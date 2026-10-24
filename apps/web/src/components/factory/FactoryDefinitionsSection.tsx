import type {
  EnvironmentId,
  FactoryDefinitionSaveInput,
  FactoryDefinitionsView,
  FactoryModelList,
  FactoryModelRef,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { FactoryDefinitionActions, confirmFactoryDelete } from "./FactoryDefinitionActions";
import { useFactoryDefinitions } from "./factoryDefinitionsState";
import { summarizeFactoryModelList } from "./factoryModelRefs";
import { FactoryModelListEditor } from "./FactoryModelListEditor";
import type { FactoryModelOption } from "./FactoryPageConfig";
import { PROTOCOL_COPY_WARNING, looksLikeProtocolCopy } from "./factoryProtocolCopy";
import { duplicateDefinitionName } from "./factoryTeamCopies";

type DefinitionKind = "worker" | "lead" | "manager";

interface DefinitionDraft {
  readonly name: string;
  readonly models: FactoryModelList;
  readonly body: string;
}

interface EditRequest {
  readonly kind: DefinitionKind;
  /** Null creates a definition, as New and Duplicate do. */
  readonly id: string | null;
  readonly draft: DefinitionDraft;
}

const KINDS: ReadonlyArray<DefinitionKind> = ["worker", "lead", "manager"];

/** A lead's or manager's added instructions that repeat the built-in protocol, flagged to trim. */
const copiesProtocol = (kind: DefinitionKind, body: string) =>
  kind !== "worker" && looksLikeProtocolCopy(kind, body);

const COPY: Record<
  DefinitionKind,
  {
    readonly title: string;
    readonly noun: string;
    readonly empty: string;
    readonly bodyLabel: string;
    readonly bodyHint: string;
  }
> = {
  worker: {
    title: "Workers",
    noun: "worker",
    empty: "No workers yet. A team copies its members from these.",
    bodyLabel: "Description",
    bodyHint: "What this worker is and does: its whole brief",
  },
  lead: {
    title: "Leads",
    noun: "lead",
    empty: "No leads yet. A team copies its lead from these.",
    bodyLabel: "Added instructions",
    bodyHint: "Added after the fixed lead protocol, which you can't remove",
  },
  manager: {
    title: "Managers",
    noun: "manager",
    empty: "No managers yet.",
    bodyLabel: "Added instructions",
    bodyHint: "Added after the fixed manager protocol, which you can't remove",
  },
};

const EMPTY_DRAFT: DefinitionDraft = { name: "", models: { dynamic: false, models: [] }, body: "" };

function definitionsOf(view: FactoryDefinitionsView, kind: DefinitionKind) {
  return kind === "worker"
    ? view.workers.map((worker) => ({ ...worker, body: worker.description }))
    : (kind === "lead" ? view.leads : view.managers).map((definition) => ({
        ...definition,
        body: definition.instructions,
      }));
}

function saveInput(request: EditRequest): FactoryDefinitionSaveInput {
  const id = request.id === null ? {} : { id: request.id };
  const fields = { name: request.draft.name.trim(), models: request.draft.models };
  const body = request.draft.body.trim();
  return request.kind === "worker"
    ? { kind: "worker", ...id, definition: { ...fields, description: body } }
    : { kind: request.kind, ...id, definition: { ...fields, instructions: body } };
}

/** The factory config's workers, leads and managers, each saved to its own file. */
export function FactoryDefinitionsSection({
  environmentId,
  canEdit,
  modelOptions,
}: {
  readonly environmentId: EnvironmentId;
  readonly canEdit: boolean;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
}) {
  const { view, loadError, save, remove } = useFactoryDefinitions(environmentId);
  const [request, setRequest] = useState<EditRequest | null>(null);
  const [deleteError, setDeleteError] = useState<{
    readonly kind: DefinitionKind;
    readonly message: string;
  } | null>(null);
  const disabled = !canEdit || view === null;

  const deleteDefinition = async (kind: DefinitionKind, id: string, name: string) => {
    const confirmed = await confirmFactoryDelete(
      `Delete the ${COPY[kind].noun} ${name}? Teams hold their own copies, so no team changes.`,
    );
    if (!confirmed) return;
    const failure = await remove(kind, id);
    setDeleteError(failure === null ? null : { kind, message: failure });
  };

  return (
    <>
      {KINDS.map((kind) => (
        <SettingsSection
          key={kind}
          id={`factory-${kind}s`}
          title={COPY[kind].title}
          headerAction={
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() => setRequest({ kind, id: null, draft: EMPTY_DRAFT })}
            >
              <PlusIcon className="size-3" />
              New
            </Button>
          }
        >
          {view === null ? (
            <SettingsRow
              title={loadError === null ? "Loading…" : "Could not load"}
              description={loadError ?? undefined}
            />
          ) : definitionsOf(view, kind).length === 0 ? (
            <SettingsRow
              title={`No ${COPY[kind].title.toLowerCase()}`}
              description={COPY[kind].empty}
            />
          ) : (
            definitionsOf(view, kind).map((definition) => {
              const draft = {
                name: definition.name,
                models: definition.models,
                body: definition.body,
              };
              return (
                <SettingsRow
                  key={definition.id}
                  title={definition.name}
                  description={
                    <>
                      {summarizeFactoryModelList(definition.models, modelOptions)}
                      {copiesProtocol(kind, definition.body) ? (
                        <span className="block text-warning">{PROTOCOL_COPY_WARNING}</span>
                      ) : null}
                    </>
                  }
                  control={
                    <FactoryDefinitionActions
                      name={definition.name}
                      disabled={disabled}
                      onEdit={() => setRequest({ kind, id: definition.id, draft })}
                      onDuplicate={() =>
                        setRequest({
                          kind,
                          id: null,
                          draft: { ...draft, name: duplicateDefinitionName(draft.name) },
                        })
                      }
                      onDelete={() => void deleteDefinition(kind, definition.id, definition.name)}
                    />
                  }
                />
              );
            })
          )}
          {deleteError?.kind === kind ? (
            <SettingsRow title="Could not delete" description={deleteError.message} />
          ) : null}
        </SettingsSection>
      ))}
      <FactoryDefinitionDialog
        request={request}
        pool={view?.settings.modelPool ?? []}
        modelOptions={modelOptions}
        disabled={disabled}
        onSave={save}
        onClose={() => setRequest(null)}
      />
    </>
  );
}

function FactoryDefinitionDialog({
  request,
  pool,
  modelOptions,
  disabled,
  onSave,
  onClose,
}: {
  readonly request: EditRequest | null;
  readonly pool: ReadonlyArray<FactoryModelRef>;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
  readonly disabled: boolean;
  readonly onSave: (input: FactoryDefinitionSaveInput) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        {request ? (
          <DefinitionForm
            key={`${request.kind}:${request.id ?? "new"}`}
            request={request}
            pool={pool}
            modelOptions={modelOptions}
            disabled={disabled}
            onSave={onSave}
            onClose={onClose}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function DefinitionForm({
  request,
  pool,
  modelOptions,
  disabled,
  onSave,
  onClose,
}: {
  readonly request: EditRequest;
  readonly pool: ReadonlyArray<FactoryModelRef>;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
  readonly disabled: boolean;
  readonly onSave: (input: FactoryDefinitionSaveInput) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const copy = COPY[request.kind];
  const [draft, setDraft] = useState(request.draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (draft.name.trim() === "") return setError("Enter a name.");
    setSaving(true);
    const failure = await onSave(saveInput({ ...request, draft }));
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {request.id === null ? `New ${copy.noun}` : `Edit ${request.draft.name}`}
        </DialogTitle>
        <DialogDescription>
          Saved as its own file in the factory config. Teams already holding a copy keep theirs.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} onSubmit={(event) => void submit(event)}>
          <fieldset className="space-y-4" disabled={disabled || saving}>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-name`}>Name</Label>
              <Input
                id={`${formId}-name`}
                autoFocus
                maxLength={80}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Models</Label>
              <FactoryModelListEditor
                label="Models"
                value={draft.models}
                pool={pool}
                modelOptions={modelOptions}
                disabled={disabled || saving}
                onChange={(models) => setDraft({ ...draft, models })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-body`}>{copy.bodyLabel}</Label>
              <p className="text-xs text-muted-foreground">{copy.bodyHint}</p>
              <Textarea
                id={`${formId}-body`}
                rows={6}
                value={draft.body}
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              />
              {copiesProtocol(request.kind, draft.body) ? (
                <Alert variant="warning">
                  <AlertDescription>{PROTOCOL_COPY_WARNING}</AlertDescription>
                </Alert>
              ) : null}
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={disabled || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
