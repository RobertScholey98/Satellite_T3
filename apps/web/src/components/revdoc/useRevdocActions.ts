import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isRevdocError,
  type RevdocAction,
  type RevdocError,
  type RevdocTarget,
  type RevdocTestSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";

import { useRightPanelStore } from "~/rightPanelStore";
import { resolveRevdocWorktree, useRevdocWorktree } from "~/revdocWorktreeStore";
import { revdocEnvironment, useRevdocWorktrees } from "~/state/revdoc";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";

type CommandFailure = { readonly cause: Cause.Cause<unknown> };

/** The Revdoc error behind a failed command, when the server sent one. */
export function revdocFailure(result: CommandFailure): RevdocError | null {
  const error = squashAtomCommandFailure(result);
  return isRevdocError(error) ? error : null;
}

export function toastRevdocFailure(title: string, result: CommandFailure) {
  toastManager.add({
    type: "error",
    title,
    description: revdocFailure(result)?.message ?? "The Revdoc request failed.",
  });
}

/** The thread's Revdoc target: its own worktree unless the person picked another one. */
function useRevdocTarget(threadRef: ScopedThreadRef): RevdocTarget {
  const worktreePath = resolveRevdocWorktree(
    useRevdocWorktree(threadRef),
    useRevdocWorktrees(threadRef.environmentId, threadRef.threadId),
  );
  return { threadId: threadRef.threadId, ...(worktreePath ? { worktreePath } : {}) };
}

/** Pass controls for a thread's Revdoc target. */
export function useRevdocActions(threadRef: ScopedThreadRef) {
  const { environmentId } = threadRef;
  const target = useRevdocTarget(threadRef);
  const canOperate = useAtomValue(revdocEnvironment.generate.permissionAtom(environmentId));
  const generateCommand = useAtomCommand(revdocEnvironment.generate, { reportFailure: false });
  const testCommand = useAtomCommand(revdocEnvironment.test, { reportFailure: false });
  const cancelCommand = useAtomCommand(revdocEnvironment.cancel, { reportFailure: false });
  const refreshCommand = useAtomCommand(revdocEnvironment.refresh, { reportFailure: false });

  const openPanel = () => {
    useRightPanelStore.getState().open(threadRef, "revdoc");
  };

  const generate = async (action?: RevdocAction) => {
    openPanel();
    const result = await generateCommand({
      environmentId,
      input: { ...target, ...(action ? { action } : {}) },
    });
    if (result._tag === "Failure") toastRevdocFailure("Could not start Revdoc", result);
  };

  const test = async (selection: RevdocTestSelection, itemIds?: ReadonlyArray<string>) => {
    openPanel();
    const result = await testCommand({
      environmentId,
      input: { ...target, selection, ...(itemIds ? { itemIds } : {}) },
    });
    if (result._tag === "Failure") toastRevdocFailure("Could not start AI testing", result);
  };

  const cancel = async () => {
    const result = await cancelCommand({ environmentId, input: target });
    if (result._tag === "Failure") toastRevdocFailure("Could not cancel the pass", result);
  };

  const refresh = async () => {
    const result = await refreshCommand({ environmentId, input: target });
    if (result._tag === "Failure") toastRevdocFailure("Could not refresh the review", result);
  };

  return { target, canOperate, openPanel, generate, test, cancel, refresh };
}
