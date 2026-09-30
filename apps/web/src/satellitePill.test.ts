import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, EventId, ThreadId, TurnId } from "@t3tools/contracts";

import { projectSatellitePill } from "./satellitePill";

type PillInput = Parameters<typeof projectSatellitePill>[0];
type PillThread = NonNullable<PillInput["thread"]>;

const ref = scopeThreadRef(
  EnvironmentId.make("remote-environment"),
  ThreadId.make("selected-thread"),
);
const turnId = TurnId.make("turn-1");
const timestamp = "2026-09-29T12:00:00Z";
const completedTurn = {
  turnId,
  state: "completed" as const,
  requestedAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
  assistantMessageId: null,
};

function thread(overrides: Partial<PillThread> = {}): PillThread {
  return {
    title: "Fix remote navigation",
    session: null,
    latestTurn: null,
    settledAt: null,
    settledOverride: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
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

const runningSession = {
  threadId: ref.threadId,
  status: "running" as const,
  providerName: "codex",
  runtimeMode: "full-access" as const,
  activeTurnId: turnId,
  lastError: null,
  updatedAt: timestamp,
};

describe("Satellite conversation projection", () => {
  it("keeps environment and conversation identity together", () => {
    expect(project()).toMatchObject({
      environmentId: "remote-environment",
      threadId: "selected-thread",
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
        project({ connectionPhase, thread: thread({ latestTurn: completedTurn }) }),
      ).toMatchObject({ state: "unknown", attention: false });
    }
    expect(
      project({ shellStatus: "cached", thread: thread({ session: runningSession }) }),
    ).toMatchObject({
      state: "unknown",
      detail: "Synchronizing conversation",
    });
    expect(project({ thread: null })).toMatchObject({ state: "unknown" });
  });

  it("uses pending request evidence even while the provider reports running", () => {
    expect(
      project({ thread: thread({ session: runningSession, hasPendingApprovals: true }) }),
    ).toMatchObject({ state: "awaiting-input", detail: "Approval needed", attention: true });
    expect(
      project({ thread: thread({ session: runningSession, hasPendingUserInput: true }) }),
    ).toMatchObject({ state: "awaiting-input", detail: "Input needed", attention: true });
    expect(project({ thread: thread({ session: runningSession }) })).toMatchObject({
      state: "working",
      attention: false,
    });
  });

  it("does not invent completion from ready, stopped, or interrupted sessions", () => {
    for (const status of ["idle", "ready", "stopped", "interrupted"] as const) {
      expect(
        project({ thread: thread({ session: { ...runningSession, status, activeTurnId: null } }) })
          .state,
      ).toBe("idle");
    }
    expect(
      project({ thread: thread({ latestTurn: { ...completedTurn, state: "interrupted" } }) }).state,
    ).toBe("idle");
  });

  it("requires explicit turn success or settlement for completion", () => {
    expect(project({ thread: thread({ latestTurn: completedTurn }) })).toMatchObject({
      state: "completed",
      detail: "Turn completed",
    });
    expect(
      project({ thread: thread({ settledOverride: "settled", settledAt: timestamp }) }),
    ).toMatchObject({
      state: "completed",
      detail: "Conversation settled",
    });
    expect(
      project({ thread: thread({ latestTurn: { ...completedTurn, completedAt: null } }) }).state,
    ).toBe("idle");
  });

  it("preserves live background work after a completed turn", () => {
    expect(
      project({ thread: thread({ latestTurn: completedTurn, backgroundLiveness: "working" }) }),
    ).toMatchObject({
      state: "working",
      detail: "Background work running",
    });
    expect(
      project({ thread: thread({ latestTurn: completedTurn, backgroundLiveness: "monitoring" }) }),
    ).toMatchObject({
      state: "working",
      detail: "Monitoring",
    });
  });

  it("reports structured plan review as awaiting input", () => {
    expect(
      project({
        thread: thread({
          latestTurn: completedTurn,
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          backgroundLiveness: "monitoring",
        }),
      }),
    ).toMatchObject({
      state: "awaiting-input",
      detail: "Plan ready for review",
      attention: true,
    });
  });

  it("shows failures and clears them when a fresh session starts", () => {
    expect(
      project({
        thread: thread({
          session: { ...runningSession, status: "error", lastError: "Provider exited" },
        }),
      }),
    ).toMatchObject({
      state: "error",
      detail: "Provider exited",
      attention: true,
    });
    expect(
      project({
        thread: thread({
          session: runningSession,
          latestTurn: { ...completedTurn, state: "error" },
        }),
      }).state,
    ).toBe("working");
  });

  it("uses the latest activity from the current turn and bounds its detail", () => {
    const activities = [
      {
        id: EventId.make("event-1"),
        tone: "tool" as const,
        kind: "tool.started",
        summary: "Reading\n source",
        turnId,
        payload: null,
        createdAt: timestamp,
      },
      {
        id: EventId.make("event-2"),
        tone: "info" as const,
        kind: "turn.completed",
        summary: "Previous turn finished",
        turnId: TurnId.make("old-turn"),
        payload: null,
        createdAt: timestamp,
      },
    ];
    expect(
      project({
        thread: thread({
          session: runningSession,
          latestTurn: { ...completedTurn, state: "running", completedAt: null },
        }),
        activities,
      }).detail,
    ).toBe("Reading source");
    const longStep = "Inspecting source ".repeat(40);
    expect(
      project({
        thread: thread({
          session: runningSession,
          planProgress: { step: longStep, completedSteps: 0, totalSteps: 1 },
        }),
      }).detail.length,
    ).toBeLessThanOrEqual(180);
  });
});
