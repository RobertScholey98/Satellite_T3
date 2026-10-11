import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactoryDependencyId,
  FactorySnapshot,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type FactoryAssignment,
  type FactoryDecisionCommand,
  type FactoryDeliveryEvidence,
  type FactorySupportingWork,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { decide, initialFactorySnapshot, type FactoryActor } from "./FactoryState.ts";
import { initialFactoryOversight, type FactoryOversightContext } from "./FactoryOversight.ts";
import { initialFactoryCompletion } from "./FactoryRetros.ts";

const now = "2026-10-10T12:00:00.000Z";
const commandId = CommandId.make("command");
const assignmentId = FactoryAssignmentId.make("assignment");
const supportId = FactoryAssignmentId.make("support");
const managerId = ThreadId.make("manager");
const leadId = ThreadId.make("lead");
const supportLeadId = ThreadId.make("support-lead");
const diagnosisId = ThreadId.make("diagnosis");
const replacementId = ThreadId.make("replacement");
const projectId = ProjectId.make("project");
const boundaryId = FactoryBoundaryId.make("boundary");
const dependencyId = FactoryDependencyId.make("dependency");
const secondDependencyId = FactoryDependencyId.make("second-dependency");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "approved" };
const workflow = { repositoryRoot: "C:/skills", revision: "pinned" };
const qualification = { status: "qualified", profileId: "profile", checkedAt: now } as const;
const human = { kind: "human" } as const;
const system = { kind: "system" } as const;
const manager = { kind: "thread", threadId: managerId } as const;
const lead = { kind: "thread", threadId: leadId } as const;
const evidence = [{ label: "failure", location: "thread://lead/run" }];
const ref = { projectId, repository: "owner/repository", number: 12 };
const work: FactorySupportingWork = {
  title: "Supply the missing capability",
  scope: {
    description: "Implement the missing capability",
    completionCondition: "The capability PR is merged",
    requiresPullRequest: true,
  },
  complexity: "standard",
  kind: "implementation",
  sourcePaths: ["src/api.ts"],
  creatableDirectories: [],
};
const delivered: FactoryDeliveryEvidence = {
  kind: "pull-request-merged",
  id: "delivery",
  projectId,
  ref,
  headSha: "head",
  mergedAt: now,
  observedAt: now,
};

const fixture = (): FactorySnapshot => {
  const state = initialFactorySnapshot();
  const assignment: FactoryAssignment = {
    id: assignmentId,
    managerId,
    threadId: leadId,
    projectId,
    kind: "implementation",
    title: "Original work",
    scope: {
      description: "Build original feature",
      completionCondition: "Its PR is merged",
      requiresPullRequest: true,
    },
    modelSelection: selection,
    modelPolicy: { approvedModels: [selection], preferences: [] },
    complexity: "standard",
    preparation: "ready",
    status: "running",
    threadStatus: "created",
    launchStatus: "delivered",
    qualification,
    workflow,
    grantedPolicy: state.defaults,
    grant: {
      boundaryId,
      epoch: 2,
      sourcePaths: ["src/original.ts"],
      creatableDirectories: [],
      controlChange: null,
    },
    wait: null,
    report: null,
    oversight: initialFactoryOversight(),
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...state,
    assignments: [assignment],
    managers: [
      {
        id: managerId,
        threadId: managerId,
        name: "Manager",
        modelSelection: selection,
        workflow,
        overrides: {},
        status: "active",
        threadStatus: "created",
        launchStatus: "delivered",
        wait: null,
        role: "project",
        projectId,
        boundaryId,
        createdAt: now,
        updatedAt: now,
      },
    ],
    boundaries: [
      {
        id: boundaryId,
        projectId,
        sourceRevision: "source",
        workflow,
        profileId: "boundary-profile",
        approvedAt: now,
        protectedPaths: ["eslint.config.ts"],
        writablePaths: ["src/api.ts", "src/original.ts"],
        creatableDirectories: [],
        gates: [],
      },
    ],
  };
};
const apply = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = human,
  context: FactoryOversightContext = {},
) => Result.getOrThrow(decide({ state, actor, command, now, ...context }));
const failure = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = human,
  context: FactoryOversightContext = {},
) => {
  const result = decide({ state, actor, command, now, ...context });
  if (Result.isSuccess(result)) throw new Error("Expected rejection");
  return result.failure.code;
};
const original = (state: FactorySnapshot) =>
  state.assignments.find((entry) => entry.id === assignmentId)!;
const request = (state = fixture(), id = dependencyId) =>
  apply(
    state,
    {
      type: "dependency.request",
      commandId,
      assignmentId,
      dependencyId: id,
      description: "Need separate capability",
      unblockCondition: { kind: "pull-request-merged", projectId, ref, expectedHeadSha: "head" },
      evidence,
    },
    lead,
  );
const approve = (state = request().state, id = dependencyId) =>
  apply(state, { type: "dependency.approve", commandId, dependencyId: id, work }, manager);
const wait = (state: FactorySnapshot, dependencyIds = [dependencyId]) =>
  apply(
    state,
    {
      type: "assignment.wait",
      commandId,
      assignmentId,
      wait: { kind: "dependency", dependencyIds, reason: "Independent work is exhausted" },
    },
    lead,
  );
const outstanding = (state = fixture(), triggerId = "incident") =>
  apply(
    state,
    {
      type: "assignment.reconciled",
      commandId,
      assignmentId,
      triggerId,
      observation: {
        kind: "outstanding",
        reason: "Authorized work remains",
        evidence,
        runId: RunId.make(triggerId),
        attemptId: RunAttemptId.make("attempt"),
      },
    },
    system,
  );
const begin = (state = outstanding().state) =>
  apply(
    state,
    { type: "assignment.recovery.begin", commandId, assignmentId, incidentId: "incident" },
    manager,
    { auxiliaryAllocation: { threadId: diagnosisId, modelSelection: selection } },
  );
const diagnosis = () => {
  let state = begin().state;
  state = apply(
    state,
    {
      type: "auxiliary.prepared",
      commandId,
      threadId: diagnosisId,
      qualification,
      sourceDigest: "current-bytes",
    },
    system,
  ).state;
  state = apply(
    state,
    {
      type: "auxiliary.started",
      commandId,
      threadId: diagnosisId,
      qualification,
      sourceDigest: "current-bytes",
    },
    system,
  ).state;
  return apply(
    state,
    {
      type: "auxiliary.report",
      commandId,
      threadId: diagnosisId,
      summary: "The failure has a scoped remedy",
      evidence,
    },
    { kind: "thread", threadId: diagnosisId },
  );
};

describe("Factory oversight", () => {
  it("persists routine progress without waking managers or completing work", () => {
    const result = apply(
      fixture(),
      {
        type: "assignment.progress",
        commandId,
        assignmentId,
        summary: "Finished the first check",
        remainingWork: "",
        evidence,
      },
      lead,
    );
    assert.deepStrictEqual(result.effects, []);
    assert.strictEqual(original(result.state).status, "running");
    assert.strictEqual(
      original(result.state).oversight?.progress?.summary,
      "Finished the first check",
    );
    assert.strictEqual(
      failure(
        result.state,
        {
          type: "assignment.progress",
          commandId,
          assignmentId,
          summary: "Fake lead",
          remainingWork: "",
          evidence,
        },
        manager,
      ),
      "permission-denied",
    );
  });

  it("notifies one dependency request while independent work and its grant remain unchanged", () => {
    const initial = fixture();
    const requested = request(initial);
    assert.strictEqual(requested.effects.length, 1);
    assert.strictEqual(original(requested.state).wait, null);
    assert.deepStrictEqual(original(requested.state).grant, original(initial).grant);
    assert.strictEqual(
      failure(
        requested.state,
        {
          type: "assignment.wait",
          commandId,
          assignmentId,
          wait: { kind: "dependency", dependencyIds: [dependencyId], reason: "Wait" },
        },
        lead,
      ),
      "invalid-state",
    );
    const approved = approve(requested.state);
    assert.strictEqual(approved.effects[0]?.type, "assignment.reconcile");
    assert.strictEqual(original(approved.state).wait, null);
  });

  it("commissions only the exact approved separate work without changing the original assignment", () => {
    const state = wait(approve().state).state;
    const command = {
      type: "assignment.commission",
      commandId,
      managerId,
      dependencyId,
      ...work,
    } as const;
    const allocation = {
      managerThreadId: managerId,
      leadThreadId: supportLeadId,
      assignmentId: supportId,
    };
    const expanded = decide({
      state,
      actor: manager,
      command: { ...command, scope: { ...work.scope, description: "Different work" } },
      now,
      allocation,
    });
    assert.isTrue(Result.isFailure(expanded));
    const result = Result.getOrThrow(decide({ state, actor: manager, command, now, allocation }));
    assert.strictEqual(result.state.dependencies[0]?.supportingAssignmentId, supportId);
    assert.strictEqual(result.state.dependencies[0]?.state, "commissioned");
    assert.deepStrictEqual(original(result.state), original(state));
    assert.strictEqual(result.effects[0]?.type, "assignment.prepare");
    assert.isTrue(
      Result.isFailure(
        decide({
          state: result.state,
          actor: manager,
          command,
          now,
          allocation: {
            ...allocation,
            assignmentId: FactoryAssignmentId.make("duplicate"),
            leadThreadId: ThreadId.make("duplicate"),
          },
        }),
      ),
    );
  });

  it("requires host-confirmed matching delivery and current lead evidence before unblocking", () => {
    const state = wait(approve().state).state;
    assert.strictEqual(
      failure(
        state,
        { type: "dependency.delivery.observed", commandId, dependencyId, delivery: delivered },
        lead,
      ),
      "permission-denied",
    );
    const wrong = apply(
      state,
      {
        type: "dependency.delivery.observed",
        commandId,
        dependencyId,
        delivery: { ...delivered, headSha: "wrong" },
      },
      system,
    );
    assert.deepStrictEqual(wrong.effects, []);
    assert.strictEqual(wrong.state.dependencies[0]?.state, "approved");
    const deliveredState = apply(
      state,
      { type: "dependency.delivery.observed", commandId, dependencyId, delivery: delivered },
      system,
    );
    assert.strictEqual(deliveredState.state.dependencies[0]?.state, "checking");
    assert.strictEqual(original(deliveredState.state).wait?.kind, "dependency");
    const effect = deliveredState.effects[0];
    assert.strictEqual(effect?.type, "thread.deliver");
    if (effect?.type === "thread.deliver")
      assert.strictEqual(effect.purpose?.kind, "dependency-usability");
    assert.strictEqual(
      failure(
        deliveredState.state,
        {
          type: "dependency.check-usability",
          commandId,
          dependencyId,
          deliveryId: "stale",
          usable: true,
          evidence,
        },
        lead,
      ),
      "invalid-state",
    );
    assert.strictEqual(
      failure(
        deliveredState.state,
        {
          type: "dependency.check-usability",
          commandId,
          dependencyId,
          deliveryId: "delivery",
          usable: true,
          evidence,
        },
        manager,
      ),
      "permission-denied",
    );
    const usable = apply(
      deliveredState.state,
      {
        type: "dependency.check-usability",
        commandId,
        dependencyId,
        deliveryId: "delivery",
        usable: true,
        evidence,
      },
      lead,
    );
    assert.strictEqual(original(usable.state).wait, null);
    assert.strictEqual(usable.effects.length, 1);
    assert.strictEqual(original(usable.state).oversight?.recovery.cyclesUsed, 0);
  });

  it("retains another dependency and treats unusable delivery as an expected wait", () => {
    let state = approve(
      request(approve().state, secondDependencyId).state,
      secondDependencyId,
    ).state;
    state = wait(state, [dependencyId, secondDependencyId]).state;
    state = apply(
      state,
      { type: "dependency.delivery.observed", commandId, dependencyId, delivery: delivered },
      system,
    ).state;
    const usable = apply(
      state,
      {
        type: "dependency.check-usability",
        commandId,
        dependencyId,
        deliveryId: "delivery",
        usable: true,
        evidence,
      },
      lead,
    );
    assert.strictEqual(usable.effects.length, 0);
    const pending = original(usable.state).wait;
    assert.strictEqual(pending?.kind, "dependency");
    if (pending?.kind === "dependency")
      assert.deepStrictEqual(pending.dependencyIds, [secondDependencyId]);
    state = apply(
      usable.state,
      {
        type: "dependency.delivery.observed",
        commandId,
        dependencyId: secondDependencyId,
        delivery: delivered,
      },
      system,
    ).state;
    const unusable = apply(
      state,
      {
        type: "dependency.check-usability",
        commandId,
        dependencyId: secondDependencyId,
        deliveryId: "delivery",
        usable: false,
        evidence,
      },
      lead,
    );
    assert.strictEqual(original(unusable.state).wait?.kind, "dependency");
    assert.strictEqual(unusable.effects.length, 1);
    const reconciled = outstanding(unusable.state);
    assert.strictEqual(reconciled.effects.length, 0);
    assert.strictEqual(original(reconciled.state).oversight?.recovery.cyclesUsed, 0);
  });

  it("requires real review proof and a human to resolve a decision without clearing unrelated waits", () => {
    const command = {
      type: "assignment.wait",
      commandId,
      assignmentId,
      wait: { kind: "review", ref, reason: "Awaiting PR review" },
    } as const;
    assert.strictEqual(failure(fixture(), command, lead), "permission-denied");
    const review = apply(fixture(), command, lead, { reviewVerified: true });
    assert.deepStrictEqual(outstanding(review.state).effects, []);
    assert.strictEqual(
      failure(review.state, { type: "assignment.wait.resolve", commandId, assignmentId }),
      "invalid-state",
    );
    const decision = apply(
      fixture(),
      {
        type: "assignment.wait",
        commandId,
        assignmentId,
        wait: { kind: "human-decision", reason: "Clarify scope" },
      },
      lead,
    );
    assert.strictEqual(
      failure(
        decision.state,
        { type: "assignment.wait.resolve", commandId, assignmentId },
        manager,
      ),
      "permission-denied",
    );
    const resolved = apply(decision.state, {
      type: "assignment.wait.resolve",
      commandId,
      assignmentId,
    });
    assert.strictEqual(original(resolved.state).wait, null);
    // The human's decision is not manager direction, so a manager pause does not hold it.
    const resume = resolved.effects.find((effect) => effect.type === "thread.deliver");
    assert.isTrue(resume?.type === "thread.deliver" && resume.sourceThreadId === undefined);
  });

  it("cannot overwrite dependency waits or silently drop one blocking dependency", () => {
    const state = wait(
      approve(request(approve().state, secondDependencyId).state, secondDependencyId).state,
      [dependencyId, secondDependencyId],
    ).state;
    assert.strictEqual(
      failure(
        state,
        {
          type: "assignment.wait",
          commandId,
          assignmentId,
          wait: { kind: "human-decision", reason: "Change the wait" },
        },
        lead,
      ),
      "invalid-state",
    );
    assert.strictEqual(
      failure(
        state,
        {
          type: "assignment.wait",
          commandId,
          assignmentId,
          wait: { kind: "dependency", dependencyIds: [dependencyId], reason: "Drop the other" },
        },
        lead,
      ),
      "invalid-state",
    );
  });

  it("reconciles pending explicit PR dependencies from project events without waking unrelated work", () => {
    const initial = approve().state;
    const state = {
      ...initial,
      assignments: [
        ...initial.assignments,
        { ...original(initial), id: supportId, threadId: supportLeadId },
      ],
    };
    const command = {
      type: "project.reconcile.requested",
      commandId,
      projectId,
      triggerId: "pr-event",
    } as const;
    assert.strictEqual(failure(state, command, manager), "permission-denied");
    const result = apply(state, command, system);
    assert.deepStrictEqual(result.effects, [
      { type: "assignment.reconcile", assignmentId, triggerId: "pr-event" },
    ]);
    assert.deepStrictEqual(
      apply(state, { ...command, projectId: ProjectId.make("foreign") }, system).effects,
      [],
    );
  });

  it("reconciles terminal runs once without treating a successful turn as delivery", () => {
    const command = {
      type: "assignment.run.observed",
      commandId,
      assignmentId,
      threadId: leadId,
      runId: RunId.make("run"),
      attemptId: RunAttemptId.make("attempt"),
      status: "completed",
    } as const;
    const observed = apply(fixture(), command, system);
    assert.strictEqual(original(observed.state).status, "running");
    assert.strictEqual(observed.effects[0]?.type, "assignment.reconcile");
    assert.deepStrictEqual(apply(observed.state, command, system).effects, []);
    const incident = outstanding(observed.state);
    assert.strictEqual(incident.effects.length, 1);
    assert.strictEqual(original(incident.state).status, "waiting");
    assert.deepStrictEqual(outstanding(incident.state).effects, []);
  });

  it("suppresses diagnosis for active work, project pause, takeover, cancellation and expected waits", () => {
    for (const kind of ["active", "expected-wait"] as const) {
      const observed = apply(
        fixture(),
        {
          type: "assignment.reconciled",
          commandId,
          assignmentId,
          triggerId: "incident",
          observation: { kind, reason: "Runtime requests or child work remains" },
        },
        system,
      );
      assert.deepStrictEqual(observed.effects, []);
    }
    const paused = apply(fixture(), { type: "project.pause", commandId, projectId });
    const cancelled = apply(fixture(), { type: "assignment.cancel", commandId, assignmentId });
    const takeover = Result.getOrThrow(
      decide({
        state: fixture(),
        actor: human,
        now,
        command: { type: "thread.takeover", commandId, threadId: leadId },
        controlTarget: {
          threadId: leadId,
          assignmentId,
          managerId,
          projectId,
          ancestorThreadIds: [],
        },
      }),
    );
    for (const state of [
      paused.state,
      cancelled.state,
      takeover.state,
      wait(approve().state).state,
    ]) {
      assert.deepStrictEqual(outstanding(state).effects, []);
      assert.strictEqual(original(state).oversight?.recovery.cyclesUsed, 0);
    }
  });

  it("spends a cycle once, requires independent approved diagnosis, and preserves it across JSON restart", () => {
    const state = outstanding().state;
    assert.strictEqual(
      failure(
        state,
        { type: "assignment.recovery.begin", commandId, assignmentId, incidentId: "incident" },
        lead,
        { auxiliaryAllocation: { threadId: diagnosisId, modelSelection: selection } },
      ),
      "permission-denied",
    );
    assert.strictEqual(
      failure(
        state,
        { type: "assignment.recovery.begin", commandId, assignmentId, incidentId: "incident" },
        manager,
        {
          auxiliaryAllocation: {
            threadId: diagnosisId,
            modelSelection: { ...selection, model: "unapproved" },
          },
        },
      ),
      "permission-denied",
    );
    const started = begin(state);
    assert.strictEqual(original(started.state).oversight?.recovery.cyclesUsed, 1);
    assert.strictEqual(started.state.auxiliaryThreads[0]?.status, "pending");
    assert.strictEqual(started.effects[0]?.type, "auxiliary.launch");
    const codec = Schema.fromJsonString(FactorySnapshot);
    const restored = Schema.decodeSync(codec)(Schema.encodeSync(codec)(started.state));
    assert.strictEqual(original(restored).oversight?.recovery.cyclesUsed, 1);
    assert.strictEqual(
      failure(
        restored,
        { type: "assignment.recovery.begin", commandId, assignmentId, incidentId: "incident" },
        manager,
      ),
      "invalid-state",
    );
    assert.strictEqual(
      failure(
        restored,
        {
          type: "assignment.recovery.replan",
          commandId,
          assignmentId,
          incidentId: "incident",
          plan: "Try again",
        },
        manager,
      ),
      "invalid-state",
    );
  });

  it("uses the lower current and pinned recovery allowance", () => {
    const state = outstanding().state;
    const lowered = apply(state, {
      type: "manager.configure",
      commandId,
      managerId,
      overrides: { recoveryCycles: 0 },
    }).state;
    assert.strictEqual(
      failure(
        lowered,
        { type: "assignment.recovery.begin", commandId, assignmentId, incidentId: "incident" },
        manager,
        { auxiliaryAllocation: { threadId: diagnosisId, modelSelection: selection } },
      ),
      "permission-denied",
    );
    const raised = apply(lowered, {
      type: "manager.configure",
      commandId,
      managerId,
      overrides: { recoveryCycles: 4 },
    }).state;
    assert.strictEqual(original(raised).grantedPolicy.recoveryCycles, 0);
    assert.strictEqual(
      failure(
        raised,
        { type: "assignment.recovery.begin", commandId, assignmentId, incidentId: "incident" },
        manager,
        { auxiliaryAllocation: { threadId: diagnosisId, modelSelection: selection } },
      ),
      "permission-denied",
    );
  });

  it("escalates a failed cycle with evidence, options and a recommendation without another launch", () => {
    const diagnosed = diagnosis();
    const continued = apply(
      diagnosed.state,
      {
        type: "assignment.recovery.replan",
        commandId,
        assignmentId,
        incidentId: "incident",
        plan: "Apply the scoped remedy",
      },
      manager,
    );
    const replan = continued.effects[0];
    // The manager's own plan waits while that manager is paused.
    assert.isTrue(replan?.type === "thread.deliver" && replan.sourceThreadId === managerId);
    const exhausted = outstanding(continued.state, "second-incident");
    const assignment = original(exhausted.state);
    assert.strictEqual(assignment.wait?.kind, "human-decision");
    assert.strictEqual(assignment.oversight?.recovery.cyclesUsed, 1);
    assert.strictEqual(assignment.oversight?.recovery.incident?.phase, "escalated");
    assert.deepStrictEqual(assignment.oversight?.recovery.incident?.escalation?.attempts, [
      "Apply the scoped remedy",
    ]);
    assert.isAbove(assignment.oversight?.recovery.incident?.escalation?.options.length ?? 0, 0);
    assert.isDefined(assignment.oversight?.recovery.incident?.escalation?.recommendation);
    assert.strictEqual(exhausted.effects.length, 1);
    const resolved = apply(exhausted.state, {
      type: "assignment.wait.resolve",
      commandId,
      assignmentId,
    });
    assert.strictEqual(original(resolved.state).oversight?.recovery.cyclesUsed, 1);
  });

  it("blocks ambiguous external outcomes without retrying an action or spending a cycle", () => {
    const result = apply(
      fixture(),
      {
        type: "assignment.reconciled",
        commandId,
        assignmentId,
        triggerId: "uncertain",
        observation: { kind: "ambiguous", reason: "The external receipt is unavailable", evidence },
      },
      system,
    );
    assert.strictEqual(original(result.state).wait?.kind, "human-decision");
    assert.strictEqual(original(result.state).oversight?.recovery.cyclesUsed, 0);
    assert.strictEqual(result.effects.length, 1);
    assert.strictEqual(result.effects[0]?.type, "thread.deliver");
  });

  it.each<NonNullable<FactoryAssignment["wait"]>>([
    { kind: "authority", reason: "The execution grant was revoked" },
    { kind: "execution-boundary", reason: "The execution boundary is unavailable" },
    { kind: "dependency", reason: "Upstream delivery is pending", dependencyIds: [dependencyId] },
    { kind: "review", reason: "The human is reviewing the PR", ref },
    { kind: "human-decision", reason: "An independent design decision is pending" },
    { kind: "delivered", reason: "Actual delivery is complete; retro remains" },
  ])("recovery escalation cannot replace a $kind prerequisite", (heldWait) => {
    const diagnosed = diagnosis().state;
    const state = {
      ...diagnosed,
      assignments: diagnosed.assignments.map((entry) => ({ ...entry, wait: heldWait })),
    };
    const command = {
      type: "assignment.recovery.escalate",
      commandId,
      assignmentId,
      incidentId: "incident",
      escalation: {
        failure: "The scoped remedy needs another decision",
        attempts: ["Independent diagnosis"],
        options: ["Review the diagnosis"],
        recommendation: "Keep the prerequisite until it is independently satisfied",
      },
    } as const;
    // A revoked grant refuses the manager before the wait is considered.
    assert.strictEqual(
      failure(state, command, manager),
      heldWait.kind === "authority" ? "permission-denied" : "invalid-state",
    );
    assert.strictEqual(failure(state, command, human), "invalid-state");
  });

  it("escalates active recovery without bypassing pauses or a human takeover", () => {
    const state = diagnosis().state;
    const command = {
      type: "assignment.recovery.escalate",
      commandId,
      assignmentId,
      incidentId: "incident",
      escalation: {
        failure: "The scoped remedy needs another decision",
        attempts: ["Independent diagnosis"],
        options: ["Review the diagnosis"],
        recommendation: "Choose whether separate supporting work is warranted",
      },
    } as const;
    const escalated = apply(state, command, manager);
    assert.strictEqual(original(escalated.state).wait?.kind, "human-decision");
    assert.strictEqual(original(escalated.state).oversight?.recovery.cyclesUsed, 1);
    assert.deepStrictEqual(original(escalated.state).grant, original(state).grant);
    const takeover = Result.getOrThrow(
      decide({
        state,
        actor: human,
        now,
        command: { type: "thread.takeover", commandId, threadId: leadId },
        controlTarget: {
          threadId: leadId,
          assignmentId,
          managerId,
          projectId,
          ancestorThreadIds: [],
        },
      }),
    );
    for (const held of [
      apply(state, { type: "manager.pause", commandId, managerId }).state,
      apply(state, { type: "project.pause", commandId, projectId }).state,
      takeover.state,
    ]) {
      assert.strictEqual(failure(held, command, manager), "permission-denied");
      assert.strictEqual(failure(held, command, human), "invalid-state");
    }
  });

  it("does not reinterpret a recovered run as a new incident when startup uses a different trigger", () => {
    const continued = apply(
      diagnosis().state,
      {
        type: "assignment.recovery.replan",
        commandId,
        assignmentId,
        incidentId: "incident",
        plan: "Apply remedy",
      },
      manager,
    );
    const replay = apply(
      continued.state,
      {
        type: "assignment.reconciled",
        commandId,
        assignmentId,
        triggerId: "startup:other-trigger",
        observation: {
          kind: "outstanding",
          reason: "Same terminal run after restart",
          evidence,
          runId: RunId.make("incident"),
          attemptId: RunAttemptId.make("attempt"),
        },
      },
      system,
    );
    assert.deepStrictEqual(replay.effects, []);
    assert.strictEqual(original(replay.state).oversight?.recovery.incident?.phase, "continuing");
    assert.strictEqual(original(replay.state).oversight?.recovery.cyclesUsed, 1);
  });

  it("persists diagnosis preparation before launch and prevents forged reports or profile swaps", () => {
    let state = begin().state;
    const prepared = {
      type: "auxiliary.prepared",
      commandId,
      threadId: diagnosisId,
      qualification,
      sourceDigest: "bytes",
    } as const;
    state = apply(state, prepared, system).state;
    assert.strictEqual(state.auxiliaryThreads[0]?.status, "pending");
    assert.strictEqual(
      failure(state, { ...prepared, sourceDigest: "changed" }, system),
      "invalid-state",
    );
    const report = {
      type: "auxiliary.report",
      commandId,
      threadId: diagnosisId,
      summary: "Report",
      evidence,
    } as const;
    assert.strictEqual(failure(state, report, manager), "permission-denied");
    const fastReport = apply(state, report, { kind: "thread", threadId: diagnosisId });
    assert.strictEqual(fastReport.state.auxiliaryThreads[0]?.status, "complete");
    const lateStarted = apply(
      fastReport.state,
      {
        ...prepared,
        type: "auxiliary.started",
      },
      system,
    );
    assert.strictEqual(lateStarted.state.auxiliaryThreads[0]?.status, "complete");
    assert.strictEqual(
      original(lateStarted.state).oversight?.recovery.incident?.phase,
      "replanning",
    );
    const failed = apply(
      state,
      {
        type: "auxiliary.failed",
        commandId,
        threadId: diagnosisId,
        reason: "Readonly view unavailable",
      },
      system,
    );
    assert.strictEqual(original(failed.state).wait?.kind, "human-decision");
    assert.strictEqual(original(failed.state).oversight?.recovery.cyclesUsed, 1);
  });

  it("replaces execution ownership only after host preparation while preserving grants and recovery history", () => {
    const before = diagnosis().state;
    const replacing = apply(
      before,
      {
        type: "assignment.recovery.replan",
        commandId,
        assignmentId,
        incidentId: "incident",
        plan: "Use a fresh lead with the diagnosis",
        replaceLead: true,
      },
      manager,
      { replacementAllocation: { threadId: replacementId, modelSelection: selection } },
    );
    assert.strictEqual(original(replacing.state).threadId, leadId);
    const receipt = {
      commandId,
      assignmentId,
      incidentId: "incident",
      threadId: replacementId,
      previousThreadId: leadId,
      qualification: { ...qualification, profileId: "replacement-profile" },
    };
    assert.strictEqual(
      failure(replacing.state, { ...receipt, type: "assignment.replacement.recorded" }, system),
      "invalid-state",
    );
    const prepared = apply(
      replacing.state,
      { ...receipt, type: "assignment.replacement.prepared" },
      system,
    );
    assert.strictEqual(original(prepared.state).threadId, replacementId);
    assert.deepStrictEqual(original(prepared.state).previousLeadThreadIds, [leadId]);
    assert.strictEqual(original(prepared.state).oversight?.recovery.incident?.phase, "replacing");
    assert.deepStrictEqual(original(prepared.state).grant, original(before).grant);
    assert.deepStrictEqual(original(prepared.state).modelPolicy, original(before).modelPolicy);
    assert.deepStrictEqual(original(prepared.state).scope, original(before).scope);
    assert.strictEqual(original(prepared.state).oversight?.recovery.cyclesUsed, 1);
    const repeated = apply(
      prepared.state,
      { ...receipt, type: "assignment.replacement.prepared" },
      system,
    );
    assert.deepStrictEqual(original(repeated.state).previousLeadThreadIds, [leadId]);
    const recorded = apply(
      repeated.state,
      { ...receipt, type: "assignment.replacement.recorded" },
      system,
    );
    assert.strictEqual(original(recorded.state).oversight?.recovery.incident?.phase, "continuing");
    assert.deepStrictEqual(recorded.effects, []);
    assert.deepStrictEqual(
      apply(recorded.state, { ...receipt, type: "assignment.replacement.recorded" }, system)
        .effects,
      [],
    );
  });

  it("records verified delivery and propagates matching dependencies without finalizing retros", () => {
    let state = approve().state;
    const support: FactoryAssignment = {
      ...original(state),
      id: supportId,
      threadId: supportLeadId,
      scope: work.scope,
      completion: {
        ...initialFactoryCompletion(work.scope),
        plan: {
          kind: "pull-requests",
          version: 1,
          sealed: true,
          requirements: [{ id: "required", ref, expectedHeadSha: null }],
        },
      },
      oversight: initialFactoryOversight(),
    };
    state = {
      ...state,
      assignments: [...state.assignments, support],
      dependencies: state.dependencies.map((entry) => ({
        ...entry,
        supportingAssignmentId: supportId,
        state: "commissioned",
      })),
    };
    state = apply(
      state,
      {
        type: "assignment.delivery.request",
        commandId,
        assignmentId: supportId,
        claim: { kind: "pull-request", ref },
      },
      { kind: "thread", threadId: supportLeadId },
    ).state;
    const recorded = apply(
      state,
      {
        type: "assignment.delivery.recorded",
        commandId,
        assignmentId: supportId,
        delivery: delivered,
      },
      system,
    );
    assert.strictEqual(recorded.state.dependencies[0]?.state, "checking");
    assert.strictEqual(recorded.effects.length, 1);
    const deliveredAssignment = recorded.state.assignments.find((entry) => entry.id === supportId)!;
    assert.strictEqual(deliveredAssignment.status, "waiting");
    assert.strictEqual(deliveredAssignment.wait?.kind, "delivered");
    assert.strictEqual(deliveredAssignment.oversight?.delivery?.id, "delivery");
    assert.deepStrictEqual(
      apply(
        recorded.state,
        {
          type: "assignment.delivery.recorded",
          commandId,
          assignmentId: supportId,
          delivery: delivered,
        },
        system,
      ).effects,
      [],
    );
  });

  it("requires an actual report receipt matching the claimed recipient and message", () => {
    let state = fixture();
    state = {
      ...state,
      assignments: state.assignments.map((entry) => ({
        ...entry,
        scope: {
          ...entry.scope!,
          requiresPullRequest: false,
          noPrTarget: { kind: "report-received", recipientThreadId: managerId },
        },
      })),
    };
    const messageId = MessageId.make("report-message");
    state = apply(
      state,
      {
        type: "assignment.delivery.request",
        commandId,
        assignmentId,
        claim: { kind: "report", recipientThreadId: managerId, messageId },
      },
      lead,
    ).state;
    const report: FactoryDeliveryEvidence = {
      kind: "report-delivered",
      id: "report",
      assignmentId,
      recipientThreadId: managerId,
      messageId,
      summary: "Investigation and recommendation",
      evidence,
      deliveredAt: now,
    };
    assert.strictEqual(
      failure(
        state,
        { type: "assignment.delivery.recorded", commandId, assignmentId, delivery: report },
        lead,
      ),
      "permission-denied",
    );
    assert.strictEqual(
      failure(
        state,
        {
          type: "assignment.delivery.recorded",
          commandId,
          assignmentId,
          delivery: { ...report, recipientThreadId: leadId },
        },
        system,
      ),
      "invalid-state",
    );
    assert.strictEqual(
      original(
        apply(
          state,
          { type: "assignment.delivery.recorded", commandId, assignmentId, delivery: report },
          system,
        ).state,
      ).wait?.kind,
      "delivered",
    );
  });
});
