import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  IssueOperationError,
  SATELLITE_WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type IssuePeerGrant,
  type IssuePeerIdentity,
  type IssuePeersGrantInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "../auth/SessionStore.ts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { identityProofMessage, ISSUE_PEER_PROOF_PATH, IssuePeerKeys } from "./IssuePeerKeys.ts";

const ISSUE_PEER_SUBJECT_PREFIX = "issue-peer:";

export type IssuePeerMethod =
  | typeof SATELLITE_WS_METHODS.issuesAttemptsReceipts
  | typeof SATELLITE_WS_METHODS.issuesAttemptsAcknowledge
  | typeof SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations
  | typeof SATELLITE_WS_METHODS.issuesPeersRelease;
/** The destination RPCs a board environment calls. */
export const ISSUE_PEER_METHODS: ReadonlySet<string> = new Set<IssuePeerMethod>([
  SATELLITE_WS_METHODS.issuesAttemptsReceipts,
  SATELLITE_WS_METHODS.issuesAttemptsAcknowledge,
  SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations,
  SATELLITE_WS_METHODS.issuesPeersRelease,
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
    /** Revokes the calling peer session, so a forgotten board environment loses access at once. */
    readonly release: (session: {
      readonly sessionId: AuthSessionId;
      readonly subject: string;
    }) => Effect.Effect<void, IssueOperationError>;
    /** The key a worktree environment checks this board environment's generation pushes with. */
    readonly identity: Effect.Effect<IssuePeerIdentity>;
  }
>()("t3/issues/IssuePeerAccess") {}

export const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const directEndpoints = yield* DirectEndpoints;
  const keys = yield* IssuePeerKeys;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const storageError = () =>
    new IssueOperationError({
      reason: "storage",
      message: "Could not create the delivery credential.",
    });
  return IssuePeerAccess.of({
    identity: Effect.succeed({ publicKey: keys.publicKey }),
    release: Effect.fn("IssuePeerAccess.release")(function* (session) {
      const source = issuePeerSource(session.subject);
      if (source === undefined)
        return yield* new IssueOperationError({
          reason: "invalid",
          message: "Only a board environment's delivery session can release itself.",
        });
      yield* sessions.revoke(session.sessionId).pipe(Effect.mapError(storageError));
      yield* sql`DELETE FROM issue_peer_grants WHERE source_environment_id=${source}`.pipe(
        Effect.mapError(storageError),
      );
    }),
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
        .pipe(Effect.mapError(storageError));
      yield* sql`INSERT INTO issue_peer_grants(source_environment_id,public_key)
        VALUES(${input.sourceEnvironmentId},${input.sourcePublicKey})
        ON CONFLICT(source_environment_id) DO UPDATE SET public_key=excluded.public_key`.pipe(
        Effect.mapError(storageError),
      );
      const endpoints = yield* directEndpoints.resolve();
      return {
        credential: issued.token,
        endpoints: endpoints.map((endpoint) => endpoint.httpBaseUrl),
        publicKey: keys.publicKey,
        expiresAt: DateTime.formatIso(DateTime.toUtc(issued.expiresAt)),
      };
    }),
  });
});

export const layer = Layer.effect(IssuePeerAccess, make);

const ProofRequest = Schema.Struct({
  nonce: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128)),
  endpoint: Schema.String.check(Schema.isMaxLength(512)),
});

/**
 * Signs a board environment's fresh nonce, the endpoint it dialled, and this environment's ID.
 * The board environment sends its credential only after the signature verifies against the key
 * it received with the grant.
 */
export const proofRoute = Layer.unwrap(
  Effect.gen(function* () {
    const keys = yield* IssuePeerKeys;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    return HttpRouter.add(
      "POST",
      ISSUE_PEER_PROOF_PATH,
      HttpServerRequest.schemaBodyJson(ProofRequest).pipe(
        Effect.flatMap((request) =>
          HttpServerResponse.json({
            signature: keys.sign(identityProofMessage({ environmentId, ...request })),
          }),
        ),
        Effect.catchTags({
          SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
          HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
        }),
      ),
    );
  }),
);
