# FC26 AI Manager — Football Tactical Intelligence System

A Windows desktop companion for EA SPORTS FC 26 Career Mode, designed for local gameplay capture and half-time tactical analysis.

> **Development status:** Phase 2 — Native Capture Engine. Windows desktop launch has been demonstrated. Live gameplay recording, recovery, installer distribution and AI video analysis are not yet certified.

## Windows Installation Guide

### 1. Prerequisites

- Windows 10/11 x64 (Windows 11 recommended)
- [Git](https://git-scm.com/downloads/win)
- [Node.js and npm](https://nodejs.org/)
- [Bun](https://bun.sh/)
- FFmpeg and FFprobe (Windows x64 static build with libx264 and AAC)
- EA SPORTS FC 26 for live capture testing

Observed development environment: Node.js 24.21.0, npm 12.2.1, Bun 1.4.5, Electron 45.4.1. These are observed versions, not a certified compatibility matrix.

All commands below use Windows PowerShell. To install Bun, review the official installer and run:

```powershell
irm https://bun.sh/install.ps1 | iex
```

Restart PowerShell and verify:

```powershell
git --version
node --version
npm --version
bun --version
```

### 2. Clone the Repository

```powershell
cd $HOME
git clone https://github.com/jonidarma/FC26-AI-Manager-Analyst.git
cd "$HOME\FC26-AI-Manager-Analyst"
```

Skip cloning if the repository already exists. Always enter the project directory when opening a new terminal.

### 3. Install Dependencies

```powershell
bun install --frozen-lockfile
bun pm untrusted
```

The repository uses `bun.lock`. Do not use `npm ci` without a package-lock.json. Avoid `npm install --force` and `--legacy-peer-deps` to bypass dependency conflicts.

If lifecycle scripts are blocked, inspect the relevant scripts and trust only verified, necessary packages. For example:

```powershell
Get-Content .\node_modules\protobufjs\scripts\postinstall.js
# Only after reviewing and trusting the script:
bun pm trust protobufjs
bun pm untrusted
```

If esbuild fails, inspect its install scripts before selectively trusting it. electron-winstaller can be deferred until packaging. Do not blindly trust all packages. Trust commands may modify package.json or bun.lock; review `git status --short` before committing.

### 4. Verify Native Runtime

```powershell
bun run electron --version
bun run esbuild --version
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); console.log(db.prepare('SELECT 1 AS ok').get()); db.close();"
```

Electron may download its binary on first execution. Expected Electron version for the current lockfile: `v45.4.1`. SQLite should print `{ ok: 1 }`. This tests Node.js SQLite compatibility, not Electron ABI compatibility.

### 5. Install FFmpeg and FFprobe

If not installed:

```powershell
winget install --id Gyan.FFmpeg -e
```

Restart PowerShell and run:

```powershell
cd "$HOME\FC26-AI-Manager-Analyst"
ffmpeg -version
ffprobe -version
ffmpeg -hide_banner -encoders 2>&1 | Select-String libx264
```

Stage the binaries:

```powershell
$ffmpegDir = Split-Path (Get-Command ffmpeg.exe).Source
node scripts/prepare-ffmpeg-win64.mjs --from-dir "$ffmpegDir"
node scripts/prepare-ffmpeg-win64.mjs --verify
```

If WinGet exposes aliases, supply the actual directory containing both executables, such as `C:\tools\ffmpeg\bin`. The helper stages files in `resources/ffmpeg/win-x64/` and generates a SHA-256 manifest. This does not independently authenticate the original download. Use a trusted distribution. Automatic pinned downloads are not implemented by the current helper.

See [FFmpeg licensing and packaging](docs/FFMPEG_LICENSING_AND_PACKAGING.md) before distributing binaries. Do not commit large executables.

### 6. Run Validation Tests

```powershell
bun run lint
bun run test:players
bun run test:capture
```

Investigate failures before proceeding. The player adapter suite previously passed all 10 tests on Windows. Automated capture tests do not replace live gameplay testing.

### 7. Launch Desktop Application

```powershell
bun run electron:start
```

This builds the frontend, backend and Electron application. The dashboard should display **Native Desktop Runtime**. Local capture does not require Gemini analysis. For AI API calls, configure a valid key as described in [.env.example](.env.example). Never commit credentials.

## First Match — Phase 2 Acceptance Test

- [ ] Inspect FC26 Database Center. A fresh local database may not contain players imported in another environment.
- [ ] Create a Career Mode club and prepare a fixture.
- [ ] Launch FC26, initially in borderless windowed mode.
- [ ] Open Match Capture and select the game window.
- [ ] Start recording manually and play long enough to cross a configured segment boundary.
- [ ] Test pause, resume, stop and finalization.
- [ ] Verify each MP4 plays independently without black screens or excessive stuttering.
- [ ] Restart the app and verify session persistence.
- [ ] Test interrupted-session recovery using disposable test data.
- [ ] Verify gameplay performance, telemetry and disabled microphone capture.

A dashboard readiness label alone does not establish successful recording.

## Build Windows Installer (Optional)

After desktop acceptance testing:

```powershell
bun run electron:dist:win
```

This verifies FFmpeg resources, builds the application and invokes Electron Builder for Windows x64. See [electron-builder.yml](electron-builder.yml) for packaging configuration. Investigate any blocked lifecycle scripts or native module ABI errors. Test the installer before distributing it.

## Troubleshooting

| Symptom | Recommended action |
| --- | --- |
| Repository not found | Check the exact repository URL and GitHub access. |
| npm ci EUSAGE | Use Bun with the committed bun.lock. |
| npm ERESOLVE (Vite/esbuild) | Use the frozen Bun lockfile; do not force npm resolution. |
| Unexpected untrusted packages | Check your working directory with Get-Location. |
| electron.cmd not found | Use `bun run electron --version`. Bun shims differ from npm. |
| Electron binary missing | Run `bun run electron --version` and allow the initial download. |
| SQLite native binding error | Identify whether the failure occurs in Node or Electron before rebuilding native modules. |
| FFmpeg not recognized | Install FFmpeg, restart PowerShell and check PATH. |
| FFmpeg staging fails | Supply the real directory containing both executables. |
| Empty player catalog | Import the appropriate CSV using Database Center; local data is not automatically synced from AI Studio. |

## Updating an Existing Installation

Back up local application data and recordings before updating. Verify the backup and do not assume the repository contains the live database.

```powershell
cd "$HOME\FC26-AI-Manager-Analyst"
git status --short
```

Review local changes before pulling. Once the working tree is ready:

```powershell
git pull --ff-only
bun install --frozen-lockfile
bun run lint
bun run electron:start
```

Re-run relevant tests after updates. Never delete the local database to resolve a dependency installation issue.

## Technology Stack

Electron, React, TypeScript, Vite, Express, SQLite (better-sqlite3), FFmpeg and Google Gemini integration.

This is an independent companion project and is not an official EA SPORTS product.
