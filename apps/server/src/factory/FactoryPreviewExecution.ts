import {
  FactoryAssignmentId,
  FactoryError,
  FactoryPreviewAppConfiguration,
  ThreadId,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { factoryRelativePath } from "./FactoryBoundaryPaths.ts";
import { factoryIncidentBlocked } from "./FactoryCollaboration.ts";
import { factoryExecutionBlocked } from "./FactoryControls.ts";
import { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import { FactoryStore } from "./FactoryStore.ts";

export const FactoryPreviewInstance = Schema.Struct({
  id: Schema.String,
  assignmentId: FactoryAssignmentId,
  candidateId: Schema.String,
  candidateDigest: Schema.String,
  revisionId: Schema.String,
  reviewThreadId: ThreadId,
  configurationId: Schema.String,
  configuration: FactoryPreviewAppConfiguration,
  expectedEpoch: Schema.Int,
  imageId: Schema.String,
  dockerContext: Schema.String,
  containerName: Schema.String,
  relayName: Schema.String,
  networkName: Schema.String,
  containerId: Schema.optionalKey(Schema.String),
  relayId: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["starting", "ready", "stopped", "failed"]),
  createdAt: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
export type FactoryPreviewInstance = typeof FactoryPreviewInstance.Type;
const StartInput = Schema.Struct({
  instanceId: Schema.String,
  assignmentId: FactoryAssignmentId,
  candidateId: Schema.String,
  reviewThreadId: ThreadId,
  configurationId: Schema.String,
  expectedEpoch: Schema.Int,
});
const Container = Schema.Struct({
  Id: Schema.String,
  Image: Schema.String,
  Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
  State: Schema.Struct({
    Running: Schema.Boolean,
    Health: Schema.optionalKey(Schema.Struct({ Status: Schema.String })),
  }),
  NetworkSettings: Schema.Struct({
    Networks: Schema.Record(Schema.String, Schema.Unknown),
    Ports: Schema.Record(
      Schema.String,
      Schema.NullOr(
        Schema.Array(Schema.Struct({ HostIp: Schema.String, HostPort: Schema.String })),
      ),
    ),
  }),
});
const Network = Schema.Struct({
  Internal: Schema.Boolean,
  Labels: Schema.Record(Schema.String, Schema.String),
});
const DockerEvent = Schema.Struct({
  Action: Schema.String,
  Actor: Schema.Struct({ ID: Schema.String }),
});
const decodeContainer = Schema.decodeUnknownEffect(Schema.fromJsonString(Container));
const decodeNetwork = Schema.decodeUnknownEffect(Schema.fromJsonString(Network));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(DockerEvent));
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));
const decodeInstance = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryPreviewInstance));
const encodeInstance = Schema.encodeEffect(Schema.fromJsonString(FactoryPreviewInstance));
const encodeManifest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({ path: Schema.String, digest: Schema.String, mode: Schema.String }),
    ),
  ),
);
const preserve = (cause: unknown) =>
  isFactoryError(cause)
    ? cause
    : new FactoryError({
        code: "execution-unavailable",
        detail:
          "The isolated candidate app could not be started or verified. Check its approved runtime and dependencies.",
        cause,
      });

export class FactoryPreviewExecution extends Context.Service<
  FactoryPreviewExecution,
  {
    readonly start: (
      input: typeof StartInput.Type,
    ) => Effect.Effect<FactoryPreviewInstance, FactoryError>;
    readonly get: (instanceId: string) => Effect.Effect<FactoryPreviewInstance, FactoryError>;
    readonly stop: (
      instanceId: string,
    ) => Effect.Effect<FactoryPreviewInstance | undefined, FactoryError>;
  }
>()("t3/factory/FactoryPreviewExecution") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const store = yield* FactoryStore;
  const boundary = yield* FactoryBoundaryExecution;
  const runner = yield* ProcessRunner.ProcessRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const lifecycles = new Map<
    string,
    { readonly mutex: Semaphore.Semaphore; readonly stopped: Deferred.Deferred<void> }
  >();
  const lifecycle = (id: string) =>
    Effect.sync(() => {
      let current = lifecycles.get(id);
      if (!current) {
        current = { mutex: Semaphore.makeUnsafe(1), stopped: Deferred.makeUnsafe<void>() };
        lifecycles.set(id, current);
      }
      return current;
    });
  const root = path.join(config.stateDir, "factory", "previews");
  const digest = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
  const location = (id: string) =>
    digest(Buffer.from(id)).pipe(Effect.map((key) => path.join(root, key)));
  const read = Effect.fn(function* (id: string) {
    return yield* fs
      .readFileString(path.join(yield* location(id), "instance.json"))
      .pipe(Effect.flatMap(decodeInstance));
  });
  const save = Effect.fn(function* (instance: FactoryPreviewInstance) {
    const directory = yield* location(instance.id);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "instance.pending.json"),
      yield* encodeInstance(instance),
    );
    yield* fs.rename(
      path.join(directory, "instance.pending.json"),
      path.join(directory, "instance.json"),
    );
  });
  const docker = Effect.fn(function* (
    context: string,
    args: ReadonlyArray<string>,
    allowMissing = false,
  ) {
    const invocation = runner.run({
      command: "docker",
      args: ["--context", context, ...args],
      timeout: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    // A killed Docker CLI does not cancel a daemon-side create. Drain each
    // resource mutation's bounded acknowledgement before inspecting its
    // persisted name during cancellation cleanup.
    const mutates =
      args[0] === "create" ||
      args[0] === "start" ||
      (args[0] === "network" && ["create", "connect"].includes(args[1] ?? ""));
    const result = yield* mutates ? invocation.pipe(Effect.uninterruptible) : invocation;
    if (
      result.code !== 0 &&
      !(
        allowMissing &&
        /(?:no such (?:object|container|network)|network .+ not found)/i.test(result.stderr)
      )
    )
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "The approved local Docker app runtime is unavailable.",
        cause: { code: result.code, stderr: result.stderr },
      });
    return { code: result.code, value: result.stdout.trim() };
  });
  const requireCurrent = Effect.fn(function* (input: typeof StartInput.Type) {
    const state = yield* store.snapshot;
    const assignment = state.assignments.find((entry) => entry.id === input.assignmentId);
    const revision = assignment?.delivery?.revisions.find(
      (entry) => entry.id === assignment.delivery?.currentRevisionId,
    );
    const approved = state.previewConfigurations.find(
      (entry) => entry.id === input.configurationId && entry.projectId === assignment?.projectId,
    );
    const preview = revision?.preview;
    const reviewer = revision?.reviews.find(
      (entry) => entry.id === preview?.reviewId && entry.threadId === input.reviewThreadId,
    );
    if (
      !assignment ||
      assignment.status === "complete" ||
      assignment.outcome !== undefined ||
      !revision ||
      !approved ||
      !reviewer ||
      !["pending", "running"].includes(reviewer.status) ||
      (assignment.delivery?.flow !== undefined && assignment.delivery.flow.status !== "released") ||
      assignment.grant?.epoch !== input.expectedEpoch ||
      revision.candidateId !== input.candidateId ||
      !revision.candidateDigest ||
      preview?.instanceId !== input.instanceId ||
      preview.configurationId !== input.configurationId ||
      preview.threadId !== input.reviewThreadId ||
      !["starting", "ready"].includes(preview.status) ||
      (yield* Deferred.isDone((yield* lifecycle(input.instanceId)).stopped)) ||
      assignment.qualification.status !== "qualified"
    )
      return yield* new FactoryError({
        code: "invalid-state",
        detail:
          "This preview no longer matches the current candidate, reviewer and approved runtime.",
      });
    const blocked =
      factoryIncidentBlocked(state, assignment.id, "preview") ??
      factoryExecutionBlocked(state, {
        assignmentId: assignment.id,
        managerId: assignment.managerId,
        projectId: assignment.projectId,
        threadId: input.reviewThreadId,
        ancestorThreadIds: [],
      });
    if (blocked) return yield* new FactoryError({ code: "permission-denied", detail: blocked });
    return { assignment, revision, approved };
  });
  const inputOf = (instance: FactoryPreviewInstance) => ({
    instanceId: instance.id,
    assignmentId: instance.assignmentId,
    candidateId: instance.candidateId,
    reviewThreadId: instance.reviewThreadId,
    configurationId: instance.configurationId,
    expectedEpoch: instance.expectedEpoch,
  });
  const inspect = Effect.fn(function* (
    instance: FactoryPreviewInstance,
    role: "app" | "relay" = "app",
  ) {
    const id = role === "app" ? instance.containerId : instance.relayId;
    const name = role === "app" ? instance.containerName : instance.relayName;
    const inspected = yield* docker(
      instance.dockerContext,
      ["inspect", "--type", "container", id ?? name, "--format", "{{json .}}"],
      true,
    );
    if (inspected.code !== 0) return undefined;
    const container = yield* decodeContainer(inspected.value);
    if (
      container.Config.Labels["satellite.factory.preview"] !== instance.id ||
      container.Config.Labels["satellite.factory.candidate"] !== instance.candidateDigest ||
      container.Config.Labels["satellite.factory.assignment"] !== instance.assignmentId ||
      container.Config.Labels["satellite.factory.preview-role"] !== role ||
      Object.keys(container.NetworkSettings.Networks).some(
        (network) =>
          network !== instance.networkName && !(role === "relay" && network === "bridge"),
      ) ||
      container.Image !== instance.imageId ||
      (id !== undefined && container.Id !== id) ||
      !/^[a-f0-9]{64}$/.test(container.Id)
    )
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "The preview container identity differs from its persisted reservation.",
      });
    return container;
  });
  const remove = Effect.fn(function* (instance: FactoryPreviewInstance) {
    const container = yield* inspect(instance);
    if (container) yield* docker(instance.dockerContext, ["rm", "--force", container.Id]);
    const relay = yield* inspect(instance, "relay");
    if (relay) yield* docker(instance.dockerContext, ["rm", "--force", relay.Id]);
    const network = yield* docker(
      instance.dockerContext,
      ["network", "inspect", instance.networkName, "--format", "{{json .}}"],
      true,
    );
    if (network.code === 0) {
      const decoded = yield* decodeNetwork(network.value);
      if (!decoded.Internal || decoded.Labels["satellite.factory.preview"] !== instance.id)
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "The preview network identity differs from its persisted reservation.",
        });
      yield* docker(instance.dockerContext, ["network", "rm", instance.networkName]);
    }
  });
  const build = Effect.fn(function* (input: typeof StartInput.Type) {
    const { assignment, revision, approved } = yield* requireCurrent(input);
    const candidate = yield* boundary.readCandidate(input.candidateId);
    const finalized = candidate.finalized;
    if (
      !finalized ||
      candidate.assignmentId !== assignment.id ||
      candidate.projectId !== assignment.projectId ||
      candidate.grant.epoch !== input.expectedEpoch ||
      finalized.sourceDigest !== revision.candidateDigest ||
      finalized.commitOid !== revision.publication?.headSha ||
      finalized.treeOid !== revision.publication.treeOid
    )
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "Only the immutable finalized publication candidate may run in a preview.",
      });
    const configuration = approved.configuration;
    const entry = configuration.args[0];
    if (
      !/^sha256:[a-f0-9]{64}$/.test(configuration.imageId) ||
      configuration.executable !== "/usr/local/bin/node" ||
      configuration.data !== "ephemeral" ||
      !entry?.startsWith("/workspace/") ||
      !factoryRelativePath(entry.slice("/workspace/".length)) ||
      !finalized.files.some((file) => `/workspace/${file.path}` === entry) ||
      configuration.args.length > 32 ||
      configuration.args.some((value) => value.includes("\0") || value.length > 4096) ||
      !Number.isInteger(configuration.port) ||
      configuration.port < 1024 ||
      configuration.port > 65535
    )
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail:
          "Preview currently supports an approved Node entry file, isolated temporary data and an unprivileged HTTP port.",
      });
    const directory = yield* location(input.instanceId);
    let instance: FactoryPreviewInstance;
    if (yield* fs.exists(path.join(directory, "instance.json"))) {
      instance = yield* read(input.instanceId);
      if (
        stableStringify(inputOf(instance)) !== stableStringify(input) ||
        stableStringify(instance.configuration) !== stableStringify(configuration) ||
        instance.candidateDigest !== finalized.sourceDigest
      )
        return yield* new FactoryError({ code: "command-conflict" });
      if (instance.status === "stopped" || instance.status === "failed")
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "Start a new preview after a stopped or failed instance.",
        });
    } else {
      const profileId =
        assignment.qualification.status === "qualified" ? assignment.qualification.profileId : "";
      if (!/^[a-zA-Z0-9-]+$/.test(profileId))
        return yield* new FactoryError({ code: "invalid-state" });
      const profile = yield* fs
        .readFileString(
          path.join(config.stateDir, "factory", "execution", profileId, "profile.json"),
        )
        .pipe(Effect.flatMap(decodeProfile));
      if (profile.imageId !== configuration.imageId)
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "The preview image must match this assignment's qualified image.",
        });
      const endpoint = yield* docker(profile.dockerContext, [
        "context",
        "inspect",
        profile.dockerContext,
        "--format",
        "{{.Endpoints.docker.Host}}",
      ]);
      const os = yield* docker(profile.dockerContext, ["info", "--format", "{{.OSType}}"]);
      if (!/^(?:npipe:\/\/|unix:\/\/)/.test(endpoint.value) || os.value !== "linux")
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "Preview requires the environment's qualified local Linux Docker engine.",
        });
      const image = yield* docker(profile.dockerContext, [
        "image",
        "inspect",
        configuration.imageId,
        "--format",
        "{{.Id}}",
      ]);
      if (image.value !== configuration.imageId)
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "The approved preview image is not available locally.",
        });
      const key = (yield* digest(Buffer.from(input.instanceId))).slice(0, 32);
      instance = {
        id: input.instanceId,
        assignmentId: input.assignmentId,
        candidateId: input.candidateId,
        candidateDigest: finalized.sourceDigest,
        revisionId: revision.id,
        reviewThreadId: input.reviewThreadId,
        configurationId: input.configurationId,
        configuration,
        expectedEpoch: input.expectedEpoch,
        imageId: configuration.imageId,
        dockerContext: profile.dockerContext,
        containerName: `satellite-preview-${key}`,
        relayName: `satellite-preview-${key}-relay`,
        networkName: `satellite-preview-${key}`,
        status: "starting",
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* save(instance);
    }
    let container = yield* inspect(instance);
    if (instance.status === "ready" && !container?.State.Running)
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail:
          "The original preview app stopped. Start a new instance to preserve evidence identity.",
      });
    if (!container) {
      const filesDirectory = path.join(directory, "source");
      yield* fs.makeDirectory(filesDirectory, { recursive: true });
      if (directory.includes(",") || path.relative(directory, yield* fs.realPath(directory)) !== "")
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "Preview artifact storage must be a regular private directory.",
        });
      const seen = new Set<string>();
      for (const file of finalized.files) {
        const bytes = Buffer.from(file.content, "base64");
        if (
          !factoryRelativePath(file.path) ||
          seen.has(file.path.toLowerCase()) ||
          bytes.toString("base64") !== file.content ||
          (yield* digest(bytes)) !== file.digest
        )
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "The finalized candidate artifact failed its byte identity check.",
          });
        seen.add(file.path.toLowerCase());
        const target = path.join(filesDirectory, file.path);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        if (yield* fs.exists(target)) {
          if ((yield* digest(yield* fs.readFile(target))) !== file.digest)
            return yield* new FactoryError({
              code: "invalid-state",
              detail: "The immutable preview files changed after capture.",
            });
        } else yield* fs.writeFile(target, bytes);
        yield* fs.chmod(target, file.mode === "100755" ? 0o555 : 0o444);
      }
      const sourceDigest = yield* digest(
        Buffer.from(
          yield* encodeManifest(
            finalized.files.map(({ path, digest, mode }) => ({ path, digest, mode })),
          ),
        ),
      );
      if (sourceDigest !== finalized.sourceDigest)
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "The finalized candidate manifest failed its digest check.",
        });
      const network = yield* docker(
        instance.dockerContext,
        ["network", "inspect", instance.networkName, "--format", "{{json .}}"],
        true,
      );
      if (network.code !== 0)
        yield* docker(instance.dockerContext, [
          "network",
          "create",
          "--internal",
          "--label",
          `satellite.factory.preview=${instance.id}`,
          instance.networkName,
        ]);
      else {
        const decoded = yield* decodeNetwork(network.value);
        if (!decoded.Internal || decoded.Labels["satellite.factory.preview"] !== instance.id)
          return yield* new FactoryError({ code: "invalid-state" });
      }
      yield* requireCurrent(input);
      const health = `/usr/local/bin/node -e "require('http').get({host:'127.0.0.1',port:${configuration.port},path:'/'},r=>{r.resume();process.exit(r.statusCode>=200&&r.statusCode<500?0:1)}).on('error',()=>process.exit(1))"`;
      const created = yield* docker(instance.dockerContext, [
        "create",
        "--name",
        instance.containerName,
        "--pull",
        "never",
        "--read-only",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--network",
        instance.networkName,
        "--mount",
        `type=bind,source=${filesDirectory},target=/workspace,readonly`,
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=64m",
        "--tmpfs",
        "/data:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000",
        "--workdir",
        "/workspace",
        "--env",
        `PORT=${configuration.port}`,
        "--env",
        "NODE_ENV=test",
        "--env",
        "DATA_DIRECTORY=/data",
        "--label",
        `satellite.factory.preview=${instance.id}`,
        "--label",
        `satellite.factory.candidate=${instance.candidateDigest}`,
        "--label",
        `satellite.factory.assignment=${instance.assignmentId}`,
        "--label",
        "satellite.factory.preview-role=app",
        "--health-cmd",
        health,
        "--health-interval",
        "1s",
        "--health-timeout",
        "2s",
        "--health-retries",
        "15",
        "--entrypoint",
        configuration.executable,
        configuration.imageId,
        ...configuration.args,
      ]);
      if (!/^[a-f0-9]{64}$/.test(created.value))
        return yield* new FactoryError({ code: "execution-unavailable" });
      instance = { ...instance, containerId: created.value };
      yield* save(instance);
      container = yield* inspect(instance);
    }
    if (!container) return yield* new FactoryError({ code: "execution-unavailable" });
    if (!container.State.Running) {
      yield* requireCurrent(input);
      yield* docker(instance.dockerContext, ["start", container.Id]);
    }
    if (instance.containerId === undefined) {
      instance = { ...instance, containerId: container.Id };
      yield* save(instance);
    }
    let relay = yield* inspect(instance, "relay");
    if (instance.status === "ready" && !relay?.State.Running)
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "The preview relay stopped. Start a new preview instance.",
      });
    if (!relay) {
      yield* requireCurrent(input);
      const script = `const http=require('http');const server=http.createServer((q,s)=>{const u=http.request({hostname:'${instance.containerName}',port:${configuration.port},method:q.method,path:q.url,headers:q.headers},r=>{s.writeHead(r.statusCode,r.headers);r.pipe(s)});u.on('error',()=>{s.writeHead(502);s.end()});q.pipe(u)});server.on('upgrade',(q,s,h)=>{const u=http.request({hostname:'${instance.containerName}',port:${configuration.port},method:q.method,path:q.url,headers:q.headers});u.on('upgrade',(r,t,b)=>{s.write('HTTP/1.1 '+r.statusCode+' '+r.statusMessage+'\\r\\n'+Object.entries(r.headers).map(([k,v])=>k+': '+v).join('\\r\\n')+'\\r\\n\\r\\n');if(b.length)s.write(b);if(h.length)t.write(h);t.pipe(s);s.pipe(t);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy())});u.on('error',()=>s.destroy());u.end()});server.listen(${configuration.port},'0.0.0.0');`;
      const health = `/usr/local/bin/node -e "require('http').get({host:'127.0.0.1',port:${configuration.port},path:'/'},r=>{r.resume();process.exit(r.statusCode>=200&&r.statusCode<500?0:1)}).on('error',()=>process.exit(1))"`;
      const created = yield* docker(instance.dockerContext, [
        "create",
        "--name",
        instance.relayName,
        "--pull",
        "never",
        "--read-only",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "128m",
        "--cpus",
        "0.5",
        "--network",
        "bridge",
        "--publish",
        `127.0.0.1::${configuration.port}`,
        "--label",
        `satellite.factory.preview=${instance.id}`,
        "--label",
        `satellite.factory.candidate=${instance.candidateDigest}`,
        "--label",
        `satellite.factory.assignment=${instance.assignmentId}`,
        "--label",
        "satellite.factory.preview-role=relay",
        "--health-cmd",
        health,
        "--health-interval",
        "1s",
        "--health-timeout",
        "2s",
        "--health-retries",
        "15",
        "--entrypoint",
        "/usr/local/bin/node",
        configuration.imageId,
        "-e",
        script,
      ]);
      if (!/^[a-f0-9]{64}$/.test(created.value))
        return yield* new FactoryError({ code: "execution-unavailable" });
      instance = { ...instance, relayId: created.value };
      yield* save(instance);
      relay = yield* inspect(instance, "relay");
    }
    if (!relay) return yield* new FactoryError({ code: "execution-unavailable" });
    if (!(instance.networkName in relay.NetworkSettings.Networks))
      yield* docker(instance.dockerContext, ["network", "connect", instance.networkName, relay.Id]);
    if (!relay.State.Running) {
      yield* requireCurrent(input);
      yield* docker(instance.dockerContext, ["start", relay.Id]);
    }
    if (instance.relayId === undefined) {
      instance = { ...instance, relayId: relay.Id };
      yield* save(instance);
    }
    return instance;
  });
  const waitHealthy = Effect.fn(function* (
    instance: FactoryPreviewInstance,
    role: "app" | "relay",
  ) {
    const current = yield* inspect(instance, role);
    if (!current?.State.Running)
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "The candidate app exited before becoming ready.",
      });
    if (current.State.Health?.Status === "healthy") return;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "docker",
        [
          "--context",
          instance.dockerContext,
          "events",
          "--since",
          instance.createdAt,
          "--filter",
          `container=${current.Id}`,
          "--format",
          "{{json .}}",
        ],
        { stdin: "ignore" },
      ),
    );
    const event = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.mapEffect((line) => decodeEvent(line)),
      Stream.filter(
        (event) =>
          event.Actor.ID === current.Id &&
          ["health_status: healthy", "health_status: unhealthy", "die", "destroy"].includes(
            event.Action,
          ),
      ),
      Stream.runHead,
      Effect.timeout("35 seconds"),
    );
    if (Option.isNone(event) || event.value.Action !== "health_status: healthy")
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "The candidate app did not pass its HTTP readiness check.",
      });
  }, Effect.scoped);
  const ready = Effect.fn(function* (instance: FactoryPreviewInstance) {
    yield* requireCurrent(inputOf(instance));
    const saved = yield* read(instance.id);
    if (saved.status === "stopped" || saved.status === "failed")
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "This preview was stopped while starting.",
      });
    const container = yield* inspect(saved);
    const relay = yield* inspect(saved, "relay");
    const bindings = relay?.NetworkSettings.Ports[`${saved.configuration.port}/tcp`];
    const binding = bindings?.[0];
    if (
      !container?.State.Running ||
      container.State.Health?.Status !== "healthy" ||
      !relay?.State.Running ||
      relay.State.Health?.Status !== "healthy" ||
      bindings?.length !== 1 ||
      binding?.HostIp !== "127.0.0.1" ||
      !/^\d+$/.test(binding.HostPort)
    )
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "The candidate app has no healthy localhost-only HTTP binding.",
        cause: { running: container?.State.Running, health: container?.State.Health, bindings },
      });
    const port = Number(binding.HostPort);
    if (port < 1 || port > 65535) return yield* new FactoryError({ code: "invalid-state" });
    const origin = `http://127.0.0.1:${port}`;
    const response = yield* http
      .get(origin)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("5 seconds"),
      );
    if (response.status < 200 || response.status >= 500)
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "The isolated app did not answer its published HTTP endpoint.",
      });
    yield* requireCurrent(inputOf(instance));
    const result = FactoryPreviewInstance.make({ ...saved, status: "ready", origin });
    yield* save(result);
    return result;
  }, Effect.scoped);
  const stop = Effect.fn("FactoryPreviewExecution.stop")(function* (id: string) {
    const current = yield* lifecycle(id);
    yield* Deferred.succeed(current.stopped, undefined);
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(path.join(yield* location(id), "instance.json")))) return undefined;
      const instance = yield* read(id);
      yield* remove(instance);
      const stopped = FactoryPreviewInstance.make({ ...instance, status: "stopped" });
      yield* save(stopped);
      return stopped;
    }).pipe(current.mutex.withPermit);
  }, Effect.mapError(preserve));
  const start = Effect.fn("FactoryPreviewExecution.start")(function* (
    input: typeof StartInput.Type,
  ) {
    const current = yield* lifecycle(input.instanceId);
    const cancelled = Effect.raceFirst(
      Deferred.await(current.stopped).pipe(
        Effect.andThen(
          Effect.fail(
            new FactoryError({
              code: "invalid-state",
              detail: "This preview was stopped while starting.",
            }),
          ),
        ),
      ),
      store.changes.pipe(
        Stream.runForEach(() => requireCurrent(input)),
        Effect.andThen(Effect.never),
      ),
    );
    return yield* build(input).pipe(
      Effect.flatMap((instance) =>
        waitHealthy(instance, "app").pipe(
          Effect.andThen(waitHealthy(instance, "relay")),
          Effect.andThen(ready(instance)),
        ),
      ),
      (operation) => Effect.raceFirst(operation, cancelled),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.gen(function* () {
              if (
                !(yield* fs.exists(path.join(yield* location(input.instanceId), "instance.json")))
              )
                return;
              const saved = yield* read(input.instanceId);
              if (
                saved.status === "stopped" ||
                stableStringify(inputOf(saved)) !== stableStringify(input)
              )
                return;
              const stillCurrent = yield* requireCurrent(input).pipe(Effect.isSuccess);
              yield* remove(saved);
              yield* save({
                ...saved,
                status: stillCurrent ? "failed" : "stopped",
                ...(stillCurrent
                  ? {
                      error:
                        "The isolated app failed to become ready. Check the approved entry point and dependencies.",
                    }
                  : {}),
              });
            }),
      ),
      current.mutex.withPermit,
    );
  }, Effect.mapError(preserve));
  const get = Effect.fn("FactoryPreviewExecution.get")(function* (id: string) {
    const current = yield* lifecycle(id);
    return yield* Effect.gen(function* () {
      const instance = yield* read(id);
      yield* requireCurrent(inputOf(instance));
      if (instance.status !== "ready") return instance;
      return yield* ready(instance);
    }).pipe(current.mutex.withPermit);
  }, Effect.mapError(preserve));
  return FactoryPreviewExecution.of({ start, get, stop });
});

export const layer = Layer.effect(FactoryPreviewExecution, make);
