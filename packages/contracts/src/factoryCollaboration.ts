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
import { FactoryAssignmentId, FactoryControlId, FactoryResumeQueue } from "./factoryControls.ts";
import { FactoryAssignmentScope, FactorySupportingWork } from "./factoryOversight.ts";

const Id = TrimmedNonEmptyString;
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(6000));
const Ids = Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(30));
const AssignmentIds = Schema.Array(FactoryAssignmentId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(30),
);
export const FactoryCollaborationCondition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("assignment-concluded"),
    assignmentId: FactoryAssignmentId,
  }),
  Schema.Struct({ kind: Schema.Literal("incident-released"), restrictionId: Id }),
  Schema.Struct({ kind: Schema.Literal("human-decision"), decisionId: Id }),
]);
export type FactoryCollaborationCondition = typeof FactoryCollaborationCondition.Type;
export const FactoryRequestOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("assignment"), assignmentId: FactoryAssignmentId }),
  Schema.Struct({ kind: Schema.Literal("investigation"), investigationId: Id }),
]);
const Support = Schema.Struct({ assignmentId: FactoryAssignmentId, dedicated: Schema.Boolean });
export const FactoryCrossProjectRequest = Schema.Struct({
  id: Id,
  origin: FactoryRequestOrigin,
  originManagerId: ThreadId,
  originThreadId: ThreadId,
  originalLeadThreadId: Schema.NullOr(ThreadId),
  receiverManagerId: ThreadId,
  outcome: Text,
  acceptanceConditions: Text,
  compatibility: Text,
  generation: NonNegativeInt,
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("requested") }),
    Schema.Struct({
      phase: Schema.Literal("deferred"),
      reason: Text,
      reconsider: FactoryCollaborationCondition,
    }),
    Schema.Struct({
      phase: Schema.Literal("declined"),
      reason: Text,
      alternative: Text,
      reconsider: Schema.NullOr(FactoryCollaborationCondition),
    }),
    Schema.Struct({
      phase: Schema.Literal("accepted"),
      support: Support,
      notifiedConclusionId: Schema.NullOr(Id),
    }),
    Schema.Struct({
      phase: Schema.Literal("withdrawn"),
      reason: Text,
      support: Schema.NullOr(Support),
      sourceControlId: Schema.NullOr(FactoryControlId),
    }),
  ]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryCrossProjectRequest = typeof FactoryCrossProjectRequest.Type;
export const FactoryCollaborationMessage = Schema.Struct({
  id: Id,
  requestId: Id,
  fromAssignmentId: FactoryAssignmentId,
  toAssignmentId: FactoryAssignmentId,
  senderThreadId: ThreadId,
  text: Text,
  createdAt: IsoDateTime,
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
});
export type FactoryCollaborationMessage = typeof FactoryCollaborationMessage.Type;
const PlanChanges = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("technical") }),
  Schema.Struct({ kind: Schema.Literal("boundary"), reason: Text }),
]);
export const FactoryCollaborationPlan = Schema.Struct({
  id: Id,
  requestIds: Ids,
  text: Text,
  changes: PlanChanges,
  participants: Schema.Array(
    Schema.Struct({
      assignmentId: FactoryAssignmentId,
      threadId: ThreadId,
      scope: FactoryAssignmentScope,
      grantEpoch: NonNegativeInt,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  acknowledgements: Schema.Array(
    Schema.Struct({
      assignmentId: FactoryAssignmentId,
      threadId: ThreadId,
      acknowledgedAt: IsoDateTime,
    }),
  ),
  phase: Schema.Literals(["proposed", "agreed", "escalated", "superseded"]),
  createdAt: IsoDateTime,
});
export type FactoryCollaborationPlan = typeof FactoryCollaborationPlan.Type;
const DecisionOptions = Schema.Array(Schema.Struct({ id: Id, description: Text })).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(10),
);
export const FactoryCollaborationDecision = Schema.Struct({
  id: Id,
  requestIds: Ids,
  revision: Id,
  summary: Text,
  options: DecisionOptions,
  recommendations: Schema.Array(
    Schema.Struct({ authorThreadId: Schema.NullOr(ThreadId), text: Text }),
  ),
  resolution: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("pending") }),
    Schema.Struct({
      phase: Schema.Literal("decided"),
      optionId: Id,
      reason: Text,
      commandId: CommandId,
      decidedAt: IsoDateTime,
    }),
  ]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryCollaborationDecision = typeof FactoryCollaborationDecision.Type;
export const FactoryIncidentActivity = Schema.Literals(["execution", "delivery", "preview"]);
export const FactoryIncidentRestriction = Schema.Struct({
  id: Id,
  managerId: ThreadId,
  projectId: ProjectId,
  assignmentIds: AssignmentIds,
  activity: FactoryIncidentActivity,
  reason: Text,
  resumeCondition: FactoryCollaborationCondition,
  phase: Schema.Literals(["active", "releasing", "released"]),
  stop: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("pending") }),
    Schema.Struct({ phase: Schema.Literal("confirmed") }),
    Schema.Struct({ phase: Schema.Literal("failed"), reason: Text }),
  ]),
  resume: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ phase: Schema.Literal("pending") }),
      Schema.Struct({ phase: Schema.Literal("failed"), reason: Text }),
    ]),
  ),
  resumeThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  resumeQueues: Schema.optionalKey(Schema.Array(FactoryResumeQueue)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryIncidentRestriction = typeof FactoryIncidentRestriction.Type;
export const FactoryCollaborationDirectoryEntry = Schema.Struct({
  managerId: ThreadId,
  name: Schema.NullOr(Text),
  role: Schema.Literals(["project", "system"]),
  projectId: Schema.NullOr(ProjectId),
  status: Schema.Literals(["onboarding", "blocked", "active", "paused"]),
});
export type FactoryCollaborationDirectoryEntry = typeof FactoryCollaborationDirectoryEntry.Type;
const Fields = { commandId: CommandId };
export const FactoryCollaborationCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("collaboration.request.create"),
    ...Fields,
    origin: FactoryRequestOrigin,
    receiverManagerId: ThreadId,
    outcome: Text,
    acceptanceConditions: Text,
    compatibility: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration.request.respond"),
    ...Fields,
    requestId: Id,
    response: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("accept"),
        support: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("commission"), work: FactorySupportingWork }),
          Schema.Struct({ kind: Schema.Literal("existing"), assignmentId: FactoryAssignmentId }),
        ]),
      }),
      Schema.Struct({
        kind: Schema.Literal("defer"),
        reason: Text,
        reconsider: FactoryCollaborationCondition,
      }),
      Schema.Struct({
        kind: Schema.Literal("decline"),
        reason: Text,
        alternative: Text,
        reconsider: Schema.NullOr(FactoryCollaborationCondition),
      }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration.request.withdraw"),
    ...Fields,
    requestId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration.request.reconsider"),
    ...Fields,
    requestId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration.message.send"),
    ...Fields,
    requestId: Id,
    fromAssignmentId: FactoryAssignmentId,
    toAssignmentId: FactoryAssignmentId,
    text: Text,
  }),
  Schema.Struct({ type: Schema.Literal("collaboration.message.retry"), ...Fields, messageId: Id }),
  Schema.Struct({
    type: Schema.Literal("collaboration.plan.propose"),
    ...Fields,
    requestIds: Ids,
    text: Text,
    changes: PlanChanges,
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration.plan.acknowledge"),
    ...Fields,
    planId: Id,
    assignmentId: FactoryAssignmentId,
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration.decision.raise"),
    ...Fields,
    requestIds: Ids,
    summary: Text,
    options: DecisionOptions,
    recommendation: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration.decision.decide"),
    ...Fields,
    decisionId: Id,
    revision: Id,
    optionId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("incident.restrict"),
    ...Fields,
    managerId: ThreadId,
    assignmentIds: AssignmentIds,
    activity: FactoryIncidentActivity,
    reason: Text,
    resumeCondition: FactoryCollaborationCondition,
  }),
  Schema.Struct({ type: Schema.Literal("incident.release"), ...Fields, restrictionId: Id }),
  Schema.Struct({ type: Schema.Literal("incident.retry"), ...Fields, restrictionId: Id }),
]);
export type FactoryCollaborationCommand = typeof FactoryCollaborationCommand.Type;
export const FactoryCollaborationHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("collaboration.request.support-concluded"),
    ...Fields,
    requestId: Id,
    conclusionId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("incident.targets.recorded"),
    ...Fields,
    restrictionId: Id,
    threadIds: Schema.Array(ThreadId),
    resumeQueues: Schema.Array(FactoryResumeQueue),
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration.message.recorded"),
    ...Fields,
    messageId: Id,
    recipientThreadId: ThreadId,
    deliveredMessageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration.message.failed"),
    ...Fields,
    messageId: Id,
    reason: Text,
  }),
  Schema.Struct({ type: Schema.Literal("incident.stopped"), ...Fields, restrictionId: Id }),
  Schema.Struct({ type: Schema.Literal("incident.resumed"), ...Fields, restrictionId: Id }),
  Schema.Struct({
    type: Schema.Literal("incident.failed"),
    ...Fields,
    restrictionId: Id,
    step: Schema.Literals(["stop", "resume"]),
    reason: Text,
  }),
]);
export const FactoryCollaborationEffectIntent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("incident.queue.resume"),
    restrictionId: Id,
    ...FactoryResumeQueue.fields,
  }),
  Schema.Struct({ type: Schema.Literal("collaboration.message.deliver"), messageId: Id }),
  Schema.Struct({
    type: Schema.Literal("collaboration.notify"),
    subject: Schema.Struct({
      kind: Schema.Literals(["request", "plan", "decision", "incident"]),
      id: Id,
    }),
    eventId: Id,
    recipientManagerIds: Schema.Array(ThreadId),
    recipientAssignmentIds: Schema.Array(FactoryAssignmentId),
    text: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("incident.stop"),
    restrictionId: Id,
    assignmentIds: AssignmentIds,
  }),
  Schema.Struct({
    type: Schema.Literal("incident.resume"),
    restrictionId: Id,
    assignmentIds: AssignmentIds,
  }),
]);
