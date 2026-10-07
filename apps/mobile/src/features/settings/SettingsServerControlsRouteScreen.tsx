import { buildModelOptions } from "../../lib/modelOptions";
import { MaterialButton } from "../../components/MaterialButton";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import type { SettingsTarget } from "./settings-environment-filter";
import { useNavigation } from "@react-navigation/native";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text } from "../../components/AppText";
import {
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ProviderOptionSelection,
  type ResponseStreamingMode,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadEnvMode,
  type WorktreeSubmodules,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
} from "@t3tools/contracts";
import {
  createModelSelection,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";
import { Fragment, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { BranchNamingSettings } from "./components/BranchNamingSettings";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

type SettingsPage = "new-threads" | "source-control" | "agent-behavior" | "maintenance";

const PAGE_TITLES: Record<SettingsPage, string> = {
  "new-threads": "New threads",
  "source-control": "Source control",
  "agent-behavior": "Agent behavior",
  maintenance: "Maintenance",
};

const PAGE_PROJECT_KEYS: Record<SettingsPage, readonly ProjectScopedServerSettingKey[]> = {
  "new-threads": ["defaultThreadEnvMode", "worktreeSubmodules", "defaultRuntimeMode"],
  "source-control": [
    "defaultAutoPull",
    "removeAgentCreditsOnMerge",
    "newWorktreesStartFromOrigin",
    "branchNamingMode",
    "branchNamePrefix",
    "branchNameInstructions",
  ],
  "agent-behavior": ["responseStreamingMode", "enableAgentBrowserAccess"],
  maintenance: ["continueThreadsAfterServerUpdate"],
};

const SUBMODULE_CHOICES: ReadonlyArray<{
  readonly mode: WorktreeSubmodules | null;
  readonly label: string;
  readonly description: string;
}> = [
  // Only offered at environment scope; a project falls back through "Use defaults".
  {
    mode: null,
    label: "Inherit",
    description: "Use the repository's t3.json, or initialize recursively.",
  },
  { mode: "recursive", label: "Recursive", description: "Initialize nested submodules too." },
  {
    mode: "top-level",
    label: "Top level only",
    description: "Skip submodules declared inside other submodules.",
  },
  { mode: "none", label: "Skip", description: "Leave submodules empty for a setup script." },
];

const WORKSPACE_CHOICES: ReadonlyArray<{
  readonly mode: ThreadEnvMode | null;
  readonly label: string;
  readonly description: string;
}> = [
  // Only offered at environment scope; a project falls back through "Use defaults".
  {
    mode: null,
    label: "Inherit",
    description: "Use the repository's t3.json, or the current checkout.",
  },
  {
    mode: "local",
    label: "Current checkout",
    description: "Start new threads in the existing workspace.",
  },
  {
    mode: "worktree",
    label: "New worktree",
    description: "Give each new thread a separate checkout.",
  },
];

const STREAMING_CHOICES: ReadonlyArray<{
  readonly mode: ResponseStreamingMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "turn",
    label: "After the turn",
    description: "Show the answer when the agent finishes.",
  },
  {
    mode: "paragraph",
    label: "Finished paragraphs",
    description: "Show each paragraph or code block as it completes.",
  },
];

export function SettingsEnvironmentNewThreadsRouteScreen() {
  return <ServerSettingsDetail page="new-threads" />;
}

export function SettingsEnvironmentSourceControlRouteScreen() {
  return <ServerSettingsDetail page="source-control" />;
}

export function SettingsEnvironmentAgentBehaviorRouteScreen() {
  return <ServerSettingsDetail page="agent-behavior" />;
}

export function SettingsEnvironmentMaintenanceRouteScreen() {
  return <ServerSettingsDetail page="maintenance" />;
}

function ServerSettingsDetail(props: { readonly page: SettingsPage }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const canWriteSettings =
    targets.length > 0 &&
    targets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const displayTargets = pendingWrites > 0 && pendingTargets !== null ? pendingTargets : targets;
  const hasConnectedSelection = targets.length > 0;
  const reference = displayTargets[0] ?? null;
  const uniform = <K extends keyof ServerSettings>(key: K) =>
    uniformMobileSetting(displayTargets, key);
  // `uniform` folds a real null into "mixed"; nullable keys need the distinction.
  const isMixed = (key: keyof ServerSettings) =>
    reference === null ||
    displayTargets.some((entry) => entry.settings[key] !== reference.settings[key]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });
  const write = (patch: ServerSettingsPatch) => {
    if (
      writeInFlight.current ||
      !hasConnectedSelection ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsPatch(targets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const clearProjectOverrides = () => {
    if (
      writeInFlight.current ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsClear(targets, PAGE_PROJECT_KEYS[props.page]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const supportsProjectOverrides = targets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides === true,
  );
  const disabled =
    !canWriteSettings ||
    pendingWrites > 0 ||
    !hasConnectedSelection ||
    (projectSelected && !supportsProjectOverrides);
  const supportsContinuation = targets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.threadRestartContinuation === true,
  );
  const disabledFor = (key: string) =>
    disabled ||
    (projectSelected &&
      !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(
        key as (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number],
      ));

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen
        title={PAGE_TITLES[props.page]}
        trailing={<AndroidSettingsEnvironmentFilter />}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {!hasConnectedSelection || reference === null ? (
            <Text className="px-2 text-base text-foreground-muted">
              {projectSelected
                ? "Select a project with a checkout on a connected environment."
                : "Use the filter above to select a connected environment."}
            </Text>
          ) : (
            <>
              {projectSelected ? (
                <SettingsProjectOverridesSection
                  projectLabel={selectedProject?.label ?? "Unavailable project"}
                  hasOverrides={targets.some((target) =>
                    PAGE_PROJECT_KEYS[props.page].some((key) => target.sources[key] === "project"),
                  )}
                  supportsOverrides={supportsProjectOverrides}
                  pending={pendingWrites > 0}
                  disabled={!canWriteSettings}
                  onClear={clearProjectOverrides}
                />
              ) : null}
              {props.page === "new-threads" ? (
                <>
                  <SettingsSection
                    title="Default workspace"
                    trailing={
                      pendingWrites === 0 && isMixed("defaultThreadEnvMode") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {WORKSPACE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={choice.label}
                        description={choice.description}
                        selected={
                          !isMixed("defaultThreadEnvMode") &&
                          uniform("defaultThreadEnvMode") === choice.mode
                        }
                        separated={index > 0}
                        disabled={disabledFor("defaultThreadEnvMode")}
                        onPress={() => write({ defaultThreadEnvMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection
                    title="Worktree submodules"
                    trailing={
                      pendingWrites === 0 && isMixed("worktreeSubmodules") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {SUBMODULE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={choice.label}
                        description={choice.description}
                        selected={
                          !isMixed("worktreeSubmodules") &&
                          uniform("worktreeSubmodules") === choice.mode
                        }
                        separated={index > 0}
                        disabled={disabledFor("worktreeSubmodules")}
                        onPress={() => write({ worktreeSubmodules: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection
                    title="Default permissions"
                    trailing={
                      pendingWrites === 0 && uniform("defaultRuntimeMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {RUNTIME_MODE_CHOICES.map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode}
                        label={choice.label}
                        description={choice.description}
                        selected={uniform("defaultRuntimeMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("defaultRuntimeMode")}
                        onPress={() => write({ defaultRuntimeMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "source-control" ? (
                <>
                  <BranchNamingSettings
                    key={targets
                      .map((target) => `${target.environment.environmentId}:${target.projectId}`)
                      .join(",")}
                    mode={uniform("branchNamingMode")}
                    prefix={uniform("branchNamePrefix")}
                    instructions={uniform("branchNameInstructions")}
                    disabled={disabledFor("branchNamingMode")}
                    onChange={write}
                  />
                  <SettingsSection title="Pull requests">
                    <SettingsSwitchRow
                      icon="arrow.triangle.merge"
                      label="Remove agent credits when merging"
                      subtitle="Remove recognized agent credits from GitHub merge and squash messages, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits."
                      value={uniform("removeAgentCreditsOnMerge")}
                      disabled={disabledFor("removeAgentCreditsOnMerge")}
                      onValueChange={(value) => write({ removeAgentCreditsOnMerge: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title="Default branch">
                    <SettingsSwitchRow
                      icon="arrow.down.circle"
                      label="Automatically pull"
                      subtitle="Keep the default branch current when there are no local changes."
                      value={uniform("defaultAutoPull")}
                      disabled={disabledFor("defaultAutoPull")}
                      onValueChange={(value) => write({ defaultAutoPull: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title="Worktrees">
                    <SettingsSwitchRow
                      icon="arrow.triangle.branch"
                      label="Start from origin"
                      subtitle="Base new worktrees on the remote branch."
                      value={uniform("newWorktreesStartFromOrigin")}
                      disabled={disabledFor("newWorktreesStartFromOrigin")}
                      onValueChange={(value) => write({ newWorktreesStartFromOrigin: value })}
                    />
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "agent-behavior" ? (
                <>
                  <SettingsSection
                    title="Response streaming"
                    trailing={
                      pendingWrites === 0 && uniform("responseStreamingMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {STREAMING_CHOICES.map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode}
                        label={choice.label}
                        description={choice.description}
                        selected={uniform("responseStreamingMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("responseStreamingMode")}
                        onPress={() => write({ responseStreamingMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  {!projectSelected
                    ? selectedTargets.map((target) => (
                        <Fragment key={target.environmentId}>
                          <BackgroundModelSetting target={target} kind="ideas" />
                          <BackgroundModelSetting target={target} kind="revdoc" />
                          <BackgroundModelSetting target={target} kind="revdoc-large" />
                          <BackgroundModelSetting target={target} kind="revdoc-testing" />
                        </Fragment>
                      ))
                    : null}
                  <SettingsSection title="Preview browser">
                    <SettingsSwitchRow
                      icon="globe"
                      label="Agent browser access"
                      subtitle="Allow agents to use the in-app preview browser."
                      value={uniform("enableAgentBrowserAccess")}
                      disabled={disabledFor("enableAgentBrowserAccess")}
                      onValueChange={(value) => write({ enableAgentBrowserAccess: value })}
                    />
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "maintenance" ? (
                <>
                  {!projectSelected ? (
                    <SettingsSection title="Manage environments">
                      {selectedTargets.map((target) => (
                        <SettingsRow
                          key={target.environmentId}
                          icon="server.rack"
                          label={target.label}
                          value="Server and provider updates"
                          onPress={() =>
                            navigation.navigate("SettingsSheet", {
                              screen: "SettingsContent",
                              params: {
                                screen: "SettingsEnvironmentDetail",
                                params: { environmentId: target.environmentId },
                              },
                            })
                          }
                        />
                      ))}
                    </SettingsSection>
                  ) : null}
                  <SettingsSection title="Updates">
                    <SettingsSwitchRow
                      icon="arrow.clockwise"
                      label="Check provider updates"
                      subtitle={
                        projectSelected
                          ? "Environment-wide setting. Select All projects to change it."
                          : "Check installed provider CLIs for newer versions."
                      }
                      value={uniform("enableProviderUpdateChecks")}
                      disabled={disabledFor("enableProviderUpdateChecks")}
                      onValueChange={(value) => write({ enableProviderUpdateChecks: value })}
                    />
                    <View className="border-t border-border-subtle">
                      <SettingsSwitchRow
                        icon="arrow.uturn.forward"
                        label="Continue after restart"
                        subtitle={
                          supportsContinuation
                            ? "Resume interrupted threads after an update or restart."
                            : "Update older servers to control restart continuation."
                        }
                        value={uniform("continueThreadsAfterServerUpdate")}
                        disabled={
                          disabledFor("continueThreadsAfterServerUpdate") || !supportsContinuation
                        }
                        onValueChange={(value) =>
                          write({ continueThreadsAfterServerUpdate: value })
                        }
                      />
                    </View>
                  </SettingsSection>
                </>
              ) : null}
            </>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function MixedValuesLabel(props: { readonly projectSelected: boolean }) {
  return (
    <Text
      accessibilityLabel={
        props.projectSelected
          ? "Selected project checkouts use different values"
          : "Selected environments use different values"
      }
      className="px-2 text-sm text-foreground-muted android:px-4"
    >
      Mixed
    </Text>
  );
}

function BackgroundModelSetting({
  target,
  kind,
}: {
  target: SettingsTarget;
  kind: "ideas" | "revdoc" | "revdoc-large" | "revdoc-testing";
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const settingKey =
    kind === "ideas"
      ? "ideaUpdatesModelSelection"
      : kind === "revdoc"
        ? "revdocModelSelection"
        : kind === "revdoc-large"
          ? "revdocLargeModelSelection"
          : "revdocTestingModelSelection";
  const selection = target.serverConfig.settings[settingKey];
  const models = buildModelOptions(target.serverConfig, selection);
  const selectedModel = models.find(
    (model) =>
      model.selection.instanceId === selection?.instanceId &&
      model.selection.model === selection.model,
  );
  const options =
    selectedModel?.providerDriver === "codex" &&
    getProviderOptionStringSelectionValue(selection?.options, "reasoningEffort") === undefined
      ? [
          ...(selection?.options ?? []),
          { id: "reasoningEffort", value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT },
        ]
      : selection?.options;
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: selectedModel?.capabilities,
    selections: options,
  });
  const choose = async (model: typeof selection) => {
    setSaving(true);
    const result = await update({
      environmentId: target.environmentId,
      input: { patch: { [settingKey]: model } },
    });
    setSaving(false);
    if (result._tag !== "Failure") setExpanded(false);
  };
  const changeOption = (change: ProviderOptionSelection) => {
    if (!selection || saving) return;
    const nextOptions = applyProviderOptionSelection(descriptors, change);
    if (nextOptions)
      void choose(createModelSelection(selection.instanceId, selection.model, nextOptions));
  };
  return (
    <SettingsSection
      title={`${kind === "ideas" ? "Idea updates" : kind === "revdoc" ? "Revdoc" : kind === "revdoc-large" ? "Large Revdoc" : "Revdoc testing"} · ${target.label}`}
    >
      <SettingsRow
        icon="brain"
        label={
          kind === "ideas"
            ? "Notebook model"
            : kind === "revdoc-testing"
              ? "Testing model"
              : "Review model"
        }
        value={selection?.model ?? "Automatic"}
        onPress={() => setExpanded((value) => !value)}
      />
      <View className="px-4 pb-3">
        <Text className="text-sm text-foreground-muted">
          {kind === "ideas"
            ? "Organizes notes and updates pitches independently of thread titles."
            : kind === "revdoc"
              ? "Generates worktree reviews in the background. Automatic uses the thread’s provider and model."
              : kind === "revdoc-large"
                ? "Reviews large changes in parallel batches and combines the results. Automatic uses the Revdoc model, then the thread’s model."
                : "Tests the worktree in the review sidebar. Automatic uses the Revdoc model, then the thread’s model."}
        </Text>
      </View>
      {kind === "revdoc-testing" ? (
        <SettingsSwitchRow
          icon="brain"
          label="Test after generating Revdoc"
          disabled={saving}
          value={target.serverConfig.settings.revdocDefaultAction === "generate-and-test"}
          onValueChange={(checked) => {
            void update({
              environmentId: target.environmentId,
              input: { patch: { revdocDefaultAction: checked ? "generate-and-test" : "generate" } },
            });
          }}
        />
      ) : null}
      {expanded ? (
        <View className="gap-1 p-3">
          <MaterialButton label="Automatic" disabled={saving} onPress={() => void choose(null)} />
          {models.map((model) => (
            <MaterialButton
              key={model.key}
              tone="text"
              label={`${model.providerLabel} · ${model.label}`}
              disabled={saving || model.isUnavailable}
              onPress={() =>
                void choose(
                  createModelSelection(
                    model.selection.instanceId,
                    model.selection.model,
                    model === selectedModel
                      ? options
                      : model.providerDriver === "codex"
                        ? [
                            {
                              id: "reasoningEffort",
                              value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
                            },
                          ]
                        : undefined,
                  ),
                )
              }
            />
          ))}
          {!models.length ? (
            <Text className="text-sm text-foreground-muted">
              Connect a provider to choose a background model.
            </Text>
          ) : null}
        </View>
      ) : null}
      {descriptors.map((descriptor) =>
        descriptor.type === "boolean" ? (
          <SettingsSwitchRow
            key={descriptor.id}
            icon="brain"
            label={descriptor.label}
            disabled={saving}
            value={descriptor.currentValue ?? false}
            onValueChange={(value) => changeOption({ id: descriptor.id, value })}
          />
        ) : (
          <SettingsControlRow
            key={descriptor.id}
            icon="brain"
            label={descriptor.label}
            disabled={saving}
          >
            <ControlPillMenu
              accessibilityLabel={descriptor.label}
              title={descriptor.label}
              actions={descriptor.options
                .filter((choice) => !descriptor.promptInjectedValues?.includes(choice.id))
                .map((choice) => ({
                  id: choice.id,
                  title: choice.label,
                  state:
                    choice.id === getProviderOptionCurrentValue(descriptor)
                      ? ("on" as const)
                      : ("off" as const),
                  attributes: { disabled: saving },
                }))}
              onPressAction={({ nativeEvent }) =>
                changeOption({ id: descriptor.id, value: nativeEvent.event })
              }
            >
              <ControlPill
                variant="pill"
                label={getProviderOptionCurrentLabel(descriptor) ?? "Default"}
                accessibilityLabel={descriptor.label}
                disabled={saving}
              />
            </ControlPillMenu>
          </SettingsControlRow>
        ),
      )}
    </SettingsSection>
  );
}
