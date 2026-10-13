import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  AuthSettingsWriteScope,
  type FactoryBoundaryConfiguration,
  type ProjectId,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useFactoryCommand } from "./useFactoryCommand";

const lines = (value: string) => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ),
];
export function FactorySharedRepositoryForm({
  environment,
  projects,
}: {
  environment: FactoryEnvironmentView;
  projects: readonly EnvironmentProject[];
}) {
  const prefix = useId();
  const permission = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, permission);
  const choices = projects.filter(
    (project) =>
      project.environmentId === environment.environmentId &&
      !environment.data?.sharedRepositories.some((entry) => entry.projectId === project.id) &&
      !environment.data?.managers.some(
        (entry) => entry.role === "project" && entry.projectId === project.id,
      ),
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [kind, setKind] = useState<"skills" | "workflow-tooling">("skills");
  const [protectedPaths, setProtectedPaths] = useState("");
  const [writablePaths, setWritablePaths] = useState("");
  const [creatableDirectories, setCreatableDirectories] = useState("");
  const [protectedCreatablePaths, setProtectedCreatablePaths] = useState("");
  const [skillRoots, setSkillRoots] = useState(".");
  const [verification, setVerification] = useState<"protected-integrity" | "gates">(
    "protected-integrity",
  );
  const [runner, setRunner] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [saved, setSaved] = useState(false);
  const configuration: FactoryBoundaryConfiguration = {
    protectedPaths: lines(protectedPaths),
    writablePaths: lines(writablePaths),
    creatableDirectories: lines(creatableDirectories),
    protectedCreatablePaths: lines(protectedCreatablePaths),
    skillRoots: lines(skillRoots),
    verification,
    gates:
      verification === "gates"
        ? [
            {
              id: "shared-verification",
              label: "Shared repository verification",
              executable: "/usr/local/bin/node",
              args: [`/workspace/${runner.trim()}`],
              cwd: ".",
              timeoutMs: 60_000,
              protectedInputs: [runner.trim()],
            },
          ]
        : [],
  };
  const selected = choices.find((entry) => entry.id === projectId);
  const valid =
    selected &&
    acknowledged &&
    (verification !== "gates" ||
      (runner.trim() && configuration.protectedPaths.includes(runner.trim())));
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !selected) return;
        void command
          .submit({
            type: "shared.repository.register",
            projectId: selected.id,
            kind,
            configuration,
          })
          .then((success) => {
            if (success) {
              setSaved(true);
              setProjectId(null);
              setAcknowledged(false);
            }
          });
      }}
    >
      <p className="text-sm text-muted-foreground">
        Register a repository you own for shared skills or workflow tooling. It stays in its
        existing location and needs no extra engineering manager. Application work belongs to its
        project manager.
      </p>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-project`}>Existing workspace</Label>
        <Select
          value={projectId}
          disabled={command.disabled}
          items={choices.map((entry) => ({ value: entry.id, label: entry.title }))}
          onValueChange={(value) => {
            setProjectId(value);
            setAcknowledged(false);
          }}
        >
          <SelectTrigger id={`${prefix}-project`}>
            <SelectValue placeholder="Choose a shared repository" />
          </SelectTrigger>
          <SelectPopup>
            {choices.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {!choices.length ? (
          <p className="text-xs text-muted-foreground">
            Add an existing owned-skills or workflow-tooling repository as a workspace first.
            Repositories already owned by a project manager cannot be registered here.
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-kind`}>Owned content</Label>
        <Select
          value={kind}
          disabled={command.disabled}
          onValueChange={(value) => {
            if (value) {
              setKind(value);
              setAcknowledged(false);
            }
          }}
        >
          <SelectTrigger id={`${prefix}-kind`}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="skills">Shared skills</SelectItem>
            <SelectItem value="workflow-tooling">Workflow tooling</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {(
        [
          [
            "protected",
            "Existing protected instruction and control files",
            protectedPaths,
            setProtectedPaths,
            "Exact relative file paths, one per line. These remain protected unless a separate exact work plan authorizes their change.",
          ],
          [
            "writable",
            "Existing source files",
            writablePaths,
            setWritablePaths,
            "Exact files eligible for future scoped assignments, one per line.",
          ],
          [
            "directories",
            "Ordinary creation directories",
            creatableDirectories,
            setCreatableDirectories,
            "Directories where an approved assignment may create ordinary files. This does not grant creation of protected instructions.",
          ],
          [
            "protected-create",
            "Protected files eligible for creation",
            protectedCreatablePaths,
            setProtectedCreatablePaths,
            "Exact future file paths such as new-skill/SKILL.md. Each task still needs explicit human authorization.",
          ],
          [
            "skills",
            "Skill roots",
            skillRoots,
            setSkillRoots,
            "One relative directory per line. Use . for an entire skills repository. Changes in these roots require writing-for-agents and its references.",
          ],
        ] as const
      ).map(([key, label, value, setter, help]) => (
        <div key={key} className="space-y-2">
          <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
          <Textarea
            id={`${prefix}-${key}`}
            rows={3}
            value={value}
            disabled={command.disabled}
            onChange={(event) => {
              setter(event.target.value);
              setAcknowledged(false);
              setSaved(false);
            }}
          />
          <p className="text-xs text-muted-foreground">{help}</p>
        </div>
      ))}
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-verification`}>Repository verification</Label>
        <Select
          value={verification}
          disabled={command.disabled}
          onValueChange={(value) => {
            if (value) {
              setVerification(value);
              setAcknowledged(false);
            }
          }}
        >
          <SelectTrigger id={`${prefix}-verification`}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="protected-integrity">Protected file integrity</SelectItem>
            <SelectItem value="gates">Protected Node check</SelectItem>
          </SelectPopup>
        </Select>
        <p className="text-xs text-muted-foreground">
          Integrity verifies scope and protected files for instruction libraries. Skill changes
          reach new assignments once merged and have no mandatory quality-testing gate.
        </p>
      </div>
      {verification === "gates" ? (
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-runner`}>Protected Node check file</Label>
          <Input
            id={`${prefix}-runner`}
            value={runner}
            disabled={command.disabled}
            onChange={(event) => {
              setRunner(event.target.value);
              setAcknowledged(false);
            }}
          />
          <p className="text-xs text-muted-foreground">
            Relative path also listed among protected files. Runs directly with Node with a
            60-second limit.
          </p>
        </div>
      ) : null}
      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={acknowledged}
            disabled={command.disabled}
            onCheckedChange={setAcknowledged}
          />
          I authorize this repository as shared ownership with these exact boundaries.
        </label>
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={command.disabled || !valid}>
        {command.pending ? "Qualifying repository…" : "Register owned repository"}
      </Button>
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          Repository registered.
        </p>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </form>
  );
}
