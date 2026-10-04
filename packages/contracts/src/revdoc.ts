import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Text = Schema.String.check(Schema.isMaxLength(20_000));
export const RevdocOutcome = Schema.Literals([
  "untested",
  "complete",
  "partial",
  "broken",
  "notspec",
  "change",
  "missed",
  "na",
]);
export type RevdocOutcome = typeof RevdocOutcome.Type;
export const RevdocEvidence = Schema.Struct({
  id: Id,
  path: Text,
  caption: Schema.optionalKey(Text),
  capturedAt: Schema.optionalKey(Text),
  sourceRevision: Schema.optionalKey(Text),
});
export const RevdocAttempt = Schema.Struct({
  runId: Id,
  state: Schema.Literals(["queued", "running", "passed", "failed", "blocked"]),
  by: Text,
  sourceRevision: Text,
  definitionRevision: Text,
  startedAt: Text,
  finishedAt: Schema.optionalKey(Text),
  method: Schema.optionalKey(Schema.Literals(["browser", "command"])),
  steps: Schema.optionalKey(Text),
  observed: Schema.optionalKey(Text),
  evidence: Schema.Array(RevdocEvidence),
});
export type RevdocAttempt = typeof RevdocAttempt.Type;
export const RevdocTestingRun = Schema.Struct({
  id: Id,
  threadId: ThreadId,
  audience: Schema.optionalKey(Schema.Literal("revdoc")),
  sourceRevision: Text,
  status: Schema.Literals(["running", "completed", "cancelled", "failed", "interrupted"]),
  startedAt: Text,
  finishedAt: Schema.optionalKey(Text),
  error: Schema.optionalKey(Text),
  testIds: Schema.Array(Id),
});
export type RevdocTestingRun = typeof RevdocTestingRun.Type;
export const RevdocTest = Schema.Struct({
  id: Id,
  title: Text,
  expected: Schema.optionalKey(Text),
  outcome: Schema.optionalKey(RevdocOutcome),
  feedback: Schema.optionalKey(Text),
  attempts: Schema.optionalKey(Schema.Array(RevdocAttempt)),
  verification: Schema.optionalKey(
    Schema.Struct({
      result: Schema.Literals(["passed", "failed", "blocked"]),
      by: Schema.optionalKey(Text),
      testedAt: Schema.optionalKey(Text),
      sourceRevision: Schema.optionalKey(Text),
    }),
  ),
  evidence: Schema.optionalKey(Schema.Array(RevdocEvidence)),
});
export type RevdocTest = typeof RevdocTest.Type;
export const RevdocItem = Schema.Struct({
  id: Id,
  name: Text,
  status: Schema.optionalKey(Schema.Literals(["done", "doing", "todo", "blocked"])),
  summary: Schema.optionalKey(Text),
  prd: Schema.optionalKey(Schema.Array(Text)),
  quirks: Schema.optionalKey(Schema.Array(Text)),
  flags: Schema.optionalKey(Schema.Array(Schema.Struct({ k: Text, t: Text }))),
  endpoints: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        endpoint: Text,
        what: Schema.optionalKey(Text),
        data: Schema.optionalKey(Text),
        fits: Schema.optionalKey(Text),
        hooks: Schema.optionalKey(Text),
        cache: Schema.optionalKey(Text),
        shape: Schema.optionalKey(Text),
      }),
    ),
  ),
  note: Schema.optionalKey(Text),
  tests: Schema.Array(RevdocTest),
});
export type RevdocItem = typeof RevdocItem.Type;
export const RevdocSection = Schema.Struct({
  id: Id,
  area: Text,
  note: Schema.optionalKey(Text),
  items: Schema.Array(RevdocItem),
});
export type RevdocSection = typeof RevdocSection.Type;
export const RevdocReview = Schema.Struct({
  title: Text,
  summary: Schema.optionalKey(Text),
  context: Schema.optionalKey(Text),
  notes: Schema.optionalKey(Text),
  generatedAt: Schema.optionalKey(Text),
  sourceRevision: Schema.optionalKey(Text),
  testing: Schema.optionalKey(RevdocTestingRun),
  sections: Schema.Array(RevdocSection),
});
export type RevdocReview = typeof RevdocReview.Type;
export const RevdocInput = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.optionalKey(Schema.String),
});
export type RevdocInput = typeof RevdocInput.Type;
export const RevdocStartInput = Schema.Struct({
  ...RevdocInput.fields,
  action: Schema.optionalKey(Schema.Literals(["generate", "generate-and-test"])),
});
export type RevdocStartInput = typeof RevdocStartInput.Type;
export const RevdocTestStartInput = Schema.Struct({
  ...RevdocInput.fields,
  selection: Schema.Literals(["remaining", "failed", "all"]),
  testIds: Schema.optionalKey(Schema.Array(Id).check(Schema.isMaxLength(1000))),
});
export type RevdocTestStartInput = typeof RevdocTestStartInput.Type;
export const RevdocTestTarget = Schema.Struct({ runId: Id, testId: Id });
export const RevdocRecordTestInput = Schema.Struct({
  ...RevdocTestTarget.fields,
  result: Schema.Literals(["passed", "failed", "blocked"]),
  method: Schema.Literals(["browser", "command"]),
  steps: Text,
  observed: Text,
});
export type RevdocRecordTestInput = typeof RevdocRecordTestInput.Type;
export const RevdocCaptureInput = Schema.Struct({
  ...RevdocTestTarget.fields,
  caption: Text,
  tabId: Schema.optionalKey(PreviewTabId),
});
export type RevdocCaptureInput = typeof RevdocCaptureInput.Type;
export const RevdocDetail = Schema.Struct({
  cwd: Schema.String,
  revision: Schema.NullOr(Schema.String),
  review: Schema.NullOr(RevdocReview),
  currentSourceRevision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  staleTestIds: Schema.optionalKey(Schema.Array(Id)),
});
export type RevdocDetail = typeof RevdocDetail.Type;
export const RevdocRunState = Schema.Struct({
  running: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.Literals(["completed", "cancelled"])),
  version: Schema.Number,
  phase: Schema.optionalKey(Schema.Literals(["generating", "testing"])),
  testingThreadId: Schema.optionalKey(ThreadId),
  completed: Schema.optionalKey(Schema.Number),
  total: Schema.optionalKey(Schema.Number),
  activeTestId: Schema.optionalKey(Id),
});
export type RevdocRunState = typeof RevdocRunState.Type;
export const RevdocSaveInput = Schema.Struct({
  ...RevdocInput.fields,
  expectedRevision: Schema.String,
  change: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("test"), id: Id, outcome: RevdocOutcome, feedback: Text }),
    Schema.Struct({ kind: Schema.Literal("section"), id: Id, note: Text }),
    Schema.Struct({ kind: Schema.Literal("item"), id: Id, note: Text }),
    Schema.Struct({ kind: Schema.Literal("document"), note: Text }),
  ]),
});
export type RevdocSaveInput = typeof RevdocSaveInput.Type;
export class RevdocError extends Schema.TaggedError<RevdocError>()("RevdocError", {
  message: Schema.String,
}) {}
