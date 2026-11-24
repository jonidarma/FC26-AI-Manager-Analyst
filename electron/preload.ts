import { contextBridge, ipcRenderer } from 'electron';

/**
 * Restricted Electron Preload Bridge (compiled to dist-electron/preload.cjs).
 * Exposes only explicitly whitelisted IPC channels to the React renderer.
 * Never exposes Node.js primitives, filesystem handles, or raw ipcRenderer.
 */
contextBridge.exposeInMainWorld('fc26Desktop', {
  getBackendConnection: () => ipcRenderer.invoke('desktop:get-backend-connection'),
  getCapabilities: () => ipcRenderer.invoke('desktop:get-capabilities'),
  listCaptureSources: () => ipcRenderer.invoke('capture:list-sources'),
  getDiskSpace: (targetDir: string) => ipcRenderer.invoke('capture:disk-space', targetDir),
  getRecoverableSessions: () => ipcRenderer.invoke('capture:get-recoverable-sessions'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
});
