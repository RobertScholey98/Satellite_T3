import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  CodexSettings,
  EnvironmentId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationCommand,
  type RevdocReview,
  type RevdocRunState,
  DEFAULT_SERVER_SETTINGS,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
  type ModelSelection,
} from "@t3tools/contracts";
import * as OrchestrationEngine from "../orchestration-v2/SatelliteOrchestration.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectionSnapshotQuery from "../orchestration-v2/SatelliteOrchestration.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RevdocService from "./RevdocService.ts";
import type { RevdocGenerationInput, RevdocGenerationResult } from "./RevdocGeneration.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";

const threadId = ThreadId.make("review-thread");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeThreadShell = Schema.decodeSync(OrchestrationThreadShell);
const decodeProjectShell = Schema.decodeEffect(OrchestrationProjectShell);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const siblingId = ThreadId.make("same-worktree-thread");
const otherId = ThreadId.make("other-worktree-thread");
const defaultModel = { instanceId: ProviderInstanceId.make("codex"), model: "thread-model" };
const generated: RevdocGenerationResult = {
  title: "Worktree review",
  summary: "Changed behavior",
  context: "Review manually",
  sections: [
    {
      id: "area",
      area: "Area",
      items: [
        {
          id: "feature",
          name: "Feature",
          summary: "New feature",
          status: "done",
          prd: [],
          quirks: [],
          flags: [],
          endpoints: [],
          tests: [{ id: "check", title: "Open the feature", expected: "It opens" }],
        },
      ],
    },
  ],
};
const platform = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "revdoc-test-home-" })),
  Layer.provideMerge(NodeServices.layer),
);
const setup = (
  options: {
    model?: ModelSelection | null;
    largeModel?: ModelSelection | null;
    testingModel?: ModelSelection | null;
    defaultAction?: "generate" | "generate-and-test";
    generate?: (
      input: RevdocGenerationInput,
    ) => Effect.Effect<RevdocGenerationResult, TextGenerationError>;
    unavailable?: boolean;
    assumeDifferentOwner?: boolean;
    title?: () => string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-revdoc-" });
    const project = path.join(temp, "project");
    const worktree = path.join(temp, "feature");
    yield* fs.makeDirectory(project);
    const command = (cwd: string, args: readonly string[]) =>
      git.execute({ cwd, args, operation: "test", timeoutMs: 10_000 });
    yield* command(project, ["init", "-b", "main"]);
    yield* fs.writeFileString(path.join(project, "app.txt"), "Before\n");
    yield* command(project, ["add", "app.txt"]);
    yield* command(project, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Initial",
    ]);
    yield* command(project, ["worktree", "add", "-b", "feature", worktree]);
    yield* fs.writeFileString(path.join(worktree, "app.txt"), "After\n");
    const projectId = ProjectId.make("revdoc-project");
    const timestamp = "2026-10-04T12:00:00.000Z";
    const dispatched: OrchestrationCommand[] = [];
    // Threads created by the service (Revdoc testing threads) keep the
    // checkout they were created with, like the real projection.
    const shell = (id: ThreadId) => {
      const created = dispatched.find(
        (command) => command.type === "thread.create" && command.threadId === id,
      );
      return decodeThreadShell({
        id,
        projectId,
        title: options.title?.() ?? "Review work",
        modelSelection: defaultModel,
        runtimeMode: "full-access",
        ...(created?.type === "thread.create"
          ? { branch: created.branch, worktreePath: created.worktreePath }
          : { branch: "feature", worktreePath: id === otherId ? project : worktree }),
        latestTurn: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      });
    };
    const projectShell = yield* decodeProjectShell({
      id: projectId,
      title: "Project",
      workspaceRoot: project,
      defaultModelSelection: null,
      scripts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const calls: RevdocGenerationInput[] = [];
    const instance = {
      instanceId: defaultModel.instanceId,
      enabled: true,
      textGeneration: {
        generateRevdoc: (input: RevdocGenerationInput) => {
          calls.push(input);
          return options.generate?.(input) ?? Effect.succeed(generated);
        },
      },
    } as ProviderInstance;
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const starts = yield* Queue.unbounded<ThreadId>();
    const captured: string[] = [];
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=";
    const buildService = Layer.build(
      RevdocService.layer.pipe(
        Layer.provide(
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
            subscribeDomainEvents: PubSub.subscribe(events).pipe(
              Effect.map(Stream.fromSubscription),
            ),
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "thread.turn.start")
                  yield* Queue.offer(starts, command.threadId);
                return { sequence: dispatched.length };
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
            invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) =>
              Effect.sync(() => {
                captured.push(request.operation);
                return {
                  url: "http://localhost/test",
                  title: "Test",
                  loading: false,
                  visibleText: "Feature open",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: { mimeType: "image/png", data: png, width: 1, height: 1 },
                } as A;
              }),
          }),
        ),
        Layer.provide(
          Layer.succeed(GitVcsDriver.GitVcsDriver, {
            ...git,
            execute: (input) =>
              git.execute({
                ...input,
                ...(options.assumeDifferentOwner
                  ? { env: { ...input.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" } }
                  : {}),
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
            getThreadShellById: (id) => Effect.succeedSome(shell(id)),
            getProjectShellById: () => Effect.succeedSome(projectShell),
            getThreadDetailSnapshot: () => Effect.succeedNone,
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(options.unavailable ? undefined : instance),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              revdocModelSelection: options.model ?? null,
              revdocLargeModelSelection: options.largeModel ?? null,
              revdocTestingModelSelection: options.testingModel ?? null,
              revdocDefaultAction: options.defaultAction ?? "generate",
            }),
          }),
        ),
      ),
    );
    const services = yield* buildService;
    const service = Context.get(services, RevdocService.RevdocService);
    const finished = () =>
      service.changes({ threadId }).pipe(
        Stream.filter((state) => !state.running && state.version > 0),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    const settle = (
      id: ThreadId,
      settled = true,
      status: OrchestrationSession["status"] = "ready",
    ) =>
      PubSub.publish(events, {
        type: "thread.session-set",
        sequence: 1,
        eventId: EventId.make("test-event"),
        aggregateKind: "thread",
        aggregateId: id,
        occurredAt: timestamp,
        payload: {
          threadId: id,
          ...(settled ? { turnSettled: true } : {}),
          session: {
            threadId: id,
            status,
            activeTurnId: null,
            lastError: null,
            updatedAt: timestamp,
          },
        },
      });
    const tester = Effect.gen(function* () {
      const id = yield* Queue.take(starts);
      const detail = yield* service.get({ threadId });
      return {
        invocation: {
          environmentId: EnvironmentId.make("test"),
          thread: {
            threadId: id,
            providerSessionId: "session",
            providerInstanceId: defaultModel.instanceId,
          },
          client: undefined,
          requestNamespace: "test",
          capabilities: new Set(["documents", "preview"] as const),
          issuedAt: 0,
        } satisfies McpThreadInvocationScope,
        target: { runId: detail.review!.testing!.id, testId: "check" },
      };
    });
    const saveReview = (review: RevdocReview) =>
      fs.writeFileString(path.join(worktree, ".revdoc", "review.json"), encodeJson(review));
    return {
      fs,
      path,
      worktree,
      project,
      command,
      service,
      restart: buildService.pipe(
        Effect.map((context) => Context.get(context, RevdocService.RevdocService)),
      ),
      calls,
      finished,
      settle,
      tester,
      starts: Queue.take(starts),
      dispatched,
      captured,
      png,
      saveReview,
    };
  });

describe("worktree Revdoc service", () => {
  it.effect(
    "keeps provider resources alive after the start request ends and releases them after the pass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const requestEnded = yield* Deferred.make<void>();
        const cliDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "revdoc-provider-" });
        const cwdRecord = path.join(cliDirectory, "generation-cwd");
        const binaryPath = yield* Effect.sync(() =>
          writeFakeCli({
            directory: cliDirectory,
            name: "codex",
            source: [
              'import { readFileSync, writeFileSync } from "node:fs";',
              "const args = process.argv.slice(2);",
              'JSON.parse(readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));',
              "for await (const chunk of process.stdin) {}",
              `writeFileSync(${encodeJson(cwdRecord)}, process.cwd());`,
              `writeFileSync(args[args.indexOf("--output-last-message") + 1], ${encodeJson(encodeJson(generated))});`,
            ].join("\n"),
          }),
        );
        const generation = yield* makeCodexTextGeneration(
          yield* decodeCodexSettings({ binaryPath, homePath: cliDirectory }),
        );
        const env = yield* setup({
          generate: (input) =>
            Deferred.await(requestEnded).pipe(Effect.andThen(generation.generateRevdoc(input))),
        });
        yield* env.service.start({ threadId }).pipe(Effect.scoped);
        yield* Deferred.succeed(requestEnded, undefined);
        expect((yield* env.finished()).error).toBeNull();
        expect((yield* env.service.get({ threadId })).review?.title).toBe(generated.title);
        const generationCwd = yield* fs.readFileString(cwdRecord);
        expect(generationCwd).not.toBe(env.worktree);
        expect(yield* fs.exists(generationCwd)).toBe(false);
        expect(yield* fs.exists(path.join(env.worktree, ".codex-updates"))).toBe(false);
        expect(
          (yield* fs.readDirectory(env.worktree)).filter((name) =>
            name.startsWith("t3code-codex-"),
          ),
        ).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect(
    "prepares an unconfigured worktree before generation and keeps setup on cancellation",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const env = yield* setup({
          generate: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const directory = env.path.join(env.worktree, ".revdoc");
        expect(yield* env.fs.exists(directory)).toBe(false);
        yield* env.service.start({ threadId });
        yield* Deferred.await(entered);
        expect((yield* env.fs.stat(env.path.join(directory, "evidence"))).type).toBe("Directory");
        yield* env.fs.writeFileString(
          env.path.join(directory, "evidence", "capture.png"),
          "evidence",
        );
        expect((yield* env.command(env.worktree, ["status", "--porcelain"])).stdout).not.toContain(
          ".revdoc",
        );
        expect(yield* env.fs.exists(env.path.join(env.project, ".revdoc"))).toBe(false);
        yield* env.service.cancel({ threadId });
        expect((yield* env.finished()).result).toBe("cancelled");
        expect((yield* env.service.get({ threadId })).review).toBeNull();
        expect(yield* env.fs.exists(directory)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("preserves existing configuration and evidence on repeated passes", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const directory = env.path.join(env.worktree, ".revdoc");
      yield* env.fs.makeDirectory(env.path.join(directory, "evidence"), { recursive: true });
      const ignore = env.path.join(directory, ".gitignore");
      const config = env.path.join(directory, "config.json");
      const evidence = env.path.join(directory, "evidence", "capture.png");
      yield* env.fs.writeFileString(ignore, "# Keep local\n*\n");
      yield* env.fs.writeFileString(config, '{"policy":"manual"}');
      yield* env.fs.writeFileString(evidence, "existing evidence");
      for (let pass = 0; pass < 2; pass++) {
        yield* env.service.start({ threadId });
        expect((yield* env.finished()).result).toBe("completed");
      }
      expect(yield* env.fs.readFileString(ignore)).toBe("# Keep local\n*\n");
      expect(yield* env.fs.readFileString(config)).toBe('{"policy":"manual"}');
      expect(yield* env.fs.readFileString(evidence)).toBe("existing evidence");
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect(
    "explains Git's ownership rejection without running the provider or changing repository trust",
    () =>
      Effect.gen(function* () {
        const env = yield* setup({ assumeDifferentOwner: true });
        yield* env.service.start({ threadId });
        const state = yield* env.finished();
        expect(state.error).toContain("owned by another account");
        expect(state.error).toContain(env.worktree);
        expect(state.error).toContain("trust");
        expect(env.calls).toHaveLength(0);
        expect((yield* env.service.get({ threadId })).review).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("allows a new pass as soon as completion is reported", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      for (let pass = 0; pass < 2; pass++) {
        yield* env.service.start({ threadId });
        expect((yield* env.finished()).result).toBe("completed");
        expect(env.calls).toHaveLength(pass + 1);
      }
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("includes committed changes after Commit and untracked files in the pass", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      yield* env.command(env.worktree, ["add", "app.txt"]);
      yield* env.command(env.worktree, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "Feature",
      ]);
      yield* env.fs.writeFileString(env.path.join(env.worktree, "new.txt"), "New behavior");
      yield* env.service.start({ threadId, worktreePath: env.worktree });
      expect((yield* env.finished()).result).toBe("completed");
      expect(env.calls[0]?.prompt).toContain("+After");
      expect(env.calls[0]?.prompt).toContain("New behavior");
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("lists every checked-out worktree of the thread's repository", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const detached = env.path.join(env.path.dirname(env.project), "detached");
      yield* env.command(env.project, ["worktree", "add", "--detach", detached]);
      const listing = yield* env.service.worktrees({ threadId });
      expect(listing.defaultPath).toBe(yield* env.fs.realPath(env.worktree));
      expect(listing.worktrees).toHaveLength(3);
      expect(listing.worktrees).toEqual(
        expect.arrayContaining([
          { path: yield* env.fs.realPath(env.project), branch: "main" },
          { path: yield* env.fs.realPath(env.worktree), branch: "feature" },
          { path: yield* env.fs.realPath(detached), branch: null },
        ]),
      );
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("reviews and tests a selected worktree other than the thread's own", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const selected = yield* env.fs.realPath(env.project);
      yield* env.fs.writeFileString(env.path.join(env.project, "main.txt"), "Main checkout work");
      const input = { threadId, worktreePath: env.project };
      yield* env.service.start(input);
      expect(
        (yield* env.service.changes(input).pipe(
          Stream.filter((state) => !state.running && state.version > 0),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        )).result,
      ).toBe("completed");
      expect(env.calls[0]?.cwd).toBe(selected);
      expect(env.calls[0]?.prompt).toContain("Main checkout work");
      expect((yield* env.service.get(input)).cwd).toBe(selected);
      expect((yield* env.service.get({ threadId })).review).toBeNull();
      yield* env.service.startTesting({ ...input, selection: "all" });
      const testingThreadId = yield* env.starts;
      expect(env.dispatched.find((command) => command.type === "thread.create")).toMatchObject({
        branch: "main",
        worktreePath: selected,
      });
      const detail = yield* env.service.get(input);
      const invocation = {
        environmentId: EnvironmentId.make("test"),
        thread: {
          threadId: testingThreadId,
          providerSessionId: "session",
          providerInstanceId: defaultModel.instanceId,
        },
        client: undefined,
        requestNamespace: "test",
        capabilities: new Set(["documents", "preview"] as const),
        issuedAt: 0,
      } satisfies McpThreadInvocationScope;
      yield* env.service.beginTest(invocation, {
        runId: detail.review!.testing!.id,
        testId: "check",
      });
      yield* env.service.cancel(input);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("rejects a selected folder that is not a worktree of the thread's repository", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const outside = yield* env.fs.makeTempDirectoryScoped({ prefix: "t3-revdoc-outside-" });
      yield* env.command(outside, ["init", "-b", "main"]);
      for (const worktreePath of [outside, env.path.join(outside, "missing")]) {
        const error = yield* env.service.start({ threadId, worktreePath }).pipe(Effect.flip);
        expect(error.message).toContain("selected worktree is unavailable");
      }
      expect(env.calls).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("accepts and republishes a review with more than 1,000 tests", () =>
    Effect.gen(function* () {
      const item = generated.sections[0]!.items[0]!;
      const tests = Array.from({ length: 1_001 }, (_, index) => ({
        id: `check-${index}`,
        title: `Check ${index}`,
        expected: "It passes",
      }));
      const env = yield* setup({
        generate: () =>
          Effect.succeed({
            ...generated,
            sections: [{ ...generated.sections[0]!, items: [{ ...item, tests }] }],
          }),
      });
      yield* env.service.start({ threadId });
      expect((yield* env.finished()).error).toBeNull();
      const result = yield* env.service.get({ threadId });
      expect(result.review?.sections[0]?.items[0]?.tests).toHaveLength(1_001);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("rejects invalid review files without replacing them", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const directory = env.path.join(env.worktree, ".revdoc");
      yield* env.fs.makeDirectory(directory);
      const file = env.path.join(directory, "review.json");
      yield* env.fs.writeFileString(file, "{");
      expect((yield* env.service.start({ threadId }).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* env.fs.readFileString(file)).toBe("{");
      expect(env.calls).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect(
    "generates in the selected worktree, shares it between threads, and keeps it out of Git",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.service.start({ threadId });
        expect((yield* env.finished()).error).toBeNull();
        const result = yield* env.service.get({ threadId: siblingId });
        expect(result.review?.title).toBe(generated.title);
        expect(result.cwd.replaceAll("\\", "/")).toBe(env.worktree.replaceAll("\\", "/"));
        expect(env.calls[0]?.modelSelection).toEqual(defaultModel);
        expect(env.calls[0]?.prompt).toContain("+After");
        expect((yield* env.service.get({ threadId: otherId })).review).toBeNull();
        expect((yield* env.command(env.worktree, ["status", "--porcelain"])).stdout).not.toContain(
          ".revdoc",
        );
        expect(result.review?.sections[0]?.items[0]?.tests[0]?.outcome).toBe("untested");
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("uses the configured model and prevents duplicate passes in the same worktree", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<RevdocGenerationResult>();
      const entered = yield* Deferred.make<void>();
      const configured = {
        instanceId: ProviderInstanceId.make("claude"),
        model: "configured-model",
        options: [{ id: "effort", value: "high" }],
      };
      const env = yield* setup({
        model: configured,
        generate: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
      });
      yield* env.service.start({ threadId });
      yield* Deferred.await(entered);
      yield* env.service.start({ threadId: siblingId });
      expect(env.calls).toHaveLength(1);
      expect(env.calls[0]?.modelSelection).toEqual(configured);
      yield* Deferred.succeed(gate, generated);
      expect((yield* env.finished()).error).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("persists human feedback and rejects stale saves from a second client", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      yield* env.service.start({ threadId });
      yield* env.finished();
      const initial = yield* env.service.get({ threadId });
      const change = {
        kind: "test" as const,
        id: "check",
        outcome: "broken" as const,
        feedback: "Cannot open",
      };
      const saved = yield* env.service.save({
        threadId,
        expectedRevision: initial.revision!,
        change,
      });
      expect(saved.revision).not.toBe(initial.revision);
      const stale = yield* env.service
        .save({
          threadId: siblingId,
          expectedRevision: initial.revision!,
          change: { ...change, outcome: "complete" },
        })
        .pipe(Effect.result);
      expect(stale._tag).toBe("Failure");
      const result = yield* env.service.get({ threadId: siblingId });
      expect(result.review?.sections[0]?.items[0]?.tests[0]).toMatchObject({
        outcome: "broken",
        feedback: "Cannot open",
      });
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("preserves a review edited while generation is running", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<RevdocGenerationResult>();
      const entered = yield* Deferred.make<void>();
      const env = yield* setup({
        generate: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
      });
      yield* env.service.start({ threadId });
      yield* Deferred.await(entered);
      yield* env.fs.writeFileString(
        env.path.join(env.worktree, ".revdoc", "review.json"),
        encodeJson({ ...generated, notes: "External edit", title: "Updated elsewhere" }),
      );
      yield* Deferred.succeed(gate, generated);
      expect((yield* env.finished()).error).toContain("review changed");
      expect((yield* env.service.get({ threadId })).review?.title).toBe("Updated elsewhere");
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("cancels the background pass without creating or replacing a review", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const env = yield* setup({
        generate: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* env.service.start({ threadId });
      yield* Deferred.await(entered);
      yield* env.service.cancel({ threadId: siblingId });
      expect((yield* env.finished()).result).toBe("cancelled");
      expect((yield* env.service.get({ threadId })).review).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("publishes what the model is doing while a batch runs", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const env = yield* setup({
        generate: (input) =>
          Effect.gen(function* () {
            yield* input.onActivity!({ kind: "thinking", text: "Reading the diff.", tokens: 12 });
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(gate);
            yield* input.onActivity!({ kind: "output", text: '{"title":' });
            return yield* Effect.never;
          }),
      });
      const stateWhere = (predicate: (state: RevdocRunState) => boolean) =>
        env.service
          .changes({ threadId })
          .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
      yield* env.service.start({ threadId });
      yield* Deferred.await(entered);
      expect((yield* stateWhere(() => true)).activity).toEqual([
        {
          batch: 1,
          elapsedMs: 0,
          thinking: "Reading the diff.",
          thinkingTokens: 12,
          outputBytes: 0,
        },
      ]);
      yield* TestClock.adjust(1_000);
      yield* Deferred.succeed(gate, undefined);
      const writing = yield* stateWhere((state) => (state.activity?.[0]?.outputBytes ?? 0) > 0);
      expect(writing.activity).toEqual([
        {
          batch: 1,
          elapsedMs: 1_000,
          thinking: "Reading the diff.",
          thinkingTokens: 12,
          outputBytes: 9,
        },
      ]);
      yield* env.service.cancel({ threadId });
      const final = yield* env.finished();
      expect(final.result).toBe("cancelled");
      expect(final.activity).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("reports a provider failure and leaves the previous review intact", () =>
    Effect.gen(function* () {
      const env = yield* setup({
        generate: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateRevdoc",
              detail: "Provider unavailable",
            }),
          ),
      });
      yield* env.fs.makeDirectory(env.path.join(env.worktree, ".revdoc"));
      yield* env.fs.writeFileString(
        env.path.join(env.worktree, ".revdoc", "review.json"),
        encodeJson(generated),
      );
      const initial = yield* env.service.get({ threadId });
      yield* env.service.start({ threadId });
      expect((yield* env.finished()).error).toContain("Provider unavailable");
      expect((yield* env.service.get({ threadId })).revision).toBe(initial.revision);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
  it.effect("reports an unavailable configured provider without generating a review", () =>
    Effect.gen(function* () {
      const env = yield* setup({ unavailable: true });
      yield* env.service.start({ threadId });
      expect((yield* env.finished()).error).toContain("Choose an available provider");
      expect(env.calls).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
});

describe("large Revdoc generation", () => {
  it.effect("resumes unfinished batches after a session limit and service restart", () =>
    Effect.gen(function* () {
      const entered =
        yield* Queue.unbounded<Deferred.Deferred<RevdocGenerationResult, TextGenerationError>>();
      let recovering = false;
      const env = yield* setup({
        generate: () =>
          recovering
            ? Effect.succeed(generated)
            : Effect.gen(function* () {
                const result = yield* Deferred.make<RevdocGenerationResult, TextGenerationError>();
                yield* Queue.offer(entered, result);
                return yield* Deferred.await(result);
              }),
      });
      yield* env.fs.writeFileString(
        env.path.join(env.worktree, "app.txt"),
        "changed line\n".repeat(30_000),
      );
      yield* env.service.start({ threadId });
      const first = yield* Queue.take(entered);
      const second = yield* Queue.take(entered);
      yield* Deferred.succeed(first, generated);
      yield* env.service.changes({ threadId }).pipe(
        Stream.filter((state) => state.completed === 1),
        Stream.runHead,
      );
      const completedPrompt = env.calls[0]!.prompt;
      yield* Deferred.fail(
        second,
        new TextGenerationError({
          operation: "generateRevdoc",
          detail: "Agent session limit reached",
        }),
      );
      expect((yield* env.finished()).error).toContain("session limit");
      const partial = yield* env.service.get({ threadId });
      expect(partial.review?.generation).toMatchObject({ stage: "reviewing", completed: 1 });
      yield* env.service.save({
        threadId,
        expectedRevision: partial.revision!,
        change: { kind: "document", note: "Keep my recovery feedback" },
      });
      const callsBeforeResume = env.calls.length;
      recovering = true;
      const restarted = yield* env.restart;
      yield* restarted.start({ threadId });
      const finished = yield* restarted.changes({ threadId }).pipe(
        Stream.filter((state) => !state.running && state.version > 0),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(finished.error).toBeNull();
      expect(env.calls.slice(callsBeforeResume).map((call) => call.prompt)).not.toContain(
        completedPrompt,
      );
      const completed = yield* restarted.get({ threadId });
      expect(completed.review?.sections).not.toHaveLength(0);
      expect(completed.review?.notes).toBe("Keep my recovery feedback");
      expect(completed.review?.generation).toBeUndefined();
      expect(yield* env.fs.exists(env.path.join(env.worktree, ".revdoc", "generation.json"))).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect("saves finished batches while the rest of the review is still running", () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<Deferred.Deferred<RevdocGenerationResult>>();
      const env = yield* setup({
        generate: () =>
          Effect.gen(function* () {
            const result = yield* Deferred.make<RevdocGenerationResult>();
            yield* Queue.offer(entered, result);
            return yield* Deferred.await(result);
          }),
      });
      yield* env.fs.writeFileString(
        env.path.join(env.worktree, "app.txt"),
        "changed line\n".repeat(30_000),
      );
      yield* env.service.start({ threadId });
      const first = yield* Queue.take(entered);
      yield* Queue.take(entered);
      yield* Deferred.succeed(first, generated);
      yield* env.service.changes({ threadId }).pipe(
        Stream.filter((state) => state.completed === 1),
        Stream.runHead,
      );
      const partial = yield* env.service.get({ threadId: siblingId });
      expect(partial.review?.sections[0]?.items[0]?.tests[0]?.title).toBe("Open the feature");
      yield* env.service.cancel({ threadId });
      expect((yield* env.service.get({ threadId })).revision).toBe(partial.revision);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect.each(["unchanged", "source", "conversation", "damaged checkpoint"] as const)(
    "reuses cancelled generation only while its inputs match: %s",
    (change) =>
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<Deferred.Deferred<RevdocGenerationResult>>();
        let recovering = false;
        let title = "Review work";
        const env = yield* setup({
          title: () => title,
          generate: () =>
            recovering
              ? Effect.succeed(generated)
              : Effect.gen(function* () {
                  const result = yield* Deferred.make<RevdocGenerationResult>();
                  yield* Queue.offer(entered, result);
                  return yield* Deferred.await(result);
                }),
        });
        const source = env.path.join(env.worktree, "app.txt");
        yield* env.fs.writeFileString(source, "changed line\n".repeat(30_000));
        yield* env.service.start({ threadId });
        yield* Queue.take(entered);
        const second = yield* Queue.take(entered);
        // Finish out of order: recovery must identify batches, not skip the first N.
        yield* Deferred.succeed(second, generated);
        const progress = yield* env.service.changes({ threadId }).pipe(
          Stream.filter((state) => state.completed === 1),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        yield* env.service.cancel({ threadId });
        yield* env.finished();
        if (change === "source")
          yield* env.fs.writeFileString(source, "another line\n".repeat(30_000));
        if (change === "conversation") title = "Changed requirements";
        if (change === "damaged checkpoint")
          yield* env.fs.writeFileString(
            env.path.join(env.worktree, ".revdoc", "generation.json"),
            "invalid JSON",
          );
        const callsBeforeResume = env.calls.length;
        recovering = true;
        yield* env.service.start({ threadId });
        expect((yield* env.finished()).error).toBeNull();
        const retried = env.calls
          .slice(callsBeforeResume)
          .filter((call) => !call.prompt.startsWith("Organise"));
        if (change === "unchanged") {
          expect(retried).toHaveLength(progress.total! - 1);
          expect(retried.map((call) => call.prompt)).not.toContain(env.calls[1]!.prompt);
        } else {
          expect(retried).toHaveLength(progress.total!);
        }
        expect((yield* env.service.get({ threadId })).review?.generation).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect("resumes combining without repeating saved review batches or section groups", () =>
    Effect.gen(function* () {
      const entered =
        yield* Queue.unbounded<Deferred.Deferred<RevdocGenerationResult, TextGenerationError>>();
      let recovering = false;
      const largeResult = {
        ...generated,
        sections: generated.sections.map((section) => ({
          ...section,
          items: section.items.map((item) => ({
            ...item,
            tests: Array.from({ length: 12 }, (_, i) => ({
              id: `test-${i}`,
              title: `Check ${i}`,
              expected: "Details ".repeat(1_000),
            })),
          })),
        })),
      };
      const env = yield* setup({
        generate: (input) =>
          !input.prompt.startsWith("Organise")
            ? Effect.succeed(largeResult)
            : recovering
              ? Effect.succeed({ ...generated, sections: [] })
              : Effect.gen(function* () {
                  const result = yield* Deferred.make<
                    RevdocGenerationResult,
                    TextGenerationError
                  >();
                  yield* Queue.offer(entered, result);
                  return yield* Deferred.await(result);
                }),
      });
      yield* env.fs.writeFileString(
        env.path.join(env.worktree, "app.txt"),
        "changed line\n".repeat(30_000),
      );
      yield* env.service.start({ threadId });
      const first = yield* Queue.take(entered);
      const second = yield* Queue.take(entered);
      yield* Deferred.succeed(first, { ...generated, sections: [] });
      yield* env.service.changes({ threadId }).pipe(
        Stream.filter((state) => state.generationStage === "combining" && state.completed === 1),
        Stream.runHead,
      );
      const savedPrompt = env.calls.find((call) => call.prompt.startsWith("Organise"))!.prompt;
      yield* Deferred.fail(
        second,
        new TextGenerationError({ operation: "generateRevdoc", detail: "Session expired" }),
      );
      expect((yield* env.finished()).error).toContain("Session expired");
      const partial = yield* env.service.get({ threadId });
      expect(partial.review?.generation).toMatchObject({ stage: "combining", completed: 1 });
      expect(partial.review?.sections[0]?.items[0]?.tests).toHaveLength(12);
      const callsBeforeResume = env.calls.length;
      recovering = true;
      const restarted = yield* env.restart;
      yield* restarted.start({ threadId });
      const done = yield* restarted.changes({ threadId }).pipe(
        Stream.filter((state) => !state.running && state.version > 0),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(done.error).toBeNull();
      const retried = env.calls.slice(callsBeforeResume);
      expect(retried).toHaveLength(1);
      expect(retried[0]!.prompt).toMatch(/^Organise/);
      expect(retried[0]!.prompt).not.toBe(savedPrompt);
      const completed = yield* restarted.get({ threadId });
      expect(completed.review?.sections[0]?.items[0]?.tests).toHaveLength(12);
      expect(completed.review?.generation).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect(
    "automatically batches full patches and large untracked text, selects the large model, and retains omitted checks",
    () =>
      Effect.gen(function* () {
        const selected = {
          instanceId: ProviderInstanceId.make("claude"),
          model: "large-review-model",
        };
        let batch = 0;
        const env = yield* setup({
          largeModel: selected,
          generate: (input) =>
            Effect.sync(() => {
              if (input.prompt.startsWith("Organise")) return { ...generated, sections: [] };
              batch++;
              return {
                ...generated,
                sections: generated.sections.map((s) => ({
                  ...s,
                  items: s.items.map((i) => ({
                    ...i,
                    tests: [
                      {
                        id: "locally-reused-id",
                        title: `Check batch ${batch}`,
                        expected: `Result ${batch}`,
                      },
                    ],
                  })),
                })),
              };
            }),
        });
        yield* env.fs.writeFileString(
          env.path.join(env.worktree, "app.txt"),
          "changed line\n".repeat(30_000) + "TRACKED_END\n",
        );
        yield* env.fs.writeFileString(
          env.path.join(env.worktree, "large-new.txt"),
          "new line\n".repeat(25_000) + "UNTRACKED_END\n",
        );
        yield* env.service.start({ threadId });
        expect((yield* env.finished()).error).toBeNull();
        expect(batch).toBeGreaterThan(1);
        expect(env.calls.every((call) => call.modelSelection === selected)).toBe(true);
        expect(env.calls.every((call) => Buffer.byteLength(call.prompt) <= 450_000)).toBe(true);
        const allPrompts = env.calls.map((call) => call.prompt).join("\n");
        expect(allPrompts).toContain("TRACKED_END");
        expect(allPrompts).toContain("UNTRACKED_END");
        expect(allPrompts).not.toContain("[truncated]");
        expect(allPrompts.match(/\+changed line/g)).toHaveLength(30_000);
        expect(allPrompts.match(/new line/g)).toHaveLength(25_000);
        const detail = yield* env.service.get({ threadId });
        const tests = detail.review!.sections.flatMap((s) => s.items.flatMap((i) => i.tests));
        expect(tests).toHaveLength(batch);
        expect(new Set(tests.map((test) => test.id)).size).toBe(batch);
        expect(tests.every((test) => test.outcome === "untested")).toBe(true);
        const checked = tests[0]!;
        yield* env.service.save({
          threadId,
          expectedRevision: detail.revision!,
          change: {
            kind: "test",
            id: checked.id,
            outcome: "broken",
            feedback: "Keep the finding on rerun",
          },
        });
        batch = 0;
        yield* env.service.start({ threadId });
        expect((yield* env.finished()).error).toBeNull();
        const rerun = yield* env.service.get({ threadId });
        expect(
          rerun
            .review!.sections.flatMap((s) => s.items.flatMap((i) => i.tests))
            .find((test) => test.id === checked.id),
        ).toMatchObject({
          outcome: "broken",
          feedback: "Keep the finding on rerun",
        });
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect("keeps small reviews on the normal model even when a large model is configured", () =>
    Effect.gen(function* () {
      const env = yield* setup({
        largeModel: { instanceId: ProviderInstanceId.make("claude"), model: "large" },
      });
      yield* env.service.start({ threadId });
      expect((yield* env.finished()).error).toBeNull();
      expect(env.calls).toHaveLength(1);
      expect(env.calls[0]!.modelSelection).toEqual(defaultModel);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect(
    "limits parallel workers, exposes batch progress, and cancels every active worker without replacing the saved review",
    () =>
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<void>();
        let batching = false;
        let active = 0;
        const env = yield* setup({
          generate: () =>
            !batching
              ? Effect.succeed(generated)
              : Effect.gen(function* () {
                  active++;
                  yield* Queue.offer(entered, undefined);
                  return yield* Effect.never;
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      active--;
                    }),
                  ),
                ),
        });
        yield* env.service.start({ threadId });
        yield* env.finished();
        const initial = yield* env.service.get({ threadId });
        batching = true;
        yield* env.fs.writeFileString(
          env.path.join(env.worktree, "app.txt"),
          "changed line\n".repeat(50_000),
        );
        yield* env.service.start({ threadId });
        yield* Queue.take(entered);
        yield* Queue.take(entered);
        expect(active).toBe(2);
        const state = yield* env.service
          .changes({ threadId })
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        expect(state).toMatchObject({
          running: true,
          phase: "generating",
          generationStage: "reviewing",
          completed: 0,
        });
        expect(state.total).toBeGreaterThan(2);
        yield* env.service.cancel({ threadId });
        expect((yield* env.finished()).result).toBe("cancelled");
        expect(active).toBe(0);
        expect((yield* env.service.get({ threadId })).revision).toBe(initial.revision);
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect.each(["reviewing", "combining"] as const)("preserves feedback when %s fails", (stage) =>
    Effect.gen(function* () {
      let batching = false;
      const env = yield* setup({
        generate: (input) =>
          batching && (stage === "reviewing" || input.prompt.startsWith("Organise"))
            ? Effect.fail(
                new TextGenerationError({ operation: "generateRevdoc", detail: "Batch failed" }),
              )
            : Effect.succeed(generated),
      });
      yield* env.service.start({ threadId });
      yield* env.finished();
      const original = yield* env.service.get({ threadId });
      const saved = yield* env.service.save({
        threadId,
        expectedRevision: original.revision!,
        change: {
          kind: "test",
          id: "check",
          outcome: "broken",
          feedback: "Keep this finding",
        },
      });
      batching = true;
      yield* env.fs.writeFileString(
        env.path.join(env.worktree, "app.txt"),
        "changed line\n".repeat(30_000),
      );
      yield* env.service.start({ threadId });
      expect((yield* env.finished()).error).toContain("Batch failed");
      const retained = yield* env.service.get({ threadId });
      expect(retained.review?.sections[0]?.items[0]?.tests[0]).toMatchObject({
        outcome: "broken",
        feedback: "Keep this finding",
      });
      if (stage === "reviewing") expect(retained.revision).toBe(saved.revision);
      else expect(retained.review?.generation).toMatchObject({ stage: "combining", completed: 0 });
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect("does not publish a review if the worktree changes during generation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const env = yield* setup({
        generate: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(generated),
          ),
      });
      yield* env.service.start({ threadId });
      yield* Deferred.await(entered);
      yield* env.fs.writeFileString(
        env.path.join(env.worktree, "app.txt"),
        "Changed during the pass\n",
      );
      yield* Deferred.succeed(gate, undefined);
      expect((yield* env.finished()).error).toContain("worktree changed during generation");
      expect((yield* env.service.get({ threadId })).review).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
});

describe("Revdoc AI testing", () => {
  it.effect(
    "dispatches a configurable background thread and records real captures without changing human decisions",
    () =>
      Effect.gen(function* () {
        const selected = {
          instanceId: defaultModel.instanceId,
          model: "tester-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        };
        const env = yield* setup({ testingModel: selected });
        yield* env.service.start({ threadId });
        yield* env.finished();
        const initial = yield* env.service.get({ threadId });
        yield* env.service.save({
          threadId,
          expectedRevision: initial.revision!,
          change: { kind: "test", id: "check", outcome: "change", feedback: "Keep my review" },
        });
        yield* env.service.startTesting({ threadId, selection: "all" });
        const { invocation, target } = yield* env.tester;
        expect(env.dispatched.find((c) => c.type === "thread.turn.start")).toMatchObject({
          modelSelection: selected,
          threadId: invocation.thread.threadId,
        });
        expect(invocation.thread.threadId).not.toBe(threadId);
        expect(env.dispatched.find((command) => command.type === "thread.create")).toMatchObject({
          purpose: "revdoc",
        });
        expect((yield* env.service.get({ threadId })).review?.testing?.audience).toBe("revdoc");
        // A ready session during startup is not a completed turn.
        yield* env.settle(invocation.thread.threadId, false);
        yield* env.service.beginTest(invocation, target);
        const result = {
          ...target,
          result: "passed" as const,
          method: "browser" as const,
          steps: "Opened the feature",
          observed: "Feature opens",
        };
        expect(
          (yield* env.service.recordTest(invocation, result).pipe(Effect.flip)).message,
        ).toContain("Capture Browser evidence");
        yield* env.service.captureEvidence(invocation, { ...target, caption: "Feature opened" });
        yield* env.service.recordTest(invocation, result);
        yield* env.settle(invocation.thread.threadId);
        expect((yield* env.finished()).error).toBeNull();
        const detail = yield* env.service.get({ threadId });
        const test = detail.review!.sections[0]!.items[0]!.tests[0]!;
        expect(test).toMatchObject({
          outcome: "change",
          feedback: "Keep my review",
          attempts: [
            {
              state: "passed",
              by: "codex / tester-model",
              evidence: [{ caption: "Feature opened" }],
            },
          ],
        });
        expect(detail.review?.testing?.status).toBe("completed");
        expect(detail.staleTestIds).toEqual([]);
        const evidence = test.attempts![0]!.evidence[0]!;
        const bytes = yield* env.fs.readFile(env.path.join(env.worktree, ".revdoc", evidence.path));
        expect(Buffer.from(bytes).toString("base64")).toBe(env.png);
        expect(env.captured).toEqual(["snapshot"]);
        yield* env.fs.writeFileString(env.path.join(env.worktree, "app.txt"), "New code");
        expect((yield* env.service.get({ threadId })).staleTestIds).toEqual(["check"]);
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect("preserves partial results on cancellation and retries only remaining checks", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      yield* env.service.start({ threadId });
      yield* env.finished();
      const review = (yield* env.service.get({ threadId })).review!;
      const item = review.sections[0]!.items[0]!;
      yield* env.saveReview({
        ...review,
        sections: [
          {
            ...review.sections[0]!,
            items: [{ ...item, tests: [...item.tests, { id: "second", title: "Second check" }] }],
          },
        ],
      });
      yield* env.service.startTesting({ threadId, selection: "all" });
      const first = yield* env.tester;
      yield* env.service.beginTest(first.invocation, first.target);
      yield* env.service.recordTest(first.invocation, {
        ...first.target,
        result: "passed",
        method: "command",
        steps: "test app",
        observed: "exit 0",
      });
      yield* env.service.cancel({ threadId: siblingId });
      const cancelled = (yield* env.service.get({ threadId })).review!;
      expect(cancelled.testing?.status).toBe("cancelled");
      expect(cancelled.sections[0]!.items[0]!.tests.map((t) => t.attempts?.at(-1)?.state)).toEqual([
        "passed",
        "blocked",
      ]);
      expect(env.dispatched.at(-1)).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: first.invocation.thread.threadId,
      });
      yield* env.service.startTesting({ threadId, selection: "remaining" });
      const second = yield* env.tester;
      expect((yield* env.service.get({ threadId })).review?.testing?.testIds).toEqual(["second"]);
      expect(
        (yield* env.service.beginTest(first.invocation, first.target).pipe(Effect.flip)).message,
      ).toContain("Only the active");
      yield* env.settle(second.invocation.thread.threadId);
      yield* env.finished();
      const final = (yield* env.service.get({ threadId })).review!;
      expect(final.sections[0]!.items[0]!.tests[0]!.attempts).toHaveLength(1);
      expect(final.sections[0]!.items[0]!.tests[1]!.attempts).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect(
    "rejects reports from another thread and from changed code, including large binary files",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.service.start({ threadId });
        yield* env.finished();
        const binary = env.path.join(env.worktree, "asset.bin");
        yield* env.fs.writeFile(binary, new Uint8Array(60_000));
        yield* env.service.startTesting({ threadId, selection: "all" });
        const { invocation, target } = yield* env.tester;
        expect(
          (yield* env.service
            .beginTest({ ...invocation, thread: { ...invocation.thread, threadId } }, target)
            .pipe(Effect.flip)).message,
        ).toContain("Only the active");
        yield* env.service.beginTest(invocation, target);
        yield* env.fs.writeFile(binary, new Uint8Array(60_000).fill(1));
        expect(
          (yield* env.service
            .recordTest(invocation, {
              ...target,
              result: "passed",
              method: "command",
              steps: "Ran command",
              observed: "exit 0",
            })
            .pipe(Effect.flip)).message,
        ).toContain("changed during testing");
        yield* env.service.cancel({ threadId });
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect(
    "generate-and-test starts the tester after saving the generated review and handles provider errors",
    () =>
      Effect.gen(function* () {
        const env = yield* setup({ defaultAction: "generate-and-test" });
        yield* env.service.start({ threadId });
        const { invocation } = yield* env.tester;
        expect((yield* env.service.get({ threadId })).review?.title).toBe(generated.title);
        yield* env.settle(invocation.thread.threadId, true, "error");
        expect((yield* env.finished()).error).toContain("interrupted");
        const review = (yield* env.service.get({ threadId })).review!;
        expect(review.testing?.status).toBe("failed");
        expect(review.sections[0]!.items[0]!.tests[0]!.attempts?.at(-1)?.state).toBe("blocked");
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect(
    "recovers an abandoned run after restart instead of displaying a permanent spinner",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.service.start({ threadId });
        yield* env.finished();
        const review = (yield* env.service.get({ threadId })).review!;
        yield* env.saveReview({
          ...review,
          testing: {
            id: "old-run",
            threadId,
            status: "running",
            sourceRevision: "old",
            startedAt: "2026-10-04T12:00:00Z",
            testIds: ["check"],
          },
        });
        expect((yield* env.service.get({ threadId })).review?.testing).toMatchObject({
          status: "interrupted",
          error: expect.stringContaining("restarted"),
        });
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );
});
