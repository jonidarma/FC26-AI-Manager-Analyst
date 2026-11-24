import { contextBridge, ipcRenderer } from 'electron';

/**
 * Restricted Electron Preload Bridge.
 * Exposes only explicitly whitelisted IPC channels to the React renderer.
 * Never exposes Node.js primitives, filesystem handles, or raw ipcRenderer.
 */
contextBridge.exposeInMainWorld('fc26Desktop', {
  getCapabilities: () => ipcRenderer.invoke('desktop:get-capabilities'),
  listCaptureSources: () => ipcRenderer.invoke('capture:list-sources'),
  getDiskSpace: (targetDir: string) => ipcRenderer.invoke('capture:disk-space', targetDir),
  getRecoverableSessions: () => ipcRenderer.invoke('capture:get-recoverable-sessions'),
  prepareCaptureSession: (payload: {
    matchId: string;
    half: 'first_half' | 'second_half';
    sourceId: string;
    sourceName: string;
    resolution: string;
    fps: number;
    segmentDurationMinutes: number;
  }) => ipcRenderer.invoke('capture:prepare-session', payload),
  finalizeCaptureSession: (sessionId: string) =>
    ipcRenderer.invoke('capture:finalize-session', sessionId),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
});
