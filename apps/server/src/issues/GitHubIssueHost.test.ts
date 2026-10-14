import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { IssueBoardLocator, IssueRef } from "@t3tools/contracts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubIssueHost from "./GitHubIssueHost.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeDraft = Schema.decodeUnknownSync(
  Schema.Struct({ title: Schema.String, body: Schema.String }),
);
const repository: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "0",
  number: 0,
  url: "https://github.com/owner/repo",
};
const scope = { cwd: "/repo", ref: repository };
const locator: Extract<IssueBoardLocator, { kind: "github-project" }> = {
  kind: "github-project",
  host: "github.com",
  owner: "owner",
  ownerKind: "user",
  projectNumber: 2,
};

const ok = (value: unknown): GitHubApi.GitHubRestResponse => ({
  status: 200,
  headers: {},
  body: json(value),
  truncated: false,
  invalidUtf8: false,
});
/** A GitHub API that answers only the requests a test scripts, and dies on anything else. */
const adapterOn = (api: {
  readonly rest?: (input: GitHubApi.GitHubRestInput) => GitHubApi.GitHubRestResponse | undefined;
  readonly graphql?: (query: string, variables: Record<string, unknown>) => unknown;
}) =>
  GitHubIssueHost.make.pipe(
    Effect.provideService(
      GitHubApi.GitHubApi,
      GitHubApi.GitHubApi.of({
        rest: (input) => {
          const response = api.rest?.(input);
          return response ? Effect.succeed(response) : Effect.die(`Unexpected ${input.path}`);
        },
        graphql: (input) => {
          const data = api.graphql?.(input.query, { ...input.variables });
          return data === undefined
            ? Effect.die("Unexpected GraphQL request")
            : Effect.succeed(json({ data }));
        },
        credential: () => Effect.die("Unexpected credential read"),
      }),
    ),
  );

/** One user project with a Status field whose items live on two pages, moved by the mutation. */
const projectHost = () => {
  let column = "column-ready";
  const projectItems = (cursor: unknown) =>
    cursor === null
      ? {
          nodes: [
            {
              id: "item-42",
              updatedAt: "version-1",
              content: {
                __typename: "Issue",
                number: 42,
                title: "Task",
                state: "OPEN",
                updatedAt: "now",
                url: "https://github.com/owner/repo/issues/42",
                repository: { nameWithOwner: "owner/repo" },
                labels: { nodes: [{ name: "bug" }] },
              },
              fieldValues: { nodes: [{ optionId: column, field: { id: "field-node" } }] },
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: "page-2" },
        }
      : {
          nodes: [
            { id: "draft", content: { __typename: "DraftIssue" } },
            { id: "pr", content: { __typename: "PullRequest" } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
  return adapterOn({
    graphql: (query, variables) => {
      if (query.includes("updateProjectV2ItemFieldValue")) {
        if (variables.item === "item-42" && variables.field === "field-node")
          column = String(variables.option);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-42" } } };
      }
      if (query.includes("projectV2(number"))
        return {
          user: {
            projectV2: {
              id: "project-node",
              title: "Planning",
              fields: {
                nodes: [
                  {
                    id: "field-node",
                    name: "Status",
                    options: [
                      { id: "column-ready", name: "Selected" },
                      { id: "column-work", name: "Doing" },
                    ],
                  },
                ],
              },
            },
          },
        };
      return { node: { items: projectItems(variables.cursor) } };
    },
  });
};

describe("GitHubIssueHost", () => {
  it.effect("lists issues with their labels and leaves pull requests out", () =>
    Effect.gen(function* () {
      const adapter = yield* adapterOn({
        rest: () =>
          ok([
            {
              number: 42,
              title: "Task",
              state: "open",
              updated_at: "now",
              html_url: "https://github.com/owner/repo/issues/42",
              labels: [{ name: "bug" }],
            },
            { number: 43, pull_request: {}, title: "PR" },
          ]),
      });
      const result = yield* adapter.list(scope);
      assert.deepStrictEqual(result, {
        issues: [
          {
            ref: {
              ...repository,
              id: "42",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
            },
            title: "Task",
            state: "open",
            updatedAt: "now",
            labels: ["bug"],
          },
        ],
        nextCursor: null,
      });
    }),
  );

  it.effect("reads a project board across item pages, skipping drafts and pull requests", () =>
    Effect.gen(function* () {
      const boards = (yield* projectHost()).boards;
      const board = yield* boards.read("/repo", locator);
      assert.deepStrictEqual(board.columns, [
        { id: "column-ready", title: "Selected" },
        { id: "column-work", title: "Doing" },
      ]);
      assert.deepStrictEqual(
        board.items.map((item) => [
          item.itemId,
          item.columnId,
          item.issue.state,
          item.issue.labels,
        ]),
        [["item-42", "column-ready", "open", ["bug"]]],
      );
    }),
  );

  it.effect("moves a project item to another Status option", () =>
    Effect.gen(function* () {
      const boards = (yield* projectHost()).boards;
      const board = yield* boards.read("/repo", locator);
      const connected = { ...locator, projectNodeId: "project-node", statusFieldId: "field-node" };
      assert.deepStrictEqual(board.locator, connected);
      yield* boards.move("/repo", connected, board.items[0]!, "column-work");
      const moved = yield* boards.read("/repo", connected);
      assert.strictEqual(moved.items[0]?.columnId, "column-work");
    }),
  );

  it.effect("refuses a move on a project connected without its Status field", () =>
    Effect.gen(function* () {
      const boards = (yield* projectHost()).boards;
      const board = yield* boards.read("/repo", locator);
      const failure = yield* boards
        .move("/repo", locator, board.items[0]!, "column-work")
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        ["invalid", "Reconnect this GitHub Project to select its Status field."],
      );
    }),
  );

  it.effect("refuses a project that has no single-select Status field", () =>
    Effect.gen(function* () {
      const adapter = yield* adapterOn({
        graphql: () => ({
          user: { projectV2: { id: "project-node", title: "Planning", fields: { nodes: [] } } },
        }),
      });
      const failure = yield* adapter.boards.read("/repo", locator).pipe(Effect.flip);
      assert.strictEqual(
        failure.message,
        "Choose an existing GitHub Project with a single-select Status field.",
      );
    }),
  );

  it.effect("fails a missing project instead of showing an empty board", () =>
    Effect.gen(function* () {
      const adapter = yield* adapterOn({ graphql: () => ({ user: { projectV2: null } }) });
      const failure = yield* adapter.boards.read("/repo", locator).pipe(Effect.flip);
      assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
    }),
  );

  it.effect("discovers organization projects on later pages", () =>
    Effect.gen(function* () {
      const adapter = yield* adapterOn({
        rest: (input) => (input.path === "users/owner" ? ok({ type: "Organization" }) : undefined),
        graphql: (query, variables) => {
          if (!query.startsWith("query($owner:String!,$cursor:String){organization")) return;
          const first = variables.cursor === null;
          return {
            organization: {
              projectsV2: {
                nodes: [
                  first
                    ? { id: "P1", title: "Roadmap", number: 1 }
                    : { id: "P2", title: "Bugs", number: 2 },
                ],
                pageInfo: { hasNextPage: first, endCursor: first ? "next" : null },
              },
            },
          };
        },
      });
      const boards = yield* adapter.boards.list(scope);
      assert.deepStrictEqual(
        boards.map((board) => [board.title, board.locator]),
        [
          [
            "Roadmap",
            {
              kind: "github-project",
              host: "github.com",
              owner: "owner",
              ownerKind: "organization",
              projectNumber: 1,
              projectNodeId: "P1",
            },
          ],
          [
            "Bugs",
            {
              kind: "github-project",
              host: "github.com",
              owner: "owner",
              ownerKind: "organization",
              projectNumber: 2,
              projectNodeId: "P2",
            },
          ],
        ],
      );
    }),
  );

  it.effect("reports a GitHub API failure with the API's own message", () =>
    Effect.gen(function* () {
      const adapter = yield* GitHubIssueHost.make.pipe(
        Effect.provideService(
          GitHubApi.GitHubApi,
          GitHubApi.GitHubApi.of({
            rest: (input) =>
              Effect.fail(
                new GitHubApi.GitHubApiAuthenticationError({
                  host: input.host,
                  operation: input.operation,
                }),
              ),
            graphql: () => Effect.die("Unexpected GraphQL request"),
            credential: () => Effect.die("Unexpected credential read"),
          }),
        ),
      );
      const failure = yield* adapter.list(scope).pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        [
          "remote",
          "GitHub refused the credential for github.com. Run `gh auth login --hostname github.com` and retry.",
        ],
      );
    }),
  );

  it.effect("refuses a truncated response instead of decoding part of it", () =>
    Effect.gen(function* () {
      const adapter = yield* adapterOn({ rest: () => ({ ...ok([]), truncated: true }) });
      const failure = yield* adapter.list(scope).pipe(Effect.flip);
      assert.strictEqual(failure.message, "The GitHub response exceeded the issue response limit.");
    }),
  );
});

describe("GitHubIssueHost publication", () => {
  /** A repository that accepts posted issues while `settings` allow it. */
  const repositoryHost = (settings: {
    archived?: boolean;
    has_issues?: boolean;
    full_name?: string;
  }) => {
    const issues: { number: number; title: string; body: string; html_url: string }[] = [];
    const adapter = adapterOn({
      rest: (input) => {
        if (input.path === "repos/owner/repo")
          return ok({ full_name: "owner/repo", has_issues: true, archived: false, ...settings });
        if (input.path === "repos/owner/repo/issues" && input.method === "POST") {
          const { title, body } = decodeDraft(input.body);
          const number = issues.length + 1;
          issues.push({
            number,
            title,
            body,
            html_url: `https://github.com/owner/repo/issues/${number}`,
          });
          return { ...ok(issues.at(-1)), status: 201 };
        }
      },
    });
    return { adapter, issues };
  };
  const draft = { title: "Build it", body: "Details\n\n<!-- marker -->", labels: ["idea"] };

  it.effect("creates an issue in a repository that accepts them", () =>
    Effect.gen(function* () {
      const host = repositoryHost({});
      const adapter = yield* host.adapter;
      assert.deepStrictEqual(yield* adapter.publication.create(scope, draft), {
        number: 1,
        title: "Build it",
        url: "https://github.com/owner/repo/issues/1",
        body: "Details\n\n<!-- marker -->",
      });
    }),
  );

  it.effect("refuses an archived, issue-less, or renamed repository before creating anything", () =>
    Effect.gen(function* () {
      for (const settings of [
        { archived: true },
        { has_issues: false },
        { full_name: "someone-else/repo" },
      ]) {
        const host = repositoryHost(settings);
        const adapter = yield* host.adapter;
        const failure = yield* adapter.publication.create(scope, draft).pipe(Effect.flip);
        assert.deepStrictEqual(
          [failure.reason, failure.message],
          [
            "unavailable",
            "This repository cannot accept issues. Enable Issues or choose an active issue tracker before promotion.",
          ],
        );
        assert.deepStrictEqual(host.issues, []);
      }
    }),
  );

  it.effect("finds marked issues past many pages of large unrelated issues", () =>
    Effect.gen(function* () {
      const issues = [
        ...Array.from({ length: 150 }, (_, i) => ({
          number: i + 1,
          title: "Unrelated",
          body: "x".repeat(65_000),
          html_url: `https://github.com/owner/repo/issues/${i + 1}`,
        })),
        {
          number: 151,
          title: "Build it",
          body: "Details\n\n<!-- marker -->",
          html_url: "https://github.com/owner/repo/issues/151",
        },
      ];
      const adapter = yield* adapterOn({
        rest: (input) => {
          const url = new URL(input.path, "https://api.github.test/");
          if (url.pathname !== "/repos/owner/repo/issues") return;
          const page = Number(url.searchParams.get("page"));
          const size = Number(url.searchParams.get("per_page"));
          return ok(issues.slice((page - 1) * size, page * size));
        },
      });
      const found = yield* adapter.publication.findByMarker(scope, ["<!-- marker -->"]);
      assert.deepStrictEqual(found, [
        {
          number: 151,
          title: "Build it",
          url: "https://github.com/owner/repo/issues/151",
          body: "Details\n\n<!-- marker -->",
        },
      ]);
    }),
  );
});
