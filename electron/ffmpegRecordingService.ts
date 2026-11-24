/**
 * FC26 AI Manager — Phase 2 FFmpeg & FFprobe Recording Service
 *
 * Responsibilities:
 * - Resolve FFmpeg and FFprobe binaries safely (packaged resources only when app.isPackaged === true)
 * - Probe runtime capabilities (version, WebM/Matroska input, verified H.264 encoders, AAC, writable dir)
 * - Build strictly validated argument arrays (NEVER shell: true)
 * - Manage bounded-queue backpressure stdin streaming from binary IPC chunks to FFmpeg
 * - Produce crash-resilient fragmented MP4 segments (2–5 min) with .segments.list completion tracking
 * - Validate recorded MP4 segments via FFprobe and compute SHA-256 checksums
 * - Attempt safe, non-destructive remux repair on partial segments during crash recovery
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CaptureEngineCapabilities,
  CapturePrerequisiteCheck,
  MediaProbeResult,
} from './captureTypes';

export interface FfmpegBinaryResolution {
  ffmpegPath: string | null;
  ffprobePath: string | null;
  source: CaptureEngineCapabilities['ffmpegPathSource'];
  searchedPaths: string[];
}

export interface FfmpegSegmentConfig {
  ffmpegPath: string;
  encoder: 'libx264' | 'h264_mf';
  inputFormat: 'webm' | 'matroska';
  resolution: '1280x720' | '1920x1080';
  fps: number;
  bitrateKbps: number;
  audioEnabled: boolean;
  segmentDurationSeconds: number;
  startSegmentIndex: number;
  outputDirectory: string;
  segmentListPath: string;
}

export interface FfmpegProgressSnapshot {
  fps: number | null;
  bitrateKbps: number | null;
  encodedSeconds: number | null;
  lastLine: string;
}

export interface FfmpegQueueMetrics {
  queuedChunks: number;
  queuedBytes: number;
  backpressureActive: boolean;
  backpressureEvents: number;
  chunksEnqueued: number;
  bytesEnqueued: number;
  totalBytesWritten: number;
  droppedChunks: number;
  lastChunkEnqueuedAt: string | null;
  currentOutputFileBytes: number;
  lastError: string | null;
  stderrTail: string[];
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  spawnedArgs: string[];
}

export interface FfmpegProcessEvents {
  onSegmentFinalized?: (segmentFileName: string, segmentFilePath: string, segmentIndex: number) => void;
  onActiveSegmentChanged?: (segmentIndex: number) => void;
  onProgress?: (progress: FfmpegProgressSnapshot) => void;
  onQueueChange?: (metrics: FfmpegQueueMetrics) => void;
  onError?: (errorMessage: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string) => void;
}

const MAX_QUEUE_BYTES = 64 * 1024 * 1024; // 64 MB hard cap to avoid unbounded memory growth
const HIGH_WATER_BYTES = 24 * 1024 * 1024; // 24 MB triggers backpressure
const LOW_WATER_BYTES = 8 * 1024 * 1024; // 8 MB releases backpressure
const MAX_QUEUE_CHUNKS = 256;
const HIGH_WATER_CHUNKS = 64;
const LOW_WATER_CHUNKS = 16;

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs = 8000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as NodeJS.ErrnoException & { code?: number | string }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode,
        });
      }
    );
  });
}

function isExecutableFile(candidatePath: string): boolean {
  try {
    const stat = fs.statSync(candidatePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function findInSystemPath(binaryName: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, binaryName);
    if (isExecutableFile(full)) {
      return full;
    }
  }
  return null;
}

/**
 * Resolves FFmpeg & FFprobe binary paths.
 * Security & Reliability Rule:
 * - In packaged production builds (isPackaged === true), ONLY resolve from
 *   process.resourcesPath/ffmpeg. Never silently fall back to arbitrary PATH binaries.
 * - In development/testing (isPackaged === false), check repo resources/ffmpeg/<platform>-<arch>,
 *   optional dev/test env override (FC26_FFMPEG_PATH / FC26_FFPROBE_PATH), and then system PATH.
 */
export function resolveFfmpegBinaries(options: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): FfmpegBinaryResolution {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const ext = platform === 'win32' ? '.exe' : '';
  const ffmpegBin = `ffmpeg${ext}`;
  const ffprobeBin = `ffprobe${ext}`;
  const searchedPaths: string[] = [];

  if (options.isPackaged) {
    const resBase = options.resourcesPath ?? '';
    const packagedDir = path.join(resBase, 'ffmpeg');
    const ffmpegCandidate = path.join(packagedDir, ffmpegBin);
    const ffprobeCandidate = path.join(packagedDir, ffprobeBin);
    searchedPaths.push(ffmpegCandidate);

    return {
      ffmpegPath: isExecutableFile(ffmpegCandidate) ? ffmpegCandidate : null,
      ffprobePath: isExecutableFile(ffprobeCandidate) ? ffprobeCandidate : null,
      source: isExecutableFile(ffmpegCandidate) ? 'packaged-resource' : 'missing',
      searchedPaths,
    };
  }

  // 1. Development env override (strictly non-packaged)
  const envFfmpeg = process.env.FC26_FFMPEG_PATH?.trim();
  const envFfprobe = process.env.FC26_FFPROBE_PATH?.trim();
  if (envFfmpeg) {
    searchedPaths.push(envFfmpeg);
    if (isExecutableFile(envFfmpeg)) {
      const siblingProbe = path.join(path.dirname(envFfmpeg), ffprobeBin);
      const resolvedProbe =
        envFfprobe && isExecutableFile(envFfprobe)
          ? envFfprobe
          : isExecutableFile(siblingProbe)
            ? siblingProbe
            : findInSystemPath(ffprobeBin);
      return {
        ffmpegPath: envFfmpeg,
        ffprobePath: resolvedProbe,
        source: 'env-override',
        searchedPaths,
      };
    }
  }

  // 2. Local project resources/ffmpeg/<platform>-<arch>
  const platformFolder =
    platform === 'win32'
      ? `win-${arch}`
      : platform === 'darwin'
        ? `darwin-${arch}`
        : `linux-${arch}`;
  const devDir = path.join(options.appPath, 'resources', 'ffmpeg', platformFolder);
  const devFfmpeg = path.join(devDir, ffmpegBin);
  const devFfprobe = path.join(devDir, ffprobeBin);
  searchedPaths.push(devFfmpeg);
  if (isExecutableFile(devFfmpeg)) {
    return {
      ffmpegPath: devFfmpeg,
      ffprobePath: isExecutableFile(devFfprobe) ? devFfprobe : findInSystemPath(ffprobeBin),
      source: 'dev-resource',
      searchedPaths,
    };
  }

  // 3. System PATH (development & CI testing only)
  const sysFfmpeg = findInSystemPath(ffmpegBin);
  const sysFfprobe = findInSystemPath(ffprobeBin);
  searchedPaths.push(`PATH:${ffmpegBin}`);
  if (sysFfmpeg) {
    return {
      ffmpegPath: sysFfmpeg,
      ffprobePath: sysFfprobe,
      source: 'system-path',
      searchedPaths,
    };
  }

  return {
    ffmpegPath: null,
    ffprobePath: null,
    source: 'missing',
    searchedPaths,
  };
}

export function testDirectoryWritable(dirPath: string): { writable: boolean; error?: string } {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probeFile = path.join(dirPath, `.write_probe_${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(probeFile, 'ok', 'utf8');
    fs.unlinkSync(probeFile);
    return { writable: true };
  } catch (err) {
    return {
      writable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testEncoderWorks(ffmpegPath: string, encoder: 'libx264' | 'h264_mf'): Promise<boolean> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=160x90:r=10:d=0.2',
    '-frames:v',
    '2',
    '-c:v',
    encoder,
    '-pix_fmt',
    'yuv420p',
    '-f',
    'null',
    '-',
  ];
  const res = await execFileAsync(ffmpegPath, args, 6000);
  return res.exitCode === 0;
}

/**
 * Evaluates all 8 runtime prerequisites for Phase 2 local FFmpeg recording.
 * Never claims localFfmpegRecording = true unless every prerequisite passes.
 */
export async function probeFfmpegCapabilities(options: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath?: string;
  recordingsRootDir: string;
  transportReady: boolean;
  ipcHandlersReady: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<{
  ready: boolean;
  binaries: FfmpegBinaryResolution;
  capabilities: CaptureEngineCapabilities;
}> {
  const platform = options.platform ?? process.platform;
  const supportedPlatform = platform === 'win32' || platform === 'linux' || platform === 'darwin';
  const binaries = resolveFfmpegBinaries({
    isPackaged: options.isPackaged,
    appPath: options.appPath,
    resourcesPath: options.resourcesPath,
    platform,
    arch: options.arch,
  });

  let ffmpegVersion: string | null = null;
  let ffmpegExecOk = false;
  let ffprobeExecOk = false;
  const supportedInputFormats: string[] = [];
  const h264Encoders: string[] = [];
  let preferredEncoder: 'libx264' | 'h264_mf' | null = null;
  let aacAudioAvailable = false;
  let licenseNotice =
    'FFmpeg license depends on the active binary build. Check docs/FFMPEG_LICENSING_AND_PACKAGING.md for bundled Windows x64 licensing details.';

  if (binaries.ffmpegPath) {
    const versionRes = await execFileAsync(binaries.ffmpegPath, ['-version'], 5000);
    if (versionRes.exitCode === 0 && versionRes.stdout) {
      ffmpegExecOk = true;
      const firstLine = versionRes.stdout.split(/\r?\n/)[0]?.trim() ?? '';
      ffmpegVersion = firstLine || 'FFmpeg detected';
      if (versionRes.stdout.includes('--enable-gpl')) {
        licenseNotice =
          'Detected GPL FFmpeg build (includes libx264). Distribute with GPLv3 source offer & license notice per docs/FFMPEG_LICENSING_AND_PACKAGING.md.';
      } else {
        licenseNotice =
          'Detected LGPL-compatible FFmpeg build. Verify hardware/system H.264 encoder availability and retain FFmpeg LGPL notices.';
      }
    }

    if (ffmpegExecOk) {
      const [demuxersRes, encodersRes] = await Promise.all([
        execFileAsync(binaries.ffmpegPath, ['-hide_banner', '-demuxers'], 5000),
        execFileAsync(binaries.ffmpegPath, ['-hide_banner', '-encoders'], 5000),
      ]);

      const demuxText = demuxersRes.stdout.toLowerCase();
      if (demuxText.includes('matroska') || demuxText.includes('webm')) {
        supportedInputFormats.push('webm', 'matroska');
      }

      const encText = encodersRes.stdout;
      const hasLibx264Listed = /\blibx264\b/.test(encText);
      const hasH264MfListed = /\bh264_mf\b/.test(encText);
      aacAudioAvailable = /\baac\b/.test(encText);

      // Prefer verified libx264 for deterministic cross-GPU stability; validate h264_mf via real probe before accepting
      if (hasLibx264Listed) {
        const works = await testEncoderWorks(binaries.ffmpegPath, 'libx264');
        if (works) {
          h264Encoders.push('libx264');
          preferredEncoder = 'libx264';
        }
      }
      if (hasH264MfListed) {
        const works = await testEncoderWorks(binaries.ffmpegPath, 'h264_mf');
        if (works) {
          h264Encoders.push('h264_mf');
          if (!preferredEncoder) {
            preferredEncoder = 'h264_mf';
          }
        }
      }
    }
  }

  if (binaries.ffprobePath) {
    const probeRes = await execFileAsync(binaries.ffprobePath, ['-version'], 5000);
    ffprobeExecOk = probeRes.exitCode === 0;
  }

  const dirCheck = testDirectoryWritable(options.recordingsRootDir);

  const prerequisites: CapturePrerequisiteCheck[] = [
    {
      key: 'platform',
      label: 'Supported Desktop Platform',
      ok: supportedPlatform,
      detail: supportedPlatform
        ? `Platform "${platform}" supported (primary target: Windows 10/11 x64).`
        : `Unsupported platform "${platform}".`,
    },
    {
      key: 'ffmpeg_binary',
      label: 'FFmpeg Binary Present',
      ok: Boolean(binaries.ffmpegPath),
      detail: binaries.ffmpegPath
        ? `Resolved (${binaries.source}): ${binaries.ffmpegPath}`
        : options.isPackaged
          ? `Bundled FFmpeg binary missing from ${path.join(options.resourcesPath ?? '', 'ffmpeg')}. Run prepare:ffmpeg:win64 before packaging.`
          : `FFmpeg not found. Searched: ${binaries.searchedPaths.join(', ')}`,
    },
    {
      key: 'ffmpeg_exec',
      label: 'FFmpeg Executable Verified',
      ok: ffmpegExecOk,
      detail: ffmpegExecOk
        ? ffmpegVersion ?? 'FFmpeg responded cleanly to -version.'
        : 'FFmpeg failed to execute -version check.',
    },
    {
      key: 'input_format',
      label: 'WebM/Matroska Input Demuxer',
      ok: supportedInputFormats.includes('webm'),
      detail: supportedInputFormats.includes('webm')
        ? `Supported demuxers: ${supportedInputFormats.join(', ')}`
        : 'FFmpeg build lacks WebM/Matroska demuxer required for MediaRecorder pipe.',
    },
    {
      key: 'h264_encoder',
      label: 'Verified H.264 MP4 Encoder',
      ok: Boolean(preferredEncoder),
      detail: preferredEncoder
        ? `Active encoder: ${preferredEncoder} (verified: ${h264Encoders.join(', ')})`
        : 'No working H.264 encoder (libx264 or h264_mf) passed verification probe.',
    },
    {
      key: 'transport_ready',
      label: 'Binary IPC Media Transport',
      ok: options.transportReady,
      detail: options.transportReady
        ? 'MessageChannelMain binary ArrayBuffer transport registered.'
        : 'Binary capture transport has not been initialized.',
    },
    {
      key: 'storage_writable',
      label: 'Recordings Directory Writable',
      ok: dirCheck.writable,
      detail: dirCheck.writable
        ? `Verified writable: ${options.recordingsRootDir}`
        : `Cannot write to ${options.recordingsRootDir}: ${dirCheck.error ?? 'permission denied'}`,
    },
    {
      key: 'ipc_handlers',
      label: 'Capture Lifecycle IPC Handlers',
      ok: options.ipcHandlersReady,
      detail: options.ipcHandlersReady
        ? 'Main process start/pause/resume/stop/recover IPC handlers active.'
        : 'Capture IPC handlers are not registered.',
    },
  ];

  const failedPrereq = prerequisites.find((p) => !p.ok) ?? null;
  const ready = failedPrereq === null;

  return {
    ready,
    binaries,
    capabilities: {
      ffmpegAvailable: ffmpegExecOk,
      ffprobeAvailable: ffprobeExecOk,
      ffmpegVersion,
      ffmpegPathSource: binaries.source,
      h264Encoders,
      preferredEncoder,
      supportedInputFormats,
      aacAudioAvailable,
      recordingsRootDir: options.recordingsRootDir,
      recordingsDirWritable: dirCheck.writable,
      transportReady: options.transportReady,
      ipcHandlersReady: options.ipcHandlersReady,
      prerequisites,
      blockingReason: failedPrereq ? `${failedPrereq.label}: ${failedPrereq.detail}` : null,
      licenseNotice,
    },
  };
}

/**
 * Builds a validated FFmpeg argument array (no shell interpolation).
 * Produces crash-resilient fragmented MP4 segments preserving aspect ratio with even yuv420p dimensions.
 */
export function buildFfmpegSegmentArgs(config: FfmpegSegmentConfig): string[] {
  const [rawW, rawH] = config.resolution === '1920x1080' ? [1920, 1080] : [1280, 720];
  const fps = Math.max(10, Math.min(60, Math.round(config.fps)));
  const bitrateKbps = Math.max(800, Math.min(12000, Math.round(config.bitrateKbps)));
  const maxrateKbps = Math.round(bitrateKbps * 1.25);
  const bufsizeKbps = bitrateKbps * 2;
  const segmentSeconds = Math.max(2, Math.min(600, Math.round(config.segmentDurationSeconds)));
  const startNumber = Math.max(1, Math.min(999, Math.round(config.startSegmentIndex)));
  const gopSize = Math.max(fps, fps * 2);

  // Preserve aspect ratio without distortion, then guarantee even width & height required by yuv420p
  const scaleFilter = `scale='min(${rawW},iw)':'min(${rawH},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  const outputPattern = path.join(config.outputDirectory, 'segment_%03d.mp4');

  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'info',
    '-fflags',
    '+genpts',
    '-f',
    config.inputFormat,
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
  ];

  if (config.audioEnabled) {
    args.push('-map', '0:a:0?');
  }

  args.push('-vf', scaleFilter, '-r', String(fps));

  if (config.encoder === 'libx264') {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      `${bitrateKbps}k`,
      '-maxrate',
      `${maxrateKbps}k`,
      '-bufsize',
      `${bufsizeKbps}k`,
      '-g',
      String(gopSize),
      '-keyint_min',
      String(fps),
      '-sc_threshold',
      '0',
      '-force_key_frames',
      `expr:gte(t,n_forced*${segmentSeconds})`
    );
  } else {
    args.push(
      '-c:v',
      'h264_mf',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      `${bitrateKbps}k`,
      '-g',
      String(gopSize),
      '-force_key_frames',
      `expr:gte(t,n_forced*${segmentSeconds})`
    );
  }

  if (config.audioEnabled) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000');
  } else {
    args.push('-an');
  }

  args.push(
    '-f',
    'segment',
    '-segment_time',
    String(segmentSeconds),
    '-segment_start_number',
    String(startNumber),
    '-reset_timestamps',
    '1',
    '-segment_format',
    'mp4',
    '-segment_format_options',
    'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-segment_list',
    config.segmentListPath,
    '-segment_list_type',
    'flat',
    outputPattern
  );

  return args;
}

export function parseSegmentIndexFromFileName(fileName: string): number | null {
  const match = /^segment_(\d+)\.mp4$/i.exec(path.basename(fileName));
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseFrameRate(raw: string | undefined): number | null {
  if (!raw || raw === '0/0') return null;
  if (raw.includes('/')) {
    const [numStr, denStr] = raw.split('/');
    const num = Number(numStr);
    const den = Number(denStr);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Math.round((num / den) * 100) / 100;
    }
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Probes an MP4 file using FFprobe to verify decodable container, duration, video stream, and audio stream.
 */
export async function probeMediaFile(
  ffprobePath: string | null,
  filePath: string
): Promise<MediaProbeResult> {
  let sizeBytes = 0;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0) {
      return {
        valid: false,
        filePath,
        sizeBytes: 0,
        durationSeconds: 0,
        width: null,
        height: null,
        resolution: null,
        fps: null,
        videoCodec: null,
        hasVideo: false,
        hasAudio: false,
        audioCodec: null,
        error: 'File is empty or missing.',
      };
    }
    sizeBytes = st.size;
  } catch (err) {
    return {
      valid: false,
      filePath,
      sizeBytes: 0,
      durationSeconds: 0,
      width: null,
      height: null,
      resolution: null,
      fps: null,
      videoCodec: null,
      hasVideo: false,
      hasAudio: false,
      audioCodec: null,
      error: err instanceof Error ? err.message : 'File stat failed.',
    };
  }

  if (!ffprobePath) {
    return {
      valid: false,
      filePath,
      sizeBytes,
      durationSeconds: 0,
      width: null,
      height: null,
      resolution: null,
      fps: null,
      videoCodec: null,
      hasVideo: false,
      hasAudio: false,
      audioCodec: null,
      error: 'FFprobe binary unavailable for media verification.',
    };
  }

  const res = await execFileAsync(
    ffprobePath,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    8000
  );

  if (res.exitCode !== 0 || !res.stdout.trim()) {
    return {
      valid: false,
      filePath,
      sizeBytes,
      durationSeconds: 0,
      width: null,
      height: null,
      resolution: null,
      fps: null,
      videoCodec: null,
      hasVideo: false,
      hasAudio: false,
      audioCodec: null,
      error: res.stderr.trim() || 'FFprobe failed to parse media file.',
    };
  }

  try {
    const parsed = JSON.parse(res.stdout) as {
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

    const streams = parsed.streams ?? [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');

    const rawDuration =
      Number(parsed.format?.duration ?? videoStream?.duration ?? 0);
    const durationSeconds =
      Number.isFinite(rawDuration) && rawDuration > 0
        ? Math.round(rawDuration * 100) / 100
        : 0;

    const width = typeof videoStream?.width === 'number' ? videoStream.width : null;
    const height = typeof videoStream?.height === 'number' ? videoStream.height : null;
    const resolution = width && height ? `${width}x${height}` : null;
    const fps = parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate);
    const hasVideo = Boolean(videoStream && width && height);
    const valid = hasVideo && durationSeconds > 0;

    return {
      valid,
      filePath,
      sizeBytes,
      durationSeconds,
      width,
      height,
      resolution,
      fps,
      videoCodec: videoStream?.codec_name ?? null,
      hasVideo,
      hasAudio: Boolean(audioStream),
      audioCodec: audioStream?.codec_name ?? null,
      error: valid ? undefined : 'Container parsed but lacked valid video stream or positive duration.',
    };
  } catch (err) {
    return {
      valid: false,
      filePath,
      sizeBytes,
      durationSeconds: 0,
      width: null,
      height: null,
      resolution: null,
      fps: null,
      videoCodec: null,
      hasVideo: false,
      hasAudio: false,
      audioCodec: null,
      error: err instanceof Error ? err.message : 'Invalid FFprobe JSON output.',
    };
  }
}

/**
 * Safely attempts a non-destructive stream-copy remux of a partial/interrupted MP4 segment.
 * Writes to a temporary sibling path first, validates with FFprobe, and only replaces the
 * corrupted target if the remuxed file is verified valid. Never modifies already-valid segments.
 */
export async function attemptPartialSegmentRepair(
  ffmpegPath: string | null,
  ffprobePath: string | null,
  partialFilePath: string
): Promise<{
  repaired: boolean;
  probe: MediaProbeResult;
  note: string;
}> {
  const initialProbe = await probeMediaFile(ffprobePath, partialFilePath);
  if (initialProbe.valid) {
    return {
      repaired: true,
      probe: initialProbe,
      note: 'Segment already decodable without remux.',
    };
  }

  if (!ffmpegPath || !ffprobePath) {
    return {
      repaired: false,
      probe: initialProbe,
      note: 'FFmpeg/FFprobe unavailable to attempt remux repair.',
    };
  }

  const tempOutput = `${partialFilePath}.repair_${crypto.randomBytes(4).toString('hex')}.mp4`;
  try {
    const res = await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-err_detect',
        'ignore_err',
        '-i',
        partialFilePath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-y',
        tempOutput,
      ],
      15000
    );

    if (res.exitCode !== 0 || !fs.existsSync(tempOutput)) {
      if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
      return {
        repaired: false,
        probe: initialProbe,
        note: `Remux repair failed: ${res.stderr.trim() || 'unrecoverable container'}`,
      };
    }

    const repairedProbe = await probeMediaFile(ffprobePath, tempOutput);
    if (!repairedProbe.valid) {
      fs.unlinkSync(tempOutput);
      return {
        repaired: false,
        probe: initialProbe,
        note: `Remux output failed FFprobe validation: ${repairedProbe.error ?? 'invalid stream'}`,
      };
    }

    fs.renameSync(tempOutput, partialFilePath);
    const finalProbe = await probeMediaFile(ffprobePath, partialFilePath);
    return {
      repaired: finalProbe.valid,
      probe: finalProbe,
      note: `Repaired partial segment via non-destructive remux (${finalProbe.durationSeconds.toFixed(1)}s).`,
    };
  } catch (err) {
    if (fs.existsSync(tempOutput)) {
      try {
        fs.unlinkSync(tempOutput);
      } catch {
        // ignore cleanup failure
      }
    }
    return {
      repaired: false,
      probe: initialProbe,
      note: err instanceof Error ? err.message : 'Unexpected repair error.',
    };
  }
}

/**
 * Managed FFmpeg child process with bounded binary chunk queueing, backpressure signaling,
 * stderr progress parsing, .segments.list completion tracking, and bounded graceful shutdown.
 */
export class FfmpegSegmentProcess {
  private readonly config: FfmpegSegmentConfig;
  private readonly events: FfmpegProcessEvents;
  private child: ChildProcess | null = null;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private chunksEnqueued = 0;
  private bytesEnqueued = 0;
  private totalBytesWritten = 0;
  private droppedChunks = 0;
  private backpressureEvents = 0;
  private lastChunkEnqueuedAt: string | null = null;
  private currentOutputFileBytes = 0;
  private lastError: string | null = null;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private spawnedArgs: string[] = [];
  private writingPausedForDrain = false;
  private backpressureActive = false;
  private ending = false;
  private exited = false;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private emittedSegments = new Set<string>();
  private lastKnownActiveSegmentIndex: number;
  private stderrLines: string[] = [];

  constructor(config: FfmpegSegmentConfig, events: FfmpegProcessEvents = {}) {
    this.config = config;
    this.events = events;
    this.lastKnownActiveSegmentIndex = config.startSegmentIndex;
  }

  public get pid(): number | null {
    return this.child?.pid ?? null;
  }

  public get isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  public getSpawnedArgs(): string[] {
    return [...this.spawnedArgs];
  }

  public getStderrTail(limit = 20): string[] {
    return this.stderrLines.slice(-limit);
  }

  public getMetrics(): FfmpegQueueMetrics {
    return {
      queuedChunks: this.queue.length,
      queuedBytes: this.queuedBytes,
      backpressureActive: this.backpressureActive,
      backpressureEvents: this.backpressureEvents,
      chunksEnqueued: this.chunksEnqueued,
      bytesEnqueued: this.bytesEnqueued,
      totalBytesWritten: this.totalBytesWritten,
      droppedChunks: this.droppedChunks,
      lastChunkEnqueuedAt: this.lastChunkEnqueuedAt,
      currentOutputFileBytes: this.currentOutputFileBytes,
      lastError: this.lastError,
      stderrTail: this.stderrLines.slice(-15),
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      spawnedArgs: [...this.spawnedArgs],
    };
  }

  public start(): void {
    if (this.child) {
      throw new Error('FFmpeg segment process is already running.');
    }

    fs.mkdirSync(this.config.outputDirectory, { recursive: true });
    // Clear any stale segment list from a prior run in this session folder
    if (fs.existsSync(this.config.segmentListPath)) {
      try {
        fs.unlinkSync(this.config.segmentListPath);
      } catch {
        // ignore
      }
    }

    const args = buildFfmpegSegmentArgs(this.config);
    this.spawnedArgs = [...args];
    const child = spawn(this.config.ffmpegPath, args, {
      cwd: this.config.outputDirectory,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.exited = false;
    this.ending = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.lastError = null;

    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE/EOF can occur if FFmpeg terminates early; never crash the main process
      if (!this.ending && err.code !== 'EPIPE') {
        this.lastError = `FFmpeg stdin error: ${err.message}`;
        this.events.onError?.(this.lastError);
      }
    });

    child.stdin?.on('drain', () => {
      this.writingPausedForDrain = false;
      this.flushQueue();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r|\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        this.stderrLines.push(line);
        if (this.stderrLines.length > 60) {
          this.stderrLines.shift();
        }
        if (/error|invalid|failed|cannot|no such|broken pipe/i.test(line) && !line.includes('frame=')) {
          this.lastError = line;
        }
        this.parseProgressLine(line);
      }
    });

    this.exitPromise = new Promise((resolve) => {
      child.on('error', (err) => {
        this.exited = true;
        this.exitCode = 1;
        this.exitSignal = null;
        this.lastError = `Failed to spawn FFmpeg: ${err.message}`;
        this.stopSegmentPolling();
        this.events.onError?.(this.lastError);
        this.events.onExit?.(1, null, err.message);
        resolve({ code: 1, signal: null });
      });

      child.on('close', (code, signal) => {
        this.exited = true;
        this.exitCode = code;
        this.exitSignal = signal;
        this.stopSegmentPolling();
        // Final scan of .segments.list after FFmpeg exits cleanly
        this.scanCompletedSegmentsList();
        this.detectActiveSegmentOnDisk();
        const stderrTail = this.stderrLines.slice(-12).join(' | ');
        if (code !== 0 && !this.lastError) {
          this.lastError = stderrTail || `FFmpeg exited with code ${code ?? 'unknown'}`;
        }
        this.events.onExit?.(code, signal, stderrTail);
        resolve({ code, signal });
      });
    });

    this.pollTimer = setInterval(() => {
      this.scanCompletedSegmentsList();
      this.detectActiveSegmentOnDisk();
    }, 900);
    this.pollTimer.unref();
  }

  public enqueueChunk(chunk: Buffer): { accepted: boolean; backpressureActive: boolean; reason?: string } {
    if (!this.child || this.exited || this.ending) {
      this.droppedChunks += 1;
      return {
        accepted: false,
        backpressureActive: this.backpressureActive,
        reason: this.exited
          ? 'FFmpeg process already exited.'
          : this.ending
            ? 'FFmpeg process is finalizing.'
            : 'FFmpeg process not started.',
      };
    }
    if (chunk.byteLength === 0) {
      return { accepted: true, backpressureActive: this.backpressureActive };
    }

    // Hard memory safety ceiling
    if (this.queuedBytes + chunk.byteLength > MAX_QUEUE_BYTES || this.queue.length >= MAX_QUEUE_CHUNKS) {
      this.droppedChunks += 1;
      if (!this.backpressureActive) {
        this.backpressureEvents += 1;
      }
      this.backpressureActive = true;
      this.lastError = `Recording pipeline buffer reached ${Math.round(MAX_QUEUE_BYTES / (1024 * 1024))} MB limit; chunk dropped to protect system stability.`;
      this.events.onQueueChange?.(this.getMetrics());
      this.events.onError?.(this.lastError);
      return { accepted: false, backpressureActive: true, reason: this.lastError };
    }

    this.chunksEnqueued += 1;
    this.bytesEnqueued += chunk.byteLength;
    this.lastChunkEnqueuedAt = new Date().toISOString();
    this.queue.push(chunk);
    this.queuedBytes += chunk.byteLength;
    this.flushQueue();
    this.updateBackpressureState();
    this.events.onQueueChange?.(this.getMetrics());
    return { accepted: true, backpressureActive: this.backpressureActive };
  }

  private flushQueue(): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable || this.writingPausedForDrain) {
      return;
    }

    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.queuedBytes = Math.max(0, this.queuedBytes - next.byteLength);
      this.totalBytesWritten += next.byteLength;

      let canContinue = false;
      try {
        canContinue = stdin.write(next);
      } catch (err) {
        this.lastError = `FFmpeg stdin write threw: ${err instanceof Error ? err.message : String(err)}`;
        this.queue = [];
        this.queuedBytes = 0;
        return;
      }

      if (!canContinue) {
        this.writingPausedForDrain = true;
        break;
      }
    }

    this.updateBackpressureState();
    this.events.onQueueChange?.(this.getMetrics());

    if (this.ending && this.queue.length === 0 && !this.writingPausedForDrain && !stdin.writableEnded) {
      try {
        stdin.end();
      } catch {
        // ignore
      }
    }
  }

  private updateBackpressureState(): void {
    if (!this.backpressureActive) {
      if (this.queuedBytes >= HIGH_WATER_BYTES || this.queue.length >= HIGH_WATER_CHUNKS) {
        this.backpressureActive = true;
        this.backpressureEvents += 1;
      }
    } else if (this.queuedBytes <= LOW_WATER_BYTES && this.queue.length <= LOW_WATER_CHUNKS) {
      this.backpressureActive = false;
    }
  }

  /**
   * Gracefully closes FFmpeg stdin after flushing queued chunks, waiting up to gracefulTimeoutMs
   * before escalating SIGTERM -> SIGKILL so the app never hangs on stop or quit.
   */
  public async stopGracefully(gracefulTimeoutMs = 10000): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    if (!this.child || !this.exitPromise) {
      return { code: 0, signal: null };
    }
    if (this.exited) {
      return this.exitPromise;
    }

    this.ending = true;
    this.flushQueue();

    const stdin = this.child.stdin;
    if (stdin && !stdin.destroyed && this.queue.length === 0 && !this.writingPausedForDrain && !stdin.writableEnded) {
      try {
        stdin.end();
      } catch {
        // ignore
      }
    }

    let termTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const guardedExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      termTimer = setTimeout(() => {
        if (!this.exited && this.child) {
          try {
            this.child.kill('SIGTERM');
          } catch {
            // ignore
          }
          killTimer = setTimeout(() => {
            if (!this.exited && this.child) {
              try {
                this.child.kill('SIGKILL');
              } catch {
                // ignore
              }
            }
          }, 3000);
          killTimer.unref();
        }
      }, gracefulTimeoutMs);
      termTimer.unref();

      void this.exitPromise!.then((result) => {
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      });
    });

    const result = await guardedExit;
    this.stopSegmentPolling();
    this.scanCompletedSegmentsList();
    return result;
  }

  private stopSegmentPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scanCompletedSegmentsList(): void {
    if (!fs.existsSync(this.config.segmentListPath)) return;
    try {
      const content = fs.readFileSync(this.config.segmentListPath, 'utf8');
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const fileName of lines) {
        if (this.emittedSegments.has(fileName)) continue;
        const segmentIndex = parseSegmentIndexFromFileName(fileName);
        if (segmentIndex === null) continue;
        const fullPath = path.resolve(this.config.outputDirectory, path.basename(fileName));
        if (!fs.existsSync(fullPath)) continue;

        this.emittedSegments.add(fileName);
        this.events.onSegmentFinalized?.(path.basename(fileName), fullPath, segmentIndex);
      }
    } catch {
      // Ignore transient read race while FFmpeg updates segment list
    }
  }

  private detectActiveSegmentOnDisk(): void {
    try {
      const files = fs.readdirSync(this.config.outputDirectory);
      let maxIdx = this.lastKnownActiveSegmentIndex;
      let latestFileName: string | null = null;
      let highestOnDiskIdx = 0;
      for (const f of files) {
        const idx = parseSegmentIndexFromFileName(f);
        if (idx !== null) {
          if (idx >= highestOnDiskIdx) {
            highestOnDiskIdx = idx;
            latestFileName = f;
          }
          if (idx > maxIdx) {
            maxIdx = idx;
          }
        }
      }
      if (latestFileName) {
        try {
          const st = fs.statSync(path.join(this.config.outputDirectory, latestFileName));
          this.currentOutputFileBytes = st.size;
        } catch {
          // ignore stat race
        }
      } else {
        this.currentOutputFileBytes = 0;
      }
      if (maxIdx !== this.lastKnownActiveSegmentIndex) {
        this.lastKnownActiveSegmentIndex = maxIdx;
        this.events.onActiveSegmentChanged?.(maxIdx);
      }
    } catch {
      // ignore transient directory errors
    }
  }

  private parseProgressLine(line: string): void {
    if (!line.includes('frame=') && !line.includes('time=')) return;

    const fpsMatch = /fps=\s*([\d.]+)/.exec(line);
    const bitrateMatch = /bitrate=\s*([\d.]+)kbits\/s/.exec(line);
    const timeMatch = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);

    let encodedSeconds: number | null = null;
    if (timeMatch) {
      encodedSeconds =
        Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
    }

    this.events.onProgress?.({
      fps: fpsMatch ? Math.round(Number(fpsMatch[1]) * 10) / 10 : null,
      bitrateKbps: bitrateMatch ? Math.round(Number(bitrateMatch[1])) : null,
      encodedSeconds,
      lastLine: line,
    });
  }
}
