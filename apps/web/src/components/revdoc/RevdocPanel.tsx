import type {
  RevdocDetail,
  RevdocTestStartInput,
  RevdocItem,
  RevdocSaveInput,
  RevdocSection,
  RevdocTest,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  REVDOC_OUTCOMES,
  revdocEvidencePath,
  revdocSummary,
  revdocTests,
} from "@t3tools/client-runtime/revdoc";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BookOpenCheckIcon,
  PlayIcon,
  SquareIcon,
  ChevronDownIcon,
  CameraIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FileTextIcon,
  MessageSquareIcon,
  RefreshCwIcon,
} from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useComposerDraftStore } from "~/composerDraftStore";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { revdocEnvironment } from "~/state/revdoc";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRightPanelStore } from "~/rightPanelStore";
import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { RevdocControl } from "./RevdocControl";
import { RevdocRunActivity } from "./RevdocRunActivity";
import { RevdocWorktreePicker } from "./RevdocWorktreePicker";

const TestingContext = createContext<{
  busy: boolean;
  stale: ReadonlySet<string>;
  retry: (id: string) => void;
}>({ busy: true, stale: new Set(), retry: () => {} });

function AiTestResult({ test, threadRef }: { test: RevdocTest; threadRef: ScopedThreadRef }) {
  const testing = useContext(TestingContext);
  const attempt = test.attempts?.at(-1);
  const stale = testing.stale.has(test.id);
  const label = stale
    ? "Needs retest"
    : attempt
      ? {
          queued: "AI queued",
          running: "AI testing",
          passed: "AI passed",
          failed: "AI failed",
          blocked: "AI blocked",
        }[attempt.state]
      : "AI not tested";
  const tone = stale
    ? "warning"
    : attempt?.state === "passed"
      ? "success"
      : attempt?.state === "failed"
        ? "error"
        : attempt?.state === "blocked"
          ? "warning"
          : "secondary";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tone}>{label}</Badge>
        <Button
          size="xs"
          variant="ghost"
          disabled={testing.busy}
          onClick={() => testing.retry(test.id)}
        >
          {attempt ? "Retest" : "Test with AI"}
        </Button>
      </div>
      {attempt && (
        <details className="text-xs">
          <summary className="cursor-pointer py-1 text-muted-foreground">
            Result &amp; evidence
            {attempt.evidence.length
              ? ` · ${attempt.evidence.length} screenshot${attempt.evidence.length === 1 ? "" : "s"}`
              : ""}
          </summary>
          <div className="space-y-3 py-2">
            {stale && (
              <p className="text-warning">
                The code or this check has changed. This result describes an earlier state.
              </p>
            )}
            {attempt.steps && (
              <div>
                <p className="mb-1 font-medium">Steps taken</p>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                  {attempt.steps}
                </p>
              </div>
            )}
            {attempt.observed && (
              <div>
                <p className="mb-1 font-medium">Observed</p>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                  {attempt.observed}
                </p>
              </div>
            )}
            <p className="text-muted-foreground">
              {attempt.by} · {new Date(attempt.finishedAt ?? attempt.startedAt).toLocaleString()}
            </p>
            {attempt.evidence.map((attachment) => (
              <Evidence key={attachment.id} attachment={attachment} threadRef={threadRef} />
            ))}
            {(test.attempts?.length ?? 0) > 1 && (
              <details>
                <summary className="cursor-pointer py-1 text-muted-foreground">
                  Previous attempts · {test.attempts!.length - 1}
                </summary>
                {test
                  .attempts!.slice(0, -1)
                  .toReversed()
                  .map((previous) => (
                    <div key={previous.runId} className="space-y-2 border-t border-border/50 py-3">
                      <p>
                        {previous.state} ·{" "}
                        {new Date(previous.finishedAt ?? previous.startedAt).toLocaleString()} ·{" "}
                        {previous.by}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-muted-foreground">
                        {previous.steps}
                      </p>
                      <p className="whitespace-pre-wrap">{previous.observed}</p>
                      {previous.evidence.map((attachment) => (
                        <Evidence
                          key={attachment.id}
                          attachment={attachment}
                          threadRef={threadRef}
                        />
                      ))}
                    </div>
                  ))}
              </details>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

type Save = (change: RevdocSaveInput["change"]) => Promise<boolean>;

function NoteEditor({
  value = "",
  label,
  disabled,
  onSave,
}: {
  value?: string | undefined;
  label: string;
  disabled: boolean;
  onSave: (note: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const text = draft?.text ?? value;
  const dirty = text !== value;
  return (
    <div className="space-y-2">
      <Button size="xs" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
        <MessageSquareIcon />
        {value || dirty ? label : `Add ${label.toLowerCase()}`}
        {dirty && <span aria-label="Unsaved note">•</span>}
      </Button>
      {open && (
        <div className="space-y-2">
          <Textarea
            size="sm"
            aria-label={label}
            value={text}
            disabled={disabled}
            onChange={(event) => setDraft({ base: draft?.base ?? value, text: event.target.value })}
          />
          {draft && draft.base !== value && dirty && (
            <p className="text-xs text-warning">
              The saved note changed. Your draft is still here.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setDraft(null);
                setOpen(false);
              }}
            >
              Discard
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!dirty || disabled}
              onClick={async () => {
                if (await onSave(text)) {
                  setDraft(null);
                  setOpen(false);
                }
              }}
            >
              Save note
            </Button>
          </div>
        </div>
      )}
      {!open && value && (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{value}</p>
      )}
    </div>
  );
}

function Evidence({
  attachment,
  threadRef,
}: {
  attachment: NonNullable<RevdocTest["evidence"]>[number];
  threadRef: ScopedThreadRef;
}) {
  const relativePath = revdocEvidencePath(attachment.path);
  const resource = useMemo(
    () =>
      relativePath
        ? {
            _tag: "workspace-file" as const,
            threadId: threadRef.threadId,
            path: relativePath,
          }
        : null,
    [relativePath, threadRef.threadId],
  );
  const asset = useAssetUrlState(threadRef.environmentId, resource);
  const refresh = useAssetUrlRefresh(threadRef.environmentId, resource);
  const [failed, setFailed] = useState(false);
  return (
    <figure className="min-w-0 space-y-2">
      {relativePath && asset._tag === "Success" && !failed ? (
        <button
          type="button"
          className="block w-full overflow-hidden rounded-lg border border-border/60 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`Open screenshot: ${attachment.caption || attachment.path}`}
          onClick={() => useRightPanelStore.getState().openFile(threadRef, relativePath)}
        >
          <img
            loading="lazy"
            className="max-h-48 w-full object-contain"
            src={asset.url}
            alt={attachment.caption || attachment.path}
            onError={() => setFailed(true)}
          />
        </button>
      ) : (
        <div className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">
          {asset._tag === "Failure" || failed || !relativePath ? (
            <>
              <p>Screenshot unavailable.</p>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setFailed(false);
                  void refresh();
                }}
              >
                Retry
              </Button>
            </>
          ) : (
            "Loading screenshot…"
          )}
        </div>
      )}
      <figcaption className="space-y-1 text-xs text-muted-foreground">
        <p>{attachment.caption || attachment.path}</p>
        {attachment.sourceRevision && (
          <p className="break-all">Source: {attachment.sourceRevision}</p>
        )}
        {attachment.capturedAt && (
          <time dateTime={attachment.capturedAt}>
            {new Date(attachment.capturedAt).toLocaleString()}
          </time>
        )}
      </figcaption>
    </figure>
  );
}

function TestRow({
  test,
  save,
  disabled,
  threadRef,
}: {
  test: RevdocTest;
  save: Save;
  disabled: boolean;
  threadRef: ScopedThreadRef;
}) {
  const outcome = REVDOC_OUTCOMES.find((entry) => entry.value === (test.outcome ?? "untested"))!;
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  return (
    <article className="space-y-2 border-t border-border/50 px-3 py-3 [content-visibility:auto] [contain-intrinsic-block-size:120px]">
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-40 flex-1 text-base leading-relaxed">{test.title}</p>
        <Select
          value={outcome.value}
          disabled={disabled}
          onValueChange={(value) => {
            const selected = REVDOC_OUTCOMES.find((entry) => entry.value === value);
            if (selected)
              void save({
                kind: "test",
                id: test.id,
                outcome: selected.value,
                feedback: test.feedback ?? "",
              });
          }}
        >
          <SelectTrigger size="sm" aria-label={`Your review for ${test.title}`}>
            <Badge variant={outcome.tone}>{outcome.label}</Badge>
          </SelectTrigger>
          <SelectPopup align="end">
            {REVDOC_OUTCOMES.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {test.expected && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {test.expected}
        </p>
      )}
      <AiTestResult test={test} threadRef={threadRef} />
      <NoteEditor
        label="Test note"
        value={test.feedback}
        disabled={disabled}
        onSave={(feedback) =>
          save({ kind: "test", id: test.id, outcome: test.outcome ?? "untested", feedback })
        }
      />
      {!test.attempts?.length && (test.verification || test.evidence?.length) ? (
        <Collapsible open={evidenceOpen} onOpenChange={setEvidenceOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 rounded-sm py-1 text-xs text-muted-foreground hover:text-foreground">
            <CameraIcon className="size-3.5" />
            Evidence{test.evidence?.length ? ` · ${test.evidence.length}` : ""}
            <ChevronRightIcon className={cn("size-3", evidenceOpen && "rotate-90")} />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="space-y-3 py-2">
              {test.verification && (
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    Recorded check: {test.verification.result}
                    {test.verification.by ? ` · ${test.verification.by}` : ""}
                  </p>
                  {test.verification.sourceRevision && (
                    <p className="break-all">Source: {test.verification.sourceRevision}</p>
                  )}
                  <p>Recorded evidence is separate from your review outcome.</p>
                </div>
              )}
              {test.evidence?.map((attachment) => (
                <Evidence key={attachment.id} attachment={attachment} threadRef={threadRef} />
              ))}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </article>
  );
}

function ItemContext({ item, threadRef }: { item: RevdocItem; threadRef: ScopedThreadRef }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
        Context · implementation and references
      </summary>
      <div className="space-y-2 py-2 text-muted-foreground">
        {item.summary && <p className="whitespace-pre-wrap">{item.summary}</p>}
        {item.status && (
          <p>
            Implementation:{" "}
            {
              { done: "Built", doing: "In progress", todo: "Not built", blocked: "Blocked" }[
                item.status
              ]
            }
          </p>
        )}
        {item.prd?.map((reference) => (
          <Button
            key={reference}
            size="xs"
            variant="ghost"
            onClick={() => useRightPanelStore.getState().openFile(threadRef, reference)}
          >
            <FileTextIcon />
            <span className="max-w-64 truncate">{reference}</span>
          </Button>
        ))}
        {item.quirks?.map((quirk) => (
          <p key={quirk}>{quirk}</p>
        ))}
        {item.flags?.map((flag) => (
          <p key={`${flag.k}:${flag.t}`}>
            {flag.k}: {flag.t}
          </p>
        ))}
        {item.endpoints?.map((endpoint) => (
          <details key={endpoint.endpoint}>
            <summary className="cursor-pointer break-all font-mono text-xs">
              {endpoint.endpoint}
            </summary>
            <div className="space-y-1 py-2">
              {Object.entries(endpoint)
                .filter(([key, value]) => key !== "endpoint" && value)
                .map(([key, value]) => (
                  <p key={key} className="whitespace-pre-wrap break-words">
                    <span className="font-medium">{key}: </span>
                    {value}
                  </p>
                ))}
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}

function ReviewItem({
  item,
  tests,
  save,
  disabled,
  threadRef,
}: {
  item: RevdocItem;
  tests: readonly RevdocTest[];
  save: Save;
  disabled: boolean;
  threadRef: ScopedThreadRef;
}) {
  const summary = revdocSummary(item.tests, [item.note]);
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
        <div className="flex flex-wrap items-center gap-2 bg-muted/25 px-3 py-2.5">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium">
            <ChevronRightIcon className={cn("size-3.5 shrink-0", open && "rotate-90")} />
            {item.name}
          </CollapsibleTrigger>
          <Badge
            variant={
              summary.good
                ? "success"
                : summary.findings || summary.hasNotes
                  ? "warning"
                  : "secondary"
            }
          >
            {summary.reviewed}/{summary.total} reviewed
          </Badge>
        </div>
        <CollapsiblePanel keepMounted>
          <div className="space-y-2 px-3 py-2">
            <ItemContext item={item} threadRef={threadRef} />
            <NoteEditor
              label="Item note"
              value={item.note}
              disabled={disabled}
              onSave={(note) => save({ kind: "item", id: item.id, note })}
            />
          </div>
          {tests.map((test) => (
            <TestRow
              key={test.id}
              test={test}
              save={save}
              disabled={disabled}
              threadRef={threadRef}
            />
          ))}
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

function ReviewSection({
  section,
  open,
  onOpenChange,
  filter,
  save,
  disabled,
  threadRef,
}: {
  section: RevdocSection;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  filter: (test: RevdocTest, item: RevdocItem, section: RevdocSection) => boolean;
  save: Save;
  disabled: boolean;
  threadRef: ScopedThreadRef;
}) {
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) setHasOpened(true);
  const summary = revdocSummary(
    section.items.flatMap((item) => item.tests),
    [section.note, ...section.items.map((item) => item.note)],
  );
  const visible = section.items.map((item) => ({
    item,
    tests: item.tests.filter((test) => filter(test, item, section)),
  }));
  if (
    !visible.some(({ tests }) => tests.length) &&
    !section.note &&
    !section.items.some((item) => item.note)
  )
    return null;
  const fullyReviewed = (item: RevdocItem) =>
    item.tests.length > 0 &&
    item.tests.every((test) => test.outcome && test.outcome !== "untested");
  const ordered = visible.toSorted(
    (a, b) => Number(fullyReviewed(b.item)) - Number(fullyReviewed(a.item)),
  );
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-background pr-4">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-sm font-medium text-muted-foreground hover:text-foreground">
          <span>{section.area}</span>
          <ChevronRightIcon className={cn("size-3.5 shrink-0", open && "rotate-90")} />
        </CollapsibleTrigger>
        <Badge
          variant={
            summary.good
              ? "success"
              : summary.findings || summary.hasNotes
                ? "warning"
                : "secondary"
          }
        >
          {summary.reviewed}/{summary.total}
        </Badge>
      </div>
      <CollapsiblePanel keepMounted>
        {hasOpened && (
          <div className="space-y-3 px-4 pb-4">
            <NoteEditor
              label="Section note"
              value={section.note}
              disabled={disabled}
              onSave={(note) => save({ kind: "section", id: section.id, note })}
            />
            {ordered
              .filter(({ item, tests }) => tests.length || item.note)
              .map(({ item, tests }) => (
                <ReviewItem
                  key={item.id}
                  item={item}
                  tests={tests}
                  save={save}
                  disabled={disabled}
                  threadRef={threadRef}
                />
              ))}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

export default function RevdocPanel({
  threadRef,
  worktreePath,
}: {
  threadRef: ScopedThreadRef;
  worktreePath: string;
}) {
  const target = useMemo(
    () => ({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, worktreePath },
    }),
    [threadRef.environmentId, threadRef.threadId, worktreePath],
  );
  const query = useEnvironmentQuery(revdocEnvironment.get(target));
  const run = useEnvironmentQuery(revdocEnvironment.changes(target));
  const testCommand = useAtomCommand(revdocEnvironment.startTesting, { reportFailure: false });
  const cancelCommand = useAtomCommand(revdocEnvironment.cancel, { reportFailure: false });
  const [testingPending, setTestingPending] = useState(false);
  const testingRef = useRef(false);
  const saveCommand = useAtomCommand(revdocEnvironment.save, { reportFailure: false });
  const [saved, setSaved] = useState<{ detail: RevdocDetail; at: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [hideResolved, setHideResolved] = useState(false);
  const [tab, setTab] = useState("review");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filteredClosed, setFilteredClosed] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: "",
    ids: new Set(),
  });
  const detail = saved && (query.dataUpdatedAt ?? 0) < saved.at ? saved.detail : query.data;
  const review = detail?.review;
  const save: Save = async (change) => {
    if (!detail?.revision || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await saveCommand({
        ...target,
        input: { ...target.input, expectedRevision: detail.revision, change },
      });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        throw failure instanceof Error ? failure : new Error(String(failure));
      }
      setSaved({ detail: { ...detail, ...result.value }, at: Date.now() });
      query.refresh();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const allTests = review ? revdocTests(review) : [];
  const summary = revdocSummary(
    allTests,
    review
      ? [
          review.notes,
          ...review.sections.flatMap((section) => [
            section.note,
            ...section.items.map((item) => item.note),
          ]),
        ]
      : [],
  );
  const stale = useMemo(() => new Set(detail?.staleTestIds ?? []), [detail?.staleTestIds]);
  const aiPassed = allTests.filter(
    (test) => !stale.has(test.id) && test.attempts?.at(-1)?.state === "passed",
  ).length;
  const failures = allTests.filter(
    (test) => !stale.has(test.id) && test.attempts?.at(-1)?.state === "failed",
  );
  const busy = Boolean(run.data?.running || testingPending);
  const activeTest = allTests.find((test) => test.id === run.data?.activeTestId);
  const startTests = useCallback(
    async (selection: RevdocTestStartInput["selection"], testIds?: string[]) => {
      if (busy || testingRef.current) return;
      testingRef.current = true;
      setTestingPending(true);
      setError(null);
      const result = await testCommand({
        ...target,
        input: { ...target.input, selection, ...(testIds ? { testIds } : {}) },
      });
      setTestingPending(false);
      testingRef.current = false;
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [busy, target, testCommand],
  );
  const testingContext = useMemo(
    () => ({ busy, stale, retry: (id: string) => void startTests("all", [id]) }),
    [busy, stale, startTests],
  );
  const cancelTests = async () => {
    const result = await cancelCommand(target);
    if (result._tag !== "Success") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const draftFixes = () => {
    const prompt = [
      "Fix the failures from this worktree's latest Revdoc AI testing pass. Read .revdoc/review.json for the recorded steps and screenshot evidence, reproduce each failure, then fix it. Preserve human review decisions. Rerun the affected checks after the changes.",
      ...failures.map(
        (test) =>
          `Check ${test.id}: ${test.title}\nExpected: ${test.expected ?? "See review"}\nObserved: ${test.attempts?.at(-1)?.observed ?? "See Revdoc agent activity"}`,
      ),
    ].join("\n\n");
    const store = useComposerDraftStore.getState();
    const existing = store.getComposerDraft(threadRef)?.prompt ?? "";
    store.setPrompt(threadRef, existing ? `${existing}\n\n${prompt}` : prompt);
    toastManager.add({
      type: "info",
      title: "Fix request added to your draft",
      description: "Review it in this thread’s composer, then send when ready.",
    });
  };
  const normalizedSearch = search.trim().toLowerCase();
  const filter = (test: RevdocTest, item: RevdocItem, section: RevdocSection) =>
    (outcome === "all" || (test.outcome ?? "untested") === outcome) &&
    (!hideResolved || test.outcome !== "complete" || Boolean(test.feedback?.trim())) &&
    (!normalizedSearch ||
      [section.area, item.name, test.title, test.expected, test.feedback].some((text) =>
        text?.toLowerCase().includes(normalizedSearch),
      ));
  const filtered = Boolean(normalizedSearch || outcome !== "all" || hideResolved);
  const filterKey = JSON.stringify([normalizedSearch, outcome, hideResolved]);
  const isExpanded = (id: string) =>
    filtered ? !(filteredClosed.key === filterKey && filteredClosed.ids.has(id)) : expanded.has(id);
  const anyExpanded = review?.sections.some((section) => isExpanded(section.id)) ?? false;
  const changeExpanded = (id: string, value: boolean) => {
    if (filtered) {
      const ids = new Set(filteredClosed.key === filterKey ? filteredClosed.ids : []);
      if (value) ids.delete(id);
      else ids.add(id);
      setFilteredClosed({ key: filterKey, ids });
    } else {
      const ids = new Set(expanded);
      if (value) ids.add(id);
      else ids.delete(id);
      setExpanded(ids);
    }
  };
  const shownError = error ?? query.error ?? run.error ?? run.data?.error;
  return (
    <TestingContext value={testingContext}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="shrink-0 border-b border-border/60">
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-start gap-2">
              <BookOpenCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <h2 className="min-w-0 flex-1 text-base font-semibold">
                {review?.title || "Worktree review"}
              </h2>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh Revdoc"
                disabled={saving}
                onClick={() => {
                  setSaved(null);
                  setError(null);
                  query.refresh();
                }}
              >
                <RefreshCwIcon />
              </Button>
            </div>
            {review?.summary && (
              <p className="text-sm leading-relaxed text-muted-foreground">{review.summary}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
              <RevdocWorktreePicker threadRef={threadRef} current={detail?.cwd ?? worktreePath} />
              {review && (
                <Badge
                  variant={
                    summary.good
                      ? "success"
                      : summary.findings || summary.hasNotes
                        ? "warning"
                        : "secondary"
                  }
                >
                  {summary.reviewed}/{summary.total} reviewed
                </Badge>
              )}
              <span role="status">
                {saving
                  ? "Saving…"
                  : run.data?.running
                    ? run.data.phase === "testing"
                      ? `Testing ${run.data.completed ?? 0}/${run.data.total ?? allTests.length} checks…`
                      : run.data.generationStage === "combining"
                        ? `Combining review sections · ${run.data.completed ?? 0}/${run.data.total ?? 0} complete…`
                        : run.data.total && run.data.total > 1
                          ? `Generating review · ${run.data.completed ?? 0}/${run.data.total} batches complete…`
                          : "Generating review…"
                    : review
                      ? "Saved in this worktree"
                      : ""}
              </span>
            </div>
          </div>
          <nav
            className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-2"
            aria-label="Revdoc tabs"
          >
            <ToggleGroup
              value={[tab]}
              onValueChange={(values) => {
                if (values[0]) setTab(values[0]);
              }}
            >
              <Toggle value="review">Review</Toggle>
              <Toggle value="context">Context</Toggle>
            </ToggleGroup>
            <div className="ml-auto">
              <RevdocControl
                threadRef={threadRef}
                worktreePath={worktreePath}
                presentation="toolbar"
                notifyCompletion={false}
              />
            </div>
          </nav>
        </header>
        {review && (
          <div className="max-h-[50%] shrink-0 space-y-2 overflow-y-auto border-b border-border/60 px-4 py-3">
            <div
              className="flex items-center justify-between gap-2"
              role="status"
              aria-live="polite"
            >
              <p className="text-sm font-medium">
                {busy
                  ? run.data?.phase === "generating"
                    ? "Generating review…"
                    : "AI testing is running"
                  : review.testing
                    ? "AI testing results"
                    : "AI testing"}
              </p>
              {busy && run.data?.phase === "testing" && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {run.data.completed ?? 0}/{run.data.total ?? allTests.length}
                </span>
              )}
            </div>
            {run.data?.running && run.data.phase === "testing" && (
              <progress
                className="h-1 w-full accent-primary"
                aria-label="AI testing progress"
                value={run.data.completed ?? 0}
                max={Math.max(1, run.data.total ?? allTests.length)}
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={aiPassed === allTests.length && aiPassed > 0 ? "success" : "secondary"}
              >
                {aiPassed}/{allTests.length} AI passed
              </Badge>
              {stale.size > 0 && <Badge variant="warning">{stale.size} need retest</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {run.data?.running ? (
                <Button size="xs" variant="outline" onClick={() => void cancelTests()}>
                  <SquareIcon />
                  Stop pass
                </Button>
              ) : (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || !allTests.length}
                    onClick={() => void startTests("remaining")}
                  >
                    <PlayIcon />
                    Test with AI
                  </Button>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={busy}
                          aria-label="AI testing options"
                        />
                      }
                    >
                      <ChevronDownIcon />
                    </MenuTrigger>
                    <MenuPopup align="start">
                      <MenuItem
                        disabled={!failures.length}
                        onClick={() => void startTests("failed")}
                      >
                        Retry failed checks
                      </MenuItem>
                      <MenuItem disabled={!allTests.length} onClick={() => void startTests("all")}>
                        Retest all checks
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </>
              )}
              {failures.length > 0 && (
                <Button size="xs" variant="ghost" disabled={busy} onClick={draftFixes}>
                  Draft fix request
                </Button>
              )}
            </div>
            {run.data?.running && activeTest && (
              <p role="status" className="break-words text-xs text-muted-foreground">
                Testing: {activeTest.title}
              </p>
            )}
            {review.testing && (
              <RevdocRunActivity
                key={review.testing.id}
                run={review.testing}
                threadRef={threadRef}
              />
            )}
            <p className="text-xs text-muted-foreground">
              AI results are separate from your review. Test with AI runs remaining checks; use
              Retest on an individual check to repeat it.
            </p>
            {review.testing?.status === "interrupted" && (
              <p role="status" className="text-xs text-warning">
                {review.testing.error}
              </p>
            )}
          </div>
        )}
        {shownError && (
          <div
            role="alert"
            className="shrink-0 border-b border-border/60 px-4 py-3 text-sm text-destructive"
          >
            {shownError}
          </div>
        )}
        {!review ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
            <p>
              {query.isPending
                ? "Loading review…"
                : run.data?.running
                  ? "Your review is being prepared. You can keep working in the thread."
                  : "Run a Revdoc pass to turn this worktree’s changes into a review checklist."}
            </p>
          </div>
        ) : tab === "context" ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            {review.context && (
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{review.context}</p>
            )}
            <dl className="space-y-2 text-xs text-muted-foreground">
              {review.generatedAt && (
                <div>
                  <dt>Last pass</dt>
                  <dd>{new Date(review.generatedAt).toLocaleString()}</dd>
                </div>
              )}
              <div>
                <dt>Review file</dt>
                <dd className="break-all">{detail?.cwd}/.revdoc/review.json</dd>
              </div>
              {review.sourceRevision && (
                <div>
                  <dt>Source state</dt>
                  <dd className="break-all font-mono">{review.sourceRevision}</dd>
                </div>
              )}
            </dl>
            <NoteEditor
              label="Review note"
              value={review.notes}
              disabled={saving}
              onSave={(note) => save({ kind: "document", note })}
            />
          </div>
        ) : (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
              <div className="min-w-32 flex-1">
                <Input
                  size="sm"
                  aria-label="Search review"
                  placeholder="Search review…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <Select value={outcome} onValueChange={(value) => setOutcome(value ?? "all")}>
                <SelectTrigger size="sm" aria-label="Filter review outcomes">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="all">All outcomes</SelectItem>
                  {REVDOC_OUTCOMES.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="xs"
                variant={hideResolved ? "secondary" : "ghost"}
                aria-pressed={hideResolved}
                onClick={() => setHideResolved(!hideResolved)}
              >
                Hide resolved
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={anyExpanded ? "Collapse all sections" : "Expand all sections"}
                onClick={() =>
                  filtered
                    ? setFilteredClosed({
                        key: filterKey,
                        ids: anyExpanded ? new Set(review.sections.map((s) => s.id)) : new Set(),
                      })
                    : setExpanded(
                        anyExpanded ? new Set() : new Set(review.sections.map((s) => s.id)),
                      )
                }
              >
                {anyExpanded ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto pb-4">
              {review.notes && (
                <p className="whitespace-pre-wrap px-4 pt-3 text-sm text-muted-foreground">
                  {review.notes}
                </p>
              )}
              {review.sections.map((section) => (
                <ReviewSection
                  key={section.id}
                  section={section}
                  open={isExpanded(section.id)}
                  onOpenChange={(value) => changeExpanded(section.id, value)}
                  filter={filter}
                  save={save}
                  disabled={saving}
                  threadRef={threadRef}
                />
              ))}
              {!review.sections.some((section) =>
                section.items.some((item) =>
                  item.tests.some((test) => filter(test, item, section)),
                ),
              ) && (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  No tests match these filters.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </TestingContext>
  );
}
