import { create } from "zustand";
import type { IdeaArtifactId, IdeaEntryId, MessageId } from "@t3tools/contracts";

export type IdeaTab =
  | { kind: "thread"; id: "thread" }
  | { kind: "entry"; id: IdeaEntryId }
  | { kind: "artifact"; id: IdeaArtifactId };

export function ideaTabKey(tab: IdeaTab): string {
  return tab.kind === "thread" ? "thread" : `${tab.kind}:${tab.id}`;
}

const readerPositions = new Map<string, Map<string, number>>();

export function readIdeaPosition(key: string, resource: string): number {
  return readerPositions.get(key)?.get(resource) ?? 0;
}

export function saveIdeaPosition(key: string, resource: string, position: number): void {
  const positions = readerPositions.get(key) ?? new Map<string, number>();
  positions.set(resource, position);
  readerPositions.set(key, positions);
}

export interface IdeaEditorDraft {
  baseRevision: number;
  markdown: string;
  title: string;
  categoryId: string;
}

interface Workspace {
  tabs: IdeaTab[];
  activeTab: string;
  panelOpen: boolean;
  drafts: Record<string, IdeaEditorDraft>;
  messageRequest: { messageId?: MessageId; activityId?: string; requestId: number } | null;
}

const emptyWorkspace: Workspace = {
  tabs: [{ kind: "thread", id: "thread" }],
  activeTab: "thread",
  panelOpen: true,
  drafts: {},
  messageRequest: null,
};

export const useIdeaWorkspaceStore = create<{
  lastSelected: { environment: string; idea: string } | null;
  select: (environment: string, idea: string) => void;
  workspaces: Record<string, Workspace>;
  open: (key: string, tab: IdeaTab) => void;
  openMessage: (key: string, messageId: MessageId) => void;
  openActivity: (key: string, activityId: string) => void;
  close: (key: string, id: string) => void;
  toggle: (key: string) => void;
  setDraft: (key: string, resource: string, draft: IdeaEditorDraft | null) => void;
  remove: (key: string) => void;
}>((set) => ({
  lastSelected: null,
  select: (environment, idea) => set({ lastSelected: { environment, idea } }),
  workspaces: {},
  openMessage: (key, messageId) =>
    set((state) => {
      const current = state.workspaces[key] ?? emptyWorkspace;
      return {
        workspaces: {
          ...state.workspaces,
          [key]: {
            ...current,
            activeTab: "thread",
            panelOpen: true,
            messageRequest: { messageId, requestId: (current.messageRequest?.requestId ?? 0) + 1 },
          },
        },
      };
    }),
  openActivity: (key, activityId) =>
    set((state) => {
      const current = state.workspaces[key] ?? emptyWorkspace;
      return {
        workspaces: {
          ...state.workspaces,
          [key]: {
            ...current,
            activeTab: "thread",
            panelOpen: true,
            messageRequest: { activityId, requestId: (current.messageRequest?.requestId ?? 0) + 1 },
          },
        },
      };
    }),
  open: (key, tab) =>
    set((state) => {
      const current = state.workspaces[key] ?? emptyWorkspace;
      return {
        workspaces: {
          ...state.workspaces,
          [key]: {
            ...current,
            tabs: current.tabs.some((item) => ideaTabKey(item) === ideaTabKey(tab))
              ? current.tabs
              : [...current.tabs, tab],
            activeTab: ideaTabKey(tab),
            panelOpen: true,
          },
        },
      };
    }),
  close: (key, id) =>
    set((state) => {
      if (id === "thread") return state;
      const current = state.workspaces[key] ?? emptyWorkspace;
      return {
        workspaces: {
          ...state.workspaces,
          [key]: {
            ...current,
            tabs: current.tabs.filter((item) => ideaTabKey(item) !== id),
            activeTab: current.activeTab === id ? "thread" : current.activeTab,
          },
        },
      };
    }),
  toggle: (key) =>
    set((state) => {
      const current = state.workspaces[key] ?? emptyWorkspace;
      return {
        workspaces: { ...state.workspaces, [key]: { ...current, panelOpen: !current.panelOpen } },
      };
    }),
  setDraft: (key, resource, draft) =>
    set((state) => {
      const current = state.workspaces[key] ?? emptyWorkspace;
      const drafts = { ...current.drafts };
      if (draft === null) delete drafts[resource];
      else drafts[resource] = draft;
      return { workspaces: { ...state.workspaces, [key]: { ...current, drafts } } };
    }),
  remove: (key) =>
    set((state) => {
      readerPositions.delete(key);
      const workspaces = { ...state.workspaces };
      delete workspaces[key];
      return {
        workspaces,
        lastSelected:
          state.lastSelected &&
          key === `${state.lastSelected.environment}:${state.lastSelected.idea}`
            ? null
            : state.lastSelected,
      };
    }),
}));

export function useIdeaWorkspace(key: string) {
  return useIdeaWorkspaceStore((state) => state.workspaces[key] ?? emptyWorkspace);
}
