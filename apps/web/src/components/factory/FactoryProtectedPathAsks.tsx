import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, FactoryProtectedPathAsk } from "@t3tools/contracts";
import { ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon } from "lucide-react";
import { useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
        .map((ask) => {
          // Every answer is the same outline control, so a reversal weighs what the first answer did.
          const allow = (
            <Button
              variant="outline"
              size="xs"
              disabled={disabled}
              aria-label={`Allow ${files(ask)}`}
              onClick={() => void answer(ask, "allow")}
            >
              Allow
            </Button>
          );
          const refuse = (label: string) => (
            <Button
              variant="outline"
              size="xs"
              disabled={disabled}
              aria-label={`${label} ${files(ask)}`}
              onClick={() => void answer(ask, "decline")}
            >
              {label}
            </Button>
          );
          return ask.state === "open" ? (
            <li key={ask.id} className="flex gap-2.5 px-2.5 py-1.5">
              <ShieldAlertIcon
                aria-hidden
                className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, "mt-0.5 text-info")}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground/80">
                  Wants to edit protected files
                </p>
                <ul className="m-0 list-none p-0">
                  {ask.paths.map((path) => (
                    <li key={path} className="truncate font-mono text-xs text-muted-foreground">
                      {path}
                    </li>
                  ))}
                </ul>
                {ask.reason === "" ? null : (
                  <p className="pt-0.5 text-xs text-muted-foreground">{ask.reason}</p>
                )}
                <div className="flex justify-end gap-1.5 pt-1.5">
                  {refuse("Decline")}
                  {allow}
                </div>
              </div>
            </li>
          ) : (
            <li key={ask.id} className="flex items-start gap-2.5 px-2.5 py-1.5">
              {ask.state === "allowed" ? (
                <ShieldCheckIcon
                  aria-hidden
                  className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, "mt-0.5 text-success")}
                />
              ) : (
                <ShieldXIcon aria-hidden className={`${THREAD_DETAILS_PANEL_ICON_CLASS} mt-0.5`} />
              )}
              <div className="min-w-0 flex-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <p className="truncate font-mono text-xs leading-5 text-foreground/80" />
                    }
                  >
                    {files(ask)}
                  </TooltipTrigger>
                  <TooltipPopup side="left">{files(ask)}</TooltipPopup>
                </Tooltip>
                <p className="text-xs text-muted-foreground">
                  {ask.state === "allowed" ? "Allowed" : "Declined"}
                </p>
              </div>
              <div className="flex shrink-0 self-center">
                {ask.state === "allowed" ? refuse("Revoke") : allow}
              </div>
            </li>
          );
        })}
    </ul>
  );
}
