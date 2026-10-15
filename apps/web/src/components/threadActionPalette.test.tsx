import { describe, expect, it } from "vite-plus/test";

import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "./CommandPalette.logic";
import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";
import { buildThreadActionPaletteItems } from "./threadActionPalette";

const state: ThreadActionMenuState = {
  canOperate: true,
  branch: "feature/palette",
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function summarize(items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>) {
  return items.map((item) => ({
    value: item.value,
    title: item.title,
    disabled: item.disabled === true,
    ...(item.kind === "submenu"
      ? { children: item.groups.flatMap((group) => group.items.map((child) => child.title)) }
      : {}),
  }));
}

describe("buildThreadActionPaletteItems", () => {
  it("lists the context menu's actions, flattening Copy into searchable verbs", () => {
    const items = buildThreadActionPaletteItems({
      items: buildThreadActionMenuItems(state),
      run: async () => {},
    });
    expect(summarize(items)).toEqual([
      {
        value: "thread-action:new-thread-on-branch",
        title: "New thread on feature/palette",
        disabled: false,
      },
      { value: "thread-action:pin", title: "Pin thread", disabled: false },
      { value: "thread-action:settle", title: "Settle thread", disabled: false },
      {
        value: "thread-action:snooze",
        title: "Snooze",
        disabled: false,
        children: ["In 1 hour (3:00 PM)", "Custom…"],
      },
      { value: "thread-action:rename", title: "Rename thread", disabled: false },
      { value: "thread-action:regenerate-title", title: "Regenerate title", disabled: false },
      { value: "thread-action:mark-unread", title: "Mark unread", disabled: false },
      {
        value: "thread-action:auto-settle",
        title: "Auto-settle behavior",
        disabled: false,
        children: ["Enabled", "Disabled"],
      },
      { value: "thread-action:copy-path", title: "Copy path", disabled: false },
      { value: "thread-action:copy-branch", title: "Copy branch", disabled: false },
      { value: "thread-action:copy-thread-id", title: "Copy thread ID", disabled: false },
      { value: "thread-action:project-settings", title: "Project settings", disabled: false },
      { value: "thread-action:archive", title: "Archive thread", disabled: false },
      { value: "thread-action:delete", title: "Delete", disabled: false },
    ]);
  });

  it("keeps the menu's enablement: read-only connections see mutations disabled", () => {
    const items = buildThreadActionPaletteItems({
      items: buildThreadActionMenuItems({ ...state, canOperate: false, isRegeneratingTitle: true }),
      run: async () => {},
    });
    const disabled = summarize(items)
      .filter((item) => item.disabled)
      .map((item) => item.value);
    expect(disabled).toEqual([
      "thread-action:pin",
      "thread-action:settle",
      "thread-action:snooze",
      "thread-action:rename",
      "thread-action:regenerate-title",
      "thread-action:auto-settle",
      "thread-action:archive",
      "thread-action:delete",
    ]);
  });

  it("runs the registry action the entry was built from", async () => {
    const ran: string[] = [];
    const items = buildThreadActionPaletteItems({
      items: buildThreadActionMenuItems(state),
      run: async (action) => {
        ran.push(action);
      },
    });
    const snooze = items.find((item) => item.value === "thread-action:snooze");
    const rename = items.find((item) => item.value === "thread-action:rename");
    if (snooze?.kind !== "submenu" || rename?.kind !== "action") throw new Error("missing entries");
    await rename.run();
    const hour = snooze.groups[0]!.items[0]!;
    if (hour.kind !== "action") throw new Error("snooze preset is not an action");
    await hour.run();
    expect(ran).toEqual(["rename", "snooze:hour"]);
  });
});
