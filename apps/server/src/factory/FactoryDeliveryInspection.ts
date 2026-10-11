import {
  CommandId,
  FactoryError,
  type FactoryAssignmentId,
  type FactoryRevisionHostEvidence,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import type { ProviderMergeEvidence } from "../pullRequest/pullRequestMergeEvidence.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { factoryIncidentBlocked } from "./FactoryCollaboration.ts";
import { factoryExecutionBlocked } from "./FactoryControls.ts";

type Revision = { readonly assignmentId: FactoryAssignmentId; readonly revisionId: string };
export class FactoryDeliveryInspection extends Context.Service<
  FactoryDeliveryInspection,
  {
    readonly inspect: (input: Revision) => Effect.Effect<
      Revision & {
        readonly evidence: FactoryRevisionHostEvidence;
        readonly bundleDigest: string;
        readonly expectedStateRevision: number;
      },
      FactoryError
    >;
    readonly refresh: (
      input: Revision & { readonly commandId: CommandId },
    ) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryDeliveryInspection") {}
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });
function hostEvidence(raw: ProviderMergeEvidence, observedAt: string): FactoryRevisionHostEvidence {
  const required = raw.checks.filter((check) => check.required !== false);
  const unknownChecks =
    !raw.complete ||
    required.some(
      (check) =>
        check.required === null || check.status === "unknown" || check.headSha !== raw.headSha,
    );
  const checks = unknownChecks
    ? "unknown"
    : required.some((check) => check.status === "failure")
      ? "failed"
      : required.some((check) => check.status === "pending")
        ? "pending"
        : "passed";
  const reviews = !raw.complete
    ? "unknown"
    : raw.reviewDecision === "changes-requested"
      ? "failed"
      : raw.reviewDecision === "review-required"
        ? "pending"
        : "passed";
  const mergeable =
    raw.complete &&
    raw.state === "open" &&
    !raw.isDraft &&
    raw.mergeability === "mergeable" &&
    ["CLEAN", "HAS_HOOKS"].includes(raw.mergeState);
  const conditionalMerge = !raw.autoMergeEnabled && !raw.mergeQueueEnabled;
  const reasons = [
    ...raw.issues,
    ...(checks === "passed" ? [] : [`Required hosting checks are ${checks}.`]),
    ...(reviews === "passed" ? [] : [`Required hosting reviews are ${reviews}.`]),
    ...(mergeable
      ? []
      : [`The host does not permit direct merge (${raw.state}, ${raw.mergeState}).`]),
    ...(conditionalMerge
      ? []
      : ["A merge queue or standing auto-merge instruction cannot preserve this approval."]),
  ];
  return {
    headSha: raw.headSha,
    baseSha: raw.baseSha,
    complete: raw.complete,
    checks,
    reviews,
    mergeable,
    conditionalMerge,
    reasons,
    observedAt,
  };
}

const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const hash = (value: unknown) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(stableStringify(value)))
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
  const readRevision = Effect.fn(function* (input: Revision) {
    const state = yield* store.snapshot;
    const assignment = state.assignments.find((entry) => entry.id === input.assignmentId);
    const revision = assignment?.delivery?.revisions.find((entry) => entry.id === input.revisionId);
    if (
      !assignment ||
      assignment.outcome ||
      assignment.status === "complete" ||
      !assignment.grant ||
      !assignment.startingSource ||
      !revision ||
      assignment.delivery?.currentRevisionId !== revision.id ||
      revision.grantEpoch !== assignment.grant.epoch ||
      revision.boundaryId !== assignment.grant.boundaryId ||
      revision.startingSourceId !== assignment.startingSource.id ||
      revision.workflowRevision !== assignment.workflow.revision
    )
      return yield* new FactoryError({
        code: "stale-revision",
        detail: "This delivery revision no longer matches its current execution grant and source.",
      });
    const blocked =
      factoryIncidentBlocked(state, assignment.id, "delivery") ??
      factoryExecutionBlocked(state, {
        threadId: assignment.threadId,
        managerId: assignment.managerId,
        projectId: assignment.projectId,
        assignmentId: assignment.id,
        ancestorThreadIds: [],
      });
    if (blocked || revision.error || (assignment.wait && assignment.wait.kind !== "review"))
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: blocked ?? revision.error ?? "This assignment is held.",
      });
    return { state, assignment, revision };
  });
  const inspect = Effect.fn("FactoryDeliveryInspection.inspect")(function* (input: Revision) {
    const current = yield* readRevision(input);
    const ref = current.revision.publication?.ref;
    if (!ref)
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "The delivery revision has no published pull request.",
      });
    const raw = yield* pullRequests.inspectForMerge(ref);
    const fresh = yield* readRevision(input);
    if (stableStringify(fresh.revision.publication?.ref) !== stableStringify(ref))
      return yield* new FactoryError({ code: "stale-revision" });
    const evidence = hostEvidence(raw, yield* nowIso);
    const revision = fresh.revision;
    // The bundle names what the human reviewed: the exact head and the outcome of its checks and
    // reviews. Base movement and merge state stay out, so an approval survives other merges;
    // the merge effect re-inspects and refuses unless the host permits merge at that moment.
    const bundleDigest = yield* hash({
      assignmentId: fresh.assignment.id,
      revisionId: revision.id,
      source: fresh.assignment.startingSource,
      grant: fresh.assignment.grant,
      workflow: fresh.assignment.workflow,
      candidateId: revision.candidateId,
      candidateDigest: revision.candidateDigest,
      publication: revision.publication,
      verification: revision.verification,
      reviews: revision.reviews,
      impact: fresh.assignment.delivery?.impact,
      flow: fresh.assignment.delivery?.flow,
      ux: revision.uxEvidence,
      publishedUx: revision.publishedUxEvidence,
      host: {
        headSha: evidence.headSha,
        baseBranch: raw.baseBranch,
        complete: evidence.complete,
        checks: evidence.checks,
        reviews: evidence.reviews,
      },
    });
    const sealed = yield* readRevision(input);
    if (sealed.state.revision !== fresh.state.revision)
      return yield* new FactoryError({ code: "stale-revision" });
    return { ...input, evidence, bundleDigest, expectedStateRevision: sealed.state.revision };
  }, Effect.mapError(failure));
  const refresh = Effect.fn("FactoryDeliveryInspection.refresh")(function* (
    input: Revision & { readonly commandId: CommandId },
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = yield* Effect.gen(function* () {
        const inspected = yield* inspect({
          assignmentId: input.assignmentId,
          revisionId: input.revisionId,
        });
        yield* store.commit({
          actor: { kind: "system" },
          now: yield* nowIso,
          command: {
            type: "delivery.inspected",
            commandId: CommandId.make(
              `${input.commandId}:${inspected.expectedStateRevision}:${inspected.bundleDigest}`,
            ),
            ...inspected,
          },
        });
      }).pipe(Effect.result);
      if (Result.isSuccess(result)) return;
      if (result.failure.code !== "stale-revision") return yield* result.failure;
    }
    return yield* new FactoryError({
      code: "stale-revision",
      detail: "Delivery evidence kept changing during inspection. Refresh it again.",
    });
  });
  return FactoryDeliveryInspection.of({ inspect, refresh });
});
export const layer = Layer.effect(FactoryDeliveryInspection, make);
