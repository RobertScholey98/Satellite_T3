import {
  FactoryControlId,
  FactoryError,
  MessageId,
  factorySystemManager,
  type FactoryAssignment,
  type FactoryAssignmentId,
  type FactoryCollaborationCondition,
  type FactoryCollaborationDecision,
  type FactoryCollaborationMessage,
  type FactoryCollaborationPlan,
  type FactoryCommandResult,
  type FactoryCrossProjectRequest,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryIncidentRestriction,
  type FactoryManager,
  type FactorySnapshot,
  type FactorySupportingWork,
  type ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { commissionFactoryAssignment } from "./FactoryAssignmentCommission.ts";
import {
  factoryPathWithin,
  factoryProtectedPath,
  factoryRelativePath,
} from "./FactoryBoundaryPaths.ts";
import { resolveManagerPolicy } from "./FactoryPolicy.ts";
import { effectiveFactoryWorkflow } from "./FactoryWorkflow.ts";
import type { FactoryActor, FactoryAllocation, FactoryDecision } from "./FactoryState.ts";

const active = (assignment: FactoryAssignment | undefined): assignment is FactoryAssignment =>
  assignment !== undefined &&
  assignment.outcome === undefined &&
  assignment.status !== "complete" &&
  (assignment.completion === undefined || assignment.completion.phase === "collecting");
const supportOf = (request: FactoryCrossProjectRequest) =>
  request.lifecycle.phase === "accepted" || request.lifecycle.phase === "withdrawn"
    ? request.lifecycle.support
    : null;
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));
// A request lives only as long as the assignment or system investigation that raised it.
const originActive = (state: FactorySnapshot, request: FactoryCrossProjectRequest) => {
  const origin = request.origin;
  return origin.kind === "assignment"
    ? active(state.assignments.find((entry) => entry.id === origin.assignmentId))
    : state.improvementInvestigations.some(
        (entry) => entry.id === origin.investigationId && entry.lifecycle.phase !== "closed",
      );
};

/** Delivered peer messages kept per conversation. Each also lives on in its recipient's thread. */
export const FACTORY_DELIVERED_MESSAGE_RETENTION = 50;

/**
 * Drops the oldest delivered messages of one conversation beyond the retention cap. Pending and
 * failed messages always stay, because delivery, recovery and retry act on them.
 */
export function retainDeliveredMessages<
  M extends { readonly delivery: { readonly phase: string } },
>(messages: readonly M[], inConversation: (message: M) => boolean): readonly M[] {
  const delivered = (message: M) =>
    inConversation(message) && message.delivery.phase === "delivered";
  let excess = messages.filter(delivered).length - FACTORY_DELIVERED_MESSAGE_RETENTION;
  return messages.filter((message) => {
    if (excess <= 0 || !delivered(message)) return true;
    excess -= 1;
    return false;
  });
}

export function factoryRequestParticipants(
  state: FactorySnapshot,
  request: FactoryCrossProjectRequest,
): readonly FactoryAssignment[] {
  if (request.lifecycle.phase !== "accepted") return [];
  const originId = request.origin.kind === "assignment" ? request.origin.assignmentId : undefined;
  const supportId = request.lifecycle.support.assignmentId;
  return state.assignments.filter((entry) => entry.id === originId || entry.id === supportId);
}

export function factoryCollaborationConditionSatisfied(
  state: FactorySnapshot,
  condition: FactoryCollaborationCondition,
): boolean {
  switch (condition.kind) {
    case "assignment-concluded":
      return state.assignments.some(
        (entry) =>
          entry.id === condition.assignmentId &&
          (entry.completion?.phase === "concluded" || entry.status === "complete"),
      );
    case "incident-released":
      return state.incidentRestrictions.some(
        (entry) => entry.id === condition.restrictionId && entry.phase === "released",
      );
    case "human-decision":
      return state.collaborationDecisions.some(
        (entry) => entry.id === condition.decisionId && entry.resolution.phase === "decided",
      );
  }
}

export function factoryRequestReconsiderable(
  state: FactorySnapshot,
  request: FactoryCrossProjectRequest,
): boolean {
  const phase = request.lifecycle;
  return (
    (phase.phase === "deferred" || phase.phase === "declined") &&
    phase.reconsider !== null &&
    factoryCollaborationConditionSatisfied(state, phase.reconsider) &&
    originActive(state, request)
  );
}

export function factoryIncidentBlocked(
  state: FactorySnapshot,
  assignmentId: FactoryAssignmentId,
  activity: FactoryIncidentRestriction["activity"],
  excludingRestrictionId?: string,
): string | undefined {
  const restriction = state.incidentRestrictions.find(
    (entry) =>
      entry.id !== excludingRestrictionId &&
      entry.phase !== "released" &&
      entry.assignmentIds.includes(assignmentId) &&
      (entry.activity === "execution" || entry.activity === activity),
  );
  return restriction ? `Incident restriction ${restriction.id}: ${restriction.reason}` : undefined;
}

const notify = (
  kind: "request" | "plan" | "decision" | "incident",
  id: string,
  eventId: string,
  managerIds: readonly ThreadId[],
  assignments: readonly FactoryAssignmentId[],
  text: string,
): FactoryEffectIntent => ({
  type: "collaboration.notify",
  subject: { kind, id },
  eventId,
  recipientManagerIds: [...new Set(managerIds)],
  recipientAssignmentIds: [...new Set(assignments)],
  text: text.slice(0, 6000),
});
const requestNotice = (
  request: FactoryCrossProjectRequest,
  eventId: string,
  text: string,
): FactoryEffectIntent => {
  const support = supportOf(request);
  return notify(
    "request",
    request.id,
    eventId,
    [request.originManagerId, request.receiverManagerId],
    [
      ...(request.origin.kind === "assignment" ? [request.origin.assignmentId] : []),
      ...(support ? [support.assignmentId] : []),
    ],
    text,
  );
};

export function reconcileFactoryRequestCancellation(
  decision: FactoryDecision,
  now: string,
): FactoryDecision {
  const state = decision.state;
  const effects = [...decision.effects];
  const cancelled = new Set(
    state.assignments.filter((entry) => entry.outcome !== undefined).map((entry) => entry.id),
  );
  const dedicated = new Set(
    state.crossProjectRequests.flatMap((request) => {
      const support = supportOf(request);
      return support?.dedicated ? [support.assignmentId] : [];
    }),
  );
  const withdrawn = (request: FactoryCrossProjectRequest) =>
    request.lifecycle.phase === "withdrawn" ||
    (request.origin.kind === "assignment"
      ? cancelled.has(request.origin.assignmentId)
      : !originActive(state, request));
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignmentId of dedicated) {
      const assignment = state.assignments.find((entry) => entry.id === assignmentId);
      if (cancelled.has(assignmentId) || !active(assignment)) continue;
      const needed =
        state.crossProjectRequests.some(
          (entry) => !withdrawn(entry) && supportOf(entry)?.assignmentId === assignmentId,
        ) ||
        state.dependencies.some(
          (entry) =>
            entry.supportingAssignmentId === assignmentId &&
            !cancelled.has(entry.assignmentId) &&
            active(state.assignments.find((parent) => parent.id === entry.assignmentId)),
        );
      if (needed) continue;
      cancelled.add(assignmentId);
      changed = true;
    }
    // An integration team exists only for its requests; a withdrawn one can never verify again.
    for (const integration of state.integrations) {
      const team = state.assignments.find((entry) => entry.id === integration.assignmentId);
      if (!team || cancelled.has(team.id) || !active(team)) continue;
      if (
        !integration.requestIds.some((id) => {
          const request = state.crossProjectRequests.find((entry) => entry.id === id);
          return !request || withdrawn(request);
        })
      )
        continue;
      cancelled.add(team.id);
      changed = true;
    }
  }
  const controls = new Map(state.controls.map((entry) => [entry.id, entry]));
  const assignments = state.assignments.map((assignment) => {
    if (!cancelled.has(assignment.id) || assignment.outcome !== undefined) return assignment;
    const controlId = FactoryControlId.make(`cancellation:${assignment.id}`);
    if (!controls.has(controlId)) {
      controls.set(controlId, {
        kind: "cancellation",
        id: controlId,
        generation: 1,
        assignmentId: assignment.id,
        managerId: assignment.managerId,
        stop: { status: "pending" },
        requestedAt: now,
        updatedAt: now,
      });
      effects.push({ type: "control.stop", controlId, generation: 1 });
    }
    return {
      ...assignment,
      status: "waiting" as const,
      outcome: { kind: "cancelled" as const, controlId },
      updatedAt: now,
    };
  });
  const requests = state.crossProjectRequests.map((request): FactoryCrossProjectRequest => {
    const lifecycle = request.lifecycle;
    if (
      lifecycle.phase === "accepted" &&
      !withdrawn(request) &&
      assignments.find((entry) => entry.id === lifecycle.support.assignmentId)?.outcome
    ) {
      // The receiver cancelled its support: reopen so it can answer again and the requester knows.
      const next: FactoryCrossProjectRequest = {
        ...request,
        generation: request.generation + 1,
        updatedAt: now,
        lifecycle: { phase: "requested" },
      };
      effects.push(
        requestNotice(
          next,
          `support-cancelled:${next.generation}`,
          `Supporting assignment ${lifecycle.support.assignmentId} for request ${next.id} was cancelled. The request is open again: the receiver may accept it with new support, defer or decline it, and the requester may withdraw it.`,
        ),
      );
      return next;
    }
    const reconsider =
      lifecycle.phase === "deferred" || lifecycle.phase === "declined"
        ? lifecycle.reconsider
        : null;
    if (reconsider?.kind === "assignment-concluded" && !withdrawn(request)) {
      const awaited = assignments.find((entry) => entry.id === reconsider.assignmentId);
      if (!awaited?.outcome) return request;
      // A cancelled assignment never concludes, so the promised reconsideration cannot happen.
      const next: FactoryCrossProjectRequest = {
        ...request,
        generation: request.generation + 1,
        updatedAt: now,
        lifecycle: { phase: "requested" },
      };
      effects.push(
        requestNotice(
          next,
          `reconsider-unmeetable:${next.generation}`,
          `Request ${next.id} was ${lifecycle.phase} until assignment ${reconsider.assignmentId} concluded, but that assignment was cancelled. The request is open again: the receiver may accept, defer or decline it, and the requester may withdraw it.`,
        ),
      );
      return next;
    }
    if (lifecycle.phase === "withdrawn" || !withdrawn(request)) return request;
    const origin = request.origin;
    const source =
      origin.kind === "assignment"
        ? assignments.find((entry) => entry.id === origin.assignmentId)
        : undefined;
    if (origin.kind === "assignment" && !source?.outcome) return request;
    const reason = source
      ? "The originating assignment was cancelled. Preserve its work and await the human reason."
      : "The originating system investigation was closed.";
    const next: FactoryCrossProjectRequest = {
      ...request,
      generation: request.generation + 1,
      updatedAt: now,
      lifecycle: {
        phase: "withdrawn",
        reason,
        support: supportOf(request),
        sourceControlId: source?.outcome?.controlId ?? null,
      },
    };
    effects.push(requestNotice(next, `withdrawn:${next.generation}`, reason));
    return next;
  });
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const control of controls.values()) {
      if (control.kind !== "cancellation" || control.reason !== undefined) continue;
      const causes = requests.filter(
        (request) =>
          request.lifecycle.phase === "withdrawn" &&
          ((request.lifecycle.support?.dedicated &&
            request.lifecycle.support.assignmentId === control.assignmentId) ||
            state.integrations.some(
              (entry) =>
                entry.assignmentId === control.assignmentId &&
                entry.requestIds.includes(request.id),
            )),
      );
      if (!causes.length) continue;
      const reasons = causes.flatMap((request) => {
        if (request.lifecycle.phase !== "withdrawn" || request.lifecycle.sourceControlId === null)
          return [];
        const source = controls.get(request.lifecycle.sourceControlId);
        return source?.kind === "cancellation" && source.reason ? [source.reason] : [];
      });
      if (reasons.length !== causes.length) continue;
      controls.set(control.id, {
        ...control,
        reason: {
          text: [...new Set(reasons.map((entry) => entry.text))].join("\n"),
          recordedAt: now,
        },
        updatedAt: now,
      });
      propagated = true;
    }
  }
  return {
    ...decision,
    state: {
      ...state,
      assignments,
      crossProjectRequests: requests,
      controls: [...controls.values()],
    },
    effects,
  };
}

export function decideFactoryCollaboration(input: {
  readonly state: FactorySnapshot;
  readonly actor: FactoryActor;
  readonly command: FactoryDecisionCommand;
  readonly now: string;
  readonly allocation?: FactoryAllocation;
}): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  if (!command.type.startsWith("collaboration.") && !command.type.startsWith("incident."))
    return undefined;
  const human = actor.kind === "human";
  const host = actor.kind === "system";
  const fail = (detail: string, code: FactoryError["code"] = "permission-denied") =>
    Result.fail(new FactoryError({ code, detail }));
  const accept = (
    changes: Partial<FactorySnapshot> = {},
    result: Omit<FactoryCommandResult, "revision"> = {},
    effects: readonly FactoryEffectIntent[] = [],
  ): Result.Result<FactoryDecision, FactoryError> =>
    Result.succeed({
      state: { ...state, ...changes, revision: state.revision + 1 },
      result: { ...result, revision: state.revision + 1 },
      effects,
    });
  const managerAvailable = (manager: FactoryManager | undefined) =>
    manager?.status === "active" &&
    !state.controls.some(
      (entry) =>
        entry.kind === "project-pause" &&
        entry.status === "active" &&
        manager.role === "project" &&
        entry.projectId === manager.projectId,
    );
  const ownsManager = (managerId: ThreadId) =>
    human ||
    (actor.kind === "thread" &&
      actor.threadId === managerId &&
      managerAvailable(state.managers.find((entry) => entry.id === managerId)));
  const leadAvailable = (assignment: FactoryAssignment) =>
    active(assignment) &&
    factoryIncidentBlocked(state, assignment.id, "execution") === undefined &&
    !state.controls.some(
      (entry) =>
        entry.kind === "project-pause" &&
        entry.status === "active" &&
        entry.projectId === assignment.projectId,
    ) &&
    assignment.wait?.kind !== "authority";
  const ownsLead = (assignment: FactoryAssignment) =>
    human ||
    (actor.kind === "thread" &&
      actor.threadId === assignment.threadId &&
      leadAvailable(assignment));
  const validCondition = (condition: FactoryCollaborationCondition) => {
    switch (condition.kind) {
      case "assignment-concluded":
        // A cancelled assignment never concludes, so it cannot satisfy a condition.
        return state.assignments.some(
          (entry) => entry.id === condition.assignmentId && entry.outcome === undefined,
        );
      case "incident-released":
        return state.incidentRestrictions.some((entry) => entry.id === condition.restrictionId);
      case "human-decision":
        return state.collaborationDecisions.some((entry) => entry.id === condition.decisionId);
    }
  };
  const findRequests = (ids: readonly string[]) =>
    [...new Set(ids)].flatMap((id) => {
      const request = state.crossProjectRequests.find((entry) => entry.id === id);
      return request ? [request] : [];
    });
  const participants = (requests: readonly FactoryCrossProjectRequest[]) => [
    ...new Map(
      requests
        .flatMap((request) => factoryRequestParticipants(state, request))
        .map((entry) => [entry.id, entry]),
    ).values(),
  ];
  const participatingActor = (requests: readonly FactoryCrossProjectRequest[], managers: boolean) =>
    human ||
    requests.every(
      (request) =>
        (managers &&
          (ownsManager(request.originManagerId) || ownsManager(request.receiverManagerId))) ||
        factoryRequestParticipants(state, request).some(ownsLead),
    );
  const planOwners = (requests: readonly FactoryCrossProjectRequest[]) => [
    ...new Set(requests.flatMap((entry) => [entry.originManagerId, entry.receiverManagerId])),
  ];
  // A plan binds the exact leads, scopes and grants it was recorded against.
  const planCurrent = (plan: FactoryCollaborationPlan) =>
    findRequests(plan.requestIds).every((entry) => entry.lifecycle.phase === "accepted") &&
    plan.participants.every((entry) => {
      const current = state.assignments.find((assignment) => assignment.id === entry.assignmentId);
      return (
        active(current) &&
        current.threadId === entry.threadId &&
        current.grant?.epoch === entry.grantEpoch &&
        JSON.stringify(current.scope) === JSON.stringify(entry.scope)
      );
    });
  const saveRequest = (
    request: FactoryCrossProjectRequest,
    effects: readonly FactoryEffectIntent[] = [],
    result: Omit<FactoryCommandResult, "revision"> = {},
  ) =>
    accept(
      {
        crossProjectRequests: state.crossProjectRequests.map((entry) =>
          entry.id === request.id ? request : entry,
        ),
      },
      { requestId: request.id, ...result },
      effects,
    );
  const saveMessage = (
    message: FactoryCollaborationMessage,
    effects: readonly FactoryEffectIntent[] = [],
  ) =>
    accept(
      {
        collaborationMessages: retainDeliveredMessages(
          state.collaborationMessages.map((entry) => (entry.id === message.id ? message : entry)),
          (entry) => entry.requestId === message.requestId,
        ),
      },
      { collaborationMessageId: message.id },
      effects,
    );
  const saveRestriction = (
    restriction: FactoryIncidentRestriction,
    effects: readonly FactoryEffectIntent[] = [],
  ) =>
    accept(
      {
        incidentRestrictions: state.incidentRestrictions.map((entry) =>
          entry.id === restriction.id ? restriction : entry,
        ),
      },
      { restrictionId: restriction.id },
      effects,
    );
  // The owner, its restricted teams, and every peer manager and lead collaborating with them.
  const incidentNotice = (
    restriction: FactoryIncidentRestriction,
    eventId: string,
    text: string,
  ) => {
    const peers = state.crossProjectRequests.flatMap((request) => {
      const members = factoryRequestParticipants(state, request);
      return members.some((member) => restriction.assignmentIds.includes(member.id))
        ? [{ request, members }]
        : [];
    });
    return notify(
      "incident",
      restriction.id,
      eventId,
      [
        restriction.managerId,
        ...peers.flatMap(({ request }) => [request.originManagerId, request.receiverManagerId]),
      ],
      [
        ...restriction.assignmentIds,
        ...peers.flatMap(({ members }) => members.map((member) => member.id)),
      ],
      text,
    );
  };
  switch (command.type) {
    case "collaboration.request.create": {
      const origin = command.origin;
      const assignment =
        origin.kind === "assignment"
          ? state.assignments.find((entry) => entry.id === origin.assignmentId)
          : undefined;
      const originManager =
        origin.kind === "assignment"
          ? state.managers.find((entry) => entry.id === assignment?.managerId)
          : factorySystemManager(state.managers);
      const receiver = state.managers.find((entry) => entry.id === command.receiverManagerId);
      if (
        !originManager ||
        !ownsManager(originManager.id) ||
        !managerAvailable(originManager) ||
        !receiver ||
        receiver.role !== "project" ||
        receiver.status === "retired" ||
        receiver.id === originManager.id
      )
        return fail("Only the source owner can request work from a peer project manager.");
      if (
        (origin.kind === "assignment" && !active(assignment)) ||
        (origin.kind === "investigation" &&
          !state.improvementInvestigations.some(
            (entry) => entry.id === origin.investigationId && entry.lifecycle.phase !== "closed",
          ))
      )
        return fail(
          "Select an active originating assignment or system investigation.",
          "invalid-state",
        );
      if (
        state.crossProjectRequests.some(
          (entry) =>
            entry.lifecycle.phase !== "withdrawn" &&
            entry.receiverManagerId === receiver.id &&
            JSON.stringify(entry.origin) === JSON.stringify(origin) &&
            entry.outcome === command.outcome,
        )
      )
        return fail(
          "This source already has an active request for that outcome.",
          "command-conflict",
        );
      const request: FactoryCrossProjectRequest = {
        id: `request:${command.commandId}`,
        origin,
        originManagerId: originManager.id,
        originThreadId: assignment?.threadId ?? originManager.threadId,
        originalLeadThreadId: assignment?.threadId ?? null,
        receiverManagerId: receiver.id,
        outcome: command.outcome,
        acceptanceConditions: command.acceptanceConditions,
        compatibility: command.compatibility,
        generation: 0,
        lifecycle: { phase: "requested" },
        createdAt: now,
        updatedAt: now,
      };
      return accept(
        { crossProjectRequests: [...state.crossProjectRequests, request] },
        { requestId: request.id },
        [
          requestNotice(
            request,
            "created",
            `Cross-project request ${request.id}: ${request.outcome}\nAcceptance: ${request.acceptanceConditions}\nCompatibility: ${request.compatibility}`,
          ),
        ],
      );
    }
    case "collaboration.request.respond": {
      const request = state.crossProjectRequests.find((entry) => entry.id === command.requestId);
      if (!request || !ownsManager(request.receiverManagerId))
        return fail("Only the receiving manager can decide this request.");
      const origin = request.origin;
      if (request.lifecycle.phase !== "requested" || !originActive(state, request))
        return fail("This request is no longer awaiting a response.", "invalid-state");
      const response = command.response;
      const base = { ...request, generation: request.generation + 1, updatedAt: now };
      if (response.kind !== "accept") {
        if (
          response.reconsider !== null &&
          (!validCondition(response.reconsider) ||
            factoryCollaborationConditionSatisfied(state, response.reconsider))
        )
          return fail("Select an existing reconsideration event.", "invalid-state");
        const next: FactoryCrossProjectRequest = {
          ...base,
          lifecycle:
            response.kind === "defer"
              ? { phase: "deferred", reason: response.reason, reconsider: response.reconsider }
              : {
                  phase: "declined",
                  reason: response.reason,
                  alternative: response.alternative,
                  reconsider: response.reconsider,
                },
        };
        return saveRequest(next, [
          requestNotice(
            next,
            `response:${next.generation}`,
            `${response.kind}: ${response.reason}${response.kind === "decline" ? `\nAlternative: ${response.alternative}` : ""}`,
          ),
        ]);
      }
      const manager = state.managers.find((entry) => entry.id === request.receiverManagerId);
      if (!manager || manager.role !== "project" || !managerAvailable(manager))
        return fail("The receiver cannot commission work while its project is paused.");
      const support = response.support;
      let assignment: FactoryAssignment;
      let dedicated: boolean;
      const effects: FactoryEffectIntent[] = [];
      if (support.kind === "existing") {
        const existing = state.assignments.find((entry) => entry.id === support.assignmentId);
        if (
          !active(existing) ||
          existing.managerId !== manager.id ||
          existing.kind === "onboarding"
        )
          return fail("Only active work owned by the receiver can be shared.");
        assignment = existing;
        dedicated = state.crossProjectRequests.some(
          (entry) => supportOf(entry)?.assignmentId === existing.id && supportOf(entry)?.dedicated,
        );
      } else {
        const boundary = state.boundaries.find((entry) => entry.id === manager.boundaryId);
        const policy = resolveManagerPolicy(state.defaults, manager.overrides);
        const work: FactorySupportingWork = support.work;
        const controls = work.controlPaths ?? [];
        if (
          !boundary ||
          (work.kind === "implementation" && controls.length > 0) ||
          (work.kind === "rule-change" &&
            (!controls.length || (!human && !policy.authorizeRuleWeakening))) ||
          controls.some(
            (path) =>
              !factoryRelativePath(path) ||
              (!boundary.protectedPaths.includes(path) &&
                !boundary.protectedCreatablePaths?.includes(path)),
          ) ||
          work.creatableDirectories.some((path) => !boundary.creatableDirectories.includes(path)) ||
          work.sourcePaths.some(
            (path) =>
              !factoryRelativePath(path) ||
              factoryProtectedPath(path) ||
              boundary.protectedPaths.includes(path) ||
              boundary.protectedCreatablePaths?.includes(path) ||
              (!boundary.writablePaths.includes(path) &&
                !boundary.creatableDirectories.some((directory) =>
                  factoryPathWithin(path, directory),
                )),
          ) ||
          !(work.sourcePaths.length + work.creatableDirectories.length + controls.length)
        )
          return fail(
            "Supporting work must fit the receiver's current project boundary and rule-change authority.",
          );
        const constructed = commissionFactoryAssignment({
          state,
          manager,
          boundary,
          work,
          allocation: input.allocation,
          workflow: effectiveFactoryWorkflow(state, manager),
          policy,
          authorization: human
            ? { kind: "human", commandId: command.commandId }
            : { kind: "manager", commandId: command.commandId, threadId: manager.id },
          controlAuthorizationId: command.commandId,
          now,
        });
        if (Result.isFailure(constructed)) return Result.fail(constructed.failure);
        assignment = constructed.success;
        dedicated = true;
        effects.push({
          type: "assignment.prepare",
          managerId: manager.id,
          assignmentId: assignment.id,
          threadId: assignment.threadId,
          projectId: assignment.projectId,
        });
      }
      if (origin.kind === "assignment" && assignment.id === origin.assignmentId)
        return fail("A request cannot depend on its own assignment.");
      const next: FactoryCrossProjectRequest = {
        ...base,
        lifecycle: {
          phase: "accepted",
          support: { assignmentId: assignment.id, dedicated },
          notifiedConclusionId: null,
        },
      };
      effects.push(
        requestNotice(
          next,
          `accepted:${next.generation}`,
          `Request ${next.id} accepted. Supporting lead ${assignment.threadId} owns assignment ${assignment.id}. Collaborating leads may communicate within the recorded boundaries.`,
        ),
      );
      return accept(
        {
          crossProjectRequests: state.crossProjectRequests.map((entry) =>
            entry.id === next.id ? next : entry,
          ),
          assignments:
            support.kind === "commission" ? [...state.assignments, assignment] : state.assignments,
        },
        { requestId: next.id, assignmentId: assignment.id, managerId: manager.id },
        effects,
      );
    }
    case "collaboration.request.withdraw": {
      const request = state.crossProjectRequests.find((entry) => entry.id === command.requestId);
      if (!request || !ownsManager(request.originManagerId))
        return fail("Only the originating owner can withdraw this request.");
      if (request.lifecycle.phase === "withdrawn") return accept({}, { requestId: request.id });
      const next: FactoryCrossProjectRequest = {
        ...request,
        generation: request.generation + 1,
        updatedAt: now,
        lifecycle: {
          phase: "withdrawn",
          support: supportOf(request),
          sourceControlId: null,
          reason: command.reason,
        },
      };
      return Result.map(
        saveRequest(next, [
          requestNotice(
            next,
            `withdrawn:${next.generation}`,
            `Request withdrawn: ${command.reason}`,
          ),
        ]),
        (value) => reconcileFactoryRequestCancellation(value, now),
      );
    }
    case "collaboration.request.reconsider": {
      const request = state.crossProjectRequests.find((entry) => entry.id === command.requestId);
      // The requester may also ask again; the receiver then answers afresh.
      if (
        !request ||
        (!ownsManager(request.receiverManagerId) &&
          !ownsManager(request.originManagerId) &&
          !(host && factoryRequestReconsiderable(state, request)))
      )
        return fail(
          "Only the requester, the receiver or a satisfied recorded event can reopen the request.",
        );
      if (!["deferred", "declined"].includes(request.lifecycle.phase))
        return fail("This request has no deferred decision.", "invalid-state");
      if (!originActive(state, request))
        return fail("The work that raised this request has ended.", "invalid-state");
      const next: FactoryCrossProjectRequest = {
        ...request,
        generation: request.generation + 1,
        updatedAt: now,
        lifecycle: { phase: "requested" },
      };
      return saveRequest(next, [
        requestNotice(
          next,
          `reconsider:${next.generation}`,
          `Reconsider request ${next.id} against current priorities. Its previous response remains in the event history.`,
        ),
      ]);
    }
    case "collaboration.request.support-concluded": {
      const request = state.crossProjectRequests.find((entry) => entry.id === command.requestId);
      if (!host || !request || request.lifecycle.phase !== "accepted")
        return fail("Only the host reports a support conclusion.");
      const supportId = request.lifecycle.support.assignmentId;
      const support = state.assignments.find((entry) => entry.id === supportId);
      if (
        support?.completion?.phase !== "concluded" ||
        support.completion.conclusion?.id !== command.conclusionId
      )
        return fail("The support conclusion has not been recorded.", "invalid-state");
      if (request.lifecycle.notifiedConclusionId === command.conclusionId) return accept();
      return saveRequest(
        {
          ...request,
          lifecycle: { ...request.lifecycle, notifiedConclusionId: command.conclusionId },
          updatedAt: now,
        },
        [
          requestNotice(
            request,
            `concluded:${command.conclusionId}`,
            `Support assignment ${supportId} concluded with ${support.completion.conclusion.kind}. Its delivery evidence is available. Confirm whether the requested outcome is usable.`,
          ),
        ],
      );
    }
    case "collaboration.message.send": {
      const request = state.crossProjectRequests.find((entry) => entry.id === command.requestId);
      const members = request ? factoryRequestParticipants(state, request) : [];
      const from = members.find((entry) => entry.id === command.fromAssignmentId);
      const to = members.find((entry) => entry.id === command.toAssignmentId);
      if (!from || !to || from.id === to.id || !ownsLead(from) || !active(to))
        return fail("Only current collaborating leads can message their recorded peer.");
      const message: FactoryCollaborationMessage = {
        id: `collaboration-message:${command.commandId}`,
        requestId: command.requestId,
        fromAssignmentId: from.id,
        toAssignmentId: to.id,
        senderThreadId: from.threadId,
        text: command.text,
        createdAt: now,
        delivery: { phase: "pending" },
      };
      return accept(
        { collaborationMessages: [...state.collaborationMessages, message] },
        { collaborationMessageId: message.id },
        [{ type: "collaboration.message.deliver", messageId: message.id }],
      );
    }
    case "collaboration.message.retry": {
      const message = state.collaborationMessages.find((entry) => entry.id === command.messageId);
      const from = state.assignments.find((entry) => entry.id === message?.fromAssignmentId);
      const request = state.crossProjectRequests.find((entry) => entry.id === message?.requestId);
      if (
        !message ||
        !from ||
        !ownsLead(from) ||
        message.delivery.phase !== "failed" ||
        request?.lifecycle.phase !== "accepted"
      )
        return fail("Only the sender can retry a failed active peer message.");
      return saveMessage({ ...message, delivery: { phase: "pending" } }, [
        { type: "collaboration.message.deliver", messageId: message.id },
      ]);
    }
    case "collaboration.message.recorded":
    case "collaboration.message.failed": {
      if (!host) return fail("Only the host records actual peer-message outcomes.");
      const message = state.collaborationMessages.find((entry) => entry.id === command.messageId);
      if (!message) return fail("Message not found.", "invalid-state");
      if (message.delivery.phase === "delivered") return accept();
      if (command.type === "collaboration.message.recorded") {
        const recipient = state.assignments.find((entry) => entry.id === message.toAssignmentId);
        if (
          !recipient ||
          ![recipient.threadId, ...(recipient.previousLeadThreadIds ?? [])].includes(
            command.recipientThreadId,
          )
        )
          return fail("The delivery receipt names another team.", "invalid-state");
        return saveMessage({
          ...message,
          delivery: {
            phase: "delivered",
            recipientThreadId: command.recipientThreadId,
            messageId: command.deliveredMessageId,
            deliveredAt: now,
          },
        });
      }
      return saveMessage({ ...message, delivery: { phase: "failed", reason: command.reason } });
    }
    case "collaboration.plan.propose": {
      const requests = findRequests(command.requestIds);
      const members = participants(requests);
      const changes = command.changes;
      const amendments = changes.kind === "boundary" ? (changes.amendments ?? []) : [];
      // Owning managers may propose commitment changes; technical plans stay with the leads.
      if (
        requests.length !== new Set(command.requestIds).size ||
        requests.some((entry) => entry.lifecycle.phase !== "accepted") ||
        !members.length ||
        !participatingActor(requests, changes.kind === "boundary") ||
        members.some((entry) => !active(entry) || !entry.scope || !entry.grant)
      )
        return fail("Only current leads can record a plan for their accepted collaboration.");
      if (
        amendments.some((entry) => !command.requestIds.includes(entry.requestId)) ||
        new Set(amendments.map((entry) => entry.requestId)).size !== amendments.length
      )
        return fail("Amend each request in this plan at most once.", "invalid-state");
      const owners = planOwners(requests);
      const proposer =
        actor.kind === "thread" && owners.includes(actor.threadId) ? actor.threadId : undefined;
      const plan: FactoryCollaborationPlan = {
        id: `collaboration-plan:${command.commandId}`,
        requestIds: [...new Set(command.requestIds)].sort(),
        text: command.text,
        changes,
        participants: members.map((entry) => ({
          assignmentId: entry.id,
          threadId: entry.threadId,
          scope: entry.scope!,
          grantEpoch: entry.grant!.epoch,
        })),
        acknowledgements: [],
        ...(changes.kind === "boundary"
          ? { approvals: proposer ? [{ managerId: proposer, approvedAt: now }] : [] }
          : {}),
        phase: changes.kind === "technical" ? "proposed" : "escalated",
        createdAt: now,
      };
      return accept(
        {
          collaborationPlans: [
            ...state.collaborationPlans.map((entry) =>
              sameSet(entry.requestIds, plan.requestIds) &&
              entry.phase !== "superseded" &&
              entry.phase !== "declined"
                ? { ...entry, phase: "superseded" as const }
                : entry,
            ),
            plan,
          ],
        },
        { planId: plan.id },
        [
          notify(
            "plan",
            plan.id,
            "proposed",
            changes.kind === "boundary" ? owners : [],
            members.map((entry) => entry.id),
            `${changes.kind === "boundary" ? `Owner decision required: each owning manager or the human approves or declines this plan with collaboration.plan.decide.${amendments.length ? " Approval replaces the named requests' outcome, acceptance and compatibility in place and keeps their supporting work." : ""} Until then the recorded commitments and every assignment boundary stand.` : "A shared technical plan awaits each lead's acknowledgement."}\n${plan.text}`,
          ),
        ],
      );
    }
    case "collaboration.plan.acknowledge": {
      const plan = state.collaborationPlans.find((entry) => entry.id === command.planId);
      const member = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (
        !plan ||
        plan.phase === "superseded" ||
        plan.changes.kind !== "technical" ||
        !member ||
        !ownsLead(member) ||
        !plan.participants.some((entry) => entry.assignmentId === member.id)
      )
        return fail("Only a participating lead can acknowledge the current technical plan.");
      if (!planCurrent(plan))
        return fail("A participant changed. Record a fresh shared plan.", "stale-revision");
      if (
        plan.acknowledgements.some(
          (entry) => entry.assignmentId === member.id && entry.threadId === member.threadId,
        )
      )
        return accept({}, { planId: plan.id });
      const acknowledgements = [
        ...plan.acknowledgements.filter((entry) => entry.assignmentId !== member.id),
        { assignmentId: member.id, threadId: member.threadId, acknowledgedAt: now },
      ];
      const phase = acknowledgements.length === plan.participants.length ? "agreed" : "proposed";
      return accept(
        {
          collaborationPlans: state.collaborationPlans.map((entry) =>
            entry.id === plan.id ? { ...entry, acknowledgements, phase } : entry,
          ),
        },
        { planId: plan.id },
        phase === "agreed"
          ? [
              notify(
                "plan",
                plan.id,
                "agreed",
                [],
                plan.participants.map((entry) => entry.assignmentId),
                `Every affected lead agreed technical plan ${plan.id}. Existing assignment boundaries still apply.`,
              ),
            ]
          : [],
      );
    }
    case "collaboration.plan.decide": {
      const plan = state.collaborationPlans.find((entry) => entry.id === command.planId);
      const requests = plan ? findRequests(plan.requestIds) : [];
      const owners = planOwners(requests);
      const decider = human
        ? null
        : owners.find((managerId) => actor.kind === "thread" && actor.threadId === managerId);
      if (!plan || (decider !== null && (decider === undefined || !ownsManager(decider))))
        return fail("Only an owning manager or the human can decide an escalated plan.");
      if (plan.phase !== "escalated" || plan.changes.kind !== "boundary")
        return fail("This plan is not awaiting an owner decision.", "invalid-state");
      if (!planCurrent(plan))
        return fail("A participant changed. Record a fresh shared plan.", "stale-revision");
      const members = plan.participants.map((entry) => entry.assignmentId);
      const save = (next: FactoryCollaborationPlan, changes: Partial<FactorySnapshot> = {}) => ({
        ...changes,
        collaborationPlans: state.collaborationPlans.map((entry) =>
          entry.id === plan.id ? next : entry,
        ),
      });
      if (command.decision.kind === "decline") {
        const reason = command.decision.reason;
        return accept(
          save({
            ...plan,
            phase: "declined",
            declined: { managerId: decider, reason, declinedAt: now },
          }),
          { planId: plan.id },
          [
            notify(
              "plan",
              plan.id,
              `declined:${command.commandId}`,
              owners,
              members,
              `Plan ${plan.id} was declined: ${reason}\nThe recorded commitments and assignment boundaries are unchanged.`,
            ),
          ],
        );
      }
      const approvals = [
        ...(plan.approvals ?? []).filter((entry) => entry.managerId !== decider),
        { managerId: decider, approvedAt: now },
      ];
      if (
        decider !== null &&
        !owners.every((managerId) => approvals.some((entry) => entry.managerId === managerId))
      )
        return accept(save({ ...plan, approvals }), { planId: plan.id });
      const amendments = plan.changes.amendments ?? [];
      const amended = new Map(amendments.map((entry) => [entry.requestId, entry]));
      return accept(
        save(
          { ...plan, approvals, phase: "agreed" },
          {
            crossProjectRequests: state.crossProjectRequests.map((entry) => {
              const amendment = amended.get(entry.id);
              return amendment
                ? {
                    ...entry,
                    outcome: amendment.outcome,
                    acceptanceConditions: amendment.acceptanceConditions,
                    compatibility: amendment.compatibility,
                    generation: entry.generation + 1,
                    updatedAt: now,
                  }
                : entry;
            }),
          },
        ),
        { planId: plan.id },
        [
          notify(
            "plan",
            plan.id,
            `approved:${command.commandId}`,
            owners,
            members,
            `Plan ${plan.id} was approved.${amendments.length ? " The amended requests now record the new outcome, acceptance and compatibility; their supporting work continues." : ""} Permissions and resource limits change only through each owner's own authorized actions.`,
          ),
        ],
      );
    }
    case "collaboration.decision.raise": {
      const requests = findRequests(command.requestIds);
      if (
        requests.length !== new Set(command.requestIds).size ||
        !participatingActor(requests, true) ||
        new Set(command.options.map((entry) => entry.id)).size !== command.options.length
      )
        return fail("A consolidated decision must concern the caller's recorded collaboration.");
      // Any pending decision that touches these requests is the one consolidated decision.
      const overlapping = state.collaborationDecisions.filter(
        (entry) =>
          entry.resolution.phase === "pending" &&
          entry.requestIds.some((id) => command.requestIds.includes(id)),
      );
      if (overlapping.length > 1)
        return fail(
          "These requests already belong to separate pending decisions. Raise against one of them.",
          "command-conflict",
        );
      const existing = overlapping[0];
      const authorThreadId = actor.kind === "thread" ? actor.threadId : null;
      const kept = (existing?.options ?? []).filter(
        (entry) => entry.authorThreadId !== authorThreadId,
      );
      const options = [
        ...kept,
        ...command.options.flatMap((option) => {
          const clash = kept.find((entry) => entry.id === option.id);
          if (clash?.description === option.description) return [];
          const id = clash ? `${authorThreadId ?? "human"}:${option.id}` : option.id;
          return [{ ...option, id, authorThreadId }];
        }),
      ];
      const requestIds = [
        ...new Set([...(existing?.requestIds ?? []), ...command.requestIds]),
      ].sort();
      if (
        options.length > 30 ||
        new Set(options.map((entry) => entry.id)).size !== options.length ||
        requestIds.length > 30
      )
        return fail("The consolidated decision cannot hold these options.", "invalid-state");
      // The trade-off keeps its first framing; a different framing travels with its author.
      const summary = existing?.summary ?? command.summary;
      const decision: FactoryCollaborationDecision = {
        id: existing?.id ?? `collaboration-decision:${command.commandId}`,
        requestIds,
        revision: command.commandId,
        summary,
        options,
        recommendations: [
          ...(existing?.recommendations ?? []).filter(
            (entry) => entry.authorThreadId !== authorThreadId,
          ),
          {
            authorThreadId,
            text: (command.summary === summary
              ? command.recommendation
              : `${command.summary}\n${command.recommendation}`
            ).slice(0, 6000),
          },
        ],
        resolution: { phase: "pending" },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return accept(
        {
          collaborationDecisions: [
            ...state.collaborationDecisions.filter((entry) => entry.id !== decision.id),
            decision,
          ],
        },
        { decisionId: decision.id },
        [
          notify(
            "decision",
            decision.id,
            decision.revision,
            findRequests(requestIds).flatMap((entry) => [
              entry.originManagerId,
              entry.receiverManagerId,
            ]),
            participants(findRequests(requestIds)).map((entry) => entry.id),
            `One consolidated human decision is required: ${decision.summary}\nUnaffected work may continue. Recommendations do not change permissions.`,
          ),
        ],
      );
    }
    case "collaboration.decision.decide": {
      const decision = state.collaborationDecisions.find(
        (entry) => entry.id === command.decisionId,
      );
      if (!human)
        return fail("Only the human decides a cross-project trade-off beyond delegated authority.");
      if (
        !decision ||
        decision.resolution.phase !== "pending" ||
        decision.revision !== command.revision ||
        !decision.options.some((entry) => entry.id === command.optionId)
      )
        return fail("Review the exact current consolidated proposal.", "stale-revision");
      const requests = findRequests(decision.requestIds);
      return accept(
        {
          collaborationDecisions: state.collaborationDecisions.map((entry) =>
            entry.id === decision.id
              ? {
                  ...entry,
                  resolution: {
                    phase: "decided",
                    optionId: command.optionId,
                    reason: command.reason,
                    commandId: command.commandId,
                    decidedAt: now,
                  },
                  updatedAt: now,
                }
              : entry,
          ),
        },
        { decisionId: decision.id },
        [
          notify(
            "decision",
            decision.id,
            `decided:${command.commandId}`,
            requests.flatMap((entry) => [entry.originManagerId, entry.receiverManagerId]),
            participants(requests).map((entry) => entry.id),
            `Human decision ${decision.id} selected ${command.optionId}: ${command.reason}\nEach owner applies the decision through its existing authorized project actions.`,
          ),
        ],
      );
    }
    case "incident.restrict": {
      const manager = state.managers.find((entry) => entry.id === command.managerId);
      if (!manager || manager.role !== "project" || !ownsManager(manager.id))
        return fail("Only the project owner can restrict its conflicting activity.");
      const members = state.assignments.filter((entry) => command.assignmentIds.includes(entry.id));
      if (
        members.length !== new Set(command.assignmentIds).size ||
        members.some((entry) => entry.managerId !== manager.id || !active(entry)) ||
        !validCondition(command.resumeCondition) ||
        factoryCollaborationConditionSatisfied(state, command.resumeCondition)
      )
        return fail(
          "Name active assignments in this project and a resume condition that has not happened yet.",
        );
      const restriction: FactoryIncidentRestriction = {
        id: `incident:${command.commandId}`,
        managerId: manager.id,
        projectId: manager.projectId,
        assignmentIds: [...new Set(command.assignmentIds)],
        activity: command.activity,
        reason: command.reason,
        resumeCondition: command.resumeCondition,
        phase: "active",
        stop: command.activity === "execution" ? { phase: "pending" } : { phase: "confirmed" },
        resume: null,
        createdAt: now,
        updatedAt: now,
      };
      return accept(
        { incidentRestrictions: [...state.incidentRestrictions, restriction] },
        { restrictionId: restriction.id },
        [
          ...(restriction.activity === "execution"
            ? [
                {
                  type: "incident.stop" as const,
                  restrictionId: restriction.id,
                  assignmentIds: restriction.assignmentIds,
                },
              ]
            : []),
          incidentNotice(
            restriction,
            "restricted",
            `Incident restricts ${restriction.activity}: ${restriction.reason}. Unrelated work remains authorized. Resume condition: ${JSON.stringify(restriction.resumeCondition)}.`,
          ),
        ],
      );
    }
    case "incident.release":
    case "incident.retry": {
      const restriction = state.incidentRestrictions.find(
        (entry) => entry.id === command.restrictionId,
      );
      if (!restriction || !ownsManager(restriction.managerId))
        return fail("Only the incident owner can release or retry its restriction.");
      if (restriction.phase === "released") return accept({}, { restrictionId: restriction.id });
      if (command.type === "incident.retry") {
        if (restriction.phase === "active" && restriction.stop.phase === "failed")
          return saveRestriction({ ...restriction, stop: { phase: "pending" }, updatedAt: now }, [
            {
              type: "incident.stop",
              restrictionId: restriction.id,
              assignmentIds: restriction.assignmentIds,
            },
          ]);
        if (restriction.resume?.phase === "failed")
          return saveRestriction({ ...restriction, resume: { phase: "pending" }, updatedAt: now }, [
            {
              type: "incident.resume",
              restrictionId: restriction.id,
              assignmentIds: restriction.assignmentIds,
            },
          ]);
        return fail("Only a recorded incident enforcement failure can retry.", "invalid-state");
      }
      // A failed stop may still be released: releasing only lifts the restriction.
      if (restriction.stop.phase === "pending")
        return fail(
          "Wait for the affected runtime to stop before releasing its restriction.",
          "invalid-state",
        );
      if (restriction.phase === "releasing") return accept({}, { restrictionId: restriction.id });
      const next: FactoryIncidentRestriction = {
        ...restriction,
        phase: restriction.activity === "execution" ? "releasing" : "released",
        resume: restriction.activity === "execution" ? { phase: "pending" } : null,
        updatedAt: now,
      };
      return saveRestriction(
        next,
        restriction.activity === "execution"
          ? [
              {
                type: "incident.resume",
                restrictionId: restriction.id,
                assignmentIds: restriction.assignmentIds,
              },
            ]
          : [
              incidentNotice(
                restriction,
                "released",
                "The incident restriction was released. Other controls and project permissions still apply.",
              ),
            ],
      );
    }
    case "incident.condition-met": {
      if (!host) return fail("Only the host reports a satisfied resume condition.");
      const restriction = state.incidentRestrictions.find(
        (entry) => entry.id === command.restrictionId,
      );
      if (
        restriction?.phase !== "active" ||
        !factoryCollaborationConditionSatisfied(state, restriction.resumeCondition)
      )
        return fail("This restriction has no satisfied resume condition.", "invalid-state");
      return accept({}, { restrictionId: restriction.id }, [
        notify(
          "incident",
          restriction.id,
          "condition-met",
          [restriction.managerId],
          [],
          `The resume condition for incident restriction ${restriction.id} has been met. The restriction stays in force until you or the human release it.`,
        ),
      ]);
    }
    case "incident.targets.recorded":
    case "incident.stopped":
    case "incident.resumed":
    case "incident.failed": {
      if (!host) return fail("Only the host records physical incident enforcement.");
      const restriction = state.incidentRestrictions.find(
        (entry) => entry.id === command.restrictionId,
      );
      if (!restriction) return fail("Restriction not found.", "invalid-state");
      if (restriction.phase === "released") return accept();
      if (command.type === "incident.targets.recorded") {
        if (restriction.resumeThreadIds !== undefined) return accept();
        return saveRestriction({
          ...restriction,
          resumeThreadIds: [...new Set(command.threadIds)],
          resumeQueues: command.resumeQueues,
          updatedAt: now,
        });
      }
      if (command.type === "incident.stopped")
        return saveRestriction({ ...restriction, stop: { phase: "confirmed" }, updatedAt: now });
      if (command.type === "incident.resumed") {
        if (restriction.phase !== "releasing" || restriction.stop.phase === "pending")
          return fail("This incident is not awaiting runtime resumption.", "invalid-state");
        return saveRestriction(
          { ...restriction, phase: "released", resume: null, updatedAt: now },
          [
            ...(restriction.resumeThreadIds ?? []).map((threadId): FactoryEffectIntent => ({
              type: "thread.deliver",
              kind: "continuation",
              threadId,
              messageId: MessageId.make(`factory-incident:${restriction.id}:${threadId}`),
              text: "The incident restriction was released. Continue only within the current assignment, permissions and remaining controls.",
            })),
            ...(restriction.resumeQueues ?? []).map((queue): FactoryEffectIntent => ({
              type: "incident.queue.resume",
              restrictionId: restriction.id,
              ...queue,
            })),
            incidentNotice(
              restriction,
              "released",
              "The incident restriction was released. Resume only where other controls permit.",
            ),
          ],
        );
      }
      if (
        (command.step === "stop" && restriction.stop.phase === "confirmed") ||
        (command.step === "resume" && restriction.phase !== "releasing")
      )
        return accept();
      return saveRestriction({
        ...restriction,
        ...(command.step === "stop"
          ? { stop: { phase: "failed" as const, reason: command.reason } }
          : { resume: { phase: "failed" as const, reason: command.reason } }),
        updatedAt: now,
      });
    }
    default:
      return undefined;
  }
}
