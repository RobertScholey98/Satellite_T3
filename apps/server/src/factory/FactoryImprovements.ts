import { sha256 } from "@noble/hashes/sha2";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  FactoryError,
  factorySystemManager,
  type FactoryCommandResult,
  type FactoryDecisionCommand,
  type FactoryDiscoveryQualification,
  type FactoryEffectIntent,
  type FactoryFinding,
  type FactoryImprovementBatch,
  type FactoryImprovementIntake,
  type FactoryImprovementSettings,
  type FactoryManager,
  type FactorySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import { isFactoryModelApproved, resolveFactoryModelPolicy } from "./FactoryModelPolicy.ts";
import { preserveFactoryManagerPauses } from "./FactoryControls.ts";
import type { FactoryActor, FactoryDecision } from "./FactoryState.ts";
import { factorySharedAssignmentOwned } from "./FactoryWorkflowOwnership.ts";
import { factorySkillsPin, type FactorySkillsContext } from "./FactoryAssignmentCommission.ts";

/**
 * Host qualification for `system.create` and `system.retry`, gathered by
 * `FactoryImprovementEffects.context`. A retry reuses the manager's thread; a create gets a new
 * one.
 */
export interface FactoryImprovementContext {
  readonly systemManagerCreation?: {
    readonly threadId: ThreadId;
    readonly qualification: FactoryDiscoveryQualification;
  };
}
export const factoryImprovementDefaults: FactoryImprovementSettings = {
  enabled: true,
  routineThreshold: 10,
  maxAgeHours: 24,
  sampleEvery: 5,
  maxBatchItems: 20,
  maxSummaryChars: 16_000,
  routineBatchesPerDay: 2,
  urgentBatchesPerDay: 4,
};
/** The active review settings: the human's latest saved configuration over the defaults. */
export const factoryImprovementConfiguration = (
  state: FactorySnapshot,
): FactoryImprovementSettings => ({
  ...factoryImprovementDefaults,
  ...state.improvementConfigurations.at(-1),
});
const hash = (value: unknown) =>
  Hex.encode(sha256(new TextEncoder().encode(stableStringify(value))));
/**
 * The version of a finding the system manager has seen. Intake repeats only when this changes, so
 * it ignores evidence order and duplicates.
 */
export const factoryImprovementFindingDigest = (finding: FactoryFinding) =>
  hash({
    id: finding.id,
    assignmentId: finding.assignmentId,
    problem: finding.problem,
    impact: finding.impact,
    evidence: [
      ...new Map(finding.evidence.map((entry) => [stableStringify(entry), entry])).values(),
    ].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    activeBlocker: finding.activeBlocker,
    // Rerouting an escalation alone must not wake the system manager again.
    route: finding.escalation ? null : finding.route,
    containmentOf: finding.containmentOf,
    escalation: finding.escalation?.summary ?? null,
  });
const systemManager = (state: FactorySnapshot) => factorySystemManager(state.managers);
// The system manager takes new work only while qualified, launched, active and not paused.
const availableManager = (state: FactorySnapshot) => {
  const manager = systemManager(state);
  return manager?.role === "system" &&
    manager.qualification.status === "qualified" &&
    manager.status === "active" &&
    manager.launchStatus === "delivered" &&
    !state.controls.some(
      (entry) =>
        entry.kind === "manager-pause" &&
        entry.managerId === manager.id &&
        entry.status === "active",
    )
    ? manager
    : undefined;
};
/**
 * Findings that a completed retro named in a learning or disposed of. These feed routine intake;
 * any other finding reaches the system manager only through an explicit escalation.
 */
export const factoryImprovementRetroFindingIds = (state: FactorySnapshot): readonly string[] => [
  ...new Set(
    state.retros.flatMap((retro) =>
      retro.reports.phase !== "complete"
        ? []
        : [
            ...(retro.reports.team.learning.kind === "findings"
              ? retro.reports.team.learning.findingIds
              : []),
            ...(retro.reports.manager.learning.kind === "findings"
              ? retro.reports.manager.learning.findingIds
              : []),
            ...retro.reports.manager.dispositions.map((entry) => entry.findingId),
          ].filter((id) =>
            state.findings.some(
              (finding) => finding.id === id && finding.assignmentId === retro.assignmentId,
            ),
          ),
    ),
  ),
];
// Escalations form the urgent queue and completed-retro findings the routine one.
const pending = (state: FactorySnapshot, kind: "urgent" | "routine") =>
  state.improvementIntakes.filter(
    (entry) =>
      entry.delivery.phase === "queued" &&
      (kind === "urgent" ? entry.origin === "explicit-escalation" : entry.origin === "retro"),
  );
export const factoryImprovementBatchesSpent = (
  state: FactorySnapshot,
  kind: "urgent" | "routine",
  day: string,
) =>
  state.improvementBatches.filter((entry) => entry.kind === kind && entry.budgetDay === day).length;
const allowance = (settings: FactoryImprovementSettings, kind: "urgent" | "routine") =>
  kind === "urgent" ? settings.urgentBatchesPerDay : settings.routineBatchesPerDay;
// Allowances reset at the start of each UTC day.
const dayAt = (now: string) => now.slice(0, 10);
const nextDay = (now: string) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(`${dayAt(now)}T00:00:00.000Z`) + 86_400_000));
const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/**
 * The next batch of one kind to seal, or `undefined` when none is due. Each kind has at most one
 * batch awaiting delivery. Routine batches wait for the threshold or for the oldest intake to
 * reach the maximum age, and each sealed batch spends that kind's daily allowance. Forcing a
 * routine batch skips the threshold and age but not the allowance; a forced urgent batch is the
 * human's and spends none. The summary splits its character budget evenly across intakes.
 */
export function factoryImprovementBatchPlan(
  state: FactorySnapshot,
  now: string,
  options: { readonly kind: "urgent" | "routine"; readonly force?: boolean },
) {
  const configuration = factoryImprovementConfiguration(state);
  const manager = availableManager(state);
  if (
    !configuration.enabled ||
    !manager ||
    state.improvementBatches.some(
      (entry) => entry.kind === options.kind && entry.delivery.status === "pending",
    )
  )
    return undefined;
  const queued = pending(state, options.kind);
  if (!queued.length) return undefined;
  // A human escalation review is outside the daily allowance and spends none of it.
  const humanEscalation = options.kind === "urgent" && options.force === true;
  const budgetDay = humanEscalation ? null : dayAt(now);
  if (
    (budgetDay !== null &&
      factoryImprovementBatchesSpent(state, options.kind, budgetDay) >=
        allowance(configuration, options.kind)) ||
    (options.kind === "routine" &&
      !options.force &&
      queued.length < configuration.routineThreshold &&
      Date.parse(now) < Date.parse(queued[0]!.queuedAt) + configuration.maxAgeHours * 3_600_000)
  )
    return undefined;
  const selected = queued.slice(0, configuration.maxBatchItems);
  const perItem = Math.floor(
    (configuration.maxSummaryChars - selected.length * 2) / selected.length,
  );
  const summary = selected
    .map((entry) =>
      truncate(
        `[${entry.id}] project=${entry.projectId}; finding=${entry.findingId}; assignment=${entry.assignmentId}\n${entry.summary}`,
        perItem,
      ),
    )
    .join("\n\n");
  const intakeIds = selected.map((entry) => entry.id);
  return {
    managerId: manager.id,
    intakeIds,
    summary,
    digest: hash({ intakeIds, summary }),
    budgetDay,
  };
}

/**
 * When intake next needs a wake: `now` if a batch can be sealed, otherwise the earliest time a
 * held batch becomes due, or `null` when nothing is waiting. `FactoryImprovementEffects.watch`
 * sleeps until this time rather than polling.
 */
export function factoryImprovementNextDueAt(state: FactorySnapshot, now: string): string | null {
  const configuration = factoryImprovementConfiguration(state);
  if (!configuration.enabled || !availableManager(state)) return null;
  if (
    factoryImprovementBatchPlan(state, now, { kind: "urgent" }) ||
    factoryImprovementBatchPlan(state, now, { kind: "routine" })
  )
    return now;
  const waiting = (kind: "urgent" | "routine") =>
    pending(state, kind).length > 0 &&
    allowance(configuration, kind) > 0 &&
    !state.improvementBatches.some(
      (entry) => entry.kind === kind && entry.delivery.status === "pending",
    );
  // Escalations held by a spent urgent allowance are due when the next UTC day begins.
  const urgent = waiting("urgent") ? Date.parse(nextDay(now)) : null;
  const queued = pending(state, "routine");
  const age = waiting("routine")
    ? Date.parse(queued[0]!.queuedAt) + configuration.maxAgeHours * 3_600_000
    : null;
  const routine =
    age === null
      ? null
      : factoryImprovementBatchesSpent(state, "routine", dayAt(now)) >=
          configuration.routineBatchesPerDay
        ? Math.max(
            Date.parse(nextDay(now)),
            queued.length >= configuration.routineThreshold ? 0 : age,
          )
        : age;
  const due = Math.min(urgent ?? Infinity, routine ?? Infinity);
  return due === Infinity
    ? null
    : DateTime.formatIso(DateTime.makeUnsafe(Math.max(Date.parse(now), due)));
}

/**
 * Decides the system manager's lifecycle, evidence intake and batching, investigations and
 * proposals, and returns `undefined` for commands it leaves to other deciders. It also screens
 * the system manager's other commands that reach it: the system manager may steer only
 * assignments it owns through shared work, and anything else from it is refused.
 */
export function decideFactoryImprovements(
  input: FactoryImprovementContext &
    FactorySkillsContext & {
      readonly state: FactorySnapshot;
      readonly actor: FactoryActor;
      readonly command: FactoryDecisionCommand;
      readonly now: string;
    },
): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  const recognized =
    command.type.startsWith("system.") ||
    command.type.startsWith("improvement.") ||
    command.type.startsWith("investigation.") ||
    command.type.startsWith("proposal.");
  const manager = systemManager(state);
  const systemActor = actor.kind === "thread" && actor.threadId === manager?.threadId;
  const fail = (detail: string, code: FactoryError["code"] = "permission-denied") =>
    Result.fail(new FactoryError({ code, detail }));
  if (!recognized) {
    const assignmentId =
      "assignmentId" in command
        ? command.assignmentId
        : "retroId" in command
          ? state.retros.find((entry) => entry.id === command.retroId)?.assignmentId
          : "findingId" in command
            ? state.findings.find((entry) => entry.id === command.findingId)?.assignmentId
            : "dependencyId" in command
              ? state.dependencies.find((entry) => entry.id === command.dependencyId)?.assignmentId
              : undefined;
    const assignment = state.assignments.find((entry) => entry.id === assignmentId);
    // An owned shared-work assignment is steered through the ordinary deciders, and only while
    // the system manager is available.
    if (
      systemActor &&
      assignment &&
      availableManager(state) &&
      factorySharedAssignmentOwned(state, assignment) &&
      [
        "assignment.retry",
        "assignment.wait.resolve",
        "assignment.recovery.begin",
        "assignment.recovery.replan",
        "assignment.recovery.escalate",
        "assignment.completion.retry",
        "dependency.check-usability",
        "finding.route",
        "finding.escalate",
        "retro.manager.submit",
        "retro.retry",
      ].includes(command.type)
    )
      return undefined;
    return systemActor
      ? fail(
          "The system manager investigates shared process. It cannot direct project delivery or change project permissions.",
        )
      : undefined;
  }
  const accepted = (
    changes: Partial<FactorySnapshot> = {},
    result: Omit<FactoryCommandResult, "revision"> = {},
    effects: readonly FactoryEffectIntent[] = [],
  ): Result.Result<FactoryDecision, FactoryError> =>
    Result.succeed({
      state: {
        ...state,
        ...changes,
        ...(changes.managers === undefined
          ? {}
          : preserveFactoryManagerPauses(state, changes.managers)),
        revision: state.revision + 1,
      },
      result: { ...result, revision: state.revision + 1 },
      effects,
    });
  const human = actor.kind === "human";
  const host = actor.kind === "system";
  const canInvestigate = human || (systemActor && availableManager(state) !== undefined);
  // Sampled findings open investigations. Retained but unsampled findings can join one that the
  // human opens or that already exists.
  const attachableFindings = (ids: readonly string[], retained: boolean) =>
    new Set(ids).size === ids.length &&
    ids.every(
      (id) =>
        state.findings.some((finding) => finding.id === id) &&
        state.improvementIntakes.some(
          (entry) => entry.findingId === id && (retained || entry.delivery.phase !== "skipped"),
        ),
    );
  const relatedValid = (ids: readonly string[], self?: string) =>
    new Set(ids).size === ids.length &&
    ids.every(
      (id) => id !== self && state.improvementInvestigations.some((entry) => entry.id === id),
    );
  // A sealed batch freezes its intakes and digest. Delivery and failure receipts must cite that
  // digest, so a batch never changes after the manager may have seen it.
  const seal = (kind: "urgent" | "routine", force = false) => {
    const plan = factoryImprovementBatchPlan(state, now, { kind, force });
    if (!plan) return accepted();
    const id = `improvement-batch:${command.commandId}`;
    const batch: FactoryImprovementBatch = {
      id,
      kind,
      ...plan,
      createdAt: now,
      delivery: { status: "pending" },
    };
    return accepted(
      {
        improvementBatches: [...state.improvementBatches, batch],
        improvementIntakes: state.improvementIntakes.map((entry) =>
          plan.intakeIds.includes(entry.id)
            ? { ...entry, delivery: { phase: "batched", batchId: id } }
            : entry,
        ),
      },
      { batchId: id },
      [{ type: "improvement.notify", batchId: id, managerId: plan.managerId, digest: plan.digest }],
    );
  };

  switch (command.type) {
    case "system.create": {
      if (!human) return fail("Only the human can create the system manager.");
      if (manager && manager.status !== "retired")
        return fail("This environment already has its system manager.", "invalid-state");
      const creation = input.systemManagerCreation;
      if (
        !creation ||
        state.managers.some((entry) => entry.threadId === creation.threadId) ||
        state.assignments.some((entry) => entry.threadId === creation.threadId) ||
        state.auxiliaryThreads.some((entry) => entry.threadId === creation.threadId)
      )
        return fail("A fresh host-qualified system-manager identity is required.", "invalid-state");
      if (
        !isFactoryModelApproved(
          resolveFactoryModelPolicy(state.modelDefaults, undefined, command.modelSelection),
          command.modelSelection,
        )
      )
        return fail("Select an approved system-manager model.");
      const pin = factorySkillsPin(input.skills);
      if (Result.isFailure(pin)) return Result.fail(pin.failure);
      const qualification = creation.qualification;
      const created: FactoryManager = {
        id: creation.threadId,
        threadId: creation.threadId,
        role: "system",
        projectId: null,
        workspaceProjectId: command.workspaceProjectId,
        qualification,
        name: command.name ?? "System manager",
        modelSelection: command.modelSelection,
        workflow: pin.success,
        overrides: {},
        status: qualification.status === "qualified" ? "onboarding" : "blocked",
        threadStatus: "pending",
        launchStatus: "pending",
        wait:
          qualification.status === "unavailable"
            ? { kind: "execution-boundary", reason: qualification.reason }
            : null,
        createdAt: now,
        updatedAt: now,
      };
      // A replacement inherits what its retired predecessor held but had not acted on: shared
      // repository registrations, undelivered evidence batches and uncommissioned work plans.
      // Commissioned teams were cancelled at retirement and stay with their original manager.
      const inherits = (entry: { readonly managerId: ThreadId }) => entry.managerId === manager?.id;
      const batches = state.improvementBatches.filter(
        (entry) => inherits(entry) && entry.delivery.status === "pending",
      );
      const works = state.sharedWorks.filter(
        (entry) =>
          inherits(entry) &&
          (entry.lifecycle.phase === "proposed" || entry.lifecycle.phase === "authorized"),
      );
      return accepted(
        {
          managers: [...state.managers, created],
          sharedRepositories: state.sharedRepositories.map((entry) =>
            inherits(entry) ? { ...entry, managerId: created.id } : entry,
          ),
          improvementBatches: state.improvementBatches.map((entry) =>
            batches.includes(entry)
              ? { ...entry, managerId: created.id, delivery: { status: "pending" } }
              : entry,
          ),
          sharedWorks: state.sharedWorks.map((entry) =>
            !works.includes(entry)
              ? entry
              : {
                  ...entry,
                  managerId: created.id,
                  notification:
                    entry.lifecycle.phase === "authorized"
                      ? { phase: "pending" }
                      : entry.notification,
                },
          ),
        },
        { managerId: created.id },
        [
          ...(qualification.status === "qualified"
            ? [
                {
                  type: "system.launch" as const,
                  managerId: created.id,
                  profileId: qualification.profileId,
                },
              ]
            : []),
          ...batches.map((entry): FactoryEffectIntent => ({
            type: "improvement.notify",
            batchId: entry.id,
            managerId: created.id,
            digest: entry.digest,
          })),
          ...works
            .filter((entry) => entry.lifecycle.phase === "authorized")
            .map((entry): FactoryEffectIntent => ({
              type: "workflow.work.notify",
              workId: entry.id,
              managerId: created.id,
            })),
        ],
      );
    }
    case "system.retry": {
      if (!human) return fail("Only the human can retry the system manager.");
      if (
        !manager ||
        manager.id !== command.managerId ||
        manager.role !== "system" ||
        manager.status !== "blocked"
      )
        return fail("The system manager is not awaiting a retry.", "invalid-state");
      const creation = input.systemManagerCreation;
      if (!creation || creation.threadId !== manager.threadId)
        return fail("Retry requires host qualification for the same manager.", "invalid-state");
      // Once its thread exists the manager's workspace, model and skills commit are pinned, so a
      // retry can only relaunch the same qualified profile. Before that it records the current
      // skills commit.
      if (
        manager.threadStatus === "created" &&
        (command.modelSelection !== undefined ||
          creation.qualification.status !== "qualified" ||
          manager.qualification.status !== "qualified" ||
          creation.qualification.profileId !== manager.qualification.profileId)
      )
        return fail(
          "A created system-manager thread retains its pinned workspace and model.",
          "invalid-state",
        );
      const pin =
        manager.threadStatus === "created"
          ? Result.succeed(manager.workflow)
          : factorySkillsPin(input.skills);
      if (Result.isFailure(pin)) return Result.fail(pin.failure);
      const modelSelection = command.modelSelection ?? manager.modelSelection;
      if (
        !isFactoryModelApproved(
          resolveFactoryModelPolicy(
            state.modelDefaults,
            manager.modelOverrides,
            manager.modelSelection,
          ),
          modelSelection,
        )
      )
        return fail("Select an approved system-manager model.");
      const qualification = creation.qualification;
      const updated: FactoryManager = {
        ...manager,
        qualification,
        workflow: pin.success,
        modelSelection,
        status: qualification.status === "qualified" ? "onboarding" : "blocked",
        wait:
          qualification.status === "unavailable"
            ? { kind: "execution-boundary", reason: qualification.reason }
            : null,
        updatedAt: now,
      };
      return accepted(
        { managers: state.managers.map((entry) => (entry.id === manager.id ? updated : entry)) },
        { managerId: manager.id },
        qualification.status === "qualified"
          ? [{ type: "system.launch", managerId: manager.id, profileId: qualification.profileId }]
          : [],
      );
    }
    case "system.launch.recorded":
    case "system.launch.failed": {
      if (!host) return fail("System-manager launch receipts are host-owned.");
      if (
        !manager ||
        manager.id !== command.managerId ||
        manager.role !== "system" ||
        manager.qualification.status !== "qualified" ||
        manager.qualification.profileId !== command.profileId
      )
        return fail("The system-manager profile changed.", "stale-revision");
      // A receipt after a delivered launch changes nothing. A failure blocks the manager until the
      // human retries, and remembers whether its thread was already created.
      if (manager.launchStatus === "delivered") return accepted();
      const delivered = command.type === "system.launch.recorded";
      return accepted(
        {
          managers: state.managers.map((entry) =>
            entry.id !== manager.id
              ? entry
              : {
                  ...manager,
                  threadStatus:
                    delivered || (command.type === "system.launch.failed" && command.threadCreated)
                      ? "created"
                      : manager.threadStatus,
                  launchStatus: delivered ? "delivered" : "pending",
                  status: delivered ? "active" : "blocked",
                  wait:
                    command.type === "system.launch.failed"
                      ? { kind: "execution-boundary", reason: command.reason }
                      : null,
                  updatedAt: now,
                },
          ),
        },
        { managerId: manager.id },
        delivered ? [{ type: "improvement.reconcile" }] : [],
      );
    }
    case "improvement.configure":
      if (!human) return fail("Review collection settings belong to the human.");
      return accepted(
        {
          improvementConfigurations: [
            ...state.improvementConfigurations,
            {
              id: `improvement-config:${command.commandId}`,
              enabled: command.enabled,
              routineThreshold: command.routineThreshold,
              maxAgeHours: command.maxAgeHours,
              sampleEvery: command.sampleEvery,
              maxBatchItems: command.maxBatchItems,
              maxSummaryChars: command.maxSummaryChars,
              routineBatchesPerDay: command.routineBatchesPerDay,
              urgentBatchesPerDay: command.urgentBatchesPerDay,
              approvedBy: command.commandId,
              approvedAt: now,
            },
          ],
        },
        {},
        [{ type: "improvement.reconcile" }],
      );
    case "improvement.flush": {
      if (!human) return fail("Only the human can flush a review batch.");
      const kind = command.kind ?? "routine";
      if (factoryImprovementBatchPlan(state, now, { kind, force: true })) return seal(kind, true);
      const settings = factoryImprovementConfiguration(state);
      return fail(
        !settings.enabled
          ? "Shared evidence review is disabled."
          : !availableManager(state)
            ? "The system manager is not available to review evidence."
            : state.improvementBatches.some(
                  (entry) => entry.kind === kind && entry.delivery.status === "pending",
                )
              ? `${kind === "urgent" ? "An escalation" : "A routine"} batch is already waiting for delivery.`
              : !pending(state, kind).length
                ? `No ${kind === "urgent" ? "escalations are" : "routine findings are"} waiting.`
                : "Today's routine allowance is spent. Raise it in review settings to review now.",
        "invalid-state",
      );
    }
    case "improvement.batch.retry": {
      if (!human) return fail("Only the human can retry a failed review delivery.");
      const batch = state.improvementBatches.find((entry) => entry.id === command.batchId);
      if (!batch || batch.delivery.status !== "pending" || !batch.delivery.failure)
        return fail("This review batch is not waiting for a delivery retry.", "invalid-state");
      // The notify effect stays pending while a failure is recorded; clearing it resumes delivery.
      return accepted(
        {
          improvementBatches: state.improvementBatches.map((entry) =>
            entry.id !== batch.id ? entry : { ...entry, delivery: { status: "pending" } },
          ),
        },
        { batchId: batch.id },
        [{ type: "improvement.reconcile" }],
      );
    }
    case "improvement.batch.failed": {
      if (!host) return fail("Review delivery failures are host-owned.");
      const batch = state.improvementBatches.find((entry) => entry.id === command.batchId);
      if (!batch || batch.digest !== command.digest)
        return fail("The failure receipt does not match its frozen batch.", "invalid-state");
      if (batch.delivery.status === "delivered") return accepted({}, { batchId: batch.id });
      return accepted(
        {
          improvementBatches: state.improvementBatches.map((entry) =>
            entry.id !== batch.id
              ? entry
              : { ...entry, delivery: { status: "pending", failure: command.reason } },
          ),
        },
        { batchId: batch.id },
      );
    }
    case "improvement.intake": {
      if (!host) return fail("Evidence intake is host-owned.");
      const finding = state.findings.find((entry) => entry.id === command.findingId);
      const assignment = state.assignments.find((entry) => entry.id === finding?.assignmentId);
      if (
        !finding ||
        !assignment ||
        factoryImprovementFindingDigest(finding) !== command.sourceDigest
      )
        return fail("Finding evidence changed before intake.", "stale-revision");
      if (
        command.origin === "explicit-escalation"
          ? !finding.escalation
          : !factoryImprovementRetroFindingIds(state).includes(finding.id)
      )
        return fail(
          "Intake requires an explicit escalation or a completed manager-retro finding.",
          "invalid-state",
        );
      // A repeat for the same finding version is a no-op, and a retro intake never downgrades an
      // escalation.
      const previous = state.improvementIntakes.findLast((entry) => entry.findingId === finding.id);
      if (
        previous?.sourceDigest === command.sourceDigest &&
        (previous.origin === command.origin || previous.origin === "explicit-escalation")
      )
        return accepted({}, { intakeId: previous.id });
      // Routing facts lead the summary so batch truncation cuts the long problem text first.
      const summary = truncate(
        [
          `Cause: ${finding.route.suspectedCause}. Containment of: ${finding.containmentOf ?? "none"}.`,
          `Uncertainty: ${truncate(finding.route.uncertainty, 300)}`,
          ...(finding.escalation ? [`Escalation: ${finding.escalation.summary}`] : []),
          finding.problem,
          `Impact: ${finding.impact}`,
        ].join("\n"),
        6_000,
      );
      // Escalating a finding whose intake is not yet batched promotes that intake in place, so the
      // finding never waits in two queues and an unsampled local finding enters review. Its sampling
      // record stays so later local ordinals do not shift.
      if (
        command.origin === "explicit-escalation" &&
        previous &&
        previous.delivery.phase !== "batched"
      ) {
        const promoted: FactoryImprovementIntake = {
          ...previous,
          sourceDigest: command.sourceDigest,
          origin: command.origin,
          summary,
          delivery: { phase: "queued" },
        };
        return accepted(
          {
            improvementIntakes: state.improvementIntakes.map((entry) =>
              entry.id === previous.id ? promoted : entry,
            ),
          },
          { intakeId: previous.id },
          [{ type: "improvement.reconcile" }],
        );
      }
      // Implementation and project causes from retros are sampled per project, queuing every
      // `sampleEvery`th one. Escalations and all other causes are always queued.
      const local =
        command.origin === "retro" &&
        ["implementation", "project"].includes(finding.route.suspectedCause);
      const ordinal =
        1 +
        state.improvementIntakes.filter(
          (entry) => entry.projectId === assignment.projectId && entry.sampling.kind === "local",
        ).length;
      const selected = !local || ordinal % factoryImprovementConfiguration(state).sampleEvery === 0;
      const id = `improvement-intake:${command.commandId}`;
      const receipt: FactoryImprovementIntake = {
        id,
        findingId: finding.id,
        sourceDigest: command.sourceDigest,
        projectId: assignment.projectId,
        assignmentId: assignment.id,
        origin: command.origin,
        sampling: local ? { kind: "local", ordinal, selected } : { kind: "all" },
        summary,
        queuedAt: now,
        delivery: { phase: selected ? "queued" : "skipped" },
      };
      return accepted(
        { improvementIntakes: [...state.improvementIntakes, receipt] },
        { intakeId: id },
        selected ? [{ type: "improvement.reconcile" }] : [],
      );
    }
    case "improvement.batch.requested":
      if (!host) return fail("Review batches are sealed by the host.");
      if (command.expectedStateRevision !== state.revision)
        return fail("Review evidence changed before sealing.", "stale-revision");
      return seal(command.kind, command.force);
    case "improvement.batch.delivered": {
      if (!host) return fail("Review delivery receipts are host-owned.");
      const batch = state.improvementBatches.find((entry) => entry.id === command.batchId);
      if (!batch || batch.digest !== command.digest)
        return fail("The delivery receipt does not match its frozen batch.", "invalid-state");
      // Delivery is recorded once; a replay must name the same message.
      if (batch.delivery.status === "delivered")
        return batch.delivery.messageId === command.messageId
          ? accepted({}, { batchId: batch.id })
          : fail("A delivered batch cannot change its message.", "invalid-state");
      return accepted(
        {
          improvementBatches: state.improvementBatches.map((entry) =>
            entry.id !== batch.id
              ? entry
              : {
                  ...entry,
                  delivery: { status: "delivered", messageId: command.messageId, deliveredAt: now },
                },
          ),
        },
        { batchId: batch.id },
        [{ type: "improvement.reconcile" }],
      );
    }
    case "investigation.open": {
      if (!canInvestigate)
        return fail("Only the human or active system manager can investigate shared evidence.");
      if (
        !attachableFindings(command.findingIds, human) ||
        !relatedValid(command.relatedInvestigationIds)
      )
        return fail(
          "Attach sampled intake findings and existing related investigations.",
          "invalid-state",
        );
      const id = `investigation:${command.commandId}`;
      return accepted(
        {
          improvementInvestigations: [
            ...state.improvementInvestigations,
            {
              id,
              title: command.title,
              findingIds: command.findingIds,
              relatedInvestigationIds: command.relatedInvestigationIds,
              uncertainty: command.uncertainty,
              assessment: "",
              lifecycle: { phase: "open" },
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
        { investigationId: id },
      );
    }
    // Records each bounded read made through FactoryImprovementEvidence, so an investigation keeps
    // the provenance of what the system manager read.
    case "improvement.evidence.read": {
      if (!host) return fail("Investigation read receipts are host-owned.");
      const investigation = state.improvementInvestigations.find(
        (entry) => entry.id === command.investigationId,
      );
      const finding = state.findings.find((entry) => entry.id === command.findingId);
      const assignment = state.assignments.find((entry) => entry.id === finding?.assignmentId);
      if (
        !manager ||
        manager.id !== command.managerId ||
        !availableManager(state) ||
        !investigation ||
        investigation.lifecycle.phase === "closed" ||
        !investigation.findingIds.includes(command.findingId) ||
        !finding ||
        !assignment ||
        !finding.evidence.some(
          (ref) => stableStringify(ref) === stableStringify(command.evidenceRef),
        ) ||
        command.characters > command.limit
      )
        return fail("The read no longer belongs to the active manager's named investigation.");
      return accepted({
        improvementEvidenceReads: [
          ...state.improvementEvidenceReads,
          {
            id: `improvement-read:${command.commandId}`,
            managerId: command.managerId,
            investigationId: investigation.id,
            findingId: finding.id,
            evidenceRef: command.evidenceRef,
            digest: command.digest,
            characters: command.characters,
            cursor: command.cursor,
            limit: command.limit,
            projectId: assignment.projectId,
            assignmentId: assignment.id,
            readAt: now,
          },
        ],
      });
    }
    case "investigation.update": {
      if (!canInvestigate)
        return fail("Only the human or active system manager can update an investigation.");
      const investigation = state.improvementInvestigations.find(
        (entry) => entry.id === command.investigationId,
      );
      if (
        !investigation ||
        !attachableFindings(command.findingIds, true) ||
        !relatedValid(command.relatedInvestigationIds, investigation.id)
      )
        return fail(
          "Investigation references must name existing retained evidence.",
          "invalid-state",
        );
      return accepted(
        {
          improvementInvestigations: state.improvementInvestigations.map((entry) =>
            entry.id !== investigation.id
              ? entry
              : {
                  ...entry,
                  findingIds: command.findingIds,
                  relatedInvestigationIds: command.relatedInvestigationIds,
                  uncertainty: command.uncertainty,
                  assessment: command.assessment,
                  lifecycle: command.lifecycle,
                  updatedAt: now,
                },
          ),
        },
        { investigationId: investigation.id },
      );
    }
    case "proposal.write": {
      if (!canInvestigate)
        return fail("Only the human or active system manager can write a shared proposal.");
      const investigation = state.improvementInvestigations.find(
        (entry) => entry.id === command.investigationId,
      );
      const previous = state.improvementProposals.findLast(
        (entry) => entry.id === command.proposalId,
      );
      if (
        !investigation ||
        investigation.lifecycle.phase === "closed" ||
        (command.proposalId !== undefined &&
          (!previous || previous.investigationId !== investigation.id))
      )
        return fail("The proposal must belong to its open investigation.", "invalid-state");
      if (
        command.content.scope.kind === "projects" &&
        (new Set(command.content.scope.projectIds).size !==
          command.content.scope.projectIds.length ||
          command.content.scope.projectIds.some(
            (id) =>
              !state.managers.some((entry) => entry.role === "project" && entry.projectId === id),
          ))
      )
        return fail("Proposal project scope must name managed projects.", "invalid-state");
      const id = command.proposalId ?? `proposal:${command.commandId}`;
      const revision = `proposal-revision:${command.commandId}`;
      return accepted(
        {
          improvementProposals: [
            // An undecided older revision can no longer be decided, so retire it from review.
            ...state.improvementProposals.map((entry) =>
              entry.id === id && (entry.phase === "draft" || entry.phase === "human-review")
                ? { ...entry, phase: "superseded" as const }
                : entry,
            ),
            {
              id,
              revision,
              investigationId: investigation.id,
              content: command.content,
              phase: "draft",
              createdAt: now,
              submittedAt: null,
            },
          ],
        },
        { proposalId: id, proposalRevision: revision },
      );
    }
    case "proposal.submit":
    case "proposal.decide":
    case "proposal.feedback": {
      if (command.type === "proposal.submit" && !canInvestigate)
        return fail("Only the human or active system manager can submit a shared proposal.");
      if (command.type !== "proposal.submit" && !human)
        return fail("Proposal decisions and usefulness feedback belong to the human.");
      const proposal = state.improvementProposals.find(
        (entry) => entry.id === command.proposalId && entry.revision === command.revision,
      );
      if (!proposal) return fail("The proposal revision was not found.", "invalid-state");
      // Feedback may rate any revision. Only the newest can be submitted or decided.
      if (command.type === "proposal.feedback")
        return accepted(
          {
            improvementFeedback: [
              ...state.improvementFeedback,
              {
                id: `improvement-feedback:${command.commandId}`,
                proposalId: proposal.id,
                revision: proposal.revision,
                usefulness: command.usefulness,
                reason: command.reason,
                recordedAt: now,
              },
            ],
          },
          { proposalId: proposal.id, proposalRevision: proposal.revision },
        );
      if (
        state.improvementProposals.findLast((entry) => entry.id === proposal.id)?.revision !==
        proposal.revision
      )
        return fail("A newer proposal revision requires fresh human review.", "stale-revision");
      if (command.type === "proposal.submit") {
        if (
          proposal.phase !== "draft" ||
          state.improvementInvestigations.find((entry) => entry.id === proposal.investigationId)
            ?.lifecycle.phase === "closed"
        )
          return fail("Only a draft from an open investigation can be submitted.", "invalid-state");
        return accepted(
          {
            improvementProposals: state.improvementProposals.map((entry) =>
              entry.revision !== proposal.revision
                ? entry
                : { ...entry, phase: "human-review", submittedAt: now },
            ),
          },
          { proposalId: proposal.id, proposalRevision: proposal.revision },
        );
      }
      // A deferred revision stays open to a later human decision on the same exact content.
      const deferred =
        proposal.phase === "decided" &&
        state.improvementDecisions.findLast(
          (entry) => entry.proposalId === proposal.id && entry.revision === proposal.revision,
        )?.outcome === "deferred";
      if (proposal.phase !== "human-review" && !deferred)
        return fail("This exact revision is not awaiting human review.", "invalid-state");
      return accepted(
        {
          improvementProposals: state.improvementProposals.map((entry) =>
            entry.revision !== proposal.revision ? entry : { ...entry, phase: "decided" },
          ),
          improvementDecisions: [
            ...state.improvementDecisions,
            {
              proposalId: proposal.id,
              revision: proposal.revision,
              outcome: command.outcome,
              reason: command.reason,
              commandId: command.commandId,
              decidedAt: now,
            },
          ],
        },
        { proposalId: proposal.id, proposalRevision: proposal.revision },
      );
    }
    case "investigation.recurrence": {
      if (!canInvestigate)
        return fail("Only the human or active system manager can identify recurrence.");
      const investigation = state.improvementInvestigations.find(
        (entry) => entry.id === command.investigationId,
      );
      if (!investigation || !attachableFindings([command.findingId], true))
        return fail(
          "Recurrence must reference a retained finding and existing investigation.",
          "invalid-state",
        );
      if (
        state.improvementRecurrences.some(
          (entry) =>
            entry.investigationId === investigation.id && entry.findingId === command.findingId,
        )
      )
        return accepted({});
      return accepted(
        {
          improvementRecurrences: [
            ...state.improvementRecurrences,
            {
              id: `improvement-recurrence:${command.commandId}`,
              investigationId: investigation.id,
              findingId: command.findingId,
              reason: command.reason,
              recordedAt: now,
            },
          ],
        },
        { investigationId: investigation.id },
      );
    }
  }
}
