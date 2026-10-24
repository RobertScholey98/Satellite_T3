import {
  type FactoryLogEntry,
  type FactoryTeamDefinition,
  type FactoryTicketDraft,
  ProjectId,
  ProviderDriverKind,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decisionSentence,
  latestTicketDecision,
  proposedChangeView,
  triageColumnDrafts,
} from "./FactoryTriageState";

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

const opusRef = { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" };
const gptRef = { driver: ProviderDriverKind.make("codex"), model: "gpt-5.5" };

const TEAM: FactoryTeamDefinition = {
  id: "web-ui",
  name: "Web UI",
  useWhen: "The ticket changes the web client.",
  workflow: "Implement, then review.",
  mayEditProtectedPaths: false,
  createdBy: "manager",
  lead: {
    id: "default",
    name: "Default lead",
    models: { dynamic: true, models: [opusRef] },
    instructions: "Open one pull request per change.",
  },
  members: [
    {
      id: "implementer",
      name: "Implementer",
      models: { dynamic: false, models: [opusRef] },
      description: "Implement the change.",
      count: 2,
    },
  ],
};

describe("proposedChangeView", () => {
  it("shows every field of a team change on both sides, the lead copy and members included", () => {
    const after: FactoryTeamDefinition = {
      ...TEAM,
      lead: { ...TEAM.lead, models: { dynamic: true, models: [gptRef] } },
      members: [{ ...TEAM.members[0]!, description: "Implement the change, tests first." }],
    };
    const view = proposedChangeView({ kind: "team", before: TEAM, after });

    expect(view.label).toBe("Team Web UI");
    expect(view.applicable).toBe(true);
    expect(view.before).toBe(
      [
        "Team: Web UI\nUse when: The ticket changes the web client.\nMay edit protected paths: no\nWorkflow:\nImplement, then review.",
        "Lead: Default lead\nModels: claudeAgent/claude-opus-5-5 (picked per task)\nInstructions:\nOpen one pull request per change.",
        "Member: Implementer × 2\nModels: claudeAgent/claude-opus-5-5 (in this order)\nDescription:\nImplement the change.",
      ].join("\n\n"),
    );
    expect(view.after).toContain("Lead: Default lead\nModels: codex/gpt-5.5 (picked per task)");
    expect(view.after).toContain("Description:\nImplement the change, tests first.");
  });

  it("shows a definition change's models and text", () => {
    const view = proposedChangeView({
      kind: "definition",
      target: "worker",
      before: null,
      after: {
        id: "reviewer",
        name: "Reviewer",
        models: { dynamic: false, models: [gptRef] },
        description: "Review the diff.",
      },
    });

    expect(view).toEqual({
      label: "New worker",
      before: "(none)",
      after:
        "Worker: Reviewer\nModels: codex/gpt-5.5 (in this order)\nDescription:\nReview the diff.",
      applicable: true,
    });
  });
});
