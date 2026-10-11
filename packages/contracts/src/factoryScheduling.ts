import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryAssignmentId } from "./factoryControls.ts";
import { FactoryTaskComplexity } from "./factoryModels.ts";
import { FactoryDependencyId, FactorySupportingWork } from "./factoryOversight.ts";
import { IssueAttemptLink, IssueRef } from "./issues.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(6_000));
export const FactoryProjectImprovementRule = Schema.Struct({
  id: Id,
  allowedSourcePaths: Schema.Array(Id),
  creatableDirectories: Schema.Array(Id),
  allowedComplexities: Schema.Array(FactoryTaskComplexity).check(Schema.isMinLength(1)),
  allowedCauses: Schema.Array(Schema.Literals(["implementation", "project"])).check(
    Schema.isMinLength(1),
  ),
  protectedPaths: Schema.Array(Id),
  reason: Text,
});
export type FactoryProjectImprovementRule = typeof FactoryProjectImprovementRule.Type;

export const FactorySchedulingConfiguration = Schema.Struct({
  id: Id,
  projectId: ProjectId,
  boardId: Id,
  enabled: Schema.Boolean,
  maxConcurrentAssignments: NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  improvementRule: Schema.NullOr(FactoryProjectImprovementRule),
  approvedBy: CommandId,
  approvedAt: IsoDateTime,
});
export type FactorySchedulingConfiguration = typeof FactorySchedulingConfiguration.Type;

export const FactoryScheduleSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tracker-ready") }),
  Schema.Struct({ kind: Schema.Literal("project-improvement"), followupId: Id }),
]);
export type FactoryScheduleSource = typeof FactoryScheduleSource.Type;

export const FactoryScheduleObservation = Schema.Struct({
  title: Text,
  boardRevision: NonNegativeInt,
  itemId: Id,
  columnId: Schema.NullOr(Id),
  ready: Schema.Boolean,
  detailDigest: Id,
  observedAt: IsoDateTime,
});
export type FactoryScheduleObservation = typeof FactoryScheduleObservation.Type;

export const FactorySchedulePreparation = Schema.Struct({
  work: FactorySupportingWork,
  detailDigest: Id,
  priority: NonNegativeInt.check(Schema.isLessThanOrEqualTo(100)),
  dependencyIds: Schema.Array(FactoryDependencyId),
  recommendation: Text,
});
export type FactorySchedulePreparation = typeof FactorySchedulePreparation.Type;

export const FactoryScheduleAuthority = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tracker-ready"),
    boardId: Id,
    itemId: Id,
    observedAt: IsoDateTime,
  }),
  Schema.Struct({ kind: Schema.Literal("project-improvement"), ruleId: Id, followupId: Id }),
  // Direct human assignment: the human commissions the ticket, or the manager cites their message.
  Schema.Struct({
    kind: Schema.Literal("human"),
    commandId: CommandId,
    messageId: Schema.NullOr(MessageId),
  }),
]);
export type FactoryScheduleAuthority = typeof FactoryScheduleAuthority.Type;

export const FactoryScheduleCandidate = Schema.Struct({
  id: Id,
  projectId: ProjectId,
  managerId: ThreadId,
  issue: IssueRef,
  canonicalIssueKey: Id,
  generation: NonNegativeInt,
  reopenedFrom: Schema.optionalKey(
    Schema.Struct({ candidateId: Id, commandId: CommandId, reason: Text }),
  ),
  configurationId: Id,
  source: FactoryScheduleSource,
  observation: FactoryScheduleObservation,
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("observed") }),
    Schema.Struct({ phase: Schema.Literal("prepared"), preparation: FactorySchedulePreparation }),
    Schema.Struct({
      phase: Schema.Literal("held"),
      origin: Schema.Literals(["eligibility", "tracker"]),
      reason: Text,
      preparation: Schema.NullOr(FactorySchedulePreparation),
    }),
    Schema.Struct({
      phase: Schema.Literal("dismissed"),
      reason: Text,
      preparation: Schema.NullOr(FactorySchedulePreparation),
    }),
    Schema.Struct({
      phase: Schema.Literal("commissioned"),
      preparation: FactorySchedulePreparation,
      assignmentId: FactoryAssignmentId,
      authority: FactoryScheduleAuthority,
    }),
  ]),
  notifiedDigest: Schema.NullOr(Id),
  notificationDigest: Schema.NullOr(Id),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryScheduleCandidate = typeof FactoryScheduleCandidate.Type;

/** Host-produced context. Never accepted as a public command argument. */
export const FactorySchedulingAdmission = Schema.Struct({
  candidateId: Id,
  configurationId: Id,
  canonicalIssueKey: Id,
  workDigest: Id,
  detailDigest: Id,
  boardId: Id,
  boardFence: Id,
  authority: FactoryScheduleAuthority,
  issueAttempt: IssueAttemptLink,
});
export type FactorySchedulingAdmission = typeof FactorySchedulingAdmission.Type;

export const FactorySchedulingCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project.scheduling.configure"),
    commandId: CommandId,
    projectId: ProjectId,
    boardId: Id,
    enabled: Schema.Boolean,
    maxConcurrentAssignments: FactorySchedulingConfiguration.fields.maxConcurrentAssignments,
    improvementRule: Schema.NullOr(FactoryProjectImprovementRule),
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.prepare"),
    commandId: CommandId,
    candidateId: Id,
    preparation: FactorySchedulePreparation,
  }),
  /** Brings a board ticket that is not Ready into the queue to prepare. It authorizes nothing. */
  Schema.Struct({
    type: Schema.Literal("schedule.track"),
    commandId: CommandId,
    projectId: ProjectId,
    issueNumber: PositiveInt,
  }),
  Schema.Struct({ type: Schema.Literal("schedule.retry"), commandId: CommandId, candidateId: Id }),
  Schema.Struct({
    type: Schema.Literal("schedule.reopen"),
    commandId: CommandId,
    candidateId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.dismiss"),
    commandId: CommandId,
    candidateId: Id,
    reason: Text,
  }),
]);
export type FactorySchedulingCommand = typeof FactorySchedulingCommand.Type;

const ScheduleNotifications = Schema.Array(Schema.Struct({ candidateId: Id, digest: Id })).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(20),
);

export const FactorySchedulingHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("schedule.observed"),
    commandId: CommandId,
    projectId: ProjectId,
    configurationId: Id,
    issue: IssueRef,
    canonicalIssueKey: Id,
    source: FactoryScheduleSource,
    observation: FactoryScheduleObservation,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.held"),
    commandId: CommandId,
    candidateId: Id,
    reason: Text,
    origin: Schema.Literals(["eligibility", "tracker"]),
    expectedStateRevision: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.ready"),
    commandId: CommandId,
    candidateId: Id,
    expectedStateRevision: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.notified"),
    commandId: CommandId,
    managerId: ThreadId,
    notifications: ScheduleNotifications,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.notifications.requested"),
    commandId: CommandId,
    managerId: ThreadId,
    notifications: ScheduleNotifications,
  }),
]);
export type FactorySchedulingHostCommand = typeof FactorySchedulingHostCommand.Type;

export const FactorySchedulingEffectIntent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("schedule.reconcile"), projectId: ProjectId }),
  Schema.Struct({
    type: Schema.Literal("schedule.notify"),
    managerId: ThreadId,
    notifications: ScheduleNotifications,
  }),
  Schema.Struct({ type: Schema.Literal("schedule.release"), candidateId: Id }),
]);
export type FactorySchedulingEffectIntent = typeof FactorySchedulingEffectIntent.Type;
