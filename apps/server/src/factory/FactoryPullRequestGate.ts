import { FactoryError, type FactoryAssignmentId, type PullRequestRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FactoryStore } from "./FactoryStore.ts";
import {
  factoryMergeGroupForAssignment,
  factoryMergeGroupsForPullRequest,
} from "./FactoryMergeOwnership.ts";
import { factoryDeliveryReadiness } from "./FactoryDelivery.ts";
import { factoryMergeOperationWriteReadiness } from "./FactoryMergeOperation.ts";

export const FactoryDeliveryPermit = Context.Reference<{
  readonly assignmentId: FactoryAssignmentId;
  readonly revisionId: string;
  readonly operationId: string;
} | null>("t3/factory/FactoryDeliveryPermit", { defaultValue: () => null });

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
export class FactoryPullRequestGate extends Context.Service<
  FactoryPullRequestGate,
  {
    readonly appliesToRepository: (
      host: string,
      repository: string,
    ) => Effect.Effect<boolean, FactoryError>;
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
export const layer = Layer.effect(
  FactoryPullRequestGate,
  Effect.gen(function* () {
    const store = yield* FactoryStore;
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
          return { managed, requireConditionalMerge: managed };
        }),
    });
  }),
);
