import type { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ConfinedLaunchError } from "../orchestration-v2/Adapters/ConfinedProviderLaunch.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import type { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";

// The fields of Codex's `auth.json` that are copied into a session's provider home. Decoding drops
// every other field, so only the model credential reaches the container.
const ModelCredentials = Schema.Struct({
  auth_mode: Schema.optional(Schema.String),
  OPENAI_API_KEY: Schema.optional(Schema.NullOr(Schema.String)),
  tokens: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id_token: Schema.String,
        access_token: Schema.String,
        refresh_token: Schema.String,
        account_id: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  last_refresh: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelCredentials));
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(ModelCredentials));

/**
 * Codex's part of a factory launch: rewrites the session's Codex home from scratch and passes
 * exactly one model credential, either the managed access token, a copy of the selected account's
 * file credential, or `OPENAI_API_KEY`. Returns the `docker run` arguments from the credential
 * through the image and Codex's overrides, and the secrets the Docker CLI forwards.
 */
export const prepareFactoryCodexLaunch = Effect.fn("prepareFactoryCodexLaunch")(function* (input: {
  readonly profile: FactoryExecutionProfile;
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const codexHome = path.join(input.profile.runtimePath, "codex");
  const args: Array<string> = [];
  const environment: Record<string, string> = {};
  const config: Array<string> = [
    'approval_policy="never"',
    'sandbox_mode="danger-full-access"',
    'cli_auth_credentials_store="file"',
    "features.apps=false",
    "features.plugins=false",
    "features.hooks=false",
    "features.browser_use=false",
    "features.computer_use=false",
    "features.codex_hooks=false",
    // Native subagents would share this container, but Codex lets `spawn_agent`
    // pick any catalog model and reasoning effort (by argument or agent role),
    // even with the overrides hidden from its schema. Those choices never reach
    // FactoryModelAdmission, so managed teams delegate through `delegate_task`.
    // Codex 0.161 needs all three flags: the model catalog can turn on V2 by itself.
    "agents.enabled=false",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
  ];
  const authPath = path.join(codexHome, "auth.json");
  if (input.settings.setupMode === "managed") {
    if (!input.environment.ACCESS_TOKEN)
      return yield* new ConfinedLaunchError({
        detail: "The selected managed Codex model account is not available.",
      });
    environment.ACCESS_TOKEN = input.environment.ACCESS_TOKEN;
    args.push("--env", "ACCESS_TOKEN");
    config.push(
      'model_provider="openai_token_sharing"',
      'model_providers.openai_token_sharing.name="OpenAI Token Sharing"',
      'model_providers.openai_token_sharing.base_url="https://api.openai.com/v1"',
      'model_providers.openai_token_sharing.env_key="ACCESS_TOKEN"',
      'model_providers.openai_token_sharing.wire_api="responses"',
      "model_providers.openai_token_sharing.requires_openai_auth=false",
      "model_providers.openai_token_sharing.supports_websockets=false",
    );
  } else {
    const home = yield* resolveCodexHomeLayout(input.settings);
    const nativeAuth = path.join(home.effectiveHomePath ?? home.sharedHomePath, "auth.json");
    if (yield* fs.exists(nativeAuth)) {
      const credentials = yield* fs
        .readFileString(nativeAuth)
        .pipe(Effect.flatMap(decodeCredentials));
      if (!credentials.OPENAI_API_KEY && !credentials.tokens?.access_token) {
        return yield* new ConfinedLaunchError({
          detail: "The selected Codex account has no file-based model credential.",
        });
      }
      yield* fs.writeFileString(authPath, yield* encodeCredentials(credentials), {
        flag: "wx",
        mode: 0o600,
      });
    } else if (input.environment.OPENAI_API_KEY) {
      environment.OPENAI_API_KEY = input.environment.OPENAI_API_KEY;
      args.push("--env", "OPENAI_API_KEY");
    } else {
      return yield* new ConfinedLaunchError({
        detail: "Discovery supports managed Codex sign-in or a file-based Codex model credential.",
      });
    }
  }
  const configPath = path.join(codexHome, "config.toml");
  if (yield* fs.exists(configPath)) yield* fs.remove(configPath);
  yield* fs.writeFileString(configPath, config.join("\n"), { flag: "wx" });
  args.push(input.profile.imageId);
  for (const value of config) args.push("-c", value);
  return { args, environment };
});
