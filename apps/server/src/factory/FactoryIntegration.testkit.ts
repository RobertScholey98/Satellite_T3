import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  ProjectId,
  ThreadId,
  type FactoryDecisionCommand,
  type FactoryIntegrationManifest,
  type FactoryIntegrationPaths,
  type FactoryIntegrationTestArtifact,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decide, type FactoryActor } from "./FactoryState.ts";
import { deliveryFixture, deliveryIds, deliveryNow } from "./FactoryDelivery.testkit.ts";
import { initialFactoryCompletion } from "./FactoryRetros.ts";

export const api = {
  project: ProjectId.make("api"),
  manager: ThreadId.make("api-manager"),
  assignment: FactoryAssignmentId.make("api-work"),
  lead: ThreadId.make("api-lead"),
  boundary: FactoryBoundaryId.make("api-boundary"),
};
export const integrated = {
  assignment: FactoryAssignmentId.make("integration-work"),
  lead: ThreadId.make("integration-lead"),
};
export const human = { kind: "human" } as const;
export const host = { kind: "system" } as const;
export const actor = (threadId: ThreadId): FactoryActor => ({ kind: "thread", threadId });
let sequence = 0;
export const id = () => CommandId.make(`integration-test-${++sequence}`);
export const paths: FactoryIntegrationPaths = {
  readPaths: ["."],
  testPaths: ["test/check.js"],
  fixturePaths: ["fixtures/input.json"],
  testDirectories: ["test/new"],
  fixtureDirectories: ["fixtures/new"],
};
export const run = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  by: FactoryActor = human,
) =>
  decide({
    state,
    command,
    actor: by,
    now: deliveryNow,
    allocation: {
      managerThreadId: deliveryIds.manager,
      assignmentId: integrated.assignment,
      leadThreadId: integrated.lead,
    },
  });
export const apply = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  by: FactoryActor = human,
) => Result.getOrThrow(run(state, command, by));
export const fixture = (): FactorySnapshot => {
  const state = deliveryFixture();
  const manager = state.managers[0]!;
  const base = state.assignments[0]!;
  const participants = [
    base,
    {
      ...base,
      id: api.assignment,
      projectId: api.project,
      managerId: api.manager,
      threadId: api.lead,
      grant: { ...base.grant!, boundaryId: api.boundary },
    },
  ].map((entry) => ({
    ...entry,
    completion: initialFactoryCompletion(entry.scope!),
    delivery: {
      ...entry.delivery!,
      currentRevisionId: `revision-${entry.id}`,
      revisions: [
        {
          id: `revision-${entry.id}`,
          operationId: `capture-${entry.id}`,
          selectedPaths: ["src/feature.ts"],
          commitMessage: "Implement feature",
          grantEpoch: entry.grant!.epoch,
          boundaryId: entry.grant!.boundaryId,
          workflowRevision: "workflow",
          startingSourceId: "source",
          candidateId: `candidate-${entry.id}`,
          candidateDigest: `digest-${entry.id}`,
          status: "captured" as const,
          reviews: [],
          createdAt: deliveryNow,
        },
      ],
    },
  }));
  return {
    ...state,
    assignments: participants,
    managers: [
      manager,
      {
        ...manager,
        role: "project",
        projectId: api.project,
        id: api.manager,
        threadId: api.manager,
        boundaryId: api.boundary,
      },
    ],
    boundaries: [
      { id: deliveryIds.boundary, projectId: deliveryIds.project },
      { id: api.boundary, projectId: api.project },
    ].map((entry) => ({
      ...entry,
      sourceRevision: "base",
      workflow: manager.workflow,
      profileId: `profile-${entry.id}`,
      approvedAt: deliveryNow,
      protectedPaths: ["runner.js"],
      writablePaths: ["src/feature.ts", "test/check.js", "fixtures/input.json"],
      creatableDirectories: ["test/new", "fixtures/new"],
      gates: [],
    })),
    crossProjectRequests: [
      {
        id: "peer-request",
        origin: { kind: "assignment", assignmentId: deliveryIds.assignment },
        originManagerId: deliveryIds.manager,
        originThreadId: deliveryIds.lead,
        originalLeadThreadId: deliveryIds.lead,
        receiverManagerId: api.manager,
        outcome: "Implement API",
        acceptanceConditions: "Frontend consumes API",
        compatibility: "Existing clients keep working",
        generation: 1,
        lifecycle: {
          phase: "accepted",
          support: { assignmentId: api.assignment, dedicated: true },
          notifiedConclusionId: null,
        },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
  };
};
export const commissioned = () => {
  const result = apply(
    fixture(),
    {
      type: "integration.commission",
      commandId: id(),
      managerId: deliveryIds.manager,
      requestIds: ["peer-request"],
      title: "Verify frontend and API",
      description: "Exercise the cross-project flow",
      complexity: "standard",
      coordinatorProjectId: deliveryIds.project,
    },
    actor(deliveryIds.manager),
  );
  return { ...result, integrationId: result.result.integrationId! };
};
export const configured = () => {
  const result = commissioned();
  let state = apply(
    result.state,
    {
      type: "integration.thread.created",
      commandId: id(),
      integrationId: result.integrationId,
      threadId: integrated.lead,
    },
    host,
  ).state;
  for (const boundary of state.boundaries) {
    const configured = apply(state, {
      type: "integration.capability.configure",
      commandId: id(),
      projectId: boundary.projectId,
      boundaryId: boundary.id,
      paths,
      coordinator:
        boundary.projectId === deliveryIds.project
          ? {
              executable: "/usr/local/bin/node",
              entrypoint: "runner.js",
              args: [],
              timeoutMs: 30000,
            }
          : null,
    });
    state = apply(
      configured.state,
      {
        type: "integration.capability.qualified",
        commandId: id(),
        capabilityId: configured.result.integrationCapabilityId!,
        profileId: `integration-profile-${boundary.id}`,
        configurationDigest: `configuration-${boundary.id}`,
        coordinatorDigest: boundary.projectId === deliveryIds.project ? "runner-digest" : null,
      },
      host,
    ).state;
  }
  return { state, integrationId: result.integrationId };
};
export const granted = () => {
  let { state, integrationId } = configured();
  for (const capability of state.integrationCapabilities) {
    state = apply(
      state,
      {
        type: "integration.grant",
        commandId: id(),
        integrationId,
        projectId: capability.projectId,
        capabilityId: capability.id,
        paths,
      },
      actor(capability.projectId === api.project ? api.manager : deliveryIds.manager),
    ).state;
  }
  return { state, integrationId };
};
export const preparationReceipt = (state: FactorySnapshot, integrationId: string) => {
  const preparationId = state.integrations.find(
    (entry) => entry.id === integrationId,
  )!.currentPreparationId!;
  const manifest: FactoryIntegrationManifest = {
    inputDigest: "combined-input",
    inputs: state.integrationGrants
      .filter(
        (entry) => entry.integrationId === integrationId && entry.lifecycle.phase === "active",
      )
      .map((grant) => {
        const assignment = state.assignments.find(
          (entry) => entry.id === grant.participantAssignmentId,
        )!;
        const revision = assignment.delivery!.revisions[0]!;
        return {
          projectId: assignment.projectId,
          assignmentId: assignment.id,
          leadThreadId: assignment.threadId,
          revisionId: revision.id,
          candidateId: revision.candidateId!,
          candidateDigest: revision.candidateDigest!,
          sourceDigest: revision.candidateDigest!,
          boundaryId: grant.boundaryId,
          grantEpoch: assignment.grant!.epoch,
          integrationGrantId: grant.id,
          capabilityId: grant.capabilityId,
          publication: { kind: "unpublished-candidate" },
        };
      }),
    planIds: [],
    coordinatorCapabilityId: state.integrationCapabilities.find(
      (entry) => entry.projectId === deliveryIds.project && entry.supersededBy === null,
    )!.id,
    coordinatorDigest: "runner-digest",
  };
  const artifact: FactoryIntegrationTestArtifact = {
    id: `artifact-${preparationId}`,
    integrationId,
    preparationId,
    digest: "test-artifact",
    projects: manifest.inputs.map((entry) => ({
      projectId: entry.projectId,
      grantId: entry.integrationGrantId,
      candidateId: entry.candidateId,
      candidateDigest: entry.candidateDigest,
      sourceDigest: entry.sourceDigest,
      changedPaths: [],
      deletedPaths: [],
      patchArtifactId: `patch-${entry.projectId}`,
    })),
    capturedAt: deliveryNow,
  };
  return { preparationId, manifest, artifact };
};
export const ready = () => {
  const { state, integrationId } = granted();
  const { preparationId, manifest, artifact } = preparationReceipt(state, integrationId);
  const result = apply(
    state,
    {
      type: "integration.prepared",
      commandId: id(),
      integrationId,
      preparationId,
      manifest,
      profileId: "combined-profile",
      testArtifact: artifact,
    },
    host,
  );
  return { ...result, integrationId, preparationId, artifact, manifest };
};
export const verified = () => {
  const prepared = ready();
  const requested = apply(
    prepared.state,
    {
      type: "integration.verify",
      commandId: id(),
      integrationId: prepared.integrationId,
      preparationId: prepared.preparationId,
    },
    actor(integrated.lead),
  );
  const result = apply(
    requested.state,
    {
      type: "integration.verified",
      commandId: id(),
      verificationId: requested.result.integrationVerificationId!,
      result: "passed",
      testArtifact: { ...prepared.artifact, id: "verified-artifact" },
      hostArtifactId: "combined-run",
      checks: [
        {
          id: "coordinator",
          status: "passed",
          exitCode: 0,
          output: "Frontend consumed API response",
        },
      ],
    },
    host,
  );
  return { ...prepared, ...result };
};
