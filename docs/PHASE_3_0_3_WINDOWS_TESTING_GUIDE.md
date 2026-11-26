# Phase 3.0.3 Windows Acceptance Testing Guide (`v3.0.3`)

This checklist verifies Phase 3.0.3 on native **Windows 10/11** with the packaged Electron desktop application, a real `GEMINI_API_KEY`, and genuine EA SPORTS FC 26 gameplay recordings.

> **Note:** Automated regression tests (133/133) verified all backend, SQLite, FFmpeg, validation, failover, checkpoint, and sequential-frame logic using synthetic clips and mock Gemini clients in Linux. Live Gemini API and native Windows Electron acceptance must be confirmed via the steps below.

---

## Prerequisites

1. Build and launch the Windows Electron build (`v3.0.3`) with `GEMINI_API_KEY` configured in the desktop environment (`.env` or Windows system/user environment variable — never entered in UI).
2. Confirm an existing EA SPORTS FC 26 First-Half recording session is available and marked `verified` / `aiEligible: true`.
3. Back up your existing `%APPDATA%/fc26-ai-manager/` database folder before testing Migration `v8 -> v9`.

---

## Test Plan

### Test 1 — Non-Destructive Startup & Migration v8 → v9
1. Launch FC26 AI Manager `v3.0.3` against your existing `v3.0.2` SQLite database.
2. **Expected:**
   - Existing Career Mode clubs, squads, tactical presets, match history, and recording sessions load intact.
   - No error banner on startup.

### Test 2 — Four Independent Model Capability Probes (Settings View)
1. Navigate to **Settings → Gemini AI Configuration**.
2. Click **Refresh Models** to populate the live model registry for your API key.
3. Select your desired primary model (e.g., `gemini-2.5-flash` or `gemini-3.1-flash-lite`) and run all four probe buttons individually:
   - **Test Text & JSON**
   - **Test Image**
   - **Test Inline Video**
   - **Test Files API Video**
4. **Expected:**
   - Each probe reports independent pass/fail latency and exact error code (if unsupported).
   - Running **Test Image** does NOT clear the verified badge from **Test Text & JSON**.
   - **Test Files API Video** uploads a tiny 1s MP4, polls to `ACTIVE`, runs JSON inference, and displays **Remote file deleted (confirmed)** (`remoteCleanupConfirmed: true`).
   - Model Registry table displays all 4 capability columns (`Text/JSON`, `Image`, `Inline Video`, `Files API`) plus the **Health** column.

### Test 3 — Real Gameplay Quick Mode Analysis (Regression Check for `CHECK constraint failed`)
1. Open a match with a verified First-Half recording in **Half-Time Briefing**.
2. Choose **Quick** analysis mode and start First-Half Analysis (with privacy consent checked).
3. **Expected:**
   - Stage 1 (`classifying_gameplay`), Stage 2 (`analyzing_gameplay`), and Stage 3 (`generating_briefing`) complete without any `CHECK constraint failed: confidence IN ('High', 'Medium', 'Low')` error.
   - If the model returned non-canonical casing/numeric confidence values, the **AI Response Validation Audit** strip displays the normalized count (`Normalized: N`) and `Local DB Errors: 0`.
   - Remote uploaded media status transitions to `deleted` after completion, while the local MP4 recording remains untouched.

### Test 4 — Adaptive Failover Policy & Cost Guardrail (Settings + Half-Time Briefing)
1. In **Settings → AI Policy**:
   - Enable **Adaptive Model Failover**.
   - Add a comma-separated **Fallback Model Chain** (e.g., `gemini-2.5-flash-lite, gemini-2.5-flash`).
   - Leave **Allow higher-cost failover (e.g., Flash → Pro)** unchecked first to verify cost protection.
   - Click **Save Settings**, reload the app, and confirm all Phase 3.0.3 settings persisted cleanly.
2. Test **Reset Model Health** button in Settings if any model enters `degraded` or `cooldown` during testing.
3. **Expected:**
   - If a primary model fails mid-stage with a retryable/upstream error (e.g., `503` or `429`), the **Adaptive Failover History** strip in Half-Time Briefing shows `fromModel -> toModel (reasonCode · reused remote file)` without re-uploading the segment.

### Test 5 — Opt-In Stage Checkpoints & Clear Checkpoints
1. On a multi-segment First-Half recording, cancel the job after Segment 1 finishes Stage 2 (while Segment 2 is uploading or processing).
2. Return to **Half-Time Briefing** for the same match and half.
3. **Expected:**
   - A **Saved Stage Checkpoints Available** banner appears listing completed segment(s) (e.g., Segment `#1`).
   - Verify that clicking **Start Analysis** WITHOUT checking **Resume from saved stage checkpoints** runs a fresh full upload (never auto-resumes).
   - Repeat with **Resume from saved stage checkpoints** checked: Segment `#1` displays `Restored segment 1 ... from verified checkpoint` and only Segment `#2` uploads to Gemini.
   - Test **Clear Checkpoints** and confirm the saved-checkpoints banner disappears.

### Test 6 — Opt-In Sequential Keyframe Fallback
1. In **Settings → AI Policy**, enable **Allow Sequential Keyframe Fallback**, set Interval `6s` and Max Frames `18`, and save.
2. In **Half-Time Briefing**, select **Media Strategy → Sequential Keyframes (Fallback)** (or trigger fallback after native video failure) and run analysis.
3. **Expected:**
   - Job header displays the **Sequential Frames Fallback** strategy badge.
   - Briefing completes with status `completed_with_limitations` and explicitly discloses in **Limitations** that discrete keyframes were sampled instead of continuous native video.
   - Original MP4 recording file size and checksum remain 100% unchanged, and `%APPDATA%/fc26-ai-manager/analysis_temp/<jobId>` is removed after completion.

### Test 7 — Error Domain Diagnostics & Secret Safety
1. Temporarily select an unavailable model ID or disconnect Wi-Fi to trigger a failure.
2. Expand **Technical Diagnostics** in Half-Time Briefing.
3. **Expected:**
   - Error Domain badge accurately distinguishes `Gemini API Error`, `Network / Upstream Error`, `AI Validation Error`, `Local Media / FFmpeg Error`, or `Local Database Error`.
   - `GEMINI_API_KEY` never appears anywhere in the UI, diagnostics panel, exported analysis JSON, or Backup v9 JSON export.
