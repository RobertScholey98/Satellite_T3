// @effect-diagnostics nodeBuiltinImport:off - Hashes request payloads and mints manager ids.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_FACTORY_CONFIG,
  FactoryConfig,
  FactoryConfigOverride,
  FactoryManager,
  FactoryOnboardingReport,
  FactoryOperationError,
  ModelSelection,
  resolveFactoryConfig,
  type FactoryConfigGetInput,
  type FactoryConfigUpdateInput,
  type FactoryConfigView,
  type FactoryManagersApproveOnboardingInput,
  type FactoryManagersCreateInput,
  type FactoryManagersEvent,
  type FactoryManagersListInput,
  type FactoryManagersPauseInput,
  type FactoryManagersResumeInput,
  type FactoryManagersRetireInput,
  type FactoryManagersSubscribeInput,
  type FactoryRole,
  type FactoryRoleBrief,
  type OrchestrationProjectShell,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { factoryConfigProblem, modelKey, overrideWidensPool } from "./factoryConfig.ts";
import {
  renderRoleSkill,
  roleSkillSource,
  type RoleSkillFill,
  type RoleSkillSource,
} from "./roleSkills.ts";
import { ONBOARDING_BRIEF } from "./roles/index.ts";

/** Upstream's thread launch, as the factory calls it. Factory threads run in the project root. */
export interface FactoryThreadLaunch {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface FactoryServiceDependencies {
  readonly getProject: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProjectShell | null, FactoryOperationError>;
  readonly allocateThreadId: (
    projectId: ProjectId,
  ) => Effect.Effect<ThreadId, FactoryOperationError>;
  readonly launchThread: (input: FactoryThreadLaunch) => Effect.Effect<void, FactoryOperationError>;
  readonly readRoleSkill: (
    role: FactoryRole,
    projectRoot: string,
  ) => Effect.Effect<RoleSkillSource>;
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
  /** Stores the onboarding report the manager in this thread proposes for the user to approve. */
  readonly proposeOnboarding: (
    threadId: ThreadId,
    report: FactoryOnboardingReport,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  readonly approveOnboarding: (
    input: FactoryManagersApproveOnboardingInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  /** The current manager whose own thread this is, or null. */
  readonly managerForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<FactoryManager | null, FactoryOperationError>;
  /** A role's skill for this manager's project, with its placeholders filled. */
  readonly roleBrief: (
    projectId: ProjectId,
    role: FactoryRole,
    managerId: string,
  ) => Effect.Effect<FactoryRoleBrief, FactoryOperationError>;
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
const encodeModel = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const encodeReport = Schema.encodeSync(Schema.fromJsonString(FactoryOnboardingReport));
const decodeManagerValue = Schema.decodeUnknownEffect(FactoryManager);
const parse = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(storageError));

const ENVIRONMENT_SCOPE = "environment";
const projectScope = (projectId: ProjectId) => `project:${projectId}`;

/** Assignments in these states hold the manager and block retiring it. */
const ACTIVE_ASSIGNMENT_STATES = ["active", "blocked", "waiting-rob", "stalled", "retro"] as const;

// Always protected, so a team cannot rewrite the rules and role skills it works under.
const FACTORY_CONTROL_PATH = ".satellite/factory/";

const controlPathsOf = (paths: ReadonlyArray<string>) => [
  ...new Set([
    ...paths.map((path) => path.trim()).filter((path) => path !== ""),
    FACTORY_CONTROL_PATH,
  ]),
];

const dedupeModels = (models: ReadonlyArray<ModelSelection>) => [
  ...new Map(models.map((model) => [modelKey(model), model])).values(),
];

/** The models a role may start, narrowed by the role models and otherwise the whole pool. */
const allowedModelsFor = (config: FactoryConfig, role: FactoryRole) => {
  const { manager, lead, workers } = config.roleModels;
  switch (role) {
    case "manager":
      return manager === null ? config.modelPool : [manager];
    case "lead":
      // An unset size may use the whole pool, so only three set sizes narrow it.
      return lead.small !== null && lead.medium !== null && lead.large !== null
        ? dedupeModels([lead.small, lead.medium, lead.large])
        : config.modelPool;
    default:
      return workers[role].length > 0 ? workers[role] : config.modelPool;
  }
};

const skillFill = (
  config: FactoryConfig,
  role: FactoryRole,
  protectedPaths: ReadonlyArray<string>,
): RoleSkillFill => ({
  modelPool: config.modelPool,
  allowedModels: allowedModelsFor(config, role),
  protectedPaths,
  completionCondition: null,
  pickupGuidance: config.pickupGuidance,
});

interface ManagerRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly state: string;
  readonly paused_from: string | null;
  readonly thread_id: string | null;
  readonly control_paths_json: string;
  readonly onboarding_notes: string;
  readonly onboarding_report_json: string | null;
  readonly model_selection_json: string | null;
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
      onboardingReport:
        row.onboarding_report_json === null
          ? null
          : yield* parse(Schema.Unknown, row.onboarding_report_json),
      modelSelection:
        row.model_selection_json === null
          ? null
          : yield* parse(Schema.Unknown, row.model_selection_json),
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

  /**
   * Records the manager in onboarding, then launches its thread outside the lock like issue
   * attempts. A failed launch removes the row before the request is remembered, so the user can retry.
   */
  const createManager: FactoryServiceShape["createManager"] = (input) =>
    protect(
      Effect.gen(function* () {
        const created = yield* lock(
          Effect.gen(function* () {
            const replay = yield* replayManager(input.requestId, input);
            if (replay) return { replay } as const;
            const shell = yield* project(input.projectId);
            const current = yield* sql<{ name: string }>`SELECT name FROM factory_managers
                WHERE project_id=${input.projectId} AND state != 'retired'`;
            if (current[0])
              return yield* error(
                "conflict",
                `This project already has an engineering manager, ${current[0].name}.`,
              );
            const config = (yield* configView(input.projectId)).effective;
            if (config.modelPool.length === 0)
              return yield* error("invalid", "Add at least one model to the factory pool first.");
            const pool = new Set(config.modelPool.map(modelKey));
            if (input.modelSelection && !pool.has(modelKey(input.modelSelection)))
              return yield* error(
                "invalid",
                `${input.modelSelection.model} (${input.modelSelection.instanceId}) is not in the model pool.`,
              );
            const modelSelection =
              input.modelSelection ?? config.roleModels.manager ?? config.modelPool[0]!;
            const runtimeMode = input.runtimeMode ?? "full-access";
            const threadId = yield* deps.allocateThreadId(input.projectId);
            const id = NodeCrypto.randomUUID();
            const at = yield* now;
            yield* sql`INSERT INTO factory_managers(id,project_id,name,state,thread_id,
                model_selection_json,runtime_mode,created_at,updated_at)
                VALUES(${id},${input.projectId},${input.name},'onboarding',${threadId},
                ${encodeModel(modelSelection)},${runtimeMode},${at},${at})`;
            return { id, threadId, config, modelSelection, runtimeMode, shell } as const;
          }),
        );
        if ("replay" in created) return created.replay;
        const skill = yield* deps.readRoleSkill("manager", created.shell.workspaceRoot);
        const launched = yield* deps
          .launchThread({
            commandId: CommandId.make(`factory-manager:${input.requestId}`),
            threadId: created.threadId,
            projectId: input.projectId,
            title: `Engineering manager: ${input.name}`,
            text: `${renderRoleSkill(skill.text, skillFill(created.config, "manager", []))}\n\n${ONBOARDING_BRIEF}`,
            modelSelection: created.modelSelection,
            runtimeMode: created.runtimeMode,
            interactionMode: "default",
          })
          .pipe(Effect.result);
        if (launched._tag === "Failure") {
          yield* lock(sql`DELETE FROM factory_managers WHERE id=${created.id}`);
          return yield* error("unavailable", launched.failure.message);
        }
        return yield* lock(rememberManager(input.requestId, input, created.id));
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

  const managerRowForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const rows = yield* managerRows(sql.literal("m.state != 'retired'"));
    return rows.find((row) => row.thread_id === threadId) ?? null;
  });

  const managerForThread: FactoryServiceShape["managerForThread"] = (threadId) =>
    protect(
      Effect.gen(function* () {
        const row = yield* managerRowForThread(threadId);
        return row === null ? null : yield* decodeManager(row);
      }),
    );

  const proposeOnboarding: FactoryServiceShape["proposeOnboarding"] = (threadId, report) =>
    lock(
      Effect.gen(function* () {
        const row = yield* managerRowForThread(threadId);
        if (row === null)
          return yield* error("not-found", "This thread is not an engineering manager.");
        const onboarding =
          row.state === "onboarding" ||
          ((row.state === "manager-paused" || row.state === "project-paused") &&
            row.paused_from === "onboarding");
        if (!onboarding)
          return yield* error("conflict", "This manager has already finished onboarding.");
        yield* sql`UPDATE factory_managers SET onboarding_report_json=${encodeReport(report)},
            onboarding_notes=${report.summary},updated_at=${yield* now} WHERE id=${row.id}`;
        yield* publish;
        return yield* readManager(row.id);
      }),
    );

  const approveOnboarding: FactoryServiceShape["approveOnboarding"] = (input) =>
    lock(
      Effect.gen(function* () {
        const replay = yield* replayManager(input.requestId, input);
        if (replay) return replay;
        const manager = yield* readManager(input.managerId);
        if (manager.state === "manager-paused" || manager.state === "project-paused")
          return yield* error("conflict", "Resume the manager first.");
        if (manager.state !== "onboarding")
          return yield* error("conflict", `${manager.name} is not onboarding.`);
        if (manager.onboardingReport === null)
          return yield* error(
            "conflict",
            `${manager.name} has not proposed an onboarding report yet.`,
          );
        yield* sql`UPDATE factory_managers SET state='active',
            control_paths_json=${json(controlPathsOf(input.controlPaths))},updated_at=${yield* now}
            WHERE id=${manager.id}`;
        return yield* rememberManager(input.requestId, input, manager.id);
      }),
    );

  const roleBrief: FactoryServiceShape["roleBrief"] = (projectId, role, managerId) =>
    protect(
      Effect.gen(function* () {
        const shell = yield* project(projectId);
        const manager = yield* readManager(managerId);
        if (manager.projectId !== projectId)
          return yield* error("invalid", "This manager belongs to a different project.");
        const config = (yield* configView(projectId)).effective;
        const skill = yield* deps.readRoleSkill(role, shell.workspaceRoot);
        const protectedPaths =
          manager.controlPaths.length > 0
            ? manager.controlPaths
            : (manager.onboardingReport?.controlPaths ?? []);
        const text = renderRoleSkill(skill.text, skillFill(config, role, protectedPaths));
        return { role, text, source: skill.source } satisfies FactoryRoleBrief;
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
    proposeOnboarding,
    approveOnboarding,
    managerForThread,
    roleBrief,
  } satisfies FactoryServiceShape;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* makeFactoryService({
    getProject: (id) =>
      projects.getShell(id).pipe(Effect.map(Option.getOrNull), Effect.mapError(storageError)),
    allocateThreadId: (projectId) =>
      ids.allocate.thread({ projectId }).pipe(Effect.mapError(storageError)),
    launchThread: (input) =>
      threadLaunch
        .launch({
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          generateTitle: false,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          workspaceStrategy: { type: "root" },
          initialMessage: { text: input.text, attachments: [] },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.mapError((cause) =>
            error("unavailable", `The thread could not be launched: ${cause.message}`),
          ),
          Effect.asVoid,
        ),
    readRoleSkill: (role, projectRoot) =>
      roleSkillSource(role, { projectRoot, baseDir }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
  });
});

export const layer = Layer.effect(FactoryService, make);
