import type {
  EnvironmentId,
  FactoryConfig,
  FactoryConfigView,
  FactoryRole,
  FactoryTeamPreset,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useProjects } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { issuesEnvironment } from "../work/issuesState";
import { FactoryConfigRepoSection } from "./FactoryConfigRepoSection";
import { FactoryConfigShareSection } from "./FactoryConfigShareSection";
import { FactoryDefinitionsSection } from "./FactoryDefinitionsSection";
import { FactoryPoolSection } from "./FactoryPoolSection";
import { FactoryTeamsFileSection } from "./FactoryTeamsFileSection";
import { factoryEnvironment, factoryErrorMessage, unwrapFactoryResult } from "./factoryState";
import {
  FACTORY_ROLE_LABELS,
  FACTORY_WORKER_ROLES,
  type FactoryConfigDraft,
  type FactoryModelOption,
  type FactoryOverridableKey,
  type FactoryPresetEntry,
  effectiveFactoryConfig,
  factoryFieldIsSet,
  factoryModelKey,
  factoryOverrideToSave,
  factoryPresetEntries,
  factoryPresetNameTaken,
  factoryPresetSummary,
  initialFactoryDraft,
  removeFactoryPreset,
  resetFactoryField,
  setFactoryField,
  setFactoryModelPool,
  upsertFactoryPreset,
} from "./FactoryPageConfig";
import {
  FactoryModelAllowList,
  FactoryModelSelect,
  type FactoryPoolModel,
} from "./FactoryPageModelControls";
import { type FactoryPresetRequest, FactoryPagePresetDialog } from "./FactoryPagePresetDialog";
import { factoryPresetUses } from "./FactoryPageStats";

const ENVIRONMENT_SCOPE = "environment";

function failureMessage<A, E>(result: AtomCommandResult<A, E>): string | null {
  try {
    unwrapFactoryResult(result);
    return null;
  } catch (failure) {
    return factoryErrorMessage(failure);
  }
}

const ROLE_SKILLS: ReadonlyArray<FactoryRole> = [
  "manager",
  "lead",
  "implementer",
  "reviewer",
  "verifier",
];

const COMPLEXITIES = [
  { value: "small", label: "Small tickets" },
  { value: "medium", label: "Medium tickets" },
  { value: "large", label: "Large tickets" },
] as const;

/**
 * Every factory setting for one environment: its defaults, or one project's overrides. Edits stay
 * local until Save, so a starter setup is never written by just opening the page.
 */
export function FactoryPageConfiguration({
  environmentId,
  environmentLabel,
  modelOptions,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
  readonly canEdit: boolean;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const scopeKey = projectId ?? "";
  const getConfig = useAtomCommand(factoryEnvironment.getConfig, { reportFailure: false });
  const updateConfig = useAtomCommand(factoryEnvironment.updateConfig, { reportFailure: false });
  const getStats = useAtomCommand(factoryEnvironment.getStats, { reportFailure: false });
  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });

  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly view: FactoryConfigView;
  } | null>(null);
  const [loadError, setLoadError] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void getConfig({ environmentId, input: projectId === null ? {} : { projectId } }).then(
      (result) => {
        if (!current) return;
        if (result._tag === "Success") setLoaded({ key: scopeKey, view: result.value });
        else setLoadError({ key: scopeKey, message: failureMessage(result) ?? "Cancelled." });
      },
    );
    return () => {
      current = false;
    };
  }, [environmentId, getConfig, projectId, scopeKey]);

  const [uses, setUses] = useState<{
    readonly key: string;
    readonly uses: ReadonlyMap<string, number>;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void getStats({ environmentId, input: projectId === null ? {} : { projectId } }).then(
      (result) => {
        if (current && result._tag === "Success")
          setUses({ key: scopeKey, uses: factoryPresetUses(result.value) });
      },
    );
    return () => {
      current = false;
    };
  }, [environmentId, getStats, projectId, scopeKey]);

  const [boardProjects, setBoardProjects] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    let current = true;
    void listBoards({ environmentId, input: { connectedOnly: true } }).then((result) => {
      if (current && result._tag === "Success")
        setBoardProjects(new Set(result.value.map((board) => board.projectId)));
    });
    return () => {
      current = false;
    };
  }, [environmentId, listBoards]);

  const view = loaded?.key === scopeKey ? loaded.view : null;
  const [edit, setEdit] = useState<{
    readonly key: string;
    readonly draft: FactoryConfigDraft;
  } | null>(null);
  const dirty = edit !== null && edit.key === scopeKey;
  const draft =
    view === null ? null : dirty ? edit.draft : initialFactoryDraft(view, projectId, modelOptions);
  const starter = view !== null && !view.configured && projectId === null;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const disabled = !canEdit || saving;

  const change = (next: (draft: FactoryConfigDraft) => FactoryConfigDraft) => {
    if (draft === null) return;
    setSaveError(null);
    setEdit({ key: scopeKey, draft: next(draft) });
  };

  const selectScope = async (next: string) => {
    const nextProjectId = next === ENVIRONMENT_SCOPE ? null : (next as ProjectId);
    if (nextProjectId === projectId) return;
    if (dirty) {
      const message = "Discard unsaved factory changes?";
      const confirmed = await (requestConfirmDialog(message, { variant: "destructive" }) ??
        Promise.resolve(window.confirm(message)));
      if (!confirmed) return;
    }
    setEdit(null);
    setSaveError(null);
    setProjectId(nextProjectId);
  };

  const save = async () => {
    if (draft === null || !canEdit) return;
    setSaving(true);
    setSaveError(null);
    const result = await updateConfig({
      environmentId,
      input:
        draft.kind === "environment"
          ? { scope: "environment", config: draft.config }
          : {
              scope: "project",
              projectId: draft.projectId,
              override: factoryOverrideToSave(draft.override),
            },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setLoaded({ key: scopeKey, view: result.value });
      setEdit(null);
    } else {
      setSaveError(failureMessage(result));
    }
  };

  const scopeLabel =
    projectId === null
      ? `${environmentLabel} defaults`
      : (projects.find((project) => project.id === projectId)?.title ?? "This project");

  const header = (
    <div className="flex flex-col gap-2 px-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-base text-muted-foreground">
          <span className="shrink-0">Applying settings for</span>
          <Select
            value={projectId ?? ENVIRONMENT_SCOPE}
            onValueChange={(next) => void selectScope(String(next))}
          >
            <SelectTrigger size="sm" variant="ghost" aria-label="Factory settings scope">
              <SelectValue>{() => scopeLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem value={ENVIRONMENT_SCOPE}>{environmentLabel} defaults</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </p>
        <div className="flex items-center gap-2">
          {dirty ? (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEdit(null)}>
              Discard
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={disabled || draft === null || (!dirty && !starter)}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {starter ? (
        <p role="status" className="text-sm text-muted-foreground">
          This is a starting point. Nothing is saved until you press Save.
        </p>
      ) : null}
      {projectId !== null ? (
        <p className="text-sm text-muted-foreground">
          Settings you change here override the environment defaults for this project only.
        </p>
      ) : null}
      {!canEdit ? (
        <p role="status" className="text-sm text-muted-foreground">
          This connection cannot change factory settings on {environmentLabel}.
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
    </div>
  );

  if (view === null || draft === null) {
    return (
      <>
        {header}
        <p
          role={loadError?.key === scopeKey ? "alert" : "status"}
          className="px-3 text-sm text-muted-foreground sm:px-4"
        >
          {loadError?.key === scopeKey ? loadError.message : "Loading factory settings…"}
        </p>
      </>
    );
  }

  const effective = effectiveFactoryConfig(view, draft);
  const labelOf = new Map(
    modelOptions.map((option) => [factoryModelKey(option.selection), option.label]),
  );
  const poolModels: ReadonlyArray<FactoryPoolModel> = effective.modelPool.map((selection) => ({
    selection,
    label:
      labelOf.get(factoryModelKey(selection)) ?? `${selection.model} (${selection.instanceId})`,
  }));
  const hasBoard =
    boardProjects === null ||
    (projectId === null ? boardProjects.size > 0 : boardProjects.has(projectId));
  const resetFor = (key: FactoryOverridableKey, label: string) =>
    factoryFieldIsSet(draft, key) && canEdit ? (
      <SettingResetButton
        label={label}
        tooltip={draft.kind === "project" ? "Use the environment value" : "Reset to default"}
        onClick={() => change((current) => resetFactoryField(current, key))}
      />
    ) : null;

  return (
    <>
      {header}
      <FactoryPickupSection
        config={effective}
        disabled={disabled || !hasBoard}
        noBoard={!hasBoard}
        resetFor={resetFor}
        onChange={(key, value) => change((current) => setFactoryField(current, key, value))}
      />
      <FactoryModelsSection
        draft={draft}
        view={view}
        config={effective}
        poolModels={poolModels}
        modelOptions={modelOptions}
        disabled={disabled}
        resetFor={resetFor}
        onPoolChange={(pool) => change((current) => setFactoryModelPool(view, current, pool))}
        onRoleModelsChange={(roleModels) =>
          change((current) => setFactoryField(current, "roleModels", roleModels))
        }
      />
      <FactoryTeamsSection
        entries={factoryPresetEntries(view, draft)}
        projectScope={draft.kind === "project"}
        uses={uses?.key === scopeKey ? uses.uses : null}
        pool={poolModels}
        disabled={disabled}
        nameTaken={(name, id) => factoryPresetNameTaken(draft, name, id)}
        onSave={(previousId, preset) =>
          change((current) => upsertFactoryPreset(current, previousId, preset))
        }
        onDelete={(id) => change((current) => removeFactoryPreset(current, id))}
      />
      <FactoryRoleSkillsSection />
      <FactoryBehaviourSection
        config={effective}
        disabled={disabled}
        resetFor={resetFor}
        onChange={(key, value) => change((current) => setFactoryField(current, key, value))}
      />
      {/* The factory config files belong to the environment; projects only reference teams. */}
      {draft.kind === "environment" ? (
        <>
          <FactoryPoolSection
            environmentId={environmentId}
            canEdit={canEdit}
            modelOptions={modelOptions}
          />
          <FactoryDefinitionsSection
            environmentId={environmentId}
            canEdit={canEdit}
            modelOptions={modelOptions}
          />
          <FactoryTeamsFileSection
            environmentId={environmentId}
            canEdit={canEdit}
            modelOptions={modelOptions}
          />
          <FactoryConfigRepoSection environmentId={environmentId} canEdit={canEdit} />
          <FactoryConfigShareSection environmentId={environmentId} canEdit={canEdit} />
        </>
      ) : null}
    </>
  );
}

type ResetFor = (key: FactoryOverridableKey, label: string) => ReactNode;
type FieldChange = <K extends "concurrencyCap" | "recoveryAllowance" | "digestIntervalMinutes">(
  key: K,
  value: FactoryConfig[K],
) => void;

function FactoryNumberControl({
  label,
  value,
  min,
  max,
  unit,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly unit?: string;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <NumberField
        value={value}
        min={min}
        max={max}
        size="sm"
        className="w-32"
        disabled={disabled}
        onValueChange={(next) => {
          if (next === null || !Number.isFinite(next)) return;
          onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${label}`} />
          <NumberFieldInput aria-label={label} />
          <NumberFieldIncrement aria-label={`Increase ${label}`} />
        </NumberFieldGroup>
      </NumberField>
      {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
    </div>
  );
}

function FactoryPickupSection({
  config,
  disabled,
  noBoard,
  resetFor,
  onChange,
}: {
  readonly config: FactoryConfig;
  readonly disabled: boolean;
  readonly noBoard: boolean;
  readonly resetFor: ResetFor;
  readonly onChange: FieldChange;
}) {
  return (
    <SettingsSection id="factory-pickup" title="Pickup">
      {noBoard ? (
        <SettingsRow
          title="No issue board"
          description={
            <>
              The manager picks up tickets from a connected board. Connect one in{" "}
              <Link to="/settings/issue-boards" className="underline">
                Issue boards
              </Link>
              .
            </>
          }
        />
      ) : null}
      <SettingsRow
        id="factory-concurrency"
        title="Concurrent assignments"
        aria-disabled={noBoard || undefined}
        description="How many assignments the manager runs at once in a project. Which tickets it picks up is set per manager during onboarding."
        resetAction={resetFor("concurrencyCap", "concurrent assignments")}
        control={
          <FactoryNumberControl
            label="Concurrent assignments"
            value={config.concurrencyCap}
            min={1}
            max={20}
            disabled={disabled}
            onChange={(value) => onChange("concurrencyCap", value)}
          />
        }
      />
    </SettingsSection>
  );
}

function FactoryModelsSection({
  draft,
  view,
  config,
  poolModels,
  modelOptions,
  disabled,
  resetFor,
  onPoolChange,
  onRoleModelsChange,
}: {
  readonly draft: FactoryConfigDraft;
  readonly view: FactoryConfigView;
  readonly config: FactoryConfig;
  readonly poolModels: ReadonlyArray<FactoryPoolModel>;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
  readonly disabled: boolean;
  readonly resetFor: ResetFor;
  readonly onPoolChange: (pool: ReadonlyArray<ModelSelection>) => void;
  readonly onRoleModelsChange: (roleModels: FactoryConfig["roleModels"]) => void;
}) {
  const labelOf = new Map(
    modelOptions.map((option) => [factoryModelKey(option.selection), option.label]),
  );
  // A project can only narrow the environment's pool; the environment offers its enabled models
  // plus any pooled model that is no longer enabled, so it can still be removed.
  const candidates: ReadonlyArray<FactoryPoolModel> =
    draft.kind === "project"
      ? view.environment.modelPool.map((selection) => ({
          selection,
          label:
            labelOf.get(factoryModelKey(selection)) ??
            `${selection.model} (${selection.instanceId})`,
        }))
      : [
          ...modelOptions.map((option) => ({ selection: option.selection, label: option.label })),
          ...config.modelPool
            .filter((selection) => !labelOf.has(factoryModelKey(selection)))
            .map((selection) => ({
              selection,
              label: `${selection.model} (${selection.instanceId}, not enabled)`,
            })),
        ];
  const pooled = new Set(config.modelPool.map(factoryModelKey));
  const { roleModels } = config;
  return (
    <SettingsSection id="factory-models" title="Models">
      <SettingsRow
        id="factory-model-pool"
        title="Model pool"
        description={
          draft.kind === "project"
            ? "The models this project's managers and teams may use, from the environment's pool."
            : "The models managers and teams may use. No manager starts while the pool is empty."
        }
        resetAction={resetFor("modelPool", "model pool")}
      >
        <div className="mt-3 flex max-w-2xl flex-col gap-2 pb-3.5">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No models are available. Enable a provider in Settings → Providers.
            </p>
          ) : (
            candidates.map((model) => {
              const key = factoryModelKey(model.selection);
              return (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={pooled.has(key)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      onPoolChange(
                        checked
                          ? candidates
                              .filter(
                                (candidate) =>
                                  pooled.has(factoryModelKey(candidate.selection)) ||
                                  factoryModelKey(candidate.selection) === key,
                              )
                              .map((candidate) => candidate.selection)
                          : config.modelPool.filter(
                              (candidate) => factoryModelKey(candidate) !== key,
                            ),
                      )
                    }
                  />
                  <span className="min-w-0 truncate">{model.label}</span>
                </label>
              );
            })
          )}
        </div>
      </SettingsRow>
      <SettingsRow
        id="factory-role-models"
        title="Role models"
        description="Which pool models each role uses. A role left on the pool lets the factory choose."
        resetAction={resetFor("roleModels", "role models")}
      />
      <SettingsRow
        id="factory-manager-model"
        title="Manager"
        description="The model a new manager's thread starts with."
        control={
          <FactoryModelSelect
            label="Manager model"
            pool={poolModels}
            value={roleModels.manager}
            emptyLabel="First pool model"
            disabled={disabled}
            onChange={(manager) => onRoleModelsChange({ ...roleModels, manager })}
          />
        }
      />
      <SettingsRow title="Lead" description="The lead's model, by the ticket's size.">
        <div className="mt-3 flex max-w-2xl flex-col gap-2 pb-3.5">
          {COMPLEXITIES.map((complexity) => (
            <div
              key={complexity.value}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span className="text-sm">{complexity.label}</span>
              <FactoryModelSelect
                label={`Lead model for ${complexity.label.toLowerCase()}`}
                pool={poolModels}
                value={roleModels.lead[complexity.value]}
                emptyLabel="Any pool model"
                disabled={disabled}
                onChange={(model) =>
                  onRoleModelsChange({
                    ...roleModels,
                    lead: { ...roleModels.lead, [complexity.value]: model },
                  })
                }
              />
            </div>
          ))}
        </div>
      </SettingsRow>
      {FACTORY_WORKER_ROLES.map((role) => (
        <SettingsRow
          key={role}
          title={FACTORY_ROLE_LABELS[role]}
          description="Models this role may use. A team can narrow it further."
          control={
            <FactoryModelAllowList
              label={`${FACTORY_ROLE_LABELS[role]} models`}
              pool={poolModels}
              value={roleModels.workers[role]}
              disabled={disabled}
              onChange={(models) =>
                onRoleModelsChange({
                  ...roleModels,
                  workers: { ...roleModels.workers, [role]: models },
                })
              }
            />
          }
        />
      ))}
    </SettingsSection>
  );
}

const ORIGIN_LABELS = {
  environment: "Environment",
  project: "This project",
  replaces: "Replaces environment team",
} as const;

function FactoryTeamsSection({
  entries,
  projectScope,
  uses,
  pool,
  disabled,
  nameTaken,
  onSave,
  onDelete,
}: {
  readonly entries: ReadonlyArray<FactoryPresetEntry>;
  readonly projectScope: boolean;
  readonly uses: ReadonlyMap<string, number> | null;
  readonly pool: ReadonlyArray<FactoryPoolModel>;
  readonly disabled: boolean;
  readonly nameTaken: (name: string, id: string | null) => boolean;
  readonly onSave: (previousId: string | null, preset: FactoryTeamPreset) => void;
  readonly onDelete: (id: string) => void;
}) {
  const [request, setRequest] = useState<FactoryPresetRequest | null>(null);
  return (
    <SettingsSection
      id="factory-teams"
      title="Teams"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => setRequest({ preset: null, copy: false, removable: false })}
        >
          <PlusIcon className="size-3" />
          Add team
        </Button>
      }
    >
      {entries.length === 0 ? (
        <SettingsRow
          title="No teams"
          description="The manager staffs every assignment as a custom team until you add one."
        />
      ) : (
        entries.map((entry) => (
          <SettingsRow
            key={entry.preset.id}
            className="group py-2"
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{entry.preset.name}</span>
                {projectScope ? (
                  <Badge size="sm" variant="outline">
                    {ORIGIN_LABELS[entry.origin]}
                  </Badge>
                ) : null}
              </span>
            }
            description={factoryPresetSummary(
              entry.preset,
              uses?.get(entry.preset.name) ?? (uses ? 0 : null),
            )}
            control={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Edit ${entry.preset.name}`}
                disabled={disabled}
                onClick={() =>
                  setRequest({
                    preset: entry.preset,
                    copy: projectScope && entry.origin === "environment",
                    removable: entry.removable,
                  })
                }
              >
                <SettingsIcon className="size-3.5" />
              </Button>
            }
          />
        ))
      )}
      <FactoryPagePresetDialog
        request={request}
        pool={pool}
        disabled={disabled}
        nameTaken={nameTaken}
        onSave={(previousId, preset) => {
          onSave(previousId, preset);
          setRequest(null);
        }}
        onDelete={(id) => {
          onDelete(id);
          setRequest(null);
        }}
        onClose={() => setRequest(null)}
      />
    </SettingsSection>
  );
}

function FactoryRoleSkillsSection() {
  return (
    <SettingsSection id="factory-role-skills" title="Role skills">
      {ROLE_SKILLS.map((role) => (
        <SettingsRow
          key={role}
          title={FACTORY_ROLE_LABELS[role]}
          description={
            <>
              Read from <code>.satellite/factory/roles/{role}.md</code> in the project, else{" "}
              <code>factory/roles/{role}.md</code> in the T3 home, else built in. Edit the file to
              customise it.
            </>
          }
        />
      ))}
    </SettingsSection>
  );
}

function FactoryBehaviourSection({
  config,
  disabled,
  resetFor,
  onChange,
}: {
  readonly config: FactoryConfig;
  readonly disabled: boolean;
  readonly resetFor: ResetFor;
  readonly onChange: FieldChange;
}) {
  return (
    <SettingsSection id="factory-behaviour" title="Behaviour">
      <SettingsRow
        id="factory-recovery-allowance"
        title="Recovery allowance"
        description="How many times a stuck assignment is diagnosed and replanned before it waits on you."
        resetAction={resetFor("recoveryAllowance", "recovery allowance")}
        control={
          <FactoryNumberControl
            label="Recovery allowance"
            value={config.recoveryAllowance}
            min={0}
            max={10}
            disabled={disabled}
            onChange={(value) => onChange("recoveryAllowance", value)}
          />
        }
      />
      <SettingsRow
        id="factory-digest-interval"
        title="Digest interval"
        description="How often a lead's recent activity is summarised for you and the manager."
        resetAction={resetFor("digestIntervalMinutes", "digest interval")}
        control={
          <FactoryNumberControl
            label="Digest interval"
            value={config.digestIntervalMinutes}
            min={1}
            max={24 * 60}
            unit="minutes"
            disabled={disabled}
            onChange={(value) => onChange("digestIntervalMinutes", value)}
          />
        }
      />
      <SettingsRow
        id="factory-git-identity"
        title="Git identity"
        description="Managed work pushes and opens pull requests as you. Using a GitHub App identity comes in a later version."
        control={
          <span className="text-sm text-muted-foreground">
            {config.gitIdentity.kind === "user" ? "You" : `GitHub App ${config.gitIdentity.appId}`}
          </span>
        }
      />
    </SettingsSection>
  );
}
