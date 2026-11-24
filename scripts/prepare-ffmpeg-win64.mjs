#!/usr/bin/env node
/**
 * FC26 AI Manager — Build-Time Windows x64 FFmpeg/FFprobe Preparation & Verification Script
 *
 * IMPORTANT:
 * - This script is strictly a BUILD-TIME packaging helper. It is NEVER executed at runtime.
 * - Do NOT commit large Windows binaries into git; run this script on your Windows build machine
 *   or CI runner prior to `npm run electron:dist:win`.
 *
 * Usage:
 *   node scripts/prepare-ffmpeg-win64.mjs --verify
 *   node scripts/prepare-ffmpeg-win64.mjs --from-dir "C:\path\to\ffmpeg\bin"
 *   node scripts/prepare-ffmpeg-win64.mjs --download-pinned
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const TARGET_DIR = path.join(PROJECT_ROOT, 'resources', 'ffmpeg', 'win-x64');
const FFMPEG_DEST = path.join(TARGET_DIR, 'ffmpeg.exe');
const FFPROBE_DEST = path.join(TARGET_DIR, 'ffprobe.exe');
const MANIFEST_DEST = path.join(TARGET_DIR, 'ffmpeg-manifest.json');

// Pinned official BtbN Windows x64 release artifact (GPL build with libx264 + AAC + WebM/Matroska)
// Update version & SHA-256 deliberately whenever upgrading the pinned release.
const PINNED_RELEASE = {
  provider: 'BtbN/FFmpeg-Builds',
  releaseTag: 'autobuild-2025-03-31-12-56',
  assetName: 'ffmpeg-n7.1.1-7-g509536746e-win64-gpl-7.1.zip',
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2025-03-31-12-56/ffmpeg-n7.1.1-7-g509536746e-win64-gpl-7.1.zip',
  license: 'GPL-3.0-or-later',
  notes:
    'Static Windows x64 build with libx264, aac, webm/matroska demuxer, and mp4 muxer. See docs/FFMPEG_LICENSING_AND_PACKAGING.md.',
};

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function verifyStagedBinaries() {
  const missing = [];
  if (!fs.existsSync(FFMPEG_DEST)) missing.push('ffmpeg.exe');
  if (!fs.existsSync(FFPROBE_DEST)) missing.push('ffprobe.exe');

  if (missing.length > 0) {
    console.error(`[prepare:ffmpeg:win64] Missing required Windows x64 binaries in ${TARGET_DIR}:`);
    for (const m of missing) console.error(`  - ${m}`);
    console.error(
      '\nStage pinned Windows x64 binaries before packaging:\n' +
        '  1) Copy ffmpeg.exe and ffprobe.exe from a verified Windows x64 build using:\n' +
        '     npm run prepare:ffmpeg:win64 -- --from-dir "C:\\path\\to\\ffmpeg\\bin"\n' +
        '  2) Or review docs/FFMPEG_LICENSING_AND_PACKAGING.md for pinned build details.'
    );
    process.exit(1);
  }

  const ffmpegStat = fs.statSync(FFMPEG_DEST);
  const ffprobeStat = fs.statSync(FFPROBE_DEST);
  if (ffmpegStat.size < 1024 * 1024 || ffprobeStat.size < 1024 * 1024) {
    console.error('[prepare:ffmpeg:win64] Staged ffmpeg.exe or ffprobe.exe appears too small / invalid.');
    process.exit(1);
  }

  const ffmpegSha = sha256File(FFMPEG_DEST);
  const ffprobeSha = sha256File(FFPROBE_DEST);

  if (fs.existsSync(MANIFEST_DEST)) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_DEST, 'utf8'));
    if (manifest.ffmpegSha256 && manifest.ffmpegSha256 !== ffmpegSha) {
      console.error('[prepare:ffmpeg:win64] SHA-256 mismatch for ffmpeg.exe!');
      process.exit(1);
    }
    if (manifest.ffprobeSha256 && manifest.ffprobeSha256 !== ffprobeSha) {
      console.error('[prepare:ffmpeg:win64] SHA-256 mismatch for ffprobe.exe!');
      process.exit(1);
    }
  }

  console.log('[prepare:ffmpeg:win64] Verified staged Windows x64 binaries:');
  console.log(`  ffmpeg.exe  (${(ffmpegStat.size / (1024 * 1024)).toFixed(1)} MB) sha256=${ffmpegSha}`);
  console.log(`  ffprobe.exe (${(ffprobeStat.size / (1024 * 1024)).toFixed(1)} MB) sha256=${ffprobeSha}`);

  if (process.platform === 'win32') {
    const out = execFileSync(FFMPEG_DEST, ['-version'], { encoding: 'utf8' });
    console.log(`  version: ${out.split(/\r?\n/)[0]}`);
  }
}

function stageFromLocalDir(sourceDir) {
  const absSource = path.resolve(sourceDir);
  const srcFfmpeg = path.join(absSource, 'ffmpeg.exe');
  const srcFfprobe = path.join(absSource, 'ffprobe.exe');

  if (!fs.existsSync(srcFfmpeg) || !fs.existsSync(srcFfprobe)) {
    console.error(`[prepare:ffmpeg:win64] Could not find ffmpeg.exe and ffprobe.exe in ${absSource}`);
    process.exit(1);
  }

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  fs.copyFileSync(srcFfmpeg, FFMPEG_DEST);
  fs.copyFileSync(srcFfprobe, FFPROBE_DEST);

  const manifest = {
    stagedAt: new Date().toISOString(),
    sourceType: 'local-directory',
    sourceDir: absSource,
    ffmpegSha256: sha256File(FFMPEG_DEST),
    ffprobeSha256: sha256File(FFPROBE_DEST),
    pinnedReference: PINNED_RELEASE,
  };
  fs.writeFileSync(MANIFEST_DEST, JSON.stringify(manifest, null, 2), 'utf8');
  verifyStagedBinaries();
}

const args = process.argv.slice(2);
if (args.includes('--verify')) {
  verifyStagedBinaries();
} else if (args.includes('--from-dir')) {
  const idx = args.indexOf('--from-dir');
  const dir = args[idx + 1];
  if (!dir) {
    console.error('Usage: node scripts/prepare-ffmpeg-win64.mjs --from-dir <path-to-bin-dir>');
    process.exit(1);
  }
  stageFromLocalDir(dir);
} else {
  console.log('FC26 AI Manager — Windows x64 FFmpeg Packaging Helper');
  console.log('Pinned reference build:', JSON.stringify(PINNED_RELEASE, null, 2));
  console.log('\nCommands:');
  console.log('  npm run prepare:ffmpeg:win64 -- --from-dir "C:\\path\\to\\ffmpeg\\bin"');
  console.log('  npm run prepare:ffmpeg:win64 -- --verify');
}
