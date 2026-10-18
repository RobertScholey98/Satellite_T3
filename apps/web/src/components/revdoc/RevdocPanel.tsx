import { LegendList } from "@legendapp/list/react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  appendToDraft,
  draftFixRequest,
  needsAttention,
  needsFix,
  REVDOC_OUTCOME_LABELS,
  summarizeRevdoc,
} from "@t3tools/client-runtime/revdoc";
import type {
  RevdocItemDetail,
  RevdocItemSummary,
  RevdocOutcome,
  RevdocPass,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { useState } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useThreadShell } from "~/state/entities";
import { revdocEnvironment, useRevdocReview } from "~/state/revdoc";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { RevdocGenerationProgress, revdocProgressKey } from "./RevdocGenerationProgress";
import { RevdocItemRow } from "./RevdocItemRow";
import { RevdocWorktreePicker } from "./RevdocWorktreePicker";
import { toastRevdocFailure, useRevdocActions } from "./useRevdocActions";

const LARGE_AREA = 60;
const COLLAPSE_AREAS_ABOVE = 200;
const NO_THREAD_TO_TEST = "Start a thread in this worktree to test it.";
type OutcomeFilter = "all" | RevdocOutcome;

const passLine = (pass: RevdocPass | undefined) => {
  if (!pass) return null;
  if (pass.status === "conflicted" || pass.status === "failed")
    return pass.error ?? "The pass failed.";
  if (pass.status === "cancelled")
    return `${pass.kind === "generate" ? "Generation" : "Testing"} was cancelled.`;
  if (pass.status === "interrupted") return "The pass was interrupted. Run it again to continue.";
  return null;
};

function TestingProgress({
  pass,
  environmentId,
}: {
  readonly pass: RevdocPass;
  readonly environmentId: ScopedThreadRef["environmentId"];
}) {
  const navigate = useNavigate();
  const testing = pass.testing;
  const childRef = testing?.childThreadId
    ? scopeThreadRef(environmentId, testing.childThreadId)
    : null;
  const child = useThreadShell(childRef);
  if (!testing) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>
        Testing: {testing.recorded} of {testing.total} recorded · section {testing.section} of{" "}
        {testing.sections}
      </span>
      {child?.hasPendingApprovals || child?.hasPendingUserInput ? (
        <Badge variant="warning" size="sm">
          Needs input
        </Badge>
      ) : null}
      {childRef ? (
        <Button
          variant="link"
          size="xs"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(childRef),
            })
          }
        >
          Open testing agent
        </Button>
      ) : (
        <span>Starting the testing agent…</span>
      )}
    </div>
  );
}

function AreaGroup(props: {
  readonly area: string;
  readonly items: ReadonlyArray<RevdocItemSummary>;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly renderRow: (item: RevdocItemSummary) => React.ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <div className="flex">
        <Button variant="ghost" size="sm" aria-expanded={props.expanded} onClick={props.onToggle}>
          {props.expanded ? <ChevronDown /> : <ChevronRight />}
          <span className="truncate">{props.area}</span>
          <span className="text-muted-foreground">{props.items.length}</span>
        </Button>
      </div>
      {props.expanded ? (
        props.items.length > LARGE_AREA ? (
          <div className="h-[60vh]">
            <LegendList<RevdocItemSummary>
              data={props.items}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => props.renderRow(item)}
              estimatedItemSize={64}
              drawDistance={640}
              className="h-full"
            />
          </div>
        ) : (
          props.items.map((item) => props.renderRow(item))
        )
      ) : null}
    </section>
  );
}

export function RevdocPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget: ComposerThreadTarget;
}) {
  const { threadRef } = props;
  const environmentId = threadRef.environmentId;
  const actions = useRevdocActions(threadRef);
  const { state, error } = useRevdocReview(environmentId, actions.target);
  const browserAccess = useEnvironmentSettings(
    environmentId,
    (settings) => settings.enableAgentBrowserAccess,
  );
  const getItems = useAtomCommand(revdocEnvironment.getItems, { reportFailure: false });
  const deleteReview = useAtomCommand(revdocEnvironment.deleteReview, { reportFailure: false });
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [areaOverrides, setAreaOverrides] = useState<Record<string, boolean>>({});

  const summary = summarizeRevdoc(state.items);
  const pass = state.activePass;
  const generating = pass?.kind === "generate";
  const editingDisabled = generating || !actions.canOperate;
  const canTest = actions.canOperate && pass === null && state.testParentThreadId !== null;
  const latestGenerate = state.latestPasses.find((candidate) => candidate.kind === "generate");
  const latestTest = state.latestPasses.find((candidate) => candidate.kind === "test");
  const hasFindings = state.items.some(needsFix);

  const { groups, dismissed } = (() => {
    const query = search.trim().toLowerCase();
    const byArea = new Map<string, RevdocItemSummary[]>();
    const hidden: RevdocItemSummary[] = [];
    for (const item of state.items) {
      if (item.dismissed) {
        hidden.push(item);
        continue;
      }
      if (query && !`${item.check} ${item.note} ${item.area}`.toLowerCase().includes(query))
        continue;
      if (outcomeFilter !== "all" && item.outcome !== outcomeFilter) continue;
      if (attentionOnly && !needsAttention(item)) continue;
      byArea.set(item.area, [...(byArea.get(item.area) ?? []), item]);
    }
    return { groups: [...byArea.entries()], dismissed: hidden };
  })();

  const renderRow = (item: RevdocItemSummary) => (
    <RevdocItemRow
      key={item.id}
      item={item}
      threadRef={threadRef}
      target={actions.target}
      worktreePath={state.worktreePath}
      editingDisabled={editingDisabled}
      testingDisabled={!canTest}
      onTest={(itemId) => void actions.test("items", [itemId])}
    />
  );

  const draftFix = async () => {
    const ids = state.items.filter(needsFix).map((item) => item.id);
    const details: RevdocItemDetail[] = [];
    for (let start = 0; start < ids.length; start += 100) {
      const result = await getItems({
        environmentId,
        input: { ...actions.target, ids: ids.slice(start, start + 100) },
      });
      if (result._tag === "Failure") {
        toastRevdocFailure("Could not draft the fix request", result);
        return;
      }
      details.push(...result.value.items);
    }
    const text = draftFixRequest(details);
    if (!text) return;
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(props.composerDraftTarget)?.prompt ?? "";
    store.setPrompt(props.composerDraftTarget, appendToDraft(current, text));
    toastManager.add({ type: "success", title: "Fix request added to the composer" });
  };

  const removeReview = async () => {
    const message =
      "Delete this Revdoc review? Outcomes, notes, and AI results cannot be recovered.";
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await deleteReview({
      environmentId,
      input: { ...actions.target, expectedRevision: state.revision },
    });
    if (result._tag === "Failure") toastRevdocFailure("Could not delete the review", result);
  };

  const failureLine =
    passLine(pass ? undefined : latestGenerate) ?? passLine(pass ? undefined : latestTest);
  const areaExpanded = (area: string) =>
    areaOverrides[area] ?? summary.total <= COLLAPSE_AREAS_ABOVE;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold text-foreground">
              {state.review?.title ?? "Revdoc"}
            </span>
            {state.review?.summary ? (
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {state.review.summary}
              </span>
            ) : null}
          </div>
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="More Revdoc actions" />}
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={!state.review} onClick={() => setShowContext((open) => !open)}>
                {showContext ? "Hide context" : "Show context"}
              </MenuItem>
              <MenuItem onClick={() => void navigate({ to: "/settings/general" })}>
                Revdoc settings
              </MenuItem>
              <MenuItem
                variant="destructive"
                disabled={!state.review || pass !== null || !actions.canOperate}
                onClick={() => void removeReview()}
              >
                Delete review
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        {showContext && state.review ? (
          <div className="flex flex-col gap-1 whitespace-pre-wrap text-xs text-muted-foreground">
            <span>{state.review.summary}</span>
            {state.review.context ? <span>{state.review.context}</span> : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <RevdocWorktreePicker threadRef={threadRef} />
          {state.review ? (
            <span className="text-xs text-muted-foreground">
              {summary.reviewed} of {summary.total} reviewed
              {summary.findings > 0 ? ` · ${summary.findings} findings` : ""}
              {summary.needsRetest > 0 ? ` · ${summary.needsRetest} need retest` : ""}
            </span>
          ) : null}
          {state.review?.partial ? (
            <Badge variant="info" size="sm">
              Partial
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {pass ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!actions.canOperate}
              onClick={() => void actions.cancel()}
            >
              Stop pass
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={!actions.canOperate}
              onClick={() => void actions.generate("generate")}
            >
              {state.review ? "Regenerate" : "Generate review"}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={!state.review || generating}
            onClick={() => void actions.refresh()}
          >
            Refresh
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!state.review || !canTest}
                  title={state.testParentThreadId === null ? NO_THREAD_TO_TEST : undefined}
                />
              }
            >
              Test with AI
              <ChevronDown />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuItem onClick={() => void actions.test("remaining")}>Remaining checks</MenuItem>
              <MenuItem onClick={() => void actions.test("failed")}>Failed checks</MenuItem>
            </MenuPopup>
          </Menu>
          {hasFindings ? (
            <Button size="xs" variant="ghost" onClick={() => void draftFix()}>
              Draft fix request
            </Button>
          ) : null}
        </div>
        {state.review && state.testParentThreadId === null ? (
          <span className="text-xs text-muted-foreground">{NO_THREAD_TO_TEST}</span>
        ) : null}
        {pass?.kind === "generate" ? (
          pass.generation ? (
            <RevdocGenerationProgress
              key={revdocProgressKey(pass.generation)}
              progress={pass.generation}
            />
          ) : (
            <span className="text-xs text-muted-foreground">Generating…</span>
          )
        ) : null}
        {pass?.kind === "test" ? (
          <>
            <TestingProgress pass={pass} environmentId={environmentId} />
            {!browserAccess ? (
              <span className="text-xs text-warning-foreground">
                Agent browser access is off, so browser checks will be blocked.{" "}
                <Button
                  variant="link"
                  size="xs"
                  onClick={() => void navigate({ to: "/settings/integrations" })}
                >
                  Turn it on
                </Button>
              </span>
            ) : null}
          </>
        ) : null}
        {failureLine ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{failureLine}</span>
            {latestGenerate && latestGenerate.status !== "completed" && !pass ? (
              <Button size="xs" variant="link" onClick={() => void actions.generate("generate")}>
                Run again
              </Button>
            ) : null}
          </div>
        ) : null}
        {state.review?.exportError ? (
          <span className="text-xs text-warning-foreground">{state.review.exportError}</span>
        ) : null}
        {state.review ? (
          <div className="flex flex-wrap items-center gap-1">
            <Input
              size="sm"
              value={search}
              placeholder="Search checks"
              aria-label="Search checks"
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              value={outcomeFilter}
              items={{ all: "All outcomes", ...REVDOC_OUTCOME_LABELS }}
              onValueChange={(value) => setOutcomeFilter((value ?? "all") as OutcomeFilter)}
            >
              <SelectTrigger size="xs" aria-label="Outcome filter">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="all">All outcomes</SelectItem>
                {Object.entries(REVDOC_OUTCOME_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="xs"
              variant={attentionOnly ? "secondary" : "ghost"}
              aria-pressed={attentionOnly}
              onClick={() => setAttentionOnly((on) => !on)}
            >
              Needs attention
            </Button>
          </div>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && !state.loaded ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{error}</p>
        ) : !state.loaded ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">Loading review…</p>
        ) : state.deleted ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">This review was deleted.</p>
        ) : !state.review ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            {pass
              ? "The first review is being generated."
              : "No review yet. Generate one to turn this worktree's changes into a checklist."}
          </p>
        ) : (
          <>
            {groups.map(([area, items]) => (
              <AreaGroup
                key={area}
                area={area}
                items={items}
                expanded={areaExpanded(area)}
                onToggle={() =>
                  setAreaOverrides((current) => ({ ...current, [area]: !areaExpanded(area) }))
                }
                renderRow={renderRow}
              />
            ))}
            {groups.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No checks match these filters.
              </p>
            ) : null}
            {dismissed.length > 0 ? (
              <AreaGroup
                area="Dismissed"
                items={dismissed}
                expanded={showDismissed}
                onToggle={() => setShowDismissed((open) => !open)}
                renderRow={renderRow}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
