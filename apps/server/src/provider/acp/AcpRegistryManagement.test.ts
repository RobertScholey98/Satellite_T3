import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AcpRegistryOperationError,
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SatelliteTestRuntime from "../../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ProviderAuth from "../ProviderAuthService.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildUnavailableProviderSnapshot } from "../unavailableProviderSnapshot.ts";
import * as AcpRegistryManagement from "./AcpRegistryManagement.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";

const projectId = ProjectId.make("acp-management-project");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const nativeId = "native-session";
const threadId = IdAllocator.deriveThreadFromProviderThread({
  driver,
  providerInstanceId: instanceId,
  nativeThreadId: nativeId,
});
const workspaceRoot = "C:/environment/workspace";
const session = {
  sessionId: nativeId,
  cwd: workspaceRoot,
  additionalDirectories: [],
  title: "Native session",
  updatedAt: "2026-06-20T00:00:00.000Z",
  importedThreadId: null,
} as const;
const models = [
  { slug: "other", name: "Other", isCustom: false, capabilities: null },
  { slug: "preferred", name: "Preferred", isCustom: false, capabilities: null, isDefault: true },
];

const makeHarness = Effect.fn(function* (
  options: {
    readonly canResume?: boolean;
    readonly canDelete?: boolean;
    readonly manager?: Partial<NonNullable<ProviderInstance["acpSessionManagement"]>>;
    readonly enqueueCommand?: ServerRuntimeStartup.ServerRuntimeStartup["Service"]["enqueueCommand"];
  } = {},
) {
  const actions: string[] = [];
  const base = yield* buildUnavailableProviderSnapshot({
    instanceId,
    driverKind: driver,
    reason: "Test fixture",
  });
  const snapshot: ServerProvider = {
    ...base,
    models,
    auth: { ...base.auth, canLogout: true },
    nativeSessions: {
      canList: true,
      canLoad: false,
      canResume: options.canResume ?? true,
      canDelete: options.canDelete ?? true,
    },
    configurableProviders: true,
  };
  const instance: ProviderInstance = {
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "test-instance" },
    displayName: "Native fixture",
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
        ),
    },
    orchestrationAdapter: SatelliteTestRuntime.makeProviderAdapter(instanceId),
    textGeneration: {
      generateCommitMessage: () => Effect.die("Unused generation"),
      generatePrContent: () => Effect.die("Unused generation"),
      generateBranchName: () => Effect.die("Unused generation"),
      generateThreadTitle: () => Effect.die("Unused generation"),
    },
    acpSessionManagement: {
      listSessions: ({ cwd, cursor }) =>
        Effect.sync(() => {
          actions.push(`list:${cwd}:${cursor ?? ""}`);
          return {
            sessions: [session],
            nextCursor: "next",
            canLoad: false,
            canResume: true,
            canDelete: true,
          };
        }),
      deleteSession: ({ cwd, sessionId }) =>
        Effect.sync(() => {
          actions.push(`delete:${cwd}:${sessionId}`);
        }),
      listProviders: () =>
        Effect.succeed({
          providers: [
            { providerId: "optional", supported: ["openai"], required: false, current: null },
            { providerId: "required", supported: ["openai"], required: true, current: null },
          ],
        }),
      setProvider: ({ cwd }) =>
        Effect.sync(() => {
          actions.push(`set:${cwd}`);
        }),
      disableProvider: ({ cwd }) =>
        Effect.sync(() => {
          actions.push(`disable:${cwd}`);
        }),
      logout: (cwd) =>
        Effect.sync(() => {
          actions.push(`logout:${cwd}`);
        }),
      ...options.manager,
    },
  };
  const external = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "C:/environment/projects",
      folderForThread: () => Effect.succeedNone,
    }),
    Layer.mock(TextGeneration.TextGeneration)({}),
    ServerSettings.layerTest(),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([snapshot]),
      refreshInstance: () =>
        Effect.sync(() => {
          actions.push("refresh");
          return [snapshot];
        }),
    }),
    Layer.mock(ProviderAuth.ProviderAuthService)({}),
    AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator.layer,
    Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
      enqueueCommand: options.enqueueCommand ?? ((effect) => effect),
    }),
  );
  const runtime = Layer.mergeAll(ThreadManagement.layer, CommandReceiptStore.layer).pipe(
    Layer.provideMerge(SatelliteTestRuntime.layer),
  );
  const dependencies = ThreadLaunch.layer.pipe(
    Layer.provideMerge(external),
    Layer.provideMerge(runtime),
  );
  return {
    actions,
    layer: AcpRegistryManagement.layer.pipe(
      Layer.provideMerge(dependencies),
      Layer.provideMerge(ServerConfig.layerTest("C:/environment", { prefix: "acp-management-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
});

const seed = SatelliteTestRuntime.recordProject({ projectId, title: "Workspace", workspaceRoot });
const nativeInput = { instanceId, projectId, sessionId: nativeId };

describe("AcpRegistryManagement", () => {
  it.effect("imports one native session idempotently and reports its mapping in paged lists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* seed;
        const management = yield* AcpRegistryManagement.AcpRegistryManagement;
        expect(
          yield* management.listSessions({ instanceId, projectId, cursor: "page" }),
        ).toMatchObject({
          nextCursor: "next",
          sessions: [{ importedThreadId: null }],
        });
        const imported = yield* management.importSession({
          ...nativeInput,
          title: "Imported title",
          updatedAt: session.updatedAt,
        });
        expect(imported).toEqual({ threadId, imported: true });
        expect(yield* management.importSession(nativeInput)).toEqual({ threadId, imported: false });
        const threads = yield* ThreadManagement.ThreadManagementService;
        const projection = yield* threads.getThreadProjection(threadId);
        expect(projection.thread).toMatchObject({
          projectId,
          title: "Imported title",
          modelSelection: { instanceId, model: "preferred" },
          runtimeMode: "approval-required",
        });
        expect(projection.providerThreads).toContainEqual(
          expect.objectContaining({
            nativeThreadRef: expect.objectContaining({ nativeId }),
          }),
        );
        expect(yield* management.listSessions({ instanceId, projectId })).toMatchObject({
          sessions: [{ importedThreadId: threadId }],
        });
        expect(harness.actions[0]).toBe(`list:${workspaceRoot}:page`);
        const rejected = yield* Effect.result(management.deleteSession(nativeInput));
        expect(Result.isFailure(rejected) && rejected.failure.reason).toBe("session_delete_failed");
        expect(harness.actions.some((action) => action.startsWith("delete:"))).toBe(false);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("validates projects, instances, and native capabilities before touching sessions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ canResume: false, canDelete: false });
      yield* Effect.gen(function* () {
        yield* seed;
        const management = yield* AcpRegistryManagement.AcpRegistryManagement;
        const missingProject = yield* Effect.result(
          management.listSessions({ instanceId, projectId: ProjectId.make("missing") }),
        );
        expect(Result.isFailure(missingProject) && missingProject.failure.reason).toBe(
          "project_not_found",
        );
        const missingInstance = yield* Effect.result(
          management.listSessions({ instanceId: ProviderInstanceId.make("missing"), projectId }),
        );
        expect(Result.isFailure(missingInstance) && missingInstance.failure.reason).toBe(
          "instance_not_found",
        );
        const importFailure = yield* Effect.result(management.importSession(nativeInput));
        expect(Result.isFailure(importFailure) && importFailure.failure.reason).toBe(
          "session_resume_unsupported",
        );
        const deleteFailure = yield* Effect.result(management.deleteSession(nativeInput));
        expect(Result.isFailure(deleteFailure) && deleteFailure.failure.reason).toBe(
          "session_delete_unsupported",
        );
        expect(harness.actions).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("serializes import with delete while waiting for command readiness", () =>
    Effect.gen(function* () {
      const launchReady = yield* Deferred.make<void>();
      const releaseLaunch = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        enqueueCommand: (effect) =>
          Deferred.succeed(launchReady, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLaunch)),
            Effect.andThen(effect),
          ),
      });
      yield* Effect.gen(function* () {
        yield* seed;
        const management = yield* AcpRegistryManagement.AcpRegistryManagement;
        const importing = yield* management.importSession(nativeInput).pipe(Effect.forkChild);
        yield* Deferred.await(launchReady);
        const deleting = yield* Effect.result(management.deleteSession(nativeInput)).pipe(
          Effect.forkChild,
        );
        yield* Deferred.succeed(releaseLaunch, undefined);
        expect(yield* Fiber.join(importing)).toEqual({ threadId, imported: true });
        const deleted = yield* Fiber.join(deleting);
        expect(Result.isFailure(deleted) && deleted.failure.reason).toBe("session_delete_failed");
        expect(harness.actions.some((action) => action.startsWith("delete:"))).toBe(false);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("recognizes an import that raced a failed launch", () =>
    Effect.gen(function* () {
      const failure = new ServerRuntimeStartup.ServerRuntimeStartupError({
        mode: "web",
        host: "127.0.0.1",
        port: 0,
        cause: new Error("Command startup failed"),
      });
      let racedImport: Effect.Effect<never, ServerRuntimeStartup.ServerRuntimeStartupError> =
        Effect.die("Race was not prepared");
      const harness = yield* makeHarness({ enqueueCommand: () => racedImport });
      yield* Effect.gen(function* () {
        yield* seed;
        const threads = yield* ThreadManagement.ThreadManagementService;
        racedImport = threads
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make("raced-import"),
            threadId,
            projectId,
            title: "Raced",
            modelSelection: { instanceId, model: "preferred" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.orDie, Effect.andThen(Effect.fail(failure)));
        const management = yield* AcpRegistryManagement.AcpRegistryManagement;
        expect(yield* management.importSession(nativeInput)).toEqual({ threadId, imported: false });
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "deletes an unimported session in its environment and retains the native typed failure",
    () =>
      Effect.gen(function* () {
        const failure = new AcpRegistryOperationError({
          reason: "session_delete_failed",
          message: "Native deletion failed",
        });
        const deletedAt: string[] = [];
        const harness = yield* makeHarness({
          manager: {
            deleteSession: ({ cwd, sessionId }) =>
              sessionId === "failed"
                ? Effect.fail(failure)
                : Effect.sync(() => {
                    deletedAt.push(cwd);
                  }),
          },
        });
        yield* Effect.gen(function* () {
          yield* seed;
          const management = yield* AcpRegistryManagement.AcpRegistryManagement;
          expect(yield* management.deleteSession(nativeInput)).toEqual({ deleted: true });
          expect(deletedAt).toEqual([workspaceRoot]);
          expect(
            yield* Effect.result(management.deleteSession({ ...nativeInput, sessionId: "failed" })),
          ).toEqual(Result.fail(failure));
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "validates provider configuration before stopping sessions and refreshes after mutation",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          yield* seed;
          const management = yield* AcpRegistryManagement.AcpRegistryManagement;
          const providers = yield* management.listProviders({ instanceId, projectId });
          expect(providers.providers.map((provider) => provider.providerId)).toEqual([
            "optional",
            "required",
          ]);
          const invalid = yield* Effect.result(
            management.setProvider({
              instanceId,
              projectId,
              providerId: "optional",
              apiType: "unsupported",
              baseUrl: "https://example.com",
            }),
          );
          expect(Result.isFailure(invalid) && invalid.failure.reason).toBe(
            "provider_configuration_failed",
          );
          const required = yield* Effect.result(
            management.disableProvider({ instanceId, projectId, providerId: "required" }),
          );
          expect(Result.isFailure(required) && required.failure.reason).toBe(
            "provider_configuration_failed",
          );
          expect(harness.actions).toEqual([]);
          expect(
            yield* management.setProvider({
              instanceId,
              projectId,
              providerId: "optional",
              apiType: "openai",
              baseUrl: "https://example.com",
            }),
          ).toEqual({ configured: true });
          expect(
            yield* management.disableProvider({ instanceId, projectId, providerId: "optional" }),
          ).toEqual({ disabled: true });
          expect(yield* management.logout({ instanceId })).toEqual({ loggedOut: true });
          expect(harness.actions).toEqual([
            `set:${workspaceRoot}`,
            "refresh",
            `disable:${workspaceRoot}`,
            "refresh",
            "logout:C:/environment",
            "refresh",
          ]);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );
});
