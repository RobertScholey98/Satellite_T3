import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { IssueBoardLocator, IssueRef } from "@t3tools/contracts";
import { CredentialScope } from "../sourceControl/SourceControlRateLimit.ts";
import * as AzureBoardsIssueHost from "./AzureBoardsIssueHost.ts";
import { azureCli, type AzureRequest } from "./IssueHost.testFixtures.ts";

const decodeQuery = Schema.decodeUnknownSync(Schema.Struct({ query: Schema.String }));
const adapterOn = (organization: string, answer: (request: AzureRequest) => unknown) =>
  adapterOnEffect(organization, (request) => Effect.sync(() => answer(request)));
const adapterOnEffect = (organization: string, answer: Parameters<typeof azureCli>[1]) =>
  Effect.gen(function* () {
    const cli = yield* azureCli(organization, answer);
    return yield* AzureBoardsIssueHost.make.pipe(Effect.provide(cli));
  });
const withNode = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

const repository = (name: string): IssueRef => ({
  hostKind: "azure-devops",
  host: "dev.azure.com",
  repository: name,
  id: "0",
  number: 0,
  url: "",
});
const discovery = (options: {
  readonly projects: ReadonlyArray<{ id: string; name: string }>;
  readonly teams: (project: string) => ReadonlyArray<{ id: string; name: string }>;
  readonly boards: (project: string, team: string) => ReadonlyArray<{ id: string; name: string }>;
}) => {
  const page = <A>(items: ReadonlyArray<A>, request: AzureRequest) =>
    items.slice(Number(request.flag("--skip")), Number(request.flag("--skip")) + 100);
  return (request: AzureRequest) => {
    if (request.command === "devops project list")
      return { value: page(options.projects, request) };
    if (request.command === "devops team list")
      return page(options.teams(request.flag("--project")!), request);
    if (request.resource === "boards")
      return { value: options.boards(request.route.project!, request.route.team!) };
  };
};
const named = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, name: `${prefix} ${i}` }));

describe("AzureBoardsIssueHost discovery", () => {
  it.effect("lists boards that sit on later pages of projects and teams", () =>
    withNode(
      Effect.gen(function* () {
        const adapter = yield* adapterOn(
          "org",
          discovery({
            projects: [...named("project", 100), { id: "last-project", name: "Last project" }],
            teams: (project) =>
              project === "last-project"
                ? [...named("team", 100), { id: "last-team", name: "Last team" }]
                : [],
            boards: (_project, team) =>
              team === "last-team" ? [{ id: "stories", name: "Stories" }] : [],
          }),
        );
        const boards = yield* adapter.boards.list({ cwd: "/repo", ref: repository("org/repo") });
        assert.deepStrictEqual(boards, [
          {
            title: "Last project / Last team / Stories",
            locator: {
              kind: "azure-board",
              host: "dev.azure.com",
              organization: "org",
              project: "Last project",
              team: "last-team",
              boardId: "stories",
            },
          },
        ]);
      }),
    ),
  );

  it.effect("discovers boards in every project of the repository's organization", () =>
    withNode(
      Effect.gen(function* () {
        const adapter = yield* adapterOn(
          "org",
          discovery({
            projects: [
              { id: "project-one", name: "First project" },
              { id: "project-two", name: "Other project" },
            ],
            teams: () => [{ id: "team-one", name: "Team" }],
            boards: () => [{ id: "stories", name: "Stories" }],
          }),
        );
        const boards = yield* adapter.boards.list({
          cwd: "/repo",
          ref: repository("org/First project"),
        });
        assert.deepStrictEqual(
          boards.map((board) => board.title),
          ["First project / Team / Stories", "Other project / Team / Stories"],
        );
      }),
    ),
  );

  it.effect("reads team boards concurrently, at most three at a time", () =>
    withNode(
      Effect.gen(function* () {
        let active = 0;
        let peak = 0;
        const boards = discovery({
          projects: [{ id: "project", name: "Project" }],
          teams: () => named("Team", 8),
          boards: () => [{ id: "board", name: "Board" }],
        });
        const adapter = yield* adapterOnEffect("org", (request) =>
          request.resource === "boards"
            ? Effect.gen(function* () {
                active++;
                peak = Math.max(peak, active);
                yield* Effect.yieldNow;
                active--;
                return boards(request);
              })
            : Effect.sync(() => boards(request)),
        );
        const results = yield* adapter.boards.list({ cwd: "/repo", ref: repository("org/repo") });
        assert.strictEqual(results.length, 8);
        assert.isAbove(peak, 1);
        assert.isAtMost(peak, 3);
      }),
    ),
  );

  it.effect("reuses discovery for a minute per credential scope", () =>
    withNode(
      Effect.gen(function* () {
        let requests = 0;
        const answer = discovery({
          projects: [{ id: "project", name: "Project" }],
          teams: () => [{ id: "team", name: "Team" }],
          boards: () => [{ id: "board", name: "Board" }],
        });
        const adapter = yield* adapterOn("org", (request) => {
          requests++;
          return answer(request);
        });
        const scope = { cwd: "/repo", ref: repository("org/repo") };
        const first = yield* adapter.boards.list(scope);
        assert.deepStrictEqual(yield* adapter.boards.list(scope), first);
        assert.strictEqual(requests, 3);
        yield* adapter.boards
          .list(scope)
          .pipe(Effect.provideService(CredentialScope, "other-account"));
        assert.strictEqual(requests, 6);
        yield* TestClock.adjust("61 seconds");
        yield* Effect.all([adapter.boards.list(scope), adapter.boards.list(scope)], {
          concurrency: "unbounded",
        });
        assert.strictEqual(requests, 9);
      }),
    ),
  );

  it.effect("retries failed discovery instead of caching the failure", () =>
    withNode(
      Effect.gen(function* () {
        let calls = 0;
        const adapter = yield* adapterOn("org", () => {
          calls++;
          return calls === 1 ? {} : { value: [] };
        });
        const scope = { cwd: "/repo", ref: repository("org/repo") };
        const failure = yield* adapter.boards.list(scope).pipe(Effect.flip);
        assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
        assert.deepStrictEqual(yield* adapter.boards.list(scope), []);
      }),
    ),
  );

  it.effect("fails a project listing with a malformed entry", () =>
    withNode(
      Effect.gen(function* () {
        const adapter = yield* adapterOn("org", () => ({ value: [{ name: "Missing ID" }] }));
        const failure = yield* adapter.boards
          .list({ cwd: "/repo", ref: repository("org/repo") })
          .pipe(Effect.flip);
        assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
      }),
    ),
  );
});

const locator: Extract<IssueBoardLocator, { kind: "azure-board" }> = {
  kind: "azure-board",
  host: "dev.azure.com",
  organization: "org",
  project: "Project",
  team: "Team",
  boardId: "board",
};
const metadata = {
  id: "board",
  name: "Stories",
  fields: {
    columnField: { referenceName: "WEF_TEAM_Kanban.Column" },
    doneField: { referenceName: "WEF_TEAM_Kanban.Column.Done" },
  },
  columns: [
    { id: "ready", name: "Selected", stateMappings: { "User Story": "New" } },
    { id: "doing", name: "Building", stateMappings: { "User Story": "Active" } },
  ],
};
/** A team board holding work item 42, with the CLI's work-item update applied to it. */
const boardHost = (
  team: unknown = {
    field: { referenceName: "System.AreaPath" },
    values: [{ value: "Project\\Team", includeChildren: true }],
  },
) => {
  const queries: string[] = [];
  const fields: Record<string, string> = {
    "System.Title": "Task",
    "System.State": "New",
    "System.ChangedDate": "now",
    "System.WorkItemType": "User Story",
    "WEF_TEAM_Kanban.Column": "Selected",
  };
  const workItem = () => ({ id: 42, rev: 9, fields: { ...fields } });
  const adapter = adapterOn("org", (request) => {
    if (request.command === "boards work-item update" && request.flag("--id") === "42") {
      fields["System.State"] = request.flag("--state")!;
      for (const pair of request.values("--fields")) {
        const [name, value] = pair.split("=");
        fields[name!] = value!;
      }
      return workItem();
    }
    if (request.resource === "boards") return metadata;
    if (request.resource === "teamfieldvalues") return team;
    if (request.resource === "wiql") {
      queries.push(decodeQuery(request.body).query);
      return { workItems: [{ id: 42 }] };
    }
    if (request.resource === "workItemsBatch") return { value: [workItem()] };
    if (request.resource === "comments") return { comments: [], continuation_token: null };
  });
  return { adapter, queries };
};

describe("AzureBoardsIssueHost boards", () => {
  it.effect("reads the team's areas and mapped work item types into the board", () =>
    withNode(
      Effect.gen(function* () {
        const host = boardHost();
        const adapter = yield* host.adapter;
        const board = yield* adapter.boards.read("/repo", locator);
        assert.deepStrictEqual(board.columns, [
          { id: "ready", title: "Selected" },
          { id: "doing", title: "Building" },
        ]);
        assert.deepStrictEqual(
          board.items.map((item) => [item.itemId, item.columnId, item.version, item.issue.title]),
          [["42", "ready", "9", "Task"]],
        );
        assert.deepStrictEqual(host.queries, [
          "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story') AND ([System.AreaPath] UNDER 'Project\\Team') ORDER BY [System.Id] ASC",
        ]);
      }),
    ),
  );

  it.effect("moves a work item to the column's state for its type and clears the done field", () =>
    withNode(
      Effect.gen(function* () {
        const adapter = yield* boardHost().adapter;
        const board = yield* adapter.boards.read("/repo", locator);
        yield* adapter.boards.move("/repo", locator, board.items[0]!, "doing");
        const moved = yield* adapter.boards.read("/repo", locator);
        assert.strictEqual(moved.items[0]?.columnId, "doing");
        const detail = yield* adapter.get({
          cwd: "/repo",
          ref: { ...repository("org/Project"), id: "42", number: 42 },
        });
        assert.strictEqual(detail.state, "Active");
        assert.strictEqual(detail.hostFields?.["WEF_TEAM_Kanban.Column.Done"], "false");
      }),
    ),
  );

  it.effect("refuses a move to a column the board no longer has", () =>
    withNode(
      Effect.gen(function* () {
        const adapter = yield* boardHost().adapter;
        const board = yield* adapter.boards.read("/repo", locator);
        const failure = yield* adapter.boards
          .move("/repo", locator, board.items[0]!, "removed")
          .pipe(Effect.flip);
        assert.strictEqual(failure.message, "The selected Azure board column no longer exists.");
      }),
    ),
  );

  it.effect("fails a board whose team has no area field instead of showing it empty", () =>
    withNode(
      Effect.gen(function* () {
        const adapter = yield* boardHost({}).adapter;
        const failure = yield* adapter.boards.read("/repo", locator).pipe(Effect.flip);
        assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
      }),
    ),
  );
});
