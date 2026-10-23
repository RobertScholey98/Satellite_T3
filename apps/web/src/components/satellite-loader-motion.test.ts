import { describe, expect, it } from "vite-plus/test";

import { satelliteLoaderExitFrame, satelliteLoaderLoopFrame } from "./satellite-loader-motion";

describe("approved Satellite loader geometry", () => {
  it("preserves the square orbit and reflects both body arms along the travel axis", () => {
    for (const [phase, x, y] of [
      [0, 48, 16],
      [0.25, 54.627, 54.627],
      [0.5, 16, 48],
      [0.75, 9.373, 9.373],
    ] as const) {
      expect(satelliteLoaderLoopFrame(phase)).toMatchObject({ x, y });
    }
    expect(satelliteLoaderLoopFrame(1)).toEqual(satelliteLoaderLoopFrame(0));
    for (let phase = 0; phase <= 1; phase += 0.025) {
      const { points } = satelliteLoaderLoopFrame(phase);
      for (const [index, [x, y]] of points.entries()) {
        const reflected = points[points.length - 1 - index]!;
        expect(x).toBeCloseTo(64 - reflected[1], 8);
        expect(y).toBeCloseTo(64 - reflected[0], 8);
      }
    }
  });

  it("finishes from any visible pose and reaches the centre without invalid coordinates", () => {
    for (let phase = 0; phase < 1; phase += 0.025) {
      const { points: _points, ...loop } = satelliteLoaderLoopFrame(phase);
      expect(satelliteLoaderExitFrame(0, phase)).toEqual(loop);
      const end = satelliteLoaderExitFrame(1, phase);
      expect(end).toMatchObject({ x: 32, y: 32, squareScale: 0, opacity: 0 });
      expect(end.path.match(/-?\d+(?:\.\d+)?/g)!.every((value) => Number(value) === 32)).toBe(true);
      for (let progress = 0; progress <= 1; progress += 0.05) {
        const frame = satelliteLoaderExitFrame(progress, phase);
        expect(JSON.stringify(frame)).not.toMatch(/NaN|Infinity|null/);
        expect(frame.opacity).toBeGreaterThanOrEqual(0);
        expect(frame.squareScale).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
