import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type FactoryDefinitionsView } from "@t3tools/contracts";

import { teamFromDefinitions, teamProblem } from "./definitionRules.ts";

const opus = { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" };

const lead = {
  id: "default",
  name: "Default lead",
  models: { dynamic: true, models: [opus] },
  instructions: "Keep PRs small.",
};
const reviewer = {
  id: "reviewer",
  name: "Reviewer",
  models: { dynamic: false, models: [opus] },
  description: "Review the diff.",
};

const VIEW: FactoryDefinitionsView = {
  configured: true,
  settings: { version: 1, modelPool: [opus], recoveryAllowance: 1 },
  workers: [reviewer],
  leads: [lead],
  managers: [],
  teams: [],
  // A broken team file still owns its id.
  problems: [{ path: "teams/review/team.md", message: "Not valid YAML." }],
};

describe("teamFromDefinitions", () => {
  it("copies the lead and workers, making member names unique and skipping a taken id", () => {
    assert.deepStrictEqual(
      teamFromDefinitions(
        {
          name: "Review",
          useWhen: "Risky changes.",
          workflow: "",
          members: [
            { workerId: "reviewer", count: 1 },
            { workerId: "reviewer", count: 2 },
          ],
        },
        VIEW,
      ),
      {
        team: {
          id: "review-2",
          name: "Review",
          useWhen: "Risky changes.",
          workflow: "",
          mayEditProtectedPaths: false,
          createdBy: "manager",
          lead,
          members: [
            { ...reviewer, count: 1 },
            { ...reviewer, id: "reviewer-2", name: "Reviewer 2", count: 2 },
          ],
        },
      },
    );
  });

  it("names a missing lead or worker", () => {
    const input = {
      name: "Review",
      useWhen: "",
      workflow: "",
      members: [{ workerId: "reviewer", count: 1 }],
    };
    assert.deepStrictEqual(teamFromDefinitions({ ...input, leadId: "strict" }, VIEW), {
      problem: 'There is no lead "strict". Read the leads with factory_definitions.',
    });
    assert.deepStrictEqual(
      teamFromDefinitions({ ...input, members: [{ workerId: "tester", count: 1 }] }, VIEW),
      { problem: 'There is no worker "tester". Read the workers with factory_definitions.' },
    );
  });
});

describe("teamProblem", () => {
  it("refuses two members with one name", () => {
    assert.strictEqual(
      teamProblem(
        {
          lead,
          members: [
            { ...reviewer, count: 1 },
            { ...reviewer, id: "second", count: 1 },
          ],
        },
        [opus],
      ),
      'Two members are named "Reviewer". Give each member its own name.',
    );
  });

  it("refuses names that differ only in case, since delegation ignores case", () => {
    assert.strictEqual(
      teamProblem(
        {
          lead,
          members: [
            { ...reviewer, count: 1 },
            { ...reviewer, id: "second", name: "REVIEWER", count: 1 },
          ],
        },
        [opus],
      ),
      'Two members are named "REVIEWER". Give each member its own name.',
    );
  });
});

describe("teamFromDefinitions names", () => {
  it("numbers a requested name that only differs in case from one already taken", () => {
    const result = teamFromDefinitions(
      {
        name: "Review",
        useWhen: "",
        workflow: "",
        members: [
          { workerId: "reviewer", count: 1 },
          { workerId: "reviewer", count: 1, name: "reviewer" },
        ],
      },
      VIEW,
    );
    assert.deepStrictEqual(
      "team" in result ? result.team.members.map((member) => member.name) : result,
      ["Reviewer", "reviewer 2"],
    );
  });
});
