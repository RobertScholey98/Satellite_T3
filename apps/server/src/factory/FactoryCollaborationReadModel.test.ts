import { assert, describe, it } from "@effect/vitest";
import {
  FactoryAssignmentId,
  ProjectId,
  ThreadId,
  type FactoryCrossProjectRequest,
  type FactorySnapshot,
} from "@t3tools/contracts";
import { deliveryFixture, deliveryNow } from "./FactoryDelivery.testkit.ts";
import { scopeFactoryCollaboration } from "./FactoryCollaborationReadModel.ts";

const ids = (name: string) => ({
  assignmentId: FactoryAssignmentId.make(name),
  projectId: ProjectId.make(name),
  managerId: ThreadId.make(`manager-${name}`),
  threadId: ThreadId.make(`lead-${name}`),
});
const request = (from: string, to: string): FactoryCrossProjectRequest => ({
  id: `${from}-${to}`,
  origin: { kind: "assignment", assignmentId: ids(from).assignmentId },
  originManagerId: ids(from).managerId,
  originThreadId: ids(from).threadId,
  originalLeadThreadId: ids(from).threadId,
  receiverManagerId: ids(to).managerId,
  outcome: "Implement shared capability",
  acceptanceConditions: "Both callers work",
  compatibility: "Existing clients keep working",
  generation: 1,
  lifecycle: {
    phase: "accepted",
    notifiedConclusionId: null,
    support: { assignmentId: ids(to).assignmentId, dedicated: true },
  },
  createdAt: deliveryNow,
  updatedAt: deliveryNow,
});
const fixture = (): FactorySnapshot => {
  const initial = deliveryFixture();
  const manager = initial.managers[0]!;
  if (manager.role !== "project") throw new Error("Expected the project fixture");
  const assignments = ["web", "api", "billing", "storage"].map((name) => ({
    ...initial.assignments[0]!,
    id: ids(name).assignmentId,
    ...ids(name),
  }));
  return {
    ...initial,
    assignments,
    managers: ["web", "api", "billing", "storage"].map((name) => ({
      ...manager,
      id: ids(name).managerId,
      threadId: ids(name).managerId,
      projectId: ids(name).projectId,
    })),
    crossProjectRequests: [request("web", "api"), request("billing", "storage")],
    collaborationMessages: [request("web", "api"), request("billing", "storage")].map((entry) => ({
      id: `message-${entry.id}`,
      requestId: entry.id,
      fromAssignmentId:
        entry.origin.kind === "assignment" ? entry.origin.assignmentId : ids("web").assignmentId,
      toAssignmentId:
        entry.lifecycle.phase === "accepted"
          ? entry.lifecycle.support.assignmentId
          : ids("api").assignmentId,
      senderThreadId: entry.originThreadId,
      text: `Private ${entry.id}`,
      createdAt: deliveryNow,
      delivery: { phase: "pending" },
    })),
    collaborationPlans: [
      {
        id: "plan",
        requestIds: ["web-api"],
        text: "Use the agreed endpoint",
        changes: { kind: "technical" },
        participants: assignments.slice(0, 2).map((entry) => ({
          assignmentId: entry.id,
          threadId: entry.threadId,
          scope: entry.scope!,
          grantEpoch: entry.grant!.epoch,
        })),
        acknowledgements: [],
        phase: "proposed",
        createdAt: deliveryNow,
      },
    ],
    collaborationDecisions: [
      {
        id: "decision",
        requestIds: ["web-api"],
        revision: "revision",
        summary: "Choose order",
        options: [
          { id: "first", description: "Web first" },
          { id: "second", description: "API first" },
        ],
        recommendations: [],
        resolution: { phase: "pending" },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
    incidentRestrictions: [
      {
        id: "incident",
        managerId: ids("api").managerId,
        projectId: ids("api").projectId,
        assignmentIds: [ids("api").assignmentId, ids("storage").assignmentId],
        activity: "preview",
        reason: "Shared preview host unavailable",
        resumeCondition: { kind: "human-decision", decisionId: "decision" },
        phase: "active",
        stop: { phase: "confirmed" },
        resume: null,
        resumeThreadIds: [ids("api").threadId, ids("storage").threadId],
        resumeQueues: [],
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
  };
};

describe("collaboration read scope", () => {
  it("includes the system manager's origin conversation without exposing unrelated relationships", () => {
    const state = fixture();
    const systemId = ThreadId.make("system-manager");
    const current = state.managers[0]!;
    const scoped = scopeFactoryCollaboration(
      {
        ...state,
        managers: [
          ...state.managers,
          {
            ...current,
            id: systemId,
            threadId: systemId,
            role: "system",
            projectId: null,
            workspaceProjectId: ids("web").projectId,
            qualification: {
              status: "qualified",
              profileId: "system-profile",
              checkedAt: deliveryNow,
            },
          },
        ],
        crossProjectRequests: [
          ...state.crossProjectRequests,
          {
            ...request("web", "api"),
            id: "system-request",
            origin: { kind: "investigation", investigationId: "investigation" },
            originManagerId: systemId,
            originThreadId: systemId,
            originalLeadThreadId: null,
            lifecycle: { phase: "requested" },
          },
        ],
      },
      { kind: "project", projectId: ids("web").projectId },
    );
    assert.deepEqual(
      scoped.crossProjectRequests.map((entry) => entry.id),
      ["web-api", "system-request"],
    );
    assert.deepEqual(
      scoped.collaborationMessages.map((entry) => entry.id),
      ["message-web-api"],
    );
  });
  it("keeps unrelated project requests, messages and incidents out of the project view", () => {
    const result = scopeFactoryCollaboration(fixture(), {
      kind: "project",
      projectId: ids("web").projectId,
    });
    assert.deepEqual(
      result.crossProjectRequests.map((entry) => entry.id),
      ["web-api"],
    );
    assert.deepEqual(
      result.collaborationMessages.map((entry) => entry.id),
      ["message-web-api"],
    );
    assert.deepEqual(
      result.collaborationPlans.map((entry) => entry.id),
      ["plan"],
    );
    assert.deepEqual(
      result.collaborationDecisions.map((entry) => entry.id),
      ["decision"],
    );
    assert.isEmpty(result.incidentRestrictions);
  });
  it("allows both participating current leads their shared records without exposing unrelated teams", () => {
    for (const name of ["web", "api"]) {
      const result = scopeFactoryCollaboration(fixture(), {
        kind: "assignment",
        assignmentId: ids(name).assignmentId,
        includeLeadCommunication: true,
      });
      assert.deepEqual(
        result.crossProjectRequests.map((entry) => entry.id),
        ["web-api"],
      );
      assert.deepEqual(
        result.collaborationMessages.map((entry) => entry.id),
        ["message-web-api"],
      );
      if (name === "api") {
        assert.deepEqual(result.incidentRestrictions[0]?.assignmentIds, [ids("api").assignmentId]);
        assert.notProperty(result.incidentRestrictions[0], "resumeThreadIds");
        assert.notProperty(result.incidentRestrictions[0], "resumeQueues");
      }
    }
  });
  it("keeps peer transcripts and shared-plan snapshots away from descendants", () => {
    const result = scopeFactoryCollaboration(fixture(), {
      kind: "assignment",
      assignmentId: ids("web").assignmentId,
      includeLeadCommunication: false,
    });
    assert.lengthOf(result.crossProjectRequests, 1);
    assert.isEmpty(result.collaborationMessages);
    assert.isEmpty(result.collaborationPlans);
    assert.isEmpty(result.collaborationDecisions);
  });
  it("limits manager reads to owned relationships and preserves withdrawn history", () => {
    const state = fixture();
    const existing = state.crossProjectRequests[0]!;
    const historical = {
      ...state,
      crossProjectRequests: [
        {
          ...existing,
          lifecycle: {
            phase: "withdrawn" as const,
            reason: "Cancelled origin",
            support: { assignmentId: ids("api").assignmentId, dedicated: true },
            sourceControlId: null,
          },
        },
        state.crossProjectRequests[1]!,
      ],
    };
    const result = scopeFactoryCollaboration(historical, {
      kind: "manager",
      managerId: ids("api").managerId,
    });
    assert.deepEqual(
      result.crossProjectRequests.map((entry) => entry.id),
      ["web-api"],
    );
    assert.equal(result.crossProjectRequests[0]?.lifecycle.phase, "withdrawn");
  });
});
