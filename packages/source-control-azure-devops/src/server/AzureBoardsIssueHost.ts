import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  IssueOperationError,
  PositiveInt,
  SourceControlProviderKind,
  TrimmedNonEmptyString,
  type IssueBoardItem,
  type IssueBoardLocator,
  type IssueDetail,
  type IssueRef,
} from "@t3tools/contracts";
import {
  JsonRecord,
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
} from "@t3tools/source-control-core/server/IssueHostAdapter";
import { CredentialScope } from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as AzureBoardsCli from "./AzureBoardsCli.ts";

type BoardLocator = Extract<IssueBoardLocator, { kind: "azure-board" }>;

const AZURE_DEVOPS = SourceControlProviderKind.make("azure-devops");
const PAGE_SIZE = 100;
const BATCH_SIZE = 200;
const DISCOVERY_CONCURRENCY = 3;

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
const ReferenceName = Schema.Struct({ referenceName: TrimmedNonEmptyString });
const Board = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  fields: Schema.Struct({
    columnField: ReferenceName,
    doneField: Schema.optional(Schema.NullOr(ReferenceName)),
  }),
  columns: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      name: Schema.String,
      stateMappings: Schema.Record(Schema.String, TrimmedNonEmptyString),
    }),
  ),
});
type Board = typeof Board.Type;
const TeamFieldValues = Schema.Struct({
  field: ReferenceName,
  values: Schema.Array(
    Schema.Struct({ value: TrimmedNonEmptyString, includeChildren: Schema.Boolean }),
  ),
});
// `errorPolicy: "omit"` answers a deleted id with null instead of failing the whole batch.
const WorkItemBatch = Schema.Struct({ value: Schema.Array(Schema.NullOr(JsonRecord)) });
const QueryResult = Schema.Struct({ workItems: Schema.Array(Schema.Struct({ id: PositiveInt })) });
const Named = Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String });
const NamedList = Schema.Struct({ value: Schema.Array(Named) });
const CommentPage = Schema.Struct({
  comments: Schema.Array(JsonRecord),
  continuation_token: Schema.optional(Schema.NullOr(Schema.String)),
});

const AUTHENTICATION_MESSAGE =
  "Azure DevOps is not signed in. Run `az login` and `az devops login` on the computer hosting this project.";

const toIssueError = (error: AzureBoardsCli.AzureBoardsCliError): IssueOperationError => {
  switch (error._tag) {
    case "AzureDevOpsCliAuthenticationError":
      return new IssueOperationError({ reason: "authentication", message: AUTHENTICATION_MESSAGE });
    case "AzureDevOpsCliUnavailableError":
      return new IssueOperationError({ reason: "unavailable", message: error.detail });
    case "AzureBoardsRejectedError":
      return new IssueOperationError({ reason: "invalid", message: error.message });
    case "AzureDevOpsPullRequestNotFoundError":
      return new IssueOperationError({
        reason: "not-found",
        message: "Azure DevOps could not find this work item or board.",
      });
    default:
      return remoteIssueError(error);
  }
};
const missingWorkItem = () =>
  new IssueOperationError({ reason: "not-found", message: "This work item no longer exists." });

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const projectOf = (ref: IssueRef) => {
  const [organization = "", project = ""] = ref.repository.split("/");
  return { organization, project };
};
const actor = (value: unknown) => {
  const name = str(obj(value).displayName);
  return name ? { name } : null;
};
const toIssue = (ref: IssueRef, raw: Record<string, unknown>): IssueDetail => {
  const fields = obj(raw.fields);
  const id = num(raw.id);
  return {
    ref: {
      ...ref,
      id: String(id),
      number: id,
      url: `https://${ref.host}/${ref.repository.split("/").map(segment).join("/")}/_workitems/edit/${id}`,
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
const boardRef = (locator: BoardLocator): IssueRef => ({
  hostKind: AZURE_DEVOPS,
  host: locator.host,
  repository: `${locator.organization}/${locator.project}`,
  id: "0",
  number: 0,
  url: `https://${locator.host}`,
});

/** Requires `AzureBoardsCli`; `CredentialScope` is read per call to split the discovery cache. */
export const make = Effect.gen(function* () {
  const cli = yield* AzureBoardsCli.AzureBoardsCli;

  const invoke = (input: AzureBoardsCli.AzureBoardsInvokeInput) =>
    cli.invoke(input).pipe(Effect.mapError(toIssueError), Effect.flatMap(readRecord));

  const workItems = Effect.fnUntraced(function* (
    cwd: string,
    organization: string,
    project: string,
    ids: ReadonlyArray<number>,
  ) {
    const found: Record<string, unknown>[] = [];
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      const response = yield* invoke({
        cwd,
        organization,
        area: "wit",
        resource: "workItemsBatch",
        route: { project },
        body: { ids: ids.slice(offset, offset + BATCH_SIZE), errorPolicy: "omit" },
      });
      const batch = yield* validate(WorkItemBatch, response);
      for (const entry of batch.value) if (entry !== null) found.push(entry);
    }
    return found;
  });
  const workItem = Effect.fnUntraced(function* (
    cwd: string,
    organization: string,
    project: string,
    id: string,
  ) {
    const [found] = /^\d+$/.test(id)
      ? yield* workItems(cwd, organization, project, [Number(id)])
      : [];
    if (!found) return yield* missingWorkItem();
    yield* validate(WorkItem, found);
    return found;
  });
  const boardMetadata = (cwd: string, locator: BoardLocator) =>
    invoke({
      cwd,
      organization: locator.organization,
      area: "work",
      resource: "boards",
      route: { project: locator.project, team: locator.team, id: locator.boardId },
    }).pipe(Effect.flatMap((response) => validate(Board, response)));
  const toBoardItem = (locator: BoardLocator, board: Board, raw: Record<string, unknown>) =>
    Effect.gen(function* () {
      const column = board.columns.find(
        (entry) => entry.name === obj(raw.fields)[board.fields.columnField.referenceName],
      );
      const item: IssueBoardItem = {
        issue: yield* toIssueSummary(toIssue(boardRef(locator), raw)),
        itemId: String(num(raw.id)),
        columnId: column?.id ?? null,
        version: String(num(raw.rev)),
      };
      return item;
    });

  const list: IssueHostAdapter["list"] = Effect.fn("AzureBoardsIssueHost.list")(
    function* (scope, cursor) {
      const { organization, project } = projectOf(scope.ref);
      const after = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
      const response = yield* invoke({
        cwd: scope.cwd,
        organization,
        area: "wit",
        resource: "wiql",
        route: { project },
        query: { $top: String(PAGE_SIZE) },
        body: {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Id] > ${after} ORDER BY [System.Id] ASC`,
        },
      });
      const ids = (yield* validate(QueryResult, response)).workItems.map((entry) => entry.id);
      const entries = yield* workItems(scope.cwd, organization, project, ids);
      const issues = yield* Effect.forEach(entries, (entry) =>
        validate(WorkItem, entry).pipe(
          Effect.flatMap(() => toIssueSummary(toIssue(scope.ref, entry))),
        ),
      );
      return { issues, nextCursor: ids.length === PAGE_SIZE ? String(ids.at(-1)) : null };
    },
  );

  const get: IssueHostAdapter["get"] = Effect.fn("AzureBoardsIssueHost.get")(function* (scope) {
    const { ref, cwd } = scope;
    const { organization, project } = projectOf(ref);
    const raw = yield* workItem(cwd, organization, project, ref.id);
    const comments: Record<string, unknown>[] = [];
    let continuation: string | null = null;
    do {
      const response: Record<string, unknown> = yield* invoke({
        cwd,
        organization,
        area: "wit",
        resource: "comments",
        route: { project, workItemId: ref.id },
        query: {
          $top: String(PAGE_SIZE),
          ...(continuation ? { continuationToken: continuation } : {}),
        },
        apiVersion: AzureBoardsCli.COMMENTS_API_VERSION,
      });
      const page: typeof CommentPage.Type = yield* validate(CommentPage, response);
      comments.push(...page.comments);
      continuation = page.continuation_token || null;
    } while (continuation);
    return yield* toIssueDetail({
      ...toIssue(ref, raw),
      comments: comments.map((comment) => ({
        id: String(comment.id),
        body: str(comment.text),
        createdAt: str(comment.createdDate),
        author: actor(comment.createdBy),
      })),
    });
  });

  const pages = <A>(read: (skip: number) => Effect.Effect<ReadonlyArray<A>, IssueOperationError>) =>
    Effect.gen(function* () {
      const all: A[] = [];
      for (let skip = 0; ; skip += PAGE_SIZE) {
        const page = yield* read(skip);
        all.push(...page);
        if (page.length < PAGE_SIZE) return all;
      }
    });
  const discover = Effect.fn("AzureBoardsIssueHost.discover")(function* (
    cwd: string,
    host: string,
    organization: string,
  ) {
    const projects = yield* pages((skip) =>
      cli.listProjects({ cwd, organization, top: PAGE_SIZE, skip }).pipe(
        Effect.mapError(toIssueError),
        Effect.flatMap(readRecord),
        Effect.flatMap((response) => validate(NamedList, response)),
        Effect.map((response) => response.value),
      ),
    );
    const teams = yield* Effect.forEach(
      projects,
      (project) =>
        pages((skip) =>
          cli.listTeams({ cwd, organization, project: project.id, top: PAGE_SIZE, skip }).pipe(
            Effect.mapError(toIssueError),
            Effect.flatMap(readJson),
            Effect.flatMap((response) => validate(Schema.Array(Named), response)),
          ),
        ).pipe(Effect.map((found) => found.map((team) => ({ project, team })))),
      { concurrency: DISCOVERY_CONCURRENCY },
    );
    const boards = yield* Effect.forEach(
      teams.flat(),
      ({ project, team }) =>
        invoke({
          cwd,
          organization,
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
      { concurrency: DISCOVERY_CONCURRENCY },
    );
    return boards.flat();
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

  const read: IssueHostBoards<"azure-board">["read"] = Effect.fn("AzureBoardsIssueHost.read")(
    function* (cwd, locator) {
      const board = yield* boardMetadata(cwd, locator);
      const team = yield* invoke({
        cwd,
        organization: locator.organization,
        area: "work",
        resource: "teamfieldvalues",
        route: { project: locator.project, team: locator.team },
      }).pipe(Effect.flatMap((response) => validate(TeamFieldValues, response)));
      const types = [
        ...new Set(board.columns.flatMap((column) => Object.keys(column.stateMappings))),
      ];
      if (!team.values.length || !types.length)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Azure board team areas or work item type mappings are unavailable.",
        });
      const areaQuery = team.values
        .map(
          (area) =>
            `[${team.field.referenceName}] ${area.includeChildren ? "UNDER" : "="} ${quote(area.value)}`,
        )
        .join(" OR ");
      const response = yield* invoke({
        cwd,
        organization: locator.organization,
        area: "wit",
        resource: "wiql",
        route: { project: locator.project },
        body: {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN (${types.map(quote).join(",")}) AND (${areaQuery}) ORDER BY [System.Id] ASC`,
        },
      });
      const ids = (yield* validate(QueryResult, response)).workItems.map((entry) => entry.id);
      const entries = yield* workItems(cwd, locator.organization, locator.project, ids);
      const items = yield* Effect.forEach(entries, (raw) =>
        validate(WorkItem, raw).pipe(Effect.flatMap(() => toBoardItem(locator, board, raw))),
      );
      return {
        title: board.name,
        locator,
        columns: board.columns.map((column) => ({ id: column.id, title: column.name })),
        items,
      };
    },
  );

  const readItem: IssueHostBoards<"azure-board">["readItem"] = Effect.fn(
    "AzureBoardsIssueHost.readItem",
  )(function* (cwd, locator, item) {
    const [board, raw] = yield* Effect.all(
      [
        boardMetadata(cwd, locator),
        workItem(cwd, locator.organization, locator.project, item.itemId),
      ],
      { concurrency: 2 },
    );
    return yield* toBoardItem(locator, board, raw);
  });

  const move: IssueHostBoards<"azure-board">["move"] = Effect.fn("AzureBoardsIssueHost.move")(
    function* (cwd, locator, item, columnId) {
      const [board, current] = yield* Effect.all(
        [
          boardMetadata(cwd, locator),
          workItem(cwd, locator.organization, locator.project, item.itemId),
        ],
        { concurrency: 2 },
      );
      const column = board.columns.find((entry) => entry.id === columnId);
      if (!column)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "The selected Azure board column no longer exists.",
        });
      const state = column.stateMappings[str(obj(current.fields)["System.WorkItemType"])];
      if (!state)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "The selected column does not map this work item type.",
        });
      const doneField = board.fields.doneField?.referenceName;
      yield* cli
        .updateWorkItem({
          cwd,
          organization: locator.organization,
          id: item.itemId,
          state,
          fields: {
            [board.fields.columnField.referenceName]: column.name,
            ...(doneField ? { [doneField]: "false" } : {}),
          },
        })
        .pipe(Effect.mapError(toIssueError));
    },
  );

  return {
    kind: AZURE_DEVOPS,
    list,
    get,
    boards: { locatorKind: "azure-board", list: listBoards, read, readItem, move },
  } satisfies IssueHostAdapter;
});
