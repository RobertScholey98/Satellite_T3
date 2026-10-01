import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { type IssueBoardLocator, type IssueRef } from "@t3tools/contracts";
import { makeIssueHost, type IssueHostScope } from "./IssueHost.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeVariables = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));
const decodeQuery = Schema.decodeUnknownEffect(Schema.Struct({ query: Schema.String }));
const read = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
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
  github?: (input: {
    args: ReadonlyArray<string>;
    stdin?: string;
  }) => Effect.Effect<unknown, Schema.SchemaError | PlatformError.PlatformError>;
  azure?: (input: {
    args: ReadonlyArray<string>;
  }) => Effect.Effect<unknown, Schema.SchemaError | PlatformError.PlatformError>;
  forgejo?: unknown;
}) =>
  makeIssueHost({
    github: {
      execute: (input) =>
        (responses.github?.(input) ?? Effect.succeed({})).pipe(Effect.map(output), Effect.orDie),
    },
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
  it.effect("lists real GitHub issues and excludes PRs, rejecting malformed issue identities", () =>
    withNode(
      Effect.gen(function* () {
        const api = yield* host({
          github: () =>
            Effect.succeed([
              {
                number: 42,
                title: "Task",
                state: "open",
                updated_at: "now",
                html_url: issue.url,
                labels: [{ name: "bug" }],
              },
              { number: 43, pull_request: {}, title: "PR" },
            ]),
        });
        const result = yield* api.list(scope);
        assert.deepStrictEqual(
          result.issues.map((entry) => ({
            number: entry.ref.number,
            title: entry.title,
            labels: entry.labels,
          })),
          [{ number: 42, title: "Task", labels: ["bug"] }],
        );
        const broken = yield* host({
          github: () =>
            Effect.succeed([
              { title: "Missing ID", state: "open", updated_at: "now", html_url: issue.url },
            ]),
        });
        assert.strictEqual((yield* broken.list(scope).pipe(Effect.result))._tag, "Failure");
      }),
    ),
  );
  it.effect(
    "GitHub Projects use remote option and item IDs across pages and skip draft/PR items",
    () =>
      withNode(
        Effect.gen(function* () {
          const mutations: unknown[] = [];
          const api = yield* host({
            github: (input) =>
              Effect.gen(function* () {
                const body = yield* read(input.stdin!);
                const query = String(body.query).trim();
                const variables = yield* decodeVariables(body.variables);
                if (query.startsWith("mutation")) {
                  mutations.push(variables);
                  return {
                    data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-42" } } },
                  };
                }
                if (query.includes("projectV2(number"))
                  return {
                    data: {
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
                    },
                  };
                return {
                  data: {
                    node: {
                      items: {
                        nodes:
                          variables.cursor === null
                            ? [
                                {
                                  id: "item-42",
                                  updatedAt: "version-1",
                                  content: {
                                    __typename: "Issue",
                                    number: 42,
                                    title: "Task",
                                    state: "OPEN",
                                    updatedAt: "now",
                                    url: issue.url,
                                    repository: { nameWithOwner: "owner/repo" },
                                    labels: { nodes: [] },
                                  },
                                  fieldValues: {
                                    nodes: [
                                      { optionId: "column-ready", field: { id: "field-node" } },
                                    ],
                                  },
                                },
                              ]
                            : [
                                { id: "draft", content: { __typename: "DraftIssue" } },
                                { id: "pr", content: { __typename: "PullRequest" } },
                              ],
                        pageInfo: {
                          hasNextPage: variables.cursor === null,
                          endCursor: variables.cursor === null ? "page-2" : null,
                        },
                      },
                    },
                  },
                };
              }),
          });
          const locator: IssueBoardLocator = {
            kind: "github-project",
            host: "github.com",
            owner: "owner",
            ownerKind: "user",
            projectNumber: 2,
          };
          const board = yield* api.board("/repo", locator);
          assert.strictEqual(board.items.length, 1);
          assert.strictEqual(board.items[0]!.columnId, "column-ready");
          assert.deepStrictEqual(board.columns, [
            { id: "column-ready", title: "Selected" },
            { id: "column-work", title: "Doing" },
          ]);
          yield* api.move("/repo", board.locator, board.items[0]!, "column-work");
          assert.deepStrictEqual(mutations, [
            {
              project: "project-node",
              item: "item-42",
              field: "field-node",
              option: "column-work",
            },
          ]);
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
  it.effect(
    "missing GitHub project data or Azure team fields fail rather than pretending empty boards",
    () =>
      withNode(
        Effect.gen(function* () {
          const api = yield* host({
            github: () => Effect.succeed({ data: { user: { projectV2: null } } }),
            azure: () => Effect.succeed({}),
          });
          assert.strictEqual(
            (yield* api
              .board("/repo", {
                kind: "github-project",
                host: "github.com",
                owner: "owner",
                ownerKind: "user",
                projectNumber: 1,
              })
              .pipe(Effect.result))._tag,
            "Failure",
          );
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
