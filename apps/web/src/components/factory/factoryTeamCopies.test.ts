import {
  type FactoryTeamDefinition,
  type FactoryWorkerDefinition,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_TEAM_DRAFT,
  duplicateDefinitionName,
  factoryTeamSummary,
  memberFromWorker,
  teamDraftFrom,
  teamDraftProblem,
  teamSaveInput,
  uniqueMemberName,
} from "./factoryTeamCopies";

const REVIEWER: FactoryWorkerDefinition = {
  id: "reviewer",
  name: "Reviewer",
  models: {
    dynamic: true,
    models: [{ driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" }],
  },
  description: "Reviews the diff.",
};

const LEAD = {
  id: "default-lead",
  name: "Default lead",
  models: { dynamic: false, models: [] },
  instructions: "Keep PRs small.",
};

const TEAM: FactoryTeamDefinition = {
  id: "web-ui",
  name: "Web UI",
  useWhen: "Web client work.",
  workflow: "Implement, then review.",
  mayEditProtectedPaths: true,
  createdBy: "manager",
  lead: LEAD,
  members: [
    { ...REVIEWER, id: "implementer", name: "Implementer", count: 2 },
    { ...REVIEWER, count: 1 },
  ],
};

describe("factory team copies", () => {
  it("copies a worker into a team under a name no other member has", () => {
    expect(memberFromWorker(REVIEWER, [])).toEqual({
      name: "Reviewer",
      count: 1,
      models: REVIEWER.models,
      description: "Reviews the diff.",
    });
    expect(
      memberFromWorker(REVIEWER, [
        { name: "Reviewer", count: 1, models: REVIEWER.models, description: "" },
        { name: "Reviewer 2", count: 1, models: REVIEWER.models, description: "" },
      ]).name,
    ).toBe("Reviewer 3");
  });

  it("keeps numbered and copied names within 80 characters", () => {
    const long = "R".repeat(80);
    expect(uniqueMemberName(long, [long])).toBe(`${"R".repeat(78)} 2`);
    expect(duplicateDefinitionName("Reviewer")).toBe("Reviewer (copy)");
    expect(duplicateDefinitionName(long)).toBe(`${"R".repeat(73)} (copy)`);
  });

  it("duplicates a team as a user's copy with the same members and lead", () => {
    expect(teamDraftFrom(TEAM, true)).toEqual({
      name: "Web UI (copy)",
      useWhen: "Web client work.",
      workflow: "Implement, then review.",
      mayEditProtectedPaths: true,
      createdBy: "user",
      lead: LEAD,
      members: TEAM.members,
    });
  });

  it("explains what blocks saving a team", () => {
    expect(teamDraftProblem(EMPTY_TEAM_DRAFT)).toBe("Enter a name.");
    expect(teamDraftProblem({ ...EMPTY_TEAM_DRAFT, name: "QA" })).toBe("Choose a lead.");
    expect(teamDraftProblem({ ...EMPTY_TEAM_DRAFT, name: "QA", lead: LEAD })).toBe(
      "Add at least one member.",
    );
    expect(
      teamDraftProblem({
        ...teamDraftFrom(TEAM, false),
        members: [TEAM.members[1]!, { ...TEAM.members[1]!, id: "second" }],
      }),
    ).toBe("Two members are named Reviewer. A lead delegates by name.");
    expect(teamDraftProblem(teamDraftFrom(TEAM, false))).toBeNull();
  });

  it("saves a team without its own id and with trimmed names", () => {
    expect(
      teamSaveInput({ ...teamDraftFrom(TEAM, false), name: " Web UI ", lead: LEAD }, "web-ui"),
    ).toEqual({
      kind: "team",
      id: "web-ui",
      definition: {
        name: "Web UI",
        useWhen: "Web client work.",
        workflow: "Implement, then review.",
        mayEditProtectedPaths: true,
        createdBy: "manager",
        lead: LEAD,
        members: TEAM.members,
      },
    });
  });

  it("summarises a team for its row", () => {
    expect(factoryTeamSummary(TEAM)).toBe(
      "Lead: Default lead · Implementer ×2, Reviewer · May edit protected paths · Added by manager",
    );
  });
});
