import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  ProjectId,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import type { OrchestrationMessageContext } from "./composerContext.ts";
import { type OrchestrationV2Command, OrchestrationV2ThreadShellJson } from "./orchestrationV2.ts";
import { ThreadPurpose, type IdeaMutation } from "./ideas.ts";
import { CommitRecommendation } from "./commitRecommendation.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import {
  ThreadPullRequestLink,
  ThreadLinkedPullRequest,
  type ThreadPullRequestSnapshot,
  type ThreadPullRequestKey,
} from "./threadPullRequest.ts";

/** A bounded activity view used by Satellite's request pills and notebook source links. */
export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: Schema.Literals(["info", "tool", "approval", "error"]),
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

export const ORCHESTRATION_REQUEST_LIFECYCLE_MAX_ROWS = 4;
export const ORCHESTRATION_REQUEST_LIFECYCLE_MAX_ROW_BYTES = 65_536;
export const OrchestrationGetRequestLifecycleInput = Schema.Struct({
  threadId: ThreadId,
  audience: Schema.Literals(["work", "idea"]),
  kind: Schema.Literals(["question", "approval"]),
  requestId: RuntimeRequestId,
  submittedAt: Schema.optionalKey(IsoDateTime),
});
export type OrchestrationGetRequestLifecycleInput =
  typeof OrchestrationGetRequestLifecycleInput.Type;
export const OrchestrationGetRequestLifecycleResult = Schema.Array(
  OrchestrationThreadActivity,
).check(Schema.isMaxLength(ORCHESTRATION_REQUEST_LIFECYCLE_MAX_ROWS));
export type OrchestrationGetRequestLifecycleResult =
  typeof OrchestrationGetRequestLifecycleResult.Type;
export class OrchestrationGetRequestLifecycleError extends Schema.TaggedError<OrchestrationGetRequestLifecycleError>()(
  "OrchestrationGetRequestLifecycleError",
  { reason: Schema.Literals(["thread-unavailable", "payload-too-large", "query-failed"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "thread-unavailable":
        return "This request is unavailable in the selected workspace.";
      case "payload-too-large":
        return "This request is too large to check here. Open its thread to review it.";
      case "query-failed":
        return "Could not check this request. Try again.";
    }
  }
}

/** Internal DTOs for Satellite services while all execution and persistence use V2. */
export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant", "system", "reasoning"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;
export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals([
    "idle",
    "starting",
    "running",
    "ready",
    "interrupted",
    "stopped",
    "error",
  ]),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;
const optionalDate = Schema.NullOr(IsoDateTime).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  purpose: Schema.optional(ThreadPurpose),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("default" as const)),
  ),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  commitRecommendation: Schema.optional(Schema.NullOr(CommitRecommendation)),
  pullRequests: Schema.Array(ThreadPullRequestLink).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  latestTurn: Schema.NullOr(
    Schema.Struct({
      turnId: TurnId,
      state: Schema.Literals(["running", "interrupted", "completed", "error"]),
      requestedAt: IsoDateTime,
      startedAt: Schema.NullOr(IsoDateTime),
      completedAt: Schema.NullOr(IsoDateTime),
      assistantMessageId: Schema.NullOr(MessageId),
    }),
  ),
  session: Schema.NullOr(OrchestrationSession),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: optionalDate,
  settledAt: optionalDate,
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  latestUserMessageAt: optionalDate,
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  titleRegeneration: Schema.optional(
    Schema.NullOr(Schema.Struct({ requestId: CommandId, startedAt: IsoDateTime })),
  ),
  titleState: OrchestrationV2ThreadShellJson.fields.titleState,
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;
export const OrchestrationThread = Schema.Struct({
  ...OrchestrationThreadShell.fields,
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  proposedPlans: Schema.Array(Schema.Struct({ planMarkdown: Schema.String })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;
export type OrchestrationCommand =
  | OrchestrationV2Command
  | (Omit<
      Extract<OrchestrationV2Command, { type: "thread.create" }>,
      "createdBy" | "creationSource"
    > & { readonly createdAt?: string })
  | {
      readonly type: "thread.turn.start";
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly message: {
        readonly messageId: MessageId;
        readonly role: "user";
        readonly text: string;
        readonly attachments: readonly ChatAttachment[];
        readonly context?: OrchestrationMessageContext;
      };
      readonly modelSelection?: OrchestrationV2ThreadShellJson["modelSelection"];
      readonly runtimeMode: OrchestrationV2ThreadShellJson["runtimeMode"];
      readonly interactionMode: OrchestrationV2ThreadShellJson["interactionMode"];
      readonly createdAt: string;
    }
  | {
      readonly type: "thread.turn.interrupt";
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly createdAt?: string;
    }
  | {
      readonly type: "thread.meta.update";
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly commitRecommendation?: OrchestrationV2ThreadShellJson["commitRecommendation"];
      readonly title?: string;
    }
  | {
      readonly type: "thread.title.generate.complete";
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly expectedTitle: string;
      readonly expectedVersion?: CommandId | null;
      readonly needsRefinement?: boolean;
    };

type EventBase = {
  readonly sequence: number;
  readonly eventId: EventId;
  readonly aggregateKind: "thread";
  readonly aggregateId: string;
  readonly occurredAt: string;
};
export type OrchestrationEvent = EventBase &
  (
    | {
        readonly type: "thread.created";
        readonly payload: {
          readonly threadId: ThreadId;
          readonly purpose?: OrchestrationV2ThreadShellJson["purpose"];
        };
      }
    | { readonly type: "thread.deleted"; readonly payload: { readonly threadId: ThreadId } }
    | { readonly type: "thread.meta-updated"; readonly payload: { readonly threadId: ThreadId } }
    | {
        readonly type: "thread.session-set";
        readonly payload: {
          readonly threadId: ThreadId;
          readonly session: OrchestrationSession;
          readonly turnSettled?: boolean;
          readonly providerAccepted?: boolean;
        };
      }
    | {
        readonly type: "thread.message-sent";
        readonly payload: {
          readonly threadId: ThreadId;
          readonly messageId: MessageId;
          readonly role: OrchestrationMessage["role"];
          readonly text: string;
          readonly streaming: boolean;
        };
      }
    | {
        readonly type: "thread.activity-appended";
        readonly payload: {
          readonly threadId: ThreadId;
          readonly activity: OrchestrationThreadActivity;
        };
      }
    | {
        readonly type: "thread.user-input-response-requested";
        readonly payload: { readonly threadId: ThreadId };
      }
    | {
        readonly type: "thread.pull-request-linked";
        readonly payload: { readonly threadId: ThreadId; readonly link: ThreadPullRequestLink };
      }
    | {
        readonly type: "thread.pull-request-synced";
        readonly payload: ThreadPullRequestKey & {
          readonly threadId: ThreadId;
          readonly snapshot: ThreadPullRequestSnapshot;
        };
      }
    | {
        readonly type: "idea.changed";
        readonly payload: { readonly threadId: ThreadId; readonly mutation: IdeaMutation };
      }
    | {
        readonly type: "idea.purged";
        readonly payload: { readonly threadId: ThreadId; readonly deletionEpoch: number };
      }
  );
