import { createModelSelection } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";
import {
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  CommandId,
  type IdeaSystemMutation,
  type IdeaSource,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { ideaActivityDiscussion } from "./IdeaDiscussion.ts";
import { IdeaRuntime, IdeaRuntimeError, isIdeaTextDocument } from "./IdeaRuntime.ts";
import {
  IDEA_UPDATE_INSTRUCTIONS,
  IDEA_UPDATE_OUTPUT_SCHEMA,
  IDEA_UPDATE_MESSAGE_CHARS,
  IDEA_UPDATE_DOCUMENT_CHARS,
  IDEA_UPDATE_PROMPT_BYTES,
  boundIdeaUpdateContext,
  validateIdeaUpdateProjection,
  validateIdeaUpdateSources,
  validateIdeaUpdateCoverage,
} from "./IdeaUpdateGeneration.ts";

const encodeUpdateContext = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class IdeaUpdateReactor extends Context.Service<
  IdeaUpdateReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly cancel: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/ideas/IdeaUpdateReactor") {
  static readonly layer = Layer.effect(
    IdeaUpdateReactor,
    Effect.gen(function* () {
      const store = yield* IdeaNotebookStore;
      const runtime = yield* IdeaRuntime;
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const events = yield* OrchestrationEventStore;
      const settings = yield* ServerSettingsService;
      const providers = yield* ProviderInstanceRegistry;
      const crypto = yield* Crypto.Crypto;
      const running = new Map<ThreadId, Fiber.Fiber<void>>();
      const cancelled = new Set<ThreadId>();
      const apply = Effect.fn("IdeaUpdateReactor.apply")(function* (
        threadId: ThreadId,
        deletionEpoch: number,
        mutation: IdeaSystemMutation,
      ) {
        yield* engine.dispatch({
          type: "idea.apply",
          threadId,
          deletionEpoch,
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          mutation,
        });
      });
      const update = Effect.fn("IdeaUpdateReactor.update")(function* (threadId: ThreadId) {
        const initial = yield* store.get(threadId);
        if (
          !initial ||
          initial.status === "deleting" ||
          !["pending", "running"].includes(initial.update.status) ||
          cancelled.has(threadId)
        )
          return;
        const runId = yield* crypto.randomUUIDv4;
        yield* apply(threadId, initial.deletionEpoch, { kind: "update.start", runId });
        yield* Effect.gen(function* () {
          const notebook = yield* store.requireActive(threadId);
          const thread = yield* snapshots.getThreadShellById(threadId);
          const initialTitle = notebook.update.processedSequence === 0 ? thread : Option.none();
          const selected = (yield* settings.getSettings).ideaUpdatesModelSelection;
          const candidates = selected
            ? []
            : (yield* providers.listInstances).filter(
                (instance) => instance.enabled && instance.textGeneration.generateIdeaUpdate,
              );
          const automatic =
            candidates.find(
              (instance) =>
                Option.isSome(thread) &&
                instance.instanceId === thread.value.modelSelection.instanceId,
            ) ?? candidates[0];
          const defaultModel = automatic
            ? (DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[automatic.driverKind] ??
              DEFAULT_MODEL_BY_PROVIDER[automatic.driverKind])
            : undefined;
          const modelSelection =
            selected ??
            (automatic && defaultModel
              ? createModelSelection(automatic.instanceId, defaultModel)
              : undefined);
          if (!modelSelection)
            return yield* new IdeaRuntimeError({
              message:
                "Choose an enabled model in Settings → Idea updates, then retry this notebook update.",
            });
          const provider = yield* providers.getInstance(modelSelection.instanceId);
          if (!provider?.enabled || !provider.textGeneration.generateIdeaUpdate)
            return yield* new IdeaRuntimeError({
              message:
                "The selected provider is unavailable for idea updates. Choose an enabled model in Settings → Idea updates.",
            });
          const cwd = yield* runtime.workingDirectory(threadId);
          const sourceEvents = yield* events
            .readAggregateRange({
              aggregateKind: "thread",
              aggregateId: threadId,
              fromSequenceExclusive: 0,
              toSequenceInclusive: notebook.update.requestedSequence,
            })
            .pipe(
              Stream.filter(
                (event) =>
                  event.type === "thread.message-sent" ||
                  event.type === "thread.activity-appended" ||
                  (event.type === "idea.changed" &&
                    event.payload.mutation.kind === "artifact.register"),
              ),
              Stream.runCollect,
            );
          const sourceSequences = new Map<string, number>();
          const discussion = new Map<
            string,
            {
              id: string;
              source: IdeaSource;
              sequence: number;
              role: string;
              text: string;
              truncated: boolean;
            }
          >();
          const activities: OrchestrationThreadActivity[] = [];
          for (const event of sourceEvents) {
            if (event.type === "thread.message-sent") {
              sourceSequences.set("message:" + event.payload.messageId, event.sequence);
              const previous = discussion.get(event.payload.messageId);
              const replacing = !event.payload.streaming && event.payload.text.length > 0;
              const text =
                !previous || replacing
                  ? event.payload.text
                  : event.payload.streaming
                    ? previous.text + event.payload.text
                    : previous.text;
              discussion.set(event.payload.messageId, {
                id: event.payload.messageId,
                source: { kind: "message", messageId: event.payload.messageId },
                sequence: event.sequence,
                role: event.payload.role,
                text: text.slice(0, IDEA_UPDATE_MESSAGE_CHARS),
                truncated:
                  text.length > IDEA_UPDATE_MESSAGE_CHARS ||
                  (!replacing && previous?.truncated === true),
              });
            } else if (event.type === "thread.activity-appended") {
              activities.push({ ...event.payload.activity, sequence: event.sequence });
            } else if (
              event.type === "idea.changed" &&
              event.payload.mutation.kind === "artifact.register"
            )
              sourceSequences.set("artifact:" + event.payload.mutation.artifact.id, event.sequence);
          }
          const documents = yield* Effect.forEach(
            notebook.artifacts.filter((artifact) =>
              isIdeaTextDocument(artifact.mediaType, artifact.name),
            ),
            (artifact) =>
              runtime.readArtifact({ threadId, artifactId: artifact.id }).pipe(
                Effect.map((result) => {
                  const text = Buffer.from(result.contentBase64, "base64").toString("utf8");
                  return {
                    id: artifact.id,
                    name: artifact.name,
                    text: text.slice(0, IDEA_UPDATE_DOCUMENT_CHARS),
                    truncated: text.length > IDEA_UPDATE_DOCUMENT_CHARS,
                    sequence: sourceSequences.get("artifact:" + artifact.id) ?? 0,
                  };
                }),
              ),
          );
          const activityDiscussion = ideaActivityDiscussion(activities);
          for (const activity of activityDiscussion)
            sourceSequences.set("activity:" + activity.id, activity.sequence);
          const messages = [...discussion.values(), ...activityDiscussion].toSorted(
            (left, right) => left.sequence - right.sequence,
          );
          const context = boundIdeaUpdateContext(notebook, messages, documents);
          const incomplete = validateIdeaUpdateCoverage(
            notebook,
            messages,
            context,
            sourceSequences,
          );
          if (incomplete) return yield* new IdeaRuntimeError({ message: incomplete });
          const prompt = [
            IDEA_UPDATE_INSTRUCTIONS,
            "Return only a JSON object matching this schema:",
            yield* encodeUpdateContext(IDEA_UPDATE_OUTPUT_SCHEMA),
            "Notebook context:",
            yield* encodeUpdateContext(context),
          ].join("\n\n");
          if (Buffer.byteLength(prompt, "utf8") > IDEA_UPDATE_PROMPT_BYTES)
            return yield* new IdeaRuntimeError({
              message:
                "The combined notebook context exceeds the automatic update budget. The notebook remains behind; no unread input was marked processed.",
            });
          const result = yield* provider.textGeneration.generateIdeaUpdate({
            cwd,
            modelSelection,
            prompt,
          });
          const invalid =
            validateIdeaUpdateProjection(result.edits, context) ??
            validateIdeaUpdateSources(notebook, result.edits, sourceSequences);
          if (invalid) return yield* new IdeaRuntimeError({ message: invalid });
          if (cancelled.has(threadId)) return;
          yield* apply(threadId, initial.deletionEpoch, {
            kind: "update.apply",
            runId,
            throughSequence: notebook.update.requestedSequence,
            edits: result.edits,
            summary: result.summary,
          });
          if (
            result.title?.trim() &&
            Option.isSome(initialTitle) &&
            initialTitle.value.titleState?.source !== "manual"
          ) {
            yield* engine
              .dispatch({
                type: "thread.title.generate.complete",
                commandId: CommandId.make(yield* crypto.randomUUIDv4),
                threadId,
                title: result.title.trim(),
                expectedTitle: initialTitle.value.title,
                expectedVersion: initialTitle.value.titleState?.version ?? null,
                needsRefinement: false,
              })
              .pipe(
                Effect.catch((failure) =>
                  Effect.logWarning("Could not update idea title", {
                    threadId,
                    message: failure.message,
                  }),
                ),
              );
          }
        }).pipe(
          Effect.catch((failure) =>
            apply(threadId, initial.deletionEpoch, {
              kind: "update.fail",
              runId,
              error: failure.message,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });
      const queued = new Set<ThreadId>();
      const processQueued = (threadId: ThreadId) =>
        Effect.gen(function* () {
          queued.delete(threadId);
          if (cancelled.has(threadId)) return;
          const fiber = yield* update(threadId).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logWarning("Idea update failed", { threadId, cause: Cause.pretty(cause) }),
            ),
            Effect.forkScoped,
          );
          running.set(threadId, fiber);
          yield* Fiber.await(fiber);
          running.delete(threadId);
        });
      const workers = [
        yield* makeDrainableWorker(processQueued),
        yield* makeDrainableWorker(processQueued),
      ];
      const enqueue = (threadId: ThreadId) =>
        Effect.gen(function* () {
          if (queued.has(threadId) || cancelled.has(threadId)) return;
          queued.add(threadId);
          const shard = [...threadId].reduce(
            (hash, char) => (hash + char.charCodeAt(0)) % workers.length,
            0,
          );
          yield* workers[shard]!.enqueue(threadId);
        });
      const processEvent = Effect.fn("IdeaUpdateReactor.processEvent")(function* (
        event: OrchestrationEvent,
      ) {
        if (event.type === "thread.session-set" && event.payload.turnSettled) {
          yield* enqueue(event.payload.threadId);
        } else if (
          event.type === "idea.changed" &&
          (event.payload.mutation.kind.startsWith("entry.") ||
            event.payload.mutation.kind.startsWith("category.") ||
            [
              "update.request",
              "update.retry",
              "artifact.register",
              "artifact.delete",
              "update.apply",
              "proposal.accept",
              "update.undo",
            ].includes(event.payload.mutation.kind))
        ) {
          yield* enqueue(event.payload.threadId);
        }
      });
      const start = Effect.fn("IdeaUpdateReactor.start")(function* () {
        const stream = yield* engine.subscribeDomainEvents;
        yield* forkParked(Stream.runForEach(stream, processEvent));
        yield* forkParked(
          store.pending().pipe(
            Effect.flatMap((notebooks) =>
              Effect.forEach(
                notebooks.filter((notebook) => notebook.status !== "deleting"),
                (notebook) =>
                  Effect.gen(function* () {
                    if (notebook.update.status === "waiting")
                      yield* apply(notebook.threadId, notebook.deletionEpoch, {
                        kind: "update.request",
                        sequence: notebook.update.requestedSequence,
                      });
                    yield* enqueue(notebook.threadId);
                  }),
                { discard: true },
              ),
            ),
            Effect.catch((error) =>
              Effect.logWarning("Could not restore idea updates", { message: error.message }),
            ),
          ),
        );
      });
      const cancel = (threadId: ThreadId) =>
        Effect.gen(function* () {
          cancelled.add(threadId);
          const fiber = running.get(threadId);
          if (fiber) yield* Fiber.interrupt(fiber);
        });
      return IdeaUpdateReactor.of({
        start,
        drain: Effect.all(
          workers.map((worker) => worker.drain),
          { concurrency: "unbounded", discard: true },
        ),
        cancel,
      });
    }),
  );
}
