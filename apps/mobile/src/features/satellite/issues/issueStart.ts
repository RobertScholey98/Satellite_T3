import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  ThreadId,
  issueReadyColumnIds,
  type EnvironmentId,
  type IssueBoardSummary,
  type IssueBoardView,
  type IssueSummary,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import type { AsyncResult } from "effect/reactivity";

import type { QueuedThreadMessage } from "../../../state/thread-outbox-model";

export interface ReadyIssue {
  readonly boardId: string;
  readonly boardTitle: string;
  readonly issue: IssueSummary;
}

/** Issues sitting in one of a board's Ready columns, board by board. */
export function readyIssues(views: ReadonlyArray<IssueBoardView>): ReadonlyArray<ReadyIssue> {
  return views.flatMap((view) => {
    const mapping = view.board.mapping;
    if (mapping === null) return [];
    const ready = new Set(issueReadyColumnIds(mapping));
    return view.items
      .filter((item) => item.columnId !== null && ready.has(item.columnId))
      .map((item) => ({ boardId: view.board.id, boardTitle: view.board.title, issue: item.issue }));
  });
}

type IssueCommand<Input, A> = (value: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<A, unknown>>;

/** Reads the project's connected boards and returns the issues ready to start. */
export async function loadReadyIssues(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly listBoards: IssueCommand<
    { readonly projectId: ProjectId; readonly connectedOnly: boolean },
    ReadonlyArray<IssueBoardSummary>
  >;
  readonly openBoard: IssueCommand<
    { readonly projectId: ProjectId; readonly boardId: string },
    IssueBoardView
  >;
}): Promise<{ readonly issues: ReadonlyArray<ReadyIssue> } | { readonly error: string }> {
  const { environmentId, projectId } = input;
  const boards = await input.listBoards({
    environmentId,
    input: { projectId, connectedOnly: true },
  });
  if (boards._tag === "Failure") return { error: failureMessage(boards) };
  const views: IssueBoardView[] = [];
  for (const board of boards.value) {
    if (board.mapping === null) continue;
    const view = await input.openBoard({ environmentId, input: { projectId, boardId: board.id } });
    if (view._tag === "Failure") return { error: failureMessage(view) };
    views.push(view.value);
  }
  return { issues: readyIssues(views) };
}

function failureMessage(result: AsyncResult.Failure<unknown, unknown>): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The issue board could not load.";
}

/**
 * A queued new-thread creation that starts work on the issue in a new worktree off `baseBranch`.
 * Delivery reserves the attempt and attaches the issue text, so the prompt only names it.
 */
export function issueStartTask(input: {
  readonly project: {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  };
  readonly readyIssue: ReadyIssue;
  readonly worktreeName: string;
  readonly baseBranch: string;
  readonly modelSelection: ModelSelection;
  readonly ids: {
    readonly threadId: string;
    readonly commandId: string;
    readonly messageId: string;
    readonly requestId: string;
    readonly createdAt: string;
  };
}): QueuedThreadMessage {
  const { project, readyIssue, ids } = input;
  return {
    environmentId: project.environmentId,
    threadId: ThreadId.make(ids.threadId),
    messageId: MessageId.make(ids.messageId),
    commandId: CommandId.make(ids.commandId),
    text: `Work on issue #${readyIssue.issue.ref.number}: ${readyIssue.issue.title}`,
    attachments: [],
    modelSelection: input.modelSelection,
    creation: {
      projectId: project.id,
      projectTitle: project.title,
      projectCwd: project.workspaceRoot,
      workspaceMode: "worktree",
      branch: input.baseBranch,
      worktreePath: null,
    },
    issue: {
      sourceEnvironmentId: project.environmentId,
      sourceProjectId: project.id,
      boardId: readyIssue.boardId,
      issue: readyIssue.issue.ref,
      title: readyIssue.issue.title,
      worktreeName: input.worktreeName,
      requestId: ids.requestId,
    },
    createdAt: ids.createdAt,
  };
}
