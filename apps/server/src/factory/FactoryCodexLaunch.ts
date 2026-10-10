import type { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { factoryDockerArguments, type FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";

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

export class FactoryCodexLaunchError extends Schema.TaggedError<FactoryCodexLaunchError>()(
  "FactoryCodexLaunchError",
  { detail: Schema.String },
) {}

const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelCredentials));
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(ModelCredentials));
const isLaunchError = Schema.is(FactoryCodexLaunchError);

export const prepareFactoryCodexLaunch = Effect.fn("prepareFactoryCodexLaunch")(
  function* (input: {
    readonly profile: FactoryExecutionProfile;
    readonly settings: CodexSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly containerName: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { profile } = input;
    yield* assertFactoryProfileActive(profile);
    const codexHome = path.join(profile.runtimePath, "codex");
    for (const directory of [profile.runtimePath, codexHome]) {
      yield* fs.makeDirectory(directory, { recursive: true });
      if (path.relative(directory, yield* fs.realPath(directory)) !== "") {
        return yield* new FactoryCodexLaunchError({
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
    const args = [...factoryDockerArguments(profile), "--name", input.containerName];
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
    ];
    const authPath = path.join(codexHome, "auth.json");
    if (yield* fs.exists(authPath)) yield* fs.remove(authPath);
    if (input.settings.setupMode === "managed") {
      if (!input.environment.ACCESS_TOKEN)
        return yield* new FactoryCodexLaunchError({
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
          return yield* new FactoryCodexLaunchError({
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
        return yield* new FactoryCodexLaunchError({
          detail:
            "Discovery supports managed Codex sign-in or a file-based Codex model credential.",
        });
      }
    }
    const configPath = path.join(codexHome, "config.toml");
    if (yield* fs.exists(configPath)) yield* fs.remove(configPath);
    yield* fs.writeFileString(configPath, config.join("\n"), { flag: "wx" });
    args.push(profile.imageId);
    for (const value of config) args.push("-c", value);
    return { command: "docker", args, environment };
  },
  Effect.mapError((cause) =>
    isLaunchError(cause)
      ? cause
      : new FactoryCodexLaunchError({
          detail: "The isolated Codex model account could not be prepared.",
        }),
  ),
);
