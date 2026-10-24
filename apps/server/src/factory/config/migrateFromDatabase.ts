import {
  FACTORY_CONFIG_FORMAT_VERSION,
  FactoryConfig,
  FactoryConfigOverride,
  type FactoryDefinitions,
  type FactoryLeadDefinition,
  type FactoryModelList,
  type FactoryModelRef,
  type FactoryConfigProblem,
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
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  FACTORY_SETTINGS_FILE,
  TEAM_FILE,
  TEAM_LEAD_FILE,
  TEAM_MEMBERS_DIRECTORY,
  decodeLeadFile,
  decodeManagerFile,
  decodeSettingsFile,
  decodeTeamFiles,
  decodeWorkerFile,
  definitionIdFromName,
  encodeLeadFile,
  encodeManagerFile,
  encodeSettingsFile,
  encodeTeamFiles,
  encodeWorkerFile,
} from "./definitionFiles.ts";
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
  readonly driverOf: (instanceId: ProviderInstanceId) => ProviderDriverKind | null;
}

export interface FactoryConfigMigrationPlan {
  readonly definitions: FactoryDefinitions;
  readonly notCarriedOver: ReadonlyArray<NotCarriedOver>;
  /**
   * Which instance each driver's models ran on, where the old pool named a driver's non-default
   * instance. Instance ids stay out of the files, so these go to the environment's database config.
   */
  readonly instancePreferences: FactoryConfig["instancePreferences"];
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

  // Definitions name only a driver, so a pool that named a driver's other instance would lose which
  // one ran. Its first such entry becomes the driver's preference; a default instance needs none.
  const instancePreferences: Record<ProviderDriverKind, ProviderInstanceId> = {};
  for (const selection of environment?.modelPool ?? []) {
    const driver = input.driverOf(selection.instanceId);
    if (driver === null) {
      notCarriedOver.push({ projectId: null, key: "modelPool", value: selection });
      continue;
    }
    if (
      instancePreferences[driver] === undefined &&
      selection.instanceId !== defaultInstanceIdForDriver(driver)
    )
      instancePreferences[driver] = selection.instanceId;
  }

  const roleModels = environment?.roleModels;
  const workerFor = (role: FactoryWorkerRole): FactoryWorkerDefinition =>
    starterWorker(role, {
      ...(input.roleSkills[role] === undefined ? {} : { description: input.roleSkills[role] }),
      models: dynamic(roleModels?.workers[role] ?? []),
    });
  const workers = STARTER_WORKER_ROLES.map(workerFor);
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
    teams.push(teamFromPreset(preset, { id, name, lead, workerFor, dynamic }));
  };
  for (const preset of environment?.teamPresets ?? []) addTeam(preset, preset.name);

  for (const { projectId, title, override } of input.projectOverrides) {
    for (const preset of override.teamPresets ?? []) {
      addTeam(preset, teamNames.has(preset.name) ? clashName(preset.name, title) : preset.name);
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
    instancePreferences,
  };
};

const MAX_NAME_LENGTH = 80;
const ELLIPSIS = "…";

/** Cuts on a code point boundary and marks the cut. */
const shorten = (text: string, max: number) => {
  if (text.length <= max) return text;
  let kept = "";
  for (const char of text) {
    if (kept.length + char.length > max - ELLIPSIS.length) break;
    kept += char;
  }
  return `${kept.trimEnd()}${ELLIPSIS}`;
};

/** `Name (Project)` within the name limit. The title gives way first, down to a few characters. */
const clashName = (name: string, title: string) => {
  const room = MAX_NAME_LENGTH - " ()".length;
  const shortTitle = shorten(title, Math.max(room - name.length, Math.min(title.length, 12)));
  return `${shorten(name, room - shortTitle.length)} (${shortTitle})`;
};

const teamFromPreset = (
  preset: FactoryTeamPreset,
  context: {
    readonly id: string;
    readonly name: string;
    readonly lead: FactoryLeadDefinition;
    readonly workerFor: (role: FactoryWorkerRole) => FactoryWorkerDefinition;
    readonly dynamic: (selections: ReadonlyArray<ModelSelection>) => FactoryModelList;
  },
): FactoryTeamDefinition => {
  const memberIds = new Set<string>();
  const members = preset.members.map((member): FactoryTeamMemberDefinition => {
    const worker = context.workerFor(member.role);
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
const DEFAULT_INSTANCE_DRIVERS = new Map<ProviderInstanceId, ProviderDriverKind>(
  BUILT_IN_DRIVERS.filter((driver) => driver.metadata.hasDefaultInstance !== false).map(
    (driver) => [defaultInstanceIdForDriver(driver.driverKind), driver.driverKind],
  ),
);

const storageError = (message: string) => new FactoryOperationError({ reason: "storage", message });
const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(FactoryConfig));
const decodeOverride = Schema.decodeEffect(Schema.fromJsonString(FactoryConfigOverride));
// The row as stored, so a merge keeps every key it holds, decoded or not.
const StoredRow = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeRow = Schema.decodeEffect(StoredRow);
const encodeRow = Schema.encodeSync(StoredRow);

const failureOf = <A>(decoded: Result.Result<A, FactoryConfigProblem>) =>
  Result.isFailure(decoded) ? decoded.failure : null;

/**
 * The first planned definition that would not load back from its own file, or null. A value the
 * old schema allowed and the new one does not, such as a role file over the length limit, would
 * otherwise be written and then skipped by every read.
 */
const unloadableDefinition = (definitions: FactoryDefinitions): FactoryConfigProblem | null => {
  const checks: Array<() => FactoryConfigProblem | null> = [
    () =>
      failureOf(
        decodeSettingsFile(FACTORY_SETTINGS_FILE, encodeSettingsFile(definitions.settings)),
      ),
    ...definitions.workers.map((worker) => () => {
      const path = `workers/${worker.id}.md`;
      return failureOf(decodeWorkerFile({ path, id: worker.id, text: encodeWorkerFile(worker) }));
    }),
    ...definitions.leads.map((lead) => () => {
      const path = `leads/${lead.id}.md`;
      return failureOf(decodeLeadFile({ path, id: lead.id, text: encodeLeadFile(lead) }));
    }),
    ...definitions.managers.map((manager) => () => {
      const path = `managers/${manager.id}.md`;
      return failureOf(
        decodeManagerFile({ path, id: manager.id, text: encodeManagerFile(manager) }),
      );
    }),
    ...definitions.teams.map((team) => () => {
      const directory = `teams/${team.id}`;
      const files = encodeTeamFiles(team);
      const text = (path: string) => files.find((file) => file.path === path)?.contents ?? null;
      const memberPrefix = `${TEAM_MEMBERS_DIRECTORY}/`;
      const decoded = decodeTeamFiles({
        id: team.id,
        directory,
        team: text(TEAM_FILE),
        lead: text(TEAM_LEAD_FILE),
        members: files.flatMap((file) =>
          file.path.startsWith(memberPrefix)
            ? [{ id: file.path.slice(memberPrefix.length, -".md".length), text: file.contents }]
            : [],
        ),
      });
      if (decoded.problems[0] !== undefined) return decoded.problems[0];
      return decoded.team === null
        ? { path: directory, message: "The team would not load." }
        : null;
    }),
  ];
  for (const check of checks) {
    const found = check();
    if (found !== null) return found;
  }
  return null;
};

/**
 * Writes the factory config files from the database once, while `factory.yaml` is missing and
 * there is something to carry over. Every definition is checked before the first write, and
 * `factory.yaml` is written last, so a run that fails or stops part way runs again at the next
 * start. The database rows stay as the rollback copy, and the role files stay for the live briefs
 * that still read them.
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
    const projectRows = rows.filter((row) => row.scope_key.startsWith("project:"));
    if (
      environmentRow === undefined &&
      projectRows.length === 0 &&
      !roleFileNames.some((name) => name.endsWith(".md"))
    )
      return;

    // A row that no longer decodes fails the run rather than migrating defaults over it.
    const environment =
      environmentRow === undefined
        ? null
        : yield* decodeConfig(environmentRow.config_json).pipe(
            Effect.mapError(() => storageError("The saved factory config could not be read.")),
          );
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectOverrides = yield* Effect.forEach(projectRows, (row) =>
      Effect.gen(function* () {
        const projectId = ProjectId.make(row.scope_key.slice("project:".length));
        const override = yield* decodeOverride(row.config_json).pipe(
          Effect.mapError(() =>
            storageError(`The saved factory config of project ${projectId} could not be read.`),
          ),
        );
        const title = yield* projects.get(projectId, { includeDeleted: true }).pipe(
          Effect.map(Option.match({ onNone: () => projectId, onSome: (project) => project.title })),
          Effect.orElseSucceed(() => projectId),
        );
        return { projectId, title, override };
      }),
    );

    const { providerInstances } =
      yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
        Effect.mapError(() => storageError("Could not read the provider instances.")),
      );
    const driverOf = (instanceId: ProviderInstanceId): ProviderDriverKind | null =>
      providerInstances[instanceId]?.driver ?? DEFAULT_INSTANCE_DRIVERS.get(instanceId) ?? null;

    const { definitions, notCarriedOver, instancePreferences } = planFactoryConfigMigration({
      environment,
      projectOverrides,
      roleSkills,
      driverOf,
    });
    const unloadable = unloadableDefinition(definitions);
    if (unloadable !== null) {
      return yield* storageError(
        `The migrated ${unloadable.path} would not load, so nothing was written: ${unloadable.message}`,
      );
    }
    // Merged into the row's own JSON, which otherwise stays the rollback copy. Written before any
    // file, so a run interrupted before factory.yaml seeds them again on the next start.
    if (environmentRow !== undefined && Object.keys(instancePreferences).length > 0) {
      const stored = yield* decodeRow(environmentRow.config_json).pipe(
        Effect.mapError(() => storageError("The saved factory config could not be read.")),
      );
      const merged = {
        ...stored,
        instancePreferences: { ...environment?.instancePreferences, ...instancePreferences },
      };
      yield* sql`UPDATE factory_config SET config_json=${encodeRow(merged)}
          WHERE scope_key='environment'`.pipe(
        Effect.mapError(() => storageError("Could not record which instances the pool ran on.")),
      );
    }
    for (const worker of definitions.workers) yield* store.writeWorker(worker);
    for (const lead of definitions.leads) yield* store.writeLead(lead);
    for (const manager of definitions.managers) yield* store.writeManager(manager);
    for (const team of definitions.teams) yield* store.writeTeam(team);
    yield* store.writeSettings(definitions.settings);

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
