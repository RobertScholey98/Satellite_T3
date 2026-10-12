import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryAssignmentId,
  FactoryControlId,
  FactoryDependencyId,
  FactoryError,
  FactorySnapshot,
  FactoryImprovementSnapshot,
  FactoryImprovementRecord,
  FactoryIntegrationRead,
  FactoryMergeGroupRead,
  FactoryIntegrationPatchPage,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryWait,
  type FactoryScheduleCandidate,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as DeviceService from "../device/DeviceService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectService from "../project/ProjectService.ts";
import migration from "../persistence/Migrations/067_EngineeringFactory.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryMcpGuard from "./FactoryMcpGuard.ts";
import * as FactoryImprovementEvidence from "./FactoryImprovementEvidence.ts";
import * as FactoryIntegrationExecution from "./FactoryIntegrationExecution.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactorySchedulingEffects from "./FactorySchedulingEffects.ts";
import { initialFactoryCompletion } from "./FactoryRetros.ts";
import * as FactoryPreviewService from "./FactoryPreviewService.ts";
import { reviewedDeliveryFixture } from "./FactoryDelivery.testkit.ts";
import * as FactoryBoundaryExecutionTestkit from "./FactoryBoundaryExecution.testkit.ts";
import * as FactorySourceTestkit from "./FactorySource.testkit.ts";
import * as FactoryHandoverTestkit from "./FactoryHandover.testkit.ts";
import { sharedAccessFixture } from "./FactorySharedAccess.testkit.ts";
import { frozenMergeOperationFixture } from "./FactoryMergeOperation.testkit.ts";
import * as FactoryServiceTestkit from "./FactoryService.testkit.ts";

const now = "2026-10-10T12:00:00.000Z";
const managerId = ThreadId.make("manager-web");
const leadId = ThreadId.make("lead-web");
const childId = ThreadId.make("child-web");
const grandchildId = ThreadId.make("grandchild-web");
const forkId = ThreadId.make("fork-web");
const unmanagedId = ThreadId.make("independent-thread");
const reviewerId = ThreadId.make("delivery-reviewer");
const assignmentId = FactoryAssignmentId.make("assignment-web");
const otherAssignmentId = FactoryAssignmentId.make("assignment-api");
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(FactorySnapshot));
const decodeFactorySnapshot = Schema.decodeUnknownEffect(FactorySnapshot);
const decodeImprovementSnapshot = Schema.decodeUnknownEffect(FactoryImprovementSnapshot);
const decodeImprovementRecord = Schema.decodeUnknownEffect(FactoryImprovementRecord);
const decodeIntegrationRead = Schema.decodeUnknownEffect(FactoryIntegrationRead);
const decodeMergeGroupRead = Schema.decodeUnknownEffect(FactoryMergeGroupRead);
const decodeIntegrationPatch = Schema.decodeUnknownEffect(FactoryIntegrationPatchPage);
const decodeRecordReason = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.String })),
);
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
  readonly previewCalls: Array<{ threadId: ThreadId; instanceId: string; action: string }>;
  readonly ticketReads: string[];
}

/**
 * Whether a call was refused: an error result, or an MCP error before any
 * handler ran, for a tool outside the caller's grant or parameters it rejects.
 */
const refused = (result: ReturnType<Scenario["call"]>) =>
  result.pipe(
    Effect.map((value) => value.isError === true),
    Effect.catchTag("InvalidParams", () => Effect.succeed(true)),
  );

const scenario = <E, R>(
  test: (context: Scenario) => Effect.Effect<void, E, R>,
  heldWait?: FactoryWait,
  withReviewer: boolean | "retro" = false,
  withTickets = false,
) =>
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
    yield* Effect.forEach(
      pending.filter((operation) => operation.intent.type === "thread.launch"),
      (operation) =>
        store.finishEffect({
          id: operation.id,
          command: {
            type: "thread.launch.recorded",
            commandId: CommandId.make(`${operation.id}:recorded`),
            threadId:
              operation.intent.type === "thread.launch" ? operation.intent.threadId : leadId,
          },
          now,
        }),
    );
    if (heldWait !== undefined) {
      const state = yield* store.snapshot;
      const payload = yield* encodeSnapshot({
        ...state,
        assignments: state.assignments.map((entry) =>
          entry.id === assignmentId
            ? { ...entry, kind: "implementation", status: "waiting", wait: heldWait }
            : entry,
        ),
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_state SET revision = revision + 1, payload_json = ${payload} WHERE id = 1`;
    }
    if (withReviewer) {
      const state = yield* store.snapshot;
      const fixture = reviewedDeliveryFixture();
      const assignment = fixture.assignments[0]!;
      const payload = yield* encodeSnapshot({
        ...state,
        assignments: state.assignments.map((entry) =>
          entry.id !== assignmentId
            ? entry
            : {
                ...assignment,
                id: assignmentId,
                threadId: leadId,
                managerId,
                projectId: ProjectId.make("web"),
                delivery: {
                  ...assignment.delivery!,
                  revisions: assignment.delivery!.revisions.map((revision) => ({
                    ...revision,
                    reviews: revision.reviews.map((review) => ({
                      ...review,
                      threadId: reviewerId,
                      status: "running",
                    })),
                  })),
                },
              },
        ),
        auxiliaryThreads: fixture.auxiliaryThreads.map((entry) => ({
          ...entry,
          threadId: reviewerId,
          assignmentId,
          managerId,
          projectId: ProjectId.make("web"),
          status: "running",
        })),
      });
      yield* (yield* SqlClient.SqlClient)`UPDATE factory_state SET revision = revision + 1, payload_json = ${payload} WHERE id = 1`;
    }
    if (withTickets) {
      const state = yield* store.snapshot;
      const candidates: FactoryScheduleCandidate[] = ["own", "other", "api"].map((id) => ({
        id,
        projectId: ProjectId.make(id === "api" ? "api" : "web"),
        managerId: id === "api" ? ThreadId.make("manager-api") : managerId,
        issue: {
          hostKind: "github",
          host: "github.com",
          repository: "owner/repo",
          id,
          number: 1,
          url: `https://github.com/owner/repo/issues/${id}`,
        },
        canonicalIssueKey: id,
        generation: 0,
        configurationId: "config",
        source: { kind: "tracker-ready" },
        observation: {
          title: `Ticket ${id}`,
          boardRevision: 1,
          itemId: id,
          columnId: "ready",
          ready: true,
          detailDigest: `digest:${id}`,
          observedAt: now,
        },
        lifecycle: { phase: "observed" },
        notificationDigest: null,
        notifiedDigest: null,
        createdAt: now,
        updatedAt: now,
      }));
      const payload = yield* encodeSnapshot({
        ...state,
        scheduleCandidates: candidates,
        assignments: state.assignments.map((entry) =>
          entry.id !== assignmentId
            ? entry
            : {
                ...entry,
                kind: "implementation",
                scheduling: {
                  candidateId: "own",
                  authority: {
                    kind: "tracker-ready",
                    boardId: "board",
                    itemId: "own",
                    observedAt: now,
                  },
                  issueAttempt: {
                    attemptId: "attempt",
                    reservationId: "reservation",
                    sourceEnvironmentId: EnvironmentId.make("factory-test"),
                    destinationEnvironmentId: EnvironmentId.make("factory-test"),
                    sourceProjectId: ProjectId.make("web"),
                    boardId: "board",
                    issue: candidates[0]!.issue,
                    sourceGeneration: 0,
                  },
                },
              },
        ),
      });
      yield* (yield* SqlClient.SqlClient)`UPDATE factory_state SET revision = revision + 1, payload_json = ${payload} WHERE id = 1`;
    }
    if (withReviewer === "retro") {
      const state = yield* store.snapshot;
      const assignment = state.assignments.find((entry) => entry.id === assignmentId)!;
      const qualification = {
        status: "qualified" as const,
        profileId: "retro-profile",
        checkedAt: now,
      };
      const payload = yield* encodeSnapshot({
        ...state,
        assignments: state.assignments.map((entry) =>
          entry.id !== assignmentId
            ? entry
            : {
                ...entry,
                completion: {
                  ...initialFactoryCompletion(entry.scope),
                  phase: "concluded",
                  conclusion: {
                    kind: "delivered",
                    id: "conclusion",
                    evidenceDigest: "evidence",
                    concludedAt: now,
                    planVersion: 1,
                    deliveryIds: ["delivery"],
                  },
                },
              },
        ),
        auxiliaryThreads: state.auxiliaryThreads.map((entry) =>
          entry.threadId !== reviewerId
            ? entry
            : {
                ...entry,
                kind: "retrospective",
                incidentId: "retro",
                qualification,
                sourceDigest: "retro-source",
              },
        ),
        retros: [
          {
            id: "retro",
            assignmentId,
            conclusionId: "conclusion",
            evidenceDigest: "evidence",
            threadId: reviewerId,
            modelSelection: assignment.modelSelection!,
            execution: {
              status: "ready",
              qualification,
              sourceDigest: "retro-source",
              launch: "delivered",
            },
            reports: { phase: "team-pending" },
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      yield* (yield* SqlClient.SqlClient)`UPDATE factory_state SET revision = revision + 1, payload_json = ${payload} WHERE id = 1`;
    }
    const ticketReads: string[] = [];
    const flags = { hostCalls: 0, missingProfile: false, unavailableStore: false };
    const previewCalls: Scenario["previewCalls"] = [];
    const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
      [managerId, liveThreadShell(managerId)],
      [leadId, liveThreadShell(leadId)],
      [unmanagedId, liveThreadShell(unmanagedId)],
      [reviewerId, liveThreadShell(reviewerId)],
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
    for (const [id, shell] of shells)
      shells.set(id, { ...shell, projectId: ProjectId.make("web") });
    const external = Layer.mergeAll(
      Layer.mock(FactorySchedulingEffects.FactorySchedulingEffects)({
        watch: () => Effect.void,
        reconcile: Effect.void,
        handle: () => Effect.void,
        context: () => Effect.succeed({}),
        release: () => Effect.void,
        beforeLaunch: () => Effect.void,
        read: (candidateId) =>
          Effect.sync(() => {
            ticketReads.push(candidateId);
            return {
              detail: {
                ref: {
                  hostKind: "github",
                  host: "github.com",
                  repository: "owner/repo",
                  id: candidateId,
                  number: 1,
                  url: `https://github.com/owner/repo/issues/${candidateId}`,
                },
                title: `Ticket ${candidateId}`,
                state: "open",
                updatedAt: now,
                labels: [],
                body: "Full ticket body",
                comments: [],
              },
              detailDigest: `digest:${candidateId}`,
            };
          }),
      }),
      FactoryBoundaryExecutionTestkit.layerUnavailable,
      Layer.mock(EventSink.EventSinkV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (id) => Effect.sync(() => shells.get(id) ?? null),
      }),
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
      Layer.mock(FactoryIntegrationExecution.FactoryIntegrationExecution)({
        readPatch: (input) =>
          Effect.sync(() => {
            flags.hostCalls += 1;
            return {
              patchArtifactId: input.patchArtifactId,
              projectId: ProjectId.make(input.patchArtifactId === "patch-api" ? "api" : "web"),
              digest: "patch-digest",
              encoding: "json" as const,
              text: "{}",
              cursor: input.cursor ?? 0,
              nextCursor: null,
              totalCharacters: 2,
            };
          }),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(FactoryPreviewService.FactoryPreviewService)({
        invoke: (threadId, input) =>
          Effect.sync(() => {
            previewCalls.push({
              threadId,
              instanceId: input.instanceId,
              action: input.action.type,
            });
            return {
              sequence: 1,
              receiptDigest: "receipt",
              result:
                input.action.type === "snapshot"
                  ? {
                      url: "http://127.0.0.1:9000/",
                      title: "Candidate",
                      loading: false,
                      visibleText: "Save",
                      interactiveElements: [],
                      accessibilityTree: '- button "Save"',
                      consoleEntries: [],
                      networkEntries: [],
                      actionTimeline: [],
                      screenshot: { mimeType: "image/png", data: "aW1hZ2U=", width: 1, height: 1 },
                    }
                  : null,
            };
          }),
        finish: (threadId, input) =>
          Effect.sync(() => {
            previewCalls.push({ threadId, instanceId: input.instanceId, action: "finish" });
            return {
              instanceId: input.instanceId,
              candidateDigest: "digest",
              reviewThreadId: threadId,
              operationsDigest: "operations",
              screenshots: [{ label: "Screenshot", location: "candidate://screenshot" }],
              journeys: [{ label: "Save", location: "candidate://journey" }],
              observedAt: now,
            };
          }),
      }),
    );
    const ProbeToolkit = Toolkit.make(
      Tool.make("t3_thread_send", {
        description: "Probe the team communication boundary.",
        parameters: Schema.Struct({ threadId: ThreadId }),
        success: Schema.Struct({ ran: Schema.Boolean }),
        failure: OrchestratorMcpFailure,
        failureMode: "return",
      }),
      Tool.make("t3_thread_read", {
        description: "Probe reading team evidence during a wait.",
        parameters: Schema.Struct({ threadId: ThreadId }),
        success: Schema.Struct({ ran: Schema.Boolean }),
        failure: OrchestratorMcpFailure,
        failureMode: "return",
      }),
      Tool.make("t3_thread_wait", {
        description: "Probe awaiting a team response.",
        parameters: Schema.Struct({ threadId: ThreadId }),
        success: Schema.Struct({ ran: Schema.Boolean }),
        failure: OrchestratorMcpFailure,
        failureMode: "return",
      }),
      Tool.make("t3_thread_fork", {
        description: "Probe forking, which only humans may do.",
        parameters: Schema.Struct({ threadId: ThreadId }),
        success: Schema.Struct({ ran: Schema.Boolean }),
        failure: OrchestratorMcpFailure,
        failureMode: "return",
      }),
      Tool.make("host_effect", {
        description: "A host operation that managed agents cannot run.",
        parameters: Tool.EmptyParams,
        success: Schema.Struct({ ran: Schema.Boolean }),
        failure: OrchestratorMcpFailure,
        failureMode: "return",
      }),
      Tool.make("preview_navigate", {
        description: "Probe the unrestricted host browser boundary.",
        parameters: Schema.Struct({ url: Schema.String }),
        success: Schema.Struct({ ran: Schema.Boolean }),
        failure: OrchestratorMcpFailure,
        failureMode: "return",
      }),
    );
    const registration = Layer.mergeAll(
      McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          t3_thread_send: McpToolAccess.reads(() =>
            Effect.sync(() => {
              flags.hostCalls += 1;
              return { ran: true };
            }),
          ),
          t3_thread_read: McpToolAccess.reads(() =>
            Effect.sync(() => {
              flags.hostCalls += 1;
              return { ran: true };
            }),
          ),
          t3_thread_wait: McpToolAccess.reads(() =>
            Effect.sync(() => {
              flags.hostCalls += 1;
              return { ran: true };
            }),
          ),
          t3_thread_fork: McpToolAccess.reads(() =>
            Effect.sync(() => {
              flags.hostCalls += 1;
              return { ran: true };
            }),
          ),
          host_effect: McpToolAccess.reads(() =>
            Effect.sync(() => {
              flags.hostCalls += 1;
              return { ran: true };
            }),
          ),
          preview_navigate: McpToolAccess.reads(() =>
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
      Layer.provideMerge(FactoryMcpGuard.layer),
      Layer.provide(
        FactoryService.layer.pipe(Layer.provide(FactoryServiceTestkit.layerTestDependencies)),
      ),
      Layer.provide(Layer.mock(FactoryImprovementEvidence.FactoryImprovementEvidence)({})),
      Layer.provide(
        Layer.mergeAll(FactorySourceTestkit.layerUnused, FactoryHandoverTestkit.layerUnused),
      ),
      Layer.provide(external),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const callers = yield* McpToolAccess.CallerPolicy;
      yield* test({
        store,
        flags,
        shells,
        previewCalls,
        ticketReads,
        call: (name, args = {}, caller = leadId) => {
          const result = server
            .callTool({ name, arguments: args })
            .pipe(Effect.provideService(McpSchema.McpServerClient, client));
          return caller === null
            ? result
            : result.pipe(
                McpToolAccess.provideCaller(invocation(caller)),
                Effect.provideService(McpToolAccess.CallerPolicy, callers),
              );
        },
      });
    }).pipe(Effect.provide(registration));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped);

describe("FactoryMcpGuard", () => {
  it.effect(
    "keeps combined review inspection with the current integration lead and human decisions out of MCP",
    () =>
      scenario(({ call, store, flags }) =>
        Effect.gen(function* () {
          const state = yield* store.snapshot;
          const integrationId = "combined-feature";
          const groupId = "combined-group";
          const webMember = FactoryAssignmentId.make("web-member");
          const payload = yield* encodeSnapshot({
            ...state,
            assignments: [
              ...state.assignments.map((entry) =>
                entry.id === assignmentId
                  ? { ...entry, kind: "implementation" as const, integrationId }
                  : entry,
              ),
              {
                ...state.assignments.find((entry) => entry.id === assignmentId)!,
                id: webMember,
                threadId: ThreadId.make("web-member-lead"),
                kind: "implementation",
              },
            ],
            integrations: [
              {
                id: integrationId,
                assignmentId,
                requesterManagerId: managerId,
                requestIds: ["request"],
                participantAssignmentIds: [webMember, otherAssignmentId],
                coordinatorProjectId: ProjectId.make("web"),
                phase: "awaiting-grants",
                waitReason: null,
                hold: null,
                currentPreparationId: null,
                currentTestArtifactId: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
            mergeGroups: [
              {
                id: groupId,
                integrationId,
                integrationAssignmentId: assignmentId,
                memberAssignmentIds: [webMember, otherAssignmentId],
                knownPullRequests: [],
                currentReviewId: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
          });
          yield* (yield* SqlClient.SqlClient)`UPDATE factory_state SET revision = revision + 1, payload_json = ${payload} WHERE id = 1`;
          flags.missingProfile = true;
          const read = yield* call("factory_merge_group_get", { groupId });
          assert.isFalse(read.isError);
          const parsed = yield* decodeMergeGroupRead(read.structuredContent);
          assert.equal(parsed.group.id, groupId);
          assert.deepEqual(
            parsed.readiness.members.map((entry) => entry.assignmentId),
            [webMember, otherAssignmentId],
          );
          assert.notProperty(parsed.readiness.members[0]!, "workflow");
          assert.notProperty(parsed.readiness.members[0]!, "grant");
          assert.notProperty(parsed, "assignments");
          assert.isTrue((yield* call("factory_merge_group_get", { groupId: "unrelated" })).isError);
          for (const caller of [managerId, childId, grandchildId, ThreadId.make("lead-api")]) {
            assert.isTrue((yield* call("factory_merge_group_get", { groupId }, caller)).isError);
            assert.isTrue(
              (yield* call(
                "factory_merge_group_review",
                { commandId: `review-${caller}`, groupId },
                caller,
              )).isError,
            );
          }
          flags.missingProfile = false;
          for (const type of ["merge.group.approve", "merge.group.reject"]) {
            assert.isTrue(
              (yield* call("factory_dispatch", {
                command: {
                  type,
                  commandId: type,
                  groupId,
                  reviewId: "review",
                  expectedDigest: "digest",
                  ...(type.endsWith("reject") ? { reason: "Agent must not decide" } : {}),
                },
              })).isError,
            );
          }
          assert.isTrue(
            (yield* call("t3_thread_read", { threadId: ThreadId.make("lead-api") })).isError,
          );
          assert.equal(flags.hostCalls, 0);
        }),
      ),
  );
  it.effect(
    "limits a frozen integration lead to its merge recovery and still applies project pauses",
    () =>
      scenario(({ call, store }) =>
        Effect.gen(function* () {
          const state = yield* store.snapshot;
          const integrationId = "frozen-feature";
          const groupId = "frozen-group";
          const operation = frozenMergeOperationFixture().state.mergeOperations[0]!;
          const write = (snapshot: FactorySnapshot) =>
            encodeSnapshot(snapshot).pipe(
              Effect.flatMap((payload) =>
                SqlClient.SqlClient.pipe(
                  Effect.flatMap(
                    (sql) =>
                      sql`UPDATE factory_state SET revision = revision + 1, payload_json = ${payload} WHERE id = 1`,
                  ),
                ),
              ),
            );
          const frozen: FactorySnapshot = {
            ...state,
            assignments: state.assignments.map((entry) =>
              entry.id === assignmentId ? { ...entry, integrationId } : entry,
            ),
            mergeGroups: [
              {
                id: groupId,
                integrationId,
                integrationAssignmentId: assignmentId,
                memberAssignmentIds: [otherAssignmentId, FactoryAssignmentId.make("web-member")],
                knownPullRequests: [],
                currentReviewId: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
            mergeOperations: [
              { ...operation, groupId, integrationId, integrationAssignmentId: assignmentId },
            ],
          };
          yield* write(frozen);
          assert.isFalse((yield* call("factory_merge_group_get", { groupId })).isError);
          assert.isTrue((yield* call("factory_integration_get", { integrationId })).isError);
          assert.isTrue((yield* call("factory_merge_group_get", { groupId }, childId)).isError);
          const escalation = {
            type: "merge.operation.escalate",
            commandId: "lead-escalation",
            operationId: operation.id,
            reason: "A member PR merged with an unexpected head",
            recommendation: "Revert the merged member in a separate task",
          };
          const incomplete = yield* Effect.flip(
            call("factory_merge_operation_action", {
              command: { ...escalation, recommendation: undefined },
            }),
          );
          assert.equal(incomplete._tag, "InvalidParams");
          const escalated = yield* call("factory_merge_operation_action", { command: escalation });
          assert.isFalse(escalated.isError);
          assert.include(JSON.stringify(escalated.content), operation.id);
          yield* write({
            ...frozen,
            controls: [
              {
                id: FactoryControlId.make("frozen-pause"),
                generation: 1,
                kind: "project-pause",
                status: "active",
                projectId: state.assignments.find((entry) => entry.id === assignmentId)!.projectId,
                stop: { status: "pending" },
                requestedAt: now,
                updatedAt: now,
              },
            ],
          });
          assert.isTrue((yield* call("factory_merge_group_get", { groupId })).isError);
          assert.isTrue(
            (yield* call("factory_merge_operation_action", {
              command: {
                type: "merge.operation.retry",
                commandId: "paused-retry",
                operationId: operation.id,
              },
            })).isError,
          );
        }),
      ),
  );
  it.effect(
    "scopes integration identities and paged patches without granting peer source reads",
    () =>
      scenario(({ call, store, flags }) =>
        Effect.gen(function* () {
          const state = yield* store.snapshot;
          const integrationAssignmentId = FactoryAssignmentId.make("integration-work");
          const integrationId = "integration";
          const payload = yield* encodeSnapshot({
            ...state,
            assignments: state.assignments.map((entry) => ({ ...entry, kind: "implementation" })),
            integrations: [
              {
                id: integrationId,
                assignmentId: integrationAssignmentId,
                requesterManagerId: managerId,
                requestIds: ["request"],
                participantAssignmentIds: [assignmentId, otherAssignmentId],
                coordinatorProjectId: ProjectId.make("web"),
                phase: "awaiting-grants",
                waitReason: null,
                hold: null,
                currentPreparationId: null,
                currentTestArtifactId: "tests",
                createdAt: now,
                updatedAt: now,
              },
            ],
            integrationTestArtifacts: [
              {
                id: "tests",
                integrationId,
                preparationId: "old-preparation",
                digest: "digest",
                capturedAt: now,
                projects: ["web", "api"].map((name) => ({
                  projectId: ProjectId.make(name),
                  grantId: name,
                  candidateId: name,
                  candidateDigest: name,
                  sourceDigest: name,
                  changedPaths: ["test.js"],
                  deletedPaths: [],
                  patchArtifactId: `patch-${name}`,
                })),
              },
            ],
          });
          yield* (yield* SqlClient.SqlClient)`UPDATE factory_state SET revision = revision + 1, payload_json = ${payload} WHERE id = 1`;
          flags.missingProfile = true;
          const read = yield* call("factory_integration_get", { integrationId }, leadId);
          assert.isFalse(read.isError);
          const parsed = yield* decodeIntegrationRead(read.structuredContent);
          assert.deepEqual(
            parsed.participants.map((entry) => entry.assignmentId),
            [assignmentId, otherAssignmentId],
          );
          assert.deepEqual(
            parsed.integrationTestArtifacts[0]!.projects.map((entry) => entry.projectId),
            ["web"],
          );
          assert.notProperty(parsed.participants[1]!, "workflow");
          assert.notProperty(parsed.participants[1]!, "grant");
          const ownPatch = yield* call(
            "factory_integration_read_patch",
            { patchArtifactId: "patch-web" },
            leadId,
          );
          assert.isFalse(ownPatch.isError);
          assert.equal(
            (yield* decodeIntegrationPatch(ownPatch.structuredContent)).projectId,
            "web",
          );
          assert.isTrue(
            (yield* call(
              "factory_integration_read_patch",
              { patchArtifactId: "patch-api" },
              leadId,
            )).isError,
          );
          assert.isTrue(
            (yield* call(
              "factory_integration_read_patch",
              { patchArtifactId: "unknown" },
              managerId,
            )).isError,
          );
          assert.isTrue(
            (yield* call("factory_integration_get", { integrationId: "unrelated" }, managerId))
              .isError,
          );
          assert.isTrue(
            (yield* call("factory_integration_get", { integrationId }, childId)).isError,
          );
          assert.isFalse(
            (yield* call(
              "factory_integration_read_patch",
              { patchArtifactId: "patch-api" },
              managerId,
            )).isError,
          );
          assert.equal(flags.hostCalls, 2);
          flags.missingProfile = false;
          assert.isTrue(
            (yield* call("t3_thread_read", { threadId: ThreadId.make("lead-api") }, leadId))
              .isError,
          );
        }),
      ),
  );
  it.effect(
    "exposes only peer identities to managers and keeps accepted collaboration out of generic tools",
    () =>
      scenario(({ call, store, flags }) =>
        Effect.gen(function* () {
          const state = yield* store.snapshot;
          const directory = yield* call("factory_collaboration_directory", {}, managerId);
          assert.deepEqual(directory.structuredContent, {
            entries: [
              {
                managerId: "manager-api",
                name: state.managers.find((entry) => entry.id === "manager-api")!.name,
                role: "project",
                projectId: "api",
                status: "onboarding",
              },
            ],
            nextCursor: null,
          });
          for (const caller of [leadId, childId, grandchildId, unmanagedId] as const)
            assert.isTrue(yield* refused(call("factory_collaboration_directory", {}, caller)));
          const payload = yield* encodeSnapshot({
            ...state,
            crossProjectRequests: [
              {
                id: "peer-request",
                origin: { kind: "assignment", assignmentId },
                originManagerId: managerId,
                originThreadId: leadId,
                originalLeadThreadId: leadId,
                receiverManagerId: ThreadId.make("manager-api"),
                outcome: "Add API",
                acceptanceConditions: "Frontend works",
                compatibility: "Existing callers supported",
                generation: 1,
                lifecycle: {
                  phase: "accepted",
                  notifiedConclusionId: null,
                  support: { assignmentId: otherAssignmentId, dedicated: true },
                },
                createdAt: now,
                updatedAt: now,
              },
            ],
            collaborationMessages: [
              {
                id: "peer-message",
                requestId: "peer-request",
                fromAssignmentId: assignmentId,
                toAssignmentId: otherAssignmentId,
                senderThreadId: leadId,
                text: "Agreed API detail",
                createdAt: now,
                delivery: { phase: "pending" },
              },
            ],
          });
          yield* (yield* SqlClient.SqlClient)`UPDATE factory_state SET revision=revision+1, payload_json=${payload} WHERE id=1`;
          const lead = yield* decodeFactorySnapshot(
            (yield* call("factory_snapshot", {}, leadId)).structuredContent,
          );
          assert.deepEqual(
            lead.crossProjectRequests.map((entry) => entry.id),
            ["peer-request"],
          );
          assert.deepEqual(
            lead.collaborationMessages.map((entry) => entry.id),
            ["peer-message"],
          );
          assert.deepEqual(
            lead.assignments.map((entry) => entry.id),
            [assignmentId],
          );
          const child = yield* decodeFactorySnapshot(
            (yield* call("factory_snapshot", {}, childId)).structuredContent,
          );
          assert.isEmpty(child.collaborationMessages);
          for (const name of ["t3_thread_send", "t3_thread_read", "t3_thread_wait"])
            assert.isTrue(
              (yield* call(name, { threadId: ThreadId.make("lead-api") }, leadId)).isError,
            );
          assert.equal(flags.hostCalls, 0);
        }),
      ),
  );
  it.effect(
    "scopes shared teams to registered work and denies experiment publication across descendants",
    () =>
      scenario(
        ({ call, store, shells, flags }) =>
          Effect.gen(function* () {
            const shared = sharedAccessFixture(yield* store.snapshot, true);
            const sql = yield* SqlClient.SqlClient;
            const payload = yield* encodeSnapshot(shared);
            yield* sql`UPDATE factory_state SET revision = revision + 1, payload_json = ${payload} WHERE id = 1`;
            shells.set(managerId, {
              ...liveThreadShell(managerId),
              projectId: ProjectId.make("system-reference"),
            });
            const own = yield* decodeFactorySnapshot(
              (yield* call("factory_snapshot", {}, managerId)).structuredContent,
            );
            assert.deepEqual(
              own.assignments.map((entry) => entry.id),
              [assignmentId],
            );
            assert.equal(own.projectTrackers.length, 0);
            assert.equal(own.sharedRepositories.length, 1);
            const child = yield* decodeFactorySnapshot(
              (yield* call("factory_snapshot", {}, grandchildId)).structuredContent,
            );
            assert.deepEqual(
              child.assignments.map((entry) => entry.id),
              [assignmentId],
            );
            assert.equal(child.workflowExperiments.length, 1);
            assert.isFalse(
              (yield* call("t3_thread_read", { threadId: leadId }, managerId)).isError ?? false,
            );
            assert.isTrue(
              (yield* call("t3_thread_read", { threadId: ThreadId.make("lead-api") }, managerId))
                .isError,
            );
            const previousHostCalls = flags.hostCalls;
            for (const caller of [leadId, childId, grandchildId]) {
              assert.isTrue((yield* call("host_effect", {}, caller)).isError);
              assert.isTrue(
                (yield* call(
                  "factory_dispatch",
                  {
                    command: {
                      type: "delivery.publish",
                      commandId: `forbidden:${caller}`,
                      assignmentId,
                      revisionId: "revision",
                      title: "Forbidden experiment publication",
                      body: "Experiment must remain isolated.",
                    },
                  },
                  caller,
                )).isError,
              );
            }
            assert.equal(flags.hostCalls, previousHostCalls);
            const missing = yield* encodeSnapshot({ ...shared, workflowExperiments: [] });
            yield* sql`UPDATE factory_state SET revision = revision + 1, payload_json = ${missing} WHERE id = 1`;
            assert.isTrue((yield* call("factory_snapshot", {}, grandchildId)).isError);
          }),
        undefined,
        true,
      ),
  );
  it.effect(
    "gives the system peer only compact investigation tools and denies project delivery and generic host reads",
    () =>
      scenario(({ call, store, shells, flags }) =>
        Effect.gen(function* () {
          const systemId = ThreadId.make("system-manager");
          yield* store.commit({
            actor: { kind: "human" },
            command: {
              type: "system.create",
              commandId: CommandId.make("create-system"),
              workspaceProjectId: ProjectId.make("web"),
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "approved-model",
              },
              workflow: { repositoryRoot: "/owned", revision: "pinned" },
            },
            systemManagerCreation: {
              threadId: systemId,
              qualification: { status: "qualified", profileId: "system-profile", checkedAt: now },
            },
            now,
          });
          yield* store.commit({
            actor: { kind: "system" },
            command: {
              type: "system.launch.recorded",
              commandId: CommandId.make("launch-system"),
              managerId: systemId,
              profileId: "system-profile",
            },
            now,
          });
          shells.set(systemId, { ...liveThreadShell(systemId), projectId: ProjectId.make("web") });
          const state = yield* store.snapshot;
          const budgetDay = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
          const projected = yield* encodeSnapshot({
            ...state,
            improvementDecisions: [
              ...Array.from({ length: 7 }, (_, index) => ({
                proposalId: "proposal",
                revision: `revision-${index}`,
                outcome: "deferred" as const,
                reason: "Keep this decision rationale ".repeat(80),
                commandId: CommandId.make(`decision-${index}`),
                decidedAt: now,
              })),
              {
                proposalId: "proposal",
                revision: "revision-6",
                outcome: "accepted" as const,
                reason: "Accepted after deferral ".repeat(80),
                commandId: CommandId.make("decision-redecided"),
                decidedAt: now,
              },
            ],
            improvementInvestigations: [
              {
                id: "investigation",
                title: "Shared review slowdown",
                findingIds: ["attached-unsampled"],
                relatedInvestigationIds: [],
                uncertainty: "",
                assessment: "",
                lifecycle: { phase: "open" },
                createdAt: now,
                updatedAt: now,
              },
            ],
            improvementFeedback: [
              {
                id: "feedback",
                proposalId: "proposal",
                revision: "revision-6",
                usefulness: "noisy",
                reason: "Repeated recommendation",
                recordedAt: now,
              },
            ],
            improvementRecurrences: [
              {
                id: "recurrence",
                investigationId: "investigation",
                findingId: "finding",
                reason: "Failure returned",
                recordedAt: now,
              },
            ],
            improvementBatches: [
              {
                id: "spent",
                managerId: systemId,
                kind: "routine",
                intakeIds: ["intake"],
                digest: "batch-digest",
                summary: "Consumed review",
                budgetDay,
                createdAt: now,
                delivery: { status: "pending" },
              },
            ],
            findings: [
              ...state.findings,
              {
                id: "contained",
                assignmentId,
                reporterThreadId: leadId,
                problem: "Long problem ".repeat(100),
                impact: "Slower reviews",
                evidence: [{ kind: "thread", threadId: leadId }],
                activeBlocker: false,
                route: {
                  suspectedCause: "shared-system",
                  uncertainty: "Only seen once",
                  owner: { kind: "system-remit" },
                  requiredAuthority: "Human review",
                  rationale: "Shared instructions",
                },
                containmentOf: "source-finding",
                history: [],
                escalation: null,
                createdAt: now,
                updatedAt: now,
              },
              ...["attached-unsampled", "hidden-unsampled"].map((id) => ({
                id,
                assignmentId,
                reporterThreadId: leadId,
                problem: "Local slowdown",
                impact: "Slower reviews",
                evidence: [{ kind: "thread" as const, threadId: leadId }],
                activeBlocker: false,
                route: {
                  suspectedCause: "project" as const,
                  uncertainty: "Seen in one project",
                  owner: { kind: "system-remit" as const },
                  requiredAuthority: "Human review",
                  rationale: "Local habit",
                },
                containmentOf: null,
                history: [],
                escalation: null,
                createdAt: now,
                updatedAt: now,
              })),
            ],
            improvementIntakes: [
              {
                id: "contained-intake",
                findingId: "contained",
                sourceDigest: "digest",
                projectId: ProjectId.make("web"),
                assignmentId,
                origin: "retro",
                sampling: { kind: "all" },
                summary: "Contained finding",
                queuedAt: now,
                delivery: { phase: "queued" },
              },
              ...["attached-unsampled", "hidden-unsampled"].map((findingId) => ({
                id: `${findingId}-intake`,
                findingId,
                sourceDigest: `${findingId}-digest`,
                projectId: ProjectId.make("web"),
                assignmentId,
                origin: "retro" as const,
                sampling: { kind: "all" as const },
                summary: "Unsampled local finding",
                queuedAt: now,
                delivery: { phase: "skipped" as const },
              })),
            ],
          });
          yield* (yield* SqlClient.SqlClient)`UPDATE factory_state SET revision=revision+1, payload_json=${projected} WHERE id=1`;
          const response = yield* call("factory_improvement_snapshot", {}, systemId);
          const compact = yield* decodeImprovementSnapshot(response.structuredContent);
          assert.equal(compact.decisions.length, 5);
          assert.equal(compact.decisions[0]?.reason.length, 1000);
          assert.equal(compact.feedback[0]?.usefulness, "noisy");
          assert.equal(compact.recurrences[0]?.findingId, "finding");
          // Unsampled findings appear once attached to an investigation, and not before.
          assert.deepEqual(compact.findings.map((entry) => entry.id).toSorted(), [
            "attached-unsampled",
            "contained",
          ]);
          const contained = compact.findings.find((entry) => entry.id === "contained");
          assert.equal(contained?.containmentOf, "source-finding");
          assert.equal(contained?.uncertainty, "Only seen once");
          assert.equal(compact.budget.used, 1);
          assert.equal(compact.budget.remaining, compact.settings.routineBatchesPerDay - 1);
          assert.equal(compact.nextCursor, 5);
          const next = yield* decodeImprovementSnapshot(
            (yield* call("factory_improvement_snapshot", { cursor: compact.nextCursor }, systemId))
              .structuredContent,
          );
          assert.equal(next.decisions.length, 3);
          assert.equal(next.nextCursor, null);
          const project = yield* decodeFactorySnapshot(
            (yield* call("factory_snapshot", {}, managerId)).structuredContent,
          );
          assert.equal(project.improvementDecisions.length, 0);
          assert.equal(project.improvementFeedback.length, 0);
          const namedRecord = { kind: "decision", id: "proposal", revision: "revision-6" };
          const readRecord = (cursor?: { offset: number; digest: string }) =>
            call(
              "factory_improvement_record",
              { record: namedRecord, limit: 1000, ...(cursor ? { cursor } : {}) },
              systemId,
            ).pipe(Effect.flatMap((result) => decodeImprovementRecord(result.structuredContent)));
          let page = yield* readRecord();
          assert.equal(page.text.length, 1000);
          let complete = page.text;
          while (page.nextCursor !== null) {
            page = yield* readRecord(page.nextCursor);
            complete += page.text;
          }
          const fullRecord = yield* decodeRecordReason(complete);
          // A revision decided again after deferral reads as its latest decision.
          assert.equal(fullRecord.reason, "Accepted after deferral ".repeat(80).trim());
          assert.isTrue(
            (yield* call("factory_improvement_record", { record: namedRecord }, managerId)).isError,
          );
          assert.isTrue(
            (yield* call(
              "factory_improvement_record",
              { record: { ...namedRecord, revision: "other-revision" } },
              systemId,
            )).isError,
          );
          assert.isTrue(
            (yield* call(
              "factory_improvement_record",
              { record: namedRecord, cursor: { offset: 1000, digest: "stale" } },
              systemId,
            )).isError,
          );
          assert.isFalse(response.isError ?? false);
          assert.notProperty(response.structuredContent, "assignments");
          assert.notProperty(response.structuredContent, "retros");
          const owned = yield* decodeFactorySnapshot(
            (yield* call("factory_snapshot", {}, systemId)).structuredContent,
          );
          assert.equal(owned.assignments.length, 0);
          assert.deepEqual(
            owned.managers.map((entry) => entry.id),
            [systemId],
          );
          for (const name of [
            "host_effect",
            "preview_navigate",
            "t3_thread_read",
            "t3_thread_send",
            "t3_thread_wait",
          ]) {
            assert.isTrue(yield* refused(call(name, { threadId: leadId }, systemId)), name);
          }
          for (const command of [
            { type: "manager.pause", commandId: "system-pause-other", managerId },
            { type: "project.pause", commandId: "system-pause-project", projectId: "web" },
            {
              type: "manager.retire",
              commandId: "system-self-retire",
              managerId: systemId,
              reason: "Self retirement",
            },
            {
              type: "proposal.decide",
              commandId: "system-self-approve",
              proposalId: "proposal",
              revision: "revision",
              outcome: "accepted",
              reason: "Self approval",
            },
          ])
            assert.isTrue((yield* call("factory_dispatch", { command }, systemId)).isError);
          assert.equal(
            (yield* store.snapshot).managers.find((entry) => entry.id === systemId)?.status,
            "active",
          );
          assert.isTrue((yield* call("factory_improvement_snapshot", {}, managerId)).isError);
          const descendant = ThreadId.make("system-descendant");
          shells.set(descendant, {
            ...liveThreadShell(descendant),
            projectId: ProjectId.make("web"),
            lineage: {
              rootThreadId: systemId,
              parentThreadId: systemId,
              relationshipToParent: "subagent",
            },
          });
          assert.isTrue((yield* call("factory_improvement_snapshot", {}, descendant)).isError);
          assert.equal(flags.hostCalls, 0);
          yield* store.commit({
            actor: { kind: "human" },
            command: {
              type: "manager.pause",
              commandId: CommandId.make("pause-system"),
              managerId: systemId,
            },
            now,
          });
          assert.isTrue((yield* call("factory_improvement_snapshot", {}, systemId)).isError);
        }),
      ),
  );
  it.effect("reads exact scoped tickets without exposing other teams or projects", () =>
    scenario(
      ({ call, ticketReads }) =>
        Effect.gen(function* () {
          for (const caller of [leadId, childId, grandchildId, reviewerId]) {
            assert.isFalse(
              (yield* call("factory_ticket_read", { candidateId: "own" }, caller)).isError ?? false,
            );
            assert.isTrue(
              (yield* call("factory_ticket_read", { candidateId: "other" }, caller)).isError,
            );
            const snapshot = yield* call("factory_snapshot", {}, caller);
            const parsed = yield* decodeFactorySnapshot(snapshot.structuredContent);
            assert.deepEqual(
              parsed.scheduleCandidates.map((entry) => entry.id),
              ["own"],
            );
          }
          assert.isFalse(
            (yield* call("factory_ticket_read", { candidateId: "other" }, managerId)).isError ??
              false,
          );
          const managerSnapshot = yield* decodeFactorySnapshot(
            (yield* call("factory_snapshot", {}, managerId)).structuredContent,
          );
          assert.deepEqual(
            managerSnapshot.scheduleCandidates.map((entry) => entry.id),
            ["own", "other"],
          );
          for (const caller of [managerId, leadId, reviewerId, unmanagedId, "client"] as const)
            assert.isTrue(
              yield* refused(call("factory_ticket_read", { candidateId: "api" }, caller)),
            );
          assert.deepEqual(ticketReads, ["own", "own", "own", "own", "other"]);
        }),
      undefined,
      true,
      true,
    ),
  );
  it.effect("lets the current retrospective read only its concluded assignment ticket", () =>
    scenario(
      ({ call, ticketReads }) =>
        Effect.gen(function* () {
          const own = yield* call("factory_ticket_read", { candidateId: "own" }, reviewerId);
          assert.isFalse(own.isError ?? false);
          assert.isTrue(
            (yield* call("factory_ticket_read", { candidateId: "other" }, reviewerId)).isError,
          );
          assert.isTrue(
            (yield* call("factory_ticket_read", { candidateId: "own" }, leadId)).isError,
          );
          const snapshot = yield* decodeFactorySnapshot(
            (yield* call("factory_snapshot", {}, reviewerId)).structuredContent,
          );
          assert.deepEqual(
            snapshot.scheduleCandidates.map((entry) => entry.id),
            ["own"],
          );
          assert.deepEqual(ticketReads, ["own"]);
        }),
      undefined,
      "retro",
      true,
    ),
  );
  it.effect(
    "routes only the independent reviewer's scoped preview tools with authenticated identity",
    () =>
      scenario(
        ({ call, previewCalls, flags }) =>
          Effect.gen(function* () {
            const input = {
              commandId: "preview-action",
              instanceId: "candidate-app",
              journey: "Save",
            };
            assert.isFalse(
              (yield* call(
                "factory_preview_action",
                { ...input, action: { type: "navigate", path: "/" } },
                reviewerId,
              )).isError ?? false,
            );
            const snapshot = yield* call(
              "factory_preview_snapshot",
              { ...input, commandId: "preview-snapshot" },
              reviewerId,
            );
            assert.isFalse(snapshot.isError ?? false);
            assert.isTrue(snapshot.content.some((entry) => entry.type === "image"));
            assert.isFalse(
              (yield* call(
                "factory_preview_finish",
                { commandId: "preview-finish", instanceId: "candidate-app", journeys: ["Save"] },
                reviewerId,
              )).isError ?? false,
            );
            assert.deepStrictEqual(previewCalls, [
              { threadId: reviewerId, instanceId: "candidate-app", action: "navigate" },
              { threadId: reviewerId, instanceId: "candidate-app", action: "snapshot" },
              { threadId: reviewerId, instanceId: "candidate-app", action: "finish" },
            ]);
            for (const caller of [leadId, managerId, childId]) {
              assert.isTrue(
                (yield* call(
                  "factory_preview_action",
                  { ...input, action: { type: "navigate", path: "/" } },
                  caller,
                )).isError,
              );
            }
            assert.isTrue(
              (yield* call("preview_navigate", { url: "https://outside.example" }, reviewerId))
                .isError,
            );
            assert.isTrue((yield* call("host_effect", {}, reviewerId)).isError);
            assert.lengthOf(previewCalls, 3);
            assert.equal(flags.hostCalls, 0);
          }),
        undefined,
        true,
      ),
  );

  it.effect("rejects spoofed review authority and never trusts payload caller fields", () =>
    scenario(
      ({ call, previewCalls }) =>
        Effect.gen(function* () {
          const base = {
            commandId: "spoof",
            assignmentId,
            revisionId: "revision:command",
            type: "delivery.preview.start",
            configurationId: "preview-configuration",
          };
          for (const command of [
            { ...base, reviewId: "another-review" },
            { ...base, reviewId: "review:command", revisionId: "another-revision" },
            { ...base, reviewId: "review:command", assignmentId: otherAssignmentId },
          ])
            assert.isTrue((yield* call("factory_dispatch", { command }, reviewerId)).isError);
          const spoofed = yield* call(
            "factory_preview_action",
            {
              commandId: "spoof-thread",
              instanceId: "candidate-app",
              journey: "Save",
              action: { type: "navigate", path: "/" },
              threadId: unmanagedId,
              actor: { kind: "human" },
            },
            reviewerId,
          );
          assert.isFalse(spoofed.isError ?? false);
          assert.equal(previewCalls[0]?.threadId, reviewerId);
          assert.isTrue(
            (yield* call(
              "factory_preview_action",
              {
                commandId: "spoof-reviewer",
                instanceId: "candidate-app",
                journey: "Save",
                action: { type: "navigate", path: "/" },
                threadId: reviewerId,
              },
              leadId,
            )).isError,
          );
          const arbitraryTab = yield* call(
            "factory_preview_action",
            {
              commandId: "spoof-tab",
              instanceId: "candidate-app",
              journey: "Save",
              action: { type: "click", input: { locator: "button", tabId: "user-tab" } },
            },
            reviewerId,
          ).pipe(Effect.flip);
          assert.equal(arbitraryTab._tag, "InvalidParams");
          assert.lengthOf(previewCalls, 1);
        }),
      undefined,
      true,
    ),
  );

  it.effect.each(["complete", "superseded"] as const)(
    "denies preview work after its reviewer is %s",
    (retired) =>
      scenario(
        ({ call, store, previewCalls }) =>
          Effect.gen(function* () {
            if (retired === "complete")
              yield* store.commit({
                actor: { kind: "thread", threadId: reviewerId },
                now,
                command: {
                  type: "delivery.review.report",
                  commandId: CommandId.make("finish-review"),
                  assignmentId,
                  revisionId: "revision:command",
                  reviewId: "review:command",
                  verdict: "passed",
                  confirmsImpact: true,
                  findings: "Reviewed candidate",
                  evidence: [{ label: "Source", location: "candidate://src" }],
                },
              });
            else
              yield* store.commit({
                actor: { kind: "thread", threadId: leadId },
                now,
                command: {
                  type: "delivery.capture",
                  commandId: CommandId.make("replace-candidate"),
                  assignmentId,
                  expectedEpoch: 1,
                  selectedPaths: ["src/feature.ts"],
                  commitMessage: "fix: revise candidate",
                },
              });
            const base = { commandId: "retired", instanceId: "candidate-app", journey: "Save" };
            assert.isTrue(
              (yield* call(
                "factory_preview_action",
                { ...base, action: { type: "navigate", path: "/" } },
                reviewerId,
              )).isError,
            );
            assert.isTrue((yield* call("factory_preview_snapshot", base, reviewerId)).isError);
            assert.isTrue(
              (yield* call(
                "factory_preview_finish",
                { commandId: "retired-finish", instanceId: "candidate-app", journeys: ["Save"] },
                reviewerId,
              )).isError,
            );
            assert.lengthOf(previewCalls, 0);
          }),
        undefined,
        true,
      ),
  );

  it.effect.each<FactoryWait>([
    {
      kind: "dependency",
      dependencyIds: [FactoryDependencyId.make("awaited-dependency")],
      reason: "Actual supporting delivery is pending",
    },
    {
      kind: "review",
      ref: { projectId: ProjectId.make("web"), repository: "owner/repository", number: 12 },
      reason: "The human is reviewing the implementation",
    },
    { kind: "recovery", reason: "Independent diagnosis is pending" },
    { kind: "authority", reason: "The execution grant was revoked" },
    { kind: "human-decision", reason: "A product decision is pending" },
  ])("registered parent sends cannot bypass an assignment's $kind wait", (heldWait) =>
    scenario(
      ({ call, flags }) =>
        Effect.gen(function* () {
          for (const [caller, target] of [
            [managerId, leadId],
            [managerId, grandchildId],
            [leadId, childId],
            [childId, grandchildId],
          ] as const)
            assert.isTrue((yield* call("t3_thread_send", { threadId: target }, caller)).isError);
          assert.equal(flags.hostCalls, 0);
          for (const name of ["t3_thread_read", "t3_thread_wait"])
            assert.isFalse((yield* call(name, { threadId: leadId }, managerId)).isError ?? false);
          assert.equal(
            (yield* call("t3_thread_send", { threadId: managerId }, leadId)).isError ?? false,
            heldWait.kind === "authority",
          );
          assert.equal(
            (yield* call("t3_thread_send", { threadId: leadId }, childId)).isError ?? false,
            heldWait.kind === "authority",
          );
          assert.equal(flags.hostCalls, heldWait.kind === "authority" ? 2 : 4);
        }),
      heldWait,
    ),
  );

  it.effect("checks the actual thread target before permitting team communication", () =>
    scenario(({ call, flags }) =>
      Effect.gen(function* () {
        assert.isFalse(
          (yield* call("t3_thread_send", { threadId: leadId }, managerId)).isError ?? false,
        );
        assert.isFalse(
          (yield* call("t3_thread_send", { threadId: managerId }, leadId)).isError ?? false,
        );
        assert.isFalse(
          (yield* call("t3_thread_send", { threadId: childId }, leadId)).isError ?? false,
        );
        const accepted = flags.hostCalls;
        assert.isTrue((yield* call("t3_thread_send", { threadId: unmanagedId }, leadId)).isError);
        assert.isTrue((yield* call("t3_thread_send", { threadId: "manager-api" }, leadId)).isError);
        assert.equal(flags.hostCalls, accepted);
      }),
    ),
  );
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
          yield* refused(call("host_effect", { actor: { kind: "human" }, threadId: unmanagedId })),
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
            text: "This managed thread can use only its scoped factory and approved team tools. This host tool is outside its execution grant.",
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
        assert.isTrue(yield* refused(call("factory_snapshot", {}, "client")));
        assert.isTrue(yield* refused(call("factory_snapshot", {}, unmanagedId)));
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
          yield* refused(call("factory_dispatch", { command, actor: { kind: "human" } }, "client")),
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

  // Forks are human-only: managed callers cannot fork, and a fork starts an ordinary host
  // session because native context cannot cross the managed execution boundary.
  it.effect("refuses forks from managed callers and treats a human fork as ordinary", () =>
    scenario(({ call, flags }) =>
      Effect.gen(function* () {
        for (const caller of [managerId, leadId, childId])
          assert.isTrue((yield* call("t3_thread_fork", { threadId: leadId }, caller)).isError);
        assert.isTrue((yield* call("host_effect", {}, leadId)).isError);
        assert.equal(flags.hostCalls, 0);
        assert.isTrue(yield* refused(call("factory_snapshot", {}, forkId)));
        assert.isTrue(
          yield* refused(
            call(
              "factory_dispatch",
              {
                command: {
                  type: "onboarding.report",
                  commandId: "report-from-fork",
                  assignmentId,
                  report,
                },
              },
              forkId,
            ),
          ),
        );
        assert.deepEqual((yield* call("host_effect", {}, forkId)).structuredContent, {
          ran: true,
        });
        assert.equal(flags.hostCalls, 1);
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
