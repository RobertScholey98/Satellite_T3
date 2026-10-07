import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { IdeaNotebookStore } from "../ideas/IdeaNotebookStore.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { layer as SatelliteTestLayer, recordProject } from "./testkit/SatelliteTestRuntime.ts";

const layer = SatelliteTestLayer.pipe(Layer.provideMerge(NodeServices.layer));
const threadId = ThreadId.make("thread:idea-policy");
const projectId = ProjectId.make("project:idea-policy");
const create = {
  type: "thread.create" as const,
  commandId: CommandId.make("command:idea-policy:create"),
  threadId,
  projectId,
  purpose: "idea" as const,
  title: "An idea",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
};

it.effect.each([
  { branch: "implementation" },
  { worktreePath: "/repo/worktree" },
  {
    importedNativeThread: {
      ref: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "native:work",
        strength: "strong" as const,
      },
    },
  },
])("rejects idea creation with implementation workspace or imported history %j", (fields) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const notebooks = yield* IdeaNotebookStore;
    yield* recordProject({ projectId, title: "Project", workspaceRoot: "/repo" });
    const failure = yield* orchestrator.dispatch({ ...create, ...fields }).pipe(Effect.flip);
    assert.equal(failure._tag, "OrchestratorDispatchError");
    assert.isNull(yield* notebooks.get(threadId));
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps work lifecycle, workspace, pull request, and history commands out of ideas", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const notebooks = yield* IdeaNotebookStore;
    yield* recordProject({ projectId, title: "Project", workspaceRoot: "/repo" });
    yield* orchestrator.dispatch(create);
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    const base = { commandId: CommandId.make("command:idea-policy:blocked"), threadId };
    const commands = [
      { ...base, type: "thread.delete" },
      { ...base, type: "thread.archive" },
      { ...base, type: "thread.unarchive" },
      { ...base, type: "thread.settle" },
      { ...base, type: "thread.unsettle", reason: "user" },
      { ...base, type: "thread.auto-settle", snapshotAt: yield* DateTime.now },
      { ...base, type: "thread.snooze", snoozedUntil: "2026-12-01T00:00:00.000Z" },
      { ...base, type: "thread.unsnooze", reason: "user" },
      { ...base, type: "thread.pin" },
      { ...base, type: "thread.unpin" },
      { ...base, type: "thread.pin.reorder", orderKey: "m" },
      { ...base, type: "thread.active.reorder", orderKey: "m" },
      { ...base, type: "thread.auto-settle.set", enabled: true },
      { ...base, type: "thread.runtime-mode.set", runtimeMode: "approval-required" },
      { ...base, type: "thread.interaction-mode.set", interactionMode: "plan" },
      { ...base, type: "thread.metadata.update", branch: null },
      { ...base, type: "thread.metadata.update", worktreePath: null },
      { ...base, type: "thread.metadata.update", linkedPullRequest: null },
      {
        ...base,
        type: "thread.pull-request.link",
        host: "github.com",
        repository: "satellite/project",
        number: 1,
        url: "https://github.com/satellite/project/pull/1",
        source: "manual",
      },
      {
        ...base,
        type: "thread.pull-request.unlink",
        host: "github.com",
        repository: "satellite/project",
        number: 1,
      },
      {
        ...base,
        type: "checkpoint.rollback",
        scopeId: CheckpointScopeId.make("scope:idea"),
        checkpointId: CheckpointId.make("checkpoint:idea"),
      },
      {
        ...base,
        type: "message.dispatch",
        messageId: MessageId.make("message:idea-policy:prepared"),
        text: "Explore",
        attachments: [],
        dispatchMode: {
          type: "defer_start",
          workspaceStrategy: { type: "worktree", baseRef: "main" },
        },
        createdBy: "user",
        creationSource: "web",
      },
    ] satisfies ReadonlyArray<OrchestrationV2Command>;
    for (const [index, command] of commands.entries()) {
      const commandId = CommandId.make(`command:idea-policy:blocked:${index}`);
      const failure = yield* orchestrator.dispatch({ ...command, commandId }).pipe(Effect.flip);
      assert.equal(failure._tag, "OrchestratorDispatchError");
      assert.deepStrictEqual(
        yield* sql`
        SELECT status FROM orchestration_command_receipts WHERE command_id = ${commandId}
      `,
        [{ status: "rejected" }],
      );
    }
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
    assert.isNull((yield* projections.getThread(threadId)).deletedAt);
    assert.equal((yield* notebooks.get(threadId))?.status, "active");
    yield* orchestrator.dispatch({
      ...base,
      commandId: CommandId.make("command:idea-policy:title"),
      type: "thread.metadata.update",
      title: "Edited idea",
    });
    yield* orchestrator.dispatch({
      ...base,
      commandId: CommandId.make("command:idea-policy:delete"),
      type: "idea.delete",
    });
    assert.equal((yield* notebooks.get(threadId))?.status, "deleting");
  }).pipe(Effect.provide(layer)),
);
