import {
  FactoryError,
  type FactoryAssignment,
  type FactoryAssignmentCompletion,
  type FactoryAssignmentId,
  type FactoryAssignmentScope,
  type FactoryCommandResult,
  type FactoryConclusion,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryFinding,
  type FactoryFindingOwner,
  type FactoryFollowup,
  type FactoryRetro,
  type FactorySnapshot,
  type PullRequestRef,
  type QualifiedIssueDestination,
  type ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";
import { factoryExecutionBlocked } from "./FactoryControls.ts";
import { isFactoryModelApproved } from "./FactoryModelPolicy.ts";
import type { FactoryActor, FactoryDecision } from "./FactoryState.ts";

export interface FactoryRetroContext {
  readonly qualifiedTracker?: QualifiedIssueDestination;
  readonly evidenceValidated?: boolean;
}
type Disposition<T> = T extends FactoryConclusion
  ? Omit<T, "id" | "evidenceDigest" | "concludedAt">
  : never;
export type FactoryConclusionDisposition = Disposition<FactoryConclusion>;
export const factoryRetroId = (assignmentId: FactoryAssignmentId) => `retro:${assignmentId}`;
export const factorySamePullRequest = (a: PullRequestRef, b: PullRequestRef) =>
  a.projectId === b.projectId &&
  (a.host ?? "github.com").toLowerCase() === (b.host ?? "github.com").toLowerCase() &&
  a.repository.toLowerCase() === b.repository.toLowerCase() &&
  a.number === b.number;
const hash = (value: unknown) =>
  Hex.encode(sha256(new TextEncoder().encode(stableStringify(value))));
const conclusionDisposition = (conclusion: FactoryConclusion): FactoryConclusionDisposition => {
  const { id: _id, evidenceDigest: _digest, concludedAt: _at, ...disposition } = conclusion;
  return disposition;
};

export const initialFactoryCompletion = (
  scope: FactoryAssignmentScope | undefined,
  _managerId?: ThreadId,
): FactoryAssignmentCompletion => ({
  phase: "collecting",
  waitReason: null,
  plan:
    scope?.requiresPullRequest === false
      ? {
          kind: "no-pr",
          target: scope.noPrTarget ?? { kind: "human-acceptance" },
          condition: scope.completionCondition,
        }
      : { kind: "pull-requests", version: 0, requirements: [], sealed: false },
  deliveries: [],
  waivers: [],
  acceptance: null,
  conclusion: null,
});

export function factoryCompletionEligibility(
  state: FactorySnapshot,
  assignment: FactoryAssignment,
):
  | { readonly eligible: true; readonly disposition: FactoryConclusionDisposition }
  | { readonly eligible: false; readonly reasons: readonly string[] } {
  const wait = (reason: string) => ({ eligible: false as const, reasons: [reason] });
  if (assignment.completion?.waitReason) return wait(assignment.completion.waitReason);
  if (assignment.kind === "onboarding")
    return wait("Onboarding is concluded through its boundary report.");
  if (
    assignment.delivery?.revisions.some(
      (revision) =>
        (!assignment.outcome && revision.status === "capturing") ||
        revision.status === "publishing" ||
        revision.merge?.status === "requested" ||
        revision.merge?.status === "unknown",
    )
  )
    return wait("An external publication or merge outcome remains unresolved.");
  if (assignment.outcome) {
    const control = state.controls.find((entry) => entry.id === assignment.outcome?.controlId);
    if (control?.kind !== "cancellation" || control.stop.status !== "confirmed")
      return wait("Cancellation must finish stopping the team first.");
    if (!control.reason) return wait("The human cancellation reason is still required.");
    return {
      eligible: true,
      disposition: {
        kind: "cancelled",
        controlId: control.id,
        reasonRecordedAt: control.reason.recordedAt,
      },
    };
  }
  if (assignment.integrationId)
    return wait("Integration completion requires a confirmed shared merge operation.");
  const completion = assignment.completion;
  if (!completion) return wait("Declare the assignment's complete delivery requirements first.");
  const plan = completion.plan;
  if (plan.kind === "no-pr") {
    if (
      assignment.scope?.requiresPullRequest !== false ||
      plan.condition !== assignment.scope.completionCondition
    )
      return wait("The no-PR completion target does not match the commissioned scope.");
    if (plan.target.kind === "human-acceptance")
      return completion.acceptance
        ? {
            eligible: true,
            disposition: {
              kind: "no-pr-delivered",
              proof: { kind: "human-acceptance", commandId: completion.acceptance.commandId },
            },
          }
        : wait("The agreed human acceptance is pending.");
    const recipient = plan.target.recipientThreadId;
    const receipt = completion.deliveries.find(
      (entry) =>
        entry.kind === "report-delivered" &&
        entry.assignmentId === assignment.id &&
        entry.recipientThreadId === recipient,
    );
    return receipt
      ? {
          eligible: true,
          disposition: {
            kind: "no-pr-delivered",
            proof: { kind: "report-received", deliveryId: receipt.id },
          },
        }
      : wait("The agreed report must actually reach its recipient.");
  }
  if (!plan.sealed || plan.requirements.length === 0)
    return wait("The complete required-PR manifest must be declared and sealed.");
  const deliveryIds: string[] = [];
  const waiverCommandIds: FactoryAssignmentCompletion["waivers"][number]["commandId"][] = [];
  for (const requirement of plan.requirements) {
    const delivery = completion.deliveries.find(
      (entry) =>
        entry.kind === "pull-request-merged" &&
        factorySamePullRequest(entry.ref, requirement.ref) &&
        (requirement.expectedHeadSha === null || requirement.expectedHeadSha === entry.headSha),
    );
    if (delivery) {
      deliveryIds.push(delivery.id);
      continue;
    }
    const waiver = completion.waivers.find((entry) => entry.requirementId === requirement.id);
    if (waiver) {
      waiverCommandIds.push(waiver.commandId);
      continue;
    }
    return wait(
      `Required PR ${requirement.ref.repository}#${requirement.ref.number} has not actually merged or been explicitly waived.`,
    );
  }
  const known = [
    ...completion.deliveries.flatMap((entry) =>
      entry.kind === "pull-request-merged" ? [entry.ref] : [],
    ),
    ...(assignment.delivery?.revisions.flatMap((entry) =>
      entry.publication?.ref ? [entry.publication.ref] : [],
    ) ?? []),
  ];
  if (
    known.some(
      (ref) =>
        !plan.requirements.some((requirement) => factorySamePullRequest(ref, requirement.ref)),
    )
  )
    return wait("A published or delivered PR is missing from the required manifest.");
  return {
    eligible: true,
    disposition: waiverCommandIds.length
      ? {
          kind: "partially-delivered-and-cancelled",
          planVersion: plan.version,
          deliveryIds,
          waiverCommandIds: [...new Set(waiverCommandIds)],
        }
      : { kind: "delivered", planVersion: plan.version, deliveryIds },
  };
}

export function decideFactoryRetros(
  input: FactoryRetroContext & {
    readonly state: FactorySnapshot;
    readonly actor: FactoryActor;
    readonly command: FactoryDecisionCommand;
    readonly now: string;
  },
): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  const fail = (detail: string, code: FactoryError["code"] = "invalid-state") =>
    Result.fail(new FactoryError({ code, detail }));
  const accept = (
    patch: Partial<FactorySnapshot> = {},
    effects: readonly FactoryEffectIntent[] = [],
    result: Omit<FactoryCommandResult, "revision"> = {},
  ): Result.Result<FactoryDecision, FactoryError> => {
    const revision = state.revision + 1;
    return Result.succeed({
      state: { ...state, ...patch, revision },
      result: { ...result, revision },
      effects,
    });
  };
  const saveAssignment = (
    assignment: FactoryAssignment,
    effects: readonly FactoryEffectIntent[] = [],
    patch: Partial<FactorySnapshot> = {},
  ) =>
    accept(
      {
        ...patch,
        assignments: state.assignments.map((entry) =>
          entry.id === assignment.id ? { ...assignment, updatedAt: now } : entry,
        ),
      },
      effects,
      { assignmentId: assignment.id },
    );
  const saveRetro = (
    retro: FactoryRetro,
    effects: readonly FactoryEffectIntent[] = [],
    patch: Partial<FactorySnapshot> = {},
  ) =>
    accept(
      {
        ...patch,
        retros: state.retros.map((entry) =>
          entry.id === retro.id ? { ...retro, updatedAt: now } : entry,
        ),
      },
      effects,
      { retroId: retro.id, assignmentId: retro.assignmentId },
    );
  const saveFollowup = (followup: FactoryFollowup, effects: readonly FactoryEffectIntent[] = []) =>
    accept(
      {
        followups: state.followups.some((entry) => entry.id === followup.id)
          ? state.followups.map((entry) =>
              entry.id === followup.id ? { ...followup, updatedAt: now } : entry,
            )
          : [...state.followups, followup],
      },
      effects,
      { followupId: followup.id, assignmentId: followup.assignmentId },
    );
  const canManage = (assignment: FactoryAssignment) =>
    actor.kind === "human" || (actor.kind === "thread" && actor.threadId === assignment.managerId);
  const canLead = (assignment: FactoryAssignment) =>
    canManage(assignment) ||
    (actor.kind === "thread" &&
      (actor.threadId === assignment.threadId ||
        state.retros.some(
          (retro) =>
            retro.assignmentId === assignment.id &&
            retro.threadId === actor.threadId &&
            retro.reports.phase !== "complete",
        )));
  const ownEvidence = (assignment: FactoryAssignment) =>
    canLead(assignment) || (actor.kind === "thread" && actor.assignmentId === assignment.id);
  const ownerInScope = (owner: FactoryFindingOwner, assignment: FactoryAssignment) =>
    owner.kind === "implementation-lead"
      ? owner.assignmentId === assignment.id
      : owner.kind !== "project-manager" || owner.projectId === assignment.projectId;
  const managerAvailable = (assignment: FactoryAssignment) =>
    factoryExecutionBlocked(state, {
      threadId: assignment.managerId,
      managerId: assignment.managerId,
      projectId: assignment.projectId,
      ancestorThreadIds: [],
    }) === undefined;
  const publicAllowed = (assignment: FactoryAssignment) =>
    actor.kind === "human" ||
    (!state.controls.some(
      (entry) =>
        entry.kind === "project-pause" &&
        entry.status === "active" &&
        entry.projectId === assignment.projectId,
    ) &&
      (actor.kind !== "thread" ||
        actor.threadId !== assignment.managerId ||
        managerAvailable(assignment)));
  const activeTracker = (projectId: FactoryAssignment["projectId"]) =>
    state.projectTrackers.findLast((entry) => entry.projectId === projectId);
  const validLearning = (
    assignmentId: FactoryAssignmentId,
    learning: { kind: string; findingIds?: readonly string[] },
  ) =>
    learning.kind === "no-process-change" ||
    learning.findingIds?.every((id) =>
      state.findings.some((finding) => finding.id === id && finding.assignmentId === assignmentId),
    );

  switch (command.type) {
    case "assignment.completion.retry": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment || !canLead(assignment) || !publicAllowed(assignment))
        return fail(
          "This actor cannot retry the assignment's completion check.",
          "permission-denied",
        );
      const completion = assignment.completion;
      if (
        !completion ||
        completion.phase === "concluded" ||
        completion.conclusion ||
        (completion.phase === "concluding" && !completion.waitReason)
      )
        return fail("No completion check is awaiting retry.");
      return saveAssignment(
        { ...assignment, completion: { ...completion, waitReason: null } },
        completion.phase === "concluding"
          ? [{ type: "assignment.conclude", assignmentId: assignment.id }]
          : [],
      );
    }
    case "assignment.completion.failed": {
      if (actor.kind !== "system")
        return fail("Only the host can record a failed conclusion step.", "permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      const completion = assignment?.completion;
      if (!assignment || !completion || completion.phase !== "concluding" || completion.conclusion)
        return fail("No conclusion is being prepared.");
      return saveAssignment({
        ...assignment,
        completion: { ...completion, waitReason: command.reason },
      });
    }
    case "assignment.completion.plan": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("Assignment not found.", "assignment-not-found");
      if (!canLead(assignment) || !publicAllowed(assignment))
        return fail(
          "Only this team, its manager or the human can declare its delivery requirements.",
          "permission-denied",
        );
      if (
        assignment.outcome ||
        assignment.scope?.requiresPullRequest === false ||
        assignment.completion?.conclusion
      )
        return fail("This assignment cannot change its PR requirements.");
      const completion = assignment.completion ?? initialFactoryCompletion(assignment.scope);
      const plan = completion.plan;
      if (
        plan.kind !== "pull-requests" ||
        plan.version !== command.expectedVersion ||
        completion.phase !== "collecting"
      )
        return fail("The delivery requirements changed.", "stale-revision");
      if (
        command.requirements.some(
          (entry, index) =>
            entry.ref.projectId !== assignment.projectId ||
            command.requirements.some(
              (other, otherIndex) =>
                otherIndex !== index &&
                (other.id === entry.id || factorySamePullRequest(other.ref, entry.ref)),
            ),
        )
      )
        return fail("Required PR identities must be unique and belong to this project.");
      if (
        plan.requirements.some(
          (previous) =>
            !command.requirements.some(
              (next) =>
                next.id === previous.id &&
                factorySamePullRequest(previous.ref, next.ref) &&
                next.expectedHeadSha === previous.expectedHeadSha,
            ),
        )
      )
        return fail(
          "An existing PR obligation cannot be removed or silently changed; explicitly waive remaining scope.",
        );
      if (
        command.seal &&
        (command.requirements.length === 0 ||
          assignment.oversight?.progress?.remainingWork.trim() !== "")
      )
        return fail("Declare all PRs and report no remaining implementation scope before sealing.");
      return saveAssignment({
        ...assignment,
        completion: {
          ...completion,
          waitReason: null,
          plan: {
            kind: "pull-requests",
            version: plan.version + 1,
            requirements: command.requirements,
            sealed: command.seal,
          },
        },
      });
    }
    case "assignment.completion.waive": {
      if (actor.kind !== "human")
        return fail("Only the human can cancel remaining delivery scope.", "permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      const completion = assignment?.completion;
      if (
        !assignment ||
        !completion ||
        completion.plan.kind !== "pull-requests" ||
        completion.conclusion ||
        completion.phase !== "collecting"
      )
        return fail("No mutable PR manifest exists.");
      if (completion.plan.version !== command.expectedVersion)
        return fail("The manifest changed.", "stale-revision");
      const requirements = completion.plan.requirements;
      if (
        command.requirementIds.some((id) => !requirements.some((entry) => entry.id === id)) ||
        new Set(command.requirementIds).size !== command.requirementIds.length
      )
        return fail("Every waiver must name an existing unique requirement.");
      return saveAssignment({
        ...assignment,
        completion: {
          ...completion,
          waivers: [
            ...completion.waivers.filter(
              (entry) => !command.requirementIds.includes(entry.requirementId),
            ),
            ...command.requirementIds.map((requirementId) => ({
              requirementId,
              commandId: command.commandId,
              reason: command.reason,
              decidedAt: now,
            })),
          ],
        },
      });
    }
    case "assignment.completion.accept": {
      if (actor.kind !== "human")
        return fail("Only the human can accept this completion condition.", "permission-denied");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (
        !assignment ||
        assignment.scope?.requiresPullRequest !== false ||
        assignment.outcome ||
        command.condition !== assignment.scope.completionCondition ||
        !input.evidenceValidated
      )
        return fail("Acceptance must match the agreed no-PR condition and verified evidence.");
      const completion = assignment.completion ?? initialFactoryCompletion(assignment.scope);
      if (
        completion.phase !== "collecting" ||
        completion.plan.kind !== "no-pr" ||
        completion.plan.target.kind !== "human-acceptance"
      )
        return fail("This target is not awaiting human acceptance.");
      return saveAssignment({
        ...assignment,
        completion: {
          ...completion,
          acceptance: { commandId: command.commandId, evidence: command.evidence, acceptedAt: now },
        },
      });
    }
    case "assignment.completion.begin": {
      if (actor.kind !== "system")
        return fail("Only host reconciliation can freeze concluded work.", "permission-denied");
      if (state.revision !== command.expectedStateRevision)
        return fail("Assignment changed before conclusion preparation.", "stale-revision");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("Assignment not found.", "assignment-not-found");
      const completion = assignment.completion ?? initialFactoryCompletion(assignment.scope);
      if (completion.phase !== "collecting") return accept();
      const eligible = factoryCompletionEligibility(state, assignment);
      if (!eligible.eligible) return fail(eligible.reasons.join(" "));
      return saveAssignment(
        { ...assignment, completion: { ...completion, phase: "concluding", waitReason: null } },
        [{ type: "assignment.conclude", assignmentId: assignment.id }],
      );
    }
    case "assignment.completion.reopen": {
      if (actor.kind !== "system")
        return fail("Only host reconciliation can reopen a conclusion.", "permission-denied");
      if (state.revision !== command.expectedStateRevision)
        return fail("Assignment changed during conclusion preparation.", "stale-revision");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      const completion = assignment?.completion;
      if (!assignment || !completion || completion.phase !== "concluding" || completion.conclusion)
        return fail("No conclusion is being prepared.");
      let plan = completion.plan;
      if (
        command.discoveredRequirements.some((entry) => entry.ref.projectId !== assignment.projectId)
      )
        return fail("Discovered PRs do not belong to this project.");
      if (command.discoveredRequirements.length && plan.kind === "pull-requests") {
        const requirements = [...plan.requirements];
        for (const entry of command.discoveredRequirements)
          if (!requirements.some((previous) => factorySamePullRequest(previous.ref, entry.ref))) {
            if (requirements.some((previous) => previous.id === entry.id))
              return fail("Discovered requirement ID conflicts.");
            requirements.push(entry);
          }
        plan = { ...plan, version: plan.version + 1, sealed: false, requirements };
      }
      return saveAssignment({
        ...assignment,
        completion: { ...completion, phase: "collecting", waitReason: command.reason, plan },
      });
    }
    case "assignment.concluded": {
      if (actor.kind !== "system")
        return fail("Only verified host evidence can conclude an assignment.", "permission-denied");
      if (state.revision !== command.expectedStateRevision)
        return fail("Assignment changed before conclusion was sealed.", "stale-revision");
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment?.completion || assignment.completion.phase !== "concluding")
        return fail("The implementation must be frozen before concluding.");
      const eligible = factoryCompletionEligibility(state, assignment);
      if (!eligible.eligible) return fail(eligible.reasons.join(" "));
      const disposition = conclusionDisposition(command.conclusion);
      if (stableStringify(disposition) !== stableStringify(eligible.disposition))
        return fail(
          "The conclusion does not match all current required deliveries.",
          "stale-revision",
        );
      if (
        state.retros.some((entry) => entry.assignmentId === assignment.id) ||
        state.auxiliaryThreads.some((entry) => entry.threadId === command.retroThreadId)
      )
        return fail("The assignment already has a retrospective identity.");
      if (
        assignment.modelPolicy &&
        !isFactoryModelApproved(assignment.modelPolicy, command.modelSelection)
      )
        return fail("The retrospective model is outside the approved pool.", "permission-denied");
      const retro: FactoryRetro = {
        id: factoryRetroId(assignment.id),
        assignmentId: assignment.id,
        conclusionId: command.conclusion.id,
        evidenceDigest: command.conclusion.evidenceDigest,
        threadId: command.retroThreadId,
        modelSelection: command.modelSelection,
        execution: { status: "preparing" },
        reports: { phase: "team-pending" },
        createdAt: now,
        updatedAt: now,
      };
      return saveAssignment(
        {
          ...assignment,
          completion: {
            ...assignment.completion,
            phase: "concluded",
            conclusion: command.conclusion,
          },
          status: assignment.outcome ? assignment.status : "waiting",
          wait: assignment.outcome
            ? assignment.wait
            : {
                kind: "delivered",
                reason: "Delivery concluded. Team and manager retrospectives remain pending.",
              },
        },
        [{ type: "retro.launch", retroId: retro.id }],
        {
          retros: [...state.retros, retro],
          auxiliaryThreads: [
            ...state.auxiliaryThreads,
            {
              threadId: retro.threadId,
              assignmentId: assignment.id,
              managerId: assignment.managerId,
              projectId: assignment.projectId,
              kind: "retrospective",
              incidentId: retro.id,
              cycle: 0,
              status: "pending",
              modelSelection: retro.modelSelection,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      );
    }
    case "finding.report": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment || !ownEvidence(assignment) || !publicAllowed(assignment))
        return fail(
          "Findings must belong to the authenticated team or its manager.",
          "permission-denied",
        );
      if (!input.evidenceValidated || !ownerInScope(command.finding.route.owner, assignment))
        return fail("The finding needs verified scoped evidence and an accountable owner.");
      if (state.findings.some((entry) => entry.id === command.findingId))
        return fail("This finding already exists.", "command-conflict");
      if (
        command.finding.containmentOf !== null &&
        !state.findings.some(
          (entry) =>
            entry.id === command.finding.containmentOf && entry.assignmentId === assignment.id,
        )
      )
        return fail("Containment must reference an existing scoped finding.");
      const finding: FactoryFinding = {
        ...command.finding,
        id: command.findingId,
        assignmentId: assignment.id,
        reporterThreadId: actor.kind === "thread" ? actor.threadId : null,
        history: [],
        escalation: null,
        createdAt: now,
        updatedAt: now,
      };
      return accept({ findings: [...state.findings, finding] }, [], {
        findingId: finding.id,
        assignmentId: assignment.id,
      });
    }
    case "finding.route":
    case "finding.escalate": {
      const finding = state.findings.find((entry) => entry.id === command.findingId);
      const assignment = state.assignments.find((entry) => entry.id === finding?.assignmentId);
      if (!finding || !assignment) return fail("Finding not found.");
      if (
        !(command.type === "finding.route" ? canManage(assignment) : canLead(assignment)) ||
        !publicAllowed(assignment)
      )
        return fail("This actor cannot route the finding.", "permission-denied");
      if (command.type === "finding.route" && !ownerInScope(command.route.owner, assignment))
        return fail("The owner is outside this project's remit.");
      const updated: FactoryFinding =
        command.type === "finding.route"
          ? {
              ...finding,
              route: command.route,
              history: [
                ...finding.history,
                { route: finding.route, commandId: command.commandId, recordedAt: now },
              ],
              updatedAt: now,
            }
          : {
              ...finding,
              escalation: finding.escalation ?? {
                summary: command.summary,
                commandId: command.commandId,
                escalatedAt: now,
              },
              updatedAt: now,
            };
      return accept(
        { findings: state.findings.map((entry) => (entry.id === finding.id ? updated : entry)) },
        [],
        { findingId: finding.id },
      );
    }
    case "retro.prepared":
    case "retro.started":
    case "retro.failed":
    case "retro.stopped": {
      if (actor.kind !== "system")
        return fail("Only the host can record retrospective execution.", "permission-denied");
      const retro = state.retros.find((entry) => entry.id === command.retroId);
      if (!retro) return fail("Retrospective not found.");
      if (command.type === "retro.failed") {
        if (
          command.expectedStateRevision !== undefined &&
          command.expectedStateRevision !== state.revision
        )
          return fail(
            "The retrospective changed before terminal observation was recorded.",
            "stale-revision",
          );
        if (retro.reports.phase !== "team-pending") return accept();
      }
      if (retro.reports.phase === "complete" && command.type !== "retro.stopped")
        return fail("The retrospective is already complete.");
      const execution: FactoryRetro["execution"] =
        command.type === "retro.prepared"
          ? {
              status: "ready",
              qualification: command.qualification,
              sourceDigest: command.sourceDigest,
              launch: "pending",
            }
          : command.type === "retro.failed"
            ? { status: "failed", reason: command.reason }
            : command.type === "retro.stopped"
              ? { status: "stopped" }
              : retro.execution.status === "ready"
                ? { ...retro.execution, launch: "delivered" }
                : retro.execution;
      if (command.type === "retro.started" && execution.status !== "ready")
        return fail("The read-only retrospective profile is not prepared.");
      return saveRetro({ ...retro, execution }, [], {
        auxiliaryThreads: state.auxiliaryThreads.map((entry) =>
          entry.threadId !== retro.threadId
            ? entry
            : {
                ...entry,
                status:
                  command.type === "retro.failed"
                    ? "failed"
                    : command.type === "retro.stopped"
                      ? "complete"
                      : command.type === "retro.started"
                        ? "running"
                        : "pending",
                ...(execution.status === "ready"
                  ? { qualification: execution.qualification, sourceDigest: execution.sourceDigest }
                  : {}),
                updatedAt: now,
              },
        ),
      });
    }
    case "retro.retry": {
      const retro = state.retros.find((entry) => entry.id === command.retroId);
      const assignment = state.assignments.find((entry) => entry.id === retro?.assignmentId);
      if (!retro || !assignment || !canLead(assignment) || !publicAllowed(assignment))
        return fail("This actor cannot retry the retrospective.", "permission-denied");
      if (retro.reports.phase === "complete") return fail("The retrospective is already complete.");
      if (retro.reports.phase === "manager-pending")
        return saveRetro(retro, [
          {
            type: "retro.manager-notify",
            retroId: retro.id,
            teamReportDigest: retro.reports.team.digest,
          },
        ]);
      return saveRetro(
        { ...retro, execution: { status: "preparing" } },
        [{ type: "retro.launch", retroId: retro.id }],
        {
          auxiliaryThreads: state.auxiliaryThreads.map((entry) =>
            entry.threadId === retro.threadId
              ? { ...entry, status: "pending", updatedAt: now }
              : entry,
          ),
        },
      );
    }
    case "retro.team.submit": {
      const retro = state.retros.find((entry) => entry.id === command.retroId);
      const assignment = state.assignments.find((entry) => entry.id === retro?.assignmentId);
      if (
        !retro ||
        !assignment ||
        !(
          actor.kind === "human" ||
          (actor.kind === "thread" && actor.threadId === retro.threadId)
        ) ||
        !publicAllowed(assignment)
      )
        return fail(
          "Only the designated retrospective lead can submit the team report.",
          "permission-denied",
        );
      if (actor.kind === "thread" && retro.execution.status !== "ready")
        return fail(
          "The designated read-only retrospective session is not ready.",
          "permission-denied",
        );
      if (
        retro.reports.phase !== "team-pending" ||
        retro.conclusionId !== command.conclusionId ||
        !input.evidenceValidated ||
        !validLearning(assignment.id, command.report.learning)
      )
        return fail("The report must match the current conclusion and scoped evidence.");
      const eligibility = factoryCompletionEligibility(state, assignment);
      if (
        !eligibility.eligible ||
        !assignment.completion?.conclusion ||
        stableStringify(eligibility.disposition) !==
          stableStringify(conclusionDisposition(assignment.completion.conclusion))
      )
        return fail("The assignment's delivery disposition changed.", "stale-revision");
      const report = {
        ...command.report,
        digest: hash({ conclusionId: retro.conclusionId, report: command.report, actor }),
        commandId: command.commandId,
        submittedBy: actor.kind === "thread" ? actor.threadId : null,
        submittedAt: now,
      };
      return saveRetro({ ...retro, reports: { phase: "manager-pending", team: report } }, [
        { type: "retro.manager-notify", retroId: retro.id, teamReportDigest: report.digest },
      ]);
    }
    case "retro.manager.submit": {
      const retro = state.retros.find((entry) => entry.id === command.retroId);
      const assignment = state.assignments.find((entry) => entry.id === retro?.assignmentId);
      if (!retro || !assignment || !canManage(assignment) || !publicAllowed(assignment))
        return fail(
          "Only the commissioning manager or human can conclude this retrospective.",
          "permission-denied",
        );
      if (
        retro.reports.phase !== "manager-pending" ||
        retro.reports.team.digest !== command.teamReportDigest ||
        !validLearning(assignment.id, command.report.learning)
      )
        return fail("The exact team report must precede the manager report.", "stale-revision");
      const eligibility = factoryCompletionEligibility(state, assignment);
      if (
        !eligibility.eligible ||
        !assignment.completion?.conclusion ||
        stableStringify(eligibility.disposition) !==
          stableStringify(conclusionDisposition(assignment.completion.conclusion))
      )
        return fail("The assignment's delivery disposition changed.", "stale-revision");
      const findings = state.findings.filter((entry) => entry.assignmentId === assignment.id);
      if (
        findings.some(
          (finding) => !command.report.dispositions.some((entry) => entry.findingId === finding.id),
        ) ||
        command.report.dispositions.some(
          (entry, index) =>
            !findings.some((finding) => finding.id === entry.findingId) ||
            command.report.dispositions.some(
              (other, otherIndex) => index !== otherIndex && other.findingId === entry.findingId,
            ) ||
            ((entry.kind === "investigate" || entry.kind === "shared-proposal") &&
              !ownerInScope(entry.owner, assignment)) ||
            (entry.kind === "ticket" &&
              !state.followups.some(
                (followup) =>
                  followup.id === entry.followupId &&
                  followup.assignmentId === assignment.id &&
                  followup.findingIds.includes(entry.findingId),
              )),
        )
      )
        return fail("Every finding needs one valid disposition and owner or follow-up.");
      if (
        command.report.dispositions.some(
          (entry) =>
            entry.kind === "existing-ticket" &&
            !state.followups.some((followup) => {
              if (
                followup.assignmentId !== assignment.id ||
                !followup.findingIds.includes(entry.findingId)
              )
                return false;
              const publication = followup.publication;
              const issue =
                publication.status === "linked"
                  ? publication.issue
                  : publication.status === "recorded" &&
                      publication.receipt.progress.status === "triaged"
                    ? publication.receipt.progress.issue
                    : undefined;
              return issue !== undefined && stableStringify(issue) === stableStringify(entry.issue);
            }),
        )
      )
        return fail("Existing tickets must first be verified through a scoped follow-up link.");
      const report = {
        ...command.report,
        digest: hash({ teamReportDigest: command.teamReportDigest, report: command.report, actor }),
        commandId: command.commandId,
        submittedBy: actor.kind === "thread" ? actor.threadId : null,
        submittedAt: now,
        teamReportDigest: command.teamReportDigest,
      };
      return saveRetro(
        { ...retro, reports: { phase: "complete", team: retro.reports.team, manager: report } },
        [{ type: "retro.stop", retroId: retro.id }],
        {
          assignments: state.assignments.map((entry) =>
            entry.id === assignment.id
              ? { ...entry, status: "complete", wait: null, updatedAt: now }
              : entry,
          ),
        },
      );
    }
    case "project.tracker.configure": {
      if (actor.kind !== "human")
        return fail(
          "Tracker publication destinations require human configuration.",
          "permission-denied",
        );
      const current = activeTracker(command.projectId);
      if ((current?.id ?? null) !== command.expectedTrackerId)
        return fail("The tracker configuration changed.", "stale-revision");
      if (
        !input.qualifiedTracker ||
        input.qualifiedTracker.projectId !== command.projectId ||
        stableStringify(input.qualifiedTracker.destination) !== stableStringify(command.destination)
      )
        return fail("Validate the owning environment's tracker and triage destination first.");
      return accept({
        projectTrackers: [
          ...state.projectTrackers,
          {
            id: `tracker:${command.commandId}`,
            projectId: command.projectId,
            destination: input.qualifiedTracker,
            approvedBy: command.commandId,
            approvedAt: now,
          },
        ],
      });
    }
    case "followup.request": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment || !canLead(assignment) || !publicAllowed(assignment))
        return fail(
          "Only this lead, manager or human can request a scoped follow-up.",
          "permission-denied",
        );
      if (state.followups.some((entry) => entry.id === command.followupId))
        return fail("The follow-up already exists.", "command-conflict");
      const findings = command.findingIds.map((id) =>
        state.findings.find((entry) => entry.id === id && entry.assignmentId === assignment.id),
      );
      if (
        !findings.length ||
        findings.some(
          (entry) =>
            entry === undefined ||
            !["implementation", "project"].includes(entry.route.suspectedCause),
        ) ||
        command.draft.origin.assignmentId !== assignment.id ||
        stableStringify([...command.draft.origin.findingIds].sort()) !==
          stableStringify([...command.findingIds].sort()) ||
        (command.draft.containmentOf !== null &&
          !findings.some((entry) => entry?.containmentOf === command.draft.containmentOf))
      )
        return fail(
          "Project tickets need local findings or explicit local containment and matching origin evidence.",
        );
      const tracker = activeTracker(assignment.projectId);
      const followup: FactoryFollowup = {
        id: command.followupId,
        assignmentId: assignment.id,
        projectId: assignment.projectId,
        findingIds: command.findingIds,
        draft: command.draft,
        error: null,
        existingIssue: null,
        publication: tracker
          ? {
              status: "requested",
              trackerId: tracker.id,
              requestId: `factory-followup:${command.followupId}`,
            }
          : {
              status: "configuration-required",
              reason: "Configure this project's approved tracker and triage destination.",
            },
        createdAt: now,
        updatedAt: now,
      };
      return saveFollowup(
        followup,
        tracker ? [{ type: "followup.publish", followupId: followup.id }] : [],
      );
    }
    case "followup.retry":
    case "followup.link-existing": {
      const followup = state.followups.find((entry) => entry.id === command.followupId);
      const assignment = state.assignments.find((entry) => entry.id === followup?.assignmentId);
      if (!followup || !assignment || !canLead(assignment) || !publicAllowed(assignment))
        return fail("This actor cannot retry or link that follow-up.", "permission-denied");
      if (
        followup.publication.status === "linked" ||
        (followup.publication.status === "recorded" &&
          followup.publication.receipt.progress.status === "triaged")
      )
        return accept();
      if (command.type === "followup.link-existing") {
        const progress =
          followup.publication.status === "recorded"
            ? followup.publication.receipt.progress
            : undefined;
        if (progress?.status === "outcome-unknown" && actor.kind !== "human")
          return fail(
            "Only the human can resolve an unknown publication by selecting an existing ticket.",
            "permission-denied",
          );
        if (followup.publication.status === "requested" && followup.existingIssue === null)
          return fail("Reconcile the reserved publication before linking a different ticket.");
        if (
          progress &&
          "issue" in progress &&
          stableStringify(progress.issue) !== stableStringify(command.issue)
        )
          return fail("A created ticket cannot be replaced by a different issue.");
        if (
          followup.existingIssue !== null &&
          stableStringify(followup.existingIssue) !== stableStringify(command.issue)
        )
          return fail("Retry the selected existing issue; do not silently replace its identity.");
        let publication = followup.publication;
        if (publication.status === "configuration-required") {
          const tracker = activeTracker(assignment.projectId);
          if (!tracker)
            return fail(
              "Configure this project's approved tracker before linking an existing ticket.",
            );
          publication = {
            status: "requested",
            trackerId: tracker.id,
            requestId: `factory-followup:${followup.id}`,
          };
        }
        return saveFollowup(
          { ...followup, error: null, existingIssue: command.issue, publication },
          [{ type: "followup.link", followupId: followup.id, issue: command.issue }],
        );
      }
      const effect: FactoryEffectIntent =
        followup.existingIssue === null
          ? { type: "followup.publish", followupId: followup.id }
          : { type: "followup.link", followupId: followup.id, issue: followup.existingIssue };
      if (followup.publication.status === "configuration-required") {
        const tracker = activeTracker(assignment.projectId);
        if (!tracker) return fail("Configure this project's tracker first.");
        return saveFollowup(
          {
            ...followup,
            error: null,
            publication: {
              status: "requested",
              trackerId: tracker.id,
              requestId: `factory-followup:${followup.id}`,
            },
          },
          [effect],
        );
      }
      return saveFollowup({ ...followup, error: null }, [effect]);
    }
    case "followup.failed": {
      if (actor.kind !== "system")
        return fail(
          "Only the tracker adapter can record publication failures.",
          "permission-denied",
        );
      const followup = state.followups.find((entry) => entry.id === command.followupId);
      if (!followup) return fail("Follow-up not found.");
      return saveFollowup({ ...followup, error: command.reason });
    }
    case "followup.publication.recorded": {
      if (actor.kind !== "system")
        return fail("Only the tracker adapter can confirm publication.", "permission-denied");
      const followup = state.followups.find((entry) => entry.id === command.followupId);
      if (
        !followup ||
        (followup.publication.status !== "requested" && followup.publication.status !== "recorded")
      )
        return fail("No tracker publication is reserved.");
      const publication = followup.publication;
      const tracker = state.projectTrackers.find((entry) => entry.id === publication.trackerId);
      const requestId =
        publication.status === "requested" ? publication.requestId : publication.receipt.requestId;
      if (
        !tracker ||
        requestId !== command.receipt.requestId ||
        stableStringify(tracker.destination) !== stableStringify(command.receipt.destination)
      )
        return fail("The receipt belongs to another publication destination.");
      if (publication.status === "recorded") {
        const previous = publication.receipt;
        if (
          previous.requestDigest !== command.receipt.requestDigest ||
          (previous.progress.status === "triaged" && command.receipt.progress.status !== "triaged")
        )
          return fail(
            "A publication receipt cannot change its request or regress confirmed triage.",
          );
        if (
          "issue" in previous.progress &&
          (!("issue" in command.receipt.progress) ||
            stableStringify(previous.progress.issue) !==
              stableStringify(command.receipt.progress.issue))
        )
          return fail("A known published issue identity must be preserved.");
      }
      return saveFollowup({
        ...followup,
        error: null,
        publication: { status: "recorded", trackerId: tracker.id, receipt: command.receipt },
      });
    }
    case "followup.linked": {
      if (actor.kind !== "system")
        return fail(
          "Only the tracker adapter can confirm an existing ticket.",
          "permission-denied",
        );
      const followup = state.followups.find((entry) => entry.id === command.followupId);
      if (!followup) return fail("Follow-up not found.");
      if (followup.existingIssue === null || command.receipt.progress.status !== "triaged")
        return fail("An existing ticket link needs a selected issue and verified triage receipt.");
      const publication = followup.publication;
      if (publication.status !== "requested" && publication.status !== "recorded")
        return fail("No tracker publication is reserved for this link.");
      const tracker = state.projectTrackers.find((entry) => entry.id === publication.trackerId);
      const requestId =
        publication.status === "requested" ? publication.requestId : publication.receipt.requestId;
      if (
        !tracker ||
        requestId !== command.receipt.requestId ||
        stableStringify(tracker.destination) !== stableStringify(command.receipt.destination) ||
        stableStringify(followup.existingIssue) !== stableStringify(command.receipt.progress.issue)
      )
        return fail("The triage receipt belongs to another selected issue or destination.");
      return saveFollowup({
        ...followup,
        error: null,
        publication: {
          status: "linked",
          issue: command.receipt.progress.issue,
          verifiedAt: command.receipt.progress.verifiedAt,
        },
      });
    }
    default:
      return undefined;
  }
}
