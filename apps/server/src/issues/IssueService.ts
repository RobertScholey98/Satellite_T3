// @effect-diagnostics nodeBuiltinImport:off - Hashes board ids and stored copies.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  IssueAttempt,
  IssueBoardColumn,
  IssueBoardItem,
  IssueBoardLocator,
  IssueBoardMapping,
  IssueBoardSummary,
  IssueMove,
  IssueOperationError,
  IssuePullRequestRef,
  IssueRef,
  issueReadyColumnIds,
  type IssueAttemptsEndInput,
  type IssueAttemptsListInput,
  type IssueAttemptsResumeInput,
  type IssueAttemptsStartInput,
  type IssueAttemptsStartResult,
  type IssueBoardSync,
  type IssueBoardSyncEvent,
  type IssueBoardView,
  type IssueBoardsConfigureInput,
  type IssueBoardsDisconnectInput,
  type IssueBoardsListInput,
  type IssueBoardsMoveInput,
  type IssueBoardsOpenInput,
  type IssueBoardsSubscribeInput,
  type IssueDetail,
  type IssueMovesRetryInput,
  type IssuesGetInput,
  type IssuesListInput,
  type IssuesListResult,
  type ModelSelection,
  type OrchestrationProjectShell,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type {
  IssueHostAdapter,
  IssueHostBoards,
  IssueHostScope,
  RemoteIssueBoard,
} from "@t3tools/source-control-core/server/IssueHostAdapter";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  controllingPullRequestOf,
  deriveStage,
  firstRunProgress,
  pullRequestKey,
  stageColumn,
  type AttemptStage,
  type FirstRunProgress,
} from "./attemptStage.ts";
import { canonicalIssueKey, IssueHost, repositoryIssueScope } from "./IssueHost.ts";
import {
  automaticMovesState,
  decideAutomaticMove,
  decideManualMove,
  isTransientFailure,
  MOVE_RETRY_WINDOW_MS,
  moveRetryDelayMs,
} from "./moveReconciliation.ts";

/** What the attempt reconciler reads from a thread. */
export interface IssueThreadFacts {
  readonly deleted: boolean;
  readonly worktreePath: string | null;
  readonly firstRun: FirstRunProgress;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}

/** Upstream's thread launch, as the issue service calls it. */
export interface IssueThreadLaunch {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly text: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface IssueServiceDependencies {
  readonly hosts: IssueHost["Service"];
  readonly getProject: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProjectShell | null, IssueOperationError>;
  readonly resolveRepositoryIdentity?: (
    cwd: string,
  ) => Effect.Effect<OrchestrationProjectShell["repositoryIdentity"] | null>;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<IssueThreadFacts | null>;
  readonly allocateThreadId: (projectId: ProjectId) => Effect.Effect<ThreadId, IssueOperationError>;
  readonly launchThread: (input: IssueThreadLaunch) => Effect.Effect<void, IssueOperationError>;
}

/** The ticket an agent's thread is working, as the MCP read tool returns it. */
export interface IssueThreadTicket {
  readonly ticket: IssueDetail;
  readonly column: string | null;
  readonly attempt: IssueAttempt;
  /** `stored-copy` when the host was unreachable and body and comments are unavailable. */
  readonly source: "host" | "stored-copy";
}

export interface IssueServiceShape {
  readonly list: (input: IssuesListInput) => Effect.Effect<IssuesListResult, IssueOperationError>;
  readonly get: (input: IssuesGetInput) => Effect.Effect<IssueDetail, IssueOperationError>;
  readonly listBoards: (
    input: IssueBoardsListInput,
  ) => Effect.Effect<ReadonlyArray<IssueBoardSummary>, IssueOperationError>;
  readonly openBoard: (
    input: IssueBoardsOpenInput,
  ) => Effect.Effect<IssueBoardView, IssueOperationError>;
  readonly subscribeBoard: (
    input: IssueBoardsSubscribeInput,
  ) => Stream.Stream<IssueBoardSyncEvent, IssueOperationError>;
  readonly configureBoard: (
    input: IssueBoardsConfigureInput,
  ) => Effect.Effect<IssueBoardView, IssueOperationError>;
  readonly disconnectBoard: (
    input: IssueBoardsDisconnectInput,
  ) => Effect.Effect<void, IssueOperationError>;
  readonly move: (input: IssueBoardsMoveInput) => Effect.Effect<IssueMove, IssueOperationError>;
  readonly retryMove: (
    input: IssueMovesRetryInput,
  ) => Effect.Effect<IssueMove, IssueOperationError>;
  readonly listAttempts: (
    input: IssueAttemptsListInput,
  ) => Effect.Effect<ReadonlyArray<IssueAttempt>, IssueOperationError>;
  readonly startAttempt: (
    input: IssueAttemptsStartInput,
  ) => Effect.Effect<IssueAttemptsStartResult, IssueOperationError>;
  readonly endAttempt: (
    input: IssueAttemptsEndInput,
  ) => Effect.Effect<IssueAttempt, IssueOperationError>;
  readonly resumeAttempt: (
    input: IssueAttemptsResumeInput,
  ) => Effect.Effect<IssueAttempt, IssueOperationError>;
  /** The active attempt's ticket for a thread, or its most recent attempt's; null without one. */
  readonly threadTicket: (
    threadId: ThreadId,
  ) => Effect.Effect<IssueThreadTicket | null, IssueOperationError>;
  /** Brings the thread's attempts up to date with the thread and queues their automatic moves. */
  readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void, IssueOperationError>;
  /** Reconciles every running attempt and applies due moves. Recovers events missed while down. */
  readonly sweep: Effect.Effect<void, IssueOperationError>;
  /** Queues a refresh for watched or worked boards whose stored copy is older than five minutes. */
  readonly refreshStaleBoards: Effect.Effect<void, IssueOperationError>;
  readonly drainRefreshes: Effect.Effect<void>;
}

export class IssueService extends Context.Service<IssueService, IssueServiceShape>()(
  "t3/issues/IssueService",
) {}

const error = (reason: IssueOperationError["reason"], message: string) =>
  new IssueOperationError({ reason, message });
const storageError = () => error("storage", "Could not read or save issue tracking state.");
const isIssueError = Schema.is(IssueOperationError);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const hash = (value: unknown) => digest(json(value));
const decodeBoardValue = Schema.decodeEffect(IssueBoardSummary);
const decodeAttemptValue = Schema.decodeUnknownEffect(IssueAttempt);
const decodeMoveValue = Schema.decodeUnknownEffect(IssueMove);
const parse = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(storageError));
const RemoteBoard = Schema.Struct({
  title: Schema.String,
  locator: IssueBoardLocator,
  columns: Schema.Array(IssueBoardColumn),
  items: Schema.Array(IssueBoardItem),
});

const FRESH_WINDOW_MS = 30_000;
const STALE_WINDOW_MS = 5 * 60_000;
const TICKET_TEXT_LIMIT = 32 * 1024;
const TICKET_COMMENT_LIMIT = 20;

interface BoardRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly locator_json: string;
  readonly mapping_json: string;
}
interface SyncRow {
  readonly revision: number;
  readonly synced_at: string;
  readonly failed_at: string | null;
  readonly failure: string | null;
}
interface SnapshotRow extends SyncRow {
  readonly board_json: string;
}
interface AttemptRow {
  readonly id: string;
  readonly board_id: string;
  readonly issue_key: string;
  readonly issue_json: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly worktree_path: string | null;
  readonly status: string;
  readonly active: number;
  readonly ended_reason: string | null;
  readonly baseline_column_id: string | null;
  readonly start_column_id: string | null;
  readonly transition_index: number;
  readonly controlling_pr_key: string | null;
  readonly controlling_pr_json: string | null;
  readonly launch_request_id: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
}
interface MoveRow {
  readonly sequence: number;
  readonly id: string;
  readonly request_key: string;
  readonly board_id: string;
  readonly issue_key: string;
  readonly issue_json: string;
  readonly column_id: string;
  readonly attempt_id: string | null;
  readonly origin: "manual" | "automatic";
  readonly status: string;
  readonly error: string | null;
  readonly retry_at: string | null;
  readonly created_at: string;
}

const attemptedAt = (row: SyncRow) =>
  Math.max(Date.parse(row.synced_at), row.failed_at === null ? 0 : Date.parse(row.failed_at));
const automaticRequestKey = (attemptId: string, transitionIndex: number) =>
  `auto:${attemptId}:${transitionIndex}`;
const LIVE_STAGES = new Set(["launching", "working", "in-pr", "merged"]);

/** Board ids are derived from project and locator, so reconnecting a board finds its attempts. */
export const issueBoardId = (projectId: ProjectId, locator: IssueBoardLocator) =>
  `board-${hash([
    projectId,
    locator.kind === "github-project"
      ? [
          locator.kind,
          locator.host.toLowerCase(),
          locator.owner.toLowerCase(),
          locator.ownerKind,
          locator.projectNumber,
        ]
      : [
          locator.kind,
          locator.host.toLowerCase(),
          locator.organization.toLowerCase(),
          locator.project,
          locator.team,
          locator.boardId,
        ],
  ]).slice(0, 24)}`;

/** The ticket text an attempt's first message carries. */
const attachedIssueBlock = (detail: Pick<IssueDetail, "ref" | "title" | "body">) =>
  `\n\n<attached_issue>\nRepository host: ${detail.ref.host}\nIssue: #${detail.ref.number} ${detail.title}\nURL: ${detail.ref.url}\n\n${detail.body}\n</attached_issue>`;

export const makeIssueService = (deps: IssueServiceDependencies) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mutex = yield* Semaphore.make(1);
    const preserveError = (cause: unknown) => (isIssueError(cause) ? cause : storageError());
    const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError(preserveError));
    const lock = <A, E, R>(effect: Effect.Effect<A, E, R>) => protect(mutex.withPermits(1)(effect));
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      protect(sql.withTransaction(effect));
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const syncing = new Set<string>();
    const subscribers = new Map<string, number>();
    const changes = yield* PubSub.unbounded<IssueBoardSyncEvent>();

    const boardsHost = (
      locator: IssueBoardLocator,
    ): Effect.Effect<IssueHostBoards, IssueOperationError> => {
      const found = deps.hosts.forBoard(locator);
      return found
        ? Effect.succeed(found)
        : Effect.fail(error("unavailable", "This repository host does not expose this board."));
    };
    const issueHost = (
      scope: IssueHostScope,
    ): Effect.Effect<IssueHostAdapter, IssueOperationError> => {
      const found = deps.hosts.forHost(scope.ref.hostKind);
      return found
        ? Effect.succeed(found)
        : Effect.fail(error("unavailable", "This repository host does not expose issues."));
    };
    const host = {
      readBoard: (cwd: string, locator: IssueBoardLocator) =>
        boardsHost(locator).pipe(Effect.flatMap((found) => found.read(cwd, locator))),
      readItem: (cwd: string, locator: IssueBoardLocator, item: IssueBoardItem) =>
        boardsHost(locator).pipe(Effect.flatMap((found) => found.readItem(cwd, locator, item))),
      move: (cwd: string, locator: IssueBoardLocator, item: IssueBoardItem, columnId: string) =>
        boardsHost(locator).pipe(
          Effect.flatMap((found) => found.move(cwd, locator, item, columnId)),
        ),
    };

    const project = Effect.fnUntraced(function* (id: ProjectId) {
      const value = yield* deps.getProject(id);
      if (!value) return yield* error("not-found", "The selected project is unavailable.");
      return value;
    });
    const scope = Effect.fnUntraced(function* (projectId: ProjectId) {
      const value = yield* project(projectId);
      // Imported projects can lack a saved identity even when their checkout has a remote.
      let identity = value.repositoryIdentity;
      if (
        (!identity?.provider || identity.provider === "unknown") &&
        deps.resolveRepositoryIdentity
      )
        identity = (yield* deps.resolveRepositoryIdentity(value.workspaceRoot)) ?? identity;
      return yield* repositoryIssueScope(value.workspaceRoot, identity);
    });

    const decodeBoard = Effect.fnUntraced(function* (row: BoardRow) {
      return yield* decodeBoardValue({
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        locator: yield* parse(IssueBoardLocator, row.locator_json),
        mapping: yield* parse(Schema.NullOr(IssueBoardMapping), row.mapping_json),
      }).pipe(Effect.mapError(storageError));
    });
    const findBoard = Effect.fnUntraced(function* (id: string) {
      const rows = yield* sql<BoardRow>`SELECT * FROM issue_boards WHERE id=${id}`;
      return rows[0] ? yield* decodeBoard(rows[0]) : null;
    });
    const readBoard = Effect.fnUntraced(function* (id: string) {
      const board = yield* findBoard(id);
      if (!board) return yield* error("not-found", "This board is no longer connected.");
      return board;
    });
    const readSnapshot = Effect.fnUntraced(function* (boardId: string) {
      const rows =
        yield* sql<SnapshotRow>`SELECT * FROM issue_board_snapshots WHERE board_id=${boardId}`;
      return rows[0];
    });
    const readSync = Effect.fnUntraced(function* (boardId: string) {
      const rows = yield* sql<SyncRow>`SELECT revision,synced_at,failed_at,failure
        FROM issue_board_snapshots WHERE board_id=${boardId}`;
      return rows[0];
    });
    const storedBoard = Effect.fnUntraced(function* (boardId: string) {
      const row = yield* readSnapshot(boardId);
      return row ? yield* parse(RemoteBoard, row.board_json) : null;
    });
    const syncOf = (boardId: string, row: SyncRow): IssueBoardSync => ({
      revision: row.revision,
      syncedAt: row.synced_at,
      syncing: syncing.has(boardId),
      failure: row.failed_at === null ? null : { at: row.failed_at, message: row.failure ?? "" },
    });
    const syncEvent = Effect.fnUntraced(function* (boardId: string) {
      const row = yield* readSync(boardId);
      return { boardId, sync: row ? syncOf(boardId, row) : null } satisfies IssueBoardSyncEvent;
    });
    const publish = (boardId: string) =>
      syncEvent(boardId).pipe(Effect.flatMap((event) => PubSub.publish(changes, event)));
    /** Attempts and moves live outside the stored copy; a new revision tells clients to reopen. */
    const bumpRevision = Effect.fnUntraced(function* (boardId: string) {
      yield* sql`UPDATE issue_board_snapshots SET revision=revision+1 WHERE board_id=${boardId}`;
      yield* publish(boardId);
    });

    const prepareSnapshot = Effect.fnUntraced(function* (
      boardId: string,
      remote: RemoteIssueBoard,
    ) {
      const board = json(remote);
      const rows = yield* sql<{ revision: number; content_hash: string }>`
        SELECT revision,content_hash FROM issue_board_snapshots WHERE board_id=${boardId}`;
      return { board, contentHash: digest(board), at: yield* now, stored: rows[0] };
    });
    const upsertSnapshot = Effect.fnUntraced(function* (boardId: string, remote: RemoteIssueBoard) {
      const { board, contentHash, at, stored } = yield* prepareSnapshot(boardId, remote);
      if (stored?.content_hash === contentHash) {
        yield* sql`UPDATE issue_board_snapshots SET synced_at=${at},failed_at=NULL,failure=NULL
          WHERE board_id=${boardId}`;
        return;
      }
      const rows =
        yield* sql`INSERT INTO issue_board_snapshots(board_id,revision,content_hash,board_json,synced_at)
        SELECT ${boardId},1,${contentHash},${board},${at} WHERE EXISTS (SELECT 1 FROM issue_boards WHERE id=${boardId})
        ON CONFLICT(board_id) DO UPDATE SET
          revision=issue_board_snapshots.revision+1,content_hash=excluded.content_hash,board_json=excluded.board_json,
          synced_at=excluded.synced_at,failed_at=NULL,failure=NULL
        RETURNING board_id`;
      if (rows.length) yield* publish(boardId);
    });
    /** Stores a refresh only if nothing changed the copy since the refresh began reading. */
    const storeRefresh = Effect.fnUntraced(function* (
      boardId: string,
      expectedRevision: number,
      remote: RemoteIssueBoard,
    ) {
      const { board, contentHash, at, stored } = yield* prepareSnapshot(boardId, remote);
      if (stored?.revision !== expectedRevision) return;
      if (stored.content_hash === contentHash) {
        yield* sql`UPDATE issue_board_snapshots SET synced_at=${at},failed_at=NULL,failure=NULL
          WHERE board_id=${boardId} AND revision=${expectedRevision}`;
        return;
      }
      const rows = yield* sql`UPDATE issue_board_snapshots SET
        revision=revision+1,content_hash=${contentHash},board_json=${board},synced_at=${at},failed_at=NULL,failure=NULL
        WHERE board_id=${boardId} AND revision=${expectedRevision} RETURNING board_id`;
      if (rows.length) yield* publish(boardId);
    });
    /** Writes one confirmed item into the stored copy, so the board shows a move without a full read. */
    const storeItem = Effect.fnUntraced(function* (boardId: string, item: IssueBoardItem) {
      const remote = yield* storedBoard(boardId);
      if (!remote) return;
      const key = canonicalIssueKey(item.issue.ref);
      const known = remote.items.some((entry) => canonicalIssueKey(entry.issue.ref) === key);
      yield* upsertSnapshot(boardId, {
        ...remote,
        items: known
          ? remote.items.map((entry) => (canonicalIssueKey(entry.issue.ref) === key ? item : entry))
          : [...remote.items, item],
      });
    });

    const refreshBoard = (boardId: string) =>
      Effect.gen(function* () {
        const row = yield* readSync(boardId);
        if (!row) return;
        const board = yield* readBoard(boardId);
        const remote = yield* project(board.projectId).pipe(
          Effect.flatMap((value) => host.readBoard(value.workspaceRoot, board.locator)),
          Effect.result,
        );
        if (remote._tag === "Success")
          return yield* storeRefresh(boardId, row.revision, remote.success);
        yield* sql`UPDATE issue_board_snapshots SET failed_at=${yield* now},failure=${remote.failure.message}
          WHERE board_id=${boardId} AND revision=${row.revision}`;
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("issue board refresh failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.ensuring(
          Effect.sync(() => syncing.delete(boardId)).pipe(
            Effect.andThen(publish(boardId)),
            Effect.ignore,
          ),
        ),
      );
    const refreshes = yield* makeDrainableWorker(refreshBoard);
    const requestRefresh = (boardId: string) =>
      Effect.suspend(() => {
        if (syncing.has(boardId)) return Effect.void;
        syncing.add(boardId);
        return publish(boardId).pipe(Effect.andThen(refreshes.enqueue(boardId)));
      });

    const requestReplay = Effect.fnUntraced(function* (requestId: string, payload: unknown) {
      const rows = yield* sql<{ payload_hash: string; result_json: string }>`
        SELECT * FROM issue_requests WHERE request_id=${requestId}`;
      if (rows[0] && rows[0].payload_hash !== hash(payload))
        return yield* error(
          "conflict",
          "This request ID was already used for a different issue operation.",
        );
      return rows[0]?.result_json ?? null;
    });
    const remember = (requestId: string, payload: unknown, result: unknown) =>
      sql`INSERT INTO issue_requests(request_id,payload_hash,result_json)
        VALUES(${requestId},${hash(payload)},${json(result)})`;

    const decodeMove = Effect.fnUntraced(function* (row: MoveRow) {
      return yield* decodeMoveValue({
        id: row.id,
        boardId: row.board_id,
        issue: yield* parse(IssueRef, row.issue_json),
        columnId: row.column_id,
        origin: row.origin,
        attemptId: row.attempt_id,
        status: row.status,
        error: row.error,
        createdAt: row.created_at,
      }).pipe(Effect.mapError(storageError));
    });
    const readMove = Effect.fnUntraced(function* (id: string) {
      const rows = yield* sql<MoveRow>`SELECT * FROM issue_moves WHERE id=${id}`;
      if (!rows[0]) return yield* error("not-found", "The board move was not found.");
      return yield* decodeMove(rows[0]);
    });

    const readAttemptRow = Effect.fnUntraced(function* (id: string) {
      const rows = yield* sql<AttemptRow>`SELECT * FROM issue_board_attempts WHERE id=${id}`;
      if (!rows[0]) return yield* error("not-found", "This issue attempt was not found.");
      return rows[0];
    });
    const decodeAttempts = Effect.fnUntraced(function* (rows: ReadonlyArray<AttemptRow>) {
      const copies = new Map<
        string,
        { board: typeof RemoteBoard.Type | null; ready: ReadonlyArray<string> }
      >();
      const attempts: IssueAttempt[] = [];
      for (const row of rows) {
        let copy = copies.get(row.board_id);
        if (!copy) {
          const board = yield* findBoard(row.board_id);
          copy = {
            board: board ? yield* storedBoard(row.board_id) : null,
            ready: board?.mapping ? issueReadyColumnIds(board.mapping) : [],
          };
          copies.set(row.board_id, copy);
        }
        const pending = yield* sql<{ column_id: string }>`SELECT column_id FROM issue_moves
          WHERE attempt_id=${row.id} AND origin='automatic' AND status='pending' ORDER BY sequence DESC LIMIT 1`;
        const storedColumn = copy.board?.items.find(
          (item) => canonicalIssueKey(item.issue.ref) === row.issue_key,
        )?.columnId;
        attempts.push(
          yield* decodeAttemptValue({
            id: row.id,
            boardId: row.board_id,
            issue: yield* parse(IssueRef, row.issue_json),
            projectId: row.project_id,
            threadId: row.thread_id,
            worktreePath: row.worktree_path,
            status: row.status,
            active: row.active === 1,
            endedReason: row.ended_reason,
            automaticMoves: automaticMovesState({
              active: row.active === 1,
              storedColumn,
              baseline: row.baseline_column_id,
              readyColumns: copy.ready,
              pendingTarget: pending[0]?.column_id ?? null,
            }),
            createdAt: row.created_at,
            startedAt: row.started_at,
            controllingPullRequest:
              row.controlling_pr_json === null
                ? null
                : yield* parse(IssuePullRequestRef, row.controlling_pr_json),
          }).pipe(Effect.mapError(storageError)),
        );
      }
      return attempts;
    });
    const readAttempt = (id: string) =>
      readAttemptRow(id).pipe(
        Effect.flatMap((row) => decodeAttempts([row])),
        Effect.map((attempts) => attempts[0]!),
      );
    const listAttempts: IssueServiceShape["listAttempts"] = (input) =>
      protect(
        Effect.gen(function* () {
          const issueKey = input.issue ? canonicalIssueKey(input.issue) : null;
          const rows = yield* sql<AttemptRow>`SELECT * FROM issue_board_attempts
            WHERE (${input.boardId ?? null} IS NULL OR board_id=${input.boardId ?? null})
            AND (${input.threadId ?? null} IS NULL OR thread_id=${input.threadId ?? null})
            AND (${issueKey} IS NULL OR issue_key=${issueKey})
            ORDER BY active DESC, created_at DESC`;
          return yield* decodeAttempts(rows);
        }),
      );

    /** Finds the board item for a ticket in the stored copy, reading the board when it is missing. */
    const locateItem = Effect.fnUntraced(function* (
      boardId: string,
      cwd: string,
      locator: IssueBoardLocator,
      issueKey: string,
    ) {
      const stored = yield* storedBoard(boardId);
      const known = stored?.items.find((item) => canonicalIssueKey(item.issue.ref) === issueKey);
      if (known) return known;
      const remote = yield* host.readBoard(cwd, locator);
      yield* upsertSnapshot(boardId, remote);
      const item = remote.items.find((entry) => canonicalIssueKey(entry.issue.ref) === issueKey);
      if (!item) return yield* error("not-found", "The issue is no longer on this board.");
      return item;
    });
    const freshItem = Effect.fnUntraced(function* (
      boardId: string,
      cwd: string,
      locator: IssueBoardLocator,
      issueKey: string,
    ) {
      return yield* host.readItem(cwd, locator, yield* locateItem(boardId, cwd, locator, issueKey));
    });

    const enqueueMove = Effect.fnUntraced(function* (input: {
      readonly requestKey: string;
      readonly boardId: string;
      readonly issue: IssueRef;
      readonly columnId: string;
      readonly attemptId: string | null;
      readonly origin: "manual" | "automatic";
    }) {
      const existing =
        yield* sql<MoveRow>`SELECT * FROM issue_moves WHERE request_key=${input.requestKey}`;
      if (existing[0]) return existing[0].id;
      const key = canonicalIssueKey(input.issue);
      if (input.origin === "manual")
        yield* sql`UPDATE issue_moves SET status='superseded',error=NULL
          WHERE board_id=${input.boardId} AND issue_key=${key} AND status IN ('pending','failed')`;
      const id = NodeCrypto.randomUUID();
      yield* sql`INSERT INTO issue_moves(id,request_key,board_id,issue_key,issue_json,column_id,attempt_id,origin,status,error,created_at)
        VALUES(${id},${input.requestKey},${input.boardId},${key},${json(input.issue)},${input.columnId},${input.attemptId},${input.origin},'pending',NULL,${yield* now})`;
      return id;
    });

    const settleMove = (
      id: string,
      status: "applied" | "failed" | "skipped" | "superseded",
      reason: string | null,
    ) => sql`UPDATE issue_moves SET status=${status},error=${reason},retry_at=NULL WHERE id=${id}`;

    /** Applies one pending move against the remote board. */
    const processMove = Effect.fnUntraced(function* (move: MoveRow) {
      const board = yield* findBoard(move.board_id);
      if (!board) return yield* settleMove(move.id, "superseded", null);
      const outcome = yield* Effect.gen(function* () {
        const cwd = (yield* project(board.projectId)).workspaceRoot;
        let attempt: AttemptRow | undefined;
        if (move.origin === "automatic") {
          attempt =
            (yield* sql<AttemptRow>`SELECT * FROM issue_board_attempts WHERE id=${move.attempt_id}`)[0];
          if (
            !attempt ||
            attempt.active !== 1 ||
            move.request_key !== automaticRequestKey(attempt.id, attempt.transition_index)
          )
            return { status: "superseded" as const, reason: null };
        }
        const remote = yield* freshItem(board.id, cwd, board.locator, move.issue_key);
        const columns = (yield* storedBoard(board.id))?.columns ?? [];
        if (!columns.some((column) => column.id === move.column_id))
          return yield* error(
            "invalid",
            "The configured board column no longer exists. Reconfigure this board.",
          );
        if (attempt) {
          const manual = yield* sql`SELECT 1 FROM issue_moves WHERE board_id=${move.board_id}
            AND issue_key=${move.issue_key} AND origin='manual' AND status IN ('pending','failed')`;
          const decision = decideAutomaticMove({
            attemptActive: true,
            latestTransition: true,
            pendingManualMove: manual.length > 0,
            remoteColumn: remote.columnId,
            target: move.column_id,
            baseline: attempt.baseline_column_id,
            readyColumns: board.mapping ? issueReadyColumnIds(board.mapping) : [],
            columnTitle: (id) => columns.find((column) => column.id === id)?.title ?? "no column",
          });
          if (decision._tag === "Skipped") {
            yield* storeItem(board.id, remote);
            return { status: "skipped" as const, reason: decision.reason };
          }
          if (decision._tag === "Superseded")
            return { status: "superseded" as const, reason: null };
        }
        if (remote.columnId !== move.column_id)
          yield* host.move(cwd, board.locator, remote, move.column_id);
        const confirmed = yield* host.readItem(cwd, board.locator, remote);
        yield* storeItem(board.id, confirmed);
        if (confirmed.columnId !== move.column_id)
          return yield* error(
            "conflict",
            "The repository host has not confirmed the ticket move. Retry to recheck its placement.",
          );
        if (move.attempt_id !== null)
          yield* sql`UPDATE issue_board_attempts SET baseline_column_id=${move.column_id} WHERE id=${move.attempt_id}`;
        return { status: "applied" as const, reason: null };
      }).pipe(Effect.result);
      if (outcome._tag === "Success")
        return yield* settleMove(move.id, outcome.success.status, outcome.success.reason);
      const failure = preserveError(outcome.failure);
      const waited = (yield* nowMillis) - Date.parse(move.created_at);
      if (isTransientFailure(failure) && waited < MOVE_RETRY_WINDOW_MS) {
        const retryAt = DateTime.formatIso(
          DateTime.makeUnsafe((yield* nowMillis) + moveRetryDelayMs(waited)),
        );
        return yield* sql`UPDATE issue_moves SET error=${failure.message},retry_at=${retryAt} WHERE id=${move.id}`;
      }
      yield* settleMove(move.id, "failed", failure.message);
    });
    /** Applies due moves in order. All boards share one queue, so moves on a board never interleave. */
    const flushLocked = (filter?: { readonly id: string }) =>
      Effect.gen(function* () {
        const at = yield* now;
        const pending = yield* sql<MoveRow>`SELECT * FROM issue_moves WHERE status='pending'
          AND (${filter?.id ?? null} IS NOT NULL AND id=${filter?.id ?? null}
            OR ${filter?.id ?? null} IS NULL AND (retry_at IS NULL OR retry_at<=${at}))
          ORDER BY sequence`;
        const touched = new Set<string>();
        for (const move of pending) {
          yield* processMove(move);
          touched.add(move.board_id);
        }
        for (const boardId of touched) yield* bumpRevision(boardId);
      });

    const threadFacts = Effect.fnUntraced(function* (row: AttemptRow) {
      return yield* deps.readThread(ThreadId.make(row.thread_id));
    });
    /** Records the attempt's derived stage and queues the automatic move for a new stage. */
    const reconcileRow = Effect.fnUntraced(function* (row: AttemptRow) {
      if (!LIVE_STAGES.has(row.status) || (row.status !== "launching" && row.active !== 1))
        return false;
      // A disconnected board pauses its attempts; reconnecting lets the next sweep catch up.
      const board = yield* findBoard(row.board_id);
      if (!board?.mapping) return false;
      const facts = yield* threadFacts(row);
      if (!facts) return false;
      if (facts.deleted) {
        yield* sql`UPDATE issue_board_attempts SET status='ended',ended_reason='thread-deleted',active=0 WHERE id=${row.id}`;
        return true;
      }
      const pr = controllingPullRequestOf(facts.pullRequests);
      const prKey = pr ? pullRequestKey(pr) : null;
      const prJson = pr
        ? json({ host: pr.host, repository: pr.repository, number: pr.number, url: pr.url })
        : null;
      if (
        row.worktree_path !== facts.worktreePath ||
        row.controlling_pr_key !== prKey ||
        row.controlling_pr_json !== prJson
      )
        yield* sql`UPDATE issue_board_attempts SET worktree_path=${facts.worktreePath},controlling_pr_key=${prKey},
          controlling_pr_json=${prJson} WHERE id=${row.id}`;
      const stage = deriveStage({
        worktreeReady: facts.worktreePath !== null,
        firstRun: facts.firstRun,
        controllingPullRequest: pr,
      });
      if (stage === "failed") {
        if (row.status !== "launching") return false;
        yield* sql`UPDATE issue_board_attempts SET status='failed' WHERE id=${row.id}`;
        return true;
      }
      if (stage === row.status) return false;
      if (stage === "launching") return false;
      const index = row.transition_index + 1;
      yield* transaction(
        Effect.gen(function* () {
          if (row.status === "launching") {
            yield* sql`UPDATE issue_board_attempts SET status='ended',ended_reason='superseded',active=0
              WHERE board_id=${row.board_id} AND issue_key=${row.issue_key} AND active=1 AND id<>${row.id}`;
            yield* sql`UPDATE issue_board_attempts SET active=1,started_at=${yield* now} WHERE id=${row.id}`;
          }
          yield* sql`UPDATE issue_board_attempts SET status=${stage},transition_index=${index} WHERE id=${row.id}`;
          const target = stageColumn(stage, board.mapping!);
          if (target !== null)
            yield* enqueueMove({
              requestKey: automaticRequestKey(row.id, index),
              boardId: row.board_id,
              issue: yield* parse(IssueRef, row.issue_json),
              columnId: target,
              attemptId: row.id,
              origin: "automatic",
            });
        }),
      );
      return true;
    });
    const reconcileRows = Effect.fnUntraced(function* (rows: ReadonlyArray<AttemptRow>) {
      const changed = new Set<string>();
      for (const row of rows) if (yield* reconcileRow(row)) changed.add(row.board_id);
      yield* flushLocked();
      for (const boardId of changed) yield* bumpRevision(boardId);
    });
    const reconcileThread: IssueServiceShape["reconcileThread"] = (threadId) =>
      lock(
        sql<AttemptRow>`SELECT * FROM issue_board_attempts WHERE thread_id=${threadId}
          AND status IN ('launching','working','in-pr','merged')`.pipe(
          Effect.flatMap(reconcileRows),
        ),
      );
    const sweep: IssueServiceShape["sweep"] = lock(
      sql<AttemptRow>`SELECT * FROM issue_board_attempts WHERE status IN ('launching','working','in-pr','merged')`.pipe(
        Effect.flatMap(reconcileRows),
      ),
    );

    const latestMoves = Effect.fnUntraced(function* (boardId: string) {
      const rows =
        yield* sql<MoveRow>`SELECT * FROM issue_moves WHERE board_id=${boardId} AND sequence IN
        (SELECT MAX(sequence) FROM issue_moves WHERE board_id=${boardId} GROUP BY issue_key)`;
      return yield* Effect.forEach(rows, decodeMove);
    });

    const openBoard: IssueServiceShape["openBoard"] = (input) =>
      protect(
        Effect.gen(function* () {
          let board: IssueBoardSummary;
          let saved = true;
          if (input.boardId) board = yield* readBoard(input.boardId);
          else if (input.locator) {
            const id = issueBoardId(input.projectId, input.locator);
            const found = yield* findBoard(id);
            if (found) board = found;
            else {
              board = {
                id,
                projectId: input.projectId,
                title: "",
                locator: input.locator,
                mapping: null,
              };
              saved = false;
            }
          } else return yield* error("invalid", "Choose a board to open.");
          if (board.projectId !== input.projectId)
            return yield* error("invalid", "This board belongs to a different project.");
          const row = saved ? yield* readSnapshot(board.id) : undefined;
          let remote: RemoteIssueBoard;
          let sync: IssueBoardSync | undefined;
          if (row) {
            if (input.refresh || (yield* nowMillis) - attemptedAt(row) > FRESH_WINDOW_MS)
              yield* requestRefresh(board.id);
            remote = yield* parse(RemoteBoard, row.board_json);
            sync = syncOf(board.id, row);
          } else {
            remote = yield* host.readBoard(
              (yield* project(board.projectId)).workspaceRoot,
              board.locator,
            );
            if (saved) {
              yield* upsertSnapshot(board.id, remote);
              const stored = yield* readSync(board.id);
              if (!stored) return yield* error("not-found", "This board is no longer connected.");
              sync = syncOf(board.id, stored);
            }
          }
          return {
            board: { ...board, title: remote.title, locator: remote.locator },
            columns: remote.columns,
            items: remote.items,
            attempts: saved ? yield* listAttempts({ boardId: board.id }) : [],
            moves: saved ? yield* latestMoves(board.id) : [],
            ...(sync ? { sync } : {}),
          };
        }),
      );

    const subscribeBoard: IssueServiceShape["subscribeBoard"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const boards = yield* sql<{
            project_id: string;
          }>`SELECT project_id FROM issue_boards WHERE id=${input.boardId}`;
          if (boards[0] && boards[0].project_id !== input.projectId)
            return yield* error("invalid", "This board belongs to a different project.");
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              subscribers.set(input.boardId, (subscribers.get(input.boardId) ?? 0) + 1),
            ),
            () =>
              Effect.sync(() => {
                const count = (subscribers.get(input.boardId) ?? 1) - 1;
                if (count > 0) subscribers.set(input.boardId, count);
                else subscribers.delete(input.boardId);
              }),
          );
          return Stream.concat(
            Stream.make(yield* syncEvent(input.boardId)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.boardId === input.boardId),
            ),
          );
        }).pipe(Effect.mapError(preserveError)),
      ).pipe(
        Stream.changesWith((left, right) => json(left) === json(right)),
        Stream.scoped,
      );

    const configureBoard: IssueServiceShape["configureBoard"] = (input) =>
      lock(
        Effect.gen(function* () {
          const replay = yield* requestReplay(input.requestId, input);
          if (replay)
            return yield* openBoard({
              projectId: input.projectId,
              boardId: yield* parse(Schema.String, replay),
            });
          const remote = yield* host.readBoard(
            (yield* project(input.projectId)).workspaceRoot,
            input.locator,
          );
          const readyColumns = issueReadyColumnIds(input.mapping);
          for (const id of [
            ...readyColumns,
            input.mapping.inProgress,
            input.mapping.inPullRequest,
            input.mapping.completed,
          ])
            if (!remote.columns.some((column) => column.id === id))
              return yield* error("invalid", "Map each stage to an existing remote board column.");
          const mapping = {
            ...input.mapping,
            ready:
              typeof input.mapping.ready === "string"
                ? input.mapping.ready
                : [...new Set(readyColumns)],
          };
          const id = issueBoardId(input.projectId, remote.locator);
          const previous = yield* sql<{
            mapping_json: string;
          }>`SELECT mapping_json FROM issue_boards WHERE id=${id}`;
          yield* transaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO issue_boards(id,project_id,locator_key,title,locator_json,mapping_json)
                VALUES(${id},${input.projectId},${id},${remote.title},${json(remote.locator)},${json(mapping)})
                ON CONFLICT(id) DO UPDATE SET title=excluded.title,locator_json=excluded.locator_json,mapping_json=excluded.mapping_json`;
              yield* upsertSnapshot(id, remote);
              if (previous[0] && previous[0].mapping_json !== json(mapping))
                yield* bumpRevision(id);
              yield* remember(input.requestId, input, id);
            }),
          );
          return yield* openBoard({ projectId: input.projectId, boardId: id });
        }),
      );

    const disconnectBoard: IssueServiceShape["disconnectBoard"] = (input) =>
      lock(
        transaction(
          Effect.gen(function* () {
            if (yield* requestReplay(input.requestId, input)) return;
            yield* sql`UPDATE issue_moves SET status='superseded',error=NULL,retry_at=NULL
              WHERE board_id=${input.boardId} AND status IN ('pending','failed')`;
            yield* sql`DELETE FROM issue_boards WHERE id=${input.boardId}`;
            yield* sql`DELETE FROM issue_board_snapshots WHERE board_id=${input.boardId}`;
            syncing.delete(input.boardId);
            yield* publish(input.boardId);
            yield* remember(input.requestId, input, true);
          }),
        ),
      );

    const listBoards: IssueServiceShape["listBoards"] = (input) =>
      protect(
        Effect.gen(function* () {
          const saved = input.projectId
            ? yield* sql<BoardRow>`SELECT * FROM issue_boards WHERE project_id=${input.projectId} ORDER BY title`
            : yield* sql<BoardRow>`SELECT * FROM issue_boards ORDER BY project_id, title`;
          const configs = yield* Effect.forEach(saved, (row) =>
            Effect.gen(function* () {
              const board = yield* decodeBoard(row);
              const sync = yield* readSync(row.id);
              return sync ? { ...board, sync: syncOf(row.id, sync) } : board;
            }),
          );
          if (input.connectedOnly || !input.projectId) return configs;
          const projectId = input.projectId;
          const discovery = yield* scope(projectId).pipe(
            Effect.flatMap((found) =>
              issueHost(found).pipe(
                Effect.flatMap((adapter) =>
                  adapter.boards
                    ? adapter.boards.list(found)
                    : Effect.fail(
                        error(
                          "unavailable",
                          "Boards are supported for GitHub Projects and Azure DevOps. This host supports issue listing only.",
                        ),
                      ),
                ),
              ),
            ),
            Effect.result,
          );
          if (discovery._tag === "Failure") {
            if (configs.length) return configs;
            return yield* discovery.failure;
          }
          const results = new Map<string, IssueBoardSummary>(
            configs.map((board) => [board.id, board]),
          );
          for (const board of discovery.success) {
            const id = issueBoardId(projectId, board.locator);
            if (!results.has(id)) results.set(id, { id, projectId, ...board, mapping: null });
          }
          return [...results.values()];
        }),
      );

    const move: IssueServiceShape["move"] = (input) =>
      lock(
        Effect.gen(function* () {
          const replay = yield* requestReplay(input.requestId, input);
          if (replay) return yield* readMove(yield* parse(Schema.String, replay));
          const board = yield* readBoard(input.boardId);
          const cwd = (yield* project(board.projectId)).workspaceRoot;
          const remote = yield* freshItem(
            board.id,
            cwd,
            board.locator,
            canonicalIssueKey(input.issue),
          );
          if (
            decideManualMove({
              expected: input.expectedPlacement,
              remoteColumn: remote.columnId,
              target: input.columnId,
            }) === "conflict"
          ) {
            yield* storeItem(board.id, remote);
            return yield* error(
              "conflict",
              "This ticket moved on another device. Refresh before moving it again.",
            );
          }
          const columns = (yield* storedBoard(board.id))?.columns ?? [];
          if (!columns.some((column) => column.id === input.columnId))
            return yield* error("invalid", "The selected board column no longer exists.");
          const id = yield* transaction(
            Effect.gen(function* () {
              const id = yield* enqueueMove({
                requestKey: `manual:${input.requestId}`,
                boardId: board.id,
                issue: remote.issue.ref,
                columnId: input.columnId,
                attemptId: null,
                origin: "manual",
              });
              yield* remember(input.requestId, input, id);
              return id;
            }),
          );
          yield* flushLocked({ id });
          return yield* readMove(id);
        }),
      );

    const retryMove: IssueServiceShape["retryMove"] = (input) =>
      lock(
        Effect.gen(function* () {
          const replay = yield* requestReplay(input.requestId, input);
          if (replay) return yield* readMove(yield* parse(Schema.String, replay));
          const previous =
            (yield* sql<MoveRow>`SELECT * FROM issue_moves WHERE id=${input.moveId}`)[0];
          if (!previous) return yield* error("not-found", "The board move was not found.");
          let id = previous.id;
          if (previous.status === "failed")
            yield* sql`UPDATE issue_moves SET status='pending',error=NULL,retry_at=NULL WHERE id=${previous.id}`;
          else if (previous.status === "skipped")
            // Applying a skipped automatic move is a deliberate manual move; the attempt resumes from there.
            id = yield* enqueueMove({
              requestKey: `manual:${input.requestId}`,
              boardId: previous.board_id,
              issue: yield* parse(IssueRef, previous.issue_json),
              columnId: previous.column_id,
              attemptId: previous.attempt_id,
              origin: "manual",
            });
          yield* remember(input.requestId, input, id);
          yield* flushLocked({ id });
          return yield* readMove(id);
        }),
      );

    const startAttempt: IssueServiceShape["startAttempt"] = (input) =>
      protect(
        Effect.gen(function* () {
          const row = yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const existing = (yield* sql<AttemptRow>`SELECT * FROM issue_board_attempts
                WHERE launch_request_id=${input.requestId}`)[0];
              if (existing) {
                yield* requestReplay(input.requestId, input);
                return existing;
              }
              const board = yield* readBoard(input.boardId);
              if (!board.mapping)
                return yield* error("invalid", "Map this board's columns before starting tickets.");
              const cwd = (yield* project(board.projectId)).workspaceRoot;
              yield* project(input.projectId);
              const item = yield* freshItem(
                board.id,
                cwd,
                board.locator,
                canonicalIssueKey(input.issue),
              );
              yield* storeItem(board.id, item);
              if (!item.columnId || !issueReadyColumnIds(board.mapping).includes(item.columnId))
                return yield* error(
                  "conflict",
                  "Start is available only while this ticket is in a configured Ready for development column.",
                );
              const threadId = yield* deps.allocateThreadId(input.projectId);
              const id = NodeCrypto.randomUUID();
              yield* transaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO issue_board_attempts(id,board_id,issue_key,issue_json,project_id,thread_id,status,active,
                    start_column_id,launch_request_id,created_at)
                    VALUES(${id},${board.id},${canonicalIssueKey(item.issue.ref)},${json(item.issue.ref)},${input.projectId},
                    ${threadId},'launching',0,${item.columnId},${input.requestId},${yield* now})`;
                  yield* remember(input.requestId, input, id);
                }),
              );
              yield* bumpRevision(board.id);
              return yield* readAttemptRow(id);
            }),
          );
          if (row.status === "launching") {
            // The ticket read is part of the launch: if either fails the attempt is failed, never
            // left launching without a thread.
            const launched = yield* scope(input.projectId).pipe(
              Effect.flatMap((found) =>
                issueHost(found).pipe(
                  Effect.flatMap((adapter) => adapter.get({ cwd: found.cwd, ref: input.issue })),
                ),
              ),
              Effect.flatMap((detail) =>
                deps.launchThread({
                  commandId: CommandId.make(`issue-attempt:${input.requestId}`),
                  threadId: ThreadId.make(row.thread_id),
                  projectId: input.projectId,
                  title: `#${detail.ref.number} ${detail.title}`.slice(0, 200),
                  text: `${input.prompt}${attachedIssueBlock(detail)}`,
                  branch: input.branch,
                  baseRef: input.baseRef,
                  modelSelection: input.modelSelection,
                  runtimeMode: input.runtimeMode,
                  interactionMode: input.interactionMode,
                }),
              ),
              Effect.result,
            );
            if (launched._tag === "Failure") {
              yield* lock(
                Effect.gen(function* () {
                  yield* sql`UPDATE issue_board_attempts SET status='failed' WHERE id=${row.id} AND status='launching'`;
                  yield* bumpRevision(row.board_id);
                }),
              );
              return yield* launched.failure;
            }
          }
          return { attempt: yield* readAttempt(row.id), threadId: ThreadId.make(row.thread_id) };
        }),
      );

    const endAttempt: IssueServiceShape["endAttempt"] = (input) =>
      lock(
        Effect.gen(function* () {
          const replay = yield* requestReplay(input.requestId, input);
          if (replay) return yield* readAttempt(input.attemptId);
          const row = yield* readAttemptRow(input.attemptId);
          if (row.status === "ended" || row.status === "failed")
            return yield* error("conflict", "This attempt has already stopped.");
          const board = yield* findBoard(row.board_id);
          if (
            input.returnToColumnId !== undefined &&
            (!board?.mapping ||
              !issueReadyColumnIds(board.mapping).includes(input.returnToColumnId))
          )
            return yield* error("invalid", "Choose a configured Ready for development column.");
          const moveId = yield* transaction(
            Effect.gen(function* () {
              yield* sql`UPDATE issue_board_attempts SET status='ended',ended_reason='user',active=0 WHERE id=${row.id}`;
              yield* sql`UPDATE issue_moves SET status='superseded',error=NULL,retry_at=NULL
                WHERE attempt_id=${row.id} AND origin='automatic' AND status='pending'`;
              const id =
                input.returnToColumnId === undefined
                  ? null
                  : yield* enqueueMove({
                      requestKey: `manual:${input.requestId}`,
                      boardId: row.board_id,
                      issue: yield* parse(IssueRef, row.issue_json),
                      columnId: input.returnToColumnId,
                      attemptId: null,
                      origin: "manual",
                    });
              yield* remember(input.requestId, input, row.id);
              return id;
            }),
          );
          if (moveId) yield* flushLocked({ id: moveId });
          else if (board) yield* bumpRevision(board.id);
          return yield* readAttempt(row.id);
        }),
      );

    const resumeAttempt: IssueServiceShape["resumeAttempt"] = (input) =>
      lock(
        Effect.gen(function* () {
          const replay = yield* requestReplay(input.requestId, input);
          if (replay) return yield* readAttempt(input.attemptId);
          const row = yield* readAttemptRow(input.attemptId);
          if (row.status !== "ended" || row.ended_reason !== "user")
            return yield* error("conflict", "Only an attempt you stopped can be resumed.");
          const others = yield* sql`SELECT 1 FROM issue_board_attempts
            WHERE board_id=${row.board_id} AND issue_key=${row.issue_key} AND active=1`;
          if (others.length)
            return yield* error("conflict", "Another attempt is active for this ticket.");
          const board = yield* readBoard(row.board_id);
          if (!board.mapping)
            return yield* error("invalid", "Map this board's columns before resuming.");
          const facts = yield* threadFacts(row);
          if (!facts || facts.deleted)
            return yield* error("not-found", "This attempt's thread is gone.");
          const pr = controllingPullRequestOf(facts.pullRequests);
          const derived = deriveStage({
            worktreeReady: facts.worktreePath !== null,
            firstRun: facts.firstRun,
            controllingPullRequest: pr,
          });
          const stage: AttemptStage =
            derived === "failed" || derived === "launching" ? "working" : derived;
          const cwd = (yield* project(board.projectId)).workspaceRoot;
          const current = yield* freshItem(board.id, cwd, board.locator, row.issue_key).pipe(
            Effect.asSome,
            Effect.orElseSucceed(() => Option.none<IssueBoardItem>()),
          );
          const baseline = Option.match(current, {
            onNone: () => row.baseline_column_id,
            onSome: (item) => item.columnId,
          });
          const index = row.transition_index + 1;
          yield* transaction(
            Effect.gen(function* () {
              yield* sql`UPDATE issue_board_attempts SET status=${stage},active=1,ended_reason=NULL,
                baseline_column_id=${baseline},transition_index=${index} WHERE id=${row.id}`;
              const target = stageColumn(stage, board.mapping!);
              if (target !== null)
                yield* enqueueMove({
                  requestKey: automaticRequestKey(row.id, index),
                  boardId: row.board_id,
                  issue: yield* parse(IssueRef, row.issue_json),
                  columnId: target,
                  attemptId: row.id,
                  origin: "automatic",
                });
              yield* remember(input.requestId, input, row.id);
            }),
          );
          yield* flushLocked();
          yield* bumpRevision(board.id);
          return yield* readAttempt(row.id);
        }),
      );

    const threadTicket: IssueServiceShape["threadTicket"] = (threadId) =>
      protect(
        Effect.gen(function* () {
          const attempts = yield* listAttempts({ threadId });
          const attempt = attempts.find((candidate) => candidate.active) ?? attempts[0];
          if (!attempt) return null;
          const stored = yield* storedBoard(attempt.boardId);
          const key = canonicalIssueKey(attempt.issue);
          const item = stored?.items.find((entry) => canonicalIssueKey(entry.issue.ref) === key);
          const column =
            stored?.columns.find((entry) => entry.id === item?.columnId)?.title ?? null;
          const fresh = yield* scope(attempt.projectId).pipe(
            Effect.flatMap((found) =>
              issueHost(found).pipe(
                Effect.flatMap((adapter) => adapter.get({ cwd: found.cwd, ref: attempt.issue })),
              ),
            ),
            Effect.result,
          );
          if (fresh._tag === "Failure") {
            if (!item) return yield* fresh.failure;
            return {
              ticket: { ...item.issue, body: "" },
              column,
              attempt,
              source: "stored-copy" as const,
            };
          }
          return { ticket: capTicketText(fresh.success), column, attempt, source: "host" as const };
        }),
      );

    const refreshStaleBoards: IssueServiceShape["refreshStaleBoards"] = protect(
      Effect.gen(function* () {
        const rows = yield* sql<{ board_id: string; synced_at: string; failed_at: string | null }>`
          SELECT s.board_id, s.synced_at, s.failed_at FROM issue_board_snapshots s
          JOIN issue_boards b ON b.id = s.board_id`;
        const worked = new Set(
          (yield* sql<{
            board_id: string;
          }>`SELECT DISTINCT board_id FROM issue_board_attempts WHERE active=1`).map(
            (row) => row.board_id,
          ),
        );
        const at = yield* nowMillis;
        for (const row of rows) {
          if (!subscribers.has(row.board_id) && !worked.has(row.board_id)) continue;
          if (at - attemptedAt({ ...row, revision: 0, failure: null }) <= STALE_WINDOW_MS) continue;
          yield* requestRefresh(row.board_id);
        }
      }),
    );

    return {
      list: (input) =>
        scope(input.projectId).pipe(
          Effect.flatMap((found) =>
            issueHost(found).pipe(Effect.flatMap((adapter) => adapter.list(found, input.cursor))),
          ),
        ),
      get: (input) =>
        project(input.projectId).pipe(
          Effect.flatMap((value) =>
            issueHost({ cwd: value.workspaceRoot, ref: input.issue }).pipe(
              Effect.flatMap((adapter) =>
                adapter.get({ cwd: value.workspaceRoot, ref: input.issue }),
              ),
            ),
          ),
        ),
      listBoards,
      openBoard,
      subscribeBoard,
      configureBoard,
      disconnectBoard,
      move,
      retryMove,
      listAttempts,
      startAttempt,
      endAttempt,
      resumeAttempt,
      threadTicket,
      reconcileThread,
      sweep,
      refreshStaleBoards,
      drainRefreshes: refreshes.drain,
    } satisfies IssueServiceShape;
  });

/** Keeps the body and the latest comments within the MCP tool's text budget. */
const capTicketText = (detail: IssueDetail): IssueDetail => {
  const comments = (detail.comments ?? []).slice(-TICKET_COMMENT_LIMIT);
  let budget = TICKET_TEXT_LIMIT;
  const body = detail.body.slice(0, budget);
  budget -= body.length;
  const kept: typeof comments = [];
  for (const comment of comments.toReversed()) {
    if (budget <= 0) break;
    const text = comment.body.slice(0, budget);
    budget -= text.length;
    kept.unshift({ ...comment, body: text });
  }
  return { ...detail, body, comments: kept };
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const hosts = yield* IssueHost;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const repositories = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  return yield* makeIssueService({
    hosts,
    getProject: (id) =>
      projects.getShell(id).pipe(Effect.map(Option.getOrNull), Effect.mapError(storageError)),
    resolveRepositoryIdentity: (cwd) => repositories.resolve(cwd, { refresh: true }),
    readThread: (threadId) =>
      orchestrator.getThreadRecords(threadId, ["runs"]).pipe(
        Effect.map(({ thread, runs }) => ({
          deleted: thread.deletedAt !== null,
          worktreePath: thread.worktreePath,
          firstRun: firstRunProgress(runs),
          pullRequests: threadPullRequestsOf(thread),
        })),
        Effect.catchCause((cause) =>
          Effect.logDebug("issue attempt thread unavailable", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
    allocateThreadId: (projectId) =>
      ids.allocate.thread({ projectId }).pipe(Effect.mapError(storageError)),
    launchThread: (input) =>
      threadLaunch
        .launch({
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          generateTitle: false,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          workspaceStrategy: { type: "worktree", baseRef: input.baseRef, branch: input.branch },
          initialMessage: { text: input.text, attachments: [] },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.mapError((cause) =>
            error("remote", `The thread could not be launched: ${cause.message}`),
          ),
          Effect.asVoid,
        ),
  });
});

export const layer = Layer.effect(IssueService, make);
