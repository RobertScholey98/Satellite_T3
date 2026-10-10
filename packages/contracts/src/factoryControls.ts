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

export const FactoryAssignmentId = TrimmedNonEmptyString.pipe(Schema.brand("FactoryAssignmentId"));
export type FactoryAssignmentId = typeof FactoryAssignmentId.Type;
export const FactoryControlId = TrimmedNonEmptyString.pipe(Schema.brand("FactoryControlId"));
export type FactoryControlId = typeof FactoryControlId.Type;

export const FactoryStopState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("confirmed"), stoppedAt: IsoDateTime }),
  Schema.Struct({ status: Schema.Literal("failed"), detail: TrimmedNonEmptyString }),
]);
export type FactoryStopState = typeof FactoryStopState.Type;
export const FactoryResumeState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("failed"), detail: TrimmedNonEmptyString }),
]);
export type FactoryResumeState = typeof FactoryResumeState.Type;

const ControlFields = {
  id: FactoryControlId,
  generation: NonNegativeInt,
  requestedAt: IsoDateTime,
  updatedAt: IsoDateTime,
};
export const FactoryResumeQueue = Schema.Struct({
  threadId: ThreadId,
  runIds: Schema.Array(RunId),
});
export type FactoryResumeQueue = typeof FactoryResumeQueue.Type;
const PauseFields = {
  ...ControlFields,
  status: Schema.Literals(["active", "released"]),
  stop: FactoryStopState,
  resume: Schema.optionalKey(FactoryResumeState),
  resumeThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  resumeQueues: Schema.optionalKey(Schema.Array(FactoryResumeQueue)),
};

export const FactoryControl = Schema.Union([
  Schema.Struct({
    ...PauseFields,
    kind: Schema.Literal("manager-pause"),
    managerId: ThreadId,
    priorStatus: Schema.Literals(["onboarding", "blocked", "active"]),
  }),
  Schema.Struct({ ...PauseFields, kind: Schema.Literal("project-pause"), projectId: ProjectId }),
  Schema.Struct({
    ...ControlFields,
    kind: Schema.Literal("takeover"),
    status: Schema.Literals(["active", "released"]),
    threadId: ThreadId,
    assignmentId: FactoryAssignmentId,
    managerId: ThreadId,
    parentThreadId: ThreadId,
  }),
  Schema.Struct({
    ...ControlFields,
    kind: Schema.Literal("cancellation"),
    assignmentId: FactoryAssignmentId,
    managerId: ThreadId,
    stop: FactoryStopState,
    reason: Schema.optionalKey(
      Schema.Struct({ text: TrimmedNonEmptyString, recordedAt: IsoDateTime }),
    ),
  }),
]);
export type FactoryControl = typeof FactoryControl.Type;

export const FactoryGuidance = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  assignmentId: FactoryAssignmentId,
  observedAt: IsoDateTime,
  escalation: Schema.optionalKey(
    Schema.Struct({ summary: TrimmedNonEmptyString, escalatedAt: IsoDateTime }),
  ),
});
export type FactoryGuidance = typeof FactoryGuidance.Type;

export const FactoryControlCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("manager.pause"),
    commandId: CommandId,
    managerId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("manager.resume"),
    commandId: CommandId,
    managerId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("project.pause"),
    commandId: CommandId,
    projectId: ProjectId,
  }),
  Schema.Struct({
    type: Schema.Literal("project.resume"),
    commandId: CommandId,
    projectId: ProjectId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.takeover"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.handback"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.cancel"),
    commandId: CommandId,
    assignmentId: FactoryAssignmentId,
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.cancellation-reason"),
    commandId: CommandId,
    assignmentId: FactoryAssignmentId,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("control.retry"),
    commandId: CommandId,
    controlId: FactoryControlId,
    generation: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("guidance.escalate"),
    commandId: CommandId,
    threadId: ThreadId,
    messageId: MessageId,
    summary: TrimmedNonEmptyString,
  }),
]);
export type FactoryControlCommand = typeof FactoryControlCommand.Type;

const ReceiptFields = {
  commandId: CommandId,
  controlId: FactoryControlId,
  generation: NonNegativeInt,
};
export const FactoryControlHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread.delivery.recorded"),
    commandId: CommandId,
    threadId: ThreadId,
    messageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.queue.resumed"),
    ...ReceiptFields,
    threadId: ThreadId,
  }),
  Schema.Struct({
    ...ReceiptFields,
    type: Schema.Literal("control.stop.targets.recorded"),
    threadIds: Schema.Array(ThreadId),
    resumeQueues: Schema.optionalKey(Schema.Array(FactoryResumeQueue)),
  }),
  Schema.Struct({ ...ReceiptFields, type: Schema.Literal("control.stop.recorded") }),
  Schema.Struct({
    ...ReceiptFields,
    type: Schema.Literal("control.stop.failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...ReceiptFields, type: Schema.Literal("control.resume.recorded") }),
  Schema.Struct({
    ...ReceiptFields,
    type: Schema.Literal("control.resume.failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("guidance.observed"),
    commandId: CommandId,
    threadId: ThreadId,
    messageId: MessageId,
    assignmentId: FactoryAssignmentId,
  }),
]);
export type FactoryControlHostCommand = typeof FactoryControlHostCommand.Type;

export const FactoryControlEffectIntent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread.queue.resume"),
    controlId: FactoryControlId,
    generation: NonNegativeInt,
    threadId: ThreadId,
    runIds: Schema.optionalKey(Schema.Array(RunId)),
  }),
  Schema.Struct({
    type: Schema.Literal("control.stop"),
    controlId: FactoryControlId,
    generation: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("control.resume"),
    controlId: FactoryControlId,
    generation: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.deliver"),
    threadId: ThreadId,
    messageId: MessageId,
    kind: Schema.Literals(["guidance", "coordination", "continuation"]),
    purpose: Schema.optionalKey(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("dependency-usability"),
          dependencyId: TrimmedNonEmptyString,
          deliveryId: TrimmedNonEmptyString,
        }),
        Schema.Struct({ kind: Schema.Literal("recovery"), incidentId: TrimmedNonEmptyString }),
      ]),
    ),
    text: TrimmedNonEmptyString,
    sourceThreadId: Schema.optionalKey(ThreadId),
    sourceMessageId: Schema.optionalKey(MessageId),
  }),
]);
export type FactoryControlEffectIntent = typeof FactoryControlEffectIntent.Type;
