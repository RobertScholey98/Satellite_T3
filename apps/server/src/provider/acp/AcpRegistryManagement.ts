import {
  AcpRegistryOperationError,
  CommandId,
  type AcpRegistryListSessionsInput,
  type AcpRegistryListSessionsResult,
  type AcpRegistryImportSessionInput,
  type AcpRegistryImportSessionResult,
  type AcpRegistryDeleteSessionInput,
  type AcpRegistryDeleteSessionResult,
  type AcpRegistryListProvidersInput,
  type AcpRegistryListProvidersResult,
  type AcpRegistrySetProviderInput,
  type AcpRegistrySetProviderResult,
  type AcpRegistryDisableProviderInput,
  type AcpRegistryDisableProviderResult,
  type AcpRegistryLogoutInput,
  type AcpRegistryLogoutResult,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ProviderAuth from "../ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../ProviderRegistry.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";

export class AcpRegistryManagement extends Context.Service<
  AcpRegistryManagement,
  {
    readonly listSessions: (
      input: AcpRegistryListSessionsInput,
    ) => Effect.Effect<AcpRegistryListSessionsResult, AcpRegistryOperationError>;
    readonly importSession: (
      input: AcpRegistryImportSessionInput,
    ) => Effect.Effect<AcpRegistryImportSessionResult, AcpRegistryOperationError>;
    readonly deleteSession: (
      input: AcpRegistryDeleteSessionInput,
    ) => Effect.Effect<AcpRegistryDeleteSessionResult, AcpRegistryOperationError>;
    readonly listProviders: (
      input: AcpRegistryListProvidersInput,
    ) => Effect.Effect<AcpRegistryListProvidersResult, AcpRegistryOperationError>;
    readonly setProvider: (
      input: AcpRegistrySetProviderInput,
    ) => Effect.Effect<AcpRegistrySetProviderResult, AcpRegistryOperationError>;
    readonly disableProvider: (
      input: AcpRegistryDisableProviderInput,
    ) => Effect.Effect<AcpRegistryDisableProviderResult, AcpRegistryOperationError>;
    readonly logout: (
      input: AcpRegistryLogoutInput,
    ) => Effect.Effect<AcpRegistryLogoutResult, AcpRegistryOperationError>;
  }
>()("t3/provider/acp/AcpRegistryManagement") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAuth = yield* ProviderAuth.ProviderAuthService;
  const acpRegistryRuntimeCoordinator =
    yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;

  const getProject = Effect.fn("AcpRegistryManagement.project")(function* (projectId: ProjectId) {
    const project = yield* projectService.getById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "project_not_found",
            message: `Project ${projectId} is unavailable.`,
            cause,
          }),
      ),
    );
    return yield* Option.match(project, {
      onNone: () =>
        Effect.fail(
          new AcpRegistryOperationError({
            reason: "project_not_found",
            message: `Project ${projectId} was not found.`,
          }),
        ),
      onSome: Effect.succeed,
    });
  });

  const getSessionManager = Effect.fn("AcpRegistryManagement.sessionManager")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* providerInstances.getInstance(instanceId);
    if (instance === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "instance_not_found",
        message: `Provider instance ${instanceId} was not found.`,
      });
    }
    if (instance.acpSessionManagement === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "session_list_unsupported",
        message: `Provider instance ${instanceId} does not expose ACP session management.`,
      });
    }
    return { instance, manager: instance.acpSessionManagement };
  });

  const importedAcpThreadId = (input: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly sessionId: string;
  }) =>
    IdAllocator.deriveThreadFromProviderThread({
      driver: input.driver,
      providerInstanceId: input.instanceId,
      nativeThreadId: input.sessionId,
    });

  const listSessions = Effect.fn("AcpRegistryManagement.listSessions")(function* (
    input: AcpRegistryListSessionsInput,
  ) {
    const project = yield* getProject(input.projectId);
    const { instance, manager } = yield* getSessionManager(input.instanceId);
    const listed = yield* manager.listSessions({
      cwd: project.workspaceRoot,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const sessions = yield* Effect.forEach(
      listed.sessions,
      (session) => {
        const threadId = importedAcpThreadId({
          driver: instance.driverKind,
          instanceId: input.instanceId,
          sessionId: session.sessionId,
        });
        return threadManagement.getThreadShell(threadId).pipe(
          Effect.map((thread) => ({
            ...session,
            importedThreadId: thread === null ? null : threadId,
          })),
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not inspect existing imported ACP sessions.",
                cause,
              }),
          ),
        );
      },
      { concurrency: 16 },
    );
    return { ...listed, sessions };
  });

  const importSession = Effect.fn("AcpRegistryManagement.importSession")(function* (
    input: AcpRegistryImportSessionInput,
  ) {
    return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
      Effect.gen(function* () {
        yield* getProject(input.projectId);
        const { instance } = yield* getSessionManager(input.instanceId);
        const providerSnapshot = yield* instance.snapshot.getSnapshot;
        if (
          providerSnapshot.nativeSessions?.canLoad !== true &&
          providerSnapshot.nativeSessions?.canResume !== true
        ) {
          return yield* new AcpRegistryOperationError({
            reason: "session_resume_unsupported",
            message: "The ACP agent cannot load or resume native sessions.",
          });
        }
        const threadId = importedAcpThreadId({
          driver: instance.driverKind,
          instanceId: input.instanceId,
          sessionId: input.sessionId,
        });
        const existing = yield* threadManagement.getThreadShell(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not inspect the imported ACP session mapping.",
                cause,
              }),
          ),
        );
        if (existing !== null) return { threadId, imported: false } as const;

        const provider = (yield* providerRegistry.getProviders).find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        const model =
          provider?.models.find((candidate) => candidate.isDefault)?.slug ??
          provider?.models[0]?.slug ??
          "default";
        const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const launched = yield* Effect.result(
          startup.enqueueCommand(
            threadLaunch.launch({
              commandId,
              threadId,
              projectId: input.projectId,
              title: input.title ?? "Imported ACP session",
              modelSelection: { instanceId: input.instanceId, model },
              runtimeMode: "approval-required",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              importedNativeThread: {
                ref: {
                  driver: instance.driverKind,
                  nativeId: input.sessionId,
                  strength: "strong",
                },
                metadata: {
                  itemIdentityVersion: 2,
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
                },
              },
              createdBy: "user",
              creationSource: "web",
            }),
          ),
        );
        if (Result.isFailure(launched)) {
          const racedImport = yield* threadManagement.getThreadShell(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new AcpRegistryOperationError({
                  reason: "session_import_failed",
                  message: "Could not inspect the imported ACP session after launch failed.",
                  cause,
                }),
            ),
          );
          if (racedImport !== null) return { threadId, imported: false } as const;
          return yield* new AcpRegistryOperationError({
            reason: "session_import_failed",
            message: "Could not create a T3 thread for the ACP session.",
            cause: launched.failure,
          });
        }
        return { threadId, imported: true } as const;
      }),
    );
  });

  const deleteSession = Effect.fn("AcpRegistryManagement.deleteSession")(function* (
    input: AcpRegistryDeleteSessionInput,
  ) {
    return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
      Effect.gen(function* () {
        const project = yield* getProject(input.projectId);
        const { instance, manager } = yield* getSessionManager(input.instanceId);
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (snapshot.nativeSessions?.canDelete !== true) {
          return yield* new AcpRegistryOperationError({
            reason: "session_delete_unsupported",
            message: "The ACP agent does not advertise session deletion.",
          });
        }
        const threadId = importedAcpThreadId({
          driver: instance.driverKind,
          instanceId: input.instanceId,
          sessionId: input.sessionId,
        });
        const importedThread = yield* threadManagement.getThreadShell(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "session_delete_failed",
                message: "Could not inspect the imported ACP session mapping.",
                cause,
              }),
          ),
        );
        if (importedThread !== null) {
          return yield* new AcpRegistryOperationError({
            reason: "session_delete_failed",
            message: "Delete the imported T3 thread before deleting its native ACP session.",
          });
        }
        yield* manager.deleteSession({
          cwd: project.workspaceRoot,
          sessionId: input.sessionId,
        });
        return { deleted: true } as const;
      }),
    );
  });

  const listProviders = Effect.fn("AcpRegistryManagement.listProviders")(function* (
    input: AcpRegistryListProvidersInput,
  ) {
    const project = yield* getProject(input.projectId);
    const { instance, manager } = yield* getSessionManager(input.instanceId);
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (snapshot.configurableProviders !== true) {
      return yield* new AcpRegistryOperationError({
        reason: "providers_unsupported",
        message: "The ACP agent does not advertise provider configuration.",
      });
    }
    return yield* manager.listProviders(project.workspaceRoot);
  });

  const setProvider = Effect.fn("AcpRegistryManagement.setProvider")(function* (
    input: AcpRegistrySetProviderInput,
  ) {
    const project = yield* getProject(input.projectId);
    const { manager } = yield* getSessionManager(input.instanceId);
    if (input.headers !== undefined && Object.keys(input.headers).length > 32) {
      return yield* new AcpRegistryOperationError({
        reason: "provider_configuration_failed",
        message: "ACP provider configuration accepts at most 32 headers.",
      });
    }
    const listed = yield* manager.listProviders(project.workspaceRoot);
    const provider = listed.providers.find(
      (candidate) => candidate.providerId === input.providerId,
    );
    if (provider === undefined || !provider.supported.includes(input.apiType)) {
      return yield* new AcpRegistryOperationError({
        reason: "provider_configuration_failed",
        message: `Provider ${input.providerId} does not support ${input.apiType}.`,
      });
    }
    yield* providerSessionManager.closeInstance(input.instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: "Could not stop live sessions before updating the ACP provider.",
            cause,
          }),
      ),
    );
    yield* manager.setProvider({
      cwd: project.workspaceRoot,
      providerId: input.providerId,
      apiType: input.apiType,
      baseUrl: input.baseUrl,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    });
    yield* providerRegistry.refreshInstance(input.instanceId);
    return { configured: true } as const;
  });

  const disableProvider = Effect.fn("AcpRegistryManagement.disableProvider")(function* (
    input: AcpRegistryDisableProviderInput,
  ) {
    const project = yield* getProject(input.projectId);
    const { manager } = yield* getSessionManager(input.instanceId);
    const listed = yield* manager.listProviders(project.workspaceRoot);
    const provider = listed.providers.find(
      (candidate) => candidate.providerId === input.providerId,
    );
    if (provider === undefined || provider.required) {
      return yield* new AcpRegistryOperationError({
        reason: "provider_configuration_failed",
        message:
          provider === undefined
            ? `Provider ${input.providerId} was not advertised by the ACP agent.`
            : `Provider ${input.providerId} is required and cannot be disabled.`,
      });
    }
    yield* providerSessionManager.closeInstance(input.instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: "Could not stop live sessions before disabling the ACP provider.",
            cause,
          }),
      ),
    );
    yield* manager.disableProvider({
      cwd: project.workspaceRoot,
      providerId: input.providerId,
    });
    yield* providerRegistry.refreshInstance(input.instanceId);
    return { disabled: true } as const;
  });

  const logout = Effect.fn("AcpRegistryManagement.logout")(function* (
    input: AcpRegistryLogoutInput,
  ) {
    const { instance, manager } = yield* getSessionManager(input.instanceId);
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (snapshot.auth.canLogout !== true) {
      return yield* new AcpRegistryOperationError({
        reason: "logout_unsupported",
        message: "The ACP agent does not advertise logout.",
      });
    }
    if (instance.auth) {
      yield* providerAuth.logout(input).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "logout_failed",
              message: "Could not sign out of the ACP agent.",
              cause,
            }),
        ),
      );
    } else {
      yield* providerSessionManager.closeInstance(input.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "logout_failed",
              message: "Could not stop live sessions before ACP logout.",
              cause,
            }),
        ),
      );
      yield* manager.logout(config.cwd);
    }
    yield* providerRegistry.refreshInstance(input.instanceId);
    return { loggedOut: true } as const;
  });

  return AcpRegistryManagement.of({
    listSessions,
    importSession,
    deleteSession,
    listProviders,
    setProvider,
    disableProvider,
    logout,
  });
});

export const layer = Layer.effect(AcpRegistryManagement, make);
