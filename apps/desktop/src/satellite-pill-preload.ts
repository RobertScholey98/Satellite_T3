import type { SatellitePillBridge, SatellitePillState } from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";
import * as Channels from "./satellite/channels.ts";

contextBridge.exposeInMainWorld("satellitePillBridge", {
  openMain: () => ipcRenderer.send(Channels.SATELLITE_PILL_OPEN),
  showMenu: () => ipcRenderer.send(Channels.SATELLITE_PILL_MENU),
  movePill: (direction) => ipcRenderer.send(Channels.SATELLITE_PILL_MOVE, direction),
  beginPillDrag: () => ipcRenderer.send(Channels.SATELLITE_PILL_DRAG_BEGIN),
  onPillState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: SatellitePillState) =>
      listener(state);
    ipcRenderer.on(Channels.SATELLITE_PILL_STATE, wrapped);
    ipcRenderer.send(Channels.SATELLITE_PILL_READY);
    return () => ipcRenderer.removeListener(Channels.SATELLITE_PILL_STATE, wrapped);
  },
} satisfies SatellitePillBridge);
