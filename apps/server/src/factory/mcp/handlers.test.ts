import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FactoryManager,
  type FactoryOnboardingReport,
  type FactoryRole,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Tool from "effect/ai/Tool";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import { FactoryService } from "../FactoryService.ts";
import * as FactoryMcp from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";

const MANAGER_THREAD = ThreadId.make("thread-manager");
const OTHER_THREAD = ThreadId.make("thread-other");

const report: FactoryOnboardingReport = {
  summary: "Turbo monorepo; CI gates on lint and tests.",
  controlPaths: [".github/**", "apps/server/src/persistence/Migrations/**"],
  boardGaps: ["No column for blocked tickets."],
  openChoices: ["Should docs-only tickets skip review?"],
};

const manager: FactoryManager = {
  id: "manager-1",
  projectId: ProjectId.make("project-1"),
  name: "Ada",
  state: "onboarding",
  threadId: MANAGER_THREAD,
  controlPaths: [],
  onboardingNotes: "",
  onboardingReport: null,
  modelSelection: null,
  activeAssignments: 0,
  waitingOnYou: 0,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
};

const invocation = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.gen(function* () {
  const proposals = yield* Ref.make<ReadonlyArray<FactoryOnboardingReport>>([]);
  const briefRequests = yield* Ref.make<
    ReadonlyArray<{ projectId: ProjectId; role: FactoryRole; managerId: string }>
  >([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(FactoryService)({
      managerForThread: (threadId) => Effect.succeed(threadId === MANAGER_THREAD ? manager : null),
      proposeOnboarding: (_threadId, proposed) =>
        Ref.update(proposals, (recorded) => [...recorded, proposed]).pipe(
          Effect.as({ ...manager, onboardingReport: proposed }),
        ),
      roleBrief: (projectId, role, managerId) =>
        Ref.update(briefRequests, (recorded) => [...recorded, { projectId, role, managerId }]).pipe(
          Effect.as({ role, text: `# ${role} brief`, source: "project" as const }),
        ),
    }),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* FactoryToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(FactoryMcp.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  const call = <Name extends keyof typeof FactoryToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    threadId: ThreadId = MANAGER_THREAD,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof FactoryToolkit.tools)[Name]>,
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(threadId, capabilities),
      ),
      Effect.provide(dependencies),
    );
  return { proposals, briefRequests, call };
});

describe("factory_propose_onboarding", () => {
  it.effect("refuses a thread that is not a manager without storing anything", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_propose_onboarding", report, OTHER_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        _tag: "FactoryToolFailedError",
        reason: "not-found",
        message: "This thread is not an engineering manager.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.proposals), []);
    }),
  );

  it.effect("forwards the manager's report and returns the stored control paths", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_propose_onboarding", report);
      assert.deepStrictEqual(yield* Ref.get(harness.proposals), [report]);
      assert.deepStrictEqual(result, {
        managerId: "manager-1",
        managerName: "Ada",
        state: "onboarding",
        controlPaths: report.controlPaths,
        message:
          "The onboarding report is with the user. Ask them in this thread to review and approve it in Satellite.",
      });
    }),
  );

  it.effect("refuses a credential without the orchestration capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_propose_onboarding", report, MANAGER_THREAD, ["preview"])
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "McpCapabilityUnavailableError");
      assert.deepStrictEqual(yield* Ref.get(harness.proposals), []);
    }),
  );
});

describe("factory_role_brief", () => {
  it.effect("reads the brief for the calling manager's project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_role_brief", { role: "reviewer" });
      assert.deepStrictEqual(yield* Ref.get(harness.briefRequests), [
        { projectId: manager.projectId, role: "reviewer", managerId: "manager-1" },
      ]);
      assert.deepStrictEqual(result, {
        role: "reviewer",
        text: "# reviewer brief",
        source: "project",
        message: "The reviewer brief, from this project's role file.",
      });
    }),
  );

  it.effect("refuses a thread outside the factory", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_role_brief", { role: "lead" }, OTHER_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        _tag: "FactoryToolFailedError",
        reason: "not-found",
        message: "This thread is not part of the factory.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.briefRequests), []);
    }),
  );

  it.effect("refuses a credential without the orchestration capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_role_brief", { role: "lead" }, MANAGER_THREAD, ["preview"])
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "McpCapabilityUnavailableError");
    }),
  );
});
