import {
  AuthSettingsWriteScope,
  type FactoryCollaborationDecision,
  type FactoryCrossProjectRequest,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useFactoryCommand } from "./useFactoryCommand";

function Decision({
  environment,
  decision,
}: {
  environment: FactoryEnvironmentView;
  decision: FactoryCollaborationDecision;
}) {
  const prefix = useId();
  const permission = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, permission);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const resolution = decision.resolution;
  return (
    <section className="space-y-3 border-b border-border pb-4">
      <div className="flex flex-wrap gap-2">
        <h3 className="text-sm font-medium">{decision.summary}</h3>
        <Badge variant={decision.resolution.phase === "pending" ? "warning" : "outline"}>
          {decision.resolution.phase}
        </Badge>
      </div>
      <p className="break-all text-xs text-muted-foreground">
        Decision {decision.id} · revision {decision.revision} · requests{" "}
        {decision.requestIds.join(", ")}
      </p>
      <ul className="list-disc space-y-2 pl-5 text-sm">
        {decision.options.map((option) => (
          <li key={option.id}>{option.description}</li>
        ))}
      </ul>
      {decision.recommendations.map((recommendation) => (
        <p key={recommendation.authorThreadId ?? "human"} className="text-sm text-muted-foreground">
          {recommendation.authorThreadId ?? "Human"} recommends · {recommendation.text}
        </p>
      ))}
      {decision.resolution.phase === "decided" ? (
        <p className="text-sm">
          Selected{" "}
          {decision.options.find(
            (entry) => resolution.phase === "decided" && entry.id === resolution.optionId,
          )?.description ?? decision.resolution.optionId}{" "}
          · {decision.resolution.reason}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Your decision sets the shared direction. Owning managers must still obtain any separate
            scope or permission changes. Unaffected work continues.
          </p>
          <Label htmlFor={`${prefix}-option`}>Selected option (required)</Label>
          <Select
            value={optionId}
            disabled={command.disabled}
            items={decision.options.map((entry) => ({ value: entry.id, label: entry.description }))}
            onValueChange={setOptionId}
          >
            <SelectTrigger id={`${prefix}-option`}>
              <SelectValue placeholder="Choose the combined direction" />
            </SelectTrigger>
            <SelectPopup>
              {decision.options.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.description}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Label htmlFor={`${prefix}-reason`}>Decision reason (required)</Label>
          <Textarea
            id={`${prefix}-reason`}
            value={reason}
            maxLength={6000}
            disabled={command.disabled}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled || !optionId || !reason.trim()}
            onClick={() => {
              if (optionId)
                void command.submit({
                  type: "collaboration.decision.decide",
                  decisionId: decision.id,
                  revision: decision.revision,
                  optionId,
                  reason: reason.trim(),
                });
            }}
          >
            Decide this exact revision
          </Button>
          {!permission ? (
            <p className="text-sm text-muted-foreground">
              Settings-write permission is required for the consolidated human decision.
            </p>
          ) : null}
        </>
      )}
      {command.pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Recording decision…
        </p>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}

export function FactoryCollaborationDecisions({
  environment,
  requests,
}: {
  environment: FactoryEnvironmentView;
  requests: readonly FactoryCrossProjectRequest[];
}) {
  const prefix = useId();
  const command = useFactoryCommand(environment);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [summary, setSummary] = useState("");
  const [optionA, setOptionA] = useState("");
  const [optionB, setOptionB] = useState("");
  const [recommendation, setRecommendation] = useState("");
  const eligible = requests.filter((entry) => entry.lifecycle.phase !== "withdrawn");
  const ids = selected.filter((id) => eligible.some((entry) => entry.id === id));
  const decisions =
    environment.data?.collaborationDecisions.filter((entry) =>
      entry.requestIds.some((id) => requests.some((request) => request.id === id)),
    ) ?? [];
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        One shared decision brings the competing requests and recommendations together. Neither
        manager can override the other.
      </p>
      {!decisions.length ? (
        <p className="text-sm text-muted-foreground">
          No consolidated decisions for these requests.
        </p>
      ) : null}
      {decisions.toReversed().map((entry) => (
        <Decision
          key={`${entry.id}:${entry.revision}`}
          environment={environment}
          decision={entry}
        />
      ))}
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">
          Raise a consolidated decision
        </summary>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Affected requests (required)</legend>
          {eligible.map((entry) => (
            <label key={entry.id} className="flex items-start gap-2 text-sm">
              <Checkbox
                disabled={command.disabled}
                checked={ids.includes(entry.id)}
                onCheckedChange={(checked) =>
                  setSelected(checked ? [...ids, entry.id] : ids.filter((id) => id !== entry.id))
                }
              />
              {entry.outcome}
            </label>
          ))}
        </fieldset>
        {(
          [
            ["summary", "Trade-off (required)", summary, setSummary],
            ["a", "First option (required)", optionA, setOptionA],
            ["b", "Second option (required)", optionB, setOptionB],
            ["recommendation", "Recommendation (required)", recommendation, setRecommendation],
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
          variant="outline"
          disabled={
            command.disabled ||
            !ids.length ||
            !summary.trim() ||
            !optionA.trim() ||
            !optionB.trim() ||
            !recommendation.trim()
          }
          onClick={() =>
            void command
              .submit({
                type: "collaboration.decision.raise",
                requestIds: ids,
                summary: summary.trim(),
                options: [
                  { id: "option-1", description: optionA.trim() },
                  { id: "option-2", description: optionB.trim() },
                ],
                recommendation: recommendation.trim(),
              })
              .then((saved) => {
                if (saved) {
                  setSelected([]);
                  setSummary("");
                  setOptionA("");
                  setOptionB("");
                  setRecommendation("");
                }
              })
          }
        >
          Bring requests into one decision
        </Button>
      </details>
      {command.pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saving decision request…
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
