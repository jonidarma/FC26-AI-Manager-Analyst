/**
 * FC26 AI Manager — Phase 2 Desktop Capture Session Engine
 *
 * Canonical Directory Layout (fixes Phase 1.1 duplicate recordings/recordings bug):
 *   <recordingsRootDir>/<matchId>/<sessionId>/
 *     manifest.json
 *     segment_001.mp4
 *     segment_002.mp4
 *     ...
 *
 * Also reads legacy <recordingsRootDir>/manifests/*.json read-only during crash recovery scans
 * so existing Phase 1.1 user data directories remain backward compatible.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CaptureManifest,
  CaptureManifestSegment,
  RecoverableSessionSummary,
  RecordingDiagnosticEvent,
  RecordingHalf,
  RecordingIntegrityStatus,
  RecordingPipelineDiagnostics,
  RecoveryExecutionResult,
} from './captureTypes';
import {
  attemptPartialSegmentRepair,
  computeFileSha256,
  parseSegmentIndexFromFileName,
  probeMediaFile,
} from './ffmpegRecordingService';

const ALLOWED_TRANSITIONS: Record<CaptureManifest['status'], Array<CaptureManifest['status']>> = {
  recording: ['paused', 'finalizing', 'recovered', 'failed', 'discarded'],
  paused: ['recording', 'finalizing', 'recovered', 'failed', 'discarded'],
  finalizing: ['completed', 'partial', 'recovered', 'failed', 'discarded'],
  completed: ['discarded'],
  partial: ['discarded'],
  recovered: ['discarded'],
  failed: ['discarded'],
  discarded: [],
};

const MAX_DIAGNOSTIC_LOG_BYTES = 512 * 1024; // 512 KB cap per session diagnostics.jsonl
const MAX_GLOBAL_LOG_BYTES = 2 * 1024 * 1024; // 2 MB cap for global capture-diagnostics.log

function sanitizePathSegment(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 96 || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error(`Invalid ${label} identifier: must contain only alphanumeric, underscore, or hyphen characters.`);
  }
  return trimmed;
}

export class CaptureSessionEngine {
  public readonly rootDir: string;
  private readonly legacyManifestsDir: string;

  constructor(recordingsRootDir: string) {
    this.rootDir = path.resolve(recordingsRootDir);
    this.legacyManifestsDir = path.join(this.rootDir, 'manifests');
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  public canTransition(
    from: CaptureManifest['status'],
    to: CaptureManifest['status']
  ): boolean {
    if (from === to) return true;
    return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
  }

  public getSafeSessionDirectory(matchId: string, sessionId: string): string {
    const safeMatch = sanitizePathSegment(matchId, 'matchId');
    const safeSession = sanitizePathSegment(sessionId, 'sessionId');
    const resolved = path.resolve(this.rootDir, safeMatch, safeSession);
    if (!resolved.startsWith(this.rootDir + path.sep)) {
      throw new Error('Resolved session directory escapes recordings root.');
    }
    return resolved;
  }

  public getManifestPath(matchId: string, sessionId: string): string {
    const sessionDir = this.getSafeSessionDirectory(matchId, sessionId);
    return path.join(sessionDir, 'manifest.json');
  }

  public getSegmentListPath(matchId: string, sessionId: string): string {
    const sessionDir = this.getSafeSessionDirectory(matchId, sessionId);
    return path.join(sessionDir, '.segments.list');
  }

  public getSessionDiagnosticsLogPath(matchId: string, sessionId: string): string {
    const sessionDir = this.getSafeSessionDirectory(matchId, sessionId);
    return path.join(sessionDir, 'diagnostics.jsonl');
  }

  public getSessionDiagnosticsSummaryPath(matchId: string, sessionId: string): string {
    const sessionDir = this.getSafeSessionDirectory(matchId, sessionId);
    return path.join(sessionDir, 'diagnostics-summary.json');
  }

  public getGlobalDiagnosticsDir(): string {
    const dir = path.join(this.rootDir, '_diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Appends a bounded, sanitized diagnostic event (NEVER raw video bytes) to the session's
   * diagnostics.jsonl file. Automatically caps file size to prevent runaway disk growth.
   */
  public appendDiagnosticEvent(
    matchId: string,
    sessionId: string,
    event: Omit<RecordingDiagnosticEvent, 'timestamp'> & { timestamp?: string }
  ): string | null {
    try {
      const logPath = this.getSessionDiagnosticsLogPath(matchId, sessionId);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      if (fs.existsSync(logPath)) {
        const st = fs.statSync(logPath);
        if (st.size >= MAX_DIAGNOSTIC_LOG_BYTES) {
          return logPath;
        }
      }
      const entry: RecordingDiagnosticEvent = {
        timestamp: event.timestamp ?? new Date().toISOString(),
        level: event.level,
        stage: event.stage,
        message: event.message.slice(0, 1200),
        ...(event.details ? { details: event.details } : {}),
      };
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
      return logPath;
    } catch {
      return null;
    }
  }

  /**
   * Writes a sanitized JSON diagnostic report for a session and appends a compact summary line
   * to the bounded global capture-diagnostics.log.
   */
  public writeSessionDiagnosticsSummary(
    manifest: CaptureManifest,
    diagnostics: RecordingPipelineDiagnostics,
    extra?: { ffmpegArgs?: string[]; ffmpegStderrTail?: string[] }
  ): string | null {
    try {
      const summaryPath = this.getSessionDiagnosticsSummaryPath(manifest.matchId, manifest.sessionId);
      const logPath = this.getSessionDiagnosticsLogPath(manifest.matchId, manifest.sessionId);
      let recentEvents: RecordingDiagnosticEvent[] = [];
      if (fs.existsSync(logPath)) {
        const rawLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
        recentEvents = rawLines.slice(-150).map((line) => {
          try {
            return JSON.parse(line) as RecordingDiagnosticEvent;
          } catch {
            return {
              timestamp: new Date().toISOString(),
              level: 'info' as const,
              stage: 'session' as const,
              message: line.slice(0, 300),
            };
          }
        });
      }

      const report = {
        exportedAt: new Date().toISOString(),
        sessionId: manifest.sessionId,
        matchId: manifest.matchId,
        half: manifest.half,
        status: manifest.status,
        integrityStatus: manifest.integrityStatus,
        aiEligible: manifest.aiEligible,
        failureReason: manifest.failureReason,
        config: {
          sourceId: manifest.sourceId,
          sourceName: manifest.sourceName,
          sourceType: manifest.sourceType,
          resolution: manifest.resolution,
          fps: manifest.fps,
          bitrateKbps: manifest.bitrateKbps,
          encoder: manifest.encoder,
          audioRequested: manifest.audioRequested,
          audioActive: manifest.audioActive,
          segmentDurationMinutes: manifest.segmentDurationMinutes,
          maxRecordingMinutes: manifest.maxRecordingMinutes,
        },
        totals: {
          activeDurationSeconds: manifest.activeDurationSeconds,
          totalBytes: manifest.totalBytes,
          segmentCount: manifest.segments.length,
          validSegmentCount: manifest.segments.filter(
            (s) => (s.status === 'finalized' || s.status === 'recovered') && s.sizeBytes > 0 && s.durationSeconds > 0
          ).length,
        },
        diagnostics,
        ffmpegArgs: extra?.ffmpegArgs ?? [],
        ffmpegStderrTail: extra?.ffmpegStderrTail ?? [],
        segments: manifest.segments.map((s) => ({
          index: s.index,
          fileName: s.fileName,
          status: s.status,
          integrityStatus: s.integrityStatus,
          durationSeconds: s.durationSeconds,
          sizeBytes: s.sizeBytes,
          resolution: s.resolution,
          fps: s.fps,
          codec: s.codec,
          hasAudio: s.hasAudio,
          checksum: s.checksum,
        })),
        recoveryLog: manifest.recoveryLog.slice(-50),
        events: recentEvents,
      };

      const tmpPath = `${summaryPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2), 'utf8');
      fs.renameSync(tmpPath, summaryPath);

      // Append one-line entry to bounded global capture-diagnostics.log
      const globalLogPath = path.join(this.getGlobalDiagnosticsDir(), 'capture-diagnostics.log');
      if (fs.existsSync(globalLogPath) && fs.statSync(globalLogPath).size >= MAX_GLOBAL_LOG_BYTES) {
        const rotated = `${globalLogPath}.prev`;
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(globalLogPath, rotated);
      }
      const line = `${new Date().toISOString()} session=${manifest.sessionId} match=${manifest.matchId} status=${manifest.status} integrity=${manifest.integrityStatus} segments=${manifest.segments.length} bytes=${manifest.totalBytes} chunksMain=${diagnostics.chunksReceivedMain} stdinBytes=${diagnostics.ffmpegStdinBytesWritten} reason=${JSON.stringify(manifest.failureReason ?? '')}\n`;
      fs.appendFileSync(globalLogPath, line, 'utf8');

      return summaryPath;
    } catch {
      return null;
    }
  }

  public resolveSafeMediaPath(filePath: string, requireMp4 = true): string {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(this.rootDir + path.sep)) {
      throw new Error('Requested media path is outside the recordings directory.');
    }
    if (requireMp4 && !resolved.toLowerCase().endsWith('.mp4')) {
      throw new Error('Only local .mp4 recording segments may be opened.');
    }
    if (!fs.existsSync(resolved)) {
      throw new Error('Requested recording file does not exist on disk.');
    }
    return resolved;
  }

  public resolveSafeSessionFolder(folderPath: string): string {
    const resolved = path.resolve(folderPath);
    if (!resolved.startsWith(this.rootDir + path.sep) && resolved !== this.rootDir) {
      throw new Error('Requested folder path is outside the recordings directory.');
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error('Requested session folder does not exist.');
    }
    return resolved;
  }

  private writeManifestAtomic(manifestPath: string, manifest: CaptureManifest): void {
    const dir = path.dirname(manifestPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${manifestPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmpPath, manifestPath);
  }

  public createSessionManifest(input: {
    sessionId?: string;
    matchId: string;
    half: RecordingHalf;
    sourceId: string;
    sourceName: string;
    sourceType?: 'window' | 'screen';
    resolution: string;
    fps: number;
    bitrateKbps?: number;
    encoder?: string;
    audioRequested?: boolean;
    audioActive?: boolean;
    segmentDurationMinutes: number;
    maxRecordingMinutes?: number;
  }): CaptureManifest {
    const sessionId = input.sessionId
      ? sanitizePathSegment(input.sessionId, 'sessionId')
      : crypto.randomUUID();
    const safeMatchId = sanitizePathSegment(input.matchId, 'matchId');
    const sessionDir = this.getSafeSessionDirectory(safeMatchId, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const now = new Date().toISOString();
    const diagLogPath = this.getSessionDiagnosticsLogPath(safeMatchId, sessionId);
    const manifest: CaptureManifest = {
      manifestVersion: 3,
      sessionId,
      matchId: safeMatchId,
      half: input.half,
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      sourceType: input.sourceType ?? (input.sourceId.startsWith('screen:') ? 'screen' : 'window'),
      resolution: input.resolution,
      fps: input.fps,
      bitrateKbps: input.bitrateKbps ?? 3500,
      encoder: input.encoder ?? 'libx264',
      audioRequested: Boolean(input.audioRequested),
      audioActive: Boolean(input.audioActive),
      segmentDurationMinutes: Math.max(2, Math.min(5, Math.round(input.segmentDurationMinutes))),
      maxRecordingMinutes: Math.max(5, Math.min(180, Math.round(input.maxRecordingMinutes ?? 90))),
      outputDirectory: sessionDir,
      status: 'recording',
      integrityStatus: 'pending',
      aiEligible: false,
      failureReason: null,
      diagnosticsPath: diagLogPath,
      activeDurationSeconds: 0,
      totalBytes: 0,
      nextSegmentIndex: 1,
      segments: [],
      recoveryLog: [],
      startedAt: now,
      endedAt: null,
      updatedAt: now,
    };

    this.writeManifestAtomic(this.getManifestPath(safeMatchId, sessionId), manifest);
    return manifest;
  }

  public findManifestPathBySessionId(sessionId: string): string | null {
    const safeSession = sanitizePathSegment(sessionId, 'sessionId');

    // Search canonical <rootDir>/<matchId>/<sessionId>/manifest.json
    if (fs.existsSync(this.rootDir)) {
      const matchEntries = fs.readdirSync(this.rootDir, { withFileTypes: true });
      for (const entry of matchEntries) {
        if (!entry.isDirectory() || entry.name === 'manifests') continue;
        const candidate = path.join(this.rootDir, entry.name, safeSession, 'manifest.json');
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    // Fallback read-only search in legacy <rootDir>/manifests/<sessionId>.json
    const legacy = path.join(this.legacyManifestsDir, `${safeSession}.json`);
    if (fs.existsSync(legacy)) {
      return legacy;
    }
    return null;
  }

  public loadSessionManifest(sessionId: string, matchId?: string): CaptureManifest | null {
    const manifestPath = matchId
      ? this.getManifestPath(matchId, sessionId)
      : this.findManifestPathBySessionId(sessionId);
    if (!manifestPath || !fs.existsSync(manifestPath)) return null;

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<CaptureManifest>;
      if (!raw.sessionId || !raw.matchId || !raw.half) return null;
      return this.normalizeLegacyManifest(raw, manifestPath);
    } catch {
      return null;
    }
  }

  private normalizeLegacyManifest(
    raw: Partial<CaptureManifest>,
    manifestPath: string
  ): CaptureManifest {
    const now = new Date().toISOString();
    const matchId = raw.matchId ?? 'unknown';
    const sessionId = raw.sessionId ?? path.basename(manifestPath, '.json');
    const outputDirectory =
      raw.outputDirectory ??
      (path.basename(manifestPath) === 'manifest.json'
        ? path.dirname(manifestPath)
        : path.join(this.rootDir, matchId, sessionId));

    const segments: CaptureManifestSegment[] = Array.isArray(raw.segments)
      ? raw.segments.map((seg) => ({
          index: seg.index,
          fileName: seg.fileName ?? path.basename(seg.filePath ?? `segment_${String(seg.index).padStart(3, '0')}.mp4`),
          filePath: seg.filePath,
          startedAt: seg.startedAt ?? raw.startedAt ?? now,
          endedAt: seg.endedAt ?? null,
          durationSeconds: Number(seg.durationSeconds ?? 0),
          sizeBytes: Number(seg.sizeBytes ?? 0),
          checksum: seg.checksum ?? null,
          resolution: seg.resolution ?? raw.resolution ?? null,
          fps: seg.fps ?? raw.fps ?? null,
          codec: seg.codec ?? null,
          hasAudio: Boolean(seg.hasAudio),
          finalized: Boolean(seg.finalized),
          status: seg.status ?? (seg.finalized ? 'finalized' : 'writing'),
          integrityStatus: seg.integrityStatus ?? (seg.finalized ? 'verified' : 'pending'),
        }))
      : [];

    const maxSegIndex = segments.reduce((max, s) => Math.max(max, s.index), 0);

    const validSegCount = segments.filter(
      (s) => (s.status === 'finalized' || s.status === 'recovered') && s.sizeBytes > 0 && s.durationSeconds > 0
    ).length;

    return {
      manifestVersion: raw.manifestVersion ?? 3,
      sessionId,
      matchId,
      half: raw.half ?? 'first_half',
      sourceId: raw.sourceId ?? '',
      sourceName: raw.sourceName ?? 'Unknown Source',
      sourceType: raw.sourceType ?? (raw.sourceId?.startsWith('screen:') ? 'screen' : 'window'),
      resolution: raw.resolution ?? '1280x720',
      fps: raw.fps ?? 30,
      bitrateKbps: raw.bitrateKbps ?? 3500,
      encoder: raw.encoder ?? 'libx264',
      audioRequested: Boolean(raw.audioRequested),
      audioActive: Boolean(raw.audioActive),
      segmentDurationMinutes: raw.segmentDurationMinutes ?? 3,
      maxRecordingMinutes: raw.maxRecordingMinutes ?? 90,
      outputDirectory,
      status: raw.status ?? 'recording',
      integrityStatus: raw.integrityStatus ?? 'pending',
      aiEligible:
        typeof raw.aiEligible === 'boolean'
          ? raw.aiEligible
          : validSegCount > 0 &&
            (raw.status === 'completed' || raw.status === 'partial' || raw.status === 'recovered'),
      failureReason: raw.failureReason ?? null,
      diagnosticsPath: raw.diagnosticsPath ?? null,
      activeDurationSeconds: Number(raw.activeDurationSeconds ?? 0),
      totalBytes: Number(raw.totalBytes ?? segments.reduce((sum, s) => sum + s.sizeBytes, 0)),
      nextSegmentIndex: raw.nextSegmentIndex ?? maxSegIndex + 1,
      segments,
      recoveryLog: Array.isArray(raw.recoveryLog) ? raw.recoveryLog : [],
      startedAt: raw.startedAt ?? now,
      endedAt: raw.endedAt ?? null,
      updatedAt: raw.updatedAt ?? now,
    };
  }

  public updateSessionStatus(
    sessionId: string,
    nextStatus: CaptureManifest['status'],
    patch?: Partial<
      Pick<
        CaptureManifest,
        | 'activeDurationSeconds'
        | 'totalBytes'
        | 'nextSegmentIndex'
        | 'integrityStatus'
        | 'aiEligible'
        | 'failureReason'
        | 'diagnosticsPath'
        | 'endedAt'
        | 'encoder'
        | 'audioActive'
        | 'recoveryLog'
      >
    >,
    matchId?: string
  ): CaptureManifest {
    const manifestPath = matchId
      ? this.getManifestPath(matchId, sessionId)
      : this.findManifestPathBySessionId(sessionId);
    if (!manifestPath) {
      throw new Error(`Capture manifest not found for session ${sessionId}.`);
    }

    const current = this.loadSessionManifest(sessionId, matchId);
    if (!current) {
      throw new Error(`Capture manifest unreadable for session ${sessionId}.`);
    }

    if (!this.canTransition(current.status, nextStatus)) {
      throw new Error(`Invalid capture state transition: ${current.status} -> ${nextStatus}`);
    }

    const updated: CaptureManifest = {
      ...current,
      ...patch,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    };
    this.writeManifestAtomic(manifestPath, updated);
    return updated;
  }

  public upsertSegment(
    sessionId: string,
    segment: CaptureManifestSegment,
    matchId?: string
  ): CaptureManifest {
    const manifestPath = matchId
      ? this.getManifestPath(matchId, sessionId)
      : this.findManifestPathBySessionId(sessionId);
    if (!manifestPath) {
      throw new Error(`Capture manifest not found for session ${sessionId}.`);
    }
    const current = this.loadSessionManifest(sessionId, matchId);
    if (!current) {
      throw new Error(`Capture manifest unreadable for session ${sessionId}.`);
    }

    const idx = current.segments.findIndex((s) => s.index === segment.index);
    if (idx >= 0) {
      current.segments[idx] = segment;
    } else {
      current.segments.push(segment);
      current.segments.sort((a, b) => a.index - b.index);
    }

    current.totalBytes = current.segments.reduce((sum, s) => sum + s.sizeBytes, 0);
    const maxIdx = current.segments.reduce((max, s) => Math.max(max, s.index), 0);
    current.nextSegmentIndex = Math.max(current.nextSegmentIndex, maxIdx + 1);
    current.updatedAt = new Date().toISOString();

    this.writeManifestAtomic(manifestPath, current);
    return current;
  }

  public failSessionManifest(
    sessionId: string,
    failureReason: string,
    options?: {
      activeDurationSeconds?: number;
      matchId?: string;
    }
  ): CaptureManifest | null {
    const current = this.loadSessionManifest(sessionId, options?.matchId);
    if (!current) return null;

    if (current.status === 'failed' || current.status === 'discarded') {
      return current;
    }

    const now = new Date().toISOString();
    const totalBytes = current.segments
      .filter((s) => (s.status === 'finalized' || s.status === 'recovered') && s.sizeBytes > 0)
      .reduce((sum, s) => sum + s.sizeBytes, 0);

    return this.updateSessionStatus(
      sessionId,
      'failed',
      {
        activeDurationSeconds: options?.activeDurationSeconds ?? current.activeDurationSeconds,
        totalBytes,
        integrityStatus: 'corrupted',
        aiEligible: false,
        failureReason: failureReason.trim() || 'Recording failed with zero valid segments.',
        endedAt: now,
        recoveryLog: [...current.recoveryLog, `${now}: FAILED — ${failureReason.trim()}`],
      },
      current.matchId
    );
  }

  /**
   * Finalizes a recording session strictly according to FFprobe-verified segment evidence:
   * - ZERO valid verified segments (sizeBytes > 0 and durationSeconds > 0) => status: 'failed', integrityStatus: 'corrupted', aiEligible: false (NEVER 'completed')
   * - Some valid segments + corrupted segments or pipeline error => status: 'partial', integrityStatus: 'partial', aiEligible: true
   * - >= 1 valid segments and zero corrupted segments => status: 'completed', integrityStatus: 'verified', aiEligible: true
   */
  public finalizeSessionManifest(
    sessionId: string,
    options?: {
      activeDurationSeconds?: number;
      integrityStatus?: RecordingIntegrityStatus;
      failureReason?: string | null;
      hadErrors?: boolean;
      matchId?: string;
    }
  ): CaptureManifest | null {
    const current = this.loadSessionManifest(sessionId, options?.matchId);
    if (!current) return null;

    // Idempotent if already in a terminal finalized state
    if (
      current.status === 'completed' ||
      current.status === 'partial' ||
      current.status === 'failed'
    ) {
      return current;
    }

    if (current.status !== 'finalizing') {
      this.updateSessionStatus(sessionId, 'finalizing', undefined, current.matchId);
    }

    const validSegments = current.segments.filter(
      (s) =>
        (s.status === 'finalized' || s.status === 'recovered') &&
        s.integrityStatus === 'verified' &&
        s.sizeBytes > 0 &&
        s.durationSeconds > 0
    );
    const corruptedSegCount = current.segments.filter(
      (s) => s.status === 'corrupted' || s.integrityStatus === 'corrupted'
    ).length;

    const totalValidBytes = validSegments.reduce((sum, s) => sum + s.sizeBytes, 0);
    const verifiedDuration = Math.round(
      validSegments.reduce((sum, s) => sum + s.durationSeconds, 0)
    );
    const totalDuration =
      validSegments.length > 0
        ? Math.max(verifiedDuration, Math.round(options?.activeDurationSeconds ?? 0))
        : 0;

    const now = new Date().toISOString();

    // Critical Phase 2.1 rule: Zero valid verified segments can NEVER be marked 'completed'
    if (validSegments.length === 0) {
      const reason =
        options?.failureReason?.trim() ||
        'Recording produced zero valid video segments (0 verified MP4 bytes).';
      return this.updateSessionStatus(
        sessionId,
        'failed',
        {
          activeDurationSeconds: 0,
          totalBytes: 0,
          integrityStatus: 'corrupted',
          aiEligible: false,
          failureReason: reason,
          endedAt: now,
          recoveryLog: [...current.recoveryLog, `${now}: Finalization FAILED — ${reason}`],
        },
        current.matchId
      );
    }

    const isPartial =
      corruptedSegCount > 0 ||
      Boolean(options?.hadErrors) ||
      options?.integrityStatus === 'partial';

    const finalStatus: CaptureManifest['status'] = isPartial ? 'partial' : 'completed';
    const computedIntegrity: RecordingIntegrityStatus = isPartial ? 'partial' : 'verified';

    return this.updateSessionStatus(
      sessionId,
      finalStatus,
      {
        activeDurationSeconds: totalDuration,
        totalBytes: totalValidBytes,
        integrityStatus: computedIntegrity,
        aiEligible: true,
        failureReason: isPartial ? (options?.failureReason ?? null) : null,
        endedAt: now,
        recoveryLog: isPartial && options?.failureReason
          ? [...current.recoveryLog, `${now}: Finalized PARTIAL — ${options.failureReason}`]
          : current.recoveryLog,
      },
      current.matchId
    );
  }

  /**
   * Safely discards a single recording session and removes ONLY its confined session folder.
   * Never deletes parent match folders, sibling sessions, or unrelated files.
   */
  public discardSession(
    sessionId: string,
    matchId?: string
  ): { discarded: boolean; removedFiles: number; manifest: CaptureManifest | null } {
    const manifestPath = matchId
      ? this.getManifestPath(matchId, sessionId)
      : this.findManifestPathBySessionId(sessionId);
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      return { discarded: false, removedFiles: 0, manifest: null };
    }

    const current = this.loadSessionManifest(sessionId, matchId);
    if (!current) {
      return { discarded: false, removedFiles: 0, manifest: null };
    }

    const sessionDir = path.resolve(current.outputDirectory);
    let removedFiles = 0;

    if (sessionDir.startsWith(this.rootDir + path.sep) && fs.existsSync(sessionDir)) {
      const entries = fs.readdirSync(sessionDir);
      for (const entry of entries) {
        const entryPath = path.resolve(sessionDir, entry);
        if (!entryPath.startsWith(sessionDir + path.sep)) continue;
        // Remove media segments and ffmpeg temp/list artifacts, keep discarded manifest record or clean folder
        if (
          entry.endsWith('.mp4') ||
          entry.endsWith('.tmp') ||
          entry === '.segments.list'
        ) {
          fs.unlinkSync(entryPath);
          removedFiles += 1;
        }
      }
    }

    const discardedManifest: CaptureManifest = {
      ...current,
      status: 'discarded',
      integrityStatus: 'unverified',
      segments: [],
      totalBytes: 0,
      endedAt: current.endedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      recoveryLog: [
        ...current.recoveryLog,
        `${new Date().toISOString()}: Session explicitly discarded (${removedFiles} file(s) removed).`,
      ],
    };

    this.writeManifestAtomic(manifestPath, discardedManifest);
    return { discarded: true, removedFiles, manifest: discardedManifest };
  }

  private collectAllManifestPaths(): string[] {
    const paths: string[] = [];

    if (fs.existsSync(this.rootDir)) {
      const matchDirs = fs.readdirSync(this.rootDir, { withFileTypes: true });
      for (const matchEntry of matchDirs) {
        if (!matchEntry.isDirectory() || matchEntry.name === 'manifests') continue;
        const matchPath = path.join(this.rootDir, matchEntry.name);
        const sessionDirs = fs.readdirSync(matchPath, { withFileTypes: true });
        for (const sessEntry of sessionDirs) {
          if (!sessEntry.isDirectory()) continue;
          const mPath = path.join(matchPath, sessEntry.name, 'manifest.json');
          if (fs.existsSync(mPath)) {
            paths.push(mPath);
          }
        }
      }
    }

    if (fs.existsSync(this.legacyManifestsDir)) {
      const legacyFiles = fs
        .readdirSync(this.legacyManifestsDir)
        .filter((f) => f.endsWith('.json'));
      for (const file of legacyFiles) {
        paths.push(path.join(this.legacyManifestsDir, file));
      }
    }

    return paths;
  }

  public scanRecoverableManifests(activeSessionId?: string | null): RecoverableSessionSummary[] {
    const manifestPaths = this.collectAllManifestPaths();
    const summaries: RecoverableSessionSummary[] = [];

    for (const manifestPath of manifestPaths) {
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<CaptureManifest>;
        if (!raw.sessionId || !raw.matchId) continue;
        if (activeSessionId && raw.sessionId === activeSessionId) continue;

        const manifest = this.normalizeLegacyManifest(raw, manifestPath);
        if (
          manifest.status !== 'recording' &&
          manifest.status !== 'paused' &&
          manifest.status !== 'finalizing'
        ) {
          continue;
        }

        const diskSegments = this.discoverSegmentFilesOnDisk(manifest.outputDirectory);
        let completedFound = 0;
        let partialFound = 0;
        let corruptedFound = 0;
        let totalBytes = 0;
        let estimatedDuration = 0;
        const notes: string[] = [];

        const manifestByIdx = new Map(manifest.segments.map((s) => [s.index, s]));
        for (const diskSeg of diskSegments) {
          totalBytes += diskSeg.sizeBytes;
          const recorded = manifestByIdx.get(diskSeg.index);
          if (diskSeg.sizeBytes === 0) {
            corruptedFound += 1;
            notes.push(`${diskSeg.fileName} is empty (0 bytes).`);
          } else if (recorded?.finalized && recorded.status === 'finalized') {
            completedFound += 1;
            estimatedDuration += recorded.durationSeconds;
          } else {
            partialFound += 1;
            estimatedDuration += recorded?.durationSeconds ?? 0;
            notes.push(`${diskSeg.fileName} was in progress when interrupted (${Math.round(diskSeg.sizeBytes / 1024)} KB).`);
          }
        }

        if (diskSegments.length === 0) {
          notes.push('No MP4 segment files were written to disk before interruption.');
        }

        const recoveryClassification: RecoverableSessionSummary['recoveryClassification'] =
          completedFound > 0 && partialFound === 0 && corruptedFound === 0
            ? 'recoverable'
            : completedFound > 0 || partialFound > 0
              ? 'partially_recoverable'
              : 'corrupted';

        summaries.push({
          sessionId: manifest.sessionId,
          matchId: manifest.matchId,
          half: manifest.half,
          sourceName: manifest.sourceName,
          previousStatus: manifest.status,
          startedAt: manifest.startedAt,
          updatedAt: manifest.updatedAt,
          outputDirectory: manifest.outputDirectory,
          manifestPath,
          completedSegmentsFound: completedFound,
          partialSegmentsFound: partialFound,
          corruptedSegmentsFound: corruptedFound,
          totalBytesOnDisk: totalBytes,
          estimatedDurationSeconds: Math.round(estimatedDuration),
          recoveryClassification,
          notes,
        });
      } catch {
        // Safely ignore corrupted manifest JSON during scan without crashing startup
      }
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public discoverSegmentFilesOnDisk(
    outputDirectory: string
  ): Array<{ index: number; fileName: string; filePath: string; sizeBytes: number; mtimeIso: string }> {
    if (!fs.existsSync(outputDirectory)) return [];
    const entries = fs.readdirSync(outputDirectory);
    const segments: Array<{
      index: number;
      fileName: string;
      filePath: string;
      sizeBytes: number;
      mtimeIso: string;
    }> = [];

    for (const entry of entries) {
      const idx = parseSegmentIndexFromFileName(entry);
      if (idx === null) continue;
      const fullPath = path.join(outputDirectory, entry);
      try {
        const st = fs.statSync(fullPath);
        if (!st.isFile()) continue;
        segments.push({
          index: idx,
          fileName: entry,
          filePath: fullPath,
          sizeBytes: st.size,
          mtimeIso: st.mtime.toISOString(),
        });
      } catch {
        // skip unreadable file
      }
    }

    return segments.sort((a, b) => a.index - b.index);
  }

  /**
   * Executes safe FFprobe-backed crash recovery for an interrupted session.
   * - Validates all completed segments with FFprobe and SHA-256 (never modifying already-valid segments).
   * - Attempts non-destructive remux repair on partial/unfinalized segments.
   * - Marks unrecoverable segments as 'corrupted' and preserves valid segments.
   * - Updates manifest atomically with detailed recoveryLog.
   */
  public async recoverSession(
    sessionId: string,
    ffmpegPath: string | null,
    ffprobePath: string | null
  ): Promise<RecoveryExecutionResult> {
    const manifestPath = this.findManifestPathBySessionId(sessionId);
    if (!manifestPath) {
      throw new Error(`Recoverable session manifest not found: ${sessionId}`);
    }
    const manifest = this.loadSessionManifest(sessionId);
    if (!manifest) {
      throw new Error(`Recoverable session manifest is corrupted and unreadable: ${sessionId}`);
    }

    const diskSegments = this.discoverSegmentFilesOnDisk(manifest.outputDirectory);
    const existingMap = new Map(manifest.segments.map((s) => [s.index, s]));
    const recoveredSegments: CaptureManifestSegment[] = [];
    const corruptedSegments: CaptureManifestSegment[] = [];
    const recoveryLog: string[] = [...manifest.recoveryLog];
    const now = new Date().toISOString();

    recoveryLog.push(`${now}: Starting crash recovery (${diskSegments.length} segment file(s) found on disk).`);

    for (const diskSeg of diskSegments) {
      const existing = existingMap.get(diskSeg.index);
      const probe = await probeMediaFile(ffprobePath, diskSeg.filePath);

      if (probe.valid) {
        const checksum = await computeFileSha256(diskSeg.filePath);
        const segRecord: CaptureManifestSegment = {
          index: diskSeg.index,
          fileName: diskSeg.fileName,
          filePath: diskSeg.filePath,
          startedAt: existing?.startedAt ?? manifest.startedAt,
          endedAt: existing?.endedAt ?? diskSeg.mtimeIso,
          durationSeconds: probe.durationSeconds,
          sizeBytes: probe.sizeBytes,
          checksum,
          resolution: probe.resolution ?? manifest.resolution,
          fps: probe.fps ?? manifest.fps,
          codec: probe.videoCodec ?? manifest.encoder,
          hasAudio: probe.hasAudio,
          finalized: true,
          status: existing?.finalized ? 'finalized' : 'recovered',
          integrityStatus: 'verified',
        };
        recoveredSegments.push(segRecord);
        recoveryLog.push(
          `${now}: Verified ${diskSeg.fileName} (${probe.durationSeconds.toFixed(1)}s, ${probe.resolution ?? 'unknown'}).`
        );
        continue;
      }

      // Attempt non-destructive remux repair on partial/corrupted segment
      const repair = await attemptPartialSegmentRepair(ffmpegPath, ffprobePath, diskSeg.filePath);
      if (repair.repaired && repair.probe.valid) {
        const checksum = await computeFileSha256(diskSeg.filePath);
        const segRecord: CaptureManifestSegment = {
          index: diskSeg.index,
          fileName: diskSeg.fileName,
          filePath: diskSeg.filePath,
          startedAt: existing?.startedAt ?? manifest.startedAt,
          endedAt: diskSeg.mtimeIso,
          durationSeconds: repair.probe.durationSeconds,
          sizeBytes: repair.probe.sizeBytes,
          checksum,
          resolution: repair.probe.resolution ?? manifest.resolution,
          fps: repair.probe.fps ?? manifest.fps,
          codec: repair.probe.videoCodec ?? manifest.encoder,
          hasAudio: repair.probe.hasAudio,
          finalized: true,
          status: 'recovered',
          integrityStatus: 'verified',
        };
        recoveredSegments.push(segRecord);
        recoveryLog.push(`${now}: Repaired ${diskSeg.fileName}: ${repair.note}`);
      } else {
        const segRecord: CaptureManifestSegment = {
          index: diskSeg.index,
          fileName: diskSeg.fileName,
          filePath: diskSeg.filePath,
          startedAt: existing?.startedAt ?? manifest.startedAt,
          endedAt: diskSeg.mtimeIso,
          durationSeconds: 0,
          sizeBytes: diskSeg.sizeBytes,
          checksum: null,
          resolution: existing?.resolution ?? null,
          fps: existing?.fps ?? null,
          codec: existing?.codec ?? null,
          hasAudio: false,
          finalized: false,
          status: 'corrupted',
          integrityStatus: 'corrupted',
        };
        corruptedSegments.push(segRecord);
        recoveryLog.push(`${now}: Unrecoverable ${diskSeg.fileName}: ${repair.note}`);
      }
    }

    const allSegments = [...recoveredSegments, ...corruptedSegments].sort((a, b) => a.index - b.index);
    const totalDurationSeconds = Math.round(
      recoveredSegments.reduce((sum, s) => sum + s.durationSeconds, 0)
    );
    const totalBytes = recoveredSegments.reduce((sum, s) => sum + s.sizeBytes, 0);

    const classification: RecoveryExecutionResult['classification'] =
      recoveredSegments.length > 0 && corruptedSegments.length === 0
        ? 'recovered'
        : recoveredSegments.length > 0
          ? 'partially_recovered'
          : 'corrupted';

    const integrityStatus: RecordingIntegrityStatus =
      classification === 'recovered'
        ? 'verified'
        : classification === 'partially_recovered'
          ? 'partial'
          : 'corrupted';

    const hasRecoveredVideo = recoveredSegments.length > 0;
    const finalStatus: CaptureManifest['status'] = hasRecoveredVideo ? 'recovered' : 'failed';
    const failureReason = hasRecoveredVideo
      ? null
      : 'Crash recovery found zero decodable video segments.';

    const finalManifest: CaptureManifest = {
      ...manifest,
      status: finalStatus,
      integrityStatus,
      aiEligible: hasRecoveredVideo,
      failureReason,
      activeDurationSeconds: totalDurationSeconds,
      totalBytes,
      nextSegmentIndex:
        allSegments.reduce((max, s) => Math.max(max, s.index), 0) + 1,
      segments: allSegments,
      recoveryLog,
      endedAt: manifest.endedAt ?? now,
      updatedAt: now,
    };

    this.writeManifestAtomic(manifestPath, finalManifest);

    return {
      sessionId: finalManifest.sessionId,
      matchId: finalManifest.matchId,
      half: finalManifest.half,
      status: finalStatus === 'recovered' ? 'recovered' : 'failed',
      integrityStatus,
      classification,
      recoveredSegments,
      corruptedSegments,
      totalDurationSeconds,
      totalBytes,
      recoveryLog,
    };
  }
}
