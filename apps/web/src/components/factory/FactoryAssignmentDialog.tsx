import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  CommandId,
  type FactoryAssignment,
  type FactoryManager,
  type FactoryTaskComplexity,
  type ThreadId,
} from "@t3tools/contracts";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { factoryModelKey, factoryModelLabel } from "./FactoryModelPolicyDialog";

export function FactoryAssignmentDialog({
  environment,
  manager,
  projectTitle,
  threads,
  mode,
  onClose,
}: {
  readonly environment: FactoryEnvironmentView;
  readonly manager: FactoryManager;
  readonly projectTitle: string;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly mode: "commission" | "handover";
  readonly onClose: () => void;
}) {
  const prefix = useId();
  const canChangeRules = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [completionCondition, setCompletionCondition] = useState("");
  const [requiresPullRequest, setRequiresPullRequest] = useState(true);
  const [complexity, setComplexity] = useState<FactoryTaskComplexity>("standard");
  const [kind, setKind] = useState<"implementation" | "rule-change">("implementation");
  const [sourcePaths, setSourcePaths] = useState<readonly string[]>([]);
  const [creatableDirectories, setCreatableDirectories] = useState<readonly string[]>([]);
  const [newSourcePaths, setNewSourcePaths] = useState("");
  const [controlPaths, setControlPaths] = useState<readonly string[]>([]);
  const [modelKey, setModelKey] = useState("automatic");
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const [ruleAcknowledgment, setRuleAcknowledgment] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submission = useRef<{ content: string; commandId: CommandId } | null>(null);
  const snapshot = environment.data;
  const boundary = snapshot?.boundaries.find((entry) => entry.id === manager.boundaryId);
  const approvedModels = manager.modelOverrides?.approvedModels ??
    snapshot?.modelDefaults?.approvedModels ?? [manager.modelSelection];
  const modelSelection = approvedModels.find((model) => factoryModelKey(model) === modelKey);
  const managedIds = new Set([
    ...(snapshot?.managers.map((entry) => entry.threadId) ?? []),
    ...(snapshot?.assignments.map((entry) => entry.threadId) ?? []),
  ]);
  const independentThreads = threads.filter(
    (thread) =>
      thread.environmentId === environment.environmentId &&
      thread.projectId === manager.projectId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      !managedIds.has(thread.id),
  );
  const existingThread = independentThreads.find((thread) => thread.id === threadId);
  const exactNewPaths = newSourcePaths
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  const invalidNewPath = exactNewPaths.find(
    (path) =>
      path.includes("\\") ||
      path.split("/").some((part) => part === ".." || part === "." || part === "") ||
      !boundary?.creatableDirectories.some((directory) => path.startsWith(`${directory}/`)),
  );
  const staleGrant =
    !boundary ||
    sourcePaths.some((path) => !boundary.writablePaths.includes(path)) ||
    creatableDirectories.some((path) => !boundary.creatableDirectories.includes(path)) ||
    (kind === "rule-change" &&
      controlPaths.some((path) => !boundary.protectedPaths.includes(path)));
  const ruleContent = JSON.stringify({ title, description, completionCondition, controlPaths });
  const disabled =
    pending || !environment.connected || !environment.canOperate || manager.status !== "active";
  const canSubmit =
    !disabled &&
    !staleGrant &&
    !invalidNewPath &&
    title.trim() &&
    description.trim() &&
    completionCondition.trim() &&
    approvedModels.length > 0 &&
    (modelKey === "automatic" || modelSelection !== undefined) &&
    (mode !== "handover" || existingThread !== undefined) &&
    (kind !== "rule-change" ||
      (canChangeRules && controlPaths.length > 0 && ruleAcknowledgment === ruleContent));
  const submit = async () => {
    if (
      !canSubmit ||
      inFlight.current ||
      (kind === "rule-change" &&
        !readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope))
    )
      return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const fields = {
      managerId: manager.id,
      title: title.trim(),
      kind,
      complexity,
      scope: {
        description: description.trim(),
        completionCondition: completionCondition.trim(),
        requiresPullRequest,
      },
      sourcePaths: [...new Set([...sourcePaths, ...exactNewPaths])],
      creatableDirectories,
      ...(kind === "rule-change" ? { controlPaths } : {}),
      ...(modelSelection ? { modelSelection } : {}),
    };
    const command =
      mode === "handover" && existingThread
        ? { type: "assignment.handover" as const, threadId: existingThread.id, ...fields }
        : { type: "assignment.commission" as const, ...fields };
    const content = JSON.stringify(command);
    if (submission.current?.content !== content)
      submission.current = { content, commandId: CommandId.make(randomUUID()) };
    const result = await dispatch({
      environmentId: environment.environmentId,
      input: { command: { ...command, commandId: submission.current.commandId } },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not authorize this assignment.");
      inFlight.current = false;
      setPending(false);
      return;
    }
    inFlight.current = false;
    setPending(false);
    onClose();
  };
  const modelItems = [
    { value: "automatic", label: "Automatic · approved role and complexity preference" },
    ...approvedModels.map((model) => ({
      value: factoryModelKey(model),
      label: factoryModelLabel(model),
    })),
  ];
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {mode === "handover" ? "Hand over an existing thread" : "Assign work"}
          </DialogTitle>
          <DialogDescription>
            {manager.name} · {projectTitle} · {environment.label}. Your submission directly
            authorizes this scoped assignment.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            {manager.status !== "active" || !boundary ? (
              <p role="status" className="text-sm text-muted-foreground">
                The manager needs an approved execution boundary and must be active before receiving
                work.
              </p>
            ) : null}
            {!environment.connected ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reconnect to this environment to authorize work.
              </p>
            ) : null}
            {!environment.canOperate ? (
              <p role="status" className="text-sm text-muted-foreground">
                This connection cannot authorize agent work.
              </p>
            ) : null}
            {mode === "handover" ? (
              <section className="space-y-2">
                <Label htmlFor={`${prefix}-thread`}>Independent thread</Label>
                <Select
                  value={threadId}
                  disabled={disabled}
                  items={independentThreads.map((thread) => ({
                    value: thread.id,
                    label: thread.title,
                  }))}
                  onValueChange={(value) => setThreadId(value)}
                >
                  <SelectTrigger id={`${prefix}-thread`}>
                    <SelectValue placeholder="Choose a thread" />
                  </SelectTrigger>
                  <SelectPopup>
                    {independentThreads.map((thread) => (
                      <SelectItem key={thread.id} value={thread.id}>
                        {thread.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-sm text-muted-foreground">
                  Satellite stops active work, captures the thread's current files, and binds this
                  assignment to the same conversation. Existing work and thread identity are
                  preserved. Other threads remain independent.
                </p>
                {independentThreads.length === 0 ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    No independent active threads are available in this project.
                  </p>
                ) : null}
                {existingThread ? (
                  <p className="break-words text-xs text-muted-foreground">
                    Current branch: {existingThread.branch ?? "Detached or not set"}. Workspace:{" "}
                    {existingThread.worktreePath ?? "Project workspace"}.
                  </p>
                ) : null}
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">
                The manager commissions an ordinary implementation lead. That team owns
                implementation, review, verification, and its PR work.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-title`}>Assignment title</Label>
              <Input
                id={`${prefix}-title`}
                value={title}
                disabled={disabled}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-description`}>Scope and intended outcome</Label>
              <Textarea
                id={`${prefix}-description`}
                value={description}
                disabled={disabled}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-completion`}>Completion condition</Label>
              <Textarea
                id={`${prefix}-completion`}
                value={completionCondition}
                disabled={disabled}
                onChange={(event) => setCompletionCondition(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Define what must be true when the work is done, including verification or a concrete
                investigation result.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${prefix}-pr`}
                checked={requiresPullRequest}
                disabled={disabled}
                onCheckedChange={setRequiresPullRequest}
              />
              <Label htmlFor={`${prefix}-pr`}>Requires a pull request</Label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-complexity`}>Task complexity</Label>
                <Select
                  value={complexity}
                  disabled={disabled}
                  items={[
                    { value: "small", label: "Small" },
                    { value: "standard", label: "Standard" },
                    { value: "complex", label: "Complex" },
                  ]}
                  onValueChange={(value) => {
                    if (value) setComplexity(value);
                  }}
                >
                  <SelectTrigger id={`${prefix}-complexity`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="small">Small</SelectItem>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="complex">Complex</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-kind`}>Assignment kind</Label>
                <Select
                  value={kind}
                  disabled={disabled}
                  items={[
                    { value: "implementation", label: "Implementation" },
                    { value: "rule-change", label: "Separate rule change" },
                  ]}
                  onValueChange={(value) => {
                    if (value) setKind(value);
                  }}
                >
                  <SelectTrigger id={`${prefix}-kind`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="implementation">Implementation</SelectItem>
                    <SelectItem value="rule-change">Separate rule change</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-model`}>Lead model</Label>
              <Select
                value={modelKey}
                disabled={disabled || approvedModels.length === 0}
                items={modelItems}
                onValueChange={(value) => {
                  if (value) setModelKey(value);
                }}
              >
                <SelectTrigger id={`${prefix}-model`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {modelItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                Automatic selection uses the saved lead preference for {complexity} tasks, then the
                approved fallback. The chosen model, exact options, and selection reason are
                recorded on the assignment.
              </p>
              {approvedModels.length === 0 ? (
                <p role="status" className="text-sm text-muted-foreground">
                  No models are approved. Configure the model policy before assigning work.
                </p>
              ) : null}
            </div>
            <PathChoices
              id={`${prefix}-source`}
              label="Editable existing files"
              choices={boundary?.writablePaths ?? []}
              selected={sourcePaths}
              disabled={disabled}
              onChange={setSourcePaths}
            />
            <PathChoices
              id={`${prefix}-directories`}
              label="Approved creation directories"
              choices={boundary?.creatableDirectories ?? []}
              selected={creatableDirectories}
              disabled={disabled}
              onChange={setCreatableDirectories}
            />
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-new-paths`}>Exact additional source paths</Label>
              <Textarea
                id={`${prefix}-new-paths`}
                value={newSourcePaths}
                disabled={disabled}
                spellCheck={false}
                onChange={(event) => setNewSourcePaths(event.target.value)}
                aria-describedby={`${prefix}-new-help`}
              />
              <p id={`${prefix}-new-help`} className="text-xs text-muted-foreground">
                Optional, one per line. Each must be inside an approved creation directory. This
                grants an exact path without granting the whole directory. The server validates
                source and protected-file eligibility.
              </p>
              {invalidNewPath ? (
                <p role="alert" className="text-sm text-destructive">
                  Outside approved creation directories or malformed: {invalidNewPath}
                </p>
              ) : null}
            </div>
            {kind === "rule-change" ? (
              <section className="space-y-3 border-t border-border pt-4">
                <PathChoices
                  id={`${prefix}-controls`}
                  label="Protected controls for this separate task"
                  choices={boundary?.protectedPaths ?? []}
                  selected={controlPaths}
                  disabled={disabled || !canChangeRules}
                  onChange={setControlPaths}
                />
                <p className="text-sm text-muted-foreground">
                  This is a separate, explicitly authorized rule-change assignment. Ordinary feature
                  work never gains permission to weaken safeguards.
                </p>
                {!canChangeRules ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Changing protected controls also requires permission to manage this
                    environment's settings.
                  </p>
                ) : null}
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={`${prefix}-rule-ack`}
                    checked={ruleAcknowledgment === ruleContent}
                    disabled={disabled || !canChangeRules || controlPaths.length === 0}
                    onCheckedChange={(checked) =>
                      setRuleAcknowledgment(checked ? ruleContent : null)
                    }
                  />
                  <Label htmlFor={`${prefix}-rule-ack`}>
                    I authorize this separate task to change only the selected protected controls.
                  </Label>
                </div>
              </section>
            ) : null}
            <section className="space-y-1 border-t border-border pt-4">
              <h3 className="text-sm font-medium">Recorded assignment baseline</h3>
              <p className="break-words text-xs text-muted-foreground">
                Workflow: {manager.workflow.repositoryRoot} at {manager.workflow.revision}.
              </p>
              <p className="text-xs text-muted-foreground">
                Source is captured fresh when this assignment is prepared. Approved controls and
                verification gates stay pinned. Current manager autonomy limits are recorded with
                the grant.
              </p>
            </section>
            {staleGrant && boundary ? (
              <p role="alert" className="text-sm text-destructive">
                The boundary changed. Reopen this form and review the current permissions.
              </p>
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
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {pending
              ? "Authorizing..."
              : mode === "handover"
                ? "Hand over selected thread"
                : "Authorize assignment"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function FactoryAssignmentDetailsDialog({
  environment,
  assignment,
  canOpenThread,
  onOpenThread,
  onClose,
}: {
  readonly environment: FactoryEnvironmentView;
  readonly assignment: FactoryAssignment;
  readonly canOpenThread: boolean;
  readonly onOpenThread: () => void;
  readonly onClose: () => void;
}) {
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandId = useRef<CommandId | null>(null);
  const inFlight = useRef(false);
  const retry = async () => {
    if (inFlight.current || !environment.connected || !environment.canOperate) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    commandId.current ??= CommandId.make(randomUUID());
    const result = await dispatch({
      environmentId: environment.environmentId,
      input: {
        command: {
          type: "assignment.retry",
          commandId: commandId.current,
          assignmentId: assignment.id,
        },
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not retry preparation.");
    } else commandId.current = null;
    inFlight.current = false;
    setPending(false);
  };
  const source = assignment.startingSource;
  const grant = assignment.grant;
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{assignment.title ?? "Managed assignment"}</DialogTitle>
          <DialogDescription>
            {assignment.kind} · {assignment.status}
            {assignment.preparation ? ` · ${assignment.preparation}` : ""} · {environment.label}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            {assignment.wait ? (
              <p role="status" className="text-sm text-muted-foreground">
                {assignment.wait.reason}
              </p>
            ) : null}
            {assignment.scope ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Scope</h3>
                <p className="whitespace-pre-wrap text-sm">{assignment.scope.description}</p>
                <h3 className="text-sm font-medium">Completion condition</h3>
                <p className="whitespace-pre-wrap text-sm">
                  {assignment.scope.completionCondition}
                </p>
                <p className="text-xs text-muted-foreground">
                  {assignment.scope.requiresPullRequest
                    ? "A pull request is required."
                    : "No pull request required; the recorded completion condition still applies."}
                </p>
              </section>
            ) : null}
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Lead selection</h3>
              {assignment.modelChoice ? (
                <>
                  <p className="break-words text-sm">
                    {factoryModelLabel(assignment.modelChoice.selection)}
                  </p>
                  <p className="text-sm text-muted-foreground">{assignment.modelChoice.reason}</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Model selection has not been recorded.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Complexity: {assignment.complexity ?? "Not recorded"}.
              </p>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Pinned workflow</h3>
              <p className="break-words text-sm">{assignment.workflow.repositoryRoot}</p>
              <p className="break-all text-xs text-muted-foreground">
                {assignment.workflow.revision}
              </p>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Granted permissions</h3>
              {grant ? (
                <>
                  <ReadOnlyPaths label="Exact source paths" paths={grant.sourcePaths} />
                  <ReadOnlyPaths label="Creation directories" paths={grant.creatableDirectories} />
                  <ReadOnlyPaths
                    label="Separately authorized control changes"
                    paths={grant.controlChange?.paths ?? []}
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The execution grant is not ready yet.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Merge:{" "}
                {assignment.grantedPolicy.delivery === "human-approval"
                  ? "Human approval required"
                  : "Only under approved project rules"}
                . Existing approval waits remain in force.
              </p>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Starting work</h3>
              {source ? (
                <>
                  <p className="text-sm">
                    {source.origin === "handover"
                      ? "Captured from the existing thread"
                      : "Captured from the project workspace"}{" "}
                    · {source.fileCount} files.
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    Branch: {source.branch ?? "Detached"}. Captured: {source.capturedAt}.
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    Revision: {source.revision}
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    Source digest: {source.sourceDigest}
                  </p>
                  <ReadOnlyPaths label="Staged changes" paths={source.stagedPaths} />
                  <ReadOnlyPaths label="Unstaged changes" paths={source.unstagedPaths} />
                  <ReadOnlyPaths label="Untracked files" paths={source.untrackedPaths} />
                  <ReadOnlyPaths label="Deleted paths" paths={source.deletedPaths} />
                  <ReadOnlyPaths label="Excluded paths" paths={source.excludedPaths} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Waiting for source capture. Handover stops active work before capturing and
                  rebinding the same thread.
                </p>
              )}
            </section>
            {assignment.modelPolicy ? (
              <ReadOnlyPaths
                label="Approved team model selections"
                paths={assignment.modelPolicy.approvedModels.map(factoryModelLabel)}
              />
            ) : null}
            {assignment.verification ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Latest recorded verification</h3>
                {assignment.verification.gates.map((gate) => (
                  <details key={gate.id}>
                    <summary className="cursor-pointer text-sm">
                      {gate.id}: {gate.status}
                    </summary>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {gate.output}
                    </pre>
                  </details>
                ))}
              </section>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Close
          </Button>
          {assignment.status === "waiting" && assignment.kind !== "onboarding" ? (
            <Button
              variant="outline"
              disabled={pending || !environment.connected || !environment.canOperate}
              onClick={() => void retry()}
            >
              {pending ? "Retrying..." : "Retry preparation"}
            </Button>
          ) : null}
          <Button disabled={!canOpenThread || pending} onClick={onOpenThread}>
            Open lead thread
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PathChoices({
  id,
  label,
  choices,
  selected,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly choices: readonly string[];
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (paths: readonly string[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      {choices.length === 0 ? (
        <p className="text-xs text-muted-foreground">None available in the approved boundary.</p>
      ) : (
        choices.map((path, index) => (
          <div key={path} className="flex items-start gap-2">
            <Checkbox
              id={`${id}-${index}`}
              checked={selected.includes(path)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(checked ? [...selected, path] : selected.filter((entry) => entry !== path))
              }
            />
            <Label htmlFor={`${id}-${index}`}>{path}</Label>
          </div>
        ))
      )}
    </fieldset>
  );
}

function ReadOnlyPaths({
  label,
  paths,
}: {
  readonly label: string;
  readonly paths: readonly string[];
}) {
  return (
    <details>
      <summary className="cursor-pointer text-sm">
        {label} ({paths.length})
      </summary>
      {paths.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {paths.map((path) => (
            <li key={path} className="break-words text-xs text-muted-foreground">
              {path}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">None.</p>
      )}
    </details>
  );
}
