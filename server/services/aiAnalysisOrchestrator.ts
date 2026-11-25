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
  AnalysisJobStatus,
  AnalysisLanguage,
  AnalysisTimingBreakdown,
  MatchAnalysisBundle,
  MatchTacticalSnapshot,
  PlayerRoleAssignment,
  RecommendationDecisionStatus,
  TacticalPreset,
  VideoAnalysisMode,
} from '../../src/types/domain.ts';
import { getDb } from '../db/database.ts';
import { validateAiRecommendations } from './analysisValidationService.ts';
import {
  classifyGeminiError,
  estimateVideoAnalysisCostUsd,
  isGeminiApiConfigured,
} from './geminiService.ts';
import {
  defaultLiveGeminiVideoProvider,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type GeminiVideoProvider,
  type VideoClassificationOutput,
} from './geminiVideoService.ts';
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

const runningJobIds = new Set<string>();
const cancelRequestedJobIds = new Set<string>();

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
    samplingFps: Number(r.sampling_fps ?? 1.0),
    coverageSummary: String(r.coverage_summary ?? ''),
    startedAt: r.started_at ? String(r.started_at) : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
    elapsedMs: Number(r.elapsed_ms ?? 0),
    timingBreakdown: safeJsonParse<AnalysisTimingBreakdown | null>(
      r.timing_breakdown_json ? String(r.timing_breakdown_json) : null,
      null
    ),
    errorCode: r.error_code ? String(r.error_code) : null,
    errorMessage: r.error_message ? String(r.error_message) : null,
    retryCount: Number(r.retry_count ?? 0),
    cancelRequested: Boolean(r.cancel_requested),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
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
    durationSeconds: Number(r.duration_seconds ?? 0),
    width: r.width === null || r.width === undefined ? null : Number(r.width),
    height: r.height === null || r.height === undefined ? null : Number(r.height),
    remoteFileName: r.remote_file_name ? String(r.remote_file_name) : null,
    remoteFileUri: r.remote_file_uri ? String(r.remote_file_uri) : null,
    remoteState: r.remote_state ? String(r.remote_state) : null,
    cleanupStatus: String(r.cleanup_status) as AiAnalysisAssetRecord['cleanupStatus'],
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
  const res = db
    .prepare(
      `UPDATE ai_analysis_jobs
       SET status = 'interrupted',
           current_stage = 'interrupted',
           error_code = 'APP_RESTARTED_MID_JOB',
           error_message = 'Application restarted while this analysis job was running. You may safely retry the analysis.',
           completed_at = ?,
           updated_at = ?
       WHERE status IN (${placeholders})`
    )
    .run(now, now, ...ACTIVE_JOB_STATUSES);
  return res.changes;
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
  };
}

export function cancelAnalysisJob(jobId: string, dbArg?: Database.Database): AiAnalysisJobRecord | null {
  const db = dbArg ?? getDb();
  const job = getAnalysisJob(jobId, db);
  if (!job) return null;

  cancelRequestedJobIds.add(jobId);
  const now = new Date().toISOString();
  if (ACTIVE_JOB_STATUSES.includes(job.status)) {
    db.prepare(
      `UPDATE ai_analysis_jobs
       SET cancel_requested = 1,
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           completed_at = CASE WHEN status = 'queued' THEN ? ELSE completed_at END,
           updated_at = ?
       WHERE id = ?`
    ).run(now, now, jobId);
  }
  return getAnalysisJob(jobId, db);
}

export async function retryRemoteCleanup(
  jobId: string,
  provider: GeminiVideoProvider = defaultLiveGeminiVideoProvider,
  dbArg?: Database.Database
): Promise<AiAnalysisAssetRecord[]> {
  const db = dbArg ?? getDb();
  const assetRows = db
    .prepare(
      `SELECT * FROM ai_analysis_assets
       WHERE job_id = ? AND remote_file_name IS NOT NULL AND cleanup_status IN ('pending', 'cleanup_failed')`
    )
    .all(jobId) as Array<Record<string, unknown>>;

  for (const row of assetRows) {
    const remoteName = String(row.remote_file_name);
    const now = new Date().toISOString();
    const res = await provider.deleteRemoteFile(remoteName);
    db.prepare(
      `UPDATE ai_analysis_assets
       SET cleanup_status = ?, cleanup_attempted_at = ?, cleanup_confirmed_at = ?, cleanup_error = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      res.deleted ? 'deleted' : 'cleanup_failed',
      now,
      res.deleted ? now : null,
      res.error,
      now,
      String(row.id)
    );
  }

  const refreshed = db
    .prepare('SELECT * FROM ai_analysis_assets WHERE job_id = ?')
    .all(jobId) as Array<Record<string, unknown>>;
  return refreshed.map(mapAssetRow);
}

function updateJobProgress(
  db: Database.Database,
  jobId: string,
  patch: Partial<{
    status: AnalysisJobStatus;
    currentStage: string;
    progressDetail: AiAnalysisJobRecord['progressDetail'];
    segmentsTotal: number;
    segmentsProcessed: number;
    coverageSummary: string;
    actualCostUsd: number;
    startedAt: string;
    completedAt: string;
    elapsedMs: number;
    timingBreakdown: AnalysisTimingBreakdown;
    errorCode: string | null;
    errorMessage: string | null;
    retryCount: number;
  }>
): void {
  const existing = db.prepare('SELECT * FROM ai_analysis_jobs WHERE id = ?').get(jobId) as
    | Record<string, unknown>
    | undefined;
  if (!existing) return;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE ai_analysis_jobs
    SET status = ?,
        current_stage = ?,
        progress_detail_json = ?,
        segments_total = ?,
        segments_processed = ?,
        coverage_summary = ?,
        actual_cost_usd = ?,
        started_at = ?,
        completed_at = ?,
        elapsed_ms = ?,
        timing_breakdown_json = ?,
        error_code = ?,
        error_message = ?,
        retry_count = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    patch.status ?? String(existing.status),
    patch.currentStage ?? String(existing.current_stage),
    patch.progressDetail
      ? JSON.stringify(patch.progressDetail)
      : String(existing.progress_detail_json ?? '{}'),
    patch.segmentsTotal ?? Number(existing.segments_total ?? 0),
    patch.segmentsProcessed ?? Number(existing.segments_processed ?? 0),
    patch.coverageSummary ?? String(existing.coverage_summary ?? ''),
    patch.actualCostUsd !== undefined ? patch.actualCostUsd : existing.actual_cost_usd,
    patch.startedAt ?? existing.started_at,
    patch.completedAt ?? existing.completed_at,
    patch.elapsedMs ?? Number(existing.elapsed_ms ?? 0),
    patch.timingBreakdown
      ? JSON.stringify(patch.timingBreakdown)
      : existing.timing_breakdown_json,
    patch.errorCode !== undefined ? patch.errorCode : existing.error_code,
    patch.errorMessage !== undefined ? patch.errorMessage : existing.error_message,
    patch.retryCount ?? Number(existing.retry_count ?? 0),
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
  /** Test/runtime injection options */
  provider?: GeminiVideoProvider;
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

  const analysisMode: VideoAnalysisMode = input.analysisMode ?? settings.ai.defaultAnalysisMode ?? 'quick';
  const language: AnalysisLanguage = input.language ?? settings.ai.defaultLanguage ?? 'en';

  const modelVideoId =
    analysisMode === 'deep'
      ? settings.ai.deepAnalysisModelId ?? settings.ai.modelId ?? 'gemini-4-hydrogen'
      : analysisMode === 'balanced'
        ? settings.ai.balancedAnalysisModelId ?? settings.ai.modelId ?? 'gemini-4-hydrogen'
        : settings.ai.quickAnalysisModelId ?? settings.ai.modelId ?? 'gemini-4-hydrogen';

  const modelSynthesisId =
    settings.ai.tacticalSynthesisModelId ?? settings.ai.modelId ?? 'gemini-4-hydrogen';

  const samplingFps =
    analysisMode === 'deep'
      ? settings.ai.samplingFpsDeep ?? 2.0
      : analysisMode === 'balanced'
        ? settings.ai.samplingFpsBalanced ?? 1.0
        : settings.ai.samplingFpsQuick ?? 0.5;

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

  // Build deterministic request fingerprint for cache reuse
  const fingerprintInput = JSON.stringify({
    matchId: input.matchId,
    sessionId: targetSession.id,
    segmentKeys: validSegments.map((s) => `${s.id}:${s.checksum ?? s.sizeBytes}:${s.durationSeconds}`),
    half: input.half,
    analysisMode,
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

  if (!input.forceReanalyze) {
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
      progress_detail_json, model_video_id, model_synthesis_id, prompt_version, schema_version,
      tactical_vision_dataset_version, request_fingerprint, privacy_authorized, entire_display_acknowledged,
      estimated_cost_usd, actual_cost_usd, budget_cap_usd, segments_total, segments_processed,
      sampling_fps, coverage_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, '', ?, ?)
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
      stageLabel: 'Queued for video validation',
    }),
    modelVideoId,
    modelSynthesisId,
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

async function executeAnalysisJobPipeline(params: {
  jobId: string;
  matchId: string;
  sessionId: string;
  half: 'first_half' | 'second_half';
  analysisMode: VideoAnalysisMode;
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

  runningJobIds.add(jobId);
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

  let cumulativeCostUsd = 0;
  const uploadedAssets: Array<{ assetId: string; remoteFileName: string }> = [];

  const isCancelled = (): boolean => {
    if (cancelRequestedJobIds.has(jobId)) return true;
    const row = db
      .prepare('SELECT cancel_requested FROM ai_analysis_jobs WHERE id = ?')
      .get(jobId) as { cancel_requested: number } | undefined;
    return Boolean(row?.cancel_requested);
  };

  const checkCancelledOrThrow = () => {
    if (isCancelled()) {
      throw new Error('__JOB_CANCELLED__');
    }
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
    updateJobProgress(db, jobId, {
      status: 'validating_recording',
      currentStage: 'validating_recording',
      startedAt: startedAtIso,
      progressDetail: {
        segmentsTotal: validSegments.length,
        segmentsProcessed: 0,
        stageLabel: 'Validating local MP4 segment integrity with FFprobe',
      },
    });

    const preparedAssets: Array<{
      assetId: string;
      segmentId: string;
      segmentIndex: number;
      sessionOffsetSeconds: number;
      localFilePath: string;
      preparedFilePath: string;
      durationSeconds: number;
      sizeBytes: number;
    }> = [];

    const segmentDurationById = new Map<string, number>();
    let runningOffsetSeconds = 0;

    for (let i = 0; i < validSegments.length; i++) {
      checkCancelledOrThrow();
      const seg = validSegments[i];
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

      updateJobProgress(db, jobId, {
        status: 'preprocessing',
        currentStage: 'preprocessing',
        progressDetail: {
          segmentsTotal: validSegments.length,
          segmentsProcessed: i,
          stageLabel: `Preparing segment ${i + 1} of ${validSegments.length} for analysis`,
        },
      });

      const pStart = Date.now();
      const prepared = await prepareAnalysisVideoAsset({
        jobId,
        filePath: resolvedMedia.resolvedPath,
        downscale: Boolean(settings.ai.downscaleForAnalysis),
        allowedBaseDirs: params.allowedMediaDirs,
      });
      timing.preprocessingMs += Date.now() - pStart;

      const assetId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO ai_analysis_assets (
          id, job_id, match_id, session_id, segment_id, local_file_path, prepared_file_path,
          is_temp_asset, sha256_hash, file_size_bytes, duration_seconds, width, height,
          cleanup_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_uploaded', ?, ?)
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
        durationSeconds: prepared.metadata.durationSeconds,
        sizeBytes: prepared.metadata.sizeBytes,
      });
      runningOffsetSeconds += prepared.metadata.durationSeconds;
    }

    const matchContext = buildAiMatchTacticalContext(matchId, db);
    if (!matchContext) {
      throw new Error('Match context unavailable.');
    }

    // Per-segment Upload -> Classify -> Extract Observations
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

    for (let i = 0; i < preparedAssets.length; i++) {
      checkCancelledOrThrow();
      const asset = preparedAssets[i];

      updateJobProgress(db, jobId, {
        status: 'uploading',
        currentStage: 'uploading',
        segmentsProcessed: i,
        progressDetail: {
          segmentsTotal: preparedAssets.length,
          segmentsProcessed: i,
          stageLabel: `Uploading segment ${i + 1} of ${preparedAssets.length} to Gemini Files API`,
          uploadBytesTotal: asset.sizeBytes,
        },
      });

      const uploaded = await provider.uploadAndAwaitActive({
        filePath: asset.preparedFilePath,
        mimeType: 'video/mp4',
        displayName: `fc26_${matchId.slice(0, 8)}_${half}_seg${asset.segmentIndex}.mp4`,
        isCancelled,
        maxWaitMs: (settings.ai.maxAnalysisDurationSeconds ?? 180) * 1000,
      });

      timing.uploadMs += uploaded.uploadMs;
      timing.mediaProcessingMs += uploaded.mediaProcessingMs;
      uploadedAssets.push({ assetId: asset.assetId, remoteFileName: uploaded.remoteFileName });

      db.prepare(`
        UPDATE ai_analysis_assets
        SET remote_file_name = ?, remote_file_uri = ?, remote_state = ?, cleanup_status = 'pending', updated_at = ?
        WHERE id = ?
      `).run(
        uploaded.remoteFileName,
        uploaded.remoteFileUri,
        uploaded.remoteState,
        new Date().toISOString(),
        asset.assetId
      );

      checkCancelledOrThrow();

      // Stage 1: Gameplay Content Classification
      updateJobProgress(db, jobId, {
        status: 'classifying_gameplay',
        currentStage: 'classifying_gameplay',
        progressDetail: {
          segmentsTotal: preparedAssets.length,
          segmentsProcessed: i,
          stageLabel: `Classifying gameplay vs menus/replays (segment ${i + 1}/${preparedAssets.length})`,
        },
      });

      const classRes = await provider.classifyVideoSegment({
        modelId: params.modelVideoId,
        remoteFileUri: uploaded.remoteFileUri,
        mimeType: 'video/mp4',
        segmentDurationSeconds: asset.durationSeconds,
        samplingFps: params.samplingFps,
        half,
        maxRetries: settings.ai.maxRetryAttempts ?? 2,
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

      if (classRes.readableHudStats.scoreline) mergedHudStats.scoreline = classRes.readableHudStats.scoreline;
      if (classRes.readableHudStats.matchClock) mergedHudStats.matchClock = classRes.readableHudStats.matchClock;
      if (classRes.readableHudStats.possessionLabel)
        mergedHudStats.possessionLabel = classRes.readableHudStats.possessionLabel;
      if (classRes.readableHudStats.shotsLabel) mergedHudStats.shotsLabel = classRes.readableHudStats.shotsLabel;
      for (const st of classRes.readableHudStats.otherVerifiedStats) {
        if (!mergedHudStats.otherVerifiedStats.some((x) => x.label === st.label)) {
          mergedHudStats.otherVerifiedStats.push(st);
        }
      }

      const liveWindows: Array<{ startSeconds: number; endSeconds: number }> = [];
      const replayWindows: Array<{ startSeconds: number; endSeconds: number }> = [];
      const insertClassStmt = db.prepare(`
        INSERT INTO ai_video_classifications (
          id, job_id, match_id, segment_id, start_seconds, end_seconds,
          session_start_seconds, session_end_seconds, content_type, confidence,
          evidence_description, in_game_clock, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const segWin of classRes.segments) {
        const s0 = Math.max(0, Math.min(asset.durationSeconds, Number(segWin.startSeconds ?? 0)));
        const s1 = Math.max(s0, Math.min(asset.durationSeconds, Number(segWin.endSeconds ?? s0)));
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
        allClassifications.push({
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

        if (segWin.contentType === 'live_gameplay' || segWin.contentType === 'set_piece') {
          liveGameplaySeconds += Math.max(0, s1 - s0);
          liveWindows.push({ startSeconds: s0, endSeconds: s1 });
        } else if (segWin.contentType === 'replay') {
          replayWindows.push({ startSeconds: s0, endSeconds: s1 });
        }
      }

      // Stage 2: Extract Gameplay Observations ONLY if this segment has live gameplay / set pieces
      if (liveWindows.length > 0) {
        checkCancelledOrThrow();
        updateJobProgress(db, jobId, {
          status: 'analyzing_gameplay',
          currentStage: 'analyzing_gameplay',
          progressDetail: {
            segmentsTotal: preparedAssets.length,
            segmentsProcessed: i,
            stageLabel: `Extracting tactical observations (segment ${i + 1}/${preparedAssets.length})`,
          },
        });

        const obsRes = await provider.extractGameplayObservations({
          modelId: params.modelVideoId,
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
          maxRetries: settings.ai.maxRetryAttempts ?? 2,
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

        const insertObsStmt = db.prepare(`
          INSERT INTO ai_gameplay_observations (
            id, job_id, match_id, half, segment_id, start_seconds, end_seconds,
            session_start_seconds, session_end_seconds, in_game_clock,
            category_group, category, team_attribution, player_attribution,
            description, supporting_visual_evidence, evidence_type, confidence,
            severity, limitations, evidence_frame_path, is_from_replay, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const maxFrames = Math.min(12, settings.ai.maxEvidenceFrames ?? 12);
        let framesExtracted = 0;

        for (const rawObs of obsRes.observations) {
          const s0 = Number(rawObs.startSeconds);
          const s1 = Number(rawObs.endSeconds);
          if (!Number.isFinite(s0) || !Number.isFinite(s1) || s0 < 0 || s1 < s0 || s0 > asset.durationSeconds + 2) {
            continue; // Reject out-of-range fabricated timestamps
          }

          const clampedStart = Math.max(0, Math.min(asset.durationSeconds, s0));
          const clampedEnd = Math.max(clampedStart, Math.min(asset.durationSeconds, s1));

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

          const oid = crypto.randomUUID();
          const createdAt = new Date().toISOString();
          const cleanPlayerAttr = rawObs.playerAttribution?.trim() || 'Unknown';

          insertObsStmt.run(
            oid,
            jobId,
            matchId,
            half,
            asset.segmentId,
            clampedStart,
            clampedEnd,
            asset.sessionOffsetSeconds + clampedStart,
            asset.sessionOffsetSeconds + clampedEnd,
            rawObs.inGameClock ?? null,
            rawObs.categoryGroup,
            rawObs.category,
            rawObs.teamAttribution,
            cleanPlayerAttr,
            rawObs.description,
            rawObs.supportingVisualEvidence,
            rawObs.evidenceType,
            rawObs.confidence,
            rawObs.severity,
            rawObs.limitations ?? '',
            frameFileName,
            overlapsReplay ? 1 : 0,
            createdAt
          );

          allObservations.push({
            id: oid,
            jobId,
            matchId,
            half,
            segmentId: asset.segmentId,
            startSeconds: clampedStart,
            endSeconds: clampedEnd,
            sessionStartSeconds: asset.sessionOffsetSeconds + clampedStart,
            sessionEndSeconds: asset.sessionOffsetSeconds + clampedEnd,
            inGameClock: rawObs.inGameClock ?? null,
            categoryGroup: rawObs.categoryGroup,
            category: rawObs.category,
            teamAttribution: rawObs.teamAttribution,
            playerAttribution: cleanPlayerAttr,
            description: rawObs.description,
            supportingVisualEvidence: rawObs.supportingVisualEvidence,
            evidenceType: rawObs.evidenceType,
            confidence: rawObs.confidence,
            severity: rawObs.severity,
            limitations: rawObs.limitations ?? '',
            evidenceFramePath: frameFileName,
            isFromReplay: overlapsReplay,
            createdAt,
          });
        }
      }

      updateJobProgress(db, jobId, {
        segmentsProcessed: i + 1,
        actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
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

    updateJobProgress(db, jobId, {
      status: 'generating_briefing',
      currentStage: 'generating_briefing',
      progressDetail: {
        segmentsTotal: preparedAssets.length,
        segmentsProcessed: preparedAssets.length,
        stageLabel: 'Generating structured half-time briefing and tactical recommendations',
      },
    });

    const synthRes = await provider.synthesizeTacticalBriefing({
      modelId: params.modelSynthesisId,
      language: params.language,
      half,
      matchContext,
      threeLayerEval,
      observations: allObservations,
      readableHudStats: mergedHudStats,
      coverageSummary,
      userPreMatchNotes: matchNotesRow?.pre_match_notes ?? '',
      maxRetries: settings.ai.maxRetryAttempts ?? 2,
    });

    timing.tacticalSynthesisMs += synthRes.usage.durationMs;
    cumulativeCostUsd += synthRes.usage.estimatedCostUsd;

    insertApiUsageLog({
      matchId,
      analysisJobId: jobId,
      modelId: synthRes.usage.modelId,
      stage: 'stage3_tactical_synthesis',
      inputTokens: synthRes.usage.inputTokens,
      outputTokens: synthRes.usage.outputTokens,
      evidenceFramesCount: allObservations.filter((o) => Boolean(o.evidenceFramePath)).length,
      requestDurationMs: synthRes.usage.durationMs,
      estimatedCostUsd: synthRes.usage.estimatedCostUsd,
      pricingSource: 'local_registry_indicative_estimate',
      isEstimate: true,
      status: 'success',
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
        modelUsed: params.modelSynthesisId,
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
        params.modelSynthesisId,
        PROMPT_VERSION,
        SCHEMA_VERSION,
        JSON.stringify(briefingPayload),
        briefingPayload.evidenceQuality,
        JSON.stringify(limitations),
        completedAt
      );
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

        const compRes = await provider.synthesizeSecondHalfComparison({
          modelId: params.modelSynthesisId,
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
          maxRetries: settings.ai.maxRetryAttempts ?? 2,
        });

        cumulativeCostUsd += compRes.usage.estimatedCostUsd;
        insertApiUsageLog({
          matchId,
          analysisJobId: jobId,
          modelId: compRes.usage.modelId,
          stage: 'stage4_second_half_comparison',
          inputTokens: compRes.usage.inputTokens,
          outputTokens: compRes.usage.outputTokens,
          requestDurationMs: compRes.usage.durationMs,
          estimatedCostUsd: compRes.usage.estimatedCostUsd,
          pricingSource: 'local_registry_indicative_estimate',
          isEstimate: true,
          status: 'success',
        });

        const compPayload: AiSecondHalfComparisonPayload = {
          id: crypto.randomUUID(),
          jobId,
          matchId,
          firstHalfJobId: firstHalfJobRow.id,
          modelUsed: params.modelSynthesisId,
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
          params.modelSynthesisId,
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
          modelSynthesisId: params.modelSynthesisId,
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
      hasInvalidRecs || synthRes.evidenceQuality === 'limited'
        ? 'completed_with_limitations'
        : 'completed';

    timing.totalElapsedMs = Date.now() - startedWallMs;
    updateJobProgress(db, jobId, {
      status: finalStatus,
      currentStage: finalStatus,
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
        note: coverageSummary,
      },
    });
  } catch (err) {
    const finishedAt = new Date().toISOString();
    timing.totalElapsedMs = Date.now() - startedWallMs;
    const isCancel = err instanceof Error && err.message === '__JOB_CANCELLED__';

    if (isCancel || isCancelled()) {
      updateJobProgress(db, jobId, {
        status: 'cancelled',
        currentStage: 'cancelled',
        actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
        completedAt: finishedAt,
        elapsedMs: timing.totalElapsedMs,
        timingBreakdown: timing,
        errorCode: 'USER_CANCELLED',
        errorMessage: 'Analysis job was cancelled by the user.',
      });
    } else if (isMediaPathError(err)) {
      // Local recording media path / security / integrity error — NEVER misclassify as GEMINI_ANALYSIS_ERROR!
      insertApiUsageLog({
        matchId,
        analysisJobId: jobId,
        modelId: params.modelVideoId,
        stage: 'local_media_validation_error',
        inputTokens: 0,
        outputTokens: 0,
        requestDurationMs: timing.totalElapsedMs,
        status: 'error',
        errorMessage: `${err.code}: ${err.message}`,
      });
      updateJobProgress(db, jobId, {
        status: 'failed',
        currentStage: 'failed',
        actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
        completedAt: finishedAt,
        elapsedMs: timing.totalElapsedMs,
        timingBreakdown: timing,
        errorCode: err.code,
        errorMessage: err.message,
      });
    } else {
      const classified = classifyGeminiError(err);
      insertApiUsageLog({
        matchId,
        analysisJobId: jobId,
        modelId: params.modelVideoId,
        stage: 'pipeline_error',
        inputTokens: 0,
        outputTokens: 0,
        requestDurationMs: timing.totalElapsedMs,
        status: 'error',
        errorMessage: `${classified.code}: ${classified.userMessage}`,
      });
      updateJobProgress(db, jobId, {
        status: 'failed',
        currentStage: 'failed',
        actualCostUsd: Number(cumulativeCostUsd.toFixed(6)),
        completedAt: finishedAt,
        elapsedMs: timing.totalElapsedMs,
        timingBreakdown: timing,
        errorCode: classified.code,
        errorMessage: classified.userMessage,
      });
    }
  } finally {
    // Guaranteed remote file cleanup according to user retention policy
    const shouldDeleteRemote = settings.ai.deleteRemoteAfterAnalysis !== false;
    for (const item of uploadedAssets) {
      const now = new Date().toISOString();
      if (!shouldDeleteRemote) {
        db.prepare(
          `UPDATE ai_analysis_assets
           SET cleanup_status = 'retained_by_policy', updated_at = ?
           WHERE id = ?`
        ).run(now, item.assetId);
        continue;
      }

      try {
        const res = await provider.deleteRemoteFile(item.remoteFileName);
        db.prepare(
          `UPDATE ai_analysis_assets
           SET cleanup_status = ?, cleanup_attempted_at = ?, cleanup_confirmed_at = ?, cleanup_error = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          res.deleted ? 'deleted' : 'cleanup_failed',
          now,
          res.deleted ? now : null,
          res.error,
          now,
          item.assetId
        );
      } catch (cleanupErr) {
        db.prepare(
          `UPDATE ai_analysis_assets
           SET cleanup_status = 'cleanup_failed', cleanup_attempted_at = ?, cleanup_error = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          now,
          cleanupErr instanceof Error ? cleanupErr.message.slice(0, 200) : String(cleanupErr),
          now,
          item.assetId
        );
      }
    }

    cleanupTempAnalysisDir(jobId);
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
