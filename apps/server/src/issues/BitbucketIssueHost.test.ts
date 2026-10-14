import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as BitbucketIssueHost from "./BitbucketIssueHost.ts";

describe("BitbucketIssueHost", () => {
  it.effect("explains a disabled issue tracker when the issue list is refused", () =>
    Effect.gen(function* () {
      const adapter = yield* BitbucketIssueHost.make.pipe(
        Effect.provide(
          Layer.mock(BitbucketApi.BitbucketApi)({
            request: () =>
              Effect.fail(
                new BitbucketApi.BitbucketResponseError({
                  operation: "request",
                  status: 404,
                  responseBodyLength: 0,
                }),
              ),
          }),
        ),
      );
      const failure = yield* adapter
        .list({
          cwd: "/repo",
          ref: {
            hostKind: "bitbucket",
            host: "bitbucket.org",
            repository: "owner/repo",
            id: "0",
            number: 0,
            url: "https://bitbucket.org/owner/repo",
          },
        })
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        [failure.reason, failure.message],
        [
          "unavailable",
          "Bitbucket's native issue tracker is unavailable or disabled. Bitbucket API failed in request: Bitbucket returned HTTP 404.",
        ],
      );
    }),
  );
});
