import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  AuthSettingsWriteScope,
  type FactoryFinding,
  type FactoryImprovementProposal,
  type FactoryManager,
  type ThreadId,
} from "@t3tools/contracts";
import { useId, useState } from "react";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { FactoryManagerControls } from "./FactoryControls";
import { FactoryImprovementSettings } from "./FactoryImprovementSettings";
import { useFactoryCommand } from "./useFactoryCommand";

interface EvidenceProps {
  environment: FactoryEnvironmentView;
  projects: readonly EnvironmentProject[];
  canOpenThread: (id: ThreadId) => boolean;
  onOpenThread: (id: ThreadId) => void;
}

function Finding({
  finding,
  environment,
  projects,
  canOpenThread,
  onOpenThread,
}: EvidenceProps & { finding: FactoryFinding }) {
  const assignment = environment.data?.assignments.find(
    (entry) => entry.id === finding.assignmentId,
  );
  const project = projects.find((entry) => entry.id === assignment?.projectId);
  const containment = environment.data?.findings.find(
    (entry) => entry.id === finding.containmentOf,
  );
  return (
    <details className="space-y-2 border-l border-border pl-3 text-sm">
      <summary className="cursor-pointer break-words">{finding.problem}</summary>
      <p className="whitespace-pre-wrap text-muted-foreground">{finding.impact}</p>
      <p className="text-xs text-muted-foreground">
        {project?.title ?? assignment?.projectId ?? "Source project unavailable"} ·{" "}
        {finding.route.suspectedCause} · {finding.route.owner.kind}
      </p>
      <p className="whitespace-pre-wrap text-muted-foreground">
        Uncertainty: {finding.route.uncertainty || "None recorded"}
      </p>
      <p className="whitespace-pre-wrap text-muted-foreground">
        Routing: {finding.route.rationale}
      </p>
      <p className="text-xs text-muted-foreground">
        Required authority: {finding.route.requiredAuthority}
      </p>
      {finding.containmentOf ? (
        <p className="text-xs text-muted-foreground">
          Local containment of {containment?.problem ?? finding.containmentOf}. Source finding:{" "}
          <code className="break-all">{finding.containmentOf}</code>
        </p>
      ) : null}
      <ul className="space-y-1 text-xs text-muted-foreground">
        {finding.evidence.map((evidence) => (
          <li key={JSON.stringify(evidence)} className="break-all">
            {evidence.kind}:{" "}
            {"threadId" in evidence ? (
              <>
                <code>{evidence.threadId}</code>
                {"messageId" in evidence
                  ? ` · message ${evidence.messageId}`
                  : "runId" in evidence
                    ? ` · run ${evidence.runId}`
                    : ""}{" "}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canOpenThread(evidence.threadId)}
                  onClick={() => onOpenThread(evidence.threadId)}
                >
                  Open source thread
                </Button>
              </>
            ) : (
              <code>{evidence.id}</code>
            )}
          </li>
        ))}
      </ul>
      {assignment ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!canOpenThread(assignment.threadId)}
          onClick={() => onOpenThread(assignment.threadId)}
        >
          Open source assignment
        </Button>
      ) : null}
      <p className="break-all text-xs text-muted-foreground">
        Finding {finding.id} · assignment {finding.assignmentId}
      </p>
    </details>
  );
}

function Proposal({
  proposal,
  environment,
  projects,
  canOpenThread,
  onOpenThread,
}: EvidenceProps & { proposal: FactoryImprovementProposal }) {
  const prefix = useId();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, settingsScope);
  const [outcome, setOutcome] = useState<"accepted" | "rejected" | "deferred" | null>(null);
  const [reason, setReason] = useState("");
  const [usefulness, setUsefulness] = useState<"useful" | "noisy" | "unclear" | null>(null);
  const [feedbackReason, setFeedbackReason] = useState("");
  const decision = environment.data?.improvementDecisions.findLast(
    (entry) => entry.proposalId === proposal.id && entry.revision === proposal.revision,
  );
  const feedback =
    environment.data?.improvementFeedback.filter(
      (entry) => entry.proposalId === proposal.id && entry.revision === proposal.revision,
    ) ?? [];
  const history =
    environment.data?.improvementDecisions.filter(
      (entry) => entry.proposalId === proposal.id && entry.revision !== proposal.revision,
    ) ?? [];
  const content = proposal.content;
  const scope = content.scope;
  const investigation = environment.data?.improvementInvestigations.find(
    (entry) => entry.id === proposal.investigationId,
  );
  const decide = async () => {
    if (!outcome || !reason.trim()) return;
    if (
      await command.submit({
        type: "proposal.decide",
        proposalId: proposal.id,
        revision: proposal.revision,
        outcome,
        reason: reason.trim(),
      })
    ) {
      setOutcome(null);
      setReason("");
    }
  };
  return (
    <li
      className="space-y-3 border-b border-border py-4 last:border-b-0"
      aria-busy={command.pending}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">
          {investigation?.title ?? "Shared workflow proposal"}
        </h3>
        <Badge variant={proposal.phase === "human-review" ? "warning" : "outline"}>
          {decision?.outcome ??
            (proposal.phase === "human-review" ? "Your review" : proposal.phase)}
        </Badge>
      </div>
      <p className="whitespace-pre-wrap text-sm">{content.problem}</p>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="font-medium">Affected scope</dt>
          <dd className="text-muted-foreground">
            {scope.kind === "projects"
              ? scope.projectIds
                  .map((id) => projects.find((project) => project.id === id)?.title ?? id)
                  .join(", ")
              : scope.kind === "capability"
                ? `Reusable capability: ${scope.name}`
                : `Shared workflow: ${scope.components.join(", ")}`}
          </dd>
        </div>
        {(
          [
            ["Exclusions", content.exclusions || "None recorded"],
            ["Expected benefit", content.expectedBenefit],
            ["Tradeoffs", content.tradeoffs],
            ["Uncertainty", content.uncertainty],
            ["Decision requested", content.requestedDecision],
            [
              "Optional assessment approach",
              content.assessmentApproach ??
                "No experiment proposed. Testing is not required for your decision.",
            ],
          ] as const
        ).map(([title, value]) => (
          <div key={title}>
            <dt className="font-medium">{title}</dt>
            <dd className="whitespace-pre-wrap text-muted-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="break-all text-xs text-muted-foreground">
        Proposal {proposal.id} · revision {proposal.revision}
      </p>
      {investigation ? (
        <details className="space-y-3 text-sm">
          <summary className="cursor-pointer">Source evidence · {investigation.title}</summary>
          {investigation.findingIds.map((id) => {
            const finding = environment.data?.findings.find((entry) => entry.id === id);
            return finding ? (
              <Finding
                key={id}
                finding={finding}
                environment={environment}
                projects={projects}
                canOpenThread={canOpenThread}
                onOpenThread={onOpenThread}
              />
            ) : (
              <p key={id} className="break-all text-xs text-muted-foreground">
                Finding unavailable: {id}
              </p>
            );
          })}
        </details>
      ) : null}
      {decision ? (
        <p role="status" className="whitespace-pre-wrap text-sm">
          You {decision.outcome} this revision. {decision.reason}
        </p>
      ) : null}
      {(proposal.phase === "human-review" && !decision) || decision?.outcome === "deferred" ? (
        <div className="space-y-3 border-l border-border pl-3">
          <p className="text-sm text-muted-foreground">
            {decision ? "Record a new decision when you are ready. " : ""}Decide from the evidence
            available. No test, benchmark or cross-project trial is required. Acceptance records
            this proposal decision; implementation and rollout remain separate.
          </p>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-outcome`}>Your decision for this revision</Label>
            <Select
              value={outcome}
              disabled={command.disabled}
              items={[
                { value: "accepted", label: "Accept" },
                { value: "rejected", label: "Reject" },
                { value: "deferred", label: "Defer" },
              ]}
              onValueChange={setOutcome}
            >
              <SelectTrigger id={`${prefix}-outcome`}>
                <SelectValue placeholder="Choose a decision" />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="accepted">Accept</SelectItem>
                <SelectItem value="rejected">Reject</SelectItem>
                <SelectItem value="deferred">Defer</SelectItem>
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-reason`}>Reason for your decision</Label>
            <Textarea
              id={`${prefix}-reason`}
              rows={3}
              maxLength={6000}
              value={reason}
              disabled={command.disabled}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled || !outcome || !reason.trim()}
            onClick={() => void decide()}
          >
            {command.pending ? "Recording decision…" : "Record decision for this revision"}
          </Button>
        </div>
      ) : null}
      {history.length ? (
        <details className="space-y-2 text-sm">
          <summary>Earlier decisions</summary>
          {history.map((entry) => (
            <p key={entry.commandId} className="break-words text-muted-foreground">
              {entry.outcome} · revision {entry.revision}: {entry.reason}
            </p>
          ))}
        </details>
      ) : null}
      <details className="space-y-3 text-sm">
        <summary className="cursor-pointer">Usefulness feedback</summary>
        <p className="text-xs text-muted-foreground">
          Assess the recommendation separately from accepting it. Rejection does not automatically
          mean it was noisy.
        </p>
        {feedback.map((entry) => (
          <p key={entry.id} className="whitespace-pre-wrap text-muted-foreground">
            {entry.usefulness}: {entry.reason}
          </p>
        ))}
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-usefulness`}>How useful was this proposal?</Label>
          <Select
            value={usefulness}
            disabled={command.disabled}
            items={[
              { value: "useful", label: "Useful" },
              { value: "noisy", label: "Noisy" },
              { value: "unclear", label: "Unclear" },
            ]}
            onValueChange={setUsefulness}
          >
            <SelectTrigger id={`${prefix}-usefulness`}>
              <SelectValue placeholder="Choose feedback" />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="useful">Useful</SelectItem>
              <SelectItem value="noisy">Noisy</SelectItem>
              <SelectItem value="unclear">Unclear</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-feedback`}>Feedback reason</Label>
          <Textarea
            id={`${prefix}-feedback`}
            value={feedbackReason}
            maxLength={6000}
            rows={2}
            disabled={command.disabled}
            onChange={(event) => setFeedbackReason(event.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={command.disabled || !usefulness || !feedbackReason.trim()}
          onClick={() => {
            if (usefulness)
              void command
                .submit({
                  type: "proposal.feedback",
                  proposalId: proposal.id,
                  revision: proposal.revision,
                  usefulness,
                  reason: feedbackReason.trim(),
                })
                .then((saved) => {
                  if (saved) {
                    setUsefulness(null);
                    setFeedbackReason("");
                  }
                });
          }}
        >
          Save usefulness feedback
        </Button>
      </details>
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </li>
  );
}

function AttachRetainedFinding({
  environment,
  findingId,
}: {
  environment: FactoryEnvironmentView;
  findingId: string;
}) {
  const prefix = useId();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, settingsScope);
  const [investigationId, setInvestigationId] = useState<string | null>(null);
  const investigations =
    environment.data?.improvementInvestigations.filter(
      (entry) => entry.lifecycle.phase !== "closed" && !entry.findingIds.includes(findingId),
    ) ?? [];
  const target = investigations.find((entry) => entry.id === investigationId);
  if (!investigations.length) return null;
  return (
    <div className="space-y-2 border-l border-border pl-3">
      <Label htmlFor={`${prefix}-investigation`}>Attach this retained finding</Label>
      <Select
        value={investigationId}
        disabled={command.disabled}
        items={investigations.map((entry) => ({ value: entry.id, label: entry.title }))}
        onValueChange={setInvestigationId}
      >
        <SelectTrigger id={`${prefix}-investigation`}>
          <SelectValue placeholder="Choose an open investigation" />
        </SelectTrigger>
        <SelectPopup>
          {investigations.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={command.disabled || !target}
        onClick={() => {
          if (target)
            void command
              .submit({
                type: "investigation.update",
                investigationId: target.id,
                findingIds: [...target.findingIds, findingId],
                relatedInvestigationIds: target.relatedInvestigationIds,
                uncertainty: target.uncertainty,
                assessment: target.assessment,
                lifecycle: target.lifecycle,
              })
              .then((saved) => {
                if (saved) setInvestigationId(null);
              });
        }}
      >
        Attach to investigation
      </Button>
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </div>
  );
}

export function FactoryImprovementsDialog({
  environment,
  projects,
  manager,
  onClose,
  onOpenThread,
  canOpenThread,
}: EvidenceProps & { manager: Extract<FactoryManager, { role: "system" }>; onClose: () => void }) {
  const prefix = useId();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, settingsScope);
  const [view, setView] = useState<
    "proposals" | "investigations" | "intake" | "settings" | "controls"
  >("proposals");
  const [limit, setLimit] = useState(50);
  const [flushed, setFlushed] = useState(false);
  const [escalationsReviewed, setEscalationsReviewed] = useState(false);
  const [retryingBatchId, setRetryingBatchId] = useState<string | null>(null);
  const data = environment.data;
  if (!data) return null;
  const queued = data.improvementIntakes.filter((entry) => entry.delivery.phase === "queued");
  const failedBatches = data.improvementBatches.filter(
    (entry) =>
      entry.managerId === manager.id &&
      entry.delivery.status === "pending" &&
      entry.delivery.failure !== undefined,
  );
  const proposals = [
    ...new Map(data.improvementProposals.map((entry) => [entry.id, entry])).values(),
  ].toSorted(
    (a, b) =>
      Number(b.phase === "human-review") - Number(a.phase === "human-review") ||
      b.createdAt.localeCompare(a.createdAt),
  );
  const today = new Date().toISOString().slice(0, 10);
  const spent = data.improvementBatches.filter(
    (entry) => entry.kind === "routine" && entry.budgetDay === today,
  ).length;
  const urgentSpent = data.improvementBatches.filter(
    (entry) => entry.kind === "urgent" && entry.budgetDay === today,
  ).length;
  const config = data.improvementConfigurations.at(-1);
  const urgentAllowance = config?.urgentBatchesPerDay ?? 4;
  const heldEscalations =
    urgentSpent >= urgentAllowance
      ? queued.filter((entry) => entry.origin === "explicit-escalation").length
      : 0;
  const routineQueued = queued.filter((entry) => entry.origin === "retro").length;
  const evidenceProps = { environment, projects, canOpenThread, onOpenThread };
  const viewItems = [
    { value: "proposals", label: "Proposals and decisions" },
    { value: "investigations", label: "Investigations and source evidence" },
    { value: "intake", label: "Evidence intake and batches" },
    { value: "settings", label: "Review settings" },
    { value: "controls", label: "Manager controls" },
  ] as const;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Shared improvements</DialogTitle>
          <DialogDescription>
            {manager.name} · {environment.label}. Shared process recommendations come to you;
            project managers retain their delivery remit.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{queued.length} evidence items queued</span>
              <span>
                Routine budget used today: {spent} / {config?.routineBatchesPerDay ?? 2}
              </span>
              <span>
                Escalation reviews today: {urgentSpent} / {urgentAllowance}
              </span>
            </div>
            {heldEscalations > 0 ? (
              <div role="status" className="space-y-2">
                <p className="text-sm">
                  {heldEscalations} {heldEscalations === 1 ? "escalation is" : "escalations are"}{" "}
                  waiting for your review.{" "}
                  {urgentAllowance === 0
                    ? "Automatic escalation reviews are off."
                    : "Today's escalation allowance is spent."}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    command.disabled || manager.status !== "active" || config?.enabled === false
                  }
                  onClick={() =>
                    void command
                      .submit({ type: "improvement.flush", kind: "urgent" })
                      .then((saved) => setEscalationsReviewed(saved))
                  }
                >
                  Review escalations now
                </Button>
                <p className="text-xs text-muted-foreground">
                  This sends waiting escalations to the system manager without using the daily
                  allowance.
                </p>
              </div>
            ) : null}
            {escalationsReviewed ? (
              <p role="status" className="text-sm text-muted-foreground">
                Escalation review requested.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Recorded feedback:{" "}
              {data.improvementFeedback.filter((entry) => entry.usefulness === "useful").length}{" "}
              useful,{" "}
              {data.improvementFeedback.filter((entry) => entry.usefulness === "noisy").length}{" "}
              noisy,{" "}
              {data.improvementFeedback.filter((entry) => entry.usefulness === "unclear").length}{" "}
              unclear. {data.improvementRecurrences.length} recurrence links. These describe
              feedback, not proof of delivered benefit.
            </p>
            {failedBatches.length > 0 && view !== "intake" ? (
              <div role="status" className="space-y-2">
                <p className="text-sm text-destructive">
                  {failedBatches.length} evidence{" "}
                  {failedBatches.length === 1 ? "batch needs" : "batches need"} delivery retry.
                </p>
                <Button size="sm" variant="outline" onClick={() => setView("intake")}>
                  Inspect failed delivery
                </Button>
              </div>
            ) : null}
            {!environment.connected ? (
              <p role="status" className="text-sm text-muted-foreground">
                Offline. Reconnect to record decisions or change review settings.
              </p>
            ) : null}
            {!settingsScope || !environment.canOperate ? (
              <p role="status" className="text-sm text-muted-foreground">
                You can inspect the backlog. Settings and operate permission are required to record
                decisions or configure review.
              </p>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-view`}>Backlog view</Label>
              <Select
                value={view}
                items={viewItems}
                onValueChange={(value) => {
                  if (value) {
                    setView(value);
                    setLimit(50);
                  }
                }}
              >
                <SelectTrigger id={`${prefix}-view`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {viewItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {view === "proposals" ? (
              proposals.length ? (
                <ul>
                  {proposals.slice(0, limit).map((proposal) => (
                    <Proposal
                      key={`${proposal.id}:${proposal.revision}`}
                      proposal={proposal}
                      {...evidenceProps}
                    />
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-sm text-muted-foreground">
                  No proposals yet. The system manager investigates evidence and brings concrete
                  proposals here for your decision.
                </p>
              )
            ) : null}
            {view === "proposals" && proposals.length > limit ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLimit((previous) => previous + 50)}
              >
                Show more proposals
              </Button>
            ) : null}
            {view === "investigations" ? (
              <div className="space-y-5">
                {data.improvementInvestigations.length ? (
                  data.improvementInvestigations
                    .toReversed()
                    .slice(0, limit)
                    .map((investigation) => (
                      <section
                        key={investigation.id}
                        className="space-y-3 border-b border-border pb-4"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-medium">{investigation.title}</h3>
                          <Badge variant="outline">{investigation.lifecycle.phase}</Badge>
                        </div>
                        {"reason" in investigation.lifecycle ? (
                          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                            {investigation.lifecycle.reason}
                          </p>
                        ) : null}
                        <p className="whitespace-pre-wrap text-sm">
                          {investigation.assessment || "Assessment not yet recorded."}
                        </p>
                        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                          Uncertainty: {investigation.uncertainty || "None recorded"}
                        </p>
                        {investigation.findingIds.map((id) => {
                          const finding = data.findings.find((entry) => entry.id === id);
                          return finding ? (
                            <Finding key={id} finding={finding} {...evidenceProps} />
                          ) : (
                            <p key={id} className="break-all text-xs text-muted-foreground">
                              Finding unavailable: {id}
                            </p>
                          );
                        })}
                        {investigation.relatedInvestigationIds.length ? (
                          <p className="text-xs text-muted-foreground">
                            Related investigations:{" "}
                            {investigation.relatedInvestigationIds
                              .map(
                                (id) =>
                                  data.improvementInvestigations.find((entry) => entry.id === id)
                                    ?.title ?? id,
                              )
                              .join(", ")}
                          </p>
                        ) : null}
                        {data.improvementRecurrences
                          .filter((entry) => entry.investigationId === investigation.id)
                          .map((entry) => (
                            <p key={entry.id} className="break-words text-xs text-muted-foreground">
                              Recurrence linked to finding {entry.findingId}: {entry.reason}
                            </p>
                          ))}
                        <p className="break-all text-xs text-muted-foreground">
                          Investigation {investigation.id}
                        </p>
                      </section>
                    ))
                ) : (
                  <p className="py-4 text-sm text-muted-foreground">
                    No investigations yet. Evidence is retained until the system manager can review
                    it.
                  </p>
                )}
              </div>
            ) : null}
            {view === "investigations" && data.improvementInvestigations.length > limit ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLimit((previous) => previous + 50)}
              >
                Show more investigations
              </Button>
            ) : null}
            {view === "intake" ? (
              <div className="space-y-4">
                {failedBatches.map((batch) => (
                  <section
                    key={batch.id}
                    className="space-y-2 border-l border-destructive pl-3"
                    aria-label="Failed evidence batch delivery"
                  >
                    <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
                      {batch.delivery.status === "pending" ? batch.delivery.failure : null}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      Batch {batch.id} · {batch.kind} · {batch.intakeIds.length} evidence items
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Retry sends the same saved evidence. It does not spend another batch from the
                      routine budget. Manager pause and review settings still apply.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        command.disabled || manager.status !== "active" || config?.enabled === false
                      }
                      onClick={() => {
                        setRetryingBatchId(batch.id);
                        void command
                          .submit({ type: "improvement.batch.retry", batchId: batch.id })
                          .finally(() => setRetryingBatchId(null));
                      }}
                    >
                      {retryingBatchId === batch.id ? "Retrying delivery…" : "Retry this batch"}
                    </Button>
                  </section>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    command.disabled ||
                    !routineQueued ||
                    manager.status !== "active" ||
                    config?.enabled === false
                  }
                  onClick={() =>
                    void command
                      .submit({ type: "improvement.flush" })
                      .then((saved) => setFlushed(saved))
                  }
                >
                  {command.pending ? "Requesting review…" : "Review queued routine evidence now"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  This bypasses the routine count and age threshold. The daily budget and manager
                  controls still apply.
                </p>
                {flushed ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Review requested. Eligible evidence is batched within the current limits.
                  </p>
                ) : null}
                {data.improvementIntakes
                  .toReversed()
                  .slice(0, limit)
                  .map((entry) => {
                    const finding = data.findings.find((item) => item.id === entry.findingId);
                    const delivery = entry.delivery;
                    const batch =
                      delivery.phase === "batched"
                        ? data.improvementBatches.find((item) => item.id === delivery.batchId)
                        : undefined;
                    return (
                      <section key={entry.id} className="space-y-2 border-b border-border pb-3">
                        <div className="flex flex-wrap gap-2">
                          <Badge
                            variant={entry.origin === "explicit-escalation" ? "warning" : "outline"}
                          >
                            {entry.origin === "explicit-escalation"
                              ? "Explicit escalation"
                              : "Retro finding"}
                          </Badge>
                          <Badge variant="outline">
                            {batch
                              ? batch.delivery.status === "delivered"
                                ? "Delivered"
                                : batch.delivery.failure
                                  ? "Delivery failed"
                                  : "Batch pending"
                              : entry.delivery.phase}
                          </Badge>
                        </div>
                        <p className="whitespace-pre-wrap text-sm">{entry.summary}</p>
                        {entry.sampling.kind === "local" && entry.origin === "retro" ? (
                          <p className="text-xs text-muted-foreground">
                            Local sample {entry.sampling.ordinal} ·{" "}
                            {entry.sampling.selected
                              ? "selected for review"
                              : "retained, not sampled"}
                          </p>
                        ) : null}
                        {finding ? (
                          <Finding finding={finding} {...evidenceProps} />
                        ) : (
                          <p className="break-all text-xs text-muted-foreground">
                            Source finding {entry.findingId}
                          </p>
                        )}
                        {entry.delivery.phase === "skipped" ? (
                          <AttachRetainedFinding
                            environment={environment}
                            findingId={entry.findingId}
                          />
                        ) : null}
                        <p className="break-all text-xs text-muted-foreground">
                          Intake {entry.id}
                          {batch ? ` · batch ${batch.id}` : ""}
                        </p>
                      </section>
                    );
                  })}
                {!data.improvementIntakes.length ? (
                  <p className="text-sm text-muted-foreground">No shared evidence collected yet.</p>
                ) : null}
                {data.improvementIntakes.length > limit ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLimit((previous) => previous + 50)}
                  >
                    Show more evidence
                  </Button>
                ) : null}
              </div>
            ) : null}
            {view === "settings" ? <FactoryImprovementSettings environment={environment} /> : null}
            {view === "controls" ? (
              <FactoryManagerControls environment={environment} manager={manager} />
            ) : null}
            {command.error ? (
              <p role="alert" className="text-sm text-destructive">
                {command.error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canOpenThread(manager.threadId)}
            onClick={() => onOpenThread(manager.threadId)}
          >
            Discuss with system manager
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
