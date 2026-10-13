import type {
  FactoryCollaborationCondition as Condition,
  FactorySnapshot,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function factoryCollaborationConditionLabel(state: FactorySnapshot, condition: Condition) {
  switch (condition.kind) {
    case "assignment-concluded":
      return `After ${state.assignments.find((entry) => entry.id === condition.assignmentId)?.title ?? condition.assignmentId} concludes`;
    case "incident-released":
      return `After incident ${condition.restrictionId} is released`;
    case "human-decision":
      return `After human decision ${condition.decisionId}`;
  }
}

export function FactoryCollaborationCondition({
  state,
  value,
  onChange,
  disabled,
  label,
}: {
  state: FactorySnapshot;
  value: Condition | null;
  onChange: (condition: Condition | null) => void;
  disabled: boolean;
  label: string;
}) {
  const prefix = useId();
  const [kind, setKind] = useState<Condition["kind"]>(value?.kind ?? "assignment-concluded");
  const selected =
    value === null
      ? null
      : value.kind === "assignment-concluded"
        ? value.assignmentId
        : value.kind === "incident-released"
          ? value.restrictionId
          : value.decisionId;
  const options =
    kind === "assignment-concluded"
      ? state.assignments
          .filter(
            (entry) =>
              entry.kind !== "onboarding" &&
              !entry.outcome &&
              entry.status !== "complete" &&
              entry.completion?.phase !== "concluded",
          )
          .map((entry) => ({ value: entry.id, label: entry.title ?? entry.id }))
      : kind === "incident-released"
        ? state.incidentRestrictions
            .filter((entry) => entry.phase !== "released")
            .map((entry) => ({
              value: entry.id,
              label: `${entry.activity} · ${entry.reason}`,
            }))
        : state.collaborationDecisions
            .filter((entry) => entry.resolution.phase === "pending")
            .map((entry) => ({ value: entry.id, label: entry.summary }));
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <Label className="sr-only" htmlFor={`${prefix}-kind`}>
        Condition type
      </Label>
      <Select
        value={kind}
        items={[
          { value: "assignment-concluded", label: "An assignment concludes" },
          { value: "incident-released", label: "An incident restriction is released" },
          { value: "human-decision", label: "The human resolves a decision" },
        ]}
        disabled={disabled}
        onValueChange={(next) => {
          if (next) {
            setKind(next);
            onChange(null);
          }
        }}
      >
        <SelectTrigger id={`${prefix}-kind`}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="assignment-concluded">An assignment concludes</SelectItem>
          <SelectItem value="incident-released">An incident restriction is released</SelectItem>
          <SelectItem value="human-decision">The human resolves a decision</SelectItem>
        </SelectPopup>
      </Select>
      <Label className="sr-only" htmlFor={`${prefix}-target`}>
        Condition target
      </Label>
      <Select
        value={selected}
        disabled={disabled}
        items={options}
        onValueChange={(id) => {
          if (!id) return onChange(null);
          if (kind === "assignment-concluded") {
            const assignment = state.assignments.find((entry) => entry.id === id);
            if (assignment) onChange({ kind, assignmentId: assignment.id });
          } else if (kind === "incident-released") onChange({ kind, restrictionId: id });
          else onChange({ kind, decisionId: id });
        }}
      >
        <SelectTrigger id={`${prefix}-target`}>
          <SelectValue placeholder="Select the event to wait for" />
        </SelectTrigger>
        <SelectPopup>
          {options.map((entry) => (
            <SelectItem key={entry.value} value={entry.value}>
              {entry.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {!options.length ? (
        <p className="text-sm text-muted-foreground">
          No matching records yet. Choose another condition or create the underlying decision first.
        </p>
      ) : null}
    </fieldset>
  );
}
