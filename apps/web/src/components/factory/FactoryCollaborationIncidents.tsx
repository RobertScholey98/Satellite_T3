import type {
  FactoryAssignmentId,
  FactoryCollaborationCondition as Condition,
  FactoryIncidentRestriction,
  FactoryManager,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  FactoryCollaborationCondition,
  factoryCollaborationConditionLabel,
} from "./FactoryCollaborationCondition";
import { useFactoryCommand } from "./useFactoryCommand";

export function FactoryCollaborationIncidents({
  environment,
  manager,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
}) {
  const prefix = useId();
  const command = useFactoryCommand(environment);
  const [selected, setSelected] = useState<readonly FactoryAssignmentId[]>([]);
  const [activity, setActivity] = useState<FactoryIncidentRestriction["activity"]>("execution");
  const [reason, setReason] = useState("");
  const [condition, setCondition] = useState<Condition | null>(null);
  const state = environment.data;
  if (!state) return null;
  const assignments = state.assignments.filter(
    (entry) =>
      entry.managerId === manager.id &&
      entry.kind !== "onboarding" &&
      entry.status !== "complete" &&
      !entry.outcome &&
      (!entry.completion || entry.completion.phase === "collecting"),
  );
  const ids = selected.filter((id) => assignments.some((entry) => entry.id === id));
  const restrictions = state.incidentRestrictions.filter((entry) => entry.managerId === manager.id);
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Restrict concrete activity that conflicts with incident recovery. Other teams and new
        unrelated assignments remain available. Releasing a restriction preserves all other pauses,
        takeovers and permission holds.
      </p>
      {!restrictions.length ? (
        <p className="text-sm text-muted-foreground">No incident restrictions for this manager.</p>
      ) : null}
      {restrictions.toReversed().map((restriction) => {
        const failure =
          restriction.stop.phase === "failed"
            ? restriction.stop.reason
            : restriction.resume?.phase === "failed"
              ? restriction.resume.reason
              : null;
        return (
          <section key={restriction.id} className="space-y-2 border-b border-border pb-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <span className="font-medium">{restriction.activity} restriction</span>
              <Badge variant={restriction.phase === "released" ? "outline" : "warning"}>
                {restriction.phase}
              </Badge>
            </div>
            <p className="whitespace-pre-wrap">{restriction.reason}</p>
            <ul className="list-disc pl-5">
              {restriction.assignmentIds.map((id) => (
                <li key={id}>{state.assignments.find((entry) => entry.id === id)?.title ?? id}</li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Resume condition ·{" "}
              {factoryCollaborationConditionLabel(state, restriction.resumeCondition)}
            </p>
            <p className="text-xs text-muted-foreground">
              {restriction.id} · stop {restriction.stop.phase}
              {restriction.resume ? ` · resume ${restriction.resume.phase}` : ""}
            </p>
            {failure ? (
              <>
                <p role="alert" className="text-destructive">
                  {failure}
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={command.disabled}
                  onClick={() =>
                    void command.submit({ type: "incident.retry", restrictionId: restriction.id })
                  }
                >
                  Retry enforcement
                </Button>
              </>
            ) : null}
            {restriction.phase === "active" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={command.disabled || restriction.stop.phase === "pending"}
                onClick={() =>
                  void command.submit({ type: "incident.release", restrictionId: restriction.id })
                }
              >
                Release this restriction
              </Button>
            ) : null}
          </section>
        );
      })}
      {manager.role === "project" ? (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm font-medium">
            Restrict conflicting activity
          </summary>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Affected teams (required)</legend>
            {assignments.map((entry) => (
              <label key={entry.id} className="flex items-start gap-2 text-sm">
                <Checkbox
                  disabled={command.disabled}
                  checked={ids.includes(entry.id)}
                  onCheckedChange={(checked) =>
                    setSelected(checked ? [...ids, entry.id] : ids.filter((id) => id !== entry.id))
                  }
                />
                {entry.title ?? entry.id}
              </label>
            ))}
          </fieldset>
          <Label htmlFor={`${prefix}-activity`}>Blocked activity</Label>
          <Select
            value={activity}
            items={[
              { value: "execution", label: "Team execution" },
              { value: "delivery", label: "Delivery and merge" },
              { value: "preview", label: "Candidate preview" },
            ]}
            disabled={command.disabled}
            onValueChange={(value) => {
              if (value) setActivity(value);
            }}
          >
            <SelectTrigger id={`${prefix}-activity`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="execution">Team execution</SelectItem>
              <SelectItem value="delivery">Delivery and merge</SelectItem>
              <SelectItem value="preview">Candidate preview</SelectItem>
            </SelectPopup>
          </Select>
          <Label htmlFor={`${prefix}-reason`}>Concrete conflict (required)</Label>
          <Textarea
            id={`${prefix}-reason`}
            value={reason}
            disabled={command.disabled}
            maxLength={6000}
            onChange={(event) => setReason(event.target.value)}
          />
          <FactoryCollaborationCondition
            state={state}
            value={condition}
            onChange={setCondition}
            disabled={command.disabled}
            label="Resume condition (required)"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled || !ids.length || !reason.trim() || !condition}
            onClick={() => {
              if (condition)
                void command
                  .submit({
                    type: "incident.restrict",
                    managerId: manager.id,
                    assignmentIds: ids,
                    activity,
                    reason: reason.trim(),
                    resumeCondition: condition,
                  })
                  .then((saved) => {
                    if (saved) {
                      setSelected([]);
                      setReason("");
                      setCondition(null);
                    }
                  });
            }}
          >
            Apply targeted restriction
          </Button>
        </details>
      ) : null}
      {command.pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Updating incident restriction…
        </p>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </div>
  );
}
