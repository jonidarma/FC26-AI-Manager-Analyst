/**
 * FC26 AI Manager — Phase 2.1 App-Level Recording Controller (Renderer Singleton)
 *
 * Architectural Guarantees:
 * - Owned outside individual React views (subscribed by AppContext) so active recording
 *   continues uninterrupted when the user navigates away from Match Capture or minimizes the app.
 * - Invokes navigator.mediaDevices.getDisplayMedia() synchronously from user action.
 * - Waits deterministically for the preload binary MessagePort handshake (with bounded preload buffering
 *   so chunk #0 WebM EBML header is never dropped).
 * - Tracks measured renderer-side diagnostics (MediaStream, video/audio tracks, MediaRecorder state,
 *   negotiated MIME type, chunks/bytes generated, chunks/bytes transmitted, failed transports) and
 *   reports them to Electron Main for real-time Diagnostics UI and Startup/Stall Watchdogs.
 * - Maps finalized manifest status honestly ('completed' | 'partial' | 'failed') — NEVER forces
 *   a 0-byte or failed session to appear as 'completed'.
 */
import { desktopBridge } from './desktopBridge';
import type {
  CaptureManifest,
  RecordingPipelineDiagnostics,
  RecordingTelemetry,
  RendererCaptureDiagnostics,
} from '../types/domain';

export interface StartCaptureOptions {
  matchId: string;
  half: 'first_half' | 'second_half';
  sourceId: string;
  sourceName: string;
  sourceType: 'window' | 'screen';
  resolution: '1280x720' | '1920x1080';
  fps: 20 | 30;
  bitrateKbps: number;
  segmentDurationMinutes: number;
  maxRecordingMinutes: number;
  audioRequested: boolean;
}

type TelemetryListener = (telemetry: RecordingTelemetry) => void;

export const INITIAL_RENDERER_DIAGNOSTICS: RendererCaptureDiagnostics = {
  mediaStreamActive: false,
  videoTrackState: 'none',
  videoTrackLabel: null,
  audioTrackState: 'none',
  mediaRecorderState: 'none',
  negotiatedMimeType: null,
  transportPortReady: false,
  chunksGenerated: 0,
  bytesGenerated: 0,
  chunksTransmitted: 0,
  bytesTransmitted: 0,
  chunksFailedTransport: 0,
  lastChunkGeneratedAt: null,
  lastRendererError: null,
};

export const INITIAL_PIPELINE_DIAGNOSTICS: RecordingPipelineDiagnostics = {
  sessionId: null,
  matchId: null,
  transportPortAttached: false,
  transportPortReadyAck: false,
  chunksReceivedMain: 0,
  bytesReceivedMain: 0,
  ffmpegPid: null,
  ffmpegState: 'idle',
  ffmpegStdinBytesWritten: 0,
  ffmpegExitCode: null,
  ffmpegExitSignal: null,
  queueSizeChunks: 0,
  queueSizeBytes: 0,
  backpressureEvents: 0,
  droppedChunks: 0,
  currentOutputFileBytes: 0,
  completedSegmentsCount: 0,
  lastChunkReceivedAt: null,
  startupWatchdogState: 'idle',
  stallWatchdogState: 'idle',
  startupTimeoutSeconds: 10,
  stallTimeoutSeconds: 18,
  lastFfmpegError: null,
  lastPipelineError: null,
  diagnosticsLogPath: null,
  renderer: { ...INITIAL_RENDERER_DIAGNOSTICS },
};

export const INITIAL_RECORDING_TELEMETRY: RecordingTelemetry = {
  uiStatus: 'idle',
  sessionId: null,
  matchId: null,
  half: null,
  sourceId: null,
  sourceName: null,
  sourceType: null,
  sourceAvailable: false,
  sessionElapsedSeconds: 0,
  activeDurationSeconds: 0,
  currentFps: null,
  captureResolution: null,
  encoder: null,
  currentSegmentIndex: 0,
  completedSegmentCount: 0,
  totalBytes: 0,
  availableDiskBytes: null,
  diskLowWarning: false,
  audioRequested: false,
  audioActive: false,
  audioStatusLabel: 'Idle',
  ffmpegStatus: 'idle',
  ffmpegPid: null,
  queuedChunks: 0,
  queuedBytes: 0,
  backpressureActive: false,
  outputDirectory: null,
  integrityStatus: 'pending',
  aiEligible: false,
  failureReason: null,
  maxRecordingWarning: false,
  lastWarning: null,
  lastError: null,
  segments: [],
  diagnostics: { ...INITIAL_PIPELINE_DIAGNOSTICS, renderer: { ...INITIAL_RENDERER_DIAGNOSTICS } },
};

function selectSupportedMediaRecorderMime(hasAudio: boolean): string {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder API is not supported in this runtime.');
  }

  const candidates = hasAudio
    ? [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ]
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return 'video/webm';
}

function mapManifestStatusToUiStatus(
  status: CaptureManifest['status']
): RecordingTelemetry['uiStatus'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'partial':
      return 'partial';
    case 'recovered':
      return 'recovered';
    case 'failed':
      return 'failed';
    case 'discarded':
      return 'discarded';
    case 'paused':
      return 'paused';
    case 'finalizing':
      return 'finalizing';
    default:
      return 'recording';
  }
}

class RecordingController {
  private telemetry: RecordingTelemetry = {
    ...INITIAL_RECORDING_TELEMETRY,
    diagnostics: { ...INITIAL_PIPELINE_DIAGNOSTICS, renderer: { ...INITIAL_RENDERER_DIAGNOSTICS } },
  };
  private rendererDiagnostics: RendererCaptureDiagnostics = { ...INITIAL_RENDERER_DIAGNOSTICS };
  private listeners = new Set<TelemetryListener>();
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private activeSessionId: string | null = null;
  private activeBitrateKbps = 3500;
  private activeMimeType = 'video/webm';
  private activeAudio = false;
  private pendingChunkTransfers = new Set<Promise<void>>();
  private initializedBridgeListeners = false;
  private lastCompletedManifest: CaptureManifest | null = null;
  private intentionalStop = false;
  private portReadyWaiters = new Map<string, Array<() => void>>();
  private diagSyncTimer: number | null = null;

  public ensureInitialized(): void {
    if (this.initializedBridgeListeners) return;
    this.initializedBridgeListeners = true;

    if (desktopBridge.isElectron()) {
      desktopBridge.onRecordingTelemetry((incoming) => {
        // Merge freshest local renderer counters if this telemetry is for our active session
        const mergedRenderer =
          incoming.sessionId && incoming.sessionId === this.activeSessionId
            ? {
                ...incoming.diagnostics?.renderer,
                ...this.rendererDiagnostics,
              }
            : incoming.diagnostics?.renderer ?? { ...INITIAL_RENDERER_DIAGNOSTICS };

        this.telemetry = {
          ...incoming,
          diagnostics: {
            ...(incoming.diagnostics ?? INITIAL_PIPELINE_DIAGNOSTICS),
            renderer: mergedRenderer,
          },
        };

        // If main-process watchdog terminated/failed the session, stop local MediaRecorder & stream cleanly
        if (
          this.activeSessionId &&
          incoming.sessionId === this.activeSessionId &&
          (incoming.uiStatus === 'failed' ||
            incoming.uiStatus === 'partial' ||
            incoming.uiStatus === 'completed' ||
            incoming.uiStatus === 'discarded')
        ) {
          this.intentionalStop = true;
          this.stopDiagnosticsSyncTimer();
          this.cleanupLocalMedia();
          this.activeSessionId = null;
        }

        this.emit();
      });

      desktopBridge.onTransportControl((msg) => {
        if (msg.type === 'port-ready') {
          if (msg.sessionId === this.activeSessionId) {
            this.rendererDiagnostics.transportPortReady = true;
          }
          const waiters = this.portReadyWaiters.get(msg.sessionId);
          if (waiters) {
            this.portReadyWaiters.delete(msg.sessionId);
            for (const resolve of waiters) resolve();
          }
          return;
        }

        if (msg.type === 'backpressure') {
          this.telemetry = {
            ...this.telemetry,
            backpressureActive: msg.active,
            queuedBytes: msg.queuedBytes,
            queuedChunks: msg.queuedChunks,
          };
          this.emit();
        }
      });

      void desktopBridge
        .getRecordingStatus()
        .then((status) => {
          this.telemetry = status;
          this.activeSessionId = status.sessionId;
          this.emit();
        })
        .catch(() => {
          // ignore initial status fetch error
        });
    }
  }

  public getTelemetry(): RecordingTelemetry {
    return this.telemetry;
  }

  public getLastCompletedManifest(): CaptureManifest | null {
    return this.lastCompletedManifest;
  }

  public isRecordingOrBusy(): boolean {
    return (
      this.telemetry.uiStatus === 'initializing' ||
      this.telemetry.uiStatus === 'recording' ||
      this.telemetry.uiStatus === 'paused' ||
      this.telemetry.uiStatus === 'finalizing'
    );
  }

  public subscribe(listener: TelemetryListener): () => void {
    this.ensureInitialized();
    this.listeners.add(listener);
    listener(this.telemetry);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.telemetry);
    }
  }

  private updateLocalTelemetry(patch: Partial<RecordingTelemetry>): void {
    this.telemetry = {
      ...this.telemetry,
      ...patch,
      diagnostics: {
        ...this.telemetry.diagnostics,
        ...(patch.diagnostics ?? {}),
        renderer: { ...this.rendererDiagnostics },
      },
    };
    this.emit();
  }

  private resetRendererDiagnostics(): void {
    this.rendererDiagnostics = { ...INITIAL_RENDERER_DIAGNOSTICS };
  }

  private refreshTrackDiagnostics(): void {
    const stream = this.mediaStream;
    const videoTrack = stream?.getVideoTracks()[0];
    const audioTrack = stream?.getAudioTracks()[0];

    this.rendererDiagnostics.mediaStreamActive = Boolean(stream?.active);
    this.rendererDiagnostics.videoTrackState = videoTrack
      ? videoTrack.readyState === 'live'
        ? 'live'
        : 'ended'
      : 'none';
    this.rendererDiagnostics.videoTrackLabel = videoTrack?.label ?? null;
    this.rendererDiagnostics.audioTrackState = audioTrack
      ? audioTrack.readyState === 'live'
        ? 'live'
        : 'ended'
      : 'none';
    this.rendererDiagnostics.mediaRecorderState = this.mediaRecorder
      ? this.mediaRecorder.state
      : 'none';
    this.rendererDiagnostics.transportPortReady = this.activeSessionId
      ? desktopBridge.isTransportPortReady(this.activeSessionId)
      : false;
  }

  private syncRendererDiagnosticsToMain(): void {
    if (!this.activeSessionId || !desktopBridge.isElectron()) return;
    this.refreshTrackDiagnostics();
    void desktopBridge
      .reportRendererDiagnostics({
        sessionId: this.activeSessionId,
        renderer: { ...this.rendererDiagnostics },
      })
      .catch(() => {
        // ignore transient IPC error
      });
  }

  private startDiagnosticsSyncTimer(): void {
    this.stopDiagnosticsSyncTimer();
    this.diagSyncTimer = window.setInterval(() => {
      this.syncRendererDiagnosticsToMain();
    }, 1000);
  }

  private stopDiagnosticsSyncTimer(): void {
    if (this.diagSyncTimer !== null) {
      window.clearInterval(this.diagSyncTimer);
      this.diagSyncTimer = null;
    }
  }

  private waitForTransportPortReady(sessionId: string, timeoutMs = 1500): Promise<boolean> {
    if (desktopBridge.isTransportPortReady(sessionId)) {
      this.rendererDiagnostics.transportPortReady = true;
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (ready: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (ready) {
          this.rendererDiagnostics.transportPortReady = true;
        }
        resolve(ready);
      };

      const list = this.portReadyWaiters.get(sessionId) ?? [];
      list.push(() => done(true));
      this.portReadyWaiters.set(sessionId, list);

      const timer = window.setTimeout(() => {
        const current = this.portReadyWaiters.get(sessionId);
        if (current) {
          this.portReadyWaiters.delete(sessionId);
        }
        done(desktopBridge.isTransportPortReady(sessionId));
      }, timeoutMs);
    });
  }

  private cleanupLocalMedia(): void {
    this.stopDiagnosticsSyncTimer();
    if (this.mediaRecorder) {
      try {
        if (this.mediaRecorder.state !== 'inactive') {
          this.mediaRecorder.stop();
        }
      } catch {
        // ignore
      }
      this.mediaRecorder = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.onended = null;
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.mediaStream = null;
    }
    this.refreshTrackDiagnostics();
  }

  private startMediaRecorderOnCurrentStream(sessionId: string): void {
    if (!this.mediaStream) {
      throw new Error('No live MediaStream available to start MediaRecorder.');
    }

    const mimeType = selectSupportedMediaRecorderMime(this.activeAudio);
    this.activeMimeType = mimeType;
    this.rendererDiagnostics.negotiatedMimeType = mimeType;

    const recorder = new MediaRecorder(this.mediaStream, {
      mimeType,
      videoBitsPerSecond: Math.max(1500, this.activeBitrateKbps) * 1000,
    });

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return;

      const chunkSize = event.data.size;
      this.rendererDiagnostics.chunksGenerated += 1;
      this.rendererDiagnostics.bytesGenerated += chunkSize;
      this.rendererDiagnostics.lastChunkGeneratedAt = new Date().toISOString();

      const transferPromise = event.data
        .arrayBuffer()
        .then((buf) => {
          const sendRes = desktopBridge.sendRecordingChunk(sessionId, buf);
          if (sendRes.ok) {
            this.rendererDiagnostics.chunksTransmitted += 1;
            this.rendererDiagnostics.bytesTransmitted += sendRes.bytes;
          } else {
            this.rendererDiagnostics.chunksFailedTransport += 1;
            this.rendererDiagnostics.lastRendererError =
              sendRes.error ?? 'Failed to transmit binary recording chunk to preload transport.';
            this.updateLocalTelemetry({
              lastWarning: this.rendererDiagnostics.lastRendererError,
            });
          }
        })
        .catch((err) => {
          this.rendererDiagnostics.chunksFailedTransport += 1;
          this.rendererDiagnostics.lastRendererError =
            err instanceof Error
              ? `Chunk ArrayBuffer read failed: ${err.message}`
              : 'Chunk ArrayBuffer read failed.';
          this.updateLocalTelemetry({
            lastWarning: this.rendererDiagnostics.lastRendererError,
          });
        })
        .finally(() => {
          this.pendingChunkTransfers.delete(transferPromise);
        });
      this.pendingChunkTransfers.add(transferPromise);
    };

    recorder.onerror = (ev) => {
      if (!this.intentionalStop) {
        const errMsg =
          (ev as Event & { error?: DOMException }).error?.message ||
          'Browser MediaRecorder reported an encoding error.';
        this.rendererDiagnostics.lastRendererError = errMsg;
        this.syncRendererDiagnosticsToMain();
        this.updateLocalTelemetry({
          lastError: errMsg,
        });
      }
    };

    this.mediaRecorder = recorder;
    // 1000ms timeslice gives low latency and bounded chunk sizes for FFmpeg stdin
    recorder.start(1000);
    this.refreshTrackDiagnostics();
    this.syncRendererDiagnosticsToMain();
    this.startDiagnosticsSyncTimer();
  }

  private async stopCurrentMediaRecorderAndFlush(sessionId: string): Promise<void> {
    this.stopDiagnosticsSyncTimer();
    const recorder = this.mediaRecorder;
    this.mediaRecorder = null;

    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 2500);
        recorder.addEventListener(
          'stop',
          () => {
            window.clearTimeout(timeout);
            resolve();
          },
          { once: true }
        );
        try {
          recorder.stop();
        } catch {
          window.clearTimeout(timeout);
          resolve();
        }
      });
    }

    if (this.pendingChunkTransfers.size > 0) {
      await Promise.allSettled(Array.from(this.pendingChunkTransfers));
    }

    this.syncRendererDiagnosticsToMain();
    desktopBridge.endRecordingTransport(sessionId);
  }

  public async startRecording(options: StartCaptureOptions): Promise<CaptureManifest> {
    this.ensureInitialized();

    if (!desktopBridge.isElectron()) {
      throw new Error(
        'Native video recording is only available in the Windows Electron desktop application.'
      );
    }
    if (this.isRecordingOrBusy()) {
      throw new Error(
        'A recording session is already active. Stop or discard it before starting a new one.'
      );
    }

    this.intentionalStop = false;
    this.lastCompletedManifest = null;
    this.resetRendererDiagnostics();
    this.updateLocalTelemetry({
      uiStatus: 'initializing',
      lastError: null,
      lastWarning: null,
      failureReason: null,
      aiEligible: false,
    });

    try {
      // Step 1: Authorize the exact selected source in Electron Main Process
      const auth = await desktopBridge.selectCaptureSource({
        sourceId: options.sourceId,
        sourceName: options.sourceName,
        sourceType: options.sourceType,
        audioRequested: options.audioRequested,
      });

      if (!auth.authorized) {
        throw new Error(
          auth.reason ??
            'Selected capture source is no longer available. Refresh sources and select again.'
        );
      }

      // Step 2: Acquire live MediaStream via setDisplayMediaRequestHandler()
      const [targetW, targetH] = options.resolution === '1920x1080' ? [1920, 1080] : [1280, 720];
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: targetW, max: targetW },
          height: { ideal: targetH, max: targetH },
          frameRate: { ideal: options.fps, max: options.fps },
        },
        audio: options.audioRequested,
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        for (const t of stream.getTracks()) t.stop();
        throw new Error('Capture stream did not provide a video track.');
      }

      const audioTracks = stream.getAudioTracks();
      const audioActive = options.audioRequested && audioTracks.length > 0;
      const mimeType = selectSupportedMediaRecorderMime(audioActive);

      this.mediaStream = stream;
      this.activeBitrateKbps = options.bitrateKbps;
      this.activeAudio = audioActive;
      this.activeMimeType = mimeType;
      this.rendererDiagnostics.negotiatedMimeType = mimeType;
      this.refreshTrackDiagnostics();

      // Step 3: Start Main Process FFmpeg session & attach binary MessagePort
      const started = await desktopBridge.startRecordingSession({
        ...options,
        audioActive,
        inputMimeType: mimeType,
      });

      this.activeSessionId = started.sessionId;
      this.telemetry = started.telemetry;
      if (options.audioRequested && !audioActive) {
        this.telemetry = {
          ...this.telemetry,
          lastWarning:
            'System loopback audio was unavailable for this capture; recording continued in video-only mode.',
        };
      }
      this.emit();

      // Handle unexpected game/window closure or external stop-sharing
      videoTrack.onended = () => {
        if (this.intentionalStop) return;
        const sid = this.activeSessionId;
        if (!sid) return;
        void this.handleStreamEndedUnexpectedly(sid);
      };

      // Wait deterministically for preload MessagePort attachment (preload also buffers early chunks)
      await this.waitForTransportPortReady(started.sessionId, 1500);
      this.startMediaRecorderOnCurrentStream(started.sessionId);

      return started.manifest;
    } catch (err) {
      this.cleanupLocalMedia();
      this.activeSessionId = null;
      const message = err instanceof Error ? err.message : 'Failed to start recording.';
      this.rendererDiagnostics.lastRendererError = message;
      this.updateLocalTelemetry({
        uiStatus: 'failed',
        ffmpegStatus: 'error',
        lastError: message,
        failureReason: message,
        aiEligible: false,
      });
      throw err;
    }
  }

  private async handleStreamEndedUnexpectedly(sessionId: string): Promise<void> {
    this.intentionalStop = true;
    await this.stopCurrentMediaRecorderAndFlush(sessionId);
    this.cleanupLocalMedia();
    this.activeSessionId = null;

    try {
      const res = await desktopBridge.reportStreamInterrupted({
        sessionId,
        reason: 'Selected EA SPORTS FC 26 window or display stream closed unexpectedly.',
      });
      if (res.manifest) {
        this.lastCompletedManifest = res.manifest;
      }
      if (res.telemetry) {
        this.telemetry = res.telemetry;
        this.emit();
        return;
      }
      this.updateLocalTelemetry({
        uiStatus: res.manifest?.status === 'failed' ? 'failed' : 'interrupted',
        sourceAvailable: false,
        lastError:
          res.manifest?.failureReason ??
          'Capture source window closed during recording. Any valid segments were saved and verified.',
      });
    } catch {
      this.updateLocalTelemetry({
        uiStatus: 'interrupted',
        sourceAvailable: false,
        lastError: 'Capture stream ended unexpectedly.',
      });
    }
  }

  public async pauseRecording(): Promise<void> {
    const sessionId = this.activeSessionId ?? this.telemetry.sessionId;
    if (!sessionId || this.telemetry.uiStatus !== 'recording') {
      throw new Error('No active recording session to pause.');
    }

    // Flush current MediaRecorder segment while preserving live MediaStream
    await this.stopCurrentMediaRecorderAndFlush(sessionId);
    const updated = await desktopBridge.pauseRecordingSession(sessionId);
    this.telemetry = updated;
    this.emit();
  }

  public async resumeRecording(): Promise<void> {
    const sessionId = this.activeSessionId ?? this.telemetry.sessionId;
    if (!sessionId || this.telemetry.uiStatus !== 'paused') {
      throw new Error('No paused recording session to resume.');
    }

    const videoTrack = this.mediaStream?.getVideoTracks()[0];
    if (!this.mediaStream || !videoTrack || videoTrack.readyState !== 'live') {
      throw new Error(
        'The captured window stream is no longer live. Finalize this session and reselect the FC26 window.'
      );
    }

    const updated = await desktopBridge.resumeRecordingSession({
      sessionId,
      inputMimeType: this.activeMimeType,
    });
    this.telemetry = updated;
    this.emit();

    await this.waitForTransportPortReady(sessionId, 1500);
    this.startMediaRecorderOnCurrentStream(sessionId);
  }

  public async stopRecording(reason?: string): Promise<CaptureManifest | null> {
    const sessionId = this.activeSessionId ?? this.telemetry.sessionId;
    if (!sessionId) {
      return null;
    }

    this.intentionalStop = true;
    this.updateLocalTelemetry({ uiStatus: 'finalizing', ffmpegStatus: 'finalizing' });

    await this.stopCurrentMediaRecorderAndFlush(sessionId);
    this.cleanupLocalMedia();

    const result = await desktopBridge.stopRecordingSession({ sessionId, reason });
    this.activeSessionId = null;
    if (result.manifest) {
      this.lastCompletedManifest = result.manifest;
    }
    this.telemetry = result.manifest
      ? {
          ...result.telemetry,
          uiStatus: mapManifestStatusToUiStatus(result.manifest.status),
          sessionId: result.manifest.sessionId,
          matchId: result.manifest.matchId,
          half: result.manifest.half,
          activeDurationSeconds: result.manifest.activeDurationSeconds,
          completedSegmentCount: result.manifest.segments.filter(
            (s) =>
              (s.finalized || s.status === 'finalized' || s.status === 'recovered') &&
              s.sizeBytes > 0 &&
              s.durationSeconds > 0
          ).length,
          totalBytes: result.manifest.totalBytes,
          outputDirectory: result.manifest.outputDirectory,
          integrityStatus: result.manifest.integrityStatus,
          aiEligible: result.manifest.aiEligible,
          failureReason: result.manifest.failureReason,
          lastError:
            result.manifest.status === 'failed'
              ? result.manifest.failureReason ?? result.telemetry.lastError
              : result.telemetry.lastError,
          segments: result.manifest.segments,
          diagnostics: {
            ...(result.telemetry.diagnostics ?? INITIAL_PIPELINE_DIAGNOSTICS),
            renderer: { ...this.rendererDiagnostics },
          },
        }
      : result.telemetry;
    this.emit();
    return result.manifest;
  }

  public async discardRecording(sessionId: string, matchId?: string): Promise<{
    discarded: boolean;
    removedFiles: number;
  }> {
    if (this.activeSessionId === sessionId || this.telemetry.sessionId === sessionId) {
      this.intentionalStop = true;
      this.cleanupLocalMedia();
      this.activeSessionId = null;
    }
    const res = await desktopBridge.discardRecordingSession({ sessionId, matchId });
    if (this.lastCompletedManifest?.sessionId === sessionId) {
      this.lastCompletedManifest = null;
    }
    this.resetRendererDiagnostics();
    this.telemetry = {
      ...INITIAL_RECORDING_TELEMETRY,
      uiStatus: 'discarded',
      diagnostics: { ...INITIAL_PIPELINE_DIAGNOSTICS, renderer: { ...INITIAL_RENDERER_DIAGNOSTICS } },
    };
    this.emit();
    return res;
  }
}

export const recordingController = new RecordingController();
