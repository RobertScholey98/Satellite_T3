import { useAtomValue } from "@effect/atom-react";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useUiStateStore } from "~/uiStateStore";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolvePullRequestMergeMethod } from "../pullRequest/pullRequestDetail.logic";
import {
  usePullRequestActionRunner,
  usePullRequestDefaultMergeMethodResolver,
} from "../pullRequest/usePullRequestActions";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  factoryMergeConfirmText,
  factoryMergeHeldPaths,
  factoryMergeRowDetail,
  factoryMergeRowNote,
  type FactoryMergeRow,
} from "./factoryMergeLogic";
import { FACTORY_CARD_CLASS } from "./FactoryThreadStack";
import { useFactoryMergeRows } from "./factoryWorkspaceState";

// A merge queue or a host that lags can leave the next sync reading the pull request as before, and
// a sync that reads nothing new does not replace the snapshot.
const MERGE_HOLD_MS = 2 * 60_000;

/** The open pull requests of a manager's teams, in merge order; nothing while there are none. */
export function FactoryMergeCard(props: {
  readonly environmentId: EnvironmentId;
  readonly managerId: string;
}) {
  const rows = useFactoryMergeRows(props.environmentId, props.managerId);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Pull requests to merge" className={`${FACTORY_CARD_CLASS} p-2`}>
      <h3 className="flex min-h-8 items-center px-2.5 text-sm font-semibold select-none">
        Pull requests
      </h3>
      <ul className="m-0 flex list-none flex-col">
        {rows.map((row) => (
          <MergeRow key={row.key} environmentId={props.environmentId} row={row} />
        ))}
      </ul>
    </section>
  );
}

function MergeRow(props: { readonly environmentId: EnvironmentId; readonly row: FactoryMergeRow }) {
  const { row } = props;
  const canWrite = useAtomValue(
    pullRequestEnvironment.runAction.permissionAtom(props.environmentId),
  );
  const resolveProjectDefault = usePullRequestDefaultMergeMethodResolver(
    props.environmentId,
    row.projectId,
  );
  // The host's answer comes before the sync that marks the pull request merged, so the row holds
  // until a sync replaces the snapshot it merged from, or for MERGE_HOLD_MS if none does. Then it
  // leaves the card, or offers Merge again if the host still reports it open.
  const [mergedFrom, setMergedFrom] = useState<string | null>(null);
  const merging = mergedFrom !== null && mergedFrom === row.syncedAt;
  // oxlint-disable-next-line t3code/react-effect-budget -- Release the merging hold after MERGE_HOLD_MS when no sync replaces the snapshot first.
  useEffect(() => {
    if (!merging) return;
    const timeout = setTimeout(() => setMergedFrom(null), MERGE_HOLD_MS);
    return () => clearTimeout(timeout);
  }, [merging]);
  // The same merge as the pull request list's quick action, with the repository's method.
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId: props.environmentId,
    reference: {
      projectId: row.projectId,
      host: row.host,
      repository: row.repository,
      number: row.number,
    },
    terminology: (
      sourceControlClients.findByPublicHost(row.host) ?? sourceControlClients.get(undefined)
    ).changeRequest,
    onSuccess: () => setMergedFrom(row.syncedAt),
    resolveMergeMethod: (detail) => {
      const allowed = detail.capabilities.mergeMethods.filter(
        (method) => detail.mergeCapabilities[method],
      );
      if (allowed.length === 0)
        throw new Error("No merge method is available for this repository.");
      return resolvePullRequestMergeMethod(
        allowed,
        null,
        resolveProjectDefault(),
        useUiStateStore.getState().pullRequestMergeMethod,
      );
    },
  });
  const held = factoryMergeHeldPaths(row);
  const merge = async () => {
    const message = factoryMergeConfirmText(row);
    if (message !== null) {
      const confirmed = await (requestConfirmDialog(message, { variant: "destructive" }) ??
        Promise.resolve(window.confirm(message)));
      if (!confirmed) return;
    }
    await perform("merge");
  };
  const title = row.title ?? row.repository;
  const note = factoryMergeRowNote(row);
  const ready = row.status === "ready" && !merging;
  return (
    <li className="flex items-start gap-2.5 rounded-lg px-2.5 py-1.5">
      <PullRequestGlyph.pullRequest
        aria-hidden
        className={cn(
          THREAD_DETAILS_PANEL_ICON_CLASS,
          "mt-px",
          ready && PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
        )}
      />
      <Tooltip>
        <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
          <p className="truncate text-sm font-medium text-foreground/80">{title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {merging ? (
              <>
                #{row.number} · <span>Merging…</span>
              </>
            ) : (
              factoryMergeRowDetail(row)
            )}
          </p>
          {note === null ? null : (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />
              <span className="truncate">{note}</span>
            </p>
          )}
        </TooltipTrigger>
        <TooltipPopup side="left">
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground">For {row.assignmentTitle}</p>
          {row.awaitingAnswer.length > 0 ? (
            <p className="text-muted-foreground">
              Waiting for your answer on the team's card: {row.awaitingAnswer.join(", ")}
            </p>
          ) : null}
          {held.length > 0 ? (
            <p className="text-muted-foreground">Held by the factory: {held.join(", ")}</p>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      {ready ? (
        <Button
          variant="outline"
          size="xs"
          disabled={!canWrite || actionPending}
          aria-label={`Merge #${row.number}`}
          onClick={() => void merge()}
        >
          {actionPending ? <Spinner size="xs" /> : null}
          Merge
        </Button>
      ) : null}
    </li>
  );
}
