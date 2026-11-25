/**
 * FC26 AI Manager — Phase 2.1 Hardened Preload Bridge
 *
 * Security & Reliability Guarantees:
 * - contextIsolation: true, nodeIntegration: false, sandbox: true
 * - Zero Node.js APIs exposed to React renderer
 * - Fixes Phase 2 contextBridge ArrayBuffer transfer silent failure:
 *   Uses structured-cloned Uint8Array over MessagePort (immune to contextBridge DataCloneError)
 *   AND buffers early chunks (including chunk #0 WebM EBML header) until capture:transport-port arrives,
 *   guaranteeing zero silent chunk drops and returning structured diagnostic results.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface RecordingChunkSendResult {
  ok: boolean;
  buffered: boolean;
  bytes: number;
  error?: string;
}

type TransportControlCallback = (msg: {
  type: 'backpressure' | 'port-ready';
  active?: boolean;
  queuedBytes?: number;
  queuedChunks?: number;
  sessionId?: string;
}) => void;

type TelemetryCallback = (telemetry: unknown) => void;

let activeTransportPort: MessagePort | null = null;
let activeTransportSessionId: string | null = null;

// Bounded early-chunk buffer for chunks emitted while MessagePort transfer is still completing
const MAX_EARLY_BUFFER_BYTES = 12 * 1024 * 1024; // 12 MB safety bound
let earlyBufferSessionId: string | null = null;
let earlyBufferChunks: Uint8Array[] = [];
let earlyBufferBytes = 0;

const transportControlListeners = new Set<TransportControlCallback>();

function resetEarlyBuffer(): void {
  earlyBufferSessionId = null;
  earlyBufferChunks = [];
  earlyBufferBytes = 0;
}

function flushEarlyBufferToPort(sessionId: string, port: MessagePort): void {
  if (earlyBufferSessionId !== sessionId || earlyBufferChunks.length === 0) {
    resetEarlyBuffer();
    return;
  }
  const toFlush = earlyBufferChunks;
  resetEarlyBuffer();
  for (const chunk of toFlush) {
    try {
      port.postMessage({ type: 'chunk', sessionId, payload: chunk });
    } catch {
      // Stop flushing if port already closed
      break;
    }
  }
}

ipcRenderer.on('capture:transport-port', (event, payload: { sessionId?: string }) => {
  if (activeTransportPort) {
    try {
      activeTransportPort.close();
    } catch {
      // ignore
    }
    activeTransportPort = null;
    activeTransportSessionId = null;
  }

  const port = event.ports?.[0] ?? null;
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
  if (!port || !sessionId) return;

  activeTransportPort = port;
  activeTransportSessionId = sessionId;

  port.onmessage = (msgEvent: MessageEvent) => {
    const data = msgEvent.data as {
      type?: string;
      active?: boolean;
      queuedBytes?: number;
      queuedChunks?: number;
    };
    if (data && data.type === 'backpressure') {
      const normalized = {
        type: 'backpressure' as const,
        active: Boolean(data.active),
        queuedBytes: Number(data.queuedBytes ?? 0),
        queuedChunks: Number(data.queuedChunks ?? 0),
      };
      for (const listener of transportControlListeners) {
        listener(normalized);
      }
    }
  };
  port.start();

  // Send explicit readiness acknowledgement to Main Process BEFORE flushing early chunks
  try {
    port.postMessage({ type: 'port-ready', sessionId });
  } catch {
    // ignore
  }

  // Flush any buffered early chunks (preserves chunk #0 WebM EBML header in strict order)
  flushEarlyBufferToPort(sessionId, port);

  // Notify renderer listeners that transport port is attached and ready
  for (const listener of transportControlListeners) {
    listener({ type: 'port-ready', sessionId });
  }
});

contextBridge.exposeInMainWorld('fc26Desktop', {
  getBackendConnection: () => ipcRenderer.invoke('desktop:get-backend-connection'),
  getCapabilities: () => ipcRenderer.invoke('desktop:get-capabilities'),
  listCaptureSources: () => ipcRenderer.invoke('capture:list-sources'),
  selectCaptureSource: (payload: {
    sourceId: string;
    sourceName: string;
    sourceType: 'window' | 'screen';
    audioRequested: boolean;
  }) => ipcRenderer.invoke('capture:select-source', payload),
  startRecordingSession: (req: unknown) => ipcRenderer.invoke('capture:start-session', req),
  pauseRecordingSession: (sessionId: string) =>
    ipcRenderer.invoke('capture:pause-session', sessionId),
  resumeRecordingSession: (payload: { sessionId: string; inputMimeType?: string }) =>
    ipcRenderer.invoke('capture:resume-session', payload),
  stopRecordingSession: (payload: { sessionId?: string; reason?: string }) =>
    ipcRenderer.invoke('capture:stop-session', payload),
  reportStreamInterrupted: (payload: { sessionId: string; reason: string }) =>
    ipcRenderer.invoke('capture:report-stream-interrupted', payload),
  reportRendererDiagnostics: (payload: { sessionId: string; renderer: Record<string, unknown> }) =>
    ipcRenderer.invoke('capture:report-renderer-diagnostics', payload),
  reportWatchdogFailure: (payload: { sessionId: string; reason: string; kind: 'startup' | 'stall' }) =>
    ipcRenderer.invoke('capture:report-watchdog-failure', payload),
  discardRecordingSession: (payload: { sessionId: string; matchId?: string }) =>
    ipcRenderer.invoke('capture:discard-session', payload),
  getRecordingStatus: () => ipcRenderer.invoke('capture:get-status'),
  getDiskSpace: (targetDir: string) => ipcRenderer.invoke('capture:disk-space', targetDir),
  getRecoverableSessions: () => ipcRenderer.invoke('capture:get-recoverable-sessions'),
  recoverSession: (sessionId: string) => ipcRenderer.invoke('capture:recover-session', sessionId),
  openRecordingSegment: (filePath: string) => ipcRenderer.invoke('capture:open-segment', filePath),
  openSessionFolder: (folderPath: string) =>
    ipcRenderer.invoke('capture:open-session-folder', folderPath),
  openTrustedFolder: (payload: {
    kind:
      | 'storage_root'
      | 'legacy_recordings_root'
      | 'career_root'
      | 'match_root'
      | 'first_half'
      | 'second_half'
      | 'session_dir'
      | 'evidence_frames'
      | 'ai_analysis'
      | 'diagnostics';
    matchId?: string;
    sessionId?: string;
  }) => ipcRenderer.invoke('capture:open-trusted-folder', payload),
  openDiagnosticsFolder: (sessionId?: string, matchId?: string) =>
    ipcRenderer.invoke('capture:open-diagnostics-folder', { sessionId, matchId }),
  exportSessionDiagnostics: (sessionId?: string, matchId?: string) =>
    ipcRenderer.invoke('capture:export-diagnostics', { sessionId, matchId }),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),

  isTransportPortReady: (sessionId: string): boolean => {
    return Boolean(activeTransportPort && activeTransportSessionId === sessionId);
  },

  /**
   * Transmits raw MediaRecorder WebM binary chunks over the dedicated MessagePort.
   * Converts input into a clean preload-owned Uint8Array so contextIsolation / contextBridge
   * never triggers a DataCloneError on transfer lists, and buffers early chunks safely if the
   * port transfer event is still in flight.
   */
  sendRecordingChunk: (
    sessionId: string,
    chunk: ArrayBuffer | Uint8Array
  ): RecordingChunkSendResult => {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, buffered: false, bytes: 0, error: 'Missing recording sessionId.' };
    }

    let bytesView: Uint8Array;
    try {
      if (chunk instanceof Uint8Array) {
        bytesView = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
      } else if (chunk instanceof ArrayBuffer) {
        bytesView = new Uint8Array(chunk).slice();
      } else if (ArrayBuffer.isView(chunk)) {
        const view = chunk as ArrayBufferView;
        bytesView = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
      } else {
        return {
          ok: false,
          buffered: false,
          bytes: 0,
          error: `Unsupported binary chunk type: ${Object.prototype.toString.call(chunk)}`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        buffered: false,
        bytes: 0,
        error: `Failed to copy binary chunk across preload boundary: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (bytesView.byteLength === 0) {
      return { ok: false, buffered: false, bytes: 0, error: 'Empty binary chunk ignored.' };
    }

    // If port is not attached yet for this session, buffer early chunks safely instead of dropping EBML header
    if (!activeTransportPort || activeTransportSessionId !== sessionId) {
      if (earlyBufferSessionId !== sessionId) {
        earlyBufferSessionId = sessionId;
        earlyBufferChunks = [];
        earlyBufferBytes = 0;
      }
      if (earlyBufferBytes + bytesView.byteLength > MAX_EARLY_BUFFER_BYTES) {
        return {
          ok: false,
          buffered: false,
          bytes: bytesView.byteLength,
          error: 'Transport port was not ready and early chunk buffer reached 12 MB limit.',
        };
      }
      earlyBufferChunks.push(bytesView);
      earlyBufferBytes += bytesView.byteLength;
      return { ok: true, buffered: true, bytes: bytesView.byteLength };
    }

    try {
      // Structured-clone Uint8Array wrapped with sessionId (immune to contextBridge transfer-list DataCloneError)
      activeTransportPort.postMessage({ type: 'chunk', sessionId, payload: bytesView });
      return { ok: true, buffered: false, bytes: bytesView.byteLength };
    } catch (err) {
      return {
        ok: false,
        buffered: false,
        bytes: bytesView.byteLength,
        error: `MessagePort.postMessage failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  endRecordingTransport: (sessionId: string): boolean => {
    if (activeTransportPort && activeTransportSessionId === sessionId) {
      flushEarlyBufferToPort(sessionId, activeTransportPort);
      try {
        activeTransportPort.postMessage({ type: 'eos', sessionId });
        return true;
      } catch {
        return false;
      }
    }
    resetEarlyBuffer();
    return false;
  },

  onTransportControl: (callback: TransportControlCallback) => {
    transportControlListeners.add(callback);
    return () => {
      transportControlListeners.delete(callback);
    };
  },

  onRecordingTelemetry: (callback: TelemetryCallback) => {
    const handler = (_event: Electron.IpcRendererEvent, telemetry: unknown) => {
      callback(telemetry);
    };
    ipcRenderer.on('capture:telemetry', handler);
    return () => {
      ipcRenderer.removeListener('capture:telemetry', handler);
    };
  },
});
