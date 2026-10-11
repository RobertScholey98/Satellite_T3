import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  CommandId,
  type FactoryAssignment,
  type FactoryControl,
  type FactoryControlCommand,
  type FactoryManager,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useId, useMemo, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useThreadShell, useThreadShellsForProjectRefs } from "../../state/entities";
import {
  factoryEnvironment,
  useFactoryEnvironments,
  type FactoryEnvironmentView,
} from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
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
import {
  factoryAssignmentCancellation,
  factoryAssignmentStatus,
  factoryLatestThreadGuidance,
  factoryManagerPause,
  factoryPauseStatus,
  factoryProjectPause,
  factoryThreadMembership,
} from "./FactoryControlsReadModel";

type ControlInput = FactoryControlCommand extends infer Command
  ? Command extends FactoryControlCommand
    ? Omit<Command, "commandId">
    : never
  : never;

function useFactoryControlCommand(environment: FactoryEnvironmentView) {
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submissions = useRef(new Map<string, CommandId>());
  const syncing = revision > (environment.data?.revision ?? 0);
  const disabled = pending || syncing || !environment.connected || !environment.canOperate;
  const submit = async (command: ControlInput) => {
    if (inFlight.current || disabled) return false;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const content = JSON.stringify(command);
    const commandId = submissions.current.get(content) ?? CommandId.make(randomUUID());
    submissions.current.set(content, commandId);
    try {
      const result = await dispatch({
        environmentId: environment.environmentId,
        input: { command: { ...command, commandId } },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error ? cause.message : "Could not save this control. Try again.",
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
  return { submit, disabled, pending: pending || syncing, error };
}

function ControlFeedback({
  environment,
  command,
}: {
  environment: FactoryEnvironmentView;
  command: ReturnType<typeof useFactoryControlCommand>;
}) {
  return (
    <>
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
      {command.pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Updating controls…
        </p>
      ) : null}
      {!environment.connected ? (
        <p className="text-xs text-muted-foreground">
          Reconnect to {environment.label} to change controls.
        </p>
      ) : null}
      {!environment.canOperate ? (
        <p className="text-xs text-muted-foreground">
          This connection cannot change agent controls.
        </p>
      ) : null}
    </>
  );
}

export function FactoryManagerControls({
  environment,
  manager,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
}) {
  const command = useFactoryControlCommand(environment);
  const canRetire = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const reasonId = useId();
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [retireReason, setRetireReason] = useState("");
  const controls = environment.data?.controls;
  if (!controls) return null;
  const managerPause = factoryManagerPause(environment.data, manager.id);
  const projectPause = factoryProjectPause(environment.data, manager.projectId);
  const system = manager.role === "system";
  const reasonMissing = system && !retireReason.trim();
  if (manager.status === "retired")
    return (
      <div className="space-y-2" aria-busy={command.pending}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{system ? "System manager" : "Manager"}</h3>
          <Badge variant="secondary">Retired</Badge>
          {managerPause?.stop.status === "failed" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={command.disabled}
              onClick={() =>
                void command.submit({
                  type: "control.retry",
                  controlId: managerPause.id,
                  generation: managerPause.generation,
                })
              }
            >
              Retry stop
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {system
            ? "This system manager and its shared teams are stopped. Investigations, proposals and decisions stay readable. Create a new system manager from the sidebar; it takes over shared repositories and pending evidence."
            : "This manager and its teams are stopped. Their threads and evidence stay readable. Create a new manager in project settings to manage this project again."}
        </p>
        {manager.retiredReason ? (
          <p className="whitespace-pre-wrap text-sm">Reason: {manager.retiredReason}</p>
        ) : null}
        <ControlFeedback environment={environment} command={command} />
      </div>
    );
  return (
    <div className="space-y-4" aria-busy={command.pending}>
      <PauseControl
        label="Manager"
        description={
          manager.role === "system"
            ? "Stops shared investigations and evidence delivery. Project managers and their teams continue."
            : "Stops new assignments and manager coordination. Existing teams can continue within their grants."
        }
        control={managerPause}
        disabled={command.disabled}
        onPause={() => void command.submit({ type: "manager.pause", managerId: manager.id })}
        onResume={() => void command.submit({ type: "manager.resume", managerId: manager.id })}
        onRetry={(control) =>
          void command.submit({
            type: "control.retry",
            controlId: control.id,
            generation: control.generation,
          })
        }
      />
      {manager.projectId !== null ? (
        <PauseControl
          label="Project"
          description="Stops this project's manager and managed teams. Work is preserved; other threads continue independently."
          control={projectPause}
          disabled={command.disabled}
          onPause={() => {
            if (manager.projectId !== null)
              void command.submit({ type: "project.pause", projectId: manager.projectId });
          }}
          onResume={() => {
            if (manager.projectId !== null)
              void command.submit({ type: "project.resume", projectId: manager.projectId });
          }}
          onRetry={(control) =>
            void command.submit({
              type: "control.retry",
              controlId: control.id,
              generation: control.generation,
            })
          }
        />
      ) : null}
      {manager.wait ? (
        <p role="status" className="text-sm text-muted-foreground">
          Existing manager wait: {manager.wait.reason}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Resuming one control keeps other pauses, takeovers, approval waits, and current permissions
        in force.
      </p>
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Retire</h3>
          {confirmRetire ? (
            <>
              <Button
                size="xs"
                variant="destructive"
                disabled={command.disabled || !canRetire || reasonMissing}
                onClick={() =>
                  void command.submit({
                    type: "manager.retire",
                    managerId: manager.id,
                    ...(system ? { reason: retireReason.trim() } : {}),
                  })
                }
              >
                {system ? "Retire system manager" : "Retire manager"}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirmRetire(false)}>
                Keep manager
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={command.disabled || !canRetire}
              onClick={() => setConfirmRetire(true)}
            >
              {system ? "Retire system manager…" : "Retire manager…"}
            </Button>
          )}
        </div>
        {confirmRetire && system ? (
          <div className="space-y-1">
            <Label htmlFor={reasonId}>Reason (required)</Label>
            <Textarea
              id={reasonId}
              value={retireReason}
              onChange={(event) => setRetireReason(event.target.value)}
              disabled={command.disabled}
            />
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {system
            ? "Stops the system manager and cancels its unfinished shared teams. Investigations, proposals and decisions stay readable. A new system manager takes over shared repositories and pending evidence. A retired manager cannot be resumed."
            : "Stops this manager and cancels its unfinished teams. Threads and evidence stay readable, and the project can get a new manager. A retired manager cannot be resumed."}
        </p>
        {!canRetire ? (
          <p className="text-xs text-muted-foreground">
            Retiring a manager needs permission to change settings.
          </p>
        ) : null}
      </section>
      <ControlFeedback environment={environment} command={command} />
    </div>
  );
}

type Pause = Extract<FactoryControl, { kind: "manager-pause" | "project-pause" }>;

function PauseControl({
  label,
  description,
  control,
  disabled,
  onPause,
  onResume,
  onRetry,
}: {
  label: string;
  description: string;
  control: Pause | undefined;
  disabled: boolean;
  onPause: () => void;
  onResume: () => void;
  onRetry: (control: Pause) => void;
}) {
  const failure =
    control?.resume?.status === "failed"
      ? control.resume.detail
      : control?.stop.status === "failed"
        ? control.stop.detail
        : null;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        {control ? (
          <Badge variant={failure ? "error" : "warning"}>{factoryPauseStatus(control)}</Badge>
        ) : null}
        {!control ? (
          <Button size="xs" variant="outline" disabled={disabled} onClick={onPause}>
            Pause {label.toLowerCase()}
          </Button>
        ) : (
          <>
            {failure ? (
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => onRetry(control)}
              >
                Retry {control.resume ? "resume" : "stop"}
              </Button>
            ) : null}
            {/* A failed stop can still be released; a failed resume is retried instead. */}
            {control.resume?.status === "failed" ? null : (
              <Button
                size="xs"
                variant="outline"
                disabled={
                  disabled ||
                  control.stop.status === "pending" ||
                  control.resume?.status === "pending"
                }
                onClick={onResume}
              >
                Resume {label.toLowerCase()}
              </Button>
            )}
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure} This pause remains in force until the control is resolved.
        </p>
      ) : null}
      {control?.stop.status === "pending" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Stop requested. Waiting for running agents to stop.
        </p>
      ) : null}
    </section>
  );
}

export function FactoryManagerControlsDialog({
  environment,
  manager,
  onClose,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{manager.name} controls</DialogTitle>
          <DialogDescription>
            Manager and project pauses are separate. {environment.label}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <FactoryManagerControls environment={environment} manager={manager} />
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

export function FactoryAssignmentControls({
  environment,
  assignment,
  threadId,
}: {
  environment: FactoryEnvironmentView;
  assignment: FactoryAssignment;
  threadId?: ThreadId;
}) {
  const command = useFactoryControlCommand(environment);
  const [reasonRequested, setReasonRequested] = useState(false);
  const controls = environment.data?.controls;
  if (!controls) return null;
  const cancellation = factoryAssignmentCancellation(environment.data, assignment);
  const retro = environment.data?.retros.find(
    (entry) => entry.threadId === threadId && entry.assignmentId === assignment.id,
  );
  const activeRetro =
    retro !== undefined && retro.reports.phase !== "complete" && retro.execution.status === "ready";
  const activeImplementation =
    !retro &&
    !cancellation &&
    assignment.status !== "complete" &&
    (assignment.completion === undefined || assignment.completion.phase === "collecting");
  const takeover = controls.find(
    (control) =>
      control.kind === "takeover" && control.threadId === threadId && control.status === "active",
  );
  const stopped = cancellation?.stop.status === "confirmed";
  const reasonNeeded = stopped && cancellation.reason === undefined;
  const cancel = () => {
    setReasonRequested(true);
    void command.submit({ type: "assignment.cancel", assignmentId: assignment.id });
  };
  return (
    <section className="space-y-2" aria-label="Assignment controls" aria-busy={command.pending}>
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className="text-xs text-muted-foreground">
          {retro
            ? `Retro · ${retro.reports.phase}`
            : factoryAssignmentStatus(environment.data, assignment)}
        </span>
        {threadId && (takeover || activeRetro || activeImplementation) ? (
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled}
            onClick={() =>
              void command.submit({
                type: takeover ? "thread.handback" : "thread.takeover",
                threadId,
              })
            }
          >
            {takeover ? "Hand back thread" : "Take over thread"}
          </Button>
        ) : null}
        {activeImplementation ? (
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={command.disabled}
            onClick={cancel}
          >
            Cancel assignment
          </Button>
        ) : null}
        {cancellation?.stop.status === "failed" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled}
            onClick={() =>
              void command.submit({
                type: "control.retry",
                controlId: cancellation.id,
                generation: cancellation.generation,
              })
            }
          >
            Retry cancellation stop
          </Button>
        ) : null}
        {reasonNeeded ? (
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled}
            onClick={() => setReasonRequested(true)}
          >
            Add reason
          </Button>
        ) : null}
      </div>
      {takeover && (activeImplementation || activeRetro) ? (
        <p className="text-xs text-muted-foreground">
          You direct this thread. Parent instructions wait until handback; its scope and permissions
          stay the same.
        </p>
      ) : null}
      {threadId && !takeover && (activeImplementation || activeRetro) ? (
        <p className="text-xs text-muted-foreground">
          Messages are guidance; parent coordination continues. Takeover is an explicit choice.
        </p>
      ) : null}
      {assignment.wait && !retro ? (
        <p role="status" className="text-xs text-muted-foreground">
          Existing wait: {assignment.wait.reason}
        </p>
      ) : null}
      {cancellation?.stop.status === "pending" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Cancellation requested. Waiting for the team to stop before asking for your reason.
        </p>
      ) : null}
      {cancellation?.stop.status === "failed" ? (
        <p role="alert" className="text-sm text-destructive">
          {cancellation.stop.detail} Cancellation remains in force, but the team's stop is not
          confirmed.
        </p>
      ) : null}
      {stopped && !retro ? (
        <p className="text-xs text-muted-foreground">
          The team has stopped. Work and evidence are preserved.
          {reasonNeeded ? " Your reason is still needed for the retrospective." : ""}
        </p>
      ) : null}
      {cancellation?.reason ? (
        <p className="whitespace-pre-wrap text-sm">Reason: {cancellation.reason.text}</p>
      ) : null}
      <ControlFeedback environment={environment} command={command} />
      {reasonRequested && reasonNeeded ? (
        <CancellationReasonDialog
          environment={environment}
          assignment={assignment}
          onClose={() => setReasonRequested(false)}
        />
      ) : null}
    </section>
  );
}

function CancellationReasonDialog({
  environment,
  assignment,
  onClose,
}: {
  environment: FactoryEnvironmentView;
  assignment: FactoryAssignment;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [reason, setReason] = useState("");
  const command = useFactoryControlCommand(environment);
  const save = async () => {
    if (!reason.trim()) return;
    if (
      await command.submit({
        type: "assignment.cancellation-reason",
        assignmentId: assignment.id,
        reason: reason.trim(),
      })
    )
      onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !command.pending && onClose()}>
      <DialogPopup showCloseButton={!command.pending}>
        <DialogHeader>
          <DialogTitle>Why was this assignment cancelled?</DialogTitle>
          <DialogDescription>
            The team has stopped. Your explanation adds context to the retrospective; cancellation
            does not imply an engineering failure.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <Label htmlFor={fieldId}>Reason (required)</Label>
            <Textarea
              id={fieldId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={command.disabled}
            />
            <ControlFeedback environment={environment} command={command} />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={command.pending} onClick={onClose}>
            Add later
          </Button>
          <Button disabled={command.disabled || !reason.trim()} onClick={() => void save()}>
            Save reason
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function FactoryThreadControls({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environments = useFactoryEnvironments();
  const thread = useThreadShell(threadRef);
  const environment = environments.find((entry) => entry.environmentId === threadRef.environmentId);
  if (
    !thread ||
    !environment?.data?.controls ||
    !environment.data.managers.some((manager) => manager.projectId === thread.projectId)
  )
    return null;
  return (
    <ManagedThreadControls
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      environment={environment}
      thread={thread}
      threadRef={threadRef}
    />
  );
}

function ManagedThreadControls({
  environment,
  thread,
  threadRef,
}: {
  environment: FactoryEnvironmentView;
  thread: EnvironmentThreadShell;
  threadRef: ScopedThreadRef;
}) {
  const projectRefs = useMemo(
    () => [{ environmentId: environment.environmentId, projectId: thread.projectId }],
    [environment.environmentId, thread.projectId],
  );
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const membership = environment.data
    ? factoryThreadMembership(environment.data, threadRef, threads)
    : null;
  if (!membership) return null;
  const { manager, assignment, auxiliary, ancestorThreadIds } = membership;
  const controls = environment.data?.controls ?? [];
  const ancestorTakeover = controls.some(
    (control) =>
      control.kind === "takeover" &&
      control.status === "active" &&
      ancestorThreadIds.includes(control.threadId),
  );
  const managerPause = factoryManagerPause(environment.data, manager.id);
  const projectPause = factoryProjectPause(environment.data, manager.projectId);
  return (
    <div
      className="space-y-2 border-b border-border px-4 py-2"
      aria-label="Managed thread controls"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">
          {assignment
            ? `${auxiliary?.kind === "retrospective" ? "Retrospective lead" : auxiliary?.kind === "delivery-review" ? "Independent reviewer" : auxiliary?.kind === "diagnosis" ? "Recovery diagnosis" : assignment.threadId === thread.id ? "Implementation lead" : "Team member"} · ${manager.name}`
            : manager.name}
        </span>
        {managerPause ? (
          <Badge size="sm" variant="warning">
            Manager: {factoryPauseStatus(managerPause)}
          </Badge>
        ) : null}
        {projectPause ? (
          <Badge size="sm" variant="warning">
            Project: {factoryPauseStatus(projectPause)}
          </Badge>
        ) : null}
      </div>
      {assignment ? (
        <FactoryAssignmentControls
          environment={environment}
          assignment={assignment}
          threadId={thread.id}
        />
      ) : null}
      {assignment &&
      auxiliary?.kind !== "retrospective" &&
      assignment.outcome === undefined &&
      assignment.status !== "complete" &&
      (assignment.completion === undefined || assignment.completion.phase === "collecting") ? (
        <GuidanceEscalation environment={environment} threadId={thread.id} />
      ) : null}
      {ancestorTakeover ? (
        <p className="text-xs text-muted-foreground">
          An ancestor thread is under your direction; its takeover also remains in force.
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Manager and project controls
        </summary>
        <div className="pt-3">
          <FactoryManagerControls environment={environment} manager={manager} />
        </div>
      </details>
    </div>
  );
}

/** Sends the human's latest message in this thread to the manager as a scope or priority decision. */
function GuidanceEscalation({
  environment,
  threadId,
}: {
  environment: FactoryEnvironmentView;
  threadId: ThreadId;
}) {
  const fieldId = useId();
  const command = useFactoryControlCommand(environment);
  const [summary, setSummary] = useState<string | null>(null);
  const guidance = factoryLatestThreadGuidance(environment.data, threadId);
  if (!guidance) return null;
  if (guidance.escalation)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Sent to manager: {guidance.escalation.summary}
      </p>
    );
  const send = async () => {
    const text = summary?.trim();
    if (!text) return;
    if (
      await command.submit({
        type: "guidance.escalate",
        threadId,
        messageId: guidance.messageId,
        summary: text,
      })
    )
      setSummary(null);
  };
  return (
    <section className="space-y-2" aria-label="Send guidance to manager">
      {summary === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled}
            onClick={() => setSummary("")}
          >
            Send to manager…
          </Button>
          <span className="text-xs text-muted-foreground">
            Use this when your latest message changes scope or priority.
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={fieldId}>What should the manager decide?</Label>
          <Textarea
            id={fieldId}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            disabled={command.disabled}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              disabled={command.disabled || !summary.trim()}
              onClick={() => void send()}
            >
              Send to manager
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setSummary(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}
