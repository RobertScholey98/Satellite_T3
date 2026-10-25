import { assert, describe, it } from "@effect/vitest";
import {
  PullRequestOperationError,
  type PullRequestDetail,
  type PullRequestInvalidateInput,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readPullRequestHeadLive } from "./FactoryService.ts";
import { PROJECT_ID } from "./FactoryService.testkit.ts";

const PR_7 = { projectId: PROJECT_ID, host: "github.com", repository: "acme/app", number: 7 };

type Call =
  | readonly ["invalidate", PullRequestInvalidateInput]
  | readonly ["detail", PullRequestRef];

/** A pull request service whose detail read answers with `detail`, recording every call. */
const pullRequests = (detail: Effect.Effect<PullRequestDetail, PullRequestOperationError>) => {
  const calls: Call[] = [];
  return {
    calls,
    service: {
      invalidate: (input: PullRequestInvalidateInput) =>
        Effect.sync(() => void calls.push(["invalidate", input])),
      detail: (input: PullRequestRef) =>
        Effect.sync(() => void calls.push(["detail", input])).pipe(Effect.andThen(detail)),
    },
  };
};

const detailWithHead = (headSha?: string) =>
  Effect.succeed({ number: 7, ...(headSha === undefined ? {} : { headSha }) } as PullRequestDetail);

describe("readPullRequestHeadLive", () => {
  it.effect("drops the cached detail, then reads a fresh one for its head", () =>
    Effect.gen(function* () {
      const { calls, service } = pullRequests(detailWithHead("abc123"));
      const head = yield* readPullRequestHeadLive(service)(PR_7);
      assert.strictEqual(head, "abc123");
      assert.deepStrictEqual(calls, [
        [
          "invalidate",
          {
            reference: {
              projectId: PROJECT_ID,
              host: "github.com",
              repository: "acme/app",
              number: 7,
            },
          },
        ],
        [
          "detail",
          {
            projectId: PROJECT_ID,
            host: "github.com",
            repository: "acme/app",
            number: 7,
            allowStale: false,
          },
        ],
      ]);
    }),
  );

  it.effect("reads an unknown head when the detail has none", () =>
    Effect.gen(function* () {
      const { service } = pullRequests(detailWithHead());
      assert.isNull(yield* readPullRequestHeadLive(service)(PR_7));
    }),
  );

  it.effect("reads an unknown head when the detail cannot be read", () =>
    Effect.gen(function* () {
      const { service } = pullRequests(
        Effect.fail(
          new PullRequestOperationError({ operation: "detail", detail: "GitHub is down." }),
        ),
      );
      assert.isNull(yield* readPullRequestHeadLive(service)(PR_7));
    }),
  );
});
