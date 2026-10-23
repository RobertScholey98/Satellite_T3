import type {
  FactoryDefinitionSaveInput,
  FactoryLeadDefinition,
  FactoryTeamDefinition,
  FactoryTeamMemberDraft,
  FactoryWorkerDefinition,
} from "@t3tools/contracts";

/**
 * A team holds copies of the workers and lead it was built from, so editing a worker later never
 * changes a team. These helpers make and check those copies before a team is saved.
 */

// The longest definition name the contracts allow.
const MAX_NAME_LENGTH = 80;

const withSuffix = (name: string, suffix: string) =>
  `${name
    .trim()
    .slice(0, MAX_NAME_LENGTH - suffix.length)
    .trimEnd()}${suffix}`;

/** The name Duplicate starts from. */
export const duplicateDefinitionName = (name: string) => withSuffix(name, " (copy)");

/** A lead delegates to members by name, so a second copy of a worker gets a numbered name. */
export function uniqueMemberName(name: string, taken: ReadonlyArray<string>): string {
  const names = new Set(taken.map((candidate) => candidate.trim()));
  if (!names.has(name.trim())) return name.trim();
  for (let n = 2; ; n += 1) {
    const candidate = withSuffix(name, ` ${n}`);
    if (!names.has(candidate)) return candidate;
  }
}

/** A new member copied from a worker. It has no id until the server derives one from its name. */
export function memberFromWorker(
  worker: FactoryWorkerDefinition,
  members: ReadonlyArray<FactoryTeamMemberDraft>,
): FactoryTeamMemberDraft {
  return {
    name: uniqueMemberName(
      worker.name,
      members.map((member) => member.name),
    ),
    count: 1,
    models: worker.models,
    description: worker.description,
  };
}

/** A team as the editor holds it. A team cannot be saved without a lead copy. */
export interface FactoryTeamDraft {
  readonly name: string;
  readonly useWhen: string;
  readonly workflow: string;
  readonly mayEditProtectedPaths: boolean;
  readonly createdBy: FactoryTeamDefinition["createdBy"];
  readonly lead: FactoryLeadDefinition | null;
  readonly members: ReadonlyArray<FactoryTeamMemberDraft>;
}

export const EMPTY_TEAM_DRAFT: FactoryTeamDraft = {
  name: "",
  useWhen: "",
  workflow: "",
  mayEditProtectedPaths: false,
  createdBy: "user",
  lead: null,
  members: [],
};

/** A duplicate keeps its members' ids: they name files inside the new team's own folder. */
export function teamDraftFrom(team: FactoryTeamDefinition, duplicate: boolean): FactoryTeamDraft {
  return {
    name: duplicate ? duplicateDefinitionName(team.name) : team.name,
    useWhen: team.useWhen,
    workflow: team.workflow,
    mayEditProtectedPaths: team.mayEditProtectedPaths,
    createdBy: duplicate ? "user" : team.createdBy,
    lead: team.lead,
    members: team.members,
  };
}

/** Why the team cannot be saved yet, or null. */
export function teamDraftProblem(draft: FactoryTeamDraft): string | null {
  if (draft.name.trim() === "") return "Enter a name.";
  if (draft.lead === null) return "Choose a lead.";
  if (draft.members.length === 0) return "Add at least one member.";
  const seen = new Set<string>();
  for (const member of draft.members) {
    const name = member.name.trim();
    if (name === "") return "Every member needs a name.";
    if (seen.has(name)) return `Two members are named ${name}. A lead delegates by name.`;
    seen.add(name);
  }
  return null;
}

export function teamSaveInput(
  draft: FactoryTeamDraft & { readonly lead: FactoryLeadDefinition },
  id: string | null,
): FactoryDefinitionSaveInput {
  return {
    kind: "team",
    ...(id === null ? {} : { id }),
    definition: {
      name: draft.name.trim(),
      useWhen: draft.useWhen.trim(),
      workflow: draft.workflow.trim(),
      mayEditProtectedPaths: draft.mayEditProtectedPaths,
      createdBy: draft.createdBy,
      lead: draft.lead,
      members: draft.members.map((member) => ({ ...member, name: member.name.trim() })),
    },
  };
}

/** For example "Lead: Default lead · Implementer ×2, Reviewer · May edit protected paths". */
export function factoryTeamSummary(team: FactoryTeamDefinition): string {
  return [
    `Lead: ${team.lead.name}`,
    team.members
      .map((member) => (member.count === 1 ? member.name : `${member.name} ×${member.count}`))
      .join(", "),
    team.mayEditProtectedPaths ? "May edit protected paths" : null,
    team.createdBy === "manager" ? "Added by manager" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
