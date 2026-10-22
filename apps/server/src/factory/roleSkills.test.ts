import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { FactoryRole, ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { renderRoleSkill, roleSkillSource, type RoleSkillFill } from "./roleSkills.ts";
import { DEFAULT_ROLE_SKILLS } from "./roles/index.ts";

const model = Schema.decodeSync(ModelSelection);
const OPUS = model({ instanceId: "claude", model: "claude-opus-5-5" });
const GPT = model({ instanceId: "codex", model: "gpt-6" });

const EMPTY: RoleSkillFill = {
  modelPool: [],
  allowedModels: [],
  protectedPaths: [],
  completionCondition: null,
  pickupGuidance: "",
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
      modelPool: [OPUS, GPT],
      allowedModels: [GPT],
      protectedPaths: [".github/workflows/**", "AGENTS.md"],
      completionCondition: "The tests pass.",
      pickupGuidance: "Only small bug fixes.",
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
        "pickup: Only small bug fixes.",
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
        "pickup: (none: nothing auto-starts)",
      ].join("\n"),
    );
  });

  it("gives every default skill the six sections in order and no unfilled placeholder", () => {
    for (const role of FactoryRole.literals) {
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

describe("roleSkillSource", () => {
  it.effect("prefers the project's skill, then the environment's, then the default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectRoot = yield* fs.makeTempDirectoryScoped();
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const projectFile = path.join(projectRoot, ".satellite", "factory", "roles", "lead.md");
      const environmentFile = path.join(baseDir, "factory", "roles", "lead.md");
      const roots = { projectRoot, baseDir };

      assert.deepStrictEqual(yield* roleSkillSource("lead", roots), {
        text: DEFAULT_ROLE_SKILLS.lead,
        source: "default",
      });

      yield* fs.makeDirectory(path.dirname(environmentFile), { recursive: true });
      yield* fs.writeFileString(environmentFile, "environment lead");
      assert.deepStrictEqual(yield* roleSkillSource("lead", roots), {
        text: "environment lead",
        source: "environment",
      });

      // A directory where the file should be is unreadable, and falls through like a missing file.
      yield* fs.makeDirectory(projectFile, { recursive: true });
      assert.strictEqual((yield* roleSkillSource("lead", roots)).source, "environment");

      yield* fs.remove(projectFile, { recursive: true });
      yield* fs.writeFileString(projectFile, "project lead");
      assert.deepStrictEqual(yield* roleSkillSource("lead", roots), {
        text: "project lead",
        source: "project",
      });
      assert.strictEqual((yield* roleSkillSource("reviewer", roots)).source, "default");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
