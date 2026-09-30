import type {
  EnvironmentId,
  OpenWorkDocument,
  OpenWorkTimelineResult,
  OpenWorktreeSummary,
  OpenWorkTimeLink,
  IssueAttempt,
} from "@t3tools/contracts";
import { documentPreviewHtml } from "@t3tools/client-runtime/documents";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { FileTextIcon, StarIcon, TicketIcon, FolderSearchIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

export function OpenWorkView() {
  const { environments } = useEnvironments();
  const available = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.openWork === true,
  );
  const [environmentKey, setEnvironmentKey] = useState<EnvironmentId | null>(null);
  const environment =
    available.find((candidate) => candidate.environmentId === environmentKey) ?? available[0];
  const environmentId = environment?.environmentId;
  const connected = environment?.connection.phase === "connected";
  const [worktrees, setWorktrees] = useState<readonly OpenWorktreeSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<OpenWorkTimelineResult | null>(null);
  const [favorites, setFavorites] = useState<readonly OpenWorkDocument[]>([]);
  const [attempts, setAttempts] = useState<readonly IssueAttempt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);
  const [opened, setOpened] = useState<{
    title: string;
    format: string;
    content: string;
    truncated: boolean;
    live: boolean;
    cwd: string;
  } | null>(null);
  const generation = useRef(0);
  const list = useAtomCommand(openWorkEnvironment.list, { reportFailure: false });
  const getTimeline = useAtomCommand(openWorkEnvironment.timeline, { reportFailure: false });
  const getFavorites = useAtomCommand(openWorkEnvironment.favorites, { reportFailure: false });
  const favorite = useAtomCommand(openWorkEnvironment.setFavorite, { reportFailure: false });
  const assign = useAtomCommand(openWorkEnvironment.assignDocument, { reportFailure: false });
  const unlink = useAtomCommand(openWorkEnvironment.unlinkFolder, { reportFailure: false });
  const readLinked = useAtomCommand(openWorkEnvironment.readLinked, { reportFailure: false });
  const readPublished = useAtomCommand(documentsEnvironment.get, { reportFailure: false });
  const listAttempts = useAtomCommand(issuesEnvironment.listAttempts, { reportFailure: false });
  const refresh = useCallback(
    async (worktreeId?: string) => {
      if (!environmentId || !connected) return;
      const current = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        const [inventory, pinned] = await Promise.all([
          list({ environmentId, input: {} }).then(unwrapWorkResult),
          getFavorites({ environmentId, input: {} }).then(unwrapWorkResult),
        ]);
        if (current !== generation.current) return;
        setWorktrees(inventory.worktrees);
        setFavorites(pinned.documents);
        const preferredId = worktreeId ?? selectedId;
        const id =
          inventory.worktrees.find((worktree) => worktree.id === preferredId)?.id ??
          inventory.worktrees[0]?.id;
        if (id && inventory.worktrees.some((worktree) => worktree.id === id)) {
          const value = unwrapWorkResult(
            await getTimeline({ environmentId, input: { worktreeId: id } }),
          );
          if (current === generation.current) {
            setTimeline(value);
            setSelectedId(id);
          }
        } else {
          setTimeline(null);
          setSelectedId(null);
        }
      } catch (failure) {
        if (current === generation.current) setError(workError(failure));
      } finally {
        if (current === generation.current) setBusy(false);
      }
    },
    [environmentId, connected, list, getTimeline, getFavorites, selectedId],
  );
  useEffect(() => {
    generation.current++;
    setWorktrees([]);
    setTimeline(null);
    setFavorites([]);
    setSelectedId(null);
    setAttempts([]);
    setOpened(null);
    setFinding(false);
    setError(null);
    setBusy(false);
  }, [environmentId]);

  useEffect(() => {
    if (!environmentId || !connected) return;
    const currentEnvironmentId = environmentId;
    let current = true;
    void refresh();
    if (environmentId && environment?.serverConfig?.environment.capabilities.issueBoards) {
      void listAttempts({ environmentId, input: {} })
        .then(unwrapWorkResult)
        .then((value) => {
          if (current && currentEnvironmentId === environmentId) setAttempts(value);
        })
        .catch((failure) => {
          if (current) setError(workError(failure));
        });
    }
    return () => {
      current = false;
      generation.current++;
    };
  }, [environmentId, connected]);
  useLiveRefresh(
    environmentId && connected && !busy && !finding && !opened
      ? () => {
          void refresh();
        }
      : null,
    { key: `open-work:${environmentId ?? "none"}:${selectedId ?? "none"}` },
  );
  const openDocument = async (document: OpenWorkDocument) => {
    if (!environmentId || !connected || !document.available) return;
    setBusy(true);
    setError(null);
    try {
      if (document.source.kind === "linked") {
        const result = unwrapWorkResult(
          await readLinked({ environmentId, input: { documentId: document.id } }),
        );
        setOpened({ title: document.title, ...result, live: true, cwd: document.worktreeId });
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
        setOpened({
          title: document.title,
          format: result.revision.format,
          content: result.content,
          truncated: false,
          live: false,
          cwd: document.worktreeId,
        });
      }
    } catch (failure) {
      setError(workError(failure));
    } finally {
      setBusy(false);
    }
  };
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
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-5">
      {environmentId && !connected ? (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {environment.label} is not connected. Last loaded history stays visible; reconnect to
          update it.
        </p>
      ) : null}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <select
          aria-label="Open work environment"
          value={environmentId ?? ""}
          onChange={(event) => setEnvironmentKey(event.target.value as EnvironmentId)}
          className="max-w-64 rounded-md border bg-background px-2 py-2 text-sm"
        >
          {available.map((candidate) => (
            <option key={candidate.environmentId} value={candidate.environmentId}>
              {candidate.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Worktree"
          value={selectedId ?? ""}
          onChange={(event) => {
            setSelectedId(event.target.value);
            void refresh(event.target.value);
          }}
          className="min-w-0 max-w-xl rounded-md border bg-background px-2 py-2 text-sm"
        >
          {worktrees.map((worktree) => (
            <option key={worktree.id} value={worktree.id}>
              {attempts.some(
                (attempt) =>
                  attempt.worktreePath !== null &&
                  normalizeProjectPathForComparison(attempt.worktreePath) ===
                    normalizeProjectPathForComparison(worktree.path),
              )
                ? "🎫 (linked issue) "
                : ""}
              {worktree.branch ?? "Detached HEAD"} ·{" "}
              {worktree.ahead === null || worktree.behind === null
                ? "Main unavailable"
                : `↑${worktree.ahead} ↓${worktree.behind}`}{" "}
              · {worktree.path}
            </option>
          ))}
        </select>
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
      {!available.length ? (
        <p className="text-sm text-muted-foreground">
          Open work is unavailable. Connect an environment that supports worktree history.
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          Loading worktree history…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {favorites.length ? (
        <section className="mb-6 border-b pb-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <StarIcon className="size-4" />
            Favourite documents
          </h2>
          {favorites.map(documentRow)}
        </section>
      ) : null}
      {timeline ? (
        <>
          <div className="mb-5 text-xs text-muted-foreground">
            {timeline.worktree.path} · Compared with{" "}
            {timeline.worktree.baseRef ?? "unavailable main branch"}
          </div>
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
          {attempts
            .filter(
              (attempt) =>
                attempt.worktreePath !== null &&
                normalizeProjectPathForComparison(attempt.worktreePath) ===
                  normalizeProjectPathForComparison(timeline.worktree.path),
            )
            .map((attempt) => (
              <a
                key={attempt.link.attemptId}
                href={attempt.link.issue.url}
                target="_blank"
                rel="noreferrer"
                className="mb-3 flex items-center gap-2 text-xs"
              >
                <TicketIcon className="size-4" />
                Issue #{attempt.link.issue.number} ·{" "}
                {attempt.active ? "Active attempt" : "Earlier attempt"}
              </a>
            ))}
          <div className="ml-2 border-l pl-6">
            {timeline.commits.map((commit) => (
              <section key={commit.sha} className="relative pb-7">
                <span className="absolute -left-[29px] top-1 size-2 rounded-full bg-muted-foreground" />
                <h2 className="text-sm font-medium">{commit.subject}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {commit.sha.slice(0, 7)} · {new Date(commit.committedAt).toLocaleString()}
                </p>
                {documentsAtStep(timeline.documents, { kind: "commit", commitSha: commit.sha }).map(
                  documentRow,
                )}
              </section>
            ))}
            <section className="relative pb-5">
              <span className="absolute -left-[29px] top-1 size-2 rounded-full border border-primary bg-background" />
              <h2 className="text-sm font-medium">Work in progress</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {timeline.wip.files.length} changed files · +{timeline.wip.insertions} −
                {timeline.wip.deletions}
              </p>
              {timeline.wip.files.map((file) => (
                <p key={file.path} className="mt-2 flex gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  <span className="text-muted-foreground">
                    +{file.insertions} −{file.deletions}
                  </span>
                </p>
              ))}
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
          No local worktrees were found in this environment's projects.
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
      {opened ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setOpened(null);
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
