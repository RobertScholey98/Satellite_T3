import type {
  EnvironmentId,
  ProjectId,
  IssueBoardView,
  IssueBoardLocator,
  IssueBoardMapping,
  IssueBoardItem,
  IssueDetail,
  IssueBoardSummary,
  IssueSummary,
} from "@t3tools/contracts";

import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";

import { CSS } from "@dnd-kit/utilities";

import { useNavigate } from "@tanstack/react-router";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GripVerticalIcon,
  ListIcon,
  Columns3Icon,
  MoreHorizontalIcon,
  SearchIcon,
  TicketIcon,
  ListFilterIcon,
} from "lucide-react";

import { useProjects } from "~/state/entities";

import { useEnvironments } from "~/state/environments";

import { issuesEnvironment } from "~/state/issues";

import { useAtomCommand } from "~/state/use-atom-command";

import { randomUUID } from "~/lib/utils";

import { Button } from "../ui/button";

import { Input } from "../ui/input";

import { Switch } from "../ui/switch";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
} from "../ui/menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  PullRequestRowLines,
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
} from "../pullRequest/PullRequestListRow";
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";

import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

import { IssueStartDialog } from "./IssueStartDialog";

import { defaultIssueAttempt, issueCanStart } from "./work.logic";

import { unwrapWorkResult, workError } from "./commands";

function BoardCard({
  item,
  onOpen,
  disabled,
}: {
  item: IssueBoardItem;
  onOpen: () => void;
  disabled: boolean;
}) {
  const drag = useDraggable({ id: item.itemId, disabled });

  return (
    <div
      ref={drag.setNodeRef}
      style={{
        transform: CSS.Translate.toString(drag.transform),
        opacity: drag.isDragging ? 0.5 : 1,
      }}
      className="group flex gap-1 rounded-lg border border-border/60 bg-card/40 p-3 hover:bg-accent/40"
    >
      <button
        type="button"
        {...drag.listeners}
        {...drag.attributes}
        aria-label={`Drag issue ${item.issue.ref.number}`}
        className="cursor-grab touch-none self-start rounded-sm text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          #{item.issue.ref.number}
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
}

function BoardColumn({
  id,
  title,
  count,
  tone = "muted",
  children,
}: {
  id: string;
  title: string;
  count: number;
  tone?: "muted" | "progress" | "review" | "completed";
  children: React.ReactNode;
}) {
  const drop = useDroppable({ id });

  return (
    <section
      ref={drop.setNodeRef}
      className={`min-h-64 w-72 shrink-0 rounded-xl bg-muted/30 p-2 ${drop.isOver ? "ring-1 ring-primary" : ""}`}
    >
      <h2 className="flex items-center gap-2 px-1 py-2 text-sm font-medium">
        <span
          className={`size-2 rounded-full border ${tone === "progress" ? "border-warning bg-warning" : tone === "review" ? "border-primary bg-primary" : tone === "completed" ? "border-success bg-success" : "border-muted-foreground/70"}`}
        />
        {title}
        <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
      </h2>
      <div className="mt-2 space-y-2">{children}</div>
      {!count ? (
        <p className="px-2 py-5 text-xs text-muted-foreground">No issues in this column</p>
      ) : null}
    </section>
  );
}

export function IssuesBoard({
  target,
  onViewWork,
  onSelectBoard,
  onDismissIssue,
}: {
  target?: {
    environmentId?: EnvironmentId;
    projectId?: ProjectId;
    boardId?: string;
    issueId?: string;
  };
  onViewWork?: (target: { environmentId: EnvironmentId; worktreePath: string }) => void;
  onSelectBoard?: (target: {
    environmentId: EnvironmentId;
    projectId: ProjectId;
    boardId?: string;
  }) => void;
  onDismissIssue?: () => void;
}) {
  const projects = useProjects();

  const { environments } = useEnvironments();
  const targetKey = JSON.stringify(target ?? null);
  const [dismissedTargetKey, setDismissedTargetKey] = useState<string | null>(null);
  const activeTarget = dismissedTargetKey === targetKey ? undefined : target;

  const supported = projects.filter(
    (project) =>
      environments.find((environment) => environment.environmentId === project.environmentId)
        ?.serverConfig?.environment.capabilities.issueBoards === true,
  );

  const [scopeKey, setScopeKey] = useState(
    target?.environmentId && target.projectId ? `${target.environmentId}:${target.projectId}` : "",
  );
  const targetOpened = useRef<string | null>(null);
  useEffect(() => {
    if (target?.environmentId && target.projectId) {
      setScopeKey(`${target.environmentId}:${target.projectId}`);
    }
    targetOpened.current = null;
  }, [target?.environmentId, target?.projectId, target?.boardId, target?.issueId]);

  const scope = scopeKey
    ? supported.find((project) => `${project.environmentId}:${project.id}` === scopeKey)
    : activeTarget?.environmentId
      ? supported.find((project) => project.environmentId === activeTarget.environmentId)
      : supported[0];
  const scopedEnvironment = environments.find(
    (environment) => environment.environmentId === scope?.environmentId,
  );
  const connected = scopedEnvironment?.connection.phase === "connected";

  const [mode, setMode] = useState<"issues" | "board">("board");

  const [issueList, setIssueList] = useState<readonly IssueSummary[]>([]);

  const [query, setQuery] = useState("");
  const [issueState, setIssueState] = useState("all");
  const [issueHost, setIssueHost] = useState("all");

  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const detailGeneration = useRef(0);

  const listIssues = useAtomCommand(issuesEnvironment.list, { reportFailure: false });

  const [boards, setBoards] = useState<readonly IssueBoardSummary[]>([]);

  const [view, setView] = useState<IssueBoardView | null>(null);

  const [selected, setSelected] = useState<IssueBoardItem | null>(null);

  const [detail, setDetail] = useState<IssueDetail | null>(null);

  const [configuring, setConfiguring] = useState(false);

  const [connecting, setConnecting] = useState(false);

  const [starting, setStarting] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState(false);

  const generation = useRef(0);
  const scopeGeneration = useRef(0);

  const list = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });

  const open = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });

  const get = useAtomCommand(issuesEnvironment.get, { reportFailure: false });

  const move = useAtomCommand(issuesEnvironment.move, { reportFailure: false });

  const retry = useAtomCommand(issuesEnvironment.retryMove, { reportFailure: false });

  const disconnect = useAtomCommand(issuesEnvironment.disconnectBoard, { reportFailure: false });

  const navigate = useNavigate();

  const refresh = useCallback(
    async (boardId: string, locator?: IssueBoardLocator) => {
      if (!scope || !connected) return;

      const current = ++generation.current;

      setPending(true);
      setError(null);

      try {
        const result = unwrapWorkResult(
          await open({
            environmentId: scope.environmentId,
            input: {
              projectId: scope.id,
              ...((locator ??
              boards.find((board) => board.id === boardId && board.mapping === null)?.locator)
                ? { locator: locator ?? boards.find((board) => board.id === boardId)?.locator }
                : { boardId }),
            },
          }),
        );

        if (current === generation.current) {
          setView(result);
          setConfiguring(result.board.mapping === null);
          return result;
        }
      } catch (failure) {
        if (current === generation.current) setError(workError(failure));
      } finally {
        if (current === generation.current) setPending(false);
      }
    },
    [open, scope, connected, boards],
  );

  useEffect(() => {
    generation.current++;
    scopeGeneration.current++;
    detailGeneration.current++;
    setView(null);
    setBoards([]);
    setIssueList([]);
    setNextCursor(null);
    setSelected(null);
    setDetail(null);
    setError(null);
    setPending(false);
    setConnecting(false);
    setConfiguring(false);
    setStarting(false);
  }, [scope?.environmentId, scope?.id]);

  useEffect(() => {
    if (!scope || !connected) return;
    const current = ++scopeGeneration.current;

    setSelected(null);
    setError(null);

    detailGeneration.current++;

    if (!scope) return;

    setPending(true);

    void listIssues({ environmentId: scope.environmentId, input: { projectId: scope.id } })
      .then(unwrapWorkResult)
      .then((result) => {
        if (current === scopeGeneration.current) {
          setIssueList(result.issues);
          setNextCursor(result.nextCursor);
        }
      })
      .catch((failure) => {
        if (current === scopeGeneration.current) setError(workError(failure));
      });

    void list({ environmentId: scope.environmentId, input: { projectId: scope.id } })
      .then(unwrapWorkResult)
      .then(async (result) => {
        if (current !== scopeGeneration.current) return;

        setBoards(result);

        const requested = activeTarget?.boardId
          ? result.find((board) => board.id === activeTarget.boardId)
          : result[0];
        if (requested) await refresh(requested.id, requested.locator);
        else {
          setView(null);
          if (activeTarget?.boardId)
            setError(
              "The requested board is unavailable. Choose another board or connect it again.",
            );
        }
      })
      .catch((failure) => {
        if (current === scopeGeneration.current) setError(workError(failure));
      })
      .finally(() => {
        if (current === scopeGeneration.current) setPending(false);
      });

    return () => {
      generation.current++;
      scopeGeneration.current++;
    };
  }, [list, scope?.environmentId, scope?.id, connected, target?.boardId]);

  const select = useCallback(
    async (item: IssueBoardItem) => {
      if (!scope || !connected) return;

      const current = ++detailGeneration.current;

      setSelected(item);
      setDetail(null);
      setError(null);

      try {
        const result = unwrapWorkResult(
          await get({
            environmentId: scope.environmentId,
            input: { projectId: scope.id, issue: item.issue.ref },
          }),
        );
        if (current === detailGeneration.current) setDetail(result);
      } catch (failure) {
        if (current === detailGeneration.current) setError(workError(failure));
      }
    },
    [scope, connected, get],
  );

  useEffect(() => {
    if (!activeTarget?.issueId || !connected || !scope || pending) return;
    if (activeTarget.environmentId && activeTarget.environmentId !== scope.environmentId) return;
    if (activeTarget.projectId && activeTarget.projectId !== scope.id) return;
    if (activeTarget.boardId && activeTarget.boardId !== view?.board.id) return;
    const key = `${scope.environmentId}:${scope.id}:${activeTarget.boardId ?? ""}:${activeTarget.issueId}`;
    if (targetOpened.current === key) return;
    const item = view?.items.find((candidate) => candidate.issue.ref.id === activeTarget.issueId);
    const issue = issueList.find((candidate) => candidate.ref.id === activeTarget.issueId);
    const selectedItem =
      item ?? (issue ? { issue, itemId: issue.ref.id, columnId: null, version: null } : null);
    if (!selectedItem) return;
    targetOpened.current = key;
    void select(selectedItem);
  }, [
    target?.environmentId,
    target?.projectId,
    target?.boardId,
    target?.issueId,
    scope,
    view,
    issueList,
    connected,
    pending,
    select,
    activeTarget,
  ]);

  const moveItem = async (item: IssueBoardItem, columnId: string) => {
    if (!scope || !connected || !view || item.columnId === columnId) return;
    const currentScope = scopeGeneration.current;

    setPending(true);
    setError(null);

    try {
      const receipt = unwrapWorkResult(
        await move({
          environmentId: scope.environmentId,
          input: {
            requestId: randomUUID(),
            boardId: view.board.id,
            issue: item.issue.ref,
            columnId,
            expectedPlacement: item.columnId,
            ...(item.version ? { expectedVersion: item.version } : {}),
          },
        }),
      );
      if (currentScope !== scopeGeneration.current) return;

      if (receipt.status === "failed")
        throw new Error(receipt.error ?? "The remote board rejected this move.");

      await refresh(view.board.id);

      if (currentScope === scopeGeneration.current) setSelected(null);
    } catch (failure) {
      if (currentScope === scopeGeneration.current) setError(workError(failure));
    } finally {
      if (currentScope === scopeGeneration.current) setPending(false);
    }
  };

  const dragEnd = (event: DragEndEvent) => {
    const item = view?.items.find((candidate) => candidate.itemId === event.active.id);

    if (item && event.over && view?.columns.some((column) => column.id === event.over!.id))
      void moveItem(item, String(event.over.id));
  };

  const attempts =
    view?.attempts.filter(
      (attempt) =>
        attempt.link.issue.id === selected?.issue.ref.id &&
        attempt.link.issue.host === selected?.issue.ref.host &&
        attempt.link.issue.repository === selected?.issue.ref.repository,
    ) ?? [];

  const existing = defaultIssueAttempt(attempts);
  const startIssue = () => {
    onDismissIssue?.();
    setStarting(true);
  };
  const matchesQuery = (issue: IssueSummary) =>
    `${issue.title} ${issue.ref.number} ${issue.labels.join(" ")}`
      .toLowerCase()
      .includes(query.replace(/^#/, "").toLowerCase());

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4 sm:px-6">
      {scope && !connected ? (
        <p role="status" className="text-sm text-muted-foreground">
          {scopedEnvironment?.label ?? "Environment"} is not connected. Last loaded data stays
          visible; reconnect to update it.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="ghost" />}>
            {scope?.title ?? "Choose project"} · {scopedEnvironment?.label ?? "Environment"}
          </MenuTrigger>
          <MenuPopup>
            {supported.map((project) => (
              <MenuItem
                key={`${project.environmentId}:${project.id}`}
                onClick={() => {
                  setDismissedTargetKey(targetKey);
                  setScopeKey(`${project.environmentId}:${project.id}`);
                  onSelectBoard?.({ environmentId: project.environmentId, projectId: project.id });
                }}
              >
                {project.title} ·{" "}
                {
                  environments.find(
                    (environment) => environment.environmentId === project.environmentId,
                  )?.label
                }
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        {mode === "board" && boards.length ? (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="ghost" />}>
              {view?.board.title ?? "Choose board"}
            </MenuTrigger>
            <MenuPopup>
              {boards.map((board) => (
                <MenuItem
                  key={board.id}
                  disabled={!connected || pending}
                  onClick={() => {
                    setDismissedTargetKey(targetKey);
                    void refresh(board.id).then((result) => {
                      if (result && scope)
                        onSelectBoard?.({
                          environmentId: scope.environmentId,
                          projectId: scope.id,
                          boardId: result.board.id,
                        });
                    });
                  }}
                >
                  {board.title}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Issues view">
          <Button
            size="icon-sm"
            aria-label="Issue list"
            aria-pressed={mode === "issues"}
            variant={mode === "issues" ? "secondary" : "ghost"}
            onClick={() => setMode("issues")}
          >
            <ListIcon />
          </Button>
          <Button
            size="icon-sm"
            aria-label="Board"
            aria-pressed={mode === "board"}
            variant={mode === "board" ? "secondary" : "ghost"}
            onClick={() => setMode("board")}
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
              {view ? (
                <MenuItem onClick={() => setConfiguring(true)} disabled={!connected || pending}>
                  Column mapping
                </MenuItem>
              ) : null}
              <MenuItem
                disabled={!scope || !connected || pending}
                onClick={() => {
                  setMode("board");
                  setConnecting(true);
                }}
              >
                Connect board
              </MenuItem>
              {view ? (
                <>
                  <MenuItem
                    disabled={!connected || pending}
                    onClick={() => void refresh(view.board.id)}
                  >
                    Refresh board
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    disabled={!connected || pending}
                    onClick={() => {
                      const currentScope = scopeGeneration.current;
                      if (scope && connected)
                        void disconnect({
                          environmentId: scope.environmentId,
                          input: { requestId: randomUUID(), boardId: view.board.id },
                        })
                          .then(unwrapWorkResult)
                          .then(() => {
                            if (currentScope !== scopeGeneration.current) return;
                            setView(null);
                            setBoards((current) =>
                              current.filter((board) => board.id !== view.board.id),
                            );
                          })
                          .catch((failure) => {
                            if (currentScope === scopeGeneration.current)
                              setError(workError(failure));
                          });
                    }}
                  >
                    Disconnect board
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search issues"
          placeholder="Search issues or #number"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </InputGroup>
      {!scope && supported.length ? (
        <p role="status" className="text-sm text-muted-foreground">
          The requested project is unavailable. Choose a connected project to view its issues.
        </p>
      ) : !supported.length ? (
        <p className="text-sm text-muted-foreground">
          Issues are unavailable. Connect an environment that supports issue boards.
        </p>
      ) : !view && !pending && connected ? (
        <p className="text-sm text-muted-foreground">
          Connect an existing GitHub Project or Azure DevOps board to get started.
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Updating board…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {view?.moves
        .filter((receipt) => receipt.status === "failed" || receipt.status === "pending")
        .map((receipt) => (
          <div key={receipt.id} className="flex items-center gap-2 text-xs">
            <span>
              {receipt.status === "pending" ? "Board synchronization pending" : receipt.error} · #
              {receipt.issue.number}
            </span>
            {receipt.status === "failed" ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const currentScope = scopeGeneration.current;
                  if (scope && connected)
                    void retry({
                      environmentId: scope.environmentId,
                      input: { requestId: randomUUID(), moveId: receipt.id },
                    })
                      .then(unwrapWorkResult)
                      .then(() => {
                        if (currentScope === scopeGeneration.current) return refresh(view.board.id);
                      })
                      .catch((failure) => {
                        if (currentScope === scopeGeneration.current) setError(workError(failure));
                      });
                }}
              >
                Retry
              </Button>
            ) : null}
          </div>
        ))}
      {mode === "issues" ? (
        <section>
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="ghost" />}>
              <ListFilterIcon />
              Filters
              {issueState !== "all" || issueHost !== "all"
                ? ` · ${Number(issueState !== "all") + Number(issueHost !== "all")}`
                : ""}
            </MenuTrigger>
            <MenuPopup>
              <MenuGroupLabel>State</MenuGroupLabel>
              <MenuRadioGroup value={issueState} onValueChange={setIssueState}>
                <MenuRadioItem value="all">All states</MenuRadioItem>
                {[...new Set(issueList.map((issue) => issue.state))].map((state) => (
                  <MenuRadioItem key={state} value={state}>
                    {state}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuGroupLabel>Repository host</MenuGroupLabel>
              <MenuRadioGroup value={issueHost} onValueChange={setIssueHost}>
                <MenuRadioItem value="all">All hosts</MenuRadioItem>
                {[...new Set(issueList.map((issue) => issue.ref.host))].map((host) => (
                  <MenuRadioItem key={host} value={host}>
                    {host}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem
                onClick={() => {
                  setIssueState("all");
                  setIssueHost("all");
                }}
              >
                Clear filters
              </MenuItem>
            </MenuPopup>
          </Menu>
          <div className="mt-3 space-y-1">
            {issueList
              .filter(
                (issue) =>
                  (issueState === "all" || issue.state === issueState) &&
                  (issueHost === "all" || issue.ref.host === issueHost) &&
                  matchesQuery(issue),
              )
              .map((issue) => (
                <button
                  type="button"
                  key={`${issue.ref.host}:${issue.ref.repository}:${issue.ref.id}`}
                  className={`${PULL_REQUEST_ROW_CLASS} px-2 py-2 hover:bg-accent/40 outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                  onClick={() =>
                    void select(
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
          {nextCursor && scope ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!connected}
              onClick={() => {
                if (!connected) return;
                const currentScope = scopeGeneration.current;
                void listIssues({
                  environmentId: scope.environmentId,
                  input: { projectId: scope.id, cursor: nextCursor },
                })
                  .then(unwrapWorkResult)
                  .then((result) => {
                    if (currentScope !== scopeGeneration.current) return;
                    setIssueList((current) => [...current, ...result.issues]);
                    setNextCursor(result.nextCursor);
                  })
                  .catch((failure) => {
                    if (currentScope === scopeGeneration.current) setError(workError(failure));
                  });
              }}
            >
              Load more
            </Button>
          ) : null}
          {!issueList.length && !pending && connected ? (
            <p className="mt-4 text-sm text-muted-foreground">
              No issues loaded for this repository.
            </p>
          ) : null}
        </section>
      ) : null}
      {mode === "board" && view ? (
        <DndContext onDragEnd={dragEnd}>
          <div className="flex items-start gap-3 overflow-x-auto pb-4">
            {view.columns.map((column) => (
              <BoardColumn
                key={column.id}
                id={column.id}
                title={column.title}
                tone={
                  column.id === view.board.mapping?.inProgress
                    ? "progress"
                    : column.id === view.board.mapping?.inPullRequest
                      ? "review"
                      : column.id === view.board.mapping?.completed
                        ? "completed"
                        : "muted"
                }
                count={
                  view.items.filter(
                    (item) => item.columnId === column.id && matchesQuery(item.issue),
                  ).length
                }
              >
                {view.items
                  .filter((item) => item.columnId === column.id && matchesQuery(item.issue))
                  .map((item) => (
                    <BoardCard
                      key={item.itemId}
                      item={item}
                      onOpen={() => void select(item)}
                      disabled={pending || !connected || !view.board.mapping}
                    />
                  ))}
              </BoardColumn>
            ))}
            {view.items.some(
              (item) => !view.columns.some((column) => column.id === item.columnId),
            ) ? (
              <BoardColumn
                id="unassigned"
                title="Unassigned"
                count={
                  view.items.filter(
                    (item) =>
                      !view.columns.some((column) => column.id === item.columnId) &&
                      matchesQuery(item.issue),
                  ).length
                }
              >
                {view.items
                  .filter(
                    (item) =>
                      !view.columns.some((column) => column.id === item.columnId) &&
                      matchesQuery(item.issue),
                  )
                  .map((item) => (
                    <BoardCard
                      key={item.itemId}
                      item={item}
                      onOpen={() => void select(item)}
                      disabled={pending || !connected}
                    />
                  ))}
              </BoardColumn>
            ) : null}
          </div>
        </DndContext>
      ) : null}
      {scope && connected && (connecting || configuring) ? (
        <BoardConfiguration
          environmentId={scope.environmentId}
          projectId={scope.id}
          initial={configuring ? view : null}
          onClose={() => {
            setConnecting(false);
            setConfiguring(false);
          }}
          onConfigured={(result) => {
            setDismissedTargetKey(targetKey);
            onSelectBoard?.({
              environmentId: scope.environmentId,
              projectId: scope.id,
              boardId: result.board.id,
            });
            setView(result);
            setBoards((current) => [
              ...current.filter((board) => board.id !== result.board.id),
              result.board,
            ]);
            setConnecting(false);
            setConfiguring(false);
          }}
        />
      ) : null}
      {selected && !starting ? (
        <Dialog
          open
          onOpenChange={(opened) => {
            if (!opened) {
              detailGeneration.current++;
              setSelected(null);
              onDismissIssue?.();
            }
          }}
        >
          <DialogPopup className="max-w-3xl">
            <DialogHeader>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <TicketIcon className="size-3.5" />#{selected.issue.ref.number} ·{" "}
                {selected.issue.state}
              </p>
              <DialogTitle>{selected.issue.title}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <a
                href={selected.issue.ref.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline"
              >
                Open in repository host
              </a>
              {detail ? (
                <div className="mt-4 space-y-5">
                  <p className="text-xs text-muted-foreground">
                    {detail.author?.name ?? "Unknown author"} · {detail.ref.repository}
                    {detail.labels.length ? ` · ${detail.labels.join(" · ")}` : ""}
                  </p>
                  {scope ? (
                    <PullRequestMarkdown
                      text={detail.body || "No description."}
                      cwd={scope.workspaceRoot}
                      environmentId={scope.environmentId}
                    />
                  ) : null}
                  <details className="border-t border-border/60 pt-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      All issue details
                    </summary>
                    <div className="mt-3">
                      {" "}
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                        <dt className="text-muted-foreground">State</dt>
                        <dd>{detail.state}</dd>
                        <dt className="text-muted-foreground">Repository host</dt>
                        <dd>
                          {detail.ref.host} · {detail.ref.repository}
                        </dd>
                        <dt className="text-muted-foreground">Author</dt>
                        <dd>{detail.author?.name ?? "Unavailable"}</dd>
                        <dt className="text-muted-foreground">Assignees</dt>
                        <dd>
                          {detail.assignees?.map((actor) => actor.name).join(", ") || "Unassigned"}
                        </dd>
                        {detail.createdAt ? (
                          <>
                            <dt className="text-muted-foreground">Created</dt>
                            <dd>
                              <time dateTime={detail.createdAt}>
                                {new Date(detail.createdAt).toLocaleString()}
                              </time>
                            </dd>
                          </>
                        ) : null}
                        <dt className="text-muted-foreground">Updated</dt>
                        <dd>
                          <time dateTime={detail.updatedAt}>
                            {new Date(detail.updatedAt).toLocaleString()}
                          </time>
                        </dd>
                        <dt className="text-muted-foreground">Labels</dt>
                        <dd>{detail.labels.join(" · ") || "None"}</dd>
                      </dl>
                    </div>
                  </details>
                  {detail.hostFields && Object.keys(detail.hostFields).length ? (
                    <details className="border-t pt-3">
                      <summary className="cursor-pointer text-sm font-medium">
                        Repository host fields ({Object.keys(detail.hostFields).length})
                      </summary>
                      <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 text-xs">
                        {Object.entries(detail.hostFields).map(([name, value]) => (
                          <div key={name} className="contents">
                            <dt className="break-words text-muted-foreground">{name}</dt>
                            <dd className="whitespace-pre-wrap break-words">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ) : null}
                  {detail.comments?.length ? (
                    <section className="space-y-4 border-t pt-3">
                      <h3 className="text-sm font-medium">Comments ({detail.comments.length})</h3>
                      {detail.comments.map((comment) => (
                        <article key={comment.id} className="space-y-2 border-b pb-3">
                          <p className="text-xs text-muted-foreground">
                            {comment.author?.name ?? "Unknown author"} ·{" "}
                            <time dateTime={comment.createdAt}>
                              {new Date(comment.createdAt).toLocaleString()}
                            </time>
                          </p>
                          {scope ? (
                            <PullRequestMarkdown
                              text={comment.body}
                              cwd={scope.workspaceRoot}
                              environmentId={scope.environmentId}
                            />
                          ) : null}
                        </article>
                      ))}
                    </section>
                  ) : null}
                </div>
              ) : (
                <p role="status" className="mt-4 text-sm text-muted-foreground">
                  Loading full issue details…
                </p>
              )}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              {attempts.length ? (
                <div className="mt-5 grid gap-2 rounded-xl border border-border/60 bg-card/40 p-4">
                  <h3 className="text-sm font-medium">Linked work attempts</h3>
                  {attempts.map((attempt) => (
                    <div key={attempt.link.attemptId} className="space-y-2 py-1">
                      <p className="text-xs text-muted-foreground">
                        {attempt.active ? "Active" : "Earlier"} · {attempt.status}
                      </p>
                      <p className="break-all font-mono text-xs">
                        {attempt.worktreePath ?? "Worktree not ready"}
                      </p>
                      {attempt.threadId ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            if (attempt.threadId)
                              void navigate({
                                to: "/$environmentId/$threadId",
                                params: {
                                  environmentId: attempt.link.destinationEnvironmentId,
                                  threadId: attempt.threadId,
                                },
                              });
                          }}
                        >
                          Open thread
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {view?.items.some((item) => item.itemId === selected.itemId) ? (
                <label className="mt-4 grid gap-1 text-xs">
                  Move to column
                  <select
                    aria-label="Move issue to column"
                    disabled={pending || !connected}
                    value={selected.columnId ?? ""}
                    onChange={(event) => void moveItem(selected, event.target.value)}
                    className="rounded-md border bg-background px-2 py-2"
                  >
                    {view?.columns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              {existing?.worktreePath && onViewWork ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (!existing.worktreePath) return;
                    onViewWork({
                      environmentId: existing.link.destinationEnvironmentId,
                      worktreePath: existing.worktreePath,
                    });
                  }}
                >
                  View work
                </Button>
              ) : null}
              {view && issueCanStart(selected, view.board.mapping) ? (
                existing?.threadId ? (
                  <>
                    <Button
                      onClick={() => {
                        if (existing.threadId)
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: {
                              environmentId: existing.link.destinationEnvironmentId,
                              threadId: existing.threadId,
                            },
                          });
                      }}
                    >
                      Continue thread
                    </Button>
                    <Button variant="outline" disabled={!connected || pending} onClick={startIssue}>
                      New attempt
                    </Button>
                  </>
                ) : (
                  <Button disabled={!connected || pending} onClick={startIssue}>
                    Start
                  </Button>
                )
              ) : null}
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
      {starting && selected && view && scope ? (
        <IssueStartDialog
          environmentId={scope.environmentId}
          board={view}
          item={selected}
          onClose={() => {
            setStarting(false);
            setSelected(null);
          }}
        />
      ) : null}
    </div>
  );
}

function BoardConfiguration({
  environmentId,
  projectId,
  initial,
  onClose,
  onConfigured,
}: {
  environmentId: EnvironmentId;
  projectId: IssueBoardSummary["projectId"];
  initial: IssueBoardView | null;
  onClose: () => void;
  onConfigured: (view: IssueBoardView) => void;
}) {
  const [kind, setKind] = useState<IssueBoardLocator["kind"]>(
    initial?.board.locator.kind ?? "github-project",
  );

  const [host, setHost] = useState(initial?.board.locator.host ?? "github.com");

  const [owner, setOwner] = useState("");
  const [ownerKind, setOwnerKind] = useState<"user" | "organization">("organization");

  const [number, setNumber] = useState("");
  const [organization, setOrganization] = useState("");

  const [project, setProject] = useState("");
  const [team, setTeam] = useState("");
  const [boardId, setBoardId] = useState("");

  const [view, setView] = useState(initial);
  const [mapping, setMapping] = useState<IssueBoardMapping | null>(initial?.board.mapping ?? null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });

  const configure = useAtomCommand(issuesEnvironment.configureBoard, { reportFailure: false });

  const locator: IssueBoardLocator =
    kind === "github-project"
      ? { kind, host, owner, ownerKind, projectNumber: Number(number) }
      : { kind, host, organization, project, team, boardId };

  const load = async () => {
    setBusy(true);
    setError(null);

    try {
      const result = unwrapWorkResult(await open({ environmentId, input: { projectId, locator } }));

      setView(result);
      setMapping(
        result.board.mapping ?? {
          ready: "",
          inProgress: "",
          inPullRequest: "",
          completed: "",
          moveOnMerge: false,
        },
      );
    } catch (failure) {
      setError(workError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(opened) => {
        if (!opened && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Configure board columns" : "Connect board"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {!view ? (
            <div className="grid gap-3">
              <label className="grid gap-1 text-xs">
                Repository host
                <select
                  value={kind}
                  onChange={(event) => {
                    const next =
                      event.target.value === "azure-board" ? "azure-board" : "github-project";
                    setKind(next);
                    setHost(next === "azure-board" ? "dev.azure.com" : "github.com");
                  }}
                  className="rounded-md border bg-background p-2"
                >
                  <option value="github-project">GitHub Project</option>
                  <option value="azure-board">Azure DevOps board</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs">
                Host
                <Input value={host} onChange={(event) => setHost(event.target.value)} />
              </label>
              {kind === "github-project" ? (
                <>
                  <label className="grid gap-1 text-xs">
                    Owner
                    <Input value={owner} onChange={(event) => setOwner(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-xs">
                    Owner type
                    <select
                      value={ownerKind}
                      onChange={(event) =>
                        setOwnerKind(event.target.value === "user" ? "user" : "organization")
                      }
                      className="rounded-md border bg-background p-2"
                    >
                      <option value="organization">Organization</option>
                      <option value="user">User</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs">
                    Project number
                    <Input value={number} onChange={(event) => setNumber(event.target.value)} />
                  </label>
                </>
              ) : (
                <>
                  {[
                    ["Organization", organization, setOrganization],
                    ["Project", project, setProject],
                    ["Team", team, setTeam],
                    ["Board ID", boardId, setBoardId],
                  ].map(([label, value, setter]) =>
                    typeof setter === "function" ? (
                      <label key={String(label)} className="grid gap-1 text-xs">
                        {String(label)}
                        <Input
                          value={String(value)}
                          onChange={(event) => setter(event.target.value)}
                        />
                      </label>
                    ) : null,
                  )}
                </>
              )}
              <Button variant="outline" disabled={busy} onClick={() => void load()}>
                Load remote columns
              </Button>
            </div>
          ) : (
            <div className="grid gap-3">
              {(
                [
                  ["ready", "Ready for development"],
                  ["inProgress", "In progress"],
                  ["inPullRequest", "In PR"],
                  ["completed", "Completed"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="grid gap-1 text-xs">
                  {label}
                  <select
                    value={mapping?.[key] ?? ""}
                    onChange={(event) =>
                      setMapping((current) => ({
                        ...(current ?? {
                          ready: "",
                          inProgress: "",
                          inPullRequest: "",
                          completed: "",
                          moveOnMerge: false,
                        }),
                        [key]: event.target.value,
                      }))
                    }
                    className="rounded-md border bg-background p-2"
                  >
                    <option value="">Choose a remote column</option>
                    {view.columns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.title}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={mapping?.moveOnMerge ?? false}
                  onCheckedChange={(checked) =>
                    setMapping((current) =>
                      current ? { ...current, moveOnMerge: checked } : current,
                    )
                  }
                />
                Move to Completed when a pull request is merged
              </label>
            </div>
          )}
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {view && mapping ? (
            <Button
              disabled={
                busy ||
                !mapping.ready ||
                !mapping.inProgress ||
                !mapping.inPullRequest ||
                !mapping.completed
              }
              onClick={() => {
                setBusy(true);
                setError(null);

                void configure({
                  environmentId,
                  input: {
                    requestId: randomUUID(),
                    projectId,
                    locator: view.board.locator,
                    mapping,
                  },
                })
                  .then(unwrapWorkResult)
                  .then(onConfigured)
                  .catch((failure) => setError(workError(failure)))
                  .finally(() => setBusy(false));
              }}
            >
              Save mapping
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
