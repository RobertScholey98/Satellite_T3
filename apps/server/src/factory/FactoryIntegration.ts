import {
  FactoryError,
  type FactoryAssignment,
  type FactoryAssignmentId,
  type FactoryBoundary,
  type FactoryWorkflowVersion,
  type FactoryCommandResult,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryIntegration,
  type FactoryIntegrationGrant,
  type FactoryIntegrationManifest,
  type FactoryIntegrationMessage,
  type FactoryIntegrationPaths,
  type FactoryIntegrationPreparation,
  type FactoryIntegrationTestArtifact,
  type FactorySnapshot,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { commissionFactoryAssignment } from "./FactoryAssignmentCommission.ts";
import {
  factoryPathWithin,
  factoryProtectedPath,
  factoryRelativePath,
} from "./FactoryBoundaryPaths.ts";
import {
  factoryIncidentBlocked,
  factoryRequestParticipants,
  retainDeliveredMessages,
} from "./FactoryCollaboration.ts";
import { resolveManagerPolicy } from "./FactoryPolicy.ts";
import { factorySamePullRequest } from "./FactoryRetros.ts";
import type { FactoryActor, FactoryAllocation, FactoryDecision } from "./FactoryState.ts";

/**
 * Facts the service resolves before deciding. For `integration.file.mutate` and
 * `integration.verify` from a thread, `integrationActorAssignmentId` is the assignment that
 * thread belongs to, so a team thread other than the lead can use the prepared workspace.
 */
export interface FactoryIntegrationContext {
  readonly integrationActorAssignmentId?: FactoryAssignmentId;
}

/** Still doing work. An assignment that is collecting its completion still counts. */
const active = (assignment: FactoryAssignment | undefined): assignment is FactoryAssignment =>
  assignment !== undefined &&
  assignment.outcome === undefined &&
  assignment.status !== "complete" &&
  (assignment.completion === undefined || assignment.completion.phase === "collecting");
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  a.every((value) => b.includes(value));
/** A root of `.` contains every path. */
const contains = (roots: readonly string[], value: string) =>
  roots.some((root) => root === "." || root === value || factoryPathWithin(value, root));
const writable = (paths: FactoryIntegrationPaths) => [
  ...paths.testPaths,
  ...paths.fixturePaths,
  ...paths.testDirectories,
  ...paths.fixtureDirectories,
];
/**
 * Whether a grant asks for no more than a capability classifies. An exact test or fixture file
 * may also sit under a classified directory of the same kind.
 */
const pathsWithin = (paths: FactoryIntegrationPaths, limits: FactoryIntegrationPaths) =>
  paths.readPaths.every((path) => contains(limits.readPaths, path)) &&
  paths.testPaths.every(
    (path) => limits.testPaths.includes(path) || contains(limits.testDirectories, path),
  ) &&
  paths.fixturePaths.every(
    (path) => limits.fixturePaths.includes(path) || contains(limits.fixtureDirectories, path),
  ) &&
  paths.testDirectories.every((path) => contains(limits.testDirectories, path)) &&
  paths.fixtureDirectories.every((path) => contains(limits.fixtureDirectories, path));
/**
 * Whether a test and fixture classification fits the project's approved boundary. Every write
 * path must be readable, already writable or creatable in the boundary, and clear of protected
 * paths in either direction, ignoring case. A path is a test or a fixture, never both, and no
 * write path repeats ignoring case.
 */
const validPaths = (paths: FactoryIntegrationPaths, boundary: FactoryBoundary) => {
  const writes = writable(paths);
  const protectedPaths = [...boundary.protectedPaths, ...(boundary.protectedCreatablePaths ?? [])];
  return (
    paths.readPaths.length > 0 &&
    paths.readPaths.every((path) => path === "." || factoryRelativePath(path)) &&
    writes.every(
      (path) =>
        factoryRelativePath(path) &&
        !factoryProtectedPath(path) &&
        contains(paths.readPaths, path) &&
        !protectedPaths.some(
          (protectedPath) =>
            path.toLowerCase() === protectedPath.toLowerCase() ||
            factoryPathWithin(path.toLowerCase(), protectedPath.toLowerCase()) ||
            factoryPathWithin(protectedPath.toLowerCase(), path.toLowerCase()),
        ),
    ) &&
    [...paths.testPaths, ...paths.fixturePaths].every(
      (path) =>
        boundary.writablePaths.includes(path) || contains(boundary.creatableDirectories, path),
    ) &&
    [...paths.testDirectories, ...paths.fixtureDirectories].every((path) =>
      contains(boundary.creatableDirectories, path),
    ) &&
    !paths.testPaths.some(
      (path) => paths.fixturePaths.includes(path) || contains(paths.fixtureDirectories, path),
    ) &&
    !paths.fixturePaths.some((path) => contains(paths.testDirectories, path)) &&
    !paths.testDirectories.some(
      (path) =>
        contains(paths.fixtureDirectories, path) ||
        paths.fixtureDirectories.some((other) => factoryPathWithin(other, path)),
    ) &&
    new Set(writes.map((path) => path.toLowerCase())).size === writes.length
  );
};

/**
 * The participant assignments that still exist. A list shorter than
 * `participantAssignmentIds` means a participant was removed, which blocks access.
 */
export function factoryIntegrationParticipants(
  state: FactorySnapshot,
  integrationId: string,
): readonly FactoryAssignment[] {
  const integration = state.integrations.find((entry) => entry.id === integrationId);
  return integration
    ? state.assignments.filter((entry) => integration.participantAssignmentIds.includes(entry.id))
    : [];
}

/** Requested and revoked grants carry no authority; only active ones count. */
const currentGrants = (state: FactorySnapshot, integrationId: string) =>
  state.integrationGrants.filter(
    (entry) => entry.integrationId === integrationId && entry.lifecycle.phase === "active",
  );

/**
 * Why the integration team may not run now, or `null` when it may. The team and every
 * participant must be active, free of execution incidents, authority holds and project pauses.
 * Every request must still be accepted with all its participants inside the integration. Each
 * participant needs exactly one active grant from its own project's manager, on a current
 * qualified capability in that manager's boundary, and the coordinator project's capability
 * needs a qualified protected runner. The decider, the reconciler, the effect handlers and
 * runtime admission all ask this, so a new blocking condition belongs here.
 */
export function factoryIntegrationAccessBlocked(
  state: FactorySnapshot,
  integrationId: string,
): string | null {
  const integration = state.integrations.find((entry) => entry.id === integrationId);
  if (!integration) return "The integration assignment no longer exists.";
  const team = state.assignments.find((entry) => entry.id === integration.assignmentId);
  const participants = factoryIntegrationParticipants(state, integrationId);
  if (
    !active(team) ||
    participants.length !== integration.participantAssignmentIds.length ||
    participants.some((entry) => !active(entry))
  )
    return "An integration participant or the integration team has concluded or been cancelled.";
  if (
    integration.requestIds.some((id) => {
      const request = state.crossProjectRequests.find((entry) => entry.id === id);
      return (
        !request ||
        request.lifecycle.phase !== "accepted" ||
        factoryRequestParticipants(state, request).some(
          (entry) => !integration.participantAssignmentIds.includes(entry.id),
        )
      );
    })
  )
    return "A participating request is no longer active.";
  for (const assignment of [...participants, team]) {
    const restriction = factoryIncidentBlocked(state, assignment.id, "execution");
    if (restriction) return restriction;
    if (assignment.wait?.kind === "authority")
      return "A participating team's execution authority is held.";
    if (
      state.controls.some(
        (entry) =>
          entry.kind === "project-pause" &&
          entry.status === "active" &&
          entry.projectId === assignment.projectId,
      )
    )
      return "A participating project is paused.";
  }
  const grants = currentGrants(state, integrationId);
  for (const participant of participants) {
    const matches = grants.filter(
      (entry) =>
        entry.participantAssignmentId === participant.id &&
        entry.projectId === participant.projectId &&
        entry.ownerManagerId === participant.managerId,
    );
    if (matches.length !== 1)
      return `Project ${participant.projectId} needs its owner's integration grant.`;
    const grant = matches[0]!;
    const capability = state.integrationCapabilities.find(
      (entry) => entry.id === grant.capabilityId,
    );
    const owner = state.managers.find((entry) => entry.id === grant.ownerManagerId);
    if (
      !capability ||
      capability.supersededBy !== null ||
      capability.qualification.status !== "qualified" ||
      capability.boundaryId !== grant.boundaryId ||
      owner?.boundaryId !== grant.boundaryId ||
      participant.grant?.boundaryId !== grant.boundaryId
    )
      return `Project ${participant.projectId} needs a current qualified integration capability.`;
  }
  const coordinator = grants.find((entry) => entry.projectId === integration.coordinatorProjectId);
  const capability = state.integrationCapabilities.find(
    (entry) => entry.id === coordinator?.capabilityId,
  );
  if (
    !capability?.coordinator ||
    capability.qualification.status !== "qualified" ||
    !capability.qualification.coordinatorDigest
  )
    return "The coordinator project needs a qualified protected runner.";
  return null;
}

/**
 * Agreed technical plans on this integration's requests whose participants still match their
 * assignments' lead thread, grant epoch and scope. Sorted, so a manifest records the exact plan
 * set it was prepared against.
 */
export function factoryIntegrationPlanIds(
  state: FactorySnapshot,
  integrationId: string,
): readonly string[] {
  const integration = state.integrations.find((entry) => entry.id === integrationId);
  if (!integration) return [];
  return state.collaborationPlans
    .filter(
      (plan) =>
        plan.phase === "agreed" &&
        plan.changes.kind === "technical" &&
        plan.requestIds.some((id) => integration.requestIds.includes(id)) &&
        plan.participants.every((participant) => {
          const assignment = state.assignments.find(
            (entry) => entry.id === participant.assignmentId,
          );
          return (
            assignment?.threadId === participant.threadId &&
            assignment.grant?.epoch === participant.grantEpoch &&
            JSON.stringify(assignment.scope) === JSON.stringify(participant.scope)
          );
        }),
    )
    .map((entry) => entry.id)
    .sort();
}

/**
 * Why a prepared manifest no longer describes current work; empty while it still does. It goes
 * stale when the participant set, the agreed plans, the coordinator, or a participant's current
 * revision, lead, grant, capability or published head changes. An unpublished input also goes
 * stale once its revision is published, so evidence is always taken against the published
 * bytes. Execution checks it again around each isolated step.
 */
export function factoryIntegrationManifestReasons(
  state: FactorySnapshot,
  integrationId: string,
  manifest: FactoryIntegrationManifest,
): readonly string[] {
  const reasons: string[] = [];
  const participants = factoryIntegrationParticipants(state, integrationId);
  const grants = currentGrants(state, integrationId);
  if (
    !sameSet(
      manifest.inputs.map((entry) => entry.assignmentId),
      participants.map((entry) => entry.id),
    )
  )
    reasons.push("The participant set changed.");
  if (!sameSet(manifest.planIds, factoryIntegrationPlanIds(state, integrationId)))
    reasons.push("The agreed technical plan changed.");
  for (const input of manifest.inputs) {
    const assignment = participants.find((entry) => entry.id === input.assignmentId);
    const revision = assignment?.delivery?.revisions.find(
      (entry) => entry.id === assignment.delivery?.currentRevisionId,
    );
    const grant = grants.find((entry) => entry.id === input.integrationGrantId);
    if (
      !assignment ||
      !revision ||
      revision.id !== input.revisionId ||
      revision.candidateId !== input.candidateId ||
      revision.candidateDigest !== input.candidateDigest ||
      assignment.threadId !== input.leadThreadId ||
      assignment.projectId !== input.projectId ||
      assignment.grant?.epoch !== input.grantEpoch ||
      assignment.grant.boundaryId !== input.boundaryId ||
      !grant ||
      grant.capabilityId !== input.capabilityId ||
      grant.participantAssignmentId !== input.assignmentId
    )
      reasons.push(`Project ${input.projectId} has different source or authority.`);
    const publication = input.publication;
    if (publication.kind === "published-head") {
      if (
        revision?.status !== "published" ||
        !revision.publication?.ref ||
        !factorySamePullRequest(publication.ref, revision.publication.ref) ||
        publication.headSha !== revision.publication.headSha ||
        publication.treeOid !== revision.publication.treeOid ||
        publication.baseSha !== revision.hostEvidence?.baseSha
      )
        reasons.push(`Project ${input.projectId} has different published bytes.`);
    } else if (revision?.status === "published")
      reasons.push(`Project ${input.projectId} now has a published revision to verify.`);
  }
  const coordinator = state.integrationCapabilities.find(
    (entry) => entry.id === manifest.coordinatorCapabilityId,
  );
  const integration = state.integrations.find((entry) => entry.id === integrationId);
  if (
    coordinator?.projectId !== integration?.coordinatorProjectId ||
    coordinator?.qualification.status !== "qualified" ||
    coordinator.qualification.coordinatorDigest !== manifest.coordinatorDigest ||
    coordinator.supersededBy !== null
  )
    reasons.push("The protected coordinator changed.");
  return [...new Set(reasons)];
}

/**
 * The latest combined verification as merge groups and the integration thread see it. A current
 * blocker, a stale manifest, a newer preparation or a changed test artifact makes it `stale`
 * whatever the run recorded, so `passed` means a passing run on inputs that are still current.
 * `published` is true only when every verified input was a published head.
 */
export function factoryIntegrationVerificationReadiness(
  state: FactorySnapshot,
  integrationId: string,
): {
  status: "missing" | "running" | "failed" | "stale" | "passed";
  verificationId: string | null;
  reasons: readonly string[];
  published: boolean;
} {
  const integration = state.integrations.find((entry) => entry.id === integrationId);
  const verification = state.integrationVerifications.findLast(
    (entry) => entry.integrationId === integrationId,
  );
  const missing = {
    status: "missing" as const,
    verificationId: null,
    reasons: ["Run combined verification against the prepared inputs."],
    published: false,
  };
  if (!integration || !verification) return missing;
  const preparation = state.integrationPreparations.find(
    (entry) => entry.id === verification.preparationId,
  );
  const phase = verification.lifecycle;
  const manifest =
    preparation?.lifecycle.phase === "ready" ? preparation.lifecycle.manifest : undefined;
  const blocked = factoryIntegrationAccessBlocked(state, integrationId);
  const reasons = [
    ...(blocked ? [blocked] : []),
    ...(manifest
      ? factoryIntegrationManifestReasons(state, integrationId, manifest)
      : ["The preparation is unavailable."]),
    ...(integration.currentPreparationId !== verification.preparationId
      ? ["New inputs were prepared."]
      : []),
  ];
  if (
    phase.phase === "completed" &&
    state.integrationTestArtifacts.find((entry) => entry.id === integration.currentTestArtifactId)
      ?.digest !== phase.testArtifactDigest
  )
    reasons.push("The recorded test and fixture artifact changed.");
  const base = {
    verificationId: verification.id,
    reasons,
    published:
      manifest?.inputs.every((entry) => entry.publication.kind === "published-head") ?? false,
  };
  if (reasons.length) return { ...base, status: "stale" };
  if (phase.phase === "requested") return { ...base, status: "running" };
  if (phase.phase === "failed") return { ...base, status: "failed", reasons: [phase.reason] };
  return {
    ...base,
    status: phase.result === "passed" ? "passed" : "failed",
    reasons: phase.result === "passed" ? [] : ["The protected combined verification did not pass."],
  };
}

/** Tells the requester, every participant's manager and the integration team. */
const notice = (
  integration: FactoryIntegration,
  eventId: string,
  text: string,
  state: FactorySnapshot,
): FactoryEffectIntent => ({
  type: "integration.notify",
  integrationId: integration.id,
  eventId,
  recipientManagerIds: [
    ...new Set([
      integration.requesterManagerId,
      ...factoryIntegrationParticipants(state, integration.id).map((entry) => entry.managerId),
    ]),
  ],
  recipientAssignmentIds: [integration.assignmentId],
  text,
});

/**
 * Runs after every accepted factory decision. Integrations that existed before the command
 * notify their managers and team when the agreed plans or a participant's captured source
 * changed. Any preparing or ready integration whose access is now blocked is held: it becomes
 * `blocked`, its team waits, and `integration.stop` shuts its runtime down. Commands that remove
 * access elsewhere, such as a grant revocation or a project pause, rely on this hold rather
 * than stopping the integration themselves.
 */
export function reconcileFactoryIntegrations(
  decision: FactoryDecision,
  now: string,
  previousState?: FactorySnapshot,
): FactoryDecision {
  const state = decision.state;
  const effects = [...decision.effects];
  const holds = new Map<string, FactoryIntegration>();
  for (const integration of state.integrations) {
    // A newly commissioned integration has no earlier plans or sources to compare with.
    if (previousState?.integrations.some((entry) => entry.id === integration.id)) {
      const plans = (snapshot: FactorySnapshot) =>
        snapshot.collaborationPlans
          .filter(
            (entry) =>
              entry.requestIds.some((id) => integration.requestIds.includes(id)) &&
              (entry.phase === "agreed" || entry.phase === "superseded"),
          )
          .map((entry) => `${entry.id}:${entry.phase}`)
          .sort();
      const sources = (snapshot: FactorySnapshot) =>
        factoryIntegrationParticipants(snapshot, integration.id)
          .map(
            (entry) =>
              `${entry.id}:${entry.threadId}:${entry.grant?.epoch}:${entry.delivery?.currentRevisionId}:${entry.delivery?.revisions.find((revision) => revision.id === entry.delivery?.currentRevisionId)?.status}`,
          )
          .sort();
      if (!sameSet(plans(previousState), plans(state)))
        effects.push(
          notice(
            integration,
            `plans:${state.revision}`,
            "A recorded shared technical plan changed. Review it and refresh integration inputs before relying on combined evidence.",
            state,
          ),
        );
      if (!sameSet(sources(previousState), sources(state)))
        effects.push(
          notice(
            integration,
            `inputs:${state.revision}`,
            "A participant's captured revision, publication or lead changed. Refresh the immutable integration inputs before verifying the new work.",
            state,
          ),
        );
    }
    // `awaiting-grants` has no runtime to stop yet, and `blocked` is already held.
    if (integration.phase === "awaiting-grants" || integration.phase === "blocked") continue;
    const reason = factoryIntegrationAccessBlocked(state, integration.id);
    if (!reason) continue;
    // The revision makes each hold distinct, so stop receipts for an older hold are refused.
    const holdId = `integration-hold:${integration.id}:${state.revision}`;
    const held: FactoryIntegration = {
      ...integration,
      hold: {
        id: holdId,
        preparationId: integration.currentPreparationId,
        status: "pending",
        reason,
      },
      phase: "blocked",
      waitReason: reason,
      updatedAt: now,
    };
    holds.set(integration.id, held);
    effects.push(
      {
        type: "integration.stop",
        integrationId: integration.id,
        holdId,
        preparationId: integration.currentPreparationId,
        reason,
      },
      notice(held, `held:${state.revision}`, reason, state),
    );
  }
  return {
    ...decision,
    state:
      holds.size === 0
        ? state
        : {
            ...state,
            integrations: state.integrations.map((entry) => holds.get(entry.id) ?? entry),
            assignments: state.assignments.map((entry) => {
              const held = entry.integrationId ? holds.get(entry.integrationId) : undefined;
              if (!held?.waitReason) return entry;
              return {
                ...entry,
                qualification: { status: "unavailable", reason: held.waitReason },
                status: "waiting",
                wait: { kind: "execution-boundary", reason: held.waitReason },
                updatedAt: now,
              };
            }),
          },
    effects,
  };
}

/**
 * Decides every `integration.*` command and returns `undefined` for any other. The human may do
 * whatever a manager or lead may. Receipts for host work come only from the host (`system`
 * actor) and are refused as `stale-revision` once they no longer match the current record; the
 * target and resume receipts accept a repeat with no change, so replayed effects converge.
 */
export function decideFactoryIntegration(
  input: FactoryIntegrationContext & {
    readonly state: FactorySnapshot;
    readonly actor: FactoryActor;
    readonly command: FactoryDecisionCommand;
    readonly now: string;
    readonly allocation?: FactoryAllocation;
    readonly skills?: FactoryWorkflowVersion;
  },
): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  if (!command.type.startsWith("integration.")) return undefined;
  const human = actor.kind === "human";
  const host = actor.kind === "system";
  const fail = (detail: string, code: FactoryError["code"] = "permission-denied") =>
    Result.fail(new FactoryError({ code, detail }));
  const accept = (
    patch: Partial<FactorySnapshot> = {},
    result: Omit<FactoryCommandResult, "revision"> = {},
    effects: readonly FactoryEffectIntent[] = [],
  ): Result.Result<FactoryDecision, FactoryError> =>
    Result.succeed({
      state: { ...state, ...patch, revision: state.revision + 1 },
      result: { ...result, revision: state.revision + 1 },
      effects,
    });
  // The human, or the named manager's own thread while it is active and its project unpaused.
  const managerOwns = (managerId: ThreadId) =>
    human ||
    (actor.kind === "thread" &&
      actor.threadId === managerId &&
      state.managers.some(
        (entry) =>
          entry.id === managerId &&
          entry.status === "active" &&
          !state.controls.some(
            (control) =>
              control.kind === "project-pause" &&
              control.status === "active" &&
              control.projectId === entry.projectId,
          ),
      ));
  const integration =
    "integrationId" in command
      ? state.integrations.find((entry) => entry.id === command.integrationId)
      : undefined;
  const assignment = state.assignments.find((entry) => entry.id === integration?.assignmentId);
  // A merge operation that is live, or that stopped after any member got an outcome, merges on
  // the tested inputs. Refreshing, changing tests, verifying, recreating the lead or resuming
  // paused work would change what it merges, so all of them wait for it.
  if (
    integration &&
    state.mergeOperations.some(
      (entry) =>
        entry.integrationId === integration.id &&
        (entry.lifecycle.phase !== "stopped" ||
          entry.members.some((member) => member.outcome.phase !== "pending")),
    ) &&
    [
      "integration.refresh",
      "integration.file.mutate",
      "integration.verify",
      "integration.thread.retry",
      "integration.operation.resumed",
    ].includes(command.type)
  )
    return fail(
      "The shared merge operation has frozen this integration workspace. Resolve or safely stop that operation before changing its tested inputs.",
      "permission-denied",
    );
  const leadOwns = (entry: FactoryAssignment | undefined) =>
    human || (active(entry) && actor.kind === "thread" && actor.threadId === entry.threadId);
  // Like `leadOwns` for the integration team, but any thread the service placed on the team
  // through `integrationActorAssignmentId` also qualifies.
  const teamOwns = () =>
    human ||
    (active(assignment) &&
      actor.kind === "thread" &&
      (actor.threadId === assignment.threadId ||
        input.integrationActorAssignmentId === assignment.id));
  /**
   * Starts a new preparation from `source`, the state after the triggering change. The team
   * waits until the host reports the inputs prepared.
   */
  const prepare = (
    selected: FactoryIntegration,
    source: FactorySnapshot,
  ): Result.Result<FactoryDecision, FactoryError> => {
    const reason = factoryIntegrationAccessBlocked(source, selected.id);
    if (reason) return fail(reason, "execution-unavailable");
    const team = source.assignments.find((entry) => entry.id === selected.assignmentId);
    if (!team || team.threadStatus !== "created")
      return fail(
        "Create the integration lead thread before preparing its workspace.",
        "invalid-state",
      );
    const prior = source.integrationPreparations.find(
      (entry) => entry.id === selected.currentPreparationId,
    );
    // Work stopped by the current hold, the prior preparation or its finished verifications and
    // never resumed carries into the new preparation, so a refresh never strands a stopped
    // thread or queued run. Its resume receipt then resumes all of it.
    const interrupted = [
      ...(selected.hold ? [selected.hold] : []),
      ...(prior && !prior.resumedAt ? [prior] : []),
      ...source.integrationVerifications.filter(
        (entry) =>
          entry.integrationId === selected.id &&
          entry.preparationId === selected.currentPreparationId &&
          !entry.resumedAt &&
          entry.lifecycle.phase !== "requested",
      ),
    ];
    const inheritedThreads = [
      ...new Set([
        ...interrupted.flatMap((entry) => entry.resumeThreadIds ?? []),
        ...(!prior?.resumedAt ? (prior?.inheritedResumeThreadIds ?? []) : []),
      ]),
    ];
    const inheritedQueues = new Map<ThreadId, Set<RunId>>();
    for (const queue of [
      ...interrupted.flatMap((entry) => entry.resumeQueues ?? []),
      ...(!prior?.resumedAt ? (prior?.inheritedResumeQueues ?? []) : []),
    ]) {
      const runs = inheritedQueues.get(queue.threadId) ?? new Set<RunId>();
      for (const runId of queue.runIds) runs.add(runId);
      inheritedQueues.set(queue.threadId, runs);
    }
    const preparation: FactoryIntegrationPreparation = {
      inheritedResumeThreadIds: inheritedThreads,
      inheritedResumeQueues: [...inheritedQueues].map(([threadId, runs]) => ({
        threadId,
        runIds: [...runs],
      })),
      id: `integration-preparation:${command.commandId}`,
      integrationId: selected.id,
      previousPreparationId: selected.currentPreparationId,
      grantIds: currentGrants(source, selected.id)
        .map((entry) => entry.id)
        .sort(),
      lifecycle: { phase: "requested" },
      createdAt: now,
    };
    const next: FactoryIntegration = {
      ...selected,
      phase: "preparing",
      hold: null,
      currentPreparationId: preparation.id,
      waitReason: null,
      updatedAt: now,
    };
    return accept(
      {
        ...source,
        integrations: source.integrations.map((entry) => (entry.id === selected.id ? next : entry)),
        integrationPreparations: [...source.integrationPreparations, preparation],
        assignments: source.assignments.map((entry) =>
          entry.id === selected.assignmentId
            ? {
                ...entry,
                status: "waiting",
                qualification: {
                  status: "unavailable",
                  reason: "Preparing the integration inputs.",
                },
                wait: { kind: "execution-boundary", reason: "Preparing the integration inputs." },
              }
            : entry,
        ),
      },
      { integrationId: selected.id, integrationPreparationId: preparation.id },
      [{ type: "integration.prepare", integrationId: selected.id, preparationId: preparation.id }],
    );
  };
  /**
   * Whether a captured test artifact belongs to this preparation: one entry per participant
   * project, each under a grant the preparation was made with, on the manifest's exact
   * candidate once the preparation is ready, changing only granted test and fixture paths.
   */
  const artifactValid = (
    artifact: FactoryIntegrationTestArtifact,
    selected: FactoryIntegration,
    preparation: FactoryIntegrationPreparation,
  ) =>
    artifact.integrationId === selected.id &&
    artifact.preparationId === preparation.id &&
    sameSet(
      artifact.projects.map((entry) => entry.projectId),
      factoryIntegrationParticipants(state, selected.id).map((entry) => entry.projectId),
    ) &&
    artifact.projects.every((project) => {
      const grant = state.integrationGrants.find((entry) => entry.id === project.grantId);
      const basis =
        preparation.lifecycle.phase === "ready"
          ? preparation.lifecycle.manifest.inputs.find(
              (entry) => entry.projectId === project.projectId,
            )
          : undefined;
      const allowed = grant && [...grant.paths.testPaths, ...grant.paths.fixturePaths];
      const directories = grant && [
        ...grant.paths.testDirectories,
        ...grant.paths.fixtureDirectories,
      ];
      return (
        grant?.integrationId === selected.id &&
        grant.projectId === project.projectId &&
        preparation.grantIds.includes(grant.id) &&
        (!basis ||
          (basis.candidateId === project.candidateId &&
            basis.candidateDigest === project.candidateDigest &&
            basis.sourceDigest === project.sourceDigest)) &&
        [...project.changedPaths, ...project.deletedPaths].every(
          (path) =>
            factoryRelativePath(path) &&
            !factoryProtectedPath(path) &&
            (allowed?.includes(path) || contains(directories ?? [], path)),
        )
      );
    });
  switch (command.type) {
    case "integration.hold.targets.recorded": {
      if (!host || !integration || integration.hold?.id !== command.holdId)
        return fail("The integration hold changed before its work was captured.", "stale-revision");
      // Captured once per hold, before the stop; a repeat keeps the first capture.
      if (integration.hold.resumeThreadIds !== undefined) return accept();
      const hold = {
        ...integration.hold,
        resumeThreadIds: command.threadIds,
        resumeQueues: command.resumeQueues,
      };
      return accept({
        integrations: state.integrations.map((entry) =>
          entry.id === integration.id ? { ...entry, hold } : entry,
        ),
      });
    }
    case "integration.operation.resumed": {
      if (!host || !integration) return fail("Only the host confirms restored integration work.");
      const operation = command.operation;
      const record =
        operation.kind === "preparation"
          ? state.integrationPreparations.find((entry) => entry.id === operation.id)
          : state.integrationVerifications.find((entry) => entry.id === operation.id);
      if (
        !record ||
        record.integrationId !== integration.id ||
        record.lifecycle.phase === "requested"
      )
        return fail("This integration operation has not completed.", "invalid-state");
      if (record.resumedAt) return accept();
      return accept(
        operation.kind === "preparation"
          ? {
              integrationPreparations: state.integrationPreparations.map((entry) =>
                entry.id === operation.id ? { ...entry, resumedAt: now } : entry,
              ),
            }
          : {
              integrationVerifications: state.integrationVerifications.map((entry) =>
                entry.id === operation.id ? { ...entry, resumedAt: now } : entry,
              ),
            },
      );
    }
    case "integration.operation.targets.recorded": {
      if (!host || !integration)
        return fail("Only the host records an integration operation's stopped work.");
      const operation = command.operation;
      const record =
        operation.kind === "preparation"
          ? state.integrationPreparations.find((entry) => entry.id === operation.id)
          : state.integrationVerifications.find((entry) => entry.id === operation.id);
      if (
        !record ||
        record.integrationId !== integration.id ||
        record.lifecycle.phase !== "requested"
      )
        return fail(
          "This integration operation is no longer awaiting execution.",
          "stale-revision",
        );
      // Captured once, while the operation is still requested and before it stops the team.
      if (record.resumeThreadIds !== undefined) return accept();
      const targets = { resumeThreadIds: command.threadIds, resumeQueues: command.resumeQueues };
      return accept(
        operation.kind === "preparation"
          ? {
              integrationPreparations: state.integrationPreparations.map((entry) =>
                entry.id === operation.id ? { ...entry, ...targets } : entry,
              ),
            }
          : {
              integrationVerifications: state.integrationVerifications.map((entry) =>
                entry.id === operation.id ? { ...entry, ...targets } : entry,
              ),
            },
      );
    }
    case "integration.capability.configure": {
      const boundary = state.boundaries.find(
        (entry) => entry.id === command.boundaryId && entry.projectId === command.projectId,
      );
      const manager = state.managers.find(
        (entry) =>
          entry.role === "project" &&
          entry.projectId === command.projectId &&
          entry.status !== "retired",
      );
      // Only the human classifies tests and fixtures. A new classification supersedes the
      // project's current one, which blocks every grant made on it until the owner grants again.
      if (
        !human ||
        !boundary ||
        manager?.boundaryId !== boundary.id ||
        !validPaths(command.paths, boundary)
      )
        return fail(
          "Only the human can establish test and fixture classifications inside the current approved project boundary.",
        );
      // The coordinator's result counts toward combined success, so agents must not change it.
      if (
        command.coordinator &&
        (!boundary.protectedPaths.includes(command.coordinator.entrypoint) ||
          !contains(command.paths.readPaths, command.coordinator.entrypoint))
      )
        return fail(
          "The coordinator must be a protected readable file in this project's boundary.",
        );
      const capabilityId = `integration-capability:${command.commandId}`;
      return accept(
        {
          integrationCapabilities: [
            ...state.integrationCapabilities.map((entry) =>
              entry.projectId === command.projectId && entry.supersededBy === null
                ? { ...entry, supersededBy: capabilityId }
                : entry,
            ),
            {
              id: capabilityId,
              projectId: command.projectId,
              boundaryId: boundary.id,
              paths: command.paths,
              coordinator: command.coordinator,
              qualification: { status: "pending" },
              supersededBy: null,
              authorizingCommandId: command.commandId,
              createdAt: now,
            },
          ],
        },
        { integrationCapabilityId: capabilityId },
        [{ type: "integration.capability.qualify", capabilityId }],
      );
    }
    case "integration.capability.retry": {
      const capability = state.integrationCapabilities.find(
        (entry) => entry.id === command.capabilityId,
      );
      if (
        !human ||
        !capability ||
        capability.supersededBy !== null ||
        capability.qualification.status !== "unavailable"
      )
        return fail("Only the human can retry the current unavailable integration capability.");
      return accept(
        {
          integrationCapabilities: state.integrationCapabilities.map((entry) =>
            entry.id === capability.id ? { ...entry, qualification: { status: "pending" } } : entry,
          ),
        },
        { integrationCapabilityId: capability.id },
        [{ type: "integration.capability.qualify", capabilityId: capability.id }],
      );
    }
    case "integration.capability.qualified":
    case "integration.capability.failed": {
      const capability = state.integrationCapabilities.find(
        (entry) => entry.id === command.capabilityId,
      );
      if (
        !host ||
        !capability ||
        capability.supersededBy !== null ||
        capability.qualification.status !== "pending"
      )
        return fail("This capability qualification is no longer current.", "stale-revision");
      // A coordinator capability qualifies only with a coordinator digest, any other only without.
      if (
        command.type === "integration.capability.qualified" &&
        Boolean(capability.coordinator) !== Boolean(command.coordinatorDigest)
      )
        return fail("The protected coordinator qualification is incomplete.", "invalid-state");
      return accept(
        {
          integrationCapabilities: state.integrationCapabilities.map((entry) =>
            entry.id === capability.id
              ? {
                  ...entry,
                  qualification:
                    command.type === "integration.capability.failed"
                      ? { status: "unavailable", reason: command.reason }
                      : {
                          status: "qualified",
                          profileId: command.profileId,
                          configurationDigest: command.configurationDigest,
                          coordinatorDigest: command.coordinatorDigest,
                          checkedAt: now,
                        },
                }
              : entry,
          ),
        },
        { integrationCapabilityId: capability.id },
      );
    }
    case "integration.commission": {
      const manager = state.managers.find((entry) => entry.id === command.managerId);
      const boundary = state.boundaries.find((entry) => entry.id === manager?.boundaryId);
      if (
        !manager ||
        manager.role !== "project" ||
        manager.status !== "active" ||
        !managerOwns(manager.id) ||
        !boundary
      )
        return fail("The requesting project manager must commission the integration team.");
      const requests = state.crossProjectRequests.filter((entry) =>
        command.requestIds.includes(entry.id),
      );
      if (
        requests.length !== command.requestIds.length ||
        new Set(command.requestIds).size !== command.requestIds.length ||
        requests.some(
          (entry) =>
            entry.lifecycle.phase !== "accepted" ||
            entry.originManagerId !== manager.id ||
            entry.origin.kind !== "assignment",
        )
      )
        return fail(
          "Select accepted requests originating with this project manager.",
          "invalid-state",
        );
      const participants = [
        ...new Map(
          requests
            .flatMap((entry) => factoryRequestParticipants(state, entry))
            .map((entry) => [entry.id, entry]),
        ).values(),
      ];
      // One active assignment per participating project, none already in another integration,
      // and both the requester's and the coordinator's projects take part.
      if (
        participants.length < 2 ||
        participants.some((entry) => !active(entry) || entry.integrationId) ||
        new Set(participants.map((entry) => entry.projectId)).size !== participants.length ||
        !participants.some((entry) => entry.projectId === manager.projectId) ||
        !participants.some((entry) => entry.projectId === command.coordinatorProjectId)
      )
        return fail(
          "Integration requires one active implementation assignment per participating project.",
          "invalid-state",
        );
      if (
        state.integrations.some(
          (entry) =>
            sameSet(entry.requestIds, command.requestIds) &&
            active(state.assignments.find((team) => team.id === entry.assignmentId)),
        )
      )
        return fail("These requests already have an active integration team.", "command-conflict");
      // The team is an ordinary implementation assignment under the requester with no source
      // paths of its own; it reaches participant files only through the owners' grants.
      const constructed = commissionFactoryAssignment({
        state,
        manager,
        boundary,
        work: {
          kind: "implementation",
          title: command.title,
          complexity: command.complexity,
          scope: {
            description: command.description,
            completionCondition: "All participating changes complete their shared merge action.",
            requiresPullRequest: false,
            noPrTarget: { kind: "human-acceptance" },
          },
          sourcePaths: [],
          creatableDirectories: [],
          ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
        },
        allocation: input.allocation,
        skills: input.skills,
        policy: resolveManagerPolicy(state.defaults, manager.overrides),
        authorization: human
          ? { kind: "human", commandId: command.commandId }
          : { kind: "manager", commandId: command.commandId, threadId: manager.threadId },
        controlAuthorizationId: command.commandId,
        now,
      });
      if (Result.isFailure(constructed)) return Result.fail(constructed.failure);
      const integrationId = `integration:${command.commandId}`;
      const created: FactoryIntegration = {
        id: integrationId,
        assignmentId: constructed.success.id,
        requesterManagerId: manager.id,
        requestIds: [...command.requestIds].sort(),
        participantAssignmentIds: participants.map((entry) => entry.id).sort(),
        coordinatorProjectId: command.coordinatorProjectId,
        phase: "awaiting-grants",
        waitReason: "Each project owner must grant its integration resources.",
        currentPreparationId: null,
        hold: null,
        currentTestArtifactId: null,
        createdAt: now,
        updatedAt: now,
      };
      const nextState = {
        ...state,
        integrations: [...state.integrations, created],
        assignments: [
          ...state.assignments,
          {
            ...constructed.success,
            integrationId,
            status: "waiting" as const,
            wait: { kind: "execution-boundary" as const, reason: created.waitReason! },
          },
        ],
      };
      return accept(
        nextState,
        { integrationId, assignmentId: created.assignmentId, managerId: manager.id },
        [
          { type: "integration.thread.create", integrationId },
          notice(
            created,
            "commissioned",
            "The requester commissioned an integration team. Each participating project owner must grant its test and fixture resources.",
            nextState,
          ),
        ],
      );
    }
    case "integration.thread.retry": {
      if (
        !integration ||
        !assignment ||
        !managerOwns(integration.requesterManagerId) ||
        assignment.threadStatus === "created"
      )
        return fail("The requester can retry creation of the pending integration lead.");
      return accept({}, { integrationId: integration.id }, [
        { type: "integration.thread.create", integrationId: integration.id },
      ]);
    }
    case "integration.thread.created":
    case "integration.thread.failed": {
      if (
        !host ||
        !integration ||
        !assignment ||
        (command.type === "integration.thread.created" && command.threadId !== assignment.threadId)
      )
        return fail("This integration thread receipt does not match its allocated lead.");
      const reason =
        command.type === "integration.thread.failed"
          ? command.reason
          : "Each project owner must grant its integration resources.";
      const nextState: FactorySnapshot = {
        ...state,
        assignments: state.assignments.map((entry) =>
          entry.id === assignment.id
            ? {
                ...entry,
                threadStatus: command.type === "integration.thread.created" ? "created" : "pending",
                wait: { kind: "execution-boundary", reason },
              }
            : entry,
        ),
      };
      // Preparation starts on whichever arrives last: the lead thread or the final grant.
      if (
        command.type === "integration.thread.created" &&
        integration.phase === "awaiting-grants" &&
        factoryIntegrationAccessBlocked(nextState, integration.id) === null
      )
        return prepare(integration, nextState);
      return accept(nextState, { integrationId: integration.id });
    }
    case "integration.grant":
    case "integration.grant.approve": {
      const requested =
        command.type === "integration.grant.approve"
          ? state.integrationGrants.find((entry) => entry.id === command.grantId)
          : undefined;
      if (command.type === "integration.grant.approve" && (!human || !requested))
        return fail("Only the human can approve a grant beyond the owner's qualified capability.");
      if (requested && requested.lifecycle.phase !== "requested")
        return fail("This grant is no longer awaiting approval.", "stale-revision");
      const target = state.integrations.find(
        (entry) => entry.id === (requested?.integrationId ?? integration?.id),
      );
      const team = state.assignments.find((entry) => entry.id === target?.assignmentId);
      if (!target || !active(team))
        return fail("The integration team is no longer active.", "invalid-state");
      const ask =
        requested ??
        (command.type === "integration.grant"
          ? {
              projectId: command.projectId,
              capabilityId: command.capabilityId,
              paths: command.paths,
            }
          : undefined);
      if (!ask) return fail("Select an integration grant.", "invalid-state");
      const participant = factoryIntegrationParticipants(state, target.id).find(
        (entry) => entry.projectId === ask.projectId,
      );
      const capability = state.integrationCapabilities.find(
        (entry) => entry.id === ask.capabilityId,
      );
      const boundary = state.boundaries.find((entry) => entry.id === capability?.boundaryId);
      const owner = state.managers.find((entry) => entry.id === participant?.managerId);
      // Ownership is checked against the participant's manager, so the requester cannot grant
      // another project's resources. Every grant, even a human-approved one, stays inside the
      // approved boundary of the project's current qualified capability.
      if (
        !participant ||
        !owner ||
        !managerOwns(owner.id) ||
        !capability ||
        capability.projectId !== participant.projectId ||
        capability.supersededBy !== null ||
        capability.qualification.status !== "qualified" ||
        owner.boundaryId !== capability.boundaryId ||
        !boundary ||
        !validPaths(ask.paths, boundary)
      )
        return fail(
          "Only this project's owner can grant access inside its current qualified test capability and approved boundary.",
        );
      const grant: FactoryIntegrationGrant = {
        id: requested?.id ?? `integration-grant:${command.commandId}`,
        integrationId: target.id,
        projectId: participant.projectId,
        ownerManagerId: owner.id,
        participantAssignmentId: participant.id,
        capabilityId: capability.id,
        boundaryId: capability.boundaryId,
        paths: ask.paths,
        lifecycle: { phase: "active" },
        authorizingCommandId: command.commandId,
        createdAt: requested?.createdAt ?? now,
      };
      // One live grant per project: a new active grant revokes the project's other active and
      // requested grants.
      const open = state.integrationGrants.filter(
        (entry) =>
          entry.integrationId === target.id &&
          entry.projectId === participant.projectId &&
          entry.id !== grant.id &&
          entry.lifecycle.phase !== "revoked",
      );
      const revoke = (entries: readonly FactoryIntegrationGrant[], reason: string) =>
        state.integrationGrants.map((entry) =>
          entries.some((old) => old.id === entry.id)
            ? {
                ...entry,
                lifecycle: {
                  phase: "revoked" as const,
                  reason,
                  commandId: command.commandId,
                  revokedAt: now,
                },
              }
            : entry,
        );
      if (!pathsWithin(ask.paths, capability.paths) && !requested) {
        // Beyond the owner's authority: record the ask for the human instead of refusing it.
        const asked = { ...grant, lifecycle: { phase: "requested" as const } };
        const pending = open.filter((entry) => entry.lifecycle.phase === "requested");
        return accept(
          {
            integrationGrants: [...revoke(pending, "Replaced by a newer grant request."), asked],
          },
          { integrationId: target.id, integrationGrantId: asked.id },
          [
            notice(
              target,
              `grant-requested:${asked.id}`,
              `Project ${participant.projectId} asked to grant integration access beyond its qualified capability. The human decides grant ${asked.id}; until then the current grant, if any, stays in force.`,
              state,
            ),
          ],
        );
      }
      const replaced = open.filter((entry) => entry.lifecycle.phase === "active");
      const nextState: FactorySnapshot = {
        ...state,
        integrationGrants: [
          ...revoke(open, "Replaced by a new owner grant.").filter(
            (entry) => entry.id !== grant.id,
          ),
          grant,
        ],
      };
      // Replacing a grant after preparation changes what the prepared workspace may hold, so the
      // integration is held until a refresh rebuilds it under the new grant.
      if (replaced.length && target.currentPreparationId !== null) {
        const reason =
          "An owner replaced its integration grant. Refresh explicitly before resuming.";
        const held = {
          ...target,
          phase: "blocked" as const,
          hold: {
            id: `integration-grant-hold:${command.commandId}`,
            preparationId: target.currentPreparationId,
            status: "pending" as const,
            reason,
          },
          waitReason: reason,
          updatedAt: now,
        };
        return accept(
          {
            ...nextState,
            integrations: state.integrations.map((entry) =>
              entry.id === target.id ? held : entry,
            ),
            assignments: state.assignments.map((entry) =>
              entry.id === team.id
                ? {
                    ...entry,
                    qualification: { status: "unavailable", reason },
                    status: "waiting",
                    wait: { kind: "execution-boundary", reason },
                  }
                : entry,
            ),
          },
          { integrationId: target.id, integrationGrantId: grant.id },
          [
            {
              type: "integration.stop",
              integrationId: target.id,
              holdId: `integration-grant-hold:${command.commandId}`,
              preparationId: target.currentPreparationId,
              reason,
            },
          ],
        );
      }
      if (
        target.phase === "awaiting-grants" &&
        team.threadStatus === "created" &&
        factoryIntegrationAccessBlocked(nextState, target.id) === null
      )
        return Result.map(prepare(target, nextState), (value) => ({
          ...value,
          result: { ...value.result, integrationGrantId: grant.id },
        }));
      return accept(nextState, { integrationId: target.id, integrationGrantId: grant.id });
    }
    case "integration.grant.revoke": {
      const grant = state.integrationGrants.find((entry) => entry.id === command.grantId);
      if (!grant || !managerOwns(grant.ownerManagerId))
        return fail("Only the project owner can revoke its integration grant.");
      // Revoking an active grant blocks access and `reconcileFactoryIntegrations` holds the
      // integration. Revoking a requested grant declines it and notifies the integration.
      if (grant.lifecycle.phase === "revoked") return accept({}, { integrationGrantId: grant.id });
      const grantIntegration = state.integrations.find((entry) => entry.id === grant.integrationId);
      return accept(
        {
          integrationGrants: state.integrationGrants.map((entry) =>
            entry.id === grant.id
              ? {
                  ...entry,
                  lifecycle: {
                    phase: "revoked",
                    reason: command.reason,
                    commandId: command.commandId,
                    revokedAt: now,
                  },
                }
              : entry,
          ),
        },
        { integrationId: grant.integrationId, integrationGrantId: grant.id },
        grantIntegration && grant.lifecycle.phase === "requested"
          ? [
              notice(
                grantIntegration,
                `grant-declined:${grant.id}`,
                `Grant request ${grant.id} for project ${grant.projectId} was not granted: ${command.reason}`,
                state,
              ),
            ]
          : [],
      );
    }
    case "integration.refresh": {
      if (!integration || (!leadOwns(assignment) && !managerOwns(integration.requesterManagerId)))
        return fail("The integration lead or requester must refresh its inputs.");
      if (
        integration.currentPreparationId !== command.expectedPreparationId ||
        integration.phase === "preparing"
      )
        return fail("The integration preparation changed or is already running.", "stale-revision");
      // Refresh is the way out of `blocked`. It waits for a running verification, whose result
      // belongs to the preparation it ran against.
      if (
        state.integrationVerifications.some(
          (entry) =>
            entry.integrationId === integration.id && entry.lifecycle.phase === "requested",
        )
      )
        return fail(
          "Wait for the current combined verification before refreshing.",
          "invalid-state",
        );
      return prepare(integration, state);
    }
    case "integration.prepared":
    case "integration.prepare.failed": {
      const preparation = state.integrationPreparations.find(
        (entry) => entry.id === command.preparationId && entry.integrationId === integration?.id,
      );
      if (
        !host ||
        !integration ||
        !assignment ||
        !preparation ||
        preparation.lifecycle.phase !== "requested" ||
        integration.currentPreparationId !== preparation.id
      )
        return fail("This preparation receipt is no longer current.", "stale-revision");
      if (command.type === "integration.prepare.failed")
        return accept(
          {
            integrationPreparations: state.integrationPreparations.map((entry) =>
              entry.id === preparation.id
                ? { ...entry, lifecycle: { phase: "failed", reason: command.reason } }
                : entry,
            ),
            integrations: state.integrations.map((entry) =>
              entry.id === integration.id
                ? { ...entry, phase: "blocked", waitReason: command.reason, updatedAt: now }
                : entry,
            ),
          },
          { integrationId: integration.id },
        );
      // The host prepared against an earlier snapshot, so its inputs must still match current
      // authority, the preparation's own grants and the current source before they count.
      const blocked = factoryIntegrationAccessBlocked(state, integration.id);
      const preparedBasis: FactoryIntegrationPreparation = {
        ...preparation,
        lifecycle: {
          phase: "ready",
          manifest: command.manifest,
          profileId: command.profileId,
          testArtifactId: command.testArtifact.id,
          preparedAt: now,
        },
      };
      if (
        blocked ||
        integration.phase !== "preparing" ||
        !sameSet(
          preparation.grantIds,
          command.manifest.inputs.map((entry) => entry.integrationGrantId),
        ) ||
        factoryIntegrationManifestReasons(state, integration.id, command.manifest).length ||
        !artifactValid(command.testArtifact, integration, preparedBasis)
      )
        return fail(
          blocked ?? "The prepared input vector no longer matches current authority and source.",
          "stale-revision",
        );
      const nextAssignment: FactoryAssignment = {
        ...assignment,
        status: "pending",
        preparation: "ready",
        qualification: { status: "qualified", profileId: command.profileId, checkedAt: now },
        wait: null,
        updatedAt: now,
      };
      return accept(
        {
          integrationPreparations: state.integrationPreparations.map((entry) =>
            entry.id === preparation.id ? preparedBasis : entry,
          ),
          integrationTestArtifacts: [...state.integrationTestArtifacts, command.testArtifact],
          integrations: state.integrations.map((entry) =>
            entry.id === integration.id
              ? {
                  ...entry,
                  phase: "ready",
                  waitReason: null,
                  currentTestArtifactId: command.testArtifact.id,
                  updatedAt: now,
                }
              : entry,
          ),
          assignments: state.assignments.map((entry) =>
            entry.id === assignment.id ? nextAssignment : entry,
          ),
        },
        { integrationId: integration.id, integrationPreparationId: preparation.id },
        // The lead first launches on a ready preparation; every preparation then resumes the
        // work it stopped.
        [
          ...(assignment.launchStatus === "pending" && assignment.modelSelection
            ? [
                {
                  type: "thread.launch" as const,
                  purpose: "implementation" as const,
                  managerId: assignment.managerId,
                  assignmentId: assignment.id,
                  threadId: assignment.threadId,
                  projectId: assignment.projectId,
                  modelSelection: assignment.modelSelection,
                  workflow: assignment.workflow,
                  profileId: command.profileId,
                },
              ]
            : []),
          {
            type: "integration.resume",
            integrationId: integration.id,
            operation: { kind: "preparation", id: preparation.id },
          },
        ],
      );
    }
    case "integration.file.mutate":
    case "integration.verify": {
      const preparation = state.integrationPreparations.find(
        (entry) => entry.id === command.preparationId,
      );
      if (
        !integration ||
        !assignment ||
        !teamOwns() ||
        integration.phase !== "ready" ||
        integration.currentPreparationId !== command.preparationId ||
        preparation?.lifecycle.phase !== "ready"
      )
        return fail("Only the current integration team can use its ready prepared workspace.");
      const blocked = factoryIntegrationAccessBlocked(state, integration.id);
      if (blocked) return fail(blocked, "execution-unavailable");
      // A running verification seals the test artifact it runs, so the workspace stays still.
      if (
        state.integrationVerifications.some(
          (entry) =>
            entry.integrationId === integration.id && entry.lifecycle.phase === "requested",
        )
      )
        return fail("A combined verification is already running.", "invalid-state");
      // The host checks the same grant paths again inside the runtime before writing.
      if (command.type === "integration.file.mutate") {
        const grant = currentGrants(state, integration.id).find(
          (entry) => entry.id === command.grantId,
        );
        const paths = [
          command.operation.path,
          ...(command.operation.kind === "rename" ? [command.operation.to] : []),
        ];
        if (
          !grant ||
          !preparation.grantIds.includes(grant.id) ||
          paths.some(
            (path) =>
              !factoryRelativePath(path) ||
              factoryProtectedPath(path) ||
              (![...grant.paths.testPaths, ...grant.paths.fixturePaths].includes(path) &&
                !contains(
                  [...grant.paths.testDirectories, ...grant.paths.fixtureDirectories],
                  path,
                )),
          )
        )
          return fail(
            "Integration file changes are limited to this owner's granted tests and fixtures.",
          );
        const operationId = `integration-file:${command.commandId}`;
        return accept({}, { integrationId: integration.id, integrationOperationId: operationId }, [
          {
            type: "integration.file.mutate",
            integrationId: integration.id,
            preparationId: preparation.id,
            grantId: grant.id,
            operationId,
            operation: command.operation,
          },
        ]);
      }
      const reasons = factoryIntegrationManifestReasons(
        state,
        integration.id,
        preparation.lifecycle.manifest,
      );
      if (reasons.length) return fail(reasons.join(" "), "stale-revision");
      // The recorded input digest lets the host refuse to run against a different input vector.
      const verificationId = `integration-verification:${command.commandId}`;
      return accept(
        {
          integrationVerifications: [
            ...state.integrationVerifications,
            {
              id: verificationId,
              integrationId: integration.id,
              preparationId: preparation.id,
              inputDigest: preparation.lifecycle.manifest.inputDigest,
              lifecycle: { phase: "requested" },
              createdAt: now,
            },
          ],
        },
        { integrationId: integration.id, integrationVerificationId: verificationId },
        [{ type: "integration.verify", verificationId }],
      );
    }
    case "integration.file.mutated":
    case "integration.file.failed": {
      if (!host || !integration) return fail("Only the host records integration file mutations.");
      if (command.type === "integration.file.failed")
        return accept(
          {},
          { integrationId: integration.id, integrationOperationId: command.operationId },
        );
      const preparation = state.integrationPreparations.find(
        (entry) => entry.id === command.preparationId,
      );
      if (!preparation || !artifactValid(command.testArtifact, integration, preparation))
        return fail("The captured test artifact is outside this preparation.", "invalid-state");
      // A late capture is still recorded, but becomes current only while its preparation is.
      return accept(
        {
          integrationTestArtifacts: [...state.integrationTestArtifacts, command.testArtifact],
          integrations: state.integrations.map((entry) =>
            entry.id === integration.id && entry.currentPreparationId === preparation.id
              ? { ...entry, currentTestArtifactId: command.testArtifact.id, updatedAt: now }
              : entry,
          ),
        },
        { integrationId: integration.id, integrationOperationId: command.operationId },
      );
    }
    case "integration.verified":
    case "integration.verify.failed": {
      const verification = state.integrationVerifications.find(
        (entry) => entry.id === command.verificationId,
      );
      const selected = state.integrations.find((entry) => entry.id === verification?.integrationId);
      const preparation = state.integrationPreparations.find(
        (entry) => entry.id === verification?.preparationId,
      );
      if (
        !host ||
        !verification ||
        verification.lifecycle.phase !== "requested" ||
        !selected ||
        !preparation
      )
        return fail("This verification receipt has no pending run.", "stale-revision");
      if (command.type === "integration.verify.failed")
        return accept(
          {
            integrationVerifications: state.integrationVerifications.map((entry) =>
              entry.id === verification.id
                ? { ...entry, lifecycle: { phase: "failed", reason: command.reason } }
                : entry,
            ),
          },
          { integrationVerificationId: verification.id },
          [
            {
              type: "integration.resume",
              integrationId: selected.id,
              operation: { kind: "verification", id: verification.id },
            },
          ],
        );
      // `passed` needs at least one check, each passing with exit code 0. The run is recorded
      // even after its preparation was replaced; readiness then reports it stale.
      if (
        !artifactValid(command.testArtifact, selected, preparation) ||
        (command.result === "passed" &&
          (!command.checks.length ||
            command.checks.some((entry) => entry.status !== "passed" || entry.exitCode !== 0)))
      )
        return fail(
          "Only actual passing protected checks can record combined success.",
          "invalid-state",
        );
      return accept(
        {
          integrationTestArtifacts: [...state.integrationTestArtifacts, command.testArtifact],
          integrations: state.integrations.map((entry) =>
            entry.id === selected.id && entry.currentPreparationId === preparation.id
              ? { ...entry, currentTestArtifactId: command.testArtifact.id, updatedAt: now }
              : entry,
          ),
          integrationVerifications: state.integrationVerifications.map((entry) =>
            entry.id === verification.id
              ? {
                  ...entry,
                  lifecycle: {
                    phase: "completed",
                    result: command.result,
                    testArtifactId: command.testArtifact.id,
                    testArtifactDigest: command.testArtifact.digest,
                    hostArtifactId: command.hostArtifactId,
                    checks: command.checks,
                    completedAt: now,
                  },
                }
              : entry,
          ),
        },
        { integrationId: selected.id, integrationVerificationId: verification.id },
        [
          {
            type: "integration.resume",
            integrationId: selected.id,
            operation: { kind: "verification", id: verification.id },
          },
        ],
      );
    }
    case "integration.stopped":
    case "integration.stop.failed": {
      if (!host || !integration || integration.hold?.id !== command.holdId)
        return fail(
          "This stop receipt belongs to a superseded integration hold.",
          "stale-revision",
        );
      // A failed stop leaves the hold in force with the failure as its reason; the stop effect
      // stays pending and retries.
      const hold = {
        ...integration.hold,
        status:
          command.type === "integration.stopped" ? ("confirmed" as const) : ("failed" as const),
        reason:
          command.type === "integration.stop.failed" ? command.reason : integration.hold.reason,
      };
      return accept(
        {
          integrations: state.integrations.map((entry) =>
            entry.id === integration.id
              ? { ...entry, hold, waitReason: hold.reason, updatedAt: now }
              : entry,
          ),
        },
        { integrationId: integration.id },
      );
    }
    case "integration.message.send":
    case "integration.defect.report": {
      if (!integration || !active(assignment))
        return fail("The integration team is no longer active.");
      const fromId =
        command.type === "integration.defect.report" ? assignment.id : command.fromAssignmentId;
      const toId =
        command.type === "integration.defect.report"
          ? command.participantAssignmentId
          : command.toAssignmentId;
      const sender = state.assignments.find((entry) => entry.id === fromId);
      const recipient = state.assignments.find((entry) => entry.id === toId);
      // Messages pass only between the integration lead and a participant lead, either way, while
      // every request is still accepted. A defect report always goes from the integration team to
      // the owning lead and must cite a ready preparation.
      if (
        !active(sender) ||
        !active(recipient) ||
        !leadOwns(sender) ||
        !(
          (fromId === assignment.id && integration.participantAssignmentIds.includes(toId)) ||
          (toId === assignment.id && integration.participantAssignmentIds.includes(fromId))
        ) ||
        integration.requestIds.some(
          (id) =>
            !state.crossProjectRequests.some(
              (entry) => entry.id === id && entry.lifecycle.phase === "accepted",
            ),
        )
      )
        return fail(
          "Only current integration and participant leads can exchange these scoped messages.",
        );
      if (
        command.type === "integration.defect.report" &&
        !state.integrationPreparations.some(
          (entry) =>
            entry.id === command.preparationId &&
            entry.integrationId === integration.id &&
            entry.lifecycle.phase === "ready",
        )
      )
        return fail(
          "Reference the actual prepared inputs for this production defect.",
          "invalid-state",
        );
      const message: FactoryIntegrationMessage = {
        id: `integration-message:${command.commandId}`,
        integrationId: integration.id,
        fromAssignmentId: fromId,
        toAssignmentId: toId,
        senderThreadId: sender.threadId,
        content:
          command.type === "integration.defect.report"
            ? {
                kind: "production-defect",
                preparationId: command.preparationId,
                summary: command.summary,
                evidence: command.evidence,
              }
            : { kind: "message", text: command.text },
        delivery: { phase: "pending" },
        createdAt: now,
      };
      return accept(
        { integrationMessages: [...state.integrationMessages, message] },
        { integrationId: integration.id, integrationMessageId: message.id },
        [{ type: "integration.message.deliver", messageId: message.id }],
      );
    }
    case "integration.message.retry": {
      const message = state.integrationMessages.find((entry) => entry.id === command.messageId);
      const sender = state.assignments.find((entry) => entry.id === message?.fromAssignmentId);
      if (!message || message.delivery.phase !== "failed" || !leadOwns(sender))
        return fail("Only the current sending lead can retry this message.");
      return accept(
        {
          integrationMessages: state.integrationMessages.map((entry) =>
            entry.id === message.id ? { ...entry, delivery: { phase: "pending" } } : entry,
          ),
        },
        { integrationMessageId: message.id },
        [{ type: "integration.message.deliver", messageId: message.id }],
      );
    }
    case "integration.message.recorded":
    case "integration.message.failed": {
      const message = state.integrationMessages.find((entry) => entry.id === command.messageId);
      if (!host || !message || message.delivery.phase !== "pending")
        return fail("This integration message has no pending delivery.", "invalid-state");
      return accept(
        {
          integrationMessages: retainDeliveredMessages(
            state.integrationMessages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    delivery:
                      command.type === "integration.message.failed"
                        ? { phase: "failed", reason: command.reason }
                        : {
                            phase: "delivered",
                            recipientThreadId: command.recipientThreadId,
                            messageId: command.deliveredMessageId,
                            deliveredAt: now,
                          },
                  }
                : entry,
            ),
            (entry) => entry.integrationId === message.integrationId,
          ),
        },
        { integrationMessageId: message.id },
      );
    }
  }
}
