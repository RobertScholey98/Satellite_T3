import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { FactoryAssignmentId } from "./factoryControls.ts";
import { FactoryRetroEvidenceRef } from "./factoryRetros.ts";
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export const FactoryInvestigationCursor = Schema.Struct({
  afterPosition: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  offset: NonNegativeInt,
  digest: Schema.NullOr(Id),
});
export const FactoryInvestigationRead = Schema.Struct({
  investigationId: Id,
  findingId: Id,
  evidenceRef: FactoryRetroEvidenceRef,
  cursor: Schema.optionalKey(FactoryInvestigationCursor),
  limit: Schema.optionalKey(NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 16000 }))),
});
export type FactoryInvestigationRead = typeof FactoryInvestigationRead.Type;
export const FactoryInvestigationEvidence = Schema.Struct({
  investigationId: Id,
  findingId: Id,
  assignmentId: FactoryAssignmentId,
  projectId: ProjectId,
  evidenceRef: FactoryRetroEvidenceRef,
  digest: Id,
  text: Schema.String.check(Schema.isMaxLength(16000)),
  nextCursor: Schema.NullOr(FactoryInvestigationCursor),
});
export type FactoryInvestigationEvidence = typeof FactoryInvestigationEvidence.Type;
