# Phase 3.0.2 Engineering Report — Gemini Model Routing & Analysis Pipeline Reliability

**Project:** FC26 AI Manager — Football Tactical Intelligence System  
**Repository:** `jonidarma/FC26-AI-Manager-Analyst`  
**Version:** `3.0.1` -> `3.0.2`  
**Target Platform:** Native Windows 10/11 Electron Desktop (`x64`)

---

## 1. Root Cause Analysis of the Phase 3.0.1 Windows Failure

During real Windows EA SPORTS FC 26 acceptance testing on the existing 3-segment (272.87 MB) legacy recording, the Gemini connection test succeeded with `gemini-3.1-flash-lite`, yet launching First-Half Analysis failed after `43.3s` during `Classifying gameplay vs menus/replays (segment 1/3)` with:

- Displayed error: `Analysis Failed (NETWORK_OR_UPSTREAM_TRANSIENT) — Transient network or Gemini service error occurred.`
- Displayed configuration mismatch: Primary Default Model `gemini-3.1-flash-lite`, Active Video Model `gemini-4-hydrogen`, Active Synthesis Model `gemini-4-hydrogen`, Remote Media Cleanup stuck at `pending`.

Investigation uncovered **four compounding root causes**:

1. **Silent Settings Stripping in `server.ts` (`settingsPatchSchema`):**  
   `PUT /api/settings` validated `ai` patches against mismatched Zod keys (`quickModelId`, `balancedModelId`, `deepModelId`, `synthesisModelId`) instead of the canonical domain keys (`quickAnalysisModelId`, `balancedAnalysisModelId`, `deepAnalysisModelId`, `tacticalSynthesisModelId`), and similarly mismatched timeout/retry/proxy keys. Saving Settings silently stripped stage overrides, leaving `balancedAnalysisModelId` and `tacticalSynthesisModelId` permanently stuck at legacy `'gemini-4-hydrogen'`.
2. **No Single Authoritative Model Router & Hardcoded Legacy Fallbacks:**  
   `aiAnalysisOrchestrator.ts` resolved stage models ad hoc with hardcoded `'gemini-4-hydrogen'` fallbacks instead of honoring the user's configured Primary Default Model through one shared routing resolver.
3. **Upstream Error Masking:**  
   Sending the uploaded video segment to `'gemini-4-hydrogen'` failed upstream after 43.3s, and the old coarse error classifier collapsed the actual HTTP/SDK error into `NETWORK_OR_UPSTREAM_TRANSIENT`, hiding the real model/access failure from the user and omitting stage/model/HTTP diagnostics.
4. **Unbounded SDK Calls & Late Remote File Persistence:**  
   `LiveGeminiVideoProvider` lacked per-stage timeouts and `AbortSignal` propagation across `files.upload`, `files.get`, and `models.generateContent`, and `ai_analysis_assets.remote_file_name` was only persisted *after* `uploadAndAwaitActive()` returned `ACTIVE`, leaving uploaded remote files orphaned or stuck in `pending` cleanup whenever processing failed, timed out, or was cancelled.

---

## 2. Summary of Architectural Fixes Implemented

### P0 — Authoritative Model Routing & Full Settings Persistence
- Added `server/services/geminiModelRouter.ts` (`resolveEffectiveModelRouting()`), now the single source of truth across Settings preview (`GET /api/ai/model-routing`), Connection Test (`POST /api/ai/test-connection`), Preflight (`POST /api/matches/:id/analysis/preflight`), and Job Execution (`startAnalysisJob()`).
- Fixed `settingsPatchSchema.ai` in `server.ts` to accept all canonical `v3.0.2` keys plus legacy aliases; updated `normalizeAiSettings()` in `server/services/repository.ts` to automatically upgrade legacy Phase 3.0.0/3.0.1 configs by clearing stale `'gemini-4-hydrogen'` / `'gemini-4-neon'` stage placeholders and enabling `usePrimaryModelForAllStages = true` so the user's chosen Primary Default Model takes effect immediately.
- Removed all `'gemini-4-hydrogen'` production defaults/fallbacks across backend and frontend; updated default fallback registry to current public Gemini models (`gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-pro`).
- Historical completed jobs retain their recorded `modelVideoId` and `modelSynthesisId` immutably when Settings change; re-analysis runs with the newly saved routing.

### P1 — Dynamic Model Discovery, Live Capability Probes & 8-Gate Preflight
- Added `discoverAvailableGeminiModels()` (`client.models.list()`) filtering deprecated and non-video models, flagging inaccessible configured models, and caching results in SQLite (`gemini_model_capabilities_cache`, Migration v8).
- Added `verifyModelCapabilities()` supporting both structured JSON verification (`POST /api/ai/models/test`) and live 1-second synthetic FFmpeg MP4 video compatibility probing (`POST /api/ai/models/test-video`) with guaranteed remote and temp cleanup.
- Implemented `runAnalysisPreflight()` (8 gates: privacy consent, API key presence, routing validity, live model access & video support, session ownership/eligibility, media path security + FFprobe integrity, FFmpeg proxy readiness, and per-match/daily budget guardrails) before uploading any video bytes.

### P2 — Exact 19-Code Error Taxonomy & Secret-Scrubbed Diagnostics
- Upgraded `classifyGeminiError()` in `server/services/geminiService.ts` to classify all 19 exact error codes (`INVALID_API_KEY`, `API_KEY_REVOKED`, `MODEL_NOT_FOUND`, `MODEL_ACCESS_DENIED`, `MODEL_VIDEO_UNSUPPORTED`, `QUOTA_EXCEEDED`, `BILLING_REQUIRED`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `MEDIA_PROCESSING_FAILED`, `VIDEO_UPLOAD_TIMEOUT`, `VIDEO_PROCESSING_TIMEOUT`, `INFERENCE_TIMEOUT`, `SCHEMA_VALIDATION_FAILED`, `SAFETY_OR_EMPTY_RESPONSE`, `NETWORK_CONNECTION_FAILED`, `UPSTREAM_SERVICE_UNAVAILABLE`, `ANALYSIS_CANCELLED`, `ANALYSIS_INTERRUPTED`).
- Added `sanitizeDiagnosticText()` to scrub `AIza...`, `Bearer ...`, `key=...`, and `process.env.GEMINI_API_KEY` from all stored `SanitizedGeminiErrorDiagnostic` objects, logs, UI panels, and backups.

### P3 — Bounded Timeouts, `AbortSignal`, Smart Retries & Instant Cancellation
- Added `runWithTimeoutAndAbort()` and `withBoundedStageRetries()` in `server/services/geminiVideoService.ts` with configurable `uploadTimeoutSeconds` (300s), `processingTimeoutSeconds` (180s), `inferenceTimeoutSeconds` (180s), and `maxRetryAttempts` (2).
- Permanent errors fail immediately on attempt 1 (zero retries); transient errors retry with exponential backoff + jitter and honor `Retry-After`.
- Wired `activeJobControllers` (`AbortController`) per active job; `cancelAnalysisJob()` immediately aborts in-flight SDK/FFmpeg operations and transitions the job to terminal `cancelled` (`ANALYSIS_CANCELLED`) while `updateJobProgress()` blocks late background writes from overwriting terminal states.

### P4 — Durable Remote Media Cleanup, Heartbeats & Startup Recovery
- `onRemoteFileUploaded` persists `remote_file_name` immediately after `files.upload` completes (prior to processing poll).
- Implemented Migration v8 non-destructive table upgrade widening `ai_analysis_assets.cleanup_status` to `not_uploaded | uploaded | cleanup_pending | deleting | deleted | cleanup_failed | retained_by_policy` (mapping legacy `pending` -> `cleanup_pending`) and adding `original_size_bytes`, `processed_size_bytes`, `preprocessing_ms`, heartbeat/stage/diagnostics columns, and `gemini_model_capabilities_cache`.
- Added 4-second job heartbeat updates, `reconcileStaleAnalysisJobs()`, `markInterruptedJobsOnStartup()` (never auto-restarting uploads), startup/shutdown `cleanupPendingRemoteFiles()` sweeps, and manual **Retry Remote Cleanup** (`POST /api/analysis-jobs/:jobId/retry-cleanup`). Local gameplay recordings are never deleted.

### P5 — Mode-Specific FFmpeg Analysis Proxies & UI Transparency
- Implemented mode-specific FFmpeg proxies in `server/services/videoPreprocessingService.ts` (`quick`: 720p/15fps/CRF28/no audio; `balanced`: 1080p/24fps/CRF24; `deep`: <=1080p/30fps/CRF20) with smart skip for already-compliant clips and original recordings preserved untouched.
- Upgraded `SettingsView.tsx` (Refresh Available Models, Test Selected Model, Test Video Compatibility, Use Primary Model for All Stages toggle, Effective Model Routing Preview, timeout/retry/proxy controls, Saved vs Unsaved indicator), `HalfTimeBriefingView.tsx` (pre-launch Effective Model Routing banner before upload authorization, live 1s Total + Stage elapsed timers, honest discrete segment progress with no fabricated %/ETA, proxy reduction metrics, Retry Remote Cleanup, expandable Technical Diagnostics + Copy Diagnostics), and `MatchCaptureView.tsx` (inline pre-launch model routing preview).
- Updated backup format to `fc26-ai-manager-backup-v8` with full backward-compatible restore support for `v1`–`v7`.

---

## 3. Verification Results (Automated Linux Environment)

All verification below was executed locally in an isolated Linux workspace using isolated temporary SQLite databases (workspace `/data/fc26_manager.db` preserved cleanly) and real local FFmpeg/FFprobe binaries plus mocked Gemini SDK clients:

| Suite / Check | Result |
| --- | --- |
| `npm run test:phase302` (30 Phase 3.0.2 scenarios) | **30 / 30 passed** |
| `npm run test:phase301` (Phase 3.0.1 media resolver & structured storage) | **35 / 35 passed** |
| `npm run test:phase3` (Phase 3 end-to-end analysis & tactical vision) | **10 / 10 passed** |
| `npm run test:phase22` (Phase 2.2 tactical & club reconciliation) | **9 / 9 passed** |
| `npm run test:phase21` (Phase 2.1 domain & migration) | **4 / 4 passed** |
| `npm run test:capture` (Phase 2 capture engine & SQLite persistence) | **14 / 14 passed** |
| `npm run test:players` (EAFC26 DataHub player adapter) | **10 / 10 passed** |
| **Total Automated Tests** | **112 / 112 passed, 0 failed** |
| `npm run build:desktop` (Vite + Server CJS + Electron Main/Preload `tsc` & CJS) | **Succeeded** (`dist/`, `dist-server/server.cjs`, `dist-electron/main.cjs`, `dist-electron/preload.cjs`) |
| TypeScript Lint (`npm run lint`) | **Passed (0 errors)** |
| Secret & Legacy Fallback Hygiene Audit | **Passed** (0 hardcoded `AIza` keys, 0 UI API key inputs, 0 production `gemini-4-hydrogen` fallbacks) |

---

## 4. What Still Requires Native Windows + Live `GEMINI_API_KEY` Acceptance

The following real-world checks cannot be executed in this headless Linux build environment and must be verified on your Windows 10/11 desktop machine using `docs/PHASE_3_0_2_WINDOWS_TESTING_GUIDE.md`:

1. Live `client.models.list()` model discovery and `Test Video Compatibility` against your real Google `GEMINI_API_KEY`.
2. Re-analysis of the existing 3-segment (272.87 MB) Chelsea vs Sunderland legacy recording on Windows with real Gemini Files API upload, proxy transcoding throughput, live inference, and confirmed remote file deletion.
3. Packaged Windows NSIS Electron executable startup, Migration v8 upgrade against your existing `AppData\Roaming\fc26-ai-manager\database\fc26_manager.db`, and mid-run UI cancellation under real network upload load.
