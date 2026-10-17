import type {
  OpenWorkFile,
  OpenWorkFileStatus,
  OpenWorkWip,
  OpenWorkWipFile,
  OpenWorkWipLayer,
} from "@t3tools/contracts";

/** Precedes every commit in Open work's `git log` format, so records split without parsing paths. */
export const LOG_RECORD_MARKER = "t3-commit";
export const LOG_FORMAT = `--format=%x00${LOG_RECORD_MARKER}%x00%H%x00%P%x00%s%x00%cI%x00`;

const RAW_RECORD = /^:[0-7]{6} [0-7]{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])[0-9]*$/;
const NUMSTAT_RECORD = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;
// The lookahead pins the marker to a real record start: a hash, parents, a subject, and a date.
const LOG_RECORD_SPLIT = new RegExp(
  `\\0${LOG_RECORD_MARKER}\\0(?=[0-9a-f]{40,64}\\0[0-9a-f ]*\\0[^\\0]*\\0\\d{4}-\\d{2}-\\d{2}T[^\\0]*\\0)`,
);

const STATUS_BY_CODE: Partial<Record<string, OpenWorkFileStatus>> = {
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
};

/**
 * Files from `git diff` or `git log` run with `--raw --numstat -z`. Raw records carry each change
 * type; numstat records carry line counts for the same files. Binary files count zero lines.
 */
export function parseDiffRecords(fields: ReadonlyArray<string>): OpenWorkFile[] {
  const files: OpenWorkFile[] = [];
  const counts = new Map<string, { insertions: number; deletions: number }>();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    const raw = RAW_RECORD.exec(field.trimStart());
    if (raw) {
      const code = raw[1]!;
      const pairs = code === "R" || code === "C";
      const first = fields[++index] ?? "";
      const path = pairs ? (fields[++index] ?? "") : first;
      files.push({
        path,
        previousPath: pairs ? first : null,
        status: STATUS_BY_CODE[code] ?? "modified",
        insertions: 0,
        deletions: 0,
      });
      continue;
    }
    const numstat = NUMSTAT_RECORD.exec(field);
    if (!numstat) continue;
    // A rename's numstat leaves its own path empty and names both paths in the next two fields.
    const path = numstat[3] === "" ? ((index += 2), fields[index] ?? "") : numstat[3]!;
    counts.set(path, {
      insertions: numstat[1] === "-" ? 0 : Number(numstat[1]),
      deletions: numstat[2] === "-" ? 0 : Number(numstat[2]),
    });
  }
  return files.map((file) => ({ ...file, ...counts.get(file.path) }));
}

export interface LogRecord {
  readonly sha: string;
  readonly parents: string[];
  readonly subject: string;
  readonly committedAt: string;
  readonly files: OpenWorkFile[];
}

/** Commits from `git log` with `LOG_FORMAT`, `--raw --numstat -z`, in the order git printed them. */
export function parseLogRecords(stdout: string): LogRecord[] {
  return stdout
    .split(LOG_RECORD_SPLIT)
    .slice(1)
    .map((record) => {
      const fields = record.split("\0");
      return {
        sha: fields[0]!,
        parents: fields[1]!.split(" ").filter(Boolean),
        subject: fields[2]!,
        committedAt: fields[3]!,
        files: parseDiffRecords(fields.slice(4)),
      };
    });
}

export interface PorcelainStatus {
  /** Null before the first commit. */
  readonly head: string | null;
  /** Null for a detached HEAD. */
  readonly branch: string | null;
  readonly changeCount: number;
  readonly untracked: string[];
}

/** `git status --porcelain=v2 --branch -z`. */
export function parsePorcelainStatus(stdout: string): PorcelainStatus {
  const fields = stdout.split("\0");
  let head: string | null = null;
  let branch: string | null = null;
  let changeCount = 0;
  const untracked: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.startsWith("# branch.oid ")) {
      const oid = field.slice("# branch.oid ".length);
      head = oid === "(initial)" ? null : oid;
    } else if (field.startsWith("# branch.head ")) {
      const name = field.slice("# branch.head ".length);
      branch = name === "(detached)" ? null : name;
    } else if (field.startsWith("? ")) {
      changeCount++;
      untracked.push(field.slice(2));
    } else if (field.startsWith("1 ") || field.startsWith("u ")) {
      changeCount++;
    } else if (field.startsWith("2 ")) {
      changeCount++;
      // A rename or copy names its original path in the next field.
      index++;
    }
  }
  return { head, branch, changeCount, untracked };
}

/** Candidates for main, best first. Also the patterns Open work passes to `git for-each-ref`. */
export const BASE_REF_CANDIDATES = [
  "refs/remotes/origin/main",
  "refs/heads/main",
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/master",
  "refs/heads/master",
] as const;
export const BASE_REF_FORMAT = "--format=%(refname)%00%(symref)";

export interface BaseRef {
  /** The full ref git commands use. */
  readonly ref: string;
  /** The short name people read, such as `origin/main`. */
  readonly name: string;
}

const shortRefName = (ref: string) => ref.replace(/^refs\/(?:heads|remotes)\//, "");

/** The best existing candidate from `git for-each-ref BASE_REF_FORMAT ...BASE_REF_CANDIDATES`. */
export function selectBaseRef(stdout: string): BaseRef | null {
  const symrefs = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [ref, symref] = line.split("\0");
    if (ref) symrefs.set(ref, symref ?? "");
  }
  for (const candidate of BASE_REF_CANDIDATES) {
    if (!symrefs.has(candidate)) continue;
    // origin/HEAD stands for the branch it points at. Git skips a dangling one.
    const ref = candidate === "refs/remotes/origin/HEAD" ? symrefs.get(candidate) : candidate;
    if (ref) return { ref, name: shortRefName(ref) };
  }
  return null;
}

const LAYER_ORDER: Record<OpenWorkWipLayer, number> = { staged: 0, unstaged: 1, untracked: 2 };

/**
 * The WIP step: staged and unstaged files from their diffs, untracked files from status with zero
 * counts. Sorted by path, then layer, and capped at `maxFiles`. Totals cover every file.
 */
export function groupWip(
  layers: {
    readonly staged: ReadonlyArray<OpenWorkFile>;
    readonly unstaged: ReadonlyArray<OpenWorkFile>;
    readonly untracked: ReadonlyArray<string>;
  },
  maxFiles: number,
): OpenWorkWip {
  const files: OpenWorkWipFile[] = [
    ...layers.staged.map((file) => ({ ...file, layer: "staged" as const })),
    ...layers.unstaged.map((file) => ({ ...file, layer: "unstaged" as const })),
    ...layers.untracked.map((path) => ({
      path,
      previousPath: null,
      status: "added" as const,
      insertions: 0,
      deletions: 0,
      layer: "untracked" as const,
    })),
  ].toSorted((left, right) =>
    left.path === right.path
      ? LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
      : left.path < right.path
        ? -1
        : 1,
  );
  return {
    files: files.slice(0, maxFiles),
    insertions: files.reduce((sum, file) => sum + file.insertions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    truncated: files.length > maxFiles,
  };
}
