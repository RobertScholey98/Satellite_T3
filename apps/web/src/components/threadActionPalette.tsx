import type { ContextMenuItem } from "@t3tools/contracts";
import {
  ArchiveIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  HashIcon,
  LinkIcon,
  MailOpenIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  SettingsIcon,
  TimerIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  THREAD_ACTION_SHORTCUT_COMMANDS,
  threadActionForShortcut,
  type ThreadActionMenuId,
} from "./threadActionMenu.logic";

const ICONS: Readonly<Record<string, LucideIcon>> = {
  archive: ArchiveIcon,
  "circle-check": CircleCheckIcon,
  clock: ClockIcon,
  copy: CopyIcon,
  folder: FolderIcon,
  "folder-tree": FolderTreeIcon,
  "git-branch": GitBranchIcon,
  hash: HashIcon,
  link: LinkIcon,
  "mail-open": MailOpenIcon,
  "message-square-plus": MessageSquarePlusIcon,
  pencil: PencilIcon,
  pin: PinIcon,
  "pin-off": PinOffIcon,
  "refresh-cw": RefreshCwIcon,
  settings: SettingsIcon,
  timer: TimerIcon,
  trash: Trash2Icon,
};

// Copy targets read as one verb each ("Copy branch") so palette search finds
// them; the other submenus stay submenus because their children only make
// sense under the parent ("Enabled", "In 1 hour").
const FLATTENED_PARENTS: ReadonlySet<ThreadActionMenuId> = new Set(["copy"]);

function lowerFirstWord(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function icon(name: string | undefined, className: string) {
  const Icon = (name && ICONS[name]) || CopyIcon;
  return <Icon className={className} />;
}

/**
 * Projects the thread action registry (the same items the context menus
 * show) into command palette entries for one thread.
 */
export function buildThreadActionPaletteItems(input: {
  readonly items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>;
  readonly run: (action: ThreadActionMenuId) => Promise<void>;
}): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const shortcutByAction = new Map(
    THREAD_ACTION_SHORTCUT_COMMANDS.flatMap((command) => {
      const target = threadActionForShortcut(command, input.items);
      return target ? [[target, command] as const] : [];
    }),
  );
  const action = (
    item: ContextMenuItem<ThreadActionMenuId>,
    title: string,
    iconName: string | undefined,
  ): CommandPaletteActionItem => {
    const shortcutCommand = shortcutByAction.get(item.id);
    return {
      kind: "action",
      value: `thread-action:${item.id}`,
      searchTerms: [title, "thread"],
      title,
      icon: icon(iconName, ITEM_ICON_CLASS),
      ...(item.disabled ? { disabled: true } : {}),
      ...(shortcutCommand ? { shortcutCommand } : {}),
      run: () => input.run(item.id),
    };
  };
  return input.items.flatMap(
    (item): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> => {
      if (!item.children) return [action(item, item.label, item.icon)];
      if (FLATTENED_PARENTS.has(item.id)) {
        return item.children.map((child) =>
          action(
            item.disabled ? { ...child, disabled: true } : child,
            `${item.label} ${lowerFirstWord(child.label)}`,
            child.icon ?? item.icon,
          ),
        );
      }
      return [
        {
          kind: "submenu",
          value: `thread-action:${item.id}`,
          searchTerms: [item.label, "thread"],
          title: item.label,
          icon: icon(item.icon, ITEM_ICON_CLASS),
          addonIcon: icon(item.icon, ADDON_ICON_CLASS),
          ...(item.disabled ? { disabled: true } : {}),
          groups: [
            {
              value: item.id,
              label: item.label,
              items: item.children.map((child) =>
                action(
                  item.disabled ? { ...child, disabled: true } : child,
                  child.label,
                  item.icon,
                ),
              ),
            },
          ],
        },
      ];
    },
  );
}
