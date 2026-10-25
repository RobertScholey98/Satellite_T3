import { useAtomValue } from "@effect/atom-react";
import { createFactoryEnvironmentAtoms } from "@t3tools/client-runtime/state/factory";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type FactoryAssignment,
  type FactoryManager,
  FactoryOperationError,
  type FactoryTicketDraft,
  type FactoryWorkspaceFeed,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import type { EnvironmentPresentation } from "~/state/environments";
import { effectiveManagerCap } from "./factoryManagerSettings.logic";

export const factoryEnvironment = createFactoryEnvironmentAtoms(connectionAtomRuntime);

const isFactoryOperationError = Schema.is(FactoryOperationError);

/** Thrown by `unwrapFactoryResult`; `interrupted` failures are not worth showing. */
export class FactoryRequestError extends Error {
  constructor(
    message: string,
    readonly reason: FactoryOperationError["reason"] | "interrupted" | "other",
  ) {
    super(message);
  }
}

export function unwrapFactoryResult<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new FactoryRequestError("Cancelled.", "interrupted");
  const failure = squashAtomCommandFailure(result);
  if (isFactoryOperationError(failure))
    throw new FactoryRequestError(failure.message, failure.reason);
  throw new FactoryRequestError(
    failure instanceof Error && failure.message ? failure.message : "The request failed.",
    "other",
  );
}

export function factoryErrorMessage(failure: unknown): string | null {
  if (failure instanceof FactoryRequestError && failure.reason === "interrupted") return null;
  return failure instanceof Error ? failure.message : String(failure);
}

/** The factory ships with issue boards: a server with boards has the factory too. */
export function supportsFactory(environment: EnvironmentPresentation | undefined): boolean {
  return environment?.serverConfig?.environment.capabilities.issueBoards === true;
}

const UNSUBSCRIBED = Atom.make<undefined>(undefined).pipe(Atom.withLabel("web-factory:none"));

const managersAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<FactoryManager> | undefined =>
      Option.getOrUndefined(
        AsyncResult.value(get(factoryEnvironment.managers({ environmentId, input: {} }))),
      )?.managers,
  ).pipe(Atom.withLabel(`web-factory-managers:${environmentId}`)),
);

const assignmentsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<FactoryAssignment> | undefined =>
      Option.getOrUndefined(
        AsyncResult.value(get(factoryEnvironment.assignments({ environmentId, input: {} }))),
      )?.assignments,
  ).pipe(Atom.withLabel(`web-factory-assignments:${environmentId}`)),
);

const workspaceAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): FactoryWorkspaceFeed | undefined =>
    Option.getOrUndefined(
      AsyncResult.value(get(factoryEnvironment.workspace({ environmentId, input: {} }))),
    ),
  ).pipe(Atom.withLabel(`web-factory-workspace:${environmentId}`)),
);

const draftsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<FactoryTicketDraft> | undefined =>
      Option.getOrUndefined(
        AsyncResult.value(get(factoryEnvironment.drafts({ environmentId, input: {} }))),
      )?.drafts,
  ).pipe(Atom.withLabel(`web-factory-drafts:${environmentId}`)),
);

/** Every manager on the environment; `undefined` until the first event. */
export function useFactoryManagers(
  environmentId: EnvironmentId | null,
): ReadonlyArray<FactoryManager> | undefined {
  return useAtomValue(environmentId === null ? UNSUBSCRIBED : managersAtom(environmentId));
}

const environmentCapAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): number | undefined =>
      Option.getOrUndefined(
        AsyncResult.value(get(factoryEnvironment.managers({ environmentId, input: {} }))),
      )?.environmentConcurrencyCap,
  ).pipe(Atom.withLabel(`web-factory-environment-cap:${environmentId}`)),
);

/** The cap a manager runs to, live from the managers feed; null until the environment's is known. */
export function useFactoryManagerCap(environmentId: EnvironmentId, managerId: string) {
  const environment = useFactoryEnvironmentCap(environmentId);
  const manager = useFactoryManagers(environmentId)?.find((entry) => entry.id === managerId);
  if (environment === undefined) return null;
  return effectiveManagerCap(manager?.onboardingResult, environment);
}

/** The environment's cap from the managers feed; `undefined` until the first event. */
export function useFactoryEnvironmentCap(environmentId: EnvironmentId): number | undefined {
  return useAtomValue(environmentCapAtom(environmentId));
}

/** Live assignments plus those ended in the last day; `undefined` until the first event. */
export function useFactoryAssignments(
  environmentId: EnvironmentId | null,
): ReadonlyArray<FactoryAssignment> | undefined {
  return useAtomValue(environmentId === null ? UNSUBSCRIBED : assignmentsAtom(environmentId));
}

/** Thread membership and checklists for the manager workspace. */
export function useFactoryWorkspace(
  environmentId: EnvironmentId | null,
): FactoryWorkspaceFeed | undefined {
  return useAtomValue(environmentId === null ? UNSUBSCRIBED : workspaceAtom(environmentId));
}

/** Retro triage drafts in every state; `undefined` until the first event. */
export function useFactoryDrafts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<FactoryTicketDraft> | undefined {
  return useAtomValue(environmentId === null ? UNSUBSCRIBED : draftsAtom(environmentId));
}
