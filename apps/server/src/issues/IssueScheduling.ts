import { sha256 } from "@noble/hashes/sha2";
import {
  FactorySchedulingAdmission,
  IssueBoardSummary,
  IssueBoardMapping,
  IssueBoardLocator,
  IssueOperationError,
  issueReadyColumnIds,
  type FactoryScheduleAuthority,
  type FactoryScheduleCandidate,
  type FactoryScheduleObservation,
  type FactorySchedulingConfiguration,
  type IssueDetail,
  type IssueAttemptLink,
  type IssueRef,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  detectSourceControlProviderFromRemoteUrl,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import * as IssueHost from "./IssueHost.ts";
import * as IssueService from "./IssueService.ts";

type BoardInput = { readonly projectId: ProjectId; readonly boardId: string };
type Authorize = Effect.Effect<FactoryScheduleAuthority, IssueOperationError>;

export class IssueScheduling extends Context.Service<
  IssueScheduling,
  {
    readonly qualify: (input: BoardInput) => Effect.Effect<void, IssueOperationError>;
    readonly observe: (
      input: BoardInput & { readonly includeIssues?: ReadonlyArray<IssueRef> },
    ) => Effect.Effect<
      {
        readonly board: IssueBoardSummary;
        readonly revision: number;
        readonly items: ReadonlyArray<{
          readonly issue: IssueRef;
          readonly observation: FactoryScheduleObservation;
        }>;
      },
      IssueOperationError
    >;
    readonly read: (input: {
      readonly candidate: FactoryScheduleCandidate;
    }) => Effect.Effect<
      { readonly detail: IssueDetail; readonly detailDigest: string },
      IssueOperationError
    >;
    readonly admit: (input: {
      readonly candidate: FactoryScheduleCandidate;
      readonly configuration: FactorySchedulingConfiguration;
      readonly workDigest: string;
      readonly authorize: Authorize;
    }) => Effect.Effect<FactorySchedulingAdmission, IssueOperationError>;
    readonly revalidate: (input: {
      readonly admission: FactorySchedulingAdmission;
      readonly authorize: Authorize;
      readonly attach?: {
        readonly projectId: ProjectId;
        readonly threadId: ThreadId;
        readonly worktreePath: string;
      };
    }) => Effect.Effect<void, IssueOperationError>;
    readonly reservation: (
      candidateId: string,
    ) => Effect.Effect<FactorySchedulingAdmission | undefined, IssueOperationError>;
    /** SQL-only admission check; call inside the assignment commit transaction. */
    readonly fence: (
      admission: FactorySchedulingAdmission,
    ) => Effect.Effect<boolean, IssueOperationError>;
    readonly release: (input: {
      readonly candidateId: string;
      readonly authorizeUnstarted?: Effect.Effect<void, IssueOperationError>;
      readonly authorizeCompleted?: Effect.Effect<void, IssueOperationError>;
    }) => Effect.Effect<void, IssueOperationError>;
  }
>()("t3/issues/IssueScheduling") {}

const digest = (value: unknown) =>
  Hex.encode(sha256(new TextEncoder().encode(stableStringify(value))));
const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (message: string, reason: IssueOperationError["reason"] = "conflict") =>
  new IssueOperationError({ reason, message });
const isIssueError = Schema.is(IssueOperationError);
const preserveError = (cause: unknown) =>
  isIssueError(cause)
    ? cause
    : failure("Could not read or save the scheduling reservation.", "storage");
const decodeAdmission = Schema.decodeEffect(Schema.fromJsonString(FactorySchedulingAdmission));
const encodeAdmission = Schema.encodeSync(Schema.fromJsonString(FactorySchedulingAdmission));
const decodeMapping = Schema.decodeEffect(Schema.fromJsonString(Schema.NullOr(IssueBoardMapping)));
const decodeLocator = Schema.decodeEffect(Schema.fromJsonString(IssueBoardLocator));
const detailDigest = (detail: IssueDetail) =>
  digest({
    key: IssueHost.canonicalIssueKey(detail.ref),
    title: detail.title,
    body: detail.body,
    labels: [...detail.labels].sort(),
  });

const storedFence = Effect.fnUntraced(function* (boardId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    project_id: string;
    locator_json: string;
    mapping_json: string;
    content_hash: string | null;
    revision: number | null;
  }>`
    SELECT b.project_id,b.locator_json,b.mapping_json,s.content_hash,s.revision
    FROM issue_boards b LEFT JOIN issue_board_snapshots s ON s.board_id=b.id WHERE b.id=${boardId}`;
  return rows.length ? digest(rows[0]) : undefined;
});

/** Uses the caller's SQLite transaction; no provider service is constructed or contacted. */
export const checkIssueSchedulingFence = Effect.fn("IssueScheduling.checkFence")(function* (
  admission: FactorySchedulingAdmission,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    admission_json: string;
  }>`SELECT admission_json FROM issue_schedule_reservations
    WHERE candidate_id=${admission.candidateId} AND attempt_id=${admission.issueAttempt.attemptId} AND status <> 'released'`;
  return (
    rows[0]?.admission_json === encodeAdmission(admission) &&
    (yield* storedFence(admission.boardId)) === admission.boardFence
  );
}, Effect.mapError(preserveError));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const host = yield* IssueHost.IssueHost;
  const issues = yield* IssueService.IssueService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver;
  const environment = yield* ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const cachedDetails = new Map<
    string,
    { readonly version: string; readonly detail: IssueDetail }
  >();
  const ownScope = Effect.fnUntraced(function* (projectId: ProjectId) {
    const project = yield* projects.get(projectId).pipe(Effect.mapError(preserveError));
    if (Option.isNone(project))
      return yield* failure("The scheduling project is unavailable.", "not-found");
    const identity = yield* identities.resolve(project.value.workspaceRoot, { refresh: true });
    if (!identity || (identity.provider !== "github" && identity.provider !== "azure-devops"))
      return yield* failure(
        "Managed issue scheduling requires a GitHub Project or Azure board.",
        "unavailable",
      );
    const repository =
      identity.provider === "azure-devops"
        ? identity.displayName?.split("/_git/")[0]
        : sourceControlRepositorySelector(identity);
    const detected = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
    const hostName =
      identity.provider === "azure-devops"
        ? "dev.azure.com"
        : detected
          ? new URL(detected.baseUrl).host
          : undefined;
    if (!repository || !hostName)
      return yield* failure("The project's repository identity is unavailable.", "unavailable");
    return {
      cwd: project.value.workspaceRoot,
      kind: identity.provider,
      repository,
      host: hostName,
    };
  });
  const ownIssue = (scope: Effect.Success<ReturnType<typeof ownScope>>, issue: IssueRef) =>
    issue.hostKind === scope.kind &&
    issue.host.toLowerCase() === scope.host.toLowerCase() &&
    issue.repository.toLowerCase() === scope.repository.toLowerCase();
  const board = Effect.fnUntraced(function* (input: BoardInput) {
    const boards = yield* issues.listBoards({ projectId: input.projectId, connectedOnly: true });
    const saved = boards.find((entry) => entry.id === input.boardId);
    if (!saved || !saved.mapping)
      return yield* failure(
        "Connect this project's board and configure its Ready columns first.",
        "unavailable",
      );
    const scope = yield* ownScope(input.projectId);
    if (
      saved.locator.host.toLowerCase() !== scope.host.toLowerCase() ||
      (scope.kind === "github") !== (saved.locator.kind === "github-project") ||
      (saved.locator.kind === "azure-board" &&
        `${saved.locator.organization}/${saved.locator.project}`.toLowerCase() !==
          scope.repository.toLowerCase())
    )
      return yield* failure(
        "The configured board does not belong to this project's repository host.",
        "invalid",
      );
    const remote = yield* host.board(scope.cwd, saved.locator);
    if (
      issueReadyColumnIds(saved.mapping).some(
        (id) => !remote.columns.some((column) => column.id === id),
      )
    )
      return yield* failure(
        "A configured Ready column no longer exists. Update the board mapping.",
      );
    return { saved, scope, remote };
  });
  const readIssue = Effect.fnUntraced(function* (projectId: ProjectId, issue: IssueRef) {
    const scope = yield* ownScope(projectId);
    if (!ownIssue(scope, issue))
      return yield* failure("This ticket belongs to another project's repository.", "invalid");
    const detail = yield* host.get({ cwd: scope.cwd, ref: issue });
    if (
      !ownIssue(scope, detail.ref) ||
      IssueHost.canonicalIssueKey(detail.ref) !== IssueHost.canonicalIssueKey(issue)
    )
      return yield* failure("The host returned a different ticket.", "invalid");
    return { detail, detailDigest: detailDigest(detail) };
  });
  const reservation = Effect.fn("IssueScheduling.reservation")(function* (candidateId: string) {
    const rows = yield* sql<{
      admission_json: string;
    }>`SELECT admission_json FROM issue_schedule_reservations WHERE candidate_id=${candidateId}`;
    return rows[0] ? yield* decodeAdmission(rows[0].admission_json) : undefined;
  }, Effect.mapError(preserveError));
  const checkAuthority = (
    authority: FactoryScheduleAuthority,
    candidate: Pick<FactoryScheduleCandidate, "source">,
    boardId: string,
    itemId: string,
  ) => {
    if (authority.kind === "tracker-ready")
      return authority.boardId === boardId && authority.itemId === itemId;
    return (
      candidate.source.kind === "project-improvement" &&
      authority.kind === "project-improvement" &&
      authority.followupId === candidate.source.followupId
    );
  };
  const assertManualFree = Effect.fnUntraced(function* (key: string, attemptId: string) {
    // Reservations are intentionally not expired by time: the creator may still be launching.
    // Completed PR-backed attempts are historical; pending/attached attempts need explicit resolution.
    const competing = yield* sql<{ id: string }>`SELECT a.id FROM issue_attempts a
      LEFT JOIN issue_schedule_reservations r ON r.attempt_id=a.id
      WHERE a.issue_key=${key} AND a.id<>${attemptId} AND a.status IN ('reserved','attached','started')
      AND (r.candidate_id IS NULL OR r.status <> 'released')
      AND (a.status <> 'started' OR NOT EXISTS (
        SELECT 1 FROM issue_pr_observations p WHERE p.attempt_id=a.id AND p.state='merged'
      ) OR EXISTS (SELECT 1 FROM issue_pr_observations p WHERE p.attempt_id=a.id AND p.state<>'merged'))`;
    if (competing.length)
      return yield* failure(
        "This ticket already has another reserved or running attempt. Resolve that work before scheduling it.",
      );
  });
  const observe: IssueScheduling["Service"]["observe"] = Effect.fn("IssueScheduling.observe")(
    function* (input) {
      const current = yield* board(input);
      const stored = yield* issues.openBoard(input);
      const included = new Set(input.includeIssues?.map(IssueHost.canonicalIssueKey) ?? []);
      const items = [];
      const observedAt = yield* timestamp;
      for (const item of current.remote.items) {
        if (!ownIssue(current.scope, item.issue.ref)) continue;
        const ready =
          item.columnId !== null &&
          issueReadyColumnIds(current.saved.mapping!).includes(item.columnId);
        const key = IssueHost.canonicalIssueKey(item.issue.ref);
        if (!ready && !included.has(key)) continue;
        const version = digest(item.issue);
        const cached = cachedDetails.get(key);
        const detail =
          cached?.version === version
            ? cached.detail
            : (yield* readIssue(input.projectId, item.issue.ref)).detail;
        if (cachedDetails.size > 500) cachedDetails.clear();
        cachedDetails.set(key, { version, detail });
        items.push({
          issue: detail.ref,
          observation: {
            boardRevision: stored.sync?.revision ?? 0,
            itemId: item.itemId,
            columnId: item.columnId,
            title: detail.title,
            ready,
            detailDigest: detailDigest(detail),
            observedAt,
          },
        });
      }
      return { board: current.saved, revision: stored.sync?.revision ?? 0, items };
    },
  );
  const admit: IssueScheduling["Service"]["admit"] = Effect.fn("IssueScheduling.admit")(function* (
    input,
  ) {
    const { candidate, configuration } = input;
    if (
      !configuration.enabled ||
      candidate.configurationId !== configuration.id ||
      candidate.projectId !== configuration.projectId
    )
      return yield* failure("The scheduling configuration changed or was disabled.");
    const current = yield* board({
      projectId: candidate.projectId,
      boardId: configuration.boardId,
    });
    const key = IssueHost.canonicalIssueKey(candidate.issue);
    if (candidate.canonicalIssueKey !== key || !ownIssue(current.scope, candidate.issue))
      return yield* failure("The scheduling candidate belongs to another repository.", "invalid");
    const item = current.remote.items.find(
      (entry) => IssueHost.canonicalIssueKey(entry.issue.ref) === key,
    );
    if (!item) return yield* failure("The ticket is no longer on the configured board.");
    const fresh = yield* readIssue(candidate.projectId, candidate.issue);
    if (fresh.detailDigest !== candidate.observation.detailDigest)
      return yield* failure(
        "The ticket changed. Refresh and prepare its current scope before commissioning.",
      );
    const authority = yield* input.authorize;
    if (!checkAuthority(authority, candidate, configuration.boardId, item.itemId))
      return yield* failure("The current authorization does not match this candidate.", "invalid");
    if (
      authority.kind === "tracker-ready" &&
      (!item.columnId || !issueReadyColumnIds(current.saved.mapping!).includes(item.columnId))
    )
      return yield* failure("The ticket is no longer Ready for implementation.");
    const requestId = `factory-schedule:${candidate.id}:${candidate.generation}`;
    let admission: FactorySchedulingAdmission | undefined;
    yield* issues
      .reserveAttempt({
        requestId,
        boardId: configuration.boardId,
        issue: fresh.detail.ref,
        sourceEnvironmentId: environmentId,
        destinationEnvironmentId: environmentId,
      })
      .pipe(
        Effect.provideService(IssueService.ScheduledIssueReservation, {
          requestId,
          allowUnready: authority.kind === "project-improvement",
          reserve: Effect.fnUntraced(function* (link: IssueAttemptLink) {
            const latest = yield* input.authorize;
            if (stableStringify(latest) !== stableStringify(authority))
              return yield* failure(
                "The scheduling authorization changed while reserving this ticket.",
              );
            yield* assertManualFree(key, link.attemptId);
            const boards = yield* sql<{
              mapping_json: string;
              locator_json: string;
            }>`SELECT mapping_json,locator_json FROM issue_boards WHERE id=${configuration.boardId}`;
            if (
              !boards[0] ||
              stableStringify(yield* decodeMapping(boards[0].mapping_json)) !==
                stableStringify(current.saved.mapping) ||
              stableStringify(yield* decodeLocator(boards[0].locator_json)) !==
                stableStringify(current.saved.locator)
            )
              return yield* failure("The board configuration changed during scheduling admission.");
            const claims = yield* sql<{
              candidate_id: string;
              generation: number;
              attempt_id: string;
              status: string;
            }>`SELECT candidate_id,generation,attempt_id,status
            FROM issue_schedule_reservations WHERE (issue_key=${key} AND status <> 'released') OR candidate_id=${candidate.id}`;
            if (
              claims.some(
                (claim) =>
                  claim.candidate_id !== candidate.id ||
                  claim.generation !== candidate.generation ||
                  claim.attempt_id !== link.attemptId,
              )
            )
              return yield* failure(
                "This ticket already belongs to another scheduling generation.",
              );
            const boardFence = yield* storedFence(configuration.boardId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            if (!boardFence) return yield* failure("The board was disconnected during admission.");
            admission = {
              candidateId: candidate.id,
              configurationId: configuration.id,
              canonicalIssueKey: key,
              workDigest: input.workDigest,
              detailDigest: fresh.detailDigest,
              boardId: configuration.boardId,
              boardFence,
              authority,
              issueAttempt: link,
            };
            yield* sql`INSERT INTO issue_schedule_reservations(candidate_id,generation,issue_key,request_id,attempt_id,board_id,status,admission_json)
            VALUES(${candidate.id},${candidate.generation},${key},${requestId},${link.attemptId},${configuration.boardId},'reserved',${encodeAdmission(admission)})
            ON CONFLICT(candidate_id) DO UPDATE SET status=CASE WHEN issue_schedule_reservations.status='attached' THEN 'attached' ELSE 'reserved' END,admission_json=excluded.admission_json`;
          }, Effect.mapError(preserveError)),
        }),
      );
    if (!admission)
      return yield* failure("The host did not record scheduling admission.", "storage");
    return admission;
  }, Effect.mapError(preserveError));
  const fence: IssueScheduling["Service"]["fence"] = (admission) =>
    checkIssueSchedulingFence(admission).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const revalidate: IssueScheduling["Service"]["revalidate"] = Effect.fn(
    "IssueScheduling.revalidate",
  )(function* ({ admission, authorize, attach }) {
    if (attach && attach.projectId !== admission.issueAttempt.sourceProjectId)
      return yield* failure("The scheduled attachment belongs to another project.", "invalid");
    const rows = yield* sql<{
      status: string;
    }>`SELECT status FROM issue_schedule_reservations WHERE candidate_id=${admission.candidateId} AND attempt_id=${admission.issueAttempt.attemptId}`;
    if (!rows[0] || rows[0].status === "released")
      return yield* failure("This scheduling reservation is no longer active.");
    const expectedFence = yield* storedFence(admission.boardId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (!expectedFence) return yield* failure("The board is no longer connected.");
    const current = yield* board({
      projectId: admission.issueAttempt.sourceProjectId,
      boardId: admission.boardId,
    });
    const item = current.remote.items.find(
      (entry) => IssueHost.canonicalIssueKey(entry.issue.ref) === admission.canonicalIssueKey,
    );
    const authority = yield* authorize;
    if (authority.kind !== admission.authority.kind)
      return yield* failure(
        "The assignment's original scheduling authority cannot be replaced during launch.",
      );
    if (
      !item ||
      !checkAuthority(
        authority,
        {
          source:
            admission.authority.kind === "tracker-ready"
              ? { kind: "tracker-ready" }
              : { kind: "project-improvement", followupId: admission.authority.followupId },
        },
        admission.boardId,
        item.itemId,
      )
    )
      return yield* failure("The selected ticket or its authorization is no longer available.");
    if (
      authority.kind === "tracker-ready" &&
      (!item.columnId || !issueReadyColumnIds(current.saved.mapping!).includes(item.columnId))
    )
      return yield* failure("The ticket is no longer Ready for implementation.");
    if (
      authority.kind === "project-improvement" &&
      admission.authority.kind === "project-improvement" &&
      authority.ruleId !== admission.authority.ruleId
    )
      return yield* failure("The approved project improvement rule changed.");
    const fresh = yield* readIssue(
      admission.issueAttempt.sourceProjectId,
      admission.issueAttempt.issue,
    );
    if (fresh.detailDigest !== admission.detailDigest)
      return yield* failure("The ticket changed after its scope was prepared.");
    const check = Effect.gen(function* () {
      const claims = yield* sql<{
        admission_json: string;
      }>`SELECT admission_json FROM issue_schedule_reservations
        WHERE candidate_id=${admission.candidateId} AND attempt_id=${admission.issueAttempt.attemptId} AND status <> 'released'`;
      if (
        claims[0]?.admission_json !== encodeAdmission(admission) ||
        (yield* storedFence(admission.boardId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        )) !== expectedFence
      )
        return yield* failure(
          "The board mapping, observed placement or scheduling reservation changed during launch admission.",
        );
      const latestAuthority = yield* authorize;
      if (stableStringify(latestAuthority) !== stableStringify(authority))
        return yield* failure("The scheduling authority changed during launch admission.");
    }).pipe(Effect.mapError(preserveError));
    if (attach) {
      yield* issues.attachAttempt({ ...attach, link: admission.issueAttempt }).pipe(
        Effect.provideService(IssueService.ScheduledIssueAttachment, {
          attemptId: admission.issueAttempt.attemptId,
          check,
        }),
      );
    } else yield* sql.withTransaction(check);
  }, Effect.mapError(preserveError));
  return IssueScheduling.of({
    qualify: Effect.fn("IssueScheduling.qualify")(function* (input) {
      yield* board(input);
    }),
    observe,
    read: Effect.fn("IssueScheduling.read")(function* ({ candidate }) {
      return yield* readIssue(candidate.projectId, candidate.issue);
    }),
    admit,
    revalidate,
    reservation,
    fence,
    release: Effect.fn("IssueScheduling.release")(function* ({
      candidateId,
      authorizeUnstarted,
      authorizeCompleted,
    }) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            status: string;
            attempt_id: string;
            thread_id: string | null;
            started_at: string | null;
          }>`
          SELECT r.status,r.attempt_id,a.thread_id,a.started_at FROM issue_schedule_reservations r
          JOIN issue_attempts a ON a.id=r.attempt_id WHERE r.candidate_id=${candidateId}`;
          const row = rows[0];
          if (!row || row.status === "released") return;
          if (row.status === "attached" || row.thread_id !== null || row.started_at !== null) {
            if (!authorizeCompleted)
              return yield* failure(
                "An attached or started assignment needs verified conclusion and explicit reopening before releasing its reservation.",
              );
            yield* authorizeCompleted;
          } else if (authorizeUnstarted) yield* authorizeUnstarted;
          yield* sql`UPDATE issue_schedule_reservations SET status='released' WHERE candidate_id=${candidateId}`;
        }),
      );
    }, Effect.mapError(preserveError)),
  });
});

export const layer = Layer.effect(IssueScheduling, make);
