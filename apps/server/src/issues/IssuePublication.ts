import { sha256 } from "@noble/hashes/sha2";
import {
  IssueOperationError,
  IssuePublicationReceipt,
  IssuePublicationRequest,
  type IssuePublicationDestination,
  type IssuePublicationProgress,
  type IssueRef,
  type ProjectId,
  type QualifiedIssueDestination,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as IssuePublicationHost from "./IssuePublicationHost.ts";

export class IssuePublication extends Context.Service<
  IssuePublication,
  {
    readonly validate: (input: {
      readonly projectId: ProjectId;
      readonly destination: IssuePublicationDestination;
    }) => Effect.Effect<QualifiedIssueDestination, IssueOperationError>;
    readonly publish: (
      input: IssuePublicationRequest & {
        readonly beforeMutation: Effect.Effect<void, IssueOperationError>;
      },
    ) => Effect.Effect<IssuePublicationReceipt, IssueOperationError>;
    readonly read: (
      requestId: string,
    ) => Effect.Effect<IssuePublicationReceipt | undefined, IssueOperationError>;
    readonly linkExisting: (
      input: IssuePublicationRequest & { readonly issue: IssueRef },
    ) => Effect.Effect<IssuePublicationReceipt, IssueOperationError>;
  }
>()("t3/issues/IssuePublication") {}

const hash = (value: unknown) =>
  Hex.encode(sha256(new TextEncoder().encode(stableStringify(value))));
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(IssuePublicationRequest));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(IssuePublicationReceipt));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(IssuePublicationReceipt));
const decodeRequest = Schema.decodeEffect(IssuePublicationRequest);
const storageError = () =>
  new IssueOperationError({
    reason: "storage",
    message: "Could not read or save the issue publication journal.",
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const host = yield* IssuePublicationHost.IssuePublicationHost;
  const mutex = yield* Semaphore.make(1);
  const readRow = Effect.fnUntraced(function* (requestId: string) {
    const rows = yield* sql<{
      request_json: string;
      receipt_json: string;
      create_attempted: number;
    }>`SELECT request_json, receipt_json, create_attempted FROM issue_publications WHERE request_id=${requestId}`.pipe(
      Effect.mapError(storageError),
    );
    const row = rows[0];
    return row
      ? {
          receipt: yield* decodeReceipt(row.receipt_json).pipe(Effect.mapError(storageError)),
          attempted: row.create_attempted === 1,
        }
      : undefined;
  });
  const save = Effect.fnUntraced(function* (
    receipt: IssuePublicationReceipt,
    progress: IssuePublicationProgress,
  ) {
    const next: IssuePublicationReceipt = { ...receipt, progress, updatedAt: yield* now };
    yield* sql`UPDATE issue_publications SET receipt_json=${encodeReceipt(next)} WHERE request_id=${receipt.requestId}`.pipe(
      Effect.mapError(storageError),
    );
    return next;
  });
  const reserve = Effect.fnUntraced(function* (input: IssuePublicationRequest) {
    const request = yield* decodeRequest(input).pipe(
      Effect.mapError(
        () =>
          new IssueOperationError({
            reason: "invalid",
            message: "The issue publication request is invalid.",
          }),
      ),
    );
    if (request.projectId !== request.destination.projectId)
      return yield* new IssueOperationError({
        reason: "invalid",
        message: "The destination belongs to another project.",
      });
    const requestDigest = hash(request);
    const timestamp = yield* now;
    const receipt: IssuePublicationReceipt = {
      requestId: request.requestId,
      requestDigest,
      destination: request.destination,
      marker: `satellite-followup:${hash(request.requestId)}`,
      progress: { status: "reserved" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    yield* sql`INSERT OR IGNORE INTO issue_publications (request_id, request_json, receipt_json) VALUES (${request.requestId}, ${encodeRequest(request)}, ${encodeReceipt(receipt)})`.pipe(
      Effect.mapError(storageError),
    );
    const row = yield* readRow(request.requestId);
    if (!row || row.receipt.requestDigest !== requestDigest)
      return yield* new IssueOperationError({
        reason: "conflict",
        message: "This publication identity already belongs to a different request.",
      });
    return row;
  });
  const publish: IssuePublication["Service"]["publish"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* reserve(input);
        let receipt = row.receipt;
        if (receipt.progress.status === "triaged") return receipt;
        let issue = "issue" in receipt.progress ? receipt.progress.issue : undefined;
        if (!issue) {
          const lookup = yield* host
            .lookup({ destination: input.destination, marker: receipt.marker })
            .pipe(Effect.result);
          if (lookup._tag === "Failure")
            return yield* save(receipt, {
              status: row.attempted ? "outcome-unknown" : "blocked",
              reason:
                "The publication marker could not be reconciled. Retry after the tracker can be read.",
            });
          if (!lookup.success.complete || lookup.success.issues.length > 1)
            return yield* save(receipt, {
              status: "outcome-unknown",
              reason:
                "The marker lookup is incomplete or matches multiple issues. Link the intended existing issue explicitly.",
            });
          issue = lookup.success.issues[0];
          if (!issue && row.attempted)
            return yield* save(receipt, {
              status: "outcome-unknown",
              reason:
                "The tracker has not confirmed the earlier create attempt. No second issue will be created; reconcile or link the existing issue.",
            });
          if (!issue) {
            const beforeCreate = Effect.gen(function* () {
              yield* input.beforeMutation;
              // Claim inside the host's write queue, after live admission. A crash after this
              // durable claim remains ambiguous; a rejected admission is safe to retry.
              const claimed = yield* sql<{
                request_id: string;
              }>`UPDATE issue_publications SET create_attempted=1 WHERE request_id=${input.requestId} AND create_attempted=0 RETURNING request_id`.pipe(
                Effect.mapError(storageError),
              );
              if (!claimed.length)
                return yield* new IssueOperationError({
                  reason: "conflict",
                  message: "Issue creation was already attempted; reconcile its outcome.",
                });
            });
            const created = yield* host
              .create({
                destination: input.destination,
                draft: input.draft,
                marker: receipt.marker,
                beforeMutation: beforeCreate,
              })
              .pipe(Effect.result);
            if (created._tag === "Failure") {
              const latest = yield* readRow(input.requestId);
              if (latest && "issue" in latest.receipt.progress) return latest.receipt;
              return yield* save(receipt, {
                status: latest?.attempted ? "outcome-unknown" : "blocked",
                reason: latest?.attempted
                  ? "The tracker did not confirm issue creation. Retry reconciliation; no duplicate create will be sent."
                  : created.failure.message,
              });
            }
            issue = created.success;
          }
          receipt = yield* save(receipt, { status: "created", issue });
        }
        const inspected = yield* host
          .inspect({ destination: input.destination, issue })
          .pipe(Effect.result);
        if (inspected._tag === "Success" && inspected.success)
          return yield* save(receipt, {
            status: "triaged",
            issue,
            placement: inspected.success,
            verifiedAt: yield* now,
          });
        if (inspected._tag === "Failure")
          return yield* save(receipt, {
            status: "placement-pending",
            issue,
            reason:
              "The existing issue could not be verified. Retry when its identity and destination can be read.",
          });
        const placed = yield* host
          .place({ destination: input.destination, issue, beforeMutation: input.beforeMutation })
          .pipe(Effect.result);
        if (placed._tag === "Failure")
          return yield* save(receipt, {
            status: "placement-pending",
            issue,
            reason:
              "The issue exists, but its configured triage placement has not been confirmed. Retry placement on this same issue.",
          });
        const verified = yield* host
          .inspect({ destination: input.destination, issue })
          .pipe(Effect.result);
        return yield* save(
          receipt,
          verified._tag === "Success" && verified.success
            ? { status: "triaged", issue, placement: verified.success, verifiedAt: yield* now }
            : {
                status: "placement-pending",
                issue,
                reason: "The tracker has not read back the exact configured triage placement.",
              },
        );
      }),
    );
  return IssuePublication.of({
    validate: host.validate,
    read: (id) => readRow(id).pipe(Effect.map((row) => row?.receipt)),
    publish,
    linkExisting: (input) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const { receipt } = yield* reserve(input);
          if ("issue" in receipt.progress && receipt.progress.issue.id !== input.issue.id)
            return yield* new IssueOperationError({
              reason: "conflict",
              message: "This publication already identifies a different issue.",
            });
          const placement = yield* host.inspect({
            destination: input.destination,
            issue: input.issue,
          });
          return yield* save(
            receipt,
            placement
              ? { status: "triaged", issue: input.issue, placement, verifiedAt: yield* now }
              : {
                  status: "placement-pending",
                  issue: input.issue,
                  reason: "The linked issue exists but is not in the approved triage destination.",
                },
          );
        }),
      ),
  });
});

export const layer = Layer.effect(IssuePublication, make);
