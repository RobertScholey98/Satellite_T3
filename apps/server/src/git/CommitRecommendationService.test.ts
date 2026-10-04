import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
  type OrchestrationCommand,
  type CommitRecommendation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CommitRecommendationService from "./CommitRecommendationService.ts";

const threadId = ThreadId.make("thread-commit-advice");
const thread = Schema.decodeSync(OrchestrationThreadShell)({
  id: threadId,
  projectId: "project-1",
  title: "Work",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  branch: "feature",
  worktreePath: "/repo/worktree",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  latestTurn: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
const project = Schema.decodeSync(OrchestrationProjectShell)({
  id: "project-1",
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});

const makeHarness = Effect.fn(function* (
  options: {
    readonly worktreePath?: string | null;
    readonly dirty?: boolean;
    readonly headCommit?: string | null;
    readonly missing?: boolean;
  } = {},
) {
  const commands: OrchestrationCommand[] = [];
  const reads: string[] = [];
  let dirty = options.dirty ?? true;
  let recommendation: CommitRecommendation | null = null;
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.meta.update" && command.commitRecommendation !== undefined) {
            recommendation = command.commitRecommendation;
          }
          return { sequence: commands.length };
        }),
    }),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      listThreadsWithCommitRecommendations: () =>
        Effect.sync(() =>
          recommendation === null ? [] : [{ id: threadId, commitRecommendation: recommendation }],
        ),
      getThreadShellById: (id) =>
        Effect.succeed(
          options.missing || id !== threadId
            ? Option.none()
            : Option.some({
                ...thread,
                worktreePath:
                  options.worktreePath === undefined ? thread.worktreePath : options.worktreePath,
              }),
        ),
      getProjectShellById: () => Effect.succeedSome(project),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      statusDetailsLocal: (cwd) =>
        Effect.sync(() => {
          reads.push(cwd);
          return {
            isRepo: true,
            branch: "feature",
            headCommit: options.headCommit === undefined ? "head-1" : options.headCommit,
            hasWorkingTreeChanges: dirty,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasOriginRemote: false,
            isDefaultBranch: false,
            upstreamRef: null,
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
          };
        }),
    }),
  );
  const service = yield* CommitRecommendationService.CommitRecommendationService.pipe(
    Effect.provide(CommitRecommendationService.layer.pipe(Layer.provide(dependencies))),
  );
  return {
    service,
    commands,
    reads,
    setDirty: (value: boolean) => {
      dirty = value;
    },
    recommendation: () => recommendation,
  };
});

it.effect("anchors and replaces advice using fresh Git state in the thread's worktree", () =>
  Effect.gen(function* () {
    const { service, commands, reads } = yield* makeHarness();
    for (const level of ["recommended", "overdue"] as const) {
      const recommendation = yield* service.set(threadId, {
        level,
        reason: "A verified milestone is ready.",
      });
      expect(recommendation).toMatchObject({
        level,
        cwd: "/repo/worktree",
        branch: "feature",
        headCommit: "head-1",
      });
      expect(commands.at(-1)).toMatchObject({
        type: "thread.meta.update",
        threadId,
        commitRecommendation: recommendation,
      });
    }
    expect(reads).toEqual(["/repo/worktree", "/repo/worktree"]);
  }),
);

it.effect("withdraws advice without needing access to the checkout", () =>
  Effect.gen(function* () {
    const { service, commands, reads } = yield* makeHarness();
    expect(yield* service.set(threadId, { level: "none" })).toBeNull();
    expect(reads).toEqual([]);
    expect(commands.at(-1)).toMatchObject({ commitRecommendation: null });
  }),
);

it.effect("clears advice on a clean checkout and supports local unborn branches", () =>
  Effect.gen(function* () {
    const clean = yield* makeHarness({ dirty: false });
    expect(
      yield* clean.service.set(threadId, { level: "overdue", reason: "Earlier work." }),
    ).toBeNull();
    expect(clean.commands.at(-1)).toMatchObject({ commitRecommendation: null });
    const initial = yield* makeHarness({ worktreePath: null, headCommit: null });
    expect(
      yield* initial.service.set(threadId, {
        level: "recommended",
        reason: "Initial implementation is ready.",
      }),
    ).toMatchObject({ cwd: "/repo", headCommit: null });
  }),
);

it.effect("does not write advice for a missing thread", () =>
  Effect.gen(function* () {
    const { service, commands, reads } = yield* makeHarness({ missing: true });
    const failure = yield* service
      .set(threadId, { level: "recommended", reason: "Ready." })
      .pipe(Effect.flip);
    expect(failure.reason).toBe("thread-unavailable");
    expect(commands).toEqual([]);
    expect(reads).toEqual([]);
  }),
);

it.effect(
  "retires persisted advice after a clean status before unrelated edits at the same HEAD",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.service.set(threadId, { level: "overdue", reason: "Assessed work." });
      yield* harness.service.readLocalStatus("/repo/worktree");
      expect(harness.recommendation()).not.toBeNull();
      harness.setDirty(false);
      yield* harness.service.readLocalStatus("/another/checkout");
      expect(harness.recommendation()).not.toBeNull();
      yield* harness.service.readLocalStatus("/repo/worktree");
      expect(harness.recommendation()).toBeNull();
      harness.setDirty(true);
      yield* harness.service.readLocalStatus("/repo/worktree");
      expect(harness.recommendation()).toBeNull();
      expect(harness.commands).toHaveLength(2);
      expect(harness.commands.at(-1)).toMatchObject({ threadId, commitRecommendation: null });
      yield* harness.service.set(threadId, { level: "recommended", reason: "New assessment." });
      expect(harness.recommendation()?.reason).toBe("New assessment.");
    }),
);
