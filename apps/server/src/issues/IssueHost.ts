import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  IssueOperationError,
  IssueDetail,
  IssueSummary,
  PositiveInt,
  TrimmedNonEmptyString,
  type IssueRef,
  type IssueBoardLocator,
  type IssueBoardItem,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { GitLabCli } from "../sourceControl/GitLabCli.ts";
import { AzureDevOpsCli } from "../sourceControl/AzureDevOpsCli.ts";
import { ForgejoCli } from "../sourceControl/ForgejoCli.ts";
import { BitbucketApi } from "../sourceControl/BitbucketApi.ts";
import { CredentialScope } from "../sourceControl/SourceControlRateLimit.ts";
import * as GitHubIssueHost from "./GitHubIssueHost.ts";
import type { IssueHostAdapter, IssueHostBoards, IssueHostScope } from "./IssueHostAdapter.ts";

type AzureBoardLocator = Extract<IssueBoardLocator, { kind: "azure-board" }>;
class AzureBoardsKey extends Data.Class<{
  readonly cwd: string;
  readonly host: string;
  readonly organization: string;
  readonly credentialScope: string;
}> {}

const invalid = () =>
  new IssueOperationError({
    reason: "remote",
    message: "The repository host returned invalid issue data.",
  });
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const remoteError = (cause: unknown) =>
  new IssueOperationError({
    reason: "remote",
    message: cause instanceof Error ? cause.message : "The repository host request failed.",
  });
const decode = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(invalid));
const record = Schema.Record(Schema.String, Schema.Unknown);
const GithubIssueResponse = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updated_at: Schema.String,
  html_url: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
});
const GitlabIssueResponse = Schema.Struct({
  iid: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updated_at: Schema.String,
  web_url: TrimmedNonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const BitbucketIssueResponse = Schema.Struct({
  id: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updated_on: Schema.String,
  links: Schema.Struct({ html: Schema.Struct({ href: TrimmedNonEmptyString }) }),
});
const AzureIssueResponse = Schema.Struct({
  id: PositiveInt,
  rev: PositiveInt,
  fields: Schema.Struct({
    "System.Title": Schema.String,
    "System.State": TrimmedNonEmptyString,
    "System.ChangedDate": Schema.String,
    "System.WorkItemType": TrimmedNonEmptyString,
  }),
});
const AzureBoardResponse = Schema.Struct({
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
const AzureTeamResponse = Schema.Struct({
  field: Schema.Struct({ referenceName: TrimmedNonEmptyString }),
  values: Schema.Array(
    Schema.Struct({ value: TrimmedNonEmptyString, includeChildren: Schema.Boolean }),
  ),
});
const AzureWorkItemList = Schema.Struct({ value: Schema.Array(record) });
const AzureQueryResponse = Schema.Struct({
  workItems: Schema.Array(Schema.Struct({ id: PositiveInt })),
});
const validate = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalid));
const validateIssue = (scope: IssueHostScope, raw: unknown) =>
  validate(
    scope.ref.hostKind === "azure-devops"
      ? AzureIssueResponse
      : scope.ref.hostKind === "gitlab"
        ? GitlabIssueResponse
        : scope.ref.hostKind === "bitbucket"
          ? BitbucketIssueResponse
          : GithubIssueResponse,
    raw,
  );
const JsonRecord = Schema.fromJsonString(record);
const decodeRecordJson = Schema.decodeEffect(JsonRecord);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isRecord = Schema.is(record);
const isArray = Schema.is(Schema.Array(Schema.Unknown));
const decodeIssueDetail = Schema.decodeEffect(IssueDetail);
const decodeIssueSummary = Schema.decodeEffect(IssueSummary);
const readRecord = (text: string) => decodeRecordJson(text).pipe(Effect.mapError(invalid));
const readJson = (text: string) => decodeJson(text).pipe(Effect.mapError(invalid));
const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const obj = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const arr = (value: unknown): ReadonlyArray<unknown> => (isArray(value) ? value : []);
const labels = (value: unknown) =>
  arr(value)
    .map((label) => (typeof label === "string" ? label : str(obj(label).name)))
    .filter(Boolean);
const actor = (value: unknown) => {
  const user = obj(value);
  const name = str(user.login) || str(user.name) || str(user.display_name) || str(user.displayName);
  return name
    ? { name, avatarUrl: str(user.avatar_url) || str(obj(obj(user.links).avatar).href) }
    : null;
};
const segment = encodeURIComponent;
export const canonicalIssueKey = (ref: IssueRef) =>
  ref.hostKind === "azure-devops"
    ? `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.split("/")[0]!.toLowerCase()}:${ref.id}`
    : `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.toLowerCase()}:${ref.id}`;
const issueFromHost = (scope: IssueHostScope, raw: Record<string, unknown>): IssueDetail => {
  const fields = obj(raw.fields);
  const azure = scope.ref.hostKind === "azure-devops";
  const id = azure ? num(raw.id) : num(raw.number) || num(raw.iid) || num(raw.id);
  const links = obj(raw.links);
  const content = obj(raw.content);
  const ref: IssueRef = {
    ...scope.ref,
    id: String(id),
    number: id,
    url:
      str(raw.html_url) ||
      str(raw.web_url) ||
      str(obj(links.html).href) ||
      (azure
        ? `https://${scope.ref.host}/${scope.ref.repository}/_workitems/edit/${id}`
        : scope.ref.url),
  };
  return {
    ref,
    title: str(raw.title) || str(fields["System.Title"]),
    state: str(raw.state) || str(fields["System.State"]),
    updatedAt: str(raw.updated_at) || str(raw.updated_on) || str(fields["System.ChangedDate"]),
    labels: azure
      ? str(fields["System.Tags"])
          .split(";")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : labels(raw.labels),
    body:
      str(raw.body) ||
      str(raw.description) ||
      str(content.raw) ||
      str(fields["System.Description"]),
    author: actor(raw.user ?? raw.author ?? fields["System.CreatedBy"]),
    assignees: (azure ? [fields["System.AssignedTo"]] : arr(raw.assignees))
      .map(actor)
      .filter((value) => value !== null),
    createdAt: str(raw.created_at) || str(raw.created_on) || str(fields["System.CreatedDate"]),
    hostFields: Object.fromEntries(
      Object.entries(fields).flatMap(([key, value]) =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? [[key, String(value)]]
          : [],
      ),
    ),
  };
};

export const makeIssueHost = (options: {
  readonly gitlab: Pick<GitLabCli["Service"], "execute">;
  readonly azure: Pick<AzureDevOpsCli["Service"], "execute">;
  readonly forgejo: Pick<ForgejoCli["Service"], "api">;
  readonly bitbucket: Pick<BitbucketApi["Service"], "request">;
}) =>
  Effect.gen(function* () {
    const { gitlab, azure, forgejo, bitbucket } = options;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gl = (cwd: string, host: string, endpoint: string) =>
      gitlab
        .execute({
          cwd,
          args: ["api", "--hostname", host, endpoint],
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(
          Effect.map((output) => output.stdout),
          Effect.mapError(remoteError),
        );
    const azCli = (cwd: string, organization: string, args: ReadonlyArray<string>) =>
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
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(
          Effect.map((output) => output.stdout),
          Effect.mapError(remoteError),
        );
    const az = Effect.fnUntraced(function* (
      cwd: string,
      organization: string,
      area: string,
      resource: string,
      route: Record<string, string>,
      query: Record<string, string> = {},
      body?: unknown,
      method = "GET",
      // The CLI parses this as a float after stripping "-preview", so "7.1-preview.4" is rejected.
      apiVersion = "7.1",
    ) {
      const args = [
        "devops",
        "invoke",
        "--area",
        area,
        "--resource",
        resource,
        "--api-version",
        apiVersion,
        "--http-method",
        method,
      ];
      if (Object.keys(route).length)
        args.push(
          "--route-parameters",
          ...Object.entries(route).map(([key, value]) => `${key}=${value}`),
        );
      if (Object.keys(query).length)
        args.push(
          "--query-parameters",
          ...Object.entries(query).map(([key, value]) => `${key}=${value}`),
        );
      return yield* Effect.scoped(
        Effect.gen(function* () {
          if (body !== undefined) {
            const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issues-" });
            const file = path.join(directory, "request.json");
            yield* fs.writeFileString(file, json(body));
            args.push("--in-file", file);
          }
          return yield* azCli(cwd, organization, args);
        }),
      ).pipe(Effect.mapError(remoteError));
    });
    const azureScope = (ref: IssueRef) => {
      const parts = ref.repository.split("/");
      return { organization: parts[0] ?? "", project: parts[1] ?? "" };
    };
    const get = Effect.fn("IssueHost.get")(function* (scope: IssueHostScope) {
      const { ref, cwd } = scope;
      let raw: Record<string, unknown>;
      if (ref.hostKind === "gitlab")
        raw = yield* readRecord(
          yield* gl(cwd, ref.host, `projects/${segment(ref.repository)}/issues/${segment(ref.id)}`),
        );
      else if (ref.hostKind === "forgejo")
        raw = yield* readRecord(
          (yield* forgejo
            .api({
              cwd,
              host: ref.host,
              repository: ref.repository,
              path: `repos/${ref.repository}/issues/${segment(ref.id)}`,
            })
            .pipe(Effect.mapError(remoteError))).stdout,
        );
      else if (ref.hostKind === "bitbucket")
        raw = yield* readRecord(
          (yield* bitbucket
            .request({
              method: "GET",
              url: `repositories/${ref.repository}/issues/${segment(ref.id)}`,
              maxBytes: 4 * 1024 * 1024,
            })
            .pipe(Effect.mapError(remoteError))).body,
        );
      else if (ref.hostKind === "azure-devops") {
        const { organization, project } = azureScope(ref);
        raw = yield* azureWorkItem(cwd, organization, project, ref.id);
      } else
        return yield* new IssueOperationError({
          reason: "unavailable",
          message: "This repository host does not expose issues.",
        });
      yield* validateIssue(scope, raw);
      const detail = issueFromHost(scope, raw);
      const commentEntries: unknown[] = [];
      let page = 1;
      let continuation: string | null = null;
      let more: boolean;
      do {
        let entries: ReadonlyArray<unknown>;
        if (ref.hostKind === "gitlab")
          entries = yield* decode(
            Schema.Array(record),
            yield* gl(
              cwd,
              ref.host,
              `projects/${segment(ref.repository)}/issues/${segment(ref.id)}/notes?per_page=100&page=${page}`,
            ),
          );
        else if (ref.hostKind === "forgejo")
          entries = yield* decode(
            Schema.Array(record),
            (yield* forgejo
              .api({
                cwd,
                host: ref.host,
                repository: ref.repository,
                path: `repos/${ref.repository}/issues/${segment(ref.id)}/comments?limit=100&page=${page}`,
              })
              .pipe(Effect.mapError(remoteError))).stdout,
          );
        else if (ref.hostKind === "bitbucket") {
          const response = yield* readRecord(
            (yield* bitbucket
              .request({
                method: "GET",
                url: `repositories/${ref.repository}/issues/${segment(ref.id)}/comments?pagelen=100&page=${page}`,
              })
              .pipe(Effect.mapError(remoteError))).body,
          );
          entries = (yield* validate(Schema.Struct({ values: Schema.Array(record) }), response))
            .values;
          continuation = str(response.next) || null;
        } else {
          const scope = azureScope(ref);
          const parameters: Record<string, string> = { $top: "100" };
          if (continuation) parameters.continuationToken = continuation;
          const response = yield* readRecord(
            yield* az(
              cwd,
              scope.organization,
              "wit",
              "comments",
              { project: scope.project, workItemId: ref.id },
              parameters,
              undefined,
              "GET",
              "7.1-preview",
            ),
          );
          entries = (yield* validate(Schema.Struct({ comments: Schema.Array(record) }), response))
            .comments;
          continuation = str(response.continuation_token) || null;
        }
        commentEntries.push(...entries);
        more =
          ref.hostKind === "azure-devops" || ref.hostKind === "bitbucket"
            ? continuation !== null
            : entries.length === 100;
        page++;
      } while (more);
      return yield* decodeIssueDetail({
        ...detail,
        comments: commentEntries.map((entry) => {
          const value = obj(entry);
          return {
            id: String(value.id),
            body: str(value.body) || str(value.text) || str(obj(value.content).raw),
            createdAt: str(value.created_at) || str(value.createdDate) || str(value.created_on),
            author: actor(value.user ?? value.author ?? value.createdBy),
          };
        }),
      }).pipe(Effect.mapError(invalid));
    });
    const list = Effect.fn("IssueHost.list")(function* (scope: IssueHostScope, cursor?: string) {
      const { ref, cwd } = scope;
      const page = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 1;
      let entries: ReadonlyArray<unknown>;
      let nextCursor: string | null = null;
      if (ref.hostKind === "gitlab" || ref.hostKind === "forgejo") {
        let text: string;
        if (ref.hostKind === "gitlab")
          text = yield* gl(
            cwd,
            ref.host,
            `projects/${segment(ref.repository)}/issues?per_page=100&page=${page}`,
          );
        else
          text = (yield* forgejo
            .api({
              cwd,
              host: ref.host,
              repository: ref.repository,
              path: `repos/${ref.repository}/issues?state=all&type=issues&limit=100&page=${page}`,
            })
            .pipe(Effect.mapError(remoteError))).stdout;
        entries = yield* decode(Schema.Array(record), text);
        if (entries.length === 100) nextCursor = String(page + 1);
        entries = entries.filter((entry) => obj(entry).pull_request === undefined);
      } else if (ref.hostKind === "bitbucket") {
        const response = yield* readRecord(
          (yield* bitbucket
            .request({
              method: "GET",
              url: `repositories/${ref.repository}/issues?pagelen=100&page=${page}`,
              maxBytes: 4 * 1024 * 1024,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new IssueOperationError({
                    reason: "unavailable",
                    message: `Bitbucket's native issue tracker is unavailable or disabled. ${cause.message}`,
                  }),
              ),
            )).body,
        );
        entries = (yield* validate(Schema.Struct({ values: Schema.Array(record) }), response))
          .values;
        if (str(response.next)) nextCursor = String(page + 1);
      } else if (ref.hostKind === "azure-devops") {
        const { organization, project } = azureScope(ref);
        const after = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
        const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Id] > ${after} ORDER BY [System.Id] ASC`;
        const response = yield* readRecord(
          yield* az(
            cwd,
            organization,
            "wit",
            "wiql",
            { project },
            { $top: "100" },
            { query },
            "POST",
          ),
        );
        const ids = (yield* validate(AzureQueryResponse, response)).workItems.map(
          (entry) => entry.id,
        );
        entries = ids.length ? yield* azureWorkItems(cwd, organization, project, ids) : [];
        if (ids.length === 100) nextCursor = String(ids.at(-1));
      } else
        return yield* new IssueOperationError({
          reason: "unavailable",
          message: "This repository host does not expose issues.",
        });
      const issues = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          yield* validateIssue(scope, entry);
          return yield* decodeIssueSummary(issueFromHost(scope, obj(entry))).pipe(
            Effect.mapError(invalid),
          );
        }),
      );
      return { issues, nextCursor };
    });
    const azureWorkItems = Effect.fnUntraced(function* (
      cwd: string,
      organization: string,
      project: string,
      ids: ReadonlyArray<number>,
    ) {
      const batch = yield* readRecord(
        yield* az(cwd, organization, "wit", "workItemsBatch", { project }, {}, { ids }, "POST"),
      );
      return (yield* validate(AzureWorkItemList, batch)).value;
    });
    const azureWorkItem = Effect.fnUntraced(function* (
      cwd: string,
      organization: string,
      project: string,
      id: string,
    ) {
      const [workItem] = yield* azureWorkItems(cwd, organization, project, [Number(id)]);
      if (!workItem)
        return yield* new IssueOperationError({
          reason: "not-found",
          message: "This work item no longer exists.",
        });
      return workItem;
    });
    const azureBoardMetadata = Effect.fnUntraced(function* (
      cwd: string,
      locator: Extract<IssueBoardLocator, { kind: "azure-board" }>,
    ) {
      const value = yield* readRecord(
        yield* az(cwd, locator.organization, "work", "boards", {
          project: locator.project,
          team: locator.team,
          id: locator.boardId,
        }),
      );
      yield* validate(AzureBoardResponse, value);
      return value;
    });
    const azureBoard = Effect.fnUntraced(function* (
      cwd: string,
      locator: Extract<IssueBoardLocator, { kind: "azure-board" }>,
    ) {
      const metadata = yield* azureBoardMetadata(cwd, locator);
      const team = yield* readRecord(
        yield* az(cwd, locator.organization, "work", "teamfieldvalues", {
          project: locator.project,
          team: locator.team,
        }),
      );
      yield* validate(AzureTeamResponse, team);
      const columns = arr(metadata.columns).map(obj);
      const types = [
        ...new Set(columns.flatMap((column) => Object.keys(obj(column.stateMappings)))),
      ];
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
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
      const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN (${types.map(quote).join(",")}) AND (${areaQuery}) ORDER BY [System.Id] ASC`;
      const response = yield* readRecord(
        yield* az(
          cwd,
          locator.organization,
          "wit",
          "wiql",
          { project: locator.project },
          {},
          { query },
          "POST",
        ),
      );
      const ids = (yield* validate(AzureQueryResponse, response)).workItems.map(
        (entry) => entry.id,
      );
      const columnField = str(obj(obj(metadata.fields).columnField).referenceName);
      if (!columnField)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Azure did not expose this board's column field.",
        });
      const entries: unknown[] = [];
      for (let offset = 0; offset < ids.length; offset += 200) {
        entries.push(
          ...(yield* azureWorkItems(
            cwd,
            locator.organization,
            locator.project,
            ids.slice(offset, offset + 200),
          )),
        );
      }
      const items = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const raw = obj(entry);
          const fields = obj(raw.fields);
          yield* validate(AzureIssueResponse, raw);
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
          const column = columns.find((column) => column.name === fields[columnField]);
          return {
            issue: issueFromHost(scope, raw),
            itemId: String(num(raw.id)),
            columnId: column ? str(column.id) : null,
            version: String(num(raw.rev)),
          };
        }),
      );
      return {
        title: str(metadata.name),
        locator,
        columns: columns.map((column) => ({ id: str(column.id), title: str(column.name) })),
        items,
      };
    });
    const loadBoards = Effect.fn("IssueHost.listBoards")(function* (scope: IssueHostScope) {
      const { ref, cwd } = scope;
      {
        const { organization } = azureScope(ref);
        const named = Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String });
        const namedList = Schema.Struct({ value: Schema.Array(named) });
        const pageSize = 100;
        const projects: { id: string; name: string }[] = [];
        for (let skip = 0; ; skip += pageSize) {
          const output = yield* azCli(cwd, organization, [
            "devops",
            "project",
            "list",
            "--top",
            String(pageSize),
            "--skip",
            String(skip),
          ]);
          const page = yield* validate(namedList, yield* readRecord(output));
          projects.push(...page.value);
          if (page.value.length < pageSize) break;
        }
        // Bound organization-wide discovery even when the read transport uses HTTP.
        const results = yield* Effect.forEach(
          projects,
          (project) =>
            Effect.gen(function* () {
              const teams: { id: string; name: string }[] = [];
              for (let skip = 0; ; skip += pageSize) {
                const output = yield* azCli(cwd, organization, [
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
                const page = yield* validate(Schema.Array(named), yield* readJson(output));
                teams.push(...page);
                if (page.length < pageSize) break;
              }
              const boards = yield* Effect.forEach(
                teams,
                (team) =>
                  Effect.gen(function* () {
                    const response = yield* validate(
                      namedList,
                      yield* readRecord(
                        yield* az(cwd, organization, "work", "boards", {
                          project: project.id,
                          team: team.id,
                        }),
                      ),
                    );
                    return response.value.map(
                      (board) =>
                        ({
                          title: `${project.name} / ${team.name} / ${board.name}`,
                          locator: {
                            kind: "azure-board",
                            host: ref.host,
                            organization,
                            project: project.name,
                            team: team.id,
                            boardId: board.id,
                          },
                        }) satisfies { title: string; locator: IssueBoardLocator },
                    );
                  }),
                { concurrency: 3 },
              );
              return boards.flat();
            }),
          { concurrency: 3 },
        );
        return results.flat();
      }
    });
    const azureBoards = yield* Cache.makeWith(
      (key: AzureBoardsKey) =>
        loadBoards({
          cwd: key.cwd,
          ref: {
            hostKind: "azure-devops",
            host: key.host,
            repository: key.organization,
            id: "0",
            number: 0,
            url: "",
          },
        }).pipe(Effect.provideService(CredentialScope, key.credentialScope)),
      {
        capacity: 32,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(60) : Duration.zero),
      },
    );
    const listBoards = (scope: IssueHostScope) =>
      Effect.gen(function* () {
        const credentialScope = yield* CredentialScope;
        return yield* Cache.get(
          azureBoards,
          new AzureBoardsKey({
            cwd: scope.cwd,
            host: scope.ref.host,
            organization: azureScope(scope.ref).organization,
            credentialScope,
          }),
        );
      });
    const move = Effect.fn("IssueHost.move")(function* (
      cwd: string,
      locator: AzureBoardLocator,
      item: IssueBoardItem,
      columnId: string,
    ) {
      const [metadata, workItem] = yield* Effect.all(
        [
          azureBoardMetadata(cwd, locator),
          azureWorkItem(cwd, locator.organization, locator.project, item.issue.ref.id),
        ],
        { concurrency: 2 },
      );
      const column = arr(metadata.columns)
        .map(obj)
        .find((column) => column.id === columnId);
      if (!column)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "The selected Azure board column no longer exists.",
        });
      yield* validate(AzureIssueResponse, workItem);
      const fields = obj(workItem.fields);
      const state = str(obj(column.stateMappings)[str(fields["System.WorkItemType"])]);
      const columnField = str(obj(obj(metadata.fields).columnField).referenceName);
      if (!state || !columnField)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "The selected column does not map this work item type.",
        });
      const doneField = str(obj(obj(metadata.fields).doneField).referenceName);
      yield* azCli(cwd, locator.organization, [
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
    });
    return { list, get, listBoards, board: azureBoard, move };
  });

const readOnlyKinds = ["gitlab", "forgejo", "bitbucket"] as const;
const fallbackAdapters = (host: Effect.Success<ReturnType<typeof makeIssueHost>>) => [
  ...readOnlyKinds.map((kind): IssueHostAdapter => ({ kind, list: host.list, get: host.get })),
  {
    kind: "azure-devops",
    list: host.list,
    get: host.get,
    boards: {
      locatorKind: "azure-board",
      list: host.listBoards,
      read: host.board,
      move: host.move,
    },
  } satisfies IssueHostAdapter,
];

export class IssueHost extends Context.Service<
  IssueHost,
  {
    /** Null for a host kind with no adapter, which the issue service reports as unavailable. */
    readonly forHost: (kind: SourceControlProviderKind) => IssueHostAdapter | null;
    readonly forBoard: (locator: IssueBoardLocator) => IssueHostBoards | null;
  }
>()("t3/issues/IssueHost") {}

/** Exported for tests, which stand a registry up from adapters they supply themselves. */
export function fromAdapters(adapters: ReadonlyArray<IssueHostAdapter>): IssueHost["Service"] {
  const byKind = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  // Each group only receives locators of the kind it declared, which is what the cast relies on.
  const byLocator = new Map(
    adapters.flatMap((adapter) =>
      adapter.boards
        ? [[adapter.boards.locatorKind, adapter.boards as IssueHostBoards] as const]
        : [],
    ),
  );
  return {
    forHost: (kind) => byKind.get(kind) ?? null,
    forBoard: (locator) => byLocator.get(locator.kind) ?? null,
  };
}

const make = Effect.gen(function* () {
  const github = yield* GitHubIssueHost.make;
  const fallback = yield* makeIssueHost({
    gitlab: yield* GitLabCli,
    azure: yield* AzureDevOpsCli,
    forgejo: yield* ForgejoCli,
    bitbucket: yield* BitbucketApi,
  });
  return fromAdapters([github, ...fallbackAdapters(fallback)]);
});
export const layer = Layer.effect(IssueHost, make);
