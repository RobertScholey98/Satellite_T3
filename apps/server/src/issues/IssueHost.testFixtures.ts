import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { IssueOperationError } from "@t3tools/contracts";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import type { IssueHostAdapter, PublishedIssue } from "./IssueHostAdapter.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/** One Azure CLI call, as the scripted host reads it. */
export interface AzureRequest {
  readonly command: string;
  readonly resource: string | undefined;
  readonly route: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly flag: (name: string) => string | undefined;
  readonly values: (name: string) => ReadonlyArray<string>;
}

/**
 * An Azure DevOps CLI for one organization that answers what `answer` returns and dies on anything
 * else, including the calls the real CLI rejects: preview-numbered API versions and `invoke` on the
 * preview-only teams resource.
 */
export const azureCli = (
  organization: string,
  answer: (request: AzureRequest) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
      execute: ({ args }) =>
        Effect.gen(function* () {
          const flag = (name: string) => {
            const index = args.indexOf(name);
            return index < 0 ? undefined : args[index + 1];
          };
          const values = (name: string) => {
            const index = args.indexOf(name);
            if (index < 0) return [];
            const end = args.findIndex((arg, at) => at > index && arg.startsWith("--"));
            return args.slice(index + 1, end < 0 ? undefined : end);
          };
          const pairs = (name: string) =>
            Object.fromEntries(values(name).map((pair) => pair.split("=") as [string, string]));
          if (flag("--organization") !== `https://dev.azure.com/${organization}`)
            return yield* Effect.die(`Unexpected organization ${flag("--organization")}`);
          if (/preview\.\d/.test(flag("--api-version") ?? ""))
            return yield* Effect.die("The CLI cannot parse a numbered preview API version");
          if (flag("--resource") === "teams")
            return yield* Effect.die("The teams resource is preview-only in the CLI");
          const file = flag("--in-file");
          const request: AzureRequest = {
            command: args.slice(0, 3).join(" "),
            resource: flag("--resource"),
            route: pairs("--route-parameters"),
            query: pairs("--query-parameters"),
            body: file ? yield* decodeJson(yield* fs.readFileString(file)) : undefined,
            flag,
            values,
          };
          const resolved = yield* answer(request);
          if (resolved === undefined)
            return yield* Effect.die(`Unexpected Azure request ${args.join(" ")}`);
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: json(resolved),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }).pipe(Effect.orDie),
    });
  });

/**
 * A GitHub adapter over an in-memory repository, for code that publishes issues. `onRead` sees
 * every issue read back, and `loseFirstCreate` creates the first issue but fails its response.
 */
export const publishingHost = (
  options: {
    readonly loseFirstCreate?: boolean;
    readonly alterReadback?: boolean;
    readonly onRead?: (issue: PublishedIssue) => void;
  } = {},
) => {
  const remote: PublishedIssue[] = [];
  const adapter: IssueHostAdapter = {
    kind: "github",
    list: () => Effect.die("Publication does not list issues"),
    get: ({ ref }) => {
      const issue = remote.find((entry) => entry.number === ref.number);
      if (!issue) return Effect.die(`Unexpected read of issue ${ref.number}`);
      options.onRead?.(issue);
      return Effect.succeed({
        ref: { ...ref, url: issue.url },
        title: issue.title,
        state: "open",
        updatedAt: "2026-10-01T00:00:00Z",
        labels: [],
        body: options.alterReadback ? issue.body + "\nAltered externally" : issue.body,
      });
    },
    publication: {
      create: ({ ref }, draft) => {
        const number = remote.length + 1;
        const issue = {
          number,
          title: draft.title,
          body: draft.body,
          url: `https://${ref.host}/${ref.repository}/issues/${number}`,
        };
        remote.push(issue);
        return number === 1 && options.loseFirstCreate
          ? Effect.fail(
              new IssueOperationError({ reason: "remote", message: "GitHub did not answer." }),
            )
          : Effect.succeed(issue);
      },
      findByMarker: (_scope, markers) =>
        Effect.succeed(
          remote.filter((issue) => markers.some((marker) => issue.body.includes(marker))),
        ),
    },
  };
  return { adapter, remote };
};
