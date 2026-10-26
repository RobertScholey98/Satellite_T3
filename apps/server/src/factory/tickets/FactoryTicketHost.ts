import {
  FactoryOperationError,
  PositiveInt,
  SourceControlProviderKind,
  issueReadyColumnIds,
  type IssueBoardItem,
  type IssueBoardLocator,
  type IssueBoardSummary,
  type IssueOperationError,
  type IssueRef,
  type ProjectId,
} from "@t3tools/contracts";
import * as AzureBoardsCli from "@t3tools/source-control-azure-devops/server/AzureBoardsCli";
import * as AzureBoardsIssueHost from "@t3tools/source-control-azure-devops/server/AzureBoardsIssueHost";
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import { ISSUE_RESPONSE_LIMIT_BYTES } from "@t3tools/source-control-core/server/IssueHostAdapter";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubIssueHost from "@t3tools/source-control-github/server/GitHubIssueHost";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { repositoryIssueScope } from "../../issues/IssueHost.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";

export interface FactoryTicketCreateInput {
  readonly projectId: ProjectId;
  /** The project checkout, for credential and host resolution. */
  readonly cwd: string;
  /** A connected board with a mapping; the ticket lands in its first Ready column. */
  readonly board: IssueBoardSummary;
  /** Unique per draft; finding it on the host is what keeps a retry from filing twice. */
  readonly marker: string;
  readonly title: string;
  readonly body: string;
}

/** Files an approved triage draft on the board's host and places it in the board's Ready column. */
export class FactoryTicketHost extends Context.Service<
  FactoryTicketHost,
  {
    readonly create: (
      input: FactoryTicketCreateInput,
    ) => Effect.Effect<IssueRef, FactoryOperationError>;
  }
>()("t3/factory/tickets/FactoryTicketHost") {}

type GitHubLocator = Extract<IssueBoardLocator, { kind: "github-project" }>;
type AzureLocator = Extract<IssueBoardLocator, { kind: "azure-board" }>;

const GITHUB = SourceControlProviderKind.make("github");
const AZURE_DEVOPS = SourceControlProviderKind.make("azure-devops");
// The marker is quoted into a GitHub search and a WIQL string, and sits inside an HTML comment.
const MARKER = /^[A-Za-z0-9:._]+(?:-[A-Za-z0-9:._]+)*$/;

const failure = (reason: FactoryOperationError["reason"], message: string) =>
  new FactoryOperationError({ reason, message });

const fromIssueError = (error: IssueOperationError) =>
  failure(
    error.reason === "invalid" || error.reason === "not-found" || error.reason === "conflict"
      ? error.reason
      : "unavailable",
    error.message,
  );

const fromGitHubError = (error: GitHubRequestPolicy.GitHubApiError) =>
  failure(
    error._tag === "GitHubApiNotFoundError"
      ? "not-found"
      : error._tag === "GitHubApiResponseError" && error.status < 500
        ? "invalid"
        : "unavailable",
    error.message,
  );

const fromAzureError = (error: AzureBoardsCli.AzureBoardsCliError) =>
  error._tag === "AzureDevOpsCliAuthenticationError"
    ? failure(
        "unavailable",
        "Azure DevOps is not signed in. Run `az login` and `az devops login` on the computer hosting this project.",
      )
    : failure(error._tag === "AzureBoardsRejectedError" ? "invalid" : "unavailable", error.message);

const unexpectedAnswer = (host: string) =>
  failure("unavailable", `${host} returned an answer the factory could not read.`);

const decodeJsonAs = <S extends Schema.Top>(schema: S, host: string) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return (text: string) => decode(text).pipe(Effect.mapError(() => unexpectedAnswer(host)));
};

const GraphQlAnswer = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ message: Schema.String, type: Schema.optional(Schema.Unknown) })),
  ),
});
const decodeGraphQlAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(GraphQlAnswer));

const FoundIssue = Schema.Struct({
  __typename: Schema.Literal("Issue"),
  id: Schema.String,
  number: PositiveInt,
  url: Schema.String,
  body: Schema.String,
});
const isFoundIssue = Schema.is(FoundIssue);
const SearchData = Schema.Struct({
  search: Schema.Struct({ nodes: Schema.NullOr(Schema.Array(Schema.Unknown)) }),
});
const AddItemData = Schema.Struct({
  addProjectV2ItemById: Schema.NullOr(
    Schema.Struct({ item: Schema.NullOr(Schema.Struct({ id: Schema.String })) }),
  ),
});
const CreatedIssue = Schema.Struct({
  node_id: Schema.String,
  number: PositiveInt,
  html_url: Schema.String,
});

const SEARCH_QUERY = `query FactoryTicketSearch($query: String!) {
  search(type: ISSUE, query: $query, first: 20) {
    nodes { __typename ... on Issue { id number url body } }
  }
}`;
// Adding content a Project already holds returns its existing item, so this is safe to repeat.
const ADD_ITEM_MUTATION = `mutation FactoryTicketAddToProject($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`;

const AzureBoard = Schema.Struct({
  columns: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      stateMappings: Schema.Record(Schema.String, Schema.String),
    }),
  ),
});
const AzureTeamFieldValues = Schema.Struct({
  field: Schema.Struct({ referenceName: Schema.String }),
  defaultValue: Schema.optional(Schema.NullOr(Schema.String)),
  values: Schema.Array(Schema.Struct({ value: Schema.String })),
});
const AzureQueryResult = Schema.Struct({
  workItems: Schema.Array(Schema.Struct({ id: PositiveInt })),
});
const AzureCreatedWorkItem = Schema.Struct({ id: PositiveInt });

const quoteWiql = (value: string) => `'${value.replaceAll("'", "''")}'`;
const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The board item a host's `move` needs: only `itemId` is read. */
const boardItem = (ref: IssueRef, title: string, itemId: string): IssueBoardItem => ({
  issue: { ref, title, state: "open", updatedAt: "", labels: [] },
  itemId,
  columnId: null,
  version: null,
});

/** @public */
export const make = Effect.gen(function* () {
  const github = yield* GitHubRest.GitHubRest;
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;
  const httpClient = yield* HttpClient.HttpClient;
  const repositories = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const boardsCli = yield* AzureBoardsCli.AzureBoardsCli;
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fs = yield* FileSystem.FileSystem;
  const gitHubBoards = (yield* GitHubIssueHost.make).boards;
  const azureBoards = (yield* AzureBoardsIssueHost.make).boards;

  /**
   * One GraphQL request through the request policy, so it spends the `graphql` quota and carries
   * the same credential as the issue host. The generated client is private to its package.
   */
  const graphql = <S extends Schema.Top>(
    host: string,
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    data: S,
  ) =>
    SourceControlRateLimit.Interactive.pipe(
      Effect.flatMap((allowReserve) =>
        policy.request({ host, operation, resource: "graphql", allowReserve }, (headers) =>
          httpClient
            .execute(
              HttpClientRequest.make("POST")(GitHubRequestPolicy.gitHubApiUrls(host).graphql).pipe(
                HttpClientRequest.setHeaders(headers),
                HttpClientRequest.bodyJsonUnsafe({
                  query,
                  operationName: operation,
                  variables,
                }),
              ),
            )
            .pipe(
              Effect.flatMap((response) =>
                response.text.pipe(
                  Effect.map((text): GitHubRequestPolicy.GitHubAnswer<unknown> => {
                    const meta = { status: response.status, headers: response.headers };
                    const answer = Option.getOrUndefined(decodeGraphQlAnswer(text));
                    if (
                      GitHubRequestPolicy.isRateLimited({
                        ...meta,
                        body: text,
                        ...(answer?.errors ? { graphqlErrors: answer.errors } : {}),
                      })
                    )
                      return { _tag: "RateLimited", ...meta };
                    if (response.status === 401) return { _tag: "Unauthorized", ...meta };
                    if (response.status === 404) return { _tag: "NotFound", ...meta };
                    if (response.status >= 300 || answer === undefined || answer.errors?.length)
                      return {
                        _tag: "Failed",
                        messages: answer?.errors?.map((entry) => entry.message),
                        ...meta,
                      };
                    return { _tag: "Ok", value: answer.data, ...meta };
                  }),
                ),
              ),
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
              Effect.mapError(
                (cause) =>
                  new GitHubRequestPolicy.GitHubApiRequestError({ host, operation, cause }),
              ),
            ),
        ),
      ),
      Effect.mapError(fromGitHubError),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(data)(value).pipe(
          Effect.mapError(() => unexpectedAnswer("GitHub")),
        ),
      ),
    );

  const gitHubRepository = Effect.fnUntraced(function* (cwd: string, locator: GitHubLocator) {
    const identity = yield* repositories.resolve(cwd);
    const scope = yield* repositoryIssueScope(cwd, identity).pipe(
      Effect.mapError((error) => failure("unavailable", error.message)),
    );
    if (scope.ref.hostKind !== GITHUB)
      return yield* failure(
        "unavailable",
        "This project's repository is not on GitHub, so its tickets cannot be filed on a GitHub Project.",
      );
    if (
      GitHubRequestPolicy.normalizeHost(scope.ref.host) !==
      GitHubRequestPolicy.normalizeHost(locator.host)
    )
      return yield* failure(
        "invalid",
        `This project's repository is on ${scope.ref.host}, but the board is on ${locator.host}.`,
      );
    return scope.ref;
  });

  const createOnGitHub = Effect.fn("FactoryTicketHost.createOnGitHub")(function* (
    input: FactoryTicketCreateInput,
    locator: GitHubLocator,
    readyColumnId: string,
    body: string,
  ) {
    const { projectNodeId } = locator;
    // Checked before filing: without these ids the issue could be filed but never placed.
    if (!projectNodeId || !locator.statusFieldId)
      return yield* failure(
        "invalid",
        "Reconnect this GitHub Project to select its Status field before filing tickets.",
      );
    const repository = yield* gitHubRepository(input.cwd, locator);
    const host = repository.host;

    const search = yield* graphql(
      host,
      "FactoryTicketSearch",
      SEARCH_QUERY,
      { query: `repo:${repository.repository} "${input.marker}" in:body` },
      SearchData,
    );
    const existing = (search.search.nodes ?? [])
      .filter(isFoundIssue)
      .find((issue) => issue.body.includes(input.marker));
    const issue = existing
      ? { nodeId: existing.id, number: existing.number, url: existing.url }
      : yield* github
          .rest({
            host,
            operation: "FactoryTicketHost.createIssue",
            method: "POST",
            path: `repos/${repository.repository}/issues`,
            body: { title: input.title, body },
            maxResponseBytes: ISSUE_RESPONSE_LIMIT_BYTES,
          })
          .pipe(
            Effect.mapError(fromGitHubError),
            Effect.flatMap((response) => decodeJsonAs(CreatedIssue, "GitHub")(response.body)),
            Effect.map((created) => ({
              nodeId: created.node_id,
              number: created.number,
              url: created.html_url,
            })),
          );
    const ref: IssueRef = {
      hostKind: GITHUB,
      host,
      repository: repository.repository,
      id: String(issue.number),
      number: issue.number,
      url: issue.url,
    };

    const place = Effect.gen(function* () {
      const added = yield* graphql(
        host,
        "FactoryTicketAddToProject",
        ADD_ITEM_MUTATION,
        { projectId: projectNodeId, contentId: issue.nodeId },
        AddItemData,
      );
      const itemId = added.addProjectV2ItemById?.item?.id;
      if (!itemId) return yield* unexpectedAnswer("GitHub");
      yield* gitHubBoards
        .move(input.cwd, locator, boardItem(ref, input.title, itemId), readyColumnId)
        .pipe(Effect.mapError(fromIssueError));
    });
    return yield* placed(ref, place);
  });

  const azureInvoke = (request: AzureBoardsCli.AzureBoardsInvokeInput) =>
    boardsCli.invoke(request).pipe(Effect.mapError(fromAzureError));

  const createOnAzure = Effect.fn("FactoryTicketHost.createOnAzure")(function* (
    input: FactoryTicketCreateInput,
    locator: AzureLocator,
    readyColumnId: string,
  ) {
    const { organization, project } = locator;
    const decode = <S extends Schema.Top>(schema: S) => decodeJsonAs(schema, "Azure DevOps");
    const toRef = (id: number): IssueRef => ({
      hostKind: AZURE_DEVOPS,
      host: locator.host,
      repository: `${organization}/${project}`,
      id: String(id),
      number: id,
      url: `https://${locator.host}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_workitems/edit/${id}`,
    });

    // Rich-text fields only take full-text operators in WIQL; plain CONTAINS is refused there.
    const found = yield* azureInvoke({
      cwd: input.cwd,
      organization,
      area: "wit",
      resource: "wiql",
      route: { project },
      body: {
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Description] CONTAINS WORDS ${quoteWiql(input.marker)} ORDER BY [System.Id] ASC`,
      },
    }).pipe(Effect.flatMap(decode(AzureQueryResult)));
    const existingId = found.workItems[0]?.id;

    const id =
      existingId ??
      (yield* Effect.gen(function* () {
        const [board, team] = yield* Effect.all(
          [
            azureInvoke({
              cwd: input.cwd,
              organization,
              area: "work",
              resource: "boards",
              route: { project, team: locator.team, id: locator.boardId },
            }).pipe(Effect.flatMap(decode(AzureBoard))),
            azureInvoke({
              cwd: input.cwd,
              organization,
              area: "work",
              resource: "teamfieldvalues",
              route: { project, team: locator.team },
            }).pipe(Effect.flatMap(decode(AzureTeamFieldValues))),
          ],
          { concurrency: 2 },
        );
        const types = Object.keys(
          board.columns.find((column) => column.id === readyColumnId)?.stateMappings ?? {},
        );
        // A draft describes work to build; a Bug type is used only when the board maps nothing else.
        const type = types.find((name) => name !== "Bug") ?? types[0];
        if (!type)
          return yield* failure(
            "invalid",
            "The board's Ready column no longer exists or maps no work item type. Update the board's column mapping.",
          );
        // The board only shows work items under the team's area, so the ticket is filed there.
        const area = team.defaultValue || team.values[0]?.value;
        if (!area)
          return yield* failure("invalid", "The board's team has no area to file tickets under.");
        const description = `${input.body.split("\n").map(escapeHtml).join("<br>")}<!-- ${input.marker} -->`;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            // `az` reads `@file` arguments itself, which keeps a long body off the command line.
            const file = yield* fs.makeTempFileScoped({
              prefix: "t3-factory-ticket-",
              suffix: ".html",
            });
            yield* fs.writeFileString(file, description);
            const output = yield* azure.execute({
              cwd: input.cwd,
              args: [
                "boards",
                "work-item",
                "create",
                "--title",
                input.title,
                "--type",
                type,
                "--project",
                project,
                "--description",
                `@${file}`,
                "--fields",
                `${team.field.referenceName}=${area}`,
                "--organization",
                `https://dev.azure.com/${encodeURIComponent(organization)}`,
                "--only-show-errors",
                "--output",
                "json",
              ],
              maxOutputBytes: ISSUE_RESPONSE_LIMIT_BYTES,
            });
            return (yield* decode(AzureCreatedWorkItem)(output.stdout)).id;
          }),
        ).pipe(
          Effect.mapError((error) =>
            error._tag === "FactoryOperationError" ? error : fromAzureError(error),
          ),
        );
      }));
    const ref = toRef(id);
    return yield* placed(
      ref,
      azureBoards
        .move(input.cwd, locator, boardItem(ref, input.title, String(id)), readyColumnId)
        .pipe(Effect.mapError(fromIssueError)),
    );
  });

  const create: FactoryTicketHost["Service"]["create"] = Effect.fn("FactoryTicketHost.create")(
    function* (input) {
      if (!MARKER.test(input.marker))
        return yield* failure("invalid", "The draft's ticket marker is malformed.");
      const readyColumnId = input.board.mapping
        ? issueReadyColumnIds(input.board.mapping)[0]
        : undefined;
      if (!readyColumnId)
        return yield* failure("invalid", "Map this board's Ready column before filing tickets.");
      const { locator } = input.board;
      if (locator.kind === "github-project")
        return yield* createOnGitHub(
          input,
          locator,
          readyColumnId,
          `${input.body.trimEnd()}\n\n<!-- ${input.marker} -->`,
        );
      if (locator.kind === "azure-board")
        return yield* createOnAzure(input, locator, readyColumnId);
      return yield* failure(
        "unavailable",
        "Tickets can be filed on GitHub Projects and Azure Boards only.",
      );
    },
  );

  return FactoryTicketHost.of({ create });
});

/** A filed ticket that could not be placed is still filed: name it so the user can place it. */
const placed = (ref: IssueRef, place: Effect.Effect<void, FactoryOperationError>) =>
  place.pipe(
    Effect.mapError((error) =>
      failure(
        "unavailable",
        `Filed ${ref.url}, but could not move it to the board's Ready column: ${error.message} Move it there by hand, or retry to place it.`,
      ),
    ),
    Effect.as(ref),
  );

export const layer = Layer.effect(FactoryTicketHost, make).pipe(
  Layer.provide(AzureBoardsCli.layer),
);
