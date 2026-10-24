import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type FactoryConfig,
  type FactoryManager,
  type FactoryOnboardingResult,
  issueReadyColumnIds,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { randomUUID } from "~/lib/utils";
import { useEnvironmentProviders } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { issuesEnvironment } from "../work/issuesState";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useFactoryDefinitions } from "./factoryDefinitionsState";
import {
  effectiveManagerCap,
  MANAGER_CAP_MAX,
  managerModelChoices,
  managerSettingsDirty,
  managerSettingsDraft,
  managerSettingsProblem,
  managerSettingsResult,
  toggleSettingsColumn,
  type ManagerSettingsDraft,
} from "./factoryManagerSettings.logic";
import { sameColumn } from "./factoryOnboardingCard.logic";
import { factoryModelOptions } from "./FactoryPageConfig";
import {
  factoryEnvironment,
  factoryErrorMessage,
  unwrapFactoryResult,
  useFactoryManagers,
} from "./factoryState";
import { FACTORY_CARD_CLASS } from "./FactoryThreadStack";

interface ReadyBoard {
  readonly boardId: string;
  readonly title: string;
  readonly readyColumns: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

const modelValue = (model: ModelSelection) => `${model.instanceId}\n${model.model}`;

/** The approved manager's onboarding result and model, to read and edit; nothing before approval. */
export function FactoryManagerSettingsCard(props: {
  readonly environmentId: EnvironmentId;
  readonly managerId: string;
}) {
  const manager = useFactoryManagers(props.environmentId)?.find(
    (entry) => entry.id === props.managerId,
  );
  if (manager === undefined || manager.onboardingResult === null || manager.state === "retired")
    return null;
  return (
    <ManagerSettings
      environmentId={props.environmentId}
      manager={manager}
      result={manager.onboardingResult}
    />
  );
}

function ManagerSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly manager: FactoryManager;
  readonly result: FactoryOnboardingResult;
}) {
  const { environmentId, manager, result } = props;
  const canEdit = useAtomValue(factoryEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(factoryEnvironment.updateSettings, {
    reportFailure: false,
  });
  const getConfig = useAtomCommand(factoryEnvironment.getConfig, { reportFailure: false });
  const definitions = useFactoryDefinitions(environmentId).view;
  const providers = useEnvironmentProviders().get(environmentId);
  const [environment, setEnvironment] = useState<FactoryConfig | null>(null);
  const [draft, setDraft] = useState<ManagerSettingsDraft | null>(null);
  // The version the form was opened at, so a save over a change made meanwhile is refused.
  const [openedAt, setOpenedAt] = useState(manager.updatedAt);
  const [newPath, setNewPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boards = useReadyBoards(
    environmentId,
    manager.projectId,
    draft !== null || result.pickup.columns.length > 0,
  );

  useEffect(() => {
    let current = true;
    void getConfig({ environmentId, input: {} }).then((loaded) => {
      if (current && loaded._tag === "Success") setEnvironment(loaded.value.environment);
    });
    return () => {
      current = false;
    };
  }, [environmentId, getConfig]);

  const paused = manager.state === "manager-paused" || manager.state === "project-paused";
  const teams = definitions?.teams ?? [];
  const models = managerModelChoices(
    definitions?.settings.modelPool ?? [],
    factoryModelOptions(providers ?? []),
    environment?.instancePreferences ?? {},
  );
  const modelLabel = (model: ModelSelection | null) =>
    model === null
      ? "The pool's manager model"
      : (models.find((choice) => modelValue(choice.selection) === modelValue(model))?.label ??
        `${model.model} (${model.instanceId})`);
  const columnLabel = (column: { readonly boardId: string; readonly columnId: string }) => {
    const board = boards?.find((entry) => entry.boardId === column.boardId);
    const title = board?.readyColumns.find((ready) => ready.id === column.columnId)?.title;
    return board === undefined || title === undefined
      ? column.columnId
      : `${title} on ${board.title}`;
  };
  const shown = draft === null ? result : managerSettingsResult(result, draft);
  const cap =
    environment === null
      ? null
      : effectiveManagerCap(shown.concurrencyCap, environment.concurrencyCap);
  const capNote =
    cap === null ? null : (
      <p className="text-2xs text-muted-foreground">
        Runs up to {cap.cap} at once
        {cap.limitedByEnvironment ? `; the environment's cap of ${cap.cap} is the lower one.` : "."}
        {draft !== null && manager.activeAssignments > shown.concurrencyCap
          ? ` ${manager.activeAssignments} are running now: lowering the cap cancels none of them, and new work waits for room.`
          : null}
      </p>
    );

  const edit = () => {
    setError(null);
    setNewPath("");
    setOpenedAt(manager.updatedAt);
    setDraft(managerSettingsDraft(result, manager.modelSelection));
  };
  const save = async (next: ManagerSettingsDraft) => {
    setSaving(true);
    setError(null);
    const modelChanged =
      next.model !== null &&
      (manager.modelSelection === null ||
        modelValue(next.model) !== modelValue(manager.modelSelection));
    const saved = await updateSettings({
      environmentId,
      input: {
        requestId: randomUUID(),
        expectedUpdatedAt: openedAt,
        managerId: manager.id,
        result: managerSettingsResult(result, next),
        ...(modelChanged && next.model !== null ? { modelSelection: next.model } : {}),
      },
    })
      .then(unwrapFactoryResult)
      .catch((failure: unknown) => {
        setError(factoryErrorMessage(failure));
        return null;
      });
    setSaving(false);
    if (saved !== null) setDraft(null);
  };

  if (draft === null) {
    return (
      <section aria-label="Manager settings" className={`${FACTORY_CARD_CLASS} space-y-2 p-3.5`}>
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-2xs font-medium text-muted-foreground select-none">
            Settings
          </h3>
          <Button variant="ghost" size="xs" disabled={!canEdit || paused} onClick={edit}>
            Edit
          </Button>
        </div>
        {paused ? (
          <p className="text-2xs text-muted-foreground">Resume the manager to edit its settings.</p>
        ) : null}
        <dl className="space-y-1.5 text-xs">
          {result.purpose === "" ? null : <Row term="Purpose">{result.purpose}</Row>}
          <Row term="Pickup">
            {result.pickup.enabled ? result.pickup.columns.map(columnLabel).join(", ") : "Off"}
            {result.pickup.enabled ? (
              <span className="block text-muted-foreground">
                {result.pickup.labels.length === 0
                  ? "Any label"
                  : `Labels: ${result.pickup.labels.join(", ")}`}
                {result.pickup.guidance === "" ? null : ` · ${result.pickup.guidance}`}
              </span>
            ) : null}
          </Row>
          <Row term="Concurrency cap">
            {result.concurrencyCap}
            {capNote}
          </Row>
          <Row term="Teams">
            {result.teamIds.length === 0
              ? "All teams"
              : result.teamIds
                  .map((id) => teams.find((team) => team.id === id)?.name ?? id)
                  .join(", ")}
          </Row>
          <Row term="Protected paths">
            {result.controlPaths.length === 0
              ? "None"
              : result.controlPaths.map((entry) => (
                  <span key={entry.path} className="block">
                    <code className="break-all">{entry.path}</code>
                    {entry.reason === "" ? null : (
                      <span className="text-muted-foreground"> · {entry.reason}</span>
                    )}
                  </span>
                ))}
          </Row>
          {result.rules.map((rule) => (
            <Row key={rule.id} term={rule.question}>
              {rule.answer}
            </Row>
          ))}
          <Row term="Model">{modelLabel(manager.modelSelection)}</Row>
        </dl>
      </section>
    );
  }

  const update = (next: ManagerSettingsDraft) => {
    setError(null);
    setDraft(next);
  };
  const problem = managerSettingsProblem(result, draft);
  const dirty = managerSettingsDirty(result, manager.modelSelection, draft);
  const disabled = saving || !canEdit;
  const addPath = () => {
    const path = newPath.trim();
    if (path === "" || draft.controlPaths.some((entry) => entry.path === path)) return;
    update({ ...draft, controlPaths: [...draft.controlPaths, { path, reason: "" }] });
    setNewPath("");
  };
  const modelChoices =
    draft.model === null ||
    models.some((choice) => modelValue(choice.selection) === modelValue(draft.model!))
      ? models
      : [{ selection: draft.model, label: modelLabel(draft.model) }, ...models];
  return (
    <section aria-label="Manager settings" className={`${FACTORY_CARD_CLASS} space-y-3 p-3.5`}>
      <h3 className="text-2xs font-medium text-muted-foreground select-none">Settings</h3>
      <Field title="Purpose">
        <Textarea
          aria-label="Purpose"
          size="sm"
          rows={2}
          disabled={disabled}
          value={draft.purpose}
          onChange={(event) => update({ ...draft, purpose: event.target.value })}
        />
      </Field>
      <Field title="Pickup">
        <Label>
          <Switch
            size="sm"
            checked={draft.pickupEnabled}
            disabled={disabled}
            onCheckedChange={(checked) => update({ ...draft, pickupEnabled: checked })}
          />
          Pick up tickets on its own
        </Label>
        {draft.pickupEnabled ? (
          <>
            {boards === null ? (
              <p className="text-2xs text-muted-foreground">Reading the boards…</p>
            ) : boards.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                No board has a Ready column; map one in Issues.
              </p>
            ) : (
              boards.map((board) => (
                <fieldset key={board.boardId} className="space-y-1">
                  <legend className="text-2xs">Ready columns on {board.title}</legend>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {board.readyColumns.map((column) => {
                      const ref = { boardId: board.boardId, columnId: column.id };
                      return (
                        <Label key={column.id}>
                          <Checkbox
                            checked={draft.columns.some((entry) => sameColumn(entry, ref))}
                            disabled={disabled}
                            onCheckedChange={(checked) =>
                              update(toggleSettingsColumn(draft, ref, checked === true))
                            }
                          />
                          {column.title}
                        </Label>
                      );
                    })}
                  </div>
                </fieldset>
              ))
            )}
            <Input
              aria-label="Pickup labels"
              size="sm"
              placeholder="Labels, comma-separated; empty for any"
              disabled={disabled}
              value={draft.labels}
              onChange={(event) => update({ ...draft, labels: event.target.value })}
            />
            <Textarea
              aria-label="Pickup guidance"
              size="sm"
              rows={2}
              disabled={disabled}
              value={draft.guidance}
              onChange={(event) => update({ ...draft, guidance: event.target.value })}
            />
          </>
        ) : null}
      </Field>
      <Field title="Concurrency cap">
        <Input
          aria-label="Concurrency cap"
          size="sm"
          type="number"
          min={1}
          max={MANAGER_CAP_MAX}
          disabled={disabled}
          value={draft.concurrencyCap}
          onChange={(event) => update({ ...draft, concurrencyCap: event.target.value })}
        />
        {capNote}
      </Field>
      <Field title="Teams">
        <p className="text-2xs text-muted-foreground">None ticked means every team.</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {teams.map((team) => (
            <Label key={team.id}>
              <Checkbox
                checked={draft.teamIds.includes(team.id)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  update({
                    ...draft,
                    teamIds:
                      checked === true
                        ? [...draft.teamIds, team.id]
                        : draft.teamIds.filter((id) => id !== team.id),
                  })
                }
              />
              {team.name}
            </Label>
          ))}
        </div>
      </Field>
      <Field title="Protected paths">
        {draft.controlPaths.map((entry) => (
          <div key={entry.path} className="flex items-start gap-1">
            <p className="min-w-0 flex-1 text-xs">
              <code className="break-all">{entry.path}</code>
              {entry.reason === "" ? null : (
                <span className="block text-2xs text-muted-foreground">{entry.reason}</span>
              )}
            </p>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${entry.path}`}
              disabled={disabled}
              onClick={() =>
                update({
                  ...draft,
                  controlPaths: draft.controlPaths.filter((current) => current !== entry),
                })
              }
            >
              <XIcon />
            </Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Input
            aria-label="New protected path"
            size="sm"
            placeholder="docs/**"
            disabled={disabled}
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addPath();
            }}
          />
          <Button variant="outline" size="sm" disabled={disabled} onClick={addPath}>
            Add
          </Button>
        </div>
      </Field>
      {result.rules.length === 0 ? null : (
        <Field title="Rules">
          {result.rules.map((rule) => (
            <div key={rule.id} className="space-y-1">
              <p className="text-xs">{rule.question}</p>
              <Input
                aria-label={rule.question}
                size="sm"
                disabled={disabled}
                value={draft.answers[rule.id] ?? ""}
                onChange={(event) =>
                  update({ ...draft, answers: { ...draft.answers, [rule.id]: event.target.value } })
                }
              />
            </div>
          ))}
        </Field>
      )}
      <Field title="Model">
        <Select
          value={draft.model === null ? "" : modelValue(draft.model)}
          disabled={disabled}
          onValueChange={(value) => {
            const choice = modelChoices.find((entry) => modelValue(entry.selection) === value);
            if (choice !== undefined) update({ ...draft, model: choice.selection });
          }}
        >
          <SelectTrigger size="sm" aria-label="Manager model">
            <SelectValue>{() => modelLabel(draft.model)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {modelChoices.map((choice) => (
              <SelectItem key={modelValue(choice.selection)} value={modelValue(choice.selection)}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <p className="text-2xs text-muted-foreground">Applies from the manager's next turn.</p>
      </Field>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {problem === null ? null : (
          <p className="min-w-0 flex-1 text-2xs text-muted-foreground">{problem}</p>
        )}
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={disabled || !dirty || problem !== null}
          onClick={() => void save(draft)}
        >
          {saving ? <Spinner size="xs" /> : null}
          Save
        </Button>
      </div>
    </section>
  );
}

function Row(props: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs text-muted-foreground">{props.term}</dt>
      <dd className="m-0 text-foreground/80">{props.children}</dd>
    </div>
  );
}

function Field(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{props.title}</h4>
      {props.children}
    </div>
  );
}

/** The project's mapped boards with their Ready columns, read once `wanted`; null while reading. */
function useReadyBoards(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  wanted: boolean,
): ReadonlyArray<ReadyBoard> | null {
  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });
  const openBoard = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });
  const [boards, setBoards] = useState<ReadonlyArray<ReadyBoard> | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    void (async () => {
      const listed = await listBoards({ environmentId, input: { projectId, connectedOnly: true } });
      if (listed._tag !== "Success") return current ? setBoards([]) : undefined;
      const read: ReadyBoard[] = [];
      for (const summary of listed.value) {
        if (summary.mapping === null) continue;
        const opened = await openBoard({
          environmentId,
          input: { projectId, boardId: summary.id },
        });
        if (opened._tag !== "Success") continue;
        const ready = new Set(issueReadyColumnIds(opened.value.board.mapping ?? summary.mapping));
        read.push({
          boardId: summary.id,
          title: opened.value.board.title,
          readyColumns: opened.value.columns.filter((column) => ready.has(column.id)),
        });
      }
      if (current) setBoards(read);
    })();
    return () => {
      current = false;
    };
  }, [environmentId, projectId, wanted, listBoards, openBoard]);
  return boards;
}
