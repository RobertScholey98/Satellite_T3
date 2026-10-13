import type { FactoryIntegrationPaths } from "@t3tools/contracts";
import { useId } from "react";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

export const integrationPathFields = [
  ["readPaths", "Read-only source files or directories"],
  ["testPaths", "Editable test files"],
  ["fixturePaths", "Editable fixture files"],
  ["testDirectories", "Directories for new tests"],
  ["fixtureDirectories", "Directories for new fixtures"],
] as const;
export const emptyIntegrationPaths: FactoryIntegrationPaths = {
  readPaths: [],
  testPaths: [],
  fixturePaths: [],
  testDirectories: [],
  fixtureDirectories: [],
};
export const integrationLines = (value: string) => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];
export const validIntegrationPaths = (paths: FactoryIntegrationPaths) =>
  paths.readPaths.length > 0 &&
  Object.entries(paths).every(
    ([key, entries]) =>
      entries.length <= 500 &&
      entries.every(
        (path) =>
          (key === "readPaths" && path === ".") ||
          (path.length <= 512 &&
            !/[\\:*?\0]/.test(path) &&
            path.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
      ),
  );

export function FactoryIntegrationPathsEditor({
  value,
  onChange,
  disabled,
}: {
  value: FactoryIntegrationPaths;
  onChange: (value: FactoryIntegrationPaths) => void;
  disabled: boolean;
}) {
  const prefix = useId();
  return (
    <div className="space-y-3">
      {integrationPathFields.map(([key, label]) => (
        <div key={key} className="space-y-1.5">
          <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
          <Textarea
            id={`${prefix}-${key}`}
            disabled={disabled}
            value={value[key].join("\n")}
            onChange={(event) => onChange({ ...value, [key]: event.target.value.split("\n") })}
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        One project-relative path per line. Use . for the complete read-only source tree. Only
        classified tests and fixtures can change; production fixes return to their owning team.
      </p>
    </div>
  );
}

export const normalizeIntegrationPaths = (
  paths: FactoryIntegrationPaths,
): FactoryIntegrationPaths => ({
  readPaths: integrationLines(paths.readPaths.join("\n")),
  testPaths: integrationLines(paths.testPaths.join("\n")),
  fixturePaths: integrationLines(paths.fixturePaths.join("\n")),
  testDirectories: integrationLines(paths.testDirectories.join("\n")),
  fixtureDirectories: integrationLines(paths.fixtureDirectories.join("\n")),
});

export function FactoryIntegrationPathsSummary({ paths }: { paths: FactoryIntegrationPaths }) {
  return (
    <dl className="space-y-2 text-xs">
      {integrationPathFields.map(([key, label]) => (
        <div key={key}>
          <dt className="font-medium">{label}</dt>
          <dd className="break-all text-muted-foreground">{paths[key].join(", ") || "None"}</dd>
        </div>
      ))}
    </dl>
  );
}
