import { contextBridge, ipcRenderer } from 'electron';
import type {
  CaptureManifest,
  CaptureSourceInfo,
  RecoverableSessionSummary,
  RecordingTelemetry,
  RecoveryExecutionResult,
  StartRecordingSessionRequest,
} from './captureTypes';

/**
 * Restricted Electron Preload Bridge (compiled to dist-electron/preload.cjs).
 * Exposes ONLY explicitly whitelisted IPC channels and binary MessagePort streaming
 * helpers to the React renderer. Never exposes Node.js primitives, filesystem APIs,
 * or raw ipcRenderer.
 */

type TransportControlCallback = (msg: {
  type: 'backpressure';
  active: boolean;
  queuedBytes: number;
  queuedChunks: number;
}) => void;

let activeTransportPort: MessagePort | null = null;
let activeTransportSessionId: string | null = null;
const transportControlListeners = new Set<TransportControlCallback>();

ipcRenderer.on(
  'capture:transport-port',
  (event, meta: { sessionId?: string }) => {
    if (activeTransportPort) {
      try {
        activeTransportPort.close();
      } catch {
        // ignore
      }
      activeTransportPort = null;
    }

    const transferredPort = event.ports?.[0] ?? null;
    if (!transferredPort || !meta?.sessionId) return;

    activeTransportPort = transferredPort;
    activeTransportSessionId = meta.sessionId;
    activeTransportPort.onmessage = (msgEvent) => {
      const payload = msgEvent.data;
      if (payload && typeof payload === 'object' && payload.type === 'backpressure') {
        for (const cb of transportControlListeners) {
          cb(payload);
        }
      }
    };
    activeTransportPort.start();
  }
);

contextBridge.exposeInMainWorld('fc26Desktop', {
  getBackendConnection: () => ipcRenderer.invoke('desktop:get-backend-connection'),
  getCapabilities: () => ipcRenderer.invoke('desktop:get-capabilities'),
  listCaptureSources: (): Promise<CaptureSourceInfo[]> =>
    ipcRenderer.invoke('capture:list-sources'),
  selectCaptureSource: (payload: {
    sourceId: string;
    sourceName: string;
    sourceType: 'window' | 'screen';
    audioRequested: boolean;
  }) => ipcRenderer.invoke('capture:select-source', payload),
  startRecordingSession: (
    req: StartRecordingSessionRequest
  ): Promise<{ sessionId: string; manifest: CaptureManifest; telemetry: RecordingTelemetry }> =>
    ipcRenderer.invoke('capture:start-session', req),
  pauseRecordingSession: (sessionId: string): Promise<RecordingTelemetry> =>
    ipcRenderer.invoke('capture:pause-session', sessionId),
  resumeRecordingSession: (payload: {
    sessionId: string;
    inputMimeType?: string;
  }): Promise<RecordingTelemetry> => ipcRenderer.invoke('capture:resume-session', payload),
  stopRecordingSession: (payload: {
    sessionId?: string;
    reason?: string;
  }): Promise<{ stopped: boolean; manifest: CaptureManifest | null; telemetry: RecordingTelemetry }> =>
    ipcRenderer.invoke('capture:stop-session', payload),
  reportStreamInterrupted: (payload: { sessionId: string; reason: string }) =>
    ipcRenderer.invoke('capture:report-stream-interrupted', payload),
  discardRecordingSession: (payload: {
    sessionId: string;
    matchId?: string;
  }): Promise<{ discarded: boolean; removedFiles: number }> =>
    ipcRenderer.invoke('capture:discard-session', payload),
  getRecordingStatus: (): Promise<RecordingTelemetry> =>
    ipcRenderer.invoke('capture:get-status'),
  getDiskSpace: (targetDir: string) => ipcRenderer.invoke('capture:disk-space', targetDir),
  getRecoverableSessions: (): Promise<RecoverableSessionSummary[]> =>
    ipcRenderer.invoke('capture:get-recoverable-sessions'),
  recoverSession: (sessionId: string): Promise<RecoveryExecutionResult> =>
    ipcRenderer.invoke('capture:recover-session', sessionId),
  openRecordingSegment: (filePath: string): Promise<{ opened: boolean; path: string }> =>
    ipcRenderer.invoke('capture:open-segment', filePath),
  openSessionFolder: (folderPath: string): Promise<{ opened: boolean; path: string }> =>
    ipcRenderer.invoke('capture:open-session-folder', folderPath),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),

  // Binary zero-copy chunk transport over MessagePort (never Base64)
  sendRecordingChunk: (sessionId: string, chunk: ArrayBuffer): boolean => {
    if (!activeTransportPort || activeTransportSessionId !== sessionId) {
      return false;
    }
    try {
      activeTransportPort.postMessage(chunk, [chunk]);
      return true;
    } catch {
      return false;
    }
  },
  endRecordingTransport: (sessionId: string): void => {
    if (!activeTransportPort || activeTransportSessionId !== sessionId) {
      return;
    }
    try {
      activeTransportPort.postMessage({ type: 'eos', sessionId });
    } catch {
      // ignore
    }
  },
  onTransportControl: (cb: TransportControlCallback): (() => void) => {
    transportControlListeners.add(cb);
    return () => {
      transportControlListeners.delete(cb);
    };
  },
  onRecordingTelemetry: (cb: (telemetry: RecordingTelemetry) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, telemetry: RecordingTelemetry) => {
      cb(telemetry);
    };
    ipcRenderer.on('capture:telemetry', handler);
    return () => {
      ipcRenderer.removeListener('capture:telemetry', handler);
    };
  },
});
