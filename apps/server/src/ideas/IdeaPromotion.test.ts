import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";
import { IssueHost, fromAdapters } from "../issues/IssueHost.ts";
import type { IssueHostAdapter } from "../issues/IssueHostAdapter.ts";
import { publishingHost } from "../issues/IssueHost.testFixtures.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { IdeaRuntime } from "./IdeaRuntime.ts";
import { IdeaPromotion } from "./IdeaPromotion.ts";
import { clearIdeaExecution, setIdeaExecution } from "./IdeaExecution.ts";
import { ideaStateFixture, testIdeaId } from "./IdeaRuntime.testFixtures.ts";

const draft = (id: string) => ({
  id,
  title: "Build " + id,
  body: "Implement and verify " + id + ".",
  labels: [],
});
const fixture = Effect.fn(function* (
  options: {
    loseFirstResponse?: boolean;
    changeAfterFirstReadback?: boolean;
    alterReadback?: boolean;
    adapters?: (github: IssueHostAdapter) => ReadonlyArray<IssueHostAdapter>;
    provider?: string;
  } = {},
) {
  const state = ideaStateFixture();
  const host = publishingHost({
    ...(options.loseFirstResponse ? { loseFirstCreate: true } : {}),
    ...(options.alterReadback ? { alterReadback: true } : {}),
    onRead: (issue) => {
      if (options.changeAfterFirstReadback && issue.number === 1)
        state.set({ ...state.get(), contentRevision: state.get().contentRevision + 1 });
    },
  });
  setIdeaExecution(testIdeaId, {
    cwd: process.cwd(),
    projectDirectory: process.cwd(),
    mainRevision: "a".repeat(40),
    deletionEpoch: 0,
    context: "",
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => clearIdeaExecution(testIdeaId)));
  const promotion = yield* IdeaPromotion.pipe(
    Effect.provide(IdeaPromotion.layer),
    Effect.provideService(IdeaNotebookStore, state.store),
    Effect.provideService(OrchestrationEngineService, state.engine),
    Effect.provide(
      Layer.mock(IdeaRuntime)({ prepare: () => Effect.die("The execution is already prepared") }),
    ),
    Effect.provideService(RepositoryIdentityResolver, {
      resolve: () =>
        Effect.succeed({
          canonicalKey: "github.com/example/ideas",
          provider: options.provider ?? "github",
          displayName: "example/ideas",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/example/ideas.git",
          },
        }),
    }),
    Effect.provideService(
      IssueHost,
      fromAdapters(options.adapters?.(host.adapter) ?? [host.adapter]),
    ),
  );
  const approve = () => {
    const current = state.get();
    if (!current.promotion) throw new Error("No review to approve");
    state.set({ ...current, promotion: { ...current.promotion, status: "approved" } });
  };
  return { ...state, promotion, remote: host.remote, posts: () => host.remote.length, approve };
});

describe("idea publication outcomes", () => {
  it.effect(
    "reconciles an issue created before its response was lost without posting a duplicate",
    () =>
      Effect.gen(function* () {
        const state = yield* fixture({ loseFirstResponse: true });
        yield* state.promotion.propose({
          threadId: testIdeaId,
          drafts: [draft("notebook")],
          remainingScope: "",
        });
        state.approve();
        assert.equal(
          (yield* state.promotion.publish(testIdeaId).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.get().promotion?.status, "partial");
        assert.equal(state.get().promotion?.issues.length, 0);
        const retried = yield* state.promotion.publish(testIdeaId);
        assert.equal(retried.status, "complete");
        assert.equal(retried.issues[0]?.number, 1);
        assert.equal(state.posts(), 1);
        assert.equal(state.get().status, "settled");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "stops creating issues after a later notebook edit and permits a fresh reviewed remainder",
    () =>
      Effect.gen(function* () {
        const state = yield* fixture({ changeAfterFirstReadback: true });
        yield* state.promotion.propose({
          threadId: testIdeaId,
          drafts: [draft("first"), draft("second")],
          remainingScope: "",
        });
        state.approve();
        assert.equal(
          (yield* state.promotion.publish(testIdeaId).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.posts(), 1);
        assert.equal(state.get().promotion?.issues.length, 1);
        assert.equal(state.get().status, "active");
        const next = yield* state.promotion.propose({
          threadId: testIdeaId,
          drafts: [draft("revised second")],
          remainingScope: "",
        });
        assert.equal(next.status, "review");
        assert.equal(state.get().promotionHistory[0]?.issues[0]?.number, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps verified partial scope and accepts only a different follow-up breakdown", () =>
    Effect.gen(function* () {
      const state = yield* fixture();
      yield* state.promotion.propose({
        threadId: testIdeaId,
        drafts: [draft("first")],
        remainingScope: "The second feature remains.",
      });
      state.approve();
      assert.equal((yield* state.promotion.publish(testIdeaId)).status, "partial");
      assert.equal(
        (yield* state.promotion
          .propose({ threadId: testIdeaId, drafts: [draft("first")], remainingScope: "" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const next = yield* state.promotion.propose({
        threadId: testIdeaId,
        drafts: [draft("second")],
        remainingScope: "",
      });
      assert.equal(next.status, "review");
      assert.equal(state.get().promotionHistory[0]?.issues.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retains the remote identity but refuses settlement when readback differs from approved contents",
    () =>
      Effect.gen(function* () {
        const state = yield* fixture({ alterReadback: true });
        yield* state.promotion.propose({
          threadId: testIdeaId,
          drafts: [draft("notebook")],
          remainingScope: "",
        });
        state.approve();
        assert.equal(
          (yield* state.promotion.publish(testIdeaId).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.get().promotion?.issues[0]?.number, 1);
        assert.equal(state.get().promotion?.status, "partial");
        assert.equal(state.get().status, "active");
        assert.equal(
          (yield* state.promotion.publish(testIdeaId).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.posts(), 1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to propose issues for a project whose host cannot publish them", () =>
    Effect.gen(function* () {
      const state = yield* fixture({
        provider: "gitlab",
        adapters: (github) => [{ kind: "gitlab", list: github.list, get: github.get }],
      });
      const failure = yield* state.promotion
        .propose({ threadId: testIdeaId, drafts: [draft("notebook")], remainingScope: "" })
        .pipe(Effect.flip);
      assert.equal(
        failure.message,
        "Idea promotion currently supports GitHub project repositories. Configure the project's tracked remote before proposing issues.",
      );
      assert.equal(state.get().promotion, null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "refuses an approved destination whose host cannot publish before creating anything",
    () =>
      Effect.gen(function* () {
        const state = yield* fixture();
        const proposed = yield* state.promotion.propose({
          threadId: testIdeaId,
          drafts: [draft("notebook")],
          remainingScope: "",
        });
        state.set({
          ...state.get(),
          promotion: {
            ...proposed,
            status: "approved",
            target: { ...proposed.target, hostKind: "bitbucket" },
          },
        });
        const failure = yield* state.promotion.publish(testIdeaId).pipe(Effect.flip);
        assert.equal(failure.message, "The approved issue destination is unsupported.");
        assert.equal(state.posts(), 0);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
