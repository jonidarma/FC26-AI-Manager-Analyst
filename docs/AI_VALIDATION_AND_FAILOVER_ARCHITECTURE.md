# AI Validation, Error Domain Separation, Adaptive Failover & Checkpoint Architecture (`v3.0.3`)

This document describes the runtime architecture introduced in Phase 3.0.3 for FC26 AI Manager.

---

## 1. End-to-End Pipeline Hardening Flow

```text
Local Verified MP4 Recording
        │
        ▼
[Preflight Gate] (API key, media confinement, FFprobe integrity, budget cap, routing)
        │
        ▼
[Opt-In Checkpoint Check] (only if user explicitly checks resumeFromCheckpoint=true)
        │
        ├─ Segment already checkpointed & checksum/proxy match ─► Hydrate into job (skip upload)
        │
        └─ Segment needs execution
                │
                ▼
        [Upload & Poll ACTIVE] (Files API; remote_file_name persisted immediately for guaranteed cleanup)
                │
                ├─ Native video failure + allowSequentialFrameFallback=true
                │       └─► [FFmpeg extractSequentialFallbackFrames()] ─► Local JPEGs in temp dir
                │           ─► Stage 1 & 2 via image multimodal calls
                │           ─► Marks job strategy='sequential_frames' + status='completed_with_limitations'
                │
                ▼
        [Stage 1 / Stage 2 / Stage 3 / Stage 4 Inference]
                │  ▲
                │  └─ [runStageWithModelFailover()]
                │       • Reuses active remoteFileUri (no duplicate upload)
                │       • Checks gemini_model_health cooldown/unsupported state
                │       • Enforces allowHigherCostFailover guardrail
                │       • NEVER triggers on database, ai_validation, local_media, or cancel errors
                ▼
        [validateAndRepairStageOutput()]
                │  • Normalizes safe canonical enum variants (e.g. 'high' / 0.85 / '85%' -> 'High')
                │  • Strictly rejects ambiguous/unmappable enums (never guesses)
                │  • Executes at most 1 bounded repairStageJsonResponse() pass if invalid
                │  • Throws AiResponseValidationError BEFORE touching SQLite if still invalid
                ▼
        [Atomic SQLite Transaction: db.transaction()]
                │  • Inserts validated stage rows (all SQLite CHECK constraints preserved)
                │  • Writes verified stage checkpoint row into ai_analysis_checkpoints
                │  • Full rollback on any SQLite error (zero partial rows)
                ▼
        [finally: Remote File Cleanup + Local Temp Dir Cleanup]
                   (Original gameplay MP4 recordings are NEVER modified or deleted)
```

---

## 2. Error Domain Separation Contract

Every error surfaced by `classifyGeminiError()` in `server/services/geminiService.ts` carries an explicit `errorDomain: ErrorDomain`:

| `errorDomain` | Example Error Codes | Retryable / Failover Eligible? | Penalizes `gemini_model_health`? |
|---|---|---|---|
| `database` | `DATABASE_CONSTRAINT_VIOLATION`, `DATABASE_PERSISTENCE_FAILED` | **Never** (`retryable: false`, never fails over) | **Never** |
| `ai_validation` | `AI_RESPONSE_SCHEMA_INVALID`, `AI_RESPONSE_ENUM_INVALID`, `AI_RESPONSE_REPAIR_FAILED`, `ANALYSIS_STAGE_VALIDATION_FAILED` | **Never** auto-retried; bounded 1-pass repair only | Tracked only if upstream model returns malformed schema |
| `ffmpeg` | Local `MediaPathError`, `MEDIA_INTEGRITY_FAILED` | **Never** | **Never** |
| `gemini_api` | `MODEL_NOT_FOUND`, `MODEL_ACCESS_DENIED`, `MODEL_VIDEO_UNSUPPORTED`, `RATE_LIMIT_EXCEEDED`, `QUOTA_EXCEEDED`, `VIDEO_PROCESSING_FAILED`, `UPSTREAM_SERVICE_UNAVAILABLE`, `INFERENCE_TIMEOUT` | Transient errors bounded-retry & failover-eligible; auth/key errors never fail over | **Yes** (`degraded` -> `cooldown` -> `unsupported`) |
| `network` | `NETWORK_CONNECTION_FAILED`, `VIDEO_UPLOAD_FAILED`, `VIDEO_UPLOAD_TIMEOUT` | Bounded retry | **Yes** |
| `internal` | `ANALYSIS_CANCELLED`, `ANALYSIS_INTERRUPTED` | **Never** | **Never** |

---

## 3. Canonical Enum Contract (Schema ↔ Validator ↔ SQLite `CHECK`)

All 12 enum domains share a single source of truth exported from `server/services/aiResponseValidationService.ts` and referenced directly by `buildStage1..4Schema()` in `server/services/geminiVideoService.ts`:

- `confidence`: `'High' | 'Medium' | 'Low'`
- `contentType`: 14 canonical FC26 segment types (`live_gameplay`, `set_piece`, `replay`, ...)
- `categoryGroup`: `'attacking' | 'defensive' | 'possession' | 'match_events'`
- `teamAttribution`: `'user_team' | 'opponent' | 'both' | 'unknown'`
- `evidenceType`: `'directly_observed' | 'hud_or_statistics_screen' | 'user_confirmed' | 'tactical_inference' | 'master_database_attribute'`
- `severity`: `'Critical' | 'High' | 'Medium' | 'Low' | 'Positive'`
- `evidenceQuality`: `'high' | 'moderate' | 'limited' | 'insufficient'`
- `recommendationStance`: `'retain_and_refine' | 'adapt_vision' | 'insufficient_evidence'`
- `criteriaBreakdown[].assessment`: `'strong' | 'mixed' | 'weak' | 'unknown'`
- `priorityGroup`: `'immediate_correction' | 'player_change' | 'structural_adjustment' | 'gameplay_coaching' | 'contingency_plan'`
- `actionType`: 10 canonical FC26 tactical actions
- `outcomeAssessment`: `'improved' | 'unchanged' | 'worsened' | 'insufficient_evidence'`

---

## 4. Database Schema Additions (Migration `v9`)

1. **`gemini_model_health`** — Primary key `(model_id, capability, stage)`. Stores `status` (`healthy | degraded | cooldown | unsupported`), `consecutive_failures`, `last_success_at`, `last_failure_at`, `last_error_code`, `last_error_message`, `cooldown_until`, `updated_at`.
2. **`ai_analysis_checkpoints`** — Stores validated JSON payloads for `classifying_gameplay`, `analyzing_gameplay`, and `generating_briefing` tied to `job_id`, `match_id`, `session_id`, `half`, `segment_index`, `segment_checksum`, `proxy_signature`, `model_used`, `analysis_strategy`, and `status` (`valid | invalidated | consumed`).
3. **`gemini_model_capabilities_cache`** — Extended with independent probe columns: `text_verified`, `text_verified_at`, `image_verified`, `image_verified_at`, `inline_video_verified`, `inline_video_verified_at`, `files_api_video_verified`, `files_api_video_verified_at`, `last_probe_type`.
4. **`ai_analysis_jobs`** — Extended with `analysis_strategy`, `stage_models_json`, `fallback_history_json`, `validation_summary_json`, and `checkpoint_resumed_from_job_id`.
