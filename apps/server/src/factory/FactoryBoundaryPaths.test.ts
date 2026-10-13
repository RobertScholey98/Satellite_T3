import {
  FactoryBoundaryId,
  type FactoryAssignmentGrant,
  type FactoryBoundaryConfiguration,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  factoryCanWrite,
  factoryValidConfiguration,
  factoryGrantChangesSkills,
} from "./FactoryBoundaryPaths.ts";

const configuration: FactoryBoundaryConfiguration = {
  protectedPaths: ["tests/required.cjs"],
  writablePaths: ["src/value.cjs", "src/unassigned.cjs"],
  creatableDirectories: ["src"],
  gates: [
    {
      id: "required",
      label: "Required assertion",
      executable: "/usr/local/bin/node",
      args: ["/workspace/tests/required.cjs"],
      cwd: ".",
      timeoutMs: 10000,
      protectedInputs: ["tests/required.cjs"],
    },
  ],
};
const grant: FactoryAssignmentGrant = {
  boundaryId: FactoryBoundaryId.make("baseline"),
  epoch: 0,
  sourcePaths: ["src/value.cjs"],
  creatableDirectories: ["src"],
  controlChange: null,
};

describe("managed assignment paths", () => {
  it("qualifies Markdown-only repositories and restricts new protected skill files to exact approvals", () => {
    const skills = {
      protectedPaths: ["existing/SKILL.md"],
      protectedCreatablePaths: ["new/SKILL.md"],
      writablePaths: [],
      creatableDirectories: [],
      skillRoots: ["."],
      verification: "protected-integrity" as const,
      gates: [],
    };
    const approved = {
      ...grant,
      sourcePaths: [],
      creatableDirectories: [],
      controlChange: {
        authorizationId: "human-approval",
        paths: ["new/SKILL.md", "other/SKILL.md"],
      },
    };
    expect(factoryValidConfiguration(skills)).toBe(true);
    expect(factoryCanWrite("new/SKILL.md", approved, skills)).toBe(true);
    expect(factoryCanWrite("other/SKILL.md", approved, skills)).toBe(false);
    expect(factoryCanWrite("new/skill.md", approved, skills)).toBe(false);
    expect(factoryCanWrite("existing/SKILL.md", approved, skills)).toBe(false);
    expect(factoryGrantChangesSkills({ ...grant, sourcePaths: ["reference.md"] }, skills)).toBe(
      true,
    );
    expect(factoryValidConfiguration({ ...skills, verification: "gates" })).toBe(false);
  });
  it("treats skill references and new skill directories in a project boundary as skill edits", () => {
    const project: FactoryBoundaryConfiguration = {
      protectedPaths: ["skills/review/SKILL.md", "tests/required.cjs"],
      writablePaths: ["skills/review/references/checklist.md", "src/value.cjs"],
      creatableDirectories: ["skills", "skills/review/references", "src"],
      gates: configuration.gates,
    };
    const changes = (sourcePaths: string[], creatableDirectories: string[] = []) =>
      factoryGrantChangesSkills({ ...grant, sourcePaths, creatableDirectories }, project);
    expect(changes(["skills/review/references/checklist.md"])).toBe(true);
    expect(changes([], ["skills/review/references"])).toBe(true);
    expect(changes([], ["skills"])).toBe(true);
    expect(changes(["src/value.cjs"], ["src"])).toBe(false);
  });
  it("permits source creation without granting missing nested controls or path escapes", () => {
    expect(factoryCanWrite("src/new/component.ts", grant, configuration)).toBe(true);
    for (const file of [
      "src/AGENTS.md",
      "src/new/package.json",
      "src/new/eslint.config.js",
      "src/.env",
      "src/../tests/required.cjs",
      "src\\escape.ts",
      "/src/value.cjs",
      "tests/required.cjs",
      "src/a\0b.ts",
      "src/unassigned.cjs",
      "src/package.json ",
      "src/CON.ts",
    ])
      expect(factoryCanWrite(file, grant, configuration)).toBe(false);
    expect(
      factoryCanWrite(
        "tests/required.cjs",
        {
          ...grant,
          controlChange: { authorizationId: "separate-job", paths: ["tests/required.cjs"] },
        },
        configuration,
      ),
    ).toBe(true);
  });

  it("keeps files that runners and interpreters load implicitly out of creatable directories", () => {
    for (const file of [
      "src/conftest.py",
      "src/tests/conftest.py",
      "src/sitecustomize.py",
      "src/usercustomize.py",
      "src/hooks.pth",
      "src/__pycache__/value.cpython-312.pyc",
      "src/node_modules/zod/index.d.ts",
      "src/node_modules/chai/index.js",
      "src/vendor/autoload.php",
      "src/__mocks__/fs.js",
      "src/setupTests.ts",
      "src/vitest.setup.ts",
      "src/jest.setup.js",
      "src/karma.conf.js",
      "src/.npmrc",
      "src/tsconfig.json",
      "src/build.rs",
    ])
      expect([file, factoryCanWrite(file, grant, configuration)]).toEqual([file, false]);
    for (const file of ["src/conftest_helpers.py", "src/mocks/fs.ts", "src/setup.ts"])
      expect([file, factoryCanWrite(file, grant, configuration)]).toEqual([file, true]);
  });

  it("accepts only direct approved Node runners and rejects branch script selection", () => {
    expect(factoryValidConfiguration(configuration)).toBe(true);
    for (const gate of [
      { ...configuration.gates[0]!, executable: "npm", args: ["test"] },
      {
        ...configuration.gates[0]!,
        args: ["--require", "/workspace/src/hook.js", "/workspace/tests/required.cjs"],
      },
      { ...configuration.gates[0]!, args: ["/workspace/src/replacement.cjs"] },
      { ...configuration.gates[0]!, protectedInputs: ["src/config.cjs"] },
    ])
      expect(factoryValidConfiguration({ ...configuration, gates: [gate] })).toBe(false);
  });
});
