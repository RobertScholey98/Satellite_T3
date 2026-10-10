import {
  FactoryAssignmentId,
  FactoryBoundaryId,
  ProjectId,
  ThreadId,
  type FactoryAssignment,
  type FactoryCollaborationPlan,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { factoryCollaborationPlanStatus } from "./FactoryCollaborationReadModel";

const assignment: FactoryAssignment = {
  id: FactoryAssignmentId.make("web"),
  managerId: ThreadId.make("web-manager"),
  threadId: ThreadId.make("web-lead"),
  projectId: ProjectId.make("web"),
  kind: "implementation",
  status: "running",
  threadStatus: "created",
  launchStatus: "delivered",
  scope: {
    description: "Use existing API",
    completionCondition: "Works with existing callers",
    requiresPullRequest: true,
  },
  qualification: { status: "qualified", profileId: "profile", checkedAt: "2026-10-10T12:00:00Z" },
  workflow: { repositoryRoot: "C:/skills", revision: "pin" },
  grantedPolicy: {
    delivery: "human-approval",
    projectImprovements: "create-tickets",
    sharedWorkflow: "investigate-and-recommend",
    authorizeRuleWeakening: false,
    recoveryCycles: 1,
  },
  grant: {
    boundaryId: FactoryBoundaryId.make("boundary"),
    epoch: 1,
    sourcePaths: ["src/app.ts"],
    creatableDirectories: [],
    controlChange: null,
  },
  wait: null,
  report: null,
  createdAt: "2026-10-10T12:00:00Z",
  updatedAt: "2026-10-10T12:00:00Z",
};
const plan: FactoryCollaborationPlan = {
  id: "plan",
  requestIds: ["request"],
  text: "Use existing API",
  changes: { kind: "technical" },
  participants: [
    {
      assignmentId: assignment.id,
      threadId: assignment.threadId,
      scope: assignment.scope!,
      grantEpoch: 1,
    },
  ],
  acknowledgements: [
    {
      assignmentId: assignment.id,
      threadId: assignment.threadId,
      acknowledgedAt: assignment.updatedAt,
    },
  ],
  phase: "agreed",
  createdAt: assignment.createdAt,
};
describe("shared technical plan status", () => {
  it("shows an agreed plan only while its lead, scope and grants still match", () => {
    expect(factoryCollaborationPlanStatus({ assignments: [assignment] }, plan)).toBe("agreed");
    for (const changed of [
      { ...assignment, threadId: ThreadId.make("replacement-lead") },
      { ...assignment, grant: { ...assignment.grant!, epoch: 2 } },
      { ...assignment, scope: { ...assignment.scope!, description: "Change public API" } },
    ])
      expect(factoryCollaborationPlanStatus({ assignments: [changed] }, plan)).toBe("stale");
  });
  it("does not infer current agreement from a partial project snapshot", () => {
    expect(factoryCollaborationPlanStatus({ assignments: [] }, plan)).toBe("unverified");
    expect(
      factoryCollaborationPlanStatus({ assignments: [] }, { ...plan, phase: "superseded" }),
    ).toBe("superseded");
  });
});
