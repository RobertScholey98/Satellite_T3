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
          "  reach the lead. Never end your turn with background work still running: wait for slow work,",
          "  such as CI, in the foreground with a bounded loop, or stop it and report how far it got.",
          "- Write content that holds escape sequences or template literals with your file-editing tool",
          "  (Write, Edit or apply_patch). Keep shell one-liners to plain search and replace: on Windows,",
          "  heredocs and `node -e` turn `\\n` inside strings into real newlines.",
          "- You may run focused tests and write scratch reproductions to check something. They are not",
          "  changes to the code: put them in a throwaway worktree outside the lead's, remove it",
          "  afterwards, and never commit them. If you link the lead's dependency folders into it rather",
          "  than install, remove the links before `git worktree remove --force`, so the removal cannot",
          "  follow them. To prove a test fails without the fix, copy the changed source files aside,",
          "  replace each with `git show <ref>:<path>` (the base branch, or the commit before a",
          "  follow-up fix), run the new tests, then put the copies back and check that `git status`",
          "  shows the same changes as before. Swap in your own checkout, or in the lead's only while no",
          "  one else works there.",
          "- Never edit the protected control paths:",
          "",
          "- .github/**",
        ].join("\n"),
        "# Task\n\nReview the List.tsx change.",
      ].join("\n\n"),
    );
  });

  const ALLOWED_FILL = {
    ...BRIEF_FILL,
    allowedProtectedPaths: [".github/workflows/ci.yml"],
    result: null,
    task: "Fix the CI job.",
  };
  const ALLOWED = "The user allowed you to edit these protected files for this assignment only:";
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("gives a description without {{protectedPaths}} the protected list in its rules", () => {
    const brief = workerBrief({ description: "Implements the change." }, ALLOWED_FILL);
    assert.isTrue(
      brief.endsWith(
        [
          "  one else works there.\n- Never edit the protected control paths:",
          "- .github/**",
          ALLOWED,
          "- .github/workflows/ci.yml",
          "# Task\n\nFix the CI job.",
        ].join("\n\n"),
      ),
      brief,
    );
    assert.strictEqual(count(brief, "- .github/**"), 1);
    assert.strictEqual(count(brief, ALLOWED), 1);
    assert.strictEqual(count(brief, "- .github/workflows/ci.yml"), 1);
  });

  it("renders the protected list once when the description names {{protectedPaths}}", () => {
    const brief = workerBrief(
      { description: "Implement it. Never touch:\n\n{{protectedPaths}}" },
      ALLOWED_FILL,
    );
    assert.strictEqual(count(brief, "- .github/**"), 1);
    assert.strictEqual(count(brief, ALLOWED), 1);
    assert.strictEqual(count(brief, "- .github/workflows/ci.yml"), 1);
    assert.notInclude(brief, "Never edit the protected control paths");
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
      "a table of the previous round's findings with the commit that fixed each one or the reason it was dismissed.",
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

  it("maps a state machine's writers and every feed of a changed field before the change", () => {
    assert.include(
      lead,
      "Before you change a state machine, list every writer of its state and give the implementer and reviewer a table of each state against each new event.",
    );
    assert.include(lead, "When a field changes meaning, trace every client feed that carries it.");
  });

  it("makes briefs self-contained and lets the lead write wording that is the design", () => {
    assert.include(
      lead,
      "paste in the exact commands and facts the worker needs: a fresh worker remembers no earlier round.",
    );
    assert.include(
      lead,
      "When the wording is the design, as in prompts, docs or role text, you may write it yourself and staff only a reviewer.",
    );
  });

  it("scopes review briefs, including merged branches, and closes every review loop", () => {
    assert.include(
      lead,
      "beyond the diff (for agent-facing text, every surface that renders or returns it),",
    );
    assert.include(
      lead,
      "Round 1 gets the draft pull request body, and an audit brief names every hazard class to look for.",
    );
    assert.include(
      lead,
      "On a branch that merges another, brief `<base>..HEAD` for scope, `<merged head>..HEAD` for the team's own work and `git show --remerge-diff <merge>` for the resolution, and have the reviewer check the callers of every shared helper either side changed.",
    );
    assert.include(
      lead,
      "Before the pull request is marked ready, even after one round, send the reviewer that table for its last round.",
    );
  });

  it("delivers one draft pull request, rechecks its body, and marks it ready on the claim", () => {
    assert.include(
      lead,
      "An assignment delivers one pull request: open it as a draft and link it to this thread. Separate concerns are separate commits in it, not separate pull requests; for factory work this overrides a project's one-concern-per-PR rule.",
    );
    assert.include(
      lead,
      "After each follow-up commit, recheck its body: every test it names exists, whether each fails on the base branch or only on the commit before, and each changed file's upstream status (`git cat-file -e upstream/main:<path>` in a fork).",
    );
    assert.include(
      lead,
      "It stays a draft until review and verification are done and CI is green; mark it ready for review when you claim complete, and stop.",
    );
    assert.notInclude(lead, "Open a pull request for each coherent change");
  });
});

describe("the manager protocol", () => {
  it("briefs one draft pull request per assignment", () => {
    assert.include(
      DEFAULT_ROLE_SKILLS.manager.replaceAll(/\n\s*/g, " "),
      "The assignment delivers one pull request, a draft until the lead claims complete; never brief several.",
    );
  });
});

describe("the worker rules and starter descriptions", () => {
  const flat = (text: string) => text.replaceAll(/\n\s*/g, " ");
  const rules = flat(workerBrief({ description: "" }, { ...BRIEF_FILL, result: null, task: "" }));

  it("tell every worker to finish background work and prove red by swapping changed files", () => {
    assert.include(
      rules,
      "Never end your turn with background work still running: wait for slow work, such as CI, in the foreground with a bounded loop, or stop it and report how far it got.",
    );
    assert.include(
      rules,
      "remove the links before `git worktree remove --force`, so the removal cannot follow them.",
    );
    assert.include(
      rules,
      "To prove a test fails without the fix, copy the changed source files aside, replace each with `git show <ref>:<path>` (the base branch, or the commit before a follow-up fix), run the new tests, then put the copies back and check that `git status` shows the same changes as before. Swap in your own checkout, or in the lead's only while no one else works there.",
    );
  });

  it("have the implementer test touched browser components, prove red and run limits at once", () => {
    const implementer = flat(DEFAULT_ROLE_SKILLS.implementer);
    assert.include(
      implementer,
      "Before you commit, prove each new test fails without the change by swapping the changed source files to `git show HEAD:<file>` as the worker rules describe, never by undoing edits with a script.",
    );
    assert.include(
      implementer,
      "When the change frees, counts or caps a limit, test it with every path that starts work running at once.",
    );
    assert.include(
      implementer,
      "Before each commit, run the tests and checks that cover it, including the browser tests of every component it touches",
    );
  });

  it("have the reviewer review its own detached checkout and test limits with every path", () => {
    const reviewer = flat(DEFAULT_ROLE_SKILLS.reviewer);
    assert.include(
      reviewer,
      "Review a detached worktree at the reviewed SHA (`git worktree add --detach <path> <sha>`), not the lead's, which may still be changing, and remove it after the round.",
    );
    assert.include(
      reviewer,
      "A change to a limit or capacity needs a test with every path that starts work running at once.",
    );
    assert.include(
      reviewer,
      "When the lead sends a table of your findings, check each fix and dismissal against the code and hand back only the ones you dispute.",
    );
  });

  it("have the verifier judge CI only once the final run ends, waiting in the foreground", () => {
    const verifier = flat(DEFAULT_ROLE_SKILLS.verifier);
    assert.include(
      verifier,
      "Judge CI only after the run on the final head SHA has finished: an aggregate job, such as a `Check` that sums the others, is listed only once they end.",
    );
    assert.include(
      verifier,
      "Wait for it in the foreground with a bounded loop, each wait under ten minutes, until every check is terminal; never end your turn with it running in the background.",
    );
  });
});

describe("the manager protocol", () => {
  const manager = DEFAULT_ROLE_SKILLS.manager.replaceAll(/\n\s*/g, " ");

  it("settles open product questions before commissioning and names the defaults left", () => {
    assert.include(
      manager,
      "before you commission, list the open product questions the brief raises and get the user's answers.",
    );
    assert.include(
      manager,
      "Name each one still open in the brief as a default the lead may build on, and tell the user which defaults are in play.",
    );
  });

  it("amends a changed brief with factory_amend_assignment instead of only messaging the lead", () => {
    assert.include(
      manager,
      "when the brief or completion condition changes mid-assignment, amend it with `factory_amend_assignment` rather than only messaging the lead,",
    );
  });
});
