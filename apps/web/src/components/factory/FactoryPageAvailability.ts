import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "~/state/presentation";

// A boolean, so the sidebar re-renders only when the answer changes, not on every config update.
const factorySupportedAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom).values()].some(
    (presentation) => presentation.serverConfig?.environment.capabilities.issueBoards === true,
  ),
).pipe(Atom.withLabel("web-factory:supported"));

/** Whether any environment runs the factory, which ships with issue boards. */
export function useFactorySupported(): boolean {
  return useAtomValue(factorySupportedAtom);
}
