import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";

/**
 * Revdoc keeps one living review checklist per worktree. These are Satellite-only contracts: the
 * official T3 Code mobile app never calls them, and they must stay additive.
 */
export const REVDOC_LIMITS = {
  items: 5_000,
  notePreview: 300,
  check: 500,
  expected: 2_000,
  note: 8_000,
  steps: 4_000,
  observed: 4_000,
  caption: 500,
  coveredPaths: 20,
  getItems: 100,
} as const;

const boundedText = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const RevdocItemId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type RevdocItemId = typeof RevdocItemId.Type;
export const RevdocPassId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type RevdocPassId = typeof RevdocPassId.Type;

/** The person's verdict. Separate from the AI result. */
export const RevdocOutcome = Schema.Literals([
  "not_checked",
  "complete",
  "broken",
  "change_requested",
  "skipped",
]);
export type RevdocOutcome = typeof RevdocOutcome.Type;

export const RevdocResultState = Schema.Literals(["passed", "failed", "blocked"]);
export type RevdocResultState = typeof RevdocResultState.Type;
export const RevdocTestMethod = Schema.Literals(["browser", "command"]);
export type RevdocTestMethod = typeof RevdocTestMethod.Type;
/** Which side changed since the outcome or result was recorded. Derived, never stored. */
export const RevdocRetest = Schema.Literals(["check", "code", "both"]);
export type RevdocRetest = typeof RevdocRetest.Type;

export const RevdocEvidence = Schema.Struct({
  id: RevdocItemId,
  caption: Schema.String,
  capturedAt: IsoDateTime,
  /** Worktree-relative, under `.revdoc/evidence`. */
  path: Schema.String,
});
export type RevdocEvidence = typeof RevdocEvidence.Type;

export const RevdocResult = Schema.Struct({
  passId: RevdocPassId,
  state: RevdocResultState,
  method: RevdocTestMethod,
  steps: Schema.String,
  observed: Schema.String,
  model: Schema.String,
  recordedAt: IsoDateTime,
  evidence: Schema.Array(RevdocEvidence),
});
export type RevdocResult = typeof RevdocResult.Type;

export const RevdocItemSummary = Schema.Struct({
  id: RevdocItemId,
  revision: NonNegativeInt,
  position: NonNegativeInt,
  area: Schema.String,
  check: Schema.String,
  outcome: RevdocOutcome,
  /** The start of the note; the full note comes with the item detail. */
  note: Schema.String,
  noteTruncated: Schema.Boolean,
  retest: Schema.NullOr(RevdocRetest),
  stale: Schema.Boolean,
  dismissed: Schema.Boolean,
  result: Schema.NullOr(Schema.Struct({ state: RevdocResultState, evidenceCount: NonNegativeInt })),
});
export type RevdocItemSummary = typeof RevdocItemSummary.Type;

export const RevdocItemDetail = Schema.Struct({
  ...RevdocItemSummary.fields,
  expected: Schema.String,
  coveredPaths: Schema.Array(Schema.String),
  result: Schema.NullOr(RevdocResult),
});
export type RevdocItemDetail = typeof RevdocItemDetail.Type;

export const RevdocReviewHeader = Schema.Struct({
  id: RevdocItemId,
  projectId: ProjectId,
  worktreePath: Schema.String,
  revision: NonNegativeInt,
  title: Schema.String,
  summary: Schema.String,
  context: Schema.String,
  /** True while a batched generation pass is still assembling the checklist. */
  partial: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  generatedAt: Schema.NullOr(IsoDateTime),
  refreshedAt: Schema.NullOr(IsoDateTime),
  exportError: Schema.NullOr(Schema.String),
});
export type RevdocReviewHeader = typeof RevdocReviewHeader.Type;

export const RevdocPassKind = Schema.Literals(["generate", "test"]);
export type RevdocPassKind = typeof RevdocPassKind.Type;
export const RevdocPassStatus = Schema.Literals([
  "running",
  "completed",
  "cancelled",
  "conflicted",
  "failed",
  "interrupted",
]);
export type RevdocPassStatus = typeof RevdocPassStatus.Type;

export const RevdocGenerationProgress = Schema.Struct({
  stage: Schema.Literals(["reviewing", "combining"]),
  completed: NonNegativeInt,
  total: NonNegativeInt,
  /** One entry per running model call, with server-measured elapsed time. */
  running: Schema.Array(Schema.Struct({ batch: NonNegativeInt, elapsedMs: NonNegativeInt })),
});
export type RevdocGenerationProgress = typeof RevdocGenerationProgress.Type;

export const RevdocTestProgress = Schema.Struct({
  parentThreadId: ThreadId,
  childThreadId: Schema.NullOr(ThreadId),
  recorded: NonNegativeInt,
  total: NonNegativeInt,
  section: NonNegativeInt,
  sections: NonNegativeInt,
});
export type RevdocTestProgress = typeof RevdocTestProgress.Type;

export const RevdocPassReport = Schema.Struct({
  added: NonNegativeInt,
  updated: NonNegativeInt,
  staled: NonNegativeInt,
  unstaled: NonNegativeInt,
  unknownIds: NonNegativeInt,
  /** New checks left out because the Review reached its item cap. */
  dropped: NonNegativeInt,
  notReached: NonNegativeInt,
});
export type RevdocPassReport = typeof RevdocPassReport.Type;

export const RevdocPass = Schema.Struct({
  id: RevdocPassId,
  kind: RevdocPassKind,
  status: RevdocPassStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  model: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  report: Schema.NullOr(RevdocPassReport),
  generation: Schema.NullOr(RevdocGenerationProgress),
  testing: Schema.NullOr(RevdocTestProgress),
});
export type RevdocPass = typeof RevdocPass.Type;

export const RevdocSnapshot = Schema.Struct({
  worktreePath: Schema.String,
  review: Schema.NullOr(RevdocReviewHeader),
  items: Schema.Array(RevdocItemSummary),
  activePass: Schema.NullOr(RevdocPass),
  latestPasses: Schema.Array(RevdocPass),
  /** The thread a test pass would run under, or null when the worktree has no thread. */
  testParentThreadId: Schema.NullOr(ThreadId),
});
export type RevdocSnapshot = typeof RevdocSnapshot.Type;

/**
 * `revdoc.subscribe` emits a snapshot first, then one delta per committed change. Every delta
 * carries the Review revision it produced; pass progress repeats the current revision. A client
 * that sees a gap resubscribes.
 */
export const RevdocEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { snapshot: RevdocSnapshot }),
  Schema.TaggedStruct("delta", {
    revision: NonNegativeInt,
    review: Schema.optionalKey(RevdocReviewHeader),
    items: Schema.optionalKey(Schema.Array(RevdocItemSummary)),
    removed: Schema.optionalKey(Schema.Array(RevdocItemId)),
    activePass: Schema.optionalKey(Schema.NullOr(RevdocPass)),
    latestPass: Schema.optionalKey(RevdocPass),
  }),
  Schema.TaggedStruct("deleted", { revision: NonNegativeInt }),
]);
export type RevdocEvent = typeof RevdocEvent.Type;

/** A Revdoc request names a thread and may pick another worktree of the same repository. */
export const RevdocTarget = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RevdocTarget = typeof RevdocTarget.Type;

export const RevdocWorktreesInput = Schema.Struct({ threadId: ThreadId });
export type RevdocWorktreesInput = typeof RevdocWorktreesInput.Type;
export const RevdocWorktrees = Schema.Struct({
  /** The thread's own worktree, or the project root when the thread has none. */
  defaultPath: Schema.String,
  worktrees: Schema.Array(
    Schema.Struct({ path: Schema.String, branch: Schema.NullOr(Schema.String) }),
  ),
});
export type RevdocWorktrees = typeof RevdocWorktrees.Type;

export const RevdocGetItemsInput = Schema.Struct({
  ...RevdocTarget.fields,
  ids: Schema.Array(RevdocItemId).check(Schema.isMaxLength(REVDOC_LIMITS.getItems)),
});
export type RevdocGetItemsInput = typeof RevdocGetItemsInput.Type;

export const RevdocAction = Schema.Literals(["generate", "generate-and-test"]);
export type RevdocAction = typeof RevdocAction.Type;
export const RevdocGenerateInput = Schema.Struct({
  ...RevdocTarget.fields,
  action: Schema.optionalKey(RevdocAction),
});
export type RevdocGenerateInput = typeof RevdocGenerateInput.Type;

export const RevdocTestSelection = Schema.Literals(["remaining", "failed", "items"]);
export type RevdocTestSelection = typeof RevdocTestSelection.Type;
export const RevdocTestInput = Schema.Struct({
  ...RevdocTarget.fields,
  selection: RevdocTestSelection,
  itemIds: Schema.optionalKey(
    Schema.Array(RevdocItemId).check(Schema.isMaxLength(REVDOC_LIMITS.items)),
  ),
});
export type RevdocTestInput = typeof RevdocTestInput.Type;

export const RevdocPassStarted = Schema.Struct({ passId: RevdocPassId });
export type RevdocPassStarted = typeof RevdocPassStarted.Type;

export const RevdocItemChange = Schema.Union([
  Schema.TaggedStruct("set_outcome", { outcome: RevdocOutcome }),
  Schema.TaggedStruct("set_note", { note: boundedText(REVDOC_LIMITS.note) }),
  Schema.TaggedStruct("dismiss", {}),
  Schema.TaggedStruct("restore", {}),
]);
export type RevdocItemChange = typeof RevdocItemChange.Type;

export const RevdocEditItemInput = Schema.Struct({
  ...RevdocTarget.fields,
  itemId: RevdocItemId,
  expectedRevision: NonNegativeInt,
  change: RevdocItemChange,
});
export type RevdocEditItemInput = typeof RevdocEditItemInput.Type;

export const RevdocDeleteInput = Schema.Struct({
  ...RevdocTarget.fields,
  expectedRevision: NonNegativeInt,
});
export type RevdocDeleteInput = typeof RevdocDeleteInput.Type;

export const RevdocRecordResultInput = Schema.Struct({
  passId: RevdocPassId,
  itemId: RevdocItemId,
  state: RevdocResultState,
  method: RevdocTestMethod,
  steps: boundedText(REVDOC_LIMITS.steps),
  observed: boundedText(REVDOC_LIMITS.observed),
});
export type RevdocRecordResultInput = typeof RevdocRecordResultInput.Type;

export const RevdocCaptureEvidenceInput = Schema.Struct({
  passId: RevdocPassId,
  itemId: RevdocItemId,
  caption: boundedText(REVDOC_LIMITS.caption),
  tabId: Schema.optionalKey(PreviewTabId),
});
export type RevdocCaptureEvidenceInput = typeof RevdocCaptureEvidenceInput.Type;

export const RevdocErrorCode = Schema.Literals([
  "not_found",
  "conflict",
  "busy",
  "provider_unavailable",
  "invalid_output",
  "invalid_request",
  "not_allowed",
  "no_browser_host",
  "browser_access_off",
  "storage",
]);
export type RevdocErrorCode = typeof RevdocErrorCode.Type;

/**
 * The one Revdoc failure. A conflict carries the current item (item edits) or the current Review
 * revision (review-wide operations); busy carries the running pass.
 */
export class RevdocError extends Schema.TaggedError<RevdocError>()("RevdocError", {
  code: RevdocErrorCode,
  message: Schema.String,
  currentItem: Schema.optionalKey(RevdocItemDetail),
  currentRevision: Schema.optionalKey(NonNegativeInt),
  passId: Schema.optionalKey(RevdocPassId),
}) {}
export const isRevdocError = Schema.is(RevdocError);

export const REVDOC_WS_METHODS = {
  revdocWorktrees: "revdoc.worktrees",
  revdocSubscribe: "revdoc.subscribe",
  revdocGetItems: "revdoc.getItems",
  revdocGenerate: "revdoc.generate",
  revdocTest: "revdoc.test",
  revdocCancel: "revdoc.cancel",
  revdocRefresh: "revdoc.refresh",
  revdocEditItem: "revdoc.editItem",
  revdocDelete: "revdoc.delete",
} as const;

const RevdocRpcError = Schema.Union([RevdocError, EnvironmentAuthorizationError]);
const revdocRpc = <const Tag extends string, P extends Schema.Top, S extends Schema.Top>(
  tag: Tag,
  payload: P,
  success: S,
) => Rpc.make(tag, { payload, success, error: RevdocRpcError });

export const WsRevdocWorktreesRpc = revdocRpc(
  REVDOC_WS_METHODS.revdocWorktrees,
  RevdocWorktreesInput,
  RevdocWorktrees,
);
export const WsRevdocSubscribeRpc = Rpc.make(REVDOC_WS_METHODS.revdocSubscribe, {
  payload: RevdocTarget,
  success: RevdocEvent,
  error: RevdocRpcError,
  stream: true,
});
export const WsRevdocGetItemsRpc = revdocRpc(
  REVDOC_WS_METHODS.revdocGetItems,
  RevdocGetItemsInput,
  Schema.Struct({ items: Schema.Array(RevdocItemDetail) }),
);
export const WsRevdocGenerateRpc = revdocRpc(
  REVDOC_WS_METHODS.revdocGenerate,
  RevdocGenerateInput,
  RevdocPassStarted,
);
export const WsRevdocTestRpc = revdocRpc(
  REVDOC_WS_METHODS.revdocTest,
  RevdocTestInput,
  RevdocPassStarted,
);
export const WsRevdocCancelRpc = revdocRpc(
  REVDOC_WS_METHODS.revdocCancel,
  RevdocTarget,
  Schema.Struct({}),
);
export const WsRevdocRefreshRpc = revdocRpc(
  REVDOC_WS_METHODS.revdocRefresh,
  RevdocTarget,
  Schema.Struct({}),
);
export const WsRevdocEditItemRpc = revdocRpc(
  REVDOC_WS_METHODS.revdocEditItem,
  RevdocEditItemInput,
  RevdocItemSummary,
);
export const WsRevdocDeleteRpc = revdocRpc(
  REVDOC_WS_METHODS.revdocDelete,
  RevdocDeleteInput,
  Schema.Struct({}),
);
