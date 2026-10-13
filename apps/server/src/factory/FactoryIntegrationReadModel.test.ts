import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  ProjectId,
  ThreadId,
  type FactorySnapshot,
} from "@t3tools/contracts";
import { deliveryFixture, deliveryNow } from "./FactoryDelivery.testkit.ts";
import { scopeFactoryIntegration } from "./FactoryIntegrationReadModel.ts";

const project = (name: string) => ProjectId.make(name);
const assignment = (name: string) => FactoryAssignmentId.make(name);
const manager = (name: string) => ThreadId.make(`manager-${name}`);
const fixture = (): FactorySnapshot => {
  const state = deliveryFixture();
  const names = ["web", "api", "qa", "unrelated"];
  return {
    ...state,
    managers: names.map((name) => ({
      ...state.managers[0]!,
      role: "project",
      projectId: project(name === "qa" ? "web" : name),
      id: manager(name),
      threadId: manager(name),
    })),
    assignments: names.map((name) => ({
      ...state.assignments[0]!,
      id: assignment(name),
      managerId: manager(name === "qa" ? "web" : name),
      projectId: project(name === "qa" ? "web" : name),
      threadId: ThreadId.make(`lead-${name}`),
    })),
    integrations: ["integration", "unrelated"].map((id) => ({
      id,
      assignmentId: assignment(id === "integration" ? "qa" : "unrelated"),
      requesterManagerId: manager(id === "integration" ? "web" : "unrelated"),
      requestIds: ["request"],
      participantAssignmentIds:
        id === "integration" ? [assignment("web"), assignment("api")] : [assignment("unrelated")],
      coordinatorProjectId: project("web"),
      phase: "ready",
      waitReason: null,
      hold: null,
      currentPreparationId: null,
      currentTestArtifactId: "tests",
      createdAt: deliveryNow,
      updatedAt: deliveryNow,
    })),
    integrationCapabilities: ["web", "api", "unrelated"].map((name) => ({
      id: `cap-${name}`,
      projectId: project(name),
      boundaryId: FactoryBoundaryId.make(name),
      paths: {
        readPaths: ["src"],
        testPaths: ["test.js"],
        fixturePaths: [],
        testDirectories: [],
        fixtureDirectories: [],
      },
      coordinator: null,
      qualification: { status: "pending" },
      supersededBy: null,
      authorizingCommandId: CommandId.make("setup"),
      createdAt: deliveryNow,
    })),
    integrationGrants: ["web", "api", "unrelated"].map((name) => ({
      id: `grant-${name}`,
      integrationId: name === "unrelated" ? "unrelated" : "integration",
      projectId: project(name),
      ownerManagerId: manager(name),
      participantAssignmentId: assignment(name),
      capabilityId: `cap-${name}`,
      boundaryId: FactoryBoundaryId.make(name),
      paths: {
        readPaths: ["src"],
        testPaths: ["test.js"],
        fixturePaths: [],
        testDirectories: [],
        fixtureDirectories: [],
      },
      lifecycle: { phase: "active" },
      authorizingCommandId: CommandId.make("grant"),
      createdAt: deliveryNow,
    })),
    integrationPreparations: [
      {
        id: "preparation",
        integrationId: "integration",
        previousPreparationId: null,
        grantIds: ["grant-web", "grant-api"],
        lifecycle: { phase: "requested" },
        resumeThreadIds: [ThreadId.make("private-worker")],
        resumeQueues: [],
        createdAt: deliveryNow,
      },
    ],
    integrationTestArtifacts: [
      {
        id: "tests",
        integrationId: "integration",
        preparationId: "preparation",
        digest: "digest",
        projects: ["web", "api"].map((name) => ({
          projectId: project(name),
          grantId: `grant-${name}`,
          candidateId: name,
          candidateDigest: name,
          sourceDigest: name,
          changedPaths: ["test.js"],
          deletedPaths: [],
          patchArtifactId: `patch-${name}`,
        })),
        capturedAt: deliveryNow,
      },
    ],
    integrationMessages: [
      {
        id: "message",
        integrationId: "integration",
        fromAssignmentId: assignment("qa"),
        toAssignmentId: assignment("api"),
        senderThreadId: ThreadId.make("lead-qa"),
        content: { kind: "message", text: "Check API fixture" },
        delivery: { phase: "pending" },
        createdAt: deliveryNow,
      },
    ],
  };
};

describe("integration read scope", () => {
  it("shows an owning lead only its project patch and never unrelated capability records", () => {
    const scoped = scopeFactoryIntegration(fixture(), {
      kind: "assignment",
      assignmentId: assignment("api"),
      includeLeadCommunication: true,
    });
    assert.deepEqual(
      scoped.integrations.map((entry) => entry.id),
      ["integration"],
    );
    assert.deepEqual(
      scoped.integrationCapabilities.map((entry) => entry.id),
      ["cap-api"],
    );
    assert.deepEqual(
      scoped.integrationTestArtifacts[0]!.projects.map((entry) => entry.patchArtifactId),
      ["patch-api"],
    );
    assert.lengthOf(scoped.integrationMessages, 1);
    assert.notProperty(scoped.integrationPreparations[0]!, "resumeThreadIds");
    assert.notProperty(scoped.integrationPreparations[0]!, "resumeQueues");
  });
  it("gives requester managers and the integration team the participating vector, excluding unrelated groups", () => {
    for (const scope of [
      { kind: "manager", managerId: manager("web") },
      { kind: "assignment", assignmentId: assignment("qa"), includeLeadCommunication: false },
    ] as const) {
      const scoped = scopeFactoryIntegration(fixture(), scope);
      assert.deepEqual(
        scoped.integrations.map((entry) => entry.id),
        ["integration"],
      );
      assert.deepEqual(
        scoped.integrationGrants.map((entry) => entry.id),
        ["grant-web", "grant-api"],
      );
      assert.deepEqual(
        scoped.integrationTestArtifacts[0]!.projects.map((entry) => entry.patchArtifactId),
        ["patch-web", "patch-api"],
      );
      if (scope.kind === "assignment") assert.isEmpty(scoped.integrationMessages);
    }
  });
  it("keeps revoked evidence inspectable without widening the owning project's scope", () => {
    const state = fixture();
    const scoped = scopeFactoryIntegration(
      {
        ...state,
        integrationGrants: state.integrationGrants.map((entry) => ({
          ...entry,
          lifecycle: {
            phase: "revoked",
            reason: "Withdrawn",
            commandId: CommandId.make("revoke"),
            revokedAt: deliveryNow,
          },
        })),
      },
      { kind: "project", projectId: project("api") },
    );
    assert.deepEqual(
      scoped.integrationGrants.map((entry) => entry.id),
      ["grant-api"],
    );
    assert.deepEqual(
      scoped.integrationTestArtifacts[0]!.projects.map((entry) => entry.projectId),
      [project("api")],
    );
  });
  it("omits captured user queue contents from holds and inherited refresh targets", () => {
    const state = fixture();
    const scoped = scopeFactoryIntegration(
      {
        ...state,
        integrations: state.integrations.map((entry) => ({
          ...entry,
          hold: {
            id: "hold",
            preparationId: null,
            status: "confirmed",
            reason: "Paused",
            resumeThreadIds: [ThreadId.make("private")],
            resumeQueues: [],
          },
        })),
        integrationPreparations: state.integrationPreparations.map((entry) => ({
          ...entry,
          inheritedResumeThreadIds: [ThreadId.make("private")],
          inheritedResumeQueues: [],
        })),
      },
      { kind: "project", projectId: project("api") },
    );
    assert.notProperty(scoped.integrations[0]!.hold!, "resumeThreadIds");
    assert.notProperty(scoped.integrations[0]!.hold!, "resumeQueues");
    assert.notProperty(scoped.integrationPreparations[0]!, "inheritedResumeThreadIds");
    assert.notProperty(scoped.integrationPreparations[0]!, "inheritedResumeQueues");
  });
});
