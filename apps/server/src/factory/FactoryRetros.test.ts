import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryControlId,
  ThreadId,
  type FactoryAssignment,
  type FactoryDecisionCommand,
  type FactorySnapshot,
  type FactoryFindingDraft,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import {
  decideFactoryRetros,
  factoryCompletionEligibility,
  initialFactoryCompletion,
  type FactoryRetroContext,
} from "./FactoryRetros.ts";
import {
  reviewedDeliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";
import type { FactoryActor } from "./FactoryState.ts";

const ref = { projectId: deliveryIds.project, repository: "owner/repo", number: 1 };
const ref2 = { ...ref, number: 2 };
const fixture = (): FactorySnapshot => {
  const state = reviewedDeliveryFixture();
  const { delivery: _delivery, ...original } = state.assignments[0]!;
  const assignment: FactoryAssignment = {
    ...original,
    scope: {
      description: "Feature",
      completionCondition: "Both PRs merged",
      requiresPullRequest: true,
    },
    completion: {
      phase: "collecting",
      waitReason: null,
      plan: {
        kind: "pull-requests",
        version: 1,
        sealed: true,
        requirements: [
          { id: "one", ref, expectedHeadSha: "head" },
          { id: "two", ref: ref2, expectedHeadSha: "head-two" },
        ],
      },
      deliveries: [
        {
          kind: "pull-request-merged",
          id: "delivery-one",
          projectId: deliveryIds.project,
          ref,
          headSha: "head",
          mergedAt: deliveryNow,
          observedAt: deliveryNow,
        },
      ],
      waivers: [],
      acceptance: null,
      conclusion: null,
    },
  };
  return {
    ...state,
    assignments: [assignment],
    retros: [],
    findings: [],
    followups: [],
    projectTrackers: [],
  };
};
const complete = () => {
  const state = fixture();
  const assignment = state.assignments[0]!;
  return {
    ...state,
    assignments: [
      {
        ...assignment,
        completion: {
          ...assignment.completion!,
          deliveries: [
            ...assignment.completion!.deliveries,
            {
              kind: "pull-request-merged" as const,
              id: "delivery-two",
              projectId: deliveryIds.project,
              ref: ref2,
              headSha: "head-two",
              mergedAt: deliveryNow,
              observedAt: deliveryNow,
            },
          ],
        },
      },
    ],
  };
};
const apply = (
  state: FactorySnapshot,
  command: FactoryDecisionCommand,
  actor: FactoryActor = { kind: "system" },
  context: FactoryRetroContext = {},
) =>
  Result.getOrThrow(decideFactoryRetros({ state, command, actor, now: deliveryNow, ...context })!);
const id = CommandId.make("retro-command");
const cancelled = (patch: Partial<FactoryAssignment> = {}): FactorySnapshot => {
  const state = fixture();
  const controlId = FactoryControlId.make("cancel");
  return {
    ...state,
    assignments: [
      { ...state.assignments[0]!, ...patch, outcome: { kind: "cancelled", controlId } },
    ],
    controls: [
      {
        kind: "cancellation",
        id: controlId,
        generation: 1,
        assignmentId: deliveryIds.assignment,
        managerId: deliveryIds.manager,
        requestedAt: deliveryNow,
        updatedAt: deliveryNow,
        stop: { status: "confirmed", stoppedAt: deliveryNow },
        reason: { text: "Priority changed", recordedAt: deliveryNow },
      },
    ],
  };
};
const conclude = (state: FactorySnapshot) => {
  const frozen = apply(state, {
    type: "assignment.completion.begin",
    commandId: id,
    assignmentId: deliveryIds.assignment,
    expectedStateRevision: state.revision,
  }).state;
  return apply(frozen, {
    type: "assignment.concluded",
    expectedProjectThreadFence: "pure-state-test",
    commandId: id,
    assignmentId: deliveryIds.assignment,
    expectedStateRevision: frozen.revision,
    conclusion: {
      kind: "cancelled",
      id: "cancelled-conclusion",
      evidenceDigest: "cancelled-evidence",
      concludedAt: deliveryNow,
      controlId: FactoryControlId.make("cancel"),
      reasonRecordedAt: deliveryNow,
    },
    retroThreadId: ThreadId.make("cancelled-retro"),
    modelSelection: deliverySelection,
  });
};
const reportFinding = (state: FactorySnapshot, findingId: string) =>
  apply(
    state,
    {
      type: "finding.report",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      findingId,
      finding: {
        problem: `Problem ${findingId}`,
        impact: "Rework",
        evidence: [{ kind: "thread", threadId: deliveryIds.lead }],
        activeBlocker: false,
        route: {
          suspectedCause: "project",
          uncertainty: "Confirmed",
          owner: { kind: "project-manager", projectId: deliveryIds.project },
          requiredAuthority: "Project manager",
          rationale: "Local gap",
        },
        containmentOf: null,
      },
    },
    { kind: "thread", threadId: deliveryIds.lead },
    { evidenceValidated: true },
  ).state;

describe("factory assignment conclusions", () => {
  it("keeps implementation frozen when stopping fails and retries the same conclusion", () => {
    const state = complete();
    const begun = apply(state, {
      type: "assignment.completion.begin",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedStateRevision: state.revision,
    }).state;
    const failed = apply(begun, {
      type: "assignment.completion.failed",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      reason: "Provider stop acknowledgement unavailable",
    }).state;
    assert.equal(failed.assignments[0]!.completion!.phase, "concluding");
    assert.equal(factoryCompletionEligibility(failed, failed.assignments[0]!).eligible, false);
    const retried = apply(
      failed,
      { type: "assignment.completion.retry", commandId: id, assignmentId: deliveryIds.assignment },
      { kind: "human" },
    );
    assert.equal(retried.state.assignments[0]!.completion!.phase, "concluding");
    assert.equal(retried.state.assignments[0]!.completion!.waitReason, null);
    assert.deepEqual(retried.state.assignments[0]!.grant, state.assignments[0]!.grant);
    assert.deepEqual(retried.effects, [
      { type: "assignment.conclude", assignmentId: deliveryIds.assignment },
    ]);
  });
  it("raises a shared cause during active work without a local patch or ticket", () => {
    const state = fixture();
    const finding: FactoryFindingDraft = {
      problem: "Coordination loses context",
      impact: "Teams repeat investigation",
      evidence: [{ kind: "thread", threadId: deliveryIds.lead }],
      activeBlocker: true,
      route: {
        suspectedCause: "shared-system",
        uncertainty: "May be a host race",
        owner: { kind: "system-remit" },
        requiredAuthority: "Human workflow review",
        rationale: "Reproduced in shared host messages",
      },
      containmentOf: null,
    };
    const recorded = apply(
      state,
      {
        type: "finding.report",
        commandId: id,
        assignmentId: deliveryIds.assignment,
        findingId: "shared-finding",
        finding,
      },
      { kind: "thread", threadId: deliveryIds.lead },
      { evidenceValidated: true },
    ).state;
    const escalated = apply(
      recorded,
      {
        type: "finding.escalate",
        commandId: id,
        findingId: "shared-finding",
        summary: "Investigate shared message delivery",
      },
      { kind: "thread", threadId: deliveryIds.lead },
    );
    assert.equal(
      escalated.state.findings[0]!.escalation?.summary,
      "Investigate shared message delivery",
    );
    assert.deepEqual(escalated.state.followups, []);
    assert.deepEqual(escalated.effects, []);
  });
  it("files project follow-ups under the approved tracker without commissioning implementation", () => {
    const state = fixture();
    const finding: FactoryFindingDraft = {
      problem: "Missing lint rule",
      impact: "Repeated invalid imports",
      evidence: [{ kind: "thread", threadId: deliveryIds.lead }],
      activeBlocker: false,
      route: {
        suspectedCause: "project",
        uncertainty: "Confirmed by repro",
        owner: { kind: "project-manager", projectId: deliveryIds.project },
        requiredAuthority: "Separate rule-change task",
        rationale: "Project import convention is unenforced",
      },
      containmentOf: null,
    };
    let next = apply(
      state,
      {
        type: "finding.report",
        commandId: id,
        assignmentId: deliveryIds.assignment,
        findingId: "lint",
        finding,
      },
      { kind: "thread", threadId: deliveryIds.lead },
      { evidenceValidated: true },
    ).state;
    const destination = {
      kind: "github" as const,
      host: "github.com",
      repository: "owner/repo",
      triage: { kind: "labels" as const, labels: ["triage"] },
    };
    next = apply(
      next,
      {
        type: "project.tracker.configure",
        commandId: id,
        projectId: deliveryIds.project,
        expectedTrackerId: null,
        destination,
      },
      { kind: "human" },
      {
        qualifiedTracker: {
          projectId: deliveryIds.project,
          environmentId: EnvironmentId.make("environment"),
          credentialNamespace: "namespace",
          destination,
          board: null,
          validatedAt: deliveryNow,
        },
      },
    ).state;
    const requested = apply(
      next,
      {
        type: "followup.request",
        commandId: id,
        assignmentId: deliveryIds.assignment,
        followupId: "lint-followup",
        findingIds: ["lint"],
        draft: {
          title: "Enforce import convention",
          problem: "Missing rule",
          impact: "Inconsistent imports",
          proposedOutcome: "Rule catches violations",
          acceptanceCriteria: ["Invalid import rejected"],
          evidence: [{ summary: "Implementation found repeated imports", url: null }],
          owner: "Project manager",
          requiredAuthority: "Separate rule-change task",
          suspectedCause: "Project safeguard gap",
          origin: { assignmentId: deliveryIds.assignment, findingIds: ["lint"] },
          containmentOf: null,
        },
      },
      { kind: "thread", threadId: deliveryIds.lead },
    );
    assert.deepEqual(requested.effects, [
      { type: "followup.publish", followupId: "lint-followup" },
    ]);
    assert.equal(requested.state.assignments.length, state.assignments.length);
    assert.equal(requested.state.followups[0]!.publication.status, "requested");
    const failed = apply(requested.state, {
      type: "followup.failed",
      commandId: id,
      followupId: "lint-followup",
      reason: "Tracker authentication unavailable",
    }).state;
    assert.equal(failed.followups[0]!.error, "Tracker authentication unavailable");
    assert.deepEqual(failed.followups[0]!.publication, requested.state.followups[0]!.publication);
    const retried = apply(
      failed,
      { type: "followup.retry", commandId: id, followupId: "lint-followup" },
      { kind: "thread", threadId: deliveryIds.lead },
    );
    assert.equal(retried.state.followups[0]!.error, null);
    assert.deepEqual(
      retried.state.followups[0]!.publication,
      requested.state.followups[0]!.publication,
    );
    assert.deepEqual(retried.effects, requested.effects);
    const issue = {
      hostKind: "github" as const,
      host: "github.com",
      repository: "owner/repo",
      id: "12",
      number: 12,
      url: "https://github.com/owner/repo/issues/12",
    };
    const linkCommand = {
      type: "followup.link-existing" as const,
      commandId: id,
      followupId: "lint-followup",
      issue,
    };
    const unconfigured = {
      ...requested.state,
      followups: requested.state.followups.map((followup) => ({
        ...followup,
        publication: { status: "configuration-required" as const, reason: "Configure tracker" },
      })),
    };
    assert.isTrue(
      Result.isFailure(
        decideFactoryRetros({
          state: { ...unconfigured, projectTrackers: [] },
          command: linkCommand,
          actor: { kind: "human" },
          now: deliveryNow,
        })!,
      ),
    );
    const linkedRequest = apply(unconfigured, linkCommand, { kind: "human" });
    assert.equal(linkedRequest.state.followups[0]!.publication.status, "requested");
    assert.deepEqual(linkedRequest.state.followups[0]!.existingIssue, issue);
    const linkFailure = apply(linkedRequest.state, {
      type: "followup.failed",
      commandId: id,
      followupId: "lint-followup",
      reason: "Temporary lookup outage",
    }).state;
    assert.deepEqual(
      apply(
        linkFailure,
        { type: "followup.retry", commandId: id, followupId: "lint-followup" },
        { kind: "human" },
      ).effects,
      linkedRequest.effects,
    );
    const receipt = {
      requestId: "factory-followup:lint-followup",
      requestDigest: "digest",
      destination: next.projectTrackers[0]!.destination,
      marker: "marker",
      progress: { status: "outcome-unknown" as const, reason: "Create response lost" },
      createdAt: deliveryNow,
      updatedAt: deliveryNow,
    };
    const unknown = apply(requested.state, {
      type: "followup.publication.recorded",
      commandId: id,
      followupId: "lint-followup",
      receipt,
    }).state;
    assert.isTrue(
      Result.isFailure(
        decideFactoryRetros({
          state: unknown,
          command: linkCommand,
          actor: { kind: "thread", threadId: deliveryIds.lead },
          now: deliveryNow,
        })!,
      ),
    );
    const selected = apply(unknown, linkCommand, { kind: "human" }).state;
    const pendingReceipt = {
      ...receipt,
      progress: { status: "placement-pending" as const, issue, reason: "Board access unavailable" },
    };
    assert.isTrue(
      Result.isFailure(
        decideFactoryRetros({
          state: selected,
          command: {
            type: "followup.linked",
            commandId: id,
            followupId: "lint-followup",
            receipt: pendingReceipt,
          },
          actor: { kind: "system" },
          now: deliveryNow,
        })!,
      ),
    );
    const confirmed = apply(selected, {
      type: "followup.linked",
      commandId: id,
      followupId: "lint-followup",
      receipt: {
        ...receipt,
        progress: {
          status: "triaged",
          issue,
          placement: { kind: "labels", labels: ["triage"] },
          verifiedAt: deliveryNow,
        },
      },
    }).state;
    assert.equal(confirmed.followups[0]!.publication.status, "linked");
  });
  it("requires every actual merge and freezes implementation before scheduling the final retro", () => {
    const waiting = fixture();
    assert.equal(factoryCompletionEligibility(waiting, waiting.assignments[0]!).eligible, false);
    const state = complete();
    const begun = apply(state, {
      type: "assignment.completion.begin",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedStateRevision: state.revision,
    });
    assert.equal(begun.state.assignments[0]!.completion!.phase, "concluding");
    assert.deepEqual(begun.effects, [
      { type: "assignment.conclude", assignmentId: deliveryIds.assignment },
    ]);
  });
  it("requires human scope cancellation and never turns a closed PR into a merge", () => {
    const state = fixture();
    const command = {
      type: "assignment.completion.waive" as const,
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedVersion: 1,
      requirementIds: ["two"],
      reason: "No longer needed",
    };
    assert.isTrue(
      Result.isFailure(
        decideFactoryRetros({
          state,
          command,
          actor: { kind: "thread", threadId: deliveryIds.lead },
          now: deliveryNow,
        })!,
      ),
    );
    const waived = apply(state, command, { kind: "human" }).state;
    const result = factoryCompletionEligibility(waived, waived.assignments[0]!);
    assert.isTrue(result.eligible);
    if (result.eligible) assert.equal(result.disposition.kind, "partially-delivered-and-cancelled");
  });
  it("requires confirmed stopping and the human reason for cancellation", () => {
    let state = fixture();
    const controlId = FactoryControlId.make("cancel");
    state = {
      ...state,
      assignments: [{ ...state.assignments[0]!, outcome: { kind: "cancelled", controlId } }],
      controls: [
        {
          kind: "cancellation",
          id: controlId,
          generation: 1,
          assignmentId: deliveryIds.assignment,
          managerId: deliveryIds.manager,
          requestedAt: deliveryNow,
          updatedAt: deliveryNow,
          stop: { status: "pending" },
        },
      ],
    };
    assert.equal(factoryCompletionEligibility(state, state.assignments[0]!).eligible, false);
    state = {
      ...state,
      controls: state.controls.map((control) =>
        control.kind === "cancellation"
          ? {
              ...control,
              stop: { status: "confirmed" as const, stoppedAt: deliveryNow },
              reason: { text: "Priority changed", recordedAt: deliveryNow },
            }
          : control,
      ),
    };
    assert.equal(factoryCompletionEligibility(state, state.assignments[0]!).eligible, true);
    state = apply(state, {
      type: "assignment.completion.begin",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedStateRevision: state.revision,
    }).state;
    state = apply(state, {
      type: "assignment.concluded",
      expectedProjectThreadFence: "pure-state-test",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedStateRevision: state.revision,
      conclusion: {
        kind: "cancelled",
        id: "cancelled-conclusion",
        evidenceDigest: "cancelled-evidence",
        concludedAt: deliveryNow,
        controlId,
        reasonRecordedAt: deliveryNow,
      },
      retroThreadId: ThreadId.make("cancelled-retro"),
      modelSelection: deliverySelection,
    }).state;
    const command = {
      type: "retro.team.submit" as const,
      commandId: id,
      retroId: state.retros[0]!.id,
      conclusionId: "cancelled-conclusion",
      report: {
        outcome: "Priority changed",
        helped: "Investigation clarified options",
        hindered: "",
        contributions: [],
        learning: {
          kind: "no-process-change" as const,
          reason: "Cancellation did not indicate an engineering failure",
        },
      },
    };
    assert.equal(
      apply(state, command, { kind: "human" }, { evidenceValidated: true }).state.retros[0]!.reports
        .phase,
      "manager-pending",
    );
    const changed = {
      ...state,
      controls: state.controls.map((control) =>
        control.kind === "cancellation"
          ? { ...control, reason: { text: "Different reason", recordedAt: "2026-10-11T12:00:00Z" } }
          : control,
      ),
    };
    assert.isTrue(
      Result.isFailure(
        decideFactoryRetros({
          state: changed,
          command,
          actor: { kind: "human" },
          now: deliveryNow,
          evidenceValidated: true,
        })!,
      ),
    );
  });
  it("does not substitute a delivered recommendation for an agreed human acceptance", () => {
    const state = fixture();
    const scope = {
      description: "Investigate",
      completionCondition: "Human accepts findings",
      requiresPullRequest: false,
      noPrTarget: { kind: "human-acceptance" as const },
    };
    const assignment = {
      ...state.assignments[0]!,
      scope,
      completion: initialFactoryCompletion(scope),
    };
    assert.equal(
      factoryCompletionEligibility({ ...state, assignments: [assignment] }, assignment).eligible,
      false,
    );
  });
  it("reopens a frozen manifest when another required PR is discovered", () => {
    const state = complete();
    const frozen = apply(state, {
      type: "assignment.completion.begin",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedStateRevision: state.revision,
    }).state;
    const reopened = apply(frozen, {
      type: "assignment.completion.reopen",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedStateRevision: frozen.revision,
      reason: "Another linked PR remains open",
      discoveredRequirements: [{ id: "three", ref: { ...ref, number: 3 }, expectedHeadSha: null }],
    }).state;
    assert.equal(reopened.assignments[0]!.completion!.phase, "collecting");
    assert.equal(factoryCompletionEligibility(reopened, reopened.assignments[0]!).eligible, false);
  });
  it("holds an unexpected PR on no-PR work for explicit retry without changing the scope", () => {
    const state = fixture();
    const scope = {
      description: "Investigate",
      completionCondition: "Human accepts findings",
      requiresPullRequest: false,
      noPrTarget: { kind: "human-acceptance" as const },
    };
    const completion = {
      ...initialFactoryCompletion(scope),
      phase: "concluding" as const,
      acceptance: {
        commandId: id,
        evidence: [{ kind: "thread" as const, threadId: deliveryIds.lead }],
        acceptedAt: deliveryNow,
      },
    };
    const frozen = { ...state, assignments: [{ ...state.assignments[0]!, scope, completion }] };
    const reopened = apply(frozen, {
      type: "assignment.completion.reopen",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedStateRevision: frozen.revision,
      reason: "Unexpected linked PR needs resolution",
      discoveredRequirements: [{ id: "unexpected", ref, expectedHeadSha: null }],
    }).state;
    assert.deepEqual(reopened.assignments[0]!.completion!.plan, completion.plan);
    assert.equal(factoryCompletionEligibility(reopened, reopened.assignments[0]!).eligible, false);
    const retried = apply(
      reopened,
      { type: "assignment.completion.retry", commandId: id, assignmentId: deliveryIds.assignment },
      { kind: "human" },
    ).state;
    assert.equal(retried.assignments[0]!.completion!.phase, "collecting");
    assert.equal(retried.assignments[0]!.completion!.waitReason, null);
    assert.equal(retried.retros.length, 0);
  });
  it("accepts one team retro before the manager report and permits no process change", () => {
    const state = complete();
    const frozen = apply(state, {
      type: "assignment.completion.begin",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedStateRevision: state.revision,
    }).state;
    const concluded = apply(frozen, {
      type: "assignment.concluded",
      expectedProjectThreadFence: "pure-state-test",
      commandId: id,
      assignmentId: deliveryIds.assignment,
      expectedStateRevision: frozen.revision,
      conclusion: {
        kind: "delivered",
        id: "conclusion",
        evidenceDigest: "evidence",
        concludedAt: deliveryNow,
        planVersion: 1,
        deliveryIds: ["delivery-one", "delivery-two"],
      },
      retroThreadId: ThreadId.make("retro-thread"),
      modelSelection: deliverySelection,
    }).state;
    const retro = concluded.retros[0]!;
    const staleTerminal = decideFactoryRetros({
      state: concluded,
      actor: { kind: "system" },
      now: deliveryNow,
      command: {
        type: "retro.failed",
        commandId: id,
        retroId: retro.id,
        reason: "Turn ended before report",
        expectedStateRevision: concluded.revision - 1,
      },
    })!;
    assert.isTrue(Result.isFailure(staleTerminal));
    if (Result.isFailure(staleTerminal)) assert.equal(staleTerminal.failure.code, "stale-revision");
    const managerCommand = {
      type: "retro.manager.submit" as const,
      commandId: id,
      retroId: retro.id,
      teamReportDigest: "team",
      report: {
        summary: "No change",
        learning: { kind: "no-process-change" as const, reason: "Routine delivery" },
        dispositions: [],
      },
    };
    assert.isTrue(
      Result.isFailure(
        decideFactoryRetros({
          state: concluded,
          command: managerCommand,
          actor: { kind: "human" },
          now: deliveryNow,
        })!,
      ),
    );
    const team = apply(
      concluded,
      {
        type: "retro.team.submit",
        commandId: id,
        retroId: retro.id,
        conclusionId: "conclusion",
        report: {
          outcome: "Delivered",
          helped: "Checks",
          hindered: "",
          contributions: [],
          learning: { kind: "no-process-change", reason: "Routine delivery" },
        },
      },
      { kind: "human" },
      { evidenceValidated: true },
    ).state;
    const reportState = team.retros[0]!.reports;
    assert.equal(reportState.phase, "manager-pending");
    const lateTerminal = apply(team, {
      type: "retro.failed",
      commandId: id,
      retroId: retro.id,
      reason: "Late terminal observation after accepted report",
      expectedStateRevision: team.revision,
    }).state;
    assert.deepEqual(lateTerminal.retros[0], team.retros[0]);
    if (reportState.phase !== "manager-pending") return;
    const finished = apply(
      team,
      { ...managerCommand, teamReportDigest: reportState.team.digest },
      { kind: "human" },
    ).state;
    assert.equal(finished.retros[0]!.reports.phase, "complete");
  });
  it("concludes work cancelled before it qualified with a manager retro only", () => {
    const unqualified = cancelled({
      qualification: { status: "unavailable", reason: "Preparing" },
    });
    const concluded = conclude(unqualified);
    const retro = concluded.state.retros[0]!;
    assert.equal(retro.execution.status, "stopped");
    assert.equal(retro.reports.phase, "manager-pending");
    if (retro.reports.phase !== "manager-pending") return;
    assert.deepEqual(concluded.effects, [
      {
        type: "retro.manager-notify",
        retroId: retro.id,
        teamReportDigest: retro.reports.team.digest,
      },
    ]);
    assert.isFalse(
      concluded.state.auxiliaryThreads.some((entry) => entry.threadId === retro.threadId),
    );
    const finished = apply(
      concluded.state,
      {
        type: "retro.manager.submit",
        commandId: id,
        retroId: retro.id,
        teamReportDigest: retro.reports.team.digest,
        report: {
          summary: "Cancelled before work started",
          learning: { kind: "no-process-change", reason: "Priority change" },
          dispositions: [],
        },
      },
      { kind: "human" },
    ).state;
    assert.equal(finished.retros[0]!.reports.phase, "complete");
    assert.equal(finished.assignments[0]!.status, "complete");
  });
  it("lets a failed retro for unstarted cancelled work move on when retried", () => {
    const concluded = conclude(cancelled()).state;
    // Retros recorded for unstarted work by older builds failed to prepare; retry must move on.
    const failed = {
      ...concluded,
      assignments: concluded.assignments.map(({ startingSource: _source, ...entry }) => entry),
      retros: concluded.retros.map((entry) => ({
        ...entry,
        execution: { status: "failed" as const, reason: "Could not prepare" },
      })),
    };
    const retried = apply(
      failed,
      { type: "retro.retry", commandId: id, retroId: failed.retros[0]!.id },
      { kind: "human" },
    );
    assert.equal(retried.state.retros[0]!.reports.phase, "manager-pending");
    assert.equal(retried.effects[0]?.type, "retro.manager-notify");
    assert.equal(
      retried.state.auxiliaryThreads.find((entry) => entry.threadId === failed.retros[0]!.threadId)
        ?.status,
      "complete",
    );
  });
  it("lets the human acknowledge an escalation", () => {
    const recorded = reportFinding(fixture(), "active");
    const escalated = apply(
      recorded,
      { type: "finding.escalate", commandId: id, findingId: "active", summary: "Blocked on host" },
      { kind: "thread", threadId: deliveryIds.lead },
    ).state;
    const acknowledge = {
      type: "finding.escalation.acknowledge" as const,
      commandId: id,
      findingId: "active",
    };
    assert.isTrue(
      Result.isFailure(
        decideFactoryRetros({
          state: escalated,
          command: acknowledge,
          actor: { kind: "thread", threadId: deliveryIds.manager },
          now: deliveryNow,
        })!,
      ),
    );
    const acknowledged = apply(escalated, acknowledge, { kind: "human" }).state;
    assert.equal(acknowledged.findings[0]!.escalation?.acknowledgedAt, deliveryNow);
    assert.equal(acknowledged.findings[0]!.escalation?.summary, "Blocked on host");
  });
  it("caps findings at the number a manager retro can dispose of", () => {
    let state = fixture();
    for (let index = 0; index < 30; index++) state = reportFinding(state, `finding-${index}`);
    assert.throws(() => reportFinding(state, "finding-30"));
  });
  it("files one follow-up ticket per finding", () => {
    const state = reportFinding(fixture(), "lint");
    const request = (followupId: string) => ({
      type: "followup.request" as const,
      commandId: id,
      assignmentId: deliveryIds.assignment,
      followupId,
      findingIds: ["lint"],
      draft: {
        title: "Enforce import convention",
        problem: "Missing rule",
        impact: "Inconsistent imports",
        proposedOutcome: "Rule catches violations",
        acceptanceCriteria: ["Invalid import rejected"],
        evidence: [],
        owner: "Project manager",
        requiredAuthority: "Separate rule-change task",
        suspectedCause: "Project safeguard gap",
        origin: { assignmentId: deliveryIds.assignment, findingIds: ["lint"] },
        containmentOf: null,
      },
    });
    const filed = apply(state, request("team"), { kind: "thread", threadId: deliveryIds.lead });
    assert.equal(filed.state.followups.length, 1);
    const duplicate = decideFactoryRetros({
      state: filed.state,
      command: request("manager"),
      actor: { kind: "thread", threadId: deliveryIds.manager },
      now: deliveryNow,
    })!;
    assert.isTrue(Result.isFailure(duplicate));
  });
});
