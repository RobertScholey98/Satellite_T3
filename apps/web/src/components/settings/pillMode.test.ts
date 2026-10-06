// @vitest-environment jsdom
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  add: vi.fn<
    (toast: { title: string; id?: string; actionProps?: { onClick: () => Promise<void> } }) => void
  >(),
  close: vi.fn(),
  restartApp: vi.fn<() => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence: mocks }) }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.add, close: mocks.close } }));

import {
  __resetClientSettingsPersistenceForTests,
  getClientSettings,
} from "../../hooks/useSettings";
import { setPillModeEnabled } from "./pillMode";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getClientSettings.mockResolvedValue(null);
  mocks.setClientSettings.mockResolvedValue(undefined);
  mocks.restartApp.mockResolvedValue(undefined);
  vi.stubGlobal("desktopBridge", { restartApp: mocks.restartApp });
  __resetClientSettingsPersistenceForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("Satellite widget restart prompt", () => {
  it("waits for persistence and only restarts when the toast action is chosen", async () => {
    let finishSaving!: () => void;
    const saved = new Promise<void>((resolve) => {
      finishSaving = resolve;
    });
    let startedSaving!: () => void;
    const saving = new Promise<void>((resolve) => {
      startedSaving = resolve;
    });
    mocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      satellitePillEnabled: true,
    });
    mocks.setClientSettings.mockImplementation(() => {
      startedSaving();
      return saved;
    });
    const change = setPillModeEnabled(false, true);
    await saving;
    expect(mocks.add).not.toHaveBeenCalled();
    expect(getClientSettings().satellitePillEnabled).toBe(true);
    finishSaving();
    await change;
    expect(getClientSettings().satellitePillEnabled).toBe(false);
    expect(mocks.restartApp).not.toHaveBeenCalled();
    const toast = mocks.add.mock.calls[0]![0];
    expect(toast).toMatchObject({
      title: "Restart to apply Satellite widget preference",
      actionProps: { children: "Restart now" },
    });
    await toast.actionProps!.onClick();
    expect(mocks.restartApp).toHaveBeenCalledOnce();
  });

  it("dismisses the prompt when the saved mode is switched back to the running mode", async () => {
    await setPillModeEnabled(true, false);
    const toastId = mocks.add.mock.calls[0]![0].id;
    await setPillModeEnabled(false, false);
    expect(mocks.close).toHaveBeenCalledWith(toastId);
    expect(mocks.add).toHaveBeenCalledOnce();
    expect(mocks.restartApp).not.toHaveBeenCalled();
  });

  it("keeps the previous preference and offers no restart if saving fails", async () => {
    mocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      satellitePillEnabled: false,
    });
    mocks.setClientSettings.mockRejectedValue(new Error("Disk is full"));
    await setPillModeEnabled(true, false);
    expect(getClientSettings().satellitePillEnabled).toBe(false);
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't save Satellite widget preference" }),
    );
    expect(mocks.add.mock.calls[0]![0].actionProps).toBeUndefined();
    expect(mocks.restartApp).not.toHaveBeenCalled();
  });

  it("reports a failed restart request", async () => {
    mocks.restartApp.mockRejectedValue(new Error("Restart failed"));
    await setPillModeEnabled(true, false);
    await mocks.add.mock.calls[0]![0].actionProps!.onClick();
    expect(mocks.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Couldn't restart the app" }),
    );
  });
});
