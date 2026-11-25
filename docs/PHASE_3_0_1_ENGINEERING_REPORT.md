# Phase 3.0.1 — Engineering Report
## Native Recording Media Path Resolution & Structured Career Mode Recording Storage

**Version:** 3.0.1 (upgraded from 3.0.0)  
**Target Platform:** Windows 10/11 x64 Native Electron Desktop Application  
**Authoritative Database:** `%APPDATA%\fc26-ai-manager\database\fc26_manager.db` (preserved unchanged)

---

## 1. Root Cause Analysis of Production Bug

During Windows EA SPORTS FC 26 gameplay acceptance testing on v3.0.0, Gemini connectivity (`gemini-3.1-flash-lite`) succeeded, but First-Half Analysis failed with:

```text
Analysis Failed (GEMINI_ANALYSIS_ERROR)
Segment #1 failed FFprobe integrity validation:
Security block: media path "segment_001.mp4" lies outside approved application recording/data directories.
```

Three compounding defects caused this failure:
1. **Unanchored Relative Path Resolution (`process.cwd()` drift):** `aiAnalysisOrchestrator.ts` passed `seg.filePath` directly into `validateVideoFile()`, which invoked `path.resolve(candidatePath)`. When `seg.filePath` was relative (e.g., `"segment_001.mp4"`), `path.resolve()` anchored it to the packaged backend's working directory instead of the recording session's authoritative output directory.
2. **Incomplete Packaged Root Awareness:** Packaged Electron stores the database in `<userData>/database/fc26_manager.db` (`FC26_USER_DATA_DIR`) while recordings live in the sibling `<userData>/recordings/` directory (`FC26_RECORDINGS_DIR`). Without explicitly forwarding `FC26_APP_USER_DATA_ROOT` and `FC26_RECORDINGS_DIR` from Electron Main to the spawned Express backend, `<userData>/recordings/` was not guaranteed to be included among approved roots.
3. **Misleading Error Classification:** Local media resolution, containment, and FFprobe errors fell through generic error handling and were surfaced to users as `GEMINI_ANALYSIS_ERROR` even though the Gemini API was never reached.

---

## 2. Implemented Architecture & Key Changes

### 2.1 Shared Storage & Containment Contract (`shared/recordingStorage.ts`)
- Single contract shared across Electron Main (`electron/tsconfig.json` updated with `"rootDir": ".."`) and Express backend.
- Implements `canonicalizeAndContainPath()` performing **both lexical and `fs.realpathSync` canonical containment** (preventing `..` traversal, null bytes, symlinks, and Windows directory junctions from escaping approved roots).
- Implements Windows-safe sanitization (`sanitizeWindowsSegment`), reserved device name protection (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), deterministic `WINDOWS_SAFE_MAX_PATH` (240-char) compaction, strict in-game fixture date validation (`Date-Unknown` fallback; never system clock), atomic secret-scrubbed JSON writing (`writeJsonAtomic`, `scrubSecretsFromMetadata`), and structured naming builders.

### 2.2 Canonical Server-Side Media Resolver & Storage Planner (`server/services/recordingMediaResolver.ts`)
- `resolveRecordingSegmentMediaPath()`: Enforces strict session/match/half ownership (`RECORDING_SESSION_MISMATCH`), resolves relative and absolute paths across both Layout v2 and Legacy v1 without ever using `process.cwd()`, and emits distinct local error codes (`MEDIA_PATH_SECURITY_VIOLATION`, `MEDIA_FILE_NOT_FOUND`, `MEDIA_INTEGRITY_FAILED`, etc.).
- `buildMatchStoragePlan()` & `previewMatchStoragePlan()`: Deterministically plans and lazily allocates `<userData>/<Club>-Career-Mode/<UserClub>-vs-<Opponent> (<Competition>) <MatchDate>/{First Half, Second Half, Evidence Frames, AI Analysis, Diagnostics, match-metadata.json}`.
- `resolveActiveFormationForHalf()`: Enforces that Second-Half filenames use an `in_match_adjustment` formation **only when** `applied_in_game_confirmed = 1`; unconfirmed AI proposals fall back to the pre-match formation.
- `resolveTrustedFolderPath()`: Resolves Explorer-openable folders strictly by semantic IDs (`kind`, `matchId`, `sessionId`), eliminating raw renderer filesystem paths.

### 2.3 Non-Destructive Database Migration v7 (`server/db/migrations.ts`, `server/db/database.ts`, `server/services/repository.ts`)
- Transactional Migration `v7` adds `storage_career_directory`, `storage_match_directory`, `storage_layout_version`, `session_directory`, `recorded_formation_name`, `tactical_snapshot_id`, `relative_media_path`, `original_file_name`, and `display_file_name` columns.
- Existing v1 rows default cleanly to `storage_layout_version = 1`; existing files under `recordings/` are never moved or modified.
- Database backup/restore bumped to `fc26-ai-manager-backup-v7` with full backward compatibility for v1–v6 backups.

### 2.4 Electron Capture Engine & Safe Post-Close Rename (`electron/captureEngine.ts`, `electron/ffmpegRecordingService.ts`, `electron/main.ts`, `electron/preload.ts`)
- Electron Main passes `FC26_APP_USER_DATA_ROOT`, `FC26_RECORDINGS_DIR`, `FC26_RESOURCES_DIR`, `FC26_FFMPEG_PATH`, and `FC26_FFPROBE_PATH` to the spawned local Express server.
- Structured v2 recordings write active FFmpeg segments to temp staging names (`.fc26_seg_001.mp4`) and atomically rename them to human-readable `Part N.mp4` names **only after FFmpeg closes the file**, refusing overwrites with `RECORDING_FILENAME_COLLISION`.
- Crash recovery discovers and recovers both legacy v1 (`manifest.json`) and structured v2 (`recording-manifest.json`) interrupted sessions.
- Exposed `openTrustedFolder(payload)` via `electron/preload.ts` and `capture:open-trusted-folder` IPC handler.

### 2.5 AI Pipeline & UI Integration (`server/services/videoPreprocessingService.ts`, `server/services/aiAnalysisOrchestrator.ts`, `server.ts`, `src/views/*`)
- Video preprocessing resolves packaged FFmpeg from `resources/ffmpeg/` and `resources/bin/`, delegates root confinement to the canonical resolver, and stores/serves evidence frames in v2 `{MatchDir}/Evidence Frames/{First|Second} Half/` (preserving legacy v1 paths).
- AI orchestrator preserves exact local media error codes (`MEDIA_FILE_NOT_FOUND`, `MEDIA_PATH_SECURITY_VIOLATION`, `MEDIA_INTEGRITY_FAILED`, `RECORDING_SESSION_MISMATCH`) instead of misclassifying them as `GEMINI_ANALYSIS_ERROR`, and exports secret-scrubbed `AI Analysis/*.json` mirrors.
- Updated **Match Preparation** (live v2 Recording Storage Preview + missing-date warning), **Match Capture** (active storage layout, path, filename, formation, and trusted Open Folder button), **Match History** (per-match Open Match/First Half/Second Half Folder & Copy Path actions), and **Settings → Capture & Storage** (storage overview, v1/v2 session stats, naming templates, example tree, Open Storage Folder).

---

## 3. Automated Verification Results

All automated test suites and desktop builds were executed cleanly in isolated temporary directories (without touching live user data):

| Suite / Build | Command | Observed Result |
|---|---|---|
| EAFC26 DataHub Player Adapters | `npm run test:players` | **10/10 passed** |
| Capture Engine & Real FFmpeg/FFprobe | `npm run test:capture` | **14/14 passed** |
| Phase 2.1 Domain & Migrations | `npm run test:phase21` | **4/4 passed** |
| Phase 2.2 Tactical Validation & Catalog | `npm run test:phase22` | **9/9 passed** |
| Phase 3 Tactical Vision & AI Pipeline | `npm run test:phase3` | **10/10 passed** |
| Phase 3.0.1 Media Resolver & Storage v2 | `npm run test:phase301` | **35/35 passed** |
| Full Desktop Build (Vite + Server + Electron) | `npm run build:desktop` | **Succeeded** (`dist/`, `dist-server/server.cjs`, `dist-electron/main.cjs`, `dist-electron/preload.cjs`) |
| TypeScript Lint (Web + Electron) | `npm run lint` | Verified via `lint_applet` & `compile_applet` |

### Security Scan Verification
- Verified zero `shell: true` usages across `shared/`, `electron/`, `server/`, `server.ts`, and `src/services/desktopBridge.ts`.
- Verified zero hardcoded API keys or credentials.
- Verified every `shell.openPath()` call in `electron/main.ts` passes through canonical realpath containment and trusted semantic resolution.
- Verified secret scrubbing strips `apiKey`, `GEMINI_API_KEY`, `authorization`, and Bearer/`AIza...` tokens from manifests, `match-metadata.json`, `AI Analysis/*.json`, and `Diagnostics/*.json`.

---

## 4. Verification Scope & Honest Boundary

- **Verified Automatically (Linux Environment):** Canonical path resolution across v1 & v2 layouts, `process.cwd()` independence, packaged sibling directory layout (`database/` + `recordings/`), real FFmpeg/FFprobe MP4 validation & evidence frame extraction, real symlink escape blocking, crash recovery, Migration v6→v7 preservation, end-to-end mock Gemini analysis, error taxonomy, secret scrubbing, desktop bundling, and simulated Windows path/case-insensitivity checks.
- **Pending Native Windows Acceptance:** Actual Windows 10/11 Electron window capture of EA SPORTS FC 26, Windows File Explorer `shell.openPath()` actions, Windows junction testing, and live Gemini API (`gemini-3.1-flash-lite`) execution with a real key. Follow `/docs/PHASE_3_0_1_WINDOWS_TESTING_GUIDE.md` on Windows to complete final acceptance.
