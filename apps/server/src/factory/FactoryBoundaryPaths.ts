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

export function factoryProtectedPath(value: string): boolean {
  return value
    .split("/")
    .some((part) =>
      /^(?:\..*|AGENTS\.md|CLAUDE\.md|GEMINI\.md|SKILL\.md|package(?:-lock)?\.json|[\w.-]*lock(?:\.[\w.-]+)?|(?:ts|js)config(?:\.[\w.-]+)?\.json|(?:eslint|prettier|biome|oxlint|oxfmt|vite|vitest|webpack|rollup|babel|jest|playwright|cypress|turbo|nx|next|nuxt|svelte|astro|tailwind|postcss|commitlint|lint-staged)(?:\.[\w.-]+)?|[\w.-]+\.config\.[\w.-]+|Dockerfile(?:\..*)?|Makefile|[\w.-]+\.(?:ya?ml|toml|ini|cfg)|SATELLITE_DISCOVERY\.md)$/i.test(
        part,
      ),
    );
}

export function factoryPathWithin(value: string, directory: string): boolean {
  return value.startsWith(`${directory}/`);
}

export function factoryGrantChangesSkills(
  grant: FactoryAssignmentGrant,
  configuration: FactoryBoundaryConfiguration,
): boolean {
  const paths = [
    ...grant.sourcePaths,
    ...grant.creatableDirectories,
    ...(grant.controlChange?.paths ?? []),
  ];
  return paths.some(
    (value) =>
      /(?:^|\/)(?:SKILL|SKILL-MECHANICS|AGENTS|CLAUDE)\.md$/i.test(value) ||
      configuration.skillRoots?.some(
        (root) => root === "." || value === root || factoryPathWithin(value, root),
      ),
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
