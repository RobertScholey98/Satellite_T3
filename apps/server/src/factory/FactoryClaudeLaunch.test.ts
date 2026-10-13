// @effect-diagnostics nodeBuiltinImport:off -- the live probe runs the pinned image's Claude Code against a capture server.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import {
  CLAUDE_CONFINED_DISALLOWED_TOOLS,
  makeClaudeQueryOptions,
  spawnConfinedClaudeCode,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ConfinedProviderLaunch from "../orchestration-v2/Adapters/ConfinedProviderLaunch.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as FactoryConfinedLaunch from "./FactoryConfinedLaunch.ts";
import { FACTORY_AGENT_IMAGE } from "./FactoryExecutionProfile.ts";

const settings = Schema.decodeUnknownSync(ClaudeSettings);
// The test clock starts at the epoch, so these expiries are an hour and a minute away.
const signIn = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "file-access-token",
      refreshToken: "host-refresh-token",
      expiresAt,
      scopes: ["user:inference"],
      subscriptionType: "max",
    },
    oauthAccount: { emailAddress: "host@example.com" },
  });
const live = process.env.SATELLITE_FACTORY_LIVE_TEST === "1" ? it.effect : it.effect.skip;
const NO_CREDENTIAL =
  "Managed Claude needs a file-based Claude sign-in, or CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the provider's environment.";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const configDir = path.join(root, "claude-home");
  yield* fs.makeDirectory(configDir);
  const profile = {
    boundaryId: "profile:thread",
    dockerContext: "local",
    imageId: "sha256:verified",
    projectSnapshotPath: path.join(root, "project"),
    workflowSnapshotPath: path.join(root, "workflow"),
    runtimePath: path.join(root, "runtime"),
  };
  const launch = (environment: NodeJS.ProcessEnv, homePath = configDir) =>
    FactoryConfinedLaunch.prepareFactoryLaunch({
      profile,
      containerName: "factory-claude",
      environment,
      provider: {
        driver: "claudeAgent",
        settings: settings({
          homePath,
          binaryPath: "/host/bin/claude",
          launchArgs: "--dangerously-skip-permissions --mcp-config /host/privileged.json",
        }),
      },
    });
  return { fs, path, root, configDir, profile, launch };
});

it.effect("passes only the file sign-in's access token and none of the host's environment", () =>
  Effect.gen(function* () {
    const { fs, path, configDir, profile, launch } = yield* fixture;
    yield* fs.writeFileString(path.join(configDir, ".credentials.json"), signIn(3_600_000));
    const result = yield* launch({
      PATH: "allowed",
      GH_TOKEN: "forbidden",
      AWS_SECRET_ACCESS_KEY: "forbidden",
      CLAUDE_CONFIG_DIR: configDir,
    });
    assert.equal(result.command, "docker");
    assert.deepEqual(result.environment, {
      PATH: "allowed",
      CLAUDE_CODE_OAUTH_TOKEN: "file-access-token",
    });
    assert.deepEqual(result.args.slice(-7), [
      "--name",
      "factory-claude",
      "--env",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "--entrypoint",
      "claude",
      "sha256:verified",
    ]);
    const argv = result.args.join(" ");
    for (const forbidden of [
      "file-access-token",
      "host-refresh-token",
      "host@example.com",
      configDir,
      "/host/",
      "dangerously",
    ])
      assert.notInclude(argv, forbidden);
    assert.include(
      result.args,
      `type=bind,source=${profile.workflowSnapshotPath}/skills,target=/runtime/claude/skills,readonly`,
    );
    assert.deepEqual(yield* fs.readDirectory(path.join(profile.runtimePath, "claude")), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("takes the provider environment's token, then its API key, then the file sign-in", () =>
  Effect.gen(function* () {
    const { fs, path, configDir, launch } = yield* fixture;
    yield* fs.writeFileString(path.join(configDir, ".credentials.json"), signIn(3_600_000));
    const credential = (environment: NodeJS.ProcessEnv) =>
      launch(environment).pipe(
        Effect.map((result) => ({
          forwarded: result.args[result.args.indexOf("--env") + 1],
          environment: result.environment,
        })),
      );
    assert.deepEqual(
      yield* credential({ CLAUDE_CODE_OAUTH_TOKEN: "setup-token", ANTHROPIC_API_KEY: "api-key" }),
      {
        forwarded: "CLAUDE_CODE_OAUTH_TOKEN",
        environment: { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" },
      },
    );
    assert.deepEqual(yield* credential({ ANTHROPIC_API_KEY: "api-key" }), {
      forwarded: "ANTHROPIC_API_KEY",
      environment: { ANTHROPIC_API_KEY: "api-key" },
    });
    assert.deepEqual(yield* credential({}), {
      forwarded: "CLAUDE_CODE_OAUTH_TOKEN",
      environment: { CLAUDE_CODE_OAUTH_TOKEN: "file-access-token" },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a file sign-in that expires within five minutes", () =>
  Effect.gen(function* () {
    const { fs, path, configDir, launch } = yield* fixture;
    yield* fs.writeFileString(path.join(configDir, ".credentials.json"), signIn(60_000));
    const failure = yield* launch({}).pipe(Effect.flip);
    assert.equal(failure._tag, "ConfinedLaunchError");
    assert.equal(
      failure.detail,
      "Open Claude Code on this machine to refresh its sign-in, then retry.",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses without a credential instead of falling back to the host", () =>
  Effect.gen(function* () {
    const { fs, path, root, configDir, launch } = yield* fixture;
    assert.equal((yield* launch({}).pipe(Effect.flip)).detail, NO_CREDENTIAL);
    yield* fs.writeFileString(
      path.join(configDir, ".credentials.json"),
      '{"primaryApiKey":"not-a-sign-in"}',
    );
    assert.equal((yield* launch({}).pipe(Effect.flip)).detail, NO_CREDENTIAL);
    const elsewhere = path.join(root, "unconfigured");
    yield* fs.makeDirectory(elsewhere);
    assert.equal(
      (yield* launch({ CLAUDE_CONFIG_DIR: configDir }, elsewhere).pipe(Effect.flip)).detail,
      NO_CREDENTIAL,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("launches Claude only from an image that runs it, and fences the confinement", () =>
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
    const inspected: Array<ReadonlyArray<string>> = [];
    let labels = "codex claudeAgent\n";
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          inspected.push(input.args);
          return {
            stdout: labels,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    yield* Effect.gen(function* () {
      const launcher = yield* ConfinedProviderLaunch.ConfinedProviderLaunch;
      const prepare = () =>
        launcher.prepare({
          driver: "claudeAgent",
          confinement,
          settings: settings({}),
          environment: { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" },
        });
      const launch = yield* prepare();
      const containerName = launch.args[launch.args.indexOf("--name") + 1] ?? "";
      assert.match(containerName, /^satellite-factory-/);
      assert.deepEqual(launch.cleanup, {
        command: "docker",
        args: ["--context", "owned-context", "rm", "--force", containerName],
      });
      assert.deepEqual(inspected, [
        [
          "--context",
          "owned-context",
          "image",
          "inspect",
          "sha256:verified",
          "--format",
          '{{index .Config.Labels "satellite.factory.providers"}}',
        ],
      ]);
      labels = "\n";
      assert.equal(
        (yield* prepare().pipe(Effect.flip)).detail,
        "This managed runtime was prepared before Claude support and runs only Codex models. Choose a Codex model for it.",
      );
      yield* launcher.assertActive(confinement);
      yield* fs.writeFileString(revocationPath, "{}");
      assert.include(
        (yield* launcher.assertActive(confinement).pipe(Effect.flip)).message,
        "execution grant was withdrawn",
      );
      assert.include((yield* prepare().pipe(Effect.flip)).detail, "withdrawn");
    }).pipe(
      Effect.provide(
        FactoryConfinedLaunch.layerConfinedLaunch.pipe(
          Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

live(
  "the pinned image runs Claude as root with bypassed permissions and no agent tools",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, "project"));
      yield* fs.makeDirectory(path.join(root, "workflow", "skills"), { recursive: true });
      // A capture server stands in for the model, so the probe records the
      // tools Claude would offer without spending on a real model request.
      const requests: Array<{ readonly url: string; readonly body: string }> = [];
      const server = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server>((resume) => {
          const server = NodeHttp.createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => (body += chunk));
            request.on("end", () => {
              requests.push({ url: request.url ?? "", body });
              response.writeHead(400, { "content-type": "application/json" });
              response.end(
                '{"type":"error","error":{"type":"invalid_request_error","message":"probe"}}',
              );
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
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const launch = yield* FactoryConfinedLaunch.prepareFactoryLaunch({
        profile: {
          boundaryId: "claude-agent-tool-probe",
          dockerContext: NodeChildProcess.execFileSync("docker", ["context", "show"], {
            encoding: "utf8",
          }).trim(),
          imageId: FACTORY_AGENT_IMAGE,
          projectSnapshotPath: path.join(root, "project"),
          workflowSnapshotPath: path.join(root, "workflow"),
          runtimePath: path.join(root, "runtime"),
        },
        containerName: "factory-claude-agent-tool-probe",
        environment: { ...process.env, ANTHROPIC_API_KEY: "unused" },
        provider: { driver: "claudeAgent", settings: settings({}) },
      });
      const entrypoint = launch.args.indexOf("--entrypoint");
      const probeLaunch = {
        ...launch,
        args: [
          ...launch.args.slice(0, entrypoint),
          "--env",
          `ANTHROPIC_BASE_URL=http://host.docker.internal:${port}`,
          ...launch.args.slice(entrypoint),
        ],
        cleanup: {
          command: "docker",
          args: ["rm", "--force", "factory-claude-agent-tool-probe"],
        },
      };
      const sessionId = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const removed = Promise.withResolvers<void>();
      const messages = yield* Effect.promise(async () => {
        const received: Array<SDKMessage> = [];
        const session = query({
          prompt: "Start the assignment.",
          options: makeClaudeQueryOptions({
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
            nativeThreadId: sessionId,
            resume: false,
            cwd: null,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            confined: {
              spawnClaudeCodeProcess: (options) =>
                spawnConfinedClaudeCode(probeLaunch, options, async () => removed.resolve()),
              orchestrationInstructions: undefined,
            },
          }),
        });
        try {
          for await (const message of session) received.push(message);
        } catch {
          // The capture server's refusal ends the run with an API error.
        }
        await removed.promise;
        return received;
      });
      const init = messages.find(
        (message) => message.type === "system" && message.subtype === "init",
      );
      assert.deepInclude(init, { cwd: "/workspace", permissionMode: "bypassPermissions" });
      const modelRequest = requests.find((request) => request.url.startsWith("/v1/messages"));
      assert.isDefined(modelRequest);
      const offered = (yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
        ),
      )(modelRequest?.body ?? "")).tools.map((tool) => tool.name);
      assert.include(offered, "Bash");
      for (const tool of CLAUDE_CONFINED_DISALLOWED_TOOLS) assert.notInclude(offered, tool);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);
