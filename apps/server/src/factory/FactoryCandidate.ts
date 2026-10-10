import {
  FactoryAssignmentGrant,
  FactoryAssignmentId,
  FactoryBoundaryConfiguration,
  FactoryStartingSource,
  FactoryWorkflowVersion,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { FactorySourceFile } from "./FactorySource.ts";

export const FactoryCandidateArtifact = Schema.Struct({
  id: Schema.String,
  assignmentId: FactoryAssignmentId,
  projectId: ProjectId,
  leadThreadId: ThreadId,
  startingSource: FactoryStartingSource,
  workflow: FactoryWorkflowVersion,
  grant: FactoryAssignmentGrant,
  configuration: FactoryBoundaryConfiguration,
  sourceDigest: Schema.String,
  files: Schema.Array(FactorySourceFile),
  deletedPaths: Schema.Array(Schema.String),
  selectedPaths: Schema.Array(Schema.String),
  startingFiles: Schema.Array(FactorySourceFile),
  startingIndexFiles: Schema.Array(FactorySourceFile),
  capturedAt: Schema.String,
  finalized: Schema.optionalKey(
    Schema.Struct({
      reservationId: Schema.String,
      sourceDigest: Schema.String,
      treeOid: Schema.String,
      commitOid: Schema.String,
      files: Schema.Array(FactorySourceFile),
    }),
  ),
});
export type FactoryCandidateArtifact = typeof FactoryCandidateArtifact.Type;
