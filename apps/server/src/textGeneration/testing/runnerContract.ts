import { assert } from "@effect/vitest";
import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as TextGeneration from "../TextGeneration.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

type GenerateTitle = (
  textGeneration: TextGeneration.TextGeneration["Service"],
) => Effect.Effect<TextGeneration.ThreadTitleGenerationResult, TextGenerationError>;

/**
 * The contract every provider's run step keeps: the model's reply reaches the
 * shared decoder untouched, so one reply yields one result on every provider.
 * `withReply` runs `generate` against the provider's fixture answering `reply`.
 */
export const expectRunnerContract = <E, R>(
  modelSelection: ModelSelection,
  withReply: (
    reply: string,
    generate: GenerateTitle,
  ) => Effect.Effect<TextGeneration.ThreadTitleGenerationResult, E, R>,
) =>
  Effect.gen(function* () {
    const generate: GenerateTitle = (textGeneration) =>
      textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Repair the login redirect",
        modelSelection,
      });

    const generated = yield* withReply(
      String.raw`{"title":"  \"Repair login redirect\"\nwhile signed out"}`,
      generate,
    );
    assert.deepStrictEqual(generated, { title: "Repair login redirect" });

    const failure = yield* Effect.flip(withReply('{"heading":"Repair login redirect"}', generate));
    assert(isTextGenerationError(failure), "a reply off the schema is a text generation error");
    assert.strictEqual(failure.operation, "generateThreadTitle");
  });
