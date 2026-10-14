import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";

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
