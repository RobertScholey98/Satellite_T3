import { TextGenerationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { AcpRequestError } from "effect-acp/errors";
import type { AcpSessionRuntime } from "../provider/acp/AcpSessionRuntime.ts";

export const installTextGenerationToolGuard = Effect.fn("installTextGenerationToolGuard")(
  function* (runtime: AcpSessionRuntime["Service"], operation: string) {
    const failed = yield* Deferred.make<never, TextGenerationError>();
    const reject = () =>
      Deferred.fail(
        failed,
        new TextGenerationError({
          operation,
          detail: "Background text generation cannot use tools or request user input.",
        }),
      ).pipe(Effect.asVoid);
    const rejectRequest = () =>
      reject().pipe(
        Effect.andThen(
          Effect.fail(
            new AcpRequestError({
              code: -32601,
              errorMessage: "Tools are disabled for background text generation.",
            }),
          ),
        ),
      );
    yield* runtime.handleRequestPermission(() =>
      reject().pipe(Effect.as({ outcome: { outcome: "cancelled" as const } })),
    );
    yield* runtime.handleElicitation(() =>
      reject().pipe(Effect.as({ action: "decline" as const })),
    );
    yield* runtime.handleReadTextFile(rejectRequest);
    yield* runtime.handleWriteTextFile(rejectRequest);
    yield* runtime.handleCreateTerminal(rejectRequest);
    yield* runtime.handleTerminalOutput(rejectRequest);
    yield* runtime.handleTerminalWaitForExit(rejectRequest);
    yield* runtime.handleTerminalKill(rejectRequest);
    yield* runtime.handleTerminalRelease(rejectRequest);
    yield* runtime.handleUnknownExtRequest(rejectRequest);
    return { reject, failure: Deferred.await(failed) };
  },
);
