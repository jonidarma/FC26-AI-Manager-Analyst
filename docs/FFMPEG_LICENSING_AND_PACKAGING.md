# FFmpeg Licensing, Binary Provenance & Windows Packaging Guide

## 1. Runtime Packaging Architecture

FC26 AI Manager packages FFmpeg and FFprobe **outside `app.asar`** using Electron Builder `extraResources` (`electron-builder.yml`):

```yaml
extraResources:
  - from: resources/ffmpeg/win-x64
    to: ffmpeg
    filter:
      - "**/*"
```

At runtime:
- **Packaged Windows builds (`app.isPackaged === true`)**:
  `electron/ffmpegRecordingService.ts` resolves binaries **exclusively** from:
  - `<installDir>/resources/ffmpeg/ffmpeg.exe`
  - `<installDir>/resources/ffmpeg/ffprobe.exe`
  Packaged builds **never** silently fall back to an arbitrary system `PATH` binary, preventing tampered or mismatched binaries from being executed.
- **Development & automated CI tests (`app.isPackaged === false`)**:
  Resolves in strict order:
  1. `FC26_FFMPEG_PATH` / `FC26_FFPROBE_PATH` (development/test override only)
  2. `<repo>/resources/ffmpeg/<platform>-<arch>/`
  3. System `PATH` (`ffmpeg` / `ffprobe`)

## 2. Required FFmpeg Capabilities

The runtime capability probe (`probeFfmpegCapabilities`) verifies all 8 prerequisites before setting `localFfmpegRecording: true`:
1. Supported desktop platform (`win32`, `linux`, `darwin`; primary target Windows 10/11 x64).
2. `ffmpeg` binary present at resolved path.
3. `ffmpeg -version` executes cleanly.
4. `webm` / `matroska` input demuxer supported (for Chromium `MediaRecorder` binary pipe).
5. At least one **probe-verified** H.264 MP4 encoder (`libx264` or `h264_mf` verified via real test encode to `null` muxer).
6. Binary IPC `MessageChannelMain` transport registered.
7. Persistent `userData/recordings` directory verified writable via temporary file write/unlink probe.
8. Main Process capture lifecycle IPC handlers registered.

Optional / supporting codecs:
- `aac` audio encoder (used when Windows system loopback audio is enabled; falls back cleanly to `-an` video-only if unavailable).
- `ffprobe` binary (used for post-segment container verification and crash recovery inspection).

## 3. Licensing Compliance (GPLv3 vs LGPLv2.1)

FFmpeg licensing depends directly on the build flags of the bundled binary:

### Option A — GPLv3 Static Build (Recommended for Private Desktop Distribution with `libx264`)
- **Pinned Reference**: `BtbN/FFmpeg-Builds` Windows x64 `gpl-7.1` static build (`ffmpeg.exe` + `ffprobe.exe`).
- **Encoders**: Includes `libx264` (software H.264 encoder, reliable across all Windows GPUs and VMs), `h264_mf`, `aac`, `webm`/`matroska` demuxer, and `mp4` muxer.
- **Obligations**:
  - `libx264` is GPL-licensed; bundling a GPL FFmpeg build places distribution under **GPLv3** terms for the bundled FFmpeg binaries.
  - Retain the upstream `LICENSE.txt` and build configuration notes inside `resources/ffmpeg/win-x64/`.
  - Provide corresponding FFmpeg source code link/offer if redistributing the installer publicly.

### Option B — LGPLv2.1 Build (No `libx264`)
- **Build Type**: `lgpl` static/shared build without `--enable-gpl` / `--enable-libx264`.
- **Encoders**: Relies on Windows Media Foundation `h264_mf` hardware/OS encoder (probed at runtime with a real encode check).
- **Obligations**:
  - Retain LGPLv2.1 license text and FFmpeg attribution notices.
  - Note: Some older Windows systems or headless environments may fail the `h264_mf` test probe, in which case the app will honestly disable recording and report the exact prerequisite failure.

## 4. Build-Time Windows Packaging Workflow

Never download binaries at application runtime. Stage binaries on the Windows build machine prior to building the NSIS installer:

```powershell
# 1. Stage verified Windows x64 ffmpeg.exe and ffprobe.exe
npm run prepare:ffmpeg:win64 -- --from-dir "C:\tools\ffmpeg-7.1.1-win64-gpl\bin"

# 2. Verify binaries and SHA-256 manifest
npm run prepare:ffmpeg:win64 -- --verify

# 3. Build React frontend, Express backend bundle, Electron Main/Preload, and NSIS Windows installer
npm run electron:dist:win
```

Output installer:
`release/FC26 AI Manager — Windows Setup.exe`
