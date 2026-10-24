import type {
  EnvironmentId,
  FactoryDefinitionSaveInput,
  FactoryDefinitionsView,
  FactoryLeadDefinition,
  FactoryTeamMemberDraft,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { FactoryCountField } from "./FactoryCountField";
import { FactoryDefinitionActions, confirmFactoryDelete } from "./FactoryDefinitionActions";
import { useFactoryDefinitions } from "./factoryDefinitionsState";
import { factoryEnvironment } from "./factoryState";
import { factoryTeamDeleteMessage } from "./factoryTeamDelete";
import { FactoryModelListEditor } from "./FactoryModelListEditor";
import type { FactoryModelOption } from "./FactoryPageConfig";
import {
  EMPTY_TEAM_DRAFT,
  type FactoryTeamDraft,
  factoryTeamSummary,
  memberFromWorker,
  teamDraftFrom,
  teamDraftProblem,
  teamSaveInput,
} from "./factoryTeamCopies";

interface TeamRequest {
  /** Null creates a team, as New and Duplicate do. */
  readonly id: string | null;
  readonly title: string;
  readonly draft: FactoryTeamDraft;
}

const MAX_MEMBER_COUNT = 8;

/** The factory config's teams. Each holds copies of a lead and of workers, never references. */
export function FactoryTeamsFileSection({
  environmentId,
  canEdit,
  modelOptions,
}: {
  readonly environmentId: EnvironmentId;
  readonly canEdit: boolean;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
}) {
  const { view, loadError, save, remove } = useFactoryDefinitions(environmentId);
  const teamUses = useAtomCommand(factoryEnvironment.teamUses, { reportFailure: false });
  const [request, setRequest] = useState<TeamRequest | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const disabled = !canEdit || view === null;

  const deleteTeam = async (id: string, name: string) => {
    const uses = await teamUses({ environmentId, input: { teamId: id } });
    const confirmed = await confirmFactoryDelete(
      factoryTeamDeleteMessage({
        name,
        uses: uses._tag === "Success" ? uses.value : null,
        lastTeam: view !== null && view.teams.length === 1 && view.teams[0]!.id === id,
      }),
    );
    if (confirmed) setDeleteError(await remove("team", id));
  };

  return (
    <SettingsSection
      id="factory-teams-file"
      title="Teams"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => setRequest({ id: null, title: "New team", draft: EMPTY_TEAM_DRAFT })}
        >
          <PlusIcon className="size-3" />
          New
        </Button>
      }
    >
      {view !== null && view.problems.length > 0 ? (
        <SettingsRow
          title="Some files could not be used"
          description="They are skipped until fixed. The rest of the config still works."
        >
          <ul className="flex flex-col gap-1 pb-3.5 text-sm">
            {view.problems.map((problem) => (
              <li key={`${problem.path}:${problem.message}`}>
                <code>{problem.path}</code>{" "}
                <span className="text-muted-foreground">{problem.message}</span>
              </li>
            ))}
          </ul>
        </SettingsRow>
      ) : null}
      {deleteError !== null ? (
        <SettingsRow title="Could not delete" description={deleteError} />
      ) : null}
      {view === null ? (
        <SettingsRow
          title={loadError === null ? "Loading…" : "Could not load"}
          description={loadError ?? undefined}
        />
      ) : view.teams.length === 0 ? (
        <SettingsRow
          title="No teams"
          description="A team copies a lead and workers. Add workers and a lead first."
        />
      ) : (
        view.teams.map((team) => (
          <SettingsRow
            key={team.id}
            title={team.name}
            description={factoryTeamSummary(team)}
            control={
              <FactoryDefinitionActions
                name={team.name}
                disabled={disabled}
                onEdit={() =>
                  setRequest({
                    id: team.id,
                    title: `Edit ${team.name}`,
                    draft: teamDraftFrom(team, false),
                  })
                }
                onDuplicate={() =>
                  setRequest({ id: null, title: "New team", draft: teamDraftFrom(team, true) })
                }
                onDelete={() => void deleteTeam(team.id, team.name)}
              />
            }
          />
        ))
      )}
      <Dialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) setRequest(null);
        }}
      >
        <DialogPopup>
          {request !== null && view !== null ? (
            <TeamForm
              key={request.id ?? "new"}
              request={request}
              view={view}
              modelOptions={modelOptions}
              disabled={disabled}
              onSave={save}
              onClose={() => setRequest(null)}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

/** Members keep a local key, since a new copy has no id until the server derives one. */
interface KeyedMember {
  readonly key: string;
  readonly member: FactoryTeamMemberDraft;
}

function TeamForm({
  request,
  view,
  modelOptions,
  disabled,
  onSave,
  onClose,
}: {
  readonly request: TeamRequest;
  readonly view: FactoryDefinitionsView;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
  readonly disabled: boolean;
  readonly onSave: (input: FactoryDefinitionSaveInput) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const [team, setTeam] = useState(request.draft);
  const [members, setMembers] = useState<ReadonlyArray<KeyedMember>>(() =>
    request.draft.members.map((member) => ({ key: randomUUID(), member })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pool = view.settings.modelPool;
  const busy = disabled || saving;
  const draft: FactoryTeamDraft = { ...team, members: members.map(({ member }) => member) };

  const setMember = (key: string, patch: Partial<FactoryTeamMemberDraft>) =>
    setMembers(
      members.map((entry) =>
        entry.key === key ? { key, member: { ...entry.member, ...patch } } : entry,
      ),
    );

  const setLead = (patch: Partial<FactoryLeadDefinition>) => {
    if (team.lead !== null) setTeam({ ...team, lead: { ...team.lead, ...patch } });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = teamDraftProblem(draft);
    if (problem !== null || draft.lead === null) return setError(problem);
    setSaving(true);
    const failure = await onSave(teamSaveInput({ ...draft, lead: draft.lead }, request.id));
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{request.title}</DialogTitle>
        <DialogDescription>
          The manager picks a team for each ticket, and its lead staffs the work from these members.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} onSubmit={(event) => void submit(event)}>
          <fieldset className="space-y-4" disabled={busy}>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-name`}>Name</Label>
              <Input
                id={`${formId}-name`}
                autoFocus
                maxLength={80}
                value={team.name}
                onChange={(event) => setTeam({ ...team, name: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-use-when`}>Use when</Label>
              <Textarea
                id={`${formId}-use-when`}
                rows={2}
                placeholder="Most tickets"
                value={team.useWhen}
                onChange={(event) => setTeam({ ...team, useWhen: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-workflow`}>How the team works</Label>
              <Textarea
                id={`${formId}-workflow`}
                rows={4}
                placeholder="Implement, then review, then verify against the ticket."
                value={team.workflow}
                onChange={(event) => setTeam({ ...team, workflow: event.target.value })}
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Switch
                size="sm"
                checked={team.mayEditProtectedPaths}
                disabled={busy}
                onCheckedChange={(mayEditProtectedPaths) =>
                  setTeam({ ...team, mayEditProtectedPaths })
                }
              />
              <span className="flex flex-col">
                <span>May edit protected paths</span>
                <span className="text-xs text-muted-foreground">
                  For teams whose job is the workflow itself
                </span>
              </span>
            </label>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Lead</Label>
                <Menu>
                  <MenuTrigger
                    disabled={busy || view.leads.length === 0}
                    render={<Button size="xs" variant="outline" />}
                  >
                    {team.lead === null ? "Choose lead" : "Replace with a copy of…"}
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {view.leads.map((lead) => (
                      <MenuItem key={lead.id} onClick={() => setTeam({ ...team, lead })}>
                        {lead.name}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              </div>
              {team.lead === null ? (
                <p className="text-xs text-muted-foreground">
                  {view.leads.length === 0
                    ? "Add a lead under Leads first. The team keeps its own copy."
                    : "Choose a lead to copy into this team."}
                </p>
              ) : (
                <div className="space-y-2 rounded-md border p-3">
                  <Input
                    aria-label="Lead name"
                    maxLength={80}
                    value={team.lead.name}
                    onChange={(event) => setLead({ name: event.target.value })}
                  />
                  <FactoryModelListEditor
                    label="Lead models"
                    value={team.lead.models}
                    pool={pool}
                    modelOptions={modelOptions}
                    disabled={busy}
                    onChange={(models) => setLead({ models })}
                  />
                  <Textarea
                    aria-label="Lead added instructions"
                    rows={3}
                    placeholder="Added after the fixed lead protocol, which you can't remove"
                    value={team.lead.instructions}
                    onChange={(event) => setLead({ instructions: event.target.value })}
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Members</Label>
                <Menu>
                  <MenuTrigger
                    disabled={busy || view.workers.length === 0}
                    render={<Button size="xs" variant="outline" />}
                  >
                    <PlusIcon />
                    Add member
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {view.workers.map((worker) => (
                      <MenuItem
                        key={worker.id}
                        onClick={() =>
                          setMembers([
                            ...members,
                            {
                              key: randomUUID(),
                              member: memberFromWorker(
                                worker,
                                members.map(({ member }) => member),
                              ),
                            },
                          ])
                        }
                      >
                        {worker.name}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              </div>
              <p className="text-xs text-muted-foreground">
                Members are copies. Editing a worker later doesn't change this team. A lead
                delegates by member name, so each name is unique in the team.
              </p>
              {members.map(({ key, member }, index) => {
                const n = index + 1;
                return (
                  <div key={key} className="space-y-2 rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <Input
                          aria-label={`Member ${n} name`}
                          maxLength={80}
                          value={member.name}
                          onChange={(event) => setMember(key, { name: event.target.value })}
                        />
                      </div>
                      <FactoryCountField
                        label={`Member ${n} count`}
                        value={member.count}
                        min={1}
                        max={MAX_MEMBER_COUNT}
                        disabled={busy}
                        onChange={(count) => setMember(key, { count })}
                      />
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Remove member ${n}`}
                        onClick={() => setMembers(members.filter((entry) => entry.key !== key))}
                      >
                        <XIcon />
                      </Button>
                    </div>
                    <FactoryModelListEditor
                      label={`Member ${n} models`}
                      value={member.models}
                      pool={pool}
                      modelOptions={modelOptions}
                      disabled={busy}
                      onChange={(models) => setMember(key, { models })}
                    />
                    <Textarea
                      aria-label={`Member ${n} description`}
                      rows={3}
                      value={member.description}
                      onChange={(event) => setMember(key, { description: event.target.value })}
                    />
                  </div>
                );
              })}
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
        <Button form={formId} type="submit" disabled={busy}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
