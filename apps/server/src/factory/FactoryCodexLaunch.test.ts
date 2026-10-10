import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { prepareFactoryCodexLaunch } from "./FactoryCodexLaunch.ts";
import {
  admissibleFactorySourcePath,
  factoryContainerEndpoint,
} from "./FactoryExecutionProfile.ts";

const settings = Schema.decodeUnknownSync(CodexSettings);
const readJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "copies only model credentials and never inherits host connectors or privileged environment",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = path.join(root, "human-home");
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(
        path.join(home, "auth.json"),
        '{"OPENAI_API_KEY":"model-test","githubToken":"forbidden"}',
      );
      yield* fs.writeFileString(
        path.join(home, "config.toml"),
        '[mcp_servers.host]\ncommand="privileged"',
      );
      const profile = {
        boundaryId: "profile:thread",
        dockerContext: "local",
        imageId: "sha256:verified",
        projectSnapshotPath: path.join(root, "project"),
        workflowSnapshotPath: path.join(root, "workflow"),
        runtimePath: path.join(root, "runtime"),
      };
      const result = yield* prepareFactoryCodexLaunch({
        profile,
        settings: settings({
          homePath: home,
          launchArgs: "--yolo -c mcp_servers.host.command=privileged",
        }),
        containerName: "factory-test",
        environment: {
          PATH: "allowed",
          GH_TOKEN: "forbidden",
          AWS_SECRET_ACCESS_KEY: "forbidden",
          CODEX_HOME: home,
        },
      });
      assert.deepEqual(
        yield* fs
          .readFileString(path.join(profile.runtimePath, "codex", "auth.json"))
          .pipe(Effect.flatMap(readJson)),
        { OPENAI_API_KEY: "model-test" },
      );
      assert.isUndefined(result.environment.GH_TOKEN);
      assert.isUndefined(result.environment.AWS_SECRET_ACCESS_KEY);
      assert.isUndefined(result.environment.CODEX_HOME);
      assert.notInclude(result.args.join(" "), home);
      assert.notInclude(result.args.join(" "), "privileged");
      assert.include(result.args, "--read-only");
      assert.include(result.args, "ALL");
      assert.include(result.args, "--pull");
      assert.equal(
        yield* fs.readFileString(path.join(home, "config.toml")),
        '[mcp_servers.host]\ncommand="privileged"',
      );
      assert.notInclude(
        yield* fs.readFileString(path.join(profile.runtimePath, "codex", "config.toml")),
        "mcp_servers.host",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "does not fall back to the host provider when the selected model credential is missing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const failure = yield* prepareFactoryCodexLaunch({
        profile: {
          boundaryId: "missing",
          dockerContext: "local",
          imageId: "sha256:test",
          projectSnapshotPath: root,
          workflowSnapshotPath: root,
          runtimePath: path.join(root, "runtime"),
        },
        settings: settings({ homePath: path.join(root, "empty") }),
        environment: {},
        containerName: "factory-missing",
      }).pipe(Effect.flip);
      assert.equal(failure._tag, "FactoryCodexLaunchError");
      assert.include(failure.detail, "file-based Codex");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("excludes credential paths and traversal while retaining ordinary tracked project instructions", () => {
  for (const path of [
    ".env",
    "src/.env.production",
    ".git/config",
    "keys/service.pem",
    "../outside",
    ".aws/credentials",
    "auth.json",
  ])
    assert.isFalse(admissibleFactorySourcePath(path), path);
  for (const path of [
    "AGENTS.md",
    "package.json",
    "src/settings.ts",
    "docs/architecture.md",
    "skills/retro/SKILL.md",
  ])
    assert.isTrue(admissibleFactorySourcePath(path), path);
  assert.equal(
    factoryContainerEndpoint("http://127.0.0.1:4000/mcp"),
    "http://host.docker.internal:4000/mcp",
  );
  assert.equal(
    factoryContainerEndpoint("https://environment.example/mcp"),
    "https://environment.example/mcp",
  );
});
