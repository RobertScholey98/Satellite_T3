// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import fixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      label: Schema.String,
      result: Schema.Record(Schema.String, Schema.Json),
    }),
  ),
);

it.live(
  "rejects native write and escalation requests without asking the Idea user for approval",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const scriptPath = NodePath.join(directory, "idea-native-requests.json");
      const common = {
        threadId: "${threadId}",
        turnId: "${turnId}",
        startedAtMs: 1_778_000_000_000,
      };
      const script = {
        rootThreadId: fixture.rootThreadId,
        notifications: [],
        holdTurnOpen: true,
        serverRequests: [
          {
            label: "command",
            method: "item/commandExecution/requestApproval",
            params: { ...common, itemId: "command", command: "write repository", cwd: directory },
          },
          {
            label: "file",
            method: "item/fileChange/requestApproval",
            params: { ...common, itemId: "file", grantRoot: directory },
          },
          {
            label: "permissions",
            method: "item/permissions/requestApproval",
            params: {
              ...common,
              itemId: "permissions",
              cwd: directory,
              permissions: { network: { enabled: true } },
            },
          },
        ],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      yield* fs.writeFileString(scriptPath, JSON.stringify(script));
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("idea-no-native-writes"),
        binaryPath: NodePath.join(
          import.meta.dirname,
          `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
        ),
        cwd: directory,
        runtimeMode: "full-access",
        idea: true,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      let resolvedCount = 0;
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.method === "serverRequest/resolved" && ++resolvedCount === 3,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Consider this idea" });
      const events = yield* Fiber.join(eventsFiber);
      const responses = (yield* fs.readFileString(`${scriptPath}.approvalResponses`))
        .trim()
        .split("\n")
        .map((line) => decodeResponse(line));
      expect(
        Object.fromEntries(responses.map((response) => [response.label, response.result])),
      ).toEqual({
        command: { decision: "decline" },
        file: { decision: "decline" },
        permissions: { permissions: {} },
      });
      expect(Array.from(events).filter((event) => event.kind === "request")).toEqual([]);
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
