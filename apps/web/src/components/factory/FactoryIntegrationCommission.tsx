import type { FactoryManager, FactoryTaskComplexity, ProjectId } from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useFactoryCommand } from "./useFactoryCommand";

export function FactoryIntegrationCommission({
  environment,
  manager,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
}) {
  const prefix = useId();
  const command = useFactoryCommand(environment);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [complexity, setComplexity] = useState<FactoryTaskComplexity>("standard");
  const [coordinator, setCoordinator] = useState<ProjectId | null>(null);
  const state = environment.data;
  const requests =
    state?.crossProjectRequests.filter(
      (entry) =>
        entry.originManagerId === manager.id &&
        entry.origin.kind === "assignment" &&
        entry.lifecycle.phase === "accepted",
    ) ?? [];
  const selectedRequests = requests.filter((entry) => selected.includes(entry.id));
  const assignmentIds = new Set(
    selectedRequests.flatMap((entry) =>
      entry.origin.kind === "assignment" && entry.lifecycle.phase === "accepted"
        ? [entry.origin.assignmentId, entry.lifecycle.support.assignmentId]
        : [],
    ),
  );
  const participants = state?.assignments.filter((entry) => assignmentIds.has(entry.id)) ?? [];
  const projectIds = [...new Set(participants.map((entry) => entry.projectId))];
  const options = projectIds.map((id) => ({
    value: id,
    label: state?.managers.findLast((entry) => entry.projectId === id)?.name ?? id,
  }));
  const complexities = [
    { value: "small", label: "Small" },
    { value: "standard", label: "Standard" },
    { value: "complex", label: "Complex" },
  ] as const;
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Commission an integration team
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-muted-foreground">
          Select accepted supporting work. A dedicated lead coordinates cross-project QA in an
          isolated workspace. Each project owner grants access separately; production fixes stay
          with the owning team.
        </p>
        <fieldset disabled={command.disabled} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Accepted work requests</legend>
          {requests.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2">
              <Checkbox
                id={`${prefix}-${entry.id}`}
                checked={selected.includes(entry.id)}
                onCheckedChange={(checked) =>
                  setSelected((previous) =>
                    checked ? [...previous, entry.id] : previous.filter((id) => id !== entry.id),
                  )
                }
              />
              <Label htmlFor={`${prefix}-${entry.id}`}>{entry.outcome}</Label>
            </div>
          ))}
          {!requests.length ? (
            <p className="text-sm text-muted-foreground">
              No accepted requests from this manager's implementation teams.
            </p>
          ) : null}
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-title`}>Integration task title</Label>
          <Input
            id={`${prefix}-title`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={command.disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-description`}>QA scope and acceptance conditions</Label>
          <Textarea
            id={`${prefix}-description`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={command.disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-complexity`}>Task complexity</Label>
          <Select
            value={complexity}
            items={complexities}
            disabled={command.disabled}
            onValueChange={(value) => {
              if (value) setComplexity(value);
            }}
          >
            <SelectTrigger id={`${prefix}-complexity`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {complexities.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-coordinator`}>
            Project providing the protected test coordinator
          </Label>
          <Select
            value={coordinator}
            items={options}
            disabled={command.disabled}
            onValueChange={setCoordinator}
          >
            <SelectTrigger id={`${prefix}-coordinator`}>
              <SelectValue placeholder="Select a participating project" />
            </SelectTrigger>
            <SelectPopup>
              {options.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          The manager's approved model policy selects the integration lead. A coordinator capability
          and owner grants are required before execution.
        </p>
        {participants.length !== projectIds.length ? (
          <p role="alert" className="text-sm">
            Select one implementation per project for this integration.
          </p>
        ) : null}
        {command.error ? (
          <p role="alert" className="text-sm text-destructive">
            {command.error}
          </p>
        ) : null}
        <Button
          disabled={
            command.disabled ||
            !title.trim() ||
            !description.trim() ||
            projectIds.length < 2 ||
            participants.length !== projectIds.length ||
            !coordinator ||
            !projectIds.includes(coordinator)
          }
          onClick={() => {
            if (coordinator)
              void command.submit({
                type: "integration.commission",
                managerId: manager.id,
                requestIds: selectedRequests.map((entry) => entry.id),
                title: title.trim(),
                description: description.trim(),
                complexity,
                coordinatorProjectId: coordinator,
              });
          }}
        >
          {command.pending ? "Commissioning…" : "Commission integration team"}
        </Button>
      </div>
    </details>
  );
}
