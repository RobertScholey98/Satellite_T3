import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryError,
  FactorySnapshot,
  PullRequestOperationError,
  type FactoryDecisionCommand,
  type PullRequestDetail,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import type { ProviderMergeEvidence } from "../pullRequest/pullRequestMergeEvidence.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import type { FactoryCandidateArtifact } from "./FactoryCandidate.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import { ready as integrationReady } from "./FactoryIntegration.testkit.ts";
import { factoryMergeGroupEvidence } from "./FactoryMerge.ts";
import { factoryMergeGroupForAssignment } from "./FactoryMergeOwnership.ts";
import * as FactoryDeliveryEffects from "./FactoryDeliveryEffects.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryHandover from "./FactoryHandover.ts";
import * as FactoryPublicationHost from "./FactoryPublicationHost.ts";
import { FactoryDeliveryPermit } from "./FactoryPullRequestGate.ts";
import * as FactoryStore from "./FactoryStore.ts";
import {
  deliveryActors,
  deliveryCommand,
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliveryRevisionCommand,
  deliverySelection,
  reviewedDeliveryFixture,
} from "./FactoryDelivery.testkit.ts";

const qualification = {
  status: "qualified" as const,
  profileId: "review-profile",
  checkedAt: deliveryNow,
};
const destination = {
  reservationId: deliveryRevisionCommand.revisionId,
  host: "github.com",
  repository: "owner/repo",
  branch: "factory/work",
  baseBranch: "main",
  headSha: "head",
  treeOid: "tree",
};
const publishedRef = {
  projectId: deliveryIds.project,
  host: "github.com",
  repository: "owner/repo",
  number: 20,
};
const evidence: ProviderMergeEvidence = {
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
const candidate = (): FactoryCandidateArtifact => {
  const assignment = deliveryFixture().assignments[0]!;
  return {
    id: "candidate",
    assignmentId: assignment.id,
    projectId: assignment.projectId,
    leadThreadId: assignment.threadId,
    startingSource: assignment.startingSource!,
    workflow: assignment.workflow,
    grant: assignment.grant!,
    configuration: {
      writablePaths: ["src"],
      creatableDirectories: [],
      protectedPaths: [],
      gates: [],
    },
    sourceDigest: "raw-digest",
    files: [],
    deletedPaths: [],
    selectedPaths: ["src/feature.ts"],
    startingFiles: [],
    startingIndexFiles: [],
    capturedAt: deliveryNow,
  };
};
const finalCandidate = () => ({
  ...candidate(),
  finalized: {
    reservationId: destination.reservationId,
    sourceDigest: "digest",
    treeOid: "tree",
    commitOid: "head",
    files: [],
  },
});
const detail = (merged: boolean): PullRequestDetail => ({
  provider: "github",
  capabilities: {
    diff: true,
    comment: true,
    actions: ["merge"],
    mergeMethods: ["merge"],
    conditionalMerge: true,
    search: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: ["approve"] },
    reviewers: { request: true, listCandidates: true },
  },
  projectId: deliveryIds.project,
  projectTitle: "Project",
  workspaceRoot: "/project",
  repository: "owner/repo",
  number: 20,
  title: "Feature",
  body: "Body",
  url: "https://github.com/owner/repo/pull/20",
  author: null,
  headBranch: "factory/work",
  headSha: "head",
  baseBranch: "main",
  state: merged ? "merged" : "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  createdAt: deliveryNow,
  updatedAt: deliveryNow,
  mergedAt: merged ? deliveryNow : null,
  closedAt: merged ? deliveryNow : null,
  labels: [],
  reviewers: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "viewer",
  viewerPermissions: {
    actions: ["merge"],
    comment: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
    requestReviewers: true,
  },
});
const base = Layer.mergeAll(FactoryStore.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const adapter = FactoryDeliveryEffects.layer.pipe(Layer.provide(FactoryControlAccess.layer));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const request = (
  command: FactoryDecisionCommand,
  actor: (typeof deliveryActors)[keyof typeof deliveryActors] = deliveryActors.lead,
) =>
  Effect.flatMap(FactoryStore.FactoryStore, (store) =>
    store.commit({ actor, now: deliveryNow, command }),
  );
const pendingFor = (type: string) =>
  Effect.gen(function* () {
    const store = yield* FactoryStore.FactoryStore;
    const pending = (yield* store.pending).find((entry) => entry.intent.type === type);
    assert.isDefined(pending);
    return pending!;
  });
const revision = Effect.flatMap(FactoryStore.FactoryStore, (store) =>
  Effect.map(store.snapshot, (snapshot) => snapshot.assignments[0]!.delivery!.revisions.at(-1)!),
);
const unreviewedFixture = (): FactorySnapshot => {
  const seed = reviewedDeliveryFixture();
  return {
    ...seed,
    auxiliaryThreads: [],
    assignments: seed.assignments.map((assignment) => ({
      ...assignment,
      delivery: {
        ...assignment.delivery!,
        revisions: assignment.delivery!.revisions.map((entry) => ({ ...entry, reviews: [] })),
      },
    })),
  };
};

const scenario = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  options: {
    seed?: FactorySnapshot;
    boundary?: Partial<FactoryBoundaryExecution.FactoryBoundaryExecution["Service"]>;
    host?: Partial<FactoryPublicationHost.FactoryPublicationHost["Service"]>;
    pr?: (
      store: FactoryStore.FactoryStore["Service"],
    ) => Partial<PullRequestService.PullRequestService["Service"]>;
    store?: (store: FactoryStore.FactoryStore["Service"]) => FactoryStore.FactoryStore["Service"];
    stopTeam?: FactoryHandover.FactoryHandover["Service"]["stopTeam"];
    lostSendAck?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* Threads.ThreadManagementService;
    const store = yield* FactoryStore.FactoryStore;
    yield* Satellite.recordProject({
      projectId: deliveryIds.project,
      title: "Delivery",
      workspaceRoot: "/project",
    });
    for (const threadId of [deliveryIds.manager, deliveryIds.lead])
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:" + threadId),
        threadId,
        projectId: deliveryIds.project,
        title: threadId,
        modelSelection: deliverySelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        worktreePath: "/project",
        branch: "main",
        createdBy: "user",
        creationSource: "web",
      });
    yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,0,${encodeSnapshot(options.seed ?? reviewedDeliveryFixture())})`;
    const threadLayer = Layer.succeed(Threads.ThreadManagementService, {
      ...threads,
      sendToThread: (input) =>
        threads.sendToThread(input).pipe(
          Effect.flatMap((receipt) =>
            options.lostSendAck
              ? Effect.fail(
                  new Threads.ThreadManagementDurableRunProjectionError({
                    threadId: input.threadId!,
                    messageId: input.messageId!,
                  }),
                )
              : Effect.succeed(receipt),
          ),
        ),
    });
    yield* body.pipe(
      Effect.provide(
        adapter.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(FactoryStore.FactoryStore, options.store?.(store) ?? store),
              threadLayer,
              Layer.mock(FactoryBoundaryExecution.FactoryBoundaryExecution)({
                captureCandidate: () => Effect.succeed(candidate()),
                finalizeCandidate: () => Effect.succeed(finalCandidate()),
                verifyCandidate: () =>
                  Effect.succeed({
                    artifactId: "verification",
                    boundaryId: deliveryIds.boundary,
                    epoch: 1,
                    sourceDigest: "digest",
                    gates: [{ id: "tests", status: "passed", exitCode: 0, output: "Passed" }],
                    checkedAt: deliveryNow,
                  }),
                inspectCandidate: () => Effect.succeed({ qualification, sourceDigest: "digest" }),
                setDeliveryHold: ({ held }) =>
                  Effect.succeed(held ? { qualification, sourceDigest: "held-source" } : undefined),
                ...options.boundary,
              }),
              Layer.mock(FactoryPublicationHost.FactoryPublicationHost)({
                prepare: () => Effect.succeed(destination),
                publish: () => Effect.succeed(publishedRef),
                ...options.host,
              }),
              Layer.mock(PullRequestService.PullRequestService)({
                inspectForMerge: () => Effect.succeed(evidence),
                detail: () => Effect.succeed(detail(false)),
                invalidate: () => Effect.void,
                runAction: () => Effect.void,
                ...options.pr?.(store),
              }),
              Layer.mock(FactoryHandover.FactoryHandover)({
                stopTeam: options.stopTeam ?? (() => Effect.void),
              }),
              Layer.mock(FactoryExecution.FactoryExecution)({
                assertSelectionFor: () => Effect.void,
                runtimePolicyFor: () =>
                  Effect.gen(function* () {
                    const state = yield* store.snapshot;
                    assert.isDefined(
                      state.auxiliaryThreads.find(
                        (entry) => entry.threadId === deliveryIds.reviewer,
                      )?.qualification,
                      "Review qualification must be durable before ordinary launch",
                    );
                    return {
                      boundaryId: "boundary",
                      dockerContext: "test",
                      imageId: "image",
                      projectSnapshotPath: "/candidate",
                      workflowSnapshotPath: "/workflow",
                      runtimePath: "/runtime",
                      inspection: {
                        sourceDigest: "digest",
                        candidateId: "candidate",
                        evidencePath: "/evidence",
                      },
                    };
                  }),
              }),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(base), Effect.scoped);

const beginCapture = Effect.gen(function* () {
  yield* request({
    ...deliveryCommand,
    type: "delivery.impact.declare",
    impact: reviewedDeliveryFixture().assignments[0]!.delivery!.impact!,
  });
  yield* request({
    ...deliveryCommand,
    commandId: CommandId.make("capture"),
    type: "delivery.capture",
    expectedEpoch: 1,
    selectedPaths: ["src/feature.ts"],
    commitMessage: "feat: feature",
  });
  return yield* pendingFor("delivery.capture");
});
const approveRevision = Effect.gen(function* () {
  const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
  yield* request({
    ...deliveryRevisionCommand,
    commandId: CommandId.make("inspect"),
    type: "delivery.ready",
  });
  yield* effects.handle(yield* pendingFor("delivery.inspect"));
  yield* request(
    {
      ...deliveryRevisionCommand,
      type: "delivery.approve",
      commandId: CommandId.make("approve"),
      expectedHeadSha: "head",
      bundleDigest: (yield* revision).bundleDigest!,
    },
    deliveryActors.human,
  );
});
const beginMerge = Effect.gen(function* () {
  yield* approveRevision;
  yield* request({ ...deliveryRevisionCommand, type: "delivery.merge" });
  return yield* pendingFor("delivery.merge");
});

it.effect(
  "captures and verifies the finalized publication digest before completing its outbox",
  () =>
    scenario(
      Effect.gen(function* () {
        const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
        const pending = yield* beginCapture;
        yield* effects.handle(pending);
        const result = yield* revision;
        assert.equal(result.candidateDigest, "digest");
        assert.equal(result.verification?.sourceDigest, "digest");
        assert.equal(result.publication?.headSha, "head");
        assert.equal(result.status, "captured");
        assert.isFalse(
          (yield* (yield* FactoryStore.FactoryStore).pending).some(
            (entry) => entry.id === pending.id,
          ),
        );
      }),
      { seed: deliveryFixture() },
    ),
);

it.effect("parks a verification mismatch and never publishes the candidate", () =>
  scenario(
    Effect.gen(function* () {
      const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
      yield* effects.handle(yield* beginCapture);
      assert.match((yield* revision).error!, /different candidate/);
      assert.equal((yield* revision).status, "capturing");
      assert.isDefined(yield* pendingFor("delivery.capture"));
    }),
    {
      seed: deliveryFixture(),
      boundary: {
        verifyCandidate: () =>
          Effect.succeed({
            artifactId: "wrong",
            boundaryId: deliveryIds.boundary,
            epoch: 1,
            sourceDigest: "another",
            gates: [],
            checkedAt: deliveryNow,
          }),
      },
    },
  ),
);

it.effect("stops capture after cancellation while private preparation is pending", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let finalizations = 0;
    yield* scenario(
      Effect.gen(function* () {
        const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
        const pending = yield* beginCapture;
        const fiber = yield* effects
          .handle(pending)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        yield* request(
          {
            type: "assignment.cancel",
            commandId: CommandId.make("cancel"),
            assignmentId: deliveryIds.assignment,
          },
          deliveryActors.human,
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        assert.equal(finalizations, 0);
        assert.isFalse(
          (yield* (yield* FactoryStore.FactoryStore).pending).some(
            (entry) => entry.id === pending.id,
          ),
        );
      }),
      {
        seed: deliveryFixture(),
        host: {
          prepare: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(destination),
            ),
        },
        boundary: {
          finalizeCandidate: () =>
            Effect.sync(() => {
              finalizations++;
              return finalCandidate();
            }),
        },
      },
    );
  }),
);

it.effect(
  "seals stable evidence across fresh reads so observation time does not invalidate approval",
  () =>
    scenario(
      Effect.gen(function* () {
        const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
        yield* request({
          ...deliveryRevisionCommand,
          commandId: CommandId.make("inspect-1"),
          type: "delivery.ready",
        });
        yield* effects.handle(yield* pendingFor("delivery.inspect"));
        const bundleDigest = (yield* revision).bundleDigest!;
        yield* request(
          {
            ...deliveryRevisionCommand,
            type: "delivery.approve",
            expectedHeadSha: "head",
            bundleDigest,
          },
          deliveryActors.human,
        );
        yield* request({
          ...deliveryRevisionCommand,
          commandId: CommandId.make("inspect-2"),
          type: "delivery.ready",
        });
        yield* effects.handle(yield* pendingFor("delivery.inspect"));
        assert.equal((yield* revision).bundleDigest, bundleDigest);
        assert.equal((yield* revision).approval?.bundleDigest, bundleDigest);
      }),
    ),
);

it.effect(
  "records an actual merge after a lost acknowledgement, with one mutation and a dependency fact",
  () =>
    Effect.gen(function* () {
      let merged = false;
      let mutations = 0;
      yield* scenario(
        Effect.gen(function* () {
          const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
          yield* effects.handle(yield* beginMerge);
          assert.equal(mutations, 1);
          assert.equal((yield* revision).merge?.status, "merged", (yield* revision).error);
          const state = yield* (yield* FactoryStore.FactoryStore).snapshot;
          assert.equal(state.assignments[0]?.oversight?.delivery?.kind, "pull-request-merged");
        }),
        {
          pr: (store) => ({
            detail: () => Effect.sync(() => detail(merged)),
            runAction: (input) =>
              Effect.gen(function* () {
                assert.equal(
                  (yield* store.snapshot).assignments[0]!.delivery!.revisions[0]!.merge?.status,
                  "unknown",
                );
                assert.equal((yield* FactoryDeliveryPermit)?.operationId, "merge:command");
                assert.equal(input.expectedHeadSha, "head");
                mutations++;
                merged = true;
                return yield* new PullRequestOperationError({
                  operation: "runAction",
                  detail: "Lost acknowledgement",
                });
              }).pipe(Effect.catchTags({ FactoryError: (cause) => Effect.die(cause) })),
          }),
        },
      );
    }),
);

it.effect("parks an unconfirmed merge and retries only after an explicit retry command", () =>
  Effect.gen(function* () {
    let mutations = 0;
    yield* scenario(
      Effect.gen(function* () {
        const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
        const pending = yield* beginMerge;
        yield* effects.handle(pending);
        assert.equal((yield* revision).merge?.status, "unknown");
        assert.isDefined((yield* revision).error);
        yield* effects.handle(yield* pendingFor("delivery.merge"));
        assert.equal(mutations, 1);
        yield* request({
          ...deliveryRevisionCommand,
          commandId: CommandId.make("retry"),
          type: "delivery.retry",
        });
        yield* effects.handle(yield* pendingFor("delivery.merge"));
        assert.equal(mutations, 2);
        assert.equal((yield* revision).merge?.status, "unknown");
        assert.isUndefined(
          (yield* (yield* FactoryStore.FactoryStore).snapshot).assignments[0]?.oversight?.delivery,
        );
      }),
      {
        pr: () => ({
          runAction: () =>
            Effect.sync(() => {
              mutations++;
            }),
        }),
      },
    );
  }),
);

it.effect(
  "closes a requested merge the host merged at another head so the lead can recapture",
  () =>
    scenario(
      Effect.gen(function* () {
        const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
        const pending = yield* beginMerge;
        yield* effects.handle(pending);
        const result = yield* revision;
        assert.equal(result.merge?.status, "failed");
        assert.isUndefined(result.error);
        assert.isFalse(
          (yield* (yield* FactoryStore.FactoryStore).pending).some(
            (entry) => entry.id === pending.id,
          ),
        );
        yield* request({
          ...deliveryCommand,
          commandId: CommandId.make("recapture"),
          type: "delivery.capture",
          expectedEpoch: 1,
          selectedPaths: ["src/feature.ts"],
          commitMessage: "feat: corrected feature",
        });
      }),
      { pr: () => ({ detail: () => Effect.succeed({ ...detail(true), headSha: "pushed" }) }) },
    ),
);

it.effect("holds an approved merge when fresh host checks or evidence change", () =>
  Effect.gen(function* () {
    let reads = 0;
    let mutations = 0;
    yield* scenario(
      Effect.gen(function* () {
        const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
        yield* effects.handle(yield* beginMerge);
        assert.equal(mutations, 0);
        assert.equal((yield* revision).hostEvidence?.checks, "failed");
        assert.isUndefined((yield* revision).approval);
        assert.isDefined((yield* revision).error);
      }),
      {
        pr: () => ({
          inspectForMerge: () =>
            Effect.sync(() => ({
              ...evidence,
              checks: [{ ...evidence.checks[0]!, status: ++reads === 1 ? "success" : "failure" }],
            })),
          runAction: () =>
            Effect.sync(() => {
              mutations++;
            }),
        }),
      },
    );
  }),
);

it.effect("recreates the store and worker at an unknown submission without submitting again", () =>
  Effect.gen(function* () {
    let mutations = 0;
    yield* scenario(
      Effect.gen(function* () {
        yield* beginMerge;
        yield* request(
          {
            ...deliveryRevisionCommand,
            commandId: CommandId.make("submission-at-process-exit"),
            type: "delivery.merge.recorded",
            operationId: "merge:command",
            status: "unknown",
            reason: "Process exited after dispatch.",
          },
          deliveryActors.host,
        );
        yield* Effect.gen(function* () {
          const recreatedStore = yield* FactoryStore.FactoryStore;
          const recreatedEffects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
          const pending = yield* pendingFor("delivery.merge");
          assert.equal(pending.attempts, 0);
          yield* recreatedEffects.handle(pending);
          assert.equal(mutations, 0);
          assert.equal((yield* revision).merge?.status, "unknown");
          assert.match((yield* revision).error!, /previous merge acknowledgement is unknown/);
          assert.isTrue((yield* recreatedStore.pending).some((entry) => entry.id === pending.id));
        }).pipe(
          Effect.provide(
            Layer.fresh(adapter).pipe(Layer.provideMerge(Layer.fresh(FactoryStore.layer))),
          ),
        );
      }),
      {
        pr: () => ({
          runAction: () =>
            Effect.sync(() => {
              mutations++;
            }),
        }),
      },
    );
  }),
);

it.effect(
  "re-seals after an atomic stale-state rejection without restoring obsolete approval",
  () =>
    Effect.gen(function* () {
      let intervene = false;
      let reads = 0;
      yield* scenario(
        Effect.gen(function* () {
          const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
          yield* approveRevision;
          const approvedBundle = (yield* revision).approval!.bundleDigest;
          intervene = true;
          yield* request({
            ...deliveryRevisionCommand,
            commandId: CommandId.make("inspect-after-approval"),
            type: "delivery.ready",
          });
          yield* effects.handle(yield* pendingFor("delivery.inspect"));
          assert.equal(reads, 3, "Initial seal plus rejected stale seal and fresh replacement");
          const result = yield* revision;
          assert.notEqual(result.bundleDigest, approvedBundle);
          assert.isUndefined(result.approval);
          assert.isUndefined(result.error);
          assert.lengthOf(result.reviews, 0);
        }),
        {
          pr: () => ({
            inspectForMerge: () =>
              Effect.sync(() => {
                reads++;
                return evidence;
              }),
          }),
          store: (store) => ({
            ...store,
            finishEffect: (input) =>
              Effect.gen(function* () {
                if (intervene && input.command.type === "delivery.inspected") {
                  intervene = false;
                  yield* store.commit({
                    actor: deliveryActors.lead,
                    now: deliveryNow,
                    command: {
                      ...deliveryCommand,
                      commandId: CommandId.make("change-impact-before-seal"),
                      type: "delivery.impact.declare",
                      impact: {
                        ...reviewedDeliveryFixture().assignments[0]!.delivery!.impact!,
                        summary: "Changed impact assessment needs another independent review",
                      },
                    },
                  });
                }
                yield* store.finishEffect(input);
              }),
          }),
        },
      );
    }),
);

it.effect(
  "records a merge confirmed after cancellation without delivering the abandoned assignment",
  () =>
    Effect.gen(function* () {
      let merged = false;
      let mutations = 0;
      yield* scenario(
        Effect.gen(function* () {
          const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
          const pending = yield* beginMerge;
          yield* effects.handle(pending);
          assert.equal(mutations, 1);
          assert.equal((yield* revision).merge?.status, "unknown");
          assert.isDefined(yield* pendingFor("delivery.merge"));
          merged = true;
          yield* effects.handle(yield* pendingFor("delivery.merge"));
          const assignment = (yield* (yield* FactoryStore.FactoryStore).snapshot).assignments[0]!;
          assert.equal(assignment.outcome?.kind, "cancelled");
          assert.equal((yield* revision).merge?.status, "merged");
          assert.isUndefined(assignment.oversight?.delivery);
          assert.equal(mutations, 1);
          assert.isFalse(
            (yield* (yield* FactoryStore.FactoryStore).pending).some(
              (entry) => entry.id === pending.id,
            ),
          );
        }),
        {
          pr: (store) => ({
            detail: () => Effect.sync(() => detail(merged)),
            runAction: () =>
              Effect.gen(function* () {
                mutations++;
                yield* store.commit({
                  actor: deliveryActors.human,
                  now: deliveryNow,
                  command: {
                    type: "assignment.cancel",
                    commandId: CommandId.make("cancel-in-flight"),
                    assignmentId: deliveryIds.assignment,
                  },
                });
                return yield* new PullRequestOperationError({
                  operation: "runAction",
                  detail: "Connection lost.",
                });
              }).pipe(Effect.catchTags({ FactoryError: (cause) => Effect.die(cause) })),
          }),
        },
      );
    }),
);

it.effect(
  "launches one ordinary reviewer thread after preparation and survives a lost send acknowledgement",
  () => {
    return scenario(
      Effect.gen(function* () {
        const store = yield* FactoryStore.FactoryStore;
        const threads = yield* Threads.ThreadManagementService;
        yield* store.commit({
          actor: deliveryActors.lead,
          now: deliveryNow,
          deliveryReviewAllocation: {
            threadId: deliveryIds.reviewer,
            modelSelection: deliverySelection,
          },
          command: { ...deliveryRevisionCommand, type: "delivery.review.request" },
        });
        const pending = yield* pendingFor("delivery.review.launch");
        const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
        yield* effects.handle(pending);
        assert.equal((yield* revision).reviews[0]?.status, "running");
        const records = yield* threads.getThreadRecords(deliveryIds.reviewer, ["messages", "runs"]);
        assert.lengthOf(records.messages, 1);
        assert.lengthOf(records.runs, 1);
        assert.equal(
          (yield* threads.getThreadShell(deliveryIds.reviewer))?.worktreePath,
          "/candidate",
        );
        assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
      }),
      { seed: unreviewedFixture(), lostSendAck: true },
    );
  },
);

it.effect(
  "resumes a prepared review after recreating its store and worker with one durable launch",
  () =>
    Effect.gen(function* () {
      let preparations = 0;
      let loseReceipt = true;
      yield* scenario(
        Effect.gen(function* () {
          const store = yield* FactoryStore.FactoryStore;
          yield* store.commit({
            actor: deliveryActors.lead,
            now: deliveryNow,
            deliveryReviewAllocation: {
              threadId: deliveryIds.reviewer,
              modelSelection: deliverySelection,
            },
            command: { ...deliveryRevisionCommand, type: "delivery.review.request" },
          });
          const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
          yield* effects.handle(yield* pendingFor("delivery.review.launch"));
          assert.match((yield* revision).error!, /Process exited before started receipt/);
          yield* request({
            ...deliveryRevisionCommand,
            commandId: CommandId.make("resume-review"),
            type: "delivery.retry",
          });
          yield* Effect.gen(function* () {
            const restarted = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
            yield* restarted.handle(yield* pendingFor("delivery.review.launch"));
            const records = yield* (yield* Threads.ThreadManagementService).getThreadRecords(
              deliveryIds.reviewer,
              ["messages", "runs"],
            );
            assert.equal(preparations, 1);
            assert.lengthOf(records.messages, 1);
            assert.lengthOf(records.runs, 1);
            assert.equal((yield* revision).reviews[0]?.status, "running");
            assert.isUndefined((yield* revision).error);
          }).pipe(
            Effect.provide(
              Layer.fresh(adapter).pipe(Layer.provideMerge(Layer.fresh(FactoryStore.layer))),
            ),
          );
        }),
        {
          seed: unreviewedFixture(),
          boundary: {
            inspectCandidate: () =>
              Effect.sync(() => {
                preparations++;
                return { qualification, sourceDigest: "digest" };
              }),
          },
          store: (store) => ({
            ...store,
            finishEffect: (input) => {
              if (loseReceipt && input.command.type === "delivery.review.started") {
                loseReceipt = false;
                return Effect.fail(
                  new FactoryError({
                    code: "persistence",
                    detail: "Process exited before started receipt.",
                  }),
                );
              }
              return store.finishEffect(input);
            },
          }),
        },
      );
    }),
);

it.effect(
  "waits for actual team stop before creating the readonly flow context and seals embedded content",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let holds = 0;
      yield* scenario(
        Effect.gen(function* () {
          const effects = yield* FactoryDeliveryEffects.FactoryDeliveryEffects;
          yield* request({
            ...deliveryCommand,
            type: "delivery.impact.declare",
            impact: {
              ...reviewedDeliveryFixture().assignments[0]!.delivery!.impact!,
              classification: "substantial-ui",
              changedFlows: true,
            },
          });
          const fiber = yield* effects
            .handle(yield* pendingFor("delivery.flow.hold"))
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(entered);
          assert.equal(holds, 0);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          yield* request({
            ...deliveryCommand,
            commandId: CommandId.make("flow"),
            type: "delivery.flow.submit",
            title: "Checkout",
            content: "<main>Confirm order</main>",
            format: "html",
          });
          yield* effects.handle(yield* pendingFor("delivery.flow.capture"));
          const flow = (yield* (yield* FactoryStore.FactoryStore).snapshot).assignments[0]!
            .delivery!.flow!;
          assert.equal(flow.status, "held");
          assert.equal(flow.qualification?.profileId, qualification.profileId);
          assert.equal(flow.artifact?.content, "<main>Confirm order</main>");
          assert.match(flow.artifactDigest!, /^[a-f0-9]{64}$/);
          const store = yield* FactoryStore.FactoryStore;
          assert.equal((yield* store.snapshot).assignments[0]!.wait?.kind, "flow-review");
          yield* request(
            {
              ...deliveryCommand,
              commandId: CommandId.make("approve-flow"),
              type: "delivery.flow.decide",
              artifactDigest: flow.artifactDigest!,
              approved: true,
            },
            deliveryActors.human,
          );
          assert.equal((yield* store.snapshot).assignments[0]!.wait?.kind, "flow-review");
          yield* effects.handle(yield* pendingFor("delivery.flow.hold"));
          const resumed = (yield* store.snapshot).assignments[0]!;
          assert.equal(holds, 2);
          assert.equal(resumed.delivery!.flow!.status, "released");
          assert.isNull(resumed.wait);
          assert.equal(resumed.status, "running");
        }),
        {
          seed: deliveryFixture(),
          stopTeam: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          boundary: {
            setDeliveryHold: () =>
              Effect.sync(() => {
                holds++;
                return { qualification, sourceDigest: "held-source" };
              }),
          },
        },
      );
    }),
);

it.effect(
  "retires a queued individual merge after group enrollment without submitting a host mutation",
  () => {
    let mutations = 0;
    return scenario(
      Effect.gen(function* () {
        const pending = yield* beginMerge;
        const store = yield* FactoryStore.FactoryStore;
        const state = yield* store.snapshot;
        const grouped = {
          ...state,
          revision: state.revision + 1,
          integrations: integrationReady().state.integrations,
          mergeGroups: [],
        };
        const sql = yield* SqlClient.SqlClient;
        const enrolled = {
          ...grouped,
          mergeGroups: [factoryMergeGroupForAssignment(grouped, deliveryIds.assignment)!],
        };
        const blocked = factoryMergeGroupEvidence(enrolled, enrolled.mergeGroups[0]!.id);
        assert.isTrue(
          !blocked.ready &&
            blocked.reasons.some((reason) => /independent merge outcome/.test(reason)),
        );
        yield* sql`UPDATE factory_state SET revision=${enrolled.revision}, payload_json=${encodeSnapshot(enrolled)} WHERE id=1`;
        yield* (yield* FactoryDeliveryEffects.FactoryDeliveryEffects).handle(pending);
        assert.equal(mutations, 0);
        assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
        assert.equal((yield* revision).merge?.status, "failed");
        assert.isUndefined((yield* revision).error);
        const recovered = yield* store.snapshot;
        const group = factoryMergeGroupForAssignment(recovered, deliveryIds.assignment)!;
        const readiness = factoryMergeGroupEvidence(recovered, group.id);
        assert.isFalse(
          !readiness.ready &&
            readiness.reasons.some((reason) => /independent merge outcome/.test(reason)),
        );
      }),
      {
        pr: () => ({
          runAction: () =>
            Effect.sync(() => {
              mutations++;
            }),
        }),
      },
    );
  },
);

it.effect("preserves an unknown individual submission after group enrollment", () =>
  scenario(
    Effect.gen(function* () {
      const pending = yield* beginMerge;
      yield* request(
        {
          ...deliveryRevisionCommand,
          commandId: CommandId.make("group-unknown-submission"),
          type: "delivery.merge.recorded",
          operationId: "merge:command",
          status: "unknown",
          reason: "The host submission acknowledgement was lost.",
        },
        deliveryActors.host,
      );
      const store = yield* FactoryStore.FactoryStore;
      const state = yield* store.snapshot;
      const grouped = {
        ...state,
        revision: state.revision + 1,
        integrations: integrationReady().state.integrations,
        mergeGroups: [],
      };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_state SET revision=${grouped.revision}, payload_json=${encodeSnapshot(grouped)} WHERE id=1`;
      yield* (yield* FactoryDeliveryEffects.FactoryDeliveryEffects).handle(pending);
      assert.equal((yield* revision).merge?.status, "unknown");
      assert.isTrue((yield* store.pending).some((entry) => entry.id === pending.id));
    }),
    {
      pr: () => ({ runAction: () => Effect.die("An uncertain merge must not be resubmitted.") }),
    },
  ),
);
