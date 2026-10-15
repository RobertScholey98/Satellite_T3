import {
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../session-logic";
import type { ChatMessage } from "../types";
import { selectPromptHistoryMessages } from "./threadViewModel";

const timestamp = DateTime.makeUnsafe("2026-10-15T12:00:00.000Z");
const forkId = ThreadId.make("thread-fork");
const parentId = ThreadId.make("thread-parent");

function itemBase(id: string, threadId: ThreadId = forkId) {
  return {
    id: TurnItemId.make(`item-${id}`),
    threadId,
    runId: RunId.make("run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function userMessage(
  id: string,
  text: string,
  threadId: ThreadId = forkId,
): OrchestrationV2TurnItem {
  return {
    ...itemBase(id, threadId),
    type: "user_message",
    messageId: MessageId.make(id),
    inputIntent: "turn_start",
    text,
    createdBy: "user",
    creationSource: "web",
    attachments: [],
  };
}

function row(
  item: OrchestrationV2TurnItem,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
): OrchestrationV2ProjectedTurnItem {
  return { position: 0, visibility, sourceThreadId: item.threadId, sourceItemId: item.id, item };
}

function recall(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  optimisticMessages: ReadonlyArray<ChatMessage> = [],
): string[] {
  return selectPromptHistoryMessages(
    deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems, optimisticMessages }),
  ).map((message) => message.text);
}

describe("selectPromptHistoryMessages", () => {
  it("recalls the prompts a fork inherited from its parent", () => {
    expect(
      recall([
        row(userMessage("parent-prompt", "Plan the migration", parentId), "inherited"),
        row(userMessage("fork-prompt", "Now the rollback")),
      ]),
    ).toEqual(["Plan the migration", "Now the rollback"]);
  });

  it("leaves answers to the agent's questions out of recall", () => {
    const requestId = RuntimeRequestId.make("question");
    const question: OrchestrationV2TurnItem = {
      ...itemBase("question"),
      type: "user_input_request",
      requestId,
      questions: [],
      questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} },
    };
    expect(
      recall([
        row(userMessage("prompt", "Pick a theme")),
        row(question),
        row(userMessage(`async-answer:${requestId}`, "Which color?\nBlue")),
      ]),
    ).toEqual(["Pick a theme"]);
    expect(recall([row(userMessage(`async-answer:${requestId}`, "Which color?\nBlue"))])).toEqual(
      [],
    );
  });

  it("recalls a send before the server acknowledges it", () => {
    const pending: ChatMessage = {
      id: MessageId.make("optimistic"),
      role: "user",
      text: "Ship the fix",
      runId: null,
      createdAt: "2026-10-15T12:00:01.000Z",
      updatedAt: "2026-10-15T12:00:01.000Z",
      streaming: false,
    };
    expect(recall([row(userMessage("prompt", "Find the bug"))], [pending])).toEqual([
      "Find the bug",
      "Ship the fix",
    ]);
  });
});
