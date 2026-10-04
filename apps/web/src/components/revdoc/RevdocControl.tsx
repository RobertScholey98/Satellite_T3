import type { ScopedThreadRef } from "@t3tools/contracts";
import { BookOpenCheckIcon, ChevronDownIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { revdocEnvironment } from "~/state/revdoc";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

export function RevdocControl({
  threadRef,
  worktreePath,
  presentation,
  onOpen,
  notifyCompletion = true,
}: {
  threadRef: ScopedThreadRef;
  worktreePath: string;
  presentation: "toolbar" | "menu";
  onOpen?: () => void;
  notifyCompletion?: boolean;
}) {
  const target = {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, worktreePath },
  };
  const state = useEnvironmentQuery(revdocEnvironment.changes(target));
  const start = useAtomCommand(revdocEnvironment.start, { reportFailure: false });
  const cancel = useAtomCommand(revdocEnvironment.cancel, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  const previousRunning = useRef(false);
  const running = state.data?.running ?? false;
  const open = () => {
    useRightPanelStore.getState().open(threadRef, "revdoc");
    onOpen?.();
  };
  useEffect(() => {
    if (notifyCompletion && previousRunning.current && !running && state.data) {
      toastManager.add(
        state.data.error
          ? { type: "error", title: "Revdoc pass failed", description: state.data.error }
          : state.data.result === "cancelled"
            ? { type: "info", title: "Revdoc pass cancelled" }
            : {
                type: "info",
                title: "Revdoc pass finished",
                description: "Open the worktree review from the Revdoc menu.",
              },
      );
    }
    previousRunning.current = running;
  }, [notifyCompletion, running, state.data]);
  const run = async (action?: "generate" | "generate-and-test") => {
    if (pending.current || running) return;
    pending.current = true;
    setStarting(true);
    if (action !== "generate") open();
    const result = await start({
      ...target,
      input: { ...target.input, ...(action ? { action } : {}) },
    });
    pending.current = false;
    setStarting(false);
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not start Revdoc",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const cancelPass = async () => {
    const result = await cancel(target);
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not cancel Revdoc",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const items = (
    <>
      <MenuItem onClick={open}>
        <BookOpenCheckIcon />
        Open worktree review
      </MenuItem>
      <MenuItem
        disabled={starting || running || !state.isSuccess}
        onClick={() => void run("generate-and-test")}
      >
        Generate &amp; test
      </MenuItem>
      <MenuItem
        disabled={starting || running || !state.isSuccess}
        onClick={() => void run("generate")}
      >
        Generate review only
      </MenuItem>
      {running && (
        <MenuItem onClick={() => void cancelPass()}>
          <SquareIcon />
          Cancel pass
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        render={
          <Link
            to="/settings/general"
            hash="revdoc-model"
            search={{ machine: threadRef.environmentId }}
          />
        }
      >
        Revdoc settings
      </MenuItem>
    </>
  );
  if (presentation === "menu")
    return (
      <>
        <MenuItem
          density="touch"
          disabled={starting || running || !state.isSuccess}
          onClick={() => void run()}
        >
          <BookOpenCheckIcon />
          {running || starting
            ? state.data?.phase === "testing"
              ? "Testing Revdoc…"
              : "Generating Revdoc…"
            : "Run Revdoc pass"}
        </MenuItem>
        {items}
      </>
    );
  return (
    <Group aria-label="Revdoc actions" className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              disabled={starting || !state.isSuccess}
              aria-label={running || starting ? "Revdoc pass running" : "Run Revdoc pass"}
              aria-busy={running || starting}
              onClick={() => (running ? open() : void run())}
            />
          }
        >
          <BookOpenCheckIcon aria-hidden />
          <span
            className={
              running || starting
                ? "ml-0.5"
                : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"
            }
          >
            {running || starting
              ? state.data?.phase === "testing"
                ? "Testing…"
                : "Generating…"
              : "Revdoc"}
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {state.error ?? "Run this worktree’s Revdoc pass using your configured default"}
        </TooltipPopup>
      </Tooltip>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" variant="outline" aria-label="Revdoc options" />}
        >
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">{items}</MenuPopup>
      </Menu>
    </Group>
  );
}
