import {
  CommandId,
  FactoryAssignmentId,
  FactoryError,
  MessageId,
  ThreadId,
  factorySystemManager,
  type FactoryCommand,
  type FactoryCommandResult,
  type FactoryQuery,
  type FactorySnapshot,
  type FactoryMergeGroupQuery,
  type FactoryMergeGroupRead,
  type OrchestrationV2StoredEvent,
  type FactoryHostCommand,
  type ModelSelection,
  type ProjectId,
  isConfinableProviderDriver,
  isFactoryError,
} from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as ThreadGovernance from "../orchestration-v2/ThreadGovernance.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import * as FactorySource from "./FactorySource.ts";
import * as FactorySkills from "./FactorySkills.ts";
import * as FactoryHandover from "./FactoryHandover.ts";
import * as FactoryStore from "./FactoryStore.ts";
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
import * as FactoryDeliveryEffects from "./FactoryDeliveryEffects.ts";
import * as FactoryPreviewService from "./FactoryPreviewService.ts";
import * as FactoryRetroEffects from "./FactoryRetroEffects.ts";
import { type FactoryRetroContext } from "./FactoryRetros.ts";
import * as FactorySchedulingEffects from "./FactorySchedulingEffects.ts";
import * as FactoryImprovementEffects from "./FactoryImprovementEffects.ts";
import type { FactoryImprovementContext } from "./FactoryImprovements.ts";
import type { FactorySchedulingContext } from "./FactoryScheduling.ts";
import * as FactoryWorkflowEffects from "./FactoryWorkflowEffects.ts";
import * as FactoryCollaborationEffects from "./FactoryCollaborationEffects.ts";
import { scopeFactoryCollaboration } from "./FactoryCollaborationReadModel.ts";
import * as FactoryIntegrationEffects from "./FactoryIntegrationEffects.ts";
import * as FactoryMergeEffects from "./FactoryMergeEffects.ts";
import * as FactoryMergeOperationEffects from "./FactoryMergeOperationEffects.ts";
import {
  factoryMergeOperationReadiness,
  latestFactoryMergeOperation,
} from "./FactoryMergeOperation.ts";
import { factoryMergeGroupReadiness } from "./FactoryMerge.ts";
import { scopeFactoryMerge } from "./FactoryMergeReadModel.ts";
import { scopeFactoryIntegration } from "./FactoryIntegrationReadModel.ts";
import type { FactoryWorkflowContext } from "./FactoryWorkflow.ts";
import type { FactoryIntegrationContext } from "./FactoryIntegration.ts";
import { factorySharedAssignmentOwned } from "./FactoryWorkflowOwnership.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type FactoryControlContext } from "./FactoryControls.ts";
import * as FactoryThreadScope from "./FactoryThreadScope.ts";
import { deletedThreadDetail, factoryThreadDeleted } from "./FactoryThreadReach.ts";
import * as FactoryPrompts from "./FactoryPrompts.ts";

/** The service before its thread-scoped reads, which `FactoryThreadScope` builds from it. */
interface FactoryServiceCore {
  /** The unscoped state, narrowed to one project when the query names one. */
  readonly snapshot: (query: FactoryQuery) => Effect.Effect<FactorySnapshot, FactoryError>;
  /** Refuses a skills repository path that is not a Git repository with `skills/` at HEAD. */
  readonly validateSkillsRepository: (repositoryRoot: string) => Effect.Effect<void, FactoryError>;
  readonly mergeGroupGet: (
    query: FactoryMergeGroupQuery,
  ) => Effect.Effect<FactoryMergeGroupRead, FactoryError>;
  /** Emits the scoped snapshot on subscribe and after each new revision. */
  readonly changes: (query: FactoryQuery) => Stream.Stream<FactorySnapshot>;
  /**
   * Decides and commits one human or thread command, then wakes the workers. Idempotent by
   * command id: a repeat returns the first receipt, and reusing an id for a different request
   * fails with `command-conflict`. Host side effects the command needs (qualification, boundary
   * approval, file edits, verification) run before the commit, after a preflight decision.
   */
  readonly dispatch: (
    actor: Exclude<FactoryActor, { readonly kind: "system" }>,
    command: FactoryCommand,
  ) => Effect.Effect<FactoryCommandResult, FactoryError>;
  /** Waits until a full pass over every worker commits nothing new. */
  readonly drain: Effect.Effect<void>;
  /** Run at startup: asks for reconciliation of every open assignment and live auxiliary. */
  readonly recover: Effect.Effect<void, FactoryError>;
  /** Records a hint, such as a merged PR, that the project's work should reconcile. */
  readonly reconcileProject: (
    projectId: ProjectId,
    triggerId: string,
  ) => Effect.Effect<void, FactoryError>;
  /**
   * Feeds one orchestration event to the factory. PR syncs, run activity on managed threads and
   * direct human messages in them become host commands; anything else only advances the
   * observation cursor.
   */
  readonly observe: (event: OrchestrationV2StoredEvent) => Effect.Effect<void, FactoryError>;
}

/**
 * Owns the engineering factory: the only entry for factory commands from the human (RPC) and
 * from managed threads (the factory MCP tools, through the thread-scoped methods), and the
 * workers that carry out the decider's effect intents from the outbox.
 */
export class FactoryService extends Context.Service<
  FactoryService,
  FactoryServiceCore & FactoryThreadScope.FactoryThreadScope
>()("t3/factory/FactoryService") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

// A project view keeps that project's records and drops environment-wide ones: improvements
// and model recommendations.
const scopedSnapshot =
  (query: FactoryQuery) =>
  (snapshot: FactorySnapshot): FactorySnapshot => {
    if (query.projectId === undefined) return snapshot;
    const projectId = query.projectId;
    const assignments = snapshot.assignments.filter(
      (assignment) => assignment.projectId === projectId,
    );
    const assignmentIds = new Set<string>(assignments.map((assignment) => assignment.id));
    const inProject = (entry: { readonly assignmentId: string }) =>
      assignmentIds.has(entry.assignmentId);
    // A system manager is visible where it owns shared work in this project.
    const managers = snapshot.managers.filter(
      (manager) =>
        manager.projectId === projectId ||
        assignments.some(
          (assignment) =>
            assignment.managerId === manager.id &&
            factorySharedAssignmentOwned(snapshot, assignment),
        ),
    );
    const managerIds = new Set(managers.map((manager) => manager.id));
    return {
      ...snapshot,
      ...scopeFactoryCollaboration(snapshot, { kind: "project", projectId }),
      ...scopeFactoryIntegration(snapshot, { kind: "project", projectId }),
      ...scopeFactoryMerge(snapshot, { kind: "project", projectId }),
      sharedRepositories: snapshot.sharedRepositories.filter(
        (entry) => entry.projectId === projectId,
      ),
      sharedWorks: snapshot.sharedWorks.filter((entry) =>
        snapshot.sharedRepositories.some(
          (repository) =>
            repository.id === entry.plan.repositoryId && repository.projectId === projectId,
        ),
      ),
      experimentConfigurations: [],
      workflowExperiments: snapshot.workflowExperiments.filter(inProject),
      improvementValidations: [],
      modelRecommendations: [],
      improvementConfigurations: [],
      improvementIntakes: [],
      improvementBatches: [],
      improvementInvestigations: [],
      improvementProposals: [],
      improvementDecisions: [],
      improvementFeedback: [],
      improvementRecurrences: [],
      improvementEvidenceReads: [],
      managers,
      assignments,
      boundaries: snapshot.boundaries.filter((boundary) => boundary.projectId === projectId),
      controls: snapshot.controls.filter((control) =>
        control.kind === "project-pause"
          ? control.projectId === projectId
          : managerIds.has(control.managerId),
      ),
      guidance: snapshot.guidance.filter(inProject),
      dependencies: snapshot.dependencies.filter(inProject),
      auxiliaryThreads: snapshot.auxiliaryThreads.filter(
        (thread) => thread.projectId === projectId,
      ),
      mergeRules: snapshot.mergeRules.filter((rule) => rule.projectId === projectId),
      previewConfigurations: snapshot.previewConfigurations.filter(
        (config) => config.projectId === projectId,
      ),
      previewPublicationPolicies: snapshot.previewPublicationPolicies.filter(
        (policy) => policy.projectId === projectId,
      ),
      retros: snapshot.retros.filter(inProject),
      findings: snapshot.findings.filter(inProject),
      followups: snapshot.followups.filter((followup) => followup.projectId === projectId),
      projectTrackers: snapshot.projectTrackers.filter(
        (tracker) => tracker.projectId === projectId,
      ),
      schedulingConfigurations: snapshot.schedulingConfigurations.filter(
        (entry) => entry.projectId === projectId,
      ),
      scheduleCandidates: snapshot.scheduleCandidates.filter(
        (entry) => entry.projectId === projectId,
      ),
    };
  };

export const layer = Layer.effect(
  FactoryService,
  Effect.gen(function* () {
    const store = yield* FactoryStore.FactoryStore;
    const execution = yield* FactoryExecution.FactoryExecution;
    const boundaries = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
    const sources = yield* FactorySource.FactorySource;
    const skillsRepository = yield* FactorySkills.FactorySkills;
    const handovers = yield* FactoryHandover.FactoryHandover;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const controls = yield* FactoryControlAccess.FactoryControlAccess;
    const controlEffects = yield* FactoryControlEffects.FactoryControlEffects;
    const recoveryEffects = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
    const reconciliation = yield* FactoryReconciliation.FactoryReconciliation;
    const recoveryReconciliation =
      yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation;
    const deliveryEffects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
    const previews = yield* FactoryPreviewService.FactoryPreviewService;
    const retros = yield* FactoryRetroEffects.FactoryRetroEffects;
    const scheduling = yield* FactorySchedulingEffects.FactorySchedulingEffects;
    const improvements = yield* FactoryImprovementEffects.FactoryImprovementEffects;
    const workflows = yield* FactoryWorkflowEffects.FactoryWorkflowEffects;
    const collaboration = yield* FactoryCollaborationEffects.FactoryCollaborationEffects;
    const integrations = yield* FactoryIntegrationEffects.FactoryIntegrationEffects;
    const merges = yield* FactoryMergeEffects.FactoryMergeEffects;
    const mergeOperations = yield* FactoryMergeOperationEffects.FactoryMergeOperationEffects;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // The beta switch gates only the first manager. Once one exists, its work stays controllable
    // and new managers may join it, so turning the switch off never strands or weakens a team.
    const admitCreation = (command: FactoryCommand) =>
      command.type !== "manager.create" && command.type !== "system.create"
        ? Effect.void
        : Effect.gen(function* () {
            const settings = yield* serverSettings.getSettings.pipe(
              Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })),
            );
            if (settings.engineeringManagersEnabled || (yield* store.snapshot).managers.length > 0)
              return;
            return yield* new FactoryError({
              code: "invalid-state",
              detail:
                "Engineering managers are off. Turn on Engineering managers in Settings → General.",
            });
          });
    // Managed work runs only on providers the factory can confine, so a model policy never
    // approves another. An unknown instance cannot run at all and is left to admission.
    // The models a command writes into a model policy.
    const policyModels = (command: FactoryCommand): ReadonlyArray<ModelSelection> => {
      switch (command.type) {
        case "models.defaults.configure":
          return [
            ...command.policy.approvedModels,
            ...command.policy.preferences.map((preference) => preference.selection),
          ];
        case "manager.models.configure":
          return [
            ...(command.overrides.approvedModels ?? []),
            ...(command.overrides.preferences ?? []).map((preference) => preference.selection),
          ];
        case "system.create":
          return [command.modelSelection];
        case "system.retry":
          return command.modelSelection === undefined ? [] : [command.modelSelection];
        default:
          return [];
      }
    };
    const admitModels = (command: FactoryCommand) =>
      Effect.forEach(
        policyModels(command),
        (selection) =>
          providerInstances.getInstance(selection.instanceId).pipe(
            Effect.flatMap((instance) =>
              instance === undefined || isConfinableProviderDriver(instance.driverKind)
                ? Effect.void
                : Effect.fail(
                    new FactoryError({
                      code: "invalid-state",
                      detail:
                        "Managed execution requires a provider with a confined runtime (Codex or Claude).",
                    }),
                  ),
            ),
          ),
        { discard: true },
      );
    // `commands` serializes general dispatches and thread launches. Controls and boundary file
    // operations skip it, so they never queue behind a slow dispatch. `withCommand` serializes
    // concurrent calls with one command id, so the later call finds the first call's receipt.
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

    /**
     * Creates a manager, onboarding or implementation thread and sends its first message.
     * Retires the intent once it no longer applies; leaves it pending while the manager is
     * blocked or paused or direction is held. Safe to rerun: the thread and first message use
     * fixed ids, and a message already accepted counts as delivered once its run exists.
     */
    const launch = Effect.fn("FactoryService.launch")(function* (
      pending: FactoryStore.PendingFactoryEffect,
    ) {
      const { intent } = pending;
      if (intent.type !== "thread.launch") return;
      const snapshot = yield* store.snapshot;
      const assignment = snapshot.assignments.find((entry) => entry.id === intent.assignmentId);
      const manager = snapshot.managers.find((entry) => entry.id === intent.managerId);
      if (
        assignment === undefined ||
        manager === undefined ||
        manager.status === "retired" ||
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
          (existing.projectId !== intent.projectId || existing.archivedAt !== null)
        )
          return yield* new FactoryError({ code: "invalid-state" });
        if (existing === null && (yield* factoryThreadDeleted(threads, intent.threadId)))
          return yield* new FactoryError({ code: "invalid-state", detail: deletedThreadDetail });
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
        else if (assignment.integrationId && existing.worktreePath !== profile.projectSnapshotPath)
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`factory:${pending.id}:workspace`),
            threadId: intent.threadId,
            worktreePath: profile.projectSnapshotPath,
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
          yield* scheduling.beforeLaunch(assignment, profile.projectSnapshotPath).pipe(
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
          text: FactoryPrompts.launchMessage({
            intent,
            assignment,
            manager,
            requiresSkillAuthoring: profile.requiresSkillAuthoring,
          }),
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
        // A tracker hold is not a launch failure: the intent stays pending for the next wake,
        // and the wait is recorded once per distinct reason.
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

    /**
     * Prepares an assignment's environment: stops a handed-over thread, captures the starting
     * source once, and qualifies the boundary for the current grant. Each stage is committed as
     * it lands, so a rerun resumes. A result for a grant epoch that has since changed is dropped.
     */
    const prepare = Effect.fn("FactoryService.prepare")(function* (
      pending: FactoryStore.PendingFactoryEffect,
    ) {
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
    // Runs one worker's share of the outbox. Handling an intent can commit new ones, so an
    // intent that moves the factory revision re-reads the outbox and runs `onProgress`.
    const drainIntents = <E>(
      accepts: (type: FactoryStore.PendingFactoryEffect["intent"]["type"]) => boolean,
      handle: (entry: FactoryStore.PendingFactoryEffect) => Effect.Effect<void, E>,
      onProgress: Effect.Effect<void> = Effect.void,
    ) =>
      Effect.gen(function* () {
        const visited = new Set<string>();
        for (;;) {
          const pending = (yield* store.pending).filter(
            (entry) => !visited.has(entry.id) && accepts(entry.intent.type),
          );
          if (pending.length === 0) return;
          for (const entry of pending) {
            visited.add(entry.id);
            const revision = (yield* store.latest).revision;
            yield* handle(entry);
            if ((yield* store.latest).revision !== revision) {
              workerProgress += 1;
              visited.clear();
              yield* onProgress;
            }
          }
        }
      });
    // A failed intent stays pending in the outbox; log it and carry on with the next one.
    const keepPending =
      <E>(
        message: string,
        handle: (entry: FactoryStore.PendingFactoryEffect) => Effect.Effect<void, E>,
      ) =>
      (entry: FactoryStore.PendingFactoryEffect) =>
        handle(entry).pipe(
          Effect.catch((cause) => Effect.logError(message, { effectId: entry.id, cause })),
        );
    const logFailure =
      (message: string) =>
      <E>(effect: Effect.Effect<void, E>) =>
        effect.pipe(Effect.catch((cause) => Effect.logError(message, { cause })));
    const enqueue = (...workers: ReadonlyArray<DrainableWorker<void>>) =>
      Effect.forEach(workers, (target) => target.enqueue(undefined), { discard: true });

    // Each worker owns a disjoint set of intent types, so slow host work in one area never holds
    // up another. A worker that commits progress wakes the workers its commits may unblock.
    const worker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      drainIntents(
        (type) =>
          type === "thread.launch" ||
          type === "assignment.prepare" ||
          type === "auxiliary.launch" ||
          type === "assignment.replace-lead",
        (entry) =>
          entry.intent.type === "assignment.prepare"
            ? prepare(entry)
            : entry.intent.type === "thread.launch"
              ? commands.withPermits(1)(launch(entry))
              : recoveryEffects.handle(entry),
        enqueue(controlWorker, oversightWorker, deliveryWorker, retroWorker),
      ),
    );
    const controlWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      drainIntents(
        (type) =>
          type === "control.stop" ||
          type === "control.resume" ||
          type === "thread.deliver" ||
          type === "thread.queue.resume",
        keepPending("Factory control effect remains pending", (entry) => controlEffects.run(entry)),
        enqueue(worker, oversightWorker, deliveryWorker, retroWorker),
      ),
    );
    const oversightWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      drainIntents(
        (type) => type === "assignment.reconcile" || type === "auxiliary.reconcile",
        keepPending("Factory reconciliation remains pending", (entry) =>
          entry.intent.type === "auxiliary.reconcile"
            ? recoveryReconciliation.handle(entry)
            : reconciliation.handle(entry),
        ),
        enqueue(worker, controlWorker, deliveryWorker, retroWorker),
      ),
    );
    const deliveryWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        yield* previews.reconcile.pipe(logFailure("Factory preview shutdown remains pending"));
        yield* drainIntents(
          (type) => type.startsWith("delivery."),
          keepPending("Factory delivery remains pending", (entry) =>
            entry.intent.type === "delivery.preview.start" ||
            entry.intent.type === "delivery.preview.stop"
              ? previews.handle(entry)
              : deliveryEffects.handle(entry),
          ),
          enqueue(worker, controlWorker, oversightWorker, retroWorker),
        );
      }),
    );
    const retroWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        yield* retros.reconcile.pipe(
          logFailure("Factory retrospective reconciliation remains pending"),
        );
        yield* drainIntents(
          (type) =>
            type === "assignment.conclude" ||
            type.startsWith("retro.") ||
            type.startsWith("followup."),
          keepPending("Factory retrospective work remains pending", (entry) =>
            retros.handle(entry),
          ),
          enqueue(worker, controlWorker, oversightWorker, deliveryWorker),
        );
      }),
    );
    const schedulingWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        const reconcile = scheduling.reconcile.pipe(
          logFailure("Factory scheduling reconciliation failed"),
        );
        yield* reconcile;
        yield* drainIntents(
          (type) => type.startsWith("schedule."),
          keepPending("Factory scheduling remains pending", (entry) => scheduling.handle(entry)),
          reconcile,
        );
      }),
    );
    const improvementWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        const reconcile = improvements.reconcile.pipe(
          logFailure("Factory improvement intake remains pending"),
        );
        yield* reconcile;
        yield* drainIntents(
          (type) => type.startsWith("improvement.") || type === "system.launch",
          keepPending("Factory improvement work remains pending", (entry) =>
            improvements.handle(entry),
          ),
          reconcile,
        );
      }),
    );
    const workflowWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      drainIntents(
        (type) => type.startsWith("workflow."),
        keepPending("Factory workflow operation remains pending", (entry) =>
          workflows.handle(entry),
        ),
      ),
    );
    const collaborationWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        const reconcile = collaboration.reconcile.pipe(
          logFailure("Factory collaboration reconciliation remains pending"),
        );
        yield* reconcile;
        yield* drainIntents(
          (type) => type.startsWith("collaboration.") || type.startsWith("incident."),
          keepPending("Factory collaboration work remains pending", (entry) =>
            collaboration.handle(entry),
          ),
          reconcile.pipe(Effect.andThen(enqueue(worker, controlWorker))),
        );
      }),
    );
    // The integration lead's thread is created without a workspace; `launch` later points it at
    // the prepared integration workspace.
    const createIntegrationThread = Effect.fn("FactoryService.createIntegrationThread")(function* (
      pending: FactoryStore.PendingFactoryEffect,
    ) {
      if (pending.intent.type !== "integration.thread.create") return;
      const integrationId = pending.intent.integrationId;
      const state = yield* store.snapshot;
      const integration = state.integrations.find((entry) => entry.id === integrationId);
      const assignment = state.assignments.find((entry) => entry.id === integration?.assignmentId);
      if (!integration || !assignment || assignment.outcome || assignment.status === "complete") {
        yield* store.retireEffect(pending.id);
        return;
      }
      yield* store.beginEffect(pending.id);
      const result = yield* Effect.gen(function* () {
        if (!assignment.modelSelection)
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "The integration thread has no approved model selection.",
          });
        const existing = yield* threads.getThreadShell(assignment.threadId);
        if (
          existing &&
          (existing.projectId !== assignment.projectId ||
            existing.deletedAt !== null ||
            existing.archivedAt !== null)
        )
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "The allocated integration thread is unavailable.",
          });
        if (!existing)
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`factory:${pending.id}:create`),
            threadId: assignment.threadId,
            projectId: assignment.projectId,
            title: assignment.title ?? "Cross-project integration",
            modelSelection: assignment.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "system",
            creationSource: "server",
          });
      }).pipe(Effect.result);
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        ...(Result.isFailure(result) ? { failed: true } : {}),
        command: Result.isFailure(result)
          ? {
              type: "integration.thread.failed",
              commandId: CommandId.make(`${pending.id}:failed`),
              integrationId,
              reason:
                "The integration conversation could not be created. Retry after resolving the thread error.",
            }
          : {
              type: "integration.thread.created",
              commandId: CommandId.make(`${pending.id}:receipt`),
              integrationId,
              threadId: assignment.threadId,
            },
      });
    });
    // Stops have their own worker, so a hold lands even while other integration work runs.
    const integrationStopWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        for (const entry of (yield* store.pending).filter(
          (entry) => entry.intent.type === "integration.stop",
        ))
          yield* integrations.handle(entry).pipe(
            Effect.catch((cause) =>
              Effect.logError("Factory integration shutdown remains pending", {
                effectId: entry.id,
                cause,
              }),
            ),
          );
      }),
    );
    const integrationWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      drainIntents(
        (type) => type.startsWith("integration.") && type !== "integration.stop",
        keepPending("Factory integration work remains pending", (entry) =>
          entry.intent.type === "integration.thread.create"
            ? createIntegrationThread(entry)
            : integrations.handle(entry),
        ),
        enqueue(worker, controlWorker),
      ),
    );
    const mergeWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      drainIntents(
        (type) => type.startsWith("merge.group.") || type.startsWith("merge.operation."),
        keepPending("Factory shared delivery remains pending", (entry) =>
          entry.intent.type.startsWith("merge.operation.")
            ? mergeOperations.handle(entry)
            : merges.handle(entry),
        ),
        enqueue(worker, controlWorker),
      ),
    );
    const wake = Effect.all(
      [
        worker.enqueue(undefined),
        controlWorker.enqueue(undefined),
        oversightWorker.enqueue(undefined),
        deliveryWorker.enqueue(undefined),
        retroWorker.enqueue(undefined),
        schedulingWorker.enqueue(undefined),
        improvementWorker.enqueue(undefined),
        workflowWorker.enqueue(undefined),
        collaborationWorker.enqueue(undefined),
        integrationWorker.enqueue(undefined),
        integrationStopWorker.enqueue(undefined),
        mergeWorker.enqueue(undefined),
      ],
      {
        discard: true,
      },
    );
    // Intents left in the outbox by the previous run resume once the server activates.
    if ((yield* ServerActivation.ServerActivation) === undefined) yield* wake;
    else yield* ServerActivation.forkParked(wake);
    yield* scheduling.watch(wake);
    yield* improvements.watch(wake);
    yield* ServerActivation.forkParked(
      store.changes.pipe(
        Stream.changesWith((left, right) => left.revision === right.revision),
        Stream.runForEach(() => collaborationWorker.enqueue(undefined)),
      ),
    );
    yield* ServerActivation.forkParked(
      store.changes.pipe(
        Stream.changesWith((left, right) => left.revision === right.revision),
        Stream.runForEach(() =>
          Effect.all(
            [integrationWorker.enqueue(undefined), integrationStopWorker.enqueue(undefined)],
            { discard: true },
          ),
        ),
      ),
    );
    yield* ServerActivation.forkParked(
      store.changes.pipe(
        Stream.changesWith((left, right) => left.revision === right.revision),
        Stream.runForEach(() => mergeWorker.enqueue(undefined)),
      ),
    );
    // Workers wake each other, so one pass is not enough; repeat until a pass makes no progress.
    const drain = Effect.gen(function* () {
      for (;;) {
        const progress = workerProgress;
        yield* worker.drain;
        yield* controlWorker.drain;
        yield* oversightWorker.drain;
        yield* deliveryWorker.drain;
        yield* retroWorker.drain;
        yield* schedulingWorker.drain;
        yield* improvementWorker.drain;
        yield* workflowWorker.drain;
        yield* collaborationWorker.drain;
        yield* integrationWorker.drain;
        yield* integrationStopWorker.drain;
        yield* mergeWorker.drain;
        if (progress === workerProgress) return;
      }
    });

    // Facts the control decider cannot read itself: the managed thread a takeover targets, and
    // for an escalation, proof that the named message is a direct human message in a managed
    // thread.
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
          ThreadGovernance.directionSender(entry) === undefined,
      );
      return message === undefined ? {} : { guidance: { messageId: message.id, target } };
    });

    const service: FactoryServiceCore = {
      snapshot: (query) => store.snapshot.pipe(Effect.map(scopedSnapshot(query))),
      validateSkillsRepository: (repositoryRoot) => skillsRepository.validate(repositoryRoot),
      mergeGroupGet: Effect.fn("FactoryService.mergeGroupGet")(function* (query) {
        const state = yield* store.snapshot;
        const group = state.mergeGroups.find((entry) => entry.id === query.groupId);
        const assignment = state.assignments.find(
          (entry) => entry.id === group?.integrationAssignmentId,
        );
        if (!group || !assignment)
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "This merge group is unavailable in the current environment.",
          });
        const operationReadiness = factoryMergeOperationReadiness(state, group.id);
        return {
          group,
          readiness: {
            ...factoryMergeGroupReadiness(state, group.id),
            canRequestMerge: operationReadiness.canStart,
          },
          currentReview:
            state.mergeGroupReviews.find((entry) => entry.id === group.currentReviewId) ?? null,
          integrationLeadThreadId: assignment.threadId,
          operation: latestFactoryMergeOperation(state, group.id) ?? null,
          operationReadiness,
        };
      }),
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
          // A thread whose lineage fails closed has no record to update, so it is skipped.
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
            // Activity from a replaced lead or its subagents no longer speaks for the assignment.
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
          ThreadGovernance.directionSender(event.payload) === undefined
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
        const snapshot = yield* store.snapshot;
        const sharedManager =
          command.type === "shared.work.commission" || command.type === "experiment.commission"
            ? factorySystemManager(snapshot.managers)
            : undefined;
        const receiverManager =
          command.type === "collaboration.request.respond" &&
          command.response.kind === "accept" &&
          command.response.support.kind === "commission"
            ? snapshot.managers.find(
                (manager) =>
                  manager.id ===
                  snapshot.crossProjectRequests.find((request) => request.id === command.requestId)
                    ?.receiverManagerId,
              )
            : undefined;
        // Every command that creates an assignment gets fresh ids here; the decider rejects ids
        // already in use. Shared and accepted cross-project work go to the owning manager.
        const allocation =
          command.type === "manager.create" ||
          command.type === "assignment.commission" ||
          command.type === "assignment.handover" ||
          command.type === "integration.commission" ||
          sharedManager !== undefined ||
          receiverManager !== undefined
            ? {
                managerThreadId:
                  command.type === "manager.create"
                    ? ThreadId.make(yield* randomUuidV4)
                    : "managerId" in command
                      ? command.managerId
                      : (receiverManager ?? sharedManager)!.id,
                leadThreadId:
                  command.type === "assignment.handover"
                    ? command.threadId
                    : ThreadId.make(yield* randomUuidV4),
                assignmentId: FactoryAssignmentId.make(yield* randomUuidV4),
              }
            : undefined;
        // Whatever this command creates records the skills repository's HEAD as of now. One read
        // serves the qualification, preflight and commit, so they all agree on the commit.
        const skills =
          allocation !== undefined ||
          command.type === "manager.retry-onboarding" ||
          command.type === "system.create" ||
          command.type === "system.retry" ||
          command.type === "shared.repository.register"
            ? yield* skillsRepository.head
            : undefined;
        const reportTarget =
          command.type === "assignment.commission" || command.type === "assignment.handover"
            ? command.scope.noPrTarget
            : command.type === "collaboration.request.respond" &&
                command.response.kind === "accept" &&
                command.response.support.kind === "commission"
              ? command.response.support.work.scope.noPrTarget
              : undefined;
        // A no-PR report may go only to the manager or the recipient a dependency agreed on, and
        // that thread must be live in the manager's project.
        if (reportTarget?.kind === "report-received") {
          const recipientId = reportTarget.recipientThreadId;
          const manager =
            receiverManager ??
            snapshot.managers.find(
              (entry) => "managerId" in command && entry.id === command.managerId,
            );
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
        let improvementContext: FactoryImprovementContext = {};
        let workflowContext: FactoryWorkflowContext = {};
        let integrationContext: FactoryIntegrationContext = {};
        if (
          actor.kind === "thread" &&
          (command.type === "integration.file.mutate" || command.type === "integration.verify")
        ) {
          yield* controls.assertExecution(actor.threadId);
          const membership = yield* controls.membership(actor.threadId);
          if (membership?.assignmentId)
            integrationContext = { integrationActorAssignmentId: membership.assignmentId };
        }
        workflowContext = yield* workflows.context(actor, command, skills);
        improvementContext = yield* improvements.context(actor, command, skills);
        retroContext = yield* retros.context(actor, command);
        schedulingContext = yield* scheduling.context(actor, command);
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
          // New reviewer, diagnosis and replacement lead threads take a model from the pool the
          // assignment and its manager still both approve.
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
        // A manager's commission needs a message the human typed in the manager thread, not one
        // a thread or scheduled task sent. Without a named message, the latest one counts.
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
        // Only a live top-level thread in the manager's project can be handed over.
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
        // Decide first so a refused command runs no host side effect. The commit decides again
        // against the latest state, with the side effects' results.
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
          ...improvementContext,
          ...workflowContext,
          ...integrationContext,
          ...(allocation === undefined ? {} : { allocation }),
          ...(skills === undefined ? {} : { skills }),
        });
        if (Result.isFailure(preflight)) {
          if (schedulingContext.schedulingAdmission)
            yield* scheduling.release(schedulingContext.schedulingAdmission.candidateId);
          return yield* preflight.failure;
        }
        // A moved grant epoch revokes that grant, so its running boundary stops before commit.
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
        const onboarding =
          requested === undefined
            ? undefined
            : preflight.success.state.assignments.find(
                (entry) =>
                  entry.kind === "onboarding" &&
                  entry.managerId ===
                    (command.type === "manager.create"
                      ? allocation?.managerThreadId
                      : "managerId" in command
                        ? command.managerId
                        : undefined),
              );
        // A retry before launch moves onboarding to the current skills commit, which needs a
        // fresh qualification just like a new model does.
        const replacingSetup =
          command.type === "manager.retry-onboarding" &&
          (command.modelSelection !== undefined ||
            onboarding?.workflow.revision !== previousAssignment?.workflow.revision ||
            onboarding?.workflow.repositoryRoot !== previousAssignment?.workflow.repositoryRoot);
        // The decider refuses a new setup once launch recorded a thread. A launch can create the
        // thread before recording it, so the threads themselves must not exist either.
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
        // Onboarding qualifies its read-only boundary, reusing an earlier qualification when the
        // retry keeps the same setup.
        const qualification =
          requested?.projectId == null || onboarding === undefined
            ? undefined
            : !replacingSetup && previousAssignment?.qualification.status === "qualified"
              ? previousAssignment.qualification
              : yield* execution.qualify({
                  projectId: requested.projectId,
                  modelSelection: requested.modelSelection,
                  workflow: onboarding.workflow,
                });
        const boundary =
          command.type === "manager.approve-onboarding"
            ? yield* boundaries.approve({
                managerId: command.managerId,
                configuration: command.configuration,
              })
            : command.type === "manager.refresh-boundary" && actor.kind === "human"
              ? yield* boundaries.refresh(command)
              : undefined;
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
            ...improvementContext,
            ...workflowContext,
            ...integrationContext,
            ...(allocation === undefined ? {} : { allocation }),
            ...(skills === undefined ? {} : { skills }),
            ...(qualification === undefined ? {} : { qualification }),
            ...(boundary === undefined ? {} : { boundary }),
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                const candidateId = schedulingContext.schedulingAdmission?.candidateId;
                if (
                  candidateId &&
                  !(yield* store.snapshot).assignments.some(
                    (entry) => entry.scheduling?.candidateId === candidateId,
                  )
                )
                  yield* scheduling.release(candidateId);
                return yield* cause;
              }),
            ),
          );
        yield* wake;
        if (command.type === "delivery.preview.stop") yield* previews.reconcile;
        return result;
      }, commands.withPermits(1)),
    };
    // Routes dispatch three ways. Controls commit directly, without preflight or the global lock,
    // and then shut down previews they stopped. Boundary file edits and verification check, run
    // in the boundary, then commit. Everything else takes the general path.
    const core: FactoryServiceCore = {
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
            "collaboration.request.withdraw",
            "incident.restrict",
            "incident.release",
            "incident.retry",
            "integration.grant.revoke",
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
              yield* previews.reconcile.pipe(
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
          return withCommand(
            command.commandId,
            admitCreation(command).pipe(
              Effect.andThen(admitModels(command)),
              Effect.andThen(service.dispatch(actor, command)),
            ),
          );
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
    };
    return FactoryService.of({ ...core, ...(yield* FactoryThreadScope.make(core)) });
  }),
).pipe(
  Layer.provide(FactoryControlEffects.layer),
  Layer.provide(FactoryRecoveryEffects.layer),
  Layer.provide(FactoryReconciliation.layer.pipe(Layer.provide(EffectOutbox.layer))),
  Layer.provide(FactoryRecoveryReconciliation.layer),
  Layer.provide(FactoryControlAccess.layer),
);
