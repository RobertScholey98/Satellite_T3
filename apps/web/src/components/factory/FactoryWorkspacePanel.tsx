import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useChatCanvas } from "../chat/ChatCanvasContext";
import {
  resolveThreadDetailsCardLayout,
  THREAD_DETAILS_CARD_GAP,
} from "../chat/threadDetailsCardLayout";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { ScrollArea } from "../ui/scroll-area";
import { useFactoryWorkspaceFeed } from "./factoryWorkspaceState";
import {
  factoryMemberLabel,
  resolveFactoryWorkspaceView,
  type FactoryWorkspaceTeam,
} from "./factoryWorkspaceLogic";

/** Below this the card would be unreadable; the column waits for the details card to close. */
const MIN_COLUMN_HEIGHT = 220;
/**
 * Matches the details card's pressed surface, so the open thread rests at the same fill. It sits
 * on the list item because the control owns its own colours.
 */
const CURRENT_ROW_CLASS = "rounded-lg bg-black/[0.05] dark:bg-white/[0.08]";

/**
 * The right-hand column of a manager's workspace: every team thread.
 * Shown on the manager's thread and on each of its teams' threads, below the details card.
 */
export function FactoryWorkspacePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const feed = useFactoryWorkspaceFeed(props.environmentId);
  const view = resolveFactoryWorkspaceView(feed, props.threadId);
  const canvas = useChatCanvas();
  const detailsOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(
      state.threadPanelVisibilityByThreadKey,
      scopeThreadRef(props.environmentId, props.threadId),
      "inline",
    ),
  );
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [detailsHeight, setDetailsHeight] = useState(0);
  const topInset = canvas?.detailsCardTopInset ?? 0;
  const placement =
    canvas && view
      ? resolveThreadDetailsCardLayout({
          container: canvas.container,
          lane: canvas.lane,
          frame: null,
          topInset,
        })
      : null;

  // The details card shares this column's top edge, so only its height decides where this starts.
  useLayoutEffect(() => {
    const details = detailsOpen
      ? (anchor
          ?.closest("[data-chat-canvas]")
          ?.querySelector<HTMLElement>('[data-thread-details-panel="inline"]') ?? null)
      : null;
    const measure = () => setDetailsHeight(details?.offsetHeight ?? 0);
    measure();
    return details ? observeResize(details, measure) : undefined;
  }, [anchor, detailsOpen]);

  const top = placement
    ? placement.y + (detailsHeight > 0 ? detailsHeight + THREAD_DETAILS_CARD_GAP : 0)
    : 0;
  const height = placement && canvas ? canvas.container.height - top - THREAD_DETAILS_CARD_GAP : 0;
  const visible = placement !== null && height >= MIN_COLUMN_HEIGHT;

  // With the details card closed the column is the right lane's only card, so it keeps the chat
  // lane clear the way the details card would.
  const reportDetailsCard = canvas?.reportDetailsCard;
  const obstacle =
    visible && !detailsOpen
      ? { left: placement.x, right: placement.x + placement.width, bottom: top + height }
      : null;
  const reportedRef = useRef(false);
  // Every commit: the details card clears its report on its own commits, and the canvas ignores
  // a report equal to the current one.
  useLayoutEffect(() => {
    if (!reportDetailsCard) return;
    if (obstacle) {
      reportDetailsCard(obstacle);
      reportedRef.current = true;
    } else if (reportedRef.current) {
      if (!detailsOpen) reportDetailsCard(null);
      reportedRef.current = false;
    }
  });
  useLayoutEffect(
    () => () => {
      if (reportedRef.current) reportDetailsCard?.(null);
    },
    [reportDetailsCard],
  );

  if (!view) return null;
  return (
    <div ref={setAnchor} className="contents">
      {visible ? (
        <aside
          aria-label="Manager workspace"
          className="absolute z-20 flex flex-col gap-3"
          style={{ right: placement.right, top, width: placement.width, height }}
          data-factory-workspace-panel
        >
          <FactoryTeamThreadsCard
            environmentId={props.environmentId}
            threadId={props.threadId}
            managerThreadId={view.manager.threadId}
            teams={view.teams}
          />
        </aside>
      ) : null}
    </div>
  );
}

function WorkspaceCard(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section
      aria-label={props.label}
      className="dropdown-glass isolate contain-paint flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl"
    >
      {props.children}
    </section>
  );
}

function CardHeading(props: { readonly children: ReactNode }) {
  return (
    <h3 className="px-3.5 pt-3 pb-1 text-2xs font-medium text-muted-foreground select-none">
      {props.children}
    </h3>
  );
}

function FactoryTeamThreadsCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly managerThreadId: ThreadId;
  readonly teams: ReadonlyArray<FactoryWorkspaceTeam>;
}) {
  const navigate = useNavigate();
  const open = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  return (
    <WorkspaceCard label="Team threads">
      <CardHeading>Team threads</CardHeading>
      {props.threadId === props.managerThreadId ? null : (
        <div className="px-2 pb-1">
          <ThreadDetailsControl part="row" onClick={() => open(props.managerThreadId)}>
            <ArrowLeftIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            Manager
          </ThreadDetailsControl>
        </div>
      )}
      <ScrollArea scrollFade className="min-h-0 flex-1">
        {props.teams.length === 0 ? (
          <p className="px-3.5 pb-3 text-xs text-muted-foreground">No team threads yet.</p>
        ) : (
          <div className="flex flex-col gap-2 px-2 pb-2.5">
            {props.teams.map((team) => (
              <div key={team.assignment.id} role="group" aria-label={team.assignment.title}>
                <p className="line-clamp-2 px-2.5 py-1 text-2xs font-medium text-muted-foreground">
                  {team.assignment.title}
                </p>
                <ul className="m-0 flex list-none flex-col p-0">
                  {team.threads.map((thread) => (
                    <TeamThreadRow
                      key={thread.threadId}
                      environmentId={props.environmentId}
                      threadId={thread.threadId}
                      label={factoryMemberLabel(thread)}
                      current={thread.threadId === props.threadId}
                      onOpen={() => open(thread.threadId)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </WorkspaceCard>
  );
}

function TeamThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly current: boolean;
  readonly onOpen: () => void;
}) {
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const status = shell ? resolveThreadStatusPill({ thread: shell }) : null;
  const title = shell?.title ?? "Thread";
  return (
    <li className={props.current ? CURRENT_ROW_CLASS : undefined}>
      <ThreadDetailsControl
        part="row"
        aria-current={props.current ? "page" : undefined}
        onClick={props.onOpen}
      >
        {/* Held open so an idle thread's title keeps the same left edge as a working one's. */}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {status ? <ThreadStatusLabel status={status} compact /> : null}
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 text-2xs text-muted-foreground">{props.label}</span>
      </ThreadDetailsControl>
    </li>
  );
}
