import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  IdeaArtifactId,
  IdeaCategoryId,
  IdeaEntryId,
  IdeaNotebook,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type IdeaArtifact,
  type IdeaSource,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import {
  layer as SatelliteTestLayer,
  makeProviderAdapter,
  recordCompletedRun,
  recordMessage,
  recordProject,
} from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import {
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
} from "../orchestration-v2/SatelliteOrchestration.ts";
import * as LegacyImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { createIdeaNotebook } from "./IdeaNotebook.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { IdeaRuntime } from "./IdeaRuntime.ts";
import { IdeaUpdateReactor } from "./IdeaUpdateReactor.ts";
import { type IdeaUpdateResult, validateIdeaUpdateSources } from "./IdeaUpdateGeneration.ts";
import { readIdeaUpdateSources } from "./IdeaUpdateSources.ts";

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("update-regression-project");
const now = "2026-09-30T12:00:00.000Z";
const unused = () => Effect.die("Unexpected provider operation in idea update regression");
const encodeNotebook = Schema.encodeEffect(Schema.fromJsonString(IdeaNotebook));
const infrastructure = Layer.mergeAll(
  SatelliteTestLayer,
  LegacyImporter.layer.pipe(Layer.provide(SatelliteTestLayer)),
);
const updaterLayer = (generate: (prompt: string) => Effect.Effect<IdeaUpdateResult>) =>
  IdeaUpdateReactor.layer.pipe(
    Layer.provideMerge(infrastructure),
    Layer.provide(
      Layer.mock(IdeaRuntime)({
        workingDirectory: () => Effect.succeed("C:/isolated-idea"),
        readArtifact: () =>
          Effect.succeed({
            artifact: artifact,
            contentBase64: Buffer.from("The retained design document.").toString("base64"),
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          ideaUpdatesModelSelection: { instanceId, model: "test" },
        }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.succeed({
            instanceId,
            driverKind: ProviderDriverKind.make("codex"),
            continuationIdentity: {
              driverKind: ProviderDriverKind.make("codex"),
              continuationKey: "idea-regression",
            },
            displayName: "Codex",
            enabled: true,
            snapshot: {
              resolveMaintenance: unused,
              getSnapshot: unused(),
              refresh: unused(),
              streamChanges: Stream.empty,
              applyUsageLimits: unused,
            },
            orchestrationAdapter: makeProviderAdapter(instanceId),
            textGeneration: {
              generateCommitMessage: unused,
              generatePrContent: unused,
              generateBranchName: unused,
              generateThreadTitle: unused,
              generateIdeaUpdate: ({ prompt }) => generate(prompt),
            },
          }),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const awaitUpdate = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const stream = yield* engine.subscribeDomainEvents;
  return yield* stream.pipe(
    Stream.filter(
      (event) =>
        event.type === "idea.changed" &&
        ["update.apply", "update.fail"].includes(event.payload.mutation.kind),
    ),
    Stream.take(1),
    Stream.runCollect,
    Effect.forkScoped,
  );
});

it.effect.each(["initial", "before", "during", "same-text", "away-and-back", "older-v2"] as const)(
  "preserves title ownership when renamed $case relative to the first update",
  (rename) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const updates = yield* IdeaUpdateReactor;
        const store = yield* IdeaNotebookStore;
        const threadId = ThreadId.make("title-regression-idea");
        yield* recordProject({ projectId, title: "Project", workspaceRoot: "C:/isolated-project" });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId,
          purpose: "idea",
          title: "Untitled idea",
          modelSelection: { instanceId, model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const manualRename = (title: string, commandId = "manual-rename") =>
          engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(commandId),
            threadId,
            title,
          });
        if (rename === "before") yield* manualRename("My manual title");
        if (rename === "older-v2") {
          const projections = yield* ProjectionStoreV2;
          const sink = yield* EventSinkV2;
          const { titleState: _titleState, ...oldThread } = (yield* projections.getThreadProjection(
            threadId,
          )).thread;
          yield* sink.write({
            commandId: CommandId.make("older-v2-rename"),
            events: [
              {
                id: EventId.make("older-v2-rename-event"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: yield* DateTime.now,
                payload: { ...oldThread, title: "My older V2 title" },
              },
            ],
          });
        }
        yield* recordMessage({
          threadId,
          messageId: MessageId.make("title-message"),
          role: "user",
          text: "Explore the idea",
        });
        const finished = yield* awaitUpdate;
        yield* updates.start();
        yield* recordCompletedRun(threadId);
        yield* Deferred.await(started);
        if (rename === "during") yield* manualRename("My manual title");
        if (rename === "same-text") yield* manualRename("Untitled idea");
        if (rename === "away-and-back") {
          yield* manualRename("Interim title");
          yield* manualRename("Untitled idea", "manual-rename-back");
        }
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(finished);
        yield* updates.drain;
        assert.equal((yield* store.requireActive(threadId)).update.status, "current");
        const shell = yield* snapshots.getThreadShellById(threadId);
        assert.isTrue(Option.isSome(shell));
        if (Option.isNone(shell)) return;
        assert.equal(
          shell.value.title,
          rename === "initial"
            ? "Generated title"
            : rename === "older-v2"
              ? "My older V2 title"
              : ["before", "during"].includes(rename)
                ? "My manual title"
                : "Untitled idea",
        );
        assert.equal(
          shell.value.titleState?.source,
          rename === "initial" ? "generated" : rename === "older-v2" ? undefined : "manual",
        );
        if (rename === "away-and-back")
          assert.equal(shell.value.titleState?.version, "manual-rename-back");
      }).pipe(
        Effect.provide(
          updaterLayer(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return { edits: [], summary: "Updated", title: "Generated title" };
            }),
          ),
        ),
      );
    }),
);

const artifact: IdeaArtifact = {
  id: IdeaArtifactId.make("legacy-document"),
  name: "design.md",
  mediaType: "text/markdown",
  sizeBytes: 29,
  revision: 0,
  createdAt: now,
  source: "upload",
};

it.effect(
  "continues a migrated notebook using retained message, question and document citations",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
      const engine = yield* OrchestrationEngineService;
      const updates = yield* IdeaUpdateReactor;
      const store = yield* IdeaNotebookStore;
      const snapshots = yield* ProjectionSnapshotQuery;
      const threadId = ThreadId.make("migrated-update-idea");
      const messageId = MessageId.make("legacy-message");
      const activityId = EventId.make("legacy-answer");
      const sources: readonly IdeaSource[] = [
        { kind: "message", messageId },
        { kind: "activity", activityId },
        { kind: "artifact", artifactId: artifact.id },
      ];
      const notebook = {
        ...createIdeaNotebook(threadId, now),
        entries: [
          {
            id: IdeaEntryId.make("retained-note"),
            categoryId: IdeaCategoryId.make("notes"),
            title: "Retained note",
            document: {
              markdown: "Saved design",
              revision: 1,
              author: "user" as const,
              updatedAt: now,
            },
            sources,
          },
        ],
        artifacts: [artifact],
        update: {
          status: "current" as const,
          processedSequence: 3,
          requestedSequence: 3,
          runId: null,
          error: null,
        },
        deletedEntries: [
          {
            id: IdeaEntryId.make("deleted-note"),
            title: "Deleted note",
            deletedAt: now,
            throughSequence: 3,
          },
        ],
      };
      yield* recordProject({ projectId, title: "Project", workspaceRoot: "C:/isolated-project" });
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, created_at, updated_at, purpose, title_state_json)
      VALUES (${threadId}, ${projectId}, 'My migrated title', '{"instanceId":"codex","model":"test"}',
        'full-access', 'default', ${now}, ${now}, 'idea', '{"source":"manual","version":"legacy-rename","needsRefinement":false}')`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, attachments_json,
      is_streaming, created_at, updated_at) VALUES (${messageId}, ${threadId}, 'user', 'The saved design discussion.', '[]', 0, ${now}, ${now})`;
      const records = [
        {
          type: "thread.message-sent",
          payload: {
            threadId,
            messageId,
            role: "user",
            text: "The saved design discussion.",
            streaming: false,
          },
        },
        {
          type: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: activityId,
              tone: "info",
              kind: "user-input.answer-submitted",
              summary: "Answer",
              createdAt: now,
              turnId: null,
              payload: {
                requestId: "legacy-question",
                answers: { choice: ["Use the saved design"] },
              },
            },
          },
        },
        {
          type: "idea.changed",
          payload: { threadId, mutation: { kind: "artifact.register", artifact }, updatedAt: now },
        },
      ];
      for (const [index, record] of records.entries())
        yield* sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (${`legacy-source:${index}`}, 'thread', ${threadId}, ${index + 1}, ${record.type}, ${now}, 'server', ${JSON.stringify(record.payload)}, '{}')`;
      const encoded = yield* encodeNotebook(notebook);
      yield* sql`INSERT INTO projection_idea_notebooks (thread_id, revision, status, updated_at, excerpt, update_status, notebook_json)
      VALUES (${threadId}, 0, 'active', ${now}, '', 'current', ${encoded})`;
      const liveEvents = yield* engine.subscribeDomainEvents;
      const firstLiveEvent = yield* liveEvents.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* importer.reconcileShells;
      yield* importer.ensureTranscript(threadId);
      const history = yield* readIdeaUpdateSources(threadId, 3);
      const message = history.find((event) => event.type === "thread.message-sent");
      assert.equal(message?.sequence, 1);
      assert.equal(
        validateIdeaUpdateSources(
          notebook,
          [
            {
              kind: "entry.save",
              id: IdeaEntryId.make("recreated-note"),
              categoryId: IdeaCategoryId.make("notes"),
              title: "Recreated",
              baseRevision: 0,
              markdown: "Old evidence",
              sources: [{ kind: "message", messageId }],
            },
          ],
          new Map([["message:" + messageId, message?.sequence ?? 0]]),
        ),
        "A new note needs evidence newer than the deleted notes. Old discussion cannot recreate deleted notes.",
      );
      const finished = yield* awaitUpdate;
      yield* updates.start();
      yield* recordMessage({
        threadId,
        messageId: MessageId.make("new-message"),
        role: "user",
        text: "Refine the existing note.",
      });
      const first = (yield* Fiber.join(firstLiveEvent))[0];
      assert.equal(first?.type, "thread.message-sent");
      if (first?.type === "thread.message-sent")
        assert.equal(first.payload.messageId, "new-message");
      yield* recordCompletedRun(threadId);
      yield* Fiber.join(finished);
      yield* updates.drain;
      const updated = yield* store.requireActive(threadId);
      assert.equal(updated.update.status, "current");
      assert.equal(updated.entries[0]?.document.markdown, "Refined retained design");
      assert.deepEqual(updated.entries[0]?.sources, sources);
      assert.equal(
        Option.getOrThrow(yield* snapshots.getThreadShellById(threadId)).title,
        "My migrated title",
      );
    }).pipe(
      Effect.provide(
        updaterLayer((prompt) =>
          Effect.sync(() => {
            assert.include(prompt, "The saved design discussion.");
            assert.include(prompt, "Use the saved design");
            assert.include(prompt, "The retained design document.");
            return {
              summary: "Refined the existing design",
              title: "Generated title",
              edits: [
                {
                  kind: "entry.save",
                  id: IdeaEntryId.make("retained-note"),
                  categoryId: IdeaCategoryId.make("notes"),
                  title: "Retained note",
                  baseRevision: 1,
                  markdown: "Refined retained design",
                  sources: [
                    { kind: "message", messageId: MessageId.make("legacy-message") },
                    { kind: "activity", activityId: EventId.make("legacy-answer") },
                    { kind: "artifact", artifactId: artifact.id },
                  ],
                },
              ],
            };
          }),
        ),
      ),
    ),
);
