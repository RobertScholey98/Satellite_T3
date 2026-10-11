import {
  CommandId,
  FactoryError,
  MessageId,
  RunId,
  ThreadId,
  type FactoryAssignment,
  type FactoryDecisionCommand,
  type FactoryMergeOperation,
  type FactoryMergeOperationMember,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../config.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import { GitHubConditionalMergeError } from "../pullRequest/GitHubPullRequestCli.ts";
import { GitHubApiRateLimitError, GitHubApiResponseError } from "../sourceControl/GitHubApi.ts";
import { SourceControlRateLimitPausedError } from "../sourceControl/SourceControlRateLimit.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Inspection from "./FactoryDeliveryInspection.ts";
import * as Handover from "./FactoryHandover.ts";
import * as Integration from "./FactoryIntegrationExecution.ts";
import { factoryMergeGroupEvidence } from "./FactoryMerge.ts";
import {
  factoryMergeFrozenDigest,
  factoryMergeFrozenProof,
  factoryMergeOperationWriteReadiness,
  factoryMergeReceiptDigest,
} from "./FactoryMergeOperation.ts";
import { FactoryMergeGroupPermit } from "./FactoryPullRequestGate.ts";
import * as Store from "./FactoryStore.ts";

export class FactoryMergeOperationEffects extends Context.Service<
  FactoryMergeOperationEffects,
  { readonly handle: (pending: Store.PendingFactoryEffect) => Effect.Effect<void, FactoryError> }
>()("t3/factory/FactoryMergeOperationEffects") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const isFactoryError = Schema.is(FactoryError);
const isRateLimit = Schema.is(GitHubApiRateLimitError);
const isRateLimitPaused = Schema.is(SourceControlRateLimitPausedError);
const isResponseError = Schema.is(GitHubApiResponseError);
const isConditionalMergeError = Schema.is(GitHubConditionalMergeError);
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });
type Observation = Extract<
  FactoryDecisionCommand,
  { type: "merge.operation.observed" }
>["observation"];
type Recovery = Extract<FactoryDecisionCommand, { type: "merge.operation.held" }>["retry"];
const Targets = Schema.Struct({
  operationId: Schema.String,
  preparationId: Schema.String,
  threadIds: Schema.Array(ThreadId),
  queues: Schema.Array(Schema.Struct({ threadId: ThreadId, runIds: Schema.Array(RunId) })),
});
const encodeTargets = Schema.encodeEffect(Schema.fromJsonString(Targets));
const decodeTargets = Schema.decodeUnknownEffect(Schema.fromJsonString(Targets));

function definitiveRejection(error: unknown): "transient" | "permanent" | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current) && seen.size < 12) {
    seen.add(current);
    if (isRateLimit(current) || isRateLimitPaused(current)) return "transient";
    if (isResponseError(current)) {
      if (current.status === 429) return "transient";
      if ([400, 401, 403, 404, 409, 422].includes(current.status)) return "permanent";
    }
    if (
      isConditionalMergeError(current) ||
      (isFactoryError(current) && current.code === "permission-denied")
    )
      return "permanent";
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

const make = Effect.gen(function* () {
  const store = yield* Store.FactoryStore;
  const threads = yield* Threads.ThreadManagementService;
  const access = yield* Access.FactoryControlAccess;
  const handover = yield* Handover.FactoryHandover;
  const inspection = yield* Inspection.FactoryDeliveryInspection;
  const integration = yield* Integration.FactoryIntegrationExecution;
  const pullRequests = yield* PullRequests.PullRequestService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const locks = new Map<string, Semaphore.Semaphore>();
  const lock = (id: string) => {
    let selected = locks.get(id);
    if (!selected) {
      selected = Semaphore.makeUnsafe(1);
      locks.set(id, selected);
    }
    return selected;
  };
  const hash = (value: unknown) =>
    crypto
      .digest("SHA-256", Buffer.from(stableStringify(value)))
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
  const location = (id: string) =>
    hash(id).pipe(
      Effect.map((digest) => path.join(config.stateDir, "factory", "merge", digest, "resume.json")),
    );
  const retire = (id: string) =>
    store.pending.pipe(
      Effect.flatMap((pending) =>
        pending.some((entry) => entry.id === id) ? store.retireEffect(id) : Effect.void,
      ),
    );
  const operation = (id: string) =>
    store.snapshot.pipe(
      Effect.map((state) => state.mergeOperations.find((entry) => entry.id === id)),
    );
  const commit = (command: FactoryDecisionCommand) =>
    nowIso.pipe(Effect.flatMap((now) => store.commit({ actor: { kind: "system" }, command, now })));
  const finish = (
    pending: Store.PendingFactoryEffect,
    command: Parameters<typeof store.finishEffect>[0]["command"],
  ) => nowIso.pipe(Effect.flatMap((now) => store.finishEffect({ id: pending.id, command, now })));

  const hold = Effect.fn(function* (
    pending: Store.PendingFactoryEffect,
    id: string,
    reason: string,
    retry: Recovery = "same-vector",
  ) {
    const current = yield* operation(id);
    if (!current || ["stopped", "completed"].includes(current.lifecycle.phase)) {
      yield* retire(pending.id);
      return;
    }
    yield* commit({
      type: "merge.operation.held",
      operationId: id,
      commandId: CommandId.make(`${pending.id}:held:${yield* hash({ reason, retry })}`),
      reason: reason.slice(0, 6000),
      retry,
      recommendation:
        retry === "reconcile"
          ? "Read the host outcome again. An uncertain submission must not be repeated; preserve any confirmed merges."
          : retry === "new-review"
            ? "Review the changed evidence with the owning teams. Preserve confirmed merges; changing a partially merged vector needs a separately authorized recovery task."
            : retry === "none"
              ? "The bounded merge attempts are exhausted. Review actual outcomes and authorize any further recovery or revert as a separate task."
              : "Resolve the recorded restriction, then retry this unchanged reviewed operation. Confirmed members will not be submitted again.",
    });
    yield* retire(pending.id);
  });

  const saveTargets = Effect.fn(function* (
    current: FactoryMergeOperation,
    assignment: FactoryAssignment,
    preparationId: string,
  ) {
    const file = yield* location(current.id);
    if (yield* fs.exists(file)) return;
    const listed = yield* threads.listProjectThreads({
      projectId: assignment.projectId,
      includeSubagents: true,
    });
    const descendants = new Set<ThreadId>([assignment.threadId]);
    const state = yield* store.snapshot;
    for (const auxiliary of state.auxiliaryThreads.filter(
      (entry) => entry.assignmentId === assignment.id,
    ))
      descendants.add(auxiliary.threadId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const shell of listed)
        if (
          shell.lineage.relationshipToParent === "subagent" &&
          shell.lineage.parentThreadId &&
          descendants.has(shell.lineage.parentThreadId) &&
          !descendants.has(shell.id)
        ) {
          descendants.add(shell.id);
          changed = true;
        }
    }
    const threadIds: ThreadId[] = [];
    const queues: Array<{ threadId: ThreadId; runIds: RunId[] }> = [];
    for (const shell of listed.filter(
      (entry) => descendants.has(entry.id) && entry.deletedAt === null,
    )) {
      const records = yield* threads.getThreadRecords(shell.id, ["runs"]);
      if (
        records.runs.some((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        )
      )
        threadIds.push(shell.id);
      const runIds = records.runs
        .filter((run) => run.status === "queued" && !run.queueHeld)
        .map((run) => run.id);
      if (runIds.length) queues.push({ threadId: shell.id, runIds });
    }
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const temporary = `${file}.${yield* crypto.randomUUIDv4}`;
    const content = yield* encodeTargets({
      operationId: current.id,
      preparationId,
      threadIds,
      queues,
    });
    yield* fs.writeFileString(temporary, content, { flag: "wx" });
    yield* fs
      .rename(temporary, file)
      .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
  }, Effect.mapError(failure));

  const prepare = Effect.fn(function* (
    pending: Store.PendingFactoryEffect,
    current: FactoryMergeOperation,
  ) {
    if (current.lifecycle.phase !== "preparing") {
      yield* retire(pending.id);
      return;
    }
    const state = yield* store.snapshot;
    const assignment = state.assignments.find(
      (entry) => entry.id === current.integrationAssignmentId,
    );
    const review = state.mergeGroupReviews.find(
      (entry) => entry.id === current.reviewId,
    )?.lifecycle;
    if (!assignment?.grant || review?.phase !== "sealed")
      return yield* new FactoryError({ code: "invalid-state" });
    const preparationId = review.integrationPreparationId;
    yield* saveTargets(current, assignment, preparationId);
    const physical = yield* integration
      .stop({ integrationId: current.integrationId, preparationId, holdId: current.id })
      .pipe(Effect.result);
    const stopped = yield* Effect.forEach(
      [
        assignment.threadId,
        ...state.auxiliaryThreads
          .filter((entry) => entry.assignmentId === assignment.id)
          .map((entry) => entry.threadId),
      ],
      (threadId) =>
        handover.stopTeam({
          threadId,
          projectId: assignment.projectId,
          commandId: CommandId.make(`${pending.id}:stop:${threadId}`),
        }),
    ).pipe(Effect.result);
    if (Result.isFailure(physical)) return yield* physical.failure;
    if (Result.isFailure(stopped)) return yield* stopped.failure;
    for (const member of current.members)
      yield* inspection.refresh({
        assignmentId: member.reviewed.assignmentId,
        revisionId: member.reviewed.revisionId,
        commandId: CommandId.make(`${pending.id}:freeze-inspect:${member.reviewed.assignmentId}`),
      });
    const artifact = yield* integration.capture({
      integrationId: current.integrationId,
      preparationId,
    });
    const fresh = yield* store.snapshot;
    const latest = fresh.mergeOperations.find((entry) => entry.id === current.id);
    if (latest?.lifecycle.phase !== "preparing") {
      yield* retire(pending.id);
      return;
    }
    const evidence = factoryMergeGroupEvidence(fresh, current.groupId);
    const preparation = fresh.integrationPreparations.find(
      (entry) => entry.id === preparationId,
    )?.lifecycle;
    const owner = fresh.assignments.find((entry) => entry.id === assignment.id);
    if (
      !evidence.ready ||
      preparation?.phase !== "ready" ||
      !owner?.grant ||
      artifact.integrationId !== current.integrationId ||
      artifact.preparationId !== preparationId ||
      artifact.digest !== review.testArtifactDigest ||
      artifact.projects.some(
        (entry) => entry.changedPaths.length > 0 || entry.deletedPaths.length > 0,
      )
    )
      return yield* new FactoryError({
        code: "stale-revision",
        detail: !evidence.ready
          ? evidence.reasons.join(" ")
          : "The stopped integration bytes do not match the reviewed passing verification.",
      });
    const fields = {
      integrationPreparationId: preparationId,
      integrationVerificationId: review.integrationVerificationId,
      inputDigest: review.inputDigest,
      testArtifactDigest: review.testArtifactDigest,
      captureArtifactId: artifact.id,
      captureDigest: artifact.digest,
      coordinatorCapabilityId: preparation.manifest.coordinatorCapabilityId,
      coordinatorDigest: preparation.manifest.coordinatorDigest,
      integrationLeadThreadId: owner.threadId,
      integrationGrantEpoch: owner.grant.epoch,
      planIds: preparation.manifest.planIds,
      stoppedAt: yield* nowIso,
    };
    yield* finish(pending, {
      type: "merge.operation.frozen",
      commandId: CommandId.make(`${pending.id}:frozen:${fresh.revision}`),
      operationId: current.id,
      expectedStateRevision: fresh.revision,
      frozen: { ...fields, digest: factoryMergeFrozenDigest(latest, fields) },
    });
  });

  const observe = Effect.fn(function* (
    pending: Store.PendingFactoryEffect,
    current: FactoryMergeOperation,
    member: FactoryMergeOperationMember,
    mutationFailure?: unknown,
  ) {
    const ref = member.reviewed.ref;
    const detail = yield* pullRequests
      .invalidate({ reference: ref })
      .pipe(
        Effect.andThen(pullRequests.detail({ ...ref, allowStale: false })),
        Effect.mapError(failure),
      );
    let observation: Observation;
    const same =
      detail.number === ref.number &&
      detail.repository.toLowerCase() === ref.repository.toLowerCase() &&
      detail.headSha === member.reviewed.headSha &&
      detail.baseBranch === member.authority.targetBranch;
    if (detail.state === "merged" && same && detail.mergedAt && detail.mergeCommitSha) {
      observation = {
        phase: "confirmed",
        receipt: {
          id: `merge-receipt:${current.id}:${member.reviewed.assignmentId}`,
          operationId: current.id,
          assignmentId: member.reviewed.assignmentId,
          revisionId: member.reviewed.revisionId,
          ref,
          headSha: member.reviewed.headSha,
          targetBranch: member.authority.targetBranch,
          mergeCommitSha: detail.mergeCommitSha,
          mergedAt: detail.mergedAt,
          observedAt: yield* nowIso,
        },
      };
    } else if (detail.state === "open" && same) {
      if (member.outcome.phase === "pending") return "open" as const;
      const evidence = yield* pullRequests.inspectForMerge(ref).pipe(Effect.mapError(failure));
      const rejection = definitiveRejection(mutationFailure);
      const open =
        evidence.complete &&
        evidence.state === "open" &&
        evidence.headSha === member.reviewed.headSha &&
        evidence.baseBranch === member.authority.targetBranch &&
        evidence.autoMergeEnabled === false &&
        evidence.mergeQueueEnabled === false;
      observation = !open
        ? {
            phase: "unresolved",
            reason:
              "The host has not proved an exact open PR without a deferred merge instruction.",
            observedAt: yield* nowIso,
          }
        : rejection
          ? {
              phase: "rejected",
              classification: rejection,
              reason: failure(mutationFailure).message.slice(0, 6000),
              headSha: member.reviewed.headSha,
              targetBranch: member.authority.targetBranch,
              observedAt: yield* nowIso,
            }
          : {
              phase: "open",
              headSha: member.reviewed.headSha,
              targetBranch: member.authority.targetBranch,
              queued: false,
              observedAt: yield* nowIso,
            };
    } else {
      observation = {
        phase: "unresolved",
        reason:
          detail.state === "merged"
            ? "The host's merge fact lacks the exact reviewed head, target, timestamp or merge commit."
            : "The host PR changed identity or is no longer open; its merge outcome cannot be confirmed.",
        observedAt: yield* nowIso,
      };
    }
    yield* commit({
      type: "merge.operation.observed",
      operationId: current.id,
      assignmentId: member.reviewed.assignmentId,
      commandId: CommandId.make(`${pending.id}:observed:${yield* hash(observation)}`),
      ...(member.outcome.phase === "unknown" ? { attemptId: member.outcome.attemptId } : {}),
      observation,
    });
    return observation.phase;
  });

  const complete = Effect.fn(function* (pending: Store.PendingFactoryEffect, id: string) {
    const current = yield* operation(id);
    if (!current || current.lifecycle.phase === "completed") {
      yield* retire(pending.id);
      return true;
    }
    if (!current.members.every((member) => member.outcome.phase === "confirmed")) return false;
    if (!factoryMergeFrozenProof(current)) return false;
    yield* finish(pending, {
      type: "merge.operation.completed",
      commandId: CommandId.make(`${current.id}:completed`),
      operationId: current.id,
      receiptDigest: factoryMergeReceiptDigest(current),
    });
    return true;
  });

  const reconcile = Effect.fn(function* (
    pending: Store.PendingFactoryEffect,
    current: FactoryMergeOperation,
  ) {
    for (const member of current.members.filter((entry) => entry.outcome.phase !== "confirmed")) {
      const latest = yield* operation(current.id);
      const target = latest?.members.find(
        (entry) => entry.reviewed.assignmentId === member.reviewed.assignmentId,
      );
      if (latest && target && target.outcome.phase !== "confirmed")
        yield* observe(pending, latest, target);
    }
    if (!(yield* complete(pending, current.id))) yield* retire(pending.id);
  });

  const advance = Effect.fn(function* (
    pending: Store.PendingFactoryEffect,
    current: FactoryMergeOperation,
  ) {
    if (yield* complete(pending, current.id)) return;
    if (current.lifecycle.phase !== "running") {
      yield* retire(pending.id);
      return;
    }
    if (current.members.some((member) => member.outcome.phase === "unknown")) {
      yield* reconcile(pending, current);
      return;
    }
    for (const member of current.members.filter((entry) => entry.outcome.phase !== "confirmed")) {
      const outcome = yield* observe(pending, current, member);
      if (outcome !== "open") {
        yield* retire(pending.id);
        return;
      }
      yield* inspection.refresh({
        assignmentId: member.reviewed.assignmentId,
        revisionId: member.reviewed.revisionId,
        commandId: CommandId.make(`${pending.id}:preflight:${member.reviewed.assignmentId}`),
      });
    }
    if (yield* complete(pending, current.id)) return;
    const state = yield* store.snapshot;
    const fresh = state.mergeOperations.find((entry) => entry.id === current.id);
    const member = fresh?.members.find((entry) => entry.outcome.phase !== "confirmed");
    if (!fresh || !member || fresh.lifecycle.phase !== "running") {
      yield* retire(pending.id);
      return;
    }
    const readiness = factoryMergeOperationWriteReadiness(
      state,
      current.id,
      member.reviewed.assignmentId,
    );
    if (!readiness.allowed) {
      yield* hold(
        pending,
        current.id,
        readiness.reasons.join(" "),
        member.attempts >= 3 ? "none" : "same-vector",
      );
      return;
    }
    const attemptId = `${fresh.id}:${member.reviewed.assignmentId}:${member.attempts + 1}`;
    yield* finish(pending, {
      type: "merge.operation.submitting",
      operationId: fresh.id,
      commandId: CommandId.make(`${pending.id}:submitting:${member.attempts + 1}`),
      assignmentId: member.reviewed.assignmentId,
      attemptId,
      expectedAttempt: member.attempts,
      expectedStateRevision: state.revision,
      evidenceDigest: fresh.lifecycle.frozen.digest,
    });
    const mutation = yield* pullRequests
      .runAction({
        ...member.reviewed.ref,
        action: "merge",
        expectedHeadSha: member.reviewed.headSha,
      })
      .pipe(
        Effect.provideService(FactoryMergeGroupPermit, {
          groupId: fresh.groupId,
          operationId: fresh.id,
          assignmentId: member.reviewed.assignmentId,
          revisionId: member.reviewed.revisionId,
          attemptId,
          expectedHeadSha: member.reviewed.headSha,
          frozenDigest: fresh.lifecycle.frozen.digest,
        }),
        Effect.result,
      );
    const submitted = yield* operation(fresh.id);
    const target = submitted?.members.find(
      (entry) => entry.reviewed.assignmentId === member.reviewed.assignmentId,
    );
    if (submitted && target && target.outcome.phase !== "confirmed")
      yield* observe(
        pending,
        submitted,
        target,
        Result.isFailure(mutation) ? mutation.failure : undefined,
      );
  });

  const resume = Effect.fn(function* (
    pending: Store.PendingFactoryEffect,
    current: FactoryMergeOperation,
  ) {
    if (
      current.lifecycle.phase !== "stopped" ||
      current.members.some((member) => member.outcome.phase !== "pending")
    ) {
      yield* retire(pending.id);
      return;
    }
    const file = yield* location(current.id);
    if (!(yield* fs.exists(file))) {
      yield* retire(pending.id);
      return;
    }
    const targets = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeTargets));
    if (targets.operationId !== current.id)
      return yield* new FactoryError({ code: "invalid-state" });
    const state = yield* store.snapshot;
    const assignment = state.assignments.find(
      (entry) => entry.id === current.integrationAssignmentId,
    );
    const currentPreparationId = state.integrations.find(
      (entry) => entry.id === current.integrationId,
    )?.currentPreparationId;
    if (
      !assignment ||
      assignment.outcome ||
      assignment.status === "complete" ||
      currentPreparationId !== targets.preparationId
    ) {
      yield* retire(pending.id);
      return;
    }
    yield* access.assertExecution(assignment.threadId);
    yield* integration.release({
      integrationId: current.integrationId,
      preparationId: targets.preparationId,
      holdId: current.id,
    });
    let held = false;
    for (const threadId of new Set([
      ...targets.threadIds,
      ...targets.queues.map((entry) => entry.threadId),
    ])) {
      const shell = yield* threads.getThreadShell(threadId);
      if (
        !shell ||
        shell.deletedAt !== null ||
        shell.archivedAt !== null ||
        assignment.previousLeadThreadIds?.includes(threadId)
      )
        continue;
      const member = yield* access.membership(threadId);
      if (member?.assignmentId !== assignment.id) continue;
      const allowed = yield* access
        .assertDirection({ threadId, senderThreadId: null })
        .pipe(Effect.result);
      if (Result.isFailure(allowed)) {
        held = true;
        continue;
      }
      if (targets.threadIds.includes(threadId)) {
        const messageId = MessageId.make(`factory:merge-resume:${current.id}:${threadId}`);
        const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
          messageIds: [messageId],
        });
        if (
          !records.messages.some(
            (message) =>
              message.id === messageId && records.runs.some((run) => run.id === message.runId),
          )
        )
          yield* threads.sendToThread({
            threadId,
            projectId: assignment.projectId,
            messageId,
            commandId: CommandId.make(`${pending.id}:continue:${threadId}`),
            text: "The shared merge operation stopped without any confirmed or uncertain merge. Review the recorded reason and current integration evidence before continuing. Other project controls and permissions still apply.",
            attachments: [],
            mode: "queue",
            createdBy: "system",
            creationSource: "server",
          });
      }
      const queue = targets.queues.find((entry) => entry.threadId === threadId);
      if (queue?.runIds.length)
        yield* threads.dispatch({
          type: "queue.resume",
          threadId,
          runIds: queue.runIds,
          commandId: CommandId.make(`${pending.id}:queue:${threadId}`),
        });
    }
    if (!held) yield* retire(pending.id);
  });

  const handle = Effect.fn("FactoryMergeOperationEffects.handle")(function* (
    pending: Store.PendingFactoryEffect,
  ) {
    if (!pending.intent.type.startsWith("merge.operation.") || !("operationId" in pending.intent))
      return;
    const id = pending.intent.operationId;
    yield* lock(id).withPermit(
      Effect.gen(function* () {
        if (!(yield* store.pending).some((entry) => entry.id === pending.id)) return;
        const current = yield* operation(id);
        if (!current) {
          yield* retire(pending.id);
          return;
        }
        yield* store.beginEffect(pending.id);
        const result = yield* Effect.gen(function* () {
          switch (pending.intent.type) {
            case "merge.operation.prepare":
              return yield* prepare(pending, current);
            case "merge.operation.advance":
              return yield* advance(pending, current);
            case "merge.operation.reconcile":
              return yield* reconcile(pending, current);
            case "merge.operation.resume":
              return yield* resume(pending, current);
          }
        }).pipe(Effect.result);
        if (Result.isFailure(result)) {
          if (pending.intent.type === "merge.operation.resume") return;
          const latest = yield* operation(id);
          const error = failure(result.failure);
          yield* hold(
            pending,
            id,
            error.detail ?? error.message,
            latest?.members.some((member) => member.outcome.phase === "unknown")
              ? "reconcile"
              : error.code === "stale-revision"
                ? "new-review"
                : "same-vector",
          );
        }
      }),
    );
  }, Effect.mapError(failure));
  return FactoryMergeOperationEffects.of({ handle });
});

export const layer = Layer.effect(FactoryMergeOperationEffects, make).pipe(
  Layer.provide(Inspection.layer),
);
