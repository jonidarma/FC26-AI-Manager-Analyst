/**
 * FC26 AI Manager — Electron Main Process (Phase 2 Native Capture & Hardened Desktop Lifecycle)
 *
 * Security & Lifecycle Guarantees:
 * - Uses app.isPackaged to distinguish packaged production vs local development
 * - Starts and monitors the local Express backend on 127.0.0.1 only (never 0.0.0.0)
 * - Generates a fresh 256-bit per-session Bearer API token shared exclusively with renderer via preload IPC
 * - Stores SQLite database & recordings inside persistent Electron app.getPath('userData')
 * - Authorizes display media strictly via setDisplayMediaRequestHandler() with origin & source validation
 * - Streams MediaRecorder WebM chunks over binary MessageChannelMain MessagePorts (zero Base64)
 * - Pipes binary chunks into managed FFmpeg H.264 fragmented MP4 segmenter with bounded backpressure
 * - Syncs recording sessions & segments to SQLite exclusively through authenticated local Express HTTP API
 * - Reports localFfmpegRecording: true ONLY when all 8 runtime prerequisites pass verification
 * - Enforces contextIsolation: true, nodeIntegration: false, sandbox: true, strict CSP
 */
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  MessageChannelMain,
  type MessagePortMain,
  safeStorage,
  session,
  shell,
} from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { CaptureSessionEngine } from './captureEngine';
import type {
  CaptureEngineCapabilities,
  CaptureManifest,
  CaptureManifestSegment,
  CaptureSourceInfo,
  RecordingHalf,
  RecordingIntegrityStatus,
  RecordingTelemetry,
  StartRecordingSessionRequest,
} from './captureTypes';
import {
  attemptPartialSegmentRepair,
  computeFileSha256,
  FfmpegSegmentProcess,
  probeFfmpegCapabilities,
  probeMediaFile,
  type FfmpegBinaryResolution,
} from './ffmpegRecordingService';

const FC26_WINDOW_PATTERN = /ea\s*sports\s*fc\s*26|\bfc\s*26\b|\bfc26\b/i;
const APP_OWN_WINDOW_PATTERN = /fc26\s*ai\s*manager/i;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{4,96}$/;
const LOW_DISK_WARNING_BYTES = 500 * 1024 * 1024; // 500 MB
const CRITICAL_DISK_STOP_BYTES = 150 * 1024 * 1024; // 150 MB

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort = 0;
let backendBaseUrl = '';
let isQuitting = false;
let quitShutdownCompleted = false;
let ipcHandlersRegistered = false;
let transportReady = true;

let recordingsRootDirGlobal = '';
let captureEngine: CaptureSessionEngine | null = null;
let cachedProbe: {
  ready: boolean;
  binaries: FfmpegBinaryResolution;
  capabilities: CaptureEngineCapabilities;
} | null = null;

// Per-session 256-bit token held strictly in memory for renderer <-> local Express auth
const sessionApiToken = crypto.randomBytes(32).toString('hex');

// Authorized capture source selection (set explicitly by renderer before getDisplayMedia)
let authorizedSelection: {
  sourceId: string;
  sourceName: string;
  sourceType: 'window' | 'screen';
  audioRequested: boolean;
  selectedAtMs: number;
} | null = null;

interface ActiveRecordingState {
  sessionId: string;
  matchId: string;
  half: RecordingHalf;
  manifest: CaptureManifest;
  ffmpeg: FfmpegSegmentProcess | null;
  port: MessagePortMain | null;
  eosResolver: (() => void) | null;
  uiStatus: RecordingTelemetry['uiStatus'];
  ffmpegStatus: RecordingTelemetry['ffmpegStatus'];
  startedWallMs: number;
  activeSegmentStartMs: number | null;
  accumulatedActiveMs: number;
  currentFps: number | null;
  currentSegmentIndex: number;
  sourceAvailable: boolean;
  availableDiskBytes: number | null;
  diskLowWarning: boolean;
  maxRecordingWarning: boolean;
  lastWarning: string | null;
  lastError: string | null;
  autoStopTriggered: boolean;
  expectedFfmpegClose: boolean;
  segmentVerificationQueue: Promise<void>;
  monitorTimer: NodeJS.Timeout | null;
}

let activeRecording: ActiveRecordingState | null = null;

function buildIdleTelemetry(): RecordingTelemetry {
  return {
    uiStatus: 'idle',
    sessionId: null,
    matchId: null,
    half: null,
    sourceId: authorizedSelection?.sourceId ?? null,
    sourceName: authorizedSelection?.sourceName ?? null,
    sourceType: authorizedSelection?.sourceType ?? null,
    sourceAvailable: Boolean(authorizedSelection),
    sessionElapsedSeconds: 0,
    activeDurationSeconds: 0,
    currentFps: null,
    captureResolution: null,
    encoder: cachedProbe?.capabilities.preferredEncoder ?? null,
    currentSegmentIndex: 0,
    completedSegmentCount: 0,
    totalBytes: 0,
    availableDiskBytes: null,
    diskLowWarning: false,
    audioRequested: authorizedSelection?.audioRequested ?? false,
    audioActive: false,
    audioStatusLabel: 'Idle',
    ffmpegStatus: 'idle',
    ffmpegPid: null,
    queuedChunks: 0,
    queuedBytes: 0,
    backpressureActive: false,
    outputDirectory: null,
    integrityStatus: 'pending',
    maxRecordingWarning: false,
    lastWarning: null,
    lastError: null,
    segments: [],
  };
}

function getActiveDurationSeconds(state: ActiveRecordingState): number {
  const runningDeltaMs =
    state.uiStatus === 'recording' && state.activeSegmentStartMs !== null
      ? Math.max(0, Date.now() - state.activeSegmentStartMs)
      : 0;
  return Math.floor((state.accumulatedActiveMs + runningDeltaMs) / 1000);
}

function buildActiveTelemetry(state: ActiveRecordingState): RecordingTelemetry {
  const queueMetrics = state.ffmpeg?.getMetrics() ?? {
    queuedChunks: 0,
    queuedBytes: 0,
    backpressureActive: false,
    totalBytesWritten: 0,
    droppedChunks: 0,
  };
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - state.startedWallMs) / 1000));
  const activeSeconds = getActiveDurationSeconds(state);
  const completedCount = state.manifest.segments.filter(
    (s) => s.finalized || s.status === 'finalized' || s.status === 'recovered'
  ).length;

  let audioStatusLabel = 'Video-only (Audio Disabled)';
  if (state.manifest.audioRequested) {
    audioStatusLabel = state.manifest.audioActive
      ? 'System Loopback Active (Mic Disabled)'
      : 'Video-only Fallback (Loopback Unavailable)';
  }

  return {
    uiStatus: state.uiStatus,
    sessionId: state.sessionId,
    matchId: state.matchId,
    half: state.half,
    sourceId: state.manifest.sourceId,
    sourceName: state.manifest.sourceName,
    sourceType: state.manifest.sourceType,
    sourceAvailable: state.sourceAvailable,
    sessionElapsedSeconds: elapsedSeconds,
    activeDurationSeconds: activeSeconds,
    currentFps: state.currentFps,
    captureResolution: state.manifest.resolution,
    encoder: state.manifest.encoder,
    currentSegmentIndex: state.currentSegmentIndex,
    completedSegmentCount: completedCount,
    totalBytes: state.manifest.totalBytes,
    availableDiskBytes: state.availableDiskBytes,
    diskLowWarning: state.diskLowWarning,
    audioRequested: state.manifest.audioRequested,
    audioActive: state.manifest.audioActive,
    audioStatusLabel,
    ffmpegStatus: state.ffmpegStatus,
    ffmpegPid: state.ffmpeg?.pid ?? null,
    queuedChunks: queueMetrics.queuedChunks,
    queuedBytes: queueMetrics.queuedBytes,
    backpressureActive: queueMetrics.backpressureActive,
    outputDirectory: state.manifest.outputDirectory,
    integrityStatus: state.manifest.integrityStatus,
    maxRecordingWarning: state.maxRecordingWarning,
    lastWarning: state.lastWarning,
    lastError: state.lastError,
    segments: state.manifest.segments,
  };
}

function broadcastTelemetry(overrideTelemetry?: RecordingTelemetry): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload =
    overrideTelemetry ?? (activeRecording ? buildActiveTelemetry(activeRecording) : buildIdleTelemetry());
  mainWindow.webContents.send('capture:telemetry', payload);
}

function assertAuthorizedSender(sender: Electron.WebContents): void {
  if (!mainWindow || sender !== mainWindow.webContents) {
    throw new Error('Unauthorized IPC caller.');
  }
  const currentUrl = sender.getURL();
  if (backendBaseUrl && currentUrl && !currentUrl.startsWith(backendBaseUrl)) {
    throw new Error('Unauthorized renderer origin.');
  }
}

function validateSafeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value.trim())) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.trim();
}

function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Failed to allocate loopback port.'));
        return;
      }
      const allocatedPort = address.port;
      probe.close(() => resolve(allocatedPort));
    });
  });
}

function resolvePackagedPaths(): {
  serverScriptPath: string;
  staticDistDir: string;
  userDataDbDir: string;
  recordingsRootDir: string;
  referenceDataDir: string;
} {
  const appPath = app.getAppPath();
  const unpackedAppPath = app.isPackaged
    ? appPath.replace(/app\.asar$/i, 'app.asar.unpacked')
    : appPath;

  const candidateServerPaths = [
    path.join(unpackedAppPath, 'dist-server', 'server.mjs'),
    path.join(appPath, 'dist-server', 'server.mjs'),
  ];
  const serverScriptPath =
    candidateServerPaths.find((p) => fs.existsSync(p)) ?? candidateServerPaths[0];

  const candidateRefDataDirs = [
    path.join(unpackedAppPath, 'data', 'fc26'),
    path.join(appPath, 'data', 'fc26'),
  ];
  const referenceDataDir =
    candidateRefDataDirs.find((p) => fs.existsSync(p)) ?? candidateRefDataDirs[0];

  const staticDistDir = path.join(appPath, 'dist');
  const userDataRoot = app.getPath('userData');
  const userDataDbDir = path.join(userDataRoot, 'database');
  const recordingsRootDir = path.join(userDataRoot, 'recordings');

  fs.mkdirSync(userDataDbDir, { recursive: true });
  fs.mkdirSync(recordingsRootDir, { recursive: true });

  return { serverScriptPath, staticDistDir, userDataDbDir, recordingsRootDir, referenceDataDir };
}

/**
 * Authenticated loopback HTTP client for syncing capture state to SQLite exclusively through
 * the local Express backend (never opening a second SQLite handle in Electron Main).
 */
function localBackendRequest<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  apiPath: string,
  body?: unknown
): Promise<T | null> {
  if (!backendPort) return Promise.resolve(null);
  return new Promise((resolve) => {
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: backendPort,
        path: apiPath,
        method,
        timeout: 4000,
        headers: {
          Authorization: `Bearer ${sessionApiToken}`,
          'X-Requested-With': 'FC26-AI-Manager',
          Origin: backendBaseUrl,
          ...(serialized
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(serialized),
              }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(raw ? (JSON.parse(raw) as T) : null);
            } catch {
              resolve(null);
            }
          } else {
            console.warn(`[capture-sync] ${method} ${apiPath} failed (${res.statusCode}): ${raw}`);
            resolve(null);
          }
        });
      }
    );

    req.on('error', (err) => {
      console.warn(`[capture-sync] ${method} ${apiPath} network error: ${err.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    if (serialized) {
      req.write(serialized);
    }
    req.end();
  });
}

async function syncSessionToBackend(manifest: CaptureManifest): Promise<void> {
  await localBackendRequest('POST', '/api/recording-sessions', {
    id: manifest.sessionId,
    matchId: manifest.matchId,
    half: manifest.half,
    status: manifest.status,
    captureSourceId: manifest.sourceId,
    captureSourceName: manifest.sourceName,
    resolution: manifest.resolution,
    fps: manifest.fps,
    durationSeconds: manifest.activeDurationSeconds,
    totalBytes: manifest.totalBytes,
    encoder: manifest.encoder,
    audioEnabled: manifest.audioActive,
    outputDirectory: manifest.outputDirectory,
    integrityStatus: manifest.integrityStatus,
    recoveryNotes: manifest.recoveryLog.length > 0 ? manifest.recoveryLog.slice(-5).join('\n') : null,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
  });
}

async function syncSessionPatchToBackend(manifest: CaptureManifest): Promise<void> {
  await localBackendRequest('PATCH', `/api/recording-sessions/${encodeURIComponent(manifest.sessionId)}`, {
    status: manifest.status,
    durationSeconds: manifest.activeDurationSeconds,
    totalBytes: manifest.totalBytes,
    encoder: manifest.encoder,
    audioEnabled: manifest.audioActive,
    outputDirectory: manifest.outputDirectory,
    integrityStatus: manifest.integrityStatus,
    recoveryNotes: manifest.recoveryLog.length > 0 ? manifest.recoveryLog.slice(-5).join('\n') : null,
    endedAt: manifest.endedAt,
  });
}

async function syncSegmentToBackend(
  manifest: CaptureManifest,
  seg: CaptureManifestSegment
): Promise<void> {
  await localBackendRequest(
    'PUT',
    `/api/recording-sessions/${encodeURIComponent(manifest.sessionId)}/segments/${seg.index}`,
    {
      matchId: manifest.matchId,
      filePath: seg.filePath,
      durationSeconds: seg.durationSeconds,
      sizeBytes: seg.sizeBytes,
      checksum: seg.checksum,
      status: seg.status,
      resolution: seg.resolution,
      fps: seg.fps,
      codec: seg.codec,
      hasAudio: seg.hasAudio,
      integrityStatus: seg.integrityStatus,
      startedAt: seg.startedAt,
      endedAt: seg.endedAt,
    }
  );
}

async function refreshCapabilityProbe(): Promise<{
  ready: boolean;
  binaries: FfmpegBinaryResolution;
  capabilities: CaptureEngineCapabilities;
}> {
  const probe = await probeFfmpegCapabilities({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    recordingsRootDir: recordingsRootDirGlobal || path.join(app.getPath('userData'), 'recordings'),
    transportReady,
    ipcHandlersReady: ipcHandlersRegistered,
  });
  cachedProbe = probe;
  return probe;
}

async function listSortedCaptureSources(): Promise<CaptureSourceInfo[]> {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: false,
  });

  const mapped: CaptureSourceInfo[] = sources.map((src) => {
    const type: 'window' | 'screen' = src.id.startsWith('screen:') ? 'screen' : 'window';
    const isOwnWindow = APP_OWN_WINDOW_PATTERN.test(src.name);
    const isFc26Candidate = type === 'window' && !isOwnWindow && FC26_WINDOW_PATTERN.test(src.name);
    return {
      id: src.id,
      name: src.name,
      type,
      thumbnailDataUrl: src.thumbnail.toDataURL(),
      isFc26Candidate,
      available: true,
    };
  });

  // Sort FC 26 windows first, then other windows, then screens
  return mapped.sort((a, b) => {
    if (a.isFc26Candidate && !b.isFc26Candidate) return -1;
    if (!a.isFc26Candidate && b.isFc26Candidate) return 1;
    if (a.type !== b.type) return a.type === 'window' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function getAvailableDiskBytes(targetDir: string): number | null {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const stats = fs.statfsSync(targetDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function configureDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // Strictly verify the request originates from our own local Electron window & origin
      const frameUrl = request.frame?.url ?? '';
      if (!backendBaseUrl || !frameUrl.startsWith(backendBaseUrl)) {
        console.warn(`[capture] Denied getDisplayMedia from unauthorized origin: ${frameUrl}`);
        callback({});
        return;
      }

      if (!authorizedSelection) {
        console.warn('[capture] Denied getDisplayMedia: no source explicitly selected.');
        callback({});
        return;
      }

      // Re-enumerate fresh sources so we never grant a stale or spoofed source ID
      const liveSources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });

      const matched = liveSources.find((src) => src.id === authorizedSelection?.sourceId);
      if (!matched) {
        console.warn(
          `[capture] Selected source "${authorizedSelection.sourceName}" (${authorizedSelection.sourceId}) is no longer available.`
        );
        // Never silently switch to another window or screen
        callback({});
        return;
      }

      // Microphone is permanently prohibited. On Windows, grant system loopback ONLY if enabled.
      const allowLoopback =
        authorizedSelection.audioRequested && process.platform === 'win32';

      if (allowLoopback) {
        callback({ video: matched, audio: 'loopback' });
      } else {
        callback({ video: matched });
      }
    } catch (err) {
      console.error('[capture] DisplayMediaRequestHandler error:', err);
      callback({});
    }
  });
}

function detachTransportPort(state: ActiveRecordingState): void {
  if (state.port) {
    try {
      state.port.close();
    } catch {
      // ignore
    }
    state.port = null;
  }
}

function attachBinaryTransportPort(state: ActiveRecordingState): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is unavailable for binary media transport.');
  }
  detachTransportPort(state);

  const channel = new MessageChannelMain();
  const mainPort = channel.port1;
  const rendererPort = channel.port2;
  state.port = mainPort;

  let lastNotifiedBackpressure = false;

  mainPort.on('message', (event) => {
    const data = event.data as
      | { type?: 'chunk'; sessionId?: string; payload?: Uint8Array | ArrayBuffer }
      | { type?: 'eos'; sessionId?: string }
      | Uint8Array
      | ArrayBuffer;

    if (!activeRecording || activeRecording.sessionId !== state.sessionId) {
      return;
    }

    // Handle control EOS message
    if (data && typeof data === 'object' && 'type' in data && data.type === 'eos') {
      if (data.sessionId === state.sessionId && state.eosResolver) {
        const resolve = state.eosResolver;
        state.eosResolver = null;
        resolve();
      }
      return;
    }

    // Handle binary chunk (ArrayBuffer or Uint8Array or wrapped chunk)
    let chunkBuffer: Buffer | null = null;
    if (data instanceof Uint8Array) {
      chunkBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      chunkBuffer = Buffer.from(data);
    } else if (
      data &&
      typeof data === 'object' &&
      'type' in data &&
      data.type === 'chunk' &&
      data.sessionId === state.sessionId &&
      data.payload
    ) {
      if (data.payload instanceof Uint8Array) {
        chunkBuffer = Buffer.from(
          data.payload.buffer,
          data.payload.byteOffset,
          data.payload.byteLength
        );
      } else if (data.payload instanceof ArrayBuffer) {
        chunkBuffer = Buffer.from(data.payload);
      }
    }

    if (!chunkBuffer || chunkBuffer.byteLength === 0) return;
    if (state.uiStatus !== 'recording' && state.uiStatus !== 'finalizing' && state.uiStatus !== 'paused') {
      return;
    }

    if (state.ffmpeg) {
      const res = state.ffmpeg.enqueueChunk(chunkBuffer);
      if (res.backpressureActive !== lastNotifiedBackpressure) {
        lastNotifiedBackpressure = res.backpressureActive;
        const metrics = state.ffmpeg.getMetrics();
        try {
          mainPort.postMessage({
            type: 'backpressure',
            active: res.backpressureActive,
            queuedBytes: metrics.queuedBytes,
            queuedChunks: metrics.queuedChunks,
          });
        } catch {
          // ignore if port already closed
        }
      }
    }
  });

  mainPort.start();
  mainWindow.webContents.postMessage(
    'capture:transport-port',
    { sessionId: state.sessionId },
    [rendererPort]
  );
}

function waitForRendererEos(state: ActiveRecordingState, timeoutMs = 2500): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (state.eosResolver === done) {
        state.eosResolver = null;
      }
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    state.eosResolver = done;
  });
}

async function verifyAndRecordSegment(
  state: ActiveRecordingState,
  segmentFileName: string,
  segmentFilePath: string,
  segmentIndex: number
): Promise<void> {
  if (!captureEngine || !cachedProbe) return;
  const probe = await probeMediaFile(cachedProbe.binaries.ffprobePath, segmentFilePath);

  let finalProbe = probe;
  let status: CaptureManifestSegment['status'] = 'finalized';
  let integrityStatus: RecordingIntegrityStatus = 'verified';

  if (!probe.valid) {
    const repair = await attemptPartialSegmentRepair(
      cachedProbe.binaries.ffmpegPath,
      cachedProbe.binaries.ffprobePath,
      segmentFilePath
    );
    if (repair.repaired && repair.probe.valid) {
      finalProbe = repair.probe;
      status = 'recovered';
      integrityStatus = 'verified';
    } else {
      status = 'corrupted';
      integrityStatus = 'corrupted';
    }
  }

  const checksum =
    finalProbe.valid && fs.existsSync(segmentFilePath)
      ? await computeFileSha256(segmentFilePath)
      : null;

  const now = new Date().toISOString();
  const segmentRecord: CaptureManifestSegment = {
    index: segmentIndex,
    fileName: segmentFileName,
    filePath: segmentFilePath,
    startedAt: state.manifest.startedAt,
    endedAt: now,
    durationSeconds: finalProbe.durationSeconds,
    sizeBytes: finalProbe.sizeBytes,
    checksum,
    resolution: finalProbe.resolution ?? state.manifest.resolution,
    fps: finalProbe.fps ?? state.manifest.fps,
    codec: finalProbe.videoCodec ?? state.manifest.encoder,
    hasAudio: finalProbe.hasAudio,
    finalized: status === 'finalized' || status === 'recovered',
    status,
    integrityStatus,
  };

  state.manifest = captureEngine.upsertSegment(
    state.sessionId,
    segmentRecord,
    state.matchId
  );
  state.manifest.activeDurationSeconds = getActiveDurationSeconds(state);

  await syncSegmentToBackend(state.manifest, segmentRecord);
  await syncSessionPatchToBackend(state.manifest);
  broadcastTelemetry();
}

function spawnFfmpegForActiveSession(
  state: ActiveRecordingState,
  inputFormat: 'webm' | 'matroska'
): void {
  if (!captureEngine || !cachedProbe?.binaries.ffmpegPath || !cachedProbe.capabilities.preferredEncoder) {
    throw new Error('FFmpeg runtime prerequisites are not satisfied.');
  }

  const encoder = cachedProbe.capabilities.preferredEncoder as 'libx264' | 'h264_mf';
  const startIdx = state.manifest.nextSegmentIndex;
  const segmentListPath = captureEngine.getSegmentListPath(state.matchId, state.sessionId);

  state.currentSegmentIndex = startIdx;
  state.expectedFfmpegClose = false;
  state.ffmpegStatus = 'starting';

  const proc = new FfmpegSegmentProcess(
    {
      ffmpegPath: cachedProbe.binaries.ffmpegPath,
      encoder,
      inputFormat,
      resolution: state.manifest.resolution as '1280x720' | '1920x1080',
      fps: state.manifest.fps,
      bitrateKbps: state.manifest.bitrateKbps,
      audioEnabled: state.manifest.audioActive && cachedProbe.capabilities.aacAudioAvailable,
      segmentDurationSeconds: state.manifest.segmentDurationMinutes * 60,
      startSegmentIndex: startIdx,
      outputDirectory: state.manifest.outputDirectory,
      segmentListPath,
    },
    {
      onSegmentFinalized: (fileName, filePath, segIndex) => {
        state.segmentVerificationQueue = state.segmentVerificationQueue.then(() =>
          verifyAndRecordSegment(state, fileName, filePath, segIndex)
        );
      },
      onActiveSegmentChanged: (segIndex) => {
        state.currentSegmentIndex = segIndex;
        broadcastTelemetry();
      },
      onProgress: (progress) => {
        if (state.ffmpegStatus === 'starting') {
          state.ffmpegStatus = 'running';
        }
        if (progress.fps !== null) {
          state.currentFps = progress.fps;
        }
      },
      onQueueChange: () => {
        // Reflected in periodic telemetry broadcast
      },
      onError: (msg) => {
        state.lastWarning = msg;
        broadcastTelemetry();
      },
      onExit: (code, signal, stderrTail) => {
        if (!state.expectedFfmpegClose && state.uiStatus === 'recording') {
          state.ffmpegStatus = 'error';
          state.uiStatus = 'interrupted';
          state.lastError = `FFmpeg exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}). ${stderrTail}`;
          broadcastTelemetry();
        } else if (state.uiStatus === 'paused') {
          state.ffmpegStatus = 'paused';
        } else {
          state.ffmpegStatus = 'stopped';
        }
      },
    }
  );

  proc.start();
  state.ffmpeg = proc;
  state.ffmpegStatus = 'running';
}

function startActiveSessionMonitor(state: ActiveRecordingState): void {
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  let tickCount = 0;

  state.monitorTimer = setInterval(async () => {
    if (!activeRecording || activeRecording.sessionId !== state.sessionId) {
      return;
    }
    tickCount += 1;

    // Every 5 seconds: verify disk space and maxRecordingMinutes safeguard
    if (tickCount % 5 === 0) {
      const avail = getAvailableDiskBytes(state.manifest.outputDirectory);
      state.availableDiskBytes = avail;
      state.diskLowWarning = avail !== null && avail < LOW_DISK_WARNING_BYTES;

      if (avail !== null && avail < CRITICAL_DISK_STOP_BYTES && !state.autoStopTriggered) {
        state.autoStopTriggered = true;
        state.lastError =
          'Available disk space dropped below 150 MB. Automatically finalizing recording safely.';
        void finalizeActiveSession('Critical low disk space safeguard triggered.');
        return;
      }

      const activeSecs = getActiveDurationSeconds(state);
      const maxSecs = state.manifest.maxRecordingMinutes * 60;
      state.maxRecordingWarning = activeSecs >= Math.max(60, maxSecs - 300);

      if (activeSecs >= maxSecs && !state.autoStopTriggered) {
        state.autoStopTriggered = true;
        state.lastWarning = `Maximum recording duration (${state.manifest.maxRecordingMinutes} min) reached. Finalizing recording safely.`;
        void finalizeActiveSession('Max recording duration limit reached.');
        return;
      }
    }

    broadcastTelemetry();
  }, 1000);
  state.monitorTimer.unref();
}

function stopActiveSessionMonitor(state: ActiveRecordingState): void {
  if (state.monitorTimer) {
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
  }
}

async function verifyAnyUnregisteredDiskSegments(state: ActiveRecordingState): Promise<void> {
  if (!captureEngine) return;
  const onDisk = captureEngine.discoverSegmentFilesOnDisk(state.manifest.outputDirectory);
  const alreadyFinalized = new Set(
    state.manifest.segments.filter((s) => s.finalized).map((s) => s.index)
  );
  for (const seg of onDisk) {
    if (!alreadyFinalized.has(seg.index)) {
      await verifyAndRecordSegment(state, seg.fileName, seg.filePath, seg.index);
    }
  }
}

async function finalizeActiveSession(
  reason?: string,
  gracefulTimeoutMs = 10000
): Promise<CaptureManifest | null> {
  if (!activeRecording || !captureEngine) {
    return null;
  }

  const state = activeRecording;
  if (state.uiStatus === 'finalizing' || state.uiStatus === 'completed') {
    return state.manifest;
  }

  if (state.uiStatus === 'recording' && state.activeSegmentStartMs !== null) {
    state.accumulatedActiveMs += Math.max(0, Date.now() - state.activeSegmentStartMs);
    state.activeSegmentStartMs = null;
  }

  state.uiStatus = 'finalizing';
  state.ffmpegStatus = 'finalizing';
  if (reason) state.lastWarning = reason;
  stopActiveSessionMonitor(state);
  broadcastTelemetry();

  // Wait briefly for renderer's final MediaRecorder flush EOS
  if (state.port) {
    await waitForRendererEos(state, Math.min(2500, gracefulTimeoutMs));
  }

  if (state.ffmpeg) {
    state.expectedFfmpegClose = true;
    await state.ffmpeg.stopGracefully(gracefulTimeoutMs);
    state.ffmpeg = null;
  }

  detachTransportPort(state);
  await state.segmentVerificationQueue;
  await verifyAnyUnregisteredDiskSegments(state);

  const activeSeconds = Math.max(
    Math.floor(state.accumulatedActiveMs / 1000),
    Math.round(state.manifest.segments.reduce((sum, s) => sum + s.durationSeconds, 0))
  );

  const finalized = captureEngine.finalizeSessionManifest(state.sessionId, {
    activeDurationSeconds: activeSeconds,
    matchId: state.matchId,
  });

  if (finalized) {
    state.manifest = finalized;
    state.uiStatus = 'completed';
    state.ffmpegStatus = 'stopped';
    await syncSessionPatchToBackend(finalized);
    const completedSnapshot = buildActiveTelemetry(state);
    activeRecording = null;
    broadcastTelemetry(completedSnapshot);
    return finalized;
  }

  activeRecording = null;
  broadcastTelemetry();
  return null;
}

function checkHealthOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/health',
        timeout: 1500,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          try {
            const parsed = JSON.parse(body) as { ok?: boolean };
            resolve(parsed.ok === true);
          } catch {
            resolve(false);
          }
        });
      }
    );

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForBackendReady(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backendProcess && backendProcess.exitCode !== null) {
      throw new Error(`Local backend exited prematurely with code ${backendProcess.exitCode}.`);
    }
    const healthy = await checkHealthOnce(port);
    if (healthy) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timed out waiting for local Express backend health check.');
}

async function startLocalBackend(): Promise<void> {
  const { serverScriptPath, staticDistDir, userDataDbDir, recordingsRootDir, referenceDataDir } =
    resolvePackagedPaths();

  recordingsRootDirGlobal = recordingsRootDir;
  captureEngine = new CaptureSessionEngine(recordingsRootDir);

  if (!fs.existsSync(serverScriptPath)) {
    throw new Error(
      `Packaged backend bundle missing at ${serverScriptPath}. Run "npm run build:desktop" before launching Electron.`
    );
  }
  if (!fs.existsSync(path.join(staticDistDir, 'index.html'))) {
    throw new Error(
      `Built React frontend missing at ${staticDistDir}. Run "npm run build:desktop" before launching Electron.`
    );
  }

  backendPort = await findFreeLoopbackPort();
  backendBaseUrl = `http://127.0.0.1:${backendPort}`;

  const child = spawn(process.execPath, [serverScriptPath], {
    cwd: app.isPackaged ? path.dirname(serverScriptPath) : app.getAppPath(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      FC26_DESKTOP_MODE: '1',
      FC26_HOST: '127.0.0.1',
      FC26_PORT: String(backendPort),
      FC26_USER_DATA_DIR: userDataDbDir,
      FC26_STATIC_DIR: staticDistDir,
      FC26_REFERENCE_DATA_DIR: referenceDataDir,
      FC26_API_TOKEN: sessionApiToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess = child;

  child.stdout?.on('data', (chunk: Buffer) => {
    console.log(`[backend] ${chunk.toString().trim()}`);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[backend:err] ${chunk.toString().trim()}`);
  });

  child.on('exit', (code, signal) => {
    backendProcess = null;
    if (!isQuitting) {
      console.error(`Local backend stopped unexpectedly (code=${code}, signal=${signal}).`);
      dialog.showErrorBox(
        'FC26 AI Manager — Backend Stopped',
        `The local database backend stopped unexpectedly (exit code ${code ?? 'unknown'}). Please restart FC26 AI Manager.`
      );
      app.quit();
    }
  });

  await waitForBackendReady(backendPort);
  configureDisplayMediaHandler();
  await refreshCapabilityProbe();
}

function stopLocalBackend(): void {
  if (!backendProcess || backendProcess.killed) return;
  const proc = backendProcess;
  backendProcess = null;
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, 3000).unref();
  } catch {
    // ignore termination errors on exit
  }
}

function createMainWindow(): void {
  const preloadPath = path.join(__dirname, 'preload.cjs');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: '#0B0D10',
    title: 'FC26 AI Manager — Football Tactical Intelligence System',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Strict CSP scoped strictly to this session's 127.0.0.1 backend origin (media-src blob: allowed for local preview)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ${backendBaseUrl};`,
        ],
      },
    });
  });

  void mainWindow.loadURL(backendBaseUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-backend-connection', async (event) => {
    assertAuthorizedSender(event.sender);
    return {
      baseUrl: backendBaseUrl,
      apiToken: sessionApiToken,
    };
  });

  ipcMain.handle('desktop:get-capabilities', async (event) => {
    assertAuthorizedSender(event.sender);
    const probe = await refreshCapabilityProbe();

    const notice = probe.ready
      ? `Native Electron desktop capture engine ready (${probe.capabilities.preferredEncoder}, ${probe.capabilities.ffmpegPathSource}). Local H.264 MP4 segmented recording active.`
      : `Native Electron runtime active, but local FFmpeg recording is blocked: ${probe.capabilities.blockingReason ?? 'runtime prerequisite failed.'}`;

    return {
      environment: 'electron-native',
      nativeWindowCapture: true,
      localFfmpegRecording: probe.ready,
      nativeDiskInspection: true,
      safeStorageAvailable: safeStorage.isEncryptionAvailable(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      notice,
      captureDiagnostics: probe.capabilities,
    };
  });

  ipcMain.handle('capture:list-sources', async (event) => {
    assertAuthorizedSender(event.sender);
    return listSortedCaptureSources();
  });

  ipcMain.handle(
    'capture:select-source',
    async (
      event,
      payload: {
        sourceId: string;
        sourceName: string;
        sourceType: 'window' | 'screen';
        audioRequested: boolean;
      }
    ) => {
      assertAuthorizedSender(event.sender);
      if (!payload || typeof payload.sourceId !== 'string' || !payload.sourceId.trim()) {
        throw new Error('Invalid capture source selection.');
      }

      const liveSources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });
      const matched = liveSources.find((s) => s.id === payload.sourceId);
      if (!matched) {
        authorizedSelection = null;
        return {
          authorized: false,
          reason: 'Selected capture source is no longer available. Refresh sources and try again.',
        };
      }

      authorizedSelection = {
        sourceId: matched.id,
        sourceName: matched.name,
        sourceType: matched.id.startsWith('screen:') ? 'screen' : 'window',
        audioRequested: Boolean(payload.audioRequested),
        selectedAtMs: Date.now(),
      };

      return {
        authorized: true,
        sourceId: matched.id,
        sourceName: matched.name,
        sourceType: authorizedSelection.sourceType,
      };
    }
  );

  ipcMain.handle(
    'capture:start-session',
    async (event, req: StartRecordingSessionRequest) => {
      assertAuthorizedSender(event.sender);
      if (!captureEngine) {
        throw new Error('Capture engine has not been initialized.');
      }
      if (activeRecording) {
        throw new Error(
          `A recording session (${activeRecording.sessionId}) is already active. Finalize or discard it before starting another.`
        );
      }

      const probe = await refreshCapabilityProbe();
      if (!probe.ready || !probe.capabilities.preferredEncoder) {
        throw new Error(
          `Local FFmpeg recording is unavailable: ${probe.capabilities.blockingReason ?? 'missing prerequisite'}`
        );
      }

      const matchId = validateSafeId(req.matchId, 'matchId');
      const half: RecordingHalf = req.half === 'second_half' ? 'second_half' : 'first_half';
      const resolution = req.resolution === '1920x1080' ? '1920x1080' : '1280x720';
      const fps = req.fps === 20 ? 20 : 30;
      const bitrateKbps = Math.max(1500, Math.min(8000, Math.round(Number(req.bitrateKbps) || 3500)));
      const segmentDurationMinutes = Math.max(
        2,
        Math.min(5, Math.round(Number(req.segmentDurationMinutes) || 3))
      );
      const maxRecordingMinutes = Math.max(
        5,
        Math.min(180, Math.round(Number(req.maxRecordingMinutes) || 90))
      );

      if (!authorizedSelection || authorizedSelection.sourceId !== req.sourceId) {
        throw new Error('Capture source must be explicitly selected and verified before recording.');
      }

      const availBytes = getAvailableDiskBytes(recordingsRootDirGlobal);
      if (availBytes !== null && availBytes < CRITICAL_DISK_STOP_BYTES) {
        throw new Error(
          'Insufficient disk space (< 150 MB free) to start recording. Free local disk space first.'
        );
      }

      const manifest = captureEngine.createSessionManifest({
        matchId,
        half,
        sourceId: authorizedSelection.sourceId,
        sourceName: authorizedSelection.sourceName,
        sourceType: authorizedSelection.sourceType,
        resolution,
        fps,
        bitrateKbps,
        encoder: probe.capabilities.preferredEncoder,
        audioRequested: Boolean(req.audioRequested),
        audioActive: Boolean(req.audioActive && probe.capabilities.aacAudioAvailable),
        segmentDurationMinutes,
        maxRecordingMinutes,
      });

      const state: ActiveRecordingState = {
        sessionId: manifest.sessionId,
        matchId,
        half,
        manifest,
        ffmpeg: null,
        port: null,
        eosResolver: null,
        uiStatus: 'recording',
        ffmpegStatus: 'starting',
        startedWallMs: Date.now(),
        activeSegmentStartMs: Date.now(),
        accumulatedActiveMs: 0,
        currentFps: null,
        currentSegmentIndex: 1,
        sourceAvailable: true,
        availableDiskBytes: availBytes,
        diskLowWarning: availBytes !== null && availBytes < LOW_DISK_WARNING_BYTES,
        maxRecordingWarning: false,
        lastWarning: null,
        lastError: null,
        autoStopTriggered: false,
        expectedFfmpegClose: false,
        segmentVerificationQueue: Promise.resolve(),
        monitorTimer: null,
      };

      activeRecording = state;

      try {
        const inputFormat: 'webm' | 'matroska' =
          req.inputMimeType && req.inputMimeType.toLowerCase().includes('matroska')
            ? 'matroska'
            : 'webm';
        spawnFfmpegForActiveSession(state, inputFormat);
        attachBinaryTransportPort(state);
        startActiveSessionMonitor(state);
        await syncSessionToBackend(manifest);
        broadcastTelemetry();
        return {
          sessionId: manifest.sessionId,
          manifest,
          telemetry: buildActiveTelemetry(state),
        };
      } catch (err) {
        stopActiveSessionMonitor(state);
        detachTransportPort(state);
        if (state.ffmpeg) {
          state.expectedFfmpegClose = true;
          await state.ffmpeg.stopGracefully(3000);
        }
        activeRecording = null;
        broadcastTelemetry();
        throw err;
      }
    }
  );

  ipcMain.handle('capture:pause-session', async (event, sessionId: string) => {
    assertAuthorizedSender(event.sender);
    const safeSessionId = validateSafeId(sessionId, 'sessionId');
    if (!activeRecording || activeRecording.sessionId !== safeSessionId || !captureEngine) {
      throw new Error('No matching active recording session to pause.');
    }
    if (activeRecording.uiStatus !== 'recording') {
      throw new Error(`Cannot pause recording while in "${activeRecording.uiStatus}" state.`);
    }

    const state = activeRecording;
    if (state.activeSegmentStartMs !== null) {
      state.accumulatedActiveMs += Math.max(0, Date.now() - state.activeSegmentStartMs);
      state.activeSegmentStartMs = null;
    }

    state.uiStatus = 'paused';
    broadcastTelemetry();

    // Flush final MediaRecorder chunk before closing active FFmpeg segment cleanly
    if (state.port) {
      await waitForRendererEos(state, 2500);
    }

    if (state.ffmpeg) {
      state.expectedFfmpegClose = true;
      await state.ffmpeg.stopGracefully(6000);
      state.ffmpeg = null;
    }
    detachTransportPort(state);
    state.ffmpegStatus = 'paused';

    await state.segmentVerificationQueue;
    await verifyAnyUnregisteredDiskSegments(state);

    state.manifest = captureEngine.updateSessionStatus(
      state.sessionId,
      'paused',
      {
        activeDurationSeconds: getActiveDurationSeconds(state),
        nextSegmentIndex:
          state.manifest.segments.reduce((max, s) => Math.max(max, s.index), 0) + 1,
      },
      state.matchId
    );
    await syncSessionPatchToBackend(state.manifest);
    broadcastTelemetry();
    return buildActiveTelemetry(state);
  });

  ipcMain.handle(
    'capture:resume-session',
    async (event, payload: { sessionId: string; inputMimeType?: string }) => {
      assertAuthorizedSender(event.sender);
      const safeSessionId = validateSafeId(payload?.sessionId, 'sessionId');
      if (!activeRecording || activeRecording.sessionId !== safeSessionId || !captureEngine) {
        throw new Error('No matching paused recording session to resume.');
      }
      if (activeRecording.uiStatus !== 'paused') {
        throw new Error(`Cannot resume recording while in "${activeRecording.uiStatus}" state.`);
      }

      const state = activeRecording;
      const inputFormat: 'webm' | 'matroska' =
        payload.inputMimeType && payload.inputMimeType.toLowerCase().includes('matroska')
          ? 'matroska'
          : 'webm';

      state.manifest = captureEngine.updateSessionStatus(
        state.sessionId,
        'recording',
        { activeDurationSeconds: getActiveDurationSeconds(state) },
        state.matchId
      );
      state.uiStatus = 'recording';
      state.activeSegmentStartMs = Date.now();
      spawnFfmpegForActiveSession(state, inputFormat);
      attachBinaryTransportPort(state);
      await syncSessionPatchToBackend(state.manifest);
      broadcastTelemetry();
      return buildActiveTelemetry(state);
    }
  );

  ipcMain.handle(
    'capture:stop-session',
    async (event, payload: { sessionId?: string; reason?: string }) => {
      assertAuthorizedSender(event.sender);
      if (!activeRecording) {
        return { stopped: false, manifest: null, telemetry: buildIdleTelemetry() };
      }
      if (payload?.sessionId && payload.sessionId !== activeRecording.sessionId) {
        throw new Error('Requested sessionId does not match the active recording session.');
      }
      const manifest = await finalizeActiveSession(payload?.reason);
      return {
        stopped: true,
        manifest,
        telemetry: buildIdleTelemetry(),
      };
    }
  );

  ipcMain.handle(
    'capture:report-stream-interrupted',
    async (event, payload: { sessionId: string; reason: string }) => {
      assertAuthorizedSender(event.sender);
      if (!activeRecording || activeRecording.sessionId !== payload?.sessionId) {
        return buildIdleTelemetry();
      }
      activeRecording.sourceAvailable = false;
      activeRecording.lastError = payload.reason || 'Capture stream ended unexpectedly.';
      const manifest = await finalizeActiveSession(
        `Capture interrupted: ${activeRecording.lastError}`,
        5000
      );
      return {
        interrupted: true,
        manifest,
        telemetry: buildIdleTelemetry(),
      };
    }
  );

  ipcMain.handle(
    'capture:discard-session',
    async (event, payload: { sessionId: string; matchId?: string }) => {
      assertAuthorizedSender(event.sender);
      if (!captureEngine) throw new Error('Capture engine unavailable.');
      const safeSessionId = validateSafeId(payload?.sessionId, 'sessionId');

      if (activeRecording && activeRecording.sessionId === safeSessionId) {
        const state = activeRecording;
        stopActiveSessionMonitor(state);
        if (state.ffmpeg) {
          state.expectedFfmpegClose = true;
          await state.ffmpeg.stopGracefully(4000);
          state.ffmpeg = null;
        }
        detachTransportPort(state);
        activeRecording = null;
      }

      const result = captureEngine.discardSession(safeSessionId, payload?.matchId);
      if (result.manifest) {
        await syncSessionPatchToBackend(result.manifest);
      }
      broadcastTelemetry();
      return {
        discarded: result.discarded,
        removedFiles: result.removedFiles,
      };
    }
  );

  ipcMain.handle('capture:get-status', async (event) => {
    assertAuthorizedSender(event.sender);
    return activeRecording ? buildActiveTelemetry(activeRecording) : buildIdleTelemetry();
  });

  ipcMain.handle('capture:disk-space', async (event, targetSubdir: string) => {
    assertAuthorizedSender(event.sender);
    const baseDir = path.resolve(app.getPath('userData'), 'recordings');
    const safeName = targetSubdir ? path.basename(targetSubdir).replace(/[^a-zA-Z0-9._-]/g, '') : '';
    const resolved = safeName ? path.resolve(baseDir, safeName) : baseDir;
    if (!resolved.startsWith(baseDir)) {
      throw new Error('Invalid storage inspection path.');
    }
    fs.mkdirSync(resolved, { recursive: true });
    const stats = fs.statfsSync(resolved);
    return {
      path: resolved,
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
      isEstimate: false,
    };
  });

  ipcMain.handle('capture:get-recoverable-sessions', async (event) => {
    assertAuthorizedSender(event.sender);
    return captureEngine
      ? captureEngine.scanRecoverableManifests(activeRecording?.sessionId ?? null)
      : [];
  });

  ipcMain.handle('capture:recover-session', async (event, sessionId: string) => {
    assertAuthorizedSender(event.sender);
    if (!captureEngine) throw new Error('Capture engine unavailable.');
    const safeSessionId = validateSafeId(sessionId, 'sessionId');
    if (activeRecording && activeRecording.sessionId === safeSessionId) {
      throw new Error('Cannot run crash recovery on the currently active recording session.');
    }

    const probe = cachedProbe ?? (await refreshCapabilityProbe());
    const result = await captureEngine.recoverSession(
      safeSessionId,
      probe.binaries.ffmpegPath,
      probe.binaries.ffprobePath
    );

    const updatedManifest = captureEngine.loadSessionManifest(safeSessionId, result.matchId);
    if (updatedManifest) {
      await syncSessionToBackend(updatedManifest);
      for (const seg of updatedManifest.segments) {
        await syncSegmentToBackend(updatedManifest, seg);
      }
    }

    return result;
  });

  ipcMain.handle('capture:open-segment', async (event, filePath: string) => {
    assertAuthorizedSender(event.sender);
    if (!captureEngine || typeof filePath !== 'string') {
      throw new Error('Invalid media segment path.');
    }
    const safePath = captureEngine.resolveSafeMediaPath(filePath, true);
    const errMsg = await shell.openPath(safePath);
    if (errMsg) {
      throw new Error(`Failed to open recording segment: ${errMsg}`);
    }
    return { opened: true, path: safePath };
  });

  ipcMain.handle('capture:open-session-folder', async (event, folderPath: string) => {
    assertAuthorizedSender(event.sender);
    if (!captureEngine || typeof folderPath !== 'string') {
      throw new Error('Invalid session folder path.');
    }
    const safeFolder = captureEngine.resolveSafeSessionFolder(folderPath);
    const errMsg = await shell.openPath(safeFolder);
    if (errMsg) {
      throw new Error(`Failed to open session folder: ${errMsg}`);
    }
    return { opened: true, path: safeFolder };
  });

  ipcMain.handle('window:minimize', (event) => {
    assertAuthorizedSender(event.sender);
    mainWindow?.minimize();
  });

  ipcHandlersRegistered = true;
}

app.whenReady().then(async () => {
  try {
    registerIpcHandlers();
    await startLocalBackend();
    createMainWindow();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Fatal Electron startup error:', message);
    dialog.showErrorBox('FC26 AI Manager — Startup Failed', message);
    isQuitting = true;
    stopLocalBackend();
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backendBaseUrl) {
      createMainWindow();
    }
  });
});

app.on('before-quit', (event) => {
  if (quitShutdownCompleted) {
    isQuitting = true;
    stopLocalBackend();
    return;
  }

  if (activeRecording) {
    event.preventDefault();
    isQuitting = true;
    void (async () => {
      try {
        await finalizeActiveSession('Application shutting down — saving recorded segments.', 4500);
      } catch (err) {
        console.error('[capture] Error during before-quit finalization:', err);
      } finally {
        quitShutdownCompleted = true;
        stopLocalBackend();
        app.quit();
      }
    })();
    return;
  }

  isQuitting = true;
  quitShutdownCompleted = true;
  stopLocalBackend();
});

app.on('will-quit', () => {
  isQuitting = true;
  stopLocalBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
