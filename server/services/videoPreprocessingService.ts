import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveDatabaseLocation } from '../db/database.ts';

const execFileAsync = promisify(execFile);

export interface ServerFfmpegBinaries {
  ffmpegPath: string | null;
  ffprobePath: string | null;
  source: 'env-override' | 'packaged-resource' | 'dev-resource' | 'system-path' | 'missing';
}

export interface ProbedVideoMetadata {
  valid: boolean;
  filePath: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  hasAudio: boolean;
  sha256Hash: string;
  error?: string;
}

export interface PreparedVideoAsset {
  localFilePath: string;
  preparedFilePath: string;
  isTempAsset: boolean;
  metadata: ProbedVideoMetadata;
  downscaled: boolean;
}

export function resolveServerFfmpegBinaries(): ServerFfmpegBinaries {
  const isWin = process.platform === 'win32';
  const ffmpegBin = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const ffprobeBin = isWin ? 'ffprobe.exe' : 'ffprobe';

  const envFfmpeg = process.env.FC26_FFMPEG_PATH?.trim();
  const envFfprobe = process.env.FC26_FFPROBE_PATH?.trim();
  if (envFfmpeg && fs.existsSync(envFfmpeg)) {
    const derivedProbe =
      envFfprobe && fs.existsSync(envFfprobe)
        ? envFfprobe
        : path.join(path.dirname(envFfmpeg), ffprobeBin);
    return {
      ffmpegPath: envFfmpeg,
      ffprobePath: fs.existsSync(derivedProbe) ? derivedProbe : null,
      source: 'env-override',
    };
  }

  const resourcesDir = process.env.FC26_RESOURCES_DIR?.trim();
  if (resourcesDir) {
    const resFfmpeg = path.join(resourcesDir, 'bin', ffmpegBin);
    const resFfprobe = path.join(resourcesDir, 'bin', ffprobeBin);
    if (fs.existsSync(resFfmpeg)) {
      return {
        ffmpegPath: resFfmpeg,
        ffprobePath: fs.existsSync(resFfprobe) ? resFfprobe : null,
        source: 'packaged-resource',
      };
    }
  }

  const devFfmpeg = path.resolve(process.cwd(), 'resources', 'bin', ffmpegBin);
  const devFfprobe = path.resolve(process.cwd(), 'resources', 'bin', ffprobeBin);
  if (fs.existsSync(devFfmpeg)) {
    return {
      ffmpegPath: devFfmpeg,
      ffprobePath: fs.existsSync(devFfprobe) ? devFfprobe : null,
      source: 'dev-resource',
    };
  }

  // Fallback to system PATH
  const systemCandidates = isWin
    ? [ffmpegBin]
    : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
  for (const cand of systemCandidates) {
    if (cand.includes(path.sep) && !fs.existsSync(cand)) continue;
    const probeCand = cand.includes(path.sep)
      ? path.join(path.dirname(cand), ffprobeBin)
      : ffprobeBin;
    return {
      ffmpegPath: cand,
      ffprobePath: probeCand,
      source: 'system-path',
    };
  }

  return {
    ffmpegPath: null,
    ffprobePath: null,
    source: 'missing',
  };
}

export function getAllowedMediaRoots(extraAllowedDirs: string[] = []): string[] {
  const { dataDir } = resolveDatabaseLocation();
  const roots = [
    dataDir,
    path.join(dataDir, 'recordings'),
    path.join(dataDir, 'evidence_frames'),
    path.join(dataDir, 'analysis_temp'),
    path.join(dataDir, 'test_clips'),
    path.join(os.homedir(), 'Documents', 'FC26_AI_Manager'),
    ...extraAllowedDirs,
  ];
  return Array.from(new Set(roots.map((r) => path.resolve(r))));
}

/**
 * Strictly confines media file paths to approved application directories, rejecting
 * path traversal (`..`), null bytes, and arbitrary filesystem reads.
 */
export function assertConfinedMediaPath(
  candidatePath: string,
  allowedBaseDirs?: string[]
): string {
  if (!candidatePath || candidatePath.includes('\0')) {
    throw new Error('Invalid media path: empty or contains null byte.');
  }
  const resolved = path.resolve(candidatePath);
  const roots = allowedBaseDirs && allowedBaseDirs.length > 0
    ? allowedBaseDirs.map((d) => path.resolve(d))
    : getAllowedMediaRoots();

  const allowed = roots.some((root) => {
    const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
    return resolved === root || resolved.startsWith(normalizedRoot);
  });

  if (!allowed) {
    throw new Error(
      `Security block: media path "${path.basename(resolved)}" lies outside approved application recording/data directories.`
    );
  }
  return resolved;
}

export function getEvidenceFramesDir(matchId: string): string {
  const safeMatchId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeMatchId) {
    throw new Error('Invalid matchId for evidence frames directory.');
  }
  const { dataDir } = resolveDatabaseLocation();
  const dir = path.join(dataDir, 'evidence_frames', safeMatchId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getAnalysisTempDir(jobId: string): string {
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
  const { dataDir } = resolveDatabaseLocation();
  const dir = path.join(dataDir, 'analysis_temp', safeJobId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getTestClipsDir(matchId: string): string {
  const safeMatchId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  const { dataDir } = resolveDatabaseLocation();
  const dir = path.join(dataDir, 'test_clips', safeMatchId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const parts = raw.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (den > 0 && Number.isFinite(num / den)) {
      return Number((num / den).toFixed(2));
    }
  }
  const single = Number(raw);
  return Number.isFinite(single) && single > 0 ? Number(single.toFixed(2)) : null;
}

export async function validateVideoFile(
  filePath: string,
  allowedBaseDirs?: string[]
): Promise<ProbedVideoMetadata> {
  let confinedPath: string;
  try {
    confinedPath = assertConfinedMediaPath(filePath, allowedBaseDirs);
  } catch (err) {
    return {
      valid: false,
      filePath,
      sizeBytes: 0,
      durationSeconds: 0,
      width: null,
      height: null,
      fps: null,
      codec: null,
      hasAudio: false,
      sha256Hash: '',
      error: err instanceof Error ? err.message : 'Path confinement error.',
    };
  }

  if (!fs.existsSync(confinedPath)) {
    return {
      valid: false,
      filePath: confinedPath,
      sizeBytes: 0,
      durationSeconds: 0,
      width: null,
      height: null,
      fps: null,
      codec: null,
      hasAudio: false,
      sha256Hash: '',
      error: `Recording file not found on disk: ${path.basename(confinedPath)}`,
    };
  }

  const stat = fs.statSync(confinedPath);
  if (!stat.isFile() || stat.size <= 0) {
    return {
      valid: false,
      filePath: confinedPath,
      sizeBytes: stat.size,
      durationSeconds: 0,
      width: null,
      height: null,
      fps: null,
      codec: null,
      hasAudio: false,
      sha256Hash: '',
      error: 'Recording file is empty (0 bytes) and cannot be analyzed.',
    };
  }

  const bins = resolveServerFfmpegBinaries();
  if (!bins.ffprobePath) {
    return {
      valid: false,
      filePath: confinedPath,
      sizeBytes: stat.size,
      durationSeconds: 0,
      width: null,
      height: null,
      fps: null,
      codec: null,
      hasAudio: false,
      sha256Hash: '',
      error: 'FFprobe binary is unavailable; cannot verify video integrity.',
    };
  }

  try {
    const { stdout } = await execFileAsync(
      bins.ffprobePath,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', confinedPath],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }
    );

    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; size?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        r_frame_rate?: string;
        duration?: string;
      }>;
    };

    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');

    if (!videoStream) {
      return {
        valid: false,
        filePath: confinedPath,
        sizeBytes: stat.size,
        durationSeconds: 0,
        width: null,
        height: null,
        fps: null,
        codec: null,
        hasAudio: Boolean(audioStream),
        sha256Hash: '',
        error: 'Media file contains no decodable video stream.',
      };
    }

    const durationRaw = Number(parsed.format?.duration ?? videoStream.duration ?? 0);
    const durationSeconds = Number.isFinite(durationRaw) && durationRaw > 0 ? Number(durationRaw.toFixed(2)) : 0;

    if (durationSeconds <= 0) {
      return {
        valid: false,
        filePath: confinedPath,
        sizeBytes: stat.size,
        durationSeconds: 0,
        width: videoStream.width ?? null,
        height: videoStream.height ?? null,
        fps: parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
        codec: videoStream.codec_name ?? null,
        hasAudio: Boolean(audioStream),
        sha256Hash: '',
        error: 'Video duration is 0 seconds or unreadable.',
      };
    }

    const sha256Hash = await computeFileSha256(confinedPath);

    return {
      valid: true,
      filePath: confinedPath,
      sizeBytes: stat.size,
      durationSeconds,
      width: videoStream.width ?? null,
      height: videoStream.height ?? null,
      fps: parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
      codec: videoStream.codec_name ?? null,
      hasAudio: Boolean(audioStream),
      sha256Hash,
    };
  } catch (err) {
    return {
      valid: false,
      filePath: confinedPath,
      sizeBytes: stat.size,
      durationSeconds: 0,
      width: null,
      height: null,
      fps: null,
      codec: null,
      hasAudio: false,
      sha256Hash: '',
      error: `FFprobe validation failed (corrupted or unsupported media): ${err instanceof Error ? err.message.slice(0, 180) : String(err)}`,
    };
  }
}

export async function prepareAnalysisVideoAsset(input: {
  jobId: string;
  filePath: string;
  downscale: boolean;
  allowedBaseDirs?: string[];
}): Promise<PreparedVideoAsset> {
  const metadata = await validateVideoFile(input.filePath, input.allowedBaseDirs);
  if (!metadata.valid) {
    throw new Error(metadata.error ?? 'Video validation failed.');
  }

  const bins = resolveServerFfmpegBinaries();
  const shouldDownscale =
    input.downscale &&
    Boolean(bins.ffmpegPath) &&
    ((metadata.width ?? 0) > 1280 || (metadata.height ?? 0) > 720);

  if (!shouldDownscale || !bins.ffmpegPath) {
    return {
      localFilePath: metadata.filePath,
      preparedFilePath: metadata.filePath,
      isTempAsset: false,
      metadata,
      downscaled: false,
    };
  }

  // Create a temporary downscaled copy without modifying the original recorded MP4
  const tempDir = getAnalysisTempDir(input.jobId);
  const outName = `analysis_${crypto.randomUUID().slice(0, 8)}.mp4`;
  const tempOutPath = path.join(tempDir, outName);

  await execFileAsync(
    bins.ffmpegPath,
    [
      '-y',
      '-i',
      metadata.filePath,
      '-vf',
      'scale=min(1280\\,iw):-2',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-an',
      '-movflags',
      '+faststart',
      tempOutPath,
    ],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }
  );

  const downscaledMeta = await validateVideoFile(tempOutPath, [tempDir]);
  if (!downscaledMeta.valid) {
    try {
      fs.unlinkSync(tempOutPath);
    } catch {
      // ignore cleanup error
    }
    return {
      localFilePath: metadata.filePath,
      preparedFilePath: metadata.filePath,
      isTempAsset: false,
      metadata,
      downscaled: false,
    };
  }

  return {
    localFilePath: metadata.filePath,
    preparedFilePath: tempOutPath,
    isTempAsset: true,
    metadata: downscaledMeta,
    downscaled: true,
  };
}

export async function extractEvidenceFrame(input: {
  matchId: string;
  videoFilePath: string;
  timestampSeconds: number;
  labelSlug: string;
  allowedBaseDirs?: string[];
}): Promise<string | null> {
  const bins = resolveServerFfmpegBinaries();
  if (!bins.ffmpegPath) return null;

  let confinedVideo: string;
  try {
    confinedVideo = assertConfinedMediaPath(input.videoFilePath, input.allowedBaseDirs);
  } catch {
    return null;
  }

  if (!fs.existsSync(confinedVideo)) return null;

  const framesDir = getEvidenceFramesDir(input.matchId);
  const safeSlug = input.labelSlug.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28) || 'ev';
  const fileName = `frame_${safeSlug}_${Math.max(0, Math.round(input.timestampSeconds * 10))}.jpg`;
  const outPath = path.join(framesDir, fileName);

  try {
    await execFileAsync(
      bins.ffmpegPath,
      [
        '-y',
        '-ss',
        String(Math.max(0, Number(input.timestampSeconds.toFixed(2)))),
        '-i',
        confinedVideo,
        '-frames:v',
        '1',
        '-q:v',
        '4',
        '-vf',
        'scale=min(960\\,iw):-2',
        outPath,
      ],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }
    );

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      return fileName;
    }
    return null;
  } catch {
    return null;
  }
}

export function cleanupTempAnalysisDir(jobId: string): void {
  try {
    const { dataDir } = resolveDatabaseLocation();
    const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeJobId) return;
    const tempDir = path.join(dataDir, 'analysis_temp', safeJobId);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    // non-fatal cleanup failure
  }
}
