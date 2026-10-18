import type { RevdocItemDetail, RevdocPass, RevdocReviewHeader } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const EXPORT_FORMAT = "satellite.revdoc.review/2";

export interface ExportSnapshot {
  readonly review: RevdocReviewHeader;
  readonly items: ReadonlyArray<RevdocItemDetail>;
  readonly activePass: RevdocPass | null;
}

/** The file agents and tools without MCP access read. Revdoc never takes data from it. */
const exportDocument = (snapshot: ExportSnapshot) => ({
  format: EXPORT_FORMAT,
  revision: snapshot.review.revision,
  title: snapshot.review.title,
  summary: snapshot.review.summary,
  context: snapshot.review.context,
  partial: snapshot.review.partial,
  updatedAt: snapshot.review.updatedAt,
  activePass: snapshot.activePass
    ? {
        id: snapshot.activePass.id,
        kind: snapshot.activePass.kind,
        startedAt: snapshot.activePass.startedAt,
      }
    : null,
  items: snapshot.items
    .filter((item) => !item.dismissed)
    .map((item) => ({
      id: item.id,
      area: item.area,
      check: item.check,
      expected: item.expected,
      coveredPaths: item.coveredPaths,
      outcome: item.outcome,
      note: item.note,
      needsRetest: item.retest,
      stale: item.stale,
      result: item.result
        ? {
            state: item.result.state,
            method: item.result.method,
            observed: item.result.observed,
            recordedAt: item.result.recordedAt,
            evidence: item.result.evidence.map((evidence) => evidence.path),
          }
        : null,
    })),
});

const exportFile = (snapshot: ExportSnapshot) =>
  `${JSON.stringify(exportDocument(snapshot), null, 2)}\n`;

const isExportFile = (text: string) => text.includes(`"format": "${EXPORT_FORMAT}"`);

export class RevdocExport extends Context.Service<
  RevdocExport,
  {
    /**
     * Writes `.revdoc/review.json` atomically and ensures `.revdoc/.gitignore`. Serialised per
     * Review; a write older than one already on disk is skipped. Fails with a readable reason.
     */
    readonly write: (snapshot: ExportSnapshot) => Effect.Effect<void, string>;
    /** Removes the export and the evidence screenshots of a deleted Review. */
    readonly remove: (worktreePath: string) => Effect.Effect<void>;
    /** Saves a screenshot under `.revdoc/evidence` and returns its worktree-relative path. */
    readonly writeEvidence: (
      worktreePath: string,
      id: string,
      png: Uint8Array,
    ) => Effect.Effect<string, string>;
  }
>()("t3/revdoc/RevdocExport") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = new Map<string, Semaphore.Semaphore>();
  const written = new Map<string, number>();
  const lockFor = (reviewId: string) => {
    let lock = locks.get(reviewId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(reviewId, lock);
    }
    return lock;
  };

  /**
   * `.revdoc` inside a worktree that still exists, created if missing. Never creates the worktree
   * itself (a removed worktree must stay removed) and never follows `.revdoc` or a folder under it
   * out of the worktree.
   */
  const revdocFolder = Effect.fn("RevdocExport.revdocFolder")(function* (
    worktreePath: string,
    ...subfolders: ReadonlyArray<string>
  ) {
    if (!(yield* fs.exists(worktreePath))) return null;
    const root = yield* fs.realPath(worktreePath);
    let folder = path.join(worktreePath, ".revdoc");
    let expected = path.join(root, ".revdoc");
    for (const name of ["", ...subfolders]) {
      if (name !== "") {
        folder = path.join(folder, name);
        expected = path.join(expected, name);
      }
      yield* fs.makeDirectory(folder, { recursive: false }).pipe(Effect.ignore);
      if ((yield* fs.realPath(folder)) !== expected) return yield* Effect.fail("symbolic link");
    }
    return folder;
  });

  const writeNow = Effect.fn("RevdocExport.writeNow")(function* (snapshot: ExportSnapshot) {
    const { review } = snapshot;
    if ((written.get(review.id) ?? 0) > review.revision) return;
    const directory = yield* revdocFolder(review.worktreePath);
    if (directory === null) return;
    const file = path.join(directory, "review.json");
    const gitignore = path.join(directory, ".gitignore");
    if (!(yield* fs.exists(gitignore))) yield* fs.writeFileString(gitignore, "*\n");
    if (!written.has(review.id) && (yield* fs.exists(file))) {
      // A file without this export's format marker is a Satellite 1.x review. Keep it aside once.
      if (!isExportFile(yield* fs.readFileString(file))) {
        const aside = path.join(directory, "review.v1.json");
        if (!(yield* fs.exists(aside))) yield* fs.rename(file, aside);
      }
      yield* fs.remove(path.join(directory, "generation.json"), { force: true });
    }
    const temporary = `${file}.${review.revision}.tmp`;
    yield* fs.writeFileString(temporary, exportFile(snapshot));
    yield* fs.rename(temporary, file);
    written.set(review.id, review.revision);
  });

  return RevdocExport.of({
    write: (snapshot) =>
      Semaphore.withPermit(lockFor(snapshot.review.id), writeNow(snapshot)).pipe(
        Effect.mapError(() => "Revdoc could not write .revdoc/review.json in this worktree."),
      ),
    remove: (worktreePath) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(path.join(worktreePath, ".revdoc")))) return;
        const directory = yield* revdocFolder(worktreePath);
        if (directory === null) return;
        yield* fs.remove(path.join(directory, "review.json"), { force: true });
        const evidence = path.join(directory, "evidence");
        if (!(yield* fs.exists(evidence))) return;
        if ((yield* fs.realPath(evidence)) !== path.join(yield* fs.realPath(directory), "evidence"))
          return;
        yield* fs.remove(evidence, { recursive: true, force: true });
      }).pipe(Effect.ignore),
    writeEvidence: (worktreePath, id, png) =>
      Effect.gen(function* () {
        const folder = yield* revdocFolder(worktreePath, "evidence");
        if (folder === null) return yield* Effect.fail("missing worktree");
        yield* fs.writeFile(path.join(folder, `${id}.png`), png);
        return `.revdoc/evidence/${id}.png`;
      }).pipe(Effect.mapError(() => "Revdoc could not save the screenshot.")),
  });
});

export const layer = Layer.effect(RevdocExport, make);
