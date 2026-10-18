// @effect-diagnostics nodeBuiltinImport:off - Removes worktree folders out from under Revdoc.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import {
  type ApplicationStoredEvent,
  type StorageCleanupReport,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as RevdocLifecycleReactor from "./RevdocLifecycleReactor.ts";
import * as RevdocService from "./RevdocService.ts";
import * as RevdocStore from "./RevdocStore.ts";
import * as RevdocWorktreeRemoval from "./RevdocWorktreeRemoval.ts";
import {
  answering,
  awaitPass,
  layerRevdoc,
  makeRepository,
  PROJECT_ID,
  type Reviewer,
  target,
  writeFile,
} from "./testing/revdocService.test.helpers.ts";

interface Triggers {
  readonly reports: Queue.Queue<StorageCleanupReport | null>;
  readonly applicationEvents: Queue.Queue<ApplicationStoredEvent>;
  readonly ready: Deferred.Deferred<void>;
}

const layerReactor = (root: string, reviewer: { current: Reviewer }, triggers: Triggers) =>
  Layer.mergeAll(
    RevdocLifecycleReactor.layer,
    RevdocWorktreeRemoval.layer.pipe(
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          removeWorktree: (input: VcsRemoveWorktreeInput) =>
            Effect.sync(() => NodeFS.rmSync(input.path, { recursive: true, force: true })),
        }),
      ),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(StorageCleanup.StorageCleanup)({ reports: Stream.fromQueue(triggers.reports) }),
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(0),
          streamApplicationEvents: () => Stream.fromQueue(triggers.applicationEvents),
        }),
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          awaitCommandReady: Deferred.await(triggers.ready),
        }),
      ),
    ),
    Layer.provideMerge(layerRevdoc({ root, reviewer })),
  );

const makeTriggers = Effect.gen(function* () {
  return {
    reports: yield* Queue.unbounded<StorageCleanupReport | null>(),
    applicationEvents: yield* Queue.unbounded<ApplicationStoredEvent>(),
    ready: yield* Deferred.make<void>(),
  } satisfies Triggers;
});

/** A Review with a generation pass blocked in its model call, and a signal for its interruption. */
const reviewWithRunningPass = (reviewer: { current: Reviewer }) =>
  Effect.gen(function* () {
    const revdoc = yield* RevdocService.RevdocService;
    yield* awaitPass((yield* revdoc.generate(target())).passId);
    const interrupted = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    reviewer.current = () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      );
    yield* revdoc.generate(target());
    yield* Deferred.await(started);
    const subscribed = yield* Deferred.make<void>();
    const deleted = yield* revdoc.subscribe(target()).pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.filter((event) => event._tag === "deleted"),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* Deferred.await(subscribed);
    return { interrupted, deleted };
  });

const reviewCount = Effect.flatMap(RevdocStore.RevdocStore, (store) =>
  Effect.map(store.listReviews(), (reviews) => reviews.length),
);

const run = <E, R>(
  body: (
    root: string,
    triggers: Triggers,
    reviewer: { current: Reviewer },
  ) => Effect.Effect<void, E, R>,
) => {
  const root = makeRepository();
  writeFile(root, "a.ts", "a\n");
  const reviewer = { current: answering() };
  return Effect.gen(function* () {
    const triggers = yield* makeTriggers;
    yield* body(root, triggers, reviewer).pipe(
      Effect.provide(layerReactor(root, reviewer, triggers)),
    );
  }).pipe(Effect.scoped);
};

describe("RevdocLifecycleReactor", () => {
  it.live("forgets the Review and cancels its pass when Satellite removes the worktree", () =>
    run((root, _triggers, reviewer) =>
      Effect.gen(function* () {
        const { interrupted, deleted } = yield* reviewWithRunningPass(reviewer);
        const git = yield* GitWorkflowService.GitWorkflowService;
        yield* git.removeWorktree({ cwd: root, path: root, force: true });
        yield* Fiber.join(deleted);
        yield* Deferred.await(interrupted);
        assert.strictEqual(yield* reviewCount, 0);
      }),
    ),
  );

  it.live("forgets the Review when settled-worktree cleanup reports the worktree removed", () =>
    run((root, triggers, reviewer) =>
      Effect.gen(function* () {
        const { interrupted, deleted } = yield* reviewWithRunningPass(reviewer);
        yield* Queue.offer(triggers.reports, {
          trigger: "automatic",
          startedAt: "2026-10-17T00:00:00.000Z",
          finishedAt: "2026-10-17T00:00:01.000Z",
          entries: [
            {
              kind: "worktree",
              outcome: "removed",
              reason: "Settled.",
              // Cleanup reports the path it was given, which may run through a symlinked folder.
              path: root.replace(/^\/private\/var\//, "/var/"),
              threadId: null,
              threadTitle: null,
              bytes: null,
              files: null,
            },
          ],
          counts: { removed: 1, kept: 0, failed: 0 },
          omittedCount: 0,
          bytesFreed: 0,
        });
        yield* Fiber.join(deleted);
        yield* Deferred.await(interrupted);
        assert.strictEqual(yield* reviewCount, 0);
      }),
    ),
  );

  it.live("forgets every Review of a removed project", () =>
    run((_root, triggers, reviewer) =>
      Effect.gen(function* () {
        const { interrupted, deleted } = yield* reviewWithRunningPass(reviewer);
        yield* Deferred.succeed(triggers.ready, undefined);
        yield* Queue.offer(triggers.applicationEvents, {
          sequence: 1,
          aggregateKind: "project",
          aggregateId: PROJECT_ID,
          type: "project.deleted",
          payload: { projectId: PROJECT_ID, deletedAt: "2026-10-17T00:00:00.000Z" },
        } as unknown as ApplicationStoredEvent);
        yield* Fiber.join(deleted);
        yield* Deferred.await(interrupted);
        assert.strictEqual(yield* reviewCount, 0);
      }),
    ),
  );

  it.live("sweeps Reviews whose worktree disappeared while the server was down", () =>
    run((root, triggers, reviewer) =>
      Effect.gen(function* () {
        const { interrupted, deleted } = yield* reviewWithRunningPass(reviewer);
        NodeFS.rmSync(root, { recursive: true, force: true });
        yield* Deferred.succeed(triggers.ready, undefined);
        yield* Fiber.join(deleted);
        yield* Deferred.await(interrupted);
        assert.strictEqual(yield* reviewCount, 0);
      }),
    ),
  );
});
