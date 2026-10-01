import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { prepareOpenCodeIdeaEnvironment } from "./OpenCodeIdeaEnvironment.ts";

const decodeConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

it.effect("preserves configured models and OAuth without inheriting executable configuration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const home = path.join(directory, "provider-home");
    const sourceConfig = path.join(home, ".config", "opencode");
    const sourceData = path.join(home, ".local", "share", "opencode");
    const extraConfig = path.join(directory, "instance-config");
    for (const folder of [sourceConfig, sourceData, extraConfig, path.join(home, ".opencode")]) {
      yield* fs.makeDirectory(folder, { recursive: true });
    }
    const original = `{
      // A configured provider with a credential beside this file.
      "provider": {"custom": {"options": {"baseURL": "https://models.example/v1", "apiKey": "{file:token.txt}"}}},
      "model": "custom/old",
      "plugin": ["external-hook"],
      "mcp": {"unrelated": {"command": ["unsafe"]}},
      "agent": {"build": {"prompt": "unrelated"}},
    }`;
    yield* fs.writeFileString(path.join(sourceConfig, "opencode.jsonc"), original);
    yield* fs.writeFileString(path.join(sourceConfig, "token.txt"), "test-api-token");
    yield* fs.writeFileString(
      path.join(home, ".opencode", "opencode.json"),
      '{"provider":{"custom":{"options":{"headers":{"X-Custom":"configured"}}}},"plugin":["home-hook"]}',
    );
    yield* fs.writeFileString(
      path.join(extraConfig, "opencode.json"),
      '{"model":"custom/selected","provider":{"custom":{"options":{"timeout":60000}}}}',
    );
    const auth =
      '{"openai":{"type":"oauth","refresh":"test-refresh","access":"test-access","expires":42}}';
    yield* fs.writeFileString(path.join(sourceData, "auth.json"), auth);
    yield* fs.writeFileString(path.join(sourceData, "opencode.db"), "existing conversations");
    const idea = path.join(directory, "idea");
    const environment = {
      HOME: home,
      CUSTOM_API_TOKEN: "test-env-token",
      OPENCODE_CONFIG_DIR: extraConfig,
      OPENCODE_CONFIG_CONTENT:
        '{"small_model":"custom/fast","plugin":["inline-hook"],"permission":"allow"}',
    };
    const result = yield* prepareOpenCodeIdeaEnvironment({
      directory: idea,
      environment,
      purpose: "thread",
    });
    const config = decodeConfig(result.OPENCODE_CONFIG_CONTENT);
    expect(config).toEqual({
      provider: {
        custom: {
          options: {
            baseURL: "https://models.example/v1",
            apiKey: `{file:${path.join(sourceConfig, "token.txt")}}`,
            headers: { "X-Custom": "configured" },
            timeout: 60000,
          },
        },
      },
      model: "custom/selected",
      small_model: "custom/fast",
      share: "disabled",
      snapshot: false,
    });
    const root = path.join(idea, "runtime", "opencode-thread");
    expect(result.OPENCODE_CONFIG_DIR).toBe(path.join(root, "config", "opencode"));
    expect(result.OPENCODE_TEST_HOME).toBe(path.join(root, "home"));
    expect(result.OPENCODE_PURE).toBe("true");
    expect(result.OPENCODE_DISABLE_DEFAULT_PLUGINS).not.toBe("true");
    expect(result.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    expect(result.OPENCODE_DISABLE_CLAUDE_CODE).toBe("true");
    expect(result.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("true");
    expect(result.CUSTOM_API_TOKEN).toBe("test-env-token");
    expect(result.HOME).toBe(home);
    expect(yield* fs.readFileString(path.join(root, "data", "opencode", "auth.json"))).toBe(auth);
    expect(yield* fs.exists(path.join(root, "data", "opencode", "opencode.db"))).toBe(false);
    expect(yield* fs.readFileString(path.join(sourceData, "opencode.db"))).toBe(
      "existing conversations",
    );
    expect(yield* fs.readFileString(path.join(sourceConfig, "opencode.jsonc"))).toBe(original);
    const updates = yield* prepareOpenCodeIdeaEnvironment({
      directory: idea,
      environment,
      purpose: "updates",
    });
    expect(updates.XDG_DATA_HOME).not.toBe(result.XDG_DATA_HOME);
    expect(updates.OPENCODE_CONFIG).not.toBe(result.OPENCODE_CONFIG);
    expect(updates.TMP).not.toBe(result.TMP);
    expect(decodeConfig(updates.OPENCODE_CONFIG_CONTENT)).toEqual(config);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses configured inline credentials and removes stale owned sign-in when credentials disappear",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const home = path.join(directory, "home");
      const idea = path.join(directory, "idea");
      const auth = '{"custom":{"type":"api","key":"test-inline"}}';
      const first = yield* prepareOpenCodeIdeaEnvironment({
        directory: idea,
        purpose: "updates",
        environment: { HOME: home, OPENCODE_AUTH_CONTENT: auth },
      });
      const ownedAuth = path.join(first.XDG_DATA_HOME!, "opencode", "auth.json");
      expect(yield* fs.readFileString(ownedAuth)).toBe(auth);
      yield* prepareOpenCodeIdeaEnvironment({
        directory: idea,
        purpose: "updates",
        environment: { HOME: home },
      });
      expect(yield* fs.exists(ownedAuth)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects malformed provider config before launching with substituted defaults", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const result = yield* prepareOpenCodeIdeaEnvironment({
      directory: path.join(directory, "idea"),
      purpose: "thread",
      environment: {
        HOME: path.join(directory, "home"),
        OPENCODE_CONFIG_CONTENT: '{"provider": {invalid}',
      },
    }).pipe(Effect.flip);
    expect(result.message).toBe("Could not read configured OpenCode provider settings.");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
