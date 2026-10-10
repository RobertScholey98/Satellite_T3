import type { FactoryManager, ThreadId } from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useFactoryCommand } from "./useFactoryCommand";

export function FactoryCollaborationCreate({
  environment,
  manager,
  onCreated,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  onCreated: () => void;
}) {
  const prefix = useId();
  const command = useFactoryCommand(environment);
  const [originKind, setOriginKind] = useState<"assignment" | "investigation">("assignment");
  const [originId, setOriginId] = useState<string | null>(null);
  const [receiverId, setReceiverId] = useState<ThreadId | null>(null);
  const [outcome, setOutcome] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [compatibility, setCompatibility] = useState("");
  const state = environment.data;
  const assignments =
    state?.assignments.filter(
      (entry) =>
        entry.managerId === manager.id &&
        entry.kind !== "onboarding" &&
        entry.status !== "complete" &&
        !entry.outcome &&
        (!entry.completion || entry.completion.phase === "collecting"),
    ) ?? [];
  const investigations =
    manager.role === "system"
      ? (state?.improvementInvestigations.filter((entry) => entry.lifecycle.phase !== "closed") ??
        [])
      : [];
  const receivers =
    state?.managers.filter((entry) => entry.role === "project" && entry.id !== manager.id) ?? [];
  const assignment = assignments.find((entry) => entry.id === originId);
  const investigation = investigations.find((entry) => entry.id === originId);
  const origins =
    originKind === "assignment"
      ? assignments.map((entry) => ({
          value: entry.id,
          label: `${entry.title ?? entry.id} · lead ${entry.threadId}`,
        }))
      : investigations.map((entry) => ({ value: entry.id, label: entry.title }));
  const validOrigin = originKind === "assignment" ? !!assignment : !!investigation;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Request an outcome from a peer manager. The receiver decides how to staff it within its own
        project. This does not grant access to the other project's files or tools.
      </p>
      {manager.role === "system" ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-kind`}>Request origin</Label>
          <Select
            value={originKind}
            items={[
              { value: "assignment", label: "Existing shared implementation" },
              { value: "investigation", label: "Shared process investigation" },
            ]}
            disabled={command.disabled}
            onValueChange={(value) => {
              if (value) {
                setOriginKind(value);
                setOriginId(null);
              }
            }}
          >
            <SelectTrigger id={`${prefix}-kind`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="assignment">Existing shared implementation</SelectItem>
              <SelectItem value="investigation">Shared process investigation</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-origin`}>Originating work (required)</Label>
        <Select
          value={originId}
          disabled={command.disabled}
          items={origins}
          onValueChange={setOriginId}
        >
          <SelectTrigger id={`${prefix}-origin`}>
            <SelectValue placeholder="Select originating work" />
          </SelectTrigger>
          <SelectPopup>
            {origins.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {!origins.length ? (
          <p className="text-sm text-muted-foreground">
            No eligible{" "}
            {originKind === "assignment" ? "implementation assignments" : "investigations"} for this
            manager.
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-receiver`}>Receiving project manager (required)</Label>
        <Select
          value={receiverId}
          disabled={command.disabled}
          items={receivers.map((entry) => ({ value: entry.id, label: entry.name }))}
          onValueChange={setReceiverId}
        >
          <SelectTrigger id={`${prefix}-receiver`}>
            <SelectValue placeholder="Select a peer manager" />
          </SelectTrigger>
          <SelectPopup>
            {receivers.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name} · {entry.status}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {(
        [
          ["outcome", "Requested outcome (required)", outcome, setOutcome],
          ["acceptance", "Acceptance conditions (required)", acceptance, setAcceptance],
          [
            "compatibility",
            "Compatibility commitments (required)",
            compatibility,
            setCompatibility,
          ],
        ] as const
      ).map(([key, label, value, update]) => (
        <div key={key} className="space-y-1.5">
          <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
          <Textarea
            id={`${prefix}-${key}`}
            value={value}
            disabled={command.disabled}
            maxLength={6000}
            onChange={(event) => update(event.target.value)}
          />
        </div>
      ))}
      <Button
        size="sm"
        disabled={
          command.disabled ||
          !validOrigin ||
          !receivers.some((entry) => entry.id === receiverId) ||
          !outcome.trim() ||
          !acceptance.trim() ||
          !compatibility.trim()
        }
        onClick={() => {
          if (!receiverId || !validOrigin) return;
          const origin =
            originKind === "assignment" && assignment
              ? { kind: "assignment" as const, assignmentId: assignment.id }
              : investigation
                ? { kind: "investigation" as const, investigationId: investigation.id }
                : null;
          if (origin)
            void command
              .submit({
                type: "collaboration.request.create",
                origin,
                receiverManagerId: receiverId,
                outcome: outcome.trim(),
                acceptanceConditions: acceptance.trim(),
                compatibility: compatibility.trim(),
              })
              .then((saved) => {
                if (saved) onCreated();
              });
        }}
      >
        {command.pending ? "Sending request…" : "Send work request"}
      </Button>
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </div>
  );
}
