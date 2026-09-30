import { createIssuesEnvironmentAtoms } from "@t3tools/client-runtime/issues";
import { connectionAtomRuntime } from "../connection/runtime";

export const issuesEnvironment = createIssuesEnvironmentAtoms(connectionAtomRuntime);
