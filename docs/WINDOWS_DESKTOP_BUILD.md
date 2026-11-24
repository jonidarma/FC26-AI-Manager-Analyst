# FC26 AI Manager — Windows Desktop Build & Native Packaging Guide

This project runs in **two environments** via the `DesktopBridge` abstraction (`src/services/desktopBridge.ts`):

1. **Browser Preview Environment (Current AI Studio / Web Dev Runtime)**
   - Full UI, local SQLite database (`./data/fc26_manager.db`), Career Mode club/squad management, Match Preparation, Tactical Board, Tactical Memory, and Settings.
   - Native Windows `desktopCapturer` window enumeration and local FFmpeg segmented recording are **explicitly unavailable** in a browser sandbox and are never simulated.

2. **Native Windows Electron Environment (`FC26 AI Manager — Windows Setup.exe`)**
   - Full Windows window/display detection for EA SPORTS FC 26 (`desktopCapturer`).
   - Local H.264 MP4 segmented recording (2–5 minute crash-resilient segments, microphone permanently disabled).
   - Main-process `safeStorage` credential management and local disk space inspection.

---

## Building on Windows 10 / 11 (x64)

### 1. Prerequisites
- Node.js 22 LTS (x64)
- Visual Studio Build Tools (C++ workload for `better-sqlite3` native rebuild)
- FFmpeg Windows static binary (bundled in Phase 2 capture verification)

### 2. Install Desktop Packaging DevDependencies
On your Windows workstation, install Electron and Electron Builder:

```bash
npm install --save-dev electron electron-builder @electron/rebuild
```

Rebuild `better-sqlite3` for Electron's Node ABI:

```bash
npx @electron/rebuild -f -w better-sqlite3
```

### 3. Run Locally in Native Electron Mode
Start the local backend/renderer and launch Electron:

```bash
npm run electron:compile
npx electron dist-electron/main.js
```

### 4. Package Windows Installer (`FC26 AI Manager — Windows Setup.exe`)
```bash
npm run electron:dist:win
```

Output installer will be created inside `release/FC26 AI Manager — Windows Setup.exe`.

### Recommended EA SPORTS FC 26 Display Mode
For reliable window-only capture on Windows without exclusive fullscreen black frames, set EA SPORTS FC 26 video settings to **Borderless Windowed** mode.
