import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  SatellitePillState,
  ScopedThreadRef,
} from "@t3tools/contracts";

type PillThread = Pick<
  OrchestrationThreadShell,
  | "title"
  | "session"
  | "latestTurn"
  | "settledAt"
  | "settledOverride"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "backgroundLiveness"
  | "planProgress"
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
  activities?: ReadonlyArray<OrchestrationThreadActivity> | undefined;
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
    thread.session?.status === "running" || thread.session?.status === "starting";
  if (
    thread.session?.status === "error" ||
    (!sessionRunning && thread.latestTurn?.state === "error")
  ) {
    return state("error", thread.session?.lastError ?? "Turn failed", true);
  }

  const latestActivity = input.activities?.findLast(
    (activity) => activity.turnId === (thread.latestTurn?.turnId ?? null),
  );
  const turnRunning =
    thread.latestTurn?.state === "running" &&
    thread.session?.status !== "interrupted" &&
    thread.session?.status !== "stopped";
  if (
    !sessionRunning &&
    !turnRunning &&
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    thread.latestTurn?.state === "completed"
  ) {
    return state("awaiting-input", "Plan ready for review", true);
  }
  if (sessionRunning || turnRunning || thread.backgroundLiveness) {
    return state(
      "working",
      thread.planProgress?.step ??
        (sessionRunning || turnRunning ? latestActivity?.summary : null) ??
        (thread.backgroundLiveness === "monitoring"
          ? "Monitoring"
          : thread.backgroundLiveness === "working"
            ? "Background work running"
            : thread.session?.status === "starting"
              ? "Starting agent"
              : "Working"),
    );
  }
  if (thread.settledOverride === "settled" || thread.settledAt !== null) {
    return state("completed", "Conversation settled");
  }
  if (thread.latestTurn?.state === "completed" && thread.latestTurn.completedAt !== null) {
    return state("completed", "Turn completed");
  }
  return state(
    "idle",
    thread.session?.status === "interrupted" || thread.latestTurn?.state === "interrupted"
      ? "Turn interrupted"
      : thread.session?.status === "stopped"
        ? "Agent stopped"
        : "Ready for a message",
  );
}
