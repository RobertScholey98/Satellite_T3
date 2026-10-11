import { FactoryAssignmentId, FactoryError, isFactoryError } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import { factoryExecutionBlocked } from "./FactoryControls.ts";
import * as FactoryPreviewEvidence from "./FactoryPreviewEvidence.ts";
import * as FactoryPublication from "./FactoryPublication.ts";
import { FactoryStore } from "./FactoryStore.ts";

export const FactoryPublishedPreview = Schema.Struct({
  operationsDigest: Schema.String,
  commitOid: Schema.String,
  urls: Schema.Array(
    Schema.Struct({
      digest: Schema.String,
      label: Schema.String,
      imageUrl: Schema.String,
      linkUrl: Schema.String,
    }),
  ),
});
export type FactoryPublishedPreview = typeof FactoryPublishedPreview.Type;
const Input = Schema.Struct({ assignmentId: FactoryAssignmentId, revisionId: Schema.String });
const Reservation = Schema.Struct({
  assignmentId: FactoryAssignmentId,
  revisionId: Schema.String,
  operationsDigest: Schema.String,
  candidateDigest: Schema.String,
  grantEpoch: Schema.Int,
  boundaryId: Schema.String,
  sourceId: Schema.String,
  workflowRevision: Schema.String,
  host: Schema.String,
  repository: Schema.String,
  credentialFingerprint: Schema.String,
  branch: Schema.String,
  treeOid: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      digest: Schema.String,
      blobOid: Schema.String,
      label: Schema.String,
    }),
  ),
  commitOid: Schema.optionalKey(Schema.String),
  referenceAttempted: Schema.Boolean,
  proof: Schema.optionalKey(FactoryPublishedPreview),
});
const ObjectId = Schema.Struct({ sha: Schema.String });
const GitReference = Schema.Struct({
  ref: Schema.String,
  object: Schema.Struct({ type: Schema.String, sha: Schema.String }),
});
const GitTree = Schema.Struct({
  sha: Schema.String,
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.String,
      type: Schema.String,
      sha: Schema.String,
    }),
  ),
});
const GitCommit = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  tree: ObjectId,
  parents: Schema.Array(ObjectId),
});
const decodeObject = Schema.decodeUnknownEffect(Schema.fromJsonString(ObjectId));
const decodeRef = Schema.decodeUnknownEffect(Schema.fromJsonString(GitReference));
const decodeTree = Schema.decodeUnknownEffect(Schema.fromJsonString(GitTree));
const decodeCommit = Schema.decodeUnknownEffect(Schema.fromJsonString(GitCommit));
const decodeReservation = Schema.decodeUnknownEffect(Schema.fromJsonString(Reservation));
const encodeReservation = Schema.encodeEffect(Schema.fromJsonString(Reservation));
const preserve = (cause: unknown) =>
  isFactoryError(cause)
    ? cause
    : new FactoryError({
        code: "execution-unavailable",
        detail:
          "The sealed screenshots could not be published to the approved evidence destination.",
        cause,
      });

export class FactoryPreviewPublication extends Context.Service<
  FactoryPreviewPublication,
  {
    readonly publish: (
      input: typeof Input.Type,
    ) => Effect.Effect<FactoryPublishedPreview, FactoryError>;
    readonly read: (
      input: typeof Input.Type,
    ) => Effect.Effect<FactoryPublishedPreview | undefined, FactoryError>;
  }
>()("t3/factory/FactoryPreviewPublication") {}

const make = Effect.gen(function* () {
  const store = yield* FactoryStore;
  const evidence = yield* FactoryPreviewEvidence.FactoryPreviewEvidence;
  const publication = yield* FactoryPublication.FactoryPublication;
  const api = yield* GitHubApi.GitHubApi;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const mutex = yield* Semaphore.make(1);
  const digest = (algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array) =>
    crypto
      .digest(algorithm, bytes)
      .pipe(Effect.map((result) => Buffer.from(result).toString("hex")));
  const gitHash = (type: "blob" | "tree", bytes: Uint8Array) =>
    digest("SHA-1", Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]));
  const location = (input: typeof Input.Type, operationsDigest: string) =>
    digest("SHA-256", Buffer.from(stableStringify({ ...input, operationsDigest }))).pipe(
      Effect.map((key) =>
        path.join(config.stateDir, "factory", "preview-publications", `${key}.json`),
      ),
    );
  const save = Effect.fn(function* (input: typeof Input.Type, record: typeof Reservation.Type) {
    const target = yield* location(input, record.operationsDigest);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(`${target}.pending`, yield* encodeReservation(record));
    yield* fs.rename(`${target}.pending`, target);
  });
  const current = Effect.fn(function* (
    input: typeof Input.Type,
    reserved?: typeof Reservation.Type,
  ) {
    const state = yield* store.snapshot;
    const assignment = state.assignments.find((entry) => entry.id === input.assignmentId);
    const revision = assignment?.delivery?.revisions.find((entry) => entry.id === input.revisionId);
    if (
      !assignment ||
      assignment.status === "complete" ||
      assignment.outcome?.kind === "cancelled" ||
      !revision?.publication ||
      !revision.uxEvidence ||
      assignment.delivery?.currentRevisionId !== revision.id ||
      assignment.grant?.epoch !== revision.grantEpoch ||
      assignment.grant.boundaryId !== revision.boundaryId ||
      assignment.startingSource?.id !== revision.startingSourceId ||
      assignment.workflow.revision !== revision.workflowRevision ||
      revision.uxEvidence.candidateDigest !== revision.candidateDigest ||
      !state.previewPublicationPolicies.some(
        (entry) => entry.projectId === assignment.projectId && entry.enabled,
      )
    )
      return yield* new FactoryError({
        code: "permission-denied",
        detail:
          "Screenshot publication requires the current candidate and explicit project opt-in.",
      });
    const blocked = factoryExecutionBlocked(state, {
      assignmentId: assignment.id,
      threadId: assignment.threadId,
      projectId: assignment.projectId,
      managerId: assignment.managerId,
      ancestorThreadIds: [],
    });
    if (blocked) return yield* new FactoryError({ code: "permission-denied", detail: blocked });
    if (
      reserved &&
      (reserved.operationsDigest !== revision.uxEvidence.operationsDigest ||
        reserved.candidateDigest !== revision.candidateDigest ||
        reserved.grantEpoch !== revision.grantEpoch ||
        reserved.boundaryId !== revision.boundaryId ||
        reserved.sourceId !== revision.startingSourceId ||
        reserved.workflowRevision !== revision.workflowRevision ||
        reserved.host !== revision.publication.host ||
        reserved.repository !== revision.publication.repository)
    )
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "The screenshot publication reservation no longer matches the current revision.",
      });
    return { assignment, revision, destination: revision.publication, ux: revision.uxEvidence };
  });
  const publish = Effect.fn("FactoryPreviewPublication.publish")(
    function* (input: typeof Input.Type) {
      const { assignment, revision, destination, ux } = yield* current(input);
      const bundle = yield* evidence.read(ux.operationsDigest);
      if (
        stableStringify(bundle.evidence) !== stableStringify(ux) ||
        bundle.artifacts.length === 0 ||
        bundle.artifacts.length > 20 ||
        bundle.artifacts.length !== ux.screenshots.length
      )
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "Only the sealed native browser screenshot bundle may be published.",
        });
      const source = yield* publication.read(destination.reservationId);
      const remote = source.reservation.destination;
      if (
        remote.kind !== "github" ||
        remote.host !== destination.host ||
        `${remote.owner}/${remote.repository}` !== destination.repository ||
        source.reservation.assignmentId !== assignment.id ||
        source.reservation.sourceId !== revision.startingSourceId ||
        source.reservation.epoch !== revision.grantEpoch ||
        source.prepared.publishedSourceDigest !== revision.candidateDigest ||
        source.prepared.commitOid !== destination.headSha
      )
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "The evidence destination must match the qualified candidate destination.",
        });
      let total = 0;
      const files = yield* Effect.forEach(bundle.artifacts, (artifact, index) =>
        Effect.gen(function* () {
          const bytes = yield* fs.readFile(artifact.path);
          total += bytes.length;
          if (
            bytes.length < 8 ||
            bytes.length > 10 * 1024 * 1024 ||
            total > 60 * 1024 * 1024 ||
            !Buffer.from(bytes.subarray(0, 8)).equals(
              Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            ) ||
            (yield* digest("SHA-256", bytes)) !== artifact.digest
          )
            return yield* new FactoryError({
              code: "invalid-state",
              detail: "A sealed screenshot is not an intact supported PNG.",
            });
          return {
            name: `${String(index).padStart(3, "0")}-${artifact.digest}.png`,
            digest: artifact.digest,
            blobOid: yield* gitHash("blob", bytes),
            label: artifact.label,
            content: Buffer.from(bytes).toString("base64"),
          };
        }),
      );
      const treeOid = yield* gitHash(
        "tree",
        Buffer.concat(
          files.map((file) =>
            Buffer.concat([Buffer.from(`100644 ${file.name}\0`), Buffer.from(file.blobOid, "hex")]),
          ),
        ),
      );
      const target = yield* location(input, ux.operationsDigest);
      const desired = {
        assignmentId: assignment.id,
        revisionId: revision.id,
        operationsDigest: ux.operationsDigest,
        candidateDigest: ux.candidateDigest,
        grantEpoch: revision.grantEpoch,
        boundaryId: revision.boundaryId,
        sourceId: revision.startingSourceId,
        workflowRevision: revision.workflowRevision,
        host: remote.host,
        repository: destination.repository,
        credentialFingerprint: remote.credentialFingerprint,
        branch: `satellite/factory-evidence/${(yield* digest("SHA-256", Buffer.from(assignment.id))).slice(0, 32)}/${ux.operationsDigest}`,
        treeOid,
        files: files.map(({ name, digest, blobOid, label }) => ({ name, digest, blobOid, label })),
      };
      let record: typeof Reservation.Type;
      if (yield* fs.exists(target)) {
        record = yield* fs.readFileString(target).pipe(Effect.flatMap(decodeReservation));
        const { commitOid: _, referenceAttempted: __, proof: ___, ...saved } = record;
        if (stableStringify(saved) !== stableStringify(desired))
          return yield* new FactoryError({ code: "command-conflict" });
      } else {
        record = { ...desired, referenceAttempted: false };
        yield* save(input, record);
      }
      const endpoint = `repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repository)}/git`;
      const request = Effect.fn(function* (operation: string, suffix: string, body?: unknown) {
        const credential = yield* credentials.get(remote.host);
        if (
          credential.host !== remote.host ||
          credential.fingerprint !== record.credentialFingerprint
        )
          return yield* new FactoryError({
            code: "permission-denied",
            detail: "The approved screenshot publication account changed.",
          });
        if (body !== undefined) yield* current(input, record);
        const response = yield* api
          .rest({
            host: remote.host,
            operation: `FactoryPreviewPublication.${operation}`,
            path: `${endpoint}/${suffix}`,
            ...(body === undefined ? {} : { method: "POST" as const, body }),
          })
          .pipe(
            Effect.provideService(
              GitHubApi.BeforeGitHubMutation,
              body === undefined
                ? null
                : current(input, record).pipe(
                    Effect.asVoid,
                    Effect.mapError(
                      (cause) =>
                        new GitHubApi.GitHubApiRequestError({
                          host: remote.host,
                          operation,
                          cause,
                        }),
                    ),
                  ),
            ),
            Effect.provideService(GitHubApi.PinnedGitHubCredential, {
              host: credential.host,
              token: credential.token,
              credentialFingerprint: credential.fingerprint,
            }),
          );
        if (response.truncated || response.invalidUtf8)
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: "The screenshot publication response was incomplete.",
          });
        return response.body;
      });
      const refPath = `ref/heads/${record.branch}`;
      const find = request("reference", refPath).pipe(
        Effect.flatMap(decodeRef),
        Effect.catchTags({ GitHubApiNotFoundError: () => Effect.void }),
      );
      const existing = yield* find;
      if (
        existing &&
        (!record.referenceAttempted ||
          existing.ref !== `refs/heads/${record.branch}` ||
          existing.object.type !== "commit" ||
          existing.object.sha !== record.commitOid)
      )
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "An unrelated reference already occupies the immutable evidence destination.",
        });
      const message = `Satellite preview evidence ${assignment.id}\n${revision.id}\n${ux.operationsDigest}\n`;
      if (!record.commitOid) {
        for (const file of files) {
          const blob = yield* request("blob", "blobs", {
            content: file.content,
            encoding: "base64",
          }).pipe(Effect.flatMap(decodeObject));
          if (blob.sha !== file.blobOid)
            return yield* new FactoryError({
              code: "invalid-state",
              detail: "The uploaded screenshot blob differs from its sealed bytes.",
            });
        }
        const tree = yield* request("tree", "trees", {
          tree: files.map((file) => ({
            path: file.name,
            mode: "100644",
            type: "blob",
            sha: file.blobOid,
          })),
        }).pipe(Effect.flatMap(decodeObject));
        if (tree.sha !== treeOid)
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "The uploaded evidence tree differs from the sealed PNG manifest.",
          });
        const author = {
          name: source.reservation.author.name,
          email: source.reservation.author.email,
          date: revision.createdAt,
        };
        const committed = yield* request("commit", "commits", {
          message,
          tree: treeOid,
          parents: [],
          author,
          committer: author,
        }).pipe(Effect.flatMap(decodeObject));
        if (!/^[a-f0-9]{40}$/.test(committed.sha))
          return yield* new FactoryError({ code: "invalid-state" });
        record = { ...record, commitOid: committed.sha };
        yield* save(input, record);
      }
      const commit = yield* request("verify-commit", `commits/${record.commitOid}`).pipe(
        Effect.flatMap(decodeCommit),
      );
      const tree = yield* request("verify-tree", `trees/${treeOid}`).pipe(
        Effect.flatMap(decodeTree),
      );
      if (
        commit.sha !== record.commitOid ||
        commit.tree.sha !== treeOid ||
        commit.parents.length !== 0 ||
        commit.message.trimEnd() !== message.trimEnd() ||
        tree.sha !== treeOid ||
        tree.truncated ||
        stableStringify(tree.tree) !==
          stableStringify(
            files.map((file) => ({
              path: file.name,
              mode: "100644",
              type: "blob",
              sha: file.blobOid,
            })),
          )
      )
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "The remote evidence commit does not contain the exact sealed screenshot tree.",
        });
      if (!existing) {
        record = { ...record, referenceAttempted: true };
        yield* save(input, record);
        yield* request("create-reference", "refs", {
          ref: `refs/heads/${record.branch}`,
          sha: record.commitOid,
        }).pipe(Effect.result);
      }
      const observed = yield* find;
      if (
        !observed ||
        observed.ref !== `refs/heads/${record.branch}` ||
        observed.object.type !== "commit" ||
        observed.object.sha !== record.commitOid
      )
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail:
            "The immutable evidence reference is not confirmed. Its reservation is retained for reconciliation.",
        });
      yield* current(input, record);
      const proof = FactoryPublishedPreview.make({
        operationsDigest: ux.operationsDigest,
        commitOid: record.commitOid!,
        urls: files.map((file) => {
          const linkUrl = `https://${remote.host}/${destination.repository}/blob/${record.commitOid}/${file.name}`;
          return {
            digest: file.digest,
            label: file.label,
            imageUrl: `${linkUrl}?raw=true`,
            linkUrl,
          };
        }),
      });
      yield* save(input, { ...record, proof });
      return proof;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const read = Effect.fn("FactoryPreviewPublication.read")(function* (input: typeof Input.Type) {
    const state = yield* store.snapshot;
    const operationsDigest = state.assignments
      .find((entry) => entry.id === input.assignmentId)
      ?.delivery?.revisions.find((entry) => entry.id === input.revisionId)
      ?.uxEvidence?.operationsDigest;
    if (!operationsDigest) return undefined;
    const target = yield* location(input, operationsDigest);
    if (!(yield* fs.exists(target))) return undefined;
    return (yield* fs.readFileString(target).pipe(Effect.flatMap(decodeReservation))).proof;
  }, Effect.mapError(preserve));
  return FactoryPreviewPublication.of({ publish, read });
});

export const layer = Layer.effect(FactoryPreviewPublication, make);
