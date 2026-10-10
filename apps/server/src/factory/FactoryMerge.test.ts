import { assert, describe, it } from "@effect/vitest";
import {
  FactoryAssignmentId,
  ThreadId,
  type FactoryDecisionCommand,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decide, type FactoryActor } from "./FactoryState.ts";
import { factoryMergeGroupEvidence, factoryMergeGroupReadiness } from "./FactoryMerge.ts";
import {
  canonicalFactoryPullRequest,
  factoryMergeGroupForAssignment,
  factoryMergeGroupsForPullRequest,
} from "./FactoryMergeOwnership.ts";
import { commissioned } from "./FactoryIntegration.testkit.ts";
import {
  applyMerge,
  api,
  deliveryIds,
  deliveryNow,
  integrated,
  mergeCommandId,
  mergeFixture,
  requestMergeReview,
  reviewedMergeFixture,
  sealMergeReview,
} from "./FactoryMerge.testkit.ts";

const run = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = { kind: "human" },
) => decide({ state, command, actor, now: deliveryNow });
const approve = (fixture: ReturnType<typeof reviewedMergeFixture>) =>
  applyMerge(fixture.state, {
    type: "merge.group.approve",
    commandId: mergeCommandId(),
    groupId: fixture.groupId,
    reviewId: fixture.reviewId,
    expectedDigest: fixture.reviewDigest,
  });
const autonomous = (state: FactorySnapshot, projectId = api.project): FactorySnapshot => ({
  ...state,
  managers: state.managers.map((entry) =>
    entry.projectId === projectId
      ? { ...entry, overrides: { ...entry.overrides, delivery: "project-rule" } }
      : entry,
  ),
  assignments: state.assignments.map((entry) =>
    entry.projectId === projectId
      ? { ...entry, grantedPolicy: { ...entry.grantedPolicy, delivery: "project-rule" } }
      : entry,
  ),
  mergeRules: [
    ...state.mergeRules,
    {
      projectId,
      version: 1,
      enabled: true,
      kinds: ["implementation"],
      allowedPaths: ["src"],
      excludedPaths: [],
      allowEstablishedPatterns: true,
      approvedAt: deliveryNow,
      authorizingCommandId: mergeCommandId(),
    },
  ],
});

describe("merge groups", () => {
  it("enrolls every integration participant before a pull request is published", () => {
    const result = commissioned();
    assert.lengthOf(result.state.mergeGroups, 1);
    const group = result.state.mergeGroups[0]!;
    assert.equal(group.integrationId, result.integrationId);
    assert.deepEqual(group.memberAssignmentIds, [api.assignment, deliveryIds.assignment].sort());
    assert.deepEqual(group.knownPullRequests, []);
    assert.equal(factoryMergeGroupForAssignment(result.state, api.assignment)?.id, group.id);
  });
  it("rejects an overlapping integration assignment before allocating its thread", () => {
    const first = commissioned();
    const existing = first.state.crossProjectRequests[0]!;
    const state = {
      ...first.state,
      crossProjectRequests: [
        ...first.state.crossProjectRequests,
        { ...existing, id: "another-request", outcome: "Another dependent outcome" },
      ],
    };
    const result = decide({
      state,
      actor: { kind: "thread", threadId: deliveryIds.manager },
      now: deliveryNow,
      command: {
        type: "integration.commission",
        commandId: mergeCommandId(),
        managerId: deliveryIds.manager,
        requestIds: ["another-request"],
        title: "Duplicate integration",
        description: "Same implementation teams",
        complexity: "standard",
        coordinatorProjectId: deliveryIds.project,
      },
      allocation: {
        managerThreadId: deliveryIds.manager,
        assignmentId: FactoryAssignmentId.make("duplicate-integration"),
        leadThreadId: ThreadId.make("duplicate-lead"),
      },
    });
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result))
      assert.include(result.failure.detail!, "already belongs to merge group");
    assert.lengthOf(state.assignments, 3);
  });
  it("blocks individual merge for human-approved and autonomous members", () => {
    const fixture = reviewedMergeFixture();
    const approved = approve(fixture);
    for (const state of [approved.state, autonomous(approved.state)]) {
      const assignment = state.assignments.find((entry) => entry.id === api.assignment)!;
      const result = run(
        state,
        {
          type: "delivery.merge",
          commandId: mergeCommandId(),
          assignmentId: assignment.id,
          revisionId: assignment.delivery!.currentRevisionId!,
        },
        { kind: "thread", threadId: api.lead },
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.include(result.failure.detail!, "shared action");
    }
  });
  it("holds legacy integration members even before their group record is materialized", () => {
    const fixture = mergeFixture();
    const state = { ...fixture.state, mergeGroups: [] };
    assert.equal(
      factoryMergeGroupForAssignment(state, api.assignment)?.integrationId,
      fixture.integrationId,
    );
    assert.isTrue(
      Result.isFailure(
        run(
          state,
          {
            type: "delivery.merge",
            commandId: mergeCommandId(),
            assignmentId: api.assignment,
            revisionId: state.assignments.find((entry) => entry.id === api.assignment)!.delivery!
              .currentRevisionId!,
          },
          { kind: "thread", threadId: api.lead },
        ),
      ),
    );
  });
  it("keeps old canonical PR references protected after republishing and dropping an old revision", () => {
    const fixture = reviewedMergeFixture();
    const assignment = fixture.state.assignments.find((entry) => entry.id === api.assignment)!;
    const old = assignment.delivery!.revisions[0]!;
    const oldRef = old.publication!.ref!;
    const revised = {
      ...old,
      id: "republished-api",
      publication: { ...old.publication!, ref: { ...oldRef, number: 99 } },
    };
    const state = {
      ...fixture.state,
      assignments: fixture.state.assignments.map((entry) =>
        entry.id === api.assignment
          ? {
              ...entry,
              delivery: { ...entry.delivery!, currentRevisionId: revised.id, revisions: [revised] },
            }
          : entry,
      ),
    };
    const refreshed = requestMergeReview(state, fixture.groupId);
    assert.equal(
      factoryMergeGroupsForPullRequest(refreshed.state, {
        ...oldRef,
        host: "GITHUB.COM",
        repository: oldRef.repository.toUpperCase(),
      })[0]?.id,
      fixture.groupId,
    );
    assert.equal(
      factoryMergeGroupsForPullRequest(refreshed.state, revised.publication.ref)[0]?.id,
      fixture.groupId,
    );
    assert.lengthOf(refreshed.state.mergeGroups[0]!.knownPullRequests, 3);
  });
  it("blocks retry of a pending individual merge after enrollment", () => {
    const fixture = mergeFixture();
    const state = {
      ...fixture.state,
      assignments: fixture.state.assignments.map((entry) =>
        entry.id === api.assignment
          ? {
              ...entry,
              delivery: {
                ...entry.delivery!,
                revisions: entry.delivery!.revisions.map((revision) => ({
                  ...revision,
                  merge: {
                    operationId: "old-independent-merge",
                    status: "unknown" as const,
                    requestedAt: deliveryNow,
                  },
                })),
              },
            }
          : entry,
      ),
    };
    assert.isTrue(
      Result.isFailure(
        run(
          state,
          {
            type: "delivery.retry",
            commandId: mergeCommandId(),
            assignmentId: api.assignment,
            revisionId: state.assignments.find((entry) => entry.id === api.assignment)!.delivery!
              .currentRevisionId!,
          },
          { kind: "thread", threadId: api.lead },
        ),
      ),
    );
    assert.isFalse(factoryMergeGroupEvidence(state, fixture.groupId).ready);
  });
  it("lets the integration lead request the review while managers remain outside review", () => {
    const fixture = mergeFixture();
    const command = {
      type: "merge.group.review" as const,
      commandId: mergeCommandId(),
      groupId: fixture.groupId,
    };
    assert.isTrue(
      Result.isFailure(
        run(fixture.state, command, { kind: "thread", threadId: deliveryIds.manager }),
      ),
    );
    assert.isTrue(
      Result.isFailure(run(fixture.state, command, { kind: "thread", threadId: api.lead })),
    );
    const review = applyMerge(fixture.state, command, {
      kind: "thread",
      threadId: integrated.lead,
    });
    assert.equal(review.effects[0]!.type, "merge.group.inspect");
    assert.isTrue(
      Result.isFailure(
        run(
          review.state,
          { ...command, commandId: mergeCommandId() },
          { kind: "thread", threadId: integrated.lead },
        ),
      ),
    );
  });
  it("approves every displayed exact member bundle with one human decision", () => {
    const fixture = reviewedMergeFixture();
    const before = factoryMergeGroupReadiness(fixture.state, fixture.groupId);
    assert.isTrue(before.canApprove);
    assert.equal(before.status, "reviewing");
    const result = approve(fixture);
    const after = factoryMergeGroupReadiness(result.state, fixture.groupId);
    assert.equal(after.status, "ready");
    assert.isFalse(after.canRequestMerge);
    assert.isTrue(after.members.every((entry) => entry.humanApproved));
    assert.deepEqual(after.reasons, []);
    for (const assignment of result.state.assignments.filter((entry) => !entry.integrationId)) {
      const revision = assignment.delivery!.revisions[0]!;
      assert.equal(revision.approval!.bundleDigest, revision.bundleDigest);
      assert.equal(revision.approval!.expectedHeadSha, revision.publication!.headSha);
    }
  });
  it("requires consolidated human approval for mixed autonomous and human-reviewed members", () => {
    const fixture = mergeFixture();
    const state = autonomous(fixture.state);
    const pending = requestMergeReview(state, fixture.groupId);
    const reviewId = pending.result.mergeGroupReviewId!;
    const sealed = sealMergeReview(pending.state, fixture.groupId, reviewId);
    const readiness = factoryMergeGroupReadiness(sealed.state, fixture.groupId);
    assert.isFalse(
      readiness.members.find((entry) => entry.assignmentId === api.assignment)!.needsHuman,
    );
    assert.isTrue(
      readiness.members.find((entry) => entry.assignmentId === deliveryIds.assignment)!.needsHuman,
    );
    assert.equal(readiness.status, "reviewing");
    assert.isFalse(readiness.canRequestMerge);
  });
  it("preserves a human rejection until a current exact review is approved", () => {
    const fixture = reviewedMergeFixture();
    const rejected = applyMerge(fixture.state, {
      type: "merge.group.reject",
      commandId: mergeCommandId(),
      groupId: fixture.groupId,
      reviewId: fixture.reviewId,
      expectedDigest: fixture.reviewDigest,
      reason: "Correct the combined UI flow",
    });
    assert.equal(
      factoryMergeGroupReadiness(rejected.state, fixture.groupId).status,
      "changes-requested",
    );
    assert.isTrue(
      rejected.effects.every(
        (entry) =>
          entry.type !== "merge.group.notify" ||
          !entry.recipientAssignmentIds.includes(FactoryAssignmentId.make(deliveryIds.manager)),
      ),
    );
    const corrected = requestMergeReview(rejected.state, fixture.groupId);
    assert.isNull(corrected.state.mergeGroupReviews.at(-1)!.decision);
  });
  it("retains a human veto when autonomous teams refresh unchanged combined evidence", () => {
    const fixture = mergeFixture();
    const autonomousState = autonomous(autonomous(fixture.state), deliveryIds.project);
    const pending = requestMergeReview(autonomousState, fixture.groupId);
    const sealed = sealMergeReview(
      pending.state,
      fixture.groupId,
      pending.result.mergeGroupReviewId!,
    );
    const first = factoryMergeGroupReadiness(sealed.state, fixture.groupId);
    assert.equal(first.status, "ready");
    assert.isTrue(first.members.every((member) => member.ruleEligible && !member.needsHuman));
    const rejected = applyMerge(sealed.state, {
      type: "merge.group.reject",
      commandId: mergeCommandId(),
      groupId: fixture.groupId,
      reviewId: first.reviewId!,
      expectedDigest: first.reviewDigest!,
      reason: "The combined flow needs correction",
    });
    const repeatedVerification = {
      ...rejected.state,
      integrationVerifications: rejected.state.integrationVerifications.map((entry) => ({
        ...entry,
        id: `${entry.id}:repeated`,
      })),
    };
    const refreshed = requestMergeReview(repeatedVerification, fixture.groupId);
    const inspected = sealMergeReview(
      refreshed.state,
      fixture.groupId,
      refreshed.result.mergeGroupReviewId!,
    );
    const current = factoryMergeGroupReadiness(inspected.state, fixture.groupId);
    assert.equal(current.status, "changes-requested");
    assert.include(current.reasons, "The combined flow needs correction");
    const approved = applyMerge(inspected.state, {
      type: "merge.group.approve",
      commandId: mergeCommandId(),
      groupId: fixture.groupId,
      reviewId: current.reviewId!,
      expectedDigest: current.reviewDigest!,
    });
    assert.equal(factoryMergeGroupReadiness(approved.state, fixture.groupId).status, "ready");
    const finalRefresh = requestMergeReview(approved.state, fixture.groupId);
    const finalSeal = sealMergeReview(
      finalRefresh.state,
      fixture.groupId,
      finalRefresh.result.mergeGroupReviewId!,
    );
    assert.equal(factoryMergeGroupReadiness(finalSeal.state, fixture.groupId).status, "ready");
  });
  it("requires a new human decision after reviewed evidence changes", () => {
    const fixture = reviewedMergeFixture();
    const rejected = applyMerge(fixture.state, {
      type: "merge.group.reject",
      commandId: mergeCommandId(),
      groupId: fixture.groupId,
      reviewId: fixture.reviewId,
      expectedDigest: fixture.reviewDigest,
      reason: "Correct the evidence",
    });
    const changed = {
      ...rejected.state,
      assignments: rejected.state.assignments.map((entry) =>
        !entry.delivery
          ? entry
          : {
              ...entry,
              delivery: {
                ...entry.delivery,
                revisions: entry.delivery.revisions.map((revision) => ({
                  ...revision,
                  bundleDigest: `${revision.bundleDigest}:corrected`,
                })),
              },
            },
      ),
    };
    const refreshed = requestMergeReview(changed, fixture.groupId);
    const inspected = sealMergeReview(
      refreshed.state,
      fixture.groupId,
      refreshed.result.mergeGroupReviewId!,
    );
    assert.isNull(inspected.state.mergeGroupReviews.at(-1)!.decision);
    assert.equal(factoryMergeGroupReadiness(inspected.state, fixture.groupId).status, "reviewing");
  });
  it("invalidates a seal when a current reviewed bundle or project rule changes", () => {
    const fixture = reviewedMergeFixture();
    const changed = {
      ...fixture.state,
      assignments: fixture.state.assignments.map((entry) =>
        entry.id === api.assignment
          ? {
              ...entry,
              delivery: {
                ...entry.delivery!,
                revisions: entry.delivery!.revisions.map((revision) => ({
                  ...revision,
                  bundleDigest: "new-host-review-bundle",
                })),
              },
            }
          : entry,
      ),
    };
    assert.isFalse(factoryMergeGroupReadiness(changed, fixture.groupId).canApprove);
    assert.isFalse(
      factoryMergeGroupReadiness(autonomous(fixture.state), fixture.groupId).canApprove,
    );
    assert.isTrue(
      Result.isFailure(
        run(changed, {
          type: "merge.group.approve",
          commandId: mergeCommandId(),
          groupId: fixture.groupId,
          reviewId: fixture.reviewId,
          expectedDigest: fixture.reviewDigest,
        }),
      ),
    );
  });
  it("rejects foreign host success and missing host checks before sealing", () => {
    const fixture = mergeFixture();
    const changed = {
      ...fixture.state,
      assignments: fixture.state.assignments.map((entry) =>
        entry.id === api.assignment
          ? {
              ...entry,
              delivery: {
                ...entry.delivery!,
                revisions: entry.delivery!.revisions.map((revision) => ({
                  ...revision,
                  hostEvidence: { ...revision.hostEvidence!, checks: "pending" as const },
                })),
              },
            }
          : entry,
      ),
    };
    const evidence = factoryMergeGroupEvidence(changed, fixture.groupId);
    assert.isFalse(evidence.ready);
    if (!evidence.ready)
      assert.isTrue(evidence.reasons.some((reason) => reason.includes("hosting checks")));
    const pending = requestMergeReview(fixture.state, fixture.groupId);
    const current = factoryMergeGroupEvidence(pending.state, fixture.groupId);
    assert.isTrue(current.ready);
    if (current.ready)
      assert.isTrue(
        Result.isFailure(
          run(
            pending.state,
            {
              type: "merge.group.inspected",
              commandId: mergeCommandId(),
              groupId: fixture.groupId,
              reviewId: pending.result.mergeGroupReviewId!,
              expectedStateRevision: pending.state.revision,
              digest: "forged-head",
              ...current,
              members: current.members.map((entry) => ({ ...entry, headSha: "other-head" })),
            },
            { kind: "system" },
          ),
        ),
      );
  });
  it("requires owner incorporation of edited integration test overlays", () => {
    const fixture = mergeFixture();
    const changed = {
      ...fixture.state,
      integrationTestArtifacts: fixture.state.integrationTestArtifacts.map((entry) => ({
        ...entry,
        projects: entry.projects.map((project) => ({
          ...project,
          changedPaths: ["test/check.js"],
        })),
      })),
    };
    const evidence = factoryMergeGroupEvidence(changed, fixture.groupId);
    assert.isFalse(evidence.ready);
    if (!evidence.ready)
      assert.isTrue(evidence.reasons.some((reason) => reason.includes("incorporate")));
  });
  it("invalidates combined readiness when any owner revokes its contribution", () => {
    const fixture = reviewedMergeFixture();
    const grant = fixture.state.integrationGrants.find((entry) => entry.projectId === api.project)!;
    const revoked = applyMerge(
      fixture.state,
      {
        type: "integration.grant.revoke",
        commandId: mergeCommandId(),
        grantId: grant.id,
        reason: "Resource restriction",
      },
      { kind: "thread", threadId: api.manager },
    );
    assert.isFalse(factoryMergeGroupReadiness(revoked.state, fixture.groupId).canApprove);
    assert.equal(factoryMergeGroupReadiness(revoked.state, fixture.groupId).status, "waiting");
  });
  it("reports conflicting canonical PR ownership instead of dropping a host publication", () => {
    const fixture = mergeFixture();
    const group = fixture.state.mergeGroups[0]!;
    const ref = fixture.state.assignments.find((entry) => entry.id === api.assignment)!.delivery!
      .revisions[0]!.publication!.ref!;
    const state = {
      ...fixture.state,
      mergeGroups: [
        ...fixture.state.mergeGroups,
        {
          ...group,
          id: "conflicting-group",
          integrationId: "other-integration",
          knownPullRequests: [
            {
              assignmentId: api.assignment,
              ref: { ...ref, host: "GITHUB.COM", repository: ref.repository.toUpperCase() },
            },
          ],
        },
      ],
    };
    assert.equal(
      canonicalFactoryPullRequest(ref),
      canonicalFactoryPullRequest(state.mergeGroups[1]!.knownPullRequests[0]!.ref),
    );
    const evidence = factoryMergeGroupEvidence(state, fixture.groupId);
    assert.isFalse(evidence.ready);
    if (!evidence.ready)
      assert.isTrue(
        evidence.reasons.some((reason) => reason.includes("more than one merge group")),
      );
  });
  it("preserves conflicting historical ownership after both teams publish elsewhere", () => {
    const fixture = mergeFixture();
    const group = fixture.state.mergeGroups[0]!;
    const known = {
      assignmentId: api.assignment,
      ref: {
        projectId: api.project,
        host: "github.com",
        repository: "owner/historical",
        number: 42,
      },
    };
    const state = {
      ...fixture.state,
      mergeGroups: [
        { ...group, knownPullRequests: [...group.knownPullRequests, known] },
        {
          ...group,
          id: "historical-conflict",
          integrationId: "other-integration",
          memberAssignmentIds: [],
          knownPullRequests: [known],
        },
      ],
    };
    const evidence = factoryMergeGroupEvidence(state, fixture.groupId);
    assert.isFalse(evidence.ready);
    if (!evidence.ready)
      assert.isTrue(evidence.reasons.some((reason) => reason.includes("owner/historical#42")));
  });
});
