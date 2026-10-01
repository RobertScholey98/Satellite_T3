import { deepMerge } from "@t3tools/shared/Struct";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse, type ParseError } from "jsonc-parser";

import { expandHomePath } from "../pathExpansion.ts";

const Config = Schema.Record(Schema.String, Schema.Json);
const decodeConfig = Schema.decodeUnknownEffect(Config);
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(Config));
const providerKeys = new Set([
  "provider",
  "model",
  "small_model",
  "enabled_providers",
  "disabled_providers",
]);

class OpenCodeIdeaConfigError extends Schema.TaggedError<OpenCodeIdeaConfigError>()(
  "OpenCodeIdeaConfigError",
  { message: Schema.String },
) {}

/** Preserve model routing and sign-in while native sessions stay inside the idea. */
export const prepareOpenCodeIdeaEnvironment = Effect.fn("prepareOpenCodeIdeaEnvironment")(
  function* (input: {
    readonly directory: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly purpose: "thread" | "updates";
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = input.environment ?? process.env;
    const home = environment.HOME || environment.USERPROFILE || expandHomePath("~");
    const sourceConfigDirectory = path.join(
      environment.XDG_CONFIG_HOME || path.join(home, ".config"),
      "opencode",
    );
    const sourceDataDirectory = path.join(
      environment.XDG_DATA_HOME || path.join(home, ".local", "share"),
      "opencode",
    );
    const sourceHomeDirectory = path.join(environment.OPENCODE_TEST_HOME || home, ".opencode");

    // Native substitution resolves relative credential files beside their source config.
    const rebaseFiles = (value: Schema.Json, directory: string): Schema.Json => {
      if (typeof value === "string") {
        return value.replace(/\{file:([^}]+)\}/g, (_match, reference: string) => {
          const source = reference.startsWith("~/")
            ? path.join(home, reference.slice(2))
            : path.resolve(directory, reference);
          return `{file:${source}}`;
        });
      }
      if (Array.isArray(value)) return value.map((entry) => rebaseFiles(entry, directory));
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, rebaseFiles(entry, directory)]),
        );
      }
      return value;
    };
    const readConfig = Effect.fn("OpenCodeIdeaEnvironment.readConfig")(function* (
      text: string,
      directory: string,
    ) {
      const errors: ParseError[] = [];
      const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
      if (errors.length > 0) {
        return yield* new OpenCodeIdeaConfigError({
          message: "Could not read configured OpenCode provider settings.",
        });
      }
      const config = yield* decodeConfig(parsed).pipe(
        Effect.mapError(
          () =>
            new OpenCodeIdeaConfigError({
              message: "Could not read configured OpenCode provider settings.",
            }),
        ),
      );
      return Object.fromEntries(
        Object.entries(config)
          .filter(([key]) => providerKeys.has(key))
          .map(([key, value]) => [key, rebaseFiles(value, directory)]),
      );
    });
    let config: typeof Config.Type = {};
    const extraConfigDirectory = environment.OPENCODE_CONFIG_DIR;
    const files = [
      ...["config.json", "opencode.json", "opencode.jsonc"].map((name) =>
        path.join(sourceConfigDirectory, name),
      ),
      ...(environment.OPENCODE_CONFIG ? [expandHomePath(environment.OPENCODE_CONFIG)] : []),
      ...["opencode.json", "opencode.jsonc"].map((name) => path.join(sourceHomeDirectory, name)),
      ...(extraConfigDirectory
        ? ["opencode.json", "opencode.jsonc"].map((name) =>
            path.join(expandHomePath(extraConfigDirectory), name),
          )
        : []),
    ];
    for (const file of files) {
      if (!(yield* fs.exists(file))) continue;
      config = deepMerge(
        config,
        yield* readConfig(yield* fs.readFileString(file), path.dirname(file)),
      );
    }
    if (environment.OPENCODE_CONFIG_CONTENT) {
      config = deepMerge(
        config,
        yield* readConfig(environment.OPENCODE_CONFIG_CONTENT, input.directory),
      );
    }

    const root = path.join(input.directory, "runtime", `opencode-${input.purpose}`);
    const ownedData = path.join(root, "data");
    const ownedConfig = path.join(root, "config");
    const ownedConfigDirectory = path.join(ownedConfig, "opencode");
    const ownedAuth = path.join(ownedData, "opencode", "auth.json");
    const temporary = path.join(root, "tmp");
    for (const directory of [ownedConfigDirectory, path.dirname(ownedAuth), temporary]) {
      yield* fs.makeDirectory(directory, { recursive: true });
    }
    const sourceAuth = path.join(sourceDataDirectory, "auth.json");
    if (environment.OPENCODE_AUTH_CONTENT) {
      yield* fs.writeFileString(ownedAuth, environment.OPENCODE_AUTH_CONTENT, { mode: 0o600 });
    } else if (yield* fs.exists(sourceAuth)) {
      yield* fs.copyFile(sourceAuth, ownedAuth);
      yield* fs.chmod(ownedAuth, 0o600);
    } else {
      yield* fs.remove(ownedAuth, { force: true });
    }
    const content = encodeConfig({ ...config, share: "disabled", snapshot: false });
    const ownedConfigFile = path.join(ownedConfigDirectory, "opencode.json");
    yield* fs.writeFileString(ownedConfigFile, content, { mode: 0o600 });
    const result: NodeJS.ProcessEnv = {
      ...environment,
      XDG_DATA_HOME: ownedData,
      XDG_CONFIG_HOME: ownedConfig,
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      // OpenCode also scans ~/.opencode independently of project config discovery.
      OPENCODE_TEST_HOME: path.join(root, "home"),
      OPENCODE_CONFIG: ownedConfigFile,
      OPENCODE_CONFIG_DIR: ownedConfigDirectory,
      OPENCODE_CONFIG_CONTENT: content,
      // Pure mode skips external plugins; built-in subscription auth plugins remain enabled.
      OPENCODE_PURE: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      OPENCODE_AUTO_SHARE: "false",
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    };
    return result;
  },
);
