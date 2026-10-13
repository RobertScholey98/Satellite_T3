import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const FactorySourceId = TrimmedNonEmptyString.pipe(Schema.brand("FactorySourceId"));
export type FactorySourceId = typeof FactorySourceId.Type;

export const FactoryStartingSource = Schema.Struct({
  id: FactorySourceId,
  projectId: ProjectId,
  revision: TrimmedNonEmptyString,
  sourceDigest: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  origin: Schema.Literals(["project", "handover"]),
  threadId: Schema.optionalKey(ThreadId),
  capturedAt: IsoDateTime,
  fileCount: NonNegativeInt,
  stagedPaths: Schema.Array(TrimmedNonEmptyString),
  unstagedPaths: Schema.Array(TrimmedNonEmptyString),
  untrackedPaths: Schema.Array(TrimmedNonEmptyString),
  deletedPaths: Schema.Array(TrimmedNonEmptyString),
  excludedPaths: Schema.Array(TrimmedNonEmptyString),
});
export type FactoryStartingSource = typeof FactoryStartingSource.Type;
