import type { FactoryAssignmentGrant, FactoryBoundaryConfiguration } from "@t3tools/contracts";

import { admissibleFactorySourcePath } from "./FactoryExecutionProfile.ts";

export function factorySafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\\:]/.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
    !value
      .split("/")
      .some(
        (part) =>
          /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      ) &&
    !value.startsWith("/") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

export function factoryRelativePath(value: string): boolean {
  return factorySafeRelativePath(value) && admissibleFactorySourcePath(value);
}

// Names that tools load without an explicit import: test-runner hooks, interpreter startup files,
// and dependency directories that resolve before the root ones. An agent that could create one of
// these anywhere in the tree could silently disarm protected checks.
const autoLoadedName =
  /^(?:node_modules|bower_components|jspm_packages|vendor|site-packages|__pycache__|__mocks__|conftest\.py|sitecustomize\.py|usercustomize\.py|setup\.py|[\w.-]+\.pth|[\w.-]+\.pyc|setupTests\.\w+|[\w.-]+\.conf\.\w+|deno\.jsonc?|Gemfile|Rakefile|build\.rs)$/i;

export function factoryProtectedPath(value: string): boolean {
  return value
    .split("/")
    .some(
      (part) =>
        autoLoadedName.test(part) ||
        /^(?:\..*|AGENTS\.md|CLAUDE\.md|GEMINI\.md|SKILL\.md|package(?:-lock)?\.json|[\w.-]*lock(?:\.[\w.-]+)?|(?:ts|js)config(?:\.[\w.-]+)?\.json|(?:eslint|prettier|biome|oxlint|oxfmt|vite|vitest|webpack|rollup|babel|jest|playwright|cypress|turbo|nx|next|nuxt|svelte|astro|tailwind|postcss|commitlint|lint-staged)(?:\.[\w.-]+)?|[\w.-]+\.config\.[\w.-]+|Dockerfile(?:\..*)?|Makefile|[\w.-]+\.(?:ya?ml|toml|ini|cfg)|SATELLITE_DISCOVERY\.md)$/i.test(
          part,
        ),
    );
}

export function factoryPathWithin(value: string, directory: string): boolean {
  return value.startsWith(`${directory}/`);
}

const instructionFile = /(?:^|\/)(?:SKILL|SKILL-MECHANICS|AGENTS|CLAUDE)\.md$/i;
const parentDirectory = (value: string) => value.split("/").slice(0, -1).join("/") || ".";
const within = (value: string, directory: string) =>
  directory === "." || value === directory || factoryPathWithin(value, directory);

// Skill content is found by location: configured skill roots, any directory holding a known or
// approved SKILL.md (so its references count), and new directories beside existing skills.
export function factoryPathsChangeSkills(
  paths: { readonly files: readonly string[]; readonly creatableDirectories: readonly string[] },
  configuration: FactoryBoundaryConfiguration,
): boolean {
  const skillDirectories = [
    ...configuration.protectedPaths,
    ...(configuration.protectedCreatablePaths ?? []),
  ]
    .filter((value) => /(?:^|\/)SKILL\.md$/i.test(value))
    .map(parentDirectory);
  const skillsRoots = skillDirectories.filter((value) => value !== ".").map(parentDirectory);
  const skillContent = (value: string) =>
    instructionFile.test(value) ||
    [...(configuration.skillRoots ?? []), ...skillDirectories].some((root) => within(value, root));
  return (
    paths.files.some(skillContent) ||
    paths.creatableDirectories.some(
      (directory) => skillContent(directory) || skillsRoots.some((root) => within(directory, root)),
    )
  );
}

export function factoryGrantChangesSkills(
  grant: FactoryAssignmentGrant,
  configuration: FactoryBoundaryConfiguration,
): boolean {
  return factoryPathsChangeSkills(
    {
      files: [...grant.sourcePaths, ...(grant.controlChange?.paths ?? [])],
      creatableDirectories: grant.creatableDirectories,
    },
    configuration,
  );
}

export function factoryCanWrite(
  value: string,
  grant: FactoryAssignmentGrant,
  configuration: FactoryBoundaryConfiguration,
): boolean {
  if (!factoryRelativePath(value)) return false;
  if (
    [
      ...configuration.protectedPaths,
      ...(configuration.protectedCreatablePaths ?? []),
      ...configuration.writablePaths,
    ].some((entry) => entry !== value && entry.toLowerCase() === value.toLowerCase())
  )
    return false;
  if (grant.controlChange?.paths.includes(value))
    return (
      configuration.protectedPaths.includes(value) ||
      (configuration.protectedCreatablePaths ?? []).includes(value)
    );
  if (
    factoryProtectedPath(value) ||
    [...configuration.protectedPaths, ...(configuration.protectedCreatablePaths ?? [])].some(
      (entry) => value === entry || factoryPathWithin(value, entry),
    )
  )
    return false;
  if (configuration.writablePaths.includes(value)) return grant.sourcePaths.includes(value);
  return grant.creatableDirectories.some((entry) => factoryPathWithin(value, entry));
}

export function factoryValidConfiguration(configuration: FactoryBoundaryConfiguration): boolean {
  if (
    configuration.writablePaths.length === 0 &&
    configuration.verification !== "protected-integrity"
  )
    return false;
  const paths = [
    ...configuration.protectedPaths,
    ...configuration.writablePaths,
    ...configuration.creatableDirectories,
    ...(configuration.protectedCreatablePaths ?? []),
  ];
  if (paths.some((value) => !factoryRelativePath(value))) return false;
  if (configuration.skillRoots?.some((value) => value !== "." && !factoryRelativePath(value)))
    return false;
  if (configuration.writablePaths.some((value) => factoryProtectedPath(value))) return false;
  if (configuration.creatableDirectories.some((value) => factoryProtectedPath(value))) return false;
  if (configuration.gates.length === 0) return configuration.verification === "protected-integrity";
  return configuration.gates.every(
    (gate) =>
      gate.executable === "/usr/local/bin/node" &&
      (gate.cwd === "." || factoryRelativePath(gate.cwd)) &&
      gate.timeoutMs > 0 &&
      gate.timeoutMs <= 300_000 &&
      gate.protectedInputs.length > 0 &&
      gate.protectedInputs.every(
        (value) => factoryRelativePath(value) && configuration.protectedPaths.includes(value),
      ) &&
      (gate.args.length === 1 || (gate.args.length === 2 && gate.args[0] === "--test")) &&
      gate.protectedInputs.some((value) => gate.args.at(-1) === `/workspace/${value}`),
  );
}
