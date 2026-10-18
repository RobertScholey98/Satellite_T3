import type { IssueAttempt, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { TicketIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { useEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  issueErrorMessage,
  issuesEnvironment,
  supportsIssueBoards,
  unwrapIssueResult,
  useIssueBoardSync,
} from "./issuesState";
import { canResumeAttempt } from "./issuesViewState";

const FOCUS_REFRESH_DEBOUNCE_MS = 250;

/** The ticket a thread works on, with the way to stop its attempt and the way back. */
export function ThreadTicketChip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const environment = useEnvironment(threadRef.environmentId);
  const enabled =
    supportsIssueBoards(environment ?? undefined) && environment?.connection.phase === "connected";
  const listAttempts = useAtomCommand(issuesEnvironment.listAttempts, { reportFailure: false });
  const endAttempt = useAtomCommand(issuesEnvironment.endAttempt, { reportFailure: false });
  const resumeAttempt = useAtomCommand(issuesEnvironment.resumeAttempt, { reportFailure: false });
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly attempts: ReadonlyArray<IssueAttempt>;
  } | null>(null);
  const [acting, setActing] = useState(false);
  const threadKey = `${threadRef.environmentId}\n${threadRef.threadId}`;

  const load = () => {
    if (!enabled) return;
    void listAttempts({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).then((result) => {
      if (result._tag === "Success") setLoaded({ key: threadKey, attempts: result.value });
    });
  };

  useEffect(() => {
    load();
    if (!enabled) return;
    let timeout: number | null = null;
    const schedule = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = window.setTimeout(load, FOCUS_REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener("focus", schedule);
    return () => {
      if (timeout !== null) window.clearTimeout(timeout);
      window.removeEventListener("focus", schedule);
    };
  }, [enabled, load]);

  const attempts = loaded?.key === threadKey ? loaded.attempts : [];
  const attempt =
    attempts.find((candidate) => candidate.active) ??
    attempts.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  // Moves and attempt changes bump the board's revision, so the chip follows them while open. An
  // ended attempt changes only through this chip, so it does not keep the board watched.
  const boardRevision = useIssueBoardSync(
    enabled && attempt?.active
      ? {
          environmentId: threadRef.environmentId,
          projectId: attempt.projectId,
          boardId: attempt.boardId,
        }
      : null,
  )?.revision;
  useEffect(() => {
    if (boardRevision !== undefined) load();
  }, [boardRevision, load]);
  if (!attempt) return null;

  const paused = attempt.active && attempt.automaticMoves === "paused";
  const resumable = canResumeAttempt(attempt, attempts);

  const act = async (title: string, request: () => Promise<unknown>) => {
    setActing(true);
    try {
      await request();
    } catch (failure) {
      const description = issueErrorMessage(failure);
      if (description) toastManager.add({ type: "error", title, description });
    } finally {
      setActing(false);
      load();
    }
  };

  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost" className="shrink-0" disabled={acting} />}
      >
        <TicketIcon />
        Ticket #{attempt.issue.number}
        <Badge size="sm" variant={paused ? "warning" : attempt.active ? "success" : "outline"}>
          {paused ? "Automatic moves paused" : attempt.active ? "Active" : "Earlier"}
        </Badge>
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void ensureLocalApi().shell.openExternal(attempt.issue.url)}>
          Open ticket
        </MenuItem>
        <MenuItem
          onClick={() =>
            void navigate({
              to: "/issues",
              search: {
                environmentId: threadRef.environmentId,
                projectId: attempt.projectId,
                boardId: attempt.boardId,
                ticket: `${attempt.issue.repository}#${attempt.issue.number}`,
                mode: "board",
              },
            })
          }
        >
          Show on board
        </MenuItem>
        {attempt.active || resumable ? <MenuSeparator /> : null}
        {attempt.active ? (
          <MenuItem
            variant="destructive"
            onClick={() =>
              void act("Could not stop the attempt", async () =>
                unwrapIssueResult(
                  await endAttempt({
                    environmentId: threadRef.environmentId,
                    input: { requestId: randomUUID(), attemptId: attempt.id },
                  }),
                ),
              )
            }
          >
            Stop attempt
          </MenuItem>
        ) : resumable ? (
          <MenuItem
            onClick={() =>
              void act("Could not resume the attempt", async () =>
                unwrapIssueResult(
                  await resumeAttempt({
                    environmentId: threadRef.environmentId,
                    input: { requestId: randomUUID(), attemptId: attempt.id },
                  }),
                ),
              )
            }
          >
            Resume attempt
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
