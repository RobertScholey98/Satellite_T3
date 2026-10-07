import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationV2ThreadProjection,
  SatellitePillState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

export type PillThread = Pick<
  EnvironmentThreadShell,
  | "title"
  | "runtime"
  | "latestRun"
  | "settledAt"
  | "settledOverride"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "pendingBackgroundTasks"
>;

function concise(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

/** Projects existing server evidence; the native window never owns conversation state. */
export function projectSatellitePill(input: {
  ref: ScopedThreadRef | null;
  thread: PillThread | null;
  connectionPhase: EnvironmentConnectionPhase | null;
  shellStatus: EnvironmentShellStatus | null;
  projection?: OrchestrationV2ThreadProjection | undefined;
}): SatellitePillState {
  const { ref, thread } = input;
  const base = {
    threadId: ref?.threadId ?? null,
    environmentId: ref?.environmentId ?? null,
    title: concise(thread?.title ?? "SatelliteT3"),
  };
  const state = (
    value: SatellitePillState["state"],
    detail: string,
    attention = false,
  ): SatellitePillState => ({ ...base, state: value, detail: concise(detail), attention });

  if (ref === null) return state("idle", "Choose a conversation");
  if (input.connectionPhase !== "connected") {
    return state(
      "unknown",
      input.connectionPhase === "connecting"
        ? "Connecting to environment"
        : input.connectionPhase === "reconnecting"
          ? "Reconnecting to environment"
          : input.connectionPhase === "error" || input.connectionPhase === "unsupported"
            ? "Environment connection failed"
            : "Environment disconnected",
    );
  }
  if (input.shellStatus !== "live") return state("unknown", "Synchronizing conversation");
  if (thread === null) return state("unknown", "Conversation unavailable");

  if (thread.hasPendingApprovals) return state("awaiting-input", "Approval needed", true);
  if (thread.hasPendingUserInput) return state("awaiting-input", "Input needed", true);

  const sessionRunning =
    thread.runtime?.status === "running" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "preparing";
  if (
    thread.runtime?.status === "failed" ||
    (!sessionRunning && thread.latestRun?.status === "failed")
  ) {
    return state("error", thread.runtime?.lastError ?? "Turn failed", true);
  }

  const turnRunning =
    thread.latestRun?.status === "running" &&
    thread.runtime?.status !== "interrupted" &&
    thread.runtime?.status !== "cancelled";
  const backgroundRunning = backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks);
  if (
    !sessionRunning &&
    !turnRunning &&
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    thread.latestRun?.status === "completed"
  ) {
    return state("awaiting-input", "Plan ready for review", true);
  }
  if (sessionRunning || turnRunning || backgroundRunning || thread.runtime?.status === "queued") {
    const activePlan = input.projection?.plans.findLast(
      (artifact) => artifact.kind === "todo_list" && artifact.status === "active",
    );
    const runningStep =
      activePlan?.kind === "todo_list"
        ? activePlan.steps.find((step) => step.status === "running")?.text
        : undefined;
    return state(
      "working",
      runningStep ??
        (thread.pendingBackgroundTasks.some((task) => task.kind === "monitor")
          ? "Monitoring"
          : backgroundRunning
            ? "Background work running"
            : thread.runtime?.status === "starting" || thread.runtime?.status === "preparing"
              ? "Starting agent"
              : "Working"),
    );
  }
  if (thread.settledOverride === "settled" || thread.settledAt !== null) {
    return state("completed", "Conversation settled");
  }
  if (thread.latestRun?.status === "completed" && thread.latestRun.completedAt !== null) {
    return state("completed", "Turn completed");
  }
  return state(
    "idle",
    thread.runtime?.status === "interrupted" || thread.latestRun?.status === "interrupted"
      ? "Turn interrupted"
      : thread.runtime?.status === "cancelled"
        ? "Agent stopped"
        : "Ready for a message",
  );
}
