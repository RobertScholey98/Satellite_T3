import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ProcessRunner } from "../processRunner.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { IdeaRuntime } from "./IdeaRuntime.ts";
import { IdeaPromotion } from "./IdeaPromotion.ts";
import { clearIdeaExecution, setIdeaExecution } from "./IdeaExecution.ts";
import { ideaStateFixture, testIdeaId } from "./IdeaRuntime.testFixtures.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const DraftBody = Schema.fromJsonString(
  Schema.Struct({ title: Schema.String, body: Schema.String }),
);
const decodeDraftBody = Schema.decodeEffect(DraftBody);
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
    unrelatedIssues?: number;
  } = {},
) {
  const state = ideaStateFixture();
  let posts = 0;
  const scannedPages: number[] = [];
  const remote = Array.from({ length: options.unrelatedIssues ?? 0 }, (_, index) => ({
    number: index + 1000,
    title: "Unrelated issue",
    body: "x".repeat(65_000),
    html_url: "https://github.com/example/ideas/issues/" + (index + 1000),
  }));
  const runner = Layer.succeed(ProcessRunner, {
    run: (input) =>
      Effect.gen(function* () {
        assert.equal(input.command, "gh");
        let stdout = "";
        let code = 0;
        if (input.args[0] === "repo") {
          assert.equal(input.args[2], "github.com/example/ideas");
          stdout = yield* encode({
            nameWithOwner: "example/ideas",
            hasIssuesEnabled: true,
            isArchived: false,
          });
        } else {
          assert.deepEqual(input.args.slice(0, 3), ["api", "--hostname", "github.com"]);
          if (input.args.includes("POST")) {
            posts++;
            const body = yield* decodeDraftBody(input.stdin ?? "{}").pipe(Effect.orDie);
            const issue = {
              ...body,
              number: posts,
              html_url: "https://github.com/example/ideas/issues/" + posts,
            };
            remote.push(issue);
            stdout = yield* encode(issue);
            if (posts === 1 && options.loseFirstResponse) code = 1;
          } else if (input.args.at(-1)?.includes("?state=all")) {
            const page = Number(
              new URL(input.args.at(-1)!, "https://api.github.com/").searchParams.get("page"),
            );
            scannedPages.push(page);
            stdout = yield* encode(remote.slice((page - 1) * 25, page * 25));
            assert.isBelow(Buffer.byteLength(stdout), 8 * 1024 * 1024);
          } else {
            const issue = remote.find((item) => input.args.at(-1)?.endsWith("/" + item.number));
            if (!issue) throw new Error("Unexpected issue readback");
            stdout = yield* encode(
              options.alterReadback
                ? { ...issue, body: issue.body + "\nAltered externally" }
                : issue,
            );
            if (options.changeAfterFirstReadback && issue.number === 1)
              state.set({ ...state.get(), contentRevision: state.get().contentRevision + 1 });
          }
        }
        return {
          code: ChildProcessSpawner.ExitCode(code),
          stdout,
          stderr: "",
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }).pipe(Effect.orDie),
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
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/example/ideas.git",
          },
        }),
    }),
    Effect.provide(runner),
  );
  const approve = () => {
    const current = state.get();
    if (!current.promotion) throw new Error("No review to approve");
    state.set({ ...current, promotion: { ...current.promotion, status: "approved" } });
  };
  return { ...state, promotion, remote, scannedPages, posts: () => posts, approve };
});

describe("idea publication outcomes", () => {
  it.effect(
    "reconciles uncertain publication beyond eight megabytes of unrelated issue history",
    () =>
      Effect.gen(function* () {
        const state = yield* fixture({ loseFirstResponse: true, unrelatedIssues: 150 });
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
        const retried = yield* state.promotion.publish(testIdeaId);
        assert.equal(retried.status, "complete");
        assert.equal(retried.issues[0]?.number, 1);
        assert.equal(state.posts(), 1);
        assert.deepEqual(state.scannedPages, [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
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
});
