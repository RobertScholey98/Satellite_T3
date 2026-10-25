import { assert, describe, it } from "@effect/vitest";
import {
  FactoryRole,
  ModelSelection,
  ProviderDriverKind,
  type FactoryOnboardingResult,
  type FactoryTeamDefinition,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  definitionTeamSection,
  leadBrief,
  managerBrief,
  projectSection,
  renderRoleSkill,
  roleSkillSource,
  type RoleSkillFill,
  workerBrief,
} from "./roleSkills.ts";
import { DEFAULT_ROLE_SKILLS } from "./roles/index.ts";

const model = Schema.decodeSync(ModelSelection);
const OPUS = model({ instanceId: "claude", model: "claude-opus-5-5" });
const GPT = model({ instanceId: "codex", model: "gpt-6" });

const EMPTY: RoleSkillFill = {
  modelPool: [],
  allowedModels: [],
  protectedPaths: [],
  allowedProtectedPaths: [],
  completionCondition: null,
};

const TEMPLATE = [
  "pool:",
  "{{modelPool}}",
  "allowed:",
  "{{allowedModels}}",
  "protected:",
  "{{protectedPaths}}",
  "done when: {{completionCondition}}",
  "pickup: {{pickupGuidance}}",
].join("\n");

const HEADINGS = [
  "## What you are",
  "## How you work",
  "## What you hand back",
  "## Sub-agents and models",
  "## What stuck means",
  "## What you must never touch",
];

describe("renderRoleSkill", () => {
  it("fills every placeholder, models as instance/model list items", () => {
    const text = renderRoleSkill(TEMPLATE, {
      ...EMPTY,
      modelPool: [OPUS, GPT],
      allowedModels: [GPT],
      protectedPaths: [".github/workflows/**", "AGENTS.md"],
      completionCondition: "The tests pass.",
    });
    assert.strictEqual(
      text,
      [
        "pool:",
        "- claude/claude-opus-5-5",
        "- codex/gpt-6",
        "allowed:",
        "- codex/gpt-6",
        "protected:",
        "- .github/workflows/**",
        "- AGENTS.md",
        "done when: The tests pass.",
        "pickup: (see the Project section)",
      ].join("\n"),
    );
  });

  it("says plainly when a value is missing", () => {
    assert.strictEqual(
      renderRoleSkill(TEMPLATE, EMPTY),
      [
        "pool:",
        "(none configured)",
        "allowed:",
        "(none configured)",
        "protected:",
        "(none configured)",
        "done when: (no assignment yet)",
        "pickup: (see the Project section)",
      ].join("\n"),
    );
  });

  it("gives every default skill the six sections in order and no unfilled placeholder", () => {
    // A worker has no built-in text: its definition's description is its brief.
    for (const role of FactoryRole.literals.filter((role) => role !== "worker")) {
      const skill = DEFAULT_ROLE_SKILLS[role];
      const positions = HEADINGS.map((heading) => skill.indexOf(`\n${heading}\n`));
      assert.isFalse(positions.includes(-1), `${role} is missing a section`);
      assert.deepStrictEqual(
        positions,
        positions.toSorted((left, right) => left - right),
        `${role} sections are out of order`,
      );
      assert.notInclude(renderRoleSkill(skill, EMPTY), "{{", role);
    }
  });
});

const RESULT: FactoryOnboardingResult = {
  purpose: "A todo app for small teams.",
  pickup: { enabled: true, columns: [], labels: [], guidance: "Only small bug fixes." },
  baseBranch: null,
  rules: [
    { id: "small", question: "Which tickets count as small?", answer: "One file" },
    { id: "docs", question: "Do docs-only changes need review?", answer: "Yes" },
  ],
  controlPaths: [],
  teamIds: [],
  concurrencyCap: 2,
};

describe("projectSection", () => {
  it("gives the purpose, the pickup switch with its guidance, and each rule with its answer", () => {
    assert.strictEqual(
      projectSection(RESULT),
      [
        "# Project",
        "A todo app for small teams.",
        "## Pickup",
        "Pickup is on. Judge each ticket you are offered against this guidance:",
        "Only small bug fixes.",
        "## Project rules",
        "- Which tickets count as small?: One file\n- Do docs-only changes need review?: Yes",
      ].join("\n\n"),
    );
  });

  it("says when pickup is off, and starts nothing on its own with no guidance", () => {
    const bare = { ...RESULT, purpose: " ", rules: [] };
    assert.strictEqual(
      projectSection({ ...bare, pickup: { ...RESULT.pickup, enabled: false } }),
      "# Project\n\n## Pickup\n\nPickup is off. No ticket is offered on its own; work starts when the user asks for it.",
    );
    assert.include(
      projectSection({ ...bare, pickup: { ...RESULT.pickup, guidance: "" } }),
      "Recommend every ticket to the user; start none on your own.",
    );
  });
});

describe("roleSkillSource", () => {
  it("serves only the built-in protocols; no override file is read", () => {
    assert.deepStrictEqual(roleSkillSource("lead"), {
      text: DEFAULT_ROLE_SKILLS.lead,
      source: "default",
    });
    assert.deepStrictEqual(roleSkillSource("worker"), { text: "", source: "default" });
  });
});

const BRIEF_FILL: RoleSkillFill = {
  ...EMPTY,
  protectedPaths: [".github/**"],
  completionCondition: "The tests pass.",
};
const PROTOCOL = "# Protocol\n\nNever touch:\n\n{{protectedPaths}}";
const opusRef = { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" };
const gptRef = { driver: ProviderDriverKind.make("codex"), model: "gpt-5.5" };

describe("managerBrief", () => {
  it("puts the protocol, then the definition's instructions, then the project section", () => {
    assert.strictEqual(
      managerBrief({
        protocol: PROTOCOL,
        instructions: " Escalate early. ",
        fill: BRIEF_FILL,
        result: RESULT,
      }),
      [
        "# Protocol\n\nNever touch:\n\n- .github/**",
        "Escalate early.",
        projectSection(RESULT),
      ].join("\n\n"),
    );
  });

  it("adds nothing for empty instructions or before onboarding", () => {
    assert.strictEqual(
      managerBrief({ protocol: PROTOCOL, instructions: "  ", fill: BRIEF_FILL, result: null }),
      "# Protocol\n\nNever touch:\n\n- .github/**",
    );
  });
});

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
    models: { dynamic: true, models: [opusRef] },
    instructions: "Open one pull request per change.",
  },
  members: [
    {
      id: "implementer",
      name: "Implementer",
      models: { dynamic: false, models: [gptRef, opusRef] },
      description: "Implement it.",
      count: 2,
    },
    {
      id: "reviewer",
      name: "Reviewer",
      models: { dynamic: true, models: [] },
      description: "Review it.",
      count: 1,
    },
  ],
};

describe("leadBrief", () => {
  it("puts the protocol, the lead's instructions, the project, the assignment, then the team", () => {
    const team = definitionTeamSection(TEAM);
    assert.strictEqual(
      team,
      [
        "# Team\n\nWeb UI",
        "Implement, then review.",
        "## Members\n\nDelegate to a member by its name with `factory_delegate`.\n\n- Implementer, up to 2 at once: codex/gpt-5.5, claudeAgent/claude-opus-5-5 (in this order)\n- Reviewer, up to 1 at once: any pool model, you pick per task",
        "This team may not edit the project's protected paths.",
      ].join("\n\n"),
    );
    assert.strictEqual(
      leadBrief({
        protocol: PROTOCOL,
        instructions: TEAM.lead.instructions,
        fill: BRIEF_FILL,
        result: RESULT,
        assignment: {
          title: "Fix the empty list",
          brief: "Guard List.tsx.",
          completionCondition: "The tests pass.",
        },
        team,
      }),
      [
        "# Protocol\n\nNever touch:\n\n- .github/**",
        "Open one pull request per change.",
        projectSection(RESULT),
        "# Assignment\n\n## Fix the empty list\n\nGuard List.tsx.\n\n## Completion condition\n\nThe tests pass.",
        team,
      ].join("\n\n"),
    );
  });

  it("lists the protected files the user allowed for the assignment", () => {
    const brief = leadBrief({
      protocol: PROTOCOL,
      instructions: null,
      fill: { ...BRIEF_FILL, allowedProtectedPaths: [".github/workflows/ci.yml"] },
      result: null,
      assignment: { title: "Fix CI", brief: "Fix the CI job.", completionCondition: "CI passes." },
      team: null,
    });
    assert.strictEqual(
      brief,
      [
        "# Protocol\n\nNever touch:\n\n- .github/**",
        "The user allowed you to edit these protected files for this assignment only:",
        "- .github/workflows/ci.yml",
        "# Assignment\n\n## Fix CI\n\nFix the CI job.\n\n## Completion condition\n\nCI passes.",
      ].join("\n\n"),
    );
  });

  it("says when the team may edit protected paths", () => {
    assert.include(
      definitionTeamSection({ ...TEAM, mayEditProtectedPaths: true }),
      "This team may edit the project's protected paths.",
    );
  });
});

describe("workerBrief", () => {
  it("fills the description, then adds the project section, the worker rules and the task", () => {
    // A user's own copy of an older starter description gets the same rules as a new one.
    assert.strictEqual(
      workerBrief(
        {
          description:
            "You review diffs. You do not change code. Done when: {{completionCondition}}",
        },
        {
          ...BRIEF_FILL,
          allowedModels: [opusRef],
          result: RESULT,
          task: "Review the List.tsx change.",
        },
      ),
      [
        "You review diffs. You do not change code. Done when: The tests pass.",
        projectSection(RESULT),
        [
          "# Working on the team",
          "",
          "- Your final turn result is your handback to the lead. Do not message other sessions, even to",
          "  reach the lead.",
          "- Write content that holds escape sequences or template literals with your file-editing tool",
          "  (Write, Edit or apply_patch). Keep shell one-liners to plain search and replace: on Windows,",
          "  heredocs and `node -e` turn `\\n` inside strings into real newlines.",
          "- You may run focused tests and write scratch reproductions to check something. They are not",
          "  changes to the code: put them in a throwaway worktree outside the lead's, remove it",
          "  afterwards, and never commit them.",
        ].join("\n"),
        "# Task\n\nReview the List.tsx change.",
      ].join("\n\n"),
    );
  });

  it("lists the protected files the user allowed for the assignment", () => {
    const brief = workerBrief(
      { description: "Implement it. Never touch:\n\n{{protectedPaths}}" },
      {
        ...BRIEF_FILL,
        allowedProtectedPaths: [".github/workflows/ci.yml", ".github/actions/setup/action.yml"],
        result: null,
        task: "Fix the CI job.",
      },
    );
    assert.isTrue(
      brief.startsWith(
        [
          "Implement it. Never touch:\n\n- .github/**",
          "The user allowed you to edit these protected files for this assignment only:",
          "- .github/workflows/ci.yml\n- .github/actions/setup/action.yml",
          "# Working on the team",
        ].join("\n\n"),
      ),
    );
  });

  it("reads correctly for each starter worker's built-in description", () => {
    for (const role of ["implementer", "reviewer", "verifier"] as const) {
      const brief = workerBrief(
        { description: DEFAULT_ROLE_SKILLS[role] },
        { ...BRIEF_FILL, result: null, task: "Do it." },
      );
      assert.notInclude(brief, "{{", role);
      assert.isTrue(brief.endsWith("# Task\n\nDo it."), role);
    }
  });

  it("lets the starter reviewer run throwaway checks but never edit the code under review", () => {
    const brief = workerBrief(
      { description: DEFAULT_ROLE_SKILLS.reviewer },
      { ...BRIEF_FILL, result: null, task: "Review it." },
    );
    assert.include(
      brief,
      "Run focused tests or a scratch\n  reproduction when reading is not enough.",
    );
    assert.include(
      brief,
      "put them in a throwaway worktree outside the lead's, remove it\n  afterwards, and never commit them.",
    );
    assert.include(brief, "Tag a\nfinding that needs a user decision rather than a fix.");
    assert.include(brief, "- The code under review: you never edit it, even to fix a finding.");
    assert.notInclude(brief, "You do not change code.");
  });
});

describe("the lead protocol", () => {
  const lead = DEFAULT_ROLE_SKILLS.lead.replaceAll(/\n\s*/g, " ");

  it("grounds the design in live data and settles a stack's end state before clients start", () => {
    assert.include(lead, "Ground it in live data read from a read-only snapshot");
    assert.include(lead, "how it behaves today before you propose changes.");
    assert.include(
      lead,
      "For stacked work, settle the end-state data model, migration ids and contract fields, and commit the contract, before client implementers start.",
    );
  });

  it("splits parallel work by module behind shared contracts and checked symbols", () => {
    assert.include(lead, "Give parallel workers whole modules, never regions of one large file.");
    assert.include(
      lead,
      "one owner writes the shared contracts, migration columns and cross-owner hooks, and each brief says which layer every input it uses lives on.",
    );
    assert.include(lead, "Check every symbol a brief names against the target ref with `git grep`");
  });

  it("sizes review rounds, tracks findings per round, and verifies migrations on old records", () => {
    assert.include(
      lead,
      "about 1,500 lines from a committed base..head, with server and UI reviewed separately.",
    );
    assert.include(
      lead,
      "names the shared integration paths the change flows through beyond the diff",
    );
    assert.include(lead, "escalate those to the manager in the same round.");
    assert.include(
      lead,
      "a table of the previous round's findings with the commit that fixed each one.",
    );
    assert.include(
      lead,
      "tests both the write to the new home and the read of a record that existed before, with one fake input per migrated kind.",
    );
  });

  it("sends questions to the manager with factory_ask_manager and keeps working", () => {
    assert.include(
      lead,
      "A question that needs the manager or the user goes to `factory_ask_manager`; the answer arrives in this thread.",
    );
    assert.include(
      lead,
      "Never wait for an answer in your own thread: keep working on whatever the question does not block.",
    );
  });
});
