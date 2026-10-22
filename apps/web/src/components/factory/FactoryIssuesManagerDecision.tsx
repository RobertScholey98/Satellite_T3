import type { EnvironmentId, FactoryLogEntry, IssueRef, ProjectId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatDayAwareTimestamp } from "~/timestampFormat";
import { factoryEnvironment, useFactoryManagers } from "./factoryState";
import { decisionSentence, latestTicketDecision, projectManager } from "./FactoryTriageState";

/** Enough of the log to reach a ticket's last judgement on a busy manager. */
const DECISION_LOG_LIMIT = 300;

/**
 * The project manager's latest pickup or skip of a ticket, in one sentence. Start on the ticket
 * stays the override: a manual start always wins over a skip.
 */
export function FactoryIssuesManagerDecision({
  environmentId,
  projectId,
  issue,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issue: Pick<IssueRef, "host" | "repository" | "number">;
  readonly connected: boolean;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const manager = projectManager(useFactoryManagers(environmentId), projectId);
  const listLog = useAtomCommand(factoryEnvironment.listLog, { reportFailure: false });
  const managerId = manager?.id ?? null;
  const { host, repository, number } = issue;
  const [decision, setDecision] = useState<{
    readonly key: string;
    readonly entry: FactoryLogEntry | null;
  } | null>(null);
  const key = `${managerId}\n${host}\n${repository}\n${number}`;

  useEffect(() => {
    if (!connected || managerId === null) return;
    let current = true;
    void listLog({ environmentId, input: { managerId, limit: DECISION_LOG_LIMIT } }).then(
      (result) => {
        if (!current || result._tag !== "Success") return;
        setDecision({
          key,
          entry: latestTicketDecision(result.value, { host, repository, number }),
        });
      },
    );
    return () => {
      current = false;
    };
  }, [connected, environmentId, host, key, listLog, managerId, number, repository]);

  if (manager === null) return null;
  const entry = decision?.key === key ? decision.entry : null;
  return (
    <section className="grid gap-1 border-t border-border/60 pt-3">
      <h3 className="text-sm font-medium">Manager</h3>
      <p className="text-sm text-muted-foreground">
        {entry
          ? decisionSentence(entry, formatDayAwareTimestamp(entry.at, timestampFormat))
          : decision?.key === key
            ? "The manager has not judged this ticket."
            : connected
              ? "Loading the manager's decision…"
              : "Reconnect to load the manager's decision."}
      </p>
    </section>
  );
}
