import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { deriveLatestThreadRun, deriveThreadRuntime } from "./threadExecution.ts";
function latestUserMessageAt(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell["latestUserMessageAt"] {
  for (let index = projection.messages.length - 1; index >= 0; index -= 1) {
    const message = projection.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }

  return null;
}

/**
 * Builds an optimistic thread shell from the detail projection for the window
 * where the shell list has not materialized the thread yet (e.g. a thread that
 * was just created from this device).
 */
export function presentThreadProjectionShell(
  environmentId: EnvironmentId,
  projection: OrchestrationV2ThreadProjection,
): EnvironmentThreadShell {
  const thread = projection.thread;
  const latestRun = deriveLatestThreadRun(projection);
  const runtime = deriveThreadRuntime(projection);
  const pendingRequest =
    projection.runtimeRequests.find((request) => request.status === "pending") ?? null;
  const pendingRequests = projection.runtimeRequests.filter(
    (request) => request.status === "pending",
  );
  const shell = presentThreadShell(environmentId, {
    id: thread.id,
    purpose: thread.purpose,
    commitRecommendation: thread.commitRecommendation,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    linkedPullRequest: thread.linkedPullRequest ?? null,
    pullRequests: thread.pullRequests,
    branchPullRequest: thread.branchPullRequest ?? null,
    activeProviderThreadId: thread.activeProviderThreadId,
    lineage: thread.lineage,
    forkedFrom: thread.forkedFrom,
    createdBy: thread.createdBy,
    creationSource: thread.creationSource,
    latestRunId: latestRun?.runId ?? null,
    activeRunId: runtime?.activeRunId ?? null,
    status: runtime?.status ?? "idle",
    pendingRuntimeRequest:
      pendingRequest === null
        ? null
        : { id: pendingRequest.id, kind: pendingRequest.kind, createdAt: pendingRequest.createdAt },
    pendingRequests: pendingRequests.flatMap((request) =>
      request.kind === "auth_refresh" || request.kind === "dynamic_tool_call"
        ? []
        : [
            {
              requestId: request.id,
              kind: request.kind === "user_input" ? "question" : "approval",
              createdAt: DateTime.formatIso(request.createdAt),
            },
          ],
    ),
    latestVisibleMessage: null,
    latestUserMessageAt: latestUserMessageAt(projection),
    hasActionableProposedPlan: false,
    itemCount: projection.turnItems.length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    unsettledAt: thread.unsettledAt,
    activeOrderKey: thread.activeOrderKey,
    autoSettleDisabledAt: thread.autoSettleDisabledAt,
    pinnedAt: thread.pinnedAt,
    pinOrderKey: thread.pinOrderKey,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    deletedAt: thread.deletedAt,
  });
  return { ...shell, runtime, latestRun };
}
