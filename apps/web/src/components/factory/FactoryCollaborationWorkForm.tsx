import type {
  FactoryBoundary,
  FactorySupportingWork,
  FactoryTaskComplexity,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export function FactoryCollaborationWorkForm({
  boundary,
  outcome,
  acceptance,
  disabled,
  onSubmit,
}: {
  boundary: FactoryBoundary | undefined;
  outcome: string;
  acceptance: string;
  disabled: boolean;
  onSubmit: (work: FactorySupportingWork) => void;
}) {
  const prefix = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(outcome);
  const [completion, setCompletion] = useState(acceptance);
  const [complexity, setComplexity] = useState<FactoryTaskComplexity>("standard");
  const [requiresPullRequest, setRequiresPullRequest] = useState(true);
  const [sourcePaths, setSourcePaths] = useState<readonly string[]>([]);
  const [directories, setDirectories] = useState<readonly string[]>([]);
  const [newPaths, setNewPaths] = useState("");
  const exactPaths = newPaths
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  const invalidPath = exactPaths.find(
    (path) =>
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !boundary?.creatableDirectories.some((directory) => path.startsWith(`${directory}/`)),
  );
  const stale =
    !boundary ||
    sourcePaths.some((path) => !boundary.writablePaths.includes(path)) ||
    directories.some((path) => !boundary.creatableDirectories.includes(path));
  return (
    <div className="space-y-3 border-l border-border pl-3">
      <p className="text-sm text-muted-foreground">
        The receiving manager owns this implementation team. Its ordinary PR process and human
        approvals still apply. Models are selected from its approved pool.
      </p>
      {(
        [
          ["title", "Supporting task title (required)", title, setTitle],
          ["description", "Scope (required)", description, setDescription],
          ["completion", "Completion condition (required)", completion, setCompletion],
        ] as const
      ).map(([key, label, value, update]) => (
        <div key={key} className="space-y-1.5">
          <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
          {key === "title" ? (
            <Input
              id={`${prefix}-${key}`}
              value={value}
              disabled={disabled}
              maxLength={500}
              onChange={(event) => update(event.target.value)}
            />
          ) : (
            <Textarea
              id={`${prefix}-${key}`}
              value={value}
              disabled={disabled}
              maxLength={6000}
              onChange={(event) => update(event.target.value)}
            />
          )}
        </div>
      ))}
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-complexity`}>Task complexity</Label>
        <Select
          value={complexity}
          disabled={disabled}
          onValueChange={(value) => {
            if (value) setComplexity(value);
          }}
        >
          <SelectTrigger id={`${prefix}-complexity`}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {(["small", "standard", "complex"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={requiresPullRequest}
          disabled={disabled}
          onCheckedChange={setRequiresPullRequest}
        />
        Produces a pull request
      </label>
      {!requiresPullRequest ? (
        <p className="text-sm text-muted-foreground">
          Completion requires explicit human acceptance of the agreed result.
        </p>
      ) : null}
      {(
        [
          ["Editable existing files", boundary?.writablePaths ?? [], sourcePaths, setSourcePaths],
          [
            "Approved creation directories",
            boundary?.creatableDirectories ?? [],
            directories,
            setDirectories,
          ],
        ] as const
      ).map(([label, choices, selected, update]) => (
        <fieldset key={label} className="space-y-1.5">
          <legend className="mb-1 text-sm font-medium">{label}</legend>
          {choices.length ? (
            choices.map((path) => (
              <label key={path} className="flex items-start gap-2 text-sm">
                <Checkbox
                  disabled={disabled}
                  checked={selected.includes(path)}
                  onCheckedChange={(checked) =>
                    update(
                      checked ? [...selected, path] : selected.filter((entry) => entry !== path),
                    )
                  }
                />
                <span className="break-all">{path}</span>
              </label>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">None approved.</p>
          )}
        </fieldset>
      ))}
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-paths`}>Exact new files (optional)</Label>
        <Textarea
          id={`${prefix}-paths`}
          value={newPaths}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => setNewPaths(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          One per line, inside an approved creation directory. Protected rule changes require a
          separate authorization.
        </p>
        {invalidPath ? (
          <p role="alert" className="text-sm text-destructive">
            Outside approved directories or malformed: {invalidPath}
          </p>
        ) : null}
      </div>
      {!boundary ? (
        <p role="status" className="text-sm text-muted-foreground">
          Approve the receiving project's execution boundary before commissioning support.
        </p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={
          disabled ||
          stale ||
          !!invalidPath ||
          !title.trim() ||
          !description.trim() ||
          !completion.trim()
        }
        onClick={() =>
          onSubmit({
            title: title.trim(),
            kind: "implementation",
            complexity,
            scope: {
              description: description.trim(),
              completionCondition: completion.trim(),
              requiresPullRequest,
              ...(!requiresPullRequest
                ? { noPrTarget: { kind: "human-acceptance" as const } }
                : {}),
            },
            sourcePaths: [...new Set([...sourcePaths, ...exactPaths])],
            creatableDirectories: directories,
          })
        }
      >
        Accept and commission supporting team
      </Button>
    </div>
  );
}
