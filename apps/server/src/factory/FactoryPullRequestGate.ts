import {
  FactoryError,
  type FactoryAssignmentId,
  type PullRequestActionInput,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestStack,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PullRequestActionGate from "../pullRequest/PullRequestActionGate.ts";
import * as FactoryStore from "./FactoryStore.ts";
import {
  factoryMergeGroupForAssignment,
  factoryMergeGroupsForPullRequest,
} from "./FactoryMergeOwnership.ts";
import { factoryDeliveryReadiness } from "./FactoryDelivery.ts";
import { factoryMergeOperationWriteReadiness } from "./FactoryMergeOperation.ts";

/**
 * Provided only by the delivery merge effect around its host merge, naming the operation it runs.
 * Without it the gate refuses every merge of a managed pull request.
 */
export const FactoryDeliveryPermit = Context.Reference<{
  readonly assignmentId: FactoryAssignmentId;
  readonly revisionId: string;
  readonly operationId: string;
} | null>("t3/factory/FactoryDeliveryPermit", { defaultValue: () => null });

/**
 * The merge-group counterpart: provided by the shared merge operation for one member's merge
 * attempt, bound to the operation's frozen digest and the member's reviewed head.
 */
export const FactoryMergeGroupPermit = Context.Reference<{
  readonly groupId: string;
  readonly operationId: string;
  readonly assignmentId: FactoryAssignmentId;
  readonly revisionId: string;
  readonly attemptId: string;
  readonly expectedHeadSha: string;
  readonly frozenDigest: string;
} | null>("t3/factory/FactoryMergeGroupPermit", { defaultValue: () => null });

interface MutationTarget {
  readonly ref: PullRequestRef;
  readonly headBranch: string;
  readonly headSha: string;
}
/**
 * Decides which pull-request actions may touch PRs that managed teams or merge groups own. A PR
 * is managed when a delivery revision published it (by number or branch) or a merge group knows
 * it. Ordinary PRs pass untouched.
 */
export class FactoryPullRequestGate extends Context.Service<
  FactoryPullRequestGate,
  {
    /** Cheap pre-check: whether any managed delivery work targets this repository at all. */
    readonly appliesToRepository: (
      host: string,
      repository: string,
    ) => Effect.Effect<boolean, FactoryError>;
    /**
     * Refuses unless every managed target may take this action. An individually managed PR takes
     * only a merge, under the delivery permit for its current revision's approved head; a grouped
     * PR merges only under the group permit, and may otherwise only be closed, reopened or have
     * auto-merge disabled. `requireConditionalMerge` asks the caller to pin the merge to the head.
     */
    readonly authorizeMutation: (input: {
      readonly action: string;
      readonly targets: ReadonlyArray<MutationTarget>;
      readonly expectedHeadSha?: string;
      readonly stack?: boolean;
    }) => Effect.Effect<
      { readonly managed: boolean; readonly requireConditionalMerge: boolean },
      FactoryError
    >;
  }
>()("t3/factory/FactoryPullRequestGate") {}

const canonicalHost = (host: string) => host.toLowerCase();
const canonicalRepository = (repository: string) => repository.toLowerCase();
const groupReversibleActions = new Set(["close", "reopen", "disable-auto-merge"]);
export const layer = Layer.effect(
  FactoryPullRequestGate,
  Effect.gen(function* () {
    const store = yield* FactoryStore.FactoryStore;
    return FactoryPullRequestGate.of({
      appliesToRepository: (host, repository) =>
        store.snapshot.pipe(
          Effect.map(
            (state) =>
              state.mergeGroups.some((group) =>
                group.knownPullRequests.some(
                  ({ ref }) =>
                    canonicalHost(ref.host ?? "github.com") === canonicalHost(host) &&
                    canonicalRepository(ref.repository) === canonicalRepository(repository),
                ),
              ) ||
              state.assignments.some((assignment) =>
                assignment.delivery?.revisions.some(
                  (revision) =>
                    revision.publication &&
                    canonicalHost(revision.publication.host) === canonicalHost(host) &&
                    canonicalRepository(revision.publication.repository) ===
                      canonicalRepository(repository),
                ),
              ),
          ),
        ),
      authorizeMutation: (input) =>
        Effect.gen(function* () {
          const state = yield* store.snapshot;
          const permit = yield* FactoryDeliveryPermit;
          const groupPermit = yield* FactoryMergeGroupPermit;
          let managed = false;
          for (const target of input.targets) {
            // Matching the branch as well as the number also catches a PR someone else opened
            // from a team's publication branch.
            const owners = state.assignments.flatMap((assignment) =>
              (assignment.delivery?.revisions ?? []).flatMap((revision) => {
                const publication = revision.publication;
                if (
                  !publication ||
                  canonicalHost(publication.host) !==
                    canonicalHost(target.ref.host ?? "github.com") ||
                  canonicalRepository(publication.repository) !==
                    canonicalRepository(target.ref.repository) ||
                  (publication.ref?.number !== target.ref.number &&
                    publication.branch !== target.headBranch)
                )
                  return [];
                return [{ assignment, revision }];
              }),
            );
            const groups = [
              ...factoryMergeGroupsForPullRequest(state, target.ref),
              ...owners.flatMap(({ assignment }) => {
                const group = factoryMergeGroupForAssignment(state, assignment.id);
                return group ? [group] : [];
              }),
            ];
            if (groups.length > 0) {
              // These never merge anything, and the shared action rereads the PR before each write.
              if (!input.stack && groupReversibleActions.has(input.action)) {
                managed = true;
                continue;
              }
              const refuse = () =>
                new FactoryError({
                  code: "permission-denied",
                  detail: `This pull request belongs to merge group ${groups[0]!.id}. Review the combined feature in its integration thread; individual merge, auto-merge, and stack actions are held.`,
                });
              const operation = state.mergeOperations.find(
                (entry) => entry.id === groupPermit?.operationId,
              );
              const member = operation?.members.find(
                (entry) => entry.reviewed.assignmentId === groupPermit?.assignmentId,
              );
              if (
                !groupPermit ||
                !operation ||
                !member ||
                input.action !== "merge" ||
                input.stack ||
                input.targets.length !== 1 ||
                new Set(groups.map((entry) => entry.id)).size !== 1 ||
                groups[0]!.id !== groupPermit.groupId ||
                operation.groupId !== groupPermit.groupId ||
                operation.lifecycle.phase !== "running" ||
                operation.lifecycle.frozen.digest !== groupPermit.frozenDigest ||
                member.outcome.phase !== "unknown" ||
                member.outcome.attemptId !== groupPermit.attemptId ||
                member.reviewed.revisionId !== groupPermit.revisionId ||
                member.reviewed.headSha !== groupPermit.expectedHeadSha ||
                input.expectedHeadSha !== groupPermit.expectedHeadSha ||
                target.headSha !== groupPermit.expectedHeadSha ||
                member.reviewed.ref.number !== target.ref.number ||
                canonicalHost(member.reviewed.ref.host ?? "github.com") !==
                  canonicalHost(target.ref.host ?? "github.com") ||
                canonicalRepository(member.reviewed.ref.repository) !==
                  canonicalRepository(target.ref.repository)
              )
                return yield* refuse();
              const readiness = factoryMergeOperationWriteReadiness(
                state,
                operation.id,
                member.reviewed.assignmentId,
              );
              if (!readiness.allowed)
                return yield* new FactoryError({
                  code: "permission-denied",
                  detail: readiness.reasons.join(" "),
                });
              managed = true;
              continue;
            }
            if (owners.length === 0) continue;
            managed = true;
            const current = owners.find(
              ({ assignment, revision }) => assignment.delivery?.currentRevisionId === revision.id,
            );
            const refuse = () =>
              new FactoryError({
                code: "permission-denied",
                detail: `This pull request belongs to a managed team. Open its implementation lead${current ? ` (${current.assignment.threadId})` : ""} to review the current revision and authorize its delivery.`,
              });
            if (
              !current ||
              input.stack ||
              input.action !== "merge" ||
              permit === null ||
              permit.assignmentId !== current.assignment.id ||
              permit.revisionId !== current.revision.id ||
              permit.operationId !== current.revision.merge?.operationId ||
              !["requested", "unknown"].includes(current.revision.merge.status) ||
              current.revision.publication?.ref?.number !== target.ref.number ||
              current.revision.publication.headSha !== target.headSha ||
              input.expectedHeadSha !== target.headSha
            )
              return yield* refuse();
            const readiness = factoryDeliveryReadiness(state, current.assignment, current.revision);
            const approval = current.revision.approval;
            if (
              readiness.reasons.length ||
              !approval ||
              approval.expectedHeadSha !== target.headSha ||
              approval.bundleDigest !== current.revision.bundleDigest ||
              (readiness.needsHuman && !readiness.humanApproved) ||
              (approval.authority === "project-rule" &&
                (!readiness.ruleEligible || approval.ruleVersion !== readiness.ruleVersion))
            )
              return yield* refuse();
          }
          // Hosts accept a head condition only on merges.
          return { managed, requireConditionalMerge: managed && input.action === "merge" };
        }),
    });
  }),
);

/**
 * Authorizes a pull-request action against managed delivery work. The pull-request service
 * supplies its uncached host reads. `beforeMutation` repeats the decision at the host's mutation
 * boundary, after any queueing.
 */
const authorizeFactoryPullRequestAction = <E>(
  gate: FactoryPullRequestGate["Service"],
  input: {
    readonly request: PullRequestActionInput;
    readonly ref: PullRequestRef & { readonly host: string };
    readonly readDetail: (ref: PullRequestRef) => Effect.Effect<PullRequestDetail, E>;
    readonly readStack: (ref: PullRequestRef) => Effect.Effect<PullRequestStack | null, E>;
  },
) =>
  Effect.gen(function* () {
    const { request, ref } = input;
    if (!(yield* gate.appliesToRepository(ref.host, ref.repository)))
      return {
        requireConditionalMerge: false,
        beforeMutation: gate.appliesToRepository(ref.host, ref.repository).pipe(
          Effect.flatMap((applies) =>
            applies
              ? Effect.fail(
                  new FactoryError({
                    code: "permission-denied",
                    detail:
                      "This repository acquired managed delivery work while the action was queued. Retry to inspect its current ownership before changing the pull request.",
                  }),
                )
              : Effect.void,
          ),
        ),
      };
    const stack = request.stackNumber === undefined ? null : yield* input.readStack(ref);
    const numbers = stack?.layers.map((entry) => entry.number) ?? [ref.number];
    if (
      request.stackNumber !== undefined &&
      (stack === null ||
        stack.number !== request.stackNumber ||
        !numbers.includes(ref.number) ||
        new Set(numbers).size !== numbers.length)
    )
      return yield* new FactoryError({
        code: "invalid-state",
        detail:
          "The complete requested stack must be inspected before changing a managed repository.",
      });
    const targets = yield* Effect.forEach(numbers, (number) =>
      Effect.gen(function* () {
        const targetRef = { ...ref, number };
        const detail = yield* input.readDetail(targetRef);
        if (
          !detail.headSha ||
          detail.number !== number ||
          detail.repository.toLowerCase() !== ref.repository.toLowerCase()
        )
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "The current pull request identity and head could not be verified.",
          });
        return { ref: targetRef, headBranch: detail.headBranch, headSha: detail.headSha };
      }),
    );
    // A stack action touches every open layer, so the caller must name each layer's current head.
    if (stack !== null) {
      const open = stack.layers.filter((entry) => entry.state === "open");
      const expected = request.expectedStackHeads ?? [];
      if (
        expected.length !== open.length ||
        new Set(expected.map((entry) => entry.number)).size !== open.length ||
        open.some(
          (entry) =>
            !expected.some(
              (head) =>
                head.number === entry.number &&
                targets.some(
                  (target) => target.ref.number === entry.number && target.headSha === head.headSha,
                ),
            ),
        )
      )
        return yield* new FactoryError({
          code: "stale-revision",
          detail: "The stack membership or head revisions changed before factory authorization.",
        });
    }
    const authorize = gate.authorizeMutation({
      action: request.action,
      targets,
      ...(request.expectedHeadSha === undefined
        ? {}
        : { expectedHeadSha: request.expectedHeadSha }),
      stack: request.stackNumber !== undefined,
    });
    const authorization = yield* authorize;
    return {
      requireConditionalMerge: authorization.requireConditionalMerge,
      beforeMutation: Effect.asVoid(authorize),
    };
  }).pipe(Effect.withSpan("FactoryPullRequestGate.authorizeAction"));

/** Managed delivery as the pull-request service's action gate. */
export const layerActionGate = Layer.effect(
  PullRequestActionGate.PullRequestActionGate,
  Effect.gen(function* () {
    const gate = yield* FactoryPullRequestGate;
    return PullRequestActionGate.PullRequestActionGate.of({
      authorize: (input) => authorizeFactoryPullRequestAction(gate, input),
    });
  }),
).pipe(Layer.provide(layer));
