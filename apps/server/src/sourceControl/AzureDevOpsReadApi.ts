import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { CredentialScope } from "./SourceControlRateLimit.ts";

export class AzureDevOpsReadError extends Schema.TaggedError<AzureDevOpsReadError>()(
  "AzureDevOpsReadError",
  {
    reason: Schema.Literals(["authentication", "rate-limited", "not-found", "failed"]),
    status: Schema.optional(Schema.Int),
  },
) {
  override get message(): string {
    return this.detail;
  }

  get detail(): string {
    return this.status === undefined
      ? "Could not read Azure DevOps using the existing sign-in."
      : `Azure DevOps returned HTTP ${this.status}.`;
  }
}

interface ReadInput {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class AzureDevOpsReadApi extends Context.Service<
  AzureDevOpsReadApi,
  {
    /** Existing adapters keep their command vocabulary; supported reads reuse HTTP credentials. */
    readonly read: (
      input: ReadInput,
    ) => Effect.Effect<VcsProcess.VcsProcessOutput | null, AzureDevOpsReadError>;
  }
>()("t3/sourceControl/AzureDevOpsReadApi") {}

const flag = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const parameters = (args: ReadonlyArray<string>, name: string) => {
  const result = new Map<string, string>();
  const index = args.indexOf(name);
  if (index < 0) return result;
  for (const value of args.slice(index + 1)) {
    if (value.startsWith("--")) break;
    const equal = value.indexOf("=");
    if (equal > 0) result.set(value.slice(0, equal), value.slice(equal + 1));
  }
  return result;
};

function repositoryScope(remote: string) {
  const ssh =
    /^(?:git@ssh\.dev\.azure\.com:|ssh:\/\/(?:git@)?ssh\.dev\.azure\.com\/)v3\/([^/]+)\/([^/]+)\/(.+)$/i.exec(
      remote,
    );
  try {
    if (ssh)
      return {
        organization: decodeURIComponent(ssh[1]!),
        project: decodeURIComponent(ssh[2]!),
        repository: decodeURIComponent(ssh[3]!),
      };
    const url = new URL(remote);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const git = parts.indexOf("_git");
    if (url.hostname === "dev.azure.com" && git === 2 && parts[3]) {
      return { organization: parts[0]!, project: parts[1]!, repository: parts[3] };
    }
    if (url.hostname.endsWith(".visualstudio.com") && git >= 0 && parts[git + 1]) {
      return {
        organization: url.hostname.slice(0, -".visualstudio.com".length),
        project: git > 0 ? parts[git - 1]! : parts[git + 1]!,
        repository: parts[git + 1]!,
      };
    }
  } catch {
    /* A non-Azure remote is left to the CLI. */
  }
  return null;
}

const AccessToken = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  expires_on: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
});
const Identities = Schema.Struct({
  value: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
});
const ListResponse = Schema.Struct({ value: Schema.Array(Schema.Unknown) });
const decodeToken = Schema.decodeEffect(Schema.fromJsonString(AccessToken));
const decodeIdentities = Schema.decodeEffect(Schema.fromJsonString(Identities));
const decodeList = Schema.decodeEffect(Schema.fromJsonString(ListResponse));
const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)));

const failure = () => new AzureDevOpsReadError({ reason: "failed" });
const authenticationFailure = () => new AzureDevOpsReadError({ reason: "authentication" });
// HTTP failures carry request headers. Keep credentials out of errors sent to clients.

class RequestKey extends Data.Class<{
  readonly organization: string;
  readonly scope: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body: string | undefined;
  readonly maxBytes: number;
  readonly ttlMs: number;
}> {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const process = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const envPat = yield* Config.String("AZURE_DEVOPS_EXT_PAT").pipe(
    Config.withDefault(""),
    Effect.orDie,
  );
  const configDirectory = yield* Config.String("AZURE_CONFIG_DIR").pipe(
    Config.withDefault(path.join(NodeOS.homedir(), ".azure")),
    Effect.orDie,
  );

  const scopes = yield* Cache.makeWith(
    (cwd: string) =>
      process
        .run({
          operation: "AzureDevOpsReadApi.remote",
          command: "git",
          cwd,
          args: ["config", "--get-regexp", "^remote\\..*\\.url$"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((output) => {
            const rows = output.stdout
              .trim()
              .split(/\r?\n/)
              .sort(
                (a, b) =>
                  Number(b.startsWith("remote.origin.url ")) -
                  Number(a.startsWith("remote.origin.url ")),
              );
            for (const row of rows) {
              const remote = row.slice(row.indexOf(" ") + 1).trim();
              const scope = repositoryScope(remote);
              if (scope) return scope;
            }
            return null;
          }),
          Effect.orElseSucceed(() => null),
        ),
    { capacity: 128, timeToLive: () => Duration.seconds(30) },
  );

  const storedPat = Effect.fnUntraced(function* (organization: string) {
    const keys = [
      `azdevops-cli:https://dev.azure.com/${organization.toLowerCase()}`,
      `azdevops-cli:https://${organization.toLowerCase()}.visualstudio.com`,
      "azdevops-cli: default",
    ];
    const keyring = yield* Effect.tryPromise(() => import("@napi-rs/keyring")).pipe(Effect.option);
    if (Option.isSome(keyring)) {
      for (const service of keys) {
        // Python keyring writes Windows credentials as UTF-16 under the service target.
        const secret = yield* Effect.tryPromise(() =>
          platform === "win32"
            ? keyring.value.AsyncEntry.withTarget(
                service,
                service,
                "Personal Access Token",
              ).getSecret()
            : new keyring.value.AsyncEntry(service, "Personal Access Token").getSecret(),
        ).pipe(Effect.option);
        if (Option.isSome(secret) && secret.value?.length) {
          return Buffer.from(secret.value).toString(platform === "win32" ? "utf16le" : "utf8");
        }
      }
    }
    if (platform === "linux") {
      const contents = yield* fs
        .readFileString(path.join(configDirectory, "azuredevops", "personalAccessTokens"))
        .pipe(Effect.orElseSucceed(() => ""));
      let section = "";
      const values = new Map<string, string>();
      for (const line of contents.split(/\r?\n/)) {
        const heading = /^\[(.+)\]\s*$/.exec(line);
        if (heading) section = heading[1]!;
        const token = /^\s*personal access token\s*=\s*(.+)$/i.exec(line);
        if (token) values.set(section, token[1]!.trim());
      }
      for (const key of keys) {
        const token = values.get(key);
        if (token) return token;
      }
    }
    return null;
  });

  const credentials = yield* Cache.makeWith(
    Effect.fnUntraced(function* (key: string) {
      const [organization] = key.split("\n");
      const pat = yield* storedPat(organization!);
      if (pat)
        return { authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`, ttl: 60_000 };
      // Ask the organization which tenant owns it; the default az tenant may be different.
      const challenge = yield* http
        .execute(
          HttpClientRequest.get(
            `https://dev.azure.com/${encodeURIComponent(organization!)}/_apis/connectionData`,
          ),
        )
        .pipe(Effect.mapError(failure));
      const tenant = challenge.headers["x-vss-resourcetenant"];
      const output = yield* process
        .run({
          operation: "AzureDevOpsReadApi.token",
          command: "az",
          cwd: NodeOS.tmpdir(),
          args: [
            "account",
            "get-access-token",
            "--resource",
            "499b84ac-1321-427f-aa17-267ca6975798",
            ...(tenant && /^[0-9a-f-]{36}$/i.test(tenant) ? ["--tenant", tenant] : []),
            "--only-show-errors",
            "--output",
            "json",
          ],
          timeoutMs: 20_000,
        })
        .pipe(Effect.mapError(authenticationFailure));
      const token = yield* decodeToken(output.stdout).pipe(Effect.mapError(authenticationFailure));
      const now = yield* Clock.currentTimeMillis;
      const expiry = Number(token.expires_on) * 1000;
      return {
        authorization: `Bearer ${token.accessToken}`,
        ttl: Number.isFinite(expiry) ? Math.max(0, expiry - now - 60_000) : 60_000,
      };
    }),
    {
      capacity: 32,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.millis(exit.value.ttl) : Duration.zero,
    },
  );

  const requests = yield* Cache.makeWith(
    Effect.fnUntraced(function* (input: RequestKey) {
      const key = `${input.organization}\n${input.scope}`;
      const send = (authorization: string) =>
        http
          .execute(
            HttpClientRequest.make(input.method)(input.url).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.setHeader("authorization", authorization),
              (request) =>
                input.body === undefined
                  ? request
                  : HttpClientRequest.bodyText(request, input.body, "application/json"),
            ),
          )
          .pipe(Effect.mapError(failure));
      let credential = envPat
        ? { authorization: `Basic ${Buffer.from(`:${envPat}`).toString("base64")}` }
        : yield* Cache.get(credentials, key);
      let response = yield* send(credential.authorization);
      if (response.status === 401 && !envPat) {
        const held = yield* Cache.getSuccess(credentials, key);
        if (Option.isSome(held) && held.value === credential)
          yield* Cache.invalidate(credentials, key);
        credential = yield* Cache.get(credentials, key);
        response = yield* send(credential.authorization);
      }
      if (response.status < 200 || response.status >= 300)
        return yield* new AzureDevOpsReadError({
          reason:
            response.status === 401
              ? "authentication"
              : response.status === 429
                ? "rate-limited"
                : response.status === 404
                  ? "not-found"
                  : "failed",
          status: response.status,
        });
      const body = yield* collectUint8StreamText({
        stream: response.stream,
        maxBytes: input.maxBytes,
      }).pipe(Effect.mapError(failure));
      if (body.truncated || body.invalidUtf8) return yield* failure();
      return { text: body.text, ttlMs: body.text.length <= 65_536 ? input.ttlMs : 0 };
    }),
    {
      capacity: 128,
      // Mutable metadata shares only the in-flight request. Its domain cache owns
      // freshness and invalidation; an explicit refresh must reach Azure.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.millis(exit.value.ttlMs) : Duration.zero,
    },
  );

  const request = Effect.fnUntraced(function* (
    input: ReadInput,
    organization: string,
    path: string,
    query: ReadonlyMap<string, string>,
    identityHost = false,
    method: "GET" | "POST" = "GET",
    body?: string,
  ) {
    const scope = yield* CredentialScope;
    const url = new URL(
      `https://${identityHost ? "vssps.dev.azure.com" : "dev.azure.com"}/${encodeURIComponent(organization)}${path}`,
    );
    for (const [name, value] of [...query].sort(([a], [b]) => a.localeCompare(b)))
      url.searchParams.set(name, value);
    if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", "7.1");
    const immutable =
      path.endsWith("/items") &&
      query.get("versionDescriptor.versionType") === "commit" &&
      /^[0-9a-f]{40}$/i.test(query.get("versionDescriptor.version") ?? "");
    const key = new RequestKey({
      organization,
      scope,
      url: url.href,
      method,
      body,
      maxBytes: input.maxOutputBytes ?? 1_000_000,
      ttlMs: identityHost ? 300_000 : immutable ? 600_000 : 0,
    });
    const response = yield* Cache.get(requests, key);
    // Expired Cache entries remain allocated until eviction. Release uncached
    // responses immediately, especially large file and work-item payloads.
    if (response.ttlMs === 0) {
      const held = yield* Cache.getSuccess(requests, key);
      if (Option.isSome(held) && held.value === response) yield* Cache.invalidate(requests, key);
    }
    return response.text;
  });

  const read: AzureDevOpsReadApi["Service"]["read"] = Effect.fnUntraced(
    function* (input) {
      const { args } = input;
      const show = args.slice(0, 3).join(" ") === "repos pr show";
      const list = args.slice(0, 3).join(" ") === "repos pr list";
      const repoShow = args.slice(0, 2).join(" ") === "repos show";
      const projects = args.slice(0, 3).join(" ") === "devops project list";
      const teams = args.slice(0, 3).join(" ") === "devops team list";
      const invoke = args.slice(0, 2).join(" ") === "devops invoke";
      if (!show && !list && !repoShow && !projects && !teams && !invoke) return null;
      const area = flag(args, "--area");
      const resource = flag(args, "--resource");
      const method = flag(args, "--http-method") ?? "GET";
      const resources: Record<string, string> = {
        pullRequestThreads: "threads",
        pullRequestIterations: "iterations",
        pullRequestIterationChanges: "changes",
        items: "items",
      };
      const gitRead = area === "git" && resource && resources[resource] && method === "GET";
      const workRead =
        area === "work" &&
        ["boards", "teamfieldvalues"].includes(resource ?? "") &&
        method === "GET";
      const itemRead =
        area === "wit" &&
        ((resource === "comments" && method === "GET") ||
          (["wiql", "workItemsBatch"].includes(resource ?? "") && method === "POST"));
      if (invoke && !gitRead && !workRead && !itemRead) return null;
      const explicitOrganization = flag(args, "--organization");
      const detected = explicitOrganization ? null : yield* Cache.get(scopes, input.cwd);
      const organization = explicitOrganization
        ? repositoryScope(`${explicitOrganization.replace(/\/+$/, "")}/project/_git/repository`)
            ?.organization
        : detected?.organization;
      if (!organization) return null;
      const repository = {
        ...detected,
        organization,
        project: flag(args, "--project") ?? detected?.project ?? "",
        repository: detected?.repository ?? "",
      };
      let path: string;
      const query = parameters(args, "--query-parameters");
      if (projects || teams) {
        path = teams
          ? `/_apis/projects/${encodeURIComponent(repository.project)}/teams`
          : "/_apis/projects";
        for (const [cli, api] of [
          ["--top", "$top"],
          ["--skip", "$skip"],
        ]) {
          const value = flag(args, cli!);
          if (value) query.set(api!, value);
        }
      } else if (repoShow) {
        const parts = (flag(args, "--repository") ?? repository.repository).split("/");
        const project =
          flag(args, "--project") ?? (parts.length > 1 ? parts.at(-2)! : repository.project);
        path = `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(parts.at(-1)!)}`;
      } else if (show) {
        path = `/${encodeURIComponent(repository.project)}/_apis/git/pullrequests/${encodeURIComponent(flag(args, "--id") ?? "")}`;
      } else if (list) {
        path = `/${encodeURIComponent(repository.project)}/_apis/git/repositories/${encodeURIComponent(flag(args, "--repository") ?? repository.repository)}/pullrequests`;
        query.set("searchCriteria.status", flag(args, "--status") ?? "active");
        for (const [cli, api] of [
          ["--top", "$top"],
          ["--skip", "$skip"],
          ["--source-branch", "searchCriteria.sourceRefName"],
        ]) {
          const value = flag(args, cli!);
          if (value)
            query.set(
              api!,
              cli === "--source-branch" && !value.startsWith("refs/")
                ? `refs/heads/${value}`
                : value,
            );
        }
        for (const [cli, api] of [
          ["--creator", "searchCriteria.creatorId"],
          ["--reviewer", "searchCriteria.reviewerId"],
        ]) {
          const value = flag(args, cli!);
          if (!value) continue;
          let id = value;
          if (!/^[0-9a-f-]{36}$/i.test(id)) {
            const identities = yield* request(
              input,
              repository.organization,
              "/_apis/identities",
              new Map([
                ["searchFilter", "General"],
                ["filterValue", value],
                ["queryMembership", "None"],
              ]),
              true,
            );
            const decoded = yield* decodeIdentities(identities).pipe(Effect.mapError(failure));
            if (decoded.value.length !== 1) return yield* failure();
            id = decoded.value[0]!.id;
          }
          query.set(api!, id);
        }
      } else {
        const route = parameters(args, "--route-parameters");
        const project = route.get("project") ?? repository.project;
        const repo = route.get("repositoryId") ?? repository.repository;
        path = `/${encodeURIComponent(project)}`;
        if (workRead) {
          const team = route.get("team");
          if (team) path += `/${encodeURIComponent(team)}`;
          path +=
            resource === "teamfieldvalues"
              ? "/_apis/work/teamsettings/teamfieldvalues"
              : "/_apis/work/boards";
          if (resource === "boards" && route.get("id"))
            path += `/${encodeURIComponent(route.get("id")!)}`;
        } else if (itemRead) {
          path +=
            resource === "comments"
              ? `/_apis/wit/workItems/${encodeURIComponent(route.get("workItemId") ?? "")}/comments`
              : `/_apis/wit/${resource!.toLowerCase()}`;
        } else {
          path += `/_apis/git/repositories/${encodeURIComponent(repo)}`;
          if (resource === "items") path += "/items";
          else {
            path += `/pullrequests/${encodeURIComponent(route.get("pullRequestId") ?? "")}`;
            path +=
              resource === "pullRequestIterationChanges"
                ? `/iterations/${encodeURIComponent(route.get("iterationId") ?? "")}/changes`
                : `/${resources[resource!]}`;
          }
        }
        query.set("api-version", flag(args, "--api-version") ?? "7.1");
      }
      const bodyFile = invoke && method === "POST" ? flag(args, "--in-file") : undefined;
      if (invoke && method === "POST" && !bodyFile) return null;
      const body = bodyFile
        ? yield* fs.readFileString(bodyFile).pipe(Effect.mapError(failure))
        : undefined;
      const text = yield* request(
        input,
        repository.organization,
        path,
        query,
        false,
        method === "POST" ? "POST" : "GET",
        body,
      );
      const stdout =
        list || teams
          ? yield* decodeList(text).pipe(
              Effect.map((response) => encodeRows(response.value)),
              Effect.mapError(failure),
            )
          : text;
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(input.timeoutMs ?? 30_000),
          orElse: () => Effect.fail(failure()),
        }),
      ),
  );

  return AzureDevOpsReadApi.of({ read });
});

export const layer = Layer.effect(AzureDevOpsReadApi, make);
