import {
  FactoryError,
  type FactoryCollaborationDirectoryEntry,
  type FactoryCommand,
  type FactoryCommandResult,
  type FactoryImprovementRecord,
  type FactoryImprovementRecordRead,
  type FactoryImprovementSnapshot,
  type FactoryIntegrationRead,
  type FactoryMergeGroupQuery,
  type FactoryMergeGroupRead,
  type FactoryQuery,
  type FactorySnapshot,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { sha256 } from "@noble/hashes/sha2";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Struct from "effect/Struct";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import { scopeFactoryCollaboration } from "./FactoryCollaborationReadModel.ts";
import { factoryImprovementConfiguration } from "./FactoryImprovements.ts";
import { factoryIntegrationVerificationReadiness } from "./FactoryIntegration.ts";
import { scopeFactoryIntegration } from "./FactoryIntegrationReadModel.ts";
import { resolveFactoryLineage } from "./FactoryLineage.ts";
import { scopeFactoryMerge } from "./FactoryMergeReadModel.ts";
import type { FactoryActor } from "./FactoryState.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { factorySharedAssignmentOwned } from "./FactoryWorkflowOwnership.ts";

/**
 * What a managed thread may read and submit, derived from its identity alone.
 * Each method resolves the thread's manager, assignment or auxiliary role and
 * fails with `permission-denied` outside it, so parameters cannot widen the
 * scope. `FactoryService` exposes these for the factory MCP tools.
 */
export interface FactoryThreadScope {
  readonly threadSnapshot: (threadId: ThreadId) => Effect.Effect<FactorySnapshot, FactoryError>;
  readonly threadMergeGroup: (
    threadId: ThreadId,
    groupId: string,
  ) => Effect.Effect<FactoryMergeGroupRead, FactoryError>;
  readonly threadIntegration: (
    threadId: ThreadId,
    integrationId: string,
  ) => Effect.Effect<FactoryIntegrationRead, FactoryError>;
  /** The project of a test patch this thread may read. The integration runtime reads the patch. */
  readonly threadPatchProject: (
    threadId: ThreadId,
    patchArtifactId: string,
  ) => Effect.Effect<ProjectId, FactoryError>;
  readonly threadImprovements: (
    threadId: ThreadId,
    cursor?: number,
  ) => Effect.Effect<FactoryImprovementSnapshot, FactoryError>;
  readonly threadImprovementRecord: (
    threadId: ThreadId,
    input: FactoryImprovementRecordRead,
  ) => Effect.Effect<FactoryImprovementRecord, FactoryError>;
  readonly threadDirectory: (
    threadId: ThreadId,
    cursor?: number,
  ) => Effect.Effect<
    {
      readonly entries: readonly FactoryCollaborationDirectoryEntry[];
      readonly nextCursor: number | null;
    },
    FactoryError
  >;
  /** Succeeds when this thread may read the candidate's ticket. Scheduling reads the ticket. */
  readonly threadTicketAccess: (
    threadId: ThreadId,
    candidateId: string,
  ) => Effect.Effect<void, FactoryError>;
  readonly threadDispatch: (
    threadId: ThreadId,
    command: FactoryCommand,
  ) => Effect.Effect<FactoryCommandResult, FactoryError>;
}

const denied = () =>
  new FactoryError({
    code: "permission-denied",
    detail:
      "This managed thread can use only its scoped factory and approved team tools. This host tool is outside its execution grant.",
  });

const unavailable = () =>
  new FactoryError({
    code: "execution-unavailable",
    detail: "The managed execution boundary could not be verified. No host tool was run.",
  });

/**
 * The factory record a thread acts for, or undefined for an ordinary thread.
 * `ownerThreadId` is the manager, lead or auxiliary thread the lineage walk
 * matched, which differs from the caller for a subagent.
 */
export const makeThreadMember =
  (
    store: FactoryStore.FactoryStore["Service"],
    threads: ThreadManagementService.ThreadManagementService["Service"],
  ) =>
  (threadId: ThreadId) =>
    Effect.gen(function* () {
      const state = yield* store.snapshot.pipe(Effect.mapError(unavailable));
      const match = yield* resolveFactoryLineage({
        state,
        threadId,
        getThreadShell: (id) => threads.getThreadShell(id),
      }).pipe(Effect.mapError(unavailable));
      if (match === undefined) return undefined;
      const { threadId: ownerThreadId, manager, assignment, auxiliary } = match;
      if (manager !== undefined)
        return { ownerThreadId, manager, assignment: undefined, auxiliary: undefined };
      const owner = state.managers.find((entry) => entry.id === assignment?.managerId);
      if (
        assignment === undefined ||
        owner === undefined ||
        (owner.role === "system" && !factorySharedAssignmentOwned(state, assignment))
      )
        return yield* unavailable();
      return { ownerThreadId, manager: owner, assignment, auxiliary };
    });

/** Builds the scope from the service's own unscoped reads and dispatch. */
export const make = Effect.fn("FactoryThreadScope.make")(function* (core: {
  readonly snapshot: (query: FactoryQuery) => Effect.Effect<FactorySnapshot, FactoryError>;
  readonly mergeGroupGet: (
    query: FactoryMergeGroupQuery,
  ) => Effect.Effect<FactoryMergeGroupRead, FactoryError>;
  readonly dispatch: (
    actor: Exclude<FactoryActor, { readonly kind: "system" }>,
    command: FactoryCommand,
  ) => Effect.Effect<FactoryCommandResult, FactoryError>;
}) {
  const store = yield* FactoryStore.FactoryStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const controls = yield* FactoryControlAccess.FactoryControlAccess;
  const membership = makeThreadMember(store, threads);

  const managedCaller = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const member = yield* membership(threadId);
      if (member === undefined) return yield* denied();
      return member;
    });

  const integrationCaller = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const member = yield* managedCaller(threadId);
      if (
        member.auxiliary ||
        member.manager.role !== "project" ||
        (member.assignment === undefined
          ? member.manager.threadId !== threadId
          : member.assignment.threadId !== member.ownerThreadId ||
            (member.assignment.integrationId === undefined &&
              threadId !== member.assignment.threadId))
      )
        return yield* denied();
      yield* controls.assertExecution(threadId).pipe(Effect.mapError(unavailable));
      const state = yield* store.snapshot;
      const scoped = scopeFactoryIntegration(
        state,
        member.assignment
          ? {
              kind: "assignment",
              assignmentId: member.assignment.id,
              includeLeadCommunication: threadId === member.assignment.threadId,
            }
          : { kind: "manager", managerId: member.manager.id },
      );
      return { state, scoped, member };
    });

  return {
    threadSnapshot: (threadId) =>
      Effect.gen(function* () {
        const { manager, assignment } = yield* managedCaller(threadId);
        const snapshot =
          manager.role === "system" && assignment === undefined
            ? yield* store.snapshot
            : yield* core.snapshot({ projectId: assignment?.projectId ?? manager.projectId! });
        const ownedAssignments = snapshot.assignments.filter((entry) =>
          assignment === undefined ? entry.managerId === manager.id : entry.id === assignment.id,
        );
        const assignmentIds = new Set(ownedAssignments.map((entry) => entry.id));
        const projectIds = new Set(ownedAssignments.map((entry) => entry.projectId));
        if (manager.projectId !== null) projectIds.add(manager.projectId);
        const systemManager = manager.role === "system" && assignment === undefined;
        const repositories = snapshot.sharedRepositories.filter((entry) =>
          systemManager
            ? entry.managerId === manager.id
            : entry.id === assignment?.sharedWork?.repositoryId,
        );
        const repositoryIds = new Set(repositories.map((entry) => entry.id));
        const boundaryIds = new Set([
          ...ownedAssignments.flatMap((entry) => (entry.grant ? [entry.grant.boundaryId] : [])),
          ...repositories.map((entry) => entry.boundaryId),
        ]);
        return {
          ...snapshot,
          ...scopeFactoryMerge(
            snapshot,
            assignment === undefined
              ? { kind: "manager", managerId: manager.id }
              : { kind: "assignment", assignmentId: assignment.id },
          ),
          ...scopeFactoryIntegration(
            snapshot,
            assignment === undefined
              ? { kind: "manager", managerId: manager.id }
              : {
                  kind: "assignment",
                  assignmentId: assignment.id,
                  includeLeadCommunication: threadId === assignment.threadId,
                },
          ),
          ...scopeFactoryCollaboration(
            snapshot,
            assignment === undefined
              ? { kind: "manager", managerId: manager.id }
              : {
                  kind: "assignment",
                  assignmentId: assignment.id,
                  includeLeadCommunication: threadId === assignment.threadId,
                },
          ),
          improvementConfigurations: [],
          improvementIntakes: [],
          improvementBatches: [],
          improvementInvestigations: [],
          improvementProposals: [],
          improvementDecisions: [],
          improvementFeedback: [],
          improvementRecurrences: [],
          improvementEvidenceReads: [],
          sharedRepositories: repositories,
          sharedWorks: snapshot.sharedWorks.filter((entry) =>
            systemManager
              ? entry.managerId === manager.id
              : assignment?.sharedWork?.kind === "implementation" &&
                entry.id === assignment.sharedWork.workId,
          ),
          experimentConfigurations: systemManager
            ? snapshot.experimentConfigurations.slice(-1)
            : [],
          workflowExperiments: snapshot.workflowExperiments.filter((entry) =>
            systemManager ? entry.managerId === manager.id : entry.assignmentId === assignment?.id,
          ),
          workflowReleases: snapshot.workflowReleases.filter((entry) =>
            systemManager
              ? repositoryIds.has(entry.repositoryId)
              : entry.version.revision === assignment?.workflow.revision &&
                entry.version.repositoryRoot === assignment.workflow.repositoryRoot,
          ),
          workflowAdoptions: systemManager ? snapshot.workflowAdoptions : [],
          workflowOverrides: systemManager ? snapshot.workflowOverrides : [],
          workflowMigrations: snapshot.workflowMigrations.filter((entry) =>
            assignmentIds.has(entry.assignmentId),
          ),
          improvementValidations: snapshot.improvementValidations.filter(
            (entry) =>
              systemManager ||
              (entry.assignmentId !== null && assignmentIds.has(entry.assignmentId)),
          ),
          modelRecommendations: systemManager ? snapshot.modelRecommendations : [],
          managers: snapshot.managers.filter((entry) => entry.id === manager.id),
          assignments: ownedAssignments,
          boundaries: snapshot.boundaries.filter((entry) =>
            manager.role === "system" ? boundaryIds.has(entry.id) : projectIds.has(entry.projectId),
          ),
          mergeRules: manager.role === "system" ? [] : snapshot.mergeRules,
          previewConfigurations: snapshot.previewConfigurations.filter((entry) =>
            projectIds.has(entry.projectId),
          ),
          previewPublicationPolicies: snapshot.previewPublicationPolicies.filter((entry) =>
            projectIds.has(entry.projectId),
          ),
          projectTrackers: manager.role === "system" ? [] : snapshot.projectTrackers,
          schedulingConfigurations:
            manager.role === "system" ? [] : snapshot.schedulingConfigurations,
          guidance: snapshot.guidance.filter((entry) => assignmentIds.has(entry.assignmentId)),
          controls: snapshot.controls.flatMap((entry): FactorySnapshot["controls"] => {
            if (entry.kind === "manager-pause")
              return entry.managerId === manager.id
                ? [Struct.omit(entry, ["resumeThreadIds", "resumeQueues"])]
                : [];
            if (entry.kind === "project-pause")
              return projectIds.has(entry.projectId)
                ? [Struct.omit(entry, ["resumeThreadIds", "resumeQueues"])]
                : [];
            return assignmentIds.has(entry.assignmentId) ? [entry] : [];
          }),
          dependencies: snapshot.dependencies.filter(
            (entry) =>
              assignmentIds.has(entry.assignmentId) ||
              (entry.supportingAssignmentId != null &&
                assignmentIds.has(entry.supportingAssignmentId)),
          ),
          auxiliaryThreads: snapshot.auxiliaryThreads.filter((entry) =>
            assignmentIds.has(entry.assignmentId),
          ),
          retros: snapshot.retros.filter((entry) => assignmentIds.has(entry.assignmentId)),
          findings: snapshot.findings.filter((entry) => assignmentIds.has(entry.assignmentId)),
          followups: snapshot.followups.filter((entry) => assignmentIds.has(entry.assignmentId)),
          scheduleCandidates: snapshot.scheduleCandidates.filter((entry) =>
            assignment === undefined
              ? entry.managerId === manager.id
              : entry.id === assignment.scheduling?.candidateId,
          ),
        };
      }),
    threadMergeGroup: (threadId, groupId) =>
      Effect.gen(function* () {
        const member = yield* managedCaller(threadId);
        if (
          member.auxiliary ||
          !member.assignment?.integrationId ||
          threadId !== member.assignment.threadId
        )
          return yield* denied();
        yield* controls.assertExecution(threadId).pipe(Effect.mapError(unavailable));
        const state = yield* store.snapshot;
        const group = state.mergeGroups.find((entry) => entry.id === groupId);
        if (
          !group ||
          group.integrationAssignmentId !== member.assignment.id ||
          group.integrationId !== member.assignment.integrationId
        )
          return yield* denied();
        return yield* core.mergeGroupGet({ groupId });
      }),
    threadIntegration: (threadId, integrationId) =>
      Effect.gen(function* () {
        const { state, scoped } = yield* integrationCaller(threadId);
        const integration = scoped.integrations.find((entry) => entry.id === integrationId);
        if (!integration) return yield* denied();
        const slim = (id: FactorySnapshot["assignments"][number]["id"]) => {
          const assignment = state.assignments.find((entry) => entry.id === id);
          return assignment
            ? {
                assignmentId: assignment.id,
                projectId: assignment.projectId,
                managerId: assignment.managerId,
                threadId: assignment.threadId,
                title: assignment.title ?? null,
                status: assignment.status,
              }
            : null;
        };
        const grants = scoped.integrationGrants.filter(
          (entry) => entry.integrationId === integrationId,
        );
        const capabilityIds = new Set(grants.map((entry) => entry.capabilityId));
        return {
          integration,
          lead: slim(integration.assignmentId),
          participants: integration.participantAssignmentIds.flatMap((id) => {
            const entry = slim(id);
            return entry ? [entry] : [];
          }),
          readiness: factoryIntegrationVerificationReadiness(state, integrationId),
          integrationCapabilities: scoped.integrationCapabilities.filter((entry) =>
            capabilityIds.has(entry.id),
          ),
          integrationGrants: grants,
          integrationPreparations: scoped.integrationPreparations.filter(
            (entry) => entry.integrationId === integrationId,
          ),
          integrationTestArtifacts: scoped.integrationTestArtifacts.filter(
            (entry) => entry.integrationId === integrationId,
          ),
          integrationVerifications: scoped.integrationVerifications.filter(
            (entry) => entry.integrationId === integrationId,
          ),
          integrationMessages: scoped.integrationMessages.filter(
            (entry) => entry.integrationId === integrationId,
          ),
        };
      }),
    threadPatchProject: (threadId, patchArtifactId) =>
      Effect.gen(function* () {
        const { scoped } = yield* integrationCaller(threadId);
        const project = scoped.integrationTestArtifacts
          .flatMap((entry) => entry.projects)
          .find((entry) => entry.patchArtifactId === patchArtifactId);
        if (!project) return yield* denied();
        return project.projectId;
      }),
    threadImprovements: (threadId, cursor = 0) =>
      Effect.gen(function* () {
        const member = yield* managedCaller(threadId);
        if (
          member.manager.role !== "system" ||
          threadId !== member.manager.threadId ||
          !Number.isInteger(cursor) ||
          cursor < 0
        )
          return yield* denied();
        yield* controls.assertExecution(member.manager.threadId);
        const state = yield* store.snapshot;
        // Unsampled findings stay hidden until someone attaches them to an investigation.
        const attached = new Set(
          state.improvementInvestigations.flatMap((entry) => entry.findingIds),
        );
        const visible = new Set(
          state.improvementIntakes
            .filter((entry) => entry.delivery.phase !== "skipped" || attached.has(entry.findingId))
            .map((entry) => entry.findingId),
        );
        const findings = state.findings.filter((entry) => visible.has(entry.id)).toReversed();
        const investigations = state.improvementInvestigations.toReversed();
        const proposals = state.improvementProposals.toReversed();
        const decisions = state.improvementDecisions.toReversed();
        const feedback = state.improvementFeedback.toReversed();
        const recurrences = state.improvementRecurrences.toReversed();
        const settings = factoryImprovementConfiguration(state);
        const day = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
        const used = state.improvementBatches.filter(
          (entry) => entry.kind === "routine" && entry.budgetDay === day,
        ).length;
        const hasMore =
          Math.max(
            findings.length,
            investigations.length,
            proposals.length,
            decisions.length,
            feedback.length,
            recurrences.length,
          ) >
          cursor + 5;
        return {
          revision: state.revision,
          managerId: member.manager.id,
          settings,
          budget: { day, used, remaining: Math.max(0, settings.routineBatchesPerDay - used) },
          decisions: decisions.slice(cursor, cursor + 5).map((entry) => ({
            proposalId: entry.proposalId,
            revision: entry.revision,
            outcome: entry.outcome,
            reason: entry.reason.slice(0, 1000),
            decidedAt: entry.decidedAt,
          })),
          feedback: feedback.slice(cursor, cursor + 5).map((entry) => ({
            id: entry.id,
            proposalId: entry.proposalId,
            revision: entry.revision,
            usefulness: entry.usefulness,
            reason: entry.reason.slice(0, 1000),
          })),
          recurrences: recurrences.slice(cursor, cursor + 5).map((entry) => ({
            id: entry.id,
            investigationId: entry.investigationId,
            findingId: entry.findingId,
            reason: entry.reason.slice(0, 1000),
          })),
          queued: state.improvementIntakes.filter((entry) => entry.delivery.phase === "queued")
            .length,
          findings: findings.slice(cursor, cursor + 5).flatMap((entry) => {
            const assignment = state.assignments.find((item) => item.id === entry.assignmentId);
            return assignment
              ? [
                  {
                    id: entry.id,
                    assignmentId: entry.assignmentId,
                    projectId: assignment.projectId,
                    summary: entry.problem.slice(0, 700),
                    containmentOf: entry.containmentOf,
                    uncertainty: entry.route.uncertainty.slice(0, 300),
                    evidence: entry.evidence,
                  },
                ]
              : [];
          }),
          investigations: investigations.slice(cursor, cursor + 5).map((entry) => ({
            id: entry.id,
            title: entry.title.slice(0, 200),
            findingIds: entry.findingIds,
            phase: entry.lifecycle.phase,
            assessment: entry.assessment.slice(0, 500),
            uncertainty: entry.uncertainty.slice(0, 500),
          })),
          proposals: proposals.slice(cursor, cursor + 5).map((entry) => ({
            id: entry.id,
            revision: entry.revision,
            investigationId: entry.investigationId,
            phase: entry.phase,
            problem: entry.content.problem.slice(0, 500),
            requestedDecision: entry.content.requestedDecision.slice(0, 500),
          })),
          hasMore,
          nextCursor: hasMore ? cursor + 5 : null,
        };
      }),
    threadImprovementRecord: (threadId, input) =>
      Effect.gen(function* () {
        const member = yield* managedCaller(threadId);
        if (member.manager.role !== "system" || threadId !== member.manager.threadId)
          return yield* denied();
        yield* controls.assertExecution(member.manager.threadId);
        const state = yield* store.snapshot;
        const manager = state.managers.find((entry) => entry.id === member.manager.id);
        if (
          manager?.role !== "system" ||
          manager.status !== "active" ||
          manager.qualification.status !== "qualified"
        )
          return yield* denied();
        const ref = input.record;
        const record =
          ref.kind === "proposal"
            ? state.improvementProposals.find(
                (entry) => entry.id === ref.id && entry.revision === ref.revision,
              )
            : ref.kind === "decision"
              ? // A deferred revision can be decided again; the latest decision stands.
                state.improvementDecisions.findLast(
                  (entry) => entry.proposalId === ref.id && entry.revision === ref.revision,
                )
              : ref.kind === "investigation"
                ? state.improvementInvestigations.find((entry) => entry.id === ref.id)
                : ref.kind === "feedback"
                  ? state.improvementFeedback.find((entry) => entry.id === ref.id)
                  : state.improvementRecurrences.find((entry) => entry.id === ref.id);
        const limit = input.limit ?? 8000;
        const offset = input.cursor?.offset ?? 0;
        if (
          !record ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 16000 ||
          !Number.isInteger(offset) ||
          offset < 0
        )
          return yield* denied();
        const serialized = stableStringify(record);
        const digest = Hex.encode(sha256(new TextEncoder().encode(serialized)));
        if (
          (input.cursor !== undefined && input.cursor.digest !== digest) ||
          offset > serialized.length
        )
          return yield* new FactoryError({
            code: "stale-revision",
            detail: "The record changed while paging. Restart this named record read.",
          });
        const text = serialized.slice(offset, offset + limit);
        const nextOffset = offset + text.length;
        return {
          record: ref,
          digest,
          text,
          nextCursor: nextOffset < serialized.length ? { offset: nextOffset, digest } : null,
        };
      }),
    threadDirectory: (threadId, cursor = 0) =>
      Effect.gen(function* () {
        const member = yield* managedCaller(threadId);
        if (
          member.assignment !== undefined ||
          threadId !== member.manager.threadId ||
          !Number.isInteger(cursor) ||
          cursor < 0
        )
          return yield* denied();
        yield* controls.assertExecution(member.manager.threadId).pipe(Effect.mapError(unavailable));
        const entries = (yield* store.snapshot).managers.flatMap((entry) =>
          entry.id === member.manager.id || entry.status === "retired"
            ? []
            : [
                {
                  managerId: entry.id,
                  name: entry.name,
                  role: entry.role,
                  projectId: entry.projectId,
                  status: entry.status,
                },
              ],
        );
        const page = entries.slice(cursor, cursor + 30);
        return {
          entries: page,
          nextCursor: cursor + page.length < entries.length ? cursor + page.length : null,
        };
      }),
    threadTicketAccess: (threadId, candidateId) =>
      Effect.gen(function* () {
        yield* controls.assertExecution(threadId).pipe(Effect.mapError(unavailable));
        const member = yield* managedCaller(threadId);
        const candidate = (yield* store.snapshot).scheduleCandidates.find(
          (entry) => entry.id === candidateId,
        );
        if (
          !candidate ||
          member.manager.projectId !== candidate.projectId ||
          candidate.managerId !== member.manager.id ||
          (member.assignment === undefined
            ? member.ownerThreadId !== threadId
            : member.assignment.scheduling?.candidateId !== candidate.id)
        )
          return yield* denied();
      }),
    threadDispatch: (threadId, command) =>
      Effect.gen(function* () {
        if (
          command.type === "integration.capability.configure" ||
          command.type === "integration.grant.approve" ||
          command.type === "integration.capability.retry" ||
          command.type === "merge.group.approve" ||
          command.type === "merge.group.reject" ||
          command.type === "merge.operation.stop"
        )
          return yield* denied();
        yield* controls.assertExecution(threadId).pipe(Effect.mapError(unavailable));
        const member = yield* managedCaller(threadId);
        if (
          member.manager.role === "system" &&
          member.assignment === undefined &&
          ![
            "investigation.open",
            "investigation.update",
            "investigation.recurrence",
            "proposal.write",
            "proposal.submit",
            "shared.work.propose",
            "shared.work.commission",
            "experiment.commission",
            "workflow.release.register",
            "improvement.validation.record",
            "workflow.models.recommend",
            "retro.manager.submit",
            "retro.retry",
            "finding.route",
            "assignment.completion.retry",
            "assignment.wait.resolve",
            "assignment.retry",
            "dependency.check-usability",
            "assignment.recovery.begin",
            "assignment.recovery.replan",
            "assignment.recovery.escalate",
            "finding.escalate",
            "collaboration.request.create",
            "collaboration.request.withdraw",
            "collaboration.request.reconsider",
            "collaboration.plan.decide",
            "collaboration.decision.raise",
          ].includes(command.type)
        )
          return yield* denied();
        if (
          member.assignment?.sharedWork?.kind === "experiment" &&
          ((command.type.startsWith("delivery.") &&
            command.type !== "delivery.impact.declare" &&
            !command.type.startsWith("delivery.flow.")) ||
            command.type === "followup.request")
        )
          return yield* denied();
        const retroCommand =
          member.auxiliary?.kind === "retrospective" &&
          ((command.type === "retro.team.submit" &&
            command.retroId === member.auxiliary.incidentId) ||
            ((command.type === "finding.report" || command.type === "followup.request") &&
              command.assignmentId === member.assignment?.id) ||
            (command.type === "finding.escalate" &&
              (yield* store.snapshot).findings.some(
                (entry) =>
                  entry.id === command.findingId && entry.assignmentId === member.assignment?.id,
              )));
        if (
          member.auxiliary !== undefined &&
          (member.auxiliary.threadId !== threadId ||
            (member.auxiliary.kind === "retrospective"
              ? !retroCommand
              : member.auxiliary.kind === "diagnosis"
                ? command.type !== "auxiliary.report" || command.threadId !== threadId
                : !(
                    command.type === "delivery.review.report" ||
                    command.type === "delivery.preview.start" ||
                    command.type === "delivery.preview.stop"
                  ) ||
                  command.assignmentId !== member.assignment?.id ||
                  command.revisionId !== member.auxiliary.revisionId ||
                  ("reviewId" in command && command.reviewId !== member.auxiliary.incidentId)))
        )
          return yield* denied();
        const descendantOperation =
          member.assignment !== undefined &&
          member.assignment.kind !== "onboarding" &&
          (((command.type === "assignment.file.mutate" ||
            command.type === "assignment.verify" ||
            command.type === "finding.report") &&
            command.assignmentId === member.assignment.id) ||
            ((command.type === "integration.file.mutate" ||
              command.type === "integration.verify") &&
              command.integrationId === member.assignment.integrationId) ||
            (command.type === "guidance.escalate" && command.threadId === threadId));
        if (member.ownerThreadId !== threadId && !descendantOperation) return yield* denied();
        return yield* core.dispatch(
          {
            kind: "thread",
            threadId: threadId,
            ...(member.assignment === undefined ? {} : { assignmentId: member.assignment.id }),
          },
          command,
        );
      }),
  } satisfies FactoryThreadScope;
});
