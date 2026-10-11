import {
  AuthSettingsWriteScope,
  type FactoryAssignment,
  type FactoryManager,
  type FactoryScheduleCandidate,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useId, useRef, useState } from "react";

import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { useFactoryCommand } from "./useFactoryCommand";

const finished = (assignment: FactoryAssignment | undefined) =>
  assignment !== undefined &&
  (assignment.status === "complete" || assignment.completion?.phase === "concluded");

function Candidate({
  candidate,
  environment,
  onOpenThread,
  canOpenThread,
}: {
  candidate: FactoryScheduleCandidate;
  environment: FactoryEnvironmentView;
  onOpenThread: (threadId: ThreadId) => void;
  canOpenThread: (threadId: ThreadId) => boolean;
}) {
  const prefix = useId();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, settingsScope);
  const [decision, setDecision] = useState<"dismiss" | "reopen" | null>(null);
  const [reason, setReason] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const lifecycle = candidate.lifecycle;
  const preparation = "preparation" in lifecycle ? lifecycle.preparation : null;
  const assignment =
    lifecycle.phase === "commissioned"
      ? environment.data?.assignments.find((entry) => entry.id === lifecycle.assignmentId)
      : undefined;
  const canReopen =
    lifecycle.phase === "dismissed" || (lifecycle.phase === "commissioned" && finished(assignment));
  const canDismiss = lifecycle.phase !== "dismissed" && lifecycle.phase !== "commissioned";
  const activeGeneration = environment.data?.scheduleCandidates.some(
    (entry) =>
      entry.canonicalIssueKey === candidate.canonicalIssueKey &&
      entry.generation > candidate.generation,
  );
  const decisionAvailable =
    !activeGeneration && (decision === "dismiss" ? canDismiss : decision === "reopen" && canReopen);
  useEffect(() => {
    if (command.error) errorRef.current?.focus();
  }, [command.error]);
  const submitDecision = async () => {
    if (!decision || !decisionAvailable || !reason.trim()) return;
    if (
      await command.submit({
        type: decision === "dismiss" ? "schedule.dismiss" : "schedule.reopen",
        candidateId: candidate.id,
        reason: reason.trim(),
      })
    ) {
      setDecision(null);
      setReason("");
    }
  };
  return (
    <li
      className="space-y-3 border-b border-border py-4 last:border-b-0"
      aria-busy={command.pending}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 break-words text-sm font-medium">
          {candidate.observation.title}
        </h3>
        <Badge variant={lifecycle.phase === "held" ? "warning" : "outline"}>
          {lifecycle.phase === "observed"
            ? "Awaiting scope"
            : lifecycle.phase === "prepared"
              ? "Prepared"
              : lifecycle.phase === "held"
                ? "Held"
                : lifecycle.phase === "dismissed"
                  ? "Dismissed"
                  : "Commissioned"}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {/^https?:\/\//.test(candidate.issue.url) ? (
          <a
            href={candidate.issue.url}
            target="_blank"
            rel="noreferrer"
            className="break-all underline"
          >
            {candidate.issue.repository} #{candidate.issue.number}
          </a>
        ) : (
          <span className="break-all">
            {candidate.issue.repository} #{candidate.issue.number}
          </span>
        )}
        <span>
          {candidate.source.kind === "tracker-ready" ? "Tracker Ready" : "Project retro follow-up"}
        </span>
        {preparation ? <span>Priority {preparation.priority} / 100</span> : null}
        <span>Attempt {candidate.generation + 1}</span>
      </div>
      <p className="text-sm text-muted-foreground">
        {lifecycle.phase === "held" || lifecycle.phase === "dismissed"
          ? lifecycle.reason
          : lifecycle.phase === "observed"
            ? "The manager needs to prepare an exact scope and recommendation before this work can start."
            : lifecycle.phase === "prepared"
              ? "Scope prepared. Scheduling still checks current authority, capacity, dependencies and issue ownership."
              : `Commissioned ${
                  lifecycle.authority.kind === "human"
                    ? "on your direct request"
                    : lifecycle.authority.kind === "tracker-ready"
                      ? "from the board's Ready column"
                      : "under the project improvement rule"
                }. The implementation team now owns this work.`}
      </p>
      {candidate.source.kind === "project-improvement" ? (
        <p className="text-xs text-muted-foreground">
          Starting from triage requires a matching project improvement rule or your direct request.
          Moving it out of triage into Ready follows the board's ordinary scheduling authority.
        </p>
      ) : null}
      {candidate.reopenedFrom ? (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
          Reopened by you: {candidate.reopenedFrom.reason}
        </p>
      ) : null}
      {preparation ? (
        <details className="space-y-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Prepared scope and recommendation
          </summary>
          <p className="whitespace-pre-wrap text-muted-foreground">{preparation.recommendation}</p>
          <dl className="space-y-2">
            <div>
              <dt className="font-medium">Work</dt>
              <dd className="whitespace-pre-wrap text-muted-foreground">
                {preparation.work.title} · {preparation.work.complexity} ·{" "}
                {preparation.work.kind === "rule-change"
                  ? "Separate rule-change task"
                  : "Implementation"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Outcome</dt>
              <dd className="whitespace-pre-wrap text-muted-foreground">
                {preparation.work.scope.description}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Completion condition</dt>
              <dd className="whitespace-pre-wrap text-muted-foreground">
                {preparation.work.scope.completionCondition}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Delivery</dt>
              <dd className="text-muted-foreground">
                {preparation.work.scope.requiresPullRequest
                  ? "Pull request required"
                  : preparation.work.scope.noPrTarget?.kind === "report-received"
                    ? "Verified report receipt"
                    : "Human acceptance"}
              </dd>
            </div>
            {(
              [
                ["Existing files", preparation.work.sourcePaths],
                ["New-file directories", preparation.work.creatableDirectories],
                ["Protected controls", preparation.work.controlPaths ?? []],
              ] as const
            ).map(([title, paths]) => (
              <div key={title}>
                <dt className="font-medium">{title}</dt>
                <dd className="break-words text-muted-foreground">
                  {paths.length ? paths.join(", ") : "None"}
                </dd>
              </div>
            ))}
            <div>
              <dt className="font-medium">Dependencies</dt>
              <dd className="text-muted-foreground">
                {preparation.dependencyIds.length ? (
                  <ul className="list-disc space-y-1 pl-4">
                    {preparation.dependencyIds.map((id) => {
                      const dependency = environment.data?.dependencies.find(
                        (entry) => entry.id === id,
                      );
                      return (
                        <li key={id}>
                          {dependency
                            ? `${dependency.description} · ${dependency.state}`
                            : "Dependency details unavailable"}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  "None declared"
                )}
              </dd>
            </div>
          </dl>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {assignment ? (
          <Button
            size="xs"
            variant="outline"
            disabled={assignment.threadStatus !== "created" || !canOpenThread(assignment.threadId)}
            onClick={() => onOpenThread(assignment.threadId)}
          >
            Open implementation
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          disabled={!canOpenThread(candidate.managerId)}
          onClick={() => onOpenThread(candidate.managerId)}
        >
          Discuss scope with manager
        </Button>
        {!activeGeneration && canDismiss ? (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={command.disabled}
              onClick={() =>
                void command.submit({ type: "schedule.retry", candidateId: candidate.id })
              }
            >
              {command.pending ? "Updating…" : "Retry scheduling check"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={command.disabled}
              onClick={() => {
                setDecision("dismiss");
                setReason("");
              }}
            >
              Dismiss candidate
            </Button>
          </>
        ) : null}
        {!activeGeneration && canReopen ? (
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled}
            onClick={() => {
              setDecision("reopen");
              setReason("");
            }}
          >
            Reopen for consideration
          </Button>
        ) : null}
      </div>
      {activeGeneration ? (
        <p className="text-xs text-muted-foreground">
          A newer attempt exists; this record is retained as history.
        </p>
      ) : null}
      {decision && decisionAvailable ? (
        <div className="space-y-2 border-l border-border pl-3">
          <Label htmlFor={`${prefix}-reason`}>
            {decision === "dismiss"
              ? "Reason for dismissing this candidate"
              : "Reason for reopening this work"}
          </Label>
          <p className="text-xs text-muted-foreground">
            {decision === "dismiss"
              ? "The decision is retained so this ticket is not repeatedly selected. It does not cancel an implementation assignment."
              : "Creates a new consideration attempt. The manager must prepare scope and scheduling must recheck its authority."}
          </p>
          <Textarea
            id={`${prefix}-reason`}
            rows={3}
            maxLength={6000}
            value={reason}
            disabled={command.disabled}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={command.disabled || !reason.trim()}
              onClick={() => void submitDecision()}
            >
              {command.pending
                ? "Saving decision…"
                : decision === "dismiss"
                  ? "Confirm dismissal"
                  : "Confirm reopen"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={command.pending}
              onClick={() => setDecision(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {command.error ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </li>
  );
}

export function FactoryScheduleCandidates({
  environment,
  manager,
  onClose,
  onOpenThread,
  canOpenThread,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  onClose: () => void;
  onOpenThread: (threadId: ThreadId) => void;
  canOpenThread: (threadId: ThreadId) => boolean;
}) {
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const configuration = environment.data?.schedulingConfigurations.findLast(
    (entry) => entry.projectId === manager.projectId,
  );
  const candidates = (environment.data?.scheduleCandidates ?? [])
    .filter((entry) => entry.projectId === manager.projectId)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Project work queue</DialogTitle>
          <DialogDescription>
            {manager.name} · {environment.label}. The manager prepares scope; scheduling explains
            what starts and what is held.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            {configuration?.enabled
              ? `Scheduling enabled · up to ${configuration.maxConcurrentAssignments} concurrent assignments.`
              : "Scheduling is disabled. Enable it in this project’s delivery settings to consider new work."}
          </p>
          {!environment.connected ? (
            <p role="status" className="mt-2 text-sm text-muted-foreground">
              Offline. Reconnect to update this queue.
            </p>
          ) : null}
          {!settingsScope || !environment.canOperate ? (
            <p role="status" className="mt-2 text-sm text-muted-foreground">
              You can inspect this queue. Settings and operate permission are required to make
              scheduling decisions.
            </p>
          ) : null}
          {candidates.length ? (
            <ul>
              {candidates.map((candidate) => (
                <Candidate
                  key={candidate.id}
                  candidate={candidate}
                  environment={environment}
                  onOpenThread={onOpenThread}
                  canOpenThread={canOpenThread}
                />
              ))}
            </ul>
          ) : (
            <p role="status" className="py-6 text-sm text-muted-foreground">
              No candidates observed yet. Connected-board Ready work and eligible project retro
              follow-ups appear here when scheduling evaluates them.
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
