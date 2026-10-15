import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuItem,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

import { resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
  type ThreadActionMenuState,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentScope } from "../state/session";
import {
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsTitleRegeneration,
  readProject,
  readThreadShell,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readLocalApi } from "../localApi";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * What a surface contributes to the shared thread actions. Everything else
 * (labels, availability, the mutation, failure toasts) is the module's.
 */
export interface ThreadActionSurface {
  /** Opens this surface's inline title editor. Committing goes through `renameThread`. */
  readonly startRename: (threadRef: ScopedThreadRef) => void;
  /**
   * The sidebar parks a thread and moves the reader to the next card; other
   * surfaces leave settle and snooze to the module, which stays put.
   */
  readonly settle?: (threadRef: ScopedThreadRef) => void;
  readonly snooze?: (threadRef: ScopedThreadRef, snoozedUntil: string) => void;
  /** Replaces the module's navigation, for sidebars that close their mobile sheet first. */
  readonly openProjectSettings?: (threadRef: ScopedThreadRef) => void;
  /** Only a surface with a project-scoped thread list offers "Filter by project". */
  readonly projectFilter?: {
    readonly read: (threadRef: ScopedThreadRef) => ThreadActionMenuState["projectFilter"];
    readonly toggle: (threadRef: ScopedThreadRef) => void;
  };
}

/** Snapshot of everything the thread action registry decides availability from. */
export function readThreadActionMenuState(
  threadRef: ScopedThreadRef,
  options: {
    readonly now: Date;
    readonly timestampFormat: TimestampFormat;
    readonly projectFilter?: ThreadActionMenuState["projectFilter"];
  },
): ThreadActionMenuState | null {
  const thread = readThreadShell(threadRef);
  if (!thread) return null;
  const now = options.now.toISOString();
  const supports = {
    settlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
    autoSettleOptOut: readEnvironmentSupportsAutoSettleOptOut(threadRef.environmentId),
    snooze: readEnvironmentSupportsSnooze(threadRef.environmentId),
    pinning: readEnvironmentSupportsPinning(threadRef.environmentId),
    titleRegeneration: readEnvironmentSupportsTitleRegeneration(threadRef.environmentId),
  };
  return {
    canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
    branch: thread.branch ?? null,
    projectFilter: options.projectFilter ?? null,
    isPinned: thread.pinnedAt != null,
    isSettled: supports.settlement && thread.settledOverride === "settled",
    autoSettleEnabled: thread.autoSettleDisabledAt == null,
    isSnoozed: supports.snooze && effectiveSnoozed(thread, { now }),
    canSnoozeNow: canSnooze(thread, { now }),
    isRegeneratingTitle: thread.titleRegeneration != null,
    isRunning: !threadRuntimeCanArchive(thread.runtime),
    supports,
    snoozePresets: resolveSnoozePresets(options.now, options.timestampFormat),
  };
}

const THREAD_RENAME_REQUEST_EVENT = "t3code:thread-rename-request";

/** Asks whichever surface shows this thread's title editor to open it. */
export function requestThreadRename(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  const dispatch = () =>
    window.dispatchEvent(
      new CustomEvent<string>(THREAD_RENAME_REQUEST_EVENT, { detail: threadKey }),
    );
  // The palette hands focus back to the composer as it closes. Opening the
  // title editor before that would blur it straight into a no-op commit.
  const afterPaletteCloses = () =>
    requestAnimationFrame(isCommandPaletteOpen() ? afterPaletteCloses : dispatch);
  afterPaletteCloses();
}

/** Opens `startRename` when another surface (the command palette) asks to rename this thread. */
export function useThreadRenameRequest(
  threadRef: ScopedThreadRef | null,
  startRename: () => void,
): void {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  useEffect(() => {
    if (threadKey === null) return;
    const handler = (event: Event) => {
      if ((event as CustomEvent<string>).detail === threadKey) startRename();
    };
    window.addEventListener(THREAD_RENAME_REQUEST_EVENT, handler);
    return () => window.removeEventListener(THREAD_RENAME_REQUEST_EVENT, handler);
  }, [startRename, threadKey]);
}

/**
 * The per-thread action registry's dispatcher: every surface that offers
 * thread actions (context menus, the command palette, keybindings) lists them
 * from `buildThreadActionMenuItems` and runs them here.
 *
 * Unless the surface parks threads itself, settle and snooze never navigate
 * away: the caller is acting on the thread they are reading, and ChatView's
 * parked-thread banner already offers the way back.
 */
export function useThreadActionMenu({
  startRename,
  settle,
  snooze,
  openProjectSettings,
  projectFilter,
}: ThreadActionSurface) {
  const router = useRouter();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectKeyByPhysicalKey = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    archiveThread,
    deleteThread,
    markThreadUnread,
    renameThread,
    regenerateThreadTitle,
  } = useThreadActions();
  const handleNewThread = useNewThreadHandler();
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "Branch copied", description: branch });
    },
    onError: (error) => failureToast("Failed to copy branch", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "Thread ID copied", description: threadId });
    },
    onError: (error) => failureToast("Failed to copy thread ID", error),
  });

  const readMenuItems = useCallback(
    (threadRef: ScopedThreadRef): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> => {
      const state = readThreadActionMenuState(threadRef, {
        now: new Date(),
        timestampFormat,
        projectFilter: projectFilter?.read(threadRef) ?? null,
      });
      return state ? buildThreadActionMenuItems(state) : [];
    },
    [projectFilter, timestampFormat],
  );

  const runAction = useCallback(
    async (threadRef: ScopedThreadRef, action: ThreadActionMenuId): Promise<void> => {
      const api = readLocalApi();
      const thread = readThreadShell(threadRef);
      if (!thread) return;
      if (
        threadActionRequiresOperate(action) &&
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
      ) {
        failureToast(
          "Thread action unavailable",
          new Error("This connection cannot change threads."),
        );
        return;
      }
      if (action.startsWith("snooze:")) {
        const preset =
          action === "snooze:custom"
            ? await requestCustomSnooze()
            : resolveSnoozePresets(new Date(), timestampFormat).find(
                (candidate) => `snooze:${candidate.id}` === action,
              );
        if (!preset) return;
        if (snooze) {
          snooze(threadRef, preset.snoozedUntil);
          return;
        }
        const result = await snoozeThread(threadRef, preset.snoozedUntil);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast("Failed to snooze thread", squashAtomCommandFailure(result));
        }
        return;
      }
      const reportFailure = async (
        title: string,
        run: () => Promise<AtomCommandResult<unknown, unknown>>,
      ) => {
        const result = await run();
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast(title, squashAtomCommandFailure(result));
        }
      };
      switch (action) {
        case "filter-by-project":
          projectFilter?.toggle(threadRef);
          return;
        case "project-settings": {
          if (openProjectSettings) {
            openProjectSettings(threadRef);
            return;
          }
          const project = projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          );
          if (!project) return;
          const projectKey =
            logicalProjectKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
            deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings);
          void router.navigate({
            to: "/projects/$projectKey",
            params: { projectKey },
          });
          return;
        }
        case "new-thread-on-branch": {
          // Explicit branch carry-over: reuse the thread's worktree when it
          // has one, otherwise its branch on the local checkout.
          const result = await settlePromise(() =>
            handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              envMode: thread.worktreePath ? "worktree" : "local",
              startFromOrigin: false,
            }),
          );
          if (result._tag === "Failure") {
            failureToast("Could not create thread", squashAtomCommandFailure(result));
          }
          return;
        }
        case "settle":
          if (settle) {
            settle(threadRef);
            return;
          }
          await reportFailure("Failed to settle thread", () => settleThread(threadRef));
          return;
        case "unsettle":
          await reportFailure("Failed to un-settle thread", () => unsettleThread(threadRef));
          return;
        case "unsnooze":
          await reportFailure("Failed to wake thread", () => unsnoozeThread(threadRef));
          return;
        case "pin":
          await reportFailure("Failed to pin thread", () => pinThread(threadRef));
          return;
        case "unpin":
          await reportFailure("Failed to unpin thread", () => confirmAndUnpinThread(threadRef));
          return;
        case "auto-settle:enabled":
        case "auto-settle:disabled":
          await reportFailure("Failed to update auto-settle", () =>
            setThreadAutoSettle(threadRef, action === "auto-settle:enabled"),
          );
          return;
        case "rename":
          startRename(threadRef);
          return;
        case "regenerate-title":
          await reportFailure("Failed to regenerate thread title", () =>
            regenerateThreadTitle(threadRef),
          );
          return;
        case "mark-unread":
          markThreadUnread(threadRef);
          return;
        case "copy-path": {
          const workspacePath =
            thread.worktreePath ??
            readProject(scopeProjectRef(threadRef.environmentId, thread.projectId))
              ?.workspaceRoot ??
            null;
          if (!workspacePath) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Path unavailable",
                description: "This thread does not have a workspace path to copy.",
              }),
            );
            return;
          }
          copyPathToClipboard(workspacePath, { path: workspacePath });
          return;
        }
        case "copy-branch":
          if (thread.branch) {
            copyBranchToClipboard(thread.branch, { branch: thread.branch });
          }
          return;
        case "copy-thread-id":
          copyThreadIdToClipboard(thread.id, { threadId: thread.id });
          return;
        case "archive": {
          if (confirmThreadArchive) {
            if (!api) return;
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(`Archive thread "${thread.title}"?`),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          let didArchive = false;
          const result = await archiveThread(threadRef, {
            onArchived: () => {
              didArchive = true;
            },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(
              didArchive ? "Thread archived, but navigation failed" : "Failed to archive thread",
              squashAtomCommandFailure(result),
            );
          }
          return;
        }
        case "delete": {
          if (confirmThreadDelete) {
            if (!api) return;
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(
                [
                  `Delete thread "${thread.title}"?`,
                  "This permanently clears conversation history for this thread.",
                ].join("\n"),
                { variant: "destructive" },
              ),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          const deleted = await deleteThread(threadRef);
          if (
            deleted._tag === "Failure" &&
            !isAtomCommandInterrupted(deleted) &&
            // A failure with the thread already gone is worktree cleanup
            // failing after a successful delete — deleteThread has toasted
            // that itself, and "Failed to delete thread" would be a lie.
            readThreadShell(threadRef) !== null
          ) {
            failureToast("Failed to delete thread", squashAtomCommandFailure(deleted));
          }
          return;
        }
        default:
          return;
      }
    },
    [
      archiveThread,
      confirmThreadArchive,
      confirmThreadDelete,
      confirmAndUnpinThread,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleNewThread,
      logicalProjectKeyByPhysicalKey,
      markThreadUnread,
      openProjectSettings,
      pinThread,
      projectFilter,
      projectGroupingSettings,
      projects,
      regenerateThreadTitle,
      router,
      setThreadAutoSettle,
      settle,
      settleThread,
      snooze,
      snoozeThread,
      startRename,
      timestampFormat,
      unsettleThread,
      unsnoozeThread,
    ],
  );

  const openMenu = useCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        // Snapshot at open time — the menu is modal, so state read now is
        // what the user is looking at.
        const items = readMenuItems(threadRef);
        if (items.length === 0) return;
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        await runAction(threadRef, clicked.value);
      })();
    },
    [readMenuItems, runAction],
  );

  const closeMenu = useCallback(() => {
    void readLocalApi()?.contextMenu.close();
  }, []);

  return { openMenu, closeMenu, readMenuItems, runAction, renameThread };
}
