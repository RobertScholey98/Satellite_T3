import {
  FactoryCommandResult,
  FactoryEffectIntent,
  FactoryError,
  FactorySnapshot,
  type FactoryHostCommand,
  type ProjectId,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { decide, initialFactorySnapshot } from "./FactoryState.ts";
import { checkIssueSchedulingFence } from "../issues/IssueScheduling.ts";

type DecisionInput = Omit<Parameters<typeof decide>[0], "state">;

/** An outbox entry. Its id is `<commandId>:<index>`; `attempts` counts `beginEffect` calls. */
export interface PendingFactoryEffect {
  readonly id: string;
  readonly intent: FactoryEffectIntent;
  readonly attempts: number;
}

/**
 * Persists the factory: one snapshot row, a receipt per command id, and an outbox of effect
 * intents. Every state change runs `decide` inside one SQL transaction under one lock, so the
 * state, the receipt and the new intents land together or not at all.
 */
export class FactoryStore extends Context.Service<
  FactoryStore,
  {
    /** The persisted state; decoded again only when the stored revision moved. */
    readonly snapshot: Effect.Effect<FactorySnapshot, FactoryError>;
    /** The last published snapshot, held in memory. For cheap gating off the hot path. */
    readonly latest: Effect.Effect<FactorySnapshot>;
    readonly changes: Stream.Stream<FactorySnapshot>;
    /**
     * A digest of the project's threads, lineage and PR links. `assignment.concluded` carries
     * the value its evidence was sealed against and is refused once the digest moves.
     */
    readonly completionFence: (projectId: ProjectId) => Effect.Effect<string, FactoryError>;
    /**
     * The stored result for this command id, or undefined. Fails with `command-conflict` when
     * the id was already used by a different actor or command.
     */
    readonly findReceipt: (
      input: Pick<DecisionInput, "actor" | "command">,
    ) => Effect.Effect<FactoryCommandResult | undefined, FactoryError>;
    /** Decides and persists one command, then publishes. A repeated command returns its receipt. */
    readonly commit: (input: DecisionInput) => Effect.Effect<FactoryCommandResult, FactoryError>;
    /** Highest sequence observed: persisted, or seen by this process. */
    readonly observationCursor: Effect.Effect<number, FactoryError>;
    /**
     * Records one orchestration event as observed and commits its command, at most once per
     * sequence. An event at or below the cursor is ignored.
     */
    readonly observe: (input: {
      readonly sequence: number;
      readonly command?: FactoryHostCommand;
      readonly now: string;
    }) => Effect.Effect<void, FactoryError>;
    /** Outbox intents still pending, oldest first. A step of the removed restart flow is retired. */
    readonly pending: Effect.Effect<ReadonlyArray<PendingFactoryEffect>, FactoryError>;
    /** Counts an attempt before host work starts; fails once the intent is no longer pending. */
    readonly beginEffect: (id: string) => Effect.Effect<void, FactoryError>;
    /** Drops an intent that no longer applies, without a receipt. Repeating it is harmless. */
    readonly retireEffect: (id: string) => Effect.Effect<void, FactoryError>;
    /**
     * Commits the receipt command that closes an intent and marks the intent done, in one
     * transaction. The command must answer this exact intent, and `failed` must match whether
     * it is a failure receipt. Finishing again with the same receipt is a no-op. Progress
     * commands that do not close an intent are excluded by type.
     */
    readonly finishEffect: (input: {
      readonly id: string;
      readonly command: Exclude<
        FactoryHostCommand,
        {
          readonly type:
            | "thread.launch.started"
            | "assignment.preparation.recorded"
            | "control.stop.targets.recorded"
            | "auxiliary.prepared"
            | "delivery.review.prepared"
            | "retro.prepared"
            | "assignment.replacement.prepared"
            | "guidance.observed";
        }
      >;
      readonly now: string;
      readonly failed?: boolean;
    }) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryStore") {}

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(FactorySnapshot));
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryCommandResult));
const decodeIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryEffectIntent));
// Steps of the removed workflow restart flow. A stored one can no longer run, so it retires.
const decodeRemovedIntent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literals([
        "workflow.restart.stop",
        "workflow.restart.prepare",
        "workflow.restart.resume",
      ]),
    }),
  ),
);
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(FactorySnapshot));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(FactoryCommandResult));
const encodeIntent = Schema.encodeEffect(Schema.fromJsonString(FactoryEffectIntent));
const OBSERVATION_CURSOR_BATCH = 256;
// Storage failures become persistence errors; a decider refusal keeps its own code.
const storageError = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "persistence", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);
  // Access checks read the state several times per turn. Every write bumps `revision`, so an
  // unchanged revision serves the cached state without reading or decoding the payload.
  let decoded: { readonly revision: number; readonly state: FactorySnapshot } | undefined;
  const snapshot = Effect.gen(function* () {
    const heads = yield* sql<{ readonly revision: number }>`
      SELECT revision FROM factory_state WHERE id = 1
    `;
    const head = heads[0];
    if (head === undefined) return initialFactorySnapshot();
    if (decoded?.revision === head.revision) return decoded.state;
    const rows = yield* sql<{ readonly revision: number; readonly payload_json: string }>`
      SELECT revision, payload_json FROM factory_state WHERE id = 1
    `;
    const row = rows[0];
    if (row === undefined) return initialFactorySnapshot();
    decoded = { revision: row.revision, state: yield* decodeSnapshot(row.payload_json) };
    return decoded.state;
  }).pipe(Effect.mapError(storageError));
  const current = yield* SubscriptionRef.make(yield* snapshot);
  // Thread links and lineage commit independently of factory observations. Compare their
  // persisted snapshot inside the conclusion transaction, rather than trusting observer lag.
  const completionFence = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly deleted_at: string | null;
        readonly lineage: string | null;
        readonly pull_requests: string | null;
      }>`SELECT thread_id, deleted_at,
      json_extract(payload_json, '$.lineage') AS lineage,
      json_extract(payload_json, '$.pullRequests') AS pull_requests
      FROM orchestration_v2_projection_threads
      WHERE project_id = ${projectId} ORDER BY thread_id`;
      return Hex.encode(sha256(new TextEncoder().encode(stableStringify(rows))));
    }).pipe(Effect.mapError(storageError));

  const findReceipt = Effect.fn("FactoryStore.findReceipt")(function* (
    input: Pick<DecisionInput, "actor" | "command">,
  ) {
    const request = stableStringify({ actor: input.actor, command: input.command });
    const receipts = yield* sql<{
      readonly request_json: string;
      readonly result_json: string;
    }>`SELECT request_json, result_json FROM factory_commands
      WHERE command_id = ${input.command.commandId}`;
    const receipt = receipts[0];
    if (receipt === undefined) return undefined;
    if (receipt.request_json !== request) {
      return yield* new FactoryError({ code: "command-conflict" });
    }
    return yield* decodeResult(receipt.result_json);
  }, Effect.mapError(storageError));

  const commitTransaction = Effect.fn("FactoryStore.commitTransaction")(function* (
    input: DecisionInput,
  ) {
    const receipt = yield* findReceipt(input);
    if (receipt !== undefined) return receipt;
    const request = stableStringify({ actor: input.actor, command: input.command });
    // Fences that read other tables run inside this transaction, so nothing they check can
    // change between the check and the write.
    const stateBefore = yield* snapshot;
    if (
      input.schedulingAdmission &&
      !(yield* checkIssueSchedulingFence(input.schedulingAdmission).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(storageError),
      ))
    )
      return yield* new FactoryError({
        code: "stale-revision",
        detail:
          "The tracker mapping, observed board or exclusive reservation changed before commissioning.",
      });
    if (input.command.type === "assignment.concluded") {
      const command = input.command;
      const assignment = stateBefore.assignments.find((entry) => entry.id === command.assignmentId);
      if (
        !assignment ||
        (yield* completionFence(assignment.projectId)) !== command.expectedProjectThreadFence
      )
        return yield* new FactoryError({
          code: "stale-revision",
          detail:
            "The project's thread membership or pull-request links changed while retrospective evidence was being sealed.",
        });
    }
    const planned = decide({ ...input, state: stateBefore });
    if (Result.isFailure(planned)) return yield* planned.failure;
    const { state, result, effects } = planned.success;
    const snapshotJson = yield* encodeSnapshot(state);
    const resultJson = yield* encodeResult(result);
    yield* sql`
      INSERT INTO factory_state (id, revision, payload_json)
      VALUES (1, ${state.revision}, ${snapshotJson})
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json
    `;
    // The publish after commit reads this revision back from the cache. A rolled-back write
    // leaves the older revision in the row, so the next read misses and reloads.
    decoded = { revision: state.revision, state };
    yield* sql`
      INSERT INTO factory_commands (command_id, request_json, result_json)
      VALUES (${input.command.commandId}, ${request}, ${resultJson})
    `;
    for (const [index, intent] of effects.entries()) {
      const intentJson = yield* encodeIntent(intent);
      yield* sql`
        INSERT INTO factory_outbox
          (effect_id, command_id, payload_json, status, created_at)
        VALUES (${`${input.command.commandId}:${index}`}, ${input.command.commandId},
          ${intentJson}, 'pending', ${input.now})
      `;
    }
    return result;
  });

  const publish = snapshot.pipe(Effect.flatMap((value) => SubscriptionRef.set(current, value)));
  // Observations without a command replay idempotently, so their cursor is persisted in
  // batches instead of one write transaction per orchestration event.
  let observedThrough = 0;
  let persistedThrough = 0;
  const observationCursor = Effect.gen(function* () {
    const rows = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM factory_observers WHERE name = 'orchestration'
    `;
    return Math.max(rows[0]?.sequence ?? 0, observedThrough);
  }).pipe(Effect.mapError(storageError));
  const observed = (sequence: number, persisted: boolean) =>
    Effect.sync(() => {
      observedThrough = Math.max(observedThrough, sequence);
      if (persisted) persistedThrough = Math.max(persistedThrough, sequence);
    });

  return FactoryStore.of({
    snapshot,
    latest: SubscriptionRef.get(current),
    completionFence,
    // Idempotent replays republish an unchanged snapshot; subscribers only need new revisions.
    changes: SubscriptionRef.changes(current).pipe(
      Stream.changesWith((left, right) => left.revision === right.revision),
    ),
    findReceipt,
    observationCursor,
    observe: (input) =>
      Effect.suspend(() =>
        input.command === undefined && input.sequence < persistedThrough + OBSERVATION_CURSOR_BATCH
          ? observed(input.sequence, false)
          : mutex.withPermits(1)(
              sql
                .withTransaction(
                  Effect.gen(function* () {
                    if ((yield* observationCursor) >= input.sequence) return undefined;
                    if (input.command !== undefined)
                      yield* commitTransaction({
                        actor: { kind: "system" },
                        command: input.command,
                        now: input.now,
                      });
                    yield* sql`INSERT INTO factory_observers (name, sequence)
        VALUES ('orchestration', ${input.sequence})
        ON CONFLICT(name) DO UPDATE SET sequence = excluded.sequence`;
                    return input.command !== undefined;
                  }),
                )
                .pipe(
                  Effect.mapError(storageError),
                  Effect.flatMap((changed) =>
                    changed === undefined
                      ? Effect.void
                      : observed(input.sequence, true).pipe(
                          Effect.andThen(changed ? publish : Effect.void),
                        ),
                  ),
                ),
            ),
      ),
    commit: (input) =>
      mutex.withPermits(1)(
        sql.withTransaction(commitTransaction(input)).pipe(
          Effect.mapError(storageError),
          Effect.tap(() => publish),
        ),
      ),
    pending: Effect.gen(function* () {
      const rows = yield* sql<{
        readonly effect_id: string;
        readonly payload_json: string;
        readonly attempts: number;
      }>`SELECT effect_id, payload_json, attempts FROM factory_outbox
        WHERE status = 'pending' ORDER BY rowid`;
      const pending: PendingFactoryEffect[] = [];
      for (const row of rows) {
        if (Option.isSome(decodeRemovedIntent(row.payload_json))) {
          yield* sql`UPDATE factory_outbox SET status = 'superseded'
            WHERE effect_id = ${row.effect_id} AND status = 'pending'`;
          continue;
        }
        const intent = yield* decodeIntent(row.payload_json);
        pending.push({ id: row.effect_id, intent, attempts: row.attempts });
      }
      return pending;
    }).pipe(Effect.mapError(storageError)),
    beginEffect: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly effect_id: string }>`
        UPDATE factory_outbox SET attempts = attempts + 1
        WHERE effect_id = ${id} AND status = 'pending'
        RETURNING effect_id
      `;
        if (rows.length === 0) return yield* new FactoryError({ code: "invalid-state" });
      }).pipe(Effect.mapError(storageError)),
    retireEffect: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly effect_id: string }>`
        UPDATE factory_outbox SET status = 'superseded'
        WHERE effect_id = ${id} AND status IN ('pending', 'superseded')
        RETURNING effect_id
      `;
        if (rows.length === 0) return yield* new FactoryError({ code: "invalid-state" });
      }).pipe(Effect.mapError(storageError)),
    finishEffect: (input) =>
      mutex.withPermits(1)(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                readonly payload_json: string;
                readonly status: "pending" | "completed" | "failed" | "superseded";
              }>`SELECT payload_json, status FROM factory_outbox WHERE effect_id = ${input.id}`;
              const effect = rows[0];
              if (effect === undefined) return yield* new FactoryError({ code: "invalid-state" });
              const intent = yield* decodeIntent(effect.payload_json);
              const command = input.command;
              const failed = command.type.endsWith(".failed");
              // A receipt must name the same intent it closes, so a late or misrouted receipt
              // can never close a newer intent of the same kind.
              const matches = (() => {
                switch (intent.type) {
                  case "integration.thread.create":
                    return (
                      (command.type === "integration.thread.created" ||
                        command.type === "integration.thread.failed") &&
                      command.integrationId === intent.integrationId
                    );
                  case "integration.capability.qualify":
                    return (
                      (command.type === "integration.capability.qualified" ||
                        command.type === "integration.capability.failed") &&
                      command.capabilityId === intent.capabilityId
                    );
                  case "integration.prepare":
                    return (
                      (command.type === "integration.prepared" ||
                        command.type === "integration.prepare.failed") &&
                      command.integrationId === intent.integrationId &&
                      command.preparationId === intent.preparationId
                    );
                  case "integration.stop":
                    return (
                      (command.type === "integration.stopped" ||
                        command.type === "integration.stop.failed") &&
                      command.integrationId === intent.integrationId &&
                      command.holdId === intent.holdId
                    );
                  case "integration.file.mutate":
                    return (
                      (command.type === "integration.file.mutated" ||
                        command.type === "integration.file.failed") &&
                      command.integrationId === intent.integrationId &&
                      command.preparationId === intent.preparationId &&
                      command.operationId === intent.operationId
                    );
                  case "integration.verify":
                    return (
                      (command.type === "integration.verified" ||
                        command.type === "integration.verify.failed") &&
                      command.verificationId === intent.verificationId
                    );
                  case "integration.message.deliver":
                    return (
                      (command.type === "integration.message.recorded" ||
                        command.type === "integration.message.failed") &&
                      command.messageId === intent.messageId
                    );
                  case "integration.resume":
                    return (
                      command.type === "integration.operation.resumed" &&
                      command.integrationId === intent.integrationId &&
                      command.operation.kind === intent.operation.kind &&
                      command.operation.id === intent.operation.id
                    );
                  case "merge.group.inspect":
                    return (
                      (command.type === "merge.group.inspected" ||
                        command.type === "merge.group.inspect.failed") &&
                      command.groupId === intent.groupId &&
                      command.reviewId === intent.reviewId
                    );
                  case "merge.operation.prepare":
                    return (
                      (command.type === "merge.operation.frozen" ||
                        command.type === "merge.operation.held") &&
                      command.operationId === intent.operationId
                    );
                  case "merge.operation.advance":
                    return (
                      (command.type === "merge.operation.submitting" ||
                        command.type === "merge.operation.held" ||
                        command.type === "merge.operation.completed") &&
                      command.operationId === intent.operationId
                    );
                  case "merge.operation.reconcile":
                    return (
                      (command.type === "merge.operation.held" ||
                        command.type === "merge.operation.completed") &&
                      command.operationId === intent.operationId
                    );
                  case "merge.operation.signal":
                    return (
                      command.type === "merge.operation.signaled" &&
                      command.operationId === intent.operationId
                    );
                  case "collaboration.message.deliver":
                    return (
                      (command.type === "collaboration.message.recorded" ||
                        command.type === "collaboration.message.failed") &&
                      command.messageId === intent.messageId
                    );
                  case "incident.stop":
                    return (
                      (command.type === "incident.stopped" ||
                        (command.type === "incident.failed" && command.step === "stop")) &&
                      command.restrictionId === intent.restrictionId
                    );
                  case "incident.resume":
                    return (
                      (command.type === "incident.resumed" ||
                        (command.type === "incident.failed" && command.step === "resume")) &&
                      command.restrictionId === intent.restrictionId
                    );
                  case "workflow.work.notify":
                    return (
                      (command.type === "workflow.work.notified" ||
                        command.type === "workflow.work.notify.failed") &&
                      command.workId === intent.workId &&
                      command.managerId === intent.managerId
                    );
                  case "assignment.conclude":
                    return (
                      (command.type === "assignment.concluded" ||
                        command.type === "assignment.completion.failed" ||
                        command.type === "assignment.completion.reopen") &&
                      command.assignmentId === intent.assignmentId
                    );
                  case "retro.launch":
                    return (
                      (command.type === "retro.started" || command.type === "retro.failed") &&
                      command.retroId === intent.retroId
                    );
                  case "retro.stop":
                    return command.type === "retro.stopped" && command.retroId === intent.retroId;
                  case "followup.publish":
                    return (
                      (command.type === "followup.publication.recorded" ||
                        command.type === "followup.failed") &&
                      command.followupId === intent.followupId
                    );
                  case "followup.link":
                    return (
                      (command.type === "followup.linked" ||
                        command.type === "followup.publication.recorded" ||
                        command.type === "followup.failed") &&
                      command.followupId === intent.followupId
                    );
                  case "system.launch":
                    return (
                      (command.type === "system.launch.recorded" ||
                        command.type === "system.launch.failed") &&
                      command.managerId === intent.managerId &&
                      command.profileId === intent.profileId
                    );
                  case "improvement.notify":
                    return (
                      command.type === "improvement.batch.delivered" &&
                      command.batchId === intent.batchId &&
                      command.digest === intent.digest
                    );
                  case "schedule.notify":
                    return (
                      command.type === "schedule.notified" &&
                      command.managerId === intent.managerId &&
                      stableStringify(command.notifications) ===
                        stableStringify(intent.notifications)
                    );
                  case "delivery.capture":
                    return (
                      command.type === "delivery.captured" &&
                      command.assignmentId === intent.assignmentId &&
                      command.revisionId === intent.revisionId
                    );
                  case "delivery.publish":
                    return (
                      command.type === "delivery.published" &&
                      command.assignmentId === intent.assignmentId &&
                      command.revisionId === intent.revisionId
                    );
                  case "delivery.inspect":
                    return (
                      command.type === "delivery.inspected" &&
                      command.assignmentId === intent.assignmentId &&
                      command.revisionId === intent.revisionId
                    );
                  case "delivery.merge":
                    return (
                      command.type === "delivery.merge.recorded" &&
                      command.assignmentId === intent.assignmentId &&
                      command.revisionId === intent.revisionId &&
                      command.operationId === intent.operationId
                    );
                  case "delivery.review.launch":
                    return (
                      command.type === "delivery.review.started" &&
                      command.assignmentId === intent.assignmentId &&
                      command.revisionId === intent.revisionId &&
                      command.reviewId === intent.reviewId
                    );
                  case "delivery.flow.hold":
                    return (
                      command.type === "delivery.flow.recorded" &&
                      command.assignmentId === intent.assignmentId &&
                      command.holdId === intent.holdId &&
                      command.held === intent.held
                    );
                  case "delivery.flow.capture":
                    return (
                      command.type === "delivery.flow.artifact" &&
                      command.assignmentId === intent.assignmentId &&
                      command.holdId === intent.holdId &&
                      command.artifactId === intent.artifactId
                    );
                  case "delivery.preview.start":
                  case "delivery.preview.stop":
                    return (
                      command.type === "delivery.preview.recorded" &&
                      command.assignmentId === intent.assignmentId &&
                      command.revisionId === intent.revisionId &&
                      command.instanceId === intent.instanceId
                    );
                  case "assignment.reconcile":
                    return (
                      ((command.type === "assignment.reconciled" &&
                        command.triggerId === intent.triggerId) ||
                        command.type === "assignment.delivery.recorded") &&
                      command.assignmentId === intent.assignmentId
                    );
                  case "auxiliary.reconcile":
                    return (
                      command.type === "auxiliary.reconciled" &&
                      command.threadId === intent.threadId &&
                      command.triggerId === intent.triggerId
                    );
                  case "auxiliary.launch":
                    return (
                      (command.type === "auxiliary.started" ||
                        command.type === "auxiliary.failed") &&
                      command.threadId === intent.threadId
                    );
                  case "assignment.replace-lead":
                    return (
                      (command.type === "assignment.replacement.recorded" ||
                        command.type === "assignment.replacement.failed") &&
                      command.assignmentId === intent.assignmentId &&
                      command.threadId === intent.threadId &&
                      command.incidentId === intent.incidentId &&
                      (command.type !== "assignment.replacement.recorded" ||
                        command.previousThreadId === intent.previousThreadId)
                    );
                  case "thread.launch":
                    return (
                      (command.type === "thread.launch.recorded" ||
                        command.type === "thread.launch.failed") &&
                      intent.threadId === command.threadId
                    );
                  case "assignment.prepare":
                    return (
                      (command.type === "assignment.prepared" ||
                        command.type === "assignment.prepare.failed") &&
                      intent.threadId === command.threadId &&
                      intent.assignmentId === command.assignmentId
                    );
                  case "control.stop":
                  case "control.resume":
                    return (
                      (intent.type === "control.stop"
                        ? command.type === "control.stop.recorded" ||
                          command.type === "control.stop.failed"
                        : command.type === "control.resume.recorded" ||
                          command.type === "control.resume.failed") &&
                      "controlId" in command &&
                      intent.controlId === command.controlId &&
                      "generation" in command &&
                      intent.generation === command.generation
                    );
                  case "thread.deliver":
                    return (
                      command.type === "thread.delivery.recorded" &&
                      intent.threadId === command.threadId &&
                      intent.messageId === command.messageId
                    );
                  case "thread.queue.resume":
                    return (
                      command.type === "thread.queue.resumed" &&
                      intent.threadId === command.threadId &&
                      intent.controlId === command.controlId &&
                      intent.generation === command.generation
                    );
                }
              })();
              if (!matches || failed !== (input.failed ?? false)) {
                return yield* new FactoryError({ code: "invalid-state" });
              }
              const status = failed ? "failed" : "completed";
              // An intent already closed accepts only a replay of the receipt that closed it.
              if (effect.status !== "pending") {
                const receipt = yield* findReceipt({
                  actor: { kind: "system" },
                  command: input.command,
                });
                if (effect.status !== status || receipt === undefined) {
                  return yield* new FactoryError({ code: "invalid-state" });
                }
                return;
              }
              yield* commitTransaction({
                actor: { kind: "system" },
                command: input.command,
                now: input.now,
              });
              yield* sql`
              UPDATE factory_outbox SET status = ${status}
              WHERE effect_id = ${input.id} AND status = 'pending'
            `;
            }),
          )
          .pipe(
            Effect.mapError(storageError),
            Effect.tap(() => publish),
          ),
      ),
  });
});

export const layer = Layer.effect(FactoryStore, make);
