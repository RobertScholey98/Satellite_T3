import {
  FactoryError,
  factorySystemManager,
  type FactoryAssignment,
  type FactoryCommand,
  type FactoryBoundary,
  type FactoryManager,
  type FactoryPolicy,
  type FactorySnapshot,
  type FactorySupportingWork,
  type FactoryWorkflowVersion,
  type CommandId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { initialFactoryCompletion } from "./FactoryRetros.ts";
import { initialFactoryOversight } from "./FactoryOversight.ts";
import { resolveFactoryModelPolicy, selectFactoryModel } from "./FactoryModelPolicy.ts";
import type { FactoryAllocation } from "./FactoryState.ts";

/**
 * The skills repository's HEAD, which the service reads once per command that creates a manager
 * or assignment. Whatever the command creates records it as its pinned `workflow`.
 */
export interface FactorySkillsContext {
  readonly skills?: FactoryWorkflowVersion;
}

/**
 * Whether deciding `command` against `state` records a new skills pin, so the service must read
 * the repository's HEAD first. A retry of a manager whose thread already launched keeps its
 * recorded commit and so works whatever the setting holds now.
 */
export function factoryCommandRecordsSkills(
  command: FactoryCommand,
  state: FactorySnapshot,
): boolean {
  switch (command.type) {
    case "manager.create":
    case "assignment.commission":
    case "assignment.handover":
    case "integration.commission":
    case "system.create":
    case "shared.repository.register":
      return true;
    case "shared.work.commission":
    case "experiment.commission":
      return factorySystemManager(state.managers) !== undefined;
    case "collaboration.request.respond": {
      if (command.response.kind !== "accept" || command.response.support.kind !== "commission")
        return false;
      const request = state.crossProjectRequests.find((entry) => entry.id === command.requestId);
      return state.managers.some((manager) => manager.id === request?.receiverManagerId);
    }
    case "manager.retry-onboarding": {
      const manager = state.managers.find((entry) => entry.id === command.managerId);
      const assignment = state.assignments.find((entry) => entry.managerId === manager?.id);
      return (
        manager !== undefined &&
        assignment !== undefined &&
        manager.threadStatus !== "created" &&
        assignment.threadStatus !== "created"
      );
    }
    case "system.retry": {
      const manager = state.managers.find((entry) => entry.id === command.managerId);
      return manager !== undefined && manager.threadStatus !== "created";
    }
    default:
      return false;
  }
}

/**
 * The pin a command records. The service reads it for every command `factoryCommandRecordsSkills`
 * names, so a missing one is a broken invariant rather than a missing setting.
 */
export function factorySkillsPin(
  skills: FactoryWorkflowVersion | undefined,
): Result.Result<FactoryWorkflowVersion, FactoryError> {
  return skills === undefined
    ? Result.fail(
        new FactoryError({
          code: "invalid-state",
          detail: "The command was decided without the skills commit it records.",
        }),
      )
    : Result.succeed(skills);
}

/**
 * Builds a new pending assignment from approved supporting work. Every path that creates an
 * assignment (state transitions, collaboration, workflow and integration) goes through here so
 * the lead's model is chosen and the grant is shaped the same way. Refuses a missing allocation
 * or one whose ids are already in use. With `existingThreadId`, the assignment takes over that
 * human thread as a handover and starts by stopping it rather than capturing source.
 */
export function commissionFactoryAssignment(input: {
  readonly state: FactorySnapshot;
  readonly manager: FactoryManager;
  readonly boundary: FactoryBoundary;
  readonly work: FactorySupportingWork;
  readonly allocation: FactoryAllocation | undefined;
  readonly skills: FactorySkillsContext["skills"];
  readonly policy: FactoryPolicy;
  readonly authorization: NonNullable<FactoryAssignment["authorization"]>;
  readonly controlAuthorizationId: CommandId | string;
  readonly now: string;
  readonly existingThreadId?: ThreadId;
  readonly sharedWork?: FactoryAssignment["sharedWork"];
}): Result.Result<FactoryAssignment, FactoryError> {
  const { state, manager, boundary, work, allocation, now } = input;
  if (
    !allocation ||
    state.assignments.some(
      (entry) => entry.id === allocation.assignmentId || entry.threadId === allocation.leadThreadId,
    ) ||
    state.managers.some((entry) => entry.threadId === allocation.leadThreadId) ||
    state.auxiliaryThreads.some((entry) => entry.threadId === allocation.leadThreadId) ||
    (input.existingThreadId !== undefined && allocation.leadThreadId !== input.existingThreadId)
  ) {
    return Result.fail(new FactoryError({ code: "invalid-state" }));
  }
  const pin = factorySkillsPin(input.skills);
  if (Result.isFailure(pin)) return Result.fail(pin.failure);
  const modelPolicy = resolveFactoryModelPolicy(
    state.modelDefaults,
    manager.modelOverrides,
    manager.modelSelection,
  );
  const selected = selectFactoryModel({
    policy: modelPolicy,
    ...(manager.modelOverrides === undefined ? {} : { overrides: manager.modelOverrides }),
    role: "lead",
    complexity: work.complexity,
    ...(work.modelSelection === undefined ? {} : { selection: work.modelSelection }),
  });
  if (Result.isFailure(selected)) return Result.fail(selected.failure);
  const controls = work.controlPaths ?? [];
  return Result.succeed({
    id: allocation.assignmentId,
    managerId: manager.id,
    threadId: allocation.leadThreadId,
    projectId: boundary.projectId,
    ...(input.sharedWork === undefined ? {} : { sharedWork: input.sharedWork }),
    kind: work.kind,
    title: work.title,
    scope: work.scope,
    completion: initialFactoryCompletion(work.scope),
    oversight: initialFactoryOversight(),
    complexity: work.complexity,
    modelSelection: selected.success.selection,
    modelChoice: selected.success,
    modelPolicy,
    origin: input.existingThreadId === undefined ? "new" : "handover",
    preparation: input.existingThreadId === undefined ? "capturing" : "stopping",
    authorization: input.authorization,
    status: "pending",
    threadStatus: input.existingThreadId === undefined ? "pending" : "created",
    launchStatus: "pending",
    qualification: {
      status: "unavailable",
      reason: "Preparing the assignment's approved execution environment.",
    },
    workflow: pin.success,
    grantedPolicy: input.policy,
    grant: {
      boundaryId: boundary.id,
      epoch: 0,
      sourcePaths: work.sourcePaths,
      creatableDirectories: work.creatableDirectories,
      controlChange:
        controls.length === 0
          ? null
          : { authorizationId: input.controlAuthorizationId, paths: controls },
    },
    wait: null,
    report: null,
    createdAt: now,
    updatedAt: now,
  });
}
