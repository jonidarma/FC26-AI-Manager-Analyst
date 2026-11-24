# Windows 10/11 Live Capture Acceptance Test Checklist (Phase 2)

> **Purpose**: Manual verification procedure on a real Windows 10/11 x64 machine running **EA SPORTS FC 26**.
> Automated Linux container tests verify FFmpeg/FFprobe segmentation, manifests, state transitions, IPC validation, and SQLite persistence using synthetic video streams — they **cannot** substitute for real Windows `desktopCapturer`, DirectX/Borderless Windowed capture, Windows loopback audio, or NSIS installer verification.

---

## Pre-Test Setup

1. Build and install on Windows 10/11 x64:
   ```powershell
   npm run prepare:ffmpeg:win64 -- --from-dir "C:\path\to\ffmpeg-win64\bin"
   npm run electron:dist:win
   ```
2. Install `release/FC26 AI Manager — Windows Setup.exe`.
3. Launch **EA SPORTS FC 26** and set Display Mode to **Borderless Windowed** (recommended).
4. Launch **FC26 AI Manager**, confirm active Career Mode club exists, and create a new match in **Match Preparation**.

---

## 22-Item Windows Acceptance Checklist

| # | Test Case | Steps | Expected Result | Pass / Fail |
|---|---|---|---|---|
| 1 | **Packaged FFmpeg Resolution** | Open **Match Capture** → click **Inspect Prerequisites**. | All 8 prerequisites show `PASS`; source shows `packaged-resource` under `<installDir>\resources\ffmpeg\ffmpeg.exe`; `localFfmpegRecording` is active. | [ ] |
| 2 | **Browser Preview Isolation** | Open the web preview in Chrome/Edge (`npm run dev` on `127.0.0.1:3000`). | Capture controls remain disabled; banner honestly states native Windows capture requires Electron. | [ ] |
| 3 | **FC 26 Window Enumeration** | With FC 26 running, click **Refresh Sources**. | EA SPORTS FC 26 appears at the top tagged `[FC 26 Detected]`; live thumbnail renders. | [ ] |
| 4 | **Display Fallback Privacy Notice** | Select a `[Display Fallback]` monitor source. | Amber Display Fallback Privacy Notice appears warning about desktop notifications, taskbar, and Alt-Tab content. | [ ] |
| 5 | **Single Match Binding** | Select the prepared match in **Bound Match ID**. | Match selector locks once recording starts; cannot switch matches mid-recording. | [ ] |
| 6 | **First-Half Recording Start** | Select FC 26 window → click **Start First-Half Recording**. | Recording starts cleanly; TopBar displays live red `REC · 1st Half` timer & segment #; FFmpeg status shows `running`. | [ ] |
| 7 | **Zero Live AI / Zero Gameplay Interruption** | Play 4+ minutes of first-half FC 26 gameplay. | Zero AI notifications, zero popups, zero Gemini API calls, zero controller/keyboard interception. | [ ] |
| 8 | **Automatic Segmentation (2–5 min)** | Set Segment Length to 2 min and record for ~4.5 minutes. | `segment_001.mp4`, `segment_002.mp4`, and `segment_003.mp4` created inside `%APPDATA%\FC26 AI Manager\recordings\<matchId>\<sessionId>\` (NO duplicate `recordings\recordings\` folder!). | [ ] |
| 9 | **Navigation Persistence** | While recording is active, navigate to Dashboard, Tactical Board, Match History, and Settings. | Recording continues uninterrupted; TopBar timer keeps ticking; clicking TopBar badge returns to Match Capture. | [ ] |
| 10 | **Minimize / Background Recording** | Minimize FC26 AI Manager while playing FC 26 in Borderless Windowed mode. | Capture continues smoothly without frame drop freeze or stream stop. | [ ] |
| 11 | **Pause & Resume Continuity** | Click **Pause Recording**, wait 15 seconds, click **Resume Recording**, record 30 seconds. | Same `sessionId` retained; active duration excludes the 15s pause; paused segment cleanly closed and resumed segment increments index (`segment_002.mp4`). | [ ] |
| 12 | **End First Half & Finalization** | Click **End First Half & Save**. | Transitions through `finalizing` → `completed`; every segment verified with FFprobe & SHA-256; Match status updates to `halftime_ready`. | [ ] |
| 13 | **Local MP4 Playback & Quality** | Click **Play Segment** on each recorded `.mp4` (or open in VLC / Windows Media Player). | H.264 (`yuv420p`) playback is smooth, pitch markings & players are crisp, aspect ratio is preserved (no stretching). | [ ] |
| 14 | **Video-Only Default & Microphone Block** | Verify default recording (`audioEnabled = false`) in VLC / FFprobe. | Zero audio track present; Windows microphone privacy indicator NEVER activates at any point. | [ ] |
| 15 | **Optional Windows Loopback Audio** | Enable Game Audio in **Settings**, record 30s of FC 26 gameplay, play segment. | AAC game audio plays cleanly in sync; microphone remains inactive. | [ ] |
| 16 | **Second-Half Optional Lifecycle** | Click **Start Second-Half Recording**, record 1 min, click **End Second Half & Save**. | Separate `sessionId` created for `second_half`; `hasSecondHalfRecording` becomes `Yes` in UI and SQLite. | [ ] |
| 17 | **Match History Persistence** | Restart FC26 AI Manager → open **Match History** → click **Recordings**. | Both First Half and Second Half sessions persist across restart with durations, sizes, integrity statuses, and working **Play MP4** / **Folder** buttons. | [ ] |
| 18 | **Discard With Explicit Confirmation** | Start a short recording → click **Discard** → confirm; then test **Discard** on a finalized session. | Active discard requires 1 confirmation; finalized discard requires 2-step confirmation; ONLY that session's MP4 files are removed; other sessions & matches untouched. | [ ] |
| 19 | **Unexpected Game Window Closure** | Start recording FC 26 window → force-close FC 26 (`Alt+F4`). | Renderer `track.onended` triggers graceful finalization; completed segments are preserved and verified; clear interruption message shown. | [ ] |
| 20 | **Crash Recovery After Force-Kill** | Start recording for 2.5 minutes (so `segment_001.mp4` completes and `segment_002.mp4` is writing) → kill Electron via Task Manager → relaunch app. | **Interrupted Recording Sessions Detected** panel appears in Match Capture; **Inspect Recovery Details** shows segment counts; **Recover Session** verifies `segment_001.mp4`, repairs or classifies `segment_002.mp4`, and syncs to SQLite. | [ ] |
| 21 | **Graceful App Close During Recording** | Start recording → close FC26 AI Manager window (`X` or `Alt+F4`). | `before-quit` waits cleanly (bounded timeout) to flush FFmpeg, save manifest & SQLite, and exits with zero orphan `ffmpeg.exe` processes in Task Manager. | [ ] |
| 22 | **Exclusive Fullscreen Fallback Check** | Switch FC 26 to Exclusive Fullscreen and test Window vs Display capture. | If Windows DWM blocks window capture in Exclusive Fullscreen, selecting Display Fallback records gameplay cleanly with privacy warning shown; Borderless Windowed remains recommended. | [ ] |
