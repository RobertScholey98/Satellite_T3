import { useIdeaWorkspaceStore } from "../ideas/ideaWorkspaceStore";
import {
  ArrowLeftIcon,
  BrainIcon,
  ChartNoAxesColumnIcon,
  Minimize2Icon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { SatelliteMark } from "../SatelliteMark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readWorkAreaSearch } from "../work/workspaceNavigation";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      className={cn(
        "@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pt-2 pr-3 pl-(--workspace-controls-left)",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarHeaderToggle />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
      <Link
        aria-label="Go to threads"
        className={cn(
          "relative z-10 ml-auto flex h-8 shrink-0 items-center rounded-md outline-hidden ring-ring [-webkit-app-region:no-drag] focus-visible:ring-2",
          backdropVariant !== null ? "text-white" : "text-foreground",
        )}
        to="/"
      >
        <SatelliteMark
          className="size-7 shrink-0"
          preserveAspectRatio="xMidYMid meet"
          shapeRendering="geometricPrecision"
          aria-hidden="true"
          focusable="false"
        />
      </Link>
    </div>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 flex h-8 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring [-webkit-app-region:no-drag] focus-visible:ring-2",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <span className="inline-flex min-w-0 items-center gap-2 text-base font-medium tracking-tight">
        <span className="truncate">Satellite</span>
      </span>
    </Link>
  );
}

function SidebarHeaderToggle() {
  return (
    <div className="relative z-10 shrink-0 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger render={<SidebarTrigger aria-label="Toggle main sidebar" />} />
        <TooltipPopup side="bottom">Toggle main sidebar</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readWorkAreaSearch(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigateToMainApp();
  }, [closeMobileSidebar, navigateToMainApp]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<BrainIcon />}
            label="Ideas"
            onClick={() => {
              closeMobileSidebar();
              void navigate({
                to: "/ideas",
                search: useIdeaWorkspaceStore.getState().lastSelected ?? {
                  environment: undefined,
                  idea: undefined,
                },
              });
            }}
          />
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      {window.satelliteBridge ? (
        <SidebarUtilityItem
          icon={<Minimize2Icon />}
          label="Collapse to Satellite pill"
          onClick={() => window.satelliteBridge?.hideMain()}
        />
      ) : null}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
