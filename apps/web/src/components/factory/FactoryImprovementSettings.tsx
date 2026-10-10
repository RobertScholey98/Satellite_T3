import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { useFactoryCommand } from "./useFactoryCommand";

const fields = [
  {
    key: "routineThreshold",
    title: "Findings per routine review",
    min: 1,
    max: 1000,
    help: "Seal a routine batch when this many selected findings are waiting.",
  },
  {
    key: "maxAgeHours",
    title: "Maximum wait in hours",
    min: 1,
    max: 168,
    help: "Review a smaller backlog after this age, within the routine budget.",
  },
  {
    key: "sampleEvery",
    title: "Sample every N local findings",
    min: 1,
    max: 100,
    help: "Sample separately within each project. A value of 1 includes every local finding.",
  },
  {
    key: "maxBatchItems",
    title: "Maximum findings in one batch",
    min: 1,
    max: 20,
    help: "A manager turn receives at most this many finding summaries.",
  },
  {
    key: "maxSummaryChars",
    title: "Maximum summary characters",
    min: 1000,
    max: 16000,
    help: "Caps the batch summary. Detailed evidence is retrieved for a named investigation.",
  },
  {
    key: "routineBatchesPerDay",
    title: "Routine batches per UTC day",
    min: 0,
    max: 24,
    help: "Zero holds routine reviews. Explicit escalations use their prompt path and remain bounded.",
  },
] as const;

export function FactoryImprovementSettings({
  environment,
}: {
  environment: FactoryEnvironmentView;
}) {
  const current = environment.data?.improvementConfigurations.at(-1);
  return (
    <ReviewSettings
      key={`${environment.environmentId}:${current?.id ?? "defaults"}`}
      environment={environment}
    />
  );
}

function ReviewSettings({ environment }: { environment: FactoryEnvironmentView }) {
  const prefix = useId();
  const current = environment.data?.improvementConfigurations.at(-1);
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, settingsScope);
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [values, setValues] = useState<Record<(typeof fields)[number]["key"], number | null>>({
    routineThreshold: current?.routineThreshold ?? 10,
    maxAgeHours: current?.maxAgeHours ?? 24,
    sampleEvery: current?.sampleEvery ?? 5,
    maxBatchItems: current?.maxBatchItems ?? 20,
    maxSummaryChars: current?.maxSummaryChars ?? 16000,
    routineBatchesPerDay: current?.routineBatchesPerDay ?? 2,
  });
  const [message, setMessage] = useState<string | null>(null);
  const save = async () => {
    setMessage(null);
    for (const field of fields) {
      const value = values[field.key];
      if (value === null || !Number.isInteger(value) || value < field.min || value > field.max) {
        setMessage(`${field.title} must be a whole number from ${field.min} to ${field.max}.`);
        return;
      }
    }
    if (
      await command.submit({
        type: "improvement.configure",
        enabled,
        routineThreshold: values.routineThreshold!,
        maxAgeHours: values.maxAgeHours!,
        sampleEvery: values.sampleEvery!,
        maxBatchItems: values.maxBatchItems!,
        maxSummaryChars: values.maxSummaryChars!,
        routineBatchesPerDay: values.routineBatchesPerDay!,
      })
    )
      setMessage("Review settings saved.");
  };
  return (
    <section className="space-y-4" aria-label="Shared review settings" aria-busy={command.pending}>
      <p className="text-sm text-muted-foreground">
        Review summaries in bounded groups. Explicit escalations receive prompt attention; routine
        reviews include samples of apparently local problems. These limits count batches and input
        characters, not provider tokens.
      </p>
      {current ? (
        <p className="text-xs text-muted-foreground">Last approved {current.approvedAt}.</p>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={enabled} disabled={command.disabled} onCheckedChange={setEnabled} />
        Enable shared evidence review
      </label>
      <p className="text-xs text-muted-foreground">
        Disabling delivery preserves incoming evidence. A paused system manager also holds review
        delivery.
      </p>
      {fields.map((field) => (
        <div key={field.key} className="space-y-2">
          <Label htmlFor={`${prefix}-${field.key}`}>{field.title}</Label>
          <NumberField
            id={`${prefix}-${field.key}`}
            min={field.min}
            max={field.max}
            step={1}
            value={values[field.key]}
            disabled={command.disabled}
            onValueChange={(value) =>
              setValues((previous) => ({ ...previous, [field.key]: value }))
            }
          >
            <NumberFieldGroup>
              <NumberFieldInput />
            </NumberFieldGroup>
          </NumberField>
          <p className="text-xs text-muted-foreground">{field.help}</p>
        </div>
      ))}
      <Button variant="outline" size="sm" disabled={command.disabled} onClick={() => void save()}>
        {command.pending ? "Saving…" : "Save review settings"}
      </Button>
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
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
