import {
  CommandId,
  type ChatAttachment,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type MessageId,
  type OrchestrationMessageContext,
  type ProviderInteractionMode,
  type RuntimeMode,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { isTransportConnectionErrorMessage } from "./errors/transport.ts";
import type {
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadTurnInput,
  UpdateThreadMetadataInput,
} from "./operations/commands.ts";
import type { AtomCommandResult } from "./state/runtime.ts";

type EnvironmentCommand<Input> = (value: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<unknown, unknown>>;

/** The thread command atoms a client already binds for its UI. */
export interface TurnDeliveryCommands {
  readonly updateMetadata: EnvironmentCommand<UpdateThreadMetadataInput>;
  readonly setRuntimeMode: EnvironmentCommand<SetThreadRuntimeModeInput>;
  readonly setInteractionMode: EnvironmentCommand<SetThreadInteractionModeInput>;
  readonly startTurn: EnvironmentCommand<StartThreadTurnInput>;
}

export interface TurnDeliveryServices {
  readonly commands: TurnDeliveryCommands;
  /** The environment as its server last described it. Read at the step that needs it. */
  readonly environment: (
    environmentId: EnvironmentId,
  ) => ExecutionEnvironmentDescriptor | undefined;
}

/** An existing thread's settings as the server holds them. */
export interface ThreadSettings {
  readonly branch: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface TurnDeliveryRequest {
  readonly environmentId: EnvironmentId;
  /** The start command without its message. `createdAt` also stamps the settings commands. */
  readonly turn: Omit<StartThreadTurnInput, "message"> & { readonly createdAt: string };
  readonly message: {
    readonly messageId: MessageId;
    /** Canonical prose with inline context links. */
    readonly text: string;
    readonly context?: OrchestrationMessageContext;
    readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  };
  /** Present for an existing thread: runtime and interaction modes that differ are synced first. */
  readonly thread?: ThreadSettings;
  /** The checkout the turn runs on, recorded on the thread when it differs. */
  readonly branch?: string;
  /** Sends `/compact` under this message id first, so a stale session compacts before the turn. */
  readonly compactFirst?: MessageId;
  /** Runs once every check has passed, immediately before the start command. */
  readonly onDispatching?: (message: { readonly text: string }) => void | Promise<void>;
}

export type TurnDeliveryStage = "settings" | "dispatch";

export type TurnDeliveryResult =
  | { readonly _tag: "Delivered" }
  | {
      readonly _tag: "Failed";
      readonly stage: TurnDeliveryStage;
      readonly failure: AsyncResult.Failure<unknown, unknown>;
      /** Interrupted or lost in transport, so the same attempt can be made again unchanged. */
      readonly transient: boolean;
    };

/**
 * Delivers one turn: syncs the thread's settings, serializes context for the server, and sends
 * the start command. One attempt; retry and persistence belong to the caller.
 */
export async function deliverTurn(
  request: TurnDeliveryRequest,
  services: TurnDeliveryServices,
): Promise<TurnDeliveryResult> {
  const settings = await syncThreadSettings(request, services.commands);
  if (settings !== null) return failed("settings", settings);

  const text = request.message.text;
  await request.onDispatching?.({ text });
  const { environmentId, turn } = request;
  if (request.compactFirst !== undefined) {
    const compact = await services.commands.startTurn({
      environmentId,
      input: {
        threadId: turn.threadId,
        message: {
          messageId: request.compactFirst,
          role: "user",
          text: "/compact",
          attachments: [],
        },
        ...(turn.modelSelection === undefined ? {} : { modelSelection: turn.modelSelection }),
        runtimeMode: turn.runtimeMode,
        interactionMode: turn.interactionMode,
      },
    });
    if (compact._tag === "Failure") return failed("dispatch", compact);
  }
  const supportsInlineContext =
    services.environment(environmentId)?.capabilities.inlineMessageContext === true;
  const context = request.message.context;
  const started = await services.commands.startTurn({
    environmentId,
    input: {
      ...turn,
      message: {
        messageId: request.message.messageId,
        role: "user",
        ...(context === undefined
          ? { text }
          : supportsInlineContext
            ? { text, context }
            : { text: serializeLegacyContextMessage({ text, records: context.records }) }),
        attachments: request.message.attachments,
      },
    },
  });
  return started._tag === "Failure" ? failed("dispatch", started) : { _tag: "Delivered" };
}

/** Metadata, then runtime mode, then interaction mode, each only when it differs. */
async function syncThreadSettings(
  request: TurnDeliveryRequest,
  commands: TurnDeliveryCommands,
): Promise<AsyncResult.Failure<unknown, unknown> | null> {
  const thread = request.thread;
  if (thread === undefined) return null;
  const { environmentId, turn } = request;
  const commandId = (setting: string) =>
    turn.commandId === undefined
      ? {}
      : { commandId: CommandId.make(`${turn.commandId}:${setting}`) };
  if (request.branch !== undefined && request.branch !== thread.branch) {
    const result = await commands.updateMetadata({
      environmentId,
      input: {
        ...commandId("metadata"),
        threadId: turn.threadId,
        branch: request.branch,
        worktreePath: null,
      },
    });
    if (result._tag === "Failure") return result;
  }
  if (turn.runtimeMode !== thread.runtimeMode) {
    const result = await commands.setRuntimeMode({
      environmentId,
      input: {
        ...commandId("runtime-mode"),
        threadId: turn.threadId,
        runtimeMode: turn.runtimeMode,
        createdAt: turn.createdAt,
      },
    });
    if (result._tag === "Failure") return result;
  }
  if (turn.interactionMode !== thread.interactionMode) {
    const result = await commands.setInteractionMode({
      environmentId,
      input: {
        ...commandId("interaction-mode"),
        threadId: turn.threadId,
        interactionMode: turn.interactionMode,
        createdAt: turn.createdAt,
      },
    });
    if (result._tag === "Failure") return result;
  }
  return null;
}

function failed(
  stage: TurnDeliveryStage,
  failure: AsyncResult.Failure<unknown, unknown>,
): TurnDeliveryResult {
  return {
    _tag: "Failed",
    stage,
    failure,
    transient:
      Cause.hasInterruptsOnly(failure.cause) ||
      isTransientDeliveryError(Cause.squash(failure.cause)),
  };
}

/**
 * Only a failure the server decided (a rejected command or an authorization rejection) means the
 * payload is bad. Socket drops and an unconnected environment are transport-shaped; they are
 * matched by tag because a socket read error's message says nothing useful.
 */
export function isTransientDeliveryError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "OrchestrationDispatchCommandError":
      case "EnvironmentAuthorizationError":
        return false;
      case "ConnectionTransientError":
      case "RpcClientError":
      case "EnvironmentRpcUnavailableError":
      case "EnvironmentNotRegisteredError":
        return true;
      default:
        break;
    }
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}
