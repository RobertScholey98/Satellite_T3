// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- the fake serves plain REST JSON to the gate script in a separate Node process.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";

/**
 * A GitHub that records labels, commit statuses and merge commits in memory. The server reaches it
 * through a `GitHubApi` layer and a deployment gate through `serveFakeGitHub`, so both read the
 * same REST state.
 */
export function makeFakeGitHub() {
  const repositoryLabels = new Map<string, Set<string>>();
  const pullLabels = new Map<string, string[]>();
  const commitPulls = new Map<string, number[]>();
  const statuses: Array<{
    repository: string;
    sha: string;
    state: string;
    context: string;
    description: string;
  }> = [];
  const writes: string[] = [];
  const labelsOf = (repository: string, number: number) =>
    (pullLabels.get(`${repository}#${number}`) ?? []).map((name) => ({ name }));
  const handle = (
    method: string,
    rawPath: string,
    body: unknown,
  ): { status: number; json: unknown } => {
    const path = decodeURIComponent(rawPath.split("?")[0]!.replace(/^\/+/, ""));
    const fields = (body ?? {}) as Record<string, unknown>;
    let match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels$/.exec(path);
    if (match) {
      const [, repository = "", number = ""] = match;
      const key = `${repository}#${number}`;
      if (method === "POST") {
        const labels = pullLabels.get(key) ?? [];
        for (const name of fields.labels as string[]) if (!labels.includes(name)) labels.push(name);
        pullLabels.set(key, labels);
        writes.push(`add-label ${key}`);
      }
      return { status: 200, json: labelsOf(repository, Number(number)) };
    }
    match = /^repos\/([^/]+\/[^/]+)\/labels(?:\/(.+))?$/.exec(path);
    if (match) {
      const [, repository = "", name] = match;
      const labels = repositoryLabels.get(repository) ?? new Set<string>();
      repositoryLabels.set(repository, labels);
      if (method === "GET")
        return name && labels.has(name)
          ? { status: 200, json: { name } }
          : { status: 404, json: { message: "Not Found" } };
      if (labels.has(fields.name as string)) return { status: 422, json: { message: "exists" } };
      labels.add(fields.name as string);
      writes.push(`create-label ${repository}`);
      return { status: 201, json: { name: fields.name } };
    }
    match = /^repos\/([^/]+\/[^/]+)\/statuses\/([^/]+)$/.exec(path);
    if (match && method === "POST") {
      const [, repository = "", sha = ""] = match;
      const status = {
        repository,
        sha,
        state: fields.state as string,
        context: fields.context as string,
        description: fields.description as string,
      };
      statuses.push(status);
      writes.push(`status ${repository}@${sha} ${status.state}`);
      return { status: 201, json: status };
    }
    match = /^repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/(status|pulls)$/.exec(path);
    if (match) {
      const [, repository = "", sha = "", kind] = match;
      if (kind === "pulls")
        return {
          status: 200,
          json: (commitPulls.get(`${repository}@${sha}`) ?? []).map((number) => ({
            number,
            labels: labelsOf(repository, number),
          })),
        };
      const latest = new Map<string, (typeof statuses)[number]>();
      for (const entry of statuses)
        if (entry.repository === repository && entry.sha === sha) latest.set(entry.context, entry);
      return { status: 200, json: { sha, statuses: [...latest.values()] } };
    }
    return { status: 404, json: { message: "Not Found" } };
  };
  const layer = Layer.mock(GitHubApi.GitHubApi)({
    rest: (input) =>
      Effect.suspend((): Effect.Effect<GitHubApi.GitHubRestResponse, GitHubApi.GitHubApiError> => {
        const response = handle(input.method ?? "GET", input.path, input.body);
        const context = { host: input.host, operation: input.operation };
        if (response.status === 404)
          return Effect.fail(new GitHubApi.GitHubApiNotFoundError(context));
        if (response.status >= 400)
          return Effect.fail(
            new GitHubApi.GitHubApiResponseError({ ...context, status: response.status }),
          );
        return Effect.succeed({
          status: response.status,
          headers: {},
          body: JSON.stringify(response.json),
          truncated: false,
          invalidUtf8: false,
        });
      }),
  });
  return {
    handle,
    layer,
    statuses,
    writes,
    /** Records that `sha` is the merge commit of pull request `number`, as a host merge does. */
    associate: (repository: string, sha: string, number: number) => {
      const key = `${repository}@${sha}`;
      commitPulls.set(key, [...new Set([...(commitPulls.get(key) ?? []), number])]);
    },
  };
}

/** Serves the fake's REST state on a local port for the duration of the scope. */
export const serveFakeGitHub = (github: ReturnType<typeof makeFakeGitHub>) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
          const server = NodeHttp.createServer((request, response) => {
            let raw = "";
            request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
            request.on("end", () => {
              const result = github.handle(
                request.method ?? "GET",
                request.url ?? "/",
                raw ? JSON.parse(raw) : undefined,
              );
              response.writeHead(result.status, { "content-type": "application/json" });
              response.end(JSON.stringify(result.json));
            });
          });
          server.listen(0, "127.0.0.1", () =>
            resolve({
              url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
              close: () => new Promise((done) => server.close(() => done())),
            }),
          );
        }),
    ),
    (served) => Effect.promise(served.close),
  ).pipe(Effect.map((served) => served.url));
