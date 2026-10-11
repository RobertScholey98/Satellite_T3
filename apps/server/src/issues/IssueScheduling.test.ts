import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  IssueOperationError,
  FactorySnapshot,
  FactoryAssignmentId,
  type FactorySupportingWork,
  type FactoryScheduleCandidate,
  type FactorySchedulingConfiguration,
  type IssueRef,
  type IssueBoardLocator,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import migration from "../persistence/Migrations/056_IssueBoards.ts";
import snapshotMigration from "../persistence/Migrations/059_IssueBoardSnapshots.ts";
import schedulingMigration from "../persistence/Migrations/071_IssueScheduling.ts";
import factoryMigration from "../persistence/Migrations/067_EngineeringFactory.ts";
import * as FactoryStore from "../factory/FactoryStore.ts";
import { deliveryFixture, deliveryIds } from "../factory/FactoryDelivery.testkit.ts";
import { factoryScheduleWorkDigest } from "../factory/FactoryScheduling.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ProjectRow, ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import * as IssueHost from "./IssueHost.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueScheduling from "./IssueScheduling.ts";

const projectId = ProjectId.make("scheduling-project");
const environmentId = EnvironmentId.make("scheduling-environment");
const issue: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "42",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
};
const locator: IssueBoardLocator = {
  kind: "github-project",
  host: "github.com",
  owner: "owner",
  ownerKind: "user",
  projectNumber: 1,
  projectNodeId: "P1",
  statusFieldId: "F1",
};
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  repositoryIdentity: {
    canonicalKey: "github.com/owner/repo",
    provider: "github",
    displayName: "owner/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/owner/repo.git",
    },
  },
  scripts: [],
  createdAt: "2026-10-10T00:00:00Z",
  updatedAt: "2026-10-10T00:00:00Z",
};
const row = ProjectRow.make({
  projectId,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  deletedAt: null,
});
const fixture = (initialize = true) =>
  Effect.gen(function* () {
    if (initialize) {
      yield* migration;
      yield* snapshotMigration;
      yield* schedulingMigration;
    }
    const state = {
      column: "ready",
      body: "Implement this exact behavior",
      title: "Ticket",
      reads: 0,
      boardReads: 0,
      updatedAt: "v1",
      failed: false,
      beforeAuthorize: Effect.void as Effect.Effect<void, IssueOperationError>,
      beforeRead: Effect.void as Effect.Effect<void, IssueOperationError>,
    };
    const host = IssueHost.IssueHost.of({
      list: () => Effect.succeed({ issues: [], nextCursor: null }),
      listBoards: () => Effect.succeed([{ title: "Board", locator }]),
      get: () =>
        Effect.gen(function* () {
          yield* state.beforeRead;
          state.reads++;
          return {
            ref: issue,
            title: state.title,
            body: state.body,
            state: "open",
            labels: [],
            updatedAt: state.updatedAt,
          };
        }),
      board: () =>
        Effect.gen(function* () {
          state.boardReads++;
          if (state.failed)
            return yield* new IssueOperationError({ reason: "remote", message: "Unavailable" });
          return {
            title: "Board",
            locator,
            columns: ["triage", "ready", "progress", "pr", "done"].map((id) => ({ id, title: id })),
            items: [
              {
                issue: {
                  ref: issue,
                  title: state.title,
                  state: "open",
                  labels: [],
                  updatedAt: state.updatedAt,
                },
                itemId: "I1",
                columnId: state.column,
                version: "1",
              },
            ],
          };
        }),
      move: () => Effect.die("Scheduling must not move a ticket"),
    });
    const options = { host, environmentId, getProject: () => Effect.succeed(project) };
    const issues = yield* IssueService.makeIssueService(options);
    const view = yield* issues.configureBoard({
      requestId: "configure",
      projectId,
      locator,
      mapping: {
        ready: "ready",
        inProgress: "progress",
        inPullRequest: "pr",
        completed: "done",
        moveOnMerge: true,
      },
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(IssueService.IssueService, issues),
      Layer.succeed(IssueHost.IssueHost, host),
      Layer.mock(ProjectStoreV2, { get: () => Effect.succeed(Option.some(row)) }),
      Layer.succeed(RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(project.repositoryIdentity ?? null),
      }),
      Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    );
    const restart = IssueScheduling.IssueScheduling.pipe(
      Effect.provide(IssueScheduling.layer.pipe(Layer.provide(dependencies))),
    );
    const service = yield* restart;
    const observed = yield* service.observe({ projectId, boardId: view.board.id });
    const configuration: FactorySchedulingConfiguration = {
      id: "config",
      projectId,
      boardId: view.board.id,
      enabled: true,
      maxConcurrentAssignments: 1,
      improvementRule: null,
      approvedBy: CommandId.make("configure"),
      approvedAt: project.createdAt,
    };
    const candidate: FactoryScheduleCandidate = {
      id: "candidate",
      projectId,
      managerId: ThreadId.make("manager"),
      issue,
      canonicalIssueKey: IssueHost.canonicalIssueKey(issue),
      generation: 0,
      configurationId: configuration.id,
      source: { kind: "tracker-ready" },
      observation: observed.items[0]!.observation,
      lifecycle: { phase: "observed" },
      notificationDigest: null,
      notifiedDigest: null,
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    };
    const authorize = Effect.gen(function* () {
      yield* state.beforeAuthorize;
      return {
        kind: "tracker-ready" as const,
        boardId: view.board.id,
        itemId: "I1",
        observedAt: project.createdAt,
      };
    });
    const admission = { candidate, configuration, workDigest: "work", authorize };
    const manual = (requestId: string) =>
      issues.reserveAttempt({
        requestId,
        boardId: view.board.id,
        issue,
        sourceEnvironmentId: environmentId,
        destinationEnvironmentId: environmentId,
      });
    return { state, service, restart, issues, configuration, candidate, admission, manual };
  });
const setup = fixture();
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const encodeFactorySnapshot = Schema.encodeEffect(Schema.fromJsonString(FactorySnapshot));
const factoryFixture = Effect.gen(function* () {
  const test = yield* setup;
  yield* factoryMigration;
  const sql = yield* SqlClient.SqlClient;
  const base = deliveryFixture();
  const work: FactorySupportingWork = {
    title: "Implement ticket",
    kind: "implementation",
    complexity: "standard",
    scope: {
      description: "Exact ticket scope",
      completionCondition: "PR merged",
      requiresPullRequest: true,
    },
    sourcePaths: ["src/feature.ts"],
    creatableDirectories: [],
  };
  const candidate: FactoryScheduleCandidate = {
    ...test.candidate,
    lifecycle: {
      phase: "prepared",
      preparation: {
        work,
        detailDigest: test.candidate.observation.detailDigest,
        priority: 50,
        dependencyIds: [],
        recommendation: "Implement the prepared work",
      },
    },
  };
  const seed: FactorySnapshot = {
    ...base,
    assignments: [],
    managers: base.managers.flatMap((manager) =>
      manager.role === "project" ? [{ ...manager, projectId }] : [],
    ),
    boundaries: [
      {
        id: deliveryIds.boundary,
        projectId,
        sourceRevision: "base",
        workflow: base.managers[0]!.workflow,
        profileId: "profile",
        approvedAt: project.createdAt,
        protectedPaths: [],
        writablePaths: work.sourcePaths,
        creatableDirectories: [],
        gates: [],
      },
    ],
    schedulingConfigurations: [test.configuration],
    scheduleCandidates: [candidate],
  };
  const seedJson = yield* encodeFactorySnapshot(seed);
  yield* sql`INSERT INTO factory_state(id,revision,payload_json) VALUES(1,${seed.revision},${seedJson})`;
  const store = yield* FactoryStore.FactoryStore.pipe(Effect.provide(FactoryStore.layer));
  const admission = yield* test.service.admit({
    ...test.admission,
    candidate,
    workDigest: factoryScheduleWorkDigest(work),
  });
  const commission = (id: string) =>
    store.commit({
      actor: { kind: "thread", threadId: candidate.managerId },
      now: project.createdAt,
      command: {
        type: "assignment.commission",
        commandId: CommandId.make(id),
        candidateId: candidate.id,
        managerId: candidate.managerId,
        ...work,
      },
      schedulingAdmission: admission,
      allocation: {
        managerThreadId: candidate.managerId,
        leadThreadId: ThreadId.make(`lead:${id}`),
        assignmentId: FactoryAssignmentId.make(`assignment:${id}`),
      },
    });
  return { ...test, store, admission, commission };
});

describe("IssueScheduling", () => {
  it.effect.each(["mapping", "reservation"] as const)(
    "a %s change during the live ticket read prevents the first attachment",
    (change) =>
      Effect.gen(function* () {
        const test = yield* setup;
        const admission = yield* test.service.admit(test.admission);
        test.state.beforeRead =
          change === "mapping"
            ? test.issues
                .configureBoard({
                  requestId: "launch-remap",
                  projectId,
                  locator,
                  mapping: {
                    ready: "triage",
                    inProgress: "progress",
                    inPullRequest: "pr",
                    completed: "done",
                    moveOnMerge: true,
                  },
                })
                .pipe(Effect.asVoid)
            : test.service.release({ candidateId: test.candidate.id });
        const denied = yield* test.service
          .revalidate({
            admission,
            authorize: test.admission.authorize,
            attach: { projectId, threadId: ThreadId.make("lead"), worktreePath: "/worktree" },
          })
          .pipe(Effect.flip);
        assert.equal(denied.reason, "conflict");
        const attempts = yield* test.issues.listAttempts({});
        assert.equal(attempts[0]?.status, "reserved");
        assert.isNull(attempts[0]?.threadId);
      }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("observes a ticket outside Ready only when asked for by number", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.state.column = "triage";
      const board = test.configuration.boardId;
      assert.lengthOf((yield* test.service.observe({ projectId, boardId: board })).items, 0);
      const asked = yield* test.service.observe({
        projectId,
        boardId: board,
        includeNumbers: [issue.number],
      });
      assert.deepEqual(
        asked.items.map((item) => [item.issue.number, item.observation.ready]),
        [[42, false]],
      );
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("managed first attachment cannot bypass live scheduling admission", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const admission = yield* test.service.admit(test.admission);
      const attach = { projectId, threadId: ThreadId.make("lead"), worktreePath: "/worktree" };
      const denied = yield* test.issues
        .attachAttempt({ ...attach, link: admission.issueAttempt })
        .pipe(Effect.flip);
      assert.match(denied.message, /fresh scheduling admission/);
      yield* test.service.revalidate({ admission, authorize: test.admission.authorize, attach });
      const attempts = yield* test.issues.listAttempts({});
      assert.equal(attempts[0]?.status, "attached");
      assert.equal(attempts[0]?.threadId, attach.threadId);
    }).pipe(Effect.scoped, Effect.provide(database)),
  );
  it.effect.each(["mapping", "board", "release"] as const)(
    "FactoryStore rejects a changed %s in the same transaction as assignment creation",
    (change) =>
      Effect.gen(function* () {
        const test = yield* factoryFixture;
        if (change === "mapping") {
          yield* test.issues.configureBoard({
            requestId: "remap",
            projectId,
            locator,
            mapping: {
              ready: "triage",
              inProgress: "progress",
              inPullRequest: "pr",
              completed: "done",
              moveOnMerge: true,
            },
          });
        } else if (change === "board") {
          test.state.column = "triage";
          yield* test.issues.openBoard({
            projectId,
            boardId: test.configuration.boardId,
            refresh: true,
          });
          yield* test.issues.drainRefreshes;
        } else yield* test.service.release({ candidateId: test.candidate.id });
        const denied = yield* test.commission(`changed:${change}`).pipe(Effect.flip);
        assert.equal(denied.code, "stale-revision");
        assert.equal((yield* test.store.snapshot).assignments.length, 0);
        assert.equal((yield* test.store.pending).length, 0);
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT command_id FROM factory_commands`).length, 0);
      }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect(
    "a losing cleanup reads the real committed assignment within its reservation transaction",
    () =>
      Effect.gen(function* () {
        const test = yield* factoryFixture;
        const winner = yield* test.commission("winner");
        assert.isDefined(winner.assignmentId);
        assert.equal((yield* test.store.snapshot).assignments.length, 1);
        yield* test.commission("loser").pipe(Effect.flip);
        const denied = yield* test.service
          .release({
            candidateId: test.candidate.id,
            authorizeUnstarted: Effect.gen(function* () {
              const state = yield* test.store.snapshot.pipe(
                Effect.mapError(
                  () =>
                    new IssueOperationError({
                      reason: "storage",
                      message: "Cannot verify ownership",
                    }),
                ),
              );
              if (
                state.assignments.some(
                  (assignment) => assignment.scheduling?.candidateId === test.candidate.id,
                )
              )
                return yield* new IssueOperationError({
                  reason: "conflict",
                  message: "The winning assignment still owns this reservation",
                });
            }),
          })
          .pipe(Effect.flip);
        assert.match(denied.message, /winning assignment/);
        assert.isTrue(yield* test.service.fence(test.admission));
        assert.equal((yield* test.issues.listAttempts({})).length, 1);
      }).pipe(Effect.scoped, Effect.provide(database)),
  );
  it.effect("retains the same reservation after closing and reopening the SQLite file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(directory, "scheduling.sqlite");
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture();
          return yield* test.service.admit(test.admission);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
      const replay = yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture(false);
          return yield* test.service.admit(test.admission);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
      assert.deepEqual(replay.issueAttempt, first.issueAttempt);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "a concluded assignment needs explicit host authorization before a new generation can reserve",
    () =>
      Effect.gen(function* () {
        const test = yield* setup;
        const first = yield* test.service.admit(test.admission);
        yield* test.service.revalidate({
          admission: first,
          authorize: test.admission.authorize,
          attach: {
            threadId: ThreadId.make("lead"),
            projectId,
            worktreePath: "/worktree",
          },
        });
        assert.equal(
          (yield* test.service.release({ candidateId: test.candidate.id }).pipe(Effect.flip))
            .reason,
          "conflict",
        );
        assert.equal(
          (yield* test.service
            .release({
              candidateId: test.candidate.id,
              authorizeCompleted: Effect.fail(
                new IssueOperationError({ reason: "conflict", message: "No human reopen" }),
              ),
            })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        yield* test.service.release({
          candidateId: test.candidate.id,
          authorizeCompleted: Effect.void,
        });
        const second = yield* test.service.admit({
          ...test.admission,
          candidate: { ...test.candidate, id: "next-generation", generation: 1 },
        });
        assert.notEqual(second.issueAttempt.attemptId, first.issueAttempt.attemptId);
        assert.isFalse(yield* test.service.fence(first));
      }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("a retro-origin ticket can use freshly verified Ready authorization", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const admitted = yield* test.service.admit({
        ...test.admission,
        candidate: {
          ...test.candidate,
          source: { kind: "project-improvement", followupId: "followup" },
        },
      });
      assert.equal(admitted.authority.kind, "tracker-ready");
    }).pipe(Effect.scoped, Effect.provide(database)),
  );
  it.effect(
    "ignores a cached Ready snapshot and rechecks exact ticket details before reservation",
    () =>
      Effect.gen(function* () {
        const test = yield* setup;
        test.state.column = "triage";
        assert.equal(
          (yield* test.issues.openBoard({ projectId, boardId: test.configuration.boardId }))
            .items[0]?.columnId,
          "ready",
        );
        assert.equal(
          (yield* test.service.admit(test.admission).pipe(Effect.flip)).reason,
          "conflict",
        );
        test.state.column = "ready";
        test.state.body = "Changed scope";
        assert.match(
          (yield* test.service.admit(test.admission).pipe(Effect.flip)).message,
          /changed/,
        );
        assert.equal((yield* test.issues.listAttempts({})).length, 0);
      }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("reserves once across service restart and blocks a competing manual reservation", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const first = yield* test.service.admit(test.admission);
      const restarted = yield* test.restart;
      const replay = yield* restarted.admit(test.admission);
      assert.deepEqual(replay.issueAttempt, first.issueAttempt);
      assert.equal((yield* test.issues.listAttempts({})).length, 1);
      assert.isTrue(yield* restarted.fence(replay));
      assert.equal((yield* test.manual("manual").pipe(Effect.flip)).reason, "conflict");
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("a manual reservation winning during authorization prevents the factory claim", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.state.beforeAuthorize = Effect.gen(function* () {
        test.state.beforeAuthorize = Effect.void;
        yield* test.manual("manual-first");
      });
      assert.match(
        (yield* test.service.admit(test.admission).pipe(Effect.flip)).message,
        /another reserved/,
      );
      assert.equal((yield* test.issues.listAttempts({})).length, 1);
      assert.isUndefined(yield* test.service.reservation(test.candidate.id));
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect(
    "an internal project rule authorizes separate work while the ticket remains triage",
    () =>
      Effect.gen(function* () {
        const test = yield* setup;
        test.state.column = "triage";
        const admitted = yield* test.service.admit({
          ...test.admission,
          candidate: {
            ...test.candidate,
            source: { kind: "project-improvement", followupId: "followup" },
          },
          authorize: Effect.succeed({
            kind: "project-improvement",
            ruleId: "rule",
            followupId: "followup",
          }),
        });
        assert.equal(admitted.authority.kind, "project-improvement");
        assert.equal(test.state.column, "triage");
        assert.equal((yield* test.issues.listAttempts({})).length, 1);
      }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("release permits manual work and prevents a stale launch from attaching", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const admitted = yield* test.service.admit(test.admission);
      yield* test.service.release({ candidateId: test.candidate.id });
      assert.isFalse(yield* test.service.fence(admitted));
      yield* test.manual("manual-after-dismiss");
      assert.equal(
        (yield* test.issues
          .attachAttempt({
            link: admitted.issueAttempt,
            threadId: ThreadId.make("late-lead"),
            projectId,
            worktreePath: "/worktree",
          })
          .pipe(Effect.flip)).reason,
        "conflict",
      );
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("revalidation holds revoked readiness, changed details and late authority denial", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const admitted = yield* test.service.admit(test.admission);
      test.state.column = "triage";
      assert.match(
        (yield* test.service
          .revalidate({ admission: admitted, authorize: test.admission.authorize })
          .pipe(Effect.flip)).message,
        /Ready/,
      );
      test.state.column = "ready";
      test.state.beforeAuthorize = Effect.fail(
        new IssueOperationError({ reason: "conflict", message: "Project paused" }),
      );
      assert.match(
        (yield* test.service
          .revalidate({ admission: admitted, authorize: test.admission.authorize })
          .pipe(Effect.flip)).message,
        /paused/,
      );
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect(
    "late authority denial at the shared reservation transaction leaves no attempt or claim",
    () =>
      Effect.gen(function* () {
        const test = yield* setup;
        let admissions = 0;
        test.state.beforeAuthorize = Effect.gen(function* () {
          admissions++;
          if (admissions === 2)
            return yield* new IssueOperationError({
              reason: "conflict",
              message: "Project paused before reservation",
            });
        });
        assert.match(
          (yield* test.service.admit(test.admission).pipe(Effect.flip)).message,
          /paused/,
        );
        assert.equal((yield* test.issues.listAttempts({})).length, 0);
        assert.isUndefined(yield* test.service.reservation(test.candidate.id));
      }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("released admission retries retain the original attempt identity", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const first = yield* test.service.admit(test.admission);
      yield* test.service.release({ candidateId: test.candidate.id });
      const second = yield* test.service.admit(test.admission);
      assert.deepEqual(second.issueAttempt, first.issueAttempt);
      assert.equal((yield* test.issues.listAttempts({})).length, 1);
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect(
    "transactional cleanup authorization preserves a concurrently commissioned reservation",
    () =>
      Effect.gen(function* () {
        const test = yield* setup;
        const admission = yield* test.service.admit(test.admission);
        const denied = yield* test.service
          .release({
            candidateId: test.candidate.id,
            authorizeUnstarted: Effect.fail(
              new IssueOperationError({
                reason: "conflict",
                message: "A concurrent command already commissioned this candidate",
              }),
            ),
          })
          .pipe(Effect.flip);
        assert.match(denied.message, /commissioned/);
        assert.isTrue(yield* test.service.fence(admission));
        assert.equal((yield* test.manual("competing").pipe(Effect.flip)).reason, "conflict");
      }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("fences mapping edits and never releases an attached attempt as unstarted", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const admitted = yield* test.service.admit(test.admission);
      yield* test.service.revalidate({
        admission: admitted,
        authorize: test.admission.authorize,
        attach: {
          threadId: ThreadId.make("lead"),
          projectId,
          worktreePath: "/worktree",
        },
      });
      assert.equal(
        (yield* test.service.release({ candidateId: test.candidate.id }).pipe(Effect.flip)).reason,
        "conflict",
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE issue_boards SET mapping_json='null' WHERE id=${test.configuration.boardId}`;
      assert.isFalse(yield* test.service.fence(admitted));
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect(
    "observation caches unchanged details but an explicit read always fetches fresh scope",
    () =>
      Effect.gen(function* () {
        const test = yield* setup;
        const reads = test.state.reads;
        yield* test.service.observe({ projectId, boardId: test.configuration.boardId });
        assert.equal(test.state.reads, reads);
        test.state.body = "Fresh read";
        assert.equal(
          (yield* test.service.read({ candidate: test.candidate })).detail.body,
          "Fresh read",
        );
        assert.equal(test.state.reads, reads + 1);
      }).pipe(Effect.scoped, Effect.provide(database)),
  );
});
