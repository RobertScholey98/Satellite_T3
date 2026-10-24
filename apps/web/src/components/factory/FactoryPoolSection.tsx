import type { EnvironmentId, FactoryConfigSettings, FactoryModelRef } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { FactoryCountField } from "./FactoryCountField";
import { useFactoryDefinitions } from "./factoryDefinitionsState";
import {
  FACTORY_MODEL_REF_FLAG_LABELS,
  describeFactoryModelRefs,
  factoryModelRefFromOption,
  factoryModelRefKey,
  factoryStarterPool,
} from "./factoryModelRefs";
import type { FactoryModelOption } from "./FactoryPageConfig";

/**
 * `factory.yaml`: the model pool every definition draws from, and the recovery allowance. Edits
 * stay local until Save. The pool holds portable names, so a model pooled on another machine
 * stays listed here, flagged, rather than disappearing.
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
  const [draft, setDraft] = useState<FactoryConfigSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = draft ?? view?.settings ?? null;
  const disabled = !canEdit || saving || settings === null;

  const change = (next: Partial<FactoryConfigSettings>) => {
    if (settings === null) return;
    setError(null);
    setDraft({ ...settings, ...next });
  };

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    const failure = await saveSettings(draft);
    setSaving(false);
    setError(failure);
    if (failure === null) setDraft(null);
  };

  const startStarter = async () => {
    setSaving(true);
    setError(null);
    const failure = await createStarter(factoryStarterPool(modelOptions));
    setSaving(false);
    setError(failure);
  };
  // The starter set only fills a config that has nothing at all, as the server also checks.
  const empty =
    view !== null &&
    !view.configured &&
    view.workers.length + view.leads.length + view.managers.length + view.teams.length === 0 &&
    view.problems.length === 0;

  const pooled = new Set(settings?.modelPool.map(factoryModelRefKey));
  const addable = modelOptions.filter(
    (option) => !pooled.has(factoryModelRefKey(factoryModelRefFromOption(option))),
  );
  const setPool = (modelPool: ReadonlyArray<FactoryModelRef>) => change({ modelPool });

  return (
    <SettingsSection
      id="factory-model-pool-file"
      title="Model pool"
      headerAction={
        <div className="flex items-center gap-2">
          {draft !== null ? (
            <Button size="xs" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Discard
            </Button>
          ) : null}
          <Button size="xs" disabled={disabled || draft === null} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
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
              <Button size="xs" disabled={!canEdit || saving} onClick={() => void startStarter()}>
                Use starter set
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {error !== null ? <SettingsRow title="Could not save" description={error} /> : null}
      {settings !== null ? (
        <>
          <SettingsRow
            title="Models"
            description="Workers, leads, managers and teams can only add models from the pool. A model removed here stays in the lists that name it, flagged as not in the pool, and delegation skips it."
            control={
              <Menu>
                <MenuTrigger
                  aria-label="Add a model to the pool"
                  disabled={disabled || addable.length === 0}
                  render={<Button size="xs" variant="outline" />}
                >
                  <PlusIcon />
                  Add model
                </MenuTrigger>
                <MenuPopup align="end">
                  {addable.map((option) => (
                    <MenuItem
                      key={factoryModelRefKey(factoryModelRefFromOption(option))}
                      onClick={() =>
                        setPool([...settings.modelPool, factoryModelRefFromOption(option)])
                      }
                    >
                      {option.label}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            }
          >
            <ul className="flex max-w-2xl flex-col gap-1 pb-3.5">
              {settings.modelPool.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  The pool is empty, so no factory work can start.
                </li>
              ) : (
                describeFactoryModelRefs(settings.modelPool, modelOptions, null).map(
                  (entry, index) => (
                    <li
                      key={factoryModelRefKey(entry.ref)}
                      className="flex items-center gap-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      {entry.flags.map((flag) => (
                        <Badge key={flag} size="sm" variant="warning">
                          {FACTORY_MODEL_REF_FLAG_LABELS[flag]}
                        </Badge>
                      ))}
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Remove ${entry.label} from the pool`}
                        disabled={disabled}
                        onClick={() =>
                          setPool(settings.modelPool.filter((_, other) => other !== index))
                        }
                      >
                        <XIcon />
                      </Button>
                    </li>
                  ),
                )
              )}
            </ul>
          </SettingsRow>
          <SettingsRow
            title="Recovery allowance"
            description="How many times a stuck assignment is diagnosed and replanned before it waits on you."
            control={
              <FactoryCountField
                label="Recovery allowance"
                value={settings.recoveryAllowance}
                min={0}
                max={10}
                disabled={disabled}
                onChange={(recoveryAllowance) => change({ recoveryAllowance })}
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
