# Phase 3 Windows 10/11 Manual Acceptance Testing Guide (v3.0.0)

This guide covers end-to-end verification of **Phase 3 (Tactical Vision Engine, Coaching Staff, Real Gemini Video Intelligence & AI Half-Time Analyst)** on your Windows 10/11 x64 PC running EA SPORTS FC 26.

---

## 1. Local Repository Update, Build & Automated Verification (PowerShell)

Run these commands from your local `FC26-AI-Manager-Analyst` directory in PowerShell:

```powershell
# 1. Pull latest Phase 3 changes
git pull origin main

# 2. Install/sync dependencies (Bun or npm)
bun install
# or: npm install

# 3. Verify bundled Windows FFmpeg / FFprobe binaries
npm run prepare:ffmpeg:win64 -- --verify

# 4. Run full automated regression + Phase 3 test suites (isolated temp DBs — safe for your AppData)
npm run test:players
npm run test:capture
npm run test:phase21
npm run test:phase22
npm run test:phase3

# 5. Typecheck & build full Electron desktop bundle
npm run lint
npm run build:desktop
```

### Configuring `GEMINI_API_KEY` (Strictly Server-Side — Never in UI)

Create or edit `.env` in your repository root (or set a Windows User Environment Variable) **before** launching Electron:

```env
GEMINI_API_KEY=your_real_gemini_api_key_here
```

Then start the desktop application:

```powershell
npm run electron:start
```

---

## 2. Manual Windows Acceptance Tests (A–F)

### Test A — Tactical Vision Engine, Coaching Staff & 3-Layer Evaluation
1. Open **FC26 Database Center → Tactical Visions**.
   - Verify all **7 EA SPORTS FC 26 Tactical Visions** appear (`Standard`, `Wing Play`, `Possession`, `High Pressing`, `Park the Bus`, `Counter Attack`, `Kick and Rush`).
   - Search the **Role Affinity Matrix** (e.g. search `Wide Half` or `False 9`) and confirm source provenance & official conflict notes are visible.
2. Open **Career Mode Clubs**:
   - Select your active club and set **Primary Tactical Vision** (e.g., `Possession`), **Alternative Vision**, and **Tactical Flexibility**.
   - Add a **Club Coach** (e.g., `Midfield`, `Possession`, `Gold`, `5★`) and save; restart the app and verify persistence.
3. Open **Tactical Setup**:
   - Select `Possession` as Tactical Vision while leaving **Build-Up Style** on `Counter`.
   - **Verify**: Build-Up Style is **NOT** silently overwritten. The live **3-Layer Tactical Evaluation** panel flags a **Layer 2 Official Conflict** and displays the 1-click **"Fix Build-Up Style -> Short Passing"** button.
   - Assign `Poacher` to `ST` under `Possession`. **Verify**: Layer 1 remains **Legal & Selectable** while Layer 3 marks `Poacher` as advisory `Not Associated` (never blocked).
   - Click **Compare Visions** and **Optimize for Vision** (test `Minimal Adjustment`, `Role Optimization`, `Squad Optimization`, `Full Tactical Optimization`). Confirm preview diff shows before/after without modifying your saved preset until you explicitly click **Apply Selected**.

---

### Test B — AI Settings, Model Registry & Live Gemini Connection Test
1. Open **Settings → AI & Evidence Policy**.
   - Confirm there is **no API key input box** anywhere in the UI.
   - Verify **Server GEMINI_API_KEY Status** shows `Configured` (once `.env` is set).
   - Click **Test API Connection** and confirm real latency and `OK` status against `gemini-4-hydrogen` (or your selected model).
   - Verify Daily Budget Cap and Per-Match Budget Cap fields save cleanly.

---

### Test C — Real EA SPORTS FC 26 First-Half Recording & Live Gemini Half-Time Analysis
1. Create a match in **Match Preparation** with your active club preset (including its Tactical Vision).
2. Open **Match Capture** and record **1–3 minutes** of actual EA SPORTS FC 26 first-half gameplay using Window Capture (`EA SPORTS FC 26`).
3. Stop recording and verify the session shows **Verified** and **AI-Eligible**.
4. In **Match Capture** (or **Half-Time Briefing**):
   - Choose **Analysis Mode** (`Quick` or `Balanced`) and **Language** (`English` or `Bahasa Indonesia`).
   - Check the explicit **Privacy Authorization** box (and **Entire Display** box if you captured a screen instead of the game window).
   - Click **Analyze First Half**.
5. **Verify Live 17-State Progress & Briefing**:
   - Watch progress advance through validating → preprocessing → uploading → media processing → Stage 1 classifying → Stage 2 observations → Stage 3 synthesis → validating results → completed.
   - Confirm **Remote Media Cleanup** shows `deleted` for every uploaded segment.
   - Inspect **Executive Briefing & Vision** (Sections A, B, C): check that HUD stats only show values actually visible on screen (no fabricated xG/possession).
   - Inspect **Evidence Timeline & Frames**: verify Stage 1 classifications, replay deduplication, honest `Unknown` player attribution when names are unreadable, and click **View Frame** to confirm real extracted JPEG evidence frames load in the lightbox.

---

### Test D — Non-Gameplay / Menu-Only Honesty Check
1. Record a short 15–20 second clip showing only the FC 26 pause menu or squad hub (no live match gameplay).
2. Run **Analyze First Half** on that clip.
3. **Verify**: The job completes with status **`insufficient_gameplay`**, **0 fabricated gameplay observations**, and **0 fabricated tactical recommendations**.

---

### Test E — Manager Decisions, Half-Time Snapshot Immutability & Save as Club Preset
1. In **Half-Time Briefing → Recommendations & Decisions**:
   - Accept or Modify 1–2 validated recommendations; Reject another.
   - Click **Apply Accepted to Half-Time Snapshot**.
   - **Verify**: A separate **`In-Match Adjustment`** snapshot is created while the original **`Pre-Match (Immutable)`** snapshot remains completely unchanged.
   - Click **Mark Applied in FC26** after applying the change inside FC 26.
   - Click **Save as Club Preset** and verify it appears as a new preset in **Tactical Setup**.

---

### Test F — Second-Half Recording & Stage 4 Comparison + Backup/Restore Safety
1. Record a second-half clip for the same match in **Match Capture** and run **Analyze Second Half**.
2. Open the **Second-Half Comparison** tab and verify side-by-side comparison, user-confirmed adjustments status, and explicit **causation caveats**.
3. Open **Settings → Database & Backup**, export a backup JSON, and verify:
   - The JSON file has `"format": "fc26-ai-manager-backup-v6"`.
   - Searching the exported JSON for your `GEMINI_API_KEY` returns **zero matches**.
4. Test **Restore Backup** (or test on a copy) and confirm your clubs, presets, visions, coaches, and briefings remain intact.
