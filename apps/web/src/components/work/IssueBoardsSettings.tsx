import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type IssueBoardMapping,
  type IssueBoardSummary,
  type IssueBoardView,
  issueReadyColumnIds,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PlusIcon, TicketIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { BoardSyncStatus } from "./BoardSyncStatus";
import {
  IssueBoardConfigurationDialog,
  describeBoardLocator,
} from "./IssueBoardConfigurationDialog";
import {
  issueErrorMessage,
  issuesEnvironment,
  unwrapIssueResult,
  useDisconnectIssueBoard,
  useIssueBoardEnvironments,
  useIssueBoardSync,
} from "./issuesState";

function mappingSummary(mapping: IssueBoardMapping, view: IssueBoardView | null): string {
  const title = (id: string) => view?.columns.find((column) => column.id === id)?.title ?? id;
  return [
    `Ready: ${issueReadyColumnIds(mapping).map(title).join(", ")}`,
    `In progress: ${title(mapping.inProgress)}`,
    `In PR: ${title(mapping.inPullRequest)}`,
    `Completed: ${title(mapping.completed)}${mapping.moveOnMerge ? " on merge" : ""}`,
  ].join(" · ");
}

function BoardConnectionRow({
  environmentId,
  board,
  connected,
  onConfigure,
  onDisconnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly board: IssueBoardSummary;
  readonly connected: boolean;
  readonly onConfigure: (view: IssueBoardView) => void;
  readonly onDisconnected: () => void;
}) {
  const openBoard = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });
  const disconnectBoard = useDisconnectIssueBoard();
  const [view, setView] = useState<IssueBoardView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveSync = useIssueBoardSync(
    connected ? { environmentId, projectId: board.projectId, boardId: board.id } : null,
  );

  // The stored copy carries the column titles the mapping summary needs; it costs no host call.
  const open = async (refresh: boolean) => {
    try {
      const result = unwrapIssueResult(
        await openBoard({
          environmentId,
          input: {
            projectId: board.projectId,
            boardId: board.id,
            ...(refresh ? { refresh: true } : {}),
          },
        }),
      );
      setView(result);
      setError(null);
    } catch (failure) {
      setError(issueErrorMessage(failure));
    }
  };
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- open sets state only after the request answers.
    if (connected) void open(false);
  }, [connected, open]);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      if (await disconnectBoard(environmentId, board)) onDisconnected();
    } catch (failure) {
      setError(issueErrorMessage(failure));
    }
    setBusy(false);
  };

  const mapping = board.mapping ?? view?.board.mapping ?? null;
  return (
    <SettingsRow
      title={board.title}
      description={[
        describeBoardLocator(board.locator),
        ...(mapping ? [mappingSummary(mapping, view)] : []),
      ].join(" · ")}
      status={
        error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <BoardSyncStatus
            sync={liveSync ?? view?.sync ?? board.sync}
            retryDisabled={!connected}
            onRetry={() => void open(true)}
          />
        )
      }
      control={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={!connected || busy || !view}
            onClick={() => view && onConfigure(view)}
          >
            Configure columns
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!connected || busy}
            onClick={() => void open(true)}
          >
            Refresh
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!connected || busy}
            onClick={() => void disconnect()}
          >
            Disconnect
          </Button>
        </>
      }
    />
  );
}

/** Board connections of one environment, grouped by project, with Connect board. */
export function IssueBoardsSettings() {
  const issueEnvironments = useIssueBoardEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environment =
    issueEnvironments.find((candidate) => candidate.environmentId === selectedEnvironmentId) ??
    issueEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    issueEnvironments[0];
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const allProjects = useProjects();
  const projects = allProjects.filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );

  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });
  const [listed, setListed] = useState<{
    readonly environmentId: EnvironmentId;
    readonly boards: ReadonlyArray<IssueBoardSummary>;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!environmentId || !connected) return;
    let current = true;
    // oxlint-disable-next-line react/set-state-in-effect -- A new list request hides the previous request's error.
    setError(null);
    void listBoards({ environmentId, input: { connectedOnly: true } })
      .then(unwrapIssueResult)
      .then((boards) => {
        if (current) setListed({ environmentId, boards });
      })
      .catch((failure: unknown) => {
        if (current) setError(issueErrorMessage(failure));
      });
    return () => {
      current = false;
    };
  }, [
    connected,
    environmentId,
    listBoards,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Bumping the revision lists the boards again.
    revision,
  ]);
  const boards = listed?.environmentId === environmentId ? listed.boards : null;
  const groups = (() => {
    const byProject = new Map<string, IssueBoardSummary[]>();
    for (const board of boards ?? []) {
      byProject.set(board.projectId, [...(byProject.get(board.projectId) ?? []), board]);
    }
    return [...byProject.entries()].map(([projectId, projectBoards]) => ({
      projectId,
      title:
        projects.find((project) => project.id === projectId)?.title ?? "Project not on this list",
      boards: projectBoards,
    }));
  })();

  const [configuring, setConfiguring] = useState<IssueBoardView | "new" | null>(null);
  const relist = () => setRevision((value) => value + 1);
  const firstProject: EnvironmentProject | undefined = projects[0];

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Issue boards"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!connected || !firstProject}
            onClick={() => setConfiguring("new")}
          >
            <PlusIcon className="size-3" />
            Connect board
          </Button>
        }
      >
        {issueEnvironments.length > 1 && environmentId ? (
          <SettingsRow
            title="Environment"
            description="Each computer keeps its own board connections. Connect the board on every computer that starts tickets."
            control={
              <Select
                value={environmentId}
                onValueChange={(next) => {
                  if (typeof next === "string") setSelectedEnvironmentId(next as EnvironmentId);
                }}
              >
                <SelectTrigger size="sm" aria-label="Environment">
                  <SelectValue>{environment?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {issueEnvironments.map((candidate) => (
                    <SelectItem
                      key={candidate.environmentId}
                      value={candidate.environmentId}
                      label={candidate.label}
                    >
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        <SettingsRow
          title="Signing in"
          description={
            <>
              GitHub Projects need a token with the project scope: run{" "}
              <code>gh auth refresh -s project</code>, or save a token in{" "}
              <Link to="/settings/source-control" className="underline">
                Source control
              </Link>
              . Azure DevOps boards use <code>az login</code> and <code>az devops login</code> on
              the computer hosting the project.
            </>
          }
        />
      </SettingsSection>
      {issueEnvironments.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TicketIcon />
            </EmptyMedia>
            <EmptyTitle>No environment supports issue boards</EmptyTitle>
            <EmptyDescription>
              Connect an environment running this version of Satellite to manage its boards.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : environment && !connected ? (
        <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
          {environment.label} is not connected. Reconnect it to manage its boards.
        </p>
      ) : error ? (
        <p role="alert" className="px-3 text-sm text-destructive sm:px-4">
          {error}
        </p>
      ) : boards && groups.length === 0 ? (
        <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
          No boards are connected on {environment?.label ?? "this environment"}.
        </p>
      ) : null}
      {environmentId
        ? groups.map((group) => (
            <SettingsSection key={group.projectId} title={group.title}>
              {group.boards.map((board) => (
                <BoardConnectionRow
                  key={board.id}
                  environmentId={environmentId}
                  board={board}
                  connected={connected}
                  onConfigure={setConfiguring}
                  onDisconnected={relist}
                />
              ))}
            </SettingsSection>
          ))
        : null}
      {configuring && environmentId && connected && firstProject ? (
        <IssueBoardConfigurationDialog
          environmentId={environmentId}
          projects={projects}
          initialProjectId={configuring === "new" ? firstProject.id : configuring.board.projectId}
          initial={configuring === "new" ? null : configuring}
          onClose={() => setConfiguring(null)}
          onConfigured={() => {
            setConfiguring(null);
            relist();
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
