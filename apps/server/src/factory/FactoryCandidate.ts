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

/**
 * A host-side capture of an assignment volume, offered for delivery. Written once per candidate
 * id and never edited; finalizing writes a second record with `finalized` set.
 */
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
  /** Every file in the volume at capture, not only the selected ones. */
  files: Schema.Array(FactorySourceFile),
  /** Starting-source paths that are absent from the volume. */
  deletedPaths: Schema.Array(Schema.String),
  /** The writable paths selected for delivery, each present in `files` or `deletedPaths`. */
  selectedPaths: Schema.Array(Schema.String),
  startingFiles: Schema.Array(FactorySourceFile),
  startingIndexFiles: Schema.Array(FactorySourceFile),
  capturedAt: Schema.String,
  /** The private publication bound to this candidate; its files are what was published. */
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
