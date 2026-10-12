import { useAtomValue } from "@effect/atom-react";
import { createFactoryEnvironmentAtoms } from "@t3tools/client-runtime/factory";
import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  type EnvironmentId,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";
import { environmentSession } from "./session";

export const factoryEnvironment = createFactoryEnvironmentAtoms(connectionAtomRuntime);

export interface FactoryEnvironmentView {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly canOperate: boolean;
  readonly data: FactorySnapshot | null;
  readonly pending: boolean;
  readonly error: string | null;
}

const factoryEnabledAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.settingsValueAtom(environmentId))?.engineeringManagersEnabled === true,
  ).pipe(Atom.withLabel(`web:factory:enabled:${environmentId}`)),
);

export const factoryEnvironmentsAtom = Atom.make((get): readonly FactoryEnvironmentView[] => {
  const environments: FactoryEnvironmentView[] = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
    const session = Option.getOrNull(AsyncResult.value(sessionResult));
    if (
      sessionResult._tag === "Failure" ||
      session === null ||
      !sessionGrantsScope(session, AuthOrchestrationReadScope)
    ) {
      continue;
    }
    // The beta switch only gates the first manager. With it off, one read tells whether this
    // environment already has managers, whose work stays visible; otherwise nothing subscribes.
    if (!get(factoryEnabledAtom(environmentId))) {
      const probe = get(factoryEnvironment.snapshot({ environmentId, input: {} }));
      if ((Option.getOrNull(AsyncResult.value(probe))?.managers.length ?? 0) === 0) continue;
    }
    const result = get(factoryEnvironment.live({ environmentId, input: {} }));
    environments.push({
      environmentId,
      label: presentation.entry.target.label,
      connected: presentation.connection.phase === "connected",
      canOperate: get(factoryEnvironment.dispatch.permissionAtom(environmentId)),
      data: Option.getOrNull(AsyncResult.value(result)),
      pending: result.waiting && Option.isNone(AsyncResult.value(result)),
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    });
  }
  return environments;
}).pipe(Atom.withLabel("web:factory:environments"));

export function useFactoryEnvironments(): readonly FactoryEnvironmentView[] {
  return useAtomValue(factoryEnvironmentsAtom);
}
