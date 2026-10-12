import {
  FactoryError,
  factorySystemManager,
  type FactoryAssignment,
  type FactoryBoundary,
  type FactoryCommandResult,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryExperimentSettings,
  type FactoryManager,
  type FactorySharedRepository,
  type FactorySharedWork,
  type FactorySnapshot,
  type FactorySupportingWork,
  type FactoryWorkflowMigration,
  type FactoryWorkflowRelease,
  type FactoryWorkflowVersion,
  type CommandId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { commissionFactoryAssignment } from "./FactoryAssignmentCommission.ts";
import {
  factoryPathWithin,
  factoryPathsChangeSkills,
  factoryProtectedPath,
  factoryRelativePath,
} from "./FactoryBoundaryPaths.ts";
import { resolveManagerPolicy } from "./FactoryPolicy.ts";
import { isFactoryModelApproved, resolveFactoryModelPolicy } from "./FactoryModelPolicy.ts";
import {
  factorySharedAssignmentEnabled,
  factorySharedAssignmentOwned,
} from "./FactoryWorkflowOwnership.ts";
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
  /** The verified snapshot of the committed revision for `workflow.release.register`. */
  readonly workflowRelease?: {
    readonly version: FactoryWorkflowVersion;
    readonly snapshotDigest: string;
  };
}

/**
 * The workflow version a manager's new assignments pin. A per-manager override wins over the
 * latest default adoption; an adoption with a null release, or no adoption at all, falls back to
 * the manager's own approved workflow. Running delivery teams keep their pinned version until the
 * human selects them for `workflow.restart`.
 */
export function effectiveFactoryWorkflow(
  state: FactorySnapshot,
  manager: FactoryManager,
): FactoryWorkflowVersion {
  const override = state.workflowOverrides.find((entry) => entry.managerId === manager.id);
  const adoption =
    override === undefined
      ? state.workflowAdoptions.findLast((entry) => entry.scope.kind === "default")
      : state.workflowAdoptions.find((entry) => entry.id === override.adoptionId);
  return (
    state.workflowReleases.find((entry) => entry.id === adoption?.releaseId)?.version ??
    manager.workflow
  );
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
 * isolated experiments, workflow releases, adoption and restarts, validations and model
 * recommendations. Returns `undefined` for any other command so `decide` tries the next decider.
 * `workflow.models.apply` also falls through, because `decide` applies it by re-deciding the
 * recommended model configuration as a human command.
 */
export function decideFactoryWorkflow(
  input: FactoryWorkflowContext & {
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
  // A release from a project-scoped proposal reaches only those projects, never the default.
  const releaseReaches = (
    release: FactoryWorkflowRelease,
    projectIds: "all" | readonly (string | null | undefined)[],
  ) => {
    const scope = proposal(release.proposalId, release.proposalRevision)?.content.scope;
    return (
      scope?.kind !== "projects" ||
      (projectIds !== "all" &&
        projectIds.every((id) => scope.projectIds.some((projectId) => projectId === id)))
    );
  };
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
      workflow: effectiveFactoryWorkflow(state, manager),
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
    case "workflow.release.register": {
      if (!canCoordinate)
        return fail("Only the human or active system manager can register an owned release.");
      const repository = repositoryFor(command.repositoryId);
      const qualified = input.workflowRelease;
      if (
        !repository ||
        repository.kind !== "skills" ||
        !qualified ||
        qualified.version.repositoryRoot !== repository.repositoryRoot ||
        qualified.version.revision !== command.revision ||
        !/^[a-f0-9]{40,64}$/i.test(command.revision) ||
        !proposal(command.proposalId, command.proposalRevision)
      )
        return fail(
          "The host must identify the exact committed owned workflow snapshot.",
          "invalid-state",
        );
      // A release is the exact commit the human approved and merged for this proposal's work.
      const delivered = state.assignments.find(
        (entry) =>
          entry.id === command.assignmentId &&
          entry.sharedWork?.kind === "implementation" &&
          entry.sharedWork.repositoryId === repository.id &&
          factorySharedAssignmentOwned(state, entry),
      );
      const plan = state.sharedWorks.find(
        (entry) =>
          delivered?.sharedWork?.kind === "implementation" &&
          entry.id === delivered.sharedWork.workId,
      )?.plan;
      if (
        !delivered ||
        plan?.proposalId !== command.proposalId ||
        plan.proposalRevision !== command.proposalRevision ||
        !delivered.delivery?.revisions.some(
          (revision) =>
            revision.merge?.status === "merged" &&
            revision.approval?.expectedHeadSha.toLowerCase() === command.revision.toLowerCase(),
        )
      )
        return fail(
          "A release must be the merged commit approved for this proposal's implementation.",
          "invalid-state",
        );
      const existing = state.workflowReleases.find(
        (entry) =>
          entry.repositoryId === repository.id && entry.version.revision === command.revision,
      );
      // Registering the same commit again returns the existing release.
      if (existing) return accepted({}, { releaseId: existing.id });
      const release = {
        id: `workflow-release:${command.commandId}`,
        repositoryId: repository.id,
        version: qualified.version,
        snapshotDigest: qualified.snapshotDigest,
        proposalId: command.proposalId,
        proposalRevision: command.proposalRevision,
        assignmentId: command.assignmentId,
        provenance: "owned-codex-library" as const,
        baselineOrigin: "pstack-codex-adaptation" as const,
        registeredAt: now,
      };
      return accepted(
        { workflowReleases: [...state.workflowReleases, release] },
        { releaseId: release.id },
      );
    }
    case "workflow.adopt": {
      if (!human) return fail("Workflow adoption always requires a human decision.");
      // A null release resets the scope to each manager's own approved workflow.
      const release = state.workflowReleases.find((entry) => entry.id === command.releaseId);
      if (
        command.releaseId !== null &&
        (!release || !acceptedProposal(release.proposalId, release.proposalRevision))
      )
        return fail("Select a committed release linked to an accepted proposal.", "invalid-state");
      if (
        command.scope.kind === "managers" &&
        (new Set(command.scope.managerIds).size !== command.scope.managerIds.length ||
          command.scope.managerIds.some((id) => !state.managers.some((entry) => entry.id === id)))
      )
        return fail("Select existing managers once.", "invalid-state");
      if (
        release &&
        !releaseReaches(
          release,
          command.scope.kind === "default"
            ? "all"
            : command.scope.managerIds.map(
                (id) => state.managers.find((entry) => entry.id === id)?.projectId,
              ),
        )
      )
        return fail(
          "A project-scoped release can only be adopted by those projects' managers.",
          "invalid-state",
        );
      const adoption = {
        id: `workflow-adoption:${command.commandId}`,
        releaseId: release?.id ?? null,
        scope: command.scope,
        commandId: command.commandId,
        adoptedAt: now,
      };
      // A manager-scoped adoption replaces those managers' overrides. A default adoption leaves
      // existing overrides in place, so it reaches only managers without one.
      const ids = command.scope.kind === "managers" ? command.scope.managerIds : [];
      return accepted(
        {
          workflowAdoptions: [...state.workflowAdoptions, adoption],
          workflowOverrides: [
            ...state.workflowOverrides.filter((entry) => !ids.includes(entry.managerId)),
            ...ids.map((managerId) => ({ managerId, adoptionId: adoption.id })),
          ],
        },
        { adoptionId: adoption.id },
      );
    }
    case "workflow.override.clear": {
      if (!human) return fail("Only the human changes workflow adoption overrides.");
      if (!state.managers.some((entry) => entry.id === command.managerId))
        return fail("Manager not found.", "manager-not-found");
      return accepted({
        workflowOverrides: state.workflowOverrides.filter(
          (entry) => entry.managerId !== command.managerId,
        ),
      });
    }
    // A restart moves each selected team through stopping, preparing and ready, then resumes it.
    // The host reports each step with a receipt below. Only an assignment's latest migration is
    // current, and a team cannot start another restart until its last one has resumed.
    case "workflow.restart": {
      if (!human)
        return fail(
          "Live trials and active-assignment migration require explicit human selection.",
        );
      // A restore restarts each team on its own pinned version, so held work can resume
      // without moving onto another release.
      const release = state.workflowReleases.find((entry) => entry.id === command.releaseId);
      const assignments = command.assignmentIds.map((id) =>
        state.assignments.find((entry) => entry.id === id),
      );
      if (
        (command.kind === "restore"
          ? command.releaseId !== undefined
          : !release ||
            !acceptedProposal(release.proposalId, release.proposalRevision) ||
            !releaseReaches(
              release,
              assignments.map((entry) => entry?.projectId),
            )) ||
        new Set(command.assignmentIds).size !== command.assignmentIds.length
      )
        return fail(
          "Select an approved exact workflow release, or a restore, and distinct active assignments.",
          "invalid-state",
        );
      if (
        assignments.some(
          (entry) =>
            !entry ||
            entry.kind === "onboarding" ||
            !entry.grant ||
            entry.outcome !== undefined ||
            entry.status === "complete" ||
            entry.preparation !== "ready" ||
            (entry.completion !== undefined && entry.completion.phase !== "collecting") ||
            state.workflowMigrations.some(
              (migration) =>
                migration.assignmentId === entry.id &&
                (migration.lifecycle.phase !== "ready" ||
                  migration.lifecycle.resume.phase !== "delivered"),
            ),
        )
      )
        return fail(
          "Only current delivery teams with no pending conclusion or restart can migrate.",
          "invalid-state",
        );
      const migrations: FactoryWorkflowMigration[] = assignments.map((entry) => ({
        id: `workflow-migration:${command.commandId}:${entry!.id}`,
        assignmentId: entry!.id,
        releaseId: release?.id ?? null,
        previousVersion: entry!.workflow,
        previousEpoch: entry!.grant!.epoch,
        ...(entry!.qualification.status === "qualified"
          ? { previousProfileId: entry!.qualification.profileId }
          : {}),
        preparedEpoch: null,
        retainedAuthorityReason: entry!.wait?.kind === "authority" ? entry!.wait.reason : null,
        previousState: { status: entry!.status, wait: entry!.wait },
        kind: command.kind,
        reason: command.reason,
        commandId: command.commandId,
        createdAt: now,
        lifecycle: { phase: "stopping" },
      }));
      return accepted(
        {
          workflowMigrations: [...state.workflowMigrations, ...migrations],
          assignments: state.assignments.map((entry) =>
            command.assignmentIds.includes(entry.id)
              ? {
                  ...entry,
                  status: "waiting",
                  wait: {
                    kind: "execution-boundary",
                    reason: "Stopping the team for its explicitly selected workflow restart.",
                  },
                  updatedAt: now,
                }
              : entry,
          ),
        },
        { migrationIds: migrations.map((entry) => entry.id) },
        migrations.map((entry) => ({
          type: "workflow.restart.stop",
          migrationId: entry.id,
          assignmentId: entry.assignmentId,
        })),
      );
    }
    case "workflow.restart.continue": {
      if (!human) return fail("Only the human can continue with the current reduced permissions.");
      const migration = state.workflowMigrations.find((entry) => entry.id === command.migrationId);
      const assignment = state.assignments.find((entry) => entry.id === migration?.assignmentId);
      const owner = state.managers.find((entry) => entry.id === assignment?.managerId);
      if (
        !migration ||
        !assignment?.grant ||
        !owner ||
        migration.lifecycle.phase !== "ready" ||
        migration.lifecycle.resume.phase === "delivered" ||
        assignment.outcome !== undefined ||
        assignment.status === "complete" ||
        assignment.wait?.kind !== "authority" ||
        state.workflowMigrations.findLast((entry) => entry.assignmentId === assignment.id)?.id !==
          migration.id
      )
        return fail(
          "Select a current prepared restart held for an explicit authority decision.",
          "invalid-state",
        );
      // Continuing lifts the hold but grants nothing back. The grant must be the one the profile
      // was prepared for, and current shared-work and model permissions must still admit the team.
      if (
        assignment.grant.epoch !== migration.preparedEpoch ||
        assignment.qualification.status !== "qualified"
      )
        return fail(
          "Current grants changed after preparation. Prepare the selected workflow again before continuing.",
          "stale-revision",
        );
      if (
        (assignment.sharedWork !== undefined &&
          !factorySharedAssignmentEnabled(state, assignment)) ||
        !assignment.modelSelection ||
        !assignment.modelPolicy ||
        !isFactoryModelApproved(assignment.modelPolicy, assignment.modelSelection) ||
        !isFactoryModelApproved(
          resolveFactoryModelPolicy(
            state.modelDefaults,
            owner.modelOverrides,
            owner.modelSelection,
          ),
          assignment.modelSelection,
        )
      )
        return fail(
          "Restore the required current repository, work, experiment and model permissions before continuing.",
        );
      // The team returns to the wait it had before the restart, except an authority hold, which
      // this decision clears, and a dependency wait whose dependencies are now usable.
      const previousWait = migration.previousState.wait;
      const wait =
        previousWait?.kind === "authority"
          ? null
          : previousWait?.kind === "dependency" &&
              previousWait.dependencyIds.every((id) =>
                state.dependencies.some((entry) => entry.id === id && entry.state === "usable"),
              )
            ? null
            : previousWait;
      return accepted(
        {
          workflowMigrations: state.workflowMigrations.map((entry) =>
            entry.id === migration.id
              ? {
                  ...entry,
                  retainedAuthorityReason: null,
                  lifecycle: { ...migration.lifecycle, resume: { phase: "pending" } },
                }
              : entry,
          ),
          assignments: state.assignments.map((entry) =>
            entry.id === assignment.id
              ? { ...entry, status: wait === null ? "running" : "waiting", wait, updatedAt: now }
              : entry,
          ),
        },
        { migrationIds: [migration.id], assignmentId: assignment.id },
        [
          {
            type: "workflow.restart.resume",
            migrationId: migration.id,
            assignmentId: assignment.id,
          },
        ],
      );
    }
    case "workflow.restart.retry": {
      if (!human) return fail("The human retries a failed workflow restart.");
      const migration = state.workflowMigrations.find((entry) => entry.id === command.migrationId);
      if (!migration) return fail("Restart not found.", "invalid-state");
      const assignment = state.assignments.find((entry) => entry.id === migration.assignmentId);
      if (
        !assignment?.grant ||
        assignment.outcome !== undefined ||
        assignment.status === "complete" ||
        state.workflowMigrations.findLast((entry) => entry.assignmentId === assignment.id)?.id !==
          migration.id
      )
        return fail("Only the current active restart can retry.", "invalid-state");
      const phase = migration.lifecycle;
      // If the grant changed after preparation, even a ready restart goes back to preparing on a
      // fresh epoch, so the team never resumes on a profile prepared for an older grant.
      const needsPreparation =
        phase.phase === "ready" &&
        phase.resume.phase !== "delivered" &&
        assignment.grant.epoch !== migration.preparedEpoch;
      const next =
        needsPreparation && assignment.startingSource
          ? { phase: "preparing" as const, startingSource: assignment.startingSource }
          : phase.phase === "failed"
            ? phase.step === "stop"
              ? { phase: "stopping" as const }
              : phase.startingSource
                ? { phase: "preparing" as const, startingSource: phase.startingSource }
                : undefined
            : phase.phase === "ready" && phase.resume.phase === "failed"
              ? { ...phase, resume: { phase: "pending" as const } }
              : undefined;
      if (!next)
        return fail("Only a recorded failed restart step can be retried.", "invalid-state");
      const type =
        next.phase === "stopping"
          ? "workflow.restart.stop"
          : next.phase === "preparing"
            ? "workflow.restart.prepare"
            : "workflow.restart.resume";
      const rebase =
        next.phase === "preparing" && assignment.grant.epoch !== migration.preparedEpoch;
      const preparedEpoch = rebase ? assignment.grant.epoch + 1 : migration.preparedEpoch;
      // Remember a current authority hold, so preparation finishing does not release the team.
      const retainedAuthorityReason =
        assignment.wait?.kind === "authority"
          ? assignment.wait.reason
          : migration.retainedAuthorityReason;
      return accepted(
        {
          workflowMigrations: state.workflowMigrations.map((entry) =>
            entry.id === migration.id
              ? { ...entry, lifecycle: next, preparedEpoch, retainedAuthorityReason }
              : entry,
          ),
          ...(rebase
            ? {
                assignments: state.assignments.map((entry) =>
                  entry.id === assignment.id
                    ? {
                        ...entry,
                        grant: { ...assignment.grant!, epoch: preparedEpoch! },
                        qualification: {
                          status: "unavailable" as const,
                          reason: "Preparing the selected workflow with current tightened grants.",
                        },
                      }
                    : entry,
                ),
              }
            : {}),
        },
        { migrationIds: [migration.id] },
        [{ type, migrationId: migration.id, assignmentId: migration.assignmentId }],
      );
    }
    case "workflow.restart.stopped":
    case "workflow.restart.prepared":
    case "workflow.restart.failed":
    case "workflow.restart.resumed": {
      if (!host) return fail("Only the host records workflow restart execution.");
      const migration = state.workflowMigrations.find((entry) => entry.id === command.migrationId);
      const assignment = state.assignments.find((entry) => entry.id === migration?.assignmentId);
      const version =
        migration?.releaseId === null
          ? migration.previousVersion
          : state.workflowReleases.find((entry) => entry.id === migration?.releaseId)?.version;
      if (!migration || !assignment || !assignment.grant || !version)
        return fail("Restart source is unavailable.", "invalid-state");
      if (
        state.workflowMigrations.findLast((entry) => entry.assignmentId === assignment.id)?.id !==
        migration.id
      )
        return fail("A newer restart supersedes this receipt.", "stale-revision");
      // Stop and prepare receipts carry the revision the host read its evidence at; any change
      // since then makes the evidence stale.
      if ("expectedStateRevision" in command && command.expectedStateRevision !== state.revision)
        return fail("Restart evidence changed before recording.", "stale-revision");
      const record = (
        lifecycle: FactoryWorkflowMigration["lifecycle"],
        updated: FactoryAssignment = assignment,
        effects: readonly FactoryEffectIntent[] = [],
        metadata: Pick<
          FactoryWorkflowMigration,
          "preparedEpoch" | "retainedAuthorityReason"
        > = migration,
      ) =>
        accepted(
          {
            workflowMigrations: state.workflowMigrations.map((entry) =>
              entry.id === migration.id
                ? {
                    ...entry,
                    lifecycle,
                    preparedEpoch: metadata.preparedEpoch,
                    retainedAuthorityReason: metadata.retainedAuthorityReason,
                  }
                : entry,
            ),
            assignments: state.assignments.map((entry) =>
              entry.id === updated.id ? updated : entry,
            ),
          },
          { migrationIds: [migration.id], assignmentId: assignment.id },
          effects,
        );
      // A failure for a step the migration has already left is a replay and changes nothing.
      // Failure and resume receipts land even for concluded work; stop and prepare receipts do not.
      if (command.type === "workflow.restart.failed") {
        if (command.step === "resume")
          return migration.lifecycle.phase === "ready" &&
            migration.lifecycle.resume.phase !== "delivered"
            ? record({
                ...migration.lifecycle,
                resume: { phase: "failed", reason: command.reason },
              })
            : accepted();
        if (
          (command.step === "stop" && migration.lifecycle.phase !== "stopping") ||
          (command.step === "prepare" && migration.lifecycle.phase !== "preparing")
        )
          return accepted();
        return record(
          {
            phase: "failed",
            step: command.step,
            reason: command.reason,
            startingSource:
              migration.lifecycle.phase === "preparing" ? migration.lifecycle.startingSource : null,
          },
          // Concluded work keeps its status; only the migration records the failure.
          assignment.outcome !== undefined || assignment.status === "complete"
            ? assignment
            : {
                ...assignment,
                status: "waiting",
                wait: { kind: "execution-boundary", reason: command.reason },
                updatedAt: now,
              },
          [],
          {
            preparedEpoch: migration.preparedEpoch,
            retainedAuthorityReason:
              assignment.wait?.kind === "authority"
                ? assignment.wait.reason
                : migration.retainedAuthorityReason,
          },
        );
      }
      if (command.type === "workflow.restart.resumed") {
        if (
          migration.lifecycle.phase !== "ready" ||
          assignment.qualification.status !== "qualified" ||
          assignment.qualification.profileId !== command.profileId
        )
          return fail("The resumed profile does not match this restart.", "stale-revision");
        return record({ ...migration.lifecycle, resume: { phase: "delivered", deliveredAt: now } });
      }
      if (assignment.outcome !== undefined || assignment.status === "complete")
        return fail("Concluded work cannot restart.", "invalid-state");
      // The stopped team's work is captured as a fresh handover source for its own lead. The
      // assignment then pins the new version and a new grant epoch, so its old profile no longer
      // qualifies.
      if (command.type === "workflow.restart.stopped") {
        if (
          migration.lifecycle.phase !== "stopping" ||
          command.startingSource.projectId !== assignment.projectId ||
          command.startingSource.origin !== "handover" ||
          command.startingSource.threadId !== assignment.threadId ||
          command.startingSource.id === assignment.startingSource?.id
        )
          return fail("The stopped team's source or grant changed.", "stale-revision");
        return record(
          { phase: "preparing", startingSource: command.startingSource },
          {
            ...assignment,
            workflow: version,
            startingSource: command.startingSource,
            grant: { ...assignment.grant, epoch: assignment.grant.epoch + 1 },
            preparation: "preparing",
            qualification: {
              status: "unavailable",
              reason: "Preparing the selected workflow profile.",
            },
            status: "waiting",
            wait: {
              kind: "execution-boundary",
              reason: "Preparing the selected workflow profile.",
            },
            updatedAt: now,
          },
          [
            {
              type: "workflow.restart.prepare",
              migrationId: migration.id,
              assignmentId: assignment.id,
            },
          ],
          {
            preparedEpoch: assignment.grant.epoch + 1,
            retainedAuthorityReason:
              assignment.wait?.kind === "authority"
                ? assignment.wait.reason
                : migration.retainedAuthorityReason,
          },
        );
      }
      if (
        migration.lifecycle.phase !== "preparing" ||
        assignment.grant.epoch !== migration.preparedEpoch ||
        command.qualification.status !== "qualified"
      )
        return fail(
          "The new workflow profile has not been qualified for this grant.",
          "stale-revision",
        );
      // Prepared: the team gets back its pre-restart status and wait, unless an authority hold is
      // current or was retained, in which case it waits for `workflow.restart.continue`.
      return record(
        { phase: "ready", completedAt: now, resume: { phase: "pending" } },
        {
          ...assignment,
          qualification: command.qualification,
          preparation: "ready",
          status:
            assignment.wait?.kind === "authority" || migration.retainedAuthorityReason !== null
              ? "waiting"
              : migration.previousState.status,
          wait:
            assignment.wait?.kind === "authority"
              ? assignment.wait
              : migration.retainedAuthorityReason !== null
                ? { kind: "authority", reason: migration.retainedAuthorityReason }
                : migration.previousState.wait,
          updatedAt: now,
        },
        [
          {
            type: "workflow.restart.resume",
            migrationId: migration.id,
            assignmentId: assignment.id,
          },
        ],
      );
    }
    case "improvement.validation.record": {
      if (!canCoordinate || !acceptedProposal(command.proposalId, command.proposalRevision))
        return fail("Validation needs its exact accepted shared proposal and authorized reviewer.");
      // A named implementation or release must come from this same proposal revision.
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
      if (
        command.releaseId !== undefined &&
        !state.workflowReleases.some(
          (entry) =>
            entry.id === command.releaseId &&
            entry.proposalId === command.proposalId &&
            entry.proposalRevision === command.proposalRevision,
        )
      )
        return fail("The release must belong to this proposal.");
      const validation = {
        id: `validation:${command.commandId}`,
        proposalId: command.proposalId,
        proposalRevision: command.proposalRevision,
        assignmentId: command.assignmentId ?? null,
        releaseId: command.releaseId ?? null,
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
