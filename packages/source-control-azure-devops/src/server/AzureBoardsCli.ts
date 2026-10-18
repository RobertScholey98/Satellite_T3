import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ISSUE_RESPONSE_LIMIT_BYTES } from "@t3tools/source-control-core/server/IssueHostAdapter";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const DEFAULT_API_VERSION = "7.1";
/** The CLI parses the version as a number once "-preview" is stripped, so "7.1-preview.4" is rejected. */
export const COMMENTS_API_VERSION = "7.1-preview";

export type AzureBoardsCliError = AzureDevOpsCli.AzureDevOpsCliError | PlatformError.PlatformError;

export interface AzureBoardsInvokeInput {
  readonly cwd: string;
  readonly organization: string;
  readonly area: "core" | "wit" | "work";
  readonly resource: string;
  readonly route: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  /** Present for a POST, which the CLI only accepts as a file. */
  readonly body?: unknown;
  readonly apiVersion?: string;
}

interface PageInput {
  readonly cwd: string;
  readonly organization: string;
  readonly top: number;
  readonly skip: number;
}

/**
 * Azure Boards reads and writes through `az`. Every call names its organization rather than
 * detecting it, because a board can belong to a project other than the checkout's remote.
 */
export class AzureBoardsCli extends Context.Service<
  AzureBoardsCli,
  {
    /** Prints the response JSON. */
    readonly invoke: (input: AzureBoardsInvokeInput) => Effect.Effect<string, AzureBoardsCliError>;
    readonly listProjects: (input: PageInput) => Effect.Effect<string, AzureBoardsCliError>;
    /** `az devops invoke` cannot reach teams: the CLI only knows that resource as a preview. */
    readonly listTeams: (
      input: PageInput & { readonly project: string },
    ) => Effect.Effect<string, AzureBoardsCliError>;
    readonly updateWorkItem: (input: {
      readonly cwd: string;
      readonly organization: string;
      readonly id: string;
      readonly state: string;
      readonly fields: Readonly<Record<string, string>>;
    }) => Effect.Effect<void, AzureBoardsCliError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureBoardsCli") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const pairs = (values: Readonly<Record<string, string>>) =>
  Object.entries(values).map(([key, value]) => `${key}=${value}`);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fs = yield* FileSystem.FileSystem;

  const run = (cwd: string, organization: string, args: ReadonlyArray<string>) =>
    azure
      .execute({
        cwd,
        args: [
          ...args,
          "--organization",
          `https://dev.azure.com/${encodeURIComponent(organization)}`,
          "--only-show-errors",
          "--output",
          "json",
        ],
        maxOutputBytes: ISSUE_RESPONSE_LIMIT_BYTES,
      })
      .pipe(Effect.map((output) => output.stdout));

  const invoke: AzureBoardsCli["Service"]["invoke"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const route = pairs(input.route);
        const query = pairs(input.query ?? {});
        const args = [
          "devops",
          "invoke",
          "--area",
          input.area,
          "--resource",
          input.resource,
          "--api-version",
          input.apiVersion ?? DEFAULT_API_VERSION,
          "--http-method",
          input.body === undefined ? "GET" : "POST",
          ...(route.length ? ["--route-parameters", ...route] : []),
          ...(query.length ? ["--query-parameters", ...query] : []),
        ];
        if (input.body !== undefined) {
          const file = yield* fs.makeTempFileScoped({
            prefix: "t3-azure-boards-",
            suffix: ".json",
          });
          yield* fs.writeFileString(file, encodeJson(input.body));
          args.push("--in-file", file);
        }
        return yield* run(input.cwd, input.organization, args);
      }),
    );

  return AzureBoardsCli.of({
    invoke,
    listProjects: (input) =>
      run(input.cwd, input.organization, [
        "devops",
        "project",
        "list",
        "--top",
        String(input.top),
        "--skip",
        String(input.skip),
      ]),
    listTeams: (input) =>
      run(input.cwd, input.organization, [
        "devops",
        "team",
        "list",
        "--project",
        input.project,
        "--top",
        String(input.top),
        "--skip",
        String(input.skip),
      ]),
    updateWorkItem: (input) =>
      run(input.cwd, input.organization, [
        "boards",
        "work-item",
        "update",
        "--id",
        input.id,
        "--state",
        input.state,
        "--fields",
        ...pairs(input.fields),
      ]).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(AzureBoardsCli, make);
