import {
  AuthSettingsWriteScope,
  issueReadyColumnIds,
  type FactoryManager,
  type FactoryProjectTracker,
  type IssueBoardSummary,
  type IssueBoardView,
  type IssuePublicationDestination,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useId, useRef, useState, useEffect } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { issuesEnvironment } from "../../state/issues";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useFactoryCommand } from "./useFactoryCommand";

function trackerSummary(destination: IssuePublicationDestination) {
  if (destination.kind === "azure")
    return `${destination.organization} / ${destination.project} · ${destination.workItemType} · ${destination.state} · ${destination.areaPath}`;
  return `${destination.host}/${destination.repository} · ${destination.triage.kind === "labels" ? `labels: ${destination.triage.labels.join(", ")}` : "connected Project triage column"}`;
}

export function FactoryTrackerSettings({
  environment,
  manager,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
}) {
  const current = environment.data?.projectTrackers.findLast(
    (entry) => entry.projectId === manager.projectId,
  );
  return (
    <TrackerForm
      key={`${environment.environmentId}:${manager.projectId}:${current?.id ?? "new"}`}
      environment={environment}
      manager={manager}
      current={current}
    />
  );
}

function TrackerForm({
  environment,
  manager,
  current,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  current: FactoryProjectTracker | undefined;
}) {
  const prefix = useId();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, settingsScope && manager.projectId !== null);
  const destination = current?.destination.destination;
  const [kind, setKind] = useState<"github" | "azure">(destination?.kind ?? "github");
  const [host, setHost] = useState(
    destination?.kind === "github" ? destination.host : "github.com",
  );
  const [repository, setRepository] = useState(
    destination?.kind === "github" ? destination.repository : "",
  );
  const [triageKind, setTriageKind] = useState<"labels" | "board">(
    destination?.kind === "github" ? destination.triage.kind : "labels",
  );
  const [labels, setLabels] = useState(
    destination?.kind === "github" ? destination.triage.labels.join("\n") : "",
  );
  const [organization, setOrganization] = useState(
    destination?.kind === "azure" ? destination.organization : "",
  );
  const [project, setProject] = useState(destination?.kind === "azure" ? destination.project : "");
  const [workItemType, setWorkItemType] = useState(
    destination?.kind === "azure" ? destination.workItemType : "",
  );
  const [areaPath, setAreaPath] = useState(
    destination?.kind === "azure" ? destination.areaPath : "",
  );
  const [state, setState] = useState(destination?.kind === "azure" ? destination.state : "");
  const [boardId, setBoardId] = useState(
    destination?.kind === "azure"
      ? destination.boardId
      : destination?.triage.kind === "board"
        ? destination.triage.boardId
        : "",
  );
  const [columnId, setColumnId] = useState(
    destination?.kind === "azure"
      ? destination.columnId
      : destination?.triage.kind === "board"
        ? destination.triage.columnId
        : "",
  );
  const [boards, setBoards] = useState<readonly IssueBoardSummary[]>([]);
  const [boardView, setBoardView] = useState<IssueBoardView | null>(null);
  const [loadingBoards, setLoadingBoards] = useState(false);
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const requestGeneration = useRef(0);
  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });
  const openBoard = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });
  const error = validation ?? command.error;
  const needsBoard = kind === "azure" || triageKind === "board";
  const disabled = command.disabled || loadingBoards;
  const matchingBoards = boards.filter(
    (board) => board.locator.kind === (kind === "github" ? "github-project" : "azure-board"),
  );
  const blockedColumns = boardView?.board.mapping
    ? [
        ...issueReadyColumnIds(boardView.board.mapping),
        boardView.board.mapping.inProgress,
        boardView.board.mapping.inPullRequest,
        boardView.board.mapping.completed,
      ]
    : [];
  const triageColumns =
    boardView?.columns.filter((column) => !blockedColumns.includes(column.id)) ?? [];
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(
    () => () => {
      requestGeneration.current++;
    },
    [],
  );

  const showFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const cause = squashAtomCommandFailure(result);
    setValidation(
      cause instanceof Error ? cause.message : "Could not read the connected boards. Try again.",
    );
  };
  const loadBoard = async (id: string, generation: number) => {
    if (manager.projectId === null) return;
    const result = await openBoard({
      environmentId: environment.environmentId,
      input: { projectId: manager.projectId, boardId: id, refresh: true },
    });
    if (generation !== requestGeneration.current) return;
    if (result._tag === "Failure") {
      showFailure(result);
      return;
    }
    setBoardView(result.value);
    if (result.value.board.locator.kind === "azure-board") {
      setOrganization(result.value.board.locator.organization);
      setProject(result.value.board.locator.project);
    }
  };
  const loadBoards = async () => {
    if (disabled || manager.projectId === null) return;
    const generation = ++requestGeneration.current;
    setLoadingBoards(true);
    setValidation(null);
    try {
      const result = await listBoards({
        environmentId: environment.environmentId,
        input: { projectId: manager.projectId, connectedOnly: true },
      });
      if (generation !== requestGeneration.current) return;
      if (result._tag === "Failure") {
        showFailure(result);
        return;
      }
      setBoards(result.value);
      setBoardsLoaded(true);
      if (boardId && result.value.some((board) => board.id === boardId))
        await loadBoard(boardId, generation);
    } finally {
      if (generation === requestGeneration.current) setLoadingBoards(false);
    }
  };
  const chooseBoard = async (id: string | null) => {
    if (!id || disabled) return;
    const generation = ++requestGeneration.current;
    setBoardId(id);
    setColumnId("");
    setBoardView(null);
    setLoadingBoards(true);
    setValidation(null);
    try {
      await loadBoard(id, generation);
    } finally {
      if (generation === requestGeneration.current) setLoadingBoards(false);
    }
  };
  const save = async () => {
    if (
      disabled ||
      manager.projectId === null ||
      !readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)
    )
      return;
    setValidation(null);
    setSaved(false);
    const labelList = [
      ...new Set(
        labels
          .split(/\r?\n/)
          .map((label) => label.trim())
          .filter(Boolean),
      ),
    ];
    if (
      kind === "github" &&
      (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host.trim()) ||
        !/^[^\s/]+\/[^\s/]+$/.test(repository.trim()))
    ) {
      setValidation("Enter the GitHub hostname and repository as owner/name.");
      return;
    }
    if (labelList.length > 30 || labelList.some((label) => label.length > 512)) {
      setValidation("Use at most 30 triage labels, each at most 512 characters.");
      return;
    }
    if (kind === "github" && triageKind === "labels" && !labelList.length) {
      setValidation("Enter at least one existing triage label, one per line.");
      return;
    }
    if (needsBoard && (!boardId || !columnId)) {
      setValidation("Load the connected boards, then choose a board and its triage column.");
      return;
    }
    if (
      kind === "azure" &&
      [organization, project, workItemType, areaPath, state].some(
        (value) => !value.trim() || value.trim().length > 512,
      )
    ) {
      setValidation(
        "Complete the Azure organization, project, work item type, area path and initial state.",
      );
      return;
    }
    const next: IssuePublicationDestination =
      kind === "github"
        ? {
            kind,
            host: host.trim(),
            repository: repository.trim(),
            triage:
              triageKind === "labels"
                ? { kind: "labels", labels: labelList }
                : { kind: "board", labels: labelList, boardId, columnId },
          }
        : {
            kind,
            host: "dev.azure.com",
            organization: organization.trim(),
            project: project.trim(),
            workItemType: workItemType.trim(),
            areaPath: areaPath.trim(),
            state: state.trim(),
            boardId,
            columnId,
          };
    if (
      await command.submit({
        type: "project.tracker.configure",
        projectId: manager.projectId,
        expectedTrackerId: current?.id ?? null,
        destination: next,
      })
    )
      setSaved(true);
  };
  const field = (
    name: string,
    label: string,
    value: string,
    update: (value: string) => void,
    placeholder?: string,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`${prefix}-${name}`}>{label}</Label>
      <Input
        id={`${prefix}-${name}`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          update(event.target.value);
          setSaved(false);
        }}
        spellCheck={false}
      />
    </div>
  );

  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      aria-label="Retrospective issue tracker"
    >
      <h3 className="text-sm font-medium">Retrospective follow-up tickets</h3>
      <p className="text-sm text-muted-foreground">
        Project findings can become tickets in this project’s triage queue. Creating a ticket does
        not assign an implementation team or start work.
      </p>
      <p className="text-xs text-muted-foreground">
        {destination
          ? `Approved destination: ${trackerSummary(destination)}.`
          : "No tracker destination approved. Findings remain available until a destination is configured."}
      </p>
      {!settingsScope ? (
        <p role="status" className="text-sm text-muted-foreground">
          Settings permission is required to approve a tracker destination.
        </p>
      ) : null}
      {!environment.connected ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reconnect to {environment.label} before checking or saving the destination.
        </p>
      ) : null}
      {error ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-provider`}>Tracker</Label>
        <Select
          value={kind}
          disabled={disabled}
          items={[
            { value: "github", label: "GitHub" },
            { value: "azure", label: "Azure Boards" },
          ]}
          onValueChange={(value) => {
            if (value !== "github" && value !== "azure") return;
            setKind(value);
            setBoardId("");
            setColumnId("");
            setBoardView(null);
            setSaved(false);
          }}
        >
          <SelectTrigger id={`${prefix}-provider`}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="github">GitHub</SelectItem>
            <SelectItem value="azure">Azure Boards</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {kind === "github" ? (
        <>
          {field("host", "GitHub hostname", host, setHost, "github.com")}
          {field("repository", "Project repository", repository, setRepository, "owner/repository")}
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-triage-kind`}>Triage destination</Label>
            <Select
              value={triageKind}
              disabled={disabled}
              items={[
                { value: "labels", label: "Issue labels" },
                { value: "board", label: "Connected GitHub Project" },
              ]}
              onValueChange={(value) => {
                if (value === "labels" || value === "board") setTriageKind(value);
              }}
            >
              <SelectTrigger id={`${prefix}-triage-kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="labels">Issue labels</SelectItem>
                <SelectItem value="board">Connected GitHub Project</SelectItem>
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-labels`}>
              {triageKind === "labels"
                ? "Existing triage labels"
                : "Additional issue labels (optional)"}
            </Label>
            <Textarea
              id={`${prefix}-labels`}
              value={labels}
              rows={3}
              disabled={disabled}
              onChange={(event) => {
                setLabels(event.target.value);
                setSaved(false);
              }}
            />
            <p className="text-xs text-muted-foreground">
              One existing label per line. Satellite checks the repository and labels before saving.
            </p>
          </div>
        </>
      ) : (
        <>
          {field("organization", "Azure organization", organization, setOrganization)}
          {field("project", "Azure project", project, setProject)}
          {field("type", "Work item type", workItemType, setWorkItemType, "Task")}
          {field("area", "Area path", areaPath, setAreaPath, "Project\\Team")}
          {field("state", "Initial triage state", state, setState, "New")}
          <p className="text-xs text-muted-foreground">
            The type, state and area must match this team’s connected board configuration.
          </p>
        </>
      )}
      {needsBoard ? (
        <div className="space-y-3">
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => void loadBoards()}>
            {loadingBoards ? "Checking boards…" : "Load connected boards"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Connect a board in the project’s Issues view first. Triage must be separate from ready,
            in progress, in PR and completed.
          </p>
          {boardsLoaded && matchingBoards.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              No compatible connected board is available for this project.
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-board`}>Connected board</Label>
            <Select
              value={boardId || null}
              disabled={disabled || matchingBoards.length === 0}
              items={matchingBoards.map((board) => ({ value: board.id, label: board.title }))}
              onValueChange={(value) => void chooseBoard(value)}
            >
              <SelectTrigger id={`${prefix}-board`}>
                <SelectValue
                  placeholder={
                    boardId ? "Approved board — load to view" : "Choose a connected board"
                  }
                />
              </SelectTrigger>
              <SelectPopup>
                {matchingBoards.map((board) => (
                  <SelectItem key={board.id} value={board.id}>
                    {board.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-column`}>Triage column</Label>
            <Select
              value={columnId || null}
              disabled={disabled || !boardView}
              items={triageColumns.map((column) => ({ value: column.id, label: column.title }))}
              onValueChange={(value) => {
                setColumnId(value ?? "");
                setSaved(false);
              }}
            >
              <SelectTrigger id={`${prefix}-column`}>
                <SelectValue
                  placeholder={
                    columnId ? "Approved column — load to view" : "Choose a triage column"
                  }
                />
              </SelectTrigger>
              <SelectPopup>
                {triageColumns.map((column) => (
                  <SelectItem key={column.id} value={column.id}>
                    {column.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          {boardView && triageColumns.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              This board needs a separate triage column before it can receive follow-up tickets.
            </p>
          ) : null}
        </div>
      ) : null}
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void save()}>
        {command.pending ? "Checking and saving tracker…" : "Approve tracker destination"}
      </Button>
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          Tracker destination approved for new project follow-up tickets.
        </p>
      ) : null}
    </section>
  );
}
