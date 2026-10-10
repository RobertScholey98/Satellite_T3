import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryBoundaryId, FactoryFileMutation } from "./factoryBoundaries.ts";
import { FactoryAssignmentId, FactoryResumeQueue } from "./factoryControls.ts";
import { FactoryTaskComplexity } from "./factoryModels.ts";
import { FactoryEvidence } from "./factoryOversight.ts";
import { ModelSelection } from "./modelSelection.ts";
import { PullRequestRef } from "./pullRequest.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(6000));
const Ids = Schema.Array(Id).check(Schema.isMaxLength(30));
const Paths = Schema.Array(Id).check(Schema.isMaxLength(500));
export const FactoryIntegrationPaths = Schema.Struct({
  readPaths: Paths,
  testPaths: Paths,
  fixturePaths: Paths,
  testDirectories: Paths,
  fixtureDirectories: Paths,
});
export type FactoryIntegrationPaths = typeof FactoryIntegrationPaths.Type;
export const FactoryIntegrationCoordinator = Schema.Struct({
  executable: Schema.Literal("/usr/local/bin/node"),
  entrypoint: Id,
  args: Schema.Array(Schema.String).check(Schema.isMaxLength(30)),
  timeoutMs: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(300000),
  ),
});
export type FactoryIntegrationCoordinator = typeof FactoryIntegrationCoordinator.Type;
export const FactoryIntegrationCapability = Schema.Struct({
  id: Id,
  projectId: ProjectId,
  boundaryId: FactoryBoundaryId,
  paths: FactoryIntegrationPaths,
  coordinator: Schema.NullOr(FactoryIntegrationCoordinator),
  qualification: Schema.Union([
    Schema.Struct({ status: Schema.Literal("pending") }),
    Schema.Struct({
      status: Schema.Literal("qualified"),
      profileId: Id,
      configurationDigest: Id,
      coordinatorDigest: Schema.NullOr(Id),
      checkedAt: IsoDateTime,
    }),
    Schema.Struct({ status: Schema.Literal("unavailable"), reason: Text }),
  ]),
  supersededBy: Schema.NullOr(Id),
  authorizingCommandId: CommandId,
  createdAt: IsoDateTime,
});
export type FactoryIntegrationCapability = typeof FactoryIntegrationCapability.Type;
export const FactoryIntegrationGrant = Schema.Struct({
  id: Id,
  integrationId: Id,
  projectId: ProjectId,
  ownerManagerId: ThreadId,
  participantAssignmentId: FactoryAssignmentId,
  capabilityId: Id,
  boundaryId: FactoryBoundaryId,
  paths: FactoryIntegrationPaths,
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("active") }),
    Schema.Struct({
      phase: Schema.Literal("revoked"),
      reason: Text,
      commandId: CommandId,
      revokedAt: IsoDateTime,
    }),
  ]),
  authorizingCommandId: CommandId,
  createdAt: IsoDateTime,
});
export type FactoryIntegrationGrant = typeof FactoryIntegrationGrant.Type;
export const FactoryIntegration = Schema.Struct({
  id: Id,
  assignmentId: FactoryAssignmentId,
  requesterManagerId: ThreadId,
  requestIds: Ids.check(Schema.isMinLength(1)),
  participantAssignmentIds: Schema.Array(FactoryAssignmentId).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(30),
  ),
  coordinatorProjectId: ProjectId,
  phase: Schema.Literals(["awaiting-grants", "preparing", "ready", "blocked"]),
  waitReason: Schema.NullOr(Text),
  hold: Schema.NullOr(
    Schema.Struct({
      id: Id,
      preparationId: Schema.NullOr(Id),
      status: Schema.Literals(["pending", "confirmed", "failed"]),
      reason: Text,
      resumeThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
      resumeQueues: Schema.optionalKey(Schema.Array(FactoryResumeQueue)),
    }),
  ),
  currentPreparationId: Schema.NullOr(Id),
  currentTestArtifactId: Schema.NullOr(Id),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryIntegration = typeof FactoryIntegration.Type;
export const FactoryIntegrationInput = Schema.Struct({
  projectId: ProjectId,
  assignmentId: FactoryAssignmentId,
  leadThreadId: ThreadId,
  revisionId: Id,
  candidateId: Id,
  candidateDigest: Id,
  sourceDigest: Id,
  boundaryId: FactoryBoundaryId,
  grantEpoch: NonNegativeInt,
  integrationGrantId: Id,
  capabilityId: Id,
  publication: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("unpublished-candidate") }),
    Schema.Struct({
      kind: Schema.Literal("published-head"),
      ref: PullRequestRef,
      headSha: Id,
      baseSha: Id,
      treeOid: Id,
    }),
  ]),
});
export type FactoryIntegrationInput = typeof FactoryIntegrationInput.Type;
export const FactoryIntegrationManifest = Schema.Struct({
  inputDigest: Id,
  inputs: Schema.Array(FactoryIntegrationInput).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(30),
  ),
  planIds: Ids,
  coordinatorCapabilityId: Id,
  coordinatorDigest: Id,
});
export type FactoryIntegrationManifest = typeof FactoryIntegrationManifest.Type;
const ResumeTargets = {
  resumedAt: Schema.optionalKey(IsoDateTime),
  resumeThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  resumeQueues: Schema.optionalKey(Schema.Array(FactoryResumeQueue)),
};
export const FactoryIntegrationOperation = Schema.Struct({
  kind: Schema.Literals(["preparation", "verification"]),
  id: Id,
});
export type FactoryIntegrationOperation = typeof FactoryIntegrationOperation.Type;
export const FactoryIntegrationPreparation = Schema.Struct({
  ...ResumeTargets,
  inheritedResumeThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  inheritedResumeQueues: Schema.optionalKey(Schema.Array(FactoryResumeQueue)),
  id: Id,
  integrationId: Id,
  previousPreparationId: Schema.NullOr(Id),
  grantIds: Ids.check(Schema.isMinLength(2)),
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("requested") }),
    Schema.Struct({
      phase: Schema.Literal("ready"),
      manifest: FactoryIntegrationManifest,
      profileId: Id,
      testArtifactId: Id,
      preparedAt: IsoDateTime,
    }),
    Schema.Struct({ phase: Schema.Literal("failed"), reason: Text }),
  ]),
  createdAt: IsoDateTime,
});
export type FactoryIntegrationPreparation = typeof FactoryIntegrationPreparation.Type;
export const FactoryIntegrationTestArtifact = Schema.Struct({
  id: Id,
  integrationId: Id,
  preparationId: Id,
  digest: Id,
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      grantId: Id,
      candidateId: Id,
      candidateDigest: Id,
      sourceDigest: Id,
      changedPaths: Paths,
      deletedPaths: Paths,
      patchArtifactId: Id,
    }),
  ).check(Schema.isMaxLength(30)),
  capturedAt: IsoDateTime,
});
export type FactoryIntegrationTestArtifact = typeof FactoryIntegrationTestArtifact.Type;
const Check = Schema.Struct({
  id: Id,
  exitCode: Schema.NullOr(Schema.Int),
  status: Schema.Literals(["passed", "failed", "stopped"]),
  output: Schema.String.check(Schema.isMaxLength(64000)),
});
const Checks = Schema.Array(Check).check(Schema.isMaxLength(100));
const VerificationResult = Schema.Literals(["passed", "failed", "stopped"]);
export const FactoryIntegrationVerification = Schema.Struct({
  ...ResumeTargets,
  id: Id,
  integrationId: Id,
  preparationId: Id,
  inputDigest: Id,
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("requested") }),
    Schema.Struct({
      phase: Schema.Literal("completed"),
      result: VerificationResult,
      testArtifactId: Id,
      testArtifactDigest: Id,
      hostArtifactId: Id,
      checks: Checks,
      completedAt: IsoDateTime,
    }),
    Schema.Struct({ phase: Schema.Literal("failed"), reason: Text }),
  ]),
  createdAt: IsoDateTime,
});
export type FactoryIntegrationVerification = typeof FactoryIntegrationVerification.Type;
export const FactoryIntegrationMessage = Schema.Struct({
  id: Id,
  integrationId: Id,
  fromAssignmentId: FactoryAssignmentId,
  toAssignmentId: FactoryAssignmentId,
  senderThreadId: ThreadId,
  content: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("message"), text: Text }),
    Schema.Struct({
      kind: Schema.Literal("production-defect"),
      preparationId: Id,
      summary: Text,
      evidence: Schema.Array(FactoryEvidence).check(Schema.isMaxLength(30)),
    }),
  ]),
  delivery: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("pending") }),
    Schema.Struct({ phase: Schema.Literal("failed"), reason: Text }),
    Schema.Struct({
      phase: Schema.Literal("delivered"),
      recipientThreadId: ThreadId,
      messageId: MessageId,
      deliveredAt: IsoDateTime,
    }),
  ]),
  createdAt: IsoDateTime,
});
export type FactoryIntegrationMessage = typeof FactoryIntegrationMessage.Type;
const Fields = { commandId: CommandId };
export const FactoryIntegrationCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("integration.thread.retry"), ...Fields, integrationId: Id }),
  Schema.Struct({
    type: Schema.Literal("integration.capability.configure"),
    ...Fields,
    projectId: ProjectId,
    boundaryId: FactoryBoundaryId,
    paths: FactoryIntegrationPaths,
    coordinator: Schema.NullOr(FactoryIntegrationCoordinator),
  }),
  Schema.Struct({
    type: Schema.Literal("integration.capability.retry"),
    ...Fields,
    capabilityId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.commission"),
    ...Fields,
    managerId: ThreadId,
    requestIds: Ids.check(Schema.isMinLength(1)),
    title: Text,
    description: Text,
    complexity: FactoryTaskComplexity,
    coordinatorProjectId: ProjectId,
    modelSelection: Schema.optionalKey(ModelSelection),
  }),
  Schema.Struct({
    type: Schema.Literal("integration.grant"),
    ...Fields,
    integrationId: Id,
    projectId: ProjectId,
    capabilityId: Id,
    paths: FactoryIntegrationPaths,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.grant.revoke"),
    ...Fields,
    grantId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.refresh"),
    ...Fields,
    integrationId: Id,
    expectedPreparationId: Schema.NullOr(Id),
  }),
  Schema.Struct({
    type: Schema.Literal("integration.file.mutate"),
    ...Fields,
    integrationId: Id,
    preparationId: Id,
    grantId: Id,
    operation: FactoryFileMutation,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.verify"),
    ...Fields,
    integrationId: Id,
    preparationId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.message.send"),
    ...Fields,
    integrationId: Id,
    fromAssignmentId: FactoryAssignmentId,
    toAssignmentId: FactoryAssignmentId,
    text: Text,
  }),
  Schema.Struct({ type: Schema.Literal("integration.message.retry"), ...Fields, messageId: Id }),
  Schema.Struct({
    type: Schema.Literal("integration.defect.report"),
    ...Fields,
    integrationId: Id,
    participantAssignmentId: FactoryAssignmentId,
    preparationId: Id,
    summary: Text,
    evidence: Schema.Array(FactoryEvidence).check(Schema.isMaxLength(30)),
  }),
]);
export type FactoryIntegrationCommand = typeof FactoryIntegrationCommand.Type;
export const FactoryIntegrationHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("integration.hold.targets.recorded"),
    ...Fields,
    integrationId: Id,
    holdId: Id,
    threadIds: Schema.Array(ThreadId),
    resumeQueues: Schema.Array(FactoryResumeQueue),
  }),
  Schema.Struct({
    type: Schema.Literal("integration.operation.resumed"),
    ...Fields,
    integrationId: Id,
    operation: FactoryIntegrationOperation,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.operation.targets.recorded"),
    ...Fields,
    integrationId: Id,
    operation: FactoryIntegrationOperation,
    threadIds: Schema.Array(ThreadId),
    resumeQueues: Schema.Array(FactoryResumeQueue),
  }),
  Schema.Struct({
    type: Schema.Literal("integration.thread.created"),
    ...Fields,
    integrationId: Id,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.thread.failed"),
    ...Fields,
    integrationId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.capability.qualified"),
    ...Fields,
    capabilityId: Id,
    profileId: Id,
    configurationDigest: Id,
    coordinatorDigest: Schema.NullOr(Id),
  }),
  Schema.Struct({
    type: Schema.Literal("integration.capability.failed"),
    ...Fields,
    capabilityId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.prepared"),
    ...Fields,
    integrationId: Id,
    preparationId: Id,
    manifest: FactoryIntegrationManifest,
    profileId: Id,
    testArtifact: FactoryIntegrationTestArtifact,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.prepare.failed"),
    ...Fields,
    integrationId: Id,
    preparationId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.stopped"),
    ...Fields,
    integrationId: Id,
    holdId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.stop.failed"),
    ...Fields,
    integrationId: Id,
    holdId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.file.mutated"),
    ...Fields,
    integrationId: Id,
    preparationId: Id,
    operationId: Id,
    testArtifact: FactoryIntegrationTestArtifact,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.file.failed"),
    ...Fields,
    integrationId: Id,
    preparationId: Id,
    operationId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.verified"),
    ...Fields,
    verificationId: Id,
    result: VerificationResult,
    testArtifact: FactoryIntegrationTestArtifact,
    hostArtifactId: Id,
    checks: Checks,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.verify.failed"),
    ...Fields,
    verificationId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.message.recorded"),
    ...Fields,
    messageId: Id,
    recipientThreadId: ThreadId,
    deliveredMessageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.message.failed"),
    ...Fields,
    messageId: Id,
    reason: Text,
  }),
]);
export const FactoryIntegrationEffectIntent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("integration.resume"),
    integrationId: Id,
    operation: FactoryIntegrationOperation,
  }),
  Schema.Struct({ type: Schema.Literal("integration.thread.create"), integrationId: Id }),
  Schema.Struct({ type: Schema.Literal("integration.capability.qualify"), capabilityId: Id }),
  Schema.Struct({
    type: Schema.Literal("integration.prepare"),
    integrationId: Id,
    preparationId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.stop"),
    integrationId: Id,
    preparationId: Schema.NullOr(Id),
    holdId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("integration.file.mutate"),
    integrationId: Id,
    preparationId: Id,
    grantId: Id,
    operationId: Id,
    operation: FactoryFileMutation,
  }),
  Schema.Struct({ type: Schema.Literal("integration.verify"), verificationId: Id }),
  Schema.Struct({ type: Schema.Literal("integration.message.deliver"), messageId: Id }),
  Schema.Struct({
    type: Schema.Literal("integration.notify"),
    integrationId: Id,
    eventId: Id,
    recipientManagerIds: Schema.Array(ThreadId).check(Schema.isMaxLength(30)),
    recipientAssignmentIds: Schema.Array(FactoryAssignmentId).check(Schema.isMaxLength(31)),
    text: Text,
  }),
]);

const SlimParticipant = Schema.Struct({
  assignmentId: FactoryAssignmentId,
  projectId: ProjectId,
  managerId: ThreadId,
  threadId: ThreadId,
  title: Schema.NullOr(Text),
  status: Schema.Literals(["pending", "running", "waiting", "complete"]),
});
export const FactoryIntegrationRead = Schema.Struct({
  integration: FactoryIntegration,
  lead: Schema.NullOr(SlimParticipant),
  participants: Schema.Array(SlimParticipant).check(Schema.isMaxLength(30)),
  readiness: Schema.Struct({
    status: Schema.Literals(["missing", "running", "failed", "stale", "passed"]),
    verificationId: Schema.NullOr(Id),
    reasons: Schema.Array(Text),
    published: Schema.Boolean,
  }),
  integrationCapabilities: Schema.Array(FactoryIntegrationCapability),
  integrationGrants: Schema.Array(FactoryIntegrationGrant),
  integrationPreparations: Schema.Array(FactoryIntegrationPreparation),
  integrationTestArtifacts: Schema.Array(FactoryIntegrationTestArtifact),
  integrationVerifications: Schema.Array(FactoryIntegrationVerification),
  integrationMessages: Schema.Array(FactoryIntegrationMessage),
});
export type FactoryIntegrationRead = typeof FactoryIntegrationRead.Type;

export const FactoryIntegrationPatchPage = Schema.Struct({
  patchArtifactId: Id,
  projectId: ProjectId,
  digest: Id,
  encoding: Schema.Literal("json"),
  text: Schema.String.check(Schema.isMaxLength(16000)),
  cursor: NonNegativeInt,
  nextCursor: Schema.NullOr(NonNegativeInt),
  totalCharacters: NonNegativeInt,
});
export type FactoryIntegrationPatchPage = typeof FactoryIntegrationPatchPage.Type;
