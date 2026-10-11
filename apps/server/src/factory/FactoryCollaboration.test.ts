import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactoryControlId,
  MessageId,
  ProjectId,
  ThreadId,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryFinding,
  FactorySnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decide, type FactoryActor, type FactoryAllocation } from "./FactoryState.ts";
import { deliveryFixture, deliveryIds, deliveryNow } from "./FactoryDelivery.testkit.ts";
import {
  factoryIncidentBlocked,
  factoryRequestParticipants,
  factoryRequestReconsiderable,
} from "./FactoryCollaboration.ts";
import { initialFactoryCompletion } from "./FactoryRetros.ts";
import { factoryExecutionBlocked } from "./FactoryControls.ts";

const receiverId = ThreadId.make("api-manager");
const receiverProject = ProjectId.make("api-project");
const decodeSnapshot = Schema.decodeUnknownSync(FactorySnapshot);
const human = { kind: "human" } as const;
const host = { kind: "system" } as const;
let sequence = 0;
const id = () => CommandId.make(`collaboration-${++sequence}`);
const actor = (threadId: ThreadId): FactoryActor => ({ kind: "thread", threadId });
const allocation = (): FactoryAllocation => ({
  managerThreadId: receiverId,
  assignmentId: FactoryAssignmentId.make(`api-assignment-${++sequence}`),
  leadThreadId: ThreadId.make(`api-lead-${sequence}`),
});
const fixture = (): FactorySnapshot => {
  const state = deliveryFixture();
  const manager = state.managers[0]!;
  assert.equal(manager.role, "project");
  return {
    ...state,
    managers: [
      ...state.managers,
      {
        ...manager,
        role: "project",
        id: receiverId,
        threadId: receiverId,
        projectId: receiverProject,
        boundaryId: FactoryBoundaryId.make("api-boundary"),
      },
    ],
    boundaries: [
      ...state.boundaries,
      {
        id: FactoryBoundaryId.make("api-boundary"),
        projectId: receiverProject,
        writablePaths: ["src/api.ts"],
        protectedPaths: ["lint.ts"],
        creatableDirectories: [],
        gates: [],
        workflow: manager.workflow,
        profileId: "api-profile",
        sourceRevision: "api-base",
        approvedAt: deliveryNow,
      },
    ],
  };
};
const apply = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  by: FactoryActor = human,
  assigned?: FactoryAllocation,
) =>
  Result.getOrThrow(
    decide({
      state,
      command,
      actor: by,
      now: deliveryNow,
      ...(assigned ? { allocation: assigned } : {}),
    }),
  );
const request = (state = fixture()) =>
  apply(
    state,
    {
      type: "collaboration.request.create",
      commandId: id(),
      origin: { kind: "assignment", assignmentId: deliveryIds.assignment },
      receiverManagerId: receiverId,
      outcome: "Expose the feature API",
      acceptanceConditions: "The frontend can consume the documented response",
      compatibility: "Preserve the existing API",
    },
    actor(deliveryIds.manager),
  );
const work = {
  title: "Implement API",
  kind: "implementation",
  complexity: "standard",
  scope: {
    description: "Expose the feature API",
    completionCondition: "Required PR merges",
    requiresPullRequest: true,
  },
  sourcePaths: ["src/api.ts"],
  creatableDirectories: [],
} as const;
const accept = (state: FactorySnapshot, requestId: string, assigned = allocation()) =>
  apply(
    state,
    {
      type: "collaboration.request.respond",
      commandId: id(),
      requestId,
      response: { kind: "accept", support: { kind: "commission", work } },
    },
    actor(receiverId),
    assigned,
  );

const systemId = ThreadId.make("system-manager");
const withSystemInvestigation = (): FactorySnapshot => {
  const state = fixture();
  const base = state.managers[0]!;
  const finding: FactoryFinding = {
    id: "finding-1",
    assignmentId: deliveryIds.assignment,
    reporterThreadId: deliveryIds.lead,
    problem: "Retries are invisible",
    impact: "Repeated review friction",
    evidence: [{ kind: "thread", threadId: deliveryIds.lead }],
    activeBlocker: false,
    route: {
      suspectedCause: "shared-system",
      uncertainty: "Cause needs investigation",
      owner: { kind: "system-remit" },
      requiredAuthority: "Human review",
      rationale: "Observed in implementation",
    },
    containmentOf: null,
    history: [],
    escalation: null,
    createdAt: deliveryNow,
    updatedAt: deliveryNow,
  };
  const withSystem: FactorySnapshot = {
    ...state,
    managers: [
      ...state.managers,
      {
        id: systemId,
        threadId: systemId,
        role: "system",
        projectId: null,
        workspaceProjectId: deliveryIds.project,
        name: "System",
        overrides: {},
        wait: null,
        modelSelection: base.modelSelection,
        workflow: base.workflow,
        qualification: {
          status: "qualified",
          profileId: "system-profile",
          checkedAt: deliveryNow,
        },
        status: "active",
        threadStatus: "created",
        launchStatus: "delivered",
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
    improvementInvestigations: [
      {
        id: "workflow-investigation",
        title: "Improve retries",
        findingIds: [],
        relatedInvestigationIds: [],
        uncertainty: "",
        assessment: "",
        lifecycle: { phase: "open" },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
  };
  return {
    ...withSystem,
    findings: [finding],
    improvementIntakes: [
      {
        id: "intake-1",
        findingId: finding.id,
        sourceDigest: "finding-digest",
        projectId: deliveryIds.project,
        assignmentId: deliveryIds.assignment,
        origin: "explicit-escalation",
        sampling: { kind: "all" },
        summary: "Retries are invisible",
        queuedAt: deliveryNow,
        delivery: { phase: "queued" },
      },
    ],
  };
};

describe("cross-project collaboration", () => {
  it("does not cancel independently commissioned work when its attached request is withdrawn", () => {
    const opened = request();
    const assignmentId = FactoryAssignmentId.make("independent-api-work");
    const independent = {
      ...opened.state.assignments[0]!,
      id: assignmentId,
      threadId: ThreadId.make("independent-api-lead"),
      managerId: receiverId,
      projectId: receiverProject,
    };
    const attached = apply(
      { ...opened.state, assignments: [...opened.state.assignments, independent] },
      {
        type: "collaboration.request.respond",
        commandId: id(),
        requestId: opened.result.requestId!,
        response: { kind: "accept", support: { kind: "existing", assignmentId } },
      },
      actor(receiverId),
    );
    const withdrawn = apply(attached.state, {
      type: "collaboration.request.withdraw",
      commandId: id(),
      requestId: opened.result.requestId!,
      reason: "No longer needed by the frontend",
    });
    assert.isUndefined(
      withdrawn.state.assignments.find((entry) => entry.id === assignmentId)?.outcome,
    );
    assert.isFalse(withdrawn.effects.some((entry) => entry.type === "control.stop"));
  });

  it("notifies a support conclusion once and requires the actual sealed completion identity", () => {
    const opened = request();
    const assigned = allocation();
    const accepted = accept(opened.state, opened.result.requestId!, assigned);
    const receipt = {
      type: "collaboration.request.support-concluded",
      commandId: id(),
      requestId: opened.result.requestId!,
      conclusionId: "support-completed",
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({ state: accepted.state, actor: host, command: receipt, now: deliveryNow }),
      ),
    );
    const state: FactorySnapshot = {
      ...accepted.state,
      assignments: accepted.state.assignments.map((entry) =>
        entry.id === assigned.assignmentId
          ? {
              ...entry,
              completion: {
                ...initialFactoryCompletion(entry.scope, receiverId),
                phase: "concluded",
                conclusion: {
                  kind: "delivered",
                  id: receipt.conclusionId,
                  evidenceDigest: "sealed-evidence",
                  concludedAt: deliveryNow,
                  planVersion: 1,
                  deliveryIds: ["actual-merged-pr"],
                },
              },
            }
          : entry,
      ),
    };
    const notified = apply(state, receipt, host);
    assert.lengthOf(notified.effects, 1);
    const replayed = apply(notified.state, { ...receipt, commandId: id() }, host);
    assert.lengthOf(replayed.effects, 0);
  });

  it("cannot attach an unrelated request to a shared plan using one legitimate participant", () => {
    const opened = request();
    const accepted = accept(opened.state, opened.result.requestId!);
    const source = accepted.state.assignments[0]!;
    const unrelatedOrigin = {
      ...source,
      id: FactoryAssignmentId.make("unrelated-origin"),
      threadId: ThreadId.make("unrelated-origin-lead"),
    };
    const unrelatedSupport = {
      ...accepted.state.assignments[1]!,
      id: FactoryAssignmentId.make("unrelated-support"),
      threadId: ThreadId.make("unrelated-support-lead"),
    };
    const unrelated = {
      ...accepted.state.crossProjectRequests[0]!,
      id: "unrelated-request",
      origin: { kind: "assignment" as const, assignmentId: unrelatedOrigin.id },
      lifecycle: {
        phase: "accepted" as const,
        support: { assignmentId: unrelatedSupport.id, dedicated: false },
        notifiedConclusionId: null,
      },
    };
    const state = {
      ...accepted.state,
      assignments: [...accepted.state.assignments, unrelatedOrigin, unrelatedSupport],
      crossProjectRequests: [...accepted.state.crossProjectRequests, unrelated],
    };
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: actor(deliveryIds.lead),
          now: deliveryNow,
          command: {
            type: "collaboration.plan.propose",
            commandId: id(),
            requestIds: [opened.result.requestId!, unrelated.id],
            text: "Read unrelated source plans",
            changes: { kind: "technical" },
          },
        }),
      ),
    );
  });
  it("commissions receiver-owned support atomically and retains original and current lead identities", () => {
    const opened = request();
    const requestId = opened.result.requestId!;
    assert.equal(opened.state.crossProjectRequests[0]?.originalLeadThreadId, deliveryIds.lead);
    const assigned = allocation();
    const accepted = accept(opened.state, requestId, assigned);
    const support = accepted.state.assignments.find((entry) => entry.id === assigned.assignmentId)!;
    assert.equal(support.managerId, receiverId);
    assert.equal(support.projectId, receiverProject);
    assert.equal(support.authorization?.kind, "manager");
    assert.deepEqual(
      accepted.effects.map((entry) => entry.type),
      ["assignment.prepare", "collaboration.notify"],
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state: opened.state,
          actor: actor(deliveryIds.manager),
          now: deliveryNow,
          allocation: allocation(),
          command: {
            type: "collaboration.request.respond",
            commandId: id(),
            requestId,
            response: { kind: "accept", support: { kind: "commission", work } },
          },
        }),
      ),
    );
  });
  it("keeps direct messages scoped to current leads and reconciles accepted delivery after withdrawal", () => {
    const opened = request();
    const requestId = opened.result.requestId!;
    const assigned = allocation();
    let state = accept(opened.state, requestId, assigned).state;
    const send = {
      type: "collaboration.message.send",
      commandId: id(),
      requestId,
      fromAssignmentId: deliveryIds.assignment,
      toAssignmentId: assigned.assignmentId,
      text: "Keep the response backwards compatible.",
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: {
            kind: "thread",
            threadId: ThreadId.make("worker"),
            assignmentId: deliveryIds.assignment,
          },
          command: send,
          now: deliveryNow,
        }),
      ),
    );
    const replacement = ThreadId.make("replacement-lead");
    state = {
      ...state,
      assignments: state.assignments.map((entry) =>
        entry.id === deliveryIds.assignment
          ? { ...entry, threadId: replacement, previousLeadThreadIds: [deliveryIds.lead] }
          : entry,
      ),
    };
    assert.equal(
      factoryRequestParticipants(state, state.crossProjectRequests[0]!).find(
        (entry) => entry.id === deliveryIds.assignment,
      )?.threadId,
      replacement,
    );
    assert.equal(state.crossProjectRequests[0]?.originalLeadThreadId, deliveryIds.lead);
    assert.isTrue(
      Result.isFailure(
        decide({ state, actor: actor(deliveryIds.lead), command: send, now: deliveryNow }),
      ),
    );
    const sent = apply(state, send, actor(replacement));
    const messageId = sent.result.collaborationMessageId!;
    state = apply(sent.state, {
      type: "collaboration.request.withdraw",
      commandId: id(),
      requestId,
      reason: "The feature is no longer required.",
    }).state;
    state = apply(
      state,
      {
        type: "collaboration.message.recorded",
        commandId: id(),
        messageId,
        recipientThreadId: assigned.leadThreadId,
        deliveredMessageId: MessageId.make("accepted-peer-message"),
      },
      host,
    ).state;
    state = apply(
      state,
      {
        type: "collaboration.message.failed",
        commandId: id(),
        messageId,
        reason: "Late network failure",
      },
      host,
    ).state;
    assert.equal(state.collaborationMessages[0]?.delivery.phase, "delivered");
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: actor(replacement),
          command: { type: "collaboration.message.retry", commandId: id(), messageId },
          now: deliveryNow,
        }),
      ),
    );
  });

  it("reconsiders a concrete deferred event after restart and rejects an already-satisfied deferral", () => {
    const opened = request();
    const requestId = opened.result.requestId!;
    const deferred = apply(
      opened.state,
      {
        type: "collaboration.request.respond",
        commandId: id(),
        requestId,
        response: {
          kind: "defer",
          reason: "The assigned migration must finish before this endpoint changes.",
          reconsider: { kind: "assignment-concluded", assignmentId: deliveryIds.assignment },
        },
      },
      actor(receiverId),
    );
    assert.isFalse(
      factoryRequestReconsiderable(deferred.state, deferred.state.crossProjectRequests[0]!),
    );
    const command = {
      type: "collaboration.request.reconsider",
      commandId: id(),
      requestId,
    } as const;
    assert.isTrue(
      Result.isFailure(decide({ state: deferred.state, actor: host, command, now: deliveryNow })),
    );
    const other = {
      ...deferred.state.assignments[0]!,
      id: FactoryAssignmentId.make("migration"),
      threadId: ThreadId.make("migration-lead"),
      status: "complete" as const,
    };
    const waiting = {
      ...deferred.state,
      assignments: [...deferred.state.assignments, other],
      crossProjectRequests: deferred.state.crossProjectRequests.map((entry) => ({
        ...entry,
        lifecycle: {
          phase: "deferred" as const,
          reason: "Waiting for migration",
          reconsider: { kind: "assignment-concluded" as const, assignmentId: other.id },
        },
      })),
    };
    const restored = decodeSnapshot(JSON.parse(JSON.stringify(waiting)));
    assert.isTrue(factoryRequestReconsiderable(restored, restored.crossProjectRequests[0]!));
    const reconsidered = apply(restored, command, host);
    assert.equal(reconsidered.state.crossProjectRequests[0]?.lifecycle.phase, "requested");
    assert.lengthOf(reconsidered.effects, 1);
    assert.isTrue(
      Result.isFailure(
        decide({
          state: reconsidered.state,
          actor: actor(receiverId),
          now: deliveryNow,
          command: {
            type: "collaboration.request.respond",
            commandId: id(),
            requestId,
            response: {
              kind: "defer",
              reason: "Already done",
              reconsider: { kind: "assignment-concluded", assignmentId: other.id },
            },
          },
        }),
      ),
    );
  });

  it("requires every lead to acknowledge unchanged technical scope and escalates boundary changes", () => {
    const opened = request();
    const assigned = allocation();
    const requestId = opened.result.requestId!;
    const accepted = accept(opened.state, requestId, assigned);
    const proposed = apply(
      accepted.state,
      {
        type: "collaboration.plan.propose",
        commandId: id(),
        requestIds: [requestId],
        text: "Use the documented response and retain fallback handling.",
        changes: { kind: "technical" },
      },
      actor(deliveryIds.lead),
    );
    const planId = proposed.result.planId!;
    const first = apply(
      proposed.state,
      {
        type: "collaboration.plan.acknowledge",
        commandId: id(),
        planId,
        assignmentId: deliveryIds.assignment,
      },
      actor(deliveryIds.lead),
    );
    assert.equal(first.state.collaborationPlans[0]?.phase, "proposed");
    const changed = {
      ...first.state,
      assignments: first.state.assignments.map((entry) =>
        entry.id === assigned.assignmentId
          ? { ...entry, grant: { ...entry.grant!, epoch: entry.grant!.epoch + 1 } }
          : entry,
      ),
    };
    const acknowledge = {
      type: "collaboration.plan.acknowledge",
      commandId: id(),
      planId,
      assignmentId: assigned.assignmentId,
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({
          state: changed,
          actor: actor(assigned.leadThreadId),
          command: acknowledge,
          now: deliveryNow,
        }),
      ),
    );
    const agreed = apply(first.state, acknowledge, actor(assigned.leadThreadId));
    assert.equal(agreed.state.collaborationPlans[0]?.phase, "agreed");
    const boundary = apply(
      agreed.state,
      {
        type: "collaboration.plan.propose",
        commandId: id(),
        requestIds: [requestId],
        text: "Drop old clients",
        changes: { kind: "boundary", reason: "Changes an existing compatibility commitment" },
      },
      actor(assigned.leadThreadId),
    );
    assert.equal(boundary.state.collaborationPlans.at(-1)?.phase, "escalated");
    assert.deepEqual(boundary.state.assignments, agreed.state.assignments);
    assert.isTrue(
      boundary.effects.some(
        (entry) =>
          entry.type === "collaboration.notify" &&
          entry.recipientManagerIds.includes(receiverId) &&
          entry.recipientManagerIds.includes(deliveryIds.manager),
      ),
    );
  });

  it("consolidates peer recommendations and lets only the human decide the exact revision", () => {
    const opened = request();
    const requestId = opened.result.requestId!;
    const options = [
      { id: "feature-first", description: "Finish feature before migration" },
      { id: "migration-first", description: "Finish migration before feature" },
    ];
    const first = apply(
      opened.state,
      {
        type: "collaboration.decision.raise",
        commandId: id(),
        requestIds: [requestId],
        summary: "Change the agreed priority order",
        options,
        recommendation: "Frontend recommends feature first",
      },
      actor(deliveryIds.manager),
    );
    const second = apply(
      first.state,
      {
        type: "collaboration.decision.raise",
        commandId: id(),
        requestIds: [requestId],
        summary: "Change the agreed priority order",
        options,
        recommendation: "API recommends migration first",
      },
      actor(receiverId),
    );
    assert.lengthOf(second.state.collaborationDecisions, 1);
    const decision = second.state.collaborationDecisions[0]!;
    assert.lengthOf(decision.recommendations, 2);
    const choose = {
      type: "collaboration.decision.decide",
      commandId: id(),
      decisionId: decision.id,
      revision: decision.revision,
      optionId: "migration-first",
      reason: "Migration is the current priority",
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({
          state: second.state,
          actor: actor(receiverId),
          command: choose,
          now: deliveryNow,
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state: second.state,
          actor: human,
          command: { ...choose, revision: first.state.collaborationDecisions[0]!.revision },
          now: deliveryNow,
        }),
      ),
    );
    const decided = apply(second.state, choose);
    assert.equal(decided.state.collaborationDecisions[0]?.resolution.phase, "decided");
    assert.deepEqual(decided.state.assignments, opened.state.assignments);
  });

  it("keeps every manager's options in one decision when request sets overlap", () => {
    const opened = request();
    const first = opened.result.requestId!;
    const another = {
      ...opened.state.assignments[0]!,
      id: FactoryAssignmentId.make("second-feature"),
      threadId: ThreadId.make("second-feature-lead"),
    };
    const second = apply(
      { ...opened.state, assignments: [...opened.state.assignments, another] },
      {
        type: "collaboration.request.create",
        commandId: id(),
        origin: { kind: "assignment", assignmentId: another.id },
        receiverManagerId: receiverId,
        outcome: "Expose the settings API",
        acceptanceConditions: "Settings page reads it",
        compatibility: "Preserve existing clients",
      },
      actor(deliveryIds.manager),
    );
    const raise = (
      state: FactorySnapshot,
      by: ThreadId,
      requestIds: string[],
      summary: string,
      [a, b]: [string, string],
    ) =>
      apply(
        state,
        {
          type: "collaboration.decision.raise",
          commandId: id(),
          requestIds,
          summary,
          options: [
            { id: "option-1", description: a },
            { id: "option-2", description: b },
          ],
          recommendation: `${by} recommendation`,
        },
        actor(by),
      ).state;
    const web = raise(second.state, deliveryIds.manager, [first], "Which ships first?", [
      "Feature first",
      "Migration first",
    ]);
    const api = raise(
      web,
      receiverId,
      [first, second.result.requestId!],
      "API capacity is limited",
      ["Settings first", "Both later"],
    );
    assert.lengthOf(api.collaborationDecisions, 1);
    const merged = api.collaborationDecisions[0]!;
    assert.deepEqual(merged.requestIds, [first, second.result.requestId!].sort());
    assert.equal(merged.summary, "Which ships first?");
    assert.deepEqual(
      merged.options.map((entry) => entry.description),
      ["Feature first", "Migration first", "Settings first", "Both later"],
    );
    assert.equal(new Set(merged.options.map((entry) => entry.id)).size, 4);
    assert.isTrue(
      merged.recommendations.some(
        (entry) =>
          entry.authorThreadId === receiverId && entry.text.startsWith("API capacity is limited"),
      ),
    );
    const revised = raise(api, receiverId, [second.result.requestId!], "Which ships first?", [
      "Settings now",
      "Both later",
    ]);
    assert.lengthOf(revised.collaborationDecisions, 1);
    const decision = revised.collaborationDecisions[0]!;
    assert.deepEqual(
      decision.options.map((entry) => entry.description),
      ["Feature first", "Migration first", "Settings now", "Both later"],
    );
    const decided = apply(revised, {
      type: "collaboration.decision.decide",
      commandId: id(),
      decisionId: decision.id,
      revision: decision.revision,
      optionId: "option-1",
      reason: "The web manager's framing wins",
    });
    assert.equal(
      decided.state.collaborationDecisions[0]?.resolution.phase === "decided" &&
        decided.state.collaborationDecisions[0].resolution.optionId,
      "option-1",
    );
  });

  it("reopens the request and tells the requester when the receiver cancels its support", () => {
    const opened = request();
    const requestId = opened.result.requestId!;
    const assigned = allocation();
    const accepted = accept(opened.state, requestId, assigned);
    const cancelled = apply(accepted.state, {
      type: "assignment.cancel",
      commandId: id(),
      assignmentId: assigned.assignmentId,
    });
    assert.equal(cancelled.state.crossProjectRequests[0]?.lifecycle.phase, "requested");
    assert.isTrue(
      cancelled.effects.some(
        (entry) =>
          entry.type === "collaboration.notify" &&
          entry.recipientManagerIds.includes(deliveryIds.manager) &&
          entry.recipientAssignmentIds.includes(deliveryIds.assignment),
      ),
    );
    const replacement = allocation();
    const reaccepted = accept(cancelled.state, requestId, replacement);
    const lifecycle = reaccepted.state.crossProjectRequests[0]!.lifecycle;
    assert.isTrue(
      lifecycle.phase === "accepted" && lifecycle.support.assignmentId === replacement.assignmentId,
    );
  });

  it("tells collaborating peer managers and leads when an incident restricts and releases", () => {
    const opened = request();
    const assigned = allocation();
    const accepted = accept(opened.state, opened.result.requestId!, assigned);
    const reachesPeers = (effects: readonly FactoryEffectIntent[]) =>
      effects.some(
        (entry) =>
          entry.type === "collaboration.notify" &&
          entry.recipientManagerIds.includes(deliveryIds.manager) &&
          entry.recipientAssignmentIds.includes(deliveryIds.assignment),
      );
    const restricted = apply(
      accepted.state,
      {
        type: "incident.restrict",
        commandId: id(),
        managerId: receiverId,
        assignmentIds: [assigned.assignmentId],
        activity: "delivery",
        reason: "Production incident freezes API delivery",
        resumeCondition: { kind: "assignment-concluded", assignmentId: deliveryIds.assignment },
      },
      actor(receiverId),
    );
    assert.isTrue(reachesPeers(restricted.effects));
    const released = apply(
      restricted.state,
      {
        type: "incident.release",
        commandId: id(),
        restrictionId: restricted.result.restrictionId!,
      },
      actor(receiverId),
    );
    assert.equal(released.state.incidentRestrictions[0]?.phase, "released");
    assert.isTrue(reachesPeers(released.effects));
  });

  it("releases a restriction whose stop failed and resumes its teams", () => {
    const opened = request();
    const assigned = allocation();
    const accepted = accept(opened.state, opened.result.requestId!, assigned);
    const restricted = apply(
      accepted.state,
      {
        type: "incident.restrict",
        commandId: id(),
        managerId: receiverId,
        assignmentIds: [assigned.assignmentId],
        activity: "execution",
        reason: "The test runner conflicts with incident recovery",
        resumeCondition: { kind: "assignment-concluded", assignmentId: deliveryIds.assignment },
      },
      actor(receiverId),
    );
    const restrictionId = restricted.result.restrictionId!;
    const failed = apply(
      restricted.state,
      {
        type: "incident.failed",
        commandId: id(),
        restrictionId,
        step: "stop",
        reason: "The runtime never settled",
      },
      host,
    );
    const released = apply(
      failed.state,
      { type: "incident.release", commandId: id(), restrictionId },
      actor(receiverId),
    );
    assert.equal(released.state.incidentRestrictions[0]?.phase, "releasing");
    const resumed = apply(
      released.state,
      { type: "incident.resumed", commandId: id(), restrictionId },
      host,
    );
    assert.equal(resumed.state.incidentRestrictions[0]?.phase, "released");
    assert.isUndefined(factoryIncidentBlocked(resumed.state, assigned.assignmentId, "execution"));
  });

  it("tells the owner once its resume condition is met and rejects conditions that cannot fire", () => {
    const opened = request();
    const requestId = opened.result.requestId!;
    const assigned = allocation();
    const accepted = accept(opened.state, requestId, assigned);
    const raised = apply(
      accepted.state,
      {
        type: "collaboration.decision.raise",
        commandId: id(),
        requestIds: [requestId],
        summary: "Hold API delivery?",
        options: [
          { id: "hold", description: "Hold" },
          { id: "ship", description: "Ship" },
        ],
        recommendation: "Hold",
      },
      actor(receiverId),
    );
    const decisionId = raised.result.decisionId!;
    const restrict = {
      type: "incident.restrict",
      commandId: id(),
      managerId: receiverId,
      assignmentIds: [assigned.assignmentId],
      activity: "delivery",
      reason: "Production incident",
      resumeCondition: { kind: "human-decision", decisionId },
    } as const;
    const restricted = apply(raised.state, restrict, actor(receiverId));
    const restrictionId = restricted.result.restrictionId!;
    const met = { type: "incident.condition-met", commandId: id(), restrictionId } as const;
    assert.isTrue(
      Result.isFailure(
        decide({ state: restricted.state, actor: host, command: met, now: deliveryNow }),
      ),
    );
    const decided = apply(restricted.state, {
      type: "collaboration.decision.decide",
      commandId: id(),
      decisionId,
      revision: restricted.state.collaborationDecisions[0]!.revision,
      optionId: "ship",
      reason: "Incident resolved",
    });
    const notified = apply(decided.state, met, host);
    assert.equal(notified.state.incidentRestrictions[0]?.phase, "active");
    assert.isTrue(
      notified.effects.some(
        (entry) =>
          entry.type === "collaboration.notify" && entry.recipientManagerIds.includes(receiverId),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state: decided.state,
          actor: actor(receiverId),
          command: { ...restrict, commandId: id() },
          now: deliveryNow,
        }),
      ),
    );
    const cancelledWork = {
      ...accepted.state.assignments[0]!,
      id: FactoryAssignmentId.make("cancelled-work"),
      threadId: ThreadId.make("cancelled-lead"),
      outcome: {
        kind: "cancelled" as const,
        controlId: FactoryControlId.make("cancellation:cancelled-work"),
      },
    };
    const second = request({
      ...fixture(),
      assignments: [...fixture().assignments, cancelledWork],
    });
    assert.isTrue(
      Result.isFailure(
        decide({
          state: second.state,
          actor: actor(receiverId),
          now: deliveryNow,
          command: {
            type: "collaboration.request.respond",
            commandId: id(),
            requestId: second.result.requestId!,
            response: {
              kind: "defer",
              reason: "Waits for work that was cancelled",
              reconsider: { kind: "assignment-concluded", assignmentId: cancelledWork.id },
            },
          },
        }),
      ),
    );
  });

  it("restricts only the owner's conflicting activity and preserves other controls after release", () => {
    const opened = request();
    const assigned = allocation();
    const accepted = accept(opened.state, opened.result.requestId!, assigned);
    const command = {
      type: "incident.restrict",
      commandId: id(),
      managerId: receiverId,
      assignmentIds: [assigned.assignmentId],
      activity: "execution",
      reason: "The test runner conflicts with incident recovery",
      resumeCondition: { kind: "assignment-concluded", assignmentId: deliveryIds.assignment },
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({
          state: accepted.state,
          actor: actor(deliveryIds.manager),
          command,
          now: deliveryNow,
        }),
      ),
    );
    const restricted = apply(accepted.state, command, actor(receiverId));
    const restrictionId = restricted.result.restrictionId!;
    assert.isDefined(factoryIncidentBlocked(restricted.state, assigned.assignmentId, "execution"));
    assert.isUndefined(
      factoryIncidentBlocked(restricted.state, deliveryIds.assignment, "execution"),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state: restricted.state,
          actor: actor(receiverId),
          now: deliveryNow,
          command: { type: "incident.release", commandId: id(), restrictionId },
        }),
      ),
    );
    let state = apply(
      restricted.state,
      {
        type: "incident.targets.recorded",
        commandId: id(),
        restrictionId,
        threadIds: [assigned.leadThreadId],
        resumeQueues: [],
      },
      host,
    ).state;
    state = apply(state, { type: "incident.stopped", commandId: id(), restrictionId }, host).state;
    state = apply(state, {
      type: "project.pause",
      commandId: id(),
      projectId: receiverProject,
    }).state;
    const released = apply(state, { type: "incident.release", commandId: id(), restrictionId });
    assert.equal(released.state.incidentRestrictions[0]?.phase, "releasing");
    const resumed = apply(
      released.state,
      { type: "incident.resumed", commandId: id(), restrictionId },
      host,
    );
    assert.isUndefined(factoryIncidentBlocked(resumed.state, assigned.assignmentId, "execution"));
    assert.equal(
      factoryExecutionBlocked(resumed.state, {
        threadId: assigned.leadThreadId,
        assignmentId: assigned.assignmentId,
        managerId: receiverId,
        projectId: receiverProject,
        ancestorThreadIds: [],
      }),
      "This project's manager and teams are paused.",
    );
    assert.isTrue(
      resumed.effects.some(
        (entry) => entry.type === "thread.deliver" && entry.threadId === assigned.leadThreadId,
      ),
    );
  });

  it("withdraws cancelled sources immediately while preserving support needed by another source", () => {
    const opened = request();
    const assigned = allocation();
    let state = accept(opened.state, opened.result.requestId!, assigned).state;
    const another = {
      ...state.assignments[0]!,
      id: FactoryAssignmentId.make("second-feature"),
      threadId: ThreadId.make("second-feature-lead"),
    };
    state = { ...state, assignments: [...state.assignments, another] };
    const second = apply(
      state,
      {
        type: "collaboration.request.create",
        commandId: id(),
        origin: { kind: "assignment", assignmentId: another.id },
        receiverManagerId: receiverId,
        outcome: "Reuse the feature API",
        acceptanceConditions: "Existing contract fits",
        compatibility: "Preserve existing clients",
      },
      actor(deliveryIds.manager),
    );
    state = apply(
      second.state,
      {
        type: "collaboration.request.respond",
        commandId: id(),
        requestId: second.result.requestId!,
        response: {
          kind: "accept",
          support: { kind: "existing", assignmentId: assigned.assignmentId },
        },
      },
      actor(receiverId),
    ).state;
    state = apply(state, {
      type: "assignment.cancel",
      commandId: id(),
      assignmentId: deliveryIds.assignment,
    }).state;
    assert.equal(state.crossProjectRequests[0]?.lifecycle.phase, "withdrawn");
    assert.isUndefined(
      state.assignments.find((entry) => entry.id === assigned.assignmentId)?.outcome,
    );
    state = decodeSnapshot(JSON.parse(JSON.stringify(state)));
    const cancelled = apply(state, {
      type: "assignment.cancel",
      commandId: id(),
      assignmentId: another.id,
    });
    assert.equal(
      cancelled.state.assignments.find((entry) => entry.id === assigned.assignmentId)?.outcome
        ?.kind,
      "cancelled",
    );
    assert.lengthOf(
      cancelled.effects.filter((entry) => entry.type === "control.stop"),
      2,
    );
    const supportControl = cancelled.state.controls.find(
      (entry) => entry.kind === "cancellation" && entry.assignmentId === assigned.assignmentId,
    );
    assert.isDefined(supportControl);
    assert.isTrue(supportControl?.kind === "cancellation" && supportControl.reason === undefined);
  });

  it("cancels dedicated support without inventing a reason and carries the later human reason", () => {
    const opened = request();
    const assigned = allocation();
    const accepted = accept(opened.state, opened.result.requestId!, assigned);
    let state = apply(accepted.state, {
      type: "assignment.cancel",
      commandId: id(),
      assignmentId: deliveryIds.assignment,
    }).state;
    assert.equal(
      state.assignments.find((entry) => entry.id === assigned.assignmentId)?.outcome?.kind,
      "cancelled",
    );
    const sourceControlId = FactoryControlId.make(`cancellation:${deliveryIds.assignment}`);
    state = apply(
      state,
      { type: "control.stop.recorded", commandId: id(), controlId: sourceControlId, generation: 1 },
      host,
    ).state;
    state = apply(state, {
      type: "assignment.cancellation-reason",
      commandId: id(),
      assignmentId: deliveryIds.assignment,
      reason: "Business plans changed; the implementation was sound.",
    }).state;
    const supportControl = state.controls.find(
      (entry) => entry.kind === "cancellation" && entry.assignmentId === assigned.assignmentId,
    );
    assert.isTrue(
      supportControl?.kind === "cancellation" &&
        supportControl.reason?.text === "Business plans changed; the implementation was sound.",
    );
  });

  it("routes system investigation requests through the application manager without a fake assignment", () => {
    const state = withSystemInvestigation();
    const created = apply(
      state,
      {
        type: "collaboration.request.create",
        commandId: id(),
        origin: { kind: "investigation", investigationId: "workflow-investigation" },
        receiverManagerId: receiverId,
        outcome: "Expose workflow retry events",
        acceptanceConditions: "The host emits durable events",
        compatibility: "Keep current event consumers working",
      },
      actor(systemId),
    );
    assert.equal(created.state.crossProjectRequests[0]?.originManagerId, systemId);
    assert.isNull(created.state.crossProjectRequests[0]?.originalLeadThreadId);
    assert.lengthOf(created.state.assignments, state.assignments.length);
    const assigned = allocation();
    const received = accept(created.state, created.result.requestId!, assigned);
    assert.equal(
      received.state.assignments.find((entry) => entry.id === assigned.assignmentId)?.managerId,
      receiverId,
    );
  });

  it("lets every owning manager approve a boundary plan that amends commitments in place", () => {
    const opened = request();
    const requestId = opened.result.requestId!;
    const assigned = allocation();
    const accepted = accept(opened.state, requestId, assigned);
    const proposed = apply(
      accepted.state,
      {
        type: "collaboration.plan.propose",
        commandId: id(),
        requestIds: [requestId],
        text: "Ship the paginated endpoint and retire the unpaged one later.",
        changes: {
          kind: "boundary",
          reason: "Changes the agreed response and compatibility",
          amendments: [
            {
              requestId,
              outcome: "Expose the paginated feature API",
              acceptanceConditions: "The frontend pages through the documented response",
              compatibility: "Keep the unpaged endpoint for one release",
            },
          ],
        },
      },
      actor(assigned.leadThreadId),
    );
    const planId = proposed.result.planId!;
    const decide_ = (state: FactorySnapshot, by: FactoryActor, kind: "approve" | "decline") =>
      decide({
        state,
        actor: by,
        now: deliveryNow,
        command: {
          type: "collaboration.plan.decide",
          commandId: id(),
          planId,
          decision: kind === "approve" ? { kind } : { kind, reason: "Not this release" },
        },
      });
    assert.isTrue(
      Result.isFailure(decide_(proposed.state, actor(assigned.leadThreadId), "approve")),
    );
    const first = Result.getOrThrow(decide_(proposed.state, actor(receiverId), "approve"));
    assert.equal(first.state.collaborationPlans.at(-1)?.phase, "escalated");
    assert.equal(first.state.crossProjectRequests[0]?.outcome, "Expose the feature API");
    const approved = Result.getOrThrow(decide_(first.state, actor(deliveryIds.manager), "approve"));
    assert.equal(approved.state.collaborationPlans.at(-1)?.phase, "agreed");
    const amended = approved.state.crossProjectRequests[0]!;
    assert.equal(amended.outcome, "Expose the paginated feature API");
    assert.equal(amended.compatibility, "Keep the unpaged endpoint for one release");
    assert.isTrue(
      amended.lifecycle.phase === "accepted" &&
        amended.lifecycle.support.assignmentId === assigned.assignmentId,
    );
    assert.isUndefined(
      approved.state.assignments.find((entry) => entry.id === assigned.assignmentId)?.outcome,
    );
    assert.isFalse(approved.state.controls.some((entry) => entry.kind === "cancellation"));
    const managerPlan = apply(
      approved.state,
      {
        type: "collaboration.plan.propose",
        commandId: id(),
        requestIds: [requestId],
        text: "Double the API team's resource limit.",
        changes: { kind: "boundary", reason: "Changes a resource limit" },
      },
      actor(receiverId),
    );
    assert.deepEqual(
      managerPlan.state.collaborationPlans.at(-1)?.approvals?.map((entry) => entry.managerId),
      [receiverId],
    );
    const declined = Result.getOrThrow(
      decide({
        state: managerPlan.state,
        actor: human,
        now: deliveryNow,
        command: {
          type: "collaboration.plan.decide",
          commandId: id(),
          planId: managerPlan.result.planId!,
          decision: { kind: "decline", reason: "Keep the current limit" },
        },
      }),
    );
    assert.equal(declined.state.collaborationPlans.at(-1)?.phase, "declined");
    assert.deepEqual(declined.state.crossProjectRequests, managerPlan.state.crossProjectRequests);
  });

  it("withdraws a system investigation's requests when it closes and refuses to answer them", () => {
    const state = withSystemInvestigation();
    const created = apply(
      state,
      {
        type: "collaboration.request.create",
        commandId: id(),
        origin: { kind: "investigation", investigationId: "workflow-investigation" },
        receiverManagerId: receiverId,
        outcome: "Expose workflow retry events",
        acceptanceConditions: "The host emits durable events",
        compatibility: "Keep current event consumers working",
      },
      actor(systemId),
    );
    const requestId = created.result.requestId!;
    const assigned = allocation();
    const accepted = accept(created.state, requestId, assigned);
    const closed = apply(accepted.state, {
      type: "investigation.update",
      commandId: id(),
      investigationId: "workflow-investigation",
      findingIds: ["finding-1"],
      relatedInvestigationIds: [],
      uncertainty: "",
      assessment: "Resolved without application changes",
      lifecycle: { phase: "closed", reason: "Resolved without application changes" },
    });
    assert.equal(closed.state.crossProjectRequests[0]?.lifecycle.phase, "withdrawn");
    assert.equal(
      closed.state.assignments.find((entry) => entry.id === assigned.assignmentId)?.outcome?.kind,
      "cancelled",
    );
    assert.isTrue(
      closed.effects.some(
        (entry) => entry.type === "collaboration.notify" && entry.subject.id === requestId,
      ),
    );
    // A closure recorded before this reconciliation existed still blocks answers.
    const stale: FactorySnapshot = {
      ...created.state,
      improvementInvestigations: created.state.improvementInvestigations.map((entry) => ({
        ...entry,
        lifecycle: { phase: "closed" as const, reason: "Done" },
      })),
    };
    const respond = (by: FactoryActor, response: "accept" | "reconsider") =>
      decide({
        state:
          response === "accept"
            ? stale
            : {
                ...stale,
                crossProjectRequests: stale.crossProjectRequests.map((entry) => ({
                  ...entry,
                  lifecycle: {
                    phase: "deferred" as const,
                    reason: "Later",
                    reconsider: { kind: "human-decision" as const, decisionId: "decision" },
                  },
                })),
              },
        actor: by,
        now: deliveryNow,
        allocation: allocation(),
        command:
          response === "accept"
            ? {
                type: "collaboration.request.respond",
                commandId: id(),
                requestId,
                response: { kind: "accept", support: { kind: "commission", work } },
              }
            : { type: "collaboration.request.reconsider", commandId: id(), requestId },
      });
    assert.isTrue(Result.isFailure(respond(actor(receiverId), "accept")));
    assert.isTrue(Result.isFailure(respond(actor(receiverId), "reconsider")));
  });

  it("reopens a deferral whose awaited assignment is cancelled and tells both managers", () => {
    const opened = request();
    const requestId = opened.result.requestId!;
    const awaited = {
      ...opened.state.assignments[0]!,
      id: FactoryAssignmentId.make("migration"),
      threadId: ThreadId.make("migration-lead"),
    };
    const deferred = apply(
      { ...opened.state, assignments: [...opened.state.assignments, awaited] },
      {
        type: "collaboration.request.respond",
        commandId: id(),
        requestId,
        response: {
          kind: "defer",
          reason: "The migration must finish before this endpoint changes.",
          reconsider: { kind: "assignment-concluded", assignmentId: awaited.id },
        },
      },
      actor(receiverId),
    );
    const cancelled = apply(deferred.state, {
      type: "assignment.cancel",
      commandId: id(),
      assignmentId: awaited.id,
    });
    assert.equal(cancelled.state.crossProjectRequests[0]?.lifecycle.phase, "requested");
    assert.isTrue(
      cancelled.effects.some(
        (entry) =>
          entry.type === "collaboration.notify" &&
          entry.subject.id === requestId &&
          entry.recipientManagerIds.includes(receiverId) &&
          entry.recipientManagerIds.includes(deliveryIds.manager),
      ),
    );
  });

  it("lets the requester ask again after a deferral without opening a duplicate request", () => {
    const opened = request();
    const requestId = opened.result.requestId!;
    const deferred = apply(
      opened.state,
      {
        type: "collaboration.request.respond",
        commandId: id(),
        requestId,
        response: {
          kind: "defer",
          reason: "Busy with the release",
          reconsider: { kind: "assignment-concluded", assignmentId: deliveryIds.assignment },
        },
      },
      actor(receiverId),
    );
    const askAgain = {
      type: "collaboration.request.reconsider",
      commandId: id(),
      requestId,
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({
          state: deferred.state,
          actor: actor(deliveryIds.lead),
          command: askAgain,
          now: deliveryNow,
        }),
      ),
    );
    const reopened = apply(deferred.state, askAgain, actor(deliveryIds.manager));
    assert.equal(reopened.state.crossProjectRequests[0]?.lifecycle.phase, "requested");
    assert.lengthOf(reopened.state.crossProjectRequests, 1);
  });
});
