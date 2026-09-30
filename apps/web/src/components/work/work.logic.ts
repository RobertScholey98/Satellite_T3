import type {
  IssueAttempt,
  IssueBoardItem,
  IssueBoardMapping,
  OpenWorkDocument,
  OpenWorkStep,
} from "@t3tools/contracts";
import { issueReadyColumnIds } from "@t3tools/contracts";

export function issueCanStart(item: IssueBoardItem, mapping: IssueBoardMapping | null): boolean {
  return (
    mapping !== null &&
    item.columnId !== null &&
    issueReadyColumnIds(mapping).includes(item.columnId)
  );
}

export function defaultIssueAttempt(attempts: readonly IssueAttempt[]): IssueAttempt | null {
  const available = attempts.filter(
    (attempt) => attempt.status === "started" && attempt.threadId !== null,
  );
  return available.find((attempt) => attempt.active) ?? available.at(-1) ?? null;
}

export function documentsAtStep(
  documents: readonly OpenWorkDocument[],
  step: OpenWorkStep,
): readonly OpenWorkDocument[] {
  return documents.filter(
    (document) =>
      document.step.kind === step.kind &&
      (step.kind !== "commit" ||
        (document.step.kind === "commit" && document.step.commitSha === step.commitSha)),
  );
}

export function validWorktreeName(name: string): boolean {
  return (
    name.trim() === name &&
    name.length > 0 &&
    !/[\s~^:?*\[\\]/.test(name) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  );
}
