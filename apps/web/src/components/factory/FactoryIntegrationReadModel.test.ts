import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  ProjectId,
  ThreadId,
  type FactoryAssignment,
  type FactorySnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { factoryIntegrationRecordedEvidence } from "./FactoryIntegrationReadModel";
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

const now = assignment.createdAt;
const paths = {
  readPaths: ["src"],
  testPaths: ["test.js"],
  fixturePaths: [],
  testDirectories: [],
  fixtureDirectories: [],
};
const fixture = (): Parameters<typeof factoryIntegrationRecordedEvidence>[0] => ({
  assignments: [
    {
      ...assignment,
      delivery: {
        currentRevisionId: "revision",
        revisions: [
          {
            id: "revision",
            operationId: "operation",
            selectedPaths: ["src/app.ts"],
            commitMessage: "Feature",
            grantEpoch: 1,
            boundaryId: assignment.grant!.boundaryId,
            workflowRevision: "pin",
            startingSourceId: "source",
            candidateId: "candidate",
            candidateDigest: "digest",
            status: "captured",
            reviews: [],
            createdAt: now,
          },
        ],
        directionHeld: false,
        readiness: [],
        retroFindings: [],
      },
    },
  ],
  integrations: [
    {
      id: "integration",
      assignmentId: FactoryAssignmentId.make("integration-lead"),
      requesterManagerId: assignment.managerId,
      requestIds: ["request"],
      participantAssignmentIds: [assignment.id],
      coordinatorProjectId: assignment.projectId,
      phase: "ready",
      waitReason: null,
      hold: null,
      currentPreparationId: "prepared",
      currentTestArtifactId: "tests",
      createdAt: now,
      updatedAt: now,
    },
  ],
  integrationGrants: [
    {
      id: "grant",
      integrationId: "integration",
      projectId: assignment.projectId,
      ownerManagerId: assignment.managerId,
      participantAssignmentId: assignment.id,
      capabilityId: "capability",
      boundaryId: assignment.grant!.boundaryId,
      paths,
      lifecycle: { phase: "active" },
      authorizingCommandId: CommandId.make("grant"),
      createdAt: now,
    },
  ],
  integrationCapabilities: [
    {
      id: "capability",
      projectId: assignment.projectId,
      boundaryId: assignment.grant!.boundaryId,
      paths,
      coordinator: null,
      qualification: {
        status: "qualified",
        profileId: "profile",
        configurationDigest: "config",
        coordinatorDigest: null,
        checkedAt: now,
      },
      supersededBy: null,
      authorizingCommandId: CommandId.make("capability"),
      createdAt: now,
    },
  ],
  integrationPreparations: [
    {
      id: "prepared",
      integrationId: "integration",
      previousPreparationId: null,
      grantIds: ["grant"],
      lifecycle: {
        phase: "ready",
        profileId: "profile",
        testArtifactId: "tests",
        preparedAt: now,
        manifest: {
          inputDigest: "inputs",
          planIds: [],
          coordinatorCapabilityId: "capability",
          coordinatorDigest: "runner",
          inputs: [
            {
              projectId: assignment.projectId,
              assignmentId: assignment.id,
              leadThreadId: assignment.threadId,
              revisionId: "revision",
              candidateId: "candidate",
              candidateDigest: "digest",
              sourceDigest: "source",
              boundaryId: assignment.grant!.boundaryId,
              grantEpoch: 1,
              integrationGrantId: "grant",
              capabilityId: "capability",
              publication: { kind: "unpublished-candidate" },
            },
          ],
        },
      },
      createdAt: now,
    },
  ],
  integrationTestArtifacts: [
    {
      id: "tests",
      integrationId: "integration",
      preparationId: "prepared",
      digest: "tests-digest",
      projects: [],
      capturedAt: now,
    },
  ],
  integrationVerifications: [
    {
      id: "verification",
      integrationId: "integration",
      preparationId: "prepared",
      inputDigest: "inputs",
      lifecycle: {
        phase: "completed",
        result: "passed",
        testArtifactId: "tests",
        testArtifactDigest: "tests-digest",
        hostArtifactId: "host",
        checks: [],
        completedAt: now,
      },
      createdAt: now,
    },
  ],
  collaborationPlans: [],
});

describe("recorded integration evidence", () => {
  it("separates candidate QA from published proof and marks changed tests or lead authority stale", () => {
    const state = fixture();
    expect(factoryIntegrationRecordedEvidence(state, "integration")).toEqual({
      status: "passed",
      reasons: [],
      published: false,
    });
    const changes: Array<Partial<typeof state>> = [
      {
        assignments: state.assignments.map((entry) => ({
          ...entry,
          threadId: ThreadId.make("new-lead"),
        })),
      },
      {
        assignments: state.assignments.map((entry) => ({
          ...entry,
          grant: { ...entry.grant!, epoch: 2 },
        })),
      },
      {
        integrations: state.integrations.map((entry) => ({
          ...entry,
          currentTestArtifactId: "changed-tests",
        })),
      },
      {
        integrationCapabilities: state.integrationCapabilities.map((entry) => ({
          ...entry,
          supersededBy: "new-capability",
        })),
      },
      {
        integrations: state.integrations.map((entry) => ({
          ...entry,
          phase: "blocked",
          waitReason: "Owner paused",
        })),
      },
    ];
    for (const change of changes)
      expect(
        factoryIntegrationRecordedEvidence({ ...state, ...change }, "integration").status,
      ).toBe("stale");
  });
  it("preserves uncertainty when another project's state is outside the view", () => {
    expect(
      factoryIntegrationRecordedEvidence({ ...fixture(), assignments: [] }, "integration").status,
    ).toBe("unverified");
  });
  it("does not reuse a passing check after a newer agreement", () => {
    const state = fixture();
    const collaborationPlans: FactorySnapshot["collaborationPlans"] = [
      {
        id: "new-plan",
        requestIds: ["request"],
        text: "Changed API",
        changes: { kind: "technical" },
        participants: [],
        acknowledgements: [],
        phase: "agreed",
        createdAt: now,
      },
    ];
    expect(
      factoryIntegrationRecordedEvidence({ ...state, collaborationPlans }, "integration").status,
    ).toBe("stale");
  });
});
