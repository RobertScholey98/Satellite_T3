import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";
import { FACTORY_WS_METHODS, FactoryDispatchInput } from "./factory.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [FACTORY_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeFactoryDispatch = Schema.decodeUnknownSync(FactoryDispatchInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === FACTORY_WS_METHODS.dispatchCommand && input !== undefined) {
    const payload = decodeFactoryDispatch(input);
    return payload.command.type === "manager.configure" ||
      payload.command.type === "policy.defaults.configure" ||
      payload.command.type === "models.defaults.configure" ||
      payload.command.type === "manager.models.configure" ||
      payload.command.type === "assignments.extend-grant" ||
      payload.command.type === "manager.approve-onboarding" ||
      payload.command.type === "delivery.rules.configure" ||
      payload.command.type === "delivery.preview.configure" ||
      payload.command.type === "delivery.preview.publication.configure" ||
      payload.command.type === "project.tracker.configure" ||
      payload.command.type === "project.scheduling.configure" ||
      payload.command.type === "system.create" ||
      payload.command.type === "system.retry" ||
      payload.command.type === "improvement.configure" ||
      payload.command.type === "improvement.flush" ||
      payload.command.type === "improvement.batch.retry" ||
      payload.command.type === "proposal.decide" ||
      payload.command.type === "shared.repository.register" ||
      payload.command.type === "shared.repository.configure" ||
      payload.command.type === "shared.work.authorize" ||
      payload.command.type === "shared.work.notify.retry" ||
      payload.command.type === "shared.work.revoke" ||
      payload.command.type === "experiment.configure" ||
      payload.command.type === "workflow.adopt" ||
      payload.command.type === "workflow.override.clear" ||
      payload.command.type === "workflow.restart" ||
      payload.command.type === "workflow.restart.retry" ||
      payload.command.type === "workflow.restart.continue" ||
      payload.command.type === "workflow.models.apply" ||
      payload.command.type === "collaboration.decision.decide" ||
      (payload.command.type === "collaboration.request.respond" &&
        payload.command.response.kind === "accept" &&
        payload.command.response.support.kind === "commission" &&
        payload.command.response.support.work.kind === "rule-change") ||
      ((payload.command.type === "assignment.commission" ||
        payload.command.type === "assignment.handover") &&
        payload.command.kind === "rule-change")
      ? [AuthOrchestrationOperateScope, AuthSettingsWriteScope]
      : [AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
