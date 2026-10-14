import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as ForgejoCli from "../sourceControl/ForgejoCli.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as AzureBoardsIssueHost from "./AzureBoardsIssueHost.ts";
import * as BitbucketIssueHost from "./BitbucketIssueHost.ts";
import * as ForgejoIssueHost from "./ForgejoIssueHost.ts";
import * as GitHubIssueHost from "./GitHubIssueHost.ts";
import * as GitLabIssueHost from "./GitLabIssueHost.ts";
import { azureCli, type AzureRequest } from "./IssueHost.testFixtures.ts";
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
  readonly adapter: (
    world: World,
  ) => Effect.Effect<IssueHostAdapter, never, FileSystem.FileSystem | Path.Path>;
}

const decodeBatch = Schema.decodeUnknownSync(Schema.Struct({ ids: Schema.Array(Schema.Number) }));
const decodeQuery = Schema.decodeUnknownSync(Schema.Struct({ query: Schema.String }));
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

const azure: Subject = {
  name: "Azure Boards",
  scope: {
    cwd: "/repo",
    ref: {
      hostKind: "azure-devops",
      host: "dev.azure.com",
      repository: "org/Project",
      id: "0",
      number: 0,
      url: "https://dev.azure.com/org/Project",
    },
  },
  adapter: (world) =>
    Effect.gen(function* () {
      const workItem = (id: number) => ({
        id,
        rev: 1,
        fields: {
          ...(world.malformed === "missing-title" ? {} : { "System.Title": `Issue ${id}` }),
          "System.State": "New",
          "System.ChangedDate": "2026-10-01T00:00:00Z",
          "System.WorkItemType": "Task",
        },
      });
      const answer = (request: AzureRequest) => {
        if (world.malformed === "not-json") return "<html>";
        if (request.resource === "wiql") {
          const after = Number(/\[System\.Id\] > (\d+)/.exec(decodeQuery(request.body).query)?.[1]);
          const ids = world.issues.filter((id) => id > after).slice(0, Number(request.query.$top));
          return { workItems: ids.map((id) => ({ id })) };
        }
        if (request.resource === "workItemsBatch")
          return {
            value: decodeBatch(request.body).ids.map(workItem),
          };
        if (request.resource === "comments") {
          const offset = Number(request.query.continuationToken ?? "0");
          const next = offset + Number(request.query.$top);
          const comments = world.comments ?? [];
          return {
            comments: comments.slice(offset, next).map((text, index) => ({
              id: offset + index,
              text,
              createdDate: "2026-10-01T00:00:00Z",
              createdBy: { displayName: "Rob" },
            })),
            continuation_token: next < comments.length ? String(next) : null,
          };
        }
      };
      const cli = yield* azureCli("org", (request) => Effect.sync(() => answer(request)));
      return yield* AzureBoardsIssueHost.make.pipe(Effect.provide(cli));
    }),
};

/** Serves a REST host's issue list, one issue, or one issue's comments from the world. */
const restAnswer = (
  world: World,
  path: string,
  host: {
    readonly size: string;
    readonly issue: (number: number) => Record<string, unknown>;
    readonly nonIssue?: (number: number) => Record<string, unknown>;
    readonly comment: (body: string, id: number) => Record<string, unknown>;
    readonly page?: (items: ReadonlyArray<unknown>, more: boolean) => unknown;
  },
): unknown => {
  if (world.malformed === "not-json") return "<html>";
  const url = new URL(path, "https://api.host.test/");
  const segments = url.pathname.split("/");
  const [number, comments] = segments.slice(segments.indexOf("issues") + 1);
  const page = Number(url.searchParams.get("page") ?? "1");
  const size = Number(url.searchParams.get(host.size));
  const respond = (items: ReadonlyArray<unknown>) => {
    const slice = pageOf(items, page, size);
    return host.page ? host.page(slice, page * size < items.length) : slice;
  };
  const issue = (n: number) => {
    const raw = host.issue(n);
    if (world.malformed !== "missing-title") return raw;
    const { title: _title, ...rest } = raw;
    return rest;
  };
  if (number === undefined)
    return respond([
      ...(host.nonIssue ? (world.nonIssues ?? []).map(host.nonIssue) : []),
      ...world.issues.map(issue),
    ]);
  if (comments === undefined) return issue(Number(number));
  return respond((world.comments ?? []).map(host.comment));
};
const vcsOutput = (value: unknown) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: typeof value === "string" ? value : json(value),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});
const repositoryScope = (
  hostKind: IssueHostScope["ref"]["hostKind"],
  host: string,
): IssueHostScope => ({
  cwd: "/repo",
  ref: {
    hostKind,
    host,
    repository: "owner/repo",
    id: "0",
    number: 0,
    url: `https://${host}/owner/repo`,
  },
});

const gitlab: Subject = {
  name: "GitLab",
  scope: repositoryScope("gitlab", "gitlab.com"),
  adapter: (world) =>
    GitLabIssueHost.make.pipe(
      Effect.provide(
        Layer.mock(GitLabCli.GitLabCli)({
          execute: ({ args }) =>
            Effect.succeed(
              vcsOutput(
                restAnswer(world, args[3]!, {
                  size: "per_page",
                  issue: (iid) => ({
                    iid,
                    title: `Issue ${iid}`,
                    state: "opened",
                    updated_at: "2026-10-01T00:00:00Z",
                    web_url: `https://gitlab.com/owner/repo/-/issues/${iid}`,
                  }),
                  comment: (body, id) => ({
                    id,
                    body,
                    created_at: "2026-10-01T00:00:00Z",
                    author: { name: "Rob" },
                  }),
                }),
              ),
            ),
        }),
      ),
    ),
};

const forgejo: Subject = {
  name: "Forgejo",
  scope: repositoryScope("forgejo", "codeberg.org"),
  adapter: (world) => {
    const issue = (number: number) => ({
      number,
      title: `Issue ${number}`,
      state: "open",
      updated_at: "2026-10-01T00:00:00Z",
      html_url: `https://codeberg.org/owner/repo/issues/${number}`,
    });
    return ForgejoIssueHost.make.pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: ({ path }) =>
            Effect.succeed(
              vcsOutput(
                restAnswer(world, path, {
                  size: "limit",
                  issue,
                  nonIssue: (number) => ({ ...issue(number), pull_request: {} }),
                  comment: (body, id) => ({
                    id,
                    body,
                    created_at: "2026-10-01T00:00:00Z",
                    user: { login: "rob" },
                  }),
                }),
              ),
            ),
        }),
      ),
    );
  },
};

const bitbucket: Subject = {
  name: "Bitbucket",
  scope: repositoryScope("bitbucket", "bitbucket.org"),
  adapter: (world) =>
    BitbucketIssueHost.make.pipe(
      Effect.provide(
        Layer.mock(BitbucketApi.BitbucketApi)({
          request: ({ url }) => {
            const value = restAnswer(world, url, {
              size: "pagelen",
              issue: (id) => ({
                id,
                title: `Issue ${id}`,
                state: "new",
                updated_on: "2026-10-01T00:00:00Z",
                links: { html: { href: `https://bitbucket.org/owner/repo/issues/${id}` } },
              }),
              comment: (body, id) => ({
                id,
                content: { raw: body },
                created_on: "2026-10-01T00:00:00Z",
                user: { display_name: "Rob" },
              }),
              page: (values, more) => ({ values, ...(more ? { next: "more" } : {}) }),
            });
            return Effect.succeed({
              body: typeof value === "string" ? value : json(value),
              truncated: false,
            });
          },
        }),
      ),
    ),
};

const subjects: ReadonlyArray<Subject> = [github, azure, gitlab, forgejo, bitbucket];

const build = (subject: Subject, world: World) =>
  subject.adapter(world).pipe(Effect.provide(NodeServices.layer));
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
      const adapter = yield* build(subject, { issues: range(1, 150) });
      assert.deepStrictEqual(yield* listAll(adapter, subject.scope), range(1, 150));
    }),
  );
  it.effect("excludes listed items that are not issues", () =>
    Effect.gen(function* () {
      const adapter = yield* build(subject, { issues: [1, 2], nonIssues: [3] });
      assert.deepStrictEqual(yield* listAll(adapter, subject.scope), [1, 2]);
    }),
  );
  it.effect("reads an issue with every page of its comments", () =>
    Effect.gen(function* () {
      const bodies = range(1, 150).map((n) => `Comment ${n}`);
      const adapter = yield* build(subject, { issues: [7], comments: bodies });
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
      const adapter = yield* build(subject, { issues: [1], malformed: "not-json" });
      const failure = yield* adapter.list(subject.scope).pipe(Effect.flip);
      assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
    }),
  );
  it.effect("fails when an issue lacks a required field", () =>
    Effect.gen(function* () {
      const adapter = yield* build(subject, { issues: [1], malformed: "missing-title" });
      const failure = yield* adapter.list(subject.scope).pipe(Effect.flip);
      assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
    }),
  );
});
