import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";
import { FACTORY_WS_METHODS, FactoryDispatchInput, type FactoryCommand } from "./factory.ts";

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

type Scopes = readonly AuthEnvironmentScope[];
const operate: Scopes = [AuthOrchestrationOperateScope];
const settings: Scopes = [AuthOrchestrationOperateScope, AuthSettingsWriteScope];
const sourceControl: Scopes = [AuthOrchestrationOperateScope, AuthSourceControlWriteScope];
// Work that changes the factory's own rules needs settings access, like editing them directly.
const settingsForRuleChange = (command: FactoryCommand): Scopes =>
  ((command.type === "assignment.commission" || command.type === "assignment.handover") &&
    command.kind === "rule-change") ||
  (command.type === "collaboration.request.respond" &&
    command.response.kind === "accept" &&
    command.response.support.kind === "commission" &&
    command.response.support.work.kind === "rule-change")
    ? settings
    : operate;

// Every factory command names its scopes, so a new command fails to compile until it has one.
const FACTORY_COMMAND_SCOPES: Record<
  FactoryCommand["type"],
  Scopes | ((command: FactoryCommand) => Scopes)
> = {
  "assignment.cancel": operate,
  "assignment.cancellation-reason": operate,
  "assignment.commission": settingsForRuleChange,
  "assignment.completion.accept": operate,
  "assignment.completion.plan": operate,
  "assignment.completion.retry": operate,
  "assignment.completion.waive": operate,
  "assignment.delivery.request": operate,
  "assignment.file.mutate": operate,
  "assignment.handover": settingsForRuleChange,
  "assignment.progress": operate,
  "assignment.recovery.begin": operate,
  "assignment.recovery.escalate": operate,
  "assignment.recovery.replan": operate,
  "assignment.retry": operate,
  "assignment.verify": operate,
  "assignment.wait": operate,
  "assignment.wait.resolve": operate,
  "assignments.extend-grant": settings,
  "auxiliary.report": operate,
  "collaboration.decision.decide": settings,
  "collaboration.decision.raise": operate,
  "collaboration.message.retry": operate,
  "collaboration.message.send": operate,
  "collaboration.plan.acknowledge": operate,
  "collaboration.plan.decide": operate,
  "collaboration.plan.propose": operate,
  "collaboration.request.create": operate,
  "collaboration.request.reconsider": operate,
  "collaboration.request.respond": settingsForRuleChange,
  "collaboration.request.withdraw": operate,
  "control.retry": operate,
  "delivery.approve": sourceControl,
  "delivery.capture": operate,
  "delivery.flow.decide": operate,
  "delivery.flow.retry": operate,
  "delivery.flow.submit": operate,
  "delivery.impact.declare": operate,
  "delivery.merge": sourceControl,
  "delivery.preview.configure": settings,
  "delivery.preview.publication.configure": settings,
  "delivery.preview.start": operate,
  "delivery.preview.stop": operate,
  "delivery.publish": sourceControl,
  "delivery.ready": operate,
  "delivery.retry": operate,
  "delivery.review.handback": operate,
  "delivery.review.report": operate,
  "delivery.review.request": operate,
  "delivery.rules.configure": settings,
  "dependency.approve": operate,
  "dependency.check-usability": operate,
  "dependency.request": operate,
  "experiment.commission": operate,
  "experiment.configure": settings,
  "finding.escalate": operate,
  "finding.escalation.acknowledge": operate,
  "finding.report": operate,
  "finding.route": operate,
  "followup.link-existing": operate,
  "followup.request": operate,
  "followup.retry": operate,
  "followup.waive": operate,
  "guidance.escalate": operate,
  "improvement.batch.retry": settings,
  "improvement.configure": settings,
  "improvement.flush": settings,
  "improvement.validation.record": operate,
  "incident.release": operate,
  "incident.restrict": operate,
  "incident.retry": operate,
  "integration.capability.configure": settings,
  "integration.capability.retry": settings,
  "integration.commission": operate,
  "integration.defect.report": operate,
  "integration.file.mutate": operate,
  "integration.grant": operate,
  "integration.grant.approve": settings,
  "integration.grant.revoke": operate,
  "integration.message.retry": operate,
  "integration.message.send": operate,
  "integration.refresh": operate,
  "integration.thread.retry": operate,
  "integration.verify": operate,
  "investigation.open": operate,
  "investigation.recurrence": operate,
  "investigation.update": operate,
  "manager.approve-onboarding": settings,
  "manager.configure": settings,
  "manager.create": operate,
  "manager.models.configure": settings,
  "manager.pause": operate,
  "manager.refresh-boundary": settings,
  "manager.resume": operate,
  "manager.retire": settings,
  "manager.retry-onboarding": operate,
  "merge.group.approve": settings,
  "merge.group.reject": settings,
  "merge.group.release": operate,
  "merge.group.restore": operate,
  "merge.group.review": operate,
  "merge.group.start": sourceControl,
  "merge.operation.escalate": operate,
  "merge.operation.reconcile": operate,
  "merge.operation.retry": sourceControl,
  "merge.operation.stop": operate,
  "models.defaults.configure": settings,
  "onboarding.report": operate,
  "policy.defaults.configure": settings,
  "project.pause": operate,
  "project.resume": operate,
  "project.scheduling.configure": settings,
  "project.tracker.configure": settings,
  "proposal.decide": settings,
  "proposal.feedback": operate,
  "proposal.submit": operate,
  "proposal.write": operate,
  "retro.manager.submit": operate,
  "retro.retry": operate,
  "retro.team.submit": operate,
  "schedule.dismiss": operate,
  "schedule.prepare": operate,
  "schedule.reopen": operate,
  "schedule.retry": operate,
  "schedule.track": operate,
  "shared.repository.configure": settings,
  "shared.repository.register": settings,
  "shared.work.authorize": settings,
  "shared.work.commission": operate,
  "shared.work.notify.retry": settings,
  "shared.work.propose": operate,
  "shared.work.revoke": settings,
  "system.create": settings,
  "system.retry": settings,
  "thread.handback": operate,
  "thread.takeover": operate,
  "workflow.adopt": settings,
  "workflow.models.apply": settings,
  "workflow.models.decline": settings,
  "workflow.models.recommend": operate,
  "workflow.override.clear": settings,
  "workflow.release.register": operate,
  "workflow.restart": settings,
  "workflow.restart.continue": settings,
  "workflow.restart.retry": settings,
};

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === FACTORY_WS_METHODS.dispatchCommand && input !== undefined) {
    const { command } = decodeFactoryDispatch(input);
    const scopes = FACTORY_COMMAND_SCOPES[command.type];
    return typeof scopes === "function" ? scopes(command) : scopes;
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
