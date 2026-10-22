import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FactoryRole,
  FactoryWorkspaceAssignment,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useChatCanvas } from "../chat/ChatCanvasContext";
import {
  resolveThreadDetailsCardLayout,
  THREAD_DETAILS_CARD_GAP,
} from "../chat/threadDetailsCardLayout";
import { RelativeTime } from "../RelativeTime";
import { ThreadRowLeadingStatus } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { factoryEnvironment, factoryErrorMessage } from "./factoryState";
import { useFactoryWorkspaceFeed } from "./factoryWorkspaceState";
import {
  checklistProgress,
  FACTORY_ASSIGNMENT_STATE_LABEL,
  FACTORY_DIGEST_STALE_MS,
  FACTORY_ROLE_LABEL,
  resolveFactoryWorkspaceView,
  type FactoryWorkspaceTeam,
} from "./factoryWorkspaceLogic";

/** Below this the two cards would be unreadable; the column waits for the details card to close. */
const MIN_COLUMN_HEIGHT = 220;
const UP_TO_DATE_MS = 4_000;

/**
 * The right-hand column of a manager's workspace: what each team is doing, and every team thread.
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
          <FactoryTeamActivityCard environmentId={props.environmentId} teams={view.teams} />
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

function WorkspaceCard(props: {
  readonly label: string;
  readonly fill: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={props.label}
      className={cn(
        "dropdown-glass isolate contain-paint flex min-h-0 flex-col overflow-hidden rounded-3xl",
        props.fill ? "flex-1" : "max-h-[45%] shrink-0",
      )}
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

type RefreshStatus = { readonly assignmentId: string; readonly kind: "refreshing" | "up-to-date" };

/** One tab per live work item, each with its team's running digest. Nothing streams. */
export function FactoryTeamActivityCard(props: {
  readonly environmentId: EnvironmentId;
  readonly teams: ReadonlyArray<FactoryWorkspaceTeam>;
}) {
  const refreshDigest = useAtomCommand(factoryEnvironment.refreshDigest, { reportFailure: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const selected =
    props.teams.find((team) => team.assignment.id === selectedId) ?? props.teams[0] ?? null;
  const selectedKey = selected?.assignment.id ?? null;

  const refresh = async (assignment: FactoryWorkspaceAssignment) => {
    const before = assignment.digest?.generatedAt ?? null;
    setStatus({ assignmentId: assignment.id, kind: "refreshing" });
    const result = await refreshDigest({
      environmentId: props.environmentId,
      input: { assignmentId: assignment.id },
    });
    if (result._tag === "Success") {
      const after = result.value.digest?.generatedAt ?? null;
      setStatus(after === before ? { assignmentId: assignment.id, kind: "up-to-date" } : null);
      return;
    }
    setStatus(null);
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not refresh the digest",
        description: factoryErrorMessage(squashAtomCommandFailure(result)) ?? undefined,
      });
    }
  };

  // Opening a tab rewrites a missing or stale digest once; later reads keep what it got.
  const refreshOnOpen = useEffectEvent(() => {
    const assignment = selected?.assignment;
    if (!assignment) return;
    const generatedAt = assignment.digest ? Date.parse(assignment.digest.generatedAt) : null;
    if (generatedAt !== null && Date.now() - generatedAt <= FACTORY_DIGEST_STALE_MS) return;
    // In the background: the feed brings the new digest, and a failure here is not worth a toast.
    void refreshDigest({
      environmentId: props.environmentId,
      input: { assignmentId: assignment.id },
    });
  });
  useEffect(() => {
    if (selectedKey !== null) refreshOnOpen();
  }, [selectedKey]);

  const upToDate = status?.kind === "up-to-date";
  useEffect(() => {
    if (!upToDate) return;
    const timeout = window.setTimeout(() => setStatus(null), UP_TO_DATE_MS);
    return () => window.clearTimeout(timeout);
  }, [upToDate]);

  return (
    <WorkspaceCard label="Team activity" fill={false}>
      <CardHeading>Team activity</CardHeading>
      {selected === null ? (
        <p className="px-3.5 pb-3 text-xs text-muted-foreground">No work on the go.</p>
      ) : (
        <>
          <div role="tablist" aria-label="Work items" className="flex gap-1 overflow-x-auto px-2.5">
            {props.teams.map((team) => {
              const active = team.assignment.id === selected.assignment.id;
              return (
                <button
                  key={team.assignment.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedId(team.assignment.id)}
                  className={cn(
                    "max-w-40 shrink-0 cursor-pointer truncate rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    active
                      ? "bg-black/[0.05] text-foreground dark:bg-white/[0.08]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {team.assignment.title}
                </button>
              );
            })}
          </div>
          <TeamDigest
            assignment={selected.assignment}
            status={status?.assignmentId === selected.assignment.id ? status.kind : null}
            onRefresh={() => void refresh(selected.assignment)}
          />
        </>
      )}
    </WorkspaceCard>
  );
}

function TeamDigest(props: {
  readonly assignment: FactoryWorkspaceAssignment;
  readonly status: RefreshStatus["kind"] | null;
  readonly onRefresh: () => void;
}) {
  const { assignment } = props;
  const progress = checklistProgress(assignment.checklist);
  return (
    <div role="tabpanel" aria-label={assignment.title} className="flex min-h-0 flex-col">
      <ScrollArea scrollFade className="min-h-0">
        <p className="whitespace-pre-wrap px-3.5 pt-2 text-xs text-foreground/85">
          {assignment.digest?.text.trim() || "No digest yet"}
        </p>
      </ScrollArea>
      <div className="flex min-h-9 items-center gap-2 px-3.5 pb-2 text-2xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {FACTORY_ASSIGNMENT_STATE_LABEL[assignment.state]}
          {assignment.digest ? (
            <>
              {" · Updated "}
              <RelativeTime timestamp={assignment.digest.generatedAt} />
            </>
          ) : null}
          {progress.total > 0 ? ` · ${progress.done}/${progress.total}` : null}
        </span>
        {props.status === "up-to-date" ? (
          <span role="status">Up to date</span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.status === "refreshing"}
            onClick={props.onRefresh}
          >
            <RefreshCwIcon />
            {props.status === "refreshing" ? "Refreshing" : "Refresh"}
          </Button>
        )}
      </div>
    </div>
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
    <WorkspaceCard label="Team threads" fill>
      <CardHeading>Team threads</CardHeading>
      {props.threadId === props.managerThreadId ? null : (
        <div className="px-2.5 pb-1">
          <Button size="sm" variant="outline" onClick={() => open(props.managerThreadId)}>
            <ArrowLeftIcon />
            Manager
          </Button>
        </div>
      )}
      <ScrollArea scrollFade className="min-h-0 flex-1">
        {props.teams.length === 0 ? (
          <p className="px-3.5 pb-3 text-xs text-muted-foreground">No team threads yet.</p>
        ) : (
          <div className="flex flex-col gap-2 px-2 pb-2.5">
            {props.teams.map((team) => (
              <div key={team.assignment.id} role="group" aria-label={team.assignment.title}>
                <p className="truncate px-1.5 py-1 text-2xs font-medium text-muted-foreground">
                  {team.assignment.title}
                </p>
                <ul className="m-0 flex list-none flex-col p-0">
                  {team.threads.map((thread) => (
                    <TeamThreadRow
                      key={thread.threadId}
                      environmentId={props.environmentId}
                      threadId={thread.threadId}
                      role={thread.role}
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
  readonly role: FactoryRole;
  readonly current: boolean;
  readonly onOpen: () => void;
}) {
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  return (
    <li>
      <button
        type="button"
        aria-current={props.current ? "page" : undefined}
        onClick={props.onOpen}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 text-left text-sm outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-white/[0.08]",
          props.current && "bg-black/[0.05] dark:bg-white/[0.08]",
        )}
      >
        <span className="flex w-4 shrink-0 justify-center">
          {shell ? <ThreadRowLeadingStatus thread={shell} /> : null}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground/85">
          {shell?.title ?? "Thread"}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {FACTORY_ROLE_LABEL[props.role]}
        </span>
      </button>
    </li>
  );
}
