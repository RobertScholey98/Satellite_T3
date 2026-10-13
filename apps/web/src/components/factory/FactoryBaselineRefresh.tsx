import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, CommandId, type FactoryManager } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { factoryEnvironment, type FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

// Lets a human adopt the project's current committed controls as a manager's baseline.
export function FactoryBaselineRefresh({
  environment,
  manager,
}: {
  readonly environment: FactoryEnvironmentView;
  readonly manager: FactoryManager;
}) {
  const hasSettingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandId = useRef<CommandId | null>(null);
  const boundary = environment.data?.boundaries.find((entry) => entry.id === manager.boundaryId);
  if (manager.role !== "project" || !boundary) return null;
  const canRefresh = hasSettingsScope && environment.canOperate && environment.connected;
  const refresh = async () => {
    if (pending || !canRefresh) return;
    setPending(true);
    setError(null);
    commandId.current ??= CommandId.make(randomUUID());
    const result = await dispatch({
      environmentId: environment.environmentId,
      input: {
        command: {
          type: "manager.refresh-boundary",
          commandId: commandId.current,
          managerId: manager.id,
        },
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        typeof cause === "object" &&
          cause !== null &&
          "detail" in cause &&
          typeof cause.detail === "string"
          ? cause.detail
          : cause instanceof Error
            ? cause.message
            : "Could not refresh the control baseline. The current baseline is unchanged.",
      );
    } else commandId.current = null;
    setPending(false);
  };
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Control baseline</h3>
      <p className="break-words text-sm text-muted-foreground">
        Adopted from commit {boundary.sourceRevision}. New work is blocked when its starting files
        change a protected control from this baseline. After a reviewed rule change or dependency
        update is committed, refresh to adopt the project's current committed controls with the same
        permissions and checks. Work blocked on the old baseline is prepared again. To undo, revert
        the commit and refresh again.
      </p>
      {!canRefresh ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reconnect with settings and agent-operation permission to refresh the baseline.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        disabled={pending || !canRefresh}
        onClick={() => void refresh()}
      >
        {pending ? "Refreshing baseline..." : "Refresh control baseline"}
      </Button>
    </section>
  );
}
