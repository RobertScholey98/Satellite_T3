import type * as Electron from "electron";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const switches = vi.hoisted(() => new Set<string>());
vi.mock("electron", () => ({
  app: {
    commandLine: {
      hasSwitch: (name: string) => switches.has(name),
      appendSwitch: (name: string) => switches.add(name),
      removeSwitch: (name: string) => switches.delete(name),
    },
  },
}));

import { hideWithoutAnimation, showInactiveWithoutAnimation } from "./WindowsWindowVisibility.ts";

const animationSwitch = "wm-window-animations-disabled";

function overlay(showInactive: () => void) {
  return { showInactive, hide: showInactive } as Electron.BaseWindow;
}

beforeEach(() => {
  switches.clear();
  switches.add("unrelated-switch");
});

it("disables Chromium window animation only while showing the window", () => {
  const flagsDuringShow: string[][] = [];

  showInactiveWithoutAnimation(overlay(() => flagsDuringShow.push([...switches])));

  expect(flagsDuringShow).toEqual([["unrelated-switch", animationSwitch]]);
  expect([...switches]).toEqual(["unrelated-switch"]);
});

it("preserves an animation switch supplied before showing the window", () => {
  switches.add(animationSwitch);
  const flagsDuringShow: string[][] = [];

  showInactiveWithoutAnimation(overlay(() => flagsDuringShow.push([...switches])));

  expect(flagsDuringShow).toEqual([["unrelated-switch", animationSwitch]]);
  expect([...switches]).toEqual(["unrelated-switch", animationSwitch]);
});

it.each([false, true])(
  "scopes hide animation suppression to the window (preexisting: %s)",
  (preexisting) => {
    if (preexisting) switches.add(animationSwitch);
    const flagsDuringHide: string[][] = [];
    hideWithoutAnimation(overlay(() => flagsDuringHide.push([...switches])));
    expect(flagsDuringHide).toEqual([["unrelated-switch", animationSwitch]]);
    expect([...switches]).toEqual(
      preexisting ? ["unrelated-switch", animationSwitch] : ["unrelated-switch"],
    );
  },
);

it.each([false, true])(
  "restores the original switch state when showing throws (preexisting: %s)",
  (preexisting) => {
    if (preexisting) switches.add(animationSwitch);
    const original = [...switches];
    const failure = new Error("Overlay was destroyed");
    const window = overlay(() => {
      expect(switches.has(animationSwitch)).toBe(true);
      throw failure;
    });

    expect(() => showInactiveWithoutAnimation(window)).toThrow(failure);
    expect([...switches]).toEqual(original);
  },
);
