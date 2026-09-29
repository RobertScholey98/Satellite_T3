import { createDocumentsEnvironmentAtoms } from "@t3tools/client-runtime/documents";
import { connectionAtomRuntime } from "../connection/runtime";

export const documentsEnvironment = createDocumentsEnvironmentAtoms(connectionAtomRuntime);
