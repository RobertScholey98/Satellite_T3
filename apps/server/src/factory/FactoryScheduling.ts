import {
  FactoryError,
  type FactoryAssignmentId,
  type FactoryCommandResult,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryScheduleCandidate,
  type FactorySchedulePreparation,
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

export interface FactorySchedulingContext {
  readonly schedulingAdmission?: FactorySchedulingAdmission;
  readonly schedulingBoardVerified?: { readonly projectId: ProjectId; readonly boardId: string };
}
const hash = (value: unknown) =>
  Hex.encode(sha256(new TextEncoder().encode(stableStringify(value))));
export const factoryScheduleIssueKey = (ref: IssueRef) =>
  ref.hostKind === "azure-devops"
    ? `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.split("/")[0]!.toLowerCase()}:${ref.id}`
    : `${ref.hostKind}:${ref.host.toLowerCase()}:${ref.repository.toLowerCase()}:${ref.id}`;
export const factoryScheduleCandidateId = (canonicalIssueKey: string, generation: number) =>
  `schedule:${hash(canonicalIssueKey)}:${generation}`;
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

interface AuthorityOptions {
  readonly existingAssignmentId?: FactoryAssignmentId;
  readonly requiredAuthority?: FactoryScheduleAuthority;
}
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
      "Project feedback remains in triage until a human authorizes it or an approved project rule applies.",
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

export function factoryScheduleAuthority(
  state: FactorySnapshot,
  candidate: FactoryScheduleCandidate,
  options: AuthorityOptions = {},
): Result.Result<FactoryScheduleAuthority, FactoryError> {
  const reasons = eligibilityReasons(state, candidate, options);
  if (reasons.length) return fail(reasons.join(" "));
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

export function factoryScheduleEligibility(
  state: FactorySnapshot,
  candidate: FactoryScheduleCandidate,
): { readonly eligible: true } | { readonly eligible: false; readonly reasons: readonly string[] } {
  const reasons = eligibilityReasons(state, candidate);
  if (reasons.length) return { eligible: false, reasons };
  const priority = factorySchedulePreparation(candidate)!.priority;
  if (
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

export function validateFactorySchedulingCommission(
  state: FactorySnapshot,
  command: Extract<FactoryDecisionCommand, { type: "assignment.commission" }>,
  admission: FactorySchedulingAdmission | undefined,
): Result.Result<FactoryScheduleCandidate, FactoryError> {
  if (
    !command.candidateId ||
    command.dependencyId ||
    command.authorizationMessageId ||
    !admission ||
    admission.candidateId !== command.candidateId
  )
    return fail(
      "Candidate commissioning requires its own verified admission, without another authority source.",
    );
  const candidate = state.scheduleCandidates.find((entry) => entry.id === command.candidateId);
  if (!candidate || candidate.managerId !== command.managerId)
    return fail("The selected ticket does not belong to this manager.");
  const eligibility = factoryScheduleEligibility(state, candidate);
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
    candidate.source.kind !== "project-improvement" ||
    admission.authority.ruleId !== config.improvementRule?.id ||
    admission.authority.followupId !== candidate.source.followupId
  )
    return fail("The project's current improvement rule must supply the authority.");
  const authority = factoryScheduleAuthority(state, candidate, {
    requiredAuthority: admission.authority,
  });
  if (Result.isFailure(authority)) return Result.fail(authority.failure);
  return Result.succeed(candidate);
}

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
  switch (command.type) {
    case "project.scheduling.configure": {
      if (actor.kind !== "human") return fail("Only the human can configure scheduling authority.");
      const previous = factorySchedulingConfiguration(state, command.projectId);
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
      const config = factorySchedulingConfiguration(state, command.projectId);
      const manager = state.managers.find(
        (entry) => entry.role === "project" && entry.projectId === command.projectId,
      );
      if (
        !config ||
        config.id !== command.configurationId ||
        !manager ||
        factoryScheduleIssueKey(command.issue) !== command.canonicalIssueKey
      )
        return fail("The tracker observation is no longer current.", "stale-revision");
      const previous = state.scheduleCandidates
        .filter((entry) => entry.canonicalIssueKey === command.canonicalIssueKey)
        .sort((a, b) => b.generation - a.generation)[0];
      if (previous && previous.projectId !== command.projectId)
        return fail("Another project already owns this canonical ticket.");
      if (previous?.lifecycle.phase === "commissioned" || previous?.lifecycle.phase === "dismissed")
        return accept();
      const source =
        previous?.source.kind === "project-improvement" ? previous.source : command.source;
      const candidate: FactoryScheduleCandidate = previous
        ? {
            ...previous,
            configurationId: config.id,
            observation: command.observation,
            source,
            updatedAt: now,
          }
        : {
            id: factoryScheduleCandidateId(command.canonicalIssueKey, 0),
            projectId: command.projectId,
            managerId: manager.id,
            issue: command.issue,
            canonicalIssueKey: command.canonicalIssueKey,
            generation: 0,
            configurationId: config.id,
            source,
            observation: command.observation,
            lifecycle: { phase: "observed" },
            notifiedDigest: null,
            notificationDigest: null,
            createdAt: now,
            updatedAt: now,
          };
      return save(candidate);
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
