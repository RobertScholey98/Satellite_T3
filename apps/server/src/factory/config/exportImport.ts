import {
  FACTORY_CONFIG_FORMAT_VERSION,
  FactoryOperationError,
  type FactoryConfigBundle,
  type FactoryConfigProblem,
  type FactoryConfigSettings,
  type FactoryDefinitionKind,
  type FactoryDefinitions,
  type FactoryExportSelection,
  type FactoryImportChoice,
  type FactoryImportDecision,
  type FactoryDefinitionsView,
  type FactoryImportPreview,
  type FactoryImportStatus,
  type FactoryModelList,
  type FactoryModelRef,
  type FactoryTeamDefinition,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { backupFactoryConfig } from "./backup.ts";
import {
  DEFAULT_FACTORY_SETTINGS,
  FACTORY_SETTINGS_FILE,
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
  type DefinitionFileInput,
} from "./definitionFiles.ts";
import * as FactoryConfigStore from "./FactoryConfigStore.ts";

/**
 * Export and import move definitions, never the directory: a bundle is built from decoded
 * definitions and an import writes decoded definitions through the store, so `.git`, `roles/`,
 * scratch files and paths outside the layout can neither leave nor arrive.
 */

type DefinitionSet = Omit<FactoryDefinitions, "settings">;

const modelKey = (model: FactoryModelRef) => `${model.driver}/${model.model}`;

type AnyDefinition = DefinitionSet[keyof DefinitionSet][number];

const modelsOf = (definition: AnyDefinition): ReadonlyArray<FactoryModelRef> => {
  const lists =
    "members" in definition
      ? [definition.lead.models, ...definition.members.map((member) => member.models)]
      : [definition.models];
  const byKey = new Map(
    lists.flatMap((list) => list.models.map((model) => [modelKey(model), model] as const)),
  );
  return [...byKey.values()];
};

const definitionFiles = (set: DefinitionSet): FactoryConfigBundle["files"] => [
  ...set.workers.map((d) => ({ path: `workers/${d.id}.md`, contents: encodeWorkerFile(d) })),
  ...set.leads.map((d) => ({ path: `leads/${d.id}.md`, contents: encodeLeadFile(d) })),
  ...set.managers.map((d) => ({ path: `managers/${d.id}.md`, contents: encodeManagerFile(d) })),
  ...set.teams.flatMap((team) =>
    encodeTeamFiles(team).map((file) => ({
      path: `teams/${team.id}/${file.path}`,
      contents: file.contents,
    })),
  ),
];

/** Selected teams bring the workers and leads whose ids match their members and lead. */
export const buildExportBundle = (
  definitions: FactoryDefinitions,
  selection: FactoryExportSelection,
): Result.Result<FactoryConfigBundle, FactoryOperationError> => {
  let included: DefinitionSet = definitions;
  if (selection.scope === "teams") {
    const missing = selection.teamIds.find(
      (id) => !definitions.teams.some((team) => team.id === id),
    );
    if (missing !== undefined) {
      return Result.fail(
        new FactoryOperationError({ reason: "not-found", message: `No team "${missing}".` }),
      );
    }
    const teams = definitions.teams.filter((team) => selection.teamIds.includes(team.id));
    const memberIds = new Set(teams.flatMap((team) => team.members.map((member) => member.id)));
    const leadIds = new Set(teams.map((team) => team.lead.id));
    included = {
      workers: definitions.workers.filter((worker) => memberIds.has(worker.id)),
      leads: definitions.leads.filter((lead) => leadIds.has(lead.id)),
      managers: [],
      teams,
    };
  }
  const used = new Set(
    [...included.workers, ...included.leads, ...included.managers, ...included.teams]
      .flatMap(modelsOf)
      .map(modelKey),
  );
  const settings: FactoryConfigSettings = {
    ...definitions.settings,
    modelPool: definitions.settings.modelPool.filter((model) => used.has(modelKey(model))),
  };
  return Result.succeed({
    files: [
      { path: FACTORY_SETTINGS_FILE, contents: encodeSettingsFile(settings) },
      ...definitionFiles(included),
    ],
  });
};

type LayoutPath =
  | { readonly kind: "settings" }
  | { readonly kind: "worker" | "lead" | "manager"; readonly id: string }
  | { readonly kind: "team"; readonly teamId: string; readonly file: "team" | "lead" }
  | { readonly kind: "member"; readonly teamId: string; readonly id: string };

const FOLDER_KIND = { workers: "worker", leads: "lead", managers: "manager" } as const;

// No dot first, so `..`, `.` and hidden names fail, and no separators or drive colons.
const SEGMENT = /^[^./\\:][^/\\:]*$/;

const markdownStem = (name: string | undefined) =>
  name !== undefined && name.endsWith(".md") && name.length > 3 ? name.slice(0, -3) : null;

/** Where a bundle path sits in the factory layout, or null for anything else. */
const parseLayoutPath = (relativePath: string): LayoutPath | null => {
  const segments = relativePath.split("/");
  if (!segments.every((segment) => SEGMENT.test(segment))) return null;
  const [first, second, third, fourth] = segments;
  if (segments.length === 1 && first === FACTORY_SETTINGS_FILE) return { kind: "settings" };
  if (segments.length === 2 && first !== undefined && Object.hasOwn(FOLDER_KIND, first)) {
    const id = markdownStem(second);
    return id === null ? null : { kind: FOLDER_KIND[first as keyof typeof FOLDER_KIND], id };
  }
  if (first !== "teams" || second === undefined) return null;
  if (segments.length === 3 && (third === "team.md" || third === "lead.md")) {
    return { kind: "team", teamId: second, file: third === "team.md" ? "team" : "lead" };
  }
  const id = segments.length === 4 && third === "members" ? markdownStem(fourth) : null;
  return id === null ? null : { kind: "member", teamId: second, id };
};

interface DecodedBundle extends DefinitionSet {
  readonly settings: FactoryConfigSettings;
  readonly problems: ReadonlyArray<FactoryConfigProblem>;
}

const collect = <A>(
  inputs: ReadonlyArray<DefinitionFileInput>,
  decode: (input: DefinitionFileInput) => Result.Result<A, FactoryConfigProblem>,
  problems: FactoryConfigProblem[],
) =>
  inputs.flatMap((input) => {
    const decoded = decode(input);
    if (Result.isSuccess(decoded)) return [decoded.success];
    problems.push(decoded.failure);
    return [];
  });

const decodeBundle = (bundle: FactoryConfigBundle): DecodedBundle => {
  const problems: FactoryConfigProblem[] = [];
  const seen = new Set<string>();
  let settingsText: string | null = null;
  const files: Record<"worker" | "lead" | "manager", DefinitionFileInput[]> = {
    worker: [],
    lead: [],
    manager: [],
  };
  const teams = new Map<
    string,
    { team: string | null; lead: string | null; members: { id: string; text: string }[] }
  >();
  for (const file of bundle.files) {
    const layout = parseLayoutPath(file.path);
    if (layout === null) {
      problems.push({ path: file.path, message: "Not a path in the factory config layout." });
      continue;
    }
    if (seen.has(file.path)) {
      problems.push({ path: file.path, message: "Appears more than once in the bundle." });
      continue;
    }
    seen.add(file.path);
    if (layout.kind === "settings") {
      settingsText = file.contents;
    } else if (layout.kind === "team" || layout.kind === "member") {
      const team = teams.get(layout.teamId) ?? { team: null, lead: null, members: [] };
      teams.set(layout.teamId, team);
      if (layout.kind === "member") team.members.push({ id: layout.id, text: file.contents });
      else team[layout.file] = file.contents;
    } else {
      files[layout.kind].push({ path: file.path, id: layout.id, text: file.contents });
    }
  }

  let settings = DEFAULT_FACTORY_SETTINGS;
  if (settingsText === null) {
    problems.push({ path: FACTORY_SETTINGS_FILE, message: "The bundle has no factory.yaml." });
  } else {
    const decoded = decodeSettingsFile(FACTORY_SETTINGS_FILE, settingsText);
    if (Result.isSuccess(decoded)) settings = decoded.success;
    else problems.push(decoded.failure);
  }
  const decodedTeams = [...teams.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([id, team]) => {
      const decoded = decodeTeamFiles({ id, directory: `teams/${id}`, ...team });
      problems.push(...decoded.problems);
      return decoded.team === null ? [] : [decoded.team];
    });
  return {
    settings,
    workers: collect(files.worker, decodeWorkerFile, problems),
    leads: collect(files.lead, decodeLeadFile, problems),
    managers: collect(files.manager, decodeManagerFile, problems),
    teams: decodedTeams,
    problems,
  };
};

interface Definition {
  readonly id: string;
  readonly name: string;
}

const status = <D extends Definition>(
  theirs: D,
  mine: ReadonlyArray<D>,
  encode: (definition: D) => string,
): FactoryImportStatus => {
  const local = mine.find((definition) => definition.id === theirs.id);
  if (local === undefined) return "new";
  return encode(local) === encode(theirs) ? "same" : "differs";
};

const encodeTeam = (team: FactoryTeamDefinition) => JSON.stringify(encodeTeamFiles(team));

const ENCODERS = {
  worker: encodeWorkerFile,
  lead: encodeLeadFile,
  manager: encodeManagerFile,
  team: encodeTeam,
};

const poolAdditions = (local: FactoryConfigSettings, imported: FactoryConfigSettings) => {
  const pool = new Set(local.modelPool.map(modelKey));
  return imported.modelPool.filter((model) => !pool.has(modelKey(model)));
};

/**
 * An import drops the models outside the pool from what it writes. An empty list means the whole
 * pool, so a list that named only dropped models would widen; its definition is skipped instead.
 */
const fitToPool = (pool: ReadonlyArray<FactoryModelRef>) => {
  const allowed = new Set(pool.map(modelKey));
  const definition = <D extends { readonly models: FactoryModelList }>(value: D): D | null => {
    const models = value.models.models.filter((model) => allowed.has(modelKey(model)));
    if (models.length === 0 && value.models.models.length > 0) return null;
    return { ...value, models: { ...value.models, models } };
  };
  const team = (value: FactoryTeamDefinition): FactoryTeamDefinition | null => {
    const lead = definition(value.lead);
    const members = value.members.map(definition);
    if (lead === null || members.some((member) => member === null)) return null;
    return { ...value, lead, members: members.filter((member) => member !== null) };
  };
  return { worker: definition, lead: definition, manager: definition, team };
};

export const previewImport = (
  local: FactoryDefinitions,
  bundle: FactoryConfigBundle,
): FactoryImportPreview => {
  const imported = decodeBundle(bundle);
  const pool = new Set(local.settings.modelPool.map(modelKey));
  // The import's own check, against the pool before any addition is accepted.
  const fit = fitToPool(local.settings.modelPool);
  const items = <D extends AnyDefinition>(
    kind: FactoryDefinitionKind,
    theirs: ReadonlyArray<D>,
    mine: ReadonlyArray<D>,
    encode: (definition: D) => string,
    fitOne: (definition: D) => D | null,
  ) =>
    theirs.map((definition) => {
      const modelsNeedingPool = modelsOf(definition).filter((model) => !pool.has(modelKey(model)));
      return {
        kind,
        id: definition.id,
        name: definition.name,
        status: status(definition, mine, encode),
        ...(modelsNeedingPool.length > 0 ? { modelsNeedingPool } : {}),
        ...(fitOne(definition) === null ? { skippedUnlessPoolAdded: true as const } : {}),
      };
    });
  return {
    items: [
      ...items("worker", imported.workers, local.workers, ENCODERS.worker, fit.worker),
      ...items("lead", imported.leads, local.leads, ENCODERS.lead, fit.lead),
      ...items("manager", imported.managers, local.managers, ENCODERS.manager, fit.manager),
      ...items("team", imported.teams, local.teams, ENCODERS.team, fit.team),
    ],
    poolAdditions: poolAdditions(local.settings, imported.settings),
    recoveryAllowance: {
      mine: local.settings.recoveryAllowance,
      theirs: imported.settings.recoveryAllowance,
    },
    problems: imported.problems,
  };
};

/** What an import writes and removes. Replace removes local definitions the bundle lacks. */
export interface ImportPlan extends DefinitionSet {
  /** Set whenever the import overwrites a file, so nothing is discarded silently. */
  readonly backup: boolean;
  readonly settings: FactoryConfigSettings;
  readonly remove: ReadonlyArray<{ readonly kind: FactoryDefinitionKind; readonly id: string }>;
  /** Definitions left out because they would only have run models the pool lacks. */
  readonly skipped: ReadonlyArray<FactoryConfigProblem>;
}

/** The local config, with the files that did not decode when it was read. */
type LocalConfig = FactoryDefinitions & {
  readonly problems?: ReadonlyArray<FactoryConfigProblem>;
};

// The longest definition name the contracts allow.
const MAX_NAME_LENGTH = 80;
const IMPORTED_SUFFIX = " (imported)";

const importedName = (name: string) =>
  `${name.slice(0, MAX_NAME_LENGTH - IMPORTED_SUFFIX.length).trimEnd()}${IMPORTED_SUFFIX}`;

const KINDS = ["worker", "lead", "manager", "team"] as const;
const PLURAL = { worker: "workers", lead: "leads", manager: "managers", team: "teams" } as const;

const listed = (words: ReadonlyArray<string>) =>
  words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;

const setOf = (set: DefinitionSet, kind: FactoryDefinitionKind): ReadonlyArray<Definition> =>
  kind === "worker"
    ? set.workers
    : kind === "lead"
      ? set.leads
      : kind === "manager"
        ? set.managers
        : set.teams;

export const planImport = (
  local: LocalConfig,
  bundle: FactoryConfigBundle,
  decision: FactoryImportDecision,
): Result.Result<ImportPlan, FactoryOperationError> => {
  const imported = decodeBundle(bundle);
  const accepted = new Set(decision.poolAdditions.map(modelKey));
  const additions = poolAdditions(local.settings, imported.settings).filter((model) =>
    accepted.has(modelKey(model)),
  );
  const skipped: FactoryConfigProblem[] = [];
  /** The definition as it can be written within the pool, or null when it is skipped. */
  const fitted = <D extends Definition>(
    kind: FactoryDefinitionKind,
    definition: D,
    fit: (definition: D) => D | null,
  ): D | null => {
    const result = fit(definition);
    if (result === null) {
      skipped.push({
        path: kind === "team" ? `teams/${definition.id}` : `${PLURAL[kind]}/${definition.id}.md`,
        message: `${definition.name} uses only models you didn't add to the pool, so it wasn't imported.`,
      });
    }
    return result;
  };

  if (decision.mode === "replace") {
    const allowed = new Set([...local.settings.modelPool, ...additions].map(modelKey));
    const modelPool = imported.settings.modelPool.filter((model) => allowed.has(modelKey(model)));
    const fit = fitToPool(modelPool);
    const all = <D extends Definition>(
      kind: FactoryDefinitionKind,
      definitions: ReadonlyArray<D>,
      fitOne: (definition: D) => D | null,
    ) =>
      definitions.flatMap((definition) => {
        const result = fitted(kind, definition, fitOne);
        return result === null ? [] : [result];
      });
    const written: DefinitionSet = {
      workers: all("worker", imported.workers, fit.worker),
      leads: all("lead", imported.leads, fit.lead),
      managers: all("manager", imported.managers, fit.manager),
      teams: all("team", imported.teams, fit.team),
    };
    const empty = KINDS.filter((kind) => setOf(written, kind).length === 0);
    if (empty.length > 0) {
      const missing = listed(empty.map((kind) => PLURAL[kind]));
      return Result.fail(
        new FactoryOperationError({
          reason: "invalid",
          message: `Replacing would leave the factory config with no ${missing}.`,
        }),
      );
    }
    // A skipped definition's local copy stays, so it counts as kept.
    const kept = new Set(
      KINDS.flatMap((kind) =>
        setOf(imported, kind).map((definition) => `${kind}/${definition.id}`),
      ),
    );
    return Result.succeed({
      backup: true,
      settings: { ...imported.settings, modelPool },
      ...written,
      remove: KINDS.flatMap((kind) =>
        setOf(local, kind)
          .filter((definition) => !kept.has(`${kind}/${definition.id}`))
          .map((definition) => ({ kind, id: definition.id })),
      ),
      skipped,
    });
  }

  const problems = local.problems ?? [];
  /** A local file at this id that did not decode, which writing the definition would replace. */
  const unreadable = (kind: FactoryDefinitionKind, id: string) =>
    problems.some(({ path }) =>
      kind === "team"
        ? path === `teams/${id}` || path.startsWith(`teams/${id}/`)
        : path === `${PLURAL[kind]}/${id}.md`,
    );
  let overwrites = problems.some(({ path }) => path === FACTORY_SETTINGS_FILE);
  const choice = (kind: FactoryDefinitionKind, id: string): FactoryImportChoice =>
    decision.choices.find((entry) => entry.kind === kind && entry.id === id)?.choice ?? "mine";
  const modelPool = [...local.settings.modelPool, ...additions];
  const fit = fitToPool(modelPool);
  const merge = <D extends Definition>(
    kind: FactoryDefinitionKind,
    theirs: ReadonlyArray<D>,
    mine: ReadonlyArray<D>,
    encode: (definition: D) => string,
    fitOne: (definition: D) => D | null,
  ): D[] => {
    const taken = new Set([...mine, ...theirs].map((original) => original.id));
    return theirs.flatMap((original) => {
      const found = status(original, mine, encode);
      if (found === "same") return [];
      const chosen = found === "new" ? "theirs" : choice(kind, original.id);
      if (chosen === "mine") return [];
      const definition = fitted(kind, original, fitOne);
      if (definition === null) return [];
      if (found === "new") {
        overwrites ||= unreadable(kind, definition.id);
        return [definition];
      }
      if (chosen === "theirs") {
        overwrites = true;
        return [definition];
      }
      const name = importedName(definition.name);
      let id = definitionIdFromName(name, taken);
      while (unreadable(kind, id)) {
        taken.add(id);
        id = definitionIdFromName(name, taken);
      }
      taken.add(id);
      return [{ ...definition, id, name }];
    });
  };
  const workers = merge("worker", imported.workers, local.workers, ENCODERS.worker, fit.worker);
  const leads = merge("lead", imported.leads, local.leads, ENCODERS.lead, fit.lead);
  const managers = merge(
    "manager",
    imported.managers,
    local.managers,
    ENCODERS.manager,
    fit.manager,
  );
  const teams = merge("team", imported.teams, local.teams, ENCODERS.team, fit.team);
  return Result.succeed({
    backup: overwrites,
    settings: {
      version: FACTORY_CONFIG_FORMAT_VERSION,
      modelPool,
      recoveryAllowance:
        decision.recoveryAllowance === "theirs"
          ? imported.settings.recoveryAllowance
          : local.settings.recoveryAllowance,
    },
    workers,
    leads,
    managers,
    teams,
    remove: [],
    skipped,
  });
};

/**
 * Applies an import to the local config and returns the config as it now reads, with skipped
 * definitions among its problems. Settings land first, so a failure part-way leaves a configured
 * directory that the database migration will not write over.
 */
export const applyImport = Effect.fn("FactoryConfigImport.apply")(function* (
  bundle: FactoryConfigBundle,
  decision: FactoryImportDecision,
) {
  const store = yield* FactoryConfigStore.FactoryConfigStore;
  const planned = planImport(yield* store.read, bundle, decision);
  if (Result.isFailure(planned)) return yield* planned.failure;
  const plan = planned.success;
  // A disconnect interrupts the request, and stopping after a replace's removes would leave
  // definitions missing, so once the backup starts every write runs.
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      if (plan.backup) yield* backupFactoryConfig(store.directory);
      yield* store.writeSettings(plan.settings);
      for (const { kind, id } of plan.remove) yield* store.remove(kind, id);
      for (const definition of plan.workers) yield* store.writeWorker(definition);
      for (const definition of plan.leads) yield* store.writeLead(definition);
      for (const definition of plan.managers) yield* store.writeManager(definition);
      for (const team of plan.teams) yield* store.writeTeam(team);
    }),
  );
  const view = yield* store.read;
  return { ...view, problems: [...view.problems, ...plan.skipped] };
});

/** Export and import as one service, so transports reach them without filesystem services. */
export class FactoryConfigTransfer extends Context.Service<
  FactoryConfigTransfer,
  {
    readonly export: (
      selection: FactoryExportSelection,
    ) => Effect.Effect<FactoryConfigBundle, FactoryOperationError>;
    readonly preview: (
      bundle: FactoryConfigBundle,
    ) => Effect.Effect<FactoryImportPreview, FactoryOperationError>;
    readonly apply: (
      bundle: FactoryConfigBundle,
      decision: FactoryImportDecision,
    ) => Effect.Effect<FactoryDefinitionsView, FactoryOperationError>;
  }
>()("t3/factory/config/exportImport/FactoryConfigTransfer") {}

export const layer = Layer.effect(
  FactoryConfigTransfer,
  Effect.gen(function* () {
    const store = yield* FactoryConfigStore.FactoryConfigStore;
    const services = Layer.mergeAll(
      Layer.succeed(FactoryConfigStore.FactoryConfigStore, store),
      Layer.succeed(FileSystem.FileSystem, yield* FileSystem.FileSystem),
      Layer.succeed(Path.Path, yield* Path.Path),
    );
    return FactoryConfigTransfer.of({
      export: Effect.fn("FactoryConfigTransfer.export")(function* (selection) {
        const bundle = buildExportBundle(yield* store.read, selection);
        if (Result.isFailure(bundle)) return yield* bundle.failure;
        return bundle.success;
      }),
      preview: Effect.fn("FactoryConfigTransfer.preview")(function* (bundle) {
        return previewImport(yield* store.read, bundle);
      }),
      apply: (bundle, decision) => applyImport(bundle, decision).pipe(Effect.provide(services)),
    });
  }),
);
