import { describe, expect, it } from "vite-plus/test";
import { createDoubleControlDetector } from "./doubleControl.ts";

describe("double Ctrl", () => {
  it("recognizes left or right Ctrl taps and consumes each pair", () => {
    const key = createDoubleControlDetector();
    expect(key(0xa2, false, 0)).toBe(false);
    expect(key(0xa2, true, 40)).toBe(false);
    expect(key(0xa3, false, 100)).toBe(false);
    expect(key(0xa3, true, 140)).toBe(true);
    expect(key(0xa2, false, 200)).toBe(false);
    expect(key(0xa2, true, 240)).toBe(false);
  });

  it("requires releases and ignores auto-repeat", () => {
    const key = createDoubleControlDetector();
    key(0xa2, false, 0);
    expect(key(0xa2, false, 20)).toBe(false);
    expect(key(0xa2, false, 40)).toBe(false);
    expect(key(0xa2, true, 60)).toBe(false);
    key(0xa2, false, 80);
    expect(key(0xa2, true, 100)).toBe(true);
  });

  it("rejects slow pairs and held Ctrl", () => {
    const key = createDoubleControlDetector();
    key(0xa2, false, 0);
    key(0xa2, true, 20);
    key(0xa2, false, 500);
    expect(key(0xa2, true, 520)).toBe(false);
    key(0xa2, false, 550);
    expect(key(0xa2, true, 1000)).toBe(false);
    key(0xa2, false, 1050);
    expect(key(0xa2, true, 1080)).toBe(false);
  });

  it.each([0x43, 0x10, 0xa3])("cancels a pair when another key is pressed (%s)", (other) => {
    const key = createDoubleControlDetector();
    key(0xa2, false, 0);
    key(0xa2, true, 20);
    key(0xa2, false, 100);
    key(other, false, 110);
    key(other, true, 120);
    expect(key(0xa2, true, 140)).toBe(false);
    key(0xa2, false, 200);
    expect(key(0xa2, true, 220)).toBe(false);
  });

  it("rejects Ctrl taps while another key is already held", () => {
    const key = createDoubleControlDetector();
    key(0x12, false, 0);
    key(0xa2, false, 20);
    key(0xa2, true, 40);
    key(0xa2, false, 60);
    expect(key(0xa2, true, 80)).toBe(false);
  });
});
