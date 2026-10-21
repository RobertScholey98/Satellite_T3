import {
  IssueOperationError,
  IssueRef,
  type IssueBoardLocator,
  type RepositoryIdentity,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import * as AzureBoardsCli from "@t3tools/source-control-azure-devops/server/AzureBoardsCli";
import * as AzureBoardsIssueHost from "@t3tools/source-control-azure-devops/server/AzureBoardsIssueHost";
import type {
  IssueHostAdapter,
  IssueHostBoards,
  IssueHostScope,
} from "@t3tools/source-control-core/server/IssueHostAdapter";
import * as GitHubIssueHost from "@t3tools/source-control-github/server/GitHubIssueHost";
import {
  detectSourceControlProviderFromRemoteUrl,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** Persisted as `issue_key` in every issue table; changing the format orphans stored rows. */
export const canonicalIssueKey = (ref: IssueRef) =>
  ref.hostKind === "azure-devops"
    ? `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.split("/")[0]!.toLowerCase()}:${ref.id}`
    : `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.toLowerCase()}:${ref.id}`;

/**
 * Issue hosts by kind, and board hosts by locator kind. Hosts without an adapter, such as GitLab
 * or Forgejo, report issues as unavailable.
 */
export class IssueHost extends Context.Service<
  IssueHost,
  {
    readonly forHost: (kind: SourceControlProviderKind) => IssueHostAdapter | null;
    readonly forBoard: (locator: IssueBoardLocator) => IssueHostBoards | null;
  }
>()("t3/issues/IssueHost") {}

const decodeHostKind = Schema.decodeUnknownEffect(IssueRef.fields.hostKind);
const unavailable = (message: string) =>
  new IssueOperationError({ reason: "unavailable", message });

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

export const layer = Layer.effect(
  IssueHost,
  Effect.map(Effect.all([GitHubIssueHost.make, AzureBoardsIssueHost.make]), fromAdapters),
).pipe(Layer.provide(AzureBoardsCli.layer));
