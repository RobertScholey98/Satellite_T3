import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PROJECT_ID,
  withDatabase,
  idleRun,
  pullRequest,
  wakeReasons,
  makeTeamFactory,
  startedTeam,
  workspace,
} from "./FactoryService.testkit.ts";

const PROTECTED_FILES = ["src/list.tsx", "apps/web/AGENTS.md", ".satellite/factory/roles/lead.md"];

describe("FactoryService control paths", () => {
  it.effect("holds a pull request that touches protected paths until a new push clears it", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, fileReads, sentMessages } = factory;
        const { manager, lead, mark, sentBefore } = yield* startedTeam(factory);
        pullRequestFiles.set(7, PROTECTED_FILES);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));

        yield* service.reconcileThread(lead);
        const held = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(held.state, "waiting-user");
        assert.strictEqual(
          held.waitingReason,
          "Pull request #7 changes protected paths: apps/web/AGENTS.md.",
        );
        assert.deepStrictEqual(held.controlViolations, [
          {
            pullRequest: { host: "github.com", repository: "acme/app", number: 7 },
            paths: ["apps/web/AGENTS.md"],
          },
        ]);
        assert.deepStrictEqual(fileReads, [
          { projectId: PROJECT_ID, host: "github.com", repository: "acme/app", number: 7 },
        ]);
        const leadText =
          "Pull request #7 changes protected paths (apps/web/AGENTS.md). Revert those changes; the factory cannot send this to the user as ready.";
        assert.deepStrictEqual(
          sentMessages.slice(sentBefore).map((message) => [message.threadId, message.text]),
          [[lead, leadText]],
        );
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), ["control"]);

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

  it.effect("lets the user's merge override the hold and starts the retro", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, sentMessages } = factory;
        const { manager, lead, mark, sentBefore } = yield* startedTeam(factory);
        pullRequestFiles.set(7, PROTECTED_FILES);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        yield* service.reconcileThread(lead);
        yield* service.claimComplete(lead, {
          evidence: "Tests pass.",
          pullRequests: [{ host: "github.com", repository: "acme/app", number: 7 }],
        });
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "waiting-user");
        // The workspace shows the claim and the paths the merge would override.
        const [held] = (yield* workspace(service)).assignments;
        assert.isString(held!.claimedAt);
        assert.deepStrictEqual(held!.controlViolations, [
          {
            pullRequest: { host: "github.com", repository: "acme/app", number: 7 },
            paths: ["apps/web/AGENTS.md"],
          },
        ]);

        yield* service.reconcileMerge({ repository: "acme/app", number: 7 });
        const merged = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(merged.state, "retro");
        assert.deepStrictEqual(merged.controlViolations, []);
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), ["control", "retro"]);
        assert.strictEqual(
          sentMessages.at(-1)!.text,
          "All pull requests for Ticket 1 are merged. Write your team retro now: what worked, what did not, what the next team should change, then call factory_retro_done.",
        );
        assert.strictEqual(sentMessages.length - sentBefore, 2);
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

  it.effect("skips the check for a team that may edit protected paths", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, fileReads, sentMessages } = factory;
        const { assignment, lead, sentBefore } = yield* startedTeam(factory);
        const sql = yield* SqlClient.SqlClient;
        // The snapshot an assignment keeps of a team from definitions, here an exempt one.
        const exempt = {
          preset: "workflow",
          members: [],
          definition: {
            id: "workflow",
            name: "Workflow",
            useWhen: "The ticket changes how work is checked.",
            workflow: "",
            mayEditProtectedPaths: true,
            createdBy: "user",
            lead: {
              id: "default",
              name: "Default lead",
              models: { dynamic: true, models: [] },
              instructions: "",
            },
            members: [
              {
                id: "implementer",
                name: "Implementer",
                models: { dynamic: true, models: [] },
                description: "Implement it.",
                count: 1,
              },
            ],
          },
        };
        yield* sql`UPDATE factory_assignments SET team_json=${JSON.stringify(exempt)}
            WHERE id=${assignment.id}`;
        pullRequestFiles.set(7, PROTECTED_FILES);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));

        yield* service.reconcileThread(lead);

        const unchecked = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(unchecked.state, "active");
        assert.deepStrictEqual(unchecked.controlViolations, []);
        assert.deepStrictEqual(fileReads, []);
        assert.deepStrictEqual(sentMessages.slice(sentBefore), []);
      }),
    ),
  );

  it.effect("leaves a pull request unchecked when its files cannot be read", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, fileReads, sentMessages, controls } =
          factory;
        const { manager, lead, mark, sentBefore } = yield* startedTeam(factory);
        pullRequestFiles.set(7, PROTECTED_FILES);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        controls.fileReadFailures = 1;

        yield* service.reconcileThread(lead);
        const unchanged = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(unchanged.state, "active");
        assert.deepStrictEqual(unchanged.controlViolations, []);
        assert.deepStrictEqual(sentMessages.slice(sentBefore), []);
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), []);

        yield* service.reconcileThread(lead);
        assert.strictEqual(fileReads.length, 2);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "waiting-user");
      }),
    ),
  );
});
