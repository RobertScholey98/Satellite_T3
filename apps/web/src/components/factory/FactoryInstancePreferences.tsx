import type { FactoryConfig, ProviderInstanceId } from "@t3tools/contracts";

import { SettingsRow } from "../settings/settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  type FactoryInstancePicker,
  factoryInstancePickers,
  setFactoryInstancePreference,
} from "./factoryRunsOn";
import type { FactoryModelOption } from "./FactoryPageConfig";

/** Select values are strings; this one stands for no preference. */
const FIRST_AVAILABLE = "";

/**
 * "Runs on": which instance runs factory work for a driver this environment has several of. The
 * choice goes into the environment form's draft and saves with its Save.
 */
export function FactoryInstancePreferences({
  config,
  modelOptions,
  disabled,
  onChange,
}: {
  readonly config: FactoryConfig;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
  readonly disabled: boolean;
  readonly onChange: (config: FactoryConfig) => void;
}) {
  const pickers = factoryInstancePickers(modelOptions, config.instancePreferences);
  if (pickers.length === 0) return null;
  return (
    <SettingsRow
      id="factory-runs-on"
      title="Runs on"
      description="Factory work names models by provider, not by account. Where this environment has more than one account for a provider, choose which runs the work."
    >
      <div className="flex flex-col gap-2 pb-3.5">
        {pickers.map((picker) => (
          <InstancePicker
            key={picker.driver}
            picker={picker}
            disabled={disabled}
            onChange={(instanceId) =>
              onChange(setFactoryInstancePreference(config, picker.driver, instanceId))
            }
          />
        ))}
      </div>
    </SettingsRow>
  );
}

function InstancePicker({
  picker,
  disabled,
  onChange,
}: {
  readonly picker: FactoryInstancePicker;
  readonly disabled: boolean;
  readonly onChange: (instanceId: ProviderInstanceId | null) => void;
}) {
  const labelOf = (value: string) => {
    if (value === FIRST_AVAILABLE) return "First available";
    const instance = picker.instances.find((candidate) => candidate.instanceId === value);
    return instance?.label ?? `${value} (not available here)`;
  };
  const options = [
    ...picker.instances.map((instance) => instance.instanceId as string),
    ...(picker.stale && picker.preferred !== null ? [picker.preferred as string] : []),
  ];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <span className="min-w-24 text-sm">{picker.driverLabel}</span>
        <div className="w-64">
          <Select
            value={picker.preferred ?? FIRST_AVAILABLE}
            disabled={disabled}
            onValueChange={(value) =>
              onChange(
                value === null || value === FIRST_AVAILABLE ? null : (value as ProviderInstanceId),
              )
            }
          >
            <SelectTrigger size="sm" aria-label={`${picker.driverLabel} runs on`}>
              <SelectValue>{(value: string) => labelOf(value)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem value={FIRST_AVAILABLE}>First available</SelectItem>
              {options.map((value) => (
                <SelectItem key={value} value={value}>
                  {labelOf(value)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      {picker.stale ? (
        <span className="text-xs text-muted-foreground">
          That instance is not available here, so the first available one runs instead.
        </span>
      ) : null}
    </div>
  );
}
