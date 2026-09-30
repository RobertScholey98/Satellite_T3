import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ThreadId, OpenWorkPublicationStep } from "@t3tools/contracts";
import { makeGitReader, type GitReader } from "./GitReader.ts";

export interface OpenWorkDocumentRow {
  id: string;
  worktree_id: string;
  title: string;
  source: "published" | "linked";
  document_id: string | null;
  revision_id: string | null;
  thread_id: string | null;
  folder_id: string | null;
  path: string | null;
  commit_sha: string | null;
  anchor_head: string | null;
  observed_at: string;
  favorite: number;
  available: number;
  unresolved: "history-diverged" | "creation-time-unavailable" | null;
  association_mode: "pending" | "unassigned";
}
export interface PublicationInput {
  documentId: string;
  revisionId: string;
  threadId: ThreadId;
  title: string;
  worktreePath: string;
  step?: OpenWorkPublicationStep;
}

export const reconcileDocumentLinks = (
  sql: SqlClient.SqlClient,
  git: GitReader,
  worktreeId: string,
  head: string | null,
) =>
  Effect.gen(function* () {
    const pending =
      yield* sql<OpenWorkDocumentRow>`SELECT * FROM open_work_documents WHERE worktree_id=${worktreeId} AND commit_sha IS NULL AND association_mode='pending'`;
    const anchors = new Map<string | null, { sha: string | null; diverged: boolean }>();
    for (const row of pending) {
      if (row.unresolved === "creation-time-unavailable") continue;
      let next = anchors.get(row.anchor_head);
      if (!next) {
        next = yield* git.firstNewCommit(worktreeId, row.anchor_head, head);
        anchors.set(row.anchor_head, next);
      }
      if (next.sha)
        yield* sql`UPDATE open_work_documents SET commit_sha=${next.sha},unresolved=NULL WHERE id=${row.id} AND commit_sha IS NULL`;
      else
        yield* sql`UPDATE open_work_documents SET unresolved=${next.diverged ? "history-diverged" : null} WHERE id=${row.id} AND commit_sha IS NULL`;
    }
  });

export const makePublicationRecorder = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const git = yield* makeGitReader;
  return Effect.fn("OpenWork.recordPublication")(function* (input: PublicationInput) {
    const identity = yield* git.identity(input.worktreePath).pipe(Effect.result);
    // Documents also belong to projects that have no Git repository.
    if (identity._tag === "Failure") {
      if (
        !input.step &&
        identity.failure.reason === "git" &&
        identity.failure.message === "The selected path is not a Git worktree."
      )
        return;
      return yield* identity.failure;
    }
    const worktree = identity.success;
    yield* sql`INSERT INTO open_worktrees (id,common_dir,path) VALUES (${worktree.id},${worktree.commonDir},${worktree.path}) ON CONFLICT(id) DO NOTHING`;
    const state = yield* git.state(worktree.path);
    yield* reconcileDocumentLinks(sql, git, worktree.id, state.head);
    const sha =
      input.step?.kind === "commit"
        ? yield* git.validateCommit(worktree.path, input.step.commitSha)
        : null;
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO open_work_documents (id,worktree_id,title,source,document_id,revision_id,thread_id,commit_sha,anchor_head,observed_at)
      VALUES (${`publication:${input.revisionId}`},${worktree.id},${input.title},'published',${input.documentId},${input.revisionId},${input.threadId},${sha},${state.head},${observedAt})`;
  });
});
