import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

it.effect(
  "rechecks a queued host mutation after admission is revoked while ordinary reads still finish",
  () =>
    Effect.gen(function* () {
      const occupied = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      let writes = 0;
      let credentialCalls = 0;
      let allowed = true;
      const layer = GitHubApi.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            GitHubGraphQlBudget.layer,
            SourceControlRateLimit.layer,
            Layer.mock(GitHubCredentials.GitHubCredentials)({
              get: (host) =>
                Effect.gen(function* () {
                  credentialCalls++;
                  if (credentialCalls === 9) yield* Deferred.succeed(queued, undefined);
                  return {
                    host,
                    token: Redacted.make("fixture"),
                    source: "settings" as const,
                    fingerprint: "fixture",
                  };
                }),
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.gen(function* () {
                  if (request.method === "GET") {
                    reads++;
                    if (reads === 8) yield* Deferred.succeed(occupied, undefined);
                    yield* Deferred.await(release);
                  } else writes++;
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response("{}", { headers: { "content-type": "application/json" } }),
                  );
                }),
              ),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const api = yield* GitHubApi.GitHubApi;
        const pendingReads = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, i) => i),
          (i) =>
            api
              .rest({ host: "github.com", operation: "occupied", path: `repos/example/test/${i}` })
              .pipe(Effect.forkChild),
        );
        yield* Deferred.await(occupied);
        const write = yield* api
          .rest({
            host: "github.com",
            operation: "publish",
            method: "POST",
            path: "repos/example/test/git/refs",
            body: {},
          })
          .pipe(
            Effect.provideService(
              GitHubApi.BeforeGitHubMutation,
              Effect.suspend(() =>
                allowed
                  ? Effect.void
                  : Effect.fail(
                      new GitHubApi.GitHubApiRequestError({
                        host: "github.com",
                        operation: "publish",
                        cause: "Revoked",
                      }),
                    ),
              ),
            ),
            Effect.result,
            Effect.forkChild,
          );
        yield* Deferred.await(queued);
        allowed = false;
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(pendingReads, Fiber.join);
        const result = yield* Fiber.join(write);
        assert.equal(result._tag, "Failure");
        assert.equal(reads, 8);
        assert.equal(writes, 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
