import * as Semaphore from "effect/Semaphore";
import type * as Effect from "effect/Effect";
import type { ThreadId } from "@t3tools/contracts";

export interface IdeaExecutionContext {
  readonly cwd: string;
  readonly mainRevision: string;
  readonly projectDirectory: string;
  readonly deletionEpoch: number;
  readonly context: string;
}

const executions = new Map<ThreadId, IdeaExecutionContext>();
const contextPending = new Set<ThreadId>();

export function setIdeaExecution(threadId: ThreadId, execution: IdeaExecutionContext) {
  executions.set(threadId, execution);
  contextPending.add(threadId);
}

export const readIdeaExecution = (threadId: ThreadId) => executions.get(threadId);

export function refreshIdeaMain(threadId: ThreadId, mainRevision: string) {
  const execution = executions.get(threadId);
  if (execution) executions.set(threadId, { ...execution, mainRevision });
}

export function takeIdeaInitialContext(threadId: ThreadId): string | undefined {
  if (!contextPending.delete(threadId)) return undefined;
  return executions.get(threadId)?.context;
}

export function clearIdeaExecution(threadId: ThreadId) {
  executions.delete(threadId);
  contextPending.delete(threadId);
}

export const IDEA_TOOL_NAMES = [
  "idea_read",
  "idea_read_main",
  "idea_read_image",
  "idea_write_document",
  "idea_propose_issues",
  "idea_publish_issues",
] as const;

export const isIdeaTool = (name: string) =>
  IDEA_TOOL_NAMES.some((tool) => name === `mcp__t3-code__${tool}`);

export const IDEA_SESSION_INSTRUCTIONS = [
  "This is an idea discussion. Project code is read-only. Use the idea tools for project reads and documents.",
  "Use idea_read_main to inspect the current main revision and idea_write_document for generated documents.",
  "All documents belong to this idea. Do not register them in a separate library or write project files.",
  "The notebook is maintained by T3. Read its pitch first, then relevant entries and discussion.",
  "Suggestions are possibilities until the user agrees. Distinguish accepted decisions from unresolved choices.",
  "When the user sends /promote, use idea_read with resource promote to load the promotion workflow.",
  "Use idea_propose_issues for a reviewed breakdown. Publication requires explicit approval in T3.",
].join("\n");

const ideaLocks = new Map<ThreadId, Semaphore.Semaphore>();
export function withIdeaLock<A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) {
  let lock = ideaLocks.get(threadId);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    ideaLocks.set(threadId, lock);
  }
  return lock.withPermits(1)(effect);
}
