import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type FactoryDefinitionsView,
  type FactoryTeamDefinition,
} from "@t3tools/contracts";

import { applyDefinitionChange } from "./applyDefinitionChange.ts";

const opus = { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" };
const gpt = { driver: ProviderDriverKind.make("codex"), model: "gpt-5.5" };

const TEAM: FactoryTeamDefinition = {
  id: "web-ui",
  name: "Web UI",
  useWhen: "The ticket changes the web client.",
  workflow: "Implement, then review.",
  mayEditProtectedPaths: false,
  createdBy: "user",
  lead: {
    id: "default",
    name: "Default lead",
    models: { dynamic: true, models: [opus] },
    instructions: "",
  },
  members: [
    {
      id: "implementer",
      name: "Implementer",
      models: { dynamic: false, models: [opus] },
      description: "Implement it.",
      count: 1,
    },
  ],
};

const view = (teams: ReadonlyArray<FactoryTeamDefinition>): FactoryDefinitionsView => ({
  configured: true,
  settings: { version: 1, modelPool: [opus], recoveryAllowance: 1 },
  workers: [],
  leads: [],
  managers: [],
  teams,
  problems: [],
});

const message = (result: ReturnType<typeof applyDefinitionChange>) =>
  "refused" in result ? [result.refused.reason, result.refused.message] : null;

describe("applyDefinitionChange for a team", () => {
  it("creates a team, refusing an id already taken", () => {
    assert.deepStrictEqual(
      applyDefinitionChange(view([]), { kind: "team", before: null, after: TEAM }),
      {
        write: { kind: "team", definition: TEAM },
      },
    );
    assert.deepStrictEqual(
      message(applyDefinitionChange(view([TEAM]), { kind: "team", before: null, after: TEAM })),
      ["conflict", 'A team with the id "web-ui" already exists.'],
    );
  });

  it("replaces a team only while the config still holds the team it was proposed against", () => {
    const after = { ...TEAM, workflow: "Implement, review, then verify." };
    assert.deepStrictEqual(
      applyDefinitionChange(view([TEAM]), { kind: "team", before: TEAM, after }),
      { write: { kind: "team", definition: after } },
    );
    const editedSince = { ...TEAM, useWhen: "Anything in apps/web." };
    assert.deepStrictEqual(
      message(applyDefinitionChange(view([editedSince]), { kind: "team", before: TEAM, after })),
      [
        "conflict",
        'The team "Web UI" changed since this was proposed. Ask the manager to propose it again.',
      ],
    );
    assert.deepStrictEqual(
      message(applyDefinitionChange(view([]), { kind: "team", before: TEAM, after })),
      ["conflict", 'The team "Web UI" no longer exists.'],
    );
  });

  it("refuses a team whose models are outside the pool", () => {
    const after = {
      ...TEAM,
      members: [{ ...TEAM.members[0]!, models: { dynamic: false, models: [gpt] } }],
    };
    assert.deepStrictEqual(
      message(applyDefinitionChange(view([TEAM]), { kind: "team", before: TEAM, after })),
      [
        "invalid",
        'codex/gpt-5.5 is not in the model pool. Add it to the pool first, or remove it from the member "Implementer".',
      ],
    );
  });
});

describe("applyDefinitionChange for a definition", () => {
  const reviewer = {
    id: "reviewer",
    name: "Reviewer",
    models: { dynamic: false, models: [opus] },
    description: "Review the diff.",
  };

  it("decodes the proposed worker and refuses one that is not a definition", () => {
    assert.deepStrictEqual(
      applyDefinitionChange(view([]), {
        kind: "definition",
        target: "worker",
        before: null,
        after: reviewer,
      }),
      { write: { kind: "worker", definition: reviewer } },
    );
    assert.deepStrictEqual(
      message(
        applyDefinitionChange(view([]), {
          kind: "definition",
          target: "worker",
          before: null,
          after: { name: "No id" },
        }),
      ),
      ["invalid", "The proposed worker is not a valid definition."],
    );
  });
});
