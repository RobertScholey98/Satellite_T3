import {
  IssueOperationError,
  issueReadyColumnIds,
  type IssuePublicationDestination,
  type IssuePublicationDraft,
  type IssuePublicationProgress,
  type IssueRef,
  type ProjectId,
  type QualifiedIssueDestination,
} from "@t3tools/contracts";
import {
  sourceControlRepositorySelector,
  detectSourceControlProviderFromRemoteUrl,
} from "@t3tools/shared/sourceControl";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import { CredentialScope } from "../sourceControl/SourceControlRateLimit.ts";
import * as IssueHost from "./IssueHost.ts";
import * as IssueService from "./IssueService.ts";

type Placement = Extract<IssuePublicationProgress, { status: "triaged" }>["placement"];
type DestinationInput = { readonly destination: QualifiedIssueDestination };
type MutationInput = DestinationInput & {
  readonly beforeMutation: Effect.Effect<void, IssueOperationError>;
};
export class IssuePublicationHost extends Context.Service<
  IssuePublicationHost,
  {
    readonly validate: (input: {
      readonly projectId: ProjectId;
      readonly destination: IssuePublicationDestination;
    }) => Effect.Effect<QualifiedIssueDestination, IssueOperationError>;
    readonly lookup: (
      input: DestinationInput & { readonly marker: string },
    ) => Effect.Effect<
      { readonly issues: ReadonlyArray<IssueRef>; readonly complete: boolean },
      IssueOperationError
    >;
    readonly create: (
      input: MutationInput & { readonly draft: IssuePublicationDraft; readonly marker: string },
    ) => Effect.Effect<IssueRef, IssueOperationError>;
    readonly place: (
      input: MutationInput & { readonly issue: IssueRef },
    ) => Effect.Effect<void, IssueOperationError>;
    readonly inspect: (
      input: DestinationInput & { readonly issue: IssueRef },
    ) => Effect.Effect<Placement | undefined, IssueOperationError>;
  }
>()("t3/issues/IssuePublicationHost") {}

const invalid = () =>
  new IssueOperationError({
    reason: "invalid",
    message:
      "The tracker destination or response does not match the approved project triage configuration.",
  });
const remoteError = () =>
  new IssueOperationError({
    reason: "remote",
    message: "The tracker could not confirm the publication operation.",
  });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const GithubIssue = Schema.Struct({
  number: Schema.Int,
  node_id: Schema.String,
  html_url: Schema.String,
  body: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  pull_request: Schema.optionalKey(Schema.Unknown),
});
const AzureItem = Schema.Struct({
  id: Schema.Int,
  fields: Schema.Record(Schema.String, Schema.Unknown),
});
const AzureBoard = Schema.Struct({
  fields: Schema.Struct({
    columnField: Schema.Struct({ referenceName: Schema.String }),
    doneField: Schema.optionalKey(Schema.Struct({ referenceName: Schema.String })),
  }),
  columns: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      stateMappings: Schema.Record(Schema.String, Schema.String),
    }),
  ),
});
const decode = <S extends Schema.Top>(schema: S, value: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(value).pipe(Effect.mapError(remoteError));
const segment = encodeURIComponent;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const publicUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/^(localhost|127\.|\[?::1)/i.test(url.hostname)
    );
  } catch {
    return false;
  }
};
const bodyFor = (draft: IssuePublicationDraft, marker: string) =>
  [
    `<!-- ${marker} -->`,
    "",
    "## Problem",
    draft.problem,
    "",
    "## Impact",
    draft.impact,
    "",
    "## Proposed outcome",
    draft.proposedOutcome,
    "",
    "## Acceptance criteria",
    ...draft.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Evidence",
    ...draft.evidence.map(
      (item) => `- ${item.summary}${item.url && publicUrl(item.url) ? ` (${item.url})` : ""}`,
    ),
    "",
    `Owner: ${draft.owner}`,
    `Required authority: ${draft.requiredAuthority}`,
    `Suspected cause: ${draft.suspectedCause}`,
    `Assignment: ${draft.origin.assignmentId}`,
    `Findings: ${draft.origin.findingIds.join(", ")}`,
    ...(draft.containmentOf ? [`Containment for: ${draft.containmentOf}`] : []),
  ].join("\n");
const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const make = Effect.gen(function* () {
  const projects = yield* ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver;
  const environment = yield* ServerEnvironmentIdentity;
  const api = yield* GitHubApi.GitHubApi;
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const issues = yield* IssueService.IssueService;
  const host = yield* IssueHost.IssueHost;
  const resolve = Effect.fnUntraced(function* (
    projectId: ProjectId,
    destination: IssuePublicationDestination,
  ) {
    const project = yield* projects.get(projectId).pipe(Effect.mapError(remoteError));
    if (Option.isNone(project)) return yield* invalid();
    const identity = yield* identities.resolve(project.value.workspaceRoot, { refresh: true });
    if (identity && identity.provider !== "github" && identity.provider !== "azure-devops")
      return yield* new IssueOperationError({
        reason: "unavailable",
        message:
          "This repository host does not support managed issue publication. The draft can be retained for manual publication.",
      });
    const detected = identity
      ? detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl)
      : undefined;
    const repository =
      identity?.provider === "azure-devops"
        ? identity.displayName?.split("/_git/")[0]
        : sourceControlRepositorySelector(identity);
    const expectedRepository =
      destination.kind === "github"
        ? destination.repository
        : `${destination.organization}/${destination.project}`;
    const actualHost =
      identity?.provider === "azure-devops"
        ? "dev.azure.com"
        : detected
          ? new URL(detected.baseUrl).host
          : undefined;
    if (
      !identity ||
      identity.provider !== (destination.kind === "github" ? "github" : "azure-devops") ||
      !repository ||
      repository.toLowerCase() !== expectedRepository.toLowerCase() ||
      actualHost?.toLowerCase() !== destination.host.toLowerCase()
    )
      return yield* invalid();
    return project.value.workspaceRoot;
  });
  const rest = Effect.fnUntraced(function* (
    destination: QualifiedIssueDestination,
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
    beforeMutation?: Effect.Effect<void, IssueOperationError>,
  ) {
    const credential = yield* api
      .credential(destination.destination.host)
      .pipe(Effect.mapError(remoteError));
    if (credential.fingerprint !== destination.credentialNamespace)
      return yield* new IssueOperationError({
        reason: "authentication",
        message: "The tracker credential changed. Revalidate the destination before publishing.",
      });
    const response = yield* api
      .rest({
        host: destination.destination.host,
        operation: "IssuePublication",
        path,
        method,
        ...(body === undefined ? {} : { body }),
      })
      .pipe(
        Effect.provideService(GitHubApi.PinnedGitHubCredential, {
          host: destination.destination.host,
          token: credential.token,
          credentialFingerprint: credential.fingerprint,
        }),
        Effect.provideService(
          GitHubApi.BeforeGitHubMutation,
          beforeMutation
            ? beforeMutation.pipe(
                Effect.mapError(
                  (cause) =>
                    new GitHubApi.GitHubApiRequestError({
                      host: destination.destination.host,
                      operation: "IssuePublication",
                      cause,
                    }),
                ),
              )
            : null,
        ),
        Effect.mapError(remoteError),
      );
    if (response.truncated || response.invalidUtf8) return yield* remoteError();
    return response.body;
  });
  const ghPath = (destination: Extract<IssuePublicationDestination, { kind: "github" }>) =>
    `repos/${destination.repository.split("/").map(segment).join("/")}`;
  const az = Effect.fnUntraced(function* (
    cwd: string,
    destination: Extract<IssuePublicationDestination, { kind: "azure" }>,
    args: ReadonlyArray<string>,
    beforeMutation?: Effect.Effect<void, IssueOperationError>,
  ) {
    const output = yield* azure
      .execute({
        cwd,
        args: [
          ...args,
          "--organization",
          `https://dev.azure.com/${segment(destination.organization)}`,
          "--output",
          "json",
          "--only-show-errors",
        ],
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.provideService(
          AzureDevOpsCli.BeforeAzureDevOpsMutation,
          beforeMutation
            ? beforeMutation.pipe(
                Effect.mapError(
                  (cause) =>
                    new AzureDevOpsCli.AzureDevOpsCommandFailedError({
                      operation: "execute",
                      command: "az",
                      cwd,
                      argumentCount: args.length,
                      cause,
                    }),
                ),
              )
            : null,
        ),
        Effect.mapError(remoteError),
      );
    if (output.stdoutTruncated) return yield* remoteError();
    return output.stdout;
  });
  const azBoard = Effect.fnUntraced(function* (
    cwd: string,
    destination: Extract<IssuePublicationDestination, { kind: "azure" }>,
    qualified: QualifiedIssueDestination,
  ) {
    const board = qualified.board;
    if (board?.kind !== "azure-board") return yield* invalid();
    return yield* decode(
      AzureBoard,
      yield* az(cwd, destination, [
        "devops",
        "invoke",
        "--area",
        "work",
        "--resource",
        "boards",
        "--api-version",
        "7.1",
        "--route-parameters",
        `project=${board.project}`,
        `team=${board.team}`,
        `id=${board.boardId}`,
      ]),
    );
  });
  const validate: IssuePublicationHost["Service"]["validate"] = Effect.fn(
    "IssuePublicationHost.validate",
  )(function* ({ projectId, destination }) {
    const cwd = yield* resolve(projectId, destination);
    const environmentId = yield* environment.getEnvironmentId;
    const credentialNamespace =
      destination.kind === "github"
        ? (yield* api.credential(destination.host).pipe(Effect.mapError(remoteError))).fingerprint
        : `azure:${yield* CredentialScope}:${destination.organization.toLowerCase()}`;
    let qualified: QualifiedIssueDestination = {
      projectId,
      environmentId,
      credentialNamespace,
      destination,
      board: null,
      validatedAt: yield* now,
    };
    if (destination.kind === "github") {
      if (destination.repository.split("/").length !== 2) return yield* invalid();
      const repository = yield* decode(
        Schema.Struct({ full_name: Schema.String, has_issues: Schema.Literal(true) }),
        yield* rest(qualified, ghPath(destination)),
      );
      if (repository.full_name.toLowerCase() !== destination.repository.toLowerCase())
        return yield* invalid();
      for (const label of destination.triage.labels) {
        const actual = yield* decode(
          Schema.Struct({ name: Schema.String }),
          yield* rest(qualified, `${ghPath(destination)}/labels/${segment(label)}`),
        );
        if (actual.name !== label) return yield* invalid();
      }
      if (destination.triage.kind === "labels") return qualified;
    }
    const boardId =
      destination.kind === "github" && destination.triage.kind === "board"
        ? destination.triage.boardId
        : destination.kind === "azure"
          ? destination.boardId
          : "";
    const columnId =
      destination.kind === "github" && destination.triage.kind === "board"
        ? destination.triage.columnId
        : destination.kind === "azure"
          ? destination.columnId
          : "";
    const boards = yield* issues.listBoards({ projectId, connectedOnly: true });
    const connected = boards.find((entry) => entry.id === boardId);
    if (
      !connected ||
      connected.projectId !== projectId ||
      connected.locator.host.toLowerCase() !== destination.host.toLowerCase()
    )
      return yield* invalid();
    if (
      connected.mapping &&
      [
        ...issueReadyColumnIds(connected.mapping),
        connected.mapping.inProgress,
        connected.mapping.inPullRequest,
        connected.mapping.completed,
      ].includes(columnId)
    )
      return yield* new IssueOperationError({
        reason: "invalid",
        message: "Triage must be separate from ready, in progress, in PR, and completed.",
      });
    const live = yield* host.board(cwd, connected.locator);
    if (!live.columns.some((column) => column.id === columnId)) return yield* invalid();
    qualified = { ...qualified, board: live.locator };
    if (destination.kind === "github") {
      if (
        live.locator.kind !== "github-project" ||
        !live.locator.projectNodeId ||
        !live.locator.statusFieldId
      )
        return yield* invalid();
    } else {
      if (
        live.locator.kind !== "azure-board" ||
        live.locator.organization.toLowerCase() !== destination.organization.toLowerCase() ||
        live.locator.project.toLowerCase() !== destination.project.toLowerCase()
      )
        return yield* invalid();
      const metadata = yield* azBoard(cwd, destination, qualified);
      if (
        metadata.columns.find((column) => column.id === columnId)?.stateMappings[
          destination.workItemType
        ] !== destination.state
      )
        return yield* invalid();
      const team = yield* decode(
        Schema.Struct({
          values: Schema.Array(
            Schema.Struct({ value: Schema.String, includeChildren: Schema.Boolean }),
          ),
        }),
        yield* az(cwd, destination, [
          "devops",
          "invoke",
          "--area",
          "work",
          "--resource",
          "teamfieldvalues",
          "--api-version",
          "7.1",
          "--route-parameters",
          `project=${live.locator.project}`,
          `team=${live.locator.team}`,
        ]),
      );
      if (
        !team.values.some(
          (area) =>
            area.value === destination.areaPath ||
            (area.includeChildren && destination.areaPath.startsWith(`${area.value}\\`)),
        )
      )
        return yield* invalid();
    }
    return qualified;
  });
  const current = Effect.fnUntraced(function* (qualified: QualifiedIssueDestination) {
    const checked = yield* validate({
      projectId: qualified.projectId,
      destination: qualified.destination,
    });
    const { validatedAt: _old, ...oldIdentity } = qualified;
    const { validatedAt: _new, ...newIdentity } = checked;
    if (stableStringify(oldIdentity) !== stableStringify(newIdentity)) return yield* invalid();
    return yield* resolve(qualified.projectId, qualified.destination);
  });
  const githubRef = (
    destination: Extract<IssuePublicationDestination, { kind: "github" }>,
    item: typeof GithubIssue.Type,
  ): IssueRef => ({
    hostKind: "github",
    host: destination.host,
    repository: destination.repository,
    id: String(item.number),
    number: item.number,
    url: `https://${destination.host}/${destination.repository}/issues/${item.number}`,
  });
  const azureRef = (
    destination: Extract<IssuePublicationDestination, { kind: "azure" }>,
    item: typeof AzureItem.Type,
  ): IssueRef => ({
    hostKind: "azure-devops",
    host: destination.host,
    repository: `${destination.organization}/${destination.project}`,
    id: String(item.id),
    number: item.id,
    url: `https://dev.azure.com/${segment(destination.organization)}/${segment(destination.project)}/_workitems/edit/${item.id}`,
  });
  const requireIssue = (qualified: QualifiedIssueDestination, issue: IssueRef) => {
    const destination = qualified.destination;
    const repository =
      destination.kind === "github"
        ? destination.repository
        : `${destination.organization}/${destination.project}`;
    const url =
      destination.kind === "github"
        ? `https://${destination.host}/${destination.repository}/issues/${issue.id}`
        : `https://dev.azure.com/${segment(destination.organization)}/${segment(destination.project)}/_workitems/edit/${issue.id}`;
    return issue.hostKind === (destination.kind === "github" ? "github" : "azure-devops") &&
      issue.host.toLowerCase() === destination.host.toLowerCase() &&
      issue.repository.toLowerCase() === repository.toLowerCase() &&
      /^[1-9]\d*$/.test(issue.id) &&
      Number(issue.id) === issue.number &&
      issue.url === url
      ? Effect.void
      : Effect.fail(invalid());
  };
  const inspect: IssuePublicationHost["Service"]["inspect"] = Effect.fn(
    "IssuePublicationHost.inspect",
  )(function* ({ destination: qualified, issue }) {
    const cwd = yield* current(qualified);
    yield* requireIssue(qualified, issue);
    const destination = qualified.destination;
    if (destination.kind === "github") {
      const item = yield* decode(
        GithubIssue,
        yield* rest(qualified, `${ghPath(destination)}/issues/${segment(issue.id)}`),
      );
      if (item.pull_request || item.number !== issue.number) return yield* invalid();
      if (
        !destination.triage.labels.every((label) =>
          item.labels.some((actual) => actual.name === label),
        )
      )
        return undefined;
      if (destination.triage.kind === "labels")
        return { kind: "labels", labels: destination.triage.labels };
    } else {
      const item = yield* decode(
        AzureItem,
        yield* az(cwd, destination, ["boards", "work-item", "show", "--id", issue.id]),
      );
      if (
        item.id !== issue.number ||
        item.fields["System.TeamProject"] !== destination.project ||
        item.fields["System.WorkItemType"] !== destination.workItemType
      )
        return yield* invalid();
      if (
        item.fields["System.State"] !== destination.state ||
        item.fields["System.AreaPath"] !== destination.areaPath
      )
        return undefined;
    }
    if (!qualified.board) return yield* invalid();
    const board = yield* host.board(cwd, qualified.board);
    const item = board.items.find(
      (entry) =>
        IssueHost.canonicalIssueKey(entry.issue.ref) === IssueHost.canonicalIssueKey(issue),
    );
    const columnId =
      destination.kind === "github" && destination.triage.kind === "board"
        ? destination.triage.columnId
        : destination.kind === "azure"
          ? destination.columnId
          : "";
    return item?.columnId === columnId
      ? { kind: "board", itemId: item.itemId, columnId }
      : undefined;
  });
  return IssuePublicationHost.of({
    validate,
    inspect,
    lookup: Effect.fn("IssuePublicationHost.lookup")(function* ({
      destination: qualified,
      marker,
    }) {
      const cwd = yield* current(qualified);
      const destination = qualified.destination;
      const found: IssueRef[] = [];
      if (destination.kind === "github") {
        for (let page = 1; page <= 100; page++) {
          const rows = yield* decode(
            Schema.Array(GithubIssue),
            yield* rest(
              qualified,
              `${ghPath(destination)}/issues?state=all&per_page=100&page=${page}&sort=created&direction=asc`,
            ),
          );
          for (const item of rows)
            if (!item.pull_request && item.body?.includes(`<!-- ${marker} -->`))
              found.push(githubRef(destination, item));
          if (rows.length < 100) return { issues: found, complete: true };
        }
        return { issues: found, complete: false };
      }
      const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${quote(destination.project)} AND [System.Tags] CONTAINS ${quote(marker)} ORDER BY [System.Id] ASC`;
      const rows = yield* decode(
        Schema.Array(AzureItem),
        yield* az(cwd, destination, [
          "boards",
          "query",
          "--wiql",
          query,
          "--project",
          destination.project,
        ]),
      );
      for (const row of rows) {
        const item = yield* decode(
          AzureItem,
          yield* az(cwd, destination, ["boards", "work-item", "show", "--id", String(row.id)]),
        );
        if (item.fields["System.TeamProject"] !== destination.project) return yield* invalid();
        if (
          String(item.fields["System.Tags"] ?? "")
            .split(";")
            .map((tag) => tag.trim())
            .includes(marker)
        )
          found.push(azureRef(destination, item));
      }
      return { issues: found, complete: rows.length < 20_000 };
    }),
    create: Effect.fn("IssuePublicationHost.create")(function* ({
      destination: qualified,
      draft,
      marker,
      beforeMutation,
    }) {
      const cwd = yield* current(qualified);
      const destination = qualified.destination;
      const body = bodyFor(draft, marker);
      const publicText = [draft.title, body].join("\n");
      if (
        /(?:file:\/\/|\b[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp)\/)/i.test(publicText) ||
        body.length > (destination.kind === "github" ? 64_000 : 16_000)
      )
        return yield* new IssueOperationError({
          reason: "invalid",
          message:
            "Use a bounded public summary without absolute local filesystem paths for the issue draft.",
        });
      if (destination.kind === "github") {
        const item = yield* decode(
          GithubIssue,
          yield* rest(
            qualified,
            `${ghPath(destination)}/issues`,
            "POST",
            { title: draft.title, body, labels: destination.triage.labels },
            beforeMutation,
          ),
        );
        if (item.pull_request || !item.body?.includes(`<!-- ${marker} -->`))
          return yield* invalid();
        return githubRef(destination, item);
      }
      const item = yield* decode(
        AzureItem,
        yield* az(
          cwd,
          destination,
          [
            "boards",
            "work-item",
            "create",
            "--project",
            destination.project,
            "--type",
            destination.workItemType,
            "--title",
            draft.title,
            "--description",
            `<pre>${escapeHtml(body)}</pre>`,
            "--area",
            destination.areaPath,
            "--fields",
            `System.State=${destination.state}`,
            `System.Tags=${marker}`,
          ],
          beforeMutation,
        ),
      );
      return azureRef(destination, item);
    }),
    place: Effect.fn("IssuePublicationHost.place")(function* ({
      destination: qualified,
      issue,
      beforeMutation,
    }) {
      const cwd = yield* current(qualified);
      yield* requireIssue(qualified, issue);
      const destination = qualified.destination;
      if (destination.kind === "github") {
        if (destination.triage.labels.length)
          yield* rest(
            qualified,
            `${ghPath(destination)}/issues/${segment(issue.id)}/labels`,
            "POST",
            { labels: destination.triage.labels },
            beforeMutation,
          );
        if (destination.triage.kind === "labels") return;
        const board = qualified.board;
        if (board?.kind !== "github-project" || !board.projectNodeId || !board.statusFieldId)
          return yield* invalid();
        const credential = yield* api
          .credential(destination.host)
          .pipe(Effect.mapError(remoteError));
        if (credential.fingerprint !== qualified.credentialNamespace) return yield* invalid();
        const mutate = (query: string, variables: Readonly<Record<string, unknown>>) =>
          api
            .graphql({
              host: destination.host,
              operation: "IssuePublication.place",
              query,
              variables,
            })
            .pipe(
              Effect.provideService(GitHubApi.PinnedGitHubCredential, {
                host: destination.host,
                token: credential.token,
                credentialFingerprint: credential.fingerprint,
              }),
              Effect.provideService(
                GitHubApi.BeforeGitHubMutation,
                beforeMutation.pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitHubApi.GitHubApiRequestError({
                        host: destination.host,
                        operation: "IssuePublication.place",
                        cause,
                      }),
                  ),
                ),
              ),
              Effect.mapError(remoteError),
            );
        const live = yield* host.board(cwd, board);
        let itemId = live.items.find(
          (entry) =>
            IssueHost.canonicalIssueKey(entry.issue.ref) === IssueHost.canonicalIssueKey(issue),
        )?.itemId;
        if (!itemId) {
          const item = yield* decode(
            GithubIssue,
            yield* rest(qualified, `${ghPath(destination)}/issues/${segment(issue.id)}`),
          );
          const response = yield* decode(
            Schema.Struct({
              data: Schema.Struct({
                addProjectV2ItemById: Schema.Struct({ item: Schema.Struct({ id: Schema.String }) }),
              }),
            }),
            yield* mutate(
              "mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}",
              { project: board.projectNodeId, content: item.node_id },
            ),
          );
          itemId = response.data.addProjectV2ItemById.item.id;
        }
        yield* mutate(
          "mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}",
          {
            project: board.projectNodeId,
            item: itemId,
            field: board.statusFieldId,
            option: destination.triage.columnId,
          },
        );
        return;
      }
      const metadata = yield* azBoard(cwd, destination, qualified);
      const column = metadata.columns.find((entry) => entry.id === destination.columnId);
      if (!column || column.stateMappings[destination.workItemType] !== destination.state)
        return yield* invalid();
      yield* az(
        cwd,
        destination,
        [
          "boards",
          "work-item",
          "update",
          "--id",
          issue.id,
          "--state",
          destination.state,
          "--area",
          destination.areaPath,
          "--fields",
          `${metadata.fields.columnField.referenceName}=${column.name}`,
          ...(metadata.fields.doneField
            ? [`${metadata.fields.doneField.referenceName}=false`]
            : []),
        ],
        beforeMutation,
      );
    }),
  });
});

export const layer = Layer.effect(IssuePublicationHost, make);
