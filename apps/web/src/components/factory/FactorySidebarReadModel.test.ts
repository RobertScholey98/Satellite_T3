import {
  EnvironmentId,
  FactorySnapshot,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import {
  createFactoryManagedThreadKeysSelector,
  factoryCanCreateManager,
  factoryManagerProviders,
  factorySidebarVisible,
  factoryVisibleThreadKeys,
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
  it("returns the previous set while its keys are unchanged", () => {
    const select = createFactoryManagedThreadKeysSelector();
    const first = select([environment(owner, managed)]);
    expect([...first]).toEqual(["owner:manager", "owner:onboarding-lead"]);
    expect(select([environment(owner, { ...managed, revision: 4 })])).toBe(first);
    const withoutLead = select([environment(owner, { ...managed, assignments: [] })]);
    expect([...withoutLead]).toEqual(["owner:manager"]);
    expect(select([environment(owner, { ...managed, assignments: [] })])).toBe(withoutLead);
  });

  it("shares one empty set when nothing is managed", () => {
    expect(createFactoryManagedThreadKeysSelector()([environment(owner, empty)])).toBe(
      createFactoryManagedThreadKeysSelector()([
        environment(owner, null),
        environment(remote, empty),
      ]),
    );
  });
});

describe("factory visible thread keys", () => {
  const team = decodeSnapshot({
    ...managed,
    managers: [
      {
        ...managed.managers[0],
        id: "system",
        threadId: "system",
        role: "system",
        projectId: null,
        workspaceProjectId: api,
        qualification: { status: "qualified", profileId: "system-profile", checkedAt: now },
      },
      ...managed.managers,
    ],
    assignments: [
      ...managed.assignments,
      {
        ...managed.assignments[0],
        id: "feature",
        threadId: "feature-lead",
        kind: "implementation",
        title: "Feature",
      },
      {
        ...managed.assignments[0],
        id: "pending",
        threadId: "pending-lead",
        threadStatus: "pending",
      },
    ],
    retros: [
      {
        id: "retro",
        assignmentId: "onboarding",
        conclusionId: "conclusion",
        evidenceDigest: "digest",
        threadId: "onboarding-retro",
        modelSelection: { instanceId: "codex", model: "approved" },
        execution: { status: "preparing" },
        reports: { phase: "team-pending" },
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  const keys = (overrides: {
    readonly scopedProjectKeys?: ReadonlySet<string> | null;
    readonly expanded?: boolean;
    readonly collapsedManagers?: ReadonlySet<string>;
  }) =>
    factoryVisibleThreadKeys({
      environments: [environment(owner, team)],
      projects: [
        { environmentId: owner, id: web },
        { environmentId: owner, id: api },
      ],
      scopedProjectKeys: overrides.scopedProjectKeys ?? null,
      expanded: overrides.expanded ?? true,
      collapsedManagers: overrides.collapsedManagers ?? new Set(),
    });

  it("lists the system manager first, then each project team with retros after their assignment", () => {
    expect(keys({})).toEqual([
      "owner:system",
      "owner:manager",
      "owner:onboarding-lead",
      "owner:onboarding-retro",
      "owner:feature-lead",
    ]);
  });

  it("keeps a collapsed manager but drops its team", () => {
    expect(keys({ collapsedManagers: new Set(["owner:manager"]) })).toEqual([
      "owner:system",
      "owner:manager",
    ]);
  });

  it("shows nothing while the section is collapsed", () => {
    expect(keys({ expanded: false })).toEqual([]);
  });

  it("leaves out project managers outside the project scope", () => {
    expect(keys({ scopedProjectKeys: new Set(["owner:api"]) })).toEqual(["owner:system"]);
  });
});

describe("factory manager providers", () => {
  const provider = (driver: string, model: string): ServerProvider => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: now,
    models: [{ slug: model, name: model, isCustom: false, isDefault: true, capabilities: {} }],
    slashCommands: [],
    skills: [],
  });
  const claudeDefault = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-fable-5",
  };

  it("defaults a manager to Codex even when the project prefers another provider", () => {
    const providers = factoryManagerProviders([
      provider("claudeAgent", "claude-fable-5"),
      provider("codex", "gpt-5.6"),
    ]);
    expect(providers.map((entry) => entry.driver)).toEqual(["codex"]);
    expect(resolveDefaultProviderModelSelection(providers, claudeDefault)).toEqual({
      instanceId: "codex",
      model: "gpt-5.6",
    });
  });

  it("offers no model without a Codex provider", () => {
    const providers = factoryManagerProviders([provider("claudeAgent", "claude-fable-5")]);
    expect(resolveDefaultProviderModelSelection(providers, claudeDefault)).toBeNull();
  });
});
