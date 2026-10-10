import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactoryDependencyId,
  FactorySnapshot,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type PullRequestDetail,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  layer as SatelliteLayer,
  recordProject,
} from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryReconciliation from "./FactoryReconciliation.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";

const now = "2026-10-10T12:00:00.000Z";
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(FactorySnapshot));
const projectId = ProjectId.make("reconcile-project");
const managerId = ThreadId.make("reconcile-manager");
const leadId = ThreadId.make("reconcile-lead");
const assignmentId = FactoryAssignmentId.make("reconcile-assignment");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "approved" };
const workflow = { repositoryRoot: "/owned-workflow", revision: "pinned" };
const prRef = { projectId, repository: "owner/repo", number: 42 };
const assignment: FactoryAssignment = {
  id: assignmentId,
  managerId,
  threadId: leadId,
  projectId,
  kind: "implementation",
  title: "Feature",
  scope: {
    description: "Build feature",
    completionCondition: "Merged and verified",
    requiresPullRequest: true,
  },
  modelSelection: model,
  modelPolicy: { approvedModels: [model], preferences: [] },
  complexity: "standard",
  preparation: "ready",
  status: "running",
  threadStatus: "created",
  launchStatus: "delivered",
  qualification: { status: "qualified", profileId: "profile", checkedAt: now },
  workflow,
  grantedPolicy: initialFactorySnapshot().defaults,
  grant: {
    boundaryId: FactoryBoundaryId.make("boundary"),
    epoch: 0,
    sourcePaths: ["src/app.ts"],
    creatableDirectories: [],
    controlChange: null,
  },
  wait: null,
  report: null,
  createdAt: now,
  updatedAt: now,
};
const initial = (item: FactoryAssignment): FactorySnapshot => ({
  ...initialFactorySnapshot(),
  assignments: [item],
  managers: [
    {
      id: managerId,
      threadId: managerId,
      projectId,
      role: "project",
      name: "Manager",
      modelSelection: model,
      workflow,
      overrides: {},
      status: "active",
      threadStatus: "created",
      launchStatus: "delivered",
      wait: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
});
const runtime = Layer.mergeAll(FactoryStore.layer, ThreadManagement.layer).pipe(
  Layer.provideMerge(SatelliteLayer),
);
const layer = FactoryReconciliation.layer.pipe(Layer.provide(FactoryControlAccess.layer));
const scenario = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  item = assignment,
  transform: (state: FactorySnapshot) => FactorySnapshot = (state) => state,
) =>
  Effect.gen(function* () {
    yield* recordProject({ projectId, title: "Reconciliation", workspaceRoot: "/project" });
    const threads = yield* ThreadManagement.ThreadManagementService;
    for (const threadId of [managerId, leadId])
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId,
        title: threadId,
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    const sql = yield* SqlClient.SqlClient;
    const encoded = yield* encodeSnapshot(transform(initial(item)));
    yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,0,${encoded})`;
    return yield* body.pipe(Effect.provide(layer));
  }).pipe(Effect.provide(runtime), Effect.scoped);

const reconcile = (name: string, trigger = name) =>
  Effect.gen(function* () {
    const store = yield* FactoryStore.FactoryStore;
    yield* store.commit({
      actor: { kind: "system" },
      now,
      command: {
        type: "assignment.reconcile.requested",
        commandId: CommandId.make(name),
        assignmentId,
        triggerId: trigger,
      },
    });
    const service = yield* FactoryReconciliation.FactoryReconciliation;
    for (const pending of yield* store.pending)
      if (pending.intent.type === "assignment.reconcile") yield* service.handle(pending);
    return yield* store.snapshot;
  });
const send = (threadId = leadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Implement feature",
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    });
    return (yield* threads.getThreadProjection(threadId)).runs.at(-1)!;
  });
const link = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.pull-request.link",
    commandId: CommandId.make("link"),
    threadId: leadId,
    host: "github.com",
    repository: prRef.repository,
    number: prRef.number,
    url: "https://github.com/owner/repo/pull/42",
    source: "agent",
  });
});
const detail: PullRequestDetail = {
  provider: "github",
  projectId,
  projectTitle: "Project",
  workspaceRoot: "/project",
  repository: prRef.repository,
  number: 42,
  title: "Feature",
  body: "Feature",
  url: "https://github.com/owner/repo/pull/42",
  author: null,
  state: "merged",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  headSha: "actual-head",
  createdAt: now,
  updatedAt: now,
  mergedAt: now,
  closedAt: now,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: true, listCandidates: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: true,
  },
};
const claimAssignment: FactoryAssignment = {
  ...assignment,
  oversight: {
    deliveryClaim: { kind: "pull-request", ref: prRef },
    recovery: { cyclesUsed: 0, history: [] },
  },
};

it.effect(
  "accepted team work suppresses recovery and terminal replay never completes an assignment",
  () =>
    scenario(
      Effect.gen(function* () {
        const run = yield* send();
        assert.equal(
          (yield* reconcile("active")).assignments[0]!.oversight?.recovery.incident,
          undefined,
        );
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            {
              id: EventId.make("run-completed"),
              type: "run.updated",
              threadId: leadId,
              occurredAt: DateTime.makeUnsafe(now),
              payload: { ...run, status: "completed", completedAt: DateTime.makeUnsafe(now) },
            },
          ],
        });
        const store = yield* FactoryStore.FactoryStore;
        for (const sequence of [100, 101])
          yield* store.observe({
            sequence,
            now,
            command: {
              type: "assignment.run.observed",
              commandId: CommandId.make(`observed:${sequence}`),
              assignmentId,
              threadId: leadId,
              runId: run.id,
              attemptId: run.activeAttemptId,
              status: "completed",
            },
          });
        const state = yield* reconcile(
          "after-run",
          `run:${run.id}:${run.activeAttemptId ?? "none"}`,
        );
        assert.equal(state.assignments[0]!.status, "waiting");
        assert.equal(state.assignments[0]!.oversight?.recovery.cyclesUsed, 0);
        assert.equal(
          (yield* store.pending).filter((entry) => entry.intent.type === "thread.deliver").length,
          1,
        );
        yield* Effect.gen(function* () {
          const reopened = yield* FactoryStore.FactoryStore;
          assert.equal(yield* reopened.observationCursor, 101);
          yield* reconcile("restart-alias", "different-startup-id");
          assert.equal(
            (yield* reopened.pending).filter((entry) => entry.intent.type === "thread.deliver")
              .length,
            1,
          );
          assert.equal((yield* reopened.snapshot).assignments[0]!.status, "waiting");
        }).pipe(Effect.provide(layer), Effect.provide(Layer.fresh(FactoryStore.layer)));
      }),
    ),
);

it.effect("active delegated children suppress recovery after their lead stops", () =>
  scenario(
    Effect.gen(function* () {
      const run = yield* send();
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* threads.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("child"),
        parentThreadId: leadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Inspect feature",
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("lead-ended"),
            type: "run.updated",
            threadId: leadId,
            occurredAt: DateTime.makeUnsafe(now),
            payload: { ...run, status: "completed", completedAt: DateTime.makeUnsafe(now) },
          },
        ],
      });
      assert.equal(
        (yield* reconcile("child-active")).assignments[0]!.oversight?.recovery.incident,
        undefined,
      );
    }),
  ),
);

it.effect("explicit human waits do not consume recovery or notify a manager", () =>
  scenario(
    Effect.gen(function* () {
      const state = yield* reconcile("expected-wait");
      assert.equal(state.assignments[0]!.wait?.kind, "human-decision");
      assert.equal(state.assignments[0]!.oversight?.recovery.incident, undefined);
      assert.equal((yield* (yield* FactoryStore.FactoryStore).pending).length, 0);
    }),
    {
      ...assignment,
      status: "waiting",
      wait: { kind: "human-decision", reason: "Choose behavior" },
    },
  ),
);

it.effect.each(["open", "wrong-identity", "missing-head", "merged"] as const)(
  "confirms PR delivery only with linked identity and remote merge revision: %s",
  (remote) => {
    const response =
      remote === "open"
        ? { ...detail, state: "open" as const, mergedAt: null }
        : remote === "wrong-identity"
          ? { ...detail, number: 43 }
          : remote === "missing-head"
            ? { ...detail, headSha: undefined }
            : detail;
    return scenario(
      Effect.gen(function* () {
        yield* link;
        const state = yield* reconcile(`pr-${remote}`);
        const current = state.assignments[0]!;
        assert.equal(
          current.oversight?.delivery?.kind,
          remote === "merged" ? "pull-request-merged" : undefined,
        );
        assert.notEqual(current.status, "complete");
        if (remote === "merged") {
          assert.equal(current.wait?.kind, "delivered");
          assert.equal(state.dependencies[0]!.state, "commissioned");
          assert.equal(state.dependencies[1]!.state, "checking");
          assert.equal(
            (yield* (yield* FactoryStore.FactoryStore).pending).filter(
              (entry) => entry.intent.type === "thread.deliver",
            ).length,
            1,
          );
        }
      }),
      claimAssignment,
      (state) => ({
        ...state,
        dependencies: ["wrong-head", "actual-head"].map((head, index) => ({
          id: FactoryDependencyId.make(`dependency-${index}`),
          assignmentId,
          description: "Need merged support",
          requestedBy: leadId,
          evidence: [],
          state: "commissioned",
          supportingAssignmentId: assignmentId,
          authorization: {
            commandId: CommandId.make(`approve-${index}`),
            managerId,
            work: {
              title: "Support",
              scope: assignment.scope!,
              kind: "implementation",
              complexity: "standard",
              sourcePaths: [],
              creatableDirectories: [],
            },
          },
          createdAt: now,
          updatedAt: now,
          unblockCondition: {
            kind: "pull-request-merged",
            projectId,
            ref: prRef,
            expectedHeadSha: head,
          },
        })),
      }),
    ).pipe(
      Effect.provide(Layer.mock(PullRequestService)({ detail: () => Effect.succeed(response) })),
    );
  },
);

it.effect("rejects an unlinked delivery before calling the provider", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    yield* scenario(
      Effect.gen(function* () {
        const state = yield* reconcile("unlinked");
        assert.equal(state.assignments[0]!.oversight?.delivery, undefined);
        assert.equal(state.assignments[0]!.oversight?.recovery.incident?.phase, "escalated");
        assert.equal(yield* Ref.get(reads), 0);
      }),
      claimAssignment,
    ).pipe(
      Effect.provide(
        Layer.mock(PullRequestService)({
          detail: () => Ref.update(reads, (count) => count + 1).pipe(Effect.as(detail)),
        }),
      ),
    );
  }),
);

it.effect(
  "retains stopped-team reconciliation while its manager is paused and catches up on resume",
  () =>
    scenario(
      Effect.gen(function* () {
        const store = yield* FactoryStore.FactoryStore;
        yield* store.commit({
          actor: { kind: "human" },
          now,
          command: { type: "manager.pause", commandId: CommandId.make("pause-manager"), managerId },
        });
        const paused = yield* reconcile("stopped-while-paused");
        assert.equal(paused.assignments[0]!.oversight?.recovery.incident, undefined);
        const check = (yield* store.pending).find(
          (entry) => entry.intent.type === "assignment.reconcile",
        )!;
        assert.isDefined(check);
        const control = paused.controls[0]!;
        assert.notEqual(control.kind, "takeover");
        if (control.kind === "takeover") return;
        const stop = (yield* store.pending).find((entry) => entry.intent.type === "control.stop")!;
        yield* store.finishEffect({
          id: stop.id,
          now,
          command: {
            type: "control.stop.recorded",
            commandId: CommandId.make("stopped"),
            controlId: control.id,
            generation: control.generation,
          },
        });
        yield* store.commit({
          actor: { kind: "human" },
          now,
          command: {
            type: "manager.resume",
            commandId: CommandId.make("resume-manager"),
            managerId,
          },
        });
        const resume = (yield* store.pending).find(
          (entry) => entry.intent.type === "control.resume",
        )!;
        yield* store.finishEffect({
          id: resume.id,
          now,
          command: {
            type: "control.resume.recorded",
            commandId: CommandId.make("resumed"),
            controlId: control.id,
            generation: control.generation,
          },
        });
        yield* (yield* FactoryReconciliation.FactoryReconciliation).handle(check);
        const state = yield* store.snapshot;
        assert.equal(state.assignments[0]!.oversight?.recovery.incident?.phase, "reconciling");
        assert.equal(state.assignments[0]!.oversight?.recovery.cyclesUsed, 0);
        assert.equal(
          (yield* store.pending).filter((entry) => entry.intent.type === "assignment.reconcile")
            .length,
          0,
        );
      }),
    ),
);

it.effect("a real report must reach its agreed recipient with team provenance and evidence", () =>
  scenario(
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* FactoryStore.FactoryStore;
      yield* store.commit({
        actor: { kind: "thread", threadId: leadId },
        now,
        command: {
          type: "assignment.progress",
          commandId: CommandId.make("report-progress"),
          assignmentId,
          summary: "Investigation complete",
          remainingWork: "",
          evidence: [{ label: "Findings", location: "docs/findings.md" }],
        },
      });
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make("deliver-report"),
        threadId: managerId,
        messageId: MessageId.make("report-message"),
        senderThreadId: leadId,
        text: "Findings: the cause is the shared adapter. Recommendation: open a separate improvement task.",
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* store.commit({
        actor: { kind: "thread", threadId: leadId },
        now,
        command: {
          type: "assignment.delivery.request",
          commandId: CommandId.make("claim-report"),
          assignmentId,
          claim: {
            kind: "report",
            recipientThreadId: managerId,
            messageId: MessageId.make("report-message"),
          },
        },
      });
      const state = yield* reconcile("report-check");
      assert.equal(state.assignments[0]!.oversight?.delivery?.kind, "report-delivered");
      assert.equal(state.assignments[0]!.wait?.kind, "delivered");
    }),
    {
      ...assignment,
      scope: {
        description: "Investigate",
        completionCondition: "Deliver findings and recommendation to manager",
        requiresPullRequest: false,
      },
    },
  ),
);
