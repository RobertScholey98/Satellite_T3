import {
  CommandId,
  FactoryError,
  type FactoryAssignment,
  type FactoryDeliveryEvidence,
  type FactoryReconciliationObservation,
  type PullRequestRef,
  type ThreadId,
  isFactoryError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { factoryDeliveryWaitReason } from "./FactoryDelivery.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import {
  continueRestartedRun,
  restartContinuationEffectId,
  restartContinuationMessageId,
  restartPrepareCommandId,
} from "../orchestration-v2/RestartContinuation.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { FactoryControlAccess } from "./FactoryControlAccess.ts";
import { factoryRecoveryBlocked } from "./FactoryOversight.ts";
import { factorySamePullRequest } from "./FactoryRetros.ts";
import { FactoryStore, type PendingFactoryEffect } from "./FactoryStore.ts";

export class FactoryReconciliation extends Context.Service<
  FactoryReconciliation,
  {
    readonly handle: (pending: PendingFactoryEffect) => Effect.Effect<void, FactoryError>;
    readonly reviewExists: (
      assignment: FactoryAssignment,
      ref: PullRequestRef,
    ) => Effect.Effect<boolean, FactoryError>;
  }
>()("t3/factory/FactoryReconciliation") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });

export const layer = Layer.effect(
  FactoryReconciliation,
  Effect.gen(function* () {
    const store = yield* FactoryStore;
    const threads = yield* ThreadManagementService;
    const access = yield* FactoryControlAccess;
    const events = yield* EventSinkV2;
    const outbox = yield* EffectOutboxV2;
    const pullRequests = yield* Effect.serviceOption(PullRequestService);
    /**
     * Resumes a lead whose turn a server restart cut, as restart continuation
     * does for opted-in threads. A resumed turn cut again by a crash is not
     * resumed: that may be a crash loop, so it goes through bounded recovery.
     */
    const resumeAfterRestart = Effect.fn("FactoryReconciliation.resumeAfterRestart")(function* (
      threadId: ThreadId,
    ) {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const run = runs.reduce<(typeof runs)[number] | undefined>(
        (latest, candidate) =>
          candidate.status !== "queued" && (!latest || runRanAfter(candidate, latest))
            ? candidate
            : latest,
        undefined,
      );
      if (run?.status !== "cancelled") return false;
      const intent = yield* outbox.get(restartContinuationEffectId(run.id));
      if (
        Option.isNone(intent) ||
        (run.restartContinuationOfRunId !== undefined &&
          intent.value.commandId !== restartPrepareCommandId(run.id))
      )
        return false;
      const resumed = yield* continueRestartedRun({
        threadId,
        sourceRunId: run.id,
        managed: true,
      }).pipe(Effect.provideService(ThreadManagementService, threads), Effect.result);
      if (Result.isFailure(resumed)) {
        yield* Effect.logWarning("Could not resume a lead after a server restart", {
          threadId,
          cause: resumed.failure,
        });
        return false;
      }
      const records = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageIds: [restartContinuationMessageId(run.id)],
      });
      return records.messages.length > 0;
    }, Effect.mapError(failure));
    const linked = Effect.fn("FactoryReconciliation.linked")(function* (
      assignment: FactoryAssignment,
      ref: PullRequestRef,
    ) {
      if (ref.projectId !== assignment.projectId) return false;
      const thread = yield* threads
        .getThreadShell(assignment.threadId)
        .pipe(Effect.mapError(failure));
      const hasLink = (shell: NonNullable<typeof thread>) =>
        shell.pullRequests?.some(
          (link) =>
            link.source !== "stack-dismissed" &&
            link.host === (ref.host ?? "github.com") &&
            link.repository === ref.repository &&
            link.number === ref.number,
        ) ?? false;
      if (thread && hasLink(thread)) return true;
      const projectThreads = yield* threads
        .listProjectThreads({ projectId: assignment.projectId, includeSubagents: true })
        .pipe(Effect.mapError(failure));
      const team = new Set([assignment.threadId]);
      let added = true;
      while (added) {
        added = false;
        for (const child of projectThreads) {
          if (
            child.lineage.relationshipToParent === "subagent" &&
            child.lineage.parentThreadId !== null &&
            team.has(child.lineage.parentThreadId) &&
            !team.has(child.id)
          ) {
            team.add(child.id);
            added = true;
          }
        }
      }
      for (const threadId of team) {
        if (threadId === assignment.threadId) continue;
        const child = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure));
        if (child && hasLink(child)) return true;
      }
      return false;
    });
    const reviewExists = Effect.fn("FactoryReconciliation.reviewExists")(function* (
      assignment: FactoryAssignment,
      ref: PullRequestRef,
    ) {
      if (!(yield* linked(assignment, ref)) || Option.isNone(pullRequests)) return false;
      const detail = yield* pullRequests.value
        .detail({ ...ref, allowStale: false })
        .pipe(Effect.result);
      return (
        Result.isSuccess(detail) &&
        detail.success.state === "open" &&
        detail.success.projectId === ref.projectId &&
        detail.success.repository === ref.repository &&
        detail.success.number === ref.number
      );
    });

    return FactoryReconciliation.of({
      reviewExists,
      handle: Effect.fn("FactoryReconciliation.handle")(function* (pending) {
        if (pending.intent.type !== "assignment.reconcile") return;
        const intent = pending.intent;
        const observedSequence = yield* events.latestSequence().pipe(Effect.mapError(failure));
        const state = yield* store.snapshot;
        const assignment = state.assignments.find((entry) => entry.id === intent.assignmentId);
        if (
          !assignment ||
          assignment.outcome ||
          assignment.status === "complete" ||
          assignment.completion?.phase === "concluded"
        ) {
          yield* store.retireEffect(pending.id);
          return;
        }
        yield* store.beginEffect(pending.id);
        const finish = (observation: FactoryReconciliationObservation) =>
          Effect.gen(function* () {
            yield* store.finishEffect({
              id: pending.id,
              now: yield* nowIso,
              command: {
                type: "assignment.reconciled",
                commandId: CommandId.make(`${pending.id}:receipt`),
                assignmentId: assignment.id,
                triggerId: intent.triggerId,
                observation,
              },
            });
          });
        const confirm = (delivery: FactoryDeliveryEvidence) =>
          Effect.gen(function* () {
            yield* store.finishEffect({
              id: pending.id,
              now: yield* nowIso,
              command: {
                type: "assignment.delivery.recorded",
                commandId: CommandId.make(`${pending.id}:receipt`),
                assignmentId: assignment.id,
                delivery,
              },
            });
          });

        if (Option.isSome(pullRequests)) {
          for (const dependency of state.dependencies) {
            const condition = dependency.unblockCondition;
            if (
              dependency.assignmentId !== assignment.id ||
              dependency.authorization === undefined ||
              dependency.state === "usable" ||
              condition.kind !== "pull-request-merged" ||
              condition.ref === undefined ||
              condition.projectId !== assignment.projectId
            )
              continue;
            const ref = condition.ref;
            const detail = yield* pullRequests.value
              .detail({ ...ref, allowStale: false })
              .pipe(Effect.mapError(failure));
            if (
              detail.projectId !== ref.projectId ||
              detail.repository !== ref.repository ||
              detail.number !== ref.number ||
              detail.state !== "merged" ||
              !detail.headSha ||
              !detail.mergedAt ||
              (condition.expectedHeadSha !== undefined &&
                condition.expectedHeadSha !== detail.headSha)
            )
              continue;
            const delivery: FactoryDeliveryEvidence = {
              kind: "pull-request-merged",
              id: `pr:${ref.projectId}:${ref.repository}:${ref.number}:${detail.headSha}`,
              projectId: ref.projectId,
              ref,
              headSha: detail.headSha,
              mergedAt: detail.mergedAt,
              observedAt: yield* nowIso,
            };
            if (dependency.delivery?.id === delivery.id) continue;
            yield* store.commit({
              actor: { kind: "system" },
              now: yield* nowIso,
              command: {
                type: "dependency.delivery.observed",
                commandId: CommandId.make(`factory:${dependency.id}:${delivery.id}`),
                dependencyId: dependency.id,
                delivery,
              },
            });
          }
        }

        // Delivery observation is a host read. It remains useful while the team is paused or waiting.
        const plan = assignment.completion?.plan;
        const unresolved =
          plan?.kind === "pull-requests"
            ? plan.requirements.find(
                (requirement) =>
                  !assignment.completion?.waivers.some(
                    (waiver) => waiver.requirementId === requirement.id,
                  ) &&
                  !assignment.completion?.deliveries.some(
                    (delivery) =>
                      delivery.kind === "pull-request-merged" &&
                      factorySamePullRequest(delivery.ref, requirement.ref) &&
                      (requirement.expectedHeadSha === null ||
                        requirement.expectedHeadSha === delivery.headSha),
                  ),
              )
            : undefined;
        const claim = unresolved
          ? { kind: "pull-request" as const, ref: unresolved.ref }
          : assignment.oversight?.deliveryClaim;
        if (
          !unresolved &&
          claim?.kind === "pull-request" &&
          assignment.completion?.deliveries.some(
            (delivery) =>
              delivery.kind === "pull-request-merged" &&
              factorySamePullRequest(delivery.ref, claim.ref),
          )
        ) {
          yield* finish({
            kind: "expected-wait",
            reason:
              "Known delivery is verified; the complete assignment disposition remains pending.",
          });
          return;
        }
        if (claim?.kind === "pull-request") {
          if (!(yield* linked(assignment, claim.ref))) {
            yield* finish({
              kind: "ambiguous",
              reason: "The claimed pull request is not linked to this implementation lead.",
              evidence: [],
            });
            return;
          }
          if (Option.isNone(pullRequests)) {
            yield* finish({
              kind: "ambiguous",
              reason:
                "The pull request provider is unavailable; merge delivery cannot be confirmed.",
              evidence: [],
            });
            return;
          }
          const detail = yield* pullRequests.value
            .detail({ ...claim.ref, allowStale: false })
            .pipe(Effect.result);
          if (Result.isFailure(detail)) {
            yield* finish({
              kind: "ambiguous",
              reason:
                "The pull request provider could not confirm the claimed delivery. Reconcile the remote state before retrying any external action.",
              evidence: [],
            });
            return;
          }
          const pr = detail.success;
          if (
            pr.projectId !== claim.ref.projectId ||
            pr.repository !== claim.ref.repository ||
            pr.number !== claim.ref.number
          ) {
            yield* finish({
              kind: "ambiguous",
              reason:
                "The provider returned a different pull request identity; delivery remains unverified.",
              evidence: [],
            });
            return;
          }
          if (
            pr.state === "merged" &&
            pr.headSha &&
            pr.mergedAt &&
            (unresolved?.expectedHeadSha == null || unresolved.expectedHeadSha === pr.headSha)
          ) {
            yield* confirm({
              kind: "pull-request-merged",
              id: `pr:${claim.ref.projectId}:${claim.ref.repository}:${claim.ref.number}:${pr.headSha}`,
              projectId: assignment.projectId,
              ref: claim.ref,
              headSha: pr.headSha,
              mergedAt: pr.mergedAt,
              observedAt: yield* nowIso,
            });
            return;
          }
          if (pr.state === "open") {
            yield* finish({
              kind: "expected-wait",
              reason: "The linked pull request remains open; actual merge delivery is pending.",
            });
            return;
          }
          yield* finish({
            kind: "ambiguous",
            reason: "The pull request is closed without sufficient merge revision evidence.",
            evidence: [{ label: "Pull request", location: pr.url }],
          });
          return;
        }
        if (claim?.kind === "report") {
          const recipient = yield* threads
            .getThreadShell(claim.recipientThreadId)
            .pipe(Effect.mapError(failure));
          const agreed =
            claim.recipientThreadId === assignment.managerId ||
            (assignment.completion?.plan.kind === "no-pr" &&
              assignment.completion.plan.target.kind === "report-received" &&
              assignment.completion.plan.target.recipientThreadId === claim.recipientThreadId) ||
            state.dependencies.some(
              (dep) =>
                dep.supportingAssignmentId === assignment.id &&
                dep.unblockCondition.kind === "report-delivered" &&
                dep.unblockCondition.recipientThreadId === claim.recipientThreadId,
            );
          const records =
            recipient === null
              ? undefined
              : yield* threads
                  .getThreadRecords(claim.recipientThreadId, ["messages", "runs"], {
                    messageIds: [claim.messageId],
                  })
                  .pipe(Effect.mapError(failure));
          const message = records?.messages.find(
            (entry) =>
              entry.id === claim.messageId && !entry.streaming && entry.text.trim().length > 0,
          );
          const sender =
            message?.senderThreadId === undefined
              ? undefined
              : yield* access.membership(message.senderThreadId);
          const progress = assignment.oversight?.progress;
          if (
            agreed &&
            recipient?.projectId === assignment.projectId &&
            message &&
            sender?.assignmentId === assignment.id &&
            sender.auxiliaryThreadId === undefined &&
            !assignment.previousLeadThreadIds?.includes(message.senderThreadId!) &&
            message.runId !== null &&
            records?.runs.some((run) => run.id === message.runId) &&
            progress &&
            progress.remainingWork.trim() === "" &&
            progress.evidence.length > 0
          ) {
            yield* confirm({
              kind: "report-delivered",
              id: `report:${assignment.id}:${message.id}`,
              assignmentId: assignment.id,
              recipientThreadId: claim.recipientThreadId,
              messageId: message.id,
              summary: message.text,
              evidence: progress.evidence,
              deliveredAt: DateTime.formatIso(message.createdAt),
            });
            return;
          }
          yield* finish({
            kind: "ambiguous",
            reason:
              "Report delivery needs the actual team-authored message at the agreed recipient, a completed progress report, and evidence references.",
            evidence: [],
          });
          return;
        }
        const deliveryWait = factoryDeliveryWaitReason(assignment);
        if (deliveryWait) {
          yield* finish({ kind: "expected-wait", reason: deliveryWait });
          return;
        }
        const blocked = factoryRecoveryBlocked(state, assignment);
        if (blocked !== undefined) {
          if (assignment.wait === null || assignment.wait.kind === "recovery") return;
          yield* finish({ kind: "expected-wait", reason: blocked });
          return;
        }
        const projectThreads = yield* threads
          .listProjectThreads({ projectId: assignment.projectId, includeSubagents: true })
          .pipe(Effect.mapError(failure));
        const team = new Set([assignment.threadId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const thread of projectThreads)
            if (
              thread.lineage.relationshipToParent === "subagent" &&
              thread.lineage.parentThreadId !== null &&
              team.has(thread.lineage.parentThreadId) &&
              !team.has(thread.id)
            ) {
              team.add(thread.id);
              changed = true;
            }
        }
        for (const threadId of team) {
          const shell = projectThreads.find((thread) => thread.id === threadId);
          if (!shell || shell.deletedAt !== null) continue;
          const records = yield* threads
            .getThreadRecords(threadId, ["runs", "runtimeRequests", "subagents"])
            .pipe(Effect.mapError(failure));
          if (
            records.runtimeRequests.some((request) => request.status === "pending") ||
            records.runs.some((run) => run.status === "queued" && run.queueHeld)
          ) {
            yield* finish({
              kind: "expected-wait",
              reason: "The team is waiting on a provider request or an explicitly held queue.",
            });
            return;
          }
          if (
            records.runs.some((run) =>
              ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
            ) ||
            records.subagents.some((child) =>
              ["idle", "pending", "running", "waiting"].includes(child.status),
            )
          ) {
            yield* finish({
              kind: "active",
              reason: "The team still has accepted work or an active child task.",
            });
            return;
          }
        }
        const pendingWork = (yield* store.pending).some(
          (entry) =>
            entry.id !== pending.id &&
            entry.intent.type !== "assignment.reconcile" &&
            (("assignmentId" in entry.intent && entry.intent.assignmentId === assignment.id) ||
              ("threadId" in entry.intent && team.has(entry.intent.threadId))),
        );
        if (pendingWork) {
          yield* finish({
            kind: "active",
            reason: "A durable factory action for this team is still pending reconciliation.",
          });
          return;
        }
        const run = assignment.oversight?.lastObservedRun;
        if (
          (yield* store.snapshot).revision !== state.revision ||
          (yield* events.latestSequence().pipe(Effect.mapError(failure))) !== observedSequence
        )
          return;
        if (yield* resumeAfterRestart(assignment.threadId)) {
          yield* finish({
            kind: "active",
            reason: "The lead resumed the turn a server restart interrupted.",
          });
          return;
        }
        yield* finish({
          kind: "outstanding",
          reason:
            "The team has stopped without verified delivery or an expected wait. A completed provider turn does not complete this assignment.",
          evidence: [
            { label: "Implementation transcript", location: `thread:${assignment.threadId}` },
          ],
          ...(run === undefined
            ? {}
            : {
                runId: run.runId,
                ...(run.attemptId === null ? {} : { attemptId: run.attemptId }),
              }),
        });
      }),
    });
  }),
);
