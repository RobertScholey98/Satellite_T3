import {
  FactoryError,
  type FactoryAssignment,
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
  readonly workflow: FactoryWorkflowVersion;
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
    completion: initialFactoryCompletion(work.scope, manager.id),
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
    workflow: input.workflow,
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
