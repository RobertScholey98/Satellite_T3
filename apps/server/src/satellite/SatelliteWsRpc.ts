import {
  IdeaOperationError,
  SATELLITE_WS_METHODS,
  ThreadId,
  WsSatelliteRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { DocumentService } from "../documents/DocumentService.ts";
import { IdeaNotebookStore } from "../ideas/IdeaNotebookStore.ts";
import { IssueDelivery } from "../issues/IssueDelivery.ts";
import { IssuePeerAccess, issuePeerSource } from "../issues/IssuePeerAccess.ts";
import { IssueService } from "../issues/IssueService.ts";
import { OpenWorkService } from "../openWork/OpenWorkService.ts";
import {
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
} from "../orchestration-v2/SatelliteOrchestration.ts";
import { RevdocService } from "../revdoc/RevdocService.ts";

const layer = (session: EnvironmentAuth.AuthenticatedSession) =>
  WsSatelliteRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = session.sessionId;
      const ideaStore = yield* IdeaNotebookStore;
      const satelliteEngine = yield* OrchestrationEngineService;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const revdoc = yield* RevdocService;
      const documents = yield* DocumentService;
      const issues = yield* IssueService;
      const delivery = yield* IssueDelivery;
      const peerAccess = yield* IssuePeerAccess;
      const peerSource = issuePeerSource(session.subject);
      const peerBinding = peerSource === undefined ? {} : { sourceEnvironmentId: peerSource };
      const openWork = yield* OpenWorkService;
      return WsSatelliteRpcGroup.of({
        [SATELLITE_WS_METHODS.ideasList]: (input) =>
          ideaStore.list(input.projectId).pipe(
            Effect.map((ideas) => ({ ideas })),
            Effect.mapError((error) => new IdeaOperationError({ message: error.message })),
          ),
        [SATELLITE_WS_METHODS.ideasGet]: (input) =>
          ideaStore.get(input.threadId).pipe(
            Effect.map((notebook) => ({ notebook })),
            Effect.mapError((error) => new IdeaOperationError({ message: error.message })),
          ),
        [SATELLITE_WS_METHODS.ideasSubscribeChanges]: () =>
          Effect.gen(function* () {
            const events = yield* satelliteEngine.subscribeDomainEvents;
            return events.pipe(
              Stream.filter(
                (event) =>
                  event.type === "idea.changed" ||
                  event.type === "idea.purged" ||
                  event.type === "thread.meta-updated" ||
                  (event.type === "thread.activity-appended" &&
                    event.payload.activity.kind === "user-input.resolved") ||
                  (event.type === "thread.session-set" && event.payload.turnSettled === true) ||
                  (event.type === "thread.message-sent" && event.payload.role === "user") ||
                  (event.type === "thread.created" && event.payload.purpose === "idea"),
              ),
              Stream.mapEffect((event) =>
                Effect.gen(function* () {
                  const threadId = ThreadId.make(event.aggregateId);
                  const notebook = yield* ideaStore.get(threadId);
                  return notebook || event.type === "idea.purged"
                    ? Option.some({
                        threadId,
                        revision: notebook?.revision ?? 0,
                        purged: event.type === "idea.purged",
                      })
                    : Option.none();
                }),
              ),
              Stream.filter(Option.isSome),
              Stream.map((change) => change.value),
              Stream.mapError((error) => new IdeaOperationError({ message: error.message })),
            );
          }).pipe(Stream.unwrap),
        [SATELLITE_WS_METHODS.orchestrationGetRequestLifecycle]: (input) =>
          projectionSnapshotQuery.getRequestLifecycle(input),
        [SATELLITE_WS_METHODS.revdocGet]: (input) => revdoc.get(input),
        [SATELLITE_WS_METHODS.revdocTestStart]: (input) => revdoc.startTesting(input),
        [SATELLITE_WS_METHODS.revdocStart]: (input) => revdoc.start(input),
        [SATELLITE_WS_METHODS.revdocCancel]: (input) => revdoc.cancel(input),
        [SATELLITE_WS_METHODS.revdocSave]: (input) => revdoc.save(input),
        [SATELLITE_WS_METHODS.revdocChanges]: (input) => revdoc.changes(input),
        [SATELLITE_WS_METHODS.revdocWorktrees]: (input) => revdoc.worktrees(input),
        [SATELLITE_WS_METHODS.documentsList]: (input) => documents.list(input),
        [SATELLITE_WS_METHODS.issuesList]: (input) => issues.list(input),
        [SATELLITE_WS_METHODS.issuesGet]: (input) => issues.get(input),
        [SATELLITE_WS_METHODS.issuesBoardsList]: (input) => issues.listBoards(input),
        [SATELLITE_WS_METHODS.issuesBoardsOpen]: (input) => issues.openBoard(input),
        [SATELLITE_WS_METHODS.issuesBoardsSubscribe]: (input) => issues.subscribeBoard(input),
        [SATELLITE_WS_METHODS.issuesBoardsConfigure]: (input) => issues.configureBoard(input),
        [SATELLITE_WS_METHODS.issuesBoardsDisconnect]: (input) => issues.disconnectBoard(input),
        [SATELLITE_WS_METHODS.issuesBoardsMove]: (input) => issues.move(input),
        [SATELLITE_WS_METHODS.issuesMovesRetry]: (input) => issues.retryMove(input),
        [SATELLITE_WS_METHODS.issuesAttemptsReserve]: (input) => issues.reserveAttempt(input),
        [SATELLITE_WS_METHODS.issuesAttemptsList]: (input) => issues.listAttempts(input),
        [SATELLITE_WS_METHODS.issuesAttemptsReceipts]: (input) =>
          issues.listReceipts({ ...input, ...peerBinding }),
        [SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations]: (input) =>
          issues.syncAttemptGenerations({ ...input, ...peerBinding }),
        [SATELLITE_WS_METHODS.issuesAttemptsAcknowledge]: (input) =>
          issues.acknowledgeReceipts({ ...input, ...peerBinding }),
        [SATELLITE_WS_METHODS.issuesPeersIdentity]: () => peerAccess.identity,
        [SATELLITE_WS_METHODS.issuesPeersGrant]: (input) => peerAccess.grant(input, session),
        [SATELLITE_WS_METHODS.issuesPeersRegister]: (input) => delivery.registerPeer(input),
        [SATELLITE_WS_METHODS.issuesPeersForget]: (input) => delivery.forgetPeer(input),
        [SATELLITE_WS_METHODS.issuesDeliveriesDeliver]: (input) => delivery.deliver(input),
        [SATELLITE_WS_METHODS.openWorkList]: (input) => openWork.list(input),
        [SATELLITE_WS_METHODS.openWorkTimeline]: (input) => openWork.timeline(input),
        [SATELLITE_WS_METHODS.openWorkLinkFolder]: (input) => openWork.linkFolder(input),
        [SATELLITE_WS_METHODS.openWorkUnlinkFolder]: (input) => openWork.unlinkFolder(input),
        [SATELLITE_WS_METHODS.openWorkAssignDocument]: (input) => openWork.assignDocument(input),
        [SATELLITE_WS_METHODS.openWorkFavoriteDocument]: (input) =>
          openWork.favoriteDocument(input),
        [SATELLITE_WS_METHODS.openWorkFavorites]: (input) => openWork.favorites(input),
        [SATELLITE_WS_METHODS.openWorkReadLinkedDocument]: (input) =>
          openWork.readLinkedDocument(input),
        [SATELLITE_WS_METHODS.documentsGet]: (input) => documents.get(input),
        [SATELLITE_WS_METHODS.documentsHistory]: (input) => documents.history(input),
        [SATELLITE_WS_METHODS.documentsPublish]: (input) =>
          documents.publish(input, `session:${currentSessionId}`),
        [SATELLITE_WS_METHODS.documentsSaveDraft]: (input) =>
          documents.saveDraft(input, `session:${currentSessionId}`),
        [SATELLITE_WS_METHODS.documentsSubmit]: (input) =>
          documents.submit(input, `session:${currentSessionId}`),
        [SATELLITE_WS_METHODS.documentsRetry]: (input) =>
          documents.retry(input, `session:${currentSessionId}`),
      });
    }),
  );

type SatelliteWsRpcServices = Layer.Services<ReturnType<typeof layer>>;

/**
 * Captures the server-lifetime services Satellite's handlers use, once, and returns the
 * per-connection handler layer, so every connection shares those services.
 */
export const makeConnectionLayer = Effect.map(
  Effect.context<SatelliteWsRpcServices>(),
  (services) => (session: EnvironmentAuth.AuthenticatedSession) =>
    layer(session).pipe(Layer.provide(Layer.succeedContext(services))),
);
