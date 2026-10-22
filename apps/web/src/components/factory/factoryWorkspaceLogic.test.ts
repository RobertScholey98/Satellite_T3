import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type FactoryMember,
  type FactoryWorkspaceFeed,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { factoryMemberThreadKeys } from "./factoryWorkspaceLogic";

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

function feed(
  input: Partial<FactoryWorkspaceFeed>,
): ReadonlyMap<EnvironmentId, FactoryWorkspaceFeed> {
  return new Map([[environmentId, { managers: [], members: [], assignments: [], ...input }]]);
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
