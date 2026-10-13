import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * The Git repository, as a path on this environment, whose committed skills managers and their
 * teams use. The server refuses a path without a committed `skills/` directory, and the row shows
 * why.
 */
export function EngineeringManagersSkillsRepository({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.engineeringManagersSkillsRepository,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (value: string) => {
    if (value === saved) {
      setError(null);
      return;
    }
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { engineeringManagersSkillsRepository: value } },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setError(null);
      return;
    }
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : "Could not save the skills repository.");
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["engineeringManagersSkillsRepository"]}
      {...searchableSetting("engineering-managers-skills")}
      description="Managers and their teams use the skills committed here. Each new assignment uses the latest commit."
      status={
        error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : null
      }
      control={
        <Input
          key={saved}
          aria-label="Skills repository path"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Path to a Git repository"
          defaultValue={saved}
          disabled={saving}
          onBlur={(event) => void save(event.target.value.trim())}
        />
      }
    />
  );
}
