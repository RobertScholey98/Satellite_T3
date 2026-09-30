import * as Effect from "effect/Effect";
import { ProcessRunner } from "../processRunner.ts";

export const resolveIdeaMain = Effect.fn("resolveIdeaMain")(function* (cwd: string) {
  const process = yield* ProcessRunner;
  const candidates: string[] = [];
  for (const remote of ["upstream", "origin"]) {
    const result = yield* process.run({
      command: "git",
      cwd,
      args: ["--no-optional-locks", "symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
      maxOutputBytes: 16_000,
      timeout: "20 seconds",
    });
    const reference = result.stdout.trim();
    const prefix = `refs/remotes/${remote}/`;
    if (result.code === 0 && reference.startsWith(prefix))
      candidates.push(`refs/heads/${reference.slice(prefix.length)}`, reference);
  }
  candidates.push("refs/heads/main", "refs/heads/master");
  for (const reference of candidates) {
    const result = yield* process.run({
      command: "git",
      cwd,
      args: ["--no-optional-locks", "rev-parse", "--verify", `${reference}^{commit}`],
      maxOutputBytes: 16_000,
      timeout: "20 seconds",
    });
    if (result.code === 0 && /^[a-f0-9]{40,64}$/.test(result.stdout.trim()))
      return result.stdout.trim();
  }
  return null;
});
