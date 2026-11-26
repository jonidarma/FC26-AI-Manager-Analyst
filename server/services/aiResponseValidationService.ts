import type {
  AiGameplayObservationRecord,
  AiHalftimeBriefingPayload,
  AiSecondHalfComparisonPayload,
  AiTacticalRecommendationRecord,
  AiTacticalVisionAssessmentRecord,
  ConfidenceLevel,
  GeminiErrorCode,
  ObservationEvidenceType,
  RecommendationPriorityGroup,
  TacticalVisionKey,
  ValidationAuditSummary,
  ValidationFieldNormalization,
  ValidationRejectedItem,
  VideoContentType,
} from '../../src/types/domain.ts';
import type { RawAiRecommendationInput } from './analysisValidationService.ts';
import type {
  SecondHalfComparisonOutput,
  TacticalSynthesisOutput,
  VideoClassificationOutput,
  VideoObservationOutput,
} from './geminiVideoService.ts';

// ============================================================
// Canonical Enum Constants (strictly matching SQLite CHECK constraints)
// ============================================================

export const CANONICAL_CONFIDENCE_LEVELS = ['High', 'Medium', 'Low'] as const;

export const CANONICAL_VIDEO_CONTENT_TYPES = [
  'live_gameplay',
  'set_piece',
  'replay',
  'cutscene',
  'pre_match_menu',
  'tactical_setup',
  'squad_management',
  'pause_menu',
  'halftime_statistics',
  'fulltime_statistics',
  'loading_screen',
  'non_game_content',
  'obscured_or_black_screen',
  'unknown',
] as const satisfies readonly VideoContentType[];

export const CANONICAL_CATEGORY_GROUPS = [
  'attacking',
  'defensive',
  'possession',
  'match_events',
] as const;

export const CANONICAL_TEAM_ATTRIBUTIONS = [
  'user_team',
  'opponent',
  'both',
  'unknown',
] as const;

export const CANONICAL_EVIDENCE_TYPES = [
  'directly_observed',
  'hud_or_statistics_screen',
  'user_confirmed',
  'tactical_inference',
  'master_database_attribute',
] as const satisfies readonly ObservationEvidenceType[];

export const CANONICAL_SEVERITY_LEVELS = [
  'Critical',
  'High',
  'Medium',
  'Low',
  'Positive',
] as const;

export const CANONICAL_EVIDENCE_QUALITIES = [
  'high',
  'moderate',
  'limited',
  'insufficient',
] as const;

export const CANONICAL_RECOMMENDATION_STANCES = [
  'retain_and_refine',
  'adapt_vision',
  'insufficient_evidence',
] as const;

export const CANONICAL_CRITERIA_ASSESSMENTS = [
  'strong',
  'mixed',
  'weak',
  'unknown',
] as const;

export const CANONICAL_PRIORITY_GROUPS = [
  'immediate_correction',
  'player_change',
  'structural_adjustment',
  'gameplay_coaching',
  'contingency_plan',
] as const satisfies readonly RecommendationPriorityGroup[];

export const CANONICAL_ACTION_TYPES = [
  'build_up_style',
  'defensive_approach',
  'defensive_line_height',
  'player_role',
  'player_focus',
  'substitution',
  'formation_change',
  'tactical_vision_change',
  'gameplay_coaching',
  'contingency_rule',
] as const satisfies readonly AiTacticalRecommendationRecord['actionType'][];

export const CANONICAL_OUTCOME_ASSESSMENTS = [
  'improved',
  'unchanged',
  'worsened',
  'insufficient_evidence',
] as const;

// ============================================================
// Structured Validation Error & Audit Helpers
// ============================================================

export class AiResponseValidationError extends Error {
  public readonly code: GeminiErrorCode;
  public readonly errorDomain = 'ai_validation' as const;
  public readonly stage: string;
  public readonly fieldName: string | null;
  public readonly expectedValues: string[] | null;
  public readonly receivedValuePreview: string | null;
  public readonly rejectedItems: ValidationRejectedItem[];

  constructor(params: {
    code:
      | 'AI_RESPONSE_SCHEMA_INVALID'
      | 'AI_RESPONSE_ENUM_INVALID'
      | 'AI_RESPONSE_REPAIR_FAILED'
      | 'ANALYSIS_STAGE_VALIDATION_FAILED';
    message: string;
    stage: string;
    fieldName?: string | null;
    expectedValues?: readonly string[] | null;
    receivedValuePreview?: string | null;
    rejectedItems?: ValidationRejectedItem[];
  }) {
    super(params.message);
    this.name = 'AiResponseValidationError';
    this.code = params.code;
    this.stage = params.stage;
    this.fieldName = params.fieldName ?? null;
    this.expectedValues = params.expectedValues ? [...params.expectedValues] : null;
    this.receivedValuePreview = params.receivedValuePreview ?? null;
    this.rejectedItems = params.rejectedItems ?? [];
  }
}

export function isAiResponseValidationError(err: unknown): err is AiResponseValidationError {
  return err instanceof AiResponseValidationError;
}

export function createEmptyValidationAuditSummary(): ValidationAuditSummary {
  return {
    totalValidatedItems: 0,
    validItemsCount: 0,
    rejectedItemsCount: 0,
    repairedAttemptsCount: 0,
    normalizedFields: [],
    rejectedItems: [],
    warnings: [],
    databaseErrors: [],
  };
}

export function mergeValidationAuditSummary(
  target: ValidationAuditSummary,
  delta: Partial<ValidationAuditSummary>
): ValidationAuditSummary {
  target.totalValidatedItems += delta.totalValidatedItems ?? 0;
  target.validItemsCount += delta.validItemsCount ?? 0;
  target.rejectedItemsCount += delta.rejectedItemsCount ?? 0;
  target.repairedAttemptsCount += delta.repairedAttemptsCount ?? 0;
  if (delta.normalizedFields?.length) {
    target.normalizedFields.push(...delta.normalizedFields.slice(0, 60));
    if (target.normalizedFields.length > 120) {
      target.normalizedFields = target.normalizedFields.slice(0, 120);
    }
  }
  if (delta.rejectedItems?.length) {
    target.rejectedItems.push(...delta.rejectedItems.slice(0, 60));
    if (target.rejectedItems.length > 120) {
      target.rejectedItems = target.rejectedItems.slice(0, 120);
    }
  }
  if (delta.warnings?.length) {
    for (const w of delta.warnings) {
      if (!target.warnings.includes(w)) target.warnings.push(w);
    }
  }
  if (delta.databaseErrors?.length) {
    target.databaseErrors.push(...delta.databaseErrors);
  }
  return target;
}

function previewValue(val: unknown): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return val.slice(0, 80);
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try {
    return JSON.stringify(val).slice(0, 80);
  } catch {
    return '[unserializable]';
  }
}

export interface EnumNormalizationResult<T extends string> {
  ok: boolean;
  value?: T;
  normalized: boolean;
  rawPreview: string;
}

// ============================================================
// Safe Enum Normalizers
// ============================================================

/**
 * Safely normalizes Gemini confidence values into exact SQLite canonical enum:
 * 'High' | 'Medium' | 'Low'.
 *
 * Handles:
 * - Case variations ('high', 'HIGH', 'Medium', 'low')
 * - Common unambiguous synonyms ('very high', 'moderate', 'med', 'very low')
 * - Numeric probabilities (0..1) and percentages (0..100 or '85%')
 * Rejects arbitrary/ambiguous strings (never silently guesses).
 */
export function normalizeConfidenceLevel(raw: unknown): EnumNormalizationResult<ConfidenceLevel> {
  const rawPreview = previewValue(raw);

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw >= 0 && raw <= 1) {
      const value: ConfidenceLevel = raw >= 0.75 ? 'High' : raw >= 0.45 ? 'Medium' : 'Low';
      return { ok: true, value, normalized: true, rawPreview };
    }
    if (raw > 1 && raw <= 100) {
      const value: ConfidenceLevel = raw >= 75 ? 'High' : raw >= 45 ? 'Medium' : 'Low';
      return { ok: true, value, normalized: true, rawPreview };
    }
    return { ok: false, normalized: false, rawPreview };
  }

  if (typeof raw !== 'string') {
    return { ok: false, normalized: false, rawPreview };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, normalized: false, rawPreview };
  }

  // Exact canonical match (no normalization needed)
  if (trimmed === 'High' || trimmed === 'Medium' || trimmed === 'Low') {
    return { ok: true, value: trimmed, normalized: false, rawPreview };
  }

  // Numeric string or percentage string ('0.85', '85%', '72')
  const pctMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      const value: ConfidenceLevel = pct >= 75 ? 'High' : pct >= 45 ? 'Medium' : 'Low';
      return { ok: true, value, normalized: true, rawPreview };
    }
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      if (num >= 0 && num <= 1) {
        const value: ConfidenceLevel = num >= 0.75 ? 'High' : num >= 0.45 ? 'Medium' : 'Low';
        return { ok: true, value, normalized: true, rawPreview };
      }
      if (num > 1 && num <= 100) {
        const value: ConfidenceLevel = num >= 75 ? 'High' : num >= 45 ? 'Medium' : 'Low';
        return { ok: true, value, normalized: true, rawPreview };
      }
    }
  }

  const key = trimmed.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  const MAP: Record<string, ConfidenceLevel> = {
    high: 'High',
    'very high': 'High',
    strong: 'High',
    certain: 'High',
    'high confidence': 'High',
    medium: 'Medium',
    med: 'Medium',
    moderate: 'Medium',
    mid: 'Medium',
    'medium confidence': 'Medium',
    'medium high': 'High',
    'medium low': 'Low',
    low: 'Low',
    'very low': 'Low',
    weak: 'Low',
    uncertain: 'Low',
    'low confidence': 'Low',
  };

  const mapped = MAP[key];
  if (mapped) {
    return { ok: true, value: mapped, normalized: true, rawPreview };
  }

  return { ok: false, normalized: false, rawPreview };
}

function normalizeTokenizedEnum<T extends string>(
  raw: unknown,
  canonical: readonly T[],
  aliases: Record<string, T>
): EnumNormalizationResult<T> {
  const rawPreview = previewValue(raw);
  if (typeof raw !== 'string') return { ok: false, normalized: false, rawPreview };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, normalized: false, rawPreview };

  if ((canonical as readonly string[]).includes(trimmed)) {
    return { ok: true, value: trimmed as T, normalized: false, rawPreview };
  }

  const lower = trimmed.toLowerCase();
  const snake = lower.replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');

  for (const c of canonical) {
    if (c.toLowerCase() === lower || c.toLowerCase() === snake) {
      return { ok: true, value: c, normalized: true, rawPreview };
    }
  }

  if (aliases[lower]) {
    return { ok: true, value: aliases[lower], normalized: true, rawPreview };
  }
  if (aliases[snake]) {
    return { ok: true, value: aliases[snake], normalized: true, rawPreview };
  }

  return { ok: false, normalized: false, rawPreview };
}

export function normalizeVideoContentType(raw: unknown): EnumNormalizationResult<VideoContentType> {
  return normalizeTokenizedEnum(raw, CANONICAL_VIDEO_CONTENT_TYPES, {
    gameplay: 'live_gameplay',
    live_match: 'live_gameplay',
    match_play: 'live_gameplay',
    active_gameplay: 'live_gameplay',
    in_play: 'live_gameplay',
    open_play: 'live_gameplay',
    kickoff: 'set_piece',
    free_kick: 'set_piece',
    corner: 'set_piece',
    corner_kick: 'set_piece',
    penalty: 'set_piece',
    throw_in: 'set_piece',
    goal_kick: 'set_piece',
    goal_replay: 'replay',
    instant_replay: 'replay',
    highlight_replay: 'replay',
    celebration: 'cutscene',
    intro: 'cutscene',
    broadcast_cutscene: 'cutscene',
    menu: 'pre_match_menu',
    main_menu: 'pre_match_menu',
    team_management: 'tactical_setup',
    tactics: 'tactical_setup',
    tactics_menu: 'tactical_setup',
    lineup: 'squad_management',
    substitutions: 'squad_management',
    paused: 'pause_menu',
    halftime_stats: 'halftime_statistics',
    half_time_stats: 'halftime_statistics',
    half_time_statistics: 'halftime_statistics',
    fulltime_stats: 'fulltime_statistics',
    full_time_stats: 'fulltime_statistics',
    match_stats: 'halftime_statistics',
    loading: 'loading_screen',
    black_screen: 'obscured_or_black_screen',
    obscured: 'obscured_or_black_screen',
    desktop: 'non_game_content',
    overlay: 'non_game_content',
  });
}

export function normalizeCategoryGroup(
  raw: unknown
): EnumNormalizationResult<'attacking' | 'defensive' | 'possession' | 'match_events'> {
  return normalizeTokenizedEnum(raw, CANONICAL_CATEGORY_GROUPS, {
    attack: 'attacking',
    offense: 'attacking',
    offensive: 'attacking',
    chance_creation: 'attacking',
    defense: 'defensive',
    defending: 'defensive',
    pressing: 'defensive',
    transition: 'defensive',
    build_up: 'possession',
    buildup: 'possession',
    midfield: 'possession',
    progression: 'possession',
    event: 'match_events',
    events: 'match_events',
    match_event: 'match_events',
    set_pieces: 'match_events',
    key_event: 'match_events',
  });
}

export function normalizeTeamAttribution(
  raw: unknown
): EnumNormalizationResult<'user_team' | 'opponent' | 'both' | 'unknown'> {
  return normalizeTokenizedEnum(raw, CANONICAL_TEAM_ATTRIBUTIONS, {
    user: 'user_team',
    player_team: 'user_team',
    our_team: 'user_team',
    home_user: 'user_team',
    managed_team: 'user_team',
    opp: 'opponent',
    opposition: 'opponent',
    opponent_team: 'opponent',
    enemy: 'opponent',
    both_teams: 'both',
    unclear: 'unknown',
    unidentified: 'unknown',
  });
}

export function normalizeEvidenceType(
  raw: unknown
): EnumNormalizationResult<ObservationEvidenceType> {
  return normalizeTokenizedEnum(raw, CANONICAL_EVIDENCE_TYPES, {
    direct_visual: 'directly_observed',
    visual: 'directly_observed',
    visual_observation: 'directly_observed',
    observed: 'directly_observed',
    direct_observation: 'directly_observed',
    hud: 'hud_or_statistics_screen',
    stats_screen: 'hud_or_statistics_screen',
    statistics_screen: 'hud_or_statistics_screen',
    scoreboard: 'hud_or_statistics_screen',
    confirmed: 'user_confirmed',
    inference: 'tactical_inference',
    inferred: 'tactical_inference',
    database: 'master_database_attribute',
    catalog: 'master_database_attribute',
  });
}

export function normalizeSeverityLevel(
  raw: unknown
): EnumNormalizationResult<'Critical' | 'High' | 'Medium' | 'Low' | 'Positive'> {
  return normalizeTokenizedEnum(raw, CANONICAL_SEVERITY_LEVELS, {
    urgent: 'Critical',
    severe: 'Critical',
    major: 'High',
    important: 'High',
    moderate: 'Medium',
    minor: 'Low',
    info: 'Low',
    strength: 'Positive',
    good: 'Positive',
  });
}

export function normalizeEvidenceQuality(
  raw: unknown
): EnumNormalizationResult<'high' | 'moderate' | 'limited' | 'insufficient'> {
  return normalizeTokenizedEnum(raw, CANONICAL_EVIDENCE_QUALITIES, {
    strong: 'high',
    medium: 'moderate',
    fair: 'moderate',
    partial: 'limited',
    low: 'limited',
    none: 'insufficient',
    poor: 'insufficient',
  });
}

export function normalizeRecommendationStance(
  raw: unknown
): EnumNormalizationResult<'retain_and_refine' | 'adapt_vision' | 'insufficient_evidence'> {
  return normalizeTokenizedEnum(raw, CANONICAL_RECOMMENDATION_STANCES, {
    retain: 'retain_and_refine',
    keep: 'retain_and_refine',
    refine: 'retain_and_refine',
    adapt: 'adapt_vision',
    change: 'adapt_vision',
    switch_vision: 'adapt_vision',
    insufficient: 'insufficient_evidence',
    unknown: 'insufficient_evidence',
  });
}

export function normalizeCriteriaAssessment(
  raw: unknown
): EnumNormalizationResult<'strong' | 'mixed' | 'weak' | 'unknown'> {
  return normalizeTokenizedEnum(raw, CANONICAL_CRITERIA_ASSESSMENTS, {
    high: 'strong',
    good: 'strong',
    moderate: 'mixed',
    average: 'mixed',
    partial: 'mixed',
    poor: 'weak',
    low: 'weak',
    unclear: 'unknown',
    insufficient: 'unknown',
  });
}

export function normalizePriorityGroup(
  raw: unknown
): EnumNormalizationResult<RecommendationPriorityGroup> {
  return normalizeTokenizedEnum(raw, CANONICAL_PRIORITY_GROUPS, {
    immediate: 'immediate_correction',
    urgent: 'immediate_correction',
    tactical_correction: 'immediate_correction',
    substitution: 'player_change',
    personnel: 'player_change',
    player_changes: 'player_change',
    structural: 'structural_adjustment',
    formation: 'structural_adjustment',
    coaching: 'gameplay_coaching',
    in_game_coaching: 'gameplay_coaching',
    contingency: 'contingency_plan',
    conditional: 'contingency_plan',
  });
}

export function normalizeActionType(
  raw: unknown
): EnumNormalizationResult<AiTacticalRecommendationRecord['actionType']> {
  return normalizeTokenizedEnum(raw, CANONICAL_ACTION_TYPES, {
    buildup_style: 'build_up_style',
    build_up: 'build_up_style',
    defensive_style: 'defensive_approach',
    line_height: 'defensive_line_height',
    defensive_line: 'defensive_line_height',
    role: 'player_role',
    role_change: 'player_role',
    focus: 'player_focus',
    focus_change: 'player_focus',
    sub: 'substitution',
    player_substitution: 'substitution',
    formation: 'formation_change',
    tactical_vision: 'tactical_vision_change',
    vision_change: 'tactical_vision_change',
    coaching: 'gameplay_coaching',
    contingency: 'contingency_rule',
  });
}

export function normalizeOutcomeAssessment(
  raw: unknown
): EnumNormalizationResult<'improved' | 'unchanged' | 'worsened' | 'insufficient_evidence'> {
  return normalizeTokenizedEnum(raw, CANONICAL_OUTCOME_ASSESSMENTS, {
    better: 'improved',
    positive: 'improved',
    same: 'unchanged',
    neutral: 'unchanged',
    worse: 'worsened',
    regressed: 'worsened',
    unknown: 'insufficient_evidence',
    insufficient: 'insufficient_evidence',
  });
}

// ============================================================
// Stage Validators (Pre-Persistence Gate)
// ============================================================

export interface StageValidationResult<T> {
  valid: boolean;
  data: T | null;
  totalValidatedItems: number;
  validItemsCount: number;
  rejectedItemsCount: number;
  normalizedFields: ValidationFieldNormalization[];
  rejectedItems: ValidationRejectedItem[];
  warnings: string[];
  blockingError: AiResponseValidationError | null;
}

export function validateClassificationStageResponse(
  raw: unknown,
  ctx: { segmentIndex: number; segmentDurationSeconds: number }
): StageValidationResult<Omit<VideoClassificationOutput, 'usage'>> {
  const stage = 'classifying_gameplay';
  const normalizedFields: ValidationFieldNormalization[] = [];
  const rejectedItems: ValidationRejectedItem[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_SCHEMA_INVALID',
      message: 'Classification response must be a JSON object.',
      stage,
      fieldName: 'root',
      receivedValuePreview: previewValue(raw),
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 0,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.segments)) {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_SCHEMA_INVALID',
      message: 'Classification response is missing required "segments" array.',
      stage,
      fieldName: 'segments',
      receivedValuePreview: previewValue(obj.segments),
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 0,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  const validSegments: VideoClassificationOutput['segments'] = [];
  const maxDur = Math.max(0.5, Number(ctx.segmentDurationSeconds) || 0);

  for (let i = 0; i < obj.segments.length; i++) {
    const item = obj.segments[i];
    if (!item || typeof item !== 'object') {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_SCHEMA_INVALID',
        fieldName: 'segments[]',
        expectedValues: null,
        receivedValuePreview: previewValue(item),
        reason: 'Segment classification entry is not an object.',
      });
      continue;
    }

    const rec = item as Record<string, unknown>;
    const rawStart = Number(rec.startSeconds);
    const rawEnd = Number(rec.endSeconds);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart < -2 || rawEnd < rawStart - 0.5) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_SCHEMA_INVALID',
        fieldName: 'startSeconds/endSeconds',
        expectedValues: [`0..${maxDur.toFixed(1)}`],
        receivedValuePreview: `${String(rec.startSeconds)}..${String(rec.endSeconds)}`,
        reason: 'Invalid or inverted classification timestamp window.',
      });
      continue;
    }

    const startSeconds = Math.max(0, Math.min(maxDur, rawStart));
    const endSeconds = Math.max(startSeconds, Math.min(maxDur, rawEnd));

    const contentRes = normalizeVideoContentType(rec.contentType);
    if (!contentRes.ok || !contentRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'contentType',
        expectedValues: [...CANONICAL_VIDEO_CONTENT_TYPES],
        receivedValuePreview: contentRes.rawPreview,
        reason: `Unrecognized contentType "${contentRes.rawPreview}".`,
      });
      continue;
    }
    if (contentRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        fieldName: 'contentType',
        rawPreview: contentRes.rawPreview,
        normalizedValue: contentRes.value,
      });
    }

    const confRes = normalizeConfidenceLevel(rec.confidence);
    if (!confRes.ok || !confRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'confidence',
        expectedValues: [...CANONICAL_CONFIDENCE_LEVELS],
        receivedValuePreview: confRes.rawPreview,
        reason: `Invalid confidence value "${confRes.rawPreview}" (expected High, Medium, or Low).`,
      });
      continue;
    }
    if (confRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        fieldName: 'confidence',
        rawPreview: confRes.rawPreview,
        normalizedValue: confRes.value,
      });
    }

    const evidenceDescription =
      typeof rec.evidenceDescription === 'string' && rec.evidenceDescription.trim()
        ? rec.evidenceDescription.trim()
        : `Classified as ${contentRes.value}.`;

    const inGameClock =
      typeof rec.inGameClock === 'string' && rec.inGameClock.trim()
        ? rec.inGameClock.trim()
        : null;

    validSegments.push({
      startSeconds,
      endSeconds,
      contentType: contentRes.value,
      confidence: confRes.value,
      evidenceDescription,
      inGameClock,
    });
  }

  const rawHud = (obj.readableHudStats && typeof obj.readableHudStats === 'object'
    ? obj.readableHudStats
    : {}) as Record<string, unknown>;
  const rawOther = Array.isArray(rawHud.otherVerifiedStats) ? rawHud.otherVerifiedStats : [];
  const otherVerifiedStats = rawOther
    .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
    .map((s) => ({
      label: String(s.label ?? '').trim(),
      value: String(s.value ?? '').trim(),
      source: 'hud_or_statistics_screen' as const,
    }))
    .filter((s) => s.label.length > 0 && s.value.length > 0);

  const readableHudStats: VideoClassificationOutput['readableHudStats'] = {
    scoreline: typeof rawHud.scoreline === 'string' && rawHud.scoreline.trim() ? rawHud.scoreline.trim() : null,
    matchClock: typeof rawHud.matchClock === 'string' && rawHud.matchClock.trim() ? rawHud.matchClock.trim() : null,
    possessionLabel:
      typeof rawHud.possessionLabel === 'string' && rawHud.possessionLabel.trim()
        ? rawHud.possessionLabel.trim()
        : null,
    shotsLabel: typeof rawHud.shotsLabel === 'string' && rawHud.shotsLabel.trim() ? rawHud.shotsLabel.trim() : null,
    otherVerifiedStats,
  };

  if (obj.segments.length > 0 && validSegments.length === 0) {
    const first = rejectedItems[0];
    const err = new AiResponseValidationError({
      code: first?.code === 'AI_RESPONSE_ENUM_INVALID' ? 'AI_RESPONSE_ENUM_INVALID' : 'AI_RESPONSE_SCHEMA_INVALID',
      message: `All ${obj.segments.length} classification window(s) failed runtime validation: ${first?.reason ?? 'invalid structure'}`,
      stage,
      fieldName: first?.fieldName ?? 'segments',
      expectedValues: first?.expectedValues ?? null,
      receivedValuePreview: first?.receivedValuePreview ?? null,
      rejectedItems,
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: obj.segments.length,
      validItemsCount: 0,
      rejectedItemsCount: rejectedItems.length,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  if (rejectedItems.length > 0) {
    warnings.push(
      `Stage 1 (segment #${ctx.segmentIndex}): rejected ${rejectedItems.length} invalid classification window(s) while preserving ${validSegments.length} valid window(s).`
    );
  }

  return {
    valid: true,
    data: {
      segments: validSegments,
      readableHudStats,
    },
    totalValidatedItems: obj.segments.length,
    validItemsCount: validSegments.length,
    rejectedItemsCount: rejectedItems.length,
    normalizedFields,
    rejectedItems,
    warnings,
    blockingError: null,
  };
}

export function validateObservationStageResponse(
  raw: unknown,
  ctx: { segmentIndex: number; segmentDurationSeconds: number }
): StageValidationResult<Omit<VideoObservationOutput, 'usage'>> {
  const stage = 'analyzing_gameplay';
  const normalizedFields: ValidationFieldNormalization[] = [];
  const rejectedItems: ValidationRejectedItem[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_SCHEMA_INVALID',
      message: 'Observation response must be a JSON object.',
      stage,
      fieldName: 'root',
      receivedValuePreview: previewValue(raw),
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 0,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.observations)) {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_SCHEMA_INVALID',
      message: 'Observation response is missing required "observations" array.',
      stage,
      fieldName: 'observations',
      receivedValuePreview: previewValue(obj.observations),
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 0,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  const validObs: VideoObservationOutput['observations'] = [];
  const maxDur = Math.max(0.5, Number(ctx.segmentDurationSeconds) || 0);

  for (let i = 0; i < obj.observations.length; i++) {
    const item = obj.observations[i];
    if (!item || typeof item !== 'object') {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_SCHEMA_INVALID',
        fieldName: 'observations[]',
        expectedValues: null,
        receivedValuePreview: previewValue(item),
        reason: 'Observation entry is not an object.',
      });
      continue;
    }

    const rec = item as Record<string, unknown>;
    const rawStart = Number(rec.startSeconds);
    const rawEnd = Number(rec.endSeconds);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart < 0 || rawEnd < rawStart || rawStart > maxDur + 2) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_SCHEMA_INVALID',
        fieldName: 'startSeconds/endSeconds',
        expectedValues: [`0..${maxDur.toFixed(1)}`],
        receivedValuePreview: `${String(rec.startSeconds)}..${String(rec.endSeconds)}`,
        reason: 'Observation timestamp is out of segment bounds.',
      });
      continue;
    }

    const catRes = normalizeCategoryGroup(rec.categoryGroup);
    if (!catRes.ok || !catRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'categoryGroup',
        expectedValues: [...CANONICAL_CATEGORY_GROUPS],
        receivedValuePreview: catRes.rawPreview,
        reason: `Invalid categoryGroup "${catRes.rawPreview}".`,
      });
      continue;
    }
    if (catRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        fieldName: 'categoryGroup',
        rawPreview: catRes.rawPreview,
        normalizedValue: catRes.value,
      });
    }

    const teamRes = normalizeTeamAttribution(rec.teamAttribution);
    if (!teamRes.ok || !teamRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'teamAttribution',
        expectedValues: [...CANONICAL_TEAM_ATTRIBUTIONS],
        receivedValuePreview: teamRes.rawPreview,
        reason: `Invalid teamAttribution "${teamRes.rawPreview}".`,
      });
      continue;
    }
    if (teamRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        fieldName: 'teamAttribution',
        rawPreview: teamRes.rawPreview,
        normalizedValue: teamRes.value,
      });
    }

    const evRes = normalizeEvidenceType(rec.evidenceType);
    if (!evRes.ok || !evRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'evidenceType',
        expectedValues: [...CANONICAL_EVIDENCE_TYPES],
        receivedValuePreview: evRes.rawPreview,
        reason: `Invalid evidenceType "${evRes.rawPreview}".`,
      });
      continue;
    }
    if (evRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        fieldName: 'evidenceType',
        rawPreview: evRes.rawPreview,
        normalizedValue: evRes.value,
      });
    }

    const confRes = normalizeConfidenceLevel(rec.confidence);
    if (!confRes.ok || !confRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'confidence',
        expectedValues: [...CANONICAL_CONFIDENCE_LEVELS],
        receivedValuePreview: confRes.rawPreview,
        reason: `Invalid confidence "${confRes.rawPreview}".`,
      });
      continue;
    }
    if (confRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        fieldName: 'confidence',
        rawPreview: confRes.rawPreview,
        normalizedValue: confRes.value,
      });
    }

    const sevRes = normalizeSeverityLevel(rec.severity);
    if (!sevRes.ok || !sevRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'severity',
        expectedValues: [...CANONICAL_SEVERITY_LEVELS],
        receivedValuePreview: sevRes.rawPreview,
        reason: `Invalid severity "${sevRes.rawPreview}".`,
      });
      continue;
    }
    if (sevRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        fieldName: 'severity',
        rawPreview: sevRes.rawPreview,
        normalizedValue: sevRes.value,
      });
    }

    const description = typeof rec.description === 'string' ? rec.description.trim() : '';
    const supportingVisualEvidence =
      typeof rec.supportingVisualEvidence === 'string' ? rec.supportingVisualEvidence.trim() : '';
    if (!description) {
      rejectedItems.push({
        stage,
        segmentIndex: ctx.segmentIndex,
        itemIndex: i,
        code: 'AI_RESPONSE_SCHEMA_INVALID',
        fieldName: 'description',
        expectedValues: null,
        receivedValuePreview: previewValue(rec.description),
        reason: 'Observation description must be a non-empty string.',
      });
      continue;
    }

    validObs.push({
      startSeconds: Math.max(0, Math.min(maxDur, rawStart)),
      endSeconds: Math.max(Math.max(0, Math.min(maxDur, rawStart)), Math.min(maxDur, rawEnd)),
      inGameClock: typeof rec.inGameClock === 'string' && rec.inGameClock.trim() ? rec.inGameClock.trim() : null,
      categoryGroup: catRes.value,
      category:
        typeof rec.category === 'string' && rec.category.trim() ? rec.category.trim() : catRes.value,
      teamAttribution: teamRes.value,
      playerAttribution:
        typeof rec.playerAttribution === 'string' && rec.playerAttribution.trim()
          ? rec.playerAttribution.trim()
          : 'Unknown',
      description,
      supportingVisualEvidence: supportingVisualEvidence || description,
      evidenceType: evRes.value,
      confidence: confRes.value,
      severity: sevRes.value,
      limitations: typeof rec.limitations === 'string' ? rec.limitations.trim() : '',
      isFromReplay: Boolean(rec.isFromReplay),
    });
  }

  if (obj.observations.length > 0 && validObs.length === 0) {
    const first = rejectedItems[0];
    const err = new AiResponseValidationError({
      code: first?.code === 'AI_RESPONSE_ENUM_INVALID' ? 'AI_RESPONSE_ENUM_INVALID' : 'AI_RESPONSE_SCHEMA_INVALID',
      message: `All ${obj.observations.length} gameplay observation(s) failed validation: ${first?.reason ?? 'invalid fields'}`,
      stage,
      fieldName: first?.fieldName ?? 'observations',
      expectedValues: first?.expectedValues ?? null,
      receivedValuePreview: first?.receivedValuePreview ?? null,
      rejectedItems,
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: obj.observations.length,
      validItemsCount: 0,
      rejectedItemsCount: rejectedItems.length,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  if (rejectedItems.length > 0) {
    warnings.push(
      `Stage 2 (segment #${ctx.segmentIndex}): rejected ${rejectedItems.length} invalid observation(s) while keeping ${validObs.length} valid observation(s).`
    );
  }

  return {
    valid: true,
    data: { observations: validObs },
    totalValidatedItems: obj.observations.length,
    validItemsCount: validObs.length,
    rejectedItemsCount: rejectedItems.length,
    normalizedFields,
    rejectedItems,
    warnings,
    blockingError: null,
  };
}

export function validateSynthesisStageResponse(
  raw: unknown
): StageValidationResult<Omit<TacticalSynthesisOutput, 'usage'>> {
  const stage = 'generating_briefing';
  const normalizedFields: ValidationFieldNormalization[] = [];
  const rejectedItems: ValidationRejectedItem[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_SCHEMA_INVALID',
      message: 'Tactical synthesis response must be a JSON object.',
      stage,
      fieldName: 'root',
      receivedValuePreview: previewValue(raw),
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 0,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  const obj = raw as Record<string, unknown>;
  const eqRes = normalizeEvidenceQuality(obj.evidenceQuality);
  if (!eqRes.ok || !eqRes.value) {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_ENUM_INVALID',
      message: `Invalid evidenceQuality "${eqRes.rawPreview}".`,
      stage,
      fieldName: 'evidenceQuality',
      expectedValues: [...CANONICAL_EVIDENCE_QUALITIES],
      receivedValuePreview: eqRes.rawPreview,
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 1,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }
  if (eqRes.normalized) {
    normalizedFields.push({
      stage,
      segmentIndex: null,
      itemIndex: null,
      fieldName: 'evidenceQuality',
      rawPreview: eqRes.rawPreview,
      normalizedValue: eqRes.value,
    });
  }

  const mv = (obj.managerVerdict && typeof obj.managerVerdict === 'object'
    ? obj.managerVerdict
    : null) as Record<string, unknown> | null;
  if (!mv) {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_SCHEMA_INVALID',
      message: 'Tactical synthesis response is missing managerVerdict object.',
      stage,
      fieldName: 'managerVerdict',
      receivedValuePreview: previewValue(obj.managerVerdict),
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 1,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  const managerVerdict: AiHalftimeBriefingPayload['managerVerdict'] = {
    whatIsWorking: Array.isArray(mv.whatIsWorking)
      ? mv.whatIsWorking.map((s) => String(s).trim()).filter(Boolean)
      : [],
    whatIsNotWorking: Array.isArray(mv.whatIsNotWorking)
      ? mv.whatIsNotWorking.map((s) => String(s).trim()).filter(Boolean)
      : [],
    whyTacticStruggling: typeof mv.whyTacticStruggling === 'string' ? mv.whyTacticStruggling.trim() : '',
    firstPriorityChange: typeof mv.firstPriorityChange === 'string' ? mv.firstPriorityChange.trim() : '',
    conciseSummary: typeof mv.conciseSummary === 'string' ? mv.conciseSummary.trim() : '',
  };

  const va = (obj.visionAssessment && typeof obj.visionAssessment === 'object'
    ? obj.visionAssessment
    : null) as Record<string, unknown> | null;
  if (!va) {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_SCHEMA_INVALID',
      message: 'Tactical synthesis response is missing visionAssessment object.',
      stage,
      fieldName: 'visionAssessment',
      receivedValuePreview: previewValue(obj.visionAssessment),
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 1,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  const stanceRes = normalizeRecommendationStance(va.recommendationStance);
  if (!stanceRes.ok || !stanceRes.value) {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_ENUM_INVALID',
      message: `Invalid visionAssessment.recommendationStance "${stanceRes.rawPreview}".`,
      stage,
      fieldName: 'visionAssessment.recommendationStance',
      expectedValues: [...CANONICAL_RECOMMENDATION_STANCES],
      receivedValuePreview: stanceRes.rawPreview,
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 1,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }
  if (stanceRes.normalized) {
    normalizedFields.push({
      stage,
      segmentIndex: null,
      itemIndex: null,
      fieldName: 'visionAssessment.recommendationStance',
      rawPreview: stanceRes.rawPreview,
      normalizedValue: stanceRes.value,
    });
  }

  const vaConfRes = normalizeConfidenceLevel(va.confidence);
  if (!vaConfRes.ok || !vaConfRes.value) {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_ENUM_INVALID',
      message: `Invalid visionAssessment.confidence "${vaConfRes.rawPreview}".`,
      stage,
      fieldName: 'visionAssessment.confidence',
      expectedValues: [...CANONICAL_CONFIDENCE_LEVELS],
      receivedValuePreview: vaConfRes.rawPreview,
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 1,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }
  if (vaConfRes.normalized) {
    normalizedFields.push({
      stage,
      segmentIndex: null,
      itemIndex: null,
      fieldName: 'visionAssessment.confidence',
      rawPreview: vaConfRes.rawPreview,
      normalizedValue: vaConfRes.value,
    });
  }

  const rawObsStyle =
    va.observedPlayingStyle && typeof va.observedPlayingStyle === 'object'
      ? (va.observedPlayingStyle as Record<string, unknown>)
      : {
          primaryTendency: typeof va.observedPlayingStyle === 'string' ? va.observedPlayingStyle : 'Unknown',
          mixedTendencies: [],
          evidenceSummary: '',
          isInsufficientEvidence: eqRes.value === 'insufficient',
        };

  const criteriaBreakdown: AiTacticalVisionAssessmentRecord['criteriaBreakdown'] = [];
  if (Array.isArray(va.criteriaBreakdown)) {
    for (let i = 0; i < va.criteriaBreakdown.length; i++) {
      const item = va.criteriaBreakdown[i];
      if (!item || typeof item !== 'object') continue;
      const cr = item as Record<string, unknown>;
      const aRes = normalizeCriteriaAssessment(cr.assessment);
      if (aRes.ok && aRes.value) {
        if (aRes.normalized) {
          normalizedFields.push({
            stage,
            segmentIndex: null,
            itemIndex: i,
            fieldName: 'visionAssessment.criteriaBreakdown.assessment',
            rawPreview: aRes.rawPreview,
            normalizedValue: aRes.value,
          });
        }
        criteriaBreakdown.push({
          criterion: String(cr.criterion ?? '').trim() || `Criterion ${i + 1}`,
          assessment: aRes.value,
          evidenceNote: String(cr.evidenceNote ?? '').trim(),
        });
      }
    }
  }

  const rawScore = va.internalAssessmentScore;
  const internalAssessmentScore =
    typeof rawScore === 'number' && Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, Math.round(rawScore)))
      : null;

  const rawRecs = Array.isArray(obj.recommendations) ? obj.recommendations : [];
  const validRecommendations: RawAiRecommendationInput[] = [];

  for (let i = 0; i < rawRecs.length; i++) {
    const item = rawRecs[i];
    if (!item || typeof item !== 'object') {
      rejectedItems.push({
        stage,
        segmentIndex: null,
        itemIndex: i,
        code: 'AI_RESPONSE_SCHEMA_INVALID',
        fieldName: 'recommendations[]',
        expectedValues: null,
        receivedValuePreview: previewValue(item),
        reason: 'Recommendation entry is not an object.',
      });
      continue;
    }

    const r = item as Record<string, unknown>;
    const pgRes = normalizePriorityGroup(r.priorityGroup);
    if (!pgRes.ok || !pgRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: null,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'recommendations.priorityGroup',
        expectedValues: [...CANONICAL_PRIORITY_GROUPS],
        receivedValuePreview: pgRes.rawPreview,
        reason: `Invalid recommendation priorityGroup "${pgRes.rawPreview}".`,
      });
      continue;
    }
    if (pgRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: null,
        itemIndex: i,
        fieldName: 'recommendations.priorityGroup',
        rawPreview: pgRes.rawPreview,
        normalizedValue: pgRes.value,
      });
    }

    const atRes = normalizeActionType(r.actionType);
    if (!atRes.ok || !atRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: null,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'recommendations.actionType',
        expectedValues: [...CANONICAL_ACTION_TYPES],
        receivedValuePreview: atRes.rawPreview,
        reason: `Invalid recommendation actionType "${atRes.rawPreview}".`,
      });
      continue;
    }
    if (atRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: null,
        itemIndex: i,
        fieldName: 'recommendations.actionType',
        rawPreview: atRes.rawPreview,
        normalizedValue: atRes.value,
      });
    }

    const rcRes = normalizeConfidenceLevel(r.confidence);
    if (!rcRes.ok || !rcRes.value) {
      rejectedItems.push({
        stage,
        segmentIndex: null,
        itemIndex: i,
        code: 'AI_RESPONSE_ENUM_INVALID',
        fieldName: 'recommendations.confidence',
        expectedValues: [...CANONICAL_CONFIDENCE_LEVELS],
        receivedValuePreview: rcRes.rawPreview,
        reason: `Invalid recommendation confidence "${rcRes.rawPreview}".`,
      });
      continue;
    }
    if (rcRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: null,
        itemIndex: i,
        fieldName: 'recommendations.confidence',
        rawPreview: rcRes.rawPreview,
        normalizedValue: rcRes.value,
      });
    }

    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : '';
    if (!title) {
      rejectedItems.push({
        stage,
        segmentIndex: null,
        itemIndex: i,
        code: 'AI_RESPONSE_SCHEMA_INVALID',
        fieldName: 'recommendations.title',
        expectedValues: null,
        receivedValuePreview: previewValue(r.title),
        reason: 'Recommendation title must be a non-empty string.',
      });
      continue;
    }

    const evidenceTimestamps = Array.isArray(r.evidenceTimestamps)
      ? r.evidenceTimestamps
          .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
          .map((t) => ({
            segmentId: typeof t.segmentId === 'string' && t.segmentId.trim() ? t.segmentId.trim() : null,
            startSeconds: Number.isFinite(Number(t.startSeconds)) ? Math.max(0, Number(t.startSeconds)) : 0,
            endSeconds: Number.isFinite(Number(t.endSeconds)) ? Math.max(0, Number(t.endSeconds)) : 0,
            inGameClock: typeof t.inGameClock === 'string' && t.inGameClock.trim() ? t.inGameClock.trim() : null,
          }))
      : [];

    validRecommendations.push({
      priorityGroup: pgRes.value,
      priorityRank: Number.isFinite(Number(r.priorityRank)) ? Math.max(1, Math.round(Number(r.priorityRank))) : i + 1,
      title,
      actionType: atRes.value,
      targetSlotId: typeof r.targetSlotId === 'string' && r.targetSlotId.trim() ? r.targetSlotId.trim() : null,
      targetPositionCode:
        typeof r.targetPositionCode === 'string' && r.targetPositionCode.trim()
          ? r.targetPositionCode.trim()
          : null,
      currentValue: typeof r.currentValue === 'string' ? r.currentValue.trim() : '',
      proposedValue: typeof r.proposedValue === 'string' ? r.proposedValue.trim() : '',
      targetPlayerOutId:
        typeof r.targetPlayerOutId === 'string' && r.targetPlayerOutId.trim() ? r.targetPlayerOutId.trim() : null,
      targetPlayerInId:
        typeof r.targetPlayerInId === 'string' && r.targetPlayerInId.trim() ? r.targetPlayerInId.trim() : null,
      reason: typeof r.reason === 'string' ? r.reason.trim() : '',
      expectedBenefit: typeof r.expectedBenefit === 'string' ? r.expectedBenefit.trim() : '',
      potentialRisk: typeof r.potentialRisk === 'string' ? r.potentialRisk.trim() : '',
      evidenceObservationIds: Array.isArray(r.evidenceObservationIds)
        ? r.evidenceObservationIds.map((id) => String(id).trim()).filter(Boolean)
        : [],
      evidenceTimestamps,
      confidence: rcRes.value,
    });
  }

  if (rawRecs.length > 0 && validRecommendations.length === 0) {
    warnings.push(
      `Stage 3 synthesis: all ${rawRecs.length} AI recommendation(s) had invalid schema/enum fields and were rejected prior to persistence.`
    );
  } else if (rejectedItems.length > 0) {
    warnings.push(
      `Stage 3 synthesis: rejected ${rejectedItems.length} invalid recommendation(s) while preserving ${validRecommendations.length} valid recommendation(s).`
    );
  }

  const gameplayCoaching = Array.isArray(obj.gameplayCoaching)
    ? obj.gameplayCoaching
        .filter((g): g is Record<string, unknown> => Boolean(g && typeof g === 'object'))
        .map((g) => ({
          instruction: String(g.instruction ?? '').trim(),
          triggerSituation: String(g.triggerSituation ?? '').trim(),
          evidenceNote: String(g.evidenceNote ?? '').trim(),
        }))
        .filter((g) => g.instruction.length > 0)
    : [];

  const contingencyPlan = Array.isArray(obj.contingencyPlan)
    ? obj.contingencyPlan
        .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
        .map((c) => ({
          scenario: String(c.scenario ?? '').trim(),
          trigger: String(c.trigger ?? '').trim(),
          tacticalAction: String(c.tacticalAction ?? '').trim(),
        }))
        .filter((c) => c.scenario.length > 0 && c.tacticalAction.length > 0)
    : [];

  const limitations = Array.isArray(obj.limitations)
    ? obj.limitations.map((l) => String(l).trim()).filter(Boolean)
    : [];

  return {
    valid: true,
    data: {
      evidenceQuality: eqRes.value,
      managerVerdict,
      gameplayCoaching,
      contingencyPlan,
      limitations,
      visionAssessment: {
        observedPlayingStyle: {
          primaryTendency: String(rawObsStyle.primaryTendency ?? 'Unspecified').trim(),
          mixedTendencies: Array.isArray(rawObsStyle.mixedTendencies)
            ? rawObsStyle.mixedTendencies.map((t) => String(t).trim()).filter(Boolean)
            : [],
          evidenceSummary: String(rawObsStyle.evidenceSummary ?? '').trim(),
          isInsufficientEvidence: Boolean(rawObsStyle.isInsufficientEvidence),
        },
        recommendedVisionKey: (typeof va.recommendedVisionKey === 'string' && va.recommendedVisionKey.trim()
          ? va.recommendedVisionKey.trim()
          : 'retain_current') as TacticalVisionKey | 'retain_current' | 'unspecified',
        recommendationStance: stanceRes.value,
        recommendationRationale: String(va.recommendationRationale ?? '').trim(),
        executionAssessmentLabel: String(va.executionAssessmentLabel ?? 'Observed').trim(),
        internalAssessmentScore,
        scoreMethodologyNote: String(va.scoreMethodologyNote ?? '').trim(),
        criteriaBreakdown,
        confidence: vaConfRes.value,
        limitations: String(va.limitations ?? '').trim(),
      },
      recommendations: validRecommendations,
    },
    totalValidatedItems: 1 + rawRecs.length,
    validItemsCount: 1 + validRecommendations.length,
    rejectedItemsCount: rejectedItems.length,
    normalizedFields,
    rejectedItems,
    warnings,
    blockingError: null,
  };
}

export function validateComparisonStageResponse(
  raw: unknown
): StageValidationResult<Omit<SecondHalfComparisonOutput, 'usage'>> {
  const stage = 'second_half_comparison';
  const normalizedFields: ValidationFieldNormalization[] = [];
  const rejectedItems: ValidationRejectedItem[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    const err = new AiResponseValidationError({
      code: 'AI_RESPONSE_SCHEMA_INVALID',
      message: 'Second-half comparison response must be a JSON object.',
      stage,
      fieldName: 'root',
      receivedValuePreview: previewValue(raw),
    });
    return {
      valid: false,
      data: null,
      totalValidatedItems: 0,
      validItemsCount: 0,
      rejectedItemsCount: 1,
      normalizedFields,
      rejectedItems,
      warnings,
      blockingError: err,
    };
  }

  const obj = raw as Record<string, unknown>;
  const rawReviews = Array.isArray(obj.appliedAdjustmentsReviewed) ? obj.appliedAdjustmentsReviewed : [];
  const appliedAdjustmentsReviewed: AiSecondHalfComparisonPayload['appliedAdjustmentsReviewed'] = [];

  for (let i = 0; i < rawReviews.length; i++) {
    const item = rawReviews[i];
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const outRes = normalizeOutcomeAssessment(r.outcomeAssessment);
    const outcome = outRes.ok && outRes.value ? outRes.value : 'insufficient_evidence';
    if (outRes.normalized) {
      normalizedFields.push({
        stage,
        segmentIndex: null,
        itemIndex: i,
        fieldName: 'appliedAdjustmentsReviewed.outcomeAssessment',
        rawPreview: outRes.rawPreview,
        normalizedValue: outcome,
      });
    } else if (!outRes.ok) {
      warnings.push(
        `Second-half comparison item #${i + 1}: unrecognized outcomeAssessment "${outRes.rawPreview}" mapped to "insufficient_evidence".`
      );
    }

    appliedAdjustmentsReviewed.push({
      recommendationTitle: String(r.recommendationTitle ?? '').trim() || `Adjustment ${i + 1}`,
      userConfirmedAppliedInGame: Boolean(r.userConfirmedAppliedInGame),
      observedSecondHalfPattern: String(r.observedSecondHalfPattern ?? '').trim(),
      outcomeAssessment: outcome,
      causationCaveat:
        String(r.causationCaveat ?? '').trim() ||
        'Observed pattern correlation only; in-game outcomes also depend on opponent behavior and execution.',
    });
  }

  return {
    valid: true,
    data: {
      summary: String(obj.summary ?? '').trim(),
      appliedAdjustmentsReviewed,
      attackingComparison: String(obj.attackingComparison ?? '').trim(),
      defensiveComparison: String(obj.defensiveComparison ?? '').trim(),
      tacticalVisionComparison: String(obj.tacticalVisionComparison ?? '').trim(),
      recurringWeaknesses: Array.isArray(obj.recurringWeaknesses)
        ? obj.recurringWeaknesses.map((w) => String(w).trim()).filter(Boolean)
        : [],
      limitations: Array.isArray(obj.limitations)
        ? obj.limitations.map((l) => String(l).trim()).filter(Boolean)
        : [],
    },
    totalValidatedItems: 1 + rawReviews.length,
    validItemsCount: 1 + appliedAdjustmentsReviewed.length,
    rejectedItemsCount: rejectedItems.length,
    normalizedFields,
    rejectedItems,
    warnings,
    blockingError: null,
  };
}
