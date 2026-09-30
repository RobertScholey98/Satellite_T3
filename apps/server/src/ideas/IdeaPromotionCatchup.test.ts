import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  IdeaArtifactId,
  IdeaCategoryId,
  IdeaEntryId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProcessRunner } from "../processRunner.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { IdeaRuntime } from "./IdeaRuntime.ts";
import { IdeaUpdateReactor } from "./IdeaUpdateReactor.ts";
import { IDEA_UPDATE_INSTRUCTIONS } from "./IdeaUpdateGeneration.ts";

const threadId = ThreadId.make("promotion-catchup");
const projectId = ProjectId.make("catchup-project");
const instanceId = ProviderInstanceId.make("claude");
const driverKind = ProviderDriverKind.make("claude");
const answerId = EventId.make("answer-activity");
const now = "2026-09-30T12:00:00.000Z";
const unused = () => Effect.die("Unexpected provider operation in catch-up test");
const decodeContextDocuments = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      documents: Schema.Array(
        Schema.Struct({ id: Schema.String, text: Schema.String, truncated: Schema.Boolean }),
      ),
    }),
  ),
);

const runCatchup = Effect.fn(function* (
  outcome: "success" | "failed" | "too-large" | "manual-title" | "markdown-study" | "html-study",
) {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let prompt = "";
  let calls = 0;
  let studyArtifactId: IdeaArtifactId | undefined;
  const hasStudy = outcome === "markdown-study" || outcome === "html-study";
  const studyLine =
    outcome === "html-study"
      ? '<section data-case="creation"><h2>Creation flow</h2><p>One thread per idea. Preserve manual edits and review before promotion.</p></section>\n'
      : "## Creation flow\nOne thread per idea. Preserve manual edits and review before promotion.\n";
  const studyText = studyLine.repeat(2000).slice(0, 99_983) + "END_OF_DESIGN_STUDY";
  const provider: ProviderInstance = {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: "catchup" },
    displayName: "Claude",
    enabled: true,
    snapshot: {
      resolveMaintenance: unused,
      getSnapshot: unused(),
      refresh: unused(),
      streamChanges: Stream.empty,
      applyUsageLimits: unused,
    },
    adapter: {
      provider: driverKind,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession: unused,
      sendTurn: unused,
      interruptTurn: unused,
      respondToRequest: unused,
      respondToUserInput: unused,
      stopSession: unused,
      listSessions: () => Effect.succeed([]),
      hasSession: () => Effect.succeed(false),
      readThread: unused,
      rollbackThread: unused,
      stopAll: unused,
      streamEvents: Stream.empty,
    },
    textGeneration: {
      generateBranchName: unused,
      generateCommitMessage: unused,
      generatePrContent: unused,
      generateThreadTitle: unused,
      generateIdeaUpdate: (input) =>
        Effect.gen(function* () {
          calls++;
          prompt = input.prompt;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          if (outcome === "failed")
            return yield* new TextGenerationError({
              operation: "generateIdeaUpdate",
              detail: "Controlled generation failure",
            });
          return {
            summary: "Saved the answered question.",
            title: "Idea notebook",
            edits: [
              {
                kind: "entry.save" as const,
                id: IdeaEntryId.make("discussion"),
                categoryId: IdeaCategoryId.make("notes"),
                title: "Thread ownership",
                baseRevision: 0,
                markdown: "One thread per idea.",
                sources: [
                  { kind: "activity" as const, activityId: answerId },
                  ...(studyArtifactId
                    ? [{ kind: "artifact" as const, artifactId: studyArtifactId }]
                    : []),
                ],
              },
              {
                kind: "pitch.save" as const,
                baseRevision: 0,
                markdown: "Caught up: one thread per idea.",
              },
            ],
          };
        }),
    },
  };
  const nativeFs = yield* FileSystem.FileSystem;
  const isPromotionSkill = (path: string) =>
    path.replaceAll("\\", "/").endsWith("/to-issues/SKILL.md");
  const fsLayer = Layer.succeed(FileSystem.FileSystem, {
    ...nativeFs,
    exists: (path) => (isPromotionSkill(path) ? Effect.succeed(true) : nativeFs.exists(path)),
    readFileString: (path, ...args) =>
      isPromotionSkill(path)
        ? Effect.succeed("Review self-contained issue drafts before publication.")
        : nativeFs.readFileString(path, ...args),
  });
  const layer = IdeaUpdateReactor.layer.pipe(
    Layer.provideMerge(IdeaRuntime.layer),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(IdeaNotebookStore.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          ideaUpdatesModelSelection: { instanceId, model: "haiku" },
        }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry)({
        listInstances: Effect.succeed([provider]),
        getInstance: () => Effect.succeed(provider),
      }),
    ),
    Layer.provide(Layer.succeed(ProcessRunner, { run: unused })),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "idea-catchup-" })),
    Layer.provide(fsLayer),
  );
  yield* Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const store = yield* IdeaNotebookStore;
    const updates = yield* IdeaUpdateReactor;
    const runtime = yield* IdeaRuntime;
    const snapshots = yield* ProjectionSnapshotQuery;
    const config = yield* ServerConfig;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("project"),
      projectId,
      title: "Project",
      workspaceRoot: config.stateDir,
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("idea"),
      threadId,
      projectId,
      purpose: "idea",
      title: "Catch up notebook",
      modelSelection: { instanceId, model: "sonnet" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    yield* updates.start();
    yield* engine.dispatch({
      type: "thread.message.user.append",
      commandId: CommandId.make("promote-message"),
      threadId,
      message: {
        messageId: MessageId.make("promote"),
        text:
          outcome === "too-large"
            ? "x".repeat(200_001)
            : hasStudy
              ? "Discuss the design, then /promote. ".repeat(600)
              : "/promote",
        attachments: [],
      },
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("question"),
      threadId,
      createdAt: now,
      activity: {
        id: EventId.make("question-activity"),
        kind: "user-input.requested",
        summary: "Choose ownership",
        tone: "info",
        turnId: null,
        createdAt: now,
        payload: {
          requestId: "ownership",
          questions: [{ id: "q", question: "How many threads per idea?" }],
        },
      },
    });
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("answer"),
      threadId,
      createdAt: now,
      activity: {
        id: answerId,
        kind: "user-input.resolved",
        summary: "Ownership answered",
        tone: "info",
        turnId: null,
        createdAt: now,
        payload: { requestId: "ownership", answers: { q: "One thread per idea" } },
      },
    });
    if (hasStudy) {
      yield* engine.dispatch({
        type: "idea.edit",
        commandId: CommandId.make("existing-note"),
        threadId,
        edit: {
          kind: "entry.save",
          id: IdeaEntryId.make("existing"),
          categoryId: IdeaCategoryId.make("notes"),
          title: "Earlier discussion",
          baseRevision: 0,
          markdown: "Keep the user in control. ".repeat(200),
          sources: [],
        },
      });
      const artifact = yield* runtime.writeArtifact({
        threadId,
        name: outcome === "html-study" ? "ux-study.html" : "ux-study.md",
        mediaType: outcome === "html-study" ? "text/html" : "text/markdown",
        contentBase64: Buffer.from(studyText).toString("base64"),
      });
      studyArtifactId = artifact.id;
    }
    const requested = yield* engine.latestSequence;
    const result = yield* runtime
      .readContext({ threadId, resource: "promote" })
      .pipe(Effect.result, Effect.forkScoped);
    if (outcome !== "too-large") {
      yield* Deferred.await(started);
      assert.equal((yield* store.requireActive(threadId)).update.status, "running");
      assert.include(prompt, "How many threads per idea?");
      assert.include(prompt, "One thread per idea");
      assert.include(prompt, '"activityId":"answer-activity"');
      if (hasStudy) {
        const context = yield* decodeContextDocuments(
          prompt.slice(IDEA_UPDATE_INSTRUCTIONS.length + 2),
        );
        const supplied = context.documents.find((document) => document.id === studyArtifactId);
        assert.equal(supplied?.text, studyText);
        assert.equal(supplied?.truncated, false);
        assert.isAtLeast(Buffer.byteLength(studyText), 100_000);
        assert.include(prompt, "Keep the user in control");
        assert.isBelow(Buffer.byteLength(prompt), 180_001);
      }
      if (outcome === "manual-title")
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("manual-rename"),
          threadId,
          title: "My handwritten title",
        });
      yield* Deferred.succeed(release, undefined);
    }
    const completed = yield* Fiber.join(result);
    yield* updates.drain;
    const notebook = yield* store.requireActive(threadId);
    if (outcome === "success" || outcome === "manual-title" || hasStudy) {
      assert.equal(completed._tag, "Success");
      if (completed._tag === "Success") {
        assert.include(completed.success, "Caught up: one thread per idea.");
        assert.include(completed.success, "Review self-contained issue drafts");
      }
      assert.equal(notebook.update.status, "current");
      const shell = yield* snapshots.getThreadShellById(threadId);
      assert.equal(
        shell._tag === "Some" ? shell.value.title : null,
        outcome === "manual-title" ? "My handwritten title" : "Idea notebook",
      );
      assert.isAtLeast(notebook.update.processedSequence, requested);
      assert.deepEqual(notebook.entries.find((entry) => entry.id === "discussion")?.sources, [
        { kind: "activity", activityId: answerId },
        ...(studyArtifactId ? [{ kind: "artifact" as const, artifactId: studyArtifactId }] : []),
      ]);
      const history = yield* runtime.readContext({ threadId, resource: "history" });
      assert.include(history, "How many threads per idea?");
      assert.include(history, "One thread per idea");
    } else {
      assert.equal(completed._tag, "Failure");
      assert.equal(notebook.update.status, "failed");
      assert.equal(notebook.update.processedSequence, 0);
      assert.equal(notebook.pitch.markdown, "");
      if (outcome === "too-large") assert.equal(calls, 0);
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "/promote catches up question answers during its own turn before handing off the pitch",
  () => runCatchup("success").pipe(Effect.provide(NodeServices.layer)),
);
it.effect("/promote reports failed notebook generation without handing off stale context", () =>
  runCatchup("failed").pipe(Effect.provide(NodeServices.layer)),
);
it.effect("a manual title entered during the first notebook update is preserved", () =>
  runCatchup("manual-title").pipe(Effect.provide(NodeServices.layer)),
);
it.effect(
  "a 100 KB Markdown study participates with discussion and notes before the cursor advances",
  () => runCatchup("markdown-study").pipe(Effect.provide(NodeServices.layer)),
);
it.effect(
  "a 100 KB HTML study participates with discussion and notes before the cursor advances",
  () => runCatchup("html-study").pipe(Effect.provide(NodeServices.layer)),
);
it.effect(
  "oversized new discussion remains unprocessed instead of falsely marking the notebook current",
  () => runCatchup("too-large").pipe(Effect.provide(NodeServices.layer)),
);
