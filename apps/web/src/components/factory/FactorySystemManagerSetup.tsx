import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  AuthSettingsWriteScope,
  type FactoryManager,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useId, useMemo, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import type { FactoryEnvironmentView } from "../../state/factory";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
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
import { factoryManagerProviders } from "./FactorySidebarReadModel";
import { useFactoryCommand } from "./useFactoryCommand";

export function FactorySystemManagerSetup({
  environment,
  projects,
  manager,
  onClose,
}: {
  environment: FactoryEnvironmentView;
  projects: readonly EnvironmentProject[];
  manager?: Extract<FactoryManager, { role: "system" }>;
  onClose: () => void;
}) {
  const prefix = useId();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, settingsScope);
  const choices = projects.filter((project) => project.environmentId === environment.environmentId);
  const [projectId, setProjectId] = useState(manager?.workspaceProjectId ?? choices[0]?.id ?? null);
  const project = choices.find((entry) => entry.id === projectId);
  const settings = useEnvironmentSettings(environment.environmentId);
  const environmentProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environment.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const providers = useMemo(
    () => factoryManagerProviders(environmentProviders),
    [environmentProviders],
  );
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const [selection, setSelection] = useState<ModelSelection | null>(
    manager?.modelSelection ?? null,
  );
  const activeSelection =
    selection ??
    resolveDefaultProviderModelSelection(
      providers,
      project?.defaultModelSelection ?? settings.defaultModelSelection,
    );
  const options = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        activeSelection?.instanceId,
        activeSelection?.model,
      ),
    [settings, providers, activeSelection?.instanceId, activeSelection?.model],
  );
  const provider = entries.find((entry) => entry.instanceId === activeSelection?.instanceId);
  const modelAvailable =
    provider?.enabled &&
    provider.isAvailable &&
    activeSelection !== null &&
    options
      .get(activeSelection.instanceId)
      ?.some((entry) => entry.slug === activeSelection.model && !entry.isUnavailable);
  const [name, setName] = useState(manager?.name ?? "System manager");
  const alreadyCreated =
    !manager &&
    environment.data?.managers.some(
      (entry) => entry.role === "system" && entry.status !== "retired",
    );
  const pinned = manager?.threadStatus === "created";
  const disabled =
    command.disabled || !project || (!pinned && !modelAvailable) || !name.trim() || alreadyCreated;
  const submit = async () => {
    if (disabled || !project || !activeSelection) return;
    const modelSelection = activeSelection;
    if (
      await command.submit(
        manager
          ? { type: "system.retry", managerId: manager.id, ...(pinned ? {} : { modelSelection }) }
          : {
              type: "system.create",
              workspaceProjectId: project.id,
              name: name.trim(),
              modelSelection,
            },
      )
    )
      onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.pending) onClose();
      }}
    >
      <DialogPopup showCloseButton={!command.pending}>
        <DialogHeader>
          <DialogTitle>
            {manager ? "Retry system manager setup" : "Create a system manager"}
          </DialogTitle>
          <DialogDescription>
            A peer of your project managers on {environment.label}. It investigates shared workflow
            problems and brings proposed skill changes to you.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={prefix}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-workspace`}>Workflow workspace</Label>
              <Select
                value={projectId}
                disabled={command.disabled || !!manager}
                items={choices.map((entry) => ({ value: entry.id, label: entry.title }))}
                onValueChange={setProjectId}
              >
                <SelectTrigger id={`${prefix}-workspace`}>
                  <SelectValue placeholder="Choose an existing project" />
                </SelectTrigger>
                <SelectPopup>
                  {choices.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                An existing workspace for its read-only session. This does not create a project
                engineering manager or transfer project priorities to the system manager.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-name`}>Manager name</Label>
              <Input
                id={`${prefix}-name`}
                value={name}
                disabled={command.disabled || !!manager}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Approved model</Label>
              {activeSelection ? (
                <ProviderModelPicker
                  activeInstanceId={activeSelection.instanceId}
                  model={activeSelection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={options}
                  disabled={command.disabled || pinned}
                  isComposerOwned={false}
                  triggerAriaLabel="Choose system manager model"
                  onInstanceModelChange={(instanceId, model) =>
                    setSelection(createModelSelection(instanceId, model))
                  }
                />
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  Enable and sign in to a Codex or Claude provider on this environment first.
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Uses the latest commit of the skills repository set in Settings → General.
            </p>
            {pinned ? (
              <p className="text-sm text-muted-foreground">
                This existing conversation retains its approved model, workspace and skills commit.
                Retry resumes its pinned setup.
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Granted authority: investigate named evidence and recommend improvements. You retain
              merges to the skills repository. Project delivery priorities and permissions stay with
              you and each project manager.
            </p>
            {alreadyCreated ? (
              <p role="status" className="text-sm text-muted-foreground">
                This environment already has a system manager. Close this form to open it.
              </p>
            ) : null}
            {!settingsScope || !environment.canOperate ? (
              <p role="status" className="text-sm text-muted-foreground">
                Settings and operate permission are required for setup.
              </p>
            ) : null}
            {command.error ? (
              <p role="alert" className="text-sm text-destructive">
                {command.error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={command.pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={prefix} disabled={!!disabled}>
            {command.pending
              ? "Preparing manager…"
              : manager
                ? "Retry setup"
                : "Create system manager"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
