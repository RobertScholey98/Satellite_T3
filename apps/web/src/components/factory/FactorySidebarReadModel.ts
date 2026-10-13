import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  factorySystemManager,
  isConfinableProviderDriver,
  type EnvironmentId,
  type FactoryManager,
  type FactorySnapshot,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";

interface FactoryEnvironmentState {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly canOperate: boolean;
  readonly data: FactorySnapshot | null;
}

type FactoryEnvironmentData = Pick<FactoryEnvironmentState, "environmentId" | "data">;

interface FactoryProjectRef {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

const NO_MANAGED_THREADS: ReadonlySet<string> = new Set();
const NO_VISIBLE_THREADS: readonly string[] = [];

/**
 * The sidebar section appears once an environment holding one of the shown projects has a
 * manager. Until then, project settings is the way to create the first one.
 */
export function factorySidebarVisible(
  environments: readonly FactoryEnvironmentData[],
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
 * Managers and their teams run only on providers the factory can confine
 * (`FactoryExecution.qualify`), so manager setup offers those instances alone.
 */
export function factoryManagerProviders(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter((provider) => isConfinableProviderDriver(provider.driver));
}

/**
 * Selects the threads the factory section lists, which the ordinary thread list leaves out.
 * The selector returns its previous set while the keys are unchanged: the environment list
 * changes identity on unrelated presentation and session updates, and the sidebar's thread
 * classification memoises on this set.
 */
export function createFactoryManagedThreadKeysSelector() {
  let previous = NO_MANAGED_THREADS;
  return (environments: readonly FactoryEnvironmentData[]): ReadonlySet<string> => {
    const keys = factoryManagedThreadKeys(environments);
    if (keys.size !== previous.size) return (previous = keys);
    for (const key of keys) if (!previous.has(key)) return (previous = keys);
    return previous;
  };
}

function factoryManagedThreadKeys(environments: readonly FactoryEnvironmentData[]) {
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
  return keys;
}

/**
 * The environment's system-manager row: the current manager, which may be retired until the human
 * creates its replacement, and the shared teams of every system manager, so a retired
 * predecessor's teams stay reachable after the replacement takes over the row.
 */
export function factorySystemManagerTeam(data: FactorySnapshot) {
  const ids = new Set(
    data.managers.flatMap((entry) => (entry.role === "system" ? [entry.id] : [])),
  );
  return {
    manager: factorySystemManager(data.managers),
    assignments: data.assignments.filter((entry) => ids.has(entry.managerId)),
  };
}

/**
 * Thread keys the factory section shows, in render order: each environment's system manager
 * first, then the project managers, each followed by its assignments and their retros. The
 * sidebar folds these into its keyboard and range-select order.
 */
export function factoryVisibleThreadKeys({
  environments,
  projects,
  scopedProjectKeys,
  expanded,
  collapsedManagers,
}: {
  readonly environments: readonly FactoryEnvironmentData[];
  readonly projects: readonly FactoryProjectRef[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly expanded: boolean;
  readonly collapsedManagers: ReadonlySet<string>;
}): readonly string[] {
  const shownProjects =
    scopedProjectKeys === null
      ? projects
      : projects.filter((project) =>
          scopedProjectKeys.has(`${project.environmentId}:${project.id}`),
        );
  if (!expanded || !factorySidebarVisible(environments, shownProjects)) return NO_VISIBLE_THREADS;
  const keys: string[] = [];
  const addTeam = (
    environmentId: EnvironmentId,
    data: FactorySnapshot,
    manager: FactoryManager,
    assignments = data.assignments.filter((entry) => entry.managerId === manager.id),
  ) => {
    const managerKey = scopedThreadKey(scopeThreadRef(environmentId, manager.threadId));
    if (manager.threadStatus === "created") keys.push(managerKey);
    if (collapsedManagers.has(managerKey)) return;
    for (const assignment of assignments) {
      if (assignment.threadStatus === "created") {
        keys.push(scopedThreadKey(scopeThreadRef(environmentId, assignment.threadId)));
      }
      const retro = data.retros.find((entry) => entry.assignmentId === assignment.id);
      if (retro) keys.push(scopedThreadKey(scopeThreadRef(environmentId, retro.threadId)));
    }
  };
  for (const { environmentId, data } of environments) {
    if (data === null || !shownProjects.some((project) => project.environmentId === environmentId))
      continue;
    const { manager, assignments } = factorySystemManagerTeam(data);
    if (manager) addTeam(environmentId, data, manager, assignments);
  }
  for (const { environmentId, data } of environments) {
    if (data === null) continue;
    for (const manager of data.managers) {
      if (
        manager.role === "project" &&
        (scopedProjectKeys === null ||
          scopedProjectKeys.has(`${environmentId}:${manager.projectId}`))
      )
        addTeam(environmentId, data, manager);
    }
  }
  return keys.length === 0 ? NO_VISIBLE_THREADS : keys;
}
