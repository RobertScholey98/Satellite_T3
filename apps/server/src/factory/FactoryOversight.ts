import {
  FactoryError,
  MessageId,
  type FactoryAssignment,
  type FactoryAssignmentOversight,
  type FactoryAuxiliaryThread,
  type FactoryCommandResult,
  type FactoryDecisionCommand,
  type FactoryDeliveryEvidence,
  type FactoryDependency,
  type FactoryEffectIntent,
  type FactoryManager,
  type FactoryRecoveryIncident,
  type FactorySnapshot,
  type FactorySupportingWork,
  type ModelSelection,
  type PullRequestRef,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Result from "effect/Result";

import { factoryDirectionBlocked, factoryExecutionBlocked } from "./FactoryControls.ts";
import {
  constrainFactoryModelPolicy,
  isFactoryModelApproved,
  resolveFactoryModelPolicy,
} from "./FactoryModelPolicy.ts";
import { resolveManagerPolicy } from "./FactoryPolicy.ts";
import { factoryDeliveryWaitReason } from "./FactoryDelivery.ts";
import { factoryCompletionEligibility, initialFactoryCompletion } from "./FactoryRetros.ts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type { FactoryActor, FactoryDecision } from "./FactoryState.ts";

export interface FactoryOversightContext {
  readonly reviewVerified?: boolean;
  readonly auxiliaryAllocation?: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
  };
  readonly replacementAllocation?: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
  };
}

export const initialFactoryOversight = (): FactoryAssignmentOversight => ({
  recovery: { cyclesUsed: 0, history: [] },
});

const samePullRequest = (left: PullRequestRef, right: PullRequestRef) =>
  left.projectId === right.projectId &&
  (left.host ?? "github.com") === (right.host ?? "github.com") &&
  left.repository === right.repository &&
  left.number === right.number;

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

export const factoryDeliverySatisfies = (
  dependency: FactoryDependency,
  delivery: FactoryDeliveryEvidence,
) => {
  const condition = dependency.unblockCondition;
  if (condition.kind === "pull-request-merged")
    return (
      delivery.kind === "pull-request-merged" &&
      condition.projectId === delivery.projectId &&
      delivery.ref.projectId === delivery.projectId &&
      (condition.ref === undefined || samePullRequest(condition.ref, delivery.ref)) &&
      (condition.expectedHeadSha === undefined || condition.expectedHeadSha === delivery.headSha)
    );
  return (
    delivery.kind === "report-delivered" &&
    condition.recipientThreadId === delivery.recipientThreadId &&
    dependency.supportingAssignmentId === delivery.assignmentId
  );
};

export const factorySupportingWorkMatches = (
  approved: FactorySupportingWork,
  requested: FactorySupportingWork,
) =>
  approved.title === requested.title &&
  approved.scope.description === requested.scope.description &&
  approved.scope.completionCondition === requested.scope.completionCondition &&
  approved.scope.requiresPullRequest === requested.scope.requiresPullRequest &&
  stableStringify(approved.scope.noPrTarget) === stableStringify(requested.scope.noPrTarget) &&
  approved.complexity === requested.complexity &&
  approved.kind === requested.kind &&
  sameStrings(approved.sourcePaths, requested.sourcePaths) &&
  sameStrings(approved.creatableDirectories, requested.creatableDirectories) &&
  sameStrings(approved.controlPaths ?? [], requested.controlPaths ?? []) &&
  (approved.modelSelection === undefined
    ? requested.modelSelection === undefined
    : requested.modelSelection !== undefined &&
      modelSelectionsEqual(approved.modelSelection, requested.modelSelection));

const member = (assignment: FactoryAssignment) => ({
  threadId: assignment.threadId,
  managerId: assignment.managerId,
  projectId: assignment.projectId,
  assignmentId: assignment.id,
  ancestorThreadIds: [],
});

export const factoryRecoveryBlocked = (state: FactorySnapshot, assignment: FactoryAssignment) => {
  if (
    assignment.kind === "onboarding" ||
    assignment.outcome !== undefined ||
    assignment.completion?.phase === "concluded" ||
    assignment.status === "complete"
  )
    return "This assignment has no implementation recovery pending.";
  const deliveryWait = factoryDeliveryWaitReason(assignment);
  if (deliveryWait) return deliveryWait;
  const blocked = factoryDirectionBlocked(state, member(assignment), assignment.managerId);
  if (blocked !== undefined) return blocked;
  if (
    state.controls.some(
      (entry) =>
        entry.kind === "takeover" &&
        entry.status === "active" &&
        entry.assignmentId === assignment.id,
    )
  )
    return "The user controls part of this team. Recovery waits for handback.";
  if (assignment.wait !== null && assignment.wait.kind !== "recovery")
    return assignment.wait.reason;
};

export const factoryRecoveryAllowance = (
  state: FactorySnapshot,
  assignment: FactoryAssignment,
  manager: FactoryManager,
) =>
  Math.min(
    assignment.grantedPolicy.recoveryCycles,
    resolveManagerPolicy(state.defaults, manager.overrides).recoveryCycles,
  );

export function decideFactoryOversight(
  input: FactoryOversightContext & {
    readonly state: FactorySnapshot;
    readonly actor: FactoryActor;
    readonly command: FactoryDecisionCommand;
    readonly now: string;
  },
): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  const fail = (code: FactoryError["code"], detail?: string) =>
    Result.fail(new FactoryError({ code, ...(detail === undefined ? {} : { detail }) }));
  const accept = (
    patch: Partial<FactorySnapshot> = {},
    result: Omit<FactoryCommandResult, "revision"> = {},
    effects: ReadonlyArray<FactoryEffectIntent> = [],
  ): Result.Result<FactoryDecision, FactoryError> => {
    const revision = state.revision + 1;
    return Result.succeed({
      state: { ...state, ...patch, revision },
      result: { ...result, revision },
      effects,
    });
  };
  const saveAssignment = (
    assignment: FactoryAssignment,
    effects: ReadonlyArray<FactoryEffectIntent> = [],
    patch: Partial<FactorySnapshot> = {},
  ) =>
    accept(
      {
        ...patch,
        assignments: state.assignments.map((entry) =>
          entry.id === assignment.id ? { ...assignment, updatedAt: now } : entry,
        ),
      },
      { assignmentId: assignment.id, managerId: assignment.managerId },
      effects,
    );
  const saveDependency = (
    dependency: FactoryDependency,
    effects: ReadonlyArray<FactoryEffectIntent> = [],
    patch: Partial<FactorySnapshot> = {},
  ) =>
    accept(
      {
        ...patch,
        dependencies: state.dependencies.some((entry) => entry.id === dependency.id)
          ? state.dependencies.map((entry) => (entry.id === dependency.id ? dependency : entry))
          : [...state.dependencies, dependency],
      },
      { dependencyId: dependency.id, assignmentId: dependency.assignmentId },
      effects,
    );
  const saveAuxiliary = (
    auxiliary: FactoryAuxiliaryThread,
    effects: ReadonlyArray<FactoryEffectIntent> = [],
    patch: Partial<FactorySnapshot> = {},
  ) =>
    accept(
      {
        ...patch,
        auxiliaryThreads: state.auxiliaryThreads.map((entry) =>
          entry.threadId === auxiliary.threadId ? { ...auxiliary, updatedAt: now } : entry,
        ),
      },
      { auxiliaryThreadId: auxiliary.threadId, assignmentId: auxiliary.assignmentId },
      effects,
    );
  const leadAuthorized = (assignment: FactoryAssignment) =>
    actor.kind === "human" || (actor.kind === "thread" && actor.threadId === assignment.threadId);
  const managerAuthorized = (assignment: FactoryAssignment) => {
    if (actor.kind === "human") return true;
    if (actor.kind !== "thread" || actor.threadId !== assignment.managerId) return false;
    return (
      factoryRecoveryBlocked(state, { ...assignment, wait: null }) === undefined &&
      factoryExecutionBlocked(state, {
        threadId: assignment.managerId,
        managerId: assignment.managerId,
        projectId: assignment.projectId,
        ancestorThreadIds: [],
      }) === undefined
    );
  };
  const activeAssignment = (assignment: FactoryAssignment) =>
    assignment.kind !== "onboarding" &&
    assignment.outcome === undefined &&
    assignment.status !== "complete" &&
    assignment.completion?.phase !== "concluded";
  const notify = (
    assignment: FactoryAssignment,
    key: string,
    text: string,
  ): FactoryEffectIntent => ({
    type: "thread.deliver",
    threadId: assignment.managerId,
    messageId: MessageId.make(`factory:${assignment.id}:${key}`),
    kind: "coordination",
    text,
  });
  // Only manager-authored continuations name the manager as sender, so a manager
  // pause holds them. Human and host continuations still reach the team.
  const continuation = (
    assignment: FactoryAssignment,
    incidentId: string,
    text: string,
    recoveryIncidentId?: string,
    sourceThreadId?: ThreadId,
  ): FactoryEffectIntent => ({
    type: "thread.deliver",
    threadId: assignment.threadId,
    messageId: MessageId.make(
      `factory:${assignment.id}:recovery:${incidentId}:${assignment.threadId}`,
    ),
    kind: "continuation",
    ...(recoveryIncidentId === undefined
      ? {}
      : { purpose: { kind: "recovery" as const, incidentId: recoveryIncidentId } }),
    ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
    text,
  });
  const reconcile = (assignment: FactoryAssignment, triggerId: string): FactoryEffectIntent => ({
    type: "assignment.reconcile",
    assignmentId: assignment.id,
    triggerId,
  });
  const deliveryInspection = (assignment: FactoryAssignment): FactoryEffectIntent[] => {
    const revision = assignment.delivery?.revisions.find(
      (entry) => entry.id === assignment.delivery?.currentRevisionId,
    );
    return revision?.status === "published" &&
      revision.publication?.ref !== undefined &&
      !["requested", "unknown", "merged"].includes(revision.merge?.status ?? "")
      ? [{ type: "delivery.inspect", assignmentId: assignment.id, revisionId: revision.id }]
      : [];
  };
  const approvedModel = (
    assignment: FactoryAssignment,
    manager: FactoryManager,
    selection: ModelSelection,
  ) => {
    if (assignment.modelPolicy === undefined) return false;
    return isFactoryModelApproved(
      constrainFactoryModelPolicy(
        assignment.modelPolicy,
        resolveFactoryModelPolicy(
          state.modelDefaults,
          manager.modelOverrides,
          manager.modelSelection,
        ),
      ),
      selection,
    );
  };
  const escalation = (
    assignment: FactoryAssignment,
    incident: FactoryRecoveryIncident,
    failure: string,
  ) => {
    const oversight = assignment.oversight ?? initialFactoryOversight();
    const details = {
      failure,
      attempts: [...oversight.recovery.history, incident]
        .filter((entry) => entry.plan !== undefined)
        .map((entry) => entry.plan!),
      options: [
        "Review the recorded diagnosis and continue with a human-approved plan.",
        "Authorize separate supporting work or change the assignment.",
        "Cancel the assignment and record the reason.",
      ],
      recommendation: "Review the evidence and choose the next step. Automatic recovery is paused.",
    };
    return saveAssignment(
      {
        ...assignment,
        status: "waiting",
        wait: { kind: "human-decision", reason: failure },
        oversight: {
          ...oversight,
          decisionPending: failure,
          recovery: {
            ...oversight.recovery,
            incident: { ...incident, phase: "escalated", escalation: details },
          },
        },
      },
      [
        notify(
          assignment,
          `escalated:${incident.id}`,
          `${details.failure}\nAttempted remedies: ${details.attempts.join("; ") || "No automatic remedy was applied."}\nOptions: ${details.options.join(" ")}\nRecommendation: ${details.recommendation}\nReplace these generic options with concrete ones and your recommendation for the human using assignment.recovery.escalate for incident ${incident.id}.`,
        ),
      ],
    );
  };
  const deliverDependency = (dependency: FactoryDependency, delivery: FactoryDeliveryEvidence) => {
    const assignment = state.assignments.find((entry) => entry.id === dependency.assignmentId);
    if (
      !assignment ||
      !activeAssignment(assignment) ||
      dependency.authorization === undefined ||
      (dependency.supportingAssignmentId === undefined &&
        (dependency.unblockCondition.kind !== "pull-request-merged" ||
          dependency.unblockCondition.ref === undefined)) ||
      !factoryDeliverySatisfies(dependency, delivery) ||
      dependency.delivery?.id === delivery.id
    )
      return undefined;
    const updated: FactoryDependency = {
      ...dependency,
      state: "checking",
      delivery,
      updatedAt: now,
    };
    const effect: FactoryEffectIntent = {
      type: "thread.deliver",
      threadId: assignment.threadId,
      messageId: MessageId.make(`factory:${dependency.id}:usability:${delivery.id}`),
      kind: "continuation",
      purpose: {
        kind: "dependency-usability",
        dependencyId: dependency.id,
        deliveryId: delivery.id,
      },
      text: `Dependency ${dependency.id} has host-confirmed delivery ${delivery.id}. Check whether it is usable for the original assignment and report dependency.check-usability with evidence. Preserve the assignment's scope and other waits; approval does not authorize importing or changing protected inputs.`,
    };
    return { dependency: updated, effect };
  };

  switch (command.type) {
    case "assignment.progress": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (!leadAuthorized(assignment)) return fail("permission-denied");
      if (!activeAssignment(assignment)) return fail("invalid-state");
      return saveAssignment({
        ...assignment,
        oversight: {
          ...(assignment.oversight ?? initialFactoryOversight()),
          progress: {
            summary: command.summary,
            remainingWork: command.remainingWork,
            evidence: command.evidence,
            reportedAt: now,
          },
        },
      });
    }
    case "dependency.request": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (!leadAuthorized(assignment)) return fail("permission-denied");
      if (
        !activeAssignment(assignment) ||
        state.dependencies.some((entry) => entry.id === command.dependencyId)
      )
        return fail("invalid-state");
      const dependency: FactoryDependency = {
        id: command.dependencyId,
        assignmentId: assignment.id,
        description: command.description,
        unblockCondition: command.unblockCondition,
        requestedBy: assignment.threadId,
        evidence: command.evidence,
        state: "requested",
        createdAt: now,
        updatedAt: now,
      };
      return saveDependency(dependency, [
        notify(
          assignment,
          `dependency:${dependency.id}`,
          `The implementation lead requested separate work: ${dependency.description}\nDependency: ${dependency.id}. Review its unblock condition and authorize a separate assignment if appropriate. Existing permitted work may continue.`,
        ),
      ]);
    }
    case "assignment.wait": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (!leadAuthorized(assignment)) return fail("permission-denied");
      if (
        !activeAssignment(assignment) ||
        (assignment.wait !== null &&
          (assignment.wait.kind !== command.wait.kind ||
            (assignment.wait.kind !== "dependency" && assignment.wait.kind !== "review")))
      )
        return fail("invalid-state");
      if (
        command.wait.kind === "dependency" &&
        (command.wait.dependencyIds.length === 0 ||
          command.wait.dependencyIds.some(
            (id) =>
              !state.dependencies.some(
                (entry) =>
                  entry.id === id &&
                  entry.assignmentId === assignment.id &&
                  entry.authorization !== undefined &&
                  entry.state !== "usable",
              ),
          ))
      )
        return fail("invalid-state");
      if (command.wait.kind === "review" && !input.reviewVerified) return fail("permission-denied");
      if (assignment.wait?.kind === "dependency" && command.wait.kind === "dependency") {
        const ids = command.wait.dependencyIds;
        if (assignment.wait.dependencyIds.some((id) => !ids.includes(id)))
          return fail("invalid-state");
      }
      const oversight = assignment.oversight ?? initialFactoryOversight();
      return saveAssignment(
        {
          ...assignment,
          status: "waiting",
          wait: command.wait,
          oversight: {
            ...oversight,
            ...(command.wait.kind === "human-decision"
              ? { decisionPending: command.wait.reason }
              : {}),
          },
        },
        command.wait.kind === "human-decision"
          ? [notify(assignment, `decision:${command.commandId}`, command.wait.reason)]
          : [],
      );
    }
    case "assignment.wait.resolve": {
      if (actor.kind !== "human") return fail("permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (
        !activeAssignment(assignment) ||
        assignment.wait?.kind !== "human-decision" ||
        assignment.oversight?.decisionPending === undefined
      )
        return fail("invalid-state");
      const { decisionPending: _, ...oversight } = assignment.oversight;
      const incident = oversight.recovery.incident;
      return saveAssignment(
        {
          ...assignment,
          status: "running",
          wait: null,
          oversight: {
            ...oversight,
            recovery: {
              ...oversight.recovery,
              ...(incident === undefined ? {} : { incident: { ...incident, phase: "continuing" } }),
            },
          },
        },
        [
          continuation(
            assignment,
            command.commandId,
            "The user resolved the pending decision. Continue only within the existing assignment scope, grants and remaining recovery allowance.",
            incident?.id,
          ),
        ],
      );
    }
    case "dependency.approve": {
      const dependency = state.dependencies.find((entry) => entry.id === command.dependencyId);
      const assignment = state.assignments.find((entry) => entry.id === dependency?.assignmentId);
      if (!dependency || !assignment) return fail("assignment-not-found");
      if (!managerAuthorized(assignment)) return fail("permission-denied");
      if (!activeAssignment(assignment) || dependency.state !== "requested")
        return fail("invalid-state");
      if (
        dependency.unblockCondition.kind === "pull-request-merged" &&
        dependency.unblockCondition.projectId !== assignment.projectId
      )
        return fail(
          "permission-denied",
          "This dependency requires its owning project's manager; it cannot expand this manager's remit.",
        );
      if (command.work.kind === "rule-change" && actor.kind !== "human")
        return fail(
          "permission-denied",
          "Dependency approval cannot authorize weakening protected rules. Use a separately authorized human task.",
        );
      return saveDependency(
        {
          ...dependency,
          state: "approved",
          authorization: {
            commandId: command.commandId,
            managerId: assignment.managerId,
            work: command.work,
          },
          updatedAt: now,
        },
        [reconcile(assignment, `dependency-approved:${command.commandId}`)],
      );
    }
    case "dependency.check-usability": {
      const dependency = state.dependencies.find((entry) => entry.id === command.dependencyId);
      const assignment = state.assignments.find((entry) => entry.id === dependency?.assignmentId);
      if (!dependency || !assignment) return fail("assignment-not-found");
      if (!leadAuthorized(assignment)) return fail("permission-denied");
      if (
        !activeAssignment(assignment) ||
        dependency.state !== "checking" ||
        dependency.delivery?.id !== command.deliveryId ||
        command.evidence.length === 0
      )
        return fail("invalid-state");
      const updated: FactoryDependency = {
        ...dependency,
        state: command.usable ? "usable" : "unusable",
        usability: {
          deliveryId: command.deliveryId,
          usable: command.usable,
          evidence: command.evidence,
          checkedAt: now,
        },
        updatedAt: now,
      };
      const remaining =
        assignment.wait?.kind === "dependency"
          ? assignment.wait.dependencyIds.filter((id) => id !== dependency.id || !command.usable)
          : undefined;
      const resumed = remaining?.length === 0;
      const nextAssignment: FactoryAssignment = {
        ...assignment,
        ...(remaining === undefined
          ? {}
          : {
              wait: resumed
                ? null
                : { kind: "dependency", dependencyIds: remaining, reason: assignment.wait!.reason },
              status: resumed ? "running" : "waiting",
            }),
        updatedAt: now,
      };
      return saveDependency(
        updated,
        command.usable
          ? resumed
            ? [
                continuation(
                  nextAssignment,
                  `dependency:${dependency.id}:${command.deliveryId}`,
                  "All recorded blocking dependencies are usable. Continue the original authorized assignment within its existing scope and grants.",
                ),
              ]
            : []
          : [
              notify(
                assignment,
                `unusable:${dependency.id}:${command.deliveryId}`,
                `Delivered dependency ${dependency.id} is not usable. Evidence: ${command.evidence.map((entry) => `${entry.label}: ${entry.location}`).join("; ")}. Review separate follow-up work; this expected wait does not consume recovery allowance.`,
              ),
            ],
        {
          assignments: state.assignments.map((entry) =>
            entry.id === assignment.id ? nextAssignment : entry,
          ),
        },
      );
    }
    case "assignment.delivery.request": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (!leadAuthorized(assignment)) return fail("permission-denied");
      if (!activeAssignment(assignment)) return fail("invalid-state");
      if (
        command.claim.kind === "pull-request" &&
        command.claim.ref.projectId !== assignment.projectId
      )
        return fail("invalid-state");
      if (assignment.scope?.requiresPullRequest && command.claim.kind !== "pull-request")
        return fail("invalid-state");
      return saveAssignment(
        {
          ...assignment,
          oversight: {
            ...(assignment.oversight ?? initialFactoryOversight()),
            deliveryClaim: command.claim,
          },
        },
        [reconcile(assignment, `delivery:${command.commandId}`)],
      );
    }
    case "assignment.run.observed": {
      if (actor.kind !== "system") return fail("permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (!activeAssignment(assignment)) return accept();
      const oversight = assignment.oversight ?? initialFactoryOversight();
      const observation = {
        threadId: command.threadId,
        runId: command.runId,
        attemptId: command.attemptId,
        status: command.status,
      };
      const previous = oversight.lastObservedRun;
      if (
        previous?.threadId === observation.threadId &&
        previous.runId === observation.runId &&
        previous.attemptId === observation.attemptId &&
        previous.status === observation.status
      )
        return accept();
      const terminal = ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
        command.status,
      );
      return saveAssignment(
        { ...assignment, oversight: { ...oversight, lastObservedRun: observation } },
        terminal
          ? [reconcile(assignment, `run:${command.runId}:${command.attemptId ?? "none"}`)]
          : [],
      );
    }
    case "project.reconcile.requested": {
      if (actor.kind !== "system") return fail("permission-denied");
      return accept(
        {},
        {},
        state.assignments.flatMap((assignment) => {
          if (assignment.projectId !== command.projectId || !activeAssignment(assignment))
            return [];
          const inspection = deliveryInspection(assignment);
          const needsReconciliation =
            assignment.oversight?.deliveryClaim !== undefined ||
            inspection.length > 0 ||
            state.dependencies.some(
              (dependency) =>
                dependency.assignmentId === assignment.id &&
                dependency.authorization !== undefined &&
                dependency.state !== "usable" &&
                dependency.unblockCondition.kind === "pull-request-merged" &&
                dependency.unblockCondition.ref !== undefined,
            );
          return needsReconciliation
            ? [reconcile(assignment, command.triggerId), ...inspection]
            : [];
        }),
      );
    }
    case "assignment.reconcile.requested": {
      if (actor.kind !== "system") return fail("permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      return accept(
        {},
        {},
        activeAssignment(assignment)
          ? [reconcile(assignment, command.triggerId), ...deliveryInspection(assignment)]
          : [],
      );
    }
    case "assignment.reconciled": {
      if (actor.kind !== "system") return fail("permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      const observation = command.observation;
      if (
        factoryRecoveryBlocked(state, assignment) !== undefined ||
        observation.kind === "active" ||
        observation.kind === "expected-wait"
      )
        return accept();
      const oversight = assignment.oversight ?? initialFactoryOversight();
      const previous = oversight.recovery.incident;
      if (
        [...oversight.recovery.history, ...(previous === undefined ? [] : [previous])].some(
          (entry) =>
            entry.id === command.triggerId ||
            (observation.runId !== undefined &&
              entry.sourceRunId === observation.runId &&
              entry.sourceAttemptId === observation.attemptId),
        ) ||
        (previous !== undefined && previous.phase !== "continuing")
      )
        return accept();
      const incident: FactoryRecoveryIncident = {
        id: command.triggerId,
        phase: "reconciling",
        reason: observation.reason,
        evidence: observation.evidence,
        ...(observation.runId === undefined ? {} : { sourceRunId: observation.runId }),
        ...(observation.attemptId === undefined ? {} : { sourceAttemptId: observation.attemptId }),
      };
      const next: FactoryAssignment = {
        ...assignment,
        oversight: {
          ...oversight,
          recovery: {
            ...oversight.recovery,
            history:
              previous === undefined
                ? oversight.recovery.history
                : [...oversight.recovery.history, previous],
            incident,
          },
        },
      };
      const manager = state.managers.find((entry) => entry.id === assignment.managerId);
      if (!manager) return fail("manager-not-found");
      if (
        observation.kind === "ambiguous" ||
        oversight.recovery.cyclesUsed >= factoryRecoveryAllowance(state, assignment, manager)
      )
        return escalation(
          next,
          incident,
          observation.kind === "ambiguous"
            ? `The previous outcome is uncertain: ${observation.reason}`
            : `Automatic recovery allowance is exhausted: ${observation.reason}`,
        );
      return saveAssignment(
        { ...next, status: "waiting", wait: { kind: "recovery", reason: observation.reason } },
        [
          notify(
            assignment,
            `incident:${incident.id}`,
            `Authorized work remains after the team stopped: ${incident.reason}\nEvidence: ${incident.evidence.map((entry) => `${entry.label}: ${entry.location}`).join("; ")}\nReconcile the evidence and begin at most the remaining approved diagnosis-and-replan cycles. The assignment is not complete.`,
          ),
        ],
      );
    }
    case "dependency.delivery.observed": {
      if (actor.kind !== "system") return fail("permission-denied");
      const dependency = state.dependencies.find((entry) => entry.id === command.dependencyId);
      if (!dependency) return fail("assignment-not-found");
      const delivery = deliverDependency(dependency, command.delivery);
      return delivery === undefined
        ? accept()
        : saveDependency(delivery.dependency, [delivery.effect]);
    }
    case "assignment.delivery.recorded": {
      if (actor.kind !== "system") return fail("permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (!activeAssignment(assignment)) return accept();
      const oversight = assignment.oversight ?? initialFactoryOversight();
      const claim = oversight.deliveryClaim;
      const delivery = command.delivery;
      const completion = assignment.completion ?? initialFactoryCompletion(assignment.scope);
      const declared =
        completion.plan.kind === "pull-requests" &&
        delivery.kind === "pull-request-merged" &&
        completion.plan.requirements.some((requirement) =>
          samePullRequest(requirement.ref, delivery.ref),
        );
      if (
        delivery.kind === "pull-request-merged"
          ? (!declared &&
              (claim?.kind !== "pull-request" || !samePullRequest(claim.ref, delivery.ref))) ||
            delivery.projectId !== assignment.projectId ||
            delivery.ref.projectId !== assignment.projectId
          : claim?.kind !== "report" ||
            delivery.assignmentId !== assignment.id ||
            delivery.recipientThreadId !== claim.recipientThreadId ||
            delivery.messageId !== claim.messageId ||
            assignment.scope?.requiresPullRequest
      )
        return fail("invalid-state");
      if (completion.deliveries.some((entry) => entry.id === delivery.id)) return accept();
      const updated: FactoryAssignment = {
        ...assignment,
        completion: { ...completion, deliveries: [...completion.deliveries, delivery] },
        oversight: { ...oversight, delivery },
      };
      const complete = factoryCompletionEligibility(state, updated).eligible;
      const propagated = state.dependencies.map((dependency) => {
        const explicit =
          dependency.unblockCondition.kind === "pull-request-merged" &&
          dependency.unblockCondition.ref !== undefined &&
          delivery.kind === "pull-request-merged" &&
          samePullRequest(dependency.unblockCondition.ref, delivery.ref);
        const fact = explicit
          ? delivery
          : dependency.supportingAssignmentId === assignment.id && complete
            ? updated.completion?.deliveries.find((entry) =>
                factoryDeliverySatisfies(dependency, entry),
              )
            : undefined;
        return fact === undefined ? undefined : deliverDependency(dependency, fact);
      });
      return saveAssignment(
        {
          ...updated,
          status: "waiting",
          wait: {
            kind: complete ? "delivered" : "human-decision",
            reason: complete
              ? "All declared deliveries are verified. Final linked-PR reconciliation and retrospective preparation remain."
              : "An individual delivery is verified. Declare and satisfy every required delivery before the final retrospective.",
          },
        },
        [
          ...propagated.flatMap((entry) => (entry === undefined ? [] : [entry.effect])),
          ...(completion.plan.kind === "pull-requests" &&
          completion.plan.requirements.length > 0 &&
          !complete
            ? [reconcile(updated, `delivery-set:${delivery.id}`)]
            : []),
        ],
        {
          dependencies: state.dependencies.map(
            (entry, index) => propagated[index]?.dependency ?? entry,
          ),
        },
      );
    }
    case "assignment.recovery.begin": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (!managerAuthorized(assignment)) return fail("permission-denied");
      const incident = assignment.oversight?.recovery.incident;
      if (
        !incident ||
        incident.id !== command.incidentId ||
        incident.phase !== "reconciling" ||
        factoryRecoveryBlocked(state, assignment) !== undefined
      )
        return fail("invalid-state");
      const manager = state.managers.find((entry) => entry.id === assignment.managerId);
      if (!manager) return fail("manager-not-found");
      const oversight = assignment.oversight!;
      if (oversight.recovery.cyclesUsed >= factoryRecoveryAllowance(state, assignment, manager))
        return fail("permission-denied");
      const allocation = input.auxiliaryAllocation;
      if (
        !allocation ||
        state.auxiliaryThreads.some((entry) => entry.threadId === allocation.threadId) ||
        state.assignments.some(
          (entry) =>
            entry.threadId === allocation.threadId ||
            entry.previousLeadThreadIds?.includes(allocation.threadId),
        ) ||
        state.managers.some((entry) => entry.threadId === allocation.threadId) ||
        !approvedModel(assignment, manager, allocation.modelSelection)
      )
        return fail("permission-denied");
      const cycle = oversight.recovery.cyclesUsed + 1;
      const auxiliary: FactoryAuxiliaryThread = {
        threadId: allocation.threadId,
        assignmentId: assignment.id,
        managerId: assignment.managerId,
        projectId: assignment.projectId,
        kind: "diagnosis",
        incidentId: incident.id,
        cycle,
        status: "pending",
        modelSelection: allocation.modelSelection,
        createdAt: now,
        updatedAt: now,
      };
      return saveAssignment(
        {
          ...assignment,
          status: "waiting",
          wait: { kind: "recovery", reason: "An independent read-only diagnosis is pending." },
          oversight: {
            ...oversight,
            recovery: {
              ...oversight.recovery,
              cyclesUsed: cycle,
              incident: { ...incident, phase: "diagnosing", diagnosisThreadId: auxiliary.threadId },
            },
          },
        },
        [
          {
            type: "auxiliary.launch",
            assignmentId: assignment.id,
            threadId: auxiliary.threadId,
            incidentId: incident.id,
            cycle,
          },
        ],
        { auxiliaryThreads: [...state.auxiliaryThreads, auxiliary] },
      );
    }
    case "auxiliary.reconcile.requested": {
      if (actor.kind !== "system") return fail("permission-denied");
      const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === command.threadId);
      if (!auxiliary) return fail("assignment-not-found");
      return accept(
        {},
        {},
        auxiliary.status === "pending" || auxiliary.status === "running"
          ? [
              {
                type: "auxiliary.reconcile",
                threadId: auxiliary.threadId,
                triggerId: command.triggerId,
              },
            ]
          : [],
      );
    }
    case "auxiliary.reconciled": {
      if (actor.kind !== "system") return fail("permission-denied");
      const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === command.threadId);
      if (!auxiliary) return fail("assignment-not-found");
      const assignment = state.assignments.find((entry) => entry.id === auxiliary.assignmentId);
      if (auxiliary.kind === "delivery-review") {
        const delivery = assignment?.delivery;
        const revision = delivery?.revisions.find((entry) => entry.id === auxiliary.revisionId);
        const review = revision?.reviews.find((entry) => entry.threadId === auxiliary.threadId);
        if (
          command.observation.kind === "active" ||
          !assignment ||
          !activeAssignment(assignment) ||
          auxiliary.status !== "running" ||
          !delivery ||
          !revision ||
          delivery.currentRevisionId !== revision.id ||
          review?.status !== "running"
        )
          return accept();
        const reason = command.observation.reason;
        return saveAssignment(
          {
            ...assignment,
            delivery: {
              ...delivery,
              readiness: [reason],
              revisions: delivery.revisions.map((entry) =>
                entry.id === revision.id
                  ? {
                      ...entry,
                      reviews: entry.reviews.map((item) =>
                        item.id === review.id
                          ? { ...item, status: "failed", findings: reason }
                          : item,
                      ),
                    }
                  : entry,
              ),
            },
          },
          [
            {
              type: "thread.deliver",
              threadId: assignment.threadId,
              sourceThreadId: assignment.threadId,
              messageId: MessageId.make(`factory-review:${command.commandId}`),
              kind: "continuation",
              purpose: { kind: "delivery", revisionId: revision.id },
              text: reason,
            },
          ],
          {
            auxiliaryThreads: state.auxiliaryThreads.map((entry) =>
              entry.threadId === auxiliary.threadId
                ? { ...entry, status: "failed", failure: reason, updatedAt: now }
                : entry,
            ),
          },
        );
      }
      const incident = assignment?.oversight?.recovery.incident;
      if (
        command.observation.kind === "active" ||
        auxiliary.status !== "running" ||
        auxiliary.findings !== undefined ||
        !assignment ||
        !activeAssignment(assignment) ||
        !incident ||
        incident.id !== auxiliary.incidentId ||
        incident.diagnosisThreadId !== auxiliary.threadId ||
        incident.phase !== "diagnosing"
      )
        return accept();
      if (factoryRecoveryBlocked(state, assignment) !== undefined) return fail("invalid-state");
      const failed: FactoryAuxiliaryThread = {
        ...auxiliary,
        status: "failed",
        failure: command.observation.reason,
        updatedAt: now,
      };
      return Result.map(
        escalation(assignment, incident, command.observation.reason),
        (decision) => ({
          ...decision,
          state: {
            ...decision.state,
            auxiliaryThreads: state.auxiliaryThreads.map((entry) =>
              entry.threadId === failed.threadId ? failed : entry,
            ),
          },
        }),
      );
    }
    case "auxiliary.prepared":
    case "auxiliary.started":
    case "auxiliary.failed": {
      if (actor.kind !== "system") return fail("permission-denied");
      const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === command.threadId);
      if (!auxiliary) return fail("assignment-not-found");
      if (auxiliary.status !== "pending") return accept();
      const assignment = state.assignments.find((entry) => entry.id === auxiliary.assignmentId);
      if (!assignment || !activeAssignment(assignment)) return accept();
      const incident = assignment.oversight?.recovery.incident;
      if (
        !incident ||
        incident.id !== auxiliary.incidentId ||
        incident.phase !== "diagnosing" ||
        incident.diagnosisThreadId !== auxiliary.threadId ||
        factoryRecoveryBlocked(state, assignment) !== undefined
      )
        return fail("invalid-state");
      if (command.type === "auxiliary.started" || command.type === "auxiliary.prepared") {
        if (
          auxiliary.qualification !== undefined &&
          (auxiliary.qualification.profileId !== command.qualification.profileId ||
            auxiliary.sourceDigest !== command.sourceDigest)
        )
          return fail("invalid-state");
        return saveAuxiliary(
          {
            ...auxiliary,
            status: command.type === "auxiliary.started" ? "running" : "pending",
            qualification: command.qualification,
            sourceDigest: command.sourceDigest,
          },
          command.type === "auxiliary.started"
            ? [
                {
                  type: "auxiliary.reconcile",
                  threadId: auxiliary.threadId,
                  triggerId: `started:${command.commandId}`,
                },
              ]
            : [],
        );
      }
      const failed: FactoryAuxiliaryThread = {
        ...auxiliary,
        status: "failed",
        failure: command.reason,
        updatedAt: now,
      };
      const escalated = escalation(
        assignment,
        incident,
        `The read-only diagnosis could not start: ${command.reason}`,
      );
      return Result.map(escalated, (decision) => ({
        ...decision,
        state: {
          ...decision.state,
          auxiliaryThreads: state.auxiliaryThreads.map((entry) =>
            entry.threadId === failed.threadId ? failed : entry,
          ),
        },
      }));
    }
    case "auxiliary.report": {
      const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === command.threadId);
      if (!auxiliary) return fail("assignment-not-found");
      if (actor.kind !== "thread" || actor.threadId !== auxiliary.threadId)
        return fail("permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === auxiliary.assignmentId);
      const incident = assignment?.oversight?.recovery.incident;
      if (
        !assignment ||
        !activeAssignment(assignment) ||
        (auxiliary.status !== "running" &&
          !(auxiliary.status === "pending" && auxiliary.qualification !== undefined)) ||
        !incident ||
        incident.id !== auxiliary.incidentId ||
        incident.phase !== "diagnosing" ||
        incident.diagnosisThreadId !== auxiliary.threadId ||
        command.evidence.length === 0
      )
        return fail("invalid-state");
      return saveAuxiliary(
        {
          ...auxiliary,
          status: "complete",
          findings: { summary: command.summary, evidence: command.evidence },
        },
        [
          notify(
            assignment,
            `diagnosed:${incident.id}`,
            `Independent diagnosis ${auxiliary.threadId} is complete: ${command.summary}\nEvidence: ${command.evidence.map((entry) => `${entry.label}: ${entry.location}`).join("; ")}\nReplan within the original scope and grants, or escalate the decision.`,
          ),
        ],
        {
          assignments: state.assignments.map((entry) =>
            entry.id === assignment.id
              ? {
                  ...assignment,
                  oversight: {
                    ...assignment.oversight!,
                    recovery: {
                      ...assignment.oversight!.recovery,
                      incident: { ...incident, phase: "replanning" },
                    },
                  },
                  updatedAt: now,
                }
              : entry,
          ),
        },
      );
    }
    case "assignment.recovery.replan": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (!managerAuthorized(assignment)) return fail("permission-denied");
      const incident = assignment.oversight?.recovery.incident;
      const humanEscalation =
        actor.kind === "human" &&
        incident?.phase === "escalated" &&
        assignment.wait?.kind === "human-decision";
      if (
        !incident ||
        incident.id !== command.incidentId ||
        (!humanEscalation && incident.phase !== "replanning") ||
        factoryRecoveryBlocked(
          state,
          humanEscalation ? { ...assignment, wait: null } : assignment,
        ) !== undefined
      )
        return fail("invalid-state");
      const manager = state.managers.find((entry) => entry.id === assignment.managerId);
      if (!manager) return fail("manager-not-found");
      const oversight = assignment.oversight!;
      const allocation = input.replacementAllocation;
      if (
        command.replaceLead &&
        (!allocation ||
          !approvedModel(assignment, manager, allocation.modelSelection) ||
          state.assignments.some(
            (entry) =>
              entry.threadId === allocation.threadId ||
              entry.previousLeadThreadIds?.includes(allocation.threadId),
          ) ||
          state.auxiliaryThreads.some((entry) => entry.threadId === allocation.threadId) ||
          state.managers.some((entry) => entry.threadId === allocation.threadId))
      )
        return fail("permission-denied");
      const { decisionPending: _, ...retained } = oversight;
      const updatedIncident: FactoryRecoveryIncident = {
        ...incident,
        phase: command.replaceLead ? "replacing" : "continuing",
        plan: command.plan,
        ...(command.replaceLead && allocation
          ? {
              replacementThreadId: allocation.threadId,
              replacementModelSelection: allocation.modelSelection,
            }
          : {}),
      };
      return saveAssignment(
        {
          ...assignment,
          status: command.replaceLead ? "waiting" : "running",
          wait: command.replaceLead
            ? {
                kind: "recovery",
                reason:
                  "Preparing a replacement lead while preserving this assignment's work and limits.",
              }
            : null,
          oversight: {
            ...retained,
            recovery: { ...oversight.recovery, incident: updatedIncident },
          },
        },
        command.replaceLead && allocation
          ? [
              {
                type: "assignment.replace-lead",
                assignmentId: assignment.id,
                incidentId: incident.id,
                previousThreadId: assignment.threadId,
                threadId: allocation.threadId,
                modelSelection: allocation.modelSelection,
              },
            ]
          : [
              continuation(
                assignment,
                incident.id,
                `Independent diagnosis is available in ${incident.diagnosisThreadId ?? "the recorded escalation evidence"}. Continue within the unchanged assignment scope and grants using this plan:\n${command.plan}`,
                incident.id,
                actor.kind === "human" ? undefined : assignment.managerId,
              ),
            ],
      );
    }
    case "assignment.recovery.escalate": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (!managerAuthorized(assignment)) return fail("permission-denied");
      const incident = assignment.oversight?.recovery.incident;
      // While its human decision is open, the manager may replace an escalation, including the
      // host's generic options and recommendation for exhausted recovery.
      const pendingEscalation =
        incident?.phase === "escalated" &&
        assignment.wait?.kind === "human-decision" &&
        assignment.wait.reason === incident.escalation?.failure;
      if (
        !activeAssignment(assignment) ||
        !incident ||
        incident.id !== command.incidentId ||
        factoryRecoveryBlocked(
          state,
          pendingEscalation ? { ...assignment, wait: null } : assignment,
        ) !== undefined ||
        command.escalation.options.length === 0
      )
        return fail("invalid-state");
      return saveAssignment({
        ...assignment,
        status: "waiting",
        wait: { kind: "human-decision", reason: command.escalation.failure },
        oversight: {
          ...assignment.oversight!,
          decisionPending: command.escalation.failure,
          recovery: {
            ...assignment.oversight!.recovery,
            incident: { ...incident, phase: "escalated", escalation: command.escalation },
          },
        },
      });
    }
    case "assignment.replacement.prepared":
    case "assignment.replacement.recorded":
    case "assignment.replacement.failed": {
      if (actor.kind !== "system") return fail("permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      const incident = assignment.oversight?.recovery.incident;
      if (
        !incident ||
        incident.id !== command.incidentId ||
        incident.replacementThreadId !== command.threadId
      )
        return fail("invalid-state");
      if (
        incident.phase === "continuing" &&
        assignment.threadId === command.threadId &&
        command.type !== "assignment.replacement.failed"
      )
        return accept();
      if (incident.phase !== "replacing" || factoryRecoveryBlocked(state, assignment) !== undefined)
        return fail("invalid-state");
      if (command.type === "assignment.replacement.failed")
        return escalation(
          assignment,
          incident,
          `The replacement lead could not be prepared: ${command.reason}`,
        );
      const alreadyPrepared =
        assignment.threadId === command.threadId &&
        assignment.previousLeadThreadIds?.includes(command.previousThreadId);
      if (!alreadyPrepared && assignment.threadId !== command.previousThreadId)
        return fail("invalid-state");
      if (
        alreadyPrepared &&
        (assignment.qualification.status !== "qualified" ||
          assignment.qualification.profileId !== command.qualification.profileId)
      )
        return fail("invalid-state");
      if (command.type === "assignment.replacement.recorded" && !alreadyPrepared)
        return fail("invalid-state");
      const prepared = command.type === "assignment.replacement.prepared";
      const updated: FactoryAssignment = {
        ...assignment,
        previousLeadThreadIds: alreadyPrepared
          ? assignment.previousLeadThreadIds!
          : [...(assignment.previousLeadThreadIds ?? []), assignment.threadId],
        threadId: command.threadId,
        ...(incident.replacementModelSelection === undefined
          ? {}
          : { modelSelection: incident.replacementModelSelection }),
        threadStatus: prepared ? "pending" : "created",
        launchStatus: prepared ? "pending" : "delivered",
        qualification: command.qualification,
        status: prepared ? "waiting" : "running",
        wait: prepared ? assignment.wait : null,
        oversight: {
          ...assignment.oversight!,
          recovery: {
            ...assignment.oversight!.recovery,
            incident: { ...incident, phase: prepared ? "replacing" : "continuing" },
          },
        },
      };
      return saveAssignment(updated);
    }
  }
}
