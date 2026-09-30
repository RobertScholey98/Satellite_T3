import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";

const now = "2026-09-30T12:00:00.000Z";
const threadId = ThreadId.make("idea-one");
const projectId = ProjectId.make("project-one");
const layer = OrchestrationLayerLive.pipe(
  Layer.provideMerge(IdeaNotebookStore.layer),
  Layer.provide(
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-idea-store-" })),
  Layer.provideMerge(NodeServices.layer),
);
const create = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/ideas-test",
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-idea"),
    threadId,
    projectId,
    purpose: "idea",
    title: "Idea",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  });
});

it.effect("creates the thread and notebook together while keeping normal navigation quiet", () =>
  Effect.gen(function* () {
    yield* create;
    const store = yield* IdeaNotebookStore;
    const snapshots = yield* ProjectionSnapshotQuery;
    assert.equal((yield* store.get(threadId))?.pitch.markdown, "");
    assert.equal((yield* store.list())[0]?.threadId, threadId);
    assert.equal((yield* snapshots.getShellSnapshot()).threads.length, 0);
    assert.equal((yield* snapshots.searchThreads({ query: "Idea" })).matches.length, 0);
    const detail = yield* snapshots.getThreadDetailById(threadId);
    assert.equal(Option.getOrThrow(detail).purpose, "idea");
  }).pipe(Effect.provide(layer)),
);

it.effect("deduplicates notebook edits through the existing command receipt", () =>
  Effect.gen(function* () {
    yield* create;
    const store = yield* IdeaNotebookStore;
    const engine = yield* OrchestrationEngineService;
    const command = {
      type: "idea.edit" as const,
      commandId: CommandId.make("edit-pitch"),
      threadId,
      edit: { kind: "pitch.save" as const, markdown: "A durable pitch", baseRevision: 0 },
    };
    const first = yield* engine.dispatch(command);
    const second = yield* engine.dispatch(command);
    assert.equal(first.sequence, second.sequence);
    assert.equal((yield* store.get(threadId))?.pitch.revision, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("rebuilds a pending deletion without losing its durable cleanup job", () =>
  Effect.gen(function* () {
    yield* create;
    const engine = yield* OrchestrationEngineService;
    const store = yield* IdeaNotebookStore;
    const sql = yield* SqlClient.SqlClient;
    const pipeline = yield* OrchestrationProjectionPipeline;
    yield* engine.dispatch({ type: "idea.delete", threadId, commandId: CommandId.make("delete") });
    yield* sql`DELETE FROM projection_idea_notebooks`;
    yield* sql`DELETE FROM projection_state WHERE projector = 'projection.ideas'`;
    yield* pipeline.bootstrap;
    assert.equal((yield* store.pending())[0]?.status, "deleting");
    assert.equal(yield* store.isDeleted(threadId), true);
  }).pipe(Effect.provide(layer)),
);

it.effect("purges content and keeps a permanent fence across projection replay", () =>
  Effect.gen(function* () {
    yield* create;
    const engine = yield* OrchestrationEngineService;
    const store = yield* IdeaNotebookStore;
    const events = yield* OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const pipeline = yield* OrchestrationProjectionPipeline;
    yield* engine.dispatch({
      type: "idea.edit",
      threadId,
      commandId: CommandId.make("secret"),
      edit: { kind: "pitch.save", baseRevision: 0, markdown: "Secret notebook content" },
    });
    yield* engine.dispatch({ type: "idea.delete", threadId, commandId: CommandId.make("delete") });
    const late = yield* engine
      .dispatch({
        type: "idea.edit",
        threadId,
        commandId: CommandId.make("late"),
        edit: { kind: "pitch.save", baseRevision: 1, markdown: "Late data" },
      })
      .pipe(Effect.flip);
    assert.include(late.message, "deleted");
    yield* engine.dispatch({
      type: "idea.purge",
      threadId,
      commandId: CommandId.make("purge"),
      deletionEpoch: 1,
    });
    assert.equal(yield* store.get(threadId), null);
    const retained = yield* Stream.runCollect(events.readAll());
    assert.deepEqual(
      retained.filter((event) => event.aggregateKind === "thread").map((event) => event.type),
      ["idea.purged"],
    );
    assert.equal(
      (yield* sql`SELECT * FROM projection_threads WHERE thread_id = ${threadId}`).length,
      0,
    );
    yield* sql`DELETE FROM projection_state`;
    yield* pipeline.bootstrap;
    assert.equal(yield* store.get(threadId), null);
    assert.equal(yield* store.isDeleted(threadId), true);
    const recreated = yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make("recreate"),
        threadId,
        projectId,
        title: "Resurrection",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      })
      .pipe(Effect.flip);
    assert.include(recreated.message, "deleted");
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["message", "native answer"] as const)(
  "invalidates approved issues immediately after a %s and waits for the completed foreground turn",
  (input) =>
    Effect.gen(function* () {
      yield* create;
      const engine = yield* OrchestrationEngineService;
      const store = yield* IdeaNotebookStore;
      const promotion = {
        target: { host: "github.com", repository: "example/repo" },
        id: "plan",
        sourceRevision: 0,
        status: "review" as const,
        drafts: [{ id: "one", title: "Build", body: "Requirements", labels: [] }],
        issues: [],
        remainingScope: "",
        error: null,
      };
      yield* engine.dispatch({
        type: "idea.apply",
        threadId,
        commandId: CommandId.make("propose"),
        deletionEpoch: 0,
        mutation: { kind: "promotion.propose", promotion },
      });
      yield* engine.dispatch({
        type: "idea.edit",
        threadId,
        commandId: CommandId.make("approve"),
        edit: { kind: "promotion.approve", id: "plan", sourceRevision: 0 },
      });
      if (input === "message")
        yield* engine.dispatch({
          type: "thread.message.user.append",
          threadId,
          commandId: CommandId.make("new-input"),
          message: {
            messageId: MessageId.make("next-message"),
            text: "Change the creation flow",
            attachments: [],
          },
          createdAt: now,
        });
      else
        yield* engine.dispatch({
          type: "thread.user-input.respond",
          threadId,
          commandId: CommandId.make("new-input"),
          requestId: ApprovalRequestId.make("creation-choice"),
          answers: { creation: "Use a dedicated conversation" },
          createdAt: now,
        });
      const waiting = yield* store.get(threadId);
      assert.equal(waiting?.update.status, "waiting");
      assert.equal(waiting?.contentRevision, 1);
      assert.notEqual(waiting?.promotion?.sourceRevision, waiting?.contentRevision);
      assert.equal((yield* store.pending())[0]?.update.status, "waiting");
      const session = {
        threadId,
        status: "ready" as const,
        providerName: "claudeAgent",
        runtimeMode: "approval-required" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      };
      yield* engine.dispatch({
        type: "thread.session.set",
        threadId,
        commandId: CommandId.make("ready"),
        session,
        createdAt: now,
      });
      assert.equal((yield* store.get(threadId))?.update.status, "waiting");
      const settled = yield* engine.dispatch({
        type: "thread.session.set",
        threadId,
        commandId: CommandId.make("settled"),
        session,
        turnSettled: true,
        createdAt: now,
      });
      assert.equal((yield* store.pending())[0]?.update.requestedSequence, settled.sequence);
    }).pipe(Effect.provide(layer)),
);
