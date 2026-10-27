import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FactoryAssignmentState, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
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
import { resolveThreadDetailsCardPlacement } from "../chat/threadDetailsCardPlacement";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  FACTORY_CARD_CLASS,
  FACTORY_THREAD_STACK,
  type FactoryStackEntry,
} from "./FactoryThreadStack";
import { resolveFactoryDetailsCardPlacement } from "./factoryDetailsCardPlacement";
import { FactoryProtectedPathAsks } from "./FactoryProtectedPathAsks";
import { useFactoryWorkspaceFeed, useFactoryWorkspacePlace } from "./factoryWorkspaceState";
import {
  FACTORY_ASSIGNMENT_STATE_LABEL,
  factoryMemberLabel,
  factoryTeamRowText,
  factoryThreadKind,
  resolveFactoryThreadStack,
  resolveFactoryWorkspaceView,
  type FactoryWorkspaceTeam,
} from "./factoryWorkspaceLogic";

const GAP = THREAD_DETAILS_CARD_GAP;
/** Below this the cards would be unreadable; the column waits for the details card to close. */
const MIN_COLUMN_HEIGHT = 220;
/**
 * Matches the details card's pressed surface, so the open thread rests at the same fill. It sits
 * on the list item because the control owns its own colours.
 */
const CURRENT_ROW_CLASS = "rounded-lg bg-black/[0.05] dark:bg-white/[0.08]";
/** Every state gets a dot so the labels line up; only the states that need the user get colour. */
const STATE_DOT_CLASS: Record<FactoryAssignmentState, string> = {
  active: "bg-muted-foreground/45",
  blocked: "bg-destructive",
  "waiting-user": "bg-info",
  stalled: "bg-muted-foreground/45",
  retro: "bg-muted-foreground/45",
  completed: "bg-muted-foreground/45",
  cancelled: "bg-muted-foreground/45",
};

export function FactoryStateDot(props: { readonly state: FactoryAssignmentState }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT_CLASS[props.state])}
    />
  );
}
/** Cards at the top right move down with the details card while the find bar is open. */
const FIND_BAR_SLIDE_CLASS = "transition-[top] duration-150 ease-out motion-reduce:transition-none";

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
  // oxlint-disable-next-line t3code/react-effect-budget -- Report this card's measured obstacle to the chat canvas after each commit, withdrawing it when it clears.
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
  // oxlint-disable-next-line t3code/react-effect-budget -- Withdraw this card's canvas obstacle when the report target changes or the card unmounts.
  useLayoutEffect(
    () => () => {
      if (reportedRef.current) report?.(null);
    },
    [report],
  );
}

/** An element's rendered size, kept current; zero while it is absent. */
function useMeasured(element: HTMLElement | null, dimension: "offsetHeight" | "offsetWidth") {
  const [size, setSize] = useState(0);
  // oxlint-disable-next-line t3code/react-effect-budget -- Measure the element and observe its resizes until it changes or unmounts.
  useLayoutEffect(() => {
    const measure = () => setSize(element?.[dimension] ?? 0);
    measure();
    return element ? observeResize(element, measure) : undefined;
  }, [element, dimension]);
  return size;
}

/**
 * What a manager's workspace adds around a factory thread's chat: the column of cards around the
 * details card (`FACTORY_THREAD_STACK`) and a card per live team on the right. The column takes the
 * top-left gutter when it fits, and otherwise heads the right side, above the teams.
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
  const [above, setAbove] = useState<HTMLElement | null>(null);
  const [below, setBelow] = useState<HTMLElement | null>(null);
  const topInset = canvas?.detailsCardTopInset ?? 0;
  // The details card's own placement, so the panel lays out around the card exactly where it is.
  const details =
    canvas && place
      ? resolveThreadDetailsCardPlacement(canvas, resolveFactoryDetailsCardPlacement(place, canvas))
      : null;
  const side = details?.side ?? "right";
  const placement =
    canvas && view
      ? resolveThreadDetailsCardLayout({
          container: canvas.container,
          lane: canvas.lane,
          frame: null,
          topInset,
        })
      : null;
  const stack = resolveFactoryThreadStack(
    FACTORY_THREAD_STACK,
    place ? factoryThreadKind(place) : "manager",
  );
  const column =
    canvas && view
      ? side === "left"
        ? { edge: "left" as const, top: GAP }
        : placement
          ? { edge: "right" as const, top: placement.y }
          : null
      : null;
  // Without room for a card at the top right the details card is a popover, so the cards above it
  // stand alone there.
  const alone =
    canvas !== null &&
    view !== null &&
    side === "right" &&
    placement === null &&
    stack.above.length > 0;

  // Growing a short window turns the details card inline without any other input here changing,
  // so the measurement below has to re-run on this.
  const detailsInline = details?.inline != null;
  // The chat view renders the details card, so the cards below it follow its measured height.
  const measuringDetails = column !== null && detailsOpen && detailsInline;
  // oxlint-disable-next-line t3code/react-effect-budget -- Find the inline details card in the DOM and observe its height while the column lays out around it.
  useLayoutEffect(() => {
    const details = measuringDetails
      ? (anchor
          ?.closest("[data-chat-canvas]")
          ?.querySelector<HTMLElement>('[data-thread-details-panel="inline"]') ?? null)
      : null;
    const measure = () => setDetailsHeight(details?.offsetHeight ?? 0);
    measure();
    return details ? observeResize(details, measure) : undefined;
  }, [anchor, measuringDetails]);
  const belowHeight = useMeasured(below, "offsetHeight");
  const aloneWidth = useMeasured(alone ? above : null, "offsetWidth");

  const aboveTop = column?.top ?? GAP + topInset;
  const detailsTop = aboveTop + stack.detailsTopInset;
  const belowTop = detailsTop + (detailsHeight > 0 ? detailsHeight + GAP : 0);
  // On the right the cards under the details card and the team cards scroll as one column, so no
  // card slides under another. The cards scroll within what is left of the canvas, so the measured
  // height below, and with it the reported obstacle, is the column's visible bottom.
  const teamsInColumn = column?.edge === "right";
  const belowRoom = Math.max(0, (canvas?.container.height ?? 0) - belowTop - GAP);
  const stackBottom =
    column === null
      ? null
      : belowHeight > 0
        ? belowTop + belowHeight
        : detailsHeight > 0
          ? detailsTop + detailsHeight
          : stack.above.length > 0
            ? detailsTop - GAP
            : null;

  // With the cards in the gutter, the team cards keep a column of their own on the right.
  const teamsTop = placement?.y ?? 0;
  const teamsHeight = canvas ? canvas.container.height - teamsTop - GAP : 0;
  const teamsVisible =
    !teamsInColumn &&
    placement !== null &&
    (view?.teams.length ?? 0) > 0 &&
    teamsHeight >= MIN_COLUMN_HEIGHT;

  // On the right an open details card reports itself, and the cards around it share its edge.
  const stacked = side === "right" && detailsOpen && placement !== null;
  const rightBottom = teamsInColumn ? stackBottom : teamsVisible ? teamsTop + teamsHeight : null;
  // Alone, the cards are reported even when the lane then falls below its minimum width: a
  // narrower chat reads better than one running under them.
  const aloneObstacle =
    alone && aloneWidth > 0
      ? {
          left: canvas.container.width - GAP - aloneWidth,
          right: canvas.container.width - GAP,
          bottom: detailsTop - GAP,
        }
      : null;
  useObstacleReport(
    canvas?.reportDetailsCard,
    stacked
      ? null
      : placement && rightBottom !== null
        ? { left: placement.x, right: placement.x + placement.width, bottom: rightBottom }
        : aloneObstacle,
    stacked,
  );
  // In the gutter the whole column is one obstacle, down to its lowest card.
  useObstacleReport(
    canvas?.reportLeftCard,
    column?.edge === "left" && stackBottom !== null
      ? { left: GAP, right: GAP + THREAD_DETAILS_CARD_WIDTH, bottom: stackBottom }
      : null,
    false,
  );

  if (!view) return null;
  const open = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  // A card with nothing to show takes no space, not even a gap: a component that renders nothing
  // leaves its wrapper empty, and an empty wrapper is hidden.
  const renderEntries = (entries: ReadonlyArray<FactoryStackEntry>) =>
    entries.flatMap((entry) => {
      const card = entry.render?.({ environmentId: props.environmentId, view, openThread: open });
      return card == null
        ? []
        : [
            <div
              key={entry.key}
              className="empty:hidden"
              style={entry.height === undefined ? undefined : { height: entry.height }}
            >
              {card}
            </div>,
          ];
    });
  const teamCards =
    view.teams.length === 0
      ? []
      : [
          // On the details card's text column, titled like its sections.
          <h3
            key="teams-heading"
            className="-mb-1 px-4.5 text-2xs font-medium text-muted-foreground select-none"
          >
            Teams
          </h3>,
          ...view.teams.map((team) => (
            <TeamCard
              key={team.assignment.id}
              environmentId={props.environmentId}
              threadId={props.threadId}
              team={team}
              onOpen={open}
            />
          )),
        ];
  const edge = column?.edge === "left" ? { left: GAP } : { right: GAP };
  const slide = column?.edge !== "left" && topInset > 0 ? FIND_BAR_SLIDE_CLASS : null;
  return (
    <div ref={setAnchor} className="contents">
      {(column !== null || alone) && stack.above.length > 0 ? (
        <nav
          ref={setAbove}
          aria-label="Manager workspace"
          className={cn("absolute z-20 flex flex-col gap-3", slide)}
          style={{
            ...edge,
            top: aboveTop,
            width: column ? THREAD_DETAILS_CARD_WIDTH : undefined,
          }}
        >
          {renderEntries(stack.above)}
        </nav>
      ) : null}
      {column !== null && (stack.below.length > 0 || (teamsInColumn && teamCards.length > 0)) ? (
        <div
          ref={setBelow}
          className={cn("absolute z-20", slide)}
          style={{ ...edge, top: belowTop, width: THREAD_DETAILS_CARD_WIDTH, maxHeight: belowRoom }}
          data-factory-workspace-panel
        >
          <ScrollArea scrollFade className="max-h-[inherit]">
            <div className="flex flex-col gap-3">
              {renderEntries(stack.below)}
              {teamsInColumn && teamCards.length > 0 ? (
                <aside aria-label="Manager teams" className="contents">
                  {teamCards}
                </aside>
              ) : null}
            </div>
          </ScrollArea>
        </div>
      ) : null}
      {teamsVisible ? (
        <aside
          aria-label="Manager teams"
          className="absolute z-20"
          style={{
            right: placement.right,
            top: teamsTop,
            width: placement.width,
            height: teamsHeight,
          }}
          data-factory-workspace-panel
        >
          <ScrollArea scrollFade className="h-full">
            <div className="flex flex-col gap-3">{teamCards}</div>
          </ScrollArea>
        </aside>
      ) : null}
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
  const asks = assignment.protectedPathAsks ?? [];
  return (
    <section aria-label={assignment.title} className={`${FACTORY_CARD_CLASS} p-2`}>
      <div className="px-2.5 py-1.5 select-none">
        <Tooltip>
          <TooltipTrigger render={<h3 className="line-clamp-2 text-sm font-medium break-words" />}>
            {assignment.title}
          </TooltipTrigger>
          <TooltipPopup side="left">{assignment.title}</TooltipPopup>
        </Tooltip>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FactoryStateDot state={assignment.state} />
          <span className="min-w-0 truncate">
            {FACTORY_ASSIGNMENT_STATE_LABEL[assignment.state]} ·{" "}
            {threads.length === 0
              ? "No threads yet"
              : `${threads.length} ${threads.length === 1 ? "thread" : "threads"}`}
          </span>
        </p>
      </div>
      {/* Asks wait on the user, so they come before the threads that raised them. */}
      <FactoryProtectedPathAsks
        environmentId={props.environmentId}
        assignmentId={assignment.id}
        asks={asks}
      />
      {threads.length === 0 ? null : (
        <ul
          className={cn(
            "m-0 flex list-none flex-col",
            asks.length > 0 && "mt-1 border-t border-border/65 pt-1",
          )}
        >
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
      )}
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
  const text = factoryTeamRowText(shell?.title, props.label);
  return (
    <li className={props.current ? CURRENT_ROW_CLASS : undefined}>
      <ThreadDetailsControl
        part="row"
        aria-current={props.current ? "page" : undefined}
        onClick={props.onOpen}
      >
        {/* A dot only when the thread has a state; an idle one shows the agent icon instead. */}
        <span className="flex size-4 shrink-0 items-center justify-center">
          {status ? (
            <ThreadStatusLabel status={status} compact />
          ) : (
            <BotIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{text.title}</span>
        {text.label === null ? null : (
          <span className="shrink-0 text-xs font-normal text-muted-foreground">{text.label}</span>
        )}
      </ThreadDetailsControl>
    </li>
  );
}
