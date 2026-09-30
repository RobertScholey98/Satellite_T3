import type { ScopedThreadRef, IssueAttempt } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useEnvironments } from "~/state/environments";
import { issuesEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { unwrapWorkResult, workError } from "./commands";

export function ThreadIssueLinks({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { environments } = useEnvironments();
  const environment = environments.find(
    (candidate) => candidate.environmentId === threadRef.environmentId,
  );
  const supported = environment?.serverConfig?.environment.capabilities.issueBoards === true;
  const connected = environment?.connection.phase === "connected";
  const list = useAtomCommand(issuesEnvironment.listAttempts, { reportFailure: false });
  const [attempts, setAttempts] = useState<readonly IssueAttempt[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setAttempts([]);
    setError(null);
  }, [threadRef.environmentId, threadRef.threadId]);
  useEffect(() => {
    let current = true;
    if (supported && connected)
      void list({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } })
        .then(unwrapWorkResult)
        .then((value) => {
          if (current) {
            setAttempts(value);
            setError(null);
          }
        })
        .catch((failure) => {
          if (current) setError(workError(failure));
        });
    return () => {
      current = false;
    };
  }, [list, supported, connected, threadRef.environmentId, threadRef.threadId]);
  if (!attempts.length && !error) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 py-2 text-xs">
      {attempts.map((attempt) => (
        <a
          key={attempt.link.attemptId}
          href={attempt.link.issue.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border px-2 py-1"
        >
          Issue #{attempt.link.issue.number}
          {attempt.active ? " · Active attempt" : " · Earlier attempt"}
        </a>
      ))}
      {error ? <span className="text-destructive">Issue links unavailable. {error}</span> : null}
    </div>
  );
}
