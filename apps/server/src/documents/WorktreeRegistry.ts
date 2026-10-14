import { OpenWorkOperationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { makeGitReader, type WorktreeIdentity } from "../openWork/GitReader.ts";

/**
 * The worktrees Satellite has seen, from Open work inventory or from a publication.
 */
export class WorktreeRegistry extends Context.Service<
  WorktreeRegistry,
  {
    readonly record: (worktree: WorktreeIdentity) => Effect.Effect<void, OpenWorkOperationError>;
    /** The registered worktree, failing when its path now belongs to another repository. */
    readonly require: (id: string) => Effect.Effect<WorktreeIdentity, OpenWorkOperationError>;
  }
>()("t3/documents/WorktreeRegistry") {
  static readonly layer = Layer.effect(
    WorktreeRegistry,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const git = yield* makeGitReader;
      const storage = () =>
        new OpenWorkOperationError({ reason: "storage", message: "Could not read worktrees." });
      const find = (id: string) =>
        sql<WorktreeIdentity>`SELECT id,common_dir AS "commonDir",path FROM open_worktrees WHERE id=${id}`.pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(storage),
        );
      const require = Effect.fn("WorktreeRegistry.require")(function* (id: string) {
        const registered = yield* find(id);
        if (!registered)
          return yield* new OpenWorkOperationError({
            reason: "not-found",
            message: "Worktree is unavailable. Refresh Open work.",
          });
        const identity = yield* git.identity(registered.path);
        if (identity.commonDir !== registered.commonDir)
          return yield* new OpenWorkOperationError({
            reason: "conflict",
            message: "This path now belongs to a different repository.",
          });
        return identity;
      });
      return WorktreeRegistry.of({
        record: (worktree) =>
          sql`INSERT INTO open_worktrees (id,common_dir,path) VALUES (${worktree.id},${worktree.commonDir},${worktree.path}) ON CONFLICT(id) DO NOTHING`.pipe(
            Effect.asVoid,
            Effect.mapError(storage),
          ),
        require,
      });
    }),
  );
}
