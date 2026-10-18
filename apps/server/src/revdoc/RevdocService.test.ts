// @effect-diagnostics nodeBuiltinImport:off - Edits files in the throwaway repository under review.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  REVDOC_LIMITS,
  type RevdocItemSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import * as RevdocService from "./RevdocService.ts";
import {
  answering,
  awaitPass,
  addWorktree,
  awaitProgress,
  CHILD_THREAD_ID,
  delegatingThreads,
  failingReviewer,
  layerRevdoc,
  makeRepository,
  readExport,
  type Reviewer,
  target,
  THREAD_ID,
  writeFile,
} from "./testing/revdocService.test.helpers.ts";

const reviewerRef = (reviewer: Reviewer = answering()) => ({ current: reviewer });

const generated = (action?: "generate") =>
  Effect.gen(function* () {
    const revdoc = yield* RevdocService.RevdocService;
    const { passId } = yield* revdoc.generate({ ...target(), ...(action ? { action } : {}) });
    return yield* awaitPass(passId);
  });

const itemsByCheck = Effect.gen(function* () {
  const revdoc = yield* RevdocService.RevdocService;
  const read = yield* revdoc.read(target(), { attentionOnly: false });
  return new Map(read.items.map((item) => [item.check, item]));
});

const edit = (
  item: Pick<RevdocItemSummary, "id" | "revision">,
  change: Parameters<RevdocService.RevdocService["Service"]["editItem"]>[0]["change"],
) =>
  Effect.flatMap(RevdocService.RevdocService, (revdoc) =>
    revdoc.editItem({ ...target(), itemId: item.id, expectedRevision: item.revision, change }),
  );

describe("RevdocService", () => {
  it.live("carries outcomes and notes from Friday through Monday's regeneration", () => {
    const root = makeRepository();
    writeFile(root, "src/a.ts", "export const a = 1;\n");
    writeFile(root, "src/b.ts", "export const b = 1;\n");
    return Effect.gen(function* () {
      const revdoc = yield* RevdocService.RevdocService;
      assert.strictEqual((yield* generated()).status, "completed");
      let items = yield* itemsByCheck;
      assert.deepStrictEqual([...items.keys()], ["Open src/a.ts", "Open src/b.ts"]);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(root, ".revdoc/.gitignore"), "utf8"),
        "*\n",
      );

      yield* edit(items.get("Open src/a.ts")!, { _tag: "set_outcome", outcome: "complete" });
      const b = yield* edit(items.get("Open src/b.ts")!, {
        _tag: "set_outcome",
        outcome: "change_requested",
      });
      yield* edit(b, { _tag: "set_note", note: "Use the shared helper" });
      const fridayIds = [...(yield* itemsByCheck).values()].map((item) => item.id);

      // Monday: the weekend agent removed b.ts and edited a.ts.
      NodeFS.rmSync(NodePath.join(root, "src/b.ts"));
      writeFile(root, "src/a.ts", "export const a = 2;\n");
      yield* revdoc.refresh(target());
      items = yield* itemsByCheck;
      assert.strictEqual(items.get("Open src/a.ts")?.retest, "code");
      assert.strictEqual(items.get("Open src/a.ts")?.outcome, "complete");

      assert.strictEqual((yield* generated()).status, "completed");
      items = yield* itemsByCheck;
      assert.deepStrictEqual(
        [...items.values()].map((item) => item.id),
        fridayIds,
      );
      assert.deepInclude(items.get("Open src/b.ts"), {
        outcome: "change_requested",
        note: "Use the shared helper",
        stale: true,
      });
      assert.deepInclude(items.get("Open src/a.ts"), {
        outcome: "complete",
        stale: false,
        retest: "code",
      });

      yield* edit(items.get("Open src/a.ts")!, { _tag: "set_outcome", outcome: "broken" });
      assert.strictEqual((yield* itemsByCheck).get("Open src/a.ts")?.retest, null);

      const exported = readExport(root);
      const review = (yield* revdoc.read(target(), { attentionOnly: false })).review!;
      assert.strictEqual(exported.revision, review.revision);
      assert.deepStrictEqual(
        exported.items.map((item: { id: string; outcome: string; stale: boolean }) => [
          item.id,
          item.outcome,
          item.stale,
        ]),
        [
          [fridayIds[0], "broken", false],
          [fridayIds[1], "change_requested", true],
        ],
      );
    }).pipe(Effect.provide(layerRevdoc({ root, reviewer: reviewerRef() })));
  });

  it.live(
    "rejects a second save of the same check from the same revision with the current check",
    () => {
      const root = makeRepository();
      writeFile(root, "a.ts", "a\n");
      writeFile(root, "b.ts", "b\n");
      return Effect.gen(function* () {
        yield* generated();
        const items = yield* itemsByCheck;
        const a = items.get("Open a.ts")!;
        yield* edit(a, { _tag: "set_note", note: "First device" });
        const conflict = yield* Effect.flip(edit(a, { _tag: "set_note", note: "Second device" }));
        assert.strictEqual(conflict.code, "conflict");
        assert.strictEqual(conflict.currentItem?.note, "First device");
        const b = yield* edit(items.get("Open b.ts")!, { _tag: "set_note", note: "Other check" });
        assert.strictEqual(b.note, "Other check");
      }).pipe(Effect.provide(layerRevdoc({ root, reviewer: reviewerRef() })));
    },
  );

  it.live(
    "ends a generation pass conflicted with nothing written when a person edits mid-run",
    () => {
      const root = makeRepository();
      writeFile(root, "a.ts", "a\n");
      const reviewer = reviewerRef();
      return Effect.gen(function* () {
        const revdoc = yield* RevdocService.RevdocService;
        yield* generated();
        const before = yield* itemsByCheck;
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        reviewer.current = (prompt, model) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(answering()(prompt.replace("a.ts", "renamed.ts"), model)),
          );
        writeFile(root, "c.ts", "c\n");
        const { passId } = yield* revdoc.generate(target());
        yield* Deferred.await(started);
        assert.strictEqual(readExport(root).activePass?.kind, "generate");
        yield* edit(before.get("Open a.ts")!, { _tag: "set_outcome", outcome: "skipped" });
        yield* Deferred.succeed(release, undefined);
        const pass = yield* awaitPass(passId);
        assert.strictEqual(pass.status, "conflicted");
        assert.strictEqual(pass.error, "The review changed while this pass ran. Run it again.");
        const after = yield* itemsByCheck;
        assert.deepStrictEqual([...after.keys()], ["Open a.ts"]);
        assert.strictEqual(after.get("Open a.ts")?.stale, false);
      }).pipe(Effect.provide(layerRevdoc({ root, reviewer })));
    },
  );

  it.live("never reads untracked content through a symbolic link into the prompt", () => {
    const root = makeRepository();
    const outside = NodePath.join(makeRepository(), "secret.txt");
    NodeFS.writeFileSync(outside, "TOP-SECRET\n");
    NodeFS.symlinkSync(outside, NodePath.join(root, "linked.txt"));
    writeFile(root, "a.ts", "a\n");
    const calls: Array<{ prompt: string; model: string }> = [];
    return Effect.gen(function* () {
      yield* generated();
      assert.isTrue(
        calls.some((call) => call.prompt.includes("linked.txt (content omitted: symbolic link)")),
      );
      assert.isFalse(calls.some((call) => call.prompt.includes("TOP-SECRET")));
    }).pipe(Effect.provide(layerRevdoc({ root, reviewer: reviewerRef(answering(calls)) })));
  });

  it.live("sends a note preview in summaries and the full note in item details", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    return Effect.gen(function* () {
      const revdoc = yield* RevdocService.RevdocService;
      yield* generated();
      const [item] = [...(yield* itemsByCheck).values()];
      const note = "n".repeat(REVDOC_LIMITS.note);
      const summary = yield* edit(item!, { _tag: "set_note", note });
      assert.deepStrictEqual(
        [summary.note.length, summary.noteTruncated],
        [REVDOC_LIMITS.notePreview, true],
      );
      const { items } = yield* revdoc.getItems({ ...target(), ids: [item!.id] });
      assert.deepStrictEqual([items[0]?.note, items[0]?.noteTruncated], [note, false]);
    }).pipe(Effect.provide(layerRevdoc({ root, reviewer: reviewerRef() })));
  });

  it.live("deletes the Review only from its current revision", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    return Effect.gen(function* () {
      const revdoc = yield* RevdocService.RevdocService;
      yield* generated();
      const review = (yield* revdoc.read(target(), { attentionOnly: false })).review!;
      const stale = yield* Effect.flip(
        revdoc.deleteReview({ ...target(), expectedRevision: review.revision - 1 }),
      );
      assert.strictEqual(stale.code, "conflict");
      yield* revdoc.deleteReview({ ...target(), expectedRevision: review.revision });
      assert.isNull((yield* revdoc.read(target(), { attentionOnly: false })).review);
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".revdoc/review.json")));
    }).pipe(Effect.provide(layerRevdoc({ root, reviewer: reviewerRef() })));
  });

  it.live("fails with the provider's reason and keeps the saved Review", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    const reviewer = reviewerRef();
    return Effect.gen(function* () {
      yield* generated();
      reviewer.current = failingReviewer;
      const pass = yield* generated();
      assert.strictEqual(pass.status, "failed");
      assert.include(pass.error, "quota");
      assert.deepStrictEqual([...(yield* itemsByCheck).keys()], ["Open a.ts"]);
    }).pipe(Effect.provide(layerRevdoc({ root, reviewer })));
  });
});

describe("RevdocService batched generation", () => {
  const bigFile = (name: string) => `${name}\n${"x".repeat(50_000)}\n`;

  it.live("resumes an interrupted pass from its saved batches, even with another model", () => {
    const root = makeRepository();
    for (const name of ["one.ts", "two.ts", "three.ts"]) writeFile(root, name, bigFile(name));
    const calls: Array<{ prompt: string; model: string }> = [];
    const reviewer = reviewerRef();
    return Effect.gen(function* () {
      const revdoc = yield* RevdocService.RevdocService;
      const settings = yield* ServerSettings.ServerSettingsService;
      reviewer.current = (prompt, model) =>
        prompt.includes("This is batch 3 of 3") ? Effect.never : answering(calls)(prompt, model);
      const first = yield* revdoc.generate(target());
      yield* awaitProgress(first.passId, 2);
      yield* revdoc.cancel(target());
      assert.strictEqual((yield* awaitPass(first.passId)).status, "cancelled");
      const partial = yield* itemsByCheck;
      assert.strictEqual(partial.size, 2);
      assert.isTrue((yield* revdoc.read(target(), { attentionOnly: false })).review?.partial);

      yield* settings.updateSettings({
        revdocLargeModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "other-model",
        },
      });
      calls.length = 0;
      reviewer.current = answering(calls);
      const second = yield* revdoc.generate(target());
      assert.strictEqual((yield* awaitPass(second.passId)).status, "completed");
      const batchCalls = calls.filter((call) => call.prompt.includes("This is batch"));
      assert.deepStrictEqual(
        batchCalls.map((call) => /This is batch (\d) of 3/.exec(call.prompt)?.[1]),
        ["3"],
      );
      assert.isTrue(calls.every((call) => call.model === "other-model"));
      const items = yield* itemsByCheck;
      assert.deepStrictEqual([...items.keys()].toSorted(), [
        "Open one.ts",
        "Open three.ts",
        "Open two.ts",
      ]);
      assert.deepStrictEqual(
        [...partial.values()].map((item) => item.id).toSorted(),
        [...items.values()]
          .filter((item) => partial.has(item.check))
          .map((item) => item.id)
          .toSorted(),
      );
      const review = (yield* revdoc.read(target(), { attentionOnly: false })).review!;
      assert.isFalse(review.partial);
      assert.strictEqual(review.summary, "Review changes across 1 area.");
    }).pipe(Effect.provide(layerRevdoc({ root, reviewer })));
  });

  it.live(
    "starts fresh when the code changed since the interruption and keeps the saved Review",
    () => {
      const root = makeRepository();
      for (const name of ["one.ts", "two.ts", "three.ts"]) writeFile(root, name, bigFile(name));
      const calls: Array<{ prompt: string; model: string }> = [];
      const reviewer = reviewerRef();
      return Effect.gen(function* () {
        const revdoc = yield* RevdocService.RevdocService;
        reviewer.current = (prompt, model) =>
          prompt.includes("This is batch 3 of 3") ? Effect.never : answering(calls)(prompt, model);
        const first = yield* revdoc.generate(target());
        yield* awaitProgress(first.passId, 2);
        yield* revdoc.cancel(target());
        yield* awaitPass(first.passId);
        const saved = yield* itemsByCheck;
        yield* edit([...saved.values()][0]!, { _tag: "set_outcome", outcome: "complete" });

        writeFile(root, "one.ts", bigFile("one.ts changed"));
        calls.length = 0;
        reviewer.current = answering(calls);
        const second = yield* revdoc.generate(target());
        assert.strictEqual((yield* awaitPass(second.passId)).status, "completed");
        assert.strictEqual(calls.filter((call) => call.prompt.includes("This is batch")).length, 3);
        const items = yield* itemsByCheck;
        assert.strictEqual(items.size, 3);
        const kept = items.get([...saved.keys()][0]!)!;
        assert.strictEqual(kept.id, [...saved.values()][0]!.id);
        assert.strictEqual(kept.outcome, "complete");
      }).pipe(Effect.provide(layerRevdoc({ root, reviewer })));
    },
  );
});

describe("RevdocService test passes", () => {
  const childThreadId = CHILD_THREAD_ID;

  it.live("accepts results only from the pass's child, for its checks, while it runs", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    writeFile(root, "b.ts", "b\n");
    return Effect.gen(function* () {
      const revdoc = yield* RevdocService.RevdocService;
      yield* generated();
      const items = yield* itemsByCheck;
      const a = items.get("Open a.ts")!;
      const b = items.get("Open b.ts")!;
      const { passId } = yield* revdoc.test(
        { ...target(), selection: "items", itemIds: [a.id] },
        { threadId: THREAD_ID },
      );
      const result = {
        passId,
        itemId: a.id,
        state: "passed" as const,
        method: "command" as const,
        steps: "vp test",
        observed: "1 passed",
      };

      const stranger = yield* Effect.flip(revdoc.recordResult(result, THREAD_ID));
      assert.strictEqual(stranger.code, "not_allowed");
      const outside = yield* Effect.flip(
        revdoc.recordResult({ ...result, itemId: b.id }, childThreadId),
      );
      assert.strictEqual(outside.code, "not_allowed");
      const unproven = yield* Effect.flip(
        revdoc.recordResult({ ...result, method: "browser" }, childThreadId),
      );
      assert.strictEqual(unproven.code, "invalid_request");

      const recorded = yield* revdoc.recordResult(result, childThreadId);
      assert.deepStrictEqual(recorded.result, { state: "passed", evidenceCount: 0 });

      yield* revdoc.cancel(target());
      const late = yield* Effect.flip(
        revdoc.recordResult({ ...result, state: "failed" }, childThreadId),
      );
      assert.strictEqual(late.code, "not_allowed");
      assert.strictEqual((yield* itemsByCheck).get("Open a.ts")?.result?.state, "passed");
      const pass = yield* awaitPass(passId);
      assert.strictEqual(pass.status, "cancelled");
    }).pipe(
      Effect.provide(layerRevdoc({ root, reviewer: reviewerRef(), threads: delegatingThreads() })),
    );
  });

  it.live("still refuses a testing child after its pass row was pruned", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    return Effect.gen(function* () {
      const revdoc = yield* RevdocService.RevdocService;
      yield* generated();
      for (let pass = 0; pass < 3; pass++) {
        const { passId } = yield* revdoc.test(
          { ...target(), selection: "remaining" },
          { threadId: THREAD_ID },
        );
        yield* revdoc.cancel(target());
        yield* awaitPass(passId);
      }
      const refused = yield* Effect.flip(
        revdoc.generate({ threadId: childThreadId }, { threadId: childThreadId }),
      );
      assert.strictEqual(refused.code, "not_allowed");
    }).pipe(
      Effect.provide(layerRevdoc({ root, reviewer: reviewerRef(), threads: delegatingThreads() })),
    );
  });

  it.live("refuses passes started by a Revdoc testing child", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    return Effect.gen(function* () {
      const revdoc = yield* RevdocService.RevdocService;
      yield* generated();
      yield* revdoc.test({ ...target(), selection: "remaining" }, { threadId: THREAD_ID });
      const refused = yield* Effect.flip(
        revdoc.generate({ threadId: childThreadId }, { threadId: childThreadId }),
      );
      assert.strictEqual(refused.code, "not_allowed");
    }).pipe(
      Effect.provide(layerRevdoc({ root, reviewer: reviewerRef(), threads: delegatingThreads() })),
    );
  });

  it.live(
    "tests another worktree under its most recent thread, or explains that it has none",
    () => {
      const root = makeRepository();
      const other = addWorktree(root, "feature");
      writeFile(other, "feature.ts", "f\n");
      const otherThread = ThreadId.make("thread:revdoc-other");
      const withThreads = (projectThreads: ReadonlyArray<{ id: ThreadId; worktreePath: string }>) =>
        Effect.gen(function* () {
          const revdoc = yield* RevdocService.RevdocService;
          const at = target({ worktreePath: other });
          yield* awaitPass((yield* revdoc.generate(at)).passId, at);
          const read = yield* revdoc.read(at, { attentionOnly: false });
          assert.deepStrictEqual(
            read.items.map((item) => item.check),
            ["Open feature.ts"],
          );
          const started = yield* revdoc.test({ ...at, selection: "remaining" }).pipe(Effect.result);
          if (started._tag === "Failure") return started.failure.message;
          return (yield* revdoc.read(at, { attentionOnly: false })).activePass?.testing
            ?.parentThreadId;
        }).pipe(
          Effect.provide(
            layerRevdoc({
              root,
              reviewer: reviewerRef(),
              threads: { ...delegatingThreads(), projectThreads },
            }),
          ),
        );
      return Effect.gen(function* () {
        const refused = yield* withThreads([{ id: THREAD_ID, worktreePath: root }]);
        assert.strictEqual(refused, "Start a thread in this worktree to test it.");
        const parent = yield* withThreads([
          { id: THREAD_ID, worktreePath: root },
          { id: otherThread, worktreePath: other },
        ]);
        assert.strictEqual(parent, otherThread);
      });
    },
  );

  it.live("recovers a pass whose section ended while the server was down", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    let taskStatus = "running";
    const threadsWithTask = {
      ...delegatingThreads(),
      subagents: () => [{ id: "node:task-1", status: taskStatus, childThreadId: childThreadId }],
    };
    return Effect.gen(function* () {
      const revdoc = yield* RevdocService.RevdocService;
      yield* generated();
      const { passId } = yield* revdoc.test(
        { ...target(), selection: "remaining" },
        { threadId: THREAD_ID },
      );
      yield* revdoc.recover;
      taskStatus = "completed";
      yield* revdoc.recover;
      const pass = yield* awaitPass(passId);
      assert.strictEqual(pass.status, "completed");
      const [item] = (yield* revdoc.read(target(), { attentionOnly: false })).items;
      assert.strictEqual(item?.result?.state, "blocked");
    }).pipe(
      Effect.provide(layerRevdoc({ root, reviewer: reviewerRef(), threads: threadsWithTask })),
    );
  });
});
