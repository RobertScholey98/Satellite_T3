import type { EnvironmentId, IssueBoardView, IssueBoardItem } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import ChatView from "../ChatView";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { useIssueDraftStore } from "~/issueDraftStore";
import { newDraftId, newThreadId, randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";

export function IssueStartDialog({
  environmentId,
  board,
  item,
  onClose,
}: {
  environmentId: EnvironmentId;
  board: IssueBoardView;
  item: IssueBoardItem;
  onClose: () => void;
}) {
  const projects = useProjects();
  const navigate = useNavigate();
  const [draftId] = useState<DraftId>(() => {
    const existing = Object.entries(useIssueDraftStore.getState().intents).find(
      ([id, intent]) =>
        intent.boardId === board.board.id &&
        intent.sourceEnvironmentId === environmentId &&
        intent.issue.id === item.issue.ref.id &&
        useComposerDraftStore.getState().getDraftSession(id as DraftId) !== null &&
        useComposerDraftStore.getState().getDraftSession(id as DraftId)?.promotedTo == null,
    );
    return existing ? (existing[0] as DraftId) : newDraftId();
  });
  useEffect(() => {
    if (useComposerDraftStore.getState().getDraftSession(draftId)) return;
    const project =
      projects.find(
        (candidate) =>
          candidate.environmentId === environmentId && candidate.id === board.board.projectId,
      ) ?? projects[0];
    if (!project) return;
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(scopeProjectRef(project.environmentId, project.id), draftId, {
        threadId: newThreadId(),
        envMode: "worktree",
        branch: null,
      });
    useIssueDraftStore.getState().set(draftId, {
      sourceEnvironmentId: environmentId,
      sourceProjectId: board.board.projectId,
      boardId: board.board.id,
      issue: item.issue.ref,
      title: item.issue.title,
      worktreeName: `issue-${item.issue.ref.number}`,
      requestId: randomUUID(),
    });
  }, [
    board.board.id,
    board.board.projectId,
    draftId,
    environmentId,
    item.issue.ref,
    item.issue.title,
    projects,
  ]);
  const draft = useComposerDraftStore((state) => state.getDraftSession(draftId));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="h-[min(80dvh,760px)] max-w-4xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Start issue #{item.issue.ref.number}</DialogTitle>
          <DialogDescription>{item.issue.title}</DialogDescription>
        </DialogHeader>
        {draft ? (
          <ChatView
            routeKind="draft"
            draftId={draftId}
            environmentId={draft.environmentId}
            threadId={draft.threadId}
            embeddedDraft
            onDraftSubmitted={(threadRef) => {
              onClose();
              void navigate({ to: "/$environmentId/$threadId", params: threadRef });
            }}
          />
        ) : (
          <p className="p-4 text-sm text-destructive">
            The source project is unavailable. Reconnect its environment before starting work.
          </p>
        )}
      </DialogPopup>
    </Dialog>
  );
}
