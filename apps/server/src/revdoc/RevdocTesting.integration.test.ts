import { assert, describe, it } from "@effect/vitest";
import {
  type ApplicationStoredEvent,
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RevdocPass,
  type StorageCleanupReport,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as RevdocLifecycleReactor from "./RevdocLifecycleReactor.ts";
import * as RevdocService from "./RevdocService.ts";
import { UNRECORDED_IN_SECTION } from "./RevdocTesting.ts";
import { makeDeterministicProvider, type StartedTurn } from "./testkit/deterministicProvider.ts";
import {
  awaitPass,
  fakeReviewer,
  layerRevdoc,
  makeRepository,
  PROJECT_ID,
  target,
  THREAD_ID,
  writeFile,
} from "./testing/revdocService.test.helpers.ts";

const codex = ProviderInstanceId.make("codex");
const selection = { instanceId: codex, model: "gpt-5.4" };

interface Turns {
  readonly started: Ref.Ref<ReadonlyArray<StartedTurn>>;
  /** Every turn waits on its own gate, keyed by thread and run ordinal, until the test opens it. */
  readonly gates: Map<string, Deferred.Deferred<void>>;
}

const gateFor = (turns: Turns, threadId: ThreadId, ordinal: number) => {
  const key = `${threadId}:${ordinal}`;
  let gate = turns.gates.get(key);
  if (!gate) {
    gate = Deferred.makeUnsafe<void>();
    turns.gates.set(key, gate);
  }
  return gate;
};

const open = (turns: Turns, threadId: ThreadId, ordinal: number) =>
  Deferred.succeed(gateFor(turns, threadId, ordinal), undefined);

const layerStack = (root: string, turns: Turns) => {
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
    makeDeterministicProvider({
      instanceId: codex,
      driver: ProviderDriverKind.make("codex"),
      capabilities: CodexProviderCapabilitiesV2,
      startedTurns: turns.started,
      gate: (turn) => Deferred.await(gateFor(turns, turn.threadId, turn.runOrdinal)),
      response: (turn) =>
        turn.threadId === THREAD_ID ? "Starting Revdoc testing." : "Section tested.",
    }),
  ]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    {
      name: "revdoc-test-pass",
      runtimePolicyOverride: {
        cwd: root,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      },
    },
    layerRegistry,
  );
  const threadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  );
  const reactor = RevdocLifecycleReactor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(StorageCleanup.StorageCleanup)({
          reports: Stream.never as Stream.Stream<StorageCleanupReport | null>,
        }),
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(0),
          streamApplicationEvents: () => Stream.never as Stream.Stream<ApplicationStoredEvent>,
        }),
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({ awaitCommandReady: Effect.never }),
      ),
    ),
  );
  const closedPreviews: Array<ThreadId> = [];
  const layer = reactor.pipe(
    Layer.provideMerge(
      layerRevdoc({
        root,
        reviewer: {
          current: (prompt) =>
            Effect.succeed(fakeReviewer(prompt)).pipe(
              // One area per file, so each check is its own testing section.
              Effect.map((output) => ({
                ...output,
                items: output.items.map((item) => ({ ...item, area: item.coveredPaths[0]! })),
              })),
            ),
        },
        threadManagement,
        closedPreviews,
      }),
    ),
    Layer.provideMerge(layerOrchestrator),
  );
  return { layer, closedPreviews };
};

const setup = (root: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:revdoc-parent:create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Revdoc parent",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: root,
    });
    const revdoc = yield* RevdocService.RevdocService;
    yield* awaitPass((yield* revdoc.generate(target())).passId);
    return (yield* revdoc.read(target(), { attentionOnly: false })).items;
  });

/** The running test pass once its child thread exists. */
const awaitChild = (passId: string) =>
  Effect.flatMap(RevdocService.RevdocService, (revdoc) =>
    revdoc.subscribe(target()).pipe(
      Stream.map((event): RevdocPass | null | undefined =>
        event._tag === "snapshot"
          ? event.snapshot.activePass
          : event._tag === "delta"
            ? event.activePass
            : undefined,
      ),
      Stream.filter(
        (pass): pass is RevdocPass => pass?.id === passId && pass.testing?.childThreadId != null,
      ),
      Stream.runHead,
      Effect.map((pass) =>
        pass._tag === "Some" ? pass.value.testing!.childThreadId! : (null as never),
      ),
    ),
  );

const makeTurns = Effect.gen(function* () {
  return {
    started: yield* Ref.make<ReadonlyArray<StartedTurn>>([]),
    gates: new Map<string, Deferred.Deferred<void>>(),
  } satisfies Turns;
});

describe("Revdoc test pass as a delegated task", () => {
  it.live("kicks off an idle parent once and runs each section as a turn of one child", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    writeFile(root, "b.ts", "b\n");
    return Effect.gen(function* () {
      const turns = yield* makeTurns;
      const { layer, closedPreviews } = layerStack(root, turns);
      yield* Effect.gen(function* () {
        const revdoc = yield* RevdocService.RevdocService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const [a, b] = yield* setup(root);
        const { passId } = yield* revdoc.test({ ...target(), selection: "remaining" });
        const childThreadId = yield* awaitChild(passId);
        yield* open(turns, THREAD_ID, 1);

        yield* revdoc.recordResult(
          {
            passId,
            itemId: a!.id,
            state: "passed",
            method: "command",
            steps: "cat a.ts",
            observed: "a",
          },
          childThreadId,
        );
        yield* open(turns, childThreadId, 1);
        // Section two is not recorded, so it is blocked when its turn ends.
        yield* open(turns, childThreadId, 2);
        const pass = yield* awaitPass(passId);
        assert.strictEqual(pass.status, "completed");

        const items = new Map(
          (yield* revdoc.read(target(), { attentionOnly: false })).items.map((item) => [
            item.id,
            item,
          ]),
        );
        assert.strictEqual(items.get(a!.id)?.result?.state, "passed");
        assert.deepInclude(items.get(b!.id)?.result, {
          state: "blocked",
          observed: UNRECORDED_IN_SECTION,
        });

        const started = yield* Ref.get(turns.started);
        assert.deepStrictEqual(
          started.filter((turn) => turn.threadId === THREAD_ID).map((turn) => turn.text),
          [
            "Revdoc is starting AI testing for 2 checks as a delegated task. Reply with one short line and take no other action.",
          ],
        );
        const childTurns = started.filter((turn) => turn.threadId === childThreadId);
        assert.deepStrictEqual(
          childTurns.map((turn) => /section (\d) of 2/.exec(turn.text)?.[1]),
          ["1", "2"],
        );
        const parent = yield* threads.getThreadProjection(THREAD_ID);
        assert.strictEqual(parent.runs.length, 1);
        assert.deepStrictEqual(
          parent.subagents
            .filter((task) => task.childThreadId === childThreadId)
            .map((task) => task.completionDelivery?.state),
          ["disposed", "disposed"],
        );
        const child = yield* threads.getThreadProjection(childThreadId);
        assert.strictEqual(child.thread.worktreePath, root);
        assert.deepStrictEqual(closedPreviews, [childThreadId, childThreadId]);
      }).pipe(Effect.provide(layer));
    });
  });

  it.live("delegates under an agent's active run and wakes it when testing ends", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    return Effect.gen(function* () {
      const turns = yield* makeTurns;
      const { layer } = layerStack(root, turns);
      yield* Effect.gen(function* () {
        const revdoc = yield* RevdocService.RevdocService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* setup(root);
        yield* threads.sendToThread({
          projectId: PROJECT_ID,
          commandId: CommandId.make("command:revdoc-parent:work"),
          threadId: THREAD_ID,
          messageId: MessageId.make("message:revdoc-parent:work"),
          text: "Build it, then test it with Revdoc.",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        const { passId } = yield* revdoc.test(
          { ...target(), selection: "remaining" },
          { threadId: THREAD_ID },
        );
        const childThreadId = yield* awaitChild(passId);
        const parent = yield* threads.getThreadProjection(THREAD_ID);
        assert.strictEqual(parent.runs.length, 1);
        assert.deepStrictEqual(
          parent.subagents
            .filter((task) => task.childThreadId === childThreadId)
            .map((task) => task.completionWake),
          ["always"],
        );
        const started = yield* Ref.get(turns.started);
        assert.isFalse(started.some((turn) => turn.text.startsWith("Revdoc is starting")));
        yield* open(turns, childThreadId, 1);
        assert.strictEqual((yield* awaitPass(passId)).status, "completed");
      }).pipe(Effect.provide(layer));
    });
  });

  it.live(
    "keeps recorded results when testing is stopped from Revdoc or from the child thread",
    () => {
      const root = makeRepository();
      writeFile(root, "a.ts", "a\n");
      writeFile(root, "b.ts", "b\n");
      return Effect.gen(function* () {
        const turns = yield* makeTurns;
        const { layer } = layerStack(root, turns);
        yield* Effect.gen(function* () {
          const revdoc = yield* RevdocService.RevdocService;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const [a, b] = yield* setup(root);
          const first = yield* revdoc.test({ ...target(), selection: "remaining" });
          const firstChild = yield* awaitChild(first.passId);
          yield* open(turns, THREAD_ID, 1);
          yield* revdoc.recordResult(
            {
              passId: first.passId,
              itemId: a!.id,
              state: "failed",
              method: "command",
              steps: "run",
              observed: "boom",
            },
            firstChild,
          );
          yield* revdoc.cancel(target());
          const cancelled = yield* awaitPass(first.passId);
          assert.deepInclude(cancelled, { status: "cancelled" });
          assert.strictEqual(cancelled.report?.notReached, 1);
          let items = new Map(
            (yield* revdoc.read(target(), { attentionOnly: false })).items.map((item) => [
              item.id,
              item,
            ]),
          );
          assert.strictEqual(items.get(a!.id)?.result?.observed, "boom");
          assert.isNull(items.get(b!.id)?.result);

          // Retry remaining: the failed check and the unreached one.
          const second = yield* revdoc.test({ ...target(), selection: "remaining" });
          const secondChild = yield* awaitChild(second.passId);
          yield* open(turns, THREAD_ID, 2);
          yield* threads.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("command:upstream-stop"),
            threadId: secondChild,
          });
          assert.strictEqual((yield* awaitPass(second.passId)).status, "cancelled");
          items = new Map(
            (yield* revdoc.read(target(), { attentionOnly: false })).items.map((item) => [
              item.id,
              item,
            ]),
          );
          assert.strictEqual(items.get(a!.id)?.result?.observed, "boom");
        }).pipe(Effect.provide(layer));
      });
    },
  );
});
