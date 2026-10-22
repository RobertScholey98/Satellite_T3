import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * The engineering factory: a standing manager per project that commissions assignments to leads.
 * Satellite-owned; nothing here enters upstream's thread contracts or event log.
 */
export const FACTORY_WS_METHODS = {
  factoryConfigGet: "factory.config.get",
  factoryConfigUpdate: "factory.config.update",
  factoryManagersList: "factory.managers.list",
  factoryManagersSubscribe: "factory.managers.subscribe",
  factoryManagersCreate: "factory.managers.create",
  factoryManagersPause: "factory.managers.pause",
  factoryManagersResume: "factory.managers.resume",
  factoryManagersRetire: "factory.managers.retire",
} as const;

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const FactoryRole = Schema.Literals([
  "manager",
  "lead",
  "implementer",
  "reviewer",
  "verifier",
]);
export type FactoryRole = typeof FactoryRole.Type;

/** The agent types a lead staffs a team from. */
export const FactoryWorkerRole = Schema.Literals(["implementer", "reviewer", "verifier"]);
export type FactoryWorkerRole = typeof FactoryWorkerRole.Type;

/** `large` never auto-starts, whatever the pickup guidance says. */
export const FactoryComplexity = Schema.Literals(["small", "medium", "large"]);
export type FactoryComplexity = typeof FactoryComplexity.Type;

export const FactoryTeamMember = Schema.Struct({
  role: FactoryWorkerRole,
  count: PositiveInt.check(Schema.isLessThanOrEqualTo(8)),
  /** Narrows the pool for this member; absent means the role's allow-list. */
  models: Schema.optionalKey(Schema.Array(ModelSelection)),
});
export type FactoryTeamMember = typeof FactoryTeamMember.Type;

export const FactoryTeamPreset = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  /** Free text the manager matches against a ticket. */
  useWhen: TrimmedString.check(Schema.isMaxLength(1000)),
  members: Schema.Array(FactoryTeamMember).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  /** Free text the lead follows, such as the order of implementation, review and verification. */
  workflow: TrimmedString.check(Schema.isMaxLength(2000)),
  createdBy: Schema.Literals(["user", "manager"]),
});
export type FactoryTeamPreset = typeof FactoryTeamPreset.Type;

const OptionalModel = Schema.NullOr(ModelSelection).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
const ModelList = Schema.Array(ModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed([])));

/** Every model named here must be in the pool. Absent means the pool. */
export const FactoryRoleModels = Schema.Struct({
  manager: OptionalModel,
  lead: Schema.Struct({ small: OptionalModel, medium: OptionalModel, large: OptionalModel }).pipe(
    Schema.withDecodingDefault(Effect.succeed({ small: null, medium: null, large: null })),
  ),
  workers: Schema.Struct({
    implementer: ModelList,
    reviewer: ModelList,
    verifier: ModelList,
  }).pipe(
    Schema.withDecodingDefault(Effect.succeed({ implementer: [], reviewer: [], verifier: [] })),
  ),
});
export type FactoryRoleModels = typeof FactoryRoleModels.Type;

/** Off by default: managed work pushes and opens pull requests as the user. */
export const FactoryGitIdentity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("github-app"),
    appId: TrimmedNonEmptyString,
    installationId: TrimmedNonEmptyString,
    /** The name of the private key in the environment's secret store, never the key. */
    privateKeySecret: TrimmedNonEmptyString,
  }),
]);
export type FactoryGitIdentity = typeof FactoryGitIdentity.Type;

const PickupGuidance = TrimmedString.check(Schema.isMaxLength(4000));
const ConcurrencyCap = PositiveInt.check(Schema.isLessThanOrEqualTo(20));
const RecoveryAllowance = NonNegativeInt.check(Schema.isLessThanOrEqualTo(10));
const DigestIntervalMinutes = PositiveInt.check(Schema.isLessThanOrEqualTo(24 * 60));
const TeamPresets = Schema.Array(FactoryTeamPreset);

export const FactoryConfig = Schema.Struct({
  /** Judged by the manager against each Ready ticket; empty means nothing auto-starts. */
  pickupGuidance: PickupGuidance.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  concurrencyCap: ConcurrencyCap.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
  /** Diagnosis-and-replan cycles per assignment. */
  recoveryAllowance: RecoveryAllowance.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  digestIntervalMinutes: DigestIntervalMinutes.pipe(Schema.withDecodingDefault(Effect.succeed(10))),
  /** No manager starts while this is empty. */
  modelPool: ModelList,
  roleModels: FactoryRoleModels.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(FactoryRoleModels)({}))),
  ),
  teamPresets: TeamPresets.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  gitIdentity: FactoryGitIdentity.pipe(
    Schema.withDecodingDefault(Effect.succeed({ kind: "user" as const })),
  ),
});
export type FactoryConfig = typeof FactoryConfig.Type;

export const DEFAULT_FACTORY_CONFIG: FactoryConfig = Schema.decodeSync(FactoryConfig)({});

/**
 * A project's overrides: an absent key inherits the environment value, and a present one survives
 * environment changes until cleared. The git identity is an environment setting only. The fields
 * carry no decoding default on purpose: a default here would turn an absent key into a value and
 * silently reset the environment's.
 */
export const FactoryConfigOverride = Schema.Struct({
  pickupGuidance: Schema.optionalKey(PickupGuidance),
  concurrencyCap: Schema.optionalKey(ConcurrencyCap),
  recoveryAllowance: Schema.optionalKey(RecoveryAllowance),
  digestIntervalMinutes: Schema.optionalKey(DigestIntervalMinutes),
  modelPool: Schema.optionalKey(Schema.Array(ModelSelection)),
  roleModels: Schema.optionalKey(FactoryRoleModels),
  /** Added to the environment's presets; one with the same name replaces it. */
  teamPresets: Schema.optionalKey(TeamPresets),
});
export type FactoryConfigOverride = typeof FactoryConfigOverride.Type;

/** The environment config with a project's overrides applied. Presets merge by name. */
export const resolveFactoryConfig = (
  environment: FactoryConfig,
  override: FactoryConfigOverride | null,
): FactoryConfig => {
  if (override === null) return environment;
  const { teamPresets, ...replaced } = override;
  const presets =
    teamPresets === undefined
      ? environment.teamPresets
      : [
          ...environment.teamPresets.filter(
            (preset) => !teamPresets.some((own) => own.name === preset.name),
          ),
          ...teamPresets,
        ];
  return { ...environment, ...replaced, teamPresets: presets };
};

export const FactoryConfigView = Schema.Struct({
  environment: FactoryConfig,
  /** Absent without a project; null for a project with no overrides. */
  override: Schema.optional(Schema.NullOr(FactoryConfigOverride)),
  effective: FactoryConfig,
  /** False until the environment config was saved once; the client offers a starting point. */
  configured: Schema.Boolean,
});
export type FactoryConfigView = typeof FactoryConfigView.Type;

/** `retired` is terminal; the project can then get a new manager. */
export const FactoryManagerState = Schema.Literals([
  "onboarding",
  "active",
  "manager-paused",
  "project-paused",
  "retired",
]);
export type FactoryManagerState = typeof FactoryManagerState.Type;

export const FactoryManager = Schema.Struct({
  id: Id,
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  state: FactoryManagerState,
  /** Null until onboarding launches the manager's thread. */
  threadId: Schema.NullOr(ThreadId),
  /** Protected control paths, approved by the user at the end of onboarding. */
  controlPaths: Schema.Array(Schema.String),
  onboardingNotes: Schema.String,
  /** Assignments that are not completed or cancelled. */
  activeAssignments: NonNegativeInt,
  /** Assignments waiting on the user. */
  waitingOnYou: NonNegativeInt,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type FactoryManager = typeof FactoryManager.Type;

export class FactoryOperationError extends Schema.TaggedError<FactoryOperationError>()(
  "FactoryOperationError",
  {
    reason: Schema.Literals(["unavailable", "invalid", "conflict", "not-found", "storage"]),
    message: Schema.String,
  },
) {}

export const FactoryConfigGetInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type FactoryConfigGetInput = typeof FactoryConfigGetInput.Type;

export const FactoryConfigUpdateInput = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("environment"), config: FactoryConfig }),
  Schema.Struct({
    scope: Schema.Literal("project"),
    projectId: ProjectId,
    /** Null clears every override. */
    override: Schema.NullOr(FactoryConfigOverride),
  }),
]);
export type FactoryConfigUpdateInput = typeof FactoryConfigUpdateInput.Type;

/** Without a project, lists every manager on the environment, retired ones included. */
export const FactoryManagersListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  includeRetired: Schema.optional(Schema.Boolean),
});
export type FactoryManagersListInput = typeof FactoryManagersListInput.Type;

export const FactoryManagersSubscribeInput = Schema.Struct({});
export type FactoryManagersSubscribeInput = typeof FactoryManagersSubscribeInput.Type;

/** The environment's current managers, sent whole: there is at most one per project. */
export const FactoryManagersEvent = Schema.Struct({ managers: Schema.Array(FactoryManager) });
export type FactoryManagersEvent = typeof FactoryManagersEvent.Type;

/** `requestId` keys the creation, so a repeated request returns the same manager. */
export const FactoryManagersCreateInput = Schema.Struct({
  requestId: Id,
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type FactoryManagersCreateInput = typeof FactoryManagersCreateInput.Type;

/** `manager` pauses only the manager; teams keep working. `project` also holds every team. */
export const FactoryManagersPauseInput = Schema.Struct({
  requestId: Id,
  managerId: Id,
  scope: Schema.Literals(["manager", "project"]),
});
export type FactoryManagersPauseInput = typeof FactoryManagersPauseInput.Type;

export const FactoryManagersResumeInput = Schema.Struct({ requestId: Id, managerId: Id });
export type FactoryManagersResumeInput = typeof FactoryManagersResumeInput.Type;

/** Refused while the manager has active assignments. */
export const FactoryManagersRetireInput = Schema.Struct({ requestId: Id, managerId: Id });
export type FactoryManagersRetireInput = typeof FactoryManagersRetireInput.Type;

const FactoryRpcError = Schema.Union([FactoryOperationError, EnvironmentAuthorizationError]);

export const WsFactoryConfigGetRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigGet, {
  payload: FactoryConfigGetInput,
  success: FactoryConfigView,
  error: FactoryRpcError,
});
export const WsFactoryConfigUpdateRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigUpdate, {
  payload: FactoryConfigUpdateInput,
  success: FactoryConfigView,
  error: FactoryRpcError,
});
export const WsFactoryManagersListRpc = Rpc.make(FACTORY_WS_METHODS.factoryManagersList, {
  payload: FactoryManagersListInput,
  success: Schema.Array(FactoryManager),
  error: FactoryRpcError,
});
export const WsFactoryManagersSubscribeRpc = Rpc.make(FACTORY_WS_METHODS.factoryManagersSubscribe, {
  payload: FactoryManagersSubscribeInput,
  success: FactoryManagersEvent,
  error: FactoryRpcError,
  stream: true,
});
export const WsFactoryManagersCreateRpc = Rpc.make(FACTORY_WS_METHODS.factoryManagersCreate, {
  payload: FactoryManagersCreateInput,
  success: FactoryManager,
  error: FactoryRpcError,
});
export const WsFactoryManagersPauseRpc = Rpc.make(FACTORY_WS_METHODS.factoryManagersPause, {
  payload: FactoryManagersPauseInput,
  success: FactoryManager,
  error: FactoryRpcError,
});
export const WsFactoryManagersResumeRpc = Rpc.make(FACTORY_WS_METHODS.factoryManagersResume, {
  payload: FactoryManagersResumeInput,
  success: FactoryManager,
  error: FactoryRpcError,
});
export const WsFactoryManagersRetireRpc = Rpc.make(FACTORY_WS_METHODS.factoryManagersRetire, {
  payload: FactoryManagersRetireInput,
  success: FactoryManager,
  error: FactoryRpcError,
});
