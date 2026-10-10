import {
  type FactoryAssignment,
  type FactoryAssignmentId,
  type FactoryBoundary,
  type FactoryDecisionCommand,
  type FactoryCommandResult,
  type FactoryDiscoveryQualification,
  type FactoryEffectIntent,
  FactoryError,
  type FactoryManager,
  type MessageId,
  type FactoryModelPolicy,
  type FactoryVerification,
  type FactoryPolicy,
  type FactorySnapshot,
  type FactoryWait,
  type ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decideFactoryDelivery, type FactoryDeliveryContext } from "./FactoryDelivery.ts";
import {
  decideFactoryControls,
  factoryExecutionBlocked,
  preserveFactoryManagerPauses,
  type FactoryControlContext,
} from "./FactoryControls.ts";
import { constrainAssignmentPolicy, resolveManagerPolicy } from "./FactoryPolicy.ts";
import {
  decideFactoryOversight,
  factorySupportingWorkMatches,
  initialFactoryOversight,
  type FactoryOversightContext,
} from "./FactoryOversight.ts";
import {
  constrainFactoryModelPolicy,
  resolveFactoryModelPolicy,
  selectFactoryModel,
  isFactoryModelApproved,
} from "./FactoryModelPolicy.ts";
import {
  factoryPathWithin,
  factoryProtectedPath,
  factoryRelativePath,
} from "./FactoryBoundaryPaths.ts";

export type FactoryActor =
  | { readonly kind: "human" }
  | {
      readonly kind: "thread";
      readonly threadId: ThreadId;
      readonly assignmentId?: FactoryAssignmentId;
    }
  | { readonly kind: "system" };

export interface FactoryAllocation {
  readonly managerThreadId: ThreadId;
  readonly leadThreadId: ThreadId;
  readonly assignmentId: FactoryAssignmentId;
}

export interface FactoryDecision {
  readonly state: FactorySnapshot;
  readonly result: FactoryCommandResult;
  readonly effects: ReadonlyArray<FactoryEffectIntent>;
}

export const initialFactorySnapshot = (): FactorySnapshot => ({
  revision: 0,
  defaults: {
    delivery: "human-approval",
    projectImprovements: "create-tickets",
    sharedWorkflow: "investigate-and-recommend",
    authorizeRuleWeakening: false,
    recoveryCycles: 1,
  },
  managers: [],
  assignments: [],
  boundaries: [],
  controls: [],
  guidance: [],
  dependencies: [],
  auxiliaryThreads: [],
  mergeRules: [],
  previewConfigurations: [],
  previewPublicationPolicies: [],
});

export const effectivePolicy = (
  state: Pick<FactorySnapshot, "defaults">,
  manager: Pick<FactoryManager, "overrides">,
): FactoryPolicy => resolveManagerPolicy(state.defaults, manager.overrides);

const reduceGrants = (
  assignments: ReadonlyArray<FactoryAssignment>,
  managers: ReadonlyArray<FactoryManager>,
  defaults: FactoryPolicy,
  now: string,
) =>
  assignments.map((assignment) => {
    if (assignment.status === "complete") return assignment;
    const manager = managers.find((entry) => entry.id === assignment.managerId);
    if (manager === undefined) return assignment;
    const grantedPolicy = constrainAssignmentPolicy(
      assignment.grantedPolicy,
      resolveManagerPolicy(defaults, manager.overrides),
    );
    const revokeControlChange =
      assignment.authorization?.kind === "manager" &&
      assignment.grant?.controlChange != null &&
      !grantedPolicy.authorizeRuleWeakening;
    return {
      ...assignment,
      grantedPolicy,
      ...(revokeControlChange
        ? {
            grant: {
              ...assignment.grant!,
              controlChange: null,
              epoch: assignment.grant!.epoch + 1,
            },
            status: "waiting" as const,
            wait: {
              kind: "authority" as const,
              reason:
                "Permission for this rule-change assignment was withdrawn. A new, separately authorized task is required to change protected controls.",
            },
          }
        : {}),
      updatedAt: now,
    };
  });

const unavailableQualification: FactoryDiscoveryQualification = {
  status: "unavailable",
  reason: "Configure and qualify a read-only execution boundary, then retry onboarding.",
};

const onboardingWait = (qualification: FactoryDiscoveryQualification): FactoryWait | null =>
  qualification.status === "unavailable"
    ? { kind: "execution-boundary", reason: qualification.reason }
    : null;

const launchIntents = (
  manager: Extract<FactoryManager, { readonly role: "project" }>,
  assignment: FactoryAssignment,
): ReadonlyArray<FactoryEffectIntent> => {
  if (assignment.qualification.status !== "qualified") return [];
  const shared = {
    type: "thread.launch" as const,
    managerId: manager.id,
    assignmentId: assignment.id,
    projectId: manager.projectId,
    modelSelection: manager.modelSelection,
    workflow: assignment.workflow,
    profileId: assignment.qualification.profileId,
  };
  return [
    ...(manager.launchStatus === "pending"
      ? [{ ...shared, purpose: "manager" as const, threadId: manager.threadId }]
      : []),
    ...(assignment.launchStatus === "pending"
      ? [{ ...shared, purpose: "onboarding" as const, threadId: assignment.threadId }]
      : []),
  ];
};

const preparationIntent = (assignment: FactoryAssignment): FactoryEffectIntent => ({
  type: "assignment.prepare",
  managerId: assignment.managerId,
  assignmentId: assignment.id,
  threadId: assignment.threadId,
  projectId: assignment.projectId,
});

const implementationLaunch = (assignment: FactoryAssignment): ReadonlyArray<FactoryEffectIntent> =>
  assignment.qualification.status === "qualified" && assignment.modelSelection !== undefined
    ? [
        {
          type: "thread.launch",
          purpose: "implementation",
          managerId: assignment.managerId,
          assignmentId: assignment.id,
          threadId: assignment.threadId,
          projectId: assignment.projectId,
          modelSelection: assignment.modelSelection,
          workflow: assignment.workflow,
          profileId: assignment.qualification.profileId,
        },
      ]
    : [];

const reduceModelGrants = (
  state: FactorySnapshot,
  managers: ReadonlyArray<FactoryManager>,
  defaults: FactoryModelPolicy | undefined,
) =>
  state.assignments.map((assignment) => {
    if (assignment.status === "complete" || assignment.modelPolicy === undefined) return assignment;
    const manager = managers.find((entry) => entry.id === assignment.managerId);
    if (!manager) return assignment;
    const modelPolicy = constrainFactoryModelPolicy(
      assignment.modelPolicy,
      resolveFactoryModelPolicy(defaults, manager.modelOverrides, manager.modelSelection),
    );
    const reduced = assignment.modelPolicy.approvedModels.some(
      (selection) => !isFactoryModelApproved(modelPolicy, selection),
    );
    return {
      ...assignment,
      modelPolicy,
      ...(reduced && assignment.grant !== undefined
        ? {
            grant: { ...assignment.grant, epoch: assignment.grant.epoch + 1 },
            status: "waiting" as const,
            wait:
              assignment.wait?.kind === "human-decision"
                ? assignment.wait
                : {
                    kind: "authority" as const,
                    reason:
                      "The approved model pool was reduced. Execution stopped; review this assignment before granting a new confined run.",
                  },
          }
        : {}),
    };
  });

export function decide(
  input: FactoryControlContext &
    FactoryDeliveryContext &
    FactoryOversightContext & {
      readonly state: FactorySnapshot;
      readonly actor: FactoryActor;
      readonly command: FactoryDecisionCommand;
      readonly now: string;
      readonly allocation?: FactoryAllocation;
      readonly qualification?: FactoryDiscoveryQualification;
      readonly boundary?: FactoryBoundary;
      readonly verification?: FactoryVerification;
      readonly humanMessageVerified?: boolean;
      readonly humanMessageId?: MessageId;
      readonly handoverVerified?: boolean;
    },
): Result.Result<FactoryDecision, FactoryError> {
  const controlDecision = decideFactoryControls(input);
  if (controlDecision !== undefined) return controlDecision;
  const oversightDecision = decideFactoryOversight(input);
  if (oversightDecision !== undefined) return oversightDecision;
  const deliveryDecision = decideFactoryDelivery(input);
  if (deliveryDecision !== undefined) return deliveryDecision;
  const { state, actor, command, now } = input;
  const fail = (code: FactoryError["code"]) => Result.fail(new FactoryError({ code }));
  const accepted = (
    managers: ReadonlyArray<FactoryManager>,
    assignments: ReadonlyArray<FactoryAssignment>,
    result: Omit<FactoryCommandResult, "revision">,
    effects: ReadonlyArray<FactoryEffectIntent> = [],
    defaults: FactoryPolicy = state.defaults,
    boundaries: ReadonlyArray<FactoryBoundary> = state.boundaries,
    modelDefaults: FactoryModelPolicy | undefined = state.modelDefaults,
  ): Result.Result<FactoryDecision, FactoryError> => {
    const revision = state.revision + 1;
    const preserved = preserveFactoryManagerPauses(state, managers);
    return Result.succeed({
      state: {
        ...state,
        revision,
        ...preserved,
        assignments: assignments.map((assignment) => {
          const previous = state.assignments.find((entry) => entry.id === assignment.id);
          return previous?.outcome === undefined
            ? assignment
            : {
                ...assignment,
                outcome: previous.outcome,
                status: previous.status,
                wait: previous.wait,
              };
        }),
        defaults,
        boundaries,
        ...(modelDefaults === undefined ? {} : { modelDefaults }),
      },
      result: { ...result, revision },
      effects,
    });
  };

  if (command.type === "assignment.commission" || command.type === "assignment.handover") {
    const manager = state.managers.find((entry) => entry.id === command.managerId);
    if (
      manager?.role === "project" &&
      factoryExecutionBlocked(state, {
        threadId: manager.threadId,
        managerId: manager.id,
        projectId: manager.projectId,
        ancestorThreadIds: [],
      }) !== undefined
    )
      return fail("invalid-state");
  }
  if (
    command.type === "assignment.retry" ||
    command.type === "assignment.file.mutate" ||
    command.type === "assignment.verify" ||
    command.type === "onboarding.report"
  ) {
    const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
    if (assignment?.outcome !== undefined) return fail("invalid-state");
    if (
      assignment &&
      command.type !== "onboarding.report" &&
      factoryExecutionBlocked(state, {
        threadId: assignment.threadId,
        managerId: assignment.managerId,
        projectId: assignment.projectId,
        assignmentId: assignment.id,
        ancestorThreadIds: [],
      }) !== undefined
    )
      return fail("invalid-state");
  }

  switch (command.type) {
    case "models.defaults.configure": {
      if (actor.kind !== "human") return fail("permission-denied");
      return accepted(
        state.managers,
        reduceModelGrants(state, state.managers, command.policy),
        {},
        [],
        state.defaults,
        state.boundaries,
        command.policy,
      );
    }
    case "manager.models.configure": {
      if (actor.kind !== "human") return fail("permission-denied");
      if (!state.managers.some((entry) => entry.id === command.managerId))
        return fail("manager-not-found");
      const managers = state.managers.map((entry) =>
        entry.id === command.managerId
          ? { ...entry, modelOverrides: command.overrides, updatedAt: now }
          : entry,
      );
      return accepted(managers, reduceModelGrants(state, managers, state.modelDefaults), {
        managerId: command.managerId,
      });
    }
    case "assignment.commission":
    case "assignment.handover": {
      const manager = state.managers.find((entry) => entry.id === command.managerId);
      if (!manager || manager.role !== "project") return fail("manager-not-found");
      const boundary = state.boundaries.find((entry) => entry.id === manager.boundaryId);
      if (manager.status !== "active" || !boundary) return fail("invalid-state");
      const dependency =
        command.type === "assignment.commission" && command.dependencyId !== undefined
          ? state.dependencies.find((entry) => entry.id === command.dependencyId)
          : undefined;
      const dependencyAssignment = state.assignments.find(
        (entry) => entry.id === dependency?.assignmentId,
      );
      const dependencyAuthorized =
        dependency?.state === "approved" &&
        dependency.authorization?.managerId === manager.id &&
        dependencyAssignment?.managerId === manager.id &&
        dependencyAssignment.outcome === undefined &&
        dependencyAssignment.status !== "complete" &&
        factorySupportingWorkMatches(dependency.authorization.work, command);
      if (
        command.type === "assignment.commission" &&
        command.dependencyId !== undefined &&
        !dependencyAuthorized
      )
        return fail("permission-denied");
      if (
        actor.kind !== "human" &&
        (actor.kind !== "thread" ||
          actor.threadId !== manager.threadId ||
          command.type !== "assignment.commission" ||
          ((!input.humanMessageVerified || input.humanMessageId === undefined) &&
            !dependencyAuthorized))
      )
        return fail("permission-denied");
      if (
        command.type === "assignment.handover" &&
        (actor.kind !== "human" || !input.handoverVerified)
      )
        return fail("permission-denied");
      const policy = effectivePolicy(state, manager);
      const controls = command.controlPaths ?? [];
      if (command.kind === "implementation" && controls.length > 0)
        return fail("permission-denied");
      if (
        command.kind === "rule-change" &&
        (controls.length === 0 || (actor.kind !== "human" && !policy.authorizeRuleWeakening))
      )
        return fail("permission-denied");
      if (
        controls.some(
          (file) => !factoryRelativePath(file) || !boundary.protectedPaths.includes(file),
        )
      )
        return fail("permission-denied");
      if (
        command.creatableDirectories.some(
          (directory) => !boundary.creatableDirectories.includes(directory),
        )
      )
        return fail("permission-denied");
      if (
        command.sourcePaths.some(
          (file) =>
            !factoryRelativePath(file) ||
            factoryProtectedPath(file) ||
            boundary.protectedPaths.includes(file) ||
            (!boundary.writablePaths.includes(file) &&
              !boundary.creatableDirectories.some((directory) =>
                factoryPathWithin(file, directory),
              )),
        )
      )
        return fail("permission-denied");
      if (
        command.sourcePaths.length === 0 &&
        command.creatableDirectories.length === 0 &&
        controls.length === 0
      )
        return fail("invalid-state");
      const allocation = input.allocation;
      if (
        !allocation ||
        state.assignments.some(
          (entry) =>
            entry.id === allocation.assignmentId || entry.threadId === allocation.leadThreadId,
        ) ||
        state.managers.some((entry) => entry.threadId === allocation.leadThreadId)
      )
        return fail("invalid-state");
      if (command.type === "assignment.handover" && allocation.leadThreadId !== command.threadId)
        return fail("invalid-state");
      const modelPolicy = resolveFactoryModelPolicy(
        state.modelDefaults,
        manager.modelOverrides,
        manager.modelSelection,
      );
      const selected = selectFactoryModel({
        policy: modelPolicy,
        ...(manager.modelOverrides === undefined ? {} : { overrides: manager.modelOverrides }),
        role: "lead",
        complexity: command.complexity,
        ...(command.modelSelection === undefined ? {} : { selection: command.modelSelection }),
      });
      if (Result.isFailure(selected)) return Result.fail(selected.failure);
      const assignment: FactoryAssignment = {
        id: allocation.assignmentId,
        managerId: manager.id,
        threadId: allocation.leadThreadId,
        projectId: manager.projectId,
        kind: command.kind,
        title: command.title,
        scope: command.scope,
        oversight: initialFactoryOversight(),
        complexity: command.complexity,
        modelSelection: selected.success.selection,
        modelChoice: selected.success,
        modelPolicy,
        origin: command.type === "assignment.handover" ? "handover" : "new",
        preparation: command.type === "assignment.handover" ? "stopping" : "capturing",
        authorization:
          actor.kind === "human"
            ? { kind: "human", commandId: command.commandId }
            : {
                kind: "manager",
                commandId: command.commandId,
                threadId: manager.threadId,
                ...(input.humanMessageId === undefined ? {} : { messageId: input.humanMessageId }),
              },
        status: "pending",
        threadStatus: command.type === "assignment.handover" ? "created" : "pending",
        launchStatus: "pending",
        qualification: {
          status: "unavailable",
          reason: "Preparing the assignment's approved execution environment.",
        },
        workflow: manager.workflow,
        grantedPolicy: policy,
        grant: {
          boundaryId: boundary.id,
          epoch: 0,
          sourcePaths: command.sourcePaths,
          creatableDirectories: command.creatableDirectories,
          controlChange:
            controls.length === 0 ? null : { authorizationId: command.commandId, paths: controls },
        },
        wait: null,
        report: null,
        createdAt: now,
        updatedAt: now,
      };
      const decision = accepted(
        state.managers,
        [...state.assignments, assignment],
        { managerId: manager.id, assignmentId: assignment.id },
        [preparationIntent(assignment)],
      );
      return dependency === undefined
        ? decision
        : Result.map(decision, (value) => ({
            ...value,
            state: {
              ...value.state,
              dependencies: value.state.dependencies.map((entry) =>
                entry.id === dependency.id
                  ? {
                      ...entry,
                      state: "commissioned" as const,
                      supportingAssignmentId: assignment.id,
                      updatedAt: now,
                    }
                  : entry,
              ),
            },
          }));
    }
    case "assignment.retry": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (
        actor.kind !== "human" &&
        (actor.kind !== "thread" || actor.threadId !== assignment.managerId)
      )
        return fail("permission-denied");
      if (
        assignment.kind === "onboarding" ||
        assignment.status !== "waiting" ||
        assignment.wait?.kind !== "execution-boundary"
      )
        return fail("invalid-state");
      const updated = { ...assignment, status: "pending" as const, wait: null, updatedAt: now };
      return accepted(
        state.managers,
        state.assignments.map((entry) => (entry.id === updated.id ? updated : entry)),
        { assignmentId: updated.id },
        updated.preparation === "ready"
          ? implementationLaunch(updated)
          : [preparationIntent(updated)],
      );
    }
    case "assignment.file.mutate":
    case "assignment.verify": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (
        actor.kind !== "human" &&
        (actor.kind !== "thread" ||
          (actor.threadId !== assignment.threadId && actor.assignmentId !== assignment.id))
      )
        return fail("permission-denied");
      if (
        assignment.kind === "onboarding" ||
        assignment.preparation !== "ready" ||
        assignment.status === "complete" ||
        (assignment.delivery?.flow !== undefined &&
          assignment.delivery.flow.status !== "released") ||
        assignment.grant?.epoch !== command.expectedEpoch
      )
        return fail("invalid-state");
      if (command.type === "assignment.verify" && input.verification !== undefined) {
        const verification = input.verification;
        if (
          verification.epoch !== assignment.grant.epoch ||
          verification.boundaryId !== assignment.grant.boundaryId
        )
          return fail("invalid-state");
        return accepted(
          state.managers,
          state.assignments.map((entry) =>
            entry.id === assignment.id ? { ...entry, verification, updatedAt: now } : entry,
          ),
          { assignmentId: assignment.id, verification },
        );
      }
      return accepted(state.managers, state.assignments, { assignmentId: assignment.id });
    }
    case "assignment.preparation.recorded":
    case "assignment.prepared":
    case "assignment.prepare.failed": {
      if (actor.kind !== "system") return fail("permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment || assignment.threadId !== command.threadId)
        return fail("assignment-not-found");
      if (assignment.kind === "onboarding") return fail("invalid-state");
      if (assignment.status !== "pending")
        return accepted(state.managers, state.assignments, { assignmentId: assignment.id });
      if (command.type === "assignment.prepare.failed") {
        return accepted(
          state.managers,
          state.assignments.map((entry) =>
            entry.id === assignment.id
              ? {
                  ...entry,
                  status: "waiting",
                  wait: { kind: "execution-boundary", reason: command.reason },
                  updatedAt: now,
                }
              : entry,
          ),
          { assignmentId: assignment.id },
        );
      }
      if (
        command.startingSource !== undefined &&
        command.startingSource.projectId !== assignment.projectId
      )
        return fail("invalid-state");
      if (
        command.startingSource !== undefined &&
        assignment.startingSource !== undefined &&
        command.startingSource.id !== assignment.startingSource.id
      )
        return fail("invalid-state");
      if (command.type === "assignment.preparation.recorded") {
        const order = { stopping: 0, capturing: 1, preparing: 2, ready: 3 };
        if (
          assignment.preparation === undefined ||
          order[command.stage] < order[assignment.preparation]
        )
          return fail("invalid-state");
        return accepted(
          state.managers,
          state.assignments.map((entry) =>
            entry.id === assignment.id
              ? {
                  ...entry,
                  preparation: command.stage,
                  ...(command.startingSource === undefined
                    ? {}
                    : { startingSource: command.startingSource }),
                  updatedAt: now,
                }
              : entry,
          ),
          { assignmentId: assignment.id },
        );
      }
      if (command.qualification.status !== "qualified") return fail("execution-unavailable");
      if (
        assignment.status !== "pending" ||
        assignment.preparation !== "preparing" ||
        assignment.startingSource?.id !== command.startingSource.id
      )
        return fail("invalid-state");
      const updated: FactoryAssignment = {
        ...assignment,
        preparation: "ready",
        status: "pending",
        wait: null,
        qualification: command.qualification,
        startingSource: command.startingSource,
        updatedAt: now,
      };
      return accepted(
        state.managers,
        state.assignments.map((entry) => (entry.id === updated.id ? updated : entry)),
        { assignmentId: updated.id },
        implementationLaunch(updated),
      );
    }
    case "policy.defaults.configure": {
      if (actor.kind !== "human") return fail("permission-denied");
      return accepted(
        state.managers,
        reduceGrants(state.assignments, state.managers, command.defaults, now),
        {},
        [],
        command.defaults,
      );
    }
    case "assignments.extend-grant": {
      if (actor.kind !== "human") return fail("permission-denied");
      if (command.assignmentIds.length === 0) return fail("invalid-state");
      const selected = new Set(command.assignmentIds);
      for (const id of selected) {
        const assignment = state.assignments.find((entry) => entry.id === id);
        if (assignment === undefined) return fail("assignment-not-found");
        if (assignment.status === "complete") return fail("invalid-state");
        if (!state.managers.some((entry) => entry.id === assignment.managerId))
          return fail("manager-not-found");
      }
      return accepted(
        state.managers,
        state.assignments.map((assignment) => {
          if (!selected.has(assignment.id)) return assignment;
          const manager = state.managers.find((entry) => entry.id === assignment.managerId)!;
          return { ...assignment, grantedPolicy: effectivePolicy(state, manager), updatedAt: now };
        }),
        {},
      );
    }
    case "manager.approve-onboarding": {
      if (actor.kind !== "human") return fail("permission-denied");
      const manager = state.managers.find((entry) => entry.id === command.managerId);
      if (manager === undefined) return fail("manager-not-found");
      const onboarding = state.assignments.find(
        (entry) => entry.managerId === manager.id && entry.kind === "onboarding",
      );
      if (
        manager.role !== "project" ||
        manager.boundaryId !== undefined ||
        onboarding?.report == null ||
        onboarding.qualification.status !== "qualified"
      )
        return fail("invalid-state");
      if (input.boundary === undefined)
        return accepted(state.managers, state.assignments, { managerId: manager.id });
      const boundary = input.boundary;
      if (
        boundary.projectId !== manager.projectId ||
        boundary.workflow.repositoryRoot !== manager.workflow.repositoryRoot ||
        boundary.workflow.revision !== manager.workflow.revision ||
        state.boundaries.some((entry) => entry.id === boundary.id)
      )
        return fail("invalid-state");
      return accepted(
        state.managers.map((entry) =>
          entry.id === manager.id
            ? { ...entry, boundaryId: boundary.id, status: "active", wait: null, updatedAt: now }
            : entry,
        ),
        state.assignments,
        { managerId: manager.id },
        [],
        state.defaults,
        [...state.boundaries, boundary],
      );
    }
    case "manager.create": {
      if (actor.kind !== "human") return fail("permission-denied");
      if (
        state.managers.some(
          (manager) => manager.role === "project" && manager.projectId === command.projectId,
        )
      ) {
        return fail("project-already-managed");
      }
      const allocation = input.allocation;
      if (
        allocation === undefined ||
        allocation.managerThreadId === allocation.leadThreadId ||
        state.managers.some(
          (manager) =>
            manager.threadId === allocation.managerThreadId ||
            manager.threadId === allocation.leadThreadId,
        ) ||
        state.assignments.some(
          (assignment) =>
            assignment.id === allocation.assignmentId ||
            assignment.threadId === allocation.leadThreadId ||
            assignment.threadId === allocation.managerThreadId,
        )
      ) {
        return fail("invalid-state");
      }
      const qualification = input.qualification ?? unavailableQualification;
      const wait = onboardingWait(qualification);
      const manager: Extract<FactoryManager, { readonly role: "project" }> = {
        id: allocation.managerThreadId,
        threadId: allocation.managerThreadId,
        role: "project",
        projectId: command.projectId,
        name: command.name ?? "Engineering manager",
        modelSelection: command.modelSelection,
        workflow: command.workflow,
        overrides: {},
        status: wait === null ? "onboarding" : "blocked",
        threadStatus: "pending",
        launchStatus: "pending",
        wait,
        createdAt: now,
        updatedAt: now,
      };
      const assignment: FactoryAssignment = {
        id: allocation.assignmentId,
        managerId: manager.id,
        threadId: allocation.leadThreadId,
        projectId: command.projectId,
        kind: "onboarding",
        status: wait === null ? "pending" : "waiting",
        threadStatus: "pending",
        launchStatus: "pending",
        qualification,
        workflow: command.workflow,
        grantedPolicy: effectivePolicy(state, manager),
        wait,
        report: null,
        createdAt: now,
        updatedAt: now,
      };
      return accepted(
        [...state.managers, manager],
        [...state.assignments, assignment],
        { managerId: manager.id, assignmentId: assignment.id },
        launchIntents(manager, assignment),
      );
    }
    case "manager.configure": {
      if (actor.kind !== "human") return fail("permission-denied");
      const manager = state.managers.find((entry) => entry.id === command.managerId);
      if (manager === undefined) return fail("manager-not-found");
      const managers = state.managers.map((entry) =>
        entry.id === manager.id
          ? { ...entry, overrides: command.overrides, updatedAt: now }
          : entry,
      );
      return accepted(managers, reduceGrants(state.assignments, managers, state.defaults, now), {
        managerId: manager.id,
      });
    }
    case "manager.retry-onboarding": {
      if (actor.kind !== "human") return fail("permission-denied");
      const manager = state.managers.find((entry) => entry.id === command.managerId);
      if (manager === undefined) return fail("manager-not-found");
      const assignment = state.assignments.find((entry) => entry.managerId === manager.id);
      if (assignment === undefined) return fail("assignment-not-found");
      if (
        manager.role !== "project" ||
        manager.status !== "blocked" ||
        assignment.report !== null ||
        assignment.wait?.kind !== "execution-boundary"
      ) {
        return fail("invalid-state");
      }
      if (
        (command.workflow !== undefined || command.modelSelection !== undefined) &&
        (manager.threadStatus === "created" || assignment.threadStatus === "created")
      )
        return fail("invalid-state");
      const qualification = input.qualification ?? assignment.qualification;
      if (
        (manager.threadStatus === "created" || assignment.threadStatus === "created") &&
        (qualification.status !== "qualified" ||
          assignment.qualification.status !== "qualified" ||
          qualification.profileId !== assignment.qualification.profileId)
      )
        return fail("invalid-state");
      const wait = onboardingWait(qualification);
      const updatedManager: typeof manager = {
        ...manager,
        workflow: command.workflow ?? manager.workflow,
        modelSelection: command.modelSelection ?? manager.modelSelection,
        status: wait === null ? "onboarding" : "blocked",
        wait,
        updatedAt: now,
      };
      const updatedAssignment: FactoryAssignment = {
        ...assignment,
        workflow: command.workflow ?? assignment.workflow,
        qualification,
        status: wait === null ? "pending" : "waiting",
        wait,
        updatedAt: now,
      };
      return accepted(
        state.managers.map((entry) => (entry.id === manager.id ? updatedManager : entry)),
        state.assignments.map((entry) => (entry.id === assignment.id ? updatedAssignment : entry)),
        { managerId: manager.id, assignmentId: assignment.id },
        launchIntents(updatedManager, updatedAssignment),
      );
    }
    case "onboarding.report": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (assignment === undefined) return fail("assignment-not-found");
      if (assignment.kind !== "onboarding") return fail("invalid-state");
      if (
        actor.kind !== "human" &&
        (actor.kind !== "thread" || actor.threadId !== assignment.threadId)
      ) {
        return fail("permission-denied");
      }
      if (
        assignment.threadStatus !== "created" ||
        assignment.qualification.status !== "qualified"
      ) {
        return fail("invalid-state");
      }
      const manager = state.managers.find((entry) => entry.id === assignment.managerId);
      if (manager === undefined) return fail("manager-not-found");
      if (manager.boundaryId !== undefined) return fail("invalid-state");
      const wait: FactoryWait = {
        kind:
          command.report.unresolvedDecisions.length === 0 ? "execution-boundary" : "human-decision",
        reason:
          command.report.unresolvedDecisions.length === 0
            ? "Onboarding findings are recorded. Configure an enforced delivery boundary before authorizing implementation."
            : "Review the onboarding report and resolve its project decisions before authorizing implementation.",
      };
      return accepted(
        state.managers.map((entry) =>
          entry.id === manager.id && assignment.kind === "onboarding"
            ? { ...entry, status: "blocked", wait, updatedAt: now }
            : entry,
        ),
        state.assignments.map((entry) =>
          entry.id === assignment.id
            ? { ...entry, status: "complete", wait: null, report: command.report, updatedAt: now }
            : entry,
        ),
        { managerId: manager.id, assignmentId: assignment.id },
      );
    }
    case "thread.launch.started":
    case "thread.launch.recorded": {
      if (actor.kind !== "system") return fail("permission-denied");
      const manager = state.managers.find((entry) => entry.threadId === command.threadId);
      const assignment = state.assignments.find((entry) => entry.threadId === command.threadId);
      if (manager === undefined && assignment === undefined) return fail("invalid-state");
      const onboarding =
        assignment ??
        state.assignments.find(
          (entry) => entry.managerId === manager?.id && entry.kind === "onboarding",
        );
      if (onboarding === undefined || onboarding.qualification.status !== "qualified") {
        return fail("execution-unavailable");
      }
      const delivered = command.type === "thread.launch.recorded";
      return accepted(
        state.managers.map((entry) =>
          entry.threadId === command.threadId
            ? {
                ...entry,
                threadStatus: "created",
                launchStatus: delivered ? "delivered" : entry.launchStatus,
                updatedAt: now,
              }
            : entry,
        ),
        state.assignments.map((entry) =>
          entry.threadId === command.threadId
            ? {
                ...entry,
                threadStatus: "created",
                launchStatus: delivered ? "delivered" : entry.launchStatus,
                status: delivered && entry.report === null ? "running" : entry.status,
                updatedAt: now,
              }
            : entry,
        ),
        {
          ...(manager === undefined ? {} : { managerId: manager.id }),
          ...(assignment === undefined
            ? {}
            : { managerId: assignment.managerId, assignmentId: assignment.id }),
        },
      );
    }
    case "thread.launch.failed": {
      if (actor.kind !== "system") return fail("permission-denied");
      const targetManager = state.managers.find((entry) => entry.threadId === command.threadId);
      const assignment = state.assignments.find(
        (entry) =>
          entry.threadId === command.threadId ||
          (entry.managerId === targetManager?.id && entry.kind === "onboarding"),
      );
      if (assignment === undefined) return fail("assignment-not-found");
      const manager = state.managers.find((entry) => entry.id === assignment.managerId);
      if (manager === undefined) return fail("manager-not-found");
      const targetDelivered =
        targetManager?.launchStatus === "delivered" ||
        (assignment.threadId === command.threadId && assignment.launchStatus === "delivered");
      if (targetDelivered || assignment.report !== null) {
        return accepted(state.managers, state.assignments, {
          managerId: manager.id,
          assignmentId: assignment.id,
        });
      }
      const wait: FactoryWait = { kind: "execution-boundary", reason: command.reason };
      return accepted(
        state.managers.map((entry) =>
          entry.id === manager.id && assignment.kind === "onboarding"
            ? { ...entry, status: "blocked", wait, updatedAt: now }
            : entry,
        ),
        state.assignments.map((entry) =>
          entry.id === assignment.id
            ? { ...entry, status: "waiting", wait, updatedAt: now }
            : entry,
        ),
        { managerId: manager.id, assignmentId: assignment.id },
      );
    }
  }
  return fail("invalid-state");
}
