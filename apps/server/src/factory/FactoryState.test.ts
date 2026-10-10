import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryDispatchInput,
  FactoryEffectIntent,
  FactorySnapshot,
  type FactoryCommand,
  type FactoryDecisionCommand,
  type FactoryOnboardingReport,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  decide,
  effectivePolicy,
  initialFactorySnapshot,
  type FactoryActor,
  type FactoryDecision,
} from "./FactoryState.ts";

const now = "2026-10-10T12:00:00.000Z";
const projectId = ProjectId.make("project-web");
const managerId = ThreadId.make("thread-manager-web");
const leadThreadId = ThreadId.make("thread-onboarding-web");
const assignmentId = FactoryAssignmentId.make("assignment-onboarding-web");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "approved-model",
};
const workflow = { repositoryRoot: "C:/owned-skills", revision: "approved-commit" };
const allocation = { managerThreadId: managerId, leadThreadId, assignmentId };
const qualified = {
  status: "qualified",
  profileId: "discovery-read-only",
  checkedAt: now,
} as const;
const human = { kind: "human" } as const;
const system = { kind: "system" } as const;
const decodeDispatch = Schema.decodeUnknownResult(FactoryDispatchInput);
const snapshotJsonSchema = Schema.fromJsonString(FactorySnapshot);
const encodeSnapshot = Schema.encodeSync(snapshotJsonSchema);
const decodeSnapshot = Schema.decodeUnknownSync(snapshotJsonSchema);
const effectsJsonSchema = Schema.fromJsonString(Schema.Array(FactoryEffectIntent));
const encodeEffects = Schema.encodeSync(effectsJsonSchema);
const decodeEffects = Schema.decodeUnknownSync(effectsJsonSchema);

const createCommand = (
  overrides: Partial<Extract<FactoryCommand, { type: "manager.create" }>> = {},
) => ({
  type: "manager.create" as const,
  commandId: CommandId.make("create-web-manager"),
  projectId,
  name: "Web engineering manager",
  modelSelection,
  workflow,
  ...overrides,
});

const created = (qualification = qualified) =>
  Result.getOrThrow(
    decide({
      state: initialFactorySnapshot(),
      actor: human,
      command: createCommand(),
      allocation,
      qualification,
      now,
    }),
  );

const apply = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = human,
) => Result.getOrThrow(decide({ state, actor, command, now }));

const failureCode = (result: ReturnType<typeof decide>) => {
  if (Result.isSuccess(result)) return assert.fail("Expected the factory command to be rejected.");
  return result.failure.code;
};

const report: FactoryOnboardingReport = {
  summary: "Existing checks and project decisions are recorded.",
  instructions: [
    {
      description: "Project coding instructions.",
      evidence: [{ label: "Instructions", location: "AGENTS.md" }],
    },
  ],
  checks: [
    {
      description: "Focused backend checks.",
      evidence: [{ label: "Scripts", location: "package.json" }],
    },
  ],
  tracker: {
    description: "The Ready column authorizes delivery.",
    evidence: [{ label: "Board", location: "https://example.test/board" }],
  },
  verificationTools: [],
  protectedControls: [
    {
      description: "Required lint rules.",
      evidence: [{ label: "Lint rules", location: "lint.config.ts" }],
    },
  ],
  unresolvedDecisions: [],
};

function started(): FactoryDecision {
  const first = created();
  const manager = apply(
    first.state,
    {
      type: "thread.launch.recorded",
      commandId: CommandId.make("manager-created"),
      threadId: managerId,
    },
    system,
  );
  return apply(
    manager.state,
    {
      type: "thread.launch.recorded",
      commandId: CommandId.make("lead-created"),
      threadId: leadThreadId,
    },
    system,
  );
}

describe("factory onboarding decisions", () => {
  it("records manager ownership and a navigable ordinary lead identity before qualified launch", () => {
    const decision = created();
    assert.deepEqual(decision.result, { revision: 1, managerId, assignmentId });
    assert.deepEqual(
      decision.state.managers.map((manager) => ({
        id: manager.id,
        projectId: manager.projectId,
        role: manager.role,
        status: manager.status,
        threadStatus: manager.threadStatus,
      })),
      [
        {
          id: ThreadId.make("thread-manager-web"),
          projectId: ProjectId.make("project-web"),
          role: "project",
          status: "onboarding",
          threadStatus: "pending",
        },
      ],
    );
    assert.deepEqual(
      decision.state.assignments.map((assignment) => ({
        id: assignment.id,
        managerId: assignment.managerId,
        threadId: assignment.threadId,
        status: assignment.status,
      })),
      [
        {
          id: "assignment-onboarding-web",
          managerId: "thread-manager-web",
          threadId: "thread-onboarding-web",
          status: "pending",
        },
      ],
    );
    assert.deepEqual(
      decision.effects
        .filter((effect) => effect.type === "thread.launch")
        .map((effect) => ({
          type: effect.type,
          purpose: effect.purpose,
          threadId: effect.threadId,
          profileId: effect.profileId,
        })),
      [
        {
          type: "thread.launch",
          purpose: "manager",
          threadId: "thread-manager-web",
          profileId: "discovery-read-only",
        },
        {
          type: "thread.launch",
          purpose: "onboarding",
          threadId: "thread-onboarding-web",
          profileId: "discovery-read-only",
        },
      ],
    );
  });

  it("preserves an actionable wait and starts nothing when discovery is not qualified", () => {
    const decision = Result.getOrThrow(
      decide({
        state: initialFactorySnapshot(),
        actor: human,
        command: createCommand(),
        allocation,
        now,
        qualification: {
          status: "unavailable",
          reason: "Install the restricted discovery runtime.",
        },
      }),
    );
    assert.deepEqual(decision.state.managers[0]?.wait, {
      kind: "execution-boundary",
      reason: "Install the restricted discovery runtime.",
    });
    assert.equal(decision.state.managers[0]?.status, "blocked");
    assert.equal(decision.state.assignments[0]?.status, "waiting");
    assert.deepEqual(decision.effects, []);
    assert.equal(
      failureCode(
        decide({
          state: decision.state,
          actor: system,
          now,
          command: {
            type: "thread.launch.recorded",
            commandId: CommandId.make("unqualified-ack"),
            threadId: managerId,
          },
        }),
      ),
      "execution-unavailable",
    );
  });

  it("fails closed when the environment supplies no qualification", () => {
    const decision = Result.getOrThrow(
      decide({
        state: initialFactorySnapshot(),
        actor: human,
        command: createCommand(),
        allocation,
        now,
      }),
    );
    assert.equal(decision.state.assignments[0]?.qualification.status, "unavailable");
    assert.equal(decision.state.managers[0]?.status, "blocked");
    assert.deepEqual(decision.effects, []);
  });

  it("rejects a second manager for a project and reusing an assigned thread identity", () => {
    const state = created().state;
    assert.equal(
      failureCode(
        decide({
          state,
          actor: human,
          command: createCommand({
            commandId: CommandId.make("another-manager"),
          }),
          allocation,
          qualification: qualified,
          now,
        }),
      ),
      "project-already-managed",
    );
    assert.equal(
      failureCode(
        decide({
          state,
          actor: human,
          command: createCommand({
            projectId: ProjectId.make("project-api"),
            commandId: CommandId.make("api-manager"),
          }),
          allocation: {
            ...allocation,
            managerThreadId: leadThreadId,
            leadThreadId: ThreadId.make("new-lead"),
          },
          qualification: qualified,
          now,
        }),
      ),
      "invalid-state",
    );
  });

  it("lets only the human create and configure managers", () => {
    const state = created().state;
    const actor = { kind: "thread", threadId: managerId } as const;
    assert.equal(
      failureCode(
        decide({
          state: initialFactorySnapshot(),
          actor,
          command: createCommand(),
          allocation,
          qualification: qualified,
          now,
        }),
      ),
      "permission-denied",
    );
    assert.equal(
      failureCode(
        decide({
          state,
          actor,
          now,
          command: {
            type: "manager.configure",
            commandId: CommandId.make("self-promote"),
            managerId,
            overrides: { authorizeRuleWeakening: true },
          },
        }),
      ),
      "permission-denied",
    );
  });

  it("retries qualification with the original manager, lead, and assignment identities", () => {
    const blocked = Result.getOrThrow(
      decide({
        state: initialFactorySnapshot(),
        actor: human,
        command: createCommand(),
        allocation,
        now,
      }),
    );
    const retried = Result.getOrThrow(
      decide({
        state: blocked.state,
        actor: human,
        now,
        qualification: qualified,
        command: {
          type: "manager.retry-onboarding",
          commandId: CommandId.make("retry"),
          managerId,
        },
      }),
    );
    assert.equal(retried.state.managers.length, 1);
    assert.equal(retried.state.assignments.length, 1);
    assert.deepEqual(
      retried.effects.map((effect) => ("threadId" in effect ? effect.threadId : undefined)),
      [ThreadId.make("thread-manager-web"), ThreadId.make("thread-onboarding-web")],
    );
    assert.equal(retried.state.assignments[0]?.id, "assignment-onboarding-web");
    assert.equal(retried.state.managers[0]?.status, "onboarding");
  });

  it("retains inherited settings and freezes the onboarding grant when a manager gains authority", () => {
    const first = created();
    const configured = apply(first.state, {
      type: "manager.configure",
      commandId: CommandId.make("configure"),
      managerId,
      overrides: { delivery: "project-rule", recoveryCycles: 3 },
    });
    const manager = configured.state.managers[0];
    assert.isDefined(manager);
    if (manager === undefined) return;
    assert.deepEqual(effectivePolicy(configured.state, manager), {
      delivery: "project-rule",
      projectImprovements: "create-tickets",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: false,
      recoveryCycles: 3,
    });
    assert.equal(configured.state.assignments[0]?.grantedPolicy.delivery, "human-approval");
    const reset = apply(configured.state, {
      type: "manager.configure",
      commandId: CommandId.make("reset"),
      managerId,
      overrides: {},
    });
    const resetManager = reset.state.managers[0];
    assert.isDefined(resetManager);
    if (resetManager === undefined) return;
    assert.equal(effectivePolicy(reset.state, resetManager).delivery, "human-approval");
  });

  it("accepts the lead's report without treating discovery as delivery authorization", () => {
    const first = started();
    const decision = apply(
      first.state,
      {
        type: "onboarding.report",
        commandId: CommandId.make("report"),
        assignmentId,
        report,
      },
      { kind: "thread", threadId: leadThreadId },
    );
    assert.equal(decision.state.assignments[0]?.status, "complete");
    assert.equal(
      decision.state.assignments[0]?.report?.checks[0]?.evidence[0]?.location,
      "package.json",
    );
    assert.equal(decision.state.managers[0]?.status, "blocked");
    assert.equal(decision.state.managers[0]?.wait?.kind, "execution-boundary");
    assert.deepEqual(decision.effects, []);
  });

  it("rejects another team's report and surfaces the authorized lead's unresolved decisions", () => {
    const first = started();
    const command = {
      type: "onboarding.report" as const,
      commandId: CommandId.make("report"),
      assignmentId,
      report: {
        ...report,
        unresolvedDecisions: [{ description: "Choose the project Ready column.", evidence: [] }],
      },
    };
    assert.equal(
      failureCode(
        decide({
          state: first.state,
          actor: { kind: "thread", threadId: managerId },
          command,
          now,
        }),
      ),
      "permission-denied",
    );
    const decision = apply(first.state, command, { kind: "thread", threadId: leadThreadId });
    assert.equal(decision.state.managers[0]?.wait?.kind, "human-decision");
    assert.equal(
      decision.state.assignments[0]?.report?.unresolvedDecisions[0]?.description,
      "Choose the project Ready column.",
    );
  });

  it("keeps completed discovery intact when a launch acknowledgement is delivered again", () => {
    const first = apply(
      started().state,
      {
        type: "onboarding.report",
        commandId: CommandId.make("report"),
        assignmentId,
        report,
      },
      { kind: "thread", threadId: leadThreadId },
    );
    const repeated = apply(
      first.state,
      {
        type: "thread.launch.recorded",
        commandId: CommandId.make("late-ack"),
        threadId: leadThreadId,
      },
      system,
    );
    assert.equal(repeated.state.assignments[0]?.status, "complete");
    assert.equal(
      repeated.state.assignments[0]?.report?.summary,
      "Existing checks and project decisions are recorded.",
    );
  });

  it("records launch failure for retry without losing the planned thread", () => {
    const first = created();
    const failed = apply(
      first.state,
      {
        type: "thread.launch.failed",
        commandId: CommandId.make("launch-failure"),
        threadId: leadThreadId,
        reason: "The configured provider is unavailable.",
      },
      system,
    );
    assert.equal(failed.state.managers[0]?.status, "blocked");
    assert.equal(failed.state.assignments[0]?.threadId, "thread-onboarding-web");
    assert.equal(
      failed.state.assignments[0]?.wait?.reason,
      "The configured provider is unavailable.",
    );
  });

  it("repairs a blocked setup before any thread launches and keeps the assigned identities", () => {
    const first = Result.getOrThrow(
      decide({
        state: initialFactorySnapshot(),
        actor: human,
        command: createCommand(),
        allocation,
        now,
        qualification: { status: "unavailable", reason: "Pin a committed workflow revision." },
      }),
    );
    const repairedWorkflow = { repositoryRoot: "C:/owned-skills", revision: "a".repeat(40) };
    const repaired = Result.getOrThrow(
      decide({
        state: first.state,
        actor: human,
        now,
        qualification: qualified,
        command: {
          type: "manager.retry-onboarding",
          commandId: CommandId.make("repair"),
          managerId,
          workflow: repairedWorkflow,
          modelSelection: { ...modelSelection, model: "other-approved-model" },
        },
      }),
    );
    assert.equal(repaired.state.managers[0]!.workflow.revision, repairedWorkflow.revision);
    assert.equal(repaired.state.assignments[0]!.workflow.revision, repairedWorkflow.revision);
    assert.equal(repaired.state.assignments[0]!.threadId, leadThreadId);
    assert.equal(
      repaired.effects.find((effect) => effect.type === "thread.launch")?.modelSelection.model,
      "other-approved-model",
    );
    const managerStarted = apply(
      repaired.state,
      {
        type: "thread.launch.recorded",
        commandId: CommandId.make("manager-started"),
        threadId: managerId,
      },
      system,
    );
    const failedLead = apply(
      managerStarted.state,
      {
        type: "thread.launch.failed",
        commandId: CommandId.make("lead-failed"),
        threadId: leadThreadId,
        reason: "Provider unavailable.",
      },
      system,
    );
    assert.equal(
      failureCode(
        decide({
          state: failedLead.state,
          actor: human,
          now,
          qualification: qualified,
          command: {
            type: "manager.retry-onboarding",
            commandId: CommandId.make("replace-running-policy"),
            managerId,
            workflow: repairedWorkflow,
          },
        }),
      ),
      "invalid-state",
    );
  });

  it("keeps host acknowledgements outside the client command schema", () => {
    assert.isTrue(Result.isSuccess(decodeDispatch({ command: createCommand() })));
    assert.isTrue(
      Result.isFailure(
        decodeDispatch({
          command: {
            type: "thread.launch.recorded",
            commandId: "forged-ack",
            threadId: leadThreadId,
          },
        }),
      ),
    );
    assert.equal(
      failureCode(
        decide({
          state: created().state,
          actor: human,
          now,
          command: {
            type: "thread.launch.recorded",
            commandId: CommandId.make("human-ack"),
            threadId: leadThreadId,
          },
        }),
      ),
      "permission-denied",
    );
  });

  it("round-trips the created state and launch intents through persistence schemas", () => {
    const decision = created();
    const snapshotJson = encodeSnapshot(decision.state);
    const restored = decodeSnapshot(snapshotJson);
    assert.equal(restored.assignments[0]?.managerId, "thread-manager-web");
    assert.equal(restored.managers[0]?.modelSelection.instanceId, "codex");
    const effectJson = encodeEffects(decision.effects);
    const effects = decodeEffects(effectJson);
    assert.deepEqual(
      effects.map((effect) => ("threadId" in effect ? effect.threadId : undefined)),
      [ThreadId.make("thread-manager-web"), ThreadId.make("thread-onboarding-web")],
    );
  });
});
