import { assert, describe, it } from "@effect/vitest";
import { type FactorySnapshot, type FactoryDecisionCommand } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decide, type FactoryActor } from "./FactoryState.ts";
import { factoryCompletionEligibility } from "./FactoryRetros.ts";
import {
  currentFactoryMergeOperation,
  factoryMergeFreezeBlocks,
  factoryMergeOperationReadiness,
  factoryMergeOperationWriteReadiness,
  factoryMergeReceiptDigest,
} from "./FactoryMergeOperation.ts";
import { api, integrated, deliveryIds, reviewedMergeFixture } from "./FactoryMerge.testkit.ts";
import {
  applyMerge,
  mergeCommandId,
  deliveryNow,
  startedMergeOperationFixture,
  frozenMergeOperationFixture,
  completedMergeOperationFixture,
  submitMergeMember,
  confirmMergeMember,
  mergeFrozenProof,
} from "./FactoryMergeOperation.testkit.ts";

const run = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = { kind: "system" },
) => decide({ state, command, actor, now: deliveryNow });

describe("durable shared merge operations", () => {
  it("records externally merged reviewed heads before freeze without inventing combined completion authority", () => {
    const fixture = startedMergeOperationFixture();
    let state = fixture.state;
    for (const member of fixture.state.mergeOperations[0]!.members)
      state = confirmMergeMember(state, fixture.operationId, member.reviewed.assignmentId).state;
    const operation = state.mergeOperations[0]!;
    assert.equal(operation.lifecycle.phase, "attention");
    assert.deepEqual(
      operation.members.map((entry) => entry.outcome.phase),
      ["confirmed", "confirmed"],
    );
    assert.isFalse(factoryMergeOperationReadiness(state, fixture.groupId).canRetry);
    assert.isTrue(
      Result.isFailure(
        run(state, {
          type: "merge.operation.completed",
          commandId: mergeCommandId(),
          operationId: operation.id,
          receiptDigest: factoryMergeReceiptDigest(operation),
        }),
      ),
    );
    assert.isFalse(
      factoryCompletionEligibility(
        state,
        state.assignments.find((entry) => entry.id === integrated.assignment)!,
      ).eligible,
    );
  });
  it("requires the exact approved review and current integration lead, then locks review and integration edits", () => {
    const fixture = reviewedMergeFixture();
    const command = {
      type: "merge.group.start" as const,
      commandId: mergeCommandId(),
      groupId: fixture.groupId,
      reviewId: fixture.reviewId,
      expectedDigest: fixture.reviewDigest,
    };
    assert.isTrue(
      Result.isFailure(run(fixture.state, command, { kind: "thread", threadId: integrated.lead })),
    );
    const started = startedMergeOperationFixture();
    assert.equal(
      currentFactoryMergeOperation(started.state, started.integrationId)?.id,
      started.operationId,
    );
    assert.isTrue(
      Result.isFailure(
        run(
          started.state,
          { type: "merge.group.review", commandId: mergeCommandId(), groupId: started.groupId },
          { kind: "human" },
        ),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        run(
          started.state,
          {
            type: "integration.verify",
            commandId: mergeCommandId(),
            integrationId: started.integrationId,
            preparationId: started.preparationId,
          },
          { kind: "thread", threadId: integrated.lead },
        ),
      ),
    );
    const approved = applyMerge(fixture.state, {
      type: "merge.group.approve",
      commandId: mergeCommandId(),
      groupId: fixture.groupId,
      reviewId: fixture.reviewId,
      expectedDigest: fixture.reviewDigest,
    });
    assert.isTrue(
      Result.isFailure(
        run(
          approved.state,
          { ...command, commandId: mergeCommandId() },
          { kind: "thread", threadId: deliveryIds.manager },
        ),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        run(
          approved.state,
          { ...command, commandId: mergeCommandId(), expectedDigest: "old" },
          { kind: "human" },
        ),
      ),
    );
  });

  it("lets only the frozen lead thread recover its operation and escalate it to the human", () => {
    const started = startedMergeOperationFixture();
    const lead = started.state.assignments.find((entry) => entry.threadId === integrated.lead)!;
    assert.isTrue(factoryMergeFreezeBlocks(started.state, lead, integrated.lead));
    const frozen = frozenMergeOperationFixture();
    const frozenLead = frozen.state.assignments.find((entry) => entry.id === lead.id)!;
    assert.isFalse(factoryMergeFreezeBlocks(frozen.state, frozenLead, integrated.lead));
    assert.isTrue(factoryMergeFreezeBlocks(frozen.state, frozenLead, "lead-subagent"));
    assert.isTrue(factoryMergeFreezeBlocks(frozen.state, frozenLead));
    const escalate = {
      type: "merge.operation.escalate" as const,
      commandId: mergeCommandId(),
      operationId: frozen.operationId,
      reason: "The API member merged but the web member is blocked by a failing check.",
      recommendation: "Revert the API merge through a separately authorized task.",
    };
    assert.isTrue(
      Result.isFailure(
        run(frozen.state, escalate, { kind: "thread", threadId: deliveryIds.manager }),
      ),
    );
    const escalated = applyMerge(frozen.state, escalate, {
      kind: "thread",
      threadId: integrated.lead,
    });
    const lifecycle = escalated.state.mergeOperations[0]!.lifecycle;
    assert.equal(lifecycle.phase, "attention");
    if (lifecycle.phase === "attention") {
      assert.equal(lifecycle.reason, escalate.reason);
      assert.equal(lifecycle.recommendation, escalate.recommendation);
      assert.equal(lifecycle.retry, "same-vector");
    }
    assert.isFalse(escalated.effects.some((entry) => entry.type === "merge.operation.advance"));
    const completed = completedMergeOperationFixture();
    assert.isTrue(
      Result.isFailure(
        run(
          completed.state,
          { ...escalate, commandId: mergeCommandId(), operationId: completed.operationId },
          { kind: "thread", threadId: integrated.lead },
        ),
      ),
    );
    assert.isTrue(
      factoryMergeFreezeBlocks(
        completed.state,
        completed.state.assignments.find((entry) => entry.id === lead.id)!,
        integrated.lead,
      ),
    );
  });

  it("requires a stopped capture matching protected verification before any submission", () => {
    const fixture = startedMergeOperationFixture();
    const proof = mergeFrozenProof(fixture.state, fixture.operationId);
    const result = run(fixture.state, {
      type: "merge.operation.frozen",
      commandId: mergeCommandId(),
      operationId: fixture.operationId,
      expectedStateRevision: fixture.state.revision,
      frozen: { ...proof, captureDigest: "edited-tests" },
    });
    assert.isTrue(Result.isFailure(result));
    const frozen = frozenMergeOperationFixture();
    assert.isTrue(
      factoryMergeOperationWriteReadiness(
        frozen.state,
        frozen.operationId,
        frozen.state.mergeOperations[0]!.members[0]!.reviewed.assignmentId,
      ).allowed,
    );
  });

  it("persists unknown before writing and an open host read cannot turn a lost ACK into another submission", () => {
    const fixture = frozenMergeOperationFixture();
    const submitted = submitMergeMember(fixture.state, fixture.operationId);
    assert.deepEqual(submitted.effects, [
      { type: "merge.operation.reconcile", operationId: fixture.operationId },
    ]);
    const member = submitted.state.mergeOperations[0]!.members[0]!;
    assert.equal(member.attempts, 1);
    assert.equal(member.outcome.phase, "unknown");
    const observed = applyMerge(
      submitted.state,
      {
        type: "merge.operation.observed",
        commandId: mergeCommandId(),
        operationId: fixture.operationId,
        assignmentId: submitted.assignmentId,
        attemptId: submitted.attemptId,
        observation: {
          phase: "open",
          headSha: member.reviewed.headSha,
          targetBranch: member.authority.targetBranch,
          queued: false,
          observedAt: deliveryNow,
        },
      },
      { kind: "system" },
    );
    assert.equal(observed.state.mergeOperations[0]!.lifecycle.phase, "attention");
    assert.equal(observed.state.mergeOperations[0]!.members[0]!.outcome.phase, "unknown");
    assert.isFalse(factoryMergeOperationReadiness(observed.state, fixture.groupId).canRetry);
    const confirmed = confirmMergeMember(
      observed.state,
      fixture.operationId,
      submitted.assignmentId,
    );
    assert.equal(confirmed.state.mergeOperations[0]!.members[0]!.outcome.phase, "confirmed");
    assert.isFalse(confirmed.effects.some((entry) => entry.type === "merge.operation.advance"));
    assert.isTrue(factoryMergeOperationReadiness(confirmed.state, fixture.groupId).canRetry);
  });

  it("records exactly three definitive rejected attempts and never resets the budget", () => {
    const fixture = frozenMergeOperationFixture();
    let state = fixture.state;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const submitted = submitMergeMember(state, fixture.operationId);
      const member = submitted.state.mergeOperations[0]!.members[0]!;
      state = applyMerge(
        submitted.state,
        {
          type: "merge.operation.observed",
          commandId: mergeCommandId(),
          operationId: fixture.operationId,
          assignmentId: submitted.assignmentId,
          attemptId: submitted.attemptId,
          observation: {
            phase: "rejected",
            classification: "transient",
            reason: "Host temporarily rejected conditional merge",
            headSha: member.reviewed.headSha,
            targetBranch: member.authority.targetBranch,
            observedAt: deliveryNow,
          },
        },
        { kind: "system" },
      ).state;
      assert.equal(state.mergeOperations[0]!.members[0]!.attempts, attempt);
    }
    assert.equal(state.mergeOperations[0]!.lifecycle.phase, "attention");
    assert.isFalse(factoryMergeOperationReadiness(state, fixture.groupId).canRetry);
    assert.isTrue(
      Result.isFailure(
        run(
          state,
          {
            type: "merge.operation.retry",
            commandId: mergeCommandId(),
            operationId: fixture.operationId,
          },
          { kind: "human" },
        ),
      ),
    );
    const stopped = applyMerge(state, {
      type: "merge.operation.stop",
      commandId: mergeCommandId(),
      operationId: fixture.operationId,
      reason: "Stop exhausted operation",
    });
    assert.isTrue(
      Result.isFailure(
        run(
          stopped.state,
          {
            type: "merge.group.start",
            commandId: mergeCommandId(),
            groupId: fixture.groupId,
            reviewId: fixture.reviewId,
            expectedDigest: fixture.reviewDigest,
          },
          { kind: "human" },
        ),
      ),
    );
  });

  it("preserves confirmed member authority after conclusion while current project pause and remaining grants still gate writes", () => {
    const fixture = frozenMergeOperationFixture();
    const submitted = submitMergeMember(fixture.state, fixture.operationId);
    const confirmed = confirmMergeMember(
      submitted.state,
      fixture.operationId,
      submitted.assignmentId,
    );
    const state: FactorySnapshot = {
      ...confirmed.state,
      assignments: confirmed.state.assignments.map((entry) => {
        if (entry.id !== submitted.assignmentId) return entry;
        const { grant: _grant, ...concluded } = entry;
        return { ...concluded, status: "complete" };
      }),
    };
    const remaining = state.mergeOperations[0]!.members.find(
      (entry) => entry.outcome.phase === "pending",
    )!;
    assert.isTrue(
      factoryMergeOperationWriteReadiness(
        state,
        fixture.operationId,
        remaining.reviewed.assignmentId,
      ).allowed,
    );
    const paused = applyMerge(state, {
      type: "project.pause",
      commandId: mergeCommandId(),
      projectId: api.project,
    }).state;
    assert.isFalse(
      factoryMergeOperationWriteReadiness(
        paused,
        fixture.operationId,
        remaining.reviewed.assignmentId,
      ).allowed,
    );
    const revoked: FactorySnapshot = {
      ...state,
      integrationGrants: state.integrationGrants.map((entry) =>
        entry.id === remaining.authority.integrationGrantId
          ? {
              ...entry,
              lifecycle: {
                phase: "revoked",
                commandId: mergeCommandId(),
                reason: "Owner withdrew access",
                revokedAt: deliveryNow,
              },
            }
          : entry,
      ),
    };
    assert.isFalse(
      factoryMergeOperationWriteReadiness(
        revoked,
        fixture.operationId,
        remaining.reviewed.assignmentId,
      ).allowed,
    );
  });

  it("checks every remaining head before the selected member write and rejects stale attempt receipts", () => {
    const fixture = frozenMergeOperationFixture();
    const operation = fixture.state.mergeOperations[0]!;
    const later = operation.members[1]!;
    const changed: FactorySnapshot = {
      ...fixture.state,
      assignments: fixture.state.assignments.map((entry) =>
        entry.id === later.reviewed.assignmentId
          ? { ...entry, grant: { ...entry.grant!, epoch: entry.grant!.epoch + 1 } }
          : entry,
      ),
    };
    assert.isFalse(
      factoryMergeOperationWriteReadiness(
        changed,
        fixture.operationId,
        operation.members[0]!.reviewed.assignmentId,
      ).allowed,
    );
    const changedHead: FactorySnapshot = {
      ...fixture.state,
      assignments: fixture.state.assignments.map((entry) =>
        entry.id === later.reviewed.assignmentId
          ? {
              ...entry,
              delivery: {
                ...entry.delivery!,
                revisions: entry.delivery!.revisions.map((revision) =>
                  revision.id === later.reviewed.revisionId
                    ? {
                        ...revision,
                        publication: { ...revision.publication!, headSha: "new-unreviewed-head" },
                      }
                    : revision,
                ),
              },
            }
          : entry,
      ),
    };
    assert.isFalse(
      factoryMergeOperationWriteReadiness(
        changedHead,
        fixture.operationId,
        operation.members[0]!.reviewed.assignmentId,
      ).allowed,
    );
    const submitted = submitMergeMember(fixture.state, fixture.operationId);
    assert.isTrue(
      Result.isFailure(
        run(submitted.state, {
          type: "merge.operation.observed",
          commandId: mergeCommandId(),
          operationId: fixture.operationId,
          assignmentId: submitted.assignmentId,
          attemptId: "previous-attempt",
          observation: { phase: "unresolved", reason: "Old request", observedAt: deliveryNow },
        }),
      ),
    );
  });

  it("completes integration from all actual receipts and no fabricated no-PR acceptance", () => {
    const fixture = completedMergeOperationFixture();
    const operation = fixture.state.mergeOperations[0]!;
    assert.equal(operation.lifecycle.phase, "completed");
    const lead = fixture.state.assignments.find((entry) => entry.id === integrated.assignment)!;
    assert.equal(lead.completion?.acceptance, null);
    assert.deepEqual(factoryCompletionEligibility(fixture.state, lead), {
      eligible: true,
      disposition: {
        kind: "shared-group-delivered",
        operationId: fixture.operationId,
        groupId: fixture.groupId,
        receiptDigest: factoryMergeReceiptDigest(operation),
      },
    });
    for (const member of operation.members)
      assert.equal(
        fixture.state.assignments.find((entry) => entry.id === member.reviewed.assignmentId)!
          .completion!.deliveries[0]!.kind,
        "pull-request-merged",
      );
    const frozen = frozenMergeOperationFixture();
    assert.isTrue(
      Result.isFailure(
        run(frozen.state, {
          type: "merge.operation.completed",
          commandId: mergeCommandId(),
          operationId: frozen.operationId,
          receiptDigest: "invented",
        }),
      ),
    );
  });

  it("allows safe zero-merge stop, retains unknown holds, and accepts actual confirmation after stop", () => {
    const fixture = frozenMergeOperationFixture();
    const stopped = applyMerge(fixture.state, {
      type: "merge.operation.stop",
      commandId: mergeCommandId(),
      operationId: fixture.operationId,
      reason: "Correct integration tests",
    });
    assert.isUndefined(currentFactoryMergeOperation(stopped.state, fixture.integrationId));
    assert.deepEqual(stopped.effects, [
      { type: "merge.operation.resume", operationId: fixture.operationId },
    ]);
    const submitted = submitMergeMember(fixture.state, fixture.operationId);
    const stoppedUnknown = applyMerge(submitted.state, {
      type: "merge.operation.stop",
      commandId: mergeCommandId(),
      operationId: fixture.operationId,
      reason: "Stop further merges",
    });
    assert.isDefined(currentFactoryMergeOperation(stoppedUnknown.state, fixture.integrationId));
    const lead = stoppedUnknown.state.assignments.find(
      (entry) => entry.id === integrated.assignment,
    )!;
    assert.isFalse(factoryCompletionEligibility(stoppedUnknown.state, lead).eligible);
    const confirmed = confirmMergeMember(
      stoppedUnknown.state,
      fixture.operationId,
      submitted.assignmentId,
    );
    assert.equal(confirmed.state.mergeOperations[0]!.lifecycle.phase, "stopped");
    assert.isFalse(confirmed.effects.some((entry) => entry.type === "merge.operation.advance"));
  });
});
