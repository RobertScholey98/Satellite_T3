import {
  FACTORY_CONFIG_FORMAT_VERSION,
  FactoryConfig,
  FactoryConfigOverride,
  type FactoryDefinitions,
  type FactoryLeadDefinition,
  type FactoryModelList,
  type FactoryModelRef,
  FactoryOperationError,
  FactoryRole,
  type FactoryTeamDefinition,
  type FactoryTeamMemberDefinition,
  type FactoryTeamPreset,
  type FactoryWorkerDefinition,
  type FactoryWorkerRole,
  type ModelSelection,
  ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { definitionIdFromName } from "./definitionFiles.ts";
import { FactoryConfigStore } from "./FactoryConfigStore.ts";
import {
  STARTER_WORKER_ROLES,
  defaultLead,
  defaultManager,
  starterWorker,
} from "./starterDefinitions.ts";

export interface ProjectOverrideRow {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly override: FactoryConfigOverride;
}

/** A saved value the factory config has no home for, shown to the user rather than dropped. */
export interface NotCarriedOver {
  /** Null for the environment config. */
  readonly projectId: ProjectId | null;
  readonly key: string;
  readonly value: unknown;
}

export interface FactoryConfigMigrationInput {
  readonly environment: FactoryConfig | null;
  readonly projectOverrides: ReadonlyArray<ProjectOverrideRow>;
  /** Text of the environment role-skill files that exist. */
  readonly roleSkills: Partial<Record<FactoryRole, string>>;
  readonly driverOf: (instanceId: string) => ProviderDriverKind | null;
}

export interface FactoryConfigMigrationPlan {
  readonly definitions: FactoryDefinitions;
  readonly notCarriedOver: ReadonlyArray<NotCarriedOver>;
}

/**
 * The file-based factory config equivalent to what the database held. Instance ids become driver
 * names, role allow-lists become dynamic starter workers, and each preset becomes a team of
 * copies. Pure so the mapping is testable without a filesystem.
 */
export const planFactoryConfigMigration = (
  input: FactoryConfigMigrationInput,
): FactoryConfigMigrationPlan => {
  const notCarriedOver: Array<NotCarriedOver> = [];
  const environment = input.environment;

  // The pool is validated to contain every role model, so a model with no driver is reported
  // once, here, and dropped silently from the lists below.
  const toRefs = (selections: ReadonlyArray<ModelSelection | null>) => {
    const seen = new Set<string>();
    const refs: Array<FactoryModelRef> = [];
    for (const selection of selections) {
      if (selection === null) continue;
      const driver = input.driverOf(selection.instanceId);
      if (driver === null) continue;
      const key = `${driver}\n${selection.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(
        selection.options === undefined
          ? { driver, model: selection.model }
          : { driver, model: selection.model, options: selection.options },
      );
    }
    return refs;
  };
  const dynamic = (selections: ReadonlyArray<ModelSelection | null>): FactoryModelList => ({
    dynamic: true,
    models: toRefs(selections),
  });

  for (const selection of environment?.modelPool ?? []) {
    if (input.driverOf(selection.instanceId) === null) {
      notCarriedOver.push({ projectId: null, key: "modelPool", value: selection });
    }
  }

  const roleModels = environment?.roleModels;
  const workers: Array<FactoryWorkerDefinition> = STARTER_WORKER_ROLES.map((role) =>
    starterWorker(role, {
      ...(input.roleSkills[role] === undefined ? {} : { description: input.roleSkills[role] }),
      models: dynamic(roleModels?.workers[role] ?? []),
    }),
  );
  const workerOf = new Map<FactoryWorkerRole, FactoryWorkerDefinition>(
    STARTER_WORKER_ROLES.map((role, index) => [role, workers[index]!]),
  );
  const lead = defaultLead({
    ...(input.roleSkills.lead === undefined ? {} : { instructions: input.roleSkills.lead }),
    models: dynamic(
      roleModels ? [roleModels.lead.small, roleModels.lead.medium, roleModels.lead.large] : [],
    ),
  });
  const manager = defaultManager({
    ...(input.roleSkills.manager === undefined ? {} : { instructions: input.roleSkills.manager }),
    models: { dynamic: false, models: toRefs([roleModels?.manager ?? null]) },
  });

  const teams: Array<FactoryTeamDefinition> = [];
  const teamIds = new Set<string>();
  const teamNames = new Set<string>();
  const addTeam = (preset: FactoryTeamPreset, name: string) => {
    const id = definitionIdFromName(name, teamIds);
    teamIds.add(id);
    teamNames.add(name);
    teams.push(teamFromPreset(preset, { id, name, lead, workerOf, dynamic }));
  };
  for (const preset of environment?.teamPresets ?? []) addTeam(preset, preset.name);

  for (const { projectId, title, override } of input.projectOverrides) {
    for (const preset of override.teamPresets ?? []) {
      addTeam(preset, teamNames.has(preset.name) ? `${preset.name} (${title})` : preset.name);
    }
    if (override.modelPool !== undefined) {
      notCarriedOver.push({ projectId, key: "modelPool", value: override.modelPool });
    }
    const workerModels = override.roleModels?.workers;
    // Decoding fills absent worker lists with empty ones, so only a list someone set is a value.
    if (workerModels && STARTER_WORKER_ROLES.some((role) => workerModels[role].length > 0)) {
      notCarriedOver.push({ projectId, key: "roleModels.workers", value: workerModels });
    }
    if (override.recoveryAllowance !== undefined) {
      notCarriedOver.push({
        projectId,
        key: "recoveryAllowance",
        value: override.recoveryAllowance,
      });
    }
    if (override.digestIntervalMinutes !== undefined) {
      notCarriedOver.push({
        projectId,
        key: "digestIntervalMinutes",
        value: override.digestIntervalMinutes,
      });
    }
  }

  return {
    definitions: {
      settings: {
        version: FACTORY_CONFIG_FORMAT_VERSION,
        modelPool: toRefs(environment?.modelPool ?? []),
        recoveryAllowance: environment?.recoveryAllowance ?? 1,
      },
      workers,
      leads: [lead],
      managers: [manager],
      teams,
    },
    notCarriedOver,
  };
};

const teamFromPreset = (
  preset: FactoryTeamPreset,
  context: {
    readonly id: string;
    readonly name: string;
    readonly lead: FactoryLeadDefinition;
    readonly workerOf: ReadonlyMap<FactoryWorkerRole, FactoryWorkerDefinition>;
    readonly dynamic: (selections: ReadonlyArray<ModelSelection>) => FactoryModelList;
  },
): FactoryTeamDefinition => {
  const memberIds = new Set<string>();
  const members = preset.members.map((member): FactoryTeamMemberDefinition => {
    const worker = context.workerOf.get(member.role)!;
    // Presets do not repeat a role in practice; a repeat still needs a distinct delegation name.
    let id: string = member.role;
    let n = 1;
    while (memberIds.has(id)) id = `${member.role}-${++n}`;
    memberIds.add(id);
    return {
      ...worker,
      id,
      name: n === 1 ? worker.name : `${worker.name} ${n}`,
      models: member.models === undefined ? worker.models : context.dynamic(member.models),
      count: member.count,
    };
  });
  return {
    id: context.id,
    name: context.name,
    useWhen: preset.useWhen,
    workflow: preset.workflow,
    mayEditProtectedPaths: false,
    createdBy: preset.createdBy,
    lead: context.lead,
    members,
  };
};

const ROLE_SKILLS_DIRECTORY = "roles";
const DEFAULT_INSTANCE_DRIVERS = new Set<string>(
  BUILT_IN_DRIVERS.filter((driver) => driver.metadata.hasDefaultInstance !== false).map(
    (driver) => driver.driverKind,
  ),
);

const storageError = (message: string) => new FactoryOperationError({ reason: "storage", message });
const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(FactoryConfig));
const decodeOverride = Schema.decodeEffect(Schema.fromJsonString(FactoryConfigOverride));

/**
 * Writes the factory config files from the database once, while `factory.yaml` is missing and
 * there is something to carry over. `factory.yaml` is written last, so a run that stops part way
 * runs again at the next start. The database rows stay as the rollback copy.
 */
export const migrateFactoryConfigFromDatabase = Effect.fn("FactoryConfigMigration.run")(
  function* () {
    const store = yield* FactoryConfigStore;
    if ((yield* store.read).configured) return;
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rolesDirectory = path.join(store.directory, ROLE_SKILLS_DIRECTORY);

    const roleFileNames = yield* fs.readDirectory(rolesDirectory).pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(() => storageError("Could not list the factory role files.")),
    );
    const roleSkills: Partial<Record<FactoryRole, string>> = {};
    for (const role of FactoryRole.literals) {
      if (!roleFileNames.includes(`${role}.md`)) continue;
      roleSkills[role] = yield* fs
        .readFileString(path.join(rolesDirectory, `${role}.md`))
        .pipe(Effect.mapError(() => storageError(`Could not read the ${role} role file.`)));
    }

    const rows = yield* sql<{ scope_key: string; config_json: string }>`
        SELECT scope_key,config_json FROM factory_config
        WHERE scope_key='environment' OR scope_key LIKE 'project:%'
        ORDER BY scope_key`.pipe(
      Effect.mapError(() => storageError("Could not read the saved factory config.")),
    );
    const environmentRow = rows.find((row) => row.scope_key === "environment");
    if (environmentRow === undefined && !roleFileNames.some((name) => name.endsWith(".md"))) return;

    // A config that no longer decodes fails the run rather than migrating defaults over it.
    const environment =
      environmentRow === undefined
        ? null
        : yield* decodeConfig(environmentRow.config_json).pipe(
            Effect.mapError(() => storageError("The saved factory config could not be read.")),
          );
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectOverrides = yield* Effect.forEach(
      rows.filter((row) => row.scope_key.startsWith("project:")),
      (row) =>
        Effect.gen(function* () {
          const projectId = ProjectId.make(row.scope_key.slice("project:".length));
          const override = yield* decodeOverride(row.config_json).pipe(Effect.option);
          if (Option.isNone(override)) {
            yield* Effect.logWarning("factory config migration skipped a project override", {
              projectId,
            });
            return [];
          }
          const title = yield* projects.get(projectId, { includeDeleted: true }).pipe(
            Effect.map(
              Option.match({ onNone: () => projectId, onSome: (project) => project.title }),
            ),
            Effect.orElseSucceed(() => projectId),
          );
          return [{ projectId, title, override: override.value }];
        }),
    ).pipe(Effect.map((overrides) => overrides.flat()));

    const { providerInstances } =
      yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
        Effect.mapError(() => storageError("Could not read the provider instances.")),
      );
    const driverOf = (instanceId: string): ProviderDriverKind | null =>
      providerInstances[instanceId as ProviderInstanceId]?.driver ??
      (DEFAULT_INSTANCE_DRIVERS.has(instanceId) ? (instanceId as ProviderDriverKind) : null);

    const { definitions, notCarriedOver } = planFactoryConfigMigration({
      environment,
      projectOverrides,
      roleSkills,
      driverOf,
    });
    for (const worker of definitions.workers) yield* store.writeWorker(worker);
    for (const lead of definitions.leads) yield* store.writeLead(lead);
    for (const manager of definitions.managers) yield* store.writeManager(manager);
    for (const team of definitions.teams) yield* store.writeTeam(team);
    yield* store.writeSettings(definitions.settings);
    yield* fs.remove(rolesDirectory, { recursive: true }).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      Effect.mapError(() => storageError("Could not remove the retired factory role files.")),
    );

    yield* Effect.logInfo("factory config migrated from the database", {
      directory: store.directory,
      teams: definitions.teams.length,
    });
    if (notCarriedOver.length > 0) {
      yield* Effect.logWarning("factory config migration did not carry over saved values", {
        notCarriedOver,
      });
    }
  },
);
