import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubIssueHost from "./GitHubIssueHost.ts";
import type { IssueHostAdapter, IssueHostScope } from "./IssueHostAdapter.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** What the scripted host holds. Every subject serves it in its own wire format. */
interface World {
  readonly issues: ReadonlyArray<number>;
  /** Items the host lists beside issues, such as pull requests. */
  readonly nonIssues?: ReadonlyArray<number>;
  /** Comment bodies on every issue, in order. */
  readonly comments?: ReadonlyArray<string>;
  readonly malformed?: "not-json" | "missing-title";
}
interface Subject {
  readonly name: string;
  readonly scope: IssueHostScope;
  readonly adapter: (world: World) => Effect.Effect<IssueHostAdapter>;
}

const pageOf = <A>(items: ReadonlyArray<A>, page: number, size: number) =>
  items.slice((page - 1) * size, page * size);

const github: Subject = {
  name: "GitHub",
  scope: {
    cwd: "/repo",
    ref: {
      hostKind: "github",
      host: "github.com",
      repository: "owner/repo",
      id: "0",
      number: 0,
      url: "https://github.com/owner/repo",
    },
  },
  adapter: (world) => {
    const issue = (number: number) => ({
      number,
      ...(world.malformed === "missing-title" ? {} : { title: `Issue ${number}` }),
      state: "open",
      updated_at: "2026-10-01T00:00:00Z",
      html_url: `https://github.com/owner/repo/issues/${number}`,
    });
    const listed = [
      ...(world.nonIssues ?? []).map((number) => ({ ...issue(number), pull_request: {} })),
      ...world.issues.map(issue),
    ];
    const answer = (path: string): unknown => {
      if (world.malformed === "not-json") return "<html>";
      const url = new URL(path, "https://api.github.test/");
      const page = Number(url.searchParams.get("page") ?? "1");
      const [, , , , kind, number, comments] = url.pathname.split("/");
      if (kind !== "issues") return undefined;
      if (number === undefined) return pageOf(listed, page, 100);
      if (comments === undefined) return issue(Number(number));
      return pageOf(world.comments ?? [], page, 100).map((body, index) => ({
        id: (page - 1) * 100 + index,
        body,
        created_at: "2026-10-01T00:00:00Z",
        user: { login: "rob" },
      }));
    };
    return GitHubIssueHost.make.pipe(
      Effect.provideService(
        GitHubApi.GitHubApi,
        GitHubApi.GitHubApi.of({
          rest: (input) => {
            const value = answer(input.path);
            if (value === undefined) return Effect.die(`Unexpected GitHub path ${input.path}`);
            return Effect.succeed({
              status: 200,
              headers: {},
              body: typeof value === "string" ? value : json(value),
              truncated: false,
              invalidUtf8: false,
            });
          },
          graphql: () => Effect.die("The issue contract does not use GraphQL"),
          credential: () => Effect.die("The issue contract does not read credentials"),
        }),
      ),
    );
  },
};

const subjects: ReadonlyArray<Subject> = [github];

const listAll = Effect.fn(function* (adapter: IssueHostAdapter, scope: IssueHostScope) {
  const numbers: number[] = [];
  let cursor: string | undefined;
  do {
    const page = yield* adapter.list(scope, cursor);
    numbers.push(...page.issues.map((issue) => issue.ref.number));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return numbers;
});
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

describe.each(subjects)("issue host contract: $name", (subject) => {
  it.effect("returns later pages of issues instead of dropping them", () =>
    Effect.gen(function* () {
      const adapter = yield* subject.adapter({ issues: range(1, 150) });
      assert.deepStrictEqual(yield* listAll(adapter, subject.scope), range(1, 150));
    }),
  );
  it.effect("excludes listed items that are not issues", () =>
    Effect.gen(function* () {
      const adapter = yield* subject.adapter({ issues: [1, 2], nonIssues: [3] });
      assert.deepStrictEqual(yield* listAll(adapter, subject.scope), [1, 2]);
    }),
  );
  it.effect("reads an issue with every page of its comments", () =>
    Effect.gen(function* () {
      const bodies = range(1, 150).map((n) => `Comment ${n}`);
      const adapter = yield* subject.adapter({ issues: [7], comments: bodies });
      const detail = yield* adapter.get({
        ...subject.scope,
        ref: { ...subject.scope.ref, id: "7", number: 7 },
      });
      assert.strictEqual(detail.ref.number, 7);
      assert.strictEqual(detail.title, "Issue 7");
      assert.deepStrictEqual(
        detail.comments?.map((comment) => comment.body),
        bodies,
      );
    }),
  );
  it.effect("fails on a malformed response rather than listing nothing", () =>
    Effect.gen(function* () {
      const adapter = yield* subject.adapter({ issues: [1], malformed: "not-json" });
      const failure = yield* adapter.list(subject.scope).pipe(Effect.flip);
      assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
    }),
  );
  it.effect("fails when an issue lacks a required field", () =>
    Effect.gen(function* () {
      const adapter = yield* subject.adapter({ issues: [1], malformed: "missing-title" });
      const failure = yield* adapter.list(subject.scope).pipe(Effect.flip);
      assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
    }),
  );
});
