import { AuthSourceControlWriteScope, type FactoryMergeGroupRead } from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { factoryMergeOperationActions, factoryMergePullRequestUrl } from "./FactoryMergeReadModel";
import { useFactoryCommand } from "./useFactoryCommand";

const statuses = {
  idle: "Ready for shared action",
  preparing: "Preparing shared merge",
  merging: "Merging linked PRs",
  partial: "Partially merged",
  attention: "Needs your attention",
  stopped: "Shared merge stopped",
  completed: "All merges confirmed",
};

export function FactoryMergeOperation({
  environment,
  read,
  refreshing,
}: {
  environment: FactoryEnvironmentView;
  read: FactoryMergeGroupRead;
  refreshing: boolean;
}) {
  const reasonId = useId();
  const releaseId = useId();
  const [stopReason, setStopReason] = useState("");
  const [releaseReason, setReleaseReason] = useState("");
  const write = useEnvironmentScope(environment.environmentId, AuthSourceControlWriteScope);
  const command = useFactoryCommand(environment, !refreshing);
  const actions = factoryMergeOperationActions(read, { operate: environment.canOperate, write });
  const operation = read.operation;
  const readiness = read.operationReadiness;
  const lifecycle = operation?.lifecycle;
  return (
    <section className="space-y-3 border-t border-border pt-3" aria-label="Shared merge operation">
      <div className="flex flex-wrap items-center gap-2" role="status">
        <h4 className="text-sm font-medium">Shared merge</h4>
        <Badge
          size="sm"
          variant={
            readiness.status === "partial" || readiness.status === "attention"
              ? "warning"
              : "secondary"
          }
        >
          {read.group.released
            ? "Group released"
            : readiness.status === "idle" && !readiness.canStart
              ? "Waiting for merge gates"
              : statuses[readiness.status]}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {readiness.confirmedCount} of {readiness.memberCount} merges confirmed
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        PRs merge one at a time. A stopped or interrupted action keeps its confirmed merges. Nothing
        is reverted automatically.
      </p>
      <p className="text-xs text-muted-foreground">
        {readiness.deploymentGate.detail}
        {readiness.deploymentGate.supported && operation?.signal
          ? ` Published status: ${operation.signal.state}.`
          : null}
      </p>
      {read.group.released ? (
        <p className="whitespace-pre-wrap text-sm">
          Released: {read.group.released.reason}. Each PR now merges through its own delivery
          approval.
        </p>
      ) : null}
      {lifecycle?.phase === "stopped" ? (
        <p className="whitespace-pre-wrap text-sm">Stopped: {lifecycle.reason}</p>
      ) : null}
      {readiness.reasons.length ? (
        <ul className="list-inside list-disc space-y-1 text-sm">
          {[...new Set(readiness.reasons)].map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {readiness.recommendation ? (
        <p className="whitespace-pre-wrap text-sm">{readiness.recommendation}</p>
      ) : null}
      {operation ? (
        <ul className="divide-y divide-border">
          {operation.members.map((member) => {
            const outcome = member.outcome;
            const url = factoryMergePullRequestUrl(member.reviewed.ref);
            return (
              <li key={member.reviewed.assignmentId} className="space-y-1 py-2">
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-primary underline underline-offset-2"
                  >
                    {member.reviewed.ref.repository} #{member.reviewed.ref.number}
                  </a>
                ) : (
                  <p className="text-sm">
                    {member.reviewed.ref.repository} #{member.reviewed.ref.number}
                  </p>
                )}
                <p className="text-xs">
                  {outcome.phase === "confirmed"
                    ? "Merge confirmed"
                    : outcome.phase === "unknown"
                      ? "Outcome unknown; confirmation required before retry"
                      : "Awaiting merge"}
                  {" · "}
                  {member.attempts} of 3 submissions used
                </p>
                {outcome.phase === "unknown" && outcome.reason ? (
                  <p className="text-xs text-muted-foreground">{outcome.reason}</p>
                ) : null}
                {outcome.phase === "confirmed" ? (
                  <details>
                    <summary className="cursor-pointer text-xs">Confirmed merge receipt</summary>
                    <div className="mt-2 space-y-1 break-all text-xs text-muted-foreground">
                      <p>Merge commit: {outcome.receipt.mergeCommitSha}</p>
                      <p>Reviewed head: {outcome.receipt.headSha}</p>
                      <p>Target branch: {outcome.receipt.targetBranch}</p>
                      <p>Merged: {outcome.receipt.mergedAt}</p>
                    </div>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!write && (readiness.canStart || readiness.canRetry) ? (
        <p className="text-xs text-muted-foreground">
          Source control write permission is required to start or retry a shared merge.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!operation || readiness.canStart ? (
          <Button
            size="sm"
            disabled={command.disabled || !actions.start}
            onClick={() => {
              if (actions.start)
                void command.submit({ type: "merge.group.start", ...actions.start });
            }}
          >
            Merge all linked PRs
          </Button>
        ) : null}
        {operation && readiness.canReconcile ? (
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled || !actions.reconcile}
            onClick={() => {
              if (actions.reconcile)
                void command.submit({
                  type: "merge.operation.reconcile",
                  operationId: actions.reconcile,
                });
            }}
          >
            Reconcile actual outcomes
          </Button>
        ) : null}
        {operation && readiness.canRetry ? (
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled || !actions.retry}
            onClick={() => {
              if (actions.retry)
                void command.submit({ type: "merge.operation.retry", operationId: actions.retry });
            }}
          >
            Retry remaining merges
          </Button>
        ) : null}
      </div>
      {operation && readiness.canStop ? (
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm">Stop future merges</summary>
          <div className="space-y-2">
            <Label htmlFor={reasonId}>Reason for stopping this shared action</Label>
            <Textarea
              id={reasonId}
              value={stopReason}
              maxLength={6000}
              disabled={command.disabled || !actions.stop}
              onChange={(event) => setStopReason(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={command.disabled || !actions.stop || !stopReason.trim()}
              onClick={() => {
                if (actions.stop)
                  void command.submit({
                    type: "merge.operation.stop",
                    operationId: actions.stop,
                    reason: stopReason.trim(),
                  });
              }}
            >
              Stop future merges
            </Button>
            <p className="text-xs text-muted-foreground">
              An in-flight request may still complete. Reconcile its outcome; reverting a confirmed
              merge requires a separate decision.
            </p>
          </div>
        </details>
      ) : null}
      {readiness.canRelease ? (
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm">Release this merge group</summary>
          <div className="space-y-2">
            <Label htmlFor={releaseId}>Reason for releasing the group</Label>
            <Textarea
              id={releaseId}
              value={releaseReason}
              maxLength={6000}
              disabled={command.disabled || !actions.release}
              onChange={(event) => setReleaseReason(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={command.disabled || !actions.release || !releaseReason.trim()}
              onClick={() => {
                if (actions.release)
                  void command.submit({
                    type: "merge.group.release",
                    groupId: actions.release,
                    reason: releaseReason.trim(),
                  });
              }}
            >
              Release merge group
            </Button>
            <p className="text-xs text-muted-foreground">
              Member PRs stop waiting for the shared merge and need their own approval to merge.
              Confirmed merges stay.
            </p>
          </div>
        </details>
      ) : null}
      {readiness.canRestore ? (
        <Button
          size="sm"
          variant="outline"
          disabled={command.disabled || !actions.restore}
          onClick={() => {
            if (actions.restore)
              void command.submit({ type: "merge.group.restore", groupId: actions.restore });
          }}
        >
          Group these PRs again
        </Button>
      ) : null}
      {command.pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saving shared merge action…
        </p>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}
