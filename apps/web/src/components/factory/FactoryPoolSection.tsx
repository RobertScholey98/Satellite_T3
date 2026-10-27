import type { EnvironmentId, FactoryConfigSettings } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { FactoryCountField } from "./FactoryCountField";
import { useFactoryDefinitions } from "./factoryDefinitionsState";
import { FactoryModelLabel } from "./FactoryModelLabel";
import {
  FACTORY_MODEL_REF_FLAG_LABELS,
  describeFactoryModelRefs,
  factoryModelRefFromOption,
  factoryModelRefKey,
  factoryStarterPool,
} from "./factoryModelRefs";
import type { FactoryModelOption } from "./FactoryPageConfig";
import { factorySectionSaveState } from "./factorySectionSave.logic";
import { FactorySectionSaveActions } from "./FactorySectionSaveActions";

/**
 * `factory.yaml`: the model pool every definition draws from, and the recovery allowance. Each
 * has its own section and Save, and saving one keeps the other as the file has it. The pool
 * holds portable names, so a model pooled on another machine stays listed here, flagged, rather
 * than disappearing.
 */
export function FactoryPoolSection({
  environmentId,
  canEdit,
  modelOptions,
}: {
  readonly environmentId: EnvironmentId;
  readonly canEdit: boolean;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
}) {
  const { view, loadError, saveSettings, createStarter } = useFactoryDefinitions(environmentId);
  const saved = view?.settings ?? null;
  const pool = useSettingsDraft(saved?.modelPool ?? null);
  const recovery = useSettingsDraft(saved?.recoveryAllowance ?? null);
  const [starting, setStarting] = useState(false);
  const [starterError, setStarterError] = useState<string | null>(null);
  const busy = starting || pool.saving || recovery.saving;
  const disabled = !canEdit || busy;

  const save = (patch: Partial<FactoryConfigSettings>) =>
    saved === null ? Promise.resolve(null) : saveSettings({ ...saved, ...patch });

  const startStarter = async () => {
    setStarting(true);
    setStarterError(null);
    const failure = await createStarter(factoryStarterPool(modelOptions));
    setStarting(false);
    setStarterError(failure);
  };
  // The starter set only fills a config that has nothing at all, as the server also checks.
  const empty =
    view !== null &&
    !view.configured &&
    view.workers.length + view.leads.length + view.managers.length + view.teams.length === 0 &&
    view.problems.length === 0;

  const modelPool = pool.value;
  const pooled = new Set(modelPool?.map(factoryModelRefKey));
  const addable = modelOptions.filter(
    (option) => !pooled.has(factoryModelRefKey(factoryModelRefFromOption(option))),
  );

  return (
    <>
      <SettingsSection
        id="factory-model-pool-file"
        title="Model pool"
        headerAction={
          <FactorySectionSaveActions
            state={pool.state}
            label="Save pool"
            disabled={disabled}
            onSave={() => void pool.save((modelPool) => save({ modelPool }))}
            onDiscard={pool.discard}
          />
        }
      >
        {view === null ? (
          <SettingsRow
            title={loadError === null ? "Loading the factory config…" : "Could not load"}
            description={loadError ?? undefined}
          />
        ) : null}
        {view !== null && !view.configured ? (
          <SettingsRow
            title="Nothing saved yet"
            description={
              empty
                ? "This environment has no factory config yet. Start from the starter set: this environment's Claude and Codex models as the pool, an implementer, a reviewer and a verifier, a default lead and manager, and one Standard team. Or build it by hand: saving a setting, worker, lead, manager or team creates the config."
                : "This environment has no factory.yaml yet. Saving a setting, worker, lead, manager or team creates it."
            }
            control={
              empty ? (
                <Button size="sm" disabled={disabled} onClick={() => void startStarter()}>
                  Use starter set
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {starterError !== null ? (
          <SettingsRow title="Could not start" description={starterError} />
        ) : null}
        {pool.error !== null ? (
          <SettingsRow title="Could not save" description={pool.error} />
        ) : null}
        {modelPool !== null ? (
          <>
            <SettingsRow
              title="Models"
              description="Workers, leads, managers and teams can only add models from the pool. A model removed here stays in the lists that name it, flagged as not in the pool, and delegation skips it."
              control={
                <Menu>
                  <MenuTrigger
                    aria-label="Add a model to the pool"
                    disabled={disabled || addable.length === 0}
                    render={<Button size="sm" variant="outline" />}
                  >
                    <PlusIcon />
                    Add model
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {addable.map((option) => (
                      <MenuItem
                        key={factoryModelRefKey(factoryModelRefFromOption(option))}
                        onClick={() =>
                          pool.change([...modelPool, factoryModelRefFromOption(option)])
                        }
                      >
                        {option.label}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              }
            />
            {modelPool.length === 0 ? (
              <SettingsRow
                title="The pool is empty"
                description="No factory work can start until the pool has a model."
              />
            ) : (
              describeFactoryModelRefs(modelPool, modelOptions, null).map((entry, index) => (
                <SettingsRow
                  key={factoryModelRefKey(entry.ref)}
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <FactoryModelLabel modelRef={entry.ref} label={entry.label} />
                      {entry.flags.map((flag) => (
                        <Badge key={flag} size="sm" variant="warning">
                          {FACTORY_MODEL_REF_FLAG_LABELS[flag]}
                        </Badge>
                      ))}
                    </span>
                  }
                  control={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={`Remove ${entry.label} from the pool`}
                      disabled={disabled}
                      onClick={() => pool.change(modelPool.filter((_, other) => other !== index))}
                    >
                      <XIcon />
                    </Button>
                  }
                />
              ))
            )}
          </>
        ) : null}
      </SettingsSection>
      {recovery.value !== null ? (
        <SettingsSection
          id="factory-recovery-file"
          title="Recovery"
          headerAction={
            <FactorySectionSaveActions
              state={recovery.state}
              label="Save recovery"
              disabled={disabled}
              onSave={() => void recovery.save((recoveryAllowance) => save({ recoveryAllowance }))}
              onDiscard={recovery.discard}
            />
          }
        >
          {recovery.error !== null ? (
            <SettingsRow title="Could not save" description={recovery.error} />
          ) : null}
          <SettingsRow
            title="Recovery allowance"
            description="How many times a stuck assignment is diagnosed and replanned before it waits on you."
            control={
              <FactoryCountField
                label="Recovery allowance"
                value={recovery.value}
                min={0}
                max={10}
                disabled={disabled}
                onChange={recovery.change}
              />
            }
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

/** One field of `factory.yaml` edited locally until its section's Save. */
function useSettingsDraft<T>(saved: T | null) {
  const [draft, setDraft] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    value: draft ?? saved,
    state: factorySectionSaveState(saved, draft, saving),
    saving,
    error,
    change: (next: T) => {
      setError(null);
      setDraft(next);
    },
    discard: () => {
      setError(null);
      setDraft(null);
    },
    save: async (write: (value: T) => Promise<string | null>) => {
      if (draft === null) return;
      setSaving(true);
      const failure = await write(draft);
      setSaving(false);
      setError(failure);
      if (failure === null) setDraft(null);
    },
  };
}
