# Windows 10/11 Live Capture & Phase 2.1 Manual Acceptance Test Checklist

> **Purpose**: Manual verification procedure on a real Windows 10/11 x64 machine running **EA SPORTS FC 26**.
> Automated Linux container tests (`npm run test:capture`, `npm run test:players`, `npm run test:phase21`) verify FFmpeg/FFprobe segmentation, IPC transport contract, watchdogs, diagnostics, SQLite Migration v4, Default Club Roster import, Tactical Presets, and Immutable Match Snapshots using synthetic streams and isolated temp databases — they **cannot** substitute for real Windows `desktopCapturer`, DirectX/Borderless Windowed capture, Windows loopback audio, or NSIS installer verification.

---

## Pre-Test Setup

1. Build and install on Windows 10/11 x64:
   ```powershell
   bun install
   npx electron-builder install-app-deps
   npm run prepare:ffmpeg:win64 -- --from-dir "C:\path\to\ffmpeg-win64\bin"
   npm run build:desktop
   npm run electron:dist:win
   ```
2. Install and launch `release/FC26 AI Manager — Windows Setup.exe`.
3. Verify `%APPDATA%\FC26 AI Manager\logs\backend-startup.log` records a clean backend start with zero `ERR_MODULE_NOT_FOUND` errors and that existing FC26 catalog players (`18,405`) are preserved after Migration v4.
4. Launch **EA SPORTS FC 26** and set Display Mode to **Borderless Windowed** (recommended).

---

## Section A — Recording Pipeline, Reliability & Watchdogs (Phase 2.1 Scenarios 1–12)

| # | Test Case | Steps | Expected Result | Pass / Fail |
|---|---|---|---|---|
| 1 | **Packaged Startup & FFmpeg Resolution** | Launch installed Windows app → open **Match Capture** → click **Inspect Prerequisites**. | App opens cleanly without backend errors; all prerequisites show `PASS`; FFmpeg resolves to `<installDir>\resources\ffmpeg\ffmpeg.exe`. | [ ] |
| 2 | **Browser Preview Isolation** | Open web preview (`npm run dev` on `127.0.0.1:3000`) in Chrome/Edge. | Capture controls remain disabled; UI honestly explains native Electron desktop runtime is required. | [ ] |
| 3 | **FC 26 Window Enumeration & Diagnostics Ready** | With FC 26 running, click **Refresh Sources** and expand **Recording Diagnostics**. | EA SPORTS FC 26 appears tagged `[FC 26 Detected]` with live thumbnail; diagnostics panel displays source ID, resolution, FPS, and transport state. | [ ] |
| 4 | **Normal First-Half Window Capture (Non-Zero MP4)** | Select FC 26 window → click **Start First-Half Recording** → record 30+ seconds → click **End First Half & Save**. | Preload transport port shows `Ready`; `MediaRecorder` chunks > 0; FFmpeg stdin bytes increase continuously; `segment_001.mp4` is > 0 bytes, FFprobe-valid H.264 (`yuv420p`), playable in VLC/Windows Media Player; match advances to `halftime_ready` with `aiEligible = true`. | [ ] |
| 5 | **Multi-Segment Rollover (2–5 min)** | Set Segment Length to 2 min → record ~4.5 minutes. | `segment_001.mp4`, `segment_002.mp4`, `segment_003.mp4` created cleanly under `%APPDATA%\FC26 AI Manager\recordings\<matchId>\<sessionId>\`; all FFprobe-verified with SHA-256. | [ ] |
| 6 | **Background / Minimized Window Recording** | Start recording FC 26 → minimize FC26 AI Manager while playing FC 26 for 2+ minutes. | `powerSaveBlocker` and `backgroundThrottling: false` keep chunk flow alive with zero stall watchdog trigger and smooth video playback. | [ ] |
| 7 | **Display Fallback Privacy Notice** | Select a `[Display Fallback]` monitor source and record 30 seconds. | Amber Display Fallback Privacy Notice appears; recording succeeds cleanly even if FC 26 is Exclusive Fullscreen. | [ ] |
| 8 | **Pause & Resume Continuity** | Start recording → **Pause** for 15s → **Resume** for 30s → **End First Half & Save**. | Same `sessionId`; active duration excludes pause; new segment increments cleanly (`segment_002.mp4`); both segments playable. | [ ] |
| 9 | **Zero-Byte / No-Frames Startup Watchdog Failure** | Trigger an unavailable/black capture source or block stream startup so 0 video bytes reach FFmpeg within 10s. | Startup Watchdog triggers actionable warning/failure; diagnostics panel auto-expands; stopping or failing produces `status = 'failed'`, `aiEligible = false`, **NEVER** advances match to `halftime_ready`, and enables **Retry First-Half Recording**. | [ ] |
| 10 | **Mid-Session Stall Watchdog & Game Window Close** | Start recording FC 26 → force-close FC 26 (`Alt+F4`) mid-recording. | Renderer `track.onended` (or 18s Stall Watchdog) stops cleanly; completed valid segments are preserved (`completed` or `partial`), 0-valid-segment sessions fail honestly; clear error & diagnostics shown. | [ ] |
| 11 | **Crash Recovery After Force-Kill** | Record 2.5 minutes (segment 1 finished, segment 2 writing) → terminate Electron via Task Manager → relaunch app. | **Interrupted Recording Sessions Detected** panel appears; **Recover Session** verifies `segment_001.mp4`, repairs/classifies `segment_002.mp4`, and updates SQLite accurately. | [ ] |
| 12 | **Diagnostics Export & Privacy Hygiene** | Click **Open Diagnostics Folder** and **Export Diagnostics** on a completed or failed session. | Folder opens to `diagnostics.log` + `diagnostics-summary.json`; exported JSON contains timestamps, MediaRecorder/IPC/FFmpeg counters, and sanitized args with **zero raw video bytes** and **zero microphone activation**. | [ ] |
| 13 | **Optional Loopback Game Audio & Second Half** | Enable Game Audio in Settings, record 30s Second Half, verify in VLC. | AAC game audio in sync, Windows microphone privacy icon remains OFF, separate `second_half` session persisted in **Match History**. | [ ] |
| 14 | **Clean Retry After Failed Session** | On a match whose first capture attempt ended in `failed`, click **Retry First-Half Recording** with a valid source. | New session starts cleanly for the same match, succeeds with valid MP4, and promotes match to `halftime_ready`. | [ ] |

---

## Section B — Squad Management, Display Names, Tactical Setup & Immutable Snapshots (Phase 2.1)

| # | Test Case | Steps | Expected Result | Pass / Fail |
|---|---|---|---|---|
| 15 | **Standardized UTF-8 Player Display Names** | Inspect players with accents/special characters (e.g. `Vinícius Júnior`, `Martin Ødegaard`, `Kylian Mbappé`) in Database Center, Squad Management, Tactical Setup pitch SVG, and Match Prep. | Full readable UTF-8 names render consistently with zero arbitrary truncation; custom `displayNameOverride` takes precedence when edited. | [ ] |
| 16 | **Automatic Default Club Roster Initialization** | Go to **Clubs → New Career Mode Club**, link a catalog club (e.g. Arsenal or Real Madrid). | Live roster preview shows exact matched player count from `catalog_players.club_id`; choosing **"Import Default Club Roster"** populates Squad Management automatically with positions, roles, ratings, and squad numbers. | [ ] |
| 17 | **Master Catalog Isolation & Duplicate Safety** | Edit a career player's overall, squad number, status (`Injured`/`Loaned Out`), or transfer out in **Squad Management**; re-run **Import Default Club Roster**. | Master FC26 Database record remains untouched; re-import skips existing players cleanly without creating duplicates. | [ ] |
| 18 | **Tactical Setup Presets & FC26 Validation** | Open **Tactical Setup** → create/edit a Tactical Preset → assign Starting XI + Bench + Roles + Focuses → click **Save Tactical Setup**. | Duplicate players across slots are blocked; invalid FC26 role/focus combinations are prevented; unavailable (`Injured`/`Suspended`) starter shows warning; preset persists across app restart. | [ ] |
| 19 | **Global Dirty-State Navigation Guard** | Make unsaved edits in **Tactical Setup** → click another sidebar view or switch active club. | **Unsaved Tactical Changes** modal appears with **Save Changes**, **Discard Changes**, and **Cancel**; all 3 actions behave deterministically. | [ ] |
| 20 | **Match Preparation & Immutable Pre-Match Snapshot** | Open **Match Preparation** → select a saved Tactical Preset → optionally apply a match-only override → create match → start First-Half Recording. | Club's saved Tactical Preset is NOT mutated by match-only override; pre-match tactical snapshot locks (`isLocked = true`) when recording starts; later edits to Club Tactical Setup do NOT alter the historical match snapshot. | [ ] |
| 21 | **Backup & Restore v5 Round-Trip** | Export Database Backup in **Settings** → verify JSON format `fc26-ai-manager-backup-v5` includes tactical presets, club aliases, match snapshots, and recording diagnostics. | Export succeeds cleanly and restores without corrupting foreign keys or catalog tables. | [ ] |

---

## Section C — Phase 2.2 Tactical Validation, Squad Eligibility, Master Catalog & Diagnostics

| # | Test Case | Steps | Expected Result | Pass / Fail |
|---|---|---|---|---|
| 22 | **Canonical FC 26 Formation Slot Validation** | Open **Tactical Setup** → select `4-2-3-1 Wide` → assign distinct players to Left/Right `CB` and Left/Right `CDM` slots with valid FC IQ roles/focuses → click **Save Tactical Setup**. | Position column displays canonical FC 26 codes (`GK, LB, CB, CB, RB, CDM, CDM, LM, CAM, RM, ST`) with subtle `Left`/`Right` hints; zero `Position "LCB" is not a recognized FC 26 position code` errors; left/right slots persist independently. | [ ] |
| 23 | **Centralized Squad Eligibility Guards** | Mark a starter `Injured`, `Suspended`, or `Loaned Out` in **Squad Management** → return to **Tactical Setup** and **Match Preparation**. | Ineligible players are hidden by default in pickers (visible & disabled when toggling **Show Unavailable Players**); existing preset shows blocking banner + 1-click eligible replacement buttons; **Save as Draft** preserves work while **Save Tactical Setup** (Match-Ready), match creation, and recording start on scheduled matches are blocked until fixed; `Doubtful` players require explicit confirmation checkbox; `Youth Academy` players require promotion or `Senior Selection Authorized`. | [ ] |
| 24 | **Complete FC 26 Club & League Reconciliation (20/20 PL + Everton)** | Open **FC26 Database Center → Overview** (or run `bun run catalog:reconcile -- --preview` and `--execute`) → search `Everton`, `Lombardia FC`, `Milano FC`, `Bergamo Calcio`, `Latium`. | Non-destructive reconciliation expands starter clubs/leagues/nations from imported `catalog_players` with 0 duplicates; Premier League shows `20 / 20` with Everton verified; Italian unlicensed aliases resolve to their Serie A clubs; women's baseline clubs remain separate; re-running reconciliation reports 0 new inserts. | [ ] |
| 25 | **Everton Default Roster Initialization & Career Isolation** | Go to **Clubs → New Career Mode Club** → search & link **Everton** → import default roster snapshot → edit or loan out a player → click **Import Missing Default FC26 Players**. | All Everton snapshot players populate cleanly; repeat import skips existing players without duplicates and never overwrites Career Mode status/ratings or reactivates loaned-out/released players. | [ ] |
| 26 | **Lifetime FFmpeg Stdin Diagnostics After Pause/Resume & Stop** | Record First Half on Windows with a Pause → Resume → End First Half & Save → inspect **Recording Diagnostics** & `diagnostics-summary.json`. | Final diagnostics report non-zero `lifetimeSessionStdinBytesWritten` and `ffmpegStdinBytesWritten` even after FFmpeg exits cleanly (`currentProcessStdinBytesWritten = 0`); microphone remains disabled and zero files are uploaded. | [ ] |
| 27 | **Honest Phase 3 Readiness States** | After finalizing a verified First-Half recording, inspect **Match Capture → Recorded Halves** and **Half-Time Briefing**. | UI clearly distinguishes `Recording Verified`, `Technically AI-Eligible`, and `Awaiting Analysis (Phase 3)` (never claiming analysis is complete or triggering Gemini calls). | [ ] |

