import { createOpenWorkEnvironmentAtoms } from "@t3tools/client-runtime/open-work";
import { connectionAtomRuntime } from "../connection/runtime";

export const openWorkEnvironment = createOpenWorkEnvironmentAtoms(connectionAtomRuntime);
