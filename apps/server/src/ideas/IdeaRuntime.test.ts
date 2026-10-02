// @effect-diagnostics nodeBuiltinImport:off - FileSystem.symlink cannot select a Windows directory junction.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import { ServerConfig } from "../config.ts";
import {
  IdeaArtifactId,
  OrchestrationThreadShell,
  OrchestrationProjectShell,
} from "@t3tools/contracts";
import { appendIdeaUserInputAttachments } from "../provider/userInputAttachments.ts";
import * as ProcessRunner from "../processRunner.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { withIdeaLock, setIdeaExecution, clearIdeaExecution } from "./IdeaExecution.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { IdeaRuntime, decodeIdeaArtifactContent } from "./IdeaRuntime.ts";
import { resolveIdeaMain } from "./IdeaMain.ts";
import { ideaStateFixture, testIdeaId, unusedIdeaSnapshots } from "./IdeaRuntime.testFixtures.ts";

const fixture = Effect.gen(function* () {
  const state = ideaStateFixture();
  const runtime = yield* IdeaRuntime.pipe(
    Effect.provide(IdeaRuntime.layer),
    Effect.provideService(IdeaNotebookStore, state.store),
    Effect.provideService(OrchestrationEngineService, state.engine),
    Effect.provideService(ProjectionSnapshotQuery, unusedIdeaSnapshots),
  );
  return { ...state, runtime };
});
const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "idea-runtime-" }),
  ProcessRunner.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const text = Buffer.from("Owned notebook document").toString("base64");
const decodeThreadShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);
const decodeProjectShell = Schema.decodeUnknownEffect(OrchestrationProjectShell);

describe("idea runtime boundaries", () => {
  it.effect.each(["directory", "unborn", "feature-only"])(
    "prepares an idea in a %s project and discovers main after its first commit",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "idea-new-project-" });
        const git = (args: readonly string[]) =>
          runner
            .run({
              command: "git",
              cwd,
              args: [
                "-c",
                "core.hooksPath=" + path.join(cwd, "no-hooks"),
                "-c",
                "user.name=Ideas test",
                "-c",
                "user.email=ideas@example.invalid",
                ...args,
              ],
            })
            .pipe(Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0))));
        if (kind !== "directory") yield* git(["init", "--initial-branch=feature"]);
        if (kind === "feature-only") yield* git(["commit", "--allow-empty", "-m", "fixture"]);
        const now = "2026-10-01T12:00:00.000Z";
        const shell = yield* decodeThreadShell({
          id: testIdeaId,
          projectId: "new-project",
          purpose: "idea",
          title: "New idea",
          modelSelection: { instanceId: "codex", model: "test" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: now,
          updatedAt: now,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        });
        const project = yield* decodeProjectShell({
          id: shell.projectId,
          title: "New project",
          workspaceRoot: cwd,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        });
        const state = ideaStateFixture();
        const runtime = yield* IdeaRuntime.pipe(
          Effect.provide(IdeaRuntime.layer),
          Effect.provideService(IdeaNotebookStore, state.store),
          Effect.provideService(OrchestrationEngineService, state.engine),
          Effect.provideService(ProjectionSnapshotQuery, {
            ...unusedIdeaSnapshots,
            getThreadShellById: () => Effect.succeedSome(shell),
            getProjectShellById: () => Effect.succeedSome(project),
            getThreadDetailById: () => Effect.succeedNone,
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => clearIdeaExecution(testIdeaId)));
        const execution = yield* runtime.prepare(testIdeaId);
        assert.isNull(execution.mainRevision);
        assert.isTrue(yield* fs.exists(execution.cwd));
        assert.include(yield* runtime.foregroundContext(testIdeaId, true), '"mainRevision":null');
        const missing = yield* runtime.readMain({ threadId: testIdeaId }).pipe(Effect.flip);
        assert.include(missing.message, "default branch is unavailable");
        if (kind === "directory") {
          assert.isFalse(yield* fs.exists(path.join(cwd, ".git")));
          yield* git(["init", "--initial-branch=main"]);
        } else {
          assert.equal((yield* git(["branch", "--show-current"])).stdout.trim(), "feature");
          yield* git(["checkout", "-b", "main"]);
        }
        yield* fs.writeFileString(path.join(cwd, "README.md"), "First project commit\n");
        yield* git(["add", "README.md"]);
        yield* git(["commit", "-m", "First project commit"]);
        const revision = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
        assert.include(yield* runtime.foregroundContext(testIdeaId, true), revision);
        const result = yield* runtime.readMain({ threadId: testIdeaId, path: "README.md" });
        assert.equal(result.revision, revision);
        assert.equal(result.text.trim(), "First project commit");
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "imports a question attachment and supplies an owned artifact reference while preserving the answer",
    () =>
      Effect.gen(function* () {
        const { runtime, get } = yield* fixture;
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const attachment = {
          type: "file" as const,
          id: testIdeaId + "-00000000-0000-4000-8000-0000000000aa-txt",
          name: "decision.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
        };
        yield* fs.writeFileString(
          path.join(config.attachmentsDir, attachment.id + ".txt"),
          "decision",
        );
        yield* runtime.importAttachments(testIdeaId, [attachment]);
        const answers = appendIdeaUserInputAttachments({ q: ["One thread"] }, { q: [attachment] });
        const id = IdeaArtifactId.make("attachment-" + attachment.id);
        assert.deepEqual((answers.q as readonly string[]).slice(0, 1), ["One thread"]);
        assert.include((answers.q as readonly string[])[1]!, id);
        assert.notInclude((answers.q as readonly string[])[1]!, config.attachmentsDir);
        assert.equal(
          Buffer.from(
            (yield* runtime.readArtifact({ threadId: testIdeaId, artifactId: id })).contentBase64,
            "base64",
          ).toString("utf8"),
          "decision",
        );
        yield* runtime.importAttachments(testIdeaId, [attachment]);
        assert.equal(get().artifacts.length, 1);
      }).pipe(Effect.provide(testLayer)),
  );
  it("rejects malformed and oversized document transport", () => {
    assert.throws(() => decodeIdeaArtifactContent("!!not base64!!"));
    assert.throws(
      () => decodeIdeaArtifactContent(Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64")),
      /20 MB/,
    );
  });
  it.effect("owns artifacts and rejects reads and queued writes after deletion", () =>
    Effect.gen(function* () {
      const { runtime, get, set } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const artifact = yield* runtime.writeArtifact({
        threadId: testIdeaId,
        name: "../notes.md",
        mediaType: "text/markdown",
        contentBase64: text,
      });
      assert.equal(
        (yield* runtime.readArtifact({ threadId: testIdeaId, artifactId: artifact.id }))
          .contentBase64,
        text,
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = yield* withIdeaLock(
        testIdeaId,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const lateWrite = yield* runtime
        .writeArtifact({
          threadId: testIdeaId,
          name: "late.md",
          mediaType: "text/markdown",
          contentBase64: text,
        })
        .pipe(Effect.result, Effect.forkScoped);
      set({ ...get(), status: "deleting", deletionEpoch: 1 });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      const result = yield* Fiber.join(lateWrite);
      assert.equal(result._tag, "Failure");
      yield* runtime.removeOwned(testIdeaId);
      assert.isFalse(
        yield* fs.exists(
          path.join(config.stateDir, "ideas", Buffer.from(testIdeaId).toString("base64url")),
        ),
      );
      assert.equal(
        (yield* runtime
          .readArtifact({ threadId: testIdeaId, artifactId: artifact.id })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.isFalse(
        yield* fs.exists(
          path.join(config.stateDir, "ideas", Buffer.from(testIdeaId).toString("base64url")),
        ),
      );
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("rejects a linked storage ancestor before creating anything outside the idea", () =>
    Effect.gen(function* () {
      const { runtime } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "idea-outside-" });
      const linked = path.join(config.stateDir, "ideas");
      yield* Effect.tryPromise(() => NodeFSP.symlink(outside, linked, "junction"));
      assert.equal(
        (yield* runtime
          .writeArtifact({
            threadId: testIdeaId,
            name: "notes.md",
            mediaType: "text/markdown",
            contentBase64: text,
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepEqual(yield* fs.readDirectory(outside), []);
      yield* fs.remove(linked);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "reads a default branch object while leaving the dirty working checkout untouched",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "idea-main-" });
        const git = (args: readonly string[]) =>
          runner
            .run({
              command: "git",
              cwd,
              args: ["-c", "core.hooksPath=" + path.join(cwd, "no-hooks"), ...args],
            })
            .pipe(Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0))));
        yield* git(["init", "--initial-branch=master"]);
        yield* fs.writeFileString(path.join(cwd, "sentinel.txt"), "committed\n");
        yield* git(["add", "sentinel.txt"]);
        yield* git([
          "-c",
          "user.name=Ideas test",
          "-c",
          "user.email=ideas@example.invalid",
          "commit",
          "-m",
          "fixture",
        ]);
        const linkBlob = yield* runner.run({
          command: "git",
          cwd,
          args: ["hash-object", "-w", "--stdin"],
          stdin: "../outside.txt",
        });
        yield* git([
          "update-index",
          "--add",
          "--cacheinfo",
          "120000," + linkBlob.stdout.trim() + ",external-link",
        ]);
        yield* git([
          "-c",
          "user.name=Ideas test",
          "-c",
          "user.email=ideas@example.invalid",
          "commit",
          "-m",
          "link fixture",
        ]);
        const main = yield* resolveIdeaMain(cwd);
        assert.isNotNull(main);
        const { runtime } = yield* fixture;
        setIdeaExecution(testIdeaId, {
          cwd: yield* runtime.workingDirectory(testIdeaId),
          projectDirectory: cwd,
          mainRevision: main!,
          deletionEpoch: 0,
          context: "",
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => clearIdeaExecution(testIdeaId)));
        yield* git(["checkout", "-b", "feature"]);
        yield* fs.writeFileString(path.join(cwd, "sentinel.txt"), "dirty working tree\n");
        assert.equal(yield* resolveIdeaMain(cwd), main);
        const result = yield* runtime.readMain({ threadId: testIdeaId, path: "sentinel.txt" });
        assert.equal(result.revision, main);
        assert.equal(result.text.trim(), "committed");
        assert.equal(
          (yield* runtime
            .readMain({ threadId: testIdeaId, path: "../outside.txt" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* runtime
            .readMain({ threadId: testIdeaId, path: "external-link" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          yield* fs.readFileString(path.join(cwd, "sentinel.txt")),
          "dirty working tree\n",
        );
        assert.equal((yield* git(["branch", "--show-current"])).stdout.trim(), "feature");
      }).pipe(Effect.provide(testLayer)),
  );
});
