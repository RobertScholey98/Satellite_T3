import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactorySourceId,
  MessageId,
  ProjectId,
  ThreadId,
  type FactoryBoundary,
  type FactoryDecisionCommand,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decide, type FactoryActor, type FactoryAllocation } from "./FactoryState.ts";
import {
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";
import {
  effectiveFactoryWorkflow,
  factoryExperimentSettings,
  type FactoryWorkflowContext,
} from "./FactoryWorkflow.ts";
import {
  factorySharedAssignmentOwned,
  factorySharedAssignmentEnabled,
} from "./FactoryWorkflowOwnership.ts";

const human = { kind: "human" } as const;
const host = { kind: "system" } as const;
const managerId = ThreadId.make("system-manager");
const manager = { kind: "thread", threadId: managerId } as const;
const projectId = ProjectId.make("skills-project");
let sequence = 0;
const commandId = () => CommandId.make(`workflow-${++sequence}`);
const allocation = (): FactoryAllocation => ({
  managerThreadId: managerId,
  leadThreadId: ThreadId.make(`shared-lead-${++sequence}`),
  assignmentId: FactoryAssignmentId.make(`shared-assignment-${sequence}`),
});
const apply = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = human,
  context: FactoryWorkflowContext & { allocation?: FactoryAllocation } = {},
) => Result.getOrThrow(decide({ state, command, actor, now: deliveryNow, ...context }));
const boundary: FactoryBoundary = {
  id: FactoryBoundaryId.make("shared-boundary"),
  projectId,
  sourceRevision: "a".repeat(40),
  workflow: { repositoryRoot: "C:/skills", revision: "b".repeat(40) },
  profileId: "shared-profile",
  approvedAt: deliveryNow,
  protectedPaths: ["skills/example/SKILL.md"],
  protectedCreatablePaths: ["skills/new/SKILL.md"],
  writablePaths: ["README.md"],
  creatableDirectories: [],
  skillRoots: ["skills"],
  gates: [],
  verification: "protected-integrity",
};
const work = {
  title: "Improve instructions",
  kind: "rule-change",
  complexity: "standard",
  sourcePaths: [],
  creatableDirectories: [],
  controlPaths: ["skills/example/SKILL.md", "skills/new/SKILL.md"],
  scope: {
    description: "Improve skill clarity",
    completionCondition: "Reviewed PR merged",
    requiresPullRequest: true,
  },
} as const;
const fixture = () => {
  const base = deliveryFixture();
  const state: FactorySnapshot = {
    ...base,
    managers: [
      ...base.managers,
      {
        id: managerId,
        threadId: managerId,
        role: "system",
        projectId: null,
        workspaceProjectId: projectId,
        name: "System",
        modelSelection: deliverySelection,
        workflow: boundary.workflow,
        qualification: { status: "qualified", profileId: "system-profile", checkedAt: deliveryNow },
        overrides: {},
        status: "active",
        threadStatus: "created",
        launchStatus: "delivered",
        wait: null,
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
    improvementInvestigations: [
      {
        id: "investigation",
        title: "Improve",
        findingIds: [],
        relatedInvestigationIds: [],
        uncertainty: "",
        assessment: "",
        lifecycle: { phase: "open" },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
    improvementProposals: [
      {
        id: "proposal",
        revision: "proposal-v1",
        investigationId: "investigation",
        content: {
          problem: "Repeated corrections",
          scope: { kind: "workflow", components: ["skills"] },
          exclusions: "Application code",
          expectedBenefit: "Fewer corrections",
          tradeoffs: "None known",
          uncertainty: "Untested",
          requestedDecision: "Implement",
          assessmentApproach: null,
        },
        phase: "decided",
        createdAt: deliveryNow,
        submittedAt: deliveryNow,
      },
    ],
    improvementDecisions: [
      {
        proposalId: "proposal",
        revision: "proposal-v1",
        outcome: "accepted",
        reason: "Proceed without tests",
        commandId: commandId(),
        decidedAt: deliveryNow,
      },
    ],
  };
  return apply(
    state,
    {
      type: "shared.repository.register",
      commandId: commandId(),
      projectId,
      kind: "skills",
      configuration: boundary,
    },
    human,
    { sharedRepository: { boundary, repositoryRoot: "C:/skills" } },
  ).state;
};
const propose = (state: FactorySnapshot) =>
  apply(
    state,
    {
      type: "shared.work.propose",
      commandId: commandId(),
      proposalId: "proposal",
      proposalRevision: "proposal-v1",
      repositoryId: state.sharedRepositories[0]!.id,
      work,
      expectedBenefit: "Fewer corrections",
      assessmentApproach: "Review later retros when available",
      changesSkills: true,
      weakensRules: false,
    },
    manager,
  );
const commission = () => {
  const proposed = propose(fixture());
  const authorized = apply(proposed.state, {
    type: "shared.work.authorize",
    commandId: commandId(),
    workId: proposed.result.workId!,
  });
  return apply(
    authorized.state,
    { type: "shared.work.commission", commandId: commandId(), workId: proposed.result.workId! },
    manager,
    { allocation: allocation() },
  );
};
const release = (state: FactorySnapshot, revision = "c".repeat(40)) =>
  apply(
    state,
    {
      type: "workflow.release.register",
      commandId: commandId(),
      repositoryId: state.sharedRepositories[0]!.id,
      revision,
      proposalId: "proposal",
      proposalRevision: "proposal-v1",
    },
    manager,
    {
      workflowRelease: {
        version: { repositoryRoot: "C:/skills", revision },
        snapshotDigest: `digest-${revision}`,
      },
    },
  );

describe("owned workflow authority", () => {
  it("requires exact separate human work authority and commissions the real system manager's team once", () => {
    const proposed = propose(fixture());
    const command = {
      type: "shared.work.commission",
      commandId: commandId(),
      workId: proposed.result.workId!,
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({
          state: proposed.state,
          command,
          actor: manager,
          now: deliveryNow,
          allocation: allocation(),
        }),
      ),
    );
    const authorized = apply(proposed.state, {
      type: "shared.work.authorize",
      commandId: commandId(),
      workId: command.workId,
    });
    const created = apply(authorized.state, command, manager, { allocation: allocation() });
    const assignment = created.state.assignments.at(-1)!;
    assert.equal(assignment.managerId, managerId);
    assert.equal(assignment.projectId, projectId);
    assert.equal(assignment.grantedPolicy.delivery, "human-approval");
    assert.deepEqual(assignment.grant?.controlChange?.paths, work.controlPaths);
    assert.isTrue(factorySharedAssignmentOwned(created.state, assignment));
    assert.equal(created.effects[0]?.type, "assignment.prepare");
    const extended = apply(
      { ...created.state, defaults: { ...created.state.defaults, delivery: "project-rule" } },
      { type: "assignments.extend-grant", commandId: commandId(), assignmentIds: [assignment.id] },
    );
    assert.equal(extended.state.assignments.at(-1)?.grantedPolicy.delivery, "human-approval");
    assert.isTrue(
      Result.isFailure(
        decide({
          state: created.state,
          command: { ...command, commandId: commandId() },
          actor: manager,
          now: deliveryNow,
          allocation: allocation(),
        }),
      ),
    );
  });

  it("adopts only for future assignments, preserves overrides and rejects manager rollout", () => {
    const original = fixture();
    const registered = release(original);
    const command = {
      type: "workflow.adopt",
      commandId: commandId(),
      releaseId: registered.result.releaseId!,
      scope: { kind: "default" },
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({ state: registered.state, command, actor: manager, now: deliveryNow }),
      ),
    );
    const adopted = apply(registered.state, command).state;
    assert.equal(effectiveFactoryWorkflow(adopted, adopted.managers[0]!).revision, "c".repeat(40));
    assert.deepEqual(adopted.assignments[0]?.workflow, original.assignments[0]?.workflow);
    const override = apply(adopted, {
      ...command,
      commandId: commandId(),
      scope: { kind: "managers", managerIds: [managerId] },
    }).state;
    const second = release(override, "d".repeat(40));
    const newer = apply(second.state, {
      ...command,
      commandId: commandId(),
      releaseId: second.result.releaseId!,
    }).state;
    assert.equal(effectiveFactoryWorkflow(newer, newer.managers.at(-1)!).revision, "c".repeat(40));
    const cleared = apply(newer, {
      type: "workflow.override.clear",
      commandId: commandId(),
      managerId,
    }).state;
    assert.equal(
      effectiveFactoryWorkflow(cleared, cleared.managers.at(-1)!).revision,
      "d".repeat(40),
    );
    const proposed = propose(cleared);
    const authorized = apply(proposed.state, {
      type: "shared.work.authorize",
      commandId: commandId(),
      workId: proposed.result.workId!,
    });
    const created = apply(
      authorized.state,
      { type: "shared.work.commission", commandId: commandId(), workId: proposed.result.workId! },
      manager,
      { allocation: allocation() },
    );
    assert.equal(created.state.assignments.at(-1)?.workflow.revision, "d".repeat(40));
    assert.deepEqual(created.state.assignments[0]?.workflow, original.assignments[0]?.workflow);
  });

  it("wakes the manager once authorized and preserves a late delivery acknowledgment after commissioning", () => {
    const proposed = propose(fixture());
    const authorized = apply(proposed.state, {
      type: "shared.work.authorize",
      commandId: commandId(),
      workId: proposed.result.workId!,
    });
    const workId = proposed.result.workId!;
    assert.deepEqual(authorized.effects, [{ type: "workflow.work.notify", workId, managerId }]);
    const failed = apply(
      authorized.state,
      {
        type: "workflow.work.notify.failed",
        commandId: commandId(),
        workId,
        managerId,
        reason: "Provider unavailable before send",
      },
      host,
    );
    assert.equal(failed.state.sharedWorks[0]?.notification?.phase, "failed");
    const retry = apply(failed.state, {
      type: "shared.work.notify.retry",
      commandId: commandId(),
      workId,
    });
    assert.deepEqual(retry.effects, authorized.effects);
    const created = apply(
      retry.state,
      { type: "shared.work.commission", commandId: commandId(), workId },
      manager,
      { allocation: allocation() },
    );
    assert.equal(created.state.sharedWorks[0]?.notification?.phase, "superseded");
    const acknowledged = apply(
      created.state,
      {
        type: "workflow.work.notified",
        commandId: commandId(),
        workId,
        managerId,
        messageId: MessageId.make("work-notification"),
      },
      host,
    );
    const lateFailure = apply(
      acknowledged.state,
      {
        type: "workflow.work.notify.failed",
        commandId: commandId(),
        workId,
        managerId,
        reason: "Lost old request",
      },
      host,
    );
    assert.equal(lateFailure.state.sharedWorks[0]?.notification?.phase, "delivered");
  });

  it("uses the adopted default for new onboarding while retaining setup fallback and exclusive shared ownership", () => {
    const registered = release(fixture());
    const adopted = apply(registered.state, {
      type: "workflow.adopt",
      commandId: commandId(),
      releaseId: registered.result.releaseId!,
      scope: { kind: "default" },
    }).state;
    const newManagerId = ThreadId.make("new-project-manager");
    const create = {
      type: "manager.create",
      commandId: commandId(),
      projectId: ProjectId.make("another-application"),
      modelSelection: deliverySelection,
      workflow: { repositoryRoot: "C:/legacy-skills", revision: "a".repeat(40) },
    } as const;
    const fresh = {
      managerThreadId: newManagerId,
      leadThreadId: ThreadId.make("new-onboarding"),
      assignmentId: FactoryAssignmentId.make("new-onboarding-assignment"),
    };
    const created = apply(adopted, create, human, { allocation: fresh });
    assert.deepEqual(created.state.managers.at(-1)?.workflow, create.workflow);
    assert.equal(created.state.assignments.at(-1)?.workflow.revision, "c".repeat(40));
    assert.isTrue(
      Result.isFailure(
        decide({
          state: adopted,
          command: { ...create, commandId: commandId(), projectId },
          actor: human,
          now: deliveryNow,
          allocation: fresh,
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state: adopted,
          command: { ...create, commandId: commandId() },
          actor: human,
          now: deliveryNow,
          allocation: fresh,
          projectRepositoryRoot: "C:/skills",
        }),
      ),
    );
  });

  it("cannot use protected skill creation authority for another path or an application repository", () => {
    const state = fixture();
    const unauthorized = {
      type: "shared.work.propose",
      commandId: commandId(),
      proposalId: "proposal",
      proposalRevision: "proposal-v1",
      repositoryId: state.sharedRepositories[0]!.id,
      work: { ...work, controlPaths: ["skills/unapproved/SKILL.md"] },
      expectedBenefit: "Improve",
      assessmentApproach: "Inspect later",
      changesSkills: false,
      weakensRules: false,
    } as const;
    assert.isTrue(
      Result.isFailure(decide({ state, command: unauthorized, actor: manager, now: deliveryNow })),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          command: {
            type: "shared.repository.register",
            commandId: commandId(),
            projectId: deliveryIds.project,
            kind: "skills",
            configuration: boundary,
          },
          actor: human,
          now: deliveryNow,
          sharedRepository: {
            boundary: {
              ...boundary,
              id: FactoryBoundaryId.make("other-boundary"),
              projectId: deliveryIds.project,
            },
            repositoryRoot: "C:/application",
          },
        }),
      ),
    );
    const valid = apply(state, { ...unauthorized, commandId: commandId(), work }, manager);
    assert.isTrue(valid.state.sharedWorks[0]!.plan.changesSkills);
  });

  it("keeps experiment allowance durable and revocation constrains existing work immediately", () => {
    const state = fixture();
    assert.deepEqual(factoryExperimentSettings(state), {
      enabled: false,
      maxConcurrent: 1,
      maxPerInvestigation: 1,
    });
    const experiment = {
      type: "experiment.commission",
      commandId: commandId(),
      repositoryId: state.sharedRepositories[0]!.id,
      investigationId: "investigation",
      work: {
        ...work,
        scope: {
          ...work.scope,
          requiresPullRequest: false,
          noPrTarget: { kind: "report-received", recipientThreadId: managerId },
        },
      },
      expectedBenefit: "Learn",
      assessmentApproach: "Inspect candidate",
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          command: experiment,
          actor: manager,
          now: deliveryNow,
          allocation: allocation(),
        }),
      ),
    );
    const enabled = apply(state, {
      type: "experiment.configure",
      commandId: commandId(),
      enabled: true,
      maxConcurrent: 1,
      maxPerInvestigation: 1,
    }).state;
    const created = apply(enabled, experiment, manager, { allocation: allocation() });
    const assignment = created.state.assignments.at(-1)!;
    const publication = decide({
      state: created.state,
      command: {
        type: "delivery.publish",
        commandId: commandId(),
        assignmentId: assignment.id,
        revisionId: "candidate",
        title: "Publish experiment",
        body: "Not authorized",
      },
      actor: human,
      now: deliveryNow,
    });
    assert.isTrue(Result.isFailure(publication));
    if (Result.isFailure(publication)) assert.equal(publication.failure.code, "permission-denied");
    const declared = apply(created.state, {
      type: "delivery.impact.declare",
      commandId: commandId(),
      assignmentId: assignment.id,
      impact: {
        classification: "none",
        changedFlows: false,
        journeys: "",
        navigation: "",
        layout: "",
        sharedComponents: "",
        summary: "Isolated skill experiment",
        evidence: [{ label: "Candidate skill", location: "skills/example/SKILL.md" }],
      },
    });
    assert.equal(declared.state.assignments.at(-1)?.delivery?.impact?.classification, "none");
    const disabled = apply(created.state, {
      type: "experiment.configure",
      commandId: commandId(),
      enabled: false,
      maxConcurrent: 1,
      maxPerInvestigation: 1,
    });
    assert.isTrue(factorySharedAssignmentOwned(disabled.state, assignment));
    assert.isFalse(factorySharedAssignmentEnabled(disabled.state, assignment));
    assert.equal(disabled.state.assignments.at(-1)?.grant?.epoch, assignment.grant!.epoch + 1);
    assert.equal(disabled.effects[0]?.type, "workflow.revoke");
    const reenabled = apply(disabled.state, {
      type: "experiment.configure",
      commandId: commandId(),
      enabled: true,
      maxConcurrent: 1,
      maxPerInvestigation: 1,
    }).state;
    assert.equal(reenabled.assignments.at(-1)?.wait?.kind, "authority");
    assert.isTrue(
      Result.isFailure(
        decide({
          state: reenabled,
          command: { ...experiment, commandId: commandId() },
          actor: manager,
          now: deliveryNow,
          allocation: allocation(),
        }),
      ),
    );
  });

  it("restarts only the selected assignment with a fresh epoch and durable resume receipt", () => {
    const registered = release(fixture());
    const old = registered.state.assignments[0]!;
    const restarted = apply(registered.state, {
      type: "workflow.restart",
      commandId: commandId(),
      releaseId: registered.result.releaseId!,
      assignmentIds: [old.id],
      kind: "trial",
      reason: "Try selected workflow",
    });
    const migrationId = restarted.result.migrationIds![0]!;
    assert.equal(restarted.state.workflowMigrations[0]?.lifecycle.phase, "stopping");
    assert.deepEqual(restarted.state.assignments[0]?.workflow, old.workflow);
    const stopped = apply(
      restarted.state,
      {
        type: "workflow.restart.stopped",
        commandId: commandId(),
        migrationId,
        expectedStateRevision: restarted.state.revision,
        startingSource: {
          ...old.startingSource!,
          id: FactorySourceId.make("captured-migration-source"),
          origin: "handover",
          threadId: old.threadId,
        },
      },
      host,
    );
    assert.equal(stopped.state.assignments[0]?.grant?.epoch, old.grant!.epoch + 1);
    assert.equal(stopped.state.assignments[0]?.workflow.revision, "c".repeat(40));
    assert.equal(stopped.state.assignments[0]?.threadId, old.threadId);
    assert.deepEqual(stopped.state.assignments[0]?.oversight, old.oversight);
    const prepared = apply(
      stopped.state,
      {
        type: "workflow.restart.prepared",
        commandId: commandId(),
        migrationId,
        expectedStateRevision: stopped.state.revision,
        qualification: { status: "qualified", profileId: "fresh-profile", checkedAt: deliveryNow },
      },
      host,
    );
    assert.equal(prepared.effects[0]?.type, "workflow.restart.resume");
    const resumed = apply(
      prepared.state,
      {
        type: "workflow.restart.resumed",
        commandId: commandId(),
        migrationId,
        profileId: "fresh-profile",
      },
      host,
    );
    assert.deepEqual(resumed.state.workflowMigrations[0]?.lifecycle, {
      phase: "ready",
      completedAt: deliveryNow,
      resume: { phase: "delivered", deliveredAt: deliveryNow },
    });
  });

  it("preserves a human decision wait through restart failure and retry", () => {
    const registered = release(fixture());
    const state: FactorySnapshot = {
      ...registered.state,
      assignments: registered.state.assignments.map((entry) => ({
        ...entry,
        status: "waiting",
        wait: { kind: "human-decision", reason: "Review the existing PR" },
      })),
    };
    const assignment = state.assignments[0]!;
    const started = apply(state, {
      type: "workflow.restart",
      commandId: commandId(),
      releaseId: registered.result.releaseId!,
      assignmentIds: [assignment.id],
      kind: "migration",
      reason: "Use approved instructions",
    });
    const migrationId = started.result.migrationIds![0]!;
    const failed = apply(
      started.state,
      {
        type: "workflow.restart.failed",
        commandId: commandId(),
        migrationId,
        step: "stop",
        reason: "Container unavailable",
      },
      host,
    );
    const retried = apply(failed.state, {
      type: "workflow.restart.retry",
      commandId: commandId(),
      migrationId,
    });
    assert.equal(retried.effects[0]?.type, "workflow.restart.stop");
    const stopped = apply(
      retried.state,
      {
        type: "workflow.restart.stopped",
        commandId: commandId(),
        migrationId,
        expectedStateRevision: retried.state.revision,
        startingSource: {
          ...assignment.startingSource!,
          id: FactorySourceId.make("restart-wait-source"),
          origin: "handover",
          threadId: assignment.threadId,
        },
      },
      host,
    );
    const prepared = apply(
      stopped.state,
      {
        type: "workflow.restart.prepared",
        commandId: commandId(),
        migrationId,
        expectedStateRevision: stopped.state.revision,
        qualification: {
          status: "qualified",
          profileId: "waiting-profile",
          checkedAt: deliveryNow,
        },
      },
      host,
    );
    assert.equal(prepared.state.assignments[0]?.status, "waiting");
    assert.deepEqual(prepared.state.assignments[0]?.wait, assignment.wait);
    assert.deepEqual(prepared.state.assignments[0]?.delivery, assignment.delivery);
    assert.deepEqual(prepared.state.assignments[0]?.oversight, assignment.oversight);
  });

  it("keeps tightened grants and the authority wait when revocation races stop and preparation", () => {
    const registered = release(fixture());
    const old = registered.state.assignments[0]!;
    const started = apply(registered.state, {
      type: "workflow.restart",
      commandId: commandId(),
      releaseId: registered.result.releaseId!,
      assignmentIds: [old.id],
      kind: "migration",
      reason: "Migrate",
    });
    const migrationId = started.result.migrationIds![0]!;
    const tightened: FactorySnapshot = {
      ...started.state,
      revision: started.state.revision + 1,
      assignments: started.state.assignments.map((entry) => ({
        ...entry,
        grant: { ...entry.grant!, epoch: 5, sourcePaths: [] },
        wait: { kind: "authority", reason: "Source permission removed" },
      })),
    };
    const stoppedCommand = {
      type: "workflow.restart.stopped",
      commandId: commandId(),
      migrationId,
      expectedStateRevision: started.state.revision,
      startingSource: {
        ...old.startingSource!,
        id: FactorySourceId.make("revocation-source"),
        origin: "handover",
        threadId: old.threadId,
      },
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({ state: tightened, command: stoppedCommand, actor: host, now: deliveryNow }),
      ),
    );
    const stopped = apply(
      tightened,
      { ...stoppedCommand, commandId: commandId(), expectedStateRevision: tightened.revision },
      host,
    );
    assert.equal(stopped.state.workflowMigrations[0]?.previousEpoch, old.grant!.epoch);
    assert.equal(stopped.state.workflowMigrations[0]?.preparedEpoch, 6);
    assert.deepEqual(stopped.state.assignments[0]?.grant?.sourcePaths, []);
    const retightened: FactorySnapshot = {
      ...stopped.state,
      revision: stopped.state.revision + 1,
      assignments: stopped.state.assignments.map((entry) => ({
        ...entry,
        grant: { ...entry.grant!, epoch: 7 },
        wait: { kind: "authority", reason: "Additional authority withdrawn" },
      })),
    };
    const stalePrepare = {
      type: "workflow.restart.prepared",
      commandId: commandId(),
      migrationId,
      expectedStateRevision: retightened.revision,
      qualification: { status: "qualified", profileId: "stale-profile", checkedAt: deliveryNow },
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({ state: retightened, command: stalePrepare, actor: host, now: deliveryNow }),
      ),
    );
    const failed = apply(
      retightened,
      {
        type: "workflow.restart.failed",
        commandId: commandId(),
        migrationId,
        step: "prepare",
        reason: "Grant changed",
      },
      host,
    );
    const retried = apply(failed.state, {
      type: "workflow.restart.retry",
      commandId: commandId(),
      migrationId,
    });
    assert.equal(retried.state.workflowMigrations[0]?.preparedEpoch, 8);
    assert.deepEqual(retried.state.assignments[0]?.grant?.sourcePaths, []);
    const prepared = apply(
      retried.state,
      {
        ...stalePrepare,
        commandId: commandId(),
        expectedStateRevision: retried.state.revision,
        qualification: { ...stalePrepare.qualification, profileId: "current-profile" },
      },
      host,
    );
    assert.deepEqual(prepared.state.assignments[0]?.wait, {
      kind: "authority",
      reason: "Additional authority withdrawn",
    });
    assert.equal(prepared.state.assignments[0]?.grant?.epoch, 8);
    const continueCommand = {
      type: "workflow.restart.continue",
      commandId: commandId(),
      migrationId,
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({
          state: prepared.state,
          command: continueCommand,
          actor: manager,
          now: deliveryNow,
        }),
      ),
    );
    const continued = apply(prepared.state, continueCommand);
    assert.equal(continued.state.assignments[0]?.wait, null);
    assert.deepEqual(continued.state.assignments[0]?.grant, prepared.state.assignments[0]?.grant);
    assert.equal(continued.effects[0]?.type, "workflow.restart.resume");
    const changedAgain: FactorySnapshot = {
      ...prepared.state,
      assignments: prepared.state.assignments.map((entry) => ({
        ...entry,
        grant: { ...entry.grant!, epoch: 9 },
      })),
    };
    assert.isTrue(
      Result.isFailure(
        decide({
          state: changedAgain,
          command: { ...continueCommand, commandId: commandId() },
          actor: human,
          now: deliveryNow,
        }),
      ),
    );
    const reprepare = apply(changedAgain, {
      type: "workflow.restart.retry",
      commandId: commandId(),
      migrationId,
    });
    assert.equal(reprepare.effects[0]?.type, "workflow.restart.prepare");
    assert.equal(reprepare.state.assignments[0]?.grant?.epoch, 10);
    assert.deepEqual(reprepare.state.assignments[0]?.grant?.sourcePaths, []);
  });

  it("keeps standing model recommendations scoped and requires exact human application", () => {
    const state = fixture();
    const target = {
      kind: "default",
      policy: { approvedModels: [deliverySelection], preferences: [] },
    } as const;
    const recommended = apply(
      state,
      {
        type: "workflow.models.recommend",
        commandId: commandId(),
        proposalId: "proposal",
        proposalRevision: "proposal-v1",
        target,
        rationale: "Observed routing quality",
      },
      manager,
    );
    assert.equal(recommended.state.modelDefaults, undefined);
    const command = {
      type: "workflow.models.apply",
      commandId: commandId(),
      recommendationId: recommended.result.recommendationId!,
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({ state: recommended.state, command, actor: manager, now: deliveryNow }),
      ),
    );
    const applied = apply(recommended.state, command);
    assert.deepEqual(applied.state.modelDefaults, target.policy);
    assert.isNotNull(applied.state.modelRecommendations[0]?.applied);
    const local: FactorySnapshot = {
      ...state,
      improvementProposals: state.improvementProposals.map((entry) => ({
        ...entry,
        content: {
          ...entry.content,
          scope: { kind: "projects", projectIds: [deliveryIds.project] },
        },
      })),
    };
    assert.isTrue(
      Result.isFailure(
        decide({
          state: local,
          command: {
            type: "workflow.models.recommend",
            commandId: commandId(),
            proposalId: "proposal",
            proposalRevision: "proposal-v1",
            target,
            rationale: "A local convention",
          },
          actor: manager,
          now: deliveryNow,
        }),
      ),
    );
  });

  it("records post-implementation uncertainty without reopening delivery or requiring tests", () => {
    const created = commission();
    const assignment = created.state.assignments.at(-1)!;
    const state = {
      ...created.state,
      assignments: created.state.assignments.map((entry) =>
        entry.id === assignment.id ? { ...entry, status: "complete" as const } : entry,
      ),
    };
    const assessed = apply(
      state,
      {
        type: "improvement.validation.record",
        commandId: commandId(),
        proposalId: "proposal",
        proposalRevision: "proposal-v1",
        assignmentId: assignment.id,
        outcome: "insufficient-evidence",
        evidence: [],
        assessment: "No subsequent deliveries yet",
        recommendedNextStep: "Review later retros",
      },
      manager,
    );
    assert.equal(assessed.state.assignments.at(-1)?.status, "complete");
    assert.equal(assessed.state.improvementValidations[0]?.outcome, "insufficient-evidence");
    assert.deepEqual(assessed.effects, []);
  });
});
