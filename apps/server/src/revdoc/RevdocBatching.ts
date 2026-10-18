import { sha256 } from "./RevdocFingerprint.ts";
import { type CompactItem, generationPrompt } from "./RevdocGeneration.ts";
import type { Upsert } from "./RevdocStore.ts";

const MAX_BATCH_CHANGES_BYTES = 90_000;
export const MAX_PROMPT_BYTES = 450_000;
const MAX_ITEMS_CONTEXT_BYTES = 90_000;
const MAX_CONVERSATION_CONTEXT_BYTES = 60_000;
const MAX_FILE_PART_BYTES = 80_000;
const MAX_HUNK_PART_BYTES = 60_000;
const MAX_COMBINE_GROUP_BYTES = 60_000;
const EXCERPT_BYTES = 80_000;

const bytes = (value: string) => Buffer.byteLength(value);
const encodedBytes = (value: unknown) => bytes(JSON.stringify(value));

/** Splits text into parts of at most `maxBytes` as JSON, preferring line ends, never inside a character. */
export function splitText(text: string, maxBytes: number): string[] {
  const parts: string[] = [];
  while (encodedBytes(text) > maxBytes) {
    let low = 0;
    let high = Math.min(text.length, maxBytes);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encodedBytes(text.slice(0, middle)) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    let end = low;
    const newline = text.lastIndexOf("\n", end - 1);
    if (newline >= end / 2) end = newline + 1;
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    if (end === 0) throw new Error("Revdoc text budget cannot fit one character.");
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

/** One part per file, oversized files split by hunk, with the file header on every fragment. */
function patchParts(patch: string): string[] {
  return patch
    .split(/(?=^diff --git |^Untracked file: |^Binary file: )/m)
    .filter((file) => file !== "")
    .flatMap((file) => {
      if (encodedBytes(file) <= MAX_FILE_PART_BYTES) return [file];
      const hunkStart = file.startsWith("Untracked file: ")
        ? file.indexOf("\n") + 1
        : file.search(/^@@ /m);
      const header = hunkStart >= 0 ? file.slice(0, hunkStart) : "";
      const body = hunkStart >= 0 ? file.slice(hunkStart) : file;
      if (encodedBytes(header) > 10_000) return splitText(file, MAX_FILE_PART_BYTES);
      return body.split(/(?=^@@ )/m).flatMap((hunk) => {
        const label = hunk.match(/^@@[^\n]*\n/)?.[0] ?? "";
        return splitText(hunk, MAX_HUNK_PART_BYTES).map(
          (part, index) => `${header}${index > 0 ? `${label}[continued hunk]\n` : ""}${part}`,
        );
      });
    });
}

export interface PlannedBatch {
  readonly prompt: string;
  /** Identifies the batch's evidence so a resumed pass can match saved results. */
  readonly digest: string;
}

export interface BatchPlanInput {
  readonly conversation: unknown;
  readonly overview: string;
  readonly changes: string;
  readonly items: ReadonlyArray<CompactItem>;
}

/**
 * One prompt when it fits the byte caps; otherwise batches of whole files and hunks, with
 * oversized conversation and checks carried as excerpts. Deterministic, which resume relies on.
 */
export function planBatches(input: BatchPlanInput): ReadonlyArray<PlannedBatch> {
  if (bytes(input.changes) <= MAX_BATCH_CHANGES_BYTES) {
    const prompt = generationPrompt(input);
    if (bytes(prompt) <= MAX_PROMPT_BYTES) return [{ prompt, digest: sha256(input.changes) }];
  }
  const evidence = patchParts(input.changes);
  const conversationFits = encodedBytes(input.conversation) <= MAX_CONVERSATION_CONTEXT_BYTES;
  const itemsFit = encodedBytes(input.items) <= MAX_ITEMS_CONTEXT_BYTES;
  if (!conversationFits) {
    evidence.push(
      ...splitText(JSON.stringify(input.conversation), EXCERPT_BYTES).map(
        (part) => `Conversation excerpt (may continue in another batch):\n${part}`,
      ),
    );
  }
  if (!itemsFit) {
    evidence.push(
      ...splitText(JSON.stringify(input.items), EXCERPT_BYTES).map(
        (part) => `Current checks excerpt (may continue in another batch):\n${part}`,
      ),
    );
  }
  const conversation = conversationFits
    ? input.conversation
    : { note: "The conversation is supplied in separate excerpt batches." };
  const items = itemsFit ? input.items : null;
  const prompt = (changes: string, number: number, total: number) =>
    generationPrompt({
      conversation,
      overview: input.overview,
      changes,
      items,
      batch: { number, total, overview: input.overview },
    });

  const groups: string[] = [];
  let current = "";
  for (const part of evidence) {
    const candidate = current ? `${current}\n\n${part}` : part;
    if (
      current &&
      (bytes(candidate) > MAX_BATCH_CHANGES_BYTES ||
        bytes(prompt(candidate, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) >
          MAX_PROMPT_BYTES)
    ) {
      groups.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current || groups.length === 0) groups.push(current);
  return groups.map((changes, index) => ({
    prompt: prompt(changes, index + 1, groups.length),
    digest: sha256(changes),
  }));
}

export const checkKey = (item: Upsert["items"][number]) =>
  `${item.area.trim().toLowerCase()}\0${item.check.trim().toLowerCase()}`;

/**
 * Folds one batch's upsert into the accumulated one. An id seen before is updated in place with
 * its covered paths merged; a new check matching an earlier new check by area and text is not
 * repeated.
 */
export function mergeUpserts(accumulated: Upsert | null, batch: Upsert): Upsert {
  const items = [...(accumulated?.items ?? [])];
  const slot = (item: Upsert["items"][number]) =>
    item.id !== null ? `id\0${item.id}` : `new\0${checkKey(item)}`;
  const positions = new Map(items.map((item, index) => [slot(item), index]));
  for (const item of batch.items) {
    const index = positions.get(slot(item));
    if (index === undefined) {
      positions.set(slot(item), items.length);
      items.push(item);
      continue;
    }
    const existing = items[index]!;
    items[index] = {
      ...item,
      coveredPaths: [...new Set([...existing.coveredPaths, ...item.coveredPaths])],
    };
  }
  return {
    title: accumulated?.title || batch.title,
    summary: accumulated?.summary || batch.summary,
    context: accumulated?.context || batch.context,
    items,
  };
}

/** Bounded portions of a merged upsert, kept together by area, for the combining stage. */
export function combineGroups(upsert: Upsert): ReadonlyArray<Upsert> {
  const byArea = new Map<string, Array<Upsert["items"][number]>>();
  for (const item of upsert.items) {
    const area = byArea.get(item.area);
    if (area) area.push(item);
    else byArea.set(item.area, [item]);
  }
  const empty = encodedBytes({ title: upsert.title, summary: "", context: "", items: [] });
  const groups: Array<Array<Upsert["items"][number]>> = [];
  let current: Array<Upsert["items"][number]> = [];
  let size = empty;
  for (const item of [...byArea.values()].flat()) {
    const itemBytes = encodedBytes(item) + 1;
    if (current.length > 0 && size + itemBytes > MAX_COMBINE_GROUP_BYTES) {
      groups.push(current);
      current = [];
      size = empty;
    }
    current.push(item);
    size += itemBytes;
  }
  if (current.length > 0) groups.push(current);
  return groups.map((items) => ({ title: upsert.title, summary: "", context: "", items }));
}

/**
 * Applies combined portions: the combining model may merge duplicates (by leaving one out),
 * rename areas, and reorder, but never rewrites a check's text or adds one.
 */
export function applyCombined(
  merged: Upsert,
  groups: ReadonlyArray<Upsert>,
  results: ReadonlyArray<Upsert>,
): Upsert {
  const items = groups.flatMap((group, index) => {
    const known = new Map(group.items.map((item) => [item.id, item]));
    const seen = new Set<string | null>();
    const kept = (results[index]?.items ?? []).flatMap((item) => {
      const original = item.id === null ? undefined : known.get(item.id);
      if (!original || seen.has(item.id)) return [];
      seen.add(item.id);
      return [{ ...original, area: item.area.trim() || original.area }];
    });
    // A combine reply that kept nothing is a bad reply, not a request to drop the whole portion.
    return kept.length > 0 ? kept : group.items;
  });
  const areas = new Set(items.map((item) => item.area)).size;
  return {
    ...merged,
    summary: `Review changes across ${areas} area${areas === 1 ? "" : "s"}.`,
    items,
  };
}
