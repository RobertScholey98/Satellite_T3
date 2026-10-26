import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, FactoryProtectedPathAsk } from "@t3tools/contracts";
import { ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
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
    <ul aria-label="Protected files" className="m-0 flex list-none flex-col">
      {props.asks
        .toSorted((left, right) => STATE_ORDER[left.state] - STATE_ORDER[right.state])
        .map((ask) =>
          ask.state === "open" ? (
            <li key={ask.id} className="flex gap-2.5 px-2.5 py-1.5">
              <ShieldAlertIcon
                aria-hidden
                className={`${THREAD_DETAILS_PANEL_ICON_CLASS} mt-px text-warning`}
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium text-foreground/80">
                  Wants to edit protected files
                </p>
                <p className="text-xs break-words text-foreground/80">{files(ask)}</p>
                {ask.reason === "" ? null : (
                  <p className="text-xs text-muted-foreground">{ask.reason}</p>
                )}
                <div className="flex gap-1.5 pt-1">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={disabled}
                    aria-label={`Allow ${files(ask)}`}
                    onClick={() => void answer(ask, "allow")}
                  >
                    Allow
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={disabled}
                    aria-label={`Decline ${files(ask)}`}
                    onClick={() => void answer(ask, "decline")}
                  >
                    Decline
                  </Button>
                </div>
              </div>
            </li>
          ) : (
            <li key={ask.id} className="flex items-center gap-2.5 px-2.5 py-1">
              {ask.state === "allowed" ? (
                <ShieldCheckIcon
                  aria-hidden
                  className={`${THREAD_DETAILS_PANEL_ICON_CLASS} text-success`}
                />
              ) : (
                <ShieldXIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              )}
              <p className="min-w-0 flex-1 text-xs break-words text-muted-foreground">
                {ask.state === "allowed" ? "Allowed" : "Declined"}: {files(ask)}
              </p>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled}
                aria-label={`${ask.state === "allowed" ? "Revoke" : "Allow"} ${files(ask)}`}
                onClick={() => void answer(ask, ask.state === "allowed" ? "decline" : "allow")}
              >
                {ask.state === "allowed" ? "Revoke" : "Allow"}
              </Button>
            </li>
          ),
        )}
    </ul>
  );
}
