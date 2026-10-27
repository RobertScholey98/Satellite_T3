import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { ChevronDownIcon, FactoryIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "~/env";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { factoryEnvironment, supportsFactory } from "./factoryState";
import { factoryModelOptions } from "./FactoryPageConfig";
import { FactoryPageConfiguration } from "./FactoryPageConfiguration";
import { FactoryPageDashboard } from "./FactoryPageDashboard";
import {
  FACTORY_CONFIGURATION_ANCHOR_PREFIX,
  type FactoryPageTab,
  readFactoryPageTab,
  writeFactoryPageTab,
} from "./FactoryPagePreferences";

const TABS: ReadonlyArray<{ readonly value: FactoryPageTab; readonly label: string }> = [
  { value: "dashboard", label: "Dashboard" },
  { value: "configuration", label: "Configuration" },
];

const isConfigurationAnchor = (hash: string) =>
  hash.replace(/^#/, "").startsWith(FACTORY_CONFIGURATION_ANCHOR_PREFIX);

/** The engineering factory: how it is doing, and every setting it runs on. */
export function FactoryPage() {
  const hash = useLocation({ select: (location) => location.hash });
  // A settings search result links to a Configuration row by its anchor.
  const [tab, setTab] = useState<FactoryPageTab>(() =>
    isConfigurationAnchor(hash) ? "configuration" : readFactoryPageTab(),
  );
  const [seenHash, setSeenHash] = useState(hash);
  if (seenHash !== hash) {
    setSeenHash(hash);
    if (isConfigurationAnchor(hash)) setTab("configuration");
  }
  // oxlint-disable-next-line t3code/react-effect-budget -- Persist the shown tab to local storage, including the tab a configuration anchor opens.
  useEffect(() => writeFactoryPageTab(tab), [tab]);

  const { environments: allEnvironments } = useEnvironments();
  const environments = allEnvironments.filter(supportsFactory);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((candidate) => candidate.environmentId === selectedEnvironmentId) ??
    environments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    environments[0];
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environmentId === null ? undefined : providersByEnvironment.get(environmentId);
  const modelOptions = factoryModelOptions(providers ?? []);
  const canEditConfig = useAtomValue(factoryEnvironment.updateConfig.permissionAtom(environmentId));

  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-x-3 py-2">
      <WorkspaceBreadcrumb ariaLabel="Factory breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Factory</h1>
        </WorkspaceBreadcrumbItem>
        {environment ? (
          <>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10 shrink">
              {environments.length > 1 ? (
                <Menu>
                  <MenuTrigger
                    render={<InlineButton />}
                    aria-label="Environment"
                    className="min-w-0 max-w-full"
                  >
                    <WorkspaceBreadcrumbText>{environment.label}</WorkspaceBreadcrumbText>
                    <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </MenuTrigger>
                  <MenuPopup align="start">
                    <MenuRadioGroup
                      value={environment.environmentId}
                      onValueChange={(next) => setSelectedEnvironmentId(next as EnvironmentId)}
                    >
                      {environments.map((candidate) => (
                        <MenuRadioItem
                          key={candidate.environmentId}
                          value={candidate.environmentId}
                          closeOnClick
                        >
                          {candidate.label}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
              ) : (
                <WorkspaceBreadcrumbText>{environment.label}</WorkspaceBreadcrumbText>
              )}
            </WorkspaceBreadcrumbItem>
          </>
        ) : null}
      </WorkspaceBreadcrumb>
      <div className="ms-auto flex min-w-0 items-center justify-end">
        <ToggleGroup
          aria-label="Factory view"
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "dashboard" || value === "configuration") setTab(value);
          }}
        >
          {TABS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
    </div>
  );

  const unavailable =
    environment === undefined ? (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FactoryIcon />
          </EmptyMedia>
          <EmptyTitle>No environment runs the factory</EmptyTitle>
          <EmptyDescription>
            Connect an environment running this version of Satellite to use the factory.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : !connected ? (
      <p role="status" className="text-sm text-muted-foreground">
        {environment.label} is not connected. Reconnect it to see its factory.
      </p>
    ) : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>
        {unavailable !== null || environmentId === null ? (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="wide">{unavailable}</WorkspacePageContainer>
          </ScrollArea>
        ) : tab === "dashboard" ? (
          <SettingsPageContainer width="wide">
            <FactoryPageDashboard key={environmentId} environmentId={environmentId} />
          </SettingsPageContainer>
        ) : (
          <SettingsPageContainer width="wide">
            <FactoryPageConfiguration
              key={environmentId}
              environmentId={environmentId}
              environmentLabel={environment?.label ?? "this environment"}
              modelOptions={modelOptions}
              canEdit={canEditConfig}
            />
          </SettingsPageContainer>
        )}
      </div>
    </SidebarInset>
  );
}
