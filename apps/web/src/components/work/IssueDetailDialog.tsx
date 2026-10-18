import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type IssueAttempt,
  type IssueBoardItem,
  type IssueBoardView,
  type IssueDetail,
  issueReadyColumnIds,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, TicketIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { issueErrorMessage, issuesEnvironment, unwrapIssueResult } from "./issuesState";
import {
  attemptStatusLabel,
  canResumeAttempt,
  issueAttemptGroups,
  issueCanStart,
  sameIssue,
} from "./issuesViewState";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
};

/**
 * A ticket's body, comments, and this environment's attempts for it, with the ways in and out of
 * an attempt: Start or New attempt, Continue thread, Stop, and Resume.
 */
export function IssueDetailDialog({
  environmentId,
  project,
  view,
  item,
  connected,
  moving,
  onClose,
  onStart,
  onMove,
  onAttemptsChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject | undefined;
  readonly view: IssueBoardView | null;
  readonly item: IssueBoardItem;
  readonly connected: boolean;
  readonly moving: boolean;
  readonly onClose: () => void;
  readonly onStart: () => void;
  readonly onMove: (columnId: string) => void;
  readonly onAttemptsChanged: () => void;
}) {
  const navigate = useNavigate();
  // Rebuilt from its fields so a board refresh that hands over a new item for the same ticket
  // keeps the identity the detail and attempt reads depend on.
  const issueRef = item.issue.ref;
  const ref = {
    hostKind: issueRef.hostKind,
    host: issueRef.host,
    repository: issueRef.repository,
    id: issueRef.id,
    number: issueRef.number,
    url: issueRef.url,
  };
  const boardId = view?.board.id ?? null;
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [fetchedAttempts, setFetchedAttempts] = useState<ReadonlyArray<IssueAttempt> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const get = useAtomCommand(issuesEnvironment.get, { reportFailure: false });
  const listAttempts = useAtomCommand(issuesEnvironment.listAttempts, { reportFailure: false });
  const endAttempt = useAtomCommand(issuesEnvironment.endAttempt, { reportFailure: false });
  const resumeAttempt = useAtomCommand(issuesEnvironment.resumeAttempt, { reportFailure: false });

  const projectId = view?.board.projectId ?? project?.id;
  useEffect(() => {
    if (!connected || !projectId) return;
    let current = true;
    void get({ environmentId, input: { projectId, issue: ref } })
      .then(unwrapIssueResult)
      .then((result) => {
        if (current) setDetail(result);
      })
      .catch((failure: unknown) => {
        if (current) setDetailError(issueErrorMessage(failure));
      });
    return () => {
      current = false;
    };
  }, [connected, environmentId, get, projectId, ref]);

  const loadAttempts = () => {
    if (!connected || boardId === null) return () => {};
    let current = true;
    void listAttempts({ environmentId, input: { boardId, issue: ref } })
      .then(unwrapIssueResult)
      .then((result) => {
        if (current) setFetchedAttempts(result);
      })
      .catch((failure: unknown) => {
        if (current) setActionError(issueErrorMessage(failure));
      });
    return () => {
      current = false;
    };
  };
  useEffect(() => loadAttempts(), [loadAttempts]);

  const attempts =
    fetchedAttempts ?? view?.attempts.filter((attempt) => sameIssue(attempt.issue, ref)) ?? [];
  const { active, earlier } = issueAttemptGroups(attempts, ref);
  const continueTarget = active[0] ?? earlier[0] ?? null;
  const mapping = view?.board.mapping ?? null;
  const readyColumns = mapping
    ? issueReadyColumnIds(mapping).map((id) => ({
        id,
        title: view?.columns.find((column) => column.id === id)?.title ?? id,
      }))
    : [];
  const onBoard = view?.items.some((candidate) => candidate.itemId === item.itemId) === true;
  const canStart = view !== null && issueCanStart(item, mapping);

  const openThread = (attempt: IssueAttempt) => {
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, attempt.threadId)),
    });
  };

  const runAttemptAction = async (request: () => Promise<unknown>) => {
    setActing(true);
    setActionError(null);
    try {
      await request();
      loadAttempts();
      onAttemptsChanged();
    } catch (failure) {
      setActionError(issueErrorMessage(failure));
    } finally {
      setActing(false);
    }
  };
  const stop = (attempt: IssueAttempt, returnToColumnId?: string) =>
    runAttemptAction(async () =>
      unwrapIssueResult(
        await endAttempt({
          environmentId,
          input: {
            requestId: randomUUID(),
            attemptId: attempt.id,
            ...(returnToColumnId ? { returnToColumnId } : {}),
          },
        }),
      ),
    );
  const resume = (attempt: IssueAttempt) =>
    runAttemptAction(async () =>
      unwrapIssueResult(
        await resumeAttempt({
          environmentId,
          input: { requestId: randomUUID(), attemptId: attempt.id },
        }),
      ),
    );

  const attemptRow = (attempt: IssueAttempt) => (
    <li key={attempt.id} className="grid gap-1.5 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={attempt.active ? "success" : "outline"}>
          {attempt.active ? "Active" : "Earlier"}
        </Badge>
        <span>{attemptStatusLabel(attempt)}</span>
        {attempt.active && attempt.automaticMoves === "paused" ? (
          <Badge variant="warning">Automatic moves paused</Badge>
        ) : null}
        <span className="text-muted-foreground">
          {formatDate(attempt.startedAt ?? attempt.createdAt)}
        </span>
      </div>
      {attempt.worktreePath ? (
        <p className="break-all font-mono text-xs text-muted-foreground">{attempt.worktreePath}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <Button size="xs" variant="outline" onClick={() => openThread(attempt)}>
          Open thread
        </Button>
        {attempt.controllingPullRequest?.url ? (
          <Button
            size="xs"
            variant="ghost"
            render={
              <a href={attempt.controllingPullRequest.url} target="_blank" rel="noreferrer" />
            }
          >
            Pull request #{attempt.controllingPullRequest.number}
            <ExternalLinkIcon />
          </Button>
        ) : null}
        {attempt.active ? (
          <Menu>
            <MenuTrigger
              render={<Button size="xs" variant="ghost" disabled={!connected || acting} />}
            >
              Stop
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuItem onClick={() => void stop(attempt)}>Stop attempt</MenuItem>
              {readyColumns.length ? <MenuSeparator /> : null}
              {readyColumns.map((column) => (
                <MenuItem key={column.id} onClick={() => void stop(attempt, column.id)}>
                  Stop and return to {column.title}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
        {canResumeAttempt(attempt, attempts) ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={!connected || acting}
            onClick={() => void resume(attempt)}
          >
            Resume
          </Button>
        ) : null}
      </div>
    </li>
  );

  return (
    <Dialog
      open
      onOpenChange={(opened) => {
        if (!opened) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <TicketIcon className="size-3.5" />#{ref.number} · {item.issue.state}
          </p>
          <DialogTitle>{item.issue.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button
                size="xs"
                variant="link"
                render={<a href={ref.url} target="_blank" rel="noreferrer" />}
              >
                Open in {ref.host}
                <ExternalLinkIcon />
              </Button>
              {onBoard && view ? (
                <Select
                  value={item.columnId ?? ""}
                  disabled={!connected || moving}
                  onValueChange={(next) => {
                    if (typeof next === "string" && next !== item.columnId) onMove(next);
                  }}
                >
                  <SelectTrigger size="xs" aria-label="Move to column" className="w-auto">
                    <SelectValue placeholder="Move to column">
                      {view.columns.find((column) => column.id === item.columnId)?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {view.columns.map((column) => (
                      <SelectItem key={column.id} value={column.id} label={column.title}>
                        {column.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
            </div>
            {detail ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {[
                    detail.author?.name ?? "Unknown author",
                    detail.ref.repository,
                    detail.assignees?.length
                      ? `Assigned to ${detail.assignees.map((actor) => actor.name).join(", ")}`
                      : "Unassigned",
                    ...detail.labels,
                  ].join(" · ")}
                </p>
                {project ? (
                  <PullRequestMarkdown
                    text={detail.body || "No description."}
                    cwd={project.workspaceRoot}
                    environmentId={environmentId}
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-sm">{detail.body || "No description."}</p>
                )}
                {detail.comments?.length ? (
                  <section className="grid gap-4 border-t border-border/60 pt-3">
                    <h3 className="text-sm font-medium">Comments ({detail.comments.length})</h3>
                    {detail.comments.map((comment) => (
                      <article key={comment.id} className="grid gap-2">
                        <p className="text-xs text-muted-foreground">
                          {comment.author?.name ?? "Unknown author"} ·{" "}
                          <time dateTime={comment.createdAt}>{formatDate(comment.createdAt)}</time>
                        </p>
                        {project ? (
                          <PullRequestMarkdown
                            text={comment.body}
                            cwd={project.workspaceRoot}
                            environmentId={environmentId}
                          />
                        ) : (
                          <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
                        )}
                      </article>
                    ))}
                  </section>
                ) : null}
              </>
            ) : detailError ? (
              <p role="alert" className="text-sm text-destructive">
                {detailError}
              </p>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {connected ? "Loading ticket details…" : "Reconnect to load ticket details."}
              </p>
            )}
            {attempts.length ? (
              <section className="grid gap-2 border-t border-border/60 pt-3">
                <h3 className="text-sm font-medium">Attempts on this computer</h3>
                {active.length ? (
                  <ul className="grid divide-y divide-border/60">{active.map(attemptRow)}</ul>
                ) : null}
                {earlier.length ? (
                  <ul className="grid divide-y divide-border/60">{earlier.map(attemptRow)}</ul>
                ) : null}
              </section>
            ) : null}
            {actionError ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {continueTarget ? (
            <Button
              variant={canStart ? "outline" : "default"}
              onClick={() => openThread(continueTarget)}
            >
              Continue thread
            </Button>
          ) : null}
          {canStart ? (
            <Button disabled={!connected || acting} onClick={onStart}>
              {attempts.length ? "New attempt" : "Start"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
