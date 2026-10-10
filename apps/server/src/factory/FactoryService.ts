import {
  CommandId,
  FactoryAssignmentId,
  FactoryError,
  MessageId,
  ThreadId,
  type FactoryCommand,
  type FactoryCommandResult,
  type FactoryThreadLaunchIntent,
  type FactoryQuery,
  type FactorySnapshot,
  type OrchestrationV2StoredEvent,
  type FactoryHostCommand,
  type ProjectId,
} from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { FactorySource } from "./FactorySource.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import { FactoryStore, type PendingFactoryEffect } from "./FactoryStore.ts";
import { decide, type FactoryActor } from "./FactoryState.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryControlEffects from "./FactoryControlEffects.ts";
import * as FactoryRecoveryEffects from "./FactoryRecoveryEffects.ts";
import * as FactoryReconciliation from "./FactoryReconciliation.ts";
import * as FactoryRecoveryReconciliation from "./FactoryRecoveryReconciliation.ts";
import {
  constrainFactoryModelPolicy,
  resolveFactoryModelPolicy,
  selectFactoryModel,
} from "./FactoryModelPolicy.ts";
import { type FactoryOversightContext } from "./FactoryOversight.ts";
import { type FactoryDeliveryContext } from "./FactoryDelivery.ts";
import { FactoryDeliveryEffects } from "./FactoryDeliveryEffects.ts";
import { FactoryPreviewService } from "./FactoryPreviewService.ts";
import { FactoryRetroEffects } from "./FactoryRetroEffects.ts";
import { type FactoryRetroContext } from "./FactoryRetros.ts";
import { FactorySchedulingEffects } from "./FactorySchedulingEffects.ts";
import type { FactorySchedulingContext } from "./FactoryScheduling.ts";
import { ServerActivation, forkParked } from "../serverActivation.ts";
import { type FactoryControlContext } from "./FactoryControls.ts";

export class FactoryService extends Context.Service<
  FactoryService,
  {
    readonly snapshot: (query: FactoryQuery) => Effect.Effect<FactorySnapshot, FactoryError>;
    readonly changes: (query: FactoryQuery) => Stream.Stream<FactorySnapshot>;
    readonly dispatch: (
      actor: Exclude<FactoryActor, { readonly kind: "system" }>,
      command: FactoryCommand,
    ) => Effect.Effect<FactoryCommandResult, FactoryError>;
    readonly drain: Effect.Effect<void>;
    readonly recover: Effect.Effect<void, FactoryError>;
    readonly reconcileProject: (
      projectId: ProjectId,
      triggerId: string,
    ) => Effect.Effect<void, FactoryError>;
    readonly observe: (event: OrchestrationV2StoredEvent) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryService") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const renderJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isFactoryError = Schema.is(FactoryError);

const scopedSnapshot =
  (query: FactoryQuery) =>
  (snapshot: FactorySnapshot): FactorySnapshot =>
    query.projectId === undefined
      ? snapshot
      : {
          ...snapshot,
          managers: snapshot.managers.filter((manager) => manager.projectId === query.projectId),
          assignments: snapshot.assignments.filter(
            (assignment) => assignment.projectId === query.projectId,
          ),
          boundaries: snapshot.boundaries.filter(
            (boundary) => boundary.projectId === query.projectId,
          ),
          controls: snapshot.controls.filter((control) =>
            control.kind === "project-pause"
              ? control.projectId === query.projectId
              : snapshot.managers.some(
                  (manager) =>
                    manager.id === control.managerId && manager.projectId === query.projectId,
                ),
          ),
          guidance: snapshot.guidance.filter((guidance) =>
            snapshot.assignments.some(
              (assignment) =>
                assignment.id === guidance.assignmentId && assignment.projectId === query.projectId,
            ),
          ),
          dependencies: snapshot.dependencies.filter((dependency) =>
            snapshot.assignments.some(
              (assignment) =>
                assignment.id === dependency.assignmentId &&
                assignment.projectId === query.projectId,
            ),
          ),
          auxiliaryThreads: snapshot.auxiliaryThreads.filter(
            (thread) => thread.projectId === query.projectId,
          ),
          mergeRules: snapshot.mergeRules.filter((rule) => rule.projectId === query.projectId),
          previewConfigurations: snapshot.previewConfigurations.filter(
            (config) => config.projectId === query.projectId,
          ),
          previewPublicationPolicies: snapshot.previewPublicationPolicies.filter(
            (policy) => policy.projectId === query.projectId,
          ),
          retros: snapshot.retros.filter((retro) =>
            snapshot.assignments.some(
              (assignment) =>
                assignment.id === retro.assignmentId && assignment.projectId === query.projectId,
            ),
          ),
          findings: snapshot.findings.filter((finding) =>
            snapshot.assignments.some(
              (assignment) =>
                assignment.id === finding.assignmentId && assignment.projectId === query.projectId,
            ),
          ),
          followups: snapshot.followups.filter(
            (followup) => followup.projectId === query.projectId,
          ),
          projectTrackers: snapshot.projectTrackers.filter(
            (tracker) => tracker.projectId === query.projectId,
          ),
          schedulingConfigurations: snapshot.schedulingConfigurations.filter(
            (entry) => entry.projectId === query.projectId,
          ),
          scheduleCandidates: snapshot.scheduleCandidates.filter(
            (entry) => entry.projectId === query.projectId,
          ),
        };

const onboardingInstructions = (intent: FactoryThreadLaunchIntent) =>
  [
    `You are the onboarding lead for project ${intent.projectId}, assigned by engineering manager ${intent.managerId}.`,
    `Assignment: ${intent.assignmentId}. You are in a read-only snapshot of the project's tracked files. Untracked files, known credential paths, and symlinks are excluded; identify any discovery gaps.`,
    `The owned workflow is pinned to ${intent.workflow.revision} and available at /workflow. Read its relevant skills.`,
    "Discover the project's instructions, existing quality checks, issue tracker readiness, verification tools, and protected controls. Cite concrete evidence paths for each finding. Do not change the project or start implementation.",
    "Protected controls include CI and merge requirements, lint and type strictness, architecture boundaries, verification procedures, authority-defining instructions, and shared skills.",
    "Where the evidence supports it, include a proposedBoundary with exact repository-relative writable source/test paths, directories for new source/test files, additional protected paths, and direct verification commands. Gate executables must be absolute container paths; record their protected configuration inputs. This is a proposal for human approval, not permission to change files. If a supported check or control is unclear, record an unresolved decision instead of inventing one.",
    "Use factory_dispatch with an onboarding.report command and this assignment ID to record your report. List unresolved decisions explicitly. The human owns approval and the manager coordinates future work; you own this investigation.",
    "If a tool or permission is unavailable, report the exact limitation instead of bypassing the boundary.",
  ].join("\n\n");

export const layer = Layer.effect(
  FactoryService,
  Effect.gen(function* () {
    const store = yield* FactoryStore;
    const execution = yield* FactoryExecution;
    const boundaries = yield* FactoryBoundaryExecution;
    const sources = yield* FactorySource;
    const handovers = yield* FactoryHandover;
    const threads = yield* ThreadManagementService;
    const projects = yield* ProjectService;
    const controls = yield* FactoryControlAccess.FactoryControlAccess;
    const controlEffects = yield* FactoryControlEffects.FactoryControlEffects;
    const recoveryEffects = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
    const reconciliation = yield* FactoryReconciliation.FactoryReconciliation;
    const recoveryReconciliation =
      yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation;
    const deliveryEffects = yield* Effect.serviceOption(FactoryDeliveryEffects);
    const previews = yield* Effect.serviceOption(FactoryPreviewService);
    const retros = yield* Effect.serviceOption(FactoryRetroEffects);
    const scheduling = yield* Effect.serviceOption(FactorySchedulingEffects);
    const commands = yield* Semaphore.make(1);
    const commandLocks = new Map<
      CommandId,
      { readonly semaphore: Semaphore.Semaphore; users: number }
    >();
    const withCommand = <A, E, R>(id: CommandId, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          let lock = commandLocks.get(id);
          if (lock === undefined) {
            lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
            commandLocks.set(id, lock);
          }
          lock.users += 1;
          return lock;
        }),
        (lock) => lock.semaphore.withPermits(1)(effect),
        (lock) =>
          Effect.sync(() => {
            lock.users -= 1;
            if (lock.users === 0) commandLocks.delete(id);
          }),
      );

    const launch = Effect.fn("FactoryService.launch")(function* (pending: PendingFactoryEffect) {
      const { intent } = pending;
      if (intent.type !== "thread.launch") return;
      const snapshot = yield* store.snapshot;
      const assignment = snapshot.assignments.find((entry) => entry.id === intent.assignmentId);
      const manager = snapshot.managers.find((entry) => entry.id === intent.managerId);
      if (
        assignment === undefined ||
        manager === undefined ||
        assignment.qualification.status !== "qualified" ||
        assignment.qualification.profileId !== intent.profileId
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      if (manager.status === "blocked" || manager.status === "paused") return;
      const allowed = yield* controls
        .assertDirection({
          threadId: intent.threadId,
          senderThreadId: intent.purpose === "manager" ? null : intent.managerId,
        })
        .pipe(Effect.result);
      if (Result.isFailure(allowed)) {
        if (allowed.failure.code === "permission-denied") return;
        return yield* allowed.failure;
      }
      yield* store.beginEffect(pending.id);
      let schedulingHold: FactoryError | undefined;
      const result = yield* Effect.gen(function* () {
        const profile = yield* execution.runtimePolicyFor(intent.threadId);
        if (profile === undefined)
          return yield* new FactoryError({ code: "execution-unavailable" });
        const existing = yield* threads.getThreadShell(intent.threadId);
        if (
          existing !== null &&
          (existing.projectId !== intent.projectId ||
            existing.deletedAt !== null ||
            existing.archivedAt !== null)
        )
          return yield* new FactoryError({ code: "invalid-state" });
        if (existing === null)
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`factory:${pending.id}:create`),
            threadId: intent.threadId,
            projectId: intent.projectId,
            title:
              intent.purpose === "manager"
                ? manager.name
                : intent.purpose === "onboarding"
                  ? "Project onboarding"
                  : (assignment.title ?? "Implementation"),
            modelSelection: intent.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: profile.projectSnapshotPath,
            createdBy: "system",
            creationSource: "server",
            ...(assignment.scheduling ? { issueAttempt: assignment.scheduling.issueAttempt } : {}),
          });
        yield* store.commit({
          actor: { kind: "system" },
          command: {
            type: "thread.launch.started",
            commandId: CommandId.make(`${pending.id}:started`),
            threadId: intent.threadId,
          },
          now: yield* nowIso,
        });
        const messageId = MessageId.make(`factory:${intent.threadId}:initial-message`);
        const records = yield* threads.getThreadRecords(intent.threadId, ["messages", "runs"], {
          messageIds: [messageId],
        });
        const accepted = records.messages.find((message) => message.id === messageId);
        if (accepted !== undefined) {
          if (!records.runs.some((run) => run.id === accepted.runId))
            return yield* new FactoryError({ code: "launch-failed" });
          return;
        }
        if (assignment.scheduling) {
          if (Option.isNone(scheduling))
            return yield* new FactoryError({ code: "execution-unavailable" });
          yield* scheduling.value.beforeLaunch(assignment, profile.projectSnapshotPath).pipe(
            Effect.tapError((cause) =>
              Effect.sync(() => {
                schedulingHold = cause;
              }),
            ),
          );
        }
        yield* threads.sendToThread({
          projectId: intent.projectId,
          commandId: CommandId.make(`factory:${pending.id}:initial-message`),
          threadId: intent.threadId,
          messageId,
          ...(intent.purpose !== "manager" ? { senderThreadId: intent.managerId } : {}),
          text:
            intent.purpose === "onboarding"
              ? onboardingInstructions(intent)
              : intent.purpose === "implementation"
                ? [
                    `You lead implementation assignment ${assignment.id} for engineering manager ${manager.id}. You own implementation, your team's reviews, verification, and the complete PR process.`,
                    `Task: ${assignment.title}. Scope: ${assignment.scope?.description}. Completion: ${assignment.scope?.completionCondition}. Pull request required: ${assignment.scope?.requiresPullRequest ?? true}.`,
                    `The owned workflow is pinned to ${assignment.workflow.revision} at /workflow. Read its relevant skills. Your approved starting source is ${assignment.startingSource?.revision} (${assignment.startingSource?.sourceDigest}); preserve any handed-over work and existing PR links.`,
                    `Approved execution grant: ${renderJson(assignment.grant)}. Existing granted files can be edited normally. For creating, renaming, or deleting files use factory_dispatch assignment.file.mutate with the current grant epoch. Use assignment.verify to run the adopted immutable checks and retain its evidence.`,
                    `Approved exact models: ${renderJson(assignment.modelPolicy)}. Your selected model: ${renderJson(assignment.modelChoice)}. Choose approved models according to task complexity. Native subagent tools are disabled; use delegate_task for your internal team. Every descendant remains inside this assignment's boundary.`,
                    "Raise an out-of-scope dependency or structural problem when discovered. Do not change protected controls without a separately authorized rule-change assignment. The manager coordinates priorities; it does not review your PR.",
                    "Before implementation, declare concrete UI impact with delivery.impact.declare: journeys, navigation, layout, shared components, classification, and evidence. Changed user flows physically hold implementation. While held, use the read-only planning context to submit a concrete markdown or HTML flow via delivery.flow.submit; wait for the human's digest-bound decision and host release before coding. Flow submission records its own approval wait; do not add an assignment.wait for that same decision. The host resumes you automatically after approval and physical release, or after requested changes so you can revise the proposal.",
                    "For PR work use the host-owned delivery process: delivery.capture with exact selected paths, commit message, and grant epoch freezes the full publication tree and runs protected checks. delivery.review.request starts an independent ordinary review thread against that immutable tree. Follow its findings; changed work needs a new capture and review. For substantial or major UI, the reviewer must exercise the isolated candidate app and record real journeys and screenshots. The project needs a human-approved preview configuration and screenshot-publication permission.",
                    "After candidate checks and independent review pass, delivery.publish creates or updates and links the exact PR. delivery.ready reconciles hosting checks and seals the evidence. Wait for the human when requested; discuss corrections directly with them. delivery.merge requests an exact-head conditional merge only when authorized. A queued or unknown hosting response is not a confirmed merge. Use delivery.retry for a visible delivery failure, preserving its reserved operation. Never use generic PR tools to bypass these gates.",
                    "Record meaningful progress using assignment.progress with summary, remainingWork, and evidence references. Before ending a turn with no independent work left, record assignment.wait: dependency with your requested dependency IDs, review with an existing linked open PR, or human-decision with the decision needed. A completed provider turn does not complete the assignment. Use dependency.request for out-of-scope supporting work; approval and commissioning never mean it is delivered. After a host-confirmed delivery wake, report dependency.check-usability against that exact delivery ID and evidence.",
                    "When delivery actually occurs, use assignment.delivery.request: a linked pull-request ref for merged work, or the actual report message ID at the agreed recipient for a non-PR assignment. For a report, first record progress with empty remainingWork and evidence, then send the findings and recommendation to the agreed recipient. The host verifies receipt; do not claim completion from a green check or an opened PR.",
                    "Declare every required PR with assignment.completion.plan. Versions of the same PR are one obligation. Seal the complete list only when no implementation scope remains. All required PRs must actually merge, or the human must explicitly waive remaining scope, before the host freezes implementation and starts the read-only team retro. A no-PR task follows the exact commissioned report-receipt or human-acceptance target.",
                    "Use finding.report to raise evidenced problems when discovered, without waiting for the retro. Classify the suspected cause and preserve uncertainty. Escalate reusable or system causes with finding.escalate. Use followup.request for project-scoped triage tickets; creating a ticket does not authorize implementation.",
                    "Human review is required unless the delivery grant and project rules explicitly permit autonomous delivery. Major UI changes require human PR approval and useful screenshots. After merge, conduct your internal retro and then a retro with your manager. Creating a follow-up ticket does not authorize its implementation.",
                  ].join("\n\n")
                : [
                    `You are the engineering manager for project ${intent.projectId}. Your durable manager identity is ${intent.managerId}. The human is your manager.`,
                    `Onboarding lead ${assignment.threadId} owns discovery assignment ${assignment.id}. Use factory_snapshot to inspect its findings and waits. A read-only tracked snapshot is mounted at /workspace; owned workflow ${intent.workflow.revision} is at /workflow.`,
                    "You coordinate scoped implementation teams and project priorities. Implementation leads own code, internal reviews, verification, and the complete PR process. You do not implement or review their PRs. You and the system manager are peers with different remits.",
                    "Currently onboarding is in progress. Acknowledge the assignment briefly, then wait for an actionable event or the human. Do not poll, start implementation, or attempt to broaden execution permissions. Unresolved permissions and project decisions must remain visible.",
                    "When factory_snapshot shows an active manager with an approved boundary and the human requests work, use assignment.commission to create a scoped implementation lead. Choose exact source paths and creation directories within that boundary, a completion condition, and task complexity. Omit modelSelection for the configured lead preference. authorizationMessageId may reference the direct human request, or omit it to use the latest direct human message. Discuss gaps with the human before commissioning unclear work.",
                    "For no-PR work, set scope.noPrTarget explicitly: report-received at the agreed recipient when receipt satisfies the task, otherwise human-acceptance. After confirmed delivery or cancellation with the human's reason, the host starts a read-only team retrospective and sends you its accepted report. Review the causes and owners through retro.manager.submit; you do not review the PR. Project follow-ups become triage tickets, while workflow-wide decisions stay with the human. No process change is a normal result.",
                    "On a dependency request, decide whether separate work is authorized within your remit. Use dependency.approve with the exact supporting work, then assignment.commission with that dependencyId and the same approved scope. Wait for actual host-confirmed delivery and the original lead's usability check. For a recovery incident, read the recorded evidence, use assignment.recovery.begin within the remaining allowance, then use its independent diagnosis to replan. Use replaceLead only when warranted; work and limits are preserved. If recovery cannot proceed, assignment.recovery.escalate must state the failure, attempts, options, and recommendation for the human.",
                  ].join("\n\n"),
          attachments: [],
          modelSelection: intent.modelSelection,
          mode: "auto",
          createdBy: "system",
          creationSource: "server",
        });
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        const latest = yield* store.snapshot;
        if (latest.assignments.find((entry) => entry.id === assignment.id)?.outcome !== undefined) {
          yield* store.retireEffect(pending.id);
          return;
        }
        const allowed = yield* controls
          .assertDirection({
            threadId: intent.threadId,
            senderThreadId: intent.purpose === "manager" ? null : intent.managerId,
          })
          .pipe(Effect.result);
        if (Result.isFailure(allowed) && allowed.failure.code === "permission-denied") return;
        if (schedulingHold) {
          const reason =
            schedulingHold.detail ??
            "Tracker admission is unavailable. This assignment will retry when scheduling conditions change.";
          const current = latest.assignments.find((entry) => entry.id === assignment.id);
          if (
            current?.status !== "waiting" ||
            current.wait?.kind !== "execution-boundary" ||
            current.wait.reason !== reason
          ) {
            yield* store.commit({
              actor: { kind: "system" },
              now: yield* nowIso,
              command: {
                type: "thread.launch.failed",
                commandId: CommandId.make(`${pending.id}:schedule-hold:${latest.revision}`),
                threadId: intent.threadId,
                reason,
              },
            });
          }
          return;
        }
        yield* Effect.logError("Managed thread launch failed", {
          threadId: intent.threadId,
          cause: result.failure,
        });
        yield* store.finishEffect({
          id: pending.id,
          command: {
            type: "thread.launch.failed",
            commandId: CommandId.make(`${pending.id}:receipt`),
            threadId: intent.threadId,
            reason:
              isFactoryError(result.failure) && result.failure.detail
                ? result.failure.detail
                : intent.purpose === "implementation"
                  ? "The implementation thread could not start. Check the environment's provider and Docker availability, then retry the assignment. Existing work is preserved."
                  : "The confined thread could not start. Check the environment's provider and Docker availability, then retry onboarding. Existing work is preserved.",
          },
          now: yield* nowIso,
          failed: true,
        });
      } else {
        yield* store.finishEffect({
          id: pending.id,
          command: {
            type: "thread.launch.recorded",
            commandId: CommandId.make(`${pending.id}:receipt`),
            threadId: intent.threadId,
          },
          now: yield* nowIso,
        });
      }
    });

    const prepare = Effect.fn("FactoryService.prepare")(function* (pending: PendingFactoryEffect) {
      const { intent } = pending;
      if (intent.type !== "assignment.prepare") return;
      const snapshot = yield* store.snapshot;
      const assignment = snapshot.assignments.find((entry) => entry.id === intent.assignmentId);
      const manager = snapshot.managers.find((entry) => entry.id === intent.managerId);
      if (
        assignment === undefined ||
        manager === undefined ||
        assignment.status === "complete" ||
        assignment.preparation === "ready"
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      if (manager.status !== "active" || assignment.status !== "pending") return;
      const allowed = yield* controls
        .assertDirection({ threadId: intent.threadId, senderThreadId: intent.managerId })
        .pipe(Effect.result);
      if (Result.isFailure(allowed)) {
        if (allowed.failure.code === "permission-denied") return;
        return yield* allowed.failure;
      }
      yield* store.beginEffect(pending.id);
      const result = yield* Effect.gen(function* () {
        if (assignment.grant === undefined)
          return yield* new FactoryError({ code: "invalid-state" });
        if (assignment.origin === "handover" && assignment.preparation === "stopping") {
          yield* handovers.stop({
            threadId: assignment.threadId,
            projectId: assignment.projectId,
            commandId: CommandId.make(`factory:${assignment.id}:stop`),
          });
          yield* store.commit({
            actor: { kind: "system" },
            command: {
              type: "assignment.preparation.recorded",
              commandId: CommandId.make(`factory:${assignment.id}:capturing`),
              assignmentId: assignment.id,
              threadId: assignment.threadId,
              stage: "capturing",
            },
            now: yield* nowIso,
          });
        }
        const startingSource =
          assignment.startingSource ??
          (yield* sources.capture({
            requestId: CommandId.make(`factory:${assignment.id}:source`),
            projectId: assignment.projectId,
            ...(assignment.origin === "handover" ? { threadId: assignment.threadId } : {}),
          }));
        yield* store.commit({
          actor: { kind: "system" },
          command: {
            type: "assignment.preparation.recorded",
            commandId: CommandId.make(`factory:${assignment.id}:source-recorded`),
            assignmentId: assignment.id,
            threadId: assignment.threadId,
            stage: "preparing",
            startingSource,
          },
          now: yield* nowIso,
        });
        const qualification = yield* boundaries.prepare({
          assignmentId: assignment.id,
          threadId: assignment.threadId,
          boundaryId: assignment.grant.boundaryId,
          grant: assignment.grant,
          startingSourceId: startingSource.id,
        });
        if (qualification.status !== "qualified")
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: qualification.reason,
          });
        if (assignment.origin === "handover") yield* sources.validateCurrent(startingSource.id);
        return { qualification, startingSource };
      }).pipe(Effect.result);
      const current = (yield* store.snapshot).assignments.find(
        (entry) => entry.id === assignment.id,
      );
      if (current?.status !== "pending" || current.grant?.epoch !== assignment.grant?.epoch) {
        yield* store.retireEffect(pending.id);
        return;
      }
      if (Result.isFailure(result)) {
        const allowed = yield* controls
          .assertDirection({ threadId: intent.threadId, senderThreadId: intent.managerId })
          .pipe(Effect.result);
        if (Result.isFailure(allowed) && allowed.failure.code === "permission-denied") return;
      }
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        ...(Result.isFailure(result) ? { failed: true } : {}),
        command: Result.isFailure(result)
          ? {
              type: "assignment.prepare.failed",
              commandId: CommandId.make(`${pending.id}:receipt`),
              assignmentId: assignment.id,
              threadId: assignment.threadId,
              reason: isFactoryError(result.failure)
                ? (result.failure.detail ?? result.failure.message)
                : "The approved assignment environment could not be prepared. Existing work is preserved; resolve the environment problem and retry.",
            }
          : {
              type: "assignment.prepared",
              commandId: CommandId.make(`${pending.id}:receipt`),
              assignmentId: assignment.id,
              threadId: assignment.threadId,
              ...result.success,
            },
      });
    });

    let workerProgress = 0;
    const worker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        const visited = new Set<string>();
        for (;;) {
          const pending = (yield* store.pending).filter(
            (entry) =>
              !visited.has(entry.id) &&
              [
                "thread.launch",
                "assignment.prepare",
                "auxiliary.launch",
                "assignment.replace-lead",
              ].includes(entry.intent.type),
          );
          if (pending.length === 0) return;
          for (const entry of pending) {
            visited.add(entry.id);
            const revision = (yield* store.snapshot).revision;
            if (entry.intent.type === "assignment.prepare") yield* prepare(entry);
            else if (entry.intent.type === "thread.launch")
              yield* commands.withPermits(1)(launch(entry));
            else yield* recoveryEffects.handle(entry);
            if ((yield* store.snapshot).revision !== revision) {
              workerProgress += 1;
              visited.clear();
              yield* controlWorker.enqueue(undefined);
              yield* oversightWorker.enqueue(undefined);
              yield* deliveryWorker.enqueue(undefined);
              yield* retroWorker.enqueue(undefined);
            }
          }
        }
      }),
    );
    const controlWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        const visited = new Set<string>();
        for (;;) {
          const pending = (yield* store.pending).filter(
            (entry) =>
              !visited.has(entry.id) &&
              ["control.stop", "control.resume", "thread.deliver", "thread.queue.resume"].includes(
                entry.intent.type,
              ),
          );
          if (pending.length === 0) return;
          for (const entry of pending) {
            visited.add(entry.id);
            const revision = (yield* store.snapshot).revision;
            yield* controlEffects.run(entry).pipe(
              Effect.catch((cause) =>
                Effect.logError("Factory control effect remains pending", {
                  effectId: entry.id,
                  cause,
                }),
              ),
            );
            if ((yield* store.snapshot).revision !== revision) {
              workerProgress += 1;
              visited.clear();
              yield* worker.enqueue(undefined);
              yield* oversightWorker.enqueue(undefined);
              yield* deliveryWorker.enqueue(undefined);
              yield* retroWorker.enqueue(undefined);
            }
          }
        }
      }),
    );
    const oversightWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        const visited = new Set<string>();
        for (;;) {
          const pending = (yield* store.pending).filter(
            (entry) =>
              !visited.has(entry.id) &&
              (entry.intent.type === "assignment.reconcile" ||
                entry.intent.type === "auxiliary.reconcile"),
          );
          if (pending.length === 0) return;
          for (const entry of pending) {
            visited.add(entry.id);
            const revision = (yield* store.snapshot).revision;
            yield* (
              entry.intent.type === "auxiliary.reconcile"
                ? recoveryReconciliation.handle(entry)
                : reconciliation.handle(entry)
            ).pipe(
              Effect.catch((cause) =>
                Effect.logError("Factory reconciliation remains pending", {
                  effectId: entry.id,
                  cause,
                }),
              ),
            );
            if ((yield* store.snapshot).revision !== revision) {
              workerProgress += 1;
              visited.clear();
              yield* worker.enqueue(undefined);
              yield* controlWorker.enqueue(undefined);
              yield* deliveryWorker.enqueue(undefined);
              yield* retroWorker.enqueue(undefined);
            }
          }
        }
      }),
    );
    const deliveryWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        if (Option.isNone(deliveryEffects) && Option.isNone(previews)) return;
        if (Option.isSome(previews))
          yield* previews.value.reconcile.pipe(
            Effect.catch((cause) =>
              Effect.logError("Factory preview shutdown remains pending", { cause }),
            ),
          );
        const visited = new Set<string>();
        for (;;) {
          const pending = (yield* store.pending).filter(
            (entry) => !visited.has(entry.id) && entry.intent.type.startsWith("delivery."),
          );
          if (!pending.length) return;
          for (const entry of pending) {
            visited.add(entry.id);
            const revision = (yield* store.snapshot).revision;
            const handler =
              entry.intent.type === "delivery.preview.start" ||
              entry.intent.type === "delivery.preview.stop"
                ? previews
                : deliveryEffects;
            if (Option.isNone(handler)) continue;
            yield* handler.value.handle(entry).pipe(
              Effect.catch((cause) =>
                Effect.logError("Factory delivery remains pending", {
                  effectId: entry.id,
                  cause,
                }),
              ),
            );
            if ((yield* store.snapshot).revision !== revision) {
              workerProgress += 1;
              visited.clear();
              yield* worker.enqueue(undefined);
              yield* controlWorker.enqueue(undefined);
              yield* oversightWorker.enqueue(undefined);
              yield* retroWorker.enqueue(undefined);
            }
          }
        }
      }),
    );
    const retroWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        if (Option.isNone(retros)) return;
        yield* retros.value.reconcile.pipe(
          Effect.catch((cause) =>
            Effect.logError("Factory retrospective reconciliation remains pending", { cause }),
          ),
        );
        const visited = new Set<string>();
        for (;;) {
          const pending = (yield* store.pending).filter(
            (entry) =>
              !visited.has(entry.id) &&
              (entry.intent.type === "assignment.conclude" ||
                entry.intent.type.startsWith("retro.") ||
                entry.intent.type.startsWith("followup.")),
          );
          if (!pending.length) return;
          for (const entry of pending) {
            visited.add(entry.id);
            const revision = (yield* store.snapshot).revision;
            yield* retros.value.handle(entry).pipe(
              Effect.catch((cause) =>
                Effect.logError("Factory retrospective work remains pending", {
                  effectId: entry.id,
                  cause,
                }),
              ),
            );
            if ((yield* store.snapshot).revision !== revision) {
              workerProgress += 1;
              visited.clear();
              yield* worker.enqueue(undefined);
              yield* controlWorker.enqueue(undefined);
              yield* oversightWorker.enqueue(undefined);
              yield* deliveryWorker.enqueue(undefined);
            }
          }
        }
      }),
    );
    const schedulingWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        if (Option.isNone(scheduling)) return;
        yield* scheduling.value.reconcile.pipe(
          Effect.catch((cause) =>
            Effect.logError("Factory scheduling reconciliation failed", { cause }),
          ),
        );
        const visited = new Set<string>();
        for (;;) {
          const pending = (yield* store.pending).filter(
            (entry) => !visited.has(entry.id) && entry.intent.type.startsWith("schedule."),
          );
          if (!pending.length) return;
          for (const entry of pending) {
            visited.add(entry.id);
            const revision = (yield* store.snapshot).revision;
            yield* scheduling.value.handle(entry).pipe(
              Effect.catch((cause) =>
                Effect.logError("Factory scheduling remains pending", {
                  effectId: entry.id,
                  cause,
                }),
              ),
            );
            if ((yield* store.snapshot).revision !== revision) {
              workerProgress += 1;
              visited.clear();
              yield* scheduling.value.reconcile.pipe(
                Effect.catch((cause) =>
                  Effect.logError("Factory scheduling reconciliation failed", { cause }),
                ),
              );
            }
          }
        }
      }),
    );
    const wake = Effect.all(
      [
        worker.enqueue(undefined),
        controlWorker.enqueue(undefined),
        oversightWorker.enqueue(undefined),
        deliveryWorker.enqueue(undefined),
        retroWorker.enqueue(undefined),
        schedulingWorker.enqueue(undefined),
      ],
      {
        discard: true,
      },
    );
    if ((yield* ServerActivation) === undefined) yield* wake;
    else yield* forkParked(wake);
    if (Option.isSome(scheduling)) yield* scheduling.value.watch(wake);
    const drain = Effect.gen(function* () {
      for (;;) {
        const progress = workerProgress;
        yield* worker.drain;
        yield* controlWorker.drain;
        yield* oversightWorker.drain;
        yield* deliveryWorker.drain;
        yield* retroWorker.drain;
        yield* schedulingWorker.drain;
        if (progress === workerProgress) return;
      }
    });

    const controlContext = Effect.fn("FactoryService.controlContext")(function* (
      command: FactoryCommand,
    ) {
      if (command.type === "thread.takeover" || command.type === "thread.handback") {
        const controlTarget = yield* controls.membership(command.threadId);
        return controlTarget === undefined ? {} : { controlTarget };
      }
      if (command.type !== "guidance.escalate") return {};
      const target = yield* controls.membership(command.threadId);
      if (target === undefined) return {};
      const records = yield* threads
        .getThreadRecords(command.threadId, ["messages"], { messageIds: [command.messageId] })
        .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
      const message = records.messages.find(
        (entry) =>
          entry.id === command.messageId &&
          entry.role === "user" &&
          FactoryControlAccess.factoryDirectionSender(entry) === undefined,
      );
      return message === undefined ? {} : { guidance: { messageId: message.id, target } };
    });

    const service = FactoryService.of({
      snapshot: (query) => store.snapshot.pipe(Effect.map(scopedSnapshot(query))),
      changes: (query) => store.changes.pipe(Stream.map(scopedSnapshot(query))),
      drain,
      reconcileProject: Effect.fn("FactoryService.reconcileProject")(
        function* (projectId, triggerId) {
          yield* store.commit({
            actor: { kind: "system" },
            now: yield* nowIso,
            command: {
              type: "project.reconcile.requested",
              commandId: CommandId.make(`factory:remote:${projectId}:${triggerId}`),
              projectId,
              triggerId,
            },
          });
          yield* wake;
        },
      ),
      recover: Effect.gen(function* () {
        const startupId = yield* randomUuidV4;
        for (const assignment of (yield* store.snapshot).assignments) {
          if (
            assignment.kind === "onboarding" ||
            assignment.outcome ||
            assignment.status === "complete"
          )
            continue;
          const observed = assignment.oversight?.lastObservedRun;
          yield* store.commit({
            actor: { kind: "system" },
            now: yield* nowIso,
            command: {
              type: "assignment.reconcile.requested",
              commandId: CommandId.make(`factory:startup:${startupId}:${assignment.id}`),
              assignmentId: assignment.id,
              triggerId:
                observed === undefined
                  ? `startup:${assignment.id}`
                  : `run:${observed.runId}:${observed.attemptId ?? "none"}`,
            },
          });
        }
        for (const auxiliary of (yield* store.snapshot).auxiliaryThreads) {
          if (auxiliary.status !== "running" && auxiliary.status !== "pending") continue;
          yield* store.commit({
            actor: { kind: "system" },
            now: yield* nowIso,
            command: {
              type: "auxiliary.reconcile.requested",
              commandId: CommandId.make(`factory:startup:${startupId}:${auxiliary.threadId}`),
              threadId: auxiliary.threadId,
              triggerId: `startup:${startupId}`,
            },
          });
        }
        yield* wake;
      }),
      observe: Effect.fn("FactoryService.observe")(function* (stored) {
        let command: FactoryHostCommand | undefined;
        const event = stored.event;
        if (event.type === "thread.pull-request-synced")
          command = {
            type: "project.reconcile.requested",
            commandId: CommandId.make(`factory:observed:${stored.sequence}`),
            projectId: event.payload.projectId,
            triggerId: `pr-sync:${stored.sequence}`,
          };
        if (
          [
            "run.updated",
            "run.created",
            "runtime-request.updated",
            "subagent.updated",
            "checkpoint.captured",
          ].includes(event.type)
        ) {
          const resolved = yield* controls.membership(event.threadId).pipe(Effect.result);
          if (Result.isFailure(resolved) && resolved.failure.code !== "execution-unavailable")
            return yield* resolved.failure;
          const membership = Result.isSuccess(resolved) ? resolved.success : undefined;
          if (membership?.auxiliaryThreadId !== undefined) {
            command = {
              type: "auxiliary.reconcile.requested",
              commandId: CommandId.make(`factory:observed:${stored.sequence}`),
              threadId: membership.auxiliaryThreadId,
              triggerId: `event:${stored.sequence}`,
            };
          }
          if (
            membership?.assignmentId !== undefined &&
            membership.auxiliaryThreadId === undefined
          ) {
            const assignment = (yield* store.snapshot).assignments.find(
              (entry) => entry.id === membership.assignmentId,
            );
            if (
              assignment !== undefined &&
              !assignment.previousLeadThreadIds?.some(
                (id) => id === event.threadId || membership.ancestorThreadIds.includes(id),
              )
            ) {
              command =
                event.type === "run.updated" || event.type === "run.created"
                  ? {
                      type: "assignment.run.observed",
                      commandId: CommandId.make(`factory:observed:${stored.sequence}`),
                      assignmentId: assignment.id,
                      threadId: event.threadId,
                      runId: event.payload.id,
                      attemptId: event.payload.activeAttemptId,
                      status: event.payload.status,
                    }
                  : {
                      type: "assignment.reconcile.requested",
                      commandId: CommandId.make(`factory:observed:${stored.sequence}`),
                      assignmentId: assignment.id,
                      triggerId:
                        assignment.oversight?.lastObservedRun === undefined
                          ? `event:${stored.sequence}`
                          : `run:${assignment.oversight.lastObservedRun.runId}:${assignment.oversight.lastObservedRun.attemptId ?? "none"}`,
                    };
            }
          }
        }
        if (
          event.type === "message.updated" &&
          event.payload.role === "user" &&
          FactoryControlAccess.factoryDirectionSender(event.payload) === undefined
        ) {
          const membership = yield* controls.membership(event.threadId).pipe(Effect.result);
          if (Result.isFailure(membership) && membership.failure.code !== "execution-unavailable")
            return yield* membership.failure;
          const member = Result.isSuccess(membership) ? membership.success : undefined;
          if (member?.assignmentId !== undefined)
            command = {
              type: "guidance.observed",
              commandId: CommandId.make(`factory:guidance:${event.threadId}:${event.payload.id}`),
              threadId: event.threadId,
              messageId: event.payload.id,
              assignmentId: member.assignmentId,
            };
        }
        yield* store.observe({
          sequence: stored.sequence,
          ...(command === undefined ? {} : { command }),
          now: yield* nowIso,
        });
        if (command !== undefined) yield* wake;
        else
          yield* Effect.all(
            [
              oversightWorker.enqueue(undefined),
              deliveryWorker.enqueue(undefined),
              retroWorker.enqueue(undefined),
            ],
            { discard: true },
          );
      }),
      dispatch: Effect.fn("FactoryService.dispatch")(function* (actor, command) {
        const receipt = yield* store.findReceipt({ actor, command });
        if (receipt !== undefined) return receipt;
        const allocation =
          command.type === "manager.create" ||
          command.type === "assignment.commission" ||
          command.type === "assignment.handover"
            ? {
                managerThreadId:
                  command.type === "manager.create"
                    ? ThreadId.make(yield* randomUuidV4)
                    : command.managerId,
                leadThreadId:
                  command.type === "assignment.handover"
                    ? command.threadId
                    : ThreadId.make(yield* randomUuidV4),
                assignmentId: FactoryAssignmentId.make(yield* randomUuidV4),
              }
            : undefined;
        const snapshot = yield* store.snapshot;
        if (
          (command.type === "assignment.commission" || command.type === "assignment.handover") &&
          command.scope.noPrTarget?.kind === "report-received"
        ) {
          const recipientId = command.scope.noPrTarget.recipientThreadId;
          const manager = snapshot.managers.find((entry) => entry.id === command.managerId);
          const recipient = yield* threads
            .getThreadShell(recipientId)
            .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
          const agreed =
            recipientId === manager?.threadId ||
            snapshot.dependencies.some(
              (dependency) =>
                "dependencyId" in command &&
                dependency.id === command.dependencyId &&
                dependency.unblockCondition.kind === "report-delivered" &&
                dependency.unblockCondition.recipientThreadId === recipientId,
            );
          if (
            !agreed ||
            !recipient ||
            recipient.projectId !== manager?.projectId ||
            recipient.deletedAt !== null ||
            recipient.archivedAt !== null
          )
            return yield* new FactoryError({
              code: "invalid-state",
              detail:
                "The report recipient must be an available thread agreed for this project assignment.",
            });
        }
        let oversightContext: FactoryOversightContext = {};
        let deliveryContext: FactoryDeliveryContext = {};
        let retroContext: FactoryRetroContext = {};
        let schedulingContext: FactorySchedulingContext = {};
        if (Option.isSome(retros)) retroContext = yield* retros.value.context(actor, command);
        if (Option.isSome(scheduling))
          schedulingContext = yield* scheduling.value.context(actor, command);
        if (command.type === "assignment.wait" && command.wait.kind === "review") {
          const assignment = snapshot.assignments.find(
            (entry) => entry.id === command.assignmentId,
          );
          oversightContext = {
            reviewVerified:
              assignment !== undefined &&
              (yield* reconciliation.reviewExists(assignment, command.wait.ref)),
          };
        }
        if (
          command.type === "assignment.recovery.begin" ||
          command.type === "delivery.review.request" ||
          (command.type === "assignment.recovery.replan" && command.replaceLead)
        ) {
          const assignment = snapshot.assignments.find(
            (entry) => entry.id === command.assignmentId,
          );
          const manager = snapshot.managers.find((entry) => entry.id === assignment?.managerId);
          if (!assignment || !manager || !assignment.modelPolicy)
            return yield* new FactoryError({ code: "invalid-state" });
          const policy = constrainFactoryModelPolicy(
            assignment.modelPolicy,
            resolveFactoryModelPolicy(
              snapshot.modelDefaults,
              manager.modelOverrides,
              manager.modelSelection,
            ),
          );
          const choice = selectFactoryModel({
            policy,
            role: command.type === "assignment.recovery.replan" ? "lead" : "reviewer",
            complexity: assignment.complexity ?? "standard",
          });
          if (Result.isFailure(choice)) return yield* choice.failure;
          const selected = {
            threadId: ThreadId.make(yield* randomUuidV4),
            modelSelection: choice.success.selection,
          };
          if (command.type === "delivery.review.request")
            deliveryContext = { deliveryReviewAllocation: selected };
          else
            oversightContext =
              command.type === "assignment.recovery.begin"
                ? { auxiliaryAllocation: selected }
                : { replacementAllocation: selected };
        }
        let humanMessageVerified = false;
        let humanMessageId: MessageId | undefined;
        if (
          command.type === "assignment.commission" &&
          actor.kind === "thread" &&
          command.candidateId === undefined
        ) {
          const records = yield* threads
            .getThreadRecords(
              actor.threadId,
              ["messages"],
              command.authorizationMessageId === undefined
                ? { messageRoles: ["user"] }
                : { messageIds: [command.authorizationMessageId] },
            )
            .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
          humanMessageId = records.messages.findLast(
            (message) =>
              (command.authorizationMessageId === undefined ||
                message.id === command.authorizationMessageId) &&
              message.role === "user" &&
              message.createdBy === "user" &&
              message.senderThreadId === undefined &&
              message.scheduledTaskId === undefined,
          )?.id;
          humanMessageVerified = humanMessageId !== undefined;
        }
        let handoverVerified = false;
        if (command.type === "assignment.handover" && actor.kind === "human") {
          const thread = yield* threads
            .getThreadShell(command.threadId)
            .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
          const manager = snapshot.managers.find((entry) => entry.id === command.managerId);
          handoverVerified =
            thread !== null &&
            thread.projectId === manager?.projectId &&
            thread.deletedAt === null &&
            thread.archivedAt === null &&
            thread.lineage.parentThreadId === null &&
            thread.lineage.relationshipToParent !== "subagent";
        }
        const now = yield* nowIso;
        const preflight = decide({
          state: snapshot,
          actor,
          command,
          now,
          humanMessageVerified,
          ...(humanMessageId === undefined ? {} : { humanMessageId }),
          handoverVerified,
          ...oversightContext,
          ...deliveryContext,
          ...retroContext,
          ...schedulingContext,
          ...(allocation === undefined ? {} : { allocation }),
        });
        if (Result.isFailure(preflight)) {
          if (schedulingContext.schedulingAdmission && Option.isSome(scheduling))
            yield* scheduling.value.release(schedulingContext.schedulingAdmission.candidateId);
          return yield* preflight.failure;
        }
        if (
          preflight.success.effects.some(
            (effect) =>
              effect.type.startsWith("delivery.") &&
              (effect.type.startsWith("delivery.preview.")
                ? Option.isNone(previews)
                : Option.isNone(deliveryEffects)),
          )
        )
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: "This environment has no qualified delivery runtime for that action.",
          });
        for (const assignment of snapshot.assignments) {
          const next = preflight.success.state.assignments.find(
            (entry) => entry.id === assignment.id,
          );
          if (
            assignment.grant !== undefined &&
            next?.grant !== undefined &&
            assignment.grant.epoch !== next.grant.epoch
          ) {
            yield* boundaries.stop(assignment.id);
          }
        }
        if (command.type === "manager.create") {
          const project = yield* projects
            .getById(command.projectId)
            .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
          if (Option.isNone(project)) return yield* new FactoryError({ code: "invalid-state" });
        }
        const requested =
          command.type === "manager.create"
            ? command
            : command.type === "manager.retry-onboarding"
              ? preflight.success.state.managers.find((manager) => manager.id === command.managerId)
              : undefined;
        if (requested !== undefined && actor.kind !== "human") {
          return yield* new FactoryError({ code: "permission-denied" });
        }
        const previousAssignment =
          command.type === "manager.retry-onboarding"
            ? snapshot.assignments.find((entry) => entry.managerId === command.managerId)
            : undefined;
        const replacingSetup =
          command.type === "manager.retry-onboarding" &&
          (command.workflow !== undefined || command.modelSelection !== undefined);
        if (replacingSetup && requested !== undefined && previousAssignment !== undefined) {
          for (const threadId of [command.managerId, previousAssignment.threadId]) {
            if (
              (yield* threads
                .getThreadShell(threadId)
                .pipe(
                  Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })),
                )) !== null
            )
              return yield* new FactoryError({ code: "invalid-state" });
          }
        }
        const qualification =
          requested?.projectId == null
            ? undefined
            : !replacingSetup && previousAssignment?.qualification.status === "qualified"
              ? previousAssignment.qualification
              : yield* execution.qualify({
                  projectId: requested.projectId,
                  modelSelection: requested.modelSelection,
                  workflow: requested.workflow,
                });
        const boundary =
          command.type === "manager.approve-onboarding"
            ? yield* boundaries.approve({
                managerId: command.managerId,
                configuration: command.configuration,
              })
            : undefined;
        if (command.type === "assignment.file.mutate") yield* boundaries.mutate(command);
        const verification =
          command.type === "assignment.verify" ? yield* boundaries.verify(command) : undefined;
        const result = yield* store
          .commit({
            actor,
            command,
            now: yield* nowIso,
            humanMessageVerified,
            ...(humanMessageId === undefined ? {} : { humanMessageId }),
            handoverVerified,
            ...oversightContext,
            ...deliveryContext,
            ...retroContext,
            ...schedulingContext,
            ...(allocation === undefined ? {} : { allocation }),
            ...(qualification === undefined ? {} : { qualification }),
            ...(boundary === undefined ? {} : { boundary }),
            ...(verification === undefined ? {} : { verification }),
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                const candidateId = schedulingContext.schedulingAdmission?.candidateId;
                if (
                  candidateId &&
                  Option.isSome(scheduling) &&
                  !(yield* store.snapshot).assignments.some(
                    (entry) => entry.scheduling?.candidateId === candidateId,
                  )
                )
                  yield* scheduling.value.release(candidateId);
                return yield* cause;
              }),
            ),
          );
        yield* wake;
        if (command.type === "delivery.preview.stop" && Option.isSome(previews))
          yield* previews.value.reconcile;
        return result;
      }, commands.withPermits(1)),
    });
    return FactoryService.of({
      ...service,
      dispatch: (actor, command) => {
        if (
          [
            "manager.pause",
            "manager.resume",
            "project.pause",
            "project.resume",
            "thread.takeover",
            "thread.handback",
            "assignment.cancel",
            "assignment.cancellation-reason",
            "control.retry",
            "guidance.escalate",
          ].includes(command.type)
        )
          return withCommand(
            command.commandId,
            Effect.gen(function* () {
              const receipt = yield* store.findReceipt({ actor, command });
              if (receipt !== undefined) return receipt;
              const context: FactoryControlContext = yield* controlContext(command);
              const result = yield* store.commit({
                actor,
                command,
                ...context,
                now: yield* nowIso,
              });
              yield* wake;
              if (Option.isSome(previews))
                yield* previews.value.reconcile.pipe(
                  Effect.catch((cause) =>
                    Effect.logError("Factory preview shutdown remains pending after control", {
                      cause,
                    }),
                  ),
                );
              return result;
            }),
          );
        if (command.type !== "assignment.file.mutate" && command.type !== "assignment.verify")
          return withCommand(command.commandId, service.dispatch(actor, command));
        return withCommand(
          command.commandId,
          Effect.gen(function* () {
            const receipt = yield* store.findReceipt({ actor, command });
            if (receipt !== undefined) return receipt;
            const preflight = decide({
              state: yield* store.snapshot,
              actor,
              command,
              now: yield* nowIso,
            });
            if (Result.isFailure(preflight)) return yield* preflight.failure;
            if (command.type === "assignment.file.mutate") yield* boundaries.mutate(command);
            const verification =
              command.type === "assignment.verify" ? yield* boundaries.verify(command) : undefined;
            return yield* store.commit({
              actor,
              command,
              now: yield* nowIso,
              ...(verification === undefined ? {} : { verification }),
            });
          }),
        );
      },
    });
  }),
).pipe(
  Layer.provide(FactoryControlEffects.layer),
  Layer.provide(FactoryRecoveryEffects.layer),
  Layer.provide(FactoryReconciliation.layer),
  Layer.provide(FactoryRecoveryReconciliation.layer),
  Layer.provide(FactoryControlAccess.layer),
);
