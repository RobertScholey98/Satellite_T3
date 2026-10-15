import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as TextGenerationOperations from "./TextGenerationOperations.ts";
import { cannedRunner } from "./testing/runners.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("test"), model: "test-model" };
const BRANCH_INSTRUCTION = "branch must be a short semantic git branch fragment";

const replying = (reply: unknown) => {
  const runner = cannedRunner(() => Effect.succeed(reply));
  return { ...TextGenerationOperations.fromRunner(runner.run), requests: runner.requests };
};

it.effect("sanitizes a commit subject and trims its body without asking for a branch", () =>
  Effect.gen(function* () {
    const generation = replying({
      subject:
        "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
      body: "\n- added migration\n- updated tests\n",
    });
    const generated = yield* generation.generateCommitMessage({
      cwd: "/work",
      branch: "feature/codex-effect",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection,
    });
    assert.deepStrictEqual(generated, {
      subject: "Add important change to the system with too much detail and a trailing p",
      body: "- added migration\n- updated tests",
    });
    assert.notInclude(generation.requests[0]?.prompt, BRANCH_INSTRUCTION);
  }),
);

it.effect("asks for a branch with the commit message when the caller wants one", () =>
  Effect.gen(function* () {
    const generation = replying({
      subject: "Add important change",
      body: "",
      branch: "fix/important-system-change",
    });
    const generated = yield* generation.generateCommitMessage({
      cwd: "/work",
      branch: "feature/codex-effect",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      includeBranch: true,
      modelSelection,
    });
    assert.deepStrictEqual(generated, {
      subject: "Add important change",
      body: "",
      branch: "feature/fix/important-system-change",
    });
    assert.include(generation.requests[0]?.prompt, BRANCH_INSTRUCTION);
  }),
);

it.effect("keeps one line of a PR title and trims the markdown body", () =>
  Effect.gen(function* () {
    const generated = yield* replying({
      title: "  Improve orchestration flow\nwith ignored suffix",
      body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
    }).generatePrContent({
      cwd: "/work",
      baseBranch: "main",
      headBranch: "feature/codex-effect",
      commitSummary: "feat: improve orchestration flow",
      diffSummary: "2 files changed",
      diffPatch: "diff --git a/a.ts b/a.ts",
      modelSelection,
    });
    assert.deepStrictEqual(generated, {
      title: "Improve orchestration flow",
      body: "## Summary\n- improve flow\n\n## Testing\n- bun test",
    });
  }),
);

it.effect("normalizes a generated branch fragment", () =>
  Effect.gen(function* () {
    const generated = yield* replying({ branch: "  Feat/Session  " }).generateBranchName({
      cwd: "/work",
      message: "Please update session handling.",
      modelSelection,
    });
    assert.deepStrictEqual(generated, { branch: "feat/session" });
  }),
);

it.effect.each([
  {
    mode: "static",
    reply: "Add Search",
    expected: "team/add-search",
    instruction: "without a prefix or namespace",
  },
  {
    mode: "semantic",
    reply: "feat/add-search",
    expected: "feat/add-search",
    instruction: "semantic prefix",
  },
  {
    mode: "custom",
    reply: "Julius/ABC-123.v2",
    expected: "Julius/ABC-123.v2",
    instruction: "Preserve the issue ID and capitalization.",
  },
] as const)("names a branch with $mode naming", (example) =>
  Effect.gen(function* () {
    const generation = replying({ branch: example.reply });
    const generated = yield* generation.generateBranchName({
      cwd: "/work",
      message: "Add search",
      modelSelection,
      naming: {
        mode: example.mode,
        prefix: "team/",
        instructions: "Preserve the issue ID and capitalization.",
      },
    });
    assert.deepStrictEqual(generated, { branch: example.expected });
    assert.include(generation.requests[0]?.prompt, example.instruction);
  }),
);

it.effect.each([
  {
    reply: '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
    expected: "Investigate websocket reconnect regressions after worktree restore",
  },
  { reply: '  """   """  ', expected: "New thread" },
  { reply: `  "' hello world '"  `, expected: "hello world" },
])("trims the thread title $reply for the sidebar", ({ reply, expected }) =>
  Effect.gen(function* () {
    const generated = yield* replying({ title: reply }).generateThreadTitle({
      cwd: "/work",
      message: "Name this thread.",
      modelSelection,
    });
    assert.deepStrictEqual(generated, { title: expected });
  }),
);

it.effect("passes on the signal that a thread title needs refinement", () =>
  Effect.gen(function* () {
    const generated = yield* replying({
      title: "Investigate issue",
      needsRefinement: true,
    }).generateThreadTitle({ cwd: "/work", message: "Fix this", modelSelection });
    assert.deepStrictEqual(generated, { title: "Investigate issue", needsRefinement: true });
  }),
);

it.effect("drops a null idea title and rejects invalid notebook edits", () =>
  Effect.gen(function* () {
    const input = { cwd: "/idea", prompt: "Organize the notebook.", modelSelection };
    const updated = yield* replying({
      edits: [],
      summary: "No new decisions.",
      title: null,
    }).generateIdeaUpdate(input);
    assert.deepStrictEqual(updated, { edits: [], summary: "No new decisions." });

    const error = yield* replying({ edits: "invalid", summary: "Bad update" })
      .generateIdeaUpdate(input)
      .pipe(Effect.flip);
    assert.strictEqual(error.operation, "generateIdeaUpdate");
  }),
);

const stalled = TextGenerationOperations.fromRunner(() => Effect.never);

it.effect("abandons a metadata task after three minutes", () =>
  Effect.gen(function* () {
    const title = yield* stalled
      .generateThreadTitle({ cwd: "/work", message: "Repair login", modelSelection })
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("3 minutes");
    const error = yield* Fiber.join(title);
    assert.strictEqual(error.operation, "generateThreadTitle");
    assert.strictEqual(error.detail, "Text generation timed out.");
  }),
);

it.effect("gives a document task thirty minutes before abandoning it", () =>
  Effect.gen(function* () {
    const review = yield* stalled
      .generateRevdoc({ cwd: "/work", prompt: "Review the worktree.", modelSelection })
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("3 minutes");
    assert.isUndefined(review.pollUnsafe());
    yield* TestClock.adjust("27 minutes");
    const error = yield* Fiber.join(review);
    assert.strictEqual(error.operation, "generateRevdoc");
    assert.strictEqual(error.detail, "Text generation timed out.");
  }),
);
