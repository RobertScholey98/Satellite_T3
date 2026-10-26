import {
  FactoryOperationError,
  type FactoryConfigProblem,
  type FactoryConfigSettings,
  type FactoryDefinitionId,
  type FactoryDefinitionsView,
  type FactoryLeadDefinition,
  type FactoryManagerDefinition,
  type FactoryTeamDefinition,
  type FactoryWorkerDefinition,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ServerConfig from "../../config.ts";
import {
  DEFAULT_FACTORY_SETTINGS,
  FACTORY_SETTINGS_FILE,
  TEAM_FILE,
  TEAM_LEAD_FILE,
  TEAM_MEMBERS_DIRECTORY,
  decodeLeadFile,
  decodeManagerFile,
  decodeSettingsFile,
  decodeTeamFiles,
  decodeWorkerFile,
  encodeLeadFile,
  encodeManagerFile,
  encodeSettingsFile,
  encodeTeamFiles,
  encodeWorkerFile,
  type DefinitionFileInput,
} from "./definitionFiles.ts";

type FactoryDefinitionKind = "worker" | "lead" | "manager" | "team";

const KIND_DIRECTORY: Record<FactoryDefinitionKind, string> = {
  worker: "workers",
  lead: "leads",
  manager: "managers",
  team: "teams",
};

/** The factory config as files under one directory. See docs/internals/factory-config.md. */
export class FactoryConfigStore extends Context.Service<
  FactoryConfigStore,
  {
    readonly directory: string;
    /** Never fails on a bad file: it is skipped and listed in `problems`. */
    readonly read: Effect.Effect<FactoryDefinitionsView, FactoryOperationError>;
    readonly writeSettings: (
      settings: FactoryConfigSettings,
    ) => Effect.Effect<void, FactoryOperationError>;
    readonly writeWorker: (
      definition: FactoryWorkerDefinition,
    ) => Effect.Effect<void, FactoryOperationError>;
    readonly writeLead: (
      definition: FactoryLeadDefinition,
    ) => Effect.Effect<void, FactoryOperationError>;
    readonly writeManager: (
      definition: FactoryManagerDefinition,
    ) => Effect.Effect<void, FactoryOperationError>;
    /** Also deletes the files of members no longer in the team. */
    readonly writeTeam: (team: FactoryTeamDefinition) => Effect.Effect<void, FactoryOperationError>;
    readonly remove: (
      kind: FactoryDefinitionKind,
      id: FactoryDefinitionId,
    ) => Effect.Effect<void, FactoryOperationError>;
    /**
     * Why this start could not migrate the database's config, or null. Kept in memory: the next
     * start retries the migration and records its own outcome.
     */
    readonly migrationFailure: Effect.Effect<string | null>;
    readonly recordMigrationFailure: (message: string | null) => Effect.Effect<void>;
  }
>()("t3/factory/config/FactoryConfigStore") {}

/**
 * What a write that would create `factory.yaml` says while the migration failed. Writing it would
 * mark the config as set up, and the database's config would never be migrated.
 */
export const unmigratedConfigMessage = (failure: string) =>
  `The factory config from the database has not been migrated yet: ${failure} Fix that and restart Satellite to migrate it. Saving factory settings before then would skip the migration for good.`;

const storageError = (action: string, relativePath: string) =>
  new FactoryOperationError({
    reason: "storage",
    message: `Could not ${action} ${relativePath || "the factory config directory"}.`,
  });

const isVisible = (name: string) => !name.startsWith(".");

const make = Effect.fn("FactoryConfigStore.make")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const migrationFailure = yield* Ref.make<string | null>(null);

  const absolute = (relativePath: string) => path.join(directory, ...relativePath.split("/"));

  const readText = (relativePath: string) =>
    fs.readFileString(absolute(relativePath)).pipe(
      Effect.map((text): string | null => text),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.mapError(() => storageError("read", relativePath)),
    );

  /** Visible entry names, sorted so reads are deterministic. A missing directory is empty. */
  const listNames = (relativePath: string) =>
    fs.readDirectory(absolute(relativePath)).pipe(
      Effect.map((names) => names.filter(isVisible).toSorted()),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
      Effect.mapError(() => storageError("list", relativePath)),
    );

  const listMarkdownStems = (relativePath: string) =>
    listNames(relativePath).pipe(
      Effect.map((names) =>
        names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)),
      ),
    );

  const isDirectory = (relativePath: string) =>
    fs.stat(absolute(relativePath)).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.mapError(() => storageError("read", relativePath)),
    );

  /** In a read, an entry that cannot be read is a problem for that entry, not a failed read. */
  const attempt = <A>(
    relativePath: string,
    effect: Effect.Effect<A, FactoryOperationError>,
  ): Effect.Effect<Result.Result<A, FactoryConfigProblem>> =>
    effect.pipe(
      Effect.map((value) => Result.succeed(value)),
      Effect.orElseSucceed(() =>
        Result.fail({ path: relativePath, message: "Could not be read." }),
      ),
    );

  const failures = (results: ReadonlyArray<Result.Result<unknown, FactoryConfigProblem>>) =>
    results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []));

  // The helpers below run inside one public operation, whose span already covers them.
  const readDefinitions = Effect.fnUntraced(function* <A>(
    kind: Exclude<FactoryDefinitionKind, "team">,
    decode: (input: DefinitionFileInput) => Result.Result<A, FactoryConfigProblem>,
  ) {
    const folder = KIND_DIRECTORY[kind];
    const stems = yield* attempt(folder, listMarkdownStems(folder));
    if (Result.isFailure(stems)) return { definitions: [], problems: [stems.failure] };
    const decoded = yield* Effect.forEach(
      stems.success,
      (id) => {
        const relativePath = `${folder}/${id}.md`;
        return attempt(relativePath, readText(relativePath)).pipe(
          Effect.map((text): Result.Result<A, FactoryConfigProblem> | null =>
            Result.isFailure(text)
              ? Result.fail(text.failure)
              : text.success === null
                ? null
                : decode({ path: relativePath, id, text: text.success }),
          ),
        );
      },
      { concurrency: 16 },
    );
    const definitions: A[] = [];
    const problems: FactoryConfigProblem[] = [];
    for (const result of decoded) {
      if (result === null) continue;
      if (Result.isSuccess(result)) definitions.push(result.success);
      else problems.push(result.failure);
    }
    return { definitions, problems };
  });

  const readTeam = Effect.fnUntraced(function* (id: string) {
    const teamDirectory = `${KIND_DIRECTORY.team}/${id}`;
    const membersDirectory = `${teamDirectory}/${TEAM_MEMBERS_DIRECTORY}`;
    const teamPath = `${teamDirectory}/${TEAM_FILE}`;
    const leadPath = `${teamDirectory}/${TEAM_LEAD_FILE}`;
    const [team, lead, memberIds] = yield* Effect.all([
      attempt(teamPath, readText(teamPath)),
      attempt(leadPath, readText(leadPath)),
      attempt(membersDirectory, listMarkdownStems(membersDirectory)),
    ]);
    const unread = failures([team, lead, memberIds]);
    // A team loads whole or not at all, so an unreadable header file skips it.
    if (Result.isFailure(team) || Result.isFailure(lead)) return { team: null, problems: unread };
    const members = yield* Effect.forEach(
      Result.isSuccess(memberIds) ? memberIds.success : [],
      (memberId) => {
        const relativePath = `${membersDirectory}/${memberId}.md`;
        return attempt(relativePath, readText(relativePath)).pipe(
          Effect.map((text) => ({ id: memberId, text })),
        );
      },
    );
    const decoded = decodeTeamFiles({
      id,
      directory: teamDirectory,
      team: team.success,
      lead: lead.success,
      members: members.flatMap(({ id, text }) =>
        Result.isSuccess(text) && text.success !== null ? [{ id, text: text.success }] : [],
      ),
    });
    return {
      team: decoded.team,
      problems: [...unread, ...failures(members.map(({ text }) => text)), ...decoded.problems],
    };
  });

  const readTeams = Effect.gen(function* () {
    const names = yield* attempt(KIND_DIRECTORY.team, listNames(KIND_DIRECTORY.team));
    if (Result.isFailure(names)) return { definitions: [], problems: [names.failure] };
    const entries = yield* Effect.forEach(names.success, (name) => {
      const relativePath = `${KIND_DIRECTORY.team}/${name}`;
      return attempt(relativePath, isDirectory(relativePath)).pipe(
        Effect.map((folder) => ({ name, folder })),
      );
    });
    const folders = entries.flatMap(({ name, folder }) =>
      Result.isSuccess(folder) && folder.success ? [name] : [],
    );
    const results = yield* Effect.forEach(folders, readTeam, { concurrency: 8 });
    return {
      definitions: results.flatMap((result) => (result.team === null ? [] : [result.team])),
      problems: [
        ...failures(entries.map(({ folder }) => folder)),
        ...results.flatMap((result) => result.problems),
      ],
    };
  });

  const read = Effect.fn("FactoryConfigStore.read")(function* () {
    // Only the root decides whether the config exists, so it alone fails the read.
    const rootNames = yield* fs.readDirectory(directory).pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(() => storageError("list", "")),
    );
    const configured = rootNames.includes(FACTORY_SETTINGS_FILE);
    const settingsText = configured
      ? yield* attempt(FACTORY_SETTINGS_FILE, readText(FACTORY_SETTINGS_FILE))
      : Result.succeed(null);
    const settings = Result.flatMap(settingsText, (text) =>
      text === null
        ? Result.succeed(DEFAULT_FACTORY_SETTINGS)
        : decodeSettingsFile(FACTORY_SETTINGS_FILE, text),
    );
    const [workers, leads, managers, teams] = yield* Effect.all(
      [
        readDefinitions("worker", decodeWorkerFile),
        readDefinitions("lead", decodeLeadFile),
        readDefinitions("manager", decodeManagerFile),
        readTeams,
      ],
      { concurrency: "unbounded" },
    );
    const failure = yield* Ref.get(migrationFailure);
    return {
      configured,
      settings: Result.isSuccess(settings) ? settings.success : DEFAULT_FACTORY_SETTINGS,
      workers: workers.definitions,
      leads: leads.definitions,
      managers: managers.definitions,
      teams: teams.definitions,
      problems: [
        // Shown where Settings and `factory_definitions` list problems, until a start migrates it.
        ...(configured || failure === null
          ? []
          : [{ path: FACTORY_SETTINGS_FILE, message: unmigratedConfigMessage(failure) }]),
        ...failures([settings]),
        ...workers.problems,
        ...leads.problems,
        ...managers.problems,
        ...teams.problems,
      ],
    } satisfies FactoryDefinitionsView;
  });

  /** Leaves an identical file untouched, so Git and file watchers see no change. */
  const writeIfChanged = Effect.fnUntraced(function* (relativePath: string, contents: string) {
    if ((yield* readText(relativePath)) === contents) return;
    yield* writeFileStringAtomically({ filePath: absolute(relativePath), contents }).pipe(
      Effect.provideContext(services),
      Effect.mapError(() => storageError("write", relativePath)),
    );
  });

  const removePath = (relativePath: string) =>
    fs.remove(absolute(relativePath), { recursive: true }).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      Effect.mapError(() => storageError("remove", relativePath)),
    );

  const writeSettings = Effect.fn("FactoryConfigStore.writeSettings")(function* (
    settings: FactoryConfigSettings,
  ) {
    yield* writeIfChanged(FACTORY_SETTINGS_FILE, encodeSettingsFile(settings));
  });

  const writeWorker = Effect.fn("FactoryConfigStore.writeWorker")(function* (
    definition: FactoryWorkerDefinition,
  ) {
    yield* writeIfChanged(
      `${KIND_DIRECTORY.worker}/${definition.id}.md`,
      encodeWorkerFile(definition),
    );
  });

  const writeLead = Effect.fn("FactoryConfigStore.writeLead")(function* (
    definition: FactoryLeadDefinition,
  ) {
    yield* writeIfChanged(`${KIND_DIRECTORY.lead}/${definition.id}.md`, encodeLeadFile(definition));
  });

  const writeManager = Effect.fn("FactoryConfigStore.writeManager")(function* (
    definition: FactoryManagerDefinition,
  ) {
    yield* writeIfChanged(
      `${KIND_DIRECTORY.manager}/${definition.id}.md`,
      encodeManagerFile(definition),
    );
  });

  const writeTeam = Effect.fn("FactoryConfigStore.writeTeam")(function* (
    team: FactoryTeamDefinition,
  ) {
    const teamDirectory = `${KIND_DIRECTORY.team}/${team.id}`;
    const membersDirectory = `${teamDirectory}/${TEAM_MEMBERS_DIRECTORY}`;
    for (const file of encodeTeamFiles(team)) {
      yield* writeIfChanged(`${teamDirectory}/${file.path}`, file.contents);
    }
    const kept = new Set(team.members.map((member) => member.id));
    for (const id of yield* listMarkdownStems(membersDirectory)) {
      if (!kept.has(id)) yield* removePath(`${membersDirectory}/${id}.md`);
    }
  });

  const remove = Effect.fn("FactoryConfigStore.remove")(function* (
    kind: FactoryDefinitionKind,
    id: FactoryDefinitionId,
  ) {
    yield* removePath(
      kind === "team" ? `${KIND_DIRECTORY.team}/${id}` : `${KIND_DIRECTORY[kind]}/${id}.md`,
    );
  });

  return FactoryConfigStore.of({
    directory,
    read: read(),
    writeSettings,
    writeWorker,
    writeLead,
    writeManager,
    writeTeam,
    remove,
    migrationFailure: Ref.get(migrationFailure),
    recordMigrationFailure: Effect.fn("FactoryConfigStore.recordMigrationFailure")((message) =>
      Ref.set(migrationFailure, message),
    ),
  });
});

/** The config under `<T3 home>/factory/`. */
export const layer = Layer.effect(
  FactoryConfigStore,
  Effect.gen(function* () {
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make(path.join(baseDir, "factory"));
  }),
);

/** The config in an explicit directory, such as a test's temp directory. */
export const layerAt = (directory: string) => Layer.effect(FactoryConfigStore, make(directory));
