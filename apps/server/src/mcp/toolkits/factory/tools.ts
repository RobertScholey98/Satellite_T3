import {
  FactoryCommandResult,
  FactoryImprovementSnapshot,
  FactoryImprovementRecordRead,
  FactoryImprovementRecord,
  FactoryInvestigationRead,
  FactoryInvestigationEvidence,
  NonNegativeInt,
  FactoryDispatchInput,
  FactoryError,
  FactoryCollaborationDirectoryEntry,
  FactoryIntegrationPatchPage,
  FactoryIntegrationCommand,
  FactoryMergeGroupQuery,
  CommandId,
  OrchestratorMcpFailure,
  FactoryPreviewActionInput,
  FactoryPreviewActionResult,
  FactoryPreviewFinishInput,
  FactoryRevisionUxEvidence,
  PreviewAutomationSnapshot,
  IssueDetail,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as FactoryPreviewService from "../../../factory/FactoryPreviewService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const failure = Schema.Union([FactoryError, OrchestratorMcpFailure]);
/**
 * A large read model, returned already encoded. Its full schema would add about 190 KB to
 * every managed session's `tools/list`; the content is the same either way.
 */
export const EncodedRead = Schema.Record(Schema.String, Schema.Unknown);
const previewDependencies = [...dependencies, FactoryPreviewService.FactoryPreviewService];
export const FactoryPreviewSnapshotTool = Tool.make("factory_preview_snapshot", {
  description:
    "Inspect the current independent review's isolated candidate app. Returns semantic page state and an actual PNG image; journals both against the immutable candidate and named journey. Use these locators for factory_preview_action. No external or user tab can be selected.",
  parameters: Schema.Struct({
    commandId: FactoryPreviewActionInput.fields.commandId,
    instanceId: FactoryPreviewActionInput.fields.instanceId,
    journey: FactoryPreviewActionInput.fields.journey,
  }),
  success: Schema.Struct({
    ...PreviewAutomationSnapshot.fields,
    sequence: FactoryPreviewActionResult.fields.sequence,
    receiptDigest: FactoryPreviewActionResult.fields.receiptDigest,
  }),
  failure,
  dependencies: previewDependencies,
})
  .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
  .annotate(Tool.Readonly, true);
export const FactoryPreviewSnapshotToolkit = Toolkit.make(FactoryPreviewSnapshotTool);

export const FactoryToolkit = Toolkit.make(
  Tool.make("factory_merge_group_get", {
    description:
      "Read the consolidated PR readiness and exact combined review for this integration lead's group. Current integration lead only; managers and workers do not review PRs. Includes slim member identities, current checks, review summaries, screenshot references and blockers, never foreign assignment grants, source paths or transcripts. Historical passing evidence is not fresh merge authority.",
    parameters: FactoryMergeGroupQuery,
    success: EncodedRead,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
    .annotate(Tool.Readonly, true),
  Tool.make("factory_merge_group_review", {
    description:
      "As the current integration lead, request fresh host inspection and a sealed combined review for all linked PRs. The human reviews the combined feature in this integration conversation and sends corrections to owning leads. Agents cannot approve or reject the human decision. This tool does not merge anything; use the shared start action only after every review gate passes.",
    parameters: Schema.Struct({
      commandId: CommandId,
      groupId: FactoryMergeGroupQuery.fields.groupId,
    }),
    success: FactoryCommandResult,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly),
  Tool.make("factory_merge_group_start", {
    description:
      "As the exact integration lead, start one durable shared merge for the current sealed review. Requires every existing human or project-rule approval. Freezes integration work, conditionally merges each exact PR, and records actual outcomes. Cross-repository writes are sequential: partial success remains visible and cannot be rolled back automatically. Read factory_merge_group_get before starting.",
    parameters: Schema.Struct({
      commandId: CommandId,
      groupId: FactoryMergeGroupQuery.fields.groupId,
      reviewId: TrimmedNonEmptyString,
      expectedDigest: TrimmedNonEmptyString,
    }),
    success: FactoryCommandResult,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly),
  Tool.make("factory_merge_operation_action", {
    description:
      "As the exact integration lead, reconcile actual host outcomes, retry the same reviewed merge operation when its current gates and remaining attempt allowance permit, or escalate it to the human. Reconcile is read-only at the host and never grants another submission. Retry preserves confirmed members and attempt counts. Escalate holds further submissions and records your reason and recommendation for the human; use it when recovery is unsafe or exhausted, or when a merged member should be reverted. Reverting needs the human's decision and a separately authorized task. While the merge is frozen these merge tools and factory_snapshot are your only factory tools. Unknown outcomes, changed revisions, and revoked authority cannot be bypassed. Read factory_merge_group_get for the operation and recommendation first. Set command.type to merge.operation.reconcile, merge.operation.retry, or merge.operation.escalate with a reason and recommendation.",
    parameters: Schema.Struct({
      command: Schema.Union([
        Schema.Struct({
          type: Schema.Literals(["merge.operation.reconcile", "merge.operation.retry"]),
          commandId: CommandId,
          operationId: TrimmedNonEmptyString,
        }),
        Schema.Struct({
          type: Schema.Literal("merge.operation.escalate"),
          commandId: CommandId,
          operationId: TrimmedNonEmptyString,
          reason: TrimmedNonEmptyString,
          recommendation: TrimmedNonEmptyString,
        }),
      ]),
    }),
    success: FactoryCommandResult,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly),
  Tool.make("factory_integration_get", {
    description:
      "Read one integration group's scoped grants, exact candidate/head vector, host verification, test patches and slim participant lead identities. Available to participating project managers/current leads and the integration team. Historical recorded evidence is not fresh merge proof. This never grants arbitrary peer source or transcript access.",
    parameters: Schema.Struct({ integrationId: TrimmedNonEmptyString }),
    success: EncodedRead,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
    .annotate(Tool.Readonly, true),
  Tool.make("factory_integration_read_patch", {
    description:
      "Read a bounded page of an immutable test/fixture patch listed in factory_integration_get. Owning project managers/current leads can read their own project patch; the requester and integration team can read granted participant patches. Concatenate pages in cursor order and verify the full digest. JSON contains base64 file content, mode, digest and deleted paths; apply through your own assignment boundary and PR process. No arbitrary path or URL is accepted.",
    parameters: Schema.Struct({
      patchArtifactId: TrimmedNonEmptyString,
      cursor: Schema.optionalKey(NonNegativeInt),
      limit: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(16000)),
      ),
    }),
    success: FactoryIntegrationPatchPage,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
    .annotate(Tool.Readonly, true),
  Tool.make("factory_integration_command", {
    description:
      "Commission cross-project QA from accepted requests; each project manager grants within its human-qualified capability; a grant beyond it is recorded as requested for the human to approve or decline, and the owner can withdraw it with integration.grant.revoke. The integration lead refreshes inputs, preserving tests, and its team mutates only granted test/fixture files and runs protected verification. Current leads communicate through integration.message.send; production defects route through integration.defect.report. Integration teams cannot publish, merge or declare ordinary no-PR completion. Capability setup remains human-only. Use factory_integration_get for IDs and current evidence; recorded verification never substitutes for fresh final merge checks.",
    parameters: Schema.Struct({ command: FactoryIntegrationCommand }),
    success: FactoryCommandResult,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly),
  Tool.make("factory_collaboration_directory", {
    description:
      "List a bounded page of peer manager identities for a cross-project work request. Managers only. Returns names, project identities and status, never their assignments, files, grants or transcripts. Use factory_dispatch collaboration.request.create for an owned assignment or system investigation. This directory grants no cross-project tool access.",
    parameters: Schema.Struct({ cursor: Schema.optionalKey(NonNegativeInt) }),
    success: Schema.Struct({
      entries: Schema.Array(FactoryCollaborationDirectoryEntry),
      nextCursor: Schema.NullOr(NonNegativeInt),
    }),
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
    .annotate(Tool.Readonly, true),
  Tool.make("factory_improvement_record", {
    description:
      "Recover the complete durable text of a named investigation, exact proposal revision or decision, usefulness feedback, or recurrence. System-manager only. Bounded pages preserve a digest; use nextCursor until complete. This reads the shared improvement record, never its source threads or files.",
    parameters: FactoryImprovementRecordRead,
    success: FactoryImprovementRecord,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
    .annotate(Tool.Readonly, true),
  Tool.make("factory_improvement_snapshot", {
    description:
      "Read bounded finding summaries, named investigations, and proposal summaries for the system manager. No project transcripts are included. Use nextCursor for subsequent pages and factory_investigation_read for linked source evidence.",
    parameters: Schema.Struct({ cursor: Schema.optionalKey(NonNegativeInt) }),
    success: FactoryImprovementSnapshot,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
    .annotate(Tool.Readonly, true),
  Tool.make("factory_investigation_read", {
    description:
      "Read one bounded page of host-verified evidence attached to a finding in an open named investigation. Only the system manager may read; source assignment, actual thread records and immutable references are verified. Returns a digest and nextCursor; never accepts paths or URLs.",
    parameters: FactoryInvestigationRead,
    success: FactoryInvestigationEvidence,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
    .annotate(Tool.Readonly, true),
  Tool.make("factory_ticket_read", {
    description:
      "Read the full current ticket and its detail digest before preparing a scheduling candidate. Managers can read their project's candidates; implementation and retrospective teams can read only their assignment's ticket. Scope is derived from authenticated thread identity.",
    parameters: Schema.Struct({ candidateId: TrimmedNonEmptyString }),
    success: Schema.Struct({ detail: IssueDetail, detailDigest: TrimmedNonEmptyString }),
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
    .annotate(Tool.Readonly, true),
  Tool.make("factory_preview_action", {
    description:
      "Exercise a named journey in the independent review's isolated immutable candidate app. Paths are relative to that app; no arbitrary URL, browser tab, script evaluation, upload, or host access. Use factory_preview_snapshot for page inspection and PNG images.",
    parameters: FactoryPreviewActionInput.check(
      Schema.makeFilter(
        (input) =>
          input.action.type !== "snapshot" ||
          "Use factory_preview_snapshot to inspect the page and its screenshot.",
      ),
    ),
    success: FactoryPreviewActionResult,
    failure,
    failureMode: "return",
    dependencies: previewDependencies,
  }).annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly),
  Tool.make("factory_preview_finish", {
    description:
      "Seal host-recorded UX evidence for this independent candidate review. Every named journey needs actual navigation, inspection, interaction, and screenshots. This cannot attest arbitrary files or URLs. Finish this before delivery.review.report.",
    parameters: FactoryPreviewFinishInput,
    success: FactoryRevisionUxEvidence,
    failure,
    failureMode: "return",
    dependencies: previewDependencies,
  }).annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly),
  Tool.make("factory_snapshot", {
    description:
      "Read this managed thread's manager and assignment state. A system manager sees its registered shared repositories, exact work plans, owned teams, validation and recommendations; implementation teams see only their assignment. The server derives scope from your authenticated thread and does not expose unrelated application projects.",
    parameters: Tool.EmptyParams,
    success: EncodedRead,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly)
    .annotate(Tool.Readonly, true),
  Tool.make("factory_dispatch", {
    description:
      "Cross-project support uses collaboration.request.create/respond/withdraw; collaboration.request.reconsider lets the requester ask again after a deferral or decline. System managers request application work from the application manager using an owned assignment or investigation. Current participating leads coordinate through collaboration.message.send and collaboration.plan.propose/acknowledge; generic peer thread tools stay denied. A boundary plan, optionally with amendments that replace a request's outcome, acceptance and compatibility in place, needs collaboration.plan.decide approval from every owning manager or the human; any owner or the human can decline it. For cross-project work, escalate scope, compatibility, permission, resource and priority changes via collaboration.decision.raise; only the human decides its exact revision. When the human changes an assignment's scope or priority in one of its threads, send that message to the manager with guidance.escalate (threadId, messageId, summary). incident.restrict/release target concrete conflicting assignments within the owning project. " +
      "Submit a factory command as this authenticated managed thread. Project managers commission scoped assignments against a human request or host-verified scheduling authority. System managers use shared.work.propose for an exact plan against an accepted proposal revision, then shared.work.commission after human authorization; enabled bounded investigations may use experiment.commission. Shared work stays in registered owned repositories, never application projects. Skill work must use writing-for-agents and its references. Leads mutate/verify only their assignment and declare required PRs with assignment.completion.plan. Experiments cannot publish PRs, merge or create tracker tickets. After host-confirmed conclusion, the independent retro submits retro.team.submit and its manager submits retro.manager.submit. System managers record available outcomes using improvement.validation.record and can recommend standing model preferences with workflow.models.recommend. Every assignment uses the skills repository commit current when it was commissioned; merging skill changes, settings and standing model application remain human-only. Report evidenced problems with finding.report; escalate shared causes with finding.escalate. followup.request creates project triage tickets without starting implementation. schedule.track brings a board ticket that is not Ready into the project queue to prepare and recommend; it authorizes nothing.",
    parameters: FactoryDispatchInput,
    success: FactoryCommandResult,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(McpSchema.EnabledWhen, McpToolAccess.grantedOnly),
);
