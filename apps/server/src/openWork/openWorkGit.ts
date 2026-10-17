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
      const first = fields[++index];
      const path = pairs ? fields[++index] : first;
      // Output cut at a size limit can end between a record and its paths.
      if (first === undefined || path === undefined) break;
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
  readonly fileCount: number;
  readonly insertions: number;
  readonly deletions: number;
}

const shortstatCount = (text: string, pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);

/** Commits from `git log` with `LOG_FORMAT` and `--shortstat`, in the order git printed them. */
export function parseLogRecords(stdout: string): LogRecord[] {
  return stdout
    .split(LOG_RECORD_SPLIT)
    .slice(1)
    .map((record) => {
      const [sha = "", parents = "", subject = "", committedAt = "", ...rest] = record.split("\0");
      const shortstat = rest.join(" ");
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        subject,
        committedAt,
        fileCount: shortstatCount(shortstat, /(\d+) files? changed/),
        insertions: shortstatCount(shortstat, /(\d+) insertions?\(\+\)/),
        deletions: shortstatCount(shortstat, /(\d+) deletions?\(-\)/),
      };
    });
}

/**
 * Splits `-z` output into fields. Output cut at a size limit ends in a partial field and git's
 * truncation marker, so everything after the last separator is dropped.
 */
export function completeFields(stdout: string, truncated: boolean): string[] {
  return (truncated ? stdout.slice(0, Math.max(0, stdout.lastIndexOf("\0"))) : stdout).split("\0");
}

/** A comparable form of a path. Windows paths compare without regard to case or separators. */
export function pathKey(value: string, platform: string): string {
  const trimmed = value.length > 1 ? value.replace(/[\\/]+$/, "") : value;
  return platform === "win32" ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
}

export interface WorktreeRecord {
  readonly path: string;
  /** Null before the first commit. */
  readonly head: string | null;
  /** Null for a detached HEAD. */
  readonly branch: string | null;
}

/**
 * Worktrees from `git worktree list --porcelain -z`, in git's order with the primary checkout
 * first. Bare and prunable entries are left out, so the primary is index 0 only when it exists.
 */
export function parseWorktreeList(stdout: string): Array<WorktreeRecord & { primary: boolean }> {
  return stdout
    .split("\0\0")
    .map((record) => record.split("\0"))
    .flatMap((fields, index) => {
      const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
      if (
        path === undefined ||
        fields.some((field) => field === "bare" || field.startsWith("prunable"))
      ) {
        return [];
      }
      const head = fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length);
      const branch = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length);
      return [
        {
          path,
          head: head && !/^0+$/.test(head) ? head : null,
          branch: branch ? branch.replace(/^refs\/heads\//, "") : null,
          primary: index === 0,
        },
      ];
    });
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

const byPathThenLayer = (left: OpenWorkWipFile, right: OpenWorkWipFile) =>
  left.path === right.path
    ? LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
    : left.path < right.path
      ? -1
      : 1;

/**
 * The WIP step, at most `maxFiles` rows: staged then unstaged files from their diffs fill it first,
 * untracked files with zero counts take what room is left. Sorted by path, then layer. Totals
 * cover every tracked change read, listed or not.
 */
export function groupWip(
  layers: {
    readonly staged: ReadonlyArray<OpenWorkFile>;
    readonly unstaged: ReadonlyArray<OpenWorkFile>;
    readonly untracked: ReadonlyArray<string>;
    /** Git stopped reading the staged or unstaged diff at its output limit. */
    readonly trackedCut: boolean;
    /** Git stopped reading the untracked listing at its output limit. */
    readonly untrackedCut: boolean;
  },
  maxFiles: number,
): OpenWorkWip {
  const tracked: OpenWorkWipFile[] = [
    ...layers.staged.map((file) => ({ ...file, layer: "staged" as const })),
    ...layers.unstaged.map((file) => ({ ...file, layer: "unstaged" as const })),
  ];
  const listedTracked = tracked.slice(0, maxFiles);
  const room = maxFiles - listedTracked.length;
  const untracked = layers.untracked.slice(0, room).map((path) => ({
    path,
    previousPath: null,
    status: "added" as const,
    insertions: 0,
    deletions: 0,
    layer: "untracked" as const,
  }));
  return {
    files: [...listedTracked, ...untracked].toSorted(byPathThenLayer),
    insertions: tracked.reduce((sum, file) => sum + file.insertions, 0),
    deletions: tracked.reduce((sum, file) => sum + file.deletions, 0),
    trackedTruncated: layers.trackedCut || tracked.length > maxFiles,
    untrackedTruncated: layers.untrackedCut || layers.untracked.length > room,
  };
}
