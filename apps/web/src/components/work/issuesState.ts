import { useAtomValue } from "@effect/atom-react";
import { createIssuesEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type IssueBoardSummary,
  type IssueBoardSync,
  IssueOperationError,
  ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { requestConfirmDialog } from "~/confirmDialog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { randomUUID } from "~/lib/utils";
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

export const issuesEnvironment = createIssuesEnvironmentAtoms(connectionAtomRuntime);

const isIssueOperationError = Schema.is(IssueOperationError);

/** Thrown by `unwrapIssueResult`; `interrupted` failures are not worth showing. */
export class IssueRequestError extends Error {
  constructor(
    message: string,
    readonly reason: IssueOperationError["reason"] | "interrupted" | "other",
  ) {
    super(message);
  }
}

export function unwrapIssueResult<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new IssueRequestError("Cancelled.", "interrupted");
  const failure = squashAtomCommandFailure(result);
  if (isIssueOperationError(failure)) throw new IssueRequestError(failure.message, failure.reason);
  throw new IssueRequestError(
    failure instanceof Error && failure.message ? failure.message : "The request failed.",
    "other",
  );
}

export function issueErrorMessage(failure: unknown): string | null {
  if (failure instanceof IssueRequestError && failure.reason === "interrupted") return null;
  return failure instanceof Error ? failure.message : String(failure);
}

export function supportsIssueBoards(environment: EnvironmentPresentation | undefined): boolean {
  return environment?.serverConfig?.environment.capabilities.issueBoards === true;
}

/** Environments whose server offers issue boards, connected or not. */
export function useIssueBoardEnvironments(): ReadonlyArray<EnvironmentPresentation> {
  const { environments } = useEnvironments();
  return environments.filter(supportsIssueBoards);
}

interface IssueBoardRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly boardId: string;
}

const UNSUBSCRIBED_BOARD_SYNC = Atom.make<IssueBoardSync | null | undefined>(undefined).pipe(
  Atom.withLabel("web-issue-board-sync:none"),
);

const BOARD_KEY_SEPARATOR = "\n";
const boardSyncAtom = Atom.family((key: string) => {
  const [environmentId = "", projectId = "", boardId = ""] = key.split(BOARD_KEY_SEPARATOR);
  return Atom.make((get): IssueBoardSync | null | undefined => {
    const result = get(
      issuesEnvironment.boardSync({
        environmentId: EnvironmentId.make(environmentId),
        input: { projectId: ProjectId.make(projectId), boardId },
      }),
    );
    return Option.getOrUndefined(AsyncResult.value(result))?.sync;
  }).pipe(Atom.withLabel(`web-issue-board-sync:${key}`));
});

/**
 * The server's freshness of a board's stored copy: `undefined` until the first event, `null` once
 * the board is no longer connected.
 */
export function useIssueBoardSync(ref: IssueBoardRef | null): IssueBoardSync | null | undefined {
  return useAtomValue(
    ref === null
      ? UNSUBSCRIBED_BOARD_SYNC
      : boardSyncAtom([ref.environmentId, ref.projectId, ref.boardId].join(BOARD_KEY_SEPARATOR)),
  );
}

// The command palette refreshes the board on screen; the board registers how while it is open.
let openBoardRefresh: (() => void) | null = null;

export function registerOpenIssueBoard(refresh: () => void): () => void {
  openBoardRefresh = refresh;
  return () => {
    if (openBoardRefresh === refresh) openBoardRefresh = null;
  };
}

export function readOpenIssueBoardRefresh(): (() => void) | null {
  return openBoardRefresh;
}

/**
 * Disconnect with a warning about this environment's active attempts. Disconnecting pauses them,
 * and connecting the same board again resumes them.
 */
export function useDisconnectIssueBoard() {
  const listAttempts = useAtomCommand(issuesEnvironment.listAttempts, { reportFailure: false });
  const disconnect = useAtomCommand(issuesEnvironment.disconnectBoard, { reportFailure: false });
  return async (environmentId: EnvironmentId, board: IssueBoardSummary): Promise<boolean> => {
    const attempts = await listAttempts({ environmentId, input: { boardId: board.id } });
    const active =
      attempts._tag === "Success" ? attempts.value.filter((attempt) => attempt.active).length : 0;
    const message = [
      `Disconnect ${board.title}?`,
      active > 0
        ? `${active === 1 ? "1 active attempt" : `${active} active attempts`} on this computer will stop moving ${active === 1 ? "its ticket" : "their tickets"}. Connecting this board again resumes them.`
        : "You can connect it again later.",
    ].join("\n");
    const confirmed = await (requestConfirmDialog(message, { variant: "destructive" }) ??
      Promise.resolve(window.confirm(message)));
    if (!confirmed) return false;
    unwrapIssueResult(
      await disconnect({ environmentId, input: { requestId: randomUUID(), boardId: board.id } }),
    );
    return true;
  };
}
