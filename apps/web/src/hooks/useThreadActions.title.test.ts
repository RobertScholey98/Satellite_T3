import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";

const state = vi.hoisted(() => ({
  canOperate: true,
  supportsTitleRegeneration: true,
  shell: { title: "Release prep", titleRegeneration: null as string | null },
  updateMetadata: vi.fn(),
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => state.canOperate,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({}) }));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentSupportsTitleRegeneration: () => state.supportsTitleRegeneration,
  readThreadShell: () => state.shell,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === threadEnvironment.updateMetadata ? state.updateMetadata : vi.fn(),
}));

const target = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

let toasts: unknown[] = [];
beforeEach(() => {
  state.canOperate = true;
  state.supportsTitleRegeneration = true;
  state.shell = { title: "Release prep", titleRegeneration: null };
  state.updateMetadata.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  toasts = [];
  vi.spyOn(toastManager, "add").mockImplementation((toast) => {
    toasts.push(toast);
    return "toast";
  });
});
afterEach(() => vi.restoreAllMocks());

describe("renameThread", () => {
  it("commits the trimmed title", async () => {
    expect(await useThreadActions().renameThread(target, "  Ship it  ")).toBe("renamed");
    expect(state.updateMetadata.mock.calls).toEqual([
      [{ environmentId: "environment-1", input: { threadId: "thread-1", title: "Ship it" } }],
    ]);
    expect(toasts).toEqual([]);
  });

  it("rejects an empty title with a warning and no mutation", async () => {
    expect(await useThreadActions().renameThread(target, "   ")).toBe("empty");
    expect(state.updateMetadata.mock.calls).toEqual([]);
    expect(toasts).toEqual([{ type: "warning", title: "Thread title cannot be empty" }]);
  });

  it("skips the mutation when the trimmed title is unchanged", async () => {
    expect(await useThreadActions().renameThread(target, " Release prep ")).toBe("unchanged");
    expect(state.updateMetadata.mock.calls).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("reports a failed rename", async () => {
    state.updateMetadata.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("server rejected title"))),
    );
    expect(await useThreadActions().renameThread(target, "Ship it")).toBe("failed");
    expect(toasts).toMatchObject([
      { type: "error", title: "Failed to rename thread", description: "server rejected title" },
    ]);
  });

  it("stays quiet when the rename is interrupted", async () => {
    state.updateMetadata.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    expect(await useThreadActions().renameThread(target, "Ship it")).toBe("interrupted");
    expect(toasts).toEqual([]);
  });

  it("does nothing on a connection that cannot change threads", async () => {
    state.canOperate = false;
    expect(await useThreadActions().renameThread(target, "Ship it")).toBe("unavailable");
    expect(state.updateMetadata.mock.calls).toEqual([]);
  });
});

describe("regenerateThreadTitle", () => {
  it("asks the server for a new title", async () => {
    const result = await useThreadActions().regenerateThreadTitle(target);
    expect(result._tag).toBe("Success");
    expect(state.updateMetadata.mock.calls).toEqual([
      [{ environmentId: "environment-1", input: { threadId: "thread-1", regenerateTitle: true } }],
    ]);
  });

  it("does not race a regeneration already in flight", async () => {
    state.shell = { title: "Release prep", titleRegeneration: "2026-10-15T00:00:00.000Z" };
    await useThreadActions().regenerateThreadTitle(target);
    expect(state.updateMetadata.mock.calls).toEqual([]);
  });

  it("never sends the command to a server without title regeneration", async () => {
    state.supportsTitleRegeneration = false;
    await useThreadActions().regenerateThreadTitle(target);
    expect(state.updateMetadata.mock.calls).toEqual([]);
  });

  it("returns the server failure for the caller to report", async () => {
    state.updateMetadata.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("provider unavailable"))),
    );
    const result = await useThreadActions().regenerateThreadTitle(target);
    expect(result._tag).toBe("Failure");
  });
});
