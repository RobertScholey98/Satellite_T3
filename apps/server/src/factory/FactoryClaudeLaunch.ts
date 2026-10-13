import type { ClaudeSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ConfinedLaunchError } from "../orchestration-v2/Adapters/ConfinedProviderLaunch.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import {
  FACTORY_IMAGE_PROVIDERS_LABEL,
  type FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";

// Decoding keeps only the access token and its expiry. The refresh token never leaves the host:
// a container that refreshed it would sign the host's Claude Code out.
const FileCredentials = Schema.Struct({
  claudeAiOauth: Schema.Struct({ accessToken: Schema.String, expiresAt: Schema.Number }),
});
const decodeFileCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(FileCredentials));

const REFRESH_MARGIN_MS = 5 * 60 * 1_000;

const fileAccessToken = Effect.fnUntraced(function* (input: {
  readonly settings: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveClaudeHomePath(input.settings, input.environment);
  const credentials = yield* fs.readFileString(path.join(configDir, ".credentials.json")).pipe(
    Effect.flatMap(decodeFileCredentials),
    Effect.mapError(
      () =>
        new ConfinedLaunchError({
          detail:
            "Managed Claude needs a file-based Claude sign-in, or CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the provider's environment.",
        }),
    ),
  );
  if (credentials.claudeAiOauth.expiresAt - (yield* Clock.currentTimeMillis) < REFRESH_MARGIN_MS) {
    return yield* new ConfinedLaunchError({
      detail: "Open Claude Code on this machine to refresh its sign-in, then retry.",
    });
  }
  return credentials.claudeAiOauth.accessToken;
});

/**
 * Fails unless the profile's pinned image can run Claude. Profiles qualified before Claude support
 * pin an image without `claude`, which would otherwise fail as a bare "not found" from Docker.
 */
export const assertFactoryImageRunsClaude = Effect.fn("assertFactoryImageRunsClaude")(function* (
  profile: FactoryExecutionProfile,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const output = yield* runner.run({
    command: "docker",
    args: [
      "--context",
      profile.dockerContext,
      "image",
      "inspect",
      profile.imageId,
      "--format",
      `{{index .Config.Labels "${FACTORY_IMAGE_PROVIDERS_LABEL}"}}`,
    ],
  });
  if (output.code !== 0)
    return yield* new ConfinedLaunchError({
      detail: "The managed runtime's image is not available on this environment.",
    });
  if (!output.stdout.trim().split(/\s+/).includes("claudeAgent"))
    return yield* new ConfinedLaunchError({
      detail:
        "This managed runtime was prepared before Claude support and runs only Codex models. Choose a Codex model for it.",
    });
});

/**
 * Claude's part of a factory launch. Passes exactly one model credential through the Docker CLI's
 * environment, first match wins: the instance's `CLAUDE_CODE_OAUTH_TOKEN`, its
 * `ANTHROPIC_API_KEY`, or the access token of the selected config directory's file-based sign-in.
 * Refuses an image that cannot run Claude first. Returns the `docker run` arguments from the
 * credential through the image, run as `claude`.
 */
export const prepareFactoryClaudeLaunch = Effect.fn("prepareFactoryClaudeLaunch")(
  function* (input: {
    readonly profile: FactoryExecutionProfile;
    readonly settings: ClaudeSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    yield* assertFactoryImageRunsClaude(input.profile);
    const credential = input.environment.CLAUDE_CODE_OAUTH_TOKEN
      ? { name: "CLAUDE_CODE_OAUTH_TOKEN", value: input.environment.CLAUDE_CODE_OAUTH_TOKEN }
      : input.environment.ANTHROPIC_API_KEY
        ? { name: "ANTHROPIC_API_KEY", value: input.environment.ANTHROPIC_API_KEY }
        : { name: "CLAUDE_CODE_OAUTH_TOKEN", value: yield* fileAccessToken(input) };
    return {
      args: ["--env", credential.name, "--entrypoint", "claude", input.profile.imageId],
      environment: { [credential.name]: credential.value },
    };
  },
);
