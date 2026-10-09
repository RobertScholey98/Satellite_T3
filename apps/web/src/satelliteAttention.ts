import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, SatelliteAttentionSummary } from "@t3tools/contracts";
import {
  EMPTY_REQUEST_DRAFT,
  isPendingDelivery,
  pendingRequestKey,
  type PendingRequestDraft,
} from "./pendingRequestStore";
import { projectSatellitePill, type PillThread } from "./satellitePill";

export type AttentionThread = PillThread &
  Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "archivedAt" | "updatedAt" | "pendingRequests"
  >;

export interface AttentionEnvironment {
  environmentId: EnvironmentId;
  label: string;
  available: boolean;
}

export function deriveSatelliteAttention(
  threads: ReadonlyArray<AttentionThread>,
  environments: ReadonlyArray<AttentionEnvironment>,
  drafts: Record<string, PendingRequestDraft>,
) {
  const items = new Map<string, SatelliteAttentionSummary>();
  const incomplete = new Set(
    environments
      .filter((environment) => !environment.available)
      .map((environment) => environment.label),
  );
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  let workingCount = 0;
  let completedCount = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const environment = byId.get(thread.environmentId);
    const environmentName = environment?.label ?? "Unknown environment";
    if (thread.pendingRequests === undefined) incomplete.add(environmentName);
    const base = {
      title: thread.title,
      environmentName,
      available: environment?.available ?? false,
      muted: false,
    };
    for (const request of thread.pendingRequests ?? []) {
      const ref = {
        environmentId: thread.environmentId,
        threadId: thread.id,
        kind: request.kind,
        requestId: request.requestId,
      };
      items.set(pendingRequestKey(ref), {
        ...base,
        ...request,
        ref,
        label: request.label ?? (request.kind === "approval" ? "Approval required" : "Question"),
        preview:
          request.preview ?? (request.kind === "approval" ? "Approval required" : "Question"),
      });
    }
    const relevant =
      thread.settledOverride !== "settled" &&
      (thread.settledAt === null || thread.settledOverride === "active");
    if (!relevant) continue;
    const status = projectSatellitePill({
      ref: { environmentId: thread.environmentId, threadId: thread.id },
      thread,
      connectionPhase: environment?.available ? "connected" : "available",
      shellStatus: environment?.available ? "live" : "cached",
    });
    if (status.state === "working") workingCount++;
    else if (status.state === "completed") completedCount++;
    const kind =
      status.state === "error"
        ? ("error" as const)
        : status.detail === "Plan ready for review"
          ? ("review" as const)
          : null;
    if (kind) {
      const ref = {
        environmentId: thread.environmentId,
        threadId: thread.id,
        kind,
        requestId: thread.latestRun?.runId ?? thread.runtime?.updatedAt ?? thread.updatedAt,
      };
      items.set(pendingRequestKey(ref), {
        ...base,
        ref,
        label: kind === "error" ? "Agent needs attention" : "Plan ready to review",
        preview:
          kind === "error"
            ? "Open the thread to inspect the failure and continue."
            : "Review the proposed plan in its thread.",
        createdAt: thread.latestRun?.completedAt ?? thread.updatedAt,
      });
    }
  }
  for (const [key, draft] of Object.entries(drafts)) {
    if (
      isPendingDelivery(draft.delivery) &&
      draft.delivery.submission.audience === "work" &&
      !items.has(key)
    ) {
      const summary = draft.delivery.submission.summary;
      const available = byId.get(summary.ref.environmentId)?.available ?? false;
      items.set(key, { ...summary, available });
    }
  }
  return {
    items: [...items.values()]
      .filter((item) => drafts[pendingRequestKey(item.ref)]?.delivery.phase !== "resolved")
      .map((item) => ({
        ...item,
        muted: (drafts[pendingRequestKey(item.ref)] ?? EMPTY_REQUEST_DRAFT).muted,
      }))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          pendingRequestKey(left.ref).localeCompare(pendingRequestKey(right.ref)),
      ),
    incompleteEnvironments: [...incomplete],
    workingCount,
    completedCount,
  };
}

export function selectAttentionItem(
  items: ReadonlyArray<SatelliteAttentionSummary>,
  key: string | null,
) {
  return (
    items.find((item) => !item.muted && pendingRequestKey(item.ref) === key) ??
    items.find((item) => !item.muted) ??
    null
  );
}
