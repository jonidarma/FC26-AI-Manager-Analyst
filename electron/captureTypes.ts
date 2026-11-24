/**
 * FC26 AI Manager — Phase 2 & 2.1 Shared Capture & Diagnostics Types (Electron Main / Preload / Tests)
 */

export type RecordingHalf = 'first_half' | 'second_half';

export type RecordingUiStatus =
  | 'idle'
  | 'initializing'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'partial'
  | 'interrupted'
  | 'recoverable'
  | 'recovered'
  | 'failed'
  | 'discarded';

export type RecordingIntegrityStatus =
  | 'pending'
  | 'verified'
  | 'partial'
  | 'corrupted'
  | 'unverified';

export type RecordingSessionStatus =
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'partial'
  | 'recovered'
  | 'failed'
  | 'discarded';

export type RecordingSegmentStatus = 'writing' | 'finalized' | 'corrupted' | 'recovered';

export interface MediaProbeResult {
  valid: boolean;
  filePath: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  resolution: string | null;
  fps: number | null;
  videoCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  audioCodec: string | null;
  error?: string;
}

export interface CaptureSourceInfo {
  id: string;
  name: string;
  type: 'window' | 'screen';
  thumbnailDataUrl?: string;
  isFc26Candidate?: boolean;
  available?: boolean;
}

export interface CapturePrerequisiteCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface CaptureEngineCapabilities {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion: string | null;
  ffmpegPathSource:
    | 'packaged-resource'
    | 'dev-resource'
    | 'env-override'
    | 'system-path'
    | 'missing';
  h264Encoders: string[];
  preferredEncoder: string | null;
  supportedInputFormats: string[];
  aacAudioAvailable: boolean;
  recordingsRootDir: string | null;
  recordingsDirWritable: boolean;
  transportReady: boolean;
  ipcHandlersReady: boolean;
  prerequisites: CapturePrerequisiteCheck[];
  blockingReason: string | null;
  licenseNotice: string;
}

export interface CaptureManifestSegment {
  index: number;
  fileName: string;
  filePath: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  sizeBytes: number;
  checksum: string | null;
  resolution: string | null;
  fps: number | null;
  codec: string | null;
  hasAudio: boolean;
  finalized: boolean;
  status: RecordingSegmentStatus;
  integrityStatus: RecordingIntegrityStatus;
}

export interface CaptureManifest {
  manifestVersion: number;
  sessionId: string;
  matchId: string;
  half: RecordingHalf;
  sourceId: string;
  sourceName: string;
  sourceType: 'window' | 'screen';
  resolution: string;
  fps: number;
  bitrateKbps: number;
  encoder: string;
  audioRequested: boolean;
  audioActive: boolean;
  segmentDurationMinutes: number;
  maxRecordingMinutes: number;
  outputDirectory: string;
  status: RecordingSessionStatus;
  integrityStatus: RecordingIntegrityStatus;
  aiEligible: boolean;
  failureReason: string | null;
  diagnosticsPath: string | null;
  activeDurationSeconds: number;
  totalBytes: number;
  nextSegmentIndex: number;
  segments: CaptureManifestSegment[];
  recoveryLog: string[];
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export interface RendererCaptureDiagnostics {
  mediaStreamActive: boolean;
  videoTrackState: 'none' | 'live' | 'ended';
  videoTrackLabel: string | null;
  audioTrackState: 'none' | 'live' | 'ended';
  mediaRecorderState: 'none' | 'inactive' | 'recording' | 'paused';
  negotiatedMimeType: string | null;
  transportPortReady: boolean;
  chunksGenerated: number;
  bytesGenerated: number;
  chunksTransmitted: number;
  bytesTransmitted: number;
  chunksFailedTransport: number;
  lastChunkGeneratedAt: string | null;
  lastRendererError: string | null;
}

export interface RecordingPipelineDiagnostics {
  sessionId: string | null;
  matchId: string | null;
  transportPortAttached: boolean;
  transportPortReadyAck: boolean;
  chunksReceivedMain: number;
  bytesReceivedMain: number;
  ffmpegPid: number | null;
  ffmpegState: 'idle' | 'starting' | 'running' | 'paused' | 'finalizing' | 'stopped' | 'error';
  ffmpegStdinBytesWritten: number;
  currentProcessStdinBytesWritten?: number;
  lifetimeSessionStdinBytesWritten?: number;
  ffmpegExitCode: number | null;
  ffmpegExitSignal: string | null;
  queueSizeChunks: number;
  queueSizeBytes: number;
  backpressureEvents: number;
  droppedChunks: number;
  currentOutputFileBytes: number;
  completedSegmentsCount: number;
  lastChunkReceivedAt: string | null;
  startupWatchdogState: 'idle' | 'armed' | 'satisfied' | 'triggered';
  stallWatchdogState: 'idle' | 'monitoring' | 'paused' | 'triggered';
  startupTimeoutSeconds: number;
  stallTimeoutSeconds: number;
  lastFfmpegError: string | null;
  lastPipelineError: string | null;
  diagnosticsLogPath: string | null;
  renderer: RendererCaptureDiagnostics;
}

export interface RecordingDiagnosticEvent {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  stage:
    | 'session'
    | 'source'
    | 'mediarecorder'
    | 'transport'
    | 'ffmpeg'
    | 'watchdog'
    | 'finalization'
    | 'ffprobe'
    | 'recovery';
  message: string;
  details?: Record<string, unknown>;
}

export interface RecordingTelemetry {
  uiStatus: RecordingUiStatus;
  sessionId: string | null;
  matchId: string | null;
  half: RecordingHalf | null;
  sourceId: string | null;
  sourceName: string | null;
  sourceType: 'window' | 'screen' | null;
  sourceAvailable: boolean;
  sessionElapsedSeconds: number;
  activeDurationSeconds: number;
  currentFps: number | null;
  captureResolution: string | null;
  encoder: string | null;
  currentSegmentIndex: number;
  completedSegmentCount: number;
  totalBytes: number;
  availableDiskBytes: number | null;
  diskLowWarning: boolean;
  audioRequested: boolean;
  audioActive: boolean;
  audioStatusLabel: string;
  ffmpegStatus: 'idle' | 'starting' | 'running' | 'paused' | 'finalizing' | 'stopped' | 'error';
  ffmpegPid: number | null;
  queuedChunks: number;
  queuedBytes: number;
  backpressureActive: boolean;
  outputDirectory: string | null;
  integrityStatus: RecordingIntegrityStatus;
  aiEligible: boolean;
  failureReason: string | null;
  maxRecordingWarning: boolean;
  lastWarning: string | null;
  lastError: string | null;
  segments: CaptureManifestSegment[];
  diagnostics: RecordingPipelineDiagnostics;
}

export interface StartRecordingSessionRequest {
  matchId: string;
  half: RecordingHalf;
  sourceId: string;
  sourceName: string;
  sourceType: 'window' | 'screen';
  resolution: '1280x720' | '1920x1080';
  fps: 20 | 30;
  bitrateKbps: number;
  segmentDurationMinutes: number;
  maxRecordingMinutes: number;
  audioRequested: boolean;
  audioActive: boolean;
  inputMimeType?: string;
  startupTimeoutSeconds?: number;
  stallTimeoutSeconds?: number;
}

export interface RecoverableSessionSummary {
  sessionId: string;
  matchId: string;
  half: RecordingHalf;
  sourceName: string;
  previousStatus: RecordingSessionStatus;
  startedAt: string;
  updatedAt: string;
  outputDirectory: string;
  manifestPath: string;
  completedSegmentsFound: number;
  partialSegmentsFound: number;
  corruptedSegmentsFound: number;
  totalBytesOnDisk: number;
  estimatedDurationSeconds: number;
  recoveryClassification: 'recoverable' | 'partially_recoverable' | 'corrupted';
  notes: string[];
}

export interface RecoveryExecutionResult {
  sessionId: string;
  matchId: string;
  half: RecordingHalf;
  status: 'recovered' | 'failed' | 'discarded';
  integrityStatus: RecordingIntegrityStatus;
  classification: 'recovered' | 'partially_recovered' | 'corrupted';
  recoveredSegments: CaptureManifestSegment[];
  corruptedSegments: CaptureManifestSegment[];
  totalDurationSeconds: number;
  totalBytes: number;
  recoveryLog: string[];
}

export const EMPTY_RENDERER_DIAGNOSTICS: RendererCaptureDiagnostics = {
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

export function createEmptyPipelineDiagnostics(
  startupTimeoutSeconds = 10,
  stallTimeoutSeconds = 18
): RecordingPipelineDiagnostics {
  return {
    sessionId: null,
    matchId: null,
    transportPortAttached: false,
    transportPortReadyAck: false,
    chunksReceivedMain: 0,
    bytesReceivedMain: 0,
    ffmpegPid: null,
    ffmpegState: 'idle',
    ffmpegStdinBytesWritten: 0,
    currentProcessStdinBytesWritten: 0,
    lifetimeSessionStdinBytesWritten: 0,
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
    startupTimeoutSeconds,
    stallTimeoutSeconds,
    lastFfmpegError: null,
    lastPipelineError: null,
    diagnosticsLogPath: null,
    renderer: { ...EMPTY_RENDERER_DIAGNOSTICS },
  };
}
