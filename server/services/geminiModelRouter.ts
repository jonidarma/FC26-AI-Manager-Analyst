import type {
  AiSettings,
  EffectiveModelRouting,
  VideoAnalysisMode,
} from '../../src/types/domain.ts';

/**
 * Deprecated / legacy Gemini model prefixes that must never be silently selected
 * or offered as production defaults.
 */
const DEPRECATED_MODEL_PATTERNS = [
  /^gemini-1\.0/i,
  /^gemini-1\.5/i,
  /^gemini-2\.0/i,
  /^gemini-pro$/i,
  /^gemini-pro-vision$/i,
];

/**
 * Known non-generative or non-video-multimodal model patterns filtered out of
 * video analysis model selection.
 */
const NON_MULTIMODAL_VIDEO_PATTERNS = [
  /embedding/i,
  /^imagen-/i,
  /^veo-/i,
  /^aqa$/i,
  /^lyria-/i,
  /tts/i,
  /native-audio/i,
  /computer-use/i,
  /image-generation/i,
];

export function normalizeModelId(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^models\//i, '');
}

export function isDeprecatedGeminiModelId(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return false;
  return DEPRECATED_MODEL_PATTERNS.some((re) => re.test(normalized));
}

export function isLikelyVideoCapableModelId(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return false;
  if (!normalized.toLowerCase().startsWith('gemini')) return false;
  if (isDeprecatedGeminiModelId(normalized)) return false;
  if (NON_MULTIMODAL_VIDEO_PATTERNS.some((re) => re.test(normalized))) return false;
  return true;
}

/**
 * Single authoritative model router shared by:
 * - Settings UI & Effective Model Routing preview
 * - Match Capture pre-launch preview
 * - Half-Time Briefing pre-launch preview
 * - Preflight validation
 * - AI Analysis Orchestrator job creation
 *
 * Guarantees:
 * 1. Never silently falls back to an unverified/inaccessible hardcoded model ID
 *    such as 'gemini-4-hydrogen'.
 * 2. When `usePrimaryModelForAllStages` is true, ALL stages resolve strictly to `primaryModelId`.
 * 3. When `usePrimaryModelForAllStages` is false, any empty stage override inherits `primaryModelId`.
 */
export function resolveEffectiveModelRouting(
  aiSettings: AiSettings,
  analysisModeOverride?: VideoAnalysisMode
): EffectiveModelRouting {
  const analysisMode: VideoAnalysisMode =
    analysisModeOverride ?? aiSettings.defaultAnalysisMode ?? 'balanced';
  const primaryModelId = normalizeModelId(aiSettings.modelId);
  const usePrimaryModelForAllStages = Boolean(aiSettings.usePrimaryModelForAllStages);
  const warnings: string[] = [];

  if (!primaryModelId) {
    warnings.push(
      'Primary Default Model is not configured. Select a verified Gemini model in Settings -> AI & Evidence Policy.'
    );
  } else if (isDeprecatedGeminiModelId(primaryModelId)) {
    warnings.push(
      `Primary model "${primaryModelId}" is deprecated. Refresh available models and choose an active Gemini model.`
    );
  }

  const pickStageModel = (stageOverride: string | undefined, stageLabel: string): string => {
    if (usePrimaryModelForAllStages) {
      return primaryModelId;
    }
    const normalizedOverride = normalizeModelId(stageOverride);
    if (!normalizedOverride) {
      return primaryModelId;
    }
    if (isDeprecatedGeminiModelId(normalizedOverride)) {
      warnings.push(
        `${stageLabel} model "${normalizedOverride}" is deprecated. Select an active Gemini model.`
      );
    }
    return normalizedOverride;
  };

  const quickVideoModelId = pickStageModel(aiSettings.quickAnalysisModelId, 'Quick Mode');
  const balancedVideoModelId = pickStageModel(aiSettings.balancedAnalysisModelId, 'Balanced Mode');
  const deepVideoModelId = pickStageModel(aiSettings.deepAnalysisModelId, 'Deep Mode');
  const synthesisModelId = pickStageModel(aiSettings.tacticalSynthesisModelId, 'Tactical Synthesis');

  const effectiveVideoModelId =
    analysisMode === 'deep'
      ? deepVideoModelId
      : analysisMode === 'balanced'
        ? balancedVideoModelId
        : quickVideoModelId;

  const classificationModelId = effectiveVideoModelId;
  const effectiveSynthesisModelId = synthesisModelId;
  const comparisonModelId = effectiveSynthesisModelId;

  return {
    analysisMode,
    usePrimaryModelForAllStages,
    primaryModelId,
    classificationModelId,
    quickVideoModelId,
    balancedVideoModelId,
    deepVideoModelId,
    synthesisModelId,
    comparisonModelId,
    effectiveVideoModelId,
    effectiveSynthesisModelId,
    routingSource: usePrimaryModelForAllStages ? 'primary_override' : 'stage_specific',
    warnings,
  };
}
