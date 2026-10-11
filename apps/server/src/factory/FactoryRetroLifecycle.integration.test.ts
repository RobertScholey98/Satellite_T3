import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactorySourceId,
  IssueOperationError,
  ProjectId,
  ProviderInstanceId,
  type FactoryBoundary,
  type FactoryCommand,
  type IssuePublicationDestination,
  type IssueRef,
  type PullRequestDetail,
  type QualifiedIssueDestination,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as IssuePublication from "../issues/IssuePublication.ts";
import * as IssuePublicationHost from "../issues/IssuePublicationHost.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import type { ProviderMergeEvidence } from "../pullRequest/pullRequestMergeEvidence.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import type { FactoryCandidateArtifact } from "./FactoryCandidate.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryDeliveryEffects from "./FactoryDeliveryEffects.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import { FactoryPublicationHost } from "./FactoryPublicationHost.ts";
import * as FactoryRetroEffects from "./FactoryRetroEffects.ts";
import * as FactoryRetroEvidence from "./FactoryRetroEvidence.ts";
import { FactoryRetroExecution } from "./FactoryRetroExecution.ts";
import * as FactoryService from "./FactoryService.ts";
import { FactorySource } from "./FactorySource.ts";
import * as FactoryStore from "./FactoryStore.ts";

// #41: one directly assigned, single-project delivery from onboarding to its follow-up ticket.
// Commands go through FactoryService and every effect runs on its real workers; only the
// provider runtime, Docker boundary, PR host and issue tracker host are substituted.

type Actor = Parameters<FactoryService.FactoryService["Service"]["dispatch"]>[0];
const projectId = ProjectId.make("retro-lifecycle");
const human = { kind: "human" } as const;
const now = "2026-10-10T12:00:00.000Z";
const model = { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" };
const workflow = { repositoryRoot: "/owned-workflow", revision: "approved-workflow" };
const configuration = {
  protectedPaths: ["AGENTS.md"],
  writablePaths: ["src/app.ts"],
  creatableDirectories: [],
  gates: [],
};
const boundary: FactoryBoundary = {
  ...configuration,
  id: FactoryBoundaryId.make("boundary"),
  projectId,
  sourceRevision: "onboarding-source",
  workflow,
  profileId: "onboarding-profile",
  approvedAt: now,
};
const qualified = (profileId: string) => ({
  status: "qualified" as const,
  profileId,
  checkedAt: now,
});
const prRef = { projectId, host: "github.com", repository: "owner/repo", number: 20 };
const publication = {
  reservationId: "reservation",
  host: "github.com",
  repository: "owner/repo",
  branch: "factory/work",
  baseBranch: "main",
  headSha: "head",
  treeOid: "tree",
};
const mergeEvidence: ProviderMergeEvidence = {
  headSha: "head",
  baseSha: "base",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  mergeState: "CLEAN",
  reviewDecision: "approved",
  autoMergeEnabled: false,
  mergeQueueEnabled: false,
  checks: [{ id: "check", name: "build", headSha: "head", required: true, status: "success" }],
  reviews: [],
  complete: true,
  issues: [],
};
const pullRequest = (merged: boolean): PullRequestDetail => ({
  ...prRef,
  provider: "github",
  projectTitle: "Retro lifecycle",
  workspaceRoot: "/project",
  title: "Feature",
  body: "Feature",
  url: "https://github.com/owner/repo/pull/20",
  author: null,
  state: merged ? "merged" : "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "factory/work",
  baseBranch: "main",
  headSha: "head",
  createdAt: now,
  updatedAt: now,
  mergedAt: merged ? now : null,
  closedAt: merged ? now : null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  capabilities: {
    diff: true,
    comment: true,
    actions: ["merge"],
    mergeMethods: ["merge"],
    conditionalMerge: true,
    search: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: true, listCandidates: true },
  },
  viewerPermissions: {
    actions: ["merge"],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: true,
  },
});
const trackerDestination: IssuePublicationDestination = {
  kind: "github",
  host: "github.com",
  repository: "owner/repo",
  triage: { kind: "labels", labels: ["triage"] },
};
const qualifiedTracker: QualifiedIssueDestination = {
  projectId,
  environmentId: EnvironmentId.make("env"),
  credentialNamespace: "namespace",
  board: null,
  validatedAt: now,
  destination: trackerDestination,
};
const ticket: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "42",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
};

const base = Layer.mergeAll(FactoryStore.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "delivers an onboarded, confined, team-reviewed PR through both retros to one triaged follow-up",
  () =>
    Effect.gen(function* () {
      const store = yield* FactoryStore.FactoryStore;
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* Satellite.recordProject({ projectId, title: "Retro lifecycle", workspaceRoot: root });
      const host = {
        merged: false,
        mergeActions: 0,
        issuesCreated: 0,
        placementOutages: 1,
        triaged: false,
      };

      const issueHost = IssuePublicationHost.IssuePublicationHost.of({
        validate: () => Effect.succeed(qualifiedTracker),
        lookup: () => Effect.succeed({ issues: [], complete: true }),
        inspect: () =>
          Effect.sync(() =>
            host.triaged ? { kind: "labels" as const, labels: ["triage"] } : undefined,
          ),
        create: ({ beforeMutation }) =>
          beforeMutation.pipe(
            Effect.andThen(
              Effect.sync(() => {
                host.issuesCreated++;
                return ticket;
              }),
            ),
          ),
        place: ({ beforeMutation }) =>
          beforeMutation.pipe(
            Effect.andThen(
              host.placementOutages-- > 0
                ? Effect.fail(
                    new IssueOperationError({ reason: "unavailable", message: "Tracker outage" }),
                  )
                : Effect.sync(() => {
                    host.triaged = true;
                  }),
            ),
          ),
      });
      const candidate = (assignmentId: FactoryAssignmentId) =>
        Effect.map(store.snapshot, (state): FactoryCandidateArtifact => {
          const assignment = state.assignments.find((entry) => entry.id === assignmentId)!;
          return {
            id: "candidate",
            assignmentId,
            projectId,
            leadThreadId: assignment.threadId,
            startingSource: assignment.startingSource!,
            workflow: assignment.workflow,
            grant: assignment.grant!,
            configuration,
            sourceDigest: "raw-digest",
            files: [],
            deletedPaths: [],
            selectedPaths: ["src/app.ts"],
            startingFiles: [],
            startingIndexFiles: [],
            capturedAt: now,
          };
        });
      const externalBoundaries = Layer.mergeAll(
        Layer.succeed(FactoryExecution, {
          qualify: () => Effect.succeed(qualified("onboarding-profile")),
          runtimePolicyFor: () =>
            Effect.succeed({
              boundaryId: "boundary",
              dockerContext: "default",
              imageId: "image",
              projectSnapshotPath: root,
              workflowSnapshotPath: root,
              runtimePath: root,
              inspection: { sourceDigest: "digest", candidateId: "candidate", evidencePath: root },
            }),
          assertSelectionFor: () => Effect.void,
          assertDelegationFor: () => Effect.void,
        }),
        Layer.mock(FactoryBoundaryExecution)({
          approve: () => Effect.succeed(boundary),
          prepare: () => Effect.succeed(qualified("implementation-profile")),
          stop: () => Effect.void,
          captureCandidate: ({ assignmentId }) => candidate(assignmentId),
          finalizeCandidate: ({ assignmentId }) =>
            Effect.map(candidate(assignmentId), (captured) => ({
              ...captured,
              finalized: {
                reservationId: publication.reservationId,
                sourceDigest: "digest",
                treeOid: "tree",
                commitOid: "head",
                files: [],
              },
            })),
          verifyCandidate: ({ expectedEpoch }) =>
            Effect.succeed({
              artifactId: "verification",
              boundaryId: boundary.id,
              epoch: expectedEpoch,
              sourceDigest: "digest",
              gates: [{ id: "tests", status: "passed" as const, exitCode: 0, output: "Passed" }],
              checkedAt: now,
            }),
          inspectCandidate: () =>
            Effect.succeed({ qualification: qualified("review-profile"), sourceDigest: "digest" }),
        }),
        Layer.mock(FactorySource)({
          capture: () =>
            Effect.succeed({
              id: FactorySourceId.make("source"),
              projectId,
              revision: "current-source",
              sourceDigest: "captured-digest",
              branch: "main",
              origin: "project",
              capturedAt: now,
              fileCount: 1,
              stagedPaths: [],
              unstagedPaths: [],
              untrackedPaths: [],
              deletedPaths: [],
              excludedPaths: [],
            }),
          validateCurrent: () => Effect.void,
        }),
        Layer.mock(FactoryHandover)({ stop: () => Effect.void, stopTeam: () => Effect.void }),
        Layer.mock(FactoryPublicationHost)({
          prepare: () => Effect.succeed(publication),
          publish: () => Effect.succeed(prRef),
        }),
        Layer.mock(PullRequestService)({
          inspectForMerge: () => Effect.succeed(mergeEvidence),
          detail: () => Effect.sync(() => pullRequest(host.merged)),
          invalidate: () => Effect.void,
          runAction: () =>
            Effect.sync(() => {
              host.mergeActions++;
            }),
        }),
        Layer.mock(FactoryRetroExecution)({
          prepare: () =>
            Effect.succeed({ qualification: qualified("retro-profile"), sourceDigest: "source" }),
          stop: () => Effect.void,
        }),
        Layer.succeed(IssuePublicationHost.IssuePublicationHost, issueHost),
        ServerConfig.layerTest(root, root),
      );
      const layer = FactoryService.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            FactoryDeliveryEffects.layer,
            FactoryRetroEffects.layer.pipe(
              Layer.provide(Layer.mergeAll(FactoryRetroEvidence.layer, IssuePublication.layer)),
            ),
          ).pipe(Layer.provide(FactoryControlAccess.layer)),
        ),
        Layer.provide(externalBoundaries),
      );

      yield* Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        const run = (actor: Actor, command: FactoryCommand) =>
          factory.dispatch(actor, command).pipe(Effect.tap(() => factory.drain));
        const id = CommandId.make;

        // 1. Onboarding: the manager's onboarding team reports and the human approves the boundary.
        yield* run(human, {
          type: "manager.create",
          commandId: id("manager"),
          projectId,
          modelSelection: model,
          workflow,
        });
        const onboarding = (yield* store.snapshot).assignments[0]!;
        yield* run(
          { kind: "thread", threadId: onboarding.threadId },
          {
            type: "onboarding.report",
            commandId: id("onboarding-report"),
            assignmentId: onboarding.id,
            report: {
              summary: "Discovered controls",
              instructions: [],
              checks: [],
              tracker: { description: "Repository issues", evidence: [] },
              verificationTools: [],
              protectedControls: [],
              unresolvedDecisions: [],
            },
          },
        );
        yield* run(human, {
          type: "manager.approve-onboarding",
          commandId: id("approve-onboarding"),
          managerId: onboarding.managerId,
          configuration,
        });
        const onboarded = yield* store.snapshot;
        assert.equal(onboarded.managers[0]!.status, "active");
        assert.equal(onboarded.managers[0]!.boundaryId, boundary.id);

        // 2. A confined implementation assignment with a PR requirement.
        const commissioned = yield* run(human, {
          type: "assignment.commission",
          commandId: id("commission"),
          managerId: onboarding.managerId,
          title: "Improve the app",
          scope: {
            description: "Improve the app module",
            completionCondition: "Behavior verified and PR merged",
            requiresPullRequest: true,
          },
          complexity: "standard",
          kind: "implementation",
          sourcePaths: ["src/app.ts"],
          creatableDirectories: [],
        });
        const assignmentId = FactoryAssignmentId.make(commissioned.assignmentId!);
        const assignment = Effect.map(store.snapshot, (state) =>
          state.assignments.find((entry) => entry.id === assignmentId)!,
        );
        const started = yield* assignment;
        assert.deepEqual(started.grant?.sourcePaths, ["src/app.ts"]);
        assert.equal(started.qualification.status, "qualified");
        assert.equal(started.launchStatus, "delivered");
        const lead: Actor = { kind: "thread", threadId: started.threadId, assignmentId };

        // 3. Delivery: captured, independently reviewed, published, approved and merged by the human.
        yield* run(lead, {
          type: "delivery.impact.declare",
          commandId: id("impact"),
          assignmentId,
          impact: {
            classification: "none",
            changedFlows: false,
            journeys: "",
            navigation: "",
            layout: "",
            sharedComponents: "",
            summary: "Server behavior only",
            evidence: [{ label: "code", location: "candidate://revision/src/app.ts" }],
          },
        });
        yield* run(lead, {
          type: "delivery.capture",
          commandId: id("capture"),
          assignmentId,
          expectedEpoch: started.grant!.epoch,
          selectedPaths: ["src/app.ts"],
          commitMessage: "feat: improve the app",
        });
        const revision = Effect.map(assignment, (entry) => entry.delivery!.revisions.at(-1)!);
        const revisionId = (yield* revision).id;
        assert.equal((yield* revision).candidateDigest, "digest");
        yield* run(lead, {
          type: "delivery.review.request",
          commandId: id("review"),
          assignmentId,
          revisionId,
        });
        const review = (yield* revision).reviews[0]!;
        yield* run(
          { kind: "thread", threadId: review.threadId, assignmentId },
          {
            type: "delivery.review.report",
            commandId: id("review-report"),
            assignmentId,
            revisionId,
            reviewId: review.id,
            verdict: "passed",
            confirmsImpact: true,
            findings: "Checked implementation and impact",
            evidence: [{ label: "code", location: "candidate://revision/src/app.ts" }],
          },
        );
        yield* run(lead, {
          type: "delivery.publish",
          commandId: id("publish"),
          assignmentId,
          revisionId,
          title: "Feature",
          body: "Feature with evidence",
        });
        assert.deepEqual((yield* revision).publication?.ref, prRef);
        yield* run(lead, {
          type: "assignment.progress",
          commandId: id("progress"),
          assignmentId,
          summary: "Feature published",
          remainingWork: "",
          evidence: [],
        });
        yield* run(lead, {
          type: "assignment.completion.plan",
          commandId: id("plan"),
          assignmentId,
          expectedVersion: 0,
          requirements: [{ id: "feature-pr", ref: prRef, expectedHeadSha: "head" }],
          seal: true,
        });
        yield* run(lead, {
          type: "delivery.ready",
          commandId: id("ready"),
          assignmentId,
          revisionId,
        });
        yield* run(human, {
          type: "delivery.approve",
          commandId: id("approve"),
          assignmentId,
          revisionId,
          expectedHeadSha: "head",
          bundleDigest: (yield* revision).bundleDigest!,
        });
        // The human merges the approved PR on the host; the team's merge request only confirms it.
        host.merged = true;
        yield* run(lead, {
          type: "delivery.merge",
          commandId: id("merge"),
          assignmentId,
          revisionId,
        });
        assert.equal((yield* revision).merge?.status, "merged");
        assert.equal(host.mergeActions, 0);

        // 4. The merge alone freezes the work and launches exactly one read-only team retro.
        const concluded = yield* store.snapshot;
        const completion = (yield* assignment).completion!;
        assert.equal(completion.phase, "concluded");
        assert.equal(completion.conclusion?.kind, "delivered");
        assert.equal(concluded.retros.length, 1);
        const retro = concluded.retros[0]!;
        assert.equal(retro.assignmentId, assignmentId);
        assert.equal(retro.reports.phase, "team-pending");
        assert.deepInclude(retro.execution, { status: "ready", launch: "delivered" });
        const retroLead: Actor = { kind: "thread", threadId: retro.threadId, assignmentId };
        const deliveryEvidence = [{ kind: "delivery" as const, id: completion.deliveries[0]!.id }];

        // 5. The retro lead files a project finding as a triage ticket.
        yield* run(human, {
          type: "project.tracker.configure",
          commandId: id("tracker"),
          projectId,
          expectedTrackerId: null,
          destination: trackerDestination,
        });
        yield* run(retroLead, {
          type: "finding.report",
          commandId: id("finding"),
          assignmentId,
          findingId: "lint-gap",
          finding: {
            problem: "The project lint rules miss the repeated import convention",
            impact: "Review rework",
            evidence: deliveryEvidence,
            activeBlocker: false,
            route: {
              suspectedCause: "project",
              uncertainty: "Low",
              owner: { kind: "project-manager", projectId },
              requiredAuthority: "Project rule",
              rationale: "Only this project's lint configuration is involved",
            },
            containmentOf: null,
          },
        });
        const followupRequest: FactoryCommand = {
          type: "followup.request",
          commandId: id("followup"),
          assignmentId,
          followupId: "lint-followup",
          findingIds: ["lint-gap"],
          draft: {
            title: "Enforce the import convention",
            problem: "Missing lint rule",
            impact: "Review rework",
            proposedOutcome: "Lint catches the convention",
            acceptanceCriteria: ["The repeated violation is caught"],
            evidence: [],
            owner: "Project manager",
            requiredAuthority: "Project rule",
            suspectedCause: "project",
            origin: { assignmentId, findingIds: ["lint-gap"] },
            containmentOf: null,
          },
        };
        const requested = yield* run(retroLead, followupRequest);
        const followup = Effect.map(store.snapshot, (state) => {
          const publication = state.followups[0]!.publication;
          assert.equal(publication.status, "recorded");
          return publication.status === "recorded" ? publication.receipt.progress : undefined;
        });
        // A tracker outage leaves the created issue outside triage; it is not yet filed.
        assert.deepInclude(yield* followup, { status: "placement-pending", issue: ticket });
        yield* run(retroLead, {
          type: "followup.retry",
          commandId: id("followup-retry"),
          followupId: "lint-followup",
        });
        // Re-running the publish effect places the same issue instead of creating another.
        assert.deepInclude(yield* followup, { status: "triaged", issue: ticket });
        assert.equal(host.issuesCreated, 1);
        const filed = yield* store.snapshot;
        assert.deepEqual(
          filed.assignments.map((entry) => entry.id),
          concluded.assignments.map((entry) => entry.id),
          "Filing a ticket commissions no work",
        );

        // 6. Duplicate events: a replayed request, another request for the same finding, and a
        // retry after triage all leave exactly one ticket.
        assert.deepEqual(yield* run(retroLead, followupRequest), requested);
        const duplicate = yield* factory
          .dispatch(retroLead, {
            ...followupRequest,
            commandId: id("followup-again"),
            followupId: "lint-followup-again",
          })
          .pipe(Effect.flip);
        assert.equal(duplicate.code, "command-conflict");
        yield* run(retroLead, {
          type: "followup.retry",
          commandId: id("followup-retry-again"),
          followupId: "lint-followup",
        });
        assert.isFalse(
          (yield* store.pending).some((entry) => entry.intent.type.startsWith("followup.")),
        );
        assert.equal(host.issuesCreated, 1);
        assert.equal((yield* store.snapshot).followups.length, 1);

        // 7. Team retro, then the commissioning manager's retro disposes of the finding by ticket.
        yield* run(retroLead, {
          type: "retro.team.submit",
          commandId: id("team-retro"),
          retroId: retro.id,
          conclusionId: retro.conclusionId,
          report: {
            outcome: "Feature merged after independent review",
            helped: "Confined scope",
            hindered: "Lint gaps caused review rework",
            learning: { kind: "findings", findingIds: ["lint-gap"] },
            contributions: deliveryEvidence,
          },
        });
        const teamDone = (yield* store.snapshot).retros[0]!.reports;
        assert.equal(teamDone.phase, "manager-pending");
        if (teamDone.phase !== "manager-pending") return assert.fail("Expected a team report");
        yield* run(
          { kind: "thread", threadId: onboarding.managerId },
          {
            type: "retro.manager.submit",
            commandId: id("manager-retro"),
            retroId: retro.id,
            teamReportDigest: teamDone.team.digest,
            report: {
              summary: "Delivered; lint gap goes to project triage",
              learning: { kind: "findings", findingIds: ["lint-gap"] },
              dispositions: [
                { findingId: "lint-gap", kind: "ticket", followupId: "lint-followup" },
              ],
            },
          },
        );
        const finished = yield* store.snapshot;
        assert.equal(finished.retros[0]!.reports.phase, "complete");
        assert.equal(finished.retros[0]!.execution.status, "stopped");
        assert.equal((yield* assignment).status, "complete");
        assert.equal(host.issuesCreated, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);
