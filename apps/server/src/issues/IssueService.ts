import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  IssueOperationError,
  IssueAttemptLink,
  IssueAttempt,
  IssueBoardSummary,
  IssueMoveReceipt,
  IssueLifecycleReceipt,
  IssueRef,
  IssueBoardLocator,
  IssueBoardMapping,
  issueReadyColumnIds,
  type ProjectId,
  type ThreadId,
  type IssuesListInput,
  type IssuesListResult,
  type IssuesGetInput,
  type IssueDetail,
  type IssueBoardsListInput,
  type IssueBoardsOpenInput,
  type IssueBoardView,
  type IssueBoardsConfigureInput,
  type IssueBoardsDisconnectInput,
  type IssueBoardsMoveInput,
  type IssueMovesRetryInput,
  type IssueAttemptsReserveInput,
  type IssueAttemptsListInput,
  type IssueAttemptsReceiptsInput,
  type IssueAttemptsReceiptsResult,
  type IssueAttemptsIngestInput,
  type IssueAttemptsIngestResult,
  type IssueAttemptsAcknowledgeInput,
  type IssuePullRequestKey,
  type OrchestrationProjectShell,
  type EnvironmentId,
  type IssueAttemptsSyncGenerationsInput,
} from "@t3tools/contracts";
import {
  canonicalIssueKey,
  IssueHost,
  type IssueHostShape,
  type IssueHostScope,
} from "./IssueHost.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  sourceControlRepositorySelector,
  detectSourceControlProviderFromRemoteUrl,
} from "@t3tools/shared/sourceControl";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";

export interface AttachIssueAttemptInput {
  readonly link: IssueAttemptLink;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string;
}
export interface ObserveIssuePullRequestInput {
  readonly threadId: ThreadId;
  readonly eventKey: string;
  readonly key: typeof IssuePullRequestKey.Type;
  readonly state: "open" | "closed" | "merged";
  readonly source?: string;
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
  readonly configureBoard: (
    input: IssueBoardsConfigureInput,
  ) => Effect.Effect<IssueBoardView, IssueOperationError>;
  readonly disconnectBoard: (
    input: IssueBoardsDisconnectInput,
  ) => Effect.Effect<void, IssueOperationError>;
  readonly move: (
    input: IssueBoardsMoveInput,
  ) => Effect.Effect<IssueMoveReceipt, IssueOperationError>;
  readonly retryMove: (
    input: IssueMovesRetryInput,
  ) => Effect.Effect<IssueMoveReceipt, IssueOperationError>;
  readonly reserveAttempt: (
    input: IssueAttemptsReserveInput,
  ) => Effect.Effect<IssueAttemptLink, IssueOperationError>;
  readonly listAttempts: (
    input: IssueAttemptsListInput,
  ) => Effect.Effect<ReadonlyArray<IssueAttempt>, IssueOperationError>;
  readonly listReceipts: (
    input: IssueAttemptsReceiptsInput,
  ) => Effect.Effect<IssueAttemptsReceiptsResult, IssueOperationError>;
  readonly ingestReceipts: (
    input: IssueAttemptsIngestInput,
  ) => Effect.Effect<IssueAttemptsIngestResult, IssueOperationError>;
  readonly acknowledgeReceipts: (
    input: IssueAttemptsAcknowledgeInput,
  ) => Effect.Effect<void, IssueOperationError>;
  readonly syncAttemptGenerations: (
    input: IssueAttemptsSyncGenerationsInput,
  ) => Effect.Effect<void, IssueOperationError>;
  readonly attachAttempt: (
    input: AttachIssueAttemptInput,
  ) => Effect.Effect<void, IssueOperationError>;
  readonly firstPromptSent: (input: {
    readonly threadId: ThreadId;
    readonly eventKey: string;
  }) => Effect.Effect<void, IssueOperationError>;
  readonly observePullRequest: (
    input: ObserveIssuePullRequestInput,
  ) => Effect.Effect<void, IssueOperationError>;
  readonly drain: Effect.Effect<void, IssueOperationError>;
}
export class IssueService extends Context.Service<IssueService, IssueServiceShape>()(
  "t3/issues/IssueService",
) {}
const error = (reason: IssueOperationError["reason"], message: string) =>
  new IssueOperationError({ reason, message });
const storageError = () => error("storage", "Could not read or save issue tracking state.");
const isIssueError = Schema.is(IssueOperationError);
const decodeHostKind = Schema.decodeUnknownEffect(IssueRef.fields.hostKind);
const decodeBoardValue = Schema.decodeEffect(IssueBoardSummary);
const decodeAttemptValue = Schema.decodeUnknownEffect(IssueAttempt);
const decodeMoveValue = Schema.decodeUnknownEffect(IssueMoveReceipt);
const decodeLifecycleValue = Schema.decodeEffect(IssueLifecycleReceipt);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const uuid = () => NodeCrypto.randomUUID();
const hash = (value: unknown) => NodeCrypto.createHash("sha256").update(json(value)).digest("hex");
const parse = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(storageError));
interface BoardRow {
  id: string;
  project_id: string;
  title: string;
  locator_json: string;
  mapping_json: string;
}
interface AttemptRow {
  id: string;
  reservation_id: string;
  board_id: string;
  issue_key: string;
  link_json: string;
  launch_order: number;
  project_id: string | null;
  thread_id: string | null;
  worktree_path: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  source_generation: number;
  controlling_pr_key: string | null;
}
interface MoveRow {
  sequence: number;
  id: string;
  board_id: string;
  issue_key: string;
  issue_json: string;
  column_id: string;
  attempt_id: string | null;
  status: string;
  error: string | null;
  created_at: string;
}
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

export const makeIssueService = (options: {
  readonly host: IssueHostShape;
  readonly environmentId: EnvironmentId;
  readonly resolveRepositoryIdentity?: RepositoryIdentityResolver["Service"]["resolve"];
  readonly getProject: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProjectShell | null, IssueOperationError>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mutex = yield* Semaphore.make(1);
    const preserveError = (cause: unknown) => (isIssueError(cause) ? cause : storageError());
    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError(preserveError));
    const lock = <A, E>(effect: Effect.Effect<A, E>) => protect(mutex.withPermits(1)(effect));
    const transaction = <A, E>(effect: Effect.Effect<A, E>) => protect(sql.withTransaction(effect));
    const project = Effect.fnUntraced(function* (id: ProjectId) {
      const value = yield* options.getProject(id);
      if (!value) return yield* error("not-found", "The selected project is unavailable.");
      return value;
    });
    const scope = Effect.fnUntraced(function* (
      projectId: ProjectId,
    ): Effect.fn.Return<IssueHostScope, IssueOperationError> {
      const value = yield* project(projectId);
      // Imported projects can lack a saved identity even when their checkout has a remote.
      let identity = value.repositoryIdentity;
      if (
        (!identity?.provider || identity.provider === "unknown") &&
        options.resolveRepositoryIdentity
      ) {
        identity =
          (yield* options.resolveRepositoryIdentity(value.workspaceRoot, { refresh: true })) ??
          identity;
      }
      const repository =
        identity?.provider === "azure-devops"
          ? identity.displayName?.split("/_git/")[0]
          : sourceControlRepositorySelector(identity);
      if (!identity || !repository || !identity.provider)
        return yield* error("unavailable", "This project has no supported repository host.");
      const kind = yield* decodeHostKind(identity.provider).pipe(
        Effect.mapError(() =>
          error("unavailable", "This repository host does not support issues."),
        ),
      );
      const detected = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
      const host =
        kind === "azure-devops" ? "dev.azure.com" : detected ? new URL(detected.baseUrl).host : "";
      if (!host) return yield* error("unavailable", "This project's repository host is unknown.");
      return {
        cwd: value.workspaceRoot,
        ref: {
          hostKind: kind,
          host,
          repository,
          id: "0",
          number: 0,
          url: `https://${host}/${repository}`,
        },
      };
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
    const readBoard = Effect.fnUntraced(function* (id: string) {
      const rows = yield* sql<BoardRow>`SELECT * FROM issue_boards WHERE id=${id}`;
      if (!rows[0]) return yield* error("not-found", "This board is no longer connected.");
      return yield* decodeBoard(rows[0]);
    });
    const decodeAttempt = Effect.fnUntraced(function* (row: AttemptRow) {
      const active = yield* sql<{
        attempt_id: string;
      }>`SELECT attempt_id FROM issue_active_attempts WHERE issue_key=${row.issue_key}`;
      return yield* decodeAttemptValue({
        link: yield* parse(IssueAttemptLink, row.link_json),
        projectId: row.project_id,
        threadId: row.thread_id,
        worktreePath: row.worktree_path,
        status: row.status,
        active: active[0]?.attempt_id === row.id,
        createdAt: row.created_at,
        startedAt: row.started_at,
        sourceGeneration: row.source_generation,
      }).pipe(Effect.mapError(storageError));
    });
    const decodeMove = Effect.fnUntraced(function* (row: MoveRow) {
      return yield* decodeMoveValue({
        id: row.id,
        boardId: row.board_id,
        issue: yield* parse(IssueRef, row.issue_json),
        columnId: row.column_id,
        status: row.status,
        error: row.error,
        createdAt: row.created_at,
      }).pipe(Effect.mapError(storageError));
    });
    const listAttempts: IssueServiceShape["listAttempts"] = (input) =>
      protect(
        Effect.gen(function* () {
          const rows = yield* sql<AttemptRow>`SELECT * FROM issue_attempts
      WHERE (${input.boardId ?? null} IS NULL OR board_id=${input.boardId ?? null})
      AND (${input.threadId ?? null} IS NULL OR thread_id=${input.threadId ?? null})
      AND (${input.issue ? canonicalIssueKey(input.issue) : null} IS NULL OR issue_key=${input.issue ? canonicalIssueKey(input.issue) : null})
      ORDER BY launch_order DESC, created_at DESC`;
          return yield* Effect.forEach(rows, decodeAttempt);
        }),
      );
    const requestReplay = Effect.fnUntraced(function* (requestId: string, payload: unknown) {
      const rows = yield* sql<{
        payload_hash: string;
        result_json: string;
      }>`SELECT * FROM issue_requests WHERE request_id=${requestId}`;
      if (rows[0] && rows[0].payload_hash !== hash(payload))
        return yield* error(
          "conflict",
          "This request ID was already used for a different issue operation.",
        );
      return rows[0]?.result_json ?? null;
    });
    const remember = (
      requestId: string,
      payload: unknown,
      result: unknown,
    ) => sql`INSERT INTO issue_requests(request_id,payload_hash,result_json)
    VALUES(${requestId},${hash(payload)},${json(result)})`;
    const enqueueMove = Effect.fnUntraced(function* (
      requestKey: string,
      boardId: string,
      issue: IssueRef,
      columnId: string,
      attemptId: string | null,
    ) {
      const existing =
        yield* sql<MoveRow>`SELECT * FROM issue_moves WHERE request_key=${requestKey}`;
      if (existing[0]) return existing[0].id;
      const key = canonicalIssueKey(issue);
      yield* sql`UPDATE issue_moves SET status='superseded', error=NULL WHERE board_id=${boardId} AND issue_key=${key} AND status IN ('pending','failed')`;
      const id = uuid();
      yield* sql`INSERT INTO issue_moves(id,request_key,board_id,issue_key,issue_json,column_id,attempt_id,status,error,created_at)
      VALUES(${id},${requestKey},${boardId},${key},${json(issue)},${columnId},${attemptId},'pending',NULL,${yield* now})`;
      return id;
    });
    const processMove = Effect.fnUntraced(function* (move: MoveRow) {
      const newest = yield* sql<{
        sequence: number;
      }>`SELECT sequence FROM issue_moves WHERE board_id=${move.board_id} AND issue_key=${move.issue_key} ORDER BY sequence DESC LIMIT 1`;
      const active =
        move.attempt_id === null
          ? []
          : yield* sql<{
              attempt_id: string;
            }>`SELECT attempt_id FROM issue_active_attempts WHERE issue_key=${move.issue_key}`;
      if (
        newest[0]?.sequence !== move.sequence ||
        (move.attempt_id !== null && active[0]?.attempt_id !== move.attempt_id)
      ) {
        yield* sql`UPDATE issue_moves SET status='superseded',error=NULL WHERE id=${move.id}`;
        return;
      }
      const result = yield* Effect.gen(function* () {
        const board = yield* readBoard(move.board_id);
        const cwd = (yield* project(board.projectId)).workspaceRoot;
        const remote = yield* options.host.board(cwd, board.locator);
        if (!remote.columns.some((column) => column.id === move.column_id))
          return yield* error(
            "invalid",
            "The configured board column no longer exists. Reconfigure this board.",
          );
        const issue = yield* parse(IssueRef, move.issue_json);
        const item = remote.items.find(
          (item) => canonicalIssueKey(item.issue.ref) === canonicalIssueKey(issue),
        );
        if (!item) return yield* error("not-found", "The issue is no longer on this board.");
        if (item.columnId !== move.column_id)
          yield* options.host.move(cwd, remote.locator, item, move.column_id);
        const confirmed = yield* options.host.board(cwd, remote.locator);
        if (
          confirmed.items.find((item) => canonicalIssueKey(item.issue.ref) === move.issue_key)
            ?.columnId !== move.column_id
        )
          return yield* error(
            "conflict",
            "The repository host has not confirmed the ticket move. Retry to recheck its placement.",
          );
      }).pipe(Effect.result);
      if (result._tag === "Success")
        yield* sql`UPDATE issue_moves SET status='applied',error=NULL WHERE id=${move.id}`;
      else
        yield* sql`UPDATE issue_moves SET status='failed',error=${preserveError(result.failure).message} WHERE id=${move.id}`;
    });
    const flush = Effect.gen(function* () {
      const pending =
        yield* sql<MoveRow>`SELECT * FROM issue_moves WHERE status='pending' ORDER BY sequence`;
      for (const move of pending) yield* processMove(move);
    });
    const readMove = Effect.fnUntraced(function* (id: string) {
      const rows = yield* sql<MoveRow>`SELECT * FROM issue_moves WHERE id=${id}`;
      if (!rows[0]) return yield* error("not-found", "The board movement receipt was not found.");
      return yield* decodeMove(rows[0]);
    });
    const openBoard: IssueServiceShape["openBoard"] = (input) =>
      protect(
        Effect.gen(function* () {
          let board: IssueBoardSummary;
          if (input.boardId) board = yield* readBoard(input.boardId);
          else if (input.locator) {
            const id = issueBoardId(input.projectId, input.locator);
            const rows = yield* sql<BoardRow>`SELECT * FROM issue_boards WHERE id=${id}`;
            board = rows[0]
              ? yield* decodeBoard(rows[0])
              : {
                  id,
                  projectId: input.projectId,
                  title: "",
                  locator: input.locator,
                  mapping: null,
                };
          } else return yield* error("invalid", "Choose a board to open.");
          if (board.projectId !== input.projectId)
            return yield* error("invalid", "This board belongs to a different project.");
          const remote = yield* options.host.board(
            (yield* project(board.projectId)).workspaceRoot,
            board.locator,
          );
          const moves =
            yield* sql<MoveRow>`SELECT * FROM issue_moves WHERE board_id=${board.id} AND sequence IN
      (SELECT MAX(sequence) FROM issue_moves WHERE board_id=${board.id} GROUP BY issue_key)`;
          return {
            board: { ...board, title: remote.title, locator: remote.locator },
            columns: remote.columns,
            items: remote.items,
            attempts: yield* listAttempts({ boardId: board.id }),
            moves: yield* Effect.forEach(moves, decodeMove),
          };
        }),
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
          const remote = yield* options.host.board(
            (yield* project(input.projectId)).workspaceRoot,
            input.locator,
          );
          const readyColumns = issueReadyColumnIds(input.mapping);
          if (readyColumns.length === 0)
            return yield* error("invalid", "Choose at least one Ready for development column.");
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
          yield* transaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO issue_boards(id,project_id,locator_key,title,locator_json,mapping_json)
        VALUES(${id},${input.projectId},${id},${remote.title},${json(remote.locator)},${json(mapping)})
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,locator_json=excluded.locator_json,mapping_json=excluded.mapping_json`;
              yield* remember(input.requestId, input, id);
            }),
          );
          return yield* openBoard({ projectId: input.projectId, boardId: id });
        }),
      );
    const reserveAttempt: IssueServiceShape["reserveAttempt"] = (input) =>
      lock(
        Effect.gen(function* () {
          if (input.sourceEnvironmentId !== options.environmentId)
            return yield* error(
              "invalid",
              "The board source environment does not match this server.",
            );
          const replay = yield* requestReplay(input.requestId, input);
          if (replay) return yield* parse(IssueAttemptLink, replay);
          const board = yield* readBoard(input.boardId);
          const remote = yield* options.host.board(
            (yield* project(board.projectId)).workspaceRoot,
            board.locator,
          );
          const item = remote.items.find(
            (item) => canonicalIssueKey(item.issue.ref) === canonicalIssueKey(input.issue),
          );
          if (
            !board.mapping ||
            !item?.columnId ||
            !issueReadyColumnIds(board.mapping).includes(item.columnId)
          )
            return yield* error(
              "conflict",
              "Start is available only while this ticket is in a configured Ready for development column.",
            );
          const generations = yield* sql<{
            generation: number;
          }>`SELECT generation FROM issue_generations WHERE issue_key=${canonicalIssueKey(item.issue.ref)}`;
          const link: IssueAttemptLink = {
            attemptId: uuid(),
            reservationId: uuid(),
            sourceEnvironmentId: input.sourceEnvironmentId,
            sourceProjectId: board.projectId,
            destinationEnvironmentId: input.destinationEnvironmentId,
            boardId: board.id,
            issue: item.issue.ref,
            sourceGeneration: generations[0]?.generation ?? 0,
          };
          yield* transaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                value: number;
              }>`SELECT COALESCE(MAX(launch_order),0)+1 AS value FROM issue_attempts`;
              yield* sql`INSERT INTO issue_attempts(id,reservation_id,board_id,issue_key,link_json,launch_order,status,created_at,source_generation)
        VALUES(${link.attemptId},${link.reservationId},${board.id},${canonicalIssueKey(link.issue)},${json(link)},${rows[0]!.value},'reserved',${yield* now},${link.sourceGeneration})`;
              yield* remember(input.requestId, input, link);
            }),
          );
          return link;
        }),
      );
    const consume = Effect.fnUntraced(function* (receipt: IssueLifecycleReceipt) {
      const seen =
        yield* sql`SELECT event_key FROM issue_lifecycle_consumed WHERE event_key=${receipt.eventKey}`;
      if (seen.length) return;
      const rows =
        yield* sql<AttemptRow>`SELECT * FROM issue_attempts WHERE id=${receipt.link.attemptId}`;
      const attempt = rows[0];
      if (
        !attempt ||
        attempt.reservation_id !== receipt.link.reservationId ||
        hash(yield* parse(IssueAttemptLink, attempt.link_json)) !== hash(receipt.link) ||
        receipt.link.sourceEnvironmentId !== options.environmentId
      )
        return yield* error(
          "invalid",
          "The issue lifecycle receipt does not match its reservation.",
        );
      const board = yield* readBoard(attempt.board_id);
      yield* sql`INSERT INTO issue_lifecycle_consumed(event_key,attempt_id) VALUES(${receipt.eventKey},${attempt.id})`;
      if (receipt.kind === "started") {
        yield* sql`UPDATE issue_attempts SET project_id=${receipt.projectId},thread_id=${receipt.threadId},worktree_path=${receipt.worktreePath},status='started',started_at=${receipt.createdAt} WHERE id=${attempt.id}`;
        yield* sql`INSERT INTO issue_active_attempts(issue_key,attempt_id,launch_order) VALUES(${attempt.issue_key},${attempt.id},${attempt.launch_order})
        ON CONFLICT(issue_key) DO UPDATE SET attempt_id=excluded.attempt_id,launch_order=excluded.launch_order
        WHERE excluded.launch_order > issue_active_attempts.launch_order`;
      }
      const active = yield* sql<{
        attempt_id: string;
      }>`SELECT attempt_id FROM issue_active_attempts WHERE issue_key=${attempt.issue_key}`;
      if (active[0]?.attempt_id !== attempt.id || !board.mapping) return;
      if (receipt.pullRequest) {
        const key = `${receipt.pullRequest.host.toLowerCase()}/${receipt.pullRequest.repository.toLowerCase()}#${receipt.pullRequest.number}`;
        if (receipt.kind === "pr-created" || attempt.controlling_pr_key === null)
          yield* sql`UPDATE issue_attempts SET controlling_pr_key=${key} WHERE id=${attempt.id}`;
        else if (attempt.controlling_pr_key !== key) return;
      }
      const column =
        receipt.kind === "started"
          ? board.mapping.inProgress
          : receipt.kind === "pr-created"
            ? board.mapping.inPullRequest
            : receipt.state === "closed"
              ? board.mapping.inProgress
              : receipt.state === "open"
                ? board.mapping.inPullRequest
                : receipt.state === "merged" && board.mapping.moveOnMerge
                  ? board.mapping.completed
                  : null;
      if (column) {
        const generations = yield* sql<{
          generation: number;
        }>`SELECT generation FROM issue_generations WHERE issue_key=${attempt.issue_key}`;
        const current = generations[0]?.generation ?? 0;
        if (receipt.sourceGeneration > current)
          return yield* error(
            "invalid",
            "This lifecycle receipt claims a source generation that has not been issued.",
          );
        const id = yield* enqueueMove(
          `event:${receipt.eventKey}`,
          board.id,
          receipt.link.issue,
          column,
          attempt.id,
        );
        if (receipt.sourceGeneration < current)
          yield* sql`UPDATE issue_moves SET status='failed',error='This lifecycle event arrived after a manual move without observing its synchronization barrier. Retry only to apply this event deliberately.' WHERE id=${id}`;
      }
    });
    const ingestReceipts: IssueServiceShape["ingestReceipts"] = (input) =>
      lock(
        Effect.gen(function* () {
          for (const receipt of input.receipts) yield* transaction(consume(receipt));
          yield* flush;
          return { acknowledgedKeys: input.receipts.map((receipt) => receipt.eventKey) };
        }),
      );
    const emitReceipt = Effect.fnUntraced(function* (receipt: IssueLifecycleReceipt) {
      yield* sql`INSERT OR IGNORE INTO issue_lifecycle_outbox(event_key,receipt_json) VALUES(${receipt.eventKey},${json(receipt)})`;
      const boards = yield* sql`SELECT id FROM issue_boards WHERE id=${receipt.link.boardId}`;
      if (
        receipt.link.sourceEnvironmentId === receipt.link.destinationEnvironmentId &&
        boards.length
      ) {
        yield* consume(receipt);
        yield* sql`UPDATE issue_lifecycle_outbox SET acknowledged=1 WHERE event_key=${receipt.eventKey}`;
      }
    });
    const attachAttempt: IssueServiceShape["attachAttempt"] = (input) =>
      lock(
        transaction(
          Effect.gen(function* () {
            if (input.link.destinationEnvironmentId !== options.environmentId)
              return yield* error(
                "invalid",
                "The issue attempt destination does not match this server.",
              );
            const rows =
              yield* sql<AttemptRow>`SELECT * FROM issue_attempts WHERE id=${input.link.attemptId}`;
            if (
              rows[0] &&
              (rows[0].reservation_id !== input.link.reservationId ||
                (rows[0].thread_id && rows[0].thread_id !== input.threadId))
            )
              return yield* error(
                "conflict",
                "This issue attempt is already attached to another thread.",
              );
            if (!rows[0])
              yield* sql`INSERT INTO issue_attempts(id,reservation_id,board_id,issue_key,link_json,launch_order,project_id,thread_id,worktree_path,status,created_at,source_generation)
      VALUES(${input.link.attemptId},${input.link.reservationId},${input.link.boardId},${canonicalIssueKey(input.link.issue)},${json(input.link)},0,${input.projectId},${input.threadId},${input.worktreePath},'attached',${yield* now},${input.link.sourceGeneration})`;
            else
              yield* sql`UPDATE issue_attempts SET project_id=${input.projectId},thread_id=${input.threadId},worktree_path=${input.worktreePath},status=CASE WHEN status='started' THEN status ELSE 'attached' END WHERE id=${input.link.attemptId}`;
          }),
        ),
      );
    const receiptFor = Effect.fnUntraced(function* (
      row: AttemptRow,
      eventKey: string,
      kind: IssueLifecycleReceipt["kind"],
      extra: Partial<Pick<IssueLifecycleReceipt, "pullRequest" | "state">> = {},
    ) {
      if (!row.project_id || !row.thread_id || !row.worktree_path)
        return yield* error("invalid", "This attempt has no prepared worktree and thread.");
      return yield* decodeLifecycleValue({
        eventKey,
        link: yield* parse(IssueAttemptLink, row.link_json),
        projectId: row.project_id,
        threadId: row.thread_id,
        worktreePath: row.worktree_path,
        kind,
        ...extra,
        createdAt: yield* now,
        sourceGeneration: row.source_generation,
      }).pipe(Effect.mapError(storageError));
    });
    const firstPromptSent: IssueServiceShape["firstPromptSent"] = (input) =>
      lock(
        Effect.gen(function* () {
          yield* transaction(
            Effect.gen(function* () {
              const rows =
                yield* sql<AttemptRow>`SELECT * FROM issue_attempts WHERE thread_id=${input.threadId} AND started_at IS NULL`;
              for (const row of rows) {
                const receipt = yield* receiptFor(row, `start:${row.id}`, "started");
                yield* emitReceipt(receipt);
                yield* sql`UPDATE issue_attempts SET status='started',started_at=${receipt.createdAt} WHERE id=${row.id}`;
              }
            }),
          );
          yield* flush;
        }),
      );
    const observePullRequest: IssueServiceShape["observePullRequest"] = (input) =>
      lock(
        Effect.gen(function* () {
          yield* transaction(
            Effect.gen(function* () {
              const attempts =
                yield* sql<AttemptRow>`SELECT * FROM issue_attempts WHERE thread_id=${input.threadId} AND status='started'`;
              const key = `${input.key.host.toLowerCase()}/${input.key.repository.toLowerCase()}#${input.key.number}`;
              for (const attempt of attempts) {
                const rows = yield* sql<{
                  state: string;
                }>`SELECT state FROM issue_pr_observations WHERE attempt_id=${attempt.id} AND pr_key=${key}`;
                if (rows[0]?.state === input.state) continue;
                yield* sql`INSERT INTO issue_pr_observations(attempt_id,pr_key,state) VALUES(${attempt.id},${key},${input.state})
          ON CONFLICT(attempt_id,pr_key) DO UPDATE SET state=excluded.state`;
                const kind = !rows[0] && input.state === "open" ? "pr-created" : "pr-state-changed";
                if (!rows[0])
                  yield* sql`UPDATE issue_attempts SET controlling_pr_key=${key} WHERE id=${attempt.id}`;
                else if (attempt.controlling_pr_key !== null && attempt.controlling_pr_key !== key)
                  continue;
                const receipt = yield* receiptFor(
                  attempt,
                  `pr:${attempt.id}:${input.eventKey}`,
                  kind,
                  { pullRequest: input.key, state: input.state },
                );
                yield* emitReceipt(receipt);
              }
            }),
          );
          yield* flush;
        }),
      );
    const move: IssueServiceShape["move"] = (input) =>
      lock(
        Effect.gen(function* () {
          const replay = yield* requestReplay(input.requestId, input);
          if (replay) return yield* readMove(yield* parse(Schema.String, replay));
          const board = yield* readBoard(input.boardId);
          const remote = yield* options.host.board(
            (yield* project(board.projectId)).workspaceRoot,
            board.locator,
          );
          const item = remote.items.find(
            (item) => canonicalIssueKey(item.issue.ref) === canonicalIssueKey(input.issue),
          );
          if (!item) return yield* error("not-found", "The issue is no longer on this board.");
          if (
            (input.expectedPlacement !== undefined && input.expectedPlacement !== item.columnId) ||
            (input.expectedVersion !== undefined && input.expectedVersion !== item.version)
          )
            return yield* error(
              "conflict",
              "This ticket moved on another device. Refresh before moving it again.",
            );
          if (!remote.columns.some((column) => column.id === input.columnId))
            return yield* error("invalid", "The selected board column no longer exists.");
          const id = yield* transaction(
            Effect.gen(function* () {
              const key = canonicalIssueKey(item.issue.ref);
              yield* sql`INSERT INTO issue_generations(issue_key,generation) VALUES(${key},1)
        ON CONFLICT(issue_key) DO UPDATE SET generation=issue_generations.generation+1`;
              yield* sql`UPDATE issue_attempts SET source_generation=(SELECT generation FROM issue_generations WHERE issue_key=${key}) WHERE issue_key=${key}`;
              const id = yield* enqueueMove(
                `manual:${input.requestId}`,
                board.id,
                item.issue.ref,
                input.columnId,
                null,
              );
              yield* remember(input.requestId, input, id);
              return id;
            }),
          );
          yield* flush;
          return yield* readMove(id);
        }),
      );
    const retryMove: IssueServiceShape["retryMove"] = (input) =>
      lock(
        Effect.gen(function* () {
          const replay = yield* requestReplay(input.requestId, input);
          if (replay) return yield* readMove(input.moveId);
          const receipt = yield* readMove(input.moveId);
          if (receipt.status === "failed")
            yield* sql`UPDATE issue_moves SET status='pending',error=NULL WHERE id=${input.moveId}`;
          yield* flush;
          yield* remember(input.requestId, input, input.moveId);
          return yield* readMove(input.moveId);
        }),
      );
    const disconnectBoard: IssueServiceShape["disconnectBoard"] = (input) =>
      lock(
        transaction(
          Effect.gen(function* () {
            if (yield* requestReplay(input.requestId, input)) return;
            yield* sql`UPDATE issue_moves SET status='superseded',error=NULL WHERE board_id=${input.boardId} AND status IN ('pending','failed')`;
            yield* sql`DELETE FROM issue_boards WHERE id=${input.boardId}`;
            yield* remember(input.requestId, input, true);
          }),
        ),
      );
    const listBoards: IssueServiceShape["listBoards"] = (input) =>
      protect(
        Effect.gen(function* () {
          const saved =
            yield* sql<BoardRow>`SELECT * FROM issue_boards WHERE project_id=${input.projectId}`;
          const configs = yield* Effect.forEach(saved, decodeBoard);
          if (input.connectedOnly) return configs;
          const discovery = yield* scope(input.projectId).pipe(
            Effect.flatMap((scope) => options.host.listBoards(scope)),
            Effect.result,
          );
          if (discovery._tag === "Failure") {
            if (configs.length) return configs;
            return yield* discovery.failure;
          }
          const results = new Map(configs.map((board) => [board.id, board]));
          for (const board of discovery.success) {
            const id = issueBoardId(input.projectId, board.locator);
            if (!results.has(id))
              results.set(id, { id, projectId: input.projectId, ...board, mapping: null });
          }
          return [...results.values()];
        }),
      );
    const listReceipts: IssueServiceShape["listReceipts"] = (input) =>
      protect(
        Effect.gen(function* () {
          const rows = yield* sql<{
            sequence: number;
            receipt_json: string;
          }>`SELECT sequence,receipt_json FROM issue_lifecycle_outbox WHERE acknowledged=0 AND sequence>${input.after ?? 0} ORDER BY sequence LIMIT 100`;
          return {
            receipts: yield* Effect.forEach(rows, (row) =>
              parse(IssueLifecycleReceipt, row.receipt_json),
            ),
            nextCursor: rows.at(-1)?.sequence ?? input.after ?? 0,
          };
        }),
      );
    const acknowledgeReceipts: IssueServiceShape["acknowledgeReceipts"] = (input) =>
      lock(
        Effect.gen(function* () {
          for (const key of input.acknowledgedKeys)
            yield* sql`UPDATE issue_lifecycle_outbox SET acknowledged=1 WHERE event_key=${key}`;
        }),
      );
    const syncAttemptGenerations: IssueServiceShape["syncAttemptGenerations"] = (input) =>
      lock(
        transaction(
          Effect.gen(function* () {
            for (const generation of input.generations) {
              const rows =
                yield* sql<AttemptRow>`SELECT * FROM issue_attempts WHERE id=${generation.attemptId}`;
              const row = rows[0];
              if (!row || row.reservation_id !== generation.reservationId)
                return yield* error(
                  "invalid",
                  "This generation update does not match a known issue attempt.",
                );
              const link = yield* parse(IssueAttemptLink, row.link_json);
              if (link.destinationEnvironmentId !== options.environmentId)
                return yield* error(
                  "invalid",
                  "This attempt does not belong to the destination server.",
                );
              yield* sql`UPDATE issue_attempts SET source_generation=MAX(source_generation,${generation.sourceGeneration}) WHERE id=${row.id}`;
            }
          }),
        ),
      );
    return {
      list: (input) =>
        scope(input.projectId).pipe(
          Effect.flatMap((scope) => options.host.list(scope, input.cursor)),
        ),
      get: (input) =>
        project(input.projectId).pipe(
          Effect.flatMap((project) =>
            options.host.get({ cwd: project.workspaceRoot, ref: input.issue }),
          ),
        ),
      listBoards,
      openBoard,
      configureBoard,
      disconnectBoard,
      move,
      retryMove,
      reserveAttempt,
      listAttempts,
      listReceipts,
      ingestReceipts,
      acknowledgeReceipts,
      syncAttemptGenerations,
      attachAttempt,
      firstPromptSent,
      observePullRequest,
      drain: lock(flush),
    } satisfies IssueServiceShape;
  });
export const make = Effect.gen(function* () {
  const host = yield* IssueHost;
  const projection = yield* ProjectionSnapshotQuery;
  const environment = yield* ServerEnvironmentIdentity;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
  return yield* makeIssueService({
    host,
    resolveRepositoryIdentity: repositoryIdentityResolver.resolve,
    environmentId: yield* environment.getEnvironmentId,
    getProject: (id) =>
      projection
        .getProjectShellById(id)
        .pipe(Effect.map(Option.getOrNull), Effect.mapError(storageError)),
  });
});
export const layer = Layer.effect(IssueService, make);
