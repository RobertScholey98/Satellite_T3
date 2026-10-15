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

/** A composer attachment before it reaches the environment. */
export interface TurnAttachmentDraft {
  readonly id: string;
  readonly type: "image" | "file";
}

/** How a client puts its composer attachments on the wire. */
export interface TurnAttachmentAdapter<A extends TurnAttachmentDraft> {
  /**
   * Resolves the wire attachments in input order. With `upload` the bytes go through the
   * environment's upload endpoint; without it only images arrive, to be sent inline as data URLs.
   * "abandoned" means the attachments' owner no longer wants this send.
   */
  readonly prepare: (input: {
    readonly environmentId: EnvironmentId;
    readonly attachments: ReadonlyArray<A>;
    readonly upload: boolean;
  }) => Promise<ReadonlyArray<ChatAttachment | UploadChatAttachment> | "abandoned">;
}

export interface TurnDeliveryServices<A extends TurnAttachmentDraft> {
  readonly commands: TurnDeliveryCommands;
  readonly attachments: TurnAttachmentAdapter<A>;
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

export interface TurnDeliveryRequest<A extends TurnAttachmentDraft> {
  readonly environmentId: EnvironmentId;
  /** The start command without its message. `createdAt` also stamps the settings commands. */
  readonly turn: Omit<StartThreadTurnInput, "message"> & { readonly createdAt: string };
  readonly message: {
    readonly messageId: MessageId;
    /** Canonical prose with inline context links. */
    readonly text: string;
    /** Records bind attachments by their draft id. */
    readonly context?: OrchestrationMessageContext;
    readonly attachments: ReadonlyArray<A>;
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

export type TurnDeliveryStage = "settings" | "attachments" | "dispatch";

export type TurnDeliveryResult =
  | { readonly _tag: "Delivered" }
  | { readonly _tag: "Abandoned" }
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
export async function deliverTurn<A extends TurnAttachmentDraft>(
  request: TurnDeliveryRequest<A>,
  services: TurnDeliveryServices<A>,
): Promise<TurnDeliveryResult> {
  const settings = await syncThreadSettings(request, services.commands);
  if (settings !== null) return failed("settings", settings);

  const { environmentId, turn } = request;
  const drafts = request.message.attachments;
  const upload = services.environment(environmentId)?.capabilities.attachmentUploads === true;
  let attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment> | "abandoned";
  try {
    if (!upload && drafts.some((draft) => draft.type === "file")) {
      throw new Error("This server does not support file attachments.");
    }
    attachments = await services.attachments.prepare({
      environmentId,
      attachments: drafts,
      upload,
    });
  } catch (error) {
    return failed("attachments", AsyncResult.failure(Cause.die(error)));
  }
  if (attachments === "abandoned") return { _tag: "Abandoned" };

  const text = request.message.text;
  await request.onDispatching?.({ text });
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
  const context = bindAttachments(request.message.context, drafts, attachments);
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
        attachments,
      },
    },
  });
  return started._tag === "Failure" ? failed("dispatch", started) : { _tag: "Delivered" };
}

/** Rebinds records from each draft's id to the id its wire attachment carries. */
function bindAttachments(
  context: OrchestrationMessageContext | undefined,
  drafts: ReadonlyArray<TurnAttachmentDraft>,
  attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>,
): OrchestrationMessageContext | undefined {
  if (context === undefined) return undefined;
  const ids = new Map(drafts.map((draft, index) => [draft.id, attachments[index]?.id]));
  return {
    version: 1,
    records: context.records.map((record) =>
      "attachmentId" in record
        ? { ...record, attachmentId: ids.get(record.attachmentId) ?? record.attachmentId }
        : record,
    ),
  };
}

/** Metadata, then runtime mode, then interaction mode, each only when it differs. */
async function syncThreadSettings(
  request: TurnDeliveryRequest<TurnAttachmentDraft>,
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
