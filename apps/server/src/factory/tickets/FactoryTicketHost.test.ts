import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  type IssueBoardLocator,
  type IssueBoardSummary,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as FactoryTicketHost from "./FactoryTicketHost.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

/** One request as the fake GitHub saw it. GraphQL requests carry their operation and variables. */
interface GitHubSent {
  readonly method: string;
  readonly url: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** One `az` invocation, with the file it was handed read back while it still exists. */
interface AzureSent {
  readonly args: ReadonlyArray<string>;
  readonly command: string;
  readonly resource: string | undefined;
  readonly body: unknown;
  readonly description: string | undefined;
  readonly flag: (name: string) => string | undefined;
}

const json = (body: unknown, status = 200) =>
  new Response(encodeJson(body), { status, headers: { "content-type": "application/json" } });

const MARKER = "satellite-factory-draft:7d0f0a4e-2f53-4c39-9a68-0c0b8f2f6d11";
const ISSUE_URL = "https://github.com/acme/web/issues/12";

const identity: RepositoryIdentity = {
  canonicalKey: "github.com/acme/web",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/web.git",
  },
  provider: "github",
  displayName: "acme/web",
  owner: "acme",
  name: "web",
};

const gitHubLocator: IssueBoardLocator = {
  kind: "github-project",
  host: "github.com",
  owner: "acme",
  ownerKind: "organization",
  projectNumber: 3,
  projectNodeId: "PVT_board",
  statusFieldId: "PVTSSF_status",
};
const azureLocator: IssueBoardLocator = {
  kind: "azure-board",
  host: "dev.azure.com",
  organization: "org",
  project: "Project",
  team: "Team",
  boardId: "board",
};
const board = (locator: IssueBoardLocator, ready: string): IssueBoardSummary => ({
  id: "board-1",
  projectId: ProjectId.make("project-1"),
  title: "Roadmap",
  locator,
  mapping: {
    ready: [ready, "later"],
    inProgress: "doing",
    inPullRequest: "review",
    completed: "done",
    moveOnMerge: true,
  },
});
const input = (locator: IssueBoardLocator, ready: string) => ({
  projectId: ProjectId.make("project-1"),
  cwd: "/repo",
  board: board(locator, ready),
  marker: MARKER,
  title: "Retry flaky checkpoint capture",
  body: "Checkpoints fail on <large> repos.\nCapture them in batches.",
});

/**
 * The ticket host over upstream's real GitHub REST transport and request policy, a fake GitHub
 * answering every HTTP request with `respond`, and an `az` that answers with `azure`.
 */
const harness = (options: {
  readonly github?: (sent: GitHubSent) => Response;
  readonly azure?: (sent: AzureSent) => unknown;
}) => {
  const gitHubSent: Array<GitHubSent> = [];
  const azureSent: Array<AzureSent> = [];
  const gitHub = Layer.mergeAll(
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
        Effect.suspend(() => {
          const body =
            request.body._tag === "Uint8Array"
              ? decodeRecord(decodeJson(new TextDecoder().decode(request.body.body)))
              : {};
          const sent = { method: request.method, url: request.url, body };
          gitHubSent.push(sent);
          return options.github
            ? Effect.succeed(HttpClientResponse.fromWeb(request, options.github(sent)))
            : Effect.die(`Unexpected GitHub request ${request.url}`);
        }),
      ),
    ),
    GitHubQuota.layer,
    SourceControlRateLimit.layer,
  );

  const execute: AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"] = ({ args }) =>
    Effect.gen(function* () {
      const flag = (name: string) => {
        const index = args.indexOf(name);
        return index < 0 ? undefined : args[index + 1];
      };
      const fs = yield* FileSystem.FileSystem;
      const file = flag("--in-file");
      const description = flag("--description");
      const sent: AzureSent = {
        args,
        command: args.slice(0, 3).join(" "),
        resource: flag("--resource"),
        body: file ? decodeJson(yield* fs.readFileString(file)) : undefined,
        description: description?.startsWith("@")
          ? yield* fs.readFileString(description.slice(1))
          : undefined,
        flag,
      };
      azureSent.push(sent);
      const answer = options.azure?.(sent);
      if (answer === undefined) return yield* Effect.die(`Unexpected az ${args.join(" ")}`);
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: encodeJson(answer),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
  // Work item updates run `az` through the host so a rejection keeps its stderr.
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (request) =>
    execute({ cwd: request.cwd, args: request.args }).pipe(Effect.orDie);

  const layer = FactoryTicketHost.layer.pipe(
    Layer.provide(GitHubRest.layer.pipe(Layer.provideMerge(gitHub))),
    Layer.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute })),
    Layer.provide(TestSourceControlHost.layer({ process: { run } })),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(identity),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return {
    host: Effect.service(FactoryTicketHost.FactoryTicketHost).pipe(Effect.provide(layer)),
    gitHubSent,
    azureSent,
  };
};

/** A fake GitHub holding `existing` issues for the marker search, answering the rest. */
const gitHubAnswering =
  (
    existing: ReadonlyArray<unknown>,
    move: () => Response = () =>
      json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item" } } } }),
  ) =>
  (sent: GitHubSent): Response => {
    switch (sent.body.operationName) {
      case "FactoryTicketSearch":
        return json({ data: { search: { nodes: existing } } });
      case "FactoryTicketAddToProject":
        return json({ data: { addProjectV2ItemById: { item: { id: "PVTI_item" } } } });
      case "MoveProjectItem":
        return move();
    }
    if (sent.method === "POST" && sent.url === "https://api.github.com/repos/acme/web/issues")
      return json({ node_id: "I_new", number: 12, html_url: ISSUE_URL }, 201);
    return json({ message: "Not Found" }, 404);
  };

describe("FactoryTicketHost on GitHub", () => {
  it.effect("files the issue with its marker, adds it to the Project and moves it to Ready", () =>
    Effect.gen(function* () {
      const { host, gitHubSent } = harness({ github: gitHubAnswering([]) });
      const ref = yield* (yield* host).create(input(gitHubLocator, "opt_ready"));

      assert.deepStrictEqual(ref, {
        hostKind: "github",
        host: "github.com",
        repository: "acme/web",
        id: "12",
        number: 12,
        url: ISSUE_URL,
      });
      assert.deepStrictEqual(
        gitHubSent.map((sent) => [sent.method, sent.url, sent.body.operationName]),
        [
          ["POST", "https://api.github.com/graphql", "FactoryTicketSearch"],
          ["POST", "https://api.github.com/repos/acme/web/issues", undefined],
          ["POST", "https://api.github.com/graphql", "FactoryTicketAddToProject"],
          ["POST", "https://api.github.com/graphql", "MoveProjectItem"],
        ],
      );
      const [search, created, added, moved] = gitHubSent;
      assert.deepStrictEqual(search?.body.variables, {
        query: `repo:acme/web "${MARKER}" in:body`,
      });
      assert.deepStrictEqual(created?.body, {
        title: "Retry flaky checkpoint capture",
        body: `Checkpoints fail on <large> repos.\nCapture them in batches.\n\n<!-- ${MARKER} -->`,
      });
      assert.deepStrictEqual(added?.body.variables, { projectId: "PVT_board", contentId: "I_new" });
      assert.deepStrictEqual(moved?.body.variables, {
        projectId: "PVT_board",
        itemId: "PVTI_item",
        fieldId: "PVTSSF_status",
        optionId: "opt_ready",
      });
    }),
  );

  it.effect("reuses the issue that already carries the marker and only places it", () =>
    Effect.gen(function* () {
      const { host, gitHubSent } = harness({
        github: gitHubAnswering([
          { __typename: "PullRequest" },
          {
            __typename: "Issue",
            id: "I_other",
            number: 9,
            url: "https://github.com/acme/web/issues/9",
            body: "Mentions satellite-factory-draft in passing.",
          },
          {
            __typename: "Issue",
            id: "I_filed",
            number: 11,
            url: "https://github.com/acme/web/issues/11",
            body: `Earlier attempt.\n\n<!-- ${MARKER} -->`,
          },
        ]),
      });
      const ref = yield* (yield* host).create(input(gitHubLocator, "opt_ready"));

      assert.strictEqual(ref.url, "https://github.com/acme/web/issues/11");
      assert.strictEqual(ref.number, 11);
      assert.deepStrictEqual(
        gitHubSent.map((sent) => sent.body.operationName),
        ["FactoryTicketSearch", "FactoryTicketAddToProject", "MoveProjectItem"],
      );
      assert.deepStrictEqual(gitHubSent[1]?.body.variables, {
        projectId: "PVT_board",
        contentId: "I_filed",
      });
    }),
  );

  it.effect("names the filed issue when it cannot be placed on the board", () =>
    Effect.gen(function* () {
      const { host } = harness({
        github: gitHubAnswering([], () =>
          json({ data: null, errors: [{ message: "The option does not exist." }] }),
        ),
      });
      const failure = yield* (yield* host)
        .create(input(gitHubLocator, "opt_gone"))
        .pipe(Effect.flip);

      assert.strictEqual(failure.reason, "unavailable");
      assert.include(failure.message, ISSUE_URL);
      assert.include(failure.message, "The option does not exist.");
    }),
  );

  it.effect("refuses a Project connected without its ids before filing anything", () =>
    Effect.gen(function* () {
      const { host, gitHubSent } = harness({ github: gitHubAnswering([]) });
      const failure = yield* (yield* host)
        .create(
          input(
            {
              kind: "github-project",
              host: "github.com",
              owner: "acme",
              ownerKind: "user",
              projectNumber: 3,
            },
            "opt_ready",
          ),
        )
        .pipe(Effect.flip);

      assert.strictEqual(failure.reason, "invalid");
      assert.deepStrictEqual(gitHubSent, []);
    }),
  );
});

const azureBoardMetadata = {
  id: "board",
  name: "Stories",
  fields: {
    columnField: { referenceName: "WEF_TEAM_Kanban.Column" },
    doneField: { referenceName: "WEF_TEAM_Kanban.Column.Done" },
  },
  columns: [
    { id: "ready", name: "Selected", stateMappings: { Bug: "New", "User Story": "New" } },
    { id: "doing", name: "Building", stateMappings: { Bug: "Active", "User Story": "Active" } },
  ],
};
const azureWorkItem = (id: number) => ({
  id,
  rev: 1,
  fields: {
    "System.Title": "Retry flaky checkpoint capture",
    "System.State": "New",
    "System.ChangedDate": "2026-10-01T00:00:00Z",
    "System.WorkItemType": "User Story",
  },
});

describe("FactoryTicketHost on Azure Boards", () => {
  it.effect("files a work item under the team's area and moves it to the Ready column", () =>
    Effect.gen(function* () {
      const { host, azureSent } = harness({
        azure: (sent) => {
          if (sent.command === "boards work-item create") return { id: 42, rev: 1 };
          if (sent.command === "boards work-item update") return azureWorkItem(42);
          if (sent.resource === "wiql") return { workItems: [] };
          if (sent.resource === "boards") return azureBoardMetadata;
          if (sent.resource === "teamfieldvalues")
            return {
              field: { referenceName: "System.AreaPath" },
              defaultValue: "Project\\Team",
              values: [{ value: "Project\\Team", includeChildren: true }],
            };
          if (sent.resource === "workItemsBatch") return { value: [azureWorkItem(42)] };
          return undefined;
        },
      });
      const ref = yield* (yield* host).create(input(azureLocator, "ready"));

      assert.deepStrictEqual(ref, {
        hostKind: "azure-devops",
        host: "dev.azure.com",
        repository: "org/Project",
        id: "42",
        number: 42,
        url: "https://dev.azure.com/org/Project/_workitems/edit/42",
      });
      assert.deepStrictEqual(azureSent[0]?.body, {
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Description] CONTAINS WORDS '${MARKER}' ORDER BY [System.Id] ASC`,
      });
      const created = azureSent.find((sent) => sent.command === "boards work-item create");
      assert.strictEqual(created?.flag("--type"), "User Story");
      assert.strictEqual(created?.flag("--project"), "Project");
      assert.strictEqual(created?.flag("--fields"), "System.AreaPath=Project\\Team");
      assert.strictEqual(
        created?.description,
        `Checkpoints fail on &lt;large&gt; repos.<br>Capture them in batches.<!-- ${MARKER} -->`,
      );
      const moved = azureSent.at(-1);
      assert.strictEqual(moved?.command, "boards work-item update");
      assert.strictEqual(moved?.flag("--id"), "42");
      assert.strictEqual(moved?.flag("--state"), "New");
      assert.strictEqual(moved?.flag("--fields"), "WEF_TEAM_Kanban.Column=Selected");
    }),
  );

  it.effect("reuses the work item that already carries the marker", () =>
    Effect.gen(function* () {
      const { host, azureSent } = harness({
        azure: (sent) => {
          if (sent.command === "boards work-item update") return azureWorkItem(41);
          if (sent.resource === "wiql") return { workItems: [{ id: 41 }] };
          if (sent.resource === "boards") return azureBoardMetadata;
          if (sent.resource === "workItemsBatch") return { value: [azureWorkItem(41)] };
          return undefined;
        },
      });
      const ref = yield* (yield* host).create(input(azureLocator, "ready"));

      assert.strictEqual(ref.number, 41);
      assert.isFalse(azureSent.some((sent) => sent.command === "boards work-item create"));
      assert.strictEqual(azureSent.at(-1)?.flag("--id"), "41");
    }),
  );
});

describe("FactoryTicketHost boards", () => {
  it.effect("refuses a board host it cannot file on", () =>
    Effect.gen(function* () {
      const { host, gitHubSent, azureSent } = harness({});
      const failure = yield* (yield* host)
        .create(
          input(
            { kind: "gitlab-board", host: "gitlab.com" } as unknown as IssueBoardLocator,
            "ready",
          ),
        )
        .pipe(Effect.flip);

      assert.strictEqual(failure.reason, "unavailable");
      assert.strictEqual(
        failure.message,
        "Tickets can be filed on GitHub Projects and Azure Boards only.",
      );
      assert.deepStrictEqual([gitHubSent, azureSent], [[], []]);
    }),
  );
});
