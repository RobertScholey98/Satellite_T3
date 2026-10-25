import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import {
  OPUS,
  SONNET,
  withDatabase,
  READY,
  board,
  activeManager,
  START,
  memberRows,
  makeTeamFactory,
  startedTeam,
  workspace,
  makeStaffingFactory,
  asLegacyTeam,
  idleRun,
} from "./FactoryService.testkit.ts";

describe("FactoryService delegation", () => {
  it.effect("on a team staffed by role, plans a worker it has room for on an allowed model", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service } = factory;
        const { manager, assignment, lead } = yield* startedTeam(factory);
        yield* asLegacyTeam(assignment.id);

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
            parent_thread_id: manager.threadId!,
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

  it.effect("on a team staffed by role, a finished implementer frees its place", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service } = factory;
        const { assignment, lead } = yield* startedTeam(factory);
        yield* asLegacyTeam(assignment.id);
        const plan = yield* service.planDelegation(lead, { role: "implementer", task: "Fix it." });
        const worker = ThreadId.make("worker-1");
        yield* service.recordMember(lead, {
          threadId: worker,
          role: "implementer",
          modelSelection: plan.modelSelection,
          joined: "created",
        });
        const busy = () =>
          service.planDelegation(lead, { role: "implementer", task: "Fix the next thing." }).pipe(
            Effect.flip,
            Effect.map((failure) => failure.message),
          );
        // Running, waiting on the user, and recorded before its first run are all still working.
        for (const runs of [
          idleRun({ latestRunStatus: "running", runInProgress: true }),
          idleRun({ pendingRequests: 1 }),
          idleRun({ latestRunStatus: null }),
        ]) {
          factory.threadRuns.set(worker, runs);
          assert.strictEqual(yield* busy(), "The team allows 1 implementer and all are busy.");
        }
        factory.threadRuns.set(worker, idleRun());

        const next = yield* service.planDelegation(lead, {
          role: "implementer",
          task: "Fix the next thing.",
        });
        assert.strictEqual(next.role, "implementer");
      }),
    ),
  );
});

describe("FactoryService delegation holds", () => {
  it.effect("lets a held place go once the hold lapses without a recorded worker", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeStaffingFactory();
        const { service } = factory;
        factory.boards.push(board([{ number: 1, columnId: READY }]));
        const manager = yield* activeManager(factory);
        yield* service.pickup(manager.threadId!, { ...START, issueNumber: 1, teamId: "web" });
        const lead = ThreadId.make("lead-1");

        yield* service.planDelegation(lead, { member: "Builder", task: "Add the button." });
        const busy = yield* service
          .planDelegation(lead, { member: "Builder", task: "Add the button." })
          .pipe(Effect.flip);
        assert.strictEqual(busy.reason, "conflict");
        // The first launch never recorded its worker; after five minutes the place is free.
        yield* TestClock.adjust("5 minutes");
        const retried = yield* service.planDelegation(lead, {
          member: "Builder",
          task: "Add the button.",
        });
        assert.strictEqual(retried.member, "Builder");
      }),
    ),
  );
});
