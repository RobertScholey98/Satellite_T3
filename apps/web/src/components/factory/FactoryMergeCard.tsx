import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useUiStateStore } from "~/uiStateStore";
import { resolvePullRequestMergeMethod } from "../pullRequest/pullRequestDetail.logic";
import {
  usePullRequestActionRunner,
  usePullRequestDefaultMergeMethodResolver,
} from "../pullRequest/usePullRequestActions";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  FACTORY_MERGE_STATUS_LABEL,
  factoryMergeConfirmText,
  factoryMergeHeldPaths,
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
    <section aria-label="Pull requests to merge" className={FACTORY_CARD_CLASS}>
      <h3 className="px-3.5 pt-3 pb-1 text-2xs font-medium text-muted-foreground select-none">
        Pull requests
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1 px-2 pb-2">
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
  return (
    <li className="flex items-center gap-2 rounded-lg px-1.5 py-1">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground/80">
          <span className="text-muted-foreground">#{row.number}</span> {row.title ?? row.repository}
        </p>
        <p className="truncate text-2xs text-muted-foreground">{row.assignmentTitle}</p>
        {row.awaitingAnswer.length > 0 ? (
          <p className="text-2xs text-warning-foreground">
            Protected paths waiting for your answer on the team's card:{" "}
            {row.awaitingAnswer.join(", ")}
          </p>
        ) : null}
        {held.length > 0 ? (
          <p className="text-2xs text-warning-foreground">Protected paths: {held.join(", ")}</p>
        ) : null}
      </div>
      {merging ? (
        <span className="shrink-0 text-2xs text-muted-foreground">Merging…</span>
      ) : row.status === "ready" ? (
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
      ) : (
        <span className="shrink-0 text-2xs text-muted-foreground">
          {FACTORY_MERGE_STATUS_LABEL[row.status]}
        </span>
      )}
    </li>
  );
}
