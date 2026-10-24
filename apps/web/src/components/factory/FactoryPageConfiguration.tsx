import {
  DEFAULT_FACTORY_CONFIG,
  type EnvironmentId,
  type FactoryConfig,
  type FactoryConfigView,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { issuesEnvironment } from "../work/issuesState";
import { FactoryConfigRepoSection } from "./FactoryConfigRepoSection";
import { FactoryConfigShareSection } from "./FactoryConfigShareSection";
import { FactoryDefinitionsSection } from "./FactoryDefinitionsSection";
import type { FactoryModelOption } from "./FactoryPageConfig";
import { FactoryPoolSection } from "./FactoryPoolSection";
import { FactoryTeamsFileSection } from "./FactoryTeamsFileSection";
import { factoryEnvironment, factoryErrorMessage, unwrapFactoryResult } from "./factoryState";

function failureMessage<A, E>(result: AtomCommandResult<A, E>): string | null {
  try {
    unwrapFactoryResult(result);
    return null;
  } catch (failure) {
    return factoryErrorMessage(failure);
  }
}

/** The settings the environment's database still owns; the rest live in the config files. */
type EnvironmentField = "concurrencyCap" | "digestIntervalMinutes";

/**
 * Factory settings for one environment. The concurrency cap, digest interval and git identity are
 * the environment's own and save together with Save; workers, teams, the model pool and the
 * recovery allowance live in the factory config files, which each section below saves itself.
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
  const getConfig = useAtomCommand(factoryEnvironment.getConfig, { reportFailure: false });
  const updateConfig = useAtomCommand(factoryEnvironment.updateConfig, { reportFailure: false });
  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });

  const [view, setView] = useState<FactoryConfigView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void getConfig({ environmentId, input: {} }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") setView(result.value);
      else setLoadError(failureMessage(result) ?? "Cancelled.");
    });
    return () => {
      current = false;
    };
  }, [environmentId, getConfig]);

  const [hasBoard, setHasBoard] = useState(true);
  useEffect(() => {
    let current = true;
    void listBoards({ environmentId, input: { connectedOnly: true } }).then((result) => {
      if (current && result._tag === "Success") setHasBoard(result.value.length > 0);
    });
    return () => {
      current = false;
    };
  }, [environmentId, listBoards]);

  const [draft, setDraft] = useState<FactoryConfig | null>(null);
  const config = draft ?? view?.environment ?? null;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const disabled = !canEdit || saving;

  const change = <K extends EnvironmentField>(key: K, value: FactoryConfig[K]) => {
    if (config === null) return;
    setSaveError(null);
    setDraft({ ...config, [key]: value });
  };

  const save = async () => {
    if (draft === null || !canEdit) return;
    setSaving(true);
    setSaveError(null);
    const result = await updateConfig({
      environmentId,
      input: { scope: "environment", config: draft },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setView(result.value);
      setDraft(null);
    } else {
      setSaveError(failureMessage(result));
    }
  };

  const resetFor = (key: EnvironmentField, label: string) =>
    config !== null && config[key] !== DEFAULT_FACTORY_CONFIG[key] && canEdit ? (
      <SettingResetButton
        label={label}
        tooltip="Reset to default"
        onClick={() => change(key, DEFAULT_FACTORY_CONFIG[key])}
      />
    ) : null;

  return (
    <>
      <div className="flex flex-col gap-2 px-3 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-base text-muted-foreground">Settings for {environmentLabel}</p>
          <div className="flex items-center gap-2">
            {draft !== null ? (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
                Discard
              </Button>
            ) : null}
            <Button size="sm" disabled={disabled || draft === null} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
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
      {config === null ? (
        <p
          role={loadError === null ? "status" : "alert"}
          className="px-3 text-sm text-muted-foreground sm:px-4"
        >
          {loadError ?? "Loading factory settings…"}
        </p>
      ) : (
        <>
          <SettingsSection id="factory-pickup" title="Pickup">
            {hasBoard ? null : (
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
            )}
            <SettingsRow
              id="factory-concurrency"
              title="Concurrent assignments"
              description="How many assignments run at once on this environment, across every project. Each manager's own limit, and which tickets it picks up, are set during onboarding."
              resetAction={resetFor("concurrencyCap", "concurrent assignments")}
              control={
                <FactoryNumberControl
                  label="Concurrent assignments"
                  value={config.concurrencyCap}
                  min={1}
                  max={20}
                  disabled={disabled}
                  onChange={(value) => change("concurrencyCap", value)}
                />
              }
            />
          </SettingsSection>
          <SettingsSection id="factory-behaviour" title="Behaviour">
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
                  onChange={(value) => change("digestIntervalMinutes", value)}
                />
              }
            />
            <SettingsRow
              id="factory-git-identity"
              title="Git identity"
              description="Managed work pushes and opens pull requests as you. Using a GitHub App identity comes in a later version."
              control={
                <span className="text-sm text-muted-foreground">
                  {config.gitIdentity.kind === "user"
                    ? "You"
                    : `GitHub App ${config.gitIdentity.appId}`}
                </span>
              }
            />
          </SettingsSection>
        </>
      )}
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
  );
}

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
