/**
 * The text generation operations every provider shares. A provider supplies a
 * runner that sends one prompt and decodes the reply; prompts, linked source
 * control context, timeouts, and output sanitizing live here so providers
 * cannot drift on them.
 *
 * @module textGeneration/TextGenerationOperations
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type * as TextGeneration from "./TextGeneration.ts";
import { RevdocGenerationResult, type RevdocGenerationInput } from "../revdoc/RevdocGeneration.ts";
import {
  IdeaUpdateGenerationResult,
  normalizeIdeaUpdateResult,
  type IdeaUpdateInput,
} from "../ideas/IdeaUpdateGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

export type Operation = keyof TextGeneration.TextGeneration["Service"];

/**
 * What a task needs from its run. Each provider maps it to its own mechanism
 * (a temporary directory, an isolation policy, a tool guard), so no provider
 * branches on the operation.
 */
export type Needs =
  /** Reads the checkout at `cwd`. */
  | "checkout"
  /** Reads only its prompt, so it may run outside `cwd`. */
  | "prompt"
  /** Reads only its prompt and runs tool-free under the provider's isolation policy. */
  | "isolated"
  /** As `isolated`, in a T3-owned `cwd` that the isolation policy may write into. */
  | "isolatedWorkspace";

export const isIsolated = (needs: Needs): boolean =>
  needs === "isolated" || needs === "isolatedWorkspace";

/** One prompt for a provider to run. */
export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly needs: Needs;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  /** The user's attachments, already listed in the prompt. Providers that accept images send them. */
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly onActivity?: RevdocGenerationInput["onActivity"];
}

/** Runs one request and decodes the reply as its `outputSchema`. */
export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/** Decodes the JSON object in a text reply, which models often wrap in prose. */
export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  // Each request builds its own output schema, so the decoder cannot be hoisted.
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

// Metadata prompts finish in seconds. Document passes read large inputs and write
// long structured output, so they get room to work; cancelling still ends them.
const METADATA_TIMEOUT = Duration.minutes(3);
const DOCUMENT_TIMEOUT = Duration.minutes(30);

/** The text generation service over `run`. `name` prefixes each operation's span. */
export function fromRunner(
  name: string,
  run: Runner,
): TextGeneration.TextGeneration["Service"] &
  Required<
    Pick<TextGeneration.TextGeneration["Service"], "generateRevdoc" | "generateIdeaUpdate">
  > {
  const runTask = <S extends Schema.Top>(request: Request<S>, timeout: Duration.Duration) =>
    run(request).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new TextGenerationError({
              operation: request.operation,
              detail: "Text generation timed out.",
            }),
          ),
      }),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn(`${name}.generateCommitMessage`)(function* (input) {
      const generated = yield* runTask(
        {
          operation: "generateCommitMessage",
          needs: "checkout",
          cwd: input.cwd,
          modelSelection: input.modelSelection,
          ...buildCommitMessagePrompt({
            branch: input.branch,
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
            includeBranch: input.includeBranch === true,
            policy: input.policy,
          }),
        },
        METADATA_TIMEOUT,
      );
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn(`${name}.generatePrContent`)(function* (input) {
      const generated = yield* runTask(
        {
          operation: "generatePrContent",
          needs: "checkout",
          cwd: input.cwd,
          modelSelection: input.modelSelection,
          ...buildPrContentPrompt({
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            commitSummary: input.commitSummary,
            diffSummary: input.diffSummary,
            diffPatch: input.diffPatch,
            policy: input.policy,
            changeRequestTemplate: input.changeRequestTemplate,
          }),
        },
        METADATA_TIMEOUT,
      );
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn(`${name}.generateBranchName`)(function* (input) {
      const generated = yield* runTask(
        {
          operation: "generateBranchName",
          needs: "checkout",
          cwd: input.cwd,
          modelSelection: input.modelSelection,
          attachments: input.attachments,
          ...buildBranchNamePrompt({
            message: input.message,
            attachments: input.attachments,
            naming: input.naming,
          }),
        },
        METADATA_TIMEOUT,
      );
      return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn(`${name}.generateThreadTitle`)(function* (input) {
      const generated = yield* runTask(
        {
          operation: "generateThreadTitle",
          needs: "prompt",
          cwd: input.cwd,
          modelSelection: input.modelSelection,
          attachments: input.attachments,
          ...buildThreadTitlePrompt({
            message: input.message,
            previousTitle: input.previousTitle,
            linkedContext: input.linkedContext,
            attachments: input.attachments,
          }),
        },
        METADATA_TIMEOUT,
      );
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  return {
    generateRevdoc: (input: RevdocGenerationInput) =>
      runTask(
        {
          operation: "generateRevdoc",
          needs: "isolated",
          cwd: input.cwd,
          prompt: input.prompt,
          outputSchema: RevdocGenerationResult,
          modelSelection: input.modelSelection,
          ...(input.onActivity ? { onActivity: input.onActivity } : {}),
        },
        DOCUMENT_TIMEOUT,
      ),
    generateIdeaUpdate: (input: IdeaUpdateInput) =>
      runTask(
        {
          operation: "generateIdeaUpdate",
          needs: "isolatedWorkspace",
          cwd: input.cwd,
          prompt: input.prompt,
          outputSchema: IdeaUpdateGenerationResult,
          modelSelection: input.modelSelection,
        },
        DOCUMENT_TIMEOUT,
      ).pipe(Effect.map(normalizeIdeaUpdateResult)),
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
}
