import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as FactorySource from "./FactorySource.ts";

it.effect(
  "captures fresh committed sources and preserves dirty handover bytes and index without executing repository filters",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const root = yield* fs.makeTempDirectoryScoped();
      const repository = path.join(root, "repository");
      yield* fs.makeDirectory(repository);
      const git = Effect.fn(function* (args: ReadonlyArray<string>, stdin?: string) {
        const result = yield* runner.run({ command: "git", args, cwd: repository, stdin });
        assert.equal(result.code, 0, result.stderr);
        return result.stdout.trim();
      });
      const put = (name: string, content: string | Uint8Array) =>
        typeof content === "string"
          ? fs.writeFileString(path.join(repository, name), content)
          : fs.writeFile(path.join(repository, name), content);
      yield* git(["init", "--initial-branch=main"]);
      yield* git(["config", "user.name", "Factory fixture"]);
      yield* git(["config", "user.email", "factory@example.invalid"]);
      yield* git(["config", "core.autocrlf", "false"]);
      yield* put("source.cjs", "module.exports = 1;\n");
      yield* put("deleted.cjs", "delete me\n");
      yield* put(".env.example", "SYNTHETIC_SECRET=unchanged\n");
      yield* put(".gitattributes", "source.cjs filter=untrusted\n");
      yield* put(".gitignore", "ignored-output/\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "baseline"]);
      const revision = yield* git(["rev-parse", "HEAD"]);
      const projectId = ProjectId.make("source-project");
      const threadId = ThreadId.make("handover-thread");
      const now = yield* DateTime.now;
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId,
        createdBy: "user",
        creationSource: "web",
        title: "Handover",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
      };
      let selectedThread = thread;
      const dependencies = Layer.mergeAll(
        ServerConfig.layerTest(root, root),
        Layer.mock(ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              Option.some({
                projectId,
                title: "Fixture",
                workspaceRoot: repository,
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                createdAt: DateTime.formatIso(now),
                updatedAt: DateTime.formatIso(now),
                deletedAt: null,
              }),
            ),
        }),
        Layer.mock(ProjectionStoreV2)({ getThread: () => Effect.succeed(selectedThread) }),
      );
      yield* Effect.gen(function* () {
        const source = yield* FactorySource.FactorySource;
        const capture = (requestId: string, handover = false) =>
          source.capture({
            requestId: CommandId.make(requestId),
            projectId,
            ...(handover ? { threadId } : {}),
          });
        yield* put("source.cjs", "incidental dirty source");
        const first = yield* capture("first");
        assert.equal(first.revision, revision);
        assert.deepEqual(first.excludedPaths, [".env.example"]);
        const text = (artifact: FactorySource.FactorySourceArtifact, name: string) =>
          Buffer.from(
            artifact.files.find((file) => file.path === name)!.content,
            "base64",
          ).toString();
        assert.equal(text(yield* source.read(first.id), "source.cjs"), "module.exports = 1;\n");
        yield* put("source.cjs", "module.exports = 2;\n");
        yield* git(["add", "source.cjs"]);
        yield* git(["commit", "-m", "new committed source"]);
        const second = yield* capture("second");
        assert.notEqual(second.revision, first.revision);
        assert.equal(text(yield* source.read(second.id), "source.cjs"), "module.exports = 2;\n");
        assert.deepEqual(yield* capture("first"), first);
        const worktree = path.join(root, "worktree");
        yield* git(["worktree", "add", "--detach", worktree, "HEAD"]);
        yield* fs.writeFileString(path.join(worktree, "source.cjs"), "detached dirty source\n");
        selectedThread = { ...thread, worktreePath: worktree };
        const detached = yield* capture("detached-worktree", true);
        const detachedArtifact = yield* source.read(detached.id);
        assert.equal(detached.branch, null);
        assert.equal(text(detachedArtifact, "source.cjs"), "detached dirty source\n");
        assert.equal(detachedArtifact.workspaceRoot, worktree);
        assert.equal(
          yield* fs.readFileString(path.join(repository, "source.cjs")),
          "module.exports = 2;\n",
        );
        selectedThread = thread;
        assert.equal(
          (yield* source
            .capture({
              requestId: CommandId.make("wrong-revision"),
              projectId,
              expectedRevision: revision,
            })
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* put("source.cjs", "module.exports = 3;\n");
        const stagedBinary = Uint8Array.from([0, 255, 1, 128, 13, 10]);
        yield* put("binary.dat", stagedBinary);
        yield* git(["add", "source.cjs", "binary.dat"]);
        yield* put("source.cjs", "module.exports = 4;\r\n");
        yield* put(".env.example", "SYNTHETIC_SECRET=unchanged\r\n");
        yield* fs.remove(path.join(repository, "deleted.cjs"));
        const untrackedBinary = Uint8Array.from([0, 254, 3, 129]);
        yield* put("untracked.dat", untrackedBinary);
        yield* fs.makeDirectory(path.join(repository, "ignored-output"));
        yield* put("ignored-output/cache", "not source");
        yield* git(["config", "filter.untrusted.clean", "echo executed > filter-executed; cat"]);
        yield* git(["config", "filter.untrusted.required", "true"]);
        yield* git(["config", "core.fsmonitor", "echo executed > monitor-executed"]);
        const indexBefore = yield* fs.readFile(path.join(repository, ".git", "index"));
        const handover = yield* capture("handover", true);
        const artifact = yield* source.read(handover.id);
        assert.equal(handover.origin, "handover");
        assert.equal(text(artifact, "source.cjs"), "module.exports = 4;\r\n");
        assert.equal(
          Buffer.from(
            artifact.indexFiles.find((file) => file.path === "source.cjs")!.content,
            "base64",
          ).toString(),
          "module.exports = 3;\n",
        );
        assert.deepEqual(
          Buffer.from(artifact.files.find((file) => file.path === "binary.dat")!.content, "base64"),
          Buffer.from(stagedBinary),
        );
        assert.deepEqual(
          Buffer.from(
            artifact.files.find((file) => file.path === "untracked.dat")!.content,
            "base64",
          ),
          Buffer.from(untrackedBinary),
        );
        assert.deepEqual(handover.stagedPaths, ["binary.dat", "source.cjs"]);
        assert.deepEqual(handover.unstagedPaths, ["deleted.cjs", "source.cjs"]);
        assert.deepEqual(handover.deletedPaths, ["deleted.cjs"]);
        assert.deepEqual(handover.untrackedPaths, ["untracked.dat"]);
        assert.deepEqual(Buffer.from(artifact.indexData!, "base64"), Buffer.from(indexBefore));
        assert.deepEqual(yield* fs.readFile(path.join(repository, ".git", "index")), indexBefore);
        assert.isFalse(yield* fs.exists(path.join(repository, "filter-executed")));
        assert.isFalse(yield* fs.exists(path.join(repository, "monitor-executed")));
        yield* source.validateCurrent(handover.id);
        yield* put("source.cjs", "changed after capture");
        assert.equal(
          (yield* source.validateCurrent(handover.id).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* put(".env.example", "SYNTHETIC_SECRET=dirty\n");
        assert.include(
          (yield* capture("dirty-secret", true).pipe(Effect.flip)).detail!,
          "Sensitive-path",
        );
        yield* put(".env.example", "SYNTHETIC_SECRET=unchanged\n");
        const linkObject = yield* git(["hash-object", "-w", "--stdin"], "source.cjs");
        yield* git(["update-index", "--add", "--cacheinfo", `120000,${linkObject},link`]);
        assert.include(
          (yield* capture("unsupported-link", true).pipe(Effect.flip)).detail!,
          "links",
        );
      }).pipe(Effect.provide(FactorySource.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
  30000,
);
