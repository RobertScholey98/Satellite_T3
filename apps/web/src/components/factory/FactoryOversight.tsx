import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type FactoryAssignment,
  type FactoryDependency,
  type FactoryEvidence,
  type FactoryOversightCommand,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useThreadShell, useThreadShellsForProjectRefs } from "../../state/entities";
import {
  factoryEnvironment,
  useFactoryEnvironments,
  type FactoryEnvironmentView,
} from "../../state/factory";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import {
  factoryAssignmentCancellation,
  factoryManagerPause,
  factoryProjectPause,
  factoryThreadMembership,
} from "./FactoryControlsReadModel";
import {
  factoryDependencyStatus,
  factoryOversightSummary,
  factoryRecoveryAllowance,
  factoryThreadOversightTarget,
} from "./FactoryOversightReadModel";

type OversightInput = FactoryOversightCommand extends infer Command
  ? Command extends FactoryOversightCommand
    ? Omit<Command, "commandId">
    : never
  : never;

function useOversightCommand(environment: FactoryEnvironmentView, assignment: FactoryAssignment) {
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submissions = useRef(new Map<string, CommandId>());
  const syncing = revision > (environment.data?.revision ?? 0);
  const paused =
    factoryProjectPause(environment.data, assignment.projectId) !== undefined ||
    factoryManagerPause(environment.data, assignment.managerId) !== undefined;
  const disabled =
    pending ||
    syncing ||
    !environment.connected ||
    !environment.canOperate ||
    paused ||
    assignment.outcome !== undefined ||
    assignment.status === "complete" ||
    factoryAssignmentCancellation(environment.data, assignment) !== undefined;
  const submit = async (input: OversightInput) => {
    if (disabled || inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const content = JSON.stringify(input);
    const commandId = submissions.current.get(content) ?? CommandId.make(randomUUID());
    submissions.current.set(content, commandId);
    try {
      const result = await dispatch({
        environmentId: environment.environmentId,
        input: { command: { ...input, commandId } },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error ? cause.message : "Could not save this decision. Try again.",
        );
        return false;
      }
      submissions.current.delete(content);
      setRevision(result.value.revision);
      return true;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { submit, disabled, pending: pending || syncing, paused, error };
}

type OversightCommand = ReturnType<typeof useOversightCommand>;

function Evidence({ evidence }: { evidence: readonly FactoryEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {evidence.map((entry) => (
        <li key={`${entry.location}:${entry.label}`} className="break-words">
          {entry.label} <span className="font-mono">{entry.location}</span>
        </li>
      ))}
    </ul>
  );
}

function ThreadLink({
  environment,
  threadId,
  children,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  threadId: ThreadId;
  children: React.ReactNode;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  return onOpenThread ? (
    <Button size="xs" variant="outline" onClick={() => onOpenThread(threadId)}>
      {children}
    </Button>
  ) : (
    <Link
      className="text-xs text-primary underline underline-offset-2"
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environment.environmentId, threadId))}
    >
      {children}
    </Link>
  );
}

function Dependency({
  environment,
  assignment,
  dependency,
  command,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  assignment: FactoryAssignment;
  dependency: FactoryDependency;
  command: OversightCommand;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const prefix = useId();
  const [assessment, setAssessment] = useState("");
  const [location, setLocation] = useState("");
  const supporting = environment.data?.assignments.find(
    (entry) => entry.id === dependency.supportingAssignmentId,
  );
  const condition = dependency.unblockCondition;
  const delivery = dependency.delivery;
  const check = async (usable: boolean) => {
    if (!delivery || !assessment.trim() || !location.trim()) return;
    if (
      await command.submit({
        type: "dependency.check-usability",
        dependencyId: dependency.id,
        deliveryId: delivery.id,
        usable,
        evidence: [{ label: assessment.trim(), location: location.trim() }],
      })
    ) {
      setAssessment("");
      setLocation("");
    }
  };
  return (
    <section className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">{dependency.description}</h4>
        <Badge
          variant={
            dependency.usability?.usable && dependency.usability.deliveryId === delivery?.id
              ? "success"
              : "outline"
          }
        >
          {factoryDependencyStatus(dependency)}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {condition.kind === "pull-request-merged"
          ? `Unblocks after actual merge${condition.ref ? ` of ${condition.ref.repository} #${condition.ref.number}` : " of the supporting PR"}${condition.expectedHeadSha ? ` at ${condition.expectedHeadSha}` : " (reviewed head not recorded yet)"}.`
          : `Unblocks after the report reaches its recipient: ${condition.requirement}`}
      </p>
      {supporting ? (
        <ThreadLink
          environment={environment}
          threadId={supporting.threadId}
          onOpenThread={onOpenThread}
        >
          Open supporting team
        </ThreadLink>
      ) : dependency.authorization ? (
        <p className="text-xs text-muted-foreground">
          Approved work: {dependency.authorization.work.title}. Approval alone does not unblock this
          assignment.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The manager must authorize and commission separate supporting work.
        </p>
      )}
      {delivery ? (
        <div className="space-y-1 text-xs">
          <p>
            {delivery.kind === "pull-request-merged"
              ? `Confirmed merged: ${delivery.ref.repository} #${delivery.ref.number} · ${delivery.headSha}`
              : `Report delivered: ${delivery.summary}`}
          </p>
          {delivery.kind === "report-delivered" ? <Evidence evidence={delivery.evidence} /> : null}
          <p className="text-muted-foreground">
            Delivery must also be usable by the requesting team.
          </p>
        </div>
      ) : null}
      <Evidence evidence={dependency.evidence} />
      {dependency.usability ? <Evidence evidence={dependency.usability.evidence} /> : null}
      {delivery && assignment.outcome === undefined ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Record your usability check
          </summary>
          <div className="space-y-2 pt-2">
            <Label htmlFor={`${prefix}-assessment`}>What did you check?</Label>
            <Textarea
              id={`${prefix}-assessment`}
              value={assessment}
              disabled={command.disabled}
              onChange={(event) => setAssessment(event.target.value)}
            />
            <Label htmlFor={`${prefix}-location`}>Evidence location</Label>
            <Input
              id={`${prefix}-location`}
              value={location}
              disabled={command.disabled}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Test result, file, or discussion reference"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={command.disabled || !assessment.trim() || !location.trim()}
                onClick={() => void check(true)}
              >
                Usable — continue
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={command.disabled || !assessment.trim() || !location.trim()}
                onClick={() => void check(false)}
              >
                Not usable — keep waiting
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Other waits and permissions remain in force. A failed usability check does not spend a
              recovery cycle.
            </p>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Recovery({
  environment,
  assignment,
  command,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  assignment: FactoryAssignment;
  command: OversightCommand;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const prefix = useId();
  const [plan, setPlan] = useState("");
  const [replaceLead, setReplaceLead] = useState(false);
  const recovery = assignment.oversight?.recovery;
  const incident = recovery?.incident;
  const allowance = environment.data
    ? factoryRecoveryAllowance(environment.data, assignment)
    : null;
  const diagnosis = environment.data?.auxiliaryThreads.find(
    (entry) => entry.threadId === incident?.diagnosisThreadId,
  );
  const canReplan =
    incident?.phase === "escalated" ||
    (incident?.phase === "replanning" && diagnosis?.findings !== undefined);
  return (
    <section className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Bounded recovery</h3>
        {allowance ? (
          <span className="text-xs text-muted-foreground">
            {allowance.used} of {allowance.limit} cycles used · {allowance.remaining} remaining
          </span>
        ) : null}
        {incident ? (
          <Badge variant={incident.phase === "escalated" ? "warning" : "outline"}>
            {incident.phase}
          </Badge>
        ) : null}
      </div>
      {incident ? (
        <>
          <p className="whitespace-pre-wrap text-sm">{incident.reason}</p>
          <Evidence evidence={incident.evidence} />
          {diagnosis ? (
            <div className="space-y-2">
              <ThreadLink
                environment={environment}
                threadId={diagnosis.threadId}
                onOpenThread={onOpenThread}
              >
                Open independent diagnosis
              </ThreadLink>
              <p className="text-xs text-muted-foreground">Diagnosis: {diagnosis.status}</p>
              {diagnosis.failure ? (
                <p className="text-sm text-destructive">{diagnosis.failure}</p>
              ) : null}
              {diagnosis.findings ? (
                <>
                  <p className="whitespace-pre-wrap text-sm">{diagnosis.findings.summary}</p>
                  <Evidence evidence={diagnosis.findings.evidence} />
                </>
              ) : null}
            </div>
          ) : null}
          {incident.plan ? (
            <p className="whitespace-pre-wrap text-sm">Current plan: {incident.plan}</p>
          ) : null}
          {incident.escalation ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Your decision is needed</h4>
              <p className="whitespace-pre-wrap text-sm">{incident.escalation.failure}</p>
              {incident.escalation.attempts.length > 0 ? (
                <>
                  <p className="text-xs font-medium">Already tried</p>
                  <ul className="list-disc space-y-1 pl-4 text-sm">
                    {[...new Set(incident.escalation.attempts)].map((attempt) => (
                      <li key={attempt}>{attempt}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p className="text-xs font-medium">Options</p>
              <ul className="list-disc space-y-1 pl-4 text-sm">
                {[...new Set(incident.escalation.options)].map((option) => (
                  <li key={option}>{option}</li>
                ))}
              </ul>
              <p className="whitespace-pre-wrap text-sm">
                Recommendation: {incident.escalation.recommendation}
              </p>
            </div>
          ) : null}
          {incident.phase === "reconciling" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={command.disabled || allowance?.remaining === 0}
              onClick={() =>
                void command.submit({
                  type: "assignment.recovery.begin",
                  assignmentId: assignment.id,
                  incidentId: incident.id,
                })
              }
            >
              Begin independent diagnosis
            </Button>
          ) : null}
          {canReplan ? (
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-plan`}>Recovery plan</Label>
              <Textarea
                id={`${prefix}-plan`}
                value={plan}
                disabled={command.disabled}
                onChange={(event) => setPlan(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${prefix}-replace`}
                  checked={replaceLead}
                  disabled={command.disabled}
                  onCheckedChange={(checked) => setReplaceLead(checked === true)}
                />
                <Label htmlFor={`${prefix}-replace`}>Continue with a replacement lead</Label>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={command.disabled || !plan.trim()}
                onClick={() =>
                  void command.submit({
                    type: "assignment.recovery.replan",
                    assignmentId: assignment.id,
                    incidentId: incident.id,
                    plan: plan.trim(),
                    replaceLead,
                  })
                }
              >
                Approve plan and continue
              </Button>
              <p className="text-xs text-muted-foreground">
                The saved work, permissions and spent recovery cycles are retained. The approved
                model policy selects the lead.
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No unresolved recovery incident. Expected waits do not spend recovery cycles.
        </p>
      )}
      {(assignment.previousLeadThreadIds?.length ?? 0) > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Prior lead conversations</span>
          {assignment.previousLeadThreadIds?.map((threadId, index) => (
            <ThreadLink
              key={threadId}
              environment={environment}
              threadId={threadId}
              onOpenThread={onOpenThread}
            >
              Lead {index + 1}
            </ThreadLink>
          ))}
        </div>
      ) : null}
      {(recovery?.history.length ?? 0) > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Previous recovery incidents ({recovery?.history.length})
          </summary>
          <ul className="space-y-2 pt-2 text-xs">
            {recovery?.history.map((entry) => (
              <li key={entry.id} className="space-y-1">
                <p>
                  {entry.reason} · {entry.phase}
                </p>
                {entry.plan ? <p>{entry.plan}</p> : null}
                {entry.diagnosisThreadId ? (
                  <ThreadLink
                    environment={environment}
                    threadId={entry.diagnosisThreadId}
                    onOpenThread={onOpenThread}
                  >
                    Open diagnosis
                  </ThreadLink>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function FactoryOversight({
  environment,
  assignment,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  assignment: FactoryAssignment;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const command = useOversightCommand(environment, assignment);
  const progress = assignment.oversight?.progress;
  const dependencies =
    environment.data?.dependencies.filter((entry) => entry.assignmentId === assignment.id) ?? [];
  if (assignment.kind === "onboarding") return null;
  return (
    <div className="space-y-4" aria-busy={command.pending}>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Progress</h3>
        <p className="whitespace-pre-wrap text-sm">
          {progress?.summary ?? "No progress report yet."}
        </p>
        {progress?.remainingWork ? (
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">
            Remaining: {progress.remainingWork}
          </p>
        ) : null}
        {progress ? <Evidence evidence={progress.evidence} /> : null}
        {assignment.wait ? (
          <p className="text-sm text-muted-foreground">
            {assignment.wait.kind === "delivered" ? "Delivery recorded" : "Expected wait"}:{" "}
            {assignment.wait.reason}
          </p>
        ) : null}
        {assignment.wait?.kind === "human-decision" &&
        assignment.oversight?.decisionPending !== undefined ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Discuss the decision with the lead in the conversation, then explicitly resolve this
              wait. Other controls and the recovery allowance are unchanged.
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={command.disabled}
              onClick={() =>
                void command.submit({
                  type: "assignment.wait.resolve",
                  assignmentId: assignment.id,
                })
              }
            >
              Resolve decision and continue
            </Button>
          </div>
        ) : null}
        {!assignment.wait &&
        !assignment.oversight?.recovery.incident &&
        assignment.status !== "complete" &&
        assignment.outcome === undefined ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Record a decision the team must wait for
            </summary>
            <div className="space-y-2 pt-2">
              <Label htmlFor={reasonId}>Decision needed</Label>
              <Textarea
                id={reasonId}
                value={reason}
                disabled={command.disabled}
                onChange={(event) => setReason(event.target.value)}
              />
              <Button
                size="xs"
                variant="outline"
                disabled={command.disabled || !reason.trim()}
                onClick={() =>
                  void command.submit({
                    type: "assignment.wait",
                    assignmentId: assignment.id,
                    wait: { kind: "human-decision", reason: reason.trim() },
                  })
                }
              >
                Record decision wait
              </Button>
            </div>
          </details>
        ) : null}
      </section>
      {assignment.oversight?.delivery ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h3 className="text-sm font-medium">Confirmed delivery</h3>
          <p className="text-sm">
            {assignment.oversight.delivery.kind === "pull-request-merged"
              ? `${assignment.oversight.delivery.ref.repository} #${assignment.oversight.delivery.ref.number} merged at ${assignment.oversight.delivery.headSha}`
              : assignment.oversight.delivery.summary}
          </p>
          {assignment.oversight.delivery.kind === "report-delivered" ? (
            <Evidence evidence={assignment.oversight.delivery.evidence} />
          ) : null}
        </section>
      ) : null}
      {dependencies.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Dependencies</h3>
          {dependencies.map((dependency) => (
            <Dependency
              key={`${dependency.id}:${dependency.delivery?.id ?? "pending"}`}
              environment={environment}
              assignment={assignment}
              dependency={dependency}
              command={command}
              onOpenThread={onOpenThread}
            />
          ))}
        </section>
      ) : null}
      <Recovery
        key={assignment.oversight?.recovery.incident?.id ?? "none"}
        environment={environment}
        assignment={assignment}
        command={command}
        onOpenThread={onOpenThread}
      />
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
      {command.pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Saving decision and waiting for updated assignment state…
        </p>
      ) : null}
      {command.paused ? (
        <p className="text-xs text-muted-foreground">
          Resume the manager and project controls before requesting recovery or changing waits.
        </p>
      ) : null}
      {!environment.connected ? (
        <p className="text-xs text-muted-foreground">
          Reconnect to {environment.label} to record a decision.
        </p>
      ) : null}
      {!environment.canOperate ? (
        <p className="text-xs text-muted-foreground">
          This connection can view oversight but cannot record decisions.
        </p>
      ) : null}
    </div>
  );
}

export function FactoryThreadOversight({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environments = useFactoryEnvironments();
  const thread = useThreadShell(threadRef);
  const environment = environments.find((entry) => entry.environmentId === threadRef.environmentId);
  if (!thread || !environment?.data) return null;
  const target = factoryThreadOversightTarget(environment.data, thread.id, thread.projectId);
  if (target === null) return null;
  if (target.kind === "direct")
    return (
      <ThreadOversight
        environment={environment}
        threadId={thread.id}
        assignment={target.assignment}
      />
    );
  return (
    <LineageOversight
      environment={environment}
      threadRef={threadRef}
      projectId={thread.projectId}
    />
  );
}

function LineageOversight({
  environment,
  threadRef,
  projectId,
}: {
  environment: FactoryEnvironmentView;
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
}) {
  const projectRefs = useMemo(
    () => [{ environmentId: threadRef.environmentId, projectId }],
    [threadRef.environmentId, projectId],
  );
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const assignment = environment.data
    ? factoryThreadMembership(environment.data, threadRef, threads)?.assignment
    : undefined;
  if (!assignment) return null;
  return (
    <ThreadOversight
      environment={environment}
      threadId={threadRef.threadId}
      assignment={assignment}
    />
  );
}

function ThreadOversight({
  environment,
  threadId,
  assignment,
}: {
  environment: FactoryEnvironmentView;
  threadId: ThreadId;
  assignment: FactoryAssignment;
}) {
  if (assignment.kind === "onboarding") return null;
  return (
    <details className="border-b border-border px-4 py-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Assignment oversight · {factoryOversightSummary(assignment)}
      </summary>
      <div className="max-h-96 overflow-y-auto pt-3">
        {threadId !== assignment.threadId ? (
          <ThreadLink environment={environment} threadId={assignment.threadId}>
            Open current implementation lead
          </ThreadLink>
        ) : null}
        <FactoryOversight
          key={`${environment.environmentId}:${assignment.id}`}
          environment={environment}
          assignment={assignment}
        />
      </div>
    </details>
  );
}
