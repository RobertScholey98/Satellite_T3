import { sha256 } from "@noble/hashes/sha2";
import {
  IssueOperationError,
  type EnvironmentId,
  type IssueAttemptGeneration,
  type IssueDeliveriesDeliverInput,
  type IssuePeersForgetInput,
  type IssuePeersRegisterInput,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import { IssueService } from "./IssueService.ts";
import {
  IssuePeerTransport,
  IssuePeerUnauthorizedError,
  IssuePeerUnreachableError,
  type IssuePeerConnection,
} from "./IssuePeerTransport.ts";

/**
 * The board's environment collects lifecycle receipts from each worktree environment it reserved
 * attempts for. One round per peer pulls unacknowledged receipts, consumes them locally,
 * acknowledges what applied, and pushes manual-move generations back.
 */
export class IssueDelivery extends Context.Service<
  IssueDelivery,
  {
    readonly registerPeer: (
      input: IssuePeersRegisterInput,
    ) => Effect.Effect<void, IssueOperationError>;
    readonly forgetPeer: (input: IssuePeersForgetInput) => Effect.Effect<void, IssueOperationError>;
    /** Queues a round for every peer holding attempts on the board, ignoring backoff. */
    readonly deliver: (
      input: IssueDeliveriesDeliverInput,
    ) => Effect.Effect<void, IssueOperationError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/issues/IssueDelivery") {}

const ROUND_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const SCHEDULE_TICK = "15 seconds";

type DeliveryWork =
  | { readonly _tag: "due" }
  | { readonly _tag: "peer"; readonly destination: EnvironmentId };

interface PeerRow {
  endpoints_json: string;
  public_key: string;
  preferred_endpoint: string | null;
  state: string;
  last_error: string | null;
  last_delivered_at: string | null;
  failures: number;
}

const storageError = () =>
  new IssueOperationError({
    reason: "storage",
    message: "Could not read or save issue delivery state.",
  });
const isIssueError = Schema.is(IssueOperationError);
const decodeEndpoints = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeEndpoints = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Secret file names stay filesystem-safe whatever an environment ID contains. */
const credentialName = (destination: string) =>
  `issue-peer-${Hex.encode(sha256(new TextEncoder().encode(destination))).slice(0, 32)}`;

const backoffMs = (failures: number) =>
  Math.min(ROUND_INTERVAL_MS * 2 ** Math.max(failures - 1, 0), MAX_BACKOFF_MS);

const chunks = <A>(values: ReadonlyArray<A>, size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, index * size + size),
  );

const httpEndpoint = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* IssueService;
  const transport = yield* IssuePeerTransport;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => (isIssueError(cause) ? cause : storageError())));

  const collect = Effect.fnUntraced(function* (
    destination: EnvironmentId,
    peer: IssuePeerConnection,
  ) {
    let after = 0;
    let delivered = 0;
    const rejected: string[] = [];
    while (true) {
      const page = yield* peer.listReceipts(after);
      const receipts = page.receipts.filter(
        (receipt) =>
          receipt.link.sourceEnvironmentId === environmentId &&
          receipt.link.destinationEnvironmentId === destination,
      );
      if (receipts.length > 0) {
        const result = yield* issues.ingestReceipts({ receipts });
        if (result.acknowledgedKeys.length > 0)
          yield* peer.acknowledge({ acknowledgedKeys: result.acknowledgedKeys });
        delivered += result.acknowledgedKeys.length;
        rejected.push(...result.rejected.map((entry) => entry.message));
      }
      if (page.receipts.length === 0 || page.nextCursor <= after) break;
      after = page.nextCursor;
    }
    // Only started attempts are known at the destination; it rejects a batch naming any other.
    const generations: IssueAttemptGeneration[] = (yield* issues.listAttempts({}))
      .filter(
        (attempt) =>
          attempt.link.sourceEnvironmentId === environmentId &&
          attempt.link.destinationEnvironmentId === destination &&
          attempt.status === "started" &&
          attempt.sourceGeneration > 0,
      )
      .map((attempt) => ({
        attemptId: attempt.link.attemptId,
        reservationId: attempt.link.reservationId,
        sourceGeneration: attempt.sourceGeneration,
      }));
    for (const batch of chunks(generations, 100))
      yield* peer.syncGenerations({ generations: batch });
    return { delivered, rejected };
  });

  const round = (destination: EnvironmentId) =>
    Effect.gen(function* () {
      const rows = yield* sql<PeerRow>`SELECT * FROM issue_delivery_peers
        WHERE destination_environment_id=${destination}`;
      const row = rows[0];
      if (!row) return;
      const endpoints = yield* decodeEndpoints(row.endpoints_json);
      const ordered = row.preferred_endpoint
        ? [row.preferred_endpoint, ...endpoints.filter((value) => value !== row.preferred_endpoint)]
        : endpoints;
      const credential = yield* secrets.get(credentialName(destination));
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          if (Option.isNone(credential)) return yield* new IssuePeerUnauthorizedError({});
          if (ordered.length === 0) return yield* new IssuePeerUnreachableError({ endpoints: 0 });
          const peer = yield* transport.connect({
            destinationEnvironmentId: destination,
            endpoints: ordered,
            credential: new TextDecoder().decode(credential.value),
            publicKey: row.public_key,
          });
          return { endpoint: peer.endpoint, ...(yield* collect(destination, peer)) };
        }),
      ).pipe(Effect.result);
      const at = DateTime.formatIso(yield* DateTime.now);
      const nowMs = yield* Clock.currentTimeMillis;
      if (outcome._tag === "Success") {
        const { endpoint, delivered, rejected } = outcome.success;
        const state = rejected.length > 0 ? "failed" : "delivered";
        const deliveredAt = delivered > 0 ? at : row.last_delivered_at;
        yield* sql`UPDATE issue_delivery_peers SET preferred_endpoint=${endpoint},
          state=${state}, last_error=${rejected[0] ?? null},
          last_attempt_at=${at}, last_delivered_at=${deliveredAt},
          failures=0, next_attempt_at=${nowMs + ROUND_INTERVAL_MS}
          WHERE destination_environment_id=${destination}`;
        if (
          state !== row.state ||
          (rejected[0] ?? null) !== row.last_error ||
          deliveredAt !== row.last_delivered_at
        )
          yield* issues.publishDeliveries(destination);
        return;
      }
      const failure = outcome.failure;
      const state =
        failure._tag === "IssuePeerUnreachableError"
          ? "unreachable"
          : failure._tag === "IssuePeerUnauthorizedError"
            ? "unauthorized"
            : "failed";
      yield* sql`UPDATE issue_delivery_peers SET state=${state}, last_error=${failure.message},
        last_attempt_at=${at}, failures=failures+1,
        next_attempt_at=${nowMs + backoffMs(row.failures + 1)}
        WHERE destination_environment_id=${destination}`;
      if (state !== row.state || failure.message !== row.last_error)
        yield* issues.publishDeliveries(destination);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("issue delivery round failed", { cause })),
    );

  const roundDuePeers = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{
      destination_environment_id: EnvironmentId;
    }>`SELECT destination_environment_id FROM issue_delivery_peers WHERE next_attempt_at<=${nowMs}`;
    for (const row of rows) yield* round(row.destination_environment_id);
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("issue delivery schedule failed", { cause })),
  );

  const worker = yield* makeDrainableWorker((work: DeliveryWork) =>
    work._tag === "due" ? roundDuePeers : round(work.destination),
  );

  const registerPeer: IssueDelivery["Service"]["registerPeer"] = (input) =>
    protect(
      Effect.gen(function* () {
        if (input.destinationEnvironmentId === environmentId)
          return yield* new IssueOperationError({
            reason: "invalid",
            message: "A board's own environment does not need a delivery peer.",
          });
        const endpoints = [
          ...new Set(input.endpoints.map(httpEndpoint).filter((value) => value !== null)),
        ];
        yield* secrets.set(
          credentialName(input.destinationEnvironmentId),
          new TextEncoder().encode(input.credential),
        );
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO issue_delivery_peers(destination_environment_id,endpoints_json,public_key,state,registered_at)
          VALUES(${input.destinationEnvironmentId},${encodeEndpoints(endpoints)},${input.publicKey},'pending',${at})
          ON CONFLICT(destination_environment_id) DO UPDATE SET endpoints_json=excluded.endpoints_json,
            public_key=excluded.public_key,
            preferred_endpoint=NULL,state='pending',last_error=NULL,failures=0,next_attempt_at=0`;
        yield* issues.publishDeliveries(input.destinationEnvironmentId);
        yield* worker.enqueue({ _tag: "peer", destination: input.destinationEnvironmentId });
      }),
    );

  const forgetPeer: IssueDelivery["Service"]["forgetPeer"] = (input) =>
    protect(
      Effect.gen(function* () {
        yield* sql`DELETE FROM issue_delivery_peers
          WHERE destination_environment_id=${input.destinationEnvironmentId}`;
        yield* secrets.remove(credentialName(input.destinationEnvironmentId));
        yield* issues.publishDeliveries(input.destinationEnvironmentId);
      }),
    );

  const deliver: IssueDelivery["Service"]["deliver"] = (input) =>
    protect(
      Effect.gen(function* () {
        const destinations = new Set(
          (yield* issues.listAttempts({ boardId: input.boardId }))
            .filter((attempt) => attempt.link.destinationEnvironmentId !== environmentId)
            .map((attempt) => attempt.link.destinationEnvironmentId),
        );
        for (const destination of destinations)
          yield* worker.enqueue({ _tag: "peer", destination });
      }),
    );

  return IssueDelivery.of({
    registerPeer,
    forgetPeer,
    deliver,
    start: Effect.fn("IssueDelivery.start")(function* () {
      yield* forkParked(
        worker
          .enqueue({ _tag: "due" })
          .pipe(Effect.andThen(Effect.sleep(SCHEDULE_TICK)), Effect.forever),
      );
    }),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(IssueDelivery, make);
