import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  FactoryConfig,
  FactoryOperationError,
  IssueBoardView,
  IssueSummary,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type FactoryConfigSettings,
  type FactoryLeadDefinition,
  type FactoryManager,
  type FactoryManagerDefinition,
  type FactoryModelRef,
  type FactoryTeamDefinition,
  type FactoryWorkerDefinition,
  type FactoryOnboardingProposalInput,
  type FactoryOnboardingResult,
  type FactoryPickupInput,
  type FactoryRole,
  type IssueAttemptsStartInput,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import type { RateTable } from "../usage/usagePricing.ts";
import {
  makeFactoryService,
  type FactoryDigestRequest,
  type FactoryServiceDependencies,
  type FactoryThreadActivity,
  type FactoryThreadInterrupt,
  type FactoryThreadLaunch,
  type FactoryPullRequestRef,
  type FactoryThreadMessage,
  type FactoryThreadRuns,
  type FactoryThreadTurn,
} from "./FactoryService.ts";
import * as FactoryConfigStore from "./config/FactoryConfigStore.ts";
import type { FactoryModelCatalog } from "./config/modelResolution.ts";
import { FactoryDefinitionsV1 } from "./migrations/FactoryDefinitionsV1.ts";
import { FactoryManagersPerProjectV1 } from "./migrations/FactoryManagersPerProjectV1.ts";
import { FactoryOnboardingResultV1 } from "./migrations/FactoryOnboardingResultV1.ts";
import { FactoryV1 } from "./migrations/FactoryV1.ts";
import type { RoleSkillSource } from "./roleSkills.ts";
import { DEFAULT_ROLE_SKILLS } from "./roles/index.ts";

export const PROJECT_ID = ProjectId.make("project-1");

export const EPOCH = "1970-01-01T00:00:00.000Z";

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

const model = Schema.decodeSync(ModelSelection);
export const OPUS = model({ instanceId: "claude", model: "claude-opus-5-5" });
export const SONNET = model({ instanceId: "claude", model: "claude-sonnet-5" });
export const GPT = model({ instanceId: "codex", model: "gpt-6" });

export const decodeConfig = Schema.decodeSync(FactoryConfig);

export const preset = (name: string, workflow: string, models?: ReadonlyArray<typeof OPUS>) => ({
  id: `preset-${name}-${workflow}`,
  name,
  useWhen: "",
  members: [{ role: "implementer" as const, count: 1, ...(models ? { models } : {}) }],
  workflow,
  createdBy: "user" as const,
});

export const ENVIRONMENT = decodeConfig({
  concurrencyCap: 3,
  modelPool: [OPUS, SONNET],
  roleModels: { manager: OPUS },
  teamPresets: [preset("Solo", "environment"), preset("Pair", "environment")],
});

export const withDatabase = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    SqlClient.SqlClient | Scope.Scope | FileSystem.FileSystem | Path.Path
  >,
) =>
  effect.pipe(
    Effect.provide(
      Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  );

/** What the fake environment runs: instance `claude` is Claude Agent, `codex` is Codex. */
export const CATALOG: FactoryModelCatalog = [
  {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [OPUS.model, SONNET.model],
  },
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    models: [GPT.model],
  },
];
export const refOf = (selection: ModelSelection): FactoryModelRef => ({
  driver: CATALOG.find((entry) => entry.instanceId === selection.instanceId)!.driver,
  model: selection.model,
});

export const ANY_MODEL = { dynamic: false, models: [] };
export const DEFAULT_LEAD = {
  id: "default",
  name: "Default lead",
  models: ANY_MODEL,
  instructions: "",
};
/** The team a harness with a config staffs by default: a lead and one implementer. */
export const STANDARD_TEAM: FactoryTeamDefinition = {
  id: "standard",
  name: "Standard",
  useWhen: "Most tickets.",
  workflow: "",
  mayEditProtectedPaths: false,
  createdBy: "user",
  lead: DEFAULT_LEAD,
  members: [
    {
      id: "implementer",
      name: "Implementer",
      count: 1,
      models: ANY_MODEL,
      description: "Implements the change.",
    },
  ],
};

/** Written to the harness's factory config files; absent parts follow the database config. */
interface HarnessDefinitions {
  readonly settings?: FactoryConfigSettings;
  readonly workers?: ReadonlyArray<FactoryWorkerDefinition>;
  readonly leads?: ReadonlyArray<FactoryLeadDefinition>;
  readonly managers?: ReadonlyArray<FactoryManagerDefinition>;
  readonly teams?: ReadonlyArray<FactoryTeamDefinition>;
}

interface HarnessOptions {
  /** Saved as the environment config before the service is returned. */
  readonly config?: FactoryConfig;
  /**
   * The factory config files. A harness with `config` or `definitions` gets that config's pool and
   * recovery allowance and the Standard team unless these say otherwise; one with neither starts
   * with no files.
   */
  readonly definitions?: HarnessDefinitions;
  /** How many launches fail before one succeeds. */
  readonly launchFailures?: number;
  readonly readRoleSkill?: (role: FactoryRole, projectRoot: string) => RoleSkillSource;
}

const decodeIssue = Schema.decodeSync(IssueSummary);
const decodeBoardView = Schema.decodeSync(IssueBoardView);
export const BACKLOG = "column-backlog";
export const READY = "column-ready";
export const IN_PROGRESS = "column-progress";

export const issue = (number: number, updatedAt = EPOCH, labels: ReadonlyArray<string> = []) =>
  decodeIssue({
    ref: {
      hostKind: "github",
      host: "github.com",
      repository: "acme/app",
      id: `issue-node-${number}`,
      number,
      url: `https://github.com/acme/app/issues/${number}`,
    },
    title: `Ticket ${number}`,
    state: "open",
    updatedAt,
    labels,
  });

/** One connected board whose tickets sit in the given columns, mapping `ready` as Ready. */
export const board = (
  items: ReadonlyArray<{
    readonly number: number;
    readonly columnId: string;
    readonly updatedAt?: string;
    readonly labels?: ReadonlyArray<string>;
  }>,
  ready: string | ReadonlyArray<string> = READY,
) =>
  decodeBoardView({
    board: {
      id: "board-1",
      projectId: PROJECT_ID,
      title: "Roadmap",
      locator: {
        kind: "github-project",
        host: "github.com",
        owner: "acme",
        ownerKind: "organization",
        projectNumber: 1,
      },
      mapping: {
        ready,
        inProgress: IN_PROGRESS,
        inPullRequest: "column-review",
        completed: "column-done",
        moveOnMerge: true,
      },
    },
    columns: [
      { id: BACKLOG, title: "Backlog" },
      { id: READY, title: "Ready" },
      { id: IN_PROGRESS, title: "In progress" },
    ],
    items: items.map((item) => ({
      issue: issue(item.number, item.updatedAt, item.labels),
      itemId: `item-${item.number}`,
      columnId: item.columnId,
      version: "v1",
    })),
    attempts: [],
    moves: [],
  });

/** What the fakes do next; tests change it between calls. */
interface HarnessControls {
  sendFailures: number;
  attemptFailures: number;
  fileReadFailures: number;
  ticketFailures: number;
  /** How many thread launches fail before one succeeds. */
  launchFailures: number;
  /** Runs once inside the next launch, before it succeeds or fails. */
  duringLaunch: Effect.Effect<void, FactoryOperationError> | null;
  /** What the usage rate cache holds; null when usage tracking has cached none. */
  rateTable: RateTable | null;
  /** What the text-generation model answers a digest request with. */
  summary: Effect.Effect<string, FactoryOperationError>;
  /** The repository's default branch as git reports it; null when it cannot be read. */
  defaultBranch: string | null;
  /** What the environment can run, which factory model names resolve against. */
  catalog: FactoryModelCatalog;
}

type TicketRequest = Parameters<FactoryServiceDependencies["createTicket"]>[0];

export const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    yield* FactoryV1;
    yield* FactoryOnboardingResultV1;
    yield* FactoryDefinitionsV1;
    yield* FactoryManagersPerProjectV1;
    const launches: FactoryThreadLaunch[] = [];
    const skillReads: Array<readonly [FactoryRole, string]> = [];
    const boards: IssueBoardView[] = [];
    const attemptStarts: IssueAttemptsStartInput[] = [];
    const sentMessages: FactoryThreadMessage[] = [];
    const interrupts: FactoryThreadInterrupt[] = [];
    const settles: ThreadId[] = [];
    const threadRuns = new Map<ThreadId, FactoryThreadRuns>();
    const threadTurns = new Map<ThreadId, ReadonlyArray<FactoryThreadTurn>>();
    const threadActivity = new Map<ThreadId, ReadonlyArray<FactoryThreadActivity>>();
    const summaryRequests: FactoryDigestRequest[] = [];
    const controls: HarnessControls = {
      sendFailures: 0,
      attemptFailures: 0,
      fileReadFailures: 0,
      ticketFailures: 0,
      launchFailures: options.launchFailures ?? 0,
      duringLaunch: null,
      rateTable: null,
      summary: Effect.sync(() => ` Digest ${summaryRequests.length}. `),
      defaultBranch: "trunk",
      catalog: CATALOG,
    };
    const ticketRequests: TicketRequest[] = [];
    /** Changed files by pull request number. */
    const pullRequestFiles = new Map<number, ReadonlyArray<string>>();
    const fileReads: FactoryPullRequestRef[] = [];
    let threads = 0;
    // A real config store in a scratch directory, so definitions round-trip through their files.
    const configStore = yield* FactoryConfigStore.FactoryConfigStore.pipe(
      Effect.provide(
        FactoryConfigStore.layerAt(
          yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "t3-factory-" }),
        ),
      ),
    );
    if (options.config !== undefined || options.definitions !== undefined) {
      const files = options.definitions ?? {};
      yield* configStore.writeSettings(
        files.settings ?? {
          version: 1,
          modelPool: (options.config?.modelPool ?? []).map(refOf),
          recoveryAllowance: options.config?.recoveryAllowance ?? 1,
        },
      );
      for (const worker of files.workers ?? []) yield* configStore.writeWorker(worker);
      for (const lead of files.leads ?? []) yield* configStore.writeLead(lead);
      for (const manager of files.managers ?? []) yield* configStore.writeManager(manager);
      for (const team of files.teams ?? [STANDARD_TEAM]) yield* configStore.writeTeam(team);
    }
    const service = yield* makeFactoryService({
      getProject: (id) => Effect.succeed(id === PROJECT_ID ? PROJECT : null),
      allocateThreadId: () => Effect.sync(() => ThreadId.make(`thread-${++threads}`)),
      launchThread: (input) =>
        Effect.suspend(() => {
          launches.push(input);
          const during = controls.duringLaunch ?? Effect.void;
          controls.duringLaunch = null;
          return during.pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (controls.launchFailures === 0) return Effect.void;
                controls.launchFailures -= 1;
                return Effect.fail(
                  new FactoryOperationError({
                    reason: "unavailable",
                    message: "Provider is offline.",
                  }),
                );
              }),
            ),
          );
        }),
      configStore,
      readModelCatalog: Effect.sync(() => controls.catalog),
      readRoleSkill: (role, projectRoot) =>
        Effect.sync(() => {
          skillReads.push([role, projectRoot]);
          return (
            options.readRoleSkill?.(role, projectRoot) ?? {
              text: DEFAULT_ROLE_SKILLS[role],
              source: "default",
            }
          );
        }),
      readBoards: (projectId) =>
        Effect.sync(() =>
          boards.filter((view) => view.board.projectId === projectId).map((view) => view.board),
        ),
      readBoard: (_projectId, boardId) =>
        Effect.suspend(() => {
          const view = boards.find((candidate) => candidate.board.id === boardId);
          return view
            ? Effect.succeed(view)
            : Effect.fail(new FactoryOperationError({ reason: "not-found", message: "No board." }));
        }),
      startAttempt: (input) =>
        Effect.suspend(() => {
          attemptStarts.push(input);
          if (controls.attemptFailures > 0) {
            controls.attemptFailures -= 1;
            return Effect.fail(
              new FactoryOperationError({ reason: "conflict", message: "The ticket moved." }),
            );
          }
          const threadId = ThreadId.make(`lead-${attemptStarts.length}`);
          return Effect.succeed({
            threadId,
            attempt: {
              id: `attempt-${attemptStarts.length}`,
              boardId: input.boardId,
              issue: input.issue,
              projectId: input.projectId,
              threadId,
              worktreePath: null,
              status: "launching" as const,
              active: false,
              endedReason: null,
              automaticMoves: "on" as const,
              createdAt: EPOCH,
              startedAt: null,
              controllingPullRequest: null,
            },
          });
        }),
      readThreadRuns: (threadId) => Effect.sync(() => threadRuns.get(threadId) ?? null),
      readThreadTurns: (threadId) => Effect.sync(() => threadTurns.get(threadId) ?? []),
      readThreadActivity: (threadId) => Effect.sync(() => threadActivity.get(threadId) ?? []),
      generateSummary: (input) =>
        Effect.suspend(() => {
          summaryRequests.push(input);
          return controls.summary;
        }),
      readRateTable: Effect.sync(() => controls.rateTable),
      sendToThread: (input) =>
        Effect.suspend(() => {
          if (controls.sendFailures === 0) {
            sentMessages.push(input);
            return Effect.void;
          }
          controls.sendFailures -= 1;
          return Effect.fail(
            new FactoryOperationError({ reason: "unavailable", message: "Thread is busy." }),
          );
        }),
      interruptThread: (input) => Effect.sync(() => void interrupts.push(input)),
      settleThread: (input) => Effect.sync(() => void settles.push(input.threadId)),
      readDefaultBranch: () => Effect.sync(() => controls.defaultBranch),
      readPullRequestFiles: (input) =>
        Effect.suspend(() => {
          fileReads.push(input);
          if (controls.fileReadFailures === 0)
            return Effect.succeed(pullRequestFiles.get(input.number) ?? []);
          controls.fileReadFailures -= 1;
          return Effect.fail(
            new FactoryOperationError({ reason: "unavailable", message: "GitHub is down." }),
          );
        }),
      createTicket: (input) =>
        Effect.suspend(() => {
          ticketRequests.push(input);
          if (controls.ticketFailures === 0)
            return Effect.succeed(issue(100 + ticketRequests.length).ref);
          controls.ticketFailures -= 1;
          return Effect.fail(
            new FactoryOperationError({ reason: "unavailable", message: "GitHub is down." }),
          );
        }),
    });
    if (options.config)
      yield* service.updateConfig({ scope: "environment", config: options.config });
    return {
      service,
      configStore,
      launches,
      skillReads,
      boards,
      attemptStarts,
      sentMessages,
      interrupts,
      settles,
      threadRuns,
      threadTurns,
      threadActivity,
      summaryRequests,
      controls,
      pullRequestFiles,
      fileReads,
      ticketRequests,
    };
  });

export const makeService = makeHarness().pipe(Effect.map(({ service }) => service));
/** Managers need a model pool to launch from. */
export const makeManagerService = makeHarness({ config: ENVIRONMENT }).pipe(
  Effect.map(({ service }) => service),
);

type Service = Effect.Success<typeof makeService>;

export const PROPOSAL: FactoryOnboardingProposalInput = {
  summary: "pnpm workspace; CI runs lint and tests.",
  purpose: "A todo app for small teams.",
  pickup: { enabled: true, guidance: "Small, well-specified bugs." },
  rules: [
    {
      id: "small-tickets",
      question: "Which tickets count as small?",
      options: ["One file", "One package"],
      recommended: 0,
      reason: "Reviews stay short.",
    },
  ],
  controlPaths: [
    { path: ".github/workflows/**", reason: "CI decides what ships." },
    { path: "AGENTS.md", reason: "" },
  ],
  findings: ["Pull requests need one approving review."],
};

/** Pickup from board-1's Ready column, with the proposed guidance and question answered. */
export const RESULT: FactoryOnboardingResult = {
  purpose: "A todo app for small teams.",
  pickup: {
    enabled: true,
    columns: [{ boardId: "board-1", columnId: READY }],
    labels: [],
    guidance: "Small, well-specified bugs.",
  },
  baseBranch: null,
  rules: [{ id: "small-tickets", question: "Which tickets count as small?", answer: "One file" }],
  controlPaths: [{ path: "AGENTS.md", reason: "Agent instructions." }],
  teamIds: [],
  concurrencyCap: 1,
};

export const create = (service: Service, requestId = "create-1", name = "Ada") =>
  service.createManager({ requestId, projectId: PROJECT_ID, name });

export const managerRowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM factory_managers`;
  return rows[0]?.count;
});

/** One slot, a lead model for small work, and nothing set for large work. */
export const FACTORY = decodeConfig({
  concurrencyCap: 1,
  modelPool: [OPUS, SONNET],
  roleModels: { manager: OPUS, lead: { small: SONNET } },
});

/** FACTORY's lead model for small tickets, as the Standard team's lead copy now holds it. */
export const SONNET_LEAD = { ...DEFAULT_LEAD, models: { dynamic: false, models: [refOf(SONNET)] } };
export const makeFactory = makeHarness({
  config: FACTORY,
  definitions: { teams: [{ ...STANDARD_TEAM, lead: SONNET_LEAD }] },
});
export type Factory = Effect.Success<typeof makeFactory>;

export const approve = (
  factory: Factory,
  managerId: string,
  threadId: ThreadId,
  result: FactoryOnboardingResult = RESULT,
) =>
  Effect.gen(function* () {
    yield* factory.service.proposeOnboarding(threadId, PROPOSAL);
    // Approval reads the pickup column live; tests that add their tickets later start boardless.
    const connected = factory.boards.some((view) => view.board.id === "board-1");
    if (!connected) factory.boards.push(board([]));
    const approved = yield* factory.service.approveOnboarding({
      requestId: `approve-${managerId}`,
      managerId,
      result,
    });
    const manager =
      approved.state === "ready"
        ? yield* factory.service.startPickup({ requestId: `start-${managerId}`, managerId })
        : approved;
    if (!connected) factory.boards.pop();
    return manager;
  });

export const activeManager = (factory: Factory, result?: FactoryOnboardingResult) =>
  Effect.gen(function* () {
    const created = yield* create(factory.service);
    return yield* approve(factory, created.id, created.threadId!, result);
  });

export const START = {
  decision: "start",
  complexity: "small",
  reason: "Matches the guidance: a small bug.",
  brief: "Fix the crash when the list is empty.",
  completionCondition: "An empty list renders without errors and a test covers it.",
} as const;

export const startTicket = (factory: Factory, threadId: ThreadId, issueNumber = 1) =>
  factory.service.pickup(threadId, { ...START, issueNumber });

/** The manager's newest log sequence, so a test reads only the entries its own steps wrote. */
export const logMark = (service: Service, managerId: string) =>
  service.listLog({ managerId, limit: 1 }).pipe(Effect.map(([newest]) => newest?.sequence ?? 0));

/** The manager's log entries after `mark`, oldest first. */
const logSince = (service: Service, managerId: string, mark: number) =>
  service
    .listLog({ managerId })
    .pipe(Effect.map((entries) => entries.filter((entry) => entry.sequence > mark).toReversed()));

/** What a test measures its own steps from once setup is done. */
export const setupDone = (factory: Factory, manager: FactoryManager) =>
  Effect.gen(function* () {
    return {
      manager,
      mark: yield* logMark(factory.service, manager.id),
      sentBefore: factory.sentMessages.length,
    };
  });

export const logKinds = (service: Service, managerId: string, mark: number) =>
  logSince(service, managerId, mark).pipe(
    Effect.map((entries) => entries.map((entry) => entry.kind)),
  );

export const memberRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    thread_id: string;
    assignment_id: string;
    role: string;
    parent_thread_id: string;
    joined: string;
  }>`SELECT thread_id,assignment_id,role,parent_thread_id,joined FROM factory_members`;
});

export const SYNC_WORK = {
  title: "Rework the sync engine",
  brief: "The user asked for the sync rework.",
  completionCondition: "Sync survives a restart mid-transfer.",
  complexity: "large",
} as const;

/** A lead thread at rest after a completed run, with no questions or pull requests. */
export const idleRun = (overrides: Partial<FactoryThreadRuns> = {}): FactoryThreadRuns => ({
  deleted: false,
  latestRunStatus: "completed",
  runInProgress: false,
  pendingRequests: 0,
  pullRequests: [],
  worktreePath: null,
  ...overrides,
});
export const failedRun = idleRun({ latestRunStatus: "failed" });

export const pullRequest = (number: number, merged: boolean, updatedAt: string | null = EPOCH) => ({
  host: "github.com",
  repository: "acme/app",
  number,
  merged,
  state: merged ? ("merged" as const) : ("open" as const),
  updatedAt,
});

/**
 * An active manager whose lead on ticket 1 runs in thread lead-1, with the log mark and message
 * count after setup.
 */
export const startedAssignment = (factory: Factory, tickets: ReadonlyArray<number> = [1]) =>
  Effect.gen(function* () {
    factory.boards.push(board(tickets.map((number) => ({ number, columnId: READY }))));
    const manager = yield* activeManager(factory);
    const assignment = (yield* startTicket(factory, manager.threadId!))!;
    return { ...(yield* setupDone(factory, manager)), assignment, lead: ThreadId.make("lead-1") };
  });

export const wakeReasons = (service: Service, managerId: string, mark: number) =>
  logSince(service, managerId, mark).pipe(
    Effect.map((entries) =>
      entries.filter((entry) => entry.kind === "wake").map((entry) => entry.reason),
    ),
  );

/** A Duo preset: one implementer on two models, and one reviewer on the role's model. */
export const DUO = {
  id: "preset-duo",
  name: "Duo",
  useWhen: "Small changes worth a second look.",
  members: [
    { role: "implementer" as const, count: 1, models: [SONNET, OPUS] },
    { role: "reviewer" as const, count: 1 },
  ],
  workflow: "Implement, then review before the pull request.",
  createdBy: "user" as const,
};

export const TEAM_FACTORY = decodeConfig({
  concurrencyCap: 2,
  modelPool: [OPUS, SONNET],
  roleModels: { manager: OPUS, lead: { small: SONNET }, workers: { reviewer: [SONNET] } },
  teamPresets: [DUO],
});

/** The Duo preset as a factory team: the lead runs Sonnet, and members delegate by name. */
export const DUO_TEAM: FactoryTeamDefinition = {
  id: "duo",
  name: "Duo",
  useWhen: DUO.useWhen,
  workflow: DUO.workflow,
  mayEditProtectedPaths: false,
  createdBy: "user",
  lead: SONNET_LEAD,
  members: [
    {
      id: "implementer",
      name: "Implementer",
      count: 1,
      models: { dynamic: true, models: [refOf(SONNET), refOf(OPUS)] },
      description: "Implements the change.",
    },
    {
      id: "reviewer",
      name: "Reviewer",
      count: 1,
      models: { dynamic: false, models: [refOf(SONNET)] },
      description: "Reviews the pull request.",
    },
  ],
};

export const makeTeamFactory = makeHarness({
  config: TEAM_FACTORY,
  definitions: { teams: [DUO_TEAM] },
});

/**
 * An active manager whose Duo team works ticket 1 from lead thread lead-1, with the log mark and
 * message count after setup.
 */
export const startedTeam = (factory: Factory) =>
  Effect.gen(function* () {
    factory.boards.push(board([{ number: 1, columnId: READY }]));
    const manager = yield* activeManager(factory);
    const assignment = (yield* factory.service.pickup(manager.threadId!, {
      ...START,
      issueNumber: 1,
      team: { preset: "Duo", members: [] },
    }))!;
    return { ...(yield* setupDone(factory, manager)), assignment, lead: ThreadId.make("lead-1") };
  });

export const workspace = (service: Service) =>
  service.subscribeWorkspace({}).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((feeds) => feeds[0]!),
  );

export const VERDICT = { fit: "good", reason: "The team fit the work." } as const;

/** A team whose lead picks its model, with a builder on a menu and a checker on a priority list. */
const WEB_TEAM: FactoryTeamDefinition = {
  id: "web",
  name: "Web",
  useWhen: "Web client work.",
  workflow: "Build, then check.",
  mayEditProtectedPaths: false,
  createdBy: "user",
  lead: {
    id: "picker",
    name: "Picker lead",
    models: { dynamic: true, models: [refOf(SONNET), refOf(OPUS)] },
    instructions: "",
  },
  members: [
    {
      id: "builder",
      name: "Builder",
      count: 1,
      models: { dynamic: true, models: [refOf(SONNET), refOf(OPUS)] },
      description: "Builds until: {{completionCondition}}",
    },
    {
      id: "checker",
      name: "Checker",
      count: 2,
      // GPT is not in the pool, so the checker runs Opus.
      models: { dynamic: false, models: [refOf(GPT), refOf(OPUS)] },
      description: "Checks the build.",
    },
  ],
};

export const makeStaffingFactory = (concurrencyCap = 3) =>
  makeHarness({
    config: decodeConfig({ concurrencyCap, modelPool: [OPUS, SONNET] }),
    definitions: { teams: [STANDARD_TEAM, WEB_TEAM] },
  });

export const pickupRefusal = (
  factory: Factory,
  threadId: ThreadId,
  input: Partial<FactoryPickupInput>,
) =>
  factory.service.pickup(threadId, { ...START, issueNumber: 1, ...input }).pipe(
    Effect.flip,
    Effect.map((failure) => failure.message),
  );
