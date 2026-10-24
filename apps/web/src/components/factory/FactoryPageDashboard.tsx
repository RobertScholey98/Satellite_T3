import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FactoryComplexity,
  FactoryManager,
  FactoryStatsResult,
  ProjectId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn, randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { UsageShareBar } from "../usage/UsageShareBar";
import {
  factoryEnvironment,
  factoryErrorMessage,
  unwrapFactoryResult,
  useFactoryAssignments,
  useFactoryDrafts,
  useFactoryManagers,
} from "./factoryState";
import {
  type FactoryTeamRow,
  factoryAssignmentTokens,
  factoryRoleTokenSegments,
  factoryStatsSinceDay,
  factoryTeamRows,
  formatFactoryCost,
  formatFactoryDuration,
  formatFactoryMean,
  formatFactoryTokens,
} from "./FactoryPageStats";

function failureMessage<A, E>(result: AtomCommandResult<A, E>): string | null {
  try {
    unwrapFactoryResult(result);
    return null;
  } catch (failure) {
    return factoryErrorMessage(failure);
  }
}

const STATE_BADGES: Record<
  Exclude<FactoryManager["state"], "retired">,
  { readonly label: string; readonly variant: "info" | "success" | "warning" }
> = {
  onboarding: { label: "Onboarding", variant: "info" },
  ready: { label: "Ready", variant: "info" },
  active: { label: "Active", variant: "success" },
  "manager-paused": { label: "Paused", variant: "warning" },
  "project-paused": { label: "Paused with teams", variant: "warning" },
};

/** How the factory is doing on one environment: managers, triage waiting on you, and teams. */
export function FactoryPageDashboard({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTitle = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.title ?? "Unknown project";
  return (
    <div className="flex flex-col gap-8">
      <FactoryManagersSection environmentId={environmentId} projectTitle={projectTitle} />
      <FactoryTriageSection environmentId={environmentId} projectTitle={projectTitle} />
      <FactoryTeamsStats
        environmentId={environmentId}
        projects={projects.map((project) => ({ id: project.id, title: project.title }))}
        projectTitle={projectTitle}
      />
    </div>
  );
}

function FactoryManagersSection({
  environmentId,
  projectTitle,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: (projectId: string) => string;
}) {
  const managers = useFactoryManagers(environmentId)?.filter(
    (manager) => manager.state !== "retired",
  );
  const getConfig = useAtomCommand(factoryEnvironment.getConfig, { reportFailure: false });
  const projectKey = [...new Set((managers ?? []).map((manager) => manager.projectId))]
    .toSorted()
    .join("\n");
  const [caps, setCaps] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!projectKey) return;
    let current = true;
    const projectIds = projectKey.split("\n") as ProjectId[];
    void Promise.all(
      projectIds.map((projectId) =>
        getConfig({ environmentId, input: { projectId } }).then((result) =>
          result._tag === "Success"
            ? ([projectId, result.value.effective.concurrencyCap] as const)
            : null,
        ),
      ),
    ).then((entries) => {
      if (current)
        setCaps(new Map(entries.filter((entry): entry is [ProjectId, number] => entry !== null)));
    });
    return () => {
      current = false;
    };
  }, [environmentId, getConfig, projectKey]);

  const canPause = useAtomValue(factoryEnvironment.pauseManager.permissionAtom(environmentId));
  const canResume = useAtomValue(factoryEnvironment.resumeManager.permissionAtom(environmentId));
  const canRetire = useAtomValue(factoryEnvironment.retireManager.permissionAtom(environmentId));
  const pause = useAtomCommand(factoryEnvironment.pauseManager, { reportFailure: false });
  const resume = useAtomCommand(factoryEnvironment.resumeManager, { reportFailure: false });
  const retire = useAtomCommand(factoryEnvironment.retireManager, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (
    manager: FactoryManager,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(manager.id);
    setError(null);
    const result = await action();
    setBusy(null);
    setError(failureMessage(result));
  };
  const confirmRetire = async (manager: FactoryManager) => {
    const message = `Retire ${manager.name}?\nThe project can get a new manager afterwards.`;
    const confirmed = await (requestConfirmDialog(message, { variant: "destructive" }) ??
      Promise.resolve(window.confirm(message)));
    if (!confirmed) return;
    await run(manager, () =>
      retire({ environmentId, input: { requestId: randomUUID(), managerId: manager.id } }),
    );
  };

  return (
    <SettingsSection title="Managers">
      {error ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive sm:px-4">
          {error}
        </p>
      ) : null}
      {managers === undefined ? (
        <SettingsRow title="Loading managers…" />
      ) : managers.length === 0 ? (
        <SettingsRow
          title="No managers yet"
          description="Start a manager from a project's thread list to let it pick up tickets."
        />
      ) : (
        managers.map((manager) => {
          const state = STATE_BADGES[manager.state as keyof typeof STATE_BADGES];
          const cap = caps.get(manager.projectId);
          const paused = manager.state === "manager-paused" || manager.state === "project-paused";
          return (
            <SettingsRow
              key={manager.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">{manager.name}</span>
                  {state ? (
                    <Badge size="sm" variant={state.variant}>
                      {state.label}
                    </Badge>
                  ) : null}
                </span>
              }
              description={[
                projectTitle(manager.projectId),
                cap === undefined
                  ? `${manager.activeAssignments} running`
                  : `${manager.activeAssignments} of ${cap} running`,
                manager.waitingOnYou > 0 ? `${manager.waitingOnYou} waiting on you` : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
              control={
                <>
                  {manager.threadId ? (
                    <Button
                      size="xs"
                      variant="outline"
                      render={
                        <Link
                          to="/$environmentId/$threadId"
                          params={{ environmentId, threadId: manager.threadId }}
                        />
                      }
                    >
                      Open workspace
                    </Button>
                  ) : null}
                  <Menu>
                    <MenuTrigger
                      aria-label={`${manager.name} actions`}
                      disabled={busy === manager.id}
                      render={<Button size="icon-xs" variant="ghost-muted" />}
                    >
                      <MoreHorizontalIcon className="size-3.5" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      {paused ? (
                        <MenuItem
                          disabled={!canResume}
                          onClick={() =>
                            void run(manager, () =>
                              resume({
                                environmentId,
                                input: { requestId: randomUUID(), managerId: manager.id },
                              }),
                            )
                          }
                        >
                          Resume
                        </MenuItem>
                      ) : null}
                      {manager.state === "active" ||
                      manager.state === "ready" ||
                      manager.state === "onboarding" ? (
                        <MenuItem
                          disabled={!canPause}
                          onClick={() =>
                            void run(manager, () =>
                              pause({
                                environmentId,
                                input: {
                                  requestId: randomUUID(),
                                  managerId: manager.id,
                                  scope: "manager",
                                },
                              }),
                            )
                          }
                        >
                          Pause manager
                        </MenuItem>
                      ) : null}
                      {manager.state !== "project-paused" ? (
                        <MenuItem
                          disabled={!canPause}
                          onClick={() =>
                            void run(manager, () =>
                              pause({
                                environmentId,
                                input: {
                                  requestId: randomUUID(),
                                  managerId: manager.id,
                                  scope: "project",
                                },
                              }),
                            )
                          }
                        >
                          Pause manager and teams
                        </MenuItem>
                      ) : null}
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        disabled={!canRetire || manager.activeAssignments > 0}
                        onClick={() => void confirmRetire(manager)}
                      >
                        <span className="flex flex-col">
                          <span>Retire</span>
                          {manager.activeAssignments > 0 ? (
                            <span className="text-xs text-muted-foreground">
                              Finish or cancel its assignments first
                            </span>
                          ) : null}
                        </span>
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </>
              }
            />
          );
        })
      )}
    </SettingsSection>
  );
}

function FactoryTriageSection({
  environmentId,
  projectTitle,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: (projectId: string) => string;
}) {
  const drafts = useFactoryDrafts(environmentId);
  const counts = new Map<ProjectId, number>();
  for (const draft of drafts ?? []) {
    if (draft.state === "pending")
      counts.set(draft.projectId, (counts.get(draft.projectId) ?? 0) + 1);
  }
  return (
    <SettingsSection title="Triage">
      {drafts === undefined ? (
        <SettingsRow title="Loading triage…" />
      ) : counts.size === 0 ? (
        <SettingsRow
          title="Nothing to triage"
          description="Tickets managers draft in their retros wait here for you."
        />
      ) : (
        [...counts].map(([projectId, count]) => (
          <SettingsRow
            key={projectId}
            title={projectTitle(projectId)}
            description={count === 1 ? "1 Retro triage card" : `${count} Retro triage cards`}
            control={
              <Button
                size="xs"
                variant="outline"
                render={<Link to="/issues" search={{ environmentId, projectId, mode: "board" }} />}
              >
                Open board
              </Button>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

const PERIODS = [
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "all", label: "All time", days: null },
] as const;

const ALL = "all";

function FactoryTeamsStats({
  environmentId,
  projects,
  projectTitle,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly projectTitle: (projectId: string) => string;
}) {
  const getStats = useAtomCommand(factoryEnvironment.getStats, { reportFailure: false });
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [complexity, setComplexity] = useState<FactoryComplexity | null>(null);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["value"]>("30");
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const filterKey = [projectId ?? "", complexity ?? "", period].join("\n");
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly result: FactoryStatsResult;
  } | null>(null);
  const [error, setError] = useState<{ readonly key: string; readonly message: string } | null>(
    null,
  );
  useEffect(() => {
    let current = true;
    const days = PERIODS.find((option) => option.value === period)?.days ?? null;
    const sinceDay = factoryStatsSinceDay(days, Date.now());
    void getStats({
      environmentId,
      input: {
        ...(projectId === null ? {} : { projectId }),
        ...(complexity === null ? {} : { complexity }),
        ...(sinceDay === undefined ? {} : { sinceDay }),
      },
    }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") setLoaded({ key: filterKey, result: result.value });
      else setError({ key: filterKey, message: failureMessage(result) ?? "Cancelled." });
    });
    return () => {
      current = false;
    };
  }, [complexity, environmentId, filterKey, getStats, period, projectId]);

  const result = loaded?.key === filterKey ? loaded.result : null;
  const rows = result === null ? [] : factoryTeamRows(result);
  const selected = rows.find((row) => row.team === selectedTeam) ?? null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 sm:px-4">
        <h2 className="text-sm font-normal text-foreground/70">Teams</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={projectId ?? ALL}
            onValueChange={(next) => setProjectId(next === ALL ? null : (next as ProjectId))}
          >
            <SelectTrigger size="xs" aria-label="Project">
              <SelectValue>
                {(value: string) => (value === ALL ? "All projects" : projectTitle(value))}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={ALL}>All projects</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={complexity ?? ALL}
            onValueChange={(next) =>
              setComplexity(next === ALL ? null : (next as FactoryComplexity))
            }
          >
            <SelectTrigger size="xs" aria-label="Complexity">
              <SelectValue>
                {(value: string) =>
                  value === ALL ? "Any size" : `${value[0]!.toUpperCase()}${value.slice(1)}`
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={ALL}>Any size</SelectItem>
              <SelectItem value="small">Small</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="large">Large</SelectItem>
            </SelectPopup>
          </Select>
          <ToggleGroup
            aria-label="Period"
            variant="segmented"
            value={[period]}
            onValueChange={(next) => {
              const value = PERIODS.find((option) => option.value === next[0]);
              if (value) setPeriod(value.value);
            }}
          >
            {PERIODS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      </div>
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Medians per finished assignment; recoveries and review rounds are averages. Token totals
        across providers are approximate.
      </p>
      {error?.key === filterKey ? (
        <p role="alert" className="px-3 text-sm text-destructive sm:px-4">
          {error.message}
        </p>
      ) : null}
      <div
        className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        role="region"
        aria-label="Team stats"
        tabIndex={0}
      >
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-border text-right text-xs text-muted-foreground">
              <th className="w-full py-2 text-left font-normal">Team</th>
              <th className="py-2 pl-4 font-normal">Tasks</th>
              <th className="py-2 pl-4 font-normal">Agent time</th>
              <th className="py-2 pl-4 font-normal">Wall time</th>
              <th className="py-2 pl-4 font-normal">Tokens</th>
              <th className="py-2 pl-4 font-normal">Cost</th>
              <th className="py-2 pl-4 font-normal">Waiting on you</th>
              <th className="py-2 pl-4 font-normal">Recoveries</th>
              <th className="py-2 pl-4 font-normal">Review rounds</th>
            </tr>
          </thead>
          <tbody>
            {result === null ? (
              <tr>
                <td colSpan={9} className="py-6 text-center text-muted-foreground">
                  {error?.key === filterKey ? "Stats are unavailable." : "Loading…"}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-6 text-center text-muted-foreground">
                  No finished assignments in this window.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.team}
                  className={cn(
                    "relative border-b border-border/50 text-right text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50",
                    row.team === selected?.team && "bg-muted/50",
                  )}
                >
                  <td className="py-2.5 text-left">
                    <button
                      type="button"
                      aria-pressed={row.team === selected?.team}
                      onClick={() => setSelectedTeam(row.team === selected?.team ? null : row.team)}
                      className="text-left text-foreground outline-none after:absolute after:inset-0"
                    >
                      {row.label}
                    </button>
                  </td>
                  <td className="py-2.5 pl-4 text-foreground">{row.tasks}</td>
                  <td className="py-2.5 pl-4">{formatFactoryDuration(row.medianAgentMs)}</td>
                  <td className="py-2.5 pl-4">{formatFactoryDuration(row.medianWallMs)}</td>
                  <td className="py-2.5 pl-4">{formatFactoryTokens(row.medianTokens)}</td>
                  <td className="py-2.5 pl-4">{formatFactoryCost(row.medianCostUsd)}</td>
                  <td className="py-2.5 pl-4">{formatFactoryDuration(row.medianWaitingMs)}</td>
                  <td className="py-2.5 pl-4">{formatFactoryMean(row.meanRecoveries)}</td>
                  <td className="py-2.5 pl-4">{formatFactoryMean(row.meanReviewRounds)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {selected ? (
        <FactoryTeamDetail
          environmentId={environmentId}
          row={selected}
          projectTitle={projectTitle}
        />
      ) : null}
    </section>
  );
}

function FactoryTeamDetail({
  environmentId,
  row,
  projectTitle,
}: {
  readonly environmentId: EnvironmentId;
  readonly row: FactoryTeamRow;
  readonly projectTitle: (projectId: string) => string;
}) {
  const assignments = useFactoryAssignments(environmentId);
  return (
    <div className="flex flex-col gap-4 px-3 sm:px-4">
      <UsageShareBar
        label={`${row.label}: tokens by role`}
        segments={factoryRoleTokenSegments(row.assignments)}
        format={formatFactoryTokens}
        aside={
          <span className="text-xs text-muted-foreground">
            {row.completed} completed · {row.cancelled} cancelled · {row.goodFit} good fit ·{" "}
            {row.poorFit} poor fit
          </span>
        }
      />
      <table className="w-full text-sm whitespace-nowrap">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="w-full py-2 text-left font-normal">Assignment</th>
            <th className="py-2 pl-4 text-left font-normal">Outcome</th>
            <th className="py-2 pl-4 text-left font-normal">Team verdict</th>
            <th className="py-2 pl-4 font-normal">Wall time</th>
            <th className="py-2 pl-4 font-normal">Tokens</th>
            <th className="py-2 pl-4 font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {row.assignments.map((assignment) => {
            const live = assignments?.find((candidate) => candidate.id === assignment.assignmentId);
            return (
              <tr
                key={assignment.assignmentId}
                className="border-b border-border/50 text-right text-muted-foreground tabular-nums"
              >
                <td className="py-2 text-left whitespace-normal text-foreground">
                  {live?.title ??
                    `${projectTitle(assignment.projectId)} · ${assignment.complexity}`}
                  <span className="block text-xs text-muted-foreground">
                    Ended {new Date(assignment.endedAt).toLocaleDateString()}
                  </span>
                </td>
                <td className="py-2 pl-4 text-left">
                  <Badge
                    size="sm"
                    variant={assignment.outcome === "completed" ? "success" : "secondary"}
                  >
                    {assignment.outcome === "completed" ? "Completed" : "Cancelled"}
                  </Badge>
                </td>
                <td className="py-2 pl-4 text-left">
                  {assignment.teamVerdict === null
                    ? "None"
                    : assignment.teamVerdict === "good"
                      ? "Good fit"
                      : "Poor fit"}
                </td>
                <td className="py-2 pl-4">{formatFactoryDuration(assignment.wallMs)}</td>
                <td className="py-2 pl-4">
                  {formatFactoryTokens(factoryAssignmentTokens(assignment))}
                </td>
                <td className="py-2 pl-4">{formatFactoryCost(assignment.costUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
