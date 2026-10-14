import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { IssueRef } from "@t3tools/contracts";
import { makeIssueHost } from "./IssueHost.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const output = (value: unknown) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: json(value),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});
const issue: IssueRef = {
  hostKind: "forgejo",
  host: "forge",
  repository: "owner/repo",
  id: "42",
  number: 42,
  url: "https://forge/owner/repo/issues/42",
};

describe("IssueHost", () => {
  it.effect("Forgejo lists through its existing authenticated API", () =>
    Effect.gen(function* () {
      const [, forgejo] = makeIssueHost({
        gitlab: { execute: () => Effect.die("Unexpected GitLab request") },
        forgejo: {
          api: () =>
            Effect.succeed(
              output([
                {
                  number: 42,
                  title: "Forge task",
                  state: "open",
                  updated_at: "now",
                  html_url: "https://forge/repo/issues/42",
                },
              ]),
            ),
        },
        bitbucket: { request: () => Effect.die("Unexpected Bitbucket request") },
      });
      const result = yield* forgejo!.list({ cwd: "/repo", ref: issue });
      assert.strictEqual(result.issues[0]!.title, "Forge task");
    }),
  );
});
