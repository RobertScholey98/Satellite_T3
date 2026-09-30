import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type IssueLifecycleReceipt,
  type IssueAttempt,
} from "@t3tools/contracts";
import { relayIssueReceipts, type IssueReceiptTransport } from "./issues.ts";

const source = EnvironmentId.make("source");
const destination = EnvironmentId.make("destination");
const receipt: IssueLifecycleReceipt = {
  sourceGeneration: 0,
  eventKey: "first-send",
  kind: "started",
  createdAt: "2026-09-30T00:00:00Z",
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  worktreePath: "/work/feature",
  link: {
    attemptId: "attempt",
    reservationId: "reservation",
    sourceEnvironmentId: source,
    destinationEnvironmentId: destination,
    sourceProjectId: ProjectId.make("board-project"),
    boardId: "board",
    sourceGeneration: 0,
    issue: {
      hostKind: "github",
      host: "github.com",
      repository: "team/repo",
      id: "I_1",
      number: 1,
      url: "https://github.com/team/repo/issues/1",
    },
  },
};

describe("issue receipt relay", () => {
  it("retains disconnected work and acknowledges only after the source accepts it", async () => {
    const pending = new Map([[receipt.eventKey, receipt]]);
    const movements: string[] = [];
    const accepted = new Set<string>();
    let loseAcknowledgement = true;
    const transport: IssueReceiptTransport = {
      attempts: async () => [],
      syncGenerations: async () => {},
      list: async (environmentId, after) => ({
        receipts: environmentId === destination && after === 0 ? [...pending.values()] : [],
        nextCursor: 1,
      }),
      ingest: async (_environmentId: EnvironmentId, receipts: readonly IssueLifecycleReceipt[]) =>
        receipts.map((item) => {
          if (!accepted.has(item.eventKey)) movements.push(item.eventKey);
          accepted.add(item.eventKey);
          return item.eventKey;
        }),
      acknowledge: async (_environmentId: EnvironmentId, keys: readonly string[]) => {
        if (loseAcknowledgement) throw new Error("Destination disconnected");
        for (const key of keys) pending.delete(key);
      },
    };
    expect(await relayIssueReceipts([destination], transport)).toEqual([]);
    expect(movements).toEqual([]);
    expect(pending.size).toBe(1);
    expect(await relayIssueReceipts([source, destination], transport)).toHaveLength(1);
    expect(movements).toEqual(["first-send"]);
    expect(pending.size).toBe(1);
    loseAcknowledgement = false;
    expect(await relayIssueReceipts([source, destination], transport)).toEqual([]);
    expect(movements).toEqual(["first-send"]);
    expect(pending.size).toBe(0);
  });

  it("does not acknowledge unrelated keys or forward receipts attributed to another destination", async () => {
    const acknowledged: string[] = [];
    const received: string[] = [];
    await relayIssueReceipts([source, destination], {
      attempts: async () => [],
      syncGenerations: async () => {},
      list: async (environmentId, after) => ({
        receipts:
          environmentId === destination && after === 0
            ? [
                receipt,
                {
                  ...receipt,
                  eventKey: "wrong-destination",
                  link: { ...receipt.link, destinationEnvironmentId: source },
                },
              ]
            : [],
        nextCursor: 2,
      }),
      ingest: async (_environmentId, receipts) => {
        received.push(...receipts.map((item) => item.eventKey));
        return ["unrelated"];
      },
      acknowledge: async (_environmentId, keys) => {
        acknowledged.push(...keys);
      },
    });
    expect(received).toEqual(["first-send"]);
    expect(acknowledged).toEqual([]);
  });

  it("relays later connected work past a full page for an offline source", async () => {
    const offline = EnvironmentId.make("offline");
    const blocked = Array.from({ length: 100 }, (_, index) => ({
      ...receipt,
      eventKey: `offline-${index}`,
      link: { ...receipt.link, sourceEnvironmentId: offline },
    }));
    const received: string[] = [];
    const cursors: number[] = [];
    await relayIssueReceipts([source, destination], {
      attempts: async () => [],
      syncGenerations: async () => {},
      list: async (environmentId, after) => {
        if (environmentId !== destination) return { receipts: [], nextCursor: after };
        cursors.push(after);
        return after === 0
          ? { receipts: blocked, nextCursor: 100 }
          : after === 100
            ? { receipts: [receipt], nextCursor: 101 }
            : { receipts: [], nextCursor: after };
      },
      ingest: async (_environmentId, receipts) => {
        received.push(...receipts.map((item) => item.eventKey));
        return receipts.map((item) => item.eventKey);
      },
      acknowledge: async () => {},
    });
    expect(cursors).toEqual([0, 100, 101]);
    expect(received).toEqual(["first-send"]);
  });

  it("syncs authoritative source generations after ingest without rewriting old receipts", async () => {
    const offline = EnvironmentId.make("offline");
    const attempt: IssueAttempt = {
      link: receipt.link,
      projectId: receipt.projectId,
      threadId: receipt.threadId,
      worktreePath: receipt.worktreePath,
      status: "started",
      active: true,
      createdAt: receipt.createdAt,
      startedAt: receipt.createdAt,
      sourceGeneration: 4,
    };
    const order: string[] = [];
    const synchronized: { environmentId: EnvironmentId; generation: number; attemptId: string }[] =
      [];
    const errors = await relayIssueReceipts([source, destination], {
      list: async (environmentId, after) => ({
        receipts: environmentId === destination && after === 0 ? [receipt] : [],
        nextCursor: 1,
      }),
      ingest: async (environmentId, receipts) => {
        order.push(`ingest:${environmentId}:${receipts[0]?.link.sourceGeneration}`);
        return receipts.map((item) => item.eventKey);
      },
      acknowledge: async () => {},
      attempts: async (environmentId) =>
        environmentId === source
          ? [
              attempt,
              {
                ...attempt,
                link: { ...attempt.link, attemptId: "offline", destinationEnvironmentId: offline },
              },
            ]
          : [{ ...attempt, sourceGeneration: 99 }],
      syncGenerations: async (environmentId, input) => {
        order.push(`sync:${environmentId}`);
        synchronized.push(
          ...input.generations.map((generation) => ({
            environmentId,
            generation: generation.sourceGeneration,
            attemptId: generation.attemptId,
          })),
        );
      },
    });
    expect(errors).toEqual([]);
    expect(order).toEqual(["ingest:source:0", "sync:destination"]);
    expect(synchronized).toEqual([
      { environmentId: destination, generation: 4, attemptId: "attempt" },
    ]);
    expect(receipt.link.sourceGeneration).toBe(0);
  });
});
