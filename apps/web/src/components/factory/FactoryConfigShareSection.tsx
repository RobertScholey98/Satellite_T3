import type {
  EnvironmentId,
  FactoryConfigBundle,
  FactoryImportChoice,
  FactoryImportPreview,
  FactoryModelRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { type ChangeEvent, useRef, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { downloadBytes, unzipFactoryBundle, zipFactoryBundle } from "./factoryConfigFiles";
import { useFactoryDefinitions } from "./factoryDefinitionsState";
import { factoryEnvironment, factoryErrorMessage, unwrapFactoryResult } from "./factoryState";

function failureMessage<A, E>(result: AtomCommandResult<A, E>): string | null {
  try {
    unwrapFactoryResult(result);
    return null;
  } catch (failure) {
    return factoryErrorMessage(failure);
  }
}

const modelKey = (model: FactoryModelRef) => `${model.driver}/${model.model}`;
const itemKey = (item: { readonly kind: string; readonly id: string }) => `${item.kind}:${item.id}`;

const KIND_LABEL = { worker: "Worker", lead: "Lead", manager: "Manager", team: "Team" } as const;
const STATUS_LABEL = { new: "New", same: "Same", differs: "Differs" } as const;
const STATUS_BADGE = { new: "success", same: "secondary", differs: "warning" } as const;
const CHOICE_LABEL: Record<FactoryImportChoice, string> = {
  mine: "Keep mine",
  theirs: "Take theirs",
  both: "Keep both",
};

interface ImportDraft {
  readonly fileName: string;
  readonly bundle: FactoryConfigBundle;
  readonly preview: FactoryImportPreview;
  readonly mode: "merge" | "replace";
  readonly choices: Readonly<Record<string, FactoryImportChoice>>;
  readonly poolAdditions: ReadonlySet<string>;
  readonly recoveryAllowance: "mine" | "theirs";
}

/** Export a factory config as a zip, or import one with a preview of what it changes. */
export function FactoryConfigShareSection({
  environmentId,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly canEdit: boolean;
}) {
  const definitions = useFactoryDefinitions(environmentId);
  const exportConfig = useAtomCommand(factoryEnvironment.exportConfig, { reportFailure: false });
  const previewImport = useAtomCommand(factoryEnvironment.previewConfigImport, {
    reportFailure: false,
  });
  const applyImport = useAtomCommand(factoryEnvironment.applyConfigImport, {
    reportFailure: false,
  });

  const [scope, setScope] = useState<"all" | "teams">("all");
  const [teamIds, setTeamIds] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const teams = definitions.view?.teams ?? [];
  const selectedTeams = teams.filter((team) => teamIds.has(team.id));

  const runExport = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await exportConfig({
      environmentId,
      input:
        scope === "all"
          ? { scope: "all" }
          : { scope: "teams", teamIds: selectedTeams.map((team) => team.id) },
    });
    if (result._tag !== "Success") {
      setBusy(false);
      setError(failureMessage(result));
      return;
    }
    const bytes = await zipFactoryBundle(result.value).catch(() => null);
    setBusy(false);
    if (bytes === null) {
      setError("The export could not be zipped.");
      return;
    }
    const name =
      scope === "all" ? "factory" : selectedTeams.length === 1 ? selectedTeams[0]!.id : "teams";
    downloadBytes(`${name}.satellite-factory.zip`, bytes);
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const bundle = await file
      .arrayBuffer()
      .then(unzipFactoryBundle)
      .catch(() => null);
    if (bundle === null) {
      setBusy(false);
      setError(`${file.name} is not a zip file.`);
      return;
    }
    const result = await previewImport({ environmentId, input: bundle });
    setBusy(false);
    if (result._tag !== "Success") {
      setError(failureMessage(result));
      return;
    }
    setApplyError(null);
    setDraft({
      fileName: file.name,
      bundle,
      preview: result.value,
      mode: "merge",
      choices: {},
      poolAdditions: new Set(),
      recoveryAllowance: "mine",
    });
  };

  const apply = async (current: ImportDraft) => {
    setBusy(true);
    setApplyError(null);
    const result = await applyImport({
      environmentId,
      input: {
        bundle: current.bundle,
        decision: {
          mode: current.mode,
          choices: current.preview.items
            .filter((item) => item.status === "differs")
            .map((item) => ({
              kind: item.kind,
              id: item.id,
              choice: current.choices[itemKey(item)] ?? "mine",
            })),
          poolAdditions: current.preview.poolAdditions.filter((model) =>
            current.poolAdditions.has(modelKey(model)),
          ),
          recoveryAllowance: current.recoveryAllowance,
        },
      },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      setApplyError(failureMessage(result));
      return;
    }
    // The other factory sections read this view, so they show the imported definitions at once.
    definitions.setView(result.value);
    setDraft(null);
    setNotice(`Imported ${current.fileName}.`);
  };

  const disabled = !canEdit || busy;
  const exportDisabled = busy || (scope === "teams" && selectedTeams.length === 0);

  return (
    <SettingsSection title="Share">
      <SettingsRow
        title="Export"
        description="Download definitions as a zip another environment can import. Nothing outside the definitions is included."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={exportDisabled}
            onClick={() => void runExport()}
          >
            Export
          </Button>
        }
      >
        <RadioGroup
          aria-label="What to export"
          value={scope}
          onValueChange={(value) => setScope(value === "teams" ? "teams" : "all")}
        >
          <label className="flex items-center gap-2 text-sm">
            <Radio value="all" />
            The whole config
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Radio value="teams" disabled={teams.length === 0} />
            Selected teams, with the workers and leads they were built from
          </label>
        </RadioGroup>
        {definitions.view === null && definitions.loadError !== null ? (
          <p className="text-sm text-destructive">
            The teams could not be read: {definitions.loadError}
          </p>
        ) : null}
        {scope === "teams" ? (
          <div className="space-y-1.5 pl-6">
            {teams.map((team) => (
              <label key={team.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={teamIds.has(team.id)}
                  onCheckedChange={(checked) => {
                    const next = new Set(teamIds);
                    if (checked) next.add(team.id);
                    else next.delete(team.id);
                    setTeamIds(next);
                  }}
                />
                {team.name}
              </label>
            ))}
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Import"
        description="Pick a .satellite-factory.zip. You see what it changes before anything is saved."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          >
            Choose a zip
          </Button>
        }
      >
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          onChange={(event) => void chooseFile(event)}
        />
      </SettingsRow>
      {error !== null ? <p className="px-4 pb-3 text-sm text-destructive">{error}</p> : null}
      {notice !== null ? <p className="px-4 pb-3 text-sm text-muted-foreground">{notice}</p> : null}
      <ImportDialog
        draft={draft}
        busy={busy}
        error={applyError}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onApply={(current) => void apply(current)}
      />
    </SettingsSection>
  );
}

function ImportDialog({
  draft,
  busy,
  error,
  onChange,
  onCancel,
  onApply,
}: {
  readonly draft: ImportDraft | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onChange: (draft: ImportDraft) => void;
  readonly onCancel: () => void;
  readonly onApply: (draft: ImportDraft) => void;
}) {
  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogPopup>
        {draft === null ? null : (
          <ImportDialogBody
            draft={draft}
            busy={busy}
            error={error}
            onChange={onChange}
            onCancel={onCancel}
            onApply={onApply}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ImportDialogBody({
  draft,
  busy,
  error,
  onChange,
  onCancel,
  onApply,
}: {
  readonly draft: ImportDraft;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onChange: (draft: ImportDraft) => void;
  readonly onCancel: () => void;
  readonly onApply: (draft: ImportDraft) => void;
}) {
  const { preview, mode } = draft;
  const merging = mode === "merge";
  const needing = (model: FactoryModelRef) =>
    preview.items.filter((item) =>
      item.modelsNeedingPool?.some((needed) => modelKey(needed) === modelKey(model)),
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Import {draft.fileName}</DialogTitle>
        <DialogDescription>
          Nothing is saved until you import. A merge keeps your definitions unless you choose
          otherwise.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-5">
          <RadioGroup
            aria-label="How to import"
            value={mode}
            onValueChange={(value) =>
              onChange({ ...draft, mode: value === "replace" ? "replace" : "merge" })
            }
          >
            <label className="flex items-center gap-2 text-sm">
              <Radio value="merge" />
              Merge into this config
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Radio value="replace" />
              Replace this config
            </label>
          </RadioGroup>
          {!merging ? (
            <Alert variant="warning">
              <AlertDescription>
                Replace backs up the current config first, beside the config folder, then swaps in
                the imported one.
              </AlertDescription>
            </Alert>
          ) : null}

          <ul className="space-y-1.5">
            {preview.items.map((item) => (
              <li key={itemKey(item)} className="flex items-center gap-2 text-sm">
                <Badge size="sm" variant="outline">
                  {KIND_LABEL[item.kind]}
                </Badge>
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <Badge size="sm" variant={STATUS_BADGE[item.status]}>
                  {STATUS_LABEL[item.status]}
                </Badge>
                {merging && item.status === "differs" ? (
                  <Select
                    value={draft.choices[itemKey(item)] ?? "mine"}
                    onValueChange={(value) =>
                      onChange({
                        ...draft,
                        choices: {
                          ...draft.choices,
                          [itemKey(item)]: value as FactoryImportChoice,
                        },
                      })
                    }
                  >
                    <SelectTrigger size="sm" aria-label={`${item.name}: what to keep`}>
                      <SelectValue>
                        {(value: FactoryImportChoice) => CHOICE_LABEL[value]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {(["mine", "theirs", "both"] as const).map((choice) => (
                        <SelectItem key={choice} value={choice}>
                          {CHOICE_LABEL[choice]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
              </li>
            ))}
          </ul>

          {preview.poolAdditions.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Models to add to the pool</p>
              {preview.poolAdditions.map((model) => {
                const key = modelKey(model);
                // A flagged item would be left out entirely rather than lose a model.
                const skipped = needing(model).filter((item) => item.skippedUnlessPoolAdded);
                const losers = needing(model)
                  .filter((item) => !item.skippedUnlessPoolAdded)
                  .map((item) => item.name);
                return (
                  <div key={key} className="space-y-0.5">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={draft.poolAdditions.has(key)}
                        onCheckedChange={(checked) => {
                          const next = new Set(draft.poolAdditions);
                          if (checked) next.add(key);
                          else next.delete(key);
                          onChange({ ...draft, poolAdditions: next });
                        }}
                      />
                      <span className="font-mono">{key}</span>
                    </label>
                    {draft.poolAdditions.has(key)
                      ? null
                      : skipped.map((item) => (
                          <p key={itemKey(item)} className="pl-6 text-xs text-muted-foreground">
                            {item.name}: skipped unless you add its models to the pool.
                          </p>
                        ))}
                    {losers.length > 0 && !draft.poolAdditions.has(key) ? (
                      <p className="pl-6 text-xs text-muted-foreground">
                        Without it, {losers.join(", ")} lose this model.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {merging && preview.recoveryAllowance.mine !== preview.recoveryAllowance.theirs ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Recovery allowance</p>
              <RadioGroup
                aria-label="Recovery allowance"
                value={draft.recoveryAllowance}
                onValueChange={(value) =>
                  onChange({ ...draft, recoveryAllowance: value === "theirs" ? "theirs" : "mine" })
                }
              >
                <label className="flex items-center gap-2 text-sm">
                  <Radio value="mine" />
                  Keep mine: {preview.recoveryAllowance.mine}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Radio value="theirs" />
                  Take theirs: {preview.recoveryAllowance.theirs}
                </label>
              </RadioGroup>
            </div>
          ) : null}

          {preview.problems.length > 0 ? (
            <Alert variant="warning">
              <AlertDescription>
                <p>These files are skipped:</p>
                <ul>
                  {preview.problems.map((problem) => (
                    <li key={problem.path}>
                      <span className="font-mono">{problem.path}</span>: {problem.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={merging ? "default" : "destructive"}
          disabled={busy}
          onClick={() => onApply(draft)}
        >
          {merging ? "Import" : "Back up and replace"}
        </Button>
      </DialogFooter>
    </>
  );
}
