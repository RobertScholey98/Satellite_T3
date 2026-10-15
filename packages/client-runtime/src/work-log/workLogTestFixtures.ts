import {
  RunId,
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
