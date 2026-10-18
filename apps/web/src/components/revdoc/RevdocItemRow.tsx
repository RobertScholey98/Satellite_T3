import { REVDOC_OUTCOME_LABELS } from "@t3tools/client-runtime/revdoc";
import type {
  AssetResource,
  EnvironmentId,
  RevdocItemChange,
  RevdocItemDetail,
  RevdocItemSummary,
  RevdocOutcome,
  RevdocTarget,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ChevronDown, ChevronRight, FlaskConical } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useRightPanelStore } from "~/rightPanelStore";
import { revdocEnvironment } from "~/state/revdoc";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { revdocFailure, toastRevdocFailure } from "./useRevdocActions";

const RETEST_LABELS = {
  check: "check text changed",
  code: "code changed",
  both: "check text and code changed",
};
const RESULT_BADGES = {
  passed: { label: "AI passed", variant: "success" },
  failed: { label: "AI failed", variant: "error" },
  blocked: { label: "AI blocked", variant: "warning" },
} as const;

export interface RevdocItemRowProps {
  readonly item: RevdocItemSummary;
  readonly threadRef: ScopedThreadRef;
  readonly target: RevdocTarget;
  /** The worktree the Review belongs to, for evidence screenshots. */
  readonly worktreePath: string | null;
  readonly editingDisabled: boolean;
  readonly testingDisabled: boolean;
  readonly onTest: (itemId: string) => void;
}

function EvidenceThumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly caption: string;
}) {
  const url = useAssetUrlState(props.environmentId, props.resource);
  if (url._tag !== "Success")
    return <span className="text-xs text-muted-foreground">{props.caption}</span>;
  return (
    <a href={url.url} target="_blank" rel="noreferrer" className="block w-32">
      <img
        src={url.url}
        alt={props.caption}
        className="w-32 rounded-md border object-cover"
        loading="lazy"
      />
    </a>
  );
}

/** One check: verdict controls up front, details fetched only when expanded. */
export const RevdocItemRow = memo(function RevdocItemRow(props: RevdocItemRowProps) {
  const { item, threadRef } = props;
  const environmentId = threadRef.environmentId;
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<RevdocItemDetail | null>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const getItems = useAtomCommand(revdocEnvironment.getItems, { reportFailure: false });
  const editItem = useAtomCommand(revdocEnvironment.editItem, { reportFailure: false });

  const detailStale = detail === null || detail.revision !== item.revision;
  // Summaries carry a preview; a long note is edited from the detail.
  const fullNote = !detailStale ? detail.note : item.noteTruncated ? null : item.note;
  useEffect(() => {
    if (!expanded || !detailStale) return;
    let cancelled = false;
    void getItems({ environmentId, input: { ...props.target, ids: [item.id] } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Failure") toastRevdocFailure("Could not load the check", result);
      else setDetail(result.value.items[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [detailStale, environmentId, expanded, getItems, item.id, props.target]);

  const save = async (change: RevdocItemChange, expectedRevision = item.revision) => {
    const result = await editItem({
      environmentId,
      input: { ...props.target, itemId: item.id, expectedRevision, change },
    });
    if (result._tag === "Success") return true;
    const failure = revdocFailure(result);
    if (failure?.code === "conflict" && failure.currentItem) {
      if (change._tag === "set_note") {
        setConflictNote(failure.currentItem.note);
      } else {
        toastRevdocFailure("Another device changed this check first", result);
      }
      return false;
    }
    toastRevdocFailure("Could not save the check", result);
    return false;
  };

  const saveNote = async (expectedRevision?: number) => {
    if (draftNote === fullNote && expectedRevision === undefined) {
      setEditingNote(false);
      return;
    }
    if (await save({ _tag: "set_note", note: draftNote }, expectedRevision)) {
      setConflictNote(null);
      setEditingNote(false);
    }
  };

  const resultBadge = item.result ? RESULT_BADGES[item.result.state] : null;
  return (
    <div
      className="flex flex-col gap-1 border-b border-border/50 px-3 py-2"
      data-dismissed={item.dismissed || undefined}
    >
      <div className="flex items-start gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={expanded ? "Collapse check" : "Expand check"}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm text-foreground">{item.check}</span>
          <div className="flex flex-wrap items-center gap-1">
            {item.retest ? (
              <Badge variant="warning" size="sm">
                Needs retest: {RETEST_LABELS[item.retest]}. Was{" "}
                {REVDOC_OUTCOME_LABELS[item.outcome]}
              </Badge>
            ) : null}
            {item.stale ? (
              <Badge variant="outline" size="sm">
                Stale
              </Badge>
            ) : null}
            {resultBadge ? (
              <Badge variant={resultBadge.variant} size="sm">
                {resultBadge.label}
                {item.result && item.result.evidenceCount > 0
                  ? ` · ${item.result.evidenceCount} shots`
                  : ""}
              </Badge>
            ) : null}
            {item.note && !expanded ? (
              <span className="truncate text-xs text-muted-foreground">Note: {item.note}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {item.stale && !item.dismissed ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={props.editingDisabled}
              onClick={() => void save({ _tag: "dismiss" })}
            >
              Dismiss
            </Button>
          ) : null}
          {item.dismissed ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={props.editingDisabled}
              onClick={() => void save({ _tag: "restore" })}
            >
              Restore
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Test this check with AI"
                disabled={props.testingDisabled}
                onClick={() => props.onTest(item.id)}
              >
                <FlaskConical />
              </Button>
              <Select
                value={item.outcome}
                items={REVDOC_OUTCOME_LABELS}
                disabled={props.editingDisabled}
                onValueChange={(outcome) => {
                  if (outcome !== null && outcome !== item.outcome) {
                    void save({ _tag: "set_outcome", outcome: outcome as RevdocOutcome });
                  }
                }}
              >
                <SelectTrigger size="xs" aria-label="Outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(REVDOC_OUTCOME_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </>
          )}
        </div>
      </div>
      {expanded ? (
        <div className="flex flex-col gap-2 ps-8 text-xs">
          {detail ? (
            <>
              <div>
                <span className="font-medium text-foreground">Expected: </span>
                <span className="text-muted-foreground">{detail.expected || "Not stated."}</span>
              </div>
              {detail.coveredPaths.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {detail.coveredPaths.map((path) => (
                    <Button
                      key={path}
                      variant="link"
                      size="xs"
                      onClick={() => useRightPanelStore.getState().openFile(threadRef, path)}
                    >
                      {path}
                    </Button>
                  ))}
                </div>
              ) : null}
              {detail.result ? (
                <div className="flex flex-col gap-1">
                  <span className="font-medium text-foreground">
                    AI result: {detail.result.state} by {detail.result.method} (
                    {detail.result.model})
                  </span>
                  {detail.result.steps ? (
                    <span className="whitespace-pre-wrap text-muted-foreground">
                      Steps: {detail.result.steps}
                    </span>
                  ) : null}
                  <span className="whitespace-pre-wrap text-muted-foreground">
                    Observed: {detail.result.observed}
                  </span>
                  {detail.result.evidence.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {detail.result.evidence.map((evidence) => (
                        <EvidenceThumbnail
                          key={evidence.id}
                          environmentId={environmentId}
                          caption={evidence.caption}
                          resource={
                            props.target.worktreePath && props.worktreePath
                              ? {
                                  _tag: "draft-workspace-file",
                                  cwd: props.worktreePath,
                                  path: evidence.path,
                                }
                              : {
                                  _tag: "workspace-file",
                                  threadId: threadRef.threadId,
                                  path: evidence.path,
                                }
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">Loading details…</span>
          )}
          {editingNote ? (
            <div className="flex flex-col gap-1">
              <Textarea
                size="sm"
                value={draftNote}
                autoFocus
                aria-label="Note"
                disabled={props.editingDisabled}
                onChange={(event) => setDraftNote(event.target.value)}
              />
              {conflictNote !== null ? (
                <span className="text-warning-foreground">
                  Another device saved this note first: “{conflictNote || "(empty)"}”. Your draft is
                  kept.
                </span>
              ) : null}
              <div className="flex gap-1">
                <Button
                  size="xs"
                  disabled={props.editingDisabled}
                  onClick={() => void saveNote(conflictNote !== null ? item.revision : undefined)}
                >
                  {conflictNote !== null ? "Save mine" : "Save note"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setDraftNote(fullNote ?? "");
                    setConflictNote(null);
                    setEditingNote(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <span className="whitespace-pre-wrap text-muted-foreground">
                {fullNote === null ? "Loading note…" : fullNote ? `Note: ${fullNote}` : "No note."}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={props.editingDisabled || item.dismissed || fullNote === null}
                onClick={() => {
                  setDraftNote(fullNote ?? "");
                  setEditingNote(true);
                }}
              >
                {item.note ? "Edit note" : "Add note"}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});
