import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  IssueOperationError,
  type IssuePublicationDestination,
  type IssuePublicationDraft,
  type IssueRef,
  type IssueBoardItem,
  type IssueBoardLocator,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ProjectStoreV2, ProjectRow } from "../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as AzureDevOpsReadApi from "../sourceControl/AzureDevOpsReadApi.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as IssueHost from "./IssueHost.ts";
import * as IssueService from "./IssueService.ts";
import * as PublicationHost from "./IssuePublicationHost.ts";

const projectId = ProjectId.make("project");
const github: IssuePublicationDestination = {
  kind: "github",
  host: "github.com",
  repository: "owner/repo",
  triage: { kind: "labels", labels: ["triage"] },
};
const azure: IssuePublicationDestination = {
  kind: "azure",
  host: "dev.azure.com",
  organization: "org",
  project: "project",
  workItemType: "Task",
  areaPath: "project\\web",
  boardId: "board",
  columnId: "triage",
  state: "New",
};
const draft: IssuePublicationDraft = {
  title: "Improve lint",
  problem: "Repeated mismatch",
  impact: "Rework",
  proposedOutcome: "Enforce existing convention",
  acceptanceCriteria: ["Prevents recurrence"],
  evidence: [
    { summary: "Example", url: "file:///private/transcript" },
    { summary: "Public issue", url: "https://github.com/owner/repo/issues/1" },
  ],
  owner: "Project manager",
  requiredAuthority: "Project rule",
  suspectedCause: "project",
  origin: { assignmentId: "assignment", findingIds: ["finding"] },
  containmentOf: null,
};
const issue: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "42",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
};
const project = ProjectRow.make({
  projectId,
  title: "Project",
  workspaceRoot: "/fixture",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-10-10T00:00:00Z",
  updatedAt: "2026-10-10T00:00:00Z",
  deletedAt: null,
});
const object = Schema.Record(Schema.String, Schema.Unknown);
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(object));
const decodeObject = Schema.decodeUnknownSync(object);
const decodeStrings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
function fixture(kind: "github" | "azure" = "github") {
  const state = {
    writes: [] as string[],
    bodies: [] as Record<string, unknown>[],
    labels: ["triage"],
    body: "<!-- marker -->",
    pages: 1,
    duplicate: false,
    fingerprint: "account",
    boardItems: [] as IssueBoardItem[],
    columnId: "triage",
    azureState: "New",
    azureArea: "project\\web",
    azureType: "Task",
    boardReady: "ready",
    lostMembershipAck: false,
    allPagesFull: false,
  };
  const locator: IssueBoardLocator =
    kind === "github"
      ? {
          kind: "github-project",
          host: "github.com",
          owner: "owner",
          ownerKind: "user",
          projectNumber: 1,
          projectNodeId: "P1",
          statusFieldId: "F1",
        }
      : {
          kind: "azure-board",
          host: "dev.azure.com",
          organization: "org",
          project: "project",
          team: "web",
          boardId: "B1",
        };
  const identity: RepositoryIdentity = {
    canonicalKey: "repo",
    provider: kind === "github" ? "github" : "azure-devops",
    displayName: kind === "github" ? "owner/repo" : "org/project/_git/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl:
        kind === "github"
          ? "https://github.com/owner/repo.git"
          : "https://dev.azure.com/org/project/_git/repo",
    },
  };
  const ghItem = () => ({
    number: 42,
    node_id: "I42",
    html_url: issue.url,
    body: state.body,
    labels: state.labels.map((name) => ({ name })),
  });
  const azItem = () => ({
    id: 42,
    fields: {
      "System.TeamProject": "project",
      "System.State": state.azureState,
      "System.AreaPath": state.azureArea,
      "System.WorkItemType": state.azureType,
      "System.Tags": "marker",
    },
  });
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        let response: unknown;
        if (request.method === "POST") {
          state.writes.push(url.pathname);
          const body =
            request.body._tag === "Uint8Array"
              ? decodeBody(new TextDecoder().decode(request.body.body))
              : {};
          state.bodies.push(body);
          if (url.pathname.endsWith("/graphql")) {
            const variables = decodeObject(body.variables);
            if (String(body.query).includes("addProject")) {
              state.boardItems = [
                {
                  issue: { ref: issue, title: "Task", state: "open", labels: [], updatedAt: "now" },
                  itemId: "ITEM42",
                  columnId: null,
                  version: null,
                },
              ];
              if (state.lostMembershipAck)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response("lost acknowledgement", { status: 500 }),
                );
              response = { data: { addProjectV2ItemById: { item: { id: "ITEM42" } } } };
            } else {
              state.boardItems = state.boardItems.map((item) => ({
                ...item,
                columnId: String(variables.option),
              }));
              response = {
                data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM42" } } },
              };
            }
          } else if (url.pathname.endsWith("/labels")) {
            state.labels = decodeStrings(body.labels).slice();
            response = state.labels.map((name) => ({ name }));
          } else {
            state.body = String(body.body);
            response = ghItem();
          }
        } else if (url.pathname === "/repos/owner/repo")
          response = { full_name: "owner/repo", has_issues: true };
        else if (url.pathname.includes("/labels/"))
          response = { name: decodeURIComponent(url.pathname.split("/").at(-1)!) };
        else if (url.pathname.endsWith("/issues/42")) response = ghItem();
        else {
          const page = Number(url.searchParams.get("page") ?? 1);
          response =
            state.allPagesFull || page < state.pages
              ? Array.from({ length: 100 }, (_, index) => ({
                  ...ghItem(),
                  number: index + 100 * page,
                  body: "Unrelated",
                }))
              : state.duplicate
                ? [ghItem(), { ...ghItem(), number: 43 }]
                : [ghItem()];
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(response), {
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  const githubApi = GitHubApi.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        http,
        Layer.succeed(GitHubCredentials.GitHubCredentials, {
          get: (host) =>
            Effect.succeed({
              host,
              token: Redacted.make("fixture-token"),
              source: "gh",
              fingerprint: state.fingerprint,
            }),
          invalidate: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(GitHubGraphQlBudget.layer),
    Layer.provide(SourceControlRateLimit.layer),
  );
  const azApi = Layer.effect(AzureDevOpsCli.AzureDevOpsCli, AzureDevOpsCli.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AzureDevOpsReadApi.AzureDevOpsReadApi)({ read: () => Effect.succeed(null) }),
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              let response: unknown;
              const args = input.args;
              if (args.includes("create") || args.includes("update")) {
                state.writes.push(args.join(" "));
                response = azItem();
              } else if (args.includes("teamfieldvalues"))
                response = { values: [{ value: "project", includeChildren: true }] };
              else if (args.includes("invoke"))
                response = {
                  fields: { columnField: { referenceName: "System.BoardColumn" } },
                  columns: [{ id: "triage", name: "Triage", stateMappings: { Task: "New" } }],
                };
              else if (args.includes("query")) response = [azItem()];
              else response = azItem();
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: JSON.stringify(response),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
  const support = Layer.mergeAll(
    githubApi,
    azApi,
    Layer.mock(ProjectStoreV2)({ get: () => Effect.succeed(Option.some(project)) }),
    Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(identity) }),
    Layer.succeed(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    }),
    Layer.mock(IssueService.IssueService)({
      listBoards: () =>
        Effect.succeed([
          {
            id: "board",
            projectId,
            title: "Triage board",
            locator,
            mapping: {
              ready: state.boardReady,
              inProgress: "doing",
              inPullRequest: "review",
              completed: "done",
              moveOnMerge: true,
            },
          },
        ]),
    }),
    Layer.mock(IssueHost.IssueHost)({
      board: () =>
        Effect.succeed({
          title: "Board",
          locator,
          columns: [{ id: "triage", title: "Triage" }],
          items: state.boardItems,
        }),
    }),
  );
  return { state, layer: PublicationHost.layer.pipe(Layer.provide(support)) };
}

describe("IssuePublicationHost", () => {
  it.effect("does not publish local transcript paths inside otherwise valid prose", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const host = yield* PublicationHost.IssuePublicationHost;
      const destination = yield* host.validate({ projectId, destination: github });
      const result = yield* host
        .create({
          destination,
          draft: { ...draft, problem: "See C:\\Users\\someone\\private\\transcript.json" },
          marker: "marker",
          beforeMutation: Effect.void,
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(test.state.writes.length, 0);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("reconciles a lost board membership acknowledgement before retrying placement", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const host = yield* PublicationHost.IssuePublicationHost;
      const destination = yield* host.validate({
        projectId,
        destination: {
          ...github,
          triage: { kind: "board", boardId: "board", columnId: "triage", labels: [] },
        },
      });
      test.state.lostMembershipAck = true;
      assert.equal(
        (yield* host.place({ destination, issue, beforeMutation: Effect.void }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      assert.equal(test.state.writes.length, 1);
      test.state.lostMembershipAck = false;
      yield* host.place({ destination, issue, beforeMutation: Effect.void });
      assert.equal(test.state.writes.length, 2);
      assert.equal(
        test.state.bodies.filter((body) => String(body.query).includes("addProject")).length,
        1,
      );
      assert.deepEqual(yield* host.inspect({ destination, issue }), {
        kind: "board",
        itemId: "ITEM42",
        columnId: "triage",
      });
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("qualifies labels-only triage and verifies the actual issue labels", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const host = yield* PublicationHost.IssuePublicationHost;
      const destination = yield* host.validate({ projectId, destination: github });
      assert.equal(destination.credentialNamespace, "account");
      assert.equal(destination.board, null);
      const created = yield* host.create({
        destination,
        draft,
        marker: "marker",
        beforeMutation: Effect.void,
      });
      assert.deepEqual(created, issue);
      assert.include(String(test.state.bodies[0]!.body), "https://github.com/owner/repo/issues/1");
      assert.notInclude(String(test.state.bodies[0]!.body), "file://");
      assert.equal((yield* host.inspect({ destination, issue }))?.kind, "labels");
      test.state.labels = [];
      assert.equal(yield* host.inspect({ destination, issue }), undefined);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("rejects another repository, changed credentials and a ready column as triage", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const host = yield* PublicationHost.IssuePublicationHost;
      assert.equal(
        (yield* host
          .validate({ projectId, destination: { ...github, repository: "other/repo" } })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const destination = yield* host.validate({ projectId, destination: github });
      test.state.fingerprint = "other-account";
      assert.equal(
        (yield* host
          .create({ destination, draft, marker: "marker", beforeMutation: Effect.void })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      test.state.boardReady = "triage";
      assert.equal(
        (yield* host
          .validate({
            projectId,
            destination: {
              ...github,
              triage: { kind: "board", boardId: "board", columnId: "triage", labels: [] },
            },
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(test.state.writes.length, 0);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect(
    "looks through all issue pages and reports duplicate or bounded incomplete evidence",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        const host = yield* PublicationHost.IssuePublicationHost;
        const destination = yield* host.validate({ projectId, destination: github });
        test.state.pages = 2;
        assert.deepEqual(yield* host.lookup({ destination, marker: "marker" }), {
          issues: [issue],
          complete: true,
        });
        test.state.duplicate = true;
        assert.equal((yield* host.lookup({ destination, marker: "marker" })).issues.length, 2);
        test.state.allPagesFull = true;
        assert.equal((yield* host.lookup({ destination, marker: "marker" })).complete, false);
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect("checks live authority at the real GitHub HTTP mutation boundary", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const host = yield* PublicationHost.IssuePublicationHost;
      const destination = yield* host.validate({ projectId, destination: github });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let paused = false;
      const beforeMutation = Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        if (paused)
          return yield* new IssueOperationError({ reason: "conflict", message: "Paused" });
      });
      const pending = yield* host
        .create({ destination, draft, marker: "marker", beforeMutation })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      paused = true;
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(pending))._tag, "Failure");
      assert.equal(test.state.writes.length, 0);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect(
    "adds an existing issue to an approved board and verifies exact triage membership",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        const host = yield* PublicationHost.IssuePublicationHost;
        const destination = yield* host.validate({
          projectId,
          destination: {
            ...github,
            triage: { kind: "board", boardId: "board", columnId: "triage", labels: [] },
          },
        });
        yield* host.place({ destination, issue, beforeMutation: Effect.void });
        assert.deepEqual(yield* host.inspect({ destination, issue }), {
          kind: "board",
          itemId: "ITEM42",
          columnId: "triage",
        });
        assert.equal(test.state.writes.length, 2);
        yield* host.place({ destination, issue, beforeMutation: Effect.void });
        assert.equal(test.state.writes.length, 3);
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect(
    "qualifies exact Azure type, area, state and board; fences its actual CLI write",
    () => {
      const test = fixture("azure");
      return Effect.gen(function* () {
        const host = yield* PublicationHost.IssuePublicationHost;
        const destination = yield* host.validate({ projectId, destination: azure });
        const created = yield* host.create({
          destination,
          draft,
          marker: "marker",
          beforeMutation: Effect.void,
        });
        assert.equal(created.repository, "org/project");
        assert.include(test.state.writes[0]!, "System.State=New");
        assert.include(test.state.writes[0]!, "--area project\\web");
        assert.equal(
          (yield* host
            .create({
              destination,
              draft,
              marker: "other",
              beforeMutation: Effect.fail(
                new IssueOperationError({ reason: "conflict", message: "Paused" }),
              ),
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(test.state.writes.length, 1);
        test.state.boardItems = [
          {
            issue: { ref: created, title: "Task", state: "New", updatedAt: "now", labels: [] },
            itemId: "42",
            columnId: "triage",
            version: "1",
          },
        ];
        assert.equal((yield* host.inspect({ destination, issue: created }))?.kind, "board");
        test.state.azureState = "Active";
        assert.equal(yield* host.inspect({ destination, issue: created }), undefined);
        assert.equal(
          (yield* host
            .validate({ projectId, destination: { ...azure, state: "Active" } })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(Effect.provide(test.layer));
    },
  );
});
