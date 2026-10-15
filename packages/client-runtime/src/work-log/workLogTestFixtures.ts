import {
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const fixtureThreadId = ThreadId.make("thread-1");
const fixtureRunId = RunId.make("run-1");
export const fixtureTime = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");

export function turnItemBase(id: string, ordinal = 0) {
  return {
    id: TurnItemId.make(id),
    threadId: fixtureThreadId,
    runId: fixtureRunId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: fixtureTime,
    completedAt: fixtureTime,
    updatedAt: fixtureTime,
  };
}

export function projectedTurnItem(
  item: OrchestrationV2TurnItem,
  position = item.ordinal,
): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}

const requestKinds = [
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
] as const;
const proceedQuestion = {
  id: "proceed",
  header: "Proceed",
  question: "Proceed?",
  options: [{ label: "Yes", description: "Go ahead" }],
};
const proceedAnswer = {
  requestId: "request-answered",
  questionTextById: { proceed: "Proceed?" },
  answers: { proceed: "Yes" },
  attachmentsByQuestionId: {},
};

/** One item of each shape whose rows differ between clients or changed when they began sharing a mapper. */
const workLogScenarioItems: ReadonlyArray<OrchestrationV2TurnItem> = [
  { ...turnItemBase("edit-one"), type: "file_change" as const, fileName: "src/a.ts" },
  {
    ...turnItemBase("edit-many"),
    type: "file_change" as const,
    fileName: "src/a.ts",
    changes: [
      { path: "src/a.ts", operation: "update" },
      { path: "src/b.ts", operation: "add" },
      { path: "src/c.ts", operation: "delete" },
    ],
  },
  ...requestKinds.flatMap((requestKind) => [
    {
      ...turnItemBase(`approve-${requestKind}`),
      type: "approval_request" as const,
      requestId: RuntimeRequestId.make(`request-${requestKind}`),
      requestKind,
    },
    {
      ...turnItemBase(`approve-${requestKind}-prompt`),
      type: "approval_request" as const,
      requestId: RuntimeRequestId.make(`request-${requestKind}-prompt`),
      requestKind,
      prompt: `Allow ${requestKind}?`,
    },
  ]),
  {
    ...turnItemBase("question"),
    status: "waiting" as const,
    type: "user_input_request" as const,
    requestId: RuntimeRequestId.make("request-question"),
    questions: [proceedQuestion],
  },
  {
    ...turnItemBase("question-titled"),
    status: "waiting" as const,
    title: "Plan questions",
    type: "user_input_request" as const,
    requestId: RuntimeRequestId.make("request-question-titled"),
    questions: [proceedQuestion],
  },
  {
    ...turnItemBase("question-answered"),
    type: "user_input_request" as const,
    requestId: RuntimeRequestId.make("request-answered"),
    questions: [proceedQuestion],
    questionAnswer: proceedAnswer,
  },
  {
    ...turnItemBase("question-answered-titled"),
    title: "Plan questions",
    type: "user_input_request" as const,
    requestId: RuntimeRequestId.make("request-answered"),
    questions: [proceedQuestion],
    questionAnswer: proceedAnswer,
  },
  {
    ...turnItemBase("thread-created"),
    type: "thread_created" as const,
    targetThreadId: ThreadId.make("thread-child"),
    targetRunId: null,
    targetProviderInstanceId: ProviderInstanceId.make("codex"),
    targetModel: "gpt-5",
  },
  {
    ...turnItemBase("provider-retry"),
    status: "running" as const,
    type: "error" as const,
    failure: { class: "provider_error", message: "Overloaded", code: null, retryable: true },
    retry: { attempt: 2, maxAttempts: 5, retryDelayMs: 1_500 },
  },
  {
    ...turnItemBase("command-ok"),
    type: "command_execution" as const,
    input: "vp check",
    exitCode: 0,
  },
  {
    ...turnItemBase("command-exit-1"),
    type: "command_execution" as const,
    input: "vp test",
    exitCode: 1,
  },
  { ...turnItemBase("command-no-exit"), type: "command_execution" as const, input: "ls" },
];

export const workLogScenario = workLogScenarioItems.map((item, position) =>
  projectedTurnItem(item, position),
);
