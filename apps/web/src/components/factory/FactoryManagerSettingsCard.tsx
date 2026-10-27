import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  FACTORY_CONCURRENCY_CAP_MAX,
  type FactoryManager,
  type FactoryOnboardingResult,
  type FactoryPickupColumn,
  issueReadyColumnIds,
  type ProjectId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  GaugeIcon,
  InboxIcon,
  type LucideIcon,
  ScrollTextIcon,
  ShieldIcon,
  TargetIcon,
  UsersRoundIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { issuesEnvironment } from "../work/issuesState";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useFactoryDefinitions } from "./factoryDefinitionsState";
import {
  effectiveManagerCap,
  managerSettingsDirty,
  managerSettingsDraft,
  managerSettingsProblem,
  managerSettingsResult,
  toggleSettingsColumn,
  type ManagerSettingsDraft,
} from "./factoryManagerSettings.logic";
import { sameColumn } from "./factoryOnboardingCard.logic";
import {
  factoryEnvironment,
  factoryErrorMessage,
  unwrapFactoryResult,
  useFactoryEnvironmentCap,
  useFactoryManagers,
} from "./factoryState";
import { FACTORY_CARD_CLASS } from "./FactoryThreadStack";
import { takesAssignmentSlot } from "./factoryWorkspaceLogic";
import { useFactoryWorkspaceFeed } from "./factoryWorkspaceState";

interface ReadyBoard {
  readonly boardId: string;
  readonly title: string;
  readonly readyColumns: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

/** The approved manager's onboarding result, to read and edit; nothing before approval. */
export function FactoryManagerSettingsCard(props: {
  readonly environmentId: EnvironmentId;
  readonly managerId: string;
}) {
  const manager = useFactoryManagers(props.environmentId)?.find(
    (entry) => entry.id === props.managerId,
  );
  if (manager === undefined || manager.onboardingResult === null || manager.state === "retired")
    return null;
  return (
    <ManagerSettings
      environmentId={props.environmentId}
      manager={manager}
      result={manager.onboardingResult}
    />
  );
}

function ManagerSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly manager: FactoryManager;
  readonly result: FactoryOnboardingResult;
}) {
  const { environmentId, manager, result } = props;
  const canEdit = useAtomValue(factoryEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(factoryEnvironment.updateSettings, {
    reportFailure: false,
  });
  const definitions = useFactoryDefinitions(environmentId).view;
  const [draft, setDraft] = useState<ManagerSettingsDraft | null>(null);
  // The version the form was opened at, so a save over a change made meanwhile is refused.
  const [openedAt, setOpenedAt] = useState(manager.updatedAt);
  const [newPath, setNewPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal lands above Save at the bottom of a column that may scroll; show both.
  const actions = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Scroll once the refusal has rendered, so the new message and Save are both in view.
  useEffect(() => {
    if (error !== null) actions.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  // Whole boards are read only to edit pickup; saved columns carry their titles.
  const boards = useReadyBoards(environmentId, manager.projectId, draft !== null);
  const environmentCap = useFactoryEnvironmentCap(environmentId);
  // Counted as the Factory row counts them, so the two agree.
  const running = (useFactoryWorkspaceFeed(environmentId)?.assignments ?? []).filter(
    (assignment) => assignment.managerId === manager.id && takesAssignmentSlot(assignment),
  ).length;

  const paused = manager.state === "manager-paused" || manager.state === "project-paused";
  const teams = definitions?.teams ?? [];
  const columnLabel = (column: FactoryPickupColumn) =>
    column.title === undefined
      ? column.columnId
      : column.boardTitle === undefined
        ? column.title
        : `${column.title} on ${column.boardTitle}`;
  const shown = draft === null ? result : managerSettingsResult(result, draft);
  const cap = environmentCap === undefined ? null : effectiveManagerCap(shown, environmentCap);
  const capText =
    cap === null
      ? String(shown.concurrencyCap)
      : `Runs up to ${cap.cap} at once${cap.limitedByEnvironment ? `; the environment's cap of ${cap.cap} is the lower one.` : "."}`;
  const capNote =
    cap === null ? null : (
      <p className="text-xs text-muted-foreground">
        {capText}
        {draft !== null && running > shown.concurrencyCap
          ? ` ${running} are running now: lowering the cap cancels none of them, and new work waits for room.`
          : null}
      </p>
    );

  const edit = () => {
    setError(null);
    setNewPath("");
    setOpenedAt(manager.updatedAt);
    setDraft(managerSettingsDraft(result));
  };
  const save = async (next: ManagerSettingsDraft) => {
    setSaving(true);
    setError(null);
    const saved = await updateSettings({
      environmentId,
      input: {
        requestId: randomUUID(),
        expectedUpdatedAt: openedAt,
        managerId: manager.id,
        result: managerSettingsResult(result, next),
      },
    })
      .then(unwrapFactoryResult)
      .catch((failure: unknown) => {
        setError(factoryErrorMessage(failure));
        return null;
      });
    setSaving(false);
    if (saved !== null) setDraft(null);
  };

  if (draft === null) {
    const pickupLabels =
      result.pickup.labels.length === 0
        ? "Any label"
        : `Labels: ${result.pickup.labels.join(", ")}`;
    return (
      <section aria-label="Manager settings" className={`${FACTORY_CARD_CLASS} p-2`}>
        <CardHeading title="Settings">
          <Button variant="outline" size="xs" disabled={!canEdit} onClick={edit}>
            Edit
          </Button>
        </CardHeading>
        {paused ? (
          <p className="px-2.5 pb-1 text-xs text-muted-foreground">
            Paused. Changes you save apply when the manager resumes.
          </p>
        ) : null}
        <dl className="m-0">
          {result.purpose === "" ? null : (
            <Row icon={TargetIcon} term="Purpose" detail={result.purpose} />
          )}
          <Row
            icon={InboxIcon}
            term="Pickup"
            detail={
              result.pickup.enabled
                ? [
                    result.pickup.columns.map(columnLabel).join(", "),
                    pickupLabels,
                    result.pickup.guidance,
                  ]
                    .filter((part) => part !== "")
                    .join(" · ")
                : "Off"
            }
          />
          <Row icon={GaugeIcon} term="Concurrency cap" detail={capText} />
          <Row
            icon={UsersRoundIcon}
            term="Teams"
            detail={
              result.teamIds.length === 0
                ? "All teams"
                : result.teamIds
                    .map((id) => teams.find((team) => team.id === id)?.name ?? id)
                    .join(", ")
            }
          />
        </dl>
        {/* The lists open in place, so they sit apart from the settings, as the details card's groups do. */}
        <div className="-mx-2 mt-1 border-t border-border/65 px-2 pt-1">
          {result.controlPaths.length === 0 ? (
            <dl className="m-0">
              <Row icon={ShieldIcon} term="Protected paths" detail="None" />
            </dl>
          ) : (
            <Disclosure
              icon={ShieldIcon}
              label="Protected paths"
              count={result.controlPaths.length}
            >
              <ul className="m-0 list-none py-1 ps-9 pe-2.5">
                {result.controlPaths.map((entry) => (
                  <li key={entry.path} className="py-0.5 text-xs break-words">
                    <code>{breakAtSlashes(entry.path)}</code>
                    {entry.reason === "" ? null : (
                      <span className="text-muted-foreground"> · {entry.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
          {result.rules.length === 0 ? null : (
            <Disclosure icon={ScrollTextIcon} label="Project rules" count={result.rules.length}>
              <dl className="m-0 divide-y divide-border/65 ps-9 pe-2.5">
                {result.rules.map((rule) => (
                  <div key={rule.id} className="space-y-0.5 py-2">
                    <dt className="text-sm font-medium text-foreground/80">{rule.question}</dt>
                    <dd className="m-0 text-xs text-muted-foreground">{rule.answer}</dd>
                  </div>
                ))}
              </dl>
            </Disclosure>
          )}
        </div>
      </section>
    );
  }

  const update = (next: ManagerSettingsDraft) => {
    setError(null);
    setDraft(next);
  };
  const problem = managerSettingsProblem(result, draft);
  const dirty = managerSettingsDirty(result, draft);
  const disabled = saving || !canEdit;
  const addPath = () => {
    const path = newPath.trim();
    if (path === "" || draft.controlPaths.some((entry) => entry.path === path)) return;
    update({ ...draft, controlPaths: [...draft.controlPaths, { path, reason: "" }] });
    setNewPath("");
  };
  return (
    <section aria-label="Manager settings" className={`${FACTORY_CARD_CLASS} space-y-3 p-3.5`}>
      <h3 className="text-sm font-semibold select-none">Settings</h3>
      <Field title="Purpose">
        <Textarea
          aria-label="Purpose"
          size="sm"
          rows={2}
          disabled={disabled}
          value={draft.purpose}
          onChange={(event) => update({ ...draft, purpose: event.target.value })}
        />
      </Field>
      <Field title="Pickup">
        <Label>
          <Switch
            size="sm"
            checked={draft.pickupEnabled}
            disabled={disabled}
            onCheckedChange={(checked) => update({ ...draft, pickupEnabled: checked })}
          />
          Pick up tickets on its own
        </Label>
        {draft.pickupEnabled ? (
          <>
            {boards === null ? (
              <p className="text-2xs text-muted-foreground">Reading the boards…</p>
            ) : boards.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                No board has a Ready column; map one in Issues.
              </p>
            ) : (
              boards.map((board) => (
                <fieldset key={board.boardId} className="space-y-1">
                  <legend className="text-2xs">Ready columns on {board.title}</legend>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {board.readyColumns.map((column) => {
                      const ref = {
                        boardId: board.boardId,
                        columnId: column.id,
                        title: column.title,
                        boardTitle: board.title,
                      };
                      return (
                        <Label key={column.id}>
                          <Checkbox
                            checked={draft.columns.some((entry) => sameColumn(entry, ref))}
                            disabled={disabled}
                            onCheckedChange={(checked) =>
                              update(toggleSettingsColumn(draft, ref, checked === true))
                            }
                          />
                          {column.title}
                        </Label>
                      );
                    })}
                  </div>
                </fieldset>
              ))
            )}
            <Input
              aria-label="Pickup labels"
              size="sm"
              placeholder="Labels, comma-separated; empty for any"
              disabled={disabled}
              value={draft.labels}
              onChange={(event) => update({ ...draft, labels: event.target.value })}
            />
            <Textarea
              aria-label="Pickup guidance"
              size="sm"
              rows={2}
              disabled={disabled}
              value={draft.guidance}
              onChange={(event) => update({ ...draft, guidance: event.target.value })}
            />
          </>
        ) : null}
      </Field>
      <Field title="Concurrency cap">
        <Input
          aria-label="Concurrency cap"
          size="sm"
          type="number"
          min={1}
          max={FACTORY_CONCURRENCY_CAP_MAX}
          disabled={disabled}
          value={draft.concurrencyCap}
          onChange={(event) => update({ ...draft, concurrencyCap: event.target.value })}
        />
        {capNote}
      </Field>
      <Field title="Teams">
        <p className="text-2xs text-muted-foreground">None ticked means every team.</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {teams.map((team) => (
            <Label key={team.id}>
              <Checkbox
                checked={draft.teamIds.includes(team.id)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  update({
                    ...draft,
                    teamIds:
                      checked === true
                        ? [...draft.teamIds, team.id]
                        : draft.teamIds.filter((id) => id !== team.id),
                  })
                }
              />
              {team.name}
            </Label>
          ))}
        </div>
      </Field>
      <Field title="Protected paths">
        {draft.controlPaths.map((entry) => (
          <div key={entry.path} className="flex items-start gap-1">
            <p className="min-w-0 flex-1 text-xs">
              <code className="break-all">{entry.path}</code>
              {entry.reason === "" ? null : (
                <span className="block text-2xs text-muted-foreground">{entry.reason}</span>
              )}
            </p>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${entry.path}`}
              disabled={disabled}
              onClick={() =>
                update({
                  ...draft,
                  controlPaths: draft.controlPaths.filter((current) => current !== entry),
                })
              }
            >
              <XIcon />
            </Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Input
            aria-label="New protected path"
            size="sm"
            placeholder="docs/**"
            disabled={disabled}
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addPath();
            }}
          />
          <Button variant="outline" size="sm" disabled={disabled} onClick={addPath}>
            Add
          </Button>
        </div>
      </Field>
      {result.rules.length === 0 ? null : (
        <Field title="Rules">
          {result.rules.map((rule) => (
            <div key={rule.id} className="space-y-1">
              <p className="text-xs">{rule.question}</p>
              <Input
                aria-label={rule.question}
                size="sm"
                disabled={disabled}
                value={draft.answers[rule.id] ?? ""}
                onChange={(event) =>
                  update({ ...draft, answers: { ...draft.answers, [rule.id]: event.target.value } })
                }
              />
            </div>
          ))}
        </Field>
      )}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      <div ref={actions} className="flex items-center justify-end gap-2">
        {problem === null ? null : (
          <p className="min-w-0 flex-1 text-2xs text-muted-foreground">{problem}</p>
        )}
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={disabled || !dirty || problem !== null}
          onClick={() => void save(draft)}
        >
          {saving ? <Spinner size="xs" /> : null}
          Save
        </Button>
      </div>
    </section>
  );
}

/** Lets a long path wrap after a slash rather than mid-name. */
function breakAtSlashes(path: string): ReactNode {
  const pieces: ReactNode[] = [];
  let prefix: string | null = null;
  for (const part of path.split("/")) {
    if (prefix !== null) pieces.push(<wbr key={prefix} />);
    pieces.push(prefix === null ? part : `/${part}`);
    prefix = prefix === null ? part : `${prefix}/${part}`;
  }
  return pieces;
}

/** The card's title row, on the details card's text column. */
function CardHeading(props: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2 px-2.5">
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold select-none">{props.title}</h3>
      {props.children}
    </div>
  );
}

/** A setting on the details card's row anatomy: icon, label, and its value below. */
function Row(props: { readonly icon: LucideIcon; readonly term: string; readonly detail: string }) {
  const Icon = props.icon;
  return (
    <div className="flex gap-2.5 px-2.5 py-1.5">
      <Icon aria-hidden className={`${THREAD_DETAILS_PANEL_ICON_CLASS} mt-px`} />
      <div className="min-w-0 flex-1">
        <dt className="text-sm font-medium text-foreground/80">{props.term}</dt>
        <dd className="m-0 text-xs text-muted-foreground">{props.detail}</dd>
      </div>
    </div>
  );
}

/** A long setting folded to a count, opened in place like the details card's agent groups. */
function Disclosure(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Icon = props.icon;
  return (
    <div>
      <ThreadDetailsControl aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
          {props.count}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={`${THREAD_DETAILS_PANEL_CHEVRON_CLASS} ${open ? "" : "-rotate-90"}`}
        />
      </ThreadDetailsControl>
      {open ? props.children : null}
    </div>
  );
}

function Field(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-medium text-foreground/80">{props.title}</h4>
      {props.children}
    </div>
  );
}

/** The project's mapped boards with their Ready columns, read once `wanted`; null while reading. */
function useReadyBoards(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  wanted: boolean,
): ReadonlyArray<ReadyBoard> | null {
  const listBoards = useAtomCommand(issuesEnvironment.listBoards, { reportFailure: false });
  const openBoard = useAtomCommand(issuesEnvironment.openBoard, { reportFailure: false });
  const [boards, setBoards] = useState<ReadonlyArray<ReadyBoard> | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Fetch connected boards and their ready columns while editing pickup, dropping replies that arrive after the inputs change or unmount.
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    void (async () => {
      const listed = await listBoards({ environmentId, input: { projectId, connectedOnly: true } });
      if (listed._tag !== "Success") return current ? setBoards([]) : undefined;
      const read: ReadyBoard[] = [];
      for (const summary of listed.value) {
        if (summary.mapping === null) continue;
        const opened = await openBoard({
          environmentId,
          input: { projectId, boardId: summary.id },
        });
        if (opened._tag !== "Success") continue;
        const ready = new Set(issueReadyColumnIds(opened.value.board.mapping ?? summary.mapping));
        read.push({
          boardId: summary.id,
          title: opened.value.board.title,
          readyColumns: opened.value.columns.filter((column) => ready.has(column.id)),
        });
      }
      if (current) setBoards(read);
    })();
    return () => {
      current = false;
    };
  }, [environmentId, projectId, wanted, listBoards, openBoard]);
  return boards;
}
