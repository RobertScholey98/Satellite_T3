import {
  issueReadyColumnIds,
  type IssueBoardColumn,
  type IssueBoardMapping,
} from "@t3tools/contracts";

export type BoardColumnRole = "ready" | "in-progress" | "in-pull-request" | "completed";

/** Role names as the Issues view's Column mapping dialog labels them. */
export const boardColumnRoleLabel: Record<BoardColumnRole, string> = {
  ready: "Ready for development",
  "in-progress": "In progress",
  "in-pull-request": "In PR",
  completed: "Completed",
};

export interface TriageColumnOption {
  readonly id: string;
  readonly title: string;
  readonly role: BoardColumnRole | null;
}

/**
 * Every board column in board order with the scheduling role it already holds.
 * Only role-less columns can receive triage tickets; a ticket in a mapped column
 * would be treated as ready, started, in review or done.
 */
export function triageColumnOptions(
  columns: ReadonlyArray<IssueBoardColumn>,
  mapping: IssueBoardMapping | null,
): ReadonlyArray<TriageColumnOption> {
  const roleOf = (id: string): BoardColumnRole | null => {
    if (!mapping) return null;
    if (issueReadyColumnIds(mapping).includes(id)) return "ready";
    if (mapping.inProgress === id) return "in-progress";
    if (mapping.inPullRequest === id) return "in-pull-request";
    if (mapping.completed === id) return "completed";
    return null;
  };
  return columns.map((column) => ({ id: column.id, title: column.title, role: roleOf(column.id) }));
}
