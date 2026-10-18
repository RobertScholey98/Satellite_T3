import { SATELLITE_WS_METHODS, WsSatelliteRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as OpenWork from "../openWork/OpenWork.ts";
import * as RevdocService from "../revdoc/RevdocService.ts";
import { IssueService } from "../issues/IssueService.ts";

const layer = (_session: EnvironmentAuth.AuthenticatedSession) =>
  WsSatelliteRpcGroup.toLayer(
    Effect.gen(function* () {
      const openWork = yield* OpenWork.OpenWork;
      const revdoc = yield* RevdocService.RevdocService;
      const issues = yield* IssueService;
      return WsSatelliteRpcGroup.of({
        [SATELLITE_WS_METHODS.openWorkList]: (input) => openWork.list(input),
        [SATELLITE_WS_METHODS.openWorkTimeline]: (input) => openWork.timeline(input),
        [SATELLITE_WS_METHODS.openWorkDiff]: (input) => openWork.diff(input),
        [SATELLITE_WS_METHODS.openWorkCommitFiles]: (input) => openWork.commitFiles(input),
        [SATELLITE_WS_METHODS.revdocWorktrees]: (input) => revdoc.worktrees(input),
        [SATELLITE_WS_METHODS.revdocSubscribe]: (input) => revdoc.subscribe(input),
        [SATELLITE_WS_METHODS.revdocGetItems]: (input) => revdoc.getItems(input),
        [SATELLITE_WS_METHODS.revdocGenerate]: (input) => revdoc.generate(input),
        [SATELLITE_WS_METHODS.revdocTest]: (input) => revdoc.test(input),
        [SATELLITE_WS_METHODS.revdocCancel]: (input) => revdoc.cancel(input).pipe(Effect.as({})),
        [SATELLITE_WS_METHODS.revdocRefresh]: (input) => revdoc.refresh(input).pipe(Effect.as({})),
        [SATELLITE_WS_METHODS.revdocEditItem]: (input) => revdoc.editItem(input),
        [SATELLITE_WS_METHODS.revdocDelete]: (input) =>
          revdoc.deleteReview(input).pipe(Effect.as({})),
        [SATELLITE_WS_METHODS.issuesList]: (input) => issues.list(input),
        [SATELLITE_WS_METHODS.issuesGet]: (input) => issues.get(input),
        [SATELLITE_WS_METHODS.issuesBoardsList]: (input) => issues.listBoards(input),
        [SATELLITE_WS_METHODS.issuesBoardsOpen]: (input) => issues.openBoard(input),
        [SATELLITE_WS_METHODS.issuesBoardsSubscribe]: (input) => issues.subscribeBoard(input),
        [SATELLITE_WS_METHODS.issuesBoardsConfigure]: (input) => issues.configureBoard(input),
        [SATELLITE_WS_METHODS.issuesBoardsDisconnect]: (input) => issues.disconnectBoard(input),
        [SATELLITE_WS_METHODS.issuesBoardsMove]: (input) => issues.move(input),
        [SATELLITE_WS_METHODS.issuesMovesRetry]: (input) => issues.retryMove(input),
        [SATELLITE_WS_METHODS.issuesAttemptsList]: (input) => issues.listAttempts(input),
        [SATELLITE_WS_METHODS.issuesAttemptsStart]: (input) => issues.startAttempt(input),
        [SATELLITE_WS_METHODS.issuesAttemptsEnd]: (input) => issues.endAttempt(input),
        [SATELLITE_WS_METHODS.issuesAttemptsResume]: (input) => issues.resumeAttempt(input),
      });
    }),
  );

/** Server-lifetime services Satellite handlers use, inferred from the handler table. */
type SatelliteWsRpcServices = Layer.Services<ReturnType<typeof layer>>;

/**
 * Captures Satellite's handler services once and returns each connection's handler layer.
 * `ws.ts` merges it beside upstream's handlers.
 */
export const makeConnectionLayer = Effect.map(
  Effect.context<SatelliteWsRpcServices>(),
  (services) => (session: EnvironmentAuth.AuthenticatedSession) =>
    layer(session).pipe(Layer.provide(Layer.succeedContext(services))),
);
