import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactorySourceId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type FactoryDecisionCommand,
  type FactoryDeliveryImpact,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decide, initialFactorySnapshot, type FactoryActor } from "./FactoryState.ts";
import { initialFactoryDelivery, type FactoryDeliveryContext } from "./FactoryDelivery.ts";

export const deliveryNow = "2026-10-10T20:00:00.000Z";
export const deliveryIds = {
  assignment: FactoryAssignmentId.make("assignment"),
  manager: ThreadId.make("manager"),
  lead: ThreadId.make("lead"),
  reviewer: ThreadId.make("reviewer"),
  project: ProjectId.make("project"),
  boundary: FactoryBoundaryId.make("boundary"),
};
export const deliverySelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "approved",
};
export const deliveryActors = {
  human: { kind: "human" },
  host: { kind: "system" },
  lead: { kind: "thread", threadId: deliveryIds.lead },
  manager: { kind: "thread", threadId: deliveryIds.manager },
  reviewer: { kind: "thread", threadId: deliveryIds.reviewer },
} as const;
export const deliveryEvidence = [
  { label: "code", location: "candidate://revision/src/feature.ts" },
];
/** HEAD of the skills repository that fixture commands record as their pin. */
export const deliverySkills = { repositoryRoot: "C:/skills", revision: "workflow" };
export const deliveryFixture = (): FactorySnapshot => {
  const state = initialFactorySnapshot();
  const workflow = deliverySkills;
  const assignment: FactoryAssignment = {
    id: deliveryIds.assignment,
    managerId: deliveryIds.manager,
    threadId: deliveryIds.lead,
    projectId: deliveryIds.project,
    kind: "implementation",
    title: "Deliver feature",
    status: "running",
    threadStatus: "created",
    launchStatus: "delivered",
    scope: { description: "Feature", completionCondition: "PR merged", requiresPullRequest: true },
    preparation: "ready",
    workflow,
    qualification: { status: "qualified", profileId: "profile", checkedAt: deliveryNow },
    modelSelection: deliverySelection,
    modelPolicy: { approvedModels: [deliverySelection], preferences: [] },
    complexity: "standard",
    grantedPolicy: state.defaults,
    grant: {
      boundaryId: deliveryIds.boundary,
      epoch: 1,
      sourcePaths: ["src/feature.ts"],
      creatableDirectories: [],
      controlChange: null,
    },
    startingSource: {
      id: FactorySourceId.make("source"),
      projectId: deliveryIds.project,
      revision: "base",
      sourceDigest: "source-digest",
      branch: "main",
      origin: "project",
      capturedAt: deliveryNow,
      fileCount: 1,
      stagedPaths: [],
      unstagedPaths: [],
      untrackedPaths: [],
      deletedPaths: [],
      excludedPaths: [],
    },
    wait: null,
    report: null,
    delivery: initialFactoryDelivery(),
    createdAt: deliveryNow,
    updatedAt: deliveryNow,
  };
  return {
    ...state,
    assignments: [assignment],
    managers: [
      {
        id: deliveryIds.manager,
        threadId: deliveryIds.manager,
        name: "Manager",
        projectId: deliveryIds.project,
        role: "project",
        modelSelection: deliverySelection,
        workflow,
        overrides: {},
        status: "active",
        threadStatus: "created",
        launchStatus: "delivered",
        wait: null,
        boundaryId: deliveryIds.boundary,
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
  };
};
export const applyDelivery = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = deliveryActors.lead,
  context: FactoryDeliveryContext = {},
) =>
  Result.getOrThrow(
    decide({ skills: deliverySkills, state, command, actor, now: deliveryNow, ...context }),
  );
export const deliveryCommand = {
  commandId: CommandId.make("command"),
  assignmentId: deliveryIds.assignment,
};
export const deliveryRevisionId = "revision:command";
export const deliveryRevisionCommand = { ...deliveryCommand, revisionId: deliveryRevisionId };

export function reviewedDeliveryFixture(
  classification: FactoryDeliveryImpact["classification"] = "none",
) {
  let state = applyDelivery(deliveryFixture(), {
    ...deliveryCommand,
    type: "delivery.impact.declare",
    impact: {
      classification,
      changedFlows: false,
      journeys: "",
      navigation: "",
      layout: "",
      sharedComponents: "",
      summary: "Server behavior only",
      evidence: deliveryEvidence,
    },
  }).state;
  state = applyDelivery(state, {
    ...deliveryCommand,
    type: "delivery.capture",
    expectedEpoch: 1,
    selectedPaths: ["src/feature.ts"],
    commitMessage: "feat: feature",
  }).state;
  state = applyDelivery(
    state,
    {
      ...deliveryRevisionCommand,
      type: "delivery.captured",
      candidateId: "candidate",
      candidateDigest: "digest",
      publication: {
        reservationId: "reservation",
        host: "github.com",
        repository: "owner/repo",
        branch: "factory/work",
        baseBranch: "main",
        headSha: "head",
        treeOid: "tree",
      },
      verification: {
        artifactId: "checks",
        sourceDigest: "digest",
        passed: true,
        checkedAt: deliveryNow,
      },
    },
    deliveryActors.host,
  ).state;
  state = applyDelivery(
    state,
    { ...deliveryRevisionCommand, type: "delivery.review.request" },
    deliveryActors.lead,
    {
      deliveryReviewAllocation: {
        threadId: deliveryIds.reviewer,
        modelSelection: deliverySelection,
      },
    },
  ).state;
  state = applyDelivery(
    state,
    {
      ...deliveryRevisionCommand,
      type: "delivery.review.started",
      reviewId: "review:command",
      profileId: "review-profile",
    },
    deliveryActors.host,
  ).state;
  state = applyDelivery(
    state,
    {
      ...deliveryRevisionCommand,
      type: "delivery.review.report",
      reviewId: "review:command",
      verdict: "passed",
      confirmsImpact: true,
      findings: "Checked implementation and impact",
      evidence: deliveryEvidence,
    },
    deliveryActors.reviewer,
  ).state;
  state = applyDelivery(state, {
    ...deliveryRevisionCommand,
    type: "delivery.publish",
    title: "Feature",
    body: "Feature with evidence",
  }).state;
  state = applyDelivery(
    state,
    {
      ...deliveryRevisionCommand,
      type: "delivery.published",
      ref: {
        projectId: deliveryIds.project,
        host: "github.com",
        repository: "owner/repo",
        number: 20,
      },
    },
    deliveryActors.host,
  ).state;
  return applyDelivery(
    state,
    {
      ...deliveryRevisionCommand,
      type: "delivery.inspected",
      expectedStateRevision: state.revision,
      bundleDigest: "bundle",
      evidence: {
        headSha: "head",
        baseSha: "base",
        complete: true,
        checks: "passed",
        reviews: "passed",
        mergeable: true,
        conditionalMerge: true,
        reasons: [],
        observedAt: deliveryNow,
      },
    },
    deliveryActors.host,
  ).state;
}
