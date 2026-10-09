import {
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { derivePendingRequests, threadRequestActivities } from "./pendingRequests.ts";
import { v2Now, v2Projection } from "./state/orchestrationV2TestFixtures.ts";

const requestId = RuntimeRequestId.make("satellite-question");
const nodeId = NodeId.make("satellite-question-node");
const projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> = {
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("satellite-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      questions: [
        {
          id: " next ",
          header: "Next",
          question: "Which step?",
          required: false,
          allowCustomAnswer: false,
          options: [{ label: " Continue ", value: " continue ", description: "Resume work" }],
        },
      ],
    },
  ],
};

describe("V2 request delivery evidence", () => {
  it("preserves asynchronous question capabilities and native answer keys", () => {
    expect(derivePendingRequests(threadRequestActivities(projection)).userInputs).toEqual([
      {
        requestId,
        createdAt: "2026-06-20T00:00:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: " next ",
            header: "Next",
            question: "Which step?",
            required: false,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: " Continue ", value: " continue ", description: "Resume work" }],
          },
        ],
      },
    ]);
  });

  it.each(["resolved", "cancelled", "expired"] as const)(
    "closes a %s request even when evidence arrives out of order",
    (status) => {
      const evidence = threadRequestActivities({
        ...projection,
        runtimeRequests: projection.runtimeRequests.map((request) => ({
          ...request,
          status,
          resolvedAt: v2Now,
        })),
      });
      expect(derivePendingRequests(evidence.toReversed()).userInputs).toEqual([]);
    },
  );

  it("keeps unavailable questions visible without enabling a provider response", () => {
    const evidence = threadRequestActivities({
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: { type: "not_resumable", reason: "Provider session ended" },
      })),
    });
    expect(derivePendingRequests(evidence).userInputs[0]?.responseCapability).toBe("not_resumable");
  });
});
