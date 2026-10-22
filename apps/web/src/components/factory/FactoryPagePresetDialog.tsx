import type { FactoryTeamMember, FactoryTeamPreset, ModelSelection } from "@t3tools/contracts";
import { useId, useState } from "react";

import { randomUUID } from "~/lib/utils";
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
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Textarea } from "../ui/textarea";
import { FACTORY_ROLE_LABELS, factoryMemberCounts } from "./FactoryPageConfig";
import { FactoryModelAllowList, type FactoryPoolModel } from "./FactoryPageModelControls";

/** Which preset the editor opens on; `preset` is null for Add team. */
export interface FactoryPresetRequest {
  readonly preset: FactoryTeamPreset | null;
  /** Saving makes a new preset (a project's copy of an environment preset) instead of editing. */
  readonly copy: boolean;
  readonly removable: boolean;
}

const MAX_MEMBERS = 8;

export function FactoryPagePresetDialog({
  request,
  pool,
  disabled,
  nameTaken,
  onSave,
  onDelete,
  onClose,
}: {
  readonly request: FactoryPresetRequest | null;
  readonly pool: ReadonlyArray<FactoryPoolModel>;
  readonly disabled: boolean;
  readonly nameTaken: (name: string, id: string | null) => boolean;
  readonly onSave: (previousId: string | null, preset: FactoryTeamPreset) => void;
  readonly onDelete: (id: string) => void;
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
          <PresetForm
            key={request.preset?.id ?? "new"}
            request={request}
            pool={pool}
            disabled={disabled}
            nameTaken={nameTaken}
            onSave={onSave}
            onDelete={onDelete}
            onClose={onClose}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function PresetForm({
  request,
  pool,
  disabled,
  nameTaken,
  onSave,
  onDelete,
  onClose,
}: {
  readonly request: FactoryPresetRequest;
  readonly pool: ReadonlyArray<FactoryPoolModel>;
  readonly disabled: boolean;
  readonly nameTaken: (name: string, id: string | null) => boolean;
  readonly onSave: (previousId: string | null, preset: FactoryTeamPreset) => void;
  readonly onDelete: (id: string) => void;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const initial = request.preset;
  const [name, setName] = useState(initial?.name ?? "");
  const [useWhen, setUseWhen] = useState(initial?.useWhen ?? "");
  const [workflow, setWorkflow] = useState(initial?.workflow ?? "");
  const [members, setMembers] = useState(() => factoryMemberCounts(initial?.members ?? []));
  const [error, setError] = useState<string | null>(null);
  const previousId = request.copy ? null : (initial?.id ?? null);

  const setMember = (
    role: FactoryTeamMember["role"],
    patch: { count?: number; models?: ReadonlyArray<ModelSelection> },
  ) =>
    setMembers(members.map((member) => (member.role === role ? { ...member, ...patch } : member)));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Enter a name.");
    if (trimmed.length > 80) return setError("Use at most 80 characters for the name.");
    if (nameTaken(trimmed, previousId)) return setError(`A team named ${trimmed} already exists.`);
    const staffed = members.filter((member) => member.count > 0);
    if (staffed.length === 0) return setError("Add at least one member.");
    onSave(previousId, {
      id: previousId ?? randomUUID(),
      name: trimmed,
      useWhen: useWhen.trim(),
      members: staffed.map((member) => ({
        role: member.role,
        count: member.count,
        ...(member.models.length > 0 ? { models: member.models } : {}),
      })),
      workflow: workflow.trim(),
      createdBy: request.copy ? "user" : (initial?.createdBy ?? "user"),
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{initial === null ? "Add team" : `Edit ${initial.name}`}</DialogTitle>
        <DialogDescription>
          {request.copy
            ? "Saving adds this project's own copy, which replaces the environment team of the same name here."
            : "The manager picks a team for each ticket, and the lead staffs it from these members."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} onSubmit={submit}>
          <fieldset className="space-y-4" disabled={disabled}>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-name`}>Name</Label>
              <Input
                id={`${formId}-name`}
                autoFocus
                placeholder="Standard"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-use-when`}>When to use</Label>
              <Textarea
                id={`${formId}-use-when`}
                rows={2}
                placeholder="Most tickets"
                value={useWhen}
                onChange={(event) => setUseWhen(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Members</Label>
              <p className="text-xs text-muted-foreground">
                Every team has a lead. Limit a member to some pool models, or leave it on any.
              </p>
              {members.map((member) => (
                <div key={member.role} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-24 flex-1 text-sm">
                    {FACTORY_ROLE_LABELS[member.role]}
                  </span>
                  <NumberField
                    value={member.count}
                    min={0}
                    max={MAX_MEMBERS}
                    size="sm"
                    className="w-28"
                    onValueChange={(value) =>
                      setMember(member.role, {
                        count: Math.min(MAX_MEMBERS, Math.max(0, Math.round(value ?? 0))),
                      })
                    }
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement
                        aria-label={`Fewer ${FACTORY_ROLE_LABELS[member.role]}s`}
                      />
                      <NumberFieldInput aria-label={`${FACTORY_ROLE_LABELS[member.role]} count`} />
                      <NumberFieldIncrement
                        aria-label={`More ${FACTORY_ROLE_LABELS[member.role]}s`}
                      />
                    </NumberFieldGroup>
                  </NumberField>
                  <FactoryModelAllowList
                    label={`${FACTORY_ROLE_LABELS[member.role]} models`}
                    pool={pool}
                    value={member.models}
                    disabled={disabled || member.count === 0}
                    onChange={(models) => setMember(member.role, { models })}
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-workflow`}>Workflow</Label>
              <Textarea
                id={`${formId}-workflow`}
                rows={4}
                placeholder="Implement, then review, then verify against the ticket."
                value={workflow}
                onChange={(event) => setWorkflow(event.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        {initial !== null && request.removable ? (
          <Button
            type="button"
            variant="destructive-outline"
            className="mr-auto"
            disabled={disabled}
            onClick={() => onDelete(initial.id)}
          >
            Delete
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={disabled}>
          {initial === null ? "Add team" : "Done"}
        </Button>
      </DialogFooter>
    </>
  );
}
