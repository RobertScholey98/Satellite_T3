import {
  FactoryOperationError,
  type FactoryConfigSettings,
  type FactoryDefinitionKind,
  type FactoryDefinitionRemoveInput,
  type FactoryDefinitionSaveInput,
  type FactoryDefinitionSaveResult,
  type FactoryDefinitionsView,
  type FactoryModelList,
  type FactoryModelRef,
  type FactoryTeamMemberDefinition,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { definitionIdFromName } from "./definitionFiles.ts";
import { FactoryConfigStore } from "./FactoryConfigStore.ts";

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
  }
>()("t3/factory/config/definitionsEditor/FactoryDefinitionsEditor") {}

const KIND_DIRECTORY: Record<FactoryDefinitionKind, string> = {
  worker: "workers",
  lead: "leads",
  manager: "managers",
  team: "teams",
};

const invalid = (message: string) => new FactoryOperationError({ reason: "invalid", message });

const modelKey = (ref: FactoryModelRef) => `${ref.driver}/${ref.model}`;

/** Each model list the definition holds, with how to name its owner in a message. */
const modelListsOf = (
  input: FactoryDefinitionSaveInput,
): ReadonlyArray<{ readonly owner: string; readonly list: FactoryModelList }> =>
  input.kind === "team"
    ? [
        { owner: "the team's lead", list: input.definition.lead.models },
        ...input.definition.members.map((member) => ({
          owner: `the member "${member.name}"`,
          list: member.models,
        })),
      ]
    : [{ owner: `this ${input.kind}`, list: input.definition.models }];

/**
 * Ids in use for a kind, counting files that failed to decode: a new definition must never take
 * the id of a broken file and overwrite it.
 */
const takenIds = (view: FactoryDefinitionsView, kind: FactoryDefinitionKind) => {
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

const validate = (input: FactoryDefinitionSaveInput, view: FactoryDefinitionsView) => {
  const pool = new Set(view.settings.modelPool.map(modelKey));
  for (const { owner, list } of modelListsOf(input)) {
    const missing = list.models.find((model) => !pool.has(modelKey(model)));
    if (missing !== undefined)
      return invalid(
        `${modelKey(missing)} is not in the model pool. Add it to the pool first, or remove it from ${owner}.`,
      );
  }
  if (input.kind !== "team") return null;
  if (input.definition.members.length === 0) return invalid("A team needs at least one member.");
  const names = new Set<string>();
  for (const member of input.definition.members) {
    // A lead delegates by member name, so two members with one name would be ambiguous.
    if (names.has(member.name))
      return invalid(`Two members are named "${member.name}". Give each member its own name.`);
    names.add(member.name);
  }
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
    const taken = takenIds(view, input.kind);
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
    // TODO(#101): warn with every manager whose onboarding result lists a team before removing it.
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

  return FactoryDefinitionsEditor.of({ save, remove, saveSettings });
});

export const layer = Layer.effect(FactoryDefinitionsEditor, make);
