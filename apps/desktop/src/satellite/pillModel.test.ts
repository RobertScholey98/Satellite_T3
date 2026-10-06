import { describe, expect, it, vi } from "vite-plus/test";
import { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  clampPillBounds,
  handleMainClose,
  resolvePillBounds,
  resolvePillLayout,
  resolveWorkspaceBounds,
  unavailablePillState,
} from "./pillModel.ts";

describe("Satellite pill placement", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  it("matches the reference control sizes and clamps the complete row at the right edge", () => {
    const compact = clampPillBounds({ x: 1890, y: 100 }, [primary]);
    expect(compact).toEqual({ x: 1668, y: 100, width: 252, height: 56 });
    const attached = resolvePillLayout(compact, { mode: "compact", wing: true }, [primary]);
    expect(attached.bounds).toEqual({ x: 1480, y: 100, width: 440, height: 568 });
    expect(attached.layout.pill).toEqual({ x: 124, y: 0, width: 252, height: 56 });
    expect(attached.layout.wing).toEqual({ x: 376, y: 0, width: 64, height: 56 });
    expect(attached.shape).toEqual([
      { x: 124, y: 0, width: 252, height: 56 },
      { x: 376, y: 0, width: 64, height: 56 },
    ]);
  });
  it("starts above the taskbar in the primary work area", () => {
    expect(clampPillBounds(null, [primary])).toEqual({ x: 1644, y: 960, width: 252, height: 56 });
  });
  it("keeps saved positions on displays with negative coordinates", () => {
    const secondary = { x: -1600, y: 0, width: 1600, height: 900 };
    expect(clampPillBounds({ x: -1400, y: 40 }, [primary, secondary])).toEqual({
      x: -1400,
      y: 40,
      width: 252,
      height: 56,
    });
  });
  it("recovers a saved location when its monitor disappears", () => {
    expect(clampPillBounds({ x: -1400, y: 1050 }, [primary])).toEqual({
      x: 0,
      y: 984,
      width: 252,
      height: 56,
    });
  });
  it("clamps placement after a scale or work area change", () => {
    expect(
      clampPillBounds({ x: 1850, y: 990 }, [{ ...primary, width: 1280, height: 680 }]),
    ).toEqual({
      x: 1028,
      y: 624,
      width: 252,
      height: 56,
    });
  });
});

describe("Satellite action wing placement", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const anchor = { x: 1644, y: 960, width: 252, height: 56 };

  it("clamps the whole row at the right edge and opens above it", () => {
    const result = resolvePillLayout(anchor, { mode: "panel", wing: true }, [area]);
    expect(result).toEqual({
      bounds: { x: 1480, y: 448, width: 440, height: 568 },
      layout: {
        mode: "panel",
        width: 440,
        height: 568,
        pill: { x: 124, y: 512, width: 252, height: 56 },
        wing: { x: 376, y: 512, width: 64, height: 56 },
        panel: { x: 0, y: 0, width: 440, height: 500 },
      },
      shape: [
        { x: 124, y: 512, width: 252, height: 56 },
        { x: 376, y: 512, width: 64, height: 56 },
        { x: 0, y: 0, width: 440, height: 500 },
      ],
    });
  });

  it("keeps native bounds and row coordinates stable through every wing mode", () => {
    for (const mode of ["compact", "preview", "panel"] as const) {
      const result = resolvePillLayout(anchor, { mode, wing: true }, [area]);
      expect(result.bounds).toEqual({ x: 1480, y: 448, width: 440, height: 568 });
      expect(result.layout.pill).toEqual({ x: 124, y: 512, width: 252, height: 56 });
      expect(result.layout.wing).toEqual({ x: 376, y: 512, width: 64, height: 56 });
      expect(result.shape).toEqual([
        { x: 124, y: 512, width: 252, height: 56 },
        { x: 376, y: 512, width: 64, height: 56 },
        ...(mode === "panel" ? [{ x: 0, y: 0, width: 440, height: 500 }] : []),
      ]);
    }
    expect(resolvePillLayout(anchor, { mode: "compact", wing: false }, [area]).bounds).toEqual(
      anchor,
    );
  });

  it("reserves the panel and preview below a top-edge pill without making blank space interactive", () => {
    for (const mode of ["compact", "preview", "panel"] as const) {
      const result = resolvePillLayout(
        { x: 100, y: 100, width: 252, height: 56 },
        { mode, wing: true },
        [area],
      );
      expect(result.bounds).toEqual({ x: 0, y: 100, width: 672, height: 568 });
      expect(result.layout.pill).toEqual({ x: 100, y: 0, width: 252, height: 56 });
      expect(result.layout.wing).toEqual({
        x: 352,
        y: 0,
        width: mode === "preview" ? 320 : 64,
        height: 56,
      });
      expect(result.layout.panel).toEqual(
        mode === "panel" ? { x: 0, y: 68, width: 440, height: 500 } : null,
      );
      expect(
        result.shape.some(
          (rect) =>
            rect.x <= 600 &&
            rect.x + rect.width > 600 &&
            rect.y <= 100 &&
            rect.y + rect.height > 100,
        ),
      ).toBe(false);
    }
  });

  it("clamps panel height and preview width to the work area", () => {
    const small = { x: 0, y: 0, width: 700, height: 500 };
    const position = { x: 190, y: 100, width: 252, height: 56 };
    const result = resolvePillLayout(position, { mode: "panel", wing: true }, [small]);
    expect(result.bounds).toEqual({ x: 66, y: 100, width: 634, height: 400 });
    expect(result.layout.panel).toEqual({ x: 0, y: 68, width: 440, height: 332 });
    expect(resolvePillLayout(position, { mode: "preview", wing: true }, [small]).bounds).toEqual({
      x: 66,
      y: 100,
      width: 634,
      height: 400,
    });
  });

  it("keeps all controls within a negative-coordinate monitor", () => {
    const secondary = { x: -1600, y: -200, width: 1600, height: 900 };
    const result = resolvePillLayout(
      { x: -400, y: 600, width: 252, height: 56 },
      { mode: "panel", wing: true },
      [area, secondary],
    );
    expect(result.bounds).toEqual({ x: -524, y: 88, width: 524, height: 568 });
    expect(result.layout.pill).toEqual({ x: 124, y: 512, width: 252, height: 56 });
  });

  it("narrows the main pill so the wing stays on the right on a small monitor", () => {
    const result = resolvePillLayout(
      { x: 0, y: 0, width: 252, height: 56 },
      { mode: "panel", wing: true },
      [{ x: 0, y: 0, width: 280, height: 500 }],
    );
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 280, height: 500 });
    expect(result.layout.pill).toEqual({ x: 0, y: 0, width: 216, height: 56 });
    expect(result.layout.wing).toEqual({ x: 216, y: 0, width: 64, height: 56 });
    expect(result.layout.panel).toEqual({ x: 0, y: 68, width: 280, height: 432 });
  });

  it.each([
    { area, start: anchor, expected: { x: 1480, y: 448, width: 440, height: 568 } },
    {
      area: { x: -280, y: 0, width: 280, height: 500 },
      start: { x: -280, y: 0, width: 252, height: 56 },
      expected: { x: -280, y: 0, width: 280, height: 500 },
    },
  ])(
    "preserves the envelope when the controller feeds back its clamped anchor in $area",
    ({ area, start, expected }) => {
      let current = start;
      for (const mode of ["compact", "panel", "preview", "compact", "panel"] as const) {
        const result = resolvePillLayout(current, { mode, wing: true }, [area]);
        expect(result.bounds).toEqual(expected);
        current = {
          ...result.layout.pill,
          x: result.bounds.x + result.layout.pill.x,
          y: result.bounds.y + result.layout.pill.y,
        };
      }
    },
  );
});

describe("Satellite workspace placement", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const workspaceSize = { width: 1120, height: 820 };

  it.each([
    { pill: { x: 0, y: 0 }, workspace: { x: 0, y: 0 } },
    { pill: { x: 834, y: 492 }, workspace: { x: 400, y: 110 } },
    { pill: { x: 1668, y: 984 }, workspace: { x: 800, y: 220 } },
  ])(
    "keeps the same monitor anchor when expanding and collapsing at $pill",
    ({ pill, workspace }) => {
      const pillBounds = { ...pill, width: 252, height: 56 };
      const expanded = resolveWorkspaceBounds(pillBounds, workspaceSize, [primary]);
      expect(expanded).toEqual({ ...workspace, ...workspaceSize });
      expect(resolvePillBounds(expanded, [primary], pillBounds)).toEqual(pillBounds);
    },
  );

  it("expands the default bottom-right pill in place and restores its position", () => {
    const pill = clampPillBounds(null, [primary]);
    const expanded = resolveWorkspaceBounds(pill, workspaceSize, [primary]);
    expect(expanded).toEqual({ x: 788, y: 215, ...workspaceSize });
    expect(resolvePillBounds(expanded, [primary], pill)).toEqual(pill);
  });

  it("expands on the pill's monitor when its coordinates are negative", () => {
    const secondary = { x: -1600, y: -200, width: 1600, height: 900 };
    const pill = { x: -252, y: 644, width: 252, height: 56 };
    const expanded = resolveWorkspaceBounds(pill, workspaceSize, [primary, secondary]);
    expect(expanded).toEqual({ x: -1120, y: -120, ...workspaceSize });
    expect(resolvePillBounds(expanded, [primary, secondary], pill)).toEqual(pill);
  });

  it("caps the workspace to a small monitor and restores the saved pill anchor", () => {
    const small = { x: -800, y: 20, width: 800, height: 600 };
    const pill = { x: -680, y: 418, width: 252, height: 56 };
    const expanded = resolveWorkspaceBounds(pill, workspaceSize, [small]);
    expect(expanded).toEqual(small);
    expect(resolvePillBounds(expanded, [small], pill)).toEqual(pill);
  });

  it("retains only the anchor on a filled axis after the workspace moves", () => {
    const area = { x: 40, y: 20, width: 1000, height: 1000 };
    const pill = { x: 720, y: 492, width: 252, height: 56 };
    const expanded = resolveWorkspaceBounds(pill, workspaceSize, [area]);
    expect(expanded).toEqual({ x: 40, y: 110, width: 1000, height: 820 });
    expect(resolvePillBounds({ ...expanded, y: 20 }, [area], pill)).toEqual({
      x: 720,
      y: 20,
      width: 252,
      height: 56,
    });
  });

  it("centers a pill without a saved anchor when the workspace fills the monitor", () => {
    expect(resolvePillBounds(primary, [primary])).toEqual({
      x: 834,
      y: 492,
      width: 252,
      height: 56,
    });
  });

  it("recovers onto the nearest remaining monitor", () => {
    const disconnected = { x: -1400, y: 50, width: 252, height: 56 };
    const expanded = resolveWorkspaceBounds(disconnected, workspaceSize, [primary]);
    expect(expanded).toEqual({ x: 0, y: 11, ...workspaceSize });
    const collapsed = resolvePillBounds({ ...expanded, x: -500 }, [primary]);
    expect(collapsed.x).toBe(primary.x);
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
  it("retains last-known requests and drafts while making them unavailable", () => {
    const ref = {
      environmentId: EnvironmentId.make("remote-1"),
      threadId: ThreadId.make("thread-1"),
      kind: "question" as const,
      requestId: ApprovalRequestId.make("question-1"),
    };
    const result = unavailablePillState({
      threadId: "thread-1",
      environmentId: "remote-1",
      title: "Fix the build",
      state: "awaiting-input",
      detail: "Choose",
      attention: true,
      dark: true,
      actionWing: {
        items: [
          {
            ref,
            title: "Fix the build",
            environmentName: "Workstation",
            label: "Question",
            preview: "Choose an option",
            createdAt: "2026-10-05T12:00:00.000Z",
            available: true,
            muted: false,
          },
        ],
        selected: {
          ref,
          status: "ready",
          delivery: "sending",
          questionIndex: 0,
          answers: { choice: { customAnswer: "Keep it" } },
        },
        incompleteEnvironments: [],
        workingCount: 2,
        completedCount: 1,
      },
    });
    expect(result.actionWing?.items[0]).toMatchObject({ ref, available: false, muted: false });
    expect(result.actionWing?.selected).toEqual({
      ref,
      status: "unavailable",
      delivery: "sending",
      questionIndex: 0,
      answers: { choice: { customAnswer: "Keep it" } },
    });
    expect(result.actionWing?.incompleteEnvironments).toEqual(["Workstation"]);
    expect(result.dark).toBe(true);
  });
});
