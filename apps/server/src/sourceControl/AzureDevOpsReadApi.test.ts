import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, afterEach } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsPullRequestCli from "../pullRequest/AzureDevOpsPullRequestCli.ts";
import * as AzureDevOpsPullRequestProvider from "../pullRequest/AzureDevOpsPullRequestProvider.ts";
import { CredentialScope } from "./SourceControlRateLimit.ts";
import { makeIssueHost } from "../issues/IssueHost.ts";

const { getSecret } = vi.hoisted(() => ({
  getSecret: vi.fn(async (): Promise<Uint8Array | undefined> => undefined),
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    static withTarget() {
      return { getSecret };
    }
    getSecret = getSecret;
  },
}));
afterEach(() => getSecret.mockReset());

const output = (stdout: string) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const pr = {
  pullRequestId: 42,
  title: "Fast PR",
  sourceRefName: "refs/heads/feature",
  targetRefName: "refs/heads/main",
  creationDate: "2026-10-02T00:00:00Z",
  url: "https://dev.azure.com/acme/platform/_apis/git/repositories/web/pullrequests/42",
  repository: { name: "web", project: { name: "platform" } },
};
const read = (args: readonly string[], cwd = "/repo") =>
  Effect.flatMap(AzureDevOpsCli.AzureDevOpsCli, (cli) =>
    cli.execute({ cwd, args: [...args, "--output", "json"] }),
  );

function fixture(
  options: {
    pat?: string;
    remote?: string;
    remotes?: string;
    response?: (url: URL, authorization: string) => Response;
    wait?: (url: URL) => Effect.Effect<void>;
    tokenLifetime?: number;
  } = {},
) {
  const requests: { url: URL; authorization: string; method: string; body: string }[] = [];
  let tokenReads = 0;
  const processes: string[] = [];
  const layer = AzureDevOpsCli.layer.pipe(
    Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          const authorization = request.headers.authorization ?? "";
          requests.push({
            url,
            authorization,
            method: request.method,
            body:
              request.body._tag === "Uint8Array"
                ? Buffer.from(request.body.body).toString("utf8")
                : "",
          });
          const response = !authorization
            ? new Response("", {
                status: 401,
                headers: { "x-vss-resourcetenant": "11111111-1111-1111-1111-111111111111" },
              })
            : (options.response?.(url, authorization) ?? Response.json(pr));
          return (options.wait?.(url) ?? Effect.void).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, response)),
          );
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.gen(function* () {
            processes.push(`${input.command} ${input.args.slice(0, 3).join(" ")}`);
            if (input.command === "git") {
              const remote = options.remote ?? "https://dev.azure.com/acme/platform/_git/web";
              return output(
                input.args[0] === "remote"
                  ? (options.remotes ?? `origin\t${remote} (fetch)\norigin\t${remote} (push)`)
                  : `remote.origin.url ${remote}`,
              );
            }
            if (input.args[0] === "account" && input.args[1] === "get-access-token") {
              tokenReads++;
              expect(input.args).toContain("--tenant");
              const now = yield* Clock.currentTimeMillis;
              // Suspend so simultaneous API reads actually overlap during authentication.
              yield* Effect.yieldNow;
              return output(
                json({
                  accessToken: `token-${tokenReads}`,
                  expires_on: Math.floor((now + (options.tokenLifetime ?? 3600_000)) / 1000),
                }),
              );
            }
            return output("{}");
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { AZURE_DEVOPS_EXT_PAT: options.pat ?? "" } }),
      ),
    ),
  );
  return { layer, requests, processes, tokenReads: () => tokenReads };
}

it.effect(
  "coalesces authentication across concurrent PR reads and reuses it across repositories",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.gen(function* () {
        const results = yield* Effect.all(
          Array.from({ length: 8 }, (_, i) =>
            read(["repos", "pr", "show", "--id", "42"], `/repo-${i}`),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.map((result) => result.stdout)).toEqual(Array(8).fill(json(pr)));
        yield* read(["repos", "pr", "show", "--id", "43"]);
        expect(test.tokenReads()).toBe(1);
        expect(test.processes.filter((command) => command.startsWith("az"))).toEqual([
          "az account get-access-token --resource",
        ]);
        expect(
          test.requests
            .filter((request) => request.authorization)
            .every((request) => request.authorization === "Bearer token-1"),
        ).toBe(true);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("reads the effective origin push repository used by Azure CLI mutations", () =>
  Effect.gen(function* () {
    const fetch = "https://dev.azure.com/upstream/platform/_git/web";
    const push = "https://dev.azure.com/acme/fork/_git/custom-web";
    const test = fixture({
      pat: "pat",
      remote: fetch,
      remotes: `other\t${fetch} (push)\norigin\t${fetch} (fetch)\norigin\t${push} (push)`,
      response: (url) =>
        url.pathname.endsWith("/pullrequests")
          ? Response.json({ value: [{ ...pr, status: "active" }] })
          : Response.json({
              name: "custom-web",
              webUrl: push,
              remoteUrl: push,
              sshUrl: "git@ssh.dev.azure.com:v3/acme/fork/custom-web",
              defaultBranch: "refs/heads/main",
            }),
    });
    yield* Effect.gen(function* () {
      const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
      expect(
        yield* azure.listPullRequests({ cwd: "/repo", headSelector: "feature", state: "open" }),
      ).toHaveLength(1);
      expect(yield* azure.getDefaultBranch({ cwd: "/repo" })).toBe("main");
      expect(test.requests.map(({ url }) => url.pathname)).toEqual([
        "/acme/fork/_apis/git/repositories/custom-web/pullrequests",
        "/acme/fork/_apis/git/repositories/custom-web",
      ]);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("uses another Azure push remote when origin only pushes to GitHub", () =>
  Effect.gen(function* () {
    const fetch = "https://dev.azure.com/upstream/platform/_git/web";
    const test = fixture({
      pat: "pat",
      remote: fetch,
      remotes: [
        `origin\t${fetch} (fetch)`,
        "origin\thttps://github.com/acme/web (push)",
        "azure\tgit@ssh.dev.azure.com:v3/acme/fork/custom-web (push)",
      ].join("\n"),
    });
    yield* read(["repos", "pr", "show", "--id", "42"]).pipe(Effect.provide(test.layer));
    expect(test.requests[0]?.url.pathname).toBe("/acme/fork/_apis/git/pullrequests/42");
  }),
);

it.effect("leaves detection to Azure CLI when there is no supported Azure push remote", () =>
  Effect.gen(function* () {
    const fetch = "https://dev.azure.com/upstream/platform/_git/web";
    const test = fixture({
      pat: "pat",
      remote: fetch,
      remotes: `origin\t${fetch} (fetch)\norigin\thttps://github.com/acme/web (push)`,
    });
    yield* read(["repos", "pr", "show", "--id", "42"]).pipe(Effect.provide(test.layer));
    expect(test.requests).toHaveLength(0);
    expect(test.processes.at(-1)).toBe("az repos pr show");
  }),
);

it.effect(
  "keeps an unsupported Azure origin on the CLI instead of reading another repository",
  () =>
    Effect.gen(function* () {
      const test = fixture({
        pat: "pat",
        remotes: [
          "other\thttps://dev.azure.com/other/platform/_git/web (push)",
          "origin\tacme@vs-ssh.visualstudio.com:v3/acme/project/repo (push)",
        ].join("\n"),
      });
      yield* read(["repos", "pr", "show", "--id", "42"]).pipe(Effect.provide(test.layer));
      expect(test.requests).toHaveLength(0);
      expect(test.processes.at(-1)).toBe("az repos pr show");
    }),
);

it.effect("uses the last effective push URL for a remote, matching Azure CLI detection", () =>
  Effect.gen(function* () {
    const test = fixture({
      pat: "pat",
      remotes: [
        "origin\thttps://dev.azure.com/first/platform/_git/web (push)",
        "origin\thttps://dev.azure.com/acme/fork/_git/custom-web (push)",
      ].join("\n"),
    });
    yield* read(["repos", "pr", "show", "--id", "42"]).pipe(Effect.provide(test.layer));
    expect(test.requests[0]?.url.pathname).toBe("/acme/fork/_apis/git/pullrequests/42");
  }),
);

it.effect("reads board discovery over HTTP without requiring an Azure Git remote", () =>
  Effect.gen(function* () {
    const rows = [{ id: "id", name: "Platform" }];
    const test = fixture({
      pat: "pat",
      remote: "https://github.com/acme/web",
      response: () => Response.json({ value: rows }),
    });
    yield* Effect.gen(function* () {
      const project = yield* read([
        "devops",
        "project",
        "list",
        "--organization",
        "https://dev.azure.com/acme",
        "--top",
        "100",
        "--skip",
        "100",
      ]);
      const teams = yield* read([
        "devops",
        "team",
        "list",
        "--organization",
        "https://dev.azure.com/acme",
        "--project",
        "project id",
        "--top",
        "100",
        "--skip",
        "0",
      ]);
      yield* read([
        "devops",
        "invoke",
        "--organization",
        "https://dev.azure.com/acme",
        "--area",
        "work",
        "--resource",
        "boards",
        "--route-parameters",
        "project=platform",
        "team=team id",
      ]);
      expect(project.stdout).toBe(json({ value: rows }));
      expect(teams.stdout).toBe(json(rows));
      expect(test.requests.map(({ url }) => url.pathname)).toEqual([
        "/acme/_apis/projects",
        "/acme/_apis/projects/project%20id/teams",
        "/acme/platform/team%20id/_apis/work/boards",
      ]);
      expect(test.requests[0]?.url.searchParams.get("$skip")).toBe("100");
      expect(test.processes).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("loads an Azure board through IssueHost using one sign-in and no per-read CLI", () =>
  Effect.gen(function* () {
    const test = fixture({
      response: (url) => {
        if (url.pathname.endsWith("/boards/stories"))
          return Response.json({
            id: "stories",
            name: "Stories",
            fields: { columnField: { referenceName: "System.BoardColumn" } },
            columns: [{ id: "ready", name: "Ready", stateMappings: { Bug: "New" } }],
          });
        if (url.pathname.endsWith("/teamfieldvalues"))
          return Response.json({
            field: { referenceName: "System.AreaPath" },
            values: [{ value: "Platform", includeChildren: true }],
          });
        if (url.pathname.endsWith("/wiql")) return Response.json({ workItems: [{ id: 123 }] });
        return Response.json({
          value: [
            {
              id: 123,
              rev: 1,
              fields: {
                "System.Title": "Fix latency",
                "System.State": "New",
                "System.ChangedDate": "2026-10-02T00:00:00Z",
                "System.WorkItemType": "Bug",
                "System.BoardColumn": "Ready",
              },
            },
          ],
        });
      },
    });
    yield* Effect.gen(function* () {
      const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
      const unused = () => Effect.die("Unexpected host");
      const api = yield* makeIssueHost({
        azure,
        github: { execute: unused },
        gitlab: { execute: unused },
        forgejo: { api: unused },
        bitbucket: { request: unused },
      });
      const board = yield* api.board("/repo", {
        kind: "azure-board",
        host: "dev.azure.com",
        organization: "acme",
        project: "platform",
        team: "team",
        boardId: "stories",
      });
      expect(board.items[0]?.issue.title).toBe("Fix latency");
      expect(board.items[0]?.columnId).toBe("ready");
      expect(test.requests.filter(({ authorization }) => authorization)).toHaveLength(4);
      expect(test.tokenReads()).toBe(1);
      expect(test.processes).toEqual(["az account get-access-token --resource"]);
    }).pipe(Effect.provide(Layer.merge(test.layer, NodeServices.layer)));
  }),
);

it.effect("uses reusable auth for read-only work-item POSTs and leaves updates on CLI", () =>
  Effect.gen(function* () {
    const test = fixture({ pat: "pat" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = path.join(dir, "query.json");
        yield* fs.writeFileString(file, json({ query: "SELECT [System.Id] FROM WorkItems" }));
        for (const resource of ["wiql", "workItemsBatch"])
          yield* read([
            "devops",
            "invoke",
            "--organization",
            "https://dev.azure.com/acme",
            "--area",
            "wit",
            "--resource",
            resource,
            "--route-parameters",
            "project=platform",
            "--http-method",
            "POST",
            "--in-file",
            file,
          ]);
        yield* read([
          "devops",
          "invoke",
          "--area",
          "wit",
          "--resource",
          "workItems",
          "--http-method",
          "PATCH",
        ]);
        expect(test.requests.map(({ method }) => method)).toEqual(["POST", "POST"]);
        expect(test.requests[0]?.body).toBe(json({ query: "SELECT [System.Id] FROM WorkItems" }));
        expect(test.requests[1]?.url.pathname).toBe("/acme/platform/_apis/wit/workitemsbatch");
        expect(test.processes).toEqual(["az devops invoke --area"]);
      }),
    ).pipe(Effect.provide(Layer.merge(test.layer, NodeServices.layer)));
  }),
);

it.effect("coalesces overlapping metadata reads but fetches fresh data on refresh", () =>
  Effect.gen(function* () {
    const test = fixture();
    yield* Effect.gen(function* () {
      yield* Effect.all(
        Array.from({ length: 8 }, () => read(["repos", "pr", "show", "--id", "42"])),
        { concurrency: "unbounded" },
      );
      expect(test.requests.filter(({ authorization }) => authorization)).toHaveLength(1);
      yield* read(["repos", "pr", "show", "--id", "42"]);
      expect(test.requests.filter(({ authorization }) => authorization)).toHaveLength(2);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("releases a timed-out shared read so the next request can retry", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let first = true;
    const test = fixture({
      pat: "pat",
      wait: () => {
        if (!first) return Effect.void;
        first = false;
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      },
    });
    yield* Effect.gen(function* () {
      const pending = yield* read(["repos", "pr", "show", "--id", "42"]).pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("31 seconds");
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      expect((yield* read(["repos", "pr", "show", "--id", "42"])).stdout).toBe(json(pr));
      expect(test.requests).toHaveLength(2);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("reads repository metadata, board columns, team areas and issue comments over HTTP", () =>
  Effect.gen(function* () {
    const test = fixture({ pat: "pat" });
    yield* Effect.gen(function* () {
      yield* read(["repos", "show", "--repository", "other project/other repo"]);
      for (const [area, resource, route] of [
        ["work", "boards", ["project=platform", "team=team", "id=stories"]],
        ["work", "teamfieldvalues", ["project=platform", "team=team"]],
        ["wit", "comments", ["project=platform", "workItemId=123"]],
      ] as const)
        yield* read([
          "devops",
          "invoke",
          "--area",
          area,
          "--resource",
          resource,
          "--route-parameters",
          ...route,
          "--api-version",
          resource === "comments" ? "7.1-preview" : "7.1",
        ]);
      expect(test.requests.map(({ url }) => url.pathname)).toEqual([
        "/acme/other%20project/_apis/git/repositories/other%20repo",
        "/acme/platform/team/_apis/work/boards/stories",
        "/acme/platform/team/_apis/work/teamsettings/teamfieldvalues",
        "/acme/platform/_apis/wit/workItems/123/comments",
      ]);
      expect(test.requests.at(-1)?.url.searchParams.get("api-version")).toBe("7.1-preview");
      expect(test.processes.filter((command) => command.startsWith("az"))).toHaveLength(0);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("caches immutable diff contents by commit and excludes oversized files", () =>
  Effect.gen(function* () {
    const test = fixture({
      pat: "pat",
      response: (url) =>
        Response.json({
          content: "x".repeat(url.searchParams.get("path") === "/large" ? 70_000 : 10),
        }),
    });
    const item = (commit: string, file = "/small") =>
      read([
        "devops",
        "invoke",
        "--area",
        "git",
        "--resource",
        "items",
        "--route-parameters",
        "project=platform",
        "repositoryId=web",
        "--query-parameters",
        `path=${file}`,
        "versionDescriptor.versionType=commit",
        `versionDescriptor.version=${commit}`,
      ]);
    yield* Effect.gen(function* () {
      yield* item("a".repeat(40));
      yield* item("a".repeat(40));
      expect(test.requests).toHaveLength(1);
      yield* item("b".repeat(40));
      expect(test.requests).toHaveLength(2);
      yield* item("a".repeat(40), "/large");
      yield* item("a".repeat(40), "/large");
      expect(test.requests).toHaveLength(4);
      yield* TestClock.adjust("11 minutes");
      yield* item("a".repeat(40));
      expect(test.requests).toHaveLength(5);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("uses an existing environment PAT without starting Azure CLI", () =>
  Effect.gen(function* () {
    const test = fixture({ pat: "existing-pat" });
    yield* read(["repos", "pr", "show", "--id", "42"]).pipe(Effect.provide(test.layer));
    expect(test.tokenReads()).toBe(0);
    expect(test.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from(":existing-pat").toString("base64")}`,
    );
  }),
);

it.effect("reuses the Azure DevOps login PAT from the native credential store", () =>
  Effect.gen(function* () {
    getSecret.mockResolvedValue(Buffer.from("stored-pat", "utf16le"));
    const test = fixture();
    yield* read(["repos", "pr", "show", "--id", "42"]).pipe(Effect.provide(test.layer));
    expect(test.tokenReads()).toBe(0);
    expect(test.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from(":stored-pat").toString("base64")}`,
    );
  }),
);

it.effect("refreshes an expired access token before the next read", () =>
  Effect.gen(function* () {
    const test = fixture({ tokenLifetime: 120_000 });
    yield* Effect.gen(function* () {
      yield* read(["repos", "pr", "show", "--id", "42"]);
      yield* TestClock.adjust("61 seconds");
      yield* read(["repos", "pr", "show", "--id", "42"]);
      expect(test.tokenReads()).toBe(2);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("refreshes a rejected token once and shares the refreshed token with later reads", () =>
  Effect.gen(function* () {
    const test = fixture({
      response: (_url, auth) =>
        auth === "Bearer token-1" ? new Response("", { status: 401 }) : Response.json(pr),
    });
    yield* Effect.gen(function* () {
      yield* read(["repos", "pr", "show", "--id", "42"]);
      yield* read(["repos", "pr", "show", "--id", "43"]);
      expect(test.tokenReads()).toBe(2);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect(
  "reports a persistent authentication failure without falling back to slow CLI reads",
  () =>
    Effect.gen(function* () {
      const test = fixture({
        response: () => new Response("private token details", { status: 401 }),
      });
      const result = yield* read(["repos", "pr", "show", "--id", "42"]).pipe(
        Effect.result,
        Effect.provide(test.layer),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("AzureDevOpsCliAuthenticationError");
        expect(json(result.failure)).not.toContain("token-1");
        expect(json(result.failure)).not.toContain("private token details");
      }
      expect(test.tokenReads()).toBe(2);
    }),
);

it.effect("reads diff content over HTTP and preserves encoded file paths and commit queries", () =>
  Effect.gen(function* () {
    const test = fixture({
      pat: "pat",
      remote: "git@ssh.dev.azure.com:v3/acme/platform/web",
      response: () => Response.json({ content: "hello" }),
    });
    yield* read([
      "devops",
      "invoke",
      "--area",
      "git",
      "--resource",
      "items",
      "--route-parameters",
      "project=platform",
      "repositoryId=web",
      "--query-parameters",
      "path=/src/has space&equals=.ts",
      "versionDescriptor.version=head",
      "$format=json",
    ]).pipe(Effect.provide(test.layer));
    expect(test.requests[0]?.url.pathname).toBe("/acme/platform/_apis/git/repositories/web/items");
    expect(test.requests[0]?.url.searchParams.get("path")).toBe("/src/has space&equals=.ts");
    expect(test.requests[0]?.url.searchParams.get("versionDescriptor.version")).toBe("head");
    expect(test.processes.some((command) => command.startsWith("az"))).toBe(false);
  }),
);

it.effect("keeps pagination and translates the REST list envelope for existing readers", () =>
  Effect.gen(function* () {
    const test = fixture({ pat: "pat", response: () => Response.json({ value: [pr] }) });
    const result = yield* read([
      "repos",
      "pr",
      "list",
      "--repository",
      "web",
      "--status",
      "completed",
      "--skip",
      "20",
      "--top",
      "11",
      "--source-branch",
      "feature",
    ]).pipe(Effect.provide(test.layer));
    expect(result.stdout).toBe(json([pr]));
    expect(test.requests[0]?.url.searchParams.get("$skip")).toBe("20");
    expect(test.requests[0]?.url.searchParams.get("$top")).toBe("11");
    expect(test.requests[0]?.url.searchParams.get("searchCriteria.status")).toBe("completed");
    expect(test.requests[0]?.url.searchParams.get("searchCriteria.sourceRefName")).toBe(
      "refs/heads/feature",
    );
  }),
);

it.effect("preserves CLI mutations", () =>
  Effect.gen(function* () {
    const test = fixture();
    yield* read(["repos", "pr", "update", "--id", "42", "--status", "completed"]).pipe(
      Effect.provide(test.layer),
    );
    expect(test.requests).toHaveLength(0);
    expect(test.processes).toEqual(["az repos pr update"]);
  }),
);

it.effect(
  "loads PR information, activity and code through the real provider without per-read CLI launches",
  () =>
    Effect.gen(function* () {
      const test = fixture({
        response: (url) => {
          if (url.pathname.endsWith("/iterations"))
            return Response.json({
              value: [
                {
                  id: 1,
                  sourceRefCommit: { commitId: "head" },
                  commonRefCommit: { commitId: "base" },
                },
              ],
            });
          if (url.pathname.endsWith("/changes"))
            return Response.json({
              changeEntries: [{ changeType: "edit", item: { path: "/a.ts", objectId: "head" } }],
            });
          if (url.pathname.endsWith("/threads")) return Response.json({ value: [] });
          if (url.pathname.endsWith("/items"))
            return Response.json({
              content:
                url.searchParams.get("versionDescriptor.version") === "base" ? "old\n" : "new\n",
              contentMetadata: { isBinary: false },
            });
          return Response.json(pr);
        },
      });
      yield* Effect.gen(function* () {
        const provider = yield* AzureDevOpsPullRequestProvider.make;
        const input = { cwd: "/repo", host: "dev.azure.com", repository: "web", number: 42 };
        const [detail, activity, diff] = yield* Effect.all(
          [
            provider.getChangeRequest(input),
            provider.getChangeRequestActivity(input),
            provider.getDiff(input),
          ],
          { concurrency: "unbounded" },
        );
        expect(detail.title).toBe("Fast PR");
        expect(detail.changedFiles).toBe(1);
        expect(activity.commentsTruncated).toBe(false);
        expect(diff.patch).toContain("-old");
        expect(diff.patch).toContain("+new");
        expect(test.tokenReads()).toBe(1);
        expect(test.processes.filter((command) => command.startsWith("az"))).toHaveLength(1);
      }).pipe(Effect.provide(AzureDevOpsPullRequestCli.layer.pipe(Layer.provide(test.layer))));
    }),
);

it.effect("coalesces a token refresh when concurrent reads receive 401", () =>
  Effect.gen(function* () {
    const test = fixture({
      response: (_url, auth) =>
        auth === "Bearer token-1" ? new Response("", { status: 401 }) : Response.json(pr),
    });
    yield* Effect.gen(function* () {
      yield* Effect.all(
        Array.from({ length: 8 }, () => read(["repos", "pr", "show", "--id", "42"])),
        { concurrency: "unbounded" },
      );
      expect(test.tokenReads()).toBe(2);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("preserves rate-limit failures without retrying or exposing response bodies", () =>
  Effect.gen(function* () {
    const test = fixture({
      pat: "pat",
      response: () => new Response("private error", { status: 429 }),
    });
    const result = yield* read(["repos", "pr", "show", "--id", "42"]).pipe(
      Effect.result,
      Effect.provide(test.layer),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("AzureDevOpsCliRateLimitError");
    expect(test.requests).toHaveLength(1);
  }),
);

it.effect("resolves an author identity before applying the REST creator filter", () =>
  Effect.gen(function* () {
    const id = "22222222-2222-2222-2222-222222222222";
    const test = fixture({
      pat: "pat",
      response: (url) =>
        Response.json({ value: url.hostname === "vssps.dev.azure.com" ? [{ id }] : [pr] }),
    });
    yield* Effect.gen(function* () {
      const request = read(["repos", "pr", "list", "--creator", "user@acme.com"]);
      yield* request;
      yield* request;
      expect(test.requests).toHaveLength(3);
      yield* request.pipe(Effect.provideService(CredentialScope, "other-account"));
      expect(test.requests).toHaveLength(5);
    }).pipe(Effect.provide(test.layer));
    expect(test.requests[0]?.url.searchParams.get("filterValue")).toBe("user@acme.com");
    expect(test.requests[1]?.url.searchParams.get("searchCriteria.creatorId")).toBe(id);
  }),
);
