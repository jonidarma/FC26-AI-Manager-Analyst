# Phase 3.0.1 — Windows 10/11 Acceptance Testing Guide

**Target Build:** FC26 AI Manager v3.0.1 (Windows x64 Desktop Installer / `win-unpacked`)  
**Prerequisites:** Windows 10/11 x64, EA SPORTS FC 26 installed, valid `GEMINI_API_KEY` configured in local desktop environment/Settings, existing legacy v1 recording from Phase 3.0.0 testing (for Track A).

> **Honesty Notice:** Automated tests in this repository verify media resolution, FFmpeg/FFprobe processing, structured v2 layout, symlink confinement, crash recovery, and mock Gemini analysis on Linux with simulated Windows path tests. Native Windows Electron capture, File Explorer shell actions, and live Gemini API analysis must be confirmed directly on Windows using this checklist.

---

## Track A — Regression Fix on Existing Legacy v1 Recording (No Re-Recording Required)

1. Launch **FC26 AI Manager v3.0.1** on Windows with your existing `%APPDATA%\fc26-ai-manager\` data directory intact.
2. Confirm startup succeeds cleanly and **Database Migration v7** runs without modifying or moving:
   - `%APPDATA%\fc26-ai-manager\database\fc26_manager.db`
   - `%APPDATA%\fc26-ai-manager\recordings\{matchId}\{sessionId}\segment_001.mp4`
3. Open **Settings → Capture & Storage** and verify:
   - Authoritative Storage Root shows `%APPDATA%\fc26-ai-manager`
   - Legacy Recordings Root shows `%APPDATA%\fc26-ai-manager\recordings`
   - Legacy v1 session count matches your previously recorded matches
   - Clicking **Open Storage Folder** opens Windows File Explorer directly to `%APPDATA%\fc26-ai-manager`
4. Navigate to the previously recorded match that failed in v3.0.0 with `Security block: media path "segment_001.mp4"`.
5. Launch **First-Half Analysis** (live Gemini API with `gemini-3.1-flash-lite` or configured model):
   - Confirm no `Security block` or `GEMINI_ANALYSIS_ERROR` occurs.
   - Confirm FFprobe integrity validation passes, video uploads cleanly, evidence frames are extracted, and the Half-Time Briefing renders normally.

---

## Track B — Brand-New Structured Career Mode Recording (Layout v2)

1. Open **Match Preparation** and configure a fixture (for example: `Chelsea` vs `Sunderland`, Competition `Premier League`, In-Game Date `2027-09-11`, Formation `4-2-3-1 Wide`).
2. Verify the **Recording Storage Preview (v2)** card under the pitch preview displays:
   - Career Folder: `Chelsea-Career-Mode`
   - Match Folder: `Chelsea-vs-Sunderland (Premier League) 2027-09-11`
   - First Half Video Preview: `Chelsea vs Sunderland (Premier League) 4-2-3-1 Wide 2027-09-11 Part 1.mp4`
3. Temporarily clear the In-Game Match Date field and verify:
   - Preview updates to `Date-Unknown` with a yellow warning banner (does **not** silently insert today's real-world clock date).
   - Restore `2027-09-11` and save/start Match Preparation.
4. Go to **Match Capture**, select the **EA SPORTS FC 26** window, and click **Start First Half Recording**:
   - Record at least 15–30 seconds of live gameplay (optionally pause and resume once to produce `Part 1.mp4` and `Part 2.mp4`).
   - Stop recording and confirm the active **Recording Storage** card shows `Layout v2`, the structured folder path, and human-readable filename(s).
   - Click **Open Recording Folder** and confirm File Explorer opens `%APPDATA%\fc26-ai-manager\Chelsea-Career-Mode\Chelsea-vs-Sunderland (Premier League) 2027-09-11\First Half\`.
   - Confirm zero leftover `.fc26_seg_*.mp4` temp files remain after recording stops.
5. Run **First-Half AI Analysis**:
   - Confirm completion and inspect `%APPDATA%\fc26-ai-manager\Chelsea-Career-Mode\Chelsea-vs-Sunderland (Premier League) 2027-09-11\`:
     - `Evidence Frames\First Half\*.jpg` exists and renders in the UI
     - `AI Analysis\first-half-analysis.json` exists and contains **no** `GEMINI_API_KEY` or secret values
     - `Diagnostics\first-half-recording-diagnostics.json` exists and is secret-free
     - `match-metadata.json` exists and lists the match, formation, session, and segments
6. Test **Second-Half Confirmed Formation Rule**:
   - **Unconfirmed check:** Without confirming any in-game adjustment, inspect the Second Half preview — it must retain `4-2-3-1 Wide`.
   - **Confirmed adjustment:** Apply an accepted recommendation changing formation to `4-3-3 Holding` and explicitly check **Applied in FC 26** (`applied_in_game_confirmed = 1`).
   - Record the **Second Half** and verify File Explorer shows:
     - `Second Half\Chelsea vs Sunderland (Premier League) 4-3-3 Holding 2027-09-11 Part 1.mp4`
   - Run **Second-Half Comparison Analysis** and verify `AI Analysis\second-half-analysis.json` and `AI Analysis\match-comparison.json` are written.

---

## Track C — Match History, Error Handling & Crash Recovery

1. Open **Match History**, expand the new v2 match, and test:
   - **Open Match Folder**, **Open First Half Folder**, **Open Second Half Folder**, and **Copy Recording Path**.
   - Confirm segment rows display the human-readable `Part 1.mp4` filename.
2. **Missing File Error Classification Check** (on a disposable test match):
   - Temporarily rename or move a recorded `Part 1.mp4` outside the folder and trigger analysis.
   - Confirm the error clearly reports `MEDIA_FILE_NOT_FOUND` (not `GEMINI_ANALYSIS_ERROR`).
3. **Crash Recovery Check** (optional):
   - Start a v2 recording, wait 10 seconds, force-close the app via Task Manager, and relaunch.
   - Confirm the Recovery banner detects the interrupted v2 session and recovers/renames the segment cleanly.
