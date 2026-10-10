import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type FactoryManager, type ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { factoryEnvironment, type FactoryEnvironmentView } from "../../state/factory";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function CreateManagerDialog({
  projects,
  environments,
  onClose,
}: {
  readonly projects: readonly EnvironmentProject[];
  readonly environments: readonly FactoryEnvironmentView[];
  readonly onClose: () => void;
}) {
  const isAvailable = (project: EnvironmentProject) => {
    const environment = environments.find((entry) => entry.environmentId === project.environmentId);
    return (
      environment?.connected &&
      environment.canOperate &&
      environment.data !== null &&
      !environment.data.managers.some(
        (manager) => manager.role === "project" && manager.projectId === project.id,
      )
    );
  };
  const [selectedKey, setSelectedKey] = useState<string | null>(() => {
    const project = projects.find(isAvailable);
    return project ? `${project.environmentId}:${project.id}` : null;
  });
  const availableProjects = projects.filter(
    (project) => `${project.environmentId}:${project.id}` === selectedKey || isAvailable(project),
  );
  const selectedProject =
    availableProjects.find((project) => `${project.environmentId}:${project.id}` === selectedKey) ??
    availableProjects[0];
  const environment = environments.find(
    (entry) => entry.environmentId === selectedProject?.environmentId,
  );
  const [saving, setSaving] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogPopup showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Create an engineering manager</DialogTitle>
          <DialogDescription>
            Your manager starts a project onboarding team. Delivery waits until the required access
            boundaries are configured.
          </DialogDescription>
        </DialogHeader>
        {selectedProject && environment ? (
          <ManagerForm
            key={`${selectedProject.environmentId}:${selectedProject.id}`}
            project={selectedProject}
            environment={environment}
            saving={saving}
            onSavingChange={setSaving}
            onClose={onClose}
            projectPicker={
              <Select
                value={`${selectedProject.environmentId}:${selectedProject.id}`}
                disabled={saving}
                onValueChange={setSelectedKey}
                items={availableProjects.map((project) => ({
                  value: `${project.environmentId}:${project.id}`,
                  label: `${project.title} · ${environments.find((entry) => entry.environmentId === project.environmentId)?.label ?? "Environment"}`,
                }))}
              >
                <SelectTrigger id="factory-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {availableProjects.map((project) => (
                    <SelectItem
                      key={`${project.environmentId}:${project.id}`}
                      value={`${project.environmentId}:${project.id}`}
                    >
                      {project.title} ·{" "}
                      {environments.find((entry) => entry.environmentId === project.environmentId)
                        ?.label ?? "Environment"}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : (
          <>
            <DialogPanel>
              <p role="status" className="text-sm text-muted-foreground">
                Connect a project without an engineering manager to start onboarding.
              </p>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

export function RetryManagerDialog({
  project,
  environment,
  manager,
  onClose,
}: {
  readonly project: EnvironmentProject;
  readonly environment: FactoryEnvironmentView;
  readonly manager: FactoryManager;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogPopup showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Update {manager.name} setup</DialogTitle>
          <DialogDescription>
            Correct the model or committed skills version, then retry onboarding for this manager.
          </DialogDescription>
        </DialogHeader>
        <ManagerForm
          project={project}
          environment={environment}
          manager={manager}
          saving={saving}
          onSavingChange={setSaving}
          onClose={onClose}
          projectPicker={
            <Input
              id="factory-project"
              value={`${project.title} · ${environment.label}`}
              readOnly
            />
          }
        />
      </DialogPopup>
    </Dialog>
  );
}

function ManagerForm({
  project,
  environment,
  manager,
  projectPicker,
  saving,
  onSavingChange,
  onClose,
}: {
  readonly project: EnvironmentProject;
  readonly environment: FactoryEnvironmentView;
  readonly manager?: FactoryManager;
  readonly projectPicker: ReactNode;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const settings = useEnvironmentSettings(project.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(project.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const [name, setName] = useState(`${project.title} engineering manager`);
  const [selection, setSelection] = useState<ModelSelection | null>(
    manager?.modelSelection ?? null,
  );
  const activeSelection =
    selection ??
    resolveDefaultProviderModelSelection(
      providers,
      project.defaultModelSelection ?? settings.defaultModelSelection,
    );
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        activeSelection?.instanceId,
        activeSelection?.model,
      ),
    [settings, providers, activeSelection?.instanceId, activeSelection?.model],
  );
  const previousWorkflow = manager?.workflow ?? environment.data?.managers[0]?.workflow;
  const [repositoryRoot, setRepositoryRoot] = useState(previousWorkflow?.repositoryRoot ?? "");
  const [revision, setRevision] = useState(previousWorkflow?.revision ?? "");
  const validRevision = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(revision.trim());
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<{ commandId: CommandId; content: string } | null>(null);
  const pending = useRef(false);
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const selectedEntry = entries.find((entry) => entry.instanceId === activeSelection?.instanceId);
  const modelAvailable =
    selectedEntry?.enabled &&
    selectedEntry.isAvailable &&
    activeSelection !== null &&
    modelOptions
      .get(activeSelection.instanceId)
      ?.some((model) => model.slug === activeSelection.model && !model.isUnavailable);
  const alreadyManaged = environment.data?.managers.some(
    (manager) => manager.role === "project" && manager.projectId === project.id,
  );
  const canEditSetup =
    manager !== undefined &&
    manager.status === "blocked" &&
    manager.threadStatus === "pending" &&
    environment.data?.assignments.some(
      (assignment) =>
        assignment.managerId === manager.id &&
        assignment.threadStatus === "pending" &&
        assignment.report === null,
    ) &&
    !environment.data.assignments.some(
      (assignment) =>
        assignment.managerId === manager.id &&
        (assignment.report !== null || assignment.threadStatus !== "pending"),
    );
  const canSubmit =
    environment.connected &&
    environment.canOperate &&
    (manager ? canEditSetup : !alreadyManaged) &&
    modelAvailable &&
    name.trim().length > 0 &&
    repositoryRoot.trim().length > 0 &&
    validRevision;

  const submit = async () => {
    if (!canSubmit || !activeSelection || pending.current) return;
    pending.current = true;
    onSavingChange(true);
    setError(null);
    const fields = {
      modelSelection: activeSelection,
      workflow: { repositoryRoot: repositoryRoot.trim(), revision: revision.trim() },
    };
    const command = manager
      ? { type: "manager.retry-onboarding" as const, managerId: manager.id, ...fields }
      : {
          type: "manager.create" as const,
          projectId: project.id,
          name: name.trim(),
          ...fields,
        };
    const content = JSON.stringify(command);
    if (submission.current?.content !== content) {
      submission.current = { commandId: CommandId.make(randomUUID()), content };
    }
    const result = await dispatch({
      environmentId: project.environmentId,
      input: {
        command: { ...command, commandId: submission.current.commandId },
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : manager
            ? "Could not retry onboarding. Try again."
            : "Could not create the manager. Try again.",
      );
      pending.current = false;
      onSavingChange(false);
      return;
    }
    onSavingChange(false);
    onClose();
  };

  return (
    <>
      <DialogPanel>
        <form
          id={formId}
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="factory-project">Project and environment</Label>
            {projectPicker}
          </div>
          {!manager ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-name`}>Manager name</Label>
              <Input
                id={`${formId}-name`}
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label>Manager and onboarding model</Label>
            {activeSelection ? (
              <ProviderModelPicker
                activeInstanceId={activeSelection.instanceId}
                model={activeSelection.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptions}
                disabled={saving || !environment.connected}
                isComposerOwned={false}
                triggerAriaLabel="Choose manager and onboarding model"
                onInstanceModelChange={(instanceId, model) =>
                  setSelection(createModelSelection(instanceId, model))
                }
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Configure an available provider on {environment.label} first.
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-workflow`}>Owned skills repository</Label>
            <Input
              id={`${formId}-workflow`}
              value={repositoryRoot}
              disabled={saving}
              onChange={(event) => setRepositoryRoot(event.target.value)}
              aria-describedby={`${formId}-workflow-help`}
            />
            <p id={`${formId}-workflow-help`} className="text-xs text-muted-foreground">
              Use the repository path on {environment.label}. The approved version is pinned for
              this manager's assignments.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-revision`}>Approved commit SHA</Label>
            <Input
              id={`${formId}-revision`}
              value={revision}
              disabled={saving}
              onChange={(event) => setRevision(event.target.value.trim())}
              aria-describedby={`${formId}-revision-help`}
              aria-invalid={revision.trim().length > 0 && !validRevision}
              autoCapitalize="none"
              spellCheck={false}
              required
              pattern="([a-fA-F0-9]{40}|[a-fA-F0-9]{64})"
            />
            <p id={`${formId}-revision-help`} className="text-xs text-muted-foreground">
              Enter the full 40- or 64-character hexadecimal SHA of a committed skills version.
              Branch names and HEAD cannot pin an approved version.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {!manager && alreadyManaged && !saving ? (
            <p role="status" className="text-sm text-muted-foreground">
              This project already has an engineering manager. Open it from the sidebar.
            </p>
          ) : null}
          {manager && !canEditSetup && !saving ? (
            <p role="status" className="text-sm text-muted-foreground">
              Setup can only change while onboarding is blocked, before either thread starts. Close
              this dialog to see the current state.
            </p>
          ) : null}
        </form>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={saving || !canSubmit}>
          {manager
            ? saving
              ? "Retrying onboarding..."
              : "Save setup and retry"
            : saving
              ? "Creating manager..."
              : "Create manager"}
        </Button>
      </DialogFooter>
    </>
  );
}
