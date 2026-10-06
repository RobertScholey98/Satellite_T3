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
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { SymbolView } from "../../components/AppSymbol";
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
import { Fragment, useRef, useState, type ComponentProps } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
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
  "source-control": ["defaultAutoPull", "newWorktreesStartFromOrigin"],
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
  {
    mode: "token",
    label: "Token by token (legacy)",
    description: "Repaint for every token; this can be slower.",
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
  const displayTargets = pendingWrites > 0 && pendingTargets !== null ? pendingTargets : targets;
  const hasConnectedSelection = targets.length > 0;
  const reference = displayTargets[0] ?? null;
  const uniform = <K extends keyof ServerSettings>(key: K): ServerSettings[K] | null => {
    if (reference === null) return null;
    const value = reference.settings[key];
    return displayTargets.every((entry) => entry.settings[key] === value) ? value : null;
  };
  // `uniform` folds a real null into "mixed"; nullable keys need the distinction.
  const isMixed = (key: keyof ServerSettings) =>
    reference === null ||
    displayTargets.some((entry) => entry.settings[key] !== reference.settings[key]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });
  const write = (patch: ServerSettingsPatch) => {
    if (writeInFlight.current || !hasConnectedSelection) return;
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
    if (writeInFlight.current) return;
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
    pendingWrites > 0 || !hasConnectedSelection || (projectSelected && !supportsProjectOverrides);
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
                      <ChoiceRow
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
                      <ChoiceRow
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
                      <ChoiceRow
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
                  <SettingsSection title="Default branch">
                    <FanoutSwitchRow
                      icon="arrow.down.circle"
                      label="Automatically pull"
                      subtitle="Keep the default branch current when there are no local changes."
                      value={uniform("defaultAutoPull")}
                      disabled={disabledFor("defaultAutoPull")}
                      onValueChange={(value) => write({ defaultAutoPull: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title="Worktrees">
                    <FanoutSwitchRow
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
                      <ChoiceRow
                        key={choice.mode}
                        label={choice.label}
                        description={choice.description}
                        selected={uniform("responseStreamingMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("responseStreamingMode")}
                        onPress={() => {
                          if (choice.mode !== "token") {
                            write({ responseStreamingMode: choice.mode });
                            return;
                          }
                          Alert.alert(
                            "Use legacy token streaming?",
                            "Repainting every token can make the app slower.",
                            [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Use token streaming",
                                onPress: () => write({ responseStreamingMode: "token" }),
                              },
                            ],
                          );
                        }}
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
                    <FanoutSwitchRow
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
                    <FanoutSwitchRow
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
                      <FanoutSwitchRow
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

function ChoiceRow(props: {
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.separated
          ? "flex-row items-center gap-4 border-t border-border-subtle p-4 active:opacity-70"
          : "flex-row items-center gap-4 p-4 active:opacity-70"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text
          className={
            Platform.OS === "android" ? "text-base text-foreground" : "text-lg text-foreground"
          }
        >
          {props.label}
        </Text>
        <Text className="text-sm leading-normal text-foreground-muted">{props.description}</Text>
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
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

function FanoutSwitchRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly subtitle: string;
  readonly value: boolean | null;
  readonly disabled: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  if (props.value !== null) {
    return (
      <SettingsSwitchRow
        icon={props.icon}
        label={props.label}
        subtitle={props.subtitle}
        value={props.value}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
      />
    );
  }

  return (
    <SettingsControlRow
      disabled={props.disabled}
      icon={props.icon}
      label={props.label}
      subtitle={props.subtitle}
    >
      <Pressable
        accessibilityLabel={`Set ${props.label} on for selected environments`}
        accessibilityRole="button"
        disabled={props.disabled}
        className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
        onPress={() => props.onValueChange(true)}
      >
        <Text className="text-sm font-t3-medium text-foreground">Mixed · Set on</Text>
      </Pressable>
    </SettingsControlRow>
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
