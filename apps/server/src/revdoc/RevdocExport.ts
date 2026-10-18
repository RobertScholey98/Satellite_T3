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

  const writeNow = Effect.fn("RevdocExport.writeNow")(function* (snapshot: ExportSnapshot) {
    const { review } = snapshot;
    if ((written.get(review.id) ?? 0) > review.revision) return;
    const directory = path.join(review.worktreePath, ".revdoc");
    const file = path.join(directory, "review.json");
    yield* fs.makeDirectory(directory, { recursive: true });
    const root = yield* fs.realPath(review.worktreePath);
    if ((yield* fs.realPath(directory)) !== path.join(root, ".revdoc")) {
      return yield* Effect.fail("symbolic link");
    }
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
        if (!(yield* fs.exists(worktreePath))) return;
        const directory = path.join(worktreePath, ".revdoc");
        yield* fs.remove(path.join(directory, "review.json"), { force: true });
        yield* fs.remove(path.join(directory, "evidence"), { recursive: true, force: true });
      }).pipe(Effect.ignore),
  });
});

export const layer = Layer.effect(RevdocExport, make);
