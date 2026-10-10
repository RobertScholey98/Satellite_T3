import {
  FactoryBoundaryId,
  type FactoryAssignmentGrant,
  type FactoryBoundaryConfiguration,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { factoryCanWrite, factoryValidConfiguration } from "./FactoryBoundaryPaths.ts";

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
