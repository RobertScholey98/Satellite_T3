import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FactorySnapshot, ProjectId } from "@t3tools/contracts";

interface FactoryEnvironmentState {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly canOperate: boolean;
  readonly data: FactorySnapshot | null;
}

interface FactoryProjectRef {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

/**
 * The sidebar section appears once an environment holding one of the shown projects has a
 * manager. Until then, project settings is the way to create the first one.
 */
export function factorySidebarVisible(
  environments: readonly FactoryEnvironmentState[],
  projects: readonly FactoryProjectRef[],
): boolean {
  return environments.some(
    (environment) =>
      (environment.data?.managers.length ?? 0) > 0 &&
      projects.some((project) => project.environmentId === environment.environmentId),
  );
}

/** Whether this connection can create a project manager for `project` right now. */
export function factoryCanCreateManager(
  environments: readonly FactoryEnvironmentState[],
  project: FactoryProjectRef,
): boolean {
  const environment = environments.find((entry) => entry.environmentId === project.environmentId);
  return (
    environment !== undefined &&
    environment.connected &&
    environment.canOperate &&
    environment.data !== null &&
    !environment.data.managers.some(
      (manager) =>
        manager.role === "project" &&
        manager.projectId === project.id &&
        manager.status !== "retired",
    )
  );
}

/**
 * Threads the factory section lists, which the ordinary thread list leaves out. Sorted and
 * joined so callers can memoise on content: factory views re-derive on unrelated presentation
 * and session changes.
 */
export function factoryManagedThreadKeys(
  environments: readonly Pick<FactoryEnvironmentState, "environmentId" | "data">[],
): string {
  const keys = new Set<string>();
  for (const { environmentId, data } of environments) {
    if (data === null) continue;
    for (const manager of data.managers) {
      if (manager.role === "project" && manager.threadStatus === "created") {
        keys.add(scopedThreadKey(scopeThreadRef(environmentId, manager.threadId)));
      }
    }
    for (const assignment of data.assignments) {
      if (assignment.threadStatus === "created") {
        keys.add(scopedThreadKey(scopeThreadRef(environmentId, assignment.threadId)));
      }
    }
    for (const retro of data.retros) {
      keys.add(scopedThreadKey(scopeThreadRef(environmentId, retro.threadId)));
    }
  }
  return [...keys].toSorted().join("\n");
}
