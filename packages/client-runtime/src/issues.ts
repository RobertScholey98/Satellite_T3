import {
  WS_METHODS,
  type EnvironmentId,
  type IssueLifecycleReceipt,
  type IssueAttempt,
  type IssueAttemptsSyncGenerationsInput,
  type IssueAttemptsReceiptsResult,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "./connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./state/runtime.ts";

export function createIssuesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "issues:list",
      tag: WS_METHODS.issuesList,
    }),
    get: createEnvironmentRpcCommand(runtime, { label: "issues:get", tag: WS_METHODS.issuesGet }),
    listBoards: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:list",
      tag: WS_METHODS.issuesBoardsList,
    }),
    openBoard: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:open",
      tag: WS_METHODS.issuesBoardsOpen,
    }),
    boardSync: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:issues:board-sync",
      tag: WS_METHODS.issuesBoardsSubscribe,
    }),
    configureBoard: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:configure",
      tag: WS_METHODS.issuesBoardsConfigure,
    }),
    disconnectBoard: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:disconnect",
      tag: WS_METHODS.issuesBoardsDisconnect,
    }),
    retryMove: createEnvironmentRpcCommand(runtime, {
      label: "issues:moves:retry",
      tag: WS_METHODS.issuesMovesRetry,
    }),
    move: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:move",
      tag: WS_METHODS.issuesBoardsMove,
    }),
    reserveAttempt: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:reserve",
      tag: WS_METHODS.issuesAttemptsReserve,
    }),
    listAttempts: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:list",
      tag: WS_METHODS.issuesAttemptsList,
    }),
    listReceipts: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:receipts",
      tag: WS_METHODS.issuesAttemptsReceipts,
    }),
    ingestReceipts: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:ingest",
      tag: WS_METHODS.issuesAttemptsIngest,
    }),
    syncAttemptGenerations: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:syncGenerations",
      tag: WS_METHODS.issuesAttemptsSyncGenerations,
    }),
    acknowledgeReceipts: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:acknowledge",
      tag: WS_METHODS.issuesAttemptsAcknowledge,
    }),
  };
}

export interface IssueReceiptTransport {
  readonly list: (
    environmentId: EnvironmentId,
    after: number,
  ) => Promise<IssueAttemptsReceiptsResult>;
  readonly ingest: (
    environmentId: EnvironmentId,
    receipts: readonly IssueLifecycleReceipt[],
  ) => Promise<readonly string[]>;
  readonly acknowledge: (environmentId: EnvironmentId, keys: readonly string[]) => Promise<void>;
  readonly attempts: (environmentId: EnvironmentId) => Promise<readonly IssueAttempt[]>;
  readonly syncGenerations: (
    environmentId: EnvironmentId,
    input: IssueAttemptsSyncGenerationsInput,
  ) => Promise<void>;
}

export async function relayIssueReceipts(
  environments: readonly EnvironmentId[],
  transport: IssueReceiptTransport,
) {
  const connected = new Set(environments);
  const failures: { environmentId: EnvironmentId; error: unknown }[] = [];
  for (const destination of environments) {
    try {
      let after = 0;
      while (true) {
        const page = await transport.list(destination, after);
        const receipts = page.receipts;
        const bySource = new Map<EnvironmentId, IssueLifecycleReceipt[]>();
        for (const receipt of receipts) {
          if (receipt.link.destinationEnvironmentId !== destination) continue;
          const source = receipt.link.sourceEnvironmentId;
          if (!connected.has(source)) continue;
          const batch = bySource.get(source) ?? [];
          batch.push(receipt);
          bySource.set(source, batch);
        }
        for (const [source, receipts] of bySource) {
          try {
            for (let offset = 0; offset < receipts.length; offset += 100) {
              const batch = receipts.slice(offset, offset + 100);
              const accepted = new Set(await transport.ingest(source, batch));
              const acknowledged = batch
                .filter((receipt) => accepted.has(receipt.eventKey))
                .map((receipt) => receipt.eventKey);
              if (acknowledged.length > 0) await transport.acknowledge(destination, acknowledged);
            }
          } catch (error) {
            failures.push({ environmentId: source, error });
          }
        }
        if (receipts.length === 0 || page.nextCursor <= after) break;
        after = page.nextCursor;
      }
    } catch (error) {
      failures.push({ environmentId: destination, error });
    }
  }
  for (const source of environments) {
    try {
      const attempts = await transport.attempts(source);
      const byDestination = new Map<
        EnvironmentId,
        IssueAttemptsSyncGenerationsInput["generations"][number][]
      >();
      for (const attempt of attempts) {
        const destination = attempt.link.destinationEnvironmentId;
        if (
          attempt.link.sourceEnvironmentId !== source ||
          destination === source ||
          !connected.has(destination)
        )
          continue;
        const batch = byDestination.get(destination) ?? [];
        batch.push({
          attemptId: attempt.link.attemptId,
          reservationId: attempt.link.reservationId,
          sourceGeneration: attempt.sourceGeneration,
        });
        byDestination.set(destination, batch);
      }
      for (const [destination, generations] of byDestination) {
        try {
          for (let offset = 0; offset < generations.length; offset += 100) {
            await transport.syncGenerations(destination, {
              generations: generations.slice(offset, offset + 100),
            });
          }
        } catch (error) {
          failures.push({ environmentId: destination, error });
        }
      }
    } catch (error) {
      failures.push({ environmentId: source, error });
    }
  }
  return failures;
}
