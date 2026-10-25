// @effect-diagnostics nodeBuiltinImport:off - Hashes request payloads and mints manager ids.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

import {
  CommandId,
  DEFAULT_FACTORY_CONFIG,
  FACTORY_ASK_PATH_LIMIT,
  FactoryAssignment,
  FactoryAssignmentClaim,
  FactoryAssignmentStats,
  FactoryConfig,
  FactoryConfigOverride,
  FactoryControlViolation,
  FactoryDependency,
  FactoryFinding,
  FactoryLogEntry,
  FactoryManager,
  FactoryManagerDefinition,
  FactoryMember,
  FactoryOnboardingProposal,
  FactoryOnboardingResult,
  FactoryOperationError,
  FactoryProtectedPathAsk,
  FactoryProposedChange,
  FactoryTeamSpec,
  FactoryTeamVerdict,
  FactoryTicketDraft,
  FactoryWorkspaceFeed,
  IssueRef,
  issueReadyColumnIds,
  MessageId,
  ModelSelection,
  ProjectId,
  resolveFactoryConfig,
  RuntimeMode,
  type FactoryAmendAssignmentInput,
  type FactoryAssignmentState,
  type FactoryAssignmentsAnswerProtectedPathsInput,
  type FactoryAssignmentsCancelInput,
  type FactoryAssignmentsEvent,
  type FactoryAssignmentsListInput,
  type FactoryAssignmentsSubscribeInput,
  type FactoryClaimCompleteInput,
  type FactoryCommissionInput,
  type FactoryCompleteInput,
  type FactoryComplexity,
  type FactoryConfigGetInput,
  type FactoryConfigUpdateInput,
  type FactoryConfigView,
  type FactoryCreateTeamFromDefinitionsInput,
  type FactoryDelegateInput,
  type FactoryDelegationPlan,
  type FactoryDefinitionsView,
  type FactoryTeamDefinition,
  type FactoryDraftsApplyInput,
  type FactoryDraftsApproveInput,
  type FactoryDraftsDismissInput,
  type FactoryDraftsEditInput,
  type FactoryDraftsEvent,
  type FactoryDraftsListInput,
  type FactoryDraftsRestoreInput,
  type FactoryDraftsSubscribeInput,
  type FactoryDraftTicketInput,
  type FactoryDraftTicketResult,
  type FactoryFindingsListInput,
  type FactoryLogKind,
  type FactoryLogListInput,
  type FactoryManagersApproveOnboardingInput,
  type FactoryManagersCreateInput,
  type FactoryManagersEvent,
  type FactoryManagersListInput,
  type FactoryManagersPauseInput,
  type FactoryManagersResumeInput,
  type FactoryManagersRetireInput,
  type FactoryManagersStartPickupInput,
  type FactoryManagersUpdateSettingsInput,
  type FactoryManagersSubscribeInput,
  type FactoryOnboardingBoard,
  type FactoryPickup,
  type FactoryPickupColumn,
  type FactoryOnboardingProposalInput,
  type FactoryPickupInput,
  type FactoryReadyTicket,
  type FactoryRecordFindingInput,
  type FactoryRecoverInput,
  type FactoryReportDependencyInput,
  type FactoryAskManagerInput,
  type FactoryRole,
  type FactoryRoleBrief,
  type FactorySimilarTicket,
  type FactoryStatus,
  type FactoryTeamMember,
  type FactoryThreadsHandBackInput,
  type FactoryThreadsTakeOverInput,
  type FactoryStatsGetInput,
  type FactoryStatsResult,
  type FactoryTeamStats,
  type FactoryUpdateChecklistInput,
  type FactoryWorkspaceSubscribeInput,
  type IssueAttemptsStartInput,
  type IssueAttemptsStartResult,
  type IssueBoardSummary,
  type IssueBoardView,
  type IssueOperationError,
  type IssueSummary,
  type OrchestrationProjectShell,
  type OrchestrationV2RunStatus,
  type ProviderInteractionMode,
  type PullRequestDiffResult,
  type PullRequestMergeability,
  type PullRequestState,
  ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { parseDiffFilePaths } from "@t3tools/source-control-core/server/diffFileRevisions";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestsOf,
} from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { parseRateTable, priceUsage, type RateTable } from "../usage/usagePricing.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { applyDefinitionChange, type DefinitionChange } from "./config/applyDefinitionChange.ts";
import { teamFromDefinitions } from "./config/definitionRules.ts";
import { FactoryConfigStore, unmigratedConfigMessage } from "./config/FactoryConfigStore.ts";
import {
  chooseModel,
  ambiguousDrivers,
  factoryModelCatalog,
  resolveModelList,
  stalePreferences,
  usableModelPool,
  withInstancePreferences,
  type FactoryModelCatalog,
  type ModelChoice,
  type ResolvedModelList,
} from "./config/modelResolution.ts";
import { findTeamMember, pickFactoryTeam } from "./config/teamStaffing.ts";
import { rollupMemberStats } from "./memberStats.ts";
import { controlPathMatcher, controlPathProblem, normaliseControlPath } from "./controlPaths.ts";
import { factoryConfigProblem, modelKey, overrideWidensPool } from "./factoryConfig.ts";
import {
  definitionTeamSection,
  leadBrief,
  managerBrief,
  protocolBrief,
  renderRoleSkill,
  roleSkillSource,
  type RoleSkillFill,
  type RoleSkillSource,
  withProjectSection,
  workerBrief,
  workerRules,
  WORKER_RULES,
  workerTask,
} from "./roleSkills.ts";
import { ONBOARDING_BRIEF } from "./roles/index.ts";
import * as FactoryTicketHost from "./tickets/FactoryTicketHost.ts";

/** Upstream's thread launch, as the factory calls it. */
export interface FactoryThreadLaunch {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly text: string;
  /** The initial message's id; launch picks one when it is not given. */
  readonly messageId?: MessageId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspace: ThreadLaunchService.ThreadLaunchWorkspaceStrategy;
}

/** A pull request linked on a lead's thread, as its last sync saw it. */
export interface FactoryThreadPullRequest {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly merged: boolean;
  /** Null until the link's first sync. */
  readonly state: PullRequestState | null;
  /** The snapshot's version, which the control-path check keys on; null until the first sync. */
  readonly updatedAt: string | null;
  /** Null until the host reports it. */
  readonly mergeability?: PullRequestMergeability | null;
}

/**
 * A pull request the user merged in Satellite, as PullRequestService announces it. The event
 * carries no host, and it fires before the link's sync sees the merge.
 */
export interface FactoryMergedPullRequest {
  readonly repository: string;
  readonly number: number;
}

/** What reconciling a lead reads from its thread. */
export interface FactoryThreadRuns {
  readonly deleted: boolean;
  /** The status of the run with the highest ordinal. */
  readonly latestRunStatus: OrchestrationV2RunStatus | null;
  readonly runInProgress: boolean;
  /** Approvals and questions on the thread that nobody has answered yet. */
  readonly pendingRequests: number;
  readonly pullRequests: ReadonlyArray<FactoryThreadPullRequest>;
  readonly worktreePath: string | null;
}

export interface FactoryThreadInterrupt {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly reason: string;
}

/** A pull request whose changed files the control-path check reads. */
export interface FactoryPullRequestRef {
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

/** One provider turn of a member thread, as team stats count it. */
export interface FactoryThreadTurn {
  readonly model: string;
  readonly instanceId: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Input includes cached input. Null when the provider reported no usage for the turn. */
  readonly tokens: {
    readonly input: number;
    readonly cachedInput: number;
    readonly output: number;
  } | null;
}

/** A worker the lead launched from a delegation plan. */
export interface FactoryMemberRecord {
  readonly threadId: ThreadId;
  /**
   * As the delegation plan names it: a worker role on an older team, or `worker` for a member of
   * a team built from definitions. Recording checks it against the team.
   */
  readonly role: FactoryRole;
  /** The team member a `worker` was delegated as, from its delegation plan. */
  readonly memberName?: string | undefined;
  readonly modelSelection: ModelSelection;
  readonly joined: "created";
}

/** A new thread as upstream's `thread.created` reports it. */
export interface FactoryObservedThread {
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly modelSelection: ModelSelection;
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
  /** The factory config: the definitions teams, leads and managers are copied from. */
  readonly configStore: FactoryConfigStore["Service"];
  /** What this environment can run now, which portable model names resolve against. */
  readonly readModelCatalog: Effect.Effect<FactoryModelCatalog>;
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
  /** Empty when the thread is unknown. */
  readonly readThreadTurns: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<FactoryThreadTurn>>;
  /** The model rates usage tracking last cached, or null when there are none. */
  readonly readRateTable: Effect.Effect<RateTable | null>;
  readonly sendToThread: (
    input: FactoryThreadMessage,
  ) => Effect.Effect<void, FactoryOperationError>;
  /** Marks the thread settled and stops its provider session once any running turn ends. */
  readonly settleThread: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
  }) => Effect.Effect<void, FactoryOperationError>;
  /** Stops the thread's active run; a thread with no active run succeeds. */
  readonly interruptThread: (
    input: FactoryThreadInterrupt,
  ) => Effect.Effect<void, FactoryOperationError>;
  /** The primary remote's default branch, or null when it cannot be read. */
  readonly readDefaultBranch: (cwd: string) => Effect.Effect<string | null>;
  /** Every path the pull request changes, renamed files under both names. */
  readonly readPullRequestFiles: (
    input: FactoryPullRequestRef,
  ) => Effect.Effect<ReadonlyArray<string>, FactoryOperationError>;
  /** The pull request's head commit SHA, or null when it is unknown or cannot be read. */
  readonly readPullRequestHead: (input: FactoryPullRequestRef) => Effect.Effect<string | null>;
  /**
   * Files a ticket in the board's first Ready column. The marker is unique per draft; the host
   * hides it in the body and looks for it first, so a retry never files twice.
   */
  readonly createTicket: (input: {
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly board: IssueBoardSummary;
    readonly marker: string;
    readonly title: string;
    readonly body: string;
  }) => Effect.Effect<IssueRef, FactoryOperationError>;
  /** Test seam: runs inside wake delivery just before it reads the undelivered wakes. */
  readonly readingWakes?: (managerId: string) => Effect.Effect<void>;
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
  /**
   * Gives every manager created before definition copies a copy of the first manager definition.
   * Runs at startup after the config migration; returns how many managers it changed.
   */
  readonly adoptManagerDefinitions: Effect.Effect<number, FactoryOperationError>;
  readonly pauseManager: (
    input: FactoryManagersPauseInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  readonly resumeManager: (
    input: FactoryManagersResumeInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  readonly retireManager: (
    input: FactoryManagersRetireInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  /**
   * Stores the proposal the manager in this thread submits for the user to approve, with the
   * boards and default branch Satellite reads itself.
   */
  readonly proposeOnboarding: (
    threadId: ThreadId,
    input: FactoryOnboardingProposalInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  /** Every proposed question needs its rule, and pickup that is on a column still Ready. */
  readonly approveOnboarding: (
    input: FactoryManagersApproveOnboardingInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  /** Moves a `ready` manager to `active` and offers it the tickets in its pickup columns. */
  readonly startPickup: (
    input: FactoryManagersStartPickupInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  /**
   * Replaces an approved manager's settings through the checks approval makes, and wakes the
   * manager with what changed. Turning pickup on waits for the user's start, as after approval.
   */
  readonly updateSettings: (
    input: FactoryManagersUpdateSettingsInput,
  ) => Effect.Effect<FactoryManager, FactoryOperationError>;
  /**
   * What to tell a manager-only tool called from a manager's finished onboarding thread, or null
   * for any other thread. It scans the approval log, so ask only once no manager was found.
   */
  readonly finishedOnboardingMessage: (
    threadId: ThreadId,
  ) => Effect.Effect<string | null, FactoryOperationError>;
  /** The current manager whose own thread this is, or null. */
  readonly managerForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<FactoryManager | null, FactoryOperationError>;
  /**
   * A role's skill for this manager's project, with its placeholders filled. Asked within an
   * assignment, a lead's or worker's brief lists the protected files the user allowed it.
   */
  readonly roleBrief: (
    projectId: ProjectId,
    role: FactoryRole,
    managerId: string,
    assignmentId?: string,
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
  /**
   * The lead in this thread claims its assignment complete. Every claimed pull request must be
   * linked on the thread. Once none linked there is still open, the retro starts; until then the
   * user reviews.
   */
  readonly claimComplete: (
    leadThreadId: ThreadId,
    input: FactoryClaimCompleteInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  /** The lead in this thread reports a dependency, which blocks its assignment. */
  readonly reportDependency: (
    leadThreadId: ThreadId,
    input: FactoryReportDependencyInput,
  ) => Effect.Effect<FactoryDependency, FactoryOperationError>;
  /** The lead in this thread asks its manager a question; a paused manager hears it on resume. */
  readonly askManager: (
    leadThreadId: ThreadId,
    input: FactoryAskManagerInput,
  ) => Effect.Effect<
    { readonly assignment: FactoryAssignment; readonly managerPaused: boolean },
    FactoryOperationError
  >;
  /**
   * The manager in this thread spends a recovery on a stalled assignment, or hands it to the user
   * once the allowance is spent.
   */
  readonly recover: (
    managerThreadId: ThreadId,
    input: FactoryRecoverInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  /**
   * The manager in this thread replaces a live assignment's brief or completion condition, and
   * its lead is told once.
   */
  readonly amendAssignment: (
    managerThreadId: ThreadId,
    input: FactoryAmendAssignmentInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  /** The manager in this thread ends an assignment whose retro is in. */
  readonly complete: (
    managerThreadId: ThreadId,
    input: FactoryCompleteInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  readonly cancel: (
    input: FactoryAssignmentsCancelInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  /**
   * The user allows or declines one protected-path ask. The assignment's flagged files are
   * re-judged at once, and the manager and the lead are told the answer.
   */
  readonly answerProtectedPaths: (
    input: FactoryAssignmentsAnswerProtectedPathsInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  readonly takeOver: (
    input: FactoryThreadsTakeOverInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  readonly handBack: (
    input: FactoryThreadsHandBackInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  /**
   * Reconciles a lead with its thread: stalls, questions waiting on the user, and merges of the
   * pull requests a completion claim waits on.
   */
  readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void>;
  /** Reconciles the live leads with a pull request the user just merged, ahead of its sync. */
  readonly reconcileMerge: (merged: FactoryMergedPullRequest) => Effect.Effect<void>;
  /**
   * Reconciles every live lead, records a pickup wake for unjudged Ready tickets while there is
   * capacity, and delivers each active manager's undelivered wakes in one message.
   */
  readonly sweep: Effect.Effect<void>;
  /**
   * What delegating a worker from the lead in this thread launches: the role must be on the
   * team with a free place, and the model one the member allows. Changes nothing.
   */
  readonly planDelegation: (
    leadThreadId: ThreadId,
    input: FactoryDelegateInput,
  ) => Effect.Effect<FactoryDelegationPlan, FactoryOperationError>;
  /** Records a worker the lead in this thread launched from a delegation plan. */
  readonly recordMember: (
    leadThreadId: ThreadId,
    input: FactoryMemberRecord,
  ) => Effect.Effect<FactoryMember, FactoryOperationError>;
  /**
   * Joins a new thread to its parent's team when the parent is a live member, and wakes the
   * manager when it runs a model outside the pool. Other threads are ignored.
   */
  readonly observeThread: (thread: FactoryObservedThread) => Effect.Effect<void>;
  /** The lead in this thread replaces its assignment's checklist. */
  readonly updateChecklist: (
    leadThreadId: ThreadId,
    input: FactoryUpdateChecklistInput,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  /** The manager in this thread adds a team of definition copies to the factory config. */
  readonly createTeam: (
    managerThreadId: ThreadId,
    input: FactoryCreateTeamFromDefinitionsInput,
  ) => Effect.Effect<FactoryTeamDefinition, FactoryOperationError>;
  readonly subscribeWorkspace: (
    input: FactoryWorkspaceSubscribeInput,
  ) => Stream.Stream<FactoryWorkspaceFeed, FactoryOperationError>;
  /**
   * A live member of an assignment's team, lead or worker, records what it noticed. An escalated
   * finding wakes the manager now rather than waiting for the retro.
   */
  readonly recordFinding: (
    memberThreadId: ThreadId,
    input: FactoryRecordFindingInput,
  ) => Effect.Effect<FactoryFinding, FactoryOperationError>;
  readonly listFindings: (
    input: FactoryFindingsListInput,
  ) => Effect.Effect<ReadonlyArray<FactoryFinding>, FactoryOperationError>;
  /** The lead in this thread finished the team retro, which wakes the manager for its own. */
  readonly retroDone: (
    leadThreadId: ThreadId,
  ) => Effect.Effect<FactoryAssignment, FactoryOperationError>;
  /**
   * The manager in this thread drafts a ticket for the user's triage, with the drafts and open
   * tickets whose titles overlap it.
   */
  readonly draftTicket: (
    managerThreadId: ThreadId,
    input: FactoryDraftTicketInput,
  ) => Effect.Effect<FactoryDraftTicketResult, FactoryOperationError>;
  readonly listDrafts: (
    input: FactoryDraftsListInput,
  ) => Effect.Effect<ReadonlyArray<FactoryTicketDraft>, FactoryOperationError>;
  readonly subscribeDrafts: (
    input: FactoryDraftsSubscribeInput,
  ) => Stream.Stream<FactoryDraftsEvent, FactoryOperationError>;
  readonly editDraft: (
    input: FactoryDraftsEditInput,
  ) => Effect.Effect<FactoryTicketDraft, FactoryOperationError>;
  /** A project draft files its ticket; a factory draft is accepted with no ticket. */
  readonly approveDraft: (
    input: FactoryDraftsApproveInput,
  ) => Effect.Effect<FactoryTicketDraft, FactoryOperationError>;
  readonly dismissDraft: (
    input: FactoryDraftsDismissInput,
  ) => Effect.Effect<FactoryTicketDraft, FactoryOperationError>;
  readonly restoreDraft: (
    input: FactoryDraftsRestoreInput,
  ) => Effect.Effect<FactoryTicketDraft, FactoryOperationError>;
  /** Writes a factory draft's proposed change to the environment config and accepts the draft. */
  readonly applyDraft: (
    input: FactoryDraftsApplyInput,
  ) => Effect.Effect<FactoryTicketDraft, FactoryOperationError>;
  /** Ended assignments' stats, newest first, with each team's medians over them. */
  readonly getStats: (
    input: FactoryStatsGetInput,
  ) => Effect.Effect<FactoryStatsResult, FactoryOperationError>;
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
const encodeManagerDefinition = Schema.encodeSync(Schema.fromJsonString(FactoryManagerDefinition));
const encodeProposal = Schema.encodeSync(Schema.fromJsonString(FactoryOnboardingProposal));
const encodeResult = Schema.encodeSync(Schema.fromJsonString(FactoryOnboardingResult));
const decodeManagerValue = Schema.decodeUnknownEffect(FactoryManager);
const decodeAssignmentValue = Schema.decodeUnknownEffect(FactoryAssignment);
const decodeDependencyValue = Schema.decodeUnknownEffect(FactoryDependency);
const decodeLogValue = Schema.decodeUnknownEffect(FactoryLogEntry);
const decodeMemberValue = Schema.decodeUnknownEffect(FactoryMember);
const decodeWorkspaceFeed = Schema.decodeUnknownEffect(FactoryWorkspaceFeed);
const decodeFindingValue = Schema.decodeUnknownEffect(FactoryFinding);
const decodeDraftValue = Schema.decodeUnknownEffect(FactoryTicketDraft);
const decodeStatsValue = Schema.decodeUnknownEffect(FactoryAssignmentStats);
const ControlChecked = Schema.Record(Schema.String, Schema.String);
const ControlViolations = Schema.Array(FactoryControlViolation);
const ProtectedPathAsks = Schema.Array(FactoryProtectedPathAsk);
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

/**
 * What clients and agents see of an assignment's team. The stored snapshot carries every member's
 * description and the lead's instructions, which are too large to send on every event and are not
 * the reader's to see; its shape goes out as a summary instead.
 */
const outgoingTeam = ({ definition, ...team }: FactoryTeamSpec): FactoryTeamSpec =>
  definition === undefined
    ? team
    : {
        ...team,
        summary: {
          name: definition.name,
          members: definition.members.map((member) => ({ name: member.name, count: member.count })),
          mayEditProtectedPaths: definition.mayEditProtectedPaths,
        },
      };

const STALLED_RUNS: Partial<Record<OrchestrationV2RunStatus, string>> = {
  failed: "failed",
  cancelled: "was cancelled",
  interrupted: "was interrupted",
  rolled_back: "was rolled back",
};

/** States a completion claim can arrive in. */
const CLAIMABLE_STATES: ReadonlySet<string> = new Set<FactoryAssignmentState>([
  "active",
  "blocked",
  "waiting-user",
]);
const isTerminal = (state: string) => state === "completed" || state === "cancelled";

const stallReason = (runs: FactoryThreadRuns): string | null => {
  if (runs.deleted) return "The lead's thread was deleted.";
  if (runs.runInProgress || runs.pendingRequests > 0 || runs.latestRunStatus === null) return null;
  const phrase = STALLED_RUNS[runs.latestRunStatus];
  return phrase === undefined ? null : `The lead's latest run ${phrase}.`;
};

const managerStateProblem = (manager: FactoryManager): string | null => {
  switch (manager.state) {
    case "ready":
    case "active":
      return null;
    case "onboarding":
      return `${manager.name} is still onboarding. Nothing starts until the user approves its onboarding.`;
    case "manager-paused":
    case "project-paused":
      return `${manager.name} is paused. Nothing starts until the user resumes it.`;
    case "retired":
      return `${manager.name} is retired.`;
  }
};

/** Why pickup cannot start, or null for a `ready` manager. */
const startPickupProblem = (manager: FactoryManager): string | null => {
  switch (manager.state) {
    case "ready":
      return null;
    case "active":
      return manager.onboardingResult?.pickup.enabled === true
        ? `${manager.name} is already picking up tickets.`
        : `Pickup is off for ${manager.name}; turn it on in its settings.`;
    case "onboarding":
      return `${manager.name} is still onboarding.`;
    case "manager-paused":
    case "project-paused":
      return `Resume ${manager.name} first.`;
    case "retired":
      return `${manager.name} is retired.`;
  }
};

const PRIMED_CLOSING =
  "Onboarding is done; this thread replaces the onboarding thread. Reply with exactly: Ready.";

const ONBOARDING_FINISHED =
  "This thread's onboarding is finished; the manager now runs in a new thread.";

const decodeStoredRuntimeMode = Schema.decodeUnknownOption(RuntimeMode);
/** The mode the manager launched with; the nullable column reads as the default, full access. */
const decodeRuntimeMode = (text: string | null): RuntimeMode =>
  Option.getOrElse(decodeStoredRuntimeMode(text), () => "full-access" as const);

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
const RetroWakePayload = Schema.Struct({
  title: Schema.String,
  assignmentId: Schema.String,
  cancelReason: Schema.optionalKey(Schema.String),
});
const DependencyWakePayload = Schema.Struct({
  title: Schema.String,
  assignmentId: Schema.String,
  dependencyId: Schema.String,
  dependencyTitle: Schema.String,
  unblockCondition: Schema.String,
  brief: Schema.String,
});
const HandbackWakePayload = Schema.Struct({
  title: Schema.String,
  assignmentId: Schema.String,
  state: Schema.String,
});
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
const decodeRetroWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(RetroWakePayload)),
);
const decodeDependencyWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(DependencyWakePayload)),
);
const ClaimWakePayload = Schema.Struct({
  title: Schema.String,
  assignmentId: Schema.String,
  pullRequests: Schema.Array(
    Schema.Struct({
      repository: Schema.String,
      number: Schema.Number,
      headSha: Schema.NullOr(Schema.String),
      merged: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeClaimWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(ClaimWakePayload)),
);
const QuestionWakePayload = Schema.Struct({
  title: Schema.String,
  assignmentId: Schema.String,
  leadThreadId: Schema.String,
  question: Schema.String,
});
const decodeQuestionWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(QuestionWakePayload)),
);
const decodeHandbackWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(HandbackWakePayload)),
);
const OnboardedPayload = Schema.Struct({
  onboardingThreadId: Schema.NullOr(Schema.String),
  primingMessageId: Schema.optional(Schema.String),
});
const decodeOnboardedPayload = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(OnboardedPayload)),
);
const ControlWakePayload = Schema.Struct({ title: Schema.String, text: Schema.String });
const decodeControlWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(ControlWakePayload)),
);
const ConflictLogPayload = Schema.Struct({ pullRequest: Schema.String, asked: Schema.Boolean });
const decodeConflictLog = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(ConflictLogPayload)),
);
const OffPoolWakePayload = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  model: Schema.String,
});
const decodeOffPoolWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(OffPoolWakePayload)),
);
const FindingWakePayload = Schema.Struct({
  assignmentId: Schema.String,
  title: Schema.String,
  findingId: Schema.String,
  summary: Schema.String,
});
const decodeFindingWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(FindingWakePayload)),
);
const ManagerRetroWakePayload = Schema.Struct({
  assignmentId: Schema.String,
  title: Schema.String,
  cancelled: Schema.Boolean,
  /** The lead's thread was deleted before it finished the team retro. */
  teamRetroSkipped: Schema.optionalKey(Schema.Boolean),
});
const decodeManagerRetroWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(ManagerRetroWakePayload)),
);
const SettingsWakePayload = Schema.Struct({ changes: Schema.Array(Schema.String) });
const decodeSettingsWake = jsonDecoder(
  Schema.decodeUnknownOption(Schema.fromJsonString(SettingsWakePayload)),
);

/** Why an approved manager's settings cannot change now, or null. */
const settingsStateProblem = (manager: FactoryManager): string | null => {
  if (manager.onboardingResult === null)
    return `${manager.name} is still onboarding; approve its onboarding first.`;
  switch (manager.state) {
    case "ready":
    case "active":
    case "manager-paused":
    case "project-paused":
      return null;
    case "onboarding":
      return `${manager.name} is still onboarding; approve its onboarding first.`;
    case "retired":
      return `${manager.name} is retired.`;
  }
};

const listed = (values: ReadonlyArray<string>, empty: string) =>
  values.length === 0 ? empty : values.join(", ");
const quoted = (value: string) => (value.trim() === "" ? "(none)" : `"${value.trim()}"`);

/** Each setting that differs, as `name: old → new`, for the manager's wake. */
const settingsChanges = (
  before: FactoryOnboardingResult,
  after: FactoryOnboardingResult,
  boards: ReadonlyArray<FactoryOnboardingBoard>,
) => {
  const changes: string[] = [];
  const line = (name: string, old: string, next: string) => {
    if (old !== next) changes.push(`${name}: ${old} → ${next}`);
  };
  const columnName = (column: FactoryPickupColumn) => {
    const board = boards.find((candidate) => candidate.boardId === column.boardId);
    const title = board?.readyColumns.find((ready) => ready.id === column.columnId)?.title;
    return title === undefined ? column.columnId : `${title} (${board!.title})`;
  };
  line("purpose", quoted(before.purpose), quoted(after.purpose));
  line("pickup", before.pickup.enabled ? "on" : "off", after.pickup.enabled ? "on" : "off");
  line(
    "pickup columns",
    listed(before.pickup.columns.map(columnName), "(none)"),
    listed(after.pickup.columns.map(columnName), "(none)"),
  );
  line(
    "pickup labels",
    listed(before.pickup.labels, "(any)"),
    listed(after.pickup.labels, "(any)"),
  );
  line("pickup guidance", quoted(before.pickup.guidance), quoted(after.pickup.guidance));
  line("concurrency cap", String(before.concurrencyCap), String(after.concurrencyCap));
  line("teams", listed(before.teamIds, "all"), listed(after.teamIds, "all"));
  const paths = (result: FactoryOnboardingResult) =>
    listed(
      result.controlPaths.map((controlPath) =>
        controlPath.reason.trim() === ""
          ? controlPath.path
          : `${controlPath.path} (${controlPath.reason.trim()})`,
      ),
      "(none)",
    );
  line("protected paths", paths(before), paths(after));
  for (const rule of after.rules) {
    const old = before.rules.find((candidate) => candidate.id === rule.id);
    if (old !== undefined) line(`rule "${rule.question}"`, quoted(old.answer), quoted(rule.answer));
  }
  return changes;
};

const decodeIssueRef = jsonDecoder(Schema.decodeUnknownOption(Schema.fromJsonString(IssueRef)));

/** Ends agent- or user-written text with a full stop when it has none, so wake text reads. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const pullRequestKey = (key: ThreadPullRequestKey) => `${key.host}/${key.repository}#${key.number}`;

const isMerge = (
  merged: FactoryMergedPullRequest | undefined,
  pullRequest: { readonly repository: string; readonly number: number },
) =>
  merged !== undefined &&
  pullRequest.number === merged.number &&
  pullRequest.repository.toLowerCase() === merged.repository.toLowerCase();

/** The links as they read once their sync sees the user's merge. */
const withMerge = (
  links: ReadonlyArray<FactoryThreadPullRequest>,
  merged: FactoryMergedPullRequest | undefined,
) =>
  links.map((link) =>
    isMerge(merged, link) ? { ...link, merged: true, state: "merged" as const } : link,
  );

/**
 * Paths the user allowed for the assignment. An allowed path in any ask is allowed, even if
 * another ask that names it was declined.
 */
const allowedPaths = (asks: ReadonlyArray<FactoryProtectedPathAsk>) =>
  new Set(asks.flatMap((ask) => (ask.state === "allowed" ? ask.paths : [])));

/** Paths the user declined and has not allowed in another ask. */
const declinedPaths = (asks: ReadonlyArray<FactoryProtectedPathAsk>) => {
  const allowed = allowedPaths(asks);
  return new Set(
    asks.flatMap((ask) =>
      ask.state === "declined" ? ask.paths.filter((path) => !allowed.has(path)) : [],
    ),
  );
};

/** The stored violations without the paths the user allowed, dropping a pull request left empty. */
const effectiveViolations = (
  violations: ReadonlyArray<FactoryControlViolation>,
  asks: ReadonlyArray<FactoryProtectedPathAsk>,
): FactoryControlViolation[] => {
  const allowed = allowedPaths(asks);
  return violations.flatMap((violation) => {
    const paths = violation.paths.filter((path) => !allowed.has(path));
    return paths.length === 0 ? [] : [{ ...violation, paths }];
  });
};

const controlReason = (violations: ReadonlyArray<FactoryControlViolation>) =>
  violations
    .map(
      (violation) =>
        `Pull request #${violation.pullRequest.number} changes protected paths: ${violation.paths.join(", ")}.`,
    )
    .join(" ");

const violationText = (
  violation: FactoryControlViolation,
  asks: ReadonlyArray<FactoryProtectedPathAsk>,
) => {
  const allowed = [...allowedPaths(asks)];
  const declined = declinedPaths(asks);
  const flaggedDeclined = violation.paths.filter((path) => declined.has(path));
  return [
    `Pull request #${violation.pullRequest.number} changes protected paths (${violation.paths.join(", ")}).`,
    ...(allowed.length === 0
      ? []
      : [`Already allowed for this assignment: ${allowed.join(", ")}.`]),
    "The user can allow the flagged files for this assignment from the team's card.",
    `Keep an edit the task needs and wait for the user's answer; revert only an unintended edit or one the user declined${flaggedDeclined.length === 0 ? "" : ` (${flaggedDeclined.join(", ")})`}.`,
    "The factory cannot send this to the user as ready while unallowed protected changes remain.",
  ].join(" ");
};

/** What the lead hears when a new push still changes files the user declined. */
const declinedAgainText = (violation: FactoryControlViolation) =>
  `The user declined edits to these protected files for this assignment, and pull request #${violation.pullRequest.number} still changes them: ${violation.paths.join(", ")}. Revert them.`;

// A spent recovery allowance waits on the user's decision about a dead lead; a hold would hide it.
const HOLDABLE_WAITS: ReadonlySet<string | null> = new Set([null, "review", "question"]);

/**
 * Unallowed flags remain but the assignment is not held for them, as a fresh flag would hold it:
 * from work or from waiting on the user for something else.
 */
const needsHold = (
  row: { readonly state: string; readonly waiting_kind: string | null },
  effective: ReadonlyArray<FactoryControlViolation>,
) =>
  effective.length > 0 &&
  (row.state === "active" ||
    (row.state === "waiting-user" && HOLDABLE_WAITS.has(row.waiting_kind)));

/**
 * The state a stalled or blocked assignment returns to work in. Unallowed flags it left the hold
 * with, such as a revoke while it was out, hold it again; they were announced already, so this
 * wakes no one.
 */
const returnToWork = (row: {
  readonly control_violations_json: string;
  readonly protected_path_asks_json: string;
}) =>
  Effect.all([
    parse(ControlViolations, row.control_violations_json),
    parse(ProtectedPathAsks, row.protected_path_asks_json),
  ]).pipe(
    Effect.map(([violations, asks]) => {
      const effective = effectiveViolations(violations, asks);
      return effective.length === 0
        ? { state: "active" as const, kind: null, reason: null }
        : {
            state: "waiting-user" as const,
            kind: "control" as const,
            reason: controlReason(effective),
          };
    }),
  );

/** How the user answered an ask, as the manager and the lead are told it. */
const answerText = (
  verb: "allowed" | "declined" | "revoked",
  paths: ReadonlyArray<string>,
  forLead: boolean,
) => {
  const files = paths.join(", ");
  switch (verb) {
    case "allowed":
      return forLead
        ? `The user allowed edits to these protected files for this assignment: ${files}. You may edit them for this assignment only. Tell any running worker who needs them.`
        : `The user allowed edits to these protected files for this assignment: ${files}.`;
    case "declined":
      return `The user declined edits to these protected files for this assignment: ${files}.${forLead ? " Do not edit them, and revert any edit to them." : ""}`;
    case "revoked":
      return `The user revoked the allowance for these protected files: ${files}.${forLead ? " Revert those edits." : ""}`;
  }
};

const RETRO_ASK =
  "Write your team retro now: what worked, what did not, what the next team should change, then call factory_retro_done.";

/** Title words a duplicate check compares: lowercased, four letters or more. */
const titleWords = (title: string) =>
  new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((word) => word.length >= 4),
  );
/** Shared words over the longer title's, so both titles must mostly overlap. */
const titleOverlap = (left: ReadonlySet<string>, right: ReadonlySet<string>) => {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.max(left.size, right.size);
};
const SIMILAR_OVERLAP = 0.6;
const SIMILAR_LIMIT = 10;
// Hosts report their own state names; these are the closed ones GitHub and Azure Boards use.
const CLOSED_ISSUE_STATES: ReadonlySet<string> = new Set([
  "closed",
  "done",
  "resolved",
  "removed",
  "completed",
]);

const ticketBody = (
  body: string,
  acceptanceCriteria: ReadonlyArray<string>,
  assignmentTitle: string | null,
) =>
  [
    body,
    ...(acceptanceCriteria.length === 0
      ? []
      : [
          `## Acceptance criteria\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
        ]),
    assignmentTitle === null
      ? "Filed by the Satellite factory"
      : `Filed by the Satellite factory from assignment ${assignmentTitle}`,
  ].join("\n\n");

// Only what the project protects: role skills left the repository for the factory config.
const controlPathsOf = (paths: ReadonlyArray<string>) => [
  ...new Set(paths.map((path) => path.trim()).filter((path) => path !== "")),
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
    // A member copied from a worker definition carries its own models, so the pool is the bound.
    case "worker":
      return config.modelPool;
    default:
      return workers[role].length > 0 ? workers[role] : config.modelPool;
  }
};

const skillFill = (
  config: FactoryConfig,
  role: FactoryRole,
  protectedPaths: ReadonlyArray<string>,
  allowedProtectedPaths: ReadonlyArray<string>,
): RoleSkillFill => ({
  modelPool: config.modelPool,
  allowedModels: allowedModelsFor(config, role),
  protectedPaths,
  allowedProtectedPaths,
  completionCondition: null,
});

const modelName = (model: ModelSelection) => `${model.instanceId}/${model.model}`;

/** Why a model list gives an agent no model to start, as the agent asking should read it. */
const modelChoiceRefusal = (
  choice: Exclude<ModelChoice, { kind: "chosen" }>,
  who: string,
  requested: ModelSelection | undefined,
  resolved: ResolvedModelList,
) => {
  switch (choice.kind) {
    case "none":
      return `None of ${who}'s models can run on this environment. Add one it can run to the factory pool, or change ${who}'s models.`;
    case "not-listed":
      return `${requested ? modelName(requested) : "That model"} is not one ${who} may run. Choose from: ${resolved.models.map(modelName).join(", ")}.`;
    case "not-first":
      return `${who[0]!.toUpperCase()}${who.slice(1)} runs its models in order, so it starts on ${modelName(choice.first)}.`;
  }
};

/** The lead's model, from the lead copy in its team: picked from a dynamic list, else the first. */
const leadModelFor = (
  team: FactoryTeamDefinition,
  files: { readonly view: FactoryDefinitionsView; readonly catalog: FactoryModelCatalog },
  requested: ModelSelection | undefined,
): { readonly model: ModelSelection } | { readonly refusal: string } => {
  const resolved = resolveModelList(team.lead.models, files.view.settings, files.catalog);
  const choice = chooseModel(resolved, requested);
  return choice.kind === "chosen"
    ? { model: choice.model }
    : { refusal: modelChoiceRefusal(choice, "this team's lead", requested, resolved) };
};

const memberLine = (member: FactoryTeamMember) =>
  `${member.count} × ${member.role}${
    member.models !== undefined && member.models.length > 0
      ? ` (${member.models.map(modelName).join(", ")})`
      : ""
  }`;

const presetFor = (config: FactoryConfig, team: FactoryTeamSpec) =>
  team.preset === "custom"
    ? undefined
    : config.teamPresets.find((preset) => preset.name === team.preset);

/** The lead's view of its team; a preset also brings its workflow. */
/** Every model a team from definitions may run; a member with no list may use the pool. */
const definitionTeamModels = (team: FactoryTeamDefinition, fill: RoleSkillFill) => {
  const listed = team.members.flatMap((member) => member.models.models);
  const unrestricted = team.members.some((member) => member.models.models.length === 0);
  const all = [...listed, ...(unrestricted ? fill.modelPool : [])];
  return [
    ...new Map(
      all.map((model) => [
        `${"driver" in model ? model.driver : model.instanceId}/${model.model}`,
        model,
      ]),
    ).values(),
  ];
};

const teamSection = (config: FactoryConfig, team: FactoryTeamSpec) => {
  if (team.definition !== undefined) return definitionTeamSection(team.definition);
  const members = team.members.map(memberLine).join(", ");
  const preset = presetFor(config, team);
  if (preset !== undefined)
    return `# Team\n\nPreset ${preset.name}: ${members}${preset.workflow === "" ? "" : `\n\n${preset.workflow}`}`;
  return team.members.length === 0 ? null : `# Team\n\n${members}`;
};

const PICKUP_GUIDANCE_MOVED =
  "Pickup guidance is now set per manager at onboarding, not in the factory config, so it cannot be changed through a factory draft.";

const SETTING_LABELS = {
  concurrencyCap: "concurrency cap",
  recoveryAllowance: "recovery allowance",
} as const;

const shownValue = (value: unknown) => {
  const text = json(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

const PRESETS_MOVED =
  "Teams live in the factory config now. Ask the manager to propose a team change.";

const isFactoryConfig = Schema.is(FactoryConfig);

/**
 * The environment config with a proposed change applied, or why it no longer applies. The change
 * names the value it replaces, so a config edited since the retro is refused rather than clobbered.
 */
const applyProposedChange = (
  config: FactoryConfig,
  change: Exclude<FactoryProposedChange, DefinitionChange>,
): { readonly config: FactoryConfig } | { readonly refused: FactoryOperationError } => {
  switch (change.kind) {
    case "role-skill":
      return { refused: error("invalid", "Edit the role file to apply this change.") };
    case "setting": {
      if (change.key === "pickupGuidance")
        return { refused: error("invalid", PICKUP_GUIDANCE_MOVED) };
      if (change.key === "digestIntervalMinutes")
        return {
          refused: error("invalid", "The factory no longer has a digest interval to change."),
        };
      const current = config[change.key];
      if (!NodeUtil.isDeepStrictEqual(current, change.before))
        return {
          refused: error(
            "conflict",
            `The ${SETTING_LABELS[change.key]} changed since this was proposed: it is now ${shownValue(current)}, not ${shownValue(change.before)}.`,
          ),
        };
      const next = { ...config, [change.key]: change.after };
      if (!isFactoryConfig(next))
        return {
          refused: error(
            "invalid",
            `${shownValue(change.after)} is not a valid ${SETTING_LABELS[change.key]}.`,
          ),
        };
      return { config: next };
    }
    case "preset":
      return { refused: error("invalid", PRESETS_MOVED) };
  }
};

const resultControlPaths = (result: FactoryOnboardingResult | null) =>
  controlPathsOf((result?.controlPaths ?? []).map((controlPath) => controlPath.path));

/** The approved control paths, or the proposed ones while onboarding. */
const protectedPathsOf = (manager: FactoryManager) =>
  manager.onboardingResult !== null
    ? resultControlPaths(manager.onboardingResult)
    : (manager.onboardingProposal?.controlPaths ?? []).map((controlPath) => controlPath.path);

/** The protected files the user allowed this assignment's team to edit. */
const allowedPathsOf = (row: { readonly protected_path_asks_json: string }) =>
  parse(ProtectedPathAsks, row.protected_path_asks_json).pipe(
    Effect.map((asks) => [...allowedPaths(asks)]),
  );

/** Onboarding, or paused while onboarding. */
const isOnboarding = (row: { readonly state: string; readonly paused_from: string | null }) =>
  row.state === "onboarding" ||
  ((row.state === "manager-paused" || row.state === "project-paused") &&
    row.paused_from === "onboarding");

/** What the schema cannot check, worded for the manager to fix and resubmit. */
const proposalProblem = (input: FactoryOnboardingProposalInput) => {
  const ids = new Set<string>();
  for (const question of input.rules) {
    if (ids.has(question.id))
      return `Two questions share the id "${question.id}". Give each question its own id.`;
    ids.add(question.id);
    if (question.recommended >= question.options.length)
      return `Question "${question.id}" recommends option ${question.recommended}, but it has ${question.options.length} options. recommended is the 0-based index of one of its options.`;
  }
  return null;
};

/** Every question the manager asked needs exactly one rule with its id, and every rule a question. */
const rulesProblem = (
  questions: ReadonlyArray<{ readonly id: string; readonly question: string }>,
  rules: FactoryOnboardingResult["rules"],
) => {
  const asked = new Set(questions.map((question) => question.id));
  const answered = new Set<string>();
  for (const rule of rules) {
    if (!asked.has(rule.id)) return `Rule "${rule.id}" answers none of the manager's questions.`;
    if (answered.has(rule.id)) return `Question "${rule.id}" is answered more than once.`;
    answered.add(rule.id);
  }
  const unanswered = questions.find((question) => !answered.has(question.id));
  return unanswered === undefined ? null : `Answer "${unanswered.question}" first.`;
};

/**
 * Pickup of two live managers on one project may not share a column unless their labels keep the
 * tickets apart; no labels means every ticket in the column.
 */
const pickupOverlapProblem = (
  pickup: FactoryOnboardingResult["pickup"],
  others: ReadonlyArray<{ readonly name: string; readonly pickup: FactoryPickup }>,
  boards: ReadonlyArray<FactoryOnboardingBoard>,
) => {
  if (!pickup.enabled) return null;
  for (const other of others) {
    if (!other.pickup.enabled) continue;
    const shared = pickup.columns.find((column) =>
      other.pickup.columns.some(
        (theirs) => theirs.boardId === column.boardId && theirs.columnId === column.columnId,
      ),
    );
    if (shared === undefined) continue;
    const labels = new Set(pickup.labels.map((label) => label.toLowerCase()));
    const overlap =
      labels.size === 0 ||
      other.pickup.labels.length === 0 ||
      other.pickup.labels.some((label) => labels.has(label.toLowerCase()));
    if (!overlap) continue;
    const board = boards.find((candidate) => candidate.boardId === shared.boardId);
    const column =
      board?.readyColumns.find((ready) => ready.id === shared.columnId)?.title ?? shared.columnId;
    return `${other.name} already picks up from ${column}${board ? ` on ${board.title}` : ""} with overlapping labels. Give each manager its own labels or columns.`;
  }
  return null;
};

/**
 * Pickup with each column's title and board title as the boards read now, so a client can show
 * them without reading the boards. They are not refreshed if a column is renamed later.
 */
const titledPickup = (
  pickup: FactoryPickup,
  boards: ReadonlyArray<FactoryOnboardingBoard>,
): FactoryPickup => ({
  ...pickup,
  columns: pickup.columns.map(({ boardId, columnId }) => {
    const board = boards.find((candidate) => candidate.boardId === boardId);
    const title = board?.readyColumns.find((ready) => ready.id === columnId)?.title;
    return board === undefined || title === undefined
      ? { boardId, columnId }
      : { boardId, columnId, title, boardTitle: board.title };
  }),
});

/** The part of pickup that decides which tickets a manager may take, for overlap. */
const pickupScope = (pickup: FactoryPickup) =>
  [
    pickup.enabled ? "on" : "off",
    pickup.columns
      .map((column) => `${column.boardId}/${column.columnId}`)
      .toSorted()
      .join(","),
    pickup.labels
      .map((label) => label.toLowerCase())
      .toSorted()
      .join(","),
  ].join("|");

/** What a result is checked against besides itself. */
interface ResultContext {
  /** The manager's questions: the proposal's while onboarding, the stored rules' afterwards. */
  readonly questions: ReadonlyArray<{ readonly id: string; readonly question: string }>;
  readonly boards: ReadonlyArray<FactoryOnboardingBoard>;
  readonly teamIds: ReadonlySet<string>;
  /** The project's other live managers with an approved result. */
  readonly others: ReadonlyArray<{ readonly name: string; readonly pickup: FactoryPickup }>;
}

/**
 * Why a manager's result cannot be saved, worded for the user; null when it can. Approval and a
 * later settings change both go through it. The cap's bounds are the schema's.
 */
const onboardingResultProblem = (result: FactoryOnboardingResult, context: ResultContext) => {
  const unknownTeam = result.teamIds.find((id) => !context.teamIds.has(id));
  return (
    rulesProblem(context.questions, result.rules) ??
    pickupColumnsProblem(result.pickup, context.boards) ??
    pickupOverlapProblem(result.pickup, context.others, context.boards) ??
    result.controlPaths.map((controlPath) => controlPathProblem(controlPath.path)).find(Boolean) ??
    (unknownTeam === undefined
      ? null
      : `There is no factory team "${unknownTeam}". Choose from the teams in the factory config.`)
  );
};

/**
 * Pickup that is on needs a column. Every stored column has to be a Ready column of a connected
 * board, even with pickup off, so turning pickup on later never inherits an unchecked one.
 */
const pickupColumnsProblem = (
  pickup: FactoryOnboardingResult["pickup"],
  boards: ReadonlyArray<FactoryOnboardingBoard>,
) => {
  const { columns } = pickup;
  if (pickup.enabled && columns.length === 0)
    return "Pickup is on, so choose at least one Ready column for it.";
  for (const column of columns) {
    const board = boards.find((candidate) => candidate.boardId === column.boardId);
    if (board === undefined)
      return `Column ${column.columnId} is on board ${column.boardId}, which is not a connected board with a mapping.`;
    if (!board.readyColumns.some((ready) => ready.id === column.columnId))
      return `Column ${column.columnId} is not a Ready column of ${board.title}.`;
  }
  return null;
};

interface StatsRow {
  readonly assignment_id: string;
  readonly manager_id: string;
  readonly project_id: string;
  readonly team: string;
  readonly complexity: string;
  readonly outcome: string;
  readonly team_verdict: string | null;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly cost_usd: number | null;
  readonly agent_ms: number;
  readonly wall_ms: number;
  readonly waiting_user_ms: number;
  readonly recoveries: number;
  readonly pull_requests: number;
  readonly review_rounds: number;
  readonly by_role_json: string;
  readonly by_model_json: string;
  /** Per team member, for teams built from definitions; null or absent otherwise. */
  readonly by_member_json?: string | null;
  readonly ended_at: string;
}

interface StatsTally {
  input: number;
  cachedInput: number;
  output: number;
  agentMs: number;
}

const tallyOf = (tallies: Map<string, StatsTally>, key: string) => {
  const existing = tallies.get(key);
  if (existing !== undefined) return existing;
  const tally = { input: 0, cachedInput: 0, output: 0, agentMs: 0 };
  tallies.set(key, tally);
  return tally;
};
const tokensOf = ({ input, cachedInput, output }: StatsTally) => ({ input, cachedInput, output });

const elapsedMs = (from: string, to: string) => {
  const elapsed = Date.parse(to) - Date.parse(from);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
};

/** The middle value, or the mean of the middle two; null for no values. */
const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const teamStats = (
  team: string,
  tasks: ReadonlyArray<FactoryAssignmentStats>,
): FactoryTeamStats => ({
  team,
  tasks: tasks.length,
  completed: tasks.filter((task) => task.outcome === "completed").length,
  cancelled: tasks.filter((task) => task.outcome === "cancelled").length,
  medianTokens: median(tasks.map((task) => task.tokens.input + task.tokens.output)) ?? 0,
  medianCostUsd: median(tasks.flatMap((task) => (task.costUsd === null ? [] : [task.costUsd]))),
  medianAgentMs: median(tasks.map((task) => task.agentMs)) ?? 0,
  medianWallMs: median(tasks.map((task) => task.wallMs)) ?? 0,
  meanRecoveries: mean(tasks.map((task) => task.recoveries)),
  meanReviewRounds: mean(tasks.map((task) => task.reviewRounds)),
  goodFit: tasks.filter((task) => task.teamVerdict === "good").length,
  poorFit: tasks.filter((task) => task.teamVerdict === "poor").length,
});

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
  readonly waiting_kind: string | null;
  readonly stall_reason: string | null;
  readonly cancel_reason: string | null;
  readonly claim_json: string | null;
  readonly team_verdict_json: string | null;
  readonly checklist_json: string;
  readonly control_violations_json: string;
  readonly control_checked_json: string;
  readonly protected_path_asks_json: string;
  readonly team_retro_at: string | null;
  readonly manager_retro_at: string | null;
  readonly waiting_user_ms: number;
  readonly waiting_since: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ended_at: string | null;
}

interface FindingRow {
  readonly id: string;
  readonly assignment_id: string;
  readonly manager_id: string;
  readonly thread_id: string;
  readonly class: string;
  readonly summary: string;
  readonly evidence: string;
  readonly uncertainty: string | null;
  readonly workaround: string | null;
  readonly escalated: number;
  readonly draft_id: string | null;
  readonly created_at: string;
}

interface DraftRow {
  readonly id: string;
  readonly manager_id: string;
  readonly project_id: string;
  readonly assignment_id: string | null;
  readonly scope: string;
  readonly title: string;
  readonly body: string;
  readonly acceptance_json: string;
  readonly finding_ids_json: string;
  readonly state: string;
  readonly issue_json: string | null;
  readonly proposed_change_json: string | null;
  readonly marker: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MemberRow {
  readonly thread_id: string;
  readonly manager_id: string;
  readonly assignment_id: string | null;
  readonly role: string;
  readonly member_name: string | null;
  readonly parent_thread_id: string | null;
  readonly joined: string;
  readonly taken_over: number;
  readonly off_pool: number;
  readonly ended_at: string | null;
}

const memberValue = (row: MemberRow) => ({
  threadId: row.thread_id,
  managerId: row.manager_id,
  assignmentId: row.assignment_id,
  role: row.role,
  ...(row.member_name ? { memberName: row.member_name } : {}),
  parentThreadId: row.parent_thread_id,
  joined: row.joined,
  takenOver: row.taken_over === 1,
  offPool: row.off_pool === 1,
  endedAt: row.ended_at,
});

/** An assignment with whether the user has taken over its lead's thread. */
interface LeadAssignmentRow extends AssignmentRow {
  readonly lead_taken_over: number;
}

interface DependencyRow {
  readonly id: string;
  readonly blocked_assignment_id: string;
  readonly delivering_assignment_id: string | null;
  readonly title: string;
  readonly unblock_condition: string;
  readonly brief: string;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
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
  /** The factory team asked for; otherwise `team.preset` names one, or the first is used. */
  readonly teamId?: string | undefined;
  /** The lead's model, for a team whose lead has a dynamic model list. */
  readonly leadModel?: ModelSelection | undefined;
  /** Null for work with no ticket: the lead gets its own worktree outside issue attempts. */
  readonly ticket: ReadyItem | null;
  /** The open dependency this assignment delivers, or null. */
  readonly dependencyId: string | null;
  /** Protected files the manager asks the user to allow, already checked and normalised. */
  readonly protectedPaths?:
    | { readonly paths: ReadonlyArray<string>; readonly reason: string }
    | undefined;
}

const findTicket = (items: ReadonlyArray<ReadyItem>, issueNumber: number, missing: string) => {
  const matches = items.filter((item) => item.issue.ref.number === issueNumber);
  const distinct = new Set(matches.map((item) => canonicalIssueKey(item.issue.ref)));
  if (distinct.size > 1)
    return {
      found: false,
      reason: "invalid",
      message: `#${issueNumber} matches Ready tickets in more than one repository.`,
    } as const;
  const ticket = matches[0];
  if (ticket === undefined) return { found: false, reason: "conflict", message: missing } as const;
  return { found: true, ticket } as const;
};

interface ManagerRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly state: string;
  readonly paused_from: string | null;
  readonly thread_id: string | null;
  readonly onboarding_proposal_json: string | null;
  readonly onboarding_result_json: string | null;
  readonly model_selection_json: string | null;
  /** The manager's copy of its definition; null for managers created before definitions. */
  readonly definition_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly active_assignments: number;
  readonly waiting_on_you: number;
  /** The latest `onboarded` log entry's payload; approval writes no column of its own. */
  readonly onboarded_json: string | null;
}

export const makeFactoryService = Effect.fn("makeFactoryService")(function* (
  deps: FactoryServiceDependencies,
) {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);
  /** Wake delivery sends outside `mutex`, so two deliveries could each send the same rows. */
  const deliveryMutex = yield* Semaphore.make(1);
  const preserveError = (cause: unknown) => (isFactoryError(cause) ? cause : storageError());
  const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(preserveError));
  const lock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    protect(mutex.withPermits(1)(sql.withTransaction(effect)));
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const changes = yield* PubSub.unbounded<void>();
  const publish = PubSub.publish(changes, undefined);
  // Drafts change rarely and apart from assignments, so their stream has its own signal.
  const draftChanges = yield* PubSub.unbounded<void>();
  const publishDrafts = PubSub.publish(draftChanges, undefined);

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

  /**
   * The factory config files with this environment's usable pool. The pool and recovery allowance
   * come from here; the database config keeps only the environment cap and git identity.
   */
  // Saving a pool writes factory.yaml, which would skip a migration that failed, so say why instead.
  const noPoolMessage = Effect.map(deps.configStore.migrationFailure, (failure) =>
    failure === null
      ? "Add a model this environment can run to the factory pool first."
      : unmigratedConfigMessage(failure),
  );

  // Drivers already warned about, by their set of instances, so reading the catalog on every call
  // does not repeat the warning.
  const warnedDrivers = new Set<string>();

  /**
   * Its catalog puts each driver's preferred instance first, from the environment's database
   * config, so every resolution through it honours the preference.
   */
  const factoryFiles = Effect.fnUntraced(function* () {
    const view = yield* deps.configStore.read;
    const preferences = (yield* environmentConfig()).config.instancePreferences;
    const usable = yield* deps.readModelCatalog;
    yield* Effect.forEach(ambiguousDrivers(usable, preferences), ({ driver, instanceIds }) => {
      const key = `${driver}:${instanceIds.join(",")}`;
      if (warnedDrivers.has(key)) return Effect.void;
      warnedDrivers.add(key);
      return Effect.logWarning(
        "A factory model name matches more than one provider instance; the first is used",
        { driver, chosen: instanceIds[0], instances: instanceIds },
      );
    });
    const catalog = withInstancePreferences(usable, preferences);
    return { view, catalog, pool: usableModelPool(view.settings, catalog) };
  });

  /** A config view as clients read it, with the preferences this environment cannot honour now. */
  const withStalePreferences = Effect.fnUntraced(function* (view: FactoryConfigView) {
    const stale = stalePreferences(
      view.environment.instancePreferences,
      yield* deps.readModelCatalog,
    );
    return stale.length === 0 ? view : { ...view, stalePreferences: stale };
  });

  /**
   * Places a delegation plan holds until the lead records the worker it launched, as expiry times
   * by assignment and place. Planning and launching are separate calls, so without a hold two
   * concurrent delegations could both see the last place free. They live in memory because the
   * server is one process and planning already runs under its lock; pending rows in
   * `factory_members` would leak into the feed, stats and sub-agent lookups. A hold lapses, so a
   * launch that failed never keeps the place for good.
   *
   * A place counts work running at once, not delegations: a member whose task finished frees its
   * place without ending its row, so its stats and feed stay. A follow-up to a finished member
   * goes through delegation too, with `continueThreadId`. A plain `t3_thread_send` to its thread
   * is never refused, so the lead skill forbids it; such a follow-up still counts against the
   * place while it runs.
   */
  const heldPlaces = new Map<string, ReadonlyArray<number>>();
  const PLACE_HOLD_MS = 5 * 60_000;
  type Place =
    | { readonly kind: "member"; readonly name: string }
    | { readonly kind: "role"; readonly role: string };
  const placeKey = (assignmentId: string, place: Place) =>
    `${assignmentId}\n${place.kind === "member" ? `member:${place.name}` : `role:${place.role}`}`;

  /**
   * Whether a live member's thread is working. A thread not readable yet was just created, and one
   * with no run yet is about to start, so both count as working.
   */
  const threadHoldsPlace = (runs: FactoryThreadRuns | null) =>
    runs === null ||
    (!runs.deleted &&
      (runs.runInProgress || runs.pendingRequests > 0 || runs.latestRunStatus === null));

  /**
   * Threads a follow-up plan was made for, as expiry times, until the lead re-records them. Until
   * its follow-up starts, the thread still reads as finished, so this keeps a second plan off it.
   */
  const pendingFollowUps = new Map<string, number>();

  /** Holds one of the place's seats for a plan, or fails when every seat is taken or held. */
  const reservePlace = (
    assignmentId: string,
    place: Place & {
      readonly count: number;
      readonly busy: string;
      readonly idle?: { readonly threadId: ThreadId; readonly busy: string };
    },
  ) =>
    lock(
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        // A failed send never re-records its thread, so its expired entry is dropped here.
        for (const [threadId, expiry] of pendingFollowUps)
          if (expiry <= nowMs) pendingFollowUps.delete(threadId);
        // Checked under the lock so two follow-ups to one finished thread cannot both pass.
        if (
          place.idle !== undefined &&
          ((pendingFollowUps.get(place.idle.threadId) ?? 0) > nowMs ||
            threadHoldsPlace(yield* deps.readThreadRuns(place.idle.threadId)))
        )
          return yield* error("conflict", place.idle.busy);
        const key = placeKey(assignmentId, place);
        const held = (heldPlaces.get(key) ?? []).filter((expiry) => expiry > nowMs);
        heldPlaces.set(key, held);
        // Sub-agents join observed under their parent's place but never take one.
        const live =
          place.kind === "member"
            ? yield* sql<{ thread_id: string }>`SELECT thread_id FROM factory_members
                WHERE assignment_id=${assignmentId} AND member_name=${place.name}
                AND joined != 'observed' AND ended_at IS NULL`
            : yield* sql<{ thread_id: string }>`SELECT thread_id FROM factory_members
                WHERE assignment_id=${assignmentId} AND role=${place.role}
                AND joined != 'observed' AND ended_at IS NULL`;
        let busy = held.length;
        // Safe under the lock: this reads the orchestrator's projections (a nested transaction, a
        // savepoint in this fiber) and never calls back into the factory. Tests stub it.
        for (const member of live)
          if (threadHoldsPlace(yield* deps.readThreadRuns(ThreadId.make(member.thread_id))))
            busy += 1;
        if (busy >= place.count) return yield* error("conflict", place.busy);
        heldPlaces.set(key, [...held, nowMs + PLACE_HOLD_MS]);
        if (place.idle !== undefined)
          pendingFollowUps.set(place.idle.threadId, nowMs + PLACE_HOLD_MS);
      }),
    );

  /** A recorded worker now takes the place itself, so the oldest hold on it is let go. */
  const releasePlace = (assignmentId: string, place: Place, threadId: string) => {
    const key = placeKey(assignmentId, place);
    heldPlaces.set(key, (heldPlaces.get(key) ?? []).slice(1));
    pendingFollowUps.delete(threadId);
  };

  /**
   * A manager's instructions: its own definition copy, or for a manager created before copies
   * existed, the first manager definition, into which the migration wrote the old role text.
   */
  const managerInstructions = Effect.fnUntraced(function* (manager: FactoryManager) {
    if (manager.definition) return manager.definition.instructions;
    return (yield* deps.configStore.read).managers[0]?.instructions;
  });

  const withoutCap = ({ concurrencyCap: _, ...rest }: FactoryConfigOverride) => rest;

  const configView = Effect.fnUntraced(function* (projectId: ProjectId | undefined) {
    const environment = yield* environmentConfig();
    if (projectId === undefined) {
      return {
        environment: environment.config,
        effective: environment.config,
        configured: environment.configured,
      } satisfies FactoryConfigView;
    }
    const stored = yield* projectOverride(projectId);
    // A cap stored before projects lost theirs still decodes, but echoing it back would make
    // a client that edits another key and saves the override get refused.
    const override = stored === null ? null : withoutCap(stored);
    return {
      environment: environment.config,
      override,
      effective: resolveFactoryConfig(environment.config, override),
      configured: environment.configured,
    } satisfies FactoryConfigView;
  });

  const getConfig: FactoryServiceShape["getConfig"] = (input) =>
    protect(configView(input.projectId).pipe(Effect.flatMap(withStalePreferences)));

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

  const saveEnvironmentConfig = Effect.fnUntraced(function* (config: FactoryConfig) {
    const problem = factoryConfigProblem(config);
    if (problem !== null) return yield* error("invalid", problem);
    yield* assertProjectsSound(config);
    yield* writeConfigRow(ENVIRONMENT_SCOPE, encodeConfig(config));
  });

  const updateConfig: FactoryServiceShape["updateConfig"] = (input) =>
    lock(
      Effect.gen(function* () {
        if (input.scope === "environment") {
          yield* saveEnvironmentConfig(input.config);
          return yield* configView(undefined);
        }
        yield* project(input.projectId);
        const scopeKey = projectScope(input.projectId);
        if (input.override === null) {
          yield* sql`DELETE FROM factory_config WHERE scope_key=${scopeKey}`;
          return yield* configView(input.projectId);
        }
        if (input.override.concurrencyCap !== undefined)
          return yield* error(
            "invalid",
            "A project has no concurrency cap of its own. Set the cap on the environment, or as the manager's own cap.",
          );
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
    ).pipe(
      // The managers feed carries the environment cap.
      Effect.tap(() => (input.scope === "environment" ? publish : Effect.void)),
      Effect.flatMap(withStalePreferences),
    );

  const decodeManager = Effect.fnUntraced(function* (row: ManagerRow) {
    return yield* decodeManagerValue({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      state: row.state,
      threadId: row.thread_id,
      ...Option.match(decodeOnboardedPayload(row.onboarded_json), {
        onNone: () => ({ onboardingThreadId: null, primingMessageId: null }),
        onSome: (payload) => ({
          onboardingThreadId: payload.onboardingThreadId,
          primingMessageId: payload.primingMessageId ?? null,
        }),
      }),
      onboardingProposal:
        row.onboarding_proposal_json === null
          ? null
          : yield* parse(Schema.Unknown, row.onboarding_proposal_json),
      onboardingResult:
        row.onboarding_result_json === null
          ? null
          : yield* parse(Schema.Unknown, row.onboarding_result_json),
      modelSelection:
        row.model_selection_json === null
          ? null
          : yield* parse(Schema.Unknown, row.model_selection_json),
      ...(row.definition_json
        ? { definition: yield* parse(Schema.Unknown, row.definition_json) }
        : {}),
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
          WHERE a.manager_id=m.id AND a.state='waiting-user') AS waiting_on_you,
        (SELECT l.payload_json FROM factory_log l
          WHERE l.manager_id=m.id AND l.kind='onboarded'
          ORDER BY l.sequence DESC LIMIT 1) AS onboarded_json
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
    return {
      managers: yield* currentManagers(),
      environmentConcurrencyCap: (yield* environmentConfig()).config.concurrencyCap,
    } satisfies FactoryManagersEvent;
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
      // The RPC server interrupts a request when its client disconnects. Once the row commits, its
      // thread must still launch and be remembered, or a retry inserts a second manager.
      Effect.gen(function* () {
        const created = yield* lock(
          Effect.gen(function* () {
            const replay = yield* replayManager(input.requestId, input);
            if (replay) return { replay } as const;
            const shell = yield* project(input.projectId);
            const config = (yield* configView(input.projectId)).effective;
            const files = yield* factoryFiles();
            if (files.pool.length === 0) return yield* error("invalid", yield* noPoolMessage);
            const definitions = files.view.managers;
            const definition =
              input.definitionId === undefined
                ? (definitions[0] ?? null)
                : definitions.find((candidate) => candidate.id === input.definitionId);
            if (definition === undefined)
              return yield* error(
                "not-found",
                `There is no manager definition "${input.definitionId}". Use one of: ${
                  definitions.map((candidate) => candidate.id).join(", ") || "none"
                }.`,
              );
            const pool = new Set(files.pool.map(modelKey));
            if (input.modelSelection && !pool.has(modelKey(input.modelSelection)))
              return yield* error(
                "invalid",
                `${input.modelSelection.model} (${input.modelSelection.instanceId}) is not in the model pool.`,
              );
            const resolved =
              definition === null
                ? null
                : resolveModelList(definition.models, files.view.settings, files.catalog);
            // An empty list resolves to the pool, so nothing resolving means the definition names
            // only models this environment cannot run: refused, as delegation refuses it.
            if (input.modelSelection === undefined && resolved !== null && definition !== null) {
              const choice = chooseModel(resolved, undefined);
              if (choice.kind !== "chosen")
                return yield* error(
                  "invalid",
                  modelChoiceRefusal(choice, definition.name, undefined, resolved),
                );
            }
            const modelSelection = input.modelSelection ?? resolved?.models[0] ?? files.pool[0]!;
            const runtimeMode = input.runtimeMode ?? "full-access";
            const threadId = yield* deps.allocateThreadId(input.projectId);
            const id = NodeCrypto.randomUUID();
            const at = yield* now;
            yield* sql`INSERT INTO factory_managers(id,project_id,name,state,thread_id,
                model_selection_json,definition_json,runtime_mode,created_at,updated_at)
                VALUES(${id},${input.projectId},${input.name},'onboarding',${threadId},
                ${encodeModel(modelSelection)},
                ${definition === null ? null : encodeManagerDefinition(definition)},
                ${runtimeMode},${at},${at})`;
            return {
              id,
              threadId,
              config: { ...config, modelPool: files.pool },
              modelSelection,
              runtimeMode,
              shell,
              definition,
            } as const;
          }),
        );
        if ("replay" in created) return created.replay;
        const skill = yield* deps.readRoleSkill("manager", created.shell.workspaceRoot);
        // Onboarding has no project section yet; the onboarding brief follows the manager's own.
        const onboardingSkill = protocolBrief(
          skill.text,
          created.definition?.instructions,
          skillFill(created.config, "manager", [], []),
        );
        const launched = yield* deps
          .launchThread({
            commandId: CommandId.make(`factory-manager:${input.requestId}`),
            threadId: created.threadId,
            projectId: input.projectId,
            title: `Engineering manager: ${input.name}`,
            text: `${onboardingSkill}\n\n${ONBOARDING_BRIEF}`,
            modelSelection: created.modelSelection,
            runtimeMode: created.runtimeMode,
            interactionMode: "default",
            workspace: { type: "root" },
          })
          .pipe(Effect.result);
        if (launched._tag === "Failure") {
          yield* lock(sql`DELETE FROM factory_managers WHERE id=${created.id}`);
          return yield* error("unavailable", launched.failure.message);
        }
        return yield* lock(rememberManager(input.requestId, input, created.id));
      }).pipe(Effect.uninterruptible),
    );

  const adoptManagerDefinitions: FactoryServiceShape["adoptManagerDefinitions"] = protect(
    Effect.gen(function* () {
      const definition = (yield* deps.configStore.read).managers[0];
      if (definition === undefined) return 0;
      const changed = yield* lock(
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`SELECT id FROM factory_managers
              WHERE state != 'retired' AND definition_json IS NULL`;
          if (rows.length === 0) return 0;
          yield* sql`UPDATE factory_managers
              SET definition_json=${encodeManagerDefinition(definition)},updated_at=${yield* now}
              WHERE ${sql.in(
                "id",
                rows.map((row) => row.id),
              )}`;
          return rows.length;
        }),
      );
      if (changed > 0) yield* publish;
      return changed;
    }),
  );

  const pauseManagerRow = Effect.fnUntraced(function* (input: FactoryManagersPauseInput) {
    const replay = yield* replayManager(input.requestId, input);
    if (replay) return { manager: replay, leads: [] };
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
    const leads =
      input.scope === "project"
        ? yield* sql<{ lead_thread_id: string }>`SELECT a.lead_thread_id
            FROM factory_assignments a WHERE a.manager_id=${manager.id}
            AND a.lead_thread_id IS NOT NULL AND ${sql.in("a.state", ACTIVE_ASSIGNMENT_STATES)}
            AND NOT EXISTS (SELECT 1 FROM factory_members m
              WHERE m.thread_id=a.lead_thread_id AND m.taken_over=1)`
        : [];
    return {
      manager: yield* rememberManager(input.requestId, input, manager.id),
      leads: leads.map((row) => row.lead_thread_id),
    };
  });

  /** Pausing the project also interrupts every lead's run, except threads the user took over. */
  const pauseManager: FactoryServiceShape["pauseManager"] = (input) =>
    protect(
      // A disconnect interrupts the request, and a replay interrupts no leads, so once the pause
      // commits every lead must still be interrupted.
      Effect.gen(function* () {
        const paused = yield* lock(pauseManagerRow(input));
        for (const lead of paused.leads)
          yield* deps
            .interruptThread({
              projectId: paused.manager.projectId,
              threadId: ThreadId.make(lead),
              commandId: CommandId.make(`factory-pause:${input.requestId}:${lead}`),
              reason: "The user paused the project's factory.",
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not interrupt a factory lead", {
                  threadId: lead,
                  cause: cause.message,
                }),
              ),
            );
        return paused.manager;
      }).pipe(Effect.uninterruptible),
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
          const from = rows[0]?.paused_from;
          const resumed = from === "onboarding" || from === "ready" ? from : "active";
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

  /** Approval moves the manager off its onboarding thread; the log remembers which one it was. */
  const finishedOnboardingThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const rows = yield* sql`SELECT 1 FROM factory_log WHERE kind='onboarded'
        AND json_extract(payload_json,'$.onboardingThreadId')=${threadId} LIMIT 1`;
    return rows.length > 0;
  });
  /** Only manager-only tools ask, and only once the thread turned out not to be a manager's. */
  const notAManager = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* error(
      "not-found",
      (yield* finishedOnboardingMessage(threadId)) ?? "This thread is not an engineering manager.",
    );
  });

  const managerForThread: FactoryServiceShape["managerForThread"] = (threadId) =>
    protect(
      Effect.gen(function* () {
        const row = yield* managerRowForThread(threadId);
        return row === null ? null : yield* decodeManager(row);
      }),
    );

  const finishedOnboardingMessage: FactoryServiceShape["finishedOnboardingMessage"] = (threadId) =>
    protect(
      finishedOnboardingThread(threadId).pipe(
        Effect.map((finished) => (finished ? ONBOARDING_FINISHED : null)),
      ),
    );

  /** Each connected board's Ready columns in board order, and the labels on its items. */
  const factoryTeamIds = deps.configStore.read.pipe(
    Effect.map((view) => new Set(view.teams.map((team) => team.id))),
  );
  /** The pickup of the project's other approved managers that are not retired. */
  const otherPickups = Effect.fnUntraced(function* (manager: FactoryManager) {
    return (yield* currentManagers()).flatMap((other) =>
      other.projectId === manager.projectId &&
      other.id !== manager.id &&
      other.onboardingResult !== null
        ? [{ name: other.name, pickup: other.onboardingResult.pickup }]
        : [],
    );
  });

  const onboardingBoards = Effect.fnUntraced(function* (projectId: ProjectId) {
    const boards: FactoryOnboardingBoard[] = [];
    for (const summary of yield* deps.readBoards(projectId)) {
      if (summary.mapping === null) continue;
      const view = yield* deps.readBoard(projectId, summary.id);
      const ready = new Set(issueReadyColumnIds(view.board.mapping ?? summary.mapping));
      boards.push({
        boardId: summary.id,
        title: view.board.title,
        readyColumns: view.columns
          .filter((column) => ready.has(column.id))
          .map((column) => ({ id: column.id, title: column.title })),
        labels: [...new Set(view.items.flatMap((item) => item.issue.labels))].toSorted(),
      });
    }
    return boards;
  });

  const proposeOnboarding: FactoryServiceShape["proposeOnboarding"] = (threadId, input) =>
    protect(
      Effect.gen(function* () {
        const problem = proposalProblem(input);
        if (problem !== null) return yield* error("invalid", problem);
        const found = yield* managerRowForThread(threadId);
        if (found === null) return yield* notAManager(threadId);
        if (!isOnboarding(found))
          return yield* error("conflict", "This manager has already finished onboarding.");
        const projectId = ProjectId.make(found.project_id);
        const shell = yield* project(projectId);
        // Read outside the lock: boards come from the issue service and git from a subprocess.
        const boards = yield* onboardingBoards(projectId);
        const defaultBranch = yield* deps.readDefaultBranch(shell.workspaceRoot);
        return yield* lock(
          Effect.gen(function* () {
            const row = yield* managerRowForThread(threadId);
            if (row === null || row.id !== found.id)
              return yield* error("not-found", "This thread is not an engineering manager.");
            if (!isOnboarding(row))
              return yield* error("conflict", "This manager has already finished onboarding.");
            const at = yield* now;
            const proposal = {
              ...input,
              detected: { boards, defaultBranch, detectedAt: at },
              proposedAt: at,
            };
            yield* sql`UPDATE factory_managers SET onboarding_proposal_json=${encodeProposal(proposal)},
                updated_at=${at} WHERE id=${row.id}`;
            yield* publish;
            return yield* readManager(row.id);
          }),
        );
      }),
    );

  /**
   * Moves the manager to a fresh thread primed from the approved result. The approval is written
   * under the lock, the thread launches outside it like a new manager's, and only a launched
   * approval is remembered and published. A failed launch puts the manager back in onboarding on
   * its old thread, keeping a pause or retirement made meanwhile, so approving again starts over.
   */
  const approveOnce = Effect.fnUntraced(function* (
    input: FactoryManagersApproveOnboardingInput,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) {
    const { pickup } = input.result;
    // Pickup columns are checked against the boards as they are now, not as proposed: a
    // column that stopped being Ready since must not be approved.
    const boards =
      pickup.enabled || pickup.columns.length > 0
        ? yield* restore(onboardingBoards((yield* readManager(input.managerId)).projectId))
        : [];
    const teamIds = yield* restore(factoryTeamIds);
    const approved = yield* lock(
      Effect.gen(function* () {
        const replay = yield* replayManager(input.requestId, input);
        if (replay) return { replay } as const;
        const manager = yield* readManager(input.managerId);
        if (manager.state === "manager-paused" || manager.state === "project-paused")
          return yield* error("conflict", "Resume the manager first.");
        if (manager.state !== "onboarding")
          return yield* error("conflict", `${manager.name} is not onboarding.`);
        const proposal = manager.onboardingProposal;
        if (proposal === null)
          return yield* error("conflict", `${manager.name} has not proposed onboarding yet.`);
        const problem = onboardingResultProblem(input.result, {
          questions: proposal.rules,
          boards,
          teamIds,
          others: yield* otherPickups(manager),
        });
        if (problem !== null) return yield* error("invalid", problem);
        // The question is the manager's wording from the proposal, not whatever the client sent.
        const asked = new Map(proposal.rules.map((question) => [question.id, question.question]));
        const result = {
          ...input.result,
          pickup: titledPickup(input.result.pickup, boards),
          rules: input.result.rules.map((rule) => ({
            ...rule,
            question: asked.get(rule.id) ?? rule.question,
          })),
        };
        const runtime = yield* sql<{ runtime_mode: string | null }>`
            SELECT runtime_mode FROM factory_managers WHERE id=${manager.id}`;
        const threadId = yield* deps.allocateThreadId(manager.projectId);
        const primingMessageId = MessageId.make(`message:factory-manager-primed:${threadId}`);
        yield* sql`UPDATE factory_managers SET state=${pickup.enabled ? "ready" : "active"},
            thread_id=${threadId},onboarding_result_json=${encodeResult(result)},
            onboarding_proposal_json=NULL,updated_at=${yield* now} WHERE id=${manager.id}`;
        yield* writeLog(manager.id, null, "onboarded", "onboarding approved", {
          onboardingThreadId: manager.threadId,
          threadId,
          primingMessageId,
        });
        return {
          manager: yield* readManager(manager.id),
          onboardingThreadId: manager.threadId,
          proposal,
          primingMessageId,
          runtimeMode: decodeRuntimeMode(runtime[0]?.runtime_mode ?? null),
        } as const;
      }),
    );
    if ("replay" in approved) return approved.replay;
    const { manager, onboardingThreadId, proposal } = approved;
    const newThreadId = manager.threadId!;
    const launched = yield* Effect.gen(function* () {
      const shell = yield* project(manager.projectId);
      const { pool } = yield* factoryFiles();
      const config = { ...(yield* configView(manager.projectId)).effective, modelPool: pool };
      const skill = yield* deps.readRoleSkill("manager", shell.workspaceRoot);
      const modelSelection = manager.modelSelection ?? pool[0];
      if (modelSelection === undefined) return yield* error("invalid", yield* noPoolMessage);
      yield* deps.launchThread({
        // A rejected command id stays rejected, so each new thread gets its own.
        commandId: CommandId.make(`factory-manager-primed:${newThreadId}`),
        threadId: newThreadId,
        projectId: manager.projectId,
        title: `Engineering manager: ${manager.name}`,
        text: `${managerBrief({
          protocol: skill.text,
          instructions: yield* managerInstructions(manager),
          fill: skillFill(config, "manager", protectedPathsOf(manager), []),
          result: manager.onboardingResult,
        })}\n\n${PRIMED_CLOSING}`,
        messageId: approved.primingMessageId,
        modelSelection,
        runtimeMode: approved.runtimeMode,
        interactionMode: "default",
        workspace: { type: "root" },
      });
    }).pipe(Effect.result);
    if (launched._tag === "Failure") {
      const state = yield* lock(
        Effect.gen(function* () {
          // A pause made during the launch stays, now pausing onboarding; a retirement stays too.
          yield* sql`UPDATE factory_managers SET
              state=CASE WHEN state IN ('ready','active') THEN 'onboarding' ELSE state END,
              paused_from=CASE WHEN state IN ('manager-paused','project-paused')
                THEN 'onboarding' ELSE NULL END,
              thread_id=${onboardingThreadId},onboarding_result_json=NULL,
              onboarding_proposal_json=${encodeProposal(proposal)},updated_at=${yield* now}
              WHERE id=${manager.id} AND thread_id=${newThreadId}`;
          yield* sql`DELETE FROM factory_log WHERE manager_id=${manager.id}
              AND kind='onboarded' AND json_extract(payload_json,'$.threadId')=${newThreadId}`;
          return (yield* readManager(manager.id)).state;
        }),
      );
      yield* publish;
      yield* Effect.logWarning("Could not launch the manager's primed thread", {
        managerId: manager.id,
        cause: launched.failure.message,
      });
      return yield* error(
        "unavailable",
        state === "retired"
          ? `${launched.failure.message} ${manager.name} was retired meanwhile, so it stays retired.`
          : `${launched.failure.message} Onboarding is unchanged; approve it again.`,
      );
    }
    const remembered = yield* lock(rememberManager(input.requestId, input, manager.id));
    if (onboardingThreadId !== null)
      yield* deps
        .settleThread({
          threadId: onboardingThreadId,
          commandId: CommandId.make(`factory-onboarding-settle:${onboardingThreadId}`),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not settle the manager's onboarding thread", {
              threadId: onboardingThreadId,
              cause: cause.message,
            }),
          ),
        );
    return remembered;
  });

  // An approval is remembered only once its thread launched, so a repeat of a request still
  // launching waits for it here instead of being refused as no longer onboarding.
  const approvalsInFlight = new Map<
    string,
    {
      readonly hash: string;
      readonly done: Deferred.Deferred<FactoryManager, FactoryOperationError>;
    }
  >();
  const approveOnboarding: FactoryServiceShape["approveOnboarding"] = (input) =>
    protect(
      Effect.gen(function* () {
        const inFlight = approvalsInFlight.get(input.requestId);
        if (inFlight !== undefined) {
          if (inFlight.hash !== hash(input))
            return yield* error(
              "conflict",
              "This request ID was already used for a different factory operation.",
            );
          return yield* Deferred.await(inFlight.done);
        }
        const done = Deferred.makeUnsafe<FactoryManager, FactoryOperationError>();
        approvalsInFlight.set(input.requestId, { hash: hash(input), done });
        // A disconnect interrupts the request. Once the approval commits the manager is on its new
        // thread, so that thread must still launch, or be rolled back, before a retry can tell.
        return yield* protect(
          Effect.uninterruptibleMask((restore) => approveOnce(input, restore)),
        ).pipe(
          Effect.onExit((exit) => Deferred.done(done, exit)),
          Effect.ensuring(Effect.sync(() => approvalsInFlight.delete(input.requestId))),
        );
      }),
    );

  /** Pickup of a `ready` manager starts only when the user asks, and offers its first tickets. */
  const startPickup: FactoryServiceShape["startPickup"] = (input) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* lock(
          Effect.gen(function* () {
            const replay = yield* replayManager(input.requestId, input);
            if (replay) return replay;
            const current = yield* readManager(input.managerId);
            const problem = startPickupProblem(current);
            if (problem !== null) return yield* error("conflict", problem);
            yield* sql`UPDATE factory_managers SET state='active',updated_at=${yield* now}
                WHERE id=${current.id}`;
            return yield* rememberManager(input.requestId, input, current.id);
          }),
        );
        if (manager.state === "active")
          yield* queuePickupWake(manager).pipe(
            Effect.andThen(deliverWakes(manager)),
            Effect.catch((cause) =>
              Effect.logWarning("Could not offer a manager its first pickup tickets", {
                managerId: manager.id,
                cause: cause.message,
              }),
            ),
          );
        return manager;
      }),
    );

  const updateSettings: FactoryServiceShape["updateSettings"] = (input) =>
    protect(
      Effect.gen(function* () {
        const { pickup } = input.result;
        const boards =
          pickup.enabled || pickup.columns.length > 0
            ? yield* onboardingBoards((yield* readManager(input.managerId)).projectId)
            : [];
        const teamIds = yield* factoryTeamIds;
        // The RPC server interrupts a request when its client disconnects. Once the save commits, the
        // wake must still be written and sent, so closing the window doesn't drop it.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const saved = yield* lock(
              Effect.gen(function* () {
                const replay = yield* replayManager(input.requestId, input);
                if (replay) return { replay } as const;
                const manager = yield* readManager(input.managerId);
                const stateProblem = settingsStateProblem(manager);
                if (stateProblem !== null) return yield* error("conflict", stateProblem);
                if (manager.updatedAt !== input.expectedUpdatedAt)
                  return yield* error(
                    "conflict",
                    "These settings changed since you opened them; cancel and edit again.",
                  );
                const stored = manager.onboardingResult!;
                // Overlap is checked only when this save changes pickup, so two managers that already
                // overlap can still change everything else.
                const pickupChanged =
                  pickupScope(stored.pickup) !== pickupScope(input.result.pickup);
                // The manager's questions stay its own; only the answers are the user's to change.
                const problem = onboardingResultProblem(input.result, {
                  questions: stored.rules,
                  boards,
                  teamIds,
                  others: pickupChanged ? yield* otherPickups(manager) : [],
                });
                if (problem !== null) return yield* error("invalid", problem);
                const asked = new Map(stored.rules.map((rule) => [rule.id, rule.question]));
                const result = {
                  ...input.result,
                  pickup: titledPickup(input.result.pickup, boards),
                  baseBranch: stored.baseBranch,
                  rules: input.result.rules.map((rule) => ({
                    ...rule,
                    question: asked.get(rule.id) ?? rule.question,
                  })),
                };
                const changes = settingsChanges(stored, result, boards);
                // Pickup turned on waits for the user's start, as after approval; turned off before
                // it started, there is nothing left to start. A paused manager stays paused and
                // resumes to what the new settings say.
                const settled = (from: string) =>
                  from === "active" && result.pickup.enabled && !stored.pickup.enabled
                    ? "ready"
                    : from === "ready" && !result.pickup.enabled
                      ? "active"
                      : from;
                if (isPaused(manager.state))
                  yield* sql`UPDATE factory_managers SET paused_from=CASE paused_from
                      WHEN 'active' THEN ${settled("active")} WHEN 'ready' THEN ${settled("ready")}
                      ELSE paused_from END WHERE id=${manager.id}`;
                const state = isPaused(manager.state) ? manager.state : settled(manager.state);
                yield* sql`UPDATE factory_managers SET state=${state},
                onboarding_result_json=${encodeResult(result)},
                updated_at=${yield* now} WHERE id=${manager.id}`;
                return {
                  manager: yield* rememberManager(input.requestId, input, manager.id),
                  changes,
                } as const;
              }),
            );
            if ("replay" in saved) return saved.replay;
            const { manager, changes } = saved;
            yield* publish;
            if (changes.length > 0)
              yield* lock(writeLog(manager.id, null, "wake", "settings", { changes })).pipe(
                // A paused manager's wakes wait in the log; the sweep delivers them once it resumes.
                Effect.andThen(isPaused(manager.state) ? Effect.void : deliverWakes(manager)),
                Effect.catch((cause) =>
                  Effect.logWarning("Could not tell a manager its settings changed", {
                    managerId: manager.id,
                    cause: cause.message,
                  }),
                ),
              );
            return manager;
          }),
        );
      }),
    );

  const roleBrief: FactoryServiceShape["roleBrief"] = (projectId, role, managerId, assignmentId) =>
    protect(
      Effect.gen(function* () {
        const shell = yield* project(projectId);
        const manager = yield* readManager(managerId);
        if (manager.projectId !== projectId)
          return yield* error("invalid", "This manager belongs to a different project.");
        const config = {
          ...(yield* configView(projectId)).effective,
          modelPool: (yield* factoryFiles()).pool,
        };
        const fill = skillFill(
          config,
          role,
          protectedPathsOf(manager),
          // The manager has no single assignment.
          role === "manager" || assignmentId === undefined
            ? []
            : yield* allowedPathsOf(yield* leadAssignmentRow(assignmentId)),
        );
        const sourceOf = (instructions: string | undefined) =>
          (instructions ?? "").trim() === "" ? ("default" as const) : ("definition" as const);
        if (role === "manager" || role === "lead") {
          const skill = yield* deps.readRoleSkill(role, shell.workspaceRoot);
          // A lead's own copy lives in its team; outside an assignment, the first lead is the one
          // new teams copy.
          const instructions =
            role === "manager"
              ? yield* managerInstructions(manager)
              : (yield* deps.configStore.read).leads[0]?.instructions;
          const text = managerBrief({
            protocol: skill.text,
            instructions,
            fill,
            result: manager.onboardingResult,
          });
          return { role, text, source: sourceOf(instructions) } satisfies FactoryRoleBrief;
        }
        // A worker's brief is its definition's description, so the starter worker of this id.
        const worker = (yield* deps.configStore.read).workers.find(
          (candidate) => candidate.id === role,
        );
        if (worker !== undefined) {
          const text = withProjectSection(
            renderRoleSkill(worker.description, fill),
            manager.onboardingResult,
          );
          return {
            role,
            text: `${text}\n\n${workerRules(worker.description, fill)}`,
            source: "definition",
          } satisfies FactoryRoleBrief;
        }
        if (role === "worker")
          return yield* error(
            "not-found",
            "Workers are defined in the factory config. Read them with factory_definitions.",
          );
        const skill = yield* deps.readRoleSkill(role, shell.workspaceRoot);
        return {
          role,
          text: `${withProjectSection(renderRoleSkill(skill.text, fill), manager.onboardingResult)}\n\n${WORKER_RULES}`,
          source: skill.source,
        } satisfies FactoryRoleBrief;
      }),
    );

  const dependencyValue = (row: DependencyRow) => ({
    id: row.id,
    blockedAssignmentId: row.blocked_assignment_id,
    deliveringAssignmentId: row.delivering_assignment_id,
    title: row.title,
    unblockCondition: row.unblock_condition,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const readDependency = Effect.fnUntraced(function* (id: string) {
    const rows = yield* sql<DependencyRow>`SELECT * FROM factory_dependencies WHERE id=${id}`;
    if (!rows[0]) return yield* error("not-found", "This dependency no longer exists.");
    return yield* decodeDependencyValue(dependencyValue(rows[0])).pipe(
      Effect.mapError(storageError),
    );
  });

  const decodeAssignment = Effect.fnUntraced(function* (row: AssignmentRow) {
    const leadMember =
      row.lead_thread_id === null
        ? []
        : yield* sql<{ taken_over: number }>`SELECT taken_over FROM factory_members
            WHERE thread_id=${row.lead_thread_id}`;
    const dependencies = yield* sql<DependencyRow>`SELECT * FROM factory_dependencies
        WHERE blocked_assignment_id=${row.id} ORDER BY created_at, id`;
    const asks = yield* parse(ProtectedPathAsks, row.protected_path_asks_json);
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
      team: outgoingTeam(yield* parse(FactoryTeamSpec, row.team_json)),
      recoveryUsed: row.recovery_used,
      waitingReason: row.waiting_reason,
      cancelReason: row.cancel_reason,
      claim: row.claim_json === null ? null : yield* parse(Schema.Unknown, row.claim_json),
      takenOver: leadMember[0]?.taken_over === 1,
      dependencies: dependencies.map(dependencyValue),
      teamVerdict:
        row.team_verdict_json === null ? null : yield* parse(Schema.Unknown, row.team_verdict_json),
      checklist: yield* parse(Schema.Unknown, row.checklist_json),
      controlViolations: effectiveViolations(
        yield* parse(ControlViolations, row.control_violations_json),
        asks,
      ),
      protectedPathAsks: asks,
      retro: { teamDoneAt: row.team_retro_at, managerDoneAt: row.manager_retro_at },
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
  const writeWake = (row: AssignmentRow, reason: string, payload: unknown) =>
    writeLog(row.manager_id, row.id, "wake", reason, payload);
  /**
   * The `state=` of every assignment update, so time waiting on the user accrues: entering
   * waiting-user stamps waiting_since and leaving it adds the elapsed time. SQLite evaluates each
   * SET expression against the row as it was, so the CASEs see the previous wait.
   */
  const enterState = (state: FactoryAssignmentState, at: string) =>
    sql`state=${state},
      waiting_since=CASE WHEN ${state}='waiting-user' THEN COALESCE(waiting_since,${at}) ELSE NULL END,
      waiting_user_ms=waiting_user_ms + CASE WHEN ${state}!='waiting-user' AND waiting_since IS NOT NULL
        THEN MAX(0, CAST(ROUND((julianday(${at}) - julianday(waiting_since)) * 86400000) AS INTEGER))
        ELSE 0 END`;

  const LEAD_TAKEN_OVER = sql.literal(`COALESCE((SELECT taken_over FROM factory_members
      WHERE thread_id=a.lead_thread_id),0) AS lead_taken_over`);
  const leadAssignmentRow = Effect.fnUntraced(function* (id: string) {
    const rows = yield* sql<LeadAssignmentRow>`SELECT a.*, ${LEAD_TAKEN_OVER}
        FROM factory_assignments a WHERE a.id=${id}`;
    if (!rows[0]) return yield* error("not-found", "This assignment no longer exists.");
    return rows[0];
  });
  /** The live assignment this thread leads. Every lead tool refuses once the user takes over. */
  const requireLead = Effect.fnUntraced(function* (threadId: ThreadId) {
    const rows = yield* sql<LeadAssignmentRow>`SELECT a.*, ${LEAD_TAKEN_OVER}
        FROM factory_assignments a WHERE a.lead_thread_id=${threadId}
        AND ${sql.in("a.state", ACTIVE_ASSIGNMENT_STATES)}
        ORDER BY a.created_at DESC, a.id LIMIT 1`;
    const row = rows[0];
    if (!row) return yield* error("not-found", "This thread is not a factory lead.");
    if (row.lead_taken_over === 1)
      return yield* error("conflict", "The user has taken over this thread.");
    return row;
  });
  const ownAssignment = Effect.fnUntraced(function* (manager: FactoryManager, id: string) {
    const row = yield* leadAssignmentRow(id);
    if (row.manager_id !== manager.id)
      return yield* error("not-found", `${manager.name} has no assignment ${id}.`);
    return row;
  });

  /** Best effort: the state change it follows is already committed. */
  const notifyLead = Effect.fnUntraced(function* (
    projectId: string,
    threadId: string,
    text: string,
  ) {
    yield* deps
      .sendToThread({
        projectId: ProjectId.make(projectId),
        threadId: ThreadId.make(threadId),
        commandId: CommandId.make(`factory-lead:${threadId}:${NodeCrypto.randomUUID()}`),
        text,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not message a factory lead", {
            threadId,
            cause: cause.message,
          }),
        ),
      );
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

  /** Items in the columns `pick` chooses from each connected board's Ready columns. */
  const itemsIn = Effect.fnUntraced(function* (
    projectId: ProjectId,
    pick: (boardId: string, ready: ReadonlyArray<string>) => ReadonlyArray<string>,
  ) {
    const items: ReadyItem[] = [];
    for (const summary of yield* deps.readBoards(projectId)) {
      if (summary.mapping === null) continue;
      const view = yield* deps.readBoard(projectId, summary.id);
      const columns = new Set(
        pick(summary.id, issueReadyColumnIds(view.board.mapping ?? summary.mapping)),
      );
      for (const item of view.items) {
        if (item.columnId === null || !columns.has(item.columnId)) continue;
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
  /** Every Ready ticket: what the user may ask the manager to start by hand. */
  const readyItems = (projectId: ProjectId) => itemsIn(projectId, (_boardId, ready) => ready);
  /**
   * What the manager may take on its own: only the pickup columns the user confirmed, and only
   * while each is still Ready, so a board mapping that counts Backlog as Ready offers nothing new.
   */
  const pickupItems = (manager: FactoryManager) => {
    const pickup = manager.onboardingResult?.pickup;
    // A ready manager waits for the user to start pickup before anything is offered.
    if (pickup === undefined || !pickup.enabled || manager.state === "ready")
      return Effect.succeed([]);
    return itemsIn(manager.projectId, (boardId, ready) =>
      ready.filter((columnId) =>
        pickup.columns.some((column) => column.boardId === boardId && column.columnId === columnId),
      ),
    );
  };
  /** Pickup tickets with no live assignment, flagged when the manager already judged them. */
  const readyTickets = Effect.fnUntraced(function* (manager: FactoryManager) {
    const items = yield* pickupItems(manager);
    const live = yield* liveIssueKeys(manager.projectId);
    const judged = yield* judgedKeys(manager.id);
    return items
      .filter((item) => !live.has(canonicalIssueKey(item.issue.ref)))
      .map((item): FactoryReadyTicket => ({
        ...item,
        judged: judged.has(ticketKey(item.issue.ref, item.issue.updatedAt)),
      }));
  });

  /**
   * A new assignment needs room under both caps: the environment's, counted over every manager's
   * assignments, and the manager's own from its onboarding result. Without a result only the
   * environment's applies.
   */
  const capacity = Effect.fnUntraced(function* (manager: FactoryManager) {
    const environmentCap = (yield* environmentConfig()).config.concurrencyCap;
    const taken = yield* sql<{ manager_id: string }>`SELECT manager_id FROM factory_assignments
        WHERE ${sql.in("state", [...CAPACITY_STATES])}`;
    const managerCap = manager.onboardingResult?.concurrencyCap ?? environmentCap;
    const managerTaken = taken.filter((row) => row.manager_id === manager.id).length;
    return {
      environmentCap,
      environmentTaken: taken.length,
      managerCap,
      managerTaken,
      free: taken.length < environmentCap && managerTaken < managerCap,
    };
  });

  const status: FactoryServiceShape["status"] = (managerId) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* readManager(managerId);
        const assignments = yield* Effect.forEach(
          yield* liveAssignmentRows(manager.id),
          decodeAssignment,
        );
        const room = yield* capacity(manager);
        return {
          manager,
          concurrencyCap: Math.min(room.managerCap, room.environmentCap),
          activeCount: room.managerTaken,
          capacityFree: room.free,
          assignments,
          readyTickets: yield* readyTickets(manager),
          pickupEnabled: manager.onboardingResult?.pickup.enabled ?? false,
          pickupGuidance: manager.onboardingResult?.pickup.guidance ?? "",
        } satisfies FactoryStatus;
      }),
    );

  const requireManager = Effect.fnUntraced(function* (threadId: ThreadId) {
    const row = yield* managerRowForThread(threadId);
    if (row === null) return yield* notAManager(threadId);
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

  const leadPrompt = Effect.fnUntraced(function* (
    manager: FactoryManager,
    config: FactoryConfig,
    workspaceRoot: string,
    plan: Pick<AssignmentPlan, "title" | "brief" | "completionCondition" | "team">,
    allowedProtectedPaths: ReadonlyArray<string>,
  ) {
    const skill = yield* deps.readRoleSkill("lead", workspaceRoot);
    const definition = plan.team.definition;
    const fill = skillFill(
      { ...config, modelPool: (yield* factoryFiles()).pool },
      "lead",
      protectedPathsOf(manager),
      allowedProtectedPaths,
    );
    return leadBrief({
      protocol: skill.text,
      // A team commissioned before snapshots has no lead copy; the migration wrote the lead's text
      // into the first lead definition.
      instructions:
        definition?.lead.instructions ?? (yield* deps.configStore.read).leads[0]?.instructions,
      fill: {
        ...fill,
        // A team from definitions lists each member's models in its Team section; this is
        // their union, and a member with no list may use the whole pool.
        ...(definition === undefined
          ? {}
          : { allowedModels: definitionTeamModels(definition, fill) }),
        completionCondition: plan.completionCondition,
      },
      result: manager.onboardingResult,
      assignment: plan,
      team: teamSection(config, plan.team),
    });
  });

  /** A ticket's lead starts through an issue attempt, which owns its worktree and board moves. */
  const launchLead = Effect.fnUntraced(function* (
    manager: FactoryManager,
    config: FactoryConfig,
    plan: AssignmentPlan,
    id: string,
    branch: string,
    modelSelection: ModelSelection,
  ) {
    const shell = yield* project(manager.projectId);
    const prompt = yield* leadPrompt(manager, config, shell.workspaceRoot, plan, []);
    const baseRef = (yield* deps.readDefaultBranch(shell.workspaceRoot)) ?? "main";
    if (plan.ticket !== null) {
      const launched = yield* deps.startAttempt({
        requestId: `factory-assignment:${id}`,
        boardId: plan.ticket.boardId,
        issue: plan.ticket.issue.ref,
        projectId: manager.projectId,
        prompt,
        branch,
        baseRef,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      return { threadId: launched.threadId, attemptId: launched.attempt.id };
    }
    const threadId = yield* deps.allocateThreadId(manager.projectId);
    yield* deps.launchThread({
      commandId: CommandId.make(`factory-assignment:${id}`),
      threadId,
      projectId: manager.projectId,
      title: `Factory: ${plan.title}`,
      text: prompt,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspace: { type: "worktree", baseRef, branch },
    });
    return { threadId, attemptId: null };
  });

  /**
   * Reserves the slot and the ticket, launches the lead outside the lock, then records the lead.
   * A failed launch removes the reservation and logs the refusal.
   */
  const startAssignment = Effect.fnUntraced(function* (
    manager: FactoryManager,
    config: FactoryConfig,
    requested: AssignmentPlan,
  ) {
    const refusal = (reason: "conflict" | "invalid", message: string) =>
      refuse(manager.id, reason, message, requested.refusalPayload);
    const files = yield* factoryFiles();
    const picked = pickFactoryTeam(files.view.teams, manager.onboardingResult?.teamIds ?? [], {
      teamId: requested.teamId,
      team: requested.team,
    });
    if (picked.kind === "refused") return yield* refusal("invalid", picked.message);
    if (requested.protectedPaths !== undefined && picked.team.mayEditProtectedPaths)
      return yield* refusal(
        "invalid",
        `${picked.team.name} may already edit protected paths, so it needs no ask; leave protectedPaths out.`,
      );
    const lead = leadModelFor(picked.team, files, requested.leadModel);
    if ("refusal" in lead) return yield* refusal("invalid", lead.refusal);
    const modelSelection = lead.model;
    // The snapshot keeps the team as it was, so editing the team never changes running work.
    const plan: AssignmentPlan = {
      ...requested,
      team: { preset: picked.team.id, members: [], definition: picked.team },
    };
    const issue = plan.ticket?.issue.ref ?? null;
    const id = NodeCrypto.randomUUID();
    // Two commissions with the same title must not collide on one branch.
    const branch = sanitizeFeatureBranchName(
      issue === null
        ? `factory/${plan.title.replaceAll("/", "-")}-${id.slice(0, 8)}`
        : `factory/issue-${issue.number}`,
    );
    const source =
      plan.dependencyId !== null ? "dependency" : plan.ticket === null ? "user" : "ticket";
    const reserved = yield* lock(
      Effect.gen(function* () {
        const current = yield* readManager(manager.id);
        const problem = managerStateProblem(current);
        if (problem !== null) return ["conflict", problem] as const;
        // The blocked assignment already holds a slot while it waits on this delivery, so
        // counting the delivery too could leave both waiting on each other.
        if (plan.dependencyId === null) {
          const room = yield* capacity(current);
          if (room.environmentTaken >= room.environmentCap)
            return [
              "conflict",
              `All ${room.environmentCap} assignment slots on this environment are in use across its projects. Wait for one to finish.`,
            ] as const;
          if (room.managerTaken >= room.managerCap)
            return [
              "conflict",
              `All ${room.managerCap} assignment slots are in use. Wait for one to finish.`,
            ] as const;
        }
        if (
          issue !== null &&
          (yield* liveIssueKeys(manager.projectId)).has(canonicalIssueKey(issue))
        )
          return ["conflict", `#${issue.number} already has a live assignment.`] as const;
        if (plan.dependencyId !== null) {
          const rows = yield* sql<DependencyRow & { manager_id: string }>`
              SELECT d.*, a.manager_id FROM factory_dependencies d
              JOIN factory_assignments a ON a.id=d.blocked_assignment_id
              WHERE d.id=${plan.dependencyId}`;
          const dependency = rows[0];
          if (!dependency || dependency.manager_id !== manager.id)
            return [
              "invalid",
              `No open dependency ${plan.dependencyId} blocks your teams.`,
            ] as const;
          if (dependency.state !== "open" || dependency.delivering_assignment_id !== null)
            return [
              "conflict",
              `${dependency.title} is already delivered or being delivered by another assignment.`,
            ] as const;
          yield* sql`UPDATE factory_dependencies SET delivering_assignment_id=${id},
              updated_at=${yield* now} WHERE id=${plan.dependencyId}`;
        }
        const at = yield* now;
        const asks: ReadonlyArray<FactoryProtectedPathAsk> =
          plan.protectedPaths === undefined
            ? []
            : [
                {
                  id: NodeCrypto.randomUUID(),
                  paths: plan.protectedPaths.paths,
                  reason: plan.protectedPaths.reason,
                  source: "commission",
                  pullRequest: null,
                  state: "open",
                  createdAt: at,
                  answeredAt: null,
                },
              ];
        yield* writeLog(manager.id, id, plan.kind, plan.reason, plan.logPayload);
        yield* sql`INSERT INTO factory_assignments(id,manager_id,project_id,title,brief,
            completion_condition,source,issue_json,board_id,branch,complexity,state,team_json,
            protected_path_asks_json,created_at,updated_at)
            VALUES(${id},${manager.id},${manager.projectId},${plan.title},${plan.brief},
            ${plan.completionCondition},${source},
            ${issue === null ? null : json(issue)},${plan.ticket?.boardId ?? null},${branch},
            ${plan.complexity},'active',${json(plan.team)},${json(asks)},${at},${at})`;
        return null;
      }),
    );
    if (reserved !== null) return yield* refusal(reserved[0], reserved[1]);

    const launched = yield* launchLead(manager, config, plan, id, branch, modelSelection).pipe(
      Effect.result,
    );
    if (launched._tag === "Failure") {
      yield* lock(
        Effect.gen(function* () {
          yield* sql`DELETE FROM factory_log WHERE assignment_id=${id}`;
          yield* sql`DELETE FROM factory_assignments WHERE id=${id}`;
          yield* sql`UPDATE factory_dependencies SET delivering_assignment_id=NULL
              WHERE delivering_assignment_id=${id}`;
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
    const { attemptId, threadId } = launched.success;
    yield* lock(
      Effect.gen(function* () {
        const at = yield* now;
        yield* sql`UPDATE factory_assignments SET attempt_id=${attemptId},lead_thread_id=${threadId},
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
        if (manager.state === "ready")
          return yield* refusal("conflict", "Pickup has not started; the user starts it.");
        if (manager.onboardingResult?.pickup.enabled !== true)
          return yield* refusal(
            "conflict",
            "Pickup is off for this project. Recommend the ticket to the user instead.",
          );
        const found = findTicket(
          yield* pickupItems(manager),
          input.issueNumber,
          `#${input.issueNumber} is not in one of your pickup columns.`,
        );
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
          teamId: input.teamId,
          leadModel: input.leadModel,
          ticket,
          dependencyId: null,
        });
      }),
    );

  const commission: FactoryServiceShape["commission"] = (managerThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* requireManager(managerThreadId);
        const refusalPayload = {
          title: input.title,
          issueNumber: input.issueNumber ?? null,
          dependencyId: input.dependencyId ?? null,
        };
        const refusal = (reason: "conflict" | "invalid", message: string) =>
          refuse(manager.id, reason, message, refusalPayload);
        const problem = managerStateProblem(manager);
        if (problem !== null) return yield* refusal("conflict", problem);
        let ticket: ReadyItem | null = null;
        if (input.issueNumber !== undefined) {
          const found = findTicket(
            yield* readyItems(manager.projectId),
            input.issueNumber,
            `#${input.issueNumber} is not in a Ready column on a connected board.`,
          );
          if (!found.found) return yield* refusal(found.reason, found.message);
          ticket = found.ticket;
        }
        let protectedPaths: AssignmentPlan["protectedPaths"];
        if (input.protectedPaths !== undefined) {
          const paths = [...new Set(input.protectedPaths.paths.map(normaliseControlPath))];
          const glob = paths.find((path) => /[*?[]/.test(path));
          if (glob !== undefined)
            return yield* refusal(
              "invalid",
              `${glob} is a pattern. Name each protected file the team must edit exactly, without *, ? or [.`,
            );
          const isProtected = controlPathMatcher(protectedPathsOf(manager));
          const unprotected = paths.find((path) => path === "" || !isProtected(path));
          if (unprotected !== undefined)
            return yield* refusal(
              "invalid",
              `${unprotected || "An empty path"} is not a protected path, so the team may edit it without asking.`,
            );
          protectedPaths = { paths, reason: input.protectedPaths.reason };
        }
        const config = (yield* configView(manager.projectId)).effective;
        return yield* startAssignment(manager, config, {
          kind: "commission",
          reason: input.title,
          logPayload:
            ticket === null
              ? { title: input.title }
              : { issue: ticket.issue.ref, updatedAt: ticket.issue.updatedAt },
          refusalPayload,
          title: input.title,
          brief: input.brief,
          completionCondition: input.completionCondition,
          complexity: input.complexity,
          team: input.team ?? DEFAULT_TEAM,
          teamId: input.teamId,
          leadModel: input.leadModel,
          ticket,
          dependencyId: input.dependencyId ?? null,
          protectedPaths,
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

  /**
   * Writes the stall and the wake that tells the manager, unless the manager is paused or the user
   * has taken over the lead's thread.
   */
  const markStalled = Effect.fnUntraced(function* (id: string, reason: string) {
    const rows = yield* sql<LeadAssignmentRow & { manager_state: string }>`
        SELECT a.*, ${LEAD_TAKEN_OVER}, m.state AS manager_state FROM factory_assignments a
        JOIN factory_managers m ON m.id=a.manager_id WHERE a.id=${id}`;
    const row = rows[0];
    if (!row || row.state !== "active") return false;
    const at = yield* now;
    yield* sql`UPDATE factory_assignments SET ${enterState("stalled", at)},waiting_reason=${reason},
        waiting_kind=NULL,stall_reason=${reason},updated_at=${at} WHERE id=${id}`;
    yield* writeLog(row.manager_id, id, "stalled", reason, { leadThreadId: row.lead_thread_id });
    if (!isPaused(row.manager_state) && row.lead_taken_over !== 1)
      yield* writeWake(row, "stalled", { title: row.title, reason });
    return true;
  });

  /** Moves the assignment between two states when it is still in `from`. */
  const moveState = Effect.fnUntraced(function* (
    id: string,
    from: { readonly state: string; readonly kind: string | null },
    to: { readonly state: FactoryAssignmentState; readonly kind: string | null },
    reason: string | null,
  ) {
    const rows = yield* sql<AssignmentRow>`SELECT * FROM factory_assignments WHERE id=${id}`;
    const row = rows[0];
    if (!row || row.state !== from.state || row.waiting_kind !== from.kind) return false;
    const at = yield* now;
    yield* sql`UPDATE factory_assignments SET ${enterState(to.state, at)},waiting_kind=${to.kind},
        waiting_reason=${reason},updated_at=${at} WHERE id=${id}`;
    return true;
  });

  /**
   * Starts the retro once every claimed pull request and every one linked on the lead's thread is
   * merged or closed; until then the assignment waits on the user's review.
   */
  /**
   * The pull requests linked on the lead threads an assignment had before its current one: a
   * replacement lead inherits the worktree but not the first lead's links.
   */
  const previousLeadLinks = Effect.fnUntraced(function* (id: string) {
    const previousLeads = yield* sql<{ thread_id: string }>`SELECT thread_id FROM factory_members
        WHERE assignment_id=${id} AND role='lead' AND ended_at IS NOT NULL`;
    const links: FactoryThreadPullRequest[] = [];
    for (const lead of previousLeads) {
      const previous = yield* deps.readThreadRuns(ThreadId.make(lead.thread_id));
      links.push(...(previous?.pullRequests ?? []));
    }
    return links;
  });

  const settleClaim = Effect.fnUntraced(function* (
    id: string,
    runs: FactoryThreadRuns | null,
    merged?: FactoryMergedPullRequest,
  ) {
    const previousLinks = withMerge(yield* previousLeadLinks(id), merged);
    const settled = yield* lock(
      Effect.gen(function* () {
        const rows = yield* sql<AssignmentRow>`SELECT * FROM factory_assignments WHERE id=${id}`;
        const row = rows[0];
        if (!row || row.claim_json === null || !CLAIMABLE_STATES.has(row.state)) return null;
        // Protected-path changes hold the claim; clearing them settles it again.
        if (row.waiting_kind === "control") return null;
        const claim = yield* parse(FactoryAssignmentClaim, row.claim_json);
        const linked = new Map(
          [...previousLinks, ...(runs?.pullRequests ?? [])].map((pullRequest) => [
            pullRequestKey(pullRequest),
            pullRequest,
          ]),
        );
        // Flags the assignment left the hold with, such as a revoke while it was blocked, still
        // hold the claim; the user's merge or close of that pull request lets it through.
        const unheld = effectiveViolations(
          yield* parse(ControlViolations, row.control_violations_json),
          yield* parse(ProtectedPathAsks, row.protected_path_asks_json),
        ).filter((violation) => {
          const link = linked.get(pullRequestKey(violation.pullRequest));
          if (link === undefined) return !isMerge(merged, violation.pullRequest);
          return !link.merged && link.state !== "closed";
        });
        if (unheld.length > 0) {
          if (!needsHold(row, unheld)) return null;
          const at = yield* now;
          yield* sql`UPDATE factory_assignments SET ${enterState("waiting-user", at)},
              waiting_kind='control',waiting_reason=${controlReason(unheld)},updated_at=${at}
              WHERE id=${id}`;
          return { retro: false, row } as const;
        }
        const gated = new Map<string, ThreadPullRequestKey>();
        for (const pullRequest of [...claim.pullRequests, ...linked.values()])
          gated.set(pullRequestKey(pullRequest), pullRequest);
        const unmerged = [...gated].filter(([key, pullRequest]) => {
          const link = linked.get(key);
          if (link === undefined) return !isMerge(merged, pullRequest);
          return !link.merged && link.state !== "closed";
        });
        if (unmerged.length > 0) {
          const reason = `Pull requests await the user's review: ${unmerged
            .map(([, pullRequest]) => `#${pullRequest.number}`)
            .join(", ")}.`;
          if (
            row.state === "waiting-user" &&
            row.waiting_kind === "review" &&
            row.waiting_reason === reason
          )
            return null;
          const at = yield* now;
          yield* sql`UPDATE factory_assignments SET ${enterState("waiting-user", at)},
              waiting_kind='review',waiting_reason=${reason},updated_at=${at} WHERE id=${id}`;
          return { retro: false, row } as const;
        }
        const at = yield* now;
        yield* sql`UPDATE factory_assignments SET ${enterState("retro", at)},waiting_kind=NULL,
            waiting_reason=NULL,ended_at=NULL,updated_at=${at} WHERE id=${id}`;
        yield* writeWake(row, "retro", { title: row.title, assignmentId: row.id });
        return { retro: true, row } as const;
      }),
    );
    if (settled === null) return;
    const { row } = settled;
    if (settled.retro && row.lead_thread_id !== null)
      yield* notifyLead(
        row.project_id,
        row.lead_thread_id,
        `All pull requests for ${row.title} are merged. ${RETRO_ASK}`,
      );
    yield* publish;
  });

  /**
   * Reads the files of each open pull request whose snapshot changed since its last check, outside
   * the lock, and records which touch the manager's control paths. Paths the user allowed for the
   * assignment do not count. A newly flagged path sends the assignment to the user, records an ask
   * for a path no ask names yet, and tells the lead and the manager unless the user already
   * declined it; once none remain the assignment returns to work. An unlinked pull request's flag
   * stays until the user merges it or allows its files. A failed read leaves that pull
   * request for the next reconcile. True when the assignment's state changed, so the caller stops
   * there.
   */
  const checkControlPaths = Effect.fnUntraced(function* (
    row: LeadAssignmentRow & { readonly manager_result_json: string | null },
    runs: FactoryThreadRuns,
    merged: FactoryMergedPullRequest | undefined,
  ) {
    // An exempt team's job is the workflow itself. The snapshot carries the flag, so editing the
    // team later cannot change a running check.
    const team = yield* parse(FactoryTeamSpec, row.team_json);
    if (team.definition?.mayEditProtectedPaths === true) return false;
    const open = runs.pullRequests.filter(
      (pullRequest) => pullRequest.state === "open" && pullRequest.updatedAt !== null,
    );
    const checked = yield* parse(ControlChecked, row.control_checked_json);
    const stored = yield* parse(ControlViolations, row.control_violations_json);
    // A flag ends only with its pull request's merge or close, or a fresh read without protected
    // paths. A replacement lead that has not linked the pull request, or whose link has not
    // synced, ends nothing.
    const latest = new Map(
      (stored.length === 0
        ? []
        : [...withMerge(yield* previousLeadLinks(row.id), merged), ...runs.pullRequests]
      ).map((link) => [pullRequestKey(link), link]),
    );
    const ended = (violation: FactoryControlViolation) => {
      const link = latest.get(pullRequestKey(violation.pullRequest));
      return (
        isMerge(merged, violation.pullRequest) ||
        (link !== undefined && (link.merged || link.state === "closed"))
      );
    };
    const due = open.filter(
      (pullRequest) => checked[pullRequestKey(pullRequest)] !== pullRequest.updatedAt,
    );
    if (
      due.length === 0 &&
      !stored.some(ended) &&
      !needsHold(
        row,
        effectiveViolations(stored, yield* parse(ProtectedPathAsks, row.protected_path_asks_json)),
      )
    )
      return false;
    const matches = controlPathMatcher(
      resultControlPaths(
        row.manager_result_json === null
          ? null
          : yield* parse(FactoryOnboardingResult, row.manager_result_json),
      ),
    );
    const results: Array<
      { readonly key: string; readonly version: string } & FactoryControlViolation
    > = [];
    for (const pullRequest of due) {
      const files = yield* deps
        .readPullRequestFiles({
          projectId: ProjectId.make(row.project_id),
          host: pullRequest.host,
          repository: pullRequest.repository,
          number: pullRequest.number,
        })
        .pipe(Effect.result);
      if (files._tag === "Failure") {
        yield* Effect.logWarning("Could not read a factory pull request's files", {
          assignmentId: row.id,
          pullRequest: pullRequestKey(pullRequest),
          cause: files.failure.message,
        });
        continue;
      }
      results.push({
        key: pullRequestKey(pullRequest),
        version: pullRequest.updatedAt!,
        pullRequest: {
          host: pullRequest.host,
          repository: pullRequest.repository,
          number: pullRequest.number,
        },
        paths: files.success.filter(matches),
      });
    }
    const outcome = yield* lock(
      Effect.gen(function* () {
        const current = (yield* sql<AssignmentRow>`SELECT * FROM factory_assignments
            WHERE id=${row.id}`)[0];
        if (!current || isTerminal(current.state)) return null;
        const before = yield* parse(ControlViolations, current.control_violations_json);
        const asksBefore = yield* parse(ProtectedPathAsks, current.protected_path_asks_json);
        const allowed = allowedPaths(asksBefore);
        const declined = declinedPaths(asksBefore);
        const asked = new Set(asksBefore.flatMap((ask) => ask.paths));
        const nextChecked = { ...(yield* parse(ControlChecked, current.control_checked_json)) };
        const byKey = new Map(
          before
            .filter((violation) => !ended(violation))
            .map((violation) => [pullRequestKey(violation.pullRequest), violation]),
        );
        const at = yield* now;
        const newAsks: FactoryProtectedPathAsk[] = [];
        // A path the previous check of the same pull request did not flag holds the assignment.
        let flagged = false;
        const fresh: FactoryControlViolation[] = [];
        // Declined paths a new snapshot still changes: the lead hears once per snapshot, and the
        // manager is not woken.
        const stillDeclined: FactoryControlViolation[] = [];
        for (const { key, version, ...violation } of results) {
          nextChecked[key] = version;
          if (violation.paths.length === 0) {
            byKey.delete(key);
            continue;
          }
          const previous = byKey.get(key);
          byKey.set(key, violation);
          const unallowed = violation.paths.filter((path) => !allowed.has(path));
          const added = unallowed.filter((path) => previous?.paths.includes(path) !== true);
          if (added.length > 0) flagged = true;
          const declinedHere = unallowed.filter((path) => declined.has(path));
          // A fresh flag's wake already names the declined files it carries.
          if (added.some((path) => !declined.has(path)))
            fresh.push({ ...violation, paths: unallowed });
          else if (declinedHere.length > 0)
            stillDeclined.push({ ...violation, paths: declinedHere });
          const unasked = unallowed.filter((path) => !asked.has(path));
          for (let index = 0; index < unasked.length; index += FACTORY_ASK_PATH_LIMIT) {
            newAsks.push({
              id: NodeCrypto.randomUUID(),
              paths: unasked.slice(index, index + FACTORY_ASK_PATH_LIMIT),
              reason: `Pull request #${violation.pullRequest.number} changes these protected files.`,
              source: "pull-request",
              pullRequest: violation.pullRequest,
              state: "open",
              createdAt: at,
              answeredAt: null,
            });
          }
          for (const path of unasked) asked.add(path);
        }
        const violations = [...byKey.values()];
        const asks = [...asksBefore, ...newAsks];
        yield* sql`UPDATE factory_assignments SET control_checked_json=${json(nextChecked)},
            control_violations_json=${json(violations)},
            protected_path_asks_json=${json(asks)} WHERE id=${row.id}`;
        const effective = effectiveViolations(violations, asks);
        const reason = controlReason(effective);
        const inControl = current.state === "waiting-user" && current.waiting_kind === "control";
        // An unflagged hold covers flags the assignment left control with, such as a revoke
        // while it was blocked; those were announced already, so nothing is woken for them.
        if (flagged || needsHold(current, effective)) {
          if (current.state === "active" || current.state === "waiting-user")
            yield* sql`UPDATE factory_assignments SET ${enterState("waiting-user", at)},
                waiting_kind='control',waiting_reason=${reason},updated_at=${at} WHERE id=${row.id}`;
          const texts = fresh.map((violation) => violationText(violation, asks));
          for (const text of texts)
            yield* writeWake(current, "control", {
              title: current.title,
              assignmentId: current.id,
              text,
            });
          return {
            kind: "violation",
            texts: [...texts, ...stillDeclined.map(declinedAgainText)],
          } as const;
        }
        if (inControl && effective.length === 0) {
          yield* sql`UPDATE factory_assignments SET ${enterState("active", at)},waiting_kind=NULL,
              waiting_reason=NULL,updated_at=${at} WHERE id=${row.id}`;
          return { kind: "cleared", claimed: current.claim_json !== null } as const;
        }
        if (inControl && reason !== current.waiting_reason)
          yield* sql`UPDATE factory_assignments SET waiting_reason=${reason},
              updated_at=${at} WHERE id=${row.id}`;
        return {
          kind: "recorded",
          changed: json(before) !== json(violations) || newAsks.length > 0,
          texts: stillDeclined.map(declinedAgainText),
        } as const;
      }),
    );
    if (outcome === null) return false;
    switch (outcome.kind) {
      case "violation":
        if (row.lead_taken_over !== 1 && row.lead_thread_id !== null)
          for (const text of outcome.texts)
            yield* notifyLead(row.project_id, row.lead_thread_id, text);
        yield* publish;
        return true;
      case "cleared":
        yield* publish;
        if (outcome.claimed) yield* settleClaim(row.id, runs, merged);
        return true;
      case "recorded":
        if (row.lead_taken_over !== 1 && row.lead_thread_id !== null)
          for (const text of outcome.texts)
            yield* notifyLead(row.project_id, row.lead_thread_id, text);
        if (outcome.changed) yield* publish;
        return false;
    }
  });

  /**
   * Whether the assignment's claim, any of its lead threads or a stored control flag names the
   * merged pull request.
   */
  const involvesMerge = Effect.fnUntraced(function* (
    row: AssignmentRow,
    runs: FactoryThreadRuns,
    merged: FactoryMergedPullRequest,
  ) {
    if (runs.pullRequests.some((link) => isMerge(merged, link))) return true;
    const claim =
      row.claim_json === null ? null : yield* parse(FactoryAssignmentClaim, row.claim_json);
    if (claim?.pullRequests.some((pullRequest) => isMerge(merged, pullRequest))) return true;
    const stored = yield* parse(ControlViolations, row.control_violations_json);
    if (stored.some((violation) => isMerge(merged, violation.pullRequest))) return true;
    return (yield* previousLeadLinks(row.id)).some((link) => isMerge(merged, link));
  });

  /**
   * Asks the lead to rebase an open pull request once when it starts conflicting with its base.
   * A sync that shows it mergeable again ends that conflict, so a later one is asked about anew.
   * `unknown` ends nothing: hosts report it while they recompute after any push or base move, so
   * it says nothing about whether the conflict was resolved. The ask waits while the manager is
   * paused, the user has the lead, or the lead waits on the user. It is recorded after the send is
   * attempted: a failed send is only logged, so that ask is lost rather than retried.
   */
  const askToRebase = Effect.fnUntraced(function* (
    row: LeadAssignmentRow & { readonly manager_state: string },
    runs: FactoryThreadRuns,
  ) {
    const leadThreadId = row.lead_thread_id;
    if (leadThreadId === null) return;
    const open = runs.pullRequests.filter((pullRequest) => pullRequest.state === "open");
    const conflicting = open.filter((pullRequest) => pullRequest.mergeability === "conflicting");
    const resolved = open.filter((pullRequest) => pullRequest.mergeability === "mergeable");
    if (conflicting.length === 0 && resolved.length === 0) return;
    const asked = new Map<string, boolean>();
    for (const logged of yield* sql<{ payload_json: string | null }>`SELECT payload_json
        FROM factory_log WHERE assignment_id=${row.id} AND kind='conflict' ORDER BY sequence`)
      Option.map(decodeConflictLog(logged.payload_json), (payload) =>
        asked.set(payload.pullRequest, payload.asked),
      );
    const record = (pullRequest: FactoryThreadPullRequest, nowAsked: boolean) =>
      writeLog(
        row.manager_id,
        row.id,
        "conflict",
        nowAsked
          ? `Pull request #${pullRequest.number} conflicts with its base branch.`
          : `Pull request #${pullRequest.number} no longer conflicts.`,
        { pullRequest: pullRequestKey(pullRequest), asked: nowAsked },
      );
    for (const pullRequest of resolved)
      if (asked.get(pullRequestKey(pullRequest)) === true) yield* lock(record(pullRequest, false));
    const holding =
      row.lead_taken_over === 1 ||
      row.manager_state === "manager-paused" ||
      row.manager_state === "project-paused" ||
      runs.pendingRequests > 0 ||
      (row.state === "waiting-user" && row.waiting_kind === "question");
    if (holding) return;
    // The reactor reconciles one lead at a time, so recording after the send cannot ask twice.
    for (const pullRequest of conflicting) {
      if (asked.get(pullRequestKey(pullRequest)) === true) continue;
      yield* notifyLead(
        row.project_id,
        leadThreadId,
        `Pull request #${pullRequest.number} conflicts with its base branch. Rebase it onto the base, resolve the conflicts, and push.`,
      );
      yield* lock(record(pullRequest, true));
    }
  });

  const reconcileLead = Effect.fnUntraced(function* (
    threadId: ThreadId,
    merged?: FactoryMergedPullRequest,
  ) {
    const rows = yield* sql<
      LeadAssignmentRow & { manager_state: string; manager_result_json: string | null }
    >`
        SELECT a.*, ${LEAD_TAKEN_OVER}, m.state AS manager_state,
        m.onboarding_result_json AS manager_result_json FROM factory_assignments a
        JOIN factory_managers m ON m.id=a.manager_id
        WHERE a.lead_thread_id=${threadId} AND a.state IN ('active','waiting-user')`;
    const row = rows[0];
    if (!row) return;
    const read = yield* deps.readThreadRuns(threadId);
    if (read === null) return;
    if (merged !== undefined && !(yield* involvesMerge(row, read, merged))) return;
    const runs = { ...read, pullRequests: withMerge(read.pullRequests, merged) };
    if (!runs.deleted && (yield* checkControlPaths(row, runs, merged))) return;
    if (!runs.deleted) yield* askToRebase(row, runs);
    if (row.state === "waiting-user") {
      if (row.waiting_kind === "review" && row.claim_json !== null)
        return yield* settleClaim(row.id, runs, merged);
      if (row.waiting_kind === "question" && runs.pendingRequests === 0) {
        const moved = yield* lock(
          moveState(
            row.id,
            { state: "waiting-user", kind: "question" },
            { state: "active", kind: null },
            null,
          ),
        );
        if (moved) yield* publish;
      }
      return;
    }
    if (!runs.deleted && runs.pendingRequests > 0) {
      const moved = yield* lock(
        moveState(
          row.id,
          { state: "active", kind: null },
          { state: "waiting-user", kind: "question" },
          "The lead is waiting on the user.",
        ),
      );
      if (moved) yield* publish;
      return;
    }
    // A project pause interrupts every lead on purpose; those runs are not stalls.
    if (row.manager_state === "project-paused") return;
    // A completed run is left alone: the lead reports through factory_claim_complete.
    const reason = stallReason(runs);
    if (reason === null) return;
    if (yield* lock(markStalled(row.id, reason))) yield* publish;
  });

  const reconcileThread: FactoryServiceShape["reconcileThread"] = (threadId) =>
    protect(reconcileLead(threadId)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reconcile a factory lead thread", { threadId, cause }),
      ),
    );

  const reconcileMerge: FactoryServiceShape["reconcileMerge"] = (merged) =>
    protect(
      Effect.gen(function* () {
        const leads = yield* sql<{ lead_thread_id: string }>`SELECT lead_thread_id
            FROM factory_assignments WHERE lead_thread_id IS NOT NULL
            AND state IN ('active','waiting-user')`;
        for (const lead of leads) yield* reconcileLead(ThreadId.make(lead.lead_thread_id), merged);
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reconcile a merged factory pull request", {
          pullRequest: `${merged.repository}#${merged.number}`,
          cause,
        }),
      ),
    );

  const queuePickupWake = Effect.fnUntraced(function* (manager: FactoryManager) {
    if (!(yield* capacity(manager)).free) return;
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
      switch (row.reason) {
        case "stalled":
          Option.map(decodeStalledWake(row.payload_json), (payload) =>
            lines.push(
              `Assignment ${payload.title} stalled: ${payload.reason} Investigate its lead thread, then call factory_recover to rebrief or replace the lead, or recommend to the user.`,
            ),
          );
          break;
        case "retro":
          Option.map(decodeRetroWake(row.payload_json), (payload) =>
            lines.push(
              payload.cancelReason === undefined
                ? `All pull requests for ${payload.title} are merged and its lead is writing the team retro. You will be woken for your manager retro once it is done.`
                : `The user cancelled ${payload.title}: ${sentence(payload.cancelReason)} Its lead is writing the team retro. You will be woken for your manager retro once it is done.`,
            ),
          );
          break;
        case "dependency":
          Option.map(decodeDependencyWake(row.payload_json), (payload) =>
            lines.push(
              `Assignment ${payload.title} is blocked on ${payload.dependencyTitle}: ${sentence(payload.unblockCondition)} Commission it with factory_commission (dependencyId ${payload.dependencyId}) or tell the lead how to proceed. The lead's brief for it:\n\n${payload.brief}`,
            ),
          );
          break;
        case "control":
          Option.map(decodeControlWake(row.payload_json), (payload) =>
            lines.push(`Assignment ${payload.title}: ${payload.text}`),
          );
          break;
        case "off-pool":
          Option.map(decodeOffPoolWake(row.payload_json), (payload) =>
            lines.push(
              `Thread ${payload.threadId} under ${payload.title} runs ${payload.model}, which is outside the pool. Tell the lead to stop it or ask the user to add the model.`,
            ),
          );
          break;
        case "handback":
          Option.map(decodeHandbackWake(row.payload_json), (payload) =>
            lines.push(
              `The user handed back ${payload.title}; it is now ${payload.state}. Check its thread for what changed.`,
            ),
          );
          break;
        case "finding":
          Option.map(decodeFindingWake(row.payload_json), (payload) =>
            lines.push(
              `Finding escalated on ${payload.title}: ${sentence(payload.summary)} Read it with factory_status or factory_findings and decide.`,
            ),
          );
          break;
        case "settings":
          Option.map(decodeSettingsWake(row.payload_json), (payload) =>
            lines.push(
              [
                "The user changed your settings:",
                ...payload.changes.map((change) => `- ${change}`),
                "Use them from now on.",
              ].join("\n"),
            ),
          );
          break;
        case "manager-retro":
          Option.map(decodeManagerRetroWake(row.payload_json), (payload) =>
            lines.push(
              `${payload.teamRetroSkipped === true ? `The lead's thread for ${payload.title} was deleted before its team retro.` : `The team retro for ${payload.title} is done.`} Do the manager retro: read its findings, draft tickets with factory_draft_ticket (scope project or factory), judge the team fit, then call factory_complete for assignment ${payload.assignmentId}.`,
            ),
          );
          break;
        case "claim":
          Option.map(decodeClaimWake(row.payload_json), (payload) =>
            lines.push(
              `The lead of ${payload.title} claims it complete with ${
                payload.pullRequests.length === 0
                  ? "no pull requests"
                  : payload.pullRequests
                      .map(
                        (pullRequest) =>
                          `${pullRequest.repository}#${pullRequest.number}${
                            pullRequest.merged === true
                              ? " (merged)"
                              : pullRequest.headSha === null
                                ? " (head unknown)"
                                : ` at ${pullRequest.headSha.slice(0, 12)}`
                          }`,
                      )
                      .join(", ")
              }. Check the evidence with factory_status.`,
            ),
          );
          break;
        case "question":
          Option.map(decodeQuestionWake(row.payload_json), (payload) =>
            lines.push(
              `The lead of ${payload.title} asks: ${payload.question}\n\nReply in its thread with t3_thread_send (threadId ${payload.leadThreadId}).`,
            ),
          );
          break;
      }
    }
    return lines.join("\n\n");
  };

  const deliverWakes = Effect.fnUntraced(function* (manager: FactoryManager) {
    if (manager.threadId === null) return;
    if (deps.readingWakes) yield* deps.readingWakes(manager.id);
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
  }, deliveryMutex.withPermits(1));

  /**
   * A lead whose thread is deleted mid-retro never calls factory_retro_done, so its retro counts
   * as done and the manager is woken for its own.
   */
  const skipOrphanedRetros = Effect.fnUntraced(function* (managerId: string) {
    const candidates = yield* sql<{ id: string; lead_thread_id: string }>`
        SELECT id,lead_thread_id FROM factory_assignments
        WHERE manager_id=${managerId} AND state='retro' AND team_retro_at IS NULL
        AND lead_thread_id IS NOT NULL`;
    let skipped = false;
    for (const candidate of candidates) {
      const runs = yield* deps.readThreadRuns(ThreadId.make(candidate.lead_thread_id));
      if (runs?.deleted !== true) continue;
      const changed = yield* lock(
        Effect.gen(function* () {
          const rows = yield* sql<AssignmentRow>`SELECT * FROM factory_assignments
              WHERE id=${candidate.id}`;
          const row = rows[0];
          if (!row || row.state !== "retro" || row.team_retro_at !== null) return false;
          const at = yield* now;
          yield* sql`UPDATE factory_assignments SET team_retro_at=${at},updated_at=${at}
              WHERE id=${row.id}`;
          yield* writeLog(
            row.manager_id,
            row.id,
            "retro",
            "team retro skipped: lead thread deleted",
            null,
          );
          yield* writeWake(row, "manager-retro", {
            assignmentId: row.id,
            title: row.title,
            cancelled: row.cancel_reason !== null,
            teamRetroSkipped: true,
          });
          return true;
        }),
      );
      skipped = skipped || changed;
    }
    if (skipped) yield* publish;
  });

  const sweepManager = Effect.fnUntraced(function* (managerId: string) {
    yield* skipOrphanedRetros(managerId);
    const leads = yield* sql<{ lead_thread_id: string }>`SELECT lead_thread_id
        FROM factory_assignments WHERE manager_id=${managerId} AND lead_thread_id IS NOT NULL
        AND ${sql.in("state", ACTIVE_ASSIGNMENT_STATES)}`;
    for (const lead of leads) yield* reconcileLead(ThreadId.make(lead.lead_thread_id));
    const manager = yield* readManager(managerId);
    if (manager.state !== "active" && manager.state !== "ready") return;
    // A ready manager hears about its assignments, but no ticket until the user starts pickup.
    if (manager.state === "active") yield* queuePickupWake(manager);
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

  /**
   * Delivers a lead's wake without waiting for the sweep. A paused manager's wakes wait in the log
   * until it resumes; a failed delivery leaves them for the sweep.
   */
  const wakeManagerNow = (managerId: string) =>
    readManager(managerId).pipe(
      Effect.flatMap((manager) => (isPaused(manager.state) ? Effect.void : deliverWakes(manager))),
      Effect.catch((cause) =>
        Effect.logWarning("Could not wake the engineering manager", {
          managerId,
          cause: cause.message,
        }),
      ),
    );

  const requireClaimableLead = Effect.fnUntraced(function* (leadThreadId: ThreadId) {
    const row = yield* requireLead(leadThreadId);
    if (!CLAIMABLE_STATES.has(row.state))
      return yield* error(
        "conflict",
        `${row.title} is ${row.state}; a completion claim needs it active, blocked or waiting on the user.`,
      );
    return row;
  });

  const claimComplete: FactoryServiceShape["claimComplete"] = (leadThreadId, input) =>
    protect(
      Effect.gen(function* () {
        // The lock re-validates the lead; this read reports a non-lead or an ended assignment
        // before a link error, and supplies the project and the assignment.
        const lead = yield* requireClaimableLead(leadThreadId);
        const runs = yield* deps.readThreadRuns(leadThreadId);
        const pullRequests = (input.pullRequests ?? []).map(normalizeThreadPullRequestKey);
        const linked = new Map(
          (runs?.pullRequests ?? []).map((link) => [pullRequestKey(link), link]),
        );
        // Checked before the head reads so a bad claim costs no host calls. Both inputs are read
        // once, so the lock has nothing newer to check this against.
        const unlinked = pullRequests.find((key) => !linked.has(pullRequestKey(key)));
        if (unlinked !== undefined)
          return yield* error(
            "invalid",
            `Link #${unlinked.number} to this thread before claiming.`,
          );
        const projectId = ProjectId.make(lead.project_id);
        // The manager hears of every pull request the assignment waits on, claimed or only linked,
        // including links on replaced leads' threads as settleClaim gates on them.
        // A closed one no longer gates it, and a merged one has no head left to check.
        const known = new Map(
          [...(yield* previousLeadLinks(lead.id)), ...(runs?.pullRequests ?? [])].map((link) => [
            pullRequestKey(link),
            link,
          ]),
        );
        const waitedOn = new Map<string, ThreadPullRequestKey>();
        for (const key of [
          ...pullRequests,
          ...[...known.values()].map(normalizeThreadPullRequestKey),
        ])
          if (known.get(pullRequestKey(key))?.state !== "closed")
            waitedOn.set(pullRequestKey(key), key);
        // Read outside the lock; an unknown head never blocks the claim.
        const heads = yield* Effect.forEach([...waitedOn.values()], (key) =>
          known.get(pullRequestKey(key))?.merged === true
            ? Effect.succeed({
                repository: key.repository,
                number: key.number,
                headSha: null,
                merged: true,
              })
            : deps.readPullRequestHead({ projectId, ...key }).pipe(
                Effect.map((headSha) => ({
                  repository: key.repository,
                  number: key.number,
                  headSha,
                  merged: false,
                })),
              ),
        );
        const id = yield* lock(
          Effect.gen(function* () {
            const row = yield* requireClaimableLead(leadThreadId);
            const at = yield* now;
            yield* sql`UPDATE factory_assignments SET claim_json=${json({
              evidence: input.evidence,
              pullRequests,
              claimedAt: at,
            })},updated_at=${at} WHERE id=${row.id}`;
            yield* writeLog(row.manager_id, row.id, "claim", input.evidence, { pullRequests });
            yield* writeWake(row, "claim", {
              title: row.title,
              assignmentId: row.id,
              pullRequests: heads,
            });
            return row.id;
          }),
        );
        yield* settleClaim(id, runs);
        yield* publish;
        const assignment = yield* readAssignment(id);
        yield* wakeManagerNow(assignment.managerId);
        return assignment;
      }),
    );

  const reportDependency: FactoryServiceShape["reportDependency"] = (leadThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const dependency = yield* lock(
          Effect.gen(function* () {
            const row = yield* requireLead(leadThreadId);
            if (row.state !== "active")
              return yield* error(
                "conflict",
                `${row.title} is ${row.state}; only an active assignment can report a dependency.`,
              );
            const id = NodeCrypto.randomUUID();
            const at = yield* now;
            yield* sql`INSERT INTO factory_dependencies(id,blocked_assignment_id,title,
                unblock_condition,brief,state,created_at,updated_at)
                VALUES(${id},${row.id},${input.title},${input.unblockCondition},${input.brief},
                'open',${at},${at})`;
            yield* sql`UPDATE factory_assignments SET ${enterState("blocked", at)},waiting_kind=NULL,
                waiting_reason=${`Blocked on ${input.title}: ${sentence(input.unblockCondition)}`},
                updated_at=${at} WHERE id=${row.id}`;
            yield* writeLog(row.manager_id, row.id, "dependency", input.title, {
              dependencyId: id,
              unblockCondition: input.unblockCondition,
            });
            yield* writeWake(row, "dependency", {
              title: row.title,
              assignmentId: row.id,
              dependencyId: id,
              dependencyTitle: input.title,
              unblockCondition: input.unblockCondition,
              brief: input.brief,
            });
            return yield* readDependency(id);
          }),
        );
        yield* publish;
        return dependency;
      }),
    );

  const askManager: FactoryServiceShape["askManager"] = (leadThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const row = yield* lock(
          Effect.gen(function* () {
            const row = yield* requireLead(leadThreadId);
            yield* writeWake(row, "question", {
              title: row.title,
              assignmentId: row.id,
              leadThreadId,
              question: input.question,
            });
            return row;
          }),
        );
        yield* publish;
        yield* wakeManagerNow(row.manager_id);
        const manager = yield* readManager(row.manager_id);
        return {
          assignment: yield* readAssignment(row.id),
          managerPaused: isPaused(manager.state),
        };
      }),
    );

  const recover: FactoryServiceShape["recover"] = (managerThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* requireManager(managerThreadId);
        const problem = managerStateProblem(manager);
        if (problem !== null) return yield* error("conflict", problem);
        const config = (yield* configView(manager.projectId)).effective;
        const files = yield* factoryFiles();
        const checked = yield* lock(
          Effect.gen(function* () {
            const row = yield* ownAssignment(manager, input.assignmentId);
            if (row.state !== "stalled")
              return yield* error(
                "conflict",
                `${row.title} is ${row.state}; only a stalled assignment can be recovered.`,
              );
            if (row.lead_taken_over === 1)
              return yield* error("conflict", "The user has taken over this thread.");
            if (row.recovery_used < files.view.settings.recoveryAllowance)
              return { row, exhausted: false };
            const at = yield* now;
            yield* sql`UPDATE factory_assignments SET ${enterState("waiting-user", at)},
                waiting_kind='recovery',
                waiting_reason=${`Recovery allowance used; the manager recommends: ${input.brief}`},
                updated_at=${at} WHERE id=${row.id}`;
            yield* writeLog(manager.id, row.id, "recovery", "Recovery allowance used.", {
              action: input.action,
              exhausted: true,
            });
            return { row, exhausted: true };
          }),
        );
        const { row } = checked;
        if (checked.exhausted) {
          yield* publish;
          return yield* readAssignment(row.id);
        }
        const attempt = row.recovery_used + 1;
        if (input.action === "rebrief") {
          if (row.lead_thread_id === null)
            return yield* error("invalid", `${row.title} has no lead thread to brief.`);
          // Sent before the state changes, so a lead that never got the brief stays stalled.
          yield* deps.sendToThread({
            projectId: manager.projectId,
            threadId: ThreadId.make(row.lead_thread_id),
            commandId: CommandId.make(
              `factory-recovery:${row.id}:${attempt}:${NodeCrypto.randomUUID()}`,
            ),
            text: input.brief,
          });
          yield* lock(
            Effect.gen(function* () {
              const at = yield* now;
              const back = yield* returnToWork(
                (yield* sql<AssignmentRow>`SELECT * FROM factory_assignments
                    WHERE id=${row.id}`)[0] ?? row,
              );
              yield* sql`UPDATE factory_assignments SET ${enterState(back.state, at)},
                  recovery_used=${attempt},waiting_kind=${back.kind},waiting_reason=${back.reason},
                  updated_at=${at} WHERE id=${row.id}`;
              yield* writeLog(manager.id, row.id, "recovery", input.brief, {
                action: input.action,
                attempt,
              });
            }),
          );
        } else {
          // The stored snapshot, which outgoing assignments replace with a summary.
          const team = yield* parse(FactoryTeamSpec, row.team_json);
          const noPool = yield* noPoolMessage;
          // The same rule as commissioning, read from the team snapshot the assignment keeps.
          const lead =
            team.definition === undefined
              ? files.pool[0] === undefined
                ? { refusal: noPool }
                : { model: files.pool[0] }
              : leadModelFor(team.definition, files, undefined);
          if ("refusal" in lead) return yield* error("invalid", lead.refusal);
          const modelSelection = lead.model;
          const previous =
            row.lead_thread_id === null
              ? null
              : yield* deps.readThreadRuns(ThreadId.make(row.lead_thread_id));
          const worktreePath = previous?.worktreePath ?? null;
          if (worktreePath === null)
            return yield* error(
              "invalid",
              `${row.title}'s stalled lead has no worktree to hand over. Rebrief it or tell the user.`,
            );
          // The issue attempt stays with the first lead's thread, so the ticket's automatic board
          // moves keep following that thread rather than the replacement.
          const ticketNote =
            row.attempt_id === null
              ? ""
              : `\n\nThe ticket's board moves are tracked on the original lead's thread, ${row.lead_thread_id}, not this one.`;
          const shell = yield* project(manager.projectId);
          const threadId = yield* deps.allocateThreadId(manager.projectId);
          yield* deps.launchThread({
            commandId: CommandId.make(`factory-assignment:${row.id}:recovery-${attempt}`),
            threadId,
            projectId: manager.projectId,
            title: `Factory: ${row.title}`,
            text: yield* leadPrompt(
              manager,
              config,
              shell.workspaceRoot,
              {
                title: row.title,
                brief: `${row.brief}\n\n## Recovery brief\n\nYou replace a stalled lead and continue in its worktree${row.branch === null ? "" : ` on branch ${row.branch}`}. Check what it left before you change anything.${ticketNote}\n\n${input.brief}`,
                completionCondition: row.completion_condition,
                team,
              },
              yield* allowedPathsOf(row),
            ),
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspace: {
              type: "existing_worktree",
              worktreePath,
              ...(row.branch === null ? {} : { branch: row.branch }),
            },
          });
          yield* lock(
            Effect.gen(function* () {
              const at = yield* now;
              const back = yield* returnToWork(
                (yield* sql<AssignmentRow>`SELECT * FROM factory_assignments
                    WHERE id=${row.id}`)[0] ?? row,
              );
              yield* sql`UPDATE factory_assignments SET ${enterState(back.state, at)},
                  recovery_used=${attempt},lead_thread_id=${threadId},
                  waiting_kind=${back.kind},waiting_reason=${back.reason},updated_at=${at}
                  WHERE id=${row.id}`;
              if (row.lead_thread_id !== null)
                yield* sql`UPDATE factory_members SET ended_at=${at}
                    WHERE thread_id=${row.lead_thread_id} AND ended_at IS NULL`;
              yield* sql`INSERT INTO factory_members(thread_id,manager_id,assignment_id,role,
                  parent_thread_id,joined,created_at)
                  VALUES(${threadId},${manager.id},${row.id},'lead',${manager.threadId},
                  'created',${at})
                  ON CONFLICT(thread_id) DO NOTHING`;
              yield* writeLog(manager.id, row.id, "recovery", input.brief, {
                action: input.action,
                attempt,
                leadThreadId: threadId,
                previousLeadThreadId: row.lead_thread_id,
              });
            }),
          );
        }
        yield* publish;
        return yield* readAssignment(row.id);
      }),
    );

  /**
   * Marks what this assignment delivered and returns to work every blocked assignment with no
   * other open dependency. Returns the leads to tell.
   */
  const deliverDependencies = Effect.fnUntraced(function* (delivering: AssignmentRow, at: string) {
    const delivered = yield* sql<DependencyRow>`SELECT * FROM factory_dependencies
        WHERE delivering_assignment_id=${delivering.id} AND state='open'`;
    const unblocked: Array<{ projectId: string; threadId: string; text: string }> = [];
    for (const dependency of delivered) {
      yield* sql`UPDATE factory_dependencies SET state='delivered',updated_at=${at}
          WHERE id=${dependency.id}`;
      const blocked = (yield* sql<AssignmentRow>`SELECT * FROM factory_assignments
          WHERE id=${dependency.blocked_assignment_id}`)[0];
      if (!blocked) continue;
      yield* writeLog(
        blocked.manager_id,
        blocked.id,
        "dependency",
        `${dependency.title} delivered.`,
        {
          dependencyId: dependency.id,
          deliveringAssignmentId: delivering.id,
        },
      );
      if (blocked.state !== "blocked") continue;
      const open = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM factory_dependencies
          WHERE blocked_assignment_id=${blocked.id} AND state='open'`;
      if ((open[0]?.count ?? 0) > 0) continue;
      const back = yield* returnToWork(blocked);
      yield* sql`UPDATE factory_assignments SET ${enterState(back.state, at)},
          waiting_kind=${back.kind},waiting_reason=${back.reason},updated_at=${at}
          WHERE id=${blocked.id}`;
      if (blocked.lead_thread_id !== null) {
        const text = `${dependency.title} is done (${delivering.title}). Confirm it unblocks you and continue.`;
        unblocked.push({
          projectId: blocked.project_id,
          threadId: blocked.lead_thread_id,
          text:
            back.kind === "control"
              ? `${text} It is still held on protected files. ${back.reason}`
              : text,
        });
      }
    }
    return unblocked;
  });

  /**
   * Rolls an ended assignment's member threads, lead and workers, into its stats row. Each turn's
   * model prices its tokens; a model the rate table does not know adds tokens but no cost.
   */
  const rollupStats = Effect.fnUntraced(function* (assignmentId: string) {
    const rows = yield* sql<AssignmentRow>`SELECT * FROM factory_assignments
        WHERE id=${assignmentId}`;
    const row = rows[0];
    if (!row || !isTerminal(row.state) || row.ended_at === null) return;
    const members = yield* sql<{
      thread_id: string;
      role: string;
      member_name: string | null;
      joined: string;
    }>`SELECT thread_id,role,member_name,joined
        FROM factory_members WHERE assignment_id=${assignmentId} ORDER BY created_at, thread_id`;
    const byRole = new Map<string, StatsTally>();
    const byModel = new Map<string, StatsTally>();
    const byThread = new Map<string, StatsTally>();
    const pullRequests = new Set<string>();
    for (const member of members) {
      const threadId = ThreadId.make(member.thread_id);
      for (const turn of yield* deps.readThreadTurns(threadId)) {
        const agentMs =
          turn.startedAt === null || turn.completedAt === null
            ? 0
            : elapsedMs(turn.startedAt, turn.completedAt);
        for (const tally of [
          tallyOf(byRole, member.role),
          tallyOf(byModel, turn.model),
          tallyOf(byThread, member.thread_id),
        ]) {
          tally.agentMs += agentMs;
          tally.input += turn.tokens?.input ?? 0;
          tally.cachedInput += turn.tokens?.cachedInput ?? 0;
          tally.output += turn.tokens?.output ?? 0;
        }
      }
      const runs = yield* deps.readThreadRuns(threadId);
      for (const pullRequest of runs?.pullRequests ?? [])
        pullRequests.add(pullRequestKey(pullRequest));
    }
    const table = yield* deps.readRateTable;
    const models = [...byModel].map(([model, tally]) => {
      const priced =
        table === null
          ? null
          : priceUsage(table, {
              model,
              rateModel: model,
              totals: {
                uncachedInputTokens: Math.max(0, tally.input - tally.cachedInput),
                cachedInputTokens: tally.cachedInput,
                cacheCreationTokens: 0,
                outputTokens: tally.output,
                reasoningTokens: 0,
              },
              speed: "standard",
              reportedCostUsd: null,
            });
      return {
        model,
        tokens: tokensOf(tally),
        agentMs: tally.agentMs,
        costUsd: priced === null || priced.costSource === "unpriced" ? null : priced.costUsd,
      };
    });
    const roles = [...byRole].map(([role, tally]) => ({
      role,
      tokens: tokensOf(tally),
      agentMs: tally.agentMs,
    }));
    const total = (pick: (tokens: ReturnType<typeof tokensOf>) => number) =>
      roles.reduce((sum, role) => sum + pick(role.tokens), 0);
    const team = yield* parse(FactoryTeamSpec, row.team_json);
    const verdict =
      row.team_verdict_json === null
        ? null
        : yield* parse(FactoryTeamVerdict, row.team_verdict_json);
    const endedAt = row.ended_at;
    // A team built from definitions has no reviewer role to count rounds by, so it reports none.
    const reviewRounds =
      team.definition === undefined
        ? members.filter((member) => member.role === "reviewer").length
        : 0;
    const byMember =
      team.definition === undefined
        ? null
        : rollupMemberStats(
            members.map((member) => ({
              threadId: member.thread_id,
              memberName: member.member_name,
              joined: member.joined,
            })),
            byThread,
            team.definition.members.map((member) => member.name),
          );
    yield* lock(
      Effect.gen(function* () {
        yield* sql`INSERT OR REPLACE INTO factory_assignment_stats(assignment_id,manager_id,project_id,team,
          complexity,outcome,team_verdict,input_tokens,cached_input_tokens,output_tokens,cost_usd,
          agent_ms,wall_ms,waiting_user_ms,recoveries,pull_requests,review_rounds,by_role_json,
          by_model_json,ended_at)
          VALUES(${row.id},${row.manager_id},${row.project_id},${team.preset},${row.complexity},
          ${row.state},${verdict?.fit ?? null},${total((tokens) => tokens.input)},
          ${total((tokens) => tokens.cachedInput)},${total((tokens) => tokens.output)},
          ${table === null ? null : models.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)},
          ${roles.reduce((sum, role) => sum + role.agentMs, 0)},
          ${elapsedMs(row.created_at, endedAt)},${row.waiting_user_ms},${row.recovery_used},
          ${pullRequests.size},${reviewRounds},
          ${json(roles)},${json(models)},${endedAt})`;
        if (byMember !== null)
          yield* sql`UPDATE factory_assignment_stats SET by_member_json=${json(byMember)}
              WHERE assignment_id=${row.id}`;
      }),
    );
  });

  const decodeStats = Effect.fnUntraced(function* (row: StatsRow) {
    return yield* decodeStatsValue({
      assignmentId: row.assignment_id,
      managerId: row.manager_id,
      projectId: row.project_id,
      team: row.team,
      complexity: row.complexity,
      outcome: row.outcome,
      teamVerdict: row.team_verdict,
      tokens: {
        input: row.input_tokens,
        cachedInput: row.cached_input_tokens,
        output: row.output_tokens,
      },
      costUsd: row.cost_usd,
      agentMs: row.agent_ms,
      wallMs: row.wall_ms,
      waitingUserMs: row.waiting_user_ms,
      recoveries: row.recoveries,
      pullRequests: row.pull_requests,
      reviewRounds: row.review_rounds,
      byRole: yield* parse(Schema.Unknown, row.by_role_json),
      ...(row.by_member_json ? { byMember: yield* parse(Schema.Unknown, row.by_member_json) } : {}),
      byModel: yield* parse(Schema.Unknown, row.by_model_json),
      endedAt: row.ended_at,
    }).pipe(Effect.mapError(storageError));
  });

  const getStats: FactoryServiceShape["getStats"] = (input) =>
    protect(
      Effect.gen(function* () {
        const rows = yield* sql<StatsRow>`SELECT * FROM factory_assignment_stats
            WHERE (${input.projectId ?? null} IS NULL OR project_id=${input.projectId ?? null})
            AND (${input.complexity ?? null} IS NULL OR complexity=${input.complexity ?? null})
            AND (${input.sinceDay ?? null} IS NULL OR ended_at >= ${input.sinceDay ?? null})
            ORDER BY ended_at DESC, assignment_id`;
        const assignments = yield* Effect.forEach(rows, decodeStats);
        const byTeam = new Map<string, FactoryAssignmentStats[]>();
        for (const assignment of assignments) {
          const tasks = byTeam.get(assignment.team);
          if (tasks === undefined) byTeam.set(assignment.team, [assignment]);
          else tasks.push(assignment);
        }
        return {
          teams: [...byTeam]
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([team, tasks]) => teamStats(team, tasks)),
          assignments,
        } satisfies FactoryStatsResult;
      }),
    );

  const amendAssignment: FactoryServiceShape["amendAssignment"] = (managerThreadId, input) =>
    protect(
      // A disconnect interrupts the request, so once the amendment commits the lead must still
      // hear it.
      Effect.gen(function* () {
        const manager = yield* requireManager(managerThreadId);
        const { row, after } = yield* lock(
          Effect.gen(function* () {
            const row = yield* ownAssignment(manager, input.assignmentId);
            if (!CAPACITY_STATES.has(row.state))
              return yield* error(
                "conflict",
                `${row.title} is ${row.state}; only a live assignment can be amended.`,
              );
            if (input.brief === undefined && input.completionCondition === undefined)
              return yield* error("invalid", "Give a new brief, completion condition, or both.");
            const brief = input.brief !== undefined && input.brief !== row.brief;
            const condition =
              input.completionCondition !== undefined &&
              input.completionCondition !== row.completion_condition;
            if (!brief && !condition)
              return yield* error(
                "invalid",
                `${row.title} already has this text; nothing changed.`,
              );
            const before = {
              ...(brief ? { brief: row.brief } : {}),
              ...(condition ? { completionCondition: row.completion_condition } : {}),
            };
            const after = {
              ...(brief ? { brief: input.brief } : {}),
              ...(condition ? { completionCondition: input.completionCondition } : {}),
            };
            const at = yield* now;
            yield* sql`UPDATE factory_assignments SET
                brief=${after.brief ?? row.brief},
                completion_condition=${after.completionCondition ?? row.completion_condition},
                updated_at=${at} WHERE id=${row.id}`;
            yield* writeLog(manager.id, row.id, "amend", input.reason, { before, after });
            return { row, after };
          }),
        );
        // A user who took over the lead thread directs it themselves.
        if (row.lead_thread_id !== null && row.lead_taken_over !== 1)
          yield* notifyLead(
            row.project_id,
            row.lead_thread_id,
            [
              `The manager amended ${row.title}: ${sentence(input.reason)}`,
              ...(after.brief === undefined ? [] : [`The brief is now:\n\n${after.brief}`]),
              ...(after.completionCondition === undefined
                ? []
                : [`The completion condition is now:\n\n${after.completionCondition}`]),
            ].join("\n\n"),
          );
        yield* publish;
        return yield* readAssignment(row.id);
      }).pipe(Effect.uninterruptible),
    );

  const complete: FactoryServiceShape["complete"] = (managerThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* requireManager(managerThreadId);
        // Read outside the lock; a deleted thread stays deleted, so it cannot go stale.
        const leadGone =
          input.teamRetro === "skipped"
            ? yield* Effect.gen(function* () {
                const { lead_thread_id } = yield* ownAssignment(manager, input.assignmentId);
                if (lead_thread_id === null) return true;
                const runs = yield* deps.readThreadRuns(ThreadId.make(lead_thread_id));
                return runs === null || runs.deleted;
              })
            : false;
        const unblocked = yield* lock(
          Effect.gen(function* () {
            const row = yield* ownAssignment(manager, input.assignmentId);
            if (row.state !== "retro")
              return yield* error(
                "conflict",
                `${row.title} is ${row.state}; only an assignment in its retro can be completed.`,
              );
            if (row.team_retro_at === null) {
              if (input.teamRetro !== "skipped")
                return yield* error("conflict", "The team retro has not finished.");
              if (!leadGone && row.lead_taken_over !== 1)
                return yield* error(
                  "conflict",
                  "The lead is still active; wait for its team retro or cancel the assignment.",
                );
            }
            const outcome = row.cancel_reason === null ? "completed" : "cancelled";
            const at = yield* now;
            yield* sql`UPDATE factory_assignments SET ${enterState(outcome, at)},
                team_verdict_json=${json(input.teamVerdict)},waiting_kind=NULL,waiting_reason=NULL,
                manager_retro_at=${at},ended_at=${at},updated_at=${at} WHERE id=${row.id}`;
            yield* sql`UPDATE factory_members SET ended_at=${at}
                WHERE assignment_id=${row.id} AND ended_at IS NULL`;
            yield* writeLog(manager.id, row.id, "complete", input.teamVerdict.reason, {
              outcome,
              teamVerdict: input.teamVerdict,
              ...(row.team_retro_at === null ? { teamRetro: "skipped" } : {}),
            });
            if (outcome === "completed") return yield* deliverDependencies(row, at);
            // A cancelled delivery frees its dependency for another commission.
            yield* sql`UPDATE factory_dependencies SET delivering_assignment_id=NULL,updated_at=${at}
                WHERE delivering_assignment_id=${row.id} AND state='open'`;
            return [];
          }),
        );
        // The assignment has ended either way; stats are a record of it, not part of ending it.
        yield* rollupStats(input.assignmentId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not roll up a factory assignment's stats", {
              assignmentId: input.assignmentId,
              cause,
            }),
          ),
        );
        for (const lead of unblocked) yield* notifyLead(lead.projectId, lead.threadId, lead.text);
        yield* publish;
        return yield* readAssignment(input.assignmentId);
      }),
    );

  /**
   * The design has a state that waits for the user's reason after a cancel. The reason is part of
   * the cancel call, so the assignment goes straight to the lead's retro.
   */
  const cancel: FactoryServiceShape["cancel"] = (input) =>
    protect(
      // A disconnect interrupts the request, and a replay returns early, so once the cancel commits
      // the lead must still be interrupted and told to stop.
      Effect.gen(function* () {
        const applied = yield* lock(
          Effect.gen(function* () {
            const replay = yield* requestReplay(input.requestId, input);
            if (replay !== null) return { replay: yield* parse(FactoryAssignment, replay) };
            const row = yield* leadAssignmentRow(input.assignmentId);
            if (isTerminal(row.state))
              return yield* error("conflict", `${row.title} has already ended.`);
            const at = yield* now;
            yield* sql`UPDATE factory_assignments SET ${enterState("retro", at)},
                cancel_reason=${input.reason},waiting_kind=NULL,waiting_reason=NULL,ended_at=NULL,
                updated_at=${at} WHERE id=${row.id}`;
            yield* writeLog(row.manager_id, row.id, "cancel", input.reason, {
              previousState: row.state,
            });
            yield* writeWake(row, "retro", {
              title: row.title,
              assignmentId: row.id,
              cancelReason: input.reason,
            });
            const assignment = yield* readAssignment(row.id);
            yield* remember(input.requestId, input, assignment);
            return { assignment, row };
          }),
        );
        if ("replay" in applied) return applied.replay;
        const { assignment, row } = applied;
        // After the commit, so the interrupted run reads as a retro rather than a stall. A lead
        // already in its retro keeps writing it.
        if (row.lead_thread_id !== null && row.state !== "retro") {
          yield* deps
            .interruptThread({
              projectId: assignment.projectId,
              threadId: ThreadId.make(row.lead_thread_id),
              commandId: CommandId.make(`factory-cancel:${input.requestId}`),
              reason: `The user cancelled this assignment: ${input.reason}`,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not interrupt a cancelled factory lead", {
                  threadId: row.lead_thread_id,
                  cause: cause.message,
                }),
              ),
            );
          yield* notifyLead(
            row.project_id,
            row.lead_thread_id,
            `The user cancelled ${row.title}: ${sentence(input.reason)} Stop the work. ${RETRO_ASK}`,
          );
        }
        yield* publish;
        return assignment;
      }).pipe(Effect.uninterruptible),
    );

  const answerProtectedPaths: FactoryServiceShape["answerProtectedPaths"] = (input) =>
    protect(
      // A disconnect interrupts the request, and a replay answers nothing, so once the answer
      // commits the lead must still hear it and a claim it frees must still settle.
      Effect.gen(function* () {
        const applied = yield* lock(
          Effect.gen(function* () {
            const replay = yield* requestReplay(input.requestId, input);
            if (replay !== null)
              return { assignment: yield* parse(FactoryAssignment, replay), answered: null };
            const row = yield* leadAssignmentRow(input.assignmentId);
            if (isTerminal(row.state))
              return yield* error("conflict", `${row.title} has already ended.`);
            const asks = yield* parse(ProtectedPathAsks, row.protected_path_asks_json);
            const ask = asks.find((candidate) => candidate.id === input.askId);
            if (ask === undefined)
              return yield* error(
                "not-found",
                `${row.title} has no protected-path ask ${input.askId}.`,
              );
            const state = input.answer === "allow" ? ("allowed" as const) : ("declined" as const);
            if (ask.state === state) {
              const assignment = yield* readAssignment(row.id);
              yield* remember(input.requestId, input, assignment);
              return { assignment, answered: null };
            }
            const verb = ask.state === "allowed" ? ("revoked" as const) : state;
            const at = yield* now;
            const nextAsks = asks.map((candidate) =>
              candidate.id === ask.id ? { ...candidate, state, answeredAt: at } : candidate,
            );
            // The stored flags are re-judged against the answer; the pull requests are not re-read.
            const effective = effectiveViolations(
              yield* parse(ControlViolations, row.control_violations_json),
              nextAsks,
            );
            const reason = controlReason(effective);
            const inControl = row.state === "waiting-user" && row.waiting_kind === "control";
            const flaggedAgain =
              verb === "revoked" &&
              effective.some((violation) =>
                violation.paths.some((path) => ask.paths.includes(path)),
              );
            let cleared = false;
            if (inControl && effective.length === 0) {
              yield* sql`UPDATE factory_assignments SET ${enterState("active", at)},waiting_kind=NULL,
                  waiting_reason=NULL WHERE id=${row.id}`;
              cleared = true;
            } else if (flaggedAgain && needsHold(row, effective))
              yield* sql`UPDATE factory_assignments SET ${enterState("waiting-user", at)},
                  waiting_kind='control',waiting_reason=${reason} WHERE id=${row.id}`;
            else if (inControl)
              yield* sql`UPDATE factory_assignments SET waiting_reason=${reason} WHERE id=${row.id}`;
            yield* sql`UPDATE factory_assignments SET protected_path_asks_json=${json(nextAsks)},
                updated_at=${at} WHERE id=${row.id}`;
            yield* writeWake(row, "control", {
              title: row.title,
              assignmentId: row.id,
              text: answerText(verb, ask.paths, false),
            });
            const assignment = yield* readAssignment(row.id);
            yield* remember(input.requestId, input, assignment);
            return {
              assignment,
              answered: { row, verb, paths: ask.paths, settle: cleared && row.claim_json !== null },
            };
          }),
        );
        const { answered } = applied;
        if (answered === null) return applied.assignment;
        const { row } = answered;
        if (row.lead_taken_over !== 1 && row.lead_thread_id !== null)
          yield* notifyLead(
            row.project_id,
            row.lead_thread_id,
            answerText(answered.verb, answered.paths, true),
          );
        yield* publish;
        if (!answered.settle) return applied.assignment;
        // A claim held only by the flags goes on to the user's review or the retro.
        yield* settleClaim(
          row.id,
          row.lead_thread_id === null
            ? null
            : yield* deps.readThreadRuns(ThreadId.make(row.lead_thread_id)),
        );
        return yield* readAssignment(row.id);
      }).pipe(Effect.uninterruptible),
    );

  const setTakenOver = (
    input: FactoryThreadsTakeOverInput | FactoryThreadsHandBackInput,
    takenOver: boolean,
  ) =>
    protect(
      Effect.gen(function* () {
        const payload = { ...input, takenOver };
        const result = yield* lock(
          Effect.gen(function* () {
            const replay = yield* requestReplay(input.requestId, payload);
            if (replay !== null)
              return { assignment: yield* parse(FactoryAssignment, replay), changed: false };
            const rows = yield* sql<AssignmentRow & { member_taken_over: number }>`
                SELECT a.*, m.taken_over AS member_taken_over FROM factory_members m
                JOIN factory_assignments a ON a.id=m.assignment_id
                WHERE m.thread_id=${input.threadId} AND m.ended_at IS NULL
                AND a.lead_thread_id=m.thread_id AND ${sql.in("a.state", ACTIVE_ASSIGNMENT_STATES)}`;
            const row = rows[0];
            if (!row) return yield* error("not-found", "This thread is not a live factory lead.");
            const changed = (row.member_taken_over === 1) !== takenOver;
            if (changed) {
              yield* sql`UPDATE factory_members SET taken_over=${takenOver ? 1 : 0}
                  WHERE thread_id=${input.threadId}`;
              if (takenOver)
                yield* writeLog(
                  row.manager_id,
                  row.id,
                  "takeover",
                  "The user took over the lead's thread.",
                  {
                    threadId: input.threadId,
                  },
                );
              else {
                yield* writeLog(
                  row.manager_id,
                  row.id,
                  "handback",
                  "The user handed back the lead's thread.",
                  {
                    threadId: input.threadId,
                  },
                );
                yield* writeWake(row, "handback", {
                  title: row.title,
                  assignmentId: row.id,
                  state: row.state,
                });
              }
            }
            const assignment = yield* readAssignment(row.id);
            yield* remember(input.requestId, payload, assignment);
            return { assignment, changed };
          }),
        );
        if (result.changed) yield* publish;
        return result.assignment;
      }),
    );

  const takeOver: FactoryServiceShape["takeOver"] = (input) => setTakenOver(input, true);
  const handBack: FactoryServiceShape["handBack"] = (input) => setTakenOver(input, false);

  const decodeMember = (row: MemberRow) =>
    decodeMemberValue(memberValue(row)).pipe(Effect.mapError(storageError));

  /** Delegation on a team built from definitions: a member by name, on its own model list. */
  const planMemberDelegation = Effect.fnUntraced(function* (
    row: LeadAssignmentRow,
    team: FactoryTeamDefinition,
    input: FactoryDelegateInput,
  ) {
    const names = team.members.map((candidate) => candidate.name).join(", ");
    if (input.member === undefined)
      return yield* error("invalid", `Name the team member to delegate to: ${names}.`);
    const member = findTeamMember(team, input.member);
    if (member === undefined)
      return yield* error(
        "invalid",
        `${team.name} has no member named "${input.member}". Its members: ${names}.`,
      );
    const files = yield* factoryFiles();
    const resolved = resolveModelList(member.models, files.view.settings, files.catalog);
    const choice = chooseModel(resolved, input.modelSelection);
    if (choice.kind !== "chosen")
      return yield* error(
        "invalid",
        modelChoiceRefusal(choice, member.name, input.modelSelection, resolved),
      );
    // A priority list leaves the lead no choice, so it is offered only the model that runs.
    const allowedModels = resolved.dynamic ? resolved.models : [choice.model];
    const manager = yield* readManager(row.manager_id);
    // Last, so a plan refused for any other reason holds no place.
    yield* reservePlace(row.id, {
      kind: "member",
      name: member.name,
      count: member.count,
      busy: `The team allows ${member.count} × ${member.name} and ${member.count === 1 ? "it is" : "all are"} busy.`,
    });
    return {
      role: "worker",
      member: member.name,
      title: input.title ?? `${member.name}: ${row.title}`.slice(0, 120),
      task: workerBrief(member, {
        modelPool: files.pool,
        allowedModels,
        protectedPaths: protectedPathsOf(manager),
        allowedProtectedPaths: yield* allowedPathsOf(row),
        completionCondition: row.completion_condition,
        result: manager.onboardingResult,
        task: input.task,
      }),
      modelSelection: choice.model,
      allowedModels,
    } satisfies FactoryDelegationPlan;
  });

  /**
   * More work for a finished member, in its own thread and on its own model. It takes a place
   * through the same check as a new delegation, so a follow-up never runs past the team's count.
   */
  const planContinuation = Effect.fnUntraced(function* (
    row: LeadAssignmentRow,
    team: FactoryTeamSpec,
    threadId: ThreadId,
    input: FactoryDelegateInput,
  ) {
    const rows = yield* sql<MemberRow & { model_selection_json: string | null }>`SELECT *
        FROM factory_members WHERE thread_id=${threadId} AND assignment_id=${row.id}
        AND joined != 'observed' AND ended_at IS NULL`;
    const recorded = rows[0];
    if (recorded === undefined || recorded.role === "lead" || recorded.role === "manager")
      return yield* error(
        "invalid",
        `${threadId} is not a member of ${row.title}'s team. Delegate without continueThreadId to start one.`,
      );
    const member = yield* decodeMember(recorded);
    let place: Place & { readonly count: number; readonly busy: string };
    let label: string;
    if (team.definition !== undefined) {
      const named =
        member.memberName === undefined
          ? undefined
          : findTeamMember(team.definition, member.memberName);
      if (named === undefined)
        return yield* error(
          "invalid",
          `${threadId} is no longer one of ${team.definition.name}'s members.`,
        );
      if (
        input.member !== undefined &&
        findTeamMember(team.definition, input.member)?.name !== named.name
      )
        return yield* error("invalid", `${threadId} is ${named.name}, not ${input.member}.`);
      label = named.name;
      place = {
        kind: "member",
        name: named.name,
        count: named.count,
        busy: `The team allows ${named.count} × ${named.name} and ${named.count === 1 ? "it is" : "all are"} busy.`,
      };
    } else {
      const staffed = team.members.find((candidate) => candidate.role === member.role);
      if (staffed === undefined)
        return yield* error("invalid", `The team for ${row.title} has no ${member.role}.`);
      if (input.role !== undefined && input.role !== member.role)
        return yield* error("invalid", `${threadId} is a ${member.role}, not a ${input.role}.`);
      label = `The ${member.role}`;
      place = {
        kind: "role",
        role: member.role,
        count: staffed.count,
        busy: `The team allows ${staffed.count} ${member.role}${staffed.count === 1 ? "" : "s"} and all are busy.`,
      };
    }
    if (recorded.model_selection_json === null)
      return yield* error("invalid", `${threadId} has no recorded model to continue on.`);
    const modelSelection = yield* parse(ModelSelection, recorded.model_selection_json);
    if (
      input.modelSelection !== undefined &&
      modelKey(input.modelSelection) !== modelKey(modelSelection)
    )
      return yield* error(
        "invalid",
        `${threadId} runs ${modelSelection.model} (${modelSelection.instanceId}); a follow-up keeps its thread's model.`,
      );
    const runs = yield* deps.readThreadRuns(threadId);
    if (runs?.deleted)
      return yield* error(
        "invalid",
        `${threadId} was deleted. Delegate without continueThreadId to start a new one.`,
      );
    yield* reservePlace(row.id, {
      ...place,
      idle: { threadId, busy: `${label} is still working in ${threadId}; wait for it to finish.` },
    });
    return {
      role: member.role,
      ...(member.memberName === undefined ? {} : { member: member.memberName }),
      title: input.title ?? `${label}: ${row.title}`.slice(0, 120),
      task: workerTask(input.task),
      modelSelection,
      allowedModels: [modelSelection],
      continueThreadId: threadId,
    } satisfies FactoryDelegationPlan;
  });

  const planDelegation: FactoryServiceShape["planDelegation"] = (leadThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const row = yield* requireLead(leadThreadId);
        const team = yield* parse(FactoryTeamSpec, row.team_json);
        if (input.continueThreadId !== undefined)
          return yield* planContinuation(row, team, input.continueThreadId, input);
        if (team.definition !== undefined)
          return yield* planMemberDelegation(row, team.definition, input);
        if (input.role === undefined)
          return yield* error("invalid", `Name the role to delegate to on ${row.title}'s team.`);
        const memberRole = input.role;
        const member = team.members.find((candidate) => candidate.role === memberRole);
        if (member === undefined)
          return yield* error("invalid", `The team for ${row.title} has no ${memberRole}.`);
        // Older teams keep their role models, but the pool comes from the factory config files.
        const config = {
          ...(yield* configView(ProjectId.make(row.project_id))).effective,
          modelPool: (yield* factoryFiles()).pool,
        };
        const allowedModels =
          member.models !== undefined && member.models.length > 0
            ? member.models
            : allowedModelsFor(config, memberRole);
        const modelSelection = input.modelSelection ?? allowedModels[0];
        if (modelSelection === undefined) return yield* error("invalid", yield* noPoolMessage);
        const allowed = new Set(allowedModels.map(modelKey));
        if (!allowed.has(modelKey(modelSelection)))
          return yield* error(
            "invalid",
            `${modelSelection.model} (${modelSelection.instanceId}) is not allowed for a ${memberRole} on this team.`,
          );
        yield* reservePlace(row.id, {
          kind: "role",
          role: memberRole,
          count: member.count,
          busy: `The team allows ${member.count} ${memberRole}${member.count === 1 ? "" : "s"} and all are busy.`,
        });
        const manager = yield* readManager(row.manager_id);
        const shell = yield* project(manager.projectId);
        const fill = {
          ...skillFill(config, memberRole, protectedPathsOf(manager), yield* allowedPathsOf(row)),
          allowedModels,
          completionCondition: row.completion_condition,
        };
        // The migration wrote each role's text into the starter worker of that id, as roleBrief
        // reads it; the built-in skill serves only when that worker is gone.
        const migrated = (yield* deps.configStore.read).workers.find(
          (worker) => worker.id === memberRole,
        );
        const task =
          migrated === undefined
            ? `${renderRoleSkill(
                (yield* deps.readRoleSkill(memberRole, shell.workspaceRoot)).text,
                fill,
              )}\n\n${workerTask(input.task)}`
            : workerBrief(migrated, {
                ...fill,
                result: manager.onboardingResult,
                task: input.task,
              });
        const role = `${memberRole[0]!.toUpperCase()}${memberRole.slice(1)}`;
        return {
          role: memberRole,
          title: input.title ?? `${role}: ${row.title}`.slice(0, 120),
          task,
          modelSelection,
          allowedModels,
        } satisfies FactoryDelegationPlan;
      }),
    );

  const recordMember: FactoryServiceShape["recordMember"] = (leadThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const member = yield* lock(
          Effect.gen(function* () {
            const row = yield* requireLead(leadThreadId);
            // The thread's own `thread.created` may have joined it as observed first.
            // Places are counted by member name, so it is stored as the team spells it.
            const team = (yield* parse(FactoryTeamSpec, row.team_json)).definition;
            const named =
              team === undefined || input.memberName === undefined
                ? undefined
                : findTeamMember(team, input.memberName);
            if (
              input.role === "manager" ||
              input.role === "lead" ||
              (team !== undefined) !== (input.role === "worker") ||
              (team && !named)
            )
              return yield* error(
                "invalid",
                team === undefined
                  ? "This team is staffed by role; record the worker under its role."
                  : "Record the worker as role worker under one of the team's member names.",
              );
            yield* sql`INSERT INTO factory_members(thread_id,manager_id,assignment_id,role,
                member_name,parent_thread_id,joined,off_pool,model_selection_json,created_at)
                VALUES(${input.threadId},${row.manager_id},${row.id},${input.role},
                ${named?.name ?? null},${leadThreadId},
                ${input.joined},0,${encodeModel(input.modelSelection)},${yield* now})
                ON CONFLICT(thread_id) DO UPDATE SET role=excluded.role,
                member_name=excluded.member_name,joined=excluded.joined,
                off_pool=0,model_selection_json=excluded.model_selection_json
                WHERE factory_members.assignment_id=excluded.assignment_id`;
            const rows = yield* sql<MemberRow>`SELECT * FROM factory_members
                WHERE thread_id=${input.threadId}`;
            if (rows[0]?.assignment_id !== row.id)
              return yield* error("conflict", "That thread already belongs to another team.");
            releasePlace(
              row.id,
              named === undefined
                ? { kind: "role", role: input.role }
                : { kind: "member", name: named.name },
              input.threadId,
            );
            return yield* decodeMember(rows[0]);
          }),
        );
        yield* publish;
        return member;
      }),
    );

  const observeThread: FactoryServiceShape["observeThread"] = (thread) =>
    protect(
      Effect.gen(function* () {
        const parentThreadId = thread.parentThreadId;
        if (parentThreadId === null) return;
        const joined = yield* lock(
          Effect.gen(function* () {
            const parents = yield* sql<
              MemberRow & { title: string; project_id: string }
            >`SELECT m.*, a.title, a.project_id FROM factory_members m
                JOIN factory_assignments a ON a.id=m.assignment_id
                WHERE m.thread_id=${parentThreadId} AND m.ended_at IS NULL
                AND ${sql.in("a.state", ACTIVE_ASSIGNMENT_STATES)}`;
            const parent = parents[0];
            if (!parent) return false;
            const existing = yield* sql<{ thread_id: string }>`SELECT thread_id FROM factory_members
                WHERE thread_id=${thread.threadId}`;
            if (existing[0]) return false;
            // A sub-agent belongs to its parent: it takes the parent's role and member name, never
            // a place, and is not checked against the pool, since sub-agents act through their
            // parent and never with the factory itself.
            yield* sql`INSERT INTO factory_members(thread_id,manager_id,assignment_id,role,
                member_name,parent_thread_id,joined,off_pool,model_selection_json,created_at)
                VALUES(${thread.threadId},${parent.manager_id},${parent.assignment_id},
                ${parent.role},${parent.member_name},${parentThreadId},'observed',0,
                ${encodeModel(thread.modelSelection)},${yield* now})`;
            return true;
          }),
        );
        if (joined) yield* publish;
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not observe a thread for the factory", {
          threadId: thread.threadId,
          cause: cause.message,
        }),
      ),
    );

  const updateChecklist: FactoryServiceShape["updateChecklist"] = (leadThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const id = yield* lock(
          Effect.gen(function* () {
            const row = yield* requireLead(leadThreadId);
            yield* sql`UPDATE factory_assignments SET checklist_json=${json(input.steps)},
                updated_at=${yield* now} WHERE id=${row.id}`;
            return row.id;
          }),
        );
        yield* publish;
        return yield* readAssignment(id);
      }),
    );

  const createTeam: FactoryServiceShape["createTeam"] = (managerThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* requireManager(managerThreadId);
        const problem = managerStateProblem(manager);
        if (problem !== null) return yield* error("conflict", problem);
        return yield* lock(
          Effect.gen(function* () {
            const view = yield* deps.configStore.read;
            if (view.teams.some((team) => team.name === input.name))
              return yield* error("conflict", `A team named "${input.name}" already exists.`);
            const built = teamFromDefinitions(input, view);
            if ("problem" in built) return yield* error("invalid", built.problem);
            yield* deps.configStore.writeTeam(built.team);
            yield* writeLog(manager.id, null, "team", input.name, {
              teamId: built.team.id,
              name: input.name,
            });
            return built.team;
          }),
        );
      }),
    );

  const workspaceFeed = Effect.fnUntraced(function* () {
    const managers = yield* currentManagers();
    const members = yield* sql<MemberRow>`SELECT * FROM factory_members
        WHERE ended_at IS NULL ORDER BY created_at, rowid`;
    const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 24 }));
    const assignments = yield* sql<AssignmentRow>`SELECT * FROM factory_assignments
        WHERE ${sql.in("state", ACTIVE_ASSIGNMENT_STATES)} OR ended_at >= ${since}
        ORDER BY created_at, id`;
    const previousLeads = new Map<string, string[]>();
    for (const lead of yield* sql<{ assignment_id: string; thread_id: string }>`
        SELECT m.assignment_id,m.thread_id FROM factory_members m
        JOIN factory_assignments a ON a.id=m.assignment_id
        WHERE m.role='lead' AND m.ended_at IS NOT NULL
          -- Completion ends the current lead's membership too.
          AND m.thread_id IS NOT a.lead_thread_id
          AND (${sql.in("a.state", ACTIVE_ASSIGNMENT_STATES)} OR a.ended_at >= ${since})
        ORDER BY m.created_at, m.rowid`)
      previousLeads.set(lead.assignment_id, [
        ...(previousLeads.get(lead.assignment_id) ?? []),
        lead.thread_id,
      ]);
    return yield* decodeWorkspaceFeed({
      managers: managers.map((manager) => ({
        id: manager.id,
        threadId: manager.threadId,
        projectId: manager.projectId,
        name: manager.name,
        state: manager.state,
        waitingOnYou: manager.waitingOnYou,
      })),
      members: members.map(memberValue),
      assignments: yield* Effect.forEach(assignments, (row) =>
        Effect.gen(function* () {
          const asks = yield* parse(ProtectedPathAsks, row.protected_path_asks_json);
          return {
            id: row.id,
            managerId: row.manager_id,
            title: row.title,
            state: row.state,
            source: row.source,
            complexity: row.complexity,
            team: yield* parse(FactoryTeamSpec, row.team_json).pipe(
              // A factory team's preset is its id; the feed shows its name.
              Effect.map((team) => team.definition?.name ?? team.preset),
            ),
            leadThreadId: row.lead_thread_id,
            checklist: yield* parse(Schema.Unknown, row.checklist_json),
            waitingReason: row.waiting_reason,
            claimedAt:
              row.claim_json === null
                ? null
                : (yield* parse(FactoryAssignmentClaim, row.claim_json)).claimedAt,
            controlViolations: effectiveViolations(
              yield* parse(ControlViolations, row.control_violations_json),
              asks,
            ),
            protectedPathAsks: asks,
            previousLeadThreadIds: previousLeads.get(row.id) ?? [],
          };
        }),
      ),
    }).pipe(Effect.mapError(storageError));
  });

  const subscribeWorkspace: FactoryServiceShape["subscribeWorkspace"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.make(yield* workspaceFeed()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => workspaceFeed())),
        );
      }).pipe(Effect.mapError(preserveError)),
    ).pipe(
      Stream.mapError(preserveError),
      Stream.changesWith((left, right) => json(left) === json(right)),
      Stream.scoped,
    );

  /** The live assignment this member thread works on, as lead or worker. */
  const requireMember = Effect.fnUntraced(function* (threadId: ThreadId) {
    const rows = yield* sql<LeadAssignmentRow>`SELECT a.*, ${LEAD_TAKEN_OVER}
        FROM factory_members m JOIN factory_assignments a ON a.id=m.assignment_id
        WHERE m.thread_id=${threadId} AND m.ended_at IS NULL
        AND ${sql.in("a.state", ACTIVE_ASSIGNMENT_STATES)}`;
    const row = rows[0];
    if (!row)
      return yield* error("not-found", "This thread is not a member of a live factory team.");
    if (row.lead_taken_over === 1)
      return yield* error("conflict", "The user has taken over this team's lead.");
    return row;
  });

  const decodeFinding = (row: FindingRow) =>
    decodeFindingValue({
      id: row.id,
      assignmentId: row.assignment_id,
      threadId: row.thread_id,
      class: row.class,
      summary: row.summary,
      evidence: row.evidence,
      uncertainty: row.uncertainty,
      workaround: row.workaround,
      escalated: row.escalated === 1,
      draftId: row.draft_id,
      createdAt: row.created_at,
    }).pipe(Effect.mapError(storageError));

  const recordFinding: FactoryServiceShape["recordFinding"] = (memberThreadId, input) =>
    lock(
      Effect.gen(function* () {
        const row = yield* requireMember(memberThreadId);
        const id = NodeCrypto.randomUUID();
        const escalated = input.escalate === true;
        yield* sql`INSERT INTO factory_findings(id,assignment_id,manager_id,thread_id,class,
            summary,evidence,uncertainty,workaround,escalated,created_at)
            VALUES(${id},${row.id},${row.manager_id},${memberThreadId},${input.class},
            ${input.summary},${input.evidence},${input.uncertainty ?? null},
            ${input.workaround ?? null},${escalated ? 1 : 0},${yield* now})`;
        yield* writeLog(row.manager_id, row.id, "finding", input.summary, {
          findingId: id,
          class: input.class,
          escalated,
        });
        if (escalated)
          yield* writeWake(row, "finding", {
            assignmentId: row.id,
            title: row.title,
            findingId: id,
            summary: input.summary,
          });
        const rows = yield* sql<FindingRow>`SELECT * FROM factory_findings WHERE id=${id}`;
        return yield* decodeFinding(rows[0]!);
      }),
    );

  const listFindings: FactoryServiceShape["listFindings"] = (input) =>
    protect(
      Effect.gen(function* () {
        const rows = yield* sql<FindingRow>`SELECT * FROM factory_findings
            WHERE assignment_id=${input.assignmentId} ORDER BY created_at, rowid`;
        return yield* Effect.forEach(rows, decodeFinding);
      }),
    );

  const retroDone: FactoryServiceShape["retroDone"] = (leadThreadId) =>
    protect(
      Effect.gen(function* () {
        const id = yield* lock(
          Effect.gen(function* () {
            const row = yield* requireLead(leadThreadId);
            if (row.state !== "retro")
              return yield* error(
                "conflict",
                `${row.title} is ${row.state}; the team retro starts once its pull requests are merged or the user cancels it.`,
              );
            if (row.team_retro_at !== null)
              return yield* error("conflict", "The team retro is already done.");
            const at = yield* now;
            yield* sql`UPDATE factory_assignments SET team_retro_at=${at},updated_at=${at}
                WHERE id=${row.id}`;
            yield* writeLog(row.manager_id, row.id, "retro", "team", null);
            yield* writeWake(row, "manager-retro", {
              assignmentId: row.id,
              title: row.title,
              cancelled: row.cancel_reason !== null,
            });
            return row.id;
          }),
        );
        yield* publish;
        return yield* readAssignment(id);
      }),
    );

  const decodeDraft = Effect.fnUntraced(function* (row: DraftRow) {
    return yield* decodeDraftValue({
      id: row.id,
      managerId: row.manager_id,
      projectId: row.project_id,
      assignmentId: row.assignment_id,
      scope: row.scope,
      title: row.title,
      body: row.body,
      acceptanceCriteria: yield* parse(Schema.Unknown, row.acceptance_json),
      findingIds: yield* parse(Schema.Unknown, row.finding_ids_json),
      state: row.state,
      issue: row.issue_json === null ? null : yield* parse(Schema.Unknown, row.issue_json),
      proposedChange:
        row.proposed_change_json === null
          ? null
          : yield* parse(Schema.Unknown, row.proposed_change_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }).pipe(Effect.mapError(storageError));
  });
  const draftRow = Effect.fnUntraced(function* (id: string) {
    const rows = yield* sql<DraftRow>`SELECT * FROM factory_ticket_drafts WHERE id=${id}`;
    if (!rows[0]) return yield* error("not-found", "This draft no longer exists.");
    return rows[0];
  });
  const readDraft = (id: string) => draftRow(id).pipe(Effect.flatMap(decodeDraft));

  /**
   * Pending and approved drafts of the project, and open tickets on its boards' stored copies,
   * whose titles overlap the draft's. The draft is already saved, so an unreadable board is skipped.
   */
  const similarTo = Effect.fnUntraced(function* (draft: FactoryTicketDraft) {
    const words = titleWords(draft.title);
    const found: Array<{ readonly overlap: number; readonly ticket: FactorySimilarTicket }> = [];
    const consider = (title: string, ticket: FactorySimilarTicket) => {
      const overlap = titleOverlap(words, titleWords(title));
      if (overlap >= SIMILAR_OVERLAP) found.push({ overlap, ticket });
    };
    const drafts = yield* sql<DraftRow>`SELECT * FROM factory_ticket_drafts
        WHERE project_id=${draft.projectId} AND id != ${draft.id}
        AND state IN ('pending','approved') ORDER BY created_at, rowid`;
    for (const row of drafts)
      consider(row.title, {
        kind: "draft",
        id: row.id,
        title: row.title,
        url: Option.getOrNull(Option.map(decodeIssueRef(row.issue_json), (issue) => issue.url)),
      });
    const boards = yield* deps.readBoards(draft.projectId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not list boards for similar tickets", {
          cause: cause.message,
        }).pipe(Effect.as([])),
      ),
    );
    const seen = new Set<string>();
    for (const summary of boards) {
      const view = yield* deps.readBoard(draft.projectId, summary.id).pipe(Effect.result);
      if (view._tag === "Failure") {
        yield* Effect.logWarning("Could not read a board for similar tickets", {
          boardId: summary.id,
          cause: view.failure.message,
        });
        continue;
      }
      const completed = (view.success.board.mapping ?? summary.mapping)?.completed ?? null;
      for (const item of view.success.items) {
        const key = canonicalIssueKey(item.issue.ref);
        if (seen.has(key)) continue;
        seen.add(key);
        if (
          (completed !== null && item.columnId === completed) ||
          CLOSED_ISSUE_STATES.has(item.issue.state.toLowerCase())
        )
          continue;
        consider(item.issue.title, {
          kind: "ticket",
          id: item.issue.ref.id,
          title: item.issue.title,
          url: item.issue.ref.url,
        });
      }
    }
    return found
      .toSorted((left, right) => right.overlap - left.overlap)
      .slice(0, SIMILAR_LIMIT)
      .map((entry) => entry.ticket);
  });

  const draftTicket: FactoryServiceShape["draftTicket"] = (managerThreadId, input) =>
    protect(
      Effect.gen(function* () {
        const manager = yield* requireManager(managerThreadId);
        // Drafting only records a proposal for the user, so a paused manager may finish its retro
        // and an onboarding one may draft a ticket from a finding the user asked about.
        const problem =
          isPaused(manager.state) || manager.state === "onboarding"
            ? null
            : managerStateProblem(manager);
        if (problem !== null) return yield* error("conflict", problem);
        if (
          input.proposedChange?.kind === "setting" &&
          input.proposedChange.key === "pickupGuidance"
        )
          return yield* error("invalid", PICKUP_GUIDANCE_MOVED);
        const findingIds = [...new Set(input.findingIds ?? [])];
        const id = yield* lock(
          Effect.gen(function* () {
            if (findingIds.length > 0) {
              const owned = yield* sql<{ id: string }>`SELECT id FROM factory_findings
                  WHERE manager_id=${manager.id} AND ${sql.in("id", findingIds)}`;
              const ownedIds = new Set(owned.map((row) => row.id));
              const stranger = findingIds.find((findingId) => !ownedIds.has(findingId));
              if (stranger !== undefined)
                return yield* error("invalid", `No finding ${stranger} belongs to your teams.`);
            }
            const retro = yield* sql<{ id: string }>`SELECT id FROM factory_assignments
                WHERE manager_id=${manager.id} AND state='retro'
                ORDER BY updated_at DESC, created_at DESC, id LIMIT 1`;
            const assignmentId = retro[0]?.id ?? null;
            const draftId = NodeCrypto.randomUUID();
            const at = yield* now;
            yield* sql`INSERT INTO factory_ticket_drafts(id,manager_id,project_id,assignment_id,
                scope,title,body,acceptance_json,finding_ids_json,state,proposed_change_json,marker,
                created_at,updated_at)
                VALUES(${draftId},${manager.id},${manager.projectId},${assignmentId},${input.scope},
                ${input.title},${input.body},${json(input.acceptanceCriteria)},${json(findingIds)},
                'pending',${input.proposedChange === undefined ? null : json(input.proposedChange)},
                ${`satellite-factory-draft:${draftId}`},${at},${at})`;
            if (findingIds.length > 0)
              yield* sql`UPDATE factory_findings SET draft_id=${draftId}
                  WHERE ${sql.in("id", findingIds)}`;
            yield* writeLog(manager.id, assignmentId, "draft", input.title, {
              draftId,
              scope: input.scope,
              findingIds,
            });
            return draftId;
          }),
        );
        yield* publishDrafts;
        const draft = yield* readDraft(id);
        return { draft, similar: yield* similarTo(draft) } satisfies FactoryDraftTicketResult;
      }),
    );

  const listDrafts: FactoryServiceShape["listDrafts"] = (input) =>
    protect(
      Effect.gen(function* () {
        const rows = yield* sql<DraftRow>`SELECT * FROM factory_ticket_drafts
            WHERE (${input.projectId ?? null} IS NULL OR project_id=${input.projectId ?? null})
            AND (${input.managerId ?? null} IS NULL OR manager_id=${input.managerId ?? null})
            AND (${input.state ?? null} IS NULL OR state=${input.state ?? null})
            ORDER BY created_at, rowid`;
        return yield* Effect.forEach(rows, decodeDraft);
      }),
    );

  const draftsEvent = Effect.fnUntraced(function* () {
    const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 7 }));
    const rows = yield* sql<DraftRow>`SELECT * FROM factory_ticket_drafts
        WHERE state='pending' OR updated_at >= ${since} ORDER BY created_at, rowid`;
    return { drafts: yield* Effect.forEach(rows, decodeDraft) } satisfies FactoryDraftsEvent;
  });

  const subscribeDrafts: FactoryServiceShape["subscribeDrafts"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(draftChanges);
        return Stream.concat(
          Stream.make(yield* draftsEvent()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => draftsEvent())),
        );
      }).pipe(Effect.mapError(preserveError)),
    ).pipe(
      Stream.mapError(preserveError),
      Stream.changesWith((left, right) => json(left) === json(right)),
      Stream.scoped,
    );

  /**
   * Replays the request, else applies the change to the draft and remembers the result. The
   * operation is part of the hashed payload, since every draft request has the same shape.
   */
  const changeDraft = <E, R>(
    operation: string,
    input: { readonly requestId: string; readonly draftId: string },
    change: (row: DraftRow, at: string) => Effect.Effect<void, E, R>,
  ) =>
    protect(
      Effect.gen(function* () {
        const payload = { ...input, operation };
        const result = yield* lock(
          Effect.gen(function* () {
            const replay = yield* requestReplay(input.requestId, payload);
            if (replay !== null)
              return { draft: yield* parse(FactoryTicketDraft, replay), changed: false };
            const row = yield* draftRow(input.draftId);
            yield* change(row, yield* now);
            const draft = yield* readDraft(row.id);
            yield* remember(input.requestId, payload, draft);
            return { draft, changed: true };
          }),
        );
        if (result.changed) yield* publishDrafts;
        return result.draft;
      }),
    );

  const moveDraft = (
    operation: "dismiss" | "restore",
    input: { readonly requestId: string; readonly draftId: string },
    from: FactoryTicketDraft["state"],
    to: FactoryTicketDraft["state"],
  ) =>
    changeDraft(operation, input, (row, at) =>
      Effect.gen(function* () {
        if (row.state !== from)
          return yield* error(
            "conflict",
            `This draft is ${row.state}; only a ${from} draft can be ${operation === "dismiss" ? "dismissed" : "restored"}.`,
          );
        yield* sql`UPDATE factory_ticket_drafts SET state=${to},updated_at=${at}
            WHERE id=${row.id}`;
      }),
    );

  const editDraft: FactoryServiceShape["editDraft"] = (input) =>
    changeDraft("edit", input, (row, at) =>
      Effect.gen(function* () {
        if (row.state !== "pending")
          return yield* error(
            "conflict",
            `This draft is ${row.state}; only a pending draft can be edited.`,
          );
        yield* sql`UPDATE factory_ticket_drafts SET title=${input.title ?? row.title},
            body=${input.body ?? row.body},
            acceptance_json=${
              input.acceptanceCriteria === undefined
                ? row.acceptance_json
                : json(input.acceptanceCriteria)
            },updated_at=${at} WHERE id=${row.id}`;
      }),
    );

  const dismissDraft: FactoryServiceShape["dismissDraft"] = (input) =>
    moveDraft("dismiss", input, "pending", "dismissed");
  const restoreDraft: FactoryServiceShape["restoreDraft"] = (input) =>
    moveDraft("restore", input, "dismissed", "pending");

  // A rollback cannot unwrite a definition file, so a disconnect must not stop the apply between
  // its file write and its commit: the retry would find the definition and refuse it as a duplicate.
  const applyDraft: FactoryServiceShape["applyDraft"] = (input) =>
    changeDraft("apply", input, (row, at) =>
      Effect.gen(function* () {
        if (row.scope !== "factory" || row.proposed_change_json === null)
          return yield* error("invalid", "This draft proposes no factory change to apply.");
        if (row.state !== "pending")
          return yield* error(
            "conflict",
            `This draft is ${row.state}; only a pending draft can be applied.`,
          );
        const change = yield* parse(FactoryProposedChange, row.proposed_change_json);
        if (change.kind === "team" || change.kind === "definition") {
          const applied = applyDefinitionChange(yield* deps.configStore.read, change);
          if ("refused" in applied) return yield* applied.refused;
          const { write } = applied;
          switch (write.kind) {
            case "team":
              yield* deps.configStore.writeTeam(write.definition);
              break;
            case "worker":
              yield* deps.configStore.writeWorker(write.definition);
              break;
            case "lead":
              yield* deps.configStore.writeLead(write.definition);
              break;
            case "manager":
              yield* deps.configStore.writeManager(write.definition);
              break;
          }
        } else {
          const applied = applyProposedChange((yield* environmentConfig()).config, change);
          if ("refused" in applied) return yield* applied.refused;
          yield* saveEnvironmentConfig(applied.config);
        }
        yield* sql`UPDATE factory_ticket_drafts SET state='approved',updated_at=${at}
            WHERE id=${row.id}`;
        yield* writeLog(row.manager_id, row.assignment_id, "ticket", "factory change applied", {
          draftId: row.id,
          change,
        });
      }),
    ).pipe(Effect.uninterruptible);

  /**
   * A factory draft is accepted in one step. A project draft files its ticket outside the lock;
   * a failed filing leaves it pending with no request remembered, so the user can approve again.
   */
  const approveDraft: FactoryServiceShape["approveDraft"] = (input) =>
    protect(
      Effect.gen(function* () {
        const payload = { ...input, operation: "approve" };
        const prepared = yield* lock(
          Effect.gen(function* () {
            const replay = yield* requestReplay(input.requestId, payload);
            if (replay !== null)
              return { done: yield* parse(FactoryTicketDraft, replay), changed: false } as const;
            const row = yield* draftRow(input.draftId);
            if (row.state !== "pending")
              return yield* error(
                "conflict",
                `This draft is ${row.state}; only a pending draft can be approved.`,
              );
            if (row.scope === "project") return { row } as const;
            const at = yield* now;
            yield* sql`UPDATE factory_ticket_drafts SET state='approved',updated_at=${at}
                WHERE id=${row.id}`;
            yield* writeLog(row.manager_id, row.assignment_id, "ticket", "factory draft accepted", {
              draftId: row.id,
            });
            const draft = yield* readDraft(row.id);
            yield* remember(input.requestId, payload, draft);
            return { done: draft, changed: true } as const;
          }),
        );
        if ("done" in prepared) {
          // An applied factory change may set the environment cap the managers feed carries.
          if (prepared.changed) yield* Effect.andThen(publishDrafts, publish);
          return prepared.done;
        }
        const { row } = prepared;
        const projectId = ProjectId.make(row.project_id);
        const board = (yield* deps.readBoards(projectId)).find(
          (summary) => summary.mapping !== null,
        );
        if (board === undefined)
          return yield* error("unavailable", "Connect an issue board with a Ready column first.");
        const shell = yield* project(projectId);
        const assignment =
          row.assignment_id === null
            ? []
            : yield* sql<{ title: string }>`SELECT title FROM factory_assignments
                WHERE id=${row.assignment_id}`;
        const issue = yield* deps.createTicket({
          projectId,
          cwd: shell.workspaceRoot,
          board,
          marker: row.marker,
          title: row.title,
          body: ticketBody(
            row.body,
            yield* parse(Schema.Array(Schema.String), row.acceptance_json),
            assignment[0]?.title ?? null,
          ),
        });
        const draft = yield* lock(
          Effect.gen(function* () {
            const replay = yield* requestReplay(input.requestId, payload);
            if (replay !== null) return yield* parse(FactoryTicketDraft, replay);
            // The ticket exists now whatever happened to the draft meanwhile, so it reads approved.
            const current = yield* draftRow(row.id);
            const at = yield* now;
            yield* sql`UPDATE factory_ticket_drafts SET state='approved',issue_json=${json(issue)},
                updated_at=${at} WHERE id=${row.id}`;
            if (current.state !== "approved")
              yield* writeLog(row.manager_id, row.assignment_id, "ticket", row.title, {
                draftId: row.id,
                issue,
              });
            const approved = yield* readDraft(row.id);
            yield* remember(input.requestId, payload, approved);
            return approved;
          }),
        );
        yield* publishDrafts;
        return draft;
      }),
    );

  return {
    getConfig,
    updateConfig,
    listManagers,
    subscribeManagers,
    createManager,
    adoptManagerDefinitions,
    pauseManager,
    resumeManager,
    retireManager,
    proposeOnboarding,
    approveOnboarding,
    startPickup,
    updateSettings,
    managerForThread,
    finishedOnboardingMessage,
    roleBrief,
    status,
    pickup,
    commission,
    listAssignments,
    subscribeAssignments,
    listLog,
    assignmentForThread,
    claimComplete,
    reportDependency,
    askManager,
    recover,
    amendAssignment,
    complete,
    cancel,
    answerProtectedPaths,
    takeOver,
    handBack,
    reconcileThread,
    reconcileMerge,
    sweep,
    planDelegation,
    recordMember,
    observeThread,
    updateChecklist,
    createTeam,
    subscribeWorkspace,
    recordFinding,
    listFindings,
    retroDone,
    draftTicket,
    listDrafts,
    subscribeDrafts,
    editDraft,
    approveDraft,
    dismissDraft,
    restoreDraft,
    applyDraft,
    getStats,
  } satisfies FactoryServiceShape;
});

const fromIssueError = (cause: IssueOperationError) =>
  error(
    cause.reason === "invalid" || cause.reason === "conflict" || cause.reason === "not-found"
      ? cause.reason
      : "unavailable",
    cause.message,
  );

const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ document: Schema.Unknown })),
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
  const pullRequests = yield* PullRequestService.PullRequestService;
  const ticketHost = yield* FactoryTicketHost.FactoryTicketHost;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const configStore = yield* FactoryConfigStore;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
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
          workspaceStrategy: input.workspace,
          initialMessage: {
            text: input.text,
            attachments: [],
            ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
          },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.mapError((cause) =>
            error("unavailable", `The thread could not be launched: ${cause.message}`),
          ),
          Effect.asVoid,
        ),
    readRoleSkill: (role) => Effect.succeed(roleSkillSource(role)),
    configStore,
    // Instance preferences live in the environment's config, so the service warns about ambiguity.
    readModelCatalog: providerRegistry.getProviders.pipe(Effect.map(factoryModelCatalog)),
    readBoards: (projectId) =>
      issues.listBoards({ projectId, connectedOnly: true }).pipe(Effect.mapError(fromIssueError)),
    // Serves the stored copy; one older than 30 seconds also queues a background refresh, which
    // is how a board nobody has open still shows the factory new Ready tickets.
    readBoard: (projectId, boardId) =>
      issues.openBoard({ projectId, boardId }).pipe(Effect.mapError(fromIssueError)),
    startAttempt: (input) => issues.startAttempt(input).pipe(Effect.mapError(fromIssueError)),
    readThreadRuns: (threadId) =>
      orchestrator.getThreadRecords(threadId, ["runs", "runtimeRequests"]).pipe(
        Effect.map(({ thread, runs, runtimeRequests }) => ({
          deleted: thread.deletedAt !== null,
          latestRunStatus:
            runs.reduce<(typeof runs)[number] | undefined>(
              (latest, run) =>
                latest === undefined || run.ordinal > latest.ordinal ? run : latest,
              undefined,
            )?.status ?? null,
          runInProgress: runs.some((run) => RUNS_IN_PROGRESS.has(run.status)),
          pendingRequests: runtimeRequests.filter((request) => request.status === "pending").length,
          pullRequests: threadPullRequestsOf(thread)
            .filter((link) => link.source !== "stack-dismissed")
            .map((link) => ({
              host: link.host,
              repository: link.repository,
              number: link.number,
              state: link.snapshot?.state ?? null,
              merged: link.snapshot?.state === "merged" || link.snapshot?.mergedAt != null,
              // A host with no updatedAt is checked again on every sync rather than never.
              updatedAt: link.snapshot?.updatedAt ?? link.snapshot?.syncedAt ?? null,
              mergeability: link.snapshot?.mergeability ?? null,
            })),
          worktreePath: thread.worktreePath,
        })),
        Effect.catchCause((cause) =>
          Effect.logDebug("factory lead thread unavailable", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
    readThreadTurns: (threadId) =>
      orchestrator.getThreadRecords(threadId, ["providerTurns", "attempts", "runs"]).pipe(
        Effect.map(({ providerTurns, attempts, runs }) => {
          const runsById = new Map(runs.map((run) => [run.id, run]));
          const runOfAttempt = new Map(
            attempts.map((attempt) => [attempt.id, runsById.get(attempt.runId)]),
          );
          return providerTurns.map((turn) => {
            const run =
              (turn.runAttemptId === null ? undefined : runOfAttempt.get(turn.runAttemptId)) ??
              runs.findLast((candidate) => candidate.providerThreadId === turn.providerThreadId);
            const usage = turn.turnTokenUsage;
            return {
              model: run?.modelSelection.model ?? "unknown",
              instanceId: run?.modelSelection.instanceId ?? "unknown",
              startedAt: turn.startedAt === null ? null : DateTime.formatIso(turn.startedAt),
              completedAt: turn.completedAt === null ? null : DateTime.formatIso(turn.completedAt),
              tokens:
                usage === undefined || usage.usageStatus === "unavailable"
                  ? null
                  : {
                      input: usage.inputTokens ?? 0,
                      cachedInput: usage.cachedInputTokens ?? 0,
                      output: usage.outputTokens ?? 0,
                    },
            };
          });
        }),
        Effect.catchCause((cause) =>
          Effect.logDebug("factory member turns unavailable", { threadId, cause }).pipe(
            Effect.as([]),
          ),
        ),
      ),
    // UsageService owns fetching the rates; the factory only reads the copy it caches.
    readRateTable: fs.readFileString(path.join(stateDir, "usage-model-rates.json")).pipe(
      Effect.flatMap(decodeRatesCache),
      Effect.map(({ document }) => {
        const table = parseRateTable(document);
        return table.size > 0 ? table : null;
      }),
      Effect.catchCause((cause) =>
        Effect.logDebug("factory stats have no usage rate table", { cause }).pipe(Effect.as(null)),
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
    settleThread: (input) =>
      threads.settleThread({ ...input, byOwnAgent: false }).pipe(
        Effect.mapError(() =>
          error("unavailable", "The manager's onboarding thread could not be settled."),
        ),
        Effect.asVoid,
      ),
    interruptThread: (input) =>
      threads
        .interruptThread({
          projectId: input.projectId,
          commandId: input.commandId,
          threadId: input.threadId,
          reason: input.reason,
        })
        .pipe(
          Effect.mapError((cause) =>
            error("unavailable", `The lead could not be interrupted: ${cause.message}`),
          ),
          Effect.asVoid,
        ),
    // Same source GitManager falls back to: the primary remote's HEAD symbolic ref.
    readDefaultBranch: (cwd) =>
      git.resolvePrimaryRemoteName(cwd).pipe(
        Effect.flatMap((remote) => git.resolveDefaultBranchName(cwd, remote)),
        Effect.orElseSucceed(() => null),
      ),
    readPullRequestFiles: Effect.fn("FactoryService.readPullRequestFiles")(
      function* (input) {
        const paths = new Set<string>();
        let cursor: string | null = null;
        do {
          const page: PullRequestDiffResult = yield* pullRequests.diff({
            projectId: input.projectId,
            host: input.host,
            repository: input.repository,
            number: input.number,
            ...(cursor === null ? {} : { cursor }),
          });
          // Both names of a rename count: moving a protected file away changes it too.
          for (const file of parseDiffFilePaths(page.patch))
            for (const path of [file.oldPath, file.newPath]) if (path !== null) paths.add(path);
          for (const stat of page.omittedFileStats ?? []) paths.add(stat.path);
          cursor = page.nextCursor;
        } while (cursor !== null);
        return [...paths];
      },
      Effect.mapError((cause) =>
        error("unavailable", `The pull request's files could not be read: ${cause.message}`),
      ),
    ),
    readPullRequestHead: readPullRequestHeadLive(pullRequests),
    createTicket: (input) => ticketHost.create(input),
  });
});

export const layer = Layer.effect(FactoryService, make);

export const readPullRequestHeadLive =
  (
    pullRequests: Pick<PullRequestService.PullRequestService["Service"], "invalidate" | "detail">,
  ): FactoryServiceDependencies["readPullRequestHead"] =>
  (input) => {
    const reference = {
      projectId: input.projectId,
      host: input.host,
      repository: input.repository,
      number: input.number,
    };
    // A cached detail can predate the lead's last push, and the manager checks this head.
    return pullRequests.invalidate({ reference }).pipe(
      Effect.andThen(pullRequests.detail({ ...reference, allowStale: false })),
      Effect.map((detail) => detail.headSha ?? null),
      Effect.catch((cause) =>
        Effect.logDebug("Could not read a factory pull request's head", {
          repository: input.repository,
          number: input.number,
          cause: cause.message,
        }).pipe(Effect.as(null)),
      ),
    );
  };
