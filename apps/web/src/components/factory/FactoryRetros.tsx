import type { FactoryAssignment, FactoryFollowup, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import type { FactoryEnvironmentView } from "../../state/factory";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { factoryProjectPause } from "./FactoryControlsReadModel";
import { factorySystemManagerActive } from "./FactoryOversightReadModel";
import { useFactoryCommand } from "./useFactoryCommand";

function Followup({
  followup,
  environment,
}: {
  followup: FactoryFollowup;
  environment: FactoryEnvironmentView;
}) {
  const command = useFactoryCommand(environment);
  const [existingNumber, setExistingNumber] = useState("");
  const publication = followup.publication;
  const tracker =
    "trackerId" in publication
      ? environment.data?.projectTrackers.find((entry) => entry.id === publication.trackerId)
      : environment.data?.projectTrackers.findLast(
          (entry) => entry.projectId === followup.projectId,
        );
  const number = Number(existingNumber);
  const linkExisting = () => {
    const destination = tracker?.destination.destination;
    if (!destination || !Number.isSafeInteger(number) || number <= 0) return;
    const id = String(number);
    void command.submit({
      type: "followup.link-existing",
      followupId: followup.id,
      issue: {
        hostKind: destination.kind === "github" ? "github" : "azure-devops",
        host: destination.host,
        repository:
          destination.kind === "github"
            ? destination.repository
            : `${destination.organization}/${destination.project}`,
        id,
        number,
        url:
          destination.kind === "github"
            ? `https://${destination.host}/${destination.repository}/issues/${id}`
            : `https://dev.azure.com/${encodeURIComponent(destination.organization)}/${encodeURIComponent(destination.project)}/_workitems/edit/${id}`,
      },
    });
  };
  const progress = publication.status === "recorded" ? publication.receipt.progress : undefined;
  const issue =
    publication.status === "linked"
      ? publication.issue
      : progress && "issue" in progress
        ? progress.issue
        : undefined;
  const reason =
    followup.error ??
    (publication.status === "configuration-required"
      ? publication.reason
      : progress && "reason" in progress
        ? progress.reason
        : undefined);
  return (
    <li className="space-y-2 border-l border-border pl-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{followup.draft.title}</span>
        <Badge variant="outline">{progress?.status ?? publication.status}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{followup.draft.problem}</p>
      {issue && /^https?:\/\//.test(issue.url) ? (
        <a
          className="text-sm text-primary underline"
          href={issue.url}
          target="_blank"
          rel="noreferrer"
        >
          Open ticket #{issue.number}
        </a>
      ) : null}
      {reason ? <p className="text-sm text-muted-foreground">{reason}</p> : null}
      {publication.status !== "linked" && progress?.status !== "triaged" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={command.disabled}
          onClick={() => void command.submit({ type: "followup.retry", followupId: followup.id })}
        >
          Retry ticket publication
        </Button>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
      {tracker && publication.status !== "linked" && progress?.status !== "triaged" ? (
        <details className="space-y-2 text-sm">
          <summary>Use an existing ticket</summary>
          <p className="text-xs text-muted-foreground">
            Select its number in the approved tracker. The host checks the destination and triage
            placement before marking this follow-up ready.
          </p>
          <Input
            aria-label="Existing ticket number"
            inputMode="numeric"
            value={existingNumber}
            onChange={(event) => setExistingNumber(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled || !Number.isSafeInteger(number) || number <= 0}
            onClick={linkExisting}
          >
            Verify existing ticket
          </Button>
        </details>
      ) : null}
    </li>
  );
}

export function FactoryRetros({
  environment,
  assignment,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  assignment: FactoryAssignment;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const command = useFactoryCommand(
    environment,
    !factoryProjectPause(environment.data, assignment.projectId),
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [waiverReason, setWaiverReason] = useState("");
  const [waivers, setWaivers] = useState<readonly string[]>([]);
  if (assignment.kind === "onboarding") return null;
  const completion = assignment.completion;
  const retro = environment.data?.retros.find((entry) => entry.assignmentId === assignment.id);
  const findings =
    environment.data?.findings.filter((entry) => entry.assignmentId === assignment.id) ?? [];
  const followups =
    environment.data?.followups.filter((entry) => entry.assignmentId === assignment.id) ?? [];
  const systemManagerActive = factorySystemManagerActive(environment.data);
  const plan = completion?.plan;
  const noPrAcceptance =
    !assignment.integrationId &&
    assignment.scope?.requiresPullRequest === false &&
    !assignment.outcome &&
    !completion?.conclusion &&
    !completion?.acceptance &&
    (plan === undefined || (plan.kind === "no-pr" && plan.target.kind === "human-acceptance"));
  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      aria-label="Retrospective and follow-ups"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Completion and retrospective</h3>
        <Badge variant="outline">
          {retro?.reports.phase ?? completion?.phase ?? "Awaiting completion"}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        The team reviews its work after delivery or confirmed cancellation. Its engineering manager
        then reviews the lessons and assigns follow-ups. No process change is a valid outcome.
      </p>
      {assignment.integrationId && !completion?.conclusion ? (
        <p className="text-sm text-muted-foreground">
          This integration completes when every linked PR has a confirmed merge. Its team and
          manager retros follow that shared outcome.
        </p>
      ) : null}
      {completion?.waitReason ? (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            {completion.waitReason}
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled}
            onClick={() =>
              void command.submit({
                type: "assignment.completion.retry",
                assignmentId: assignment.id,
              })
            }
          >
            Retry completion check
          </Button>
        </div>
      ) : null}
      {completion && plan?.kind === "pull-requests" ? (
        <div className="space-y-2">
          <p className="text-sm">
            {plan.sealed
              ? "Required PR list sealed"
              : "The lead must declare and seal all required PRs"}
            . {plan.requirements.length} required.
          </p>
          {plan.requirements.map((requirement) => {
            const waived = completion.waivers.some(
              (waiver) => waiver.requirementId === requirement.id,
            );
            const delivered = completion.deliveries.some(
              (delivery) =>
                delivery.kind === "pull-request-merged" &&
                delivery.ref.number === requirement.ref.number &&
                delivery.ref.repository === requirement.ref.repository &&
                (requirement.expectedHeadSha === null ||
                  requirement.expectedHeadSha === delivery.headSha),
            );
            return (
              <label key={requirement.id} className="flex items-start gap-2 text-sm">
                {!waived && !delivered && completion.phase === "collecting" ? (
                  <Checkbox
                    checked={waivers.includes(requirement.id)}
                    disabled={command.disabled}
                    onCheckedChange={(checked) =>
                      setWaivers((current) =>
                        checked
                          ? [...current, requirement.id]
                          : current.filter((id) => id !== requirement.id),
                      )
                    }
                  />
                ) : null}
                <span>
                  {requirement.ref.repository} #{requirement.ref.number} ·{" "}
                  {waived ? "Waived by you" : delivered ? "Merged" : "Awaiting merge"}
                </span>
              </label>
            );
          })}
          {waivers.length ? (
            <div className="space-y-2">
              <Textarea
                aria-label="Reason for waiving remaining PR work"
                value={waiverReason}
                onChange={(event) => setWaiverReason(event.target.value)}
                placeholder="Explain why this remaining scope is being cancelled."
              />
              <Button
                size="sm"
                variant="outline"
                disabled={command.disabled || !waiverReason.trim()}
                onClick={() =>
                  void command
                    .submit({
                      type: "assignment.completion.waive",
                      assignmentId: assignment.id,
                      expectedVersion: plan.version,
                      requirementIds: waivers,
                      reason: waiverReason.trim(),
                    })
                    .then((saved) => {
                      if (saved) {
                        setWaivers([]);
                        setWaiverReason("");
                      }
                    })
                }
              >
                Waive selected remaining work
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {noPrAcceptance ? (
        <div className="space-y-2">
          <p className="text-sm">{assignment.scope?.completionCondition}</p>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={setAcknowledged}
              disabled={command.disabled}
            />
            I have checked the agreed outcome and accept this work.
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled || !acknowledged}
            onClick={() =>
              void command.submit({
                type: "assignment.completion.accept",
                assignmentId: assignment.id,
                condition: assignment.scope!.completionCondition,
                evidence: [{ kind: "thread", threadId: assignment.threadId }],
              })
            }
          >
            Accept outcome and begin retro
          </Button>
        </div>
      ) : null}
      {retro ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={
                !onOpenThread ||
                retro.execution.status === "preparing" ||
                !environment.data?.auxiliaryThreads.some(
                  (entry) => entry.threadId === retro.threadId,
                )
              }
              onClick={() => onOpenThread?.(retro.threadId)}
            >
              Open team retro
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!onOpenThread}
              onClick={() => onOpenThread?.(assignment.managerId)}
            >
              Discuss with manager
            </Button>
          </div>
          {retro.execution.status === "failed" ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive">{retro.execution.reason}</p>
              <Button
                size="xs"
                variant="outline"
                disabled={command.disabled}
                onClick={() => void command.submit({ type: "retro.retry", retroId: retro.id })}
              >
                Retry retrospective
              </Button>
            </div>
          ) : null}
          {retro.reports.phase !== "team-pending" ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Team report</h4>
              <p className="whitespace-pre-wrap text-sm">{retro.reports.team.outcome}</p>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                Helped: {retro.reports.team.helped || "None recorded"}
              </p>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                Hindered: {retro.reports.team.hindered || "None recorded"}
              </p>
              {retro.reports.team.learning.kind === "no-process-change" ? (
                <p className="text-sm">No process change: {retro.reports.team.learning.reason}</p>
              ) : null}
            </div>
          ) : null}
          {retro.reports.phase === "complete" ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Manager report</h4>
              <p className="whitespace-pre-wrap text-sm">{retro.reports.manager.summary}</p>
              {retro.reports.manager.learning.kind === "no-process-change" ? (
                <p className="text-sm">
                  No process change: {retro.reports.manager.learning.reason}
                </p>
              ) : null}
              {retro.reports.manager.dispositions.map((disposition) => (
                <p key={disposition.findingId} className="text-sm text-muted-foreground">
                  {findings.find((finding) => finding.id === disposition.findingId)?.problem ??
                    disposition.findingId}{" "}
                  · {disposition.kind}
                  {"reason" in disposition
                    ? `: ${disposition.reason}`
                    : "nextAction" in disposition
                      ? `: ${disposition.nextAction} (${disposition.owner.kind}; ${disposition.requiredAuthority})`
                      : ""}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {findings.length ? (
        <ul className="space-y-3">
          {findings.map((finding) => (
            <li key={finding.id} className="space-y-1 border-l border-border pl-3">
              <p className="text-sm font-medium">{finding.problem}</p>
              <p className="text-sm text-muted-foreground">{finding.impact}</p>
              <p className="text-xs">
                {finding.route.suspectedCause} · {finding.route.owner.kind} ·{" "}
                {finding.route.requiredAuthority}
              </p>
              <p className="text-xs text-muted-foreground">{finding.route.uncertainty}</p>
              {finding.escalation ? (
                <div className="space-y-1">
                  <p className="text-sm">
                    {finding.escalation.acknowledgedAt
                      ? "Escalation reviewed by you"
                      : systemManagerActive
                        ? "Sent to the system manager for workflow review"
                        : "Escalated to you (no active system manager)"}
                    : {finding.escalation.summary}
                  </p>
                  {finding.escalation.acknowledgedAt ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={command.disabled}
                      onClick={() =>
                        void command.submit({
                          type: "finding.escalation.acknowledge",
                          findingId: finding.id,
                        })
                      }
                    >
                      Mark escalation reviewed
                    </Button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {followups.length ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Follow-up tickets</h4>
          <ul className="space-y-3">
            {followups.map((followup) => (
              <Followup key={followup.id} followup={followup} environment={environment} />
            ))}
          </ul>
        </div>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}
