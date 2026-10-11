import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  type FactoryDecisionCommand,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decide, type FactoryActor } from "./FactoryState.ts";
import { factoryDeliveryReadiness } from "./FactoryDelivery.ts";
import { factoryDirectionBlocked } from "./FactoryControls.ts";
import {
  applyDelivery,
  deliveryActors,
  deliveryCommand,
  deliveryEvidence,
  deliveryIds,
  deliveryNow,
  deliveryRevisionCommand,
  deliverySelection,
  reviewedDeliveryFixture,
} from "./FactoryDelivery.testkit.ts";

const rejected = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = deliveryActors.lead,
) => assert.isTrue(Result.isFailure(decide({ state, command, actor, now: deliveryNow })));
const approve = (state: FactorySnapshot) =>
  applyDelivery(
    state,
    {
      ...deliveryRevisionCommand,
      type: "delivery.approve",
      expectedHeadSha: "head",
      bundleDigest: "bundle",
    },
    deliveryActors.human,
  ).state;
const member = {
  threadId: deliveryIds.lead,
  assignmentId: deliveryIds.assignment,
  managerId: deliveryIds.manager,
  projectId: deliveryIds.project,
  ancestorThreadIds: [],
};

describe("factory delivery", () => {
  it("hands verified work to the human, keeps the lead able to correct it, and records only actual merge confirmation", () => {
    const ready = reviewedDeliveryFixture();
    assert.isTrue(ready.assignments[0]!.delivery!.directionHeld);
    assert.isDefined(factoryDirectionBlocked(ready, member, deliveryIds.manager));
    assert.isUndefined(factoryDirectionBlocked(ready, member, deliveryIds.lead));
    assert.isUndefined(factoryDirectionBlocked(ready, member, null));
    rejected(ready, { ...deliveryRevisionCommand, type: "delivery.merge" });
    rejected(
      ready,
      {
        ...deliveryRevisionCommand,
        type: "delivery.approve",
        expectedHeadSha: "head",
        bundleDigest: "bundle",
      },
      deliveryActors.manager,
    );
    const requested = applyDelivery(approve(ready), {
      ...deliveryRevisionCommand,
      type: "delivery.merge",
    });
    assert.equal(requested.effects[0]?.type, "delivery.merge");
    assert.equal(
      requested.state.assignments[0]!.delivery!.revisions[0]!.merge?.status,
      "requested",
    );
    assert.isUndefined(requested.state.assignments[0]!.oversight?.delivery);
    const unknown = applyDelivery(
      requested.state,
      {
        ...deliveryRevisionCommand,
        type: "delivery.merge.recorded",
        operationId: "merge:command",
        status: "unknown",
        reason: "Host acknowledgement was lost",
      },
      deliveryActors.host,
    ).state;
    rejected(unknown, { ...deliveryRevisionCommand, type: "delivery.merge" });
    assert.equal(unknown.assignments[0]!.status, "running");
    const merged = applyDelivery(
      unknown,
      {
        ...deliveryRevisionCommand,
        type: "delivery.merge.recorded",
        operationId: "merge:command",
        status: "merged",
        mergedAt: deliveryNow,
      },
      deliveryActors.host,
    ).state;
    assert.equal(merged.assignments[0]!.delivery!.revisions[0]!.merge?.status, "merged");
  });
  it("allows an explicitly eligible project-rule merge without a manager review step", () => {
    let state = reviewedDeliveryFixture();
    state = {
      ...state,
      defaults: { ...state.defaults, delivery: "project-rule" },
      assignments: state.assignments.map((entry) => ({
        ...entry,
        grantedPolicy: { ...entry.grantedPolicy, delivery: "project-rule" },
        // Granted the rule from the start, so the revision was never handed to the human.
        delivery: {
          ...entry.delivery!,
          directionHeld: false,
          revisions: entry.delivery!.revisions.map(
            ({ routedToHuman: _routed, ...revision }) => revision,
          ),
        },
      })),
    };
    state = applyDelivery(
      state,
      {
        type: "delivery.rules.configure",
        commandId: CommandId.make("rule"),
        projectId: deliveryIds.project,
        enabled: true,
        kinds: ["implementation"],
        allowedPaths: ["src"],
        excludedPaths: ["src/protected"],
        allowEstablishedPatterns: false,
      },
      deliveryActors.human,
    ).state;
    const merged = applyDelivery(state, { ...deliveryRevisionCommand, type: "delivery.merge" });
    assert.equal(
      merged.state.assignments[0]!.delivery!.revisions[0]!.approval?.authority,
      "project-rule",
    );
    const revoked = {
      ...state,
      defaults: { ...state.defaults, delivery: "human-approval" as const },
    };
    rejected(revoked, { ...deliveryRevisionCommand, type: "delivery.merge" });
  });
  it("keeps a revision already routed to the human waiting after its grant is extended", () => {
    let state = reviewedDeliveryFixture();
    assert.isTrue(state.assignments[0]!.delivery!.revisions[0]!.routedToHuman);
    state = { ...state, defaults: { ...state.defaults, delivery: "project-rule" } };
    state = applyDelivery(
      state,
      {
        type: "assignments.extend-grant",
        commandId: CommandId.make("extend"),
        assignmentIds: [deliveryIds.assignment],
      },
      deliveryActors.human,
    ).state;
    assert.equal(state.assignments[0]!.grantedPolicy.delivery, "project-rule");
    state = applyDelivery(
      state,
      {
        type: "delivery.rules.configure",
        commandId: CommandId.make("rule"),
        projectId: deliveryIds.project,
        enabled: true,
        kinds: ["implementation"],
        allowedPaths: ["src"],
        excludedPaths: [],
        allowEstablishedPatterns: false,
      },
      deliveryActors.human,
    ).state;
    const assignment = state.assignments[0]!;
    const readiness = factoryDeliveryReadiness(
      state,
      assignment,
      assignment.delivery!.revisions[0]!,
    );
    assert.isTrue(readiness.ruleEligible);
    assert.isTrue(readiness.needsHuman);
    rejected(state, { ...deliveryRevisionCommand, type: "delivery.merge" });
    assert.equal(
      applyDelivery(approve(state), { ...deliveryRevisionCommand, type: "delivery.merge" })
        .effects[0]?.type,
      "delivery.merge",
    );
  });
  it("invalidates human approval after a changed head, changed candidate, or changed grant", () => {
    const approved = approve(reviewedDeliveryFixture());
    const revision = approved.assignments[0]!.delivery!.revisions[0]!;
    const changed = applyDelivery(
      approved,
      {
        ...deliveryRevisionCommand,
        type: "delivery.inspected",
        expectedStateRevision: approved.revision,
        bundleDigest: "changed",
        evidence: { ...revision.hostEvidence!, headSha: "different-head" },
      },
      deliveryActors.host,
    ).state;
    rejected(changed, { ...deliveryRevisionCommand, type: "delivery.merge" });
    assert.isUndefined(changed.assignments[0]!.delivery!.revisions[0]!.approval);
    const fresh = applyDelivery(approved, {
      ...deliveryCommand,
      commandId: CommandId.make("correction"),
      type: "delivery.capture",
      expectedEpoch: 1,
      selectedPaths: ["src/feature.ts"],
      commitMessage: "fix: correction",
    }).state;
    rejected(fresh, { ...deliveryRevisionCommand, type: "delivery.merge" });
    assert.isTrue(fresh.assignments[0]!.delivery!.directionHeld);
    const reduced = {
      ...approved,
      assignments: approved.assignments.map((entry) => ({
        ...entry,
        grant: { ...entry.grant!, epoch: 2 },
      })),
    };
    rejected(reduced, { ...deliveryRevisionCommand, type: "delivery.merge" });
  });
  it("requires early concrete flow approval independently of final major-UI approval", () => {
    const state = applyDelivery(reviewedDeliveryFixture(), {
      ...deliveryCommand,
      type: "delivery.impact.declare",
      impact: {
        classification: "major-ui",
        changedFlows: true,
        journeys: "New checkout",
        navigation: "New destination",
        layout: "New screen",
        sharedComponents: "Changes shared forms",
        summary: "New checkout flow",
        evidence: deliveryEvidence,
      },
    }).state;
    assert.equal(state.assignments[0]!.delivery!.flow?.status, "stopping");
    rejected(
      state,
      {
        ...deliveryCommand,
        type: "delivery.flow.decide",
        artifactDigest: "forged",
        approved: true,
      },
      deliveryActors.human,
    );
    const held = applyDelivery(
      state,
      { ...deliveryCommand, type: "delivery.flow.recorded", holdId: "flow:command", held: true },
      deliveryActors.host,
    ).state;
    const submitted = applyDelivery(held, {
      ...deliveryCommand,
      type: "delivery.flow.submit",
      title: "Checkout flow",
      content: "Review cart, enter delivery details, then confirm payment.",
      format: "markdown",
    }).state;
    const concrete = applyDelivery(
      submitted,
      {
        ...deliveryCommand,
        type: "delivery.flow.artifact",
        holdId: "flow:command",
        artifactId: "flow-artifact:command",
        artifactDigest: "flow-digest",
      },
      deliveryActors.host,
    ).state;
    assert.equal(submitted.assignments[0]!.wait?.kind, "flow-review");
    assert.equal(submitted.assignments[0]!.status, "waiting");
    rejected(submitted, {
      ...deliveryCommand,
      type: "assignment.wait",
      wait: { kind: "human-decision", reason: "Approve this same flow" },
    });
    assert.isUndefined(concrete.assignments[0]!.delivery!.flow!.pendingArtifactId);
    const changeDecision = applyDelivery(
      concrete,
      {
        ...deliveryCommand,
        type: "delivery.flow.decide",
        artifactDigest: "flow-digest",
        approved: false,
      },
      deliveryActors.human,
    );
    const changesRequested = changeDecision.state;
    assert.isTrue(
      changeDecision.effects.some(
        (effect) =>
          effect.type === "thread.deliver" &&
          effect.purpose?.kind === "delivery-flow" &&
          effect.purpose.holdId === "flow:command",
      ),
    );
    const replacement = applyDelivery(changesRequested, {
      ...deliveryCommand,
      commandId: CommandId.make("replacement-flow"),
      type: "delivery.flow.submit",
      title: "Revised checkout",
      content: "Review cart and edit delivery details without losing entered payment information.",
      format: "markdown",
    }).state;
    assert.isNull(changesRequested.assignments[0]!.wait);
    assert.equal(changesRequested.assignments[0]!.status, "running");
    assert.deepEqual(replacement.assignments[0]!.wait, {
      kind: "flow-review",
      holdId: "flow:command",
      artifactId: "flow-artifact:replacement-flow",
      reason: "Waiting for the human's decision on the concrete UI flow.",
    });
    rejected(
      replacement,
      {
        ...deliveryCommand,
        type: "delivery.flow.decide",
        artifactDigest: "flow-digest",
        approved: true,
      },
      deliveryActors.human,
    );
    const revised = applyDelivery(
      replacement,
      {
        ...deliveryCommand,
        type: "delivery.flow.artifact",
        holdId: "flow:command",
        artifactId: "flow-artifact:replacement-flow",
        artifactDigest: "revised-flow",
      },
      deliveryActors.host,
    ).state;
    assert.isUndefined(revised.assignments[0]!.delivery!.flow!.pendingArtifactId);
    assert.isUndefined(revised.assignments[0]!.delivery!.flow!.decision);
    assert.equal(
      applyDelivery(
        revised,
        {
          ...deliveryCommand,
          type: "delivery.flow.decide",
          artifactDigest: "revised-flow",
          approved: true,
        },
        deliveryActors.human,
      ).state.assignments[0]!.delivery!.flow!.status,
      "releasing",
    );
    rejected(
      concrete,
      {
        ...deliveryCommand,
        type: "delivery.flow.decide",
        artifactDigest: "flow-digest",
        approved: true,
      },
      deliveryActors.manager,
    );
    const releasing = applyDelivery(
      concrete,
      {
        ...deliveryCommand,
        type: "delivery.flow.decide",
        artifactDigest: "flow-digest",
        approved: true,
      },
      deliveryActors.human,
    ).state;
    const released = applyDelivery(
      releasing,
      { ...deliveryCommand, type: "delivery.flow.recorded", holdId: "flow:command", held: false },
      deliveryActors.host,
    ).state;
    assert.equal(releasing.assignments[0]!.wait?.kind, "flow-review");
    assert.isNull(released.assignments[0]!.wait);
    assert.equal(released.assignments[0]!.status, "running");
    const independentWait = {
      kind: "human-decision" as const,
      reason: "Choose a payment provider",
    };
    const independentlyWaiting = {
      ...held,
      assignments: held.assignments.map((item) => ({ ...item, wait: independentWait })),
    };
    let independent = applyDelivery(independentlyWaiting, {
      ...deliveryCommand,
      type: "delivery.flow.submit",
      title: "Checkout flow",
      content: "Review the order before payment.",
      format: "markdown",
    }).state;
    assert.deepEqual(independent.assignments[0]!.wait, independentWait);
    independent = applyDelivery(
      independent,
      {
        ...deliveryCommand,
        type: "delivery.flow.artifact",
        holdId: "flow:command",
        artifactId: "flow-artifact:command",
        artifactDigest: "independent-flow",
      },
      deliveryActors.host,
    ).state;
    independent = applyDelivery(
      independent,
      {
        ...deliveryCommand,
        type: "delivery.flow.decide",
        artifactDigest: "independent-flow",
        approved: true,
      },
      deliveryActors.human,
    ).state;
    independent = applyDelivery(
      independent,
      {
        ...deliveryCommand,
        type: "delivery.flow.recorded",
        holdId: "flow:command",
        held: false,
      },
      deliveryActors.host,
    ).state;
    assert.deepEqual(independent.assignments[0]!.wait, independentWait);
    const assignment = released.assignments[0]!;
    const readiness = factoryDeliveryReadiness(
      released,
      assignment,
      assignment.delivery!.revisions[0]!,
    );
    assert.isTrue(readiness.needsHuman);
    assert.isTrue(readiness.reasons.some((reason) => reason.includes("actual app")));
    assert.isFalse(
      readiness.reasons.some((reason) => reason.includes("flow needs human approval")),
    );
  });
  it("keeps a requested corrective review blocking after an older review passed", () => {
    const requestReview = (state: FactorySnapshot, id: string) =>
      applyDelivery(
        state,
        {
          ...deliveryRevisionCommand,
          commandId: CommandId.make(id),
          type: "delivery.review.request",
        },
        deliveryActors.lead,
        {
          deliveryReviewAllocation: {
            threadId: ThreadId.make(id),
            modelSelection: deliverySelection,
          },
        },
      ).state;
    let state = requestReview(approve(reviewedDeliveryFixture()), "second-review");
    state = applyDelivery(
      state,
      {
        ...deliveryRevisionCommand,
        type: "delivery.review.started",
        reviewId: "review:second-review",
        profileId: "second-profile",
      },
      deliveryActors.host,
    ).state;
    state = applyDelivery(
      state,
      {
        ...deliveryRevisionCommand,
        type: "delivery.review.report",
        reviewId: "review:second-review",
        verdict: "changes-requested",
        confirmsImpact: true,
        findings: "The error path loses the submitted work.",
        evidence: deliveryEvidence,
      },
      { kind: "thread", threadId: ThreadId.make("second-review") },
    ).state;
    state = requestReview(state, "corrective-review");
    const assignment = state.assignments[0]!;
    const revision = assignment.delivery!.revisions[0]!;
    assert.deepEqual(
      revision.reviews.map((entry) => entry.status),
      ["passed", "changes-requested", "pending"],
    );
    assert.isTrue(
      factoryDeliveryReadiness(state, assignment, revision).reasons.some((reason) =>
        reason.includes("independent team reviewer"),
      ),
    );
    rejected(state, { ...deliveryRevisionCommand, type: "delivery.merge" });
    rejected(
      state,
      {
        ...deliveryRevisionCommand,
        type: "delivery.approve",
        expectedHeadSha: "head",
        bundleDigest: "bundle",
      },
      deliveryActors.human,
    );
  });
  it("rejects an old flow artifact receipt after impact changes within the same hold", () => {
    const impact = {
      classification: "major-ui" as const,
      changedFlows: true,
      journeys: "New checkout",
      navigation: "Checkout destination",
      layout: "Checkout screen",
      sharedComponents: "Shared form",
      summary: "Checkout flow",
      evidence: deliveryEvidence,
    };
    let state = applyDelivery(reviewedDeliveryFixture(), {
      ...deliveryCommand,
      type: "delivery.impact.declare",
      impact,
    }).state;
    state = applyDelivery(
      state,
      { ...deliveryCommand, type: "delivery.flow.recorded", holdId: "flow:command", held: true },
      deliveryActors.host,
    ).state;
    state = applyDelivery(state, {
      ...deliveryCommand,
      type: "delivery.flow.submit",
      title: "Original flow",
      content: "Enter address and confirm payment.",
      format: "markdown",
    }).state;
    state = applyDelivery(state, {
      ...deliveryCommand,
      commandId: CommandId.make("changed-impact"),
      type: "delivery.impact.declare",
      impact: { ...impact, journeys: "Guest checkout and account creation" },
    }).state;
    assert.equal(state.assignments[0]!.delivery!.flow!.holdId, "flow:command");
    assert.isUndefined(state.assignments[0]!.delivery!.flow!.pendingArtifactId);
    assert.isNull(state.assignments[0]!.wait);
    rejected(
      state,
      {
        ...deliveryCommand,
        type: "delivery.flow.artifact",
        holdId: "flow:command",
        artifactId: "flow-artifact:command",
        artifactDigest: "old-flow",
      },
      deliveryActors.host,
    );
    state = applyDelivery(state, {
      ...deliveryCommand,
      commandId: CommandId.make("new-flow"),
      type: "delivery.flow.submit",
      title: "Guest checkout",
      content: "Choose guest checkout or create an account, then enter delivery details.",
      format: "markdown",
    }).state;
    state = applyDelivery(
      state,
      {
        ...deliveryCommand,
        type: "delivery.flow.artifact",
        holdId: "flow:command",
        artifactId: "flow-artifact:new-flow",
        artifactDigest: "new-flow",
      },
      deliveryActors.host,
    ).state;
    state = applyDelivery(
      state,
      {
        ...deliveryCommand,
        type: "delivery.flow.decide",
        artifactDigest: "new-flow",
        approved: true,
      },
      deliveryActors.human,
    ).state;
    assert.equal(state.assignments[0]!.delivery!.flow!.status, "releasing");
  });
  it("does not accept the lead or an unrelated worker as its independent reviewer", () => {
    const state = reviewedDeliveryFixture();
    const report = {
      ...deliveryRevisionCommand,
      type: "delivery.review.report" as const,
      reviewId: "review:command",
      verdict: "passed" as const,
      confirmsImpact: true,
      findings: "Self approved",
      evidence: deliveryEvidence,
    };
    rejected(state, report);
    rejected(state, report, { kind: "thread", threadId: ThreadId.make("foreign") });
  });
  it("records ambiguous eligibility for the retro and routes it to human review", () => {
    const original = reviewedDeliveryFixture();
    const state = {
      ...original,
      assignments: original.assignments.map((assignment) => ({
        ...assignment,
        delivery: {
          ...assignment.delivery!,
          impact: { ...assignment.delivery!.impact!, classification: "unclear" as const },
        },
      })),
    };
    const revision = state.assignments[0]!.delivery!.revisions[0]!;
    const routed = applyDelivery(
      state,
      {
        ...deliveryRevisionCommand,
        type: "delivery.inspected",
        expectedStateRevision: state.revision,
        bundleDigest: "bundle",
        evidence: revision.hostEvidence!,
      },
      deliveryActors.host,
    ).state;
    assert.equal(routed.assignments[0]!.delivery!.retroFindings.length, 1);
    rejected(routed, { ...deliveryRevisionCommand, type: "delivery.merge" });
  });
});
