import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  decodeJsonReply,
  fromRunner,
  type Request,
  type Runner,
} from "./textGenerationOperations.ts";

describe("fromRunner", () => {
  it.effect("generateSummary sends its inputs to the runner and trims the reply", () =>
    Effect.gen(function* () {
      const requests: Array<Request<Schema.Top>> = [];
      const run: Runner = (request) => {
        requests.push(request);
        return decodeJsonReply(
          request,
          "fake",
          JSON.stringify({ summary: "  The parser landed. Tests are in progress.\n" }),
        );
      };

      const result = yield* fromRunner("Fake", run).generateSummary!({
        cwd: "/repo",
        subject: "Rewrite the parser",
        context: "assistant: parser merged",
        previousSummary: "Work started on the parser.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      });

      assert.deepStrictEqual(result, { summary: "The parser landed. Tests are in progress." });
      assert.strictEqual(requests.length, 1);
      const [request] = requests;
      assert.strictEqual(request?.operation, "generateSummary");
      assert.strictEqual(request?.investigate, undefined);
      assert.include(request?.prompt, "Rewrite the parser");
      assert.include(request?.prompt, "assistant: parser merged");
      assert.include(request?.prompt, "Work started on the parser.");
    }),
  );
});
