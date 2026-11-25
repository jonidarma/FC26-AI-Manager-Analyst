# Phase 3.0.2 — Native Windows Acceptance Testing Guide

**Project:** FC26 AI Manager (`v3.0.2`)  
**Target Environment:** Windows 10 / Windows 11 (x64), Native Electron Desktop Build (`npm run build:desktop` / NSIS Installer)  
**Prerequisite:** Valid `GEMINI_API_KEY` set in the Windows environment or `.env` (never entered in the UI).

---

## 1. Quick-Path Verification: Re-Analyze Existing Chelsea vs Sunderland Recording (No Re-Recording Needed)

This workflow verifies the exact production bug from Phase 3.0.1 using your existing 3-segment (272.87 MB) legacy Chelsea vs Sunderland first-half recording without capturing new footage.

### Step 1: Build and Launch `v3.0.2`
1. Pull/sync the `v3.0.2` codebase on Windows and run:
   ```bash
   npm install
   npm run build:desktop
   ```
2. Launch the Electron desktop application (`npm run electron:dev` or packaged `win-unpacked\FC26 AI Manager.exe`).
3. Confirm the application boots cleanly with your existing local SQLite database intact (clubs, squads, tactical presets, and the Chelsea vs Sunderland match/recording all remain visible).
4. Confirm Migration v8 applied cleanly without data loss and any orphaned active job from Phase 3.0.1 was marked `interrupted` (`ANALYSIS_INTERRUPTED`) without auto-restarting uploads.

### Step 2: Configure & Verify Gemini Models in Settings
1. Open **Settings -> AI & Evidence Policy**.
2. Click **Refresh Available Models**.
   - Verify the dropdown populates with live models discovered from your `GEMINI_API_KEY` (deprecated/non-video models filtered out).
   - Verify `gemini-4-hydrogen` is no longer forced as the Balanced or Synthesis model.
3. Select your verified Primary Default Model (for example, `gemini-3.1-flash-lite` or `gemini-2.5-flash`).
4. Ensure **Use Primary Model for All Stages** is **ON** (checked).
5. Inspect the **Effective Model Routing Preview**:
   - Quick Video Model = your selected Primary Model
   - Balanced Video Model = your selected Primary Model
   - Deep Video Model = your selected Primary Model
   - Tactical Synthesis Model = your selected Primary Model
6. Click **Test Selected Model**:
   - Confirm structured JSON connectivity succeeds and shows latency + verified status.
7. Click **Test Video Compatibility**:
   - Confirm a synthetic 1-second test MP4 is generated, uploaded to Gemini Files API, processed, analyzed for structured JSON, and deleted remotely with `Video Ready` badge shown.
8. Verify the **Unsaved Changes** badge switches to **Saved** after clicking **Save AI Policy**.
9. **Persistence Check:** Close and completely restart the Electron app, return to **Settings -> AI & Evidence Policy**, and verify your selected Primary Default Model, **Use Primary Model for All Stages**, timeouts, retries, and proxy toggles persisted identically.

### Step 3: Re-Analyze Existing Chelsea vs Sunderland Legacy Recording
1. Navigate to **Half-Time Briefing** and select the existing **Chelsea vs Sunderland** match.
2. Confirm the legacy 3-segment (272.87 MB) first-half recording is detected as verified and AI-eligible.
3. **Pre-Launch Routing Check (BEFORE checking privacy authorization):**
   - Verify the pre-launch banner displays the exact **Effective Video Model** and **Effective Synthesis Model** matching Settings (e.g., `gemini-3.1-flash-lite` for both — NOT `gemini-4-hydrogen`).
4. Check **Force Re-analyze** (to bypass any prior cached run if applicable), check the **Privacy Upload Authorization** checkbox, and click **Analyze First Half**.
5. **Live Progress Honesty Check:**
   - Verify **Total Elapsed** and **Stage Elapsed** timers tick smoothly every second.
   - Verify discrete segment progress displays honestly (e.g., `Segment 1/3`, `Segment 2/3`, `Segment 3/3`) with a live activity indicator — NO fabricated percentage bar or fake ETA.
   - If FFmpeg analysis proxy is enabled (default ON), observe the **Proxy Size Reduction** summary (e.g., original 272.87 MB vs transcoded proxy MB).
6. **Completion & Remote Cleanup Check:**
   - Once completed, confirm the Half-Time Briefing, Gameplay Observations, Tactical Vision Assessment, and validated FC 26 Recommendations render cleanly.
   - Check the **Remote Media Cleanup** strip: all 3 uploaded remote Gemini files should report `deleted` with confirmation timestamps.
   - Verify in Windows File Explorer that all 3 original local `.mp4` files on disk remain completely intact and untouched.

---

## 2. Reliability & Failure-Mode Acceptance Checks

### Test A: Stage-Override Mode (`usePrimaryModelForAllStages = false`)
1. In **Settings -> AI & Evidence Policy**, disable **Use Primary Model for All Stages**.
2. Choose two distinct accessible models (e.g., `gemini-3.1-flash-lite` for Balanced Video and `gemini-2.5-flash` for Synthesis), save, and restart.
3. Open **Half-Time Briefing** and confirm the pre-launch banner shows both distinct models accurately before authorization.
4. Confirm previous completed jobs in history still display the original models they ran with (historical preservation).

### Test B: Preflight Block Before Upload (Invalid/Inaccessible Model)
1. Configure an inaccessible/non-existent model ID (or temporarily unset `GEMINI_API_KEY` in a test launch).
2. Attempt to launch First-Half Analysis.
3. Confirm analysis fails **immediately** in preflight with an exact code (`MODEL_NOT_FOUND` or `INVALID_API_KEY`) **before** any video bytes are uploaded.
4. Expand **Technical Diagnostics** and verify exact error code, stage, model ID, and sanitized message are shown — and verify no `AIza...` key substring appears anywhere. Click **Copy Diagnostics** to test clipboard copy.

### Test C: Mid-Run Cancellation & Orphan Remote Cleanup
1. Start a First-Half Analysis run (e.g., with `Force Re-analyze`).
2. While uploading or processing segment 1, click **Cancel Analysis**.
3. Confirm the job transitions immediately to `cancelled` (`ANALYSIS_CANCELLED`) and does not flip back to `uploading` or `failed`.
4. Confirm any already-uploaded remote file transitions to `deleted` automatically (or shows **Retry Remote Cleanup** if offline).

### Test D: Retry Remote Cleanup Button
1. If any asset shows `cleanup_pending`, `uploaded`, or `cleanup_failed` (for example after simulating an offline disconnect during cleanup), restore network access and click **Retry Remote Cleanup**.
2. Confirm the asset transitions to `deleted` with a confirmed timestamp while the local MP4 file remains untouched.

### Test E: Secret Hygiene Verification
1. Export a database backup from **Settings** and inspect the JSON file.
2. Confirm `GEMINI_API_KEY` never appears anywhere in the backup file, UI diagnostics, or Electron/server logs.
