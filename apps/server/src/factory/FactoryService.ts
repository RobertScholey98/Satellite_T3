import {
  CommandId,
  FactoryAssignmentId,
  FactoryError,
  MessageId,
  ThreadId,
  factorySystemManager,
  type FactoryCommand,
  type FactoryCommandResult,
  type FactoryThreadLaunchIntent,
  type FactoryQuery,
  type FactorySnapshot,
  type FactoryMergeGroupQuery,
  type FactoryMergeGroupRead,
  type OrchestrationV2StoredEvent,
  type FactoryHostCommand,
  type ProjectId,
  isFactoryError,
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

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import * as FactorySource from "./FactorySource.ts";
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
import { ServerActivation, forkParked } from "../serverActivation.ts";
import { type FactoryControlContext } from "./FactoryControls.ts";

export class FactoryService extends Context.Service<
  FactoryService,
  {
    readonly snapshot: (query: FactoryQuery) => Effect.Effect<FactorySnapshot, FactoryError>;
    readonly mergeGroupGet: (
      query: FactoryMergeGroupQuery,
    ) => Effect.Effect<FactoryMergeGroupRead, FactoryError>;
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
      workflowReleases: [],
      workflowAdoptions: [],
      workflowOverrides: [],
      workflowMigrations: snapshot.workflowMigrations.filter(inProject),
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
    const store = yield* FactoryStore.FactoryStore;
    const execution = yield* FactoryExecution.FactoryExecution;
    const boundaries = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
    const sources = yield* FactorySource.FactorySource;
    const handovers = yield* FactoryHandover.FactoryHandover;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const controls = yield* FactoryControlAccess.FactoryControlAccess;
    const controlEffects = yield* FactoryControlEffects.FactoryControlEffects;
    const recoveryEffects = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
    const reconciliation = yield* FactoryReconciliation.FactoryReconciliation;
    const recoveryReconciliation =
      yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation;
    const deliveryEffects = yield* Effect.serviceOption(
      FactoryDeliveryEffects.FactoryDeliveryEffects,
    );
    const previews = yield* Effect.serviceOption(FactoryPreviewService.FactoryPreviewService);
    const retros = yield* Effect.serviceOption(FactoryRetroEffects.FactoryRetroEffects);
    const scheduling = yield* Effect.serviceOption(
      FactorySchedulingEffects.FactorySchedulingEffects,
    );
    const improvements = yield* Effect.serviceOption(
      FactoryImprovementEffects.FactoryImprovementEffects,
    );
    const workflows = yield* Effect.serviceOption(FactoryWorkflowEffects.FactoryWorkflowEffects);
    const collaboration = yield* Effect.serviceOption(
      FactoryCollaborationEffects.FactoryCollaborationEffects,
    );
    const integrations = yield* Effect.serviceOption(
      FactoryIntegrationEffects.FactoryIntegrationEffects,
    );
    const merges = yield* Effect.serviceOption(FactoryMergeEffects.FactoryMergeEffects);
    const mergeOperations = yield* Effect.serviceOption(
      FactoryMergeOperationEffects.FactoryMergeOperationEffects,
    );
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
              : assignment.integrationId
                ? [
                    `You lead integration assignment ${assignment.id}, managed by ${manager.id}. Integration identity: ${assignment.integrationId}. Task: ${assignment.title}. Scope: ${assignment.scope?.description}.`,
                    `Read the owned workflow at /workflow, pinned to ${assignment.workflow.revision}. Use factory_integration_get to inspect the current immutable participant revisions, project-owned grants, preparation, shared plans and verification evidence. Each project manager owns its contribution; the requesting manager cannot extend another project's access.`,
                    "The prepared workspace contains namespaced candidate snapshots. Production and protected runner files are read-only. Edit only granted test and fixture files. Use factory_integration_command integration.file.mutate for creation, deletion and renames, identifying the current preparation and project grant. Every child agent inherits the same combined boundary.",
                    "Use integration.verify to run the protected combined checks. Verification stops writers, captures the exact permitted test bytes and then resumes eligible work. A passed old run does not verify changed candidate revisions or later test edits. Refresh explicitly when an owning lead supplies new candidate inputs; retained test edits are preserved or reported as conflicts.",
                    "Send production defects with integration.defect.report to the owning implementation lead. Use integration.message.send for direct coordination with current participant leads. Request missing scope from the owning managers. Do not patch production files or direct unrelated threads.",
                    "Return test patch artifacts to their owning leads through factory_integration_read_patch. They incorporate those changes into their PR candidates before final combined verification. A temporary passing test overlay does not prove that the published change includes those tests.",
                    "Read your merge group from factory_snapshot and use factory_merge_group_get for the current combined review and blockers. Once the published candidates pass combined verification, refresh the review through factory_merge_group_review. The human reviews the exact combined evidence here and gives corrections directly to owning leads. You cannot approve your own review or bypass a member's required approval.",
                    "Your team owns combined QA and the consolidated review point. Individual project checks, reviews and human approvals still apply. Do not publish an independent integration PR, merge a member separately, or conclude through a generic report. Completion waits for the confirmed shared merge operation, followed by your internal retro and the requesting-manager retro. Starting the shared merge stops your team; you can still reconcile, retry within its bounds, or escalate it to the human with factory_merge_operation_action.",
                    `Approved model policy: ${renderJson(assignment.modelPolicy)}. Use delegate_task for your internal team, selecting approved models for task complexity. Read current factory controls before continuing after an interruption.`,
                  ].join("\n\n")
                : intent.purpose === "implementation"
                  ? [
                      `You lead implementation assignment ${assignment.id} for engineering manager ${manager.id}. You own implementation, your team's reviews, verification, and the complete PR process.`,
                      `Task: ${assignment.title}. Scope: ${assignment.scope?.description}. Completion: ${assignment.scope?.completionCondition}. Pull request required: ${assignment.scope?.requiresPullRequest ?? true}.`,
                      `The owned workflow is pinned to ${assignment.workflow.revision} at /workflow. Read its relevant skills. Your approved starting source is ${assignment.startingSource?.revision} (${assignment.startingSource?.sourceDigest}); preserve any handed-over work and existing PR links.`,
                      `Approved execution grant: ${renderJson(assignment.grant)}. Existing granted files can be edited normally. For creating, renaming, or deleting files use factory_dispatch assignment.file.mutate with the current grant epoch. Use assignment.verify to run the adopted immutable checks and retain its evidence.`,
                      ...(profile.requiresSkillAuthoring
                        ? [
                            "This assignment creates or edits agent instructions or skills. Before changing them, use /workflow/skills/writing-for-agents/SKILL.md and its SKILL-MECHANICS.md reference, then read and apply every further reference relevant to the edit. Your authoring baseline remains read-only; write only the authorized candidate files.",
                          ]
                        : []),
                      ...(assignment.sharedWork
                        ? [
                            assignment.sharedWork.kind === "experiment"
                              ? "This is an isolated investigation experiment. Produce candidate work and a report for the system manager. Publication, tracker changes, PR creation, merge, deployment, live trials, and workflow adoption are not authorized. A new candidate file does not become an adopted instruction. Complete through the exact commissioned report target."
                              : "The system manager owns this shared repository assignment. Your team owns implementation, internal review and the PR process. Human PR approval and separate human adoption are required; completing this change never changes the adopted workflow.",
                          ]
                        : []),
                      `Approved exact models: ${renderJson(assignment.modelPolicy)}. Your selected model: ${renderJson(assignment.modelChoice)}. Choose approved models according to task complexity. Native subagent tools are disabled; use delegate_task for your internal team. Every descendant remains inside this assignment's boundary.`,
                      "Raise an out-of-scope dependency or structural problem when discovered. Do not change protected controls without a separately authorized rule-change assignment. The manager coordinates priorities; it does not review your PR. When the human changes this assignment's scope or priority in any of its threads, send that message to the manager with guidance.escalate (threadId, messageId, summary).",
                      "For an accepted cross-project request, coordinate directly with its current peer lead through collaboration.message.send. Record shared technical changes with collaboration.plan.propose and acknowledge the same plan within each team's existing scope. Changes to outcomes, compatibility, grants or resource limits need a boundary plan (collaboration.plan.propose with changes.kind boundary, plus amendments for new request commitments) that the owning managers or the human approve with collaboration.plan.decide. Peer coordination does not grant access to unrelated threads or source files.",
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
                      "Use factory_collaboration_directory to find a peer manager, then collaboration.request.create to request another project's work against an existing assignment. The receiving manager owns acceptance and commissions its own team with collaboration.request.respond. Defer or decline only with a concrete reason and alternative or reconsideration condition. Raise a single collaboration.decision.raise when existing priorities or authority cannot settle a trade-off. An incident does not stop unrelated work; use incident.restrict only for concrete conflicting assignments and activity, with a reason and resume condition, then incident.release when resolved.",
                      "For accepted cross-project work, the requesting manager can use integration.commission to create an integration lead. Each participating manager grants only its project's qualified test/fixture access with integration.grant. Capability setup or expansion requires the human; routine narrower grants do not. The integration team owns combined verification and routes production defects to the implementation leads. You do not review their PRs or override another manager's grants.",
                      "Currently onboarding is in progress. Acknowledge the assignment briefly, then wait for an actionable event or the human. Do not poll, start implementation, or attempt to broaden execution permissions. Unresolved permissions and project decisions must remain visible.",
                      "When factory_snapshot shows an active manager with an approved boundary and the human requests work, use assignment.commission to create a scoped implementation lead. Choose exact source paths and creation directories within that boundary, a completion condition, and task complexity. Omit modelSelection for the configured lead preference. authorizationMessageId may reference the direct human request, or omit it to use the latest direct human message. Each human request authorizes one commission; ask again before commissioning more work from it. If the requested work is a ticket in factory_snapshot scheduleCandidates, prepare it and pass its candidateId with authorizationMessageId so the ticket is reserved. Discuss gaps with the human before commissioning unclear work.",
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
        if (Option.isNone(deliveryEffects) && Option.isNone(previews)) return;
        if (Option.isSome(previews))
          yield* previews.value.reconcile.pipe(
            logFailure("Factory preview shutdown remains pending"),
          );
        yield* drainIntents(
          (type) => type.startsWith("delivery."),
          keepPending("Factory delivery remains pending", (entry) => {
            const handler =
              entry.intent.type === "delivery.preview.start" ||
              entry.intent.type === "delivery.preview.stop"
                ? previews
                : deliveryEffects;
            return Option.isNone(handler) ? Effect.void : handler.value.handle(entry);
          }),
          enqueue(worker, controlWorker, oversightWorker, retroWorker),
        );
      }),
    );
    const retroWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        if (Option.isNone(retros)) return;
        yield* retros.value.reconcile.pipe(
          logFailure("Factory retrospective reconciliation remains pending"),
        );
        yield* drainIntents(
          (type) =>
            type === "assignment.conclude" ||
            type.startsWith("retro.") ||
            type.startsWith("followup."),
          keepPending("Factory retrospective work remains pending", (entry) =>
            retros.value.handle(entry),
          ),
          enqueue(worker, controlWorker, oversightWorker, deliveryWorker),
        );
      }),
    );
    const schedulingWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        if (Option.isNone(scheduling)) return;
        const reconcile = scheduling.value.reconcile.pipe(
          logFailure("Factory scheduling reconciliation failed"),
        );
        yield* reconcile;
        yield* drainIntents(
          (type) => type.startsWith("schedule."),
          keepPending("Factory scheduling remains pending", (entry) =>
            scheduling.value.handle(entry),
          ),
          reconcile,
        );
      }),
    );
    const improvementWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        if (Option.isNone(improvements)) return;
        const reconcile = improvements.value.reconcile.pipe(
          logFailure("Factory improvement intake remains pending"),
        );
        yield* reconcile;
        yield* drainIntents(
          (type) => type.startsWith("improvement.") || type === "system.launch",
          keepPending("Factory improvement work remains pending", (entry) =>
            improvements.value.handle(entry),
          ),
          reconcile,
        );
      }),
    );
    const workflowWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Option.isNone(workflows)
        ? Effect.void
        : drainIntents(
            (type) => type.startsWith("workflow."),
            keepPending("Factory workflow operation remains pending", (entry) =>
              workflows.value.handle(entry),
            ),
          ),
    );
    const collaborationWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        if (Option.isNone(collaboration)) return;
        const reconcile = collaboration.value.reconcile.pipe(
          logFailure("Factory collaboration reconciliation remains pending"),
        );
        yield* reconcile;
        yield* drainIntents(
          (type) => type.startsWith("collaboration.") || type.startsWith("incident."),
          keepPending("Factory collaboration work remains pending", (entry) =>
            collaboration.value.handle(entry),
          ),
          reconcile.pipe(Effect.andThen(enqueue(worker, controlWorker))),
        );
      }),
    );
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
    const integrationStopWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        if (Option.isNone(integrations)) return;
        for (const entry of (yield* store.pending).filter(
          (entry) => entry.intent.type === "integration.stop",
        ))
          yield* integrations.value.handle(entry).pipe(
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
      Option.isNone(integrations)
        ? Effect.void
        : drainIntents(
            (type) => type.startsWith("integration.") && type !== "integration.stop",
            keepPending("Factory integration work remains pending", (entry) =>
              entry.intent.type === "integration.thread.create"
                ? createIntegrationThread(entry)
                : integrations.value.handle(entry),
            ),
            enqueue(worker, controlWorker),
          ),
    );
    const mergeWorker: DrainableWorker<void> = yield* makeDrainableWorker((_wake: void) =>
      Option.isNone(merges) && Option.isNone(mergeOperations)
        ? Effect.void
        : drainIntents(
            (type) =>
              (Option.isSome(merges) && type.startsWith("merge.group.")) ||
              (Option.isSome(mergeOperations) && type.startsWith("merge.operation.")),
            keepPending("Factory shared delivery remains pending", (entry) => {
              const executor = entry.intent.type.startsWith("merge.operation.")
                ? mergeOperations
                : merges;
              return Option.isNone(executor) ? Effect.void : executor.value.handle(entry);
            }),
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
    if ((yield* ServerActivation) === undefined) yield* wake;
    else yield* forkParked(wake);
    if (Option.isSome(scheduling)) yield* scheduling.value.watch(wake);
    if (Option.isSome(improvements)) yield* improvements.value.watch(wake);
    if (Option.isSome(collaboration))
      yield* forkParked(
        store.changes.pipe(
          Stream.changesWith((left, right) => left.revision === right.revision),
          Stream.runForEach(() => collaborationWorker.enqueue(undefined)),
        ),
      );
    if (Option.isSome(integrations))
      yield* forkParked(
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
    if (Option.isSome(merges) || Option.isSome(mergeOperations))
      yield* forkParked(
        store.changes.pipe(
          Stream.changesWith((left, right) => left.revision === right.revision),
          Stream.runForEach(() => mergeWorker.enqueue(undefined)),
        ),
      );
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
        const runtimeAvailable = Option.isSome(mergeOperations);
        return {
          group,
          readiness: {
            ...factoryMergeGroupReadiness(state, group.id),
            canRequestMerge: runtimeAvailable && operationReadiness.canStart,
          },
          currentReview:
            state.mergeGroupReviews.find((entry) => entry.id === group.currentReviewId) ?? null,
          integrationLeadThreadId: assignment.threadId,
          operation: latestFactoryMergeOperation(state, group.id) ?? null,
          operationReadiness: runtimeAvailable
            ? operationReadiness
            : {
                ...operationReadiness,
                canStart: false,
                canRetry: false,
                canReconcile: false,
                canStop: false,
                reasons: [
                  ...operationReadiness.reasons,
                  "Coordinated merge execution is unavailable in this environment.",
                ],
              },
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
        const reportTarget =
          command.type === "assignment.commission" || command.type === "assignment.handover"
            ? command.scope.noPrTarget
            : command.type === "collaboration.request.respond" &&
                command.response.kind === "accept" &&
                command.response.support.kind === "commission"
              ? command.response.support.work.scope.noPrTarget
              : undefined;
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
          (command.type === "merge.group.start" || command.type.startsWith("merge.operation.")) &&
          Option.isNone(mergeOperations)
        )
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: "This environment has no coordinated merge runtime.",
          });
        if (command.type.startsWith("merge.group.") && Option.isNone(merges))
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: "This environment has no qualified shared review runtime.",
          });
        if (command.type.startsWith("integration.") && Option.isNone(integrations))
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: "This environment has no qualified integration runtime.",
          });
        if (
          actor.kind === "thread" &&
          (command.type === "integration.file.mutate" || command.type === "integration.verify")
        ) {
          yield* controls.assertExecution(actor.threadId);
          const membership = yield* controls.membership(actor.threadId);
          if (membership?.assignmentId)
            integrationContext = { integrationActorAssignmentId: membership.assignmentId };
        }
        if (
          Option.isNone(collaboration) &&
          (command.type.startsWith("collaboration.") || command.type.startsWith("incident."))
        )
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: "This environment has no qualified cross-project coordination runtime.",
          });
        if (Option.isSome(workflows))
          workflowContext = yield* workflows.value.context(actor, command);
        else if (
          command.type.startsWith("shared.") ||
          command.type.startsWith("workflow.") ||
          command.type.startsWith("experiment.")
        )
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: "This environment has no qualified workflow adoption runtime.",
          });
        if (Option.isSome(improvements))
          improvementContext = yield* improvements.value.context(actor, command);
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
          ...improvementContext,
          ...workflowContext,
          ...integrationContext,
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
        const qualification =
          requested?.projectId == null
            ? undefined
            : !replacingSetup && previousAssignment?.qualification.status === "qualified"
              ? previousAssignment.qualification
              : yield* execution.qualify({
                  projectId: requested.projectId,
                  modelSelection: requested.modelSelection,
                  workflow: onboarding?.workflow ?? requested.workflow,
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
            ...improvementContext,
            ...workflowContext,
            ...integrationContext,
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
              if (
                Option.isNone(collaboration) &&
                (command.type.startsWith("collaboration.") || command.type.startsWith("incident."))
              )
                return yield* new FactoryError({
                  code: "execution-unavailable",
                  detail: "This environment has no qualified cross-project coordination runtime.",
                });
              if (command.type.startsWith("integration.") && Option.isNone(integrations))
                return yield* new FactoryError({
                  code: "execution-unavailable",
                  detail: "This environment has no qualified integration runtime.",
                });
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
  Layer.provide(FactoryReconciliation.layer.pipe(Layer.provide(EffectOutbox.layer))),
  Layer.provide(FactoryRecoveryReconciliation.layer),
  Layer.provide(FactoryControlAccess.layer),
);
