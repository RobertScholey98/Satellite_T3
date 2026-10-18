import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as RevdocService from "./RevdocService.ts";

const keepRunning = <A, E, R>(
  name: string,
  stream: Stream.Stream<A, E, R>,
  handle: (value: A) => Effect.Effect<void>,
) =>
  Stream.runForEach(stream, handle).pipe(
    Effect.catchCause((cause) => Effect.logWarning(`Revdoc ${name} stopped`, { cause })),
    Effect.forkScoped({ startImmediately: true }),
  );

/**
 * Ties Reviews to their worktrees and testing passes to their child threads. Settled-worktree
 * cleanup removes worktrees with raw git and fires no domain event, so its report stream is the
 * signal; project removal is an application event; a testing child's run ending advances its pass.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const revdoc = yield* RevdocService.RevdocService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const cleanup = yield* StorageCleanup.StorageCleanup;
    const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

    yield* keepRunning("testing observer", threads.streamDomainEvents, revdoc.onOrchestrationEvent);
    yield* keepRunning("cleanup observer", cleanup.reports, (report) =>
      Effect.forEach(
        report?.entries ?? [],
        (entry) =>
          entry.kind === "worktree" && entry.outcome === "removed" && entry.path !== null
            ? revdoc.forgetWorktree(entry.path)
            : Effect.void,
        { discard: true },
      ),
    );
    yield* Effect.gen(function* () {
      yield* startup.awaitCommandReady;
      const afterSequence = yield* eventStore.latestApplicationSequence;
      yield* keepRunning(
        "project observer",
        eventStore.streamApplicationEvents({ afterSequence }),
        (stored) =>
          "aggregateKind" in stored && stored.type === "project.deleted"
            ? revdoc.forgetProject(stored.payload.projectId)
            : Effect.void,
      );
      yield* revdoc.recover;
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Revdoc startup recovery failed", { cause })),
      Effect.forkScoped,
    );
  }),
);
