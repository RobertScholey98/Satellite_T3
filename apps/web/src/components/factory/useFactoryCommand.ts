import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type FactoryCommand } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { factoryEnvironment, type FactoryEnvironmentView } from "../../state/factory";
import { useAtomCommand } from "../../state/use-atom-command";

type FactoryInput = FactoryCommand extends infer Command
  ? Command extends FactoryCommand
    ? Omit<Command, "commandId">
    : never
  : never;

export function useFactoryCommand(environment: FactoryEnvironmentView, allowed = true) {
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submissions = useRef(new Map<string, CommandId>());
  const syncing = revision > (environment.data?.revision ?? 0);
  const disabled =
    pending || syncing || !allowed || !environment.connected || !environment.canOperate;
  const submit = async (input: FactoryInput) => {
    if (disabled || inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const content = JSON.stringify(input);
    const commandId = submissions.current.get(content) ?? CommandId.make(randomUUID());
    submissions.current.set(content, commandId);
    try {
      const result = await dispatch({
        environmentId: environment.environmentId,
        input: { command: { ...input, commandId } },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error ? cause.message : "Could not save this decision. Try again.",
        );
        return false;
      }
      submissions.current.delete(content);
      setRevision(result.value.revision);
      return true;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { submit, disabled, pending: pending || syncing, error };
}
