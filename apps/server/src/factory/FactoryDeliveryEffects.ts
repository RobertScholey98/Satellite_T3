import {
  CommandId,
  FactoryError,
  MessageId,
  type FactoryDeliveryEffectIntent,
  type FactoryHostCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { FactoryControlAccess } from "./FactoryControlAccess.ts";
import { factoryIncidentBlocked } from "./FactoryCollaboration.ts";
import { factoryExecutionBlocked } from "./FactoryControls.ts";
import * as FactoryDeliveryInspection from "./FactoryDeliveryInspection.ts";
import { factoryMergeGroupForAssignment } from "./FactoryMergeOwnership.ts";
import { factoryDeliveryReadiness } from "./FactoryDelivery.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import { FactoryPublicationHost } from "./FactoryPublicationHost.ts";
import { FactoryDeliveryPermit } from "./FactoryPullRequestGate.ts";
import { FactoryStore, type PendingFactoryEffect } from "./FactoryStore.ts";

export class FactoryDeliveryEffects extends Context.Service<
  FactoryDeliveryEffects,
  { readonly handle: (pending: PendingFactoryEffect) => Effect.Effect<void, FactoryError> }
>()("t3/factory/FactoryDeliveryEffects") {}

class DeliveryStopped extends Schema.TaggedError<DeliveryStopped>()("DeliveryStopped", {
  disposition: Schema.Literals(["held", "superseded"]),
}) {}
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const isFactoryError = Schema.is(FactoryError);
const isStopped = Schema.is(DeliveryStopped);
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });
type DeliveryIntent = Exclude<
  FactoryDeliveryEffectIntent,
  { type: "delivery.preview.start" | "delivery.preview.stop" }
>;
const deliveryIntent = (pending: PendingFactoryEffect): DeliveryIntent | undefined =>
  [
    "delivery.capture",
    "delivery.publish",
    "delivery.review.launch",
    "delivery.inspect",
    "delivery.merge",
    "delivery.flow.hold",
    "delivery.flow.capture",
  ].includes(pending.intent.type)
    ? (pending.intent as DeliveryIntent)
    : undefined;

const make = Effect.gen(function* () {
  const store = yield* FactoryStore;
  const inspection = yield* FactoryDeliveryInspection.FactoryDeliveryInspection;
  const boundaries = yield* FactoryBoundaryExecution;
  const publication = yield* FactoryPublicationHost;
  const pullRequests = yield* PullRequestService;
  const threads = yield* ThreadManagementService;
  const execution = yield* FactoryExecution;
  const access = yield* FactoryControlAccess;
  const handovers = yield* FactoryHandover;
  const crypto = yield* Crypto.Crypto;
  const hash = (value: unknown) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(stableStringify(value)))
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
  const commit = (command: FactoryHostCommand) =>
    Effect.flatMap(nowIso, (now) => store.commit({ actor: { kind: "system" }, now, command }));

  const accepted = Effect.fn("FactoryDeliveryEffects.accepted")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    if ((yield* threads.getThreadShell(threadId)) === null) return false;
    const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
      messageIds: [messageId],
    });
    const message = records.messages.find((entry) => entry.id === messageId);
    if (!message) return false;
    if (!records.runs.some((run) => run.id === message.runId))
      return yield* new FactoryError({ code: "launch-failed" });
    return true;
  }, Effect.mapError(failure));

  const handle = Effect.fn("FactoryDeliveryEffects.handle")(function* (
    pending: PendingFactoryEffect,
  ) {
    const intent = deliveryIntent(pending);
    if (!intent) return;
    const attempt = pending.attempts + 1;
    const receiptId = CommandId.make(`${pending.id}:receipt`);
    let epoch: number | undefined;
    const readCurrent = Effect.gen(function* () {
      const state = yield* store.snapshot;
      const assignment = state.assignments.find((entry) => entry.id === intent.assignmentId);
      if (
        !assignment ||
        assignment.outcome ||
        assignment.status === "complete" ||
        !assignment.grant ||
        !assignment.startingSource
      )
        return yield* new DeliveryStopped({ disposition: "superseded" });
      epoch ??= assignment.grant.epoch;
      if (assignment.grant.epoch !== epoch)
        return yield* new DeliveryStopped({ disposition: "superseded" });
      const revision =
        "revisionId" in intent
          ? assignment.delivery?.revisions.find((entry) => entry.id === intent.revisionId)
          : undefined;
      if (
        "revisionId" in intent &&
        (!revision ||
          assignment.delivery?.currentRevisionId !== revision.id ||
          revision.grantEpoch !== assignment.grant.epoch ||
          revision.boundaryId !== assignment.grant.boundaryId ||
          revision.startingSourceId !== assignment.startingSource.id ||
          revision.workflowRevision !== assignment.workflow.revision)
      )
        return yield* new DeliveryStopped({ disposition: "superseded" });
      if (
        intent.type === "delivery.inspect" &&
        ["requested", "unknown", "merged"].includes(revision?.merge?.status ?? "")
      )
        return yield* new DeliveryStopped({ disposition: "superseded" });
      const flow = assignment.delivery?.flow;
      if (
        "holdId" in intent &&
        (!flow ||
          flow.holdId !== intent.holdId ||
          (intent.type === "delivery.flow.capture" &&
            (flow.status !== "held" || flow.pendingArtifactId !== intent.artifactId)) ||
          (intent.type === "delivery.flow.hold" &&
            flow.status !== (intent.held ? "stopping" : "releasing")))
      )
        return yield* new DeliveryStopped({ disposition: "superseded" });
      const blocked =
        factoryIncidentBlocked(state, assignment.id, "delivery") ??
        factoryExecutionBlocked(state, {
          threadId: assignment.threadId,
          managerId: assignment.managerId,
          projectId: assignment.projectId,
          assignmentId: assignment.id,
          ancestorThreadIds: [],
        });
      const ownsFlowWait =
        assignment.wait?.kind === "flow-review" &&
        (intent.type === "delivery.flow.capture" || intent.type === "delivery.flow.hold") &&
        assignment.wait.holdId === intent.holdId &&
        assignment.wait.artifactId ===
          (intent.type === "delivery.flow.capture" ? intent.artifactId : flow?.artifactId);
      if (
        blocked ||
        revision?.error ||
        ("holdId" in intent && flow?.error) ||
        (assignment.wait && assignment.wait.kind !== "review" && !ownsFlowWait)
      )
        return yield* new DeliveryStopped({ disposition: "held" });
      return { state, assignment, revision };
    });
    const readRevision = Effect.gen(function* () {
      const current = yield* readCurrent;
      if (!current.revision) return yield* new FactoryError({ code: "invalid-state" });
      return { ...current, revision: current.revision };
    });
    const readMergeOperation = Effect.gen(function* () {
      const state = yield* store.snapshot;
      const assignment = state.assignments.find((entry) => entry.id === intent.assignmentId);
      const revision =
        "revisionId" in intent
          ? assignment?.delivery?.revisions.find((entry) => entry.id === intent.revisionId)
          : undefined;
      if (
        intent.type !== "delivery.merge" ||
        !assignment ||
        !revision ||
        revision.merge?.operationId !== intent.operationId
      )
        return yield* new DeliveryStopped({ disposition: "superseded" });
      return { state, assignment, revision };
    });
    const finish = (command: Parameters<typeof store.finishEffect>[0]["command"]) =>
      Effect.flatMap(nowIso, (now) => store.finishEffect({ id: pending.id, command, now }));

    const sealInspection = Effect.fn("FactoryDeliveryEffects.sealInspection")(function* () {
      if (!("revisionId" in intent)) return yield* new FactoryError({ code: "invalid-state" });
      for (let sealAttempt = 0; sealAttempt < 3; sealAttempt++) {
        const sealed = yield* Effect.gen(function* () {
          yield* readRevision;
          const inspected = yield* inspection.inspect({
            assignmentId: intent.assignmentId,
            revisionId: intent.revisionId,
          });
          const command = {
            type: "delivery.inspected" as const,
            commandId: receiptId,
            ...inspected,
          };
          yield* finish(command);
        }).pipe(Effect.result);
        if (Result.isSuccess(sealed)) return;
        if (!isFactoryError(sealed.failure) || sealed.failure.code !== "stale-revision")
          return yield* sealed.failure;
      }
      // Another persisted event will wake this outbox. Never attach a stale seal.
      return yield* new DeliveryStopped({ disposition: "held" });
    });

    const result = yield* Effect.gen(function* () {
      const initial = yield* intent.type === "delivery.merge" ? readMergeOperation : readCurrent;
      yield* store.beginEffect(pending.id);
      switch (intent.type) {
        case "delivery.capture": {
          const { assignment, revision } = yield* readRevision;
          if (revision.status !== "capturing")
            return yield* new DeliveryStopped({ disposition: "superseded" });
          const candidate = yield* boundaries.captureCandidate({
            assignmentId: assignment.id,
            expectedEpoch: revision.grantEpoch,
            commandId: CommandId.make(revision.operationId),
            selectedPaths: revision.selectedPaths,
          });
          const fresh = yield* readRevision;
          const destination = yield* publication.prepare({
            assignment: fresh.assignment,
            revision: fresh.revision,
            candidate,
          });
          yield* readRevision;
          const finalized = yield* boundaries.finalizeCandidate({
            assignmentId: assignment.id,
            expectedEpoch: revision.grantEpoch,
            candidateId: candidate.id,
            reservationId: destination.reservationId,
          });
          yield* readRevision;
          if (
            !finalized.finalized ||
            finalized.finalized.commitOid !== destination.headSha ||
            finalized.finalized.treeOid !== destination.treeOid
          )
            return yield* new FactoryError({
              code: "invalid-state",
              detail: "The finalized candidate does not match its private publication.",
            });
          const verification = yield* boundaries.verifyCandidate({
            assignmentId: assignment.id,
            expectedEpoch: revision.grantEpoch,
            candidateId: candidate.id,
          });
          yield* readRevision;
          if (
            verification.sourceDigest !== finalized.finalized.sourceDigest ||
            verification.epoch !== revision.grantEpoch ||
            verification.boundaryId !== revision.boundaryId
          )
            return yield* new FactoryError({
              code: "invalid-state",
              detail: "Verification belongs to a different candidate or authority.",
            });
          yield* finish({
            type: "delivery.captured",
            commandId: receiptId,
            assignmentId: assignment.id,
            revisionId: revision.id,
            candidateId: candidate.id,
            candidateDigest: finalized.finalized.sourceDigest,
            publication: destination,
            verification: {
              artifactId: verification.artifactId,
              sourceDigest: verification.sourceDigest,
              passed: verification.gates.every((gate) => gate.status === "passed"),
              checkedAt: verification.checkedAt,
            },
          });
          return;
        }
        case "delivery.publish": {
          const { assignment, revision } = yield* readRevision;
          if (revision.status !== "publishing")
            return yield* new DeliveryStopped({ disposition: "superseded" });
          const ref = yield* publication.publish({
            assignment,
            revision,
            title: intent.title,
            body: intent.body,
          });
          yield* readRevision;
          yield* finish({
            type: "delivery.published",
            commandId: receiptId,
            assignmentId: assignment.id,
            revisionId: revision.id,
            ref,
          });
          return;
        }
        case "delivery.review.launch": {
          const messageId = MessageId.make(
            `factory:${intent.threadId}:delivery-review:${intent.reviewId}`,
          );
          const wasAccepted = yield* accepted(intent.threadId, messageId);
          let current = yield* readRevision;
          const reviewer = current.state.auxiliaryThreads.find(
            (entry) => entry.threadId === intent.threadId,
          );
          const review = current.revision.reviews.find(
            (entry) => entry.id === intent.reviewId && entry.threadId === intent.threadId,
          );
          if (
            !review ||
            !reviewer ||
            reviewer.kind !== "delivery-review" ||
            reviewer.assignmentId !== intent.assignmentId ||
            reviewer.revisionId !== intent.revisionId ||
            reviewer.incidentId !== intent.reviewId ||
            reviewer.sourceDigest !== current.revision.candidateDigest ||
            !current.revision.candidateId
          )
            return yield* new DeliveryStopped({ disposition: "superseded" });
          let profileId =
            reviewer.qualification?.status === "qualified"
              ? reviewer.qualification.profileId
              : undefined;
          if (profileId === undefined) {
            if (wasAccepted) return yield* new FactoryError({ code: "invalid-state" });
            const inspected = yield* boundaries.inspectCandidate({
              assignmentId: current.assignment.id,
              expectedEpoch: current.revision.grantEpoch,
              candidateId: current.revision.candidateId,
              threadId: intent.threadId,
            });
            current = yield* readRevision;
            if (inspected.sourceDigest !== current.revision.candidateDigest)
              return yield* new FactoryError({ code: "invalid-state" });
            profileId = inspected.qualification.profileId;
            yield* commit({
              type: "delivery.review.prepared",
              commandId: CommandId.make(`${pending.id}:prepared`),
              assignmentId: intent.assignmentId,
              revisionId: intent.revisionId,
              reviewId: intent.reviewId,
              profileId,
            });
          }
          if (!wasAccepted) {
            current = yield* readRevision;
            yield* access.assertDirection({
              threadId: intent.threadId,
              senderThreadId: current.assignment.threadId,
            });
            yield* execution.assertSelectionFor(intent.threadId, reviewer.modelSelection);
            const profile = yield* execution.runtimePolicyFor(intent.threadId);
            if (
              !profile ||
              profile.inspection === undefined ||
              profile.inspection?.candidateId !== current.revision.candidateId ||
              profile.inspection.sourceDigest !== current.revision.candidateDigest
            )
              return yield* new FactoryError({ code: "execution-unavailable" });
            const shell = yield* threads.getThreadShell(intent.threadId);
            if (
              shell &&
              (shell.projectId !== current.assignment.projectId ||
                shell.deletedAt !== null ||
                shell.archivedAt !== null ||
                shell.worktreePath !== profile.projectSnapshotPath)
            )
              return yield* new FactoryError({ code: "invalid-state" });
            current = yield* readRevision;
            if (!shell)
              yield* threads.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`${pending.id}:create`),
                threadId: intent.threadId,
                projectId: current.assignment.projectId,
                title: `Review: ${current.assignment.title}`,
                modelSelection: reviewer.modelSelection,
                runtimeMode: "approval-required",
                interactionMode: "default",
                branch: null,
                worktreePath: profile.projectSnapshotPath,
                createdBy: "system",
                creationSource: "server",
              });
            current = yield* readRevision;
            yield* access.assertDirection({
              threadId: intent.threadId,
              senderThreadId: current.assignment.threadId,
            });
            yield* execution.assertSelectionFor(intent.threadId, reviewer.modelSelection);
            const text = [
              `Independently review delivery revision ${intent.revisionId} for assignment ${intent.assignmentId}. Your implementation lead is ${current.assignment.threadId}.`,
              `The read-only candidate at /workspace has digest ${current.revision.candidateDigest}; /workflow is pinned to ${current.assignment.workflow.revision}. Review only this candidate.`,
              `Task: ${stableStringify(current.assignment.scope)}. Impact declaration: ${stableStringify(current.assignment.delivery?.impact)}.`,
              "Review correctness, architectural fit and UX consistency. For substantial UI work, exercise the actual isolated app and capture journey evidence and screenshots through the authorized preview workflow. Do not claim that reading source is app verification.",
              "For app verification, read factory_snapshot.previewConfigurations and use delivery.preview.start with your assignment, revision, reviewId, and an approved project configurationId. Wait for the host's ready message. Then use factory_preview_action to navigate an app-relative path and exercise a named journey, and factory_preview_snapshot to inspect actual page state and PNG images before and after the interaction. Use factory_preview_finish with the journey names before reporting your review. These tools bind evidence to this candidate and your authenticated reviewer identity. If no approved runtime can run the app, report that limitation and request changes; never substitute arbitrary screenshots or URLs.",
              `Report concrete findings and evidence with delivery.review.report, assignmentId ${intent.assignmentId}, revisionId ${intent.revisionId}, reviewId ${intent.reviewId}. Explicitly confirm or challenge the impact declaration. Request changes when required. The team owns the PR process; the engineering manager does not review it.`,
            ].join("\n\n");
            yield* threads
              .sendToThread({
                projectId: current.assignment.projectId,
                threadId: intent.threadId,
                commandId: CommandId.make(`${pending.id}:message`),
                messageId,
                senderThreadId: current.assignment.threadId,
                modelSelection: reviewer.modelSelection,
                text,
                attachments: [],
                mode: "auto",
                createdBy: "system",
                creationSource: "server",
              })
              .pipe(
                Effect.catch((cause) =>
                  accepted(intent.threadId, messageId).pipe(
                    Effect.flatMap((recorded) => (recorded ? Effect.void : Effect.fail(cause))),
                  ),
                ),
              );
          }
          yield* readRevision;
          yield* finish({
            type: "delivery.review.started",
            commandId: receiptId,
            assignmentId: intent.assignmentId,
            revisionId: intent.revisionId,
            reviewId: intent.reviewId,
            profileId,
          });
          return;
        }
        case "delivery.inspect": {
          yield* sealInspection();
          return;
        }
        case "delivery.merge": {
          let current = yield* readMergeOperation;
          const ref = current.revision.publication?.ref;
          if (!ref || current.revision.merge?.operationId !== intent.operationId)
            return yield* new DeliveryStopped({ disposition: "superseded" });
          const freshDetail = () =>
            pullRequests
              .invalidate({ reference: ref })
              .pipe(
                Effect.andThen(pullRequests.detail({ ...ref, allowStale: false })),
                Effect.mapError(failure),
              );
          let detail = yield* freshDetail();
          if (detail.state !== "merged") {
            const supersedeGroupedRequest = Effect.gen(function* () {
              const latest = yield* readMergeOperation;
              if (!factoryMergeGroupForAssignment(latest.state, intent.assignmentId)) return false;
              if (latest.revision.merge?.status !== "requested") return false;
              yield* finish({
                type: "delivery.merge.recorded",
                commandId: receiptId,
                assignmentId: intent.assignmentId,
                revisionId: intent.revisionId,
                operationId: intent.operationId,
                status: "failed",
                reason:
                  "The unsubmitted individual merge was superseded by its shared merge group.",
              });
              return true;
            });
            if (yield* supersedeGroupedRequest) return;
            if (current.revision.merge?.status === "unknown")
              return yield* new FactoryError({
                code: "execution-unavailable",
                detail:
                  "The previous merge acknowledgement is unknown and the host has not confirmed merge. Review the host state, then explicitly retry to resubmit this approved revision.",
              });
            current = yield* readRevision;
            if (current.revision.merge?.status !== "requested")
              return yield* new DeliveryStopped({ disposition: "superseded" });
            if (yield* supersedeGroupedRequest) return;
            yield* inspection.refresh({
              assignmentId: intent.assignmentId,
              revisionId: intent.revisionId,
              commandId: CommandId.make(`${pending.id}:inspect:${attempt}`),
            });
            current = yield* readRevision;
            const readiness = factoryDeliveryReadiness(
              current.state,
              current.assignment,
              current.revision,
            );
            const approval = current.revision.approval;
            if (
              readiness.reasons.length ||
              !approval ||
              (readiness.needsHuman && !readiness.humanApproved) ||
              approval.bundleDigest !== current.revision.bundleDigest ||
              approval.expectedHeadSha !== current.revision.publication?.headSha ||
              (approval.authority === "project-rule" &&
                (!readiness.ruleEligible || approval.ruleVersion !== readiness.ruleVersion))
            )
              return yield* new FactoryError({
                code: "permission-denied",
                detail:
                  readiness.reasons.join(" ") ||
                  "Fresh evidence changed the approved revision. Review and approve its current bundle.",
              });
            yield* commit({
              type: "delivery.merge.recorded",
              commandId: CommandId.make(`${pending.id}:submitting:${attempt}`),
              assignmentId: intent.assignmentId,
              revisionId: intent.revisionId,
              operationId: intent.operationId,
              status: "unknown",
              reason: "Conditional merge submission is awaiting host confirmation.",
            });
            current = yield* readRevision;
            const mutation = yield* pullRequests
              .runAction({ ...ref, action: "merge", expectedHeadSha: approval.expectedHeadSha })
              .pipe(
                Effect.provideService(FactoryDeliveryPermit, {
                  assignmentId: intent.assignmentId,
                  revisionId: intent.revisionId,
                  operationId: intent.operationId,
                }),
                Effect.result,
              );
            detail = yield* freshDetail();
            if (detail.state !== "merged")
              return yield* new FactoryError({
                code: "execution-unavailable",
                detail: Result.isFailure(mutation)
                  ? `Merge remains unconfirmed: ${mutation.failure.message}`
                  : "The host acknowledged the action but has not confirmed an actual merge.",
              });
          }
          current = yield* readMergeOperation;
          // Someone pushed and merged on the host: the approved revision was never delivered.
          // Close this operation so the lead can capture a new revision or conclude.
          if (
            detail.number === ref.number &&
            detail.headSha &&
            detail.headSha !== current.revision.publication?.headSha
          )
            return yield* finish({
              type: "delivery.merge.recorded",
              commandId: receiptId,
              assignmentId: intent.assignmentId,
              revisionId: intent.revisionId,
              operationId: intent.operationId,
              status: "failed",
              reason:
                "The pull request was merged on the host at a different head than the approved revision.",
            });
          if (
            !detail.headSha ||
            detail.headSha !== current.revision.publication?.headSha ||
            !detail.mergedAt ||
            detail.number !== ref.number
          )
            return yield* new FactoryError({
              code: "invalid-state",
              detail: "The host's merge fact belongs to another revision.",
            });
          const deliveryId = `delivery:${intent.operationId}`;
          const belongsToActiveAssignment = () =>
            Effect.map(store.snapshot, (snapshot) => {
              const owner = snapshot.assignments.find((entry) => entry.id === intent.assignmentId);
              return (
                owner !== undefined &&
                !owner.outcome &&
                owner.status !== "complete" &&
                owner.delivery?.currentRevisionId === intent.revisionId
              );
            });
          if (
            current.assignment.oversight?.delivery?.id !== deliveryId &&
            (yield* belongsToActiveAssignment())
          ) {
            yield* commit({
              type: "assignment.delivery.recorded",
              commandId: CommandId.make(`${pending.id}:delivered`),
              assignmentId: intent.assignmentId,
              delivery: {
                kind: "pull-request-merged",
                id: deliveryId,
                projectId: current.assignment.projectId,
                ref,
                headSha: detail.headSha,
                mergedAt: detail.mergedAt,
                observedAt: yield* nowIso,
              },
            }).pipe(
              Effect.catch((error) =>
                belongsToActiveAssignment().pipe(
                  Effect.flatMap((active) =>
                    !active && ["invalid-state", "permission-denied"].includes(error.code)
                      ? Effect.void
                      : Effect.fail(error),
                  ),
                ),
              ),
            );
          }
          yield* finish({
            type: "delivery.merge.recorded",
            commandId: receiptId,
            assignmentId: intent.assignmentId,
            revisionId: intent.revisionId,
            operationId: intent.operationId,
            status: "merged",
            mergedAt: detail.mergedAt,
          });
          return;
        }
        case "delivery.flow.hold": {
          const assignment = initial.assignment;
          yield* handovers.stopTeam({
            threadId: assignment.threadId,
            projectId: assignment.projectId,
            commandId: CommandId.make(`${pending.id}:stop`),
          });
          yield* readCurrent;
          const result = yield* boundaries.setDeliveryHold({
            assignmentId: assignment.id,
            threadId: assignment.threadId,
            expectedEpoch: assignment.grant!.epoch,
            holdId: intent.holdId,
            held: intent.held,
          });
          yield* readCurrent;
          if (intent.held && result === undefined)
            return yield* new FactoryError({ code: "execution-unavailable" });
          yield* finish({
            type: "delivery.flow.recorded",
            commandId: receiptId,
            assignmentId: assignment.id,
            holdId: intent.holdId,
            held: intent.held,
            ...result,
          });
          return;
        }
        case "delivery.flow.capture": {
          const artifact = { title: intent.title, content: intent.content, format: intent.format };
          const artifactDigest = yield* hash(artifact);
          yield* readCurrent;
          yield* finish({
            type: "delivery.flow.artifact",
            commandId: receiptId,
            assignmentId: intent.assignmentId,
            holdId: intent.holdId,
            artifactId: intent.artifactId,
            artifactDigest,
            artifact,
          });
          return;
        }
      }
    }).pipe(Effect.result);
    if (Result.isSuccess(result)) return;
    if (isStopped(result.failure)) {
      if (result.failure.disposition === "superseded") yield* store.retireEffect(pending.id);
      return;
    }
    const current = yield* (
      intent.type === "delivery.merge" ? readMergeOperation : readCurrent
    ).pipe(Effect.result);
    if (Result.isFailure(current)) {
      if (isStopped(current.failure)) {
        if (current.failure.disposition === "superseded") yield* store.retireEffect(pending.id);
        return;
      }
      return yield* current.failure;
    }
    const error = failure(result.failure);
    const reason = error.detail ?? error.message;
    if (current.success.revision?.error === reason) return;
    if ("revisionId" in intent)
      yield* commit({
        type: "delivery.effect.failed",
        commandId: CommandId.make(`${pending.id}:failed:${attempt}`),
        assignmentId: intent.assignmentId,
        revisionId: intent.revisionId,
        operationId: "operationId" in intent ? intent.operationId : pending.id,
        reason,
      });
    else
      yield* commit({
        type: "delivery.flow.failed",
        commandId: CommandId.make(`${pending.id}:failed:${attempt}`),
        assignmentId: intent.assignmentId,
        holdId: intent.holdId,
        reason,
      });
  });
  return FactoryDeliveryEffects.of({ handle });
});

export const layer = Layer.effect(FactoryDeliveryEffects, make).pipe(
  Layer.provide(FactoryDeliveryInspection.layer),
);
