import {
  FactoryAssignment,
  FactoryDependency,
  FactorySnapshot,
  MessageId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  factoryDependencyStatus,
  factoryOversightSummary,
  factoryRecoveryAllowance,
} from "./FactoryOversightReadModel";

const now = "2026-10-10T12:00:00.000Z";
const policy = {
  delivery: "human-approval",
  projectImprovements: "create-tickets",
  sharedWorkflow: "investigate-and-recommend",
  authorizeRuleWeakening: false,
  recoveryCycles: 1,
};
const workflow = { repositoryRoot: "/skills", revision: "pinned" };
const decodeDependency = Schema.decodeSync(FactoryDependency);
const assignment = Schema.decodeUnknownSync(FactoryAssignment)({
  id: "assignment",
  managerId: "manager",
  threadId: "lead",
  projectId: "project",
  kind: "implementation",
  status: "waiting",
  threadStatus: "created",
  launchStatus: "delivered",
  qualification: { status: "qualified", profileId: "profile", checkedAt: now },
  workflow,
  grantedPolicy: policy,
  wait: null,
  report: null,
  createdAt: now,
  updatedAt: now,
  oversight: { recovery: { cyclesUsed: 1, history: [] } },
});
const snapshot = Schema.decodeUnknownSync(FactorySnapshot)({
  revision: 1,
  defaults: policy,
  assignments: [assignment],
  boundaries: [],
  managers: [
    {
      id: "manager",
      threadId: "manager",
      projectId: "project",
      role: "project",
      name: "Manager",
      modelSelection: { instanceId: "codex", model: "approved" },
      workflow,
      overrides: {},
      status: "active",
      threadStatus: "created",
      launchStatus: "delivered",
      wait: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
});
const dependency = decodeDependency({
  id: "dependency",
  assignmentId: assignment.id,
  description: "Need an API report",
  requestedBy: assignment.threadId,
  unblockCondition: {
    kind: "report-delivered",
    recipientThreadId: assignment.threadId,
    requirement: "Document response fields",
  },
  evidence: [],
  state: "approved",
  createdAt: now,
  updatedAt: now,
});
const delivery = {
  kind: "report-delivered" as const,
  id: "delivery-2",
  assignmentId: assignment.id,
  recipientThreadId: assignment.threadId,
  messageId: MessageId.make("report-message"),
  summary: "Response fields delivered",
  evidence: [],
  deliveredAt: now,
};

describe("factory oversight presentation", () => {
  it("does not present work approval as actual delivery or usability", () => {
    expect(factoryDependencyStatus(dependency)).toBe("Approved · awaiting supporting team");
    const delivered = decodeDependency({
      ...dependency,
      delivery: { ...delivery, messageId: "report-message" },
    });
    expect(factoryDependencyStatus(delivered)).toBe("Delivered · usability check needed");
  });

  it("requires the usability result to refer to the current delivery", () => {
    const delivered = decodeDependency({
      ...dependency,
      state: "usable",
      delivery: { ...delivery, messageId: "report-message" },
      usability: { deliveryId: "delivery-1", usable: true, evidence: [], checkedAt: now },
    });
    expect(factoryDependencyStatus(delivered)).toBe("Delivered · usability check needed");
    expect(
      factoryDependencyStatus({
        ...delivered,
        usability: { ...delivered.usability!, deliveryId: "delivery-2", usable: false },
      }),
    ).toBe("Delivered · not usable");
    expect(
      factoryDependencyStatus({
        ...delivered,
        usability: { ...delivered.usability!, deliveryId: "delivery-2" },
      }),
    ).toBe("Usable");
  });

  it("retains spent cycles across increases and applies reductions and manager overrides", () => {
    const raised = { ...snapshot, defaults: { ...snapshot.defaults, recoveryCycles: 5 } };
    expect(factoryRecoveryAllowance(raised, assignment)).toEqual({
      used: 1,
      limit: 1,
      remaining: 0,
    });
    const reduced = { ...raised, defaults: { ...raised.defaults, recoveryCycles: 0 } };
    expect(factoryRecoveryAllowance(reduced, assignment)).toEqual({
      used: 1,
      limit: 0,
      remaining: 0,
    });
    const overridden = {
      ...reduced,
      managers: reduced.managers.map((manager) => ({
        ...manager,
        overrides: { recoveryCycles: 1 },
      })),
    };
    expect(factoryRecoveryAllowance(overridden, assignment)).toEqual({
      used: 1,
      limit: 1,
      remaining: 0,
    });
  });

  it("makes exhaustion visible without hiding the retained human wait", () => {
    const escalated: FactoryAssignment = {
      ...assignment,
      wait: { kind: "human-decision", reason: "Choose the next step" },
      oversight: {
        recovery: {
          cyclesUsed: 1,
          history: [],
          incident: {
            id: "incident",
            phase: "escalated",
            reason: "Recovery did not resolve the issue",
            evidence: [],
          },
        },
      },
    };
    expect(factoryOversightSummary(escalated)).toBe("Recovery needs your decision");
    expect(factoryOversightSummary(assignment)).toBe("Progress and dependencies");
    expect(factoryOversightSummary({ ...assignment, wait: escalated.wait })).toBe(
      "Choose the next step",
    );
  });
});
