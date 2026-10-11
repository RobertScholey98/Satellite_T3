import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as IdeaWorkspace from "../ideas/IdeaWorkspace.ts";
import * as FactoryExecution from "../factory/FactoryExecution.ts";
import * as FactoryExecutionTestkit from "../factory/FactoryExecution.testkit.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// Grok's instance offers no Auto-accept edits; the Codex instance advertises no
// restriction.
const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(FactoryExecutionTestkit.layerUnmanaged),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

const discoveryProfile = {
  boundaryId: "discovery:runtime-policy",
  dockerContext: "default",
  imageId: "sha256:discovery-image",
  projectSnapshotPath: "/state/discovery/project",
  workflowSnapshotPath: "/state/discovery/workflow",
  runtimePath: "/state/discovery/runtime",
} satisfies FactoryExecution.FactoryExecutionProfile;

const managedLayer = (driverKind: "codex" | "grok") =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FactoryExecution.FactoryExecution)({
          runtimePolicyFor: () => Effect.succeed(discoveryProfile),
          assertSelectionFor: () => Effect.void,
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.die("managed execution must not read the writable checkout"),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (instanceId) =>
            Effect.succeed({
              ...providerInstanceFor(instanceId),
              driverKind: ProviderDriverKind.make(driverKind),
            }),
        }),
      ),
    ),
  );

it.effect("runs managed discovery from the qualified snapshot instead of its worktree", () =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const now = yield* DateTime.now;
    const resolved = yield* policy.resolve({
      thread: makeThread({ now, worktreePath: "/writable-worktree" }),
      modelSelection,
    });
    assert.equal(resolved.cwd, discoveryProfile.projectSnapshotPath);
    assert.deepStrictEqual(resolved.factoryExecution, discoveryProfile);
    assert.deepStrictEqual(resolved.sandboxPolicy, {
      type: "externalSandbox",
      networkAccess: "enabled",
    });
    assert.equal(resolved.approvalPolicy, "never");
  }).pipe(Effect.provide(managedLayer("codex"))),
);

it.effect("rejects a managed runtime when the selected driver cannot enforce discovery", () =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const now = yield* DateTime.now;
    const failure = yield* policy
      .resolve({
        thread: makeThread({ now, worktreePath: "/writable-worktree" }),
        modelSelection: { instanceId: grokInstanceId, model: "test-model" },
      })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "RuntimePolicyResolveError");
    assert.equal(failure.providerInstanceId, grokInstanceId);
  }).pipe(Effect.provide(managedLayer("grok"))),
);

it.effect("preserves the managed boundary when a runtime override requests wider access", () =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const now = yield* DateTime.now;
    const resolved = yield* policy.resolve({
      thread: makeThread({ now, worktreePath: "/writable-worktree" }),
      modelSelection,
    });
    assert.equal(resolved.cwd, discoveryProfile.projectSnapshotPath);
    assert.deepStrictEqual(resolved.factoryExecution, discoveryProfile);
    assert.deepStrictEqual(resolved.sandboxPolicy, {
      type: "externalSandbox",
      networkAccess: "enabled",
    });
    assert.equal(resolved.approvalPolicy, "never");
  }).pipe(
    Effect.provide(
      RuntimePolicy.layerWithOverride({
        cwd: "/writable-checkout",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "dangerFullAccess" },
      }).pipe(Layer.provide(managedLayer("codex"))),
    ),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect(
    "requires an isolated workspace for an idea instead of using its project worktree",
    () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const now = yield* DateTime.now;
        const failure = yield* policy
          .resolve({
            thread: { ...makeThread({ now, worktreePath: "/project-worktree" }), purpose: "idea" },
            modelSelection,
          })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "RuntimePolicyResolveError");
      }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      // A provider that advertises no restriction runs every mode as stored.
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

it.effect("uses the owned idea workspace and preserves its selected permissions", () => {
  const calls: ThreadId[] = [];
  const isolatedLayer = RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(FactoryExecutionTestkit.layerUnmanaged),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(IdeaWorkspace.IdeaWorkspace)({
          prepare: (threadId) =>
            Effect.sync(() => {
              calls.push(threadId);
              return {
                cwd: "/state/ideas/owned-idea",
                projectDirectory: "/project-root",
                mainRevision: "main-head",
                deletionEpoch: 0,
                context: "{}",
              };
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.die("idea execution must not fall back to the project checkout"),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const now = yield* DateTime.now;
    const thread = {
      ...makeThread({ now, worktreePath: "/project-worktree", runtimeMode: "full-access" }),
      purpose: "idea" as const,
    };
    const resolved = yield* policy.resolve({ thread, modelSelection });
    assert.equal(resolved.cwd, "/state/ideas/owned-idea");
    assert.equal(resolved.runtimeMode, "full-access");
    assert.equal(resolved.purpose, "idea");
    assert.deepStrictEqual(calls, [thread.id]);
  }).pipe(Effect.provide(isolatedLayer));
});

it.effect("passes the parent to factory policy only for subagents, never for forks", () =>
  Effect.gen(function* () {
    const parents: Array<ThreadId | undefined> = [];
    const layer = RuntimePolicy.layerFromProjectStore.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(FactoryExecution.FactoryExecution)({
            runtimePolicyFor: (_threadId, pendingParentThreadId) =>
              Effect.sync(() => {
                parents.push(pendingParentThreadId);
                return discoveryProfile;
              }),
            assertSelectionFor: () => Effect.void,
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.die("managed execution must not read the writable checkout"),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (instanceId) =>
              Effect.succeed({
                ...providerInstanceFor(instanceId),
                driverKind: ProviderDriverKind.make("codex"),
              }),
          }),
        ),
      ),
    );
    const now = yield* DateTime.now;
    const parentThreadId = ThreadId.make("thread:managed-lead");
    const child = (relationshipToParent: "fork" | "subagent") => {
      const thread = makeThread({ now, worktreePath: null });
      return {
        ...thread,
        lineage: { parentThreadId, relationshipToParent, rootThreadId: parentThreadId },
      };
    };
    yield* Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      yield* policy.resolve({ thread: child("fork"), modelSelection });
      yield* policy.resolve({ thread: child("subagent"), modelSelection });
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(parents, [undefined, parentThreadId]);
  }),
);
