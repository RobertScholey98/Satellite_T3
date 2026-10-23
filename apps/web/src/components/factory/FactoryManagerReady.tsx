import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  factoryEnvironment,
  factoryErrorMessage,
  unwrapFactoryResult,
  useFactoryManagers,
} from "./factoryState";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The empty state of a manager's thread primed from its approved onboarding: what it will do,
 * and the one action left before it picks up tickets on its own.
 */
export function FactoryManagerReady(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const { environmentId } = props;
  const manager = useFactoryManagers(environmentId)?.find(
    (entry) => props.threadId !== null && entry.threadId === props.threadId,
  );
  const canStart = useAtomValue(factoryEnvironment.startPickup.permissionAtom(environmentId));
  const startPickup = useAtomCommand(factoryEnvironment.startPickup, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = manager?.onboardingResult ?? null;
  if (manager === undefined || result === null) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    let failure: unknown = null;
    await startPickup({
      environmentId,
      input: { requestId: randomUUID(), managerId: manager.id },
    })
      .then(unwrapFactoryResult)
      .catch((cause: unknown) => {
        failure = cause;
      });
    setBusy(false);
    if (failure !== null) setError(factoryErrorMessage(failure));
  };

  // The approved result keeps column ids only; their titles live on the boards.
  const pickup = result.pickup.enabled
    ? `Pickup on · ${plural(result.pickup.columns.length, "Ready column", "Ready columns")}`
    : "Pickup off";
  return (
    <section className="mx-1 space-y-3 rounded-lg border bg-card p-4 text-sm">
      <div className="space-y-1">
        <h2 className="font-medium">Manager ready</h2>
        <p className="text-xs text-muted-foreground">
          {pickup} · {plural(result.rules.length, "project rule", "project rules")}
        </p>
      </div>
      {manager.state === "ready" ? (
        <Button size="sm" disabled={busy || !canStart} onClick={() => void start()}>
          Start picking up
        </Button>
      ) : result.pickup.enabled ? null : (
        <p>Let's get started</p>
      )}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
