import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  SourceControlProviderKind,
  type IssueBoardItem,
  type IssueBoardLocator,
  type IssueRef,
} from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubIssueHost from "./GitHubIssueHost.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRest from "./GitHubRest.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeGraphQlBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      operationName: Schema.String,
      variables: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);

/** One request as the fake GitHub saw it. GraphQL requests carry their operation and variables. */
interface Sent {
  readonly method: string;
  readonly url: string;
  readonly operationName?: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}
type Respond = (sent: Sent) => Response;

const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : encodeJson(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const data = (value: unknown) => json({ data: value });

/**
 * The adapter over upstream's real REST transport, request policy, quota and rate limit, with a
 * fixed credential and a fake GitHub answering every request with `respond`.
 */
const harness = (respond: Respond) => {
  const sent: Array<Sent> = [];
  const services = Layer.mergeAll(
    Layer.succeed(GitHubCredentials.GitHubCredentials, {
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("secret"),
          source: "gh" as const,
          fingerprint: `${host}:secret`,
        }),
      invalidate: () => Effect.void,
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const body =
            request.body._tag === "Uint8Array"
              ? decodeGraphQlBody(new TextDecoder().decode(request.body.body))
              : undefined;
          const entry: Sent = { method: request.method, url: request.url, ...body };
          sent.push(entry);
          return HttpClientResponse.fromWeb(request, respond(entry));
        }),
      ),
    ),
    GitHubQuota.layer,
    SourceControlRateLimit.layer,
  );
  const layer = GitHubRest.layer.pipe(Layer.provideMerge(services));
  return { adapter: GitHubIssueHost.make.pipe(Effect.provide(layer)), sent };
};

const repository: IssueRef = {
  hostKind: SourceControlProviderKind.make("github"),
  host: "github.com",
  repository: "acme/web",
  id: "0",
  number: 0,
  url: "https://github.com/acme/web",
};
const scope = { cwd: "/repo", ref: repository };
const locator: Extract<IssueBoardLocator, { kind: "github-project" }> = {
  kind: "github-project",
  host: "github.com",
  owner: "acme",
  ownerKind: "organization",
  projectNumber: 3,
};
const connected = { ...locator, projectNodeId: "PVT_board", statusFieldId: "PVTSSF_status" };

const issueContent = (number: number) => ({
  __typename: "Issue",
  number,
  title: `Issue ${number}`,
  state: "OPEN",
  updatedAt: "2026-10-01T00:00:00Z",
  url: `https://github.com/acme/web/issues/${number}`,
  repository: { nameWithOwner: "acme/web" },
  labels: { nodes: [{ name: "bug" }] },
});
const selectValue = (fieldId: string, name: string, optionId: string) => ({
  __typename: "ProjectV2ItemFieldSingleSelectValue",
  optionId,
  field: { __typename: "ProjectV2SingleSelectField", id: fieldId, name },
});
const projectItem = (id: string, content: unknown, values: ReadonlyArray<unknown>) => ({
  id,
  updatedAt: "2026-10-02T00:00:00Z",
  content,
  fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldTextValue" }, ...values] },
});
const statusField = {
  __typename: "ProjectV2SingleSelectField",
  id: "PVTSSF_status",
  name: "Status",
  options: [
    { id: "opt_todo", name: "Todo" },
    { id: "opt_doing", name: "Doing" },
  ],
};
const project = (fields: ReadonlyArray<unknown>) =>
  data({
    organization: {
      projectV2: {
        id: "PVT_board",
        title: "Roadmap",
        fields: { nodes: [{ __typename: "ProjectV2Field" }, ...fields] },
      },
    },
  });
const itemsPage = (nodes: ReadonlyArray<unknown>, endCursor: string | null) =>
  data({
    node: {
      __typename: "ProjectV2",
      items: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
    },
  });
const boardItem = (itemId: string, number: number, columnId: string | null): IssueBoardItem => ({
  itemId,
  columnId,
  version: "2026-10-02T00:00:00Z",
  issue: {
    ref: {
      hostKind: SourceControlProviderKind.make("github"),
      host: "github.com",
      repository: "acme/web",
      id: String(number),
      number,
      url: `https://github.com/acme/web/issues/${number}`,
    },
    title: `Issue ${number}`,
    state: "open",
    updatedAt: "2026-10-01T00:00:00Z",
    labels: ["bug"],
  },
});
const graphQlCalls = (sent: ReadonlyArray<Sent>) =>
  sent
    .filter((entry) => entry.operationName !== undefined)
    .map((entry) => [entry.operationName, entry.variables]);
const unexpected = (sent: Sent) => json({ message: `Unexpected ${sent.url}` }, 599);

describe("GitHubIssueHost boards", () => {
  it.effect("discovers an organization's Projects across pages", () =>
    Effect.gen(function* () {
      const { adapter, sent } = harness((request) => {
        if (request.url === "https://api.github.com/users/acme")
          return json({ type: "Organization" });
        if (request.operationName !== "OrganizationProjects") return unexpected(request);
        const first = request.variables?.after === undefined;
        return data({
          organization: {
            projectsV2: {
              nodes: [
                first
                  ? { id: "PVT_1", title: "Roadmap", number: 1 }
                  : { id: "PVT_2", title: "Bugs", number: 2 },
              ],
              pageInfo: { hasNextPage: first, endCursor: first ? "cursor-1" : null },
            },
          },
        });
      });
      const boards = yield* (yield* adapter).boards.list(scope);
      assert.deepStrictEqual(boards, [
        {
          title: "Roadmap",
          locator: {
            kind: "github-project",
            host: "github.com",
            owner: "acme",
            ownerKind: "organization",
            projectNumber: 1,
            projectNodeId: "PVT_1",
          },
        },
        {
          title: "Bugs",
          locator: {
            kind: "github-project",
            host: "github.com",
            owner: "acme",
            ownerKind: "organization",
            projectNumber: 2,
            projectNodeId: "PVT_2",
          },
        },
      ]);
      assert.deepStrictEqual(
        sent.map((entry) => entry.url),
        [
          "https://api.github.com/users/acme",
          "https://api.github.com/graphql",
          "https://api.github.com/graphql",
        ],
      );
      assert.deepStrictEqual(graphQlCalls(sent), [
        ["OrganizationProjects", { owner: "acme" }],
        ["OrganizationProjects", { owner: "acme", after: "cursor-1" }],
      ]);
    }),
  );

  it.effect("discovers a user's Projects with the user query", () =>
    Effect.gen(function* () {
      const { adapter, sent } = harness((request) => {
        if (request.url === "https://api.github.com/users/rob") return json({ type: "User" });
        if (request.operationName !== "UserProjects") return unexpected(request);
        return data({
          user: {
            projectsV2: {
              nodes: [{ id: "PVT_9", title: "Personal", number: 9 }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      });
      const boards = yield* (yield* adapter).boards.list({
        cwd: "/repo",
        ref: { ...repository, repository: "rob/dotfiles" },
      });
      assert.deepStrictEqual(boards, [
        {
          title: "Personal",
          locator: {
            kind: "github-project",
            host: "github.com",
            owner: "rob",
            ownerKind: "user",
            projectNumber: 9,
            projectNodeId: "PVT_9",
          },
        },
      ]);
      assert.deepStrictEqual(graphQlCalls(sent), [["UserProjects", { owner: "rob" }]]);
    }),
  );

  it.effect("reads a board across item pages, keeping only issues, by its Status field", () =>
    Effect.gen(function* () {
      const { adapter, sent } = harness((request) => {
        if (request.operationName === "OrganizationProject") return project([statusField]);
        if (request.operationName !== "ProjectItems") return unexpected(request);
        return request.variables?.after === undefined
          ? itemsPage(
              [
                projectItem("PVTI_1", issueContent(1), [
                  selectValue("PVTSSF_status", "Status", "opt_todo"),
                ]),
                projectItem("PVTI_draft", { __typename: "DraftIssue" }, []),
              ],
              "cursor-1",
            )
          : itemsPage(
              [
                projectItem("PVTI_pr", { __typename: "PullRequest" }, []),
                projectItem("PVTI_2", issueContent(2), []),
              ],
              null,
            );
      });
      const board = yield* (yield* adapter).boards.read("/repo", locator);
      assert.deepStrictEqual(board, {
        title: "Roadmap",
        locator: connected,
        columns: [
          { id: "opt_todo", title: "Todo" },
          { id: "opt_doing", title: "Doing" },
        ],
        items: [boardItem("PVTI_1", 1, "opt_todo"), boardItem("PVTI_2", 2, null)],
      });
      assert.deepStrictEqual(graphQlCalls(sent), [
        ["OrganizationProject", { owner: "acme", number: 3 }],
        ["ProjectItems", { projectId: "PVT_board" }],
        ["ProjectItems", { projectId: "PVT_board", after: "cursor-1" }],
      ]);
    }),
  );

  it.effect("reads the stored Status field even when another field is named Status", () =>
    Effect.gen(function* () {
      const { adapter } = harness((request) => {
        if (request.operationName === "OrganizationProject")
          return project([
            statusField,
            {
              __typename: "ProjectV2SingleSelectField",
              id: "PVTSSF_stage",
              name: "Stage",
              options: [{ id: "opt_review", name: "Review" }],
            },
          ]);
        if (request.operationName !== "ProjectItems") return unexpected(request);
        return itemsPage(
          [
            projectItem("PVTI_1", issueContent(1), [
              selectValue("PVTSSF_status", "Status", "opt_todo"),
              selectValue("PVTSSF_stage", "Stage", "opt_review"),
            ]),
          ],
          null,
        );
      });
      const board = yield* (yield* adapter).boards.read("/repo", {
        ...locator,
        statusFieldId: "PVTSSF_stage",
      });
      assert.deepStrictEqual(board.locator, {
        ...locator,
        projectNodeId: "PVT_board",
        statusFieldId: "PVTSSF_stage",
      });
      assert.deepStrictEqual(board.columns, [{ id: "opt_review", title: "Review" }]);
      assert.deepStrictEqual(board.items, [boardItem("PVTI_1", 1, "opt_review")]);
    }),
  );

  it.effect("refuses a Project without a single-select Status field", () =>
    Effect.gen(function* () {
      const { adapter } = harness((request) =>
        request.operationName === "OrganizationProject"
          ? project([{ __typename: "ProjectV2Field" }])
          : unexpected(request),
      );
      const failure = yield* (yield* adapter).boards.read("/repo", locator).pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        ["invalid", "Choose an existing GitHub Project with a single-select Status field."],
      );
    }),
  );

  it.effect("moves an item by sending the project, item, field and option ids", () =>
    Effect.gen(function* () {
      const { adapter, sent } = harness((request) =>
        request.operationName === "MoveProjectItem"
          ? data({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } })
          : unexpected(request),
      );
      yield* (yield* adapter).boards.move(
        "/repo",
        connected,
        boardItem("PVTI_1", 1, "opt_todo"),
        "opt_doing",
      );
      assert.deepStrictEqual(graphQlCalls(sent), [
        [
          "MoveProjectItem",
          {
            projectId: "PVT_board",
            itemId: "PVTI_1",
            fieldId: "PVTSSF_status",
            optionId: "opt_doing",
          },
        ],
      ]);
    }),
  );

  it.effect("refuses a move on a Project connected without its ids", () =>
    Effect.gen(function* () {
      const { adapter, sent } = harness(unexpected);
      const failure = yield* (yield* adapter).boards
        .move("/repo", locator, boardItem("PVTI_1", 1, "opt_todo"), "opt_doing")
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        ["invalid", "Reconnect this GitHub Project to select its Status field."],
      );
      assert.deepStrictEqual(sent, []);
    }),
  );

  it.effect("reads one item fresh by its node id", () =>
    Effect.gen(function* () {
      const { adapter, sent } = harness((request) =>
        request.operationName === "ProjectItem"
          ? data({
              node: {
                __typename: "ProjectV2Item",
                project: { id: "PVT_board" },
                ...projectItem("PVTI_1", issueContent(1), [
                  selectValue("PVTSSF_status", "Status", "opt_doing"),
                ]),
              },
            })
          : unexpected(request),
      );
      const item = yield* (yield* adapter).boards.readItem(
        "/repo",
        connected,
        boardItem("PVTI_1", 1, "opt_todo"),
      );
      assert.deepStrictEqual(item, boardItem("PVTI_1", 1, "opt_doing"));
      assert.deepStrictEqual(graphQlCalls(sent), [["ProjectItem", { itemId: "PVTI_1" }]]);
    }),
  );

  it.effect("fails a one-item read as not found when the item is deleted or not an issue", () =>
    Effect.gen(function* () {
      const answers = [
        json({
          data: { node: null },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["node"],
              message: "Could not resolve to a node with the global id of 'PVTI_1'",
            },
          ],
        }),
        data({
          node: {
            __typename: "ProjectV2Item",
            project: { id: "PVT_board" },
            ...projectItem("PVTI_1", { __typename: "DraftIssue" }, []),
          },
        }),
      ];
      for (const answer of answers) {
        const { adapter } = harness(() => answer);
        const failure = yield* (yield* adapter).boards
          .readItem("/repo", connected, boardItem("PVTI_1", 1, "opt_todo"))
          .pipe(Effect.flip);
        assert.strictEqual(failure.reason, "not-found");
      }
    }),
  );

  it.effect("routes an enterprise host's Projects calls to its own API", () =>
    Effect.gen(function* () {
      const { adapter, sent } = harness((request) => {
        if (request.url === "https://ghe.acme.test/api/v3/users/acme")
          return json({ type: "Organization" });
        if (request.url !== "https://ghe.acme.test/api/graphql") return unexpected(request);
        return data({
          organization: {
            projectsV2: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        });
      });
      const boards = yield* (yield* adapter).boards.list({
        cwd: "/repo",
        ref: { ...repository, host: "ghe.acme.test" },
      });
      assert.deepStrictEqual(boards, []);
      assert.deepStrictEqual(
        sent.map((entry) => `${entry.method} ${entry.url}`),
        ["GET https://ghe.acme.test/api/v3/users/acme", "POST https://ghe.acme.test/api/graphql"],
      );
    }),
  );

  it.effect("asks for the project scope when the token lacks it", () =>
    Effect.gen(function* () {
      const answers = [
        json({
          data: null,
          errors: [
            {
              type: "INSUFFICIENT_SCOPES",
              message:
                "Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes.",
            },
          ],
        }),
        json({ message: "Resource not accessible by integration" }, 403),
      ];
      for (const answer of answers) {
        const { adapter } = harness(() => answer);
        const failure = yield* (yield* adapter).boards.read("/repo", locator).pipe(Effect.flip);
        assert.deepStrictEqual(
          [failure.reason, failure.message],
          [
            "authentication",
            "GitHub Projects needs a token with the project scope. Run `gh auth refresh -s project`, or save a token with Project access in Settings, Source control.",
          ],
        );
      }
    }),
  );

  it.effect("fails a Project answer that does not match its document", () =>
    Effect.gen(function* () {
      const { adapter } = harness(() =>
        data({ organization: { projectV2: { id: "PVT_board", fields: { nodes: [] } } } }),
      );
      const failure = yield* (yield* adapter).boards.read("/repo", locator).pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        ["remote", "The repository host returned invalid issue data."],
      );
    }),
  );
});

describe("GitHubIssueHost issues", () => {
  const restIssue = (number: number) => ({
    number,
    title: `Issue ${number}`,
    state: "open",
    updated_at: "2026-10-01T00:00:00Z",
    html_url: `https://github.com/acme/web/issues/${number}`,
    labels: [{ name: "bug" }],
  });

  it.effect("lists issues without pull requests, with the next page as the cursor", () =>
    Effect.gen(function* () {
      const listed = [
        ...Array.from({ length: 99 }, (_, index) => restIssue(index + 1)),
        { ...restIssue(100), pull_request: { url: "https://api.github.com/x" } },
      ];
      const { adapter, sent } = harness((request) =>
        request.url === "https://api.github.com/repos/acme/web/issues?state=all&per_page=100&page=2"
          ? json(listed)
          : unexpected(request),
      );
      const result = yield* (yield* adapter).list(scope, "2");
      assert.strictEqual(result.issues.length, 99);
      assert.deepStrictEqual(result.issues[0], {
        ref: { ...repository, id: "1", number: 1, url: "https://github.com/acme/web/issues/1" },
        title: "Issue 1",
        state: "open",
        updatedAt: "2026-10-01T00:00:00Z",
        labels: ["bug"],
      });
      assert.notInclude(
        result.issues.map((issue) => issue.ref.number),
        100,
      );
      assert.strictEqual(result.nextCursor, "3");
      assert.strictEqual(sent.length, 1);
    }),
  );

  it.effect("reads an issue with every page of its comments", () =>
    Effect.gen(function* () {
      const comment = (id: number) => ({
        id,
        body: `Comment ${id}`,
        created_at: "2026-10-03T00:00:00Z",
        user: { login: "rob" },
      });
      const { adapter, sent } = harness((request) => {
        switch (request.url) {
          case "https://api.github.com/repos/acme/web/issues/7":
            return json({ ...restIssue(7), body: "Details", user: { login: "rob" } });
          case "https://api.github.com/repos/acme/web/issues/7/comments?per_page=100&page=1":
            return json(Array.from({ length: 100 }, (_, index) => comment(index + 1)));
          case "https://api.github.com/repos/acme/web/issues/7/comments?per_page=100&page=2":
            return json([comment(101)]);
          default:
            return unexpected(request);
        }
      });
      const detail = yield* (yield* adapter).get({
        ...scope,
        ref: { ...repository, id: "7", number: 7 },
      });
      assert.deepStrictEqual(
        [detail.title, detail.body, detail.author, detail.comments?.length],
        ["Issue 7", "Details", { name: "rob" }, 101],
      );
      assert.deepStrictEqual(detail.comments?.[100], {
        id: "101",
        body: "Comment 101",
        createdAt: "2026-10-03T00:00:00Z",
        author: { name: "rob" },
      });
      assert.strictEqual(sent.length, 3);
    }),
  );

  it.effect("fails a malformed issue list rather than listing nothing", () =>
    Effect.gen(function* () {
      for (const body of ["<html>", [{ ...restIssue(1), title: undefined }]]) {
        const { adapter } = harness(() => json(body));
        const failure = yield* (yield* adapter).list(scope).pipe(Effect.flip);
        assert.deepStrictEqual(
          [failure.reason, failure.message],
          ["remote", "The repository host returned invalid issue data."],
        );
      }
    }),
  );

  it.effect("maps GitHub's refusals to issue error reasons", () =>
    Effect.gen(function* () {
      const reasons = [];
      for (const status of [401, 404, 422, 502]) {
        const { adapter } = harness(() => json({ message: "Refused" }, status));
        reasons.push((yield* (yield* adapter).list(scope).pipe(Effect.flip)).reason);
      }
      assert.deepStrictEqual(reasons, ["authentication", "not-found", "invalid", "remote"]);
    }),
  );
});
