import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type FactoryDecisionCommand,
  type FactoryFinding,
  type FactoryImprovementProposalContent,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { FactorySnapshot as SnapshotSchema } from "@t3tools/contracts";
import { decide, type FactoryActor } from "./FactoryState.ts";
import {
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";
import {
  factoryImprovementBatchPlan,
  factoryImprovementDefaults,
  factoryImprovementFindingDigest,
  factoryImprovementNextDueAt,
  type FactoryImprovementContext,
} from "./FactoryImprovements.ts";

const managerId = ThreadId.make("system-manager");
const human = { kind: "human" } as const;
const host = { kind: "system" } as const;
const manager = { kind: "thread", threadId: managerId } as const;
let sequence = 0;
const id = () => CommandId.make(`improvement-${++sequence}`);
const apply = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = host,
  context: FactoryImprovementContext = {},
  now = deliveryNow,
) => Result.getOrThrow(decide({ state, command, actor, now, ...context }));
const creation = {
  threadId: managerId,
  qualification: {
    status: "qualified" as const,
    profileId: "system-profile",
    checkedAt: deliveryNow,
  },
};
const create = {
  type: "system.create",
  commandId: CommandId.make("system-create"),
  workspaceProjectId: ProjectId.make("skills-workspace"),
  modelSelection: deliverySelection,
  workflow: { repositoryRoot: "C:/skills", revision: "workflow" },
} as const;
const fixture = () => {
  const state = apply(deliveryFixture(), create, human, { systemManagerCreation: creation }).state;
  return apply(state, {
    type: "system.launch.recorded",
    commandId: id(),
    managerId,
    profileId: "system-profile",
  }).state;
};
const finding = (number: number, local = false): FactoryFinding => ({
  id: `finding-${number}`,
  assignmentId: deliveryIds.assignment,
  reporterThreadId: deliveryIds.lead,
  problem: `Problem ${number}`,
  impact: "Repeated review friction",
  evidence: [{ kind: "thread", threadId: deliveryIds.lead }],
  activeBlocker: false,
  route: {
    suspectedCause: local ? "project" : "shared-system",
    uncertainty: "Cause needs investigation",
    owner: { kind: "system-remit" },
    requiredAuthority: "Human review",
    rationale: "Observed in implementation",
  },
  containmentOf: null,
  history: [],
  escalation: null,
  createdAt: deliveryNow,
  updatedAt: deliveryNow,
});
const withRetro = (
  state: FactorySnapshot,
  findings: readonly FactoryFinding[],
): FactorySnapshot => {
  const receipt = {
    digest: "report",
    commandId: id(),
    submittedBy: deliveryIds.lead,
    submittedAt: deliveryNow,
  };
  const learning = { kind: "findings" as const, findingIds: findings.map((entry) => entry.id) };
  return {
    ...state,
    findings,
    retros: [
      {
        id: "retro",
        assignmentId: deliveryIds.assignment,
        conclusionId: "conclusion",
        evidenceDigest: "digest",
        threadId: ThreadId.make("retro-thread"),
        modelSelection: deliverySelection,
        execution: { status: "stopped" },
        reports: {
          phase: "complete",
          team: {
            ...receipt,
            outcome: "Merged",
            helped: "",
            hindered: "",
            contributions: [],
            learning,
          },
          manager: {
            ...receipt,
            summary: "Reviewed learning",
            teamReportDigest: "report",
            learning,
            dispositions: [],
          },
        },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
  };
};
const intake = (
  state: FactorySnapshot,
  item: FactoryFinding,
  origin: "retro" | "explicit-escalation" = "retro",
) =>
  apply(state, {
    type: "improvement.intake",
    commandId: id(),
    findingId: item.id,
    sourceDigest: factoryImprovementFindingDigest(item),
    origin,
  });
const content: FactoryImprovementProposalContent = {
  problem: "Review instructions omit usability checks",
  scope: { kind: "workflow", components: ["review-skill"] },
  exclusions: "No project conventions change",
  expectedBenefit: "Fewer repeated UI corrections",
  tradeoffs: "Longer review input",
  uncertainty: "Evidence is limited",
  requestedDecision: "Approve the proposed instruction change",
  assessmentApproach: null,
};
const investigated = () => {
  const item = {
    ...finding(1),
    escalation: {
      summary: "Investigate shared review instructions",
      commandId: id(),
      escalatedAt: deliveryNow,
    },
  };
  let state: FactorySnapshot = { ...fixture(), findings: [item] };
  state = intake(state, item, "explicit-escalation").state;
  return apply(
    state,
    {
      type: "investigation.open",
      commandId: id(),
      title: "Review consistency",
      findingIds: [item.id],
      relatedInvestigationIds: [],
      uncertainty: "Scope unknown",
    },
    manager,
  );
};

describe("shared improvement authority and intake", () => {
  it("invalidates an in-flight resume when the system manager's model is revoked again", () => {
    let state = apply(
      fixture(),
      { type: "manager.pause", commandId: id(), managerId },
      human,
    ).state;
    const pause = state.controls.find((entry) => entry.kind === "manager-pause")!;
    state = apply(state, {
      type: "control.stop.recorded",
      commandId: id(),
      controlId: pause.id,
      generation: pause.generation,
    }).state;
    state = apply(state, { type: "manager.resume", commandId: id(), managerId }, human).state;
    const revoked = apply(
      state,
      {
        type: "models.defaults.configure",
        commandId: id(),
        policy: { approvedModels: [{ ...deliverySelection, model: "other" }], preferences: [] },
      },
      human,
    );
    state = revoked.state;
    assert.equal(revoked.effects[0]?.type, "control.stop");
    const current = state.controls.find((entry) => entry.id === pause.id)!;
    assert.equal(current.generation, pause.generation + 1);
    state = apply(state, {
      type: "control.resume.recorded",
      commandId: id(),
      controlId: pause.id,
      generation: pause.generation,
    }).state;
    assert.equal(state.managers.find((entry) => entry.id === managerId)!.status, "paused");
    const control = state.controls.find((entry) => entry.id === pause.id)!;
    assert.equal(control.kind === "manager-pause" ? control.status : null, "active");
  });
  it.each(["defaults", "manager"] as const)(
    "pauses and durably stops the system manager when its %s model pool is revoked, requiring explicit resume after restoration",
    (source) => {
      let state = fixture();
      const configure = (approved: boolean): FactoryDecisionCommand => {
        const policy = {
          approvedModels: [
            approved
              ? deliverySelection
              : { ...deliverySelection, model: "different-approved-model" },
          ],
          preferences: [],
        };
        return source === "defaults"
          ? { type: "models.defaults.configure", commandId: id(), policy }
          : { type: "manager.models.configure", commandId: id(), managerId, overrides: policy };
      };
      const before = state.revision;
      const revoked = apply(state, configure(false), human);
      state = revoked.state;
      assert.equal(state.revision, before + 1);
      assert.equal(state.managers.find((entry) => entry.id === managerId)!.status, "paused");
      assert.equal(
        state.managers.find((entry) => entry.id === deliveryIds.manager)!.status,
        "active",
      );
      const stop = revoked.effects.find((entry) => entry.type === "control.stop")!;
      assert.isDefined(stop);
      state = apply(state, {
        type: "control.stop.recorded",
        commandId: id(),
        controlId: stop.controlId,
        generation: stop.generation,
      }).state;
      assert.isTrue(
        Result.isFailure(
          decide({
            state,
            actor: human,
            now: deliveryNow,
            command: { type: "manager.resume", commandId: id(), managerId },
          }),
        ),
      );
      const restored = apply(state, configure(true), human);
      state = restored.state;
      assert.equal(state.managers.find((entry) => entry.id === managerId)!.status, "paused");
      assert.deepStrictEqual(restored.effects, []);
      const resumed = apply(state, { type: "manager.resume", commandId: id(), managerId }, human);
      const resume = resumed.effects.find((entry) => entry.type === "control.resume")!;
      assert.isDefined(resume);
      state = apply(resumed.state, {
        type: "control.resume.recorded",
        commandId: id(),
        controlId: resume.controlId,
        generation: resume.generation,
      }).state;
      assert.equal(state.managers.find((entry) => entry.id === managerId)!.status, "active");
    },
  );
  it("creates one peer system manager without a project assignment and preserves its qualified workspace", () => {
    const base = deliveryFixture();
    const created = apply(base, create, human, { systemManagerCreation: creation });
    const system = created.state.managers.find((entry) => entry.role === "system")!;
    assert.equal(system.projectId, null);
    assert.equal(system.workspaceProjectId, create.workspaceProjectId);
    assert.deepStrictEqual(system.qualification, creation.qualification);
    assert.deepStrictEqual(created.state.assignments, base.assignments);
    assert.deepStrictEqual(created.effects, [
      { type: "system.launch", managerId, profileId: "system-profile" },
    ]);
    assert.isTrue(
      Result.isFailure(
        decide({
          state: created.state,
          command: { ...create, commandId: id() },
          actor: human,
          now: deliveryNow,
          systemManagerCreation: creation,
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state: base,
          command: create,
          actor: { kind: "thread", threadId: deliveryIds.manager },
          now: deliveryNow,
          systemManagerCreation: creation,
        }),
      ),
    );
  });
  it("denies project direction, adoption and configuration to the system manager", () => {
    const state = fixture();
    for (const command of [
      {
        type: "manager.configure",
        commandId: id(),
        managerId: deliveryIds.manager,
        overrides: { delivery: "project-rule" },
      },
      { type: "project.pause", commandId: id(), projectId: deliveryIds.project },
      { type: "improvement.configure", commandId: id(), ...factoryImprovementDefaults },
    ] satisfies FactoryDecisionCommand[])
      assert.isTrue(Result.isFailure(decide({ state, command, actor: manager, now: deliveryNow })));
  });
  it("retains failed launch identity and requires the same pinned profile on retry", () => {
    let state = apply(deliveryFixture(), create, human, { systemManagerCreation: creation }).state;
    state = apply(state, {
      type: "system.launch.failed",
      commandId: id(),
      managerId,
      profileId: "system-profile",
      threadCreated: true,
      reason: "Provider unavailable",
    }).state;
    assert.equal(state.managers.find((entry) => entry.id === managerId)!.threadStatus, "created");
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: human,
          now: deliveryNow,
          command: {
            type: "system.retry",
            commandId: id(),
            managerId,
            workflow: { repositoryRoot: "C:/other", revision: "other" },
          },
          systemManagerCreation: creation,
        }),
      ),
    );
    assert.equal(
      apply(state, { type: "system.retry", commandId: id(), managerId }, human, {
        systemManagerCreation: creation,
      }).effects[0]?.type,
      "system.launch",
    );
  });
  it("preserves a pause during launch acknowledgement and restores the completed launch state on resume", () => {
    let state = apply(deliveryFixture(), create, human, { systemManagerCreation: creation }).state;
    state = apply(state, { type: "manager.pause", commandId: id(), managerId }, human).state;
    state = apply(state, {
      type: "system.launch.recorded",
      commandId: id(),
      managerId,
      profileId: "system-profile",
    }).state;
    assert.equal(state.managers.find((entry) => entry.id === managerId)!.status, "paused");
    const pause = state.controls.find((entry) => entry.kind === "manager-pause");
    assert.equal(pause?.kind === "manager-pause" ? pause.priorStatus : null, "active");
    assert.equal(factoryImprovementNextDueAt(state, deliveryNow), null);
  });
  it("queues explicit escalation before local containment and while the manager is absent", () => {
    const item = {
      ...finding(1),
      escalation: {
        summary: "Suspected shared failure",
        commandId: id(),
        escalatedAt: deliveryNow,
      },
    };
    const state = intake(
      { ...deliveryFixture(), findings: [item] },
      item,
      "explicit-escalation",
    ).state;
    assert.equal(state.improvementIntakes[0]!.delivery.phase, "queued");
    assert.equal(factoryImprovementNextDueAt(state, deliveryNow), null);
    assert.equal(state.findings[0]!.containmentOf, null);
    const active = {
      ...fixture(),
      findings: state.findings,
      improvementIntakes: state.improvementIntakes,
    };
    assert.equal(
      factoryImprovementBatchPlan(active, deliveryNow, { kind: "urgent" })?.intakeIds.length,
      1,
    );
  });
  it("samples every fifth local finding per project, deduplicates evidence, and preserves A/B/A occurrences", () => {
    const items = Array.from({ length: 10 }, (_, index) => finding(index + 1, true));
    let state = withRetro(fixture(), items);
    for (const item of items) state = intake(state, item).state;
    assert.deepStrictEqual(
      state.improvementIntakes
        .filter((entry) => entry.delivery.phase === "queued")
        .map((entry) => entry.findingId),
      ["finding-5", "finding-10"],
    );
    const original = items[0]!;
    const duplicate = {
      ...original,
      evidence: [...original.evidence, ...original.evidence],
      updatedAt: "2026-10-11T00:00:00.000Z",
    };
    assert.equal(
      factoryImprovementFindingDigest(original),
      factoryImprovementFindingDigest(duplicate),
    );
    state = intake({ ...state, findings: [duplicate, ...items.slice(1)] }, duplicate).state;
    assert.equal(state.improvementIntakes.length, 10);
    const changed = { ...original, impact: "New observed impact" };
    state = intake({ ...state, findings: [changed, ...items.slice(1)] }, changed).state;
    state = intake({ ...state, findings: items }, original).state;
    assert.equal(state.improvementIntakes.length, 12);
    assert.deepStrictEqual(
      state.improvementIntakes
        .slice(-2)
        .map((entry) => (entry.sampling.kind === "local" ? entry.sampling.ordinal : null)),
      [11, 12],
    );
    const otherProject = ProjectId.make("second-project");
    const other = { ...finding(20, true), assignmentId: state.assignments[0]!.id };
    const second = withRetro(
      { ...state, assignments: [{ ...state.assignments[0]!, projectId: otherProject }] },
      [other],
    );
    const sampled = intake(second, other).state.improvementIntakes.at(-1)!;
    assert.deepStrictEqual(sampled.sampling, { kind: "local", ordinal: 1, selected: false });
  });
});

describe("bounded improvement batches", () => {
  it("keeps failed notification evidence and budget frozen through an explicit retry", () => {
    const item = finding(1);
    let state = intake(withRetro(fixture(), [item]), item).state;
    state = apply(state, { type: "improvement.flush", commandId: id() }, human).state;
    const original = state.improvementBatches[0]!;
    state = apply(state, {
      type: "improvement.batch.failed",
      commandId: id(),
      batchId: original.id,
      digest: original.digest,
      reason: "Provider unavailable",
    }).state;
    assert.deepStrictEqual(state.improvementBatches[0]!.delivery, {
      status: "pending",
      failure: "Provider unavailable",
    });
    assert.equal(factoryImprovementNextDueAt(state, "2026-10-12T00:00:00.000Z"), null);
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: manager,
          now: deliveryNow,
          command: { type: "improvement.batch.retry", commandId: id(), batchId: original.id },
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: host,
          now: deliveryNow,
          command: {
            type: "improvement.batch.failed",
            commandId: id(),
            batchId: original.id,
            digest: "stale",
            reason: "Wrong version",
          },
        }),
      ),
    );
    const retry = apply(
      state,
      { type: "improvement.batch.retry", commandId: id(), batchId: original.id },
      human,
    );
    assert.deepStrictEqual(retry.state.improvementBatches, [original]);
    assert.deepStrictEqual(retry.effects, [{ type: "improvement.reconcile" }]);
    state = apply(retry.state, {
      type: "improvement.batch.delivered",
      commandId: id(),
      batchId: original.id,
      digest: original.digest,
      messageId: MessageId.make("recovered-delivery"),
    }).state;
    state = apply(state, {
      type: "improvement.batch.failed",
      commandId: id(),
      batchId: original.id,
      digest: original.digest,
      reason: "Late failure",
    }).state;
    assert.equal(state.improvementBatches.length, 1);
    assert.equal(state.improvementBatches[0]!.budgetDay, original.budgetDay);
    assert.equal(state.improvementBatches[0]!.delivery.status, "delivered");
  });
  it("seals a fixed bounded payload and budget debit, while urgent evidence bypasses a pending routine batch", () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      ...finding(index + 1),
      problem: "A".repeat(6_000),
    }));
    let state = withRetro(fixture(), items);
    for (const item of items) state = intake(state, item).state;
    const result = apply(state, {
      type: "improvement.batch.requested",
      commandId: id(),
      expectedStateRevision: state.revision,
      kind: "routine",
    });
    state = result.state;
    const batch = state.improvementBatches[0]!;
    assert.equal(batch.intakeIds.length, 20);
    assert.isAtMost(batch.summary.length, 16_000);
    assert.isAbove(batch.summary.length, 6_000);
    assert.equal(batch.budgetDay, "2026-10-10");
    assert.equal(
      factoryImprovementBatchPlan(state, deliveryNow, { kind: "routine", force: true }),
      undefined,
    );
    const urgent = {
      ...finding(40),
      escalation: { summary: "Current shared outage", commandId: id(), escalatedAt: deliveryNow },
    };
    state = intake(
      { ...state, findings: [...state.findings, urgent] },
      urgent,
      "explicit-escalation",
    ).state;
    const urgentPlan = factoryImprovementBatchPlan(state, deliveryNow, { kind: "urgent" })!;
    assert.equal(urgentPlan.intakeIds.length, 1);
    assert.equal(urgentPlan.budgetDay, null);
    assert.deepStrictEqual(state.improvementBatches[0], batch);
    const receipt = {
      type: "improvement.batch.delivered",
      commandId: id(),
      batchId: batch.id,
      digest: batch.digest,
      messageId: MessageId.make("batch-message"),
    } as const;
    state = apply(state, receipt).state;
    state = apply(state, { ...receipt, commandId: id() }).state;
    assert.equal(state.improvementBatches.length, 1);
    assert.equal(state.improvementBatches[0]!.delivery.status, "delivered");
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: host,
          now: deliveryNow,
          command: { ...receipt, commandId: id(), digest: "wrong" },
        }),
      ),
    );
    const decode = Schema.decodeUnknownSync(SnapshotSchema);
    assert.equal(
      decode(JSON.parse(JSON.stringify(state))).improvementBatches[0]!.summary,
      batch.summary,
    );
  });
  it("defers routine budget exhaustion to the next UTC day and never wakes an unavailable manager", () => {
    const items = Array.from({ length: 3 }, (_, index) => finding(index + 1));
    let state = withRetro(fixture(), items);
    state = apply(
      state,
      {
        type: "improvement.configure",
        commandId: id(),
        ...factoryImprovementDefaults,
        routineThreshold: 1,
        maxBatchItems: 1,
      },
      human,
    ).state;
    for (const item of items) state = intake(state, item).state;
    for (let count = 0; count < 2; count++) {
      state = apply(state, { type: "improvement.flush", commandId: id() }, human).state;
      const batch = state.improvementBatches.at(-1)!;
      state = apply(state, {
        type: "improvement.batch.delivered",
        commandId: id(),
        batchId: batch.id,
        digest: batch.digest,
        messageId: MessageId.make(`message-${count}`),
      }).state;
    }
    assert.equal(factoryImprovementNextDueAt(state, deliveryNow), "2026-10-11T00:00:00.000Z");
    assert.equal(
      apply(state, { type: "improvement.flush", commandId: id() }, human).state.improvementBatches
        .length,
      2,
    );
    const paused = {
      ...state,
      managers: state.managers.map((entry) =>
        entry.id === managerId ? { ...entry, status: "paused" as const } : entry,
      ),
    };
    assert.equal(factoryImprovementNextDueAt(paused, "2026-10-12T00:00:00.000Z"), null);
    assert.equal(
      factoryImprovementBatchPlan(state, "2026-10-11T00:00:00.000Z", { kind: "routine" })?.intakeIds
        .length,
      1,
    );
  });
  it("schedules a sparse routine backlog at its age deadline and rejects stale seal requests", () => {
    const item = finding(1);
    const state = intake(withRetro(fixture(), [item]), item).state;
    assert.equal(factoryImprovementNextDueAt(state, deliveryNow), "2026-10-11T20:00:00.000Z");
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: host,
          now: deliveryNow,
          command: {
            type: "improvement.batch.requested",
            commandId: id(),
            kind: "routine",
            expectedStateRevision: state.revision - 1,
          },
        }),
      ),
    );
  });
});

describe("proposal review", () => {
  it("accepts an exact untested workflow proposal without changing project grants or adopting a workflow", () => {
    const investigation = investigated();
    let result = apply(
      investigation.state,
      {
        type: "proposal.write",
        commandId: id(),
        investigationId: investigation.result.investigationId!,
        content,
      },
      manager,
    );
    const proposalId = result.result.proposalId!;
    const revision = result.result.proposalRevision!;
    result = apply(
      result.state,
      { type: "proposal.submit", commandId: id(), proposalId, revision },
      manager,
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state: result.state,
          actor: manager,
          now: deliveryNow,
          command: {
            type: "proposal.decide",
            commandId: id(),
            proposalId,
            revision,
            outcome: "accepted",
            reason: "Approve",
          },
        }),
      ),
    );
    const accepted = apply(
      result.state,
      {
        type: "proposal.decide",
        commandId: id(),
        proposalId,
        revision,
        outcome: "accepted",
        reason: "The human agrees with the proposed scope",
      },
      human,
    );
    assert.equal(accepted.state.improvementDecisions[0]!.revision, revision);
    assert.deepStrictEqual(accepted.state.assignments, investigation.state.assignments);
    assert.deepStrictEqual(accepted.state.defaults, investigation.state.defaults);
    assert.deepStrictEqual(accepted.effects, []);
    assert.equal(accepted.state.improvementProposals[0]!.content.assessmentApproach, null);
  });
  it("invalidates an old review when a new immutable revision is written and records usefulness independently", () => {
    const investigation = investigated();
    let result = apply(
      investigation.state,
      {
        type: "proposal.write",
        commandId: id(),
        investigationId: investigation.result.investigationId!,
        content,
      },
      manager,
    );
    const proposalId = result.result.proposalId!;
    const oldRevision = result.result.proposalRevision!;
    result = apply(
      result.state,
      { type: "proposal.submit", commandId: id(), proposalId, revision: oldRevision },
      manager,
    );
    result = apply(
      result.state,
      {
        type: "proposal.write",
        commandId: id(),
        investigationId: investigation.result.investigationId!,
        proposalId,
        content: { ...content, tradeoffs: "Revised tradeoff" },
      },
      manager,
    );
    const revision = result.result.proposalRevision!;
    assert.isTrue(
      Result.isFailure(
        decide({
          state: result.state,
          actor: human,
          now: deliveryNow,
          command: {
            type: "proposal.decide",
            commandId: id(),
            proposalId,
            revision: oldRevision,
            outcome: "accepted",
            reason: "Stale review",
          },
        }),
      ),
    );
    result = apply(
      result.state,
      { type: "proposal.submit", commandId: id(), proposalId, revision },
      manager,
    );
    result = apply(
      result.state,
      {
        type: "proposal.decide",
        commandId: id(),
        proposalId,
        revision,
        outcome: "rejected",
        reason: "Wrong timing",
      },
      human,
    );
    assert.equal(result.state.improvementFeedback.length, 0);
    result = apply(
      result.state,
      {
        type: "proposal.feedback",
        commandId: id(),
        proposalId,
        revision,
        usefulness: "useful",
        reason: "A valid observation despite deferring action",
      },
      human,
    );
    assert.equal(result.state.improvementFeedback[0]!.usefulness, "useful");
    assert.equal(result.state.improvementDecisions[0]!.outcome, "rejected");
    assert.equal(result.state.improvementProposals[0]!.content.tradeoffs, content.tradeoffs);
  });
  it("records only evidence attached to an open named investigation", () => {
    const investigation = investigated();
    const state = investigation.state;
    const command = {
      type: "improvement.evidence.read",
      commandId: id(),
      managerId,
      investigationId: investigation.result.investigationId!,
      findingId: "finding-1",
      evidenceRef: { kind: "thread", threadId: deliveryIds.lead },
      cursor: { afterPosition: -1, offset: 0, digest: null },
      limit: 1000,
      characters: 500,
      digest: "read-digest",
    } as const;
    const result = apply(state, command);
    assert.equal(result.state.improvementEvidenceReads[0]!.assignmentId, deliveryIds.assignment);
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: host,
          now: deliveryNow,
          command: {
            ...command,
            commandId: id(),
            evidenceRef: { kind: "thread", threadId: deliveryIds.manager },
          },
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: host,
          now: deliveryNow,
          command: { ...command, commandId: id(), characters: 1001 },
        }),
      ),
    );
  });
});
