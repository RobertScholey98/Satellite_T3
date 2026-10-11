import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryControlId,
  FactorySnapshot,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type FactoryControl,
  type FactoryDecisionCommand,
  type FactoryOnboardingReport,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { decide, initialFactorySnapshot, type FactoryActor } from "./FactoryState.ts";
import { sharedAccessFixture } from "./FactorySharedAccess.testkit.ts";
import {
  factoryDirectionBlocked,
  factoryExecutionBlocked,
  type FactoryControlContext,
} from "./FactoryControls.ts";

const now = "2026-10-10T12:00:00.000Z";
const managerId = ThreadId.make("manager");
const leadId = ThreadId.make("lead");
const workerId = ThreadId.make("worker");
const childId = ThreadId.make("worker-child");
const projectId = ProjectId.make("project");
const assignmentId = FactoryAssignmentId.make("assignment");
const commandId = CommandId.make("command");
const messageId = MessageId.make("human-guidance");
const human = { kind: "human" } as const;
const system = { kind: "system" } as const;
const member = { threadId: leadId, managerId, projectId, assignmentId, ancestorThreadIds: [] };
const worker = { ...member, threadId: workerId, ancestorThreadIds: [leadId] };
const child = { ...member, threadId: childId, ancestorThreadIds: [leadId, workerId] };
const managerMember = { threadId: managerId, managerId, projectId, ancestorThreadIds: [] };
const snapshotJson = Schema.fromJsonString(FactorySnapshot);
const encodeSnapshot = Schema.encodeSync(snapshotJson);
const decodeSnapshot = Schema.decodeSync(snapshotJson);
const decodeLegacySnapshot = Schema.decodeSync(FactorySnapshot);

const apply = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = human,
  context: FactoryControlContext = {},
) => Result.getOrThrow(decide({ state, command, actor, now, ...context }));

const fixture = () => {
  const created = Result.getOrThrow(
    decide({
      state: initialFactorySnapshot(),
      actor: human,
      now,
      command: {
        type: "manager.create",
        commandId,
        projectId,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved" },
        workflow: { repositoryRoot: "C:/skills", revision: "pinned" },
      },
      allocation: { managerThreadId: managerId, leadThreadId: leadId, assignmentId },
      qualification: { status: "qualified", profileId: "profile", checkedAt: now },
    }),
  );
  return apply(
    apply(created.state, { type: "thread.launch.recorded", commandId, threadId: managerId }, system)
      .state,
    { type: "thread.launch.recorded", commandId, threadId: leadId },
    system,
  ).state;
};

const control = (state: FactorySnapshot, kind: FactoryControl["kind"]) => {
  const found = state.controls.find((entry) => entry.kind === kind);
  if (!found) throw new Error(`Missing ${kind} control`);
  return found;
};
const receipt = (
  state: FactorySnapshot,
  kind: FactoryControl["kind"],
  type: "control.stop.recorded" | "control.resume.recorded",
) => {
  const target = control(state, kind);
  return apply(
    state,
    { type, commandId, controlId: target.id, generation: target.generation },
    system,
  ).state;
};
const failure = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = human,
  context: FactoryControlContext = {},
) => {
  const result = decide({ state, command, actor, now, ...context });
  if (Result.isSuccess(result)) throw new Error("Expected rejected command");
  return result.failure.code;
};

describe("Factory controls", () => {
  it("keeps withdrawn authority held after a workflow restart becomes ready", () => {
    const shared = sharedAccessFixture(fixture());
    const held: FactorySnapshot = {
      ...shared,
      assignments: shared.assignments.map((entry) => ({
        ...entry,
        wait: { kind: "authority", reason: "Repository authority was withdrawn" },
      })),
    };
    assert.isDefined(factoryExecutionBlocked(held, { ...worker, managerRole: "system" }));
    assert.isDefined(factoryExecutionBlocked(held, { ...child, managerRole: "system" }));
    assert.isUndefined(factoryExecutionBlocked(held, { ...managerMember, managerRole: "system" }));
  });
  it("pauses shared repository teams without pausing the peer system manager", () => {
    const shared = sharedAccessFixture(fixture());
    const paused = apply(shared, { type: "project.pause", commandId, projectId }).state;
    assert.isDefined(factoryExecutionBlocked(paused, { ...worker, managerRole: "system" }));
    assert.isUndefined(
      factoryExecutionBlocked(paused, { ...managerMember, managerRole: "system" }),
    );
  });
  it("pauses manager initiation and direction while existing teams keep working", () => {
    const paused = apply(fixture(), { type: "manager.pause", commandId, managerId });
    assert.strictEqual(paused.state.managers[0]?.status, "paused");
    assert.strictEqual(paused.effects[0]?.type, "control.stop");
    assert.isDefined(factoryExecutionBlocked(paused.state, managerMember));
    assert.isUndefined(factoryExecutionBlocked(paused.state, worker));
    assert.isDefined(factoryDirectionBlocked(paused.state, worker, managerId));
    assert.isUndefined(factoryDirectionBlocked(paused.state, worker, leadId));
  });

  it("retires a manager for good, stopping its teams and releasing its project", () => {
    const managerThread = { kind: "thread", threadId: managerId } as const;
    const retire = { type: "manager.retire", commandId, managerId } as const;
    assert.strictEqual(failure(fixture(), retire, managerThread), "permission-denied");
    const retired = apply(apply(fixture(), { type: "manager.pause", commandId, managerId }).state, {
      ...retire,
      commandId: CommandId.make("retire"),
    });
    assert.strictEqual(retired.state.managers[0]?.status, "retired");
    assert.strictEqual(retired.state.assignments[0]?.outcome?.kind, "cancelled");
    assert.deepStrictEqual(
      retired.effects.map((effect) => effect.type),
      ["control.stop"],
    );
    assert.include(factoryExecutionBlocked(retired.state, managerMember), "retired");
    assert.include(factoryExecutionBlocked(retired.state, member), "retired");
    let state = receipt(retired.state, "manager-pause", "control.stop.recorded");
    assert.strictEqual(
      failure(state, { type: "manager.resume", commandId, managerId }),
      "invalid-state",
    );
    assert.strictEqual(
      apply(state, { type: "manager.pause", commandId: CommandId.make("pause"), managerId }).state
        .managers[0]?.status,
      "retired",
    );
    state = apply(state, {
      type: "policy.defaults.configure",
      commandId: CommandId.make("defaults"),
      defaults: state.defaults,
    }).state;
    assert.strictEqual(state.managers[0]?.status, "retired");
    assert.deepStrictEqual(apply(state, retire).effects, []);
    const recreated = Result.getOrThrow(
      decide({
        state,
        actor: human,
        now,
        command: {
          type: "manager.create",
          commandId: CommandId.make("recreate"),
          projectId,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved" },
          workflow: { repositoryRoot: "C:/skills", revision: "pinned" },
        },
        allocation: {
          managerThreadId: ThreadId.make("manager-2"),
          leadThreadId: ThreadId.make("lead-2"),
          assignmentId: FactoryAssignmentId.make("assignment-2"),
        },
        qualification: { status: "qualified", profileId: "profile-2", checkedAt: now },
      }),
    );
    assert.deepStrictEqual(
      recreated.state.managers.map((entry) => [entry.id, entry.status]),
      [
        [managerId, "retired"],
        [ThreadId.make("manager-2"), "onboarding"],
      ],
    );
  });

  it("resuming a project retains a separate manager pause and takeover", () => {
    let state = apply(fixture(), { type: "manager.pause", commandId, managerId }).state;
    state = apply(state, { type: "thread.takeover", commandId, threadId: workerId }, human, {
      controlTarget: worker,
    }).state;
    state = apply(state, { type: "project.pause", commandId, projectId }).state;
    assert.isDefined(factoryExecutionBlocked(state, worker));
    assert.strictEqual(
      failure(state, { type: "project.resume", commandId, projectId }),
      "invalid-state",
    );
    state = receipt(state, "project-pause", "control.stop.recorded");
    state = apply(state, { type: "project.resume", commandId, projectId }).state;
    assert.isDefined(factoryExecutionBlocked(state, worker));
    state = receipt(state, "project-pause", "control.resume.recorded");
    assert.isUndefined(factoryExecutionBlocked(state, worker));
    assert.isDefined(factoryExecutionBlocked(state, managerMember));
    assert.isDefined(factoryDirectionBlocked(state, worker, leadId));
    assert.isUndefined(factoryDirectionBlocked(state, worker));
  });

  it("keeps stop failures prohibited, retries the same generation, and can still resume", () => {
    let state = apply(fixture(), { type: "project.pause", commandId, projectId }).state;
    const paused = control(state, "project-pause");
    state = apply(
      state,
      {
        type: "control.stop.failed",
        commandId,
        controlId: paused.id,
        generation: paused.generation,
        reason: "Provider did not detach",
      },
      system,
    ).state;
    assert.isDefined(factoryExecutionBlocked(state, worker));
    // Releasing a pause is always safe, so a stop that never settles is not a one-way door.
    const resumed = receipt(
      apply(state, { type: "project.resume", commandId, projectId }).state,
      "project-pause",
      "control.resume.recorded",
    );
    assert.isUndefined(factoryExecutionBlocked(resumed, worker));
    const retry = apply(state, {
      type: "control.retry",
      commandId,
      controlId: paused.id,
      generation: paused.generation,
    });
    assert.deepStrictEqual(retry.effects, [
      { type: "control.stop", controlId: paused.id, generation: 1 },
    ]);
    assert.strictEqual(
      failure(state, { type: "control.retry", commandId, controlId: paused.id, generation: 0 }),
      "invalid-state",
    );
  });

  it("retains captured resume targets across failed stops and does not wake idle teams", () => {
    let state = apply(fixture(), { type: "project.pause", commandId, projectId }).state;
    const paused = control(state, "project-pause");
    state = apply(
      state,
      {
        type: "control.stop.targets.recorded",
        commandId,
        controlId: paused.id,
        generation: 1,
        threadIds: [workerId, workerId],
      },
      system,
    ).state;
    state = apply(
      state,
      {
        type: "control.stop.targets.recorded",
        commandId,
        controlId: paused.id,
        generation: 1,
        threadIds: [],
      },
      system,
    ).state;
    state = receipt(state, "project-pause", "control.stop.recorded");
    state = apply(state, { type: "project.resume", commandId, projectId }).state;
    const resumed = apply(
      state,
      { type: "control.resume.recorded", commandId, controlId: paused.id, generation: 1 },
      system,
    );
    assert.strictEqual(resumed.effects.length, 1);
    assert.strictEqual(resumed.effects[0]?.type, "thread.deliver");
    if (resumed.effects[0]?.type !== "thread.deliver") throw new Error("Missing continuation");
    assert.strictEqual(resumed.effects[0].threadId, workerId);
    assert.strictEqual(resumed.effects[0].kind, "continuation");
  });

  it("uses a newer generation for another pause and ignores old resume receipts", () => {
    let state = apply(fixture(), { type: "project.pause", commandId, projectId }).state;
    const first = control(state, "project-pause");
    state = receipt(state, "project-pause", "control.stop.recorded");
    state = apply(state, { type: "project.resume", commandId, projectId }).state;
    state = receipt(state, "project-pause", "control.resume.recorded");
    state = apply(state, { type: "project.pause", commandId, projectId }).state;
    const second = control(state, "project-pause");
    assert.strictEqual(second.id, first.id);
    assert.strictEqual(second.generation, 2);
    state = apply(
      state,
      { type: "control.resume.recorded", commandId, controlId: first.id, generation: 1 },
      system,
    ).state;
    assert.isDefined(factoryExecutionBlocked(state, child));
  });

  it("resumes captured queues after active work and creates no continuation for queue-only threads", () => {
    let state = apply(fixture(), { type: "project.pause", commandId, projectId }).state;
    const paused = control(state, "project-pause");
    const runIds = [RunId.make("queued-before-pause")];
    state = apply(
      state,
      {
        type: "control.stop.targets.recorded",
        commandId,
        controlId: paused.id,
        generation: 1,
        threadIds: [leadId],
        resumeQueues: [{ threadId: workerId, runIds }],
      },
      system,
    ).state;
    state = receipt(state, "project-pause", "control.stop.recorded");
    state = apply(state, { type: "project.resume", commandId, projectId }).state;
    const resumed = apply(
      state,
      {
        type: "control.resume.recorded",
        commandId,
        controlId: paused.id,
        generation: 1,
      },
      system,
    );
    assert.deepStrictEqual(
      resumed.effects.map((effect) => effect.type),
      ["thread.deliver", "thread.queue.resume"],
    );
    assert.deepStrictEqual(resumed.effects[1], {
      type: "thread.queue.resume",
      controlId: paused.id,
      generation: 1,
      threadId: workerId,
      runIds,
    });
    if (resumed.effects[0]?.type !== "thread.deliver")
      throw new Error("Missing active continuation");
    assert.strictEqual(resumed.effects[0].threadId, leadId);
    const restored = decodeSnapshot(encodeSnapshot(resumed.state));
    const pause = control(restored, "project-pause");
    if (pause.kind !== "project-pause") throw new Error("Missing pause");
    assert.deepStrictEqual(pause.resumeQueues, [{ threadId: workerId, runIds }]);
  });

  it("keeps a failed resume blocked and does not release a separate project pause", () => {
    let state = apply(fixture(), { type: "manager.pause", commandId, managerId }).state;
    state = apply(state, { type: "project.pause", commandId, projectId }).state;
    state = receipt(state, "manager-pause", "control.stop.recorded");
    state = apply(state, { type: "manager.resume", commandId, managerId }).state;
    const paused = control(state, "manager-pause");
    state = apply(
      state,
      {
        type: "control.resume.failed",
        commandId,
        controlId: paused.id,
        generation: paused.generation,
        reason: "Environment unavailable",
      },
      system,
    ).state;
    assert.strictEqual(state.managers[0]?.status, "paused");
    const retried = apply(state, {
      type: "control.retry",
      commandId,
      controlId: paused.id,
      generation: paused.generation,
    });
    assert.deepStrictEqual(retried.effects, [
      { type: "control.resume", controlId: paused.id, generation: paused.generation },
    ]);
    state = receipt(retried.state, "manager-pause", "control.resume.recorded");
    assert.strictEqual(state.managers[0]?.status, "onboarding");
    assert.isDefined(factoryExecutionBlocked(state, managerMember));
    assert.isDefined(factoryExecutionBlocked(state, worker));
  });

  it("allows human guidance and subtree coordination during takeover but holds parent direction", () => {
    const taken = apply(
      fixture(),
      { type: "thread.takeover", commandId, threadId: workerId },
      human,
      { controlTarget: worker },
    );
    assert.isUndefined(factoryDirectionBlocked(taken.state, worker));
    assert.isUndefined(factoryDirectionBlocked(taken.state, child, workerId));
    assert.isDefined(factoryDirectionBlocked(taken.state, worker, leadId));
    assert.isDefined(factoryDirectionBlocked(taken.state, child, managerId));
    assert.isDefined(factoryDirectionBlocked(taken.state, child, null));
    const handed = apply(taken.state, { type: "thread.handback", commandId, threadId: workerId });
    assert.isUndefined(factoryDirectionBlocked(handed.state, worker, leadId));
    assert.strictEqual(handed.effects[0]?.type, "thread.queue.resume");
  });

  it("requires host-resolved membership for takeover and human authority for release", () => {
    assert.strictEqual(
      failure(fixture(), { type: "thread.takeover", commandId, threadId: workerId }),
      "invalid-state",
    );
    const state = apply(
      fixture(),
      { type: "thread.takeover", commandId, threadId: workerId },
      human,
      { controlTarget: worker },
    ).state;
    assert.strictEqual(
      failure(
        state,
        { type: "thread.handback", commandId, threadId: workerId },
        { kind: "thread", threadId: managerId },
      ),
      "permission-denied",
    );
    assert.strictEqual(
      failure(
        state,
        { type: "project.resume", commandId, projectId },
        { kind: "thread", threadId: leadId },
      ),
      "permission-denied",
    );
  });

  it("stops cancellation before accepting a human reason and never treats it as delivered", () => {
    const before = fixture();
    let state = apply(before, { type: "assignment.cancel", commandId, assignmentId }).state;
    const cancellation = control(state, "cancellation");
    assert.strictEqual(state.assignments[0]?.status, "waiting");
    assert.strictEqual(state.assignments[0]?.outcome?.kind, "cancelled");
    assert.isDefined(factoryExecutionBlocked(state, worker));
    assert.strictEqual(
      failure(state, {
        type: "assignment.cancellation-reason",
        commandId,
        assignmentId,
        reason: "No longer needed",
      }),
      "invalid-state",
    );
    state = receipt(state, "cancellation", "control.stop.recorded");
    assert.strictEqual(
      failure(
        state,
        {
          type: "assignment.cancellation-reason",
          commandId,
          assignmentId,
          reason: "No longer needed",
        },
        { kind: "thread", threadId: managerId },
      ),
      "permission-denied",
    );
    state = apply(state, {
      type: "assignment.cancellation-reason",
      commandId,
      assignmentId,
      reason: "Priority changed",
    }).state;
    state = apply(
      state,
      { type: "thread.launch.recorded", commandId, threadId: leadId },
      system,
    ).state;
    assert.strictEqual(state.assignments[0]?.status, "waiting");
    assert.isDefined(factoryExecutionBlocked(state, child));
    assert.strictEqual(
      failure(state, { type: "assignment.retry", commandId, assignmentId }),
      "invalid-state",
    );
    assert.deepStrictEqual(state.assignments[0]?.workflow, before.assignments[0]?.workflow);
    assert.strictEqual(control(state, "cancellation").id, cancellation.id);
  });

  it("permits cancellation only by the human or the owning manager", () => {
    const command = { type: "assignment.cancel", commandId, assignmentId } as const;
    assert.strictEqual(
      failure(fixture(), command, { kind: "thread", threadId: leadId }),
      "permission-denied",
    );
    assert.strictEqual(
      failure(fixture(), command, { kind: "thread", threadId: ThreadId.make("other-manager") }),
      "permission-denied",
    );
    const cancelled = apply(fixture(), command, { kind: "thread", threadId: managerId });
    assert.strictEqual(cancelled.effects[0]?.type, "control.stop");
    const repeated = apply(cancelled.state, command, human);
    assert.deepStrictEqual(repeated.effects, []);
    assert.strictEqual(repeated.state.controls.length, 1);
  });

  it("prevents manager cancellation across takeover or pause while retaining human cancellation", () => {
    const actor = { kind: "thread", threadId: managerId } as const;
    const cancel = { type: "assignment.cancel", commandId, assignmentId } as const;
    const states = [
      apply(fixture(), { type: "thread.takeover", commandId, threadId: workerId }, human, {
        controlTarget: worker,
      }).state,
      apply(fixture(), { type: "manager.pause", commandId, managerId }).state,
      apply(fixture(), { type: "project.pause", commandId, projectId }).state,
    ];
    for (const state of states) {
      assert.strictEqual(failure(state, cancel, actor), "permission-denied");
      const cancelled = apply(state, cancel);
      assert.strictEqual(cancelled.state.assignments[0]?.outcome?.kind, "cancelled");
      assert.strictEqual(cancelled.effects[0]?.type, "control.stop");
    }
  });

  it("deduplicates human guidance, notifies the lead once, and preserves parent ownership", () => {
    const observed = apply(
      fixture(),
      { type: "guidance.observed", commandId, threadId: workerId, messageId, assignmentId },
      system,
    );
    assert.strictEqual(observed.effects.length, 1);
    assert.strictEqual(observed.effects[0]?.type, "thread.deliver");
    if (observed.effects[0]?.type !== "thread.deliver") throw new Error("Missing guidance");
    assert.strictEqual(observed.effects[0].threadId, leadId);
    assert.isUndefined(factoryDirectionBlocked(observed.state, worker, leadId));
    const again = apply(
      observed.state,
      { type: "guidance.observed", commandId, threadId: workerId, messageId, assignmentId },
      system,
    );
    assert.strictEqual(again.state.guidance.length, 1);
    assert.deepStrictEqual(again.effects, []);
    const direct = apply(
      again.state,
      {
        type: "guidance.observed",
        commandId,
        threadId: leadId,
        messageId: MessageId.make("lead-human"),
        assignmentId,
      },
      system,
    );
    assert.deepStrictEqual(direct.effects, []);
  });

  it("requires verified human-message provenance for manager escalation without expanding scope", () => {
    const state = fixture();
    const command = {
      type: "guidance.escalate",
      commandId,
      threadId: workerId,
      messageId,
      summary: "User requests a different priority",
    } as const;
    const actor = { kind: "thread", threadId: leadId } as const;
    assert.strictEqual(failure(state, command, actor), "assignment-not-found");
    assert.strictEqual(
      failure(state, command, actor, {
        guidance: { messageId: MessageId.make("different"), target: worker },
      }),
      "permission-denied",
    );
    const escalated = apply(state, command, actor, { guidance: { messageId, target: worker } });
    assert.strictEqual(escalated.effects.length, 2);
    assert.deepStrictEqual(escalated.state.assignments, state.assignments);
    const repeated = apply(escalated.state, command, actor, {
      guidance: { messageId, target: worker },
    });
    assert.deepStrictEqual(repeated.effects, []);
    assert.strictEqual(repeated.state.guidance[0]?.escalation?.summary, command.summary);
  });

  it("preserves onboarding results received while a manager is paused", () => {
    let state = apply(fixture(), { type: "manager.pause", commandId, managerId }).state;
    const report: FactoryOnboardingReport = {
      summary: "Boundary proposal ready",
      instructions: [],
      checks: [],
      tracker: { description: "Project tracker", evidence: [] },
      verificationTools: [],
      protectedControls: [],
      unresolvedDecisions: [],
    };
    state = apply(
      state,
      { type: "onboarding.report", commandId, assignmentId, report },
      { kind: "thread", threadId: leadId },
    ).state;
    assert.strictEqual(state.managers[0]?.status, "paused");
    state = receipt(state, "manager-pause", "control.stop.recorded");
    state = apply(state, { type: "manager.resume", commandId, managerId }).state;
    state = receipt(state, "manager-pause", "control.resume.recorded");
    assert.strictEqual(state.managers[0]?.status, "blocked");
    assert.strictEqual(state.managers[0]?.wait?.kind, "execution-boundary");
    assert.strictEqual(state.assignments[0]?.report?.summary, report.summary);
  });

  it("round-trips pending controls and decodes snapshots written before controls existed", () => {
    const state = apply(fixture(), { type: "project.pause", commandId, projectId }).state;
    const restored = decodeSnapshot(encodeSnapshot(state));
    assert.isDefined(factoryExecutionBlocked(restored, worker));
    assert.strictEqual(
      control(restored, "project-pause").id,
      FactoryControlId.make(`project-pause:${projectId}`),
    );
    const { controls: _, guidance: __, ...previous } = fixture();
    const legacy = decodeLegacySnapshot(previous);
    assert.deepStrictEqual(legacy.controls, []);
    assert.deepStrictEqual(legacy.guidance, []);
  });
});
