import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Toml from "effect/unstable/encoding/Toml";
import { expect } from "vite-plus/test";

import { prepareCodexIdeaPolicy } from "./CodexIdeaPolicy.ts";
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

it.effect(
  "keeps configured model credentials while confining native state and discarding unsafe launch overrides",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const sourceHome = path.join(directory, "configured-home");
      const cwd = path.join(directory, "idea");
      yield* fs.makeDirectory(sourceHome);
      yield* fs.writeFileString(
        path.join(sourceHome, "auth.json"),
        '{"OPENAI_API_KEY":"test-only"}',
      );
      const config =
        'model_provider="custom"\n[model_providers.custom]\nbase_url="https://models.example/v1"\n';
      yield* fs.writeFileString(
        path.join(sourceHome, "config.toml"),
        `${config}\n[mcp_servers.unwanted]\ncommand="not-allowed"\n`,
      );
      yield* fs.makeDirectory(path.join(sourceHome, "sessions"));
      yield* fs.writeFileString(path.join(sourceHome, "sessions", "existing"), "ordinary history");
      const result = yield* prepareCodexIdeaPolicy({
        cwd,
        homePath: sourceHome,
        purpose: "updates",
        environment: { ACCESS_TOKEN: "managed-test-token", T3CODE_CODEX_LAUNCH_ARGS: "--yolo" },
        launchArgs:
          '-c model_provider="custom" -c model_providers.custom.env_key="ACCESS_TOKEN" --disable hooks -c sandbox_mode="danger-full-access" -c mcp_servers.other.command="unsafe" --yolo',
      });
      expect(result.homePath).toBe(path.join(cwd, ".codex-updates"));
      expect(result.environment.ACCESS_TOKEN).toBe("managed-test-token");
      expect(result.environment.CODEX_SQLITE_HOME).toBe(result.homePath);
      expect(result.environment.TMP).toBe(path.join(result.homePath, "tmp"));
      expect(
        Toml.parse(yield* fs.readFileString(path.join(result.homePath, "config.toml"))),
      ).toEqual(Toml.parse(config));
      expect(yield* fs.readFileString(path.join(result.homePath, "auth.json"))).toContain(
        "test-only",
      );
      expect(yield* fs.exists(path.join(result.homePath, "sessions"))).toBe(false);
      expect(result.args).toContain("model_provider=custom");
      expect(result.args).toContain("model_providers.custom.env_key=ACCESS_TOKEN");
      expect(result.args).toContain('sandbox_mode="read-only"');
      expect(result.args).toContain('approval_policy="never"');
      expect(result.args).toContain("features.shell_tool=false");
      expect(result.args).toContain("features.hooks=false");
      expect(result.args).toContain("features.code_mode=false");
      expect(result.args).toContain("features.code_mode_host=false");
      expect(result.args).toContain("mcp_servers={}");
      expect(result.args.join(" ")).not.toContain("danger-full-access");
      expect(result.args.join(" ")).not.toContain("mcp_servers.other");
      expect(result.args).not.toContain("--yolo");
      expect(yield* fs.readFileString(path.join(sourceHome, "sessions", "existing"))).toBe(
        "ordinary history",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retains a selected configuration profile's model routing without its tools", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const sourceHome = path.join(directory, "provider");
    yield* fs.makeDirectory(sourceHome);
    yield* fs.writeFileString(
      path.join(sourceHome, "config.toml"),
      [
        'model_provider="default"',
        "[model_providers.custom]",
        'base_url="https://custom.example/v1"',
        "[profiles.personal]",
        'model_provider="custom"',
        'model_reasoning_effort="high"',
        'sandbox_mode="danger-full-access"',
      ].join("\n"),
    );
    const result = yield* prepareCodexIdeaPolicy({
      cwd: path.join(directory, "idea"),
      homePath: sourceHome,
      purpose: "updates",
      launchArgs: '-c profile="personal"',
      environment: { ACCESS_TOKEN: "test-token" },
    });
    const ownedConfig = Toml.parse(
      yield* fs.readFileString(path.join(result.homePath, "config.toml")),
    );
    expect(ownedConfig.model_provider).toBe("custom");
    expect(ownedConfig.model_reasoning_effort).toBe("high");
    expect(ownedConfig.sandbox_mode).toBeUndefined();
    expect(result.args).toContain('model_provider="custom"');
    expect(result.args).toContain('sandbox_mode="read-only"');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "preserves native keyring identity while placing every conversation store inside the idea",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const sourceHome = path.join(directory, "keyring-home");
      const cwd = path.join(directory, "idea");
      yield* fs.makeDirectory(sourceHome);
      yield* fs.writeFileString(
        path.join(sourceHome, "config.toml"),
        'cli_auth_credentials_store="keyring"\n[mcp_servers.external]\ncommand="not-allowed"\n[profiles.personal.mcp_servers.other]\ncommand="also-not-allowed"',
      );
      const result = yield* prepareCodexIdeaPolicy({
        cwd,
        homePath: sourceHome,
        purpose: "updates",
        environment: {},
      });
      expect(result.homePath).toBe(sourceHome);
      expect(result.environment.CODEX_HOME).toBe(sourceHome);
      expect(result.environment.CODEX_SQLITE_HOME).toBe(path.join(cwd, ".codex-updates"));
      expect(result.args).toContain(
        `log_dir=${encodeJsonString(path.join(cwd, ".codex-updates", "log"))}`,
      );
      expect(result.args).toContain('history.persistence="none"');
      expect(result.args).toContain("features.code_mode=false");
      expect(result.args).toContain("features.code_mode_host=false");
      expect(result.args).not.toContain('cli_auth_credentials_store="file"');
      expect(result.args).toContain(
        'mcp_servers={"external"={"enabled"=false},"other"={"enabled"=false}}',
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps foreground skills, plugins and tools from the configured Codex home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const sourceHome = path.join(directory, "configured-home");
    const cwd = path.join(directory, "idea");
    yield* fs.makeDirectory(sourceHome);
    const config = '[mcp_servers.custom]\ncommand="custom-tool"\n[features]\nplugins=true\n';
    yield* fs.writeFileString(path.join(sourceHome, "config.toml"), config);
    const result = yield* prepareCodexIdeaPolicy({
      cwd,
      homePath: sourceHome,
      environment: { CUSTOM_SETTING: "retained" },
    });
    expect(result.homePath).toBe(sourceHome);
    expect(result.environment.CODEX_HOME).toBe(sourceHome);
    expect(result.environment.CUSTOM_SETTING).toBe("retained");
    expect(result.environment.CODEX_SQLITE_HOME).toBe(path.join(cwd, ".codex"));
    expect(result.args.join(" ")).not.toMatch(/sandbox|approval|features|mcp_servers/);
    expect(yield* fs.readFileString(path.join(sourceHome, "config.toml"))).toBe(config);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
