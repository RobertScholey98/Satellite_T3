import {
  FactoryError,
  type FactoryAssignmentId,
  type FactoryCommandResult,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryScheduleCandidate,
  type FactoryScheduleObservation,
  type FactorySchedulePreparation,
  type FactoryScheduleSource,
  type FactoryScheduleAuthority,
  type FactorySchedulingAdmission,
  type FactorySnapshot,
  type FactorySupportingWork,
  type IssueRef,
  type ProjectId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";
import { factoryExecutionBlocked } from "./FactoryControls.ts";
import { factoryPathWithin, factoryRelativePath } from "./FactoryBoundaryPaths.ts";
import { resolveManagerPolicy } from "./FactoryPolicy.ts";
import type { FactoryActor, FactoryDecision } from "./FactoryState.ts";

/** Host facts for scheduling decisions, resolved by `FactorySchedulingEffects.context`. */
export interface FactorySchedulingContext {
  /** The tracker reservation for an `assignment.commission` that names a candidate. */
  readonly schedulingAdmission?: FactorySchedulingAdmission;
  /** Set when the host qualified the board for `project.scheduling.configure`. */
  readonly schedulingBoardVerified?: { readonly projectId: ProjectId; readonly boardId: string };
  /** The host's fresh board read for `schedule.track`. */
  readonly schedulingObservation?: {
    readonly projectId: ProjectId;
    readonly configurationId: string;
    readonly issue: IssueRef;
    readonly source: FactoryScheduleSource;
    readonly observation: FactoryScheduleObservation;
  };
}
const hash = (value: unknown) =>
  Hex.encode(sha256(new TextEncoder().encode(stableStringify(value))));
/**
 * Identifies one ticket across observations and generations. Azure DevOps work items are not
 * repository-scoped, so their key keeps only the first repository segment.
 */
export const factoryScheduleIssueKey = (ref: IssueRef) =>
  ref.hostKind === "azure-devops"
    ? `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.split("/")[0]!.toLowerCase()}:${ref.id}`
    : `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.toLowerCase()}:${ref.id}`;
/** Each generation of a ticket is its own candidate; the human's reopen starts the next one. */
export const factoryScheduleCandidateId = (canonicalIssueKey: string, generation: number) =>
  `schedule:${hash(canonicalIssueKey)}:${generation}`;
/** Fingerprints the scope a commission must match exactly against the manager's preparation. */
export const factoryScheduleWorkDigest = (work: FactorySupportingWork) =>
  hash({
    title: work.title,
    kind: work.kind,
    scope: work.scope,
    complexity: work.complexity,
    sourcePaths: work.sourcePaths,
    creatableDirectories: work.creatableDirectories,
    controlPaths: work.controlPaths ?? [],
    modelSelection: work.modelSelection ?? null,
  });
export const factorySchedulePreparation = (
  candidate: FactoryScheduleCandidate,
): FactorySchedulePreparation | null =>
  candidate.lifecycle.phase === "observed" ? null : candidate.lifecycle.preparation;
/**
 * What the manager has been told about a candidate. Observation time and board revision are
 * left out, so a board refresh with no material change does not notify the manager again.
 */
export const factoryScheduleNotificationDigest = (candidate: FactoryScheduleCandidate) =>
  hash({
    configurationId: candidate.configurationId,
    source: candidate.source,
    observation: { ...candidate.observation, observedAt: undefined, boardRevision: undefined },
    lifecycle: candidate.lifecycle,
  });
export const factorySchedulingConfiguration = (state: FactorySnapshot, projectId: ProjectId) =>
  state.schedulingConfigurations.findLast((entry) => entry.projectId === projectId);
const fail = (detail: string, code: FactoryError["code"] = "permission-denied") =>
  Result.fail(new FactoryError({ code, detail }));

export interface AuthorityOptions {
  /**
   * Rechecks an assignment already commissioned from the candidate, before its launch. The
   * assignment does not count against itself, and a newer enabled configuration on the same
   * board does not by itself revoke it.
   */
  readonly existingAssignmentId?: FactoryAssignmentId;
  /** The authority the work was admitted under; it must still be the one that applies. */
  readonly requiredAuthority?: FactoryScheduleAuthority;
}
/** Why a candidate cannot be commissioned now. Empty when it can. */
function eligibilityReasons(
  state: FactorySnapshot,
  candidate: FactoryScheduleCandidate,
  options: AuthorityOptions = {},
): readonly string[] {
  const config = factorySchedulingConfiguration(state, candidate.projectId);
  if (
    !config?.enabled ||
    (!options.existingAssignmentId && config.id !== candidate.configurationId)
  )
    return ["Scheduling is disabled or its configuration changed."];
  if (
    options.requiredAuthority?.kind === "project-improvement" &&
    candidate.source.kind !== "project-improvement"
  )
    return ["The original improvement authority does not belong to this ticket."];
  if (
    (candidate.lifecycle.phase === "commissioned" &&
      candidate.lifecycle.assignmentId !== options.existingAssignmentId) ||
    candidate.lifecycle.phase === "dismissed"
  )
    return ["This issue generation has already been consumed."];
  // A ticket the tracker no longer offers must not keep outranking the rest of the queue.
  if (candidate.lifecycle.phase === "held" && candidate.lifecycle.origin === "tracker")
    return [candidate.lifecycle.reason];
  if (
    options.existingAssignmentId &&
    !state.assignments.some(
      (entry) =>
        entry.id === options.existingAssignmentId &&
        entry.scheduling?.candidateId === candidate.id &&
        entry.scheduling.issueAttempt.boardId === config.boardId &&
        !entry.outcome &&
        entry.status !== "complete",
    )
  )
    return ["The scheduled assignment is no longer active."];
  if (
    state.scheduleCandidates.some(
      (entry) =>
        entry.canonicalIssueKey === candidate.canonicalIssueKey &&
        entry.generation > candidate.generation,
    )
  )
    return ["A newer explicitly reopened generation owns this ticket."];
  const manager = state.managers.find((entry) => entry.id === candidate.managerId);
  if (
    !manager ||
    manager.role !== "project" ||
    manager.projectId !== candidate.projectId ||
    manager.status !== "active" ||
    factoryExecutionBlocked(state, {
      threadId: manager.threadId,
      managerId: manager.id,
      projectId: candidate.projectId,
      ancestorThreadIds: [],
    }) !== undefined
  )
    return ["The project manager is not available to commission work."];
  const preparation = factorySchedulePreparation(candidate);
  if (!preparation) return ["The manager must prepare the exact work scope first."];
  if (preparation.detailDigest !== candidate.observation.detailDigest)
    return ["The ticket changed after its scope was prepared."];
  if (
    state.assignments.filter(
      (entry) =>
        entry.id !== options.existingAssignmentId &&
        entry.projectId === candidate.projectId &&
        entry.kind !== "onboarding" &&
        !entry.outcome &&
        entry.status !== "complete" &&
        entry.completion?.phase !== "concluded",
    ).length >= config.maxConcurrentAssignments
  )
    return ["The project's concurrent assignment limit has been reached."];
  if (
    preparation.dependencyIds.some((id) => {
      const dependency = state.dependencies.find((entry) => entry.id === id);
      const assignment = state.assignments.find((entry) => entry.id === dependency?.assignmentId);
      return (
        !dependency ||
        dependency.state !== "usable" ||
        assignment?.projectId !== candidate.projectId
      );
    })
  )
    return ["A required project dependency is not usable yet."];
  if (
    state.assignments.some(
      (entry) =>
        entry.id !== options.existingAssignmentId && entry.scheduling?.candidateId === candidate.id,
    )
  )
    return ["This ticket generation already has an assignment."];
  // Direct human assignment replaces readiness; commission checks still apply to the work itself.
  if (options.requiredAuthority?.kind === "human") return [];
  // Tracker readiness never authorizes protected-control changes. Improvement tickets fall
  // through to the project improvement rule when readiness does not cover them.
  const controls = preparation.work.controlPaths ?? [];
  if (
    (candidate.observation.ready &&
      preparation.work.kind !== "rule-change" &&
      !controls.length &&
      options.requiredAuthority?.kind !== "project-improvement") ||
    candidate.source.kind === "tracker-ready" ||
    options.requiredAuthority?.kind === "tracker-ready"
  ) {
    if (!candidate.observation.ready) return ["The ticket is not in a configured Ready column."];
    if (preparation.work.kind === "rule-change" || (preparation.work.controlPaths?.length ?? 0) > 0)
      return [
        "Tracker readiness does not authorize a protected-rule change; authorize a separate task.",
      ];
    return [];
  }
  const policy = resolveManagerPolicy(state.defaults, manager.overrides);
  const rule = config.improvementRule;
  if (policy.projectImprovements !== "project-rule" || !rule)
    return [
      "Project feedback remains in triage until a human moves it out of triage into Ready, assigns it directly, or an approved project rule applies.",
    ];
  const followupId = candidate.source.followupId;
  const followup = state.followups.find(
    (entry) => entry.id === followupId && entry.projectId === candidate.projectId,
  );
  const publication = followup?.publication;
  const issue =
    publication?.status === "linked"
      ? publication.issue
      : publication?.status === "recorded" && publication.receipt.progress.status === "triaged"
        ? publication.receipt.progress.issue
        : undefined;
  if (!followup || !issue || factoryScheduleIssueKey(issue) !== candidate.canonicalIssueKey)
    return ["The improvement needs a verified project triage ticket."];
  if (
    !followup.findingIds.length ||
    followup.findingIds.some((id) => {
      const finding = state.findings.find((entry) => entry.id === id);
      const assignment = state.assignments.find((entry) => entry.id === finding?.assignmentId);
      return (
        !finding ||
        assignment?.projectId !== candidate.projectId ||
        !rule.allowedCauses.some((cause) => cause === finding.route.suspectedCause) ||
        (finding.route.owner.kind !== "implementation-lead" &&
          (finding.route.owner.kind !== "project-manager" ||
            finding.route.owner.projectId !== candidate.projectId))
      );
    })
  )
    return ["The findings fall outside the approved project improvement rule."];
  const work = preparation.work;
  if (
    !rule.allowedComplexities.includes(work.complexity) ||
    work.sourcePaths.some(
      (path) =>
        !rule.allowedSourcePaths.includes(path) &&
        !rule.creatableDirectories.some((directory) => factoryPathWithin(path, directory)),
    ) ||
    work.creatableDirectories.some((directory) => !rule.creatableDirectories.includes(directory))
  )
    return ["The prepared scope exceeds the project improvement rule."];
  if (
    work.kind === "rule-change" &&
    (!policy.authorizeRuleWeakening ||
      !controls.length ||
      controls.some((path) => !rule.protectedPaths.includes(path)))
  )
    return [
      "Rule weakening requires a separate authorized task and the enabled manager permission.",
    ];
  if (work.kind !== "rule-change" && controls.length)
    return ["Protected rules can only change in a separately authorized rule-change task."];
  return [];
}

/**
 * The authority a candidate would be commissioned under now: tracker readiness when the ticket is
 * Ready and the work touches no protected controls, otherwise the project's improvement rule.
 * With `requiredAuthority`, fails unless that same authority still applies. The tracker calls
 * this inside admission and again before launch.
 */
export function factoryScheduleAuthority(
  state: FactorySnapshot,
  candidate: FactoryScheduleCandidate,
  options: AuthorityOptions = {},
): Result.Result<FactoryScheduleAuthority, FactoryError> {
  const reasons = eligibilityReasons(state, candidate, options);
  if (reasons.length) return fail(reasons.join(" "));
  if (options.requiredAuthority?.kind === "human") return Result.succeed(options.requiredAuthority);
  const config = factorySchedulingConfiguration(state, candidate.projectId)!;
  const work = factorySchedulePreparation(candidate)!.work;
  const authority: FactoryScheduleAuthority =
    candidate.observation.ready &&
    work.kind !== "rule-change" &&
    !work.controlPaths?.length &&
    options.requiredAuthority?.kind !== "project-improvement"
      ? {
          kind: "tracker-ready",
          boardId: config.boardId,
          itemId: candidate.observation.itemId,
          observedAt: candidate.observation.observedAt,
        }
      : {
          kind: "project-improvement",
          ruleId: config.improvementRule!.id,
          followupId:
            candidate.source.kind === "project-improvement" ? candidate.source.followupId : "",
        };
  if (
    options.requiredAuthority &&
    (authority.kind !== options.requiredAuthority.kind ||
      (authority.kind === "project-improvement" &&
        (options.requiredAuthority.kind !== "project-improvement" ||
          authority.ruleId !== options.requiredAuthority.ruleId ||
          authority.followupId !== options.requiredAuthority.followupId)))
  )
    return fail("The original scheduling authority no longer applies.");
  return Result.succeed(authority);
}

/** Eligibility plus queue order: a candidate yields to a higher-priority eligible one. */
export function factoryScheduleEligibility(
  state: FactorySnapshot,
  candidate: FactoryScheduleCandidate,
  options: AuthorityOptions = {},
): { readonly eligible: true } | { readonly eligible: false; readonly reasons: readonly string[] } {
  const reasons = eligibilityReasons(state, candidate, options);
  if (reasons.length) return { eligible: false, reasons };
  const priority = factorySchedulePreparation(candidate)!.priority;
  // Priorities are the manager's ordering; a direct human assignment overrides them.
  if (
    options.requiredAuthority?.kind !== "human" &&
    state.scheduleCandidates.some(
      (other) =>
        other.id !== candidate.id &&
        other.projectId === candidate.projectId &&
        (factorySchedulePreparation(other)?.priority ?? -1) > priority &&
        eligibilityReasons(state, other).length === 0,
    )
  )
    return {
      eligible: false,
      reasons: ["A higher-priority prepared ticket is ready for the project's available capacity."],
    };
  return { eligible: true };
}

/**
 * Checks an `assignment.commission` that names a candidate. The host admission must match the
 * current configuration, board, ticket detail and the exact prepared work, and its authority
 * must still apply. A direct human message authorizes one commission only.
 */
export function validateFactorySchedulingCommission(
  state: FactorySnapshot,
  command: Extract<FactoryDecisionCommand, { type: "assignment.commission" }>,
  admission: FactorySchedulingAdmission | undefined,
): Result.Result<FactoryScheduleCandidate, FactoryError> {
  const human = admission?.authority.kind === "human" ? admission.authority : undefined;
  if (
    !command.candidateId ||
    command.dependencyId ||
    (command.authorizationMessageId ?? null) !== (human?.messageId ?? null) ||
    (human && human.commandId !== command.commandId) ||
    !admission ||
    admission.candidateId !== command.candidateId
  )
    return fail(
      "Candidate commissioning requires its own verified admission, without another authority source.",
    );
  const candidate = state.scheduleCandidates.find((entry) => entry.id === command.candidateId);
  if (!candidate || candidate.managerId !== command.managerId)
    return fail("The selected ticket does not belong to this manager.");
  const messageId = human?.messageId;
  if (
    messageId &&
    state.assignments.some(
      (entry) =>
        (entry.authorization?.kind === "manager" && entry.authorization.messageId === messageId) ||
        (entry.scheduling?.authority.kind === "human" &&
          entry.scheduling.authority.messageId === messageId),
    )
  )
    return fail(
      "That human request already authorized a commission. Ask the human before commissioning more work.",
    );
  const eligibility = factoryScheduleEligibility(
    state,
    candidate,
    human ? { requiredAuthority: human } : {},
  );
  if (!eligibility.eligible) return fail(eligibility.reasons.join(" "));
  const config = factorySchedulingConfiguration(state, candidate.projectId)!;
  if (
    admission.configurationId !== config.id ||
    admission.canonicalIssueKey !== candidate.canonicalIssueKey ||
    admission.boardId !== config.boardId ||
    admission.detailDigest !== candidate.observation.detailDigest ||
    admission.workDigest !== factoryScheduleWorkDigest(command) ||
    admission.workDigest !==
      factoryScheduleWorkDigest(factorySchedulePreparation(candidate)!.work) ||
    admission.issueAttempt.sourceProjectId !== candidate.projectId ||
    admission.issueAttempt.boardId !== config.boardId ||
    factoryScheduleIssueKey(admission.issueAttempt.issue) !== candidate.canonicalIssueKey
  )
    return fail(
      "The host admission no longer matches the prepared ticket and scope.",
      "stale-revision",
    );
  if (admission.authority.kind === "tracker-ready") {
    if (
      admission.authority.kind !== "tracker-ready" ||
      admission.authority.boardId !== config.boardId ||
      admission.authority.itemId !== candidate.observation.itemId
    )
      return fail("Fresh tracker readiness proof is required.");
  } else if (
    admission.authority.kind === "project-improvement" &&
    (candidate.source.kind !== "project-improvement" ||
      admission.authority.ruleId !== config.improvementRule?.id ||
      admission.authority.followupId !== candidate.source.followupId)
  )
    return fail("The project's current improvement rule must supply the authority.");
  const authority = factoryScheduleAuthority(state, candidate, {
    requiredAuthority: admission.authority,
  });
  if (Result.isFailure(authority)) return Result.fail(authority.failure);
  return Result.succeed(candidate);
}

/** Consumes the candidate's generation in the same decision that creates its assignment. */
export function claimFactoryScheduleCandidate(
  state: FactorySnapshot,
  candidate: FactoryScheduleCandidate,
  assignmentId: FactoryAssignmentId,
  admission: FactorySchedulingAdmission,
  now: string,
): FactorySnapshot {
  return {
    ...state,
    scheduleCandidates: state.scheduleCandidates.map((entry) =>
      entry.id === candidate.id
        ? {
            ...entry,
            lifecycle: {
              phase: "commissioned",
              preparation: factorySchedulePreparation(candidate)!,
              assignmentId,
              authority: admission.authority,
            },
            updatedAt: now,
          }
        : entry,
    ),
  };
}

/**
 * Decides scheduling configuration, the ticket queue and its host receipts. Returns `undefined`
 * for other commands. Commissioning a candidate is decided with the assignment, through
 * `validateFactorySchedulingCommission` and `claimFactoryScheduleCandidate`.
 */
export function decideFactoryScheduling(
  input: FactorySchedulingContext & {
    readonly state: FactorySnapshot;
    readonly actor: FactoryActor;
    readonly command: FactoryDecisionCommand;
    readonly now: string;
  },
): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  const accept = (
    patch: Partial<FactorySnapshot> = {},
    effects: readonly FactoryEffectIntent[] = [],
    result: Omit<FactoryCommandResult, "revision"> = {},
  ) =>
    Result.succeed({
      state: { ...state, ...patch, revision: state.revision + 1 },
      effects,
      result: { ...result, revision: state.revision + 1 },
    });
  const save = (
    candidate: FactoryScheduleCandidate,
    effects: readonly FactoryEffectIntent[] = [],
  ) =>
    accept(
      {
        scheduleCandidates: state.scheduleCandidates.some((entry) => entry.id === candidate.id)
          ? state.scheduleCandidates.map((entry) =>
              entry.id === candidate.id ? { ...candidate, updatedAt: now } : entry,
            )
          : [...state.scheduleCandidates, candidate],
      },
      effects,
      { candidateId: candidate.id, managerId: candidate.managerId },
    );
  const canManage = (candidate: FactoryScheduleCandidate) =>
    actor.kind === "human" ||
    (actor.kind === "thread" &&
      actor.threadId === candidate.managerId &&
      factoryExecutionBlocked(state, {
        threadId: actor.threadId,
        managerId: candidate.managerId,
        projectId: candidate.projectId,
        ancestorThreadIds: [],
      }) === undefined);
  // Records a board observation as the ticket's current candidate. A consumed generation stays.
  const recordObservation = (
    observed: NonNullable<FactorySchedulingContext["schedulingObservation"]>,
    consumed: Result.Result<FactoryDecision, FactoryError>,
  ) => {
    const config = factorySchedulingConfiguration(state, observed.projectId);
    const manager = state.managers.find(
      (entry) =>
        entry.role === "project" &&
        entry.projectId === observed.projectId &&
        entry.status !== "retired",
    );
    if (!config || config.id !== observed.configurationId || !manager)
      return fail("The tracker observation is no longer current.", "stale-revision");
    const canonicalIssueKey = factoryScheduleIssueKey(observed.issue);
    const previous = state.scheduleCandidates
      .filter((entry) => entry.canonicalIssueKey === canonicalIssueKey)
      .sort((a, b) => b.generation - a.generation)[0];
    if (previous && previous.projectId !== observed.projectId)
      return fail("Another project already owns this canonical ticket.");
    if (previous?.lifecycle.phase === "commissioned" || previous?.lifecycle.phase === "dismissed")
      return consumed;
    // Once a ticket is known to come from a project improvement, it keeps that source.
    const source =
      previous?.source.kind === "project-improvement" ? previous.source : observed.source;
    const candidate: FactoryScheduleCandidate = previous
      ? {
          ...previous,
          configurationId: config.id,
          observation: observed.observation,
          source,
          updatedAt: now,
        }
      : {
          id: factoryScheduleCandidateId(canonicalIssueKey, 0),
          projectId: observed.projectId,
          managerId: manager.id,
          issue: observed.issue,
          canonicalIssueKey,
          generation: 0,
          configurationId: config.id,
          source,
          observation: observed.observation,
          lifecycle: { phase: "observed" },
          notifiedDigest: null,
          notificationDigest: null,
          createdAt: now,
          updatedAt: now,
        };
    return save(candidate);
  };
  switch (command.type) {
    case "project.scheduling.configure": {
      if (actor.kind !== "human") return fail("Only the human can configure scheduling authority.");
      const previous = factorySchedulingConfiguration(state, command.projectId);
      // Disabling scheduling on the current board needs no fresh board check, so the human can
      // switch it off even when the tracker is unreachable.
      if (
        !(!command.enabled && previous?.boardId === command.boardId) &&
        (input.schedulingBoardVerified?.projectId !== command.projectId ||
          input.schedulingBoardVerified.boardId !== command.boardId)
      )
        return fail("Select a verified connected board for this project.");
      const rule = command.improvementRule;
      if (
        rule &&
        [...rule.allowedSourcePaths, ...rule.creatableDirectories, ...rule.protectedPaths].some(
          (path) => !factoryRelativePath(path),
        )
      )
        return fail("Improvement rules require project-relative paths.", "invalid-state");
      // Rule ids are immutable because scheduled assignments cite the rule they ran under.
      if (
        rule &&
        state.schedulingConfigurations.some(
          (entry) =>
            entry.improvementRule?.id === rule.id &&
            stableStringify(entry.improvementRule) !== stableStringify(rule),
        )
      )
        return fail("A changed improvement rule requires a new immutable ID.", "command-conflict");
      const configuration = {
        id: command.commandId,
        projectId: command.projectId,
        boardId: command.boardId,
        enabled: command.enabled,
        maxConcurrentAssignments: command.maxConcurrentAssignments,
        improvementRule: rule,
        approvedBy: command.commandId,
        approvedAt: now,
      };
      return accept(
        { schedulingConfigurations: [...state.schedulingConfigurations, configuration] },
        [{ type: "schedule.reconcile", projectId: command.projectId }],
      );
    }
    case "schedule.observed": {
      if (actor.kind !== "system") return fail("Only the host can record tracker observations.");
      if (factoryScheduleIssueKey(command.issue) !== command.canonicalIssueKey)
        return fail("The tracker observation is no longer current.", "stale-revision");
      return recordObservation(command, accept());
    }
    case "schedule.track": {
      const manager = state.managers.find(
        (entry) =>
          entry.role === "project" &&
          entry.projectId === command.projectId &&
          entry.status === "active",
      );
      if (
        !manager ||
        (actor.kind !== "human" &&
          (actor.kind !== "thread" ||
            actor.threadId !== manager.id ||
            factoryExecutionBlocked(state, {
              threadId: actor.threadId,
              managerId: manager.id,
              projectId: command.projectId,
              ancestorThreadIds: [],
            }) !== undefined))
      )
        return fail("Only the project's manager or the human can bring a ticket into its queue.");
      const observed = input.schedulingObservation;
      if (
        observed?.projectId !== command.projectId ||
        observed.issue.number !== command.issueNumber
      )
        return fail("Read the ticket from the project's configured board first.", "stale-revision");
      return recordObservation(
        observed,
        fail(
          "This ticket was already commissioned or dismissed. Ask the human to reopen it.",
          "invalid-state",
        ),
      );
    }
    case "schedule.notifications.requested":
    case "schedule.notified": {
      if (actor.kind !== "system")
        return fail("Only the host can record scheduling notifications.");
      if (
        command.notifications.length < 1 ||
        command.notifications.length > 20 ||
        new Set(command.notifications.map((entry) => entry.candidateId)).size !==
          command.notifications.length ||
        command.notifications.some(
          (notification) =>
            !state.scheduleCandidates.some(
              (entry) =>
                entry.id === notification.candidateId && entry.managerId === command.managerId,
            ),
        )
      )
        return fail(
          "A notification batch must contain one to twenty distinct candidates belonging to its manager.",
          "invalid-state",
        );
      // A receipt only marks candidates whose requested digest is still current; a newer
      // request supersedes it. A request skips candidates already told or being told.
      if (command.type === "schedule.notified")
        return accept({
          scheduleCandidates: state.scheduleCandidates.map((candidate) => {
            const receipt = command.notifications.find(
              (entry) => entry.candidateId === candidate.id,
            );
            return receipt && receipt.digest === candidate.notificationDigest
              ? { ...candidate, notifiedDigest: receipt.digest, updatedAt: now }
              : candidate;
          }),
        });
      const notifications = command.notifications.filter((notification) => {
        const candidate = state.scheduleCandidates.find(
          (entry) => entry.id === notification.candidateId,
        )!;
        return (
          candidate.lifecycle.phase !== "commissioned" &&
          candidate.lifecycle.phase !== "dismissed" &&
          candidate.notifiedDigest !== notification.digest &&
          candidate.notificationDigest !== notification.digest
        );
      });
      if (!notifications.length) return accept();
      return accept(
        {
          scheduleCandidates: state.scheduleCandidates.map((candidate) => {
            const notification = notifications.find((entry) => entry.candidateId === candidate.id);
            return notification
              ? { ...candidate, notificationDigest: notification.digest, updatedAt: now }
              : candidate;
          }),
        },
        [{ type: "schedule.notify", managerId: command.managerId, notifications }],
      );
    }
    case "schedule.prepare":
    case "schedule.retry":
    case "schedule.dismiss":
    case "schedule.reopen":
    case "schedule.held":
    case "schedule.ready": {
      const candidate = state.scheduleCandidates.find((entry) => entry.id === command.candidateId);
      if (!candidate) return fail("The selected ticket was not found.", "invalid-state");
      if (command.type === "schedule.held" || command.type === "schedule.ready") {
        if (actor.kind !== "system") return fail("Only the host can record scheduling receipts.");
        if (state.revision !== command.expectedStateRevision)
          return fail(
            "The candidate changed before its scheduling state was recorded.",
            "stale-revision",
          );
        // A consumed generation ignores holds, and `ready` only lifts an existing hold.
        if (
          candidate.lifecycle.phase === "commissioned" ||
          candidate.lifecycle.phase === "dismissed"
        )
          return accept();
        if (command.type === "schedule.ready") {
          if (candidate.lifecycle.phase !== "held") return accept();
          const preparation = candidate.lifecycle.preparation;
          return save({
            ...candidate,
            lifecycle: preparation ? { phase: "prepared", preparation } : { phase: "observed" },
          });
        }
        return save({
          ...candidate,
          lifecycle: {
            phase: "held",
            origin: command.origin,
            reason: command.reason,
            preparation: factorySchedulePreparation(candidate),
          },
        });
      }
      if (!canManage(candidate))
        return fail("Only the owning manager or human can manage this ticket.");
      if (command.type === "schedule.reopen") {
        if (actor.kind !== "human") return fail("Only the human can reopen an issue generation.");
        // Reopening starts a new generation with its own candidate id and releases the old
        // reservation. The prior generation must be dismissed, or its assignment finished.
        const lifecycle = candidate.lifecycle;
        const assignment =
          lifecycle.phase === "commissioned"
            ? state.assignments.find((entry) => entry.id === lifecycle.assignmentId)
            : undefined;
        if (
          candidate.lifecycle.phase !== "dismissed" &&
          (!assignment ||
            (assignment.status !== "complete" && assignment.completion?.phase !== "concluded"))
        )
          return fail(
            "Finish or dismiss the prior ticket generation before reopening.",
            "invalid-state",
          );
        if (
          state.scheduleCandidates.some(
            (entry) =>
              entry.canonicalIssueKey === candidate.canonicalIssueKey &&
              entry.generation > candidate.generation,
          )
        )
          return fail("This ticket already has a newer generation.", "invalid-state");
        const generation = candidate.generation + 1;
        return save(
          {
            ...candidate,
            id: factoryScheduleCandidateId(candidate.canonicalIssueKey, generation),
            generation,
            reopenedFrom: {
              candidateId: candidate.id,
              commandId: command.commandId,
              reason: command.reason,
            },
            lifecycle: { phase: "observed" },
            notifiedDigest: null,
            notificationDigest: null,
            createdAt: now,
            updatedAt: now,
          },
          [
            { type: "schedule.release", candidateId: candidate.id },
            { type: "schedule.reconcile", projectId: candidate.projectId },
          ],
        );
      }
      if (candidate.lifecycle.phase === "commissioned" || candidate.lifecycle.phase === "dismissed")
        return fail("This generation has already been consumed.", "invalid-state");
      if (command.type === "schedule.dismiss") {
        if (actor.kind !== "human")
          return fail("Only the human can dismiss a scheduling candidate.");
        return save(
          {
            ...candidate,
            lifecycle: {
              phase: "dismissed",
              reason: command.reason,
              preparation: factorySchedulePreparation(candidate),
            },
          },
          [{ type: "schedule.release", candidateId: candidate.id }],
        );
      }
      if (command.type === "schedule.prepare") {
        if (command.preparation.detailDigest !== candidate.observation.detailDigest)
          return fail("Read the current ticket before preparing its scope.", "stale-revision");
        return save(
          { ...candidate, lifecycle: { phase: "prepared", preparation: command.preparation } },
          [{ type: "schedule.reconcile", projectId: candidate.projectId }],
        );
      }
      // Retry lifts any hold and asks the host to recheck the ticket and its eligibility.
      const preparation = factorySchedulePreparation(candidate);
      return save(
        {
          ...candidate,
          lifecycle: preparation ? { phase: "prepared", preparation } : { phase: "observed" },
        },
        [{ type: "schedule.reconcile", projectId: candidate.projectId }],
      );
    }
    default:
      return undefined;
  }
}
