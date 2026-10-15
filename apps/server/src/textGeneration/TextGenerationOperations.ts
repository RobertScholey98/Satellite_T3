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
  /** As `isolated`, and `cwd` is a T3-owned idea workspace rather than the user's checkout. */
  | "isolatedWorkspace";

/** The needs of document tasks, which a provider must declare before it is given one. */
export type Isolation = Extract<Needs, "isolated" | "isolatedWorkspace">;

export const isIsolated = (needs: Needs): needs is Isolation =>
  needs === "isolated" || needs === "isolatedWorkspace";

/** The isolation each document task needs. */
const DOCUMENT_NEEDS = {
  generateRevdoc: "isolated",
  generateIdeaUpdate: "isolatedWorkspace",
} as const satisfies Record<string, Isolation>;

export type DocumentOperation = keyof typeof DOCUMENT_NEEDS;

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

/** One provider's text generation: its run step and the isolation that run step honours. */
export interface Provider {
  /** Prefixes the span of every request this provider runs. */
  readonly name: string;
  readonly run: Runner;
  readonly isolation: Effect.Effect<ReadonlySet<Isolation>>;
}

export const isolates = (...needs: ReadonlyArray<Isolation>) =>
  Effect.succeed<ReadonlySet<Isolation>>(new Set(needs));

/** Whether `provider` can be given `operation`; candidate selection reads this, not method presence. */
export const supports = (provider: Provider, operation: DocumentOperation) =>
  Effect.map(provider.isolation, (isolation) => isolation.has(DOCUMENT_NEEDS[operation]));

/** A document task refused because its provider cannot isolate it. Refused before any process starts. */
export class TextGenerationUnsupportedError extends Schema.TaggedError<TextGenerationUnsupportedError>()(
  "TextGenerationUnsupportedError",
  { operation: Schema.String, provider: Schema.String },
) {
  override get message(): string {
    return `${this.provider} cannot run ${this.operation} in isolation. Choose another provider.`;
  }
}

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

/**
 * The text generation service: every task composed over the provider `resolve`
 * returns for the request's model selection.
 */
export function fromProvider(
  resolve: (request: Request<Schema.Top>) => Effect.Effect<Provider, TextGenerationError>,
): TextGeneration.TextGeneration["Service"] {
  const withTimeout = <A, E, R>(
    operation: Operation,
    timeout: Duration.Duration,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(new TextGenerationError({ operation, detail: "Text generation timed out." })),
      }),
    );
  const runOn = <S extends Schema.Top>(provider: Provider, request: Request<S>) =>
    provider.run(request).pipe(Effect.withSpan(`${provider.name}.${request.operation}`));
  const runTask = <S extends Schema.Top>(request: Request<S>, timeout: Duration.Duration) =>
    withTimeout(
      request.operation,
      timeout,
      Effect.flatMap(resolve(request), (provider) => runOn(provider, request)),
    );
  const runDocument = <S extends Schema.Top>(
    request: Request<S> & { readonly operation: DocumentOperation },
  ) =>
    withTimeout(
      request.operation,
      DOCUMENT_TIMEOUT,
      Effect.gen(function* () {
        const provider = yield* resolve(request);
        if (!(yield* supports(provider, request.operation))) {
          return yield* new TextGenerationUnsupportedError({
            operation: request.operation,
            provider: provider.name,
          });
        }
        return yield* runOn(provider, request);
      }),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("TextGeneration.generateCommitMessage")(function* (input) {
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
    Effect.fn("TextGeneration.generatePrContent")(function* (input) {
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
    Effect.fn("TextGeneration.generateBranchName")(function* (input) {
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
    Effect.fn("TextGeneration.generateThreadTitle")(function* (input) {
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
      runDocument({
        operation: "generateRevdoc",
        needs: DOCUMENT_NEEDS.generateRevdoc,
        cwd: input.cwd,
        prompt: input.prompt,
        outputSchema: RevdocGenerationResult,
        modelSelection: input.modelSelection,
        ...(input.onActivity ? { onActivity: input.onActivity } : {}),
      }),
    generateIdeaUpdate: (input: IdeaUpdateInput) =>
      runDocument({
        operation: "generateIdeaUpdate",
        needs: DOCUMENT_NEEDS.generateIdeaUpdate,
        cwd: input.cwd,
        prompt: input.prompt,
        outputSchema: IdeaUpdateGenerationResult,
        modelSelection: input.modelSelection,
      }).pipe(Effect.map(normalizeIdeaUpdateResult)),
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
}
