import { FactoryError, isFactoryError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ConfinedProviderLaunch from "../orchestration-v2/Adapters/ConfinedProviderLaunch.ts";
import type { ConfinedExecution } from "../orchestration-v2/ThreadGovernance.ts";
import * as ProcessRunner from "../processRunner.ts";
import { prepareFactoryClaudeLaunch } from "./FactoryClaudeLaunch.ts";
import { prepareFactoryCodexLaunch } from "./FactoryCodexLaunch.ts";
import {
  FACTORY_PROVIDER_CREDENTIAL_FILES,
  factoryDockerArguments,
  FactoryExecutionProfile,
  makeFactoryProviderHomes,
} from "./FactoryExecutionProfile.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";

const isLaunchError = Schema.is(ConfinedProviderLaunch.ConfinedLaunchError);

// Host configuration such as `binaryPath` or `launchArgs` never shapes the boundary.
const prepareProvider = (
  profile: FactoryExecutionProfile,
  provider: ConfinedProviderLaunch.ConfinedProvider,
) => {
  switch (provider.driver) {
    case "codex":
      return prepareFactoryCodexLaunch({
        profile,
        settings: provider.settings,
        environment: provider.environment,
      });
    case "claudeAgent":
      return prepareFactoryClaudeLaunch({
        profile,
        settings: provider.settings,
        environment: provider.environment,
      });
  }
};

/**
 * Builds the `docker` command that starts a provider inside a profile's boundary. Refuses a held
 * profile, reduces the host environment to what the Docker CLI needs, and leaves the provider's
 * credential and arguments to its driver.
 */
export const prepareFactoryLaunch = Effect.fn("prepareFactoryLaunch")(
  function* (input: {
    readonly profile: FactoryExecutionProfile;
    readonly containerName: string;
    readonly provider: ConfinedProviderLaunch.ConfinedProvider;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { profile } = input;
    yield* assertFactoryProfileActive(profile);
    for (const directory of [
      profile.runtimePath,
      ...(yield* makeFactoryProviderHomes(fs, path, profile.runtimePath)),
    ]) {
      if (path.relative(directory, yield* fs.realPath(directory)) !== "") {
        return yield* new ConfinedProviderLaunch.ConfinedLaunchError({
          detail: "The managed provider home must not contain filesystem links.",
        });
      }
    }
    const environment = Object.fromEntries(
      [
        "PATH",
        "Path",
        "SystemRoot",
        "SYSTEMROOT",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
      ].flatMap((key) =>
        input.provider.environment[key] === undefined
          ? []
          : [[key, input.provider.environment[key]]],
      ),
    );
    // A thread can switch provider within its approved pool, and its runtime directory outlives
    // each launch, so no provider finds another's credential there. Codex writes its own anew.
    for (const credential of FACTORY_PROVIDER_CREDENTIAL_FILES) {
      yield* fs.remove(path.join(profile.runtimePath, credential), { force: true });
    }
    const provider = yield* prepareProvider(profile, input.provider);
    return {
      command: "docker",
      args: [...factoryDockerArguments(profile), "--name", input.containerName, ...provider.args],
      // Secrets ride `--env NAME`, which forwards the value from the Docker CLI's environment and
      // keeps it out of the argv.
      environment: { ...environment, ...provider.environment },
      hostEnvironment: environment,
      ...("renewBy" in provider ? { renewBy: provider.renewBy } : {}),
    };
  },
  Effect.mapError((cause) =>
    isLaunchError(cause)
      ? cause
      : new ConfinedProviderLaunch.ConfinedLaunchError({
          // The factory's refusal is written for the user, such as a paused assignment.
          detail: isFactoryError(cause)
            ? (cause.detail ?? "The managed execution boundary is unavailable.")
            : "The isolated provider account could not be prepared.",
          cause,
        }),
  ),
);

const decodeProfile = Schema.decodeUnknownEffect(FactoryExecutionProfile);

/** Runs a managed thread's provider in its Docker boundary, as `ThreadGovernance` confined it. */
export const layerConfinedLaunch = Layer.effect(
  ConfinedProviderLaunch.ConfinedProviderLaunch,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const runner = yield* ProcessRunner.ProcessRunner;
    const profileOf = (confinement: ConfinedExecution) =>
      decodeProfile(confinement.profile).pipe(
        Effect.mapError((cause) => new FactoryError({ code: "execution-unavailable", cause })),
      );
    return ConfinedProviderLaunch.ConfinedProviderLaunch.of({
      prepare: ({ confinement, ...provider }) =>
        Effect.gen(function* () {
          const profile = yield* profileOf(confinement);
          // Each provider process runs in its own named container.
          const containerName = `satellite-factory-${yield* crypto.randomUUIDv4}`;
          const { hostEnvironment, ...launch } = yield* prepareFactoryLaunch({
            profile,
            containerName,
            provider,
          });
          return {
            ...launch,
            name: containerName,
            cleanup: {
              command: "docker",
              args: ["--context", profile.dockerContext, "rm", "--force", containerName],
              environment: hostEnvironment,
            },
          };
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.mapError((cause) =>
            isLaunchError(cause)
              ? cause
              : new ConfinedProviderLaunch.ConfinedLaunchError({
                  detail: "The managed execution boundary is unavailable.",
                  cause,
                }),
          ),
        ),
      assertActive: (confinement) =>
        profileOf(confinement).pipe(
          Effect.flatMap(assertFactoryProfileActive),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
    });
  }),
);
