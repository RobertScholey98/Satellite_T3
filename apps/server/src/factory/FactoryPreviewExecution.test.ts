import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactoryControlId,
  FactorySourceId,
  ProjectId,
  ThreadId,
  type FactoryAssignment,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import { type FactoryCandidateArtifact } from "./FactoryCandidate.ts";
import { FACTORY_AGENT_IMAGE, type FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import * as FactoryPreviewExecution from "./FactoryPreviewExecution.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import * as FactoryStore from "./FactoryStore.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.fn(function* (options?: {
  live?: boolean;
  script?: string;
  waitAt?: "http" | "create" | "health";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped();
  const digest = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
  const key = yield* crypto.randomUUIDv4;
  const projectId = ProjectId.make(`preview-project-${key}`);
  const assignmentId = FactoryAssignmentId.make(`preview-assignment-${key}`);
  const leadId = ThreadId.make("preview-lead");
  const reviewThreadId = ThreadId.make("preview-reviewer");
  const managerId = ThreadId.make("preview-manager");
  const instanceId = `preview:${key}`;
  const now = "2026-10-10T12:00:00.000Z";
  let dockerContext = "fixture";
  let imageId = `sha256:${"a".repeat(64)}`;
  if (options?.live) {
    dockerContext = (yield* runner.run({
      command: "docker",
      args: ["context", "show"],
    })).stdout.trim();
    imageId = (yield* runner.run({
      command: "docker",
      args: ["image", "inspect", FACTORY_AGENT_IMAGE, "--format", "{{.Id}}"],
    })).stdout.trim();
  }
  const configuration = {
    imageId,
    executable: "/usr/local/bin/node" as const,
    args: ["/workspace/app.cjs"],
    port: 3137,
    data: "ephemeral" as const,
  };
  const app =
    options?.script ??
    "require('http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<h1>Immutable candidate app</h1>')}).listen(process.env.PORT,'0.0.0.0');";
  const bytes = Buffer.from(app);
  const files = [
    {
      path: "app.cjs",
      mode: "100644" as const,
      content: bytes.toString("base64"),
      digest: yield* digest(bytes),
    },
  ];
  const sourceDigest = yield* digest(
    Buffer.from(json(files.map(({ path, digest, mode }) => ({ path, digest, mode })))),
  );
  const startingSource = {
    id: FactorySourceId.make("preview-source"),
    projectId,
    revision: "b".repeat(40),
    sourceDigest,
    origin: "project" as const,
    branch: "main",
    capturedAt: now,
    fileCount: 1,
    stagedPaths: [],
    unstagedPaths: [],
    untrackedPaths: [],
    deletedPaths: [],
    excludedPaths: [],
  };
  const grant = {
    boundaryId: FactoryBoundaryId.make("preview-boundary"),
    epoch: 2,
    sourcePaths: ["app.cjs"],
    creatableDirectories: [],
    controlChange: null,
  };
  const workflow = { repositoryRoot: "/workflow", revision: "c".repeat(40) };
  const candidate: FactoryCandidateArtifact = {
    id: "candidate",
    assignmentId,
    projectId,
    leadThreadId: leadId,
    startingSource,
    workflow,
    grant,
    configuration: {
      protectedPaths: [],
      writablePaths: ["app.cjs"],
      creatableDirectories: [],
      gates: [],
    },
    sourceDigest,
    files,
    deletedPaths: [],
    selectedPaths: ["app.cjs"],
    startingFiles: files,
    startingIndexFiles: files,
    capturedAt: now,
    finalized: {
      reservationId: "revision",
      sourceDigest,
      treeOid: "d".repeat(40),
      commitOid: "e".repeat(40),
      files,
    },
  };
  const assignment: FactoryAssignment = {
    id: assignmentId,
    projectId,
    managerId,
    threadId: leadId,
    kind: "implementation",
    startingSource,
    workflow,
    status: "running",
    threadStatus: "created",
    launchStatus: "delivered",
    qualification: { status: "qualified", profileId: key, checkedAt: now },
    grantedPolicy: initialFactorySnapshot().defaults,
    grant,
    wait: null,
    report: null,
    createdAt: now,
    updatedAt: now,
    delivery: {
      currentRevisionId: "revision",
      directionHeld: false,
      readiness: [],
      retroFindings: [],
      revisions: [
        {
          id: "revision",
          operationId: "capture",
          selectedPaths: ["app.cjs"],
          commitMessage: "Candidate",
          grantEpoch: 2,
          boundaryId: grant.boundaryId,
          workflowRevision: workflow.revision,
          startingSourceId: startingSource.id,
          status: "captured",
          candidateId: candidate.id,
          candidateDigest: sourceDigest,
          publication: {
            reservationId: "revision",
            host: "github.invalid",
            repository: "example/test",
            branch: "private",
            baseBranch: "main",
            headSha: candidate.finalized!.commitOid,
            treeOid: candidate.finalized!.treeOid,
          },
          reviews: [
            {
              id: "review",
              threadId: reviewThreadId,
              candidateDigest: sourceDigest,
              status: "running",
              evidence: [],
            },
          ],
          preview: {
            instanceId,
            configurationId: "approved-app",
            reviewId: "review",
            threadId: reviewThreadId,
            status: "starting",
          },
          createdAt: now,
        },
      ],
    },
  };
  let state: FactorySnapshot = {
    ...initialFactorySnapshot(),
    assignments: [assignment],
    previewConfigurations: [
      {
        id: "approved-app",
        projectId,
        configuration,
        approvedAt: now,
        authorizingCommandId: CommandId.make("approve"),
      },
    ],
  };
  const changes = yield* SubscriptionRef.make(state);
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const healthStopped = yield* Deferred.make<void>();
  const relayStarted = yield* Deferred.make<void>();
  const serverConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(root, root)),
  );
  const profileDirectory = path.join(serverConfig.stateDir, "factory", "execution", key);
  const profile: FactoryExecutionProfile = {
    boundaryId: key,
    dockerContext,
    imageId,
    projectSnapshotPath: profileDirectory,
    workflowSnapshotPath: profileDirectory,
    runtimePath: profileDirectory,
  };
  yield* fs.makeDirectory(profileDirectory, { recursive: true });
  yield* fs.writeFileString(path.join(profileDirectory, "profile.json"), json(profile));
  let containerExists = false;
  let relayExists = false;
  let networkExists = false;
  let networkName = "";
  let running = false;
  let relayRunning = false;
  let foreign = false;
  let daemonUnavailable = false;
  let failStart = false;
  let createCount = 0;
  let httpCount = 0;
  const commands: Array<ReadonlyArray<string>> = [];
  const containerId = "f".repeat(64);
  const relayId = "e".repeat(64);
  const output = (stdout = "", code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
    stdout,
    stderr,
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });
  const fakeRunner = Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) =>
      Effect.sync(() => {
        const args = input.args.slice(2);
        commands.push(args);
        if (daemonUnavailable) return output("", 1, "Cannot connect to Docker daemon");
        if (args[0] === "context") return output("npipe://local");
        if (args[0] === "info") return output("linux");
        if (args[0] === "image") return output(imageId);
        if (args[0] === "inspect") {
          const isRelay = args[3] === relayId || args[3]?.endsWith("-relay");
          return (isRelay ? relayExists : containerExists)
            ? output(
                json({
                  Id: isRelay ? relayId : containerId,
                  Image: imageId,
                  Config: {
                    Labels: {
                      "satellite.factory.preview": foreign ? "someone-else" : instanceId,
                      "satellite.factory.candidate": sourceDigest,
                      "satellite.factory.assignment": assignmentId,
                      "satellite.factory.preview-role": isRelay ? "relay" : "app",
                    },
                  },
                  State: {
                    Running: isRelay ? relayRunning : running,
                    Health: { Status: options?.waitAt === "health" ? "starting" : "healthy" },
                  },
                  NetworkSettings: {
                    Networks: { [networkName]: {}, ...(isRelay ? { bridge: {} } : {}) },
                    Ports: { "3137/tcp": [{ HostIp: "127.0.0.1", HostPort: "43137" }] },
                  },
                }),
              )
            : output("", 1, "Error: No such container");
        }
        if (args[0] === "network") {
          if (args[1] === "connect") return output();
          if (args[1] === "inspect")
            return networkExists
              ? output(
                  json({ Internal: true, Labels: { "satellite.factory.preview": instanceId } }),
                )
              : output("", 1, "Error: No such network");
          networkExists = args[1] === "create";
          if (args[1] === "create") networkName = args.at(-1)!;
          return output("network");
        }
        if (args[0] === "create") {
          const isRelay = args.includes("satellite.factory.preview-role=relay");
          if (isRelay) relayExists = true;
          else containerExists = true;
          createCount++;
          return output(isRelay ? relayId : containerId);
        }
        if (args[0] === "start") {
          if (failStart) return output("", 1, "Fixture start failed");
          if (args[1] === relayId) relayRunning = true;
          else running = true;
          return output(containerId);
        }
        if (args[0] === "rm") {
          if (args.includes(relayId)) {
            relayExists = false;
            relayRunning = false;
          } else {
            containerExists = false;
            running = false;
          }
          return output(containerId);
        }
        throw new Error(`Unexpected Docker operation ${args[0]}`);
      }).pipe(
        Effect.tap(() =>
          input.args[2] === "create" &&
          !input.args.includes("satellite.factory.preview-role=relay") &&
          options?.waitAt === "create"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
      ),
  });
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        httpCount++;
        assert.equal(request.url, "http://127.0.0.1:43137");
        return HttpClientResponse.fromWeb(request, new Response("Candidate app"));
      }).pipe(
        Effect.tap(() =>
          options?.waitAt === "http"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
      ),
    ),
  );
  const healthSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Deferred.succeed(healthStopped, undefined).pipe(Effect.asVoid),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
            Stream.flatMap(() => Stream.never),
          ),
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
        return handle;
      }),
    ),
  );
  const liveRunner = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        runner
          .run(input)
          .pipe(
            Effect.tap(() =>
              input.args[2] === "start"
                ? Deferred.succeed(relayStarted, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
    }),
  );
  const layer = FactoryPreviewExecution.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(root, root),
        Layer.mock(FactoryStore.FactoryStore)({
          snapshot: Effect.sync(() => state),
          changes: SubscriptionRef.changes(changes),
        }),
        Layer.mock(FactoryBoundaryExecution.FactoryBoundaryExecution)({
          readCandidate: () => Effect.succeed(candidate),
        }),
        options?.live ? liveRunner : fakeRunner,
        options?.live ? FetchHttpClient.layer : http,
        ...(options?.waitAt === "health" ? [healthSpawner] : []),
      ),
    ),
  );
  return {
    layer,
    root,
    path,
    fs,
    commands,
    instanceId,
    entered: Deferred.await(entered),
    release: Deferred.succeed(release, undefined),
    healthStopped: Deferred.await(healthStopped),
    appStarted: Deferred.await(relayStarted),
    publishState: Effect.suspend(() => SubscriptionRef.set(changes, state)),
    changePreview: (status: "starting" | "ready" | "stopping" | "stopped" | "failed") => {
      state = {
        ...state,
        assignments: state.assignments.map((entry) => ({
          ...entry,
          delivery: {
            ...entry.delivery!,
            revisions: entry.delivery!.revisions.map((revision) => ({
              ...revision,
              preview: { ...revision.preview!, status },
            })),
          },
        })),
      };
    },
    finishReview: (status: "passed" | "changes-requested" | "failed") => {
      state = {
        ...state,
        assignments: state.assignments.map((entry) => ({
          ...entry,
          delivery: {
            ...entry.delivery!,
            revisions: entry.delivery!.revisions.map((revision) => ({
              ...revision,
              reviews: revision.reviews.map((review) => ({ ...review, status })),
            })),
          },
        })),
      };
    },
    holdFlow: () => {
      state = {
        ...state,
        assignments: state.assignments.map((entry) => ({
          ...entry,
          delivery: { ...entry.delivery!, flow: { holdId: "flow", status: "held" } },
        })),
      };
    },
    input: {
      instanceId,
      assignmentId,
      candidateId: candidate.id,
      reviewThreadId,
      configurationId: "approved-app",
      expectedEpoch: 2,
    },
    counts: () => ({ createCount, httpCount }),
    daemonUnavailable: () => {
      daemonUnavailable = true;
    },
    foreign: () => {
      foreign = true;
    },
    failStart: () => {
      failStart = true;
    },
    loseContainer: () => {
      containerExists = false;
    },
    changeEpoch: () => {
      state = { ...state, assignments: [{ ...assignment, grant: { ...grant, epoch: 3 } }] };
    },
    pause: () => {
      state = {
        ...state,
        controls: [
          {
            id: FactoryControlId.make("pause"),
            kind: "project-pause",
            projectId,
            status: "active",
            generation: 1,
            stop: { status: "confirmed", stoppedAt: now },
            resumeThreadIds: [],
            requestedAt: now,
            updatedAt: now,
          },
        ],
      };
    },
    replaceCandidateBytes: () => {
      files[0] = { ...files[0]!, content: Buffer.from("tampered").toString("base64") };
    },
  };
});
const run = <A, E, R>(
  body: (f: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<A, E, R>,
  options?: { live?: boolean; script?: string; waitAt?: "http" | "create" | "health" },
) =>
  fixture(options).pipe(
    Effect.flatMap(body),
    Effect.scoped,
    Effect.provide(ProcessRunner.layer),
    Effect.provide(NodeServices.layer),
  );

it.effect(
  "starts only the pinned candidate and recovers the same container after service restart",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          return yield* (yield* FactoryPreviewExecution.FactoryPreviewExecution).start(f.input);
        }).pipe(Effect.provide(f.layer));
        const again = yield* Effect.gen(function* () {
          return yield* (yield* FactoryPreviewExecution.FactoryPreviewExecution).start(f.input);
        }).pipe(Effect.provide(f.layer));
        assert.equal(first.status, "ready");
        assert.equal(first.origin, "http://127.0.0.1:43137");
        assert.equal(first.containerId, again.containerId);
        assert.equal(f.counts().createCount, 2);
        assert.equal(f.counts().httpCount, 2);
        const args = f.commands.find((entry) => entry[0] === "create")!;
        assert.include(args, "--read-only");
        assert.notInclude(args, "--publish");
        assert.include(
          f.commands.find(
            (entry) =>
              entry[0] === "create" && entry.includes("satellite.factory.preview-role=relay"),
          )!,
          "127.0.0.1::3137",
        );
        assert.include(args, "ALL");
        assert.include(args, "no-new-privileges");
        const mount = args[args.indexOf("--mount") + 1]!;
        assert.match(mount, /target=\/workspace,readonly$/);
        assert.notInclude(args.join(" "), "credentials");
        yield* Effect.gen(function* () {
          const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
          assert.equal((yield* runtime.stop(f.instanceId))?.status, "stopped");
          assert.equal((yield* runtime.stop(f.instanceId))?.status, "stopped");
          assert.isUndefined(yield* runtime.stop("never-created"));
        }).pipe(Effect.provide(f.layer));
      }),
    ),
);

it.effect(
  "rejects stale authority, a changed candidate, and unsupported approved commands before launching",
  () =>
    Effect.forEach(["epoch", "pause", "tamper", "configuration"] as const, (kind) =>
      run((f) =>
        Effect.gen(function* () {
          if (kind === "epoch") f.changeEpoch();
          if (kind === "pause") f.pause();
          if (kind === "tamper") f.replaceCandidateBytes();
          const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
          const input =
            kind === "configuration" ? { ...f.input, configurationId: "not-approved" } : f.input;
          yield* runtime.start(input).pipe(Effect.flip);
          assert.equal(f.counts().createCount, 0);
        }).pipe(Effect.provide(f.layer)),
      ),
    ),
);

it.effect(
  "never recreates a lost ready app or treats an unavailable daemon as a confirmed stop",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
        yield* runtime.start(f.input);
        f.daemonUnavailable();
        assert.include((yield* runtime.stop(f.instanceId).pipe(Effect.flip)).detail!, "Docker");
        assert.equal(f.commands.filter((args) => args[0] === "rm").length, 0);
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect(
  "holds failed startup as failed, cleans its exact resources and refuses foreign identities",
  () =>
    Effect.forEach(["start", "foreign", "lost", "pause"] as const, (kind) =>
      run((f) =>
        Effect.gen(function* () {
          const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
          if (kind === "start") {
            f.failStart();
            yield* runtime.start(f.input).pipe(Effect.flip);
            assert.equal((yield* runtime.get(f.instanceId)).status, "failed");
            assert.equal(f.commands.filter((args) => args[0] === "rm").length, 1);
          } else {
            yield* runtime.start(f.input);
            if (kind === "foreign") f.foreign();
            if (kind === "lost") f.loseContainer();
            if (kind === "pause") f.pause();
            yield* runtime.get(f.instanceId).pipe(Effect.flip);
            if (kind === "foreign") yield* runtime.stop(f.instanceId).pipe(Effect.flip);
            if (kind === "lost") yield* runtime.start(f.input).pipe(Effect.flip);
            assert.equal(f.counts().createCount, 2);
          }
        }).pipe(Effect.provide(f.layer)),
      ),
    ),
);

it.effect(
  "stops a pending native health subscription without waiting for its readiness timeout",
  () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
          const starting = yield* runtime.start(f.input).pipe(Effect.result, Effect.forkChild);
          yield* f.entered;
          const stopped = yield* runtime.stop(f.instanceId);
          yield* f.healthStopped;
          assert.equal(stopped?.status, "stopped");
          assert.equal((yield* Fiber.join(starting))._tag, "Failure");
          assert.equal(f.commands.filter((args) => args[0] === "rm").length, 2);
          assert.equal(f.counts().httpCount, 0);
          yield* runtime.start(f.input).pipe(Effect.flip);
          assert.equal(f.counts().createCount, 2);
        }).pipe(Effect.provide(f.layer)),
      { waitAt: "health" },
    ),
);

it.effect(
  "authority events cancel an in-flight HTTP readiness request and prevent late ready",
  () =>
    Effect.forEach(["stopping", "pause", "review", "flow", "epoch"] as const, (change) =>
      run(
        (f) =>
          Effect.gen(function* () {
            const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
            const starting = yield* runtime.start(f.input).pipe(Effect.result, Effect.forkChild);
            yield* f.entered;
            if (change === "stopping") f.changePreview("stopping");
            if (change === "pause") f.pause();
            if (change === "review") f.finishReview("passed");
            if (change === "flow") f.holdFlow();
            if (change === "epoch") f.changeEpoch();
            yield* f.publishState;
            assert.equal((yield* Fiber.join(starting))._tag, "Failure");
            assert.equal(f.commands.filter((args) => args[0] === "rm").length, 2);
            yield* f.release;
            assert.equal((yield* runtime.stop(f.instanceId))?.status, "stopped");
            yield* runtime.get(f.instanceId).pipe(Effect.flip);
          }).pipe(Effect.provide(f.layer)),
        { waitAt: "http" },
      ),
    ),
);

it.effect(
  "drains a pending Docker create acknowledgement before exact-name cleanup and never starts it",
  () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
          const starting = yield* runtime.start(f.input).pipe(Effect.result, Effect.forkChild);
          yield* f.entered;
          f.changePreview("stopping");
          yield* f.publishState;
          const stopping = yield* runtime.stop(f.instanceId).pipe(Effect.forkChild);
          yield* f.release;
          assert.equal((yield* Fiber.join(starting))._tag, "Failure");
          assert.equal((yield* Fiber.join(stopping))?.status, "stopped");
          assert.equal(f.commands.filter((args) => args[0] === "start").length, 0);
          assert.equal(f.commands.filter((args) => args[0] === "create").length, 1);
          assert.equal(f.commands.filter((args) => args[0] === "rm").length, 1);
        }).pipe(Effect.provide(f.layer)),
      { waitAt: "create" },
    ),
);

it.effect(
  "refuses completed reviewers and held flows before launch and after runtime recreation",
  () =>
    Effect.forEach(["passed", "changes-requested", "flow", "stopping"] as const, (change) =>
      run((f) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            yield* (yield* FactoryPreviewExecution.FactoryPreviewExecution).start(f.input);
          }).pipe(Effect.provide(f.layer));
          if (change === "flow") f.holdFlow();
          else if (change === "stopping") f.changePreview("stopping");
          else f.finishReview(change);
          yield* Effect.gen(function* () {
            const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
            yield* runtime.get(f.instanceId).pipe(Effect.flip);
            yield* runtime.start(f.input).pipe(Effect.flip);
            assert.equal(f.counts().createCount, 2);
            yield* runtime.stop(f.instanceId);
          }).pipe(Effect.provide(f.layer));
        }),
      ),
    ),
);

const live = process.env.SATELLITE_FACTORY_LIVE_TEST === "1" ? it.effect : it.effect.skip;
live(
  "cancels and cleans an actual Docker app before HTTP readiness",
  () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
          yield* Effect.addFinalizer(() => runtime.stop(f.instanceId).pipe(Effect.orDie));
          const starting = yield* runtime.start(f.input).pipe(Effect.result, Effect.forkChild);
          yield* f.appStarted;
          f.changePreview("stopping");
          yield* f.publishState;
          assert.equal((yield* runtime.stop(f.instanceId))?.status, "stopped");
          assert.equal((yield* Fiber.join(starting))._tag, "Failure");
        }).pipe(Effect.provide(f.layer)),
      {
        live: true,
        script:
          "require('http').createServer((_q,s)=>{s.statusCode=503;s.end('Starting')}).listen(process.env.PORT,'0.0.0.0');",
      },
    ),
  60_000,
);
live(
  "reports missing application dependencies and removes the failed isolated app",
  () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
          yield* Effect.addFinalizer(() => runtime.stop(f.instanceId).pipe(Effect.orDie));
          assert.equal(
            (yield* runtime.start(f.input).pipe(Effect.flip)).code,
            "execution-unavailable",
          );
          const failed = yield* runtime.get(f.instanceId);
          assert.equal(failed.status, "failed");
          assert.include(failed.error!, "dependencies");
        }).pipe(Effect.provide(f.layer)),
      { live: true, script: "require('missing-factory-preview-dependency');" },
    ),
  60_000,
);
live(
  "serves the actual immutable Node app through a localhost-only Docker preview and tears it down",
  () =>
    run(
      (f) =>
        Effect.gen(function* () {
          const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
          yield* Effect.addFinalizer(() => runtime.stop(f.instanceId).pipe(Effect.orDie));
          const ready = yield* runtime.start(f.input);
          assert.equal(ready.status, "ready");
          assert.match(ready.origin!, /^http:\/\/127\.0\.0\.1:\d+$/);
          const http = yield* HttpClient.HttpClient;
          const response = yield* http.get(ready.origin!);
          assert.include(yield* response.text, "Immutable candidate app");
          assert.equal((yield* runtime.get(f.instanceId)).containerId, ready.containerId);
          assert.equal((yield* runtime.stop(f.instanceId))?.status, "stopped");
        }).pipe(Effect.provide(f.layer), Effect.provide(FetchHttpClient.layer)),
      { live: true },
    ),
  60_000,
);
