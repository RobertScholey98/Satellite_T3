import {
  FactoryLeadDefinition,
  FactoryManagerDefinition,
  FactoryOperationError,
  type FactoryDefinitionsView,
  type FactoryProposedChange,
  type FactoryTeamDefinition,
  FactoryWorkerDefinition,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  encodeLeadFile,
  encodeManagerFile,
  encodeTeamFiles,
  encodeWorkerFile,
} from "./definitionFiles.ts";
import { definitionProblem, takenDefinitionIds, teamProblem } from "./definitionRules.ts";

export type DefinitionChange = Extract<FactoryProposedChange, { kind: "team" | "definition" }>;

/** What applying a change writes. */
export type DefinitionWrite =
  | { readonly kind: "team"; readonly definition: FactoryTeamDefinition }
  | { readonly kind: "worker"; readonly definition: FactoryWorkerDefinition }
  | { readonly kind: "lead"; readonly definition: FactoryLeadDefinition }
  | { readonly kind: "manager"; readonly definition: FactoryManagerDefinition };

const refused = (reason: FactoryOperationError["reason"], message: string) => ({
  refused: new FactoryOperationError({ reason, message }),
});

const decodeWorker = Schema.decodeUnknownResult(FactoryWorkerDefinition);
const decodeLead = Schema.decodeUnknownResult(FactoryLeadDefinition);
const decodeManager = Schema.decodeUnknownResult(FactoryManagerDefinition);

/** `after` and `before` of a definition change decode as their target's definition. */
const decodeDefinition = (
  target: "worker" | "lead" | "manager",
  value: unknown,
): DefinitionWrite | null => {
  switch (target) {
    case "worker": {
      const decoded = decodeWorker(value);
      return Result.isSuccess(decoded) ? { kind: target, definition: decoded.success } : null;
    }
    case "lead": {
      const decoded = decodeLead(value);
      return Result.isSuccess(decoded) ? { kind: target, definition: decoded.success } : null;
    }
    case "manager": {
      const decoded = decodeManager(value);
      return Result.isSuccess(decoded) ? { kind: target, definition: decoded.success } : null;
    }
  }
};

/**
 * Whether the config still holds exactly `before`, compared by the bytes each would write, as an
 * import compares definitions. Undefined when the definition is gone.
 */
const stillCurrent = (view: FactoryDefinitionsView, before: DefinitionWrite) => {
  switch (before.kind) {
    case "team": {
      const found = view.teams.find((team) => team.id === before.definition.id);
      return found === undefined
        ? undefined
        : JSON.stringify(encodeTeamFiles(found)) ===
            JSON.stringify(encodeTeamFiles(before.definition));
    }
    case "worker": {
      const found = view.workers.find((worker) => worker.id === before.definition.id);
      return found === undefined
        ? undefined
        : encodeWorkerFile(found) === encodeWorkerFile(before.definition);
    }
    case "lead": {
      const found = view.leads.find((lead) => lead.id === before.definition.id);
      return found === undefined
        ? undefined
        : encodeLeadFile(found) === encodeLeadFile(before.definition);
    }
    case "manager": {
      const found = view.managers.find((manager) => manager.id === before.definition.id);
      return found === undefined
        ? undefined
        : encodeManagerFile(found) === encodeManagerFile(before.definition);
    }
  }
};

/**
 * The write a proposed team or definition change makes, or why it no longer applies. A change
 * names the definition it replaces, so one edited since the retro is refused, not clobbered.
 */
export const applyDefinitionChange = (
  view: FactoryDefinitionsView,
  change: DefinitionChange,
): { readonly write: DefinitionWrite } | { readonly refused: FactoryOperationError } => {
  const after =
    change.kind === "team"
      ? ({ kind: "team", definition: change.after } as const)
      : decodeDefinition(change.target, change.after);
  if (after === null)
    return refused(
      "invalid",
      `The proposed ${change.kind === "definition" ? change.target : "team"} is not a valid definition.`,
    );
  const before =
    change.before === null
      ? null
      : change.kind === "team"
        ? ({ kind: "team", definition: change.before } as const)
        : decodeDefinition(change.target, change.before);
  if (change.before !== null && before === null)
    return refused("invalid", `The ${after.kind} this replaces is not a valid definition.`);

  const { id, name } = after.definition;
  if (before === null) {
    if (takenDefinitionIds(view, after.kind).has(id))
      return refused("conflict", `A ${after.kind} with the id "${id}" already exists.`);
  } else {
    if (before.definition.id !== id)
      return refused(
        "invalid",
        `A change to a ${after.kind} keeps its id, "${before.definition.id}".`,
      );
    const current = stillCurrent(view, before);
    if (current === undefined)
      return refused("conflict", `The ${after.kind} "${before.definition.name}" no longer exists.`);
    if (!current)
      return refused(
        "conflict",
        `The ${after.kind} "${name}" changed since this was proposed. Ask the manager to propose it again.`,
      );
  }

  const problem =
    after.kind === "team"
      ? teamProblem(after.definition, view.settings.modelPool)
      : definitionProblem(after.kind, after.definition, view.settings.modelPool);
  if (problem !== null) return refused("invalid", problem);
  return { write: after };
};
