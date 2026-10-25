import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, FactoryProtectedPathAsk } from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { factoryEnvironment, factoryErrorMessage, unwrapFactoryResult } from "./factoryState";

// Asks waiting on the user come first, then what is allowed, then what was declined.
const STATE_ORDER: Record<FactoryProtectedPathAsk["state"], number> = {
  open: 0,
  allowed: 1,
  declined: 2,
};

/**
 * The protected files a team asked to edit, on its own card. The user allows or declines each ask
 * for this assignment only; an allowed ask can be revoked and a declined one allowed after all.
 */
export function FactoryProtectedPathAsks(props: {
  readonly environmentId: EnvironmentId;
  readonly assignmentId: string;
  readonly asks: ReadonlyArray<FactoryProtectedPathAsk>;
}) {
  const answerCommand = useAtomCommand(factoryEnvironment.answerProtectedPaths, {
    reportFailure: false,
  });
  const canAnswer = useAtomValue(
    factoryEnvironment.answerProtectedPaths.permissionAtom(props.environmentId),
  );
  const [pending, setPending] = useState<string | null>(null);
  if (props.asks.length === 0) return null;

  const answer = async (ask: FactoryProtectedPathAsk, reply: "allow" | "decline") => {
    setPending(ask.id);
    let failure: unknown = null;
    await answerCommand({
      environmentId: props.environmentId,
      input: {
        requestId: randomUUID(),
        assignmentId: props.assignmentId,
        askId: ask.id,
        answer: reply,
      },
    })
      .then(unwrapFactoryResult)
      .catch((error: unknown) => {
        failure = error;
      });
    setPending(null);
    const description = failure === null ? null : factoryErrorMessage(failure);
    if (description)
      toastManager.add({
        type: "error",
        title: reply === "allow" ? "Could not allow the files" : "Could not decline the files",
        description,
      });
  };
  const disabled = !canAnswer || pending !== null;
  const files = (ask: FactoryProtectedPathAsk) => ask.paths.join(", ");

  return (
    <ul
      aria-label="Protected files"
      className="m-0 flex list-none flex-col gap-2 border-t border-border/60 px-3.5 py-2.5"
    >
      {props.asks
        .toSorted((left, right) => STATE_ORDER[left.state] - STATE_ORDER[right.state])
        .map((ask) => (
          <li key={ask.id} className="flex flex-col gap-1.5">
            {ask.state === "open" ? (
              <>
                <p className="text-xs text-foreground/80">
                  Wants to edit protected files:{" "}
                  <span className="font-medium break-all">{files(ask)}</span>
                </p>
                {ask.reason === "" ? null : (
                  <p className="text-2xs text-muted-foreground">{ask.reason}</p>
                )}
              </>
            ) : (
              <p
                className={
                  ask.state === "allowed"
                    ? "text-xs text-foreground/80"
                    : "text-2xs text-muted-foreground"
                }
              >
                {ask.state === "allowed" ? "Allowed for this assignment" : "Declined"}:{" "}
                <span className="break-all">{files(ask)}</span>
              </p>
            )}
            <div className="flex gap-1.5">
              {ask.state === "allowed" ? null : (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={disabled}
                  aria-label={`Allow ${files(ask)}`}
                  onClick={() => void answer(ask, "allow")}
                >
                  Allow
                </Button>
              )}
              {ask.state === "declined" ? null : (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={disabled}
                  aria-label={`${ask.state === "allowed" ? "Revoke" : "Decline"} ${files(ask)}`}
                  onClick={() => void answer(ask, "decline")}
                >
                  {ask.state === "allowed" ? "Revoke" : "Decline"}
                </Button>
              )}
            </div>
          </li>
        ))}
    </ul>
  );
}
