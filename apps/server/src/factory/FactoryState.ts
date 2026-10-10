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
  type FactoryPolicy,
  type FactorySnapshot,
  type FactoryWait,
  type ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { constrainAssignmentPolicy, resolveManagerPolicy } from "./FactoryPolicy.ts";

export type FactoryActor =
  | { readonly kind: "human" }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
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

export function decide(input: {
  readonly state: FactorySnapshot;
  readonly actor: FactoryActor;
  readonly command: FactoryDecisionCommand;
  readonly now: string;
  readonly allocation?: FactoryAllocation;
  readonly qualification?: FactoryDiscoveryQualification;
  readonly boundary?: FactoryBoundary;
}): Result.Result<FactoryDecision, FactoryError> {
  const { state, actor, command, now } = input;
  const fail = (code: FactoryError["code"]) => Result.fail(new FactoryError({ code }));
  const accepted = (
    managers: ReadonlyArray<FactoryManager>,
    assignments: ReadonlyArray<FactoryAssignment>,
    result: Omit<FactoryCommandResult, "revision">,
    effects: ReadonlyArray<FactoryEffectIntent> = [],
    defaults: FactoryPolicy = state.defaults,
    boundaries: ReadonlyArray<FactoryBoundary> = state.boundaries,
  ): Result.Result<FactoryDecision, FactoryError> => {
    const revision = state.revision + 1;
    return Result.succeed({
      state: { ...state, revision, managers, assignments, defaults, boundaries },
      result: { ...result, revision },
      effects,
    });
  };

  switch (command.type) {
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
          entry.id === manager.id ? { ...entry, status: "blocked", wait, updatedAt: now } : entry,
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
        assignment ?? state.assignments.find((entry) => entry.managerId === manager?.id);
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
        (entry) => entry.threadId === command.threadId || entry.managerId === targetManager?.id,
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
          entry.id === manager.id ? { ...entry, status: "blocked", wait, updatedAt: now } : entry,
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
}
