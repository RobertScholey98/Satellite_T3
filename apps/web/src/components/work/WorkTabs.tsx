import { Link } from "@tanstack/react-router";
import { GitBranchIcon } from "lucide-react";
import { type ComponentType, useEffect } from "react";

import { cn } from "~/lib/utils";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Spinner } from "../ui/spinner";

interface WorkTab {
  readonly id: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly to: "/pull-requests" | "/open-work";
  /** Restores the page's last search when it is opened from the strip. */
  readonly search?: () => object;
}

/** The work pages, in strip order. A new work page adds its entry here and nowhere else. */
const WORK_TABS = [
  {
    id: "pull-requests",
    label: "Pull Requests",
    icon: PullRequestGlyph.pullRequest,
    to: "/pull-requests",
    search: readPullRequestListPreferences,
  },
  // Open work restores its own last selection when opened without a target.
  { id: "open-work", label: "Open Work", icon: GitBranchIcon, to: "/open-work" },
] as const satisfies ReadonlyArray<WorkTab>;

export type WorkTabId = (typeof WORK_TABS)[number]["id"];

/** The work page last shown on this client. The sidebar's reader joins it with its first use. */
const LAST_WORK_TAB_KEY = "satellite:work:last-tab:v1";

function writeLastWorkTab(id: WorkTabId) {
  try {
    localStorage.setItem(LAST_WORK_TAB_KEY, id);
  } catch {
    // Storage can be unavailable; the sidebar then opens the first work tab.
  }
}

/**
 * The header strip linking the work pages. The current page's label is its heading. `compact`
 * shows the other pages as icons, for condensed headers. `syncing` shows upstream's spinner.
 */
export function WorkTabs({
  current,
  compact = false,
  syncing = false,
}: {
  readonly current: WorkTabId;
  readonly compact?: boolean;
  readonly syncing?: boolean;
}) {
  useEffect(() => writeLastWorkTab(current), [current]);
  return (
    <div className="flex min-w-0 items-center gap-3">
      {WORK_TABS.map((tab: WorkTab) =>
        tab.id === current ? (
          <h1 key={tab.id} className="truncate text-foreground">
            {tab.label}
          </h1>
        ) : (
          <Link
            key={tab.id}
            to={tab.to}
            // The strip's entries share one shape; each page's search validator still runs.
            search={(tab.search?.() ?? {}) as never}
            aria-label={compact ? tab.label : undefined}
            title={compact ? tab.label : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 text-muted-foreground hover:text-foreground focus-visible:text-foreground",
              "[-webkit-app-region:no-drag]",
            )}
          >
            {compact ? <tab.icon className="size-4" /> : tab.label}
          </Link>
        ),
      )}
      {syncing ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <Spinner size="xs" tone="muted" />
          Syncing
        </span>
      ) : null}
    </div>
  );
}
