import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryAssignmentId, FactoryControlId } from "./factoryControls.ts";
import { FactoryDeliveryEvidence, FactoryNoPrTarget } from "./factoryOversight.ts";
import {
  IssuePublicationDestination,
  IssuePublicationDraft,
  IssuePublicationReceipt,
  QualifiedIssueDestination,
} from "./issuePublication.ts";
import { IssueRef } from "./issues.ts";
import { ModelSelection } from "./modelSelection.ts";
import { PullRequestRef } from "./pullRequest.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(6_000));
const Ids = Schema.Array(Id).check(Schema.isMaxLength(30));

export const FactoryRequiredPullRequest = Schema.Struct({
  id: Id,
  ref: PullRequestRef,
  expectedHeadSha: Schema.NullOr(Id),
});
export type FactoryRequiredPullRequest = typeof FactoryRequiredPullRequest.Type;

export const FactoryCompletionPlan = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull-requests"),
    version: NonNegativeInt,
    requirements: Schema.Array(FactoryRequiredPullRequest).check(Schema.isMaxLength(30)),
    sealed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("no-pr"),
    target: FactoryNoPrTarget,
    condition: Text,
  }),
]);
export type FactoryCompletionPlan = typeof FactoryCompletionPlan.Type;

export const FactoryCompletionWaiver = Schema.Struct({
  requirementId: Id,
  commandId: CommandId,
  reason: Text,
  decidedAt: IsoDateTime,
});
export type FactoryCompletionWaiver = typeof FactoryCompletionWaiver.Type;

export const FactoryRetroEvidenceRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("message"), threadId: ThreadId, messageId: MessageId }),
  Schema.Struct({ kind: Schema.Literal("run"), threadId: ThreadId, runId: RunId }),
  Schema.Struct({
    kind: Schema.Literals([
      "verification",
      "candidate",
      "delivery-review",
      "delivery",
      "guidance",
      "dependency",
    ]),
    id: Id,
  }),
]);
export type FactoryRetroEvidenceRef = typeof FactoryRetroEvidenceRef.Type;
const EvidenceRefs = Schema.Array(FactoryRetroEvidenceRef).check(Schema.isMaxLength(30));

const ConclusionFields = {
  id: Id,
  evidenceDigest: Id,
  concludedAt: IsoDateTime,
};
export const FactoryConclusion = Schema.Union([
  Schema.Struct({
    ...ConclusionFields,
    kind: Schema.Literal("shared-group-delivered"),
    operationId: Id,
    groupId: Id,
    receiptDigest: Id,
  }),
  Schema.Struct({
    ...ConclusionFields,
    kind: Schema.Literal("delivered"),
    planVersion: NonNegativeInt,
    deliveryIds: Ids.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    ...ConclusionFields,
    kind: Schema.Literal("partially-delivered-and-cancelled"),
    planVersion: NonNegativeInt,
    deliveryIds: Ids,
    waiverCommandIds: Schema.Array(CommandId).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  }),
  Schema.Struct({
    ...ConclusionFields,
    kind: Schema.Literal("cancelled"),
    controlId: FactoryControlId,
    reasonRecordedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...ConclusionFields,
    kind: Schema.Literal("no-pr-delivered"),
    proof: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("report-received"), deliveryId: Id }),
      Schema.Struct({ kind: Schema.Literal("human-acceptance"), commandId: CommandId }),
    ]),
  }),
]);
export type FactoryConclusion = typeof FactoryConclusion.Type;

export const FactoryAssignmentCompletion = Schema.Struct({
  phase: Schema.Literals(["collecting", "concluding", "concluded"]),
  waitReason: Schema.NullOr(Text),
  plan: FactoryCompletionPlan,
  deliveries: Schema.Array(FactoryDeliveryEvidence).check(Schema.isMaxLength(30)),
  waivers: Schema.Array(FactoryCompletionWaiver).check(Schema.isMaxLength(30)),
  acceptance: Schema.NullOr(
    Schema.Struct({
      commandId: CommandId,
      evidence: EvidenceRefs,
      acceptedAt: IsoDateTime,
    }),
  ),
  conclusion: Schema.NullOr(FactoryConclusion),
});
export type FactoryAssignmentCompletion = typeof FactoryAssignmentCompletion.Type;

export const FactoryFindingCause = Schema.Literals([
  "implementation",
  "project",
  "reusable-capability",
  "shared-system",
  "uncertain",
]);
export type FactoryFindingCause = typeof FactoryFindingCause.Type;

export const FactoryFindingOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("implementation-lead"), assignmentId: FactoryAssignmentId }),
  Schema.Struct({ kind: Schema.Literal("project-manager"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literals(["system-remit", "human"]) }),
]);
export type FactoryFindingOwner = typeof FactoryFindingOwner.Type;

export const FactoryFindingRoute = Schema.Struct({
  suspectedCause: FactoryFindingCause,
  uncertainty: Text,
  owner: FactoryFindingOwner,
  requiredAuthority: Text,
  rationale: Text,
});
export type FactoryFindingRoute = typeof FactoryFindingRoute.Type;

export const FactoryFindingDraft = Schema.Struct({
  problem: Text,
  impact: Text,
  evidence: EvidenceRefs.check(Schema.isMinLength(1)),
  activeBlocker: Schema.Boolean,
  route: FactoryFindingRoute,
  containmentOf: Schema.NullOr(Id),
});
export type FactoryFindingDraft = typeof FactoryFindingDraft.Type;

export const FactoryFinding = Schema.Struct({
  ...FactoryFindingDraft.fields,
  id: Id,
  assignmentId: FactoryAssignmentId,
  reporterThreadId: Schema.NullOr(ThreadId),
  history: Schema.Array(
    Schema.Struct({
      route: FactoryFindingRoute,
      commandId: CommandId,
      recordedAt: IsoDateTime,
    }),
  ),
  escalation: Schema.NullOr(
    Schema.Struct({
      summary: Text,
      commandId: CommandId,
      escalatedAt: IsoDateTime,
      // Set when the human has reviewed an escalation that had no system manager to receive it.
      acknowledgedAt: Schema.optionalKey(IsoDateTime),
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryFinding = typeof FactoryFinding.Type;

export const FactoryRetroLearning = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("no-process-change"), reason: Text }),
  Schema.Struct({ kind: Schema.Literal("findings"), findingIds: Ids.check(Schema.isMinLength(1)) }),
]);
export type FactoryRetroLearning = typeof FactoryRetroLearning.Type;

export const FactoryTeamRetroDraft = Schema.Struct({
  outcome: Text,
  helped: Schema.String.check(Schema.isMaxLength(6_000)),
  hindered: Schema.String.check(Schema.isMaxLength(6_000)),
  contributions: EvidenceRefs,
  learning: FactoryRetroLearning,
});
export type FactoryTeamRetroDraft = typeof FactoryTeamRetroDraft.Type;

export const FactoryFindingDisposition = Schema.Union([
  Schema.Struct({ findingId: Id, kind: Schema.Literal("no-action"), reason: Text }),
  Schema.Struct({ findingId: Id, kind: Schema.Literal("ticket"), followupId: Id }),
  Schema.Struct({ findingId: Id, kind: Schema.Literal("existing-ticket"), issue: IssueRef }),
  Schema.Struct({
    findingId: Id,
    kind: Schema.Literals(["investigate", "shared-proposal"]),
    owner: FactoryFindingOwner,
    nextAction: Text,
    requiredAuthority: Text,
  }),
]);
export type FactoryFindingDisposition = typeof FactoryFindingDisposition.Type;

export const FactoryManagerRetroDraft = Schema.Struct({
  summary: Text,
  learning: FactoryRetroLearning,
  dispositions: Schema.Array(FactoryFindingDisposition).check(Schema.isMaxLength(30)),
});
export type FactoryManagerRetroDraft = typeof FactoryManagerRetroDraft.Type;

const ReportReceipt = {
  digest: Id,
  commandId: CommandId,
  submittedBy: Schema.NullOr(ThreadId),
  submittedAt: IsoDateTime,
};
export const FactoryTeamRetroReport = Schema.Struct({
  ...FactoryTeamRetroDraft.fields,
  ...ReportReceipt,
});
export type FactoryTeamRetroReport = typeof FactoryTeamRetroReport.Type;
export const FactoryManagerRetroReport = Schema.Struct({
  ...FactoryManagerRetroDraft.fields,
  ...ReportReceipt,
  teamReportDigest: Id,
});
export type FactoryManagerRetroReport = typeof FactoryManagerRetroReport.Type;

export const FactoryRetroQualification = Schema.Struct({
  status: Schema.Literal("qualified"),
  profileId: Id,
  checkedAt: IsoDateTime,
});
export type FactoryRetroQualification = typeof FactoryRetroQualification.Type;

export const FactoryRetro = Schema.Struct({
  id: Id,
  assignmentId: FactoryAssignmentId,
  conclusionId: Id,
  evidenceDigest: Id,
  threadId: ThreadId,
  modelSelection: ModelSelection,
  execution: Schema.Union([
    Schema.Struct({ status: Schema.Literal("preparing") }),
    Schema.Struct({
      status: Schema.Literal("ready"),
      qualification: FactoryRetroQualification,
      sourceDigest: Id,
      launch: Schema.Literals(["pending", "delivered"]),
    }),
    Schema.Struct({ status: Schema.Literal("failed"), reason: Text }),
    Schema.Struct({ status: Schema.Literal("stopped") }),
  ]),
  reports: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("team-pending") }),
    Schema.Struct({ phase: Schema.Literal("manager-pending"), team: FactoryTeamRetroReport }),
    Schema.Struct({
      phase: Schema.Literal("complete"),
      team: FactoryTeamRetroReport,
      manager: FactoryManagerRetroReport,
    }),
  ]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryRetro = typeof FactoryRetro.Type;

export const FactoryProjectTracker = Schema.Struct({
  id: Id,
  projectId: ProjectId,
  destination: QualifiedIssueDestination,
  approvedBy: CommandId,
  approvedAt: IsoDateTime,
});
export type FactoryProjectTracker = typeof FactoryProjectTracker.Type;

export const FactoryFollowup = Schema.Struct({
  id: Id,
  assignmentId: FactoryAssignmentId,
  projectId: ProjectId,
  findingIds: Ids.check(Schema.isMinLength(1)),
  draft: IssuePublicationDraft,
  error: Schema.NullOr(Text),
  existingIssue: Schema.NullOr(IssueRef),
  publication: Schema.Union([
    Schema.Struct({ status: Schema.Literal("configuration-required"), reason: Text }),
    Schema.Struct({
      status: Schema.Literal("requested"),
      trackerId: Id,
      requestId: Id,
    }),
    Schema.Struct({
      status: Schema.Literal("recorded"),
      trackerId: Id,
      receipt: IssuePublicationReceipt,
    }),
    Schema.Struct({ status: Schema.Literal("linked"), issue: IssueRef, verifiedAt: IsoDateTime }),
  ]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryFollowup = typeof FactoryFollowup.Type;

const AssignmentFields = { commandId: CommandId, assignmentId: FactoryAssignmentId };
const RetroFields = { commandId: CommandId, retroId: Id };
export const FactoryRetroCommand = Schema.Union([
  Schema.Struct({ ...AssignmentFields, type: Schema.Literal("assignment.completion.retry") }),
  Schema.Struct({
    ...AssignmentFields,
    type: Schema.Literal("assignment.completion.plan"),
    expectedVersion: NonNegativeInt,
    requirements: Schema.Array(FactoryRequiredPullRequest).check(Schema.isMaxLength(30)),
    seal: Schema.Boolean,
  }),
  Schema.Struct({
    ...AssignmentFields,
    type: Schema.Literal("assignment.completion.waive"),
    expectedVersion: NonNegativeInt,
    requirementIds: Ids.check(Schema.isMinLength(1)),
    reason: Text,
  }),
  Schema.Struct({
    ...AssignmentFields,
    type: Schema.Literal("assignment.completion.accept"),
    condition: Text,
    evidence: EvidenceRefs.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    ...AssignmentFields,
    type: Schema.Literal("finding.report"),
    findingId: Id,
    finding: FactoryFindingDraft,
  }),
  Schema.Struct({
    type: Schema.Literal("finding.route"),
    commandId: CommandId,
    findingId: Id,
    route: FactoryFindingRoute,
  }),
  Schema.Struct({
    type: Schema.Literal("finding.escalate"),
    commandId: CommandId,
    findingId: Id,
    summary: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("finding.escalation.acknowledge"),
    commandId: CommandId,
    findingId: Id,
  }),
  Schema.Struct({
    ...RetroFields,
    type: Schema.Literal("retro.team.submit"),
    conclusionId: Id,
    report: FactoryTeamRetroDraft,
  }),
  Schema.Struct({
    ...RetroFields,
    type: Schema.Literal("retro.manager.submit"),
    teamReportDigest: Id,
    report: FactoryManagerRetroDraft,
  }),
  Schema.Struct({ ...RetroFields, type: Schema.Literal("retro.retry") }),
  Schema.Struct({
    ...AssignmentFields,
    type: Schema.Literal("followup.request"),
    followupId: Id,
    findingIds: Ids.check(Schema.isMinLength(1)),
    draft: IssuePublicationDraft,
  }),
  Schema.Struct({ type: Schema.Literal("followup.retry"), commandId: CommandId, followupId: Id }),
  Schema.Struct({
    type: Schema.Literal("followup.link-existing"),
    commandId: CommandId,
    followupId: Id,
    issue: IssueRef,
  }),
  Schema.Struct({
    type: Schema.Literal("project.tracker.configure"),
    commandId: CommandId,
    projectId: ProjectId,
    expectedTrackerId: Schema.NullOr(Id),
    destination: IssuePublicationDestination,
  }),
]);
export type FactoryRetroCommand = typeof FactoryRetroCommand.Type;

export const FactoryRetroHostCommand = Schema.Union([
  Schema.Struct({
    ...AssignmentFields,
    type: Schema.Literal("assignment.completion.failed"),
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("followup.failed"),
    commandId: CommandId,
    followupId: Id,
    reason: Text,
  }),
  Schema.Struct({
    ...AssignmentFields,
    type: Schema.Literal("assignment.completion.begin"),
    expectedStateRevision: NonNegativeInt,
  }),
  Schema.Struct({
    ...AssignmentFields,
    type: Schema.Literal("assignment.completion.reopen"),
    expectedStateRevision: NonNegativeInt,
    reason: Text,
    discoveredRequirements: Schema.Array(FactoryRequiredPullRequest).check(Schema.isMaxLength(30)),
  }),
  Schema.Struct({
    ...AssignmentFields,
    type: Schema.Literal("assignment.concluded"),
    expectedStateRevision: NonNegativeInt,
    expectedProjectThreadFence: Id,
    conclusion: FactoryConclusion,
    retroThreadId: ThreadId,
    modelSelection: ModelSelection,
  }),
  Schema.Struct({
    ...RetroFields,
    type: Schema.Literal("retro.prepared"),
    qualification: FactoryRetroQualification,
    sourceDigest: Id,
  }),
  Schema.Struct({ ...RetroFields, type: Schema.Literal("retro.started") }),
  Schema.Struct({
    ...RetroFields,
    type: Schema.Literal("retro.failed"),
    reason: Text,
    expectedStateRevision: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({ ...RetroFields, type: Schema.Literal("retro.stopped") }),
  Schema.Struct({
    type: Schema.Literal("followup.publication.recorded"),
    commandId: CommandId,
    followupId: Id,
    receipt: IssuePublicationReceipt,
  }),
  Schema.Struct({
    type: Schema.Literal("followup.linked"),
    commandId: CommandId,
    followupId: Id,
    receipt: IssuePublicationReceipt,
  }),
]);
export type FactoryRetroHostCommand = typeof FactoryRetroHostCommand.Type;

export const FactoryRetroEffectIntent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("assignment.conclude"), assignmentId: FactoryAssignmentId }),
  Schema.Struct({ type: Schema.Literal("retro.launch"), retroId: Id }),
  Schema.Struct({ type: Schema.Literal("retro.stop"), retroId: Id }),
  Schema.Struct({
    type: Schema.Literal("retro.manager-notify"),
    retroId: Id,
    teamReportDigest: Id,
  }),
  Schema.Struct({ type: Schema.Literal("followup.publish"), followupId: Id }),
  Schema.Struct({ type: Schema.Literal("followup.link"), followupId: Id, issue: IssueRef }),
]);
export type FactoryRetroEffectIntent = typeof FactoryRetroEffectIntent.Type;
