import { createRevdocEnvironmentAtoms } from "@t3tools/client-runtime/revdoc";
import { createEnvironmentThreadStateAtoms } from "@t3tools/client-runtime/state/threads";
import { connectionAtomRuntime } from "../connection/runtime";

export const revdocEnvironment = createRevdocEnvironmentAtoms(connectionAtomRuntime);

export const revdocTestingThreads = createEnvironmentThreadStateAtoms(
  connectionAtomRuntime,
  "revdoc",
);
export const legacyRevdocTestingThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
