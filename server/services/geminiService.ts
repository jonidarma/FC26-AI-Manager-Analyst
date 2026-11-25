import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPartFromUri, GoogleGenAI, Type } from '@google/genai';
import type Database from 'better-sqlite3';
import type {
  AiSettings,
  AnalysisPreflightCheck,
  AnalysisPreflightResult,
  EffectiveModelRouting,
  GeminiConnectionTestResult,
  GeminiErrorCode,
  GeminiModelAccessStatus,
  GeminiModelCapability,
  GeminiModelDiscoveryResult,
  GeminiServiceStatus,
  SanitizedGeminiErrorDiagnostic,
  VideoAnalysisMode,
} from '../../src/types/domain.ts';
import { getDb } from '../db/database.ts';
import {
  isDeprecatedGeminiModelId,
  isLikelyVideoCapableModelId,
  normalizeModelId,
  resolveEffectiveModelRouting,
} from './geminiModelRouter.ts';
import { resolveRecordingSegmentMediaPath } from './recordingMediaResolver.ts';
import {
  getDailyApiSpendUsd,
  getMatchSessionById,
  getSettings,
  listMatchSessions,
} from './repository.ts';
import { resolveServerFfmpegBinaries, validateVideoFile } from './videoPreprocessingService.ts';

const execFileAsync = promisify(execFile);

export const MODEL_DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const MODEL_CAPABILITY_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Known indicative pricing and descriptive metadata for Gemini models.
 * Used ONLY as supplementary metadata (indicative cost estimation & descriptions).
 * Actual model availability and access are determined dynamically via `client.models.list()`
 * and capability verification probes against the configured API key.
 */
export const GEMINI_MODEL_REGISTRY: GeminiModelCapability[] = [
  {
    modelId: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    availability: 'available_default',
    source: 'registry',
    accessStatus: 'unverified',
    supportsGenerateContent: true,
    supportsVideoInput: true,
    supportsStructuredOutput: true,
    recommendedStages: ['classification', 'quick', 'balanced', 'synthesis'],
    estimatedInputPricePer1MTokensUsd: 0.3,
    estimatedOutputPricePer1MTokensUsd: 2.5,
    pricingVerified: false,
    pricingNote:
      'Indicative estimate for local budget guardrails only — verify current billing rates in Google AI Studio.',
    description:
      'Fast multimodal video + structured JSON reasoning model suited for Quick and Balanced half-time analysis.',
  },
  {
    modelId: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash-Lite',
    availability: 'available_optional',
    source: 'registry',
    accessStatus: 'unverified',
    supportsGenerateContent: true,
    supportsVideoInput: true,
    supportsStructuredOutput: true,
    recommendedStages: ['classification', 'quick'],
    estimatedInputPricePer1MTokensUsd: 0.1,
    estimatedOutputPricePer1MTokensUsd: 0.4,
    pricingVerified: false,
    pricingNote:
      'Indicative low-cost estimate for fast screening and quick half-time passes.',
    description:
      'Lightweight multimodal model suited for rapid footage classification and low-latency quick analysis.',
  },
  {
    modelId: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite',
    availability: 'available_optional',
    source: 'registry',
    accessStatus: 'unverified',
    supportsGenerateContent: true,
    supportsVideoInput: true,
    supportsStructuredOutput: true,
    recommendedStages: ['classification', 'quick', 'balanced'],
    estimatedInputPricePer1MTokensUsd: 0.1,
    estimatedOutputPricePer1MTokensUsd: 0.4,
    pricingVerified: false,
    pricingNote:
      'Indicative low-cost estimate for fast multimodal video screening and balanced passes.',
    description:
      'Fast lightweight multimodal model suitable for rapid footage classification and half-time analysis.',
  },
  {
    modelId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    availability: 'requires_paid_tier',
    source: 'registry',
    accessStatus: 'unverified',
    supportsGenerateContent: true,
    supportsVideoInput: true,
    supportsStructuredOutput: true,
    recommendedStages: ['deep', 'synthesis'],
    estimatedInputPricePer1MTokensUsd: 1.25,
    estimatedOutputPricePer1MTokensUsd: 10.0,
    pricingVerified: false,
    pricingNote:
      'Indicative paid-tier estimate. Verify access and billing rates in Google AI Studio.',
    description:
      'High-capability tactical reasoning model for Deep match breakdowns and second-half comparisons.',
  },
  {
    modelId: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro Preview',
    availability: 'requires_paid_tier',
    source: 'registry',
    accessStatus: 'unverified',
    supportsGenerateContent: true,
    supportsVideoInput: true,
    supportsStructuredOutput: true,
    recommendedStages: ['deep', 'synthesis'],
    estimatedInputPricePer1MTokensUsd: 2.0,
    estimatedOutputPricePer1MTokensUsd: 12.0,
    pricingVerified: false,
    pricingNote:
      'Indicative preview estimate. Verify access and billing rates in Google AI Studio.',
    description:
      'Advanced multimodal reasoning model for comprehensive tactical synthesis when available on your API key.',
  },
];

export const PERMANENT_NON_RETRYABLE_ERROR_CODES = new Set<GeminiErrorCode>([
  'INVALID_API_KEY',
  'API_KEY_REVOKED',
  'MODEL_NOT_FOUND',
  'MODEL_ACCESS_DENIED',
  'MODEL_VIDEO_UNSUPPORTED',
  'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED',
  'BILLING_REQUIRED',
  'ANALYSIS_CANCELLED',
]);

export interface GeminiErrorClassificationContext {
  stage?: string | null;
  modelId?: string | null;
  segmentIndex?: number | null;
  attemptNumber?: number | null;
  elapsedMs?: number | null;
}

export interface ClassifiedGeminiError {
  code: GeminiErrorCode;
  retryable: boolean;
  userMessage: string;
  retryAfterMs: number | null;
  diagnostic: SanitizedGeminiErrorDiagnostic;
}

export interface GeminiDiscoveryClientLike {
  models: {
    list: (params?: { config?: { pageSize?: number; abortSignal?: AbortSignal } }) => Promise<
      AsyncIterable<{
        name?: string;
        displayName?: string;
        description?: string;
        supportedActions?: string[];
        inputTokenLimit?: number;
        outputTokenLimit?: number;
      }>
    >;
    generateContent: (params: {
      model: string;
      contents: unknown;
      config?: Record<string, unknown>;
    }) => Promise<{ text?: string }>;
  };
  files?: {
    upload: (params: {
      file: string;
      config?: { mimeType?: string; displayName?: string; abortSignal?: AbortSignal };
    }) => Promise<{ name?: string; uri?: string; state?: string }>;
    get: (params: {
      name: string;
      config?: { abortSignal?: AbortSignal };
    }) => Promise<{ name?: string; uri?: string; state?: string }>;
    delete: (params: {
      name: string;
      config?: { abortSignal?: AbortSignal };
    }) => Promise<unknown>;
  };
}

let inMemoryDiscoveryCache: {
  keyFingerprint: string;
  fetchedAtMs: number;
  discoveredAt: string;
  models: GeminiModelCapability[];
} | null = null;

export function clearGeminiDiscoveryAndCapabilityCaches(dbArg?: Database.Database): void {
  inMemoryDiscoveryCache = null;
  try {
    const db = dbArg ?? getDb();
    db.prepare('DELETE FROM gemini_model_capabilities_cache').run();
  } catch {
    // ignore if table not initialized yet
  }
}

export function getApiKeyFingerprint(): string {
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return 'unconfigured';
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/**
 * Scrubs any potential API keys, bearer tokens, or query secrets from error messages
 * and diagnostics before persistence, logging, or UI display.
 */
export function sanitizeDiagnosticText(raw: string): string {
  if (!raw) return '';
  let text = String(raw);
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey && envKey.length >= 8) {
    text = text.split(envKey).join('[REDACTED_API_KEY]');
  }
  text = text.replace(/AIza[0-9A-Za-z\-_]{16,}/g, '[REDACTED_API_KEY]');
  text = text.replace(/(key|api_key|apikey|token)=([^&\s"']+)/gi, '$1=[REDACTED]');
  text = text.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 480);
}

export function isGeminiApiConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  return Boolean(apiKey && apiKey.trim().length > 0 && apiKey !== 'MY_GEMINI_API_KEY');
}

export function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0 || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }

  return new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function inferPricingForModel(modelId: string): {
  input: number;
  output: number;
  availability: GeminiModelCapability['availability'];
  recommendedStages: GeminiModelCapability['recommendedStages'];
} {
  const normalized = normalizeModelId(modelId);
  const exact = GEMINI_MODEL_REGISTRY.find((m) => m.modelId === normalized);
  if (exact) {
    return {
      input: exact.estimatedInputPricePer1MTokensUsd ?? 0.3,
      output: exact.estimatedOutputPricePer1MTokensUsd ?? 2.5,
      availability: exact.availability,
      recommendedStages: exact.recommendedStages,
    };
  }
  const lower = normalized.toLowerCase();
  if (lower.includes('flash-lite') || lower.includes('lite')) {
    return {
      input: 0.1,
      output: 0.4,
      availability: 'available_optional',
      recommendedStages: ['classification', 'quick', 'balanced'],
    };
  }
  if (lower.includes('pro') || lower.includes('carbon') || lower.includes('neon')) {
    return {
      input: 1.25,
      output: 10.0,
      availability: 'requires_paid_tier',
      recommendedStages: ['deep', 'synthesis'],
    };
  }
  return {
    input: 0.3,
    output: 2.5,
    availability: 'available_default',
    recommendedStages: ['classification', 'quick', 'balanced', 'synthesis'],
  };
}

export function getModelCapability(modelId: string): GeminiModelCapability {
  const normalized = normalizeModelId(modelId);
  const existing = GEMINI_MODEL_REGISTRY.find((m) => m.modelId === normalized);
  if (existing) return existing;

  const inferred = inferPricingForModel(normalized);
  return {
    modelId: normalized || 'unconfigured',
    displayName: normalized || 'Unconfigured Model',
    availability: inferred.availability,
    source: 'configured',
    accessStatus: 'unverified',
    supportsGenerateContent: true,
    supportsVideoInput: isLikelyVideoCapableModelId(normalized),
    supportsStructuredOutput: true,
    recommendedStages: inferred.recommendedStages,
    estimatedInputPricePer1MTokensUsd: inferred.input,
    estimatedOutputPricePer1MTokensUsd: inferred.output,
    pricingVerified: false,
    pricingNote:
      'Indicative local estimate for budget guardrails — verify exact pricing in Google AI Studio.',
    description: 'Configured Gemini model ID.',
  };
}

export function isSupportedGeminiModel(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  if (!normalized || isDeprecatedGeminiModelId(normalized)) return false;
  if (GEMINI_MODEL_REGISTRY.some((m) => m.modelId === normalized)) return true;
  if (inMemoryDiscoveryCache?.models.some((m) => m.modelId === normalized)) return true;
  return isLikelyVideoCapableModelId(normalized);
}

export function estimateVideoAnalysisCostUsd(input: {
  modelVideoId: string;
  modelSynthesisId: string;
  totalDurationSeconds: number;
  samplingFps: number;
  segmentCount: number;
}): {
  estimatedCostUsd: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  pricingSource: string;
  isEstimate: boolean;
} {
  const videoCap = getModelCapability(input.modelVideoId);
  const synthCap = getModelCapability(input.modelSynthesisId);

  const sampledFrames = Math.max(
    1,
    Math.round(input.totalDurationSeconds * Math.max(0.25, input.samplingFps))
  );
  const videoInputTokens = sampledFrames * 260 + input.segmentCount * 2400;
  const videoOutputTokens = input.segmentCount * 1600;
  const synthInputTokens = 4500 + videoOutputTokens;
  const synthOutputTokens = 3200;

  const videoInPrice = videoCap.estimatedInputPricePer1MTokensUsd ?? 0.3;
  const videoOutPrice = videoCap.estimatedOutputPricePer1MTokensUsd ?? 2.5;
  const synthInPrice = synthCap.estimatedInputPricePer1MTokensUsd ?? 0.3;
  const synthOutPrice = synthCap.estimatedOutputPricePer1MTokensUsd ?? 2.5;

  const cost =
    (videoInputTokens / 1_000_000) * videoInPrice +
    (videoOutputTokens / 1_000_000) * videoOutPrice +
    (synthInputTokens / 1_000_000) * synthInPrice +
    (synthOutputTokens / 1_000_000) * synthOutPrice;

  return {
    estimatedCostUsd: Number(cost.toFixed(6)),
    estimatedInputTokens: videoInputTokens + synthInputTokens,
    estimatedOutputTokens: videoOutputTokens + synthOutputTokens,
    pricingSource: 'local_registry_indicative_estimate',
    isEstimate: true,
  };
}

export function estimateActualStageCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const cap = getModelCapability(modelId);
  const inPrice = cap.estimatedInputPricePer1MTokensUsd ?? 0.3;
  const outPrice = cap.estimatedOutputPricePer1MTokensUsd ?? 2.5;
  return Number(
    ((inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice).toFixed(6)
  );
}

function extractRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const rec = err as Record<string, unknown>;
  const direct = rec.retryAfterMs;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
    return Math.min(120_000, Math.round(direct));
  }

  const headers =
    (rec.headers as Record<string, unknown> | undefined) ??
    ((rec.response as Record<string, unknown> | undefined)?.headers as
      | Record<string, unknown>
      | undefined);

  let rawHeader: string | null = null;
  if (headers) {
    if (typeof (headers as { get?: (k: string) => string | null }).get === 'function') {
      rawHeader = (headers as { get: (k: string) => string | null }).get('retry-after');
    } else {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'retry-after' && v !== undefined && v !== null) {
          rawHeader = String(v);
          break;
        }
      }
    }
  }

  if (rawHeader) {
    const secs = Number(rawHeader.trim());
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(120_000, Math.round(secs * 1000));
    }
    const dt = Date.parse(rawHeader);
    if (Number.isFinite(dt)) {
      const diff = dt - Date.now();
      if (diff > 0) return Math.min(120_000, diff);
    }
  }

  // Also parse "Please retry in 12.4s" style upstream messages
  const msg = typeof rec.message === 'string' ? rec.message : '';
  const m = msg.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (m) {
    const secs = Number(m[1]);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(120_000, Math.round(secs * 1000));
    }
  }
  return null;
}

function extractErrorFields(err: unknown): {
  httpStatus: number | null;
  apiStatus: string | null;
  rawMessage: string;
  explicitCode: string | null;
  isAbort: boolean;
} {
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    const nestedErr =
      rec.error && typeof rec.error === 'object' ? (rec.error as Record<string, unknown>) : null;
    const rawStatus = rec.status ?? rec.statusCode ?? nestedErr?.code ?? null;
    let httpStatus: number | null = null;
    if (typeof rawStatus === 'number' && Number.isFinite(rawStatus)) {
      httpStatus = rawStatus;
    } else if (typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus.trim())) {
      httpStatus = Number(rawStatus.trim());
    }

    const apiStatus =
      typeof nestedErr?.status === 'string'
        ? nestedErr.status
        : typeof rec.apiStatus === 'string'
          ? rec.apiStatus
          : typeof rec.status === 'string' && !/^\d+$/.test(rec.status)
            ? rec.status
            : null;

    const explicitCode =
      typeof rec.geminiErrorCode === 'string'
        ? rec.geminiErrorCode
        : typeof rec.code === 'string'
          ? rec.code
          : null;

    const rawMessage =
      typeof rec.message === 'string'
        ? rec.message
        : typeof nestedErr?.message === 'string'
          ? nestedErr.message
          : JSON.stringify(rec);

    // Check embedded JSON error payload inside SDK Error.message
    let parsedHttp = httpStatus;
    let parsedApiStatus = apiStatus;
    if (rawMessage.includes('{') && rawMessage.includes('}')) {
      try {
        const jsonStart = rawMessage.indexOf('{');
        const parsed = JSON.parse(rawMessage.slice(jsonStart)) as {
          error?: { code?: number; status?: string; message?: string };
        };
        if (parsed.error) {
          if (!parsedHttp && typeof parsed.error.code === 'number') parsedHttp = parsed.error.code;
          if (!parsedApiStatus && typeof parsed.error.status === 'string') {
            parsedApiStatus = parsed.error.status;
          }
        }
      } catch {
        // ignore non-JSON braces
      }
    }

    const name = typeof rec.name === 'string' ? rec.name : '';
    const isAbort = name === 'AbortError' || rawMessage.toLowerCase().includes('abort');
    return {
      httpStatus: parsedHttp,
      apiStatus: parsedApiStatus,
      rawMessage,
      explicitCode,
      isAbort,
    };
  }
  return {
    httpStatus: null,
    apiStatus: null,
    rawMessage: String(err ?? ''),
    explicitCode: null,
    isAbort: false,
  };
}

/**
 * Classifies any Gemini API, Files API, timeout, cancellation, or network error into
 * the exact 19 Phase 3.0.2 error codes with sanitized diagnostic metadata.
 */
export function classifyGeminiError(
  err: unknown,
  context: GeminiErrorClassificationContext = {}
): ClassifiedGeminiError {
  const { httpStatus, apiStatus, rawMessage, explicitCode, isAbort } = extractErrorFields(err);
  const sanitizedUpstream = sanitizeDiagnosticText(rawMessage);
  const lower = `${httpStatus ?? ''} ${apiStatus ?? ''} ${explicitCode ?? ''} ${sanitizedUpstream}`.toLowerCase();
  const stageLower = (context.stage ?? '').toLowerCase();
  const retryAfterMs = extractRetryAfterMs(err);

  const build = (
    code: GeminiErrorCode,
    userMessage: string,
    retryableOverride?: boolean
  ): ClassifiedGeminiError => {
    const retryable =
      retryableOverride !== undefined
        ? retryableOverride
        : !PERMANENT_NON_RETRYABLE_ERROR_CODES.has(code);
    return {
      code,
      retryable,
      userMessage,
      retryAfterMs,
      diagnostic: {
        code,
        httpStatus,
        apiStatus,
        upstreamMessage: sanitizedUpstream || userMessage,
        stage: context.stage ?? null,
        modelId: context.modelId ?? null,
        segmentIndex: context.segmentIndex ?? null,
        attemptNumber: context.attemptNumber ?? null,
        elapsedMs: context.elapsedMs ?? null,
        retryable,
        retryAfterMs,
        occurredAt: new Date().toISOString(),
      },
    };
  };

  // Explicit known Phase 3.0.2 error codes passed through from inner stage guards
  const VALID_CODES = new Set<GeminiErrorCode>([
    'INVALID_API_KEY',
    'API_KEY_REVOKED',
    'MODEL_NOT_FOUND',
    'MODEL_ACCESS_DENIED',
    'MODEL_VIDEO_UNSUPPORTED',
    'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED',
    'BILLING_REQUIRED',
    'RATE_LIMIT_EXCEEDED',
    'QUOTA_EXCEEDED',
    'VIDEO_UPLOAD_FAILED',
    'VIDEO_UPLOAD_TIMEOUT',
    'VIDEO_PROCESSING_FAILED',
    'VIDEO_PROCESSING_TIMEOUT',
    'INFERENCE_TIMEOUT',
    'NETWORK_CONNECTION_FAILED',
    'UPSTREAM_SERVICE_UNAVAILABLE',
    'INVALID_MODEL_RESPONSE',
    'ANALYSIS_CANCELLED',
    'ANALYSIS_INTERRUPTED',
  ]);

  if (explicitCode && VALID_CODES.has(explicitCode as GeminiErrorCode)) {
    const typed = explicitCode as GeminiErrorCode;
    return build(typed, sanitizedUpstream || `Gemini analysis failed (${typed}).`);
  }

  // 1. Cancellation & Interruption
  if (
    rawMessage === '__JOB_CANCELLED__' ||
    lower.includes('job cancelled') ||
    lower.includes('analysis cancelled') ||
    lower.includes('user_cancelled')
  ) {
    return build('ANALYSIS_CANCELLED', 'Analysis job was cancelled by the user.', false);
  }
  if (lower.includes('interrupted') || lower.includes('app_restarted_mid_job')) {
    return build(
      'ANALYSIS_INTERRUPTED',
      'Analysis job was interrupted before completion. Start a fresh run to retry.',
      false
    );
  }

  // 2. API Key Revoked / Invalid
  if (
    lower.includes('api key expired') ||
    lower.includes('key revoked') ||
    lower.includes('api_key_revoked') ||
    lower.includes('revoked') ||
    lower.includes('leaked') ||
    lower.includes('reported as leaked')
  ) {
    return build(
      'API_KEY_REVOKED',
      'The configured server-side GEMINI_API_KEY has been revoked or expired. Rotate the key in Google AI Studio and update your local .env.',
      false
    );
  }
  if (
    httpStatus === 401 ||
    apiStatus === 'UNAUTHENTICATED' ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('api key invalid') ||
    lower.includes('gemini_api_key is not configured') ||
    lower.includes('unauthenticated')
  ) {
    return build(
      'INVALID_API_KEY',
      'Gemini API authentication failed. Verify the server-side GEMINI_API_KEY value in your local .env.',
      false
    );
  }

  // 3. Billing Required
  if (
    lower.includes('billing') ||
    lower.includes('enable billing') ||
    lower.includes('paid tier') ||
    lower.includes('payment required') ||
    httpStatus === 402
  ) {
    return build(
      'BILLING_REQUIRED',
      `Model ${context.modelId ?? 'selected'} requires an active billed Gemini API tier. Enable billing in Google AI Studio or select a free-tier accessible model.`,
      false
    );
  }

  // 4. Model Not Found (404 / NOT_FOUND / unknown model)
  if (
    (httpStatus === 404 || apiStatus === 'NOT_FOUND' || lower.includes('not_found') || lower.includes('not found') || lower.includes('is not found for api version') || lower.includes('not supported for generatecontent')) &&
    !stageLower.includes('cleanup')
  ) {
    return build(
      'MODEL_NOT_FOUND',
      `Model "${context.modelId ?? 'selected'}" was not found or is not available on this Gemini API key. Open Settings -> AI & Evidence Policy and click "Refresh Available Models".`,
      false
    );
  }

  // 5. Model Access Denied (403 / PERMISSION_DENIED)
  if (
    httpStatus === 403 ||
    apiStatus === 'PERMISSION_DENIED' ||
    lower.includes('permission_denied') ||
    lower.includes('access denied') ||
    lower.includes('does not have access')
  ) {
    return build(
      'MODEL_ACCESS_DENIED',
      `Your Gemini API key does not have permission to access model "${context.modelId ?? 'selected'}". Choose a verified accessible model in Settings.`,
      false
    );
  }

  // 6. Model Capability Errors (Video / Structured JSON unsupported)
  if (
    lower.includes('video') &&
    (lower.includes('not supported') ||
      lower.includes('unsupported mime') ||
      lower.includes('unsupported media') ||
      lower.includes('cannot process video') ||
      lower.includes('multimodal') && lower.includes('unsupported'))
  ) {
    return build(
      'MODEL_VIDEO_UNSUPPORTED',
      `Model "${context.modelId ?? 'selected'}" does not support video input for this request. Select a video-capable Gemini model.`,
      false
    );
  }
  if (
    (lower.includes('response_schema') ||
      lower.includes('responsemimetype') ||
      lower.includes('application/json') ||
      lower.includes('structured output') ||
      lower.includes('json mode')) &&
    (lower.includes('not supported') || lower.includes('unsupported') || lower.includes('invalid_argument') || httpStatus === 400)
  ) {
    return build(
      'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED',
      `Model "${context.modelId ?? 'selected'}" does not support required structured JSON schema output.`,
      false
    );
  }

  // 7. Rate Limit vs Quota Exceeded (429 / RESOURCE_EXHAUSTED)
  if (
    httpStatus === 429 ||
    apiStatus === 'RESOURCE_EXHAUSTED' ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  ) {
    const isHardQuota =
      lower.includes('daily') ||
      lower.includes('per day') ||
      lower.includes('quota exceeded') ||
      lower.includes('exceeded your current quota') ||
      lower.includes('limit: 0');
    if (isHardQuota) {
      return build(
        'QUOTA_EXCEEDED',
        'Gemini API quota has been exhausted for this key/model. Check quota usage in Google AI Studio or switch to another verified model.',
        false
      );
    }
    return build(
      'RATE_LIMIT_EXCEEDED',
      'Gemini API rate limit reached. Wait briefly or retry with a lower sampling rate.',
      true
    );
  }

  // 8. Stage-specific Timeouts
  const isTimeout =
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('deadline_exceeded') ||
    lower.includes('deadline') ||
    isAbort;

  if (isTimeout) {
    if (stageLower.includes('upload')) {
      return build(
        'VIDEO_UPLOAD_TIMEOUT',
        'Uploading the gameplay video segment to Gemini Files API timed out before completing. Try enabling Quick/Balanced proxy compression or increasing the Upload Timeout in Settings.',
        true
      );
    }
    if (stageLower.includes('media_processing') || stageLower.includes('processing')) {
      return build(
        'VIDEO_PROCESSING_TIMEOUT',
        'Gemini Files API media processing timed out before the uploaded video became ACTIVE.',
        true
      );
    }
    return build(
      'INFERENCE_TIMEOUT',
      `Gemini model "${context.modelId ?? 'selected'}" timed out during stage "${context.stage ?? 'inference'}".`,
      true
    );
  }

  // 9. Remote Video Processing / Upload Failures
  if (
    stageLower.includes('media_processing') ||
    lower.includes('media processing ended in unexpected state') ||
    lower.includes('state "failed"') ||
    lower.includes('video processing failed')
  ) {
    return build(
      'VIDEO_PROCESSING_FAILED',
      'Gemini Files API failed to process the uploaded video segment into an ACTIVE state.',
      false
    );
  }

  // 10. Invalid / Malformed JSON Response
  if (
    lower.includes('malformed json') ||
    lower.includes('empty output') ||
    lower.includes('unexpected token') ||
    lower.includes('invalid_model_response')
  ) {
    return build(
      'INVALID_MODEL_RESPONSE',
      `Model "${context.modelId ?? 'selected'}" returned an empty or malformed JSON response during stage "${context.stage ?? 'inference'}".`,
      true
    );
  }

  // 11. Upstream Service Unavailable (500 / 502 / 503 / 504 / UNAVAILABLE / INTERNAL)
  if (
    (httpStatus !== null && httpStatus >= 500 && httpStatus <= 599) ||
    apiStatus === 'UNAVAILABLE' ||
    apiStatus === 'INTERNAL' ||
    lower.includes('service unavailable') ||
    lower.includes('overloaded') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('504') ||
    lower.includes('500')
  ) {
    return build(
      'UPSTREAM_SERVICE_UNAVAILABLE',
      `Google Gemini service returned an upstream error (${httpStatus ?? apiStatus ?? '5xx'}) during stage "${context.stage ?? 'request'}".`,
      true
    );
  }

  // 12. Network Connection Failures
  if (
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('eai_again') ||
    lower.includes('socket hang up') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    if (stageLower.includes('upload')) {
      return build(
        'VIDEO_UPLOAD_FAILED',
        `Network failure while uploading video segment to Gemini Files API: ${sanitizedUpstream}`,
        true
      );
    }
    return build(
      'NETWORK_CONNECTION_FAILED',
      `Network connection to Google Gemini API failed: ${sanitizedUpstream}`,
      true
    );
  }

  // 13. Upload-stage catch-all
  if (stageLower.includes('upload')) {
    return build(
      'VIDEO_UPLOAD_FAILED',
      `Video upload to Gemini Files API failed: ${sanitizedUpstream}`,
      true
    );
  }

  // 14. Default fallback — still preserves exact sanitized upstream error instead of hiding it
  return build(
    'UPSTREAM_SERVICE_UNAVAILABLE',
    sanitizedUpstream || 'Unexpected Gemini API error occurred.',
    false
  );
}

// ============================================================
// SQLite-backed Short-Lived Capability Verification Cache
// ============================================================

interface CachedModelCapabilityRow {
  cache_key: string;
  api_key_fingerprint: string;
  model_id: string;
  display_name: string;
  source: string;
  access_status: GeminiModelAccessStatus;
  supports_generate_content: number;
  supports_video_input: number;
  supports_structured_output: number;
  video_verified: number;
  structured_json_verified: number;
  input_token_limit: number | null;
  output_token_limit: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  verified_at: string;
  expires_at: string;
}

function readCachedCapability(
  modelId: string,
  dbArg?: Database.Database
): CachedModelCapabilityRow | null {
  try {
    const db = dbArg ?? getDb();
    const fp = getApiKeyFingerprint();
    const cacheKey = `${fp}:${normalizeModelId(modelId)}`;
    const row = db
      .prepare('SELECT * FROM gemini_model_capabilities_cache WHERE cache_key = ?')
      .get(cacheKey) as CachedModelCapabilityRow | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

function listAllCachedCapabilities(dbArg?: Database.Database): Map<string, CachedModelCapabilityRow> {
  const map = new Map<string, CachedModelCapabilityRow>();
  try {
    const db = dbArg ?? getDb();
    const fp = getApiKeyFingerprint();
    const rows = db
      .prepare('SELECT * FROM gemini_model_capabilities_cache WHERE api_key_fingerprint = ?')
      .all(fp) as CachedModelCapabilityRow[];
    const now = Date.now();
    for (const r of rows) {
      if (Date.parse(r.expires_at) > now) {
        map.set(normalizeModelId(r.model_id), r);
      }
    }
  } catch {
    // ignore if db not ready
  }
  return map;
}

function writeCachedCapability(
  entry: {
    modelId: string;
    displayName?: string;
    source?: 'discovered' | 'configured' | 'registry';
    accessStatus: GeminiModelAccessStatus;
    supportsGenerateContent: boolean;
    supportsVideoInput: boolean;
    supportsStructuredOutput: boolean;
    videoVerified: boolean;
    structuredJsonVerified: boolean;
    inputTokenLimit?: number | null;
    outputTokenLimit?: number | null;
    lastErrorCode?: GeminiErrorCode | null;
    lastErrorMessage?: string | null;
    ttlMs?: number;
  },
  dbArg?: Database.Database
): void {
  try {
    const db = dbArg ?? getDb();
    const fp = getApiKeyFingerprint();
    const normalized = normalizeModelId(entry.modelId);
    const cacheKey = `${fp}:${normalized}`;
    const nowMs = Date.now();
    const verifiedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + (entry.ttlMs ?? MODEL_CAPABILITY_CACHE_TTL_MS)).toISOString();

    db.prepare(`
      INSERT INTO gemini_model_capabilities_cache (
        cache_key, api_key_fingerprint, model_id, display_name, source, access_status,
        supports_generate_content, supports_video_input, supports_structured_output,
        video_verified, structured_json_verified, input_token_limit, output_token_limit,
        last_error_code, last_error_message, verified_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        display_name = COALESCE(NULLIF(excluded.display_name, ''), gemini_model_capabilities_cache.display_name),
        source = excluded.source,
        access_status = excluded.access_status,
        supports_generate_content = excluded.supports_generate_content,
        supports_video_input = excluded.supports_video_input,
        supports_structured_output = excluded.supports_structured_output,
        video_verified = CASE WHEN excluded.video_verified = 1 THEN 1 ELSE gemini_model_capabilities_cache.video_verified END,
        structured_json_verified = excluded.structured_json_verified,
        input_token_limit = COALESCE(excluded.input_token_limit, gemini_model_capabilities_cache.input_token_limit),
        output_token_limit = COALESCE(excluded.output_token_limit, gemini_model_capabilities_cache.output_token_limit),
        last_error_code = excluded.last_error_code,
        last_error_message = excluded.last_error_message,
        verified_at = excluded.verified_at,
        expires_at = excluded.expires_at
    `).run(
      cacheKey,
      fp,
      normalized,
      entry.displayName ?? normalized,
      entry.source ?? 'discovered',
      entry.accessStatus,
      entry.supportsGenerateContent ? 1 : 0,
      entry.supportsVideoInput ? 1 : 0,
      entry.supportsStructuredOutput ? 1 : 0,
      entry.videoVerified ? 1 : 0,
      entry.structuredJsonVerified ? 1 : 0,
      entry.inputTokenLimit ?? null,
      entry.outputTokenLimit ?? null,
      entry.lastErrorCode ?? null,
      entry.lastErrorMessage ? sanitizeDiagnosticText(entry.lastErrorMessage) : null,
      verifiedAt,
      expiresAt
    );
  } catch {
    // non-fatal cache error
  }
}

function mergeCachedStatusIntoModel(
  model: GeminiModelCapability,
  cachedMap: Map<string, CachedModelCapabilityRow>
): GeminiModelCapability {
  const cached = cachedMap.get(normalizeModelId(model.modelId));
  if (!cached) return model;
  return {
    ...model,
    accessStatus: cached.access_status,
    supportsGenerateContent: Boolean(cached.supports_generate_content),
    supportsVideoInput: Boolean(cached.supports_video_input),
    supportsStructuredOutput: Boolean(cached.supports_structured_output),
    videoVerified: Boolean(cached.video_verified),
    structuredJsonVerified: Boolean(cached.structured_json_verified),
    inputTokenLimit: cached.input_token_limit ?? model.inputTokenLimit ?? null,
    outputTokenLimit: cached.output_token_limit ?? model.outputTokenLimit ?? null,
    lastVerifiedAt: cached.verified_at,
    lastErrorCode: (cached.last_error_code as GeminiErrorCode | null) ?? null,
    lastErrorMessage: cached.last_error_message ?? null,
  };
}

// ============================================================
// Dynamic Model Discovery (client.models.list)
// ============================================================

export async function discoverAvailableGeminiModels(options: {
  forceRefresh?: boolean;
  timeoutMs?: number;
  clientOverride?: GeminiDiscoveryClientLike | null;
  configuredModelIds?: string[];
  db?: Database.Database;
} = {}): Promise<GeminiModelDiscoveryResult> {
  const cachedMap = listAllCachedCapabilities(options.db);
  const configuredIds = (options.configuredModelIds ?? [])
    .map(normalizeModelId)
    .filter((id) => id.length > 0);

  const client =
    options.clientOverride !== undefined
      ? options.clientOverride
      : (createGeminiClient() as unknown as GeminiDiscoveryClientLike | null);

  if (!client) {
    const fallbackModels = GEMINI_MODEL_REGISTRY.map((m) =>
      mergeCachedStatusIntoModel({ ...m, source: 'registry', accessStatus: 'unverified' }, cachedMap)
    );
    for (const cid of configuredIds) {
      if (!fallbackModels.some((m) => m.modelId === cid)) {
        fallbackModels.push(
          mergeCachedStatusIntoModel(
            { ...getModelCapability(cid), source: 'configured', accessStatus: 'unverified' },
            cachedMap
          )
        );
      }
    }
    return {
      configured: false,
      discoveredAt: null,
      fromCache: false,
      models: fallbackModels,
      discoveryError: null,
    };
  }

  const keyFp = getApiKeyFingerprint();
  if (
    !options.forceRefresh &&
    !options.clientOverride &&
    inMemoryDiscoveryCache &&
    inMemoryDiscoveryCache.keyFingerprint === keyFp &&
    Date.now() - inMemoryDiscoveryCache.fetchedAtMs < MODEL_DISCOVERY_CACHE_TTL_MS
  ) {
    const models = inMemoryDiscoveryCache.models.map((m) => mergeCachedStatusIntoModel(m, cachedMap));
    return {
      configured: true,
      discoveredAt: inMemoryDiscoveryCache.discoveredAt,
      fromCache: true,
      models,
      discoveryError: null,
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

  try {
    const discovered: GeminiModelCapability[] = [];
    const seen = new Set<string>();
    const pager = await client.models.list({
      config: { pageSize: 100, abortSignal: controller.signal },
    });

    for await (const rawModel of pager) {
      const id = normalizeModelId(rawModel.name);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const actions = Array.isArray(rawModel.supportedActions) ? rawModel.supportedActions : [];
      const supportsGenerateContent =
        actions.length === 0 ||
        actions.some((a) => a.toLowerCase() === 'generatecontent');

      // Filter out deprecated and non-generative/non-video models
      if (!supportsGenerateContent) continue;
      if (!isLikelyVideoCapableModelId(id)) continue;

      const inferred = inferPricingForModel(id);
      const regMatch = GEMINI_MODEL_REGISTRY.find((m) => m.modelId === id);

      const cap: GeminiModelCapability = {
        modelId: id,
        displayName: rawModel.displayName?.trim() || regMatch?.displayName || id,
        availability: regMatch?.availability ?? inferred.availability,
        source: 'discovered',
        accessStatus: 'unverified',
        supportsGenerateContent: true,
        supportsVideoInput: true,
        supportsStructuredOutput: true,
        inputTokenLimit: rawModel.inputTokenLimit ?? null,
        outputTokenLimit: rawModel.outputTokenLimit ?? null,
        recommendedStages: regMatch?.recommendedStages ?? inferred.recommendedStages,
        estimatedInputPricePer1MTokensUsd: regMatch?.estimatedInputPricePer1MTokensUsd ?? inferred.input,
        estimatedOutputPricePer1MTokensUsd: regMatch?.estimatedOutputPricePer1MTokensUsd ?? inferred.output,
        pricingVerified: false,
        pricingNote:
          regMatch?.pricingNote ??
          'Indicative local estimate for budget guardrails — verify exact pricing in Google AI Studio.',
        description:
          rawModel.description?.trim() ||
          regMatch?.description ||
          'Dynamically discovered Gemini multimodal model available on this API key.',
      };
      discovered.push(mergeCachedStatusIntoModel(cap, cachedMap));
    }

    // Include any currently configured model IDs that were NOT returned by models.list()
    // so the UI explicitly marks them as inaccessible/unlisted rather than failing silently.
    for (const cid of configuredIds) {
      if (!seen.has(cid)) {
        const cached = cachedMap.get(cid);
        discovered.push(
          mergeCachedStatusIntoModel(
            {
              ...getModelCapability(cid),
              source: 'configured',
              accessStatus: cached?.access_status ?? 'inaccessible',
              lastErrorCode: (cached?.last_error_code as GeminiErrorCode | null) ?? 'MODEL_NOT_FOUND',
              lastErrorMessage:
                cached?.last_error_message ??
                `Model "${cid}" was not listed as available by your Gemini API key.`,
            },
            cachedMap
          )
        );
      }
    }

    // Sort verified first, then discovered stable flash/pro models
    discovered.sort((a, b) => {
      const rank = (m: GeminiModelCapability) => {
        if (m.accessStatus === 'verified') return 0;
        if (m.source === 'discovered' && m.accessStatus !== 'inaccessible') return 1;
        if (m.accessStatus === 'unverified') return 2;
        return 3;
      };
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return a.modelId.localeCompare(b.modelId);
    });

    const discoveredAt = new Date().toISOString();
    if (!options.clientOverride) {
      inMemoryDiscoveryCache = {
        keyFingerprint: keyFp,
        fetchedAtMs: Date.now(),
        discoveredAt,
        models: discovered,
      };
    }

    return {
      configured: true,
      discoveredAt,
      fromCache: false,
      models: discovered,
      discoveryError: null,
    };
  } catch (err) {
    const classified = classifyGeminiError(err, {
      stage: 'model_discovery',
      elapsedMs: Date.now() - started,
    });
    const fallbackModels = GEMINI_MODEL_REGISTRY.map((m) => mergeCachedStatusIntoModel(m, cachedMap));
    return {
      configured: true,
      discoveredAt: inMemoryDiscoveryCache?.discoveredAt ?? null,
      fromCache: false,
      models: fallbackModels,
      discoveryError: classified.diagnostic,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function getGeminiStatus(selectedModel: string, aiSettings?: AiSettings): GeminiServiceStatus {
  const configured = isGeminiApiConfigured();
  const cachedMap = listAllCachedCapabilities();
  const normalizedSelected = normalizeModelId(selectedModel);

  const baseModels =
    inMemoryDiscoveryCache && inMemoryDiscoveryCache.keyFingerprint === getApiKeyFingerprint()
      ? inMemoryDiscoveryCache.models
      : GEMINI_MODEL_REGISTRY;

  const models = baseModels.map((m) => mergeCachedStatusIntoModel(m, cachedMap));
  if (normalizedSelected && !models.some((m) => m.modelId === normalizedSelected)) {
    models.push(
      mergeCachedStatusIntoModel(
        { ...getModelCapability(normalizedSelected), source: 'configured' },
        cachedMap
      )
    );
  }

  const effectiveRouting = aiSettings
    ? resolveEffectiveModelRouting(aiSettings)
    : undefined;

  return {
    configured,
    defaultModel: normalizedSelected || models[0]?.modelId || 'gemini-2.5-flash',
    supportedModels: models.map((m) => m.modelId),
    models,
    routing: effectiveRouting,
    discoveredAt: inMemoryDiscoveryCache?.discoveredAt ?? null,
    phaseNote: configured
      ? 'Server-side GEMINI_API_KEY detected. Use "Refresh Available Models" and "Test Selected Model" to verify live access before running video analysis.'
      : 'GEMINI_API_KEY is not configured in the server environment. Configure GEMINI_API_KEY in .env (server-side) before running real Gemini video analysis.',
  };
}

// ============================================================
// Live Capability Verification (Structured JSON + Video Probe)
// ============================================================

async function createTinySyntheticProbeMp4(): Promise<string> {
  const bins = resolveServerFfmpegBinaries();
  if (!bins.ffmpegPath) {
    throw new Error('FFmpeg binary is unavailable to synthesize a video compatibility probe.');
  }
  const tmpFile = path.join(os.tmpdir(), `fc26_gemini_video_probe_${crypto.randomUUID().slice(0, 8)}.mp4`);
  await execFileAsync(
    bins.ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=160x120:d=1:r=5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '32',
      '-movflags',
      '+faststart',
      tmpFile,
    ],
    { timeout: 15_000, maxBuffer: 1024 * 1024 }
  );
  return tmpFile;
}

export async function verifyModelCapabilities(input: {
  modelId: string;
  testVideo?: boolean;
  forceRefresh?: boolean;
  timeoutMs?: number;
  clientOverride?: GeminiDiscoveryClientLike | null;
  db?: Database.Database;
}): Promise<GeminiConnectionTestResult> {
  const modelId = normalizeModelId(input.modelId);
  const started = Date.now();

  if (!modelId) {
    return {
      ok: false,
      configured: isGeminiApiConfigured(),
      modelId: '',
      latencyMs: 0,
      videoSupported: false,
      videoTested: Boolean(input.testVideo),
      structuredOutputSupported: false,
      accessStatus: 'unsupported',
      message: 'No Gemini model ID is selected. Choose a model in Settings first.',
      errorCode: 'MODEL_NOT_FOUND',
    };
  }

  if (isDeprecatedGeminiModelId(modelId)) {
    return {
      ok: false,
      configured: isGeminiApiConfigured(),
      modelId,
      latencyMs: 0,
      videoSupported: false,
      videoTested: Boolean(input.testVideo),
      structuredOutputSupported: false,
      accessStatus: 'unsupported',
      message: `Model "${modelId}" is deprecated and unsupported. Select an active Gemini model.`,
      errorCode: 'MODEL_NOT_FOUND',
    };
  }

  const client =
    input.clientOverride !== undefined
      ? input.clientOverride
      : (createGeminiClient() as unknown as GeminiDiscoveryClientLike | null);

  if (!client) {
    return {
      ok: false,
      configured: false,
      modelId,
      latencyMs: Date.now() - started,
      videoSupported: false,
      videoTested: Boolean(input.testVideo),
      structuredOutputSupported: false,
      accessStatus: 'unverified',
      message:
        'GEMINI_API_KEY is not set in the local server environment. Set GEMINI_API_KEY in .env and restart the desktop app.',
      errorCode: 'INVALID_API_KEY',
    };
  }

  // Return short-lived cached verification when still fresh & matching requested scope
  if (!input.forceRefresh && !input.clientOverride) {
    const cached = readCachedCapability(modelId, input.db);
    if (
      cached &&
      cached.access_status === 'verified' &&
      cached.structured_json_verified === 1 &&
      (!input.testVideo || cached.video_verified === 1)
    ) {
      return {
        ok: true,
        configured: true,
        modelId,
        latencyMs: 0,
        videoSupported: Boolean(cached.supports_video_input),
        videoTested: Boolean(cached.video_verified),
        structuredOutputSupported: Boolean(cached.supports_structured_output),
        accessStatus: 'verified',
        verifiedAt: cached.verified_at,
        message: `Cached verification valid for ${modelId} (verified at ${cached.verified_at}).`,
      };
    }
  }

  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? (input.testVideo ? 45_000 : 25_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let tempProbePath: string | null = null;
  let uploadedRemoteName: string | null = null;

  try {
    let contents: unknown = 'Respond with JSON {"ok": true, "note": "connected"}.';

    if (input.testVideo) {
      tempProbePath = await createTinySyntheticProbeMp4();
      const videoBytes = fs.readFileSync(tempProbePath);
      if (client.files && videoBytes.length > 4 * 1024 * 1024) {
        const up = await client.files.upload({
          file: tempProbePath,
          config: {
            mimeType: 'video/mp4',
            displayName: 'fc26_video_capability_probe.mp4',
            abortSignal: controller.signal,
          },
        });
        uploadedRemoteName = up.name ?? null;
        let cur = up;
        while (cur.state === 'PROCESSING' && cur.name) {
          await new Promise((r) => setTimeout(r, 1000));
          cur = await client.files.get({ name: cur.name, config: { abortSignal: controller.signal } });
        }
        if (cur.state !== 'ACTIVE' || !cur.uri) {
          throw new Error(`Gemini media processing ended in unexpected state "${String(cur.state)}".`);
        }
        contents = [
          createPartFromUri(cur.uri, 'video/mp4'),
          'Confirm you can inspect this 1-second test video and return JSON {"ok": true, "note": "video_verified"}.',
        ];
      } else {
        // Inline tiny 1-second MP4 (~3 KB) directly avoids extra Files API wait during Settings check
        contents = [
          {
            inlineData: {
              mimeType: 'video/mp4',
              data: videoBytes.toString('base64'),
            },
          },
          'Confirm you can inspect this 1-second test video and return JSON {"ok": true, "note": "video_verified"}.',
        ];
      }
    }

    const response = await client.models.generateContent({
      model: modelId,
      contents,
      config: {
        abortSignal: controller.signal,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            ok: { type: Type.BOOLEAN },
            note: { type: Type.STRING },
          },
          required: ['ok', 'note'],
        },
      },
    });

    const parsed = JSON.parse(response.text ?? '{}') as { ok?: boolean; note?: string };
    const latencyMs = Date.now() - started;
    const ok = Boolean(parsed.ok);

    if (!ok) {
      throw new Error('Model returned structured JSON with ok=false during verification.');
    }

    const verifiedAt = new Date().toISOString();
    writeCachedCapability(
      {
        modelId,
        displayName: getModelCapability(modelId).displayName,
        source: 'discovered',
        accessStatus: 'verified',
        supportsGenerateContent: true,
        supportsVideoInput: true,
        supportsStructuredOutput: true,
        videoVerified: Boolean(input.testVideo),
        structuredJsonVerified: true,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      input.db
    );

    return {
      ok: true,
      configured: true,
      modelId,
      latencyMs,
      videoSupported: true,
      videoTested: Boolean(input.testVideo),
      structuredOutputSupported: true,
      accessStatus: 'verified',
      verifiedAt,
      message: input.testVideo
        ? `Verified ${modelId} (${latencyMs} ms): video input + structured JSON output confirmed.`
        : `Connected to ${modelId} (${latencyMs} ms): access and structured JSON output verified.`,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const classified = classifyGeminiError(err, {
      stage: input.testVideo ? 'verify_video_capability' : 'verify_model_access',
      modelId,
      elapsedMs: latencyMs,
    });

    const accessStatus: GeminiModelAccessStatus =
      classified.code === 'MODEL_VIDEO_UNSUPPORTED' ||
      classified.code === 'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED'
        ? 'unsupported'
        : classified.code === 'MODEL_NOT_FOUND' ||
            classified.code === 'MODEL_ACCESS_DENIED' ||
            classified.code === 'BILLING_REQUIRED'
          ? 'inaccessible'
          : 'unverified';

    // Cache deterministic permanent capability/access failures briefly (5 min) so repeated clicks/preflights stay informative
    if (accessStatus === 'inaccessible' || accessStatus === 'unsupported') {
      writeCachedCapability(
        {
          modelId,
          displayName: getModelCapability(modelId).displayName,
          source: 'configured',
          accessStatus,
          supportsGenerateContent: accessStatus !== 'inaccessible',
          supportsVideoInput: classified.code !== 'MODEL_VIDEO_UNSUPPORTED',
          supportsStructuredOutput: classified.code !== 'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED',
          videoVerified: false,
          structuredJsonVerified: false,
          lastErrorCode: classified.code,
          lastErrorMessage: classified.userMessage,
          ttlMs: 5 * 60 * 1000,
        },
        input.db
      );
    }

    return {
      ok: false,
      configured: true,
      modelId,
      latencyMs,
      videoSupported: classified.code !== 'MODEL_VIDEO_UNSUPPORTED',
      videoTested: Boolean(input.testVideo),
      structuredOutputSupported: classified.code !== 'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED',
      accessStatus,
      message: classified.userMessage,
      errorCode: classified.code,
      diagnostic: classified.diagnostic,
    };
  } finally {
    clearTimeout(timer);
    if (uploadedRemoteName && client.files) {
      try {
        await client.files.delete({ name: uploadedRemoteName });
      } catch {
        // best-effort probe cleanup
      }
    }
    if (tempProbePath && fs.existsSync(tempProbePath)) {
      try {
        fs.unlinkSync(tempProbePath);
      } catch {
        // ignore temp cleanup error
      }
    }
  }
}

export async function testGeminiConnection(
  requestedModelId?: string,
  options?: { testVideo?: boolean; forceRefresh?: boolean; clientOverride?: GeminiDiscoveryClientLike | null }
): Promise<GeminiConnectionTestResult> {
  const settings = getSettings();
  const routing = resolveEffectiveModelRouting(settings.ai);
  const modelId = normalizeModelId(requestedModelId) || routing.primaryModelId;
  return verifyModelCapabilities({
    modelId,
    testVideo: Boolean(options?.testVideo),
    forceRefresh: options?.forceRefresh ?? true,
    clientOverride: options?.clientOverride,
  });
}

// ============================================================
// Preflight Validation Gate (runs BEFORE any video upload)
// ============================================================

export interface RunAnalysisPreflightInput {
  matchId: string;
  sessionId?: string | null;
  half: 'first_half' | 'second_half';
  analysisMode?: VideoAnalysisMode;
  privacyAuthorized?: boolean;
  entireDisplayAcknowledged?: boolean;
  verifyLiveModelAccess?: boolean;
  isMockProvider?: boolean;
  allowedMediaDirs?: string[];
  clientOverride?: GeminiDiscoveryClientLike | null;
  db?: Database.Database;
}

export async function runAnalysisPreflight(
  input: RunAnalysisPreflightInput
): Promise<AnalysisPreflightResult> {
  const settings = getSettings();
  const analysisMode: VideoAnalysisMode =
    input.analysisMode ?? settings.ai.defaultAnalysisMode ?? 'balanced';
  const routing: EffectiveModelRouting = resolveEffectiveModelRouting(settings.ai, analysisMode);
  const checks: AnalysisPreflightCheck[] = [];

  let blockingErrorCode: string | null = null;
  let blockingMessage: string | null = null;
  let diagnostic: SanitizedGeminiErrorDiagnostic | null = null;

  const failCheck = (
    key: AnalysisPreflightCheck['key'],
    label: string,
    detail: string,
    errorCode: string,
    diag?: SanitizedGeminiErrorDiagnostic | null
  ) => {
    checks.push({ key, label, ok: false, blocking: true, detail, errorCode });
    if (!blockingErrorCode) {
      blockingErrorCode = errorCode;
      blockingMessage = detail;
      if (diag) diagnostic = diag;
    }
  };

  // 1. API Key Configured
  const apiKeyOk = Boolean(input.isMockProvider) || Boolean(input.clientOverride) || isGeminiApiConfigured();
  if (apiKeyOk) {
    checks.push({
      key: 'api_key',
      label: 'Server-side GEMINI_API_KEY',
      ok: true,
      blocking: true,
      detail: input.isMockProvider
        ? 'Mock Gemini provider active for automated verification.'
        : 'Server-side GEMINI_API_KEY is configured.',
    });
  } else {
    failCheck(
      'api_key',
      'Server-side GEMINI_API_KEY',
      'GEMINI_API_KEY is not configured in the local server environment (.env).',
      'INVALID_API_KEY'
    );
  }

  // 2. Effective Model Routing
  const routingOk =
    Boolean(routing.effectiveVideoModelId) &&
    Boolean(routing.effectiveSynthesisModelId) &&
    !isDeprecatedGeminiModelId(routing.effectiveVideoModelId) &&
    !isDeprecatedGeminiModelId(routing.effectiveSynthesisModelId);

  if (routingOk) {
    checks.push({
      key: 'model_routing',
      label: 'Effective Model Routing',
      ok: true,
      blocking: true,
      detail: `Video: ${routing.effectiveVideoModelId} · Synthesis: ${routing.effectiveSynthesisModelId} (${
        routing.usePrimaryModelForAllStages ? 'Primary Model Override' : 'Stage-Specific'
      })`,
    });
  } else {
    failCheck(
      'model_routing',
      'Effective Model Routing',
      routing.warnings[0] ?? 'Effective video or synthesis Gemini model is missing or deprecated.',
      'MODEL_NOT_FOUND'
    );
  }

  // 3 & 4. Model Access + Required Capabilities (video + structured JSON)
  if (routingOk && !isLikelyVideoCapableModelId(routing.effectiveVideoModelId)) {
    failCheck(
      'model_capabilities',
      'Model Video & Structured JSON Capabilities',
      `Model "${routing.effectiveVideoModelId}" does not support video input.`,
      'MODEL_VIDEO_UNSUPPORTED'
    );
  } else if (apiKeyOk && routingOk && input.verifyLiveModelAccess !== false && !input.isMockProvider) {
    const modelsToVerify = Array.from(
      new Set([routing.effectiveVideoModelId, routing.effectiveSynthesisModelId])
    );
    let accessFailed = false;
    for (const mid of modelsToVerify) {
      const checkRes = await verifyModelCapabilities({
        modelId: mid,
        testVideo: false,
        forceRefresh: false,
        timeoutMs: 20_000,
        clientOverride: input.clientOverride,
        db: input.db,
      });
      if (!checkRes.ok) {
        accessFailed = true;
        const code = checkRes.errorCode ?? 'MODEL_ACCESS_DENIED';
        failCheck(
          code === 'MODEL_VIDEO_UNSUPPORTED' || code === 'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED'
            ? 'model_capabilities'
            : 'model_access',
          `Model Verification (${mid})`,
          checkRes.message,
          code,
          checkRes.diagnostic ?? null
        );
        break;
      }
    }
    if (!accessFailed) {
      checks.push({
        key: 'model_access',
        label: 'Model Access Verification',
        ok: true,
        blocking: true,
        detail: `Verified API key access for ${modelsToVerify.join(', ')}.`,
      });
      checks.push({
        key: 'model_capabilities',
        label: 'Model Video & Structured JSON Capabilities',
        ok: true,
        blocking: true,
        detail: `Structured JSON confirmed and multimodal video compatibility supported for ${routing.effectiveVideoModelId}.`,
      });
    }
  } else if (routingOk) {
    checks.push({
      key: 'model_access',
      label: 'Model Access Verification',
      ok: true,
      blocking: false,
      detail: input.isMockProvider
        ? 'Mock provider bypassed live network verification.'
        : 'Model routing configured; live verification runs on launch.',
    });
    checks.push({
      key: 'model_capabilities',
      label: 'Model Video & Structured JSON Capabilities',
      ok: true,
      blocking: false,
      detail: `Video-capable model selected: ${routing.effectiveVideoModelId}.`,
    });
  }

  // 5. Recording Session Ownership
  const sessions = listMatchSessions({ matchId: input.matchId });
  const targetSession = input.sessionId
    ? getMatchSessionById(input.sessionId)
    : sessions.find(
        (s) =>
          s.half === input.half &&
          s.aiEligible &&
          ['completed', 'recovered', 'partial'].includes(s.status)
      ) ?? sessions.find((s) => s.half === input.half) ?? null;

  let validSegments: NonNullable<typeof targetSession>['segments'] = [];
  let totalDurationSeconds = 0;
  let totalBytes = 0;

  if (!targetSession) {
    failCheck(
      'session_ownership',
      'Recording Session Ownership',
      `No recorded ${input.half.replace('_', ' ')} session found for this match.`,
      'RECORDING_SESSION_MISMATCH'
    );
  } else if (targetSession.matchId !== input.matchId || targetSession.half !== input.half) {
    failCheck(
      'session_ownership',
      'Recording Session Ownership',
      `Recording session "${targetSession.id}" does not match target match/half.`,
      'RECORDING_SESSION_MISMATCH'
    );
  } else if (!targetSession.aiEligible || targetSession.segments.length === 0) {
    failCheck(
      'session_ownership',
      'Recording Session Ownership',
      `Recording session is not AI-eligible (${targetSession.failureReason ?? 'no verified MP4 segments'}).`,
      'MEDIA_INTEGRITY_FAILED'
    );
  } else {
    validSegments = targetSession.segments.filter(
      (s) => ['finalized', 'recovered'].includes(s.status) && s.sizeBytes > 0 && s.durationSeconds > 0
    );
    if (validSegments.length === 0) {
      failCheck(
        'session_ownership',
        'Recording Session Ownership',
        'Recording session has 0 valid non-empty video segments.',
        'MEDIA_INTEGRITY_FAILED'
      );
    } else {
      checks.push({
        key: 'session_ownership',
        label: 'Recording Session Ownership',
        ok: true,
        blocking: true,
        detail: `Session ${targetSession.id.slice(0, 8)} verified (${validSegments.length} segment(s)).`,
      });
    }
  }

  // 6. Local Media Integrity (path containment + FFprobe)
  if (targetSession && validSegments.length > 0) {
    let integrityFailed = false;
    for (const seg of validSegments) {
      try {
        const resolved = resolveRecordingSegmentMediaPath({
          matchId: input.matchId,
          expectedHalf: input.half,
          session: targetSession,
          segment: seg,
          extraAllowedDirs: input.allowedMediaDirs,
        });
        const probe = await validateVideoFile(resolved.resolvedPath, input.allowedMediaDirs);
        if (!probe.valid) {
          integrityFailed = true;
          failCheck(
            'local_media_integrity',
            'Local Media Integrity',
            `Segment #${seg.segmentIndex} failed FFprobe validation: ${probe.error ?? 'corrupted file'}`,
            'MEDIA_INTEGRITY_FAILED'
          );
          break;
        }
        totalDurationSeconds += probe.durationSeconds;
        totalBytes += probe.sizeBytes;
      } catch (err) {
        integrityFailed = true;
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code: string }).code)
            : 'MEDIA_FILE_NOT_FOUND';
        failCheck(
          'local_media_integrity',
          'Local Media Integrity',
          err instanceof Error ? err.message : 'Local media resolution failed.',
          code
        );
        break;
      }
    }
    if (!integrityFailed) {
      checks.push({
        key: 'local_media_integrity',
        label: 'Local Media Integrity',
        ok: true,
        blocking: true,
        detail: `${validSegments.length} MP4 segment(s) verified locally (${(totalBytes / (1024 * 1024)).toFixed(2)} MB, ${Math.round(totalDurationSeconds)}s).`,
      });
    }
  }

  // 7. Budget Guardrails
  const samplingFps =
    analysisMode === 'deep'
      ? settings.ai.samplingFpsDeep ?? 2.0
      : analysisMode === 'balanced'
        ? settings.ai.samplingFpsBalanced ?? 2.0
        : settings.ai.samplingFpsQuick ?? 1.0;

  const costEst = estimateVideoAnalysisCostUsd({
    modelVideoId: routing.effectiveVideoModelId || 'gemini-2.5-flash',
    modelSynthesisId: routing.effectiveSynthesisModelId || 'gemini-2.5-flash',
    totalDurationSeconds: Math.max(1, totalDurationSeconds),
    samplingFps,
    segmentCount: Math.max(1, validSegments.length),
  });

  const perMatchCap = settings.ai.perMatchBudgetUsd ?? 1.5;
  const dailyCap = settings.ai.dailyBudgetUsd ?? 5.0;
  const dailySpend = getDailyApiSpendUsd();
  const currentMatchSpend = dailySpend.matchSpendByMatchId[input.matchId] ?? 0;

  if (currentMatchSpend + costEst.estimatedCostUsd > perMatchCap) {
    failCheck(
      'budget_guardrails',
      'Budget Guardrails',
      `Estimated run ($${costEst.estimatedCostUsd.toFixed(4)}) + prior match spend ($${currentMatchSpend.toFixed(4)}) exceeds per-match cap ($${perMatchCap.toFixed(2)}).`,
      'QUOTA_EXCEEDED'
    );
  } else if (dailySpend.totalEstimatedUsd + costEst.estimatedCostUsd > dailyCap) {
    failCheck(
      'budget_guardrails',
      'Budget Guardrails',
      `Estimated run ($${costEst.estimatedCostUsd.toFixed(4)}) + today's spend ($${dailySpend.totalEstimatedUsd.toFixed(4)}) exceeds daily cap ($${dailyCap.toFixed(2)}).`,
      'QUOTA_EXCEEDED'
    );
  } else {
    checks.push({
      key: 'budget_guardrails',
      label: 'Budget Guardrails',
      ok: true,
      blocking: true,
      detail: `Est. $${costEst.estimatedCostUsd.toFixed(4)} within per-match ($${perMatchCap.toFixed(2)}) and daily ($${dailyCap.toFixed(2)}) caps.`,
    });
  }

  // 8. User Upload Authorization
  const isEntireDisplay = Boolean(
    targetSession?.captureSourceName?.toLowerCase().includes('screen') ||
      targetSession?.captureSourceName?.toLowerCase().includes('display') ||
      targetSession?.captureSourceName?.toLowerCase().includes('entire')
  );
  if (input.privacyAuthorized === false) {
    failCheck(
      'upload_authorization',
      'User Upload Authorization',
      'Explicit privacy authorization is required before uploading local gameplay footage.',
      'ANALYSIS_CANCELLED'
    );
  } else if (isEntireDisplay && input.entireDisplayAcknowledged === false) {
    failCheck(
      'upload_authorization',
      'User Upload Authorization',
      'Entire-display capture requires confirming that no sensitive desktop windows are visible.',
      'ANALYSIS_CANCELLED'
    );
  } else {
    checks.push({
      key: 'upload_authorization',
      label: 'User Upload Authorization',
      ok: true,
      blocking: false,
      detail:
        input.privacyAuthorized === true
          ? 'Upload privacy authorization confirmed.'
          : 'Awaiting user upload confirmation checkbox prior to launch.',
    });
  }

  return {
    ok: blockingErrorCode === null,
    matchId: input.matchId,
    sessionId: targetSession?.id ?? null,
    half: input.half,
    analysisMode,
    routing,
    estimatedCostUsd: costEst.estimatedCostUsd,
    perMatchBudgetUsd: perMatchCap,
    dailyBudgetUsd: dailyCap,
    segmentCount: validSegments.length,
    totalDurationSeconds: Number(totalDurationSeconds.toFixed(2)),
    totalBytes,
    checks,
    blockingErrorCode,
    blockingMessage,
    diagnostic,
  };
}
