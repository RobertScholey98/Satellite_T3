import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as RevdocService from "../../../revdoc/RevdocService.ts";
import {
  answering,
  awaitPass,
  CHILD_THREAD_ID,
  delegatingThreads,
  layerRevdoc,
  makeRepository,
  target,
  THREAD_ID,
  writeFile,
} from "../../../revdoc/testing/revdocService.test.helpers.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as RevdocHandlers from "./handlers.ts";
import { RevdocToolkit } from "./tools.ts";

type ToolName = keyof typeof RevdocToolkit.tools;

const scopeFor = (
  threadId: ThreadId | undefined,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration", "worktree"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("revdoc-environment"),
  requestNamespace: `revdoc-${threadId ?? "client"}`,
  thread:
    threadId === undefined
      ? undefined
      : {
          threadId,
          providerSessionId: `session-${threadId}`,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
  client:
    threadId === undefined
      ? { sessionId: "client", label: "Outside client", access: "read-only" as const }
      : undefined,
  capabilities: new Set(capabilities),
  issuedAt: 0,
});

const noBrowserHost = Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
  invoke: () =>
    Effect.fail(
      new PreviewAutomationNoAvailableHostError({
        operation: "snapshot",
        environmentId: EnvironmentId.make("revdoc-environment"),
        threadId: CHILD_THREAD_ID,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
    ) as never,
});

/** Calls a tool the way the MCP server does, as the given caller. */
const call = (name: ToolName, args: unknown, scope: McpInvocationContext.McpInvocationScope) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      noBrowserHost,
    );
    const toolkit = yield* RevdocToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(RevdocHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const results = yield* toolkit
      .handle(name as never, args as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return results.at(-1)?.result as unknown as Record<string, unknown>;
  });

/** A Review with one check and a running test pass whose child is CHILD_THREAD_ID. */
const runningTestPass = Effect.gen(function* () {
  const revdoc = yield* RevdocService.RevdocService;
  yield* awaitPass((yield* revdoc.generate(target())).passId);
  const [item] = (yield* revdoc.read(target(), { attentionOnly: false })).items;
  const { passId } = yield* revdoc.test(
    { ...target(), selection: "remaining" },
    { threadId: THREAD_ID },
  );
  return { passId, itemId: item!.id };
});

const withReview = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const root = makeRepository();
  writeFile(root, "a.ts", "a\n");
  return effect.pipe(
    Effect.provide(
      layerRevdoc({ root, reviewer: { current: answering() }, threads: delegatingThreads() }),
    ),
  );
};

describe("Revdoc MCP tools", () => {
  it.live("record results and capture evidence only from the pass's testing agent", () =>
    withReview(
      Effect.gen(function* () {
        const { passId, itemId } = yield* runningTestPass;
        const args = {
          passId,
          itemId,
          state: "passed",
          method: "command",
          steps: "ran",
          observed: "ok",
        };
        const fromParent = yield* call("revdoc_record_result", args, scopeFor(THREAD_ID));
        assert.deepInclude(fromParent, { _tag: "RevdocError", code: "not_allowed" });
        const fromChild = yield* call("revdoc_record_result", args, scopeFor(CHILD_THREAD_ID));
        assert.deepInclude(fromChild, {
          outcome: "not_checked",
          result: { state: "passed", evidenceCount: 0 },
        });
        const capture = { passId, itemId, caption: "Home" };
        const parentCapture = yield* call(
          "revdoc_capture_evidence",
          capture,
          scopeFor(THREAD_ID, ["orchestration", "worktree", "preview"]),
        );
        assert.deepInclude(parentCapture, { _tag: "RevdocError", code: "not_allowed" });
      }),
    ),
  );

  it.live("map a missing browser host and agent browser access off to blocked reasons", () =>
    withReview(
      Effect.gen(function* () {
        const { passId, itemId } = yield* runningTestPass;
        const capture = { passId, itemId, caption: "Home" };
        assert.deepInclude(
          yield* call(
            "revdoc_capture_evidence",
            capture,
            scopeFor(CHILD_THREAD_ID, ["orchestration", "worktree", "preview"]),
          ),
          { _tag: "RevdocError", code: "no_browser_host" },
        );
        assert.deepInclude(
          yield* call("revdoc_capture_evidence", capture, scopeFor(CHILD_THREAD_ID)),
          {
            _tag: "RevdocError",
            code: "browser_access_off",
          },
        );
      }),
    ),
  );

  it.live("refuse passes from a testing child and testing from a caller without a live run", () =>
    withReview(
      Effect.gen(function* () {
        yield* runningTestPass;
        assert.deepInclude(yield* call("revdoc_generate", {}, scopeFor(CHILD_THREAD_ID)), {
          _tag: "RevdocError",
          code: "not_allowed",
        });
        const idle = yield* call(
          "revdoc_test",
          { selection: "remaining" },
          scopeFor("thread:idle" as ThreadId),
        );
        assert.deepInclude(idle, { _tag: "OrchestratorMcpFailure", code: "parent_not_active" });
      }),
    ),
  );

  it.live("read the review for thread agents and require a thread from outside clients", () =>
    withReview(
      Effect.gen(function* () {
        const revdoc = yield* RevdocService.RevdocService;
        yield* awaitPass((yield* revdoc.generate(target())).passId);
        const read = (yield* call(
          "revdoc_read",
          { attentionOnly: false },
          scopeFor(THREAD_ID),
        )) as {
          readonly items: ReadonlyArray<{ readonly check: string }>;
          readonly truncated: boolean;
        };
        assert.deepStrictEqual(
          read.items.map((item) => item.check),
          ["Open a.ts"],
        );
        assert.isFalse(read.truncated);
        assert.deepInclude(yield* call("revdoc_read", {}, scopeFor(undefined)), {
          _tag: "OrchestratorMcpFailure",
          code: "target_required",
        });
        assert.deepInclude(yield* call("revdoc_read", {}, scopeFor(THREAD_ID, ["orchestration"])), {
          _tag: "OrchestratorMcpFailure",
          code: "capability_denied",
        });
      }),
    ),
  );
});
