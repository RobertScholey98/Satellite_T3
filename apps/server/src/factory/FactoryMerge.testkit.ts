import {
  CommandId,
  ThreadId,
  type FactoryDecisionCommand,
  type FactoryMergeReviewMember,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decide, type FactoryActor } from "./FactoryState.ts";
import { factoryMergeGroupEvidence } from "./FactoryMerge.ts";
import { verified, integrated, api } from "./FactoryIntegration.testkit.ts";
import { deliveryIds, deliveryNow } from "./FactoryDelivery.testkit.ts";

export { integrated, api, deliveryIds, deliveryNow };
let sequence = 0;
export const mergeCommandId = () => CommandId.make(`merge-domain-${++sequence}`);
export const applyMerge = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = { kind: "human" },
) => Result.getOrThrow(decide({ state, command, actor, now: deliveryNow }));

export function mergeFixture() {
  const base = verified();
  const assignments = base.state.assignments.map((assignment) => {
    if (assignment.integrationId || !assignment.delivery) return assignment;
    const revisions = assignment.delivery.revisions.map((revision) => {
      const headSha = `head-${assignment.id}`;
      return {
        ...revision,
        status: "published" as const,
        publication: {
          reservationId: `reservation-${assignment.id}`,
          host: "github.com",
          repository: `owner/${assignment.projectId}`,
          branch: `factory/${assignment.id}`,
          baseBranch: "main",
          headSha,
          treeOid: `tree-${assignment.id}`,
          ref: {
            projectId: assignment.projectId,
            host: "github.com",
            repository: `owner/${assignment.projectId}`,
            number: assignment.id === api.assignment ? 21 : 20,
          },
        },
        verification: {
          artifactId: `checks-${assignment.id}`,
          sourceDigest: revision.candidateDigest!,
          passed: true,
          checkedAt: deliveryNow,
        },
        reviews: [
          {
            id: `review-${assignment.id}`,
            threadId: ThreadId.make(`reviewer-${assignment.id}`),
            candidateDigest: revision.candidateDigest!,
            status: "passed" as const,
            confirmsImpact: true,
            findings: "Current candidate and impact passed",
            evidence: [],
          },
        ],
        hostEvidence: {
          headSha,
          baseSha: `base-${assignment.id}`,
          complete: true,
          checks: "passed" as const,
          reviews: "passed" as const,
          mergeable: true,
          conditionalMerge: true,
          reasons: [],
          observedAt: deliveryNow,
        },
        bundleDigest: `bundle-${assignment.id}`,
      };
    });
    return {
      ...assignment,
      delivery: {
        ...assignment.delivery,
        revisions,
        impact: {
          classification: "none" as const,
          changedFlows: false,
          journeys: "",
          navigation: "",
          layout: "",
          sharedComponents: "",
          summary: "Server behavior",
          evidence: [],
        },
      },
    };
  });
  const state: FactorySnapshot = {
    ...base.state,
    assignments,
    integrationPreparations: base.state.integrationPreparations.map((preparation) =>
      preparation.lifecycle.phase !== "ready"
        ? preparation
        : {
            ...preparation,
            lifecycle: {
              ...preparation.lifecycle,
              manifest: {
                ...preparation.lifecycle.manifest,
                inputs: preparation.lifecycle.manifest.inputs.map((input) => {
                  const revision = assignments.find((entry) => entry.id === input.assignmentId)!
                    .delivery!.revisions[0]!;
                  return {
                    ...input,
                    publication: {
                      kind: "published-head" as const,
                      ref: revision.publication!.ref!,
                      headSha: revision.publication!.headSha,
                      baseSha: revision.hostEvidence!.baseSha,
                      treeOid: revision.publication!.treeOid,
                    },
                  };
                }),
              },
            },
          },
    ),
  };
  return { ...base, state, groupId: state.mergeGroups[0]!.id };
}

export function requestMergeReview(state: FactorySnapshot, groupId: string) {
  return applyMerge(
    state,
    { type: "merge.group.review", commandId: mergeCommandId(), groupId },
    { kind: "thread", threadId: integrated.lead },
  );
}

export function sealMergeReview(state: FactorySnapshot, groupId: string, reviewId: string) {
  const evidence = factoryMergeGroupEvidence(state, groupId);
  if (!evidence.ready) throw new Error(evidence.reasons.join(" "));
  return applyMerge(
    state,
    {
      type: "merge.group.inspected",
      commandId: mergeCommandId(),
      groupId,
      reviewId,
      expectedStateRevision: state.revision,
      digest: `digest-${reviewId}`,
      members: evidence.members,
      integrationVerificationId: evidence.integrationVerificationId,
      integrationPreparationId: evidence.integrationPreparationId,
      inputDigest: evidence.inputDigest,
      testArtifactDigest: evidence.testArtifactDigest,
    },
    { kind: "system" },
  );
}

export function reviewedMergeFixture() {
  const base = mergeFixture();
  const requested = requestMergeReview(base.state, base.groupId);
  const reviewId = requested.result.mergeGroupReviewId!;
  const sealed = sealMergeReview(requested.state, base.groupId, reviewId);
  return { ...base, ...sealed, reviewId, reviewDigest: `digest-${reviewId}` };
}

export function mergeReviewMembers(
  state: FactorySnapshot,
  groupId: string,
): readonly FactoryMergeReviewMember[] {
  const evidence = factoryMergeGroupEvidence(state, groupId);
  if (!evidence.ready) throw new Error(evidence.reasons.join(" "));
  return evidence.members;
}
