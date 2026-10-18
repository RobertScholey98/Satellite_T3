import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  SourceControlProviderKind,
  type IssueBoardItem,
  type IssueBoardLocator,
  type IssueRef,
} from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { CredentialScope } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureBoardsCli from "./AzureBoardsCli.ts";
import * as AzureBoardsIssueHost from "./AzureBoardsIssueHost.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeBatch = Schema.decodeUnknownSync(Schema.Struct({ ids: Schema.Array(Schema.Number) }));
const decodeQuery = Schema.decodeUnknownSync(Schema.Struct({ query: Schema.String }));

interface AzureRequest {
  readonly args: ReadonlyArray<string>;
  readonly command: string;
  readonly resource: string | undefined;
  readonly route: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly file: string | undefined;
  readonly body: unknown;
  readonly flag: (name: string) => string | undefined;
  readonly values: (name: string) => ReadonlyArray<string>;
}

const onDisk = <A>(
  use: (fs: FileSystem.FileSystem) => Effect.Effect<A, PlatformError.PlatformError>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* FileSystem.FileSystem);
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const ORGANIZATION_ARGS = [
  "--organization",
  "https://dev.azure.com/org",
  "--only-show-errors",
  "--output",
  "json",
];

/** An answer for an `az` that exits non-zero with this stderr. */
class AzureExit {
  readonly code: number;
  readonly stderr: string;
  constructor(code: number, stderr: string) {
    this.code = code;
    this.stderr = stderr;
  }
}

/** An `az` for the "org" organization that answers what `answer` returns and dies on anything else. */
const azureOn = (
  answer: (request: AzureRequest) => Effect.Effect<unknown, AzureDevOpsCli.AzureDevOpsCliError>,
) => {
  const requests: AzureRequest[] = [];
  const execute: AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"] = ({ args }) =>
    Effect.gen(function* () {
      const flag = (name: string) => {
        const index = args.indexOf(name);
        return index < 0 ? undefined : args[index + 1];
      };
      const values = (name: string) => {
        const index = args.indexOf(name);
        if (index < 0) return [];
        const end = args.findIndex((arg, at) => at > index && arg.startsWith("--"));
        return args.slice(index + 1, end < 0 ? undefined : end);
      };
      const pairs = (name: string) =>
        Object.fromEntries(values(name).map((pair) => pair.split("=") as [string, string]));
      if (args.slice(-5).join(" ") !== ORGANIZATION_ARGS.join(" "))
        return yield* Effect.die(`Unexpected trailing arguments ${args.join(" ")}`);
      const file = flag("--in-file");
      const request: AzureRequest = {
        args,
        command: args.slice(0, 3).join(" "),
        resource: flag("--resource"),
        route: pairs("--route-parameters"),
        query: pairs("--query-parameters"),
        file,
        body: file ? decodeJson(yield* onDisk((fs) => fs.readFileString(file))) : undefined,
        flag,
        values,
      };
      requests.push(request);
      const resolved = yield* answer(request);
      if (resolved === undefined)
        return yield* Effect.die(`Unexpected Azure request ${args.join(" ")}`);
      if (resolved instanceof AzureExit)
        return {
          exitCode: ChildProcessSpawner.ExitCode(resolved.code),
          stdout: "",
          stderr: resolved.stderr,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: typeof resolved === "string" ? resolved : JSON.stringify(resolved),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });
  // Work item updates run `az` through the host so a rejection keeps its stderr.
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
    execute({ cwd: input.cwd, args: input.args }).pipe(Effect.orDie);
  const layer = AzureBoardsCli.layer.pipe(
    Layer.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute })),
    Layer.provide(TestSourceControlHost.layer({ process: { run } })),
    Layer.provide(NodeServices.layer),
  );
  return { adapter: AzureBoardsIssueHost.make.pipe(Effect.provide(layer)), requests };
};
const azureAnswering = (answer: (request: AzureRequest) => unknown) =>
  azureOn((request) => Effect.sync(() => answer(request)));

const AZURE_DEVOPS = SourceControlProviderKind.make("azure-devops");
const repository = (name: string): IssueRef => ({
  hostKind: AZURE_DEVOPS,
  host: "dev.azure.com",
  repository: name,
  id: "0",
  number: 0,
  url: "https://dev.azure.com/org/Project",
});
const projectScope = { cwd: "/repo", ref: repository("org/Project") };
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
const workItem = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  rev: 3,
  fields: {
    "System.Title": `Issue ${id}`,
    "System.State": "New",
    "System.ChangedDate": "2026-10-01T00:00:00Z",
    "System.WorkItemType": "User Story",
    ...fields,
  },
});

describe("AzureBoardsIssueHost issues", () => {
  it.effect("lists every page of work items through WIQL and the batch resource", () =>
    Effect.gen(function* () {
      const issues = range(1, 150);
      const host = azureAnswering((request) => {
        if (request.resource === "wiql") {
          const after = Number(/\[System\.Id\] > (\d+)/.exec(decodeQuery(request.body).query)?.[1]);
          const ids = issues.filter((id) => id > after).slice(0, Number(request.query.$top));
          return { workItems: ids.map((id) => ({ id })) };
        }
        if (request.resource === "workItemsBatch")
          return { value: decodeBatch(request.body).ids.map((id) => workItem(id)) };
      });
      const adapter = yield* host.adapter;
      const first = yield* adapter.list(projectScope);
      const second = yield* adapter.list(projectScope, first.nextCursor ?? undefined);
      assert.strictEqual(first.nextCursor, "100");
      assert.strictEqual(second.nextCursor, null);
      assert.deepStrictEqual(
        [...first.issues, ...second.issues].map((issue) => issue.ref.number),
        issues,
      );
      assert.deepStrictEqual(first.issues[0], {
        ref: {
          hostKind: AZURE_DEVOPS,
          host: "dev.azure.com",
          repository: "org/Project",
          id: "1",
          number: 1,
          url: "https://dev.azure.com/org/Project/_workitems/edit/1",
        },
        title: "Issue 1",
        state: "New",
        updatedAt: "2026-10-01T00:00:00Z",
        labels: [],
      });
      assert.deepStrictEqual(
        host.requests
          .filter((request) => request.resource === "wiql")
          .map((request) => [request.flag("--api-version"), request.query, request.body]),
        [
          [
            "7.1",
            { $top: "100" },
            {
              query:
                "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Id] > 0 ORDER BY [System.Id] ASC",
            },
          ],
          [
            "7.1",
            { $top: "100" },
            {
              query:
                "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Id] > 100 ORDER BY [System.Id] ASC",
            },
          ],
        ],
      );
    }),
  );

  it.effect("fails on a malformed response rather than listing nothing", () =>
    Effect.gen(function* () {
      const adapter = yield* azureAnswering(() => "<html>").adapter;
      const failure = yield* adapter.list(projectScope).pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        ["remote", "The repository host returned invalid issue data."],
      );
    }),
  );

  it.effect("fails when a work item lacks a required field", () =>
    Effect.gen(function* () {
      const adapter = yield* azureAnswering((request) => {
        if (request.resource === "wiql") return { workItems: [{ id: 1 }] };
        if (request.resource === "workItemsBatch")
          return { value: [{ id: 1, rev: 1, fields: { "System.State": "New" } }] };
      }).adapter;
      const failure = yield* adapter.list(projectScope).pipe(Effect.flip);
      assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
    }),
  );

  it.effect("reads a work item with every comment page the continuation token leads to", () =>
    Effect.gen(function* () {
      const bodies = range(1, 150).map((n) => `Comment ${n}`);
      const host = azureAnswering((request) => {
        if (request.resource === "workItemsBatch")
          return { value: [workItem(7, { "System.Description": "Body" })] };
        if (request.resource === "comments") {
          const offset = Number(request.query.continuationToken ?? "0");
          const next = offset + Number(request.query.$top);
          return {
            comments: bodies.slice(offset, next).map((text, index) => ({
              id: offset + index,
              text,
              createdDate: "2026-10-01T00:00:00Z",
              createdBy: { displayName: "Rob" },
            })),
            continuation_token: next < bodies.length ? String(next) : null,
          };
        }
      });
      const adapter = yield* host.adapter;
      const detail = yield* adapter.get({
        ...projectScope,
        ref: { ...projectScope.ref, id: "7", number: 7 },
      });
      assert.strictEqual(detail.title, "Issue 7");
      assert.strictEqual(detail.body, "Body");
      assert.deepStrictEqual(
        detail.comments?.map((comment) => comment.body),
        bodies,
      );
      assert.deepStrictEqual(
        host.requests.map((request) => [
          request.resource,
          request.flag("--api-version"),
          request.route,
          request.query,
        ]),
        [
          ["workItemsBatch", "7.1", { project: "Project" }, {}],
          ["comments", "7.1-preview", { project: "Project", workItemId: "7" }, { $top: "100" }],
          [
            "comments",
            "7.1-preview",
            { project: "Project", workItemId: "7" },
            { $top: "100", continuationToken: "100" },
          ],
        ],
      );
    }),
  );

  it.effect("reports a deleted work item as not found", () =>
    Effect.gen(function* () {
      const adapter = yield* azureAnswering(() => ({ value: [null] })).adapter;
      const failure = yield* adapter
        .get({ ...projectScope, ref: { ...projectScope.ref, id: "7", number: 7 } })
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        ["not-found", "This work item no longer exists."],
      );
    }),
  );

  it.effect("maps CLI failures to issue failure reasons", () =>
    Effect.gen(function* () {
      const fields = {
        operation: "execute" as const,
        command: "az" as const,
        cwd: "/repo",
        argumentCount: 0,
        cause: new Error("az failed"),
      };
      const errors = [
        new AzureDevOpsCli.AzureDevOpsCliAuthenticationError(fields),
        new AzureDevOpsCli.AzureDevOpsCliUnavailableError(fields),
        new AzureDevOpsCli.AzureDevOpsCliRateLimitError(fields),
        new AzureDevOpsCli.AzureDevOpsPullRequestNotFoundError(fields),
        new AzureDevOpsCli.AzureDevOpsCommandFailedError(fields),
      ];
      const failures = yield* Effect.forEach(errors, (error) =>
        Effect.gen(function* () {
          const adapter = yield* azureOn(() => Effect.fail(error)).adapter;
          const failure = yield* adapter.list(projectScope).pipe(Effect.flip);
          return [failure.reason, failure.message];
        }),
      );
      assert.deepStrictEqual(failures, [
        [
          "authentication",
          "Azure DevOps is not signed in. Run `az login` and `az devops login` on the computer hosting this project.",
        ],
        [
          "unavailable",
          "Azure CLI (`az`) with the Azure DevOps extension is required but not available on PATH.",
        ],
        ["remote", "Azure DevOps CLI failed in execute: Azure DevOps API rate limit exceeded."],
        ["not-found", "Azure DevOps could not find this work item or board."],
        ["remote", "Azure DevOps CLI failed in execute: Azure DevOps CLI command failed."],
      ]);
    }),
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
const boardMetadata = (doneField: boolean) => ({
  id: "board",
  name: "Stories",
  fields: {
    columnField: { referenceName: "WEF_TEAM_Kanban.Column" },
    ...(doneField ? { doneField: { referenceName: "WEF_TEAM_Kanban.Column.Done" } } : {}),
  },
  columns: [
    { id: "ready", name: "Selected", stateMappings: { "User Story": "New", Bug: "New" } },
    { id: "doing", name: "Building", stateMappings: { "User Story": "Active", Bug: "Active" } },
  ],
});
const teamAreas = {
  field: { referenceName: "System.AreaPath" },
  values: [
    { value: "Project\\Team", includeChildren: true },
    { value: "Project\\Ops's", includeChildren: false },
  ],
};
/** A team board holding the given work items in its "Selected" column. */
const boardHost = (options: {
  readonly ids: ReadonlyArray<number>;
  readonly team?: unknown;
  readonly doneField?: boolean;
  readonly update?: unknown;
}) => {
  const present = new Set(options.ids);
  return azureAnswering((request) => {
    if (request.command === "boards work-item update") return options.update ?? workItem(42);
    if (request.resource === "boards") return boardMetadata(options.doneField ?? true);
    if (request.resource === "teamfieldvalues") return options.team ?? teamAreas;
    if (request.resource === "wiql") return { workItems: options.ids.map((id) => ({ id })) };
    if (request.resource === "workItemsBatch")
      return {
        value: decodeBatch(request.body).ids.map((id) =>
          present.has(id) ? workItem(id, { "WEF_TEAM_Kanban.Column": "Selected" }) : null,
        ),
      };
  });
};
const boardItem = (id: number): IssueBoardItem => ({
  issue: {
    ref: {
      hostKind: AZURE_DEVOPS,
      host: "dev.azure.com",
      repository: "org/Project",
      id: String(id),
      number: id,
      url: `https://dev.azure.com/org/Project/_workitems/edit/${id}`,
    },
    title: `Issue ${id}`,
    state: "New",
    updatedAt: "2026-10-01T00:00:00Z",
    labels: [],
  },
  itemId: String(id),
  columnId: "ready",
  version: "3",
});

describe("AzureBoardsIssueHost boards", () => {
  it.effect("reads the team's areas and mapped types, then the items in batches of 200", () =>
    Effect.gen(function* () {
      const host = boardHost({ ids: range(1, 250) });
      const board = yield* (yield* host.adapter).boards.read("/repo", locator);
      assert.strictEqual(board.title, "Stories");
      assert.deepStrictEqual(board.columns, [
        { id: "ready", title: "Selected" },
        { id: "doing", title: "Building" },
      ]);
      assert.strictEqual(board.items.length, 250);
      assert.deepStrictEqual(board.items[249], boardItem(250));
      assert.deepStrictEqual(
        host.requests.map((request) => [request.resource, request.flag("--http-method")]),
        [
          ["boards", "GET"],
          ["teamfieldvalues", "GET"],
          ["wiql", "POST"],
          ["workItemsBatch", "POST"],
          ["workItemsBatch", "POST"],
        ],
      );
      const [, , wiql, firstBatch, secondBatch] = host.requests;
      assert.deepStrictEqual(wiql?.body, {
        query:
          "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story','Bug') AND ([System.AreaPath] UNDER 'Project\\Team' OR [System.AreaPath] = 'Project\\Ops''s') ORDER BY [System.Id] ASC",
      });
      assert.deepStrictEqual(firstBatch?.body, { ids: range(1, 200), errorPolicy: "omit" });
      assert.deepStrictEqual(secondBatch?.body, { ids: range(201, 50), errorPolicy: "omit" });
      assert.deepStrictEqual(host.requests[0]?.args, [
        "devops",
        "invoke",
        "--area",
        "work",
        "--resource",
        "boards",
        "--api-version",
        "7.1",
        "--http-method",
        "GET",
        "--route-parameters",
        "project=Project",
        "team=Team",
        "id=board",
        ...ORGANIZATION_ARGS,
      ]);
      assert.deepStrictEqual(secondBatch?.args, [
        "devops",
        "invoke",
        "--area",
        "wit",
        "--resource",
        "workItemsBatch",
        "--api-version",
        "7.1",
        "--http-method",
        "POST",
        "--route-parameters",
        "project=Project",
        "--in-file",
        String(secondBatch?.file),
        ...ORGANIZATION_ARGS,
      ]);
      const leftOnDisk = yield* Effect.forEach(
        host.requests.flatMap((request) => (request.file ? [request.file] : [])),
        (file) => onDisk((fs) => fs.exists(file)),
      );
      assert.deepStrictEqual(leftOnDisk, [false, false, false]);
    }),
  );

  it.effect("fails a board whose team has no area field instead of showing it empty", () =>
    Effect.gen(function* () {
      const adapter = yield* boardHost({ ids: [42], team: {} }).adapter;
      const failure = yield* adapter.boards.read("/repo", locator).pipe(Effect.flip);
      assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
    }),
  );

  it.effect("moves a work item to the column's state for its type and clears the done field", () =>
    Effect.gen(function* () {
      const host = boardHost({ ids: [42] });
      yield* (yield* host.adapter).boards.move("/repo", locator, boardItem(42), "doing");
      assert.deepStrictEqual(host.requests.at(-1)?.args, [
        "boards",
        "work-item",
        "update",
        "--id",
        "42",
        "--state",
        "Active",
        "--fields",
        "WEF_TEAM_Kanban.Column=Building",
        "WEF_TEAM_Kanban.Column.Done=false",
        ...ORGANIZATION_ARGS,
      ]);
    }),
  );

  it.effect("moves without a done field when the board has none", () =>
    Effect.gen(function* () {
      const host = boardHost({ ids: [42], doneField: false });
      yield* (yield* host.adapter).boards.move("/repo", locator, boardItem(42), "doing");
      assert.deepStrictEqual(host.requests.at(-1)?.values("--fields"), [
        "WEF_TEAM_Kanban.Column=Building",
      ]);
    }),
  );

  it.effect("fails a move Azure DevOps refuses as lasting, naming the rule", () =>
    Effect.gen(function* () {
      const host = boardHost({
        ids: [42],
        update: new AzureExit(
          1,
          "ERROR: TF401320: Rule Error for field State. Error code: Required, InvalidEmpty.\n",
        ),
      });
      const failure = yield* (yield* host.adapter).boards
        .move("/repo", locator, boardItem(42), "doing")
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        [
          "invalid",
          "Azure DevOps refused the change: ERROR: TF401320: Rule Error for field State. Error code: Required, InvalidEmpty.",
        ],
      );
    }),
  );

  it.effect("keeps a move failure without a rule code retryable", () =>
    Effect.gen(function* () {
      for (const stderr of [
        "ERROR: Max retries exceeded with url: /_apis/wit\n",
        "ERROR: TF400898: An Internal Error Occurred. Activity Id: 1f6a.\n",
      ]) {
        const host = boardHost({ ids: [42], update: new AzureExit(1, stderr) });
        const failure = yield* (yield* host.adapter).boards
          .move("/repo", locator, boardItem(42), "doing")
          .pipe(Effect.flip);
        assert.strictEqual(failure.reason, "remote");
      }
    }),
  );

  it.effect("refuses a move to a column the board no longer has", () =>
    Effect.gen(function* () {
      const host = boardHost({ ids: [42] });
      const failure = yield* (yield* host.adapter).boards
        .move("/repo", locator, boardItem(42), "removed")
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        ["invalid", "The selected Azure board column no longer exists."],
      );
      assert.isFalse(
        host.requests.some((request) => request.command === "boards work-item update"),
      );
    }),
  );

  it.effect("reads one item fresh with its column and revision", () =>
    Effect.gen(function* () {
      const host = boardHost({ ids: [42] });
      const stale = { ...boardItem(42), columnId: "doing", version: "1" };
      const fresh = yield* (yield* host.adapter).boards.readItem("/repo", locator, stale);
      assert.deepStrictEqual(fresh, boardItem(42));
      assert.deepStrictEqual(
        host.requests.find((request) => request.resource === "workItemsBatch")?.body,
        { ids: [42], errorPolicy: "omit" },
      );
    }),
  );

  it.effect("reports an item that is gone as not found", () =>
    Effect.gen(function* () {
      const adapter = yield* boardHost({ ids: [] }).adapter;
      const failure = yield* adapter.boards
        .readItem("/repo", locator, boardItem(42))
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        ["not-found", "This work item no longer exists."],
      );
    }),
  );
});

const named = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, name: `${prefix} ${i}` }));
const discovery = (options: {
  readonly projects: ReadonlyArray<{ id: string; name: string }>;
  readonly teams: (project: string) => ReadonlyArray<{ id: string; name: string }>;
  readonly boards: (project: string, team: string) => ReadonlyArray<{ id: string; name: string }>;
}) => {
  const page = <A>(items: ReadonlyArray<A>, request: AzureRequest) =>
    items.slice(
      Number(request.flag("--skip")),
      Number(request.flag("--skip")) + Number(request.flag("--top")),
    );
  return (request: AzureRequest) => {
    if (request.command === "devops project list")
      return { value: page(options.projects, request) };
    if (request.command === "devops team list")
      return page(options.teams(request.flag("--project")!), request);
    if (request.resource === "boards")
      return { value: options.boards(request.route.project!, request.route.team!) };
  };
};

describe("AzureBoardsIssueHost discovery", () => {
  it.effect("lists boards that sit on later pages of projects and teams", () =>
    Effect.gen(function* () {
      const host = azureAnswering(
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
      const boards = yield* (yield* host.adapter).boards.list(projectScope);
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
      assert.deepStrictEqual(
        host.requests
          .filter(
            (request) =>
              request.command === "devops project list" ||
              request.flag("--project") === "last-project",
          )
          .map((request) => request.args.slice(0, -5)),
        [
          ["devops", "project", "list", "--top", "100", "--skip", "0"],
          ["devops", "project", "list", "--top", "100", "--skip", "100"],
          ["devops", "team", "list", "--project", "last-project", "--top", "100", "--skip", "0"],
          ["devops", "team", "list", "--project", "last-project", "--top", "100", "--skip", "100"],
        ],
      );
    }),
  );

  it.effect("reads team boards across projects at most three at a time", () =>
    Effect.gen(function* () {
      let active = 0;
      let peak = 0;
      const answer = discovery({
        projects: named("project", 3),
        teams: () => named("team", 4),
        boards: () => [{ id: "board", name: "Board" }],
      });
      const host = azureOn((request) =>
        request.resource === "boards"
          ? Effect.gen(function* () {
              active++;
              peak = Math.max(peak, active);
              yield* Effect.yieldNow;
              active--;
              return answer(request);
            })
          : Effect.sync(() => answer(request)),
      );
      const boards = yield* (yield* host.adapter).boards.list(projectScope);
      assert.strictEqual(boards.length, 12);
      assert.strictEqual(boards[0]?.title, "project 0 / team 0 / Board");
      assert.strictEqual(peak, 3);
    }),
  );

  it.effect("reuses discovery for a minute per checkout and credential scope", () =>
    Effect.gen(function* () {
      const host = azureAnswering(
        discovery({
          projects: [{ id: "project", name: "Project" }],
          teams: () => [{ id: "team", name: "Team" }],
          boards: () => [{ id: "board", name: "Board" }],
        }),
      );
      const adapter = yield* host.adapter;
      const first = yield* adapter.boards.list(projectScope);
      assert.deepStrictEqual(yield* adapter.boards.list(projectScope), first);
      assert.strictEqual(host.requests.length, 3);
      yield* adapter.boards
        .list(projectScope)
        .pipe(Effect.provideService(CredentialScope, "other-account"));
      assert.strictEqual(host.requests.length, 6);
      yield* adapter.boards.list({ ...projectScope, cwd: "/other-checkout" });
      assert.strictEqual(host.requests.length, 9);
      yield* TestClock.adjust("59 seconds");
      yield* adapter.boards.list(projectScope);
      assert.strictEqual(host.requests.length, 9);
      yield* TestClock.adjust("2 seconds");
      yield* Effect.all([adapter.boards.list(projectScope), adapter.boards.list(projectScope)], {
        concurrency: "unbounded",
      });
      assert.strictEqual(host.requests.length, 12);
    }),
  );

  it.effect("retries failed discovery instead of caching the failure", () =>
    Effect.gen(function* () {
      let calls = 0;
      const adapter = yield* azureAnswering(() => {
        calls++;
        return calls === 1 ? {} : { value: [] };
      }).adapter;
      const failure = yield* adapter.boards.list(projectScope).pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        ["remote", "The repository host returned invalid issue data."],
      );
      assert.deepStrictEqual(yield* adapter.boards.list(projectScope), []);
    }),
  );

  it.effect("fails a project listing with a malformed entry", () =>
    Effect.gen(function* () {
      const adapter = yield* azureAnswering(() => ({ value: [{ name: "Missing ID" }] })).adapter;
      const failure = yield* adapter.boards.list(projectScope).pipe(Effect.flip);
      assert.strictEqual(failure.message, "The repository host returned invalid issue data.");
    }),
  );
});
