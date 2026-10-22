import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_FACTORY_CONFIG,
  FactoryConfig,
  FactoryConfigOverride,
  FactoryOperationError,
  IssueBoardView,
  IssueSummary,
  ModelSelection,
  ProjectId,
  ThreadId,
  type FactoryAssignmentsEvent,
  type FactoryManagersEvent,
  type FactoryOnboardingReport,
  type FactoryRole,
  type IssueAttemptsStartInput,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import {
  makeFactoryService,
  type FactoryThreadLaunch,
  type FactoryThreadMessage,
  type FactoryThreadRuns,
} from "./FactoryService.ts";
import { FactoryV1 } from "./migrations/FactoryV1.ts";
import type { RoleSkillSource } from "./roleSkills.ts";
import { DEFAULT_ROLE_SKILLS, ONBOARDING_BRIEF } from "./roles/index.ts";

const PROJECT_ID = ProjectId.make("project-1");
const UNKNOWN_PROJECT_ID = ProjectId.make("project-missing");
const EPOCH = "1970-01-01T00:00:00.000Z";

const PROJECT: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "App",
  workspaceRoot: "/repo",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/app.git",
    },
    provider: "github",
    owner: "acme",
    name: "app",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: EPOCH,
  updatedAt: EPOCH,
};

const model = Schema.decodeSync(ModelSelection);
const OPUS = model({ instanceId: "claude", model: "claude-opus-5-5" });
const SONNET = model({ instanceId: "claude", model: "claude-sonnet-5" });
const GPT = model({ instanceId: "codex", model: "gpt-6" });

const decodeConfig = Schema.decodeSync(FactoryConfig);
const decodeOverride = Schema.decodeSync(FactoryConfigOverride);

const preset = (name: string, workflow: string, models?: ReadonlyArray<typeof OPUS>) => ({
  id: `preset-${name}-${workflow}`,
  name,
  useWhen: "",
  members: [{ role: "implementer" as const, count: 1, ...(models ? { models } : {}) }],
  workflow,
  createdBy: "user" as const,
});

const ENVIRONMENT = decodeConfig({
  pickupGuidance: "anything",
  concurrencyCap: 3,
  modelPool: [OPUS, SONNET],
  roleModels: { manager: OPUS },
  teamPresets: [preset("Solo", "environment"), preset("Pair", "environment")],
});

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

interface HarnessOptions {
  /** Saved as the environment config before the service is returned. */
  readonly config?: FactoryConfig;
  /** How many launches fail before one succeeds. */
  readonly launchFailures?: number;
  readonly readRoleSkill?: (role: FactoryRole, projectRoot: string) => RoleSkillSource;
}

const decodeIssue = Schema.decodeSync(IssueSummary);
const decodeBoardView = Schema.decodeSync(IssueBoardView);
const READY = "column-ready";
const IN_PROGRESS = "column-progress";

const issue = (number: number, updatedAt = EPOCH) =>
  decodeIssue({
    ref: {
      hostKind: "github",
      host: "github.com",
      repository: "acme/app",
      id: `issue-node-${number}`,
      number,
      url: `https://github.com/acme/app/issues/${number}`,
    },
    title: `Ticket ${number}`,
    state: "open",
    updatedAt,
    labels: [],
  });

/** One connected board whose tickets sit in the given columns. */
const board = (
  items: ReadonlyArray<{
    readonly number: number;
    readonly columnId: string;
    readonly updatedAt?: string;
  }>,
) =>
  decodeBoardView({
    board: {
      id: "board-1",
      projectId: PROJECT_ID,
      title: "Roadmap",
      locator: {
        kind: "github-project",
        host: "github.com",
        owner: "acme",
        ownerKind: "organization",
        projectNumber: 1,
      },
      mapping: {
        ready: READY,
        inProgress: IN_PROGRESS,
        inPullRequest: "column-review",
        completed: "column-done",
        moveOnMerge: true,
      },
    },
    columns: [
      { id: READY, title: "Ready" },
      { id: IN_PROGRESS, title: "In progress" },
    ],
    items: items.map((item) => ({
      issue: issue(item.number, item.updatedAt),
      itemId: `item-${item.number}`,
      columnId: item.columnId,
      version: "v1",
    })),
    attempts: [],
    moves: [],
  });

/** What the fakes do next; tests change it between calls. */
interface HarnessControls {
  sendFailures: number;
  attemptFailures: number;
}

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    yield* FactoryV1;
    const launches: FactoryThreadLaunch[] = [];
    const skillReads: Array<readonly [FactoryRole, string]> = [];
    const boards: IssueBoardView[] = [];
    const attemptStarts: IssueAttemptsStartInput[] = [];
    const sentMessages: FactoryThreadMessage[] = [];
    const threadRuns = new Map<ThreadId, FactoryThreadRuns>();
    const controls: HarnessControls = { sendFailures: 0, attemptFailures: 0 };
    let failures = options.launchFailures ?? 0;
    let threads = 0;
    const service = yield* makeFactoryService({
      getProject: (id) => Effect.succeed(id === PROJECT_ID ? PROJECT : null),
      allocateThreadId: () => Effect.sync(() => ThreadId.make(`thread-${++threads}`)),
      launchThread: (input) =>
        Effect.suspend(() => {
          launches.push(input);
          if (failures === 0) return Effect.void;
          failures -= 1;
          return Effect.fail(
            new FactoryOperationError({ reason: "unavailable", message: "Provider is offline." }),
          );
        }),
      readRoleSkill: (role, projectRoot) =>
        Effect.sync(() => {
          skillReads.push([role, projectRoot]);
          return (
            options.readRoleSkill?.(role, projectRoot) ?? {
              text: DEFAULT_ROLE_SKILLS[role],
              source: "default",
            }
          );
        }),
      readBoards: (projectId) =>
        Effect.sync(() =>
          boards.filter((view) => view.board.projectId === projectId).map((view) => view.board),
        ),
      readBoard: (_projectId, boardId) =>
        Effect.suspend(() => {
          const view = boards.find((candidate) => candidate.board.id === boardId);
          return view
            ? Effect.succeed(view)
            : Effect.fail(new FactoryOperationError({ reason: "not-found", message: "No board." }));
        }),
      startAttempt: (input) =>
        Effect.suspend(() => {
          attemptStarts.push(input);
          if (controls.attemptFailures > 0) {
            controls.attemptFailures -= 1;
            return Effect.fail(
              new FactoryOperationError({ reason: "conflict", message: "The ticket moved." }),
            );
          }
          const threadId = ThreadId.make(`lead-${attemptStarts.length}`);
          return Effect.succeed({
            threadId,
            attempt: {
              id: `attempt-${attemptStarts.length}`,
              boardId: input.boardId,
              issue: input.issue,
              projectId: input.projectId,
              threadId,
              worktreePath: null,
              status: "launching" as const,
              active: false,
              endedReason: null,
              automaticMoves: "on" as const,
              createdAt: EPOCH,
              startedAt: null,
              controllingPullRequest: null,
            },
          });
        }),
      readThreadRuns: (threadId) => Effect.sync(() => threadRuns.get(threadId) ?? null),
      sendToThread: (input) =>
        Effect.suspend(() => {
          if (controls.sendFailures === 0) {
            sentMessages.push(input);
            return Effect.void;
          }
          controls.sendFailures -= 1;
          return Effect.fail(
            new FactoryOperationError({ reason: "unavailable", message: "Thread is busy." }),
          );
        }),
      resolveBaseRef: () => Effect.succeed("trunk"),
    });
    if (options.config)
      yield* service.updateConfig({ scope: "environment", config: options.config });
    return {
      service,
      launches,
      skillReads,
      boards,
      attemptStarts,
      sentMessages,
      threadRuns,
      controls,
    };
  });

const makeService = makeHarness().pipe(Effect.map(({ service }) => service));
/** Managers need a model pool to launch from. */
const makeManagerService = makeHarness({ config: ENVIRONMENT }).pipe(
  Effect.map(({ service }) => service),
);

type Service = Effect.Success<typeof makeService>;

const REPORT: FactoryOnboardingReport = {
  summary: "pnpm workspace; CI runs lint and tests.",
  controlPaths: [".github/workflows/**", "AGENTS.md"],
  boardGaps: ["No Ready column is mapped."],
  openChoices: ["Which tickets count as small?"],
};

const create = (service: Service, requestId = "create-1", name = "Ada") =>
  service.createManager({ requestId, projectId: PROJECT_ID, name });

const managerRowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM factory_managers`;
  return rows[0]?.count;
});

const insertAssignment = (managerId: string, state: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO factory_assignments(id,manager_id,project_id,title,brief,
        completion_condition,source,complexity,state,team_json,created_at,updated_at)
      VALUES('assignment-1',${managerId},${PROJECT_ID},'title','brief','done','user','small',
        ${state},'{"preset":"custom","members":[]}',${EPOCH},${EPOCH})`;
  });

describe("FactoryService config", () => {
  it.effect("returns the defaults until the environment config is saved", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeService;

        const initial = yield* service.getConfig({});
        assert.isFalse(initial.configured);
        assert.deepStrictEqual(initial.environment, DEFAULT_FACTORY_CONFIG);
        assert.deepStrictEqual(initial.effective, DEFAULT_FACTORY_CONFIG);

        const saved = yield* service.updateConfig({ scope: "environment", config: ENVIRONMENT });
        assert.isTrue(saved.configured);
        assert.deepStrictEqual(saved.environment, ENVIRONMENT);

        const read = yield* service.getConfig({});
        assert.isTrue(read.configured);
        assert.deepStrictEqual(read.environment, ENVIRONMENT);
        assert.deepStrictEqual(read.effective, ENVIRONMENT);
      }),
    ),
  );

  it.effect("refuses an environment config that names a model outside the pool", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeService;

        const managerOutside = yield* service
          .updateConfig({
            scope: "environment",
            config: decodeConfig({ modelPool: [OPUS], roleModels: { manager: GPT } }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(managerOutside.reason, "invalid");
        assert.include(managerOutside.message, "gpt-6");

        const memberOutside = yield* service
          .updateConfig({
            scope: "environment",
            config: decodeConfig({ modelPool: [OPUS], teamPresets: [preset("Solo", "a", [GPT])] }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(memberOutside.reason, "invalid");

        assert.isFalse((yield* service.getConfig({})).configured);
      }),
    ),
  );

  it.effect("refuses two team presets with the same name", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeService;

        const refused = yield* service
          .updateConfig({
            scope: "environment",
            config: decodeConfig({ teamPresets: [preset("Solo", "a"), preset("Solo", "b")] }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "invalid");
        assert.include(refused.message, "Solo");
      }),
    ),
  );
});

describe("FactoryService project overrides", () => {
  it.effect("applies a project's overrides over the environment and clears them on null", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeService;
        yield* service.updateConfig({ scope: "environment", config: ENVIRONMENT });

        const override = decodeOverride({
          pickupGuidance: "only small",
          teamPresets: [preset("Solo", "project")],
        });
        const saved = yield* service.updateConfig({
          scope: "project",
          projectId: PROJECT_ID,
          override,
        });
        assert.deepStrictEqual(saved.override, override);
        assert.deepStrictEqual(saved.environment, ENVIRONMENT);
        const { pickupGuidance, teamPresets, ...inherited } = saved.effective;
        const { pickupGuidance: _, teamPresets: __, ...environmentRest } = ENVIRONMENT;
        assert.strictEqual(pickupGuidance, "only small");
        assert.deepStrictEqual(inherited, environmentRest);
        assert.deepStrictEqual(
          teamPresets.map((team) => [team.name, team.workflow]),
          [
            ["Pair", "environment"],
            ["Solo", "project"],
          ],
        );
        assert.deepStrictEqual(yield* service.getConfig({ projectId: PROJECT_ID }), saved);

        const cleared = yield* service.updateConfig({
          scope: "project",
          projectId: PROJECT_ID,
          override: null,
        });
        assert.isNull(cleared.override);
        assert.deepStrictEqual(cleared.effective, ENVIRONMENT);
      }),
    ),
  );

  it.effect("refuses an override that adds a model to the environment pool", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeService;
        yield* service.updateConfig({ scope: "environment", config: ENVIRONMENT });

        const refused = yield* service
          .updateConfig({
            scope: "project",
            projectId: PROJECT_ID,
            override: decodeOverride({ modelPool: [OPUS, GPT] }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "invalid");
        assert.isNull((yield* service.getConfig({ projectId: PROJECT_ID })).override);
      }),
    ),
  );

  it.effect("refuses an environment config that would leave a project override unsound", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeService;
        yield* service.updateConfig({ scope: "environment", config: ENVIRONMENT });
        yield* service.updateConfig({
          scope: "project",
          projectId: PROJECT_ID,
          override: decodeOverride({ roleModels: { manager: SONNET } }),
        });

        const narrowed = decodeConfig({ modelPool: [OPUS], roleModels: { manager: OPUS } });
        const refused = yield* service
          .updateConfig({ scope: "environment", config: narrowed })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "invalid");
        assert.include(refused.message, "claude-sonnet-5");
        assert.deepStrictEqual((yield* service.getConfig({})).environment, ENVIRONMENT);
      }),
    ),
  );
});

describe("FactoryService managers", () => {
  it.effect("creates a manager in onboarding and replays a repeated request", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeManagerService;

        const created = yield* create(service);
        assert.strictEqual(created.state, "onboarding");
        assert.strictEqual(created.projectId, PROJECT_ID);
        assert.strictEqual(created.name, "Ada");
        assert.strictEqual(created.threadId, "thread-1");
        assert.strictEqual(created.activeAssignments, 0);
        assert.strictEqual(created.waitingOnYou, 0);

        assert.deepStrictEqual(yield* create(service), created);
        assert.strictEqual(yield* managerRowCount, 1);

        const reused = yield* create(service, "create-1", "Grace").pipe(Effect.flip);
        assert.strictEqual(reused.reason, "conflict");

        const second = yield* create(service, "create-2", "Grace").pipe(Effect.flip);
        assert.strictEqual(second.reason, "conflict");
        assert.include(second.message, "Ada");
        assert.strictEqual(yield* managerRowCount, 1);
      }),
    ),
  );

  it.effect("refuses a manager for an unknown project", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeManagerService;

        const refused = yield* service
          .createManager({ requestId: "create-1", projectId: UNKNOWN_PROJECT_ID, name: "Ada" })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "not-found");
        assert.strictEqual(yield* managerRowCount, 0);
      }),
    ),
  );

  it.effect("pauses by scope and resumes to onboarding when paused during onboarding", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeManagerService;
        const { id: managerId } = yield* create(service);

        const managerPaused = yield* service.pauseManager({
          requestId: "pause-1",
          managerId,
          scope: "manager",
        });
        assert.strictEqual(managerPaused.state, "manager-paused");

        const projectPaused = yield* service.pauseManager({
          requestId: "pause-2",
          managerId,
          scope: "project",
        });
        assert.strictEqual(projectPaused.state, "project-paused");

        const stillProjectPaused = yield* service.pauseManager({
          requestId: "pause-3",
          managerId,
          scope: "manager",
        });
        assert.strictEqual(stillProjectPaused.state, "project-paused");

        const resumed = yield* service.resumeManager({ requestId: "resume-1", managerId });
        assert.strictEqual(resumed.state, "onboarding");
      }),
    ),
  );

  it.effect("resumes an active manager to active", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeManagerService;
        const sql = yield* SqlClient.SqlClient;
        const { id: managerId } = yield* create(service);
        yield* sql`UPDATE factory_managers SET state='active' WHERE id=${managerId}`;

        const paused = yield* service.pauseManager({
          requestId: "pause-1",
          managerId,
          scope: "project",
        });
        assert.strictEqual(paused.state, "project-paused");

        const resumed = yield* service.resumeManager({ requestId: "resume-1", managerId });
        assert.strictEqual(resumed.state, "active");
      }),
    ),
  );

  it.effect(
    "refuses to retire a manager with active work, then retires and frees the project",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const service = yield* makeManagerService;
          const sql = yield* SqlClient.SqlClient;
          const { id: managerId } = yield* create(service);
          yield* insertAssignment(managerId, "active");

          const refused = yield* service
            .retireManager({ requestId: "retire-1", managerId })
            .pipe(Effect.flip);
          assert.strictEqual(refused.reason, "conflict");
          assert.include(refused.message, "Ada");

          yield* sql`UPDATE factory_assignments SET state='completed' WHERE id='assignment-1'`;
          const retired = yield* service.retireManager({ requestId: "retire-1", managerId });
          assert.strictEqual(retired.state, "retired");
          assert.strictEqual(retired.activeAssignments, 0);

          // Manager ids are random, so a later timestamp is what orders the listing.
          yield* TestClock.adjust("1 second");
          const successor = yield* create(service, "create-2", "Grace");
          assert.strictEqual(successor.state, "onboarding");

          const current = yield* service.listManagers({ projectId: PROJECT_ID });
          assert.deepStrictEqual(
            current.map((manager) => manager.id),
            [successor.id],
          );
          const all = yield* service.listManagers({ projectId: PROJECT_ID, includeRetired: true });
          assert.deepStrictEqual(
            all.map((manager) => [manager.id, manager.state]),
            [
              [managerId, "retired"],
              [successor.id, "onboarding"],
            ],
          );

          assert.deepStrictEqual(
            yield* service.retireManager({ requestId: "retire-1", managerId }),
            retired,
          );
          const again = yield* service.retireManager({ requestId: "retire-2", managerId });
          assert.strictEqual(again.state, "retired");
        }),
      ),
  );

  it.effect("streams the current managers, then the list after a change", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeManagerService;
        const events: FactoryManagersEvent[] = [];
        const subscribed = yield* Deferred.make<void>();
        const fiber = yield* service.subscribeManagers({}).pipe(
          Stream.take(2),
          Stream.runForEach((event) =>
            Effect.sync(() => events.push(event)).pipe(
              Effect.andThen(Deferred.succeed(subscribed, undefined)),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);

        const created = yield* create(service);
        yield* Fiber.join(fiber);

        assert.deepStrictEqual(events, [{ managers: [] }, { managers: [created] }]);
      }),
    ),
  );
});

const managerRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ id: string }>`SELECT id FROM factory_managers`;
});

describe("FactoryService manager launch", () => {
  it.effect("refuses a manager while the model pool is empty", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, launches } = yield* makeHarness();

        const refused = yield* create(service).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "invalid");
        assert.include(refused.message, "pool");
        assert.strictEqual(yield* managerRowCount, 0);
        assert.deepStrictEqual(launches, []);
      }),
    ),
  );

  it.effect("launches the manager's thread with its skill, the pool and the onboarding brief", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, launches, skillReads } = yield* makeHarness({
          config: decodeConfig({
            pickupGuidance: "anything",
            modelPool: [OPUS, SONNET],
            roleModels: { manager: SONNET },
          }),
        });

        const created = yield* create(service);
        assert.deepStrictEqual(created.modelSelection, SONNET);
        assert.deepStrictEqual(skillReads, [["manager", "/repo"]]);
        assert.strictEqual(launches.length, 1);
        const launch = launches[0]!;
        assert.strictEqual(launch.threadId, created.threadId);
        assert.strictEqual(launch.commandId, "factory-manager:create-1");
        assert.strictEqual(launch.title, "Engineering manager: Ada");
        assert.deepStrictEqual(launch.modelSelection, SONNET);
        assert.strictEqual(launch.runtimeMode, "full-access");
        assert.strictEqual(launch.interactionMode, "default");
        for (const heading of ["## What you are", "## What you must never touch"])
          assert.include(launch.text, heading);
        assert.include(launch.text, "- claude/claude-opus-5-5\n- claude/claude-sonnet-5");
        assert.include(launch.text, "Pickup guidance:\n\nanything");
        assert.isTrue(launch.text.endsWith(`\n\n${ONBOARDING_BRIEF}`));
        assert.notInclude(launch.text, "{{");

        assert.deepStrictEqual(yield* create(service), created);
        assert.strictEqual(launches.length, 1);
      }),
    ),
  );

  it.effect("defaults to the first pool model, and takes a chosen one only from the pool", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, launches } = yield* makeHarness({
          config: decodeConfig({ modelPool: [SONNET, OPUS] }),
        });

        const outside = yield* service
          .createManager({
            requestId: "create-1",
            projectId: PROJECT_ID,
            name: "Ada",
            modelSelection: GPT,
          })
          .pipe(Effect.flip);
        assert.strictEqual(outside.reason, "invalid");
        assert.include(outside.message, "gpt-6");
        assert.strictEqual(yield* managerRowCount, 0);
        assert.deepStrictEqual(launches, []);

        const defaulted = yield* create(service, "create-2");
        assert.deepStrictEqual(defaulted.modelSelection, SONNET);

        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM factory_managers`;
        const chosen = yield* service.createManager({
          requestId: "create-3",
          projectId: PROJECT_ID,
          name: "Grace",
          modelSelection: OPUS,
          runtimeMode: "approval-required",
        });
        assert.deepStrictEqual(chosen.modelSelection, OPUS);
        assert.deepStrictEqual(
          launches.map((launch) => [launch.modelSelection.model, launch.runtimeMode]),
          [
            ["claude-sonnet-5", "full-access"],
            ["claude-opus-5-5", "approval-required"],
          ],
        );
      }),
    ),
  );

  it.effect("removes the manager when its thread fails to launch, so a retry can succeed", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, launches } = yield* makeHarness({
          config: ENVIRONMENT,
          launchFailures: 1,
        });

        const failed = yield* create(service).pipe(Effect.flip);
        assert.strictEqual(failed.reason, "unavailable");
        assert.include(failed.message, "Provider is offline.");
        assert.strictEqual(yield* managerRowCount, 0);

        const retried = yield* create(service, "create-2");
        assert.strictEqual(retried.state, "onboarding");
        assert.deepStrictEqual(
          (yield* managerRows).map((row) => row.id),
          [retried.id],
        );
        assert.strictEqual(launches.length, 2);
      }),
    ),
  );
});

describe("FactoryService onboarding", () => {
  it.effect("stores the proposal from the manager's own thread only", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeManagerService;
        const created = yield* create(service);
        const threadId = created.threadId!;

        const stranger = yield* service
          .proposeOnboarding(ThreadId.make("thread-other"), REPORT)
          .pipe(Effect.flip);
        assert.strictEqual(stranger.reason, "not-found");
        assert.isNull(yield* service.managerForThread(ThreadId.make("thread-other")));

        const proposed = yield* service.proposeOnboarding(threadId, REPORT);
        assert.strictEqual(proposed.state, "onboarding");
        assert.deepStrictEqual(proposed.onboardingReport, REPORT);
        assert.strictEqual(proposed.onboardingNotes, REPORT.summary);
        assert.deepStrictEqual(proposed.controlPaths, []);
        assert.deepStrictEqual(yield* service.managerForThread(threadId), proposed);
      }),
    ),
  );

  it.effect("approves with the cleaned control paths plus the factory's own folder", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeManagerService;
        const { id: managerId, threadId } = yield* create(service);
        const approve = (requestId: string) =>
          service.approveOnboarding({
            requestId,
            managerId,
            controlPaths: [" .github/workflows/** ", "", "AGENTS.md", ".github/workflows/**"],
          });

        const early = yield* approve("approve-0").pipe(Effect.flip);
        assert.strictEqual(early.reason, "conflict");

        yield* service.proposeOnboarding(threadId!, REPORT);
        yield* service.pauseManager({ requestId: "pause-1", managerId, scope: "manager" });
        const paused = yield* approve("approve-1").pipe(Effect.flip);
        assert.strictEqual(paused.reason, "conflict");
        assert.include(paused.message, "Resume");
        yield* service.resumeManager({ requestId: "resume-1", managerId });

        const approved = yield* approve("approve-2");
        assert.strictEqual(approved.state, "active");
        assert.deepStrictEqual(approved.controlPaths, [
          ".github/workflows/**",
          "AGENTS.md",
          ".satellite/factory/",
        ]);
        assert.deepStrictEqual(approved.onboardingReport, REPORT);
        assert.deepStrictEqual(yield* approve("approve-2"), approved);

        const again = yield* approve("approve-3").pipe(Effect.flip);
        assert.strictEqual(again.reason, "conflict");
        const lateProposal = yield* service.proposeOnboarding(threadId!, REPORT).pipe(Effect.flip);
        assert.strictEqual(lateProposal.reason, "conflict");
      }),
    ),
  );
});

describe("FactoryService role briefs", () => {
  const TEMPLATE = "allowed:\n{{allowedModels}}\nprotected:\n{{protectedPaths}}";

  it.effect("fills the skill source the project resolves with the role's models and paths", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, skillReads } = yield* makeHarness({
          config: decodeConfig({
            pickupGuidance: "anything",
            modelPool: [OPUS, SONNET],
            roleModels: { manager: OPUS, workers: { implementer: [SONNET] } },
          }),
          readRoleSkill: (role) =>
            role === "implementer"
              ? { text: TEMPLATE, source: "project" }
              : { text: TEMPLATE, source: "environment" },
        });
        const { id: managerId, threadId } = yield* create(service);
        yield* service.proposeOnboarding(threadId!, REPORT);

        const implementer = yield* service.roleBrief(PROJECT_ID, "implementer", managerId);
        assert.deepStrictEqual(implementer, {
          role: "implementer",
          source: "project",
          text: "allowed:\n- claude/claude-sonnet-5\nprotected:\n- .github/workflows/**\n- AGENTS.md",
        });
        assert.deepStrictEqual(skillReads.at(-1), ["implementer", "/repo"]);

        const reviewer = yield* service.roleBrief(PROJECT_ID, "reviewer", managerId);
        assert.strictEqual(reviewer.source, "environment");
        assert.include(reviewer.text, "- claude/claude-opus-5-5\n- claude/claude-sonnet-5");

        yield* service.approveOnboarding({
          requestId: "approve-1",
          managerId,
          controlPaths: ["CI.md"],
        });
        const approved = yield* service.roleBrief(PROJECT_ID, "manager", managerId);
        assert.strictEqual(
          approved.text,
          "allowed:\n- claude/claude-opus-5-5\nprotected:\n- CI.md\n- .satellite/factory/",
        );
      }),
    ),
  );
});

/** One slot, a lead model for small work, and nothing set for large work. */
const FACTORY = decodeConfig({
  pickupGuidance: "Small, well-specified bugs.",
  concurrencyCap: 1,
  modelPool: [OPUS, SONNET],
  roleModels: { manager: OPUS, lead: { small: SONNET } },
});

const makeFactory = makeHarness({ config: FACTORY });
type Factory = Effect.Success<typeof makeFactory>;

const approve = (service: Service, managerId: string, threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* service.proposeOnboarding(threadId, REPORT);
    return yield* service.approveOnboarding({
      requestId: `approve-${managerId}`,
      managerId,
      controlPaths: ["AGENTS.md"],
    });
  });

const activeManager = (service: Service) =>
  Effect.gen(function* () {
    const created = yield* create(service);
    return yield* approve(service, created.id, created.threadId!);
  });

const START = {
  decision: "start",
  complexity: "small",
  reason: "Matches the guidance: a small bug.",
  brief: "Fix the crash when the list is empty.",
  completionCondition: "An empty list renders without errors and a test covers it.",
} as const;

const startTicket = (factory: Factory, threadId: ThreadId, issueNumber = 1) =>
  factory.service.pickup(threadId, { ...START, issueNumber });

const logKinds = (service: Service, managerId: string) =>
  service
    .listLog({ managerId })
    .pipe(Effect.map((entries) => entries.map((entry) => entry.kind).toReversed()));

const memberRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    thread_id: string;
    assignment_id: string;
    role: string;
    parent_thread_id: string;
    joined: string;
  }>`SELECT thread_id,assignment_id,role,parent_thread_id,joined FROM factory_members`;
});

describe("FactoryService status", () => {
  it.effect("lists Ready tickets, judged after a skip until the ticket changes", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards } = factory;
        const manager = yield* activeManager(service);
        boards.push(
          board([
            { number: 1, columnId: READY },
            { number: 2, columnId: IN_PROGRESS },
          ]),
        );

        const before = yield* service.status(manager.id);
        assert.strictEqual(before.concurrencyCap, 1);
        assert.strictEqual(before.activeCount, 0);
        assert.isTrue(before.capacityFree);
        assert.strictEqual(before.pickupGuidance, "Small, well-specified bugs.");
        assert.deepStrictEqual(
          before.readyTickets.map((ticket) => [ticket.issue.ref.number, ticket.judged]),
          [[1, false]],
        );

        const skipped = yield* service.pickup(manager.threadId!, {
          issueNumber: 1,
          decision: "skip",
          complexity: "medium",
          reason: "Needs a design first.",
        });
        assert.isNull(skipped);
        assert.isTrue((yield* service.status(manager.id)).readyTickets[0]!.judged);
        const [skip] = yield* service.listLog({ managerId: manager.id });
        assert.strictEqual(skip!.kind, "skip");
        assert.strictEqual(skip!.reason, "Needs a design first.");
        assert.deepStrictEqual(skip!.payload, {
          issue: issue(1).ref,
          updatedAt: EPOCH,
          complexity: "medium",
        });

        boards[0] = board([{ number: 1, columnId: READY, updatedAt: "2026-01-01T00:00:00.000Z" }]);
        assert.isFalse((yield* service.status(manager.id)).readyTickets[0]!.judged);
      }),
    ),
  );
});

describe("FactoryService pickup", () => {
  it.effect("refuses a start it may not make, and logs each refusal", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, attemptStarts } = factory;
        boards.push(
          board([
            { number: 1, columnId: READY },
            { number: 2, columnId: READY },
            { number: 3, columnId: IN_PROGRESS },
          ]),
        );
        const created = yield* create(service);
        const threadId = created.threadId!;

        const onboarding = yield* startTicket(factory, threadId).pipe(Effect.flip);
        assert.strictEqual(onboarding.reason, "conflict");
        assert.include(onboarding.message, "onboarding");
        yield* approve(service, created.id, threadId);

        const large = yield* service
          .pickup(threadId, { ...START, issueNumber: 1, complexity: "large" })
          .pipe(Effect.flip);
        assert.strictEqual(large.reason, "conflict");
        assert.strictEqual(
          large.message,
          "Large tickets never start on their own. Recommend it to the user instead.",
        );

        const { brief: _, ...withoutBrief } = START;
        const briefless = yield* service
          .pickup(threadId, { ...withoutBrief, issueNumber: 1 })
          .pipe(Effect.flip);
        assert.strictEqual(briefless.reason, "invalid");

        const notReady = yield* startTicket(factory, threadId, 3).pipe(Effect.flip);
        assert.strictEqual(notReady.reason, "conflict");
        assert.include(notReady.message, "#3");

        yield* startTicket(factory, threadId, 1);
        const full = yield* startTicket(factory, threadId, 2).pipe(Effect.flip);
        assert.strictEqual(full.reason, "conflict");
        assert.include(full.message, "slots");

        assert.strictEqual(attemptStarts.length, 1);
        assert.deepStrictEqual(yield* logKinds(service, created.id), [
          "refused",
          "refused",
          "refused",
          "refused",
          "pickup",
          "refused",
        ]);
      }),
    ),
  );

  it.effect("starts a lead on the ticket's attempt with the lead skill and records it", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, attemptStarts } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(service);

        const events: FactoryAssignmentsEvent[] = [];
        const subscribed = yield* Deferred.make<void>();
        const fiber = yield* service.subscribeAssignments({}).pipe(
          Stream.take(2),
          Stream.runForEach((event) =>
            Effect.sync(() => events.push(event)).pipe(
              Effect.andThen(Deferred.succeed(subscribed, undefined)),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);

        const assignment = (yield* startTicket(factory, manager.threadId!))!;
        yield* Fiber.join(fiber);

        assert.strictEqual(attemptStarts.length, 1);
        const start = attemptStarts[0]!;
        assert.strictEqual(start.requestId, `factory-assignment:${assignment.id}`);
        assert.strictEqual(start.boardId, "board-1");
        assert.deepStrictEqual(start.issue, issue(1).ref);
        assert.strictEqual(start.projectId, PROJECT_ID);
        assert.strictEqual(start.branch, "factory/issue-1");
        assert.strictEqual(start.baseRef, "trunk");
        assert.deepStrictEqual(start.modelSelection, SONNET);
        assert.strictEqual(start.runtimeMode, "full-access");
        assert.strictEqual(start.interactionMode, "default");
        for (const heading of ["# Lead", "## What you hand back", "# Assignment"])
          assert.include(start.prompt, heading);
        assert.include(start.prompt, `Completion condition:\n\n${START.completionCondition}`);
        assert.include(start.prompt, START.brief);
        assert.include(start.prompt, "- claude/claude-sonnet-5");
        assert.include(start.prompt, "- AGENTS.md");
        assert.notInclude(start.prompt, "{{");

        assert.strictEqual(assignment.source, "ticket");
        assert.strictEqual(assignment.state, "active");
        assert.strictEqual(assignment.title, "Ticket 1");
        assert.deepStrictEqual(assignment.issue, issue(1).ref);
        assert.strictEqual(assignment.attemptId, "attempt-1");
        assert.strictEqual(assignment.leadThreadId, "lead-1");
        assert.strictEqual(assignment.managerId, manager.id);
        assert.deepStrictEqual(assignment.team, { preset: "custom", members: [] });
        assert.deepStrictEqual(yield* memberRows, [
          {
            thread_id: "lead-1",
            assignment_id: assignment.id,
            role: "lead",
            parent_thread_id: manager.threadId!,
            joined: "created",
          },
        ]);
        const [pickup] = yield* service.listLog({ managerId: manager.id });
        assert.strictEqual(pickup!.kind, "pickup");
        assert.strictEqual(pickup!.assignmentId, assignment.id);

        assert.deepStrictEqual(events, [{ assignments: [] }, { assignments: [assignment] }]);
        assert.deepStrictEqual(
          yield* service.assignmentForThread(ThreadId.make("lead-1")),
          assignment,
        );
        assert.deepStrictEqual(yield* service.listAssignments({ managerId: manager.id }), [
          assignment,
        ]);
        const status = yield* service.status(manager.id);
        assert.strictEqual(status.activeCount, 1);
        assert.isFalse(status.capacityFree);
        assert.deepStrictEqual(status.readyTickets, []);
      }),
    ),
  );

  it.effect("releases the slot and the ticket when the lead fails to start", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, controls } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(service);
        controls.attemptFailures = 1;

        const failed = yield* startTicket(factory, manager.threadId!).pipe(Effect.flip);
        assert.strictEqual(failed.reason, "conflict");
        assert.strictEqual(failed.message, "The ticket moved.");
        assert.deepStrictEqual(yield* service.listAssignments({ includeEnded: true }), []);
        assert.deepStrictEqual(yield* logKinds(service, manager.id), ["refused"]);
        const status = yield* service.status(manager.id);
        assert.isTrue(status.capacityFree);
        assert.isFalse(status.readyTickets[0]!.judged);

        const retried = yield* startTicket(factory, manager.threadId!);
        assert.strictEqual(retried!.leadThreadId, "lead-2");
      }),
    ),
  );
});

describe("FactoryService commission", () => {
  it.effect("starts a large ticket the user asked for, and needs a ticket for now", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, attemptStarts } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(service);
        const work = {
          title: "Rework the sync engine",
          brief: "The user asked for the sync rework.",
          completionCondition: "Sync survives a restart mid-transfer.",
          complexity: "large",
        } as const;

        const ticketless = yield* service.commission(manager.threadId!, work).pipe(Effect.flip);
        assert.strictEqual(ticketless.reason, "invalid");
        assert.strictEqual(
          ticketless.message,
          "Commissioning without a ticket arrives in a later slice.",
        );

        const assignment = yield* service.commission(manager.threadId!, {
          ...work,
          issueNumber: 1,
        });
        assert.strictEqual(assignment.title, "Rework the sync engine");
        assert.strictEqual(assignment.complexity, "large");
        assert.strictEqual(assignment.source, "ticket");
        assert.strictEqual(attemptStarts.length, 1);
        // No lead model is set for large work, so the pool's first model leads it.
        assert.deepStrictEqual(attemptStarts[0]!.modelSelection, OPUS);
        assert.deepStrictEqual(yield* logKinds(service, manager.id), ["refused", "commission"]);
      }),
    ),
  );
});

const failedRun: FactoryThreadRuns = {
  deleted: false,
  latestRunStatus: "failed",
  runInProgress: false,
};

describe("FactoryService lead reconciliation", () => {
  it.effect("stalls an assignment whose lead run failed and wakes the manager about it", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, threadRuns, sentMessages } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(service);
        const assignment = (yield* startTicket(factory, manager.threadId!))!;
        const lead = ThreadId.make("lead-1");

        threadRuns.set(lead, {
          deleted: false,
          latestRunStatus: "completed",
          runInProgress: false,
        });
        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "active");
        assert.deepStrictEqual(yield* logKinds(service, manager.id), ["pickup"]);

        threadRuns.set(lead, failedRun);
        yield* service.reconcileThread(lead);
        const stalled = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(stalled.state, "stalled");
        assert.strictEqual(stalled.waitingReason, "The lead's latest run failed.");
        const [wake, stall] = yield* service.listLog({ managerId: manager.id });
        assert.strictEqual(stall!.kind, "stalled");
        assert.strictEqual(wake!.kind, "wake");
        assert.strictEqual(wake!.assignmentId, assignment.id);
        assert.isNull(wake!.deliveredAt);

        yield* service.sweep;
        assert.strictEqual(sentMessages.length, 1);
        assert.strictEqual(
          sentMessages[0]!.text,
          "Assignment Ticket 1 stalled: The lead's latest run failed. Investigate its lead thread and decide.",
        );
      }),
    ),
  );
});

describe("FactoryService sweep", () => {
  it.effect("wakes an active manager once about an unjudged Ready ticket", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, sentMessages } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(service);

        yield* service.sweep;
        assert.strictEqual(sentMessages.length, 1);
        const message = sentMessages[0]!;
        assert.strictEqual(message.threadId, manager.threadId);
        assert.strictEqual(message.projectId, PROJECT_ID);
        assert.isTrue(message.commandId.startsWith(`factory-wake:${manager.id}:`));
        assert.include(message.text, "#1 Ticket 1 (https://github.com/acme/app/issues/1)");
        assert.include(message.text, "factory_pickup");
        const [wake] = yield* service.listLog({ managerId: manager.id });
        assert.strictEqual(wake!.kind, "wake");
        assert.strictEqual(wake!.reason, "pickup");
        assert.isNotNull(wake!.deliveredAt);

        yield* service.sweep;
        assert.strictEqual(sentMessages.length, 1);
        assert.deepStrictEqual(yield* logKinds(service, manager.id), ["wake"]);
      }),
    ),
  );

  it.effect("keeps a wake whose message failed and delivers it on the next sweep", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, sentMessages, controls } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(service);
        controls.sendFailures = 1;

        yield* service.sweep;
        assert.deepStrictEqual(sentMessages, []);
        const [pending] = yield* service.listLog({ managerId: manager.id });
        assert.isNull(pending!.deliveredAt);

        yield* service.sweep;
        assert.strictEqual(sentMessages.length, 1);
        assert.include(sentMessages[0]!.text, "#1 Ticket 1");
        const [delivered] = yield* service.listLog({ managerId: manager.id });
        assert.strictEqual(delivered!.sequence, pending!.sequence);
        assert.isNotNull(delivered!.deliveredAt);
      }),
    ),
  );

  it.effect("stalls a paused manager's lead without waking the manager", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, threadRuns, sentMessages } = factory;
        boards.push(
          board([
            { number: 1, columnId: READY },
            { number: 2, columnId: READY },
          ]),
        );
        const manager = yield* activeManager(service);
        yield* startTicket(factory, manager.threadId!);
        yield* service.pauseManager({
          requestId: "pause-1",
          managerId: manager.id,
          scope: "manager",
        });
        threadRuns.set(ThreadId.make("lead-1"), failedRun);

        yield* service.sweep;
        assert.strictEqual(
          (yield* service.assignmentForThread(ThreadId.make("lead-1")))!.state,
          "stalled",
        );
        assert.deepStrictEqual(yield* logKinds(service, manager.id), ["pickup", "stalled"]);
        assert.deepStrictEqual(sentMessages, []);
      }),
    ),
  );

  it.effect("writes no pickup wake while every slot is taken", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, sentMessages } = factory;
        boards.push(
          board([
            { number: 1, columnId: READY },
            { number: 2, columnId: READY },
          ]),
        );
        const manager = yield* activeManager(service);
        yield* startTicket(factory, manager.threadId!);

        yield* service.sweep;
        assert.deepStrictEqual(yield* logKinds(service, manager.id), ["pickup"]);
        assert.deepStrictEqual(sentMessages, []);
      }),
    ),
  );
});
