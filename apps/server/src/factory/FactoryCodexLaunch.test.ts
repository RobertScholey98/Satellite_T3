// @effect-diagnostics nodeBuiltinImport:off -- the live probe runs the pinned Codex image against a capture server.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ConfinedProviderLaunch from "../orchestration-v2/Adapters/ConfinedProviderLaunch.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as FactoryConfinedLaunch from "./FactoryConfinedLaunch.ts";
import { admissibleFactorySourcePath, FACTORY_AGENT_IMAGE } from "./FactoryExecutionProfile.ts";

// prepareFactoryLaunch can inspect a Claude image, so its context includes a process runner.
const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const settings = Schema.decodeUnknownSync(CodexSettings);
const readJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
/** Names of every tool a model request offers, including namespaced and deferred tools. */
const offeredTools = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.flatMap(offeredTools)
    : typeof value === "object" && value !== null
      ? [
          ...("type" in value &&
          "name" in value &&
          typeof value.name === "string" &&
          ["function", "custom", "namespace"].includes(String(value.type))
            ? [value.name]
            : []),
          ...Object.values(value).flatMap(offeredTools),
        ]
      : [];
const live = process.env.SATELLITE_FACTORY_LIVE_TEST === "1" ? it.effect : it.effect.skip;

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
      const result = yield* FactoryConfinedLaunch.prepareFactoryLaunch({
        profile,
        provider: {
          driver: "codex",
          settings: settings({
            homePath: home,
            launchArgs: "--yolo -c mcp_servers.host.command=privileged",
          }),
          environment: {
            PATH: "allowed",
            GH_TOKEN: "forbidden",
            AWS_SECRET_ACCESS_KEY: "forbidden",
            CODEX_HOME: home,
          },
        },
        containerName: "factory-test",
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
      assert.include(result.args, "agents.enabled=false");
      assert.include(result.args, "features.multi_agent=false");
      assert.include(result.args, "features.multi_agent_v2=false");
      assert.equal(
        yield* fs.readFileString(path.join(home, "config.toml")),
        '[mcp_servers.host]\ncommand="privileged"',
      );
      assert.notInclude(
        yield* fs.readFileString(path.join(profile.runtimePath, "codex", "config.toml")),
        "mcp_servers.host",
      );
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect(
  "does not fall back to the host provider when the selected model credential is missing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const failure = yield* FactoryConfinedLaunch.prepareFactoryLaunch({
        profile: {
          boundaryId: "missing",
          dockerContext: "local",
          imageId: "sha256:test",
          projectSnapshotPath: root,
          workflowSnapshotPath: root,
          runtimePath: path.join(root, "runtime"),
        },
        provider: {
          driver: "codex",
          settings: settings({ homePath: path.join(root, "empty") }),
          environment: {},
        },
        containerName: "factory-missing",
      }).pipe(Effect.flip);
      assert.equal(failure._tag, "ConfinedLaunchError");
      assert.include(failure.detail, "file-based Codex");
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("keeps the factory refusal that stopped a launch as its cause", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const stopPath = path.join(root, "retro-stopped");
    yield* fs.writeFileString(stopPath, "");
    const failure = yield* FactoryConfinedLaunch.prepareFactoryLaunch({
      profile: {
        boundaryId: "stopped-retro",
        dockerContext: "local",
        imageId: "sha256:test",
        projectSnapshotPath: root,
        workflowSnapshotPath: root,
        runtimePath: path.join(root, "runtime"),
        retro: {
          retroId: "retro",
          assignmentId: "assignment",
          conclusionId: "conclusion",
          evidenceDigest: "digest",
          sourceBasis: "final-candidate",
          stopPath,
        },
      },
      provider: {
        driver: "codex",
        settings: settings({ homePath: path.join(root, "empty") }),
        environment: {},
      },
      containerName: "factory-stopped-retro",
    }).pipe(Effect.flip);
    assert.equal(failure._tag, "ConfinedLaunchError");
    assert.equal(
      failure.detail,
      "This retrospective runtime has stopped. Its evidence remains available.",
    );
    assert.deepInclude(failure.cause, { _tag: "FactoryError", code: "execution-unavailable" });
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("launches and fences a confinement from the profile it carries", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const revocationPath = path.join(root, "authority", "revoked.json");
    yield* fs.makeDirectory(path.dirname(revocationPath));
    const profile = {
      boundaryId: "profile:thread",
      dockerContext: "owned-context",
      imageId: "sha256:verified",
      projectSnapshotPath: path.join(root, "project"),
      workflowSnapshotPath: path.join(root, "workflow"),
      runtimePath: path.join(root, "runtime"),
      assignmentWorkspace: {
        assignmentId: "assignment",
        volumeName: "owned-volume",
        grantEpoch: 0,
        boundaryId: "baseline",
        controlsPath: root,
        revocationPath,
        workerUid: 65532,
        workerGid: 65532,
      },
    };
    const confinement = {
      boundaryId: profile.boundaryId,
      workspacePath: profile.projectSnapshotPath,
      profile,
    };
    const launcher = yield* ConfinedProviderLaunch.ConfinedProviderLaunch;
    const launch = yield* launcher.prepare({
      confinement,
      driver: "codex",
      settings: settings({ homePath: path.join(root, "empty") }),
      environment: { PATH: "host-path", OPENAI_API_KEY: "model-test" },
    });
    const containerName = launch.args[launch.args.indexOf("--name") + 1] ?? "";
    assert.match(containerName, /^satellite-factory-/);
    assert.equal(launch.name, containerName);
    assert.deepEqual(launch.cleanup, {
      command: "docker",
      args: ["--context", "owned-context", "rm", "--force", containerName],
      environment: { PATH: "host-path" },
    });
    yield* launcher.assertActive(confinement);
    yield* fs.writeFileString(revocationPath, "{}");
    assert.include(
      (yield* launcher.assertActive(confinement).pipe(Effect.flip)).message,
      "execution grant was withdrawn",
    );
    const unreadable = { ...confinement, profile: { boundaryId: 1 } };
    assert.equal(
      (yield* launcher.assertActive(unreadable).pipe(Effect.flip)).code,
      "execution-unavailable",
    );
    assert.equal(
      (yield* launcher
        .prepare({
          driver: "codex",
          confinement: unreadable,
          settings: settings({}),
          environment: {},
        })
        .pipe(Effect.flip))._tag,
      "ConfinedLaunchError",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      FactoryConfinedLaunch.layerConfinedLaunch.pipe(Layer.provide(ProcessRunner.layer)),
    ),
    Effect.provide(NodeServices.layer),
  ),
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
    ConfinedProviderLaunch.confinedEndpoint("http://127.0.0.1:4000/mcp"),
    "http://host.docker.internal:4000/mcp",
  );
  assert.equal(
    ConfinedProviderLaunch.confinedEndpoint("https://environment.example/mcp"),
    "https://environment.example/mcp",
  );
});

it.effect(
  "suspension blocks provider launch across recreation without granting revoked execution",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const authority = path.join(root, "authority");
      yield* fs.makeDirectory(authority);
      const profile = {
        boundaryId: "suspended-profile",
        dockerContext: "local",
        imageId: "sha256:qualified",
        projectSnapshotPath: root,
        workflowSnapshotPath: root,
        runtimePath: path.join(root, "runtime"),
        assignmentWorkspace: {
          assignmentId: "paused-assignment",
          volumeName: "preserved-volume",
          grantEpoch: 3,
          boundaryId: "approved-boundary",
          controlsPath: root,
          revocationPath: path.join(authority, "revoked.json"),
          workerUid: 10001,
          workerGid: 10001,
        },
      };
      const launch = () =>
        FactoryConfinedLaunch.prepareFactoryLaunch({
          profile,
          provider: {
            driver: "codex",
            settings: settings({ homePath: path.join(root, "empty") }),
            environment: { OPENAI_API_KEY: "test-model-key" },
          },
          containerName: "factory-paused",
        });
      yield* fs.writeFileString(
        path.join(authority, "suspension.json"),
        '{"generation":1,"state":"suspended"}',
      );
      assert.include((yield* launch().pipe(Effect.flip)).detail, "paused");
      assert.isFalse(yield* fs.exists(profile.runtimePath));
      yield* fs.writeFileString(
        path.join(authority, "suspension.json"),
        '{"generation":1,"state":"resumed"}',
      );
      const result = yield* launch();
      assert.equal(result.command, "docker");
      assert.include(
        result.args,
        "type=volume,source=preserved-volume,target=/workspace,volume-nocopy",
      );
      yield* fs.writeFileString(profile.assignmentWorkspace.revocationPath, "{}");
      assert.include((yield* launch().pipe(Effect.flip)).detail, "withdrawn");
    }).pipe(Effect.scoped, Effect.provide(services)),
);

live(
  "the pinned Codex image offers a managed session no native subagent tools",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const launch = yield* FactoryConfinedLaunch.prepareFactoryLaunch({
        profile: {
          boundaryId: "native-subagent-probe",
          dockerContext: "local",
          imageId: FACTORY_AGENT_IMAGE,
          projectSnapshotPath: root,
          workflowSnapshotPath: root,
          runtimePath: path.join(root, "runtime"),
        },
        provider: {
          driver: "codex",
          settings: settings({ homePath: path.join(root, "empty") }),
          environment: { OPENAI_API_KEY: "unused" },
        },
        containerName: "factory-native-subagent-probe",
      });
      const managedConfig = launch.args.flatMap((value, index) =>
        launch.args[index - 1] === "-c" ? ["-c", value] : [],
      );
      // A capture server stands in for the model, so the probe records the
      // tools Codex would offer without spending on a real model request.
      const requests: Array<string> = [];
      const server = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server>((resume) => {
          const server = NodeHttp.createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => (body += chunk));
            request.on("end", () => {
              requests.push(body);
              response.writeHead(400, { "content-type": "application/json" });
              response.end('{"error":{"message":"probe","type":"invalid_request_error"}}');
            });
          });
          server.listen(0, "0.0.0.0", () => resume(Effect.succeed(server)));
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
      );
      const address = server.address();
      assert.isObject(address);
      const port = typeof address === "object" && address !== null ? address.port : 0;
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) =>
            NodeChildProcess.execFile(
              "docker",
              [
                "run",
                "--rm",
                "--add-host",
                "host.docker.internal:host-gateway",
                "--tmpfs",
                "/runtime/codex",
                "--tmpfs",
                "/workspace",
                "--workdir",
                "/workspace",
                "--env",
                "PROBE_KEY=unused",
                "--entrypoint",
                "codex",
                FACTORY_AGENT_IMAGE,
                "exec",
                "--skip-git-repo-check",
                ...managedConfig,
                "-c",
                'model_provider="probe"',
                "-c",
                'model_providers.probe.name="probe"',
                "-c",
                `model_providers.probe.base_url="http://host.docker.internal:${port}/v1"`,
                "-c",
                'model_providers.probe.env_key="PROBE_KEY"',
                "-c",
                'model_providers.probe.wire_api="responses"',
                "-c",
                "model_providers.probe.request_max_retries=0",
                "-c",
                "model_providers.probe.stream_max_retries=0",
                "-c",
                "model_providers.probe.supports_websockets=false",
                "-c",
                // The bundled catalog turns on native subagents (multi-agent V2) for this model.
                'model="gpt-6-sol"',
                "Start the assignment.",
              ],
              () => resolve(),
            ),
          ),
      );
      assert.isNotEmpty(requests);
      const tools = offeredTools(yield* readJson(requests[0] ?? ""));
      assert.include(tools, "exec");
      assert.notInclude(tools, "collaboration");
      assert.notInclude(tools, "spawn_agent");
    }).pipe(Effect.scoped, Effect.provide(services)),
  120_000,
);
