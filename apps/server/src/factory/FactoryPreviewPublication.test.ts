import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactorySourceId,
  ProjectId,
  ThreadId,
  type FactoryAssignment,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as FactoryPreviewEvidence from "./FactoryPreviewEvidence.ts";
import * as FactoryPreviewPublication from "./FactoryPreviewPublication.ts";
import * as FactoryPublication from "./FactoryPublication.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import { FactoryStore } from "./FactoryStore.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const BlobBody = Schema.Struct({ encoding: Schema.Literal("base64"), content: Schema.String });
const TreeBody = Schema.Struct({
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.String,
      type: Schema.String,
      sha: Schema.String,
    }),
  ),
});
const CommitBody = Schema.Struct({
  message: Schema.String,
  tree: Schema.String,
  parents: Schema.Array(Schema.String),
  author: Schema.Struct({ name: Schema.String, email: Schema.String, date: Schema.String }),
});
const RefBody = Schema.Struct({ ref: Schema.String, sha: Schema.String });
const isApiError = Schema.is(GitHubApi.GitHubApiRequestError);
const isNotFoundError = Schema.is(GitHubApi.GitHubApiNotFoundError);
const decodeBlobBody = Schema.decodeUnknownEffect(BlobBody);
const decodeTreeBody = Schema.decodeUnknownEffect(TreeBody);
const decodeCommitBody = Schema.decodeUnknownEffect(CommitBody);
const decodeRefBody = Schema.decodeUnknownEffect(RefBody);

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const root = yield* fs.makeTempDirectoryScoped();
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=",
    "base64",
  );
  const hash = (algorithm: "SHA-1" | "SHA-256", value: Uint8Array) =>
    crypto
      .digest(algorithm, value)
      .pipe(Effect.map((digest) => Buffer.from(digest).toString("hex")));
  const screenshotDigest = yield* hash("SHA-256", bytes);
  const screenshot = `${root}/screenshot.png`;
  yield* fs.writeFile(screenshot, bytes);
  const projectId = ProjectId.make("preview-publication-project");
  const assignmentId = FactoryAssignmentId.make("preview-publication-assignment");
  const managerId = ThreadId.make("manager");
  const threadId = ThreadId.make("lead");
  const reviewThreadId = ThreadId.make("reviewer");
  const now = "2026-10-10T12:00:00.000Z";
  const source = {
    id: FactorySourceId.make("source"),
    projectId,
    revision: "a".repeat(40),
    sourceDigest: "source-digest",
    branch: "main",
    origin: "project" as const,
    capturedAt: now,
    fileCount: 1,
    stagedPaths: [],
    unstagedPaths: [],
    untrackedPaths: [],
    deletedPaths: [],
    excludedPaths: [],
  };
  const grant = {
    boundaryId: FactoryBoundaryId.make("boundary"),
    epoch: 2,
    sourcePaths: ["app.cjs"],
    creatableDirectories: [],
    controlChange: null,
  };
  const ux = {
    instanceId: "preview",
    candidateDigest: "candidate-digest",
    reviewThreadId,
    operationsDigest: "a".repeat(64),
    screenshots: [{ label: "Actual app", location: "broker:png" }],
    journeys: [{ label: "Open app", location: "broker:journey" }],
    observedAt: now,
  };
  const revision = {
    id: "revision",
    operationId: "capture",
    selectedPaths: ["app.cjs"],
    commitMessage: "Candidate",
    grantEpoch: 2,
    boundaryId: grant.boundaryId,
    workflowRevision: "workflow",
    startingSourceId: source.id,
    status: "captured" as const,
    candidateId: "candidate",
    candidateDigest: ux.candidateDigest,
    publication: {
      reservationId: "revision",
      host: "github.example.invalid",
      repository: "Example/Project",
      branch: "satellite/factory/candidate",
      baseBranch: "main",
      headSha: "b".repeat(40),
      treeOid: "c".repeat(40),
    },
    uxEvidence: ux,
    reviews: [],
    createdAt: now,
  };
  const assignment: FactoryAssignment = {
    id: assignmentId,
    managerId,
    threadId,
    projectId,
    kind: "implementation",
    workflow: { repositoryRoot: "/workflow", revision: "workflow" },
    startingSource: source,
    grant,
    grantedPolicy: initialFactorySnapshot().defaults,
    qualification: { status: "qualified", profileId: "profile", checkedAt: now },
    status: "running",
    threadStatus: "created",
    launchStatus: "delivered",
    wait: null,
    report: null,
    createdAt: now,
    updatedAt: now,
    delivery: {
      currentRevisionId: revision.id,
      revisions: [revision],
      directionHeld: false,
      readiness: [],
      retroFindings: [],
    },
  };
  let state: FactorySnapshot = {
    ...initialFactorySnapshot(),
    assignments: [assignment],
    previewPublicationPolicies: [
      { projectId, enabled: true, approvedAt: now, authorizingCommandId: CommandId.make("opt-in") },
    ],
  };
  const revoke = () => {
    state = {
      ...state,
      previewPublicationPolicies: state.previewPublicationPolicies.map((policy) => ({
        ...policy,
        enabled: false,
      })),
    };
  };
  let branch: typeof RefBody.Type | undefined;
  let tree: typeof TreeBody.Type | undefined;
  let treeOid = "";
  let commit: typeof CommitBody.Type | undefined;
  let commitOid = "";
  let lostRefAck = false;
  let revokeAfterBlob = false;
  let foreignRef = false;
  let credentialFingerprint = "approved";
  const mutations: Array<string> = [];
  const response = (body: unknown): GitHubApi.GitHubRestResponse => ({
    status: 200,
    headers: {},
    body: json(body),
    truncated: false,
    invalidUtf8: false,
  });
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest(root, root),
    Layer.mock(FactoryStore)({ snapshot: Effect.sync(() => state) }),
    Layer.mock(FactoryPreviewEvidence.FactoryPreviewEvidence)({
      read: () =>
        Effect.succeed({
          evidence: ux,
          artifacts: [{ path: screenshot, digest: screenshotDigest, label: "Actual app" }],
        }),
    }),
    Layer.mock(GitHubCredentials.GitHubCredentials)({
      get: (host) =>
        Effect.sync(() => ({
          host,
          token: Redacted.make("fixture"),
          fingerprint: credentialFingerprint,
          source: "settings" as const,
        })),
    }),
    Layer.mock(FactoryPublication.FactoryPublication)({
      read: () =>
        Effect.succeed({
          reservation: {
            id: "revision",
            assignmentId,
            sourceId: source.id,
            boundaryId: grant.boundaryId,
            epoch: 2,
            parentCommit: source.revision,
            destination: {
              kind: "github",
              host: revision.publication.host,
              owner: "Example",
              repository: "Project",
              credentialFingerprint: "approved",
            },
            branch: revision.publication.branch,
            baseBranch: "main",
            expectedTip: null,
            author: {
              name: "Author",
              email: "author@example.invalid",
              timestamp: "1791633600 +0000",
            },
            committer: {
              name: "Author",
              email: "author@example.invalid",
              timestamp: "1791633600 +0000",
            },
            message: "Candidate",
          },
          candidate: {
            id: "candidate",
            sourceDigest: "raw",
            files: [],
            deletedPaths: [],
            selectedPaths: ["app.cjs"],
            grant,
            configuration: {
              protectedPaths: [],
              writablePaths: ["app.cjs"],
              creatableDirectories: [],
              gates: [],
            },
          },
          publishedFiles: [],
          prepared: {
            reservationId: "revision",
            candidateId: "candidate",
            candidateDigest: "raw",
            publishedSourceDigest: ux.candidateDigest,
            startingIndexTreeOid: "index",
            startingWorkTreeOid: "work",
            treeOid: revision.publication.treeOid,
            commitOid: revision.publication.headSha,
            selectedPaths: ["app.cjs"],
          },
        }),
    }),
    Layer.mock(GitHubApi.GitHubApi)({
      rest: (input) =>
        Effect.gen(function* () {
          const credential = yield* GitHubApi.PinnedGitHubCredential;
          assert.equal(credential?.credentialFingerprint, "approved");
          if (input.method === "POST") {
            const guard = yield* GitHubApi.BeforeGitHubMutation;
            if (guard) yield* guard;
            mutations.push(input.path);
          }
          if (input.path.endsWith("/blobs")) {
            const body = yield* decodeBlobBody(input.body);
            const content = Buffer.from(body.content, "base64");
            assert.deepEqual(content, bytes);
            const sha = yield* hash(
              "SHA-1",
              Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]),
            );
            if (revokeAfterBlob) revoke();
            return response({ sha });
          }
          if (input.path.endsWith("/trees")) {
            tree = yield* decodeTreeBody(input.body);
            const raw = Buffer.concat(
              tree.tree.map((file) =>
                Buffer.concat([
                  Buffer.from(`${file.mode} ${file.path}\0`),
                  Buffer.from(file.sha, "hex"),
                ]),
              ),
            );
            treeOid = yield* hash(
              "SHA-1",
              Buffer.concat([Buffer.from(`tree ${raw.length}\0`), raw]),
            );
            return response({ sha: treeOid });
          }
          if (input.path.endsWith("/commits")) {
            commit = yield* decodeCommitBody(input.body);
            commitOid = yield* hash("SHA-1", Buffer.from(json(commit)));
            return response({ sha: commitOid });
          }
          if (input.path.includes("/trees/"))
            return response({ ...tree, sha: treeOid, truncated: false });
          if (input.path.includes("/commits/"))
            return response({
              sha: commitOid,
              message: commit!.message,
              tree: { sha: treeOid },
              parents: [],
            });
          if (input.path.endsWith("/refs")) {
            branch = yield* decodeRefBody(input.body);
            if (lostRefAck)
              return yield* new GitHubApi.GitHubApiRequestError({
                host: input.host,
                operation: input.operation,
                cause: "lost reference acknowledgement",
              });
            return response({ ref: branch.ref, object: { type: "commit", sha: branch.sha } });
          }
          if (input.path.includes("/ref/")) {
            if (foreignRef)
              return response({
                ref: `refs/${input.path.split("/ref/")[1]}`,
                object: { type: "commit", sha: "f".repeat(40) },
              });
            if (!branch)
              return yield* new GitHubApi.GitHubApiNotFoundError({
                host: input.host,
                operation: input.operation,
              });
            return response({ ref: branch.ref, object: { type: "commit", sha: branch.sha } });
          }
          return yield* new GitHubApi.GitHubApiRequestError({
            host: input.host,
            operation: input.operation,
            cause: "Unexpected fixture operation",
          });
        }).pipe(
          Effect.mapError((cause) =>
            isNotFoundError(cause) || isApiError(cause)
              ? cause
              : new GitHubApi.GitHubApiRequestError({
                  host: input.host,
                  operation: input.operation,
                  cause,
                }),
          ),
        ),
    }),
  );
  return {
    layer: FactoryPreviewPublication.layer.pipe(Layer.provide(dependencies)),
    input: { assignmentId, revisionId: revision.id },
    bytes,
    screenshot,
    mutations,
    fs,
    candidateHead: revision.publication.headSha,
    branch: () => branch,
    revoke,
    revokeAfterBlob: () => {
      revokeAfterBlob = true;
    },
    loseRefAck: () => {
      lostRefAck = true;
    },
    foreignRef: () => {
      foreignRef = true;
    },
    changeAccount: () => {
      credentialFingerprint = "different";
    },
    changeEpoch: () => {
      state = { ...state, assignments: [{ ...assignment, grant: { ...grant, epoch: 3 } }] };
    },
  };
});
const run = <A, E, R>(
  body: (f: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<A, E, R>,
) => fixture().pipe(Effect.flatMap(body), Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "publishes only sealed PNGs under an immutable evidence ref and reconciles a lost acknowledgement across restart",
  () =>
    run((f) =>
      Effect.gen(function* () {
        f.loseRefAck();
        const first = yield* Effect.gen(function* () {
          return yield* (yield* FactoryPreviewPublication.FactoryPreviewPublication).publish(
            f.input,
          );
        }).pipe(Effect.provide(f.layer));
        const count = f.mutations.length;
        const replay = yield* Effect.gen(function* () {
          const service = yield* FactoryPreviewPublication.FactoryPreviewPublication;
          assert.deepEqual(yield* service.read(f.input), first);
          return yield* service.publish(f.input);
        }).pipe(Effect.provide(f.layer));
        assert.deepEqual(replay, first);
        assert.equal(f.mutations.length, count);
        assert.notEqual(first.commitOid, f.candidateHead);
        assert.match(
          f.branch()!.ref,
          /^refs\/heads\/satellite\/factory-evidence\/[a-f0-9]{32}\/[a-f0-9]{64}$/,
        );
        assert.include(first.urls[0]!.imageUrl, `/blob/${first.commitOid}/`);
        assert.match(first.urls[0]!.imageUrl, /\.png\?raw=true$/);
        assert.match(first.urls[0]!.linkUrl, /\.png$/);
        assert.equal(f.mutations.filter((path) => path.endsWith("/refs")).length, 1);
      }),
    ),
);

it.effect(
  "requires current project opt-in, intact PNGs, current authority and the pinned account",
  () =>
    Effect.forEach(["policy", "epoch", "png", "account", "foreign"] as const, (kind) =>
      run((f) =>
        Effect.gen(function* () {
          if (kind === "policy") f.revoke();
          if (kind === "epoch") f.changeEpoch();
          if (kind === "account") f.changeAccount();
          if (kind === "foreign") f.foreignRef();
          if (kind === "png") yield* f.fs.writeFileString(f.screenshot, "not PNG");
          yield* (yield* FactoryPreviewPublication.FactoryPreviewPublication)
            .publish(f.input)
            .pipe(Effect.flip);
          assert.equal(f.mutations.length, 0);
        }).pipe(Effect.provide(f.layer)),
      ),
    ),
);

it.effect("stops subsequent writes when the project revokes publication during blob upload", () =>
  run((f) =>
    Effect.gen(function* () {
      f.revokeAfterBlob();
      yield* (yield* FactoryPreviewPublication.FactoryPreviewPublication)
        .publish(f.input)
        .pipe(Effect.flip);
      assert.equal(f.mutations.length, 1);
      assert.match(f.mutations[0]!, /\/blobs$/);
      assert.isUndefined(f.branch());
    }).pipe(Effect.provide(f.layer)),
  ),
);
