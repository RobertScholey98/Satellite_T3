import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
  type IssueBoardColumn,
  type IssueBoardItem,
  type IssuesListResult,
} from "@t3tools/contracts";
import { GitHubCli } from "../sourceControl/GitHubCli.ts";
import { GitLabCli } from "../sourceControl/GitLabCli.ts";
import { AzureDevOpsCli } from "../sourceControl/AzureDevOpsCli.ts";
import { ForgejoCli } from "../sourceControl/ForgejoCli.ts";
import { BitbucketApi } from "../sourceControl/BitbucketApi.ts";

export interface IssueHostScope {
  readonly cwd: string;
  readonly ref: IssueRef;
}
export interface RemoteIssueBoard {
  readonly title: string;
  readonly locator: IssueBoardLocator;
  readonly columns: ReadonlyArray<IssueBoardColumn>;
  readonly items: ReadonlyArray<IssueBoardItem>;
}
export interface IssueHostShape {
  readonly list: (
    scope: IssueHostScope,
    cursor?: string,
  ) => Effect.Effect<IssuesListResult, IssueOperationError>;
  readonly get: (scope: IssueHostScope) => Effect.Effect<IssueDetail, IssueOperationError>;
  readonly listBoards: (
    scope: IssueHostScope,
  ) => Effect.Effect<
    ReadonlyArray<{ title: string; locator: IssueBoardLocator }>,
    IssueOperationError
  >;
  readonly board: (
    cwd: string,
    locator: IssueBoardLocator,
  ) => Effect.Effect<RemoteIssueBoard, IssueOperationError>;
  readonly move: (
    cwd: string,
    locator: IssueBoardLocator,
    item: IssueBoardItem,
    columnId: string,
  ) => Effect.Effect<void, IssueOperationError>;
}
export class IssueHost extends Context.Service<IssueHost, IssueHostShape>()(
  "t3/issues/IssueHost",
) {}
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
const GithubProjectResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  fields: Schema.Struct({ nodes: Schema.Array(record) }),
});
const GithubFieldResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  options: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String })),
});
const GithubProjectIssueResponse = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updatedAt: Schema.String,
  url: TrimmedNonEmptyString,
  repository: Schema.Struct({ nameWithOwner: TrimmedNonEmptyString }),
  labels: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) }),
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
const GraphqlConnection = Schema.Struct({
  nodes: Schema.Array(record),
  pageInfo: Schema.Struct({
    hasNextPage: Schema.Boolean,
    endCursor: Schema.NullOr(Schema.String),
  }),
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
const isRecord = Schema.is(record);
const isArray = Schema.is(Schema.Array(Schema.Unknown));
const decodeIssueDetail = Schema.decodeEffect(IssueDetail);
const decodeIssueSummary = Schema.decodeEffect(IssueSummary);
const readRecord = (text: string) => decodeRecordJson(text).pipe(Effect.mapError(invalid));
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
export const issueFromHost = (scope: IssueHostScope, raw: Record<string, unknown>): IssueDetail => {
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
  readonly github: Pick<GitHubCli["Service"], "execute">;
  readonly gitlab: Pick<GitLabCli["Service"], "execute">;
  readonly azure: Pick<AzureDevOpsCli["Service"], "execute">;
  readonly forgejo: Pick<ForgejoCli["Service"], "api">;
  readonly bitbucket: Pick<BitbucketApi["Service"], "request">;
}) =>
  Effect.gen(function* () {
    const { github, gitlab, azure, forgejo, bitbucket } = options;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gh = (cwd: string, host: string, args: ReadonlyArray<string>, stdin?: string) =>
      github
        .execute({
          cwd,
          args: ["api", "--hostname", host, ...args],
          ...(stdin === undefined ? {} : { stdin }),
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(
          Effect.map((output) => output.stdout),
          Effect.mapError(remoteError),
        );
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
    const az = Effect.fnUntraced(function* (
      cwd: string,
      organization: string,
      area: string,
      resource: string,
      route: Record<string, string>,
      query: Record<string, string> = {},
      body?: unknown,
      method = "GET",
      apiVersion = "7.1",
    ) {
      const args = [
        "devops",
        "invoke",
        "--organization",
        `https://dev.azure.com/${segment(organization)}`,
        "--area",
        area,
        "--resource",
        resource,
        "--api-version",
        apiVersion,
        "--http-method",
        method,
        "--only-show-errors",
        "--output",
        "json",
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
            if (method === "PATCH") args.push("--media-type", "application/json-patch+json");
          }
          return (yield* azure.execute({ cwd, args, maxOutputBytes: 4 * 1024 * 1024 })).stdout;
        }),
      ).pipe(Effect.mapError(remoteError));
    });
    const graphql = Effect.fnUntraced(function* (
      cwd: string,
      host: string,
      query: string,
      variables: Record<string, unknown>,
    ) {
      const response = yield* readRecord(
        yield* gh(cwd, host, ["graphql", "--input", "-"], json({ query, variables })),
      );
      if (arr(response.errors).length)
        return yield* new IssueOperationError({
          reason: "remote",
          message:
            "GitHub Project access failed. Check project permissions and authenticate gh with the project scope.",
        });
      yield* validate(Schema.Struct({ data: record }), response);
      return obj(response.data);
    });
    const azureScope = (ref: IssueRef) => {
      const parts = ref.repository.split("/");
      return { organization: parts[0] ?? "", project: parts[1] ?? "" };
    };
    const get: IssueHostShape["get"] = Effect.fn("IssueHost.get")(function* (scope) {
      const { ref, cwd } = scope;
      let text: string;
      if (ref.hostKind === "github")
        text = yield* gh(cwd, ref.host, [`repos/${ref.repository}/issues/${segment(ref.id)}`]);
      else if (ref.hostKind === "gitlab")
        text = yield* gl(
          cwd,
          ref.host,
          `projects/${segment(ref.repository)}/issues/${segment(ref.id)}`,
        );
      else if (ref.hostKind === "forgejo")
        text = (yield* forgejo
          .api({
            cwd,
            host: ref.host,
            repository: ref.repository,
            path: `repos/${ref.repository}/issues/${segment(ref.id)}`,
          })
          .pipe(Effect.mapError(remoteError))).stdout;
      else if (ref.hostKind === "bitbucket")
        text = (yield* bitbucket
          .request({
            method: "GET",
            url: `repositories/${ref.repository}/issues/${segment(ref.id)}`,
            maxBytes: 4 * 1024 * 1024,
          })
          .pipe(Effect.mapError(remoteError))).body;
      else if (ref.hostKind === "azure-devops") {
        const scope = azureScope(ref);
        text = yield* az(cwd, scope.organization, "wit", "workitems", {
          project: scope.project,
          id: ref.id,
        });
      } else
        return yield* new IssueOperationError({
          reason: "unavailable",
          message: "This repository host does not expose issues.",
        });
      const raw = yield* readRecord(text);
      yield* validateIssue(scope, raw);
      const detail = issueFromHost(scope, raw);
      const commentEntries: unknown[] = [];
      let page = 1;
      let continuation: string | null = null;
      let more: boolean;
      do {
        let entries: ReadonlyArray<unknown>;
        if (ref.hostKind === "github")
          entries = yield* decode(
            Schema.Array(record),
            yield* gh(cwd, ref.host, [
              `repos/${ref.repository}/issues/${segment(ref.id)}/comments?per_page=100&page=${page}`,
            ]),
          );
        else if (ref.hostKind === "gitlab")
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
              "7.1-preview.4",
            ),
          );
          entries = (yield* validate(Schema.Struct({ comments: Schema.Array(record) }), response))
            .comments;
          continuation = str(response.continuationToken) || null;
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
    const list: IssueHostShape["list"] = Effect.fn("IssueHost.list")(function* (scope, cursor) {
      const { ref, cwd } = scope;
      const page = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 1;
      let entries: ReadonlyArray<unknown>;
      let nextCursor: string | null = null;
      if (ref.hostKind === "github" || ref.hostKind === "gitlab" || ref.hostKind === "forgejo") {
        let text: string;
        if (ref.hostKind === "github")
          text = yield* gh(cwd, ref.host, [
            `repos/${ref.repository}/issues?state=all&per_page=100&page=${page}`,
          ]);
        else if (ref.hostKind === "gitlab")
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
        entries = ids.length
          ? (yield* validate(
              AzureWorkItemList,
              yield* readRecord(
                yield* az(
                  cwd,
                  organization,
                  "wit",
                  "workitems",
                  { project },
                  { ids: ids.join(",") },
                ),
              ),
            )).value
          : [];
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
    const githubBoard = Effect.fnUntraced(function* (
      cwd: string,
      locator: Extract<IssueBoardLocator, { kind: "github-project" }>,
    ) {
      const ownerQuery = locator.ownerKind === "organization" ? "organization" : "user";
      const data = yield* graphql(
        cwd,
        locator.host,
        `query($owner:String!,$number:Int!){ ${ownerQuery}(login:$owner){projectV2(number:$number){id title fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`,
        { owner: locator.owner, number: locator.projectNumber },
      );
      const project = obj(obj(data[ownerQuery]).projectV2);
      yield* validate(GithubProjectResponse, project);
      const fields = arr(obj(project.fields).nodes).map(obj);
      const field = locator.statusFieldId
        ? fields.find((value) => value.id === locator.statusFieldId)
        : fields.find((value) => value.name === "Status");
      if (!str(project.id) || !field)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Choose an existing GitHub Project with a single-select Status field.",
        });
      yield* validate(GithubFieldResponse, field);
      const resolved = { ...locator, projectNodeId: str(project.id), statusFieldId: str(field.id) };
      const columns = arr(field.options).map((option) => ({
        id: str(obj(option).id),
        title: str(obj(option).name),
      }));
      const items: IssueBoardItem[] = [];
      let cursor: string | null = null;
      do {
        const page = yield* graphql(
          cwd,
          locator.host,
          `
            query ($id: ID!, $cursor: String) {
              node(id: $id) {
                ... on ProjectV2 {
                  items(first: 100, after: $cursor) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      id
                      updatedAt
                      content {
                        __typename
                        ... on Issue {
                          id
                          number
                          title
                          body
                          state
                          updatedAt
                          url
                          repository {
                            nameWithOwner
                          }
                          labels(first: 100) {
                            nodes {
                              name
                            }
                          }
                        }
                      }
                      fieldValues(first: 100) {
                        nodes {
                          ... on ProjectV2ItemFieldSingleSelectValue {
                            optionId
                            field {
                              ... on ProjectV2SingleSelectField {
                                id
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          { id: project.id, cursor },
        );
        const connection = obj(obj(page.node).items);
        yield* validate(GraphqlConnection, connection);
        for (const value of arr(connection.nodes)) {
          const item = obj(value);
          const issue = obj(item.content);
          if (issue.__typename !== "Issue") continue;
          yield* validate(GithubProjectIssueResponse, issue);
          yield* validate(
            Schema.Struct({
              id: TrimmedNonEmptyString,
              updatedAt: Schema.String,
              fieldValues: Schema.Struct({ nodes: Schema.Array(record) }),
            }),
            item,
          );
          const selectedValue = arr(obj(item.fieldValues).nodes)
            .map(obj)
            .find((entry) => obj(entry.field).id === field.id);
          items.push({
            itemId: str(item.id),
            columnId: selectedValue ? str(selectedValue.optionId) || null : null,
            version: str(item.updatedAt) || null,
            issue: {
              ref: {
                hostKind: "github",
                host: locator.host,
                repository: str(obj(issue.repository).nameWithOwner),
                id: String(issue.number),
                number: num(issue.number),
                url: str(issue.url),
              },
              title: str(issue.title),
              state: str(issue.state).toLowerCase(),
              updatedAt: str(issue.updatedAt),
              labels: labels(obj(issue.labels).nodes),
            },
          });
        }
        const pageInfo = obj(connection.pageInfo);
        cursor = pageInfo.hasNextPage === true ? str(pageInfo.endCursor) || null : null;
      } while (cursor);
      return { title: str(project.title), locator: resolved, columns, items };
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
        const batch = yield* readRecord(
          yield* az(
            cwd,
            locator.organization,
            "wit",
            "workitems",
            { project: locator.project },
            { ids: ids.slice(offset, offset + 200).join(",") },
          ),
        );
        entries.push(...(yield* validate(AzureWorkItemList, batch)).value);
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
    const board: IssueHostShape["board"] = (cwd, locator) =>
      locator.kind === "github-project" ? githubBoard(cwd, locator) : azureBoard(cwd, locator);
    const listBoards: IssueHostShape["listBoards"] = Effect.fn("IssueHost.listBoards")(
      function* (scope) {
        const { ref, cwd } = scope;
        if (ref.hostKind === "github") {
          const owner = ref.repository.split("/")[0]!;
          const account = yield* readRecord(yield* gh(cwd, ref.host, [`users/${segment(owner)}`]));
          const ownerKind =
            str(account.type) === "Organization" ? ("organization" as const) : ("user" as const);
          const results: { title: string; locator: IssueBoardLocator }[] = [];
          let cursor: string | null = null;
          do {
            const data = yield* graphql(
              cwd,
              ref.host,
              `query($owner:String!,$cursor:String){${ownerKind}(login:$owner){projectsV2(first:100,after:$cursor){nodes{id title number} pageInfo{hasNextPage endCursor}}}}`,
              { owner, cursor },
            );
            const connection = obj(obj(data[ownerKind]).projectsV2);
            yield* validate(GraphqlConnection, connection);
            for (const entry of arr(connection.nodes)) {
              const project = obj(entry);
              yield* validate(
                Schema.Struct({
                  id: TrimmedNonEmptyString,
                  title: Schema.String,
                  number: PositiveInt,
                }),
                project,
              );
              results.push({
                title: str(project.title),
                locator: {
                  kind: "github-project",
                  host: ref.host,
                  owner,
                  ownerKind,
                  projectNumber: num(project.number),
                  projectNodeId: str(project.id),
                },
              });
            }
            const page = obj(connection.pageInfo);
            cursor = page.hasNextPage === true ? str(page.endCursor) || null : null;
          } while (cursor);
          return results;
        }
        if (ref.hostKind === "azure-devops") {
          const { organization, project } = azureScope(ref);
          const teams = yield* readRecord(
            yield* az(cwd, organization, "core", "teams", { projectId: project }),
          );
          yield* validate(
            Schema.Struct({
              value: Schema.Array(
                Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String }),
              ),
            }),
            teams,
          );
          const results: { title: string; locator: IssueBoardLocator }[] = [];
          for (const value of arr(teams.value)) {
            const team = obj(value);
            const response = yield* readRecord(
              yield* az(cwd, organization, "work", "boards", { project, team: str(team.id) }),
            );
            yield* validate(
              Schema.Struct({
                value: Schema.Array(
                  Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String }),
                ),
              }),
              response,
            );
            for (const value of arr(response.value)) {
              const board = obj(value);
              results.push({
                title: `${str(team.name)} / ${str(board.name)}`,
                locator: {
                  kind: "azure-board",
                  host: ref.host,
                  organization,
                  project,
                  team: str(team.id),
                  boardId: str(board.id),
                },
              });
            }
          }
          return results;
        }
        return yield* new IssueOperationError({
          reason: "unavailable",
          message:
            "Boards are supported for GitHub Projects and Azure DevOps. This host supports issue listing only.",
        });
      },
    );
    const move: IssueHostShape["move"] = Effect.fn("IssueHost.move")(
      function* (cwd, locator, item, columnId) {
        if (locator.kind === "github-project") {
          if (!locator.projectNodeId || !locator.statusFieldId)
            return yield* new IssueOperationError({
              reason: "invalid",
              message: "Reconnect this GitHub Project to select its Status field.",
            });
          yield* graphql(
            cwd,
            locator.host,
            `
              mutation ($project: ID!, $item: ID!, $field: ID!, $option: String!) {
                updateProjectV2ItemFieldValue(
                  input: {
                    projectId: $project
                    itemId: $item
                    fieldId: $field
                    value: { singleSelectOptionId: $option }
                  }
                ) {
                  projectV2Item {
                    id
                  }
                }
              }
            `,
            {
              project: locator.projectNodeId,
              item: item.itemId,
              field: locator.statusFieldId,
              option: columnId,
            },
          );
          return;
        }
        const metadata = yield* azureBoardMetadata(cwd, locator);
        const column = arr(metadata.columns)
          .map(obj)
          .find((column) => column.id === columnId);
        if (!column)
          return yield* new IssueOperationError({
            reason: "invalid",
            message: "The selected Azure board column no longer exists.",
          });
        const workItem = yield* readRecord(
          yield* az(cwd, locator.organization, "wit", "workitems", {
            project: locator.project,
            id: item.issue.ref.id,
          }),
        );
        yield* validate(AzureIssueResponse, workItem);
        const fields = obj(workItem.fields);
        const state = str(obj(column.stateMappings)[str(fields["System.WorkItemType"])]);
        const columnField = str(obj(obj(metadata.fields).columnField).referenceName);
        if (!state || !columnField)
          return yield* new IssueOperationError({
            reason: "invalid",
            message: "The selected column does not map this work item type.",
          });
        const patch: { op: string; path: string; value: unknown }[] = [
          { op: "test", path: "/rev", value: num(workItem.rev) },
          { op: "add", path: "/fields/System.State", value: state },
          { op: "add", path: `/fields/${columnField}`, value: str(column.name) },
        ];
        const doneField = str(obj(obj(metadata.fields).doneField).referenceName);
        if (doneField) patch.push({ op: "add", path: `/fields/${doneField}`, value: false });
        yield* az(
          cwd,
          locator.organization,
          "wit",
          "workitems",
          { project: locator.project, id: item.issue.ref.id },
          {},
          patch,
          "PATCH",
        );
      },
    );
    return { list, get, listBoards, board, move } satisfies IssueHostShape;
  });
export const make = Effect.gen(function* () {
  return yield* makeIssueHost({
    github: yield* GitHubCli,
    gitlab: yield* GitLabCli,
    azure: yield* AzureDevOpsCli,
    forgejo: yield* ForgejoCli,
    bitbucket: yield* BitbucketApi,
  });
});
export const layer = Layer.effect(IssueHost, make);
