import { DndContext, type DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type {
  IssueAttempt,
  EnvironmentId,
  IssueBoardItem,
  IssueBoardMapping,
  IssueBoardSummary,
  IssueBoardView,
  IssueMove,
  IssueSummary,
  ProjectId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  Columns3Icon,
  GripVerticalIcon,
  ListFilterIcon,
  ListIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  TicketIcon,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import { cn, randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BoardSyncStatus } from "./BoardSyncStatus";
import { IssueBoardConfigurationDialog } from "./IssueBoardConfigurationDialog";
import { IssueDetailDialog } from "./IssueDetailDialog";
import { IssueStartDialog } from "./IssueStartDialog";
import {
  type IssuesMode,
  type IssuesSearch,
  formatTicketParam,
  matchesTicketParam,
  writeIssuesNavigation,
} from "./issuesNavigation";
import {
  IssueRequestError,
  issueErrorMessage,
  issuesEnvironment,
  registerOpenIssueBoard,
  unwrapIssueResult,
  useDisconnectIssueBoard,
  useIssueBoardEnvironments,
  useIssueBoardSync,
} from "./issuesState";
import {
  DEFAULT_ISSUES_PREFERENCES,
  type IssuesPreferences,
  groupBoardColumns,
  issueMatchesFilters,
  readCachedBoardView,
  readIssuesPreferences,
  selectMoveBanners,
  writeCachedBoardView,
  writeIssuesPreferences,
} from "./issuesViewState";
import { WorkTabs } from "./WorkTabs";

const FOCUS_REFRESH_DEBOUNCE_MS = 250;
/** Alt-tabbing through windows should not become a host refresh per stop. */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 10_000;
const MOVED_ELSEWHERE = "This ticket moved on another device. Refresh before moving it again.";

type ColumnTone = "muted" | "progress" | "review" | "completed";

const columnTone = (columnId: string, mapping: IssueBoardMapping | null): ColumnTone =>
  columnId === mapping?.inProgress
    ? "progress"
    : columnId === mapping?.inPullRequest
      ? "review"
      : columnId === mapping?.completed
        ? "completed"
        : "muted";

const ticketKey = (ref: IssueBoardItem["issue"]["ref"]) =>
  [ref.host.toLowerCase(), ref.repository.toLowerCase(), ref.id].join("\n");

const BoardCard = memo(function BoardCard({
  item,
  attempt,
  disabled,
  onOpen,
}: {
  readonly item: IssueBoardItem;
  readonly attempt: IssueAttempt | undefined;
  readonly disabled: boolean;
  readonly onOpen: (item: IssueBoardItem) => void;
}) {
  const drag = useDraggable({ id: item.itemId, disabled });
  return (
    <div
      ref={drag.setNodeRef}
      style={{
        transform: CSS.Translate.toString(drag.transform),
        opacity: drag.isDragging ? 0.5 : 1,
      }}
      className="flex gap-1 rounded-lg border border-border/60 bg-card/40 p-3 hover:bg-accent/40"
    >
      <button
        type="button"
        {...drag.listeners}
        {...drag.attributes}
        aria-label={`Drag ticket ${item.issue.ref.number}`}
        className="cursor-grab touch-none self-start rounded-sm text-muted-foreground/50 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            #{item.issue.ref.number}
          </span>
          {attempt ? (
            <Badge size="sm" variant={attempt.automaticMoves === "paused" ? "warning" : "success"}>
              {attempt.automaticMoves === "paused" ? "Paused" : "Active"}
            </Badge>
          ) : null}
        </span>
        <p className="mt-2 text-sm leading-snug">{item.issue.title}</p>
        {item.issue.labels.length ? (
          <p className="mt-2 truncate text-xs text-muted-foreground">
            {item.issue.labels.join(" · ")}
          </p>
        ) : null}
      </button>
    </div>
  );
});

const BoardColumn = memo(function BoardColumn({
  id,
  title,
  tone,
  items,
  activeAttempts,
  disabled,
  onOpen,
}: {
  readonly id: string;
  readonly title: string;
  readonly tone: ColumnTone;
  readonly items: ReadonlyArray<IssueBoardItem>;
  readonly activeAttempts: ReadonlyMap<string, IssueAttempt>;
  readonly disabled: boolean;
  readonly onOpen: (item: IssueBoardItem) => void;
}) {
  const drop = useDroppable({ id });
  return (
    <section
      ref={drop.setNodeRef}
      className={cn(
        "min-h-64 w-72 shrink-0 rounded-xl bg-muted/30 p-2",
        drop.isOver && "ring-1 ring-inset ring-primary",
      )}
    >
      <h2 className="flex items-center gap-2 px-1 py-2 text-sm font-medium">
        <span
          className={cn(
            "size-2 rounded-full",
            tone === "progress" && "bg-warning",
            tone === "review" && "bg-primary",
            tone === "completed" && "bg-success",
            tone === "muted" && "bg-muted-foreground/50",
          )}
        />
        {title}
        <span className="text-xs font-normal tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </h2>
      <div className="mt-2 space-y-2">
        {items.map((item) => (
          <BoardCard
            key={item.itemId}
            item={item}
            attempt={activeAttempts.get(ticketKey(item.issue.ref))}
            disabled={disabled}
            onOpen={onOpen}
          />
        ))}
      </div>
      {items.length === 0 ? (
        <p className="px-2 py-5 text-xs text-muted-foreground">No tickets in this column</p>
      ) : null}
    </section>
  );
});

function PickerMenu({
  label,
  current,
  value,
  options,
  footer,
  onChange,
}: {
  readonly label: string;
  readonly current: string;
  readonly value: string;
  readonly options: ReadonlyArray<{ value: string; label: string; note?: string }>;
  readonly footer?: ReactNode;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger aria-label={label} render={<Button variant="outline" size="sm" />}>
        <span className="max-w-48 truncate">{current}</span>
        <ChevronDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start">
        {options.length ? (
          <MenuRadioGroup value={value} onValueChange={(next) => onChange(String(next))}>
            {options.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.note ? (
                  <span className="text-xs text-muted-foreground">{option.note}</span>
                ) : null}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        ) : null}
        {footer ? (
          <>
            {options.length ? <MenuSeparator /> : null}
            {footer}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function Notice({ tone, children }: { readonly tone?: "error"; readonly children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn("text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground")}
    >
      {children}
    </p>
  );
}

const keyOf = (...parts: ReadonlyArray<string>) => parts.join("\n");

/**
 * The Issues workspace: one connected board of one project on one environment, as columns or as
 * the repository's issue list, with the ticket detail, Start, and board configuration dialogs.
 */
export function IssuesBoard({
  search,
  onSearchChange,
}: {
  readonly search: IssuesSearch;
  readonly onSearchChange: (search: IssuesSearch, options?: { readonly replace?: boolean }) => void;
}) {
  const issueEnvironments = useIssueBoardEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment =
    issueEnvironments.find((candidate) => candidate.environmentId === search.environmentId) ??
    issueEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    issueEnvironments[0];
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const mode: IssuesMode = search.mode ?? "board";

  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) => project.environmentId === environmentId && project.isScratch !== true,
      ),
    [allProjects, environmentId],
  );

  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });
  const openBoard = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });
  const listIssues = useAtomCommand(issuesEnvironment.list, { reportFailure: false });
  const moveCommand = useAtomCommand(issuesEnvironment.move, { reportFailure: false });
  const retryMove = useAtomCommand(issuesEnvironment.retryMove, { reportFailure: false });
  const disconnectBoard = useDisconnectIssueBoard();

  // Every connected board on the environment, so the default board and "No board" are known.
  const [connectedBoards, setConnectedBoards] = useState<{
    readonly environmentId: EnvironmentId;
    readonly boards: ReadonlyArray<IssueBoardSummary>;
  } | null>(null);
  const [boardsRevision, setBoardsRevision] = useState(0);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  useEffect(() => {
    if (!environmentId || !connected) return;
    let current = true;
    setBoardsError(null);
    void listBoards({ environmentId, input: { connectedOnly: true } })
      .then(unwrapIssueResult)
      .then((boards) => {
        if (current) setConnectedBoards({ environmentId, boards });
      })
      .catch((failure: unknown) => {
        if (current) setBoardsError(issueErrorMessage(failure));
      });
    return () => {
      current = false;
    };
  }, [boardsRevision, connected, environmentId, listBoards]);
  const boards =
    connectedBoards?.environmentId === environmentId
      ? connectedBoards.boards.filter((board) => board.mapping !== null)
      : null;

  const projectIds = new Set(projects.map((project) => project.id));
  const projectId: ProjectId | null =
    search.projectId && projectIds.has(search.projectId)
      ? search.projectId
      : boards === null
        ? connected
          ? null
          : (projects[0]?.id ?? null)
        : (boards.find((board) => board.id === search.boardId && projectIds.has(board.projectId))
            ?.projectId ??
          boards.find((board) => projectIds.has(board.projectId))?.projectId ??
          projects[0]?.id ??
          null);
  const project = projects.find((candidate) => candidate.id === projectId);
  const projectBoards = boards?.filter((board) => board.projectId === projectId) ?? [];
  const boardId =
    search.boardId &&
    (boards === null || projectBoards.some((board) => board.id === search.boardId))
      ? search.boardId
      : (projectBoards[0]?.id ?? null);
  const requestedBoardMissing =
    boards !== null &&
    boardId !== null &&
    search.boardId !== undefined &&
    search.boardId !== boardId;
  const scopeKey = environmentId && projectId ? keyOf(environmentId, projectId) : null;
  const viewKey = scopeKey && boardId ? keyOf(scopeKey, boardId) : null;

  const navigate = useCallback(
    (
      patch: { readonly [K in keyof IssuesSearch]?: IssuesSearch[K] | undefined },
      replace = false,
    ) => {
      const next = {
        environmentId: environmentId ?? undefined,
        projectId: projectId ?? undefined,
        boardId: boardId ?? undefined,
        ticket: search.ticket,
        mode: search.mode,
        ...patch,
      };
      onSearchChange(
        Object.fromEntries(
          Object.entries(next).filter(([, value]) => value !== undefined),
        ) as IssuesSearch,
        { replace },
      );
    },
    [boardId, environmentId, onSearchChange, projectId, search.mode, search.ticket],
  );

  // Written once the selection is settled, so a cold start never overwrites the remembered one.
  useEffect(() => {
    if (!environmentId || boards === null) return;
    if (search.environmentId && search.environmentId !== environmentId) return;
    writeIssuesNavigation({
      environmentId,
      ...(projectId ? { projectId } : {}),
      ...(boardId ? { boardId } : {}),
      ...(search.ticket ? { ticket: search.ticket } : {}),
      mode,
    });
  }, [boardId, boards === null, environmentId, mode, projectId, search.ticket]);

  // A cached copy paints while the server's stored copy loads.
  const [loaded, setLoaded] = useState<{ key: string; view: IssueBoardView } | null>(null);
  const [viewError, setViewError] = useState<{ key: string; message: string } | null>(null);
  const view =
    loaded?.key === viewKey ? loaded.view : viewKey ? (readCachedBoardView(viewKey) ?? null) : null;
  const viewFresh = loaded !== null && loaded.key === viewKey;
  const generation = useRef(0);
  const showView = useCallback((key: string, next: IssueBoardView | null) => {
    writeCachedBoardView(key, next);
    setLoaded(next ? { key, view: next } : null);
  }, []);
  const openView = useCallback(
    async (refresh: boolean) => {
      if (!viewKey || !environmentId || !projectId || !boardId || !connected) return;
      const key = viewKey;
      const current = ++generation.current;
      try {
        const result = unwrapIssueResult(
          await openBoard({
            environmentId,
            input: { projectId, boardId, ...(refresh ? { refresh: true } : {}) },
          }),
        );
        if (current !== generation.current) return;
        showView(key, result);
        setViewError(null);
      } catch (failure) {
        const message = issueErrorMessage(failure);
        if (current === generation.current && message) setViewError({ key, message });
      }
    },
    [boardId, connected, environmentId, openBoard, projectId, showView, viewKey],
  );
  useEffect(() => {
    void openView(false);
  }, [openView]);

  const serverSync = useIssueBoardSync(
    view && connected && environmentId && projectId && boardId
      ? { environmentId, projectId, boardId }
      : null,
  );
  useEffect(() => {
    if (!view?.sync || !viewKey || serverSync === undefined) return;
    if (serverSync === null) {
      showView(viewKey, null);
      setBoardsRevision((revision) => revision + 1);
      return;
    }
    if (serverSync.revision > view.sync.revision) void openView(false);
  }, [serverSync?.revision, serverSync === null, viewKey]);
  const displaySync = serverSync ?? view?.sync;

  const hasView = view !== null;
  const lastFocusRefresh = useRef(0);
  useEffect(() => {
    if (!hasView || !connected) return;
    let timeout: number | null = null;
    const schedule = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        timeout = null;
        if (Date.now() - lastFocusRefresh.current < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
        lastFocusRefresh.current = Date.now();
        void openView(true);
      }, FOCUS_REFRESH_DEBOUNCE_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule();
    };
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timeout !== null) window.clearTimeout(timeout);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [connected, hasView, openView]);

  const refreshBoard = useCallback(() => void openView(true), [openView]);
  useEffect(
    () => (hasView && connected ? registerOpenIssueBoard(refreshBoard) : undefined),
    [connected, hasView, refreshBoard],
  );

  // Search and filters belong to the project; the URL carries the rest.
  const storedPreferences = useMemo(
    () => (scopeKey ? readIssuesPreferences(scopeKey) : null),
    [scopeKey],
  );
  const [editedPreferences, setEditedPreferences] = useState<{
    key: string;
    value: IssuesPreferences;
  } | null>(null);
  const preferences =
    (editedPreferences?.key === scopeKey ? editedPreferences.value : storedPreferences) ??
    DEFAULT_ISSUES_PREFERENCES;
  const updatePreferences = (patch: Partial<IssuesPreferences>) => {
    if (!scopeKey) return;
    const value = { ...preferences, ...patch };
    setEditedPreferences({ key: scopeKey, value });
    writeIssuesPreferences(scopeKey, value);
  };
  const query = useDeferredValue(preferences.query);

  // A remembered board that is gone falls back to another; its ticket and filter do not carry over.
  // The notice stays until the person picks another board or project.
  const [fellBackTo, setFellBackTo] = useState<string | null>(null);
  const fellBack = fellBackTo !== null && fellBackTo === viewKey;
  useEffect(() => {
    if (!requestedBoardMissing) return;
    setFellBackTo(viewKey);
    updatePreferences({ query: "", issueState: "all", issueHost: "all" });
    navigate({ boardId: boardId ?? undefined, ticket: undefined }, true);
  }, [requestedBoardMissing]);

  // The repository's issues, loaded when list mode first shows them.
  const [issueList, setIssueList] = useState<{
    key: string;
    issues: ReadonlyArray<IssueSummary>;
    nextCursor: string | null;
  } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listPending, setListPending] = useState(false);
  const listedIssues = issueList?.key === scopeKey ? issueList : null;
  const loadIssues = useCallback(
    async (cursor: string | null) => {
      if (!scopeKey || !environmentId || !projectId || !connected) return;
      const key = scopeKey;
      setListPending(true);
      setListError(null);
      try {
        const result = unwrapIssueResult(
          await listIssues({
            environmentId,
            input: { projectId, ...(cursor ? { cursor } : {}) },
          }),
        );
        setIssueList((current) => ({
          key,
          issues:
            cursor && current?.key === key ? [...current.issues, ...result.issues] : result.issues,
          nextCursor: result.nextCursor,
        }));
      } catch (failure) {
        setListError(issueErrorMessage(failure));
      } finally {
        setListPending(false);
      }
    },
    [connected, environmentId, listIssues, projectId, scopeKey],
  );
  const listLoaded = listedIssues !== null;
  useEffect(() => {
    if (mode === "list" && !listLoaded) void loadIssues(null);
  }, [listLoaded, loadIssues, mode]);

  const grouped = useMemo(() => (view ? groupBoardColumns(view, query) : null), [query, view]);
  const activeAttempts = useMemo(
    () =>
      new Map(
        (view?.attempts ?? [])
          .filter((attempt) => attempt.active)
          .map((attempt) => [ticketKey(attempt.issue), attempt] as const),
      ),
    [view],
  );
  const { issueState, issueHost } = preferences;
  const filteredIssues = useMemo(
    () =>
      (listedIssues?.issues ?? []).filter((issue) =>
        issueMatchesFilters(issue, { issueState, issueHost, query }),
      ),
    [issueHost, issueState, listedIssues, query],
  );

  const columnTitle = useCallback(
    (columnId: string) => view?.columns.find((column) => column.id === columnId)?.title ?? columnId,
    [view],
  );
  const banners = useMemo(
    () => (view ? selectMoveBanners(view.moves, columnTitle) : []),
    [columnTitle, view],
  );

  const selectedItem = useMemo((): IssueBoardItem | null => {
    const ticket = search.ticket;
    if (!ticket) return null;
    const onBoard = view?.items.find((item) => matchesTicketParam(ticket, item.issue.ref));
    if (onBoard) return onBoard;
    const listed = listedIssues?.issues.find((issue) => matchesTicketParam(ticket, issue.ref));
    return listed ? { issue: listed, itemId: listed.ref.id, columnId: null, version: null } : null;
  }, [listedIssues, search.ticket, view]);
  // A remembered ticket that left the board is dropped once the fresh copy shows it gone.
  useEffect(() => {
    if (search.ticket && mode === "board" && viewFresh && !selectedItem) {
      navigate({ ticket: undefined }, true);
    }
  }, [mode, search.ticket, selectedItem, viewFresh]);

  const openTicket = useCallback(
    (item: IssueBoardItem) => {
      const refs = [
        ...(view?.items.map((candidate) => candidate.issue.ref) ?? []),
        ...(listedIssues?.issues.map((issue) => issue.ref) ?? []),
      ];
      navigate({ ticket: formatTicketParam(item.issue.ref, refs) });
    },
    [listedIssues, navigate, view],
  );

  const [starting, setStarting] = useState<IssueBoardItem | null>(null);
  const [configuring, setConfiguring] = useState<IssueBoardView | "new" | null>(null);
  const [moving, setMoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (search.connect && environmentId && projectId && connected) {
      setConfiguring("new");
      navigate({ connect: undefined }, true);
    }
  }, [connected, environmentId, projectId, search.connect]);

  const moveItem = async (item: IssueBoardItem, columnId: string) => {
    if (!view || !viewKey || !environmentId || !connected || item.columnId === columnId) return;
    const key = viewKey;
    setMoving(true);
    setActionError(null);
    showView(key, {
      ...view,
      items: view.items.map((candidate) =>
        candidate.itemId === item.itemId ? { ...candidate, columnId } : candidate,
      ),
    });
    try {
      unwrapIssueResult(
        await moveCommand({
          environmentId,
          input: {
            requestId: randomUUID(),
            boardId: view.board.id,
            issue: item.issue.ref,
            columnId,
            expectedPlacement: item.columnId,
          },
        }),
      );
    } catch (failure) {
      setActionError(
        failure instanceof IssueRequestError && failure.reason === "conflict"
          ? MOVED_ELSEWHERE
          : issueErrorMessage(failure),
      );
    } finally {
      setMoving(false);
      void openView(false);
    }
  };

  const retry = async (move: IssueMove) => {
    if (!environmentId || !connected) return;
    setActionError(null);
    try {
      unwrapIssueResult(
        await retryMove({ environmentId, input: { requestId: randomUUID(), moveId: move.id } }),
      );
    } catch (failure) {
      setActionError(issueErrorMessage(failure));
    } finally {
      void openView(false);
    }
  };

  const disconnect = async () => {
    if (!view || !viewKey || !environmentId || !connected) return;
    setActionError(null);
    try {
      if (!(await disconnectBoard(environmentId, view.board))) return;
      const removed = view.board.id;
      setConnectedBoards((current) =>
        current
          ? { ...current, boards: current.boards.filter((board) => board.id !== removed) }
          : current,
      );
      showView(viewKey, null);
      setBoardsRevision((revision) => revision + 1);
      navigate({ boardId: undefined, ticket: undefined });
    } catch (failure) {
      setActionError(issueErrorMessage(failure));
    }
  };

  const dragEnd = (event: DragEndEvent) => {
    const item = view?.items.find((candidate) => candidate.itemId === event.active.id);
    const target = event.over?.id;
    if (item && target !== undefined && view?.columns.some((column) => column.id === target)) {
      void moveItem(item, String(target));
    }
  };

  const projectsWithBoards = new Set(boards?.map((board) => board.projectId));
  const dragDisabled = moving || !connected || !view?.board.mapping;
  const visibleError =
    actionError ??
    (viewError?.key === viewKey ? viewError.message : null) ??
    boardsError ??
    (mode === "list" ? listError : null);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <WorkTabs current="issues" />
        {view ? (
          <BoardSyncStatus sync={displaySync} retryDisabled={!connected} onRetry={refreshBoard} />
        ) : null}
        <div className="min-w-0 flex-1" />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh board"
          disabled={!view || !connected}
          onClick={refreshBoard}
        >
          <RefreshIcon size="md" />
        </Button>
      </WorkspacePageHeader>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6",
          mode === "board" && view ? "overflow-hidden" : "overflow-y-auto",
        )}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {issueEnvironments.length > 1 ? (
            <PickerMenu
              label="Environment"
              current={environment?.label ?? "Choose an environment"}
              value={environmentId ?? ""}
              options={issueEnvironments.map((candidate) => ({
                value: candidate.environmentId,
                label: candidate.label,
              }))}
              onChange={(value) => onSearchChange({ environmentId: value as EnvironmentId, mode })}
            />
          ) : null}
          {projects.length ? (
            <PickerMenu
              label="Project"
              current={project?.title ?? "Choose a project"}
              value={projectId ?? ""}
              options={projects.map((candidate) => ({
                value: candidate.id,
                label: candidate.title,
                ...(boards && !projectsWithBoards.has(candidate.id) ? { note: "No board" } : {}),
              }))}
              onChange={(value) =>
                environmentId &&
                onSearchChange({ environmentId, projectId: value as ProjectId, mode })
              }
            />
          ) : null}
          {mode === "board" && project ? (
            <PickerMenu
              label="Board"
              current={view?.board.title ?? (projectBoards.length ? "Choose a board" : "No board")}
              value={boardId ?? ""}
              options={projectBoards.map((board) => ({ value: board.id, label: board.title }))}
              onChange={(value) => navigate({ boardId: value, ticket: undefined })}
              footer={
                <MenuItem disabled={!connected} onClick={() => setConfiguring("new")}>
                  <PlusIcon />
                  Connect board
                </MenuItem>
              }
            />
          ) : null}
          {mode === "list" ? (
            <Menu>
              <MenuTrigger render={<Button size="sm" variant="ghost" />}>
                <ListFilterIcon />
                Filters
                {preferences.issueState !== "all" || preferences.issueHost !== "all"
                  ? ` · ${Number(preferences.issueState !== "all") + Number(preferences.issueHost !== "all")}`
                  : ""}
              </MenuTrigger>
              <MenuPopup>
                <MenuRadioGroup
                  value={preferences.issueState}
                  onValueChange={(value) => updatePreferences({ issueState: String(value) })}
                >
                  <MenuGroupLabel>State</MenuGroupLabel>
                  <MenuRadioItem value="all">All states</MenuRadioItem>
                  {[...new Set(listedIssues?.issues.map((issue) => issue.state))].map((state) => (
                    <MenuRadioItem key={state} value={state}>
                      {state}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuRadioGroup
                  value={preferences.issueHost}
                  onValueChange={(value) => updatePreferences({ issueHost: String(value) })}
                >
                  <MenuGroupLabel>Repository host</MenuGroupLabel>
                  <MenuRadioItem value="all">All hosts</MenuRadioItem>
                  {[...new Set(listedIssues?.issues.map((issue) => issue.ref.host))].map((host) => (
                    <MenuRadioItem key={host} value={host}>
                      {host}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuItem
                  onClick={() => updatePreferences({ issueState: "all", issueHost: "all" })}
                >
                  Clear filters
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Issues view">
            <Button
              size="icon-sm"
              aria-label="Issue list"
              aria-pressed={mode === "list"}
              variant={mode === "list" ? "secondary" : "ghost"}
              onClick={() => navigate({ mode: "list" })}
            >
              <ListIcon />
            </Button>
            <Button
              size="icon-sm"
              aria-label="Board"
              aria-pressed={mode === "board"}
              variant={mode === "board" ? "secondary" : "ghost"}
              onClick={() => navigate({ mode: "board" })}
            >
              <Columns3Icon />
            </Button>
            <Menu>
              <MenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="Board settings" />}
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  {view ? (
                    <MenuItem disabled={!connected} onClick={() => setConfiguring(view)}>
                      Configure columns
                    </MenuItem>
                  ) : null}
                  <MenuItem disabled={!project || !connected} onClick={() => setConfiguring("new")}>
                    Connect board
                  </MenuItem>
                  {view ? (
                    <MenuItem disabled={!connected} onClick={refreshBoard}>
                      Refresh board
                    </MenuItem>
                  ) : null}
                </MenuGroup>
                {view ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      variant="destructive"
                      disabled={!connected}
                      onClick={() => void disconnect()}
                    >
                      Disconnect board
                    </MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          </div>
        </div>
        {mode === "list" || view ? (
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search tickets"
              placeholder="Search by title or #number"
              value={preferences.query}
              onChange={(event) => updatePreferences({ query: event.target.value })}
            />
          </InputGroup>
        ) : null}
        {environment && !connected ? (
          <Notice>
            {environment.label} is not connected. The last loaded board stays visible; reconnect to
            update it.
          </Notice>
        ) : null}
        {issueEnvironments.length === 0 ? (
          <Notice>
            Issues are unavailable. Connect an environment that supports issue boards.
          </Notice>
        ) : environment && projects.length === 0 ? (
          <Notice>Add a project to {environment.label} to connect its board.</Notice>
        ) : null}
        {requestedBoardMissing || fellBack ? (
          <Notice>The requested board is no longer connected. Showing this project's board.</Notice>
        ) : null}
        {visibleError ? <Notice tone="error">{visibleError}</Notice> : null}
        {mode === "board"
          ? banners.map(({ move, message }) => (
              <Alert
                key={move.id}
                variant={
                  move.status === "failed"
                    ? "error"
                    : move.status === "pending"
                      ? "info"
                      : "warning"
                }
              >
                <AlertDescription>
                  #{move.issue.number} · {message}
                </AlertDescription>
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!connected}
                    onClick={() => void retry(move)}
                  >
                    {move.status === "pending" ? "Retry now" : "Retry"}
                  </Button>
                </AlertAction>
              </Alert>
            ))
          : null}
        {mode === "board" && project && boards !== null && !boardId && connected ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Columns3Icon />
              </EmptyMedia>
              <EmptyTitle>No board connected to {project.title}</EmptyTitle>
              <EmptyDescription>
                Connect an existing GitHub Project or Azure DevOps board to work on its tickets
                here.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => setConfiguring("new")}>
                <PlusIcon />
                Connect board
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate({ mode: "list" })}>
                View repository issues
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
        {mode === "board" && boardId && !view && connected && !visibleError ? (
          <Notice>Loading board…</Notice>
        ) : null}
        {mode === "list" ? (
          <section>
            <div className="space-y-1">
              {filteredIssues.map((issue) => (
                <button
                  type="button"
                  key={keyOf(issue.ref.host, issue.ref.repository, issue.ref.id)}
                  className={cn(
                    PULL_REQUEST_ROW_CLASS,
                    "px-2 py-2 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  )}
                  onClick={() =>
                    openTicket(
                      view?.items.find(
                        (item) =>
                          item.issue.ref.id === issue.ref.id &&
                          item.issue.ref.repository === issue.ref.repository,
                      ) ?? { issue, itemId: issue.ref.id, columnId: null, version: null },
                    )
                  }
                >
                  <TicketIcon className="size-4 shrink-0 text-muted-foreground" />
                  <PullRequestRowLines
                    number={
                      <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{issue.ref.number}</span>
                    }
                    title={issue.title}
                    meta={
                      <>
                        <span>{issue.state}</span>
                        <span>{issue.ref.repository}</span>
                        <span className="truncate">{issue.labels.join(" · ")}</span>
                      </>
                    }
                  />
                </button>
              ))}
            </div>
            {listedIssues?.nextCursor ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!connected || listPending}
                onClick={() => void loadIssues(listedIssues.nextCursor)}
              >
                Load more
              </Button>
            ) : null}
            {listPending && !listedIssues ? <Notice>Loading issues…</Notice> : null}
            {listedIssues && filteredIssues.length === 0 ? (
              <Notice>
                {listedIssues.issues.length ? "No issues match." : "No issues in this repository."}
              </Notice>
            ) : null}
          </section>
        ) : null}
        {mode === "board" && view && grouped ? (
          <DndContext onDragEnd={dragEnd}>
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="flex min-h-full w-max min-w-full items-stretch gap-3 pb-4">
                {grouped.columns.map(({ column, items }) => (
                  <BoardColumn
                    key={column.id}
                    id={column.id}
                    title={column.title}
                    tone={columnTone(column.id, view.board.mapping)}
                    items={items}
                    activeAttempts={activeAttempts}
                    disabled={dragDisabled}
                    onOpen={openTicket}
                  />
                ))}
                {grouped.unassigned.length ? (
                  <BoardColumn
                    id="unassigned"
                    title="Unassigned"
                    tone="muted"
                    items={grouped.unassigned}
                    activeAttempts={activeAttempts}
                    disabled={dragDisabled}
                    onOpen={openTicket}
                  />
                ) : null}
              </div>
            </div>
          </DndContext>
        ) : null}
      </div>
      {selectedItem && environmentId && !starting ? (
        <IssueDetailDialog
          key={keyOf(
            selectedItem.issue.ref.host,
            selectedItem.issue.ref.repository,
            selectedItem.issue.ref.id,
          )}
          environmentId={environmentId}
          project={project}
          view={view}
          item={selectedItem}
          connected={connected}
          moving={moving}
          onClose={() => navigate({ ticket: undefined })}
          onStart={() => {
            setStarting(selectedItem);
            navigate({ ticket: undefined });
          }}
          onMove={(columnId) => void moveItem(selectedItem, columnId)}
          onAttemptsChanged={() => void openView(false)}
        />
      ) : null}
      {starting && view && environmentId ? (
        <IssueStartDialog
          environmentId={environmentId}
          board={view.board}
          item={starting}
          onClose={() => setStarting(null)}
        />
      ) : null}
      {configuring && environmentId && projectId && connected ? (
        <IssueBoardConfigurationDialog
          environmentId={environmentId}
          projects={projects.filter((candidate) => candidate.id === projectId)}
          initialProjectId={projectId}
          initial={configuring === "new" ? null : configuring}
          onClose={() => setConfiguring(null)}
          onConfigured={(result) => {
            setConfiguring(null);
            showView(keyOf(environmentId, result.board.projectId, result.board.id), result);
            setConnectedBoards((current) =>
              current?.environmentId === environmentId
                ? {
                    ...current,
                    boards: [
                      ...current.boards.filter((board) => board.id !== result.board.id),
                      result.board,
                    ],
                  }
                : current,
            );
            setBoardsRevision((revision) => revision + 1);
            navigate({
              projectId: result.board.projectId,
              boardId: result.board.id,
              mode: "board",
            });
          }}
        />
      ) : null}
    </SidebarInset>
  );
}
