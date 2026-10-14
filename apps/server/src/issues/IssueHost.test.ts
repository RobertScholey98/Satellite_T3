import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { type IssueBoardLocator, type IssueRef } from "@t3tools/contracts";
import { makeIssueHost } from "./IssueHost.ts";
import type { IssueHostScope } from "./IssueHostAdapter.ts";
import { CredentialScope } from "../sourceControl/SourceControlRateLimit.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeQuery = Schema.decodeUnknownEffect(Schema.Struct({ query: Schema.String }));
const output = (value: unknown) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: json(value),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});
const issue: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "42",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
};
const scope: IssueHostScope = { cwd: "/repo", ref: issue };
const host = (responses: {
  azure?: (input: {
    args: ReadonlyArray<string>;
  }) => Effect.Effect<unknown, Schema.SchemaError | PlatformError.PlatformError>;
  forgejo?: unknown;
}) =>
  makeIssueHost({
    gitlab: { execute: () => Effect.succeed(output([])) },
    azure: {
      execute: (input) =>
        (responses.azure?.(input) ?? Effect.succeed({})).pipe(Effect.map(output), Effect.orDie),
    },
    forgejo: { api: () => Effect.succeed(output(responses.forgejo ?? [])) },
    bitbucket: { request: () => Effect.succeed({ body: json({ values: [] }), truncated: false }) },
  });
const rejectPreviewTeamsInvoke = (args: ReadonlyArray<string>) => {
  if (args[args.indexOf("--resource") + 1] === "teams") {
    throw new Error('The requested version "7.1" of the resource is under preview.');
  }
};
const withNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | import("effect/Path").Path>,
) => effect.pipe(Effect.provide(NodeServices.layer));
describe("IssueHost", () => {
  it.effect("discovers teams concurrently with a bounded number of requests", () =>
    withNode(
      Effect.gen(function* () {
        let active = 0;
        let peak = 0;
        const api = yield* host({
          azure: ({ args }) =>
            Effect.gen(function* () {
              if (args.slice(0, 3).join(" ") === "devops project list")
                return { value: [{ id: "project", name: "Project" }] };
              if (args.slice(0, 3).join(" ") === "devops team list")
                return Array.from({ length: 8 }, (_, i) => ({
                  id: `team-${i}`,
                  name: `Team ${i}`,
                }));
              active++;
              peak = Math.max(peak, active);
              yield* Effect.yieldNow;
              active--;
              return { value: [{ id: "board", name: "Board" }] };
            }),
        });
        const results = yield* api.listBoards({
          cwd: "/repo",
          ref: { ...issue, hostKind: "azure-devops", repository: "acme/platform" },
        });
        assert.strictEqual(results.length, 8);
        assert.isAbove(peak, 1);
        assert.isAtMost(peak, 3);
        assert.deepStrictEqual(
          results.map(({ title }) => title),
          Array.from({ length: 8 }, (_, i) => `Project / Team ${i} / Board`),
        );
      }),
    ),
  );
  it.effect("reuses Azure board discovery until expiry and separates credential scopes", () =>
    withNode(
      Effect.gen(function* () {
        let requests = 0;
        const api = yield* host({
          azure: ({ args }) =>
            Effect.sync(() => {
              requests++;
              if (args.slice(0, 3).join(" ") === "devops project list")
                return { value: [{ id: "project", name: "Project" }] };
              if (args.slice(0, 3).join(" ") === "devops team list")
                return [{ id: "team", name: "Team" }];
              return { value: [{ id: "board", name: "Board" }] };
            }),
        });
        const input = {
          cwd: "/repo",
          ref: {
            ...issue,
            hostKind: "azure-devops" as const,
            host: "dev.azure.com",
            repository: "acme/platform",
          },
        };
        const first = yield* api.listBoards(input);
        assert.strictEqual(first.length, 1);
        assert.deepStrictEqual(yield* api.listBoards({ ...input, ref: { ...input.ref } }), first);
        assert.strictEqual(requests, 3);
        yield* api.listBoards(input).pipe(Effect.provideService(CredentialScope, "other-account"));
        assert.strictEqual(requests, 6);
        yield* TestClock.adjust("61 seconds");
        yield* Effect.all([api.listBoards(input), api.listBoards(input)], {
          concurrency: "unbounded",
        });
        assert.strictEqual(requests, 9);
      }),
    ),
  );
  it.effect("does not cache failed Azure board discovery", () =>
    withNode(
      Effect.gen(function* () {
        let calls = 0;
        const api = yield* host({
          azure: () =>
            Effect.sync(() => {
              calls++;
              return calls === 1 ? {} : { value: [] };
            }),
        });
        const input = {
          cwd: "/repo",
          ref: { ...issue, hostKind: "azure-devops" as const, repository: "acme/platform" },
        };
        assert.strictEqual((yield* api.listBoards(input).pipe(Effect.result))._tag, "Failure");
        assert.deepStrictEqual(yield* api.listBoards(input), []);
        assert.strictEqual(calls, 2);
      }),
    ),
  );
  it.effect("paginates Azure projects and teams instead of dropping later boards", () =>
    withNode(
      Effect.gen(function* () {
        const calls: ReadonlyArray<string>[] = [];
        const api = yield* host({
          azure: ({ args }) =>
            Effect.sync(() => {
              rejectPreviewTeamsInvoke(args);
              calls.push(args);
              if (args.includes("project") && args.includes("list")) {
                return {
                  value:
                    args[args.indexOf("--skip") + 1] === "0"
                      ? Array.from({ length: 100 }, (_, i) => ({
                          id: `project-${i}`,
                          name: `Project ${i}`,
                        }))
                      : [{ id: "last-project", name: "Last project" }],
                };
              }
              if (args.includes("team") && args.includes("list")) {
                if (args[args.indexOf("--project") + 1] !== "last-project") return [];
                return args[args.indexOf("--skip") + 1] === "0"
                  ? Array.from({ length: 100 }, (_, i) => ({
                      id: `team-${i}`,
                      name: `Team ${i}`,
                    }))
                  : [{ id: "last-team", name: "Last team" }];
              }
              return {
                value: args.includes("team=last-team") ? [{ id: "stories", name: "Stories" }] : [],
              };
            }),
        });
        const boards = yield* api.listBoards({
          ...scope,
          ref: {
            ...issue,
            hostKind: "azure-devops",
            host: "dev.azure.com",
            repository: "org/repo",
          },
        });
        assert.strictEqual(boards.length, 1);
        assert.strictEqual(boards[0]?.title, "Last project / Last team / Stories");
        assert.strictEqual(
          calls.filter((args) => args.includes("project") && args.includes("list")).length,
          2,
        );
        assert.strictEqual(
          calls.some(
            (args) =>
              args.includes("team") &&
              args[args.indexOf("--skip") + 1] === "100" &&
              args[args.indexOf("--project") + 1] === "last-project",
          ),
          true,
        );
      }),
    ),
  );
  it.effect("reports malformed Azure discovery responses as failures", () =>
    withNode(
      Effect.gen(function* () {
        const api = yield* host({
          azure: () => Effect.succeed({ value: [{ name: "Missing ID" }] }),
        });
        const result = yield* api
          .listBoards({
            ...scope,
            ref: {
              ...issue,
              hostKind: "azure-devops",
              host: "dev.azure.com",
              repository: "org/repo",
            },
          })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
      }),
    ),
  );
  it.effect(
    "discovers Azure boards across accessible projects in the repository's organization",
    () =>
      withNode(
        Effect.gen(function* () {
          const calls: ReadonlyArray<string>[] = [];
          const api = yield* host({
            azure: ({ args }) =>
              Effect.sync(() => {
                rejectPreviewTeamsInvoke(args);
                calls.push(args);
                if (args.includes("project") && args.includes("list")) {
                  return {
                    value: [
                      { id: "project-one", name: "First project" },
                      { id: "project-two", name: "Other project" },
                    ],
                  };
                }
                if (args.includes("team") && args.includes("list")) {
                  return [{ id: "team-one", name: "Team" }];
                }
                if (args.includes("boards")) {
                  return { value: [{ id: "stories", name: "Stories" }] };
                }
                return {};
              }),
          });
          const boards = yield* api.listBoards({
            ...scope,
            ref: {
              ...issue,
              hostKind: "azure-devops",
              host: "dev.azure.com",
              repository: "org/First project",
            },
          });
          assert.deepStrictEqual(
            boards.map((board) => board.locator),
            [
              {
                kind: "azure-board",
                host: "dev.azure.com",
                organization: "org",
                project: "First project",
                team: "team-one",
                boardId: "stories",
              },
              {
                kind: "azure-board",
                host: "dev.azure.com",
                organization: "org",
                project: "Other project",
                team: "team-one",
                boardId: "stories",
              },
            ],
          );
          assert.strictEqual(boards[1]?.title, "Other project / Team / Stories");
          assert.strictEqual(
            calls.every((args) => args.includes("https://dev.azure.com/org")),
            true,
          );
        }),
      ),
  );
  it.effect(
    "Azure membership applies selected team areas/types and movement uses board fields and mapped state",
    () =>
      withNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const bodies: unknown[] = [];
          const calls: ReadonlyArray<string>[] = [];
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
          const workItem = {
            id: 42,
            rev: 9,
            fields: {
              "System.Title": "Task",
              "System.State": "New",
              "System.ChangedDate": "now",
              "System.WorkItemType": "User Story",
              "WEF_TEAM_Kanban.Column": "Selected",
            },
          };
          const api = yield* host({
            azure: (input) =>
              Effect.gen(function* () {
                calls.push(input.args);
                const resource = input.args[input.args.indexOf("--resource") + 1];
                if (resource?.toLowerCase() === "workitems") throw new Error("KeyError: 'type'");
                if (input.args[0] === "boards" && input.args[1] === "work-item") return workItem;
                if (resource === "boards") return metadata;
                if (resource === "teamfieldvalues")
                  return {
                    field: { referenceName: "System.AreaPath" },
                    values: [{ value: "Project\\Team", includeChildren: true }],
                  };
                const file = input.args[input.args.indexOf("--in-file") + 1];
                if (input.args.includes("--in-file"))
                  bodies.push(yield* decodeJson(yield* fs.readFileString(file!)));
                if (resource === "wiql") return { workItems: [{ id: 42 }] };
                if (resource === "workItemsBatch") return { value: [workItem] };
                return {};
              }),
          });
          const locator: IssueBoardLocator = {
            kind: "azure-board",
            host: "dev.azure.com",
            organization: "org",
            project: "Project",
            team: "Team",
            boardId: "board",
          };
          const board = yield* api.board("/repo", locator);
          assert.strictEqual(board.items[0]!.columnId, "ready");
          yield* api.move("/repo", locator, board.items[0]!, "doing");
          const query = yield* decodeQuery(
            bodies.find((body) => typeof body === "object" && body !== null && "query" in body),
          );
          assert.match(query.query, /\[System.AreaPath\] UNDER 'Project\\Team'/);
          assert.match(query.query, /\[System.WorkItemType\] IN \('User Story'\)/);
          assert.deepStrictEqual(
            bodies.filter((body) => typeof body === "object" && body !== null && "ids" in body),
            [{ ids: [42] }, { ids: [42] }],
          );
          const update = calls.find((args) => args[0] === "boards" && args[1] === "work-item");
          assert.strictEqual(update?.[update.indexOf("--id") + 1], "42");
          assert.strictEqual(update?.[update.indexOf("--state") + 1], "Active");
          const fieldsAt = update?.indexOf("--fields") ?? -1;
          assert.deepStrictEqual(update?.slice(fieldsAt + 1, fieldsAt + 3), [
            "WEF_TEAM_Kanban.Column=Building",
            "WEF_TEAM_Kanban.Column.Done=false",
          ]);
          assert.strictEqual(
            calls.some((args) => args.includes("columns")),
            false,
          );
        }),
      ),
  );
  it.effect(
    "unknown hosts are unavailable and Forgejo lists through its existing authenticated API",
    () =>
      withNode(
        Effect.gen(function* () {
          const api = yield* host({
            forgejo: [
              {
                number: 42,
                title: "Forge task",
                state: "open",
                updated_at: "now",
                html_url: "https://forge/repo/issues/42",
              },
            ],
          });
          const result = yield* api.list({
            ...scope,
            ref: { ...issue, hostKind: "forgejo", host: "forge" },
          });
          assert.strictEqual(result.issues[0]!.title, "Forge task");
          const unavailable = yield* api
            .list({ ...scope, ref: { ...issue, hostKind: "unknown" } })
            .pipe(Effect.result);
          assert.strictEqual(unavailable._tag, "Failure");
        }),
      ),
  );
  it.effect("missing Azure team fields fail rather than pretending empty boards", () =>
    withNode(
      Effect.gen(function* () {
        const api = yield* host({
          azure: () => Effect.succeed({}),
        });
        assert.strictEqual(
          (yield* api
            .board("/repo", {
              kind: "azure-board",
              host: "dev.azure.com",
              organization: "org",
              project: "Project",
              team: "Team",
              boardId: "board",
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }),
    ),
  );
  it.effect("reads an Azure work item detail with every page of comments", () =>
    withNode(
      Effect.gen(function* () {
        const workItem = {
          id: 42,
          rev: 9,
          fields: {
            "System.Title": "Task",
            "System.State": "New",
            "System.ChangedDate": "now",
            "System.WorkItemType": "User Story",
          },
        };
        const comment = (id: number, text: string) => ({
          id,
          text,
          createdDate: "2026-10-01T00:00:00Z",
          createdBy: { displayName: "Rob" },
        });
        const api = yield* host({
          azure: ({ args }) =>
            Effect.sync(() => {
              const version = args[args.indexOf("--api-version") + 1] ?? "";
              if (/preview\.\d/.test(version))
                throw new Error(`could not convert string to float: '${version}'`);
              const resource = args[args.indexOf("--resource") + 1];
              if (resource === "workItemsBatch") return { value: [workItem] };
              if (resource === "comments")
                return args.includes("continuationToken=next")
                  ? { comments: [comment(2, "Second")], continuation_token: null }
                  : { comments: [comment(1, "First")], continuation_token: "next" };
              return {};
            }),
        });
        const detail = yield* api.get({
          cwd: "/repo",
          ref: {
            hostKind: "azure-devops",
            host: "dev.azure.com",
            repository: "org/Project",
            id: "42",
            number: 42,
            url: "https://dev.azure.com/org/Project/_workitems/edit/42",
          },
        });
        assert.strictEqual(detail.title, "Task");
        assert.deepStrictEqual(
          detail.comments?.map((entry) => [entry.id, entry.body, entry.author?.name]),
          [
            ["1", "First", "Rob"],
            ["2", "Second", "Rob"],
          ],
        );
      }),
    ),
  );
});
