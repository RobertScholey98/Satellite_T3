import {
  type FactoryAssignment,
  type FactoryLogEntry,
  type FactoryManager,
  type FactoryProposedChange,
  FactoryLeadDefinition,
  type FactoryModelList,
  type FactoryTeamDefinition,
  FactoryWorkerDefinition,
  type FactoryTeamPreset,
  type FactoryTicketDraft,
  IssueRef,
  type ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The Retro triage column's droppable id; no remote column can have it. */
export const RETRO_TRIAGE_COLUMN_ID = "satellite:retro-triage";

const DRAFT_DRAG_PREFIX = "satellite:draft:";

export const draftDragId = (draftId: string) => `${DRAFT_DRAG_PREFIX}${draftId}`;

/** The draft a dragged card stands for, or null for a remote ticket. */
export function draftIdOfDrag(id: string | number): string | null {
  const value = String(id);
  return value.startsWith(DRAFT_DRAG_PREFIX) ? value.slice(DRAFT_DRAG_PREFIX.length) : null;
}

/** The project's standing manager; a retired one no longer triages or picks up work. */
export function projectManager(
  managers: ReadonlyArray<FactoryManager> | undefined,
  projectId: ProjectId | null,
): FactoryManager | null {
  if (!managers || projectId === null) return null;
  return (
    managers.find((manager) => manager.projectId === projectId && manager.state !== "retired") ??
    null
  );
}

const matchesQuery = (draft: FactoryTicketDraft, query: string) => {
  const needle = query.trim().toLowerCase();
  return needle === "" || `${draft.title} ${draft.body}`.toLowerCase().includes(needle);
};

/**
 * The Retro triage column: the project's pending drafts, then its dismissed ones while the
 * Dismissed filter is on. Approved drafts leave the column; their tickets are on the board.
 */
export function triageColumnDrafts(
  drafts: ReadonlyArray<FactoryTicketDraft> | undefined,
  projectId: ProjectId | null,
  options: { readonly showDismissed: boolean; readonly query: string },
): ReadonlyArray<FactoryTicketDraft> {
  const own = (drafts ?? []).filter(
    (draft) => draft.projectId === projectId && matchesQuery(draft, options.query),
  );
  return [
    ...own.filter((draft) => draft.state === "pending"),
    ...(options.showDismissed ? own.filter((draft) => draft.state === "dismissed") : []),
  ];
}

/** States that take a slot under the concurrency cap; a retro frees its slot. */
const RUNNING_STATES: ReadonlySet<FactoryAssignment["state"]> = new Set([
  "active",
  "blocked",
  "waiting-user",
  "stalled",
]);

export function runningAssignmentCount(
  assignments: ReadonlyArray<FactoryAssignment> | undefined,
  managerId: string,
): number {
  return (assignments ?? []).filter(
    (assignment) => assignment.managerId === managerId && RUNNING_STATES.has(assignment.state),
  ).length;
}

export function managerStatusText(
  manager: Pick<FactoryManager, "state">,
  running: number,
  cap: number | null,
): string {
  switch (manager.state) {
    case "onboarding":
      return "Manager onboarding";
    case "ready":
      return "Manager ready to pick up";
    case "manager-paused":
      return "Manager paused";
    case "project-paused":
      return "Manager and teams paused";
    case "retired":
      return "Manager retired";
    case "active":
      return cap === null
        ? `Manager · ${running} running`
        : `Manager · ${running} of ${cap} running`;
  }
}

const DecisionPayload = Schema.Struct({ issue: IssueRef });
const decodeDecisionPayload = Schema.decodeUnknownOption(DecisionPayload);

const sameTicket = (left: IssueRef, right: Pick<IssueRef, "host" | "repository" | "number">) =>
  left.number === right.number &&
  left.host.toLowerCase() === right.host.toLowerCase() &&
  left.repository.toLowerCase() === right.repository.toLowerCase();

/** The manager's latest pickup or skip of this ticket, from its log read newest first. */
export function latestTicketDecision(
  entries: ReadonlyArray<FactoryLogEntry>,
  issue: Pick<IssueRef, "host" | "repository" | "number">,
): FactoryLogEntry | null {
  return (
    entries.find(
      (entry) =>
        (entry.kind === "pickup" || entry.kind === "skip") &&
        Option.match(decodeDecisionPayload(entry.payload), {
          onNone: () => false,
          onSome: (payload) => sameTicket(payload.issue, issue),
        }),
    ) ?? null
  );
}

const sentence = (text: string) => {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  // "Skipped at 14:02: changes the layout." reads as one sentence; "API" stays as written.
  const lowered = /^[A-Z][a-z]/.test(trimmed)
    ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
    : trimmed;
  return /[.!?]$/.test(lowered) ? lowered : `${lowered}.`;
};

export function decisionSentence(entry: FactoryLogEntry, time: string): string {
  const verb = entry.kind === "skip" ? "Skipped" : "Picked up";
  const reason = sentence(entry.reason);
  return reason === "" ? `${verb} at ${time}.` : `${verb} at ${time}: ${reason}`;
}

/** One line per non-empty line of the text, for acceptance criteria edited as a list. */
export function criteriaFromText(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

const SETTING_LABELS: Record<Extract<FactoryProposedChange, { kind: "setting" }>["key"], string> = {
  pickupGuidance: "Pickup guidance",
  concurrencyCap: "Concurrency cap",
  recoveryAllowance: "Recovery allowance",
  digestIntervalMinutes: "Digest interval (minutes)",
};

const presetText = (preset: FactoryTeamPreset) =>
  [
    `${preset.name}: ${preset.members.map((member) => `${member.count} × ${member.role}`).join(", ")}`,
    preset.useWhen === "" ? null : `Use when: ${preset.useWhen}`,
    preset.workflow === "" ? null : `Workflow: ${preset.workflow}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

/** A model list as the lead's team section words it. */
const modelsText = (list: FactoryModelList) => {
  const named = list.models.map((model) => `${model.driver}/${model.model}`).join(", ");
  if (list.dynamic)
    return named === "" ? "any pool model, picked per task" : `${named} (picked per task)`;
  return named === "" ? "any pool model" : `${named} (in this order)`;
};

const block = (heading: string, text: string) => `${heading}:\n${text.trim() || "(none)"}`;

/**
 * Everything a team file holds, so approving a change shows every field it touches: the lead
 * copy and each member, with their models and text.
 */
const teamText = (team: FactoryTeamDefinition) =>
  [
    [
      `Team: ${team.name}`,
      `Use when: ${team.useWhen || "(none)"}`,
      `May edit protected paths: ${team.mayEditProtectedPaths ? "yes" : "no"}`,
      block("Workflow", team.workflow),
    ].join("\n"),
    [
      `Lead: ${team.lead.name}`,
      `Models: ${modelsText(team.lead.models)}`,
      block("Instructions", team.lead.instructions),
    ].join("\n"),
    ...team.members.map((member) =>
      [
        `Member: ${member.name} × ${member.count}`,
        `Models: ${modelsText(member.models)}`,
        block("Description", member.description),
      ].join("\n"),
    ),
  ].join("\n\n");

const DEFINITION_LABELS = { worker: "Worker", lead: "Lead", manager: "Manager" } as const;

const decodeWorker = Schema.decodeUnknownOption(FactoryWorkerDefinition);
const decodeProtocol = Schema.decodeUnknownOption(FactoryLeadDefinition);

/** A worker, lead or manager definition's name, models and text; anything else as JSON. */
const definitionText = (target: "worker" | "lead" | "manager", value: unknown) => {
  if (target === "worker") {
    const worker = decodeWorker(value);
    return Option.isSome(worker)
      ? [
          `${DEFINITION_LABELS[target]}: ${worker.value.name}`,
          `Models: ${modelsText(worker.value.models)}`,
          block("Description", worker.value.description),
        ].join("\n")
      : valueText(value);
  }
  // A manager definition has the lead's shape: name, models and instructions.
  const protocol = decodeProtocol(value);
  return Option.isSome(protocol)
    ? [
        `${DEFINITION_LABELS[target]}: ${protocol.value.name}`,
        `Models: ${modelsText(protocol.value.models)}`,
        block("Instructions", protocol.value.instructions),
      ].join("\n")
    : valueText(value);
};

const valueText = (value: unknown) =>
  typeof value === "string" ? value || "(empty)" : JSON.stringify(value);

/** What a proposed change replaces and with what, as text for a before and after view. */
export function proposedChangeView(change: FactoryProposedChange): {
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly applicable: boolean;
} {
  switch (change.kind) {
    case "setting":
      return {
        label: SETTING_LABELS[change.key],
        before: valueText(change.before),
        after: valueText(change.after),
        applicable: true,
      };
    // Presets are retired: teams live in the factory config, so this can no longer apply.
    case "preset":
      return {
        label: change.before === null ? "New team preset" : `Team preset ${change.before.name}`,
        before: change.before === null ? "(none)" : presetText(change.before),
        after: presetText(change.after),
        applicable: false,
      };
    case "team":
      return {
        label: change.before === null ? "New team" : `Team ${change.before.name}`,
        before: change.before === null ? "(none)" : teamText(change.before),
        after: teamText(change.after),
        applicable: true,
      };
    case "definition":
      return {
        label:
          change.before === null
            ? `New ${DEFINITION_LABELS[change.target].toLowerCase()}`
            : DEFINITION_LABELS[change.target],
        before: change.before === null ? "(none)" : definitionText(change.target, change.before),
        after: definitionText(change.target, change.after),
        applicable: true,
      };
    case "role-skill":
      return {
        label: `The ${change.role} role's skill`,
        before: change.before ?? "(built-in)",
        after: change.after,
        applicable: false,
      };
  }
}

/** The finding as a message to the manager, so the user can start the conversation from it. */
export function discussPrompt(draft: FactoryTicketDraft): string {
  const criteria = draft.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n");
  return [
    `About your retro finding "${draft.title}":`,
    draft.body,
    criteria === "" ? null : `Acceptance criteria:\n${criteria}`,
  ]
    .filter((part) => part !== null && part !== "")
    .join("\n\n");
}
