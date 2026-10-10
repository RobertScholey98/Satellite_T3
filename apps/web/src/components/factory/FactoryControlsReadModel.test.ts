import {
  EnvironmentId,
  FactoryAssignmentId,
  FactoryControlId,
  FactorySnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type FactoryControl,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  factoryAssignmentCancellation,
  factoryAssignmentStatus,
  factoryManagerPause,
  factoryPauseStatus,
  factoryProjectPause,
  factoryThreadMembership,
} from "./FactoryControlsReadModel";

const environmentId = EnvironmentId.make("owner");
const projectId = ProjectId.make("project");
const managerId = ThreadId.make("manager");
const leadId = ThreadId.make("lead");
const now = "2026-10-10T12:00:00.000Z";
const policy = {
  delivery: "human-approval",
  projectImprovements: "create-tickets",
  sharedWorkflow: "investigate-and-recommend",
  authorizeRuleWeakening: false,
  recoveryCycles: 1,
} as const;
const workflow = { repositoryRoot: "/skills", revision: "pinned" };
const assignment: FactoryAssignment = {
  id: FactoryAssignmentId.make("assignment"),
  managerId,
  threadId: leadId,
  projectId,
  kind: "implementation",
  status: "running",
  threadStatus: "created",
  launchStatus: "delivered",
  qualification: { status: "qualified", profileId: "profile", checkedAt: now },
  workflow,
  grantedPolicy: policy,
  wait: { kind: "human-decision", reason: "Approve the proposed flow." },
  report: null,
  createdAt: now,
  updatedAt: now,
};
const initial: FactorySnapshot = {
  revision: 4,
  defaults: policy,
  managers: [
    {
      id: managerId,
      threadId: managerId,
      projectId,
      role: "project",
      name: "Web manager",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" },
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
  assignments: [assignment],
  boundaries: [],
  controls: [],
  guidance: [],
  dependencies: [],
  auxiliaryThreads: [],
  mergeRules: [],
  previewConfigurations: [],
  previewPublicationPolicies: [],
  retros: [],
  findings: [],
  followups: [],
  projectTrackers: [],
};
const thread = (
  id: string,
  parent: string | null = null,
  owner = environmentId,
  project = projectId,
) => ({
  id: ThreadId.make(id),
  environmentId: owner,
  projectId: project,
  lineage: {
    parentThreadId: parent === null ? null : ThreadId.make(parent),
    relationshipToParent: parent === null ? null : ("subagent" as const),
    rootThreadId: leadId,
  },
});
const controlFields = { generation: 1, requestedAt: now, updatedAt: now };
const cancellation: Extract<FactoryControl, { kind: "cancellation" }> = {
  ...controlFields,
  id: FactoryControlId.make("cancel"),
  kind: "cancellation",
  assignmentId: assignment.id,
  managerId,
  stop: { status: "pending" },
};
const decodeSnapshot = Schema.decodeUnknownSync(FactorySnapshot);

describe("factory thread controls", () => {
  it("shows managed controls for independent reviewers and retains their lead ancestry", () => {
    const reviewer = ThreadId.make("reviewer");
    const state: FactorySnapshot = {
      ...initial,
      auxiliaryThreads: [
        {
          threadId: reviewer,
          assignmentId: assignment.id,
          managerId,
          projectId,
          kind: "delivery-review",
          incidentId: "review",
          revisionId: "revision",
          cycle: 0,
          status: "running",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" },
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const member = factoryThreadMembership(state, { environmentId, threadId: reviewer }, [
      thread("reviewer"),
    ]);
    expect(member?.assignment?.id).toBe(assignment.id);
    expect(member?.auxiliary?.kind).toBe("delivery-review");
    expect(member?.ancestorThreadIds).toEqual([leadId]);
    expect(
      factoryThreadMembership(state, { environmentId, threadId: reviewer }, [
        thread("reviewer", null, environmentId, ProjectId.make("foreign")),
      ]),
    ).toBeNull();
  });
  it("resolves nested app workers to their assignment and preserves ordinary threads", () => {
    const roster = [
      thread("manager"),
      thread("lead"),
      thread("worker", "lead"),
      thread("nested", "worker"),
      thread("ordinary"),
    ];
    const member = factoryThreadMembership(
      initial,
      { environmentId, threadId: ThreadId.make("nested") },
      roster,
    );
    expect(member?.assignment?.id).toBe(assignment.id);
    expect(member?.manager.id).toBe(managerId);
    expect(member?.ancestorThreadIds).toEqual([ThreadId.make("worker"), leadId]);
    expect(
      factoryThreadMembership(
        initial,
        { environmentId, threadId: ThreadId.make("ordinary") },
        roster,
      ),
    ).toBeNull();
  });

  it("does not resolve a missing parent through another environment, a different project, or a cycle", () => {
    const requested = { environmentId, threadId: ThreadId.make("worker") };
    expect(
      factoryThreadMembership(initial, requested, [
        thread("worker", "lead"),
        thread("lead", null, EnvironmentId.make("other")),
      ]),
    ).toBeNull();
    expect(
      factoryThreadMembership(initial, requested, [
        thread("worker", "lead"),
        thread("lead", null, environmentId, ProjectId.make("other")),
      ]),
    ).toBeNull();
    expect(
      factoryThreadMembership(initial, requested, [
        thread("worker", "nested"),
        thread("nested", "worker"),
      ]),
    ).toBeNull();
  });

  it("restores cancellation truth independently of the assignment's former running state", () => {
    const restored = (control: FactoryControl) =>
      decodeSnapshot(JSON.parse(JSON.stringify({ ...initial, controls: [control] })));
    expect(factoryAssignmentStatus(restored(cancellation), assignment)).toBe(
      "Cancelling · stopping team",
    );
    expect(
      factoryAssignmentStatus(
        restored({
          ...cancellation,
          stop: { status: "failed", detail: "Provider is still active." },
        }),
        assignment,
      ),
    ).toBe("Cancellation · stop failed");
    const confirmed = restored({ ...cancellation, stop: { status: "confirmed", stoppedAt: now } });
    expect(factoryAssignmentStatus(confirmed, assignment)).toBe("Cancelled · reason needed");
    expect(factoryAssignmentCancellation(confirmed, assignment)?.reason).toBeUndefined();
    expect(confirmed.assignments[0]?.wait).toEqual(assignment.wait);
    expect(
      factoryAssignmentStatus(
        restored({
          ...cancellation,
          stop: { status: "confirmed", stoppedAt: now },
          reason: { text: "Priorities changed.", recordedAt: now },
        }),
        assignment,
      ),
    ).toBe("Cancelled");
  });

  it("keeps manager and project pauses independent and never calls a pending stop paused", () => {
    const managerPause: FactoryControl = {
      ...controlFields,
      id: FactoryControlId.make("manager-pause"),
      kind: "manager-pause",
      managerId,
      priorStatus: "active",
      status: "active",
      stop: { status: "confirmed", stoppedAt: now },
    };
    const projectPause: FactoryControl = {
      ...controlFields,
      id: FactoryControlId.make("project-pause"),
      kind: "project-pause",
      projectId,
      status: "active",
      stop: { status: "pending" },
    };
    const snapshot = { ...initial, controls: [managerPause, projectPause] };
    expect(factoryManagerPause(snapshot, managerId)?.id).toBe(managerPause.id);
    expect(factoryPauseStatus(projectPause)).toBe("Stopping");
    expect(factoryAssignmentStatus(snapshot, assignment)).toBe("Project: Stopping");
    const projectResumed = {
      ...snapshot,
      controls: [managerPause, { ...projectPause, status: "released" as const }],
    };
    expect(factoryProjectPause(projectResumed, projectId)).toBeUndefined();
    expect(factoryManagerPause(projectResumed, managerId)?.id).toBe(managerPause.id);
    expect(factoryAssignmentStatus(projectResumed, assignment)).toBe("Working");
    expect(snapshot.assignments[0]?.wait).toEqual(assignment.wait);
  });
});
