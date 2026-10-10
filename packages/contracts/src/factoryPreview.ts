import * as Schema from "effect/Schema";
import { CommandId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PreviewAutomationClickInput,
  PreviewAutomationTypeInput,
  PreviewAutomationPressInput,
  PreviewAutomationSelectInput,
  PreviewAutomationScrollInput,
} from "./previewAutomation.ts";

const ownedTab = Schema.makeFilter(
  (input: { readonly tabId?: unknown }) =>
    input.tabId === undefined ||
    "Factory verification uses its own isolated candidate tab; do not supply a tab ID.",
);
export const FactoryPreviewAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("navigate"), path: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("snapshot") }),
  Schema.Struct({
    type: Schema.Literal("click"),
    input: PreviewAutomationClickInput.check(ownedTab),
  }),
  Schema.Struct({
    type: Schema.Literal("type"),
    input: PreviewAutomationTypeInput.check(ownedTab),
  }),
  Schema.Struct({
    type: Schema.Literal("press"),
    input: PreviewAutomationPressInput.check(ownedTab),
  }),
  Schema.Struct({
    type: Schema.Literal("select"),
    input: PreviewAutomationSelectInput.check(ownedTab),
  }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    input: PreviewAutomationScrollInput.check(ownedTab),
  }),
]);
export type FactoryPreviewAction = typeof FactoryPreviewAction.Type;
export const FactoryPreviewActionInput = Schema.Struct({
  commandId: CommandId,
  instanceId: TrimmedNonEmptyString,
  journey: TrimmedNonEmptyString,
  action: FactoryPreviewAction,
});
export type FactoryPreviewActionInput = typeof FactoryPreviewActionInput.Type;
export const FactoryPreviewActionResult = Schema.Struct({
  sequence: NonNegativeInt,
  receiptDigest: TrimmedNonEmptyString,
  result: Schema.Unknown,
});
export type FactoryPreviewActionResult = typeof FactoryPreviewActionResult.Type;
export const FactoryPreviewFinishInput = Schema.Struct({
  commandId: CommandId,
  instanceId: TrimmedNonEmptyString,
  journeys: Schema.Array(TrimmedNonEmptyString),
});
export type FactoryPreviewFinishInput = typeof FactoryPreviewFinishInput.Type;
