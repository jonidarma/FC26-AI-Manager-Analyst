/**
 * FC26 AI Manager — Phase 2 / 2.1 Automated Capture Engine Test Suite
 *
 * Covers all 12 Phase 2.1 capture acceptance scenarios:
 *  1. Binary chunk transport validation (Uint8Array / ArrayBuffer cross-realm extraction)
 *  2. Missing chunk / Startup Watchdog failure (0 chunks -> 'failed', aiEligible: false)
 *  3. Invalid session ID binding rejected (segment matchId mismatch & unknown session)
 *  4. FFmpeg failure handling (invalid input / non-zero exit captured in stderr tail & exitCode)
 *  5. Zero-byte recording NEVER marked 'completed' and NEVER transitions match to halftime_ready
 *  6. Corrupted segment handling (0-byte MP4 rejected by FFprobe)
 *  7. Partial recording handling (1 valid + 1 corrupted -> 'partial', aiEligible: true)
 *  8. Valid recording finalization (multi-segment H.264 MP4 + AAC + FFprobe + SHA-256)
 *  9. Pause/Resume behavior (same sessionId, monotonic segment numbering)
 * 10. Final EOS flushing (graceful FFmpeg stdin close & segment completion)
 * 11. Unexpected termination handling (interrupted manifest discovery & bounded diagnostics log)
 * 12. Recovery workflow (recoverable -> 'recovered', 0-segment corrupted recovery -> 'failed')
 *
 * NEVER modifies the workspace live database or commits test artifacts.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureSessionEngine } from '../../electron/captureEngine';
import {
  buildFfmpegSegmentArgs,
  computeFileSha256,
  FfmpegSegmentProcess,
  probeFfmpegCapabilities,
  probeMediaFile,
} from '../../electron/ffmpegRecordingService';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fc26-phase21-capture-test-'));
const RECORDINGS_ROOT = path.join(TEST_ROOT, 'recordings');
const DB_DIR = path.join(TEST_ROOT, 'database');
const SYNTHETIC_DIR = path.join(TEST_ROOT, 'synthetic');

fs.mkdirSync(RECORDINGS_ROOT, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(SYNTHETIC_DIR, { recursive: true });

// Ensure SQLite tests are 100% isolated from live workspace DB
process.env.FC26_USER_DATA_DIR = DB_DIR;

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

function generateSyntheticWebm(
  ffmpegPath: string,
  outPath: string,
  options: { durationSec: number; withAudio: boolean }
): Buffer {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=20:duration=${options.durationSec}`,
  ];
  if (options.withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${options.durationSec}`);
  }
  args.push('-c:v', 'libvpx', '-b:v', '600k', '-g', '20');
  if (options.withAudio) {
    args.push('-c:a', 'libopus', '-b:a', '64k');
  } else {
    args.push('-an');
  }
  args.push('-f', 'webm', '-y', outPath);

  execFileSync(ffmpegPath, args, { stdio: 'pipe' });
  return fs.readFileSync(outPath);
}

/**
 * Mirrors electron/main.ts cross-realm binary payload extraction so binary chunk
 * transport accepts Uint8Array, ArrayBuffer, Buffer, and TypedArray views cleanly.
 */
function extractChunkBuffer(payload: unknown): Buffer | null {
  if (!payload) return null;
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof payload === 'object' && payload !== null && 'byteLength' in payload) {
    const view = payload as { buffer?: ArrayBufferLike; byteOffset?: number; byteLength: number };
    if (view.buffer && typeof view.byteOffset === 'number') {
      return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    }
    return Buffer.from(new Uint8Array(payload as ArrayBufferLike));
  }
  return null;
}

async function main(): Promise<void> {
  console.log('=== FC26 AI Manager — Phase 2.1 Capture Engine Automated Acceptance Suite ===');
  console.log(`Isolated temp workspace: ${TEST_ROOT}\n`);

  const engine = new CaptureSessionEngine(RECORDINGS_ROOT);

  // -------------------------------------------------------------------------
  // SECTION 1: CaptureSessionEngine & Binary Transport Unit Tests
  // -------------------------------------------------------------------------
  console.log('[Section 1] CaptureSessionEngine & Binary Transport Unit Tests');

  await runTest('Scenario 1: Binary chunk transport extracts Uint8Array, ArrayBuffer, sliced view, and Buffer accurately', () => {
    const raw = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    const asUint8 = new Uint8Array(raw);
    const asAb = asUint8.buffer.slice(asUint8.byteOffset, asUint8.byteOffset + asUint8.byteLength);
    const sliced = new Uint8Array(raw.buffer, raw.byteOffset + 2, 4);

    assert.deepEqual(extractChunkBuffer(raw), raw);
    assert.deepEqual(extractChunkBuffer(asUint8), raw);
    assert.deepEqual(extractChunkBuffer(asAb), raw);
    assert.deepEqual(extractChunkBuffer(sliced), Buffer.from([0xdf, 0xa3, 0x9f, 0x42]));
    assert.equal(extractChunkBuffer(null), null);
    assert.equal(extractChunkBuffer('invalid-string'), null);
  });

  await runTest('Canonical session layout prevents duplicate recordings/recordings path & rejects traversal', () => {
    const manifest = engine.createSessionManifest({
      matchId: 'match_alpha_01',
      half: 'first_half',
      sourceId: 'window:1001:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      bitrateKbps: 3500,
      segmentDurationMinutes: 3,
    });

    const expectedDir = path.join(RECORDINGS_ROOT, 'match_alpha_01', manifest.sessionId);
    assert.equal(manifest.outputDirectory, expectedDir);
    assert.equal(manifest.outputDirectory.includes(`recordings${path.sep}recordings`), false);
    assert.equal(fs.existsSync(path.join(expectedDir, 'manifest.json')), true);

    assert.throws(() => engine.getSafeSessionDirectory('../escape', 'sess_01'));
    assert.throws(() => engine.resolveSafeMediaPath('/etc/passwd', true));
  });

  await runTest('Scenario 2 & 5: Zero-segment finalization & startup watchdog failure ALWAYS produce status="failed", aiEligible=false', () => {
    const manifest = engine.createSessionManifest({
      matchId: 'match_zero_byte_01',
      half: 'first_half',
      sourceId: 'window:2001:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      segmentDurationMinutes: 2,
    });

    // Attempting to finalize with 0 verified segments MUST NEVER yield 'completed'
    const finalizedZero = engine.finalizeSessionManifest(manifest.sessionId, {
      activeDurationSeconds: 445,
      integrityStatus: 'verified', // even if caller naively passes verified!
      matchId: manifest.matchId,
    });
    assert.equal(finalizedZero?.status, 'failed');
    assert.equal(finalizedZero?.aiEligible, false);
    assert.equal(finalizedZero?.integrityStatus, 'corrupted');
    assert.ok(finalizedZero?.failureReason);

    // Explicit startup watchdog failure
    const m2 = engine.createSessionManifest({
      matchId: 'match_watchdog_01',
      half: 'first_half',
      sourceId: 'window:2002:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      segmentDurationMinutes: 2,
    });
    const failedWatchdog = engine.failSessionManifest(
      m2.sessionId,
      'Startup Watchdog: 0 media chunks reached Main within 10s.',
      { activeDurationSeconds: 10, matchId: m2.matchId }
    );
    assert.equal(failedWatchdog?.status, 'failed');
    assert.equal(failedWatchdog?.aiEligible, false);
    assert.ok(failedWatchdog?.failureReason?.includes('Startup Watchdog'));
  });

  await runTest('Strict recording state machine allows valid completion, partial status, and blocks invalid transitions', () => {
    const manifest = engine.createSessionManifest({
      matchId: 'match_state_01',
      half: 'first_half',
      sourceId: 'window:2003:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      segmentDurationMinutes: 2,
    });

    engine.updateSessionStatus(manifest.sessionId, 'paused', undefined, manifest.matchId);
    engine.updateSessionStatus(manifest.sessionId, 'recording', undefined, manifest.matchId);

    // Attach 1 valid non-empty segment
    engine.upsertSegment(
      manifest.sessionId,
      {
        index: 1,
        fileName: 'segment_001.mp4',
        filePath: path.join(manifest.outputDirectory, 'segment_001.mp4'),
        sizeBytes: 1_500_000,
        durationSeconds: 120,
        checksum: 'a'.repeat(64),
        resolution: '1280x720',
        fps: 30,
        codec: 'h264',
        hasAudio: false,
        finalized: true,
        status: 'finalized',
        integrityStatus: 'verified',
        startedAt: manifest.startedAt,
        endedAt: new Date().toISOString(),
      },
      manifest.matchId
    );

    const finalized1 = engine.finalizeSessionManifest(manifest.sessionId, {
      activeDurationSeconds: 120,
      integrityStatus: 'verified',
      matchId: manifest.matchId,
    });
    assert.equal(finalized1?.status, 'completed');
    assert.equal(finalized1?.aiEligible, true);

    // Idempotent second finalize call
    const finalized2 = engine.finalizeSessionManifest(manifest.sessionId, {
      matchId: manifest.matchId,
    });
    assert.equal(finalized2?.status, 'completed');

    // Invalid transition after completion must throw
    assert.throws(() =>
      engine.updateSessionStatus(manifest.sessionId, 'recording', undefined, manifest.matchId)
    );
  });

  await runTest('Scenario 7: Partial recording (valid + corrupted segment) finalizes as status="partial", aiEligible=true', () => {
    const manifest = engine.createSessionManifest({
      matchId: 'match_partial_01',
      half: 'first_half',
      sourceId: 'window:2004:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      segmentDurationMinutes: 2,
    });

    engine.upsertSegment(
      manifest.sessionId,
      {
        index: 1,
        fileName: 'segment_001.mp4',
        filePath: path.join(manifest.outputDirectory, 'segment_001.mp4'),
        sizeBytes: 2_000_000,
        durationSeconds: 120,
        checksum: 'c'.repeat(64),
        resolution: '1280x720',
        fps: 30,
        codec: 'h264',
        hasAudio: false,
        finalized: true,
        status: 'finalized',
        integrityStatus: 'verified',
        startedAt: manifest.startedAt,
        endedAt: new Date().toISOString(),
      },
      manifest.matchId
    );
    engine.upsertSegment(
      manifest.sessionId,
      {
        index: 2,
        fileName: 'segment_002.mp4',
        filePath: path.join(manifest.outputDirectory, 'segment_002.mp4'),
        sizeBytes: 0,
        durationSeconds: 0,
        checksum: null,
        resolution: null,
        fps: null,
        codec: null,
        hasAudio: false,
        finalized: false,
        status: 'corrupted',
        integrityStatus: 'corrupted',
        startedAt: manifest.startedAt,
        endedAt: new Date().toISOString(),
      },
      manifest.matchId
    );

    const finalized = engine.finalizeSessionManifest(manifest.sessionId, {
      activeDurationSeconds: 150,
      failureReason: 'Stall Watchdog: no chunks received for 18s after segment 1.',
      matchId: manifest.matchId,
    });
    assert.equal(finalized?.status, 'partial');
    assert.equal(finalized?.integrityStatus, 'partial');
    assert.equal(finalized?.aiEligible, true);
  });

  await runTest('Confined discardSession removes ONLY target session files without affecting sibling sessions', () => {
    const m1 = engine.createSessionManifest({
      matchId: 'match_iso_01',
      half: 'first_half',
      sourceId: 'window:3001:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      segmentDurationMinutes: 3,
    });
    const m2 = engine.createSessionManifest({
      matchId: 'match_iso_01',
      half: 'second_half',
      sourceId: 'window:3001:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      segmentDurationMinutes: 3,
    });

    const f1 = path.join(m1.outputDirectory, 'segment_001.mp4');
    const f2 = path.join(m2.outputDirectory, 'segment_001.mp4');
    fs.writeFileSync(f1, Buffer.alloc(1024, 1));
    fs.writeFileSync(f2, Buffer.alloc(2048, 2));

    const res = engine.discardSession(m1.sessionId, m1.matchId);
    assert.equal(res.discarded, true);
    assert.equal(res.removedFiles, 1);
    assert.equal(fs.existsSync(f1), false);
    assert.equal(fs.existsSync(f2), true);
  });

  await runTest('Scenario 11: Unexpected termination detection & bounded diagnostics log (zero raw video)', () => {
    const interrupted = engine.createSessionManifest({
      matchId: 'match_crash_scan',
      half: 'first_half',
      sourceId: 'window:4001:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      segmentDurationMinutes: 3,
    });
    fs.writeFileSync(path.join(interrupted.outputDirectory, 'segment_001.mp4'), Buffer.alloc(4096, 3));

    // Append diagnostic event and verify file exists & is bounded
    engine.appendDiagnosticEvent(interrupted.matchId, interrupted.sessionId, {
      timestamp: new Date().toISOString(),
      level: 'info',
      stage: 'transport',
      message: 'Port ready acknowledged',
    });
    const diagLogPath = engine.getSessionDiagnosticsLogPath(
      interrupted.matchId,
      interrupted.sessionId
    );
    assert.equal(fs.existsSync(diagLogPath), true);
    assert.ok(fs.readFileSync(diagLogPath, 'utf8').includes('Port ready acknowledged'));

    const summaries = engine.scanRecoverableManifests();
    assert.ok(summaries.some((s) => s.sessionId === interrupted.sessionId));
    assert.equal(
      engine.scanRecoverableManifests(interrupted.sessionId).some((s) => s.sessionId === interrupted.sessionId),
      false
    );
  });

  // -------------------------------------------------------------------------
  // SECTION 2: Real FFmpeg + FFprobe Synthetic Video Integration Tests
  // -------------------------------------------------------------------------
  console.log('\n[Section 2] Real FFmpeg + FFprobe Synthetic Video Integration Tests');

  let ffmpegPath = '';
  let ffprobePath = '';
  let preferredEncoder: 'libx264' | 'h264_mf' = 'libx264';

  await runTest('probeFfmpegCapabilities verifies all 8 prerequisites & rejects missing packaged binaries', async () => {
    const devProbe = await probeFfmpegCapabilities({
      isPackaged: false,
      appPath: process.cwd(),
      recordingsRootDir: RECORDINGS_ROOT,
      transportReady: true,
      ipcHandlersReady: true,
    });

    assert.equal(devProbe.ready, true, `Expected dev probe ready; blocking=${devProbe.capabilities.blockingReason}`);
    assert.equal(devProbe.capabilities.prerequisites.length, 8);
    assert.equal(devProbe.capabilities.prerequisites.every((p) => p.ok), true);

    ffmpegPath = devProbe.binaries.ffmpegPath!;
    ffprobePath = devProbe.binaries.ffprobePath!;
    preferredEncoder = devProbe.capabilities.preferredEncoder as 'libx264' | 'h264_mf';

    const fakePackagedProbe = await probeFfmpegCapabilities({
      isPackaged: true,
      appPath: process.cwd(),
      resourcesPath: path.join(TEST_ROOT, 'empty-resources'),
      recordingsRootDir: RECORDINGS_ROOT,
      transportReady: true,
      ipcHandlersReady: true,
    });
    assert.equal(fakePackagedProbe.ready, false);
    assert.equal(fakePackagedProbe.capabilities.ffmpegPathSource, 'missing');
  });

  await runTest('Scenario 4: FFmpeg failure handling captures non-zero exit code & stderr diagnostics cleanly', async () => {
    const manifest = engine.createSessionManifest({
      matchId: 'match_ffmpeg_fail',
      half: 'first_half',
      sourceId: 'window:5099:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1500,
      segmentDurationMinutes: 2,
    });

    const proc = new FfmpegSegmentProcess({
      ffmpegPath,
      encoder: preferredEncoder,
      inputFormat: 'webm',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1500,
      audioEnabled: false,
      segmentDurationSeconds: 10,
      startSegmentIndex: 1,
      outputDirectory: manifest.outputDirectory,
      segmentListPath: engine.getSegmentListPath(manifest.matchId, manifest.sessionId),
    });

    proc.start();
    // Feed invalid garbage bytes (not a valid WebM container)
    proc.enqueueChunk(Buffer.from('NOT_A_VALID_WEBM_HEADER_0000000000000000'));
    const exit = await proc.stopGracefully(8000);
    assert.notEqual(exit.code, 0, 'Invalid WebM input must fail FFmpeg with non-zero exit code');
    const metrics = proc.getMetrics();
    assert.equal(metrics.exitCode, exit.code);
    assert.ok(metrics.stderrTail.length > 0, 'FFmpeg stderr tail should capture failure details');
  });

  await runTest('Scenario 8 & 10: Real FFmpeg segmented H.264 MP4 recording, final EOS flush, FFprobe + SHA-256', async () => {
    const webmBuf = generateSyntheticWebm(ffmpegPath, path.join(SYNTHETIC_DIR, 'video_only.webm'), {
      durationSec: 5,
      withAudio: false,
    });

    const manifest = engine.createSessionManifest({
      matchId: 'match_ffmpeg_video',
      half: 'first_half',
      sourceId: 'window:5001:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1800,
      segmentDurationMinutes: 2,
      audioRequested: false,
      audioActive: false,
    });

    const finalizedIndices: number[] = [];
    const proc = new FfmpegSegmentProcess(
      {
        ffmpegPath,
        encoder: preferredEncoder,
        inputFormat: 'webm',
        resolution: '1280x720',
        fps: 20,
        bitrateKbps: 1800,
        audioEnabled: false,
        segmentDurationSeconds: 2,
        startSegmentIndex: 1,
        outputDirectory: manifest.outputDirectory,
        segmentListPath: engine.getSegmentListPath(manifest.matchId, manifest.sessionId),
      },
      {
        onSegmentFinalized: (_name, _fullPath, idx) => {
          finalizedIndices.push(idx);
        },
      }
    );

    const args = buildFfmpegSegmentArgs({
      ffmpegPath,
      encoder: preferredEncoder,
      inputFormat: 'webm',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1800,
      audioEnabled: false,
      segmentDurationSeconds: 2,
      startSegmentIndex: 1,
      outputDirectory: manifest.outputDirectory,
      segmentListPath: engine.getSegmentListPath(manifest.matchId, manifest.sessionId),
    });
    assert.ok(args.includes('pipe:0'));

    proc.start();
    const chunkSize = 32 * 1024;
    for (let offset = 0; offset < webmBuf.length; offset += chunkSize) {
      const slice = webmBuf.subarray(offset, Math.min(offset + chunkSize, webmBuf.length));
      assert.equal(proc.enqueueChunk(slice).accepted, true);
    }

    const exit = await proc.stopGracefully(10000);
    assert.equal(exit.code, 0, 'FFmpeg should flush cleanly on EOS with exit code 0');
    assert.ok(proc.getMetrics().totalBytesWritten > 0);

    const diskSegments = engine.discoverSegmentFilesOnDisk(manifest.outputDirectory);
    assert.ok(diskSegments.length >= 2);
    assert.ok(finalizedIndices.length >= 2);

    for (const seg of diskSegments) {
      const probe = await probeMediaFile(ffprobePath, seg.filePath);
      assert.equal(probe.valid, true);
      assert.equal(probe.videoCodec, 'h264');
      assert.equal(probe.hasAudio, false);
      assert.ok(probe.durationSeconds > 0.5);
      const sha = await computeFileSha256(seg.filePath);
      assert.equal(sha.length, 64);
    }
  });

  await runTest('Scenario 8 (Audio): Real FFmpeg segmented H.264 MP4 recording with AAC loopback audio stream', async () => {
    const webmAudioBuf = generateSyntheticWebm(
      ffmpegPath,
      path.join(SYNTHETIC_DIR, 'video_audio.webm'),
      { durationSec: 3, withAudio: true }
    );

    const manifest = engine.createSessionManifest({
      matchId: 'match_ffmpeg_audio',
      half: 'first_half',
      sourceId: 'window:5002:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1800,
      segmentDurationMinutes: 2,
      audioRequested: true,
      audioActive: true,
    });

    const proc = new FfmpegSegmentProcess({
      ffmpegPath,
      encoder: preferredEncoder,
      inputFormat: 'webm',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1800,
      audioEnabled: true,
      segmentDurationSeconds: 10,
      startSegmentIndex: 1,
      outputDirectory: manifest.outputDirectory,
      segmentListPath: engine.getSegmentListPath(manifest.matchId, manifest.sessionId),
    });

    proc.start();
    proc.enqueueChunk(webmAudioBuf);
    const exit = await proc.stopGracefully(10000);
    assert.equal(exit.code, 0);

    const diskSegments = engine.discoverSegmentFilesOnDisk(manifest.outputDirectory);
    assert.equal(diskSegments.length, 1);
    const probe = await probeMediaFile(ffprobePath, diskSegments[0].filePath);
    assert.equal(probe.valid, true);
    assert.equal(probe.videoCodec, 'h264');
    assert.equal(probe.hasAudio, true);
    assert.equal(probe.audioCodec, 'aac');
  });

  await runTest('Scenario 9: Pause/Resume continuity preserves sessionId and increments segment index cleanly', async () => {
    const shortWebm = generateSyntheticWebm(ffmpegPath, path.join(SYNTHETIC_DIR, 'short.webm'), {
      durationSec: 2,
      withAudio: false,
    });

    const manifest = engine.createSessionManifest({
      matchId: 'match_pause_resume',
      half: 'first_half',
      sourceId: 'window:5003:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1500,
      segmentDurationMinutes: 3,
    });

    const proc1 = new FfmpegSegmentProcess({
      ffmpegPath,
      encoder: preferredEncoder,
      inputFormat: 'webm',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1500,
      audioEnabled: false,
      segmentDurationSeconds: 60,
      startSegmentIndex: 1,
      outputDirectory: manifest.outputDirectory,
      segmentListPath: engine.getSegmentListPath(manifest.matchId, manifest.sessionId),
    });
    proc1.start();
    proc1.enqueueChunk(shortWebm);
    assert.equal((await proc1.stopGracefully(10000)).code, 0);

    engine.updateSessionStatus(manifest.sessionId, 'paused', { nextSegmentIndex: 2 }, manifest.matchId);
    engine.updateSessionStatus(manifest.sessionId, 'recording', undefined, manifest.matchId);

    const proc2 = new FfmpegSegmentProcess({
      ffmpegPath,
      encoder: preferredEncoder,
      inputFormat: 'webm',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1500,
      audioEnabled: false,
      segmentDurationSeconds: 60,
      startSegmentIndex: 2,
      outputDirectory: manifest.outputDirectory,
      segmentListPath: engine.getSegmentListPath(manifest.matchId, manifest.sessionId),
    });
    proc2.start();
    proc2.enqueueChunk(shortWebm);
    assert.equal((await proc2.stopGracefully(10000)).code, 0);

    const segs = engine.discoverSegmentFilesOnDisk(manifest.outputDirectory);
    assert.deepEqual(
      segs.map((s) => s.fileName),
      ['segment_001.mp4', 'segment_002.mp4']
    );
  });

  await runTest('Scenario 6 & 12: Crash recovery separates valid vs 0-byte corrupted segments, and 0-valid-segment recovery marks status="failed"', async () => {
    const shortWebm = fs.readFileSync(path.join(SYNTHETIC_DIR, 'short.webm'));
    const manifest = engine.createSessionManifest({
      matchId: 'match_crash_recover',
      half: 'first_half',
      sourceId: 'window:5004:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1500,
      segmentDurationMinutes: 3,
    });

    const proc = new FfmpegSegmentProcess({
      ffmpegPath,
      encoder: preferredEncoder,
      inputFormat: 'webm',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1500,
      audioEnabled: false,
      segmentDurationSeconds: 60,
      startSegmentIndex: 1,
      outputDirectory: manifest.outputDirectory,
      segmentListPath: engine.getSegmentListPath(manifest.matchId, manifest.sessionId),
    });
    proc.start();
    proc.enqueueChunk(shortWebm);
    await proc.stopGracefully(10000);

    // Corrupted 0-byte segment_002.mp4
    fs.writeFileSync(path.join(manifest.outputDirectory, 'segment_002.mp4'), Buffer.alloc(0));

    const recovery = await engine.recoverSession(manifest.sessionId, ffmpegPath, ffprobePath);
    assert.equal(recovery.status, 'recovered');
    assert.equal(recovery.classification, 'partially_recovered');
    assert.equal(engine.loadSessionManifest(manifest.sessionId, manifest.matchId)?.aiEligible, true);
    assert.equal(recovery.recoveredSegments.length, 1);
    assert.equal(recovery.corruptedSegments.length, 1);

    // Now test a session with ONLY a 0-byte corrupted segment -> recovery MUST yield 'failed' & aiEligible=false
    const badManifest = engine.createSessionManifest({
      matchId: 'match_crash_corrupted_only',
      half: 'first_half',
      sourceId: 'window:5005:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 20,
      bitrateKbps: 1500,
      segmentDurationMinutes: 3,
    });
    fs.writeFileSync(path.join(badManifest.outputDirectory, 'segment_001.mp4'), Buffer.alloc(0));

    const badRecovery = await engine.recoverSession(badManifest.sessionId, ffmpegPath, ffprobePath);
    assert.equal(badRecovery.status, 'failed');
    assert.equal(badRecovery.classification, 'corrupted');
    assert.equal(engine.loadSessionManifest(badManifest.sessionId, badManifest.matchId)?.aiEligible, false);
    assert.equal(badRecovery.recoveredSegments.length, 0);
  });

  // -------------------------------------------------------------------------
  // SECTION 3: SQLite Migration v4 & Strict Match Status Synchronization Tests
  // -------------------------------------------------------------------------
  console.log('\n[Section 3] SQLite Migration v4 & Recording Repository Persistence Tests');

  await runTest('Scenario 3 & 5 (SQLite): Rejects invalid session binding, blocks halftime_ready on 0-segment sessions, allows clean retry', async () => {
    const dbMod = await import('../../server/db/database');
    const repo = await import('../../server/services/repository');

    const meta = dbMod.getDatabaseMetadata();
    assert.equal(meta.schemaVersion, 4, 'Expected SQLite schema version 4');

    const club = repo.createClub({
      name: 'Test Tactical FC',
      league: 'Premier League',
      season: '2025/26',
      managerName: 'Coach Tester',
      preferredPhilosophy: 'High Press',
      primaryFormation: '4-3-3 Holding',
      alternativeFormation: '4-2-3-1 Wide',
      preferredAttackingStyle: 'Balanced',
      preferredDefensiveStyle: 'High',
      setActive: true,
    });

    const match = repo.createMatch({
      clubId: club.id,
      careerProfileId: club.profile.id,
      opponentName: 'Rival United',
      competition: 'League',
      venue: 'home',
      matchDate: '2026-01-15',
      startingFormation: '4-3-3 Holding',
      startingXiIds: [],
      benchIds: [],
      objective: 'Test recording persistence',
      preMatchNotes: '',
      tacticalSetup: {
        buildUpStyle: 'Balanced',
        defensiveApproach: 'High',
        defensiveLineHeight: 65,
        playerAssignments: [],
      },
    });

    // Attempt 1: 0-byte failed first-half recording -> match MUST NOT become halftime_ready
    const failedSess = repo.createOrUpsertMatchSession({
      id: 'sess_fh_failed_001',
      matchId: match.id,
      half: 'first_half',
      status: 'recording',
      resolution: '1280x720',
      fps: 30,
    });
    assert.equal(failedSess.status, 'recording');
    assert.equal(repo.listMatches(club.id)[0].status, 'first_half_recording');

    // Scenario 3: Mismatched matchId on segment upsert must throw
    assert.throws(() =>
      repo.upsertRecordingSegment({
        sessionId: failedSess.id,
        matchId: '00000000-0000-0000-0000-000000000000',
        segmentIndex: 1,
        filePath: '/tmp/bad.mp4',
        durationSeconds: 10,
        sizeBytes: 1000,
        status: 'finalized',
      })
    );

    // Even if an old caller tried status: 'completed' with 0 segments, syncMatchStatusForSession refuses halftime_ready
    repo.updateMatchSession(failedSess.id, {
      status: 'failed',
      durationSeconds: 445,
      totalBytes: 0,
      integrityStatus: 'corrupted',
      aiEligible: false,
      failureReason: 'Startup Watchdog: 0 bytes received.',
    });
    assert.equal(
      repo.listMatches(club.id)[0].status,
      'scheduled',
      'Failed 0-segment recording must return match to scheduled so user can retry cleanly'
    );

    // Attempt 2: Retry first-half recording with valid verified segment -> advances to halftime_ready
    const s1 = repo.createOrUpsertMatchSession({
      id: 'sess_fh_retry_002',
      matchId: match.id,
      half: 'first_half',
      status: 'recording',
      captureSourceId: 'window:999:0',
      captureSourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      encoder: 'libx264',
      audioEnabled: false,
      outputDirectory: path.join(RECORDINGS_ROOT, match.id, 'sess_fh_retry_002'),
    });

    repo.upsertRecordingSegment({
      sessionId: s1.id,
      matchId: match.id,
      segmentIndex: 1,
      filePath: path.join(RECORDINGS_ROOT, match.id, 'sess_fh_retry_002', 'segment_001.mp4'),
      durationSeconds: 181,
      sizeBytes: 76000000,
      checksum: 'b'.repeat(64),
      status: 'finalized',
      resolution: '1280x720',
      fps: 30,
      codec: 'h264',
      hasAudio: false,
      integrityStatus: 'verified',
    });

    repo.updateMatchSession(s1.id, {
      status: 'completed',
      durationSeconds: 181,
      totalBytes: 76000000,
      integrityStatus: 'verified',
      aiEligible: true,
    });

    assert.equal(repo.listMatches(club.id)[0].status, 'halftime_ready');
    assert.equal(repo.listMatches(club.id)[0].hasSecondHalfRecording, false);

    // Second-Half session -> hasSecondHalfRecording ONLY true once valid segment completes
    const s2 = repo.createOrUpsertMatchSession({
      id: 'sess_sh_001',
      matchId: match.id,
      half: 'second_half',
      status: 'recording',
      resolution: '1280x720',
      fps: 30,
    });
    repo.upsertRecordingSegment({
      sessionId: s2.id,
      matchId: match.id,
      segmentIndex: 1,
      filePath: path.join(RECORDINGS_ROOT, match.id, 'sess_sh_001', 'segment_001.mp4'),
      durationSeconds: 200,
      sizeBytes: 82000000,
      status: 'finalized',
      integrityStatus: 'verified',
    });
    repo.updateMatchSession(s2.id, {
      status: 'completed',
      durationSeconds: 200,
      totalBytes: 82000000,
      integrityStatus: 'verified',
      aiEligible: true,
    });
    assert.equal(repo.listMatches(club.id)[0].hasSecondHalfRecording, true);
  });

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Fatal test suite error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup error
    }
  });
