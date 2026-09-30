import type { ReviewDiffFileStat, OpenWorkFile } from "@t3tools/contracts";

// -z preserves tabs/newlines in paths and gives renames two separate path fields.
export function parseReviewNumstat(stdout: string): ReviewDiffFileStat[] {
  const fields = stdout.split("\0");
  const files: ReviewDiffFileStat[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    const raw = /^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ ([A-Z])[0-9]*$/.exec(field.trimStart());
    if (raw) {
      index += raw[1] === "R" || raw[1] === "C" ? 2 : 1;
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
    if (!match) continue;
    const previousPath = match[3] === "" ? fields[++index]! : null;
    const path = previousPath !== null ? fields[++index]! : match[3]!;
    files.push({
      path,
      previousPath,
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return files;
}

// Raw records carry change types; numstat records carry counts for the same comparison.
export function parseOpenWorkDiff(stdout: string): OpenWorkFile[] {
  const fields = stdout.split("\0");
  const statuses = new Map<string, OpenWorkFile["status"]>();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!.trimStart();
    const raw = /^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ ([A-Z])[0-9]*$/.exec(field);
    if (!raw) {
      if (/^(\d+|-)\t(\d+|-)\t$/.test(fields[index]!)) index += 2;
      continue;
    }
    const code = raw[1];
    const oldPath = fields[++index]!;
    const filePath = code === "R" || code === "C" ? fields[++index]! : oldPath;
    statuses.set(
      filePath,
      code === "A"
        ? "added"
        : code === "D"
          ? "deleted"
          : code === "R"
            ? "renamed"
            : code === "C"
              ? "copied"
              : code === "U"
                ? "conflicted"
                : "modified",
    );
  }
  return parseReviewNumstat(stdout).map(({ path, previousPath, additions, deletions }) => ({
    path,
    previousPath,
    status: statuses.get(path) ?? "modified",
    insertions: additions,
    deletions,
  }));
}
