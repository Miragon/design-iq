/** The bridge into the page: `window.beluga`, the BelugaApi of core/ipc.ts and nothing more. */
import { contextBridge, ipcRenderer } from "electron";

import type { BelugaApi } from "../core/ipc.ts";

function on<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: BelugaApi = {
  init: () => ipcRenderer.invoke("beluga:init"),
  chooseFolder: (current) => ipcRenderer.invoke("beluga:choose-folder", current),
  installModel: (model) => ipcRenderer.invoke("beluga:install-model", model),
  importGlossary: () => ipcRenderer.invoke("beluga:import-glossary"),
  setPreferences: (change) => ipcRenderer.send("beluga:set-preferences", change),
  start: () => ipcRenderer.invoke("beluga:start"),
  stop: () => ipcRenderer.invoke("beluga:stop"),
  audio: (channel, samples, at) => ipcRenderer.send("beluga:audio", channel, samples, at),
  showFile: (path) => ipcRenderer.send("beluga:show-file", path),
  onLine: (listener) => on("beluga:line", listener),
  onDownload: (listener) => on("beluga:download", listener),
  onLag: (listener) => on("beluga:lag", listener),
  onSessionEnded: (listener) => on("beluga:session-ended", listener),
  onFinishing: (listener) => on("beluga:finishing", listener),
  onPreferences: (listener) => on("beluga:preferences", listener),
  onLeft: (listener) => on("beluga:left", listener),
  onAgent: (listener) => on("beluga:agent", listener),
  onRemote: (listener) => on("beluga:remote", listener),
  remoteDone: (id, result) => ipcRenderer.send("beluga:remote-done", id, result),
  copyAgentCommand: () => ipcRenderer.invoke("beluga:copy-agent-command"),
  renewAgentKey: () => ipcRenderer.invoke("beluga:renew-agent-key"),
};

contextBridge.exposeInMainWorld("beluga", api);
