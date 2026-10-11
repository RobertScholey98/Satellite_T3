import { EnvironmentId, FactorySnapshot, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  factoryCanCreateManager,
  factoryManagedThreadKeys,
  factorySidebarVisible,
} from "./FactorySidebarReadModel";

const now = "2026-10-10T12:00:00.000Z";
const owner = EnvironmentId.make("owner");
const remote = EnvironmentId.make("remote");
const web = ProjectId.make("web");
const api = ProjectId.make("api");
const policy = {
  delivery: "human-approval",
  projectImprovements: "create-tickets",
  sharedWorkflow: "investigate-and-recommend",
  authorizeRuleWeakening: false,
  recoveryCycles: 1,
};
const workflow = { repositoryRoot: "/skills", revision: "pinned" };
const decodeSnapshot = Schema.decodeUnknownSync(FactorySnapshot);
const empty = decodeSnapshot({
  revision: 0,
  defaults: policy,
  managers: [],
  assignments: [],
  boundaries: [],
});
const managed = decodeSnapshot({
  revision: 3,
  defaults: policy,
  boundaries: [],
  managers: [
    {
      id: "manager",
      threadId: "manager",
      projectId: web,
      role: "project",
      name: "Web manager",
      modelSelection: { instanceId: "codex", model: "approved" },
      workflow,
      overrides: {},
      status: "onboarding",
      threadStatus: "created",
      launchStatus: "delivered",
      wait: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
  assignments: [
    {
      id: "onboarding",
      managerId: "manager",
      threadId: "onboarding-lead",
      projectId: web,
      kind: "onboarding",
      status: "running",
      threadStatus: "created",
      launchStatus: "delivered",
      qualification: { status: "qualified", profileId: "profile", checkedAt: now },
      workflow,
      grantedPolicy: policy,
      wait: null,
      report: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
});
const environment = (environmentId: EnvironmentId, data: FactorySnapshot | null) => ({
  environmentId,
  connected: true,
  canOperate: true,
  data,
});

describe("factory sidebar gating", () => {
  it("stays hidden until an environment with a shown project has a manager", () => {
    const projects = [{ environmentId: owner, id: web }];
    expect(factorySidebarVisible([environment(owner, empty)], projects)).toBe(false);
    expect(factorySidebarVisible([environment(owner, null)], projects)).toBe(false);
    expect(
      factorySidebarVisible([environment(owner, empty), environment(remote, managed)], projects),
    ).toBe(false);
    expect(factorySidebarVisible([environment(owner, managed)], projects)).toBe(true);
  });

  it("offers creation only for a connected, operable environment without that project's manager", () => {
    const environments = [environment(owner, managed)];
    expect(factoryCanCreateManager(environments, { environmentId: owner, id: web })).toBe(false);
    expect(factoryCanCreateManager(environments, { environmentId: owner, id: api })).toBe(true);
    expect(
      factoryCanCreateManager([{ ...environment(owner, empty), connected: false }], {
        environmentId: owner,
        id: api,
      }),
    ).toBe(false);
    expect(
      factoryCanCreateManager([environment(owner, null)], { environmentId: owner, id: api }),
    ).toBe(false);
  });

  it("offers creation again once the project's manager is retired", () => {
    const retired = {
      ...managed,
      managers: managed.managers.map((manager) => ({ ...manager, status: "retired" as const })),
    };
    expect(
      factoryCanCreateManager([environment(owner, retired)], { environmentId: owner, id: web }),
    ).toBe(true);
  });
});

describe("factory managed thread keys", () => {
  it("keeps the same content across snapshot copies so callers can memoise on it", () => {
    const first = factoryManagedThreadKeys([environment(owner, managed)]);
    expect(first).toBe("owner:manager\nowner:onboarding-lead");
    expect(factoryManagedThreadKeys([environment(owner, { ...managed, revision: 4 })])).toBe(first);
    expect(factoryManagedThreadKeys([environment(owner, empty)])).toBe("");
  });
});
