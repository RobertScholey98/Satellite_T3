import type { EnvironmentId, IssueAttemptLink, IssueRef, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DraftId } from "./composerDraftStore";

export interface IssueDraftIntent {
  sourceEnvironmentId: EnvironmentId;
  sourceProjectId: ProjectId;
  boardId: string;
  issue: IssueRef;
  title: string;
  worktreeName: string;
  requestId: string;
  reservation?: IssueAttemptLink;
}

export const useIssueDraftStore = create<{
  intents: Record<string, IssueDraftIntent>;
  set: (draftId: DraftId, intent: IssueDraftIntent) => void;
  remove: (draftId: DraftId) => void;
}>()(
  persist(
    (set) => ({
      intents: {},
      set: (draftId, intent) =>
        set((state) => ({ intents: { ...state.intents, [draftId]: intent } })),
      remove: (draftId) =>
        set((state) => {
          const intents = { ...state.intents };
          delete intents[draftId];
          return { intents };
        }),
    }),
    { name: "t3code:issue-drafts", partialize: (state) => ({ intents: state.intents }) },
  ),
);
