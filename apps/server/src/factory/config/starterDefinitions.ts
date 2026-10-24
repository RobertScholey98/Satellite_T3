import {
  FACTORY_CONFIG_FORMAT_VERSION,
  type FactoryDefinitions,
  type FactoryLeadDefinition,
  type FactoryManagerDefinition,
  type FactoryModelList,
  type FactoryModelRef,
  type FactoryTeamDefinition,
  type FactoryWorkerDefinition,
  FactoryWorkerRole,
} from "@t3tools/contracts";

import { DEFAULT_ROLE_SKILLS } from "../roles/index.ts";

export const STARTER_WORKER_ROLES = FactoryWorkerRole.literals;

/** An empty dynamic list is a menu of the whole pool. */
const POOL: FactoryModelList = { dynamic: true, models: [] };

/** A worker identified by its role, described by the built-in skill unless replaced. */
export const starterWorker = (
  role: FactoryWorkerRole,
  overrides: { readonly description?: string; readonly models?: FactoryModelList } = {},
): FactoryWorkerDefinition => ({
  id: role,
  name: `${role[0]!.toUpperCase()}${role.slice(1)}`,
  models: overrides.models ?? POOL,
  description: (overrides.description ?? DEFAULT_ROLE_SKILLS[role]).trim(),
});

/** The fixed lead protocol is the brief; a definition only adds to it, so it starts empty. */
export const defaultLead = (
  overrides: { readonly instructions?: string; readonly models?: FactoryModelList } = {},
): FactoryLeadDefinition => ({
  id: "default",
  name: "Default lead",
  models: overrides.models ?? POOL,
  instructions: (overrides.instructions ?? "").trim(),
});

export const defaultManager = (
  overrides: { readonly instructions?: string; readonly models?: FactoryModelList } = {},
): FactoryManagerDefinition => ({
  id: "default",
  name: "Default manager",
  models: overrides.models ?? { dynamic: false, models: [] },
  instructions: (overrides.instructions ?? "").trim(),
});

/** One of each starter worker under the default lead, as the old starting preset was. */
const standardTeam = (
  lead: FactoryLeadDefinition,
  workers: ReadonlyArray<FactoryWorkerDefinition>,
): FactoryTeamDefinition => ({
  id: "standard",
  name: "Standard",
  useWhen: "Most tickets",
  workflow:
    "The implementer builds the change, the reviewer reviews the pull request, and the verifier checks the result against the ticket before the lead claims it done.",
  mayEditProtectedPaths: false,
  createdBy: "user",
  lead,
  members: workers.map((worker) => ({ ...worker, count: 1 })),
});

/**
 * A fresh factory config to start from: the starter workers, default lead and manager, and the
 * Standard team, all running on whatever the pool holds.
 */
export const starterSet = (modelPool: ReadonlyArray<FactoryModelRef>): FactoryDefinitions => {
  const workers = STARTER_WORKER_ROLES.map((role) => starterWorker(role));
  const lead = defaultLead();
  return {
    settings: { version: FACTORY_CONFIG_FORMAT_VERSION, modelPool, recoveryAllowance: 1 },
    workers,
    leads: [lead],
    managers: [defaultManager()],
    teams: [standardTeam(lead, workers)],
  };
};
