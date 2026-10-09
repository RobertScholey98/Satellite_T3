import * as Schema from "effect/Schema";
import { RuntimeRequestId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
} from "./providerPolicy.ts";
import { UserInputQuestion } from "./providerRuntime.ts";

export const SatelliteQuestionRef = Schema.Struct({
  ...ScopedThreadRef.fields,
  kind: Schema.Literal("question"),
  requestId: RuntimeRequestId,
});
export const SatelliteApprovalRef = Schema.Struct({
  ...ScopedThreadRef.fields,
  kind: Schema.Literal("approval"),
  requestId: RuntimeRequestId,
});
export const SatelliteAttentionRef = Schema.Union([
  SatelliteQuestionRef,
  SatelliteApprovalRef,
  Schema.Struct({
    ...ScopedThreadRef.fields,
    kind: Schema.Literals(["error", "review"]),
    requestId: Schema.String,
  }),
]);
export type SatelliteAttentionRef = typeof SatelliteAttentionRef.Type;

export const SatelliteAnswer = Schema.Struct({
  selectedOptionValues: Schema.optionalKey(Schema.Array(Schema.String)),
  customAnswer: Schema.optionalKey(Schema.String),
  attachmentCount: Schema.optionalKey(NonNegativeInt),
  attachmentsBlocked: Schema.optionalKey(Schema.Boolean),
});
export const SatelliteAttentionSummary = Schema.Struct({
  ref: SatelliteAttentionRef,
  title: Schema.String,
  environmentName: Schema.String,
  label: Schema.String,
  preview: Schema.String,
  createdAt: Schema.String,
  available: Schema.Boolean,
  muted: Schema.Boolean,
});
export type SatelliteAttentionSummary = typeof SatelliteAttentionSummary.Type;

export const SatelliteAttentionEditor = Schema.Struct({
  ref: SatelliteAttentionRef,
  status: Schema.Literals(["loading", "ready", "unavailable", "resolved"]),
  delivery: Schema.Literals(["editing", "sending", "awaiting-resolution", "uncertain", "failed"]),
  message: Schema.optionalKey(Schema.String),
  answers: Schema.Record(Schema.String, SatelliteAnswer),
  questionIndex: NonNegativeInt,
  question: Schema.optionalKey(
    Schema.Struct({
      requestId: RuntimeRequestId,
      createdAt: Schema.String,
      questions: Schema.Array(
        Schema.Struct({
          ...UserInputQuestion.fields,
          id: Schema.String,
          header: Schema.String,
          question: Schema.String,
          options: Schema.Array(
            Schema.Struct({
              ...UserInputQuestion.fields.options.value.fields,
              label: Schema.String,
            }),
          ),
        }),
      ),
      dismissible: Schema.Boolean,
      responseCapability: Schema.optionalKey(Schema.Literals(["live", "message", "not_resumable"])),
      responseMode: Schema.optionalKey(Schema.Literal("message")),
    }),
  ),
  approval: Schema.optionalKey(
    Schema.Struct({
      requestId: RuntimeRequestId,
      requestKind: ProviderRequestKind,
      responseCapability: Schema.optionalKey(Schema.Literals(["live", "not_resumable"])),
      createdAt: Schema.String,
      detail: Schema.optionalKey(Schema.String),
      appName: Schema.optionalKey(Schema.String),
      options: Schema.optionalKey(Schema.Array(ProviderApprovalOption)),
    }),
  ),
});
export type SatelliteAttentionEditor = typeof SatelliteAttentionEditor.Type;

export const SatelliteAttentionView = Schema.Struct({
  items: Schema.Array(SatelliteAttentionSummary),
  selected: Schema.NullOr(SatelliteAttentionEditor),
  incompleteEnvironments: Schema.Array(Schema.String),
  workingCount: NonNegativeInt,
  completedCount: NonNegativeInt,
});
export type SatelliteAttentionView = typeof SatelliteAttentionView.Type;

export const SatelliteAttentionIntent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["select", "mute", "restore", "open-thread", "check-status"]),
    ref: SatelliteAttentionRef,
  }),
  Schema.Struct({
    type: Schema.Literal("answer"),
    ref: SatelliteQuestionRef,
    questionId: Schema.String,
    answer: SatelliteAnswer,
  }),
  Schema.Struct({
    type: Schema.Literal("question-index"),
    ref: SatelliteQuestionRef,
    index: NonNegativeInt,
  }),
  Schema.Struct({ type: Schema.Literals(["submit", "dismiss"]), ref: SatelliteQuestionRef }),
  Schema.Struct({ type: Schema.Literal("advance"), ref: SatelliteQuestionRef }),
  Schema.Struct({
    type: Schema.Literal("toggle-option"),
    ref: SatelliteQuestionRef,
    questionId: Schema.String,
    optionValue: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("approve"),
    ref: SatelliteApprovalRef,
    decision: ProviderApprovalDecision,
  }),
  Schema.Struct({
    type: Schema.Literal("retry-delivery"),
    ref: Schema.Union([SatelliteQuestionRef, SatelliteApprovalRef]),
  }),
]);
export type SatelliteAttentionIntent = typeof SatelliteAttentionIntent.Type;

export const SatellitePillLayoutRequest = Schema.Struct({
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  mode: Schema.Literals(["compact", "preview", "panel"]),
  wing: Schema.Boolean,
});
export type SatellitePillLayoutRequest = typeof SatellitePillLayoutRequest.Type;
const SatellitePillRectangle = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export const SatellitePillLayout = Schema.Struct({
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  mode: Schema.Literals(["compact", "preview", "panel"]),
  width: Schema.Number,
  height: Schema.Number,
  pill: SatellitePillRectangle,
  wing: Schema.NullOr(SatellitePillRectangle),
  panel: Schema.NullOr(SatellitePillRectangle),
});
export type SatellitePillLayout = typeof SatellitePillLayout.Type;

/** Resolved workspace colors, shared with the isolated pill renderer. */
export const SatellitePillTheme = Schema.Struct({
  "--background": Schema.String,
  "--foreground": Schema.String,
  "--muted-foreground": Schema.String,
  "--border": Schema.String,
  "--primary": Schema.String,
  "--ring": Schema.String,
  "--warning": Schema.String,
  "--success": Schema.String,
  "--destructive": Schema.String,
  "--font-sans": Schema.String,
  "--card": Schema.optionalKey(Schema.String),
  "--card-foreground": Schema.optionalKey(Schema.String),
  "--popover": Schema.optionalKey(Schema.String),
  "--popover-foreground": Schema.optionalKey(Schema.String),
  "--muted": Schema.optionalKey(Schema.String),
  "--secondary": Schema.optionalKey(Schema.String),
  "--secondary-foreground": Schema.optionalKey(Schema.String),
  "--accent": Schema.optionalKey(Schema.String),
  "--accent-foreground": Schema.optionalKey(Schema.String),
  "--primary-foreground": Schema.optionalKey(Schema.String),
  "--input": Schema.optionalKey(Schema.String),
});
export type SatellitePillTheme = typeof SatellitePillTheme.Type;

/** A view of the selected conversation; the renderer owns its source of truth. */
export const SatellitePillState = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  title: Schema.String,
  state: Schema.Literals(["working", "awaiting-input", "completed", "idle", "unknown", "error"]),
  detail: Schema.String,
  attention: Schema.Boolean,
  theme: Schema.optionalKey(SatellitePillTheme),
  dark: Schema.optionalKey(Schema.Boolean),
  actionWing: Schema.optionalKey(SatelliteAttentionView),
});
export type SatellitePillState = typeof SatellitePillState.Type;

/** The retained workspace and native pill have independent window geometry. */
export interface SatelliteShellState {
  readonly mode: "pill" | "workspace";
  readonly pinned?: boolean;
  readonly positionsLinked?: boolean;
}

export type SatelliteMoveDirection = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export interface SatelliteBridge {
  readonly publish: (state: SatellitePillState) => void;
  readonly hideMain: () => void;
  readonly setPinned: (pinned: boolean) => void;
  readonly setPositionsLinked: (linked: boolean) => void;
  readonly onShellState: (listener: (state: SatelliteShellState) => void) => () => void;
  readonly onAttentionIntent: (listener: (intent: SatelliteAttentionIntent) => void) => () => void;
  readonly openMain: () => void;
}

/** Only the standalone pill renderer receives these capabilities. */
export interface SatellitePillBridge {
  readonly onOpacityChange: (listener: (opacity: number) => void) => () => void;
  readonly openMain: () => void;
  readonly movePill: (direction: SatelliteMoveDirection) => void;
  readonly beginPillDrag: () => void;
  readonly onPillState: (listener: (state: SatellitePillState) => void) => () => void;
  readonly dispatchIntent: (intent: SatelliteAttentionIntent) => void;
  readonly setLayout: (request: SatellitePillLayoutRequest) => void;
  readonly onLayout: (listener: (layout: SatellitePillLayout) => void) => () => void;
}
