import {
  type FactoryLogEntry,
  type FactoryTicketDraft,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decisionSentence, latestTicketDecision, triageColumnDrafts } from "./FactoryTriageState";

const project = ProjectId.make("project-1");

const draft = (
  id: string,
  state: FactoryTicketDraft["state"],
  overrides: Partial<FactoryTicketDraft> = {},
): FactoryTicketDraft => ({
  id,
  managerId: "manager-1",
  projectId: project,
  assignmentId: null,
  scope: "project",
  title: `Finding ${id}`,
  body: "Body",
  acceptanceCriteria: [],
  findingIds: [],
  state,
  issue: null,
  proposedChange: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...overrides,
});

const issue = (number: number) => ({
  hostKind: SourceControlProviderKind.make("github"),
  host: "github.com",
  repository: "acme/web",
  id: `issue-${number}`,
  number,
  url: `https://github.com/acme/web/issues/${number}`,
});

const entry = (
  sequence: number,
  kind: FactoryLogEntry["kind"],
  payload: unknown,
  reason = "reason",
): FactoryLogEntry => ({
  sequence,
  managerId: "manager-1",
  assignmentId: null,
  kind,
  reason,
  payload,
  at: "2026-10-01T14:02:00Z",
  deliveredAt: null,
});

describe("triageColumnDrafts", () => {
  const drafts = [
    draft("dismissed", "dismissed"),
    draft("pending", "pending"),
    draft("approved", "approved"),
    draft("elsewhere", "pending", { projectId: ProjectId.make("project-2") }),
  ];

  it("shows the project's pending drafts, and dismissed ones only behind the filter", () => {
    const ids = (showDismissed: boolean) =>
      triageColumnDrafts(drafts, project, { showDismissed, query: "" }).map((entry) => entry.id);
    expect(ids(false)).toEqual(["pending"]);
    expect(ids(true)).toEqual(["pending", "dismissed"]);
  });

  it("applies the board's search", () => {
    expect(
      triageColumnDrafts(drafts, project, { showDismissed: true, query: "finding pending" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["pending"]);
  });
});

describe("latestTicketDecision", () => {
  it("takes the newest pickup or skip of the same ticket", () => {
    const log = [
      entry(4, "wake", { issue: issue(7) }),
      entry(3, "skip", { issue: issue(8), updatedAt: "x", complexity: "small" }),
      entry(2, "skip", { issue: { ...issue(7), host: "GitHub.com" }, updatedAt: "x" }, "Too big"),
      entry(1, "pickup", { issue: issue(7), updatedAt: "x" }),
    ];
    const decision = latestTicketDecision(log, issue(7));
    expect(decision?.sequence).toBe(2);
    expect(decisionSentence(decision!, "14:02")).toBe("Skipped at 14:02: too big.");
    expect(latestTicketDecision(log, issue(9))).toBeNull();
  });
});
