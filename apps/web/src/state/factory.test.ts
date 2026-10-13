import { EnvironmentId, FactorySnapshot, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("local");

const fake = vi.hoisted(() => ({
  enabled: undefined as unknown as Atom.Writable<boolean>,
  probe: undefined as unknown as Atom.Writable<AsyncResult.AsyncResult<FactorySnapshot>>,
  live: undefined as unknown as Atom.Writable<AsyncResult.AsyncResult<FactorySnapshot>>,
  reads: { probe: 0, live: 0 },
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("./query", () => ({ formatEnvironmentQueryError: () => "Unavailable" }));
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationsAtom: Atom.make(
        new Map([
          [
            environmentId,
            { entry: { target: { label: "Local" } }, connection: { phase: "connected" } },
          ],
        ]),
      ),
    },
  };
});
vi.mock("./session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const session = Atom.make(
    AsyncResult.success({ authenticated: true, permissions: ["orchestration:read"] }),
  );
  return { environmentSession: { sessionStateAtom: () => session } };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  fake.enabled = Atom.make(false);
  const settings = Atom.make((get) => ({ engineeringManagersEnabled: get(fake.enabled) }));
  return { serverEnvironment: { settingsValueAtom: () => settings } };
});
vi.mock("@t3tools/client-runtime/factory", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  fake.probe = Atom.make<AsyncResult.AsyncResult<FactorySnapshot>>(AsyncResult.initial());
  fake.live = Atom.make<AsyncResult.AsyncResult<FactorySnapshot>>(AsyncResult.initial());
  const probe = Atom.make((get) => {
    fake.reads.probe += 1;
    return get(fake.probe);
  });
  const live = Atom.make((get) => {
    fake.reads.live += 1;
    return get(fake.live);
  });
  const permission = Atom.make(true);
  return {
    createFactoryEnvironmentAtoms: () => ({
      snapshot: () => probe,
      live: () => live,
      dispatch: { permissionAtom: () => permission },
    }),
  };
});

const { factoryEnvironmentsAtom } = await import("./factory");

const decodeSnapshot = Schema.decodeUnknownSync(FactorySnapshot);
const now = "2026-10-10T12:00:00.000Z";
const policy = {
  delivery: "human-approval",
  projectImprovements: "create-tickets",
  sharedWorkflow: "investigate-and-recommend",
  authorizeRuleWeakening: false,
  recoveryCycles: 1,
};
const empty = decodeSnapshot({
  revision: 0,
  defaults: policy,
  managers: [],
  assignments: [],
  boundaries: [],
});
const managed = decodeSnapshot({
  revision: 1,
  defaults: policy,
  assignments: [],
  boundaries: [],
  managers: [
    {
      id: "manager",
      threadId: "manager",
      projectId: ProjectId.make("web"),
      role: "project",
      name: "Web manager",
      modelSelection: { instanceId: "codex", model: "approved" },
      workflow: { repositoryRoot: "/skills", revision: "pinned" },
      overrides: {},
      status: "onboarding",
      threadStatus: "created",
      launchStatus: "delivered",
      wait: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
});

describe("factory environments", () => {
  beforeEach(() => {
    fake.reads.probe = 0;
    fake.reads.live = 0;
  });

  it("opens no subscription and offers nothing while the beta is off and nothing is managed", () => {
    const registry = AtomRegistry.make({
      initialValues: [[fake.probe, AsyncResult.success(empty)]],
    });
    expect(registry.get(factoryEnvironmentsAtom)).toEqual([]);
    expect(fake.reads.live).toBe(0);

    registry.set(fake.enabled, true);
    expect(registry.get(factoryEnvironmentsAtom).map((view) => view.environmentId)).toEqual([
      environmentId,
    ]);
    expect(fake.reads.live).toBeGreaterThan(0);
  });

  it("keeps existing managers visible and live after the beta is turned off", () => {
    const registry = AtomRegistry.make({
      initialValues: [
        [fake.probe, AsyncResult.success(managed)],
        [fake.live, AsyncResult.success(managed)],
      ],
    });
    expect(registry.get(factoryEnvironmentsAtom).map((view) => view.data?.managers.length)).toEqual(
      [1],
    );
  });

  it("subscribes without a probe while the beta is on", () => {
    const registry = AtomRegistry.make({ initialValues: [[fake.enabled, true]] });
    expect(registry.get(factoryEnvironmentsAtom)).toHaveLength(1);
    expect(fake.reads.probe).toBe(0);
  });
});
