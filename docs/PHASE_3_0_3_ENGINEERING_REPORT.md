# Phase 3.0.3 Engineering Report — AI Response Validation, SQLite Error Domain Separation, Separate Capability Probes, Adaptive Failover, Stage Checkpoints & Sequential Frame Fallback

- **Project:** FC26 AI Manager — Football Tactical Intelligence System (`jonidarma/FC26-AI-Manager-Analyst`)
- **Version:** `v3.0.3`
- **Database Schema Version:** Migration `v9` (`phase_3_0_3_validation_failover_checkpoints_v9`)
- **Backup Format Version:** `fc26-ai-manager-backup-v9` (backward compatible with v6/v7/v8 restores)

---

## 1. Root Cause Analysis of the Production Bug

During real Windows EA SPORTS FC 26 gameplay testing using Gemini 3.5 Flash in Quick Mode, Stage 1 classification failed with:

```text
CHECK constraint failed: confidence IN ('High', 'Medium', 'Low')
```

Three compounding defects produced this failure and misdiagnosis:

1. **Unconstrained Gemini Structured Output Schemas:** Stage 1–4 `responseSchema` definitions declared `confidence` (and other SQLite-constrained enums such as `contentType`, `categoryGroup`, `teamAttribution`, `evidenceType`, `severity`, `evidenceQuality`, `recommendationStance`, `assessment`, `priorityGroup`, `actionType`, and `outcomeAssessment`) as unconstrained `Type.STRING`, allowing Gemini models to return lowercase (`"high"`), numeric (`0.85`), or percentage (`"80%"`) values.
2. **No Pre-Persistence Runtime Validation Layer:** `aiAnalysisOrchestrator.ts` inserted raw parsed model output directly into SQLite tables (`ai_video_classifications`, `ai_gameplay_observations`, `ai_tactical_vision_assessments`, `ai_tactical_recommendations`) without normalizing safe variants or rejecting ambiguous/invalid outputs prior to persistence.
3. **Error Domain Misclassification:** `classifyGeminiError()` did not detect `better-sqlite3` `SqliteError` instances or `SQLITE_CONSTRAINT_CHECK` errors before upstream fallback heuristics, misreporting local SQLite persistence failures as upstream Gemini outages (`UPSTREAM_SERVICE_UNAVAILABLE`) and allowing retry/failover logic to treat a local database error as a Gemini API failure.

---

## 2. Implemented Changes (`v3.0.3`)

### 2.1 Centralized AI Response Runtime Validation & Safe Enum Normalization
- **New service:** `server/services/aiResponseValidationService.ts`
- Defines canonical enum constants strictly matching all SQLite `CHECK` constraints (zero constraints relaxed or removed):
  - `CANONICAL_CONFIDENCE_LEVELS` (`'High' | 'Medium' | 'Low'`)
  - `CANONICAL_VIDEO_CONTENT_TYPES`, `CANONICAL_CATEGORY_GROUPS`, `CANONICAL_TEAM_ATTRIBUTIONS`, `CANONICAL_EVIDENCE_TYPES`, `CANONICAL_SEVERITY_LEVELS`, `CANONICAL_EVIDENCE_QUALITIES`, `CANONICAL_RECOMMENDATION_STANCES`, `CANONICAL_CRITERIA_ASSESSMENTS`, `CANONICAL_PRIORITY_GROUPS`, `CANONICAL_ACTION_TYPES`, `CANONICAL_OUTCOME_ASSESSMENTS`
- `normalizeConfidenceLevel()` safely normalizes case variants (`"high"`, `"MEDIUM"`, `"LOW"`), unambiguous synonyms (`"med"`, `"moderate"`), numeric probabilities (`0..1`), and percentages (`"85%"` / `0..100`) while strictly rejecting ambiguous or out-of-range values (`"maybe_kinda"`, `""`, `null`, `150`, `-0.2`).
- Stage validators (`validateClassificationStageResponse`, `validateObservationStageResponse`, `validateSynthesisStageResponse`, `validateComparisonStageResponse`) validate and normalize all fields **before** any SQLite `INSERT` executes and populate a structured `ValidationAuditSummary` (`normalizedFields`, `rejectedItems`, `repairedAttemptsCount`, `databaseErrors`).

### 2.2 Canonical Enum Constraints on All Gemini Structured Output Schemas + Bounded 1-Pass JSON Repair
- **Updated:** `server/services/geminiVideoService.ts` (`PROMPT_VERSION = 'fc26-halftime-analyst-v3.0.3'`, `SCHEMA_VERSION = 'fc26-analysis-schema-v3.0.3'`)
- Exported `buildStage1ClassificationSchema()`, `buildStage2ObservationSchema()`, `buildStage3SynthesisSchema()`, and `buildStage4ComparisonSchema()` with explicit `enum` constraints on every SQLite-checked enum field.
- Added bounded 1-pass `repairStageJsonResponse()` on `LiveGeminiVideoProvider` and integrated `validateAndRepairStageOutput()` into `server/services/aiAnalysisOrchestrator.ts`. If the single repair pass still produces invalid schema/enums, the stage halts cleanly with `AI_RESPONSE_REPAIR_FAILED` (`errorDomain: 'ai_validation'`, `retryable: false`) before touching SQLite.

### 2.3 Strict SQLite Error Domain Separation & Atomic Stage Transactions
- **Updated:** `server/services/geminiService.ts`, `server/services/aiAnalysisOrchestrator.ts`
- `classifyGeminiError()` evaluates `isAiResponseValidationError(err)` (`errorDomain: 'ai_validation'`) and `detectSqliteErrorInfo(err)` (`DATABASE_CONSTRAINT_VIOLATION` / `DATABASE_PERSISTENCE_FAILED`, `errorDomain: 'database'`, `retryable: false`, `sqliteCode`) **before** any upstream Gemini classification rules.
- Added `DATABASE_CONSTRAINT_VIOLATION`, `DATABASE_PERSISTENCE_FAILED`, `AI_RESPONSE_REPAIR_FAILED`, and `ANALYSIS_INTERRUPTED` to `PERMANENT_NON_RETRYABLE_ERROR_CODES`.
- Wrapped Stage 1 classification + checkpoint persistence, Stage 2 observation + checkpoint persistence, and Stage 3 briefing/vision/recommendations + checkpoint persistence inside atomic `db.transaction()` blocks so any mid-stage error rolls back cleanly with zero partial rows.
- Local SQLite errors are recorded in `job.validationSummary.databaseErrors` and never penalize `gemini_model_health` or trigger Gemini model failover.

### 2.4 Four Independent Capability Probes
- **Updated:** `server/services/geminiService.ts`, `server.ts`, `src/services/desktopBridge.ts`, `src/views/SettingsView.tsx`
- Added independent probe execution via `verifyModelCapabilities({ modelId, probeType })` and `POST /api/ai/models/test-probe` supporting:
  1. `text_json` — Text + structured JSON schema check
  2. `image` — Inline synthetic PNG multimodal image check
  3. `inline_video` — Synthetic 1-second FFmpeg MP4 inline video check
  4. `files_api_video` — Full Gemini Files API upload -> poll `ACTIVE` -> inference -> `files.delete` cleanup (`remoteCleanupConfirmed: true`, guaranteed in `finally`)
- Each probe updates only its own verified flag and timestamp in `gemini_model_capabilities_cache` without overwriting previously verified probe results.

### 2.5 Model Health Tracking & Adaptive Model Failover
- **New service:** `server/services/modelHealthService.ts`
- **Updated:** `server/services/aiAnalysisOrchestrator.ts`, `server/services/repository.ts`, `server.ts`, `src/views/SettingsView.tsx`, `src/views/HalfTimeBriefingView.tsx`
- Tracks per-model/capability/stage health in `gemini_model_health` (`healthy`, `degraded`, `cooldown` with stepped 60s/180s/600s cooldowns, and `unsupported`) with `GET /api/ai/model-health` and `POST /api/ai/model-health/reset`.
- `runStageWithModelFailover()` switches to the next healthy fallback candidate from `fallbackModelChain` / configured stage models / discovered models while **reusing the already-uploaded `remoteFileUri`** (zero redundant video uploads) and enforcing the `allowHigherCostFailover` cost guardrail.

### 2.6 Stage Checkpoints & Opt-In Resume
- **Updated:** `server/services/aiAnalysisOrchestrator.ts`, `server.ts`, `src/services/desktopBridge.ts`, `src/views/HalfTimeBriefingView.tsx`
- Persists validated Stage 1, Stage 2, and Stage 3 outputs into `ai_analysis_checkpoints` bound to `(job_id, match_id, session_id, half, segment_index, segment_checksum, proxy_signature)`.
- Added `GET /api/matches/:id/analysis/checkpoints` and `POST /api/matches/:id/analysis/checkpoints/invalidate`.
- **Opt-in only:** Starting a fresh analysis NEVER auto-resumes. When `resumeFromCheckpoint: true` is explicitly checked by the user, verified checkpointed segments are hydrated directly and skipped during upload and inference.

### 2.7 Opt-In Sequential Keyframe Fallback
- **Updated:** `server/services/videoPreprocessingService.ts`, `server/services/geminiVideoService.ts`, `server/services/aiAnalysisOrchestrator.ts`, `src/views/SettingsView.tsx`, `src/views/HalfTimeBriefingView.tsx`
- Added `extractSequentialFallbackFrames()` extracting bounded local JPEG keyframes into `analysis_temp/<jobId>/fallback_frames/seg_<idx>/` while keeping original gameplay MP4 recordings strictly unmodified.
- When `allowSequentialFrameFallback` is enabled (or `analysisStrategy: 'sequential_frames'` is explicitly chosen) and native video processing fails with an eligible upstream/video error, the orchestrator executes `classifySequentialFrames()` + `extractObservationsFromFrames()`, marks the job `analysisStrategy: 'sequential_frames'` and `status: 'completed_with_limitations'`, appends an honest keyframe-sampling limitation to the briefing, and cleans up all temp frames after job completion.

### 2.8 Database Migration v9 & Backup v9 Integrity
- **Verified:** `server/db/migrations.ts`, `server/db/database.ts`
- Migration `v9` adds `gemini_model_health`, `ai_analysis_checkpoints`, 4 independent capability probe columns/timestamps on `gemini_model_capabilities_cache`, and Phase 3.0.3 audit/failover/checkpoint columns on `ai_analysis_jobs`.
- `OPERATIONAL_TABLES` in `server/db/database.ts` includes both `gemini_model_health` and `ai_analysis_checkpoints` for Backup v9 export/restore integrity without leaking `GEMINI_API_KEY`.

---

## 3. Verification Results (Executed in Linux Development Environment)

All automated tests run against isolated temporary SQLite databases and synthetic FFmpeg MP4 clips (the production `/data/fc26_manager.db` was never modified):

| Verification Check | Result | Notes |
|---|---|---|
| `npm run test:players` | **10 / 10 passed** | Player CSV import adapter & catalog safety |
| `npm run test:capture` | **14 / 14 passed** | Native capture engine, FFmpeg/FFprobe, binary transport |
| `npm run test:phase21` | **4 / 4 passed** | Domain, migration v3→v4, roster & snapshot immutability |
| `npm run test:phase22` | **9 / 9 passed** | Canonical FC26 slot aliases, eligibility matrix, catalog reconciliation |
| `npm run test:phase3` | **10 / 10 passed** | Tactical visions, 3-layer validation, analysis pipeline, backup/restore |
| `npm run test:phase301` | **35 / 35 passed** | Recording media path confinement & structured Career Mode storage |
| `npm run test:phase302` | **30 / 30 passed** | Model routing, discovery, preflight, 19-code taxonomy, timeouts, proxy |
| `npm run test:phase303` | **21 / 21 passed** | Bug repro, enum normalization, 1-pass repair, SQLite error separation, 4 probes, health/failover, checkpoints, frame fallback, v8→v9 & backup v9 |
| **Total Automated Tests** | **133 / 133 passed** | **0 failures** |
| TypeScript Lint (`npm run lint`) | **0 errors** | Both `tsc --noEmit` and `tsc -p electron/tsconfig.json --noEmit` |
| Web & Desktop Build (`npm run build`, `npm run build:desktop`) | **Succeeded** | Verified clean bundle generation |

### Explicit Scope Disclosure (Not Yet Executed)
- **Live Google Gemini API verification** (against live Gemini 2.5 / 3.x endpoints with a real `GEMINI_API_KEY`) was **not** executed in this sandbox environment.
- **Native Windows 10/11 Electron desktop acceptance testing** with real EA SPORTS FC 26 gameplay recordings was **not** executed in this Linux environment.
- Follow `docs/PHASE_3_0_3_WINDOWS_TESTING_GUIDE.md` on Windows with a live `GEMINI_API_KEY` to complete final Windows acceptance sign-off.
