import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EventId, ProjectId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { WorktreeRegistry } from "../documents/WorktreeRegistry.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
}) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provide(Layer.mock(WorktreeRegistry)({ isReviewable: () => Effect.succeed(false) })),
    Layer.provideMerge(NodeServices.layer),
  );
}

const projectId = ProjectId.make("review-project");
const now = "2026-10-01T00:00:00.000Z";

describe("ReviewService", () => {
  it.effect("reviews worktrees the documents module registered for an active project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-main-" });
      const detached = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-detached-" });
      const unknown = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unknown-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const testLayer = ReviewService.layer.pipe(
        Layer.provideMerge(WorktreeRegistry.layer),
        Layer.provideMerge(ProjectStore.layer),
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(GitVcsDriver.layer),
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ detect: () => Effect.succeed(null) }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const git = yield* GitVcsDriver.GitVcsDriver;
        const registry = yield* WorktreeRegistry;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const review = yield* ReviewService.ReviewService;
        const run = (args: string[], cwd = workspaceRoot) =>
          git.execute({ operation: "ReviewService.test", cwd, args });
        const projectEvent = (type: "project.created" | "project.deleted") =>
          projects.apply({
            sequence: 0,
            eventId: EventId.make(`review-${type}`),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            ...(type === "project.created"
              ? {
                  type,
                  payload: {
                    projectId,
                    title: "Review",
                    workspaceRoot,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: now,
                    updatedAt: now,
                  },
                }
              : { type, payload: { projectId, deletedAt: now } }),
          });
        yield* run(["init", "-b", "main"]);
        yield* run([
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "initial",
        ]);
        yield* run(["worktree", "add", "--detach", detached]);
        const canonicalDetached = yield* fs.realPath(detached);
        yield* registry.record({
          id: canonicalDetached,
          path: canonicalDetached,
          commonDir: yield* fs.realPath(workspaceRoot + "/.git"),
        });
        yield* projectEvent("project.created");
        const rejected = (cwd: string) =>
          review.getDiffPreview({ cwd }).pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          );

        assert.deepEqual((yield* review.getDiffPreview({ cwd: detached })).sources, []);
        assert.equal(yield* rejected(unknown), "VcsRepositoryDetectionError");
        yield* projectEvent("project.deleted");
        assert.equal(yield* rejected(detached), "VcsRepositoryDetectionError");
        yield* projectEvent("project.created");
        yield* run(["worktree", "remove", "--force", detached]);
        yield* fs.makeDirectory(detached, { recursive: true });
        yield* run(["init", "-b", "main"], detached);
        assert.equal(yield* rejected(detached), "VcsRepositoryDetectionError");
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
