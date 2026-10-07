import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  IdeaCategoryId,
  IdeaEntryId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ServerConfig } from "../config.ts";
import {
  layer as SatelliteTestLayer,
  recordProject,
  makeProviderAdapter,
  recordMessage,
  recordCompletedRun,
} from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";
import { ProcessRunner } from "../processRunner.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../provider/ProviderEventLoggers.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { IdeaRuntime } from "./IdeaRuntime.ts";
import { IdeaPromotion } from "./IdeaPromotion.ts";
import { IdeaUpdateReactor } from "./IdeaUpdateReactor.ts";
import { IdeaDeletionReactor } from "./IdeaDeletionReactor.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectService } from "../project/ProjectService.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodePostedIssue = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String, body: Schema.String })),
);

const threadId = ThreadId.make("workflow-idea");
const projectId = ProjectId.make("workflow-project");
const messageId = MessageId.make("workflow-message");
const instanceId = ProviderInstanceId.make("claude");
const now = "2026-09-30T12:00:00.000Z";
const unused = () => Effect.die("Unexpected provider operation in notebook workflow");

it.effect.each([
  {
    deletionMode: "idea",
    modelSource: "configured",
    driver: "codex",
    model: "custom-update-model",
  },
  { deletionMode: "project", modelSource: "automatic", driver: "grok", model: "grok-build" },
  {
    deletionMode: "idea",
    modelSource: "automatic",
    driver: "claudeAgent",
    model: "claude-haiku-4-5",
  },
  { deletionMode: "project", modelSource: "fallback", driver: "cursor", model: "composer-2" },
] as const)(
  "maintains, promotes, settles, reopens and permanently deletes via $deletionMode using $modelSource $driver updates",
  ({ deletionMode, modelSource, driver, model }) =>
    Effect.gen(function* () {
      const driverKind = ProviderDriverKind.make(driver);
      const updateModelSelection = {
        instanceId,
        model,
        ...(modelSource === "configured"
          ? { options: [{ id: "reasoningEffort", value: "high" }] }
          : {}),
      };
      let generated = 0;
      let posted = 0;
      let published: { number: number; title: string; body: string; html_url: string } | null =
        null;
      const provider: ProviderInstance = {
        instanceId,
        driverKind,
        continuationIdentity: { driverKind, continuationKey: "workflow" },
        displayName: "Claude",
        enabled: true,
        snapshot: {
          resolveMaintenance: unused,
          getSnapshot: unused(),
          refresh: unused(),
          streamChanges: Stream.empty,
          applyUsageLimits: unused,
        },
        orchestrationAdapter: makeProviderAdapter(instanceId, driverKind),
        textGeneration: {
          generateBranchName: unused,
          generateCommitMessage: unused,
          generatePrContent: unused,
          generateThreadTitle: unused,
          generateIdeaUpdate: (input) =>
            Effect.sync(() => {
              assert.deepEqual(input.modelSelection, updateModelSelection);
              assert.include(input.prompt, '"edits"');
              assert.include(input.prompt, '"baseRevision"');
              assert.include(input.prompt, "Assistant decision from two chunks.");
              generated++;
              return {
                summary: "Organised the creation flow.",
                edits:
                  generated === 1
                    ? [
                        {
                          kind: "entry.save" as const,
                          id: IdeaEntryId.make("creation"),
                          categoryId: IdeaCategoryId.make("notes"),
                          title: "Creation flow",
                          baseRevision: 0,
                          markdown: "Create ideas from the home composer.",
                          sources: [{ kind: "message" as const, messageId }],
                        },
                        {
                          kind: "pitch.save" as const,
                          baseRevision: 0,
                          markdown:
                            "A notebook with an agent-first [creation flow](idea-entry:creation).",
                        },
                      ]
                    : [],
              };
            }),
        },
      };
      const runner = Layer.succeed(ProcessRunner, {
        run: (input) =>
          Effect.gen(function* () {
            let stdout = "";
            let code = 0;
            if (input.command === "git") {
              if (input.args.includes("symbolic-ref")) code = 1;
              else if (input.args.includes("rev-parse")) stdout = "a".repeat(40);
              else throw new Error("Unexpected Git command " + input.args.join(" "));
            } else if (input.command === "gh") {
              if (input.args[0] === "repo")
                stdout = yield* encodeJson({
                  nameWithOwner: "example/ideas",
                  hasIssuesEnabled: true,
                  isArchived: false,
                });
              else if (input.args.includes("POST")) {
                posted++;
                const data = yield* decodePostedIssue(input.stdin ?? "{}").pipe(Effect.orDie);
                published = {
                  number: posted,
                  title: data.title,
                  body: data.body,
                  html_url: "https://github.com/example/ideas/issues/" + posted,
                };
                stdout = yield* encodeJson(published);
              } else if (input.args.some((arg) => arg.includes("?state=all")))
                stdout = yield* encodeJson(published ? [published] : []);
              else stdout = yield* encodeJson(published);
            } else throw new Error("Unexpected process " + input.command);
            return {
              code: ChildProcessSpawner.ExitCode(code),
              stdout,
              stderr: "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      });
      const layer = IdeaDeletionReactor.layer.pipe(
        Layer.provideMerge(IdeaUpdateReactor.layer),
        Layer.provideMerge(IdeaPromotion.layer),
        Layer.provideMerge(IdeaRuntime.layer),
        Layer.provideMerge(SatelliteTestLayer),
        Layer.provide(
          Layer.succeed(RepositoryIdentityResolver, {
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/example/ideas",
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: "https://github.com/example/ideas.git",
                },
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              ideaUpdatesModelSelection: modelSource === "configured" ? updateModelSelection : null,
            }),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderInstanceRegistry)({
            listInstances: Effect.succeed([
              ...(modelSource === "fallback"
                ? []
                : [
                    {
                      ...provider,
                      instanceId: ProviderInstanceId.make("other-provider"),
                      driverKind: ProviderDriverKind.make("opencode"),
                      textGeneration: { ...provider.textGeneration, generateIdeaUpdate: unused },
                    },
                  ]),
              provider,
            ]),
            getInstance: () => Effect.succeed(provider),
          }),
        ),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
        Layer.provide(runner),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "idea-workflow-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const store = yield* IdeaNotebookStore;
        const projections = yield* ProjectionStoreV2;
        const projects = yield* ProjectService;
        const updates = yield* IdeaUpdateReactor;
        const promotion = yield* IdeaPromotion;
        const deletion = yield* IdeaDeletionReactor;
        const runtime = yield* IdeaRuntime;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const waitFor = Effect.fn(function* (predicate: (event: OrchestrationEvent) => boolean) {
          const stream = yield* engine.subscribeDomainEvents;
          return yield* stream.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
        });
        yield* updates.start();
        yield* promotion.start();
        yield* deletion.start();
        yield* recordProject({
          projectId,
          title: "Project",
          workspaceRoot: config.stateDir,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("idea"),
          threadId,
          projectId,
          purpose: "idea",
          title: "Agent notebook",
          modelSelection: {
            instanceId:
              modelSource === "fallback" ? ProviderInstanceId.make("removed-provider") : instanceId,
            model: "thread-model",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        yield* recordMessage({
          threadId,
          messageId,
          text: "Create ideas through the home composer.",
          role: "user",
        });
        assert.equal((yield* store.get(threadId))?.update.status, "waiting");
        yield* recordMessage({
          threadId,
          messageId: MessageId.make("assistant"),
          role: "assistant",
          text: "Assistant decision ",
          streaming: true,
        });
        yield* recordMessage({
          threadId,
          messageId: MessageId.make("assistant"),
          role: "assistant",
          text: "Assistant decision from two chunks.",
        });

        const updated = yield* waitFor(
          (event) =>
            event.type === "idea.changed" &&
            (event.payload.mutation.kind === "update.apply" ||
              event.payload.mutation.kind === "update.fail"),
        );
        yield* recordCompletedRun(threadId);
        yield* Fiber.join(updated);
        yield* updates.drain;
        assert.equal((yield* store.get(threadId))?.entries.length, 1);
        assert.include((yield* store.get(threadId))?.pitch.markdown ?? "", "idea-entry:creation");
        assert.equal((yield* projections.getShellSnapshot()).threads.length, 0);
        const plan = yield* promotion.propose({
          threadId,
          drafts: [
            {
              id: "build",
              title: "Build idea notebook",
              body: "Create ideas through the home composer. Keep one discussion thread and an editable notebook.",
              labels: [],
            },
          ],
          remainingScope: "",
        });
        assert.equal(posted, 0);
        const publishedEvent = yield* waitFor(
          (event) =>
            event.type === "idea.changed" &&
            event.payload.mutation.kind === "promotion.record" &&
            event.payload.mutation.promotion.status === "complete",
        );
        yield* engine.dispatch({
          type: "idea.edit",
          commandId: CommandId.make("approve"),
          threadId,
          edit: { kind: "promotion.approve", id: plan.id, sourceRevision: plan.sourceRevision },
        });
        yield* Fiber.join(publishedEvent);
        yield* promotion.drain;
        assert.equal(posted, 1);
        assert.equal((yield* store.get(threadId))?.status, "settled");
        yield* recordMessage({
          threadId,
          messageId: MessageId.make("followup"),
          role: "user",
          text: "Explore a later improvement.",
        });
        assert.equal((yield* store.get(threadId))?.status, "active");
        yield* runtime.writeArtifact({
          threadId,
          name: "notes.md",
          mediaType: "text/markdown",
          contentBase64: Buffer.from("Owned document").toString("base64"),
        });
        const revdocThreadId = ThreadId.make(`${threadId}:review`);
        if (deletionMode === "project") {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("review-thread"),
            threadId: revdocThreadId,
            projectId,
            purpose: "revdoc",
            title: "Document review",
            createdBy: "system",
            creationSource: "server",
            modelSelection: { instanceId, model: "review-model" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          assert.equal((yield* projections.getShellSnapshot()).threads.length, 0);
        }
        const purged = yield* waitFor((event) => event.type === "idea.purged");
        if (deletionMode === "project")
          yield* projects.delete({ commandId: CommandId.make("delete"), projectId, force: true });
        else
          yield* engine.dispatch({
            type: "idea.delete",
            commandId: CommandId.make("delete"),
            threadId,
          });
        yield* Fiber.join(purged);
        yield* deletion.drain;
        if (deletionMode === "project")
          assert.equal(yield* projections.getThreadShell(revdocThreadId), null);
        assert.equal(yield* store.get(threadId), null);
        assert.equal(yield* store.isDeleted(threadId), true);
        assert.isFalse(
          yield* fs.exists(
            path.join(config.stateDir, "ideas", Buffer.from(threadId).toString("base64url")),
          ),
        );
        assert.equal(posted, 1);
      }).pipe(Effect.provide(layer));
    }),
);
