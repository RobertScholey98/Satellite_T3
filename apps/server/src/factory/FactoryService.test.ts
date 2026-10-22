import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_FACTORY_CONFIG,
  FactoryConfig,
  FactoryConfigOverride,
  FactoryOperationError,
  FactoryUpdateChecklistInput,
  IssueBoardView,
  IssueSummary,
  ModelSelection,
  ProjectId,
  ThreadId,
  type FactoryAssignmentsEvent,
  type FactoryDraftTicketInput,
  type FactoryManagersEvent,
  type FactoryOnboardingReport,
  type FactoryRole,
  type IssueAttemptsStartInput,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { parseRateTable, type RateTable } from "../usage/usagePricing.ts";
import {
  makeFactoryService,
  type FactoryDigestRequest,
  type FactoryServiceDependencies,
  type FactoryThreadActivity,
  type FactoryThreadInterrupt,
  type FactoryThreadLaunch,
  type FactoryPullRequestRef,
  type FactoryThreadMessage,
  type FactoryThreadRuns,
  type FactoryThreadTurn,
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
const decodeChecklistInput = Schema.decodeUnknownOption(FactoryUpdateChecklistInput);
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
  fileReadFailures: number;
  ticketFailures: number;
  /** What the usage rate cache holds; null when usage tracking has cached none. */
  rateTable: RateTable | null;
  /** What the text-generation model answers a digest request with. */
  summary: Effect.Effect<string, FactoryOperationError>;
}

type TicketRequest = Parameters<FactoryServiceDependencies["createTicket"]>[0];

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    yield* FactoryV1;
    const launches: FactoryThreadLaunch[] = [];
    const skillReads: Array<readonly [FactoryRole, string]> = [];
    const boards: IssueBoardView[] = [];
    const attemptStarts: IssueAttemptsStartInput[] = [];
    const sentMessages: FactoryThreadMessage[] = [];
    const interrupts: FactoryThreadInterrupt[] = [];
    const threadRuns = new Map<ThreadId, FactoryThreadRuns>();
    const threadTurns = new Map<ThreadId, ReadonlyArray<FactoryThreadTurn>>();
    const threadActivity = new Map<ThreadId, ReadonlyArray<FactoryThreadActivity>>();
    const summaryRequests: FactoryDigestRequest[] = [];
    const controls: HarnessControls = {
      sendFailures: 0,
      attemptFailures: 0,
      fileReadFailures: 0,
      ticketFailures: 0,
      rateTable: null,
      summary: Effect.sync(() => ` Digest ${summaryRequests.length}. `),
    };
    const ticketRequests: TicketRequest[] = [];
    /** Changed files by pull request number. */
    const pullRequestFiles = new Map<number, ReadonlyArray<string>>();
    const fileReads: FactoryPullRequestRef[] = [];
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
      readThreadTurns: (threadId) => Effect.sync(() => threadTurns.get(threadId) ?? []),
      readThreadActivity: (threadId) => Effect.sync(() => threadActivity.get(threadId) ?? []),
      generateSummary: (input) =>
        Effect.suspend(() => {
          summaryRequests.push(input);
          return controls.summary;
        }),
      readRateTable: Effect.sync(() => controls.rateTable),
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
      interruptThread: (input) => Effect.sync(() => void interrupts.push(input)),
      resolveBaseRef: () => Effect.succeed("trunk"),
      readPullRequestFiles: (input) =>
        Effect.suspend(() => {
          fileReads.push(input);
          if (controls.fileReadFailures === 0)
            return Effect.succeed(pullRequestFiles.get(input.number) ?? []);
          controls.fileReadFailures -= 1;
          return Effect.fail(
            new FactoryOperationError({ reason: "unavailable", message: "GitHub is down." }),
          );
        }),
      createTicket: (input) =>
        Effect.suspend(() => {
          ticketRequests.push(input);
          if (controls.ticketFailures === 0)
            return Effect.succeed(issue(100 + ticketRequests.length).ref);
          controls.ticketFailures -= 1;
          return Effect.fail(
            new FactoryOperationError({ reason: "unavailable", message: "GitHub is down." }),
          );
        }),
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
      interrupts,
      threadRuns,
      threadTurns,
      threadActivity,
      summaryRequests,
      controls,
      pullRequestFiles,
      fileReads,
      ticketRequests,
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

const SYNC_WORK = {
  title: "Rework the sync engine",
  brief: "The user asked for the sync rework.",
  completionCondition: "Sync survives a restart mid-transfer.",
  complexity: "large",
} as const;

describe("FactoryService commission", () => {
  it.effect("starts a large ticket the user asked for", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, attemptStarts } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(service);
        const work = SYNC_WORK;

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
        assert.deepStrictEqual(yield* logKinds(service, manager.id), ["commission"]);
      }),
    ),
  );

  it.effect("launches work with no ticket in its own worktree and ends it on linked merges", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, launches, attemptStarts, threadRuns } = factory;
        const manager = yield* activeManager(service);

        const assignment = yield* service.commission(manager.threadId!, SYNC_WORK);
        assert.strictEqual(assignment.source, "user");
        assert.isNull(assignment.issue);
        assert.isNull(assignment.attemptId);
        assert.strictEqual(assignment.leadThreadId, "thread-2");
        assert.deepStrictEqual(attemptStarts, []);
        const launch = launches[1]!;
        assert.strictEqual(launch.commandId, `factory-assignment:${assignment.id}`);
        assert.strictEqual(launch.threadId, "thread-2");
        assert.strictEqual(launch.title, "Factory: Rework the sync engine");
        assert.deepStrictEqual(launch.modelSelection, OPUS);
        assert.strictEqual(launch.workspace.type, "worktree");
        if (launch.workspace.type !== "worktree") return;
        assert.strictEqual(launch.workspace.baseRef, "trunk");
        assert.match(
          launch.workspace.branch ?? "",
          /^factory\/rework-the-sync-engine-[0-9a-f]{8}$/,
        );
        assert.include(launch.text, "# Assignment\n\n## Rework the sync engine");
        assert.include(launch.text, SYNC_WORK.brief);
        assert.deepStrictEqual(yield* memberRows, [
          {
            thread_id: "thread-2",
            assignment_id: assignment.id,
            role: "lead",
            parent_thread_id: manager.threadId!,
            joined: "created",
          },
        ]);

        const lead = ThreadId.make("thread-2");
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(9, false)] }));
        const claimed = yield* service.claimComplete(lead, {
          evidence: "A restart mid-transfer resumes.",
          pullRequests: [{ host: "github.com", repository: "acme/app", number: 9 }],
        });
        assert.strictEqual(claimed.state, "waiting-user");
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(9, true)] }));
        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "retro");
      }),
    ),
  );
});

/** A lead thread at rest after a completed run, with no questions or pull requests. */
const idleRun = (overrides: Partial<FactoryThreadRuns> = {}): FactoryThreadRuns => ({
  deleted: false,
  latestRunStatus: "completed",
  runInProgress: false,
  pendingRequests: 0,
  pullRequests: [],
  worktreePath: null,
  ...overrides,
});
const failedRun = idleRun({ latestRunStatus: "failed" });

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

        threadRuns.set(lead, idleRun());
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
          "Assignment Ticket 1 stalled: The lead's latest run failed. Investigate its lead thread, then call factory_recover to rebrief or replace the lead, or recommend to the user.",
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

const pullRequest = (number: number, merged: boolean, updatedAt: string | null = EPOCH) => ({
  host: "github.com",
  repository: "acme/app",
  number,
  merged,
  state: merged ? ("merged" as const) : ("open" as const),
  updatedAt,
});

const RETRO_REQUEST =
  "All pull requests for Ticket 1 are merged. Write your team retro now: what worked, what did not, what the next team should change, then call factory_retro_done.";

/** An active manager whose lead on ticket 1 runs in thread lead-1. */
const startedAssignment = (factory: Factory, tickets: ReadonlyArray<number> = [1]) =>
  Effect.gen(function* () {
    factory.boards.push(board(tickets.map((number) => ({ number, columnId: READY }))));
    const manager = yield* activeManager(factory.service);
    const assignment = (yield* startTicket(factory, manager.threadId!))!;
    return { manager, assignment, lead: ThreadId.make("lead-1") };
  });

const wakeReasons = (service: Service, managerId: string) =>
  service.listLog({ managerId }).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.kind === "wake")
        .map((entry) => entry.reason)
        .toReversed(),
    ),
  );

const activity = (text: string, at: string): FactoryThreadActivity => ({
  role: "assistant",
  text,
  at,
});

describe("FactoryService digests", () => {
  it.effect("writes a digest on the sweep once there is new activity and the interval is up", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadActivity, summaryRequests, sentMessages } = factory;
        const { assignment, lead } = yield* startedAssignment(factory);
        threadActivity.set(lead, [activity("Parser merged.", "1970-01-01T00:00:01.000Z")]);

        yield* service.sweepDigests;
        const first = (yield* service.assignmentForThread(lead))!.digest;
        assert.deepStrictEqual(first, {
          text: "Digest 1.",
          generatedAt: EPOCH,
          activityAt: "1970-01-01T00:00:01.000Z",
        });
        assert.strictEqual(summaryRequests[0]!.subject, "Ticket 1");
        assert.strictEqual(summaryRequests[0]!.cwd, "/repo");
        assert.isNull(summaryRequests[0]!.previousSummary);
        assert.include(summaryRequests[0]!.context, "lead: Parser merged.");

        // New activity inside the interval waits for the next due sweep, or a refresh.
        threadActivity.set(lead, [
          activity("Parser merged.", "1970-01-01T00:00:01.000Z"),
          activity("Tests are failing on Windows.", "1970-01-01T00:00:02.000Z"),
        ]);
        yield* service.sweepDigests;
        assert.strictEqual(summaryRequests.length, 1);

        const refreshed = yield* service.refreshDigest(assignment.id);
        assert.strictEqual(refreshed.digest?.text, "Digest 2.");
        assert.strictEqual(refreshed.digest?.activityAt, "1970-01-01T00:00:02.000Z");
        assert.strictEqual(summaryRequests[1]!.previousSummary, "Digest 1.");
        assert.notInclude(summaryRequests[1]!.context, "Parser merged.");
        assert.include(summaryRequests[1]!.context, "Tests are failing on Windows.");

        // Past the interval with nothing new, the sweep leaves it alone.
        yield* TestClock.adjust("11 minutes");
        yield* service.sweepDigests;
        assert.strictEqual(summaryRequests.length, 2);
        const sentBefore = sentMessages.length;
        yield* service.refreshDigest(assignment.id);
        assert.strictEqual(summaryRequests.length, 2);
        assert.strictEqual(sentMessages.length, sentBefore);
      }),
    ),
  );

  it.effect("keeps the previous digest when generation fails", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadActivity, summaryRequests, controls } = factory;
        const { assignment, lead } = yield* startedAssignment(factory);
        threadActivity.set(lead, [activity("Parser merged.", "1970-01-01T00:00:01.000Z")]);
        controls.summary = Effect.fail(
          new FactoryOperationError({ reason: "unavailable", message: "Provider is offline." }),
        );

        const refreshed = yield* service.refreshDigest(assignment.id);
        assert.isNull(refreshed.digest);
        assert.strictEqual(summaryRequests.length, 1);
      }),
    ),
  );

  it.effect("generates once while a refresh for the assignment is in flight", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadActivity, summaryRequests, controls } = factory;
        const { assignment, lead } = yield* startedAssignment(factory);
        threadActivity.set(lead, [activity("Parser merged.", "1970-01-01T00:00:01.000Z")]);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        controls.summary = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("The parser landed."),
        );

        const first = yield* service.refreshDigest(assignment.id).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        assert.isNull((yield* service.refreshDigest(assignment.id)).digest);
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual((yield* Fiber.join(first)).digest?.text, "The parser landed.");
        assert.strictEqual(summaryRequests.length, 1);
      }),
    ),
  );
});

describe("FactoryService completion claims", () => {
  it.effect("starts the retro when every pull request is merged and asks the lead for it", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns, sentMessages } = factory;
        const { manager, lead } = yield* startedAssignment(factory);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, true)] }));

        const claimed = yield* service.claimComplete(lead, {
          evidence: "pnpm test passes; the empty list renders.",
          pullRequests: [{ host: "GitHub.com", repository: "Acme/App", number: 7 }],
        });
        assert.strictEqual(claimed.state, "retro");
        assert.deepStrictEqual(claimed.claim!.pullRequests, [
          { host: "github.com", repository: "acme/app", number: 7 },
        ]);
        assert.strictEqual(claimed.claim!.evidence, "pnpm test passes; the empty list renders.");
        assert.deepStrictEqual(yield* logKinds(service, manager.id), ["pickup", "claim", "wake"]);
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id), ["retro"]);
        assert.deepStrictEqual(
          sentMessages.map((message) => [message.threadId, message.text]),
          [[lead, RETRO_REQUEST]],
        );
        assert.isTrue((yield* service.status(manager.id)).capacityFree);
      }),
    ),
  );

  it.effect("waits on the user's review until a later sync sees the pull request merged", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns, sentMessages } = factory;
        const { manager, lead } = yield* startedAssignment(factory);
        threadRuns.set(
          lead,
          idleRun({ pullRequests: [pullRequest(7, false), pullRequest(8, true)] }),
        );

        const claimed = yield* service.claimComplete(lead, {
          evidence: "Checks pass.",
          pullRequests: [{ host: "github.com", repository: "acme/app", number: 7 }],
        });
        assert.strictEqual(claimed.state, "waiting-user");
        assert.strictEqual(claimed.waitingReason, "Pull requests await the user's review: #7.");
        assert.strictEqual((yield* service.listManagers({}))[0]!.waitingOnYou, 1);
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id), []);

        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "waiting-user");

        threadRuns.set(
          lead,
          idleRun({ pullRequests: [pullRequest(7, true), pullRequest(8, true)] }),
        );
        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "retro");
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id), ["retro"]);
        assert.deepStrictEqual(
          sentMessages.map((message) => message.text),
          [RETRO_REQUEST],
        );
      }),
    ),
  );

  it.effect(
    "refuses a claimed pull request the thread has not linked, and ignores closed ones",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeFactory;
          const { service, threadRuns } = factory;
          const { manager, lead } = yield* startedAssignment(factory);
          threadRuns.set(
            lead,
            idleRun({
              pullRequests: [pullRequest(7, true), { ...pullRequest(8, false), state: "closed" }],
            }),
          );

          const unlinked = yield* service
            .claimComplete(lead, {
              evidence: "Checks pass.",
              pullRequests: [
                { host: "github.com", repository: "acme/app", number: 7 },
                { host: "github.com", repository: "acme/app", number: 9 },
              ],
            })
            .pipe(Effect.flip);
          assert.strictEqual(unlinked.reason, "invalid");
          assert.strictEqual(unlinked.message, "Link #9 to this thread before claiming.");
          assert.isNull((yield* service.assignmentForThread(lead))!.claim);
          assert.deepStrictEqual(yield* logKinds(service, manager.id), ["pickup"]);

          const claimed = yield* service.claimComplete(lead, {
            evidence: "Checks pass.",
            pullRequests: [{ host: "github.com", repository: "acme/app", number: 7 }],
          });
          assert.strictEqual(claimed.state, "retro");
        }),
      ),
  );
});

describe("FactoryService dependencies", () => {
  it.effect("blocks on a reported dependency until the assignment delivering it completes", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, sentMessages } = factory;
        const { manager, assignment, lead } = yield* startedAssignment(factory, [1, 2]);

        const stranger = yield* service
          .reportDependency(manager.threadId!, {
            title: "Expose the sync cursor",
            brief: "Add the cursor to GET /sync.",
            unblockCondition: "GET /sync returns the cursor",
          })
          .pipe(Effect.flip);
        assert.strictEqual(stranger.reason, "not-found");
        assert.strictEqual(stranger.message, "This thread is not a factory lead.");

        const dependency = yield* service.reportDependency(lead, {
          title: "Expose the sync cursor",
          brief: "Add the cursor to GET /sync.",
          unblockCondition: "GET /sync returns the cursor",
        });
        assert.strictEqual(dependency.state, "open");
        assert.strictEqual(dependency.blockedAssignmentId, assignment.id);
        assert.isNull(dependency.deliveringAssignmentId);
        const blocked = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(blocked.state, "blocked");
        assert.deepStrictEqual(blocked.dependencies, [dependency]);
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id), ["dependency"]);

        yield* service.sweep;
        assert.include(
          sentMessages[0]!.text,
          `Assignment Ticket 1 is blocked on Expose the sync cursor: GET /sync returns the cursor. Commission it with factory_commission (dependencyId ${dependency.id}) or tell the lead how to proceed.`,
        );
        assert.include(sentMessages[0]!.text, "Add the cursor to GET /sync.");

        // The blocked assignment fills the only slot; its delivery starts anyway.
        assert.isFalse((yield* service.status(manager.id)).capacityFree);
        const delivering = yield* service.commission(manager.threadId!, {
          title: "Sync cursor endpoint",
          brief: "Add the cursor to GET /sync.",
          completionCondition: "GET /sync returns the cursor.",
          complexity: "small",
          issueNumber: 2,
          dependencyId: dependency.id,
        });
        assert.strictEqual(delivering.source, "dependency");
        const stillBlocked = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(stillBlocked.state, "blocked");
        assert.strictEqual(stillBlocked.dependencies[0]!.deliveringAssignmentId, delivering.id);

        yield* service.claimComplete(ThreadId.make("lead-2"), { evidence: "Endpoint shipped." });
        yield* service.retroDone(ThreadId.make("lead-2"));
        const completed = yield* service.complete(manager.threadId!, {
          assignmentId: delivering.id,
          teamVerdict: { fit: "good", reason: "Small team, quick turnaround." },
        });
        assert.strictEqual(completed.state, "completed");

        const unblocked = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(unblocked.state, "active");
        assert.isNull(unblocked.waitingReason);
        assert.strictEqual(unblocked.dependencies[0]!.state, "delivered");
        const last = sentMessages.at(-1)!;
        assert.strictEqual(last.threadId, lead);
        assert.strictEqual(
          last.text,
          "Expose the sync cursor is done (Sync cursor endpoint). Confirm it unblocks you and continue.",
        );
      }),
    ),
  );
});

describe("FactoryService recovery", () => {
  it.effect("rebriefs a stalled lead, then hands it to the user once the allowance is spent", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns, sentMessages } = factory;
        const { manager, assignment, lead } = yield* startedAssignment(factory);
        threadRuns.set(lead, failedRun);
        yield* service.reconcileThread(lead);

        const recovered = yield* service.recover(manager.threadId!, {
          assignmentId: assignment.id,
          action: "rebrief",
          brief: "Use the fixture in tests/empty-list and retry.",
        });
        assert.strictEqual(recovered.state, "active");
        assert.strictEqual(recovered.recoveryUsed, 1);
        assert.isNull(recovered.waitingReason);
        assert.deepStrictEqual(
          sentMessages.map((message) => [message.threadId, message.text]),
          [[lead, "Use the fixture in tests/empty-list and retry."]],
        );

        const notStalled = yield* service
          .recover(manager.threadId!, {
            assignmentId: assignment.id,
            action: "rebrief",
            brief: "x",
          })
          .pipe(Effect.flip);
        assert.strictEqual(notStalled.reason, "conflict");

        yield* service.reconcileThread(lead);
        const spent = yield* service.recover(manager.threadId!, {
          assignmentId: assignment.id,
          action: "rebrief",
          brief: "Split the work in two.",
        });
        assert.strictEqual(spent.state, "waiting-user");
        assert.strictEqual(
          spent.waitingReason,
          "Recovery allowance used; the manager recommends: Split the work in two.",
        );
        assert.strictEqual(spent.recoveryUsed, 1);
        assert.strictEqual(sentMessages.length, 1);
        assert.deepStrictEqual(yield* logKinds(service, manager.id), [
          "pickup",
          "stalled",
          "wake",
          "recovery",
          "stalled",
          "wake",
          "recovery",
        ]);
      }),
    ),
  );

  it.effect("replaces a stalled lead with a new one in the same worktree and branch", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns, attemptStarts, launches } = factory;
        const { manager, assignment, lead } = yield* startedAssignment(factory);
        threadRuns.set(lead, failedRun);
        yield* service.reconcileThread(lead);
        const replace = {
          assignmentId: assignment.id,
          action: "replace",
          brief: "The last lead looped on flaky tests; quarantine them first.",
        } as const;

        const noWorktree = yield* service.recover(manager.threadId!, replace).pipe(Effect.flip);
        assert.strictEqual(noWorktree.reason, "invalid");
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "stalled");

        threadRuns.set(lead, { ...failedRun, worktreePath: "/repo/.worktrees/issue-1" });
        const replaced = yield* service.recover(manager.threadId!, replace);
        assert.strictEqual(replaced.state, "active");
        assert.strictEqual(replaced.recoveryUsed, 1);
        assert.strictEqual(replaced.leadThreadId, "thread-2");
        assert.strictEqual(replaced.attemptId, "attempt-1");
        assert.strictEqual(attemptStarts.length, 1);
        const launch = launches[1]!;
        assert.strictEqual(launch.commandId, `factory-assignment:${assignment.id}:recovery-1`);
        assert.strictEqual(launch.threadId, "thread-2");
        assert.deepStrictEqual(launch.workspace, {
          type: "existing_worktree",
          worktreePath: "/repo/.worktrees/issue-1",
          branch: "factory/issue-1",
        });
        assert.include(launch.text, START.brief);
        assert.include(launch.text, "## Recovery brief");
        assert.include(
          launch.text,
          "The ticket's board moves are tracked on the original lead's thread, lead-1, not this one.",
        );
        assert.include(launch.text, "The last lead looped on flaky tests; quarantine them first.");

        const sql = yield* SqlClient.SqlClient;
        const members = yield* sql<{ thread_id: string; ended: number }>`
            SELECT thread_id, ended_at IS NOT NULL AS ended FROM factory_members ORDER BY created_at, thread_id`;
        assert.deepStrictEqual(
          members.map((member) => [member.thread_id, member.ended]),
          [
            ["lead-1", 1],
            ["thread-2", 0],
          ],
        );
        const oldLead = yield* service.claimComplete(lead, { evidence: "Done." }).pipe(Effect.flip);
        assert.strictEqual(oldLead.reason, "not-found");
      }),
    ),
  );
});

describe("FactoryService completion", () => {
  it.effect("completes an assignment only from its retro, with the team verdict", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service } = factory;
        const { manager, assignment, lead } = yield* startedAssignment(factory);
        const verdict = { fit: "poor", reason: "Too many reviewers for a one-line fix." } as const;

        const early = yield* service
          .complete(manager.threadId!, { assignmentId: assignment.id, teamVerdict: verdict })
          .pipe(Effect.flip);
        assert.strictEqual(early.reason, "conflict");

        yield* service.claimComplete(lead, { evidence: "Fixed without a pull request." });
        yield* service.retroDone(lead);
        const completed = yield* service.complete(manager.threadId!, {
          assignmentId: assignment.id,
          teamVerdict: verdict,
        });
        assert.strictEqual(completed.state, "completed");
        assert.deepStrictEqual(completed.teamVerdict, verdict);
        assert.isNotNull(completed.endedAt);
        assert.deepStrictEqual(yield* service.listAssignments({}), []);
        assert.strictEqual((yield* logKinds(service, manager.id)).at(-1), "complete");
      }),
    ),
  );

  it.effect("cancels into the lead's retro, interrupts the lead and ends cancelled", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, interrupts, sentMessages } = factory;
        const { manager, assignment, lead } = yield* startedAssignment(factory);
        const input = {
          requestId: "cancel-1",
          assignmentId: assignment.id,
          reason: "The ticket was descoped",
        };

        const cancelled = yield* service.cancel(input);
        assert.strictEqual(cancelled.state, "retro");
        assert.strictEqual(cancelled.cancelReason, "The ticket was descoped");
        assert.deepStrictEqual(
          interrupts.map((interrupt) => [interrupt.threadId, interrupt.commandId]),
          [[lead, "factory-cancel:cancel-1"]],
        );
        assert.strictEqual(
          sentMessages[0]!.text,
          "The user cancelled Ticket 1: The ticket was descoped. Stop the work. Write your team retro now: what worked, what did not, what the next team should change, then call factory_retro_done.",
        );
        const [wake] = yield* service.listLog({ managerId: manager.id });
        assert.strictEqual(wake!.reason, "retro");
        assert.deepStrictEqual(wake!.payload, {
          title: "Ticket 1",
          assignmentId: assignment.id,
          cancelReason: "The ticket was descoped",
        });

        assert.deepStrictEqual(yield* service.cancel(input), cancelled);
        assert.strictEqual(interrupts.length, 1);

        yield* service.retroDone(lead);
        const [managerRetro] = yield* service.listLog({ managerId: manager.id });
        assert.deepStrictEqual(managerRetro!.payload, {
          assignmentId: assignment.id,
          title: "Ticket 1",
          cancelled: true,
        });

        const ended = yield* service.complete(manager.threadId!, {
          assignmentId: assignment.id,
          teamVerdict: { fit: "good", reason: "Stopped cleanly." },
        });
        assert.strictEqual(ended.state, "cancelled");
      }),
    ),
  );
});

describe("FactoryService takeover", () => {
  it.effect("leaves a taken-over lead to the user and wakes the manager on hand back", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns, sentMessages } = factory;
        const { manager, lead } = yield* startedAssignment(factory);

        const stranger = yield* service
          .takeOver({ requestId: "take-0", threadId: manager.threadId! })
          .pipe(Effect.flip);
        assert.strictEqual(stranger.reason, "not-found");

        const taken = yield* service.takeOver({ requestId: "take-1", threadId: lead });
        assert.isTrue(taken.takenOver);
        const refused = yield* service.claimComplete(lead, { evidence: "Done." }).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "conflict");
        assert.strictEqual(refused.message, "The user has taken over this thread.");

        threadRuns.set(lead, failedRun);
        yield* service.sweep;
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "stalled");
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id), []);
        assert.deepStrictEqual(sentMessages, []);

        const handedBack = yield* service.handBack({ requestId: "hand-1", threadId: lead });
        assert.isFalse(handedBack.takenOver);
        yield* service.sweep;
        assert.deepStrictEqual(
          sentMessages.map((message) => message.text),
          ["The user handed back Ticket 1; it is now stalled. Check its thread for what changed."],
        );
        assert.deepStrictEqual(yield* logKinds(service, manager.id), [
          "pickup",
          "takeover",
          "stalled",
          "handback",
          "wake",
        ]);
      }),
    ),
  );
});

describe("FactoryService questions", () => {
  it.effect("waits on the user while the lead has an open request, and never stalls then", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns, sentMessages } = factory;
        const { manager, lead } = yield* startedAssignment(factory);

        threadRuns.set(lead, idleRun({ latestRunStatus: "interrupted", pendingRequests: 1 }));
        yield* service.reconcileThread(lead);
        const waiting = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(waiting.state, "waiting-user");
        assert.strictEqual(waiting.waitingReason, "The lead is waiting on the user.");

        yield* service.sweep;
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "waiting-user");

        threadRuns.set(lead, idleRun({ latestRunStatus: "running", runInProgress: true }));
        yield* service.reconcileThread(lead);
        const resumed = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(resumed.state, "active");
        assert.isNull(resumed.waitingReason);
        assert.deepStrictEqual(yield* logKinds(service, manager.id), ["pickup"]);
        assert.deepStrictEqual(sentMessages, []);
      }),
    ),
  );
});

describe("FactoryService project pause", () => {
  it.effect("interrupts every lead when the user pauses the project, and stalls none", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns, interrupts } = factory;
        const { manager, lead } = yield* startedAssignment(factory);

        yield* service.pauseManager({
          requestId: "pause-1",
          managerId: manager.id,
          scope: "manager",
        });
        assert.deepStrictEqual(interrupts, []);

        yield* service.pauseManager({
          requestId: "pause-2",
          managerId: manager.id,
          scope: "project",
        });
        assert.deepStrictEqual(
          interrupts.map((interrupt) => [interrupt.threadId, interrupt.commandId]),
          [[lead, `factory-pause:pause-2:${lead}`]],
        );

        threadRuns.set(lead, idleRun({ latestRunStatus: "interrupted" }));
        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "active");
      }),
    ),
  );
});

/** A Duo preset: one implementer on two models, and one reviewer on the role's model. */
const DUO = {
  id: "preset-duo",
  name: "Duo",
  useWhen: "Small changes worth a second look.",
  members: [
    { role: "implementer" as const, count: 1, models: [SONNET, OPUS] },
    { role: "reviewer" as const, count: 1 },
  ],
  workflow: "Implement, then review before the pull request.",
  createdBy: "user" as const,
};

const TEAM_FACTORY = decodeConfig({
  pickupGuidance: "Small, well-specified bugs.",
  concurrencyCap: 2,
  modelPool: [OPUS, SONNET],
  roleModels: { manager: OPUS, lead: { small: SONNET }, workers: { reviewer: [SONNET] } },
  teamPresets: [DUO],
});

const makeTeamFactory = makeHarness({ config: TEAM_FACTORY });

/** An active manager whose Duo team works ticket 1 from lead thread lead-1. */
const startedTeam = (factory: Factory) =>
  Effect.gen(function* () {
    factory.boards.push(board([{ number: 1, columnId: READY }]));
    const manager = yield* activeManager(factory.service);
    const assignment = (yield* factory.service.pickup(manager.threadId!, {
      ...START,
      issueNumber: 1,
      team: { preset: "Duo", members: [] },
    }))!;
    return { manager, assignment, lead: ThreadId.make("lead-1") };
  });

const workspace = (service: Service) =>
  service.subscribeWorkspace({}).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((feeds) => feeds[0]!),
  );

describe("FactoryService teams", () => {
  it.effect("staffs a named preset's members and gives the lead the preset's workflow", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { assignment } = yield* startedTeam(factory);

        assert.deepStrictEqual(assignment.team, { preset: "Duo", members: DUO.members });
        assert.include(
          factory.attemptStarts[0]!.prompt,
          "# Team\n\nPreset Duo: 1 × implementer (claude/claude-sonnet-5, claude/claude-opus-5-5), 1 × reviewer\n\nImplement, then review before the pull request.",
        );
      }),
    ),
  );

  it.effect(
    "adds a manager's preset to the environment, refusing duplicates and other models",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeTeamFactory;
          const { service } = factory;
          const manager = yield* activeManager(service);
          const trio = {
            name: "Trio",
            useWhen: "Risky migrations.",
            members: [{ role: "implementer" as const, count: 2, models: [OPUS] }],
            workflow: "Two implementers split the work.",
          };

          const created = yield* service.createTeam(manager.threadId!, trio);
          assert.strictEqual(created.createdBy, "manager");
          assert.deepStrictEqual({ ...created, id: "" }, { ...trio, id: "", createdBy: "manager" });
          const environment = (yield* service.getConfig({})).environment;
          assert.deepStrictEqual(environment.teamPresets, [DUO, created]);
          const [team] = yield* service.listLog({ managerId: manager.id });
          assert.strictEqual(team!.kind, "team");
          assert.strictEqual(team!.reason, "Trio");

          const duplicate = yield* service
            .createTeam(manager.threadId!, { ...trio, name: "Duo" })
            .pipe(Effect.flip);
          assert.strictEqual(duplicate.reason, "conflict");
          const outside = yield* service
            .createTeam(manager.threadId!, {
              ...trio,
              name: "Codex pair",
              members: [{ role: "reviewer", count: 1, models: [GPT] }],
            })
            .pipe(Effect.flip);
          assert.strictEqual(outside.reason, "invalid");
          assert.include(outside.message, "gpt-6");
          assert.strictEqual((yield* service.getConfig({})).environment.teamPresets.length, 2);
        }),
      ),
  );
});

describe("FactoryService delegation", () => {
  it.effect("plans a worker the team has room for, on a model the member allows", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service } = factory;
        const { assignment, lead } = yield* startedTeam(factory);

        const verifier = yield* service
          .planDelegation(lead, { role: "verifier", task: "Run the checks." })
          .pipe(Effect.flip);
        assert.strictEqual(verifier.reason, "invalid");
        const offList = yield* service
          .planDelegation(lead, { role: "reviewer", task: "Review it.", modelSelection: OPUS })
          .pipe(Effect.flip);
        assert.strictEqual(offList.reason, "invalid");

        const plan = yield* service.planDelegation(lead, {
          role: "implementer",
          task: "Guard the empty list in List.tsx.",
        });
        assert.strictEqual(plan.role, "implementer");
        assert.strictEqual(plan.title, "Implementer: Ticket 1");
        assert.deepStrictEqual(plan.modelSelection, SONNET);
        assert.deepStrictEqual(plan.allowedModels, [SONNET, OPUS]);
        for (const heading of [
          "# Implementer",
          "## What you hand back",
          "## Sub-agents and models",
        ])
          assert.include(plan.task, heading);
        assert.include(plan.task, "- claude/claude-sonnet-5\n- claude/claude-opus-5-5");
        assert.include(plan.task, START.completionCondition);
        assert.include(plan.task, "- AGENTS.md");
        assert.isTrue(plan.task.endsWith("\n\n# Task\n\nGuard the empty list in List.tsx."));
        assert.notInclude(plan.task, "{{");

        const reviewer = yield* service.planDelegation(lead, {
          role: "reviewer",
          task: "Review it.",
          title: "Review the guard",
        });
        assert.strictEqual(reviewer.title, "Review the guard");
        assert.deepStrictEqual(reviewer.allowedModels, [SONNET]);
        assert.deepStrictEqual(yield* memberRows, [
          {
            thread_id: "lead-1",
            assignment_id: assignment.id,
            role: "lead",
            parent_thread_id: "thread-1",
            joined: "created",
          },
        ]);

        const member = yield* service.recordMember(lead, {
          threadId: ThreadId.make("worker-1"),
          role: "implementer",
          modelSelection: plan.modelSelection,
          joined: "created",
        });
        assert.deepStrictEqual(member, {
          threadId: ThreadId.make("worker-1"),
          managerId: assignment.managerId,
          assignmentId: assignment.id,
          role: "implementer",
          parentThreadId: lead,
          joined: "created",
          takenOver: false,
          offPool: false,
          endedAt: null,
        });
        assert.deepStrictEqual(
          (yield* workspace(service)).members.map((row) => row.threadId),
          ["lead-1", "worker-1"],
        );

        const busy = yield* service
          .planDelegation(lead, { role: "implementer", task: "Another change." })
          .pipe(Effect.flip);
        assert.strictEqual(busy.reason, "conflict");
        assert.strictEqual(busy.message, "The team allows 1 implementer and all are busy.");
      }),
    ),
  );
});

describe("FactoryService observed threads", () => {
  it.effect("joins a member's sub-agent to its team and wakes the manager off the pool", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, sentMessages } = factory;
        const { manager, assignment, lead } = yield* startedTeam(factory);
        yield* service.recordMember(lead, {
          threadId: ThreadId.make("worker-1"),
          role: "reviewer",
          modelSelection: SONNET,
          joined: "created",
        });

        yield* service.observeThread({
          threadId: ThreadId.make("sub-1"),
          parentThreadId: lead,
          modelSelection: SONNET,
        });
        yield* service.observeThread({
          threadId: ThreadId.make("sub-2"),
          parentThreadId: ThreadId.make("worker-1"),
          modelSelection: GPT,
        });
        yield* service.observeThread({
          threadId: ThreadId.make("sub-3"),
          parentThreadId: ThreadId.make("stranger"),
          modelSelection: GPT,
        });
        yield* service.observeThread({
          threadId: ThreadId.make("sub-4"),
          parentThreadId: null,
          modelSelection: GPT,
        });

        const members = (yield* workspace(service)).members;
        assert.deepStrictEqual(
          members.map((member): ReadonlyArray<unknown> => [
            member.threadId,
            member.role,
            member.parentThreadId,
            member.joined,
            member.offPool,
          ]),
          [
            ["lead-1", "lead", "thread-1", "created", false],
            ["worker-1", "reviewer", "lead-1", "created", false],
            ["sub-1", "implementer", "lead-1", "observed", false],
            ["sub-2", "reviewer", "worker-1", "observed", true],
          ],
        );
        const [wake] = yield* service.listLog({ managerId: manager.id });
        assert.strictEqual(wake!.kind, "wake");
        assert.strictEqual(wake!.reason, "off-pool");
        assert.deepStrictEqual(wake!.payload, {
          threadId: "sub-2",
          assignmentId: assignment.id,
          title: "Ticket 1",
          model: "codex/gpt-6",
        });

        yield* service.sweep;
        assert.deepStrictEqual(
          sentMessages.map((message) => message.text),
          [
            "Thread sub-2 under Ticket 1 runs codex/gpt-6, which is outside the pool. Tell the lead to stop it or ask the user to add the model.",
          ],
        );
      }),
    ),
  );
});

describe("FactoryService checklist", () => {
  it.effect("replaces the lead's checklist and shows it in the workspace feed", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service } = factory;
        const { assignment, lead } = yield* startedTeam(factory);
        assert.deepStrictEqual(assignment.checklist, []);
        assert.isNull(assignment.digest);

        yield* service.updateChecklist(lead, {
          steps: [{ text: "Reproduce the crash", state: "in-progress" }],
        });
        const steps = [
          { text: "Reproduce the crash", state: "done" },
          { text: "Guard the empty list", state: "not-started" },
        ] as const;
        const updated = yield* service.updateChecklist(lead, { steps: [...steps] });
        assert.deepStrictEqual(updated.checklist, steps);

        const feed = yield* workspace(service);
        assert.deepStrictEqual(feed.assignments, [
          {
            id: assignment.id,
            managerId: assignment.managerId,
            title: "Ticket 1",
            state: "active",
            source: "ticket",
            complexity: "small",
            team: "Duo",
            leadThreadId: lead,
            checklist: steps,
            digest: null,
            waitingReason: null,
          },
        ]);
        assert.strictEqual(feed.managers[0]!.waitingOnYou, 0);
        assert.deepStrictEqual(yield* logKinds(service, assignment.managerId), ["pickup"]);

        const tooLong = Array.from({ length: 21 }, (_, index) => ({
          text: `Step ${index}`,
          state: "not-started",
        }));
        assert.isTrue(Option.isNone(decodeChecklistInput({ steps: tooLong })));
      }),
    ),
  );
});

const PROTECTED_FILES = ["src/list.tsx", "apps/web/AGENTS.md", ".satellite/factory/roles/lead.md"];

describe("FactoryService control paths", () => {
  it.effect("holds a pull request that touches protected paths until a new push clears it", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, fileReads, sentMessages } = factory;
        const { manager, lead } = yield* startedTeam(factory);
        pullRequestFiles.set(7, PROTECTED_FILES);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));

        yield* service.reconcileThread(lead);
        const held = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(held.state, "waiting-user");
        assert.strictEqual(
          held.waitingReason,
          "Pull request #7 changes protected paths: apps/web/AGENTS.md, .satellite/factory/roles/lead.md.",
        );
        assert.deepStrictEqual(held.controlViolations, [
          {
            pullRequest: { host: "github.com", repository: "acme/app", number: 7 },
            paths: ["apps/web/AGENTS.md", ".satellite/factory/roles/lead.md"],
          },
        ]);
        assert.deepStrictEqual(fileReads, [
          { projectId: PROJECT_ID, host: "github.com", repository: "acme/app", number: 7 },
        ]);
        const leadText =
          "Pull request #7 changes protected paths (apps/web/AGENTS.md, .satellite/factory/roles/lead.md). Revert those changes; the factory cannot send this to the user as ready.";
        assert.deepStrictEqual(
          sentMessages.map((message) => [message.threadId, message.text]),
          [[lead, leadText]],
        );
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id), ["control"]);

        // A claim waits behind the protected paths rather than going to the user's review.
        const claimed = yield* service.claimComplete(lead, {
          evidence: "Tests pass.",
          pullRequests: [{ host: "github.com", repository: "acme/app", number: 7 }],
        });
        assert.strictEqual(claimed.state, "waiting-user");
        assert.strictEqual(claimed.waitingReason, held.waitingReason);

        yield* service.reconcileThread(lead);
        assert.strictEqual(fileReads.length, 1);

        yield* service.sweep;
        assert.strictEqual(sentMessages.at(-1)!.threadId, manager.threadId);
        assert.strictEqual(sentMessages.at(-1)!.text, `Assignment Ticket 1: ${leadText}`);

        pullRequestFiles.set(7, ["src/list.tsx"]);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-2")] }));
        yield* service.reconcileThread(lead);
        const cleared = (yield* service.assignmentForThread(lead))!;
        assert.deepStrictEqual(cleared.controlViolations, []);
        assert.strictEqual(cleared.state, "waiting-user");
        assert.strictEqual(cleared.waitingReason, "Pull requests await the user's review: #7.");
      }),
    ),
  );

  it.effect("returns an unclaimed assignment to work once its pull request is clean", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles } = factory;
        const { lead } = yield* startedTeam(factory);
        pullRequestFiles.set(7, PROTECTED_FILES);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "waiting-user");

        pullRequestFiles.set(7, []);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-2")] }));
        yield* service.reconcileThread(lead);
        const active = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(active.state, "active");
        assert.isNull(active.waitingReason);
        assert.deepStrictEqual(active.controlViolations, []);
      }),
    ),
  );

  it.effect("leaves a pull request unchecked when its files cannot be read", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, fileReads, sentMessages, controls } =
          factory;
        const { manager, lead } = yield* startedTeam(factory);
        pullRequestFiles.set(7, PROTECTED_FILES);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        controls.fileReadFailures = 1;

        yield* service.reconcileThread(lead);
        const unchanged = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(unchanged.state, "active");
        assert.deepStrictEqual(unchanged.controlViolations, []);
        assert.deepStrictEqual(sentMessages, []);
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id), []);

        yield* service.reconcileThread(lead);
        assert.strictEqual(fileReads.length, 2);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "waiting-user");
      }),
    ),
  );
});

describe("FactoryService findings", () => {
  it.effect(
    "records findings from a worker and the lead, and wakes the manager on escalation",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeTeamFactory;
          const { service, sentMessages } = factory;
          const { manager, assignment, lead } = yield* startedTeam(factory);
          const worker = ThreadId.make("worker-1");
          yield* service.recordMember(lead, {
            threadId: worker,
            role: "implementer",
            modelSelection: SONNET,
            joined: "created",
          });

          const fromWorker = yield* service.recordFinding(worker, {
            class: "reusable",
            summary: "The list fixture is copied in three suites",
            evidence: "a.test.ts, b.test.ts and c.test.ts each build it.",
          });
          assert.strictEqual(fromWorker.assignmentId, assignment.id);
          assert.strictEqual(fromWorker.threadId, worker);
          assert.isFalse(fromWorker.escalated);
          assert.isNull(fromWorker.uncertainty);
          assert.isNull(fromWorker.draftId);
          assert.deepStrictEqual(yield* wakeReasons(service, manager.id), []);

          const fromLead = yield* service.recordFinding(lead, {
            class: "project",
            summary: "CI skips the e2e suite on forks",
            evidence: "The workflow's e2e job has `if: github.repository == 'acme/app'`.",
            workaround: "Run it locally.",
            escalate: true,
          });
          assert.isTrue(fromLead.escalated);
          assert.strictEqual(fromLead.workaround, "Run it locally.");
          assert.deepStrictEqual(yield* wakeReasons(service, manager.id), ["finding"]);
          const [wake] = yield* service.listLog({ managerId: manager.id });
          assert.deepStrictEqual(wake!.payload, {
            assignmentId: assignment.id,
            title: "Ticket 1",
            findingId: fromLead.id,
            summary: "CI skips the e2e suite on forks",
          });
          assert.deepStrictEqual(
            (yield* logKinds(service, manager.id)).filter((kind) => kind === "finding"),
            ["finding", "finding"],
          );

          yield* service.sweep;
          const woken = sentMessages.at(-1)!;
          assert.strictEqual(woken.threadId, manager.threadId);
          assert.include(
            woken.text,
            "Finding escalated on Ticket 1: CI skips the e2e suite on forks. Read it with factory_status or factory_findings and decide.",
          );

          assert.deepStrictEqual(
            (yield* service.listFindings({ assignmentId: assignment.id })).map(
              (finding) => finding.id,
            ),
            [fromWorker.id, fromLead.id],
          );
          const stranger = yield* service
            .recordFinding(manager.threadId!, {
              class: "uncertain",
              summary: "Not a member",
              evidence: "The manager is not on the team.",
            })
            .pipe(Effect.flip);
          assert.strictEqual(stranger.reason, "not-found");
        }),
      ),
  );
});

describe("FactoryService retro", () => {
  it.effect(
    "wakes the manager for its retro once the team retro is done, and completes after",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeFactory;
          const { service, sentMessages } = factory;
          const { manager, assignment, lead } = yield* startedAssignment(factory);
          const verdict = { fit: "good", reason: "One implementer was enough." } as const;

          const tooEarly = yield* service.retroDone(lead).pipe(Effect.flip);
          assert.strictEqual(tooEarly.reason, "conflict");

          yield* service.claimComplete(lead, { evidence: "Fixed without a pull request." });
          const beforeRetro = yield* service
            .complete(manager.threadId!, { assignmentId: assignment.id, teamVerdict: verdict })
            .pipe(Effect.flip);
          assert.strictEqual(beforeRetro.reason, "conflict");
          assert.strictEqual(beforeRetro.message, "The team retro has not finished.");

          const done = yield* service.retroDone(lead);
          assert.strictEqual(done.state, "retro");
          assert.isNotNull(done.retro.teamDoneAt);
          assert.isNull(done.retro.managerDoneAt);
          assert.deepStrictEqual(yield* wakeReasons(service, manager.id), [
            "retro",
            "manager-retro",
          ]);
          const [wake] = yield* service.listLog({ managerId: manager.id });
          assert.deepStrictEqual(wake!.payload, {
            assignmentId: assignment.id,
            title: "Ticket 1",
            cancelled: false,
          });
          assert.strictEqual((yield* service.retroDone(lead).pipe(Effect.flip)).reason, "conflict");

          yield* service.sweep;
          assert.include(
            sentMessages.at(-1)!.text,
            `The team retro for Ticket 1 is done. Do the manager retro: read its findings, draft tickets with factory_draft_ticket (scope project or factory), judge the team fit, then call factory_complete for assignment ${assignment.id}.`,
          );

          const completed = yield* service.complete(manager.threadId!, {
            assignmentId: assignment.id,
            teamVerdict: verdict,
          });
          assert.strictEqual(completed.state, "completed");
          assert.isNotNull(completed.retro.managerDoneAt);
        }),
      ),
  );
});

/** A board whose tickets carry the given titles and sit in the given columns. */
const titledBoard = (
  items: ReadonlyArray<{
    readonly number: number;
    readonly columnId: string;
    readonly title: string;
  }>,
): IssueBoardView => {
  const view = board(items);
  return {
    ...view,
    items: view.items.map((item, index) => ({
      ...item,
      issue: { ...item.issue, title: items[index]!.title },
    })),
  };
};

const DRAFT = {
  scope: "project",
  body: "The e2e suite never renders an empty list.",
  acceptanceCriteria: ["An e2e test renders an empty list", "It runs in CI"],
} as const;

describe("FactoryService ticket drafts", () => {
  it.effect(
    "stores a draft with its findings and returns overlapping drafts and open tickets",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeFactory;
          const { service } = factory;
          factory.boards.push(
            titledBoard([
              { number: 1, columnId: READY, title: "Crash on an empty list" },
              {
                number: 2,
                columnId: IN_PROGRESS,
                title: "Share the list fixture across test suites",
              },
              { number: 3, columnId: "column-done", title: "Share the list fixture across suites" },
              { number: 4, columnId: IN_PROGRESS, title: "Upgrade the date library" },
            ]),
          );
          const manager = yield* activeManager(service);
          const assignment = (yield* startTicket(factory, manager.threadId!))!;
          const lead = ThreadId.make("lead-1");
          yield* service.claimComplete(lead, { evidence: "Fixed without a pull request." });
          const finding = yield* service.recordFinding(lead, {
            class: "reusable",
            summary: "The list fixture is copied in three suites",
            evidence: "a.test.ts, b.test.ts and c.test.ts each build it.",
          });

          const earlier = yield* service.draftTicket(manager.threadId!, {
            ...DRAFT,
            title: "Share the list fixture between test suites",
          });
          const { draft, similar } = yield* service.draftTicket(manager.threadId!, {
            ...DRAFT,
            title: "Share the list fixture across all test suites",
            findingIds: [finding.id, finding.id],
          });
          assert.strictEqual(draft.state, "pending");
          assert.strictEqual(draft.scope, "project");
          assert.strictEqual(draft.assignmentId, assignment.id);
          assert.deepStrictEqual(draft.findingIds, [finding.id]);
          assert.deepStrictEqual(draft.acceptanceCriteria, DRAFT.acceptanceCriteria);
          assert.isNull(draft.issue);
          assert.isNull(draft.proposedChange);
          assert.strictEqual(
            (yield* service.listFindings({ assignmentId: assignment.id }))[0]!.draftId,
            draft.id,
          );
          assert.deepStrictEqual(similar, [
            {
              kind: "ticket",
              id: "issue-node-2",
              title: "Share the list fixture across test suites",
              url: "https://github.com/acme/app/issues/2",
            },
            {
              kind: "draft",
              id: earlier.draft.id,
              title: "Share the list fixture between test suites",
              url: null,
            },
          ]);
          assert.strictEqual((yield* logKinds(service, manager.id)).at(-1), "draft");

          const unknown = yield* service
            .draftTicket(manager.threadId!, { ...DRAFT, title: "Other", findingIds: ["missing"] })
            .pipe(Effect.flip);
          assert.strictEqual(unknown.reason, "invalid");

          const event = yield* service.subscribeDrafts({}).pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map((events) => events[0]!),
          );
          assert.deepStrictEqual(
            event.drafts.map((entry) => entry.id),
            [earlier.draft.id, draft.id],
          );
        }),
      ),
  );

  it.effect("files a project draft's ticket once, and keeps it pending when filing fails", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, controls, ticketRequests } = factory;
        const { manager, lead } = yield* startedAssignment(factory);
        const mapped = factory.boards[0]!;
        factory.boards.unshift({
          ...mapped,
          board: { ...mapped.board, id: "board-unmapped", mapping: null },
        });
        yield* service.claimComplete(lead, { evidence: "Fixed without a pull request." });
        const { draft } = yield* service.draftTicket(manager.threadId!, {
          ...DRAFT,
          title: "Cover the empty list in e2e",
        });

        controls.ticketFailures = 1;
        const failed = yield* service
          .approveDraft({ requestId: "approve-1", draftId: draft.id })
          .pipe(Effect.flip);
        assert.strictEqual(failed.reason, "unavailable");
        assert.strictEqual((yield* service.listDrafts({}))[0]!.state, "pending");

        const approved = yield* service.approveDraft({ requestId: "approve-2", draftId: draft.id });
        assert.strictEqual(approved.state, "approved");
        assert.deepStrictEqual(approved.issue, issue(102).ref);
        const request = {
          projectId: PROJECT_ID,
          cwd: "/repo",
          board: mapped.board,
          marker: `satellite-factory-draft:${draft.id}`,
          title: "Cover the empty list in e2e",
          body: "The e2e suite never renders an empty list.\n\n## Acceptance criteria\n- An e2e test renders an empty list\n- It runs in CI\n\nFiled by the Satellite factory from assignment Ticket 1",
        };
        assert.deepStrictEqual(ticketRequests, [request, request]);
        const [ticketLog] = yield* service.listLog({ managerId: manager.id });
        assert.strictEqual(ticketLog!.kind, "ticket");
        assert.deepStrictEqual(ticketLog!.payload, { draftId: draft.id, issue: issue(102).ref });

        assert.deepStrictEqual(
          yield* service.approveDraft({ requestId: "approve-2", draftId: draft.id }),
          approved,
        );
        assert.strictEqual(ticketRequests.length, 2);
        const edit = yield* service
          .editDraft({ requestId: "edit-1", draftId: draft.id, title: "Too late" })
          .pipe(Effect.flip);
        assert.strictEqual(edit.reason, "conflict");
      }),
    ),
  );

  it.effect("refuses to file a project draft with no mapped board", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, ticketRequests } = factory;
        const manager = yield* activeManager(service);
        const { draft } = yield* service.draftTicket(manager.threadId!, {
          ...DRAFT,
          title: "Cover the empty list in e2e",
        });
        const refused = yield* service
          .approveDraft({ requestId: "approve-1", draftId: draft.id })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "unavailable");
        assert.strictEqual(refused.message, "Connect an issue board with a Ready column first.");
        assert.deepStrictEqual(ticketRequests, []);
      }),
    ),
  );

  it.effect(
    "accepts a factory draft with no ticket, and dismisses and restores a pending one",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeFactory;
          const { service, ticketRequests } = factory;
          const manager = yield* activeManager(service);
          yield* service.pauseManager({
            requestId: "pause-1",
            managerId: manager.id,
            scope: "manager",
          });
          const proposedChange = {
            kind: "setting",
            key: "concurrencyCap",
            before: 1,
            after: 2,
          } as const;

          const { draft: factoryDraft } = yield* service.draftTicket(manager.threadId!, {
            scope: "factory",
            title: "Raise the concurrency cap",
            body: "Two small tickets waited a day for the only slot.",
            acceptanceCriteria: [],
            proposedChange,
          });
          assert.isNull(factoryDraft.assignmentId);
          assert.deepStrictEqual(factoryDraft.proposedChange, proposedChange);
          const accepted = yield* service.approveDraft({
            requestId: "approve-factory",
            draftId: factoryDraft.id,
          });
          assert.strictEqual(accepted.state, "approved");
          assert.isNull(accepted.issue);
          assert.deepStrictEqual(ticketRequests, []);
          const [accept] = yield* service.listLog({ managerId: manager.id });
          assert.strictEqual(accept!.kind, "ticket");
          assert.strictEqual(accept!.reason, "factory draft accepted");

          const { draft } = yield* service.draftTicket(manager.threadId!, {
            ...DRAFT,
            title: "Document the release steps",
          });
          const dismissed = yield* service.dismissDraft({
            requestId: "dismiss-1",
            draftId: draft.id,
          });
          assert.strictEqual(dismissed.state, "dismissed");
          assert.deepStrictEqual(
            yield* service.dismissDraft({ requestId: "dismiss-1", draftId: draft.id }),
            dismissed,
          );
          for (const refused of [
            service.dismissDraft({ requestId: "dismiss-2", draftId: draft.id }),
            service.approveDraft({ requestId: "approve-1", draftId: draft.id }),
            // A request id names one operation, even with the same payload shape.
            service.restoreDraft({ requestId: "dismiss-1", draftId: draft.id }),
          ])
            assert.strictEqual((yield* refused.pipe(Effect.flip)).reason, "conflict");

          const restored = yield* service.restoreDraft({
            requestId: "restore-1",
            draftId: draft.id,
          });
          assert.strictEqual(restored.state, "pending");
          const edited = yield* service.editDraft({
            requestId: "edit-1",
            draftId: draft.id,
            title: "Document the release checklist",
          });
          assert.strictEqual(edited.title, "Document the release checklist");
          assert.strictEqual(edited.body, DRAFT.body);
          assert.deepStrictEqual(
            (yield* service.listDrafts({ state: "pending" })).map((entry) => entry.id),
            [draft.id],
          );
        }),
      ),
  );
});

describe("FactoryService applied drafts", () => {
  const draftChange = (
    factory: Factory,
    threadId: ThreadId,
    proposedChange: FactoryDraftTicketInput["proposedChange"],
  ) =>
    factory.service.draftTicket(threadId, {
      scope: "factory",
      title: "Change the factory",
      body: "The retro found the factory setup in the way.",
      acceptanceCriteria: [],
      ...(proposedChange === undefined ? {} : { proposedChange }),
    });

  it.effect("applies a setting change to the environment config and accepts the draft", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service } = factory;
        const manager = yield* activeManager(service);
        const { draft } = yield* draftChange(factory, manager.threadId!, {
          kind: "setting",
          key: "concurrencyCap",
          before: 1,
          after: 2,
        });

        const applied = yield* service.applyDraft({ requestId: "apply-1", draftId: draft.id });
        assert.strictEqual(applied.state, "approved");
        assert.strictEqual((yield* service.getConfig({})).environment.concurrencyCap, 2);
        const [entry] = yield* service.listLog({ managerId: manager.id });
        assert.strictEqual(entry!.reason, "factory change applied");
        assert.deepStrictEqual(
          yield* service.applyDraft({ requestId: "apply-1", draftId: draft.id }),
          applied,
        );
      }),
    ),
  );

  it.effect("refuses a setting that changed since the retro, naming its current value", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service } = factory;
        const manager = yield* activeManager(service);
        const { draft } = yield* draftChange(factory, manager.threadId!, {
          kind: "setting",
          key: "concurrencyCap",
          before: 1,
          after: 2,
        });
        yield* service.updateConfig({
          scope: "environment",
          config: { ...FACTORY, concurrencyCap: 3 },
        });

        const refused = yield* service
          .applyDraft({ requestId: "apply-1", draftId: draft.id })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "conflict");
        assert.include(refused.message, "now 3");
        assert.strictEqual((yield* service.getConfig({})).environment.concurrencyCap, 3);
        const [pending] = yield* service.listDrafts({ state: "pending" });
        assert.strictEqual(pending!.id, draft.id);
      }),
    ),
  );

  it.effect("adds a proposed new preset, and refuses it once a preset has that name", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service } = factory;
        const manager = yield* activeManager(service);
        const trio = preset("Trio", "implement, review, verify");
        const { draft } = yield* draftChange(factory, manager.threadId!, {
          kind: "preset",
          before: null,
          after: trio,
        });
        const { draft: again } = yield* draftChange(factory, manager.threadId!, {
          kind: "preset",
          before: null,
          after: { ...trio, id: "preset-trio-2" },
        });

        yield* service.applyDraft({ requestId: "apply-1", draftId: draft.id });
        assert.deepStrictEqual((yield* service.getConfig({})).environment.teamPresets, [trio]);
        const refused = yield* service
          .applyDraft({ requestId: "apply-2", draftId: again.id })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "conflict");
        assert.include(refused.message, "Trio");
      }),
    ),
  );
});

const VERDICT = { fit: "good", reason: "The team fit the work." } as const;

/** Claims ticket 1 with nothing open, so the assignment goes straight to its retro. */
const toRetro = (factory: Factory, lead: ThreadId) =>
  factory.service.claimComplete(lead, { evidence: "Fixed without a pull request." });

describe("FactoryService skipped team retro", () => {
  it.effect("completes without the team retro only once the lead's thread is gone", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns } = factory;
        const { manager, assignment, lead } = yield* startedAssignment(factory);
        yield* toRetro(factory, lead);
        const skip = {
          assignmentId: assignment.id,
          teamVerdict: VERDICT,
          teamRetro: "skipped",
        } as const;

        threadRuns.set(lead, idleRun());
        const alive = yield* service.complete(manager.threadId!, skip).pipe(Effect.flip);
        assert.deepInclude(alive, {
          reason: "conflict",
          message: "The lead is still active; wait for its team retro or cancel the assignment.",
        });

        threadRuns.set(lead, idleRun({ deleted: true }));
        const unasked = yield* service
          .complete(manager.threadId!, { assignmentId: assignment.id, teamVerdict: VERDICT })
          .pipe(Effect.flip);
        assert.strictEqual(unasked.message, "The team retro has not finished.");

        const completed = yield* service.complete(manager.threadId!, skip);
        assert.strictEqual(completed.state, "completed");
        assert.isNull(completed.retro.teamDoneAt);
        const [entry] = yield* service.listLog({ managerId: manager.id });
        assert.deepStrictEqual(entry!.payload, {
          outcome: "completed",
          teamVerdict: VERDICT,
          teamRetro: "skipped",
        });
      }),
    ),
  );

  it.effect("skips the retro of a deleted lead on sweep and wakes the manager for its own", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns, sentMessages } = factory;
        const { manager, assignment, lead } = yield* startedAssignment(factory);
        yield* toRetro(factory, lead);
        threadRuns.set(lead, idleRun({ deleted: true }));

        yield* service.sweep;
        const retro = (yield* service.listAssignments({})).find(
          (entry) => entry.id === assignment.id,
        );
        assert.isNotNull(retro!.retro.teamDoneAt);
        const entries = yield* service.listLog({ managerId: manager.id });
        assert.deepInclude(
          entries.map((entry) => [entry.kind, entry.reason]),
          ["retro", "team retro skipped: lead thread deleted"],
        );
        assert.include(
          sentMessages.at(-1)!.text,
          `The lead's thread for Ticket 1 was deleted before its team retro. Do the manager retro:`,
        );

        yield* service.sweep;
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id), ["retro", "manager-retro"]);
        const completed = yield* service.complete(manager.threadId!, {
          assignmentId: assignment.id,
          teamVerdict: VERDICT,
        });
        assert.strictEqual(completed.state, "completed");
      }),
    ),
  );
});

const waitingRow = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ waiting_user_ms: number; waiting_since: string | null }>`
        SELECT waiting_user_ms,waiting_since FROM factory_assignments WHERE id=${id}`;
    return rows[0]!;
  });

/** A turn that ran from `startSecond` for `seconds`, with the given tokens. */
const turn = (
  model: string,
  startSecond: number,
  seconds: number,
  tokens: FactoryThreadTurn["tokens"],
): FactoryThreadTurn => ({
  model,
  instanceId: "claude",
  startedAt: DateTime.formatIso(DateTime.makeUnsafe(startSecond * 1000)),
  completedAt: DateTime.formatIso(DateTime.makeUnsafe((startSecond + seconds) * 1000)),
  tokens,
});

describe("FactoryService stats", () => {
  it.effect("accrues the time an assignment waits on the user", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, threadRuns } = factory;
        const { assignment, lead } = yield* startedAssignment(factory);

        threadRuns.set(lead, idleRun({ pendingRequests: 1 }));
        yield* service.reconcileThread(lead);
        assert.deepStrictEqual(yield* waitingRow(assignment.id), {
          waiting_user_ms: 0,
          waiting_since: EPOCH,
        });

        yield* TestClock.adjust("5 minutes");
        threadRuns.set(lead, idleRun());
        yield* service.reconcileThread(lead);
        assert.deepStrictEqual(yield* waitingRow(assignment.id), {
          waiting_user_ms: 300_000,
          waiting_since: null,
        });
      }),
    ),
  );

  it.effect("rolls the lead's and workers' turns into one row when the assignment ends", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, threadTurns, controls } = factory;
        const { manager, assignment, lead } = yield* startedTeam(factory);
        const worker = ThreadId.make("worker-1");
        const reviewer = ThreadId.make("reviewer-1");
        yield* service.recordMember(lead, {
          threadId: worker,
          role: "implementer",
          modelSelection: SONNET,
          joined: "created",
        });
        yield* service.recordMember(lead, {
          threadId: reviewer,
          role: "reviewer",
          modelSelection: SONNET,
          joined: "created",
        });
        // Only Sonnet is priced; GPT is unknown to the table, so its tokens count but cost nothing.
        controls.rateTable = parseRateTable({
          [SONNET.model]: {
            input_cost_per_token: 0.000002,
            output_cost_per_token: 0.00001,
            cache_read_input_token_cost: 0.0000002,
          },
        });
        threadTurns.set(lead, [
          turn(SONNET.model, 0, 60, { input: 1000, cachedInput: 400, output: 200 }),
          turn(SONNET.model, 60, 30, null),
          { ...turn(SONNET.model, 90, 0, null), startedAt: null },
        ]);
        threadTurns.set(worker, [
          turn(GPT.model, 10, 30, { input: 500, cachedInput: 0, output: 100 }),
        ]);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, true)] }));
        threadRuns.set(
          worker,
          idleRun({ pullRequests: [pullRequest(7, true), pullRequest(8, true)] }),
        );

        yield* service.claimComplete(lead, {
          evidence: "pnpm test passes.",
          pullRequests: [{ host: "github.com", repository: "acme/app", number: 7 }],
        });
        yield* service.retroDone(lead);
        yield* TestClock.adjust("10 minutes");
        yield* service.complete(manager.threadId!, {
          assignmentId: assignment.id,
          teamVerdict: VERDICT,
        });

        const { teams, assignments } = yield* service.getStats({});
        assert.strictEqual(assignments.length, 1);
        const { costUsd, byModel, ...stats } = assignments[0]!;
        assert.deepStrictEqual(stats, {
          assignmentId: assignment.id,
          managerId: manager.id,
          projectId: PROJECT_ID,
          team: "Duo",
          complexity: "small",
          outcome: "completed",
          teamVerdict: "good",
          tokens: { input: 1500, cachedInput: 400, output: 300 },
          agentMs: 120_000,
          wallMs: 600_000,
          waitingUserMs: 0,
          recoveries: 0,
          pullRequests: 2,
          reviewRounds: 1,
          byRole: [
            {
              role: "lead",
              tokens: { input: 1000, cachedInput: 400, output: 200 },
              agentMs: 90_000,
            },
            {
              role: "implementer",
              tokens: { input: 500, cachedInput: 0, output: 100 },
              agentMs: 30_000,
            },
          ],
          endedAt: "1970-01-01T00:10:00.000Z",
        });
        // 600 uncached input, 400 cached and 200 output tokens at Sonnet's rates.
        const sonnetCost = 600 * 0.000002 + 400 * 0.0000002 + 200 * 0.00001;
        assert.closeTo(costUsd!, sonnetCost, 1e-12);
        assert.deepStrictEqual(
          byModel.map(({ costUsd: _cost, ...entry }) => entry),
          [
            {
              model: SONNET.model,
              tokens: { input: 1000, cachedInput: 400, output: 200 },
              agentMs: 90_000,
            },
            {
              model: GPT.model,
              tokens: { input: 500, cachedInput: 0, output: 100 },
              agentMs: 30_000,
            },
          ],
        );
        assert.closeTo(byModel[0]!.costUsd!, sonnetCost, 1e-12);
        assert.isNull(byModel[1]!.costUsd);
        assert.deepStrictEqual(
          teams.map((team) => [team.team, team.tasks, team.goodFit]),
          [["Duo", 1, 1]],
        );
      }),
    ),
  );

  it.effect("groups ended assignments by team with medians and means, filtered", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service } = yield* makeFactory;
        const sql = yield* SqlClient.SqlClient;
        const insert = (
          id: string,
          values: {
            readonly team?: string;
            readonly projectId?: string;
            readonly outcome?: string;
            readonly verdict: string | null;
            readonly tokens: number;
            readonly cost: number | null;
            readonly agentMs: number;
            readonly recoveries: number;
            readonly reviewRounds: number;
            readonly endedAt: string;
          },
        ) =>
          sql`INSERT INTO factory_assignment_stats(assignment_id,manager_id,project_id,team,
              complexity,outcome,team_verdict,input_tokens,cached_input_tokens,output_tokens,
              cost_usd,agent_ms,wall_ms,waiting_user_ms,recoveries,pull_requests,review_rounds,
              by_role_json,by_model_json,ended_at)
              VALUES(${id},'manager-1',${values.projectId ?? PROJECT_ID},${values.team ?? "Duo"},
              'small',${values.outcome ?? "completed"},${values.verdict},${values.tokens - 10},0,10,
              ${values.cost},${values.agentMs},${values.agentMs * 2},0,${values.recoveries},1,
              ${values.reviewRounds},'[]','[]',${values.endedAt})`;
        yield* insert("a", {
          verdict: "good",
          tokens: 100,
          cost: 1,
          agentMs: 10,
          recoveries: 0,
          reviewRounds: 1,
          endedAt: "2026-10-01T09:00:00.000Z",
        });
        yield* insert("b", {
          outcome: "cancelled",
          verdict: "poor",
          tokens: 300,
          cost: null,
          agentMs: 30,
          recoveries: 1,
          reviewRounds: 1,
          endedAt: "2026-10-02T09:00:00.000Z",
        });
        yield* insert("c", {
          verdict: null,
          tokens: 200,
          cost: 3,
          agentMs: 20,
          recoveries: 2,
          reviewRounds: 4,
          endedAt: "2026-10-03T09:00:00.000Z",
        });
        yield* insert("d", {
          team: "Solo",
          projectId: "project-2",
          verdict: "good",
          tokens: 50,
          cost: 5,
          agentMs: 5,
          recoveries: 0,
          reviewRounds: 0,
          endedAt: "2026-10-04T09:00:00.000Z",
        });

        const all = yield* service.getStats({});
        assert.deepStrictEqual(
          all.assignments.map((entry) => entry.assignmentId),
          ["d", "c", "b", "a"],
        );
        assert.deepStrictEqual(
          all.teams.map((team) => team.team),
          ["Duo", "Solo"],
        );

        const project = yield* service.getStats({ projectId: PROJECT_ID });
        assert.deepStrictEqual(project.teams, [
          {
            team: "Duo",
            tasks: 3,
            completed: 2,
            cancelled: 1,
            medianTokens: 200,
            // Only a and c have a cost, so the median is the mean of the two.
            medianCostUsd: 2,
            medianAgentMs: 20,
            medianWallMs: 40,
            meanRecoveries: 1,
            meanReviewRounds: 2,
            goodFit: 1,
            poorFit: 1,
          },
        ]);

        const recent = yield* service.getStats({ projectId: PROJECT_ID, sinceDay: "2026-10-02" });
        assert.deepInclude(recent.teams[0]!, {
          tasks: 2,
          medianTokens: 250,
          medianCostUsd: 3,
          medianAgentMs: 25,
          meanReviewRounds: 2.5,
        });
        assert.deepStrictEqual((yield* service.getStats({ complexity: "large" })).teams, []);
      }),
    ),
  );
});
