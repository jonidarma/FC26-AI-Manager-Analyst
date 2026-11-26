import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  AiAnalysisAssetRecord,
  AiAnalysisJobRecord,
  AiGameplayObservationRecord,
  AiHalftimeBriefingPayload,
  AiRecommendationDecisionRecord,
  AiSecondHalfComparisonPayload,
  AiTacticalRecommendationRecord,
  AiTacticalVisionAssessmentRecord,
  AiVideoClassificationRecord,
  AnalysisCheckpointRecord,
  AnalysisCheckpointResumeSummary,
  AnalysisJobStatus,
  AnalysisLanguage,
  AnalysisStrategy,
  AnalysisTimingBreakdown,
  GeminiErrorCode,
  MatchAnalysisBundle,
  MatchTacticalSnapshot,
  ModelFailoverEvent,
  PlayerRoleAssignment,
  RecommendationDecisionStatus,
  RemoteCleanupStatus,
  SanitizedGeminiErrorDiagnostic,
  TacticalPreset,
  ValidationAuditSummary,
  VideoAnalysisMode,
} from '../../src/types/domain.ts';
import { getDb } from '../db/database.ts';
import {
  AiResponseValidationError,
  createEmptyValidationAuditSummary,
  isAiResponseValidationError,
  mergeValidationAuditSummary,
  validateClassificationStageResponse,
  validateComparisonStageResponse,
  validateObservationStageResponse,
  validateSynthesisStageResponse,
  type StageValidationResult,
} from './aiResponseValidationService.ts';
import { validateAiRecommendations } from './analysisValidationService.ts';
import { resolveEffectiveModelRouting } from './geminiModelRouter.ts';
import {
  classifyGeminiError,
  estimateVideoAnalysisCostUsd,
  getGeminiStatus,
  isGeminiApiConfigured,
  runAnalysisPreflight,
  sanitizeDiagnosticText,
  type GeminiDiscoveryClientLike,
} from './geminiService.ts';
import {
  buildStage1ClassificationSchema,
  buildStage2ObservationSchema,
  buildStage3SynthesisSchema,
  buildStage4ComparisonSchema,
  defaultLiveGeminiVideoProvider,
  GeminiStageError,
  isGeminiStageError,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type GeminiVideoProvider,
  type VideoClassificationOutput,
} from './geminiVideoService.ts';
import {
  recordModelFailure,
  recordModelSuccess,
  selectFailoverCandidate,
} from './modelHealthService.ts';
import {
  createInMatchTacticalAdjustment,
  createOrUpsertMatchSession,
  createTacticalPreset,
  getDailyApiSpendUsd,
  getMatchSessionById,
  getPreMatchTacticalSnapshot,
  getSettings,
  insertApiUsageLog,
  listMatchSessions,
  listMatchTacticalSnapshots,
  updateMatchSession,
  upsertRecordingSegment,
} from './repository.ts';
import { buildAiMatchTacticalContext } from './tacticalContextService.ts';
import {
  evaluateThreeLayerTactics,
  getTacticalVisionCatalog,
  normalizeTacticalVisionKey,
} from './tacticalVisionService.ts';
import {
  isMediaPathError,
  MediaPathError,
} from '../../shared/recordingStorage.ts';
import {
  exportAnalysisArtifactJson,
  resolveRecordingSegmentMediaPath,
  writeMatchMetadataManifest,
} from './recordingMediaResolver.ts';
import {
  cleanupTempAnalysisDir,
  extractEvidenceFrame,
  extractSequentialFallbackFrames,
  getTestClipsDir,
  prepareAnalysisVideoAsset,
  validateVideoFile,
} from './videoPreprocessingService.ts';

const ACTIVE_JOB_STATUSES: AnalysisJobStatus[] = [
  'queued',
  'validating_recording',
  'preprocessing',
  'uploading',
  'waiting_for_media_processing',
  'classifying_gameplay',
  'analyzing_gameplay',
  'evaluating_tactics',
  'generating_briefing',
  'validating_results',
];

const TERMINAL_JOB_STATUSES = new Set<AnalysisJobStatus>([
  'completed',
  'completed_with_limitations',
  'insufficient_gameplay',
  'failed',
  'cancelled',
  'interrupted',
]);

const CLEANABLE_ASSET_STATUSES = ['uploaded', 'cleanup_pending', 'deleting', 'cleanup_failed', 'pending'];

const runningJobIds = new Set<string>();
const cancelRequestedJobIds = new Set<string>();
const activeJobControllers = new Map<string, AbortController>();

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapJobRow(r: Record<string, unknown>): AiAnalysisJobRecord {
  return {
    id: String(r.id),
    matchId: String(r.match_id),
    sessionId: r.session_id ? String(r.session_id) : null,
    half: String(r.half) as 'first_half' | 'second_half',
    analysisMode: String(r.analysis_mode) as VideoAnalysisMode,
    language: String(r.language) as AnalysisLanguage,
    status: String(r.status) as AnalysisJobStatus,
    currentStage: String(r.current_stage),
    progressDetail: safeJsonParse<AiAnalysisJobRecord['progressDetail']>(
      String(r.progress_detail_json ?? '{}'),
      { segmentsTotal: 0, segmentsProcessed: 0, stageLabel: 'Queued' }
    ),
    modelVideoId: String(r.model_video_id),
    modelSynthesisId: String(r.model_synthesis_id),
    analysisStrategy: (r.analysis_strategy
      ? String(r.analysis_strategy)
      : 'native_video') as AnalysisStrategy,
    stageModelsUsed: safeJsonParse<Record<string, string>>(
      r.stage_models_json ? String(r.stage_models_json) : null,
      {}
    ),
    fallbackHistory: safeJsonParse<ModelFailoverEvent[]>(
      r.fallback_history_json ? String(r.fallback_history_json) : null,
      []
    ),
    validationSummary: safeJsonParse<ValidationAuditSummary | null>(
      r.validation_summary_json ? String(r.validation_summary_json) : null,
      null
    ),
    checkpointResumedFromJobId: r.checkpoint_resumed_from_job_id
      ? String(r.checkpoint_resumed_from_job_id)
      : null,
    promptVersion: String(r.prompt_version),
    schemaVersion: String(r.schema_version),
    tacticalVisionDatasetVersion: String(r.tactical_vision_dataset_version ?? ''),
    requestFingerprint: String(r.request_fingerprint ?? ''),
    privacyAuthorized: Boolean(r.privacy_authorized),
    entireDisplayAcknowledged: Boolean(r.entire_display_acknowledged),
    estimatedCostUsd: Number(r.estimated_cost_usd ?? 0),
    actualCostUsd:
      r.actual_cost_usd === null || r.actual_cost_usd === undefined ? null : Number(r.actual_cost_usd),
    budgetCapUsd: Number(r.budget_cap_usd ?? 1.5),
    segmentsTotal: Number(r.segments_total ?? 0),
    segmentsProcessed: Number(r.segments_processed ?? 0),
    currentSegmentIndex:
      r.current_segment_index === null || r.current_segment_index === undefined
        ? null
        : Number(r.current_segment_index),
    samplingFps: Number(r.sampling_fps ?? 1.0),
    coverageSummary: String(r.coverage_summary ?? ''),
    startedAt: r.started_at ? String(r.started_at) : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
    lastHeartbeatAt: r.last_heartbeat_at ? String(r.last_heartbeat_at) : null,
    lastActivityAt: r.last_activity_at ? String(r.last_activity_at) : null,
    stageStartedAt: r.stage_started_at ? String(r.stage_started_at) : null,
    elapsedMs: Number(r.elapsed_ms ?? 0),
    timingBreakdown: safeJsonParse<AnalysisTimingBreakdown | null>(
      r.timing_breakdown_json ? String(r.timing_breakdown_json) : null,
      null
    ),
    errorCode: r.error_code ? String(r.error_code) : null,
    errorMessage: r.error_message ? String(r.error_message) : null,
    diagnostics: safeJsonParse<SanitizedGeminiErrorDiagnostic | null>(
      r.diagnostics_json ? String(r.diagnostics_json) : null,
      null
    ),
    retryCount: Number(r.retry_count ?? 0),
    retryAttempt: Number(r.retry_attempt ?? 0),
    cancelRequested: Boolean(r.cancel_requested),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapCheckpointRow(r: Record<string, unknown>): AnalysisCheckpointRecord {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    matchId: String(r.match_id),
    sessionId: r.session_id ? String(r.session_id) : null,
    half: String(r.half) as 'first_half' | 'second_half',
    stageName: String(r.stage_name) as AnalysisCheckpointRecord['stageName'],
    segmentId: r.segment_id ? String(r.segment_id) : null,
    segmentIndex: Number(r.segment_index ?? 0),
    segmentChecksum: String(r.segment_checksum ?? ''),
    proxySignature: String(r.proxy_signature ?? ''),
    modelUsed: String(r.model_used ?? ''),
    promptVersion: String(r.prompt_version ?? ''),
    schemaVersion: String(r.schema_version ?? ''),
    analysisStrategy: (r.analysis_strategy
      ? String(r.analysis_strategy)
      : 'native_video') as AnalysisStrategy,
    remoteFileName: r.remote_file_name ? String(r.remote_file_name) : null,
    remoteFileUri: r.remote_file_uri ? String(r.remote_file_uri) : null,
    status: String(r.status ?? 'valid') as 'valid' | 'invalidated',
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function buildProxySignature(analysisMode: VideoAnalysisMode, proxyEnabled: boolean): string {
  return `${analysisMode}:proxy=${proxyEnabled ? '1' : '0'}`;
}

function upsertStageCheckpoint(
  db: Database.Database,
  input: {
    jobId: string;
    matchId: string;
    sessionId: string | null;
    half: 'first_half' | 'second_half';
    stageName: AnalysisCheckpointRecord['stageName'];
    segmentId: string | null;
    segmentIndex: number;
    segmentChecksum: string;
    proxySignature: string;
    modelUsed: string;
    analysisStrategy: AnalysisStrategy;
    remoteFileName?: string | null;
    remoteFileUri?: string | null;
    payload: unknown;
  }
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_analysis_checkpoints (
      id, job_id, match_id, session_id, half, stage_name, segment_id, segment_index,
      segment_checksum, proxy_signature, model_used, prompt_version, schema_version,
      analysis_strategy, remote_file_name, remote_file_uri, payload_json, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?)
    ON CONFLICT(job_id, stage_name, segment_index) DO UPDATE SET
      segment_checksum = excluded.segment_checksum,
      proxy_signature = excluded.proxy_signature,
      model_used = excluded.model_used,
      prompt_version = excluded.prompt_version,
      schema_version = excluded.schema_version,
      analysis_strategy = excluded.analysis_strategy,
      remote_file_name = excluded.remote_file_name,
      remote_file_uri = excluded.remote_file_uri,
      payload_json = excluded.payload_json,
      status = 'valid',
      updated_at = excluded.updated_at
  `).run(
    crypto.randomUUID(),
    input.jobId,
    input.matchId,
    input.sessionId,
    input.half,
    input.stageName,
    input.segmentId,
    input.segmentIndex,
    input.segmentChecksum,
    input.proxySignature,
    input.modelUsed,
    PROMPT_VERSION,
    SCHEMA_VERSION,
    input.analysisStrategy,
    input.remoteFileName ?? null,
    input.remoteFileUri ?? null,
    JSON.stringify(input.payload ?? {}),
    now,
    now
  );
}

export function invalidateCheckpointsForMatchHalf(
  matchId: string,
  half: 'first_half' | 'second_half',
  dbArg?: Database.Database
): number {
  const db = dbArg ?? getDb();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE ai_analysis_checkpoints
       SET status = 'invalidated', updated_at = ?
       WHERE match_id = ? AND half = ? AND status = 'valid'`
    )
    .run(now, matchId, half);
  return info.changes;
}

export function getResumableCheckpointsForMatchHalf(
  matchId: string,
  half: 'first_half' | 'second_half',
  options?: {
    sessionId?: string | null;
    analysisMode?: VideoAnalysisMode;
    db?: Database.Database;
  }
): AnalysisCheckpointResumeSummary {
  const db = options?.db ?? getDb();
  const settings = getSettings();
  const analysisMode: VideoAnalysisMode =
    options?.analysisMode ?? settings.ai.defaultAnalysisMode ?? 'balanced';
  const proxyEnabled =
    settings.ai.proxyEnabled !== undefined
      ? Boolean(settings.ai.proxyEnabled)
      : Boolean(settings.ai.downscaleForAnalysis);
  const expectedProxySig = buildProxySignature(analysisMode, proxyEnabled);

  const sessions = listMatchSessions({ matchId });
  const targetSession = options?.sessionId
    ? getMatchSessionById(options.sessionId)
    : sessions.find(
        (s) =>
          s.half === half &&
          s.aiEligible &&
          ['completed', 'recovered', 'partial'].includes(s.status)
      ) ?? sessions.find((s) => s.half === half) ?? null;

  // Look for latest failed/interrupted/cancelled job with valid checkpoints for this match + half
  const candidateJobs = db
    .prepare(
      `SELECT id, status, session_id, analysis_strategy, created_at
       FROM ai_analysis_jobs
       WHERE match_id = ? AND half = ?
       ORDER BY created_at DESC LIMIT 8`
    )
    .all(matchId, half) as Array<{
    id: string;
    status: string;
    session_id: string | null;
    analysis_strategy: string | null;
    created_at: string;
  }>;

  const resumableJob = candidateJobs.find((j) =>
    ['failed', 'interrupted', 'cancelled'].includes(j.status)
  );
  // If the most recent job already completed successfully for the same session, no checkpoint resume is needed
  const latestJob = candidateJobs[0];
  if (
    !resumableJob ||
    (latestJob &&
      ['completed', 'completed_with_limitations'].includes(latestJob.status) &&
      (!targetSession || latestJob.session_id === targetSession.id))
  ) {
    return {
      canResume: false,
      sourceJobId: null,
      completedStageCount: 0,
      completedSegmentIndices: [],
      analysisStrategy: 'native_video',
      requiresReuploadAuthorization: false,
      invalidationReasons: [],
      checkpoints: [],
    };
  }

  const rawRows = db
    .prepare(
      `SELECT * FROM ai_analysis_checkpoints
       WHERE job_id = ? AND status = 'valid'
       ORDER BY segment_index ASC, created_at ASC`
    )
    .all(resumableJob.id) as Array<Record<string, unknown>>;

  if (rawRows.length === 0) {
    return {
      canResume: false,
      sourceJobId: null,
      completedStageCount: 0,
      completedSegmentIndices: [],
      analysisStrategy: (resumableJob.analysis_strategy as AnalysisStrategy) ?? 'native_video',
      requiresReuploadAuthorization: false,
      invalidationReasons: [],
      checkpoints: [],
    };
  }

  const invalidationReasons: string[] = [];
  const validCheckpoints: AnalysisCheckpointRecord[] = [];
  const validSegs = (targetSession?.segments ?? []).filter(
    (s) => ['finalized', 'recovered'].includes(s.status) && s.sizeBytes > 0 && s.durationSeconds > 0
  );
  const segByIndex = new Map(validSegs.map((s) => [s.segmentIndex, s]));

  for (const r of rawRows) {
    const cp = mapCheckpointRow(r);
    if (targetSession && cp.sessionId && cp.sessionId !== targetSession.id) {
      invalidationReasons.push(`Checkpoint session (${cp.sessionId.slice(0, 8)}) no longer matches active recording session.`);
      continue;
    }
    if (cp.promptVersion !== PROMPT_VERSION || cp.schemaVersion !== SCHEMA_VERSION) {
      invalidationReasons.push(`Checkpoint schema/prompt version (${cp.schemaVersion}) differs from current (${SCHEMA_VERSION}).`);
      continue;
    }
    if (options?.analysisMode && cp.proxySignature && cp.proxySignature !== expectedProxySig) {
      invalidationReasons.push(`Checkpoint proxy/mode signature (${cp.proxySignature}) differs from requested (${expectedProxySig}).`);
      continue;
    }
    if (cp.segmentIndex > 0) {
      const seg = segByIndex.get(cp.segmentIndex);
      if (!seg) {
        invalidationReasons.push(`Segment #${cp.segmentIndex} is no longer present in the recording session.`);
        continue;
      }
      if (cp.segmentChecksum && seg.checksum && cp.segmentChecksum !== seg.checksum) {
        invalidationReasons.push(`Segment #${cp.segmentIndex} checksum changed since checkpoint was saved.`);
        continue;
      }
    }
    validCheckpoints.push(cp);
  }

  const uniqueReasons = Array.from(new Set(invalidationReasons));
  const completedSegIndices = Array.from(
    new Set(
      validCheckpoints
        .filter((c) => c.stageName === 'analyzing_gameplay' && c.segmentIndex > 0)
        .map((c) => c.segmentIndex)
    )
  ).sort((a, b) => a - b);

  const allSegsDone = validSegs.length > 0 && validSegs.every((s) => completedSegIndices.includes(s.segmentIndex));

  return {
    canResume: validCheckpoints.length > 0,
    sourceJobId: validCheckpoints.length > 0 ? resumableJob.id : null,
    completedStageCount: validCheckpoints.length,
    completedSegmentIndices: completedSegIndices,
    analysisStrategy:
      (validCheckpoints[0]?.analysisStrategy ?? resumableJob.analysis_strategy ?? 'native_video') as AnalysisStrategy,
    requiresReuploadAuthorization: !allSegsDone,
    invalidationReasons: uniqueReasons,
    checkpoints: validCheckpoints,
  };
}

function mapAssetRow(r: Record<string, unknown>): AiAnalysisAssetRecord {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    matchId: String(r.match_id),
    sessionId: r.session_id ? String(r.session_id) : null,
    segmentId: r.segment_id ? String(r.segment_id) : null,
    localFilePath: String(r.local_file_path),
    preparedFilePath: r.prepared_file_path ? String(r.prepared_file_path) : null,
    isTempAsset: Boolean(r.is_temp_asset),
    sha256Hash: String(r.sha256_hash ?? ''),
    fileSizeBytes: Number(r.file_size_bytes ?? 0),
    originalSizeBytes:
      r.original_size_bytes === null || r.original_size_bytes === undefined
        ? Number(r.file_size_bytes ?? 0)
        : Number(r.original_size_bytes),
    processedSizeBytes:
      r.processed_size_bytes === null || r.processed_size_bytes === undefined
        ? Number(r.file_size_bytes ?? 0)
        : Number(r.processed_size_bytes),
    preprocessingMs:
      r.preprocessing_ms === null || r.preprocessing_ms === undefined
        ? null
        : Number(r.preprocessing_ms),
    durationSeconds: Number(r.duration_seconds ?? 0),
    width: r.width === null || r.width === undefined ? null : Number(r.width),
    height: r.height === null || r.height === undefined ? null : Number(r.height),
    remoteFileName: r.remote_file_name ? String(r.remote_file_name) : null,
    remoteFileUri: r.remote_file_uri ? String(r.remote_file_uri) : null,
    remoteState: r.remote_state ? String(r.remote_state) : null,
    cleanupStatus: String(r.cleanup_status) as RemoteCleanupStatus,
    cleanupAttempts: Number(r.cleanup_attempts ?? 0),
    cleanupAttemptedAt: r.cleanup_attempted_at ? String(r.cleanup_attempted_at) : null,
    cleanupConfirmedAt: r.cleanup_confirmed_at ? String(r.cleanup_confirmed_at) : null,
    cleanupError: r.cleanup_error ? String(r.cleanup_error) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapClassificationRow(r: Record<string, unknown>): AiVideoClassificationRecord {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    matchId: String(r.match_id),
    segmentId: r.segment_id ? String(r.segment_id) : null,
    startSeconds: Number(r.start_seconds ?? 0),
    endSeconds: Number(r.end_seconds ?? 0),
    sessionStartSeconds: Number(r.session_start_seconds ?? 0),
    sessionEndSeconds: Number(r.session_end_seconds ?? 0),
    contentType: String(r.content_type) as AiVideoClassificationRecord['contentType'],
    confidence: String(r.confidence) as AiVideoClassificationRecord['confidence'],
    evidenceDescription: String(r.evidence_description ?? ''),
    inGameClock: r.in_game_clock ? String(r.in_game_clock) : null,
    createdAt: String(r.created_at),
  };
}

function mapObservationRow(r: Record<string, unknown>): AiGameplayObservationRecord {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    matchId: String(r.match_id),
    half: String(r.half) as 'first_half' | 'second_half',
    segmentId: r.segment_id ? String(r.segment_id) : null,
    startSeconds: Number(r.start_seconds ?? 0),
    endSeconds: Number(r.end_seconds ?? 0),
    sessionStartSeconds: Number(r.session_start_seconds ?? 0),
    sessionEndSeconds: Number(r.session_end_seconds ?? 0),
    inGameClock: r.in_game_clock ? String(r.in_game_clock) : null,
    categoryGroup: String(r.category_group) as AiGameplayObservationRecord['categoryGroup'],
    category: String(r.category),
    teamAttribution: String(r.team_attribution) as AiGameplayObservationRecord['teamAttribution'],
    playerAttribution: String(r.player_attribution ?? 'Unknown'),
    description: String(r.description),
    supportingVisualEvidence: String(r.supporting_visual_evidence ?? ''),
    evidenceType: String(r.evidence_type) as AiGameplayObservationRecord['evidenceType'],
    confidence: String(r.confidence) as AiGameplayObservationRecord['confidence'],
    severity: String(r.severity) as AiGameplayObservationRecord['severity'],
    limitations: String(r.limitations ?? ''),
    evidenceFramePath: r.evidence_frame_path ? String(r.evidence_frame_path) : null,
    isFromReplay: Boolean(r.is_from_replay),
    createdAt: String(r.created_at),
  };
}

function mapVisionAssessmentRow(r: Record<string, unknown>): AiTacticalVisionAssessmentRecord {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    matchId: String(r.match_id),
    half: String(r.half) as 'first_half' | 'second_half',
    intendedVisionKey: String(r.intended_vision_key) as AiTacticalVisionAssessmentRecord['intendedVisionKey'],
    observedPlayingStyle: safeJsonParse<AiTacticalVisionAssessmentRecord['observedPlayingStyle']>(
      String(r.observed_playing_style_json ?? '{}'),
      {
        primaryTendency: 'Unknown',
        mixedTendencies: [],
        evidenceSummary: '',
        isInsufficientEvidence: true,
      }
    ),
    recommendedVisionKey: String(
      r.recommended_vision_key
    ) as AiTacticalVisionAssessmentRecord['recommendedVisionKey'],
    recommendationStance: String(
      r.recommendation_stance
    ) as AiTacticalVisionAssessmentRecord['recommendationStance'],
    recommendationRationale: String(r.recommendation_rationale ?? ''),
    officialComplianceStatus: String(
      r.official_compliance_status
    ) as AiTacticalVisionAssessmentRecord['officialComplianceStatus'],
    roleAffinityMatchedCount: Number(r.role_affinity_matched_count ?? 0),
    roleAffinityTotalCount: Number(r.role_affinity_total_count ?? 0),
    roleAffinityUnknownCount: Number(r.role_affinity_unknown_count ?? 0),
    executionAssessmentLabel: String(r.execution_assessment_label ?? 'Unknown'),
    internalAssessmentScore:
      r.internal_assessment_score === null || r.internal_assessment_score === undefined
        ? null
        : Number(r.internal_assessment_score),
    scoreMethodologyNote: String(r.score_methodology_note ?? ''),
    criteriaBreakdown: safeJsonParse<AiTacticalVisionAssessmentRecord['criteriaBreakdown']>(
      String(r.criteria_breakdown_json ?? '[]'),
      []
    ),
    confidence: String(r.confidence) as AiTacticalVisionAssessmentRecord['confidence'],
    limitations: String(r.limitations ?? ''),
    createdAt: String(r.created_at),
  };
}

function mapDecisionRow(r: Record<string, unknown>): AiRecommendationDecisionRecord {
  return {
    id: String(r.id),
    recommendationId: String(r.recommendation_id),
    matchId: String(r.match_id),
    jobId: String(r.job_id),
    decisionStatus: String(r.decision_status) as RecommendationDecisionStatus,
    modifiedValue: r.modified_value ? String(r.modified_value) : null,
    appliedInGame: Boolean(r.applied_in_game),
    appliedConfirmedAt: r.applied_confirmed_at ? String(r.applied_confirmed_at) : null,
    adjustmentSnapshotId: r.adjustment_snapshot_id ? String(r.adjustment_snapshot_id) : null,
    userNotes: String(r.user_notes ?? ''),
    updatedAt: String(r.updated_at),
  };
}

function mapRecommendationRow(
  r: Record<string, unknown>,
  decision?: AiRecommendationDecisionRecord | null
): AiTacticalRecommendationRecord {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    matchId: String(r.match_id),
    priorityGroup: String(r.priority_group) as AiTacticalRecommendationRecord['priorityGroup'],
    priorityRank: Number(r.priority_rank ?? 1),
    title: String(r.title),
    actionType: String(r.action_type) as AiTacticalRecommendationRecord['actionType'],
    targetSlotId: r.target_slot_id ? String(r.target_slot_id) : null,
    targetPositionCode: r.target_position_code ? String(r.target_position_code) : null,
    currentValue: String(r.current_value ?? ''),
    proposedValue: String(r.proposed_value ?? ''),
    targetPlayerOutId: r.target_player_out_id ? String(r.target_player_out_id) : null,
    targetPlayerInId: r.target_player_in_id ? String(r.target_player_in_id) : null,
    reason: String(r.reason ?? ''),
    expectedBenefit: String(r.expected_benefit ?? ''),
    potentialRisk: String(r.potential_risk ?? ''),
    evidenceObservationIds: safeJsonParse<string[]>(
      String(r.evidence_observation_ids_json ?? '[]'),
      []
    ),
    evidenceTimestamps: safeJsonParse<AiTacticalRecommendationRecord['evidenceTimestamps']>(
      String(r.evidence_timestamps_json ?? '[]'),
      []
    ),
    confidence: String(r.confidence) as AiTacticalRecommendationRecord['confidence'],
    validationStatus: String(r.validation_status) as AiTacticalRecommendationRecord['validationStatus'],
    validationErrors: safeJsonParse<string[]>(String(r.validation_errors_json ?? '[]'), []),
    rawAiProposal: safeJsonParse<Record<string, unknown> | null>(
      r.raw_ai_proposal_json ? String(r.raw_ai_proposal_json) : null,
      null
    ),
    decision: decision ?? null,
    createdAt: String(r.created_at),
  };
}

export function markInterruptedJobsOnStartup(dbArg?: Database.Database): number {
  const db = dbArg ?? getDb();
  const now = new Date().toISOString();
  const placeholders = ACTIVE_JOB_STATUSES.map(() => '?').join(', ');

  // Mark any orphaned active jobs from a prior app shutdown/crash as interrupted (never auto-restart uploads!)
  const res = db
    .prepare(
      `UPDATE ai_analysis_jobs
       SET status = 'interrupted',
           current_stage = 'interrupted',
           error_code = 'ANALYSIS_INTERRUPTED',
           error_message = 'Application restarted while this analysis job was running. Pending remote uploads are queued for cleanup; you may safely start a fresh analysis run.',
           completed_at = ?,
           last_activity_at = ?,
           updated_at = ?
       WHERE status IN (${placeholders})`
    )
    .run(now, now, now, ...ACTIVE_JOB_STATUSES);

  // Transition any left-behind 'uploaded' or 'deleting' assets to 'cleanup_pending' so startup cleanup sweeps them
  db.prepare(
    `UPDATE ai_analysis_assets
     SET cleanup_status = 'cleanup_pending', updated_at = ?
     WHERE remote_file_name IS NOT NULL AND cleanup_status IN ('uploaded', 'deleting', 'pending')`
  ).run(now);

  return res.changes;
}

/**
 * Detects stale/stuck active jobs whose heartbeat has expired beyond `staleThresholdMs`
 * and marks them safely as `interrupted` (`ANALYSIS_INTERRUPTED`) without auto-restarting uploads.
 */
export function reconcileStaleAnalysisJobs(options: {
  staleThresholdMs?: number;
  db?: Database.Database;
} = {}): number {
  const db = options.db ?? getDb();
  const thresholdMs = options.staleThresholdMs ?? 10 * 60 * 1000;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const placeholders = ACTIVE_JOB_STATUSES.map(() => '?').join(', ');

  const activeRows = db
    .prepare(
      `SELECT id, last_heartbeat_at, last_activity_at, updated_at, created_at
       FROM ai_analysis_jobs
       WHERE status IN (${placeholders})`
    )
    .all(...ACTIVE_JOB_STATUSES) as Array<{
    id: string;
    last_heartbeat_at: string | null;
    last_activity_at: string | null;
    updated_at: string;
    created_at: string;
  }>;

  let reconciled = 0;
  for (const row of activeRows) {
    const lastTs = Date.parse(
      row.last_heartbeat_at ?? row.last_activity_at ?? row.updated_at ?? row.created_at
    );
    const ageMs = Number.isFinite(lastTs) ? nowMs - lastTs : thresholdMs + 1;
    if (ageMs >= thresholdMs) {
      const ctrl = activeJobControllers.get(row.id);
      if (ctrl) {
        try {
          ctrl.abort();
        } catch {
          // ignore
        }
        activeJobControllers.delete(row.id);
      }
      runningJobIds.delete(row.id);

      const diag: SanitizedGeminiErrorDiagnostic = {
        code: 'ANALYSIS_INTERRUPTED',
        httpStatus: null,
        apiStatus: null,
        upstreamMessage: `Job heartbeat went stale for ${Math.round(ageMs / 1000)}s and was marked interrupted.`,
        stage: 'stale_job_reconciliation',
        modelId: null,
        segmentIndex: null,
        attemptNumber: null,
        elapsedMs: ageMs,
        retryable: true,
        retryAfterMs: null,
        occurredAt: nowIso,
      };

      const changed = db
        .prepare(
          `UPDATE ai_analysis_jobs
           SET status = 'interrupted',
               current_stage = 'interrupted',
               error_code = 'ANALYSIS_INTERRUPTED',
               error_message = 'Analysis job heartbeat stopped responding and was marked interrupted. You may safely start a fresh analysis run.',
               diagnostics_json = ?,
               completed_at = ?,
               last_activity_at = ?,
               updated_at = ?
           WHERE id = ? AND status IN (${placeholders})`
        )
        .run(JSON.stringify(diag), nowIso, nowIso, nowIso, row.id, ...ACTIVE_JOB_STATUSES);

      if (changed.changes > 0) {
        reconciled += 1;
        db.prepare(
          `UPDATE ai_analysis_assets
           SET cleanup_status = 'cleanup_pending', updated_at = ?
           WHERE job_id = ? AND remote_file_name IS NOT NULL AND cleanup_status IN ('uploaded', 'deleting', 'pending')`
        ).run(nowIso, row.id);
      }
    }
  }
  return reconciled;
}

export function getAnalysisJob(jobId: string, dbArg?: Database.Database): AiAnalysisJobRecord | null {
  const db = dbArg ?? getDb();
  const row = db.prepare('SELECT * FROM ai_analysis_jobs WHERE id = ?').get(jobId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapJobRow(row) : null;
}

export function listMatchAnalysisBundle(
  matchId: string,
  preferredJobId?: string,
  dbArg?: Database.Database
): MatchAnalysisBundle {
  const db = dbArg ?? getDb();
  const jobRows = db
    .prepare('SELECT * FROM ai_analysis_jobs WHERE match_id = ? ORDER BY created_at DESC')
    .all(matchId) as Array<Record<string, unknown>>;

  const jobs = jobRows.map(mapJobRow);
  const activeJob = jobs.find((j) => ACTIVE_JOB_STATUSES.includes(j.status)) ?? null;
  const latestFirstHalfJob = jobs.find((j) => j.half === 'first_half') ?? null;
  const latestSecondHalfJob = jobs.find((j) => j.half === 'second_half') ?? null;

  const targetJob =
    (preferredJobId ? jobs.find((j) => j.id === preferredJobId) : null) ??
    jobs.find((j) =>
      ['completed', 'completed_with_limitations', 'insufficient_gameplay'].includes(j.status)
    ) ??
    jobs[0] ??
    null;

  const checkpointRows = db
    .prepare(
      `SELECT * FROM ai_analysis_checkpoints
       WHERE match_id = ? AND status = 'valid'
       ORDER BY updated_at DESC LIMIT 30`
    )
    .all(matchId) as Array<Record<string, unknown>>;
  const checkpoints = checkpointRows.map(mapCheckpointRow);

  const firstHalfResume = getResumableCheckpointsForMatchHalf(matchId, 'first_half', { db });
  const secondHalfResume = getResumableCheckpointsForMatchHalf(matchId, 'second_half', { db });
  const resumableCheckpoint = firstHalfResume.canResume
    ? firstHalfResume
    : secondHalfResume.canResume
      ? secondHalfResume
      : null;

  if (!targetJob) {
    return {
      matchId,
      jobs: [],
      activeJob: null,
      latestFirstHalfJob: null,
      latestSecondHalfJob: null,
      briefing: null,
      visionAssessment: null,
      classifications: [],
      observations: [],
      recommendations: [],
      assets: [],
      secondHalfComparison: null,
      checkpoints,
      resumableCheckpoint,
    };
  }

  const briefingRow = db
    .prepare('SELECT * FROM ai_halftime_briefings WHERE job_id = ?')
    .get(targetJob.id) as Record<string, unknown> | undefined;

  const briefing: AiHalftimeBriefingPayload | null = briefingRow
    ? safeJsonParse<AiHalftimeBriefingPayload | null>(String(briefingRow.briefing_json), null)
    : null;

  const vaRow = db
    .prepare('SELECT * FROM ai_tactical_vision_assessments WHERE job_id = ?')
    .get(targetJob.id) as Record<string, unknown> | undefined;
  const visionAssessment = vaRow ? mapVisionAssessmentRow(vaRow) : null;

  const classRows = db
    .prepare('SELECT * FROM ai_video_classifications WHERE job_id = ? ORDER BY session_start_seconds ASC')
    .all(targetJob.id) as Array<Record<string, unknown>>;

  const obsRows = db
    .prepare('SELECT * FROM ai_gameplay_observations WHERE job_id = ? ORDER BY session_start_seconds ASC')
    .all(targetJob.id) as Array<Record<string, unknown>>;

  const recRows = db
    .prepare(
      'SELECT * FROM ai_tactical_recommendations WHERE job_id = ? ORDER BY priority_rank ASC, created_at ASC'
    )
    .all(targetJob.id) as Array<Record<string, unknown>>;

  const decRows = db
    .prepare('SELECT * FROM ai_recommendation_decisions WHERE job_id = ?')
    .all(targetJob.id) as Array<Record<string, unknown>>;
  const decByRecId = new Map<string, AiRecommendationDecisionRecord>();
  for (const d of decRows) {
    const mapped = mapDecisionRow(d);
    decByRecId.set(mapped.recommendationId, mapped);
  }

  const assetRows = db
    .prepare('SELECT * FROM ai_analysis_assets WHERE job_id = ? ORDER BY created_at ASC')
    .all(targetJob.id) as Array<Record<string, unknown>>;

  const compRow = db
    .prepare(
      'SELECT * FROM ai_second_half_comparisons WHERE match_id = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(matchId) as Record<string, unknown> | undefined;
  const secondHalfComparison = compRow
    ? safeJsonParse<AiSecondHalfComparisonPayload | null>(String(compRow.comparison_json), null)
    : null;

  return {
    matchId,
    jobs,
    activeJob,
    latestFirstHalfJob,
    latestSecondHalfJob,
    briefing,
    visionAssessment,
    classifications: classRows.map(mapClassificationRow),
    observations: obsRows.map(mapObservationRow),
    recommendations: recRows.map((r) => mapRecommendationRow(r, decByRecId.get(String(r.id)) ?? null)),
    assets: assetRows.map(mapAssetRow),
    secondHalfComparison,
    checkpoints,
    resumableCheckpoint,
  };
}

export function cancelAnalysisJob(jobId: string, dbArg?: Database.Database): AiAnalysisJobRecord | null {
  const db = dbArg ?? getDb();
  const job = getAnalysisJob(jobId, db);
  if (!job) return null;

  cancelRequestedJobIds.add(jobId);
  // Immediately abort any active AbortController bound to SDK requests for this job
  const controller = activeJobControllers.get(jobId);
  if (controller) {
    try {
      controller.abort();
    } catch {
      // ignore abort error
    }
  }

  const now = new Date().toISOString();
  if (ACTIVE_JOB_STATUSES.includes(job.status)) {
    const diag: SanitizedGeminiErrorDiagnostic = {
      code: 'ANALYSIS_CANCELLED',
      httpStatus: null,
      apiStatus: null,
      upstreamMessage: 'Analysis job was cancelled by the user.',
      stage: job.currentStage,
      modelId: job.modelVideoId,
      segmentIndex: job.currentSegmentIndex ?? null,
      attemptNumber: job.retryAttempt ?? 0,
      elapsedMs: job.elapsedMs,
      retryable: false,
      retryAfterMs: null,
      occurredAt: now,
    };
    db.prepare(
      `UPDATE ai_analysis_jobs
       SET cancel_requested = 1,
           status = 'cancelled',
           current_stage = 'cancelled',
           error_code = 'ANALYSIS_CANCELLED',
           error_message = 'Analysis job was cancelled by the user.',
           diagnostics_json = ?,
           completed_at = COALESCE(completed_at, ?),
           last_activity_at = ?,
           updated_at = ?
       WHERE id = ?
         AND status NOT IN ('completed', 'completed_with_limitations', 'insufficient_gameplay', 'failed', 'cancelled', 'interrupted')`
    ).run(JSON.stringify(diag), now, now, now, jobId);
  }
  return getAnalysisJob(jobId, db);
}

/**
 * Durably deletes a single uploaded remote Gemini file, transitioning:
 * uploaded / cleanup_pending / cleanup_failed -> deleting -> deleted | cleanup_failed.
 * Never touches local gameplay recordings on disk.
 */
async function deleteSingleRemoteAsset(
  db: Database.Database,
  assetId: string,
  remoteFileName: string,
  provider: GeminiVideoProvider
): Promise<{ deleted: boolean; error: string | null }> {
  const deletingAt = new Date().toISOString();
  db.prepare(
    `UPDATE ai_analysis_assets
     SET cleanup_status = 'deleting',
         cleanup_attempts = COALESCE(cleanup_attempts, 0) + 1,
         cleanup_attempted_at = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(deletingAt, deletingAt, assetId);

  try {
    const res = await provider.deleteRemoteFile(remoteFileName);
    const doneAt = new Date().toISOString();
    const cleanErr = res.error ? sanitizeDiagnosticText(res.error) : null;
    db.prepare(
      `UPDATE ai_analysis_assets
       SET cleanup_status = ?,
           cleanup_confirmed_at = ?,
           cleanup_error = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(
      res.deleted ? 'deleted' : 'cleanup_failed',
      res.deleted ? doneAt : null,
      res.deleted ? null : cleanErr,
      doneAt,
      assetId
    );
    return { deleted: res.deleted, error: res.deleted ? null : cleanErr };
  } catch (err) {
    const doneAt = new Date().toISOString();
    const cleanErr = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err));
    db.prepare(
      `UPDATE ai_analysis_assets
       SET cleanup_status = 'cleanup_failed',
           cleanup_error = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(cleanErr, doneAt, assetId);
    return { deleted: false, error: cleanErr };
  }
}

export async function retryRemoteCleanup(
  jobId: string,
  provider: GeminiVideoProvider = defaultLiveGeminiVideoProvider,
  dbArg?: Database.Database
): Promise<AiAnalysisAssetRecord[]> {
  const db = dbArg ?? getDb();
  const statusPlaceholders = CLEANABLE_ASSET_STATUSES.map(() => '?').join(', ');
  const assetRows = db
    .prepare(
      `SELECT * FROM ai_analysis_assets
       WHERE job_id = ? AND remote_file_name IS NOT NULL AND cleanup_status IN (${statusPlaceholders})`
    )
    .all(jobId, ...CLEANABLE_ASSET_STATUSES) as Array<Record<string, unknown>>;

  for (const row of assetRows) {
    await deleteSingleRemoteAsset(db, String(row.id), String(row.remote_file_name), provider);
  }

  const refreshed = db
    .prepare('SELECT * FROM ai_analysis_assets WHERE job_id = ? ORDER BY created_at ASC')
    .all(jobId) as Array<Record<string, unknown>>;
  return refreshed.map(mapAssetRow);
}

/**
 * Sweeps all pending remote Gemini uploads across jobs (e.g., on startup after crash/restart
 * or during graceful shutdown). Never touches local gameplay recordings.
 */
export async function cleanupPendingRemoteFiles(
  provider: GeminiVideoProvider = defaultLiveGeminiVideoProvider,
  dbArg?: Database.Database
): Promise<{ attempted: number; deleted: number; failed: number }> {
  const db = dbArg ?? getDb();
  const targetStatuses = ['uploaded', 'cleanup_pending', 'deleting', 'pending'];
  const placeholders = targetStatuses.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, remote_file_name FROM ai_analysis_assets
       WHERE remote_file_name IS NOT NULL AND cleanup_status IN (${placeholders})`
    )
    .all(...targetStatuses) as Array<{ id: string; remote_file_name: string }>;

  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    const res = await deleteSingleRemoteAsset(db, row.id, row.remote_file_name, provider);
    if (res.deleted) deleted += 1;
    else failed += 1;
  }
  return { attempted: rows.length, deleted, failed };
}

/**
 * Graceful shutdown handler: aborts any in-flight Gemini jobs, marks them interrupted,
 * and attempts immediate remote media cleanup for uploaded files.
 */
export async function shutdownAnalysisOrchestrator(
  provider: GeminiVideoProvider = defaultLiveGeminiVideoProvider,
  dbArg?: Database.Database
): Promise<{ interruptedJobs: number; cleanup: { attempted: number; deleted: number; failed: number } }> {
  for (const [jobId, ctrl] of activeJobControllers.entries()) {
    cancelRequestedJobIds.add(jobId);
    try {
      ctrl.abort();
    } catch {
      // ignore
    }
  }
  activeJobControllers.clear();

  const db = dbArg ?? getDb();
  const interruptedJobs = markInterruptedJobsOnStartup(db);
  const cleanup = await cleanupPendingRemoteFiles(provider, db);
  return { interruptedJobs, cleanup };
}

function updateJobProgress(
  db: Database.Database,
  jobId: string,
  patch: Partial<{
    status: AnalysisJobStatus;
    currentStage: string;
    progressDetail: AiAnalysisJobRecord['progressDetail'];
    analysisStrategy: AnalysisStrategy;
    stageModelsUsed: Record<string, string>;
    fallbackHistory: ModelFailoverEvent[];
    validationSummary: ValidationAuditSummary;
    checkpointResumedFromJobId: string | null;
    segmentsTotal: number;
    segmentsProcessed: number;
    currentSegmentIndex: number | null;
    coverageSummary: string;
    actualCostUsd: number;
    startedAt: string;
    completedAt: string;
    lastHeartbeatAt: string;
    lastActivityAt: string;
    stageStartedAt: string;
    elapsedMs: number;
    timingBreakdown: AnalysisTimingBreakdown;
    errorCode: string | null;
    errorMessage: string | null;
    diagnostics: SanitizedGeminiErrorDiagnostic | null;
    retryCount: number;
    retryAttempt: number;
  }>,
  options: { allowTerminalTransition?: boolean } = {}
): void {
  const existing = db.prepare('SELECT * FROM ai_analysis_jobs WHERE id = ?').get(jobId) as
    | Record<string, unknown>
    | undefined;
  if (!existing) return;

  const existingStatus = String(existing.status) as AnalysisJobStatus;
  // Prevent late background requests from mutating already completed, failed, cancelled, or interrupted jobs
  if (TERMINAL_JOB_STATUSES.has(existingStatus) && !options.allowTerminalTransition) {
    return;
  }

  const now = new Date().toISOString();
  const nextStage = patch.currentStage ?? String(existing.current_stage);
  const stageChanged = nextStage !== String(existing.current_stage);
  const stageStartedAt =
    patch.stageStartedAt ??
    (stageChanged ? now : existing.stage_started_at ? String(existing.stage_started_at) : now);

  db.prepare(`
    UPDATE ai_analysis_jobs
    SET status = ?,
        current_stage = ?,
        progress_detail_json = ?,
        analysis_strategy = ?,
        stage_models_json = ?,
        fallback_history_json = ?,
        validation_summary_json = ?,
        checkpoint_resumed_from_job_id = ?,
        segments_total = ?,
        segments_processed = ?,
        current_segment_index = ?,
        coverage_summary = ?,
        actual_cost_usd = ?,
        started_at = ?,
        completed_at = ?,
        last_heartbeat_at = ?,
        last_activity_at = ?,
        stage_started_at = ?,
        elapsed_ms = ?,
        timing_breakdown_json = ?,
        error_code = ?,
        error_message = ?,
        diagnostics_json = ?,
        retry_count = ?,
        retry_attempt = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    patch.status ?? existingStatus,
    nextStage,
    patch.progressDetail
      ? JSON.stringify(patch.progressDetail)
      : String(existing.progress_detail_json ?? '{}'),
    patch.analysisStrategy ?? String(existing.analysis_strategy ?? 'native_video'),
    patch.stageModelsUsed !== undefined
      ? JSON.stringify(patch.stageModelsUsed)
      : existing.stage_models_json ?? null,
    patch.fallbackHistory !== undefined
      ? JSON.stringify(patch.fallbackHistory)
      : existing.fallback_history_json ?? null,
    patch.validationSummary !== undefined
      ? JSON.stringify(patch.validationSummary)
      : existing.validation_summary_json ?? null,
    patch.checkpointResumedFromJobId !== undefined
      ? patch.checkpointResumedFromJobId
      : existing.checkpoint_resumed_from_job_id ?? null,
    patch.segmentsTotal ?? Number(existing.segments_total ?? 0),
    patch.segmentsProcessed ?? Number(existing.segments_processed ?? 0),
    patch.currentSegmentIndex !== undefined
      ? patch.currentSegmentIndex
      : existing.current_segment_index ?? null,
    patch.coverageSummary ?? String(existing.coverage_summary ?? ''),
    patch.actualCostUsd !== undefined ? patch.actualCostUsd : existing.actual_cost_usd,
    patch.startedAt ?? existing.started_at,
    patch.completedAt ?? existing.completed_at,
    patch.lastHeartbeatAt ?? existing.last_heartbeat_at ?? now,
    patch.lastActivityAt ?? now,
    stageStartedAt,
    patch.elapsedMs ?? Number(existing.elapsed_ms ?? 0),
    patch.timingBreakdown
      ? JSON.stringify(patch.timingBreakdown)
      : existing.timing_breakdown_json,
    patch.errorCode !== undefined ? patch.errorCode : existing.error_code,
    patch.errorMessage !== undefined ? patch.errorMessage : existing.error_message,
    patch.diagnostics !== undefined
      ? patch.diagnostics
        ? JSON.stringify(patch.diagnostics)
        : null
      : existing.diagnostics_json ?? null,
    patch.retryCount ?? Number(existing.retry_count ?? 0),
    patch.retryAttempt !== undefined ? patch.retryAttempt : Number(existing.retry_attempt ?? 0),
    now,
    jobId
  );
}

export interface StartAnalysisJobInput {
  matchId: string;
  sessionId?: string | null;
  half: 'first_half' | 'second_half';
  analysisMode?: VideoAnalysisMode;
  language?: AnalysisLanguage;
  privacyAuthorized: boolean;
  entireDisplayAcknowledged?: boolean;
  forceReanalyze?: boolean;
  /** Phase 3.0.3 opt-in checkpoint resume (never automatic) */
  resumeFromCheckpoint?: boolean;
  /** Phase 3.0.3 explicit strategy override */
  analysisStrategy?: AnalysisStrategy;
  /** Test/runtime injection options */
  provider?: GeminiVideoProvider;
  preflightClientOverride?: GeminiDiscoveryClientLike | null;
  skipLivePreflight?: boolean;
  allowedMediaDirs?: string[];
  awaitCompletion?: boolean;
}

export async function startAnalysisJob(
  input: StartAnalysisJobInput,
  dbArg?: Database.Database
): Promise<{ job: AiAnalysisJobRecord; reusedFromCache: boolean }> {
  const db = dbArg ?? getDb();
  const provider = input.provider ?? defaultLiveGeminiVideoProvider;
  const settings = getSettings();

  if (!input.privacyAuthorized) {
    throw new Error(
      'Privacy authorization is required before uploading local gameplay footage for AI analysis.'
    );
  }

  // Require real GEMINI_API_KEY when using live provider
  if (!provider.isMock && !isGeminiApiConfigured()) {
    throw new Error(
      'GEMINI_API_KEY is not configured in the local server environment. Configure GEMINI_API_KEY in .env before running real video analysis.'
    );
  }

  // Reconcile any stale jobs before checking duplicates
  reconcileStaleAnalysisJobs({ db });

  // Prevent duplicate active jobs for the same match + half
  const activePlaceholders = ACTIVE_JOB_STATUSES.map(() => '?').join(', ');
  const existingActive = db
    .prepare(
      `SELECT id FROM ai_analysis_jobs
       WHERE match_id = ? AND half = ? AND status IN (${activePlaceholders})
       LIMIT 1`
    )
    .get(input.matchId, input.half, ...ACTIVE_JOB_STATUSES) as { id: string } | undefined;

  if (existingActive) {
    throw new Error(
      `An active AI analysis job is already running for this match (${input.half.replace('_', ' ')}). Wait for completion or cancel the active job first.`
    );
  }

  // Resolve target recording session
  const sessions = listMatchSessions({ matchId: input.matchId });
  const targetSession = input.sessionId
    ? getMatchSessionById(input.sessionId)
    : sessions.find(
        (s) =>
          s.half === input.half &&
          s.aiEligible &&
          ['completed', 'recovered', 'partial'].includes(s.status)
      ) ?? sessions.find((s) => s.half === input.half) ?? null;

  if (!targetSession) {
    throw new Error(
      `No recorded ${input.half.replace('_', ' ')} session was found for this match. Record gameplay first (or import a test clip in Browser Preview mode).`
    );
  }

  if (targetSession.matchId !== input.matchId) {
    throw new MediaPathError(
      'RECORDING_SESSION_MISMATCH',
      `Recording session "${targetSession.id}" belongs to a different match and cannot be analyzed for match "${input.matchId}".`
    );
  }

  if (targetSession.half !== input.half) {
    throw new MediaPathError(
      'RECORDING_SESSION_MISMATCH',
      `Recording session "${targetSession.id}" is recorded for ${targetSession.half.replace('_', ' ')}, not ${input.half.replace('_', ' ')}.`
    );
  }

  if (!targetSession.aiEligible || targetSession.segments.length === 0) {
    throw new Error(
      `Recording session is not AI-eligible (${targetSession.failureReason ?? 'no verified MP4 segments found'}).`
    );
  }

  const isEntireDisplay =
    Boolean(targetSession.captureSourceName?.toLowerCase().includes('screen')) ||
    Boolean(targetSession.captureSourceName?.toLowerCase().includes('display')) ||
    Boolean(targetSession.captureSourceName?.toLowerCase().includes('entire'));

  if (isEntireDisplay && !input.entireDisplayAcknowledged) {
    throw new Error(
      'This recording captured an Entire Display source. Confirm that no private windows or notifications are visible before uploading to Gemini.'
    );
  }

  const analysisMode: VideoAnalysisMode = input.analysisMode ?? settings.ai.defaultAnalysisMode ?? 'balanced';
  const language: AnalysisLanguage = input.language ?? settings.ai.defaultLanguage ?? 'en';

  // Authoritative single-source model resolution (never silently falls back to unverified hardcoded model IDs)
  const routing = resolveEffectiveModelRouting(settings.ai, analysisMode);
  const modelVideoId = routing.effectiveVideoModelId;
  const modelSynthesisId = routing.effectiveSynthesisModelId;

  if (!modelVideoId || !modelSynthesisId) {
    throw new Error(
      routing.warnings[0] ??
        'No verified Gemini model is configured. Select a Primary Default Model in Settings -> AI & Evidence Policy.'
    );
  }

  // Run Preflight live model access & capability validation BEFORE uploading any video bytes
  if (!provider.isMock && !input.skipLivePreflight) {
    const preflight = await runAnalysisPreflight({
      matchId: input.matchId,
      sessionId: targetSession.id,
      half: input.half,
      analysisMode,
      privacyAuthorized: input.privacyAuthorized,
      entireDisplayAcknowledged: input.entireDisplayAcknowledged,
      verifyLiveModelAccess: true,
      isMockProvider: false,
      allowedMediaDirs: input.allowedMediaDirs,
      clientOverride: input.preflightClientOverride,
      db,
    });
    if (!preflight.ok) {
      if (preflight.diagnostic) {
        throw new GeminiStageError({
          code: preflight.diagnostic.code,
          userMessage: preflight.blockingMessage ?? preflight.diagnostic.upstreamMessage,
          retryable: preflight.diagnostic.retryable,
          diagnostic: preflight.diagnostic,
        });
      }
      throw new Error(
        preflight.blockingMessage ?? `Preflight validation failed (${preflight.blockingErrorCode ?? 'PREFLIGHT_FAILED'}).`
      );
    }
  }

  const samplingFps =
    analysisMode === 'deep'
      ? settings.ai.samplingFpsDeep ?? 2.0
      : analysisMode === 'balanced'
        ? settings.ai.samplingFpsBalanced ?? 2.0
        : settings.ai.samplingFpsQuick ?? 1.0;

  const validSegments = targetSession.segments.filter(
    (s) => ['finalized', 'recovered'].includes(s.status) && s.sizeBytes > 0 && s.durationSeconds > 0
  );
  if (validSegments.length === 0) {
    throw new Error('Recording session has 0 valid non-empty video segments.');
  }

  const totalDurationSeconds = validSegments.reduce((sum, s) => sum + s.durationSeconds, 0);
  const costEst = estimateVideoAnalysisCostUsd({
    modelVideoId,
    modelSynthesisId,
    totalDurationSeconds,
    samplingFps,
    segmentCount: validSegments.length,
  });

  // Enforce per-match and daily budget guardrails BEFORE launching
  const perMatchCap = settings.ai.perMatchBudgetUsd ?? 1.5;
  const dailyCap = settings.ai.dailyBudgetUsd ?? 5.0;
  const dailySpend = getDailyApiSpendUsd();
  const currentMatchSpend = dailySpend.matchSpendByMatchId[input.matchId] ?? 0;

  if (currentMatchSpend + costEst.estimatedCostUsd > perMatchCap) {
    throw new Error(
      `Per-match AI budget guardrail exceeded: estimated run ($${costEst.estimatedCostUsd.toFixed(4)}) + prior match spend ($${currentMatchSpend.toFixed(4)}) exceeds per-match cap ($${perMatchCap.toFixed(2)}). Increase cap in Settings or switch to Quick mode.`
    );
  }
  if (dailySpend.totalEstimatedUsd + costEst.estimatedCostUsd > dailyCap) {
    throw new Error(
      `Daily AI budget guardrail exceeded: estimated run ($${costEst.estimatedCostUsd.toFixed(4)}) + today's spend ($${dailySpend.totalEstimatedUsd.toFixed(4)}) exceeds daily cap ($${dailyCap.toFixed(2)}).`
    );
  }

  const matchContext = buildAiMatchTacticalContext(input.matchId, db);
  if (!matchContext) {
    throw new Error(`Match "${input.matchId}" not found.`);
  }
  const visionCatalog = getTacticalVisionCatalog(db);

  const resumeSummary: AnalysisCheckpointResumeSummary | null = input.resumeFromCheckpoint
    ? getResumableCheckpointsForMatchHalf(input.matchId, input.half, {
        sessionId: targetSession.id,
        analysisMode,
        db,
      })
    : null;
  const checkpointResumedFromJobId =
    resumeSummary && resumeSummary.canResume ? resumeSummary.sourceJobId : null;
  const initialStrategy: AnalysisStrategy =
    input.analysisStrategy ??
    (resumeSummary && resumeSummary.canResume ? resumeSummary.analysisStrategy : 'native_video');

  // Build deterministic request fingerprint for cache reuse
  const fingerprintInput = JSON.stringify({
    matchId: input.matchId,
    sessionId: targetSession.id,
    segmentKeys: validSegments.map((s) => `${s.id}:${s.checksum ?? s.sizeBytes}:${s.durationSeconds}`),
    half: input.half,
    analysisMode,
    analysisStrategy: initialStrategy,
    language,
    modelVideoId,
    modelSynthesisId,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    visionDatasetVersion: visionCatalog.datasetVersion,
    snapshotId: matchContext.snapshotId,
    visionKey: matchContext.tacticalVisionKey,
  });
  const requestFingerprint = crypto.createHash('sha256').update(fingerprintInput).digest('hex');

  if (!input.forceReanalyze && !checkpointResumedFromJobId) {
    const cachedRow = db
      .prepare(
        `SELECT * FROM ai_analysis_jobs
         WHERE request_fingerprint = ? AND status IN ('completed', 'completed_with_limitations', 'insufficient_gameplay')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(requestFingerprint) as Record<string, unknown> | undefined;
    if (cachedRow) {
      return { job: mapJobRow(cachedRow), reusedFromCache: true };
    }
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ai_analysis_jobs (
      id, match_id, session_id, half, analysis_mode, language, status, current_stage,
      progress_detail_json, model_video_id, model_synthesis_id,
      analysis_strategy, stage_models_json, fallback_history_json, validation_summary_json,
      checkpoint_resumed_from_job_id,
      prompt_version, schema_version,
      tactical_vision_dataset_version, request_fingerprint, privacy_authorized, entire_display_acknowledged,
      estimated_cost_usd, actual_cost_usd, budget_cap_usd, segments_total, segments_processed,
      sampling_fps, coverage_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, '', ?, ?)
  `).run(
    jobId,
    input.matchId,
    targetSession.id,
    input.half,
    analysisMode,
    language,
    JSON.stringify({
      segmentsTotal: validSegments.length,
      segmentsProcessed: 0,
      stageLabel: checkpointResumedFromJobId
        ? 'Queued to resume from saved stage checkpoints'
        : 'Queued for video validation',
    }),
    modelVideoId,
    modelSynthesisId,
    initialStrategy,
    JSON.stringify({}),
    JSON.stringify([]),
    JSON.stringify(createEmptyValidationAuditSummary()),
    checkpointResumedFromJobId,
    PROMPT_VERSION,
    SCHEMA_VERSION,
    visionCatalog.datasetVersion,
    requestFingerprint,
    1,
    input.entireDisplayAcknowledged ? 1 : 0,
    costEst.estimatedCostUsd,
    perMatchCap,
    validSegments.length,
    samplingFps,
    now,
    now
  );

  const runPromise = executeAnalysisJobPipeline({
    jobId,
    matchId: input.matchId,
    sessionId: targetSession.id,
    half: input.half,
    analysisMode,
    initialStrategy,
    resumeSummary,
    language,
    modelVideoId,
    modelSynthesisId,
    samplingFps,
    provider,
    allowedMediaDirs: input.allowedMediaDirs,
    db,
  });

  if (input.awaitCompletion) {
    await runPromise;
  } else {
    void runPromise.catch((err) => {
      console.error('[Phase 3 Analysis Job Error]', err);
    });
  }

  return { job: getAnalysisJob(jobId, db)!, reusedFromCache: false };
}

interface PreparedSegmentAsset {
  assetId: string;
  segmentId: string;
  segmentIndex: number;
  sessionOffsetSeconds: number;
  localFilePath: string;
  preparedFilePath: string;
  sha256Hash: string;
  durationSeconds: number;
  sizeBytes: number;
  originalSizeBytes: number;
  processedSizeBytes: number;
  proxyApplied: boolean;
}

interface ClassificationCheckpointPayload {
  classifications: Array<{
    startSeconds: number;
    endSeconds: number;
    contentType: AiVideoClassificationRecord['contentType'];
    confidence: AiVideoClassificationRecord['confidence'];
    evidenceDescription: string;
    inGameClock: string | null;
  }>;
  readableHudStats: VideoClassificationOutput['readableHudStats'];
  liveWindows: Array<{ startSeconds: number; endSeconds: number }>;
  replayWindows: Array<{ startSeconds: number; endSeconds: number }>;
}

interface ObservationCheckpointPayload {
  observations: Array<{
    startSeconds: number;
    endSeconds: number;
    inGameClock: string | null;
    categoryGroup: AiGameplayObservationRecord['categoryGroup'];
    category: string;
    teamAttribution: AiGameplayObservationRecord['teamAttribution'];
    playerAttribution: string;
    description: string;
    supportingVisualEvidence: string;
    evidenceType: AiGameplayObservationRecord['evidenceType'];
    confidence: AiGameplayObservationRecord['confidence'];
    severity: AiGameplayObservationRecord['severity'];
    limitations: string;
    evidenceFramePath: string | null;
    isFromReplay: boolean;
  }>;
}

const FRAME_FALLBACK_ELIGIBLE_CODES = new Set<GeminiErrorCode>([
  'MODEL_VIDEO_UNSUPPORTED',
  'VIDEO_PROCESSING_FAILED',
  'VIDEO_PROCESSING_TIMEOUT',
  'INFERENCE_TIMEOUT',
  'UPSTREAM_SERVICE_UNAVAILABLE',
  'INVALID_MODEL_RESPONSE',
  'RATE_LIMIT_EXCEEDED',
  'MODEL_NOT_FOUND',
  'MODEL_ACCESS_DENIED',
]);

async function executeAnalysisJobPipeline(params: {
  jobId: string;
  matchId: string;
  sessionId: string;
  half: 'first_half' | 'second_half';
  analysisMode: VideoAnalysisMode;
  initialStrategy: AnalysisStrategy;
  resumeSummary: AnalysisCheckpointResumeSummary | null;
  language: AnalysisLanguage;
  modelVideoId: string;
  modelSynthesisId: string;
  samplingFps: number;
  provider: GeminiVideoProvider;
  allowedMediaDirs?: string[];
  db: Database.Database;
}): Promise<void> {
  const { jobId, matchId, sessionId, half, db, provider } = params;
  const settings = getSettings();
  const startedWallMs = Date.now();
  const startedAtIso = new Date().toISOString();
  const jobController = new AbortController();
  activeJobControllers.set(jobId, jobController);
  runningJobIds.add(jobId);

  const uploadTimeoutMs = (settings.ai.uploadTimeoutSeconds ?? 300) * 1000;
  const processingTimeoutMs =
    (settings.ai.processingTimeoutSeconds ?? settings.ai.maxAnalysisDurationSeconds ?? 180) * 1000;
  const inferenceTimeoutMs =
    (settings.ai.inferenceTimeoutSeconds ?? settings.ai.maxAnalysisDurationSeconds ?? 180) * 1000;
  const maxRetries = settings.ai.maxRetryAttempts ?? 2;
  const proxyEnabled =
    settings.ai.proxyEnabled !== undefined
      ? Boolean(settings.ai.proxyEnabled)
      : Boolean(settings.ai.downscaleForAnalysis);
  const proxySignature = buildProxySignature(params.analysisMode, proxyEnabled);

  const timing: AnalysisTimingBreakdown = {
    recordingDurationSeconds: 0,
    validationMs: 0,
    preprocessingMs: 0,
    uploadMs: 0,
    mediaProcessingMs: 0,
    classificationMs: 0,
    observationAnalysisMs: 0,
    tacticalSynthesisMs: 0,
    resultValidationMs: 0,
    totalElapsedMs: 0,
  };

  const validationSummary: ValidationAuditSummary = createEmptyValidationAuditSummary();
  const stageModelsUsed: Record<string, string> = {};
  const fallbackHistory: ModelFailoverEvent[] = [];
  let activeStrategy: AnalysisStrategy = params.initialStrategy;

  let cumulativeCostUsd = 0;
  let totalRetryCount = 0;
  let currentStageName = 'validating_recording';
  let currentModelInUse = params.modelVideoId;
  let currentSegmentNumber: number | null = null;
  let originalBytesTotal = 0;
  let processedBytesTotal = 0;
  let proxyAppliedCount = 0;
  const uploadedAssetsMap = new Map<string, string>(); // assetId -> remoteFileName

  // Periodic heartbeat timer keeps last_heartbeat_at and elapsed_ms fresh while long stages run
  const heartbeatTimer = setInterval(() => {
    try {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE ai_analysis_jobs
         SET last_heartbeat_at = ?, elapsed_ms = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('completed', 'completed_with_limitations', 'insufficient_gameplay', 'failed', 'cancelled', 'interrupted')`
      ).run(now, Date.now() - startedWallMs, now, jobId);
    } catch {
      // non-fatal heartbeat error
    }
  }, 4000);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }

  const isCancelled = (): boolean => {
    if (jobController.signal.aborted || cancelRequestedJobIds.has(jobId)) return true;
    const row = db
      .prepare('SELECT cancel_requested FROM ai_analysis_jobs WHERE id = ?')
      .get(jobId) as { cancel_requested: number } | undefined;
    if (row?.cancel_requested) {
      jobController.abort();
      return true;
    }
    return false;
  };

  const checkCancelledOrThrow = () => {
    if (isCancelled()) {
      throw new Error('__JOB_CANCELLED__');
    }
  };

  const validateAndRepairStageOutput = async <T>(opts: {
    stageName: string;
    modelId: string;
    raw: unknown;
    validator: (raw: unknown) => StageValidationResult<T>;
    canonicalSchema: Record<string, unknown>;
  }): Promise<T> => {
    const mergeResult = (res: StageValidationResult<T>) => {
      mergeValidationAuditSummary(validationSummary, {
        totalValidatedItems: res.totalValidatedItems,
        validItemsCount: res.validItemsCount,
        rejectedItemsCount: res.rejectedItemsCount,
        normalizedFields: res.normalizedFields,
        rejectedItems: res.rejectedItems,
        warnings: res.warnings,
      });
    };

    const first = opts.validator(opts.raw);
    mergeResult(first);
    if (first.valid && first.data !== null) {
      return first.data;
    }

    const firstPrimary = first.rejectedItems[0];
    const firstErrorMsg =
      first.blockingError?.message ??
      firstPrimary?.reason ??
      `Stage ${opts.stageName} failed schema/enum validation.`;

    // Attempt at most ONE bounded structured JSON repair pass if provider supports it
    if (typeof provider.repairStageJsonResponse === 'function') {
      validationSummary.repairedAttemptsCount += 1;
      try {
        const repaired = await provider.repairStageJsonResponse({
          modelId: opts.modelId,
          stage: opts.stageName,
          rawPayload: opts.raw,
          validationErrorMessage: firstErrorMsg,
          responseSchema: opts.canonicalSchema,
          inferenceTimeoutMs: Math.min(inferenceTimeoutMs, 60_000),
          abortSignal: jobController.signal,
        });
        cumulativeCostUsd += repaired.usage.estimatedCostUsd;
        insertApiUsageLog({
          matchId,
          analysisJobId: jobId,
          modelId: repaired.usage.modelId,
          stage: `${opts.stageName}_json_repair`,
          inputTokens: repaired.usage.inputTokens,
          outputTokens: repaired.usage.outputTokens,
          requestDurationMs: repaired.usage.durationMs,
          estimatedCostUsd: repaired.usage.estimatedCostUsd,
          pricingSource: 'local_registry_indicative_estimate',
          isEstimate: true,
          status: 'success',
        });

        const second = opts.validator(repaired.repairedPayload);
        mergeResult(second);
        if (second.valid && second.data !== null) {
          return second.data;
        }

        const primaryIssue = second.rejectedItems[0] ?? firstPrimary;
        throw new AiResponseValidationError({
          code: 'AI_RESPONSE_REPAIR_FAILED',
          stage: opts.stageName,
          message: `AI response for ${opts.stageName} remained invalid after 1 bounded repair pass: ${second.blockingError?.message ?? primaryIssue?.reason ?? 'schema/enum mismatch'}`,
          fieldName: second.blockingError?.fieldName ?? primaryIssue?.fieldName ?? null,
          expectedValues: second.blockingError?.expectedValues ?? primaryIssue?.expectedValues ?? null,
          receivedValuePreview:
            second.blockingError?.receivedValuePreview ?? primaryIssue?.receivedValuePreview ?? null,
          rejectedItems: second.rejectedItems.length > 0 ? second.rejectedItems : first.rejectedItems,
        });
      } catch (repairErr) {
        if (isAiResponseValidationError(repairErr)) {
          throw repairErr;
        }
        throw new AiResponseValidationError({
          code: 'AI_RESPONSE_REPAIR_FAILED',
          stage: opts.stageName,
          message: `AI response for ${opts.stageName} failed validation (${firstErrorMsg}) and the 1-pass repair attempt failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`,
          fieldName: first.blockingError?.fieldName ?? firstPrimary?.fieldName ?? null,
          expectedValues: first.blockingError?.expectedValues ?? firstPrimary?.expectedValues ?? null,
          receivedValuePreview:
            first.blockingError?.receivedValuePreview ?? firstPrimary?.receivedValuePreview ?? null,
          rejectedItems: first.rejectedItems,
        });
      }
    }

    if (first.blockingError) {
      throw first.blockingError;
    }

    throw new AiResponseValidationError({
      code:
        firstPrimary?.code === 'AI_RESPONSE_ENUM_INVALID'
          ? 'AI_RESPONSE_ENUM_INVALID'
          : 'AI_RESPONSE_SCHEMA_INVALID',
      stage: opts.stageName,
      message: `AI response validation rejected ${opts.stageName} output before database persistence: ${firstErrorMsg}`,
      fieldName: firstPrimary?.fieldName ?? null,
      expectedValues: firstPrimary?.expectedValues ?? null,
      receivedValuePreview: firstPrimary?.receivedValuePreview ?? null,
      rejectedItems: first.rejectedItems,
    });
  };

  const runStageWithModelFailover = async <T>(opts: {
    stageKey: string;
    stageLabel: string;
    capability: 'video' | 'image' | 'synthesis';
    initialModelId: string;
    reusedRemoteMedia: boolean;
    segmentIndex: number | null;
    invoke: (modelId: string) => Promise<T>;
  }): Promise<{ result: T; modelUsed: string }> => {
    const attempted = new Set<string>([opts.initialModelId]);
    let activeModelId = opts.initialModelId;
    let failoverCount = 0;
    const maxFailovers = 3;

    while (true) {
      checkCancelledOrThrow();
      currentModelInUse = activeModelId;

      try {
        const result = await opts.invoke(activeModelId);
        recordModelSuccess({
          modelId: activeModelId,
          capability: opts.capability,
          stage: currentStageName,
          db,
        });
        stageModelsUsed[opts.stageKey] = activeModelId;
        updateJobProgress(db, jobId, {
          stageModelsUsed,
          fallbackHistory,
        });
        return { result, modelUsed: activeModelId };
      } catch (err) {
        if (
          (err instanceof Error && err.message === '__JOB_CANCELLED__') ||
          isCancelled() ||
          isMediaPathError(err) ||
          isAiResponseValidationError(err)
        ) {
          throw err;
        }

        const classified = isGeminiStageError(err)
          ? {
              code: err.geminiErrorCode,
              userMessage: err.message,
              diagnostic: err.diagnostic,
            }
          : classifyGeminiError(err, {
              stage: currentStageName,
              modelId: activeModelId,
              segmentIndex: opts.segmentIndex,
              elapsedMs: Date.now() - startedWallMs,
            });

        // Never penalize model health or trigger Gemini failover on local database errors
        if (classified.diagnostic.errorDomain === 'database') {
          throw err;
        }

        recordModelFailure({
          modelId: activeModelId,
          capability: opts.capability,
          stage: currentStageName,
          errorCode: classified.code,
          errorMessage: classified.diagnostic.upstreamMessage,
          retryAfterMs: classified.diagnostic.retryAfterMs,
          db,
        });

        if (failoverCount >= maxFailovers) {
          throw err;
        }

        const discoveredModels = getGeminiStatus(activeModelId, settings.ai).models;
        const selection = selectFailoverCandidate({
          failedModelId: activeModelId,
          triedModelIds: attempted,
          stage: currentStageName,
          capability: opts.capability,
          errorCode: classified.code,
          aiSettings: settings.ai,
          discoveredModels,
          db,
        });

        if (!selection.selectedModelId) {
          throw err;
        }

        const event: ModelFailoverEvent = {
          stage: opts.stageKey,
          segmentIndex: opts.segmentIndex,
          fromModelId: activeModelId,
          toModelId: selection.selectedModelId,
          reasonCode: classified.code,
          reasonMessage: sanitizeDiagnosticText(classified.userMessage),
          reusedRemoteMedia: opts.reusedRemoteMedia,
          costDeltaAuthorized: selection.costDeltaAuthorized,
          occurredAt: new Date().toISOString(),
        };
        fallbackHistory.push(event);
        failoverCount += 1;
        activeModelId = selection.selectedModelId;
        attempted.add(activeModelId);

        updateJobProgress(db, jobId, {
          fallbackHistory,
          stageModelsUsed,
          elapsedMs: Date.now() - startedWallMs,
          progressDetail: {
            segmentsTotal: Math.max(1, Number(params.resumeSummary?.completedSegmentIndices.length ?? 0)),
            segmentsProcessed: Math.max(0, (opts.segmentIndex ?? 1) - 1),
            currentSegmentIndex: opts.segmentIndex,
            stageLabel: `Adaptive failover: switching ${opts.stageLabel} to ${activeModelId} after ${classified.code}`,
            proxyAppliedCount,
            originalBytesTotal,
            processedBytesTotal,
          },
        });
      }
    }
  };

  const canAttemptSequentialFrameFallback = (err: unknown): boolean => {
    if (!settings.ai.allowSequentialFrameFallback) return false;
    if (
      typeof provider.classifySequentialFrames !== 'function' ||
      typeof provider.extractObservationsFromFrames !== 'function'
    ) {
      return false;
    }
    if (
      (err instanceof Error && err.message === '__JOB_CANCELLED__') ||
      isCancelled() ||
      isMediaPathError(err) ||
      isAiResponseValidationError(err)
    ) {
      return false;
    }
    const code: GeminiErrorCode = isGeminiStageError(err)
      ? err.geminiErrorCode
      : classifyGeminiError(err, { stage: currentStageName, modelId: currentModelInUse }).code;
    return FRAME_FALLBACK_ELIGIBLE_CODES.has(code);
  };

  try {
    const session = getMatchSessionById(sessionId);
    if (!session) {
      throw new Error('Recording session was deleted before analysis started.');
    }

    const validSegments = session.segments.filter(
      (s) => ['finalized', 'recovered'].includes(s.status) && s.sizeBytes > 0 && s.durationSeconds > 0
    );

    // Stage: validating_recording + preprocessing
    currentStageName = 'validating_recording';
    updateJobProgress(db, jobId, {
      status: 'validating_recording',
      currentStage: 'validating_recording',
      analysisStrategy: activeStrategy,
      startedAt: startedAtIso,
      lastHeartbeatAt: startedAtIso,
      stageStartedAt: startedAtIso,
      currentSegmentIndex: 1,
      progressDetail: {
        segmentsTotal: validSegments.length,
        segmentsProcessed: 0,
        currentSegmentIndex: 1,
        stageLabel: 'Validating local MP4 segment integrity with FFprobe',
      },
    });

    const preparedAssets: PreparedSegmentAsset[] = [];
    const segmentDurationById = new Map<string, number>();
    let runningOffsetSeconds = 0;

    for (let i = 0; i < validSegments.length; i++) {
      checkCancelledOrThrow();
      const seg = validSegments[i];
      currentSegmentNumber = seg.segmentIndex;
      const vStart = Date.now();
      const resolvedMedia = resolveRecordingSegmentMediaPath({
        matchId,
        expectedHalf: half,
        session,
        segment: seg,
        extraAllowedDirs: params.allowedMediaDirs,
      });

      const probe = await validateVideoFile(resolvedMedia.resolvedPath, params.allowedMediaDirs);
      timing.validationMs += Date.now() - vStart;

      if (!probe.valid) {
        throw new MediaPathError(
          'MEDIA_INTEGRITY_FAILED',
          `Segment #${seg.segmentIndex} failed FFprobe integrity validation: ${probe.error ?? 'corrupted file'}`,
          { matchId, sessionId, segmentId: seg.id, segmentIndex: seg.segmentIndex }
        );
      }

      currentStageName = 'preprocessing';
      updateJobProgress(db, jobId, {
        status: 'preprocessing',
        currentStage: 'preprocessing',
        currentSegmentIndex: i + 1,
        elapsedMs: Date.now() - startedWallMs,
        progressDetail: {
          segmentsTotal: validSegments.length,
          segmentsProcessed: i,
          currentSegmentIndex: i + 1,
          stageLabel: `Preparing segment ${i + 1} of ${validSegments.length} (${params.analysisMode} proxy policy)`,
        },
      });

      const pStart = Date.now();
      const prepared = await prepareAnalysisVideoAsset({
        jobId,
        filePath: resolvedMedia.resolvedPath,
        downscale: proxyEnabled,
        proxyEnabled,
        analysisMode: params.analysisMode,
        proxyAudioInBalanced: Boolean(settings.ai.proxyAudioInBalanced),
        proxyAudioInDeep: Boolean(settings.ai.proxyAudioInDeep),
        abortSignal: jobController.signal,
        allowedBaseDirs: params.allowedMediaDirs,
      });
      const prepMs = Date.now() - pStart;
      timing.preprocessingMs += prepMs;
      originalBytesTotal += prepared.originalSizeBytes;
      processedBytesTotal += prepared.processedSizeBytes;
      if (prepared.proxyApplied) proxyAppliedCount += 1;

      const assetId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO ai_analysis_assets (
          id, job_id, match_id, session_id, segment_id, local_file_path, prepared_file_path,
          is_temp_asset, sha256_hash, file_size_bytes, original_size_bytes, processed_size_bytes,
          preprocessing_ms, duration_seconds, width, height, cleanup_status, cleanup_attempts,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_uploaded', 0, ?, ?)
      `).run(
        assetId,
        jobId,
        matchId,
        sessionId,
        seg.id,
        prepared.localFilePath,
        prepared.preparedFilePath,
        prepared.isTempAsset ? 1 : 0,
        prepared.metadata.sha256Hash,
        prepared.metadata.sizeBytes,
        prepared.originalSizeBytes,
        prepared.processedSizeBytes,
        prepMs,
        prepared.metadata.durationSeconds,
        prepared.metadata.width,
        prepared.metadata.height,
        now,
        now
      );

      segmentDurationById.set(seg.id, prepared.metadata.durationSeconds);
      timing.recordingDurationSeconds += prepared.metadata.durationSeconds;

      preparedAssets.push({
        assetId,
        segmentId: seg.id,
        segmentIndex: seg.segmentIndex,
        sessionOffsetSeconds: runningOffsetSeconds,
        localFilePath: prepared.localFilePath,
        preparedFilePath: prepared.preparedFilePath,
        sha256Hash: seg.checksum || prepared.metadata.sha256Hash,
        durationSeconds: prepared.metadata.durationSeconds,
        sizeBytes: prepared.metadata.sizeBytes,
        originalSizeBytes: prepared.originalSizeBytes,
        processedSizeBytes: prepared.processedSizeBytes,
        proxyApplied: prepared.proxyApplied,
      });
      runningOffsetSeconds += prepared.metadata.durationSeconds;
    }

    const matchContext = buildAiMatchTacticalContext(matchId, db);
    if (!matchContext) {
      throw new Error('Match context unavailable.');
    }

    // Per-segment state
    const allClassifications: AiVideoClassificationRecord[] = [];
    const allObservations: AiGameplayObservationRecord[] = [];
    const mergedHudStats: VideoClassificationOutput['readableHudStats'] = {
      scoreline: null,
      matchClock: null,
      possessionLabel: null,
      shotsLabel: null,
      otherVerifiedStats: [],
    };
    let liveGameplaySeconds = 0;

    const mergeHudStats = (hud: VideoClassificationOutput['readableHudStats']) => {
      if (hud.scoreline) mergedHudStats.scoreline = hud.scoreline;
      if (hud.matchClock) mergedHudStats.matchClock = hud.matchClock;
      if (hud.possessionLabel) mergedHudStats.possessionLabel = hud.possessionLabel;
      if (hud.shotsLabel) mergedHudStats.shotsLabel = hud.shotsLabel;
      for (const st of hud.otherVerifiedStats) {
        if (!mergedHudStats.otherVerifiedStats.some((x) => x.label === st.label)) {
          mergedHudStats.otherVerifiedStats.push(st);
        }
      }
    };

    // Opt-in checkpoint restoration for previously completed segments
    const resumedSegmentIndices = new Set<number>();
    if (params.resumeSummary?.canResume && params.resumeSummary.sourceJobId) {
      const priorCheckpointRows = db
        .prepare(
          `SELECT * FROM ai_analysis_checkpoints
           WHERE job_id = ? AND status = 'valid'
           ORDER BY segment_index ASC, created_at ASC`
        )
        .all(params.resumeSummary.sourceJobId) as Array<Record<string, unknown>>;

      const priorClassBySeg = new Map<number, Record<string, unknown>>();
      const priorObsBySeg = new Map<number, Record<string, unknown>>();
      for (const row of priorCheckpointRows) {
        const sIdx = Number(row.segment_index ?? 0);
        if (String(row.stage_name) === 'classifying_gameplay') priorClassBySeg.set(sIdx, row);
        if (String(row.stage_name) === 'analyzing_gameplay') priorObsBySeg.set(sIdx, row);
      }

      const insertClassStmt = db.prepare(`
        INSERT INTO ai_video_classifications (
          id, job_id, match_id, segment_id, start_seconds, end_seconds,
          session_start_seconds, session_end_seconds, content_type, confidence,
          evidence_description, in_game_clock, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertObsStmt = db.prepare(`
        INSERT INTO ai_gameplay_observations (
          id, job_id, match_id, half, segment_id, start_seconds, end_seconds,
          session_start_seconds, session_end_seconds, in_game_clock,
          category_group, category, team_attribution, player_attribution,
          description, supporting_visual_evidence, evidence_type, confidence,
          severity, limitations, evidence_frame_path, is_from_replay, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const asset of preparedAssets) {
        const classCp = priorClassBySeg.get(asset.segmentIndex);
        if (!classCp) continue;
        const cpChecksum = String(classCp.segment_checksum ?? '');
        if (cpChecksum && cpChecksum !== asset.sha256Hash) continue;

        const classPayload = safeJsonParse<ClassificationCheckpointPayload | null>(
          String(classCp.payload_json ?? ''),
          null
        );
        if (!classPayload || !Array.isArray(classPayload.classifications)) continue;

        const hasLive = classPayload.liveWindows.length > 0;
        const obsCp = priorObsBySeg.get(asset.segmentIndex);
        if (hasLive && !obsCp) continue;

        const obsPayload = obsCp
          ? safeJsonParse<ObservationCheckpointPayload | null>(String(obsCp.payload_json ?? ''), null)
          : null;
        if (hasLive && (!obsPayload || !Array.isArray(obsPayload.observations))) continue;

        const restoredClassRows: AiVideoClassificationRecord[] = [];
        const restoredObsRows: AiGameplayObservationRecord[] = [];
        const restoredAt = new Date().toISOString();

        const restoreTx = db.transaction(() => {
          for (const c of classPayload.classifications) {
            const cid = crypto.randomUUID();
            insertClassStmt.run(
              cid,
              jobId,
              matchId,
              asset.segmentId,
              c.startSeconds,
              c.endSeconds,
              asset.sessionOffsetSeconds + c.startSeconds,
              asset.sessionOffsetSeconds + c.endSeconds,
              c.contentType,
              c.confidence,
              c.evidenceDescription,
              c.inGameClock ?? null,
              restoredAt
            );
            restoredClassRows.push({
              id: cid,
              jobId,
              matchId,
              segmentId: asset.segmentId,
              startSeconds: c.startSeconds,
              endSeconds: c.endSeconds,
              sessionStartSeconds: asset.sessionOffsetSeconds + c.startSeconds,
              sessionEndSeconds: asset.sessionOffsetSeconds + c.endSeconds,
              contentType: c.contentType,
              confidence: c.confidence,
              evidenceDescription: c.evidenceDescription,
              inGameClock: c.inGameClock ?? null,
              createdAt: restoredAt,
            });
          }

          upsertStageCheckpoint(db, {
            jobId,
            matchId,
            sessionId,
            half,
            stageName: 'classifying_gameplay',
            segmentId: asset.segmentId,
            segmentIndex: asset.segmentIndex,
            segmentChecksum: asset.sha256Hash,
            proxySignature,
            modelUsed: String(classCp.model_used ?? params.modelVideoId),
            analysisStrategy: (String(classCp.analysis_strategy ?? activeStrategy) as AnalysisStrategy),
            payload: classPayload,
          });

          if (obsPayload && obsCp) {
            for (const o of obsPayload.observations) {
              const oid = crypto.randomUUID();
              insertObsStmt.run(
                oid,
                jobId,
                matchId,
                half,
                asset.segmentId,
                o.startSeconds,
                o.endSeconds,
                asset.sessionOffsetSeconds + o.startSeconds,
                asset.sessionOffsetSeconds + o.endSeconds,
                o.inGameClock ?? null,
                o.categoryGroup,
                o.category,
                o.teamAttribution,
                o.playerAttribution,
                o.description,
                o.supportingVisualEvidence,
                o.evidenceType,
                o.confidence,
                o.severity,
                o.limitations ?? '',
                o.evidenceFramePath ?? null,
                o.isFromReplay ? 1 : 0,
                restoredAt
              );
              restoredObsRows.push({
                id: oid,
                jobId,
                matchId,
                half,
                segmentId: asset.segmentId,
                startSeconds: o.startSeconds,
                endSeconds: o.endSeconds,
                sessionStartSeconds: asset.sessionOffsetSeconds + o.startSeconds,
                sessionEndSeconds: asset.sessionOffsetSeconds + o.endSeconds,
                inGameClock: o.inGameClock ?? null,
                categoryGroup: o.categoryGroup,
                category: o.category,
                teamAttribution: o.teamAttribution,
                playerAttribution: o.playerAttribution,
                description: o.description,
                supportingVisualEvidence: o.supportingVisualEvidence,
                evidenceType: o.evidenceType,
                confidence: o.confidence,
                severity: o.severity,
                limitations: o.limitations ?? '',
                evidenceFramePath: o.evidenceFramePath ?? null,
                isFromReplay: Boolean(o.isFromReplay),
                createdAt: restoredAt,
              });
            }

            upsertStageCheckpoint(db, {
              jobId,
              matchId,
              sessionId,
              half,
              stageName: 'analyzing_gameplay',
              segmentId: asset.segmentId,
              segmentIndex: asset.segmentIndex,
              segmentChecksum: asset.sha256Hash,
              proxySignature,
              modelUsed: String(obsCp.model_used ?? params.modelVideoId),
              analysisStrategy: (String(obsCp.analysis_strategy ?? activeStrategy) as AnalysisStrategy),
              payload: obsPayload,
            });
          }
        });
        restoreTx();

        allClassifications.push(...restoredClassRows);
        allObservations.push(...restoredObsRows);
        mergeHudStats(classPayload.readableHudStats);
        for (const lw of classPayload.liveWindows) {
          liveGameplaySeconds += Math.max(0, lw.endSeconds - lw.startSeconds);
        }
        stageModelsUsed[`segment_${asset.segmentIndex}_classification`] = `${String(classCp.model_used ?? params.modelVideoId)} (resumed)`;
        if (obsCp) {
          stageModelsUsed[`segment_${asset.segmentIndex}_observations`] = `${String(obsCp.model_used ?? params.modelVideoId)} (resumed)`;
        }
        resumedSegmentIndices.add(asset.segmentIndex);
      }
    }

    const persistValidatedClassificationsAndCheckpoint = (
      asset: PreparedSegmentAsset,
      validatedClass: ReturnType<typeof validateClassificationStageResponse> extends StageValidationResult<infer U>
        ? U
        : never,
      modelUsed: string,
      strategyUsed: AnalysisStrategy,
      remoteFile?: { name: string; uri: string } | null
    ): {
      liveWindows: Array<{ startSeconds: number; endSeconds: number }>;
      replayWindows: Array<{ startSeconds: number; endSeconds: number }>;
    } => {
      mergeHudStats(validatedClass.readableHudStats);

      const liveWindows: Array<{ startSeconds: number; endSeconds: number }> = [];
      const replayWindows: Array<{ startSeconds: number; endSeconds: number }> = [];
      const newRows: AiVideoClassificationRecord[] = [];
      const checkpointItems: ClassificationCheckpointPayload['classifications'] = [];
      let segLiveSeconds = 0;

      const insertClassStmt = db.prepare(`
        INSERT INTO ai_video_classifications (
          id, job_id, match_id, segment_id, start_seconds, end_seconds,
          session_start_seconds, session_end_seconds, content_type, confidence,
          evidence_description, in_game_clock, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const stage1Tx = db.transaction(() => {
        for (const segWin of validatedClass.segments) {
          const s0 = segWin.startSeconds;
          const s1 = segWin.endSeconds;
          const cid = crypto.randomUUID();
          const createdAt = new Date().toISOString();

          insertClassStmt.run(
            cid,
            jobId,
            matchId,
            asset.segmentId,
            s0,
            s1,
            asset.sessionOffsetSeconds + s0,
            asset.sessionOffsetSeconds + s1,
            segWin.contentType,
            segWin.confidence,
            segWin.evidenceDescription,
            segWin.inGameClock ?? null,
            createdAt
          );

          newRows.push({
            id: cid,
            jobId,
            matchId,
            segmentId: asset.segmentId,
            startSeconds: s0,
            endSeconds: s1,
            sessionStartSeconds: asset.sessionOffsetSeconds + s0,
            sessionEndSeconds: asset.sessionOffsetSeconds + s1,
            contentType: segWin.contentType,
            confidence: segWin.confidence,
            evidenceDescription: segWin.evidenceDescription,
            inGameClock: segWin.inGameClock ?? null,
            createdAt,
          });
          checkpointItems.push({
            startSeconds: s0,
            endSeconds: s1,
            contentType: segWin.contentType,
            confidence: segWin.confidence,
            evidenceDescription: segWin.evidenceDescription,
            inGameClock: segWin.inGameClock ?? null,
          });

          if (segWin.contentType === 'live_gameplay' || segWin.contentType === 'set_piece') {
            segLiveSeconds += Math.max(0, s1 - s0);
            liveWindows.push({ startSeconds: s0, endSeconds: s1 });
          } else if (segWin.contentType === 'replay') {
            replayWindows.push({ startSeconds: s0, endSeconds: s1 });
          }
        }

        const cpPayload: ClassificationCheckpointPayload = {
          classifications: checkpointItems,
          readableHudStats: validatedClass.readableHudStats,
          liveWindows,
          replayWindows,
        };
        upsertStageCheckpoint(db, {
          jobId,
          matchId,
          sessionId,
          half,
          stageName: 'classifying_gameplay',
          segmentId: asset.segmentId,
          segmentIndex: asset.segmentIndex,
          segmentChecksum: asset.sha256Hash,
          proxySignature,
          modelUsed,
          analysisStrategy: strategyUsed,
          remoteFileName: remoteFile?.name ?? null,
          remoteFileUri: remoteFile?.uri ?? null,
          payload: cpPayload,
        });
      });

      stage1Tx();
      allClassifications.push(...newRows);
      liveGameplaySeconds += segLiveSeconds;
      return { liveWindows, replayWindows };
    };

    const persistValidatedObservationsAndCheckpoint = async (
      asset: PreparedSegmentAsset,
      validatedObs: ReturnType<typeof validateObservationStageResponse> extends StageValidationResult<infer U>
        ? U
        : never,
      replayWindows: Array<{ startSeconds: number; endSeconds: number }>,
      modelUsed: string,
      strategyUsed: AnalysisStrategy,
      remoteFile?: { name: string; uri: string } | null
    ): Promise<void> => {
      const maxFrames = Math.min(12, settings.ai.maxEvidenceFrames ?? 12);
      let framesExtracted = 0;

      // Prepare observation records & extract evidence frames OUTSIDE the SQLite transaction
      const preparedObsRows: Array<{
        oid: string;
        clampedStart: number;
        clampedEnd: number;
        inGameClock: string | null;
        categoryGroup: AiGameplayObservationRecord['categoryGroup'];
        category: string;
        teamAttribution: AiGameplayObservationRecord['teamAttribution'];
        cleanPlayerAttr: string;
        description: string;
        supportingVisualEvidence: string;
        evidenceType: AiGameplayObservationRecord['evidenceType'];
        confidence: AiGameplayObservationRecord['confidence'];
        severity: AiGameplayObservationRecord['severity'];
        limitations: string;
        frameFileName: string | null;
        overlapsReplay: boolean;
        createdAt: string;
      }> = [];

      for (const rawObs of validatedObs.observations) {
        const clampedStart = rawObs.startSeconds;
        const clampedEnd = rawObs.endSeconds;

        // Replay deduplication: detect overlap with classified replay window
        const overlapsReplay =
          Boolean(rawObs.isFromReplay) ||
          replayWindows.some((rw) => clampedStart >= rw.startSeconds && clampedEnd <= rw.endSeconds);

        // Skip duplicate replay match_events so replay footage never doubles event counts
        if (overlapsReplay && rawObs.categoryGroup === 'match_events') {
          continue;
        }

        let frameFileName: string | null = null;
        if (!overlapsReplay && framesExtracted < maxFrames) {
          frameFileName = await extractEvidenceFrame({
            matchId,
            half,
            videoFilePath: asset.localFilePath,
            timestampSeconds: clampedStart,
            labelSlug: `${jobId.slice(0, 6)}_s${asset.segmentIndex}_${framesExtracted}`,
            allowedBaseDirs: params.allowedMediaDirs,
          });
          if (frameFileName) framesExtracted += 1;
        }

        preparedObsRows.push({
          oid: crypto.randomUUID(),
          clampedStart,
          clampedEnd,
          inGameClock: rawObs.inGameClock ?? null,
          categoryGroup: rawObs.categoryGroup,
          category: rawObs.category,
          teamAttribution: rawObs.teamAttribution,
          cleanPlayerAttr: rawObs.playerAttribution?.trim() || 'Unknown',
          description: rawObs.description,
          supportingVisualEvidence: rawObs.supportingVisualEvidence,
          evidenceType: rawObs.evidenceType,
          confidence: rawObs.confidence,
          severity: rawObs.severity,
          limitations: rawObs.limitations ?? '',
          frameFileName,
          overlapsReplay,
          createdAt: new Date().toISOString(),
        });
      }

      const insertObsStmt = db.prepare(`
        INSERT INTO ai_gameplay_observations (
          id, job_id, match_id, half, segment_id, start_seconds, end_seconds,
          session_start_seconds, session_end_seconds, in_game_clock,
          category_group, category, team_attribution, player_attribution,
          description, supporting_visual_evidence, evidence_type, confidence,
          severity, limitations, evidence_frame_path, is_from_replay, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const stage2Tx = db.transaction(() => {
        for (const row of preparedObsRows) {
          insertObsStmt.run(
            row.oid,
            jobId,
            matchId,
            half,
            asset.segmentId,
            row.clampedStart,
            row.clampedEnd,
            asset.sessionOffsetSeconds + row.clampedStart,
            asset.sessionOffsetSeconds + row.clampedEnd,
            row.inGameClock,
            row.categoryGroup,
            row.category,
            row.teamAttribution,
            row.cleanPlayerAttr,
            row.description,
            row.supportingVisualEvidence,
            row.evidenceType,
            row.confidence,
            row.severity,
            row.limitations,
            row.frameFileName,
            row.overlapsReplay ? 1 : 0,
            row.createdAt
          );
        }

        const cpPayload: ObservationCheckpointPayload = {
          observations: preparedObsRows.map((row) => ({
            startSeconds: row.clampedStart,
            endSeconds: row.clampedEnd,
            inGameClock: row.inGameClock,
            categoryGroup: row.categoryGroup,
            category: row.category,
            teamAttribution: row.teamAttribution,
            playerAttribution: row.cleanPlayerAttr,
            description: row.description,
            supportingVisualEvidence: row.supportingVisualEvidence,
            evidenceType: row.evidenceType,
            confidence: row.confidence,
            severity: row.severity,
            limitations: row.limitations,
            evidenceFramePath: row.frameFileName,
            isFromReplay: row.overlapsReplay,
          })),
        };
        upsertStageCheckpoint(db, {
          jobId,
          matchId,
          sessionId,
          half,
          stageName: 'analyzing_gameplay',
          segmentId: asset.segmentId,
          segmentIndex: asset.segmentIndex,
          segmentChecksum: asset.sha256Hash,
          proxySignature,
          modelUsed,
          analysisStrategy: strategyUsed,
          remoteFileName: remoteFile?.name ?? null,
          remoteFileUri: remoteFile?.uri ?? null,
          payload: cpPayload,
        });
      });

      stage2Tx();

      for (const row of preparedObsRows) {
        allObservations.push({
          id: row.oid,
          jobId,
          matchId,
          half,
          segmentId: asset.segmentId,
          startSeconds: row.clampedStart,
          endSeconds: row.clampedEnd,
          sessionStartSeconds: asset.sessionOffsetSeconds + row.clampedStart,
          sessionEndSeconds: asset.sessionOffsetSeconds + row.clampedEnd,
          inGameClock: row.inGameClock,
          categoryGroup: row.categoryGroup,
          category: row.category,
          teamAttribution: row.teamAttribution,
          playerAttribution: row.cleanPlayerAttr,
          description: row.description,
          supportingVisualEvidence: row.supportingVisualEvidence,
          evidenceType: row.evidenceType,
          confidence: row.confidence,
          severity: row.severity,
          limitations: row.limitations,
          evidenceFramePath: row.frameFileName,
          isFromReplay: row.overlapsReplay,
          createdAt: row.createdAt,
        });
      }
    };

    const runSegmentViaSequentialFrames = async (
      asset: PreparedSegmentAsset,
      segArrayIdx: number,
      triggerReason?: string
    ): Promise<void> => {
      activeStrategy = 'sequential_frames';
      currentStageName = 'classifying_gameplay';
      updateJobProgress(db, jobId, {
        status: 'classifying_gameplay',
        currentStage: 'classifying_gameplay',
        analysisStrategy: 'sequential_frames',
        currentSegmentIndex: segArrayIdx + 1,
        elapsedMs: Date.now() - startedWallMs,
        progressDetail: {
          segmentsTotal: preparedAssets.length,
          segmentsProcessed: segArrayIdx,
          currentSegmentIndex: segArrayIdx + 1,
          stageLabel: triggerReason
            ? `Sequential Frame Fallback (${triggerReason}): extracting local keyframes for segment ${segArrayIdx + 1}/${preparedAssets.length}`
            : `Extracting local sequential keyframes (segment ${segArrayIdx + 1}/${preparedAssets.length})`,
          proxyAppliedCount,
          originalBytesTotal,
          processedBytesTotal,
        },
      });

      const { frames } = await extractSequentialFallbackFrames({
        jobId,
        videoFilePath: asset.localFilePath,
        segmentIndex: asset.segmentIndex,
        durationSeconds: asset.durationSeconds,
        intervalSeconds: settings.ai.frameFallbackIntervalSeconds ?? 8,
        maxFrames: settings.ai.maxFallbackFramesPerSegment ?? 18,
        allowedBaseDirs: params.allowedMediaDirs,
      });

      if (frames.length === 0) {
        throw new Error(
          `Sequential Frame Fallback could not extract any JPEG keyframes from segment #${asset.segmentIndex}.`
        );
      }

      const { result: frameClassRes, modelUsed: classModelUsed } = await runStageWithModelFailover({
        stageKey: `segment_${asset.segmentIndex}_classification`,
        stageLabel: `frame classification (segment ${segArrayIdx + 1})`,
        capability: 'image',
        initialModelId: params.modelVideoId,
        reusedRemoteMedia: false,
        segmentIndex: segArrayIdx + 1,
        invoke: (mId) =>
          provider.classifySequentialFrames!({
            modelId: mId,
            frames: frames.map((f) => ({
              timestampSeconds: f.timestampSeconds,
              filePath: f.filePath,
              mimeType: f.mimeType,
            })),
            segmentDurationSeconds: asset.durationSeconds,
            half,
            maxRetries,
            segmentIndex: segArrayIdx + 1,
            inferenceTimeoutMs,
            abortSignal: jobController.signal,
          }),
      });

      timing.classificationMs += frameClassRes.usage.durationMs;
      cumulativeCostUsd += frameClassRes.usage.estimatedCostUsd;

      insertApiUsageLog({
        matchId,
        analysisJobId: jobId,
        modelId: frameClassRes.usage.modelId,
        stage: 'stage1_classify_sequential_frames',
        inputTokens: frameClassRes.usage.inputTokens,
        outputTokens: frameClassRes.usage.outputTokens,
        evidenceFramesCount: frames.length,
        videoDurationSeconds: asset.durationSeconds,
        requestDurationMs: frameClassRes.usage.durationMs,
        estimatedCostUsd: frameClassRes.usage.estimatedCostUsd,
        pricingSource: 'local_registry_indicative_estimate',
        isEstimate: true,
        status: 'success',
      });

      const validatedClass = await validateAndRepairStageOutput({
        stageName: 'stage1_classify_gameplay',
        modelId: classModelUsed,
        raw: frameClassRes,
        validator: (raw) =>
          validateClassificationStageResponse(raw, {
            segmentIndex: asset.segmentIndex,
            segmentDurationSeconds: asset.durationSeconds,
          }),
        canonicalSchema: buildStage1ClassificationSchema(),
      });

      const { liveWindows, replayWindows } = persistValidatedClassificationsAndCheckpoint(
        asset,
        validatedClass,
        classModelUsed,
        'sequential_frames',
        null
      );

      if (liveWindows.length > 0) {
        checkCancelledOrThrow();
        currentStageName = 'analyzing_gameplay';
        updateJobProgress(db, jobId, {
          status: 'analyzing_gameplay',
          currentStage: 'analyzing_gameplay',
          analysisStrategy: 'sequential_frames',
          currentSegmentIndex: segArrayIdx + 1,
          elapsedMs: Date.now() - startedWallMs,
          progressDetail: {
            segmentsTotal: preparedAssets.length,
            segmentsProcessed: segArrayIdx,
            currentSegmentIndex: segArrayIdx + 1,
            stageLabel: `Extracting tactical observations from ${frames.length} keyframes (segment ${segArrayIdx + 1}/${preparedAssets.length})`,
            proxyAppliedCount,
            originalBytesTotal,
            processedBytesTotal,
          },
        });

        const { result: frameObsRes, modelUsed: obsModelUsed } = await runStageWithModelFailover({
          stageKey: `segment_${asset.segmentIndex}_observations`,
          stageLabel: `frame observations (segment ${segArrayIdx + 1})`,
          capability: 'image',
          initialModelId: classModelUsed,
          reusedRemoteMedia: false,
          segmentIndex: segArrayIdx + 1,
          invoke: (mId) =>
            provider.extractObservationsFromFrames!({
              modelId: mId,
              frames: frames.map((f) => ({
                timestampSeconds: f.timestampSeconds,
                filePath: f.filePath,
                mimeType: f.mimeType,
              })),
              segmentDurationSeconds: asset.durationSeconds,
              analysisMode: params.analysisMode,
              half,
              clubName: matchContext.clubName,
              opponentName: matchContext.opponentName,
              language: params.language,
              liveWindows,
              maxRetries,
              segmentIndex: segArrayIdx + 1,
              inferenceTimeoutMs,
              abortSignal: jobController.signal,
            }),
        });

        timing.observationAnalysisMs += frameObsRes.usage.durationMs;
        cumulativeCostUsd += frameObsRes.usage.estimatedCostUsd;

        insertApiUsageLog({
          matchId,
          analysisJobId: jobId,
          modelId: frameObsRes.usage.modelId,
          stage: 'stage2_extract_observations_frames',
          inputTokens: frameObsRes.usage.inputTokens,
          outputTokens: frameObsRes.usage.outputTokens,
          evidenceFramesCount: frames.length,
          videoDurationSeconds: asset.durationSeconds,
          requestDurationMs: frameObsRes.usage.durationMs,
          estimatedCostUsd: frameObsRes.usage.estimatedCostUsd,
          pricingSource: 'local_registry_indicative_estimate',
          isEstimate: true,
          status: 'success',
        });

        const validatedObs = await validateAndRepairStageOutput({
          stageName: 'stage2_extract_observations',
          modelId: obsModelUsed,
          raw: frameObsRes,
          validator: (raw) =>
            validateObservationStageResponse(raw, {
              segmentIndex: asset.segmentIndex,
              segmentDurationSeconds: asset.durationSeconds,
            }),
          canonicalSchema: buildStage2ObservationSchema(),
        });

        await persistValidatedObservationsAndCheckpoint(
          asset,
          validatedObs,
          replayWindows,
          obsModelUsed,
          'sequential_frames',
          null
        );
      }
    };

    // Per-segment Upload -> Classify -> Extract Observations (with checkpoint skip, adaptive failover, and sequential frame fallback)
    for (let i = 0; i < preparedAssets.length; i++) {
      checkCancelledOrThrow();
      const asset = preparedAssets[i];
      currentSegmentNumber = i + 1;
      currentModelInUse = params.modelVideoId;

      if (resumedSegmentIndices.has(asset.segmentIndex)) {
        updateJobProgress(db, jobId, {
          segmentsProcessed: i + 1,
          currentSegmentIndex: i + 1,
          elapsedMs: Date.now() - startedWallMs,
          progressDetail: {
            segmentsTotal: preparedAssets.length,
            segmentsProcessed: i + 1,
            currentSegmentIndex: i + 1,
            stageLabel: `Restored segment ${i + 1} of ${preparedAssets.length} from verified checkpoint`,
            proxyAppliedCount,
            originalBytesTotal,
            processedBytesTotal,
          },
        });
        continue;
      }

      if (activeStrategy === 'sequential_frames') {
        await runSegmentViaSequentialFrames(asset, i);
        updateJobProgress(db, jobId, {
          segmentsProcessed: i + 1,
          actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
          analysisStrategy: activeStrategy,
          stageModelsUsed,
          fallbackHistory,
          validationSummary,
        });
        continue;
      }

      try {
        currentStageName = 'uploading';
        updateJobProgress(db, jobId, {
          status: 'uploading',
          currentStage: 'uploading',
          segmentsProcessed: i,
          currentSegmentIndex: i + 1,
          retryAttempt: 0,
          elapsedMs: Date.now() - startedWallMs,
          progressDetail: {
            segmentsTotal: preparedAssets.length,
            segmentsProcessed: i,
            currentSegmentIndex: i + 1,
            stageLabel: `Uploading segment ${i + 1} of ${preparedAssets.length} to Gemini Files API (${(
              asset.sizeBytes /
              (1024 * 1024)
            ).toFixed(2)} MB)`,
            uploadBytesTotal: asset.sizeBytes,
            uploadIndeterminate: true,
            proxyAppliedCount,
            originalBytesTotal,
            processedBytesTotal,
          },
        });

        const uploaded = await provider.uploadAndAwaitActive({
          filePath: asset.preparedFilePath,
          mimeType: 'video/mp4',
          displayName: `fc26_${matchId.slice(0, 8)}_${half}_seg${asset.segmentIndex}.mp4`,
          isCancelled,
          abortSignal: jobController.signal,
          segmentIndex: i + 1,
          uploadTimeoutMs,
          processingTimeoutMs,
          maxWaitMs: processingTimeoutMs,
          onRemoteFileUploaded: ({ remoteFileName, remoteFileUri, remoteState }) => {
            // Immediately persist remote_file_name BEFORE processing poll so cleanup is guaranteed even on failure/timeout/cancel!
            uploadedAssetsMap.set(asset.assetId, remoteFileName);
            db.prepare(`
              UPDATE ai_analysis_assets
              SET remote_file_name = ?, remote_file_uri = ?, remote_state = ?, cleanup_status = 'uploaded', updated_at = ?
              WHERE id = ?
            `).run(
              remoteFileName,
              remoteFileUri,
              remoteState ?? 'PROCESSING',
              new Date().toISOString(),
              asset.assetId
            );
          },
          onWaitingForProcessing: () => {
            currentStageName = 'waiting_for_media_processing';
            updateJobProgress(db, jobId, {
              status: 'waiting_for_media_processing',
              currentStage: 'waiting_for_media_processing',
              currentSegmentIndex: i + 1,
              elapsedMs: Date.now() - startedWallMs,
              progressDetail: {
                segmentsTotal: preparedAssets.length,
                segmentsProcessed: i,
                currentSegmentIndex: i + 1,
                stageLabel: `Waiting for Gemini media processing (segment ${i + 1}/${preparedAssets.length})`,
                uploadIndeterminate: true,
                proxyAppliedCount,
                originalBytesTotal,
                processedBytesTotal,
              },
            });
          },
        });

        timing.uploadMs += uploaded.uploadMs;
        timing.mediaProcessingMs += uploaded.mediaProcessingMs;
        uploadedAssetsMap.set(asset.assetId, uploaded.remoteFileName);

        db.prepare(`
          UPDATE ai_analysis_assets
          SET remote_file_name = ?, remote_file_uri = ?, remote_state = ?, cleanup_status = 'uploaded', updated_at = ?
          WHERE id = ?
        `).run(
          uploaded.remoteFileName,
          uploaded.remoteFileUri,
          uploaded.remoteState,
          new Date().toISOString(),
          asset.assetId
        );

        checkCancelledOrThrow();

        // Stage 1: Gameplay Content Classification (with adaptive failover reusing remoteFileUri + runtime validation)
        currentStageName = 'classifying_gameplay';
        updateJobProgress(db, jobId, {
          status: 'classifying_gameplay',
          currentStage: 'classifying_gameplay',
          currentSegmentIndex: i + 1,
          retryAttempt: 0,
          elapsedMs: Date.now() - startedWallMs,
          progressDetail: {
            segmentsTotal: preparedAssets.length,
            segmentsProcessed: i,
            currentSegmentIndex: i + 1,
            stageLabel: `Classifying gameplay vs menus/replays (segment ${i + 1}/${preparedAssets.length})`,
            proxyAppliedCount,
            originalBytesTotal,
            processedBytesTotal,
          },
        });

        const { result: classRes, modelUsed: stage1ModelUsed } = await runStageWithModelFailover({
          stageKey: `segment_${asset.segmentIndex}_classification`,
          stageLabel: `gameplay classification (segment ${i + 1})`,
          capability: 'video',
          initialModelId: params.modelVideoId,
          reusedRemoteMedia: true,
          segmentIndex: i + 1,
          invoke: (mId) =>
            provider.classifyVideoSegment({
              modelId: mId,
              remoteFileUri: uploaded.remoteFileUri,
              mimeType: 'video/mp4',
              segmentDurationSeconds: asset.durationSeconds,
              samplingFps: params.samplingFps,
              half,
              maxRetries,
              segmentIndex: i + 1,
              inferenceTimeoutMs,
              abortSignal: jobController.signal,
              onRetryAttempt: ({ attemptNumber, errorCode }) => {
                totalRetryCount += 1;
                updateJobProgress(db, jobId, {
                  retryCount: totalRetryCount,
                  retryAttempt: attemptNumber,
                  elapsedMs: Date.now() - startedWallMs,
                  progressDetail: {
                    segmentsTotal: preparedAssets.length,
                    segmentsProcessed: i,
                    currentSegmentIndex: i + 1,
                    retryAttempt: attemptNumber,
                    maxRetries,
                    stageLabel: `Retrying gameplay classification (segment ${i + 1}/${preparedAssets.length}, attempt ${attemptNumber + 1} after ${errorCode})`,
                    proxyAppliedCount,
                    originalBytesTotal,
                    processedBytesTotal,
                  },
                });
              },
            }),
        });

        timing.classificationMs += classRes.usage.durationMs;
        cumulativeCostUsd += classRes.usage.estimatedCostUsd;

        insertApiUsageLog({
          matchId,
          analysisJobId: jobId,
          modelId: classRes.usage.modelId,
          stage: 'stage1_classify_gameplay',
          inputTokens: classRes.usage.inputTokens,
          outputTokens: classRes.usage.outputTokens,
          fileSizeBytes: asset.sizeBytes,
          videoDurationSeconds: asset.durationSeconds,
          requestDurationMs: classRes.usage.durationMs,
          estimatedCostUsd: classRes.usage.estimatedCostUsd,
          pricingSource: 'local_registry_indicative_estimate',
          isEstimate: true,
          status: 'success',
        });

        const validatedClass = await validateAndRepairStageOutput({
          stageName: 'stage1_classify_gameplay',
          modelId: stage1ModelUsed,
          raw: classRes,
          validator: (raw) =>
            validateClassificationStageResponse(raw, {
              segmentIndex: asset.segmentIndex,
              segmentDurationSeconds: asset.durationSeconds,
            }),
          canonicalSchema: buildStage1ClassificationSchema(),
        });

        const { liveWindows, replayWindows } = persistValidatedClassificationsAndCheckpoint(
          asset,
          validatedClass,
          stage1ModelUsed,
          'native_video',
          { name: uploaded.remoteFileName, uri: uploaded.remoteFileUri }
        );

        // Stage 2: Extract Gameplay Observations ONLY if this segment has live gameplay / set pieces
        if (liveWindows.length > 0) {
          checkCancelledOrThrow();
          currentStageName = 'analyzing_gameplay';
          updateJobProgress(db, jobId, {
            status: 'analyzing_gameplay',
            currentStage: 'analyzing_gameplay',
            currentSegmentIndex: i + 1,
            retryAttempt: 0,
            elapsedMs: Date.now() - startedWallMs,
            progressDetail: {
              segmentsTotal: preparedAssets.length,
              segmentsProcessed: i,
              currentSegmentIndex: i + 1,
              stageLabel: `Extracting tactical observations (segment ${i + 1}/${preparedAssets.length})`,
              proxyAppliedCount,
              originalBytesTotal,
              processedBytesTotal,
            },
          });

          const { result: obsRes, modelUsed: stage2ModelUsed } = await runStageWithModelFailover({
            stageKey: `segment_${asset.segmentIndex}_observations`,
            stageLabel: `observation extraction (segment ${i + 1})`,
            capability: 'video',
            initialModelId: stage1ModelUsed,
            reusedRemoteMedia: true,
            segmentIndex: i + 1,
            invoke: (mId) =>
              provider.extractGameplayObservations({
                modelId: mId,
                remoteFileUri: uploaded.remoteFileUri,
                mimeType: 'video/mp4',
                segmentDurationSeconds: asset.durationSeconds,
                samplingFps: params.samplingFps,
                analysisMode: params.analysisMode,
                half,
                clubName: matchContext.clubName,
                opponentName: matchContext.opponentName,
                language: params.language,
                liveWindows,
                maxRetries,
                segmentIndex: i + 1,
                inferenceTimeoutMs,
                abortSignal: jobController.signal,
                onRetryAttempt: ({ attemptNumber, errorCode }) => {
                  totalRetryCount += 1;
                  updateJobProgress(db, jobId, {
                    retryCount: totalRetryCount,
                    retryAttempt: attemptNumber,
                    elapsedMs: Date.now() - startedWallMs,
                    progressDetail: {
                      segmentsTotal: preparedAssets.length,
                      segmentsProcessed: i,
                      currentSegmentIndex: i + 1,
                      retryAttempt: attemptNumber,
                      maxRetries,
                      stageLabel: `Retrying observation extraction (segment ${i + 1}/${preparedAssets.length}, attempt ${attemptNumber + 1} after ${errorCode})`,
                      proxyAppliedCount,
                      originalBytesTotal,
                      processedBytesTotal,
                    },
                  });
                },
              }),
          });

          timing.observationAnalysisMs += obsRes.usage.durationMs;
          cumulativeCostUsd += obsRes.usage.estimatedCostUsd;

          insertApiUsageLog({
            matchId,
            analysisJobId: jobId,
            modelId: obsRes.usage.modelId,
            stage: 'stage2_extract_observations',
            inputTokens: obsRes.usage.inputTokens,
            outputTokens: obsRes.usage.outputTokens,
            fileSizeBytes: asset.sizeBytes,
            videoDurationSeconds: asset.durationSeconds,
            requestDurationMs: obsRes.usage.durationMs,
            estimatedCostUsd: obsRes.usage.estimatedCostUsd,
            pricingSource: 'local_registry_indicative_estimate',
            isEstimate: true,
            status: 'success',
          });

          const validatedObs = await validateAndRepairStageOutput({
            stageName: 'stage2_extract_observations',
            modelId: stage2ModelUsed,
            raw: obsRes,
            validator: (raw) =>
              validateObservationStageResponse(raw, {
                segmentIndex: asset.segmentIndex,
                segmentDurationSeconds: asset.durationSeconds,
              }),
            canonicalSchema: buildStage2ObservationSchema(),
          });

          await persistValidatedObservationsAndCheckpoint(
            asset,
            validatedObs,
            replayWindows,
            stage2ModelUsed,
            'native_video',
            { name: uploaded.remoteFileName, uri: uploaded.remoteFileUri }
          );
        }
      } catch (segErr) {
        if (canAttemptSequentialFrameFallback(segErr)) {
          const triggerCode: GeminiErrorCode = isGeminiStageError(segErr)
            ? segErr.geminiErrorCode
            : classifyGeminiError(segErr, { stage: currentStageName, modelId: currentModelInUse }).code;
          fallbackHistory.push({
            stage: `segment_${asset.segmentIndex}_strategy_fallback`,
            segmentIndex: i + 1,
            fromModelId: currentModelInUse,
            toModelId: `${params.modelVideoId} (sequential_frames)`,
            reasonCode: triggerCode,
            reasonMessage: `Native video failed (${triggerCode}); switched to opt-in Sequential Keyframe Fallback.`,
            reusedRemoteMedia: false,
            costDeltaAuthorized: true,
            occurredAt: new Date().toISOString(),
          });
          await runSegmentViaSequentialFrames(asset, i, triggerCode);
        } else {
          throw segErr;
        }
      }

      updateJobProgress(db, jobId, {
        segmentsProcessed: i + 1,
        actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
        analysisStrategy: activeStrategy,
        stageModelsUsed,
        fallbackHistory,
        validationSummary,
      });
    }

    const minLiveRequired = settings.ai.minLiveGameplaySeconds ?? 15;
    const coverageSummary = `${preparedAssets.length} segment(s) (${timing.recordingDurationSeconds.toFixed(0)}s total), ${liveGameplaySeconds.toFixed(0)}s live gameplay/set pieces, ${allObservations.length} extracted observation(s).`;

    // Check insufficient_gameplay condition (e.g., menu-only / loading-screen recording)
    if (liveGameplaySeconds < minLiveRequired || allObservations.length === 0) {
      const finishedAt = new Date().toISOString();
      timing.totalElapsedMs = Date.now() - startedWallMs;

      const insufficientBriefing: AiHalftimeBriefingPayload = {
        id: crypto.randomUUID(),
        jobId,
        matchId,
        half,
        language: params.language,
        modelUsed: params.modelVideoId,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        evidenceQuality: 'insufficient',
        managerVerdict: {
          whatIsWorking: [],
          whatIsNotWorking: [],
          whyTacticStruggling:
            params.language === 'id'
              ? 'Rekaman tidak memiliki cukup cuplikan gameplay aktif untuk menghasilkan evaluasi taktis yang jujur.'
              : 'Insufficient live gameplay footage was observed in this recording to produce an evidence-backed tactical evaluation.',
          firstPriorityChange:
            params.language === 'id'
              ? 'Rekam gameplay pertandingan aktif minimal 15 detik sebelum menjalankan analisis babak.'
              : 'Capture active on-pitch match footage (at least 15 seconds of live play) before running half-time analysis.',
          conciseSummary:
            params.language === 'id'
              ? `Hanya terdeteksi ${liveGameplaySeconds.toFixed(0)} detik gameplay aktif dari total ${timing.recordingDurationSeconds.toFixed(0)} detik rekaman. Tidak ada peristiwa atau rekomendasi yang dikarang.`
              : `Only ${liveGameplaySeconds.toFixed(0)}s of live gameplay was detected out of ${timing.recordingDurationSeconds.toFixed(0)}s recorded. No match events or tactical recommendations were fabricated.`,
        },
        readableHudStats: mergedHudStats,
        gameplayCoaching: [],
        contingencyPlan: [],
        limitations: [
          `Detected ${liveGameplaySeconds.toFixed(0)}s of live gameplay/set pieces (minimum threshold: ${minLiveRequired}s).`,
          'Non-gameplay footage (menus, tactical screens, cutscenes, or obscured screen) cannot be used to invent match events.',
        ],
        createdAt: finishedAt,
      };

      db.prepare(`
        INSERT INTO ai_halftime_briefings (
          id, job_id, match_id, half, language, model_used, prompt_version,
          schema_version, briefing_json, evidence_quality, limitations_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'insufficient', ?, ?)
      `).run(
        insufficientBriefing.id,
        jobId,
        matchId,
        half,
        params.language,
        params.modelVideoId,
        PROMPT_VERSION,
        SCHEMA_VERSION,
        JSON.stringify(insufficientBriefing),
        JSON.stringify(insufficientBriefing.limitations),
        finishedAt
      );

      updateJobProgress(db, jobId, {
        status: 'insufficient_gameplay',
        currentStage: 'insufficient_gameplay',
        analysisStrategy: activeStrategy,
        stageModelsUsed,
        fallbackHistory,
        validationSummary,
        coverageSummary,
        actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
        completedAt: finishedAt,
        elapsedMs: timing.totalElapsedMs,
        timingBreakdown: timing,
        progressDetail: {
          segmentsTotal: preparedAssets.length,
          segmentsProcessed: preparedAssets.length,
          stageLabel: 'Stopped: insufficient live gameplay footage',
          note: coverageSummary,
        },
      });
      return;
    }

    // Stage 3: Match Context Fusion + 3-Layer Tactical Vision Evaluation + Synthesis
    checkCancelledOrThrow();
    updateJobProgress(db, jobId, {
      status: 'evaluating_tactics',
      currentStage: 'evaluating_tactics',
      coverageSummary,
      progressDetail: {
        segmentsTotal: preparedAssets.length,
        segmentsProcessed: preparedAssets.length,
        stageLabel: 'Evaluating 3-Layer Tactical Vision alignment and match context',
      },
    });

    const threeLayerEval = evaluateThreeLayerTactics(
      {
        clubId: matchContext.clubId ?? null,
        tacticalVisionKey: matchContext.tacticalVisionKey ?? 'unspecified',
        formationName: matchContext.formation?.name ?? '4-2-3-1 Wide',
        buildUpStyle: matchContext.buildUpStyle ?? 'Balanced',
        defensiveApproach: matchContext.defensiveApproach ?? 'Balanced',
        defensiveLineHeight: matchContext.defensiveLineHeight ?? 55,
        assignments: matchContext.startingXi.map((s) => ({
          slotOrder: s.slotIndex,
          slotId: s.slotId,
          positionCode: s.positionCode,
          playerId: s.playerId ?? null,
          playerDisplayName: s.playerName,
          role: s.assignedRole,
          focus: s.assignedFocus,
        })),
      },
      db
    );

    const matchNotesRow = db
      .prepare('SELECT pre_match_notes FROM matches WHERE id = ?')
      .get(matchId) as { pre_match_notes?: string } | undefined;

    currentStageName = 'generating_briefing';
    currentModelInUse = params.modelSynthesisId;
    currentSegmentNumber = null;
    updateJobProgress(db, jobId, {
      status: 'generating_briefing',
      currentStage: 'generating_briefing',
      retryAttempt: 0,
      elapsedMs: Date.now() - startedWallMs,
      progressDetail: {
        segmentsTotal: preparedAssets.length,
        segmentsProcessed: preparedAssets.length,
        stageLabel: 'Generating structured half-time briefing and tactical recommendations',
        proxyAppliedCount,
        originalBytesTotal,
        processedBytesTotal,
      },
    });

    const { result: synthResRaw, modelUsed: stage3ModelUsed } = await runStageWithModelFailover({
      stageKey: 'stage3_tactical_synthesis',
      stageLabel: 'tactical synthesis',
      capability: 'synthesis',
      initialModelId: params.modelSynthesisId,
      reusedRemoteMedia: false,
      segmentIndex: null,
      invoke: (mId) =>
        provider.synthesizeTacticalBriefing({
          modelId: mId,
          language: params.language,
          half,
          matchContext,
          threeLayerEval,
          observations: allObservations,
          readableHudStats: mergedHudStats,
          coverageSummary,
          userPreMatchNotes: matchNotesRow?.pre_match_notes ?? '',
          maxRetries,
          inferenceTimeoutMs,
          abortSignal: jobController.signal,
          onRetryAttempt: ({ attemptNumber, errorCode }) => {
            totalRetryCount += 1;
            updateJobProgress(db, jobId, {
              retryCount: totalRetryCount,
              retryAttempt: attemptNumber,
              elapsedMs: Date.now() - startedWallMs,
              progressDetail: {
                segmentsTotal: preparedAssets.length,
                segmentsProcessed: preparedAssets.length,
                retryAttempt: attemptNumber,
                maxRetries,
                stageLabel: `Retrying tactical synthesis (attempt ${attemptNumber + 1} after ${errorCode})`,
                proxyAppliedCount,
                originalBytesTotal,
                processedBytesTotal,
              },
            });
          },
        }),
    });

    timing.tacticalSynthesisMs += synthResRaw.usage.durationMs;
    cumulativeCostUsd += synthResRaw.usage.estimatedCostUsd;

    insertApiUsageLog({
      matchId,
      analysisJobId: jobId,
      modelId: synthResRaw.usage.modelId,
      stage: 'stage3_tactical_synthesis',
      inputTokens: synthResRaw.usage.inputTokens,
      outputTokens: synthResRaw.usage.outputTokens,
      evidenceFramesCount: allObservations.filter((o) => Boolean(o.evidenceFramePath)).length,
      requestDurationMs: synthResRaw.usage.durationMs,
      estimatedCostUsd: synthResRaw.usage.estimatedCostUsd,
      pricingSource: 'local_registry_indicative_estimate',
      isEstimate: true,
      status: 'success',
    });

    const synthRes = await validateAndRepairStageOutput({
      stageName: 'stage3_tactical_synthesis',
      modelId: stage3ModelUsed,
      raw: synthResRaw,
      validator: (raw) => validateSynthesisStageResponse(raw),
      canonicalSchema: buildStage3SynthesisSchema(),
    });

    // Stage: validating_results (Deterministic Server-Side FC26 Validation)
    checkCancelledOrThrow();
    updateJobProgress(db, jobId, {
      status: 'validating_results',
      currentStage: 'validating_results',
      progressDetail: {
        segmentsTotal: preparedAssets.length,
        segmentsProcessed: preparedAssets.length,
        stageLabel: 'Validating AI recommendations against FC 26 catalog and squad eligibility',
      },
    });

    const valStart = Date.now();
    const validatedRecs = validateAiRecommendations({
      clubId: matchContext.clubId ?? '',
      matchContext,
      rawRecommendations: synthRes.recommendations,
      observations: allObservations,
      segmentDurationById,
      db,
    });
    timing.resultValidationMs = Date.now() - valStart;

    const completedAt = new Date().toISOString();
    const hasInvalidRecs = validatedRecs.some((r) => r.validationStatus === 'invalid_unsupported');
    const limitations = [...(synthRes.limitations ?? [])];
    if (activeStrategy === 'sequential_frames') {
      limitations.push(
        'Analyzed using Sequential Keyframe Fallback (periodic local JPEG keyframes) rather than continuous native video; rapid micro-transitions between sampled frames may not be captured.'
      );
    }
    if (hasInvalidRecs) {
      limitations.push(
        'One or more AI proposals failed deterministic FC 26 catalog/eligibility validation and were flagged as Unsupported without silent mutation.'
      );
    }

    const persistTx = db.transaction(() => {
      // Persist Tactical Vision Assessment
      const normRecVision =
        synthRes.visionAssessment.recommendedVisionKey === 'retain_current'
          ? 'retain_current'
          : normalizeTacticalVisionKey(synthRes.visionAssessment.recommendedVisionKey, db);

      db.prepare(`
        INSERT INTO ai_tactical_vision_assessments (
          id, job_id, match_id, half, intended_vision_key, observed_playing_style_json,
          recommended_vision_key, recommendation_stance, recommendation_rationale,
          official_compliance_status, role_affinity_matched_count, role_affinity_total_count,
          role_affinity_unknown_count, execution_assessment_label, internal_assessment_score,
          score_methodology_note, criteria_breakdown_json, confidence, limitations, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        jobId,
        matchId,
        half,
        threeLayerEval.tacticalVisionKey,
        JSON.stringify(synthRes.visionAssessment.observedPlayingStyle),
        normRecVision,
        synthRes.visionAssessment.recommendationStance,
        synthRes.visionAssessment.recommendationRationale,
        threeLayerEval.layer2OfficialRequirements.status,
        threeLayerEval.layer3RoleAffinity.matchedCount,
        threeLayerEval.layer3RoleAffinity.assignedRoleCount,
        threeLayerEval.layer3RoleAffinity.unknownCount,
        synthRes.visionAssessment.executionAssessmentLabel,
        synthRes.visionAssessment.internalAssessmentScore,
        synthRes.visionAssessment.scoreMethodologyNote,
        JSON.stringify(synthRes.visionAssessment.criteriaBreakdown ?? []),
        synthRes.visionAssessment.confidence,
        synthRes.visionAssessment.limitations ?? '',
        completedAt
      );

      // Persist Validated Recommendations + Default Decision Records
      const insertRec = db.prepare(`
        INSERT INTO ai_tactical_recommendations (
          id, job_id, match_id, priority_group, priority_rank, title, action_type,
          target_slot_id, target_position_code, current_value, proposed_value,
          target_player_out_id, target_player_in_id, reason, expected_benefit, potential_risk,
          evidence_observation_ids_json, evidence_timestamps_json, confidence,
          validation_status, validation_errors_json, raw_ai_proposal_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertDec = db.prepare(`
        INSERT INTO ai_recommendation_decisions (
          id, recommendation_id, match_id, job_id, decision_status,
          modified_value, applied_in_game, applied_confirmed_at, adjustment_snapshot_id,
          user_notes, updated_at
        ) VALUES (?, ?, ?, ?, 'ai_recommended', NULL, 0, NULL, NULL, '', ?)
      `);

      for (const rec of validatedRecs) {
        const recId = crypto.randomUUID();
        insertRec.run(
          recId,
          jobId,
          matchId,
          rec.priorityGroup,
          rec.priorityRank,
          rec.title,
          rec.actionType,
          rec.targetSlotId,
          rec.targetPositionCode,
          rec.currentValue,
          rec.proposedValue,
          rec.targetPlayerOutId,
          rec.targetPlayerInId,
          rec.reason,
          rec.expectedBenefit,
          rec.potentialRisk,
          JSON.stringify(rec.evidenceObservationIds),
          JSON.stringify(rec.evidenceTimestamps),
          rec.confidence,
          rec.validationStatus,
          JSON.stringify(rec.validationErrors),
          JSON.stringify(rec.rawAiProposal),
          completedAt
        );
        insertDec.run(crypto.randomUUID(), recId, matchId, jobId, completedAt);
      }

      // Persist Half-Time Briefing payload
      const briefingPayload: AiHalftimeBriefingPayload = {
        id: crypto.randomUUID(),
        jobId,
        matchId,
        half,
        language: params.language,
        modelUsed: stage3ModelUsed,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        evidenceQuality: synthRes.evidenceQuality,
        managerVerdict: synthRes.managerVerdict,
        readableHudStats: mergedHudStats,
        gameplayCoaching: synthRes.gameplayCoaching ?? [],
        contingencyPlan: synthRes.contingencyPlan ?? [],
        limitations,
        createdAt: completedAt,
      };

      db.prepare(`
        INSERT INTO ai_halftime_briefings (
          id, job_id, match_id, half, language, model_used, prompt_version,
          schema_version, briefing_json, evidence_quality, limitations_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        briefingPayload.id,
        jobId,
        matchId,
        half,
        params.language,
        stage3ModelUsed,
        PROMPT_VERSION,
        SCHEMA_VERSION,
        JSON.stringify(briefingPayload),
        briefingPayload.evidenceQuality,
        JSON.stringify(limitations),
        completedAt
      );

      upsertStageCheckpoint(db, {
        jobId,
        matchId,
        sessionId,
        half,
        stageName: 'generating_briefing',
        segmentId: null,
        segmentIndex: 0,
        segmentChecksum: '',
        proxySignature,
        modelUsed: stage3ModelUsed,
        analysisStrategy: activeStrategy,
        payload: { briefingId: briefingPayload.id, recommendationCount: validatedRecs.length },
      });
    });

    persistTx();

    // Stage 4: Second-Half Comparison if analyzing second_half and a completed first_half job exists
    if (half === 'second_half') {
      const firstHalfJobRow = db
        .prepare(
          `SELECT id FROM ai_analysis_jobs
           WHERE match_id = ? AND half = 'first_half' AND status IN ('completed', 'completed_with_limitations')
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(matchId) as { id: string } | undefined;

      if (firstHalfJobRow) {
        const firstHalfObs = (
          db
            .prepare('SELECT * FROM ai_gameplay_observations WHERE job_id = ? ORDER BY session_start_seconds ASC')
            .all(firstHalfJobRow.id) as Array<Record<string, unknown>>
        ).map(mapObservationRow);

        const firstHalfRecs = db
          .prepare(
            `SELECT r.title, r.proposed_value, COALESCE(d.decision_status, 'ai_recommended') as decision_status,
                    COALESCE(d.applied_in_game, 0) as applied_in_game
             FROM ai_tactical_recommendations r
             LEFT JOIN ai_recommendation_decisions d ON d.recommendation_id = r.id
             WHERE r.job_id = ?`
          )
          .all(firstHalfJobRow.id) as Array<{
          title: string;
          proposed_value: string;
          decision_status: string;
          applied_in_game: number;
        }>;

        const { result: compResRaw, modelUsed: stage4ModelUsed } = await runStageWithModelFailover({
          stageKey: 'stage4_second_half_comparison',
          stageLabel: 'second-half comparison',
          capability: 'synthesis',
          initialModelId: stage3ModelUsed,
          reusedRemoteMedia: false,
          segmentIndex: null,
          invoke: (mId) =>
            provider.synthesizeSecondHalfComparison({
              modelId: mId,
              language: params.language,
              matchContext,
              firstHalfObservations: firstHalfObs,
              secondHalfObservations: allObservations,
              reviewedRecommendations: firstHalfRecs.map((r) => ({
                title: r.title,
                proposedValue: r.proposed_value,
                decisionStatus: r.decision_status,
                appliedInGame: Boolean(r.applied_in_game),
              })),
              maxRetries,
              inferenceTimeoutMs,
              abortSignal: jobController.signal,
            }),
        });

        cumulativeCostUsd += compResRaw.usage.estimatedCostUsd;
        insertApiUsageLog({
          matchId,
          analysisJobId: jobId,
          modelId: compResRaw.usage.modelId,
          stage: 'stage4_second_half_comparison',
          inputTokens: compResRaw.usage.inputTokens,
          outputTokens: compResRaw.usage.outputTokens,
          requestDurationMs: compResRaw.usage.durationMs,
          estimatedCostUsd: compResRaw.usage.estimatedCostUsd,
          pricingSource: 'local_registry_indicative_estimate',
          isEstimate: true,
          status: 'success',
        });

        const compRes = await validateAndRepairStageOutput({
          stageName: 'stage4_second_half_comparison',
          modelId: stage4ModelUsed,
          raw: compResRaw,
          validator: (raw) => validateComparisonStageResponse(raw),
          canonicalSchema: buildStage4ComparisonSchema(),
        });

        const compPayload: AiSecondHalfComparisonPayload = {
          id: crypto.randomUUID(),
          jobId,
          matchId,
          firstHalfJobId: firstHalfJobRow.id,
          modelUsed: stage4ModelUsed,
          summary: compRes.summary,
          appliedAdjustmentsReviewed: compRes.appliedAdjustmentsReviewed,
          attackingComparison: compRes.attackingComparison,
          defensiveComparison: compRes.defensiveComparison,
          tacticalVisionComparison: compRes.tacticalVisionComparison,
          recurringWeaknesses: compRes.recurringWeaknesses,
          limitations: compRes.limitations,
          createdAt: new Date().toISOString(),
        };

        db.prepare(`
          INSERT INTO ai_second_half_comparisons (
            id, job_id, match_id, first_half_job_id, model_used, comparison_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          compPayload.id,
          jobId,
          matchId,
          firstHalfJobRow.id,
          stage4ModelUsed,
          JSON.stringify(compPayload),
          compPayload.createdAt
        );

        try {
          exportAnalysisArtifactJson(matchId, 'match-comparison.json', compPayload);
        } catch {
          // supplementary file mirror is non-fatal
        }
      }
    }

    // Export supplementary secret-safe AI Analysis JSON mirror for structured v2 matches
    try {
      const bundleSnapshot = listMatchAnalysisBundle(matchId, jobId, db);
      exportAnalysisArtifactJson(
        matchId,
        half === 'first_half' ? 'first-half-analysis.json' : 'second-half-analysis.json',
        {
          jobId,
          half,
          modelVideoId: params.modelVideoId,
          modelSynthesisId: stage3ModelUsed,
          analysisStrategy: activeStrategy,
          stageModelsUsed,
          fallbackHistory,
          validationSummary,
          briefing: bundleSnapshot.briefing,
          visionAssessment: bundleSnapshot.visionAssessment,
          classifications: bundleSnapshot.classifications,
          observations: bundleSnapshot.observations,
          recommendations: bundleSnapshot.recommendations,
        }
      );
      writeMatchMetadataManifest(matchId);
    } catch {
      // supplementary file mirror is non-fatal; SQLite remains authoritative
    }

    // Mark session analysis_state completed & finalize job status truthfully
    updateMatchSession(sessionId, { analysisState: 'analysis_completed' });
    const finalStatus: AnalysisJobStatus =
      hasInvalidRecs || synthRes.evidenceQuality === 'limited' || activeStrategy === 'sequential_frames'
        ? 'completed_with_limitations'
        : 'completed';

    timing.totalElapsedMs = Date.now() - startedWallMs;
    updateJobProgress(
      db,
      jobId,
      {
        status: finalStatus,
        currentStage: finalStatus,
        analysisStrategy: activeStrategy,
        stageModelsUsed,
        fallbackHistory,
        validationSummary,
        coverageSummary,
        actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
        completedAt,
        elapsedMs: timing.totalElapsedMs,
        timingBreakdown: timing,
        progressDetail: {
          segmentsTotal: preparedAssets.length,
          segmentsProcessed: preparedAssets.length,
          stageLabel:
            finalStatus === 'completed'
              ? 'Half-time briefing ready'
              : 'Completed with documented limitations',
          proxyAppliedCount,
          originalBytesTotal,
          processedBytesTotal,
          note: coverageSummary,
        },
      },
      { allowTerminalTransition: false }
    );
  } catch (err) {
    const finishedAt = new Date().toISOString();
    timing.totalElapsedMs = Date.now() - startedWallMs;
    const isCancel = err instanceof Error && err.message === '__JOB_CANCELLED__';

    if (isCancel || isCancelled()) {
      const cancelDiag: SanitizedGeminiErrorDiagnostic = {
        code: 'ANALYSIS_CANCELLED',
        errorDomain: 'internal',
        httpStatus: null,
        apiStatus: null,
        upstreamMessage: 'Analysis job was cancelled by the user.',
        stage: currentStageName,
        modelId: currentModelInUse,
        segmentIndex: currentSegmentNumber,
        attemptNumber: totalRetryCount + 1,
        elapsedMs: timing.totalElapsedMs,
        retryable: false,
        retryAfterMs: null,
        occurredAt: finishedAt,
      };
      updateJobProgress(
        db,
        jobId,
        {
          status: 'cancelled',
          currentStage: 'cancelled',
          analysisStrategy: activeStrategy,
          stageModelsUsed,
          fallbackHistory,
          validationSummary,
          actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
          completedAt: finishedAt,
          elapsedMs: timing.totalElapsedMs,
          timingBreakdown: timing,
          errorCode: 'ANALYSIS_CANCELLED',
          errorMessage: 'Analysis job was cancelled by the user.',
          diagnostics: cancelDiag,
        },
        { allowTerminalTransition: true }
      );
    } else if (isMediaPathError(err)) {
      // Local recording media path / security / integrity error — NEVER misclassify as Gemini error!
      const mediaDiag: SanitizedGeminiErrorDiagnostic = {
        code: 'INVALID_MODEL_RESPONSE',
        errorDomain: 'ffmpeg',
        httpStatus: null,
        apiStatus: err.code,
        upstreamMessage: sanitizeDiagnosticText(err.message),
        stage: currentStageName,
        modelId: currentModelInUse,
        segmentIndex: currentSegmentNumber,
        attemptNumber: totalRetryCount + 1,
        elapsedMs: timing.totalElapsedMs,
        retryable: false,
        retryAfterMs: null,
        occurredAt: finishedAt,
      };
      insertApiUsageLog({
        matchId,
        analysisJobId: jobId,
        modelId: currentModelInUse,
        stage: 'local_media_validation_error',
        inputTokens: 0,
        outputTokens: 0,
        requestDurationMs: timing.totalElapsedMs,
        status: 'error',
        errorMessage: `${err.code}: ${sanitizeDiagnosticText(err.message)}`,
      });
      updateJobProgress(
        db,
        jobId,
        {
          status: 'failed',
          currentStage: 'failed',
          analysisStrategy: activeStrategy,
          stageModelsUsed,
          fallbackHistory,
          validationSummary,
          actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
          completedAt: finishedAt,
          elapsedMs: timing.totalElapsedMs,
          timingBreakdown: timing,
          errorCode: err.code,
          errorMessage: err.message,
          diagnostics: mediaDiag,
        },
        { allowTerminalTransition: false }
      );
    } else {
      const classified = isGeminiStageError(err)
        ? {
            code: err.geminiErrorCode,
            userMessage: err.message,
            diagnostic: {
              ...err.diagnostic,
              stage: err.diagnostic.stage ?? currentStageName,
              modelId: err.diagnostic.modelId ?? currentModelInUse,
              segmentIndex: err.diagnostic.segmentIndex ?? currentSegmentNumber,
              elapsedMs: err.diagnostic.elapsedMs ?? timing.totalElapsedMs,
            },
          }
        : classifyGeminiError(err, {
            stage: currentStageName,
            modelId: currentModelInUse,
            segmentIndex: currentSegmentNumber,
            attemptNumber: totalRetryCount + 1,
            elapsedMs: timing.totalElapsedMs,
          });

      if (classified.diagnostic.errorDomain === 'database') {
        validationSummary.databaseErrors.push({
          stage: currentStageName,
          code: classified.code,
          sqliteCode: classified.diagnostic.sqliteCode ?? null,
          message: sanitizeDiagnosticText(classified.userMessage),
          occurredAt: finishedAt,
        });
      }

      insertApiUsageLog({
        matchId,
        analysisJobId: jobId,
        modelId: currentModelInUse,
        stage:
          classified.diagnostic.errorDomain === 'database'
            ? 'local_database_persistence_error'
            : classified.diagnostic.errorDomain === 'ai_validation'
              ? 'ai_response_validation_error'
              : currentStageName || 'pipeline_error',
        inputTokens: 0,
        outputTokens: 0,
        requestDurationMs: timing.totalElapsedMs,
        status: 'error',
        errorMessage: sanitizeDiagnosticText(`${classified.code}: ${classified.userMessage}`),
      });
      updateJobProgress(
        db,
        jobId,
        {
          status: 'failed',
          currentStage: 'failed',
          analysisStrategy: activeStrategy,
          stageModelsUsed,
          fallbackHistory,
          validationSummary,
          actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
          completedAt: finishedAt,
          elapsedMs: timing.totalElapsedMs,
          timingBreakdown: timing,
          errorCode: classified.code,
          errorMessage: classified.userMessage,
          diagnostics: classified.diagnostic,
        },
        { allowTerminalTransition: false }
      );
    }
  } finally {
    clearInterval(heartbeatTimer);

    // Durable guaranteed remote file cleanup for ALL uploaded assets of this job
    // (runs on success, failure, cancel, timeout, or partial upload — NEVER touches local gameplay recordings)
    const shouldDeleteRemote = settings.ai.deleteRemoteAfterAnalysis !== false;
    const dbUploadedRows = db
      .prepare(
        `SELECT id, remote_file_name FROM ai_analysis_assets
         WHERE job_id = ? AND remote_file_name IS NOT NULL AND cleanup_status != 'deleted'`
      )
      .all(jobId) as Array<{ id: string; remote_file_name: string }>;

    for (const r of dbUploadedRows) {
      if (!uploadedAssetsMap.has(r.id)) {
        uploadedAssetsMap.set(r.id, r.remote_file_name);
      }
    }

    for (const [assetId, remoteFileName] of uploadedAssetsMap.entries()) {
      const now = new Date().toISOString();
      if (!shouldDeleteRemote) {
        db.prepare(
          `UPDATE ai_analysis_assets
           SET cleanup_status = 'retained_by_policy', updated_at = ?
           WHERE id = ?`
        ).run(now, assetId);
        continue;
      }

      // Transition uploaded -> cleanup_pending before attempting deletion
      db.prepare(
        `UPDATE ai_analysis_assets
         SET cleanup_status = 'cleanup_pending', updated_at = ?
         WHERE id = ? AND cleanup_status != 'deleted'`
      ).run(now, assetId);

      await deleteSingleRemoteAsset(db, assetId, remoteFileName, provider);
    }

    cleanupTempAnalysisDir(jobId);
    activeJobControllers.delete(jobId);
    runningJobIds.delete(jobId);
    cancelRequestedJobIds.delete(jobId);
  }
}

// ============================================================
// Recommendation Decisions, Adjustment Snapshots & Preset Saving
// ============================================================

export function saveRecommendationDecision(input: {
  recommendationId: string;
  decisionStatus: RecommendationDecisionStatus;
  modifiedValue?: string | null;
  appliedInGame?: boolean;
  userNotes?: string;
}, dbArg?: Database.Database): AiRecommendationDecisionRecord {
  const db = dbArg ?? getDb();
  const rec = db
    .prepare('SELECT id, match_id, job_id FROM ai_tactical_recommendations WHERE id = ?')
    .get(input.recommendationId) as { id: string; match_id: string; job_id: string } | undefined;
  if (!rec) {
    throw new Error(`Recommendation "${input.recommendationId}" not found.`);
  }

  const now = new Date().toISOString();
  const applied = input.appliedInGame === true || input.decisionStatus === 'applied_in_game';

  db.prepare(`
    INSERT INTO ai_recommendation_decisions (
      id, recommendation_id, match_id, job_id, decision_status,
      modified_value, applied_in_game, applied_confirmed_at, adjustment_snapshot_id,
      user_notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(recommendation_id) DO UPDATE SET
      decision_status = excluded.decision_status,
      modified_value = COALESCE(excluded.modified_value, ai_recommendation_decisions.modified_value),
      applied_in_game = excluded.applied_in_game,
      applied_confirmed_at = CASE WHEN excluded.applied_in_game = 1 THEN COALESCE(ai_recommendation_decisions.applied_confirmed_at, excluded.applied_confirmed_at) ELSE NULL END,
      user_notes = excluded.user_notes,
      updated_at = excluded.updated_at
  `).run(
    crypto.randomUUID(),
    rec.id,
    rec.match_id,
    rec.job_id,
    input.decisionStatus,
    input.modifiedValue ?? null,
    applied ? 1 : 0,
    applied ? now : null,
    (input.userNotes ?? '').trim(),
    now
  );

  const saved = db
    .prepare('SELECT * FROM ai_recommendation_decisions WHERE recommendation_id = ?')
    .get(rec.id) as Record<string, unknown>;
  return mapDecisionRow(saved);
}

export function applyAcceptedRecommendationsToAdjustmentSnapshot(input: {
  matchId: string;
  jobId: string;
  recommendationIds: string[];
  appliedInGameConfirmed?: boolean;
  notes?: string;
}, dbArg?: Database.Database): MatchTacticalSnapshot {
  const db = dbArg ?? getDb();
  const preMatch = getPreMatchTacticalSnapshot(input.matchId);
  if (!preMatch) {
    throw new Error('Cannot create half-time adjustment snapshot: pre-match snapshot not found.');
  }

  // Start from the latest snapshot (never mutating the immutable pre_match snapshot!)
  const allSnapshots = listMatchTacticalSnapshots(input.matchId);
  const baseSnapshot = allSnapshots[allSnapshots.length - 1] ?? preMatch;

  let nextVisionKey = baseSnapshot.tacticalVisionKey ?? 'unspecified';
  let nextFormationName = baseSnapshot.formationName;
  let nextBuildUpStyle = baseSnapshot.buildUpStyle;
  let nextDefensiveApproach = baseSnapshot.defensiveApproach;
  let nextLineHeight = baseSnapshot.defensiveLineHeight;

  const nextAssignments: PlayerRoleAssignment[] = baseSnapshot.assignments.map((a) => ({
    slotIndex: a.slotOrder,
    slotId: a.slotId,
    positionCode: a.positionCode,
    playerId: a.playerId,
    playerName: a.playerDisplayName,
    role: a.role,
    focus: a.focus,
  }));

  const nextBenchIds = baseSnapshot.benchPlayers.map((b) => b.playerId);
  const appliedTitles: string[] = [];

  for (const recId of input.recommendationIds) {
    const recRow = db
      .prepare('SELECT * FROM ai_tactical_recommendations WHERE id = ? AND match_id = ?')
      .get(recId, input.matchId) as Record<string, unknown> | undefined;
    if (!recRow) continue;
    if (String(recRow.validation_status) === 'invalid_unsupported') {
      throw new Error(
        `Cannot apply recommendation "${String(recRow.title)}": flagged as invalid/unsupported by FC 26 validation.`
      );
    }

    const decRow = db
      .prepare('SELECT * FROM ai_recommendation_decisions WHERE recommendation_id = ?')
      .get(recId) as Record<string, unknown> | undefined;
    const effectiveValue = decRow?.modified_value
      ? String(decRow.modified_value)
      : String(recRow.proposed_value);
    const actionType = String(recRow.action_type);

    if (actionType === 'build_up_style') {
      nextBuildUpStyle = effectiveValue;
    } else if (actionType === 'defensive_approach') {
      nextDefensiveApproach = effectiveValue;
    } else if (actionType === 'defensive_line_height') {
      const n = Number(effectiveValue.replace(/[^\d]/g, ''));
      if (Number.isFinite(n) && n >= 1 && n <= 100) nextLineHeight = n;
    } else if (actionType === 'tactical_vision_change') {
      const nk = normalizeTacticalVisionKey(effectiveValue, db);
      if (nk !== 'unspecified') nextVisionKey = nk;
    } else if (actionType === 'formation_change') {
      nextFormationName = effectiveValue;
    } else if (actionType === 'player_role' || actionType === 'player_focus') {
      const targetSlotId = recRow.target_slot_id ? String(recRow.target_slot_id) : null;
      const targetPos = recRow.target_position_code ? String(recRow.target_position_code) : null;
      const idx = nextAssignments.findIndex(
        (a) =>
          (targetSlotId && a.slotId === targetSlotId) ||
          (targetPos && a.positionCode.toUpperCase() === targetPos.toUpperCase())
      );
      if (idx >= 0) {
        if (actionType === 'player_role') {
          const m = effectiveValue.match(/^(.+?)\s*\((.+?)\)$/);
          if (m) {
            nextAssignments[idx] = { ...nextAssignments[idx], role: m[1].trim(), focus: m[2].trim() };
          } else {
            nextAssignments[idx] = { ...nextAssignments[idx], role: effectiveValue.trim() };
          }
        } else {
          nextAssignments[idx] = { ...nextAssignments[idx], focus: effectiveValue.trim() };
        }
      }
    } else if (actionType === 'substitution') {
      const outId = recRow.target_player_out_id ? String(recRow.target_player_out_id) : null;
      const inId = recRow.target_player_in_id ? String(recRow.target_player_in_id) : null;
      if (inId) {
        const idx = outId
          ? nextAssignments.findIndex((a) => a.playerId === outId)
          : nextAssignments.findIndex(
              (a) =>
                recRow.target_position_code &&
                a.positionCode.toUpperCase() === String(recRow.target_position_code).toUpperCase()
            );
        if (idx >= 0) {
          const prevPlayerId = nextAssignments[idx].playerId;
          nextAssignments[idx] = { ...nextAssignments[idx], playerId: inId };
          const benchIdx = nextBenchIds.indexOf(inId);
          if (benchIdx >= 0) nextBenchIds.splice(benchIdx, 1);
          if (prevPlayerId && !nextBenchIds.includes(prevPlayerId)) {
            nextBenchIds.push(prevPlayerId);
          }
        }
      }
    }

    appliedTitles.push(String(recRow.title));
  }

  const createdSnapshot = createInMatchTacticalAdjustment(input.matchId, {
    tacticalVisionKey: nextVisionKey,
    formationName: nextFormationName,
    buildUpStyle: nextBuildUpStyle,
    defensiveApproach: nextDefensiveApproach,
    defensiveLineHeight: nextLineHeight,
    playerAssignments: nextAssignments,
    benchIds: nextBenchIds,
    appliedInGameConfirmed: Boolean(input.appliedInGameConfirmed),
    notes:
      input.notes?.trim() ||
      `Half-time adjustment draft from AI briefing (${appliedTitles.join('; ')})`,
  });

  // Link accepted decisions to the newly created adjustment snapshot
  const now = new Date().toISOString();
  for (const recId of input.recommendationIds) {
    db.prepare(`
      UPDATE ai_recommendation_decisions
      SET decision_status = CASE WHEN ? = 1 THEN 'applied_in_game' WHEN decision_status = 'ai_recommended' THEN 'user_accepted' ELSE decision_status END,
          applied_in_game = CASE WHEN ? = 1 THEN 1 ELSE applied_in_game END,
          applied_confirmed_at = CASE WHEN ? = 1 THEN COALESCE(applied_confirmed_at, ?) ELSE applied_confirmed_at END,
          adjustment_snapshot_id = ?,
          updated_at = ?
      WHERE recommendation_id = ?
    `).run(
      input.appliedInGameConfirmed ? 1 : 0,
      input.appliedInGameConfirmed ? 1 : 0,
      input.appliedInGameConfirmed ? 1 : 0,
      now,
      createdSnapshot.id,
      now,
      recId
    );
  }

  return createdSnapshot;
}

export function saveAdjustmentAsNewClubPreset(input: {
  matchId: string;
  snapshotId: string;
  presetName: string;
}, dbArg?: Database.Database): TacticalPreset {
  const db = dbArg ?? getDb();
  const matchRow = db.prepare('SELECT club_id FROM matches WHERE id = ?').get(input.matchId) as
    | { club_id: string }
    | undefined;
  if (!matchRow) {
    throw new Error(`Match "${input.matchId}" not found.`);
  }

  const snapshots = listMatchTacticalSnapshots(input.matchId);
  const snap = snapshots.find((s) => s.id === input.snapshotId);
  if (!snap) {
    throw new Error(`Tactical snapshot "${input.snapshotId}" not found for this match.`);
  }

  return createTacticalPreset(matchRow.club_id, {
    name: input.presetName.trim() || `Half-Time Adjustment (${snap.formationName})`,
    tacticalVisionKey: snap.tacticalVisionKey ?? 'unspecified',
    formationId: snap.formationId,
    formationName: snap.formationName,
    buildUpStyle: snap.buildUpStyle,
    defensiveApproach: snap.defensiveApproach,
    defensiveLineHeight: snap.defensiveLineHeight,
    isDefault: false,
    presetStatus: 'match_ready',
    benchPlayerIds: snap.benchPlayers.map((b) => b.playerId),
    notes: `Saved explicitly from match half-time adjustment snapshot. ${snap.notes}`,
    assignments: snap.assignments.map((a) => ({
      slotOrder: a.slotOrder,
      slotId: a.slotId,
      positionCode: a.positionCode,
      playerId: a.playerId,
      role: a.role,
      focus: a.focus,
    })),
  });
}

export async function importBrowserPreviewTestClip(input: {
  matchId: string;
  half: 'first_half' | 'second_half';
  fileName: string;
  buffer: Buffer;
}): Promise<{
  sessionId: string;
  segmentId: string;
  filePath: string;
  durationSeconds: number;
  sizeBytes: number;
  resolution: string | null;
}> {
  if (!input.buffer || input.buffer.length === 0) {
    throw new Error('Uploaded test clip is empty.');
  }
  if (input.buffer.length > 60 * 1024 * 1024) {
    throw new Error('Test clip exceeds 60 MB Browser Preview upload limit.');
  }

  const dir = getTestClipsDir(input.matchId);
  const safeBase = path.basename(input.fileName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'test_clip.mp4';
  const targetName = `${Date.now()}_${safeBase.endsWith('.mp4') ? safeBase : `${safeBase}.mp4`}`;
  const outPath = path.join(dir, targetName);
  fs.writeFileSync(outPath, input.buffer);

  const probe = await validateVideoFile(outPath, [dir]);
  if (!probe.valid) {
    try {
      fs.unlinkSync(outPath);
    } catch {
      // ignore
    }
    throw new Error(`Invalid test video clip: ${probe.error ?? 'FFprobe validation failed.'}`);
  }

  const sessionId = crypto.randomUUID();
  const resolution = probe.width && probe.height ? `${probe.width}x${probe.height}` : '1280x720';
  const now = new Date().toISOString();

  createOrUpsertMatchSession({
    id: sessionId,
    matchId: input.matchId,
    half: input.half,
    status: 'recording',
    captureSourceId: 'browser-preview-test-clip',
    captureSourceName: `Test Clip (${safeBase})`,
    resolution,
    fps: Math.round(probe.fps ?? 30),
    durationSeconds: Math.round(probe.durationSeconds),
    totalBytes: probe.sizeBytes,
    encoder: probe.codec ?? 'h264',
    audioEnabled: probe.hasAudio,
    outputDirectory: dir,
    integrityStatus: 'verified',
    aiEligible: true,
    startedAt: now,
  });

  const segment = upsertRecordingSegment({
    sessionId,
    matchId: input.matchId,
    segmentIndex: 1,
    filePath: outPath,
    durationSeconds: Math.max(1, Math.round(probe.durationSeconds)),
    sizeBytes: probe.sizeBytes,
    checksum: probe.sha256Hash,
    status: 'finalized',
    resolution,
    fps: probe.fps,
    codec: probe.codec,
    hasAudio: probe.hasAudio,
    integrityStatus: 'verified',
    startedAt: now,
    endedAt: now,
  });

  updateMatchSession(sessionId, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    analysisState: 'verified_awaiting_phase3',
    endedAt: now,
  });

  return {
    sessionId,
    segmentId: segment.id,
    filePath: outPath,
    durationSeconds: probe.durationSeconds,
    sizeBytes: probe.sizeBytes,
    resolution,
  };
}
