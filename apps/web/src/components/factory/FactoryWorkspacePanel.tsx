import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useChatCanvas } from "../chat/ChatCanvasContext";
import {
  resolveThreadDetailsCardLayout,
  THREAD_DETAILS_CARD_GAP,
  THREAD_DETAILS_CARD_WIDTH,
} from "../chat/threadDetailsCardLayout";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { ScrollArea } from "../ui/scroll-area";
import { useFactoryWorkspaceFeed, useFactoryWorkspacePlace } from "./factoryWorkspaceState";
import {
  FACTORY_BACK_CONTROL_HEIGHT,
  factoryMemberLabel,
  resolveFactoryDetailsCardSide,
  resolveFactoryWorkspaceView,
  type FactoryWorkspaceTeam,
} from "./factoryWorkspaceLogic";

/** Below this the cards would be unreadable; the column waits for the details card to close. */
const MIN_COLUMN_HEIGHT = 220;
/**
 * Matches the details card's pressed surface, so the open thread rests at the same fill. It sits
 * on the list item because the control owns its own colours.
 */
const CURRENT_ROW_CLASS = "rounded-lg bg-black/[0.05] dark:bg-white/[0.08]";
const CARD_CLASS = "dropdown-glass isolate contain-paint shrink-0 rounded-3xl";

type Obstacle = { readonly left: number; readonly right: number; readonly bottom: number } | null;

/**
 * Keeps the chat lane clear of a card this panel shows. While `sharedWithDetails`, the open
 * details card owns that side's report, so withdrawing ours must not clear it. Reports on every
 * commit: the details card clears its report on its own commits, and the canvas ignores a report
 * equal to the current one.
 */
function useObstacleReport(
  report: ((obstacle: Obstacle) => void) | undefined,
  obstacle: Obstacle,
  sharedWithDetails: boolean,
) {
  const reportedRef = useRef(false);
  useLayoutEffect(() => {
    if (!report) return;
    if (obstacle) {
      report(obstacle);
      reportedRef.current = true;
    } else if (reportedRef.current) {
      if (!sharedWithDetails) report(null);
      reportedRef.current = false;
    }
  });
  useLayoutEffect(
    () => () => {
      if (reportedRef.current) report?.(null);
    },
    [report],
  );
}

/**
 * What a manager's workspace adds around a factory thread's chat: a card per live team on the
 * right and, on team threads, Back to manager above the details card. When the details card takes
 * the top-left gutter both sit there; otherwise both stay at the top right, above the teams.
 */
export function FactoryWorkspacePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const feed = useFactoryWorkspaceFeed(props.environmentId);
  const view = resolveFactoryWorkspaceView(feed, props.threadId);
  const place = useFactoryWorkspacePlace(props.environmentId, props.threadId);
  const canvas = useChatCanvas();
  const navigate = useNavigate();
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
  const side =
    canvas && place
      ? resolveFactoryDetailsCardSide({ ...canvas, teamColumn: place.teamColumn })
      : "right";
  const placement =
    canvas && view
      ? resolveThreadDetailsCardLayout({
          container: canvas.container,
          lane: canvas.lane,
          frame: null,
          topInset,
        })
      : null;

  // On the right the details card shares the column's top edge, so its height decides where the
  // column starts.
  const stacked = side === "right" && detailsOpen;
  useLayoutEffect(() => {
    const details = stacked
      ? (anchor
          ?.closest("[data-chat-canvas]")
          ?.querySelector<HTMLElement>('[data-thread-details-panel="inline"]') ?? null)
      : null;
    const measure = () => setDetailsHeight(details?.offsetHeight ?? 0);
    measure();
    return details ? observeResize(details, measure) : undefined;
  }, [anchor, stacked]);

  const backToManager = place?.backToManager === true;
  const backOnLeft = backToManager && side === "left";
  const backOnRight = backToManager && side === "right" && placement !== null;
  const backSpace = FACTORY_BACK_CONTROL_HEIGHT + THREAD_DETAILS_CARD_GAP;
  const top = placement
    ? placement.y +
      (backOnRight ? backSpace : 0) +
      (stacked && detailsHeight > 0 ? detailsHeight + THREAD_DETAILS_CARD_GAP : 0)
    : 0;
  const height = placement && canvas ? canvas.container.height - top - THREAD_DETAILS_CARD_GAP : 0;
  const visible =
    placement !== null && (view?.teams.length ?? 0) > 0 && height >= MIN_COLUMN_HEIGHT;
  const rightBottom = visible
    ? top + height
    : backOnRight
      ? placement.y + FACTORY_BACK_CONTROL_HEIGHT
      : null;

  // With the details card on the left, the column and Back to manager are the only cards on the
  // right.
  useObstacleReport(
    canvas?.reportDetailsCard,
    placement && rightBottom !== null && !stacked
      ? { left: placement.x, right: placement.x + placement.width, bottom: rightBottom }
      : null,
    stacked,
  );
  // Back to manager stays in the gutter while the details card below it is closed.
  useObstacleReport(
    canvas?.reportLeftCard,
    backOnLeft && !detailsOpen
      ? {
          left: THREAD_DETAILS_CARD_GAP,
          right: THREAD_DETAILS_CARD_GAP + THREAD_DETAILS_CARD_WIDTH,
          bottom: THREAD_DETAILS_CARD_GAP + FACTORY_BACK_CONTROL_HEIGHT,
        }
      : null,
    side === "left" && detailsOpen,
  );

  if (!view) return null;
  const open = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  const back = backToManager ? <BackToManager onOpen={() => open(view.manager.threadId)} /> : null;
  return (
    <div ref={setAnchor} className="contents">
      {backOnLeft ? (
        <nav
          aria-label="Manager workspace"
          className="absolute z-20"
          style={{
            left: THREAD_DETAILS_CARD_GAP,
            top: THREAD_DETAILS_CARD_GAP,
            width: THREAD_DETAILS_CARD_WIDTH,
            height: FACTORY_BACK_CONTROL_HEIGHT,
          }}
        >
          {back}
        </nav>
      ) : null}
      {backOnRight ? (
        <nav
          aria-label="Manager workspace"
          // Moves down with the details card below it while the find bar is open.
          className={cn(
            "absolute z-20",
            topInset > 0 && "transition-[top] duration-150 ease-out motion-reduce:transition-none",
          )}
          style={{
            right: placement.right,
            top: placement.y,
            width: placement.width,
            height: FACTORY_BACK_CONTROL_HEIGHT,
          }}
        >
          {back}
        </nav>
      ) : null}
      {visible ? (
        <aside
          aria-label="Manager teams"
          className="absolute z-20"
          style={{ right: placement.right, top, width: placement.width, height }}
          data-factory-workspace-panel
        >
          <ScrollArea scrollFade className="h-full">
            <div className="flex flex-col gap-3">
              {view.teams.map((team) => (
                <TeamCard
                  key={team.assignment.id}
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  team={team}
                  onOpen={open}
                />
              ))}
            </div>
          </ScrollArea>
        </aside>
      ) : null}
    </div>
  );
}

function BackToManager(props: { readonly onOpen: () => void }) {
  return (
    <div className={`${CARD_CLASS} p-1.5`}>
      <ThreadDetailsControl part="row" onClick={props.onOpen}>
        <ArrowLeftIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        Back to manager
      </ThreadDetailsControl>
    </div>
  );
}

function TeamCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly team: FactoryWorkspaceTeam;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { assignment, threads } = props.team;
  return (
    <section aria-label={assignment.title} className={CARD_CLASS}>
      <h3 className="line-clamp-2 px-3.5 pt-3 pb-1 text-2xs font-medium text-muted-foreground select-none">
        {assignment.title}
      </h3>
      <ul className="m-0 flex list-none flex-col px-2 pb-2">
        {threads.map((thread) => (
          <TeamThreadRow
            key={thread.threadId}
            environmentId={props.environmentId}
            threadId={thread.threadId}
            label={factoryMemberLabel(thread)}
            current={thread.threadId === props.threadId}
            onOpen={() => props.onOpen(thread.threadId)}
          />
        ))}
      </ul>
    </section>
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
