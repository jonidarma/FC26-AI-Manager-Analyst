/**
 * FC26 AI Manager — Phase 2 Automated Capture Engine Test Suite
 *
 * Covers:
 * 1. CaptureSessionEngine unit tests (canonical layout, path confinement, state machine, discard isolation, crash discovery)
 * 2. Real FFmpeg + FFprobe synthetic video integration tests (H.264 MP4 segmentation, video-only & AAC audio, pause/resume continuity, crash recovery & partial repair)
 * 3. SQLite Migration v3 & recording repository persistence tests (strictly isolated in /tmp via FC26_USER_DATA_DIR)
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

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fc26-phase2-test-'));
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

async function main(): Promise<void> {
  console.log('=== FC26 AI Manager — Phase 2 Capture Engine Automated Test Suite ===');
  console.log(`Isolated temp workspace: ${TEST_ROOT}\n`);

  const engine = new CaptureSessionEngine(RECORDINGS_ROOT);

  // -------------------------------------------------------------------------
  // SECTION 1: CaptureSessionEngine Unit Tests
  // -------------------------------------------------------------------------
  console.log('[Section 1] CaptureSessionEngine Unit Tests');

  await runTest('Canonical session layout fixes duplicate recordings/recordings path bug', () => {
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
    assert.equal(
      manifest.outputDirectory.includes(`recordings${path.sep}recordings`),
      false,
      'Must NOT create duplicate recordings/recordings path'
    );
    assert.equal(fs.existsSync(path.join(expectedDir, 'manifest.json')), true);
  });

  await runTest('Path traversal and non-MP4 playback attempts are strictly rejected', () => {
    assert.throws(() => engine.getSafeSessionDirectory('../escape', 'sess_01'));
    assert.throws(() => engine.resolveSafeMediaPath('/etc/passwd', true));

    const nonMp4 = path.join(RECORDINGS_ROOT, 'notes.txt');
    fs.writeFileSync(nonMp4, 'not a video', 'utf8');
    assert.throws(() => engine.resolveSafeMediaPath(nonMp4, true));
    fs.unlinkSync(nonMp4);
  });

  await runTest('Strict recording state machine enforces allowed transitions & idempotent finalize', () => {
    const manifest = engine.createSessionManifest({
      matchId: 'match_state_01',
      half: 'first_half',
      sourceId: 'window:2001:0',
      sourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      segmentDurationMinutes: 2,
    });

    const paused = engine.updateSessionStatus(manifest.sessionId, 'paused', undefined, manifest.matchId);
    assert.equal(paused.status, 'paused');

    const resumed = engine.updateSessionStatus(manifest.sessionId, 'recording', undefined, manifest.matchId);
    assert.equal(resumed.status, 'recording');

    const finalized1 = engine.finalizeSessionManifest(manifest.sessionId, {
      activeDurationSeconds: 120,
      integrityStatus: 'verified',
      matchId: manifest.matchId,
    });
    assert.equal(finalized1?.status, 'completed');

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
    assert.equal(fs.existsSync(f1), false, 'Discarded session MP4 should be deleted');
    assert.equal(fs.existsSync(f2), true, 'Sibling session MP4 must remain intact');

    // Discarded session cannot transition back to paused/recording
    assert.throws(() =>
      engine.updateSessionStatus(m1.sessionId, 'paused', undefined, m1.matchId)
    );
  });

  await runTest('Crash recovery scan detects canonical & legacy manifests while ignoring corrupted JSON', () => {
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

    // Add a malformed manifest in legacy folder to verify resilience
    const legacyDir = path.join(RECORDINGS_ROOT, 'manifests');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'corrupt_broken.json'), '{not-valid-json', 'utf8');

    const summaries = engine.scanRecoverableManifests();
    assert.ok(
      summaries.some((s) => s.sessionId === interrupted.sessionId),
      'Must discover canonical interrupted session'
    );

    // Excluding activeSessionId hides the active session from recovery list
    const filtered = engine.scanRecoverableManifests(interrupted.sessionId);
    assert.equal(
      filtered.some((s) => s.sessionId === interrupted.sessionId),
      false
    );
  });

  // -------------------------------------------------------------------------
  // SECTION 2: Real FFmpeg + FFprobe Synthetic Video Tests
  // -------------------------------------------------------------------------
  console.log('\n[Section 2] Real FFmpeg + FFprobe Synthetic Video Integration Tests');

  let ffmpegPath = '';
  let ffprobePath = '';
  let preferredEncoder: 'libx264' | 'h264_mf' = 'libx264';

  await runTest('probeFfmpegCapabilities verifies all 8 prerequisites in dev mode and rejects missing packaged binaries', async () => {
    const devProbe = await probeFfmpegCapabilities({
      isPackaged: false,
      appPath: process.cwd(),
      recordingsRootDir: RECORDINGS_ROOT,
      transportReady: true,
      ipcHandlersReady: true,
    });

    assert.equal(devProbe.ready, true, `Expected dev probe ready; blocking=${devProbe.capabilities.blockingReason}`);
    assert.equal(devProbe.capabilities.ffmpegAvailable, true);
    assert.equal(devProbe.capabilities.ffprobeAvailable, true);
    assert.ok(devProbe.binaries.ffmpegPath);
    assert.ok(devProbe.binaries.ffprobePath);
    assert.ok(devProbe.capabilities.preferredEncoder);
    assert.equal(devProbe.capabilities.prerequisites.length, 8);
    assert.equal(devProbe.capabilities.prerequisites.every((p) => p.ok), true);

    ffmpegPath = devProbe.binaries.ffmpegPath!;
    ffprobePath = devProbe.binaries.ffprobePath!;
    preferredEncoder = devProbe.capabilities.preferredEncoder as 'libx264' | 'h264_mf';

    // Packaged mode with empty resourcesPath MUST return ready: false (never fall back to system PATH!)
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

  await runTest('buildFfmpegSegmentArgs produces validated argument array with aspect-ratio-safe scale & fragmented MP4', () => {
    const args = buildFfmpegSegmentArgs({
      ffmpegPath,
      encoder: preferredEncoder,
      inputFormat: 'webm',
      resolution: '1280x720',
      fps: 30,
      bitrateKbps: 3500,
      audioEnabled: false,
      segmentDurationSeconds: 180,
      startSegmentIndex: 1,
      outputDirectory: RECORDINGS_ROOT,
      segmentListPath: path.join(RECORDINGS_ROOT, '.segments.list'),
    });

    assert.ok(args.includes('pipe:0'));
    assert.ok(args.includes('-an'));
    assert.ok(args.includes('yuv420p'));
    assert.ok(args.some((a) => a.includes('force_original_aspect_ratio=decrease')));
    assert.ok(args.some((a) => a.includes('frag_keyframe')));
  });

  await runTest('Real FFmpeg segmented H.264 MP4 recording (video-only, multi-segment split, FFprobe + SHA-256)', async () => {
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
        segmentDurationSeconds: 2, // 5s synthetic input -> >= 2 segments!
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

    proc.start();
    // Feed in 32KB binary chunks simulating real MediaRecorder IPC chunks
    const chunkSize = 32 * 1024;
    for (let offset = 0; offset < webmBuf.length; offset += chunkSize) {
      const slice = webmBuf.subarray(offset, Math.min(offset + chunkSize, webmBuf.length));
      const res = proc.enqueueChunk(slice);
      assert.equal(res.accepted, true);
    }

    const exit = await proc.stopGracefully(10000);
    assert.equal(exit.code, 0, 'FFmpeg should exit cleanly with code 0');

    const diskSegments = engine.discoverSegmentFilesOnDisk(manifest.outputDirectory);
    assert.ok(
      diskSegments.length >= 2,
      `Expected >= 2 segmented MP4 files from 5s input @ 2s segment_time, got ${diskSegments.length}`
    );
    assert.ok(finalizedIndices.length >= 2, 'Expected segment list callbacks for all segments');

    for (const seg of diskSegments) {
      const probe = await probeMediaFile(ffprobePath, seg.filePath);
      assert.equal(probe.valid, true, `FFprobe validation failed for ${seg.fileName}: ${probe.error}`);
      assert.equal(probe.videoCodec, 'h264');
      assert.equal(probe.hasVideo, true);
      assert.equal(probe.hasAudio, false, 'Video-only recording must NOT contain an audio stream');
      assert.ok(probe.durationSeconds > 0.5);
      const sha = await computeFileSha256(seg.filePath);
      assert.equal(sha.length, 64);
    }
  });

  await runTest('Real FFmpeg segmented H.264 MP4 recording with AAC loopback audio stream', async () => {
    const webmAudioBuf = generateSyntheticWebm(
      ffmpegPath,
      path.join(SYNTHETIC_DIR, 'video_audio.webm'),
      {
        durationSec: 3,
        withAudio: true,
      }
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
    assert.equal(probe.hasAudio, true, 'Audio-enabled recording must preserve AAC audio stream');
    assert.equal(probe.audioCodec, 'aac');
  });

  await runTest('Pause/Resume continuity keeps same sessionId and increments segment index cleanly', async () => {
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

    // Part 1 before pause -> segment_001.mp4
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

    engine.updateSessionStatus(
      manifest.sessionId,
      'paused',
      { nextSegmentIndex: 2 },
      manifest.matchId
    );
    engine.updateSessionStatus(manifest.sessionId, 'recording', undefined, manifest.matchId);

    // Part 2 after resume -> segment_002.mp4 in SAME session folder
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
    for (const seg of segs) {
      const probe = await probeMediaFile(ffprobePath, seg.filePath);
      assert.equal(probe.valid, true);
    }
  });

  await runTest('Crash recovery verifies valid segments, classifies corrupted 0-byte segments, and updates manifest', async () => {
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

    // Write valid segment_001.mp4
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

    // Simulate interrupted 0-byte segment_002.mp4 left behind by hard crash
    fs.writeFileSync(path.join(manifest.outputDirectory, 'segment_002.mp4'), Buffer.alloc(0));

    // Manifest status is still 'recording' -> run crash recovery
    const recovery = await engine.recoverSession(manifest.sessionId, ffmpegPath, ffprobePath);
    assert.equal(recovery.status, 'recovered');
    assert.equal(recovery.classification, 'partially_recovered');
    assert.equal(recovery.integrityStatus, 'partial');
    assert.equal(recovery.recoveredSegments.length, 1);
    assert.equal(recovery.corruptedSegments.length, 1);
    assert.equal(recovery.recoveredSegments[0].index, 1);
    assert.equal(recovery.corruptedSegments[0].index, 2);
    assert.ok(recovery.recoveredSegments[0].checksum?.length === 64);

    // Reloaded manifest should no longer appear in scanRecoverableManifests()
    const remaining = engine.scanRecoverableManifests();
    assert.equal(
      remaining.some((s) => s.sessionId === manifest.sessionId),
      false
    );
  });

  // -------------------------------------------------------------------------
  // SECTION 3: SQLite Migration v3 & Recording Repository Persistence Tests
  // -------------------------------------------------------------------------
  console.log('\n[Section 3] SQLite Migration v3 & Recording Repository Persistence Tests');

  await runTest('Migration v3 initializes cleanly and persists match_sessions, recording_segments, and hasSecondHalfRecording', async () => {
    const dbMod = await import('../../server/db/database');
    const repo = await import('../../server/services/repository');

    const meta = dbMod.getDatabaseMetadata();
    assert.equal(meta.schemaVersion, 3, 'Expected SQLite schema version 3');

    // Create club, opponent, match
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

    // 1. Create First-Half session & upsert segment idempotently
    const s1 = repo.createOrUpsertMatchSession({
      id: 'sess_fh_001',
      matchId: match.id,
      half: 'first_half',
      status: 'recording',
      captureSourceId: 'window:999:0',
      captureSourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
      encoder: 'libx264',
      audioEnabled: false,
      outputDirectory: path.join(RECORDINGS_ROOT, match.id, 'sess_fh_001'),
    });
    assert.equal(s1.status, 'recording');

    const seg1a = repo.upsertRecordingSegment({
      sessionId: s1.id,
      matchId: match.id,
      segmentIndex: 1,
      filePath: path.join(RECORDINGS_ROOT, match.id, 'sess_fh_001', 'segment_001.mp4'),
      durationSeconds: 180,
      sizeBytes: 75000000,
      checksum: 'a'.repeat(64),
      status: 'finalized',
      resolution: '1280x720',
      fps: 30,
      codec: 'h264',
      hasAudio: false,
      integrityStatus: 'verified',
    });
    // Upsert same segment index again -> must update without duplicating
    const seg1b = repo.upsertRecordingSegment({
      sessionId: s1.id,
      matchId: match.id,
      segmentIndex: 1,
      filePath: seg1a.filePath,
      durationSeconds: 181,
      sizeBytes: 76000000,
      checksum: 'b'.repeat(64),
      status: 'finalized',
      integrityStatus: 'verified',
    });
    assert.equal(seg1b.durationSeconds, 181);

    repo.updateMatchSession(s1.id, {
      status: 'completed',
      durationSeconds: 181,
      totalBytes: 76000000,
      integrityStatus: 'verified',
    });

    const matchesAfterFh = repo.listMatches(club.id);
    assert.equal(matchesAfterFh[0].status, 'halftime_ready');
    assert.equal(matchesAfterFh[0].hasSecondHalfRecording, false);

    // 2. Create Second-Half session -> verify hasSecondHalfRecording ONLY becomes true on completion
    const s2 = repo.createOrUpsertMatchSession({
      id: 'sess_sh_001',
      matchId: match.id,
      half: 'second_half',
      status: 'recording',
      captureSourceId: 'window:999:0',
      captureSourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
    });
    assert.equal(repo.listMatches(club.id)[0].hasSecondHalfRecording, false);

    repo.updateMatchSession(s2.id, {
      status: 'completed',
      durationSeconds: 200,
      totalBytes: 82000000,
      integrityStatus: 'verified',
    });
    assert.equal(repo.listMatches(club.id)[0].hasSecondHalfRecording, true);

    const allSessions = repo.listMatchSessions({ matchId: match.id });
    assert.equal(allSessions.length, 2);
    const loadedFh = allSessions.find((s) => s.id === 'sess_fh_001');
    assert.equal(loadedFh?.segments.length, 1);
    assert.equal(loadedFh?.segments[0].checksum, 'b'.repeat(64));
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
