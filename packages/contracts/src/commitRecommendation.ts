import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

const CommitRecommendationLevel = Schema.Literals(["recommended", "overdue"]);

export const CommitRecommendation = Schema.Struct({
  level: CommitRecommendationLevel,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  cwd: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  headCommit: Schema.NullOr(TrimmedNonEmptyString),
  assessedAt: IsoDateTime,
});
export type CommitRecommendation = typeof CommitRecommendation.Type;

export const SetCommitRecommendationInput = Schema.Struct({
  level: Schema.Literals(["none", "recommended", "overdue"]),
  reason: Schema.optional(CommitRecommendation.fields.reason),
}).check(
  Schema.makeFilter(
    (input) =>
      input.level === "none" || input.reason !== undefined || "A recommendation requires a reason.",
  ),
);
export type SetCommitRecommendationInput = typeof SetCommitRecommendationInput.Type;
