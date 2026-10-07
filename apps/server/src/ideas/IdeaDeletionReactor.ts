import { IdeaPromotion } from "./IdeaPromotion.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ProviderEventLoggers } from "../provider/ProviderEventLoggers.ts";
import { CommandId, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";
import { forkParked } from "../serverActivation.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { IdeaRuntime } from "./IdeaRuntime.ts";
import { IdeaUpdateReactor } from "./IdeaUpdateReactor.ts";
import { closeIdea } from "./IdeaLifecycle.ts";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";

export class IdeaDeletionReactor extends Context.Service<
  IdeaDeletionReactor,
  {
    start: () => Effect.Effect<void, never, Scope.Scope>;
    drain: Effect.Effect<void>;
  }
>()("t3/ideas/IdeaDeletionReactor") {
  static readonly layer = Layer.effect(
    IdeaDeletionReactor,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const store = yield* IdeaNotebookStore;
      const runtime = yield* IdeaRuntime;
      const updater = yield* IdeaUpdateReactor;
      const promotion = yield* IdeaPromotion;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const crypto = yield* Crypto.Crypto;
      const provider = yield* ProviderSessionManagerV2;
      const projections = yield* ProjectionStoreV2;
      const logs = yield* ProviderEventLoggers;
      const mcp = yield* McpSessionRegistry;
      const close = (threadId: ThreadId) =>
        closeIdea(threadId).pipe(
          Effect.provideService(ProviderSessionManagerV2, provider),
          Effect.provideService(ProjectionStoreV2, projections),
          Effect.provideService(ProviderEventLoggers, logs),
          Effect.provideService(IdeaPromotion, promotion),
          Effect.provideService(McpSessionRegistry, mcp),
        );
      const removeAttachments = Effect.fn("IdeaDeletionReactor.removeAttachments")(function* (
        threadId: ThreadId,
      ) {
        const segment = toSafeThreadAttachmentSegment(threadId);
        if (!(yield* fs.exists(config.attachmentsDir))) return;
        const entries = yield* fs.readDirectory(config.attachmentsDir);
        for (const entry of entries) {
          const attachmentId = entry.slice(0, entry.lastIndexOf("."));
          if (attachmentId && parseThreadSegmentFromAttachmentId(attachmentId) === segment) {
            yield* fs.remove(path.join(config.attachmentsDir, entry), { force: true });
          }
        }
      });
      const process = Effect.fn("IdeaDeletionReactor.process")(function* (threadId: ThreadId) {
        const notebook = yield* store.get(threadId);
        if (!notebook || notebook.status !== "deleting") return;
        yield* updater.cancel(threadId);
        yield* promotion.cancel(threadId);
        yield* close(threadId);
        yield* runtime.removeOwned(threadId);
        yield* removeAttachments(threadId);
        yield* engine.dispatch({
          type: "idea.purge",
          commandId: CommandId.make(`idea-purge:${yield* crypto.randomUUIDv4}`),
          threadId,
          deletionEpoch: notebook.deletionEpoch,
        });
      });
      const safeProcess = (threadId: ThreadId) =>
        process(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) return;
              const notebook = yield* store.get(threadId).pipe(Effect.orElseSucceed(() => null));
              if (!notebook || notebook.status !== "deleting") return;
              yield* engine
                .dispatch({
                  type: "idea.apply",
                  commandId: CommandId.make(`idea-delete-failed:${yield* crypto.randomUUIDv4}`),
                  threadId,
                  deletionEpoch: notebook.deletionEpoch,
                  mutation: {
                    kind: "delete.fail",
                    error: "Deletion could not finish. Retry to remove the remaining idea data.",
                  },
                })
                .pipe(Effect.ignore);
              yield* Effect.logWarning("Idea deletion did not finish", { threadId });
            }),
          ),
        );
      const worker = yield* makeDrainableWorker(safeProcess);
      const start = Effect.fn("IdeaDeletionReactor.start")(function* () {
        const events = yield* engine.subscribeDomainEvents;
        yield* forkParked(
          Effect.gen(function* () {
            const pending = yield* store.pending().pipe(Effect.orElseSucceed(() => []));
            for (const notebook of pending)
              if (notebook.status === "deleting") yield* worker.enqueue(notebook.threadId);
            yield* events.pipe(
              Stream.runForEach((event) => {
                if (
                  event.type === "idea.changed" &&
                  event.payload.mutation.kind === "delete.request"
                )
                  return worker.enqueue(event.payload.threadId);
                if (
                  event.type === "idea.changed" &&
                  event.payload.mutation.kind === "artifact.delete"
                )
                  return runtime
                    .removeArtifact(event.payload.threadId, event.payload.mutation.id)
                    .pipe(
                      Effect.catch(() =>
                        Effect.logWarning("Could not remove an idea artifact", {
                          threadId: event.payload.threadId,
                        }),
                      ),
                    );
                return Effect.void;
              }),
            );
          }),
        );
      });
      return IdeaDeletionReactor.of({ start, drain: worker.drain });
    }),
  );
}
