import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  EnvironmentAuthInvalidError,
  EnvironmentAuthorizationError,
  EnvironmentHttpApi,
  IssueOperationError,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  SATELLITE_WS_METHODS,
  WsSatelliteRpcGroup,
  type EnvironmentId,
  type IssueAttemptsAcknowledgeInput,
  type IssueAttemptsReceiptsResult,
  type IssueAttemptsSyncGenerationsInput,
  type SatelliteWsRpcMethod,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

export class IssuePeerUnreachableError extends Schema.TaggedError<IssuePeerUnreachableError>()(
  "IssuePeerUnreachableError",
  {
    endpoints: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.endpoints === 0
      ? "The worktree computer shares no network address this computer can reach. It may listen on loopback only."
      : "The worktree computer could not be reached on any of its network addresses.";
  }
}

export class IssuePeerUnauthorizedError extends Schema.TaggedError<IssuePeerUnauthorizedError>()(
  "IssuePeerUnauthorizedError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The worktree computer no longer accepts this computer's credential. Start a ticket on it again from a Satellite window connected to both computers.";
  }
}

export type IssuePeerError =
  | IssuePeerUnreachableError
  | IssuePeerUnauthorizedError
  | IssueOperationError;

export interface IssuePeer {
  readonly destinationEnvironmentId: EnvironmentId;
  /** Tried in order; the first that answers as the destination is used. */
  readonly endpoints: ReadonlyArray<string>;
  readonly credential: string;
}

/** The destination's three peer RPCs over one open connection. */
export interface IssuePeerConnection {
  readonly endpoint: string;
  readonly listReceipts: (
    after: number,
  ) => Effect.Effect<IssueAttemptsReceiptsResult, IssuePeerError>;
  readonly acknowledge: (
    input: IssueAttemptsAcknowledgeInput,
  ) => Effect.Effect<void, IssuePeerError>;
  readonly syncGenerations: (
    input: IssueAttemptsSyncGenerationsInput,
  ) => Effect.Effect<void, IssuePeerError>;
}

/**
 * How the board's environment reaches a worktree environment. Opening a connection is the
 * reachability probe; the connection closes with its scope.
 */
export class IssuePeerTransport extends Context.Service<
  IssuePeerTransport,
  {
    readonly connect: (
      peer: IssuePeer,
    ) => Effect.Effect<IssuePeerConnection, IssuePeerError, Scope.Scope>;
  }
>()("t3/issues/IssuePeerTransport") {}

type PeerMethod =
  | typeof SATELLITE_WS_METHODS.issuesAttemptsReceipts
  | typeof SATELLITE_WS_METHODS.issuesAttemptsAcknowledge
  | typeof SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations;
/** The destination RPCs a board environment calls. */
export const ISSUE_PEER_METHODS: ReadonlySet<string> = new Set<PeerMethod>([
  SATELLITE_WS_METHODS.issuesAttemptsReceipts,
  SATELLITE_WS_METHODS.issuesAttemptsAcknowledge,
  SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations,
]);
export const IssuePeerRpcs = WsSatelliteRpcGroup.omit(
  ...[...WsSatelliteRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<SatelliteWsRpcMethod, PeerMethod> => !ISSUE_PEER_METHODS.has(tag),
  ),
);
const isIssueError = Schema.is(IssueOperationError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const REQUEST_TIMEOUT = "10 seconds";
const CALL_TIMEOUT = "30 seconds";

/**
 * Reaches the destination the way a paired client does: confirm the endpoint answers as the
 * destination before sending the credential, exchange the credential for a short-lived socket
 * ticket so it stays out of URLs, then call the peer RPCs over the ordinary RPC socket.
 */
const makeSocket = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  const openEndpoint = Effect.fnUntraced(function* (endpoint: string, peer: IssuePeer) {
    const unreachable = (cause: unknown) =>
      new IssuePeerUnreachableError({ endpoints: peer.endpoints.length, cause });
    const metadata = yield* HttpApiClient.group(EnvironmentHttpApi, {
      httpClient,
      group: "metadata",
      baseUrl: endpoint,
    });
    const descriptor = yield* metadata
      .descriptor()
      .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(unreachable));
    if (descriptor.environmentId !== peer.destinationEnvironmentId)
      return yield* unreachable("A different environment answered on this address.");
    const auth = yield* HttpApiClient.group(EnvironmentHttpApi, {
      httpClient,
      group: "auth",
      baseUrl: endpoint,
    });
    const { ticket } = yield* auth
      .webSocketTicket({ headers: { authorization: `Bearer ${peer.credential}` } })
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) =>
          isAuthInvalidError(cause)
            ? new IssuePeerUnauthorizedError({ cause })
            : unreachable(cause),
        ),
      );
    const url = new URL("/ws", endpoint);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(url.toString(), { openTimeout: REQUEST_TIMEOUT }).pipe(
              Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    );
    const client = yield* RpcClient.make(IssuePeerRpcs).pipe(Effect.provideContext(protocol));
    const call = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.timeout(CALL_TIMEOUT),
        Effect.mapError((cause): IssuePeerError =>
          isIssueError(cause)
            ? cause
            : isAuthorizationError(cause)
              ? new IssuePeerUnauthorizedError({ cause })
              : unreachable(cause),
        ),
      );
    return {
      endpoint,
      listReceipts: (after) => call(client[SATELLITE_WS_METHODS.issuesAttemptsReceipts]({ after })),
      acknowledge: (input) => call(client[SATELLITE_WS_METHODS.issuesAttemptsAcknowledge](input)),
      syncGenerations: (input) =>
        call(client[SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations](input)),
    } satisfies IssuePeerConnection;
  });

  return IssuePeerTransport.of({
    connect: Effect.fnUntraced(function* (peer) {
      let failure: IssuePeerError = new IssuePeerUnreachableError({
        endpoints: peer.endpoints.length,
      });
      for (const endpoint of peer.endpoints) {
        const opened = yield* openEndpoint(endpoint, peer).pipe(Effect.result);
        if (opened._tag === "Success") return opened.success;
        failure = opened.failure;
        // The descriptor proved this endpoint is the destination; its other addresses refuse too.
        if (failure._tag === "IssuePeerUnauthorizedError") break;
      }
      return yield* failure;
    }),
  });
});

export const layerSocket = Layer.effect(IssuePeerTransport, makeSocket).pipe(
  Layer.provide(NodeSocket.layerWebSocketConstructor),
);
