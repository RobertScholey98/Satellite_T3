import { createIdeaEnvironmentAtoms } from "@t3tools/client-runtime/state/ideas";
import { connectionAtomRuntime } from "../connection/runtime";

export const ideaEnvironment = createIdeaEnvironmentAtoms(connectionAtomRuntime);
