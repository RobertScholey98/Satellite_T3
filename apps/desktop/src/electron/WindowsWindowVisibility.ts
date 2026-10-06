import * as Electron from "electron";

const WINDOW_ANIMATIONS_DISABLED = "wm-window-animations-disabled";

function withoutWindowAnimation(changeVisibility: () => void): void {
  // Chromium reads this switch synchronously while changing visibility. Restore it before returning
  // so other windows and CSS animations keep their normal behavior.
  const alreadyDisabled = Electron.app.commandLine.hasSwitch(WINDOW_ANIMATIONS_DISABLED);
  if (!alreadyDisabled) Electron.app.commandLine.appendSwitch(WINDOW_ANIMATIONS_DISABLED);
  try {
    changeVisibility();
  } finally {
    if (!alreadyDisabled) Electron.app.commandLine.removeSwitch(WINDOW_ANIMATIONS_DISABLED);
  }
}

export function showInactiveWithoutAnimation(window: Electron.BaseWindow): void {
  withoutWindowAnimation(() => window.showInactive());
}

export function hideWithoutAnimation(window: Electron.BaseWindow): void {
  withoutWindowAnimation(() => window.hide());
}
