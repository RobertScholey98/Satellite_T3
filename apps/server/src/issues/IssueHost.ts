import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  IssueOperationError,
  IssueRef,
  PositiveInt,
  TrimmedNonEmptyString,
  type IssueBoardLocator,
  type IssueDetail,
  type RepositoryIdentity,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  detectSourceControlProviderFromRemoteUrl,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";
import { GitLabCli } from "../sourceControl/GitLabCli.ts";
import { ForgejoCli } from "../sourceControl/ForgejoCli.ts";
import { BitbucketApi } from "../sourceControl/BitbucketApi.ts";
import * as AzureBoardsIssueHost from "./AzureBoardsIssueHost.ts";
import * as BitbucketIssueHost from "./BitbucketIssueHost.ts";
import * as ForgejoIssueHost from "./ForgejoIssueHost.ts";
import * as GitHubIssueHost from "./GitHubIssueHost.ts";
import * as GitLabIssueHost from "./GitLabIssueHost.ts";
import {
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
  type IssueHostAdapter,
  type IssueHostBoards,
  type IssueHostScope,
} from "./IssueHostAdapter.ts";

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
const validateIssue = (scope: IssueHostScope, raw: unknown) =>
  validate(
    scope.ref.hostKind === "gitlab"
      ? GitlabIssueResponse
      : scope.ref.hostKind === "bitbucket"
        ? BitbucketIssueResponse
        : GithubIssueResponse,
    raw,
  );
const actor = (value: unknown) => {
  const user = obj(value);
  const name = str(user.login) || str(user.name) || str(user.display_name) || str(user.displayName);
  return name
    ? { name, avatarUrl: str(user.avatar_url) || str(obj(obj(user.links).avatar).href) }
    : null;
};
export const canonicalIssueKey = (ref: IssueRef) =>
  ref.hostKind === "azure-devops"
    ? `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.split("/")[0]!.toLowerCase()}:${ref.id}`
    : `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.toLowerCase()}:${ref.id}`;
const issueFromHost = (scope: IssueHostScope, raw: Record<string, unknown>): IssueDetail => {
  const id = num(raw.number) || num(raw.iid) || num(raw.id);
  const links = obj(raw.links);
  const content = obj(raw.content);
  return {
    ref: {
      ...scope.ref,
      id: String(id),
      number: id,
      url: str(raw.html_url) || str(raw.web_url) || str(obj(links.html).href) || scope.ref.url,
    },
    title: str(raw.title),
    state: str(raw.state),
    updatedAt: str(raw.updated_at) || str(raw.updated_on),
    labels: labelNames(raw.labels),
    body: str(raw.body) || str(raw.description) || str(content.raw),
    author: actor(raw.user ?? raw.author),
    assignees: arr(raw.assignees)
      .map(actor)
      .filter((value) => value !== null),
    createdAt: str(raw.created_at) || str(raw.created_on),
  };
};

export const makeIssueHost = (options: {
  readonly gitlab: Pick<GitLabCli["Service"], "execute">;
  readonly forgejo: Pick<ForgejoCli["Service"], "api">;
  readonly bitbucket: Pick<BitbucketApi["Service"], "request">;
}) => {
  const { gitlab, forgejo, bitbucket } = options;
  const gl = (cwd: string, host: string, endpoint: string) =>
    gitlab
      .execute({
        cwd,
        args: ["api", "--hostname", host, endpoint],
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(
        Effect.map((output) => output.stdout),
        Effect.mapError(remoteIssueError),
      );
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
          .pipe(Effect.mapError(remoteIssueError))).stdout,
      );
    else if (ref.hostKind === "bitbucket")
      raw = yield* readRecord(
        (yield* bitbucket
          .request({
            method: "GET",
            url: `repositories/${ref.repository}/issues/${segment(ref.id)}`,
            maxBytes: 4 * 1024 * 1024,
          })
          .pipe(Effect.mapError(remoteIssueError))).body,
      );
    else
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
        entries = yield* decodeHostJson(
          Schema.Array(JsonRecord),
          yield* gl(
            cwd,
            ref.host,
            `projects/${segment(ref.repository)}/issues/${segment(ref.id)}/notes?per_page=100&page=${page}`,
          ),
        );
      else if (ref.hostKind === "forgejo")
        entries = yield* decodeHostJson(
          Schema.Array(JsonRecord),
          (yield* forgejo
            .api({
              cwd,
              host: ref.host,
              repository: ref.repository,
              path: `repos/${ref.repository}/issues/${segment(ref.id)}/comments?limit=100&page=${page}`,
            })
            .pipe(Effect.mapError(remoteIssueError))).stdout,
        );
      else {
        const response = yield* readRecord(
          (yield* bitbucket
            .request({
              method: "GET",
              url: `repositories/${ref.repository}/issues/${segment(ref.id)}/comments?pagelen=100&page=${page}`,
            })
            .pipe(Effect.mapError(remoteIssueError))).body,
        );
        entries = (yield* validate(Schema.Struct({ values: Schema.Array(JsonRecord) }), response))
          .values;
        continuation = str(response.next) || null;
      }
      commentEntries.push(...entries);
      more = ref.hostKind === "bitbucket" ? continuation !== null : entries.length === 100;
      page++;
    } while (more);
    return yield* toIssueDetail({
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
    });
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
          .pipe(Effect.mapError(remoteIssueError))).stdout;
      entries = yield* decodeHostJson(Schema.Array(JsonRecord), text);
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
      entries = (yield* validate(Schema.Struct({ values: Schema.Array(JsonRecord) }), response))
        .values;
      if (str(response.next)) nextCursor = String(page + 1);
    } else
      return yield* new IssueOperationError({
        reason: "unavailable",
        message: "This repository host does not expose issues.",
      });
    const issues = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        yield* validateIssue(scope, entry);
        return yield* toIssueSummary(issueFromHost(scope, obj(entry)));
      }),
    );
    return { issues, nextCursor };
  });
  return (["gitlab", "forgejo", "bitbucket"] as const).map((kind): IssueHostAdapter => ({
    kind,
    list,
    get,
  }));
};

export class IssueHost extends Context.Service<
  IssueHost,
  {
    /** Null for a host kind with no adapter, which the issue service reports as unavailable. */
    readonly forHost: (kind: SourceControlProviderKind) => IssueHostAdapter | null;
    readonly forBoard: (locator: IssueBoardLocator) => IssueHostBoards | null;
  }
>()("t3/issues/IssueHost") {}

const decodeHostKind = Schema.decodeUnknownEffect(IssueRef.fields.hostKind);
const unavailable = (message: string) =>
  new IssueOperationError({ reason: "unavailable", message });

/** The repository a project's issues live in, as the scope every adapter operation takes. */
export const repositoryIssueScope = Effect.fnUntraced(function* (
  cwd: string,
  identity: RepositoryIdentity | null | undefined,
): Effect.fn.Return<IssueHostScope, IssueOperationError> {
  const repository =
    identity?.provider === "azure-devops"
      ? identity.displayName?.split("/_git/")[0]
      : sourceControlRepositorySelector(identity);
  if (!identity || !repository || !identity.provider)
    return yield* unavailable("This project has no supported repository host.");
  const kind = yield* decodeHostKind(identity.provider).pipe(
    Effect.mapError(() => unavailable("This repository host does not support issues.")),
  );
  const detected = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
  const host =
    kind === "azure-devops" ? "dev.azure.com" : detected ? new URL(detected.baseUrl).host : "";
  if (!host) return yield* unavailable("This project's repository host is unknown.");
  return {
    cwd,
    ref: {
      hostKind: kind,
      host,
      repository,
      id: "0",
      number: 0,
      url: `https://${host}/${repository}`,
    },
  };
});

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

const make = Effect.map(
  Effect.all([
    GitHubIssueHost.make,
    AzureBoardsIssueHost.make,
    GitLabIssueHost.make,
    ForgejoIssueHost.make,
    BitbucketIssueHost.make,
  ]),
  fromAdapters,
);
export const layer = Layer.effect(IssueHost, make);
