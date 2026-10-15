// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert } from "@effect/vitest";
import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as TextGeneration from "../TextGeneration.ts";
import * as TextGenerationOperations from "../TextGenerationOperations.ts";

const isTextGenerationError = Schema.is(TextGenerationError);
const isUnsupportedError = Schema.is(TextGenerationOperations.TextGenerationUnsupportedError);
const FULL_ISOLATION = ["isolated", "isolatedWorkspace"] as const;

/** The service every task composes over one provider, as the TextGeneration service does. */
export const textGenerationOf = (provider: TextGenerationOperations.Provider) =>
  TextGenerationOperations.fromProvider(() => Effect.succeed(provider));

/**
 * A provider whose model answers each request with `reply`, already structured,
 * the way Claude's CLI answers. Every request its run step receives lands in `requests`.
 */
export const cannedProvider = (
  reply: (request: TextGenerationOperations.Request<Schema.Top>) => Effect.Effect<unknown>,
  isolation: ReadonlyArray<TextGenerationOperations.Isolation> = FULL_ISOLATION,
) => {
  const requests: Array<TextGenerationOperations.Request<Schema.Top>> = [];
  const provider: TextGenerationOperations.Provider = {
    name: "CannedTextGeneration",
    run: (request) => {
      requests.push(request);
      return reply(request).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(request.outputSchema)),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: request.operation,
              detail: "The model returned invalid structured output.",
              cause,
            }),
        ),
      );
    },
    isolation: TextGenerationOperations.isolates(...isolation),
  };
  return { provider, requests };
};

type Generate = (
  textGeneration: TextGeneration.TextGeneration["Service"],
) => Effect.Effect<
  unknown,
  TextGenerationError | TextGenerationOperations.TextGenerationUnsupportedError
>;

/** Every file under `directory` with its content, so a run that touched the tree is visible. */
const snapshot = (directory: string) =>
  Object.fromEntries(
    NodeFS.readdirSync(directory, { recursive: true, encoding: "utf8" })
      .toSorted()
      .map((entry) => {
        const file = NodePath.join(directory, entry);
        return [entry, NodeFS.statSync(file).isFile() ? NodeFS.readFileSync(file, "utf8") : null];
      }),
  );

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => (Result.isFailure(result) ? result.failure : undefined)),
  );

const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix))),
    (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );

/**
 * The contract every provider's run step keeps. The model's reply reaches the
 * shared decoder untouched, so one reply yields one result on every provider.
 * A task that needs no checkout leaves the checkout byte-identical, and a
 * document task the provider does not declare isolation for is refused.
 * `isolation` is what the provider declares; `withReply` runs `generate` against
 * the provider's fixture answering `reply`.
 */
export const expectRunnerContract = <E, R>(
  modelSelection: ModelSelection,
  isolation: ReadonlyArray<TextGenerationOperations.Isolation>,
  withReply: (reply: string, generate: Generate) => Effect.Effect<unknown, E, R>,
) =>
  Effect.gen(function* () {
    const checkout = yield* temporaryDirectory("t3code-contract-checkout-");
    const workspace = yield* temporaryDirectory("t3code-contract-idea-");
    NodeFS.writeFileSync(NodePath.join(checkout, "keep.txt"), "untouched");
    const untouched = snapshot(checkout);

    const generated = yield* withReply(
      String.raw`{"title":"  \"Repair login redirect\"\nwhile signed out"}`,
      (textGeneration) =>
        textGeneration.generateThreadTitle({
          cwd: checkout,
          message: "Repair the login redirect",
          modelSelection,
        }),
    );
    assert.deepStrictEqual(generated, { title: "Repair login redirect" });
    assert.deepStrictEqual(snapshot(checkout), untouched, "a title leaves the checkout untouched");

    const failure = yield* failureOf(
      withReply('{"heading":"Repair login redirect"}', (textGeneration) =>
        textGeneration.generateThreadTitle({
          cwd: checkout,
          message: "Repair the login redirect",
          modelSelection,
        }),
      ),
    );
    assert(isTextGenerationError(failure), "a reply off the schema is a text generation error");
    assert.strictEqual(failure.operation, "generateThreadTitle");

    const review = {
      title: "Review",
      summary: "Changes",
      context: "Verify manually",
      sections: [],
    };
    const reviewed = withReply(
      '{"title":"Review","summary":"Changes","context":"Verify manually","sections":[]}',
      (textGeneration) =>
        textGeneration.generateRevdoc({
          cwd: checkout,
          prompt: "Review the worktree.",
          modelSelection,
        }),
    );
    if (isolation.includes("isolated")) {
      assert.deepStrictEqual(yield* reviewed, review);
      assert.deepStrictEqual(snapshot(checkout), untouched, "Revdoc leaves the checkout untouched");
    } else {
      const refused = yield* failureOf(reviewed);
      assert(isUnsupportedError(refused), "Revdoc is refused without isolation");
      assert.strictEqual(refused.operation, "generateRevdoc");
    }

    const updated = withReply('{"edits":[],"summary":"No new decisions."}', (textGeneration) =>
      textGeneration.generateIdeaUpdate({
        cwd: workspace,
        prompt: "Organize the notebook.",
        modelSelection,
      }),
    );
    if (isolation.includes("isolatedWorkspace")) {
      assert.deepStrictEqual(yield* updated, { edits: [], summary: "No new decisions." });
      assert.deepStrictEqual(
        snapshot(checkout),
        untouched,
        "an idea update stays in its workspace",
      );
    } else {
      const refused = yield* failureOf(updated);
      assert(isUnsupportedError(refused), "an idea update is refused without isolation");
      assert.strictEqual(refused.operation, "generateIdeaUpdate");
    }
  }).pipe(Effect.scoped);
