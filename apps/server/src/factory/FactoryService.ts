// @effect-diagnostics nodeBuiltinImport:off - Hashes request payloads and mints manager ids.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_FACTORY_CONFIG,
  FactoryAssignment,
  FactoryConfig,
  FactoryConfigOverride,
  FactoryLogEntry,
  FactoryManager,
  FactoryOnboardingReport,
  FactoryOperationError,
  IssueRef,
  issueReadyColumnIds,
  MessageId,
  ModelSelection,
  resolveFactoryConfig,
  type FactoryAssignmentState,
  type FactoryAssignmentsEvent,
  type FactoryAssignmentsListInput,
  type FactoryAssignmentsSubscribeInput,
  type FactoryCommissionInput,
  type FactoryComplexity,
  type FactoryConfigGetInput,
  type FactoryConfigUpdateInput,
  type FactoryConfigView,
  type FactoryLogKind,
  type FactoryLogListInput,
  type FactoryManagersApproveOnboardingInput,
  type FactoryManagersCreateInput,
  type FactoryManagersEvent,
  type FactoryManagersListInput,
  type FactoryManagersPauseInput,
  type FactoryManagersResumeInput,
  type FactoryManagersRetireInput,
  type FactoryManagersSubscribeInput,
  type FactoryPickupInput,
  type FactoryReadyTicket,
  type FactoryRole,
  type FactoryRoleBrief,
  type FactoryStatus,
  type FactoryTeamSpec,
  type IssueAttemptsStartInput,
  type IssueAttemptsStartResult,
  type IssueBoardSummary,
  type IssueBoardView,
  type IssueOperationError,
  type IssueSummary,
  type OrchestrationProjectShell,
  type OrchestrationV2RunStatus,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
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
import { canonicalIssueKey } from "../issues/IssueHost.ts";
import { IssueService } from "../issues/IssueService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
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

/** What reconciling a lead reads from its thread. */
export interface FactoryThreadRuns {
  readonly deleted: boolean;
  /** The status of the run with the highest ordinal. */
  readonly latestRunStatus: OrchestrationV2RunStatus | null;
  readonly runInProgress: boolean;
}

/** A machine-authored message the factory queues behind the thread's current run. */
export interface FactoryThreadMessage {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly text: string;
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
  /** The project's connected boards. */
  readonly readBoards: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<IssueBoardSummary>, FactoryOperationError>;
  /** The board's stored copy. */
  readonly readBoard: (
    projectId: ProjectId,
    boardId: string,
  ) => Effect.Effect<IssueBoardView, FactoryOperationError>;
  readonly startAttempt: (
    input: IssueAttemptsStartInput,
  ) => Effect.Effect<IssueAttemptsStartResult, FactoryOperationError>;
  /** Null when the thread is unknown. */
  readonly readThreadRuns: (threadId: ThreadId) => Effect.Effect<FactoryThreadRuns | null>;
  readonly sendToThread: (
    input: FactoryThreadMessage,
  ) => Effect.Effect<void, FactoryOperationError>;
  /** The repository's default branch, else "main". */
  readonly resolveBaseRef: (cwd: string) => Effect.Effect<string>;
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
  /** The manager's capacity, live assignments and the Ready tickets waiting for it. */
  readonly status: (managerId: string) => Effect.Effect<FactoryStatus, FactoryOperationError>;
  /**
   * The manager in this thread judges a Ready ticket. `start` launches a lead and returns the
   * assignment; `skip` records the judgement and returns null. Every refusal is also logged.
   */
  readonly pickup: (
    managerThreadId: ThreadId,
    input: FactoryPickupInput,
  ) => Effect.Effect<FactoryAssignment | null, FactoryOperationError>;
  /** Work the user asked the manager in this thread for: no pickup guidance or size rule. */
  readonly commission: (
    managerThreadId: ThreadId,
    input: FactoryCommissionInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  readonly listAssignments: (
    input: FactoryAssignmentsListInput,
  ) => Effect.Effect<ReadonlyArray<FactoryAssignment>, FactoryOperationError>;
  readonly subscribeAssignments: (
    input: FactoryAssignmentsSubscribeInput,
  ) => Stream.Stream<FactoryAssignmentsEvent, FactoryOperationError>;
  readonly listLog: (
    input: FactoryLogListInput,
  ) => Effect.Effect<ReadonlyArray<FactoryLogEntry>, FactoryOperationError>;
  /** The assignment this thread is a member of, ended ones included, or null. */
  readonly assignmentForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<FactoryAssignment | null, FactoryOperationError>;
  /** Moves an active assignment whose lead thread was deleted or whose last run failed to stalled. */
  readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Reconciles every live lead, records a pickup wake for unjudged Ready tickets while there is
   * capacity, and delivers each active manager's undelivered wakes in one message.
   */
  readonly sweep: Effect.Effect<void>;
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
const decodeAssignmentValue = Schema.decodeUnknownEffect(FactoryAssignment);
const decodeLogValue = Schema.decodeUnknownEffect(FactoryLogEntry);
const parse = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(storageError));

const ENVIRONMENT_SCOPE = "environment";
const projectScope = (projectId: ProjectId) => `project:${projectId}`;

/** Assignments in these states hold the manager and block retiring it. */
const ACTIVE_ASSIGNMENT_STATES = [
  "active",
  "blocked",
  "waiting-user",
  "stalled",
  "retro",
] as const satisfies ReadonlyArray<FactoryAssignmentState>;
/** A retro still holds the manager but no longer takes a slot under the cap. */
const CAPACITY_STATES: ReadonlySet<string> = new Set<FactoryAssignmentState>([
  "active",
  "blocked",
  "waiting-user",
  "stalled",
]);

const DEFAULT_TEAM: FactoryTeamSpec = { preset: "custom", members: [] };

const STALLED_RUNS: Partial<Record<OrchestrationV2RunStatus, string>> = {
  failed: "failed",
  cancelled: "was cancelled",
  interrupted: "was interrupted",
  rolled_back: "was rolled back",
};

const stallReason = (runs: FactoryThreadRuns): string | null => {
  if (runs.deleted) return "The lead's thread was deleted.";
  if (runs.runInProgress || runs.latestRunStatus === null) return null;
  const phrase = STALLED_RUNS[runs.latestRunStatus];
  return phrase === undefined ? null : `The lead's latest run ${phrase}.`;
};

const managerStateProblem = (manager: FactoryManager): string | null => {
  switch (manager.state) {
    case "active":
      return null;
    case "onboarding":
      return `${manager.name} is still onboarding. Nothing starts until the user approves the onboarding report.`;
    case "manager-paused":
    case "project-paused":
      return `${manager.name} is paused. Nothing starts until the user resumes it.`;
    case "retired":
      return `${manager.name} is retired.`;
  }
};

const isPaused = (state: string) => state === "manager-paused" || state === "project-paused";

const ticketKey = (issue: IssueRef, updatedAt: string) =>
  `${canonicalIssueKey(issue)}\n${updatedAt}`;

const JudgedPayload = Schema.Struct({ issue: IssueRef, updatedAt: Schema.String });
const PickupWakePayload = Schema.Struct({
  tickets: Schema.Array(
    Schema.Struct({ issue: IssueRef, updatedAt: Schema.String, title: Schema.String }),
  ),
});
const StalledWakePayload = Schema.Struct({ title: Schema.String, reason: Schema.String });
const jsonDecoder =
  <A>(decode: (text: string) => Option.Option<A>) =>
  (text: string | null) =>
    text === null ? Option.none<A>() : decode(text);
const decodeJudged = jsonDecoder(Schema.decodeUnknownOption(Schema.fromJsonString(JudgedPayload)));
const decodePickupWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(PickupWakePayload)),
);
const decodeStalledWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(StalledWakePayload)),
);
const decodeIssueRef = jsonDecoder(Schema.decodeUnknownOption(Schema.fromJsonString(IssueRef)));

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

/** The approved control paths, or the proposed ones while onboarding. */
const protectedPathsOf = (manager: FactoryManager) =>
  manager.controlPaths.length > 0
    ? manager.controlPaths
    : (manager.onboardingReport?.controlPaths ?? []);

interface AssignmentRow {
  readonly id: string;
  readonly manager_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly brief: string;
  readonly completion_condition: string;
  readonly source: string;
  readonly issue_json: string | null;
  readonly attempt_id: string | null;
  readonly lead_thread_id: string | null;
  readonly board_id: string | null;
  readonly branch: string | null;
  readonly complexity: string;
  readonly state: string;
  readonly team_json: string;
  readonly recovery_used: number;
  readonly waiting_reason: string | null;
  readonly cancel_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ended_at: string | null;
}

interface LogRow {
  readonly sequence: number;
  readonly manager_id: string;
  readonly assignment_id: string | null;
  readonly kind: string;
  readonly reason: string;
  readonly payload_json: string | null;
  readonly at: string;
  readonly delivered_at: string | null;
}

/** A ticket in a Ready column of a connected board, as the stored copy shows it. */
interface ReadyItem {
  readonly issue: IssueSummary;
  readonly boardId: string;
  readonly columnId: string;
  readonly version: string | null;
}

/** What starting an assignment needs once the manager's checks passed. */
interface AssignmentPlan {
  readonly kind: Extract<FactoryLogKind, "pickup" | "commission">;
  readonly reason: string;
  readonly logPayload: unknown;
  readonly refusalPayload: unknown;
  readonly title: string;
  readonly brief: string;
  readonly completionCondition: string;
  readonly complexity: FactoryComplexity;
  readonly team: FactoryTeamSpec;
  readonly ticket: ReadyItem;
}

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
          WHERE a.manager_id=m.id AND a.state='waiting-user') AS waiting_on_you
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
        const text = renderRoleSkill(
          skill.text,
          skillFill(config, role, protectedPathsOf(manager)),
        );
        return { role, text, source: skill.source } satisfies FactoryRoleBrief;
      }),
    );

  const decodeAssignment = Effect.fnUntraced(function* (row: AssignmentRow) {
    return yield* decodeAssignmentValue({
      id: row.id,
      managerId: row.manager_id,
      projectId: row.project_id,
      title: row.title,
      brief: row.brief,
      completionCondition: row.completion_condition,
      source: row.source,
      issue: row.issue_json === null ? null : yield* parse(Schema.Unknown, row.issue_json),
      attemptId: row.attempt_id,
      leadThreadId: row.lead_thread_id,
      complexity: row.complexity,
      state: row.state,
      team: yield* parse(Schema.Unknown, row.team_json),
      recoveryUsed: row.recovery_used,
      waitingReason: row.waiting_reason,
      cancelReason: row.cancel_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
    }).pipe(Effect.mapError(storageError));
  });
  const readAssignment = Effect.fnUntraced(function* (id: string) {
    const rows = yield* sql<AssignmentRow>`SELECT * FROM factory_assignments WHERE id=${id}`;
    if (!rows[0]) return yield* error("not-found", "This assignment no longer exists.");
    return yield* decodeAssignment(rows[0]);
  });
  const liveAssignmentRows = (managerId: string) =>
    sql<AssignmentRow>`SELECT * FROM factory_assignments
        WHERE manager_id=${managerId} AND ${sql.in("state", ACTIVE_ASSIGNMENT_STATES)}
        ORDER BY created_at, id`;

  const writeLog = Effect.fnUntraced(function* (
    managerId: string,
    assignmentId: string | null,
    kind: FactoryLogKind,
    reason: string,
    payload: unknown,
  ) {
    yield* sql`INSERT INTO factory_log(manager_id,assignment_id,kind,reason,payload_json,at)
        VALUES(${managerId},${assignmentId},${kind},${reason.slice(0, 2000)},
        ${payload === null ? null : json(payload)},${yield* now})`;
  });
  const logPayloads = Effect.fnUntraced(function* (
    managerId: string,
    kinds: ReadonlyArray<FactoryLogKind>,
    reason: string | null = null,
  ) {
    const rows = yield* sql<{ payload_json: string | null }>`SELECT payload_json FROM factory_log
        WHERE manager_id=${managerId} AND ${sql.in("kind", kinds)}
        AND (${reason} IS NULL OR reason=${reason})`;
    return rows.map((row) => row.payload_json);
  });
  /** Tickets the manager picked up or skipped, keyed at the version it judged. */
  const judgedKeys = Effect.fnUntraced(function* (managerId: string) {
    const payloads = yield* logPayloads(managerId, ["pickup", "skip"]);
    return new Set(
      payloads.flatMap((text) =>
        Option.match(decodeJudged(text), {
          onNone: () => [],
          onSome: (payload) => [ticketKey(payload.issue, payload.updatedAt)],
        }),
      ),
    );
  });
  const wokenKeys = Effect.fnUntraced(function* (managerId: string) {
    const payloads = yield* logPayloads(managerId, ["wake"], "pickup");
    return new Set(
      payloads.flatMap((text) =>
        Option.match(decodePickupWake(text), {
          onNone: () => [],
          onSome: (payload) =>
            payload.tickets.map((ticket) => ticketKey(ticket.issue, ticket.updatedAt)),
        }),
      ),
    );
  });
  const liveIssueKeys = Effect.fnUntraced(function* (projectId: ProjectId) {
    const rows = yield* sql<{
      issue_json: string | null;
    }>`SELECT issue_json FROM factory_assignments
        WHERE project_id=${projectId} AND ${sql.in("state", ACTIVE_ASSIGNMENT_STATES)}`;
    return new Set(
      rows.flatMap((row) =>
        Option.match(decodeIssueRef(row.issue_json), {
          onNone: () => [],
          onSome: (issue) => [canonicalIssueKey(issue)],
        }),
      ),
    );
  });

  const readyItems = Effect.fnUntraced(function* (projectId: ProjectId) {
    const items: ReadyItem[] = [];
    for (const summary of yield* deps.readBoards(projectId)) {
      if (summary.mapping === null) continue;
      const view = yield* deps.readBoard(projectId, summary.id);
      const ready = new Set(issueReadyColumnIds(view.board.mapping ?? summary.mapping));
      for (const item of view.items) {
        if (item.columnId === null || !ready.has(item.columnId)) continue;
        items.push({
          issue: item.issue,
          boardId: summary.id,
          columnId: item.columnId,
          version: item.version,
        });
      }
    }
    return items;
  });
  /** Ready tickets with no live assignment, flagged when the manager already judged them. */
  const readyTickets = Effect.fnUntraced(function* (manager: FactoryManager) {
    const items = yield* readyItems(manager.projectId);
    const live = yield* liveIssueKeys(manager.projectId);
    const judged = yield* judgedKeys(manager.id);
    return items
      .filter((item) => !live.has(canonicalIssueKey(item.issue.ref)))
      .map((item): FactoryReadyTicket => ({
        ...item,
        judged: judged.has(ticketKey(item.issue.ref, item.issue.updatedAt)),
      }));
  });

  const status: FactoryServiceShape["status"] = (managerId) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* readManager(managerId);
        const config = (yield* configView(manager.projectId)).effective;
        const assignments = yield* Effect.forEach(
          yield* liveAssignmentRows(manager.id),
          decodeAssignment,
        );
        const activeCount = assignments.filter((assignment) =>
          CAPACITY_STATES.has(assignment.state),
        ).length;
        return {
          manager,
          concurrencyCap: config.concurrencyCap,
          activeCount,
          capacityFree: activeCount < config.concurrencyCap,
          assignments,
          readyTickets: yield* readyTickets(manager),
          pickupGuidance: config.pickupGuidance,
        } satisfies FactoryStatus;
      }),
    );

  const requireManager = Effect.fnUntraced(function* (threadId: ThreadId) {
    const row = yield* managerRowForThread(threadId);
    if (row === null)
      return yield* error("not-found", "This thread is not an engineering manager.");
    return yield* decodeManager(row);
  });

  /** Fails with the refusal after logging it, so the manager's judgement trail shows it too. */
  const refuse = (
    managerId: string,
    reason: "conflict" | "invalid",
    message: string,
    payload: unknown,
  ) =>
    lock(writeLog(managerId, null, "refused", message, payload)).pipe(
      Effect.andThen(Effect.fail(error(reason, message))),
    );

  const findReadyTicket = Effect.fnUntraced(function* (projectId: ProjectId, issueNumber: number) {
    const matches = (yield* readyItems(projectId)).filter(
      (item) => item.issue.ref.number === issueNumber,
    );
    const distinct = new Set(matches.map((item) => canonicalIssueKey(item.issue.ref)));
    if (distinct.size > 1)
      return {
        found: false,
        reason: "invalid",
        message: `#${issueNumber} matches Ready tickets in more than one repository.`,
      } as const;
    const ticket = matches[0];
    if (ticket === undefined)
      return {
        found: false,
        reason: "conflict",
        message: `#${issueNumber} is not in a Ready column on a connected board.`,
      } as const;
    return { found: true, ticket } as const;
  });

  const leadPrompt = Effect.fnUntraced(function* (
    manager: FactoryManager,
    config: FactoryConfig,
    workspaceRoot: string,
    plan: AssignmentPlan,
  ) {
    const skill = yield* deps.readRoleSkill("lead", workspaceRoot);
    const role = renderRoleSkill(skill.text, {
      ...skillFill(config, "lead", protectedPathsOf(manager)),
      completionCondition: plan.completionCondition,
    });
    return `${role}\n\n# Assignment\n\n## ${plan.title}\n\n${plan.brief}\n\n## Completion condition\n\n${plan.completionCondition}`;
  });

  /**
   * Reserves the slot and the ticket, launches the lead through an issue attempt outside the lock,
   * then records the lead. A failed launch removes the reservation and logs the refusal.
   */
  const startAssignment = Effect.fnUntraced(function* (
    manager: FactoryManager,
    config: FactoryConfig,
    plan: AssignmentPlan,
  ) {
    const refusal = (reason: "conflict" | "invalid", message: string) =>
      refuse(manager.id, reason, message, plan.refusalPayload);
    const pool = new Set(config.modelPool.map(modelKey));
    const outside = plan.team.members
      .flatMap((member) => member.models ?? [])
      .find((selection) => !pool.has(modelKey(selection)));
    if (outside)
      return yield* refusal(
        "invalid",
        `${outside.model} (${outside.instanceId}) is not in the model pool.`,
      );
    const modelSelection = config.roleModels.lead[plan.complexity] ?? config.modelPool[0];
    if (modelSelection === undefined)
      return yield* refusal("invalid", "Add at least one model to the factory pool first.");
    const issue = plan.ticket.issue.ref;
    const issueKey = canonicalIssueKey(issue);
    const branch = sanitizeFeatureBranchName(`factory/issue-${issue.number}`);
    const id = NodeCrypto.randomUUID();
    const reserved = yield* lock(
      Effect.gen(function* () {
        const current = yield* readManager(manager.id);
        const problem = managerStateProblem(current);
        if (problem !== null) return ["conflict", problem] as const;
        const live = yield* liveAssignmentRows(manager.id);
        const taken = live.filter((row) => CAPACITY_STATES.has(row.state)).length;
        if (taken >= config.concurrencyCap)
          return [
            "conflict",
            `All ${config.concurrencyCap} assignment slots are in use. Wait for one to finish.`,
          ] as const;
        if ((yield* liveIssueKeys(manager.projectId)).has(issueKey))
          return ["conflict", `#${issue.number} already has a live assignment.`] as const;
        const at = yield* now;
        yield* writeLog(manager.id, id, plan.kind, plan.reason, plan.logPayload);
        yield* sql`INSERT INTO factory_assignments(id,manager_id,project_id,title,brief,
            completion_condition,source,issue_json,board_id,branch,complexity,state,team_json,
            created_at,updated_at)
            VALUES(${id},${manager.id},${manager.projectId},${plan.title},${plan.brief},
            ${plan.completionCondition},'ticket',${json(issue)},${plan.ticket.boardId},${branch},
            ${plan.complexity},'active',${json(plan.team)},${at},${at})`;
        return null;
      }),
    );
    if (reserved !== null) return yield* refusal(...reserved);

    const launched = yield* Effect.gen(function* () {
      const shell = yield* project(manager.projectId);
      return yield* deps.startAttempt({
        requestId: `factory-assignment:${id}`,
        boardId: plan.ticket.boardId,
        issue,
        projectId: manager.projectId,
        prompt: yield* leadPrompt(manager, config, shell.workspaceRoot, plan),
        branch,
        baseRef: yield* deps.resolveBaseRef(shell.workspaceRoot),
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
    }).pipe(Effect.result);
    if (launched._tag === "Failure") {
      yield* lock(
        Effect.gen(function* () {
          yield* sql`DELETE FROM factory_log WHERE assignment_id=${id}`;
          yield* sql`DELETE FROM factory_assignments WHERE id=${id}`;
          yield* writeLog(
            manager.id,
            null,
            "refused",
            `The lead could not start: ${launched.failure.message}`,
            plan.refusalPayload,
          );
        }),
      );
      return yield* launched.failure;
    }
    const { attempt, threadId } = launched.success;
    yield* lock(
      Effect.gen(function* () {
        const at = yield* now;
        yield* sql`UPDATE factory_assignments SET attempt_id=${attempt.id},lead_thread_id=${threadId},
            updated_at=${at} WHERE id=${id}`;
        yield* sql`INSERT INTO factory_members(thread_id,manager_id,assignment_id,role,
            parent_thread_id,joined,created_at)
            VALUES(${threadId},${manager.id},${id},'lead',${manager.threadId},'created',${at})
            ON CONFLICT(thread_id) DO NOTHING`;
      }),
    );
    yield* publish;
    return yield* readAssignment(id);
  });

  const ticketTitle = (issue: IssueSummary) =>
    (issue.title.trim() || `Issue #${issue.ref.number}`).slice(0, 200);

  const pickup: FactoryServiceShape["pickup"] = (managerThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* requireManager(managerThreadId);
        const refusalPayload = { issueNumber: input.issueNumber, decision: input.decision };
        const refusal = (reason: "conflict" | "invalid", message: string) =>
          refuse(manager.id, reason, message, refusalPayload);
        const problem = managerStateProblem(manager);
        if (problem !== null) return yield* refusal("conflict", problem);
        const found = yield* findReadyTicket(manager.projectId, input.issueNumber);
        if (!found.found) return yield* refusal(found.reason, found.message);
        const { ticket } = found;
        const judged = {
          issue: ticket.issue.ref,
          updatedAt: ticket.issue.updatedAt,
          complexity: input.complexity,
        };
        if (input.decision === "skip") {
          yield* lock(writeLog(manager.id, null, "skip", input.reason, judged));
          return null;
        }
        if (input.complexity === "large")
          return yield* refusal(
            "conflict",
            "Large tickets never start on their own. Recommend it to the user instead.",
          );
        const brief = input.brief ?? "";
        const completionCondition = input.completionCondition ?? "";
        if (brief === "" || completionCondition === "")
          return yield* refusal(
            "invalid",
            "Starting a ticket needs a brief and a completion condition.",
          );
        const config = (yield* configView(manager.projectId)).effective;
        return yield* startAssignment(manager, config, {
          kind: "pickup",
          reason: input.reason,
          logPayload: judged,
          refusalPayload,
          title: ticketTitle(ticket.issue),
          brief,
          completionCondition,
          complexity: input.complexity,
          team: input.team ?? DEFAULT_TEAM,
          ticket,
        });
      }),
    );

  const commission: FactoryServiceShape["commission"] = (managerThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* requireManager(managerThreadId);
        const refusalPayload = { title: input.title, issueNumber: input.issueNumber ?? null };
        const refusal = (reason: "conflict" | "invalid", message: string) =>
          refuse(manager.id, reason, message, refusalPayload);
        const problem = managerStateProblem(manager);
        if (problem !== null) return yield* refusal("conflict", problem);
        // A lead without a ticket needs a worktree launch outside issue attempts, which the
        // factory does not have yet.
        if (input.issueNumber === undefined)
          return yield* refusal(
            "invalid",
            "Commissioning without a ticket arrives in a later slice.",
          );
        const found = yield* findReadyTicket(manager.projectId, input.issueNumber);
        if (!found.found) return yield* refusal(found.reason, found.message);
        const { ticket } = found;
        const config = (yield* configView(manager.projectId)).effective;
        return yield* startAssignment(manager, config, {
          kind: "commission",
          reason: input.title,
          logPayload: { issue: ticket.issue.ref, updatedAt: ticket.issue.updatedAt },
          refusalPayload,
          title: input.title,
          brief: input.brief,
          completionCondition: input.completionCondition,
          complexity: input.complexity,
          team: input.team ?? DEFAULT_TEAM,
          ticket,
        });
      }),
    );

  const listAssignments: FactoryServiceShape["listAssignments"] = (input) =>
    protect(
      Effect.gen(function* () {
        const rows = yield* sql<AssignmentRow>`SELECT * FROM factory_assignments
            WHERE (${input.projectId ?? null} IS NULL OR project_id=${input.projectId ?? null})
            AND (${input.managerId ?? null} IS NULL OR manager_id=${input.managerId ?? null})
            AND (${input.includeEnded ? 1 : 0}=1 OR ${sql.in("state", ACTIVE_ASSIGNMENT_STATES)})
            ORDER BY created_at, id`;
        return yield* Effect.forEach(rows, decodeAssignment);
      }),
    );

  const assignmentsEvent = Effect.fnUntraced(function* () {
    const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 24 }));
    const rows = yield* sql<AssignmentRow>`SELECT * FROM factory_assignments
        WHERE ${sql.in("state", ACTIVE_ASSIGNMENT_STATES)} OR ended_at >= ${since}
        ORDER BY created_at, id`;
    return {
      assignments: yield* Effect.forEach(rows, decodeAssignment),
    } satisfies FactoryAssignmentsEvent;
  });

  const subscribeAssignments: FactoryServiceShape["subscribeAssignments"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.make(yield* assignmentsEvent()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => assignmentsEvent())),
        );
      }).pipe(Effect.mapError(preserveError)),
    ).pipe(
      Stream.mapError(preserveError),
      Stream.changesWith((left, right) => json(left) === json(right)),
      Stream.scoped,
    );

  const decodeLog = Effect.fnUntraced(function* (row: LogRow) {
    return yield* decodeLogValue({
      sequence: row.sequence,
      managerId: row.manager_id,
      assignmentId: row.assignment_id,
      kind: row.kind,
      reason: row.reason,
      payload: row.payload_json === null ? null : yield* parse(Schema.Unknown, row.payload_json),
      at: row.at,
      deliveredAt: row.delivered_at,
    }).pipe(Effect.mapError(storageError));
  });

  const listLog: FactoryServiceShape["listLog"] = (input) =>
    protect(
      Effect.gen(function* () {
        const rows = yield* sql<LogRow>`SELECT * FROM factory_log
            WHERE manager_id=${input.managerId}
            AND (${input.before ?? null} IS NULL OR sequence < ${input.before ?? null})
            ORDER BY sequence DESC LIMIT ${input.limit ?? 100}`;
        return yield* Effect.forEach(rows, decodeLog);
      }),
    );

  const assignmentForThread: FactoryServiceShape["assignmentForThread"] = (threadId) =>
    protect(
      Effect.gen(function* () {
        const rows = yield* sql<AssignmentRow>`SELECT a.* FROM factory_assignments a
            WHERE a.lead_thread_id=${threadId} OR a.id IN
              (SELECT assignment_id FROM factory_members WHERE thread_id=${threadId})
            ORDER BY a.created_at DESC, a.id LIMIT 1`;
        return rows[0] ? yield* decodeAssignment(rows[0]) : null;
      }),
    );

  /** Writes the stall and, unless the manager is paused, the wake that tells it. */
  const markStalled = Effect.fnUntraced(function* (id: string, reason: string) {
    const rows = yield* sql<AssignmentRow & { manager_state: string }>`
        SELECT a.*, m.state AS manager_state FROM factory_assignments a
        JOIN factory_managers m ON m.id=a.manager_id WHERE a.id=${id}`;
    const row = rows[0];
    if (!row || row.state !== "active") return false;
    yield* sql`UPDATE factory_assignments SET state='stalled',waiting_reason=${reason},
        updated_at=${yield* now} WHERE id=${id}`;
    yield* writeLog(row.manager_id, id, "stalled", reason, { leadThreadId: row.lead_thread_id });
    if (!isPaused(row.manager_state))
      yield* writeLog(row.manager_id, id, "wake", "stalled", { title: row.title, reason });
    return true;
  });

  const reconcileLead = Effect.fnUntraced(function* (threadId: ThreadId) {
    const rows = yield* sql<{ id: string }>`SELECT id FROM factory_assignments
        WHERE lead_thread_id=${threadId} AND state='active'`;
    if (!rows[0]) return;
    const runs = yield* deps.readThreadRuns(threadId);
    if (runs === null) return;
    // A completed run is left alone: completion claims arrive in slice 4.
    const reason = stallReason(runs);
    if (reason === null) return;
    if (yield* lock(markStalled(rows[0].id, reason))) yield* publish;
  });

  const reconcileThread: FactoryServiceShape["reconcileThread"] = (threadId) =>
    protect(reconcileLead(threadId)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reconcile a factory lead thread", { threadId, cause }),
      ),
    );

  const queuePickupWake = Effect.fnUntraced(function* (manager: FactoryManager) {
    const config = (yield* configView(manager.projectId)).effective;
    const live = yield* liveAssignmentRows(manager.id);
    const taken = live.filter((row) => CAPACITY_STATES.has(row.state)).length;
    if (taken >= config.concurrencyCap) return;
    const unjudged = (yield* readyTickets(manager)).filter((ticket) => !ticket.judged);
    if (unjudged.length === 0) return;
    yield* lock(
      Effect.gen(function* () {
        const woken = yield* wokenKeys(manager.id);
        const due = unjudged.filter(
          (ticket) => !woken.has(ticketKey(ticket.issue.ref, ticket.issue.updatedAt)),
        );
        if (due.length === 0) return;
        yield* writeLog(manager.id, null, "wake", "pickup", {
          tickets: due.map((ticket) => ({
            issue: ticket.issue.ref,
            updatedAt: ticket.issue.updatedAt,
            title: ticket.issue.title,
          })),
        });
      }),
    );
  });

  const wakeText = (rows: ReadonlyArray<LogRow>) => {
    const tickets = rows.flatMap((row) =>
      row.reason === "pickup"
        ? Option.match(decodePickupWake(row.payload_json), {
            onNone: () => [],
            onSome: (payload) => payload.tickets,
          })
        : [],
    );
    const lines: string[] = [];
    if (tickets.length > 0)
      lines.push(
        `These Ready tickets are waiting for your judgement: ${tickets
          .map((ticket) => `#${ticket.issue.number} ${ticket.title} (${ticket.issue.url})`)
          .join(", ")}; call factory_status, then factory_pickup for each.`,
      );
    for (const row of rows) {
      if (row.reason !== "stalled") continue;
      Option.map(decodeStalledWake(row.payload_json), (payload) =>
        lines.push(
          `Assignment ${payload.title} stalled: ${payload.reason} Investigate its lead thread and decide.`,
        ),
      );
    }
    return lines.join("\n\n");
  };

  const deliverWakes = Effect.fnUntraced(function* (manager: FactoryManager) {
    if (manager.threadId === null) return;
    const rows = yield* sql<LogRow>`SELECT * FROM factory_log
        WHERE manager_id=${manager.id} AND kind='wake' AND delivered_at IS NULL
        ORDER BY sequence`;
    if (rows.length === 0) return;
    const text = wakeText(rows);
    if (text !== "") {
      const sent = yield* deps
        .sendToThread({
          projectId: manager.projectId,
          threadId: manager.threadId,
          // A rejected command id stays rejected, so each delivery attempt needs its own.
          commandId: CommandId.make(`factory-wake:${manager.id}:${NodeCrypto.randomUUID()}`),
          text,
        })
        .pipe(Effect.result);
      if (sent._tag === "Failure")
        return yield* Effect.logWarning("Could not wake the engineering manager", {
          managerId: manager.id,
          cause: sent.failure.message,
        });
    }
    const at = yield* now;
    yield* lock(
      sql`UPDATE factory_log SET delivered_at=${at} WHERE ${sql.in(
        "sequence",
        rows.map((row) => row.sequence),
      )}`,
    );
  });

  const sweepManager = Effect.fnUntraced(function* (managerId: string) {
    const leads = yield* sql<{ lead_thread_id: string }>`SELECT lead_thread_id
        FROM factory_assignments WHERE manager_id=${managerId} AND lead_thread_id IS NOT NULL
        AND ${sql.in("state", ACTIVE_ASSIGNMENT_STATES)}`;
    for (const lead of leads) yield* reconcileLead(ThreadId.make(lead.lead_thread_id));
    const manager = yield* readManager(managerId);
    if (manager.state !== "active") return;
    yield* queuePickupWake(manager);
    yield* deliverWakes(manager);
  });

  const sweep: FactoryServiceShape["sweep"] = protect(
    Effect.gen(function* () {
      for (const manager of yield* currentManagers())
        yield* protect(sweepManager(manager.id)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not sweep an engineering manager", {
              managerId: manager.id,
              cause: cause.message,
            }),
          ),
        );
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not sweep the engineering factory", { cause: cause.message }),
    ),
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
    status,
    pickup,
    commission,
    listAssignments,
    subscribeAssignments,
    listLog,
    assignmentForThread,
    reconcileThread,
    sweep,
  } satisfies FactoryServiceShape;
});

const fromIssueError = (cause: IssueOperationError) =>
  error(
    cause.reason === "invalid" || cause.reason === "conflict" || cause.reason === "not-found"
      ? cause.reason
      : "unavailable",
    cause.message,
  );

const RUNS_IN_PROGRESS = new Set<OrchestrationV2RunStatus>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const issues = yield* IssueService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
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
    readBoards: (projectId) =>
      issues.listBoards({ projectId, connectedOnly: true }).pipe(Effect.mapError(fromIssueError)),
    // Serves the stored copy; one older than 30 seconds also queues a background refresh, which
    // is how a board nobody has open still shows the factory new Ready tickets.
    readBoard: (projectId, boardId) =>
      issues.openBoard({ projectId, boardId }).pipe(Effect.mapError(fromIssueError)),
    startAttempt: (input) => issues.startAttempt(input).pipe(Effect.mapError(fromIssueError)),
    readThreadRuns: (threadId) =>
      orchestrator.getThreadRecords(threadId, ["runs"]).pipe(
        Effect.map(({ thread, runs }) => ({
          deleted: thread.deletedAt !== null,
          latestRunStatus:
            runs.reduce<(typeof runs)[number] | undefined>(
              (latest, run) =>
                latest === undefined || run.ordinal > latest.ordinal ? run : latest,
              undefined,
            )?.status ?? null,
          runInProgress: runs.some((run) => RUNS_IN_PROGRESS.has(run.status)),
        })),
        Effect.catchCause((cause) =>
          Effect.logDebug("factory lead thread unavailable", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
    sendToThread: (input) =>
      threads
        .sendToThread({
          projectId: input.projectId,
          commandId: input.commandId,
          threadId: input.threadId,
          messageId: MessageId.make(`message:${input.commandId}`),
          text: input.text,
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((cause) =>
            error("unavailable", `The message could not be sent: ${cause.message}`),
          ),
          Effect.asVoid,
        ),
    // Same source GitManager falls back to: the primary remote's HEAD symbolic ref.
    resolveBaseRef: (cwd) =>
      git.resolvePrimaryRemoteName(cwd).pipe(
        Effect.flatMap((remote) => git.resolveDefaultBranchName(cwd, remote)),
        Effect.map((branch) => branch ?? "main"),
        Effect.orElseSucceed(() => "main"),
      ),
  });
});

export const layer = Layer.effect(FactoryService, make);
