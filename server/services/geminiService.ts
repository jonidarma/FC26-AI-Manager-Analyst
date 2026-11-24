import { GoogleGenAI } from '@google/genai';

export interface GeminiServiceStatus {
  configured: boolean;
  defaultModel: string;
  supportedModels: string[];
  phaseNote: string;
}

const SUPPORTED_MODELS = ['gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-carbon'];

export function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function getGeminiStatus(selectedModel: string): GeminiServiceStatus {
  const apiKey = process.env.GEMINI_API_KEY;
  const configured = Boolean(apiKey && apiKey.trim().length > 0 && apiKey !== 'MY_GEMINI_API_KEY');

  return {
    configured,
    defaultModel: SUPPORTED_MODELS.includes(selectedModel) ? selectedModel : 'gemini-4-hydrogen',
    supportedModels: SUPPORTED_MODELS,
    phaseNote:
      'Server-side @google/genai client initialized for Phase 3 two-stage multimodal video/frame evidence analysis. No live gameplay processing is permitted during active play.',
  };
}
