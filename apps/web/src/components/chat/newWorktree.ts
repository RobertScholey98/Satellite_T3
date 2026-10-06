/** Resolve one child folder using the environment's path style, not the browser's OS. */
export function projectWorktreePath(workspaceRoot: string, folder: string): string | null {
  const name = folder.trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[<>:"/\\|?*\p{Cc}]/u.test(name) ||
    /[. ]$/.test(name) ||
    /^\.git$/i.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    return null;
  }
  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  return `${workspaceRoot.replace(/[/\\]+$/, "")}${separator}${name}`;
}
