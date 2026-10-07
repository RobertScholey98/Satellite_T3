import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProcessRunner } from "../processRunner.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { resolveIdeaMain } from "./IdeaMain.ts";
import {
  readIdeaExecution,
  setIdeaExecution,
  withIdeaLock,
  type IdeaExecutionContext,
} from "./IdeaExecution.ts";

export class IdeaWorkspaceError extends Schema.TaggedError<IdeaWorkspaceError>()(
  "IdeaWorkspaceError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Could not prepare the idea's isolated workspace.";
  }
}

export class IdeaWorkspace extends Context.Service<
  IdeaWorkspace,
  {
    readonly prepare: (
      threadId: ThreadId,
    ) => Effect.Effect<IdeaExecutionContext, IdeaWorkspaceError>;
  }
>()("t3/ideas/IdeaWorkspace") {}

const encodeContext = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const make = Effect.gen(function* () {
  const notebooks = yield* IdeaNotebookStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const config = yield* ServerConfig;
  const prepare = Effect.fn("IdeaWorkspace.prepare")((threadId: ThreadId) =>
    withIdeaLock(
      threadId,
      Effect.gen(function* () {
        const notebook = yield* notebooks.requireActive(threadId);
        const retained = readIdeaExecution(threadId);
        if (retained?.deletionEpoch === notebook.deletionEpoch) return retained;
        const thread = yield* projections.getThread(threadId);
        if (thread.purpose !== "idea") return yield* new IdeaWorkspaceError({ threadId });
        const project = yield* projects.get(thread.projectId);
        if (Option.isNone(project)) return yield* new IdeaWorkspaceError({ threadId });
        let cwd = yield* fs.realPath(config.stateDir);
        for (const segment of ["ideas", Buffer.from(threadId).toString("base64url")]) {
          cwd = path.join(cwd, segment);
          yield* fs.makeDirectory(cwd, { recursive: true });
          if (path.relative(cwd, yield* fs.realPath(cwd)) !== "")
            return yield* new IdeaWorkspaceError({ threadId });
        }
        const documents = path.join(cwd, "documents");
        yield* fs.makeDirectory(documents, { recursive: true });
        if (path.relative(documents, yield* fs.realPath(documents)) !== "")
          return yield* new IdeaWorkspaceError({ threadId });
        const mainRevision = yield* resolveIdeaMain(project.value.workspaceRoot).pipe(
          Effect.provideService(ProcessRunner, runner),
        );
        const history = yield* projections.getThreadRecords(threadId, ["messages"]);
        const context = yield* encodeContext({
          notebook: {
            revision: notebook.revision,
            mainRevision,
            pitch: { ...notebook.pitch, markdown: notebook.pitch.markdown.slice(0, 100_000) },
            pitchTruncated: notebook.pitch.markdown.length > 100_000,
            entries: notebook.entries.map(({ id, title, categoryId }) => ({
              id,
              title,
              categoryId,
            })),
            categories: notebook.categories,
            artifacts: notebook.artifacts,
            update: notebook.update,
          },
          messages: history.messages
            .slice(-20)
            .map((message) => ({ role: message.role, text: message.text.slice(0, 5000) })),
          omittedCount: Math.max(0, history.messages.length - 20),
        });
        const execution = {
          cwd,
          projectDirectory: project.value.workspaceRoot,
          mainRevision,
          deletionEpoch: notebook.deletionEpoch,
          context,
        };
        setIdeaExecution(threadId, execution);
        return execution;
      }).pipe(Effect.mapError((cause) => new IdeaWorkspaceError({ threadId, cause }))),
    ),
  );
  return IdeaWorkspace.of({ prepare });
});

export const layer = Layer.effect(IdeaWorkspace, make).pipe(Layer.provide(IdeaNotebookStore.layer));
