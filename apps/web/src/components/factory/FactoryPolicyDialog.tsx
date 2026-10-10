import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  CommandId,
  type FactoryAssignmentId,
  type FactoryManager,
  type FactoryPolicy,
  type FactoryPolicyOverrides,
} from "@t3tools/contracts";
import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { randomUUID } from "../../lib/utils";
import { factoryEnvironment, type FactoryEnvironmentView } from "../../state/factory";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";

const deliveryLabels = ["Human approval", "Merge by project rule"] as const;
const improvementLabels = ["Create tickets", "Schedule by project rule"] as const;
const policyLabels = {
  delivery: "delivery",
  projectImprovements: "project improvements",
  sharedWorkflow: "shared workflow",
  authorizeRuleWeakening: "rule-weakening authorization",
  recoveryCycles: "recovery cycles",
} satisfies Record<keyof FactoryPolicy, string>;

function policySignature(policy: FactoryPolicyOverrides) {
  return JSON.stringify([
    policy.delivery,
    policy.projectImprovements,
    policy.sharedWorkflow,
    policy.authorizeRuleWeakening,
    policy.recoveryCycles,
  ]);
}

function hasPolicyIncrease(granted: FactoryPolicy, current: FactoryPolicy) {
  return (
    (granted.delivery === "human-approval" && current.delivery === "project-rule") ||
    (granted.projectImprovements === "create-tickets" &&
      current.projectImprovements === "project-rule") ||
    (!granted.authorizeRuleWeakening && current.authorizeRuleWeakening) ||
    granted.recoveryCycles < current.recoveryCycles
  );
}

function describePolicy(policy: FactoryPolicy) {
  return `${deliveryLabels[policy.delivery === "project-rule" ? 1 : 0]}; ${improvementLabels[policy.projectImprovements === "project-rule" ? 1 : 0]}; rule-weakening authorization ${policy.authorizeRuleWeakening ? "on" : "off"}; ${policy.recoveryCycles} recovery cycles`;
}

export function FactoryPolicyDialog({
  environment,
  manager,
  onClose,
}: {
  readonly environment: FactoryEnvironmentView;
  readonly manager?: FactoryManager;
  readonly onClose: () => void;
}) {
  const hasSettingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const canConfigure = hasSettingsScope && environment.canOperate;
  const snapshot = environment.data;
  const prefix = useId();
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const [draft, setDraft] = useState<{
    readonly base: string;
    readonly values: FactoryPolicyOverrides;
  } | null>(null);
  const [saved, setSaved] = useState<{
    readonly revision: number;
    readonly values: FactoryPolicyOverrides;
  } | null>(null);
  const [selectedAssignments, setSelectedAssignments] = useState<ReadonlySet<FactoryAssignmentId>>(
    () => new Set(),
  );
  const [pending, setPending] = useState<"save" | "extend" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submission = useRef<{ readonly content: string; readonly commandId: CommandId } | null>(
    null,
  );
  if (!snapshot) return null;

  const persisted = manager?.overrides ?? snapshot.defaults;
  const syncing = saved !== null && snapshot.revision < saved.revision;
  const values = draft?.values ?? (syncing ? saved.values : persisted);
  const effective: FactoryPolicy = { ...snapshot.defaults, ...values };
  const dirty = policySignature(values) !== policySignature(persisted);
  const conflict = draft !== null && draft.base !== policySignature(persisted);
  const disabled = !canConfigure || !environment.connected || pending !== null || syncing;
  const valid = Number.isSafeInteger(effective.recoveryCycles) && effective.recoveryCycles >= 0;
  const activeAssignments = snapshot.assignments.flatMap((assignment) => {
    if (assignment.status === "complete" || (manager && assignment.managerId !== manager.id))
      return [];
    const owner = snapshot.managers.find((entry) => entry.id === assignment.managerId);
    if (!owner) return [];
    const policy: FactoryPolicy = { ...snapshot.defaults, ...owner.overrides };
    return hasPolicyIncrease(assignment.grantedPolicy, policy)
      ? [{ assignment, owner, policy }]
      : [];
  });
  const selectedIds = activeAssignments
    .filter(({ assignment }) => selectedAssignments.has(assignment.id))
    .map(({ assignment }) => assignment.id);

  const edit = <K extends keyof FactoryPolicy>(key: K, value: FactoryPolicy[K] | undefined) => {
    setDraft((current) => {
      const next = { ...(current?.values ?? values), [key]: value };
      if (value === undefined) delete next[key];
      return { base: current?.base ?? policySignature(persisted), values: next };
    });
    setNotice(null);
    setError(null);
  };
  const inheritance = (key: keyof FactoryPolicy) =>
    manager ? (
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${prefix}-${key}-inherit`}
          aria-label={`Follow defaults for ${policyLabels[key]}`}
          checked={values[key] === undefined}
          disabled={disabled}
          onCheckedChange={(checked) => edit(key, checked ? undefined : effective[key])}
        />
        <Label htmlFor={`${prefix}-${key}-inherit`}>Follow defaults</Label>
      </div>
    ) : null;
  const fieldDisabled = (key: keyof FactoryPolicy) =>
    disabled || (manager !== undefined && values[key] === undefined);

  const submit = async (action: "save" | "extend") => {
    if (
      inFlight.current ||
      disabled ||
      conflict ||
      !valid ||
      !readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope) ||
      (action === "save" ? !dirty : dirty || selectedIds.length === 0)
    )
      return;
    inFlight.current = true;
    setPending(action);
    setError(null);
    setNotice(null);
    const command =
      action === "extend"
        ? { type: "assignments.extend-grant" as const, assignmentIds: selectedIds }
        : manager
          ? { type: "manager.configure" as const, managerId: manager.id, overrides: values }
          : { type: "policy.defaults.configure" as const, defaults: effective };
    const content = JSON.stringify(command);
    if (submission.current?.content !== content) {
      submission.current = { content, commandId: CommandId.make(randomUUID()) };
    }
    const result = await dispatch({
      environmentId: environment.environmentId,
      input: { command: { ...command, commandId: submission.current.commandId } },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not update autonomy. Try again.");
    } else {
      submission.current = null;
      if (action === "save") {
        setSaved({ revision: result.value.revision, values });
        setDraft(null);
        setSelectedAssignments(new Set());
        setNotice(
          "Settings saved. Increases apply to new assignments; reductions constrain active work immediately.",
        );
      } else {
        setSelectedAssignments(new Set());
        setNotice(
          "Selected grants extended. Assignment scope and existing approval waits are unchanged.",
        );
      }
    }
    inFlight.current = false;
    setPending(null);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && pending === null && onClose()}>
      <DialogPopup showCloseButton={pending === null}>
        <DialogHeader>
          <DialogTitle>
            {manager ? `${manager.name} autonomy` : "Engineering autonomy defaults"}
          </DialogTitle>
          <DialogDescription>
            {environment.label}.{" "}
            {manager
              ? "Each setting follows the current default unless you keep an explicit override."
              : "Defaults apply to new managers and existing managers without an override for that setting."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
              You own these permissions. Prompts cannot expand them. Increasing autonomy affects new
              assignments; reducing it constrains active work immediately. Existing human approvals
              remain required until you resolve them.
            </p>
            {!canConfigure ? (
              <p role="status" className="text-sm text-muted-foreground">
                This connection needs settings and agent-operation permission to make changes.
              </p>
            ) : null}
            {!environment.connected ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reconnect to {environment.label} to make changes.
              </p>
            ) : null}
            <PolicyField
              id={`${prefix}-delivery`}
              label="Delivery"
              inheritance={inheritance("delivery")}
            >
              <PolicySlider
                id={`${prefix}-delivery`}
                value={effective.delivery === "project-rule" ? 1 : 0}
                labels={deliveryLabels}
                disabled={fieldDisabled("delivery")}
                onChange={(value) =>
                  edit("delivery", value === 1 ? "project-rule" : "human-approval")
                }
              />
              <p id={`${prefix}-delivery-help`} className="text-sm text-muted-foreground">
                {effective.delivery === "human-approval"
                  ? "Teams can implement, verify, review, and prepare PRs. Every PR comes to you for merge approval."
                  : "Teams may merge when approved project rules allow it. Ambiguous eligibility and major UI changes still come to you for PR approval."}
              </p>
            </PolicyField>
            <PolicyField
              id={`${prefix}-improvements`}
              label="Project improvements"
              inheritance={inheritance("projectImprovements")}
            >
              <PolicySlider
                id={`${prefix}-improvements`}
                value={effective.projectImprovements === "project-rule" ? 1 : 0}
                labels={improvementLabels}
                disabled={fieldDisabled("projectImprovements")}
                onChange={(value) =>
                  edit("projectImprovements", value === 1 ? "project-rule" : "create-tickets")
                }
              />
              <p id={`${prefix}-improvements-help`} className="text-sm text-muted-foreground">
                {effective.projectImprovements === "create-tickets"
                  ? "Teams file project findings as triage tickets. Filing a ticket does not authorize implementation."
                  : "Managers may schedule qualifying project follow-ups under approved project rules. Each uses a separate assignment and its delivery permissions."}
              </p>
            </PolicyField>
            <PolicyField
              id={`${prefix}-shared`}
              label="Shared workflow"
              inheritance={inheritance("sharedWorkflow")}
            >
              <Input id={`${prefix}-shared`} value="Investigate and recommend" readOnly />
              <p className="text-sm text-muted-foreground">
                Workflow-wide changes come to you for human review. This setting never grants
                autonomous adoption.
              </p>
            </PolicyField>
            <PolicyField
              id={`${prefix}-weakening`}
              label="Authorize rule weakening"
              inheritance={inheritance("authorizeRuleWeakening")}
            >
              <Switch
                id={`${prefix}-weakening`}
                checked={effective.authorizeRuleWeakening}
                disabled={fieldDisabled("authorizeRuleWeakening")}
                onCheckedChange={(value) => edit("authorizeRuleWeakening", value)}
                aria-describedby={`${prefix}-weakening-help`}
              />
              <p id={`${prefix}-weakening-help`} className="text-sm text-muted-foreground">
                {effective.authorizeRuleWeakening
                  ? "The manager may authorize a separate rule-weakening task within its project remit. Ordinary feature work still cannot weaken safeguards."
                  : "The manager cannot authorize weakening safeguards. Enabling this remains separate from delivery and project-improvement autonomy."}{" "}
                Weakening always requires a separately authorized task.
              </p>
            </PolicyField>
            <PolicyField
              id={`${prefix}-recovery`}
              label="Recovery cycles"
              inheritance={inheritance("recoveryCycles")}
            >
              <div className="max-w-40">
                <NumberField
                  id={`${prefix}-recovery`}
                  value={effective.recoveryCycles}
                  min={0}
                  step={1}
                  disabled={fieldDisabled("recoveryCycles")}
                  onValueChange={(value) => {
                    if (value !== null && Number.isSafeInteger(value) && value >= 0)
                      edit("recoveryCycles", value);
                  }}
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease recovery cycles" />
                    <NumberFieldInput aria-describedby={`${prefix}-recovery-help`} />
                    <NumberFieldIncrement aria-label="Increase recovery cycles" />
                  </NumberFieldGroup>
                </NumberField>
              </div>
              <p id={`${prefix}-recovery-help`} className="text-sm text-muted-foreground">
                Maximum recovery attempts before escalation. Zero means escalate without an
                automatic retry.
              </p>
            </PolicyField>
            {manager ? (
              <p className="text-xs text-muted-foreground">
                An explicit override is kept even when it matches the default. Check “Follow
                defaults” to remove it.
              </p>
            ) : null}
            {conflict ? (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-destructive">
                  These settings changed elsewhere while you were editing. Reload them before
                  saving.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => {
                    setDraft(null);
                    setSaved(null);
                    setError(null);
                  }}
                >
                  Reload current settings
                </Button>
              </div>
            ) : null}
            <Button
              disabled={disabled || !dirty || conflict || !valid}
              onClick={() => void submit("save")}
            >
              {pending === "save"
                ? "Saving..."
                : syncing
                  ? "Syncing saved settings..."
                  : "Save autonomy settings"}
            </Button>
            <section
              className="space-y-3 border-t border-border pt-5"
              aria-labelledby={`${prefix}-active`}
            >
              <h3 id={`${prefix}-active`} className="text-sm font-medium">
                Extend grants to active assignments
              </h3>
              <p className="text-sm text-muted-foreground">
                Choose assignments explicitly to receive increases from saved settings. This never
                expands their task scope, removes execution boundaries, or clears an approval wait.
                Onboarding remains read-only.
              </p>
              {dirty ? (
                <p className="text-xs text-muted-foreground">
                  Save or discard your settings changes before extending grants.
                </p>
              ) : null}
              {activeAssignments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active assignments have additional permissions available.
                </p>
              ) : (
                <div className="space-y-4">
                  {activeAssignments.map(({ assignment, owner, policy }) => (
                    <div key={assignment.id} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`${prefix}-${assignment.id}`}
                          checked={selectedAssignments.has(assignment.id)}
                          disabled={disabled || dirty || conflict}
                          onCheckedChange={(checked) =>
                            setSelectedAssignments((current) => {
                              const next = new Set(current);
                              if (checked) next.add(assignment.id);
                              else next.delete(assignment.id);
                              return next;
                            })
                          }
                        />
                        <Label htmlFor={`${prefix}-${assignment.id}`}>
                          {owner.name} ·{" "}
                          {assignment.title ??
                            (assignment.kind === "onboarding"
                              ? "Project onboarding"
                              : assignment.kind === "rule-change"
                                ? "Rule change"
                                : "Implementation")}
                        </Label>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Current grant: {describePolicy(assignment.grantedPolicy)}.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        After extension: {describePolicy(policy)}.
                      </p>
                      {assignment.wait ? (
                        <p className="text-xs text-muted-foreground">
                          Wait retained: {assignment.wait.reason}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              <Button
                variant="outline"
                disabled={disabled || dirty || conflict || selectedIds.length === 0}
                onClick={() => void submit("extend")}
              >
                {pending === "extend"
                  ? "Extending grants..."
                  : `Extend selected grants (${selectedIds.length})`}
              </Button>
            </section>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {dirty && !syncing ? (
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => {
                setDraft(null);
                setNotice(null);
                setError(null);
              }}
            >
              Discard changes
            </Button>
          ) : null}
          <Button variant="outline" disabled={pending !== null} onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PolicyField({
  id,
  label,
  inheritance,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly inheritance: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {inheritance}
      </div>
      {children}
    </div>
  );
}

function PolicySlider({
  id,
  value,
  labels,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: number;
  readonly labels: readonly [string, string];
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-4 text-xs text-muted-foreground">
        <span>{labels[0]}</span>
        <span>{labels[1]}</span>
      </div>
      <input
        id={id}
        type="range"
        className="settings-slider w-full disabled:opacity-50"
        style={
          {
            "--settings-slider-progress": `${value * 100}%`,
            "--settings-slider-fill-offset": value === 1 ? "-0.5rem" : "0.5rem",
          } as CSSProperties
        }
        min={0}
        max={1}
        step={1}
        value={value}
        disabled={disabled}
        aria-valuetext={labels[value === 1 ? 1 : 0]}
        aria-describedby={`${id}-help`}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <p className="text-sm font-medium">{labels[value === 1 ? 1 : 0]}</p>
    </div>
  );
}
