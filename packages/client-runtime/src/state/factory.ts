import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * The engineering factory's commands and subscriptions. Managers, assignments, the workspace feed
 * and triage drafts are pushed; everything else is read on demand.
 */
export function createFactoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const command = <TTag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(
    label: string,
    tag: TTag,
  ) => createEnvironmentRpcCommand(runtime, { label: `factory:${label}`, tag });
  return {
    getConfig: command("config:get", WS_METHODS.factoryConfigGet),
    updateConfig: command("config:update", WS_METHODS.factoryConfigUpdate),
    listManagers: command("managers:list", WS_METHODS.factoryManagersList),
    managers: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:factory:managers",
      tag: WS_METHODS.factoryManagersSubscribe,
    }),
    createManager: command("managers:create", WS_METHODS.factoryManagersCreate),
    pauseManager: command("managers:pause", WS_METHODS.factoryManagersPause),
    resumeManager: command("managers:resume", WS_METHODS.factoryManagersResume),
    retireManager: command("managers:retire", WS_METHODS.factoryManagersRetire),
    approveOnboarding: command(
      "managers:approve-onboarding",
      WS_METHODS.factoryManagersApproveOnboarding,
    ),
    startPickup: command("managers:start-pickup", WS_METHODS.factoryManagersStartPickup),
    listAssignments: command("assignments:list", WS_METHODS.factoryAssignmentsList),
    assignments: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:factory:assignments",
      tag: WS_METHODS.factoryAssignmentsSubscribe,
    }),
    cancelAssignment: command("assignments:cancel", WS_METHODS.factoryAssignmentsCancel),
    takeOver: command("threads:take-over", WS_METHODS.factoryThreadsTakeOver),
    handBack: command("threads:hand-back", WS_METHODS.factoryThreadsHandBack),
    listLog: command("log:list", WS_METHODS.factoryLogList),
    workspace: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:factory:workspace",
      tag: WS_METHODS.factoryWorkspaceSubscribe,
    }),
    listFindings: command("findings:list", WS_METHODS.factoryFindingsList),
    listDrafts: command("drafts:list", WS_METHODS.factoryDraftsList),
    drafts: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:factory:drafts",
      tag: WS_METHODS.factoryDraftsSubscribe,
    }),
    editDraft: command("drafts:edit", WS_METHODS.factoryDraftsEdit),
    approveDraft: command("drafts:approve", WS_METHODS.factoryDraftsApprove),
    dismissDraft: command("drafts:dismiss", WS_METHODS.factoryDraftsDismiss),
    restoreDraft: command("drafts:restore", WS_METHODS.factoryDraftsRestore),
    applyDraft: command("drafts:apply", WS_METHODS.factoryDraftsApply),
    getStats: command("stats:get", WS_METHODS.factoryStatsGet),
    getDefinitions: command("definitions:get", WS_METHODS.factoryDefinitionsGet),
    configRepoStatus: command("config-repo:status", WS_METHODS.factoryConfigRepoStatus),
    connectConfigRepo: command("config-repo:connect", WS_METHODS.factoryConfigRepoConnect),
    checkConfigRepo: command("config-repo:check", WS_METHODS.factoryConfigRepoCheck),
    pushConfigRepo: command("config-repo:push", WS_METHODS.factoryConfigRepoPush),
    pullConfigRepo: command("config-repo:pull", WS_METHODS.factoryConfigRepoPull),
    resolveConfigRepo: command("config-repo:resolve", WS_METHODS.factoryConfigRepoResolve),
    discardConfigRepo: command("config-repo:discard", WS_METHODS.factoryConfigRepoDiscard),
    disconnectConfigRepo: command("config-repo:disconnect", WS_METHODS.factoryConfigRepoDisconnect),
    exportConfig: command("config:export", WS_METHODS.factoryConfigExport),
    previewConfigImport: command("config:import-preview", WS_METHODS.factoryConfigImportPreview),
    applyConfigImport: command("config:import-apply", WS_METHODS.factoryConfigImportApply),
    saveDefinition: command("definitions:save", WS_METHODS.factoryDefinitionsSave),
    removeDefinition: command("definitions:remove", WS_METHODS.factoryDefinitionsRemove),
    teamUses: command("definitions:team-uses", WS_METHODS.factoryDefinitionsTeamUses),
    saveFactorySettings: command("config:save-settings", WS_METHODS.factoryConfigSaveSettings),
    createFactoryStarter: command("config:create-starter", WS_METHODS.factoryConfigCreateStarter),
  };
}
