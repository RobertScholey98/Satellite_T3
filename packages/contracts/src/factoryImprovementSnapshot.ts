import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { FactoryAssignmentId } from "./factoryControls.ts";
import { FactoryRetroEvidenceRef } from "./factoryRetros.ts";
import { FactoryImprovementSettings } from "./factoryImprovements.ts";
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export const FactoryImprovementSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  managerId: ThreadId,
  queued: NonNegativeInt,
  settings: FactoryImprovementSettings,
  budget: Schema.Struct({ day: Schema.String, used: NonNegativeInt, remaining: NonNegativeInt }),
  decisions: Schema.Array(
    Schema.Struct({
      proposalId: Id,
      revision: Id,
      outcome: Schema.String,
      reason: Schema.String,
      decidedAt: Schema.String,
    }),
  ),
  feedback: Schema.Array(
    Schema.Struct({
      id: Id,
      proposalId: Id,
      revision: Id,
      usefulness: Schema.String,
      reason: Schema.String,
    }),
  ),
  recurrences: Schema.Array(
    Schema.Struct({ id: Id, investigationId: Id, findingId: Id, reason: Schema.String }),
  ),
  findings: Schema.Array(
    Schema.Struct({
      id: Id,
      projectId: ProjectId,
      assignmentId: FactoryAssignmentId,
      summary: Schema.String,
      evidence: Schema.Array(FactoryRetroEvidenceRef),
    }),
  ),
  investigations: Schema.Array(
    Schema.Struct({
      id: Id,
      title: Schema.String,
      findingIds: Schema.Array(Id),
      phase: Schema.String,
      assessment: Schema.String,
      uncertainty: Schema.String,
    }),
  ),
  proposals: Schema.Array(
    Schema.Struct({
      id: Id,
      revision: Id,
      investigationId: Id,
      phase: Schema.String,
      problem: Schema.String,
      requestedDecision: Schema.String,
    }),
  ),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type FactoryImprovementSnapshot = typeof FactoryImprovementSnapshot.Type;

export const FactoryImprovementRecordRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["proposal", "decision"]), id: Id, revision: Id }),
  Schema.Struct({ kind: Schema.Literals(["investigation", "feedback", "recurrence"]), id: Id }),
]);
const RecordCursor = Schema.Struct({ offset: NonNegativeInt, digest: Id });
export const FactoryImprovementRecordRead = Schema.Struct({
  record: FactoryImprovementRecordRef,
  cursor: Schema.optionalKey(RecordCursor),
  limit: Schema.optionalKey(NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 16000 }))),
});
export type FactoryImprovementRecordRead = typeof FactoryImprovementRecordRead.Type;
export const FactoryImprovementRecord = Schema.Struct({
  record: FactoryImprovementRecordRef,
  digest: Id,
  text: Schema.String.check(Schema.isMaxLength(16000)),
  nextCursor: Schema.NullOr(RecordCursor),
});
export type FactoryImprovementRecord = typeof FactoryImprovementRecord.Type;
