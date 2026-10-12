import {
  CommandId,
  FactoryError,
  MessageId,
  type FactoryAssignment,
  type FactoryEffectIntent,
  type FactoryHostCommand,
  type FactorySnapshot,
  type ModelSelection,
  type ThreadId,
  isFactoryError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryHandover from "./FactoryHandover.ts";
import { factoryRecoveryBlocked } from "./FactoryOversight.ts";
import * as FactoryStore from "./FactoryStore.ts";

/**
 * Launches the threads a recovery incident asks for: an independent, read-only diagnosis thread
 * and a replacement lead. Each launch stops the current lead, prepares the boundary and records
 * a prepared receipt before it sends the initial message, so a restart resumes from whichever
 * half already landed.
 */
export class FactoryRecoveryEffects extends Context.Service<
  FactoryRecoveryEffects,
  {
    /**
     * Runs one `auxiliary.launch` or `assignment.replace-lead` intent. An intent the incident has
     * moved past retires; while the manager is inactive or recovery is blocked it stays pending.
     * A failed launch records a failure receipt for the incident.
     */
    readonly handle: (
      pending: FactoryStore.PendingFactoryEffect,
    ) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryRecoveryEffects") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const terminal = (assignment: FactoryAssignment | undefined) =>
  assignment === undefined ||
  assignment.outcome !== undefined ||
  assignment.status === "complete" ||
  assignment.oversight?.delivery !== undefined;
const held = (state: FactorySnapshot, assignment: FactoryAssignment) =>
  state.managers.find((entry) => entry.id === assignment.managerId)?.status !== "active" ||
  factoryRecoveryBlocked(state, assignment) !== undefined;
type RecoveryIntent = Extract<
  FactoryEffectIntent,
  { type: "auxiliary.launch" | "assignment.replace-lead" }
>;
/**
 * The assignment when the intent still belongs to its current incident step, otherwise
 * `undefined` and the effect retires. `acceptedReceipt` also matches a replacement lead that has
 * already taken over, so a replay after the recorded receipt can still finish.
 */
const currentRecovery = (
  state: FactorySnapshot,
  intent: RecoveryIntent,
  acceptedReceipt = false,
) => {
  const assignment = state.assignments.find((entry) => entry.id === intent.assignmentId);
  if (assignment === undefined || terminal(assignment)) return undefined;
  const incident = assignment.oversight?.recovery.incident;
  if (incident?.id !== intent.incidentId) return undefined;
  if (intent.type === "auxiliary.launch") {
    const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === intent.threadId);
    if (
      incident.phase !== "diagnosing" ||
      incident.diagnosisThreadId !== intent.threadId ||
      auxiliary?.status !== "pending" ||
      auxiliary.assignmentId !== assignment.id ||
      auxiliary.incidentId !== intent.incidentId ||
      auxiliary.cycle !== intent.cycle
    )
      return undefined;
  } else if (
    incident.replacementThreadId !== intent.threadId ||
    (incident.phase !== "replacing" &&
      !(
        acceptedReceipt &&
        incident.phase === "continuing" &&
        assignment.threadId === intent.threadId &&
        assignment.previousLeadThreadIds?.includes(intent.previousThreadId)
      ))
  )
    return undefined;
  return assignment;
};

const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const boundaries = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
  const execution = yield* FactoryExecution.FactoryExecution;
  const handovers = yield* FactoryHandover.FactoryHandover;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const access = yield* FactoryControlAccess.FactoryControlAccess;

  const accepted = Effect.fn("FactoryRecoveryEffects.accepted")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    if ((yield* threads.getThreadShell(threadId)) === null) return false;
    const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
      messageIds: [messageId],
    });
    const message = records.messages.find((entry) => entry.id === messageId);
    if (message === undefined) return false;
    if (!records.runs.some((entry) => entry.id === message.runId))
      return yield* new FactoryError({ code: "launch-failed" });
    return true;
  }, Effect.mapError(failure));

  // Creates the thread if needed and sends its initial message under the manager's direction.
  // Rechecks that the recovery is current between each host step, since any of them can race a
  // human control.
  const launch = Effect.fn("FactoryRecoveryEffects.launch")(function* (input: {
    readonly pending: FactoryStore.PendingFactoryEffect;
    readonly assignment: FactoryAssignment;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly modelSelection: ModelSelection;
    readonly title: string;
    readonly text: string;
  }) {
    const assertCurrent = Effect.gen(function* () {
      const state = yield* store.snapshot;
      const intent = input.pending.intent;
      if (intent.type !== "auxiliary.launch" && intent.type !== "assignment.replace-lead")
        return yield* new FactoryError({ code: "invalid-state" });
      const assignment = currentRecovery(state, intent);
      if (!assignment || held(state, assignment))
        return yield* new FactoryError({ code: "invalid-state" });
    });
    yield* assertCurrent;
    yield* access.assertDirection({
      threadId: input.threadId,
      senderThreadId: input.assignment.managerId,
    });
    yield* execution.assertSelectionFor(input.threadId, input.modelSelection);
    const profile = yield* execution.runtimePolicyFor(input.threadId);
    if (profile === undefined) return yield* new FactoryError({ code: "execution-unavailable" });
    const shell = yield* threads.getThreadShell(input.threadId);
    if (
      shell !== null &&
      (shell.projectId !== input.assignment.projectId ||
        shell.archivedAt !== null ||
        shell.deletedAt !== null)
    )
      return yield* new FactoryError({ code: "invalid-state" });
    yield* assertCurrent;
    if (shell === null)
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`factory:${input.pending.id}:create`),
        threadId: input.threadId,
        projectId: input.assignment.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: profile.projectSnapshotPath,
        createdBy: "system",
        creationSource: "server",
      });
    yield* access.assertDirection({
      threadId: input.threadId,
      senderThreadId: input.assignment.managerId,
    });
    yield* assertCurrent;
    yield* threads
      .sendToThread({
        projectId: input.assignment.projectId,
        threadId: input.threadId,
        commandId: CommandId.make(`factory:${input.pending.id}:initial-message`),
        messageId: input.messageId,
        senderThreadId: input.assignment.managerId,
        modelSelection: input.modelSelection,
        text: input.text,
        attachments: [],
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.catch((cause) =>
          accepted(input.threadId, input.messageId).pipe(
            Effect.flatMap((recorded) => (recorded ? Effect.void : Effect.fail(cause))),
          ),
        ),
      );
  }, Effect.mapError(failure));

  const handle = Effect.fn("FactoryRecoveryEffects.handle")(function* (
    pending: FactoryStore.PendingFactoryEffect,
  ) {
    const { intent } = pending;
    if (intent.type !== "auxiliary.launch" && intent.type !== "assignment.replace-lead") return;
    const snapshot = yield* store.snapshot;
    const assignment = currentRecovery(snapshot, intent, true);
    const incident = assignment?.oversight?.recovery.incident;
    if (assignment === undefined || incident === undefined) {
      yield* store.retireEffect(pending.id);
      return;
    }
    if (
      intent.type === "auxiliary.launch" &&
      snapshot.auxiliaryThreads.find((entry) => entry.threadId === intent.threadId)?.status !==
        "pending"
    ) {
      yield* store.retireEffect(pending.id);
      return;
    }
    if (held(snapshot, assignment)) return;
    const messageId = MessageId.make(`factory:${intent.threadId}:recovery-initial`);
    yield* store.beginEffect(pending.id);
    const result = yield* Effect.gen(function* () {
      if (assignment.grant === undefined) return yield* new FactoryError({ code: "invalid-state" });
      const alreadyAccepted = yield* accepted(intent.threadId, messageId);
      if (!alreadyAccepted && currentRecovery(yield* store.snapshot, intent) === undefined)
        return undefined;
      if (intent.type === "auxiliary.launch") {
        const auxiliary = snapshot.auxiliaryThreads.find(
          (entry) => entry.threadId === intent.threadId,
        );
        if (
          auxiliary === undefined ||
          auxiliary.assignmentId !== assignment.id ||
          auxiliary.incidentId !== incident.id ||
          auxiliary.cycle !== intent.cycle ||
          auxiliary.status !== "pending"
        )
          return yield* new FactoryError({ code: "invalid-state" });
        let qualification = auxiliary.qualification;
        let sourceDigest = auxiliary.sourceDigest;
        if (qualification === undefined || sourceDigest === undefined) {
          if (alreadyAccepted) return yield* new FactoryError({ code: "invalid-state" });
          yield* handovers.stopTeam({
            threadId: assignment.threadId,
            projectId: assignment.projectId,
            commandId: CommandId.make(`factory:${pending.id}:stop`),
          });
          const inspected = yield* boundaries.inspect({
            assignmentId: assignment.id,
            threadId: intent.threadId,
            expectedEpoch: assignment.grant.epoch,
          });
          qualification = inspected.qualification;
          sourceDigest = inspected.sourceDigest;
          const preparedState = yield* store.snapshot;
          const preparing = currentRecovery(preparedState, intent);
          if (!preparing || held(preparedState, preparing)) return undefined;
          yield* store.commit({
            actor: { kind: "system" },
            now: yield* nowIso,
            command: {
              type: "auxiliary.prepared",
              commandId: CommandId.make(`${pending.id}:prepared`),
              threadId: intent.threadId,
              qualification,
              sourceDigest,
            },
          });
        }
        if (!alreadyAccepted) {
          const latest = yield* store.snapshot;
          const current = currentRecovery(latest, intent);
          if (current === undefined || held(latest, current)) return undefined;
          yield* launch({
            pending,
            assignment: current,
            threadId: intent.threadId,
            messageId,
            modelSelection: auxiliary.modelSelection,
            title: `Diagnosis: ${assignment.title ?? assignment.id}`,
            text: [
              `Independently diagnose recovery incident ${incident.id} for assignment ${assignment.id}, cycle ${intent.cycle}. Report to engineering manager ${assignment.managerId}.`,
              `Read the frozen current workspace at /workspace and immutable assignment, grant, verification and recovery evidence at /evidence/assignment.json. Source digest ${sourceDigest}. The owned workflow is at /workflow.`,
              `Prior lead ${assignment.threadId}. Reason: ${incident.reason}. Evidence: ${json(incident.evidence)}. Read the lead's conversation and relevant worker evidence through the approved read tools.`,
              "This is a read-only diagnosis. Identify the cause and propose a replan within existing scope and permissions. Do not implement, delegate implementation, run assignment verification, change controls, or start a PR.",
              `Use factory_dispatch auxiliary.report with threadId ${intent.threadId}, a concrete summary and evidence references. Preserve uncertainty. A recommendation does not authorize additional work.`,
            ].join("\n\n"),
          });
        }
        return {
          type: "auxiliary.started",
          commandId: CommandId.make(`${pending.id}:receipt`),
          threadId: intent.threadId,
          qualification,
          sourceDigest,
        } satisfies FactoryHostCommand;
      }
      const prepared =
        assignment.threadId === intent.threadId &&
        assignment.previousLeadThreadIds?.includes(intent.previousThreadId);
      if (
        (!prepared && assignment.threadId !== intent.previousThreadId) ||
        (alreadyAccepted && !prepared)
      )
        return yield* new FactoryError({ code: "invalid-state" });
      let qualification = assignment.qualification;
      if (!prepared) {
        yield* handovers.stopTeam({
          threadId: intent.previousThreadId,
          projectId: assignment.projectId,
          commandId: CommandId.make(`factory:${pending.id}:stop`),
        });
        qualification = yield* boundaries.rebind({
          assignmentId: assignment.id,
          threadId: intent.threadId,
          expectedEpoch: assignment.grant.epoch,
        });
        const preparedState = yield* store.snapshot;
        const preparing = currentRecovery(preparedState, intent);
        if (!preparing || held(preparedState, preparing)) return undefined;
        yield* store.commit({
          actor: { kind: "system" },
          now: yield* nowIso,
          command: {
            type: "assignment.replacement.prepared",
            commandId: CommandId.make(`${pending.id}:prepared`),
            assignmentId: assignment.id,
            incidentId: incident.id,
            threadId: intent.threadId,
            previousThreadId: intent.previousThreadId,
            qualification,
          },
        });
      }
      if (qualification.status !== "qualified")
        return yield* new FactoryError({ code: "execution-unavailable" });
      if (!alreadyAccepted) {
        const latest = yield* store.snapshot;
        const current = currentRecovery(latest, intent);
        if (current === undefined || held(latest, current)) return undefined;
        const diagnosis = latest.auxiliaryThreads.find(
          (entry) => entry.threadId === incident.diagnosisThreadId,
        );
        yield* launch({
          pending,
          assignment: current,
          threadId: intent.threadId,
          messageId,
          modelSelection: intent.modelSelection,
          title: assignment.title ?? "Implementation",
          text: [
            `You are the replacement lead for existing assignment ${assignment.id}, reporting to engineering manager ${assignment.managerId}. Prior lead ${intent.previousThreadId} and earlier leads ${json(assignment.previousLeadThreadIds ?? [])} retain their conversation evidence. Read them before continuing.`,
            `Scope: ${json(assignment.scope)}. Recovery plan: ${incident.plan}. Independent diagnosis ${diagnosis?.threadId}: ${json(diagnosis?.findings)}.`,
            `Your /workspace is the same preserved candidate volume, including unfinished edits. The workflow remains pinned to ${assignment.workflow.revision} at /workflow. Current grant: ${json(assignment.grant)}. Model policy: ${json(assignment.modelPolicy)}. Recovery cycles used: ${assignment.oversight?.recovery.cyclesUsed}.`,
            "Continue within this original assignment and its completion condition. You and your implementation team own code review, verification, and the complete PR process. The manager coordinates priorities and does not review PRs. Preserve existing PR links and decisions from the prior conversation.",
            "Use assignment.file.mutate for controlled file creation, rename and deletion, and assignment.verify for the adopted checks. Protected controls, approval waits, recovery limits and rule-change authority remain unchanged. Use approved models through delegate_task when useful.",
            "Report an out-of-scope dependency or unresolved decision rather than widening the task. Human PR approval is required unless the current delivery grant and project rule permit autonomous delivery. Conduct internal and manager retros after merge.",
          ].join("\n\n"),
        });
      }
      return {
        type: "assignment.replacement.recorded",
        commandId: CommandId.make(`${pending.id}:receipt`),
        assignmentId: assignment.id,
        incidentId: incident.id,
        threadId: intent.threadId,
        previousThreadId: intent.previousThreadId,
        qualification,
      } satisfies FactoryHostCommand;
    }).pipe(Effect.mapError(failure), Effect.result);
    const latest = yield* store.snapshot;
    const current = currentRecovery(
      latest,
      intent,
      Result.isSuccess(result) && result.success !== undefined,
    );
    if (current === undefined) {
      yield* store.retireEffect(pending.id);
      return;
    }
    if (held(latest, current)) return;
    if (Result.isSuccess(result)) {
      if (result.success !== undefined)
        yield* store.finishEffect({ id: pending.id, now: yield* nowIso, command: result.success });
      return;
    }
    yield* Effect.logError("Factory recovery could not launch its thread", {
      threadId: intent.threadId,
      cause: result.failure,
    });
    const reason =
      result.failure.detail ??
      "The isolated recovery thread could not start. Existing work remains preserved; inspect the runtime and recovery evidence before retrying.";
    yield* store.finishEffect({
      id: pending.id,
      now: yield* nowIso,
      failed: true,
      command:
        intent.type === "auxiliary.launch"
          ? {
              type: "auxiliary.failed",
              commandId: CommandId.make(`${pending.id}:receipt`),
              threadId: intent.threadId,
              reason,
            }
          : {
              type: "assignment.replacement.failed",
              commandId: CommandId.make(`${pending.id}:receipt`),
              assignmentId: assignment.id,
              incidentId: incident.id,
              threadId: intent.threadId,
              reason,
            },
    });
  });
  return FactoryRecoveryEffects.of({ handle });
});

export const layer = Layer.effect(FactoryRecoveryEffects, make);
