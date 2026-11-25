import { GoogleGenAI, Type } from '@google/genai';
import type {
  GeminiConnectionTestResult,
  GeminiModelCapability,
} from '../../src/types/domain.ts';

export interface GeminiServiceStatus {
  configured: boolean;
  defaultModel: string;
  supportedModels: string[];
  models: GeminiModelCapability[];
  phaseNote: string;
}

export const GEMINI_MODEL_REGISTRY: GeminiModelCapability[] = [
  {
    modelId: 'gemini-4-hydrogen',
    displayName: 'Gemini 4 Hydrogen (Default Multimodal)',
    availability: 'available_default',
    supportsVideoInput: true,
    supportsStructuredOutput: true,
    recommendedStages: ['classification', 'quick', 'balanced', 'deep', 'synthesis'],
    estimatedInputPricePer1MTokensUsd: 0.3,
    estimatedOutputPricePer1MTokensUsd: 2.5,
    pricingVerified: false,
    pricingNote:
      'Indicative estimate for local budget guardrails only — verify current billing rates in Google AI Studio.',
    description:
      'Default multimodal video + structured JSON reasoning model for Quick, Balanced, and Deep half-time analysis.',
  },
  {
    modelId: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite (Fast Screening)',
    availability: 'available_optional',
    supportsVideoInput: true,
    supportsStructuredOutput: true,
    recommendedStages: ['classification', 'quick'],
    estimatedInputPricePer1MTokensUsd: 0.1,
    estimatedOutputPricePer1MTokensUsd: 0.4,
    pricingVerified: false,
    pricingNote:
      'Indicative low-cost estimate for fast screening and quick half-time passes.',
    description:
      'Fast lightweight multimodal model suitable for rapid footage classification and low-latency quick passes.',
  },
  {
    modelId: 'gemini-4-neon',
    displayName: 'Gemini 4 Neon (Advanced Tactical Reasoning)',
    availability: 'requires_paid_tier',
    supportsVideoInput: true,
    supportsStructuredOutput: true,
    recommendedStages: ['deep', 'synthesis'],
    estimatedInputPricePer1MTokensUsd: 1.25,
    estimatedOutputPricePer1MTokensUsd: 10.0,
    pricingVerified: false,
    pricingNote:
      'Indicative paid-tier estimate. Requires a paid Gemini API key in Google AI Studio.',
    description:
      'High-capability tactical reasoning model for Deep match breakdowns and complex second-half comparisons.',
  },
  {
    modelId: 'gemini-4-carbon',
    displayName: 'Gemini 4 Carbon (Deep Strategic Analysis)',
    availability: 'requires_paid_tier',
    supportsVideoInput: true,
    supportsStructuredOutput: true,
    recommendedStages: ['deep', 'synthesis'],
    estimatedInputPricePer1MTokensUsd: 2.0,
    estimatedOutputPricePer1MTokensUsd: 12.0,
    pricingVerified: false,
    pricingNote:
      'Indicative paid-tier estimate. Requires a paid Gemini API key in Google AI Studio.',
    description:
      'Flagship deep reasoning model for comprehensive tactical synthesis and post-match evaluations.',
  },
];

const SUPPORTED_MODELS = GEMINI_MODEL_REGISTRY.map((m) => m.modelId);

export function getModelCapability(modelId: string): GeminiModelCapability {
  return (
    GEMINI_MODEL_REGISTRY.find((m) => m.modelId === modelId) ?? GEMINI_MODEL_REGISTRY[0]
  );
}

export function isSupportedGeminiModel(modelId: string): boolean {
  return SUPPORTED_MODELS.includes(modelId);
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

  // Conservative video token estimate (~260 tokens per sampled frame + prompt overhead)
  const sampledFrames = Math.max(1, Math.round(input.totalDurationSeconds * Math.max(0.25, input.samplingFps)));
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

export function isGeminiApiConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  return Boolean(apiKey && apiKey.trim().length > 0 && apiKey !== 'MY_GEMINI_API_KEY');
}

export function getGeminiStatus(selectedModel: string): GeminiServiceStatus {
  const configured = isGeminiApiConfigured();

  return {
    configured,
    defaultModel: SUPPORTED_MODELS.includes(selectedModel) ? selectedModel : 'gemini-4-hydrogen',
    supportedModels: SUPPORTED_MODELS,
    models: GEMINI_MODEL_REGISTRY,
    phaseNote: configured
      ? 'Server-side GEMINI_API_KEY detected. Phase 3 half-time multimodal video intelligence is ready for on-demand post-recording analysis.'
      : 'GEMINI_API_KEY is not configured in the server environment. Configure GEMINI_API_KEY in .env (server-side) before running real Gemini video analysis.',
  };
}

export function classifyGeminiError(err: unknown): {
  code: string;
  retryable: boolean;
  userMessage: string;
} {
  let msg: string;
  if (err instanceof Error) {
    const extra = err as Error & { status?: number | string; code?: string };
    msg = `${extra.status ?? ''} ${extra.code ?? ''} ${err.message}`.trim();
  } else if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    msg = `${rec.status ?? ''} ${rec.code ?? ''} ${rec.message ?? JSON.stringify(rec)}`.trim();
  } else {
    msg = String(err);
  }
  const lower = msg.toLowerCase();

  if (lower.includes('api_key_invalid') || lower.includes('api key not valid') || lower.includes('api key invalid') || lower.includes('401')) {
    return {
      code: 'AUTH_INVALID_KEY',
      retryable: false,
      userMessage: 'Gemini API authentication failed. Verify the server-side GEMINI_API_KEY value.',
    };
  }
  if (lower.includes('permission_denied') || lower.includes('403') || lower.includes('billing') || lower.includes('paid')) {
    return {
      code: 'PERMISSION_OR_TIER_DENIED',
      retryable: false,
      userMessage:
        'Gemini API denied access to the selected model or project tier. Verify billing/tier or select gemini-4-hydrogen.',
    };
  }
  if (lower.includes('not_found') || lower.includes('404') || lower.includes('model not found')) {
    return {
      code: 'MODEL_OR_FILE_NOT_FOUND',
      retryable: false,
      userMessage: 'Requested Gemini model or remote file was not found.',
    };
  }
  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota') || lower.includes('rate limit')) {
    return {
      code: 'RATE_LIMIT_OR_QUOTA',
      retryable: true,
      userMessage: 'Gemini API rate limit or quota reached. Retry after a short cooldown.',
    };
  }
  if (lower.includes('timeout') || lower.includes('deadline') || lower.includes('aborted')) {
    return {
      code: 'REQUEST_TIMEOUT',
      retryable: true,
      userMessage: 'Gemini API request timed out before completion.',
    };
  }
  if (lower.includes('fetch') || lower.includes('econnreset') || lower.includes('enotfound') || lower.includes('network') || lower.includes('503') || lower.includes('500')) {
    return {
      code: 'NETWORK_OR_UPSTREAM_TRANSIENT',
      retryable: true,
      userMessage: 'Transient network or Gemini service error occurred.',
    };
  }

  return {
    code: 'GEMINI_ANALYSIS_ERROR',
    retryable: false,
    userMessage: msg.slice(0, 320),
  };
}

export async function testGeminiConnection(requestedModelId?: string): Promise<GeminiConnectionTestResult> {
  const modelId =
    requestedModelId && isSupportedGeminiModel(requestedModelId)
      ? requestedModelId
      : 'gemini-4-hydrogen';
  const cap = getModelCapability(modelId);
  const started = Date.now();

  const client = createGeminiClient();
  if (!client) {
    return {
      ok: false,
      configured: false,
      modelId,
      latencyMs: Date.now() - started,
      videoSupported: cap.supportsVideoInput,
      structuredOutputSupported: cap.supportsStructuredOutput,
      message:
        'GEMINI_API_KEY is not set in the local server environment. Set GEMINI_API_KEY in .env and restart the desktop app.',
      errorCode: 'API_KEY_NOT_CONFIGURED',
    };
  }

  try {
    const response = await client.models.generateContent({
      model: modelId,
      contents: 'Respond with JSON {"ok": true, "note": "connected"}.',
      config: {
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
    return {
      ok: Boolean(parsed.ok),
      configured: true,
      modelId,
      latencyMs: Date.now() - started,
      videoSupported: cap.supportsVideoInput,
      structuredOutputSupported: cap.supportsStructuredOutput,
      message: `Connected to ${cap.displayName} (${Date.now() - started} ms). Structured JSON output verified.`,
    };
  } catch (err) {
    const classified = classifyGeminiError(err);
    return {
      ok: false,
      configured: true,
      modelId,
      latencyMs: Date.now() - started,
      videoSupported: cap.supportsVideoInput,
      structuredOutputSupported: cap.supportsStructuredOutput,
      message: classified.userMessage,
      errorCode: classified.code,
    };
  }
}
