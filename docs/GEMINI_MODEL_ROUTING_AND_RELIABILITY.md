# Gemini Model Routing & Analysis Pipeline Reliability Reference (v3.0.2)

**Project:** FC26 AI Manager — Football Tactical Intelligence System  
**Version:** `3.0.2`  
**Scope:** Authoritative Gemini model resolution, dynamic model discovery, preflight validation, 19-code error taxonomy, bounded timeouts/retries, cancellation, durable remote file cleanup, stale job recovery, and mode-specific FFmpeg analysis proxies.

---

## 1. Single Authoritative Model Router

Module: `server/services/geminiModelRouter.ts`  
Primary API: `resolveEffectiveModelRouting(aiSettings, analysisMode)`

Every entry point that displays, validates, or executes Gemini models calls `resolveEffectiveModelRouting()`:

- `GET /api/ai/model-routing` (Settings preview & Half-Time Briefing / Match Capture pre-launch preview)
- `POST /api/ai/test-connection`
- `POST /api/matches/:id/analysis/preflight` (`runAnalysisPreflight()`)
- `POST /api/matches/:id/analysis/start` (`startAnalysisJob()`)

### Routing Rules
1. **Primary Override Mode (`usePrimaryModelForAllStages === true`, default in `v3.0.2`):**
   - `effectiveVideoModelId = primaryModelId`
   - `effectiveSynthesisModelId = primaryModelId`
   - `comparisonModelId = primaryModelId`
   - All analysis modes (`quick`, `balanced`, `deep`) route strictly to the user's selected **Primary Default Model**.
2. **Stage-Override Mode (`usePrimaryModelForAllStages === false`):**
   - `effectiveVideoModelId` uses the explicit override for the selected mode (`quickAnalysisModelId`, `balancedAnalysisModelId`, or `deepAnalysisModelId`), falling back to `primaryModelId` if empty.
   - `effectiveSynthesisModelId` uses `tacticalSynthesisModelId`, falling back to `primaryModelId` if empty.
   - `comparisonModelId` inherits `effectiveSynthesisModelId`.
3. **Zero Silent Legacy Fallbacks:**
   - Unreleased placeholder identifiers (`gemini-4-hydrogen`, `gemini-4-neon`) are never used as fallback targets.
   - On upgrade from Phase 3.0.0/3.0.1 persisted settings where `usePrimaryModelForAllStages` was unset and legacy placeholder stage overrides existed, `normalizeAiSettings()` clears those stale placeholders and enables `usePrimaryModelForAllStages = true` so the user's configured `modelId` is respected immediately.
4. **Historical Job Integrity:**
   - Each `ai_analysis_jobs` row records `model_video_id` and `model_synthesis_id` at creation time. Changing settings later never mutates prior completed jobs; a fresh re-analysis (`forceReanalyze: true`) uses the new effective routing.

---

## 2. Dynamic Gemini Model Discovery & Capability Cache

Module: `server/services/geminiService.ts`  
Table: `gemini_model_capabilities_cache` (SQLite Migration v8)

- **Discovery (`discoverAvailableGeminiModels()`):**
  - Calls `client.models.list()` using server-side `process.env.GEMINI_API_KEY`.
  - Filters out deprecated, retired, and non-generative/non-video model families (e.g., `embedding`, `aqa`, `imagen`, `veo`, `tts`, `whisper`, `lyria`, `gemini-1.0`, `gemini-1.5`).
  - Checks whether currently configured models (`modelId` and stage overrides) appear in the live discovered list and flags missing entries as inaccessible before upload.
  - Caches discovered metadata in SQLite with a 30-minute TTL (`forceRefresh: true` bypasses cache).
  - If discovery fails (e.g., invalid key or offline), returns sanitized `discoveryError` without exposing secrets and never silently invents accessibility.
- **Live Capability Verification (`verifyModelCapabilities()`):**
  - **Text & Structured JSON Probe (`POST /api/ai/models/test`):** Sends a lightweight JSON-schema `generateContent` request and validates structured JSON parsing.
  - **Video Compatibility Probe (`POST /api/ai/models/test-video`):** Synthesizes a tiny 1-second silent H.264 MP4 via local FFmpeg, sends it to the target model as `video/mp4` (inline base64 for fast ~3 KB probes, or via Gemini Files API with automatic remote deletion if >4 MB), validates structured JSON output, and cleans up the local temp file.
  - Stores verified capabilities and error status in `gemini_model_capabilities_cache` with a 6-hour TTL for verified models and 10-minute TTL for failures.

---

## 3. Eight-Gate Analysis Preflight (Zero-Byte Upload Protection)

Function: `runAnalysisPreflight()`  
Endpoint: `POST /api/matches/:id/analysis/preflight`

Executed before `startAnalysisJob()` uploads any bytes to Gemini:

1. **Privacy Authorization:** Requires explicit user confirmation (`privacyAuthorized === true`) and entire-display acknowledgement when applicable.
2. **Server-Side API Key Presence:** Verifies `process.env.GEMINI_API_KEY` is configured (`INVALID_API_KEY` if missing).
3. **Effective Model Routing:** Resolves exact `effectiveVideoModelId` and `effectiveSynthesisModelId` and blocks empty/deprecated models (`MODEL_NOT_FOUND` / `MODEL_VIDEO_UNSUPPORTED`).
4. **Live Model Access & Video Capability Check:** Uses `discoverAvailableGeminiModels()` + `verifyModelCapabilities()` (or fresh SQLite cache) to confirm both routed models are accessible and video-capable before uploading bytes.
5. **Recording Session Ownership & Eligibility:** Verifies session belongs to `matchId`, matches requested `half`, is verified/AI-eligible, and has valid finalized/recovered segments (`RECORDING_SESSION_MISMATCH`).
6. **Local Media Path Security & FFprobe Integrity:** Resolves each segment via Phase 3.0.1 `resolveRecordingSegmentMediaPath()` and validates integrity via `validateVideoFile()` (`MEDIA_INTEGRITY_FAILED` / `MEDIA_PATH_OUTSIDE_ALLOWED_ROOT`).
7. **FFmpeg Proxy Readiness:** Confirms local FFmpeg/FFprobe availability when proxy generation is enabled.
8. **Budget Guardrails:** Computes indicative cost estimate and enforces per-match (`perMatchBudgetUsd`) and daily (`dailyBudgetUsd`) caps (`QUOTA_EXCEEDED`) before starting upload.

---

## 4. Exact 19-Code Gemini Error Taxonomy & Retry Policy

Module: `server/services/geminiService.ts` (`classifyGeminiError()`)

| Error Code | Category | Retryable? | Primary Cause |
| --- | --- | --- | --- |
| `INVALID_API_KEY` | Permanent | No | Missing or invalid `GEMINI_API_KEY` (401 / `API_KEY_INVALID`) |
| `API_KEY_REVOKED` | Permanent | No | Key revoked or reported leaked |
| `MODEL_NOT_FOUND` | Permanent | No | Model ID not found / retired (404) |
| `MODEL_ACCESS_DENIED` | Permanent | No | Account/project lacks permission for model (403) |
| `MODEL_VIDEO_UNSUPPORTED` | Permanent | No | Model does not support video/multimodal input |
| `QUOTA_EXCEEDED` | Permanent | No | Account quota or app budget guardrail exceeded |
| `BILLING_REQUIRED` | Permanent | No | Paid billing tier required for model/feature |
| `RATE_LIMITED` | Transient | Yes | HTTP 429 rate limit (honors `Retry-After` header) |
| `PAYLOAD_TOO_LARGE` | Permanent | No | File/request size exceeds Gemini API limit (413) |
| `MEDIA_PROCESSING_FAILED` | Permanent | No | Gemini Files API transitioned file to `FAILED` |
| `VIDEO_UPLOAD_TIMEOUT` | Transient | Yes | Upload exceeded `uploadTimeoutSeconds` |
| `VIDEO_PROCESSING_TIMEOUT` | Transient | Yes | `files.get` polling exceeded `processingTimeoutSeconds` |
| `INFERENCE_TIMEOUT` | Transient | Yes | `models.generateContent` exceeded `inferenceTimeoutSeconds` |
| `SCHEMA_VALIDATION_FAILED` | Permanent | No | Response JSON failed strict Zod/schema validation |
| `SAFETY_OR_EMPTY_RESPONSE` | Permanent | No | Blocked by safety filter or returned empty candidate |
| `NETWORK_CONNECTION_FAILED` | Transient | Yes | DNS/socket/TCP/TLS transport error (`ECONNRESET`, `ETIMEDOUT`, etc.) |
| `UPSTREAM_SERVICE_UNAVAILABLE` | Transient | Yes | HTTP 500/502/503/504 upstream Gemini outage |
| `ANALYSIS_CANCELLED` | Terminal | No | Explicitly cancelled by the user |
| `ANALYSIS_INTERRUPTED` | Terminal | No | App restarted or stale heartbeat reconciled an orphaned job |

### Secret Redaction
`sanitizeDiagnosticText()` scrubs `AIza...` keys, `Bearer ...` tokens, `key=...` query params, `x-goog-api-key` headers, and exact runtime `process.env.GEMINI_API_KEY` matches before writing `SanitizedGeminiErrorDiagnostic` to SQLite, logs, UI diagnostics, or backup files.

---

## 5. Bounded Timeouts, Cancellation & Retry Engine

Module: `server/services/geminiVideoService.ts`

- **Per-Stage Timeouts (configurable in Settings):**
  - Upload (`uploadTimeoutSeconds`, default `300s`)
  - Media Processing Poll (`processingTimeoutSeconds`, default `180s`)
  - Stage Inference (`inferenceTimeoutSeconds`, default `180s`)
- **Cooperative `AbortSignal` Propagation:**
  - Every active job registers an `AbortController` in `activeJobControllers`.
  - `runWithTimeoutAndAbort()` combines the job's cancel signal with a per-stage deadline timer and passes `abortSignal` into `files.upload`, `files.get`, `files.delete`, and `models.generateContent`, as well as FFmpeg proxy subprocesses.
- **Bounded Exponential Backoff (`withBoundedStageRetries()`):**
  - Retries **only** transient codes (`RATE_LIMITED`, `UPSTREAM_SERVICE_UNAVAILABLE`, `NETWORK_CONNECTION_FAILED`, `VIDEO_UPLOAD_TIMEOUT`, `VIDEO_PROCESSING_TIMEOUT`, `INFERENCE_TIMEOUT`) up to `maxRetryAttempts` (default `2`), with jittered backoff and `Retry-After` support.
  - Permanent errors fail immediately on attempt 1 (zero wasted retries).

---

## 6. Durable Remote Media Cleanup State Machine

Table: `ai_analysis_assets`  
States: `not_uploaded` -> `uploaded` -> `cleanup_pending` -> `deleting` -> `deleted` | `cleanup_failed` | `retained_by_policy`

1. **Immediate Persistence:** `onRemoteFileUploaded` persists `remote_file_name` and `remote_file_uri` into `ai_analysis_assets` immediately after `files.upload` returns — **before** media processing polling begins.
2. **Guaranteed `finally` Cleanup:** Regardless of whether a job succeeds, fails, times out, or is cancelled, the orchestrator's `finally` block attempts `files.delete` for every uploaded remote asset when `deleteRemoteAfterAnalysis` is enabled (otherwise marks `retained_by_policy`).
3. **Zero Local Deletion:** Remote cleanup never touches local gameplay MP4 recordings; only temporary analysis proxy files under `temp_analysis/` are removed.
4. **Durable Recovery & Manual Retry:**
   - Failed deletions transition to `cleanup_failed` with incremented `cleanup_attempts` and `last_cleanup_error`.
   - Startup sweep (`cleanupPendingRemoteFiles()`), graceful shutdown sweep (`shutdownAnalysisOrchestrator()`), and the UI **Retry Remote Cleanup** button (`POST /api/analysis-jobs/:jobId/retry-cleanup`) retry any `uploaded`, `cleanup_pending`, or `cleanup_failed` remote assets.

---

## 7. Job Heartbeat, Stale Reconciliation & Startup Recovery

Module: `server/services/aiAnalysisOrchestrator.ts`

- **Heartbeat:** Active jobs update `last_heartbeat_at` and `elapsed_ms` every 4 seconds.
- **Terminal-State Guard:** `updateJobProgress()` refuses to overwrite any job already in a terminal state (`completed`, `completed_with_limitations`, `insufficient_gameplay`, `failed`, `cancelled`, `interrupted`) unless explicitly permitted, preventing late unwinding background tasks from corrupting cancelled/failed jobs.
- **Startup Interrupted Recovery:** `markInterruptedJobsOnStartup()` transitions any orphaned active jobs from a prior process crash/close to `status = 'interrupted'` (`error_code = 'ANALYSIS_INTERRUPTED'`). It **never** auto-restarts uploads without explicit user authorization.
- **Stale Reconciliation:** `reconcileStaleAnalysisJobs()` runs before launching new jobs, marking any non-terminal job whose heartbeat is stale as `interrupted` while still blocking healthy duplicate concurrent jobs for the same match and half.

---

## 8. Mode-Specific FFmpeg Analysis Proxies

Module: `server/services/videoPreprocessingService.ts`  
Function: `prepareAnalysisVideoAsset()`

| Mode | Max Resolution | Max FPS | Audio | Video CRF |
| --- | --- | --- | --- | --- |
| `quick` | `1280x720` | `15 fps` | Stripped (`-an`) | `28` |
| `balanced` | `1920x1080` | `24 fps` | Stripped by default (`proxyAudioInBalanced` toggle) | `24` |
| `deep` | `<= 1920x1080` (preserve up to 1080p) | `30 fps` | Stripped by default (`proxyAudioInDeep` toggle) | `20` |

- **Smart Skip:** If the original segment already satisfies the mode's resolution, frame rate, codec (`h264`), and audio policy (and is within reasonable bitrate), proxy transcoding is skipped and the original file is uploaded directly.
- **Original Footage Untouched:** Proxies are written strictly to `temp_analysis/<jobId>/`, FFprobe-verified before upload, and deleted after analysis. Both `original_size_bytes` and `processed_size_bytes` are recorded on `ai_analysis_assets` and surfaced in the Half-Time Briefing UI.
