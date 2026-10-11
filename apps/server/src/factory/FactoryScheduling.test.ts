import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryAssignmentId,
  FactoryDependencyId,
  MessageId,
  ThreadId,
  type FactoryDecisionCommand,
  type FactorySchedulingAdmission,
  type FactorySnapshot,
  type FactorySupportingWork,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decide, type FactoryActor } from "./FactoryState.ts";
import {
  factoryScheduleEligibility,
  factoryScheduleAuthority,
  factoryScheduleWorkDigest,
  type FactorySchedulingContext,
} from "./FactoryScheduling.ts";
import { deliveryFixture, deliveryIds, deliveryNow } from "./FactoryDelivery.testkit.ts";

const issue = {
  hostKind: "github" as const,
  host: "github.com",
  repository: "owner/repo",
  id: "I_1",
  number: 1,
  url: "https://github.com/owner/repo/issues/1",
};
const work: FactorySupportingWork = {
  title: "Implement ticket",
  kind: "implementation",
  scope: {
    description: "Implement approved ticket",
    completionCondition: "PR merged",
    requiresPullRequest: true,
  },
  complexity: "standard",
  sourcePaths: ["src/feature.ts"],
  creatableDirectories: [],
};
const manager = { kind: "thread" as const, threadId: deliveryIds.manager };
let sequence = 0;
const apply = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = { kind: "system" },
  context: FactorySchedulingContext = {},
) => Result.getOrThrow(decide({ state, command, actor, ...context, now: deliveryNow }));
const id = () => CommandId.make(`schedule-${++sequence}`);
const fixture = () => {
  const base = deliveryFixture();
  let state: FactorySnapshot = {
    ...base,
    assignments: [],
    boundaries: [
      {
        id: deliveryIds.boundary,
        projectId: deliveryIds.project,
        sourceRevision: "base",
        workflow: base.managers[0]!.workflow,
        profileId: "profile",
        approvedAt: deliveryNow,
        protectedPaths: ["eslint.config.js"],
        writablePaths: ["src/feature.ts"],
        creatableDirectories: [],
        gates: [],
      },
    ],
  };
  state = apply(
    state,
    {
      type: "project.scheduling.configure",
      commandId: id(),
      projectId: deliveryIds.project,
      boardId: "board",
      enabled: true,
      maxConcurrentAssignments: 1,
      improvementRule: null,
    },
    { kind: "human" },
    { schedulingBoardVerified: { projectId: deliveryIds.project, boardId: "board" } },
  ).state;
  state = apply(state, {
    type: "schedule.observed",
    commandId: id(),
    projectId: deliveryIds.project,
    configurationId: state.schedulingConfigurations[0]!.id,
    issue,
    canonicalIssueKey: "github:github.com:owner/repo:I_1",
    source: { kind: "tracker-ready" },
    observation: {
      title: "Implement ticket",
      boardRevision: 1,
      itemId: "item",
      columnId: "ready",
      ready: true,
      detailDigest: "detail",
      observedAt: deliveryNow,
    },
  }).state;
  const candidate = state.scheduleCandidates[0]!;
  return apply(
    state,
    {
      type: "schedule.prepare",
      commandId: id(),
      candidateId: candidate.id,
      preparation: {
        work,
        detailDigest: "detail",
        priority: 50,
        dependencyIds: [],
        recommendation: "Ready to implement",
      },
    },
    manager,
  ).state;
};
const admission = (state: FactorySnapshot): FactorySchedulingAdmission => {
  const c = state.scheduleCandidates.at(-1)!;
  return {
    candidateId: c.id,
    configurationId: c.configurationId,
    canonicalIssueKey: c.canonicalIssueKey,
    workDigest: factoryScheduleWorkDigest(work),
    detailDigest: "detail",
    boardId: "board",
    boardFence: "fence",
    authority: { kind: "tracker-ready", boardId: "board", itemId: "item", observedAt: deliveryNow },
    issueAttempt: {
      attemptId: "attempt",
      reservationId: "reservation",
      sourceEnvironmentId: EnvironmentId.make("environment"),
      destinationEnvironmentId: EnvironmentId.make("environment"),
      sourceProjectId: deliveryIds.project,
      boardId: "board",
      issue,
      sourceGeneration: 0,
    },
  };
};
const commission = (
  state: FactorySnapshot,
  context: FactorySchedulingContext = { schedulingAdmission: admission(state) },
) =>
  decide({
    state,
    actor: manager,
    command: {
      type: "assignment.commission",
      commandId: id(),
      managerId: deliveryIds.manager,
      candidateId: state.scheduleCandidates.at(-1)!.id,
      ...work,
    },
    allocation: {
      managerThreadId: deliveryIds.manager,
      leadThreadId: ThreadId.make("new-lead"),
      assignmentId: FactoryAssignmentId.make("scheduled-assignment"),
    },
    ...context,
    now: deliveryNow,
  });

const improvementFixture = (): FactorySnapshot => {
  const state = fixture();
  const original = deliveryFixture().assignments[0]!;
  return {
    ...state,
    defaults: { ...state.defaults, projectImprovements: "project-rule" },
    assignments: [{ ...original, status: "complete" }],
    schedulingConfigurations: state.schedulingConfigurations.map((config) => ({
      ...config,
      improvementRule: {
        id: "rule",
        allowedSourcePaths: ["src/feature.ts"],
        creatableDirectories: [],
        allowedComplexities: ["standard"],
        allowedCauses: ["project"],
        protectedPaths: ["eslint.config.js"],
        reason: "Approved local fixes",
      },
    })),
    scheduleCandidates: state.scheduleCandidates.map((candidate) => ({
      ...candidate,
      source: { kind: "project-improvement", followupId: "followup" },
      observation: { ...candidate.observation, ready: false, columnId: "triage" },
    })),
    findings: [
      {
        id: "finding",
        assignmentId: original.id,
        reporterThreadId: null,
        problem: "Repeated formatting error",
        impact: "Review rework",
        evidence: [{ kind: "thread", threadId: deliveryIds.lead }],
        activeBlocker: false,
        route: {
          suspectedCause: "project",
          uncertainty: "",
          owner: { kind: "project-manager", projectId: deliveryIds.project },
          requiredAuthority: "Project rule",
          rationale: "Local safeguard",
        },
        containmentOf: null,
        history: [],
        escalation: null,
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
    followups: [
      {
        id: "followup",
        assignmentId: original.id,
        projectId: deliveryIds.project,
        findingIds: ["finding"],
        draft: {
          title: "Fix formatting",
          problem: "Repeated formatting error",
          impact: "Review rework",
          proposedOutcome: "Consistent formatting",
          acceptanceCriteria: ["Checks enforce convention"],
          evidence: [],
          owner: "Manager",
          requiredAuthority: "Project rule",
          suspectedCause: "project",
          origin: { assignmentId: original.id, findingIds: ["finding"] },
          containmentOf: null,
        },
        error: null,
        existingIssue: issue,
        publication: { status: "linked", issue, verifiedAt: deliveryNow },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
  };
};

describe("factory scheduling authority", () => {
  it("keeps retro tickets in triage unless a project rule or fresh Ready placement authorizes them", () => {
    const allowed = improvementFixture();
    const candidate = allowed.scheduleCandidates[0]!;
    const authority = Result.getOrThrow(factoryScheduleAuthority(allowed, candidate));
    assert.equal(authority.kind, "project-improvement");
    const triageOnly = {
      ...allowed,
      defaults: { ...allowed.defaults, projectImprovements: "create-tickets" as const },
    };
    assert.isTrue(Result.isFailure(factoryScheduleAuthority(triageOnly, candidate)));
    const ready = {
      ...candidate,
      observation: { ...candidate.observation, ready: true, columnId: "ready" },
    };
    assert.equal(
      Result.getOrThrow(factoryScheduleAuthority(triageOnly, ready)).kind,
      "tracker-ready",
    );
    const result = Result.getOrThrow(
      commission(allowed, { schedulingAdmission: { ...admission(allowed), authority } }),
    );
    assert.equal(result.state.assignments.length, 2);
    assert.equal(result.state.scheduleCandidates[0]!.observation.columnId, "triage");
    assert.equal(result.state.assignments[1]!.grantedPolicy.delivery, "human-approval");
  });
  it("rejects shared findings and scope outside the approved improvement rule", () => {
    const state = improvementFixture();
    const candidate = state.scheduleCandidates[0]!;
    assert.isFalse(
      factoryScheduleEligibility(
        {
          ...state,
          findings: state.findings.map((finding) => ({
            ...finding,
            route: { ...finding.route, suspectedCause: "shared-system" as const },
          })),
        },
        candidate,
      ).eligible,
    );
    const lifecycle = candidate.lifecycle;
    if (lifecycle.phase !== "prepared") return assert.fail("Expected prepared work");
    assert.isFalse(
      factoryScheduleEligibility(state, {
        ...candidate,
        lifecycle: {
          ...lifecycle,
          preparation: {
            ...lifecycle.preparation,
            work: { ...work, sourcePaths: ["src/unapproved.ts"] },
          },
        },
      }).eligible,
    );
  });
  it("requires a distinct authorized control task and preserves rule authority after commissioning", () => {
    let state = improvementFixture();
    const candidate = state.scheduleCandidates[0]!;
    const lifecycle = candidate.lifecycle;
    if (lifecycle.phase !== "prepared") return assert.fail("Expected prepared work");
    const control = {
      ...candidate,
      lifecycle: {
        ...lifecycle,
        preparation: {
          ...lifecycle.preparation,
          work: { ...work, kind: "rule-change" as const, controlPaths: ["eslint.config.js"] },
        },
      },
    };
    assert.isTrue(Result.isFailure(factoryScheduleAuthority(state, control)));
    state = { ...state, defaults: { ...state.defaults, authorizeRuleWeakening: true } };
    assert.equal(
      Result.getOrThrow(factoryScheduleAuthority(state, control)).kind,
      "project-improvement",
    );
    const authority = Result.getOrThrow(factoryScheduleAuthority(state, candidate));
    const committed = Result.getOrThrow(
      commission(state, { schedulingAdmission: { ...admission(state), authority } }),
    ).state;
    const scheduled = committed.assignments.at(-1)!;
    const selected = committed.scheduleCandidates[0]!;
    assert.isTrue(
      Result.isSuccess(
        factoryScheduleAuthority(committed, selected, {
          existingAssignmentId: scheduled.id,
          requiredAuthority: authority,
        }),
      ),
    );
    const downgraded = {
      ...committed,
      defaults: { ...committed.defaults, projectImprovements: "create-tickets" as const },
    };
    assert.isTrue(
      Result.isFailure(
        factoryScheduleAuthority(
          downgraded,
          { ...selected, observation: { ...selected.observation, ready: true, columnId: "ready" } },
          { existingAssignmentId: scheduled.id, requiredAuthority: authority },
        ),
      ),
    );
  });
  it("deduplicates material notifications and ignores old delivery receipts", () => {
    const state = fixture();
    const candidateId = state.scheduleCandidates[0]!.id;
    const first = apply(state, {
      type: "schedule.notifications.requested",
      commandId: id(),
      managerId: deliveryIds.manager,
      notifications: [{ candidateId, digest: "first" }],
    });
    assert.equal(first.effects.length, 1);
    assert.equal(
      apply(first.state, {
        type: "schedule.notifications.requested",
        commandId: id(),
        managerId: deliveryIds.manager,
        notifications: [{ candidateId, digest: "first" }],
      }).effects.length,
      0,
    );
    const next = apply(first.state, {
      type: "schedule.notifications.requested",
      commandId: id(),
      managerId: deliveryIds.manager,
      notifications: [{ candidateId, digest: "next" }],
    }).state;
    const oldReceipt = apply(next, {
      type: "schedule.notified",
      commandId: id(),
      managerId: deliveryIds.manager,
      notifications: [{ candidateId, digest: "first" }],
    }).state;
    assert.isNull(oldReceipt.scheduleCandidates[0]!.notifiedDigest);
    const delivered = apply(oldReceipt, {
      type: "schedule.notified",
      commandId: id(),
      managerId: deliveryIds.manager,
      notifications: [{ candidateId, digest: "next" }],
    }).state;
    assert.equal(delivered.scheduleCandidates[0]!.notifiedDigest, "next");
  });
  it("records a bounded manager batch atomically and isolates superseded receipts", () => {
    const base = fixture();
    const candidate = base.scheduleCandidates[0]!;
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      ...candidate,
      id: `candidate-${index}`,
      canonicalIssueKey: `issue-${index}`,
    }));
    const state = { ...base, scheduleCandidates: candidates };
    const notifications = candidates.map((entry) => ({
      candidateId: entry.id,
      digest: `digest:${entry.id}`,
    }));
    const requested = apply(state, {
      type: "schedule.notifications.requested",
      commandId: id(),
      managerId: deliveryIds.manager,
      notifications,
    });
    assert.deepEqual(requested.effects, [
      { type: "schedule.notify", managerId: deliveryIds.manager, notifications },
    ]);
    assert.deepEqual(
      requested.state.scheduleCandidates.map((entry) => entry.notificationDigest),
      notifications.map((entry) => entry.digest),
    );
    const newer = apply(requested.state, {
      type: "schedule.notifications.requested",
      commandId: id(),
      managerId: deliveryIds.manager,
      notifications: [{ candidateId: candidates[0]!.id, digest: "newer" }],
    }).state;
    const delivered = apply(newer, {
      type: "schedule.notified",
      commandId: id(),
      managerId: deliveryIds.manager,
      notifications,
    }).state;
    assert.isNull(delivered.scheduleCandidates[0]!.notifiedDigest);
    assert.deepEqual(
      delivered.scheduleCandidates.slice(1).map((entry) => entry.notifiedDigest),
      notifications.slice(1).map((entry) => entry.digest),
    );
    for (const invalid of [
      [],
      [...notifications, { candidateId: "extra", digest: "extra" }],
      [notifications[0]!, notifications[0]!],
      [{ candidateId: "missing", digest: "missing" }],
    ])
      assert.isTrue(
        Result.isFailure(
          decide({
            state,
            actor: { kind: "system" },
            command: {
              type: "schedule.notifications.requested",
              commandId: id(),
              managerId: deliveryIds.manager,
              notifications: invalid,
            },
            now: deliveryNow,
          }),
        ),
      );
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: manager,
          command: {
            type: "schedule.notifications.requested",
            commandId: id(),
            managerId: deliveryIds.manager,
            notifications,
          },
          now: deliveryNow,
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state,
          actor: { kind: "system" },
          command: {
            type: "schedule.notifications.requested",
            commandId: id(),
            managerId: ThreadId.make("other-manager"),
            notifications,
          },
          now: deliveryNow,
        }),
      ),
    );
  });
  it("notifies again when material state returns to an earlier delivered digest", () => {
    let state = fixture();
    const candidateId = state.scheduleCandidates[0]!.id;
    for (const digest of ["held", "ready", "held"]) {
      const notifications = [{ candidateId, digest }];
      const requested = apply(state, {
        type: "schedule.notifications.requested",
        commandId: id(),
        managerId: deliveryIds.manager,
        notifications,
      });
      assert.equal(requested.effects.length, 1);
      state = apply(requested.state, {
        type: "schedule.notified",
        commandId: id(),
        managerId: deliveryIds.manager,
        notifications,
      }).state;
      assert.equal(state.scheduleCandidates[0]!.notifiedDigest, digest);
    }
  });
  it("only the host clears a current hold and preserves the prepared scope", () => {
    const state = fixture();
    const candidate = state.scheduleCandidates[0]!;
    const held = apply(state, {
      type: "schedule.held",
      commandId: id(),
      candidateId: candidate.id,
      origin: "eligibility",
      reason: "At capacity",
      expectedStateRevision: state.revision,
    }).state;
    const command = {
      type: "schedule.ready" as const,
      commandId: id(),
      candidateId: candidate.id,
      expectedStateRevision: held.revision,
    };
    assert.isTrue(
      Result.isFailure(decide({ state: held, actor: manager, command, now: deliveryNow })),
    );
    assert.isTrue(
      Result.isFailure(
        decide({
          state: held,
          actor: { kind: "system" },
          command: { ...command, expectedStateRevision: state.revision },
          now: deliveryNow,
        }),
      ),
    );
    const ready = apply(held, command).state;
    assert.deepEqual(ready.scheduleCandidates[0]!.lifecycle, candidate.lifecycle);
    const unprepared = {
      ...state,
      scheduleCandidates: [{ ...candidate, lifecycle: { phase: "observed" as const } }],
    };
    const trackerHeld = apply(unprepared, {
      type: "schedule.held",
      commandId: id(),
      candidateId: candidate.id,
      origin: "tracker",
      reason: "Tracker unavailable",
      expectedStateRevision: unprepared.revision,
    }).state;
    assert.equal(trackerHeld.scheduleCandidates[0]!.lifecycle.phase, "held");
    const observed = apply(trackerHeld, {
      ...command,
      commandId: id(),
      expectedStateRevision: trackerHeld.revision,
    }).state;
    assert.deepEqual(observed.scheduleCandidates[0]!.lifecycle, { phase: "observed" });
  });
  it("holds lower priority work and unresolved project dependencies", () => {
    const state = fixture();
    const candidate = state.scheduleCandidates[0]!;
    const lifecycle = candidate.lifecycle;
    if (lifecycle.phase !== "prepared") return assert.fail("Expected prepared work");
    const urgent = {
      ...candidate,
      id: "urgent",
      canonicalIssueKey: "other-ticket",
      lifecycle: { ...lifecycle, preparation: { ...lifecycle.preparation, priority: 100 } },
    };
    assert.isFalse(
      factoryScheduleEligibility({ ...state, scheduleCandidates: [candidate, urgent] }, candidate)
        .eligible,
    );
    const blockedUrgent = { ...urgent, observation: { ...urgent.observation, ready: false } };
    assert.isTrue(
      factoryScheduleEligibility(
        { ...state, scheduleCandidates: [candidate, blockedUrgent] },
        candidate,
      ).eligible,
    );
    assert.isFalse(
      factoryScheduleEligibility(state, {
        ...candidate,
        lifecycle: {
          ...lifecycle,
          preparation: {
            ...lifecycle.preparation,
            dependencyIds: [FactoryDependencyId.make("missing-dependency")],
          },
        },
      }).eligible,
    );
  });
  it("does not let a ticket that left the board hold back lower-priority work", () => {
    const state = fixture();
    const candidate = state.scheduleCandidates[0]!;
    const lifecycle = candidate.lifecycle;
    if (lifecycle.phase !== "prepared") return assert.fail("Expected prepared work");
    const removed = {
      ...candidate,
      id: "removed",
      canonicalIssueKey: "other-ticket",
      lifecycle: {
        phase: "held" as const,
        origin: "tracker" as const,
        reason: "The ticket is no longer available on the configured board.",
        preparation: { ...lifecycle.preparation, priority: 100 },
      },
    };
    const queue = { ...state, scheduleCandidates: [candidate, removed] };
    assert.deepEqual(factoryScheduleEligibility(queue, removed), {
      eligible: false,
      reasons: ["The ticket is no longer available on the configured board."],
    });
    assert.deepEqual(factoryScheduleEligibility(queue, candidate), { eligible: true });
  });
  it("lets a direct human assignment reserve a ticket that is not Ready", () => {
    const base = fixture();
    const c = base.scheduleCandidates[0]!;
    const lifecycle = c.lifecycle;
    if (lifecycle.phase !== "prepared") return assert.fail("Expected prepared work");
    const urgent = {
      ...c,
      id: "urgent",
      canonicalIssueKey: "other-ticket",
      lifecycle: { ...lifecycle, preparation: { ...lifecycle.preparation, priority: 100 } },
    };
    const state = {
      ...base,
      scheduleCandidates: [
        urgent,
        { ...c, observation: { ...c.observation, ready: false, columnId: "backlog" } },
      ],
    };
    const messageId = MessageId.make("human-request");
    const commandId = id();
    const human = { kind: "human" as const, commandId, messageId };
    const run = (
      authority: FactorySchedulingAdmission["authority"],
      authorizationMessageId?: MessageId,
    ) =>
      decide({
        state,
        actor: manager,
        command: {
          type: "assignment.commission",
          commandId,
          managerId: deliveryIds.manager,
          candidateId: c.id,
          ...(authorizationMessageId ? { authorizationMessageId } : {}),
          ...work,
        },
        allocation: {
          managerThreadId: deliveryIds.manager,
          leadThreadId: ThreadId.make("new-lead"),
          assignmentId: FactoryAssignmentId.make("human-assignment"),
        },
        schedulingAdmission: { ...admission(state), authority },
        now: deliveryNow,
      });
    // Without the human's authority the ticket is not Ready, so it stays unscheduled.
    assert.isTrue(Result.isFailure(run(admission(state).authority)));
    // The cited message must be the one the host verified.
    assert.isTrue(Result.isFailure(run(human, MessageId.make("other-message"))));
    const committed = Result.getOrThrow(run(human, messageId)).state;
    assert.deepEqual(committed.assignments[0]!.scheduling?.authority, human);
    const selected = committed.scheduleCandidates.find((entry) => entry.id === c.id)!;
    assert.equal(selected.lifecycle.phase, "commissioned");
    // The ticket is now reserved, so scheduling cannot start a second team on it.
    assert.isTrue(Result.isFailure(commission(committed)));
    // The same human request cannot authorize another ticket.
    const reused = decide({
      state: committed,
      actor: manager,
      command: {
        type: "assignment.commission",
        commandId: CommandId.make("reuse"),
        managerId: deliveryIds.manager,
        candidateId: urgent.id,
        authorizationMessageId: messageId,
        ...work,
      },
      schedulingAdmission: {
        ...admission(committed),
        candidateId: urgent.id,
        authority: { ...human, commandId: CommandId.make("reuse") },
      },
      now: deliveryNow,
    });
    assert.include(
      Result.isFailure(reused) ? (reused.failure.detail ?? "") : "",
      "already authorized",
    );
  });
  it("retains the issue tombstone across repeated host observations and new configuration", () => {
    const state = Result.getOrThrow(commission(fixture())).state;
    const candidate = state.scheduleCandidates[0]!;
    const replay = apply(state, {
      type: "schedule.observed",
      commandId: id(),
      projectId: candidate.projectId,
      configurationId: candidate.configurationId,
      issue,
      canonicalIssueKey: candidate.canonicalIssueKey,
      source: candidate.source,
      observation: { ...candidate.observation, boardRevision: 99 },
    }).state;
    assert.equal(replay.scheduleCandidates.length, 1);
    assert.equal(replay.assignments.length, 1);
    assert.equal(replay.scheduleCandidates[0]!.lifecycle.phase, "commissioned");
    const disabled = apply(
      replay,
      {
        type: "project.scheduling.configure",
        commandId: id(),
        projectId: deliveryIds.project,
        boardId: "board",
        enabled: false,
        maxConcurrentAssignments: 1,
        improvementRule: null,
      },
      { kind: "human" },
    ).state;
    const assigned = disabled.assignments[0]!;
    assert.isTrue(
      Result.isFailure(
        factoryScheduleAuthority(disabled, disabled.scheduleCandidates[0]!, {
          existingAssignmentId: assigned.id,
          requiredAuthority: assigned.scheduling!.authority,
        }),
      ),
    );
    const resumed = apply(
      disabled,
      {
        type: "project.scheduling.configure",
        commandId: id(),
        projectId: deliveryIds.project,
        boardId: "board",
        enabled: true,
        maxConcurrentAssignments: 1,
        improvementRule: null,
      },
      { kind: "human" },
      { schedulingBoardVerified: { projectId: deliveryIds.project, boardId: "board" } },
    ).state;
    assert.isTrue(
      Result.isSuccess(
        factoryScheduleAuthority(resumed, resumed.scheduleCandidates[0]!, {
          existingAssignmentId: assigned.id,
          requiredAuthority: assigned.scheduling!.authority,
        }),
      ),
    );
  });
  it("claims one prepared Ready issue with its assignment and rejects another command", () => {
    const state = fixture();
    const committed = Result.getOrThrow(commission(state));
    assert.equal(committed.state.assignments.length, 1);
    assert.equal(committed.state.scheduleCandidates[0]!.lifecycle.phase, "commissioned");
    assert.equal(committed.state.assignments[0]!.scheduling?.authority.kind, "tracker-ready");
    assert.equal(committed.effects[0]?.type, "assignment.prepare");
    assert.isTrue(Result.isFailure(commission(committed.state)));
  });
  it("requires host proof even for a candidate commission carrying a verified human message", () => {
    const state = fixture();
    assert.isTrue(Result.isFailure(commission(state, {})));
    const result = decide({
      state,
      actor: { kind: "human" },
      command: {
        type: "assignment.commission",
        commandId: id(),
        managerId: deliveryIds.manager,
        candidateId: state.scheduleCandidates[0]!.id,
        authorizationMessageId: MessageId.make("human-message"),
        ...work,
      },
      humanMessageVerified: true,
      humanMessageId: MessageId.make("human-message"),
      now: deliveryNow,
    });
    assert.isTrue(Result.isFailure(result));
  });
  it("holds nonready work while still allowing preparation and recommendations", () => {
    const state = fixture();
    const c = state.scheduleCandidates[0]!;
    const held = apply(state, {
      type: "schedule.observed",
      commandId: id(),
      projectId: c.projectId,
      configurationId: c.configurationId,
      issue,
      canonicalIssueKey: c.canonicalIssueKey,
      source: c.source,
      observation: { ...c.observation, boardRevision: 2, ready: false, columnId: "triage" },
    }).state;
    assert.equal(held.assignments.length, 0);
    assert.equal(factoryScheduleEligibility(held, held.scheduleCandidates[0]!).eligible, false);
    assert.isTrue(Result.isFailure(commission(held)));
  });
  it("rechecks the exact scope, configuration and capacity at the assignment decision", () => {
    const state = fixture();
    assert.isTrue(
      Result.isFailure(
        commission(state, { schedulingAdmission: { ...admission(state), workDigest: "other" } }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        commission({
          ...state,
          schedulingConfigurations: state.schedulingConfigurations.map((c) => ({
            ...c,
            enabled: false,
          })),
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(commission({ ...state, assignments: deliveryFixture().assignments })),
    );
  });
  it("dismissal leaves a tombstone and only explicit human reopen advances generation", () => {
    const state = fixture();
    const c = state.scheduleCandidates[0]!;
    const dismissed = apply(
      state,
      { type: "schedule.dismiss", commandId: id(), candidateId: c.id, reason: "Duplicate request" },
      { kind: "human" },
    );
    assert.equal(dismissed.effects[0]?.type, "schedule.release");
    assert.isTrue(
      Result.isFailure(
        decide({
          state: dismissed.state,
          actor: manager,
          command: {
            type: "schedule.reopen",
            commandId: id(),
            candidateId: c.id,
            reason: "Try again",
          },
          now: deliveryNow,
        }),
      ),
    );
    const reopened = apply(
      dismissed.state,
      {
        type: "schedule.reopen",
        commandId: id(),
        candidateId: c.id,
        reason: "New approved attempt",
      },
      { kind: "human" },
    ).state;
    assert.equal(reopened.scheduleCandidates.length, 2);
    assert.equal(reopened.scheduleCandidates[1]!.generation, 1);
    assert.equal(reopened.scheduleCandidates[0]!.lifecycle.phase, "dismissed");
  });
});
