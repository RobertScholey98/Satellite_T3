import type {
  SatellitePillBridge,
  SatellitePillLayout,
  SatellitePillState,
} from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";
import * as Channels from "./satellite/channels.ts";

contextBridge.exposeInMainWorld("satellitePillBridge", {
  openMain: () => ipcRenderer.send(Channels.SATELLITE_PILL_OPEN),
  movePill: (direction) => ipcRenderer.send(Channels.SATELLITE_PILL_MOVE, direction),
  beginPillDrag: () => ipcRenderer.send(Channels.SATELLITE_PILL_DRAG_BEGIN),
  dispatchIntent: (intent) => ipcRenderer.send(Channels.SATELLITE_ATTENTION_INTENT, intent),
  setLayout: (request) => ipcRenderer.send(Channels.SATELLITE_PILL_LAYOUT_REQUEST, request),
  onLayout: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, layout: SatellitePillLayout) =>
      listener(layout);
    ipcRenderer.on(Channels.SATELLITE_PILL_LAYOUT, wrapped);
    ipcRenderer.send(Channels.SATELLITE_PILL_READY);
    return () => ipcRenderer.removeListener(Channels.SATELLITE_PILL_LAYOUT, wrapped);
  },
  onPillState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: SatellitePillState) =>
      listener(state);
    ipcRenderer.on(Channels.SATELLITE_PILL_STATE, wrapped);
    ipcRenderer.send(Channels.SATELLITE_PILL_READY);
    return () => ipcRenderer.removeListener(Channels.SATELLITE_PILL_STATE, wrapped);
  },
} satisfies SatellitePillBridge);
