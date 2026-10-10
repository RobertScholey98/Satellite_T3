import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  CommandId,
  type FactoryBoundaryConfiguration,
  type FactoryGate,
  type FactoryManager,
  type FactoryOnboardingReport,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useRef, useState } from "react";

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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Textarea } from "../ui/textarea";

function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gateDraft(gate?: FactoryGate) {
  return {
    key: randomUUID(),
    id: gate?.id ?? "",
    label: gate?.label ?? "",
    executable: gate?.executable ?? "/usr/local/bin/node",
    args: gate?.args.join("\n") ?? "",
    cwd: gate?.cwd ?? ".",
    timeoutMs: gate?.timeoutMs ?? 60_000,
    protectedInputs: gate?.protectedInputs.join("\n") ?? "",
  };
}

function configurationProblem(configuration: FactoryBoundaryConfiguration) {
  if (configuration.writablePaths.length === 0)
    return "List at least one existing source or test file that assignments may edit.";
  if (configuration.protectedPaths.length === 0)
    return "List the protected check runners and other required control files.";
  if (configuration.gates.length === 0) return "Add at least one required verification check.";
  const ids = new Set<string>();
  for (const [index, gate] of configuration.gates.entries()) {
    const name = gate.label || `Check ${index + 1}`;
    if (!gate.id || !gate.label) return `${name}: enter a name and unique check ID.`;
    if (ids.has(gate.id)) return `${name}: check IDs must be unique.`;
    ids.add(gate.id);
    if (gate.executable !== "/usr/local/bin/node")
      return `${name}: the supported executable is /usr/local/bin/node in the managed runtime.`;
    if (!gate.cwd) return `${name}: enter a working directory; use . for the project root.`;
    if (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs <= 0 || gate.timeoutMs > 300_000)
      return `${name}: timeout must be between 1 and 300000 milliseconds.`;
    if (
      gate.protectedInputs.length === 0 ||
      gate.protectedInputs.some((path) => !configuration.protectedPaths.includes(path))
    )
      return `${name}: every protected input must also appear in Protected control files above.`;
    if (
      !(gate.args.length === 1 || (gate.args.length === 2 && gate.args[0] === "--test")) ||
      !gate.protectedInputs.some((path) => gate.args.at(-1) === `/workspace/${path}`)
    )
      return `${name}: run one protected file at /workspace/<path>, optionally preceded by --test on its own line.`;
  }
  return null;
}

export function FactoryBoundaryDialog({
  environment,
  manager,
  report,
  onClose,
}: {
  readonly environment: FactoryEnvironmentView;
  readonly manager: FactoryManager;
  readonly report: FactoryOnboardingReport;
  readonly onClose: () => void;
}) {
  const prefix = useId();
  const hasSettingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const boundary = environment.data?.boundaries.find((entry) => entry.id === manager.boundaryId);
  const initial = boundary ?? report.proposedBoundary;
  const [protectedPaths, setProtectedPaths] = useState(initial?.protectedPaths.join("\n") ?? "");
  const [writablePaths, setWritablePaths] = useState(initial?.writablePaths.join("\n") ?? "");
  const [creatableDirectories, setCreatableDirectories] = useState(
    initial?.creatableDirectories.join("\n") ?? "",
  );
  const [gates, setGates] = useState(() => initial?.gates.map(gateDraft) ?? [gateDraft()]);
  const [acknowledgedContent, setAcknowledgedContent] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submission = useRef<{ readonly content: string; readonly commandId: CommandId } | null>(
    null,
  );
  const approved = manager.boundaryId !== undefined;
  const canConfigure = hasSettingsScope && environment.canOperate;
  const disabled = approved || pending || !environment.connected || !canConfigure;
  const configuration: FactoryBoundaryConfiguration = {
    protectedPaths: lines(protectedPaths),
    writablePaths: lines(writablePaths),
    creatableDirectories: lines(creatableDirectories),
    gates: gates.map((gate) => ({
      id: gate.id.trim(),
      label: gate.label.trim(),
      executable: gate.executable.trim(),
      args: lines(gate.args),
      cwd: gate.cwd.trim(),
      timeoutMs: gate.timeoutMs,
      protectedInputs: lines(gate.protectedInputs),
    })),
  };
  const problem = configurationProblem(configuration);
  const content = JSON.stringify({ report, configuration });
  const acknowledged = acknowledgedContent === content;
  const updateGate = (key: string, patch: Partial<ReturnType<typeof gateDraft>>) => {
    setGates((current) => current.map((gate) => (gate.key === key ? { ...gate, ...patch } : gate)));
    setError(null);
  };
  const approve = async () => {
    if (
      inFlight.current ||
      disabled ||
      problem ||
      !acknowledged ||
      manager.role !== "project" ||
      !readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)
    )
      return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const command = {
      type: "manager.approve-onboarding" as const,
      managerId: manager.id,
      configuration,
    };
    const commandContent = JSON.stringify(command);
    if (submission.current?.content !== commandContent) {
      submission.current = { content: commandContent, commandId: CommandId.make(randomUUID()) };
    }
    const result = await dispatch({
      environmentId: environment.environmentId,
      input: { command: { ...command, commandId: submission.current.commandId } },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        typeof cause === "object" &&
          cause !== null &&
          "detail" in cause &&
          typeof cause.detail === "string"
          ? cause.detail
          : cause instanceof Error
            ? cause.message
            : "Could not approve the boundary. The manager remains blocked.",
      );
      inFlight.current = false;
      setPending(false);
      return;
    }
    inFlight.current = false;
    setPending(false);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {approved ? "Approved execution boundary" : "Review execution boundary"}
          </DialogTitle>
          <DialogDescription>
            {manager.name} · {environment.label}.{" "}
            {approved
              ? "These permissions and checks form the adopted baseline."
              : "Approve concrete project permissions and checks to finish onboarding."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-6">
            <section className="space-y-2" aria-labelledby={`${prefix}-report`}>
              <h3 id={`${prefix}-report`} className="text-sm font-medium">
                Onboarding findings
              </h3>
              <p className="text-sm text-muted-foreground">{report.summary}</p>
              {report.unresolvedDecisions.length > 0 ? (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Decisions resolved by this approval</h4>
                  <ul className="space-y-3">
                    {report.unresolvedDecisions.map((finding) => (
                      <li key={finding.description} className="space-y-1 text-sm">
                        <p>{finding.description}</p>
                        {finding.evidence.map((evidence) => (
                          <p
                            key={`${evidence.label}:${evidence.location}`}
                            className="break-words text-xs text-muted-foreground"
                          >
                            {evidence.label} · {evidence.location}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {approved && boundary ? (
                <p className="break-words text-xs text-muted-foreground">
                  Adopted source revision: {boundary.sourceRevision}
                </p>
              ) : null}
            </section>
            {!approved && report.proposedBoundary ? (
              <p className="text-sm text-muted-foreground">
                The onboarding team proposed this configuration. Review it before approving.
              </p>
            ) : null}
            {!canConfigure && !approved ? (
              <p role="status" className="text-sm text-muted-foreground">
                Settings and agent-operation permission are required to approve this boundary.
              </p>
            ) : null}
            {!environment.connected && !approved ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reconnect to {environment.label} before approving.
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Use project-relative paths with forward slashes, one per line. Files must exist in the
              committed onboarding snapshot. List exact files; directory-wide editing and wildcard
              grants are not implied.
            </p>
            <PathList
              id={`${prefix}-writable`}
              label="Editable source and test files"
              description="Assignments can receive permission to edit these exact files. Other existing files stay read-only."
              value={writablePaths}
              disabled={disabled}
              onChange={setWritablePaths}
            />
            <PathList
              id={`${prefix}-creatable`}
              label="Directories where files may be created"
              description="Optional. New files in these named directories must go through the controlled file tool. Protected filenames remain protected."
              value={creatableDirectories}
              disabled={disabled}
              onChange={setCreatableDirectories}
            />
            <PathList
              id={`${prefix}-protected`}
              label="Protected control files"
              description="Include check runners and all inputs that define acceptance. Standard instruction, configuration, lock, CI, and permission-control filenames are also protected automatically. Shared skills remain outside assignment write access."
              value={protectedPaths}
              disabled={disabled}
              onChange={setProtectedPaths}
            />
            <section className="space-y-4" aria-labelledby={`${prefix}-checks`}>
              <h3 id={`${prefix}-checks`} className="text-sm font-medium">
                Required verification checks
              </h3>
              <p className="text-sm text-muted-foreground">
                The verifier restores adopted protected inputs before checking the candidate.
                Changes to branch-local controls cannot redefine the approved checks.
              </p>
              <p className="text-xs text-muted-foreground">
                This runtime supports direct Node checks using /usr/local/bin/node. Arguments must
                be a protected runner at /workspace/&lt;path&gt;, or --test followed by a protected
                test file. Each input must appear in Protected control files.
              </p>
              {gates.map((gate, index) => (
                <section
                  key={gate.key}
                  className="space-y-3 border-t border-border pt-4"
                  aria-labelledby={`${prefix}-${gate.key}-heading`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h4 id={`${prefix}-${gate.key}-heading`} className="text-sm font-medium">
                      {gate.label || `Check ${index + 1}`}
                    </h4>
                    {!approved ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled}
                        aria-label={`Remove ${gate.label || `check ${index + 1}`}`}
                        onClick={() =>
                          setGates((current) => current.filter((entry) => entry.key !== gate.key))
                        }
                      >
                        <Trash2Icon aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={`${prefix}-${gate.key}-label`}>Check name</Label>
                      <Input
                        id={`${prefix}-${gate.key}-label`}
                        value={gate.label}
                        disabled={disabled}
                        onChange={(event) => updateGate(gate.key, { label: event.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${prefix}-${gate.key}-id`}>Check ID</Label>
                      <Input
                        id={`${prefix}-${gate.key}-id`}
                        value={gate.id}
                        disabled={disabled}
                        onChange={(event) => updateGate(gate.key, { id: event.target.value })}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${prefix}-${gate.key}-executable`}>
                      Executable in managed runtime
                    </Label>
                    <Input
                      id={`${prefix}-${gate.key}-executable`}
                      value={gate.executable}
                      disabled={disabled}
                      onChange={(event) => updateGate(gate.key, { executable: event.target.value })}
                    />
                  </div>
                  <PathList
                    id={`${prefix}-${gate.key}-args`}
                    label="Arguments"
                    description="One argument per line. For example: --test on one line, then /workspace/tests/acceptance.test.mjs."
                    value={gate.args}
                    disabled={disabled}
                    onChange={(args) => updateGate(gate.key, { args })}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={`${prefix}-${gate.key}-cwd`}>Working directory</Label>
                      <Input
                        id={`${prefix}-${gate.key}-cwd`}
                        value={gate.cwd}
                        disabled={disabled}
                        onChange={(event) => updateGate(gate.key, { cwd: event.target.value })}
                        aria-describedby={`${prefix}-${gate.key}-cwd-help`}
                      />
                      <p
                        id={`${prefix}-${gate.key}-cwd-help`}
                        className="text-xs text-muted-foreground"
                      >
                        Use . for the project root.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${prefix}-${gate.key}-timeout`}>
                        Timeout (milliseconds)
                      </Label>
                      <NumberField
                        id={`${prefix}-${gate.key}-timeout`}
                        value={gate.timeoutMs}
                        disabled={disabled}
                        min={1}
                        max={300_000}
                        step={1000}
                        onValueChange={(timeoutMs) => {
                          if (timeoutMs !== null) updateGate(gate.key, { timeoutMs });
                        }}
                      >
                        <NumberFieldGroup>
                          <NumberFieldInput />
                        </NumberFieldGroup>
                      </NumberField>
                    </div>
                  </div>
                  <PathList
                    id={`${prefix}-${gate.key}-inputs`}
                    label="Protected inputs for this check"
                    description="Project-relative files, including the runner or test above. Each must also be listed in Protected control files."
                    value={gate.protectedInputs}
                    disabled={disabled}
                    onChange={(protectedInputs) => updateGate(gate.key, { protectedInputs })}
                  />
                </section>
              ))}
              {!approved ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => setGates((current) => [...current, gateDraft()])}
                >
                  <PlusIcon aria-hidden />
                  Add check
                </Button>
              ) : null}
            </section>
            {!approved ? (
              <div className="space-y-3 border-t border-border pt-4">
                <p className="text-sm text-muted-foreground">
                  Approval resolves the onboarding decisions shown above. The manager becomes ready
                  only after the server validates and saves the execution baseline. Unsupported or
                  incomplete setup stays blocked.
                </p>
                {problem ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {problem}
                  </p>
                ) : null}
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={`${prefix}-acknowledge`}
                    checked={acknowledged}
                    disabled={disabled || problem !== null}
                    onCheckedChange={(checked) => setAcknowledgedContent(checked ? content : null)}
                  />
                  <Label htmlFor={`${prefix}-acknowledge`}>
                    I approve these permissions and checks, and resolve the onboarding decisions
                    shown above.
                  </Label>
                </div>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {approved ? "Close" : "Cancel"}
          </Button>
          {!approved ? (
            <Button
              disabled={disabled || problem !== null || !acknowledged}
              onClick={() => void approve()}
            >
              {pending ? "Saving boundary..." : "Approve boundary and finish onboarding"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PathList({
  id,
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="none"
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
