import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryAssignmentId,
  FactoryError,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as DeviceService from "../device/DeviceService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import migration from "../persistence/Migrations/067_EngineeringFactory.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryMcpGuard from "./FactoryMcpGuard.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { layerUnavailable as boundaryUnavailable } from "./FactoryBoundaryExecution.testkit.ts";

const now = "2026-10-10T12:00:00.000Z";
const managerId = ThreadId.make("manager-web");
const leadId = ThreadId.make("lead-web");
const childId = ThreadId.make("child-web");
const grandchildId = ThreadId.make("grandchild-web");
const forkId = ThreadId.make("fork-web");
const unmanagedId = ThreadId.make("independent-thread");
const assignmentId = FactoryAssignmentId.make("assignment-web");
const otherAssignmentId = FactoryAssignmentId.make("assignment-api");
const decodeMembership = Schema.decodeUnknownSync(
  Schema.Struct({
    managers: Schema.Array(Schema.Struct({ id: Schema.String })),
    assignments: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
);
const report = {
  summary: "Discovery completed.",
  instructions: [],
  checks: [],
  tracker: { description: "No tracker configured.", evidence: [] },
  verificationTools: [],
  protectedControls: [],
  unresolvedDecisions: [],
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "factory-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "factory-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation = (caller: ThreadId | "client"): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("factory-test"),
  capabilities: new Set(["orchestration", "device"]),
  issuedAt: 1,
  requestNamespace: `factory-test:${caller}`,
  thread:
    caller === "client"
      ? undefined
      : {
          threadId: caller,
          providerSessionId: `session:${caller}`,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
  client:
    caller === "client"
      ? { sessionId: "client", label: "Client", access: "full-access" }
      : undefined,
});

interface Scenario {
  readonly call: (
    name: string,
    args?: Record<string, unknown>,
    caller?: ThreadId | "client" | null,
  ) => Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError | McpSchema.InvalidParams>;
  readonly store: FactoryStore.FactoryStore["Service"];
  readonly flags: { hostCalls: number; missingProfile: boolean; unavailableStore: boolean };
  readonly shells: Map<ThreadId, OrchestrationV2ThreadShell>;
}

const scenario = <E>(test: (context: Scenario) => Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    yield* migration;
    const store = yield* FactoryStore.FactoryStore.pipe(Effect.provide(FactoryStore.layer));
    const seed = (
      project: string,
      manager: ThreadId,
      lead: ThreadId,
      assignment: typeof assignmentId,
    ) =>
      store.commit({
        actor: { kind: "human" },
        command: {
          type: "manager.create",
          commandId: CommandId.make(`create:${project}`),
          projectId: ProjectId.make(project),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" },
          workflow: { repositoryRoot: "/owned-skills", revision: "approved-revision" },
        },
        allocation: { managerThreadId: manager, leadThreadId: lead, assignmentId: assignment },
        qualification: { status: "qualified", profileId: `profile:${project}`, checkedAt: now },
        now,
      });
    yield* seed("web", managerId, leadId, assignmentId);
    yield* seed("api", ThreadId.make("manager-api"), ThreadId.make("lead-api"), otherAssignmentId);
    const pending = yield* store.pending;
    yield* Effect.forEach(pending, (operation) =>
      store.finishEffect({
        id: operation.id,
        command: {
          type: "thread.launch.recorded",
          commandId: CommandId.make(`${operation.id}:recorded`),
          threadId: operation.intent.threadId,
        },
        now,
      }),
    );
    const flags = { hostCalls: 0, missingProfile: false, unavailableStore: false };
    const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
      [managerId, liveThreadShell(managerId)],
      [leadId, liveThreadShell(leadId)],
      [unmanagedId, liveThreadShell(unmanagedId)],
      [
        forkId,
        {
          ...liveThreadShell(forkId),
          lineage: { rootThreadId: leadId, parentThreadId: leadId, relationshipToParent: "fork" },
        },
      ],
      [
        childId,
        {
          ...liveThreadShell(childId),
          creationSource: "provider",
          lineage: {
            rootThreadId: leadId,
            parentThreadId: leadId,
            relationshipToParent: "subagent",
          },
        },
      ],
      [
        grandchildId,
        {
          ...liveThreadShell(grandchildId),
          lineage: {
            rootThreadId: leadId,
            parentThreadId: childId,
            relationshipToParent: "subagent",
          },
        },
      ],
    ]);
    const external = Layer.mergeAll(
      boundaryUnavailable,
      Layer.succeed(FactoryStore.FactoryStore, {
        ...store,
        snapshot: Effect.suspend(() =>
          flags.unavailableStore
            ? Effect.fail(new FactoryError({ code: "persistence" }))
            : store.snapshot,
        ),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.sync(() => shells.get(id) ?? null),
      }),
      Layer.mock(FactoryExecution.FactoryExecution)({
        runtimePolicyFor: () =>
          Effect.sync(() =>
            flags.missingProfile
              ? undefined
              : {
                  boundaryId: "boundary",
                  dockerContext: "test",
                  imageId: "test-image",
                  projectSnapshotPath: "/project-snapshot",
                  workflowSnapshotPath: "/workflow-snapshot",
                  runtimePath: "/runtime",
                },
          ),
      }),
      Layer.mock(DeviceService.DeviceService)({}),
      Layer.mock(ProjectService.ProjectService)({}),
    );
    const ProbeToolkit = Toolkit.make(
      Tool.make("host_effect", {
        description: "A host operation that managed agents cannot run.",
        parameters: Tool.EmptyParams,
        success: Schema.Struct({ ran: Schema.Boolean }),
        failure: OrchestratorMcpFailure,
        failureMode: "return",
      }),
    );
    const registration = Layer.mergeAll(
      McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          host_effect: McpToolAccess.reads(() =>
            Effect.sync(() => {
              flags.hostCalls += 1;
              return { ran: true };
            }),
          ),
        }),
      ),
      McpHttpServer.layerFactoryToolkit,
      McpHttpServer.layerDeviceToolkit,
    ).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(FactoryMcpGuard.layer.pipe(Layer.provide(FactoryService.layer))),
      Layer.provide(external),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      yield* test({
        store,
        flags,
        shells,
        call: (name, args = {}, caller = leadId) => {
          const result = server
            .callTool({ name, arguments: args })
            .pipe(Effect.provideService(McpSchema.McpServerClient, client));
          return caller === null
            ? result
            : result.pipe(
                Effect.provideService(
                  McpInvocationContext.McpInvocationContext,
                  invocation(caller),
                ),
              );
        },
      });
    }).pipe(Effect.provide(registration));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped);

describe("FactoryMcpGuard", () => {
  it.effect("refuses an unauthenticated invocation before a registered handler runs", () =>
    scenario(({ call, flags }) =>
      Effect.gen(function* () {
        assert.isTrue((yield* call("host_effect", {}, null)).isError);
        assert.equal(flags.hostCalls, 0);
      }),
    ),
  );

  it.effect("refuses host effects for managed callers and preserves unmanaged calls", () =>
    scenario(({ call, flags }) =>
      Effect.gen(function* () {
        assert.isTrue(
          (yield* call("host_effect", { actor: { kind: "human" }, threadId: unmanagedId })).isError,
        );
        assert.isTrue((yield* call("host_effect", {}, managerId)).isError);
        assert.equal(flags.hostCalls, 0);
        assert.deepEqual((yield* call("host_effect", {}, unmanagedId)).structuredContent, {
          ran: true,
        });
        assert.equal(flags.hostCalls, 1);
      }),
    ),
  );

  it.effect("applies the same gate to manually registered image tools", () =>
    scenario(({ call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_screenshot", { deviceId: "unrelated-device" });
        assert.isTrue(result.isError);
        assert.deepEqual(result.content, [
          {
            type: "text",
            text: "This managed thread can use only its scoped factory tools. Host tools are unavailable during confined discovery.",
          },
        ]);
      }),
    ),
  );

  it.effect("scopes snapshots from identity and rejects spoofed target or actor fields", () =>
    scenario(({ call }) =>
      Effect.gen(function* () {
        const spoofed = yield* call("factory_snapshot", {
          projectId: "api",
          actor: { kind: "human" },
          threadId: "lead-api",
        }).pipe(Effect.flip);
        assert.equal(spoofed._tag, "InvalidParams");
        const result = yield* call("factory_snapshot");
        const snapshot = decodeMembership(result.structuredContent);
        assert.deepEqual(snapshot.managers, [{ id: "manager-web" }]);
        assert.deepEqual(snapshot.assignments, [{ id: "assignment-web" }]);
        assert.isTrue((yield* call("factory_snapshot", {}, "client")).isError);
        assert.isTrue((yield* call("factory_snapshot", {}, unmanagedId)).isError);
      }),
    ),
  );

  it.effect("derives mutation authority from the caller and records only its own report", () =>
    scenario(({ call, store }) =>
      Effect.gen(function* () {
        const command = {
          type: "onboarding.report",
          commandId: "report-web",
          assignmentId,
          report,
        };
        assert.isTrue(
          (yield* call("factory_dispatch", { command, actor: { kind: "human" } }, "client"))
            .isError,
        );
        assert.isTrue(
          (yield* call("factory_dispatch", {
            command: { ...command, assignmentId: otherAssignmentId },
            actor: { kind: "human" },
          })).isError,
        );
        assert.isTrue(
          (yield* call("factory_dispatch", {
            command: {
              type: "manager.configure",
              commandId: "self-promote",
              managerId,
              overrides: { delivery: "project-rule" },
            },
            actor: { kind: "human" },
          })).isError,
        );
        const result = yield* call("factory_dispatch", { command, actor: { kind: "human" } });
        assert.isFalse(result.isError);
        const snapshot = yield* store.snapshot;
        assert.deepEqual(
          snapshot.assignments.find((entry) => entry.id === assignmentId)?.report,
          report,
        );
        assert.equal(
          snapshot.assignments.find((entry) => entry.id === otherAssignmentId)?.report,
          null,
        );
        assert.equal(
          snapshot.managers.find((entry) => entry.id === managerId)?.overrides.delivery,
          undefined,
        );
      }),
    ),
  );

  it.effect(
    "inherits native and app-owned descendant confinement without granting lead authority",
    () =>
      scenario(({ call, flags }) =>
        Effect.gen(function* () {
          assert.isTrue((yield* call("host_effect", {}, childId)).isError);
          assert.isTrue((yield* call("host_effect", {}, grandchildId)).isError);
          assert.equal(flags.hostCalls, 0);
          assert.isFalse((yield* call("factory_snapshot", {}, grandchildId)).isError);
          assert.isTrue(
            (yield* call(
              "factory_dispatch",
              {
                command: {
                  type: "onboarding.report",
                  commandId: "child-report",
                  assignmentId,
                  report,
                },
              },
              grandchildId,
            )).isError,
          );
        }),
      ),
  );

  it.effect("fails closed when profile or store lookup is unavailable", () =>
    scenario(({ call, flags }) =>
      Effect.gen(function* () {
        flags.missingProfile = true;
        assert.isTrue((yield* call("factory_snapshot")).isError);
        assert.isTrue((yield* call("host_effect")).isError);
        flags.missingProfile = false;
        flags.unavailableStore = true;
        assert.isTrue((yield* call("host_effect")).isError);
        assert.isTrue((yield* call("factory_snapshot")).isError);
        assert.equal(flags.hostCalls, 0);
      }),
    ),
  );

  it.effect("keeps a fork of a completed managed lead confined", () =>
    scenario(({ call, store, flags }) =>
      Effect.gen(function* () {
        assert.isFalse(
          (yield* call("factory_dispatch", {
            command: {
              type: "onboarding.report",
              commandId: "complete-before-fork",
              assignmentId,
              report,
            },
          })).isError,
        );
        assert.equal(
          (yield* store.snapshot).assignments.find((entry) => entry.id === assignmentId)?.status,
          "complete",
        );
        assert.isTrue((yield* call("host_effect", {}, forkId)).isError);
        assert.equal(flags.hostCalls, 0);
      }),
    ),
  );

  it.effect("fails closed for cyclic or missing subagent ancestry", () =>
    scenario(({ call, shells, flags }) =>
      Effect.gen(function* () {
        shells.set(childId, {
          ...liveThreadShell(childId),
          lineage: {
            rootThreadId: childId,
            parentThreadId: childId,
            relationshipToParent: "subagent",
          },
        });
        assert.isTrue((yield* call("host_effect", {}, childId)).isError);
        shells.delete(childId);
        assert.isTrue((yield* call("host_effect", {}, grandchildId)).isError);
        assert.equal(flags.hostCalls, 0);
      }),
    ),
  );
});
