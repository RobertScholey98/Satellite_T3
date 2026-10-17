import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { OpenWorkUnsupportedError } from "@t3tools/client-runtime/state/open-work";
import {
  type EnvironmentId,
  type OpenWorkCommit,
  type OpenWorkCommitFilesResult,
  type OpenWorkFile,
  type OpenWorkTimelineResult,
  type OpenWorkWipFile,
  OpenWorkWorktreeNotFoundError,
  type OpenWorktreeSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  MessageSquareIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { openWorkEnvironment } from "~/state/openWork";
import { type EnvironmentQueryView, useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { vcsEnvironment } from "~/state/vcs";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  type OpenWorkTarget,
  ownerPullRequest,
  readLastOpenWorkSelection,
  resolveWorktreeOwner,
  selectWorktree,
  writeLastOpenWorkSelection,
} from "./openWork.logic";
import { OpenWorkDiffPanel, type OpenWorkDiffTarget } from "./OpenWorkDiffPanel";
import { WorkTabs } from "./WorkTabs";

const FOCUS_REFRESH_DEBOUNCE_MS = 250;
const isUnsupported = Schema.is(OpenWorkUnsupportedError);
const isWorktreeGone = Schema.is(OpenWorkWorktreeNotFoundError);
const LAYERS = [
  { layer: "staged", label: "Staged" },
  { layer: "unstaged", label: "Unstaged" },
  { layer: "untracked", label: "Untracked" },
] as const;
const commitTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const shortSha = (sha: string) => sha.slice(0, 7);
const worktreeName = (worktree: OpenWorktreeSummary) =>
  worktree.branch ?? (worktree.head ? `Detached at ${shortSha(worktree.head)}` : "Detached HEAD");

/**
 * Every worktree of the environment's registered projects, and for the selected one its commits
 * beyond main and a live work-in-progress step.
 */
export function OpenWorkView({
  target,
  onTargetChange,
}: {
  readonly target: OpenWorkTarget;
  readonly onTargetChange: (target: OpenWorkTarget) => void;
}) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [remembered] = useState(readLastOpenWorkSelection);
  const environmentIds = environments.map((environment) => environment.environmentId);
  const environmentId =
    target.environmentId ??
    (remembered.environmentId && environmentIds.includes(remembered.environmentId)
      ? remembered.environmentId
      : null) ??
    primaryEnvironmentId ??
    environmentIds[0] ??
    null;
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);

  const listQuery = useEnvironmentQuery(
    environmentId ? openWorkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const [projectFilter, setProjectFilter] = useState<ProjectId | null>(null);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const worktrees = (listQuery.data?.worktrees ?? []).filter(
    (worktree) => projectFilter === null || worktree.projectIds.includes(projectFilter),
  );
  const requestedPath =
    target.environmentId === undefined || target.environmentId === environmentId
      ? target.worktreePath
      : undefined;
  const selection = listQuery.data
    ? selectWorktree(
        worktrees,
        requestedPath,
        remembered.environmentId === environmentId ? remembered.worktreePath : undefined,
      )
    : null;
  const selected = selection?.kind === "selected" ? selection.worktree : null;
  const selectedPath = selected?.path ?? null;
  // The project the worktree was listed under, so the server checks only its repository.
  const projectHint = selected?.projectIds[0];
  const worktreeInput = (path: string) =>
    projectHint === undefined ? { path } : { path, projectId: projectHint };

  const timelineQuery = useEnvironmentQuery(
    environmentId && selectedPath
      ? openWorkEnvironment.timeline({ environmentId, input: worktreeInput(selectedPath) })
      : null,
  );
  const timeline = timelineQuery.data?.worktree.path === selectedPath ? timelineQuery.data : null;
  const refreshList = listQuery.refresh;
  const refreshTimeline = timelineQuery.refresh;

  useEffect(() => {
    if (environmentId && selectedPath) {
      writeLastOpenWorkSelection({ environmentId, worktreePath: selectedPath });
    }
  }, [environmentId, selectedPath]);

  useEffect(() => {
    let timeout: number | null = null;
    const schedule = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        timeout = null;
        refreshList();
        refreshTimeline();
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
  }, [refreshList, refreshTimeline]);

  // Upstream refreshes local status after an agent run and after git actions. With remote status
  // off, this subscription starts no poller; each local update rereads the selected timeline.
  const localStatus = useEnvironmentQuery(
    environmentId && selectedPath && listQuery.isSuccess
      ? vcsEnvironment.status({
          environmentId,
          input: { cwd: selectedPath, includeRemote: false },
        })
      : null,
  ).data;
  const seenStatus = useRef(localStatus);
  useEffect(() => {
    const previous = seenStatus.current;
    seenStatus.current = localStatus;
    if (previous && localStatus && previous !== localStatus) refreshTimeline();
  }, [localStatus, refreshTimeline]);

  const cleanupReport = useEnvironmentQuery(
    environmentId && listQuery.isSuccess
      ? serverEnvironment.storageCleanupReport({ environmentId, input: {} })
      : null,
  ).data;
  const seenReport = useRef(cleanupReport?.finishedAt);
  useEffect(() => {
    const previous = seenReport.current;
    seenReport.current = cleanupReport?.finishedAt;
    if (
      previous !== undefined &&
      cleanupReport &&
      cleanupReport.finishedAt !== previous &&
      cleanupReport.entries.some(
        (entry) => entry.kind === "worktree" && entry.outcome === "removed",
      )
    ) {
      refreshList();
    }
  }, [cleanupReport, refreshList]);

  const threads = useThreadShells().filter((thread) => thread.environmentId === environmentId);
  const owner = selectedPath ? resolveWorktreeOwner(threads, selectedPath) : null;
  const pullRequest = ownerPullRequest(owner);

  // A diff belongs to the worktree it was opened in; selecting another one closes it.
  const worktreeKey = JSON.stringify([environmentId, selectedPath]);
  const [openDiff, setOpenDiff] = useState<{
    readonly worktreeKey: string;
    readonly target: OpenWorkDiffTarget;
  } | null>(null);
  const diffTarget = openDiff?.worktreeKey === worktreeKey ? openDiff.target : null;
  const setDiffTarget = (target: OpenWorkDiffTarget | null) =>
    setOpenDiff(target ? { worktreeKey, target } : null);
  useEscapeToGoBack(diffTarget ? () => setDiffTarget(null) : undefined);

  // One commit at a time lists its files; they load on expand and stay cached per SHA.
  const [expanded, setExpanded] = useState<{
    readonly worktreeKey: string;
    readonly sha: string;
  } | null>(null);
  const expandedSha = expanded?.worktreeKey === worktreeKey ? expanded.sha : null;
  const toggleCommit = (sha: string) =>
    setExpanded(expandedSha === sha ? null : { worktreeKey, sha });
  const commitFilesAtom = (sha: string | null) =>
    environmentId && timeline && sha
      ? openWorkEnvironment.commitFiles({
          environmentId,
          input: { ...worktreeInput(timeline.worktree.path), sha },
        })
      : null;
  const expandedFiles = useEnvironmentQuery(commitFilesAtom(expandedSha));
  const diffCommitFiles = useEnvironmentQuery(
    commitFilesAtom(diffTarget?.step.kind === "commit" ? diffTarget.step.sha : null),
  ).data;

  const selectWorktreePath = (path: string) => {
    if (environmentId) onTargetChange({ environmentId, worktreePath: path });
  };
  const syncing = listQuery.isPending || timelineQuery.isPending;
  const unsupported = isUnsupported(listQuery.failure);
  const removedMessage =
    selection?.kind === "missing" || (isWorktreeGone(timelineQuery.failure) && !timeline)
      ? "This worktree no longer exists. Choose another one."
      : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <WorkTabs current="open-work" syncing={syncing} />
        <div className="min-w-0 flex-1" />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh open work"
          disabled={!environmentId}
          onClick={() => {
            refreshList();
            refreshTimeline();
          }}
        >
          <RefreshIcon size="md" refreshing={syncing} />
        </Button>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1">
        <div
          className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", diffTarget && "max-lg:hidden")}
        >
          <WorkspacePageContainer width="wide" className="gap-5">
            <div className="flex flex-wrap items-center gap-2">
              {environments.length > 1 ? (
                <PickerMenu
                  label="Environment"
                  value={environmentId ?? ""}
                  current={environment?.label ?? "Choose an environment"}
                  options={environments.map((candidate) => ({
                    value: candidate.environmentId,
                    label: candidate.label,
                  }))}
                  onChange={(value) => onTargetChange({ environmentId: value as EnvironmentId })}
                />
              ) : null}
              {projects.length > 1 ? (
                <PickerMenu
                  label="Project"
                  value={projectFilter ?? ""}
                  current={
                    projects.find((project) => project.id === projectFilter)?.title ??
                    "All projects"
                  }
                  options={[
                    { value: "", label: "All projects" },
                    ...projects.map((project) => ({ value: project.id, label: project.title })),
                  ]}
                  onChange={(value) => setProjectFilter(value ? (value as ProjectId) : null)}
                />
              ) : null}
              <WorktreeMenu
                worktrees={worktrees}
                selectedPath={selectedPath}
                ownerTitle={(path) => resolveWorktreeOwner(threads, path)?.title ?? null}
                onSelect={selectWorktreePath}
              />
            </div>
            {unsupported ? (
              <Notice>This environment does not support Open work.</Notice>
            ) : listQuery.error && !listQuery.data ? (
              <Notice tone="error">{listQuery.error}</Notice>
            ) : listQuery.data && listQuery.data.worktrees.length === 0 ? (
              <Notice>No worktrees were found in this environment's projects.</Notice>
            ) : null}
            {removedMessage ? <Notice>{removedMessage}</Notice> : null}
            {timelineQuery.error && timeline ? (
              <Notice tone="error">Refresh failed: {timelineQuery.error}</Notice>
            ) : null}
            {selected && environmentId ? (
              <WorktreeHeader
                worktree={timeline?.worktree ?? selected}
                ownerTitle={owner?.title ?? null}
                onOpenThread={
                  owner
                    ? () =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(scopeThreadRef(environmentId, owner.id)),
                        })
                    : null
                }
                onOpenPullRequest={
                  pullRequest
                    ? () =>
                        void navigate({
                          to: "/pull-requests",
                          search: {
                            involvement: "all",
                            state: "all",
                            repository: pullRequest.repository,
                            number: pullRequest.number,
                            selectedProjectId: pullRequest.projectId,
                            selectedEnvironmentId: environmentId,
                          },
                        })
                    : null
                }
              />
            ) : null}
            {timeline ? (
              <Timeline
                timeline={timeline}
                diffTarget={diffTarget}
                onOpenDiff={setDiffTarget}
                expandedSha={expandedSha}
                expandedFiles={expandedFiles}
                onToggleCommit={toggleCommit}
              />
            ) : null}
          </WorkspacePageContainer>
        </div>
        {diffTarget && timeline && environmentId ? (
          <aside
            aria-label="File diff"
            className="min-h-0 w-1/2 min-w-0 shrink-0 border-l border-border max-lg:w-full"
          >
            <OpenWorkDiffPanel
              environmentId={environmentId}
              worktreePath={timeline.worktree.path}
              projectId={projectHint}
              target={diffTarget}
              siblings={diffSiblings(timeline, diffTarget, diffCommitFiles?.files ?? [])}
              revision={timelineQuery.dataUpdatedAt}
              onSelect={setDiffTarget}
              onClose={() => setDiffTarget(null)}
            />
          </aside>
        ) : null}
      </div>
    </SidebarInset>
  );
}

function diffSiblings(
  timeline: OpenWorkTimelineResult,
  target: OpenWorkDiffTarget,
  commitFiles: ReadonlyArray<OpenWorkFile>,
): ReadonlyArray<OpenWorkDiffTarget> {
  const step = target.step;
  const files =
    step.kind === "commit"
      ? commitFiles
      : timeline.wip.files.filter(
          (file, index, all) => all.findIndex((other) => other.path === file.path) === index,
        );
  return files.map((file) => ({
    step,
    file: { path: file.path, previousPath: file.previousPath },
  }));
}

function Notice({ tone, children }: { tone?: "error"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn("text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground")}
    >
      {children}
    </p>
  );
}

function PickerMenu({
  label,
  value,
  current,
  options,
  onChange,
}: {
  label: string;
  value: string;
  current: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger aria-label={label} render={<Button variant="outline" size="sm" />}>
        <span className="max-w-48 truncate">{current}</span>
        <ChevronDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(String(next))}>
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function Divergence({ worktree }: { worktree: OpenWorktreeSummary }) {
  if (worktree.ahead === null || worktree.behind === null) {
    return <span className="text-muted-foreground">No main found</span>;
  }
  return (
    <span className="font-mono text-muted-foreground tabular-nums">
      ↑{worktree.ahead} ↓{worktree.behind}
    </span>
  );
}

function WorktreeMenu({
  worktrees,
  selectedPath,
  ownerTitle,
  onSelect,
}: {
  worktrees: ReadonlyArray<OpenWorktreeSummary>;
  selectedPath: string | null;
  ownerTitle: (path: string) => string | null;
  onSelect: (path: string) => void;
}) {
  const selected = worktrees.find((worktree) => worktree.path === selectedPath);
  return (
    <Menu>
      <MenuTrigger
        aria-label="Worktree"
        disabled={worktrees.length === 0}
        render={<Button variant="outline" size="sm" />}
      >
        <GitBranchIcon className="size-3.5" />
        <span className="max-w-64 truncate">
          {selected ? worktreeName(selected) : "Choose a worktree"}
        </span>
        <ChevronDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-[min(36rem,90vw)]">
        <MenuRadioGroup value={selectedPath ?? ""} onValueChange={(path) => onSelect(String(path))}>
          {worktrees.map((worktree) => {
            const title = ownerTitle(worktree.path);
            return (
              <MenuRadioItem key={worktree.path} value={worktree.path}>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="truncate">{worktreeName(worktree)}</span>
                    {worktree.primary ? (
                      <Badge variant="secondary" size="sm">
                        Primary
                      </Badge>
                    ) : null}
                    <span className="ml-auto shrink-0 pl-3 text-xs">
                      <Divergence worktree={worktree} />
                    </span>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {title ?? "No thread"} · {worktree.path}
                  </span>
                </div>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function WorktreeHeader({
  worktree,
  ownerTitle,
  onOpenThread,
  onOpenPullRequest,
}: {
  worktree: OpenWorktreeSummary;
  ownerTitle: string | null;
  onOpenThread: (() => void) | null;
  onOpenPullRequest: (() => void) | null;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <header className="flex flex-col gap-2 border-b border-border/60 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="truncate text-lg font-medium">{worktreeName(worktree)}</h2>
        {worktree.primary ? <Badge variant="secondary">Primary checkout</Badge> : null}
        <span className="text-xs">
          <Divergence worktree={worktree} />
          {worktree.baseRef ? (
            <span className="text-muted-foreground"> against {worktree.baseRef}</span>
          ) : null}
        </span>
      </div>
      <p className="text-xs break-all text-muted-foreground">{worktree.path}</p>
      <p className="text-sm text-muted-foreground">
        {ownerTitle ? `Thread: ${ownerTitle}` : "No thread owns this worktree."}
      </p>
      <div className="flex flex-wrap gap-2">
        {onOpenThread ? (
          <Button size="sm" variant="outline" onClick={onOpenThread}>
            <MessageSquareIcon />
            Open thread
          </Button>
        ) : null}
        {onOpenPullRequest ? (
          <Button size="sm" variant="outline" onClick={onOpenPullRequest}>
            <PullRequestGlyph.pullRequest />
            Open pull request
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => copyToClipboard(worktree.path)}>
          <CopyIcon />
          {isCopied ? "Copied" : "Copy path"}
        </Button>
      </div>
    </header>
  );
}

function Timeline({
  timeline,
  diffTarget,
  onOpenDiff,
  expandedSha,
  expandedFiles,
  onToggleCommit,
}: {
  timeline: OpenWorkTimelineResult;
  diffTarget: OpenWorkDiffTarget | null;
  onOpenDiff: (target: OpenWorkDiffTarget) => void;
  expandedSha: string | null;
  expandedFiles: EnvironmentQueryView<OpenWorkCommitFilesResult>;
  onToggleCommit: (sha: string) => void;
}) {
  const isOpen = (sha: string | null, file: OpenWorkFile) =>
    diffTarget?.file.path === file.path &&
    (sha === null
      ? diffTarget.step.kind === "wip"
      : diffTarget.step.kind === "commit" && diffTarget.step.sha === sha);
  return (
    <ol className="flex flex-col gap-6" aria-label="Commits beyond main, oldest first">
      {timeline.commitsTruncated ? (
        <li className="text-xs text-muted-foreground">
          Showing the newest {timeline.commits.length} commits.
        </li>
      ) : null}
      {timeline.commits.map((commit) => (
        <CommitStep
          key={commit.sha}
          commit={commit}
          files={commit.sha === expandedSha ? expandedFiles : null}
          onToggle={() => onToggleCommit(commit.sha)}
          isOpen={(file) => isOpen(commit.sha, file)}
          onOpenFile={(file) =>
            onOpenDiff({
              step: { kind: "commit", sha: commit.sha },
              file: { path: file.path, previousPath: file.previousPath },
            })
          }
        />
      ))}
      <li className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span aria-hidden className="size-2 rounded-full border border-primary" />
          Work in progress
          {timeline.wip.files.length > 0 ? (
            <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
              +{timeline.wip.insertions} −{timeline.wip.deletions}
            </span>
          ) : null}
        </div>
        {timeline.wip.files.length === 0 ? (
          <p className="text-xs text-muted-foreground">No uncommitted changes.</p>
        ) : (
          LAYERS.map(({ layer, label }) => {
            const files = timeline.wip.files.filter((file) => file.layer === layer);
            return files.length === 0 ? null : (
              <section key={layer} aria-label={label} className="flex flex-col">
                <h3 className="text-xs text-muted-foreground">{label}</h3>
                {files.map((file) => (
                  <FileRow
                    key={`${layer}:${file.path}`}
                    file={file}
                    open={isOpen(null, file)}
                    onOpen={() =>
                      onOpenDiff({
                        step: { kind: "wip" },
                        file: { path: file.path, previousPath: file.previousPath },
                      })
                    }
                  />
                ))}
              </section>
            );
          })
        )}
        {timeline.wip.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the first {timeline.wip.files.length} files.
          </p>
        ) : null}
      </li>
    </ol>
  );
}

function CommitStep({
  commit,
  files,
  onToggle,
  isOpen,
  onOpenFile,
}: {
  commit: OpenWorkCommit;
  /** The commit's file query while it is expanded. */
  files: EnvironmentQueryView<OpenWorkCommitFilesResult> | null;
  onToggle: () => void;
  isOpen: (file: OpenWorkFile) => boolean;
  onOpenFile: (file: OpenWorkFile) => void;
}) {
  const listed = files?.data?.sha === commit.sha ? files.data : null;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <GitCommitHorizontalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{commit.subject}</span>
      </div>
      <div className="flex items-center gap-1 pl-6 text-xs text-muted-foreground">
        <span className="font-mono">{shortSha(commit.sha)}</span>
        <span>· {commitTime.format(new Date(commit.committedAt))} ·</span>
        <Button
          size="micro"
          variant="ghost-muted"
          aria-expanded={files !== null}
          disabled={commit.fileCount === 0}
          onClick={onToggle}
        >
          {files !== null ? <ChevronDownIcon /> : <ChevronRightIcon />}
          {commit.fileCount} {commit.fileCount === 1 ? "file" : "files"}
        </Button>
        <span className="font-mono tabular-nums">
          +{commit.insertions} −{commit.deletions}
        </span>
      </div>
      {files === null ? null : (
        <div className="flex flex-col pl-4">
          {listed ? (
            listed.files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                open={isOpen(file)}
                onOpen={() => onOpenFile(file)}
              />
            ))
          ) : files.error ? (
            <p role="alert" className="px-2 text-xs text-destructive">
              {files.error}
            </p>
          ) : (
            <p role="status" className="px-2 text-xs text-muted-foreground">
              Loading files…
            </p>
          )}
          {listed?.truncated ? (
            <p className="px-2 text-xs text-muted-foreground">
              Showing the first {listed.files.length} files.
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

const STATUS_LETTER: Record<OpenWorkFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  conflicted: "U",
};

function FileRow({
  file,
  open,
  onOpen,
}: {
  file: OpenWorkFile | OpenWorkWipFile;
  open: boolean;
  onOpen: () => void;
}) {
  const untracked = "layer" in file && file.layer === "untracked";
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={onOpen}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
        open && "bg-accent",
      )}
    >
      <span className="w-3 shrink-0 font-mono text-muted-foreground">
        {untracked ? "?" : STATUS_LETTER[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {file.previousPath ? `${file.previousPath} → ` : ""}
        {file.path}
      </span>
      {untracked ? null : (
        <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
          +{file.insertions} −{file.deletions}
        </span>
      )}
    </button>
  );
}
