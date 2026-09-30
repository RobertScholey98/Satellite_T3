import type {
  EnvironmentId,
  OpenWorkDocument,
  OpenWorkTimelineResult,
  OpenWorktreeSummary,
  OpenWorkTimeLink,
  IssueAttempt,
  IssueBoardView,
  ProjectId,
  OpenWorkFile,
  OpenWorkWipFile,
} from "@t3tools/contracts";
import { documentPreviewHtml } from "@t3tools/client-runtime/documents";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import {
  FileTextIcon,
  StarIcon,
  TicketIcon,
  FolderSearchIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  ChevronDownIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useEnvironments } from "~/state/environments";
import { openWorkEnvironment } from "~/state/openWork";
import { issuesEnvironment } from "~/state/issues";
import { documentsEnvironment } from "~/state/documents";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuTrigger, MenuPopup, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { BrowserDocumentFrame } from "../files/BrowserDocumentFrame";
import ChatMarkdown from "../ChatMarkdown";
import { documentsAtStep } from "./work.logic";
import { unwrapWorkResult, workError } from "./commands";
import {
  readOpenWorkSelection,
  readOpenWorkSnapshot,
  saveOpenWorkSelection,
  saveOpenWorkSnapshot,
} from "./openWorkViewState";
import type { OpenWorkDiffSelection } from "./OpenWorkDiffPanel";

const OpenWorkDiffPanel = lazy(() =>
  import("./OpenWorkDiffPanel").then((module) => ({ default: module.OpenWorkDiffPanel })),
);

export function OpenWorkView({
  target,
  onSelectWorktree,
  onViewBoard,
  onSyncChange,
}: {
  onSyncChange?: (syncing: boolean) => void;
  target?: { environmentId?: EnvironmentId; worktreePath?: string };
  onSelectWorktree?: (target: { environmentId: EnvironmentId; worktreePath?: string }) => void;
  onViewBoard?: (target: {
    environmentId: EnvironmentId;
    projectId: ProjectId;
    boardId: string;
    issueId?: string;
  }) => void;
}) {
  const [restoredSelection, setRestoredSelection] = useState(readOpenWorkSelection);
  const { environments } = useEnvironments();
  const available = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.openWork === true,
  );
  const [environmentKey, setEnvironmentKey] = useState<EnvironmentId | null>(
    target?.environmentId ?? restoredSelection?.environmentId ?? null,
  );
  const requestedEnvironment = target?.environmentId ?? environmentKey;
  const environment = requestedEnvironment
    ? available.find((candidate) => candidate.environmentId === requestedEnvironment)
    : available[0];
  const environmentId = environment?.environmentId;
  const requestedWorktreePath =
    !target?.environmentId || target.environmentId === environmentId
      ? (target?.worktreePath ??
        (restoredSelection?.environmentId === environmentId
          ? restoredSelection?.worktreePath
          : undefined))
      : undefined;
  const connected = environment?.connection.phase === "connected";
  const activeEnvironment = useRef(environmentId);
  useLayoutEffect(() => {
    activeEnvironment.current = environmentId;
  }, [environmentId]);
  const initial = readOpenWorkSnapshot(environmentId, requestedWorktreePath);
  const [stateEnvironment, setStateEnvironment] = useState(environmentId);
  const [worktrees, setWorktrees] = useState<readonly OpenWorktreeSummary[]>(
    initial?.worktrees ?? [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(initial?.selectedId ?? null);
  const [loaded, setLoaded] = useState<{
    environmentId: EnvironmentId;
    timeline: OpenWorkTimelineResult;
  } | null>(
    initial?.timeline && environmentId ? { environmentId, timeline: initial.timeline } : null,
  );
  const timeline =
    loaded &&
    loaded.environmentId === environmentId &&
    loaded.timeline.worktree.id === selectedId &&
    (!requestedWorktreePath ||
      normalizeProjectPathForComparison(loaded.timeline.worktree.path) ===
        normalizeProjectPathForComparison(requestedWorktreePath))
      ? loaded.timeline
      : null;
  const hasIssueBoards = environment?.serverConfig?.environment.capabilities.issueBoards;
  const [favorites, setFavorites] = useState<readonly OpenWorkDocument[]>(initial?.favorites ?? []);
  const [attempts, setAttempts] = useState<readonly IssueAttempt[]>(initial?.attempts ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [documentSyncing, setDocumentSyncing] = useState(false);
  const [boardSyncing, setBoardSyncing] = useState(false);
  useEffect(() => {
    onSyncChange?.(syncing || boardSyncing || documentSyncing);
    return () => onSyncChange?.(false);
  }, [syncing, boardSyncing, documentSyncing, onSyncChange]);
  const [finding, setFinding] = useState(false);
  const [board, setBoard] = useState<{ attemptId: string; view: IssueBoardView } | null>(
    initial?.board ?? null,
  );
  const [diffSelection, setDiffSelection] = useState<OpenWorkDiffSelection | null>(
    initial?.diff ?? null,
  );
  const [revision, setRevision] = useState(0);
  const diffTrigger = useRef<HTMLButtonElement | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const handledTarget = useRef<string | null>(null);
  const closeDiff = () => {
    setDiffSelection(null);
    requestAnimationFrame(() => {
      if (diffTrigger.current?.isConnected) diffTrigger.current.focus();
      else historyRef.current?.focus();
    });
  };
  const [opened, setOpened] = useState<{
    documentId: string;
    title: string;
    format: string;
    content: string;
    truncated: boolean;
    live: boolean;
    cwd: string;
  } | null>(initial?.opened ?? null);
  const generation = useRef(0);
  const documentReadGeneration = useRef(0);
  const openedDocumentId = useRef(opened?.documentId);
  useLayoutEffect(() => {
    openedDocumentId.current = opened?.documentId;
  }, [opened?.documentId]);
  const dismissDocument = useCallback(() => {
    openedDocumentId.current = undefined;
    documentReadGeneration.current++;
    setBusy(false);
    setDocumentSyncing(false);
    setOpened(null);
  }, [setBusy, setDocumentSyncing, setOpened]);
  const list = useAtomCommand(openWorkEnvironment.list, { reportFailure: false });
  const getTimeline = useAtomCommand(openWorkEnvironment.timeline, { reportFailure: false });
  const getFavorites = useAtomCommand(openWorkEnvironment.favorites, { reportFailure: false });
  const favorite = useAtomCommand(openWorkEnvironment.setFavorite, { reportFailure: false });
  const assign = useAtomCommand(openWorkEnvironment.assignDocument, { reportFailure: false });
  const unlink = useAtomCommand(openWorkEnvironment.unlinkFolder, { reportFailure: false });
  const readLinked = useAtomCommand(openWorkEnvironment.readLinked, { reportFailure: false });
  const readPublished = useAtomCommand(documentsEnvironment.get, { reportFailure: false });
  const listAttempts = useAtomCommand(issuesEnvironment.listAttempts, { reportFailure: false });
  const openBoard = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });
  const linkedAttempt = timeline
    ? attempts
        .filter(
          (attempt) =>
            attempt.worktreePath !== null &&
            normalizeProjectPathForComparison(attempt.worktreePath) ===
              normalizeProjectPathForComparison(timeline.worktree.path),
        )
        .toSorted(
          (left, right) =>
            Number(right.active) - Number(left.active) ||
            right.createdAt.localeCompare(left.createdAt),
        )[0]
    : undefined;
  const sourceConnected =
    environments.find(
      (candidate) => candidate.environmentId === linkedAttempt?.link.sourceEnvironmentId,
    )?.connection.phase === "connected";
  const issueView = board?.attemptId === linkedAttempt?.link.attemptId ? board?.view : null;
  const boardItem = issueView?.items.find(
    (item) => item.issue.ref.id === linkedAttempt?.link.issue.id,
  );
  const boardColumn = issueView?.columns.find((column) => column.id === boardItem?.columnId);
  const openDocument = async (document: OpenWorkDocument, refreshing = false) => {
    if (!environmentId || !connected || !document.available) return;
    if (refreshing && openedDocumentId.current !== document.id) return;
    setDocumentSyncing(refreshing);
    setBusy(!refreshing);
    if (!refreshing) openedDocumentId.current = document.id;
    const documentRead = ++documentReadGeneration.current;
    const current = generation.current;
    const isCurrent = () =>
      documentRead === documentReadGeneration.current &&
      current === generation.current &&
      openedDocumentId.current === document.id;
    setError(null);
    const cwd =
      worktrees.find((worktree) => worktree.id === document.worktreeId)?.path ??
      timeline?.worktree.path ??
      "";
    try {
      if (document.source.kind === "linked") {
        const result = unwrapWorkResult(
          await readLinked({ environmentId, input: { documentId: document.id } }),
        );
        if (isCurrent())
          setOpened({ documentId: document.id, title: document.title, ...result, live: true, cwd });
      } else {
        const result = unwrapWorkResult(
          await readPublished({
            environmentId,
            input: {
              documentId: document.source.documentId,
              revisionId: document.source.revisionId,
            },
          }),
        );
        if (isCurrent())
          setOpened({
            documentId: document.id,
            title: document.title,
            format: result.revision.format,
            content: result.content,
            truncated: false,
            live: false,
            cwd,
          });
      }
    } catch (failure) {
      if (isCurrent()) setError(workError(failure));
    } finally {
      if (documentRead === documentReadGeneration.current) {
        if (refreshing) setDocumentSyncing(false);
        else setBusy(false);
      }
    }
  };
  const refreshOpened = useEffectEvent((documents: readonly OpenWorkDocument[]) => {
    const document = documents.find((candidate) => candidate.id === opened?.documentId);
    if (document) void openDocument(document, true);
  });
  const refresh = useCallback(
    async (worktreeId?: string) => {
      if (!environmentId || !connected || activeEnvironment.current !== environmentId) return;
      const current = ++generation.current;
      setSyncing(true);
      setError(null);
      try {
        const [inventory, pinned, currentAttempts] = await Promise.all([
          list({ environmentId, input: {} }).then(unwrapWorkResult),
          getFavorites({ environmentId, input: {} }).then(unwrapWorkResult),
          hasIssueBoards
            ? listAttempts({ environmentId, input: {} })
                .then(unwrapWorkResult)
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        if (current !== generation.current) return;
        setWorktrees(inventory.worktrees);
        setFavorites(pinned.documents);
        if (currentAttempts) setAttempts(currentAttempts);
        const preferredId = worktreeId ?? (requestedWorktreePath ? null : selectedId);
        const id = preferredId
          ? inventory.worktrees.find((worktree) => worktree.id === preferredId)?.id
          : requestedWorktreePath
            ? inventory.worktrees.find(
                (worktree) =>
                  normalizeProjectPathForComparison(worktree.path) ===
                  normalizeProjectPathForComparison(requestedWorktreePath),
              )?.id
            : inventory.worktrees[0]?.id;
        if (id && inventory.worktrees.some((worktree) => worktree.id === id)) {
          setSelectedId(id);
          const value = unwrapWorkResult(
            await getTimeline({ environmentId, input: { worktreeId: id } }),
          );
          if (current === generation.current) {
            setLoaded({ environmentId, timeline: value });
            setSelectedId(id);
            setRevision((value) => value + 1);
            refreshOpened([...value.documents, ...pinned.documents]);
          }
        } else {
          setLoaded(null);
          setSelectedId(null);
        }
      } catch (failure) {
        if (current === generation.current) setError(workError(failure));
      } finally {
        if (current === generation.current) setSyncing(false);
      }
    },
    [
      environmentId,
      connected,
      list,
      getTimeline,
      getFavorites,
      selectedId,
      requestedWorktreePath,
      hasIssueBoards,
      listAttempts,
    ],
  );
  useLayoutEffect(() => {
    generation.current++;
    const snapshot = readOpenWorkSnapshot(environmentId, requestedWorktreePath);
    setStateEnvironment(environmentId);
    setWorktrees(snapshot?.worktrees ?? []);
    setLoaded(
      snapshot?.timeline && environmentId ? { environmentId, timeline: snapshot.timeline } : null,
    );
    setFavorites(snapshot?.favorites ?? []);
    setSelectedId(snapshot?.selectedId ?? null);
    setAttempts(snapshot?.attempts ?? []);
    setOpened(snapshot?.opened ?? null);
    setFinding(false);
    setError(null);
    setBusy(false);
    documentReadGeneration.current++;
    setDocumentSyncing(false);
    setSyncing(false);
    setBoard(snapshot?.board ?? null);
    setDiffSelection(snapshot?.diff ?? null);
  }, [environmentId]);
  useEffect(() => {
    if (!environmentId || stateEnvironment !== environmentId) return;
    saveOpenWorkSnapshot(environmentId, {
      worktrees,
      selectedId,
      timeline,
      favorites,
      attempts,
      diff: diffSelection,
      opened,
      board,
    });
  }, [
    environmentId,
    stateEnvironment,
    worktrees,
    selectedId,
    timeline,
    favorites,
    attempts,
    diffSelection,
    opened,
    board,
  ]);
  const selectedPath = worktrees.find((worktree) => worktree.id === selectedId)?.path;
  const reportSelection = useEffectEvent((id: EnvironmentId, path: string) => {
    if (target?.environmentId && target.environmentId !== id) return;
    if (
      target?.worktreePath &&
      normalizeProjectPathForComparison(target.worktreePath) !==
        normalizeProjectPathForComparison(path)
    )
      return;
    if (target?.environmentId !== id || target?.worktreePath !== path)
      onSelectWorktree?.({ environmentId: id, worktreePath: path });
  });
  useEffect(() => {
    if (!environmentId || stateEnvironment !== environmentId) return;
    const path = selectedPath;
    if (path) {
      saveOpenWorkSelection(environmentId, path);
      reportSelection(environmentId, path);
    }
  }, [environmentId, stateEnvironment, selectedPath]);

  useEffect(() => {
    if (target?.environmentId) setEnvironmentKey(target.environmentId);
  }, [target?.environmentId]);
  useEffect(() => {
    if (!requestedWorktreePath || !worktrees.length || !connected) return;
    const key = JSON.stringify([environmentId, requestedWorktreePath]);
    if (handledTarget.current === key) return;
    handledTarget.current = key;
    const selected = worktrees.find(
      (candidate) =>
        normalizeProjectPathForComparison(candidate.path) ===
        normalizeProjectPathForComparison(requestedWorktreePath),
    );
    if (selected?.id !== selectedId) {
      setSelectedId(selected?.id ?? null);
      setDiffSelection(null);
      setLoaded(null);
      dismissDocument();
      if (selected) void refresh(selected.id);
    }
  }, [
    environmentId,
    requestedWorktreePath,
    worktrees,
    selectedId,
    connected,
    refresh,
    dismissDocument,
  ]);
  useEffect(() => {
    if (!linkedAttempt || !sourceConnected) return;
    let current = true;
    setBoardSyncing(true);
    const { link } = linkedAttempt;
    void openBoard({
      environmentId: link.sourceEnvironmentId,
      input: { projectId: link.sourceProjectId, boardId: link.boardId },
    })
      .then(unwrapWorkResult)
      .then((view) => {
        if (current) setBoard({ attemptId: link.attemptId, view });
      })
      .catch(() => {
        // Keep the last board status visible while its source is unavailable.
      })
      .finally(() => {
        if (current) setBoardSyncing(false);
      });
    return () => {
      current = false;
      setBoardSyncing(false);
    };
  }, [
    linkedAttempt?.link.attemptId,
    linkedAttempt?.sourceGeneration,
    sourceConnected,
    openBoard,
    revision,
  ]);

  const refreshOnArrival = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    if (!environmentId || !connected) return;
    refreshOnArrival();
    return () => {
      generation.current++;
    };
  }, [environmentId, connected]);
  useLiveRefresh(
    environmentId && connected && !busy && !syncing && !documentSyncing && !finding
      ? () => {
          void refresh();
        }
      : null,
    { key: `open-work:${environmentId ?? "none"}:${selectedId ?? "none"}` },
  );
  const documentRow = (document: OpenWorkDocument) => (
    <div key={document.id} className="group flex items-center gap-2 py-2">
      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-sm hover:underline disabled:text-muted-foreground"
        disabled={!document.available || busy}
        onClick={() => void openDocument(document)}
      >
        {document.title}
        {!document.available ? " · Unavailable" : ""}
      </button>
      {document.unresolved ? (
        <span className="text-xs text-warning">
          {document.unresolved === "history-diverged"
            ? "History changed; choose a step"
            : "Creation time unavailable"}
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {document.source.kind === "linked" ? "Live file" : "Published"}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={
          document.favorite ? `Unfavorite ${document.title}` : `Favorite ${document.title}`
        }
        disabled={busy || !connected}
        onClick={() => {
          if (environmentId && connected)
            void favorite({
              environmentId,
              input: {
                requestId: randomUUID(),
                documentId: document.id,
                favorite: !document.favorite,
              },
            })
              .then(unwrapWorkResult)
              .then(() => refresh())
              .catch((failure) => setError(workError(failure)));
        }}
      >
        <StarIcon
          className={
            document.favorite
              ? "size-3.5 fill-current"
              : "size-3.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          }
        />
      </Button>
      {timeline && document.worktreeId === timeline.worktree.id ? (
        <select
          aria-label={`Step for ${document.title}`}
          className="max-w-40 rounded-md border bg-background px-1 py-1 text-xs"
          disabled={busy || !connected}
          value={document.step.kind === "commit" ? document.step.commitSha : document.step.kind}
          onChange={(event) => {
            if (environmentId && connected)
              void assign({
                environmentId,
                input: {
                  requestId: randomUUID(),
                  documentId: document.id,
                  step:
                    event.target.value === "wip"
                      ? { kind: "wip" }
                      : event.target.value === "unassigned"
                        ? { kind: "unassigned" }
                        : { kind: "commit", commitSha: event.target.value },
                },
              })
                .then(unwrapWorkResult)
                .then(() => refresh())
                .catch((failure) => setError(workError(failure)));
          }}
        >
          <option value="unassigned">Unassigned</option>
          {document.step.kind === "commit" &&
          !timeline.commits.some(
            (commit) => document.step.kind === "commit" && commit.sha === document.step.commitSha,
          ) ? (
            <option value={document.step.commitSha}>
              {document.step.commitSha.slice(0, 7)} · Earlier commit
            </option>
          ) : null}
          <option value="wip">Work in progress</option>
          {timeline.commits.map((commit) => (
            <option key={commit.sha} value={commit.sha}>
              {commit.sha.slice(0, 7)} · {commit.subject}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
  const activeDiff =
    diffSelection &&
    diffSelection.environmentId === environmentId &&
    diffSelection.worktreeId === timeline?.worktree.id
      ? diffSelection
      : null;
  const diffSiblings: readonly OpenWorkDiffSelection[] =
    activeDiff && timeline
      ? activeDiff.comparison.kind === "commit"
        ? (
            timeline.commits.find(
              (commit) =>
                activeDiff.comparison.kind === "commit" &&
                commit.sha === activeDiff.comparison.commitSha,
            )?.files ?? []
          ).map((file) => ({
            ...activeDiff,
            file: { path: file.path, previousPath: file.previousPath, sourceKind: "commit" },
          }))
        : timeline.wip.files.map((file) => ({
            ...activeDiff,
            comparison: { kind: file.layer },
            file: { path: file.path, previousPath: file.previousPath, sourceKind: file.layer },
            title:
              file.layer === "staged"
                ? "Staged changes"
                : file.layer === "unstaged"
                  ? "Unstaged changes"
                  : "Untracked file",
          }))
      : [];
  const validDiff =
    activeDiff &&
    diffSiblings.some(
      (candidate) =>
        candidate.file.path === activeDiff.file.path &&
        candidate.comparison.kind === activeDiff.comparison.kind,
    )
      ? activeDiff
      : null;
  const fileRow = (
    file: OpenWorkFile | OpenWorkWipFile,
    commit?: OpenWorkTimelineResult["commits"][number],
  ) => {
    const layer = "layer" in file ? file.layer : null;
    const comparison = commit
      ? { kind: "commit" as const, commitSha: commit.sha }
      : layer
        ? { kind: layer }
        : null;
    const selected =
      activeDiff?.file.path === file.path &&
      (commit
        ? activeDiff.comparison.kind === "commit" && activeDiff.comparison.commitSha === commit.sha
        : activeDiff.comparison.kind === layer);
    return (
      <button
        key={`${layer ?? commit?.sha}:${file.path}`}
        type="button"
        aria-label={`${file.path} · ${file.status}${layer ? ` · ${layer}` : ""}${file.status === "untracked" ? " · New file" : ` · +${file.insertions} −${file.deletions}`}`}
        disabled={!connected || !comparison}
        aria-pressed={selected}
        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary disabled:text-muted-foreground ${selected ? "bg-muted/60" : ""}`}
        onClick={(event) => {
          if (!environmentId || !timeline || !comparison) return;
          diffTrigger.current = event.currentTarget;
          setDiffSelection({
            environmentId,
            worktreeId: timeline.worktree.id,
            cwd: timeline.worktree.path,
            comparison,
            file: { path: file.path, previousPath: file.previousPath, sourceKind: comparison.kind },
            title: commit
              ? `${commit.sha.slice(0, 7)} · ${commit.subject}`
              : layer === "staged"
                ? "Staged changes"
                : layer === "unstaged"
                  ? "Unstaged changes"
                  : "Untracked file",
          });
        }}
      >
        <span className="w-3 shrink-0 font-mono text-muted-foreground">
          {file.status === "untracked" ? "?" : file.status.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {file.previousPath ? `${file.previousPath} → ` : ""}
          {file.path}
        </span>
        {layer ? (
          <span className="shrink-0 text-muted-foreground">
            {layer === "staged" ? "Staged" : layer === "unstaged" ? "Unstaged" : "Untracked"}
          </span>
        ) : null}
        {file.status !== "untracked" ? (
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-success">+{file.insertions}</span>{" "}
            <span className="text-muted-foreground">−{file.deletions}</span>
          </span>
        ) : null}
      </button>
    );
  };
  return (
    <div
      className="@container/open-work flex min-h-0 flex-1 overflow-hidden bg-background"
      onKeyDown={(event) => {
        if (event.key === "Escape" && validDiff && !event.defaultPrevented && !finding && !opened) {
          event.preventDefault();
          closeDiff();
        }
      }}
    >
      <div
        ref={historyRef}
        tabIndex={-1}
        className={`min-h-0 min-w-0 flex-1 overflow-auto px-6 py-5 outline-none ${validDiff ? "@max-[900px]/open-work:hidden" : ""}`}
      >
        {environmentId && !connected ? (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            {environment.label} is not connected. Last loaded history stays visible; reconnect to
            update it.
          </p>
        ) : null}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <GitBranchIcon className="size-4 text-muted-foreground" />
          <select
            aria-label="Open work environment"
            value={environmentId ?? ""}
            onChange={(event) => {
              generation.current++;
              setEnvironmentKey(event.target.value as EnvironmentId);
              setDiffSelection(null);
              onSelectWorktree?.({ environmentId: event.target.value as EnvironmentId });
            }}
            className="max-w-40 rounded-md border bg-background px-2 py-1 text-xs"
          >
            {!environmentId ? <option value="">Choose an environment</option> : null}
            {available.map((candidate) => (
              <option key={candidate.environmentId} value={candidate.environmentId}>
                {candidate.label}
              </option>
            ))}
          </select>
          <div className="min-w-0 max-w-72">
            <Menu>
              <MenuTrigger
                aria-label="Worktree"
                disabled={!worktrees.length || !connected}
                render={<Button size="sm" variant="ghost" />}
              >
                <span className="min-w-0 truncate">
                  {worktrees.find((worktree) => worktree.id === selectedId)?.branch ??
                    (selectedId ? "Detached HEAD" : "Choose a worktree")}
                </span>
                {linkedAttempt ? <TicketIcon className="size-3.5 text-muted-foreground" /> : null}
                <ChevronDownIcon className="size-3.5 text-muted-foreground" />
              </MenuTrigger>
              <MenuPopup align="start">
                <MenuRadioGroup
                  value={selectedId ?? ""}
                  onValueChange={(value) => {
                    handledTarget.current = JSON.stringify([environmentId, requestedWorktreePath]);
                    generation.current++;
                    setSelectedId(value);
                    setDiffSelection(null);
                    dismissDocument();
                    setLoaded(null);
                    void refresh(value);
                    const selected = worktrees.find((worktree) => worktree.id === value);
                    if (selected && environmentId) {
                      setRestoredSelection({ environmentId, worktreePath: selected.path });
                      onSelectWorktree?.({ environmentId, worktreePath: selected.path });
                    }
                  }}
                >
                  {worktrees.map((worktree) => (
                    <MenuRadioItem key={worktree.id} value={worktree.id}>
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <GitBranchIcon className="size-3.5 text-muted-foreground" />
                            <span className="truncate">{worktree.branch ?? "Detached HEAD"}</span>
                            {attempts.some(
                              (attempt) =>
                                attempt.worktreePath !== null &&
                                normalizeProjectPathForComparison(attempt.worktreePath) ===
                                  normalizeProjectPathForComparison(worktree.path),
                            ) ? (
                              <TicketIcon
                                aria-label="Linked issue"
                                className="size-3.5 text-muted-foreground"
                              />
                            ) : null}
                          </div>
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            {worktree.path}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {worktree.ahead === null || worktree.behind === null ? (
                            "Main unavailable"
                          ) : (
                            <>
                              <span className="text-success">↑{worktree.ahead}</span> ↓
                              {worktree.behind}
                            </>
                          )}
                        </span>
                      </div>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          </div>
          {timeline ? (
            <span className="mr-auto text-xs text-muted-foreground">
              {timeline.worktree.ahead === null || timeline.worktree.behind === null ? (
                "Main unavailable"
              ) : (
                <>
                  <span className="text-success">↑{timeline.worktree.ahead}</span> ↓
                  {timeline.worktree.behind}
                </>
              )}
              {timeline.worktree.baseRef ? ` ${timeline.worktree.baseRef}` : ""}
            </span>
          ) : (
            <span className="mr-auto" />
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!environmentId || !connected || busy}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!timeline || !connected || busy}
            onClick={() => setFinding(true)}
          >
            <FolderSearchIcon className="size-4" />
            Find documents
          </Button>
        </div>
        {environmentKey && !environment ? (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            The requested environment is unavailable. Choose a connected environment above.
          </p>
        ) : null}
        {!available.length ? (
          <p className="text-sm text-muted-foreground">
            Open work is unavailable. Connect an environment that supports worktree history.
          </p>
        ) : null}
        {busy || (syncing && !timeline) ? (
          <p role="status" className="mb-3 text-xs text-muted-foreground">
            Loading worktree history…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {timeline ? (
          <>
            {linkedAttempt ? (
              <div className="mb-5 flex flex-wrap items-center gap-2 border-b pb-4 text-xs">
                <TicketIcon className="size-4 text-muted-foreground" />
                <button
                  type="button"
                  className="min-w-0 truncate text-left hover:underline"
                  onClick={() =>
                    onViewBoard?.({
                      environmentId: linkedAttempt.link.sourceEnvironmentId,
                      projectId: linkedAttempt.link.sourceProjectId,
                      boardId: linkedAttempt.link.boardId,
                      issueId: linkedAttempt.link.issue.id,
                    })
                  }
                >
                  #{linkedAttempt.link.issue.number}
                  {boardItem ? ` · ${boardItem.issue.title}` : ""}
                </button>
                {boardColumn ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {boardColumn.title}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Board status unavailable</span>
                )}
                {onViewBoard ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      onViewBoard({
                        environmentId: linkedAttempt.link.sourceEnvironmentId,
                        projectId: linkedAttempt.link.sourceProjectId,
                        boardId: linkedAttempt.link.boardId,
                      })
                    }
                  >
                    View board
                  </Button>
                ) : null}
              </div>
            ) : null}
            <header className="mb-6">
              <h1 className="text-xl font-medium tracking-tight">
                {boardItem?.issue.title ?? timeline.worktree.branch ?? "Detached worktree"}
              </h1>
              <p className="mt-2 break-all text-xs text-muted-foreground">
                {timeline.worktree.path} · {environment?.label}
                {linkedAttempt
                  ? ` · ${linkedAttempt.active ? "Active attempt" : "Earlier attempt"}`
                  : ""}
              </p>
            </header>
            {favorites.length ? (
              <section className="mb-7">
                <h2 className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <StarIcon className="size-3.5" />
                  Pinned documents
                </h2>
                {favorites.map(documentRow)}
              </section>
            ) : null}
            {timeline.documents.some(
              (document) =>
                document.step.kind === "commit" &&
                !timeline.commits.some(
                  (commit) =>
                    document.step.kind === "commit" && commit.sha === document.step.commitSha,
                ),
            ) ? (
              <section className="mt-4 border-t pt-4">
                <h2 className="text-sm font-medium">Earlier commits</h2>
                {timeline.documents
                  .filter(
                    (document) =>
                      document.step.kind === "commit" &&
                      !timeline.commits.some(
                        (commit) =>
                          document.step.kind === "commit" && commit.sha === document.step.commitSha,
                      ),
                  )
                  .map((document) => (
                    <div key={document.id}>
                      <p className="text-xs text-muted-foreground">
                        {document.step.kind === "commit" ? document.step.commitSha : ""}
                      </p>
                      {documentRow(document)}
                    </div>
                  ))}
              </section>
            ) : null}
            <div className="mb-5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {timeline.commits.length} commits{" "}
                {timeline.worktree.baseRef
                  ? `beyond ${timeline.worktree.baseRef}`
                  : "in available history"}
              </span>
              <span>Oldest first</span>
            </div>
            <div className="ml-3 border-l pl-7">
              {timeline.commits.map((commit) => (
                <section key={commit.sha} className="relative pb-7">
                  <span className="absolute -left-[37px] top-0 bg-background py-0.5 text-muted-foreground">
                    <GitCommitHorizontalIcon className="size-4" />
                  </span>
                  <h2 className="text-sm font-medium">{commit.subject}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="font-mono">{commit.sha.slice(0, 7)}</span> ·{" "}
                    {new Date(commit.committedAt).toLocaleString()} ·{" "}
                    <span className="text-success">
                      +{commit.files.reduce((sum, file) => sum + file.insertions, 0)}
                    </span>{" "}
                    −{commit.files.reduce((sum, file) => sum + file.deletions, 0)}
                  </p>
                  <details open className="mt-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      {commit.files.length} changed {commit.files.length === 1 ? "file" : "files"}
                    </summary>
                    <div className="mt-1">{commit.files.map((file) => fileRow(file, commit))}</div>
                  </details>
                  {documentsAtStep(timeline.documents, {
                    kind: "commit",
                    commitSha: commit.sha,
                  }).map(documentRow)}
                </section>
              ))}
              <section className="relative pb-5">
                <span className="absolute -left-[33px] top-1.5 size-2 rounded-full border border-primary bg-background" />
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  Work in progress{" "}
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    Uncommitted
                  </span>
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {timeline.wip.files.length} file changes
                  {timeline.wip.files.some((file) => file.status !== "untracked") ? (
                    <>
                      {" "}
                      · Tracked +{timeline.wip.insertions} −{timeline.wip.deletions}
                    </>
                  ) : null}
                </p>
                {timeline.wip.files.length ? (
                  <details open className="mt-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Changed files
                    </summary>
                    <div className="mt-1">{timeline.wip.files.map((file) => fileRow(file))}</div>
                  </details>
                ) : null}
                {documentsAtStep(timeline.documents, { kind: "wip" }).map(documentRow)}
                {!timeline.wip.files.length &&
                !documentsAtStep(timeline.documents, { kind: "wip" }).length ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    No uncommitted changes or documents in this step.
                  </p>
                ) : null}
              </section>
            </div>
            {documentsAtStep(timeline.documents, { kind: "unassigned" }).length ? (
              <section className="mt-4 border-t pt-4">
                <h2 className="text-sm font-medium">Unassigned documents</h2>
                {documentsAtStep(timeline.documents, { kind: "unassigned" }).map(documentRow)}
              </section>
            ) : null}
            {timeline.folderLinks.length ? (
              <section className="mt-4 border-t pt-4">
                <h2 className="mb-2 text-sm font-medium">Linked document folders</h2>
                {timeline.folderLinks.map((folder) => (
                  <div key={folder.id} className="flex items-center gap-2 py-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      {folder.path} ·{" "}
                      {folder.timeLink === "none"
                        ? "Time linking off"
                        : folder.timeLink === "birthtime"
                          ? "Creation time"
                          : "Modified time"}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        if (environmentId && connected)
                          void unlink({
                            environmentId,
                            input: { requestId: randomUUID(), folderLinkId: folder.id },
                          })
                            .then(unwrapWorkResult)
                            .then(() => refresh())
                            .catch((failure) => setError(workError(failure)));
                      }}
                    >
                      Unlink
                    </Button>
                  </div>
                ))}
              </section>
            ) : null}
          </>
        ) : !busy && environmentId && connected ? (
          <p className="text-sm text-muted-foreground">
            {requestedWorktreePath
              ? `The requested worktree is unavailable: ${requestedWorktreePath}. Choose a worktree above to continue.`
              : "No local worktrees were found in this environment's projects."}
          </p>
        ) : null}
        {finding && timeline && environmentId && connected ? (
          <DocumentFolderPicker
            environmentId={environmentId}
            timeline={timeline}
            onClose={() => setFinding(false)}
            onLinked={() => {
              setFinding(false);
              void refresh();
            }}
          />
        ) : null}
        {opened && stateEnvironment === environmentId && (!requestedWorktreePath || timeline) ? (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) {
                openedDocumentId.current = undefined;
                documentReadGeneration.current++;
                setBusy(false);
                setDocumentSyncing(false);
                setOpened(null);
              }
            }}
          >
            <DialogPopup className="h-[85dvh] max-w-5xl">
              <DialogHeader>
                <DialogTitle>{opened.title}</DialogTitle>
                <p className="text-xs text-muted-foreground">
                  {opened.live
                    ? "Live file. The commit link identifies the work this document describes."
                    : "Retained published revision."}
                  {opened.truncated ? " Preview is truncated." : ""}
                </p>
              </DialogHeader>
              <div className="flex min-h-0 flex-1 flex-col">
                {opened.format === "html" ? (
                  <BrowserDocumentFrame
                    src="about:blank"
                    pdf={false}
                    title={opened.title}
                    srcDoc={documentPreviewHtml(opened.content)}
                    restricted
                  />
                ) : opened.format === "markdown" ? (
                  <div className="min-h-0 flex-1 overflow-auto p-5">
                    <ChatMarkdown
                      text={opened.content}
                      cwd={opened.cwd}
                      environmentId={environmentId}
                    />
                  </div>
                ) : (
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-5 text-sm">
                    {opened.content}
                  </pre>
                )}
              </div>
            </DialogPopup>
          </Dialog>
        ) : null}
      </div>
      {validDiff ? (
        <aside
          aria-label="Selected file diff"
          className="min-h-0 w-1/2 min-w-0 shrink-0 border-l @max-[900px]/open-work:w-full"
        >
          <Suspense
            fallback={
              <p role="status" className="p-4 text-sm text-muted-foreground">
                Loading diff viewer…
              </p>
            }
          >
            <OpenWorkDiffPanel
              selection={validDiff}
              siblings={diffSiblings}
              onSelect={setDiffSelection}
              revision={revision}
              connected={connected}
              onClose={closeDiff}
            />
          </Suspense>
        </aside>
      ) : null}
    </div>
  );
}

function DocumentFolderPicker({
  environmentId,
  timeline,
  onClose,
  onLinked,
}: {
  environmentId: EnvironmentId;
  timeline: OpenWorkTimelineResult;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [path, setPath] = useState(timeline.worktree.path);
  const [browsePath, setBrowsePath] = useState(timeline.worktree.path);
  const [timeLink, setTimeLink] = useState<OpenWorkTimeLink>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browse = useEnvironmentQuery(
    filesystemEnvironment.browse({
      environmentId,
      input: { partialPath: `${browsePath.replace(/[\\/]$/, "")}/`, cwd: timeline.worktree.path },
    }),
  );
  const link = useAtomCommand(openWorkEnvironment.linkFolder, { reportFailure: false });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Find documents</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Choose a folder on this environment. Markdown and HTML files in its subfolders remain
            live.
          </p>
        </DialogHeader>
        <DialogPanel>
          <label className="grid gap-1 text-xs">
            Folder path
            <Input value={path} onChange={(event) => setPath(event.target.value)} />
          </label>
          <div className="my-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setBrowsePath(path)}>
              Browse
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const parent = browsePath.replace(/[\\/]?[^\\/]+[\\/]?$/, "");
                if (parent) {
                  setBrowsePath(parent);
                  setPath(parent);
                }
              }}
            >
              Parent folder
            </Button>
          </div>
          <div className="max-h-48 overflow-auto border">
            {browse.data?.entries.map((entry) => (
              <button
                type="button"
                key={entry.fullPath}
                className="block w-full border-b px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setPath(entry.fullPath);
                  setBrowsePath(entry.fullPath);
                }}
              >
                {entry.name}
              </button>
            ))}
          </div>
          {browse.isPending ? (
            <p className="text-xs text-muted-foreground">Reading folders…</p>
          ) : null}
          {browse.error ? <p className="text-xs text-destructive">{browse.error}</p> : null}
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={timeLink !== "none"}
              onChange={(event) => setTimeLink(event.target.checked ? "birthtime" : "none")}
            />
            Apply time-based document linking
          </label>
          {timeLink !== "none" ? (
            <label className="mt-2 grid gap-1 text-xs">
              Document time
              <select
                value={timeLink}
                onChange={(event) =>
                  setTimeLink(event.target.value === "mtime" ? "mtime" : "birthtime")
                }
                className="rounded-md border bg-background p-2"
              >
                <option value="birthtime">Creation time</option>
                <option value="mtime">Last modified time</option>
              </select>
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !path.trim()}
            onClick={() => {
              setBusy(true);
              setError(null);
              void link({
                environmentId,
                input: {
                  requestId: randomUUID(),
                  worktreeId: timeline.worktree.id,
                  path,
                  timeLink,
                },
              })
                .then(unwrapWorkResult)
                .then(onLinked)
                .catch((failure) => setError(workError(failure)))
                .finally(() => setBusy(false));
            }}
          >
            Link folder
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
