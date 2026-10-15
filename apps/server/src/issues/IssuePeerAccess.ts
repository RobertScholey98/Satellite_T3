import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  IssueOperationError,
  SATELLITE_WS_METHODS,
  type AuthEnvironmentScope,
  type IssuePeerGrant,
  type IssuePeersGrantInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SessionStore from "../auth/SessionStore.ts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";

const ISSUE_PEER_SUBJECT_PREFIX = "issue-peer:";

export type IssuePeerMethod =
  | typeof SATELLITE_WS_METHODS.issuesAttemptsReceipts
  | typeof SATELLITE_WS_METHODS.issuesAttemptsAcknowledge
  | typeof SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations;
/** The destination RPCs a board environment calls. */
export const ISSUE_PEER_METHODS: ReadonlySet<string> = new Set<IssuePeerMethod>([
  SATELLITE_WS_METHODS.issuesAttemptsReceipts,
  SATELLITE_WS_METHODS.issuesAttemptsAcknowledge,
  SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations,
]);
const PEER_CREDENTIAL_TTL = Duration.days(90);

/** The board environment a peer session collects receipts for; undefined for other sessions. */
export const issuePeerSource = (subject: string): EnvironmentId | undefined =>
  subject.startsWith(ISSUE_PEER_SUBJECT_PREFIX)
    ? EnvironmentId.make(subject.slice(ISSUE_PEER_SUBJECT_PREFIX.length))
    : undefined;

/**
 * The worktree side of issue delivery. A grant is an ordinary bearer session with no scopes,
 * listed in Connections and revoked there; RPC authorization lets its subject call only the peer
 * RPCs, and the handlers limit those to the granting board environment's attempts.
 */
export class IssuePeerAccess extends Context.Service<
  IssuePeerAccess,
  {
    readonly grant: (
      input: IssuePeersGrantInput,
      caller: { readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
    ) => Effect.Effect<IssuePeerGrant, IssueOperationError>;
  }
>()("t3/issues/IssuePeerAccess") {}

export const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const directEndpoints = yield* DirectEndpoints;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  return IssuePeerAccess.of({
    grant: Effect.fn("IssuePeerAccess.grant")(function* (input, caller) {
      if (input.sourceEnvironmentId === environmentId)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "A board's own environment does not need a delivery credential.",
        });
      // The peer RPCs need both scopes; a caller without them cannot hand out their use.
      if (
        !caller.scopes.includes(AuthOrchestrationReadScope) ||
        !caller.scopes.includes(AuthOrchestrationOperateScope)
      )
        return yield* new IssueOperationError({
          reason: "authentication",
          message: "Starting tickets on this computer needs permission to operate threads.",
        });
      const issued = yield* sessions
        .issue({
          subject: `${ISSUE_PEER_SUBJECT_PREFIX}${input.sourceEnvironmentId}`,
          method: "bearer-access-token",
          scopes: [],
          client: { label: `Issue updates for ${input.sourceLabel}`, deviceType: "bot" },
          ttl: PEER_CREDENTIAL_TTL,
          replaceActiveForSubjectAndMethod: true,
        })
        .pipe(
          Effect.mapError(
            () =>
              new IssueOperationError({
                reason: "storage",
                message: "Could not create the delivery credential.",
              }),
          ),
        );
      const endpoints = yield* directEndpoints.resolve();
      return {
        credential: issued.token,
        endpoints: endpoints.map((endpoint) => endpoint.httpBaseUrl),
      };
    }),
  });
});

export const layer = Layer.effect(IssuePeerAccess, make);
