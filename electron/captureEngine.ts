import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface CaptureManifest {
  sessionId: string;
  matchId: string;
  half: 'first_half' | 'second_half';
  sourceId: string;
  sourceName: string;
  resolution: string;
  fps: number;
  segmentDurationMinutes: number;
  status: 'recording' | 'paused' | 'finalizing' | 'completed' | 'recovered' | 'discarded';
  segments: Array<{
    index: number;
    filePath: string;
    sizeBytes: number;
    finalized: boolean;
  }>;
  startedAt: string;
  updatedAt: string;
}

/**
 * Phase 1/2 Desktop Capture Session Manager.
 * Persists crash-safe JSON manifests for 2-5 minute segmented recordings so
 * unexpected shutdowns or FC26 crashes never silently destroy recorded halves.
 */
export class CaptureSessionEngine {
  private readonly rootDir: string;
  private readonly manifestsDir: string;

  constructor(baseStorageDir: string) {
    this.rootDir = path.resolve(baseStorageDir);
    this.manifestsDir = path.join(this.rootDir, 'manifests');
    fs.mkdirSync(this.manifestsDir, { recursive: true });
  }

  private getSafeManifestPath(sessionId: string): string {
    const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    const resolved = path.resolve(this.manifestsDir, `${sanitized}.json`);
    if (!resolved.startsWith(this.manifestsDir + path.sep)) {
      throw new Error('Invalid session identifier path.');
    }
    return resolved;
  }

  public createSessionManifest(input: {
    matchId: string;
    half: 'first_half' | 'second_half';
    sourceId: string;
    sourceName: string;
    resolution: string;
    fps: number;
    segmentDurationMinutes: number;
  }): CaptureManifest {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    const matchDir = path.resolve(this.rootDir, 'recordings', input.matchId.replace(/[^a-zA-Z0-9_-]/g, ''));
    if (!matchDir.startsWith(this.rootDir + path.sep)) {
      throw new Error('Invalid match directory.');
    }
    fs.mkdirSync(matchDir, { recursive: true });

    const manifest: CaptureManifest = {
      sessionId,
      matchId: input.matchId,
      half: input.half,
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      resolution: input.resolution,
      fps: input.fps,
      segmentDurationMinutes: Math.max(2, Math.min(5, input.segmentDurationMinutes)),
      status: 'recording',
      segments: [],
      startedAt: now,
      updatedAt: now,
    };

    fs.writeFileSync(this.getSafeManifestPath(sessionId), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }

  public finalizeSessionManifest(sessionId: string): CaptureManifest | null {
    const manifestPath = this.getSafeManifestPath(sessionId);
    if (!fs.existsSync(manifestPath)) return null;

    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as CaptureManifest;
    manifest.status = 'completed';
    manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }

  public scanRecoverableManifests(): CaptureManifest[] {
    if (!fs.existsSync(this.manifestsDir)) return [];
    const files = fs.readdirSync(this.manifestsDir).filter((f) => f.endsWith('.json'));
    const recoverable: CaptureManifest[] = [];

    for (const file of files) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(this.manifestsDir, file), 'utf8')
        ) as CaptureManifest;
        if (parsed.status === 'recording' || parsed.status === 'paused') {
          recoverable.push(parsed);
        }
      } catch {
        // Ignore malformed manifests safely
      }
    }

    return recoverable;
  }
}
