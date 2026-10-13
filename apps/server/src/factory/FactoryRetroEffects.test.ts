import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryControlId,
  FactoryEffectIntent,
  FactorySnapshot,
  MessageId,
  type FactoryCommand,
  type PullRequestDetail,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as IssuePublication from "../issues/IssuePublication.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryHandover from "./FactoryHandover.ts";
import * as FactoryRetroEvidence from "./FactoryRetroEvidence.ts";
import * as FactoryRetroEffects from "./FactoryRetroEffects.ts";
import * as FactoryRetroExecution from "./FactoryRetroExecution.ts";
import { initialFactoryCompletion } from "./FactoryRetros.ts";
import { integrated } from "./FactoryIntegration.testkit.ts";
import { completedMergeOperationFixture } from "./FactoryMergeOperation.testkit.ts";
import * as FactoryStore from "./FactoryStore.ts";
import {
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const base = Layer.mergeAll(FactoryStore.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeServices.layer),
);
const noPr = (): FactorySnapshot => {
  const state = deliveryFixture();
  const scope = {
    description: "Research",
    requiresPullRequest: false,
    completionCondition: "Report received",
    noPrTarget: { kind: "report-received" as const, recipientThreadId: deliveryIds.manager },
  };
  return {
    ...state,
    assignments: state.assignments.map((assignment) => ({
      ...assignment,
      scope,
      completion: {
        ...initialFactoryCompletion(scope),
        deliveries: [
          {
            kind: "report-delivered",
            id: "report-proof",
            assignmentId: assignment.id,
            recipientThreadId: deliveryIds.manager,
            messageId: MessageId.make("report"),
            summary: "Research delivered",
            evidence: [],
            deliveredAt: deliveryNow,
          },
        ],
      },
    })),
  };
};

const prRef = {
  projectId: deliveryIds.project,
  host: "github.com",
  repository: "owner/repo",
  number: 1,
};
const mergedDetail: PullRequestDetail = {
  ...prRef,
  provider: "github",
  projectTitle: "Project",
  workspaceRoot: "/project",
  title: "Feature",
  body: "Feature",
  url: "https://github.com/owner/repo/pull/1",
  author: null,
  state: "merged",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  headSha: "head",
  createdAt: deliveryNow,
  updatedAt: deliveryNow,
  mergedAt: deliveryNow,
  closedAt: deliveryNow,
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
const prSeed = (): FactorySnapshot => {
  const state = deliveryFixture();
  return {
    ...state,
    assignments: state.assignments.map((assignment) => ({
      ...assignment,
      completion: {
        ...initialFactoryCompletion(assignment.scope),
        plan: {
          kind: "pull-requests",
          version: 1,
          sealed: true,
          requirements: [{ id: "one", ref: prRef, expectedHeadSha: "head" }],
        },
        deliveries: [
          {
            kind: "pull-request-merged",
            id: "merged",
            projectId: deliveryIds.project,
            ref: prRef,
            headSha: "head",
            mergedAt: deliveryNow,
            observedAt: deliveryNow,
          },
        ],
      },
    })),
  };
};

const fixture = Effect.fn(function* (seed = noPr()) {
  const store = yield* FactoryStore.FactoryStore;
  const threads = yield* Threads.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* Satellite.recordProject({
    projectId: deliveryIds.project,
    title: "Retro",
    workspaceRoot: root,
  });
  for (const threadId of [deliveryIds.manager, deliveryIds.lead])
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: deliveryIds.project,
      title: threadId,
      modelSelection: deliverySelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "main",
      worktreePath: root,
      createdBy: "user",
      creationSource: "web",
    });
  yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,${seed.revision},${encode(seed)})`;
  const stopped: string[] = [];
  const prepared: string[] = [];
  let stopAction: Effect.Effect<void> = Effect.void;
  let prepareAction: Effect.Effect<void> = Effect.void;
  let sealAction: Effect.Effect<void> = Effect.void;
  let lostSendAcknowledgement = false;
  let detail: PullRequestDetail | undefined;
  const evidence = yield* FactoryRetroEvidence.FactoryRetroEvidence.pipe(
    Effect.provide(
      FactoryRetroEvidence.layer.pipe(Layer.provide(ServerConfig.layerTest(root, root))),
    ),
  );
  const dependencies = Layer.mergeAll(
    FactoryControlAccess.layer,
    Layer.succeed(FactoryRetroEvidence.FactoryRetroEvidence, {
      ...evidence,
      seal: (request) => sealAction.pipe(Effect.andThen(evidence.seal(request))),
    }),
    Layer.succeed(Threads.ThreadManagementService, {
      ...threads,
      sendToThread: (input) =>
        threads.sendToThread(input).pipe(
          Effect.flatMap((value) => {
            if (!lostSendAcknowledgement) return Effect.succeed(value);
            lostSendAcknowledgement = false;
            return Effect.fail(
              new Threads.ThreadManagementProjectionLoadError({
                projectId: input.projectId,
                threadId: input.threadId,
                cause: "Lost fixture acknowledgement",
              }),
            );
          }),
        ),
    }),
    Layer.mock(FactoryHandover.FactoryHandover)({
      stopTeam: (input) =>
        Effect.gen(function* () {
          assert.equal((yield* store.snapshot).assignments[0]!.completion?.phase, "concluding");
          stopped.push(input.threadId);
          yield* stopAction;
        }),
    }),
    Layer.mock(FactoryExecution.FactoryExecution)({
      runtimePolicyFor: () =>
        Effect.succeed({
          boundaryId: "retro-profile",
          dockerContext: "test",
          imageId: "test",
          projectSnapshotPath: root,
          workflowSnapshotPath: root,
          runtimePath: root,
        }),
    }),
    Layer.mock(FactoryRetroExecution.FactoryRetroExecution)({
      prepare: (input) =>
        Effect.gen(function* () {
          prepared.push(input.retroId);
          yield* prepareAction;
          return {
            qualification: {
              status: "qualified" as const,
              profileId: "retro-profile",
              checkedAt: deliveryNow,
            },
            sourceDigest: "source",
          };
        }),
      stop: () => Effect.void,
    }),
    Layer.mock(IssuePublication.IssuePublication)({}),
    Layer.mock(PullRequestService.PullRequestService)({
      detail: () => (detail ? Effect.succeed(detail) : Effect.die("Unexpected external PR read")),
    }),
  );
  const layer = FactoryRetroEffects.layer.pipe(Layer.provide(dependencies));
  const pending = (type: string) =>
    store.pending.pipe(
      Effect.map((effects) => {
        const effect = effects.find((entry) => entry.intent.type === type);
        assert.isDefined(effect, `Missing ${type} intent`);
        return effect!;
      }),
    );
  return {
    store,
    threads,
    stopped,
    prepared,
    layer,
    pending,
    setStopAction: (action: Effect.Effect<void>) => {
      stopAction = action;
    },
    setPrepareAction: (action: Effect.Effect<void>) => {
      prepareAction = action;
    },
    setSealAction: (action: Effect.Effect<void>) => {
      sealAction = action;
    },
    setLostSendAcknowledgement: () => {
      lostSendAcknowledgement = true;
    },
    setDetail: (value: PullRequestDetail) => {
      detail = value;
    },
  };
});

it.effect(
  "freezes a received no-PR report before launching one retrospective and sends one manager invitation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
        yield* effects.reconcile;
        assert.equal((yield* f.store.snapshot).assignments[0]!.completion?.phase, "concluding");
        assert.deepStrictEqual(f.prepared, []);
        yield* effects.handle(yield* f.pending("assignment.conclude"));
        assert.deepStrictEqual(f.stopped, [deliveryIds.lead]);
        const concluded = yield* f.store.snapshot;
        assert.equal(concluded.assignments[0]!.completion?.conclusion?.kind, "no-pr-delivered");
        const launch = yield* f.pending("retro.launch");
        f.setLostSendAcknowledgement();
        yield* effects.handle(launch);
        yield* effects.handle(launch);
        assert.deepStrictEqual(f.prepared, [concluded.retros[0]!.id]);
        const retro = (yield* f.store.snapshot).retros[0]!;
        const records = yield* f.threads.getThreadRecords(retro.threadId, ["messages", "runs"]);
        assert.equal(
          records.messages.filter((message) => message.id === `${launch.id}:initial`).length,
          1,
        );
        assert.equal(records.runs.length, 1);
        const report: FactoryCommand = {
          type: "retro.team.submit",
          commandId: CommandId.make("team-report"),
          retroId: retro.id,
          conclusionId: retro.conclusionId,
          report: {
            outcome: "Research delivered",
            helped: "Clear scope",
            hindered: "",
            learning: { kind: "no-process-change", reason: "The workflow was sufficient" },
            contributions: [{ kind: "thread", threadId: deliveryIds.lead }],
          },
        };
        const actor = {
          kind: "thread" as const,
          threadId: retro.threadId,
          assignmentId: retro.assignmentId,
        };
        const context = yield* effects.context(actor, report);
        yield* f.store.commit({ actor, command: report, now: deliveryNow, ...context });
        const invitation = yield* f.pending("retro.manager-notify");
        f.setLostSendAcknowledgement();
        yield* effects.handle(invitation);
        yield* effects.handle(invitation);
        const managerMessages = (yield* f.threads.getThreadRecords(deliveryIds.manager, [
          "messages",
        ])).messages;
        assert.equal(managerMessages.length, 1);
        assert.include(managerMessages[0]!.text, "no-process-change");
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "holds cancellation without a reason and records a neutral retrospective after the human supplies it",
  () =>
    Effect.gen(function* () {
      const seed = noPr();
      const controlId = FactoryControlId.make("cancel");
      const f = yield* fixture({
        ...seed,
        assignments: seed.assignments.map((assignment) => ({
          ...assignment,
          outcome: { kind: "cancelled", controlId },
        })),
        controls: [
          {
            id: controlId,
            kind: "cancellation",
            assignmentId: deliveryIds.assignment,
            managerId: deliveryIds.manager,
            generation: 1,
            stop: { status: "confirmed", stoppedAt: deliveryNow },
            requestedAt: deliveryNow,
            updatedAt: deliveryNow,
          },
        ],
      });
      yield* Effect.gen(function* () {
        const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
        yield* effects.reconcile;
        assert.isEmpty(yield* f.store.pending);
        yield* f.store.commit({
          actor: { kind: "human" },
          now: deliveryNow,
          command: {
            type: "assignment.cancellation-reason",
            commandId: CommandId.make("reason"),
            assignmentId: deliveryIds.assignment,
            reason: "Priorities changed; no implementation failure.",
          },
        });
        yield* effects.reconcile;
        yield* effects.handle(yield* f.pending("assignment.conclude"));
        const state = yield* f.store.snapshot;
        assert.equal(state.assignments[0]!.completion?.conclusion?.kind, "cancelled");
        assert.isEmpty(state.findings);
        assert.isDefined(state.assignments[0]!.outcome);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "rejects a stale sealed conclusion and retries after a benign factory revision change",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setSealAction(
        f.store
          .commit({
            actor: { kind: "human" },
            now: deliveryNow,
            command: {
              type: "manager.pause",
              commandId: CommandId.make("pause-manager"),
              managerId: deliveryIds.manager,
            },
          })
          .pipe(Effect.asVoid, Effect.orDie),
      );
      yield* Effect.gen(function* () {
        const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
        yield* effects.reconcile;
        const intent = yield* f.pending("assignment.conclude");
        assert.equal((yield* effects.handle(intent).pipe(Effect.flip)).code, "stale-revision");
        assert.isEmpty((yield* f.store.snapshot).retros);
        f.setSealAction(Effect.void);
        yield* effects.handle(intent);
        assert.equal((yield* f.store.snapshot).retros.length, 1);
        yield* effects.handle(yield* f.pending("retro.launch"));
        assert.equal(f.prepared.length, 1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("does not seal or launch when the project pauses while the team is being stopped", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setStopAction(
      f.store
        .commit({
          actor: { kind: "human" },
          now: deliveryNow,
          command: {
            type: "project.pause",
            commandId: CommandId.make("pause-project"),
            projectId: deliveryIds.project,
          },
        })
        .pipe(Effect.asVoid, Effect.orDie),
    );
    yield* Effect.gen(function* () {
      const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
      yield* effects.reconcile;
      yield* effects.handle(yield* f.pending("assignment.conclude"));
      assert.isEmpty((yield* f.store.snapshot).retros);
      assert.isEmpty(f.prepared);
      assert.equal((yield* f.store.snapshot).assignments[0]!.completion?.phase, "concluding");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("discovers a linked PR after freezing and reopens the complete requirement set", () =>
  Effect.gen(function* () {
    const f = yield* fixture(prSeed());
    f.setDetail(mergedDetail);
    yield* Effect.gen(function* () {
      const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
      yield* effects.reconcile;
      yield* f.threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("late-link"),
        threadId: deliveryIds.lead,
        host: "github.com",
        repository: prRef.repository,
        number: 2,
        url: "https://github.com/owner/repo/pull/2",
        source: "agent",
      });
      yield* effects.handle(yield* f.pending("assignment.conclude"));
      const state = yield* f.store.snapshot;
      const completion = state.assignments[0]!.completion!;
      assert.equal(completion.phase, "collecting");
      assert.equal(completion.plan.kind, "pull-requests");
      if (completion.plan.kind !== "pull-requests") return assert.fail("Expected PR manifest");
      assert.isFalse(completion.plan.sealed);
      assert.deepStrictEqual(
        completion.plan.requirements.map((requirement) => requirement.ref.number),
        [1, 2],
      );
      assert.isEmpty(state.retros);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("rejects mismatched fresh host merge proof instead of trusting the prior receipt", () =>
  Effect.gen(function* () {
    const f = yield* fixture(prSeed());
    f.setDetail({ ...mergedDetail, headSha: "different-head" });
    yield* Effect.gen(function* () {
      const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
      yield* effects.reconcile;
      yield* effects.handle(yield* f.pending("assignment.conclude"));
      const state = yield* f.store.snapshot;
      assert.equal(state.assignments[0]!.completion?.phase, "collecting");
      assert.include(state.assignments[0]!.completion?.waitReason ?? "", "matching merge");
      assert.isEmpty(state.retros);
      assert.isEmpty(f.prepared);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("does not conclude when a new PR link appears while sealing the evidence", () =>
  Effect.gen(function* () {
    const f = yield* fixture(prSeed());
    f.setDetail(mergedDetail);
    f.setSealAction(
      f.threads
        .dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make("seal-race-link"),
          threadId: deliveryIds.lead,
          host: "github.com",
          repository: prRef.repository,
          number: 2,
          url: "https://github.com/owner/repo/pull/2",
          source: "agent",
        })
        .pipe(Effect.asVoid, Effect.orDie),
    );
    yield* Effect.gen(function* () {
      const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
      yield* effects.reconcile;
      const pending = yield* f.pending("assignment.conclude");
      const revision = (yield* f.store.snapshot).revision;
      const result = yield* effects.handle(pending).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "stale-revision");
      const state = yield* f.store.snapshot;
      assert.equal(state.revision, revision);
      assert.isEmpty(state.retros);
      assert.notEqual(state.assignments[0]!.completion?.phase, "concluded");
      assert.isTrue((yield* f.store.pending).some((entry) => entry.id === pending.id));
      assert.isFalse(
        (yield* f.store.pending).some((entry) => entry.intent.type === "retro.launch"),
      );
      f.setSealAction(Effect.void);
      yield* effects.handle(pending);
      const reopened = (yield* f.store.snapshot).assignments[0]!.completion!;
      assert.equal(reopened.phase, "collecting");
      if (reopened.plan.kind !== "pull-requests") return assert.fail("Expected PR manifest");
      assert.deepEqual(
        reopened.plan.requirements.map((entry) => entry.ref.number),
        [1, 2],
      );
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "holds a late project pause during retro preparation and resumes the same launch automatically",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
        yield* effects.reconcile;
        yield* effects.handle(yield* f.pending("assignment.conclude"));
        f.setPrepareAction(
          f.store
            .commit({
              actor: { kind: "human" },
              now: deliveryNow,
              command: {
                type: "project.pause",
                commandId: CommandId.make("pause-during-prepare"),
                projectId: deliveryIds.project,
              },
            })
            .pipe(Effect.asVoid, Effect.orDie),
        );
        const launch = yield* f.pending("retro.launch");
        yield* effects.handle(launch);
        const held = yield* f.store.snapshot;
        const retro = held.retros[0]!;
        assert.equal(retro.execution.status, "ready");
        if (retro.execution.status !== "ready")
          return assert.fail("Expected prepared profile to remain available");
        assert.equal(retro.execution.launch, "pending");
        assert.isNull(yield* f.threads.getThreadShell(retro.threadId));
        assert.equal((yield* f.pending("retro.launch")).id, launch.id);
        const pause = held.controls.find((control) => control.kind === "project-pause")!;
        yield* f.store.commit({
          actor: { kind: "system" },
          now: deliveryNow,
          command: {
            type: "control.stop.recorded",
            commandId: CommandId.make("pause-stop-confirmed"),
            controlId: pause.id,
            generation: pause.generation,
          },
        });
        yield* f.store.commit({
          actor: { kind: "human" },
          now: deliveryNow,
          command: {
            type: "project.resume",
            commandId: CommandId.make("resume-prepared-retro"),
            projectId: deliveryIds.project,
          },
        });
        yield* f.store.commit({
          actor: { kind: "system" },
          now: deliveryNow,
          command: {
            type: "control.resume.recorded",
            commandId: CommandId.make("resume-confirmed"),
            controlId: pause.id,
            generation: pause.generation,
          },
        });
        yield* effects.handle(launch);
        assert.deepStrictEqual(f.prepared, [retro.id]);
        const current = (yield* f.store.snapshot).retros[0]!;
        assert.equal(current.execution.status, "ready");
        if (current.execution.status !== "ready") return assert.fail("Expected resumed retro");
        assert.equal(current.execution.launch, "delivered");
        assert.equal(
          (yield* f.threads.getThreadRecords(retro.threadId, ["messages"])).messages.length,
          1,
        );
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "waits on a pending delivery effect without stopping the team or reading the PR host",
  () =>
    Effect.gen(function* () {
      // The PR host is deliberately unavailable: any read fails the test.
      const f = yield* fixture(prSeed());
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.gen(function* () {
        const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
        yield* effects.reconcile;
        const conclude = yield* f.pending("assignment.conclude");
        const intent = yield* Schema.encodeEffect(Schema.fromJsonString(FactoryEffectIntent))({
          type: "delivery.capture",
          assignmentId: deliveryIds.assignment,
          revisionId: "revision",
        });
        yield* sql`INSERT INTO factory_commands (command_id,request_json,result_json)
        VALUES('capture','{}','{"revision":0}')`;
        yield* sql`INSERT INTO factory_outbox (effect_id,command_id,payload_json,status,created_at)
        VALUES('capture:0','capture',${intent},'pending',${deliveryNow})`;
        yield* effects.handle(conclude);
        yield* effects.handle(conclude);
        assert.deepStrictEqual(f.stopped, []);
        assert.equal((yield* f.store.snapshot).assignments[0]!.completion?.phase, "concluding");
        assert.isTrue((yield* f.store.pending).some((entry) => entry.id === conclude.id));
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("tells no-PR work with a linked PR to unlink it instead of extending a manifest", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
      yield* effects.reconcile;
      yield* f.threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("no-pr-link"),
        threadId: deliveryIds.lead,
        host: "github.com",
        repository: prRef.repository,
        number: 2,
        url: "https://github.com/owner/repo/pull/2",
        source: "agent",
      });
      yield* effects.handle(yield* f.pending("assignment.conclude"));
      const completion = (yield* f.store.snapshot).assignments[0]!.completion!;
      assert.equal(completion.phase, "collecting");
      assert.equal(completion.plan.kind, "no-pr");
      assert.include(completion.waitReason ?? "", "Unlink");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "concludes an integration team from its completed shared merge and invites the requesting manager to its retro",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(completedMergeOperationFixture().state);
      yield* Effect.gen(function* () {
        const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
        yield* effects.reconcile;
        const conclude = (yield* f.store.pending).find(
          (entry) =>
            entry.intent.type === "assignment.conclude" &&
            entry.intent.assignmentId === integrated.assignment,
        );
        assert.isDefined(conclude);
        yield* effects.handle(conclude!);
        const concluded = yield* f.store.snapshot;
        const lead = concluded.assignments.find((entry) => entry.id === integrated.assignment)!;
        assert.equal(lead.completion?.conclusion?.kind, "shared-group-delivered");
        const retro = concluded.retros.find((entry) => entry.assignmentId === lead.id)!;
        const launch = (yield* f.store.pending).find(
          (entry) => entry.intent.type === "retro.launch" && entry.intent.retroId === retro.id,
        );
        assert.isDefined(launch);
        yield* effects.handle(launch!);
        assert.deepStrictEqual(f.prepared, [retro.id]);
        const actor = { kind: "thread" as const, threadId: retro.threadId, assignmentId: lead.id };
        const report: FactoryCommand = {
          type: "retro.team.submit",
          commandId: CommandId.make("integration-team-report"),
          retroId: retro.id,
          conclusionId: retro.conclusionId,
          report: {
            outcome: "Both linked PRs merged after combined verification",
            helped: "One shared review point",
            hindered: "",
            learning: { kind: "no-process-change", reason: "The shared merge recovered cleanly" },
            contributions: [{ kind: "thread", threadId: retro.threadId }],
          },
        };
        const context = yield* effects.context(actor, report);
        yield* f.store.commit({ actor, command: report, now: deliveryNow, ...context });
        yield* effects.handle(yield* f.pending("retro.manager-notify"));
        const invitations = (yield* f.threads.getThreadRecords(lead.managerId, ["messages"]))
          .messages;
        assert.equal(invitations.length, 1);
        assert.include(invitations[0]!.text, retro.id);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);
