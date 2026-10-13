import type {
  FactoryError,
  ModelSelection,
  OrchestrationV2ConversationMessage,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * The isolated runtime a governor assigns to a thread. Orchestration reads the boundary and the
 * host workspace. `profile` belongs to the governor: only its `ConfinedProviderLaunch` reads it.
 * `orchestrationInstructions`, when set, replaces T3 Code's orchestration guidance for the agent,
 * because the governor decides which delegation tools exist inside its runtime.
 */
export const ConfinedExecution = Schema.Struct({
  boundaryId: Schema.String,
  workspacePath: Schema.String,
  profile: Schema.Unknown,
  orchestrationInstructions: Schema.optional(Schema.String),
});
export type ConfinedExecution = typeof ConfinedExecution.Type;

/**
 * Who sent a message, for direction checks. A user's own message has no sender (`undefined`);
 * a message the system or a scheduled task wrote has an unknown sender (`null`).
 */
export function directionSender(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "senderThreadId" | "scheduledTaskId"
  >,
): ThreadId | null | undefined {
  return message.createdBy === "user" &&
    message.senderThreadId === undefined &&
    message.scheduledTaskId === undefined
    ? undefined
    : (message.senderThreadId ?? null);
}

/**
 * Rules an owner, such as an engineering manager, places on the threads it governs. Orchestration
 * consults it before directing, starting, confining, or recovering a thread. Every check admits a
 * thread nobody governs, so the rules cost nothing when no owner exists.
 */
export class ThreadGovernance extends Context.Service<
  ThreadGovernance,
  {
    /** Whether an owner governs the thread. A governed thread resumes by its owner's rules. */
    readonly governs: (threadId: ThreadId) => Effect.Effect<boolean, FactoryError>;
    /** Fails when the sender may not direct the thread. A `permission-denied` refusal is final. */
    readonly assertDirection: (input: {
      readonly threadId: ThreadId;
      readonly senderThreadId?: ThreadId | null | undefined;
      readonly pendingParentThreadId?: ThreadId;
    }) => Effect.Effect<void, FactoryError>;
    /** The confined runtime the thread must run in, or `undefined` when it runs on the host. */
    readonly confinementFor: (
      threadId: ThreadId,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<ConfinedExecution | undefined, FactoryError>;
    /** Fails when the thread may not run the selected model. */
    readonly assertModelSelection: (
      threadId: ThreadId,
      selection: ModelSelection,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<void, FactoryError>;
    /** Fails when the thread may not delegate a task to the selected model. */
    readonly assertDelegatedModel: (
      threadId: ThreadId,
      selection: ModelSelection,
    ) => Effect.Effect<void, FactoryError>;
  }
>()("t3/orchestration-v2/ThreadGovernance") {}

/**
 * No owner: every thread is ungoverned. For tests and compositions without engineering managers;
 * the server provides the factory's implementation instead.
 */
export const layerUngoverned = Layer.succeed(
  ThreadGovernance,
  ThreadGovernance.of({
    governs: () => Effect.succeed(false),
    assertDirection: () => Effect.void,
    confinementFor: () => Effect.succeed(undefined),
    assertModelSelection: () => Effect.void,
    assertDelegatedModel: () => Effect.void,
  }),
);
