import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  IssueOperationError,
  PositiveInt,
  TrimmedNonEmptyString,
  type IssueBoardLocator,
  type IssueDetail,
  type IssueRef,
} from "@t3tools/contracts";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import { CredentialScope } from "../sourceControl/SourceControlRateLimit.ts";
import {
  ISSUE_RESPONSE_LIMIT_BYTES,
  JsonRecord,
  arr,
  num,
  obj,
  readJson,
  readRecord,
  remoteIssueError,
  segment,
  str,
  toIssueDetail,
  toIssueSummary,
  validate,
  type DiscoveredIssueBoard,
  type IssueHostAdapter,
  type IssueHostBoards,
  type IssueHostScope,
} from "./IssueHostAdapter.ts";

type BoardLocator = Extract<IssueBoardLocator, { kind: "azure-board" }>;

class DiscoveryKey extends Data.Class<{
  readonly cwd: string;
  readonly host: string;
  readonly organization: string;
  readonly credentialScope: string;
}> {}

const WorkItem = Schema.Struct({
  id: PositiveInt,
  rev: PositiveInt,
  fields: Schema.Struct({
    "System.Title": Schema.String,
    "System.State": TrimmedNonEmptyString,
    "System.ChangedDate": Schema.String,
    "System.WorkItemType": TrimmedNonEmptyString,
  }),
});
const Board = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  fields: Schema.Struct({ columnField: Schema.Struct({ referenceName: TrimmedNonEmptyString }) }),
  columns: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      name: Schema.String,
      stateMappings: Schema.Record(Schema.String, TrimmedNonEmptyString),
    }),
  ),
});
const TeamFieldValues = Schema.Struct({
  field: Schema.Struct({ referenceName: TrimmedNonEmptyString }),
  values: Schema.Array(
    Schema.Struct({ value: TrimmedNonEmptyString, includeChildren: Schema.Boolean }),
  ),
});
const WorkItemList = Schema.Struct({ value: Schema.Array(JsonRecord) });
const QueryResult = Schema.Struct({ workItems: Schema.Array(Schema.Struct({ id: PositiveInt })) });
const Named = Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String });
const NamedList = Schema.Struct({ value: Schema.Array(Named) });
const CommentPage = Schema.Struct({ comments: Schema.Array(JsonRecord) });

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const projectOf = (ref: IssueRef) => {
  const [organization = "", project = ""] = ref.repository.split("/");
  return { organization, project };
};
const actor = (value: unknown) => {
  const name = str(obj(value).displayName);
  return name ? { name } : null;
};
const toIssue = (scope: IssueHostScope, raw: Record<string, unknown>): IssueDetail => {
  const fields = obj(raw.fields);
  const id = num(raw.id);
  return {
    ref: {
      ...scope.ref,
      id: String(id),
      number: id,
      url: `https://${scope.ref.host}/${scope.ref.repository}/_workitems/edit/${id}`,
    },
    title: str(fields["System.Title"]),
    state: str(fields["System.State"]),
    updatedAt: str(fields["System.ChangedDate"]),
    labels: str(fields["System.Tags"])
      .split(";")
      .map((tag) => tag.trim())
      .filter(Boolean),
    body: str(fields["System.Description"]),
    author: actor(fields["System.CreatedBy"]),
    assignees: [actor(fields["System.AssignedTo"])].filter((value) => value !== null),
    createdAt: str(fields["System.CreatedDate"]),
    hostFields: Object.fromEntries(
      Object.entries(fields).flatMap(([key, value]) =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? [[key, String(value)]]
          : [],
      ),
    ),
  };
};

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cli = (cwd: string, organization: string, args: ReadonlyArray<string>) =>
    azure
      .execute({
        cwd,
        args: [
          ...args,
          "--organization",
          `https://dev.azure.com/${segment(organization)}`,
          "--only-show-errors",
          "--output",
          "json",
        ],
        maxOutputBytes: ISSUE_RESPONSE_LIMIT_BYTES,
      })
      .pipe(
        Effect.map((output) => output.stdout),
        Effect.mapError(remoteIssueError),
      );
  const invoke = Effect.fnUntraced(function* (
    cwd: string,
    organization: string,
    request: {
      readonly area: string;
      readonly resource: string;
      readonly route: Record<string, string>;
      readonly query?: Record<string, string>;
      readonly body?: unknown;
      // The CLI parses this as a float after stripping "-preview", so "7.1-preview.4" is rejected.
      readonly apiVersion?: string;
    },
  ) {
    const query = request.query ?? {};
    const args = [
      "devops",
      "invoke",
      "--area",
      request.area,
      "--resource",
      request.resource,
      "--api-version",
      request.apiVersion ?? "7.1",
      "--http-method",
      request.body === undefined ? "GET" : "POST",
    ];
    if (Object.keys(request.route).length)
      args.push(
        "--route-parameters",
        ...Object.entries(request.route).map(([key, value]) => `${key}=${value}`),
      );
    if (Object.keys(query).length)
      args.push(
        "--query-parameters",
        ...Object.entries(query).map(([key, value]) => `${key}=${value}`),
      );
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        if (request.body !== undefined) {
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issues-" });
          const file = path.join(directory, "request.json");
          yield* fs.writeFileString(file, json(request.body));
          args.push("--in-file", file);
        }
        return yield* cli(cwd, organization, args);
      }),
    ).pipe(Effect.mapError(remoteIssueError));
    return yield* readRecord(output);
  });

  const workItems = Effect.fnUntraced(function* (
    cwd: string,
    organization: string,
    project: string,
    ids: ReadonlyArray<number>,
  ) {
    const batch = yield* invoke(cwd, organization, {
      area: "wit",
      resource: "workItemsBatch",
      route: { project },
      body: { ids },
    });
    return (yield* validate(WorkItemList, batch)).value;
  });
  const workItem = Effect.fnUntraced(function* (
    cwd: string,
    organization: string,
    project: string,
    id: string,
  ) {
    const [found] = yield* workItems(cwd, organization, project, [Number(id)]);
    if (!found)
      return yield* new IssueOperationError({
        reason: "not-found",
        message: "This work item no longer exists.",
      });
    return found;
  });
  const boardMetadata = Effect.fnUntraced(function* (cwd: string, locator: BoardLocator) {
    const value = yield* invoke(cwd, locator.organization, {
      area: "work",
      resource: "boards",
      route: { project: locator.project, team: locator.team, id: locator.boardId },
    });
    yield* validate(Board, value);
    return value;
  });

  const list: IssueHostAdapter["list"] = Effect.fn("AzureBoardsIssueHost.list")(
    function* (scope, cursor) {
      const { organization, project } = projectOf(scope.ref);
      const after = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
      const response = yield* invoke(scope.cwd, organization, {
        area: "wit",
        resource: "wiql",
        route: { project },
        query: { $top: "100" },
        body: {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Id] > ${after} ORDER BY [System.Id] ASC`,
        },
      });
      const ids = (yield* validate(QueryResult, response)).workItems.map((entry) => entry.id);
      const entries = ids.length ? yield* workItems(scope.cwd, organization, project, ids) : [];
      const issues = yield* Effect.forEach(entries, (entry) =>
        validate(WorkItem, entry).pipe(Effect.flatMap(() => toIssueSummary(toIssue(scope, entry)))),
      );
      return { issues, nextCursor: ids.length === 100 ? String(ids.at(-1)) : null };
    },
  );

  const get: IssueHostAdapter["get"] = Effect.fn("AzureBoardsIssueHost.get")(function* (scope) {
    const { ref, cwd } = scope;
    const { organization, project } = projectOf(ref);
    const raw = yield* workItem(cwd, organization, project, ref.id);
    yield* validate(WorkItem, raw);
    const comments: Record<string, unknown>[] = [];
    let continuation: string | null = null;
    do {
      const response: Record<string, unknown> = yield* invoke(cwd, organization, {
        area: "wit",
        resource: "comments",
        route: { project, workItemId: ref.id },
        query: { $top: "100", ...(continuation ? { continuationToken: continuation } : {}) },
        apiVersion: "7.1-preview",
      });
      comments.push(...(yield* validate(CommentPage, response)).comments);
      continuation = str(response.continuation_token) || null;
    } while (continuation);
    return yield* toIssueDetail({
      ...toIssue(scope, raw),
      comments: comments.map((comment) => ({
        id: String(comment.id),
        body: str(comment.text),
        createdAt: str(comment.createdDate),
        author: actor(comment.createdBy),
      })),
    });
  });

  const discover = Effect.fn("AzureBoardsIssueHost.listBoards")(function* (
    cwd: string,
    host: string,
    organization: string,
  ) {
    const pageSize = 100;
    const projects: (typeof Named.Type)[] = [];
    for (let skip = 0; ; skip += pageSize) {
      const output = yield* cli(cwd, organization, [
        "devops",
        "project",
        "list",
        "--top",
        String(pageSize),
        "--skip",
        String(skip),
      ]);
      const page = yield* validate(NamedList, yield* readRecord(output));
      projects.push(...page.value);
      if (page.value.length < pageSize) break;
    }
    // Bound organization-wide discovery even when the read transport uses HTTP.
    const results = yield* Effect.forEach(
      projects,
      (project) =>
        Effect.gen(function* () {
          const teams: (typeof Named.Type)[] = [];
          for (let skip = 0; ; skip += pageSize) {
            const output = yield* cli(cwd, organization, [
              "devops",
              "team",
              "list",
              "--project",
              project.id,
              "--top",
              String(pageSize),
              "--skip",
              String(skip),
            ]);
            const page = yield* validate(Schema.Array(Named), yield* readJson(output));
            teams.push(...page);
            if (page.length < pageSize) break;
          }
          const boards = yield* Effect.forEach(
            teams,
            (team) =>
              invoke(cwd, organization, {
                area: "work",
                resource: "boards",
                route: { project: project.id, team: team.id },
              }).pipe(
                Effect.flatMap((response) => validate(NamedList, response)),
                Effect.map((response) =>
                  response.value.map((board): DiscoveredIssueBoard => ({
                    title: `${project.name} / ${team.name} / ${board.name}`,
                    locator: {
                      kind: "azure-board",
                      host,
                      organization,
                      project: project.name,
                      team: team.id,
                      boardId: board.id,
                    },
                  })),
                ),
              ),
            { concurrency: 3 },
          );
          return boards.flat();
        }),
      { concurrency: 3 },
    );
    return results.flat();
  });
  const discovered = yield* Cache.makeWith(
    (key: DiscoveryKey) =>
      discover(key.cwd, key.host, key.organization).pipe(
        Effect.provideService(CredentialScope, key.credentialScope),
      ),
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(60) : Duration.zero),
    },
  );
  const listBoards: IssueHostBoards<"azure-board">["list"] = (scope) =>
    Effect.gen(function* () {
      const credentialScope = yield* CredentialScope;
      return yield* Cache.get(
        discovered,
        new DiscoveryKey({
          cwd: scope.cwd,
          host: scope.ref.host,
          organization: projectOf(scope.ref).organization,
          credentialScope,
        }),
      );
    });

  const read: IssueHostBoards<"azure-board">["read"] = Effect.fn("AzureBoardsIssueHost.board")(
    function* (cwd, locator) {
      const metadata = yield* boardMetadata(cwd, locator);
      const team = yield* invoke(cwd, locator.organization, {
        area: "work",
        resource: "teamfieldvalues",
        route: { project: locator.project, team: locator.team },
      });
      yield* validate(TeamFieldValues, team);
      const columns = arr(metadata.columns).map(obj);
      const types = [
        ...new Set(columns.flatMap((column) => Object.keys(obj(column.stateMappings)))),
      ];
      const field = str(obj(team.field).referenceName);
      const areas = arr(team.values).map(obj);
      if (!field || !areas.length || !types.length)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Azure board team areas or work item type mappings are unavailable.",
        });
      const areaQuery = areas
        .map(
          (area) =>
            `[${field}] ${area.includeChildren === true ? "UNDER" : "="} ${quote(str(area.value))}`,
        )
        .join(" OR ");
      const response = yield* invoke(cwd, locator.organization, {
        area: "wit",
        resource: "wiql",
        route: { project: locator.project },
        body: {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN (${types.map(quote).join(",")}) AND (${areaQuery}) ORDER BY [System.Id] ASC`,
        },
      });
      const ids = (yield* validate(QueryResult, response)).workItems.map((entry) => entry.id);
      const columnField = str(obj(obj(metadata.fields).columnField).referenceName);
      if (!columnField)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Azure did not expose this board's column field.",
        });
      const entries: Record<string, unknown>[] = [];
      for (let offset = 0; offset < ids.length; offset += 200)
        entries.push(
          ...(yield* workItems(
            cwd,
            locator.organization,
            locator.project,
            ids.slice(offset, offset + 200),
          )),
        );
      const scope = {
        cwd,
        ref: {
          hostKind: "azure-devops" as const,
          host: locator.host,
          repository: `${locator.organization}/${locator.project}`,
          id: "0",
          number: 0,
          url: "",
        },
      };
      const items = yield* Effect.forEach(entries, (raw) =>
        validate(WorkItem, raw).pipe(
          Effect.map(() => {
            const column = columns.find((entry) => entry.name === obj(raw.fields)[columnField]);
            return {
              issue: toIssue(scope, raw),
              itemId: String(num(raw.id)),
              columnId: column ? str(column.id) : null,
              version: String(num(raw.rev)),
            };
          }),
        ),
      );
      return {
        title: str(metadata.name),
        locator,
        columns: columns.map((column) => ({ id: str(column.id), title: str(column.name) })),
        items,
      };
    },
  );

  const move: IssueHostBoards<"azure-board">["move"] = Effect.fn("AzureBoardsIssueHost.move")(
    function* (cwd, locator, item, columnId) {
      const [metadata, current] = yield* Effect.all(
        [
          boardMetadata(cwd, locator),
          workItem(cwd, locator.organization, locator.project, item.issue.ref.id),
        ],
        { concurrency: 2 },
      );
      const column = arr(metadata.columns)
        .map(obj)
        .find((entry) => entry.id === columnId);
      if (!column)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "The selected Azure board column no longer exists.",
        });
      yield* validate(WorkItem, current);
      const fields = obj(current.fields);
      const state = str(obj(column.stateMappings)[str(fields["System.WorkItemType"])]);
      const columnField = str(obj(obj(metadata.fields).columnField).referenceName);
      if (!state || !columnField)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "The selected column does not map this work item type.",
        });
      const doneField = str(obj(obj(metadata.fields).doneField).referenceName);
      yield* cli(cwd, locator.organization, [
        "boards",
        "work-item",
        "update",
        "--id",
        item.issue.ref.id,
        "--state",
        state,
        "--fields",
        `${columnField}=${str(column.name)}`,
        ...(doneField ? [`${doneField}=false`] : []),
      ]);
    },
  );

  return {
    kind: "azure-devops",
    list,
    get,
    boards: { locatorKind: "azure-board", list: listBoards, read, move },
  } satisfies IssueHostAdapter;
});
