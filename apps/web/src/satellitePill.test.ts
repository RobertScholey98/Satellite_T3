import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { projectSatellitePill, type PillThread } from "./satellitePill";

type PillInput = Parameters<typeof projectSatellitePill>[0];
const ref = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("selected"));
const timestamp = "2026-09-29T12:00:00Z";
const runId = RunId.make("run-1");
const completedRun = {
  runId,
  status: "completed" as const,
  requestedAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
  assistantMessageId: null,
};
const runningRuntime = {
  status: "running" as const,
  activeRunId: runId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: timestamp,
};
function thread(overrides: Partial<PillThread> = {}): PillThread {
  return {
    title: "Fix remote navigation",
    runtime: null,
    latestRun: null,
    settledAt: null,
    settledOverride: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    pendingBackgroundTasks: [],
    ...overrides,
  };
}
function project(overrides: Partial<PillInput> = {}) {
  return projectSatellitePill({
    ref,
    thread: thread(),
    connectionPhase: "connected",
    shellStatus: "live",
    ...overrides,
  });
}

describe("Satellite conversation projection", () => {
  it("keeps environment and conversation identity together", () => {
    expect(project()).toMatchObject({
      environmentId: "remote",
      threadId: "selected",
      title: "Fix remote navigation",
      state: "idle",
    });
    expect(project({ ref: null, thread: null })).toMatchObject({
      environmentId: null,
      threadId: null,
      state: "idle",
      detail: "Choose a conversation",
    });
  });
  it("never reports cached work or completion as live while disconnected", () => {
    for (const connectionPhase of ["offline", "reconnecting", "error", null] as const) {
      expect(
        project({ connectionPhase, thread: thread({ latestRun: completedRun }) }),
      ).toMatchObject({ state: "unknown", attention: false });
    }
    expect(
      project({ shellStatus: "cached", thread: thread({ runtime: runningRuntime }) }),
    ).toMatchObject({ state: "unknown", detail: "Synchronizing conversation" });
    expect(project({ thread: null })).toMatchObject({ state: "unknown" });
  });
  it("uses pending request evidence even while the provider reports running", () => {
    expect(
      project({ thread: thread({ runtime: runningRuntime, hasPendingApprovals: true }) }),
    ).toMatchObject({ state: "awaiting-input", detail: "Approval needed", attention: true });
    expect(
      project({ thread: thread({ runtime: runningRuntime, hasPendingUserInput: true }) }),
    ).toMatchObject({ state: "awaiting-input", detail: "Input needed", attention: true });
    expect(project({ thread: thread({ runtime: runningRuntime }) })).toMatchObject({
      state: "working",
      attention: false,
    });
  });
  it("does not invent completion from idle, cancelled, or interrupted runtimes", () => {
    for (const status of ["idle", "cancelled", "interrupted"] as const) {
      expect(
        project({ thread: thread({ runtime: { ...runningRuntime, status, activeRunId: null } }) })
          .state,
      ).toBe("idle");
    }
    expect(
      project({ thread: thread({ latestRun: { ...completedRun, status: "interrupted" } }) }).state,
    ).toBe("idle");
  });
  it("requires explicit run success or settlement for completion", () => {
    expect(project({ thread: thread({ latestRun: completedRun }) })).toMatchObject({
      state: "completed",
      detail: "Turn completed",
    });
    expect(
      project({ thread: thread({ settledOverride: "settled", settledAt: timestamp }) }),
    ).toMatchObject({ state: "completed", detail: "Conversation settled" });
    expect(
      project({ thread: thread({ latestRun: { ...completedRun, completedAt: null } }) }).state,
    ).toBe("idle");
  });
  it("preserves live background work after a completed run", () => {
    expect(
      project({
        thread: thread({
          latestRun: completedRun,
          pendingBackgroundTasks: [{ taskId: "task", kind: "subagent" }],
        }),
      }),
    ).toMatchObject({ state: "working", detail: "Background work running" });
    expect(
      project({
        thread: thread({
          latestRun: completedRun,
          pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }],
        }),
      }),
    ).toMatchObject({ state: "working", detail: "Monitoring" });
  });
  it("reports structured plan review as awaiting input", () => {
    expect(
      project({
        thread: thread({
          latestRun: completedRun,
          interactionMode: "plan",
          hasActionableProposedPlan: true,
        }),
      }),
    ).toMatchObject({ state: "awaiting-input", detail: "Plan ready for review", attention: true });
  });
  it("shows failures and clears them when a fresh run starts", () => {
    const failed = { ...completedRun, status: "failed" as const };
    expect(
      project({
        thread: thread({
          latestRun: failed,
          runtime: { ...runningRuntime, status: "failed", lastError: "Provider unavailable" },
        }),
      }),
    ).toMatchObject({ state: "error", detail: "Provider unavailable", attention: true });
    expect(
      project({ thread: thread({ latestRun: failed, runtime: runningRuntime }) }),
    ).toMatchObject({ state: "working", attention: false });
  });
});
