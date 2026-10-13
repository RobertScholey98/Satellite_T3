import {
  FactoryError,
  factorySystemManager,
  type FactoryAssignment,
  type FactoryBoundary,
  type FactoryCommandResult,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryExperimentSettings,
  type FactorySharedRepository,
  type FactorySharedWork,
  type FactorySnapshot,
  type FactorySupportingWork,
  type CommandId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import {
  commissionFactoryAssignment,
  type FactorySkillsContext,
} from "./FactoryAssignmentCommission.ts";
import {
  factoryPathWithin,
  factoryPathsChangeSkills,
  factoryProtectedPath,
  factoryRelativePath,
} from "./FactoryBoundaryPaths.ts";
import { resolveManagerPolicy } from "./FactoryPolicy.ts";
import { isFactoryModelApproved, resolveFactoryModelPolicy } from "./FactoryModelPolicy.ts";
import type { FactoryActor, FactoryAllocation, FactoryDecision } from "./FactoryState.ts";

/**
 * Host facts the pure deciders cannot read for themselves. `FactoryWorkflowEffects.context`
 * resolves them before the decision, and a field is present only for the command that needs it.
 */
export interface FactoryWorkflowContext {
  /** Real path of the project's workspace, so `manager.create` can spot a shared repository. */
  readonly projectRepositoryRoot?: string;
  /** A qualified runtime and approved boundary for `shared.repository.register`. */
  readonly sharedRepository?: {
    readonly boundary: FactoryBoundary;
    readonly repositoryRoot: string;
  };
}

/** The latest experiment configuration. Experiments stay disabled until the human enables them. */
export function factoryExperimentSettings(state: FactorySnapshot): FactoryExperimentSettings {
  const configuration = state.experimentConfigurations.at(-1);
  return configuration === undefined
    ? { enabled: false, maxConcurrent: 1, maxPerInvestigation: 1 }
    : {
        enabled: configuration.enabled,
        maxConcurrent: configuration.maxConcurrent,
        maxPerInvestigation: configuration.maxPerInvestigation,
      };
}

export function factoryWorkChangesSkills(
  boundary: FactoryBoundary,
  work: FactorySupportingWork,
): boolean {
  return factoryPathsChangeSkills(
    {
      files: [...work.sourcePaths, ...(work.controlPaths ?? [])],
      creatableDirectories: work.creatableDirectories,
    },
    boundary,
  );
}

/**
 * Whether shared work fits its boundary exactly. It must touch something; implementation work
 * never names protected controls and rule-change work always does; each control path must be one
 * of the boundary's protected files; and source paths must be writable or inside a creatable
 * directory, never protected.
 */
function validWork(boundary: FactoryBoundary, work: FactorySupportingWork): boolean {
  const controls = work.controlPaths ?? [];
  return (
    work.sourcePaths.length + work.creatableDirectories.length + controls.length > 0 &&
    (work.kind !== "implementation" || controls.length === 0) &&
    (work.kind !== "rule-change" || controls.length > 0) &&
    controls.every(
      (file) =>
        factoryRelativePath(file) &&
        (boundary.protectedPaths.includes(file) ||
          boundary.protectedCreatablePaths?.includes(file)),
    ) &&
    work.creatableDirectories.every((directory) =>
      boundary.creatableDirectories.includes(directory),
    ) &&
    work.sourcePaths.every(
      (file) =>
        factoryRelativePath(file) &&
        !factoryProtectedPath(file) &&
        !boundary.protectedPaths.includes(file) &&
        !boundary.protectedCreatablePaths?.includes(file) &&
        (boundary.writablePaths.includes(file) ||
          boundary.creatableDirectories.some((directory) => factoryPathWithin(file, directory))),
    )
  );
}

/**
 * Decides the system manager's workflow-improvement commands: shared repositories and work,
 * isolated experiments, validations and model recommendations. Shared work ends at its PR merge:
 * the next commission picks the merged skills up from the repository's HEAD. Returns `undefined` for any other command so `decide` tries the next decider.
 * `workflow.models.apply` also falls through, because `decide` applies it by re-deciding the
 * recommended model configuration as a human command.
 */
export function decideFactoryWorkflow(
  input: FactoryWorkflowContext &
    FactorySkillsContext & {
      readonly state: FactorySnapshot;
      readonly actor: FactoryActor;
      readonly command: FactoryDecisionCommand;
      readonly now: string;
      readonly allocation?: FactoryAllocation;
    },
): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  if (
    !command.type.startsWith("shared.") &&
    !command.type.startsWith("workflow.") &&
    !command.type.startsWith("experiment.") &&
    command.type !== "improvement.validation.record"
  )
    return undefined;
  if (command.type === "workflow.models.apply") return undefined;
  const fail = (detail: string, code: FactoryError["code"] = "permission-denied") =>
    Result.fail(new FactoryError({ code, detail }));
  const accepted = (
    changes: Partial<FactorySnapshot> = {},
    result: Omit<FactoryCommandResult, "revision"> = {},
    effects: readonly FactoryEffectIntent[] = [],
  ): Result.Result<FactoryDecision, FactoryError> =>
    Result.succeed({
      state: { ...state, ...changes, revision: state.revision + 1 },
      result: { ...result, revision: state.revision + 1 },
      effects,
    });
  const human = actor.kind === "human";
  const host = actor.kind === "system";
  const manager = factorySystemManager(state.managers);
  const managerAvailable =
    manager?.status === "active" &&
    manager.launchStatus === "delivered" &&
    isFactoryModelApproved(
      resolveFactoryModelPolicy(
        state.modelDefaults,
        manager.modelOverrides,
        manager.modelSelection,
      ),
      manager.modelSelection,
    );
  // The system manager coordinates only from its own thread, and only while it is active,
  // delivered and on an approved model. The human can always coordinate.
  const canCoordinate =
    human || (managerAvailable && actor.kind === "thread" && actor.threadId === manager.threadId);
  const proposal = (proposalId: string, revision: string) =>
    state.improvementProposals.find(
      (entry) => entry.id === proposalId && entry.revision === revision,
    );
  const acceptedProposal = (proposalId: string, revision: string) =>
    proposal(proposalId, revision) !== undefined &&
    state.improvementDecisions.some(
      (entry) =>
        entry.proposalId === proposalId &&
        entry.revision === revision &&
        entry.outcome === "accepted",
    );
  const repositoryFor = (id: string) =>
    state.sharedRepositories.find((entry) => entry.id === id && entry.managerId === manager?.id);
  // Withdrawing authority bumps each live team's grant epoch, so anything prepared under the old
  // grant is stale, and holds the team on an authority wait. The host stops the teams.
  const revoke = (assignments: readonly FactoryAssignment[], reason: string) => {
    const ids = assignments
      .filter((entry) => entry.outcome === undefined && entry.status !== "complete")
      .map((entry) => entry.id);
    return {
      assignments: state.assignments.map((entry) =>
        ids.includes(entry.id)
          ? {
              ...entry,
              ...(entry.grant === undefined
                ? {}
                : { grant: { ...entry.grant, epoch: entry.grant.epoch + 1 } }),
              status: "waiting" as const,
              wait: { kind: "authority" as const, reason },
              updatedAt: now,
            }
          : entry,
      ),
      effects: ids.length ? [{ type: "workflow.revoke" as const, assignmentIds: ids, reason }] : [],
    };
  };
  const commission = (
    repository: FactorySharedRepository,
    work: FactorySupportingWork,
    sharedWork: NonNullable<FactoryAssignment["sharedWork"]>,
    authorizationId: CommandId,
  ) => {
    if (!manager || !managerAvailable || !repository.enabled)
      return fail("The shared repository and system manager must be available.");
    if (
      state.controls.some(
        (entry) =>
          entry.kind === "project-pause" &&
          entry.projectId === repository.projectId &&
          entry.status === "active",
      )
    )
      return fail("The source project is paused.");
    const boundary = state.boundaries.find(
      (entry) => entry.id === repository.boundaryId && entry.projectId === repository.projectId,
    );
    if (!boundary || !validWork(boundary, work))
      return fail("The work must fit the registered source and exact protected-file grants.");
    // Shared work always delivers through human approval, whatever the manager's own policy.
    // Implementation acts on the human's authorization; an experiment on the commission itself.
    return commissionFactoryAssignment({
      state,
      manager,
      boundary,
      work,
      allocation: input.allocation,
      skills: input.skills,
      policy: {
        ...resolveManagerPolicy(state.defaults, manager.overrides),
        delivery: "human-approval",
      },
      authorization:
        sharedWork.kind === "implementation"
          ? { kind: "human", commandId: authorizationId }
          : { kind: "manager", commandId: command.commandId, threadId: manager.id },
      controlAuthorizationId: authorizationId,
      now,
      sharedWork,
    });
  };
  const prepare = (assignment: FactoryAssignment): FactoryEffectIntent => ({
    type: "assignment.prepare",
    managerId: assignment.managerId,
    assignmentId: assignment.id,
    threadId: assignment.threadId,
    projectId: assignment.projectId,
  });

  switch (command.type) {
    case "shared.repository.register": {
      if (!human || !manager)
        return fail("The human registers a shared repository for the system manager.");
      const qualified = input.sharedRepository;
      // A project is either shared with the system manager or run by its own project manager,
      // never both, and two registrations never share a repository root or boundary.
      if (
        !qualified ||
        qualified.boundary.projectId !== command.projectId ||
        state.sharedRepositories.some(
          (entry) =>
            entry.projectId === command.projectId ||
            entry.repositoryRoot === qualified.repositoryRoot,
        ) ||
        state.managers.some(
          (entry) => entry.role === "project" && entry.projectId === command.projectId,
        ) ||
        state.boundaries.some((entry) => entry.id === qualified.boundary.id)
      )
        return fail("A distinct host-qualified shared repository is required.", "invalid-state");
      const repository: FactorySharedRepository = {
        id: `shared-repository:${command.commandId}`,
        managerId: manager.id,
        projectId: command.projectId,
        kind: command.kind,
        repositoryRoot: qualified.repositoryRoot,
        boundaryId: qualified.boundary.id,
        enabled: true,
        registeredAt: now,
      };
      return accepted(
        {
          sharedRepositories: [...state.sharedRepositories, repository],
          boundaries: [...state.boundaries, qualified.boundary],
        },
        { repositoryId: repository.id },
      );
    }
    case "shared.repository.configure": {
      if (!human) return fail("Only the human can change shared repository authority.");
      const repository = repositoryFor(command.repositoryId);
      if (!repository) return fail("Shared repository not found.", "invalid-state");
      const stopped = command.enabled
        ? { assignments: state.assignments, effects: [] }
        : revoke(
            state.assignments.filter((entry) => entry.sharedWork?.repositoryId === repository.id),
            "Shared repository authority was withdrawn. Explicit restart is required before work resumes.",
          );
      return accepted(
        {
          sharedRepositories: state.sharedRepositories.map((entry) =>
            entry.id === repository.id ? { ...entry, enabled: command.enabled } : entry,
          ),
          assignments: stopped.assignments,
        },
        { repositoryId: repository.id },
        stopped.effects,
      );
    }
    case "shared.work.propose": {
      if (!canCoordinate || !manager)
        return fail("Only the human or active system manager can propose shared work.");
      const repository = repositoryFor(command.repositoryId);
      const boundary = state.boundaries.find((entry) => entry.id === repository?.boundaryId);
      if (
        !repository ||
        !boundary ||
        !proposal(command.proposalId, command.proposalRevision) ||
        !validWork(boundary, command.work)
      )
        return fail(
          "Shared work needs an exact proposal and registered boundary.",
          "invalid-state",
        );
      if (command.weakensRules && command.work.kind !== "rule-change")
        return fail("Rule weakening requires its own explicit rule-change assignment.");
      const record: FactorySharedWork = {
        id: `shared-work:${command.commandId}`,
        managerId: manager.id,
        plan: {
          proposalId: command.proposalId,
          proposalRevision: command.proposalRevision,
          repositoryId: command.repositoryId,
          work: command.work,
          expectedBenefit: command.expectedBenefit,
          assessmentApproach: command.assessmentApproach,
          // Derived from the paths too, so a proposer cannot understate a skill change.
          changesSkills: command.changesSkills || factoryWorkChangesSkills(boundary, command.work),
          // Any protected-control change can weaken rules, whatever the proposer declares.
          weakensRules: command.weakensRules || command.work.kind === "rule-change",
        },
        createdAt: now,
        notification: null,
        lifecycle: { phase: "proposed" },
      };
      return accepted({ sharedWorks: [...state.sharedWorks, record] }, { workId: record.id });
    }
    case "shared.work.authorize": {
      if (!human) return fail("Only the human can authorize the exact shared implementation plan.");
      const record = state.sharedWorks.find((entry) => entry.id === command.workId);
      // The human authorizes one plan once, and only against the exact proposal revision they
      // accepted. A changed proposal needs a new plan.
      if (
        !record ||
        record.lifecycle.phase !== "proposed" ||
        !acceptedProposal(record.plan.proposalId, record.plan.proposalRevision)
      )
        return fail(
          "Accept the exact proposal and select an uncommissioned work plan.",
          "invalid-state",
        );
      return accepted(
        {
          sharedWorks: state.sharedWorks.map((entry) =>
            entry.id === record.id
              ? {
                  ...entry,
                  notification: { phase: "pending" },
                  lifecycle: {
                    phase: "authorized",
                    commandId: command.commandId,
                    authorizedAt: now,
                  },
                }
              : entry,
          ),
        },
        { workId: record.id },
        [{ type: "workflow.work.notify", workId: record.id, managerId: record.managerId }],
      );
    }
    case "shared.work.notify.retry": {
      if (!human) return fail("The human retries a failed shared-work notification.");
      const record = state.sharedWorks.find((entry) => entry.id === command.workId);
      if (
        !record ||
        record.lifecycle.phase !== "authorized" ||
        record.notification?.phase !== "failed"
      )
        return fail("Select an authorized plan with a failed notification.", "invalid-state");
      return accepted(
        {
          sharedWorks: state.sharedWorks.map((entry) =>
            entry.id === record.id ? { ...entry, notification: { phase: "pending" } } : entry,
          ),
        },
        { workId: record.id },
        [{ type: "workflow.work.notify", workId: record.id, managerId: record.managerId }],
      );
    }
    case "workflow.work.notified":
    case "workflow.work.notify.failed": {
      if (!host) return fail("Only the host records shared-work notification delivery.");
      const record = state.sharedWorks.find(
        (entry) => entry.id === command.workId && entry.managerId === command.managerId,
      );
      if (!record) return fail("Shared work notification not found.", "invalid-state");
      // Late or repeated receipts are no-ops. The manager may commission before the receipt
      // lands, so a commissioned plan still records it.
      if (record.lifecycle.phase === "revoked" || record.notification?.phase === "delivered")
        return accepted();
      if (record.lifecycle.phase !== "authorized" && record.lifecycle.phase !== "commissioned")
        return fail("This work plan is not authorized.", "invalid-state");
      const notification: FactorySharedWork["notification"] =
        command.type === "workflow.work.notified"
          ? { phase: "delivered", messageId: command.messageId, deliveredAt: now }
          : { phase: "failed", reason: command.reason };
      return accepted(
        {
          sharedWorks: state.sharedWorks.map((entry) =>
            entry.id === record.id ? { ...entry, notification } : entry,
          ),
        },
        { workId: record.id },
      );
    }
    case "shared.work.commission": {
      if (!canCoordinate)
        return fail("Only the human or active system manager can commission shared work.");
      const record = state.sharedWorks.find((entry) => entry.id === command.workId);
      if (
        !record ||
        record.lifecycle.phase !== "authorized" ||
        !acceptedProposal(record.plan.proposalId, record.plan.proposalRevision)
      )
        return fail("This exact work plan needs unused human authorization.", "invalid-state");
      const repository = repositoryFor(record.plan.repositoryId);
      if (!repository) return fail("Shared repository not found.");
      const created = commission(
        repository,
        record.plan.work,
        { kind: "implementation", repositoryId: repository.id, workId: record.id },
        record.lifecycle.commandId,
      );
      if (Result.isFailure(created)) return Result.fail(created.failure);
      const assignment = created.success;
      const lifecycle = {
        ...record.lifecycle,
        phase: "commissioned" as const,
        assignmentId: assignment.id,
      };
      return accepted(
        {
          assignments: [...state.assignments, assignment],
          sharedWorks: state.sharedWorks.map((entry) =>
            entry.id === record.id
              ? {
                  ...entry,
                  lifecycle,
                  // Commissioning makes an undelivered notification moot; its effect retires.
                  notification:
                    entry.notification?.phase === "delivered"
                      ? entry.notification
                      : { phase: "superseded" },
                }
              : entry,
          ),
        },
        { assignmentId: assignment.id, workId: record.id, managerId: assignment.managerId },
        [prepare(assignment)],
      );
    }
    case "shared.work.revoke": {
      if (!human) return fail("Only the human can withdraw shared work authority.");
      const record = state.sharedWorks.find((entry) => entry.id === command.workId);
      if (!record || record.lifecycle.phase === "revoked")
        return fail("Select current shared work.", "invalid-state");
      // Revoking a plan before commission only closes it; after commission it also stops the team.
      const assignmentId =
        record.lifecycle.phase === "commissioned" ? record.lifecycle.assignmentId : null;
      const stopped = revoke(
        state.assignments.filter((entry) => entry.id === assignmentId),
        command.reason,
      );
      return accepted(
        {
          assignments: stopped.assignments,
          sharedWorks: state.sharedWorks.map((entry) =>
            entry.id === record.id
              ? {
                  ...entry,
                  lifecycle: {
                    phase: "revoked",
                    assignmentId,
                    reason: command.reason,
                    revokedAt: now,
                  },
                }
              : entry,
          ),
        },
        { workId: record.id },
        stopped.effects,
      );
    }
    case "experiment.configure": {
      if (!human) return fail("Only the human configures isolated experiment authority.");
      const stopped = command.enabled
        ? { assignments: state.assignments, effects: [] }
        : revoke(
            state.assignments.filter((entry) => entry.sharedWork?.kind === "experiment"),
            "Isolated experiment authority was withdrawn. Explicit restart is required before work resumes.",
          );
      return accepted(
        {
          experimentConfigurations: [
            ...state.experimentConfigurations,
            {
              enabled: command.enabled,
              maxConcurrent: command.maxConcurrent,
              maxPerInvestigation: command.maxPerInvestigation,
              configuredAt: now,
              commandId: command.commandId,
            },
          ],
          assignments: stopped.assignments,
        },
        {},
        stopped.effects,
      );
    }
    case "experiment.commission": {
      if (!canCoordinate || !manager)
        return fail(
          "Only the human or active system manager can commission an isolated experiment.",
        );
      const settings = factoryExperimentSettings(state);
      const repository = repositoryFor(command.repositoryId);
      const investigation = state.improvementInvestigations.find(
        (entry) => entry.id === command.investigationId && entry.lifecycle.phase !== "closed",
      );
      // The concurrency limit counts only unconcluded experiments; the per-investigation limit
      // counts every experiment ever commissioned for it.
      const running = state.workflowExperiments.filter((entry) =>
        state.assignments.some(
          (assignment) =>
            assignment.id === entry.assignmentId &&
            assignment.status !== "complete" &&
            assignment.outcome === undefined,
        ),
      );
      if (
        !settings.enabled ||
        !repository ||
        !investigation ||
        running.length >= settings.maxConcurrent ||
        state.workflowExperiments.filter((entry) => entry.investigationId === investigation.id)
          .length >= settings.maxPerInvestigation
      )
        return fail("Enable experiment authority within its concurrent and investigation limits.");
      if (
        command.work.scope.requiresPullRequest ||
        command.work.scope.noPrTarget?.kind !== "report-received" ||
        command.work.scope.noPrTarget.recipientThreadId !== manager.id
      )
        return fail(
          "Isolated experiments finish with a report to the system manager, without publication.",
        );
      const experimentId = `experiment:${command.commandId}`;
      const created = commission(
        repository,
        command.work,
        { kind: "experiment", repositoryId: repository.id, experimentId },
        command.commandId,
      );
      if (Result.isFailure(created)) return Result.fail(created.failure);
      const assignment = created.success;
      return accepted(
        {
          assignments: [...state.assignments, assignment],
          workflowExperiments: [
            ...state.workflowExperiments,
            {
              id: experimentId,
              managerId: manager.id,
              repositoryId: repository.id,
              investigationId: investigation.id,
              assignmentId: assignment.id,
              expectedBenefit: command.expectedBenefit,
              assessmentApproach: command.assessmentApproach,
              createdAt: now,
            },
          ],
        },
        { experimentId, assignmentId: assignment.id, managerId: manager.id },
        [prepare(assignment)],
      );
    }
    case "improvement.validation.record": {
      if (!canCoordinate || !acceptedProposal(command.proposalId, command.proposalRevision))
        return fail("Validation needs its exact accepted shared proposal and authorized reviewer.");
      // A named implementation must come from this same proposal revision.
      if (
        command.assignmentId !== undefined &&
        !state.assignments.some(
          (entry) =>
            entry.id === command.assignmentId &&
            entry.sharedWork?.kind === "implementation" &&
            state.sharedWorks.some(
              (work) =>
                entry.sharedWork?.kind === "implementation" &&
                work.id === entry.sharedWork.workId &&
                work.plan.proposalId === command.proposalId &&
                work.plan.proposalRevision === command.proposalRevision,
            ),
        )
      )
        return fail("The implementation must belong to this proposal.");
      const validation = {
        id: `validation:${command.commandId}`,
        proposalId: command.proposalId,
        proposalRevision: command.proposalRevision,
        assignmentId: command.assignmentId ?? null,
        outcome: command.outcome,
        evidence: command.evidence,
        assessment: command.assessment,
        recommendedNextStep: command.recommendedNextStep,
        recordedAt: now,
      };
      return accepted(
        { improvementValidations: [...state.improvementValidations, validation] },
        { validationId: validation.id },
      );
    }
    case "workflow.models.recommend": {
      if (!canCoordinate || !proposal(command.proposalId, command.proposalRevision))
        return fail("A model recommendation needs its exact shared proposal.");
      const target = command.target;
      if (
        target.kind === "manager" &&
        !state.managers.some((entry) => entry.id === target.managerId)
      )
        return fail("Manager not found.", "manager-not-found");
      const scope = proposal(command.proposalId, command.proposalRevision)!.content.scope;
      // A project-scoped proposal may only recommend models for its own projects' managers.
      if (
        scope.kind === "projects" &&
        (target.kind === "default" ||
          !state.managers.some(
            (entry) =>
              target.kind === "manager" &&
              entry.id === target.managerId &&
              entry.role === "project" &&
              scope.projectIds.includes(entry.projectId),
          ))
      )
        return fail(
          "A project-scoped recommendation cannot change global or unrelated manager preferences.",
        );
      const recommendation = {
        id: `model-recommendation:${command.commandId}`,
        proposalId: command.proposalId,
        proposalRevision: command.proposalRevision,
        target: command.target,
        rationale: command.rationale,
        createdAt: now,
        applied: null,
      };
      return accepted(
        { modelRecommendations: [...state.modelRecommendations, recommendation] },
        { recommendationId: recommendation.id },
      );
    }
    case "workflow.models.decline": {
      const recommendation = state.modelRecommendations.find(
        (entry) => entry.id === command.recommendationId,
      );
      if (!human || !recommendation)
        return fail("Only the human can decline a standing model recommendation.");
      if (recommendation.applied !== null || recommendation.declined !== undefined)
        return fail("This recommendation was already resolved.", "invalid-state");
      return accepted(
        {
          modelRecommendations: state.modelRecommendations.map((entry) =>
            entry.id !== recommendation.id
              ? entry
              : {
                  ...entry,
                  declined: {
                    commandId: command.commandId,
                    reason: command.reason,
                    declinedAt: now,
                  },
                },
          ),
        },
        { recommendationId: recommendation.id },
      );
    }
  }
}
