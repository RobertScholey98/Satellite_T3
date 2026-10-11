import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { lazy, Suspense, useState } from "react";

import { useFactoryEnvironments } from "../../state/factory";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { factoryCanCreateManager } from "./FactorySidebarReadModel";

const CreateManagerDialog = lazy(() =>
  import("./CreateManagerDialog").then((module) => ({ default: module.CreateManagerDialog })),
);

/**
 * Where a project gets its first engineering manager. The sidebar section stays hidden until an
 * environment has one, so this is the way in for everyone else.
 */
export function FactoryProjectSettings({
  projects,
}: {
  readonly projects: readonly EnvironmentProject[];
}) {
  const allEnvironments = useFactoryEnvironments();
  const [creating, setCreating] = useState(false);
  const environments = allEnvironments.filter((environment) =>
    projects.some((project) => project.environmentId === environment.environmentId),
  );
  if (environments.length === 0) return null;
  const manager = environments
    .flatMap((environment) =>
      (environment.data?.managers ?? []).filter(
        (entry) =>
          entry.role === "project" &&
          projects.some(
            (project) =>
              project.environmentId === environment.environmentId && project.id === entry.projectId,
          ),
      ),
    )
    .at(0);
  const canCreate = projects.some((project) => factoryCanCreateManager(environments, project));
  const unavailable = environments.find(
    (environment) => environment.data === null && environment.error !== null,
  );
  const description = manager
    ? `${manager.name} manages this project. Open it under Engineering managers in the sidebar.`
    : environments.some((environment) => environment.pending)
      ? "Checking for an engineering manager..."
      : unavailable && !canCreate
        ? `${unavailable.label}: ${unavailable.error}`
        : "Delegate delivery for this project to an engineering manager and its team.";

  return (
    <SettingsSection title="Engineering manager">
      <SettingsRow
        title="Engineering manager"
        description={description}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!canCreate}
            title={
              canCreate
                ? "Create an engineering manager for this project"
                : "Requires a connected environment where this project has no manager"
            }
            onClick={() => setCreating(true)}
          >
            Create manager
          </Button>
        }
      />
      {creating ? (
        <Suspense fallback={null}>
          <CreateManagerDialog
            projects={projects}
            environments={allEnvironments}
            onClose={() => setCreating(false)}
          />
        </Suspense>
      ) : null}
    </SettingsSection>
  );
}
