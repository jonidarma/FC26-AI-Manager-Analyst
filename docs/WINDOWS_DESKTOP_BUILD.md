# FC26 AI Manager — Windows Desktop Build & Packaging Guide (Phase 1.1)

This project runs in **two environments** via `DesktopBridge` (`src/services/desktopBridge.ts`):

1. **Browser Preview Environment (Web Dev Runtime)**
   - Runs Express + SQLite locally with same-origin Bearer session auth.
   - Native Windows `desktopCapturer` window enumeration and Phase 2 FFmpeg video recording are unavailable and never simulated.

2. **Native Windows Electron Environment (`FC26 AI Manager — Windows Setup.exe`)**
   - Electron main process (`dist-electron/main.cjs`) detects `app.isPackaged`, spawns the packaged Express backend (`dist-server/server.mjs`) via `ELECTRON_RUN_AS_NODE=1` bound strictly to `127.0.0.1` on an ephemeral localhost port, authenticates renderer requests via a fresh 256-bit in-memory Bearer token delivered exclusively through `preload.cjs`, waits for `GET /api/health`, and stores SQLite persistently inside `app.getPath('userData')/database/fc26_manager.db`.
   - Window/display source enumeration (`desktopCapturer`) and disk inspection are active in Phase 1.1; FFmpeg segmented video recording (`localFfmpegRecording: false`) is planned for Phase 2.

---

## Reproducible Build Commands (Windows 10 / 11 x64)

### 1. Prerequisites
- Node.js 22 LTS (x64)
- Visual Studio Build Tools (Desktop development with C++ workload for `better-sqlite3`)

### 2. Install Dependencies & Rebuild Native SQLite for Electron ABI
```bash
npm install
npx electron-builder install-app-deps
```

### 3. Build Frontend, Server Bundle, and Electron Main/Preload
```bash
npm run build:desktop
```

This produces:
- `dist/` — Vite production React bundle
- `dist-server/server.mjs` — Bundled Express + SQLite backend (no Vite dev dependency)
- `dist-electron/main.cjs` & `dist-electron/preload.cjs` — Compiled CommonJS Electron entrypoints

### 4. Launch Locally in Electron Desktop Mode
```bash
npm run electron:start
```

### 5. Build Windows x64 NSIS Installer
```bash
npm run electron:dist:win
```

Output installer path: `release/FC26 AI Manager — Windows Setup.exe`.

### Persistent Windows Storage Paths
- SQLite Database: `%APPDATA%\FC26 AI Manager\database\fc26_manager.db`
- Recording Manifests / Future Segments: `%APPDATA%\FC26 AI Manager\recordings\`

### Recommended EA SPORTS FC 26 Display Mode
Set EA SPORTS FC 26 video settings to **Borderless Windowed** mode for reliable window-only capture on Windows.
