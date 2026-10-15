import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "./connection/registry.ts";
import * as EnvironmentSupervisor from "./connection/supervisor.ts";
import type { RpcSession } from "./rpc/session.ts";
import { createThreadEnvironmentAtoms } from "./state/threadCommands.ts";
import {
  deliverTurn,
  type TurnDeliveryRequest,
  type TurnDeliveryServices,
} from "./turnDelivery.ts";

const ENVIRONMENT_ID = EnvironmentId.make("remote");
const THREAD_ID = ThreadId.make("thread");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const ZERO_UUID = "00000000-0000-4000-8000-000000000000";
const TERMINAL_RECORD = {
  version: 1 as const,
  contextId: ComposerContextId.make("ctx_1"),
  kind: "terminal" as const,
  label: "Terminal 1 line 2",
  terminalId: "default",
  terminalLabel: "Terminal 1",
  lineStart: 2,
  lineEnd: 2,
  text: "npm test",
};

class CommandRejected extends Data.TaggedError("OrchestrationDispatchCommandError")<{
  readonly message: string;
}> {}
class SocketDropped extends Data.TaggedError("RpcClientError")<{ readonly message: string }> {}

type Reply = (
  command: OrchestrationV2Command,
) => Effect.Effect<{ sequence: number }, CommandRejected | SocketDropped>;

const makeHarness = Effect.fn("TestTurnDelivery.makeHarness")(function* (
  options: { readonly inlineMessageContext?: boolean; readonly reply?: Reply } = {},
) {
  const sent: OrchestrationV2Command[] = [];
  const reply: Reply = options.reply ?? (() => Effect.succeed({ sequence: 1 }));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        initialConfig: Effect.succeed({
          environment: { capabilities: { serverResolvedCommandContext: true } },
        }),
        client: {
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
            Effect.suspend(() => {
              sent.push(command);
              return reply(command);
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const thread = createThreadEnvironmentAtoms(runtime, () => Atom.make(null));
  const registry = AtomRegistry.make();
  const services: TurnDeliveryServices = {
    commands: {
      updateMetadata: (value) => thread.updateMetadata.run(registry, value),
      setRuntimeMode: (value) => thread.setRuntimeMode.run(registry, value),
      setInteractionMode: (value) => thread.setInteractionMode.run(registry, value),
      startTurn: (value) => thread.startTurn.run(registry, value),
    },
    environment: () =>
      ({
        capabilities: { inlineMessageContext: options.inlineMessageContext ?? true },
      }) as ExecutionEnvironmentDescriptor,
  };
  return { sent, services };
});

const deliver = (input: TurnDeliveryRequest, services: TurnDeliveryServices) =>
  Effect.promise(() => deliverTurn(input, services));

function request(overrides: Partial<TurnDeliveryRequest> = {}): TurnDeliveryRequest {
  return {
    environmentId: ENVIRONMENT_ID,
    turn: {
      threadId: THREAD_ID,
      modelSelection: MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-10-15T10:00:00.000Z",
    },
    message: { messageId: MessageId.make("message"), text: "Fix the build", attachments: [] },
    ...overrides,
  };
}

describe("deliverTurn", () => {
  it.effect("syncs metadata, runtime mode, then interaction mode before the turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = yield* deliver(
        request({
          thread: { branch: "main", runtimeMode: "approval-required", interactionMode: "plan" },
          branch: "feature",
        }),
        h.services,
      );

      expect(result).toEqual({ _tag: "Delivered" });
      expect(h.sent).toEqual([
        {
          type: "thread.metadata.update",
          commandId: ZERO_UUID,
          threadId: THREAD_ID,
          branch: "feature",
          worktreePath: null,
        },
        {
          type: "thread.runtime-mode.set",
          commandId: ZERO_UUID,
          threadId: THREAD_ID,
          runtimeMode: "full-access",
        },
        {
          type: "thread.interaction-mode.set",
          commandId: ZERO_UUID,
          threadId: THREAD_ID,
          interactionMode: "default",
        },
        {
          type: "message.dispatch",
          commandId: ZERO_UUID,
          createdBy: "user",
          creationSource: "web",
          threadId: THREAD_ID,
          messageId: "message",
          text: "Fix the build",
          attachments: [],
          modelSelection: MODEL,
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        },
      ]);
    }),
  );

  it.effect("sends only the start command when the thread already has the turn's settings", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* deliver(
        request({
          thread: { branch: "main", runtimeMode: "full-access", interactionMode: "default" },
          branch: "main",
        }),
        h.services,
      );

      expect(h.sent.map((command) => command.type)).toEqual(["message.dispatch"]);
    }),
  );

  it.effect("derives each settings command id from the turn's command id", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* deliver(
        request({
          turn: { ...request().turn, commandId: CommandId.make("queued"), dispatchMode: "start" },
          thread: { branch: null, runtimeMode: "approval-required", interactionMode: "plan" },
        }),
        h.services,
      );

      expect(h.sent.map((command) => command.commandId)).toEqual([
        "queued:runtime-mode",
        "queued:interaction-mode",
        "queued",
      ]);
    }),
  );

  it.effect("stops at the settings stage when the server rejects a setting", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        reply: (command) =>
          command.type === "thread.runtime-mode.set"
            ? Effect.fail(new CommandRejected({ message: "Runtime mode is locked." }))
            : Effect.succeed({ sequence: 1 }),
      });
      const result = yield* deliver(
        request({
          thread: { branch: null, runtimeMode: "approval-required", interactionMode: "plan" },
        }),
        h.services,
      );

      expect(result).toMatchObject({ _tag: "Failed", stage: "settings", transient: false });
      expect(h.sent.map((command) => command.type)).toEqual(["thread.runtime-mode.set"]);
    }),
  );

  it.effect("serializes context into the text for a server without inline context", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ inlineMessageContext: false });
      yield* deliver(
        request({
          message: {
            messageId: MessageId.make("message"),
            text: "Why does [Terminal 1 line 2](t3-context://v1/terminal/ctx_1) fail?",
            context: { version: 1, records: [TERMINAL_RECORD] },
            attachments: [],
          },
        }),
        h.services,
      );

      expect(h.sent[0]).toMatchObject({
        text: "Why does @terminal-1:2 fail?\n\n<terminal_context>\n- Terminal 1 line 2:\n  2 | npm test\n</terminal_context>",
      });
      expect(h.sent[0]).not.toHaveProperty("context");
    }),
  );

  it.effect("sends context records to a server that reads inline context", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ inlineMessageContext: true });
      const text = "Why does [Terminal 1 line 2](t3-context://v1/terminal/ctx_1) fail?";
      yield* deliver(
        request({
          message: {
            messageId: MessageId.make("message"),
            text,
            context: { version: 1, records: [TERMINAL_RECORD] },
            attachments: [],
          },
        }),
        h.services,
      );

      expect(h.sent[0]).toMatchObject({
        text,
        context: { version: 1, records: [TERMINAL_RECORD] },
      });
    }),
  );

  it.effect("compacts before the message and reports the dispatching text in between", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const seen: string[] = [];
      yield* deliver(
        request({
          compactFirst: MessageId.make("compact"),
          onDispatching: ({ text }) => {
            seen.push(`dispatching ${text} after ${h.sent.length} commands`);
          },
        }),
        h.services,
      );

      expect(seen).toEqual(["dispatching Fix the build after 0 commands"]);
      expect(h.sent.map((command) => ("text" in command ? command.text : command.type))).toEqual([
        "/compact",
        "Fix the build",
      ]);
    }),
  );

  it.effect("marks a dropped socket as transient and a rejected command as final", () =>
    Effect.gen(function* () {
      const dropped = yield* makeHarness({
        reply: () => Effect.fail(new SocketDropped({ message: "An error occurred during Read" })),
      });
      const rejected = yield* makeHarness({
        reply: () => Effect.fail(new CommandRejected({ message: "Thread is archived." })),
      });

      expect(yield* deliver(request(), dropped.services)).toMatchObject({
        _tag: "Failed",
        stage: "dispatch",
        transient: true,
      });
      expect(yield* deliver(request(), rejected.services)).toMatchObject({
        _tag: "Failed",
        stage: "dispatch",
        transient: false,
      });
    }),
  );
});
