import {
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { searchableSetting } from "../settings/settingsSearch";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "../settings/settingsLayout";
import { useScopedModelDisabledReason } from "../settings/useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

type RevdocModelKey =
  | "revdocModelSelection"
  | "revdocLargeModelSelection"
  | "revdocTestingModelSelection";

const MODEL_ROWS = [
  {
    key: "revdocModelSelection",
    search: "revdoc-model",
    label: "Revdoc review model",
    description: "Generates Revdoc checklists. Automatic uses the thread's own model.",
  },
  {
    key: "revdocLargeModelSelection",
    search: "revdoc-large-model",
    label: "Revdoc large review model",
    description:
      "Used when a large change set is reviewed in batches. Automatic uses the review model, then the thread's model.",
  },
  {
    key: "revdocTestingModelSelection",
    search: "revdoc-testing-model",
    label: "Revdoc testing model",
    description:
      "Runs AI testing as a delegated task. Automatic uses the review model, then the thread's model.",
  },
] as const;

export function RevdocSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const providers = (
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS
  ).filter((provider) => provider.supportsTextGeneration !== false);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      target?.projectId ?? null,
    ),
  );
  const disabledReason = useScopedModelDisabledReason(settings, entries);
  const fallback = resolveAppModelSelectionState(settings, providers);

  if (connectedEnvironments.length === 0) return null;

  const setModel = (key: RevdocModelKey, value: ModelSelection | null) => {
    const reason = value ? disabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Revdoc model not saved", description: reason });
      return;
    }
    updateSettings({ [key]: value });
  };

  return (
    <>
      {MODEL_ROWS.map((row) => {
        const configured = settings[row.key];
        const selection = configured ?? fallback;
        const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
        return (
          <SettingsRow
            key={row.key}
            serverScoped
            settingKeys={[row.key]}
            {...searchableSetting(row.search)}
            description={row.description}
            resetAction={
              configured !== null ? (
                <SettingResetButton label={row.label} onClick={() => setModel(row.key, null)} />
              ) : null
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={getCustomModelOptionsByInstance(
                    settings,
                    providers,
                    selection.instanceId,
                    selection.model,
                  )}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  {...(configured === null ? { triggerLabel: "Automatic" } : {})}
                  getModelDisabledReason={disabledReason}
                  {...(environmentId
                    ? {
                        onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                          void navigate({
                            to: "/settings/providers",
                            search: { environmentId, instanceId },
                          });
                        },
                      }
                    : {})}
                  onInstanceModelChange={(instanceId, model) =>
                    setModel(row.key, createModelSelection(instanceId, model))
                  }
                />
                {configured !== null ? (
                  <TraitsPicker
                    provider={entry?.driverKind ?? ProviderDriverKind.make("codex")}
                    models={entry?.models ?? []}
                    model={configured.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={configured.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      setModel(
                        row.key,
                        createModelSelection(configured.instanceId, configured.model, options),
                      )
                    }
                  />
                ) : null}
              </div>
            }
          />
        );
      })}
      <SettingsRow
        serverScoped
        settingKeys={["revdocDefaultAction"]}
        {...searchableSetting("revdoc-test-after-generate")}
        description="The Revdoc button also starts AI testing once the checklist is generated."
        control={
          <Switch
            checked={settings.revdocDefaultAction === "generate-and-test"}
            onCheckedChange={(checked) =>
              updateSettings({ revdocDefaultAction: checked ? "generate-and-test" : "generate" })
            }
            aria-label="Test after generating Revdoc"
          />
        }
      />
    </>
  );
}
