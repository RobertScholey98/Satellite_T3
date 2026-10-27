import type {
  EnvironmentId,
  FactoryLogEntry,
  FactoryManager,
  IssueRef,
  ProjectId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { factoryEnvironment, useFactoryManagers } from "./factoryState";
import {
  decisionReason,
  decisionVerb,
  latestTicketDecision,
  projectManagers,
} from "./FactoryTriageState";

/** Enough of the log to reach a ticket's last judgement on a busy manager. */
const DECISION_LOG_LIMIT = 300;

// The ticket dialog's comments use this format; the decision sits under them.
const decisionDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const formatDecisionDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : decisionDateTime.format(date);
};

/**
 * Each project manager's latest pickup or skip of a ticket, with its reason. Start on the ticket
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
  const managers = projectManagers(useFactoryManagers(environmentId), projectId);
  if (managers.length === 0) return null;
  const named = managers.length > 1;
  return (
    <section className="grid gap-2 border-t border-border/60 pt-3">
      <h3 className="text-sm font-medium">{named ? "Manager decisions" : "Manager decision"}</h3>
      {managers.map((manager) => (
        <ManagerDecision
          key={manager.id}
          environmentId={environmentId}
          manager={manager}
          named={named}
          issue={issue}
          connected={connected}
        />
      ))}
    </section>
  );
}

function ManagerDecision({
  environmentId,
  manager,
  named,
  issue,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly manager: FactoryManager;
  readonly named: boolean;
  readonly issue: Pick<IssueRef, "host" | "repository" | "number">;
  readonly connected: boolean;
}) {
  const listLog = useAtomCommand(factoryEnvironment.listLog, { reportFailure: false });
  const managerId = manager.id;
  const { host, repository, number } = issue;
  const [decision, setDecision] = useState<{
    readonly key: string;
    readonly entry: FactoryLogEntry | null;
  } | null>(null);
  const key = `${managerId}\n${host}\n${repository}\n${number}`;

  // oxlint-disable-next-line t3code/react-effect-budget -- Fetch the manager's log for this ticket's decision while connected, dropping a reply that arrives after the ticket changes or unmounts.
  useEffect(() => {
    if (!connected) return;
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

  const entry = decision?.key === key ? decision.entry : null;
  const name = named ? <span className="font-medium text-foreground">{manager.name}</span> : null;
  if (entry === null) {
    const text =
      decision?.key === key
        ? "The manager has not judged this ticket."
        : connected
          ? "Loading the manager's decision…"
          : "Reconnect to load the manager's decision.";
    return (
      <p className="text-sm text-muted-foreground">
        {name}
        {name ? ": " : null}
        {text}
      </p>
    );
  }
  const verb = decisionVerb(entry);
  const reason = decisionReason(entry);
  return (
    <div className="grid gap-1">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {name}
        <Badge size="sm" variant={entry.kind === "skip" ? "outline" : "success"}>
          {verb}
        </Badge>
        <time dateTime={entry.at}>{formatDecisionDate(entry.at)}</time>
      </p>
      {reason === "" ? null : <p className="text-sm">{reason}</p>}
    </div>
  );
}
