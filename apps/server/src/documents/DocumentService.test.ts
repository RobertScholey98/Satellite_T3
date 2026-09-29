import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import migration from "../persistence/Migrations/055_ManagedDocuments.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { makeDocumentService } from "./DocumentService.ts";

const integrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-documents-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const threadId = ThreadId.make("documents-thread");
const actor = "session:reviewer";
const createdAt = "2026-09-30T12:00:00.000Z";
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-documents-" });
  const sourcePath = path.join(stateDir, "source.html");
  yield* fs.writeFileString(
    sourcePath,
    "<!doctype html><h1>Original</h1><script>window.demo=true</script>",
  );
  const projectId = ProjectId.make("documents-project");
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId,
    title: "Documents",
    workspaceRoot: stateDir,
    createdAt,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-thread"),
    threadId,
    projectId,
    title: "Documents",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  const options = { stateDir, dispatch: engine.dispatch, getThread: projection.getThreadShellById };
  const service = yield* makeDocumentService(options);
  const publication = {
    threadId,
    title: "Review",
    kind: "review" as const,
    path: sourcePath,
    requestId: "publish-1",
    definition: { items: [{ id: "one", title: "First item" }] },
  };
  const detail = yield* service.publish(publication, actor);
  const draft = {
    documentId: detail.document.id,
    revisionId: detail.revision.id,
    expectedAnswerVersion: 0,
    requestId: "save-1",
    answers: [{ itemId: "one", outcome: "broken" as const, notes: "Please fix." }],
  };
  return {
    fs,
    path,
    engine,
    projection,
    stateDir,
    sourcePath,
    options,
    service,
    publication,
    detail,
    draft,
  };
});

describe("managed document persistence", () => {
  it.effect(
    "snapshots survive source changes and service restart, preserving revisions and answer history",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.saveDraft(f.draft, actor);
        yield* f.fs.writeFileString(f.sourcePath, "<h1>Replacement</h1>");
        const next = yield* f.service.publish(
          {
            ...f.publication,
            documentId: f.detail.document.id,
            expectedCurrentRevisionId: f.detail.revision.id,
            requestId: "publish-2",
          },
          actor,
        );
        assert.equal(next.answerVersion, 0);
        assert.equal(next.answers[0]?.outcome, "pending");
        const restarted = yield* makeDocumentService(f.options);
        const old = yield* restarted.get({
          documentId: f.detail.document.id,
          revisionId: f.detail.revision.id,
        });
        assert.include(old.content, "Original");
        assert.equal(old.answers[0]?.notes, "Please fix.");
        const history = yield* restarted.history({ documentId: f.detail.document.id });
        assert.equal(history.revisions.length, 2);
        assert.equal(
          history.events.find((event) => event.event === "draft-saved")?.answers?.[0]?.outcome,
          "broken",
        );
        assert.equal(history.events[0]?.actor, actor);
        const stale = yield* restarted
          .saveDraft({ ...f.draft, requestId: "historical", expectedAnswerVersion: 1 }, actor)
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        yield* f.fs.remove(f.sourcePath);
        assert.equal(
          (yield* restarted.publish(f.publication, actor)).revision.id,
          f.detail.revision.id,
        );
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          snapshot_path: string;
        }>`SELECT snapshot_path FROM document_revisions WHERE id=${f.detail.revision.id}`;
        yield* f.fs.writeFileString(
          f.path.join(f.stateDir, "documents", rows[0]!.snapshot_path),
          "altered",
        );
        assert.equal(
          (yield* restarted
            .get({ documentId: f.detail.document.id, revisionId: f.detail.revision.id })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect(
    "rejects stale answer versions and reused request payloads; draft saves never start turns",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        const saved = yield* f.service.saveDraft(f.draft, actor);
        assert.equal((yield* f.service.saveDraft(f.draft, actor)).answerVersion, 1);
        assert.equal(
          (yield* f.service
            .saveDraft({ ...f.draft, requestId: "other-device" }, "session:other")
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* f.service.saveDraft({ ...f.draft, answers: [] }, actor).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* f.service
            .publish({ ...f.publication, title: "Changed" }, actor)
            .pipe(Effect.result))._tag,
          "Failure",
        );
        const thread = yield* f.projection.getThreadDetailById(threadId);
        assert.equal(thread._tag, "Some");
        if (thread._tag === "Some") assert.equal(thread.value.messages.length, 0);
        assert.equal(saved.answers[0]?.notes, "Please fix.");
      }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect(
    "explicit submission freezes a receipt and delivers once through the real orchestration engine",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        const submission = yield* f.service.submit({ ...f.draft, requestId: "submit-1" }, actor);
        assert.equal(submission.delivery, "delivered");
        assert.include(submission.markdown, f.detail.revision.contentHash);
        assert.equal(
          (yield* f.service.submit({ ...f.draft, requestId: "submit-1" }, actor)).id,
          submission.id,
        );
        assert.equal(
          (yield* f.service.retry({ submissionId: submission.id }, actor)).id,
          submission.id,
        );
        assert.equal(
          (yield* f.service
            .saveDraft({ ...f.draft, expectedAnswerVersion: 1, requestId: "after-submit" }, actor)
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* f.service
            .submit({ ...f.draft, expectedAnswerVersion: 1, requestId: "resubmit" }, actor)
            .pipe(Effect.result))._tag,
          "Failure",
        );
        const thread = yield* f.projection.getThreadDetailById(threadId);
        if (thread._tag !== "Some") return assert.fail("Thread disappeared");
        assert.equal(thread.value.messages.length, 1);
        assert.include(thread.value.messages[0]!.text, "Please fix.");
        assert.equal(thread.value.modelSelection.model, "gpt-6.1-sol");
        const newer = yield* f.service.publish(
          {
            ...f.publication,
            documentId: f.detail.document.id,
            expectedCurrentRevisionId: f.detail.revision.id,
            requestId: "new-after-submit",
          },
          actor,
        );
        assert.equal(newer.document.status, "draft");
        assert.equal(newer.lastSubmission, null);
        assert.equal(newer.answers[0]?.outcome, "pending");
        const history = yield* f.service.history({ documentId: f.detail.document.id });
        assert.equal(history.submissions[0]?.answers[0]?.outcome, "broken");
      }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect(
    "retries a definitive engine rejection with a new durable attempt ID and retains accepted receipts",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        let rejectFirst = true;
        const commands: OrchestrationCommand[] = [];
        const service = yield* makeDocumentService({
          ...f.options,
          dispatch: (command) => {
            commands.push(command);
            if (rejectFirst && command.type === "thread.turn.start") {
              rejectFirst = false;
              return f.engine.dispatch({ ...command, threadId: ThreadId.make("missing-thread") });
            }
            return f.engine.dispatch(command);
          },
        });
        const failed = yield* service.submit({ ...f.draft, requestId: "submit-failed" }, actor);
        assert.equal(failed.delivery, "failed");
        const recovered = yield* service.retry({ submissionId: failed.id }, actor);
        assert.equal(recovered.delivery, "delivered");
        assert.notEqual(commands[0]?.commandId, commands[1]?.commandId);
        const sql = yield* SqlClient.SqlClient;
        const receipts = yield* sql<{
          status: string;
        }>`SELECT status FROM orchestration_command_receipts WHERE command_id IN (${commands[0]!.commandId},${commands[1]!.commandId})`;
        assert.deepEqual(receipts.map((row) => row.status).sort(), ["accepted", "rejected"]);
        const restarted = yield* makeDocumentService(f.options);
        assert.equal(
          (yield* restarted.retry({ submissionId: failed.id }, actor)).delivery,
          "delivered",
        );
        const thread = yield* f.projection.getThreadDetailById(threadId);
        if (thread._tag === "Some") assert.equal(thread.value.messages.length, 1);
      }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect(
    "replays the accepted command after a lost acknowledgement across service restart without a second message",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        const service = yield* makeDocumentService({
          ...f.options,
          dispatch: (command) =>
            f.engine
              .dispatch(command)
              .pipe(
                Effect.andThen(
                  Effect.fail(new PersistenceSqlError({ operation: "lost acknowledgement" })),
                ),
              ),
        });
        const submission = yield* service.submit(
          { ...f.draft, requestId: "submit-lost-ack" },
          actor,
        );
        assert.equal(submission.delivery, "failed");
        const restarted = yield* makeDocumentService(f.options);
        assert.equal(
          (yield* restarted.retry({ submissionId: submission.id }, actor)).delivery,
          "delivered",
        );
        const thread = yield* f.projection.getThreadDetailById(threadId);
        if (thread._tag !== "Some") return assert.fail("Thread disappeared");
        assert.equal(thread.value.messages.length, 1);
        const sql = yield* SqlClient.SqlClient;
        const attempts = yield* sql<{
          delivery_attempt: number;
        }>`SELECT delivery_attempt FROM document_submissions WHERE id=${submission.id}`;
        assert.equal(attempts[0]?.delivery_attempt, 0);
      }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect(
    "rejects oversized sources, external HTML resources, duplicate checklist IDs, and invalid answers",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        const invalidSources = [
          "x".repeat(2 * 1024 * 1024 + 1),
          '<script src="https://example.com/app.js"></script>',
          "<img src=relative.png>",
          "<style>body {background:url(https://example.com/image)}</style>",
          '<style>@import "remote.css";</style>',
        ];
        for (const [index, source] of invalidSources.entries()) {
          yield* f.fs.writeFileString(f.sourcePath, source);
          const result = yield* f.service
            .publish({ ...f.publication, requestId: `invalid-${index}` }, actor)
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure.reason, "invalid");
        }
        yield* f.fs.writeFileString(f.sourcePath, "<p>Valid</p>");
        assert.equal(
          (yield* f.service
            .publish(
              {
                ...f.publication,
                requestId: "duplicate-definition",
                definition: {
                  items: [
                    { id: "same", title: "One" },
                    { id: "same", title: "Two" },
                  ],
                },
              },
              actor,
            )
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* f.service
            .saveDraft(
              { ...f.draft, answers: [{ itemId: "unknown", outcome: "complete", notes: "" }] },
              actor,
            )
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* f.service
            .saveDraft({ ...f.draft, answers: [f.draft.answers[0]!, f.draft.answers[0]!] }, actor)
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* f.service
            .saveDraft(
              {
                ...f.draft,
                answers: [{ ...f.draft.answers[0]!, notes: "x".repeat(64 * 1024 + 1) }],
              },
              actor,
            )
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal((yield* f.service.list({ threadId })).length, 1);
      }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );
});

it.effect(
  "documents, answer history, and idempotency receipts persist across SQLite connection restart",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const filename = f.path.join(f.stateDir, "persistent.sqlite");
      const published = yield* Effect.gen(function* () {
        yield* migration;
        const service = yield* makeDocumentService(f.options);
        const detail = yield* service.publish(f.publication, actor);
        yield* service.saveDraft(
          { ...f.draft, documentId: detail.document.id, revisionId: detail.revision.id },
          actor,
        );
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          snapshot_path: string;
        }>`SELECT snapshot_path FROM document_revisions WHERE id=${detail.revision.id}`;
        assert.equal(rows[0]?.snapshot_path, `${detail.revision.id}.html`);
        return detail;
      }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename })));
      const legacyPath = [
        "C:",
        "previous-home",
        "userdata",
        "documents",
        `${published.revision.id}.html`,
      ].join("\\");
      yield* f.fs.remove(f.sourcePath);
      yield* Effect.gen(function* () {
        const service = yield* makeDocumentService(f.options);
        const replayed = yield* service.publish(f.publication, actor);
        assert.equal(replayed.revision.id, published.revision.id);
        assert.include(replayed.content, "Original");
        assert.equal(replayed.answers[0]?.notes, "Please fix.");
        assert.equal(
          (yield* service.history({ documentId: published.document.id })).events.length,
          2,
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE document_revisions SET snapshot_path=${legacyPath} WHERE id=${published.revision.id}`;
      }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename })));
      const restoredDir = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-documents-restored-" });
      yield* f.fs.copy(f.stateDir, restoredDir);
      const snapshotFilename = `${published.revision.id}.html`;
      yield* f.fs.writeFileString(
        f.path.join(f.stateDir, "documents", snapshotFilename),
        "changed at original home",
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          snapshot_path: string;
        }>`SELECT snapshot_path FROM document_revisions WHERE id=${published.revision.id}`;
        assert.equal(rows[0]?.snapshot_path, legacyPath);
        const restored = yield* makeDocumentService({ ...f.options, stateDir: restoredDir });
        const detail = yield* restored.get({ documentId: published.document.id });
        assert.include(detail.content, "Original");
        assert.equal(detail.answers[0]?.notes, "Please fix.");
        assert.equal(
          (yield* restored.history({ documentId: published.document.id })).events.length,
          2,
        );
        yield* sql`UPDATE document_revisions SET snapshot_path=${`/previous-home/userdata/documents/${snapshotFilename}`} WHERE id=${published.revision.id}`;
        assert.include(
          (yield* restored.get({ documentId: published.document.id })).content,
          "Original",
        );
        yield* sql`UPDATE document_revisions SET snapshot_path='../source.html' WHERE id=${published.revision.id}`;
        assert.equal(
          (yield* restored.get({ documentId: published.document.id }).pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          NodeSqliteClient.layer({ filename: f.path.join(restoredDir, "persistent.sqlite") }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
);
