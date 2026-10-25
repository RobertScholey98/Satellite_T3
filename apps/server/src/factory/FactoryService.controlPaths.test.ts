import { assert, describe, it } from "@effect/vitest";
import type { FactoryAssignment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PROJECT_ID,
  withDatabase,
  idleRun,
  pullRequest,
  wakeReasons,
  makeTeamFactory,
  startedTeam,
  activeManager,
  setupDone,
  SYNC_WORK,
  DUO_TEAM,
  makeHarness,
  TEAM_FACTORY,
  workspace,
} from "./FactoryService.testkit.ts";

const PROTECTED_FILES = ["src/list.tsx", "apps/web/AGENTS.md", ".satellite/factory/roles/lead.md"];

type Service = Effect.Success<typeof makeTeamFactory>["service"];

const PR_7 = { host: "github.com", repository: "acme/app", number: 7 };

const decodeControlWake = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }));

/** The text of each control wake after `mark`, oldest first. */
const controlWakes = (service: Service, managerId: string, mark: number) =>
  service.listLog({ managerId }).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.sequence > mark && entry.kind === "wake")
        .filter((entry) => entry.reason === "control")
        .toReversed()
        .map((entry) => decodeControlWake(entry.payload).text),
    ),
  );

const answer = (
  service: Service,
  assignment: FactoryAssignment,
  askId: string,
  reply: "allow" | "decline",
  requestId: string,
) => service.answerProtectedPaths({ requestId, assignmentId: assignment.id, askId, answer: reply });

const askPaths = (assignment: FactoryAssignment) =>
  assignment.protectedPathAsks.map((ask) => [ask.paths, ask.state, ask.source]);

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
          "Pull request #7 changes protected paths (apps/web/AGENTS.md). The user can allow the flagged files for this assignment from the team's card. Keep an edit the task needs and wait for the user's answer; revert only an unintended edit or one the user declined. The factory cannot send this to the user as ready while unallowed protected changes remain.";
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
        // The claim wakes the manager at once, with the held paths it had not heard about yet.
        const managerText = `Assignment Ticket 1: ${leadText}

The lead of Ticket 1 claims it complete with acme/app#7 (head unknown). Check the evidence with factory_status; the user reviews and merges.`;
        assert.strictEqual(sentMessages.at(-1)!.threadId, manager.threadId);
        assert.strictEqual(sentMessages.at(-1)!.text, managerText);

        yield* service.reconcileThread(lead);
        assert.strictEqual(fileReads.length, 1);

        yield* service.sweep;
        assert.strictEqual(sentMessages.at(-1)!.text, managerText);

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
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), [
          "control",
          "claim",
          "retro",
        ]);
        assert.strictEqual(
          sentMessages.at(-1)!.text,
          "All pull requests for Ticket 1 are merged. Write your team retro now: what worked, what did not, what the next team should change, then call factory_retro_done.",
        );
        assert.strictEqual(sentMessages.length - sentBefore, 3);
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

  it.effect("records the protected files the manager asks for at commission", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, fileReads, sentMessages } = factory;
        const { manager, mark } = yield* setupDone(factory, yield* activeManager(factory));
        const refusal = (paths: ReadonlyArray<string>) =>
          service
            .commission(manager.threadId!, {
              ...SYNC_WORK,
              protectedPaths: { paths, reason: "The task rewrites the agent instructions." },
            })
            .pipe(
              Effect.flip,
              Effect.map((failure) => [failure.reason, failure.message]),
            );
        assert.deepStrictEqual(yield* refusal(["docs/*.md"]), [
          "invalid",
          "docs/*.md is a pattern. Name each protected file the team must edit exactly, without *, ? or [.",
        ]);
        assert.deepStrictEqual(yield* refusal(["AGENTS.md", "src/list.tsx"]), [
          "invalid",
          "src/list.tsx is not a protected path, so the team may edit it without asking.",
        ]);

        const assignment = yield* service.commission(manager.threadId!, {
          ...SYNC_WORK,
          protectedPaths: {
            paths: ["./AGENTS.md", "apps\\web\\AGENTS.md", "AGENTS.md"],
            reason: "The task rewrites the agent instructions.",
          },
        });
        assert.deepStrictEqual(
          assignment.protectedPathAsks.map(({ id: _id, createdAt: _at, ...ask }) => ask),
          [
            {
              paths: ["AGENTS.md", "apps/web/AGENTS.md"],
              reason: "The task rewrites the agent instructions.",
              source: "commission",
              pullRequest: null,
              state: "open",
              answeredAt: null,
            },
          ],
        );
        assert.deepStrictEqual(yield* wakeReasons(service, manager.id, mark), []);

        // An allowed file is not flagged, and no ask is added for it.
        const allowed = yield* answer(
          service,
          assignment,
          assignment.protectedPathAsks[0]!.id,
          "allow",
          "allow-1",
        );
        assert.deepStrictEqual(askPaths(allowed), [
          [["AGENTS.md", "apps/web/AGENTS.md"], "allowed", "commission"],
        ]);
        const lead = assignment.leadThreadId!;
        const sentBefore = sentMessages.length;
        pullRequestFiles.set(7, ["AGENTS.md", "src/list.tsx"]);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        yield* service.reconcileThread(lead);

        const unflagged = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(fileReads.length, 1);
        assert.strictEqual(unflagged.state, "active");
        assert.deepStrictEqual(unflagged.controlViolations, []);
        assert.deepStrictEqual(askPaths(unflagged), askPaths(allowed));
        assert.deepStrictEqual(sentMessages.slice(sentBefore), []);
      }),
    ),
  );

  it.effect("refuses an ask for a team that may already edit protected paths", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeHarness({
          config: TEAM_FACTORY,
          definitions: {
            teams: [
              DUO_TEAM,
              { ...DUO_TEAM, id: "workflow", name: "Workflow", mayEditProtectedPaths: true },
            ],
          },
        });
        const { manager } = yield* setupDone(factory, yield* activeManager(factory));
        const failure = yield* factory.service
          .commission(manager.threadId!, {
            ...SYNC_WORK,
            teamId: "workflow",
            protectedPaths: { paths: ["AGENTS.md"], reason: "The task rewrites the instructions." },
          })
          .pipe(Effect.flip);
        assert.deepStrictEqual(
          [failure.reason, failure.message],
          [
            "invalid",
            "Workflow may already edit protected paths, so it needs no ask; leave protectedPaths out.",
          ],
        );
      }),
    ),
  );

  it.effect("flags only the files not allowed, and returns to work once the last is allowed", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, sentMessages } = factory;
        const { manager, assignment, lead, mark, sentBefore } = yield* startedTeam(factory);
        pullRequestFiles.set(7, ["AGENTS.md", "src/list.tsx"]);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        yield* service.reconcileThread(lead);

        const held = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(held.state, "waiting-user");
        assert.deepStrictEqual(
          held.protectedPathAsks.map(({ id: _id, createdAt: _at, ...ask }) => ask),
          [
            {
              paths: ["AGENTS.md"],
              reason: "Pull request #7 changes these protected files.",
              source: "pull-request",
              pullRequest: PR_7,
              state: "open",
              answeredAt: null,
            },
          ],
        );

        const firstAsk = held.protectedPathAsks[0]!.id;
        const allowed = yield* answer(service, assignment, firstAsk, "allow", "allow-1");
        assert.strictEqual(allowed.state, "active");
        assert.isNull(allowed.waitingReason);
        assert.deepStrictEqual(allowed.controlViolations, []);
        // Answering again is a no-op: no second wake or message.
        yield* answer(service, assignment, firstAsk, "allow", "allow-again");
        assert.deepStrictEqual(yield* controlWakes(service, manager.id, mark), [
          "Pull request #7 changes protected paths (AGENTS.md). The user can allow the flagged files for this assignment from the team's card. Keep an edit the task needs and wait for the user's answer; revert only an unintended edit or one the user declined. The factory cannot send this to the user as ready while unallowed protected changes remain.",
          "The user allowed edits to these protected files for this assignment: AGENTS.md.",
        ]);
        assert.deepStrictEqual(
          sentMessages
            .slice(sentBefore)
            .filter((message) => message.threadId === lead)
            .map((message) => message.text)
            .slice(1),
          [
            "The user allowed edits to these protected files for this assignment: AGENTS.md. You may edit them for this assignment only. Tell any running worker who needs them.",
          ],
        );

        // Another protected file in the same pull request is still flagged.
        const secondMark = yield* service
          .listLog({ managerId: manager.id, limit: 1 })
          .pipe(Effect.map(([newest]) => newest!.sequence));
        pullRequestFiles.set(7, ["AGENTS.md", "apps/web/AGENTS.md"]);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-2")] }));
        yield* service.reconcileThread(lead);
        const flagged = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(flagged.state, "waiting-user");
        assert.strictEqual(
          flagged.waitingReason,
          "Pull request #7 changes protected paths: apps/web/AGENTS.md.",
        );
        assert.deepStrictEqual(flagged.controlViolations, [
          { pullRequest: PR_7, paths: ["apps/web/AGENTS.md"] },
        ]);
        assert.deepStrictEqual(askPaths(flagged), [
          [["AGENTS.md"], "allowed", "pull-request"],
          [["apps/web/AGENTS.md"], "open", "pull-request"],
        ]);
        // The workspace's team card and merge card read the same unallowed paths and asks.
        const [shown] = (yield* workspace(service)).assignments;
        assert.deepStrictEqual(shown!.controlViolations, flagged.controlViolations);
        assert.deepStrictEqual(shown!.protectedPathAsks, flagged.protectedPathAsks);
        assert.deepStrictEqual(yield* controlWakes(service, manager.id, secondMark), [
          "Pull request #7 changes protected paths (apps/web/AGENTS.md). Already allowed for this assignment: AGENTS.md. The user can allow the flagged files for this assignment from the team's card. Keep an edit the task needs and wait for the user's answer; revert only an unintended edit or one the user declined. The factory cannot send this to the user as ready while unallowed protected changes remain.",
        ]);

        const working = yield* answer(
          service,
          assignment,
          flagged.protectedPathAsks[1]!.id,
          "allow",
          "allow-2",
        );
        assert.strictEqual(working.state, "active");
        assert.deepStrictEqual(working.controlViolations, []);
      }),
    ),
  );

  it.effect("flags an allowed file again when the user revokes it", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, sentMessages } = factory;
        const { manager, assignment, lead } = yield* startedTeam(factory);
        pullRequestFiles.set(7, ["AGENTS.md"]);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        yield* service.reconcileThread(lead);
        const askId = (yield* service.assignmentForThread(lead))!.protectedPathAsks[0]!.id;
        yield* answer(service, assignment, askId, "allow", "allow-1");
        const mark = yield* service
          .listLog({ managerId: manager.id, limit: 1 })
          .pipe(Effect.map(([newest]) => newest!.sequence));
        const sentBefore = sentMessages.length;

        const revoked = yield* answer(service, assignment, askId, "decline", "revoke-1");
        assert.strictEqual(revoked.state, "waiting-user");
        assert.strictEqual(
          revoked.waitingReason,
          "Pull request #7 changes protected paths: AGENTS.md.",
        );
        assert.deepStrictEqual(revoked.controlViolations, [
          { pullRequest: PR_7, paths: ["AGENTS.md"] },
        ]);
        assert.deepStrictEqual(askPaths(revoked), [[["AGENTS.md"], "declined", "pull-request"]]);
        assert.deepStrictEqual(yield* controlWakes(service, manager.id, mark), [
          "The user revoked the allowance for these protected files: AGENTS.md.",
        ]);
        assert.deepStrictEqual(
          sentMessages.slice(sentBefore).map((message) => [message.threadId, message.text]),
          [
            [
              lead,
              "The user revoked the allowance for these protected files: AGENTS.md. Revert those edits.",
            ],
          ],
        );

        // A declined ask may still be allowed.
        const reallowed = yield* answer(service, assignment, askId, "allow", "allow-2");
        assert.strictEqual(reallowed.state, "active");
      }),
    ),
  );

  it.effect("tells the team once when the user declines, and never asks again for that file", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles, sentMessages } = factory;
        const { manager, assignment, lead } = yield* startedTeam(factory);
        pullRequestFiles.set(7, ["AGENTS.md"]);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        yield* service.reconcileThread(lead);
        const askId = (yield* service.assignmentForThread(lead))!.protectedPathAsks[0]!.id;
        const mark = yield* service
          .listLog({ managerId: manager.id, limit: 1 })
          .pipe(Effect.map(([newest]) => newest!.sequence));
        const sentBefore = sentMessages.length;
        const leadMessages = () =>
          sentMessages
            .slice(sentBefore)
            .filter((message) => message.threadId === lead)
            .map((message) => message.text);
        const push = (version: string, files: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            pullRequestFiles.set(7, files);
            threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, version)] }));
            yield* service.reconcileThread(lead);
          });
        const DECLINED_AGAIN =
          "The user declined edits to these protected files for this assignment, and pull request #7 still changes them: AGENTS.md. Revert them.";

        const declined = yield* answer(service, assignment, askId, "decline", "decline-1");
        assert.strictEqual(declined.state, "waiting-user");
        assert.deepStrictEqual(declined.controlViolations, [
          { pullRequest: PR_7, paths: ["AGENTS.md"] },
        ]);
        yield* answer(service, assignment, askId, "decline", "decline-again");
        assert.deepStrictEqual(leadMessages(), [
          "The user declined edits to these protected files for this assignment: AGENTS.md. Do not edit them, and revert any edit to them.",
        ]);

        // A new push that still changes the declined file tells the lead once, and only the lead.
        yield* push("push-2", ["AGENTS.md"]);
        yield* service.reconcileThread(lead);
        assert.deepStrictEqual(leadMessages().slice(1), [DECLINED_AGAIN]);

        // Reverted, then back in a later push: held again, and the lead hears once more.
        yield* push("push-3", []);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "active");
        yield* push("push-4", ["AGENTS.md", "src/list.tsx"]);
        yield* service.reconcileThread(lead);
        assert.deepStrictEqual(leadMessages().slice(1), [DECLINED_AGAIN, DECLINED_AGAIN]);

        const reflagged = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(reflagged.state, "waiting-user");
        assert.deepStrictEqual(reflagged.controlViolations, [
          { pullRequest: PR_7, paths: ["AGENTS.md"] },
        ]);
        assert.deepStrictEqual(askPaths(reflagged), [[["AGENTS.md"], "declined", "pull-request"]]);
        assert.deepStrictEqual(yield* controlWakes(service, manager.id, mark), [
          "The user declined edits to these protected files for this assignment: AGENTS.md.",
        ]);
      }),
    ),
  );

  it.effect("holds a revoked file again once a blocked assignment returns to work", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles } = factory;
        const { manager, assignment, lead } = yield* startedTeam(factory);
        const runs = idleRun({ pullRequests: [pullRequest(7, false, "push-1")] });
        pullRequestFiles.set(7, ["AGENTS.md"]);
        threadRuns.set(lead, runs);
        yield* service.reconcileThread(lead);
        const askId = (yield* service.assignmentForThread(lead))!.protectedPathAsks[0]!.id;
        yield* answer(service, assignment, askId, "allow", "allow-1");

        const dependency = yield* service.reportDependency(lead, {
          title: "Expose the sync cursor",
          brief: "Add the cursor to GET /sync.",
          unblockCondition: "GET /sync returns the cursor",
        });
        const revoked = yield* answer(service, assignment, askId, "decline", "revoke-1");
        assert.strictEqual(revoked.state, "blocked");

        const delivering = yield* service.commission(manager.threadId!, {
          title: "Sync cursor endpoint",
          brief: "Add the cursor to GET /sync.",
          completionCondition: "GET /sync returns the cursor.",
          complexity: "small",
          dependencyId: dependency.id,
        });
        yield* service.claimComplete(delivering.leadThreadId!, { evidence: "Endpoint shipped." });
        yield* service.retroDone(delivering.leadThreadId!);
        yield* service.complete(manager.threadId!, {
          assignmentId: delivering.id,
          teamVerdict: { fit: "good", reason: "Small team, quick turnaround." },
        });
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "active");

        // The pull request has not changed since its last check, so nothing is due to read.
        yield* service.reconcileThread(lead);
        const held = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(held.state, "waiting-user");
        assert.strictEqual(
          held.waitingReason,
          "Pull request #7 changes protected paths: AGENTS.md.",
        );

        const claimed = yield* service.claimComplete(lead, {
          evidence: "Tests pass.",
          pullRequests: [PR_7],
        });
        assert.strictEqual(claimed.state, "waiting-user");
        assert.strictEqual(claimed.waitingReason, held.waitingReason);
      }),
    ),
  );

  it.effect("settles a held claim once the user allows the last flagged files", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles } = factory;
        const { assignment, lead } = yield* startedTeam(factory);
        pullRequestFiles.set(7, ["AGENTS.md"]);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        yield* service.reconcileThread(lead);
        const claimed = yield* service.claimComplete(lead, {
          evidence: "Tests pass.",
          pullRequests: [PR_7],
        });
        assert.strictEqual(
          claimed.waitingReason,
          "Pull request #7 changes protected paths: AGENTS.md.",
        );

        const askId = claimed.protectedPathAsks[0]!.id;
        const settled = yield* answer(service, assignment, askId, "allow", "allow-1");
        assert.strictEqual(settled.state, "waiting-user");
        assert.strictEqual(settled.waitingReason, "Pull requests await the user's review: #7.");
        assert.deepStrictEqual(settled.controlViolations, []);
      }),
    ),
  );

  it.effect("leaves a spent recovery waiting on the user when a revoked file is held", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles } = factory;
        const { manager, assignment, lead } = yield* startedTeam(factory);
        const pullRequests = [pullRequest(7, false, "push-1")];
        pullRequestFiles.set(7, ["AGENTS.md"]);
        threadRuns.set(lead, idleRun({ pullRequests }));
        yield* service.reconcileThread(lead);
        const askId = (yield* service.assignmentForThread(lead))!.protectedPathAsks[0]!.id;
        yield* answer(service, assignment, askId, "allow", "allow-1");

        // The lead stalls, spends the one recovery, and stalls again.
        threadRuns.set(lead, idleRun({ pullRequests, latestRunStatus: "failed" }));
        yield* service.reconcileThread(lead);
        yield* service.recover(manager.threadId!, {
          assignmentId: assignment.id,
          action: "rebrief",
          brief: "Retry with the fixture.",
        });
        yield* service.reconcileThread(lead);
        assert.strictEqual((yield* service.assignmentForThread(lead))!.state, "stalled");

        const spent = yield* service.recover(manager.threadId!, {
          assignmentId: assignment.id,
          action: "rebrief",
          brief: "Split the work in two.",
        });
        assert.strictEqual(spent.state, "waiting-user");

        const revoked = yield* answer(service, assignment, askId, "decline", "revoke-1");
        assert.strictEqual(revoked.waitingReason, spent.waitingReason);
        yield* service.reconcileThread(lead);
        const waiting = (yield* service.assignmentForThread(lead))!;
        assert.strictEqual(waiting.state, "waiting-user");
        assert.strictEqual(
          waiting.waitingReason,
          "Recovery allowance used; the manager recommends: Split the work in two.",
        );
        assert.deepStrictEqual(waiting.controlViolations, [
          { pullRequest: PR_7, paths: ["AGENTS.md"] },
        ]);
      }),
    ),
  );

  it.effect("refuses an answer to an ask the assignment does not have", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { assignment } = yield* startedTeam(factory);
        const failure = yield* answer(
          factory.service,
          assignment,
          "no-such-ask",
          "allow",
          "allow-1",
        ).pipe(Effect.flip);
        assert.deepStrictEqual(
          [failure.reason, failure.message],
          ["not-found", "Ticket 1 has no protected-path ask no-such-ask."],
        );
      }),
    ),
  );

  it.effect("lists the allowed files in the briefs of the lead and its workers", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { service, threadRuns, pullRequestFiles } = factory;
        const { manager, assignment, lead } = yield* startedTeam(factory);
        const sql = yield* SqlClient.SqlClient;
        // A member whose description names the protected paths, as the starter workers' do.
        const team = {
          preset: DUO_TEAM.id,
          members: [],
          definition: {
            ...DUO_TEAM,
            members: DUO_TEAM.members.map((member) => ({
              ...member,
              description: `${member.description} Never touch:\n\n{{protectedPaths}}`,
            })),
          },
        };
        yield* sql`UPDATE factory_assignments SET team_json=${JSON.stringify(team)}
            WHERE id=${assignment.id}`;
        pullRequestFiles.set(7, ["AGENTS.md"]);
        threadRuns.set(lead, idleRun({ pullRequests: [pullRequest(7, false, "push-1")] }));
        yield* service.reconcileThread(lead);
        const askId = (yield* service.assignmentForThread(lead))!.protectedPathAsks[0]!.id;
        yield* answer(service, assignment, askId, "allow", "allow-1");

        const allowedSection =
          "- AGENTS.md\n\nThe user allowed you to edit these protected files for this assignment only:\n\n- AGENTS.md";
        const plan = yield* service.planDelegation(lead, {
          member: "Implementer",
          task: "Update AGENTS.md.",
        });
        assert.include(plan.task, `Implements the change. Never touch:\n\n${allowedSection}`);
        const leadBrief = yield* service.roleBrief(PROJECT_ID, "lead", manager.id, assignment.id);
        assert.include(leadBrief.text, allowedSection);
        const managerBrief = yield* service.roleBrief(
          PROJECT_ID,
          "manager",
          manager.id,
          assignment.id,
        );
        assert.notInclude(managerBrief.text, "The user allowed you");
      }),
    ),
  );
});
