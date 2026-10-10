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
  FactorySnapshot,
  FactoryCollaborationDirectoryEntry,
  FactoryIntegrationRead,
  FactoryIntegrationPatchPage,
  FactoryIntegrationCommand,
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
import { Tool, Toolkit } from "effect/ai";

import * as FactoryMcpGuard from "../../../factory/FactoryMcpGuard.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FactoryPreviewService } from "../../../factory/FactoryPreviewService.ts";

const dependencies = [
  FactoryMcpGuard.FactoryMcpGuard,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const failure = Schema.Union([FactoryError, OrchestratorMcpFailure]);
const previewDependencies = [...dependencies, FactoryPreviewService];
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
  failureMode: "return",
  dependencies: previewDependencies,
}).annotate(Tool.Readonly, true);
export const FactoryPreviewSnapshotToolkit = Toolkit.make(FactoryPreviewSnapshotTool);

export const FactoryToolkit = Toolkit.make(
  Tool.make("factory_integration_get", {
    description:
      "Read one integration group's scoped grants, exact candidate/head vector, host verification, test patches and slim participant lead identities. Available to participating project managers/current leads and the integration team. Historical recorded evidence is not fresh merge proof. This never grants arbitrary peer source or transcript access.",
    parameters: Schema.Struct({ integrationId: TrimmedNonEmptyString }),
    success: FactoryIntegrationRead,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
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
  }).annotate(Tool.Readonly, true),
  Tool.make("factory_integration_command", {
    description:
      "Commission cross-project QA from accepted requests; each project manager grants only a subset of its human-qualified capability. The integration lead refreshes inputs, preserving tests, and its team mutates only granted test/fixture files and runs protected verification. Current leads communicate through integration.message.send; production defects route through integration.defect.report. Integration teams cannot publish, merge or declare ordinary no-PR completion. Capability setup remains human-only. Use factory_integration_get for IDs and current evidence; recorded verification never substitutes for fresh final merge checks.",
    parameters: Schema.Struct({ command: FactoryIntegrationCommand }),
    success: FactoryCommandResult,
    failure,
    failureMode: "return",
    dependencies,
  }),
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
  }).annotate(Tool.Readonly, true),
  Tool.make("factory_improvement_record", {
    description:
      "Recover the complete durable text of a named investigation, exact proposal revision or decision, usefulness feedback, or recurrence. System-manager only. Bounded pages preserve a digest; use nextCursor until complete. This reads the shared improvement record, never its source threads or files.",
    parameters: FactoryImprovementRecordRead,
    success: FactoryImprovementRecord,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("factory_improvement_snapshot", {
    description:
      "Read bounded finding summaries, named investigations, and proposal summaries for the system manager. No project transcripts are included. Use nextCursor for subsequent pages and factory_investigation_read for linked source evidence.",
    parameters: Schema.Struct({ cursor: Schema.optionalKey(NonNegativeInt) }),
    success: FactoryImprovementSnapshot,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("factory_investigation_read", {
    description:
      "Read one bounded page of host-verified evidence attached to a finding in an open named investigation. Only the system manager may read; source assignment, actual thread records and immutable references are verified. Returns a digest and nextCursor; never accepts paths or URLs.",
    parameters: FactoryInvestigationRead,
    success: FactoryInvestigationEvidence,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("factory_ticket_read", {
    description:
      "Read the full current ticket and its detail digest before preparing a scheduling candidate. Managers can read their project's candidates; implementation and retrospective teams can read only their assignment's ticket. Scope is derived from authenticated thread identity.",
    parameters: Schema.Struct({ candidateId: TrimmedNonEmptyString }),
    success: Schema.Struct({ detail: IssueDetail, detailDigest: TrimmedNonEmptyString }),
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
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
  }),
  Tool.make("factory_preview_finish", {
    description:
      "Seal host-recorded UX evidence for this independent candidate review. Every named journey needs actual navigation, inspection, interaction, and screenshots. This cannot attest arbitrary files or URLs. Finish this before delivery.review.report.",
    parameters: FactoryPreviewFinishInput,
    success: FactoryRevisionUxEvidence,
    failure,
    failureMode: "return",
    dependencies: previewDependencies,
  }),
  Tool.make("factory_snapshot", {
    description:
      "Read this managed thread's manager and assignment state. A system manager sees its registered shared repositories, exact work plans, owned teams, workflow releases, validation and recommendations; implementation teams see only their assignment. The server derives scope from your authenticated thread and does not expose unrelated application projects.",
    parameters: Tool.EmptyParams,
    success: FactorySnapshot,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("factory_dispatch", {
    description:
      "Cross-project support uses collaboration.request.create/respond/withdraw. System managers request application work from the application manager using an owned assignment or investigation. Current participating leads coordinate through collaboration.message.send and collaboration.plan.propose/acknowledge; generic peer thread tools stay denied. Escalate scope, compatibility, permission, resource and priority changes via collaboration.decision.raise; only the human decides its exact revision. incident.restrict/release target concrete conflicting assignments within the owning project. " +
      "Submit a factory command as this authenticated managed thread. Project managers commission scoped assignments against a human request or host-verified scheduling authority. System managers use shared.work.propose for an exact plan against an accepted proposal revision, then shared.work.commission after human authorization; enabled bounded investigations may use experiment.commission. Shared work stays in registered owned repositories, never application projects. Skill work must use writing-for-agents and its references. Leads mutate/verify only their assignment and declare required PRs with assignment.completion.plan. Experiments cannot publish PRs, merge, create tracker tickets or change adoption. After host-confirmed conclusion, the independent retro submits retro.team.submit and its manager submits retro.manager.submit. System managers record available outcomes using improvement.validation.record and can recommend standing model preferences with workflow.models.recommend. Adoption, live trials, settings and standing model application remain human-only. Report evidenced problems with finding.report; escalate shared causes with finding.escalate. followup.request creates project triage tickets without starting implementation.",
    parameters: FactoryDispatchInput,
    success: FactoryCommandResult,
    failure,
    failureMode: "return",
    dependencies,
  }),
);
