import {
  IssueOperationError,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type IssueBoardItem,
  type IssueBoardLocator,
  type IssueBoardMapping,
  type IssueRef,
  type OrchestrationProjectShell,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type {
  IssueHostAdapter,
  IssueHostBoards,
  RemoteIssueBoard,
} from "@t3tools/source-control-core/server/IssueHostAdapter";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";

import { fromAdapters } from "./IssueHost.ts";
import {
  issueBoardId,
  makeIssueService,
  type IssueServiceDependencies,
  type IssueThreadFacts,
  type IssueThreadLaunch,
} from "./IssueService.ts";
import { IssueBoardsV2 } from "./migrations/IssueBoardsV2.ts";

export const PROJECT_ID = ProjectId.make("project-1");
export const EPOCH = "1970-01-01T00:00:00.000Z";

const LOCATOR: IssueBoardLocator = {
  kind: "github-project",
  host: "github.com",
  owner: "acme",
  ownerKind: "organization",
  projectNumber: 1,
};
export const BOARD_ID = issueBoardId(PROJECT_ID, LOCATOR);

const COLUMNS = [
  { id: "ready", title: "Ready" },
  { id: "progress", title: "In progress" },
  { id: "pr", title: "In PR" },
  { id: "done", title: "Done" },
  { id: "blocked", title: "Blocked" },
] as const;
export type ColumnId = (typeof COLUMNS)[number]["id"];

const DEFAULT_MAPPING: IssueBoardMapping = {
  ready: ["ready"],
  inProgress: "progress",
  inPullRequest: "pr",
  completed: "done",
  moveOnMerge: true,
};

const GITHUB = SourceControlProviderKind.make("github");

export const issueRef = (number: number): IssueRef => ({
  hostKind: GITHUB,
  host: "github.com",
  repository: "acme/app",
  id: `I_${number}`,
  number,
  url: `https://github.com/acme/app/issues/${number}`,
});

const PROJECT: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "App",
  workspaceRoot: "/repo",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/app.git",
    },
    provider: "github",
    owner: "acme",
    name: "app",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: EPOCH,
  updatedAt: EPOCH,
};

export const remoteFailure = (message = "The repository host did not answer.") =>
  new IssueOperationError({ reason: "remote", message });
export const authenticationFailure = (message = "The GitHub token has expired.") =>
  new IssueOperationError({ reason: "authentication", message });

export type PullRequestState = "draft" | "open" | "closed" | "merged";

export interface HarnessOptions {
  /** Tickets on the board, numbered from 1, all starting in Ready. */
  readonly tickets?: number;
}

/**
 * An issue service on an in-memory database, talking to a fake GitHub Project and fake threads.
 * Tests change the remote board "by hand" and the thread facts directly, then observe the board,
 * the attempts, and the writes the service sent to the host.
 */
export const makeIssueHarness = Effect.fn("makeIssueHarness")(function* (
  options: HarnessOptions = {},
) {
  yield* IssueBoardsV2;

  const tickets = new Map<number, { columnId: string | null; version: number }>();
  for (let number = 1; number <= (options.tickets ?? 3); number++)
    tickets.set(number, { columnId: "ready", version: 1 });
  const failures: {
    read: IssueOperationError | null;
    readItem: IssueOperationError | null;
    move: IssueOperationError | null;
    launch: IssueOperationError | null;
    get: IssueOperationError | null;
  } = { read: null, readItem: null, move: null, launch: null, get: null };
  const calls = { reads: 0, itemReads: 0, moves: 0 };
  const writes: Array<{ readonly ticket: number; readonly columnId: string }> = [];
  const launches: IssueThreadLaunch[] = [];
  const threads = new Map<string, IssueThreadFacts>();
  let heldRead: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | null =
    null;
  let threadCount = 0;
  let linkCount = 0;

  const itemOf = (number: number): IssueBoardItem => {
    const ticket = tickets.get(number)!;
    return {
      issue: {
        ref: issueRef(number),
        title: `Ticket ${number}: make the board load faster on large projects`,
        state: "open",
        updatedAt: "2026-10-01T00:00:00.000Z",
        labels: ["enhancement", "boards"],
      },
      itemId: `PVTI_${number}`,
      columnId: ticket.columnId,
      version: String(ticket.version),
    };
  };
  const numberOfItem = (item: IssueBoardItem) => Number(item.itemId.slice("PVTI_".length));
  const setColumn = (number: number, columnId: string | null) => {
    const ticket = tickets.get(number)!;
    tickets.set(number, { columnId, version: ticket.version + 1 });
  };

  const boards: IssueHostBoards<"github-project"> = {
    locatorKind: "github-project",
    list: () => Effect.succeed([{ title: "Acme roadmap", locator: LOCATOR }]),
    read: (_cwd, locator) =>
      Effect.gen(function* () {
        calls.reads++;
        if (failures.read) return yield* failures.read;
        // The copy is taken before a held read waits, as a real response would be.
        const remote: RemoteIssueBoard = {
          title: "Acme roadmap",
          locator,
          columns: COLUMNS,
          items: [...tickets.keys()].map(itemOf),
        };
        const held = heldRead;
        heldRead = null;
        if (held) {
          yield* Deferred.succeed(held.started, undefined);
          yield* Deferred.await(held.release);
        }
        return remote;
      }),
    readItem: (_cwd, _locator, item) =>
      Effect.gen(function* () {
        calls.itemReads++;
        if (failures.readItem) return yield* failures.readItem;
        const number = numberOfItem(item);
        if (!tickets.has(number))
          return yield* new IssueOperationError({
            reason: "not-found",
            message: "The item is no longer on the board.",
          });
        return itemOf(number);
      }),
    move: (_cwd, _locator, item, columnId) =>
      Effect.gen(function* () {
        calls.moves++;
        if (failures.move) return yield* failures.move;
        const number = numberOfItem(item);
        setColumn(number, columnId);
        writes.push({ ticket: number, columnId });
      }),
  };
  const adapter: IssueHostAdapter = {
    kind: GITHUB,
    list: () => Effect.succeed({ issues: [], nextCursor: null }),
    get: (scope) =>
      failures.get
        ? Effect.fail(failures.get)
        : Effect.succeed({
            ...itemOf(scope.ref.number).issue,
            body: `Steps to reproduce ticket ${scope.ref.number}.`,
            comments: [
              {
                id: "c1",
                body: "Still reproduces on main.",
                createdAt: "2026-10-17T09:00:00.000Z",
                author: { name: "rob" },
              },
            ],
          }),
    boards,
  };

  const dependencies: IssueServiceDependencies = {
    hosts: fromAdapters([adapter]),
    getProject: (id) => Effect.succeed(id === PROJECT_ID ? PROJECT : null),
    readThread: (threadId) => Effect.sync(() => threads.get(threadId) ?? null),
    allocateThreadId: () => Effect.sync(() => ThreadId.make(`thread-${++threadCount}`)),
    launchThread: (input) =>
      Effect.gen(function* () {
        launches.push(input);
        if (failures.launch) return yield* failures.launch;
        if (!threads.has(input.threadId))
          threads.set(input.threadId, {
            deleted: false,
            worktreePath: null,
            firstRun: "pending",
            pullRequests: [],
          });
      }),
  };
  const service = yield* makeIssueService(dependencies);

  const updateThread = (
    threadId: ThreadId,
    change: (facts: IssueThreadFacts) => IssueThreadFacts,
  ) =>
    Effect.sync(() => {
      const facts = threads.get(threadId);
      if (!facts) throw new Error(`No thread ${threadId}`);
      threads.set(threadId, change(facts));
    });
  const snapshotOf = (number: number, state: PullRequestState, linkedAt: string) => ({
    state: state === "draft" ? ("open" as const) : state,
    title: `Fix ticket ${number}`,
    headBranch: `issue-${number}`,
    baseBranch: "main",
    isDraft: state === "draft",
    updatedAt: linkedAt,
    syncedAt: linkedAt,
  });

  return {
    service,
    /** A second service on the same database, as after a server restart. */
    restart: makeIssueService(dependencies),
    calls,
    writes,
    launches,

    remoteColumn: (number: number) => tickets.get(number)?.columnId ?? null,
    /** A person moves the ticket on GitHub, outside this environment. */
    moveByHand: (number: number, columnId: ColumnId) =>
      Effect.sync(() => setColumn(number, columnId)),
    fail: (operation: keyof typeof failures, failure: IssueOperationError | null) =>
      Effect.sync(() => {
        failures[operation] = failure;
      }),
    /** Holds the next board read open after it has copied the board, until released. */
    holdNextRead: Effect.gen(function* () {
      const held = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      heldRead = held;
      return held;
    }),

    configureBoard: (mapping: Partial<IssueBoardMapping> = {}, requestId = "configure") =>
      service.configureBoard({
        requestId,
        projectId: PROJECT_ID,
        locator: LOCATOR,
        mapping: { ...DEFAULT_MAPPING, ...mapping },
      }),
    startAttempt: (number: number, requestId = `start-${number}`) =>
      service.startAttempt({
        requestId,
        boardId: BOARD_ID,
        issue: issueRef(number),
        projectId: PROJECT_ID,
        prompt: "Fix this ticket.",
        branch: `issue-${number}`,
        baseRef: "main",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    openBoard: (refresh?: boolean) =>
      service.openBoard({
        projectId: PROJECT_ID,
        boardId: BOARD_ID,
        ...(refresh ? { refresh } : {}),
      }),
    storedColumn: (number: number) =>
      service
        .openBoard({ projectId: PROJECT_ID, boardId: BOARD_ID })
        .pipe(
          Effect.map(
            (view) => view.items.find((item) => item.issue.ref.number === number)?.columnId ?? null,
          ),
        ),
    attemptsOf: (number: number) =>
      service.listAttempts({ boardId: BOARD_ID, issue: issueRef(number) }),
    /** The latest move the board shows for a ticket. */
    latestMove: (number: number) =>
      service
        .openBoard({ projectId: PROJECT_ID, boardId: BOARD_ID })
        .pipe(Effect.map((view) => view.moves.find((move) => move.issue.number === number))),

    /** The worktree exists and the thread's first run reached running. */
    threadRunning: (threadId: ThreadId) =>
      updateThread(threadId, (facts) => ({
        ...facts,
        worktreePath: `/repo/.t3/worktrees/${threadId}`,
        firstRun: "running",
      })),
    firstRunFailed: (threadId: ThreadId) =>
      updateThread(threadId, (facts) => ({
        ...facts,
        worktreePath: `/repo/.t3/worktrees/${threadId}`,
        firstRun: "failed-before-running",
      })),
    /** Links a pull request newer than every earlier link. */
    linkPullRequest: (threadId: ThreadId, number: number, state: PullRequestState) =>
      updateThread(threadId, (facts) => {
        const linkedAt = DateTime.formatIso(
          DateTime.makeUnsafe(Date.UTC(2026, 9, 1) + ++linkCount * 60_000),
        );
        const link: ThreadPullRequestLink = {
          host: "github.com",
          repository: "acme/app",
          number,
          url: `https://github.com/acme/app/pull/${number}`,
          source: "agent",
          linkedAt,
          snapshot: snapshotOf(number, state, linkedAt),
          stack: null,
        };
        return { ...facts, pullRequests: [...facts.pullRequests, link] };
      }),
    setPullRequest: (threadId: ThreadId, number: number, state: PullRequestState) =>
      updateThread(threadId, (facts) => ({
        ...facts,
        pullRequests: facts.pullRequests.map((link) =>
          link.number === number
            ? { ...link, snapshot: snapshotOf(number, state, link.linkedAt) }
            : link,
        ),
      })),
    unlinkPullRequest: (threadId: ThreadId, number: number) =>
      updateThread(threadId, (facts) => ({
        ...facts,
        pullRequests: facts.pullRequests.filter((link) => link.number !== number),
      })),
    deleteThread: (threadId: ThreadId) =>
      updateThread(threadId, (facts) => ({ ...facts, deleted: true })),
  };
});

export type IssueHarness = Effect.Success<ReturnType<typeof makeIssueHarness>>;

export const withDatabase = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
