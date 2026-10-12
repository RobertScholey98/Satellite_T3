import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { CommandId, EventId, FactorySnapshot, type PullRequestDetail } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import type { ProviderMergeEvidence } from "../pullRequest/pullRequestMergeEvidence.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryDeliveryEffects from "./FactoryDeliveryEffects.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryHandover from "./FactoryHandover.ts";
import * as FactoryPublicationHost from "./FactoryPublicationHost.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySource from "./FactorySource.ts";
import * as FactoryStore from "./FactoryStore.ts";
import {
  deliveryIds,
  deliveryNow,
  deliveryRevisionCommand,
  deliverySelection,
  reviewedDeliveryFixture,
} from "./FactoryDelivery.testkit.ts";
import * as FactoryServiceTestkit from "./FactoryService.testkit.ts";

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
  checks: [{ id: "check", name: "build", headSha: "head", required: true, status: "pending" }],
  reviews: [],
  complete: true,
  issues: [],
};
const detail: PullRequestDetail = {
  provider: "github",
  projectId: deliveryIds.project,
  projectTitle: "Project",
  workspaceRoot: "/project",
  repository: "owner/repo",
  number: 20,
  title: "Feature",
  body: "Feature",
  url: "https://github.com/owner/repo/pull/20",
  author: null,
  headBranch: "factory/work",
  headSha: "head",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  createdAt: deliveryNow,
  updatedAt: deliveryNow,
  mergedAt: null,
  closedAt: null,
  labels: [],
  reviewers: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
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
  viewerPermissions: {
    actions: ["merge"],
    comment: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
    requestReviewers: true,
  },
};
const base = Layer.mergeAll(FactoryStore.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const services = FactoryService.layer.pipe(
  Layer.provideMerge(FactoryDeliveryEffects.layer.pipe(Layer.provide(FactoryControlAccess.layer))),
  Layer.provide(FactoryServiceTestkit.layerTestDependencies),
);
const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));

it.effect(
  "PR sync inspects changed checks once, identical evidence stays quiet, and startup recovers delivery inspection",
  () =>
    Effect.gen(function* () {
      const store = yield* FactoryStore.FactoryStore;
      const threads = yield* Threads.ThreadManagementService;
      const events = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const remote = yield* Ref.make(evidence);
      const inspections = yield* Ref.make(0);
      yield* Satellite.recordProject({
        projectId: deliveryIds.project,
        title: "Delivery",
        workspaceRoot: "/project",
      });
      for (const threadId of [deliveryIds.manager, deliveryIds.lead])
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
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
      yield* threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("link"),
        threadId: deliveryIds.lead,
        host: "github.com",
        repository: detail.repository,
        number: detail.number,
        url: detail.url,
        source: "agent",
      });
      const seed = reviewedDeliveryFixture();
      yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,0,${encode(seed)})`;
      const dependencies = Layer.mergeAll(
        Layer.mock(FactoryBoundaryExecution.FactoryBoundaryExecution)({}),
        Layer.mock(FactoryPublicationHost.FactoryPublicationHost)({}),
        Layer.mock(FactoryHandover.FactoryHandover)({}),
        Layer.mock(FactorySource.FactorySource)({}),
        Layer.mock(FactoryExecution.FactoryExecution)({}),
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () => Effect.succeed(detail),
          inspectForMerge: () =>
            Ref.update(inspections, (count) => count + 1).pipe(Effect.andThen(Ref.get(remote))),
        }),
      );
      const runtime = services.pipe(Layer.provide(dependencies));
      const leadMessages = threads
        .getThreadRecords(deliveryIds.lead, ["messages"])
        .pipe(
          Effect.map((records) =>
            records.messages.filter((message) => message.id.startsWith("factory-delivery:")),
          ),
        );
      const sync = (id: string) =>
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          const projection = yield* threads.getThreadProjection(deliveryIds.lead);
          const written = yield* events.write({
            events: [
              {
                id: EventId.make(`sync:${id}`),
                type: "thread.pull-request-synced",
                threadId: deliveryIds.lead,
                occurredAt: yield* DateTime.now,
                payload: projection.thread,
              },
            ],
          });
          yield* factory.observe(written[0]!);
          yield* factory.drain;
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* sync("pending");
          assert.equal(yield* Ref.get(inspections), 1);
          assert.equal((yield* leadMessages).length, 1);
          assert.include((yield* leadMessages)[0]!.text, "Required hosting checks are pending");
          yield* sync("pending-duplicate");
          assert.equal(yield* Ref.get(inspections), 2);
          assert.equal((yield* leadMessages).length, 1);
          yield* Ref.set(remote, {
            ...evidence,
            checks: evidence.checks.map((check) => ({ ...check, status: "success" as const })),
          });
          yield* sync("checks-passed");
          assert.equal((yield* leadMessages).length, 2);
          assert.include((yield* leadMessages).at(-1)!.text, "ready for human review");
          yield* sync("checks-passed-duplicate");
          assert.equal((yield* leadMessages).length, 2);
          assert.equal(yield* store.observationCursor, yield* events.latestSequence());
        }).pipe(Effect.provide(Layer.fresh(runtime))),
      );

      yield* Ref.set(remote, {
        ...evidence,
        checks: evidence.checks.map((check) => ({ ...check, status: "failure" as const })),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          yield* factory.recover;
          yield* factory.drain;
          assert.equal(yield* Ref.get(inspections), 5);
          assert.equal((yield* leadMessages).length, 3);
          assert.include((yield* leadMessages).at(-1)!.text, "Required hosting checks are failed");
          const state = yield* store.snapshot;
          assert.equal(
            state.assignments[0]!.delivery!.revisions[0]!.hostEvidence?.checks,
            "failed",
          );
          yield* factory.recover;
          yield* factory.drain;
          assert.equal(yield* Ref.get(inspections), 6);
          assert.equal((yield* leadMessages).length, 3);
        }).pipe(Effect.provide(Layer.fresh(runtime))),
      );

      const passing: ProviderMergeEvidence = {
        ...evidence,
        checks: evidence.checks.map((check) => ({ ...check, status: "success" as const })),
      };
      yield* Ref.set(remote, passing);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          const current = store.snapshot.pipe(
            Effect.map((state) => state.assignments[0]!.delivery!.revisions[0]!),
          );
          yield* factory.recover;
          yield* factory.drain;
          const sealed = yield* current;
          yield* store.commit({
            actor: { kind: "human" },
            now: deliveryNow,
            command: {
              ...deliveryRevisionCommand,
              type: "delivery.approve",
              commandId: CommandId.make("approve"),
              expectedHeadSha: "head",
              bundleDigest: sealed.bundleDigest!,
            },
          });
          // Recovery delivers the approval notice and re-inspects unchanged evidence.
          yield* factory.recover;
          yield* factory.drain;
          const messagesAfterApproval = (yield* leadMessages).length;
          // Another team merges into main: the base moves and checks re-run with the same outcome.
          yield* Ref.set(remote, {
            ...passing,
            baseSha: "moved-base",
            checks: passing.checks.map((check) => ({ ...check, id: "check-rerun" })),
          });
          yield* factory.recover;
          yield* factory.drain;
          const moved = yield* current;
          assert.equal(moved.bundleDigest, sealed.bundleDigest);
          assert.equal(moved.approval?.commandId, "approve");
          assert.equal((yield* leadMessages).length, messagesAfterApproval);
        }).pipe(Effect.provide(Layer.fresh(runtime))),
      );
    }).pipe(Effect.provide(base), Effect.scoped),
);
