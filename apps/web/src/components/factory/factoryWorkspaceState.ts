import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  FactoryManager,
  FactoryWorkspaceFeed,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { create } from "zustand";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsPinReorder,
  readThreadShells,
  waitForThreadShell,
} from "~/state/entities";
import { environmentPresentations, environmentSummaries } from "~/state/presentation";
import { environmentThreadShells, threadEnvironment } from "~/state/threads";
import { randomUUID } from "~/lib/utils";
import { useEnvironment } from "~/state/environments";
import {
  factoryEnvironment,
  supportsFactory,
  unwrapFactoryResult,
  useFactoryWorkspace,
} from "./factoryState";
import {
  factoryAssignmentLeadThreadIds,
  resolveFactoryMergeRows,
  type FactoryLeadThreadLinks,
  type FactoryMergeRow,
} from "./factoryMergeLogic";
import {
  factoryMemberThreadKeys,
  factoryWorkspacePlace,
  isLiveAssignment,
  resolveFactoryWorkspaceView,
  type FactoryWorkspacePlace,
} from "./factoryWorkspaceLogic";

/** Drafts whose composer currently names a new engineering manager instead of starting a thread. */
const useManagerDrafts = create<{ readonly draftIds: ReadonlySet<string> }>(() => ({
  draftIds: new Set(),
}));

export function useFactoryManagerDraft(draftId: string | null): boolean {
  return useManagerDrafts((state) => draftId !== null && state.draftIds.has(draftId));
}

export function isFactoryManagerDraft(draftId: string | null): boolean {
  return draftId !== null && useManagerDrafts.getState().draftIds.has(draftId);
}

export function setFactoryManagerDraft(draftId: string, on: boolean) {
  useManagerDrafts.setState((state) => {
    if (state.draftIds.has(draftId) === on) return state;
    const draftIds = new Set(state.draftIds);
    if (on) draftIds.add(draftId);
    else draftIds.delete(draftId);
    return { draftIds };
  });
}

const factoryEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.environmentIdsAtom).filter(
    (environmentId) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.issueBoards === true,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((id, index) => id === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("web-factory-environment-ids"));

/** Every factory environment's workspace feed, so the sidebar can tell team threads apart. */
const workspaceFeedsAtom = Atom.make((get) => {
  const feeds = new Map<EnvironmentId, FactoryWorkspaceFeed>();
  for (const environmentId of get(factoryEnvironmentIdsAtom)) {
    const feed = Option.getOrUndefined(
      AsyncResult.value(get(factoryEnvironment.workspace({ environmentId, input: {} }))),
    );
    if (feed) feeds.set(environmentId, feed);
  }
  return feeds;
}).pipe(Atom.withLabel("web-factory-workspace-feeds"));

// Checklists change the feed often; the sidebar repartitions only when membership does.
const memberThreadKeysAtom = Atom.make((get) => {
  const next = factoryMemberThreadKeys(get(workspaceFeedsAtom));
  const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every((key) => previous.has(key))
    ? previous
    : next;
}).pipe(Atom.withLabel("web-factory-member-thread-keys"));

const managerWaitingAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => {
    for (const [environmentId, feed] of get(workspaceFeedsAtom)) {
      for (const manager of feed.managers) {
        if (manager.threadId === null || manager.state === "retired") continue;
        if (scopedThreadKey(scopeThreadRef(environmentId, manager.threadId)) === threadKey)
          return manager.waitingOnYou;
      }
    }
    return 0;
  }).pipe(Atom.withLabel(`web-factory-manager-waiting:${threadKey}`)),
);

// A boolean per thread, so a checklist change re-renders no thread's timeline.
const managerThreadAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => {
    for (const [environmentId, feed] of get(workspaceFeedsAtom)) {
      for (const manager of feed.managers) {
        if (
          manager.threadId !== null &&
          scopedThreadKey(scopeThreadRef(environmentId, manager.threadId)) === threadKey
        )
          return true;
      }
    }
    return false;
  }).pipe(Atom.withLabel(`web-factory-manager-thread:${threadKey}`)),
);

// Two booleans per thread, so the details card re-renders only when they change.
const workspacePlaceAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((threadId: ThreadId) =>
    Atom.make((get) => {
      const view = resolveFactoryWorkspaceView(
        get(workspaceFeedsAtom).get(environmentId),
        threadId,
      );
      const next = view === null ? null : factoryWorkspacePlace(view, threadId);
      const previous = Option.getOrNull(get.self<FactoryWorkspacePlace | null>());
      return previous !== null &&
        next !== null &&
        previous.backToManager === next.backToManager &&
        previous.teamColumn === next.teamColumn
        ? previous
        : next;
    }).pipe(Atom.withLabel(`web-factory-workspace-place:${environmentId}:${threadId}`)),
  ),
);

// Reads the shell of every lead each live assignment has had, held through streaming ticks, so the
// card re-renders only when a row changes.
const mergeRowsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((managerId: string) =>
    Atom.make((get) => {
      const assignments = get(workspaceFeedsAtom).get(environmentId)?.assignments ?? [];
      const leadThreads = new Map<ThreadId, FactoryLeadThreadLinks>();
      for (const assignment of assignments) {
        if (assignment.managerId !== managerId || !isLiveAssignment(assignment)) continue;
        for (const threadId of factoryAssignmentLeadThreadIds(assignment)) {
          const shell = get(
            environmentThreadShells.quietThreadShellAtom(scopeThreadRef(environmentId, threadId)),
          );
          if (shell)
            leadThreads.set(threadId, {
              projectId: shell.projectId,
              pullRequests: shell.pullRequests,
            });
        }
      }
      const next = resolveFactoryMergeRows(assignments, managerId, leadThreads);
      const previous = Option.getOrNull(get.self<ReadonlyArray<FactoryMergeRow>>());
      return previous !== null && JSON.stringify(previous) === JSON.stringify(next)
        ? previous
        : next;
    }).pipe(Atom.withLabel(`web-factory-merge-rows:${environmentId}:${managerId}`)),
  ),
);

/** The open pull requests of a manager's teams, in the order the user should merge them. */
export function useFactoryMergeRows(
  environmentId: EnvironmentId,
  managerId: string,
): ReadonlyArray<FactoryMergeRow> {
  return useAtomValue(mergeRowsAtom(environmentId)(managerId));
}

/** Where a thread sits in its manager's workspace; null when it is not a factory thread. */
export function useFactoryWorkspacePlace(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): FactoryWorkspacePlace | null {
  return useAtomValue(workspacePlaceAtom(environmentId)(threadId));
}

/** Whether the thread is a manager's current thread on a factory environment. */
export function useIsFactoryManagerThread(threadKey: string | null): boolean {
  return useAtomValue(managerThreadAtom(threadKey ?? ""));
}

/** The workspace feed of an environment that has the factory; `undefined` elsewhere or until loaded. */
export function useFactoryWorkspaceFeed(
  environmentId: EnvironmentId | null,
): FactoryWorkspaceFeed | undefined {
  const environment = useEnvironment(environmentId);
  return useFactoryWorkspace(supportsFactory(environment ?? undefined) ? environmentId : null);
}

/** Scoped keys of lead and team threads that belong in a manager's workspace, not the sidebar. */
export function useFactoryMemberThreadKeys(): ReadonlySet<string> {
  return useAtomValue(memberThreadKeysAtom);
}

/** Assignments waiting on the user, for a manager's thread; 0 for any other thread. */
export function useFactoryManagerWaitingCount(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): number {
  return useAtomValue(managerWaitingAtom(scopedThreadKey(scopeThreadRef(environmentId, threadId))));
}

const creatingDrafts = new Set<string>();

/**
 * Creates the project's manager from a draft whose composer holds its name, pins the manager's
 * thread and opens it. Onboarding starts on the server as the thread's first turn.
 */
export async function createFactoryManagerFromDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftId: string;
  readonly name: string;
  readonly modelSelection: ModelSelection | null;
  readonly onCreated: (manager: FactoryManager & { readonly threadId: ThreadId }) => void;
  readonly onError: (message: string) => void;
}) {
  const name = input.name.trim();
  if (name === "") return input.onError("Name the engineering manager first.");
  if (name.length > 80) return input.onError("Keep the manager's name to 80 characters.");
  if (creatingDrafts.has(input.draftId)) return;
  creatingDrafts.add(input.draftId);
  const result = await runAtomCommand(
    appAtomRegistry,
    factoryEnvironment.createManager,
    {
      environmentId: input.environmentId,
      input: {
        requestId: randomUUID(),
        projectId: input.projectId,
        name,
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      },
    },
    { label: "factory create manager", reportFailure: false },
  );
  creatingDrafts.delete(input.draftId);
  let manager: FactoryManager;
  try {
    manager = unwrapFactoryResult(result);
  } catch (failure) {
    return input.onError(failure instanceof Error ? failure.message : String(failure));
  }
  const threadId = manager.threadId;
  if (threadId === null) return input.onError("The manager's thread did not start.");
  setFactoryManagerDraft(input.draftId, false);
  input.onCreated({ ...manager, threadId });
  await pinFactoryManagerThread(input.environmentId, threadId);
}

/** Pins a manager's thread at the top of the pinned threads, once the thread has arrived. */
export async function pinFactoryManagerThread(environmentId: EnvironmentId, threadId: ThreadId) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  if (!readEnvironmentSupportsPinning(environmentId) || !(await waitForThreadShell(threadRef)))
    return;
  const firstPinKey = readThreadShells().reduce<string | null>(
    (first, shell) =>
      shell.pinnedAt == null ||
      shell.pinOrderKey == null ||
      (first !== null && first <= shell.pinOrderKey)
        ? first
        : shell.pinOrderKey,
    null,
  );
  const orderKey = readEnvironmentSupportsPinReorder(environmentId)
    ? (pinOrderKeyBetween(null, firstPinKey) ?? undefined)
    : undefined;
  await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.pin,
    {
      environmentId,
      input: { threadId, ...(orderKey === undefined ? {} : { orderKey }) },
    },
    { label: "factory pin manager thread" },
  );
}

/** Unpins a thread the manager has moved on from, such as its settled onboarding thread. */
export async function unpinFactoryThread(environmentId: EnvironmentId, threadId: ThreadId) {
  if (!readEnvironmentSupportsPinning(environmentId)) return;
  await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.unpin,
    { environmentId, input: { threadId } },
    { label: "factory unpin onboarding thread" },
  );
}
