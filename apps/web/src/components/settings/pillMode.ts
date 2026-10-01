import { persistClientSettingsUpdate } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";

const RESTART_TOAST_ID = "pill-mode-restart";

export async function setPillModeEnabled(enabled: boolean, active: boolean): Promise<void> {
  try {
    await persistClientSettingsUpdate((settings) => ({
      ...settings,
      satellitePillEnabled: enabled,
    }));
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't save Pill mode",
      description: error instanceof Error ? error.message : "Try again.",
    });
    return;
  }

  if (enabled === active) {
    toastManager.close(RESTART_TOAST_ID);
    return;
  }

  const restart = window.desktopBridge?.restartApp;
  toastManager.add({
    id: RESTART_TOAST_ID,
    type: "info",
    title: "Restart to apply Pill mode",
    description: enabled
      ? "The app will restart with the floating pill enabled."
      : "The app will restart with a normal window and taskbar entry.",
    timeout: 0,
    ...(restart
      ? {
          actionProps: {
            children: "Restart now",
            onClick: async () => {
              try {
                await restart();
              } catch (error) {
                toastManager.add({
                  type: "error",
                  title: "Couldn't restart the app",
                  description: error instanceof Error ? error.message : "Close and reopen the app.",
                });
              }
            },
          },
        }
      : {}),
  });
}
