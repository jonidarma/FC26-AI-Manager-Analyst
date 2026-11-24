/**
 * Self-contained TypeScript types for Electron Main & Preload capture architecture.
 * Mirrors Phase 2 types in src/types/domain.ts while keeping electron/tsconfig.json
 * strictly scoped to rootDir ".".
 */

export type RecordingHalf = 'first_half' | 'second_half';

export type RecordingIntegrityStatus =
  | 'pending'
  | 'verified'
  | 'partial'
  | 'corrupted'
  | 'unverified';

export type RecordingSessionStatus =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'recovered'
  | 'discarded';

export type RecordingUiStatus =
  | 'idle'
  | 'initializing'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'interrupted'
  | 'recoverable'
  | 'recovered'
  | 'failed'
  | 'discarded';

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
  ffmpegPathSource: 'packaged-resource' | 'dev-resource' | 'env-override' | 'system-path' | 'missing';
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
  status: 'writing' | 'finalized' | 'corrupted' | 'recovered';
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
  status: 'recording' | 'paused' | 'finalizing' | 'completed' | 'recovered' | 'discarded';
  integrityStatus: RecordingIntegrityStatus;
  activeDurationSeconds: number;
  totalBytes: number;
  nextSegmentIndex: number;
  segments: CaptureManifestSegment[];
  recoveryLog: string[];
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
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
  maxRecordingWarning: boolean;
  lastWarning: string | null;
  lastError: string | null;
  segments: CaptureManifestSegment[];
}

export interface RecoverableSessionSummary {
  sessionId: string;
  matchId: string;
  half: RecordingHalf;
  sourceName: string;
  previousStatus: CaptureManifest['status'];
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
  status: 'recovered' | 'discarded';
  integrityStatus: RecordingIntegrityStatus;
  classification: 'recovered' | 'partially_recovered' | 'corrupted';
  recoveredSegments: CaptureManifestSegment[];
  corruptedSegments: CaptureManifestSegment[];
  totalDurationSeconds: number;
  totalBytes: number;
  recoveryLog: string[];
}

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
}
