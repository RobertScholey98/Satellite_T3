import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
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
import { factoryExperimentSettings, type FactoryWorkflowContext } from "./FactoryWorkflow.ts";
import type { FactorySkillsContext } from "./FactoryAssignmentCommission.ts";
import {
  factorySharedAssignmentOwned,
  factorySharedAssignmentEnabled,
} from "./FactoryWorkflowOwnership.ts";

const human = { kind: "human" } as const;
const host = { kind: "system" } as const;
const managerId = ThreadId.make("system-manager");
const manager = { kind: "thread", threadId: managerId } as const;
const projectId = ProjectId.make("skills-project");
// HEAD of the configured skills repository when these commands are decided.
const skills = { repositoryRoot: "C:/skills", revision: "e".repeat(40) };
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
  context: FactoryWorkflowContext & FactorySkillsContext & { allocation?: FactoryAllocation } = {},
) => Result.getOrThrow(decide({ state, command, actor, now: deliveryNow, skills, ...context }));
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
const commissionFrom = (state: FactorySnapshot) => {
  const proposed = propose(state);
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
const commission = () => commissionFrom(fixture());
const implementation = (state: FactorySnapshot) =>
  state.assignments.findLast((entry) => entry.sharedWork?.kind === "implementation");

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

  it("records the skills commit at commission, and a later commit reaches only the next commission", () => {
    const first = commission();
    const team = implementation(first.state)!;
    assert.deepEqual(team.workflow, skills);
    const moved = { repositoryRoot: "C:/skills", revision: "f".repeat(40) };
    const proposed = propose(first.state);
    const authorized = apply(proposed.state, {
      type: "shared.work.authorize",
      commandId: commandId(),
      workId: proposed.result.workId!,
    });
    const next = apply(
      authorized.state,
      { type: "shared.work.commission", commandId: commandId(), workId: proposed.result.workId! },
      manager,
      { allocation: allocation(), skills: moved },
    );
    assert.deepEqual(next.state.assignments.at(-1)?.workflow, moved);
    assert.deepEqual(
      next.state.assignments.find((entry) => entry.id === team.id)?.workflow,
      skills,
    );
  });

  it("refuses to commission or create a manager without the skills commit it records", () => {
    const proposed = propose(fixture());
    const authorized = apply(proposed.state, {
      type: "shared.work.authorize",
      commandId: commandId(),
      workId: proposed.result.workId!,
    });
    const unpinned = [
      decide({
        state: authorized.state,
        command: {
          type: "shared.work.commission",
          commandId: commandId(),
          workId: proposed.result.workId!,
        },
        actor: manager,
        now: deliveryNow,
        allocation: allocation(),
      }),
      decide({
        state: authorized.state,
        command: {
          type: "manager.create",
          commandId: commandId(),
          projectId: ProjectId.make("another-application"),
          modelSelection: deliverySelection,
        },
        actor: human,
        now: deliveryNow,
        allocation: {
          managerThreadId: ThreadId.make("unpinned-manager"),
          leadThreadId: ThreadId.make("unpinned-onboarding"),
          assignmentId: FactoryAssignmentId.make("unpinned-onboarding-assignment"),
        },
      }),
    ];
    for (const decision of unpinned) {
      if (Result.isSuccess(decision)) return assert.fail("Expected the missing commit to refuse.");
      assert.equal(decision.failure.code, "invalid-state");
      assert.equal(
        decision.failure.detail,
        "The command was decided without the skills commit it records.",
      );
    }
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

  it("records the current skills commit for new onboarding while keeping exclusive shared ownership", () => {
    const state = fixture();
    const create = {
      type: "manager.create",
      commandId: commandId(),
      projectId: ProjectId.make("another-application"),
      modelSelection: deliverySelection,
    } as const;
    const fresh = {
      managerThreadId: ThreadId.make("new-project-manager"),
      leadThreadId: ThreadId.make("new-onboarding"),
      assignmentId: FactoryAssignmentId.make("new-onboarding-assignment"),
    };
    const created = apply(state, create, human, { allocation: fresh });
    assert.deepEqual(created.state.managers.at(-1)?.workflow, skills);
    assert.deepEqual(created.state.assignments.at(-1)?.workflow, skills);
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          command: { ...create, commandId: commandId(), projectId },
          actor: human,
          now: deliveryNow,
          allocation: fresh,
          skills,
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          command: { ...create, commandId: commandId() },
          actor: human,
          now: deliveryNow,
          allocation: fresh,
          skills,
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

  it("lets the human decline a standing model recommendation, which then cannot be applied", () => {
    const recommended = apply(
      fixture(),
      {
        type: "workflow.models.recommend",
        commandId: commandId(),
        proposalId: "proposal",
        proposalRevision: "proposal-v1",
        target: {
          kind: "default",
          policy: { approvedModels: [deliverySelection], preferences: [] },
        },
        rationale: "Observed routing quality",
      },
      manager,
    );
    const recommendationId = recommended.result.recommendationId!;
    const decline = {
      type: "workflow.models.decline",
      commandId: commandId(),
      recommendationId,
      reason: "Current defaults are adequate",
    } as const;
    assert.isTrue(
      Result.isFailure(
        decide({ state: recommended.state, command: decline, actor: manager, now: deliveryNow }),
      ),
    );
    const declined = apply(recommended.state, decline);
    assert.equal(
      declined.state.modelRecommendations[0]?.declined?.reason,
      "Current defaults are adequate",
    );
    const applyDeclined = decide({
      state: declined.state,
      command: { type: "workflow.models.apply", commandId: commandId(), recommendationId },
      actor: human,
      now: deliveryNow,
    });
    assert.isTrue(Result.isFailure(applyDeclined));
    assert.equal(declined.state.modelDefaults, undefined);
    assert.isTrue(
      Result.isFailure(
        decide({
          state: declined.state,
          command: { ...decline, commandId: commandId() },
          actor: human,
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

  it("records validation only against an accepted proposal revision", () => {
    const validate = {
      type: "improvement.validation.record",
      commandId: commandId(),
      proposalId: "proposal",
      proposalRevision: "proposal-v1",
      outcome: "success",
      evidence: [],
      assessment: "Fewer corrections observed",
      recommendedNextStep: "Keep the change",
    } as const;
    for (const outcome of ["rejected", "deferred"] as const) {
      const state = {
        ...fixture(),
        improvementDecisions: fixture().improvementDecisions.map((entry) => ({
          ...entry,
          outcome,
        })),
      };
      assert.isTrue(
        Result.isFailure(decide({ state, command: validate, actor: manager, now: deliveryNow })),
      );
    }
    const undecided = { ...fixture(), improvementDecisions: [] };
    assert.isTrue(
      Result.isFailure(
        decide({ state: undecided, command: validate, actor: manager, now: deliveryNow }),
      ),
    );
    assert.equal(
      apply(fixture(), validate, manager).state.improvementValidations[0]?.outcome,
      "success",
    );
  });

  it("marks every protected-control plan as able to weaken rules", () => {
    const proposed = propose(fixture());
    assert.isTrue(proposed.state.sharedWorks[0]!.plan.weakensRules);
  });
});

describe("system manager replacement", () => {
  it("hands shared repositories and unstarted plans to the replacement, which can commission on them", () => {
    let state = commission().state;
    const retiredTeam = implementation(state)!;
    const proposed = propose(state);
    const workId = proposed.result.workId!;
    state = apply(proposed.state, {
      type: "shared.work.authorize",
      commandId: commandId(),
      workId,
    }).state;
    state = apply(state, {
      type: "manager.retire",
      commandId: commandId(),
      managerId,
      reason: "Replace with a new system manager",
    }).state;
    assert.equal(
      state.assignments.find((entry) => entry.id === retiredTeam.id)?.outcome?.kind,
      "cancelled",
    );

    const replacementId = ThreadId.make("system-manager-2");
    const created = Result.getOrThrow(
      decide({
        state,
        actor: human,
        now: deliveryNow,
        command: {
          type: "system.create",
          commandId: commandId(),
          workspaceProjectId: projectId,
          modelSelection: deliverySelection,
        },
        systemManagerCreation: {
          threadId: replacementId,
          qualification: {
            status: "qualified",
            profileId: "replacement-profile",
            checkedAt: deliveryNow,
          },
        },
        skills,
      }),
    );
    assert.deepEqual(
      created.state.sharedRepositories.map((entry) => entry.managerId),
      [replacementId],
    );
    assert.deepEqual(
      created.effects.filter((effect) => effect.type === "workflow.work.notify"),
      [{ type: "workflow.work.notify", workId, managerId: replacementId }],
    );
    state = apply(
      created.state,
      {
        type: "system.launch.recorded",
        commandId: commandId(),
        managerId: replacementId,
        profileId: "replacement-profile",
      },
      host,
    ).state;
    const commissioned = apply(
      state,
      { type: "shared.work.commission", commandId: commandId(), workId },
      { kind: "thread", threadId: replacementId },
      {
        allocation: {
          managerThreadId: replacementId,
          leadThreadId: ThreadId.make("replacement-lead"),
          assignmentId: FactoryAssignmentId.make("replacement-assignment"),
        },
      },
    );
    const team = commissioned.state.assignments.at(-1)!;
    assert.equal(team.managerId, replacementId);
    assert.isTrue(factorySharedAssignmentEnabled(commissioned.state, team));
    const disabled = apply(commissioned.state, {
      type: "shared.repository.configure",
      commandId: commandId(),
      repositoryId: state.sharedRepositories[0]!.id,
      enabled: false,
    });
    assert.isFalse(factorySharedAssignmentEnabled(disabled.state, team));
  });
});
