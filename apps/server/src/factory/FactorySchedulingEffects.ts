import { sha256 } from "@noble/hashes/sha2";
import {
  CommandId,
  FactoryError,
  IssueOperationError,
  MessageId,
  type FactoryAssignment,
  type FactoryCommand,
  type FactoryScheduleAuthority,
  type FactoryScheduleObservation,
  type FactorySchedulingConfiguration,
  type FactorySnapshot,
  type ThreadId,
  type IssueDetail,
  type IssueRef,
  type ProjectId,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as IssueService from "../issues/IssueService.ts";
import * as IssueScheduling from "../issues/IssueScheduling.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryStore from "./FactoryStore.ts";
import type { FactoryActor } from "./FactoryState.ts";
import {
  factoryScheduleAuthority,
  factoryScheduleEligibility,
  factoryScheduleIssueKey,
  factoryScheduleNotificationDigest,
  factorySchedulePreparation,
  factoryScheduleWorkDigest,
  factorySchedulingConfiguration,
  type AuthorityOptions,
  type FactorySchedulingContext,
} from "./FactoryScheduling.ts";

/**
 * The host side of project scheduling. Keeps each enabled project's ticket queue in step with its
 * board, notifies project managers when the queue changes, and holds the tracker reservation that
 * gives one assignment exclusive ownership of a ticket generation.
 */
export class FactorySchedulingEffects extends Context.Service<
  FactorySchedulingEffects,
  {
    /**
     * Resolves the `FactorySchedulingContext` for a command. For a candidate commission this
     * reserves the ticket on the tracker; a failed admission holds the candidate with its reason.
     */
    readonly context: (
      actor: FactoryActor,
      command: FactoryCommand,
    ) => Effect.Effect<FactorySchedulingContext, FactoryError>;
    /** Reads a candidate's current ticket for the manager, recording a changed detail digest. */
    readonly read: (
      candidateId: string,
    ) => Effect.Effect<
      { readonly detail: IssueDetail; readonly detailDigest: string },
      FactoryError
    >;
    /**
     * Holds ineligible candidates, lifts eligibility holds that no longer apply, and requests
     * manager notifications for candidates whose state or eligibility changed. Leaves tracker
     * holds to the board refresh.
     */
    readonly reconcile: Effect.Effect<void, FactoryError>;
    readonly handle: (
      pending: FactoryStore.PendingFactoryEffect,
    ) => Effect.Effect<void, FactoryError>;
    /**
     * Revalidates a scheduled assignment's reservation and authority just before its lead
     * starts, and attaches the lead's thread to the issue attempt. Fails when either lapsed.
     */
    readonly beforeLaunch: (
      assignment: FactoryAssignment,
      worktreePath: string,
    ) => Effect.Effect<void, FactoryError>;
    /**
     * Releases a reservation that no assignment took, such as after a refused commission.
     * Refuses while any assignment still owns the candidate.
     */
    readonly release: (candidateId: string) => Effect.Effect<void, FactoryError>;
    /**
     * Refreshes boards on every sync and once a minute, and runs `wake` after each state
     * revision and refresh. The fibers live for the scope.
     */
    readonly watch: (wake: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/factory/FactorySchedulingEffects") {}

const isIssueError = Schema.is(IssueOperationError);
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const hash = (value: unknown) =>
  Hex.encode(sha256(new TextEncoder().encode(stableStringify(value))));
const error = (cause: unknown) =>
  isFactoryError(cause)
    ? cause
    : new FactoryError({
        code: "execution-unavailable",
        detail: isIssueError(cause)
          ? cause.message
          : "The tracker could not confirm scheduling authority.",
        cause,
      });

// Verified project follow-up tickets, which schedule under the improvement rule rather than Ready.
const projectFollowups = (
  state: FactorySnapshot,
  projectId: ProjectId,
  configuration: FactorySchedulingConfiguration,
) =>
  state.followups
    .filter((entry) => entry.projectId === projectId)
    .flatMap((entry) => {
      const publication = entry.publication;
      const issue =
        publication.status === "linked"
          ? publication.issue
          : publication.status === "recorded" && publication.receipt.progress.status === "triaged"
            ? publication.receipt.progress.issue
            : undefined;
      const trackerId = "trackerId" in publication ? publication.trackerId : undefined;
      const destination = (
        state.projectTrackers.find((tracker) => tracker.id === trackerId) ??
        state.projectTrackers.findLast((tracker) => tracker.projectId === projectId)
      )?.destination.destination;
      // Agent-filed tickets count as Ready only after a human takes them out of triage,
      // even when a board rule or mapping places the triage column or labels in Ready.
      const inTriage = (labels: ReadonlyArray<string>, columnId: string | null) => {
        if (!destination) return false;
        if (destination.kind === "azure")
          return destination.boardId === configuration.boardId && columnId === destination.columnId;
        if (destination.triage.kind === "board")
          return (
            destination.triage.boardId === configuration.boardId &&
            columnId === destination.triage.columnId
          );
        const present = new Set(labels.map((label) => label.toLowerCase()));
        return destination.triage.labels.some((label) => present.has(label.toLowerCase()));
      };
      return issue ? [{ issue, followupId: entry.id, inTriage }] : [];
    });
const observedSource = (
  followups: ReturnType<typeof projectFollowups>,
  item: {
    readonly issue: IssueRef;
    readonly labels: ReadonlyArray<string>;
    readonly observation: FactoryScheduleObservation;
  },
) => {
  const followup = followups.find(
    (entry) => factoryScheduleIssueKey(entry.issue) === factoryScheduleIssueKey(item.issue),
  );
  return {
    source: followup
      ? { kind: "project-improvement" as const, followupId: followup.followupId }
      : { kind: "tracker-ready" as const },
    observation: followup?.inTriage(item.labels, item.observation.columnId)
      ? { ...item.observation, ready: false }
      : item.observation,
  };
};

const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const tracker = yield* IssueScheduling.IssueScheduling;
  const issues = yield* IssueService.IssueService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const access = yield* FactoryControlAccess.FactoryControlAccess;
  const refreshMutex = yield* Semaphore.make(1);
  // Records a hold unless the candidate is consumed or already held for the same reason.
  const hold = Effect.fn(function* (
    candidateId: string,
    reason: string,
    origin: "eligibility" | "tracker" = "tracker",
  ) {
    const state = yield* store.snapshot;
    const candidate = state.scheduleCandidates.find((entry) => entry.id === candidateId);
    if (
      !candidate ||
      candidate.lifecycle.phase === "commissioned" ||
      candidate.lifecycle.phase === "dismissed" ||
      (candidate.lifecycle.phase === "held" &&
        candidate.lifecycle.reason === reason &&
        candidate.lifecycle.origin === origin)
    )
      return;
    yield* store.commit({
      actor: { kind: "system" },
      now: yield* nowIso,
      command: {
        type: "schedule.held",
        commandId: CommandId.make(`schedule:hold:${candidateId}:${state.revision}:${hash(reason)}`),
        candidateId,
        reason,
        origin,
        expectedStateRevision: state.revision,
      },
    });
  });
  const authorize = (candidateId: string, options: AuthorityOptions = {}) =>
    Effect.gen(function* () {
      const state = yield* store.snapshot;
      const candidate = state.scheduleCandidates.find((entry) => entry.id === candidateId);
      if (!candidate) return yield* new FactoryError({ code: "invalid-state" });
      const result = factoryScheduleAuthority(state, candidate, options);
      if (Result.isFailure(result)) return yield* result.failure;
      return result.success;
    }).pipe(
      Effect.mapError(
        (cause) => new IssueOperationError({ reason: "conflict", message: cause.message }),
      ),
    );
  // Reads the board and records material changes as observations. A failed read holds every
  // open candidate, and a ticket missing from the board is held until it comes back.
  const refresh = Effect.fn(
    function* (projectId: ProjectId) {
      const state = yield* store.snapshot;
      const configuration = factorySchedulingConfiguration(state, projectId);
      if (!configuration?.enabled) return;
      const candidates = state.scheduleCandidates.filter(
        (entry) =>
          entry.projectId === projectId &&
          entry.lifecycle.phase !== "dismissed" &&
          entry.lifecycle.phase !== "commissioned",
      );
      const followups = projectFollowups(state, projectId, configuration);
      const result = yield* tracker
        .observe({
          projectId,
          boardId: configuration.boardId,
          includeIssues: [
            ...candidates.map((entry) => entry.issue),
            ...followups.map((entry) => entry.issue),
          ],
        })
        .pipe(Effect.result);
      if (Result.isFailure(result)) {
        for (const candidate of candidates) yield* hold(candidate.id, result.failure.message);
        return;
      }
      for (const item of result.success.items) {
        const latest = yield* store.snapshot;
        if (factorySchedulingConfiguration(latest, projectId)?.id !== configuration.id) return;
        const canonicalIssueKey = factoryScheduleIssueKey(item.issue);
        const previous = latest.scheduleCandidates
          .filter((entry) => entry.canonicalIssueKey === canonicalIssueKey)
          .sort((a, b) => b.generation - a.generation)[0];
        if (
          previous &&
          (previous.projectId !== projectId ||
            previous.lifecycle.phase === "commissioned" ||
            previous.lifecycle.phase === "dismissed")
        )
          continue;
        const { source, observation } = observedSource(followups, item);
        const material = { ...observation, observedAt: undefined, boardRevision: undefined };
        if (previous?.lifecycle.phase === "held" && previous.lifecycle.origin === "tracker") {
          yield* store.commit({
            actor: { kind: "system" },
            now: yield* nowIso,
            command: {
              type: "schedule.ready",
              commandId: CommandId.make(`schedule:ready:${previous.id}:${latest.revision}`),
              candidateId: previous.id,
              expectedStateRevision: latest.revision,
            },
          });
        }
        if (
          previous?.configurationId === configuration.id &&
          stableStringify({
            ...previous.observation,
            observedAt: undefined,
            boardRevision: undefined,
          }) === stableStringify(material)
        )
          continue;
        yield* store.commit({
          actor: { kind: "system" },
          now: yield* nowIso,
          command: {
            type: "schedule.observed",
            commandId: CommandId.make(
              `schedule:observe:${hash([configuration.id, canonicalIssueKey, material, latest.revision])}`,
            ),
            projectId,
            configurationId: configuration.id,
            issue: item.issue,
            canonicalIssueKey,
            source,
            observation,
          },
        });
      }
      for (const candidate of candidates)
        if (
          !result.success.items.some(
            (entry) => factoryScheduleIssueKey(entry.issue) === candidate.canonicalIssueKey,
          )
        )
          yield* hold(candidate.id, "The ticket is no longer available on the configured board.");
    },
    refreshMutex.withPermit,
    Effect.mapError(error),
  );
  const reconcile = Effect.gen(function* () {
    for (const initial of (yield* store.snapshot).scheduleCandidates) {
      if (initial.lifecycle.phase === "commissioned" || initial.lifecycle.phase === "dismissed")
        continue;
      const state = yield* store.snapshot;
      const candidate = state.scheduleCandidates.find((entry) => entry.id === initial.id)!;
      const eligibility = factoryScheduleEligibility(state, candidate);
      if (candidate.lifecycle.phase === "held" && candidate.lifecycle.origin === "tracker")
        continue;
      if (!eligibility.eligible)
        yield* hold(candidate.id, eligibility.reasons.join(" "), "eligibility");
      else if (candidate.lifecycle.phase === "held")
        yield* store.commit({
          actor: { kind: "system" },
          now: yield* nowIso,
          command: {
            type: "schedule.ready",
            commandId: CommandId.make(`schedule:ready:${candidate.id}:${state.revision}`),
            candidateId: candidate.id,
            expectedStateRevision: state.revision,
          },
        });
    }
    const state = yield* store.snapshot;
    const batches = new Map<ThreadId, { candidateId: string; digest: string }[]>();
    for (const candidate of state.scheduleCandidates) {
      if (candidate.lifecycle.phase === "commissioned" || candidate.lifecycle.phase === "dismissed")
        continue;
      const config = factorySchedulingConfiguration(state, candidate.projectId);
      const manager = state.managers.find((entry) => entry.id === candidate.managerId);
      if (!config?.enabled || manager?.status !== "active") continue;
      const eligibility = factoryScheduleEligibility(state, candidate);
      const digest = hash([factoryScheduleNotificationDigest(candidate), eligibility]);
      if (candidate.notifiedDigest === digest || candidate.notificationDigest === digest) continue;
      const batch = batches.get(candidate.managerId) ?? [];
      batch.push({ candidateId: candidate.id, digest });
      batches.set(candidate.managerId, batch);
    }
    for (const [managerId, changes] of batches)
      for (let offset = 0; offset < changes.length; offset += 20) {
        const notifications = changes.slice(offset, offset + 20);
        yield* store.commit({
          actor: { kind: "system" },
          now: yield* nowIso,
          command: {
            type: "schedule.notifications.requested",
            commandId: CommandId.make(
              `schedule:notify:${managerId}:${state.revision}:${hash(notifications)}`,
            ),
            managerId,
            notifications,
          },
        });
      }
  });
  const context = Effect.fn(function* (actor: FactoryActor, command: FactoryCommand) {
    if (command.type === "project.scheduling.configure") {
      if (actor.kind !== "human") return yield* new FactoryError({ code: "permission-denied" });
      const previous = factorySchedulingConfiguration(yield* store.snapshot, command.projectId);
      if (command.enabled || previous?.boardId !== command.boardId) yield* tracker.qualify(command);
      return {
        schedulingBoardVerified: { projectId: command.projectId, boardId: command.boardId },
      };
    }
    if (command.type === "schedule.track") {
      const state = yield* store.snapshot;
      const configuration = factorySchedulingConfiguration(state, command.projectId);
      const manager = state.managers.find(
        (entry) => entry.role === "project" && entry.projectId === command.projectId,
      );
      if (actor.kind !== "human" && (actor.kind !== "thread" || actor.threadId !== manager?.id))
        return yield* new FactoryError({ code: "permission-denied" });
      if (!configuration?.enabled)
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "Enable scheduling for this project before bringing tickets into its queue.",
        });
      const result = yield* tracker.observe({
        projectId: command.projectId,
        boardId: configuration.boardId,
        includeNumbers: [command.issueNumber],
      });
      const item = result.items.find((entry) => entry.issue.number === command.issueNumber);
      if (!item)
        return yield* new FactoryError({
          code: "invalid-state",
          detail: `Ticket #${command.issueNumber} is not on this project's configured board.`,
        });
      return {
        schedulingObservation: {
          projectId: command.projectId,
          configurationId: configuration.id,
          issue: item.issue,
          ...observedSource(projectFollowups(state, command.projectId, configuration), item),
        },
      };
    }
    if (command.type !== "assignment.commission" || !command.candidateId) return {};
    const state = yield* store.snapshot;
    const candidate = state.scheduleCandidates.find((entry) => entry.id === command.candidateId);
    const configuration = candidate && factorySchedulingConfiguration(state, candidate.projectId);
    if (
      !candidate ||
      !configuration ||
      candidate.managerId !== command.managerId ||
      (actor.kind !== "human" &&
        (actor.kind !== "thread" || actor.threadId !== candidate.managerId)) ||
      (actor.kind === "human" && command.authorizationMessageId) ||
      command.dependencyId
    )
      return yield* new FactoryError({ code: "permission-denied" });
    // Direct human assignment: the human commissions the ticket, or the manager cites the exact
    // direct human message. Either reserves the ticket like any other scheduled commission.
    let human: Extract<FactoryScheduleAuthority, { kind: "human" }> | undefined;
    if (actor.kind === "human")
      human = { kind: "human", commandId: command.commandId, messageId: null };
    else if (command.authorizationMessageId) {
      const messageId = command.authorizationMessageId;
      const records = yield* threads
        .getThreadRecords(candidate.managerId, ["messages"], { messageIds: [messageId] })
        .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
      if (
        !records.messages.some(
          (message) =>
            message.id === messageId &&
            message.role === "user" &&
            message.createdBy === "user" &&
            message.senderThreadId === undefined &&
            message.scheduledTaskId === undefined,
        )
      )
        return yield* new FactoryError({
          code: "permission-denied",
          detail: "authorizationMessageId must name a direct human message in this manager thread.",
        });
      human = { kind: "human", commandId: command.commandId, messageId };
    }
    const preparation = factorySchedulePreparation(candidate);
    if (
      !preparation ||
      factoryScheduleWorkDigest(preparation.work) !== factoryScheduleWorkDigest(command)
    )
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "Prepare this exact work scope before commissioning the ticket.",
      });
    const admitted = yield* tracker
      .admit({
        candidate,
        configuration,
        workDigest: factoryScheduleWorkDigest(command),
        authorize: authorize(candidate.id, human ? { requiredAuthority: human } : {}),
      })
      .pipe(Effect.result);
    if (Result.isFailure(admitted)) {
      yield* hold(candidate.id, admitted.failure.message);
      return yield* error(admitted.failure);
    }
    return { schedulingAdmission: admitted.success };
  }, Effect.mapError(error));
  const beforeLaunch = Effect.fn(function* (assignment: FactoryAssignment, worktreePath: string) {
    if (!assignment.scheduling) return;
    const admission = yield* tracker.reservation(assignment.scheduling.candidateId);
    if (
      !admission ||
      admission.issueAttempt.attemptId !== assignment.scheduling.issueAttempt.attemptId
    )
      return yield* new FactoryError({ code: "invalid-state" });
    yield* tracker.revalidate({
      admission,
      authorize: authorize(admission.candidateId, {
        existingAssignmentId: assignment.id,
        requiredAuthority: assignment.scheduling.authority,
      }),
      attach: { projectId: assignment.projectId, threadId: assignment.threadId, worktreePath },
    });
  }, Effect.mapError(error));
  // A reservation with no assignment can always be released. With `completed`, one whose
  // assignments all concluded can also be released once the human reopened a newer generation.
  const authorizeRelease = (candidateId: string, completed: boolean) =>
    Effect.gen(function* () {
      const state = yield* store.snapshot;
      const candidate = state.scheduleCandidates.find((entry) => entry.id === candidateId);
      const assignments = state.assignments.filter(
        (entry) => entry.scheduling?.candidateId === candidateId,
      );
      if (!assignments.length) return;
      if (
        completed &&
        candidate?.lifecycle.phase === "commissioned" &&
        assignments.every((entry) => entry.completion?.phase === "concluded") &&
        state.scheduleCandidates.some(
          (entry) =>
            entry.reopenedFrom?.candidateId === candidateId &&
            entry.generation > candidate.generation,
        )
      )
        return;
      return yield* new IssueOperationError({
        reason: "conflict",
        message: "An existing assignment still owns this ticket reservation.",
      });
    }).pipe(
      Effect.mapError((cause) =>
        isIssueError(cause)
          ? cause
          : new IssueOperationError({
              reason: "conflict",
              message: "Ticket ownership could not be confirmed.",
            }),
      ),
    );
  const release = (candidateId: string) =>
    tracker
      .release({ candidateId, authorizeUnstarted: authorizeRelease(candidateId, false) })
      .pipe(Effect.mapError(error));
  const handle = Effect.fn(function* (pending: FactoryStore.PendingFactoryEffect) {
    const intent = pending.intent;
    if (intent.type === "schedule.reconcile") {
      // Disabling scheduling frees every reservation not yet taken by an assignment.
      const state = yield* store.snapshot;
      if (!factorySchedulingConfiguration(state, intent.projectId)?.enabled) {
        for (const candidate of state.scheduleCandidates)
          if (
            candidate.projectId === intent.projectId &&
            candidate.lifecycle.phase !== "commissioned"
          )
            yield* release(candidate.id);
      }
      yield* refresh(intent.projectId);
      yield* store.retireEffect(pending.id);
      return;
    }
    if (intent.type === "schedule.release") {
      yield* tracker.release({
        candidateId: intent.candidateId,
        authorizeUnstarted: authorizeRelease(intent.candidateId, true),
        authorizeCompleted: authorizeRelease(intent.candidateId, true),
      });
      yield* store.retireEffect(pending.id);
      return;
    }
    if (intent.type !== "schedule.notify") return;
    // Send only candidates whose state still matches the requested digest; a newer request
    // covers the rest.
    const state = yield* store.snapshot;
    const candidates = intent.notifications.flatMap((notification) => {
      const candidate = state.scheduleCandidates.find(
        (entry) => entry.id === notification.candidateId,
      );
      return candidate &&
        candidate.notificationDigest === notification.digest &&
        hash([
          factoryScheduleNotificationDigest(candidate),
          factoryScheduleEligibility(state, candidate),
        ]) === notification.digest &&
        candidate.lifecycle.phase !== "commissioned" &&
        candidate.lifecycle.phase !== "dismissed"
        ? [candidate]
        : [];
    });
    if (!candidates.length) {
      yield* store.retireEffect(pending.id);
      return;
    }
    const manager = state.managers.find((entry) => entry.id === intent.managerId);
    if (
      !manager ||
      !manager.projectId ||
      manager.status !== "active" ||
      !factorySchedulingConfiguration(state, manager.projectId)?.enabled
    )
      return;
    const allowed = yield* access
      .assertDirection({ threadId: manager.threadId, senderThreadId: null })
      .pipe(Effect.result);
    if (Result.isFailure(allowed)) return;
    const messageId = MessageId.make(`factory:${pending.id}:schedule`);
    const accepted = Effect.gen(function* () {
      const records = yield* threads.getThreadRecords(manager.threadId, ["messages", "runs"], {
        messageIds: [messageId],
      });
      return records.messages.some(
        (message) =>
          message.id === messageId && records.runs.some((run) => run.id === message.runId),
      );
    });
    if (!(yield* accepted)) {
      yield* threads
        .sendToThread({
          projectId: manager.projectId,
          threadId: manager.threadId,
          messageId,
          commandId: CommandId.make(`${messageId}:send`),
          modelSelection: manager.modelSelection,
          mode: "auto",
          attachments: [],
          createdBy: "system",
          creationSource: "server",
          text: [
            "The project work queue changed. Review these candidates together.",
            ...candidates.map((candidate) => {
              const eligibility = factoryScheduleEligibility(state, candidate);
              return `${candidate.observation.title} (${candidate.issue.url}). Candidate ${candidate.id}; source ${candidate.source.kind}. ${candidate.lifecycle.phase === "held" ? candidate.lifecycle.reason : eligibility.eligible ? "Eligible for live admission." : eligibility.reasons.join(" ")}`;
            }),
            "Read the exact tickets with factory_ticket_read, then use schedule.prepare with each detail digest, scoped work, priority, dependency IDs and rationale. Preparation and recommendations do not authorize work. To prepare a board ticket that is not Ready, bring it into the queue with schedule.track and its issue number, then recommend readiness to the human in its preparation.",
            "If currently authorized, commission the exact prepared work with assignment.commission and candidateId. The host rechecks tracker readiness or the approved project rule, capacity, dependencies, permissions and exclusive ownership. Choose the implementation model from the approved pool according to task complexity. When the human directly asks for one of these tickets, commission it with candidateId and authorizationMessageId set to that human message so the ticket is reserved; never commission a candidate ticket without its candidateId. Do not use an unrelated earlier human message as authorization. If held, prepare or recommend a concrete next decision without repeatedly retrying unchanged conditions. Protected-rule changes always require a separately authorized task. Existing delivery and human PR-review requirements still apply.",
          ].join("\n\n"),
        })
        .pipe(
          Effect.catch((cause) =>
            accepted.pipe(
              Effect.flatMap((recorded) => (recorded ? Effect.void : Effect.fail(cause))),
            ),
          ),
        );
    }
    yield* store.finishEffect({
      id: pending.id,
      now: yield* nowIso,
      command: {
        type: "schedule.notified",
        commandId: CommandId.make(`${pending.id}:notified`),
        managerId: intent.managerId,
        notifications: intent.notifications,
      },
    });
  }, Effect.mapError(error));
  const configs = store.changes.pipe(
    Stream.map((state) =>
      [
        ...new Map(
          state.schedulingConfigurations.map((entry) => [entry.projectId, entry]),
        ).values(),
      ].filter((entry) => entry.enabled),
    ),
    Stream.changesWith((a, b) => stableStringify(a) === stableStringify(b)),
  );
  return FactorySchedulingEffects.of({
    context,
    reconcile,
    handle,
    beforeLaunch,
    release,
    read: Effect.fn(function* (candidateId: string) {
      const candidate = (yield* store.snapshot).scheduleCandidates.find(
        (entry) => entry.id === candidateId,
      );
      if (!candidate) return yield* new FactoryError({ code: "invalid-state" });
      const result = yield* tracker.read({ candidate });
      const state = yield* store.snapshot;
      const current = state.scheduleCandidates.find((entry) => entry.id === candidateId);
      const configuration = factorySchedulingConfiguration(state, candidate.projectId);
      if (
        current &&
        configuration &&
        current.lifecycle.phase !== "commissioned" &&
        current.lifecycle.phase !== "dismissed" &&
        current.observation.detailDigest !== result.detailDigest
      ) {
        yield* store.commit({
          actor: { kind: "system" },
          now: yield* nowIso,
          command: {
            type: "schedule.observed",
            commandId: CommandId.make(
              `schedule:read:${candidateId}:${state.revision}:${result.detailDigest}`,
            ),
            projectId: current.projectId,
            configurationId: configuration.id,
            canonicalIssueKey: current.canonicalIssueKey,
            issue: current.issue,
            source: current.source,
            observation: {
              ...current.observation,
              title: result.detail.title,
              detailDigest: result.detailDigest,
            },
          },
        });
      }
      return result;
    }, Effect.mapError(error)),
    watch: (wake) =>
      Effect.gen(function* () {
        yield* forkParked(
          store.changes.pipe(
            Stream.changesWith((left, right) => left.revision === right.revision),
            Stream.runForEach(() => wake),
          ),
        );
        yield* forkParked(
          configs.pipe(
            Stream.switchMap((entries) =>
              Stream.mergeAll(
                entries.map((entry) =>
                  issues
                    .subscribeBoard({ projectId: entry.projectId, boardId: entry.boardId })
                    .pipe(
                      Stream.changesWith(
                        (left, right) =>
                          left.sync?.revision === right.sync?.revision &&
                          left.sync?.failure?.message === right.sync?.failure?.message,
                      ),
                      Stream.map(() => entry.projectId),
                      Stream.catch(() => Stream.empty),
                    ),
                ),
                { concurrency: "unbounded" },
              ),
            ),
            Stream.runForEach((projectId) =>
              refresh(projectId).pipe(
                Effect.andThen(wake),
                Effect.catch((cause) =>
                  Effect.logError("Factory board observation failed", { projectId, cause }),
                ),
              ),
            ),
          ),
        );
        yield* forkParked(
          Stream.tick("60 seconds").pipe(
            Stream.runForEach(() =>
              Effect.gen(function* () {
                const state = yield* store.snapshot;
                const current = [
                  ...new Map(
                    state.schedulingConfigurations.map((entry) => [entry.projectId, entry]),
                  ).values(),
                ];
                for (const config of current)
                  if (config.enabled)
                    yield* refresh(config.projectId).pipe(
                      Effect.catch((cause) =>
                        Effect.logError("Factory tracker refresh failed", {
                          projectId: config.projectId,
                          cause,
                        }),
                      ),
                    );
                yield* wake;
              }),
            ),
          ),
        );
      }),
  });
});

export const layer = Layer.effect(FactorySchedulingEffects, make);
