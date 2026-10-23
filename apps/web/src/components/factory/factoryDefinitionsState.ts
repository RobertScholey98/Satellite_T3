import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FactoryConfigSettings,
  FactoryDefinitionKind,
  FactoryDefinitionSaveInput,
  FactoryDefinitionsView,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { factoryEnvironment, factoryErrorMessage, unwrapFactoryResult } from "./factoryState";

/**
 * One environment's factory definitions, shared by every section that edits them, so a worker
 * saved in one section is offered at once when another builds a team.
 */
const definitionsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<FactoryDefinitionsView | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-factory-definitions:${environmentId}`),
  ),
);

function failureMessage<A, E>(result: AtomCommandResult<A, E>): string | null {
  try {
    unwrapFactoryResult(result);
    return null;
  } catch (failure) {
    return factoryErrorMessage(failure);
  }
}

/** A failed request's message, or null once it succeeded and the view is current. */
type FactoryDefinitionsWriteResult = string | null;

export function useFactoryDefinitions(environmentId: EnvironmentId) {
  const atom = definitionsAtom(environmentId);
  const view = useAtomValue(atom);
  const setView = useAtomSet(atom);
  const getDefinitions = useAtomCommand(factoryEnvironment.getDefinitions, {
    reportFailure: false,
  });
  const saveDefinition = useAtomCommand(factoryEnvironment.saveDefinition, {
    reportFailure: false,
  });
  const removeDefinition = useAtomCommand(factoryEnvironment.removeDefinition, {
    reportFailure: false,
  });
  const saveFactorySettings = useAtomCommand(factoryEnvironment.saveFactorySettings, {
    reportFailure: false,
  });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void getDefinitions({ environmentId, input: {} }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") setView(result.value);
      else setLoadError(failureMessage(result) ?? "Cancelled.");
    });
    return () => {
      current = false;
    };
  }, [environmentId, getDefinitions, setView]);

  const save = async (
    input: FactoryDefinitionSaveInput,
  ): Promise<FactoryDefinitionsWriteResult> => {
    const result = await saveDefinition({ environmentId, input });
    if (result._tag !== "Success") return failureMessage(result) ?? "Cancelled.";
    setView(result.value.view);
    return null;
  };

  const remove = async (
    kind: FactoryDefinitionKind,
    id: string,
  ): Promise<FactoryDefinitionsWriteResult> => {
    const result = await removeDefinition({ environmentId, input: { kind, id } });
    if (result._tag !== "Success") return failureMessage(result) ?? "Cancelled.";
    setView(result.value);
    return null;
  };

  const saveSettings = async (
    settings: FactoryConfigSettings,
  ): Promise<FactoryDefinitionsWriteResult> => {
    const result = await saveFactorySettings({ environmentId, input: settings });
    if (result._tag !== "Success") return failureMessage(result) ?? "Cancelled.";
    setView(result.value);
    return null;
  };

  return { view, loadError, save, remove, saveSettings };
}
