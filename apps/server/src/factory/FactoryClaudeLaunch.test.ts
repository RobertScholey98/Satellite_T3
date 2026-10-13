// @effect-diagnostics nodeBuiltinImport:off -- the live probe runs the pinned image's Claude Code against a capture server.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings, CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeConfinedClaudeRuntime } from "../orchestration-v2/Adapters/ConfinedClaudeProcess.ts";
import * as ConfinedProviderLaunch from "../orchestration-v2/Adapters/ConfinedProviderLaunch.ts";
import * as ProcessRunner from "../processRunner.ts";
import { assertFactoryImageRunsClaude } from "./FactoryClaudeLaunch.ts";
import * as FactoryConfinedLaunch from "./FactoryConfinedLaunch.ts";
import { FACTORY_AGENT_DOCKERFILE, FACTORY_AGENT_IMAGE } from "./FactoryExecutionProfile.ts";

const settings = Schema.decodeUnknownSync(ClaudeSettings);
const codexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeSdkPackage = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ claudeCodeVersion: Schema.String })),
);
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
const inspection = (stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
// Answers the image label check as an image that runs Claude.
const claudeImage = ProcessRunner.ProcessRunner.of({
  run: () => Effect.succeed(inspection("codex claudeAgent\n")),
});
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
  const launch = (environment: NodeJS.ProcessEnv, homePath = configDir, runner = claudeImage) =>
    FactoryConfinedLaunch.prepareFactoryLaunch({
      profile,
      containerName: "factory-claude",
      provider: {
        driver: "claudeAgent",
        settings: settings({
          homePath,
          binaryPath: "/host/bin/claude",
          launchArgs: "--dangerously-skip-permissions --mcp-config /host/privileged.json",
        }),
        environment,
      },
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));
  return { fs, path, root, configDir, profile, launch };
});

it.effect("passes only the file sign-in's access token and none of the host's environment", () =>
  Effect.gen(function* () {
    const { fs, path, root, configDir, profile, launch } = yield* fixture;
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
    assert.deepEqual(result.args.slice(result.args.indexOf("--name")), [
      "--name",
      "factory-claude",
      "--mount",
      `type=bind,source=${path.join(profile.runtimePath, "claude")},target=/runtime/claude`,
      "--mount",
      `type=bind,source=${path.join(root, ".claude-user", "settings.json")},target=/runtime/claude/settings.json,readonly`,
      "--mount",
      `type=bind,source=${path.join(root, ".claude-user", "commands")},target=/runtime/claude/commands,readonly`,
      "--mount",
      `type=bind,source=${path.join(root, ".claude-user", "agents")},target=/runtime/claude/agents,readonly`,
      "--env",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "--env",
      "ENABLE_CLAUDEAI_MCP_SERVERS=false",
      "--env",
      "CLAUDE_CODE_ENTRYPOINT",
      "--env",
      "CLAUDE_AGENT_SDK_VERSION",
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
          renewBy: result.renewBy,
        })),
      );
    assert.deepEqual(
      yield* credential({ CLAUDE_CODE_OAUTH_TOKEN: "setup-token", ANTHROPIC_API_KEY: "api-key" }),
      {
        forwarded: "CLAUDE_CODE_OAUTH_TOKEN",
        environment: { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" },
        renewBy: undefined,
      },
    );
    assert.deepEqual(yield* credential({ ANTHROPIC_API_KEY: "api-key" }), {
      forwarded: "ANTHROPIC_API_KEY",
      environment: { ANTHROPIC_API_KEY: "api-key" },
      renewBy: undefined,
    });
    // The file sign-in is renewed five minutes before it expires.
    assert.deepEqual(yield* credential({}), {
      forwarded: "CLAUDE_CODE_OAUTH_TOKEN",
      environment: { CLAUDE_CODE_OAUTH_TOKEN: "file-access-token" },
      renewBy: 3_300_000,
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

it.effect("pins the image's Claude Code to the version the Agent SDK drives", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sdk = NodeModule.createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const { claudeCodeVersion } = yield* fs
      .readFileString(path.join(path.dirname(sdk), "package.json"))
      .pipe(Effect.flatMap(decodeSdkPackage));
    assert.equal(
      /@anthropic-ai\/claude-code@(\S+)/.exec(FACTORY_AGENT_DOCKERFILE)?.[1],
      claudeCodeVersion,
    );
    assert.isTrue(FACTORY_AGENT_IMAGE.endsWith(`-claude-${claudeCodeVersion}`));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("replaces user-scope configuration an earlier process left with empty sources", () =>
  Effect.gen(function* () {
    const { fs, path, root, profile, launch } = yield* fixture;
    const home = path.join(profile.runtimePath, "claude");
    yield* fs.makeDirectory(path.join(home, "settings.json"), { recursive: true });
    yield* fs.makeDirectory(path.join(home, "commands"), { recursive: true });
    yield* fs.writeFileString(path.join(home, "commands", "probe.md"), "---\nmodel: opus\n---\n");
    yield* fs.makeDirectory(path.join(home, "agents"), { recursive: true });
    yield* fs.writeFileString(path.join(home, "agents", "probe.md"), "---\nmodel: opus\n---\n");
    yield* launch({ CLAUDE_CODE_OAUTH_TOKEN: "setup-token" });
    assert.deepEqual(yield* fs.readDirectory(home), []);
    const sources = path.join(root, ".claude-user");
    assert.equal(yield* fs.readFileString(path.join(sources, "settings.json")), "{}");
    assert.deepEqual(yield* fs.readDirectory(path.join(sources, "commands")), []);
    assert.deepEqual(yield* fs.readDirectory(path.join(sources, "agents")), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the cause when the file sign-in cannot be decoded", () =>
  Effect.gen(function* () {
    const { fs, path, configDir, launch } = yield* fixture;
    const file = path.join(configDir, ".credentials.json");
    yield* fs.writeFileString(file, '{"claudeAiOauth":{"accessToken":');
    const failure = yield* launch({}).pipe(Effect.flip);
    assert.equal(
      failure.detail,
      `Claude's sign-in file ${file} could not be read. Open Claude Code on this machine to sign in again, then retry.`,
    );
    assert.equal((failure.cause as { readonly _tag?: string })._tag, "SchemaError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses a provider set up for another backend instead of substituting a credential",
  () =>
    Effect.gen(function* () {
      const { fs, path, configDir, launch } = yield* fixture;
      yield* fs.writeFileString(path.join(configDir, ".credentials.json"), signIn(3_600_000));
      const credentials = { ANTHROPIC_API_KEY: "api-key", CLAUDE_CODE_OAUTH_TOKEN: "setup-token" };
      const refusals: Array<string> = [];
      for (const backend of [
        { ANTHROPIC_BASE_URL: "https://gateway.example.com" },
        { ANTHROPIC_AUTH_TOKEN: "gateway-token" },
        { CLAUDE_CODE_USE_BEDROCK: "1" },
        { CLAUDE_CODE_USE_VERTEX: "true" },
        { CLAUDE_CODE_USE_FOUNDRY: "yes" },
      ])
        refusals.push((yield* launch({ ...credentials, ...backend }).pipe(Effect.flip)).detail);
      assert.deepEqual(
        refusals,
        [
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_VERTEX",
          "CLAUDE_CODE_USE_FOUNDRY",
        ].map(
          (backend) =>
            `Managed Claude supports the Anthropic API with a Claude sign-in or API key; this provider uses ${backend}.`,
        ),
      );
      const switchedOff = yield* launch({ ...credentials, CLAUDE_CODE_USE_BEDROCK: "0" });
      assert.deepEqual(switchedOff.environment, { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves no Codex credential in a runtime that switches to Claude", () =>
  Effect.gen(function* () {
    const { fs, path, root, profile, launch } = yield* fixture;
    const codexHome = path.join(root, "codex-home");
    yield* fs.makeDirectory(codexHome);
    yield* fs.writeFileString(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"codex-key"}');
    const codexCredential = path.join(profile.runtimePath, "codex", "auth.json");
    yield* FactoryConfinedLaunch.prepareFactoryLaunch({
      profile,
      containerName: "factory-codex",
      provider: {
        driver: "codex",
        settings: codexSettings({ homePath: codexHome }),
        environment: {},
      },
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, claudeImage));
    assert.equal(yield* fs.readFileString(codexCredential), '{"OPENAI_API_KEY":"codex-key"}');
    yield* launch({ CLAUDE_CODE_OAUTH_TOKEN: "setup-token" });
    assert.isFalse(yield* fs.exists(codexCredential));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("tells a stopped Docker engine apart from a missing image", () =>
  Effect.gen(function* () {
    const { launch } = yield* fixture;
    const refusal = (stderr: string) =>
      launch(
        { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" },
        undefined,
        ProcessRunner.ProcessRunner.of({
          run: () =>
            Effect.succeed({ ...inspection(""), stderr, code: ChildProcessSpawner.ExitCode(1) }),
        }),
      ).pipe(
        Effect.flip,
        Effect.map((failure) => failure.detail),
      );
    assert.equal(
      yield* refusal("Error response from daemon: No such image: sha256:verified"),
      "The managed runtime's image is not available on this environment.",
    );
    assert.equal(
      yield* refusal(
        "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running",
      ),
      "Docker is not running on this environment. Start Docker, then retry.",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("checks a provider's credential without inspecting or starting a runtime", () =>
  Effect.gen(function* () {
    const { fs, path, configDir } = yield* fixture;
    const launcher = yield* ConfinedProviderLaunch.ConfinedProviderLaunch;
    const check = (environment: NodeJS.ProcessEnv) =>
      launcher.checkCredential({
        driver: "claudeAgent",
        settings: settings({ homePath: configDir }),
        environment,
      });
    assert.equal((yield* check({}).pipe(Effect.flip)).detail, NO_CREDENTIAL);
    yield* check({ CLAUDE_CODE_OAUTH_TOKEN: "setup-token" });
    yield* fs.writeFileString(path.join(configDir, ".credentials.json"), signIn(3_600_000));
    yield* check({});
    yield* launcher.checkCredential({
      driver: "codex",
      settings: codexSettings({}),
      environment: {},
    });
  }).pipe(
    Effect.provide(
      FactoryConfinedLaunch.layerConfinedLaunch.pipe(
        Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
      ),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
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
          return inspection(labels);
        }),
    });
    yield* Effect.gen(function* () {
      const launcher = yield* ConfinedProviderLaunch.ConfinedProviderLaunch;
      const prepare = () =>
        launcher.prepare({
          driver: "claudeAgent",
          confinement,
          settings: settings({}),
          environment: { PATH: "host-path", CLAUDE_CODE_OAUTH_TOKEN: "setup-token" },
        });
      const launch = yield* prepare();
      const containerName = launch.args[launch.args.indexOf("--name") + 1] ?? "";
      assert.match(containerName, /^satellite-factory-/);
      assert.equal(launch.name, containerName);
      assert.deepEqual(launch.cleanup, {
        command: "docker",
        args: ["--context", "owned-context", "rm", "--force", containerName],
        environment: { PATH: "host-path" },
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

// As many tools as the real t3-code server offers, so Claude Code weighs deferring them.
const PROBE_MCP_TOOLS = Array.from({ length: 100 }, (_, index) => ({
  name: `probe_tool_${String(index).padStart(3, "0")}`,
  description: `Reports probe ${index}. ${"Describes what the tool does and when to use it. ".repeat(8)}`,
  inputSchema: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread to act on." },
      detail: { type: "string", description: "What to report." },
    },
    required: ["threadId"],
  },
}));

// A capture server stands in for the model and for an MCP server, so the probes record what Claude
// would send without a real model request. Model requests are refused after they are recorded.
const captureServer = Effect.acquireRelease(
  Effect.callback<{
    readonly server: NodeHttp.Server;
    readonly requests: Array<{
      readonly url: string;
      readonly body: string;
      readonly probeHeader: string | undefined;
    }>;
  }>((resume) => {
    const requests: Array<{
      readonly url: string;
      readonly body: string;
      readonly probeHeader: string | undefined;
    }> = [];
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (request.url === "/mcp" && request.method !== "POST") {
          response.writeHead(405);
          response.end();
          return;
        }
        if (request.url === "/mcp") {
          const call = JSON.parse(body) as {
            readonly id?: number;
            readonly method: string;
            readonly params?: { readonly protocolVersion?: string };
          };
          if (call.id === undefined) {
            response.writeHead(202);
            response.end();
            return;
          }
          const result =
            call.method === "initialize"
              ? {
                  protocolVersion: call.params?.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: "probe", version: "1.0.0" },
                }
              : call.method === "tools/list"
                ? { tools: PROBE_MCP_TOOLS }
                : {};
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
          return;
        }
        const probeHeader = request.headers["x-probe"];
        requests.push({
          url: request.url ?? "",
          body,
          probeHeader: Array.isArray(probeHeader) ? probeHeader.join(",") : probeHeader,
        });
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"type":"error","error":{"type":"invalid_request_error","message":"probe"}}');
      });
    });
    server.listen(0, "0.0.0.0", () => resume(Effect.succeed({ server, requests })));
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
);

const ModelRequest = Schema.Struct({
  model: Schema.String,
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  messages: Schema.Array(
    Schema.Struct({
      content: Schema.Union([
        Schema.String,
        Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
      ]),
    }),
  ),
});
const decodeModelRequest = Schema.decodeEffect(Schema.fromJsonString(ModelRequest));

// Claude Code names the tools it defers behind ToolSearch in a reminder, one per line.
const deferredToolNames = (messages: (typeof ModelRequest.Type)["messages"]) =>
  messages
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .flatMap((block) => block.text ?? [])
    .filter((text) => text.includes("deferred tools are now available via ToolSearch"))
    .flatMap((text) => text.split("\n").filter((line) => /^[\w-]+$/.test(line)));

/** Prepares a managed Claude launch of the pinned image in a fresh runtime, as a thread's is. */
const liveClaudeLaunch = Effect.fn("liveClaudeLaunch")(function* (input: {
  readonly name: string;
  readonly prepareRuntime?: (
    runtimePath: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(root, "project"));
  yield* fs.makeDirectory(path.join(root, "workflow", "skills"), { recursive: true });
  const runtimePath = path.join(root, "runtime");
  if (input.prepareRuntime) yield* input.prepareRuntime(runtimePath);
  return yield* FactoryConfinedLaunch.prepareFactoryLaunch({
    profile: {
      boundaryId: input.name,
      dockerContext: NodeChildProcess.execFileSync("docker", ["context", "show"], {
        encoding: "utf8",
      }).trim(),
      imageId: FACTORY_AGENT_IMAGE,
      projectSnapshotPath: path.join(root, "project"),
      workflowSnapshotPath: path.join(root, "workflow"),
      runtimePath,
    },
    containerName: input.name,
    provider: {
      driver: "claudeAgent",
      settings: settings({}),
      environment: { ...process.env, ANTHROPIC_API_KEY: "unused" },
    },
  }).pipe(Effect.provide(ProcessRunner.layer));
});

/**
 * Runs one prompt through the pinned image's Claude Code, launched as a managed thread's is,
 * against the capture server. Returns the CLI's init frame and every model request it sent.
 */
const probeImageClaude = Effect.fn("probeImageClaude")(function* (input: {
  readonly name: string;
  readonly prompt: string;
  readonly user?: string;
  readonly prepareRuntime?: (
    runtimePath: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}) {
  const launch = yield* liveClaudeLaunch(input);
  const { server, requests } = yield* captureServer;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const entrypoint = launch.args.indexOf("--entrypoint");
  const runtime = makeConfinedClaudeRuntime({
    ...launch,
    name: input.name,
    args: [
      ...launch.args.slice(0, entrypoint),
      "--env",
      `ANTHROPIC_BASE_URL=http://host.docker.internal:${port}`,
      // Claude Code turns tool search off for a base URL that is not Anthropic's own; this keeps
      // the default the real API gets.
      "--env",
      "ENABLE_TOOL_SEARCH=true",
      ...(input.user === undefined ? [] : ["--user", input.user]),
      ...launch.args.slice(entrypoint),
    ],
    cleanup: {
      command: "docker",
      args: ["rm", "--force", input.name],
      environment: launch.hostEnvironment,
    },
  });
  const sessionId = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const messages = yield* Effect.promise(async () => {
    const received: Array<SDKMessage> = [];
    const session = query({
      prompt: input.prompt,
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
        // Claude Code offers the tools that ask the human only to a client that answers them.
        canUseTool: async (_tool, toolInput) => ({ behavior: "allow", updatedInput: toolInput }),
        mcpServers: {
          "t3-code": { type: "http", url: `http://host.docker.internal:${port}/mcp` },
        },
        confined: { spawnClaudeCodeProcess: runtime.spawn, orchestrationInstructions: undefined },
      }),
    });
    try {
      for await (const message of session) received.push(message);
    } catch {
      // The capture server's refusal ends the run with an API error.
    }
    return received;
  });
  yield* runtime.remove;
  return {
    init: messages.find((message) => message.type === "system" && message.subtype === "init"),
    stderr: yield* runtime.stderrTail,
    requests: yield* Effect.forEach(
      requests.filter((request) => request.url.startsWith("/v1/messages")),
      (request) =>
        decodeModelRequest(request.body).pipe(
          Effect.map((decoded) => ({ ...decoded, probeHeader: request.probeHeader })),
        ),
    ),
  };
});

live(
  "the pinned image offers managed Claude exactly its allowed tools, as root and as a worker",
  () =>
    Effect.gen(function* () {
      for (const user of [undefined, "65532:65532"]) {
        const { init, stderr, requests } = yield* probeImageClaude({
          name: `factory-claude-tool-probe-${user === undefined ? "root" : "worker"}`,
          prompt: "Start the assignment.",
          ...(user === undefined ? {} : { user }),
        });
        // IS_SANDBOX lets Claude Code bypass permissions as root, where discovery runs.
        assert.deepInclude(init, { cwd: "/workspace", permissionMode: "bypassPermissions" });
        const request = requests[0];
        assert.isDefined(request, stderr);
        assert.equal(request?.model, "claude-sonnet-4-6");
        // With a hundred MCP tools, Claude Code offers a core set and ToolSearch, and defers the
        // rest, the MCP tools among them, to ToolSearch by name.
        assert.deepEqual(
          request?.tools.map((tool) => tool.name),
          [
            "AskUserQuestion",
            "Bash",
            "Edit",
            "Read",
            "Skill",
            "ToolSearch",
            "DeferredToolPlaceholder",
            "Write",
          ],
        );
        assert.deepEqual(deferredToolNames(request?.messages ?? []), [
          "EnterPlanMode",
          "ExitPlanMode",
          "NotebookEdit",
          "TaskCreate",
          "TaskGet",
          "TaskList",
          "TaskOutput",
          "TaskStop",
          "TaskUpdate",
          "WebFetch",
          "WebSearch",
          ...PROBE_MCP_TOOLS.map((tool) => `mcp__t3-code__${tool.name}`),
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  240_000,
);

// What an agent could leave in the writable Claude home for a later process: a settings file that
// sets the environment, and a command and an agent that pick their own model.
const plantUserConfiguration = (runtimePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = `${runtimePath}/claude`;
    yield* fs.makeDirectory(`${home}/commands`, { recursive: true });
    yield* fs.makeDirectory(`${home}/agents`, { recursive: true });
    yield* fs.writeFileString(
      `${home}/settings.json`,
      '{"env":{"ANTHROPIC_CUSTOM_HEADERS":"x-probe: settings-env"}}',
    );
    yield* fs.writeFileString(
      `${home}/commands/probe.md`,
      "---\nmodel: claude-opus-4-1\ndescription: Probe\n---\nSay hello.\n",
    );
    yield* fs.writeFileString(
      `${home}/agents/probe.md`,
      "---\nname: probe\nmodel: opus\ndescription: Probe\n---\nSay hello.\n",
    );
  });

live(
  "user configuration left in the Claude home cannot change a managed process's model or environment",
  () =>
    Effect.gen(function* () {
      const settingsRun = yield* probeImageClaude({
        name: "factory-claude-settings-probe",
        prompt: "Start the assignment.",
        prepareRuntime: plantUserConfiguration,
      });
      assert.isAbove(settingsRun.requests.length, 0, settingsRun.stderr);
      for (const request of settingsRun.requests) {
        assert.equal(request.model, "claude-sonnet-4-6");
        assert.isUndefined(request.probeHeader);
      }
      const commandRun = yield* probeImageClaude({
        name: "factory-claude-command-probe",
        prompt: "/probe",
        prepareRuntime: plantUserConfiguration,
      });
      for (const request of commandRun.requests) assert.equal(request.model, "claude-sonnet-4-6");

      // As a worker would: rename the home aside, recreate it, then write the locked files.
      const launch = yield* liveClaudeLaunch({ name: "factory-claude-home-write-probe" });
      const runner = yield* ProcessRunner.ProcessRunner;
      const written = yield* runner.run({
        command: launch.command,
        args: [
          ...launch.args.slice(0, launch.args.indexOf("--entrypoint")),
          "--user",
          "65532:65532",
          "--entrypoint",
          "sh",
          FACTORY_AGENT_IMAGE,
          "-c",
          "mv /runtime/claude /runtime/claude-old 2>/dev/null && echo renamed; mkdir -p /runtime/claude/commands /runtime/claude/agents 2>/dev/null; for target in settings.json commands/probe.md agents/probe.md; do (echo x > /runtime/claude/$target) 2>/dev/null && echo $target; done; echo checked",
        ],
        env: launch.hostEnvironment,
        timeout: "60 seconds",
      });
      assert.equal(written.stdout.trim(), "checked");
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  240_000,
);

live(
  "the image check admits the pinned image and refuses a missing or label-less one",
  () =>
    Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      const dockerContext = (yield* runner.run({
        command: "docker",
        args: ["context", "show"],
      })).stdout.trim();
      const check = (imageId: string) =>
        assertFactoryImageRunsClaude({
          boundaryId: "claude-image-check",
          dockerContext,
          imageId,
          projectSnapshotPath: "/unused",
          workflowSnapshotPath: "/unused",
          runtimePath: "/unused",
        });
      yield* check(FACTORY_AGENT_IMAGE);
      // The pinned Node base carries no providers label, like an image qualified before Claude.
      const base = /^FROM (\S+)/m.exec(FACTORY_AGENT_DOCKERFILE)?.[1] ?? "";
      if ((yield* runner.run({ command: "docker", args: ["image", "inspect", base] })).code !== 0)
        yield* runner.run({ command: "docker", args: ["pull", base], timeout: "5 minutes" });
      assert.equal(
        (yield* check(base).pipe(Effect.flip)).detail,
        "This managed runtime was prepared before Claude support and runs only Codex models. Choose a Codex model for it.",
      );
      assert.equal(
        (yield* check(`sha256:${"0".repeat(64)}`).pipe(Effect.flip)).detail,
        "The managed runtime's image is not available on this environment.",
      );
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  360_000,
);
