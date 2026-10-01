import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ElicitationResponse } from "effect-acp/schema";
import { expect } from "vite-plus/test";
import { AcpSessionRuntime } from "../provider/acp/AcpSessionRuntime.ts";
import { installTextGenerationToolGuard } from "./AcpTextGenerationGuard.ts";

const decodeElicitationResponse = Schema.decodeEffect(ElicitationResponse);

it.effect("declines an elicitation with a valid ACP response and fails the notebook update", () =>
  Effect.gen(function* () {
    const runtime = yield* AcpSessionRuntime;
    const guard = yield* installTextGenerationToolGuard(runtime, "generateIdeaUpdate");
    const error = yield* guard.failure.pipe(Effect.flip);
    expect(error.detail).toContain("request user input");
  }).pipe(
    Effect.provide(
      Layer.mock(AcpSessionRuntime)({
        handleRequestPermission: () => Effect.void,
        handleElicitation: (handler) =>
          Effect.gen(function* () {
            const reply = yield* handler({
              mode: "form",
              sessionId: "idea-updates",
              message: "Choose a category",
              requestedSchema: { type: "object", properties: {} },
            });
            expect(yield* decodeElicitationResponse(reply)).toEqual({
              action: { action: "decline" },
            });
          }).pipe(Effect.orDie),
        handleReadTextFile: () => Effect.void,
        handleWriteTextFile: () => Effect.void,
        handleCreateTerminal: () => Effect.void,
        handleTerminalOutput: () => Effect.void,
        handleTerminalWaitForExit: () => Effect.void,
        handleTerminalKill: () => Effect.void,
        handleTerminalRelease: () => Effect.void,
        handleUnknownExtRequest: () => Effect.void,
      }),
    ),
  ),
);
