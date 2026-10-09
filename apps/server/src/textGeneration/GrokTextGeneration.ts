import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import { installTextGenerationToolGuard } from "./AcpTextGenerationGuard.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { type GrokSettings, TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import * as TextGenerationOperations from "./TextGenerationOperations.ts";
import { textGenerationTimeoutMs } from "./TextGenerationUtils.ts";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  currentGrokReasoningEffortFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../provider/acp/GrokAcpSupport.ts";
import { prepareGrokIdeaEnvironment } from "../provider/acp/IdeaAcpPolicy.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeGrokTextGeneration = Effect.fn("makeGrokTextGeneration")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runGrokJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection, onActivity } = request;
    return Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtimeEnvironment =
        operation === "generateIdeaUpdate" || operation === "generateRevdoc"
          ? yield* prepareGrokIdeaEnvironment(cwd, environment, "updates").pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            )
          : environment;
      const runtime = yield* makeGrokAcpRuntime({
        grokSettings,
        environment: runtimeEnvironment,
        childProcessSpawner: commandSpawner,
        cwd,
        ...(operation === "generateIdeaUpdate" || operation === "generateRevdoc"
          ? { ideaPurpose: "updates" as const }
          : {}),
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );

      const guard =
        operation === "generateIdeaUpdate" || operation === "generateRevdoc"
          ? yield* installTextGenerationToolGuard(runtime, operation)
          : undefined;

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (
          guard &&
          (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
        ) {
          return guard.reject();
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          return onActivity && update.content.type === "text"
            ? onActivity({ kind: "thinking", text: update.content.text })
            : Effect.void;
        }
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text).pipe(
          Effect.andThen(onActivity?.({ kind: "output", text: content.text }) ?? Effect.void),
        );
      });

      const promptResult = yield* Effect.gen(function* () {
        const resolvedModel = resolveGrokAcpBaseModelId(modelSelection.model);
        const started = yield* runtime.start();
        const requestedReasoningEffort = getModelSelectionStringOptionValue(
          modelSelection,
          "reasoningEffort",
        );
        yield* applyGrokAcpModelSelection({
          runtime,
          currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
          currentReasoningEffort: currentGrokReasoningEffortFromSessionSetup(
            started.sessionSetupResult,
          ),
          requestedModelId: resolvedModel,
          requestedReasoningEffort,
          mapError: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to set Grok ACP base model for text generation.",
              cause,
            }),
        });
        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.raceFirst(guard?.failure ?? Effect.never),
        Effect.timeoutOption(textGenerationTimeoutMs(operation)),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Grok ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Grok ACP request failed.",
                cause,
              }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Grok ACP request was cancelled."
              : "Grok Agent returned empty output.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "Grok Agent", trimmed);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Grok ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

  return TextGenerationOperations.fromRunner("GrokTextGeneration", runGrokJson);
});
