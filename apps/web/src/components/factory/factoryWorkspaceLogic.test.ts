import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type FactoryMember,
  type FactoryWorkspaceAssignment,
  type FactoryWorkspaceFeed,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "~/session-logic";
import {
  collapseFactoryPriming,
  factoryMemberThreadKeys,
  resolveFactoryWorkspaceView,
} from "./factoryWorkspaceLogic";

const environmentId = EnvironmentId.make("local");
const key = (threadId: string) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));

function member(threadId: string, overrides: Partial<FactoryMember> = {}): FactoryMember {
  return {
    threadId: ThreadId.make(threadId),
    managerId: "manager-1",
    assignmentId: "assignment-1",
    role: "implementer",
    parentThreadId: null,
    joined: "created",
    takenOver: false,
    offPool: false,
    endedAt: null,
    ...overrides,
  };
}

function workspace(input: Partial<FactoryWorkspaceFeed>): FactoryWorkspaceFeed {
  return { managers: [], members: [], assignments: [], ...input };
}

function feed(
  input: Partial<FactoryWorkspaceFeed>,
): ReadonlyMap<EnvironmentId, FactoryWorkspaceFeed> {
  return new Map([[environmentId, workspace(input)]]);
}

function assignment(
  id: string,
  overrides: Partial<FactoryWorkspaceAssignment> = {},
): FactoryWorkspaceAssignment {
  return {
    id,
    managerId: "manager-1",
    title: `Work ${id}`,
    state: "active",
    source: "ticket",
    complexity: "small",
    team: "custom",
    leadThreadId: ThreadId.make(`${id}-lead`),
    checklist: [],
    waitingReason: null,
    ...overrides,
  };
}

const manager = (id: string, state: FactoryWorkspaceFeed["managers"][number]["state"]) => ({
  id,
  threadId: ThreadId.make(`${id}-thread`),
  projectId: ProjectId.make("project"),
  name: "Atlas",
  state,
  waitingOnYou: 0,
});

describe("factoryMemberThreadKeys", () => {
  it("hides lead and team threads of a live manager but keeps the manager's own thread", () => {
    const keys = factoryMemberThreadKeys(
      feed({
        managers: [manager("manager-1", "active")],
        members: [
          member("manager-1-thread", { role: "manager", assignmentId: null }),
          member("lead", { role: "lead" }),
          member("implementer"),
        ],
      }),
    );
    expect([...keys].toSorted()).toEqual([key("implementer"), key("lead")].toSorted());
  });

  it("returns ended members and a retired manager's team to the sidebar", () => {
    const keys = factoryMemberThreadKeys(
      feed({
        managers: [manager("manager-1", "project-paused"), manager("manager-2", "retired")],
        members: [
          member("ended", { endedAt: "2026-10-01T00:00:00.000Z" }),
          member("retired-team", { managerId: "manager-2", role: "lead" }),
          member("paused-team", { role: "reviewer" }),
        ],
      }),
    );
    expect([...keys]).toEqual([key("paused-team")]);
  });
});

describe("resolveFactoryWorkspaceView", () => {
  it("opens the workspace on the assignment of the team thread being read", () => {
    const view = resolveFactoryWorkspaceView(
      workspace({
        managers: [manager("manager-1", "active")],
        members: [
          member("manager-1-thread", { role: "manager", assignmentId: null }),
          member("assignment-2-lead", { role: "lead", assignmentId: "assignment-2" }),
        ],
        assignments: [assignment("assignment-1"), assignment("assignment-2")],
      }),
      ThreadId.make("assignment-2-lead"),
    );
    expect(view?.activeAssignmentId).toBe("assignment-2");
  });

  it("opens on no assignment from the manager's own thread", () => {
    const view = resolveFactoryWorkspaceView(
      workspace({
        managers: [manager("manager-1", "active")],
        members: [member("manager-1-thread", { role: "manager", assignmentId: null })],
        assignments: [assignment("assignment-1")],
      }),
      ThreadId.make("manager-1-thread"),
    );
    expect(view?.activeAssignmentId).toBeNull();
  });
});

describe("collapseFactoryPriming", () => {
  const at = "2026-10-23T12:00:00.000Z";
  const primingId = MessageId.make("priming");
  const message = (id: string, role: "user" | "assistant", text: string): TimelineEntry => ({
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  });
  const work = (id: string): TimelineEntry => ({
    id,
    kind: "work",
    createdAt: at,
    entry: { id, createdAt: at, label: "Read a file", tone: "tool" },
  });
  const shape = (entries: ReadonlyArray<TimelineEntry>) =>
    entries.map((entry) =>
      entry.kind === "factory-priming"
        ? {
            prompt: entry.prompt?.text ?? null,
            reply: entry.reply?.text ?? null,
            continued: entry.continued,
          }
        : entry.id,
    );

  it("folds the priming message by id with its turn and the first reply", () => {
    const entries = [
      message("priming", "user", "You are the engineering manager for Atlas."),
      work("read"),
      message("ready", "assistant", "Ready."),
    ];
    expect(shape(collapseFactoryPriming(entries, primingId))).toEqual([
      { prompt: "You are the engineering manager for Atlas.", reply: "Ready.", continued: false },
    ]);
  });

  it("returns the same array for the same entries, which the timeline's row derivation needs", () => {
    const entries = [message("priming", "user", "Primed"), message("ready", "assistant", "Ready.")];
    const first = collapseFactoryPriming(entries, primingId);
    expect(collapseFactoryPriming(entries, primingId)).toBe(first);
    expect(collapseFactoryPriming([...entries], primingId)).not.toBe(first);
  });

  it("keeps earlier and later turns and notes that the user has written since", () => {
    const entries = [
      message("earlier", "user", "An older request still in the window"),
      message("priming", "user", "Primed"),
      message("ready", "assistant", "Ready."),
      message("ask", "user", "What is on the board?"),
      message("answer", "assistant", "Two tickets."),
    ];
    expect(shape(collapseFactoryPriming(entries, primingId))).toEqual([
      "earlier",
      { prompt: "Primed", reply: "Ready.", continued: true },
      "ask",
      "answer",
    ]);
  });

  it("waits for the reply without swallowing a later user message", () => {
    const entries = [
      message("priming", "user", "Primed"),
      work("read"),
      message("ask", "user", "Hi"),
    ];
    expect(shape(collapseFactoryPriming(entries, primingId))).toEqual([
      { prompt: "Primed", reply: null, continued: true },
      "ask",
    ]);
  });

  it("folds nothing when the priming is outside the loaded window", () => {
    const windowed = [message("ask", "user", "What is on the board?"), work("read")];
    expect(collapseFactoryPriming(windowed, primingId)).toBe(windowed);
  });
});
