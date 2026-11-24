/**
 * FC26 AI Manager — Phase 2 App-Level Recording Controller (Renderer Singleton)
 *
 * Architectural Guarantee:
 * - Owned outside individual React views (subscribed by AppContext) so active recording
 *   continues uninterrupted when the user navigates away from Match Capture or minimizes the app.
 * - Invokes navigator.mediaDevices.getDisplayMedia() synchronously from user action.
 * - Streams MediaRecorder WebM chunks directly as transferable binary ArrayBuffers over
 *   Electron's MessagePort bridge (zero Base64, zero Express JSON video uploads).
 * - Handles pause/resume cleanly by flushing and closing the active MediaRecorder/FFmpeg segment
 *   while preserving the live MediaStream and sessionId, then restarting cleanly on resume.
 */
import { desktopBridge } from './desktopBridge';
import type { CaptureManifest, RecordingTelemetry } from '../types/domain';

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
  maxRecordingWarning: false,
  lastWarning: null,
  lastError: null,
  segments: [],
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
    : [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];

  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return 'video/webm';
}

class RecordingController {
  private telemetry: RecordingTelemetry = { ...INITIAL_RECORDING_TELEMETRY };
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

  public ensureInitialized(): void {
    if (this.initializedBridgeListeners) return;
    this.initializedBridgeListeners = true;

    if (desktopBridge.isElectron()) {
      desktopBridge.onRecordingTelemetry((incoming) => {
        this.telemetry = incoming;
        this.emit();
      });

      desktopBridge.onTransportControl((msg) => {
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
    this.telemetry = { ...this.telemetry, ...patch };
    this.emit();
  }

  private cleanupLocalMedia(): void {
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
  }

  private startMediaRecorderOnCurrentStream(sessionId: string): void {
    if (!this.mediaStream) {
      throw new Error('No live MediaStream available to start MediaRecorder.');
    }

    const mimeType = selectSupportedMediaRecorderMime(this.activeAudio);
    this.activeMimeType = mimeType;

    const recorder = new MediaRecorder(this.mediaStream, {
      mimeType,
      videoBitsPerSecond: Math.max(1500, this.activeBitrateKbps) * 1000,
    });

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return;
      const transferPromise = event.data
        .arrayBuffer()
        .then((buf) => {
          desktopBridge.sendRecordingChunk(sessionId, buf);
        })
        .catch(() => {
          // ignore transient chunk read error
        })
        .finally(() => {
          this.pendingChunkTransfers.delete(transferPromise);
        });
      this.pendingChunkTransfers.add(transferPromise);
    };

    recorder.onerror = () => {
      if (!this.intentionalStop) {
        this.updateLocalTelemetry({
          lastError: 'Browser MediaRecorder reported an encoding error.',
        });
      }
    };

    this.mediaRecorder = recorder;
    // 1000ms timeslice gives low latency and bounded chunk sizes for FFmpeg stdin
    recorder.start(1000);
  }

  private async stopCurrentMediaRecorderAndFlush(sessionId: string): Promise<void> {
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

    desktopBridge.endRecordingTransport(sessionId);
  }

  public async startRecording(options: StartCaptureOptions): Promise<CaptureManifest> {
    this.ensureInitialized();

    if (!desktopBridge.isElectron()) {
      throw new Error('Native video recording is only available in the Windows Electron desktop application.');
    }
    if (this.isRecordingOrBusy()) {
      throw new Error('A recording session is already active. Stop or discard it before starting a new one.');
    }

    this.intentionalStop = false;
    this.lastCompletedManifest = null;
    this.updateLocalTelemetry({
      uiStatus: 'initializing',
      lastError: null,
      lastWarning: null,
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
          auth.reason ?? 'Selected capture source is no longer available. Refresh sources and select again.'
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

      // Allow transferred MessagePort event to deliver to preload before first chunk
      await new Promise((r) => window.setTimeout(r, 60));
      this.startMediaRecorderOnCurrentStream(started.sessionId);

      return started.manifest;
    } catch (err) {
      this.cleanupLocalMedia();
      this.activeSessionId = null;
      const message = err instanceof Error ? err.message : 'Failed to start recording.';
      this.updateLocalTelemetry({
        uiStatus: 'failed',
        ffmpegStatus: 'error',
        lastError: message,
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
      this.updateLocalTelemetry({
        uiStatus: 'interrupted',
        sourceAvailable: false,
        lastError:
          'Capture source window closed during recording. Completed segments were saved and verified.',
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

    await new Promise((r) => window.setTimeout(r, 60));
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
          uiStatus: 'completed',
          sessionId: result.manifest.sessionId,
          matchId: result.manifest.matchId,
          half: result.manifest.half,
          activeDurationSeconds: result.manifest.activeDurationSeconds,
          completedSegmentCount: result.manifest.segments.filter((s) => s.finalized).length,
          totalBytes: result.manifest.totalBytes,
          outputDirectory: result.manifest.outputDirectory,
          integrityStatus: result.manifest.integrityStatus,
          segments: result.manifest.segments,
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
    this.telemetry = { ...INITIAL_RECORDING_TELEMETRY, uiStatus: 'discarded' };
    this.emit();
    return res;
  }
}

export const recordingController = new RecordingController();
