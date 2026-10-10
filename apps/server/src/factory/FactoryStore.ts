import {
  FactoryCommandResult,
  FactoryEffectIntent,
  FactoryError,
  FactorySnapshot,
  type FactoryHostCommand,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { decide, initialFactorySnapshot } from "./FactoryState.ts";

type DecisionInput = Omit<Parameters<typeof decide>[0], "state">;

export interface PendingFactoryEffect {
  readonly id: string;
  readonly intent: FactoryEffectIntent;
  readonly attempts: number;
}

export class FactoryStore extends Context.Service<
  FactoryStore,
  {
    readonly snapshot: Effect.Effect<FactorySnapshot, FactoryError>;
    readonly changes: Stream.Stream<FactorySnapshot>;
    readonly findReceipt: (
      input: Pick<DecisionInput, "actor" | "command">,
    ) => Effect.Effect<FactoryCommandResult | undefined, FactoryError>;
    readonly commit: (input: DecisionInput) => Effect.Effect<FactoryCommandResult, FactoryError>;
    readonly observationCursor: Effect.Effect<number, FactoryError>;
    readonly observe: (input: {
      readonly sequence: number;
      readonly command?: FactoryHostCommand;
      readonly now: string;
    }) => Effect.Effect<void, FactoryError>;
    readonly pending: Effect.Effect<ReadonlyArray<PendingFactoryEffect>, FactoryError>;
    readonly beginEffect: (id: string) => Effect.Effect<void, FactoryError>;
    readonly retireEffect: (id: string) => Effect.Effect<void, FactoryError>;
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
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(FactorySnapshot));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(FactoryCommandResult));
const encodeIntent = Schema.encodeEffect(Schema.fromJsonString(FactoryEffectIntent));
const isFactoryError = Schema.is(FactoryError);
const storageError = (cause: unknown) => new FactoryError({ code: "persistence", cause });
const preserveDomainError = (cause: unknown) =>
  isFactoryError(cause) ? cause : storageError(cause);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);
  const snapshot = Effect.gen(function* () {
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM factory_state WHERE id = 1
    `;
    return rows[0] === undefined
      ? initialFactorySnapshot()
      : yield* decodeSnapshot(rows[0].payload_json);
  }).pipe(Effect.mapError(storageError));
  const current = yield* SubscriptionRef.make(yield* snapshot);

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
  }, Effect.mapError(preserveDomainError));

  const commitTransaction = Effect.fn("FactoryStore.commitTransaction")(function* (
    input: DecisionInput,
  ) {
    const receipt = yield* findReceipt(input);
    if (receipt !== undefined) return receipt;
    const request = stableStringify({ actor: input.actor, command: input.command });
    const planned = decide({ ...input, state: yield* snapshot });
    if (Result.isFailure(planned)) return yield* planned.failure;
    const { state, result, effects } = planned.success;
    const snapshotJson = yield* encodeSnapshot(state);
    const resultJson = yield* encodeResult(result);
    yield* sql`
      INSERT INTO factory_state (id, revision, payload_json)
      VALUES (1, ${state.revision}, ${snapshotJson})
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json
    `;
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
  const observationCursor = Effect.gen(function* () {
    const rows = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM factory_observers WHERE name = 'orchestration'
    `;
    return rows[0]?.sequence ?? 0;
  }).pipe(Effect.mapError(storageError));

  return FactoryStore.of({
    snapshot,
    changes: SubscriptionRef.changes(current),
    findReceipt,
    observationCursor,
    observe: (input) =>
      mutex.withPermits(1)(
        sql
          .withTransaction(
            Effect.gen(function* () {
              if ((yield* observationCursor) >= input.sequence) return false;
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
            Effect.mapError(preserveDomainError),
            Effect.flatMap((changed) => (changed ? publish : Effect.void)),
          ),
      ),
    commit: (input) =>
      mutex.withPermits(1)(
        sql.withTransaction(commitTransaction(input)).pipe(
          Effect.mapError(preserveDomainError),
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
      return yield* Effect.forEach(rows, (row) =>
        decodeIntent(row.payload_json).pipe(
          Effect.map((intent) => ({ id: row.effect_id, intent, attempts: row.attempts })),
        ),
      );
    }).pipe(Effect.mapError(storageError)),
    beginEffect: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly effect_id: string }>`
        UPDATE factory_outbox SET attempts = attempts + 1
        WHERE effect_id = ${id} AND status = 'pending'
        RETURNING effect_id
      `;
        if (rows.length === 0) return yield* new FactoryError({ code: "invalid-state" });
      }).pipe(Effect.mapError(preserveDomainError)),
    retireEffect: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly effect_id: string }>`
        UPDATE factory_outbox SET status = 'superseded'
        WHERE effect_id = ${id} AND status IN ('pending', 'superseded')
        RETURNING effect_id
      `;
        if (rows.length === 0) return yield* new FactoryError({ code: "invalid-state" });
      }).pipe(Effect.mapError(preserveDomainError)),
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
              const matches = (() => {
                switch (intent.type) {
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
              UPDATE factory_outbox SET status = ${status},
                error_code = ${failed ? "launch-failed" : null}
              WHERE effect_id = ${input.id} AND status = 'pending'
            `;
            }),
          )
          .pipe(
            Effect.mapError(preserveDomainError),
            Effect.tap(() => publish),
          ),
      ),
  });
});

export const layer = Layer.effect(FactoryStore, make);
