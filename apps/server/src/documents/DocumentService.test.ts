import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  EventId,
  IdeaArtifactId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ServerConfig } from "../config.ts";
import {
  layer as SatelliteTestLayer,
  recordProject,
} from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/SatelliteOrchestration.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import migration from "../persistence/Migrations/055_ManagedDocuments.ts";
import mediaTypesMigration from "../persistence/Migrations/068_DocumentMediaTypes.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { DocumentService, makeDocumentService } from "./DocumentService.ts";
import { WorktreeRegistry } from "./WorktreeRegistry.ts";
import { IdeaNotebookStore } from "../ideas/IdeaNotebookStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeOpenWorkService, OpenWorkService } from "../openWork/OpenWorkService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";

const integrationLayer = WorktreeRegistry.layer.pipe(
  Layer.provideMerge(
    SatelliteTestLayer.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-documents-test-" })),
      Layer.provideMerge(VcsProcess.layer.pipe(Layer.provide(ProcessRunner.layer))),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);
const productionLayer = OpenWorkService.layer.pipe(
  Layer.provideMerge(DocumentService.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-documents-layer-test-" })),
  Layer.provideMerge(integrationLayer),
);
const threadId = ThreadId.make("documents-thread");
const projectId = ProjectId.make("documents-project");
const actor = "session:reviewer";
const createdAt = "2026-09-30T12:00:00.000Z";
const git = Effect.fn("DocumentService.test.git")(function* (cwd: string, args: readonly string[]) {
  const processes = yield* VcsProcess.VcsProcess;
  const result = yield* processes.run({
    operation: "DocumentService.test",
    command: "git",
    cwd,
    args,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return result.stdout.trim();
});
const initRepository = Effect.fn("DocumentService.test.initRepository")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* git(cwd, ["init", "-b", "main"]);
  yield* fs.writeFileString(path.join(cwd, "code.txt"), "main\n");
  yield* git(cwd, ["add", "code.txt"]);
  yield* git(cwd, ["commit", "-m", "main"]);
  return yield* git(cwd, ["rev-parse", "HEAD"]);
});
const createThread = (id: ThreadId, worktreePath: string | null = null) =>
  Effect.flatMap(OrchestrationEngineService, (engine) =>
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${id}`),
      threadId: id,
      projectId,
      title: "Documents",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      createdAt,
    }),
  );
const ideaThreadId = ThreadId.make("idea-document-thread");
const createIdea = Effect.flatMap(OrchestrationEngineService, (engine) =>
  engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-idea-document-thread"),
    threadId: ideaThreadId,
    projectId,
    purpose: "idea",
    title: "Private idea",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  }),
);
const publishedRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      document_id: string;
      worktree_id: string;
    }>`SELECT document_id,worktree_id FROM document_placements ORDER BY observed_at,rowid`,
);

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
  yield* recordProject({ projectId, title: "Documents", workspaceRoot: stateDir });
  yield* createThread(threadId);
  const options = {
    stateDir,
    dispatch: engine.dispatch,
    projection,
    ideas: yield* IdeaNotebookStore,
  };
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

it.effect("places a publication on its thread's worktree through the production layer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-documents-layer-" });
    yield* initRepository(root);
    yield* recordProject({ projectId, title: "Documents", workspaceRoot: root });
    yield* createThread(threadId);
    const source = path.join(root, "plan.md");
    yield* fs.writeFileString(source, "# Plan");
    const documents = yield* DocumentService;
    const openWork = yield* OpenWorkService;

    const published = yield* documents.publish(
      { requestId: "plan", threadId, title: "Plan", kind: "plan", path: source },
      actor,
    );

    const worktree = (yield* openWork.list({})).worktrees[0]!;
    const timeline = yield* openWork.timeline({ worktreeId: worktree.id });
    assert.deepEqual(
      timeline.documents.map(({ title, source, step }) => ({ title, source, step })),
      [
        {
          title: "Plan",
          source: {
            kind: "published",
            documentId: published.document.id,
            revisionId: published.revision.id,
            threadId,
          },
          step: { kind: "wip" },
        },
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(productionLayer)),
);

describe("managed document persistence", () => {
  it.effect("fails a publish whose project is unavailable instead of retaining it unplaced", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply({
        sequence: 0,
        eventId: EventId.make("project-deleted"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.deleted",
        payload: { projectId, deletedAt: createdAt },
      });

      const result = yield* f.service
        .publish({ ...f.publication, requestId: "orphaned" }, actor)
        .pipe(Effect.flip);

      assert.equal(result.reason, "not-found");
      assert.deepEqual(
        (yield* f.service.list({ threadId })).map((document) => document.id),
        [f.detail.document.id],
      );
    }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect(
    "publishes from a project without Git and from a Scratch folder without a worktree",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        yield* initRepository(f.stateDir);
        const scratch = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-documents-scratch-" });
        const scratchThread = ThreadId.make("documents-scratch-thread");
        yield* createThread(scratchThread, scratch);

        const fromScratch = yield* f.service.publish(
          { ...f.publication, threadId: scratchThread, requestId: "scratch" },
          actor,
        );
        const withStep = yield* f.service
          .publish(
            {
              ...f.publication,
              threadId: scratchThread,
              requestId: "scratch-step",
              step: { kind: "wip" },
            },
            actor,
          )
          .pipe(Effect.flip);

        assert.deepEqual(
          (yield* f.service.list({ threadId })).map((document) => document.title),
          ["Review"],
        );
        assert.deepEqual(
          (yield* f.service.list({ threadId: scratchThread })).map((document) => document.id),
          [fromScratch.document.id],
        );
        assert.equal(withStep.reason, "invalid");
        assert.deepEqual(yield* publishedRows, []);
      }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect("places documents published in an idea on its notebook instead of a worktree", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* initRepository(f.stateDir);
      const ideas = yield* IdeaNotebookStore;
      yield* createIdea;
      const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

      const fromPath = yield* f.service.publish(
        { ...f.publication, threadId: ideaThreadId, requestId: "idea-path" },
        actor,
      );
      const fromText = yield* f.service.publish(
        {
          requestId: "idea-text",
          threadId: ideaThreadId,
          title: "PRD",
          kind: "document",
          text: "# Goals",
          mediaType: "text/markdown",
        },
        "agent:codex:session",
      );
      const withoutMediaType = yield* f.service
        .publish(
          {
            requestId: "idea-text-bare",
            threadId: ideaThreadId,
            title: "PRD",
            kind: "document",
            text: "# Goals",
          },
          actor,
        )
        .pipe(Effect.flip);
      const upload = yield* f.service.publishIdeaDocument(
        { threadId: ideaThreadId, name: "sketch.png", mediaType: "image/png", bytes: image },
        "upload",
      );
      const binaryRead = yield* f.service.get({ documentId: upload.id }).pipe(Effect.flip);

      assert.deepEqual(
        (yield* ideas.requireActive(ideaThreadId)).artifacts.map(
          ({ id, name, mediaType, textStatus, source }) => ({
            id,
            name,
            mediaType,
            textStatus,
            source,
          }),
        ),
        [
          {
            id: IdeaArtifactId.make(fromPath.document.id),
            name: "Review",
            mediaType: "text/html",
            textStatus: "available",
            source: "upload",
          },
          {
            id: IdeaArtifactId.make(fromText.document.id),
            name: "PRD",
            mediaType: "text/markdown",
            textStatus: "available",
            source: "agent",
          },
          {
            id: upload.id,
            name: "sketch.png",
            mediaType: "image/png",
            textStatus: "image",
            source: "upload",
          },
        ],
      );
      assert.deepEqual(
        (yield* f.service.list({ threadId: ideaThreadId })).map((document) => document.id).sort(),
        [fromPath.document.id, fromText.document.id, upload.id].sort(),
      );
      assert.equal(
        (yield* f.service.readIdeaDocument({ threadId: ideaThreadId, artifactId: upload.id }))
          .contentBase64,
        Buffer.from(image).toString("base64"),
      );
      assert.equal(withoutMediaType.reason, "invalid");
      assert.equal(binaryRead.reason, "invalid");
      assert.include(binaryRead.message, "idea_read_image");
      assert.deepEqual(yield* publishedRows, []);
    }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect("reads idea artifacts saved before ideas used the documents module", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* createIdea;
      const legacyId = IdeaArtifactId.make("legacy-notes");
      const legacyDirectory = f.path.join(
        f.stateDir,
        "ideas",
        Buffer.from(ideaThreadId).toString("base64url"),
        "documents",
      );
      yield* f.fs.makeDirectory(legacyDirectory, { recursive: true });
      yield* f.fs.writeFileString(f.path.join(legacyDirectory, legacyId), "# Earlier notes");
      yield* f.engine.dispatch({
        type: "idea.apply",
        commandId: CommandId.make("register-legacy"),
        threadId: ideaThreadId,
        deletionEpoch: 0,
        mutation: {
          kind: "artifact.register",
          artifact: {
            id: legacyId,
            name: "notes.md",
            mediaType: "text/markdown",
            sizeBytes: 15,
            textStatus: "available",
            revision: 1,
            createdAt,
            source: "agent",
          },
        },
      });

      const read = yield* f.service.readIdeaDocument({
        threadId: ideaThreadId,
        artifactId: legacyId,
      });
      yield* f.service.remove(ideaThreadId, legacyId);

      assert.equal(Buffer.from(read.contentBase64, "base64").toString("utf8"), "# Earlier notes");
      assert.deepEqual(yield* f.fs.readDirectory(legacyDirectory), []);
    }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect("rejects a publish into an idea that is being deleted and keeps no copy", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* createIdea;
      yield* f.engine.dispatch({
        type: "idea.apply",
        commandId: CommandId.make("delete-idea"),
        threadId: ideaThreadId,
        deletionEpoch: 0,
        mutation: { kind: "delete.request" },
      });
      const snapshots = yield* f.fs.readDirectory(f.path.join(f.stateDir, "documents"));

      const rejected = yield* f.service
        .publishIdeaDocument(
          {
            threadId: ideaThreadId,
            name: "late.md",
            mediaType: "text/markdown",
            bytes: Buffer.from("# Late"),
          },
          "upload",
        )
        .pipe(Effect.flip);

      assert.equal(rejected.reason, "not-found");
      assert.deepEqual(yield* f.service.list({ threadId: ideaThreadId }), []);
      assert.deepEqual(yield* f.fs.readDirectory(f.path.join(f.stateDir, "documents")), snapshots);
    }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

  it.effect(
    "publication provenance commits atomically and keeps original worktree when its thread moves",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        const main = yield* initRepository(f.stateDir);
        yield* git(f.stateDir, ["switch", "-c", "feature"]);
        const first = yield* f.service.publish({ ...f.publication, requestId: "birth-one" }, actor);
        yield* f.fs.writeFileString(f.path.join(f.stateDir, "code.txt"), "first\n");
        yield* git(f.stateDir, ["commit", "-am", "first"]);
        const committed = yield* git(f.stateDir, ["rev-parse", "HEAD"]);
        const other = f.path.join(f.stateDir, "other-worktree");
        yield* git(f.stateDir, ["worktree", "add", "--detach", other, main]);
        yield* f.engine.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("move-thread"),
          threadId,
          worktreePath: other,
        });
        const next = yield* f.service.publish(
          {
            ...f.publication,
            requestId: "birth-two",
            documentId: first.document.id,
            expectedCurrentRevisionId: first.revision.id,
            step: { kind: "commit", commitSha: main },
          },
          actor,
        );
        const open = yield* makeOpenWorkService({
          projects: () => Effect.succeed([{ id: projectId, workspaceRoot: f.stateDir }]),
          documents: f.service,
        });
        const list = yield* open.list({});
        const original = list.worktrees.find((tree) => tree.branch === "feature")!;
        const timeline = yield* open.timeline({ worktreeId: original.id });
        assert.deepEqual(timeline.documents[0]?.source, {
          kind: "published",
          documentId: first.document.id,
          revisionId: first.revision.id,
          threadId,
        });
        assert.deepEqual(timeline.documents[0]?.step, { kind: "commit", commitSha: committed });
        const otherView = yield* open.timeline({
          worktreeId: list.worktrees.find((tree) => tree.branch === null)!.id,
        });
        assert.equal(otherView.documents[0]?.source.kind, "published");
        assert.deepEqual(otherView.documents[0]?.step, { kind: "commit", commitSha: main });
        yield* f.fs.writeFileString(f.sourcePath, "<h1>Live replacement</h1>");
        assert.include(
          (yield* f.service.get({ documentId: first.document.id, revisionId: first.revision.id }))
            .content,
          "Original",
        );

        const rejected = yield* f.service
          .publish(
            {
              ...f.publication,
              requestId: "rollback",
              step: { kind: "commit", commitSha: "0000000" },
            },
            actor,
          )
          .pipe(Effect.flip);

        assert.equal(rejected.reason, "invalid");
        assert.equal((yield* publishedRows).length, 2);
        assert.equal((yield* f.service.list({ threadId })).length, 2);
        assert.equal(
          (yield* f.service.history({ documentId: first.document.id })).revisions.length,
          2,
        );
        assert.equal(next.revision.number, 2);
      }).pipe(Effect.scoped, Effect.provide(integrationLayer)),
  );

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
            f.engine.dispatch(command).pipe(
              Effect.andThen(
                Effect.fail(
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: new PersistenceSqlError({ operation: "lost acknowledgement" }),
                  }),
                ),
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
        yield* mediaTypesMigration;
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
