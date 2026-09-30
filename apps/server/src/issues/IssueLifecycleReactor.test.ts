import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EnvironmentId, ProjectId, ThreadId, IssueOperationError } from "@t3tools/contracts";
import projectionMigration from "../persistence/Migrations/005_Projections.ts";
import issueMigration from "../persistence/Migrations/056_IssueBoards.ts";
import { makeIssueService } from "./IssueService.ts";
import { recoverStartedIssueAttempts } from "./IssueLifecycleReactor.ts";

describe("issue launch recovery", () => {
  it.effect(
    "recovers a lost post-send hook from durable provider acceptance, excludes queued work, and emits once across restart",
    () =>
      Effect.gen(function* () {
        yield* projectionMigration;
        yield* issueMigration;
        const sql = yield* SqlClient.SqlClient;
        const sourceEnvironmentId = EnvironmentId.make("source");
        const destinationEnvironmentId = EnvironmentId.make("destination");
        const projectId = ProjectId.make("destination-project");
        const unavailable = Effect.fail(
          new IssueOperationError({
            reason: "unavailable",
            message: "Host should not run during destination recovery.",
          }),
        );
        const options = {
          environmentId: destinationEnvironmentId,
          getProject: () => Effect.succeed(null),
          host: {
            list: () => unavailable,
            get: () => unavailable,
            listBoards: () => unavailable,
            board: () => unavailable,
            move: () => unavailable,
          },
        };
        const service = yield* makeIssueService(options);
        for (const id of ["accepted", "queued", "id-without-start", "start-without-id"]) {
          yield* service.attachAttempt({
            link: {
              attemptId: id,
              reservationId: `reservation-${id}`,
              boardId: "board",
              sourceEnvironmentId,
              destinationEnvironmentId,
              sourceProjectId: ProjectId.make("source-project"),
              sourceGeneration: 0,
              issue: {
                hostKind: "github",
                host: "github.com",
                repository: "owner/repo",
                id: id,
                number: 1,
                url: "https://github.com/owner/repo/issues/1",
              },
            },
            threadId: ThreadId.make(id),
            projectId,
            worktreePath: `/work/${id}`,
          });
          yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,started_at,checkpoint_files_json)
          VALUES(${id},${id === "queued" || id === "start-without-id" ? null : `provider-${id}`},${id === "queued" ? "pending" : "running"},'2026-09-30T12:00:00Z',${id === "queued" || id === "id-without-start" ? null : "2026-09-30T12:00:01Z"},'[]')`;
        }
        const restarted = yield* makeIssueService(options);
        yield* recoverStartedIssueAttempts(restarted.firstPromptSent);
        const receipts = yield* restarted.listReceipts({});
        assert.deepEqual(
          receipts.receipts.map((receipt) => [receipt.kind, receipt.threadId]),
          [["started", ThreadId.make("accepted")]],
        );
        yield* recoverStartedIssueAttempts(restarted.firstPromptSent);
        assert.equal((yield* restarted.listReceipts({})).receipts.length, 1);
        const attempts = yield* restarted.listAttempts({});
        assert.equal(
          attempts.find((attempt) => attempt.threadId === "accepted")?.status,
          "started",
        );
        assert.equal(attempts.find((attempt) => attempt.threadId === "queued")?.status, "attached");
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
