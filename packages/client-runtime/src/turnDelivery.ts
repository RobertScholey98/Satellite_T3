import {
  CommandId,
  type ChatAttachment,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type IssueAttemptLink,
  type IssueAttemptsReserveInput,
  type IssueDetail,
  type IssuePeerGrant,
  type IssuePeerIdentity,
  type IssuePeersGrantInput,
  type IssuePeersRegisterInput,
  type IssueRef,
  type IssuesGetInput,
  type MessageId,
  type OrchestrationMessageContext,
  type ProjectId,
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

type EnvironmentCommand<Input, A = unknown> = (value: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<A, unknown>>;

/** The thread command atoms a client already binds for its UI. */
export interface TurnDeliveryCommands {
  readonly updateMetadata: EnvironmentCommand<UpdateThreadMetadataInput>;
  readonly setRuntimeMode: EnvironmentCommand<SetThreadRuntimeModeInput>;
  readonly setInteractionMode: EnvironmentCommand<SetThreadInteractionModeInput>;
  readonly startTurn: EnvironmentCommand<StartThreadTurnInput>;
}

/** The issue command atoms; reads and reservations go to the board's environment. */
export interface IssueStartCommands {
  readonly get: EnvironmentCommand<IssuesGetInput, IssueDetail>;
  readonly reserveAttempt: EnvironmentCommand<IssueAttemptsReserveInput, IssueAttemptLink>;
  readonly peerIdentity: EnvironmentCommand<Record<string, never>, IssuePeerIdentity>;
  readonly grantPeer: EnvironmentCommand<IssuePeersGrantInput, IssuePeerGrant>;
  readonly registerPeer: EnvironmentCommand<IssuePeersRegisterInput>;
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
  readonly issues: IssueStartCommands;
  readonly attachments: TurnAttachmentAdapter<A>;
  /** Read per step: an upload or reservation can span a reconnect that changes capabilities. */
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

/** Starting work on a board issue, as the draft or outbox entry that owns it records it. */
export interface IssueStartIntent {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: ProjectId;
  readonly boardId: string;
  readonly issue: IssueRef;
  readonly worktreeName: string;
  readonly requestId: string;
  /** The attempt reserved by an earlier delivery, reused while it targets the same environment. */
  readonly reservation?: IssueAttemptLink;
}

export interface IssueStart {
  readonly intent: IssueStartIntent;
  readonly background?: boolean;
  /** How many models the composer is starting; issue work takes one. */
  readonly models?: number;
  /** Writes a new reservation to the intent's owner so a retry reuses it. */
  readonly persist: (reservation: IssueAttemptLink) => void | Promise<void | "abandoned">;
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
  /** Reserves the issue's attempt, attaches its text, and runs the turn in the named worktree. */
  readonly issue?: IssueStart;
  /** Sends `/compact` under this message id first, so a stale session compacts before the turn. */
  readonly compactFirst?: MessageId;
  /** Runs once every check has passed, immediately before the start command. */
  readonly onDispatching?: (message: { readonly text: string }) => void | Promise<void>;
}

export type TurnDeliveryStage = "settings" | "attachments" | "issue" | "dispatch";

export type TurnDeliveryInvalidReason =
  | "issue-in-idea-thread"
  | "issue-worktree-name"
  | "issue-in-background"
  | "issue-needs-worktree"
  | "issue-multiple-models";

const INVALID_TURN_MESSAGES: Record<TurnDeliveryInvalidReason, string> = {
  "issue-in-idea-thread":
    "Issue work must start in a standard thread. Open this issue again to start work.",
  "issue-worktree-name": "Enter a valid worktree name before sending.",
  "issue-in-background": "Send issue work in the foreground so its launch can be tracked.",
  "issue-needs-worktree": "Issue work needs a Git project and one model in a new worktree.",
  "issue-multiple-models": "Issue work starts one model per attempt.",
};

export function invalidTurnMessage(reason: TurnDeliveryInvalidReason): string {
  return INVALID_TURN_MESSAGES[reason];
}

export type TurnDeliveryResult =
  | { readonly _tag: "Delivered" }
  | { readonly _tag: "Abandoned" }
  | { readonly _tag: "Invalid"; readonly reason: TurnDeliveryInvalidReason }
  | {
      readonly _tag: "Failed";
      readonly stage: TurnDeliveryStage;
      readonly failure: AsyncResult.Failure<unknown, unknown>;
      /** Interrupted or lost in transport, so the same attempt can be made again unchanged. */
      readonly transient: boolean;
    };

/** One delivery attempt; retry and persistence belong to the caller. */
export async function deliverTurn<A extends TurnAttachmentDraft>(
  request: TurnDeliveryRequest<A>,
  services: TurnDeliveryServices<A>,
): Promise<TurnDeliveryResult> {
  const invalid = validateTurnDelivery(request);
  if (invalid !== null) return { _tag: "Invalid", reason: invalid };

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

  let text = request.message.text;
  let start = turn;
  if (request.issue !== undefined) {
    let issue: IssueWork;
    try {
      issue = await startIssueWork(request.issue, environmentId, services);
    } catch (error) {
      return failed("issue", AsyncResult.failure(Cause.die(error)));
    }
    if (issue._tag === "Abandoned") return issue;
    if (issue._tag === "Failure") return failed("issue", issue);
    text += issue.block;
    const prepareWorktree = turn.bootstrap?.prepareWorktree;
    start = {
      ...turn,
      bootstrap: {
        ...turn.bootstrap,
        issueAttempt: issue.attempt,
        ...(prepareWorktree === undefined
          ? {}
          : {
              prepareWorktree: {
                ...prepareWorktree,
                branch: request.issue.intent.worktreeName,
                requireWorktree: true,
              },
            }),
      },
    };
  }

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
      ...start,
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

function validateTurnDelivery(
  request: TurnDeliveryRequest<TurnAttachmentDraft>,
): TurnDeliveryInvalidReason | null {
  const issue = request.issue;
  if (issue === undefined) return null;
  const bootstrap = request.turn.bootstrap;
  if (bootstrap?.createThread?.purpose === "idea") return "issue-in-idea-thread";
  if (!validWorktreeName(issue.intent.worktreeName)) return "issue-worktree-name";
  if (issue.background === true) return "issue-in-background";
  if (bootstrap?.prepareWorktree === undefined) return "issue-needs-worktree";
  if ((issue.models ?? 1) > 1) return "issue-multiple-models";
  return null;
}

/** A branch name Git can create. */
export function validWorktreeName(name: string): boolean {
  return (
    name.trim() === name &&
    name.length > 0 &&
    !/[\s~^:?*[\\]/.test(name) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  );
}

type IssueWork =
  | { readonly _tag: "Started"; readonly block: string; readonly attempt: IssueAttemptLink }
  | { readonly _tag: "Abandoned" }
  | AsyncResult.Failure<unknown, unknown>;

/**
 * Reads the issue for its prompt block and reserves an attempt for this environment unless the
 * intent already holds one, so a retry after a failed dispatch reserves nothing.
 */
async function startIssueWork(
  issue: IssueStart,
  environmentId: EnvironmentId,
  services: TurnDeliveryServices<never>,
): Promise<IssueWork> {
  const { intent } = issue;
  const source = intent.sourceEnvironmentId;
  const detail = await services.issues.get({
    environmentId: source,
    input: { projectId: intent.sourceProjectId, issue: intent.issue },
  });
  if (detail._tag === "Failure") return detail;
  let attempt = intent.reservation;
  if (attempt === undefined || attempt.destinationEnvironmentId !== environmentId) {
    const reserved = await services.issues.reserveAttempt({
      environmentId: source,
      input: {
        requestId: `${intent.requestId}:${environmentId}`,
        boardId: intent.boardId,
        issue: intent.issue,
        sourceEnvironmentId: source,
        destinationEnvironmentId: environmentId,
      },
    });
    if (reserved._tag === "Failure") return reserved;
    attempt = reserved.value;
    if ((await issue.persist(attempt)) === "abandoned") return { _tag: "Abandoned" };
  }
  // The board's computer collects this work's updates itself. It needs a credential only this
  // computer can issue, so the start hands it over while the client is connected to both.
  const sourceEnvironment = services.environment(source);
  if (
    source !== environmentId &&
    sourceEnvironment?.capabilities.issueDelivery === true &&
    services.environment(environmentId)?.capabilities.issueDelivery === true
  ) {
    const identity = await services.issues.peerIdentity({ environmentId: source, input: {} });
    if (identity._tag === "Failure") return identity;
    const grant = await services.issues.grantPeer({
      environmentId,
      input: {
        sourceEnvironmentId: source,
        sourceLabel: sourceEnvironment.label,
        sourcePublicKey: identity.value.publicKey,
      },
    });
    if (grant._tag === "Failure") return grant;
    const registered = await services.issues.registerPeer({
      environmentId: source,
      input: { destinationEnvironmentId: environmentId, ...grant.value },
    });
    if (registered._tag === "Failure") return registered;
  }
  const { ref, title, body } = detail.value;
  return {
    _tag: "Started",
    block: `\n\n<attached_issue>\nRepository host: ${ref.host}\nIssue: #${ref.number} ${title}\nURL: ${ref.url}\n\n${body}\n</attached_issue>`,
    attempt,
  };
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
