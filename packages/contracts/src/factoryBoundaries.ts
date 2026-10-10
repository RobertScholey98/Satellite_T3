import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FactoryWorkflowVersion = Schema.Struct({
  repositoryRoot: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
});
export type FactoryWorkflowVersion = typeof FactoryWorkflowVersion.Type;

export const FactoryBoundaryId = TrimmedNonEmptyString.pipe(Schema.brand("FactoryBoundaryId"));
export type FactoryBoundaryId = typeof FactoryBoundaryId.Type;

export const FactoryGate = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  executable: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: TrimmedNonEmptyString,
  timeoutMs: NonNegativeInt,
  protectedInputs: Schema.Array(TrimmedNonEmptyString),
});
export type FactoryGate = typeof FactoryGate.Type;

export const FactoryBoundaryConfiguration = Schema.Struct({
  protectedPaths: Schema.Array(TrimmedNonEmptyString),
  writablePaths: Schema.Array(TrimmedNonEmptyString),
  creatableDirectories: Schema.Array(TrimmedNonEmptyString),
  gates: Schema.Array(FactoryGate),
  protectedCreatablePaths: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  skillRoots: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  verification: Schema.optionalKey(Schema.Literals(["gates", "protected-integrity"])),
});
export type FactoryBoundaryConfiguration = typeof FactoryBoundaryConfiguration.Type;

export const FactoryBoundary = Schema.Struct({
  ...FactoryBoundaryConfiguration.fields,
  id: FactoryBoundaryId,
  projectId: ProjectId,
  sourceRevision: TrimmedNonEmptyString,
  workflow: FactoryWorkflowVersion,
  profileId: TrimmedNonEmptyString,
  approvedAt: IsoDateTime,
});
export type FactoryBoundary = typeof FactoryBoundary.Type;

export const FactoryDiscoveryQualification = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("qualified"),
    profileId: TrimmedNonEmptyString,
    checkedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: TrimmedNonEmptyString,
  }),
]);
export type FactoryDiscoveryQualification = typeof FactoryDiscoveryQualification.Type;
