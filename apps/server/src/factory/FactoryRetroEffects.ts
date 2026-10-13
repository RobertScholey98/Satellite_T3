import {
  CommandId,
  FactoryError,
  IssueOperationError,
  MessageId,
  ThreadId,
  type FactoryAssignment,
  type FactoryCommand,
  type FactoryRetroEvidenceRef,
  type FactorySnapshot,
  type FactoryRequiredPullRequest,
  type IssuePublicationRequest,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as IssuePublication from "../issues/IssuePublication.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryHandover from "./FactoryHandover.ts";
import {
  constrainFactoryModelPolicy,
  resolveFactoryModelPolicy,
  selectFactoryModel,
} from "./FactoryModelPolicy.ts";
import * as FactoryRetroEvidence from "./FactoryRetroEvidence.ts";
import * as FactoryRetroExecution from "./FactoryRetroExecution.ts";
import {
  factoryCompletionEligibility,
  factoryRetroId,
  type FactoryRetroContext,
} from "./FactoryRetros.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { deletedThreadDetail, factoryThreadDeleted } from "./FactoryThreadReach.ts";
import { factoryMergeFrozenProof } from "./FactoryMergeOperation.ts";
import type { FactoryActor } from "./FactoryState.ts";

/**
 * The host side of completion and retrospectives. It verifies evidence before retro commands are
 * decided, concludes eligible work, runs the read-only retro session, invites the manager to its
 * report, and files follow-up tickets. FactoryService's retrospective worker drives it.
 */
export class FactoryRetroEffects extends Context.Service<
  FactoryRetroEffects,
  {
    /**
     * Checks what `decideFactoryRetros` cannot: cited evidence exists in the assignment, a retro
     * report still matches a confirmed delivery, and a tracker destination is valid. A failed
     * check fails the command.
     */
    readonly context: (
      actor: FactoryActor,
      command: FactoryCommand,
    ) => Effect.Effect<FactoryRetroContext, FactoryError>;
    /**
     * Starts conclusion for every eligible assignment, skipping paused projects and work whose
     * delivery effects are still pending.
     */
    readonly reconcile: Effect.Effect<void, FactoryError>;
    /**
     * Runs one conclusion, retro or follow-up effect. Returning without finishing leaves it
     * pending for the next wake. A failed conclusion or ticket publication is recorded so it can
     * be retried; a stale revision is rethrown so the worker tries again.
     */
    readonly handle: (
      pending: FactoryStore.PendingFactoryEffect,
    ) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryRetroEffects") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });
const prKey = (ref: { host?: string | undefined; repository: string; number: number }) =>
  `${ref.host ?? "github.com"}/${ref.repository}#${ref.number}`.toLowerCase();
const projectPaused = (state: FactorySnapshot, assignment: FactoryAssignment) =>
  state.controls.some(
    (control) =>
      control.kind === "project-pause" &&
      control.projectId === assignment.projectId &&
      control.status === "active",
  );

const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const access = yield* FactoryControlAccess.FactoryControlAccess;
  const handovers = yield* FactoryHandover.FactoryHandover;
  const execution = yield* FactoryExecution.FactoryExecution;
  const runtime = yield* FactoryRetroExecution.FactoryRetroExecution;
  const evidence = yield* FactoryRetroEvidence.FactoryRetroEvidence;
  const issues = yield* IssuePublication.IssuePublication;
  const pullRequests = yield* PullRequestService.PullRequestService;
  // Every lead the assignment has had, its non-retro auxiliary threads, and all their subagents.
  const team = Effect.fn(function* (assignment: FactoryAssignment) {
    const shells = yield* threads.listProjectThreads({
      projectId: assignment.projectId,
      includeSubagents: true,
    });
    const ids = new Set([assignment.threadId, ...(assignment.previousLeadThreadIds ?? [])]);
    const state = yield* store.snapshot;
    for (const auxiliary of state.auxiliaryThreads)
      if (auxiliary.assignmentId === assignment.id && auxiliary.kind !== "retrospective")
        ids.add(auxiliary.threadId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const shell of shells)
        if (
          shell.lineage.relationshipToParent === "subagent" &&
          shell.lineage.parentThreadId !== null &&
          ids.has(shell.lineage.parentThreadId) &&
          !ids.has(shell.id)
        ) {
          ids.add(shell.id);
          changed = true;
        }
    }
    return shells.filter((shell) => ids.has(shell.id));
  }, Effect.mapError(failure));
  // Compares the manifest with what the host sees now. `discovered` lists PRs linked to team
  // threads or published by the team that the manifest lacks. For work that was not cancelled,
  // `invalidReason` is set when those must be added (only when `discover`) or a required merge
  // no longer matches the PR host.
  const deliveryConflict = Effect.fn(function* (current: FactoryAssignment, discover = true) {
    const completion = current.completion;
    if (!completion) return yield* new FactoryError({ code: "invalid-state" });
    const plan = completion.plan;
    const known = new Map<string, FactoryRequiredPullRequest>();
    for (const shell of yield* team(current))
      for (const link of shell.pullRequests ?? [])
        if (link.source !== "stack-dismissed")
          known.set(prKey(link), {
            id: prKey(link),
            ref: {
              projectId: current.projectId,
              host: link.host,
              repository: link.repository,
              number: link.number,
            },
            expectedHeadSha: null,
          });
    for (const revision of current.delivery?.revisions ?? [])
      if (revision.publication?.ref !== undefined) {
        const ref = revision.publication.ref;
        known.set(prKey(ref), {
          id: prKey(ref),
          ref,
          expectedHeadSha: revision.publication.headSha,
        });
      }
    const discovered = [...known.values()].filter(
      (entry) =>
        plan.kind !== "pull-requests" ||
        !plan.requirements.some((requirement) => prKey(requirement.ref) === prKey(entry.ref)),
    );
    let invalidReason: string | undefined;
    if (discover && !current.outcome && discovered.length)
      // No-PR work has no manifest to extend, so the only way forward is removing the links.
      invalidReason =
        plan.kind === "no-pr"
          ? "This work was commissioned without a PR, but pull requests are linked to its team threads. Unlink them before retrying, or have the manager commission PR delivery separately."
          : "Additional linked pull requests need to be included in the completion plan.";
    if (!current.outcome && plan.kind === "pull-requests")
      for (const requirement of plan.requirements) {
        if (completion.waivers.some((waiver) => waiver.requirementId === requirement.id)) continue;
        const detail = yield* pullRequests.detail({ ...requirement.ref, allowStale: false });
        if (
          detail.state !== "merged" ||
          !detail.mergedAt ||
          !detail.headSha ||
          !completion.deliveries.some(
            (delivery) =>
              delivery.kind === "pull-request-merged" &&
              prKey(delivery.ref) === prKey(requirement.ref) &&
              delivery.headSha === detail.headSha,
          ) ||
          prKey(detail) !== prKey(requirement.ref) ||
          (requirement.expectedHeadSha !== null && requirement.expectedHeadSha !== detail.headSha)
        )
          invalidReason =
            "A required pull request no longer has a confirmed matching merge. Reconcile the completion plan before the retrospective.";
      }
    return { discovered, invalidReason };
  }, Effect.mapError(failure));
  // Each reference must exist and belong to this assignment, so a report cannot cite another
  // team's work.
  const validateEvidence = Effect.fn(function* (
    assignment: FactoryAssignment,
    refs: ReadonlyArray<FactoryRetroEvidenceRef>,
  ) {
    const state = yield* store.snapshot;
    for (const ref of refs) {
      if ("threadId" in ref) {
        const membership = yield* access.membership(ref.threadId);
        if (membership?.assignmentId !== assignment.id) return false;
        if (ref.kind === "message") {
          const records = yield* threads.getThreadRecords(ref.threadId, ["messages"], {
            messageIds: [ref.messageId],
          });
          if (!records.messages.some((message) => message.id === ref.messageId)) return false;
        } else if (ref.kind === "run") {
          const records = yield* threads.getThreadRecords(ref.threadId, ["runs"], {
            runIds: [ref.runId],
          });
          if (!records.runs.some((run) => run.id === ref.runId)) return false;
        }
        continue;
      }
      const revisions = assignment.delivery?.revisions ?? [];
      const exists =
        ref.kind === "guidance"
          ? state.guidance.some(
              (entry) => entry.assignmentId === assignment.id && entry.messageId === ref.id,
            )
          : ref.kind === "dependency"
            ? state.dependencies.some(
                (entry) => entry.assignmentId === assignment.id && entry.id === ref.id,
              )
            : ref.kind === "delivery"
              ? assignment.completion?.deliveries.some((entry) => entry.id === ref.id) ||
                assignment.oversight?.delivery?.id === ref.id
              : ref.kind === "candidate"
                ? revisions.some(
                    (entry) =>
                      entry.id === ref.id ||
                      entry.candidateId === ref.id ||
                      entry.candidateDigest === ref.id,
                  )
                : ref.kind === "delivery-review"
                  ? revisions.some((entry) => entry.reviews.some((review) => review.id === ref.id))
                  : assignment.verification?.artifactId === ref.id ||
                    revisions.some((entry) => entry.verification?.artifactId === ref.id);
      if (!exists) return false;
    }
    return true;
  }, Effect.mapError(failure));
  const context = Effect.fn("FactoryRetroEffects.context")(function* (
    actor: FactoryActor,
    command: FactoryCommand,
  ) {
    if (command.type === "project.tracker.configure") {
      if (actor.kind !== "human") return yield* new FactoryError({ code: "permission-denied" });
      return {
        qualifiedTracker: yield* issues.validate({
          projectId: command.projectId,
          destination: command.destination,
        }),
      };
    }
    if (
      ![
        "finding.report",
        "retro.team.submit",
        "retro.manager.submit",
        "assignment.completion.accept",
      ].includes(command.type)
    )
      return {};
    const state = yield* store.snapshot;
    const assignmentId =
      "assignmentId" in command
        ? command.assignmentId
        : "retroId" in command
          ? state.retros.find((retro) => retro.id === command.retroId)?.assignmentId
          : undefined;
    const assignment = state.assignments.find((entry) => entry.id === assignmentId);
    if (!assignment) return yield* new FactoryError({ code: "invalid-state" });
    if (command.type === "retro.team.submit" || command.type === "retro.manager.submit") {
      const conflict = yield* deliveryConflict(assignment, false);
      if (conflict.invalidReason)
        return yield* new FactoryError({ code: "invalid-state", detail: conflict.invalidReason });
    }
    const refs =
      command.type === "finding.report"
        ? command.finding.evidence
        : command.type === "retro.team.submit"
          ? command.report.contributions
          : command.type === "assignment.completion.accept"
            ? command.evidence
            : [];
    if (!(yield* validateEvidence(assignment, refs)))
      return yield* new FactoryError({ code: "invalid-state" });
    return { evidenceValidated: true as const };
  }, Effect.mapError(failure));
  // A message counts as delivered once it is recorded against a run. `notify` checks this before
  // and after sending, so a replayed effect or a send that failed after landing is not repeated.
  const accepted = Effect.fn(function* (threadId: ThreadId, messageId: MessageId) {
    const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
      messageIds: [messageId],
    });
    return records.messages.some(
      (message) => message.id === messageId && records.runs.some((run) => run.id === message.runId),
    );
  }, Effect.mapError(failure));
  const notify = Effect.fn(function* (input: {
    threadId: ThreadId;
    projectId: FactoryAssignment["projectId"];
    messageId: MessageId;
    text: string;
    modelSelection: NonNullable<FactoryAssignment["modelSelection"]>;
  }) {
    yield* access.assertDirection({ threadId: input.threadId, senderThreadId: null });
    if (yield* accepted(input.threadId, input.messageId)) return;
    yield* threads
      .sendToThread({
        ...input,
        commandId: CommandId.make(`${input.messageId}:send`),
        attachments: [],
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.catch((cause) =>
          accepted(input.threadId, input.messageId).pipe(
            Effect.flatMap((recorded) => (recorded ? Effect.void : Effect.fail(cause))),
          ),
        ),
      );
  }, Effect.mapError(failure));
  // Stops the team, rechecks delivery against the PR host, seals the evidence the retro reads,
  // and records the conclusion. A delivery mismatch reopens collection instead.
  const conclude = Effect.fn(function* (
    pending: FactoryStore.PendingFactoryEffect,
    assignment: FactoryAssignment,
  ) {
    if (assignment.completion?.phase !== "concluding") {
      yield* store.retireEffect(pending.id);
      return;
    }
    let state = yield* store.snapshot;
    if (projectPaused(state, assignment)) return;
    // A conclusion waiting on a delivery effect stays pending and runs on every wake, so check
    // the cheap conditions before stopping shells and reading the PR host.
    const deliveryPending = (current: FactoryAssignment) =>
      store.pending.pipe(
        Effect.map((pendingEffects) =>
          pendingEffects.some(
            (entry) =>
              entry.id !== pending.id &&
              "assignmentId" in entry.intent &&
              entry.intent.assignmentId === current.id &&
              ["delivery.publish", "delivery.merge", "delivery.capture"].includes(
                entry.intent.type,
              ),
          ),
        ),
      );
    if (
      (yield* deliveryPending(assignment)) ||
      !factoryCompletionEligibility(state, assignment).eligible
    )
      return;
    // Taken before the team stops, so a thread, lineage or PR link change while evidence is
    // sealed makes FactoryStore refuse the conclusion.
    const expectedProjectThreadFence = yield* store.completionFence(assignment.projectId);
    const shells = yield* team(assignment);
    for (const shell of shells)
      yield* handovers.stopTeam({
        threadId: shell.id,
        projectId: assignment.projectId,
        commandId: CommandId.make(`${pending.id}:stop:${shell.id}`),
      });
    state = yield* store.snapshot;
    const current = state.assignments.find((entry) => entry.id === assignment.id);
    if (!current || current.completion?.phase !== "concluding" || projectPaused(state, current))
      return;
    const { discovered, invalidReason } = yield* deliveryConflict(current);
    if (invalidReason) {
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        command: {
          type: "assignment.completion.reopen",
          commandId: CommandId.make(`${pending.id}:reopen`),
          assignmentId: current.id,
          expectedStateRevision: state.revision,
          reason: invalidReason,
          discoveredRequirements: discovered,
        },
      });
      return;
    }
    if (yield* deliveryPending(current)) return;
    const eligible = factoryCompletionEligibility(state, current);
    if (!eligible.eligible) return;
    const retroId = factoryRetroId(current.id);
    const conclusionId = `conclusion:${current.id}`;
    let remainingCharacters = 1_000_000;
    const transcript = yield* Effect.forEach(shells, (shell) =>
      Effect.gen(function* () {
        const records = yield* threads.getThreadRecords(shell.id, ["messages", "runs"]);
        return {
          threadId: shell.id,
          title: shell.title,
          omittedMessages: Math.max(0, records.messages.length - 100),
          messages: records.messages.slice(-100).map((message) => {
            const text = message.text.slice(0, Math.min(8_000, remainingCharacters));
            remainingCharacters -= text.length;
            return {
              id: message.id,
              role: message.role,
              text,
              omittedCharacters: message.text.length - text.length,
              senderThreadId: message.senderThreadId,
              runId: message.runId,
            };
          }),
          omittedRuns: Math.max(0, records.runs.length - 100),
          runs: records.runs.slice(-100).map((run) => ({ id: run.id, status: run.status })),
        };
      }),
    );
    const sealed = yield* evidence.seal({
      retroId,
      conclusionId,
      assignmentId: current.id,
      documents: [
        { name: "assignment.json", content: stableStringify(current) },
        { name: "team.json", content: stableStringify(transcript) },
        {
          name: "feedback.json",
          content: stableStringify({
            controls: state.controls.filter(
              (control) => "assignmentId" in control && control.assignmentId === current.id,
            ),
            guidance: state.guidance.filter((entry) => entry.assignmentId === current.id),
            findings: state.findings.filter((entry) => entry.assignmentId === current.id),
            deliveryFindings: current.delivery?.retroFindings ?? [],
            sharedDelivery: state.mergeOperations
              .filter(
                (operation) =>
                  operation.integrationAssignmentId === current.id ||
                  operation.members.some((member) => member.reviewed.assignmentId === current.id),
              )
              .map((operation) => ({
                operation,
                review: state.mergeGroupReviews.find((entry) => entry.id === operation.reviewId),
                verification: state.integrationVerifications.find(
                  (entry) =>
                    entry.id === factoryMergeFrozenProof(operation)?.integrationVerificationId,
                ),
              })),
          }),
        },
      ],
    });
    const manager = state.managers.find((entry) => entry.id === current.managerId);
    if (!manager || !current.modelPolicy) return yield* new FactoryError({ code: "invalid-state" });
    const selection = selectFactoryModel({
      policy: constrainFactoryModelPolicy(
        current.modelPolicy,
        resolveFactoryModelPolicy(
          state.modelDefaults,
          manager.modelOverrides,
          manager.modelSelection,
        ),
      ),
      role: "lead",
      complexity: current.complexity ?? "standard",
    });
    if (Result.isFailure(selection)) return yield* selection.failure;
    yield* store.finishEffect({
      id: pending.id,
      now: yield* nowIso,
      command: {
        type: "assignment.concluded",
        commandId: CommandId.make(`${pending.id}:concluded:${state.revision}`),
        assignmentId: current.id,
        expectedStateRevision: state.revision,
        expectedProjectThreadFence,
        conclusion: {
          ...eligible.disposition,
          id: conclusionId,
          evidenceDigest: sealed.evidenceDigest,
          concludedAt: yield* nowIso,
        },
        retroThreadId: ThreadId.make(yield* randomUuidV4),
        modelSelection: selection.success.selection,
      },
    });
  }, Effect.mapError(failure));

  const reconcile = Effect.gen(function* () {
    const state = yield* store.snapshot;
    for (const assignment of state.assignments) {
      if (
        assignment.kind === "onboarding" ||
        assignment.completion?.phase === "concluding" ||
        assignment.completion?.conclusion ||
        projectPaused(state, assignment)
      )
        continue;
      if (!factoryCompletionEligibility(state, assignment).eligible) continue;
      if (
        (yield* store.pending).some(
          (pending) =>
            "assignmentId" in pending.intent &&
            pending.intent.assignmentId === assignment.id &&
            ["delivery.capture", "delivery.publish", "delivery.merge"].includes(
              pending.intent.type,
            ),
        )
      )
        continue;
      const current = yield* store.snapshot;
      yield* store.commit({
        actor: { kind: "system" },
        now: yield* nowIso,
        command: {
          type: "assignment.completion.begin",
          commandId: CommandId.make(`factory:conclude:${assignment.id}:${current.revision}`),
          assignmentId: assignment.id,
          expectedStateRevision: current.revision,
        },
      });
    }
  });
  const handle = Effect.fn("FactoryRetroEffects.handle")(function* (
    pending: FactoryStore.PendingFactoryEffect,
  ) {
    const intent = pending.intent;
    const state = yield* store.snapshot;
    if (intent.type === "assignment.conclude") {
      const assignment = state.assignments.find((entry) => entry.id === intent.assignmentId);
      if (assignment) yield* conclude(pending, assignment);
      else yield* store.retireEffect(pending.id);
      return;
    }
    if (intent.type === "followup.publish" || intent.type === "followup.link") {
      const followup = state.followups.find((entry) => entry.id === intent.followupId);
      if (!followup) {
        yield* store.retireEffect(pending.id);
        return;
      }
      const ownsSelection = (current: typeof followup) =>
        intent.type === "followup.publish"
          ? current.existingIssue === null
          : current.existingIssue !== null &&
            stableStringify(current.existingIssue) === stableStringify(intent.issue);
      if (
        !ownsSelection(followup) ||
        followup.publication.status === "linked" ||
        (followup.publication.status === "recorded" &&
          followup.publication.receipt.progress.status === "triaged")
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      const trackerId =
        "trackerId" in followup.publication ? followup.publication.trackerId : undefined;
      const tracker = state.projectTrackers.find((entry) => entry.id === trackerId);
      if (!tracker) return;
      const assignment = state.assignments.find((entry) => entry.id === followup.assignmentId);
      if (!assignment || projectPaused(state, assignment)) return;
      const request: IssuePublicationRequest = {
        requestId: `factory-followup:${followup.id}`,
        projectId: followup.projectId,
        destination: tracker.destination,
        draft: followup.draft,
      };
      // IssuePublication runs this just before each tracker write, so a pause, tracker change or
      // new issue selection made while the effect waited stops the write.
      const beforeMutation = Effect.gen(function* () {
        const latest = yield* store.snapshot;
        const assignment = latest.assignments.find((entry) => entry.id === followup.assignmentId);
        const latestFollowup = latest.followups.find((entry) => entry.id === followup.id);
        const latestTracker = latest.projectTrackers.findLast(
          (entry) => entry.projectId === followup.projectId,
        );
        if (
          !assignment ||
          projectPaused(latest, assignment) ||
          latestTracker?.id !== tracker.id ||
          !latestFollowup ||
          !ownsSelection(latestFollowup) ||
          latestFollowup.publication.status === "linked" ||
          !("trackerId" in latestFollowup.publication) ||
          latestFollowup.publication.trackerId !== tracker.id ||
          (latestFollowup.publication.status === "recorded" &&
            latestFollowup.publication.receipt.progress.status === "triaged")
        )
          return yield* new FactoryError({ code: "permission-denied" });
      }).pipe(
        Effect.mapError(
          () =>
            new IssueOperationError({
              reason: "unavailable",
              message:
                "Project ticket publication is held by the current project controls or tracker configuration.",
            }),
        ),
      );
      // Selection only identifies an existing issue. The journal then performs any missing
      // triage placement on that identity through the same live mutation guard as creation.
      const linked =
        intent.type === "followup.link" && followup.existingIssue !== null
          ? yield* issues.linkExisting({ ...request, issue: followup.existingIssue })
          : undefined;
      const receipt =
        linked?.progress.status === "triaged"
          ? linked
          : yield* issues.publish({ ...request, beforeMutation });
      const latest = yield* store.snapshot;
      const latestFollowup = latest.followups.find((entry) => entry.id === followup.id);
      if (!latestFollowup || !ownsSelection(latestFollowup)) {
        yield* store.retireEffect(pending.id);
        return;
      }
      if (projectPaused(latest, assignment)) return;
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        command: {
          type: "followup.publication.recorded",
          commandId: CommandId.make(`${pending.id}:recorded`),
          followupId: followup.id,
          receipt,
        },
      });
      return;
    }
    if (
      intent.type !== "retro.launch" &&
      intent.type !== "retro.stop" &&
      intent.type !== "retro.manager-notify"
    )
      return;
    const retro = state.retros.find((entry) => entry.id === intent.retroId);
    const assignment = state.assignments.find((entry) => entry.id === retro?.assignmentId);
    if (!retro || !assignment) {
      yield* store.retireEffect(pending.id);
      return;
    }
    if (intent.type === "retro.stop") {
      // The stop marker goes first, so a prepare racing this stop cannot qualify the session.
      yield* runtime.stop({ retroId: retro.id });
      if ((yield* threads.getThreadShell(retro.threadId)) !== null)
        yield* handovers.stopTeam({
          threadId: retro.threadId,
          projectId: assignment.projectId,
          commandId: CommandId.make(`${pending.id}:stop`),
        });
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        command: {
          type: "retro.stopped",
          commandId: CommandId.make(`${pending.id}:stopped`),
          retroId: retro.id,
        },
      });
      return;
    }
    if (projectPaused(state, assignment)) return;
    if (intent.type === "retro.manager-notify") {
      if (
        retro.reports.phase !== "manager-pending" ||
        retro.reports.team.digest !== intent.teamReportDigest
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      const manager = state.managers.find((entry) => entry.id === assignment.managerId);
      if (!manager || manager.status !== "active") return;
      // A deleted manager thread can never receive the invitation; retrying would only fail again.
      if (yield* factoryThreadDeleted(threads, manager.threadId)) {
        yield* store.retireEffect(pending.id);
        return;
      }
      yield* notify({
        threadId: manager.threadId,
        projectId: assignment.projectId,
        modelSelection: manager.modelSelection,
        messageId: MessageId.make(`factory:${retro.id}:team:${intent.teamReportDigest}`),
        text: [
          `The ${assignment.integrationId ? "integration" : "implementation"} team completed its retrospective for ${assignment.title ?? assignment.id}.`,
          `Retro ${retro.id}; conversation ${retro.threadId}; accepted team report digest ${intent.teamReportDigest}.`,
          stableStringify(retro.reports.team),
          "Review the team's evidence and causal classification. Route project findings to configured triage tickets; escalate shared or uncertain causes without requiring a local patch first. Workflow-wide decisions require human review. Do not implement follow-ups or start new assignments from this invitation.",
          "Use retro.manager.submit with the exact teamReportDigest. Every actionable finding needs an owner and disposition. No process change is a valid result, including cancellation caused by a priority change.",
        ].join("\n\n"),
      });
      yield* store.retireEffect(pending.id);
      return;
    }
    if (retro.reports.phase === "complete" || retro.execution.status === "stopped") {
      yield* store.retireEffect(pending.id);
      return;
    }
    const launched = yield* Effect.gen(function* () {
      if (retro.execution.status !== "ready") {
        const prepared = yield* runtime.prepare({
          assignmentId: assignment.id,
          retroId: retro.id,
          threadId: retro.threadId,
          conclusionId: retro.conclusionId,
          evidenceDigest: retro.evidenceDigest,
        });
        yield* store.commit({
          actor: { kind: "system" },
          now: yield* nowIso,
          command: {
            type: "retro.prepared",
            commandId: CommandId.make(`${pending.id}:prepared`),
            retroId: retro.id,
            ...prepared,
          },
        });
      }
      const profile = yield* execution.runtimePolicyFor(retro.threadId);
      if (!profile) return yield* new FactoryError({ code: "execution-unavailable" });
      yield* access.assertExecution(retro.threadId);
      if ((yield* threads.getThreadShell(retro.threadId)) === null) {
        if (yield* factoryThreadDeleted(threads, retro.threadId))
          return yield* new FactoryError({ code: "invalid-state", detail: deletedThreadDetail });
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${pending.id}:create`),
          threadId: retro.threadId,
          projectId: assignment.projectId,
          title: `Retro: ${assignment.title ?? assignment.id}`,
          modelSelection: retro.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: profile.projectSnapshotPath,
          createdBy: "system",
          creationSource: "server",
        });
      }
      yield* notify({
        threadId: retro.threadId,
        projectId: assignment.projectId,
        modelSelection: retro.modelSelection,
        messageId: MessageId.make(`${pending.id}:initial`),
        text: [
          `Lead the team retrospective for assignment ${assignment.id}. Retro ${retro.id}; conclusion ${retro.conclusionId}; evidence digest ${retro.evidenceDigest}.`,
          assignment.integrationId
            ? "Integration is over and its authority stays withdrawn. This is a fresh read-only evidence environment. Read the preserved team conversations and feedback, including the shared merge operation, combined review and verification. The source is the frozen integration input: each participant's reviewed files, one folder per project under participants/. Your team delivered combined verification rather than its own PR; the confirmed shared merge is the delivered result."
            : "Implementation is over and its authority stays withdrawn. This is a fresh read-only evidence environment. Read its preserved team conversations and feedback, including cancellation reasons and human guidance. The source is a preserved candidate when available, otherwise the immutable starting snapshot; do not treat starting source as proof of final work.",
          "Gather ground-level context from the existing team evidence. State what helped, what hindered and where each suspected cause belongs. Preserve uncertainty. Cancellation does not imply a process failure; no-process-change is a valid outcome.",
          "Report findings using finding.report with concrete evidence references. Raise active shared/system issues immediately through finding.escalate; do not require a project workaround first. Project-scoped followups may use followup.request to create triage tickets, without implementing them.",
          "Submit retro.team.submit with this retroId and exact conclusionId. Your commissioning manager will review the report and own disposition. Do not mutate source, weaken rules, publish PRs, merge, use generic issue tools, or spawn implementation agents.",
        ].join("\n\n"),
      });
    }).pipe(Effect.result);
    // A launch refused by a pause or takeover is a hold, not a failure: the effect stays pending
    // until it lifts.
    if (Result.isFailure(launched)) {
      const latest = yield* store.snapshot;
      if (
        projectPaused(latest, assignment) ||
        latest.controls.some(
          (control) =>
            control.kind === "takeover" &&
            control.status === "active" &&
            control.threadId === retro.threadId,
        )
      )
        return;
    }
    yield* store.finishEffect({
      id: pending.id,
      now: yield* nowIso,
      ...(Result.isFailure(launched) ? { failed: true } : {}),
      command: Result.isSuccess(launched)
        ? {
            type: "retro.started",
            commandId: CommandId.make(`${pending.id}:started`),
            retroId: retro.id,
          }
        : {
            type: "retro.failed",
            commandId: CommandId.make(`${pending.id}:failed`),
            retroId: retro.id,
            reason:
              "The read-only retrospective could not start. Preserved work and reports remain available; resolve the environment or control hold and retry.",
          },
    });
  }, Effect.mapError(failure));
  return FactoryRetroEffects.of({
    context,
    reconcile,
    handle: (pending) =>
      handle(pending).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            if (cause.code === "stale-revision") return yield* cause;
            const intent = pending.intent;
            if (intent.type === "assignment.conclude") {
              yield* store.finishEffect({
                id: pending.id,
                now: yield* nowIso,
                failed: true,
                command: {
                  type: "assignment.completion.failed",
                  commandId: CommandId.make(`${pending.id}:failed`),
                  assignmentId: intent.assignmentId,
                  reason:
                    "Completion could not be confirmed. Implementation remains frozen; resolve the runtime or delivery problem and retry the completion check.",
                },
              });
            } else if (intent.type === "followup.publish" || intent.type === "followup.link") {
              yield* store.finishEffect({
                id: pending.id,
                now: yield* nowIso,
                failed: true,
                command: {
                  type: "followup.failed",
                  commandId: CommandId.make(`${pending.id}:failed`),
                  followupId: intent.followupId,
                  reason:
                    "The project tracker could not confirm this follow-up. Any known ticket identity is preserved; check its destination and access, then retry.",
                },
              });
            } else return yield* cause;
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(FactoryRetroEffects, make);
