import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Tool from "effect/ai/Tool";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { IssueService } from "../IssueService.ts";
import {
  makeIssueHarness,
  remoteFailure,
  withDatabase,
  type IssueHarness,
} from "../IssueService.test.helpers.ts";
import * as IssuesMcp from "./handlers.ts";
import { IssuesToolkit } from "./tools.ts";

const invocation = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const readTicket = (
  test: IssueHarness,
  threadId: ThreadId,
  capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>,
) =>
  Effect.gen(function* () {
    const service = Layer.succeed(IssueService, test.service);
    const toolkit = yield* IssuesToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(IssuesMcp.layer).pipe(Layer.provide(service)),
      ),
    );
    return yield* toolkit.handle("read_thread_ticket", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) =>
          chunk.at(-1)!.result as Tool.Success<(typeof IssuesToolkit.tools)["read_thread_ticket"]>,
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(threadId, capabilities),
      ),
      Effect.provide(service),
    );
  });

const startedTicket = Effect.gen(function* () {
  const test = yield* makeIssueHarness();
  yield* test.configureBoard();
  const { threadId } = yield* test.startAttempt(1);
  yield* test.threadRunning(threadId);
  yield* test.service.reconcileThread(threadId);
  return { test, threadId };
});

const ticketOne = {
  number: 1,
  title: "Ticket 1: make the board load faster on large projects",
  url: "https://github.com/acme/app/issues/1",
  state: "open",
  labels: ["enhancement", "boards"],
  column: "In progress",
};

describe("read_thread_ticket", () => {
  it.effect("returns the active attempt's ticket with its column and comments", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, threadId } = yield* startedTicket;
        const result = yield* readTicket(test, threadId);
        assert.deepStrictEqual(result, {
          ticket: {
            ...ticketOne,
            body: "Steps to reproduce ticket 1.",
            comments: [
              {
                author: "rob",
                createdAt: "2026-10-17T09:00:00.000Z",
                body: "Still reproduces on main.",
              },
            ],
          },
          attempt: { status: "working", active: true, automaticMovesPaused: false },
          message: "Ticket #1 Ticket 1: make the board load faster on large projects.",
        });
      }),
    ),
  );

  it.effect("falls back to the thread's earlier attempt once it stopped", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, threadId } = yield* startedTicket;
        const [attempt] = yield* test.attemptsOf(1);
        yield* test.service.endAttempt({ requestId: "stop", attemptId: attempt!.id });
        const result = yield* readTicket(test, threadId);
        assert.deepStrictEqual(result.attempt, {
          status: "ended",
          active: false,
          automaticMovesPaused: false,
        });
        assert.strictEqual(result.ticket?.number, 1);
      }),
    ),
  );

  it.effect("says plainly when the thread has no ticket", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* makeIssueHarness();
        const result = yield* readTicket(test, ThreadId.make("thread-without-ticket"));
        assert.deepStrictEqual(result, {
          ticket: null,
          attempt: null,
          message: "This thread was not started from a ticket.",
        });
      }),
    ),
  );

  it.effect("answers from the stored copy when the host is unreachable", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, threadId } = yield* startedTicket;
        yield* test.fail("get", remoteFailure());
        const result = yield* readTicket(test, threadId);
        assert.deepStrictEqual(result.ticket, { ...ticketOne, body: "", comments: [] });
        assert.strictEqual(
          result.message,
          "Ticket #1 Ticket 1: make the board load faster on large projects. The repository host was unreachable, so the body and comments are missing; this is the board's stored copy.",
        );
      }),
    ),
  );

  it.effect("refuses a credential without the orchestration capability", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, threadId } = yield* startedTicket;
        const failure = yield* readTicket(test, threadId, ["preview"]).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "McpCapabilityUnavailableError");
      }),
    ),
  );
});
