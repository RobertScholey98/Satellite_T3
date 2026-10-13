import {
  CommandId,
  FactoryError,
  MessageId,
  type ThreadId,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Store from "./FactoryStore.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Inspection from "./FactoryDeliveryInspection.ts";
import * as Integration from "./FactoryIntegrationExecution.ts";
import { factoryMergeGroupEvidence } from "./FactoryMerge.ts";
import { factoryMergeGroupHeads } from "./FactoryMergeOperation.ts";
import { canonicalFactoryPullRequest } from "./FactoryMergeOwnership.ts";
import * as MergeSignal from "./FactoryMergeSignal.ts";

/**
 * Runs merge group outbox effects for `FactoryService`: inspect seals a combined review, notify
 * queues a group message to the lead and members, and hold shows the group's hold on the host.
 */
export class FactoryMergeEffects extends Context.Service<
  FactoryMergeEffects,
  {
    readonly handle: (pending: Store.PendingFactoryEffect) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryMergeEffects") {}
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });
const make = Effect.gen(function* () {
  const store = yield* Store.FactoryStore;
  const threads = yield* Threads.ThreadManagementService;
  const access = yield* Access.FactoryControlAccess;
  const inspection = yield* Inspection.FactoryDeliveryInspection;
  const integration = yield* Integration.FactoryIntegrationExecution;
  const signals = yield* MergeSignal.FactoryMergeSignal;
  const crypto = yield* Crypto.Crypto;
  const retire = (id: string) =>
    store.pending.pipe(
      Effect.flatMap((pending) =>
        pending.some((entry) => entry.id === id) ? store.retireEffect(id) : Effect.void,
      ),
    );
  /**
   * Whether the thread already has this message with its run. A message without its run fails,
   * so the effect stays pending instead of sending again.
   */
  const accepted = Effect.fn(function* (threadId: ThreadId, messageId: MessageId) {
    if (!(yield* threads.getThreadShell(threadId))) return false;
    const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
      messageIds: [messageId],
    });
    const message = records.messages.find((entry) => entry.id === messageId);
    if (!message) return false;
    if (!records.runs.some((entry) => entry.id === message.runId))
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "The merge review notification has no durable run.",
      });
    return true;
  }, Effect.mapError(failure));
  /**
   * Queues the message once on each recipient's lead thread, skipping ended assignments and
   * recipients no longer in the group. A previous lead thread that already has it counts. Any
   * recipient that fails, for example one refused direction, keeps the effect pending.
   */
  const notify = Effect.fn(function* (pending: Store.PendingFactoryEffect) {
    if (pending.intent.type !== "merge.group.notify") return;
    const intent = pending.intent;
    const state = yield* store.snapshot;
    const group = state.mergeGroups.find((entry) => entry.id === intent.groupId);
    if (!group) {
      yield* retire(pending.id);
      return;
    }
    let held = false;
    yield* store.beginEffect(pending.id);
    for (const assignmentId of intent.recipientAssignmentIds) {
      const current = (yield* store.snapshot).assignments.find(
        (entry) => entry.id === assignmentId,
      );
      if (
        !current ||
        current.outcome ||
        current.status === "complete" ||
        (current.completion && current.completion.phase !== "collecting") ||
        ![...group.memberAssignmentIds, group.integrationAssignmentId].includes(current.id)
      )
        continue;
      const messageId = MessageId.make(`factory:merge:${pending.id}:${assignmentId}`);
      const result = yield* Effect.gen(function* () {
        for (const threadId of [current.threadId, ...(current.previousLeadThreadIds ?? [])])
          if (yield* accepted(threadId, messageId)) return;
        yield* access.assertDirection({ threadId: current.threadId, senderThreadId: null });
        const shell = yield* threads.getThreadShell(current.threadId);
        if (!shell || shell.deletedAt !== null || shell.archivedAt !== null) return;
        yield* threads.sendToThread({
          projectId: current.projectId,
          threadId: current.threadId,
          messageId,
          commandId: CommandId.make(`${pending.id}:${assignmentId}:notify`),
          text: `[Merge group ${group.id}]\n${intent.text}`,
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        });
      }).pipe(Effect.result);
      if (Result.isFailure(result)) held = true;
    }
    if (!held) yield* retire(pending.id);
  });
  /**
   * Refreshes each member's host evidence, captures the integration bytes and seals the review only
   * if nothing changed during capture. Only changed evidence is tried again, up to three tries;
   * then the review fails with the last reason. A review the group no longer requests is dropped.
   */
  const inspect = Effect.fn(function* (pending: Store.PendingFactoryEffect) {
    if (pending.intent.type !== "merge.group.inspect") return;
    const intent = pending.intent;
    const active = Effect.gen(function* () {
      const state = yield* store.snapshot;
      const group = state.mergeGroups.find(
        (entry) =>
          entry.id === intent.groupId &&
          entry.currentReviewId === intent.reviewId &&
          entry.released === undefined,
      );
      const review = state.mergeGroupReviews.find(
        (entry) =>
          entry.id === intent.reviewId &&
          entry.groupId === intent.groupId &&
          entry.lifecycle.phase === "requested",
      );
      return group && review ? { state, group } : undefined;
    });
    if (!(yield* active)) {
      yield* retire(pending.id);
      return;
    }
    yield* store.beginEffect(pending.id);
    let lastFailure = new FactoryError({
      code: "stale-revision",
      detail: "Combined review evidence kept changing. Request another inspection.",
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = yield* Effect.gen(function* () {
        const current = yield* active;
        if (!current) {
          yield* retire(pending.id);
          return;
        }
        for (const assignmentId of current.group.memberAssignmentIds) {
          const assignment = (yield* store.snapshot).assignments.find(
            (entry) => entry.id === assignmentId,
          );
          const revisionId = assignment?.delivery?.currentRevisionId;
          if (!revisionId)
            return yield* new FactoryError({
              code: "invalid-state",
              detail: "Every merge group member needs a current published revision.",
            });
          yield* inspection.refresh({
            assignmentId,
            revisionId,
            commandId: CommandId.make(
              `${pending.id}:inspect:${pending.attempts + 1}:${attempt}:${assignmentId}`,
            ),
          });
        }
        const observed = yield* active;
        if (!observed) {
          yield* retire(pending.id);
          return;
        }
        const evidence = factoryMergeGroupEvidence(observed.state, current.group.id);
        if (!evidence.ready)
          return yield* new FactoryError({
            code: "invalid-state",
            detail: evidence.reasons.join(" "),
          });
        const capture = yield* integration.capture({
          integrationId: current.group.integrationId,
          preparationId: evidence.integrationPreparationId,
        });
        if (
          capture.integrationId !== current.group.integrationId ||
          capture.preparationId !== evidence.integrationPreparationId ||
          capture.digest !== evidence.testArtifactDigest ||
          capture.projects.some(
            (entry) => entry.changedPaths.length > 0 || entry.deletedPaths.length > 0,
          )
        )
          return yield* new FactoryError({
            code: "stale-revision",
            detail:
              "The current integration test files differ from the passing combined verification. Incorporate changes and verify the published inputs again.",
          });
        const fresh = yield* active;
        if (!fresh) {
          yield* retire(pending.id);
          return;
        }
        const latest = factoryMergeGroupEvidence(fresh.state, fresh.group.id);
        if (!latest.ready || stableStringify(latest) !== stableStringify(evidence))
          return yield* new FactoryError({
            code: "stale-revision",
            detail: "The reviewed member or integration evidence changed during capture.",
          });
        const { ready: _ready, ...fields } = latest;
        const digest = Buffer.from(
          yield* crypto.digest(
            "SHA-256",
            Buffer.from(
              stableStringify({
                groupId: fresh.group.id,
                ...fields,
                members: fields.members
                  .map((entry) => ({ ...entry, ref: canonicalFactoryPullRequest(entry.ref) }))
                  .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId)),
              }),
            ),
          ),
        ).toString("hex");
        yield* store.finishEffect({
          id: pending.id,
          now: yield* nowIso,
          command: {
            type: "merge.group.inspected",
            commandId: CommandId.make(`${pending.id}:receipt`),
            groupId: fresh.group.id,
            reviewId: intent.reviewId,
            expectedStateRevision: fresh.state.revision,
            digest,
            ...fields,
          },
        });
      }).pipe(Effect.result);
      if (Result.isSuccess(result)) return;
      lastFailure = failure(result.failure);
      if (lastFailure.code !== "stale-revision") break;
    }
    if (!(yield* active)) {
      yield* retire(pending.id);
      return;
    }
    yield* store.finishEffect({
      id: pending.id,
      now: yield* nowIso,
      failed: true,
      command: {
        type: "merge.group.inspect.failed",
        commandId: CommandId.make(`${pending.id}:failed`),
        groupId: intent.groupId,
        reviewId: intent.reviewId,
        reason: (lastFailure.detail ?? lastFailure.message).slice(0, 6000),
      },
    });
  });
  /**
   * Shows the group's current hold on the host: the label on member PRs while it holds them and
   * the head statuses from `factoryMergeGroupHeads`. Every write reads first, so replays are cheap.
   */
  const hold = Effect.fn(function* (pending: Store.PendingFactoryEffect) {
    if (pending.intent.type !== "merge.group.hold") return;
    const groupId = pending.intent.groupId;
    const queued = yield* store.pending;
    const state = yield* store.snapshot;
    const group = state.mergeGroups.find((entry) => entry.id === groupId);
    // A later hold for the same group writes the same current state.
    const superseded = queued
      .slice(queued.findIndex((entry) => entry.id === pending.id) + 1)
      .some(
        (entry) => entry.intent.type === "merge.group.hold" && entry.intent.groupId === groupId,
      );
    if (!group || superseded) {
      yield* retire(pending.id);
      return;
    }
    yield* store.beginEffect(pending.id);
    const heads = factoryMergeGroupHeads(state, group.id);
    if (group.released) for (const head of heads) yield* signals.unlabel(head.ref);
    else for (const known of group.knownPullRequests) yield* signals.label(known.ref);
    for (const head of heads) yield* signals.publish(head);
    yield* retire(pending.id);
  });
  const handle = Effect.fn("FactoryMergeEffects.handle")(function* (
    pending: Store.PendingFactoryEffect,
  ) {
    if (!(yield* store.pending).some((entry) => entry.id === pending.id)) return;
    if (pending.intent.type === "merge.group.inspect") yield* inspect(pending);
    else if (pending.intent.type === "merge.group.notify") yield* notify(pending);
    else if (pending.intent.type === "merge.group.hold") yield* hold(pending);
  }, Effect.mapError(failure));
  return FactoryMergeEffects.of({ handle });
});
export const layer = Layer.effect(FactoryMergeEffects, make).pipe(
  Layer.provide(Inspection.layer),
  Layer.provide(MergeSignal.layer),
);
