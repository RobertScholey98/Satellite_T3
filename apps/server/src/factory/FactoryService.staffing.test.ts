import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type FactoryDelegateInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  EPOCH,
  OPUS,
  SONNET,
  GPT,
  withDatabase,
  READY,
  board,
  RESULT,
  activeManager,
  START,
  startTicket,
  makeStaffingFactory,
  pickupRefusal,
  idleRun,
} from "./FactoryService.testkit.ts";

describe("FactoryService staffing from the factory config", () => {
  it.effect("commissions a team by id, its lead on a model picked from the lead's list", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeStaffingFactory();
        factory.boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(factory);
        const threadId = manager.threadId!;

        assert.strictEqual(
          yield* pickupRefusal(factory, threadId, { teamId: "nope" }),
          'There is no team "nope". Teams: standard, web.',
        );
        assert.strictEqual(
          yield* pickupRefusal(factory, threadId, { teamId: "web", leadModel: GPT }),
          "codex/gpt-6 is not one this team's lead may run. Choose from: claude/claude-sonnet-5, claude/claude-opus-5-5.",
        );
        // The Standard lead lists no models, so it runs the pool in order.
        assert.strictEqual(
          yield* pickupRefusal(factory, threadId, { teamId: "standard", leadModel: SONNET }),
          "This team's lead runs its models in order, so it starts on claude/claude-opus-5-5.",
        );
        assert.strictEqual(
          yield* pickupRefusal(factory, threadId, {
            team: { preset: "custom", members: [{ role: "implementer", count: 1 }] },
          }),
          "Teams come from the factory config. Pick a team id from factory_definitions.",
        );

        const assignment = (yield* factory.service.pickup(threadId, {
          ...START,
          issueNumber: 1,
          teamId: "web",
          leadModel: OPUS,
        }))!;
        assert.deepStrictEqual(assignment.team, {
          preset: "web",
          members: [],
          summary: {
            name: "Web",
            members: [
              { name: "Builder", count: 1 },
              { name: "Checker", count: 2 },
            ],
            mayEditProtectedPaths: false,
          },
        });
        assert.deepStrictEqual(factory.attemptStarts[0]!.modelSelection, OPUS);
      }),
    ),
  );

  it.effect("staffs only the teams the manager's onboarding result lists", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeStaffingFactory();
        factory.boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(factory, { ...RESULT, teamIds: ["web"] });

        assert.strictEqual(
          yield* pickupRefusal(factory, manager.threadId!, { teamId: "standard" }),
          "You may not staff Standard. Your teams: web.",
        );
        // With no team asked for, the first team it may staff.
        const assignment = (yield* startTicket(factory, manager.threadId!))!;
        assert.strictEqual(assignment.team.preset, "web");
        assert.deepStrictEqual(factory.attemptStarts[0]!.modelSelection, SONNET);
      }),
    ),
  );

  it.effect("delegates to a member by name, counting places without its sub-agents", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeStaffingFactory();
        const { service } = factory;
        factory.boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(factory);
        yield* service.pickup(manager.threadId!, { ...START, issueNumber: 1, teamId: "web" });
        const lead = ThreadId.make("lead-1");
        const refused = (input: Omit<FactoryDelegateInput, "task">) =>
          service.planDelegation(lead, { ...input, task: "Check it." }).pipe(
            Effect.flip,
            Effect.map((failure) => failure.message),
          );

        assert.strictEqual(
          yield* refused({}),
          "Name the team member to delegate to: Builder, Checker.",
        );
        assert.strictEqual(
          yield* refused({ member: "Tester" }),
          'Web has no member named "Tester". Its members: Builder, Checker.',
        );
        assert.strictEqual(
          yield* refused({ member: "checker", modelSelection: SONNET }),
          "Checker runs its models in order, so it starts on claude/claude-opus-5-5.",
        );
        const checker = yield* service.planDelegation(lead, {
          member: "checker",
          task: "Check it.",
        });
        assert.deepStrictEqual(
          [checker.role, checker.member, checker.modelSelection, checker.allowedModels],
          ["worker", "Checker", OPUS, [OPUS]],
        );

        const builder = yield* service.planDelegation(lead, {
          member: "BUILDER",
          task: "Add the button.",
        });
        assert.deepStrictEqual(
          [builder.role, builder.member, builder.title, builder.modelSelection],
          ["worker", "Builder", "Builder: Ticket 1", SONNET],
        );
        assert.deepStrictEqual(builder.allowedModels, [SONNET, OPUS]);
        assert.isTrue(builder.task.startsWith(`Builds until: ${START.completionCondition}`));
        assert.isTrue(builder.task.endsWith("\n\n# Task\n\nAdd the button."));
        // The plan holds Builder's only place until its worker is recorded, so a second
        // delegation planned meanwhile cannot take it too.
        assert.strictEqual(
          yield* refused({ member: "Builder" }),
          "The team allows 1 × Builder and it is busy.",
        );

        yield* service.recordMember(lead, {
          threadId: ThreadId.make("worker-1"),
          role: "worker",
          memberName: "Builder",
          modelSelection: SONNET,
          joined: "created",
        });
        yield* service.observeThread({
          threadId: ThreadId.make("sub-1"),
          parentThreadId: ThreadId.make("worker-1"),
          modelSelection: SONNET,
        });
        assert.strictEqual(
          yield* refused({ member: "Builder" }),
          "The team allows 1 × Builder and it is busy.",
        );
        // The builder finished, but its sub-agent still runs: that takes no place.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE factory_members SET ended_at=${EPOCH} WHERE thread_id='worker-1'`;
        const again = yield* service.planDelegation(lead, {
          member: "Builder",
          task: "Again.",
          modelSelection: OPUS,
        });
        assert.deepStrictEqual([again.member, again.modelSelection], ["Builder", OPUS]);
        assert.strictEqual(
          (yield* service
            .recordMember(lead, {
              threadId: ThreadId.make("worker-2"),
              role: "implementer",
              modelSelection: SONNET,
              joined: "created",
            })
            .pipe(Effect.flip)).message,
          "Record the worker as role worker under one of the team's member names.",
        );
      }),
    ),
  );

  it.effect(
    "frees a member's place once its task finishes, and takes it while a follow-up runs",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeStaffingFactory();
          const { service, threadRuns } = factory;
          factory.boards.push(board([{ number: 1, columnId: READY }]));
          const manager = yield* activeManager(factory);
          yield* service.pickup(manager.threadId!, { ...START, issueNumber: 1, teamId: "web" });
          const lead = ThreadId.make("lead-1");
          const worker = ThreadId.make("worker-1");
          const busy = () =>
            service.planDelegation(lead, { member: "Builder", task: "Again." }).pipe(
              Effect.flip,
              Effect.map((failure) => failure.message),
            );

          yield* service.planDelegation(lead, { member: "Builder", task: "Add the button." });
          yield* service.recordMember(lead, {
            threadId: worker,
            role: "worker",
            memberName: "Builder",
            modelSelection: SONNET,
            joined: "created",
          });
          threadRuns.set(worker, idleRun({ latestRunStatus: "running", runInProgress: true }));
          assert.strictEqual(yield* busy(), "The team allows 1 × Builder and it is busy.");

          threadRuns.set(worker, idleRun());
          const again = yield* service.planDelegation(lead, { member: "Builder", task: "Again." });
          assert.strictEqual(again.member, "Builder");
          const second = ThreadId.make("worker-2");
          yield* service.recordMember(lead, {
            threadId: second,
            role: "worker",
            memberName: "Builder",
            modelSelection: SONNET,
            joined: "created",
          });
          threadRuns.set(second, idleRun());

          // A follow-up on the first worker's thread runs again, so it takes the place again.
          threadRuns.set(worker, idleRun({ latestRunStatus: "running", runInProgress: true }));
          assert.strictEqual(yield* busy(), "The team allows 1 × Builder and it is busy.");
        }),
      ),
  );
});

describe("FactoryService capacity", () => {
  it.effect("refuses new work once the environment is full across managers", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeStaffingFactory(2);
        factory.boards.push(
          board([
            { number: 1, columnId: READY },
            { number: 2, columnId: READY },
          ]),
        );
        const manager = yield* activeManager(factory, { ...RESULT, concurrencyCap: 5 });
        // Another project's manager already runs one assignment on this environment.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO factory_managers(id,project_id,name,state,created_at,updated_at)
            VALUES('other','project-2','Grace','active',${EPOCH},${EPOCH})`;
        yield* sql`INSERT INTO factory_assignments(id,manager_id,project_id,title,brief,
            completion_condition,source,complexity,state,team_json,created_at,updated_at)
            VALUES('other-work','other','project-2','Elsewhere','','','user','small','active',
            '{"preset":"custom","members":[]}',${EPOCH},${EPOCH})`;

        yield* startTicket(factory, manager.threadId!, 1);
        const status = yield* factory.service.status(manager.id);
        assert.deepStrictEqual(
          [status.concurrencyCap, status.activeCount, status.capacityFree],
          [5, 1, false],
        );
        assert.strictEqual(
          yield* pickupRefusal(factory, manager.threadId!, { issueNumber: 2 }),
          "All 2 assignment slots on this environment are in use across its projects. Wait for one to finish.",
        );
      }),
    ),
  );

  it.effect("refuses new work once the manager's own cap is reached", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeStaffingFactory(3);
        factory.boards.push(
          board([
            { number: 1, columnId: READY },
            { number: 2, columnId: READY },
          ]),
        );
        const manager = yield* activeManager(factory, { ...RESULT, concurrencyCap: 1 });
        assert.isTrue((yield* factory.service.status(manager.id)).capacityFree);

        yield* startTicket(factory, manager.threadId!, 1);
        const status = yield* factory.service.status(manager.id);
        assert.deepStrictEqual(
          [status.concurrencyCap, status.activeCount, status.capacityFree],
          [1, 1, false],
        );
        assert.strictEqual(
          yield* pickupRefusal(factory, manager.threadId!, { issueNumber: 2 }),
          "All 1 assignment slots are in use. Wait for one to finish.",
        );
      }),
    ),
  );
});
