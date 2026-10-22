import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_FACTORY_CONFIG,
  FactoryConfig,
  FactoryConfigOverride,
  FactoryOperationError,
  ModelSelection,
  ProjectId,
  ThreadId,
  type FactoryManagersEvent,
  type FactoryOnboardingReport,
  type FactoryRole,
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

import { makeFactoryService, type FactoryThreadLaunch } from "./FactoryService.ts";
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

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    yield* FactoryV1;
    const launches: FactoryThreadLaunch[] = [];
    const skillReads: Array<readonly [FactoryRole, string]> = [];
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
    });
    if (options.config)
      yield* service.updateConfig({ scope: "environment", config: options.config });
    return { service, launches, skillReads };
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
      VALUES('assignment-1',${managerId},${PROJECT_ID},'title','brief','done','manual','small',
        ${state},'[]',${EPOCH},${EPOCH})`;
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
