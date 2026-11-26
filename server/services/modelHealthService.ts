import type Database from 'better-sqlite3';
import type {
  AiSettings,
  CapabilityProbeType,
  GeminiErrorCode,
  GeminiModelCapability,
  ModelHealthRecord,
  ModelHealthStatus,
} from '../../src/types/domain.ts';
import { getDb } from '../db/database.ts';
import { isDeprecatedGeminiModelId, normalizeModelId } from './geminiModelRouter.ts';

// Cooldown schedule in ms for consecutive transient failures (60s -> 180s -> 600s)
const COOLDOWN_STEPS_MS = [60_000, 180_000, 600_000];

const UNSUPPORTED_MODEL_ERROR_CODES = new Set<GeminiErrorCode>([
  'MODEL_NOT_FOUND',
  'MODEL_ACCESS_DENIED',
  'MODEL_VIDEO_UNSUPPORTED',
  'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED',
  'BILLING_REQUIRED',
]);

const FAILOVER_ELIGIBLE_ERROR_CODES = new Set<GeminiErrorCode>([
  'MODEL_NOT_FOUND',
  'MODEL_ACCESS_DENIED',
  'MODEL_VIDEO_UNSUPPORTED',
  'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED',
  'BILLING_REQUIRED',
  'RATE_LIMIT_EXCEEDED',
  'QUOTA_EXCEEDED',
  'VIDEO_PROCESSING_FAILED',
  'VIDEO_PROCESSING_TIMEOUT',
  'INFERENCE_TIMEOUT',
  'UPSTREAM_SERVICE_UNAVAILABLE',
  'INVALID_MODEL_RESPONSE',
  'AI_RESPONSE_SCHEMA_INVALID',
  'AI_RESPONSE_ENUM_INVALID',
  'AI_RESPONSE_REPAIR_FAILED',
]);

const NEVER_FAILOVER_ERROR_CODES = new Set<GeminiErrorCode>([
  'INVALID_API_KEY',
  'API_KEY_REVOKED',
  'DATABASE_CONSTRAINT_VIOLATION',
  'DATABASE_PERSISTENCE_FAILED',
  'ANALYSIS_CANCELLED',
  'ANALYSIS_INTERRUPTED',
]);

export function isFailoverEligibleErrorCode(code: GeminiErrorCode): boolean {
  if (NEVER_FAILOVER_ERROR_CODES.has(code)) return false;
  return FAILOVER_ELIGIBLE_ERROR_CODES.has(code);
}

function mapHealthRow(r: Record<string, unknown>): ModelHealthRecord {
  const rawCooldown = r.cooldown_until ? String(r.cooldown_until) : null;
  let status = String(r.status ?? 'healthy') as ModelHealthStatus;
  if (status === 'cooldown' && rawCooldown && Date.parse(rawCooldown) <= Date.now()) {
    status = 'degraded';
  }
  return {
    modelId: String(r.model_id),
    capability: String(r.capability) as ModelHealthRecord['capability'],
    stage: String(r.stage ?? 'general'),
    status,
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
    lastSuccessAt: r.last_success_at ? String(r.last_success_at) : null,
    lastFailureAt: r.last_failure_at ? String(r.last_failure_at) : null,
    lastErrorCode: r.last_error_code ? (String(r.last_error_code) as GeminiErrorCode) : null,
    lastErrorMessage: r.last_error_message ? String(r.last_error_message) : null,
    cooldownUntil: rawCooldown,
    updatedAt: String(r.updated_at),
  };
}

export function getModelHealth(
  modelId: string,
  capability?: ModelHealthRecord['capability'],
  stage?: string,
  dbArg?: Database.Database
): ModelHealthRecord[] {
  const db = dbArg ?? getDb();
  const norm = normalizeModelId(modelId);
  if (!norm) return [];

  let sql = 'SELECT * FROM gemini_model_health WHERE model_id = ?';
  const params: unknown[] = [norm];
  if (capability) {
    sql += ' AND capability = ?';
    params.push(capability);
  }
  if (stage) {
    sql += ' AND stage = ?';
    params.push(stage);
  }
  sql += ' ORDER BY updated_at DESC';

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapHealthRow);
}

export function listAllModelHealth(dbArg?: Database.Database): ModelHealthRecord[] {
  const db = dbArg ?? getDb();
  const rows = db
    .prepare('SELECT * FROM gemini_model_health ORDER BY model_id ASC, capability ASC, stage ASC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapHealthRow);
}

export function recordModelSuccess(input: {
  modelId: string;
  capability: ModelHealthRecord['capability'];
  stage?: string;
  db?: Database.Database;
}): ModelHealthRecord {
  const db = input.db ?? getDb();
  const modelId = normalizeModelId(input.modelId);
  const stage = input.stage?.trim() || 'general';
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO gemini_model_health (
      model_id, capability, stage, status, consecutive_failures,
      last_success_at, last_failure_at, last_error_code, last_error_message,
      cooldown_until, updated_at
    ) VALUES (?, ?, ?, 'healthy', 0, ?, NULL, NULL, NULL, NULL, ?)
    ON CONFLICT(model_id, capability, stage) DO UPDATE SET
      status = 'healthy',
      consecutive_failures = 0,
      last_success_at = excluded.last_success_at,
      last_error_code = NULL,
      last_error_message = NULL,
      cooldown_until = NULL,
      updated_at = excluded.updated_at
  `).run(modelId, input.capability, stage, now, now);

  const row = db
    .prepare('SELECT * FROM gemini_model_health WHERE model_id = ? AND capability = ? AND stage = ?')
    .get(modelId, input.capability, stage) as Record<string, unknown>;
  return mapHealthRow(row);
}

export function recordModelFailure(input: {
  modelId: string;
  capability: ModelHealthRecord['capability'];
  stage?: string;
  errorCode: GeminiErrorCode;
  errorMessage: string;
  retryAfterMs?: number | null;
  db?: Database.Database;
}): ModelHealthRecord {
  const db = input.db ?? getDb();
  const modelId = normalizeModelId(input.modelId);
  const stage = input.stage?.trim() || 'general';
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  // Local database/cancellation errors must NEVER penalize a Gemini model's health record
  if (NEVER_FAILOVER_ERROR_CODES.has(input.errorCode)) {
    const existing = getModelHealth(modelId, input.capability, stage, db)[0];
    if (existing) return existing;
    return {
      modelId,
      capability: input.capability,
      stage,
      status: 'healthy',
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      cooldownUntil: null,
      updatedAt: now,
    };
  }

  const prev = db
    .prepare('SELECT * FROM gemini_model_health WHERE model_id = ? AND capability = ? AND stage = ?')
    .get(modelId, input.capability, stage) as Record<string, unknown> | undefined;

  const prevFailures = prev ? Number(prev.consecutive_failures ?? 0) : 0;
  const nextFailures = prevFailures + 1;

  let nextStatus: ModelHealthStatus;
  let cooldownUntil: string | null = null;

  if (UNSUPPORTED_MODEL_ERROR_CODES.has(input.errorCode)) {
    nextStatus = 'unsupported';
    cooldownUntil = new Date(nowMs + 15 * 60 * 1000).toISOString();
  } else if (nextFailures >= 2 || input.errorCode === 'RATE_LIMIT_EXCEEDED' || input.errorCode === 'QUOTA_EXCEEDED') {
    nextStatus = 'cooldown';
    const stepIdx = Math.min(COOLDOWN_STEPS_MS.length - 1, Math.max(0, nextFailures - 2));
    const cooldownMs = Math.max(COOLDOWN_STEPS_MS[stepIdx], input.retryAfterMs ?? 0);
    cooldownUntil = new Date(nowMs + cooldownMs).toISOString();
  } else {
    nextStatus = 'degraded';
  }

  db.prepare(`
    INSERT INTO gemini_model_health (
      model_id, capability, stage, status, consecutive_failures,
      last_success_at, last_failure_at, last_error_code, last_error_message,
      cooldown_until, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(model_id, capability, stage) DO UPDATE SET
      status = excluded.status,
      consecutive_failures = excluded.consecutive_failures,
      last_failure_at = excluded.last_failure_at,
      last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message,
      cooldown_until = excluded.cooldown_until,
      updated_at = excluded.updated_at
  `).run(
    modelId,
    input.capability,
    stage,
    nextStatus,
    nextFailures,
    now,
    input.errorCode,
    input.errorMessage.slice(0, 300),
    cooldownUntil,
    now
  );

  const row = db
    .prepare('SELECT * FROM gemini_model_health WHERE model_id = ? AND capability = ? AND stage = ?')
    .get(modelId, input.capability, stage) as Record<string, unknown>;
  return mapHealthRow(row);
}

export function isModelUnavailableByHealth(
  modelId: string,
  capability: ModelHealthRecord['capability'],
  stage?: string,
  dbArg?: Database.Database
): { unavailable: boolean; reason: string | null; cooldownUntil: string | null } {
  const records = getModelHealth(modelId, undefined, undefined, dbArg).filter(
    (r) =>
      r.capability === capability ||
      (capability === 'video' && (r.capability === 'files_api_video' || r.capability === 'inline_video'))
  );
  const relevant = stage
    ? records.filter((r) => r.stage === stage || r.stage === 'general')
    : records;

  const nowMs = Date.now();
  for (const r of relevant) {
    if (r.status === 'unsupported') {
      return {
        unavailable: true,
        reason: r.lastErrorMessage ?? `${modelId} is marked unsupported for ${capability}.`,
        cooldownUntil: r.cooldownUntil,
      };
    }
    if (r.status === 'cooldown' && r.cooldownUntil && Date.parse(r.cooldownUntil) > nowMs) {
      return {
        unavailable: true,
        reason: `${modelId} is in health cooldown until ${r.cooldownUntil} (${r.lastErrorCode ?? 'transient failure'}).`,
        cooldownUntil: r.cooldownUntil,
      };
    }
  }
  return { unavailable: false, reason: null, cooldownUntil: null };
}

export function resetModelHealth(modelId?: string, dbArg?: Database.Database): number {
  const db = dbArg ?? getDb();
  if (modelId && modelId.trim()) {
    const info = db
      .prepare('DELETE FROM gemini_model_health WHERE model_id = ?')
      .run(normalizeModelId(modelId));
    return info.changes;
  }
  const info = db.prepare('DELETE FROM gemini_model_health').run();
  return info.changes;
}

// ============================================================
// Adaptive Model Failover Selection
// ============================================================

export interface FailoverCandidateDecision {
  selectedModelId: string | null;
  costDeltaAuthorized: boolean;
  skippedCandidates: Array<{ modelId: string; reason: string }>;
}

function estimateRelativeModelCost(
  modelId: string,
  catalogById: Map<string, GeminiModelCapability>
): number {
  const cap = catalogById.get(modelId);
  if (cap && typeof cap.estimatedInputPricePer1MTokensUsd === 'number') {
    return cap.estimatedInputPricePer1MTokensUsd + (cap.estimatedOutputPricePer1MTokensUsd ?? 0) * 0.25;
  }
  const lower = modelId.toLowerCase();
  if (lower.includes('flash-lite')) return 0.15;
  if (lower.includes('flash')) return 0.4;
  if (lower.includes('pro')) return 2.5;
  return 0.6;
}

export function selectFailoverCandidate(input: {
  failedModelId: string;
  triedModelIds: Set<string>;
  stage: string;
  capability: 'video' | 'synthesis' | CapabilityProbeType;
  errorCode: GeminiErrorCode;
  aiSettings: AiSettings;
  discoveredModels: GeminiModelCapability[];
  db?: Database.Database;
}): FailoverCandidateDecision {
  const skippedCandidates: Array<{ modelId: string; reason: string }> = [];

  if (!input.aiSettings.autoFailoverEnabled) {
    return { selectedModelId: null, costDeltaAuthorized: false, skippedCandidates };
  }

  if (!isFailoverEligibleErrorCode(input.errorCode)) {
    return { selectedModelId: null, costDeltaAuthorized: false, skippedCandidates };
  }

  const catalogById = new Map<string, GeminiModelCapability>();
  for (const m of input.discoveredModels) {
    catalogById.set(normalizeModelId(m.modelId), m);
  }

  const failedNorm = normalizeModelId(input.failedModelId);
  const baseCost = estimateRelativeModelCost(failedNorm, catalogById);

  // Ordered candidate pool:
  // 1. User-configured explicit fallbackModelChain
  // 2. Other configured stage models (quick/balanced/deep/synthesis/primary)
  // 3. Discovered healthy models from the user's API key (preferring verified video/text models)
  const rawPool: string[] = [];
  const pushUnique = (id?: string | null) => {
    const norm = normalizeModelId(id);
    if (!norm || norm === failedNorm || input.triedModelIds.has(norm) || rawPool.includes(norm)) return;
    rawPool.push(norm);
  };

  for (const id of input.aiSettings.fallbackModelChain ?? []) {
    pushUnique(id);
  }
  pushUnique(input.aiSettings.modelId);
  pushUnique(input.aiSettings.quickAnalysisModelId);
  pushUnique(input.aiSettings.balancedAnalysisModelId);
  pushUnique(input.aiSettings.deepAnalysisModelId);
  pushUnique(input.aiSettings.tacticalSynthesisModelId);

  // Add discovered models sorted by verified status & comparable cost
  const discoveredSorted = [...input.discoveredModels]
    .filter((m) => m.accessStatus !== 'inaccessible' && m.accessStatus !== 'unsupported')
    .sort((a, b) => {
      const aScore = (a.filesApiVideoVerified ? 4 : 0) + (a.inlineVideoVerified ? 2 : 0) + (a.textVerified ? 1 : 0);
      const bScore = (b.filesApiVideoVerified ? 4 : 0) + (b.inlineVideoVerified ? 2 : 0) + (b.textVerified ? 1 : 0);
      return bScore - aScore;
    });
  for (const m of discoveredSorted) {
    pushUnique(m.modelId);
  }

  for (const candidate of rawPool) {
    if (isDeprecatedGeminiModelId(candidate)) {
      skippedCandidates.push({ modelId: candidate, reason: 'Deprecated model ID' });
      continue;
    }

    const cap = catalogById.get(candidate);
    if (cap) {
      if (cap.accessStatus === 'inaccessible' || cap.accessStatus === 'unsupported') {
        skippedCandidates.push({ modelId: candidate, reason: `Access status is ${cap.accessStatus}` });
        continue;
      }
      if ((input.capability === 'video' || input.capability === 'files_api_video') && !cap.supportsVideoInput) {
        skippedCandidates.push({ modelId: candidate, reason: 'Model does not support video input' });
        continue;
      }
    }

    const healthCheck = isModelUnavailableByHealth(candidate, input.capability, input.stage, input.db);
    if (healthCheck.unavailable) {
      skippedCandidates.push({
        modelId: candidate,
        reason: healthCheck.reason ?? 'Model currently in cooldown or unsupported',
      });
      continue;
    }

    const candidateCost = estimateRelativeModelCost(candidate, catalogById);
    const isHigherCost = candidateCost > baseCost * 1.25;
    if (isHigherCost && !input.aiSettings.allowHigherCostFailover) {
      skippedCandidates.push({
        modelId: candidate,
        reason: 'Skipped higher-cost model because allowHigherCostFailover is disabled',
      });
      continue;
    }

    return {
      selectedModelId: candidate,
      costDeltaAuthorized: !isHigherCost || Boolean(input.aiSettings.allowHigherCostFailover),
      skippedCandidates,
    };
  }

  return { selectedModelId: null, costDeltaAuthorized: false, skippedCandidates };
}
