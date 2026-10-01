// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readSatellitePillTheme, watchSatellitePillTheme } from "./satellitePillTheme";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("class");
});

describe("Satellite pill theme", () => {
  it("reads the applied palette and follows theme previews without a saved settings change", async () => {
    const root = document.documentElement;
    root.style.setProperty("--background", "#163024");
    root.style.setProperty("--foreground", "#fafafa");
    expect(readSatellitePillTheme()).toMatchObject({
      "--background": "#163024",
      "--foreground": "#fafafa",
    });
    const publish = vi.fn(() => readSatellitePillTheme());
    const stop = watchSatellitePillTheme(publish);
    try {
      root.style.setProperty("--background", "#f5f5f5");
      root.classList.add("light");
      await Promise.resolve();
      expect(publish).toHaveReturnedWith(expect.objectContaining({ "--background": "#f5f5f5" }));
      publish.mockClear();
      root.dataset.satelliteMode = "pill";
      root.style.setProperty("--unrelated-layout-width", "300px");
      await Promise.resolve();
      expect(publish).not.toHaveBeenCalled();
      stop();
      root.style.setProperty("--background", "#000000");
      await Promise.resolve();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      stop();
      delete root.dataset.satelliteMode;
    }
  });
});
