import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type IssueBoardLocator,
  type IssueBoardMapping,
  type IssueBoardSummary,
  type IssueBoardView,
  type ProjectId,
  issueReadyColumnIds,
} from "@t3tools/contracts";
import { Columns3Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { IssueReadyColumnsPicker } from "./IssueReadyColumnsPicker";
import { issueErrorMessage, issuesEnvironment, unwrapIssueResult } from "./issuesState";

export function IssueFormField({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ChoiceSelect({
  id,
  value,
  placeholder,
  options,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly placeholder: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger id={id} size="sm">
        <SelectValue placeholder={placeholder}>
          {options.find((option) => option.value === value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} label={option.label}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const EMPTY_MAPPING: IssueBoardMapping = {
  ready: [],
  inProgress: "",
  inPullRequest: "",
  completed: "",
  moveOnMerge: false,
};

const STAGE_FIELDS = [
  ["inProgress", "In progress"],
  ["inPullRequest", "In PR"],
  ["completed", "Completed"],
] as const;

export function describeBoardLocator(locator: IssueBoardLocator): string {
  return locator.kind === "github-project"
    ? `${locator.host} · ${locator.owner} / Project #${locator.projectNumber}`
    : `${locator.host} · ${locator.organization} / ${locator.project} / ${locator.team}`;
}

/**
 * Connects a board to a project, or remaps the columns of a connected one. Connecting starts from
 * the boards discovery finds through the project's sign-in, with a manual form for the rest.
 */
export function IssueBoardConfigurationDialog({
  environmentId,
  projects,
  initialProjectId,
  initial,
  onClose,
  onConfigured,
}: {
  readonly environmentId: EnvironmentId;
  /** Projects a new connection may belong to; a picker shows when there is more than one. */
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly initialProjectId: ProjectId;
  /** The connected board to remap; null connects a new board. */
  readonly initial: IssueBoardView | null;
  readonly onClose: () => void;
  readonly onConfigured: (view: IssueBoardView) => void;
}) {
  const [projectId, setProjectId] = useState<ProjectId>(
    initial?.board.projectId ?? initialProjectId,
  );
  const project = projects.find((candidate) => candidate.id === projectId);
  const [kind, setKind] = useState<IssueBoardLocator["kind"]>(
    initial?.board.locator.kind ?? "github-project",
  );
  const [host, setHost] = useState(initial?.board.locator.host ?? "github.com");
  const [owner, setOwner] = useState("");
  const [ownerKind, setOwnerKind] = useState<"user" | "organization">("organization");
  const [projectNumber, setProjectNumber] = useState("");
  const [organization, setOrganization] = useState("");
  const [azureProject, setAzureProject] = useState("");
  const [team, setTeam] = useState("");
  const [boardId, setBoardId] = useState("");

  const [view, setView] = useState(initial);
  const [mapping, setMapping] = useState<IssueBoardMapping | null>(initial?.board.mapping ?? null);
  const [manual, setManual] = useState(false);
  const [discovered, setDiscovered] = useState<ReadonlyArray<IssueBoardSummary> | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });
  const open = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });
  const configure = useAtomCommand(issuesEnvironment.configureBoard, { reportFailure: false });

  useEffect(() => {
    if (initial) return;
    let current = true;
    // oxlint-disable-next-line react/set-state-in-effect -- A new discovery request hides the previous request's boards and error.
    setDiscovered(null);
    setDiscoveryError(null);
    void listBoards({ environmentId, input: { projectId } })
      .then(unwrapIssueResult)
      .then((boards) => {
        if (current) setDiscovered(boards.filter((board) => board.mapping === null));
      })
      .catch((failure: unknown) => {
        if (current) setDiscoveryError(issueErrorMessage(failure));
      });
    return () => {
      current = false;
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry bumps the attempt to run discovery again.
    discoveryAttempt,
    environmentId,
    initial,
    listBoards,
    projectId,
  ]);

  const locator: IssueBoardLocator =
    kind === "github-project"
      ? { kind, host, owner, ownerKind, projectNumber: Number(projectNumber) }
      : { kind, host, organization, project: azureProject, team, boardId };
  const manualComplete =
    host.trim() !== "" &&
    (kind === "github-project"
      ? owner.trim() !== "" && Number.isInteger(Number(projectNumber)) && Number(projectNumber) > 0
      : [organization, azureProject, team, boardId].every((value) => value.trim() !== ""));

  const loadColumns = async (selected: IssueBoardLocator) => {
    setBusy(true);
    setError(null);
    try {
      const result = unwrapIssueResult(
        await open({ environmentId, input: { projectId, locator: selected } }),
      );
      setView(result);
      setMapping(result.board.mapping ?? EMPTY_MAPPING);
    } catch (failure) {
      setError(issueErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!view || !mapping) return;
    setBusy(true);
    setError(null);
    try {
      const result = unwrapIssueResult(
        await configure({
          environmentId,
          input: { requestId: randomUUID(), projectId, locator: view.board.locator, mapping },
        }),
      );
      onConfigured(result);
    } catch (failure) {
      setError(issueErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const mappingComplete =
    mapping !== null &&
    issueReadyColumnIds(mapping).length > 0 &&
    mapping.inProgress !== "" &&
    mapping.inPullRequest !== "" &&
    mapping.completed !== "";
  const columnOptions = (view?.columns ?? []).map((column) => ({
    value: column.id,
    label: column.title,
  }));
  const projectTitle = project?.title ?? "this project";

  return (
    <Dialog
      open
      onOpenChange={(opened) => {
        if (!opened && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Configure board columns" : "Connect board"}</DialogTitle>
          <DialogDescription>
            {view
              ? `${view.board.title} · ${projectTitle}. Choose the columns for this project's workflow.`
              : manual
                ? `Enter the details of an existing board to connect it to ${projectTitle}.`
                : `Choose a board to connect to ${projectTitle}. These boards are available through this computer's sign-in.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            {!initial && !view && projects.length > 1 ? (
              <IssueFormField label="Project" htmlFor="issue-board-project">
                <ChoiceSelect
                  id="issue-board-project"
                  value={projectId}
                  placeholder="Choose a project"
                  disabled={busy}
                  options={projects.map((candidate) => ({
                    value: candidate.id,
                    label: candidate.title,
                  }))}
                  onChange={(value) => setProjectId(value as ProjectId)}
                />
              </IssueFormField>
            ) : null}
            {busy ? (
              <p role="status" className="text-sm text-muted-foreground">
                {view ? "Saving board mapping…" : "Loading board columns…"}
              </p>
            ) : null}
            {!view && !manual ? (
              <div className="grid gap-2">
                {discoveryError ? (
                  <div className="grid gap-2">
                    <p role="alert" className="text-sm text-destructive">
                      Could not discover boards: {discoveryError}
                    </p>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setDiscoveryAttempt((attempt) => attempt + 1)}
                    >
                      Retry discovery
                    </Button>
                  </div>
                ) : discovered === null ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Finding available boards…
                  </p>
                ) : discovered.length === 0 ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    No unconnected boards were found for this repository's owner or organisation.
                    Use manual setup to connect a board owned elsewhere.
                  </p>
                ) : null}
                {(discovered ?? []).map((board) => (
                  <div key={board.id} className="grid gap-1">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void loadColumns(board.locator)}
                    >
                      <Columns3Icon />
                      {board.title}
                    </Button>
                    <p className="px-1 text-xs text-muted-foreground">
                      {describeBoardLocator(board.locator)}
                    </p>
                  </div>
                ))}
              </div>
            ) : !view ? (
              <div className="grid gap-3">
                <IssueFormField label="Board type" htmlFor="issue-board-kind">
                  <ChoiceSelect
                    id="issue-board-kind"
                    value={kind}
                    placeholder="Choose a board type"
                    options={[
                      { value: "github-project", label: "GitHub Project" },
                      { value: "azure-board", label: "Azure DevOps board" },
                    ]}
                    onChange={(value) => {
                      const next = value === "azure-board" ? "azure-board" : "github-project";
                      setKind(next);
                      setHost(next === "azure-board" ? "dev.azure.com" : "github.com");
                    }}
                  />
                </IssueFormField>
                <IssueFormField label="Host" htmlFor="issue-board-host">
                  <Input
                    id="issue-board-host"
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                  />
                </IssueFormField>
                {kind === "github-project" ? (
                  <>
                    <IssueFormField label="Owner" htmlFor="issue-board-owner">
                      <Input
                        id="issue-board-owner"
                        value={owner}
                        onChange={(event) => setOwner(event.target.value)}
                      />
                    </IssueFormField>
                    <IssueFormField label="Owner type" htmlFor="issue-board-owner-kind">
                      <ChoiceSelect
                        id="issue-board-owner-kind"
                        value={ownerKind}
                        placeholder="Choose an owner type"
                        options={[
                          { value: "organization", label: "Organization" },
                          { value: "user", label: "User" },
                        ]}
                        onChange={(value) =>
                          setOwnerKind(value === "user" ? "user" : "organization")
                        }
                      />
                    </IssueFormField>
                    <IssueFormField label="Project number" htmlFor="issue-board-number">
                      <Input
                        id="issue-board-number"
                        inputMode="numeric"
                        value={projectNumber}
                        onChange={(event) => setProjectNumber(event.target.value)}
                      />
                    </IssueFormField>
                  </>
                ) : (
                  <>
                    <IssueFormField label="Organization" htmlFor="issue-board-organization">
                      <Input
                        id="issue-board-organization"
                        value={organization}
                        onChange={(event) => setOrganization(event.target.value)}
                      />
                    </IssueFormField>
                    <IssueFormField label="Project" htmlFor="issue-board-azure-project">
                      <Input
                        id="issue-board-azure-project"
                        value={azureProject}
                        onChange={(event) => setAzureProject(event.target.value)}
                      />
                    </IssueFormField>
                    <IssueFormField label="Team" htmlFor="issue-board-team">
                      <Input
                        id="issue-board-team"
                        value={team}
                        onChange={(event) => setTeam(event.target.value)}
                      />
                    </IssueFormField>
                    <IssueFormField label="Board" htmlFor="issue-board-board">
                      <Input
                        id="issue-board-board"
                        value={boardId}
                        onChange={(event) => setBoardId(event.target.value)}
                      />
                    </IssueFormField>
                  </>
                )}
                <Button
                  variant="outline"
                  disabled={busy || !manualComplete}
                  onClick={() => void loadColumns(locator)}
                >
                  Load board columns
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                <IssueFormField
                  label="Ready for development"
                  hint="Tickets in any selected column can be started."
                >
                  <IssueReadyColumnsPicker
                    columns={view.columns}
                    value={mapping ? issueReadyColumnIds(mapping) : []}
                    disabled={busy}
                    onChange={(ready) =>
                      setMapping((current) => (current ? { ...current, ready } : current))
                    }
                  />
                </IssueFormField>
                {STAGE_FIELDS.map(([key, label]) => (
                  <IssueFormField key={key} label={label} htmlFor={`issue-board-${key}`}>
                    <ChoiceSelect
                      id={`issue-board-${key}`}
                      value={mapping?.[key] ?? ""}
                      placeholder="Choose a column"
                      disabled={busy}
                      options={columnOptions}
                      onChange={(value) =>
                        setMapping((current) => ({ ...(current ?? EMPTY_MAPPING), [key]: value }))
                      }
                    />
                  </IssueFormField>
                ))}
                <Label>
                  <Switch
                    checked={mapping?.moveOnMerge ?? false}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setMapping((current) =>
                        current ? { ...current, moveOnMerge: checked } : current,
                      )
                    }
                  />
                  Move to Completed when a pull request is merged
                </Label>
              </div>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {!view && !manual ? (
            <Button
              variant="link"
              className="sm:mr-auto"
              disabled={busy}
              onClick={() => setManual(true)}
            >
              Manual setup
            </Button>
          ) : null}
          {!initial && (view || manual) ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setView(null);
                setMapping(null);
                setManual(false);
                setError(null);
              }}
            >
              Back
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {view && mapping ? (
            <Button disabled={busy || !mappingComplete} onClick={() => void save()}>
              Save mapping
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
