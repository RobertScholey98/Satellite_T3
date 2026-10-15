import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as TextGenerationOperations from "./TextGenerationOperations.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("test"), model: "test-model" };
const stalled = TextGenerationOperations.fromRunner("Stalled", () => Effect.never);

it.effect("abandons a metadata task after three minutes", () =>
  Effect.gen(function* () {
    const title = yield* stalled
      .generateThreadTitle({ cwd: "/work", message: "Repair login", modelSelection })
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("3 minutes");
    const error = yield* Fiber.join(title);
    assert.strictEqual(error.operation, "generateThreadTitle");
    assert.strictEqual(error.detail, "Text generation timed out.");
  }),
);

it.effect("gives a document task thirty minutes before abandoning it", () =>
  Effect.gen(function* () {
    const review = yield* stalled
      .generateRevdoc({ cwd: "/work", prompt: "Review the worktree.", modelSelection })
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("3 minutes");
    assert.isUndefined(review.pollUnsafe());
    yield* TestClock.adjust("27 minutes");
    const error = yield* Fiber.join(review);
    assert.strictEqual(error.operation, "generateRevdoc");
    assert.strictEqual(error.detail, "Text generation timed out.");
  }),
);
