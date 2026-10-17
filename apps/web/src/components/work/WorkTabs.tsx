import { Link, linkOptions } from "@tanstack/react-router";
import { GitBranchIcon } from "lucide-react";

import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Spinner } from "../ui/spinner";

/** The work pages, in strip order. */
const WORK_TABS = [
  {
    id: "pull-requests",
    label: "Pull Requests",
    icon: PullRequestGlyph.pullRequest,
    link: () => linkOptions({ to: "/pull-requests", search: readPullRequestListPreferences() }),
  },
  // Open work restores its own last selection when opened without a target.
  {
    id: "open-work",
    label: "Open Work",
    icon: GitBranchIcon,
    link: () => linkOptions({ to: "/open-work" }),
  },
] as const;

export type WorkTabId = (typeof WORK_TABS)[number]["id"];

/**
 * The header strip linking the work pages. The current page's label is its heading. `compact`
 * shows the other pages as icons, for condensed headers.
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
  return (
    <div className="flex min-w-0 items-center gap-3">
      {WORK_TABS.map((tab) =>
        tab.id === current ? (
          <h1 key={tab.id} className="truncate text-foreground">
            {tab.label}
          </h1>
        ) : (
          <Link
            key={tab.id}
            {...tab.link()}
            aria-label={compact ? tab.label : undefined}
            title={compact ? tab.label : undefined}
            className="flex shrink-0 items-center gap-1.5 text-muted-foreground [-webkit-app-region:no-drag] hover:text-foreground focus-visible:text-foreground"
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
