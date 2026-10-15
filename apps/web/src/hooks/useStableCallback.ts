import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * A callback whose identity never changes but always runs the latest closure,
 * for event handlers passed to memoized children. Only for handlers called
 * after render (events, effects): during render it would still see the
 * previous closure.
 */
export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useInsertionEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
