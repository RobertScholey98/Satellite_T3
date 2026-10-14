// @effect-diagnostics nodeBuiltinImport:off - a read-only git report with no services to provide.
/**
 * Reports how much of upstream Satellite edits: the upstream files it modifies, how many of those
 * `rebrand.ts` reproduces from upstream's version, and the lines Satellite adds and removes in the
 * files where it registers its features. Measured against the merge-base with upstream, so
 * upstream's own later changes don't count.
 *
 *   node scripts/fork-footprint.ts [upstream-ref]   (default: upstream/main)
 */
import * as NodeChildProcess from "node:child_process";

import { rebrandText } from "./rebrand.ts";

export const REGISTRATION_POINTS = [
  "packages/contracts/src/rpc.ts",
  "apps/server/src/ws.ts",
  "apps/server/src/server.ts",
  "apps/server/src/auth/RpcAuthorization.ts",
  "apps/server/src/observability/RpcInstrumentation.ts",
  "apps/server/src/mcp/McpHttpServer.ts",
  "packages/client-runtime/src/rpc/client.ts",
  "apps/web/src/routes/__root.tsx",
  "apps/mobile/src/Stack.tsx",
];

if (import.meta.main) {
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 }).trim();

  const upstream = process.argv[2] ?? "upstream/main";
  const base = git("merge-base", "HEAD", upstream);
  const modified = git("diff", "--name-only", "--diff-filter=M", base, "HEAD").split("\n");
  const rebrandOnly = modified.filter(
    (file) => rebrandText(git("show", `${base}:${file}`)) === git("show", `HEAD:${file}`),
  );
  process.stdout.write(`merge-base ${base.slice(0, 10)}\n`);
  process.stdout.write(`upstream files modified: ${modified.length}\n`);
  process.stdout.write(`  reproduced by rebrand.ts: ${rebrandOnly.length}\n`);
  for (const file of REGISTRATION_POINTS) {
    const [added = "0", removed = "0"] = git("diff", "--numstat", base, "HEAD", "--", file).split(
      "\t",
    );
    process.stdout.write(`+${added} -${removed}\t${file}\n`);
  }
}
