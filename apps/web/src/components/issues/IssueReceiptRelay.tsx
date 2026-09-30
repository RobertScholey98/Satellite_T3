import { relayIssueReceipts } from "@t3tools/client-runtime/issues";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useMemo } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { issuesEnvironment } from "../../state/issues";
import { useAtomCommand } from "../../state/use-atom-command";

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

export function IssueReceiptRelay() {
  const { environments } = useEnvironments();
  const connectedKey = environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.issueBoards === true,
    )
    .map((environment) => environment.environmentId)
    .sort()
    .join("\n");
  const connected = useMemo(
    () => (connectedKey ? connectedKey.split("\n").map((id) => EnvironmentId.make(id)) : []),
    [connectedKey],
  );
  const list = useAtomCommand(issuesEnvironment.listReceipts, { reportFailure: false });
  const ingest = useAtomCommand(issuesEnvironment.ingestReceipts, { reportFailure: false });
  const acknowledge = useAtomCommand(issuesEnvironment.acknowledgeReceipts, {
    reportFailure: false,
  });
  const attempts = useAtomCommand(issuesEnvironment.listAttempts, { reportFailure: false });
  const syncGenerations = useAtomCommand(issuesEnvironment.syncAttemptGenerations, {
    reportFailure: false,
  });

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = async () => {
      await relayIssueReceipts(connected, {
        attempts: async (environmentId) => unwrap(await attempts({ environmentId, input: {} })),
        syncGenerations: async (environmentId, input) => {
          unwrap(await syncGenerations({ environmentId, input }));
        },
        list: async (environmentId, after) =>
          unwrap(await list({ environmentId, input: { after } })),
        ingest: async (environmentId, receipts) =>
          unwrap(await ingest({ environmentId, input: { receipts } })).acknowledgedKeys,
        acknowledge: async (environmentId, acknowledgedKeys) => {
          unwrap(await acknowledge({ environmentId, input: { acknowledgedKeys } }));
        },
      });
      if (!disposed)
        timer = setTimeout(() => {
          void sync();
        }, 15_000);
    };
    if (connected.length > 0) void sync();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [connected, list, ingest, acknowledge, attempts, syncGenerations]);
  return null;
}
