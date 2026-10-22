// @effect-diagnostics nodeBuiltinImport:off - Hashes request payloads and mints manager ids.
import * as NodeCrypto from "node:crypto";

import {
  DEFAULT_FACTORY_CONFIG,
  FactoryConfig,
  FactoryConfigOverride,
  FactoryManager,
  FactoryOperationError,
  resolveFactoryConfig,
  type FactoryConfigGetInput,
  type FactoryConfigUpdateInput,
  type FactoryConfigView,
  type FactoryManagersCreateInput,
  type FactoryManagersEvent,
  type FactoryManagersListInput,
  type FactoryManagersPauseInput,
  type FactoryManagersResumeInput,
  type FactoryManagersRetireInput,
  type FactoryManagersSubscribeInput,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { factoryConfigProblem, overrideWidensPool } from "./factoryConfig.ts";

export interface FactoryServiceDependencies {
  readonly getProject: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProjectShell | null, FactoryOperationError>;
}

export interface FactoryServiceShape {
  readonly getConfig: (
    input: FactoryConfigGetInput,
  ) => Effect.Effect<FactoryConfigView, FactoryOperationError>;
  readonly updateConfig: (
    input: FactoryConfigUpdateInput,
  ) => Effect.Effect<FactoryConfigView, FactoryOperationError>;
  readonly listManagers: (
    input: FactoryManagersListInput,
  ) => Effect.Effect<ReadonlyArray<FactoryManager>, FactoryOperationError>;
  readonly subscribeManagers: (
    input: FactoryManagersSubscribeInput,
  ) => Stream.Stream<FactoryManagersEvent, FactoryOperationError>;
  readonly createManager: (
    input: FactoryManagersCreateInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  readonly pauseManager: (
    input: FactoryManagersPauseInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  readonly resumeManager: (
    input: FactoryManagersResumeInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  readonly retireManager: (
    input: FactoryManagersRetireInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
}

export class FactoryService extends Context.Service<FactoryService, FactoryServiceShape>()(
  "t3/factory/FactoryService",
) {}

const error = (reason: FactoryOperationError["reason"], message: string) =>
  new FactoryOperationError({ reason, message });
const storageError = () => error("storage", "Could not read or save factory state.");
const isFactoryError = Schema.is(FactoryOperationError);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const hash = (value: unknown) => NodeCrypto.createHash("sha256").update(json(value)).digest("hex");
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(FactoryConfig));
const encodeOverride = Schema.encodeSync(Schema.fromJsonString(FactoryConfigOverride));
const decodeManagerValue = Schema.decodeUnknownEffect(FactoryManager);
const parse = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(storageError));

const ENVIRONMENT_SCOPE = "environment";
const projectScope = (projectId: ProjectId) => `project:${projectId}`;

/** Assignments in these states hold the manager and block retiring it. */
const ACTIVE_ASSIGNMENT_STATES = ["active", "blocked", "waiting-rob", "stalled", "retro"] as const;

interface ManagerRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly state: string;
  readonly paused_from: string | null;
  readonly thread_id: string | null;
  readonly control_paths_json: string;
  readonly onboarding_notes: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly active_assignments: number;
  readonly waiting_on_you: number;
}

export const makeFactoryService = Effect.fn("makeFactoryService")(function* (
  deps: FactoryServiceDependencies,
) {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);
  const preserveError = (cause: unknown) => (isFactoryError(cause) ? cause : storageError());
  const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(preserveError));
  const lock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    protect(mutex.withPermits(1)(sql.withTransaction(effect)));
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const changes = yield* PubSub.unbounded<void>();
  const publish = PubSub.publish(changes, undefined);

  const project = Effect.fnUntraced(function* (id: ProjectId) {
    const value = yield* deps.getProject(id);
    if (!value) return yield* error("not-found", "The selected project is unavailable.");
    return value;
  });

  const requestReplay = Effect.fnUntraced(function* (requestId: string, payload: unknown) {
    const rows = yield* sql<{ payload_hash: string; result_json: string }>`
        SELECT * FROM factory_requests WHERE request_id=${requestId}`;
    if (rows[0] && rows[0].payload_hash !== hash(payload))
      return yield* error(
        "conflict",
        "This request ID was already used for a different factory operation.",
      );
    return rows[0]?.result_json ?? null;
  });
  const remember = (requestId: string, payload: unknown, result: unknown) =>
    sql`INSERT INTO factory_requests(request_id,payload_hash,result_json)
        VALUES(${requestId},${hash(payload)},${json(result)})`;

  const readConfigRow = Effect.fnUntraced(function* (scopeKey: string) {
    const rows = yield* sql<{ config_json: string }>`
        SELECT config_json FROM factory_config WHERE scope_key=${scopeKey}`;
    return rows[0]?.config_json ?? null;
  });
  const environmentConfig = Effect.fnUntraced(function* () {
    const stored = yield* readConfigRow(ENVIRONMENT_SCOPE);
    return stored === null
      ? { config: DEFAULT_FACTORY_CONFIG, configured: false }
      : { config: yield* parse(FactoryConfig, stored), configured: true };
  });
  const projectOverride = Effect.fnUntraced(function* (projectId: ProjectId) {
    const stored = yield* readConfigRow(projectScope(projectId));
    return stored === null ? null : yield* parse(FactoryConfigOverride, stored);
  });
  const writeConfigRow = Effect.fnUntraced(function* (scopeKey: string, text: string) {
    const at = yield* now;
    yield* sql`INSERT INTO factory_config(scope_key,config_json,updated_at)
        VALUES(${scopeKey},${text},${at})
        ON CONFLICT(scope_key) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at`;
  });

  const configView = Effect.fnUntraced(function* (projectId: ProjectId | undefined) {
    const environment = yield* environmentConfig();
    if (projectId === undefined) {
      return {
        environment: environment.config,
        effective: environment.config,
        configured: environment.configured,
      } satisfies FactoryConfigView;
    }
    const override = yield* projectOverride(projectId);
    return {
      environment: environment.config,
      override,
      effective: resolveFactoryConfig(environment.config, override),
      configured: environment.configured,
    } satisfies FactoryConfigView;
  });

  const getConfig: FactoryServiceShape["getConfig"] = (input) =>
    protect(configView(input.projectId));

  /** Every project's effective config has to stay sound, since each can narrow the pool. */
  const assertProjectsSound = Effect.fnUntraced(function* (environment: FactoryConfig) {
    const rows = yield* sql<{ scope_key: string; config_json: string }>`
        SELECT scope_key,config_json FROM factory_config WHERE scope_key LIKE 'project:%'`;
    for (const row of rows) {
      const override = yield* parse(FactoryConfigOverride, row.config_json);
      const problem = factoryConfigProblem(resolveFactoryConfig(environment, override));
      if (problem !== null)
        return yield* error(
          "invalid",
          `A project's overrides would no longer fit: ${problem} Clear them first.`,
        );
    }
  });

  const updateConfig: FactoryServiceShape["updateConfig"] = (input) =>
    lock(
      Effect.gen(function* () {
        if (input.scope === "environment") {
          const problem = factoryConfigProblem(input.config);
          if (problem !== null) return yield* error("invalid", problem);
          yield* assertProjectsSound(input.config);
          yield* writeConfigRow(ENVIRONMENT_SCOPE, encodeConfig(input.config));
          return yield* configView(undefined);
        }
        yield* project(input.projectId);
        const scopeKey = projectScope(input.projectId);
        if (input.override === null) {
          yield* sql`DELETE FROM factory_config WHERE scope_key=${scopeKey}`;
          return yield* configView(input.projectId);
        }
        const environment = (yield* environmentConfig()).config;
        if (overrideWidensPool(environment, input.override))
          return yield* error(
            "invalid",
            "A project can narrow the model pool but not add models to it.",
          );
        const problem = factoryConfigProblem(resolveFactoryConfig(environment, input.override));
        if (problem !== null) return yield* error("invalid", problem);
        yield* writeConfigRow(scopeKey, encodeOverride(input.override));
        return yield* configView(input.projectId);
      }),
    );

  const decodeManager = Effect.fnUntraced(function* (row: ManagerRow) {
    return yield* decodeManagerValue({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      state: row.state,
      threadId: row.thread_id,
      controlPaths: yield* parse(Schema.Array(Schema.String), row.control_paths_json),
      onboardingNotes: row.onboarding_notes,
      activeAssignments: row.active_assignments,
      waitingOnYou: row.waiting_on_you,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }).pipe(Effect.mapError(storageError));
  });
  const managerRows = (where: ReturnType<typeof sql.literal>, id: string | null = null) =>
    sql<ManagerRow>`SELECT m.*,
        (SELECT COUNT(*) FROM factory_assignments a
          WHERE a.manager_id=m.id AND ${sql.in("a.state", ACTIVE_ASSIGNMENT_STATES)}) AS active_assignments,
        (SELECT COUNT(*) FROM factory_assignments a
          WHERE a.manager_id=m.id AND a.state='waiting-rob') AS waiting_on_you
      FROM factory_managers m WHERE ${where} AND (${id} IS NULL OR m.id=${id})
      ORDER BY m.created_at, m.id`;
  const readManager = Effect.fnUntraced(function* (id: string) {
    const rows = yield* managerRows(sql.literal("1=1"), id);
    if (!rows[0]) return yield* error("not-found", "This manager no longer exists.");
    return yield* decodeManager(rows[0]);
  });
  const currentManagers = Effect.fnUntraced(function* () {
    const rows = yield* managerRows(sql.literal("m.state != 'retired'"));
    return yield* Effect.forEach(rows, decodeManager);
  });
  const managersEvent = Effect.fnUntraced(function* () {
    return { managers: yield* currentManagers() } satisfies FactoryManagersEvent;
  });

  const listManagers: FactoryServiceShape["listManagers"] = (input) =>
    protect(
      Effect.gen(function* () {
        const rows = yield* managerRows(
          input.includeRetired ? sql.literal("1=1") : sql.literal("m.state != 'retired'"),
        );
        const scoped =
          input.projectId === undefined
            ? rows
            : rows.filter((row) => row.project_id === input.projectId);
        return yield* Effect.forEach(scoped, decodeManager);
      }),
    );

  const subscribeManagers: FactoryServiceShape["subscribeManagers"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.make(yield* managersEvent()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => managersEvent())),
        );
      }).pipe(Effect.mapError(preserveError)),
    ).pipe(
      Stream.mapError(preserveError),
      Stream.changesWith((left, right) => json(left) === json(right)),
      Stream.scoped,
    );

  const replayManager = Effect.fnUntraced(function* (requestId: string, payload: unknown) {
    const replay = yield* requestReplay(requestId, payload);
    return replay === null ? null : yield* parse(FactoryManager, replay);
  });
  const rememberManager = Effect.fnUntraced(function* (
    requestId: string,
    payload: unknown,
    id: string,
  ) {
    const manager = yield* readManager(id);
    yield* remember(requestId, payload, manager);
    yield* publish;
    return manager;
  });

  const createManager: FactoryServiceShape["createManager"] = (input) =>
    lock(
      Effect.gen(function* () {
        const replay = yield* replayManager(input.requestId, input);
        if (replay) return replay;
        yield* project(input.projectId);
        const current = yield* sql<{ name: string }>`SELECT name FROM factory_managers
            WHERE project_id=${input.projectId} AND state != 'retired'`;
        if (current[0])
          return yield* error(
            "conflict",
            `This project already has an engineering manager, ${current[0].name}.`,
          );
        const id = NodeCrypto.randomUUID();
        const at = yield* now;
        yield* sql`INSERT INTO factory_managers(id,project_id,name,state,thread_id,created_at,updated_at)
            VALUES(${id},${input.projectId},${input.name},'onboarding',NULL,${at},${at})`;
        return yield* rememberManager(input.requestId, input, id);
      }),
    );

  const pauseManager: FactoryServiceShape["pauseManager"] = (input) =>
    lock(
      Effect.gen(function* () {
        const replay = yield* replayManager(input.requestId, input);
        if (replay) return replay;
        const manager = yield* readManager(input.managerId);
        const target = input.scope === "manager" ? "manager-paused" : "project-paused";
        if (manager.state === "retired")
          return yield* error("conflict", "A retired manager cannot be paused.");
        // Pausing the project while the manager is paused keeps the state it resumes to.
        if (manager.state !== "manager-paused" && manager.state !== "project-paused") {
          yield* sql`UPDATE factory_managers SET paused_from=${manager.state} WHERE id=${manager.id}`;
        }
        if (
          manager.state !== target &&
          !(manager.state === "project-paused" && input.scope === "manager")
        ) {
          yield* sql`UPDATE factory_managers SET state=${target},updated_at=${yield* now}
              WHERE id=${manager.id}`;
        }
        return yield* rememberManager(input.requestId, input, manager.id);
      }),
    );

  const resumeManager: FactoryServiceShape["resumeManager"] = (input) =>
    lock(
      Effect.gen(function* () {
        const replay = yield* replayManager(input.requestId, input);
        if (replay) return replay;
        const manager = yield* readManager(input.managerId);
        if (manager.state === "manager-paused" || manager.state === "project-paused") {
          const rows = yield* sql<{ paused_from: string | null }>`
              SELECT paused_from FROM factory_managers WHERE id=${manager.id}`;
          const resumed = rows[0]?.paused_from === "onboarding" ? "onboarding" : "active";
          yield* sql`UPDATE factory_managers SET state=${resumed},paused_from=NULL,updated_at=${yield* now}
              WHERE id=${manager.id}`;
        }
        return yield* rememberManager(input.requestId, input, manager.id);
      }),
    );

  const retireManager: FactoryServiceShape["retireManager"] = (input) =>
    lock(
      Effect.gen(function* () {
        const replay = yield* replayManager(input.requestId, input);
        if (replay) return replay;
        const manager = yield* readManager(input.managerId);
        if (manager.state === "retired") return manager;
        if (manager.activeAssignments > 0)
          return yield* error(
            "conflict",
            `${manager.name} still has ${manager.activeAssignments} active assignment${manager.activeAssignments === 1 ? "" : "s"}. Finish or cancel them first.`,
          );
        const at = yield* now;
        yield* sql`UPDATE factory_managers SET state='retired',paused_from=NULL,updated_at=${at}
            WHERE id=${manager.id}`;
        yield* sql`UPDATE factory_members SET ended_at=${at}
            WHERE manager_id=${manager.id} AND ended_at IS NULL`;
        return yield* rememberManager(input.requestId, input, manager.id);
      }),
    );

  return {
    getConfig,
    updateConfig,
    listManagers,
    subscribeManagers,
    createManager,
    pauseManager,
    resumeManager,
    retireManager,
  } satisfies FactoryServiceShape;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  return yield* makeFactoryService({
    getProject: (id) =>
      projects.getShell(id).pipe(Effect.map(Option.getOrNull), Effect.mapError(storageError)),
  });
});

export const layer = Layer.effect(FactoryService, make);
