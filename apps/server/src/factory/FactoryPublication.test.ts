import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as FactoryPublication from "./FactoryPublication.ts";
import * as FactorySource from "./FactorySource.ts";

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped();
  const repository = path.join(root, "repository");
  const remote = path.join(root, "remote.git");
  yield* fs.makeDirectory(repository);
  const git = Effect.fn(function* (args: ReadonlyArray<string>, stdin?: string) {
    const result = yield* runner.run({
      command: "git",
      args,
      cwd: repository,
      ...(stdin === undefined ? {} : { stdin }),
    });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  });
  const put = (name: string, content: string | Uint8Array) =>
    typeof content === "string"
      ? fs.writeFileString(path.join(repository, name), content)
      : fs.writeFile(path.join(repository, name), content);
  const hash = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
  const file = Effect.fn(function* (
    name: string,
    content: string | Uint8Array,
    mode: "100644" | "100755" = "100644",
  ) {
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    return { path: name, content: bytes.toString("base64"), digest: yield* hash(bytes), mode };
  });
  const candidate = Effect.fn(function* (
    files: ReadonlyArray<FactorySource.FactorySourceFile>,
    selectedPaths: ReadonlyArray<string>,
    deletedPaths: ReadonlyArray<string> = [],
  ) {
    return FactoryPublication.FactoryPublicationCandidate.make({
      id: "candidate-1",
      files,
      selectedPaths,
      deletedPaths,
      sourceDigest: yield* hash(
        Buffer.from(
          JSON.stringify(files.map(({ path, digest, mode }) => ({ path, digest, mode }))),
        ),
      ),
      grant: {
        boundaryId: FactoryBoundaryId.make("boundary"),
        epoch: 3,
        sourcePaths: ["source.cjs", "binary.dat", "deleted.cjs", "other.cjs"],
        creatableDirectories: ["src"],
        controlChange: null,
      },
      configuration: {
        writablePaths: ["source.cjs", "binary.dat", "deleted.cjs", "other.cjs"],
        protectedPaths: [".gitattributes"],
        creatableDirectories: ["src"],
        gates: [],
      },
    });
  });
  yield* git(["init", "--initial-branch=main"]);
  yield* git(["config", "user.name", "Fixture"]);
  yield* git(["config", "user.email", "fixture@example.invalid"]);
  yield* git(["config", "core.autocrlf", "false"]);
  yield* put("source.cjs", "committed\n");
  yield* put("other.cjs", "other committed\n");
  yield* put("deleted.cjs", "still committed\n");
  yield* put("binary.dat", Uint8Array.from([0, 1, 255]));
  yield* put(".env.example", "SYNTHETIC_SECRET=preserved\n");
  yield* put(".gitattributes", "*.cjs filter=untrusted\n");
  yield* git(["add", "."]);
  yield* git(["update-index", "--chmod=+x", "source.cjs"]);
  yield* git(["commit", "-m", "base"]);
  const revision = yield* git(["rev-parse", "HEAD"]);
  yield* git(["init", "--bare", remote]);
  yield* git(["push", remote, "HEAD:refs/heads/main"]);
  yield* put("source.cjs", "staged\n");
  yield* git(["add", "source.cjs"]);
  yield* put("source.cjs", "working\n");
  yield* put("other.cjs", "adopted but unselected\n");
  yield* fs.remove(path.join(repository, "deleted.cjs"));
  yield* git(["config", "filter.untrusted.clean", "echo ran > filter-executed; cat"]);
  yield* git(["config", "filter.untrusted.required", "true"]);
  yield* git(["config", "core.fsmonitor", "echo ran > monitor-executed"]);
  yield* fs.writeFileString(
    path.join(repository, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\necho ran > hook-executed\nexit 1\n",
  );
  const projectId = ProjectId.make("publication-project");
  const threadId = ThreadId.make("handover-thread");
  const now = yield* DateTime.now;
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId,
    createdBy: "user",
    creationSource: "web",
    title: "Handover",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  const config = ServerConfig.layerTest(root, root);
  const sourceDependencies = Layer.mergeAll(
    config,
    Layer.mock(ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Fixture",
            workspaceRoot: repository,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(ProjectionStoreV2)({ getThread: () => Effect.succeed(thread) }),
  );
  const { source, artifact } = yield* Effect.gen(function* () {
    const source = yield* FactorySource.FactorySource;
    const captured = yield* source.capture({
      requestId: CommandId.make("source-capture"),
      projectId,
      threadId,
    });
    return { source, artifact: yield* source.read(captured.id) };
  }).pipe(Effect.provide(FactorySource.layer), Effect.provide(sourceDependencies));
  const reservation = FactoryPublication.FactoryPublicationReservation.make({
    id: "publication-1",
    assignmentId: FactoryAssignmentId.make("assignment"),
    sourceId: artifact.source.id,
    boundaryId: FactoryBoundaryId.make("boundary"),
    epoch: 3,
    parentCommit: revision,
    destination: { kind: "local", repositoryPath: remote },
    branch: "factory/assignment",
    baseBranch: "main",
    expectedTip: null,
    author: { name: "Factory", email: "factory@example.invalid", timestamp: "1700000000 +0000" },
    committer: { name: "Factory", email: "factory@example.invalid", timestamp: "1700000000 +0000" },
    message: "Publish selected work\n",
  });
  const credentials = Layer.mock(GitHubCredentials.GitHubCredentials)({
    get: () => Effect.die("Local publication must not request credentials"),
  });
  const dependencies = Layer.mergeAll(
    config,
    Layer.succeed(FactorySource.FactorySource, source),
    credentials,
  );
  const layer = FactoryPublication.layer.pipe(Layer.provide(dependencies));
  return {
    fs,
    path,
    root,
    repository,
    remote,
    git,
    put,
    file,
    candidate,
    artifact,
    reservation,
    revision,
    layer,
    config,
    source,
    dependencies,
    runner,
  };
});

const run = <A, E, R>(
  body: (input: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<A, E, R>,
) =>
  fixture().pipe(
    Effect.flatMap(body),
    Effect.scoped,
    Effect.provide(ProcessRunner.layer),
    Effect.provide(NodeServices.layer),
  );

it.effect(
  "publishes selected binary and executable bytes while preserving excluded files, captured index, working state and hooks",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const publication = yield* FactoryPublication.FactoryPublication;
        const originalIndex = yield* f.fs.readFile(f.path.join(f.repository, ".git", "index"));
        const changed = yield* f.file("source.cjs", "completed\n", "100755");
        const binary = yield* f.file("binary.dat", Uint8Array.from([255, 0, 13, 10, 128]));
        const candidate = yield* f.candidate(
          f.artifact.files.map((file) =>
            file.path === changed.path ? changed : file.path === binary.path ? binary : file,
          ),
          [changed.path, binary.path, "deleted.cjs"],
          ["deleted.cjs"],
        );
        const prepared = yield* publication.prepare({ reservation: f.reservation, candidate });
        assert.notEqual(prepared.startingIndexTreeOid, prepared.startingWorkTreeOid);
        assert.notEqual(prepared.candidateDigest, prepared.publishedSourceDigest);
        const artifact = yield* publication.read(f.reservation.id);
        assert.equal(
          Buffer.from(
            artifact.publishedFiles.find((file) => file.path === "other.cjs")!.content,
            "base64",
          ).toString(),
          "other committed\n",
        );
        yield* publication
          .push({
            reservationId: f.reservation.id,
            beforeWrite: Effect.fail(
              new FactoryPublication.FactoryPublicationError({ reason: "invalid-input" }),
            ),
          })
          .pipe(Effect.flip);
        assert.equal((yield* publication.inspect(f.reservation.id)).remoteTip, null);
        assert.deepEqual(yield* publication.push({ reservationId: f.reservation.id }), {
          status: "confirmed",
          remoteTip: prepared.commitOid,
        });
        assert.equal(
          yield* f.git([`--git-dir=${f.remote}`, "show", `${prepared.commitOid}:source.cjs`]),
          "completed",
        );
        assert.equal(
          yield* f.git([`--git-dir=${f.remote}`, "show", `${prepared.commitOid}:.env.example`]),
          "SYNTHETIC_SECRET=preserved",
        );
        const listing = yield* f.git([`--git-dir=${f.remote}`, "ls-tree", prepared.commitOid]);
        assert.include(listing, "100755 blob");
        assert.notInclude(listing, "deleted.cjs");
        const chunks: Array<Uint8Array> = [];
        yield* f.runner.run({
          command: "git",
          args: [`--git-dir=${f.remote}`, "show", `${prepared.commitOid}:binary.dat`],
          onStdoutChunk: (chunk) => chunks.push(Buffer.from(chunk)),
        });
        assert.deepEqual(Buffer.concat(chunks), Buffer.from([255, 0, 13, 10, 128]));
        assert.deepEqual(
          yield* f.fs.readFile(f.path.join(f.repository, ".git", "index")),
          originalIndex,
        );
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.repository, "source.cjs")),
          "working\n",
        );
        assert.equal(yield* f.git(["rev-parse", "HEAD"]), f.revision);
        for (const name of ["hook-executed", "filter-executed", "monitor-executed"])
          assert.isFalse(yield* f.fs.exists(f.path.join(f.repository, name)));
      }).pipe(Effect.provide(f.layer)),
    ),
  30_000,
);

it.effect(
  "reopens deterministic reservations, rejects conflicting retries, and publishes the next revision from private parent objects",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const candidate = yield* f.candidate(f.artifact.files, ["source.cjs"], ["deleted.cjs"]);
        const first = yield* Effect.gen(function* () {
          const publication = yield* FactoryPublication.FactoryPublication;
          const prepared = yield* publication.prepare({ reservation: f.reservation, candidate });
          yield* publication.push({ reservationId: f.reservation.id });
          return prepared;
        }).pipe(Effect.provide(f.layer));
        yield* Effect.gen(function* () {
          const publication = yield* FactoryPublication.FactoryPublication;
          assert.deepEqual(
            yield* publication.prepare({ reservation: f.reservation, candidate }),
            first,
          );
          assert.equal(
            (yield* publication
              .prepare({ reservation: { ...f.reservation, message: "changed" }, candidate })
              .pipe(Effect.flip)).reason,
            "reservation-conflict",
          );
          const updated = yield* f.file("source.cjs", "second revision\n");
          const nextCandidate = yield* f.candidate(
            f.artifact.files.map((file) => (file.path === updated.path ? updated : file)),
            [updated.path],
            ["deleted.cjs"],
          );
          const next = yield* publication.prepare({
            reservation: {
              ...f.reservation,
              id: "publication-2",
              previousReservationId: f.reservation.id,
              parentCommit: first.commitOid,
              expectedTip: first.commitOid,
            },
            candidate: nextCandidate,
          });
          assert.notEqual(next.commitOid, first.commitOid);
          assert.equal(
            (yield* publication.push({ reservationId: "publication-2" })).status,
            "confirmed",
          );
          assert.equal(
            yield* f.git([`--git-dir=${f.remote}`, "rev-parse", `${next.commitOid}^`]),
            first.commitOid,
          );
        }).pipe(Effect.provide(FactoryPublication.layer.pipe(Layer.provide(f.dependencies))));
      }),
    ),
  30_000,
);

it.effect(
  "rejects tampered bytes, protected changes, missing files and unselected undeclared deletions",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const publication = yield* FactoryPublication.FactoryPublication;
        const candidate = yield* f.candidate(f.artifact.files, ["source.cjs"], ["deleted.cjs"]);
        const tampered = {
          ...candidate,
          files: candidate.files.map((file) =>
            file.path === "source.cjs"
              ? { ...file, content: Buffer.from("tampered").toString("base64") }
              : file,
          ),
        };
        assert.equal(
          (yield* publication
            .prepare({ reservation: f.reservation, candidate: tampered })
            .pipe(Effect.flip)).reason,
          "invalid-input",
        );
        const protectedFile = yield* f.file(".gitattributes", "* filter=host\n");
        const protectedCandidate = yield* f.candidate(
          candidate.files.map((file) => (file.path === protectedFile.path ? protectedFile : file)),
          [protectedFile.path],
          ["deleted.cjs"],
        );
        assert.equal(
          (yield* publication
            .prepare({
              reservation: { ...f.reservation, id: "protected" },
              candidate: protectedCandidate,
            })
            .pipe(Effect.flip)).reason,
          "invalid-input",
        );
        const missing = yield* f.candidate(
          candidate.files.filter((file) => file.path !== "other.cjs"),
          ["source.cjs"],
          ["deleted.cjs"],
        );
        assert.equal(
          (yield* publication
            .prepare({ reservation: { ...f.reservation, id: "missing" }, candidate: missing })
            .pipe(Effect.flip)).reason,
          "invalid-input",
        );
        assert.equal(
          (yield* publication
            .prepare({
              reservation: { ...f.reservation, id: "digest" },
              candidate: { ...candidate, sourceDigest: "invented" },
            })
            .pipe(Effect.flip)).reason,
          "invalid-input",
        );
      }).pipe(Effect.provide(f.layer)),
    ),
  30_000,
);

it.effect(
  "does not overwrite a remote branch that moves between observation and push",
  () =>
    run((f) =>
      Effect.gen(function* () {
        let raced = false;
        const raceRunner = ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.gen(function* () {
              if (input.args?.includes("push") && !raced) {
                raced = true;
                yield* f.git([
                  `--git-dir=${f.remote}`,
                  "update-ref",
                  `refs/heads/${f.reservation.branch}`,
                  f.revision,
                ]);
              }
              return yield* f.runner.run(input);
            }),
        });
        const candidate = yield* f.candidate(f.artifact.files, ["source.cjs"], ["deleted.cjs"]);
        yield* Effect.gen(function* () {
          const publication = yield* FactoryPublication.FactoryPublication;
          yield* publication.prepare({ reservation: f.reservation, candidate });
          assert.deepEqual(yield* publication.push({ reservationId: f.reservation.id }), {
            status: "conflict",
            remoteTip: f.revision,
          });
          assert.equal(
            yield* f.git([
              `--git-dir=${f.remote}`,
              "rev-parse",
              `refs/heads/${f.reservation.branch}`,
            ]),
            f.revision,
          );
        }).pipe(
          Effect.provide(
            f.layer.pipe(Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, raceRunner))),
          ),
        );
      }),
    ),
  30_000,
);

it.effect(
  "reconciles a successful push whose acknowledgement was lost without another mutation",
  () =>
    run((f) =>
      Effect.gen(function* () {
        let pushes = 0;
        const lostAckRunner = ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.gen(function* () {
              const result = yield* f.runner.run(input);
              if (input.args?.includes("push")) {
                pushes += 1;
                return { ...result, code: null, stdout: "", stderr: "", timedOut: true };
              }
              return result;
            }),
        });
        const candidate = yield* f.candidate(f.artifact.files, ["source.cjs"], ["deleted.cjs"]);
        yield* Effect.gen(function* () {
          const publication = yield* FactoryPublication.FactoryPublication;
          const prepared = yield* publication.prepare({ reservation: f.reservation, candidate });
          assert.deepEqual(yield* publication.push({ reservationId: f.reservation.id }), {
            status: "confirmed",
            remoteTip: prepared.commitOid,
          });
          assert.equal(
            (yield* publication.push({ reservationId: f.reservation.id })).status,
            "confirmed",
          );
          assert.equal(pushes, 1);
        }).pipe(
          Effect.provide(
            f.layer.pipe(Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, lostAckRunner))),
          ),
        );
      }),
    ),
  30_000,
);

it.effect(
  "rejects changed GitHub credentials before starting network transport",
  () =>
    run((f) =>
      Effect.gen(function* () {
        let networkCalls = 0;
        const countedRunner = ProcessRunner.ProcessRunner.of({
          run: (input) => {
            if (input.args?.some((arg) => arg.startsWith("https://"))) networkCalls += 1;
            return f.runner.run(input);
          },
        });
        const candidate = yield* f.candidate(f.artifact.files, ["source.cjs"], ["deleted.cjs"]);
        const dependencies = Layer.mergeAll(
          f.config,
          Layer.succeed(FactorySource.FactorySource, f.source),
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host) =>
              Effect.succeed({
                host,
                token: Redacted.make("synthetic-only"),
                fingerprint: "new-account",
                source: "settings",
              }),
          }),
        );
        yield* Effect.gen(function* () {
          const publication = yield* FactoryPublication.FactoryPublication;
          yield* publication.prepare({
            reservation: {
              ...f.reservation,
              destination: {
                kind: "github",
                host: "github.com",
                owner: "example",
                repository: "fixture",
                credentialFingerprint: "approved-account",
              },
            },
            candidate,
          });
          assert.equal(
            (yield* publication.push({ reservationId: f.reservation.id }).pipe(Effect.flip)).reason,
            "credential-changed",
          );
          assert.equal(networkCalls, 0);
        }).pipe(
          Effect.provide(
            FactoryPublication.layer.pipe(
              Layer.provide(dependencies),
              Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, countedRunner)),
            ),
          ),
        );
      }),
    ),
  30_000,
);

it.effect(
  "rebuilds an interrupted preparation deterministically after original objects become unavailable",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const candidate = yield* f.candidate(f.artifact.files, ["source.cjs"], ["deleted.cjs"]);
        const prepared = yield* Effect.gen(function* () {
          return yield* (yield* FactoryPublication.FactoryPublication).prepare({
            reservation: f.reservation,
            candidate,
          });
        }).pipe(Effect.provide(f.layer));
        const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(f.config));
        const crypto = yield* Crypto.Crypto;
        const reservationKey = Buffer.from(
          yield* crypto.digest("SHA-256", Buffer.from(f.reservation.id)),
        ).toString("hex");
        const directory = f.path.join(config.stateDir, "factory", "publications", reservationKey);
        yield* f.fs.rename(
          f.path.join(directory, "artifact.json"),
          f.path.join(directory, "unacknowledged-artifact.json"),
        );
        yield* f.fs.rename(
          f.path.join(f.repository, ".git", "objects"),
          f.path.join(f.repository, ".git", "unavailable-objects"),
        );
        yield* Effect.gen(function* () {
          const publication = yield* FactoryPublication.FactoryPublication;
          assert.deepEqual(
            yield* publication.prepare({ reservation: f.reservation, candidate }),
            prepared,
          );
          assert.equal(
            (yield* publication.push({ reservationId: f.reservation.id })).status,
            "confirmed",
          );
        }).pipe(Effect.provide(FactoryPublication.layer.pipe(Layer.provide(f.dependencies))));
      }),
    ),
  30_000,
);

it.effect(
  "preserves unselected symlink and gitlink entries from a qualified full base tree",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const indexPath = f.path.join(f.root, "qualified-base-index");
        const indexGit = Effect.fn(function* (args: ReadonlyArray<string>, stdin?: string) {
          const result = yield* f.runner.run({
            command: "git",
            args: ["-c", "core.fsmonitor=false", ...args],
            cwd: f.repository,
            env: { GIT_INDEX_FILE: indexPath },
            ...(stdin === undefined ? {} : { stdin }),
          });
          assert.equal(result.code, 0, result.stderr);
          return result.stdout.trim();
        });
        yield* indexGit(["read-tree", f.revision]);
        const linkBlob = yield* indexGit(["hash-object", "-w", "--stdin"], "source.cjs");
        yield* indexGit([
          "update-index",
          "--add",
          "--cacheinfo",
          `120000,${linkBlob},untouched-link`,
        ]);
        yield* indexGit([
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${f.revision},untouched-submodule`,
        ]);
        const baseTree = yield* indexGit(["write-tree"]);
        const revision = yield* indexGit(
          ["commit-tree", baseTree, "-p", f.revision],
          "qualified special entries\n",
        );
        const qualifiedSource = { ...f.artifact, source: { ...f.artifact.source, revision } };
        const dependencies = Layer.mergeAll(
          f.config,
          Layer.mock(FactorySource.FactorySource)({ read: () => Effect.succeed(qualifiedSource) }),
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: () => Effect.die("No network credentials"),
          }),
        );
        const candidate = yield* f.candidate(f.artifact.files, ["source.cjs"], ["deleted.cjs"]);
        yield* Effect.gen(function* () {
          const publication = yield* FactoryPublication.FactoryPublication;
          const prepared = yield* publication.prepare({
            reservation: { ...f.reservation, parentCommit: revision },
            candidate,
          });
          assert.equal(
            (yield* publication.push({ reservationId: f.reservation.id })).status,
            "confirmed",
          );
          const listing = yield* f.git([`--git-dir=${f.remote}`, "ls-tree", prepared.commitOid]);
          assert.include(listing, `120000 blob ${linkBlob}\tuntouched-link`);
          assert.include(listing, `160000 commit ${f.revision}\tuntouched-submodule`);
          assert.equal(
            yield* f.git([`--git-dir=${f.remote}`, "show", `${prepared.commitOid}:.env.example`]),
            "SYNTHETIC_SECRET=preserved",
          );
        }).pipe(Effect.provide(FactoryPublication.layer.pipe(Layer.provide(dependencies))));
      }),
    ),
  30_000,
);

it.effect(
  "uses exact host scoped credentials only in process environment and never follows redirects",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const transportCalls: Array<ProcessRunner.ProcessRunInput> = [];
        const intercepted = ProcessRunner.ProcessRunner.of({
          run: (input) => {
            if (input.args.some((arg) => arg.startsWith("https://"))) {
              transportCalls.push(input);
              return Effect.succeed({
                stdout: "",
                stderr: "",
                code: null,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            }
            return f.runner.run(input);
          },
        });
        const dependencies = Layer.mergeAll(
          f.config,
          Layer.succeed(FactorySource.FactorySource, f.source),
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host) =>
              Effect.succeed({
                host,
                token: Redacted.make("synthetic-only-token"),
                fingerprint: "approved-account",
                source: "settings",
              }),
          }),
        );
        const candidate = yield* f.candidate(f.artifact.files, ["source.cjs"], ["deleted.cjs"]);
        yield* Effect.gen(function* () {
          const publication = yield* FactoryPublication.FactoryPublication;
          yield* publication.prepare({
            reservation: {
              ...f.reservation,
              destination: {
                kind: "github",
                host: "github.example.invalid",
                owner: "example",
                repository: "fixture",
                credentialFingerprint: "approved-account",
              },
            },
            candidate,
          });
          assert.deepEqual(yield* publication.inspect(f.reservation.id), { status: "unknown" });
          assert.equal(transportCalls.length, 1);
          const call = transportCalls[0]!;
          assert.include(call.args, "https://github.example.invalid/example/fixture.git");
          assert.include(call.args, "http.followRedirects=false");
          assert.equal(
            call.env?.GIT_CONFIG_KEY_0,
            "http.https://github.example.invalid/example/fixture.git.extraheader",
          );
          assert.equal(
            call.env?.GIT_CONFIG_VALUE_0,
            `AUTHORIZATION: basic ${Buffer.from("x-access-token:synthetic-only-token").toString("base64")}`,
          );
          assert.notInclude(call.args.join(" "), "synthetic-only-token");
          assert.notInclude(
            JSON.stringify(yield* publication.read(f.reservation.id)),
            "synthetic-only-token",
          );
        }).pipe(
          Effect.provide(
            FactoryPublication.layer.pipe(
              Layer.provide(dependencies),
              Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, intercepted)),
            ),
          ),
        );
      }),
    ),
  30_000,
);
