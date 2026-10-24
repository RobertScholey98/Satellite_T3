import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_FACTORY_CONFIG,
  FactoryConfigOverride,
  FactoryOperationError,
  FactoryUpdateChecklistInput,
  IssueBoardView,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignmentsEvent,
  type FactoryDraftTicketInput,
  type FactoryManager,
  type FactoryManagerDefinition,
  type FactoryManagersEvent,
  type FactoryOnboardingResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { parseRateTable } from "../usage/usagePricing.ts";
import type { FactoryThreadActivity, FactoryThreadTurn } from "./FactoryService.ts";
import * as FactoryConfigStore from "./config/FactoryConfigStore.ts";
import { projectSection } from "./roleSkills.ts";
import { ONBOARDING_BRIEF } from "./roles/index.ts";
import {
  PROJECT_ID,
  EPOCH,
  OPUS,
  SONNET,
  GPT,
  decodeConfig,
  preset,
  ENVIRONMENT,
  withDatabase,
  refOf,
  ANY_MODEL,
  BACKLOG,
  READY,
  IN_PROGRESS,
  issue,
  board,
  makeHarness,
  makeService,
  makeManagerService,
  PROPOSAL,
  RESULT,
  create,
  managerRowCount,
  FACTORY,
  SONNET_LEAD,
  makeFactory,
  type Factory,
  approve,
  activeManager,
  START,
  startTicket,
  logKinds,
  logMark,
  setupDone,
  memberRows,
  SYNC_WORK,
  idleRun,
  failedRun,
  pullRequest,
  startedAssignment,
  wakeReasons,
  TEAM_FACTORY,
  DUO_TEAM,
  makeTeamFactory,
  startedTeam,
  STANDARD_TEAM,
  DEFAULT_LEAD,
  CATALOG,
  workspace,
  VERDICT,
  asLegacyTeam,
} from "./FactoryService.testkit.ts";

const UNKNOWN_PROJECT_ID = ProjectId.make("project-missing");
const decodeChecklistInput = Schema.decodeUnknownOption(FactoryUpdateChecklistInput);
const decodeOverride = Schema.decodeSync(FactoryConfigOverride);

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

  it.effect("reads a config stored while pickup guidance still lived in it", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeService;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO factory_config(scope_key,config_json,updated_at) VALUES
          ('environment','{"pickupGuidance":"Only bugs.","concurrencyCap":4}',${EPOCH}),
          (${`project:${PROJECT_ID}`},'{"pickupGuidance":"Only docs.","concurrencyCap":1}',${EPOCH})`;

        const view = yield* service.getConfig({ projectId: PROJECT_ID });
        assert.strictEqual(view.environment.concurrencyCap, 4);
        assert.deepStrictEqual(view.override, { concurrencyCap: 1 });
        assert.notProperty(view.effective, "pickupGuidance");
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
          concurrencyCap: 1,
          teamPresets: [preset("Solo", "project")],
        });
        const saved = yield* service.updateConfig({
          scope: "project",
          projectId: PROJECT_ID,
          override,
        });
        assert.deepStrictEqual(saved.override, override);
        assert.deepStrictEqual(saved.environment, ENVIRONMENT);
        const { concurrencyCap, teamPresets, ...inherited } = saved.effective;
        const { concurrencyCap: _, teamPresets: __, ...environmentRest } = ENVIRONMENT;
        assert.strictEqual(concurrencyCap, 1);
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
        const { service, launches } = yield* makeHarness({ config: ENVIRONMENT });

        const created = yield* create(service);
        assert.strictEqual(created.state, "onboarding");
        assert.strictEqual(created.projectId, PROJECT_ID);
        assert.strictEqual(created.name, "Ada");
        assert.include(
          launches.map((launch) => launch.threadId),
          created.threadId,
        );
        assert.strictEqual(created.activeAssignments, 0);
        assert.strictEqual(created.waitingOnYou, 0);

        assert.deepStrictEqual(yield* create(service), created);
        assert.strictEqual(yield* managerRowCount, 1);

        const reused = yield* create(service, "create-1", "Grace").pipe(Effect.flip);
        assert.strictEqual(reused.reason, "conflict");

        assert.strictEqual(yield* managerRowCount, 1);
      }),
    ),
  );

  it.effect("creates a second manager in a project that already has one", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeManagerService;

        const ada = yield* create(service, "create-1", "Ada");
        const grace = yield* create(service, "create-2", "Grace");
        assert.strictEqual(grace.projectId, PROJECT_ID);
        assert.strictEqual(grace.state, "onboarding");
        assert.notStrictEqual(grace.id, ada.id);
        assert.notStrictEqual(grace.threadId, ada.threadId);
        assert.deepStrictEqual(
          (yield* service.listManagers({ projectId: PROJECT_ID }))
            .map((manager) => manager.name)
            .toSorted(),
          ["Ada", "Grace"],
        );
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
        const factory = yield* makeFactory;
        const { service } = factory;
        const { id: managerId } = yield* activeManager(factory);

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

  it.effect("says the saved config was not migrated when that is why the pool is empty", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, configStore, launches } = yield* makeHarness();
        yield* configStore.recordMigrationFailure("The saved factory config could not be read.");

        const refused = yield* create(service).pipe(Effect.flip);
        assert.deepInclude(refused, {
          reason: "invalid",
          message: FactoryConfigStore.unmigratedConfigMessage(
            "The saved factory config could not be read.",
          ),
        });
        assert.strictEqual(yield* managerRowCount, 0);
        assert.deepStrictEqual(launches, []);
      }),
    ),
  );

  it.effect("launches the manager's thread with its skill, the pool and the onboarding brief", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, launches, skillReads } = yield* makeHarness({
          config: decodeConfig({ modelPool: [OPUS, SONNET] }),
          // The manager definition's first model, ahead of the pool's.
          definitions: {
            managers: [
              {
                id: "default",
                name: "Default manager",
                models: { dynamic: false, models: [refOf(SONNET)] },
                instructions: "",
              },
            ],
          },
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
        assert.notInclude(launch.text, "# Project");
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
  it.effect("stores the proposal with the boards and default branch Satellite reads itself", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, boards, controls } = yield* makeHarness({ config: ENVIRONMENT });
        boards.push(
          board(
            [
              { number: 1, columnId: READY, labels: ["ui", "bug"] },
              { number: 2, columnId: BACKLOG, labels: ["bug"] },
            ],
            [READY, BACKLOG],
          ),
        );
        const created = yield* create(service);
        const threadId = created.threadId!;

        const stranger = yield* service
          .proposeOnboarding(ThreadId.make("thread-other"), PROPOSAL)
          .pipe(Effect.flip);
        assert.strictEqual(stranger.reason, "not-found");
        assert.isNull(yield* service.managerForThread(ThreadId.make("thread-other")));

        const proposed = yield* service.proposeOnboarding(threadId, PROPOSAL);
        assert.strictEqual(proposed.state, "onboarding");
        assert.isNull(proposed.onboardingResult);
        const { detected, proposedAt: _, ...submitted } = proposed.onboardingProposal!;
        assert.deepStrictEqual(submitted, PROPOSAL);
        // Ready columns come in the board's order, so Backlog shows up before Ready.
        assert.deepStrictEqual(detected.boards, [
          {
            boardId: "board-1",
            title: "Roadmap",
            readyColumns: [
              { id: BACKLOG, title: "Backlog" },
              { id: READY, title: "Ready" },
            ],
            labels: ["bug", "ui"],
          },
        ]);
        assert.strictEqual(detected.defaultBranch, "trunk");
        assert.deepStrictEqual(yield* service.managerForThread(threadId), proposed);

        const status = yield* service.status(created.id);
        assert.isFalse(status.pickupEnabled);
        assert.strictEqual(status.pickupGuidance, "");
        assert.deepStrictEqual(status.readyTickets, []);

        controls.defaultBranch = null;
        const revised = yield* service.proposeOnboarding(threadId, PROPOSAL);
        assert.isNull(revised.onboardingProposal!.detected.defaultBranch);
      }),
    ),
  );

  it.effect("refuses a question whose recommendation is not an option, or a repeated id", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* makeManagerService;
        const created = yield* create(service);
        const threadId = created.threadId!;
        const question = PROPOSAL.rules[0]!;

        const outOfRange = yield* service
          .proposeOnboarding(threadId, { ...PROPOSAL, rules: [{ ...question, recommended: 2 }] })
          .pipe(Effect.flip);
        assert.strictEqual(outOfRange.reason, "invalid");
        assert.include(outOfRange.message, `"small-tickets" recommends option 2`);

        const repeated = yield* service
          .proposeOnboarding(threadId, {
            ...PROPOSAL,
            rules: [question, { ...question, question: "Which tickets are urgent?" }],
          })
          .pipe(Effect.flip);
        assert.strictEqual(repeated.reason, "invalid");
        assert.include(repeated.message, `share the id "small-tickets"`);
        assert.isNull((yield* service.managerForThread(threadId))!.onboardingProposal);
      }),
    ),
  );

  it.effect("approves a result that answers every question, then drops the proposal", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, boards } = yield* makeHarness({ config: ENVIRONMENT });
        boards.push(board([]));
        const { id: managerId, threadId } = yield* create(service);
        const approve = (requestId: string, result: FactoryOnboardingResult = RESULT) =>
          service.approveOnboarding({ requestId, managerId, result });

        const early = yield* approve("approve-0").pipe(Effect.flip);
        assert.strictEqual(early.reason, "conflict");

        yield* service.proposeOnboarding(threadId!, PROPOSAL);
        yield* service.pauseManager({ requestId: "pause-1", managerId, scope: "manager" });
        const paused = yield* approve("approve-1").pipe(Effect.flip);
        assert.strictEqual(paused.reason, "conflict");
        assert.include(paused.message, "Resume");
        yield* service.resumeManager({ requestId: "resume-1", managerId });

        const unanswered = yield* approve("approve-2", { ...RESULT, rules: [] }).pipe(Effect.flip);
        assert.strictEqual(unanswered.reason, "invalid");
        assert.include(unanswered.message, "Which tickets count as small?");
        const unasked = yield* approve("approve-3", {
          ...RESULT,
          rules: [...RESULT.rules, { id: "deploys", question: "Who deploys?", answer: "CI" }],
        }).pipe(Effect.flip);
        assert.strictEqual(unasked.reason, "invalid");
        assert.include(unasked.message, `"deploys"`);
        const twice = yield* approve("approve-4", {
          ...RESULT,
          rules: [...RESULT.rules, ...RESULT.rules],
        }).pipe(Effect.flip);
        assert.strictEqual(twice.reason, "invalid");
        assert.include(twice.message, "more than once");

        // A rule keeps the question the manager asked, whatever wording the client sends.
        const reworded = {
          ...RESULT,
          rules: [{ ...RESULT.rules[0]!, question: "Is anything small?" }],
        };
        const approved = yield* approve("approve-5", reworded);
        assert.strictEqual(approved.state, "ready");
        assert.deepStrictEqual(approved.onboardingResult, RESULT);
        assert.isNull(approved.onboardingProposal);
        assert.deepStrictEqual(yield* approve("approve-5", reworded), approved);

        const again = yield* approve("approve-6").pipe(Effect.flip);
        assert.strictEqual(again.reason, "conflict");
        const lateProposal = yield* service
          .proposeOnboarding(threadId!, PROPOSAL)
          .pipe(Effect.flip);
        assert.deepInclude(lateProposal, {
          reason: "not-found",
          message: "This thread's onboarding is finished; the manager now runs in a new thread.",
        });
      }),
    ),
  );

  it.effect("approves pickup only from columns that are Ready on a connected board now", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, boards } = yield* makeHarness({ config: ENVIRONMENT });
        boards.push(board([], [READY, BACKLOG]));
        const { id: managerId, threadId } = yield* create(service);
        yield* service.proposeOnboarding(threadId!, PROPOSAL);
        const approve = (
          requestId: string,
          columns: FactoryOnboardingResult["pickup"]["columns"],
        ) =>
          service.approveOnboarding({
            requestId,
            managerId,
            result: { ...RESULT, pickup: { ...RESULT.pickup, columns } },
          });

        const none = yield* approve("approve-1", []).pipe(Effect.flip);
        assert.strictEqual(none.reason, "invalid");
        assert.include(none.message, "at least one Ready column");
        const inProgress = yield* approve("approve-2", [
          { boardId: "board-1", columnId: IN_PROGRESS },
        ]).pipe(Effect.flip);
        assert.strictEqual(inProgress.reason, "invalid");
        assert.strictEqual(
          inProgress.message,
          `Column ${IN_PROGRESS} is not a Ready column of Roadmap.`,
        );
        const elsewhere = yield* approve("approve-3", [
          { boardId: "board-2", columnId: READY },
        ]).pipe(Effect.flip);
        assert.include(elsewhere.message, "board-2");

        // The user narrows the board's mapping after the proposal; approval reads it as it is now.
        boards[0] = board([]);
        const backlog = yield* approve("approve-4", [
          { boardId: "board-1", columnId: BACKLOG },
        ]).pipe(Effect.flip);
        assert.strictEqual(backlog.reason, "invalid");
        assert.include(backlog.message, BACKLOG);

        // Columns stored with pickup off are checked too, so turning it on later stays safe.
        const offBacklog = yield* service
          .approveOnboarding({
            requestId: "approve-5",
            managerId,
            result: {
              ...RESULT,
              pickup: {
                ...RESULT.pickup,
                enabled: false,
                columns: [{ boardId: "board-1", columnId: BACKLOG }],
              },
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(offBacklog.reason, "invalid");
        assert.include(offBacklog.message, BACKLOG);

        const off = yield* service.approveOnboarding({
          requestId: "approve-6",
          managerId,
          result: { ...RESULT, pickup: { ...RESULT.pickup, enabled: false, columns: [] } },
        });
        assert.strictEqual(off.state, "active");
      }),
    ),
  );
});

describe("FactoryService primed manager thread", () => {
  const PRIMED_CLOSING =
    "Onboarding is done; this thread replaces the onboarding thread. Reply with exactly: Ready.";
  const FINISHED = "This thread's onboarding is finished; the manager now runs in a new thread.";
  const PICKUP_OFF = { ...RESULT, pickup: { ...RESULT.pickup, enabled: false } };

  /**
   * A manager that proposed, approved by the user with `result`; board-1 stays connected. Launches
   * from `launchesBefore` on are the approval's.
   */
  const approved = (factory: Factory, result: FactoryOnboardingResult = RESULT) =>
    Effect.gen(function* () {
      if (factory.boards.length === 0) factory.boards.push(board([]));
      const created = yield* create(factory.service);
      yield* factory.service.proposeOnboarding(created.threadId!, PROPOSAL);
      const launchesBefore = factory.launches.length;
      const manager = yield* factory.service.approveOnboarding({
        requestId: "approve-1",
        managerId: created.id,
        result,
      });
      return { created, manager, launchesBefore };
    });

  it.effect(
    "moves the manager to a new thread primed from the result, ready but not picking up",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeFactory;
          const { service, boards, launches, sentMessages, settles } = factory;
          boards.push(board([{ number: 1, columnId: READY }]));
          const { created, manager, launchesBefore } = yield* approved(factory);

          assert.strictEqual(manager.state, "ready");
          assert.notStrictEqual(manager.threadId, created.threadId);
          assert.isNull(created.onboardingThreadId);
          assert.strictEqual(manager.onboardingThreadId, created.threadId);
          assert.strictEqual(
            manager.primingMessageId,
            `message:factory-manager-primed:${manager.threadId}`,
          );
          assert.isNull(created.primingMessageId);
          const onboarding = launches.find((launch) => launch.threadId === created.threadId);
          assert.strictEqual(launches.length, launchesBefore + 1);
          const primed = launches.at(-1);
          assert.strictEqual(primed!.threadId, manager.threadId);
          assert.strictEqual(primed!.messageId, manager.primingMessageId);
          assert.strictEqual(primed!.title, "Engineering manager: Ada");
          assert.deepStrictEqual(primed!.modelSelection, onboarding!.modelSelection);
          assert.strictEqual(primed!.runtimeMode, onboarding!.runtimeMode);
          assert.deepStrictEqual(primed!.workspace, { type: "root" });
          assert.isTrue(primed!.text.startsWith("# Engineering manager"));
          assert.isTrue(
            primed!.text.endsWith(`\n\n${projectSection(RESULT)}\n\n${PRIMED_CLOSING}`),
          );
          assert.notInclude(primed!.text, ONBOARDING_BRIEF);
          assert.deepStrictEqual(settles, [created.threadId]);

          assert.strictEqual((yield* service.managerForThread(manager.threadId!))!.id, created.id);
          // The old thread is no manager's; only manager-only tools explain why.
          assert.isNull(yield* service.managerForThread(created.threadId!));
          const old = yield* startTicket(factory, created.threadId!, 1).pipe(Effect.flip);
          assert.deepInclude(old, { reason: "not-found", message: FINISHED });
          assert.strictEqual(yield* service.finishedOnboardingMessage(created.threadId!), FINISHED);
          assert.isNull(yield* service.finishedOnboardingMessage(manager.threadId!));

          // A ready manager is offered nothing and may not pick up until the user starts pickup.
          yield* service.sweep;
          assert.deepStrictEqual(sentMessages, []);
          assert.deepStrictEqual((yield* service.status(manager.id)).readyTickets, []);
          const refused = yield* startTicket(factory, manager.threadId!, 1).pipe(Effect.flip);
          assert.deepInclude(refused, {
            reason: "conflict",
            message: "Pickup has not started; the user starts it.",
          });
          // Work the user asks for still starts.
          const commissioned = yield* service.commission(manager.threadId!, SYNC_WORK);
          assert.strictEqual(commissioned.state, "active");
        }),
      ),
  );

  it.effect("makes a repeat of an approval still launching wait for its launch", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, controls, launches, boards } = factory;
        boards.push(board([]));
        const created = yield* create(service);
        yield* service.proposeOnboarding(created.threadId!, PROPOSAL);
        const launchesBefore = launches.length;
        const approve = service.approveOnboarding({
          requestId: "approve-1",
          managerId: created.id,
          result: RESULT,
        });
        const sql = yield* SqlClient.SqlClient;
        let repeat: Fiber.Fiber<FactoryManager, FactoryOperationError> | undefined;
        controls.duringLaunch = Effect.gen(function* () {
          repeat = yield* approve.pipe(Effect.forkChild);
          // Nothing is remembered while the thread launches.
          const remembered = yield* sql`SELECT 1 FROM factory_requests
              WHERE request_id='approve-1'`;
          assert.deepStrictEqual(remembered, []);
        }).pipe(Effect.orDie);

        const approved = yield* approve;
        assert.deepStrictEqual(yield* Fiber.join(repeat!), approved);
        assert.strictEqual(launches.length, launchesBefore + 1);
      }),
    ),
  );

  it.effect("keeps a pause made during a failed launch, now pausing onboarding", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, controls, boards } = factory;
        boards.push(board([]));
        const created = yield* create(service);
        const managerId = created.id;
        const proposed = yield* service.proposeOnboarding(created.threadId!, PROPOSAL);
        controls.launchFailures = 1;
        controls.duringLaunch = service
          .pauseManager({ requestId: "pause-1", managerId, scope: "manager" })
          .pipe(Effect.asVoid);
        const approve = service.approveOnboarding({
          requestId: "approve-1",
          managerId,
          result: RESULT,
        });

        const failed = yield* approve.pipe(Effect.flip);
        assert.strictEqual(failed.reason, "unavailable");
        const [paused] = yield* service.listManagers({ projectId: PROJECT_ID });
        assert.strictEqual(paused!.state, "manager-paused");
        assert.strictEqual(paused!.threadId, created.threadId);
        assert.isNull(paused!.onboardingResult);
        assert.isNull(paused!.onboardingThreadId);
        assert.deepStrictEqual(paused!.onboardingProposal, proposed.onboardingProposal);

        const resumed = yield* service.resumeManager({ requestId: "resume-1", managerId });
        assert.strictEqual(resumed.state, "onboarding");
        assert.strictEqual((yield* approve).state, "ready");
      }),
    ),
  );

  it.effect("leaves a manager retired during a failed launch retired", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, controls, boards, settles } = factory;
        boards.push(board([]));
        const created = yield* create(service);
        const managerId = created.id;
        yield* service.proposeOnboarding(created.threadId!, PROPOSAL);
        controls.launchFailures = 1;
        controls.duringLaunch = service
          .retireManager({ requestId: "retire-1", managerId })
          .pipe(Effect.asVoid);

        const failed = yield* service
          .approveOnboarding({ requestId: "approve-1", managerId, result: RESULT })
          .pipe(Effect.flip);
        assert.strictEqual(failed.reason, "unavailable");
        assert.include(failed.message, "stays retired");
        const [retired] = yield* service.listManagers({ includeRetired: true });
        assert.strictEqual(retired!.state, "retired");
        assert.strictEqual(retired!.threadId, created.threadId);
        assert.isNull(retired!.onboardingResult);
        assert.deepStrictEqual(settles, []);
      }),
    ),
  );

  it.effect("replays an approval without launching the new thread again", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { created, manager } = yield* approved(factory);
        const launchesBefore = factory.launches.length;
        const settlesBefore = factory.settles.length;

        const replayed = yield* factory.service.approveOnboarding({
          requestId: "approve-1",
          managerId: created.id,
          result: RESULT,
        });
        assert.deepStrictEqual(replayed, manager);
        assert.strictEqual(factory.launches.length, launchesBefore);
        assert.strictEqual(factory.settles.length, settlesBefore);
      }),
    ),
  );

  it.effect("leaves onboarding as it was when the new thread fails to launch", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, controls, launches, boards } = factory;
        boards.push(board([]));
        const created = yield* create(service);
        const proposed = yield* service.proposeOnboarding(created.threadId!, PROPOSAL);
        const launchesBefore = launches.length;
        controls.launchFailures = 1;
        const approve = service.approveOnboarding({
          requestId: "approve-1",
          managerId: created.id,
          result: PICKUP_OFF,
        });

        const failed = yield* approve.pipe(Effect.flip);
        assert.strictEqual(failed.reason, "unavailable");
        assert.include(failed.message, "Onboarding is unchanged");
        const restored = (yield* service.managerForThread(created.threadId!))!;
        assert.strictEqual(restored.state, "onboarding");
        assert.deepStrictEqual(restored.onboardingProposal, proposed.onboardingProposal);
        assert.isNull(restored.onboardingResult);
        assert.isNull(restored.onboardingThreadId);
        assert.deepStrictEqual(factory.settles, []);

        const retried = yield* approve;
        assert.strictEqual(retried.state, "active");
        assert.strictEqual(launches.length, launchesBefore + 2);
        assert.strictEqual(retried.threadId, launches.at(-1)!.threadId);
      }),
    ),
  );

  it.effect("approves straight to active with pickup off, and has no pickup to start", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager, launchesBefore } = yield* approved(factory, PICKUP_OFF);
        assert.strictEqual(manager.state, "active");
        assert.include(factory.launches[launchesBefore]!.text, "Pickup is off.");

        const refused = yield* factory.service
          .startPickup({ requestId: "start-1", managerId: manager.id })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "conflict");
        assert.include(refused.message, "Pickup is off");
      }),
    ),
  );

  it.effect("starts pickup once, offering the tickets in the pickup columns", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, sentMessages } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const { manager } = yield* approved(factory);
        const start = service.startPickup({ requestId: "start-1", managerId: manager.id });

        const started = yield* start;
        assert.strictEqual(started.state, "active");
        assert.strictEqual(sentMessages.length, 1);
        assert.strictEqual(sentMessages[0]!.threadId, manager.threadId);
        assert.include(sentMessages[0]!.text, "#1 Ticket 1");
        assert.deepStrictEqual(yield* start, started);
        assert.strictEqual(sentMessages.length, 1);

        const again = yield* service
          .startPickup({ requestId: "start-2", managerId: manager.id })
          .pipe(Effect.flip);
        assert.deepInclude(again, {
          reason: "conflict",
          message: "Ada is already picking up tickets.",
        });
      }),
    ),
  );

  it.effect("pauses a ready manager and resumes it ready", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service } = factory;
        const { manager } = yield* approved(factory);
        const managerId = manager.id;

        const paused = yield* service.pauseManager({
          requestId: "pause-1",
          managerId,
          scope: "manager",
        });
        assert.strictEqual(paused.state, "manager-paused");
        const refused = yield* service
          .startPickup({ requestId: "start-1", managerId })
          .pipe(Effect.flip);
        assert.include(refused.message, "Resume Ada first.");
        yield* service.pauseManager({ requestId: "pause-2", managerId, scope: "project" });
        const resumed = yield* service.resumeManager({ requestId: "resume-1", managerId });
        assert.strictEqual(resumed.state, "ready");
      }),
    ),
  );
});

describe("FactoryService role briefs", () => {
  const TEMPLATE = "allowed:\n{{allowedModels}}\nprotected:\n{{protectedPaths}}";

  it.effect("fills the skill source the project resolves with the role's models and paths", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service, skillReads, boards, configStore } = yield* makeHarness({
          config: decodeConfig({
            modelPool: [OPUS, SONNET],
            roleModels: { manager: OPUS, workers: { implementer: [SONNET] } },
          }),
          readRoleSkill: (role) =>
            role === "implementer"
              ? { text: TEMPLATE, source: "project" }
              : { text: TEMPLATE, source: "environment" },
        });
        boards.push(board([]));
        const { id: managerId, threadId } = yield* create(service);
        yield* service.proposeOnboarding(threadId!, PROPOSAL);

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

        yield* service.approveOnboarding({ requestId: "approve-1", managerId, result: RESULT });
        const approved = yield* service.roleBrief(PROJECT_ID, "manager", managerId);
        assert.strictEqual(
          approved.text,
          [
            "allowed:\n- claude/claude-opus-5-5\nprotected:\n- AGENTS.md",
            "# Project",
            "A todo app for small teams.",
            "## Pickup\n\nPickup is on. Judge each ticket you are offered against this guidance:\n\nSmall, well-specified bugs.",
            "## Project rules\n\n- Which tickets count as small?: One file",
          ].join("\n\n"),
        );
        assert.strictEqual(approved.source, "default");
        const lead = yield* service.roleBrief(PROJECT_ID, "lead", managerId);
        assert.include(lead.text, "\n\n# Project\n\n");
        assert.strictEqual(lead.source, "default");
        // A worker's brief carries the project section too, as a team member's does.
        const worker = yield* service.roleBrief(PROJECT_ID, "implementer", managerId);
        assert.include(worker.text, "\n\n# Project\n\n");

        // The first lead definition's instructions follow the protocol, before the project.
        yield* configStore.writeLead({
          id: "default",
          name: "Default lead",
          models: { dynamic: true, models: [] },
          instructions: "Open one pull request per change.",
        });
        const defined = yield* service.roleBrief(PROJECT_ID, "lead", managerId);
        assert.strictEqual(defined.source, "definition");
        assert.isTrue(
          defined.text.startsWith(
            "allowed:\n- claude/claude-opus-5-5\n- claude/claude-sonnet-5\nprotected:\n- AGENTS.md\n\nOpen one pull request per change.\n\n# Project\n\n",
          ),
          defined.text,
        );
      }),
    ),
  );
});

describe("FactoryService status", () => {
  it.effect("lists Ready tickets, judged after a skip until the ticket changes", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards } = factory;
        const manager = yield* activeManager(factory);
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
        assert.isTrue(before.pickupEnabled);
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
  it.effect("offers only the confirmed pickup columns, not every column mapped as Ready", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, attemptStarts } = factory;
        // The first real onboarding: the board's mapping counts Backlog as Ready too.
        boards.push(
          board(
            [
              { number: 1, columnId: READY },
              { number: 2, columnId: BACKLOG },
            ],
            [READY, BACKLOG],
          ),
        );
        const manager = yield* activeManager(factory);

        const status = yield* service.status(manager.id);
        assert.deepStrictEqual(
          status.readyTickets.map((ticket) => ticket.issue.ref.number),
          [1],
        );
        const backlog = yield* startTicket(factory, manager.threadId!, 2).pipe(Effect.flip);
        assert.strictEqual(backlog.reason, "conflict");
        assert.strictEqual(backlog.message, "#2 is not in one of your pickup columns.");

        // A pickup column that stops being Ready offers nothing.
        boards[0] = board([{ number: 1, columnId: READY }], BACKLOG);
        assert.deepStrictEqual((yield* service.status(manager.id)).readyTickets, []);

        // Work the user asks for may still start from any Ready column.
        boards[0] = board([{ number: 2, columnId: BACKLOG }], [READY, BACKLOG]);
        yield* service.commission(manager.threadId!, { ...SYNC_WORK, issueNumber: 2 });
        assert.deepStrictEqual(attemptStarts[0]!.issue, issue(2).ref);
      }),
    ),
  );

  it.effect("offers nothing and starts nothing while pickup is off", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, attemptStarts } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(factory, {
          ...RESULT,
          pickup: { ...RESULT.pickup, enabled: false },
        });

        const status = yield* service.status(manager.id);
        assert.isFalse(status.pickupEnabled);
        assert.strictEqual(status.pickupGuidance, "Small, well-specified bugs.");
        assert.deepStrictEqual(status.readyTickets, []);
        const refused = yield* startTicket(factory, manager.threadId!, 1).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "conflict");
        assert.include(refused.message, "Pickup is off");
        assert.strictEqual(attemptStarts.length, 0);
      }),
    ),
  );

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
        let threadId = created.threadId!;
        const createdMark = yield* logMark(service, created.id);

        const onboarding = yield* startTicket(factory, threadId).pipe(Effect.flip);
        assert.strictEqual(onboarding.reason, "conflict");
        assert.include(onboarding.message, "onboarding");
        assert.deepStrictEqual(yield* logKinds(service, created.id, createdMark), ["refused"]);
        threadId = (yield* approve(factory, created.id, threadId)).threadId!;
        const mark = yield* logMark(service, created.id);

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
        assert.deepStrictEqual(yield* logKinds(service, created.id, mark), [
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
        const manager = yield* activeManager(factory);

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
        assert.include(start.prompt, "\n\n# Project\n\nA todo app for small teams.");
        assert.include(start.prompt, "- Which tickets count as small?: One file\n\n# Assignment");
        assert.notInclude(start.prompt, "{{");

        assert.strictEqual(assignment.source, "ticket");
        assert.strictEqual(assignment.state, "active");
        assert.strictEqual(assignment.title, "Ticket 1");
        assert.deepStrictEqual(assignment.issue, issue(1).ref);
        assert.strictEqual(assignment.attemptId, "attempt-1");
        assert.strictEqual(assignment.leadThreadId, "lead-1");
        assert.strictEqual(assignment.managerId, manager.id);
        // No team asked for: the first factory team, sent as a summary of its snapshot.
        assert.deepStrictEqual(assignment.team, {
          preset: "standard",
          members: [],
          summary: {
            name: "Standard",
            members: [{ name: "Implementer", count: 1 }],
            mayEditProtectedPaths: false,
          },
        });
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
        const { manager, mark } = yield* setupDone(factory, yield* activeManager(factory));
        controls.attemptFailures = 1;

        const failed = yield* startTicket(factory, manager.threadId!).pipe(Effect.flip);
        assert.strictEqual(failed.reason, "conflict");
        assert.strictEqual(failed.message, "The ticket moved.");
        assert.deepStrictEqual(yield* service.listAssignments({ includeEnded: true }), []);
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), ["refused"]);
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
  it.effect("starts a large ticket the user asked for", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, attemptStarts } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const { manager, mark } = yield* setupDone(factory, yield* activeManager(factory));
        const work = SYNC_WORK;

        const assignment = yield* service.commission(manager.threadId!, {
          ...work,
          issueNumber: 1,
        });
        assert.strictEqual(assignment.title, "Rework the sync engine");
        assert.strictEqual(assignment.complexity, "large");
        assert.strictEqual(assignment.source, "ticket");
        assert.strictEqual(attemptStarts.length, 1);
        // The team's lead copy picks the model, whatever the ticket's size.
        assert.deepStrictEqual(attemptStarts[0]!.modelSelection, SONNET);
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), ["commission"]);
      }),
    ),
  );

  it.effect("launches work with no ticket in its own worktree and ends it on linked merges", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, launches, attemptStarts, threadRuns } = factory;
        const manager = yield* activeManager(factory);

        const assignment = yield* service.commission(manager.threadId!, SYNC_WORK);
        assert.strictEqual(assignment.source, "user");
        assert.isNull(assignment.issue);
        assert.isNull(assignment.attemptId);
        const lead = assignment.leadThreadId!;
        assert.notStrictEqual(lead, manager.threadId);
        assert.deepStrictEqual(attemptStarts, []);
        const launch = launches.at(-1)!;
        assert.strictEqual(launch.commandId, `factory-assignment:${assignment.id}`);
        assert.strictEqual(launch.threadId, lead);
        assert.strictEqual(launch.title, "Factory: Rework the sync engine");
        assert.deepStrictEqual(launch.modelSelection, SONNET);
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
            thread_id: lead,
            assignment_id: assignment.id,
            role: "lead",
            parent_thread_id: manager.threadId!,
            joined: "created",
          },
        ]);

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

describe("FactoryService lead reconciliation", () => {
  it.effect("stalls an assignment whose lead run failed and wakes the manager about it", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, threadRuns, sentMessages } = factory;
        boards.push(board([{ number: 1, columnId: READY }]));
        const { manager, mark, sentBefore } = yield* setupDone(
          factory,
          yield* activeManager(factory),
        );
        const assignment = (yield* startTicket(factory, manager.threadId!))!;
        const lead = ThreadId.make("lead-1");

        threadRuns.set(lead, idleRun());
        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "active");
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), ["pickup"]);

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
        assert.deepStrictEqual(
          sentMessages.slice(sentBefore).map((message) => message.text),
          [
            "Assignment Ticket 1 stalled: The lead's latest run failed. Investigate its lead thread, then call factory_recover to rebrief or replace the lead, or recommend to the user.",
          ],
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
        const { manager, mark, sentBefore } = yield* setupDone(
          factory,
          yield* activeManager(factory),
        );
        boards.push(board([{ number: 1, columnId: READY }]));

        yield* service.sweep;
        assert.strictEqual(sentMessages.length, sentBefore + 1);
        const message = sentMessages.at(-1)!;
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
        assert.strictEqual(sentMessages.length, sentBefore + 1);
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), ["wake"]);
      }),
    ),
  );

  it.effect("keeps a wake whose message failed and delivers it on the next sweep", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, sentMessages, controls } = factory;
        const { manager, sentBefore } = yield* setupDone(factory, yield* activeManager(factory));
        boards.push(board([{ number: 1, columnId: READY }]));
        controls.sendFailures = 1;

        yield* service.sweep;
        assert.deepStrictEqual(sentMessages.slice(sentBefore), []);
        const [pending] = yield* service.listLog({ managerId: manager.id });
        assert.isNull(pending!.deliveredAt);

        yield* service.sweep;
        assert.strictEqual(sentMessages.length, sentBefore + 1);
        assert.include(sentMessages.at(-1)!.text, "#1 Ticket 1");
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
        const { manager, mark, sentBefore } = yield* setupDone(
          factory,
          yield* activeManager(factory),
        );
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
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), ["pickup", "stalled"]);
        assert.deepStrictEqual(sentMessages.slice(sentBefore), []);
      }),
    ),
  );

  it.effect("writes no pickup wake while every slot is taken", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, boards, sentMessages } = factory;
        const { manager, mark, sentBefore } = yield* setupDone(
          factory,
          yield* activeManager(factory),
        );
        // The tickets turn Ready after pickup starts, so only the sweep could offer them.
        boards.push(
          board([
            { number: 1, columnId: READY },
            { number: 2, columnId: READY },
          ]),
        );
        yield* startTicket(factory, manager.threadId!);

        yield* service.sweep;
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), ["pickup"]);
        assert.deepStrictEqual(sentMessages.slice(sentBefore), []);
      }),
    ),
  );
});

const RETRO_REQUEST =
  "All pull requests for Ticket 1 are merged. Write your team retro now: what worked, what did not, what the next team should change, then call factory_retro_done.";

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
        const { manager, lead, mark, sentBefore } = yield* startedAssignment(factory);
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
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), ["claim", "wake"]);
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), ["retro"]);
        assert.deepStrictEqual(
          sentMessages.slice(sentBefore).map((message) => [message.threadId, message.text]),
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
        const { manager, lead, mark, sentBefore } = yield* startedAssignment(factory);
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
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), []);

        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "waiting-user");

        threadRuns.set(
          lead,
          idleRun({ pullRequests: [pullRequest(7, true), pullRequest(8, true)] }),
        );
        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "retro");
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), ["retro"]);
        assert.deepStrictEqual(
          sentMessages.slice(sentBefore).map((message) => message.text),
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
          const { manager, lead, mark } = yield* startedAssignment(factory);
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
          assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), []);

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
        const { manager, assignment, lead, mark, sentBefore } = yield* startedAssignment(
          factory,
          [1, 2],
        );

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
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), ["dependency"]);

        yield* service.sweep;
        const [woken] = sentMessages.slice(sentBefore);
        assert.include(
          woken!.text,
          `Assignment Ticket 1 is blocked on Expose the sync cursor: GET /sync returns the cursor. Commission it with factory_commission (dependencyId ${dependency.id}) or tell the lead how to proceed.`,
        );
        assert.include(woken!.text, "Add the cursor to GET /sync.");

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
        const { manager, assignment, lead, mark, sentBefore } = yield* startedAssignment(factory);
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
          sentMessages.slice(sentBefore).map((message) => [message.threadId, message.text]),

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
        assert.strictEqual(sentMessages.length, sentBefore + 1);
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), [
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
        const newLead = replaced.leadThreadId!;
        assert.notStrictEqual(newLead, lead);
        assert.strictEqual(replaced.attemptId, "attempt-1");
        assert.strictEqual(attemptStarts.length, 1);
        const launch = launches.at(-1)!;
        assert.strictEqual(launch.commandId, `factory-assignment:${assignment.id}:recovery-1`);
        assert.strictEqual(launch.threadId, newLead);
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
            [newLead, 0],
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
        const { manager, assignment, lead, mark } = yield* startedAssignment(factory);
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
        assert.strictEqual((yield* logKinds(service, manager.id, mark)).at(-1), "complete");
      }),
    ),
  );

  it.effect("cancels into the lead's retro, interrupts the lead and ends cancelled", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, interrupts, sentMessages } = factory;
        const { manager, assignment, lead, sentBefore } = yield* startedAssignment(factory);
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
          sentMessages[sentBefore]!.text,
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
        const { manager, lead, mark, sentBefore } = yield* startedAssignment(factory);

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
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), []);
        assert.deepStrictEqual(sentMessages.slice(sentBefore), []);

        const handedBack = yield* service.handBack({ requestId: "hand-1", threadId: lead });
        assert.isFalse(handedBack.takenOver);
        yield* service.sweep;
        assert.deepStrictEqual(
          sentMessages.slice(sentBefore).map((message) => message.text),
          ["The user handed back Ticket 1; it is now stalled. Check its thread for what changed."],
        );
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), [
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
        const { manager, lead, mark, sentBefore } = yield* startedAssignment(factory);

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
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), []);
        assert.deepStrictEqual(sentMessages.slice(sentBefore), []);
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

describe("FactoryService observed threads", () => {
  it.effect("joins a sub-agent under its parent's role and member, never off the pool", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, sentMessages } = factory;
        const { manager, lead, mark, sentBefore } = yield* startedTeam(factory);
        yield* service.recordMember(lead, {
          threadId: ThreadId.make("worker-1"),
          role: "worker",
          memberName: "reviewer",
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
            member.memberName,
            member.parentThreadId,
            member.joined,
            member.offPool,
          ]),
          [
            ["lead-1", "lead", undefined, manager.threadId, "created", false],
            // The member name is stored as the team spells it.
            ["worker-1", "worker", "Reviewer", "lead-1", "created", false],
            ["sub-1", "lead", undefined, "lead-1", "observed", false],
            // On a model outside the pool, yet not flagged: sub-agents act only through their parent.
            ["sub-2", "worker", "Reviewer", "worker-1", "observed", false],
          ],
        );
        assert.deepStrictEqual(yield* logKinds(service, manager.id, mark), []);
        yield* service.sweep;
        assert.deepStrictEqual(sentMessages.slice(sentBefore), []);
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
        const { assignment, lead, mark } = yield* startedTeam(factory);
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
        assert.deepStrictEqual(yield* logKinds(service, assignment.managerId, mark), []);

        const tooLong = Array.from({ length: 21 }, (_, index) => ({
          text: `Step ${index}`,
          state: "not-started",
        }));
        assert.isTrue(Option.isNone(decodeChecklistInput({ steps: tooLong })));
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
          const { manager, assignment, lead, mark } = yield* startedTeam(factory);
          yield* asLegacyTeam(assignment.id);
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
          assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), []);

          const fromLead = yield* service.recordFinding(lead, {
            class: "project",
            summary: "CI skips the e2e suite on forks",
            evidence: "The workflow's e2e job has `if: github.repository == 'acme/app'`.",
            workaround: "Run it locally.",
            escalate: true,
          });
          assert.isTrue(fromLead.escalated);
          assert.strictEqual(fromLead.workaround, "Run it locally.");
          assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), ["finding"]);
          const [wake] = yield* service.listLog({ managerId: manager.id });
          assert.deepStrictEqual(wake!.payload, {
            assignmentId: assignment.id,
            title: "Ticket 1",
            findingId: fromLead.id,
            summary: "CI skips the e2e suite on forks",
          });
          assert.deepStrictEqual(
            (yield* logKinds(service, manager.id, mark)).filter((kind) => kind === "finding"),
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
          const { manager, assignment, lead, mark } = yield* startedAssignment(factory);
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
          assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), [
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
  it.effect("lets an onboarding manager draft a ticket from a finding", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service } = yield* makeHarness({ config: ENVIRONMENT });
        const created = yield* create(service);
        assert.strictEqual(created.state, "onboarding");

        const { draft } = yield* service.draftTicket(created.threadId!, {
          ...DRAFT,
          title: "Turn on branch protection for main",
        });
        assert.strictEqual(draft.state, "pending");
        assert.strictEqual(draft.title, "Turn on branch protection for main");
        assert.isNull(draft.assignmentId);
      }),
    ),
  );

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
          const { manager, mark } = yield* setupDone(factory, yield* activeManager(factory));
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
          assert.strictEqual((yield* logKinds(service, manager.id, mark)).at(-1), "draft");

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
        const manager = yield* activeManager(factory);
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
          const manager = yield* activeManager(factory);
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
        const manager = yield* activeManager(factory);
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

  it.effect("refuses a pickup guidance change, which now lives on the manager", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service } = factory;
        const sql = yield* SqlClient.SqlClient;
        const manager = yield* activeManager(factory);
        const pickupGuidance = {
          kind: "setting",
          key: "pickupGuidance",
          before: "",
          after: "Only bugs.",
        } as const;

        const drafted = yield* draftChange(factory, manager.threadId!, pickupGuidance).pipe(
          Effect.flip,
        );
        assert.strictEqual(drafted.reason, "invalid");
        assert.include(drafted.message, "set per manager at onboarding");
        assert.deepStrictEqual(yield* service.listDrafts({ state: "pending" }), []);

        // A draft stored before the move still exists, and is refused when applied.
        const { draft } = yield* draftChange(factory, manager.threadId!, {
          kind: "setting",
          key: "concurrencyCap",
          before: 1,
          after: 2,
        });
        yield* sql`UPDATE factory_ticket_drafts
            SET proposed_change_json=${JSON.stringify(pickupGuidance)} WHERE id=${draft.id}`;
        const refused = yield* service
          .applyDraft({ requestId: "apply-1", draftId: draft.id })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "invalid");
        assert.include(refused.message, "set per manager at onboarding");
        assert.deepStrictEqual((yield* service.getConfig({})).environment, FACTORY);
      }),
    ),
  );

  it.effect("refuses a setting that changed since the retro, naming its current value", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service } = factory;
        const manager = yield* activeManager(factory);
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

  it.effect("refuses a preset change, since teams moved into the factory config", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service } = factory;
        const manager = yield* activeManager(factory);
        const { draft } = yield* draftChange(factory, manager.threadId!, {
          kind: "preset",
          before: null,
          after: preset("Trio", "implement, review, verify"),
        });

        const refused = yield* service
          .applyDraft({ requestId: "apply-1", draftId: draft.id })
          .pipe(Effect.flip);
        assert.deepInclude(refused, {
          reason: "invalid",
          message:
            "Teams live in the factory config now. Ask the manager to propose a team change.",
        });
        assert.deepStrictEqual((yield* service.getConfig({})).environment, FACTORY);
      }),
    ),
  );

  it.effect("adds a proposed team, then refuses a change proposed against an older copy", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { service, configStore } = factory;
        const manager = yield* activeManager(factory);
        const opus = { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" };
        yield* configStore.writeSettings({ version: 1, modelPool: [opus], recoveryAllowance: 1 });
        const team = {
          id: "trio",
          name: "Trio",
          useWhen: "Risky migrations.",
          workflow: "Implement, review, verify.",
          mayEditProtectedPaths: false,
          createdBy: "manager" as const,
          lead: {
            id: "default",
            name: "Default lead",
            models: { dynamic: true, models: [opus] },
            instructions: "",
          },
          members: [
            {
              id: "implementer",
              name: "Implementer",
              models: { dynamic: false, models: [opus] },
              description: "Implement it.",
              count: 1,
            },
          ],
        };
        const { draft: added } = yield* draftChange(factory, manager.threadId!, {
          kind: "team",
          before: null,
          after: team,
        });
        const { draft: stale } = yield* draftChange(factory, manager.threadId!, {
          kind: "team",
          before: { ...team, workflow: "Implement only." },
          after: { ...team, workflow: "Implement, then verify." },
        });

        const applied = yield* service.applyDraft({ requestId: "apply-1", draftId: added.id });
        assert.strictEqual(applied.state, "approved");
        assert.deepStrictEqual(
          (yield* configStore.read).teams.find((saved) => saved.id === "trio"),
          team,
        );

        const refused = yield* service
          .applyDraft({ requestId: "apply-2", draftId: stale.id })
          .pipe(Effect.flip);
        assert.deepInclude(refused, {
          reason: "conflict",
          message:
            'The team "Trio" changed since this was proposed. Ask the manager to propose it again.',
        });
        assert.deepStrictEqual(
          (yield* configStore.read).teams.find((saved) => saved.id === "trio"),
          team,
        );
        const [pending] = yield* service.listDrafts({ state: "pending" });
        assert.strictEqual(pending!.id, stale.id);
      }),
    ),
  );
});

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
        const { manager, assignment, lead, mark } = yield* startedAssignment(factory);
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
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), [
          "retro",
          "manager-retro",
        ]);
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
        // Review rounds count reviewers, which only a team staffed by role has.
        yield* asLegacyTeam(assignment.id);
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

  it.effect("rolls a definition team's usage up per member, sub-agents into their parent", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, threadTurns } = factory;
        const { manager, assignment, lead } = yield* startedTeam(factory);
        const implementer = ThreadId.make("worker-1");
        const reviewer = ThreadId.make("reviewer-1");
        const helper = ThreadId.make("sub-1");
        for (const [threadId, memberName] of [
          [implementer, "Implementer"],
          [reviewer, "Reviewer"],
        ] as const)
          yield* service.recordMember(lead, {
            threadId,
            role: "worker",
            memberName,
            modelSelection: SONNET,
            joined: "created",
          });
        yield* service.observeThread({
          threadId: helper,
          parentThreadId: implementer,
          modelSelection: SONNET,
        });
        threadTurns.set(lead, [
          turn(SONNET.model, 0, 60, { input: 1000, cachedInput: 400, output: 200 }),
        ]);
        threadTurns.set(implementer, [
          turn(SONNET.model, 10, 30, { input: 500, cachedInput: 100, output: 100 }),
        ]);
        threadTurns.set(helper, [
          turn(SONNET.model, 20, 10, { input: 100, cachedInput: 0, output: 20 }),
        ]);
        threadTurns.set(reviewer, [
          turn(SONNET.model, 50, 5, { input: 40, cachedInput: 0, output: 10 }),
        ]);
        threadRuns.set(lead, idleRun());

        yield* service.claimComplete(lead, { evidence: "Fixed without a pull request." });
        yield* service.retroDone(lead);
        yield* service.complete(manager.threadId!, {
          assignmentId: assignment.id,
          teamVerdict: VERDICT,
        });

        const [stats] = (yield* service.getStats({})).assignments;
        assert.strictEqual(stats!.team, "duo");
        assert.strictEqual(stats!.reviewRounds, 0);
        assert.deepStrictEqual(stats!.byMember, [
          {
            name: "Implementer",
            // The helper's turns count here, but it was never delegated.
            delegations: 1,
            tokens: { input: 600, cachedInput: 100, output: 120 },
            agentMs: 40_000,
          },
          {
            name: "Reviewer",
            delegations: 1,
            tokens: { input: 40, cachedInput: 0, output: 10 },
            agentMs: 5_000,
          },
        ]);
        assert.deepStrictEqual(
          stats!.byRole.map((entry) => [entry.role, entry.agentMs]),
          [
            ["lead", 60_000],
            ["worker", 45_000],
          ],
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

describe("FactoryService manager definitions", () => {
  it.effect("creates a manager with its own copy of a definition, on that definition's model", () =>
    withDatabase(
      Effect.gen(function* () {
        const steady: FactoryManagerDefinition = {
          id: "steady",
          name: "Steady",
          models: { dynamic: false, models: [refOf(SONNET)] },
          instructions: "Pick small fixes.",
        };
        const bold: FactoryManagerDefinition = {
          id: "bold",
          name: "Bold",
          // GPT is not in the pool, so the manager starts on Opus.
          models: { dynamic: false, models: [refOf(GPT), refOf(OPUS)] },
          instructions: "Pick anything.",
        };
        const { service, configStore } = yield* makeHarness({
          config: decodeConfig({ modelPool: [OPUS, SONNET] }),
          definitions: { managers: [steady, bold] },
        });
        const request = { requestId: "create-1", projectId: PROJECT_ID, name: "Ada" };

        const missing = yield* service
          .createManager({ ...request, definitionId: "calm" })
          .pipe(Effect.flip);
        assert.deepInclude(missing, {
          reason: "not-found",
          // Definitions read in id order.
          message: 'There is no manager definition "calm". Use one of: bold, steady.',
        });
        const outside = yield* service
          .createManager({ ...request, definitionId: "bold", modelSelection: GPT })
          .pipe(Effect.flip);
        assert.strictEqual(outside.message, "gpt-6 (codex) is not in the model pool.");

        const created = yield* service.createManager({ ...request, definitionId: "bold" });
        assert.deepStrictEqual(created.definition, bold);
        assert.deepStrictEqual(created.modelSelection, OPUS);
        // A copy: editing the definition afterwards leaves the manager's as it was.
        yield* configStore.writeManager({ ...bold, instructions: "Pick only docs." });
        const [listed] = yield* service.listManagers({});
        assert.deepStrictEqual(listed!.definition, bold);
      }),
    ),
  );
});

describe("FactoryService text migrated from role skills", () => {
  it.effect("briefs a role-staffed worker from the factory config worker of that role's id", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeHarness({
          config: TEAM_FACTORY,
          definitions: {
            teams: [DUO_TEAM],
            // What the migration wrote from the old reviewer role skill.
            workers: [
              {
                id: "reviewer",
                name: "Reviewer",
                models: ANY_MODEL,
                description: "Migrated reviewer text. Done when: {{completionCondition}}",
              },
            ],
          },
        });
        const { assignment, lead } = yield* startedTeam(factory);
        yield* asLegacyTeam(assignment.id);

        const plan = yield* factory.service.planDelegation(lead, {
          role: "reviewer",
          task: "Review it.",
        });
        assert.isTrue(
          plan.task.startsWith(`Migrated reviewer text. Done when: ${START.completionCondition}`),
        );
        assert.isTrue(plan.task.endsWith("\n\n# Task\n\nReview it."));
        // Without a worker of its id, the implementer keeps the built-in skill.
        const implementer = yield* factory.service.planDelegation(lead, {
          role: "implementer",
          task: "Fix it.",
        });
        assert.include(implementer.task, "# Implementer");
      }),
    ),
  );

  it.effect("replans a lead on a team without a snapshot from the first lead definition", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeHarness({
          config: FACTORY,
          definitions: {
            teams: [{ ...STANDARD_TEAM, lead: SONNET_LEAD }],
            leads: [{ ...DEFAULT_LEAD, instructions: "Migrated lead text." }],
          },
        });
        const { service, threadRuns, launches } = factory;
        const { manager, assignment, lead } = yield* startedAssignment(factory);
        yield* asLegacyTeam(assignment.id);
        threadRuns.set(lead, { ...failedRun, worktreePath: "/repo/.worktrees/issue-1" });
        yield* service.reconcileThread(lead);

        yield* service.recover(manager.threadId!, {
          assignmentId: assignment.id,
          action: "replace",
          brief: "Start again from the failing test.",
        });
        const replacement = launches.at(-1)!;
        assert.include(replacement.text, "Migrated lead text.");
        // An older team has no lead copy to pick a model from, so the pool's first runs it.
        assert.deepStrictEqual(replacement.modelSelection, OPUS);
      }),
    ),
  );

  it.effect("copies the first manager definition into every manager created without one", () =>
    withDatabase(
      Effect.gen(function* () {
        const steady: FactoryManagerDefinition = {
          id: "steady",
          name: "Steady",
          models: ANY_MODEL,
          instructions: "Migrated manager text.",
        };
        const factory = yield* makeHarness({
          config: FACTORY,
          definitions: { managers: [steady] },
        });
        const { service } = factory;
        const created = yield* create(service);
        const sql = yield* SqlClient.SqlClient;
        // As a manager created before definition copies, and one already retired.
        yield* sql`UPDATE factory_managers SET definition_json=NULL WHERE id=${created.id}`;
        yield* sql`INSERT INTO factory_managers(id,project_id,name,state,created_at,updated_at)
            VALUES('retired','project-2','Grace','retired',${EPOCH},${EPOCH})`;
        assert.strictEqual((yield* service.listManagers({}))[0]!.definition, undefined);
        assert.include(
          (yield* service.roleBrief(PROJECT_ID, "manager", created.id)).text,
          "Migrated manager text.",
        );

        assert.strictEqual(yield* service.adoptManagerDefinitions, 1);
        assert.strictEqual(yield* service.adoptManagerDefinitions, 0);
        const managers = yield* service.listManagers({ includeRetired: true });
        assert.deepStrictEqual(
          managers.map((manager) => [manager.id, manager.definition ?? null]),
          [
            [created.id, steady],
            ["retired", null],
          ],
        );
      }),
    ),
  );
});

describe("FactoryService manager models", () => {
  it.effect("refuses a manager definition none of whose models can run here", () =>
    withDatabase(
      Effect.gen(function* () {
        const { service } = yield* makeHarness({
          config: decodeConfig({ modelPool: [OPUS, SONNET] }),
          definitions: {
            managers: [
              {
                id: "codex-only",
                name: "Codex only",
                models: { dynamic: false, models: [refOf(GPT)] },
                instructions: "",
              },
            ],
          },
        });
        const refused = yield* create(service).pipe(Effect.flip);
        assert.deepInclude(refused, {
          reason: "invalid",
          message:
            "None of Codex only's models can run on this environment. Add one it can run to the factory pool, or change Codex only's models.",
        });
        // A model chosen outright is not the definition's fallback, so it is allowed.
        const created = yield* service.createManager({
          requestId: "create-2",
          projectId: PROJECT_ID,
          name: "Ada",
          modelSelection: SONNET,
        });
        assert.deepStrictEqual(created.modelSelection, SONNET);
      }),
    ),
  );
});

describe("FactoryService instance preferences", () => {
  it.effect("runs a driver's models on its preferred instance and reports a stale preference", () =>
    withDatabase(
      Effect.gen(function* () {
        const claudeWork = ProviderInstanceId.make("claude-work");
        const factory = yield* makeHarness({
          config: decodeConfig({
            modelPool: [OPUS, SONNET],
            instancePreferences: { claudeAgent: claudeWork },
          }),
        });
        const { service, controls } = factory;
        // A second Claude instance, listed after the first: only the preference picks it.
        controls.catalog = [
          ...CATALOG,
          {
            instanceId: claudeWork,
            driver: ProviderDriverKind.make("claudeAgent"),
            models: [OPUS.model],
          },
        ];

        const created = yield* create(service);
        assert.deepStrictEqual(created.modelSelection, {
          instanceId: claudeWork,
          model: OPUS.model,
        });
        assert.strictEqual((yield* service.getConfig({})).stalePreferences, undefined);

        const environment = (yield* service.getConfig({})).environment;
        const updated = yield* service.updateConfig({
          scope: "environment",
          config: {
            ...environment,
            instancePreferences: {
              ...environment.instancePreferences,
              [ProviderDriverKind.make("codex")]: ProviderInstanceId.make("codex-gone"),
            },
          },
        });
        const stale = [
          {
            driver: ProviderDriverKind.make("codex"),
            instanceId: ProviderInstanceId.make("codex-gone"),
          },
        ];
        assert.deepStrictEqual(updated.stalePreferences, stale);
        assert.deepStrictEqual((yield* service.getConfig({})).stalePreferences, stale);
      }),
    ),
  );
});
