import { SATELLITE_WS_METHODS, WsSatelliteRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { FactoryDefinitionsEditor } from "../factory/config/definitionsEditor.ts";
import { FactoryTeamUses } from "../factory/config/teamUses.ts";
import { FactoryConfigTransfer } from "../factory/config/exportImport.ts";
import { FactoryConfigRepo } from "../factory/config/FactoryConfigRepo.ts";
import { FactoryConfigStore } from "../factory/config/FactoryConfigStore.ts";
import { FactoryService } from "../factory/FactoryService.ts";
import { IssueService } from "../issues/IssueService.ts";

const layer = (_session: EnvironmentAuth.AuthenticatedSession) =>
  WsSatelliteRpcGroup.toLayer(
    Effect.gen(function* () {
      const issues = yield* IssueService;
      const factory = yield* FactoryService;
      const configStore = yield* FactoryConfigStore;
      const configRepo = yield* FactoryConfigRepo;
      const configTransfer = yield* FactoryConfigTransfer;
      const definitionsEditor = yield* FactoryDefinitionsEditor;
      const teamUses = yield* FactoryTeamUses;
      return WsSatelliteRpcGroup.of({
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
        [SATELLITE_WS_METHODS.factoryConfigGet]: (input) => factory.getConfig(input),
        [SATELLITE_WS_METHODS.factoryConfigUpdate]: (input) => factory.updateConfig(input),
        [SATELLITE_WS_METHODS.factoryManagersList]: (input) => factory.listManagers(input),
        [SATELLITE_WS_METHODS.factoryManagersSubscribe]: (input) =>
          factory.subscribeManagers(input),
        [SATELLITE_WS_METHODS.factoryManagersCreate]: (input) => factory.createManager(input),
        [SATELLITE_WS_METHODS.factoryManagersPause]: (input) => factory.pauseManager(input),
        [SATELLITE_WS_METHODS.factoryManagersResume]: (input) => factory.resumeManager(input),
        [SATELLITE_WS_METHODS.factoryManagersRetire]: (input) => factory.retireManager(input),
        [SATELLITE_WS_METHODS.factoryManagersApproveOnboarding]: (input) =>
          factory.approveOnboarding(input),
        [SATELLITE_WS_METHODS.factoryManagersStartPickup]: (input) => factory.startPickup(input),
        [SATELLITE_WS_METHODS.factoryManagersUpdateSettings]: (input) =>
          factory.updateSettings(input),
        [SATELLITE_WS_METHODS.factoryAssignmentsList]: (input) => factory.listAssignments(input),
        [SATELLITE_WS_METHODS.factoryAssignmentsSubscribe]: (input) =>
          factory.subscribeAssignments(input),
        [SATELLITE_WS_METHODS.factoryAssignmentsCancel]: (input) => factory.cancel(input),
        [SATELLITE_WS_METHODS.factoryAssignmentsAnswerProtectedPaths]: (input) =>
          factory.answerProtectedPaths(input),
        [SATELLITE_WS_METHODS.factoryThreadsTakeOver]: (input) => factory.takeOver(input),
        [SATELLITE_WS_METHODS.factoryThreadsHandBack]: (input) => factory.handBack(input),
        [SATELLITE_WS_METHODS.factoryLogList]: (input) => factory.listLog(input),
        [SATELLITE_WS_METHODS.factoryWorkspaceSubscribe]: (input) =>
          factory.subscribeWorkspace(input),
        [SATELLITE_WS_METHODS.factoryFindingsList]: (input) => factory.listFindings(input),
        [SATELLITE_WS_METHODS.factoryDraftsList]: (input) => factory.listDrafts(input),
        [SATELLITE_WS_METHODS.factoryDraftsSubscribe]: (input) => factory.subscribeDrafts(input),
        [SATELLITE_WS_METHODS.factoryDraftsEdit]: (input) => factory.editDraft(input),
        [SATELLITE_WS_METHODS.factoryDraftsApprove]: (input) => factory.approveDraft(input),
        [SATELLITE_WS_METHODS.factoryDraftsDismiss]: (input) => factory.dismissDraft(input),
        [SATELLITE_WS_METHODS.factoryDraftsRestore]: (input) => factory.restoreDraft(input),
        [SATELLITE_WS_METHODS.factoryStatsGet]: (input) => factory.getStats(input),
        [SATELLITE_WS_METHODS.factoryDraftsApply]: (input) => factory.applyDraft(input),
        [SATELLITE_WS_METHODS.factoryDefinitionsGet]: () => configStore.read,
        [SATELLITE_WS_METHODS.factoryConfigRepoStatus]: () => configRepo.status,
        [SATELLITE_WS_METHODS.factoryConfigRepoConnect]: (input) => configRepo.connect(input),
        [SATELLITE_WS_METHODS.factoryConfigRepoCheck]: () => configRepo.check,
        [SATELLITE_WS_METHODS.factoryConfigRepoPush]: (input) => configRepo.push(input.message),
        [SATELLITE_WS_METHODS.factoryConfigRepoPull]: () => configRepo.pull,
        [SATELLITE_WS_METHODS.factoryConfigRepoResolve]: (input) =>
          configRepo.resolve(input.path, input.side),
        [SATELLITE_WS_METHODS.factoryConfigRepoDiscard]: () => configRepo.discard,
        [SATELLITE_WS_METHODS.factoryConfigRepoDisconnect]: (input) => configRepo.disconnect(input),
        [SATELLITE_WS_METHODS.factoryConfigExport]: (input) => configTransfer.export(input),
        [SATELLITE_WS_METHODS.factoryConfigImportPreview]: (input) => configTransfer.preview(input),
        [SATELLITE_WS_METHODS.factoryConfigImportApply]: (input) =>
          configTransfer.apply(input.bundle, input.decision),
        [SATELLITE_WS_METHODS.factoryDefinitionsSave]: (input) => definitionsEditor.save(input),
        [SATELLITE_WS_METHODS.factoryDefinitionsRemove]: (input) => definitionsEditor.remove(input),
        [SATELLITE_WS_METHODS.factoryDefinitionsTeamUses]: (input) => teamUses.read(input.teamId),
        [SATELLITE_WS_METHODS.factoryConfigCreateStarter]: (input) =>
          definitionsEditor.createStarter(input.modelPool),
        [SATELLITE_WS_METHODS.factoryConfigSaveSettings]: (input) =>
          definitionsEditor.saveSettings(input),
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
