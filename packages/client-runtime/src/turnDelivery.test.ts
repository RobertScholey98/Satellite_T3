import { describe, expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
  type TurnAttachmentAdapter,
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

interface Draft {
  readonly id: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
}

const SCREENSHOT: Draft = { id: "local-1", type: "image", name: "shot.png", mimeType: "image/png" };
const REPORT: Draft = {
  id: "local-2",
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
};
const SCREENSHOT_RECORD = {
  version: 1 as const,
  contextId: ComposerContextId.make("local-1"),
  kind: "image" as const,
  label: "shot.png",
  attachmentId: "local-1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 3,
};

/** Uploads mint `uploaded-<id>`; inline images keep the draft id and carry their bytes. */
function fakeAttachments(calls: string[] = []): TurnAttachmentAdapter<Draft> {
  return {
    prepare: async ({ attachments, upload }) => {
      calls.push(
        `${upload ? "upload" : "inline"} ${attachments.map((draft) => draft.id).join(",")}`,
      );
      return attachments.map((draft) =>
        upload
          ? {
              type: draft.type,
              id: ChatAttachmentId.make(`uploaded-${draft.id}`),
              name: draft.name,
              mimeType: draft.mimeType,
              sizeBytes: 3,
            }
          : {
              type: "image" as const,
              id: ChatAttachmentId.make(draft.id),
              name: draft.name,
              mimeType: draft.mimeType,
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,YWJj",
            },
      );
    },
  };
}

type Reply = (
  command: OrchestrationV2Command,
) => Effect.Effect<{ sequence: number }, CommandRejected | SocketDropped>;

const makeHarness = Effect.fn("TestTurnDelivery.makeHarness")(function* (
  options: {
    readonly inlineMessageContext?: boolean;
    readonly attachmentUploads?: boolean;
    readonly attachments?: TurnAttachmentAdapter<Draft>;
    readonly reply?: Reply;
  } = {},
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
          [WS_METHODS.assetsPersistChatAttachments]: (input: {
            readonly attachments: ReadonlyArray<{ readonly id?: string; readonly name: string }>;
          }) =>
            Effect.succeed({
              attachments: input.attachments.map((attachment) => ({
                type: "image",
                id: `persisted-${attachment.id}`,
                name: attachment.name,
                mimeType: "image/png",
                sizeBytes: 3,
              })),
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
  const services: TurnDeliveryServices<Draft> = {
    commands: {
      updateMetadata: (value) => thread.updateMetadata.run(registry, value),
      setRuntimeMode: (value) => thread.setRuntimeMode.run(registry, value),
      setInteractionMode: (value) => thread.setInteractionMode.run(registry, value),
      startTurn: (value) => thread.startTurn.run(registry, value),
    },
    attachments: options.attachments ?? fakeAttachments(),
    environment: () =>
      ({
        capabilities: {
          inlineMessageContext: options.inlineMessageContext ?? true,
          attachmentUploads: options.attachmentUploads ?? true,
        },
      }) as ExecutionEnvironmentDescriptor,
  };
  return { sent, services };
});

const deliver = (input: TurnDeliveryRequest<Draft>, services: TurnDeliveryServices<Draft>) =>
  Effect.promise(() => deliverTurn(input, services));

function request(overrides: Partial<TurnDeliveryRequest<Draft>> = {}): TurnDeliveryRequest<Draft> {
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

  it.effect("uploads attachments and binds their records to the uploaded ids", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const h = yield* makeHarness({ attachments: fakeAttachments(calls) });
      yield* deliver(
        request({
          message: {
            messageId: MessageId.make("message"),
            text: "See ![shot.png](t3-context://v1/image/local-1)",
            context: { version: 1, records: [SCREENSHOT_RECORD] },
            attachments: [SCREENSHOT, REPORT],
          },
        }),
        h.services,
      );

      expect(calls).toEqual(["upload local-1,local-2"]);
      expect(h.sent[0]).toMatchObject({
        attachments: [
          { type: "image", id: "uploaded-local-1", name: "shot.png" },
          { type: "file", id: "uploaded-local-2", name: "report.pdf" },
        ],
        context: {
          version: 1,
          records: [{ ...SCREENSHOT_RECORD, attachmentId: "uploaded-local-1" }],
        },
      });
    }),
  );

  it.effect("inlines images for a server without uploads and persists them first", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const h = yield* makeHarness({
        attachmentUploads: false,
        attachments: fakeAttachments(calls),
      });
      yield* deliver(
        request({
          message: {
            messageId: MessageId.make("message"),
            text: "See ![shot.png](t3-context://v1/image/local-1)",
            context: { version: 1, records: [SCREENSHOT_RECORD] },
            attachments: [SCREENSHOT],
          },
        }),
        h.services,
      );

      expect(calls).toEqual(["inline local-1"]);
      expect(h.sent[0]).toMatchObject({
        attachments: [{ type: "image", id: "persisted-local-1" }],
        context: {
          version: 1,
          records: [{ ...SCREENSHOT_RECORD, attachmentId: "persisted-local-1" }],
        },
      });
    }),
  );

  it.effect("rejects a file for a server without uploads before any command", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ attachmentUploads: false });
      const result = yield* deliver(
        request({
          thread: { branch: null, runtimeMode: "full-access", interactionMode: "default" },
          message: {
            messageId: MessageId.make("message"),
            text: "Read this",
            attachments: [REPORT],
          },
        }),
        h.services,
      );

      expect(result).toMatchObject({ _tag: "Failed", stage: "attachments" });
      expect(result._tag === "Failed" ? Cause.squash(result.failure.cause) : undefined).toEqual(
        new Error("This server does not support file attachments."),
      );
      expect(h.sent).toEqual([]);
    }),
  );

  it.effect("stops without sending when the owner of the attachments abandons the send", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ attachments: { prepare: async () => "abandoned" } });
      const result = yield* deliver(
        request({
          message: { messageId: MessageId.make("message"), text: "Hi", attachments: [SCREENSHOT] },
        }),
        h.services,
      );

      expect(result).toEqual({ _tag: "Abandoned" });
      expect(h.sent).toEqual([]);
    }),
  );
});
