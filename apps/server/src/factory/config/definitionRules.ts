import type {
  FactoryConfigProblem,
  FactoryCreateTeamFromDefinitionsInput,
  FactoryDefinitionsView,
  FactoryModelList,
  FactoryModelRef,
  FactoryTeamDefinition,
  FactoryTeamMemberDefinition,
} from "@t3tools/contracts";

import { definitionIdFromName } from "./definitionFiles.ts";

/**
 * The rules a definition must meet before it is written, whoever writes it: the manager, an
 * applied draft, or Settings. Each returns a message the writer can act on, or null.
 */

const modelRefKey = (ref: FactoryModelRef) => `${ref.driver}/${ref.model}`;

/** The pool is the factory-wide allow-list, compared by driver and model. */
const modelOutsidePool = (
  pool: ReadonlyArray<FactoryModelRef>,
  lists: ReadonlyArray<{ readonly owner: string; readonly list: FactoryModelList }>,
): string | null => {
  const allowed = new Set(pool.map(modelRefKey));
  for (const { owner, list } of lists) {
    const missing = list.models.find((model) => !allowed.has(modelRefKey(model)));
    if (missing !== undefined)
      return `${modelRefKey(missing)} is not in the model pool. Add it to the pool first, or remove it from ${owner}.`;
  }
  return null;
};

/**
 * A lead delegates by member name, regardless of case, so a team with two names that differ only
 * in case could not be staffed.
 */
export const teamProblem = (
  team: Pick<FactoryTeamDefinition, "lead" | "members">,
  pool: ReadonlyArray<FactoryModelRef>,
): string | null => {
  if (team.members.length === 0) return "A team needs at least one member.";
  const names = new Set<string>();
  for (const member of team.members) {
    const key = member.name.toLowerCase();
    if (names.has(key))
      return `Two members are named "${member.name}". Give each member its own name.`;
    names.add(key);
  }
  return modelOutsidePool(pool, [
    { owner: "the team's lead", list: team.lead.models },
    ...team.members.map((member) => ({
      owner: `the member "${member.name}"`,
      list: member.models,
    })),
  ]);
};

/** A worker, lead or manager definition lists only pool models. */
export const definitionProblem = (
  kind: "worker" | "lead" | "manager",
  definition: { readonly models: FactoryModelList },
  pool: ReadonlyArray<FactoryModelRef>,
): string | null => modelOutsidePool(pool, [{ owner: `this ${kind}`, list: definition.models }]);

const KIND_DIRECTORY = { worker: "workers", lead: "leads", manager: "managers", team: "teams" };

/**
 * Ids in use for a kind, counting files that failed to decode, so a new definition never takes a
 * broken file's id and overwrites it.
 */
export const takenDefinitionIds = (
  view: Pick<FactoryDefinitionsView, "workers" | "leads" | "managers" | "teams"> & {
    readonly problems: ReadonlyArray<FactoryConfigProblem>;
  },
  kind: keyof typeof KIND_DIRECTORY,
): Set<string> => {
  const loaded = {
    worker: view.workers,
    lead: view.leads,
    manager: view.managers,
    team: view.teams,
  };
  const ids = new Set<string>(loaded[kind].map((definition) => definition.id));
  const prefix = `${KIND_DIRECTORY[kind]}/`;
  for (const problem of view.problems) {
    if (!problem.path.startsWith(prefix)) continue;
    const id = problem.path.slice(prefix.length).split("/")[0]!.replace(/\.md$/, "");
    if (id.length > 0) ids.add(id);
  }
  return ids;
};

/**
 * "Reviewer", then "Reviewer 2", and so on, so a name repeated in one team stays unique. `taken`
 * holds lowercased names, since delegation matches names regardless of case.
 */
const uniqueName = (name: string, taken: ReadonlySet<string>) => {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

/**
 * A new team of copies: the named lead (absent means the first one) and each named worker, so
 * editing a definition later never changes this team. It is the manager's, not yet the user's.
 */
export const teamFromDefinitions = (
  input: FactoryCreateTeamFromDefinitionsInput,
  view: FactoryDefinitionsView,
): { readonly team: FactoryTeamDefinition } | { readonly problem: string } => {
  const lead =
    input.leadId === undefined
      ? view.leads[0]
      : view.leads.find((lead) => lead.id === input.leadId);
  if (lead === undefined)
    return {
      problem:
        input.leadId === undefined
          ? "The factory config has no lead definition. Ask the user to add one."
          : `There is no lead "${input.leadId}". Read the leads with factory_definitions.`,
    };
  const names = new Set<string>();
  const memberIds = new Set<string>();
  const members: FactoryTeamMemberDefinition[] = [];
  for (const requested of input.members) {
    const worker = view.workers.find((candidate) => candidate.id === requested.workerId);
    if (worker === undefined)
      return {
        problem: `There is no worker "${requested.workerId}". Read the workers with factory_definitions.`,
      };
    const name = uniqueName(requested.name ?? worker.name, names);
    names.add(name.toLowerCase());
    const id = definitionIdFromName(name, memberIds);
    memberIds.add(id);
    members.push({ ...worker, id, name, count: requested.count });
  }
  const team: FactoryTeamDefinition = {
    id: definitionIdFromName(input.name, takenDefinitionIds(view, "team")),
    name: input.name,
    useWhen: input.useWhen,
    workflow: input.workflow,
    mayEditProtectedPaths: false,
    createdBy: "manager",
    lead,
    members,
  };
  const problem = teamProblem(team, view.settings.modelPool);
  return problem === null ? { team } : { problem };
};
