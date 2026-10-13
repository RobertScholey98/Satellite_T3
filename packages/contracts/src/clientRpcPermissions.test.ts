import { describe, expect, it } from "vite-plus/test";

import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { FACTORY_WS_METHODS } from "./factory.ts";

const dispatch = (command: Record<string, unknown>) =>
  clientRpcRequiredScopes(FACTORY_WS_METHODS.dispatchCommand, {
    command: { commandId: "command-1", ...command },
  });

const commission = (kind: "implementation" | "rule-change") => ({
  type: "assignment.commission",
  managerId: "manager-1",
  title: "Work",
  scope: {
    description: "Change the thing.",
    completionCondition: "The thing changed.",
    requiresPullRequest: true,
  },
  complexity: "standard",
  kind,
  sourcePaths: [],
  creatableDirectories: [],
});

describe("factory command scopes", () => {
  it("asks only for operate access for ordinary management", () => {
    expect(dispatch({ type: "assignment.cancel", assignmentId: "assignment-1" })).toEqual([
      "orchestration:operate",
    ]);
    expect(dispatch(commission("implementation"))).toEqual(["orchestration:operate"]);
  });

  it("asks for settings access to change the factory's rules", () => {
    expect(dispatch({ type: "manager.retire", managerId: "manager-1" })).toEqual([
      "orchestration:operate",
      "settings:write",
    ]);
    expect(dispatch(commission("rule-change"))).toEqual([
      "orchestration:operate",
      "settings:write",
    ]);
  });

  it("asks for source control access to publish or merge", () => {
    expect(
      dispatch({ type: "delivery.merge", assignmentId: "assignment-1", revisionId: "revision-1" }),
    ).toEqual(["orchestration:operate", "source-control:write"]);
  });
});
