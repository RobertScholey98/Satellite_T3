import { WS_METHODS, type RevdocReview, type RevdocTest } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "./connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./state/runtime.ts";

export const REVDOC_OUTCOMES = [
  { value: "untested", label: "Not tested", tone: "secondary" },
  { value: "complete", label: "Complete", tone: "success" },
  { value: "partial", label: "Partially complete", tone: "warning" },
  { value: "broken", label: "Complete but broken", tone: "error" },
  { value: "notspec", label: "Not to spec", tone: "warning" },
  { value: "change", label: "Request change", tone: "info" },
  { value: "missed", label: "Missed", tone: "error" },
  { value: "na", label: "N/A", tone: "secondary" },
] as const;

export function revdocSummary(
  tests: readonly RevdocTest[],
  notes: readonly (string | undefined)[] = [],
) {
  const complete = tests.filter((test) => test.outcome === "complete").length;
  const reviewed = tests.filter((test) => test.outcome && test.outcome !== "untested").length;
  const findings = tests.filter(
    (test) => test.outcome && !["untested", "complete", "na"].includes(test.outcome),
  ).length;
  const hasNotes =
    notes.some((note) => note?.trim()) || tests.some((test) => test.feedback?.trim());
  return {
    total: tests.length,
    complete,
    reviewed,
    findings,
    good: tests.length > 0 && complete === tests.length && !hasNotes,
    hasNotes,
  };
}

export function revdocTests(review: RevdocReview) {
  return review.sections.flatMap((section) => section.items.flatMap((item) => item.tests));
}

export function revdocEvidencePath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("evidence/") &&
    !normalized.split("/").some((part) => part === ".." || part === "." || !part) &&
    /\.(png|jpe?g|webp)$/i.test(normalized)
    ? `.revdoc/${normalized}`
    : null;
}

export function createRevdocEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "revdoc:changes",
    tag: WS_METHODS.revdocChanges,
  });
  return {
    changes,
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "revdoc:get",
      tag: WS_METHODS.revdocGet,
      staleTimeMs: 0,
      idleTtlMs: 0,
      refreshTrigger: (target) => changes(target),
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "revdoc:start",
      tag: WS_METHODS.revdocStart,
    }),
    startTesting: createEnvironmentRpcCommand(runtime, {
      label: "revdoc:testStart",
      tag: WS_METHODS.revdocTestStart,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "revdoc:cancel",
      tag: WS_METHODS.revdocCancel,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "revdoc:save",
      tag: WS_METHODS.revdocSave,
    }),
  };
}
