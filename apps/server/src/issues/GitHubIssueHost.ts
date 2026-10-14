import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IssueOperationError,
  PositiveInt,
  TrimmedNonEmptyString,
  type IssueBoardItem,
  type IssueBoardLocator,
  type IssueDetail,
} from "@t3tools/contracts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import {
  ISSUE_RESPONSE_LIMIT_BYTES,
  JsonRecord,
  arr,
  decodeHostJson,
  labelNames,
  num,
  obj,
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

type ProjectLocator = Extract<IssueBoardLocator, { kind: "github-project" }>;

const GitHubIssue = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updated_at: Schema.String,
  html_url: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
});
const GitHubProject = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  fields: Schema.Struct({ nodes: Schema.Array(JsonRecord) }),
});
const GitHubStatusField = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  options: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String })),
});
const GitHubProjectItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  updatedAt: Schema.String,
  fieldValues: Schema.Struct({ nodes: Schema.Array(JsonRecord) }),
});
const GitHubProjectIssue = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updatedAt: Schema.String,
  url: TrimmedNonEmptyString,
  repository: Schema.Struct({ nameWithOwner: TrimmedNonEmptyString }),
  labels: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) }),
});
const GitHubProjectSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  number: PositiveInt,
});
const GraphqlConnection = Schema.Struct({
  nodes: Schema.Array(JsonRecord),
  pageInfo: Schema.Struct({
    hasNextPage: Schema.Boolean,
    endCursor: Schema.NullOr(Schema.String),
  }),
});

const actor = (value: unknown) => {
  const user = obj(value);
  const name = str(user.login);
  if (!name) return null;
  const avatarUrl = str(user.avatar_url);
  return avatarUrl ? { name, avatarUrl } : { name };
};
const toIssue = (scope: IssueHostScope, raw: Record<string, unknown>): IssueDetail => ({
  ref: {
    ...scope.ref,
    id: String(num(raw.number)),
    number: num(raw.number),
    url: str(raw.html_url) || scope.ref.url,
  },
  title: str(raw.title),
  state: str(raw.state),
  updatedAt: str(raw.updated_at),
  labels: labelNames(raw.labels),
  body: str(raw.body),
  author: actor(raw.user),
  assignees: arr(raw.assignees)
    .map(actor)
    .filter((value) => value !== null),
  createdAt: str(raw.created_at),
});
const nextCursor = (pageInfo: unknown) => {
  const page = obj(pageInfo);
  return page.hasNextPage === true ? str(page.endCursor) || null : null;
};

const PROJECT_ITEMS_QUERY = `
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
`;
const MOVE_ITEM_MUTATION = `
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
`;

export const make = Effect.gen(function* () {
  const github = yield* GitHubApi.GitHubApi;
  const rest = (host: string, path: string) =>
    github
      .rest({
        host,
        operation: "IssueHost.read",
        path,
        maxResponseBytes: ISSUE_RESPONSE_LIMIT_BYTES,
      })
      .pipe(
        Effect.mapError(remoteIssueError),
        Effect.flatMap((response) =>
          response.truncated
            ? Effect.fail(
                new IssueOperationError({
                  reason: "remote",
                  message: "The GitHub response exceeded the issue response limit.",
                }),
              )
            : Effect.succeed(response.body),
        ),
      );
  const graphql = (host: string, query: string, variables: Record<string, unknown>) =>
    github
      .graphql({
        host,
        operation: "IssueHost.graphql",
        query,
        variables,
        maxResponseBytes: ISSUE_RESPONSE_LIMIT_BYTES,
      })
      .pipe(
        Effect.mapError(remoteIssueError),
        Effect.flatMap(readRecord),
        Effect.flatMap((response) => validate(Schema.Struct({ data: JsonRecord }), response)),
        Effect.map((response) => response.data),
      );

  const list: IssueHostAdapter["list"] = Effect.fn("GitHubIssueHost.list")(
    function* (scope, cursor) {
      const { ref } = scope;
      const page = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 1;
      const entries = yield* decodeHostJson(
        Schema.Array(JsonRecord),
        yield* rest(ref.host, `repos/${ref.repository}/issues?state=all&per_page=100&page=${page}`),
      );
      const issues = yield* Effect.forEach(
        entries.filter((entry) => entry.pull_request === undefined),
        (entry) =>
          validate(GitHubIssue, entry).pipe(
            Effect.flatMap(() => toIssueSummary(toIssue(scope, entry))),
          ),
      );
      return { issues, nextCursor: entries.length === 100 ? String(page + 1) : null };
    },
  );

  const get: IssueHostAdapter["get"] = Effect.fn("GitHubIssueHost.get")(function* (scope) {
    const { ref } = scope;
    const issuePath = `repos/${ref.repository}/issues/${segment(ref.id)}`;
    const raw = yield* readRecord(yield* rest(ref.host, issuePath));
    yield* validate(GitHubIssue, raw);
    const comments: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const entries = yield* decodeHostJson(
        Schema.Array(JsonRecord),
        yield* rest(ref.host, `${issuePath}/comments?per_page=100&page=${page}`),
      );
      comments.push(...entries);
      if (entries.length !== 100) break;
    }
    return yield* toIssueDetail({
      ...toIssue(scope, raw),
      comments: comments.map((comment) => ({
        id: String(comment.id),
        body: str(comment.body),
        createdAt: str(comment.created_at),
        author: actor(comment.user),
      })),
    });
  });

  const listBoards: IssueHostBoards<"github-project">["list"] = Effect.fn(
    "GitHubIssueHost.listBoards",
  )(function* ({ ref }) {
    const owner = ref.repository.split("/")[0]!;
    const account = yield* readRecord(yield* rest(ref.host, `users/${segment(owner)}`));
    const ownerKind =
      str(account.type) === "Organization" ? ("organization" as const) : ("user" as const);
    const boards: DiscoveredIssueBoard[] = [];
    let cursor: string | null = null;
    do {
      const data = yield* graphql(
        ref.host,
        `query($owner:String!,$cursor:String){${ownerKind}(login:$owner){projectsV2(first:100,after:$cursor){nodes{id title number} pageInfo{hasNextPage endCursor}}}}`,
        { owner, cursor },
      );
      const connection = yield* validate(GraphqlConnection, obj(obj(data[ownerKind]).projectsV2));
      for (const entry of connection.nodes) {
        const project = yield* validate(GitHubProjectSummary, entry);
        boards.push({
          title: project.title,
          locator: {
            kind: "github-project",
            host: ref.host,
            owner,
            ownerKind,
            projectNumber: project.number,
            projectNodeId: project.id,
          },
        });
      }
      cursor = nextCursor(connection.pageInfo);
    } while (cursor);
    return boards;
  });

  const read: IssueHostBoards<"github-project">["read"] = Effect.fn("GitHubIssueHost.board")(
    function* (_cwd, locator: ProjectLocator) {
      const ownerQuery = locator.ownerKind === "organization" ? "organization" : "user";
      const data = yield* graphql(
        locator.host,
        `query($owner:String!,$number:Int!){ ${ownerQuery}(login:$owner){projectV2(number:$number){id title fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`,
        { owner: locator.owner, number: locator.projectNumber },
      );
      const project = yield* validate(GitHubProject, obj(obj(data[ownerQuery]).projectV2));
      const candidate = locator.statusFieldId
        ? project.fields.nodes.find((value) => value.id === locator.statusFieldId)
        : project.fields.nodes.find((value) => value.name === "Status");
      if (!candidate)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Choose an existing GitHub Project with a single-select Status field.",
        });
      const field = yield* validate(GitHubStatusField, candidate);
      const items: IssueBoardItem[] = [];
      let cursor: string | null = null;
      do {
        const page = yield* graphql(locator.host, PROJECT_ITEMS_QUERY, { id: project.id, cursor });
        const connection = yield* validate(GraphqlConnection, obj(obj(page.node).items));
        for (const node of connection.nodes) {
          const content = obj(node.content);
          if (content.__typename !== "Issue") continue;
          const issue = yield* validate(GitHubProjectIssue, content);
          const item = yield* validate(GitHubProjectItem, node);
          const selected = item.fieldValues.nodes.find((entry) => obj(entry.field).id === field.id);
          items.push({
            itemId: item.id,
            columnId: selected ? str(selected.optionId) || null : null,
            version: item.updatedAt || null,
            issue: {
              ref: {
                hostKind: "github",
                host: locator.host,
                repository: issue.repository.nameWithOwner,
                id: String(issue.number),
                number: issue.number,
                url: issue.url,
              },
              title: issue.title,
              state: issue.state.toLowerCase(),
              updatedAt: issue.updatedAt,
              labels: issue.labels.nodes.map((label) => label.name).filter(Boolean),
            },
          });
        }
        cursor = nextCursor(connection.pageInfo);
      } while (cursor);
      return {
        title: project.title,
        locator: { ...locator, projectNodeId: project.id, statusFieldId: field.id },
        columns: field.options.map((option) => ({ id: option.id, title: option.name })),
        items,
      };
    },
  );

  const move: IssueHostBoards<"github-project">["move"] = Effect.fn("GitHubIssueHost.move")(
    function* (_cwd, locator: ProjectLocator, item, columnId) {
      if (!locator.projectNodeId || !locator.statusFieldId)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Reconnect this GitHub Project to select its Status field.",
        });
      yield* graphql(locator.host, MOVE_ITEM_MUTATION, {
        project: locator.projectNodeId,
        item: item.itemId,
        field: locator.statusFieldId,
        option: columnId,
      });
    },
  );

  return {
    kind: "github",
    list,
    get,
    boards: { locatorKind: "github-project", list: listBoards, read, move },
  } satisfies IssueHostAdapter;
});
