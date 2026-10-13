import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  CommandId,
  type FactoryManager,
  type FactoryModelPolicy,
  type FactoryModelPolicyOverrides,
  type FactoryModelPreference,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { Trash2Icon } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

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
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { factoryManagerProviders } from "./FactorySidebarReadModel";

export function factoryModelKey(selection: ModelSelection) {
  return JSON.stringify([
    selection.instanceId,
    selection.model,
    [...(selection.options ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((option) => [option.id, option.value]),
  ]);
}

export function factoryModelLabel(selection: ModelSelection) {
  const options = selection.options?.map((option) => `${option.id}: ${option.value}`).join(", ");
  return `${selection.model} · ${selection.instanceId}${options ? ` · ${options}` : ""}`;
}

const roles = ["lead", "worker", "reviewer"] as const;
const complexities = ["small", "standard", "complex"] as const;

export function FactoryModelPolicyDialog({
  environment,
  manager,
  onClose,
}: {
  readonly environment: FactoryEnvironmentView;
  readonly manager?: FactoryManager;
  readonly onClose: () => void;
}) {
  const prefix = useId();
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
  const canWrite = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const [candidate, setCandidate] = useState<ModelSelection | null>(null);
  const selection =
    candidate ??
    resolveDefaultProviderModelSelection(
      providers,
      manager?.modelSelection ?? settings.defaultModelSelection,
    );
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection?.instanceId, selection?.model),
    [settings, providers, selection?.instanceId, selection?.model],
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const candidateAvailable =
    selection !== null &&
    activeEntry?.enabled &&
    activeEntry.isAvailable &&
    modelOptions
      .get(selection.instanceId)
      ?.some((option) => option.slug === selection.model && !option.isUnavailable);
  const persisted = manager ? (manager.modelOverrides ?? {}) : environment.data?.modelDefaults;
  const persistedKey = JSON.stringify(persisted ?? null);
  const [draft, setDraft] = useState<{ base: string; values: FactoryModelPolicyOverrides } | null>(
    null,
  );
  const [saved, setSaved] = useState<{
    revision: number;
    values: FactoryModelPolicyOverrides;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submission = useRef<{ content: string; commandId: CommandId } | null>(null);
  const syncing = saved !== null && (environment.data?.revision ?? 0) < saved.revision;
  const values = draft?.values ?? (syncing ? saved.values : (persisted ?? {}));
  const inheritedPool =
    environment.data?.modelDefaults?.approvedModels ?? (manager ? [manager.modelSelection] : []);
  const approvedModels = values.approvedModels ?? inheritedPool;
  const preferences = values.preferences ?? [];
  const inheritsPool = manager !== undefined && values.approvedModels === undefined;
  const dirty = draft !== null && JSON.stringify(values) !== persistedKey;
  const conflict = draft !== null && draft.base !== persistedKey;
  const disabled =
    pending || syncing || !canWrite || !environment.canOperate || !environment.connected;
  const invalidPreference = preferences.find(
    (preference) =>
      !approvedModels.some(
        (model) => factoryModelKey(model) === factoryModelKey(preference.selection),
      ),
  );
  const edit = (next: FactoryModelPolicyOverrides) => {
    setDraft((current) => ({ base: current?.base ?? persistedKey, values: next }));
    setError(null);
    setNotice(null);
  };
  const setPreference = (
    role: FactoryModelPreference["role"],
    complexity: FactoryModelPreference["complexity"],
    key: string | null,
  ) => {
    const next = preferences.filter(
      (preference) => preference.role !== role || preference.complexity !== complexity,
    );
    const model = approvedModels.find((entry) => factoryModelKey(entry) === key);
    edit({
      ...values,
      preferences: model ? [...next, { role, complexity, selection: model }] : next,
    });
  };
  const save = async () => {
    if (
      inFlight.current ||
      disabled ||
      !dirty ||
      conflict ||
      invalidPreference ||
      !readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)
    )
      return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    const command = manager
      ? { type: "manager.models.configure" as const, managerId: manager.id, overrides: values }
      : {
          type: "models.defaults.configure" as const,
          policy: { approvedModels, preferences } satisfies FactoryModelPolicy,
        };
    const content = JSON.stringify(command);
    if (submission.current?.content !== content)
      submission.current = { content, commandId: CommandId.make(randomUUID()) };
    const result = await dispatch({
      environmentId: environment.environmentId,
      input: { command: { ...command, commandId: submission.current.commandId } },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not save model policy.");
    } else {
      setSaved({
        revision: result.value.revision,
        values: manager ? values : { approvedModels, preferences },
      });
      setDraft(null);
      submission.current = null;
      setNotice(
        "Model policy saved. Standing preferences change only through these settings; recommendations do not rewrite them.",
      );
    }
    inFlight.current = false;
    setPending(false);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {manager ? `${manager.name} models` : "Engineering model defaults"}
          </DialogTitle>
          <DialogDescription>
            {environment.label}. Approve exact model and option combinations, then favor a selection
            by role and task complexity.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
              Leads, workers, and reviewers select only from the approved pool. Managers without an
              override follow changed defaults. Existing assignments retain their recorded model
              policy.
            </p>
            {!manager && !environment.data?.modelDefaults ? (
              <p className="text-sm text-muted-foreground">
                No global policy is configured. Each manager currently starts with its
                human-selected setup model. Saving a global pool replaces that fallback for managers
                following defaults.
              </p>
            ) : null}
            {!canWrite || !environment.canOperate ? (
              <p role="status" className="text-sm text-muted-foreground">
                Settings and agent-operation permission are required to make changes.
              </p>
            ) : null}
            {!environment.connected ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reconnect to {environment.label} to save changes.
              </p>
            ) : null}
            <section className="space-y-3" aria-labelledby={`${prefix}-pool`}>
              <h3 id={`${prefix}-pool`} className="text-sm font-medium">
                Approved model pool
              </h3>
              {manager ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${prefix}-inherit-pool`}
                    checked={inheritsPool}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        const { approvedModels: _, ...rest } = values;
                        edit(rest);
                      } else edit({ ...values, approvedModels });
                    }}
                  />
                  <Label htmlFor={`${prefix}-inherit-pool`}>Follow default pool</Label>
                </div>
              ) : null}
              {approvedModels.length === 0 ? (
                <p role="status" className="text-sm text-muted-foreground">
                  This pool is empty. Saving an empty pool denies model selection until a model is
                  approved.
                </p>
              ) : (
                <ul className="space-y-2">
                  {approvedModels.map((model) => (
                    <li
                      key={factoryModelKey(model)}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="break-words text-sm">{factoryModelLabel(model)}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled || inheritsPool}
                        aria-label={`Remove ${factoryModelLabel(model)}`}
                        onClick={() =>
                          edit({
                            ...values,
                            approvedModels: approvedModels.filter(
                              (entry) => factoryModelKey(entry) !== factoryModelKey(model),
                            ),
                          })
                        }
                      >
                        <Trash2Icon aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {selection && activeEntry ? (
                <div className="flex flex-wrap items-center gap-2">
                  <ProviderModelPicker
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    isComposerOwned={false}
                    disabled={disabled || inheritsPool}
                    triggerAriaLabel="Choose model to approve"
                    onInstanceModelChange={(instanceId, model) =>
                      setCandidate(createModelSelection(instanceId, model))
                    }
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind}
                    instanceId={activeEntry.instanceId}
                    models={activeEntry.models}
                    model={selection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={selection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    isComposerOwned={false}
                    disabled={disabled || inheritsPool}
                    onModelOptionsChange={(options) =>
                      setCandidate(
                        createModelSelection(selection.instanceId, selection.model, options),
                      )
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      disabled ||
                      inheritsPool ||
                      !candidateAvailable ||
                      approvedModels.some(
                        (model) => factoryModelKey(model) === factoryModelKey(selection),
                      )
                    }
                    onClick={() =>
                      edit({ ...values, approvedModels: [...approvedModels, selection] })
                    }
                  >
                    Add approved selection
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Enable and sign in to a Codex or Claude provider to add approved models.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Effort and other selected options are part of the approval. Different options
                require a separate approved selection.
              </p>
            </section>
            <section className="space-y-4" aria-labelledby={`${prefix}-preferences`}>
              <h3 id={`${prefix}-preferences`} className="text-sm font-medium">
                Role and complexity preferences
              </h3>
              {roles.map((role) => (
                <fieldset key={role} className="space-y-2">
                  <legend className="text-sm font-medium capitalize">{role}</legend>
                  {complexities.map((complexity) => {
                    const preference = preferences.find(
                      (entry) => entry.role === role && entry.complexity === complexity,
                    );
                    const inherited = environment.data?.modelDefaults?.preferences.find(
                      (entry) => entry.role === role && entry.complexity === complexity,
                    );
                    const fallbackLabel = manager
                      ? `Follow defaults${inherited ? ` · ${factoryModelLabel(inherited.selection)}` : " · first approved model"}`
                      : "No preference · first approved model";
                    const modelItems = approvedModels.map((model) => ({
                      value: factoryModelKey(model),
                      label: factoryModelLabel(model),
                    }));
                    if (
                      preference &&
                      !modelItems.some(
                        (item) => item.value === factoryModelKey(preference.selection),
                      )
                    )
                      modelItems.push({
                        value: factoryModelKey(preference.selection),
                        label: `Not approved: ${factoryModelLabel(preference.selection)}`,
                      });
                    const items = [{ value: "inherit", label: fallbackLabel }, ...modelItems];
                    return (
                      <div key={complexity} className="space-y-1">
                        <Label htmlFor={`${prefix}-${role}-${complexity}`}>
                          {complexity[0]?.toUpperCase()}
                          {complexity.slice(1)} task
                        </Label>
                        <Select
                          value={preference ? factoryModelKey(preference.selection) : "inherit"}
                          disabled={disabled}
                          items={items}
                          onValueChange={(value) => setPreference(role, complexity, value)}
                        >
                          <SelectTrigger id={`${prefix}-${role}-${complexity}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            {items.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                    );
                  })}
                </fieldset>
              ))}
              <p className="text-xs text-muted-foreground">
                Clearing a manager preference resumes inheritance for that role and complexity. A
                recommendation from a retro does not change this policy.
              </p>
            </section>
            {invalidPreference ? (
              <p role="alert" className="text-sm text-destructive">
                The {invalidPreference.role} preference for {invalidPreference.complexity} tasks is
                outside the approved pool. Choose an approved selection or clear that preference.
              </p>
            ) : null}
            {conflict ? (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-destructive">
                  Model settings changed elsewhere. Reload before saving.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setDraft(null);
                    setSaved(null);
                  }}
                >
                  Reload model settings
                </Button>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={disabled || !dirty || conflict || invalidPreference !== undefined}
            onClick={() => void save()}
          >
            {pending ? "Saving..." : syncing ? "Syncing settings..." : "Save model policy"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
