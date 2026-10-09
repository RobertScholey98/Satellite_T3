import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import ManagedDocuments from "./Migrations/055_ManagedDocuments.ts";
import IssueBoards from "./Migrations/056_IssueBoards.ts";
import OpenWork from "./Migrations/057_OpenWork.ts";
import IdeaNotebooks from "./Migrations/058_IdeaNotebooks.ts";
import IssueBoardSnapshots from "./Migrations/059_IssueBoardSnapshots.ts";
import RevdocTesting from "./Migrations/060_RevdocTesting.ts";
import CommitRecommendation from "./Migrations/061_ProjectionThreadsCommitRecommendation.ts";
import RequestLifecycleIndex from "./Migrations/062_ProjectionRequestLifecycleIndex.ts";

// Satellite already released migrations 55–62. Move upstream's V2 ledger
// entries out of those slots before installing Satellite's feature schemas.
export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53
      `;
      const legacy = history.find(
        (row) => row.name === "OrchestrationV2" && [53, 54, 55].includes(row.migration_id),
      );
      if (!legacy) return [];
      const valid = history.every(
        (row) =>
          row === legacy ||
          (row.migration_id === 53 && row.name === "PullRequestFilesViewed") ||
          (row.migration_id === 54 && row.name === "ProjectionThreadsAutoSettleDisabledAt") ||
          ([55, 56].includes(row.migration_id) &&
            row.name === "RemoveRedundantProjectionIndexes") ||
          (row.migration_id === 57 && row.name === "ScheduledTaskWebhooks") ||
          (row.migration_id === 58 && row.name === "WebhookRelayDeliveries"),
      );
      if (!valid) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (!history.some((row) => row.name === "PullRequestFilesViewed")) {
        yield* PullRequestFilesViewed;
        executed.push([53, "PullRequestFilesViewed"]);
      }
      if (!history.some((row) => row.name === "ProjectionThreadsAutoSettleDisabledAt")) {
        yield* AutoSettleDisabledAt;
        executed.push([54, "ProjectionThreadsAutoSettleDisabledAt"]);
      }
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 66 WHERE migration_id = 58 AND name = 'WebhookRelayDeliveries'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 65 WHERE migration_id = 57 AND name = 'ScheduledTaskWebhooks'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 64 WHERE migration_id IN (55, 56) AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 63 WHERE migration_id = ${legacy.migration_id} AND name = 'OrchestrationV2'`;
      if (!history.some((row) => row.name === "PullRequestFilesViewed")) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')`;
      }
      if (!history.some((row) => row.name === "ProjectionThreadsAutoSettleDisabledAt")) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')`;
      }
      const forkMigrations = [
        [55, "ManagedDocuments", ManagedDocuments],
        [56, "IssueBoards", IssueBoards],
        [57, "OpenWork", OpenWork],
        [58, "IdeaNotebooks", IdeaNotebooks],
        [59, "IssueBoardSnapshots", IssueBoardSnapshots],
        [60, "RevdocTesting", RevdocTesting],
        [61, "ProjectionThreadsCommitRecommendation", CommitRecommendation],
        [62, "ProjectionRequestLifecycleIndex", RequestLifecycleIndex],
      ] as const;
      for (const [id, name, migration] of forkMigrations) {
        yield* migration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        executed.push([id, name]);
      }
      return executed;
    }),
  );
});
