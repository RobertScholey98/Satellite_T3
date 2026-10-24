import {
  FactoryOperationError,
  type FactoryConfigSettings,
  type FactoryDefinitionRemoveInput,
  type FactoryDefinitionSaveInput,
  type FactoryDefinitionSaveResult,
  type FactoryDefinitionsView,
  type FactoryModelRef,
  type FactoryTeamMemberDefinition,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { definitionIdFromName } from "./definitionFiles.ts";
import { definitionProblem, takenDefinitionIds, teamProblem } from "./definitionRules.ts";
import { FactoryConfigStore, unmigratedConfigMessage } from "./FactoryConfigStore.ts";
import { starterSet } from "./starterDefinitions.ts";

/** Saves and removes definitions on behalf of the user, as Settings does. */
export class FactoryDefinitionsEditor extends Context.Service<
  FactoryDefinitionsEditor,
  {
    readonly save: (
      input: FactoryDefinitionSaveInput,
    ) => Effect.Effect<FactoryDefinitionSaveResult, FactoryOperationError>;
    readonly remove: (
      input: FactoryDefinitionRemoveInput,
    ) => Effect.Effect<FactoryDefinitionsView, FactoryOperationError>;
    /**
     * A model taken out of the pool may still be listed by definitions. That is allowed: the
     * factory skips a listed model the pool lacks.
     */
    readonly saveSettings: (
      settings: FactoryConfigSettings,
    ) => Effect.Effect<FactoryDefinitionsView, FactoryOperationError>;
    /** A fresh install's starting point, written only while the config has nothing at all. */
    readonly createStarter: (
      modelPool: ReadonlyArray<FactoryModelRef>,
    ) => Effect.Effect<FactoryDefinitionsView, FactoryOperationError>;
  }
>()("t3/factory/config/definitionsEditor/FactoryDefinitionsEditor") {}

const invalid = (message: string) => new FactoryOperationError({ reason: "invalid", message });

/** The shared definition rules, then what only a save from Settings can get wrong. */
const validate = (input: FactoryDefinitionSaveInput, view: FactoryDefinitionsView) => {
  const pool = view.settings.modelPool;
  const problem =
    input.kind === "team"
      ? teamProblem(
          { lead: input.definition.lead, members: withMemberIds(input.definition.members) },
          pool,
        )
      : definitionProblem(input.kind, input.definition, pool);
  if (problem !== null) return invalid(problem);
  if (input.kind !== "team") return null;
  // Settings sends the ids of members it loaded; a new member has none yet.
  const ids = input.definition.members.flatMap((member) => (member.id ? [member.id] : []));
  if (new Set(ids).size !== ids.length) return invalid("Two members share an id.");
  return null;
};

/** Members keep their ids; a new member gets one from its name. */
const withMemberIds = (
  members: Extract<FactoryDefinitionSaveInput, { kind: "team" }>["definition"]["members"],
): ReadonlyArray<FactoryTeamMemberDefinition> => {
  const taken = new Set(members.flatMap((member) => (member.id ? [member.id] : [])));
  return members.map((member) => {
    if (member.id !== undefined) return { ...member, id: member.id };
    const id = definitionIdFromName(member.name, taken);
    taken.add(id);
    return { ...member, id };
  });
};

const make = Effect.gen(function* () {
  const store = yield* FactoryConfigStore;
  // Saves read the ids in use before writing, so two at once could take the same id.
  const lock = yield* Semaphore.make(1);
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  // The startup migration rewrites the config from the database while `factory.yaml` is missing,
  // so a change made here writes it first and is never migrated over.
  const markConfigured = (view: FactoryDefinitionsView) =>
    view.configured ? Effect.void : store.writeSettings(view.settings);

  const save = Effect.fn("FactoryDefinitionsEditor.save")(function* (
    input: FactoryDefinitionSaveInput,
  ) {
    const view = yield* store.read;
    const problem = validate(input, view);
    if (problem !== null) return yield* problem;
    const taken = takenDefinitionIds(view, input.kind);
    if (input.id !== undefined && !taken.has(input.id))
      return yield* new FactoryOperationError({
        reason: "not-found",
        message: `There is no ${input.kind} "${input.id}" to update. It may have been removed.`,
      });
    const id = input.id ?? definitionIdFromName(input.definition.name, taken);
    yield* markConfigured(view);
    switch (input.kind) {
      case "worker":
        yield* store.writeWorker({ ...input.definition, id });
        break;
      case "lead":
        yield* store.writeLead({ ...input.definition, id });
        break;
      case "manager":
        yield* store.writeManager({ ...input.definition, id });
        break;
      case "team":
        yield* store.writeTeam({
          ...input.definition,
          id,
          members: withMemberIds(input.definition.members),
        });
        break;
    }
    return { id, view: yield* store.read };
  }, serialized);

  const remove = Effect.fn("FactoryDefinitionsEditor.remove")(function* (
    input: FactoryDefinitionRemoveInput,
  ) {
    // Removing a team a manager's result lists stays allowed; Settings first names those
    // managers, from `FactoryTeamUses`, so the user decides knowing who loses it.
    yield* markConfigured(yield* store.read);
    yield* store.remove(input.kind, input.id);
    return yield* store.read;
  }, serialized);

  const saveSettings = Effect.fn("FactoryDefinitionsEditor.saveSettings")(function* (
    settings: FactoryConfigSettings,
  ) {
    yield* store.writeSettings(settings);
    return yield* store.read;
  }, serialized);

  const createStarter = Effect.fn("FactoryDefinitionsEditor.createStarter")(function* (
    modelPool: ReadonlyArray<FactoryModelRef>,
  ) {
    // Writing `factory.yaml` now would mark the config set up and skip the failed migration.
    const failure = yield* store.migrationFailure;
    if (failure !== null)
      return yield* new FactoryOperationError({
        reason: "unavailable",
        message: unmigratedConfigMessage(failure),
      });
    const view = yield* store.read;
    // A file that failed to load is still a definition someone wrote.
    const empty =
      !view.configured &&
      view.workers.length + view.leads.length + view.managers.length + view.teams.length === 0 &&
      view.problems.length === 0;
    if (!empty)
      return yield* new FactoryOperationError({
        reason: "conflict",
        message: "The factory config already exists.",
      });
    const starter = starterSet(modelPool);
    for (const worker of starter.workers) yield* store.writeWorker(worker);
    for (const lead of starter.leads) yield* store.writeLead(lead);
    for (const manager of starter.managers) yield* store.writeManager(manager);
    for (const team of starter.teams) yield* store.writeTeam(team);
    // Last, so a start that stops part way is still not configured and can be retried.
    yield* store.writeSettings(starter.settings);
    return yield* store.read;
  }, serialized);

  return FactoryDefinitionsEditor.of({ save, remove, saveSettings, createStarter });
});

export const layer = Layer.effect(FactoryDefinitionsEditor, make);
