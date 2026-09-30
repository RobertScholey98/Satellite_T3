import type { EnvironmentId, ReviewDiffPreviewInput } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { createGitDiffFileContentsLoader } from "~/lib/diffFileContents";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getRenderablePatch,
  resolveDiffThemeName,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell } from "../DiffPanelShell";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";

export type OpenWorkDiffSelection = {
  environmentId: EnvironmentId;
  worktreeId: string;
  cwd: string;
  comparison: NonNullable<ReviewDiffPreviewInput["comparison"]>;
  file: NonNullable<ReviewDiffPreviewInput["file"]>;
  title: string;
};

/** Open history supplies its own environment and comparison rather than borrowing a chat route. */
export function OpenWorkDiffPanel({
  selection,
  revision,
  connected,
  onClose,
  siblings,
  onSelect,
}: {
  selection: OpenWorkDiffSelection;
  revision: number;
  connected: boolean;
  onClose: () => void;
  siblings: readonly OpenWorkDiffSelection[];
  onSelect: (selection: OpenWorkDiffSelection) => void;
}) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const closeRef = useRef<HTMLButtonElement>(null);
  const getFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const scope = JSON.stringify([
    selection.environmentId,
    selection.cwd,
    selection.comparison,
    selection.file,
    settings.diffIgnoreWhitespace,
  ]);
  const query = useEnvironmentQuery(
    connected
      ? reviewEnvironment.diffPreview({
          environmentId: selection.environmentId,
          input: {
            cwd: selection.cwd,
            comparison: selection.comparison,
            file: selection.file,
            ignoreWhitespace: settings.diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const previousRead = useRef({ scope, revision });
  useEffect(() => {
    const previous = previousRead.current;
    previousRead.current = { scope, revision };
    if (
      selection.comparison.kind !== "commit" &&
      previous.scope === scope &&
      previous.revision !== revision &&
      connected
    )
      query.refresh();
  }, [scope, revision, connected, query.refresh, selection.comparison.kind]);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  const source = query.data?.sources.find(
    (candidate) => candidate.kind === selection.file.sourceKind,
  );
  const patch = useMemo(() => {
    const parsed = getRenderablePatch(source?.diff, `open-work:${scope}:${resolvedTheme}`, {
      compactPartialHunkOffsets: true,
    });
    if (parsed?.kind !== "files" || parsed.files.length !== 1 || source?.files?.length !== 1)
      return parsed;
    const stat = source.files[0]!;
    const file = { ...parsed.files[0]!, name: stat.path };
    if (stat.previousPath !== null) file.prevName = stat.previousPath;
    else delete file.prevName;
    return { ...parsed, files: [file] };
  }, [source, scope, resolvedTheme]);
  const items = useMemo(
    () =>
      patch?.kind === "files"
        ? patch.files.map((fileDiff) => ({
            id: buildFileDiffIdentityKey(fileDiff),
            type: "diff" as const,
            fileDiff,
            version: buildFileDiffContentVersion(fileDiff),
          }))
        : [],
    [patch],
  );
  const loadDiffFiles = useMemo(
    () =>
      source
        ? createGitDiffFileContentsLoader(getFileContents, {
            environmentId: selection.environmentId,
            cwd: selection.cwd,
            sourceKind: source.kind,
            baseRef: source.baseRef,
            headRef: source.headRef,
            cacheKey: `${scope}:${source.diffHash}`,
          })
        : undefined,
    [source, getFileContents, selection.environmentId, selection.cwd, scope],
  );
  const selectedIndex = siblings.findIndex(
    (candidate) =>
      candidate.file.path === selection.file.path &&
      candidate.comparison.kind === selection.comparison.kind,
  );
  const previous = siblings[selectedIndex - 1];
  const next = siblings[selectedIndex + 1];
  return (
    <DiffPanelShell
      mode="embedded"
      header={
        <>
          <Button ref={closeRef} size="xs" variant="ghost" onClick={onClose}>
            <ArrowLeftIcon className="size-3.5" />
            History
          </Button>
          <span className="min-w-0 truncate text-xs font-medium">{selection.title}</span>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-2">
        <span className="mr-auto min-w-0 truncate text-xs text-muted-foreground">
          {selection.file.path}
        </span>
        <DiffFilePathCopyButton filePath={selection.file.path} />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Unified diff"
          aria-pressed={settings.diffLayout === "stacked"}
          onClick={() => updateSettings({ diffLayout: "stacked" })}
        >
          <Rows3Icon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Split diff"
          aria-pressed={settings.diffLayout === "split"}
          onClick={() => updateSettings({ diffLayout: "split" })}
        >
          <Columns2Icon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Wrap lines"
          aria-pressed={settings.wordWrap}
          onClick={() => updateSettings({ wordWrap: !settings.wordWrap })}
        >
          <TextWrapIcon className="size-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous changed file"
          disabled={!previous}
          onClick={() => {
            if (previous) onSelect(previous);
          }}
        >
          <ChevronLeftIcon className="size-3.5" />
        </Button>
        <select
          aria-label="Changed file"
          value={selectedIndex}
          onChange={(event) => {
            const selected = siblings[Number(event.target.value)];
            if (selected) onSelect(selected);
          }}
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
        >
          {siblings.map((candidate, index) => (
            <option key={`${candidate.comparison.kind}:${candidate.file.path}`} value={index}>
              {candidate.comparison.kind === "commit" ? "" : `${candidate.comparison.kind} · `}
              {candidate.file.path}
            </option>
          ))}
        </select>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next changed file"
          disabled={!next}
          onClick={() => {
            if (next) onSelect(next);
          }}
        >
          <ChevronRightIcon className="size-3.5" />
        </Button>
        <span className="shrink-0 px-1 text-xs text-muted-foreground">
          {selectedIndex + 1}/{siblings.length}
        </span>
      </div>
      {source ? (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          {source.kind === "commit"
            ? `${source.baseRef?.slice(0, 7) ?? "Empty tree"} → ${source.headRef?.slice(0, 7) ?? "Commit"}`
            : source.kind === "staged"
              ? "HEAD → index"
              : source.kind === "unstaged"
                ? "Index → working tree"
                : "New untracked file"}
          {source.truncated ? " · Preview truncated" : ""}
        </p>
      ) : null}
      {!connected ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Reconnect this environment to view the diff.
        </p>
      ) : query.error ? (
        <div role="alert" className="p-4 text-sm">
          <p className="text-destructive">{query.error}</p>
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      ) : query.isPending && !source ? (
        <DiffPanelLoadingState label="Loading file diff…" />
      ) : patch?.kind === "files" ? (
        <StyledDiffCodeView
          key={scope}
          className="min-h-0 flex-1 overflow-auto"
          items={items}
          options={{
            diffStyle: settings.diffLayout === "split" ? "split" : "unified",
            lineDiffType: "none",
            overflow: settings.wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            stickyHeaders: true,
            ...(loadDiffFiles ? { loadDiffFiles } : {}),
          }}
        />
      ) : patch?.kind === "raw" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <p className="mb-2 text-xs text-muted-foreground">{patch.reason}</p>
          <pre className="whitespace-pre-wrap font-mono text-xs">{patch.text}</pre>
        </div>
      ) : (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          No text changes in this file. It may be binary, renamed without changes, or no longer
          changed.
        </p>
      )}
    </DiffPanelShell>
  );
}
