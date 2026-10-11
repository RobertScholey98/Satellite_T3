import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactorySnapshot,
  IssueOperationError,
  MessageId,
  type FactoryCommand,
  type FactoryScheduleCandidate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as IssueScheduling from "../issues/IssueScheduling.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactorySchedulingEffects from "./FactorySchedulingEffects.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { factoryScheduleCandidateId, factoryScheduleIssueKey } from "./FactoryScheduling.ts";
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
const candidate = (number: number): FactoryScheduleCandidate => {
  const issue = {
    hostKind: "github" as const,
    host: "github.com",
    repository: "owner/repo",
    id: `I${number}`,
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
  };
  const key = factoryScheduleIssueKey(issue);
  return {
    id: factoryScheduleCandidateId(key, 0),
    canonicalIssueKey: key,
    generation: 0,
    projectId: deliveryIds.project,
    managerId: deliveryIds.manager,
    issue,
    configurationId: "configuration",
    source: { kind: "tracker-ready" },
    observation: {
      title: `Ticket ${number}`,
      boardRevision: 1,
      itemId: `item${number}`,
      columnId: "ready",
      ready: true,
      detailDigest: "detail",
      observedAt: deliveryNow,
    },
    lifecycle: {
      phase: "prepared",
      preparation: {
        work: {
          title: `Ticket ${number}`,
          kind: "implementation",
          complexity: "standard",
          scope: {
            description: "Implement feature",
            completionCondition: "PR merged",
            requiresPullRequest: true,
          },
          sourcePaths: ["src/feature.ts"],
          creatableDirectories: [],
        },
        detailDigest: "detail",
        priority: 50,
        dependencyIds: [],
        recommendation: "Ready to implement",
      },
    },
    notificationDigest: null,
    notifiedDigest: null,
    createdAt: deliveryNow,
    updatedAt: deliveryNow,
  };
};
const fixture = Effect.fn(function* (count = 2) {
  const store = yield* FactoryStore.FactoryStore;
  const threads = yield* Threads.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* Satellite.recordProject({
    projectId: deliveryIds.project,
    title: "Scheduling",
    workspaceRoot: root,
  });
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("manager:create"),
    threadId: deliveryIds.manager,
    projectId: deliveryIds.project,
    title: "Manager",
    modelSelection: deliverySelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "main",
    worktreePath: root,
    createdBy: "user",
    creationSource: "web",
  });
  const seed: FactorySnapshot = {
    ...deliveryFixture(),
    assignments: [],
    scheduleCandidates: Array.from({ length: count }, (_, index) => candidate(index + 1)),
    schedulingConfigurations: [
      {
        id: "configuration",
        projectId: deliveryIds.project,
        boardId: "board",
        enabled: true,
        maxConcurrentAssignments: 1,
        improvementRule: null,
        approvedBy: CommandId.make("configuration"),
        approvedAt: deliveryNow,
      },
    ],
  };
  yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,${seed.revision},${encode(seed)})`;
  let loseAcknowledgement = false;
  let observeFailure = false;
  let qualifyCount = 0;
  const released: string[] = [];
  const labels = new Map<string, readonly string[]>();
  const dependencies = Layer.mergeAll(
    FactoryControlAccess.layer,
    Layer.succeed(Threads.ThreadManagementService, {
      ...threads,
      sendToThread: (input) =>
        threads.sendToThread(input).pipe(
          Effect.flatMap((result) => {
            if (!loseAcknowledgement) return Effect.succeed(result);
            loseAcknowledgement = false;
            return Effect.fail(
              new Threads.ThreadManagementProjectionLoadError({
                projectId: input.projectId,
                threadId: input.threadId,
                cause: "Lost acknowledgement",
              }),
            );
          }),
        ),
    }),
    Layer.mock(IssueService.IssueService)({}),
    Layer.mock(IssueScheduling.IssueScheduling)({
      read: ({ candidate }) =>
        Effect.succeed({
          detail: {
            ref: candidate.issue,
            title: "Current ticket",
            body: "Current scope",
            state: "open",
            labels: [],
            updatedAt: deliveryNow,
            comments: [],
          },
          detailDigest: "current-detail",
        }),
      qualify: () =>
        Effect.sync(() => {
          qualifyCount++;
        }),
      observe: () =>
        Effect.gen(function* () {
          if (observeFailure)
            return yield* new IssueOperationError({
              reason: "remote",
              message: "Tracker unavailable",
            });
          return {
            board: {
              id: "board",
              projectId: deliveryIds.project,
              title: "Board",
              locator: {
                kind: "github-project" as const,
                host: "github.com",
                owner: "owner",
                ownerKind: "user" as const,
                projectNumber: 1,
                projectNodeId: "P1",
                statusFieldId: "status",
              },
              mapping: {
                ready: ["ready"],
                inProgress: "progress",
                inPullRequest: "review",
                completed: "done",
                moveOnMerge: true,
              },
            },
            revision: 1,
            items: seed.scheduleCandidates.map((entry) => ({
              issue: entry.issue,
              labels: labels.get(entry.id) ?? [],
              observation: entry.observation,
            })),
          };
        }),
      admit: ({ candidate, configuration, workDigest, authorize }) =>
        authorize.pipe(
          Effect.map((authority) => ({
            candidateId: candidate.id,
            configurationId: configuration.id,
            canonicalIssueKey: candidate.canonicalIssueKey,
            workDigest,
            detailDigest: candidate.observation.detailDigest,
            boardId: configuration.boardId,
            boardFence: "fence",
            authority,
            issueAttempt: {
              attemptId: "attempt",
              reservationId: "reservation",
              sourceEnvironmentId: EnvironmentId.make("environment"),
              destinationEnvironmentId: EnvironmentId.make("environment"),
              sourceProjectId: candidate.projectId,
              boardId: configuration.boardId,
              issue: candidate.issue,
              sourceGeneration: 0,
            },
          })),
        ),
      release: ({ candidateId, authorizeUnstarted }) =>
        Effect.gen(function* () {
          if (authorizeUnstarted) yield* authorizeUnstarted;
          released.push(candidateId);
        }),
    }),
  );
  const effects = yield* FactorySchedulingEffects.FactorySchedulingEffects.pipe(
    Effect.provide(FactorySchedulingEffects.layer.pipe(Layer.provide(dependencies))),
  );
  const write = (state: FactorySnapshot) =>
    sql`UPDATE factory_state SET revision=${state.revision},payload_json=${encode(state)} WHERE id=1`;
  const notify = Effect.gen(function* () {
    for (const pending of yield* store.pending)
      if (pending.intent.type === "schedule.notify") yield* effects.handle(pending);
  });
  const messages = threads
    .getThreadRecords(deliveryIds.manager, ["messages"])
    .pipe(Effect.map((records) => records.messages));
  let refreshSequence = 0;
  const refresh = Effect.gen(function* () {
    const id = `refresh-${++refreshSequence}`;
    const configuration = (yield* store.snapshot).schedulingConfigurations.at(-1)!;
    yield* store.commit({
      actor: { kind: "human" },
      now: deliveryNow,
      schedulingBoardVerified: { projectId: deliveryIds.project, boardId: "board" },
      command: {
        type: "project.scheduling.configure",
        commandId: CommandId.make(id),
        projectId: deliveryIds.project,
        boardId: "board",
        enabled: configuration.enabled,
        maxConcurrentAssignments: configuration.maxConcurrentAssignments,
        improvementRule: null,
      },
    });
    const pending = (yield* store.pending).find((entry) => entry.id === `${id}:0`)!;
    yield* effects.handle(pending);
  });
  return {
    store,
    threads,
    effects,
    seed,
    write,
    notify,
    messages,
    released,
    refresh,
    getQualifyCount: () => qualifyCount,
    labels,
    loseAcknowledgement: () => {
      loseAcknowledgement = true;
    },
    failObservation: (failed: boolean) => {
      observeFailure = failed;
    },
  };
});

describe("FactorySchedulingEffects", () => {
  it.effect("fresh ticket reads invalidate a previously prepared scope immediately", () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      const read = yield* f.effects.read(f.seed.scheduleCandidates[0]!.id);
      assert.equal(read.detailDigest, "current-detail");
      yield* f.effects.reconcile;
      const state = yield* f.store.snapshot;
      const current = state.scheduleCandidates[0]!;
      assert.equal(current.observation.detailDigest, "current-detail");
      assert.equal(current.lifecycle.phase, "held");
      assert.include(JSON.stringify(current.lifecycle), "ticket changed");
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect(
    "discards an obsolete queued update when the ticket returns to its already delivered state",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(1);
        yield* f.effects.reconcile;
        yield* f.notify;
        const original = yield* f.store.snapshot;
        const first = original.scheduleCandidates[0]!;
        yield* f.write({
          ...original,
          revision: original.revision + 1,
          scheduleCandidates: [
            { ...first, observation: { ...first.observation, title: "Transient" } },
          ],
        });
        yield* f.effects.reconcile;
        const transient = yield* f.store.snapshot;
        yield* f.write({
          ...transient,
          revision: transient.revision + 1,
          scheduleCandidates: [
            { ...transient.scheduleCandidates[0]!, observation: first.observation },
          ],
        });
        yield* f.effects.reconcile;
        yield* f.notify;
        assert.equal((yield* f.messages).length, 1);
        assert.equal(
          (yield* f.store.pending).filter((entry) => entry.intent.type === "schedule.notify")
            .length,
          0,
        );
      }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect(
    "batches material changes, survives a lost acknowledgement and notifies again for A-B-A",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.effects.reconcile;
        assert.equal(
          (yield* f.store.pending).filter((entry) => entry.intent.type === "schedule.notify")
            .length,
          1,
        );
        f.loseAcknowledgement();
        yield* f.notify;
        let messages = yield* f.messages;
        assert.equal(messages.length, 1);
        assert.include(messages[0]!.text, "Ticket 1");
        assert.include(messages[0]!.text, "Ticket 2");
        yield* f.effects.reconcile;
        yield* f.notify;
        assert.equal((yield* f.messages).length, 1);
        for (const title of ["Changed", "Ticket 1"]) {
          const state = yield* f.store.snapshot;
          yield* f.write({
            ...state,
            revision: state.revision + 1,
            scheduleCandidates: state.scheduleCandidates.map((entry, index) =>
              index ? entry : { ...entry, observation: { ...entry.observation, title } },
            ),
          });
          yield* f.effects.reconcile;
          yield* f.notify;
        }
        assert.equal((yield* f.messages).length, 3);
      }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("caps notification groups at twenty tickets", () =>
    Effect.gen(function* () {
      const f = yield* fixture(21);
      yield* f.effects.reconcile;
      const notifications = (yield* f.store.pending).flatMap((entry) =>
        entry.intent.type === "schedule.notify" ? [entry.intent.notifications.length] : [],
      );
      assert.deepStrictEqual(notifications, [20, 1]);
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect(
    "clears a capacity hold when work completes without clearing tracker failure evidence",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(1);
        yield* f.write({ ...f.seed, assignments: deliveryFixture().assignments });
        yield* f.effects.reconcile;
        let state = yield* f.store.snapshot;
        assert.equal(state.scheduleCandidates[0]!.lifecycle.phase, "held");
        yield* f.write({ ...state, revision: state.revision + 1, assignments: [] });
        yield* f.effects.reconcile;
        assert.equal((yield* f.store.snapshot).scheduleCandidates[0]!.lifecycle.phase, "prepared");
        f.failObservation(true);
        yield* f.refresh;
        yield* f.effects.reconcile;
        state = yield* f.store.snapshot;
        assert.equal(state.scheduleCandidates[0]!.lifecycle.phase, "held");
        assert.include(
          JSON.stringify(state.scheduleCandidates[0]!.lifecycle),
          "Tracker unavailable",
        );
        f.failObservation(false);
        yield* f.refresh;
        yield* f.effects.reconcile;
        assert.equal((yield* f.store.snapshot).scheduleCandidates[0]!.lifecycle.phase, "prepared");
      }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("disables scheduling while disconnected and releases uncommissioned reservations", () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      const configuration = f.seed.schedulingConfigurations[0]!;
      const command: FactoryCommand = {
        type: "project.scheduling.configure",
        commandId: CommandId.make("disable"),
        projectId: deliveryIds.project,
        boardId: "board",
        enabled: false,
        maxConcurrentAssignments: 1,
        improvementRule: null,
      };
      yield* f.effects.context({ kind: "human" }, command);
      assert.equal(f.getQualifyCount(), 0);
      yield* f.write({
        ...f.seed,
        schedulingConfigurations: [{ ...configuration, enabled: false }],
      });
      yield* f.refresh;
      assert.deepStrictEqual(f.released, [f.seed.scheduleCandidates[0]!.id]);
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("refuses to release a reservation already owned by an assignment", () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      const selected = f.seed.scheduleCandidates[0]!;
      const assignment = deliveryFixture().assignments[0]!;
      yield* f.write({
        ...f.seed,
        assignments: [
          {
            ...assignment,
            scheduling: {
              candidateId: selected.id,
              authority: {
                kind: "tracker-ready",
                boardId: "board",
                itemId: selected.observation.itemId,
                observedAt: deliveryNow,
              },
              issueAttempt: {
                attemptId: "attempt",
                boardId: "board",
                sourceProjectId: deliveryIds.project,
                sourceEnvironmentId: EnvironmentId.make("environment"),
                destinationEnvironmentId: EnvironmentId.make("environment"),
                sourceGeneration: 1,
                reservationId: "reservation",
                issue: selected.issue,
              },
            },
          },
        ],
      });
      const result = yield* f.effects.release(selected.id).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.deepStrictEqual(f.released, []);
    }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect("keeps an agent-filed ticket out of Ready while it carries its triage labels", () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      const selected = f.seed.scheduleCandidates[0]!;
      const origin = deliveryFixture().assignments[0]!;
      yield* f.write({
        ...f.seed,
        projectTrackers: [
          {
            id: "tracker",
            projectId: deliveryIds.project,
            destination: {
              projectId: deliveryIds.project,
              environmentId: EnvironmentId.make("environment"),
              credentialNamespace: "github",
              destination: {
                kind: "github",
                host: "github.com",
                repository: "owner/repo",
                triage: { kind: "labels", labels: ["Triage"] },
              },
              board: null,
              validatedAt: deliveryNow,
            },
            approvedBy: CommandId.make("tracker"),
            approvedAt: deliveryNow,
          },
        ],
        followups: [
          {
            id: "followup",
            assignmentId: origin.id,
            projectId: deliveryIds.project,
            findingIds: ["finding"],
            draft: {
              title: "Fix formatting",
              problem: "Repeated formatting error",
              impact: "Review rework",
              proposedOutcome: "Consistent formatting",
              acceptanceCriteria: ["Checks enforce convention"],
              evidence: [],
              owner: "Manager",
              requiredAuthority: "Project rule",
              suspectedCause: "project",
              origin: { assignmentId: origin.id, findingIds: ["finding"] },
              containmentOf: null,
            },
            error: null,
            existingIssue: null,
            publication: { status: "linked", issue: selected.issue, verifiedAt: deliveryNow },
            createdAt: deliveryNow,
            updatedAt: deliveryNow,
          },
        ],
      });
      f.labels.set(selected.id, ["triage"]);
      yield* f.refresh;
      let current = (yield* f.store.snapshot).scheduleCandidates[0]!;
      assert.equal(current.source.kind, "project-improvement");
      assert.isFalse(current.observation.ready);
      f.labels.set(selected.id, []);
      yield* f.refresh;
      current = (yield* f.store.snapshot).scheduleCandidates[0]!;
      assert.isTrue(current.observation.ready);
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("reserves a ticket the manager commissions on a cited direct human request", () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      const selected = f.seed.scheduleCandidates[0]!;
      if (selected.lifecycle.phase !== "prepared") return assert.fail("Expected prepared work");
      yield* f.write({
        ...f.seed,
        scheduleCandidates: [
          { ...selected, observation: { ...selected.observation, ready: false, columnId: null } },
        ],
      });
      const messageId = MessageId.make("human-request");
      const command: FactoryCommand = {
        type: "assignment.commission",
        commandId: CommandId.make("commission"),
        managerId: deliveryIds.manager,
        candidateId: selected.id,
        authorizationMessageId: messageId,
        ...selected.lifecycle.preparation.work,
      };
      const actor = { kind: "thread", threadId: deliveryIds.manager } as const;
      assert.isTrue(Result.isFailure(yield* f.effects.context(actor, command).pipe(Effect.result)));
      yield* f.threads.sendToThread({
        projectId: deliveryIds.project,
        threadId: deliveryIds.manager,
        commandId: CommandId.make("request"),
        messageId,
        text: "Please take ticket 1 now.",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      const context = yield* f.effects.context(actor, command);
      assert.deepStrictEqual(context.schedulingAdmission?.authority, {
        kind: "human",
        commandId: CommandId.make("commission"),
        messageId,
      });
    }).pipe(Effect.provide(base), Effect.scoped),
  );
});
