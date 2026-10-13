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
// a container that refreshed it would sign the host's Claude Code out. A file without a Claude
// sign-in, such as one holding only MCP sign-ins, has no `claudeAiOauth`.
const FileCredentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({ accessToken: Schema.String, expiresAt: Schema.Number }),
  ),
});
const decodeFileCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(FileCredentials));

const REFRESH_MARGIN_MS = 5 * 60 * 1_000;

const NO_CREDENTIAL =
  "Managed Claude needs a file-based Claude sign-in, or CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the provider's environment.";

// Claude Code reads these to reach another backend or endpoint. The container would either ignore
// them or need their credentials, so a provider set up this way is refused rather than switched
// to a different account.
const OTHER_BACKENDS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
] as const;

// Claude Code treats a `CLAUDE_CODE_USE_*` switch as on only for these values.
const isSwitchedOn = (value: string) =>
  ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const fileAccessToken = Effect.fnUntraced(function* (input: {
  readonly settings: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveClaudeHomePath(input.settings, input.environment);
  const file = path.join(configDir, ".credentials.json");
  if (!(yield* fs.exists(file))) return yield* new ConfinedLaunchError({ detail: NO_CREDENTIAL });
  const credentials = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeFileCredentials),
    Effect.mapError(
      (cause) =>
        new ConfinedLaunchError({
          detail: `Claude's sign-in file ${file} could not be read. Open Claude Code on this machine to sign in again, then retry.`,
          cause,
        }),
    ),
  );
  if (credentials.claudeAiOauth === undefined)
    return yield* new ConfinedLaunchError({ detail: NO_CREDENTIAL });
  const renewBy = credentials.claudeAiOauth.expiresAt - REFRESH_MARGIN_MS;
  if ((yield* Clock.currentTimeMillis) >= renewBy) {
    return yield* new ConfinedLaunchError({
      detail: "Open Claude Code on this machine to refresh its sign-in, then retry.",
    });
  }
  return { value: credentials.claudeAiOauth.accessToken, renewBy };
});

/**
 * The model credential a managed Claude launch passes into its runtime, first match wins: the
 * provider environment's `CLAUDE_CODE_OAUTH_TOKEN`, its `ANTHROPIC_API_KEY`, or the access token
 * of the selected config directory's file-based sign-in, which expires at `renewBy`. This is the
 * host CLI's order, so managed and unmanaged threads use the same account. Never falls back to
 * another credential, and refuses a provider set up for another backend.
 */
export const resolveFactoryClaudeCredential = Effect.fn("resolveFactoryClaudeCredential")(
  function* (input: {
    readonly settings: ClaudeSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const backend = OTHER_BACKENDS.find((name) => {
      const value = input.environment[name];
      if (value === undefined || value.trim() === "") return false;
      return name.startsWith("CLAUDE_CODE_USE_") ? isSwitchedOn(value) : true;
    });
    if (backend !== undefined)
      return yield* new ConfinedLaunchError({
        detail: `Managed Claude supports the Anthropic API with a Claude sign-in or API key; this provider uses ${backend}.`,
      });
    if (input.environment.CLAUDE_CODE_OAUTH_TOKEN)
      return { name: "CLAUDE_CODE_OAUTH_TOKEN", value: input.environment.CLAUDE_CODE_OAUTH_TOKEN };
    if (input.environment.ANTHROPIC_API_KEY)
      return { name: "ANTHROPIC_API_KEY", value: input.environment.ANTHROPIC_API_KEY };
    return { name: "CLAUDE_CODE_OAUTH_TOKEN", ...(yield* fileAccessToken(input)) };
  },
);

/**
 * Fails unless the profile's pinned image can run Claude. Profiles qualified before Claude support
 * pin an image without `claude`, which would otherwise fail as a bare "not found" from Docker.
 */
export const assertFactoryImageRunsClaude = Effect.fn("assertFactoryImageRunsClaude")(function* (
  profile: FactoryExecutionProfile,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const dockerUnavailable = new ConfinedLaunchError({
    detail: "Docker is not running on this environment. Start Docker, then retry.",
  });
  const output = yield* runner
    .run({
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
    })
    .pipe(Effect.mapError(() => dockerUnavailable));
  if (output.code !== 0)
    return yield* /no such image/i.test(output.stderr)
      ? new ConfinedLaunchError({
          detail: "The managed runtime's image is not available on this environment.",
        })
      : dockerUnavailable;
  if (!output.stdout.trim().split(/\s+/).includes("claudeAgent"))
    return yield* new ConfinedLaunchError({
      detail:
        "This managed runtime was prepared before Claude support and runs only Codex models. Choose a Codex model for it.",
    });
});

/**
 * Claude's part of a factory launch. Refuses an image that cannot run Claude first, then passes
 * exactly one model credential through the Docker CLI's environment. Returns the `docker run`
 * arguments from the credential through the image, run as `claude`.
 */
export const prepareFactoryClaudeLaunch = Effect.fn("prepareFactoryClaudeLaunch")(
  function* (input: {
    readonly profile: FactoryExecutionProfile;
    readonly settings: ClaudeSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    yield* assertFactoryImageRunsClaude(input.profile);
    const credential = yield* resolveFactoryClaudeCredential(input);
    return {
      args: ["--env", credential.name, "--entrypoint", "claude", input.profile.imageId],
      environment: { [credential.name]: credential.value },
      ...("renewBy" in credential ? { renewBy: credential.renewBy } : {}),
    };
  },
);
