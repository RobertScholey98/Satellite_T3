import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { GraphQLClient, GraphQLClientError } from "effect/graphql";
import {
  IssueBoardItem,
  IssueOperationError,
  PositiveInt,
  SourceControlProviderKind,
  TrimmedNonEmptyString,
  type IssueBoardLocator,
  type IssueDetail,
} from "@t3tools/contracts";
import {
  ISSUE_RESPONSE_LIMIT_BYTES,
  JsonRecord,
  arr,
  decodeHostJson,
  labelNames,
  num,
  obj,
  readRecord,
  segment,
  str,
  toIssueDetail,
  toIssueSummary,
  validate,
  type IssueHostAdapter,
  type IssueHostBoards,
  type IssueHostScope,
} from "@t3tools/source-control-core/server/IssueHostAdapter";

import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";
import { ProjectBoardsGraphQLGroup, type ProjectIssueItem } from "./projectBoards.graphql.ts";

type ProjectLocator = Extract<IssueBoardLocator, { kind: "github-project" }>;
type GitHubFailure =
  | GitHubRequestPolicy.GitHubApiError
  | GraphQLClientError.GraphQLClientError
  | IssueOperationError;

const GITHUB = SourceControlProviderKind.make("github");
const PROJECT_SCOPE_MESSAGE =
  "GitHub Projects needs a token with the project scope. Run `gh auth refresh -s project`, or save a token with Project access in Settings, Source control.";

const GitHubIssue = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updated_at: Schema.String,
  html_url: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
});
const GitHubAccount = Schema.Struct({ type: Schema.String });
const BoardItems = Schema.Array(IssueBoardItem);

const invalidIssueData = () =>
  new IssueOperationError({
    reason: "remote",
    message: "The repository host returned invalid issue data.",
  });
const projectScopeError = () =>
  new IssueOperationError({ reason: "authentication", message: PROJECT_SCOPE_MESSAGE });

const mentionsProjectScope = (message: string) =>
  /scope/i.test(message) && /\b(read:)?project\b/.test(message);

/** GitHub answers a token without the Projects scope with HTTP 200 and typed `errors`. */
const lacksProjectScope = (error: GraphQLClientError.GraphQLClientError) =>
  error.reason._tag === "ResponseError" &&
  error.reason.errors.some(
    (entry) => entry["type"] === "INSUFFICIENT_SCOPES" || mentionsProjectScope(entry.message),
  );

/**
 * GraphQL `errors` are GitHub's own answer, so they are lasting: a denied permission is an
 * authentication problem and anything else an invalid request. Only transport and decode
 * failures may heal on a retry.
 */
const graphQlAnswerError = (error: GraphQLClientError.GraphQLClientError) => {
  // Not-found and rate-limit answers keep the client's own mapping.
  if (
    error.reason._tag !== "ResponseError" ||
    GitHubGraphQlClient.isNotFoundOnly(error) ||
    error.reason.errors.some((entry) => entry["type"] === "RATE_LIMITED")
  )
    return null;
  const [first] = error.reason.errors;
  const denied = error.reason.errors.find(
    (entry) => entry["type"] === "FORBIDDEN" || /resource not accessible/i.test(entry.message),
  );
  return denied
    ? new IssueOperationError({
        reason: "authentication",
        message: `GitHub refused this request: ${denied.message}`,
      })
    : new IssueOperationError({
        reason: "invalid",
        message: `GitHub refused this request: ${first.message}`,
      });
};

const toIssueError = (error: GitHubFailure, onProjects: boolean): IssueOperationError => {
  switch (error._tag) {
    case "IssueOperationError":
      return error;
    case "GraphQLClientError":
      return invalidIssueData();
    case "GitHubCliMissingError":
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubCliFailedError":
    case "GitHubApiAuthenticationError":
      return new IssueOperationError({ reason: "authentication", message: error.message });
    case "GitHubApiNotFoundError":
      return new IssueOperationError({ reason: "not-found", message: error.message });
    case "GitHubApiRateLimitError":
    case "GitHubApiRequestError":
    case "SourceControlRateLimitPausedError":
      return new IssueOperationError({ reason: "remote", message: error.message });
    case "GitHubApiResponseError":
      // Projects is the only GitHub API here that a token can be denied by scope.
      if (onProjects && error.status === 403) return projectScopeError();
      return new IssueOperationError({
        reason: error.status >= 500 ? "remote" : "invalid",
        message: error.message,
      });
  }
};

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

type StatusField = { readonly id: string; readonly name: string };
const statusFieldOf =
  (locator: ProjectLocator) =>
  (field: StatusField): boolean =>
    locator.statusFieldId === undefined
      ? field.name === "Status"
      : field.id === locator.statusFieldId;

/** A Project item as a board item, or null when its content is not an issue. */
const toBoardItem = (
  host: string,
  item: ProjectIssueItem,
  isStatusField: (field: StatusField) => boolean,
) => {
  const issue = item.content;
  if (issue?.__typename !== "Issue") return null;
  const [optionId] = (item.fieldValues.nodes ?? []).flatMap((value) =>
    value?.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
    value.field.__typename === "ProjectV2SingleSelectField" &&
    isStatusField(value.field)
      ? [value.optionId]
      : [],
  );
  return {
    itemId: item.id,
    columnId: optionId || null,
    version: item.updatedAt || null,
    issue: {
      ref: {
        hostKind: GITHUB,
        host,
        repository: issue.repository.nameWithOwner,
        id: String(issue.number),
        number: issue.number,
        url: issue.url,
      },
      title: issue.title,
      state: issue.state.toLowerCase(),
      updatedAt: issue.updatedAt,
      labels: (issue.labels?.nodes ?? []).flatMap((label) => (label?.name ? [label.name] : [])),
    },
  };
};

export const make = Effect.gen(function* () {
  const github = yield* GitHubRest.GitHubRest;
  const client = yield* GraphQLClient.make(
    ProjectBoardsGraphQLGroup.middleware(GitHubGraphQlClient.GitHubGraphQlAuth),
  ).pipe(Effect.provide(GitHubGraphQlClient.layer));

  const rest = (host: string, operation: string, path: string) =>
    github.rest({ host, operation, path, maxResponseBytes: ISSUE_RESPONSE_LIMIT_BYTES }).pipe(
      Effect.mapError((error) => toIssueError(error, false)),
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

  /** Runs one generated Projects call (or a paged walk of one) against `host`. */
  const projects =
    (host: string, operation: string) =>
    <A, R>(
      effect: Effect.Effect<
        A,
        GraphQLClientError.GraphQLClientError | GitHubRequestPolicy.GitHubApiError,
        R
      >,
    ) =>
      effect.pipe(
        Effect.mapError((error) =>
          !GraphQLClientError.isGraphQLClientError(error)
            ? error
            : lacksProjectScope(error)
              ? projectScopeError()
              : (graphQlAnswerError(error) ?? error),
        ),
        GitHubGraphQlClient.call({ host, operation, maxResponseBytes: ISSUE_RESPONSE_LIMIT_BYTES }),
        Effect.mapError((error) => toIssueError(error, true)),
      );

  const list: IssueHostAdapter["list"] = Effect.fn("GitHubIssueHost.list")(
    function* (scope, cursor) {
      const { ref } = scope;
      const page = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 1;
      const entries = yield* decodeHostJson(
        Schema.Array(JsonRecord),
        yield* rest(
          ref.host,
          "GitHubIssueHost.list",
          `repos/${ref.repository}/issues?state=all&per_page=100&page=${page}`,
        ),
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
    const raw = yield* readRecord(yield* rest(ref.host, "GitHubIssueHost.get", issuePath));
    yield* validate(GitHubIssue, raw);
    const comments: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const entries = yield* decodeHostJson(
        Schema.Array(JsonRecord),
        yield* rest(
          ref.host,
          "GitHubIssueHost.get",
          `${issuePath}/comments?per_page=100&page=${page}`,
        ),
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
    const operation = "GitHubIssueHost.listBoards";
    const [owner = ""] = ref.repository.split("/");
    const account = yield* decodeHostJson(
      GitHubAccount,
      yield* rest(ref.host, operation, `users/${segment(owner)}`),
    );
    const ownerKind = account.type === "Organization" ? "organization" : "user";
    const found = yield* (
      ownerKind === "organization"
        ? GraphQLClient.items(client.OrganizationProjects, {
            variables: { owner },
            connection: (result) => result.organization?.projectsV2,
          })
        : GraphQLClient.items(client.UserProjects, {
            variables: { owner },
            connection: (result) => result.user?.projectsV2,
          })
    ).pipe(Stream.runCollect, projects(ref.host, operation));
    return found.flatMap((project) =>
      project === null
        ? []
        : [
            {
              title: project.title,
              locator: {
                kind: "github-project" as const,
                host: ref.host,
                owner,
                ownerKind,
                projectNumber: project.number,
                projectNodeId: project.id,
              },
            },
          ],
    );
  });

  const read: IssueHostBoards<"github-project">["read"] = Effect.fn("GitHubIssueHost.readBoard")(
    function* (_cwd, locator: ProjectLocator) {
      const operation = "GitHubIssueHost.readBoard";
      const variables = { owner: locator.owner, number: locator.projectNumber };
      const project =
        locator.ownerKind === "organization"
          ? (yield* client.OrganizationProject(variables).pipe(projects(locator.host, operation)))
              .organization?.projectV2
          : (yield* client.UserProject(variables).pipe(projects(locator.host, operation))).user
              ?.projectV2;
      if (!project)
        return yield* new IssueOperationError({
          reason: "not-found",
          message: "The GitHub Project could not be found.",
        });
      const field = (project.fields.nodes ?? [])
        .flatMap((node) => (node?.__typename === "ProjectV2SingleSelectField" ? [node] : []))
        .find(statusFieldOf(locator));
      if (!field)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Choose an existing GitHub Project with a single-select Status field.",
        });
      const nodes = yield* GraphQLClient.items(client.ProjectItems, {
        variables: { projectId: project.id },
        connection: (result) =>
          result.node?.__typename === "ProjectV2" ? result.node.items : null,
      }).pipe(Stream.runCollect, projects(locator.host, operation));
      const items = yield* validate(
        BoardItems,
        nodes.flatMap((node) => {
          const item =
            node === null ? null : toBoardItem(locator.host, node, ({ id }) => id === field.id);
          return item === null ? [] : [item];
        }),
      );
      return {
        title: project.title,
        locator: { ...locator, projectNodeId: project.id, statusFieldId: field.id },
        columns: field.options.map((option) => ({ id: option.id, title: option.name })),
        items,
      };
    },
  );

  const readItem: IssueHostBoards<"github-project">["readItem"] = Effect.fn(
    "GitHubIssueHost.readItem",
  )(function* (_cwd, locator: ProjectLocator, item) {
    const { node } = yield* client
      .ProjectItem({ itemId: item.itemId })
      .pipe(projects(locator.host, "GitHubIssueHost.readItem"));
    const fresh =
      node?.__typename === "ProjectV2Item" &&
      (locator.projectNodeId === undefined || node.project.id === locator.projectNodeId)
        ? toBoardItem(locator.host, node, statusFieldOf(locator))
        : null;
    if (fresh === null)
      return yield* new IssueOperationError({
        reason: "not-found",
        message: "This issue is no longer on the GitHub Project.",
      });
    return yield* validate(IssueBoardItem, fresh);
  });

  const move: IssueHostBoards<"github-project">["move"] = Effect.fn("GitHubIssueHost.move")(
    function* (_cwd, locator: ProjectLocator, item, columnId) {
      if (!locator.projectNodeId || !locator.statusFieldId)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Reconnect this GitHub Project to select its Status field.",
        });
      yield* client
        .MoveProjectItem({
          projectId: locator.projectNodeId,
          itemId: item.itemId,
          fieldId: locator.statusFieldId,
          optionId: columnId,
        })
        .pipe(projects(locator.host, "GitHubIssueHost.move"));
    },
  );

  return {
    kind: GITHUB,
    list,
    get,
    boards: { locatorKind: "github-project", list: listBoards, read, readItem, move },
  } satisfies IssueHostAdapter;
});
