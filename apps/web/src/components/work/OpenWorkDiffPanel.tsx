import type { EnvironmentId, OpenWorkStep, ProjectId } from "@t3tools/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getRenderablePatch,
  resolveDiffThemeName,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { openWorkEnvironment } from "~/state/openWork";
import { useEnvironmentQuery } from "~/state/query";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell } from "../DiffPanelShell";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export interface OpenWorkDiffTarget {
  readonly step: OpenWorkStep;
  readonly file: { readonly path: string; readonly previousPath: string | null };
}

/** One file's diff beside the timeline. */
export function OpenWorkDiffPanel({
  environmentId,
  worktreePath,
  projectId,
  target,
  siblings,
  revision,
  onSelect,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly worktreePath: string;
  readonly projectId: ProjectId | undefined;
  readonly target: OpenWorkDiffTarget;
  /** The files of the same step, for previous and next. */
  readonly siblings: ReadonlyArray<OpenWorkDiffTarget>;
  /** Changes when the timeline rereads, so a WIP diff rereads with it. */
  readonly revision: number;
  readonly onSelect: (target: OpenWorkDiffTarget) => void;
  readonly onClose: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const closeRef = useRef<HTMLButtonElement>(null);
  const query = useEnvironmentQuery(
    openWorkEnvironment.diff({
      environmentId,
      input: {
        path: worktreePath,
        ...(projectId === undefined ? {} : { projectId }),
        step: target.step,
        file: target.file,
        ignoreWhitespace,
      },
    }),
  );
  const refreshDiff = query.refresh;
  const firstRevision = useRef(revision);
  useEffect(() => {
    if (target.step.kind === "wip" && revision !== firstRevision.current) refreshDiff();
  }, [revision, target.step.kind, refreshDiff]);
  useEffect(() => closeRef.current?.focus(), []);

  const result = query.data;
  const scope = JSON.stringify([environmentId, worktreePath, target, ignoreWhitespace]);
  const patch = getRenderablePatch(result?.diff, `open-work:${scope}:${resolvedTheme}`, {
    compactPartialHunkOffsets: true,
  });
  const items =
    patch?.kind === "files"
      ? patch.files.map((fileDiff) => ({
          id: buildFileDiffIdentityKey(fileDiff),
          type: "diff" as const,
          fileDiff,
          version: buildFileDiffContentVersion(fileDiff),
        }))
      : [];
  const index = siblings.findIndex(
    (sibling) => sibling.file.path === target.file.path && sibling.step.kind === target.step.kind,
  );
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 ? siblings[index + 1] : undefined;

  return (
    <DiffPanelShell
      mode="embedded"
      header={
        <>
          <span className="min-w-0 truncate text-xs font-medium">
            {result?.title ?? (target.step.kind === "wip" ? "Uncommitted" : "Commit")}
          </span>
          <Button
            ref={closeRef}
            size="icon-xs"
            variant="ghost"
            aria-label="Close diff"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous file"
          disabled={!previous}
          onClick={() => previous && onSelect(previous)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next file"
          disabled={!next}
          onClick={() => next && onSelect(next)}
        >
          <ChevronRightIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {target.file.previousPath ? `${target.file.previousPath} → ` : ""}
          {target.file.path}
        </span>
        <DiffFilePathCopyButton filePath={target.file.path} />
        <ToggleGroup
          aria-label="Diff layout"
          className="shrink-0"
          variant="segmented"
          value={[settings.diffLayout]}
          onValueChange={(value) => {
            const layout = value[0];
            if (layout === "stacked" || layout === "split") {
              updateClientSettings({ diffLayout: layout });
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Toggle
          aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          variant="ghost"
          size="sm"
          pressed={wordWrap}
          onPressedChange={(pressed) => setWordWrap(Boolean(pressed))}
        >
          <TextWrapIcon className="size-3.5" />
        </Toggle>
        <Toggle
          aria-label={ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          variant="ghost"
          size="sm"
          pressed={ignoreWhitespace}
          onPressedChange={(pressed) => setIgnoreWhitespace(Boolean(pressed))}
        >
          <PilcrowIcon className="size-3.5" />
        </Toggle>
      </div>
      {result?.truncated ? (
        <p className="shrink-0 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          This diff is larger than 1 MB and is cut short.
        </p>
      ) : null}
      {query.error && !result ? (
        <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
          <p className="text-destructive">{query.error}</p>
          <Button size="sm" variant="outline" onClick={refreshDiff}>
            Retry
          </Button>
        </div>
      ) : !result ? (
        <DiffPanelLoadingState label="Loading file diff" />
      ) : patch?.kind === "files" ? (
        <StyledDiffCodeView
          key={scope}
          className="min-h-0 flex-1 overflow-auto"
          items={items}
          options={{
            diffStyle: settings.diffLayout === "split" ? "split" : "unified",
            lineDiffType: "none",
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            stickyHeaders: true,
          }}
        />
      ) : patch?.kind === "raw" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <p className="mb-2 text-xs text-muted-foreground">{patch.reason}</p>
          <pre className="font-mono text-xs whitespace-pre-wrap">{patch.text}</pre>
        </div>
      ) : (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          No text changes in this file. It may be binary, a pure rename, or no longer changed.
        </p>
      )}
    </DiffPanelShell>
  );
}
