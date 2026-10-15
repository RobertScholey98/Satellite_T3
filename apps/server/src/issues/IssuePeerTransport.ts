import type {
  EnvironmentId,
  IssueAttemptsAcknowledgeInput,
  IssueAttemptsReceiptsResult,
  IssueAttemptsSyncGenerationsInput,
  IssueOperationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class IssuePeerUnreachableError extends Schema.TaggedError<IssuePeerUnreachableError>()(
  "IssuePeerUnreachableError",
  {
    endpoints: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.endpoints === 0
      ? "The worktree computer shares no network address this computer can reach. It may listen on loopback only."
      : "The worktree computer could not be reached on any of its network addresses.";
  }
}

export class IssuePeerUnauthorizedError extends Schema.TaggedError<IssuePeerUnauthorizedError>()(
  "IssuePeerUnauthorizedError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The worktree computer no longer accepts this computer's credential. Start a ticket on it again from a Satellite window connected to both computers.";
  }
}

export type IssuePeerError =
  | IssuePeerUnreachableError
  | IssuePeerUnauthorizedError
  | IssueOperationError;

export interface IssuePeer {
  readonly destinationEnvironmentId: EnvironmentId;
  /** Tried in order; the first that answers as the destination is used. */
  readonly endpoints: ReadonlyArray<string>;
  readonly credential: string;
}

/** The destination's three peer RPCs over one open connection. */
export interface IssuePeerConnection {
  readonly endpoint: string;
  readonly listReceipts: (
    after: number,
  ) => Effect.Effect<IssueAttemptsReceiptsResult, IssuePeerError>;
  readonly acknowledge: (
    input: IssueAttemptsAcknowledgeInput,
  ) => Effect.Effect<void, IssuePeerError>;
  readonly syncGenerations: (
    input: IssueAttemptsSyncGenerationsInput,
  ) => Effect.Effect<void, IssuePeerError>;
}

/**
 * How the board's environment reaches a worktree environment. Opening a connection is the
 * reachability probe; the connection closes with its scope.
 */
export class IssuePeerTransport extends Context.Service<
  IssuePeerTransport,
  {
    readonly connect: (
      peer: IssuePeer,
    ) => Effect.Effect<IssuePeerConnection, IssuePeerError, Scope.Scope>;
  }
>()("t3/issues/IssuePeerTransport") {}
