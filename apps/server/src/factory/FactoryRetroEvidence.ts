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

import * as ServerConfig from "../config.ts";

const DocumentName = Schema.Literals(["assignment.json", "team.json", "feedback.json"]);
const Manifest = Schema.Struct({
  retroId: Schema.String,
  conclusionId: Schema.String,
  assignmentId: FactoryAssignmentId,
  files: Schema.Array(Schema.Struct({ path: DocumentName, sha256: Schema.String })),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "persistence", cause });

/**
 * The frozen evidence a retrospective reviews. The evidence digest is the hash of a manifest
 * naming each document's hash, so it identifies exactly the documents the retro may read.
 */
export class FactoryRetroEvidence extends Context.Service<
  FactoryRetroEvidence,
  {
    /**
     * Writes the assignment, team and feedback documents with their manifest. Sealing identical
     * documents again verifies the existing copy and returns the same digest.
     */
    readonly seal: (input: {
      readonly retroId: string;
      readonly conclusionId: string;
      readonly assignmentId: FactoryAssignmentId;
      readonly documents: ReadonlyArray<{
        readonly name: typeof DocumentName.Type;
        readonly content: string;
      }>;
    }) => Effect.Effect<{ readonly evidenceDigest: string }, FactoryError>;
    /** Locates sealed evidence after checking every file against the digest; any change fails. */
    readonly read: (input: {
      readonly retroId: string;
      readonly conclusionId: string;
      readonly evidenceDigest: string;
    }) => Effect.Effect<
      { readonly directory: string; readonly manifestPath: string },
      FactoryError
    >;
  }
>()("t3/factory/FactoryRetroEvidence") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const mutex = yield* Semaphore.make(1);
  const hash = (content: string) =>
    crypto
      .digest("SHA-256", Buffer.from(content))
      .pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
  const directoryFor = Effect.fn(function* (retroId: string, digest: string) {
    if (!/^[a-f0-9]{64}$/.test(digest)) return yield* new FactoryError({ code: "invalid-state" });
    return path.join(
      config.stateDir,
      "factory",
      "retros",
      yield* hash(retroId),
      "evidence",
      digest,
    );
  });
  const read = Effect.fn("FactoryRetroEvidence.read")(function* (
    input: Parameters<FactoryRetroEvidence["Service"]["read"]>[0],
  ) {
    const directory = yield* directoryFor(input.retroId, input.evidenceDigest);
    const manifestPath = path.join(directory, "manifest.json");
    const bytes = yield* fs.readFileString(manifestPath);
    if ((yield* hash(bytes)) !== input.evidenceDigest)
      return yield* new FactoryError({ code: "invalid-state" });
    const manifest = yield* decodeManifest(bytes);
    if (manifest.retroId !== input.retroId || manifest.conclusionId !== input.conclusionId)
      return yield* new FactoryError({ code: "invalid-state" });
    for (const file of manifest.files) {
      const content = yield* fs.readFileString(path.join(directory, file.path));
      if ((yield* hash(content)) !== file.sha256)
        return yield* new FactoryError({ code: "invalid-state" });
    }
    return { directory, manifestPath };
  }, Effect.mapError(failure));
  return FactoryRetroEvidence.of({
    read,
    seal: (input) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const names = new Set(input.documents.map((document) => document.name));
          if (
            names.size !== input.documents.length ||
            names.size !== 3 ||
            input.documents.reduce(
              (sum, document) => sum + Buffer.byteLength(document.content),
              0,
            ) >
              16 * 1024 * 1024
          )
            return yield* new FactoryError({ code: "invalid-state" });
          const documents = [...input.documents].sort((a, b) => a.name.localeCompare(b.name));
          const files = yield* Effect.forEach(documents, (document) =>
            hash(document.content).pipe(Effect.map((sha256) => ({ path: document.name, sha256 }))),
          );
          const manifest = stableStringify({
            retroId: input.retroId,
            conclusionId: input.conclusionId,
            assignmentId: input.assignmentId,
            files,
          });
          const evidenceDigest = yield* hash(manifest);
          const directory = yield* directoryFor(input.retroId, evidenceDigest);
          const manifestPath = path.join(directory, "manifest.json");
          if (yield* fs.exists(manifestPath)) {
            yield* read({ ...input, evidenceDigest });
            return { evidenceDigest };
          }
          // The manifest is written last and exclusively, so it marks a complete seal. Documents
          // left by an interrupted seal are simply overwritten.
          yield* fs.makeDirectory(directory, { recursive: true });
          for (const document of documents)
            yield* fs.writeFileString(path.join(directory, document.name), document.content);
          yield* fs.writeFileString(manifestPath, manifest, { flag: "wx" });
          return { evidenceDigest };
        }).pipe(Effect.mapError(failure)),
      ),
  });
});

export const layer = Layer.effect(FactoryRetroEvidence, make);
