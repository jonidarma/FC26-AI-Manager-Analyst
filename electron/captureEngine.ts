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
  RecordingHalf,
  RecordingIntegrityStatus,
  RecoveryExecutionResult,
} from './captureTypes';
import {
  attemptPartialSegmentRepair,
  computeFileSha256,
  parseSegmentIndexFromFileName,
  probeMediaFile,
} from './ffmpegRecordingService';

const ALLOWED_TRANSITIONS: Record<CaptureManifest['status'], Array<CaptureManifest['status']>> = {
  recording: ['paused', 'finalizing', 'recovered', 'discarded'],
  paused: ['recording', 'finalizing', 'recovered', 'discarded'],
  finalizing: ['completed', 'recovered', 'discarded'],
  completed: ['discarded'],
  recovered: ['discarded'],
  discarded: [],
};

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
    const manifest: CaptureManifest = {
      manifestVersion: 2,
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

    return {
      manifestVersion: raw.manifestVersion ?? 2,
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
        | 'endedAt'
        | 'encoder'
        | 'audioActive'
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

  public finalizeSessionManifest(
    sessionId: string,
    options?: {
      activeDurationSeconds?: number;
      integrityStatus?: RecordingIntegrityStatus;
      matchId?: string;
    }
  ): CaptureManifest | null {
    const current = this.loadSessionManifest(sessionId, options?.matchId);
    if (!current) return null;

    // Idempotent if already completed
    if (current.status === 'completed') {
      return current;
    }

    if (current.status !== 'finalizing') {
      this.updateSessionStatus(sessionId, 'finalizing', undefined, current.matchId);
    }

    const validSegCount = current.segments.filter(
      (s) => s.status === 'finalized' || s.status === 'recovered'
    ).length;
    const corruptedSegCount = current.segments.filter((s) => s.status === 'corrupted').length;

    const computedIntegrity: RecordingIntegrityStatus =
      options?.integrityStatus ??
      (validSegCount === 0
        ? 'corrupted'
        : corruptedSegCount > 0
          ? 'partial'
          : 'verified');

    const totalDuration =
      options?.activeDurationSeconds ??
      Math.round(current.segments.reduce((sum, s) => sum + s.durationSeconds, 0));

    return this.updateSessionStatus(
      sessionId,
      'completed',
      {
        activeDurationSeconds: totalDuration,
        totalBytes: current.segments.reduce((sum, s) => sum + s.sizeBytes, 0),
        integrityStatus: computedIntegrity,
        endedAt: new Date().toISOString(),
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

    const finalManifest: CaptureManifest = {
      ...manifest,
      status: 'recovered',
      integrityStatus,
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
      status: 'recovered',
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
