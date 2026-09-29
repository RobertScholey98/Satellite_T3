import { describe, expect, it, vi } from "vite-plus/test";
import { clampPillBounds, handleMainClose, unavailablePillState } from "./pillModel.ts";

describe("Satellite pill placement", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  it("starts above the taskbar in the primary work area", () => {
    expect(clampPillBounds(null, [primary])).toEqual({ x: 1576, y: 946, width: 320, height: 70 });
  });
  it("keeps saved positions on displays with negative coordinates", () => {
    const secondary = { x: -1600, y: 0, width: 1600, height: 900 };
    expect(clampPillBounds({ x: -1400, y: 40 }, [primary, secondary])).toEqual({
      x: -1400,
      y: 40,
      width: 320,
      height: 70,
    });
  });
  it("recovers a saved location when its monitor disappears", () => {
    expect(clampPillBounds({ x: -1400, y: 1050 }, [primary])).toEqual({
      x: 0,
      y: 970,
      width: 320,
      height: 70,
    });
  });
  it("clamps placement after a scale or work area change", () => {
    expect(
      clampPillBounds({ x: 1850, y: 990 }, [{ ...primary, width: 1280, height: 680 }]),
    ).toEqual({
      x: 960,
      y: 610,
      width: 320,
      height: 70,
    });
  });
});

describe("Satellite lifecycle", () => {
  it("hides the workspace without allowing its renderer to be destroyed", () => {
    const event = { preventDefault: vi.fn() };
    const hide = vi.fn();
    handleMainClose(event, false, hide);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
  });
  it("allows an explicit quit to close windows", () => {
    const event = { preventDefault: vi.fn() };
    const hide = vi.fn();
    handleMainClose(event, true, hide);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });
  it("retains the reveal target but clears attention when the renderer becomes unavailable", () => {
    expect(
      unavailablePillState({
        threadId: "thread-1",
        environmentId: "remote-1",
        title: "Fix the build",
        state: "working",
        detail: "Reading files",
        attention: true,
      }),
    ).toEqual({
      threadId: "thread-1",
      environmentId: "remote-1",
      title: "Fix the build",
      state: "unknown",
      detail: "Status unavailable — reconnecting",
      attention: false,
    });
  });
});
