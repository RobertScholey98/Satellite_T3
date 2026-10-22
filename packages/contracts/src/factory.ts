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
import { IssueRef, IssueSummary } from "./issues.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ThreadPullRequestKey } from "./threadPullRequest.ts";

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
  factoryManagersApproveOnboarding: "factory.managers.approveOnboarding",
  factoryAssignmentsList: "factory.assignments.list",
  factoryAssignmentsSubscribe: "factory.assignments.subscribe",
  factoryAssignmentsCancel: "factory.assignments.cancel",
  factoryThreadsTakeOver: "factory.threads.takeOver",
  factoryThreadsHandBack: "factory.threads.handBack",
  factoryLogList: "factory.log.list",
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

/** A role's skill text and where it came from: the project, the environment, or the built-in. */
export const FactoryRoleBrief = Schema.Struct({
  role: FactoryRole,
  text: Schema.String,
  source: Schema.Literals(["project", "environment", "default"]),
});
export type FactoryRoleBrief = typeof FactoryRoleBrief.Type;

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

const ControlPath = Schema.String.check(Schema.isMaxLength(300));
const ControlPaths = Schema.Array(ControlPath).check(Schema.isMaxLength(100));

/** What the manager learned while onboarding, proposed to the user for approval. */
export const FactoryOnboardingReport = Schema.Struct({
  summary: Schema.String.check(Schema.isMaxLength(4000)),
  /** Glob patterns relative to the repository root that no team may edit. */
  controlPaths: ControlPaths,
  boardGaps: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(50),
  ),
  openChoices: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(50),
  ),
});
export type FactoryOnboardingReport = typeof FactoryOnboardingReport.Type;

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
  /** The manager's onboarding proposal; kept after approval as the record of what was approved. */
  onboardingReport: Schema.NullOr(FactoryOnboardingReport),
  /** The model the manager's thread launched with. */
  modelSelection: Schema.NullOr(ModelSelection),
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
  /**
   * Must be in the project's effective model pool. Absent means the pool's manager model, else
   * the first model in the pool.
   */
  modelSelection: Schema.optionalKey(ModelSelection),
  /** Absent means `full-access`, because the factory runs unattended. */
  runtimeMode: Schema.optionalKey(RuntimeMode),
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

/**
 * Approves the manager's onboarding with the control paths the user settled on, and starts it.
 * The factory's own folder is always protected.
 */
export const FactoryManagersApproveOnboardingInput = Schema.Struct({
  requestId: Id,
  managerId: Id,
  controlPaths: ControlPaths,
});
export type FactoryManagersApproveOnboardingInput =
  typeof FactoryManagersApproveOnboardingInput.Type;

export const FactoryAssignmentSource = Schema.Literals([
  "ticket",
  "user",
  "dependency",
  "handover",
]);
export type FactoryAssignmentSource = typeof FactoryAssignmentSource.Type;

/**
 * `completed` and `cancelled` are terminal. `retro` still holds the manager but frees its slot
 * under the concurrency cap.
 */
export const FactoryAssignmentState = Schema.Literals([
  "active",
  "blocked",
  "waiting-user",
  "stalled",
  "retro",
  "completed",
  "cancelled",
]);
export type FactoryAssignmentState = typeof FactoryAssignmentState.Type;

/** The team an assignment asks its lead to staff: a preset's name or `custom`. */
export const FactoryTeamSpec = Schema.Struct({
  preset: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  members: Schema.Array(FactoryTeamMember).check(Schema.isMaxLength(12)),
});
export type FactoryTeamSpec = typeof FactoryTeamSpec.Type;

const AssignmentTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const AssignmentBrief = TrimmedString.check(Schema.isMaxLength(20_000));
const CompletionCondition = TrimmedString.check(Schema.isMaxLength(4000));
const DecisionReason = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));
const ClaimEvidence = TrimmedNonEmptyString.check(Schema.isMaxLength(8000));
const ClaimedPullRequests = Schema.Array(ThreadPullRequestKey).check(Schema.isMaxLength(50));
const DependencyTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const UnblockCondition = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));
const RequiredBrief = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));

/** The lead's claim that the completion condition is met. */
export const FactoryAssignmentClaim = Schema.Struct({
  evidence: Schema.String.check(Schema.isMaxLength(8000)),
  pullRequests: Schema.Array(ThreadPullRequestKey),
  claimedAt: Schema.String,
});
export type FactoryAssignmentClaim = typeof FactoryAssignmentClaim.Type;

/** The manager's judgement of the team once its retro is in. */
export const FactoryTeamVerdict = Schema.Struct({
  fit: Schema.Literals(["good", "poor"]),
  reason: DecisionReason,
});
export type FactoryTeamVerdict = typeof FactoryTeamVerdict.Type;

/**
 * Something outside an assignment's scope that blocks it. `delivered` once the assignment that
 * delivers it completes; `confirmed` once the blocked lead accepts it.
 */
export const FactoryDependency = Schema.Struct({
  id: Id,
  blockedAssignmentId: Id,
  deliveringAssignmentId: Schema.NullOr(Id),
  title: DependencyTitle,
  unblockCondition: Schema.String.check(Schema.isMaxLength(2000)),
  state: Schema.Literals(["open", "delivered", "confirmed"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type FactoryDependency = typeof FactoryDependency.Type;

export const FactoryAssignment = Schema.Struct({
  id: Id,
  managerId: Id,
  projectId: ProjectId,
  title: AssignmentTitle,
  brief: AssignmentBrief,
  completionCondition: CompletionCondition,
  source: FactoryAssignmentSource,
  issue: Schema.NullOr(IssueRef),
  /** The issue attempt that owns the lead's worktree and moves the ticket. */
  attemptId: Schema.NullOr(Id),
  leadThreadId: Schema.NullOr(ThreadId),
  complexity: FactoryComplexity,
  state: FactoryAssignmentState,
  team: FactoryTeamSpec,
  /** Diagnosis-and-replan cycles spent, against the config's recovery allowance. */
  recoveryUsed: NonNegativeInt,
  /** Why the assignment is blocked, stalled or waiting on the user. */
  waitingReason: Schema.NullOr(Schema.String),
  cancelReason: Schema.NullOr(Schema.String),
  claim: Schema.NullOr(FactoryAssignmentClaim),
  /** The user took over the lead's thread; the factory leaves it alone until handed back. */
  takenOver: Schema.Boolean,
  /** Dependencies reported against this assignment, delivered ones included. */
  dependencies: Schema.Array(FactoryDependency),
  teamVerdict: Schema.NullOr(FactoryTeamVerdict),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});
export type FactoryAssignment = typeof FactoryAssignment.Type;

/** `wake` rows are messages owed to the manager; they are written before the message is sent. */
export const FactoryLogKind = Schema.Literals([
  "pickup",
  "skip",
  "commission",
  "wake",
  "stalled",
  "refused",
  "claim",
  "dependency",
  "recovery",
  "takeover",
  "handback",
  "cancel",
  "complete",
]);
export type FactoryLogKind = typeof FactoryLogKind.Type;

export const FactoryLogEntry = Schema.Struct({
  sequence: PositiveInt,
  managerId: Id,
  assignmentId: Schema.NullOr(Id),
  kind: FactoryLogKind,
  reason: Schema.String.check(Schema.isMaxLength(2000)),
  /** The row's details as stored, or null. */
  payload: Schema.Unknown,
  at: Schema.String,
  /** Set on a `wake` row once the manager's thread accepted the message. */
  deliveredAt: Schema.NullOr(Schema.String),
});
export type FactoryLogEntry = typeof FactoryLogEntry.Type;

export const FactoryReadyTicket = Schema.Struct({
  issue: IssueSummary,
  boardId: Id,
  columnId: Id,
  version: Schema.NullOr(Schema.String),
  /** The manager already picked up or skipped this ticket as it is now. */
  judged: Schema.Boolean,
});
export type FactoryReadyTicket = typeof FactoryReadyTicket.Type;

export const FactoryStatus = Schema.Struct({
  manager: FactoryManager,
  concurrencyCap: PositiveInt,
  /** Assignments that take a slot under the cap: every live state except `retro`. */
  activeCount: NonNegativeInt,
  capacityFree: Schema.Boolean,
  /** Assignments that are not completed or cancelled. */
  assignments: Schema.Array(FactoryAssignment),
  /** Tickets in a Ready column of a connected board with no live assignment. */
  readyTickets: Schema.Array(FactoryReadyTicket),
  pickupGuidance: Schema.String,
});
export type FactoryStatus = typeof FactoryStatus.Type;

/** Without `includeEnded`, only assignments that are not completed or cancelled. */
export const FactoryAssignmentsListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  managerId: Schema.optional(Id),
  includeEnded: Schema.optional(Schema.Boolean),
});
export type FactoryAssignmentsListInput = typeof FactoryAssignmentsListInput.Type;

export const FactoryAssignmentsSubscribeInput = Schema.Struct({});
export type FactoryAssignmentsSubscribeInput = typeof FactoryAssignmentsSubscribeInput.Type;

/** Every live assignment on the environment plus those that ended in the last 24 hours. */
export const FactoryAssignmentsEvent = Schema.Struct({
  assignments: Schema.Array(FactoryAssignment),
});
export type FactoryAssignmentsEvent = typeof FactoryAssignmentsEvent.Type;

/** Newest first. `before` pages back from a sequence. */
export const FactoryLogListInput = Schema.Struct({
  managerId: Id,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(500))),
  before: Schema.optional(PositiveInt),
});
export type FactoryLogListInput = typeof FactoryLogListInput.Type;

/** The manager's judgement of one Ready ticket. `start` needs a brief and completion condition. */
export const FactoryPickupInput = Schema.Struct({
  issueNumber: PositiveInt,
  decision: Schema.Literals(["start", "skip"]),
  complexity: FactoryComplexity,
  reason: DecisionReason,
  brief: Schema.optionalKey(AssignmentBrief),
  completionCondition: Schema.optionalKey(CompletionCondition),
  team: Schema.optionalKey(FactoryTeamSpec),
});
export type FactoryPickupInput = typeof FactoryPickupInput.Type;

/** Work the user asked the manager for directly, outside the pickup guidance. */
export const FactoryCommissionInput = Schema.Struct({
  title: AssignmentTitle,
  brief: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  completionCondition: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  complexity: FactoryComplexity,
  issueNumber: Schema.optionalKey(PositiveInt),
  team: Schema.optionalKey(FactoryTeamSpec),
  /** An open dependency this assignment delivers; the blocked assignment stays blocked until then. */
  dependencyId: Schema.optionalKey(Id),
});
export type FactoryCommissionInput = typeof FactoryCommissionInput.Type;

/** The lead's completion claim. Pull requests linked on the lead's thread count too. */
export const FactoryClaimCompleteInput = Schema.Struct({
  evidence: ClaimEvidence,
  pullRequests: Schema.optionalKey(ClaimedPullRequests),
});
export type FactoryClaimCompleteInput = typeof FactoryClaimCompleteInput.Type;

/** The lead reports work outside its scope that blocks it. */
export const FactoryReportDependencyInput = Schema.Struct({
  title: DependencyTitle,
  brief: RequiredBrief,
  unblockCondition: UnblockCondition,
});
export type FactoryReportDependencyInput = typeof FactoryReportDependencyInput.Type;

/** The manager's diagnosis of a stalled assignment: brief the same lead again, or replace it. */
export const FactoryRecoverInput = Schema.Struct({
  assignmentId: Id,
  action: Schema.Literals(["rebrief", "replace"]),
  brief: RequiredBrief,
});
export type FactoryRecoverInput = typeof FactoryRecoverInput.Type;

/** Ends an assignment whose retro is in, with the manager's verdict on the team. */
export const FactoryCompleteInput = Schema.Struct({
  assignmentId: Id,
  teamVerdict: FactoryTeamVerdict,
});
export type FactoryCompleteInput = typeof FactoryCompleteInput.Type;

/** The lead still writes its retro; the assignment ends cancelled once the manager completes it. */
export const FactoryAssignmentsCancelInput = Schema.Struct({
  requestId: Id,
  assignmentId: Id,
  reason: DecisionReason,
});
export type FactoryAssignmentsCancelInput = typeof FactoryAssignmentsCancelInput.Type;

/** The user takes over a factory thread; the factory stops acting on it until handed back. */
export const FactoryThreadsTakeOverInput = Schema.Struct({ requestId: Id, threadId: ThreadId });
export type FactoryThreadsTakeOverInput = typeof FactoryThreadsTakeOverInput.Type;

export const FactoryThreadsHandBackInput = Schema.Struct({ requestId: Id, threadId: ThreadId });
export type FactoryThreadsHandBackInput = typeof FactoryThreadsHandBackInput.Type;

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
export const WsFactoryManagersApproveOnboardingRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryManagersApproveOnboarding,
  {
    payload: FactoryManagersApproveOnboardingInput,
    success: FactoryManager,
    error: FactoryRpcError,
  },
);
export const WsFactoryAssignmentsListRpc = Rpc.make(FACTORY_WS_METHODS.factoryAssignmentsList, {
  payload: FactoryAssignmentsListInput,
  success: Schema.Array(FactoryAssignment),
  error: FactoryRpcError,
});
export const WsFactoryAssignmentsSubscribeRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryAssignmentsSubscribe,
  {
    payload: FactoryAssignmentsSubscribeInput,
    success: FactoryAssignmentsEvent,
    error: FactoryRpcError,
    stream: true,
  },
);
export const WsFactoryAssignmentsCancelRpc = Rpc.make(FACTORY_WS_METHODS.factoryAssignmentsCancel, {
  payload: FactoryAssignmentsCancelInput,
  success: FactoryAssignment,
  error: FactoryRpcError,
});
export const WsFactoryThreadsTakeOverRpc = Rpc.make(FACTORY_WS_METHODS.factoryThreadsTakeOver, {
  payload: FactoryThreadsTakeOverInput,
  success: FactoryAssignment,
  error: FactoryRpcError,
});
export const WsFactoryThreadsHandBackRpc = Rpc.make(FACTORY_WS_METHODS.factoryThreadsHandBack, {
  payload: FactoryThreadsHandBackInput,
  success: FactoryAssignment,
  error: FactoryRpcError,
});
export const WsFactoryLogListRpc = Rpc.make(FACTORY_WS_METHODS.factoryLogList, {
  payload: FactoryLogListInput,
  success: Schema.Array(FactoryLogEntry),
  error: FactoryRpcError,
});
