import {
  FactoryError,
  isFactoryError,
  type ClaudeSettings,
  type CodexSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ConfinedProviderLaunch from "../orchestration-v2/Adapters/ConfinedProviderLaunch.ts";
import type { ConfinedExecution } from "../orchestration-v2/ThreadGovernance.ts";
import * as ProcessRunner from "../processRunner.ts";
import { assertFactoryImageRunsClaude, prepareFactoryClaudeLaunch } from "./FactoryClaudeLaunch.ts";
import { prepareFactoryCodexLaunch } from "./FactoryCodexLaunch.ts";
import {
  factoryDockerArguments,
  FactoryExecutionProfile,
  makeFactoryProviderHomes,
} from "./FactoryExecutionProfile.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";

const isLaunchError = Schema.is(ConfinedProviderLaunch.ConfinedLaunchError);

/**
 * Builds the `docker` command that starts a provider inside a profile's boundary. Refuses a held
 * profile, reduces the host environment to what the Docker CLI needs, and leaves the provider's
 * credential and arguments to its driver.
 */
export const prepareFactoryLaunch = Effect.fn("prepareFactoryLaunch")(
  function* (input: {
    readonly profile: FactoryExecutionProfile;
    readonly containerName: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly provider:
      | { readonly driver: "codex"; readonly settings: CodexSettings }
      | { readonly driver: "claudeAgent"; readonly settings: ClaudeSettings };
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { profile } = input;
    yield* assertFactoryProfileActive(profile);
    for (const directory of [
      profile.runtimePath,
      ...(yield* makeFactoryProviderHomes(fs, profile.runtimePath)),
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
        input.environment[key] === undefined ? [] : [[key, input.environment[key]]],
      ),
    );
    // Host configuration such as `binaryPath` or `launchArgs` never shapes the boundary.
    const provider =
      input.provider.driver === "codex"
        ? yield* prepareFactoryCodexLaunch({
            profile,
            settings: input.provider.settings,
            environment: input.environment,
          })
        : yield* prepareFactoryClaudeLaunch({
            profile,
            settings: input.provider.settings,
            environment: input.environment,
          });
    return {
      command: "docker",
      args: [...factoryDockerArguments(profile), "--name", input.containerName, ...provider.args],
      // Secrets ride `--env NAME`, which forwards the value from the Docker CLI's environment and
      // keeps it out of the argv.
      environment: { ...environment, ...provider.environment },
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
      prepare: (request) =>
        Effect.gen(function* () {
          const profile = yield* profileOf(request.confinement);
          // Each provider process runs in its own named container.
          const containerName = `satellite-factory-${yield* crypto.randomUUIDv4}`;
          const launch = yield* prepareFactoryLaunch({
            profile,
            containerName,
            environment: request.environment,
            provider: request,
          });
          if (request.driver === "claudeAgent") yield* assertFactoryImageRunsClaude(profile);
          return {
            ...launch,
            cleanup: {
              command: "docker",
              args: ["--context", profile.dockerContext, "rm", "--force", containerName],
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
