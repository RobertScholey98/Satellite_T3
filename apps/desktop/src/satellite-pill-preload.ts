import type { SatellitePillState } from "@t3tools/contracts";
import { ipcRenderer } from "electron";
import * as Channels from "./satellite/channels.ts";

window.addEventListener("DOMContentLoaded", () => {
  const title = document.getElementById("title");
  const detail = document.getElementById("detail");
  const attention = document.getElementById("attention");
  ipcRenderer.on(Channels.SATELLITE_PILL_STATE, (_event, state: SatellitePillState) => {
    document.body.dataset.state = state.state;
    if (title) title.textContent = state.title;
    if (detail) {
      detail.textContent = state.detail;
      detail.title = state.detail;
    }
    if (attention) attention.style.display = state.attention ? "block" : "none";
    document.title = `${state.title} — ${state.detail}`;
  });
  document.getElementById("open")?.addEventListener("click", () => {
    ipcRenderer.send(Channels.SATELLITE_PILL_OPEN);
  });
  document.getElementById("menu")?.addEventListener("click", () => {
    ipcRenderer.send(Channels.SATELLITE_PILL_MENU);
  });
  document.addEventListener("keydown", (event) => {
    if (event.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      ipcRenderer.send(Channels.SATELLITE_PILL_MOVE, event.key);
    }
  });
  ipcRenderer.send(Channels.SATELLITE_PILL_READY);
});
