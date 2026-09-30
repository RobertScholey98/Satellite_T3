import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

export function unwrapWorkResult<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  const failure = squashAtomCommandFailure(result);
  throw failure instanceof Error ? failure : new Error(String(failure));
}

export function workError(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
