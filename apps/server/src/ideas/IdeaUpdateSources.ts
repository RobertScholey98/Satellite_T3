import {
  EventId,
  IdeaChangedPayload,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationThreadActivity,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { EventStoreV2 } from "../orchestration-v2/EventStore.ts";
import { satelliteEvents } from "../orchestration-v2/SatelliteOrchestration.ts";

const legacyBase = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: Schema.Literal("thread"),
  aggregateId: ThreadId,
  occurredAt: IsoDateTime,
};
const LegacySourceEvent = Schema.Union([
  Schema.Struct({
    ...legacyBase,
    type: Schema.Literal("thread.message-sent"),
    payload: Schema.fromJsonString(
      Schema.Struct({
        threadId: ThreadId,
        messageId: MessageId,
        role: Schema.Literals(["user", "assistant", "system"]),
        text: Schema.String,
        streaming: Schema.Boolean,
      }),
    ),
  }),
  Schema.Struct({
    ...legacyBase,
    type: Schema.Literal("thread.activity-appended"),
    payload: Schema.fromJsonString(
      Schema.Struct({ threadId: ThreadId, activity: OrchestrationThreadActivity }),
    ),
  }),
  Schema.Struct({
    ...legacyBase,
    type: Schema.Literal("idea.changed"),
    payload: Schema.fromJsonString(IdeaChangedPayload),
  }),
]);
const decodeLegacySourceEvents = Schema.decodeUnknownEffect(Schema.Array(LegacySourceEvent));

class IdeaUpdateSourceError extends Schema.TaggedError<IdeaUpdateSourceError>()(
  "IdeaUpdateSourceError",
  {
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Could not read the idea's source history.";
  }
}

const isSourceEvent = (event: OrchestrationEvent) =>
  event.type === "thread.message-sent" ||
  event.type === "thread.activity-appended" ||
  (event.type === "idea.changed" && event.payload.mutation.kind === "artifact.register");

/** Older V2 metadata updates did not record title ownership, including same-text renames. */
export const hasUnversionedTitleUpdate = Effect.fn("IdeaUpdateSources.hasUnversionedTitleUpdate")(
  function* (threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      SELECT 1 FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND stream_id = ${threadId} AND event_type = 'thread.metadata-updated'
        AND event_id NOT LIKE 'migration:v1:%'
        AND json_type(payload_json, '$.title') IS NOT NULL
        AND json_extract(payload_json, '$.titleState') IS NULL
      LIMIT 1
    `;
    return rows.length > 0;
  },
  (effect, threadId) =>
    effect.pipe(Effect.mapError((cause) => new IdeaUpdateSourceError({ threadId, cause }))),
);

/** Imported evidence keeps its original sequence so old discussion cannot undo a deletion. */
export const readIdeaUpdateSources = Effect.fn("IdeaUpdateSources.read")(
  function* (threadId: ThreadId, throughSequence: number) {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* EventStoreV2;
    const legacy = yield* decodeLegacySourceEvents(
      yield* sql`
    SELECT sequence, event_id AS "eventId", aggregate_kind AS "aggregateKind",
      stream_id AS "aggregateId", occurred_at AS "occurredAt", event_type AS type,
      payload_json AS payload
    FROM orchestration_events
    WHERE application_event_version = 1 AND aggregate_kind = 'thread'
      AND stream_id = ${threadId} AND sequence <= ${throughSequence}
      AND event_type IN ('thread.message-sent', 'thread.activity-appended', 'idea.changed')
    ORDER BY sequence
  `,
    );
    const imported = yield* decodeLegacySourceEvents(
      yield* sql`
    WITH message_sequences AS (
      SELECT json_extract(payload_json, '$.messageId') AS message_id, MAX(sequence) AS sequence
      FROM orchestration_events
      WHERE application_event_version = 1 AND aggregate_kind = 'thread'
        AND stream_id = ${threadId} AND event_type = 'thread.message-sent'
      GROUP BY json_extract(payload_json, '$.messageId')
    )
    SELECT COALESCE(source.sequence, 0) AS sequence, 'migration:v1:message:' || message.message_id AS "eventId",
      'thread' AS "aggregateKind", message.thread_id AS "aggregateId", message.updated_at AS "occurredAt",
      'thread.message-sent' AS type,
      json_object('threadId', message.thread_id, 'messageId', message.message_id, 'role', message.role,
        'text', message.text, 'streaming', json('false')) AS payload
    FROM projection_thread_messages AS message
    LEFT JOIN message_sequences AS source ON source.message_id = message.message_id
    WHERE message.thread_id = ${threadId} AND COALESCE(source.sequence, 0) <= ${throughSequence} AND EXISTS (
      SELECT 1 FROM orchestration_v2_legacy_imports WHERE thread_id = ${threadId}
    )
    ORDER BY message.created_at, message.message_id
  `,
    );
    const migratedMessages = new Set(
      imported.map((event) =>
        event.type === "thread.message-sent" ? event.payload.messageId : "",
      ),
    );
    const current = yield* events.read({ threadId, throughSequence }).pipe(
      Stream.flatMap((stored) => {
        return stored.event.id.startsWith("migration:v1:")
          ? Stream.empty
          : Stream.fromIterable(satelliteEvents(stored).filter(isSourceEvent));
      }),
      Stream.runCollect,
    );
    return [
      ...legacy.filter(
        (event) =>
          isSourceEvent(event) &&
          (event.type !== "thread.message-sent" || !migratedMessages.has(event.payload.messageId)),
      ),
      ...imported,
      ...current,
    ].toSorted((left, right) => left.sequence - right.sequence);
  },
  (effect, threadId) =>
    effect.pipe(Effect.mapError((cause) => new IdeaUpdateSourceError({ threadId, cause }))),
);
