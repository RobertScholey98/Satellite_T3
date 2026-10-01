import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Toml from "effect/unstable/encoding/Toml";

import { expandHomePath } from "../pathExpansion.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonRecord = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json));

class CodexIdeaConfigError extends Schema.TaggedError<CodexIdeaConfigError>()(
  "CodexIdeaConfigError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not read configured Codex provider settings.";
  }
}

function encodeToml(value: Schema.Json): string {
  if (Array.isArray(value)) return `[${value.map(encodeToml).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${encodeJson(key)}=${encodeToml(entry)}`)
      .join(",")}}`;
  }
  return encodeJson(value);
}

function selectedProfile(launchArgs: string | undefined, defaultProfile: unknown) {
  let selected = typeof defaultProfile === "string" ? defaultProfile : undefined;
  const tokens = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "-p" || token === "--profile") selected = tokens[++index];
    else if (token?.startsWith("--profile=")) selected = token.slice(10);
    else if (token === "-c" || token === "--config") {
      const value = tokens[++index];
      if (value?.startsWith("profile=")) selected = value.slice(8).replace(/^"|"$/g, "");
    }
  }
  return selected;
}

const disabledFeatures = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "hooks",
  "plugins",
  "apps",
  "multi_agent",
  "multi_agent_v2",
  "memories",
  "external_agent_memory_import",
  "computer_use",
  "browser_use",
  "image_generation",
  "workspace_dependencies",
  "skill_mcp_dependency_install",
] as const;

export const CODEX_IDEA_CONFIG = {
  approval_policy: "never",
  approvals_reviewer: "user",
  sandbox_mode: "read-only",
  notify: [],
  hooks: {},
  mcp_servers: {},
  plugins: {},
  project_doc_max_bytes: 0,
  web_search: "disabled",
  "history.persistence": "none",
  "analytics.enabled": false,
  "features.skip_host_skill_discovery": true,
  "features.default_mode_request_user_input": true,
  ...Object.fromEntries(disabledFeatures.map((feature) => [`features.${feature}`, false])),
};

/** Retain model routing and credentials, never a caller's execution-policy overrides. */
export function codexIdeaModelArgs(launchArgs: string | undefined): string[] {
  const tokens = tokenizeCliArgs(launchArgs);
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const value =
      token === "-c" || token === "--config"
        ? tokens[++index]
        : token?.startsWith("--config=")
          ? token.slice(9)
          : token?.startsWith("-c=")
            ? token.slice(3)
            : undefined;
    if (
      value &&
      /^(?:model(?:_provider|_reasoning_effort|_reasoning_summary|_verbosity)?|model_providers\.[A-Za-z0-9_.-]+|service_tier|features\.api_key_model_discovery)\s*=/.test(
        value,
      )
    ) {
      result.push("-c", value);
    }
  }
  return result;
}

export const prepareCodexIdeaPolicy = Effect.fn("prepareCodexIdeaPolicy")(function* (input: {
  readonly cwd: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly purpose?: "foreground" | "updates";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = input.environment ?? process.env;
  const sourceHome = path.resolve(
    expandHomePath(input.homePath?.trim() || environment.CODEX_HOME || "~/.codex"),
  );
  const configPath = path.join(sourceHome, "config.toml");
  const sourceConfig = (yield* fs.exists(configPath))
    ? yield* fs.readFileString(configPath).pipe(
        Effect.flatMap((content) =>
          Effect.try({
            try: () => Toml.parse(content),
            catch: (cause) => new CodexIdeaConfigError({ cause }),
          }),
        ),
      )
    : {};
  const profiles = isRecord(sourceConfig.profiles) ? sourceConfig.profiles : {};
  const profileName = selectedProfile(input.launchArgs, sourceConfig.profile);
  const profile = profileName === undefined ? undefined : profiles[profileName];
  const selectedConfig = { ...sourceConfig, ...(isRecord(profile) ? profile : {}) };
  const modelConfig = yield* decodeJsonRecord(
    Object.fromEntries(
      Object.entries(selectedConfig).filter(([key]) =>
        /^(?:model(?:_provider|_providers|_reasoning_effort|_reasoning_summary|_verbosity|_context_window|_auto_compact_token_limit|_catalog_json)?|service_tier|cli_auth_credentials_store|forced_login_method|forced_chatgpt_workspace_id)$/.test(
          key,
        ),
      ),
    ),
  );
  const inheritedMcpNames = new Set<string>();
  for (const config of [sourceConfig, ...Object.values(profiles)]) {
    if (isRecord(config) && isRecord(config.mcp_servers)) {
      for (const name of Object.keys(config.mcp_servers)) inheritedMcpNames.add(name);
    }
  }
  const ownedHome = path.join(input.cwd, input.purpose === "updates" ? ".codex-updates" : ".codex");
  const hasAuthFile = yield* fs.exists(path.join(sourceHome, "auth.json"));
  // Native keyring credentials are keyed by the canonical CODEX_HOME. Keep that
  // identity when no file/token is available; conversation storage is still owned.
  const homePath =
    !hasAuthFile &&
    !environment.ACCESS_TOKEN &&
    !environment.OPENAI_API_KEY &&
    (yield* fs.exists(sourceHome))
      ? sourceHome
      : ownedHome;
  const temporaryPath = path.join(ownedHome, "tmp");
  yield* fs.makeDirectory(temporaryPath, { recursive: true });
  const ownedAuth = path.join(ownedHome, "auth.json");
  if (hasAuthFile) {
    yield* fs.copyFile(path.join(sourceHome, "auth.json"), ownedAuth);
    yield* fs.chmod(ownedAuth, 0o600);
  } else {
    yield* fs.remove(ownedAuth, { force: true });
  }
  yield* fs.writeFileString(
    path.join(ownedHome, "config.toml"),
    Object.entries(modelConfig)
      .map(([key, value]) => `${key}=${encodeToml(value)}`)
      .join("\n"),
    { mode: 0o600 },
  );
  const config = {
    ...CODEX_IDEA_CONFIG,
    "features.code_mode": input.purpose !== "updates",
    "features.code_mode_host": input.purpose !== "updates",
    ...(hasAuthFile ? { cli_auth_credentials_store: "file" } : {}),
    sqlite_home: ownedHome,
    log_dir: path.join(ownedHome, "log"),
  };
  const ownedEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    CODEX_HOME: homePath,
    CODEX_SQLITE_HOME: ownedHome,
    TMPDIR: temporaryPath,
    TMP: temporaryPath,
    TEMP: temporaryPath,
  };
  return {
    homePath,
    environment: ownedEnvironment,
    args: [
      ...Object.entries(modelConfig).flatMap(([key, value]) => [
        "-c",
        `${key}=${encodeToml(value)}`,
      ]),
      ...codexIdeaModelArgs(input.launchArgs),
      ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${encodeJson(value)}`]),
      // Codex deep-merges table overrides; an empty table does not remove native MCP servers.
      ...(homePath === sourceHome && inheritedMcpNames.size > 0
        ? [
            "-c",
            `mcp_servers=${encodeToml(Object.fromEntries([...inheritedMcpNames].map((name) => [name, { enabled: false }])))}`,
          ]
        : []),
    ],
  };
});
