import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import {
  FactoryConfigRepoConnectInput,
  FactoryConfigBundle,
  FactoryConfigRepoConnectResult,
  FactoryConfigRepoDisconnectInput,
  FactoryConfigRepoPushInput,
  FactoryConfigRepoResolveInput,
  FactoryConfigRepoStatus,
  FactoryConfigSettings,
  FactoryModelRef,
  FactoryDefinitionId,
  FactoryDefinitionRemoveInput,
  FactoryDefinitionSaveInput,
  FactoryDefinitionSaveResult,
  FactoryDefinitionsView,
  FactoryExportSelection,
  FactoryImportDecision,
  FactoryImportPreview,
  FactoryManagerDefinition,
  FactoryTeamDefinition,
} from "./factoryDefinitions.ts";
import { IssueBoardColumn, IssueRef, IssueSummary } from "./issues.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ThreadPullRequestKey } from "./threadPullRequest.ts";

/**
 * The engineering factory: standing managers in a project that commission assignments to leads.
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
  factoryManagersStartPickup: "factory.managers.startPickup",
  factoryAssignmentsList: "factory.assignments.list",
  factoryAssignmentsSubscribe: "factory.assignments.subscribe",
  factoryAssignmentsCancel: "factory.assignments.cancel",
  factoryAssignmentsAnswerProtectedPaths: "factory.assignments.answerProtectedPaths",
  factoryAssignmentsRefreshDigest: "factory.assignments.refreshDigest",
  factoryThreadsTakeOver: "factory.threads.takeOver",
  factoryThreadsHandBack: "factory.threads.handBack",
  factoryLogList: "factory.log.list",
  factoryWorkspaceSubscribe: "factory.workspace.subscribe",
  factoryFindingsList: "factory.findings.list",
  factoryDraftsList: "factory.drafts.list",
  factoryDraftsSubscribe: "factory.drafts.subscribe",
  factoryDraftsEdit: "factory.drafts.edit",
  factoryDraftsApprove: "factory.drafts.approve",
  factoryDraftsDismiss: "factory.drafts.dismiss",
  factoryDraftsRestore: "factory.drafts.restore",
  factoryStatsGet: "factory.stats.get",
  factoryDraftsApply: "factory.drafts.apply",
  factoryDefinitionsGet: "factory.definitions.get",
  factoryConfigRepoStatus: "factory.configRepo.status",
  factoryConfigRepoConnect: "factory.configRepo.connect",
  factoryConfigRepoCheck: "factory.configRepo.check",
  factoryConfigRepoPush: "factory.configRepo.push",
  factoryConfigRepoPull: "factory.configRepo.pull",
  factoryConfigRepoResolve: "factory.configRepo.resolve",
  factoryConfigRepoDiscard: "factory.configRepo.discard",
  factoryConfigRepoDisconnect: "factory.configRepo.disconnect",
  factoryConfigExport: "factory.config.export",
  factoryConfigImportPreview: "factory.config.importPreview",
  factoryConfigImportApply: "factory.config.importApply",
  factoryDefinitionsSave: "factory.definitions.save",
  factoryDefinitionsRemove: "factory.definitions.remove",
  factoryDefinitionsTeamUses: "factory.definitions.teamUses",
  factoryConfigSaveSettings: "factory.config.saveSettings",
  factoryConfigCreateStarter: "factory.config.createStarter",
} as const;

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

/**
 * `worker` is a team member copied from a user-defined worker. The three named worker roles stay
 * for assignments staffed before teams were built from definitions.
 */
export const FactoryRole = Schema.Literals([
  "manager",
  "lead",
  "implementer",
  "reviewer",
  "verifier",
  "worker",
]);
export type FactoryRole = typeof FactoryRole.Type;

/**
 * A role's skill text and where it came from. `definition` is a factory config definition on top
 * of the built-in protocol; `project` and `environment` name retired override files.
 */
export const FactoryRoleBrief = Schema.Struct({
  role: FactoryRole,
  text: Schema.String,
  source: Schema.Literals(["project", "environment", "default", "definition"]),
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

const PresetFields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  /** Free text the manager matches against a ticket. */
  useWhen: TrimmedString.check(Schema.isMaxLength(1000)),
  members: Schema.Array(FactoryTeamMember).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  /** Free text the lead follows, such as the order of implementation, review and verification. */
  workflow: TrimmedString.check(Schema.isMaxLength(2000)),
};

export const FactoryTeamPreset = Schema.Struct({
  id: Id,
  ...PresetFields,
  createdBy: Schema.Literals(["user", "manager"]),
});
export type FactoryTeamPreset = typeof FactoryTeamPreset.Type;

/** A preset the manager saves to the environment config; the factory assigns its id. */
export const FactoryCreateTeamInput = Schema.Struct(PresetFields);
export type FactoryCreateTeamInput = typeof FactoryCreateTeamInput.Type;

/**
 * A team the manager saves to the factory config, built from copies of existing definitions: the
 * named lead (absent means the first lead) and each worker under an optional member name.
 */
export const FactoryCreateTeamFromDefinitionsInput = Schema.Struct({
  name: PresetFields.name,
  useWhen: PresetFields.useWhen,
  workflow: PresetFields.workflow,
  leadId: Schema.optionalKey(FactoryDefinitionId),
  members: Schema.Array(
    Schema.Struct({
      workerId: FactoryDefinitionId,
      count: PositiveInt.check(Schema.isLessThanOrEqualTo(8)),
      name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
});
export type FactoryCreateTeamFromDefinitionsInput =
  typeof FactoryCreateTeamFromDefinitionsInput.Type;

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
  /**
   * Which provider instance runs a driver's models on this environment, when it has several. Never
   * written to the factory config files, since instance ids differ between machines.
   */
  instancePreferences: Schema.Record(ProviderDriverKind, ProviderInstanceId).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
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
  /**
   * Instance preferences naming an instance this environment cannot use now, so its driver's
   * models fall back to the first instance that serves them. Absent when there are none.
   */
  stalePreferences: Schema.optionalKey(
    Schema.Array(Schema.Struct({ driver: ProviderDriverKind, instanceId: ProviderInstanceId })),
  ),
});
export type FactoryConfigView = typeof FactoryConfigView.Type;

/** A glob relative to the repository root that teams may not edit, and why. */
export const FactoryControlPath = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  reason: TrimmedString.check(Schema.isMaxLength(500)),
});
export type FactoryControlPath = typeof FactoryControlPath.Type;

const RuleId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
const RuleQuestionText = TrimmedNonEmptyString.check(Schema.isMaxLength(500));

/** An open choice the manager asks the user while onboarding. `recommended` indexes `options`. */
export const FactoryRuleQuestion = Schema.Struct({
  id: RuleId,
  question: RuleQuestionText,
  options: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(300))).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(4),
  ),
  recommended: NonNegativeInt,
  reason: TrimmedString.check(Schema.isMaxLength(1000)),
});
export type FactoryRuleQuestion = typeof FactoryRuleQuestion.Type;

/** A question with the user's answer: one of its options, or the user's own words. */
export const FactoryProjectRule = Schema.Struct({
  id: RuleId,
  question: RuleQuestionText,
  answer: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
});
export type FactoryProjectRule = typeof FactoryProjectRule.Type;

export const FactoryPickupColumn = Schema.Struct({ boardId: Id, columnId: Id });
export type FactoryPickupColumn = typeof FactoryPickupColumn.Type;

const PickupLabels = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
  Schema.isMaxLength(50),
);

/** With `enabled` false the manager is never offered tickets, whatever the columns say. */
export const FactoryPickup = Schema.Struct({
  enabled: Schema.Boolean,
  /** Each one a Ready column of its board when approved; one that stops being Ready is ignored. */
  columns: Schema.Array(FactoryPickupColumn).check(Schema.isMaxLength(50)),
  /** Stored for label-scoped pickup; nothing filters on them yet. */
  labels: PickupLabels,
  /** Judged by the manager against each ticket it is offered. */
  guidance: PickupGuidance,
});
export type FactoryPickup = typeof FactoryPickup.Type;

const Purpose = TrimmedString.check(Schema.isMaxLength(2000));
const BaseBranch = TrimmedNonEmptyString.check(Schema.isMaxLength(255));

/** The manager configuration the user approved at the end of onboarding. */
export const FactoryOnboardingResult = Schema.Struct({
  purpose: Purpose,
  pickup: FactoryPickup,
  /** Stored for a per-manager base branch; null means the repository's default. Unused yet. */
  baseBranch: Schema.NullOr(BaseBranch),
  rules: Schema.Array(FactoryProjectRule).check(Schema.isMaxLength(30)),
  controlPaths: Schema.Array(FactoryControlPath).check(Schema.isMaxLength(100)),
  /** Factory team ids this manager may staff; empty means every team. */
  teamIds: Schema.Array(Id).check(Schema.isMaxLength(50)),
  /** Stored for a per-manager cap on running assignments; the environment cap still governs. */
  concurrencyCap: ConcurrencyCap,
});
export type FactoryOnboardingResult = typeof FactoryOnboardingResult.Type;

/** One connected board as Satellite read it when the manager proposed. */
export const FactoryOnboardingBoard = Schema.Struct({
  boardId: Id,
  title: Schema.String,
  readyColumns: Schema.Array(IssueBoardColumn),
  /** Labels on the board's current items, sorted. */
  labels: Schema.Array(Schema.String),
});
export type FactoryOnboardingBoard = typeof FactoryOnboardingBoard.Type;

/** Facts Satellite reads itself, so the card never relies on the manager's reading. */
export const FactoryOnboardingDetected = Schema.Struct({
  boards: Schema.Array(FactoryOnboardingBoard),
  /** The primary remote's default branch, or null when it cannot be read. */
  defaultBranch: Schema.NullOr(Schema.String),
  detectedAt: Schema.String,
});
export type FactoryOnboardingDetected = typeof FactoryOnboardingDetected.Type;

const Finding = TrimmedNonEmptyString.check(Schema.isMaxLength(500));

/** What the manager submits while onboarding. Board columns are not its to name; Satellite detects them. */
export const FactoryOnboardingProposalInput = Schema.Struct({
  summary: TrimmedString.check(Schema.isMaxLength(4000)),
  purpose: Purpose,
  pickup: Schema.Struct({ enabled: Schema.Boolean, guidance: PickupGuidance }),
  rules: Schema.Array(FactoryRuleQuestion).check(Schema.isMaxLength(20)),
  controlPaths: Schema.Array(FactoryControlPath).check(Schema.isMaxLength(100)),
  /** Things that need no decision; shown on the card and discarded on approval. */
  findings: Schema.Array(Finding).check(Schema.isMaxLength(50)),
});
export type FactoryOnboardingProposalInput = typeof FactoryOnboardingProposalInput.Type;

/** The latest proposal with what Satellite detected. Discarded once the user approves. */
export const FactoryOnboardingProposal = Schema.Struct({
  ...FactoryOnboardingProposalInput.fields,
  detected: FactoryOnboardingDetected,
  proposedAt: Schema.String,
});
export type FactoryOnboardingProposal = typeof FactoryOnboardingProposal.Type;

/**
 * `ready` is approved with pickup on but not yet started by the user: it works like `active`
 * except that no ticket is offered or picked up. `retired` is terminal; the project can then get
 * a new manager.
 */
export const FactoryManagerState = Schema.Literals([
  "onboarding",
  "ready",
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
  /**
   * The thread the manager onboarded in, once approval moved it to a primed thread; null before.
   * Defaults on decode so manager values recorded before it existed still read.
   */
  onboardingThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** The primed thread's first message, so a client can fold it by id; null before approval. */
  primingMessageId: Schema.NullOr(MessageId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The latest proposal while onboarding; null before the first one and after approval. */
  onboardingProposal: Schema.NullOr(FactoryOnboardingProposal),
  /** Null until the user approves onboarding. */
  onboardingResult: Schema.NullOr(FactoryOnboardingResult),
  /** The model the manager's thread launched with. */
  modelSelection: Schema.NullOr(ModelSelection),
  /** The manager's own copy of the definition it was created from; absent before definitions. */
  definition: Schema.optionalKey(Schema.NullOr(FactoryManagerDefinition)),
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
  /** The manager definition the manager copies; absent means the first one. */
  definitionId: Schema.optionalKey(FactoryDefinitionId),
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
 * Approves the manager's onboarding with the result the user settled on. The manager moves to a
 * new thread primed from the result, which the returned manager names; it is `ready` with pickup
 * on and `active` otherwise. Every proposed question needs a rule with its id, and each pickup
 * column has to still be Ready. The factory's own folder is always protected.
 */
export const FactoryManagersApproveOnboardingInput = Schema.Struct({
  requestId: Id,
  managerId: Id,
  result: FactoryOnboardingResult,
});
export type FactoryManagersApproveOnboardingInput =
  typeof FactoryManagersApproveOnboardingInput.Type;

/** Starts pickup for a `ready` manager, which then becomes `active`. */
export const FactoryManagersStartPickupInput = Schema.Struct({ requestId: Id, managerId: Id });
export type FactoryManagersStartPickupInput = typeof FactoryManagersStartPickupInput.Type;

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

/**
 * The team an assignment asks its lead to staff. `definition` snapshots the factory team it was
 * commissioned with, and `preset` is then that team's id. Without it, `preset` is a legacy
 * preset's name or `custom`, and `members` name worker roles.
 */
/** What clients and agents see of a team snapshot, without its instructions and descriptions. */
export const FactoryTeamSummary = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  members: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
      count: PositiveInt.check(Schema.isLessThanOrEqualTo(8)),
    }),
  ).check(Schema.isMaxLength(12)),
  mayEditProtectedPaths: Schema.Boolean,
});
export type FactoryTeamSummary = typeof FactoryTeamSummary.Type;

export const FactoryTeamSpec = Schema.Struct({
  preset: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  members: Schema.Array(FactoryTeamMember).check(Schema.isMaxLength(12)),
  /** Stored with the assignment; never sent to clients or agents, which get `summary`. */
  definition: Schema.optionalKey(FactoryTeamDefinition),
  summary: Schema.optionalKey(FactoryTeamSummary),
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

export const FactoryChecklistStep = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  state: Schema.Literals(["done", "in-progress", "not-started"]),
});
export type FactoryChecklistStep = typeof FactoryChecklistStep.Type;

const FactoryChecklist = Schema.Array(FactoryChecklistStep).check(Schema.isMaxLength(20));

/** A summary of the lead's recent activity, and the activity it covers. */
export const FactoryAssignmentDigest = Schema.Struct({
  text: Schema.String,
  generatedAt: Schema.String,
  activityAt: Schema.String,
});
export type FactoryAssignmentDigest = typeof FactoryAssignmentDigest.Type;

/** An open pull request that changes the manager's protected control paths. */
export const FactoryControlViolation = Schema.Struct({
  pullRequest: ThreadPullRequestKey,
  paths: Schema.Array(Schema.String),
});
export type FactoryControlViolation = typeof FactoryControlViolation.Type;

const ProtectedPaths = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50),
);

/**
 * Protected files a team asks to edit for one assignment, named exactly. Only the user answers,
 * and an answer covers every path in the ask. Declining an allowed ask revokes it; a declined ask
 * may still be allowed later.
 */
export const FactoryProtectedPathAsk = Schema.Struct({
  id: Id,
  paths: ProtectedPaths,
  reason: Schema.String.check(Schema.isMaxLength(2000)),
  source: Schema.Literals(["commission", "pull-request"]),
  /** The pull request that flagged the paths, for a `pull-request` ask. */
  pullRequest: Schema.NullOr(ThreadPullRequestKey),
  state: Schema.Literals(["open", "allowed", "declined"]),
  createdAt: Schema.String,
  answeredAt: Schema.NullOr(Schema.String),
});
export type FactoryProtectedPathAsk = typeof FactoryProtectedPathAsk.Type;

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
  /** The lead's plan as it last reported it. */
  checklist: FactoryChecklist,
  digest: Schema.NullOr(FactoryAssignmentDigest),
  /**
   * Protected paths open pull requests change that the user has not allowed for this assignment.
   * While any remain, the assignment waits on the user and cannot be offered as ready.
   */
  controlViolations: Schema.Array(FactoryControlViolation),
  /** Asks to edit protected files for this assignment, answered or not. */
  protectedPathAsks: Schema.Array(FactoryProtectedPathAsk),
  /** When the lead finished the team retro, and when the manager finished its own. */
  retro: Schema.Struct({
    teamDoneAt: Schema.NullOr(Schema.String),
    managerDoneAt: Schema.NullOr(Schema.String),
  }),
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
  "team",
  "finding",
  "retro",
  "draft",
  "ticket",
  /** Onboarding approved; the payload names the onboarding thread and the manager's new one. */
  "onboarded",
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
  /** Tickets in the manager's pickup columns with no live assignment; none while pickup is off. */
  readyTickets: Schema.Array(FactoryReadyTicket),
  pickupEnabled: Schema.Boolean,
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
  /** A factory team id; absent means the first team the manager may staff. */
  teamId: Schema.optionalKey(FactoryDefinitionId),
  /** The lead's model, when the team's lead has a dynamic model list. */
  leadModel: Schema.optionalKey(ModelSelection),
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
  /** A factory team id; absent means the first team the manager may staff. */
  teamId: Schema.optionalKey(FactoryDefinitionId),
  /** The lead's model, when the team's lead has a dynamic model list. */
  leadModel: Schema.optionalKey(ModelSelection),
  /** An open dependency this assignment delivers; the blocked assignment stays blocked until then. */
  dependencyId: Schema.optionalKey(Id),
  /**
   * Exact protected files the team will need to edit, and why. The user allows or declines them
   * on the team's card; no agent can.
   */
  protectedPaths: Schema.optionalKey(
    Schema.Struct({ paths: ProtectedPaths, reason: DecisionReason }),
  ),
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
  /** Ends without the team retro; only accepted once the lead's thread is gone or taken over. */
  teamRetro: Schema.optionalKey(Schema.Literals(["skipped"])),
});
export type FactoryCompleteInput = typeof FactoryCompleteInput.Type;

/** The lead still writes its retro; the assignment ends cancelled once the manager completes it. */
export const FactoryAssignmentsCancelInput = Schema.Struct({
  requestId: Id,
  assignmentId: Id,
  reason: DecisionReason,
});
export type FactoryAssignmentsCancelInput = typeof FactoryAssignmentsCancelInput.Type;

/** The user's answer to one protected-path ask. Declining an allowed ask revokes it. */
export const FactoryAssignmentsAnswerProtectedPathsInput = Schema.Struct({
  requestId: Id,
  assignmentId: Id,
  askId: Id,
  answer: Schema.Literals(["allow", "decline"]),
});
export type FactoryAssignmentsAnswerProtectedPathsInput =
  typeof FactoryAssignmentsAnswerProtectedPathsInput.Type;

/** Rewrites the assignment's digest when its team has new activity; otherwise returns it as is. */
export const FactoryAssignmentsRefreshDigestInput = Schema.Struct({ assignmentId: Id });
export type FactoryAssignmentsRefreshDigestInput = typeof FactoryAssignmentsRefreshDigestInput.Type;

/** The user takes over a factory thread; the factory stops acting on it until handed back. */
export const FactoryThreadsTakeOverInput = Schema.Struct({ requestId: Id, threadId: ThreadId });
export type FactoryThreadsTakeOverInput = typeof FactoryThreadsTakeOverInput.Type;

export const FactoryThreadsHandBackInput = Schema.Struct({ requestId: Id, threadId: ThreadId });
export type FactoryThreadsHandBackInput = typeof FactoryThreadsHandBackInput.Type;

/** The lead replaces its checklist whole. */
export const FactoryUpdateChecklistInput = Schema.Struct({ steps: FactoryChecklist });
export type FactoryUpdateChecklistInput = typeof FactoryUpdateChecklistInput.Type;

const MemberName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

/**
 * The lead asks for a worker from its team: by `member` name on a team built from definitions, by
 * `role` on an older team. Absent model means the first one allowed.
 */
export const FactoryDelegateInput = Schema.Struct({
  member: Schema.optionalKey(MemberName),
  role: Schema.optionalKey(FactoryWorkerRole),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type FactoryDelegateInput = typeof FactoryDelegateInput.Type;

/** What a delegation launches: `task` is the full first message, role skill and task. */
export const FactoryDelegationPlan = Schema.Struct({
  role: FactoryRole,
  member: Schema.optionalKey(MemberName),
  title: TrimmedNonEmptyString,
  task: Schema.String,
  modelSelection: ModelSelection,
  allowedModels: Schema.Array(ModelSelection),
});
export type FactoryDelegationPlan = typeof FactoryDelegationPlan.Type;

/**
 * How a thread joined a team: launched by the factory, handed over from outside, or observed as
 * a sub-agent of a member.
 */
export const FactoryMemberJoin = Schema.Literals(["created", "handover", "observed"]);
export type FactoryMemberJoin = typeof FactoryMemberJoin.Type;

export const FactoryMember = Schema.Struct({
  threadId: ThreadId,
  managerId: Id,
  assignmentId: Schema.NullOr(Id),
  role: FactoryRole,
  /** The team member a `worker` was delegated as. */
  memberName: Schema.optionalKey(MemberName),
  parentThreadId: Schema.NullOr(ThreadId),
  joined: FactoryMemberJoin,
  takenOver: Schema.Boolean,
  /** The thread runs a model outside the factory's pool. */
  offPool: Schema.Boolean,
  endedAt: Schema.NullOr(Schema.String),
});
export type FactoryMember = typeof FactoryMember.Type;

export const FactoryWorkspaceSubscribeInput = Schema.Struct({});
export type FactoryWorkspaceSubscribeInput = typeof FactoryWorkspaceSubscribeInput.Type;

export const FactoryWorkspaceManager = Schema.Struct({
  id: Id,
  threadId: Schema.NullOr(ThreadId),
  projectId: ProjectId,
  name: Schema.String,
  state: FactoryManagerState,
  waitingOnYou: NonNegativeInt,
});
export type FactoryWorkspaceManager = typeof FactoryWorkspaceManager.Type;

export const FactoryWorkspaceAssignment = Schema.Struct({
  id: Id,
  managerId: Id,
  title: Schema.String,
  state: FactoryAssignmentState,
  source: FactoryAssignmentSource,
  complexity: FactoryComplexity,
  /** The team's preset name, or `custom`. */
  team: Schema.String,
  leadThreadId: Schema.NullOr(ThreadId),
  checklist: Schema.Array(FactoryChecklistStep),
  digest: Schema.NullOr(FactoryAssignmentDigest),
  waitingReason: Schema.NullOr(Schema.String),
});
export type FactoryWorkspaceAssignment = typeof FactoryWorkspaceAssignment.Type;

/**
 * What the workspace shows of the factory, sent whole: current managers, live members, and
 * assignments that are live or ended in the last 24 hours.
 */
export const FactoryWorkspaceFeed = Schema.Struct({
  managers: Schema.Array(FactoryWorkspaceManager),
  members: Schema.Array(FactoryMember),
  assignments: Schema.Array(FactoryWorkspaceAssignment),
});
export type FactoryWorkspaceFeed = typeof FactoryWorkspaceFeed.Type;

/**
 * What a team member noticed while working. `implementation` stays with the assignment; the
 * others are what the manager's retro turns into project or factory tickets.
 */
export const FactoryFindingClass = Schema.Literals([
  "implementation",
  "project",
  "reusable",
  "shared",
  "uncertain",
]);
export type FactoryFindingClass = typeof FactoryFindingClass.Type;

const FindingSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));
const FindingEvidence = TrimmedNonEmptyString.check(Schema.isMaxLength(8000));
const FindingNote = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));

export const FactoryFinding = Schema.Struct({
  id: Id,
  assignmentId: Id,
  /** The member thread that recorded it. */
  threadId: ThreadId,
  class: FactoryFindingClass,
  summary: Schema.String.check(Schema.isMaxLength(2000)),
  evidence: Schema.String.check(Schema.isMaxLength(8000)),
  uncertainty: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  workaround: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  /** The member asked the manager to decide now rather than at the retro. */
  escalated: Schema.Boolean,
  /** The ticket draft that took it up, if any. */
  draftId: Schema.NullOr(Id),
  createdAt: Schema.String,
});
export type FactoryFinding = typeof FactoryFinding.Type;

export const FactoryRecordFindingInput = Schema.Struct({
  class: FactoryFindingClass,
  summary: FindingSummary,
  evidence: FindingEvidence,
  uncertainty: Schema.optionalKey(FindingNote),
  workaround: Schema.optionalKey(FindingNote),
  escalate: Schema.optionalKey(Schema.Boolean),
});
export type FactoryRecordFindingInput = typeof FactoryRecordFindingInput.Type;

export const FactoryFindingsListInput = Schema.Struct({ assignmentId: Id });
export type FactoryFindingsListInput = typeof FactoryFindingsListInput.Type;

/** `project` files a ticket on the project's board; `factory` changes how the factory works. */
export const FactoryDraftScope = Schema.Literals(["project", "factory"]);
export type FactoryDraftScope = typeof FactoryDraftScope.Type;

export const FactoryDraftState = Schema.Literals(["pending", "approved", "dismissed"]);
export type FactoryDraftState = typeof FactoryDraftState.Type;

/** A factory change a draft proposes, with the value it replaces. Stored, not yet applied. */
export const FactoryProposedChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("preset"),
    before: Schema.NullOr(FactoryTeamPreset),
    after: FactoryTeamPreset,
  }),
  Schema.Struct({
    kind: Schema.Literal("setting"),
    /** `pickupGuidance` moved onto the manager; a draft that stored it can no longer be applied. */
    key: Schema.Literals([
      "pickupGuidance",
      "concurrencyCap",
      "recoveryAllowance",
      "digestIntervalMinutes",
    ]),
    before: Schema.Unknown,
    after: Schema.Unknown,
  }),
  Schema.Struct({
    kind: Schema.Literal("role-skill"),
    role: FactoryRole,
    before: Schema.NullOr(Schema.String),
    after: Schema.String,
  }),
  /** A team definition in the factory config, created when `before` is null. */
  Schema.Struct({
    kind: Schema.Literal("team"),
    before: Schema.NullOr(FactoryTeamDefinition),
    after: FactoryTeamDefinition,
  }),
  /** A worker, lead or manager definition; `after` decodes as that kind's definition. */
  Schema.Struct({
    kind: Schema.Literal("definition"),
    target: Schema.Literals(["worker", "lead", "manager"]),
    before: Schema.NullOr(Schema.Unknown),
    after: Schema.Unknown,
  }),
]);
export type FactoryProposedChange = typeof FactoryProposedChange.Type;

const DraftTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
const DraftBody = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));
const AcceptanceCriteria = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).check(
  Schema.isMaxLength(30),
);

/** A ticket the manager drafted in its retro, waiting for the user's triage. */
export const FactoryTicketDraft = Schema.Struct({
  id: Id,
  managerId: Id,
  projectId: ProjectId,
  /** The assignment whose retro produced it. */
  assignmentId: Schema.NullOr(Id),
  scope: FactoryDraftScope,
  title: DraftTitle,
  body: Schema.String.check(Schema.isMaxLength(20_000)),
  acceptanceCriteria: AcceptanceCriteria,
  findingIds: Schema.Array(Schema.String),
  state: FactoryDraftState,
  /** The ticket an approved project draft filed. */
  issue: Schema.NullOr(IssueRef),
  proposedChange: Schema.NullOr(FactoryProposedChange),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type FactoryTicketDraft = typeof FactoryTicketDraft.Type;

export const FactoryDraftTicketInput = Schema.Struct({
  scope: FactoryDraftScope,
  title: DraftTitle,
  body: DraftBody,
  acceptanceCriteria: AcceptanceCriteria,
  /** Findings of this manager's teams that the draft takes up. */
  findingIds: Schema.optionalKey(Schema.Array(Id).check(Schema.isMaxLength(100))),
  proposedChange: Schema.optionalKey(FactoryProposedChange),
});
export type FactoryDraftTicketInput = typeof FactoryDraftTicketInput.Type;

/** A draft or open ticket whose title overlaps the new draft's, so the manager can check it. */
export const FactorySimilarTicket = Schema.Struct({
  kind: Schema.Literals(["draft", "ticket"]),
  id: Schema.String,
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
});
export type FactorySimilarTicket = typeof FactorySimilarTicket.Type;

export const FactoryDraftTicketResult = Schema.Struct({
  draft: FactoryTicketDraft,
  similar: Schema.Array(FactorySimilarTicket),
});
export type FactoryDraftTicketResult = typeof FactoryDraftTicketResult.Type;

export const FactoryDraftsListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  managerId: Schema.optional(Id),
  state: Schema.optional(FactoryDraftState),
});
export type FactoryDraftsListInput = typeof FactoryDraftsListInput.Type;

export const FactoryDraftsSubscribeInput = Schema.Struct({});
export type FactoryDraftsSubscribeInput = typeof FactoryDraftsSubscribeInput.Type;

/** Every pending draft on the environment plus those approved or dismissed in the last 7 days. */
export const FactoryDraftsEvent = Schema.Struct({ drafts: Schema.Array(FactoryTicketDraft) });
export type FactoryDraftsEvent = typeof FactoryDraftsEvent.Type;

/** Only a pending draft can be edited. Absent fields keep their value. */
export const FactoryDraftsEditInput = Schema.Struct({
  requestId: Id,
  draftId: Id,
  title: Schema.optionalKey(DraftTitle),
  body: Schema.optionalKey(DraftBody),
  acceptanceCriteria: Schema.optionalKey(AcceptanceCriteria),
});
export type FactoryDraftsEditInput = typeof FactoryDraftsEditInput.Type;

/** A project draft files its ticket on the project's first board with a Ready column. */
export const FactoryDraftsApproveInput = Schema.Struct({ requestId: Id, draftId: Id });
export type FactoryDraftsApproveInput = typeof FactoryDraftsApproveInput.Type;

export const FactoryDraftsDismissInput = Schema.Struct({ requestId: Id, draftId: Id });
export type FactoryDraftsDismissInput = typeof FactoryDraftsDismissInput.Type;

/** Returns a dismissed draft to pending. */
export const FactoryDraftsRestoreInput = Schema.Struct({ requestId: Id, draftId: Id });
export type FactoryDraftsRestoreInput = typeof FactoryDraftsRestoreInput.Type;

/**
 * Applies a pending factory draft's proposed change and accepts the draft. Refused with
 * `conflict` when the value it replaces has changed since; a role-skill change is not applied.
 */
export const FactoryDraftsApplyInput = Schema.Struct({ requestId: Id, draftId: Id });
export type FactoryDraftsApplyInput = typeof FactoryDraftsApplyInput.Type;

const StatsTokens = Schema.Struct({
  input: NonNegativeInt,
  cachedInput: NonNegativeInt,
  output: NonNegativeInt,
});

/**
 * What one ended assignment cost, rolled up from its member threads' turns when it ended. Input
 * tokens include cached ones. `costUsd` is null without a rate table and sums only priced models.
 */
export const FactoryAssignmentStats = Schema.Struct({
  assignmentId: Id,
  managerId: Id,
  projectId: ProjectId,
  /** The team preset's name, or `custom`. */
  team: Schema.String,
  complexity: FactoryComplexity,
  outcome: Schema.Literals(["completed", "cancelled"]),
  teamVerdict: Schema.NullOr(FactoryTeamVerdict.fields.fit),
  tokens: StatsTokens,
  costUsd: Schema.NullOr(Schema.Number),
  agentMs: NonNegativeInt,
  wallMs: NonNegativeInt,
  waitingUserMs: NonNegativeInt,
  recoveries: NonNegativeInt,
  pullRequests: NonNegativeInt,
  reviewRounds: NonNegativeInt,
  byRole: Schema.Array(
    Schema.Struct({ role: FactoryRole, tokens: StatsTokens, agentMs: NonNegativeInt }),
  ),
  /** Per team member, sub-agents included; absent for assignments staffed by role. */
  byMember: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        delegations: NonNegativeInt,
        tokens: StatsTokens,
        agentMs: NonNegativeInt,
      }),
    ),
  ),
  byModel: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      tokens: StatsTokens,
      agentMs: NonNegativeInt,
      costUsd: Schema.NullOr(Schema.Number),
    }),
  ),
  endedAt: Schema.String,
});
export type FactoryAssignmentStats = typeof FactoryAssignmentStats.Type;

export const FactoryStatsGetInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  complexity: Schema.optional(FactoryComplexity),
  /** `YYYY-MM-DD`; assignments that ended on or after that day (UTC). */
  sinceDay: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
});
export type FactoryStatsGetInput = typeof FactoryStatsGetInput.Type;

/**
 * One team's ended assignments. Tokens are input plus output; the median of an even count is the
 * mean of the middle two.
 */
export const FactoryTeamStats = Schema.Struct({
  team: Schema.String,
  tasks: NonNegativeInt,
  completed: NonNegativeInt,
  cancelled: NonNegativeInt,
  medianTokens: Schema.Number,
  /** Over the tasks that have a cost; null when none has. */
  medianCostUsd: Schema.NullOr(Schema.Number),
  medianAgentMs: Schema.Number,
  medianWallMs: Schema.Number,
  meanRecoveries: Schema.Number,
  meanReviewRounds: Schema.Number,
  goodFit: NonNegativeInt,
  poorFit: NonNegativeInt,
});
export type FactoryTeamStats = typeof FactoryTeamStats.Type;

/** Assignments newest first. */
export const FactoryStatsResult = Schema.Struct({
  teams: Schema.Array(FactoryTeamStats),
  assignments: Schema.Array(FactoryAssignmentStats),
});
export type FactoryStatsResult = typeof FactoryStatsResult.Type;

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
export const WsFactoryManagersStartPickupRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryManagersStartPickup,
  {
    payload: FactoryManagersStartPickupInput,
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
export const WsFactoryAssignmentsAnswerProtectedPathsRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryAssignmentsAnswerProtectedPaths,
  {
    payload: FactoryAssignmentsAnswerProtectedPathsInput,
    success: FactoryAssignment,
    error: FactoryRpcError,
  },
);
export const WsFactoryAssignmentsRefreshDigestRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryAssignmentsRefreshDigest,
  {
    payload: FactoryAssignmentsRefreshDigestInput,
    success: FactoryAssignment,
    error: FactoryRpcError,
  },
);
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
export const WsFactoryWorkspaceSubscribeRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryWorkspaceSubscribe,
  {
    payload: FactoryWorkspaceSubscribeInput,
    success: FactoryWorkspaceFeed,
    error: FactoryRpcError,
    stream: true,
  },
);
export const WsFactoryFindingsListRpc = Rpc.make(FACTORY_WS_METHODS.factoryFindingsList, {
  payload: FactoryFindingsListInput,
  success: Schema.Array(FactoryFinding),
  error: FactoryRpcError,
});
export const WsFactoryDraftsListRpc = Rpc.make(FACTORY_WS_METHODS.factoryDraftsList, {
  payload: FactoryDraftsListInput,
  success: Schema.Array(FactoryTicketDraft),
  error: FactoryRpcError,
});
export const WsFactoryDraftsSubscribeRpc = Rpc.make(FACTORY_WS_METHODS.factoryDraftsSubscribe, {
  payload: FactoryDraftsSubscribeInput,
  success: FactoryDraftsEvent,
  error: FactoryRpcError,
  stream: true,
});
export const WsFactoryDraftsEditRpc = Rpc.make(FACTORY_WS_METHODS.factoryDraftsEdit, {
  payload: FactoryDraftsEditInput,
  success: FactoryTicketDraft,
  error: FactoryRpcError,
});
export const WsFactoryDraftsApproveRpc = Rpc.make(FACTORY_WS_METHODS.factoryDraftsApprove, {
  payload: FactoryDraftsApproveInput,
  success: FactoryTicketDraft,
  error: FactoryRpcError,
});
export const WsFactoryDraftsDismissRpc = Rpc.make(FACTORY_WS_METHODS.factoryDraftsDismiss, {
  payload: FactoryDraftsDismissInput,
  success: FactoryTicketDraft,
  error: FactoryRpcError,
});
export const WsFactoryDraftsRestoreRpc = Rpc.make(FACTORY_WS_METHODS.factoryDraftsRestore, {
  payload: FactoryDraftsRestoreInput,
  success: FactoryTicketDraft,
  error: FactoryRpcError,
});
export const WsFactoryStatsGetRpc = Rpc.make(FACTORY_WS_METHODS.factoryStatsGet, {
  payload: FactoryStatsGetInput,
  success: FactoryStatsResult,
  error: FactoryRpcError,
});
export const WsFactoryDraftsApplyRpc = Rpc.make(FACTORY_WS_METHODS.factoryDraftsApply, {
  payload: FactoryDraftsApplyInput,
  success: FactoryTicketDraft,
  error: FactoryRpcError,
});

const NoInput = Schema.Struct({});

export const WsFactoryDefinitionsGetRpc = Rpc.make(FACTORY_WS_METHODS.factoryDefinitionsGet, {
  payload: NoInput,
  success: FactoryDefinitionsView,
  error: FactoryRpcError,
});
export const WsFactoryConfigRepoStatusRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigRepoStatus, {
  payload: NoInput,
  success: FactoryConfigRepoStatus,
  error: FactoryRpcError,
});
export const WsFactoryConfigRepoConnectRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigRepoConnect, {
  payload: FactoryConfigRepoConnectInput,
  success: FactoryConfigRepoConnectResult,
  error: FactoryRpcError,
});
export const WsFactoryConfigRepoCheckRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigRepoCheck, {
  payload: NoInput,
  success: FactoryConfigRepoStatus,
  error: FactoryRpcError,
});
export const WsFactoryConfigRepoPushRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigRepoPush, {
  payload: FactoryConfigRepoPushInput,
  success: FactoryConfigRepoStatus,
  error: FactoryRpcError,
});
export const WsFactoryConfigRepoPullRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigRepoPull, {
  payload: NoInput,
  success: FactoryConfigRepoStatus,
  error: FactoryRpcError,
});
export const WsFactoryConfigRepoResolveRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigRepoResolve, {
  payload: FactoryConfigRepoResolveInput,
  success: FactoryConfigRepoStatus,
  error: FactoryRpcError,
});
export const WsFactoryConfigRepoDiscardRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigRepoDiscard, {
  payload: NoInput,
  success: FactoryConfigRepoStatus,
  error: FactoryRpcError,
});
export const WsFactoryConfigRepoDisconnectRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryConfigRepoDisconnect,
  {
    payload: FactoryConfigRepoDisconnectInput,
    success: FactoryConfigRepoStatus,
    error: FactoryRpcError,
  },
);

/** An export is built from definitions on the environment; the client only zips the files. */
export const WsFactoryConfigExportRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigExport, {
  payload: FactoryExportSelection,
  success: FactoryConfigBundle,
  error: FactoryRpcError,
});
export const WsFactoryConfigImportPreviewRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryConfigImportPreview,
  {
    payload: FactoryConfigBundle,
    success: FactoryImportPreview,
    error: FactoryRpcError,
  },
);
export const FactoryConfigImportApplyInput = Schema.Struct({
  bundle: FactoryConfigBundle,
  decision: FactoryImportDecision,
});
export type FactoryConfigImportApplyInput = typeof FactoryConfigImportApplyInput.Type;
export const WsFactoryConfigImportApplyRpc = Rpc.make(FACTORY_WS_METHODS.factoryConfigImportApply, {
  payload: FactoryConfigImportApplyInput,
  success: FactoryDefinitionsView,
  error: FactoryRpcError,
});

export const WsFactoryDefinitionsSaveRpc = Rpc.make(FACTORY_WS_METHODS.factoryDefinitionsSave, {
  payload: FactoryDefinitionSaveInput,
  success: FactoryDefinitionSaveResult,
  error: FactoryRpcError,
});
export const WsFactoryDefinitionsRemoveRpc = Rpc.make(FACTORY_WS_METHODS.factoryDefinitionsRemove, {
  payload: FactoryDefinitionRemoveInput,
  success: FactoryDefinitionsView,
  error: FactoryRpcError,
});
export const FactoryTeamUsesInput = Schema.Struct({ teamId: FactoryDefinitionId });
export type FactoryTeamUsesInput = typeof FactoryTeamUsesInput.Type;

/**
 * The managers whose onboarding result names a team among the teams they may staff. A manager
 * with no team list may staff every team, so it is never listed: removing a team leaves it able
 * to work. Retired managers are left out.
 */
export const FactoryTeamUses = Schema.Struct({
  managers: Schema.Array(
    Schema.Struct({ managerId: Id, name: Schema.String, projectTitle: Schema.String }),
  ),
});
export type FactoryTeamUses = typeof FactoryTeamUses.Type;

export const WsFactoryDefinitionsTeamUsesRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryDefinitionsTeamUses,
  {
    payload: FactoryTeamUsesInput,
    success: FactoryTeamUses,
    error: FactoryRpcError,
  },
);
/** The pool the starter set runs on; the client picks it from the models the environment has. */
export const FactoryConfigCreateStarterInput = Schema.Struct({
  modelPool: Schema.Array(FactoryModelRef),
});
export type FactoryConfigCreateStarterInput = typeof FactoryConfigCreateStarterInput.Type;

export const WsFactoryConfigCreateStarterRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryConfigCreateStarter,
  {
    payload: FactoryConfigCreateStarterInput,
    success: FactoryDefinitionsView,
    error: FactoryRpcError,
  },
);
export const WsFactoryConfigSaveSettingsRpc = Rpc.make(
  FACTORY_WS_METHODS.factoryConfigSaveSettings,
  {
    payload: FactoryConfigSettings,
    success: FactoryDefinitionsView,
    error: FactoryRpcError,
  },
);
