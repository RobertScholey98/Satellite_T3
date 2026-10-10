import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  issueReadyColumnIds,
  type FactoryManager,
  type FactoryProjectImprovementRule,
  type FactorySchedulingConfiguration,
  type IssueBoardSummary,
  type IssueBoardView,
} from "@t3tools/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import type { FactoryEnvironmentView } from "../../state/factory";
import { issuesEnvironment } from "../../state/issues";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useFactoryCommand } from "./useFactoryCommand";

const lines = (value: string) => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];
const relativePath = (value: string) =>
  value.length <= 512 &&
  !/[\\:*?\0]/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export function FactorySchedulingSettings({
  environment,
  manager,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
}) {
  const current = environment.data?.schedulingConfigurations.findLast(
    (entry) => entry.projectId === manager.projectId,
  );
  return (
    <SchedulingForm
      key={`${environment.environmentId}:${manager.projectId}:${current?.id ?? "new"}`}
      environment={environment}
      manager={manager}
      current={current}
    />
  );
}

function SchedulingForm({
  environment,
  manager,
  current,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  current: FactorySchedulingConfiguration | undefined;
}) {
  const prefix = useId();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, settingsScope && manager.projectId !== null);
  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });
  const openBoard = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [boardId, setBoardId] = useState(current?.boardId ?? "");
  const [capacity, setCapacity] = useState<number | null>(current?.maxConcurrentAssignments ?? 1);
  const [boards, setBoards] = useState<readonly IssueBoardSummary[]>([]);
  const [boardView, setBoardView] = useState<IssueBoardView | null>(null);
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const [loadingBoards, setLoadingBoards] = useState(false);
  const [useRule, setUseRule] = useState(
    current?.improvementRule !== null && current?.improvementRule !== undefined,
  );
  const rule = current?.improvementRule;
  const [sourcePaths, setSourcePaths] = useState(rule?.allowedSourcePaths.join("\n") ?? "");
  const [directories, setDirectories] = useState(rule?.creatableDirectories.join("\n") ?? "");
  const [protectedPaths, setProtectedPaths] = useState(rule?.protectedPaths.join("\n") ?? "");
  const [complexities, setComplexities] = useState<
    FactoryProjectImprovementRule["allowedComplexities"]
  >(rule?.allowedComplexities ?? ["small"]);
  const [causes, setCauses] = useState<FactoryProjectImprovementRule["allowedCauses"]>(
    rule?.allowedCauses ?? ["project"],
  );
  const [reason, setReason] = useState(rule?.reason ?? "");
  const [approvedRule, setApprovedRule] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const generation = useRef(0);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const ruleIdentity = useRef<{ signature: string; id: string } | null>(null);
  const error = validation ?? command.error;
  const disabled = command.disabled || loadingBoards;
  const paths = lines(protectedPaths);
  const nextRule = {
    allowedSourcePaths: lines(sourcePaths),
    creatableDirectories: lines(directories),
    protectedPaths: paths,
    allowedComplexities: complexities,
    allowedCauses: causes,
    reason: reason.trim(),
  };
  const ruleSignature = JSON.stringify(nextRule);
  const policy = { ...environment.data?.defaults, ...manager.overrides };
  const readyColumns = boardView?.board.mapping ? issueReadyColumnIds(boardView.board.mapping) : [];
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const showFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const cause = squashAtomCommandFailure(result);
    setValidation(
      cause instanceof Error ? cause.message : "Could not load connected boards. Try again.",
    );
  };
  const loadBoard = async (id: string, request: number) => {
    if (manager.projectId === null) return;
    const result = await openBoard({
      environmentId: environment.environmentId,
      input: { projectId: manager.projectId, boardId: id, refresh: true },
    });
    if (request !== generation.current) return;
    if (result._tag === "Failure") {
      showFailure(result);
      return;
    }
    setBoardView(result.value);
  };
  const loadBoards = async () => {
    if (disabled || manager.projectId === null) return;
    const request = ++generation.current;
    setLoadingBoards(true);
    setValidation(null);
    setBoardView(null);
    try {
      const result = await listBoards({
        environmentId: environment.environmentId,
        input: { projectId: manager.projectId, connectedOnly: true },
      });
      if (request !== generation.current) return;
      if (result._tag === "Failure") {
        showFailure(result);
        return;
      }
      setBoards(result.value);
      setBoardsLoaded(true);
      if (boardId && result.value.some((board) => board.id === boardId))
        await loadBoard(boardId, request);
    } finally {
      if (request === generation.current) setLoadingBoards(false);
    }
  };
  const chooseBoard = async (id: string | null) => {
    if (!id || disabled) return;
    const request = ++generation.current;
    setBoardId(id);
    setBoardView(null);
    setLoadingBoards(true);
    setValidation(null);
    try {
      await loadBoard(id, request);
    } finally {
      if (request === generation.current) setLoadingBoards(false);
    }
  };
  const save = async () => {
    if (
      disabled ||
      manager.projectId === null ||
      !readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)
    )
      return;
    setValidation(null);
    if (!boardId || (enabled && (!boardView || !readyColumns.length))) {
      setValidation(
        "Load a connected board with an existing Ready mapping before enabling scheduling.",
      );
      return;
    }
    if (capacity === null || !Number.isInteger(capacity) || capacity < 1 || capacity > 20) {
      setValidation("Choose a concurrent assignment limit from 1 to 20.");
      return;
    }
    let improvementRule: FactoryProjectImprovementRule | null = null;
    if (useRule) {
      if (
        [...nextRule.allowedSourcePaths, ...nextRule.creatableDirectories, ...paths].some(
          (path) => !relativePath(path),
        )
      ) {
        setValidation(
          "Use exact project-relative paths, one per line, with forward slashes and no wildcards or parent traversal.",
        );
        return;
      }
      if (!complexities.length || !causes.length || !reason.trim() || reason.trim().length > 6000) {
        setValidation(
          "The improvement rule needs at least one complexity and cause, and a reason of at most 6,000 characters.",
        );
        return;
      }
      if (enabled && paths.length && approvedRule !== ruleSignature) {
        setValidation("Explicitly acknowledge the protected-control authority before saving.");
        return;
      }
      const oldSignature = rule
        ? JSON.stringify({
            allowedSourcePaths: rule.allowedSourcePaths,
            creatableDirectories: rule.creatableDirectories,
            protectedPaths: rule.protectedPaths,
            allowedComplexities: rule.allowedComplexities,
            allowedCauses: rule.allowedCauses,
            reason: rule.reason,
          })
        : null;
      if (ruleIdentity.current?.signature !== ruleSignature)
        ruleIdentity.current = {
          signature: ruleSignature,
          id: oldSignature === ruleSignature && rule ? rule.id : randomUUID(),
        };
      improvementRule = { ...nextRule, id: ruleIdentity.current.id };
    }
    await command.submit({
      type: "project.scheduling.configure",
      projectId: manager.projectId,
      boardId,
      enabled,
      maxConcurrentAssignments: capacity,
      improvementRule,
    });
  };
  const pathField = (
    id: string,
    title: string,
    value: string,
    change: (value: string) => void,
    help: string,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`${prefix}-${id}`}>{title}</Label>
      <Textarea
        id={`${prefix}-${id}`}
        rows={3}
        value={value}
        disabled={disabled}
        onChange={(event) => change(event.target.value)}
        spellCheck={false}
        aria-describedby={`${prefix}-${id}-help`}
      />
      <p id={`${prefix}-${id}-help`} className="text-xs text-muted-foreground">
        {help}
      </p>
    </div>
  );
  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      aria-labelledby={`${prefix}-heading`}
      aria-busy={command.pending || loadingBoards}
    >
      <h3 id={`${prefix}-heading`} className="text-sm font-medium">
        Project work scheduling
      </h3>
      <p className="text-sm text-muted-foreground">
        Allow this manager to commission work from a connected board’s existing Ready columns after
        preparing its scope. Capacity, dependencies, project controls and the approved execution
        boundary still apply. PR approval follows the assignment’s delivery policy.
      </p>
      <p className="text-xs text-muted-foreground">
        {current
          ? `Saved ${current.approvedAt} · scheduling ${current.enabled ? "enabled" : "disabled"}`
          : "Not configured. No automatic scheduling is authorized."}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={enabled} disabled={disabled} onCheckedChange={setEnabled} />
        Enable project work scheduling
      </label>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void loadBoards()}>
        {loadingBoards ? "Checking boards…" : "Load connected boards"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Connect a board and configure its Ready columns in the project’s Issues view. This setting
        uses that mapping.
      </p>
      {boardsLoaded && !boards.length ? (
        <p role="status" className="text-sm text-muted-foreground">
          No connected boards are available for this project.
        </p>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-board`}>Board to schedule from</Label>
        <Select
          value={boardId || null}
          disabled={disabled || !boards.length}
          items={boards.map((board) => ({ value: board.id, label: board.title }))}
          onValueChange={(value) => void chooseBoard(value)}
        >
          <SelectTrigger id={`${prefix}-board`}>
            <SelectValue
              placeholder={boardId ? "Saved board — load to view" : "Choose a connected board"}
            />
          </SelectTrigger>
          <SelectPopup>
            {boards.map((board) => (
              <SelectItem key={board.id} value={board.id}>
                {board.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {boardView ? (
          <p role="status" className="text-xs text-muted-foreground">
            {readyColumns.length
              ? `Ready columns: ${readyColumns.map((id) => boardView.columns.find((column) => column.id === id)?.title ?? id).join(", ")}`
              : "This board has no Ready mapping. Configure it in Issues before enabling scheduling."}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-capacity`}>Maximum concurrent assignments</Label>
        <NumberField
          id={`${prefix}-capacity`}
          min={1}
          max={20}
          step={1}
          value={capacity}
          disabled={disabled}
          onValueChange={setCapacity}
        >
          <NumberFieldGroup>
            <NumberFieldInput />
          </NumberFieldGroup>
        </NumberField>
        <p className="text-xs text-muted-foreground">
          New work waits when this project is at capacity. Lowering the limit does not cancel
          existing work.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={useRule} disabled={disabled} onCheckedChange={setUseRule} />
        Authorize a bounded project improvement rule
      </label>
      <p className="text-xs text-muted-foreground">
        This rule can authorize project retro tickets while they remain in triage, if the manager’s
        project-improvement autonomy permits scheduling. Moving a ticket to Ready authorizes
        ordinary scheduling through the board. Shared workflow changes still require your review.
      </p>
      {useRule ? (
        <div className="space-y-3 border-l border-border pl-3">
          {policy.projectImprovements !== "project-rule" ? (
            <p role="status" className="text-sm text-muted-foreground">
              The manager currently creates tickets only. To schedule matching improvements, also
              select “Schedule by project rule” in manager autonomy.
            </p>
          ) : null}
          {pathField(
            "source",
            "Allowed source files",
            sourcePaths,
            setSourcePaths,
            "Exact existing project-relative files, one per line. Empty grants no existing source files.",
          )}
          {pathField(
            "directories",
            "Directories for new files",
            directories,
            setDirectories,
            "Finite project-relative directories, one per line. The approved project boundary must also allow them.",
          )}
          <fieldset disabled={disabled} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Allowed task complexity</legend>
            {(["small", "standard", "complex"] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={complexities.includes(value)}
                  onCheckedChange={(checked) =>
                    setComplexities((previous) =>
                      checked ? [...previous, value] : previous.filter((entry) => entry !== value),
                    )
                  }
                />
                {value === "small" ? "Small" : value === "standard" ? "Standard" : "Complex"}
              </label>
            ))}
          </fieldset>
          <fieldset disabled={disabled} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Eligible causes</legend>
            {(["implementation", "project"] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={causes.includes(value)}
                  onCheckedChange={(checked) =>
                    setCauses((previous) =>
                      checked ? [...previous, value] : previous.filter((entry) => entry !== value),
                    )
                  }
                />
                {value === "implementation"
                  ? "A mistake in an implementation"
                  : "A project convention or safeguard"}
              </label>
            ))}
          </fieldset>
          {pathField(
            "protected",
            "Protected controls allowed in separate tasks",
            protectedPaths,
            setProtectedPaths,
            "Optional exact protected paths, one per line. Ordinary feature work receives no permission to change these controls.",
          )}
          {paths.length ? (
            <>
              <p className="text-sm text-muted-foreground">
                This grants only a separately scoped rule-change task permission to change the
                listed controls. The manager must also have rule-weakening authorization enabled.{" "}
                {policy.authorizeRuleWeakening
                  ? "That manager permission is currently enabled."
                  : "That manager permission is currently disabled."}
              </p>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={approvedRule === ruleSignature}
                  disabled={disabled}
                  onCheckedChange={(checked) => setApprovedRule(checked ? ruleSignature : null)}
                />
                I authorize separate project improvement tasks to change only these listed protected
                controls.
              </label>
            </>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-reason`}>Reason for granting this improvement rule</Label>
            <Textarea
              id={`${prefix}-reason`}
              value={reason}
              rows={3}
              maxLength={6000}
              disabled={disabled}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
      ) : null}
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void save()}>
        {command.pending ? "Saving scheduling…" : "Save scheduling permissions"}
      </Button>
      {!settingsScope || !environment.canOperate ? (
        <p role="status" className="text-sm text-muted-foreground">
          Both settings and operate permission are required to change scheduling.
        </p>
      ) : null}
      {error ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
