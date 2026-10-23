import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { SatelliteLoader } from "./SatelliteLoader";
import { satelliteLoaderStill } from "./satellite-loader-motion";

describe("SatelliteLoader", () => {
  it("announces a loading loader and keeps redrawing it", async () => {
    await using screen = await render(<SatelliteLoader loading size={32} />);

    const loader = screen.getByRole("img", { name: "Loading" });
    await expect.element(loader).toHaveAttribute("data-state", "loading");
    await expect.element(loader).toHaveAttribute("aria-hidden", "false");

    const body = loader.element().querySelector("path");
    expect(body?.getAttribute("d")).not.toBe(satelliteLoaderStill.path);

    const firstFrame = body?.getAttribute("d");
    await vi.waitFor(() => expect(body?.getAttribute("d")).not.toBe(firstFrame));
  });

  it("mounts an idle loader hidden and never reports an exit", async () => {
    const onExitComplete = vi.fn();
    await using screen = await render(
      <SatelliteLoader loading={false} onExitComplete={onExitComplete} size={32} />,
    );

    const loader = screen.container.querySelector("svg");
    expect(loader).toHaveAttribute("data-state", "idle");
    expect(loader).toHaveAttribute("aria-hidden", "true");
    expect(onExitComplete).not.toHaveBeenCalled();
  });
});
