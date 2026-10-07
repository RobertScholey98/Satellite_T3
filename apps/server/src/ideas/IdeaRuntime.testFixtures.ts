import { ThreadId, type IdeaNotebook } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { OrchestratorCommandRejectedError } from "../orchestration-v2/Orchestrator.ts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/SatelliteOrchestration.ts";
import { applyIdeaMutation, createIdeaNotebook } from "./IdeaNotebook.ts";
import { IdeaNotebookStore, IdeaStoreError } from "./IdeaNotebookStore.ts";

export const testIdeaId = ThreadId.make("boundary-idea");
export const unusedIdeaSnapshots = ProjectionSnapshotQuery.of({
  getRequestLifecycle: () => Effect.die("unused"),
  getUserInputActivity: () => Effect.die("unused"),
  listThreadsWithCommitRecommendations: () => Effect.die("unused"),
  listThreadsWithPullRequests: () => Effect.die("unused"),
  getProjectShells: () => Effect.die("unused"),
  getProjectShellById: () => Effect.die("unused"),
  getThreadShellById: () => Effect.die("unused"),
  getThreadDetailById: () => Effect.die("unused"),
  getThreadDetailSnapshot: () => Effect.die("unused"),
});

export function ideaStateFixture() {
  let notebook: IdeaNotebook = createIdeaNotebook(testIdeaId, "2026-09-30T12:00:00.000Z");
  let sequence = 0;
  const store = IdeaNotebookStore.of({
    get: () => Effect.sync(() => notebook),
    requireActive: () =>
      Effect.suspend(() =>
        notebook.status === "deleting"
          ? Effect.fail(new IdeaStoreError({ message: "Idea deleted" }))
          : Effect.succeed(notebook),
      ),
    list: () => Effect.succeed([]),
    pending: () => Effect.succeed([]),
    isDeleted: () => Effect.sync(() => notebook.status === "deleting"),
    project: () => Effect.void,
    projectV2: () => Effect.void,
  });
  const engine = OrchestrationEngineService.of({
    dispatch: (command) =>
      Effect.try({
        try: () => {
          if (command.type !== "idea.apply") throw new Error("Unexpected command");
          if (command.deletionEpoch !== notebook.deletionEpoch) throw new Error("Idea deleted");
          notebook = applyIdeaMutation(
            notebook,
            command.mutation,
            "2026-09-30T12:00:01.000Z",
            ++sequence,
          );
          return { sequence };
        },
        catch: (cause) =>
          new OrchestratorCommandRejectedError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      }),
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    latestSequence: Effect.sync(() => sequence),
  });
  return {
    store,
    engine,
    get: () => notebook,
    set: (next: IdeaNotebook) => {
      notebook = next;
    },
  };
}
