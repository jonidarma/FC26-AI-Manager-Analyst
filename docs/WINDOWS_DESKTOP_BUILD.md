# FC26 AI Manager — Windows Desktop Build & Packaging Guide (Phase 2.1)

This project runs in **two environments** via `DesktopBridge` (`src/services/desktopBridge.ts`):

1. **Browser Preview Environment (Web Dev Runtime)**
   - Runs Express + SQLite locally with same-origin Bearer session auth.
   - Native Windows `desktopCapturer` window enumeration and local FFmpeg gameplay recording are unavailable and never simulated.

2. **Native Windows Electron Environment (`FC26 AI Manager — Windows Setup.exe`)**
   - Electron main process (`dist-electron/main.cjs`) detects `app.isPackaged`, spawns the standalone packaged Express backend (`dist-server/server.cjs`) via `ELECTRON_RUN_AS_NODE=1` bound strictly to `127.0.0.1` on an ephemeral localhost port, injects `NODE_PATH` pointing to unpacked `app.asar.unpacked/node_modules`, authenticates renderer requests via a fresh 256-bit in-memory Bearer token delivered exclusively through `preload.cjs`, waits for `GET /api/health`, and stores SQLite persistently inside `app.getPath('userData')/database/fc26_manager.db`.
   - Native `desktopCapturer` source enumeration, preload-owned `Uint8Array` chunk transport, FFmpeg/FFprobe segmented recording, Startup/Stall watchdogs, and sanitized diagnostics logging are active.

---

## Packaged Backend Stability Architecture (Phase 2.1)

To prevent `ERR_MODULE_NOT_FOUND` for pure-JS packages (`express`, `dotenv`, `zod`, etc.) when packaged inside an Electron ASAR archive:

- `npm run build:server` bundles `server.ts` into a **standalone CommonJS module**:
  ```bash
  esbuild server.ts --bundle --platform=node --format=cjs --target=node22 --outfile=dist-server/server.cjs --external:better-sqlite3 --external:vite
  ```
- `electron-builder.yml` explicitly unpacks native SQLite and its resolution helpers from ASAR:
  - `node_modules/better-sqlite3/**`
  - `node_modules/bindings/**`
  - `node_modules/file-uri-to-path/**`
- `electron/main.ts` resolves `dist-server/server.cjs` in packaged builds, configures `NODE_PATH` for `app.asar.unpacked/node_modules`, logs full startup diagnostics to `%APPDATA%\FC26 AI Manager\logs\backend-startup.log`, and surfaces an actionable Windows error dialog if backend startup fails.

---

## Reproducible Build Commands (Windows 10 / 11 x64)

### 1. Prerequisites
- **Node.js 22 LTS (x64)** and/or **Bun**
- **Python 3** (for `node-gyp` native builds)
- **Visual Studio Build Tools 2022** with **"Desktop development with C++"** workload (for `better-sqlite3`)
- **FFmpeg & FFprobe Windows x64 binaries** (`ffmpeg.exe`, `ffprobe.exe`) staged into `resources/ffmpeg/`

### 2. Install Dependencies & Rebuild Native SQLite for Electron ABI
```powershell
bun install
# or: npm install
npx electron-builder install-app-deps
```

### 3. Stage Windows FFmpeg Binaries
```powershell
npm run prepare:ffmpeg:win64 -- --from-dir "C:\path\to\ffmpeg-win64\bin"
```

### 4. Build Frontend, Standalone Server Bundle, and Electron Main/Preload
```powershell
npm run build:desktop
```

This produces:
- `dist/` — Vite production React bundle
- `dist-server/server.cjs` — Standalone bundled Express + SQLite backend (no runtime Vite or pure-JS `node_modules` dependency)
- `dist-electron/main.cjs` & `dist-electron/preload.cjs` — Compiled CommonJS Electron entrypoints

### 5. Launch Locally in Electron Desktop Mode
```powershell
npm run electron:start
```

### 6. Build Windows x64 NSIS Installer
```powershell
npm run electron:dist:win
```

Output installer path: `release/FC26 AI Manager — Windows Setup.exe`.

---

## Persistent Windows Storage Paths
- **SQLite Database**: `%APPDATA%\FC26 AI Manager\database\fc26_manager.db`
- **Recording Segments, Manifests & Session Diagnostics**: `%APPDATA%\FC26 AI Manager\recordings\<matchId>\<sessionId>\`
- **Backend Startup Log**: `%APPDATA%\FC26 AI Manager\logs\backend-startup.log`

---

## Troubleshooting on Windows

1. **Backend Failed to Start / Health Check Timeout**:
   - Open `%APPDATA%\FC26 AI Manager\logs\backend-startup.log`.
   - Confirm `better-sqlite3.node` matches the installed Electron ABI (`npx electron-builder install-app-deps`).
   - Confirm antivirus / Windows Defender did not quarantine `better-sqlite3.node` or `ffmpeg.exe`.
2. **Database Upgrades**:
   - Schema Migration v4 runs automatically and non-destructively on first launch; all existing Career Mode clubs, matches, and imported FC26 players (`18,405`) are preserved.
   - Use **Settings → Export Database Backup** before major upgrades to retain a portable JSON backup (`fc26-ai-manager-backup-v4`).
3. **Recommended EA SPORTS FC 26 Display Mode**:
   - Set EA SPORTS FC 26 video settings to **Borderless Windowed** mode for reliable DWM window-only capture on Windows.
