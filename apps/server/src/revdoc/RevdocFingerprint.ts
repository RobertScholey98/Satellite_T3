// @effect-diagnostics nodeBuiltinImport:off - Synchronous sha256 keeps the fingerprints pure.
import * as NodeCrypto from "node:crypto";

import type { RevdocRetest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface FingerprintBasis {
  readonly check: string;
  readonly code: string;
}

const MISSING = "missing";

export const sha256 = (text: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

export const jsonText = (value: unknown) => JSON.stringify(value);
export const jsonBytes = (value: unknown) => Buffer.byteLength(jsonText(value));

const normalise = (text: string) => text.trim().replace(/\s+/g, " ");

/** Changes only when the behaviour under test is reworded, not on whitespace. */
export const checkFingerprint = (check: string, expected: string) =>
  sha256(`${normalise(check)}\0${normalise(expected)}`).slice(0, 24);

/** Combines per-path content hashes. A path with no hash (deleted or unreadable) counts as missing. */
export const codeFingerprint = (
  coveredPaths: ReadonlyArray<string>,
  contentHashes: ReadonlyMap<string, string>,
) =>
  sha256(
    coveredPaths
      .toSorted()
      .map((path) => `${path}\0${contentHashes.get(path) ?? MISSING}`)
      .join("\n"),
  ).slice(0, 24);

/**
 * Needs retest: the person's outcome (or, with no outcome, the latest result) was recorded against
 * a check or code fingerprint that is no longer current. Setting a new outcome clears it. Derived
 * on read; outcomes and notes are never touched.
 */
export const deriveRetest = (item: {
  readonly outcome: string;
  readonly outcomeBasis: FingerprintBasis | null;
  readonly result: { readonly basis: FingerprintBasis } | null;
  readonly checkFingerprint: string;
  readonly codeFingerprint: string;
}): RevdocRetest | null => {
  const basis = item.outcome === "not_checked" ? (item.result?.basis ?? null) : item.outcomeBasis;
  if (basis === null) return null;
  const check = basis.check !== item.checkFingerprint;
  const code = basis.code !== item.codeFingerprint;
  return check && code ? "both" : check ? "check" : code ? "code" : null;
};

/**
 * Current content hashes of worktree-relative paths. Paths that are missing, unreadable, or
 * resolve outside the worktree are left out and fingerprint as missing.
 */
export const readContentHashes = Effect.fn("RevdocFingerprint.readContentHashes")(function* (
  worktreePath: string,
  paths: Iterable<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(worktreePath).pipe(Effect.orElseSucceed(() => worktreePath));
  const hashes = new Map<string, string>();
  for (const relative of new Set(paths)) {
    const real = yield* fs
      .realPath(path.join(root, relative))
      .pipe(Effect.orElseSucceed(() => null));
    if (real === null) continue;
    const inside = path.relative(root, real);
    if (inside.startsWith("..") || path.isAbsolute(inside)) continue;
    const bytes = yield* fs.readFile(real).pipe(Effect.orElseSucceed(() => null));
    if (bytes !== null) hashes.set(relative, sha256(bytes));
  }
  return hashes;
});
