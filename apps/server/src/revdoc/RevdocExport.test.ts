// @effect-diagnostics nodeBuiltinImport:off - Inspects the export files Revdoc writes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type RevdocItemDetail, type RevdocReviewHeader } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RevdocExport from "./RevdocExport.ts";
import * as RevdocService from "./RevdocService.ts";
import {
  answering,
  awaitPass,
  layerRevdoc,
  makeRepository,
  target,
  writeFile,
} from "./testing/revdocService.test.helpers.ts";

const worktree = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "revdoc-export-"));
const read = (root: string, file: string) =>
  NodeFS.readFileSync(NodePath.join(root, ".revdoc", file), "utf8");

const header = (root: string, revision: number, id = "review-1"): RevdocReviewHeader => ({
  id,
  projectId: ProjectId.make("project-1"),
  worktreePath: root,
  revision,
  title: "Checkout",
  summary: "Payments",
  context: "",
  partial: false,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  generatedAt: null,
  refreshedAt: null,
  exportError: null,
});

const item: RevdocItemDetail = {
  id: "chk-1",
  revision: 2,
  position: 0,
  area: "Checkout",
  check: "Pay by card",
  expected: "One charge",
  coveredPaths: ["src/pay.ts"],
  outcome: "change_requested",
  note: "Show the receipt",
  noteTruncated: false,
  retest: "code",
  stale: false,
  dismissed: false,
  result: {
    passId: "pass-1",
    state: "failed",
    method: "browser",
    steps: "Clicked pay",
    observed: "Charged twice",
    model: "codex/gpt-5",
    recordedAt: "2026-10-17T01:00:00.000Z",
    evidence: [
      {
        id: "ev-1",
        caption: "Two charges",
        capturedAt: "2026-10-17T01:00:00.000Z",
        path: ".revdoc/evidence/ev-1.png",
      },
    ],
  },
};

const withExport = <A, E>(effect: Effect.Effect<A, E, RevdocExport.RevdocExport>) =>
  effect.pipe(Effect.provide(RevdocExport.layer.pipe(Layer.provideMerge(NodeServices.layer))));

describe("RevdocExport", () => {
  it.live("writes the committed snapshot and a wildcard gitignore", () => {
    const root = worktree();
    return withExport(
      Effect.gen(function* () {
        const exporter = yield* RevdocExport.RevdocExport;
        yield* exporter.write({
          review: header(root, 4),
          items: [item, { ...item, id: "chk-2", dismissed: true }],
          activePass: null,
        });
        assert.strictEqual(read(root, ".gitignore"), "*\n");
        assert.deepStrictEqual(JSON.parse(read(root, "review.json")), {
          format: "satellite.revdoc.review/2",
          revision: 4,
          title: "Checkout",
          summary: "Payments",
          context: "",
          partial: false,
          updatedAt: "2026-10-17T00:00:00.000Z",
          activePass: null,
          items: [
            {
              id: "chk-1",
              area: "Checkout",
              check: "Pay by card",
              expected: "One charge",
              coveredPaths: ["src/pay.ts"],
              outcome: "change_requested",
              note: "Show the receipt",
              needsRetest: "code",
              stale: false,
              result: {
                state: "failed",
                method: "browser",
                observed: "Charged twice",
                recordedAt: "2026-10-17T01:00:00.000Z",
                evidence: [".revdoc/evidence/ev-1.png"],
              },
            },
          ],
        });
      }),
    );
  });

  it.live("keeps the newest revision when an older write arrives late", () => {
    const root = worktree();
    return withExport(
      Effect.gen(function* () {
        const exporter = yield* RevdocExport.RevdocExport;
        yield* exporter.write({ review: header(root, 3), items: [], activePass: null });
        yield* exporter.write({ review: header(root, 2), items: [item], activePass: null });
        assert.strictEqual(JSON.parse(read(root, "review.json")).revision, 3);
      }),
    );
  });

  it.live("moves a Satellite 1.x review aside once, unopened, and drops its checkpoint", () => {
    const root = worktree();
    NodeFS.mkdirSync(NodePath.join(root, ".revdoc"));
    NodeFS.writeFileSync(NodePath.join(root, ".revdoc/review.json"), "not json from 1.x");
    NodeFS.writeFileSync(NodePath.join(root, ".revdoc/generation.json"), "{}");
    return withExport(
      Effect.gen(function* () {
        const exporter = yield* RevdocExport.RevdocExport;
        yield* exporter.write({ review: header(root, 1), items: [], activePass: null });
        assert.strictEqual(read(root, "review.v1.json"), "not json from 1.x");
        assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".revdoc/generation.json")));
        assert.strictEqual(JSON.parse(read(root, "review.json")).revision, 1);

        yield* exporter.write({ review: header(root, 1, "review-2"), items: [], activePass: null });
        assert.strictEqual(read(root, "review.v1.json"), "not json from 1.x");
      }),
    );
  });

  it.live("reports a failed write and removes the export and evidence", () => {
    const root = worktree();
    return withExport(
      Effect.gen(function* () {
        const exporter = yield* RevdocExport.RevdocExport;
        NodeFS.writeFileSync(NodePath.join(root, ".revdoc"), "a file, not a folder");
        const failure = yield* Effect.flip(
          exporter.write({ review: header(root, 1), items: [], activePass: null }),
        );
        assert.strictEqual(failure, "Revdoc could not write .revdoc/review.json in this worktree.");

        NodeFS.rmSync(NodePath.join(root, ".revdoc"));
        NodeFS.mkdirSync(NodePath.join(root, ".revdoc/evidence"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, ".revdoc/evidence/ev-1.png"), "png");
        yield* exporter.write({ review: header(root, 2), items: [], activePass: null });
        yield* exporter.remove(root);
        assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(root, ".revdoc")), [".gitignore"]);
      }),
    );
  });

  it.live("shows an export failure on the Review without failing the pass", () => {
    const root = makeRepository();
    writeFile(root, "a.ts", "a\n");
    NodeFS.writeFileSync(NodePath.join(root, ".revdoc"), "blocks the export folder");
    return Effect.gen(function* () {
      const revdoc = yield* RevdocService.RevdocService;
      const { passId } = yield* revdoc.generate(target());
      assert.strictEqual((yield* awaitPass(passId)).status, "completed");
      const read = yield* revdoc.read(target(), { attentionOnly: false });
      assert.strictEqual(read.items.length, 1);
      assert.strictEqual(
        read.review?.exportError,
        "Revdoc could not write .revdoc/review.json in this worktree.",
      );
    }).pipe(Effect.provide(layerRevdoc({ root, reviewer: { current: answering() } })));
  });

  it.live("keeps its own export after a restart and refuses a symlinked .revdoc", () => {
    const root = worktree();
    const elsewhere = worktree();
    return Effect.gen(function* () {
      yield* withExport(
        Effect.flatMap(RevdocExport.RevdocExport, (exporter) =>
          exporter.write({ review: header(root, 1), items: [], activePass: null }),
        ),
      );
      // A new exporter, as after a server restart, sees a 2.0 export at revision 1.
      yield* withExport(
        Effect.flatMap(RevdocExport.RevdocExport, (exporter) =>
          exporter.write({ review: header(root, 1, "review-2"), items: [item], activePass: null }),
        ),
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".revdoc/review.v1.json")));

      const linked = worktree();
      NodeFS.symlinkSync(elsewhere, NodePath.join(linked, ".revdoc"));
      const refused = yield* withExport(
        Effect.flip(
          Effect.flatMap(RevdocExport.RevdocExport, (exporter) =>
            exporter.write({ review: header(linked, 1), items: [], activePass: null }),
          ),
        ),
      );
      assert.strictEqual(refused, "Revdoc could not write .revdoc/review.json in this worktree.");
      assert.deepStrictEqual(NodeFS.readdirSync(elsewhere), []);
    });
  });
});
