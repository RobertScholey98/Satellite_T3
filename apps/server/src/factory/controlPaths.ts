/** A repository-relative path with forward slashes and no leading `./` or `/`. */
export const normaliseControlPath = (value: string) =>
  value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");

const globSource = (glob: string) => {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      // `a/**/b` also matches `a/b`.
      if (glob[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return source;
};

/**
 * Matches repository-relative paths against the manager's control paths. `**` crosses segments,
 * `*` and `?` stay within one, a trailing `/` covers the directory and everything under it, and a
 * pattern with no `/` matches that name at any depth, so `AGENTS.md` protects every AGENTS.md.
 */
export const controlPathMatcher = (patterns: ReadonlyArray<string>) => {
  const expressions = patterns.flatMap((raw) => {
    const pattern = normaliseControlPath(raw);
    const body = pattern.replace(/\/+$/, "");
    if (body === "") return [];
    const anchor = body.includes("/") ? "^" : "^(?:.*/)?";
    const under = pattern.endsWith("/") ? "(?:/.*)?" : "";
    return [new RegExp(`${anchor}${globSource(body)}${under}$`)];
  });
  return (path: string) => {
    const value = normaliseControlPath(path);
    return expressions.some((expression) => expression.test(value));
  };
};
