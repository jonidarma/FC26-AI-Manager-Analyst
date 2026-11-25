import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  closeDb,
  deleteAllApplicationData,
  exportDatabaseBackup,
  getDatabaseMetadata,
  getDb,
  restoreDatabaseBackup,
} from './server/db/database.ts';
import {
  executeCatalogImport,
  previewCatalogImport,
  rollbackCatalogImportRun,
} from './server/services/catalogImporter.ts';
import {
  executeCatalogReconciliationFromPlayers,
  getCatalogCoverageReport,
  previewCatalogReconciliationFromPlayers,
} from './server/services/catalogReconciler.ts';
import * as catalogRepo from './server/services/catalogRepository.ts';
import {
  GEMINI_MODEL_REGISTRY,
  getGeminiStatus,
  testGeminiConnection,
} from './server/services/geminiService.ts';
import * as repo from './server/services/repository.ts';
import {
  buildAiMatchTacticalContext,
  validatePlayerRoleFocus,
} from './server/services/tacticalContextService.ts';
import * as tacticalVisionService from './server/services/tacticalVisionService.ts';
import * as aiOrchestrator from './server/services/aiAnalysisOrchestrator.ts';
import {
  assertConfinedMediaPath,
  getEvidenceFramesDir,
} from './server/services/videoPreprocessingService.ts';
import type { CatalogDatasetType } from './src/types/domain.ts';

const IS_DESKTOP_MODE = process.env.FC26_DESKTOP_MODE === '1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || IS_DESKTOP_MODE;
const IS_CLOUD_RUN = Boolean(process.env.K_SERVICE);

// Desktop mode ALWAYS binds strictly to 127.0.0.1 (never exposed to LAN).
// Local production also defaults to 127.0.0.1 unless running inside Cloud Run.
const HOST = IS_DESKTOP_MODE
  ? '127.0.0.1'
  : process.env.FC26_HOST ||
    process.env.HOST ||
    (IS_PRODUCTION && !IS_CLOUD_RUN ? '127.0.0.1' : '0.0.0.0');

const PORT = Number(process.env.FC26_PORT || process.env.PORT) || 3000;

// In Electron desktop mode, main process supplies a fresh 256-bit per-session token via FC26_API_TOKEN.
// In Browser Preview mode, an ephemeral in-memory token is generated per server boot.
const API_SESSION_TOKEN =
  process.env.FC26_API_TOKEN && process.env.FC26_API_TOKEN.trim().length >= 32
    ? process.env.FC26_API_TOKEN.trim()
    : crypto.randomBytes(32).toString('hex');

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isOriginAllowed(req: Request): boolean {
  const originHeader = req.headers.origin;
  if (!originHeader) {
    // Same-origin non-CORS requests or server-side health checks have no Origin header
    return true;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(originHeader);
  } catch {
    return false;
  }

  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    return false;
  }

  const expectedHosts = new Set<string>([
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
  ]);

  if (typeof req.headers.host === 'string' && req.headers.host.trim()) {
    expectedHosts.add(req.headers.host.trim().toLowerCase());
  }

  const forwardedHost = req.headers['x-forwarded-host'];
  if (typeof forwardedHost === 'string' && forwardedHost.trim()) {
    expectedHosts.add(forwardedHost.split(',')[0].trim().toLowerCase());
  }

  return expectedHosts.has(parsedOrigin.host.toLowerCase());
}

function apiSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}

function validateOriginMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isOriginAllowed(req)) {
    res.status(403).json({ error: 'Forbidden: request origin is not permitted.' });
    return;
  }
  next();
}

function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: missing Bearer session token.' });
    return;
  }

  const suppliedToken = authHeader.slice('Bearer '.length).trim();
  if (!constantTimeEquals(suppliedToken, API_SESSION_TOKEN)) {
    res.status(401).json({ error: 'Unauthorized: invalid session token.' });
    return;
  }

  next();
}

function requireDestructiveConfirmation(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-fc26-confirm-destructive'] !== 'true') {
    res.status(403).json({
      error: 'Forbidden: explicit destructive confirmation header is required.',
    });
    return;
  }
  next();
}

const clubSchema = z.object({
  name: z.string().trim().min(1).max(120),
  league: z.string().trim().max(120).default(''),
  nation: z.string().trim().max(100).default(''),
  catalogClubId: z.string().uuid().nullable().optional(),
  season: z.string().trim().min(1).max(40).default('2025/26'),
  managerName: z.string().trim().max(100).default(''),
  preferredPhilosophy: z.string().trim().max(120).default('Balanced Positional Play'),
  primaryFormation: z.string().trim().min(1).max(60).default('4-3-3 Holding'),
  alternativeFormation: z.string().trim().max(60).default('4-2-3-1 Wide'),
  preferredAttackingStyle: z.string().trim().max(80).default('Balanced'),
  preferredDefensiveStyle: z.string().trim().max(80).default('Balanced'),
  primaryTacticalVisionKey: z.string().trim().max(60).optional(),
  alternativeTacticalVisionKey: z.string().trim().max(60).nullable().optional(),
  preferredBuildUpStyle: z.string().trim().max(80).optional(),
  preferredDefensiveApproach: z.string().trim().max(80).optional(),
  preferredDefensiveLineHeight: z.number().int().min(1).max(100).optional(),
  tacticalPhilosophyNotes: z.string().trim().max(1200).optional(),
  tacticalFlexibility: z
    .preprocess(
      (val) => (val === 'flexible' ? 'pragmatic' : val),
      z.enum(['strict', 'balanced', 'pragmatic'])
    )
    .optional(),
  setActive: z.boolean().optional(),
  rosterInitMode: z.enum(['default_roster', 'empty']).optional(),
});

const squadStatusEnum = z.enum([
  'active',
  'loaned_in',
  'loaned_out',
  'transferred_out',
  'youth_academy',
  'released',
]);

const playerAvailabilityEnum = z.enum([
  'available',
  'injured',
  'suspended',
  'doubtful',
  'unavailable',
]);

const playerSchema = z.object({
  clubId: z.string().uuid(),
  catalogPlayerId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  displayNameOverride: z.string().trim().max(100).nullable().optional(),
  shortName: z.string().trim().max(100).nullable().optional(),
  fullName: z.string().trim().max(140).nullable().optional(),
  position: z.string().trim().min(1).max(12),
  secondaryPositions: z.array(z.string().trim().min(1).max(12)).max(6).optional(),
  squadNumber: z.number().int().min(1).max(99).nullable().optional(),
  squadStatus: squadStatusEnum.optional(),
  availability: playerAvailabilityEnum.optional(),
  seniorSelectionAuthorized: z.boolean().optional(),
  injuryStatus: z.string().trim().max(200).nullable().optional(),
  suspensionStatus: z.string().trim().max(200).nullable().optional(),
  membershipStartDate: z.string().trim().max(32).nullable().optional(),
  membershipEndDate: z.string().trim().max(32).nullable().optional(),
  overallRating: z.number().int().min(1).max(99).nullable().default(null),
  potentialRating: z.number().int().min(1).max(99).nullable().optional(),
  age: z.number().int().min(14).max(55).nullable().optional(),
  preferredFoot: z.enum(['Right', 'Left', 'Both']).default('Right'),
  playerRole: z.string().trim().max(80).default(''),
  playerFocus: z.string().trim().max(80).default(''),
  contractExpiry: z.string().trim().max(20).nullable().optional(),
  marketValueEur: z.number().int().min(0).nullable().optional(),
  wageEur: z.number().int().min(0).nullable().optional(),
  strengths: z.string().trim().max(400).default(''),
  weaknesses: z.string().trim().max(400).default(''),
  preferredInstructions: z.string().trim().max(400).default(''),
  notes: z.string().trim().max(1000).optional(),
});

const importPlayerFromCatalogSchema = z.object({
  catalogPlayerId: z.string().uuid(),
  displayNameOverride: z.string().trim().max(100).nullable().optional(),
  position: z.string().trim().min(1).max(12).optional(),
  squadNumber: z.number().int().min(1).max(99).nullable().optional(),
  squadStatus: squadStatusEnum.optional(),
  availability: playerAvailabilityEnum.optional(),
  injuryStatus: z.string().trim().max(200).nullable().optional(),
  suspensionStatus: z.string().trim().max(200).nullable().optional(),
  membershipStartDate: z.string().trim().max(32).nullable().optional(),
  membershipEndDate: z.string().trim().max(32).nullable().optional(),
  overallRating: z.number().int().min(1).max(99).nullable().optional(),
  potentialRating: z.number().int().min(1).max(99).nullable().optional(),
  age: z.number().int().min(14).max(55).nullable().optional(),
  playerRole: z.string().trim().max(80).optional(),
  playerFocus: z.string().trim().max(80).optional(),
  contractExpiry: z.string().trim().max(20).nullable().optional(),
  strengths: z.string().trim().max(400).optional(),
  weaknesses: z.string().trim().max(400).optional(),
  preferredInstructions: z.string().trim().max(400).optional(),
  notes: z.string().trim().max(1000).optional(),
});

const tacticalPresetAssignmentSchema = z.object({
  slotOrder: z.number().int().min(0).max(10),
  slotId: z.string().trim().max(16).optional(),
  positionCode: z.string().trim().min(1).max(12),
  playerId: z.string().uuid().nullable(),
  role: z.string().trim().max(80).default(''),
  focus: z.string().trim().max(80).default(''),
});

const tacticalPresetCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  formationId: z.string().uuid().nullable().optional(),
  formationName: z.string().trim().min(1).max(60),
  tacticalVisionKey: z.string().trim().max(60).optional(),
  buildUpStyle: z.string().trim().min(1).max(80),
  defensiveApproach: z.string().trim().min(1).max(80),
  defensiveLineHeight: z.number().int().min(1).max(100),
  isDefault: z.boolean().optional(),
  presetStatus: z.enum(['draft', 'match_ready']).optional(),
  benchPlayerIds: z.array(z.string().uuid()).max(12).optional(),
  confirmedDoubtfulPlayerIds: z.array(z.string().uuid()).max(23).optional(),
  notes: z.string().trim().max(1200).optional(),
  assignments: z.array(tacticalPresetAssignmentSchema).max(11).default([]),
});

const tacticalPresetUpdateSchema = tacticalPresetCreateSchema.partial();

const opponentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  league: z.string().trim().max(120).default(''),
  catalogClubId: z.string().uuid().nullable().optional(),
  typicalFormation: z.string().trim().max(60).default('Unknown'),
  strengths: z.string().trim().max(600).default(''),
  weaknesses: z.string().trim().max(600).default(''),
  dangerousChannels: z.string().trim().max(400).default(''),
  notes: z.string().trim().max(1000).default(''),
});

const roleAssignmentSchema = z.object({
  slotIndex: z.number().int().min(0).max(10),
  slotId: z.string().trim().max(16).optional(),
  positionCode: z.string().trim().min(1).max(12),
  playerId: z.string().uuid().nullable(),
  playerName: z.string().max(120).nullable(),
  role: z.string().trim().max(80),
  focus: z.string().trim().max(80),
});

const matchCreateSchema = z.object({
  clubId: z.string().uuid(),
  careerProfileId: z.string().uuid(),
  opponentId: z.string().uuid().optional(),
  opponentName: z.string().trim().max(120).optional(),
  competition: z.string().trim().min(1).max(120),
  venue: z.enum(['home', 'away', 'neutral']),
  matchDate: z.string().trim().min(4).max(32),
  startingFormation: z.string().trim().min(1).max(60),
  startingXiIds: z.array(z.string().uuid()).max(11).default([]),
  benchIds: z.array(z.string().uuid()).max(12).default([]),
  confirmedDoubtfulPlayerIds: z.array(z.string().uuid()).max(23).optional(),
  objective: z.string().trim().max(300).default(''),
  preMatchNotes: z.string().trim().max(1500).default(''),
  sourcePresetId: z.string().uuid().nullable().optional(),
  tacticalSetup: z.object({
    formationId: z.string().uuid().nullable().optional(),
    tacticalVisionKey: z.string().trim().max(60).optional(),
    buildUpStyle: z.string().trim().min(1).max(80),
    defensiveApproach: z.string().trim().min(1).max(80),
    defensiveLineHeight: z.number().int().min(1).max(100),
    playerAssignments: z.array(roleAssignmentSchema).max(11).default([]),
    customParameters: z.record(z.string(), z.string()).optional(),
  }),
});

const matchTacticalSnapshotInputSchema = z.object({
  sourcePresetId: z.string().uuid().nullable().optional(),
  formationId: z.string().uuid().nullable().optional(),
  formationName: z.string().trim().min(1).max(60),
  tacticalVisionKey: z.string().trim().max(60).optional(),
  buildUpStyle: z.string().trim().min(1).max(80),
  defensiveApproach: z.string().trim().min(1).max(80),
  defensiveLineHeight: z.number().int().min(1).max(100),
  playerAssignments: z.array(roleAssignmentSchema).max(11).default([]),
  benchIds: z.array(z.string().uuid()).max(12).optional(),
  confirmedDoubtfulPlayerIds: z.array(z.string().uuid()).max(23).optional(),
  appliedInGameConfirmed: z.boolean().optional(),
  notes: z.string().trim().max(1500).optional(),
});

const matchUpdateSchema = z.object({
  status: z
    .enum(['scheduled', 'first_half_recording', 'halftime_ready', 'second_half_recording', 'completed'])
    .optional(),
  halftimeScoreFor: z.number().int().min(0).max(50).nullable().optional(),
  halftimeScoreAgainst: z.number().int().min(0).max(50).nullable().optional(),
  finalScoreFor: z.number().int().min(0).max(50).nullable().optional(),
  finalScoreAgainst: z.number().int().min(0).max(50).nullable().optional(),
  preMatchNotes: z.string().max(1500).optional(),
  objective: z.string().max(300).optional(),
});

const settingsPatchSchema = z.object({
  capture: z
    .object({
      resolution: z.enum(['1920x1080', '1280x720']).optional(),
      fallbackResolution: z.enum(['1280x720']).optional(),
      fps: z.number().int().min(5).max(60).optional(),
      bitrateKbps: z.number().int().min(1000).max(20000).optional(),
      format: z.enum(['mp4']).optional(),
      codec: z.enum(['h264']).optional(),
      audioEnabled: z.boolean().optional(),
      segmentDurationMinutes: z.number().int().min(2).max(5).optional(),
      maxRecordingMinutes: z.number().int().min(5).max(120).optional(),
      storageDirectory: z.string().trim().min(1).max(260).optional(),
      autoRecoveryEnabled: z.boolean().optional(),
    })
    .optional(),
  ai: z
    .object({
      modelId: z.string().trim().min(1).max(100).optional(),
      quickModelId: z.string().trim().min(1).max(100).optional(),
      balancedModelId: z.string().trim().min(1).max(100).optional(),
      deepModelId: z.string().trim().min(1).max(100).optional(),
      synthesisModelId: z.string().trim().min(1).max(100).optional(),
      defaultAnalysisMode: z.enum(['quick', 'balanced', 'deep']).optional(),
      defaultLanguage: z.enum(['en', 'id']).optional(),
      analysisQuality: z.enum(['balanced', 'detailed', 'compact']).optional(),
      maxEvidenceFrames: z.number().int().min(4).max(60).optional(),
      samplingFps: z.number().min(0.25).max(5).optional(),
      downscaleTo720pForAnalysis: z.boolean().optional(),
      maxConcurrentSegments: z.number().int().min(1).max(4).optional(),
      perStageTimeoutSeconds: z.number().int().min(30).max(600).optional(),
      maxRetriesPerStage: z.number().int().min(0).max(5).optional(),
      perMatchBudgetUsd: z.number().min(0.01).max(25).optional(),
      dailyBudgetUsd: z.number().min(0.05).max(100).optional(),
      removeDuplicateFrames: z.boolean().optional(),
      requireUploadConfirmation: z.boolean().optional(),
      deleteRemoteAfterAnalysis: z.boolean().optional(),
    })
    .optional(),
  activeClubId: z.string().uuid().nullable().optional(),
});

const memoryCreateSchema = z.object({
  clubId: z.string().uuid(),
  matchId: z.string().uuid().nullable().optional(),
  opponentId: z.string().uuid().nullable().optional(),
  category: z.enum([
    'recurring_weakness',
    'successful_pattern',
    'formation_insight',
    'opponent_tendency',
  ]),
  title: z.string().trim().min(1).max(160),
  detail: z.string().trim().min(1).max(1200),
  confidence: z.enum(['High', 'Medium', 'Low']).default('Medium'),
});

const catalogCreateSchema = z.object({
  category: z.enum(['formation', 'build_up', 'defensive_approach', 'player_role', 'player_focus']),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
});

const feedbackSchema = z.object({
  choice: z.enum(['applied_all', 'applied_some', 'not_applied', 'custom_changes']),
  notes: z.string().max(1000).default(''),
});

async function startServer() {
  // Initialize SQLite database and run versioned migrations on startup
  getDb();
  // Mark any orphaned active AI analysis jobs from a prior app shutdown/crash as interrupted
  aiOrchestrator.markInterruptedJobsOnStartup();

  const app = express();
  app.disable('x-powered-by');
  // Raw binary upload strictly for Browser Preview test MP4 clip import (confined & FFprobe-validated)
  app.use(
    '/api/matches/:id/test-video-import',
    express.raw({ type: ['video/mp4', 'application/octet-stream'], limit: '60mb' })
  );
  // Higher payload limit strictly for large CSV/JSON catalog imports (20,000+ players x 110+ columns)
  app.use('/api/catalog/import', express.json({ limit: '60mb' }));
  app.use('/api/database/restore', express.json({ limit: '60mb' }));
  app.use(express.json({ limit: '5mb' }));

  // Apply security headers & strict origin checks to all API routes
  app.use('/api', apiSecurityHeaders, validateOriginMiddleware);

  // Minimal readiness endpoint for Electron main process startup health checks (no sensitive data)
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      mode: IS_DESKTOP_MODE ? 'electron-desktop' : 'browser-preview',
      boundHost: HOST,
    });
  });

  // Ephemeral session token bootstrap strictly for Browser Preview same-origin requests.
  // Disabled in Electron desktop mode where the token is delivered solely via preload IPC.
  app.get('/api/auth/session', (req, res) => {
    if (IS_DESKTOP_MODE) {
      res.status(403).json({
        error: 'Session bootstrap is disabled in Electron desktop mode; use preload IPC.',
      });
      return;
    }

    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      res.status(403).json({ error: 'Cross-site session bootstrap rejected.' });
      return;
    }

    res.json({
      token: API_SESSION_TOKEN,
      mode: 'browser-preview',
    });
  });

  // Protect ALL remaining /api/* routes with Bearer session authentication
  app.use('/api', requireApiAuth);

  // System & status endpoint
  app.get('/api/system/status', (_req, res) => {
    const settings = repo.getSettings();
    const dbMeta = getDatabaseMetadata();
    const gemini = getGeminiStatus(settings.ai.modelId);
    res.json({
      runtime: IS_DESKTOP_MODE ? 'electron-desktop-backend' : 'server-web-preview',
      boundHost: HOST,
      database: dbMeta,
      gemini,
    });
  });

  // Dashboard summary
  app.get('/api/dashboard', (_req, res) => {
    res.json(repo.getDashboardSummary());
  });

  // Clubs & Career Profiles
  app.get('/api/clubs', (_req, res) => {
    res.json(repo.listClubs());
  });

  app.post('/api/clubs', (req, res) => {
    const parsed = clubSchema.safeParse(req.body);
    if (!parsed.success) {
      const flattened = parsed.error.flatten();
      const badFields = Object.keys(flattened.fieldErrors).join(', ');
      return res.status(400).json({
        error: badFields ? `Invalid club data (${badFields})` : 'Invalid club data',
        details: flattened,
      });
    }
    const created = repo.createClub(parsed.data);
    return res.status(201).json(created);
  });

  app.put('/api/clubs/:id', (req, res) => {
    const parsed = clubSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      const flattened = parsed.error.flatten();
      const badFields = Object.keys(flattened.fieldErrors).join(', ');
      return res.status(400).json({
        error: badFields ? `Invalid club update (${badFields})` : 'Invalid club update',
        details: flattened,
      });
    }
    const updated = repo.updateClub(req.params.id, parsed.data);
    if (!updated) return res.status(404).json({ error: 'Club not found' });
    return res.json(updated);
  });

  app.post('/api/clubs/:id/activate', (req, res) => {
    const activated = repo.setActiveClub(req.params.id);
    if (!activated) return res.status(404).json({ error: 'Club not found' });
    return res.json(activated);
  });

  app.delete('/api/clubs/:id', (req, res) => {
    const deleted = repo.deleteClub(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Club not found' });
    return res.json({ deleted: true });
  });

  // Squad Players
  app.get('/api/clubs/:clubId/players', (req, res) => {
    res.json(repo.listPlayers(req.params.clubId));
  });

  app.post('/api/players', (req, res) => {
    const parsed = playerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid player data', details: parsed.error.flatten() });
    }
    const created = repo.createPlayer(parsed.data);
    return res.status(201).json(created);
  });

  app.put('/api/players/:id', (req, res) => {
    const parsed = playerSchema.omit({ clubId: true }).partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid player update', details: parsed.error.flatten() });
    }
    const updated = repo.updatePlayer(req.params.id, parsed.data);
    if (!updated) return res.status(404).json({ error: 'Player not found' });
    return res.json(updated);
  });

  app.post('/api/clubs/:clubId/players/from-catalog', (req, res) => {
    const parsed = importPlayerFromCatalogSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid catalog player import payload', details: parsed.error.flatten() });
    }
    const { catalogPlayerId, ...overrides } = parsed.data;
    const created = repo.importPlayerFromCatalog(req.params.clubId, catalogPlayerId, overrides);
    if (!created) {
      return res.status(404).json({ error: 'Catalog player not found' });
    }
    return res.status(201).json(created);
  });

  app.delete('/api/players/:id', (req, res) => {
    const deleted = repo.deletePlayer(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Player not found' });
    return res.json({ deleted: true });
  });

  // Phase 2.1 — Default Club Roster Initialization & Import
  app.get('/api/catalog/clubs/:catalogClubId/default-roster-preview', (req, res) => {
    try {
      return res.json(repo.previewDefaultClubRosterByCatalogClubId(req.params.catalogClubId));
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to preview default roster',
      });
    }
  });

  app.get('/api/clubs/:clubId/default-roster/preview', (req, res) => {
    try {
      return res.json(repo.previewDefaultClubRoster(req.params.clubId));
    } catch (err) {
      return res.status(404).json({
        error: err instanceof Error ? err.message : 'Failed to preview club default roster',
      });
    }
  });

  app.post('/api/clubs/:clubId/default-roster/import', (req, res) => {
    try {
      return res.json(repo.importDefaultClubRoster(req.params.clubId));
    } catch (err) {
      return res.status(404).json({
        error: err instanceof Error ? err.message : 'Failed to import club default roster',
      });
    }
  });

  // Phase 2.1 — Club Tactical Presets
  app.get('/api/clubs/:clubId/tactical-presets', (req, res) => {
    return res.json(repo.listTacticalPresets(req.params.clubId));
  });

  app.post('/api/clubs/:clubId/tactical-presets', (req, res) => {
    const parsed = tacticalPresetCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid tactical preset payload', details: parsed.error.flatten() });
    }
    try {
      const created = repo.createTacticalPreset(req.params.clubId, parsed.data);
      return res.status(201).json(created);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to create tactical preset',
      });
    }
  });

  app.put('/api/tactical-presets/:id', (req, res) => {
    const parsed = tacticalPresetUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid tactical preset update', details: parsed.error.flatten() });
    }
    try {
      const updated = repo.updateTacticalPreset(req.params.id, parsed.data);
      if (!updated) return res.status(404).json({ error: 'Tactical preset not found' });
      return res.json(updated);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to update tactical preset',
      });
    }
  });

  app.post('/api/tactical-presets/:id/duplicate', (req, res) => {
    const customName = typeof req.body?.name === 'string' ? req.body.name : undefined;
    try {
      const duplicated = repo.duplicateTacticalPreset(req.params.id, customName);
      if (!duplicated) return res.status(404).json({ error: 'Tactical preset not found' });
      return res.status(201).json(duplicated);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to duplicate tactical preset',
      });
    }
  });

  app.post('/api/tactical-presets/:id/set-default', (req, res) => {
    const updated = repo.setDefaultTacticalPreset(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Tactical preset not found' });
    return res.json(updated);
  });

  app.delete('/api/tactical-presets/:id', (req, res) => {
    const deleted = repo.deleteTacticalPreset(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Tactical preset not found' });
    return res.json({ deleted: true });
  });

  // Opponents
  app.get('/api/opponents', (_req, res) => {
    res.json(repo.listOpponents());
  });

  app.post('/api/opponents', (req, res) => {
    const parsed = opponentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid opponent data', details: parsed.error.flatten() });
    }
    return res.status(201).json(repo.createOpponent(parsed.data));
  });

  app.put('/api/opponents/:id', (req, res) => {
    const parsed = opponentSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid opponent update', details: parsed.error.flatten() });
    }
    const updated = repo.updateOpponent(req.params.id, parsed.data);
    if (!updated) return res.status(404).json({ error: 'Opponent not found' });
    return res.json(updated);
  });

  app.delete('/api/opponents/:id', (req, res) => {
    const result = repo.deleteOpponent(req.params.id);
    if (!result.deleted) {
      return res.status(409).json({ error: result.error ?? 'Opponent not found' });
    }
    return res.json({ deleted: true });
  });

  // Matches
  app.get('/api/matches', (req, res) => {
    const clubId = typeof req.query.clubId === 'string' ? req.query.clubId : undefined;
    res.json(repo.listMatches(clubId));
  });

  app.post('/api/matches', (req, res) => {
    const parsed = matchCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid match configuration', details: parsed.error.flatten() });
    }
    try {
      const created = repo.createMatch(parsed.data);
      return res.status(201).json(created);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create match' });
    }
  });

  app.patch('/api/matches/:id', (req, res) => {
    const parsed = matchUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid match update', details: parsed.error.flatten() });
    }
    const updated = repo.updateMatchResult(req.params.id, parsed.data);
    if (!updated) return res.status(404).json({ error: 'Match not found' });
    return res.json(updated);
  });

  app.delete('/api/matches/:id', (req, res) => {
    const deleted = repo.deleteMatch(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Match not found' });
    return res.json({ deleted: true });
  });

  // Phase 2.1 — Immutable Match Tactical Snapshots & In-Match Adjustments
  app.get('/api/matches/:id/tactical-snapshots', (req, res) => {
    return res.json(repo.listMatchTacticalSnapshots(req.params.id));
  });

  app.put('/api/matches/:id/tactical-snapshot', (req, res) => {
    const parsed = matchTacticalSnapshotInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid pre-match tactical snapshot payload', details: parsed.error.flatten() });
    }
    try {
      const updated = repo.updatePreMatchTacticalSnapshot(req.params.id, parsed.data);
      return res.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update tactical snapshot';
      const status = message.toLowerCase().includes('locked') ? 409 : 400;
      return res.status(status).json({ error: message });
    }
  });

  app.post('/api/matches/:id/tactical-adjustments', (req, res) => {
    const parsed = matchTacticalSnapshotInputSchema.omit({ sourcePresetId: true }).safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid in-match tactical adjustment payload', details: parsed.error.flatten() });
    }
    try {
      const created = repo.createInMatchTacticalAdjustment(req.params.id, parsed.data);
      return res.status(201).json(created);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to save in-match tactical adjustment',
      });
    }
  });

  // Reports & Feedback
  app.get('/api/reports/halftime', (_req, res) => {
    res.json(repo.listAllHalftimeReports());
  });

  app.get('/api/matches/:id/halftime-report', (req, res) => {
    const report = repo.getHalftimeReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'No half-time report found for this match' });
    return res.json(report);
  });

  app.get('/api/reports/post-match', (req, res) => {
    const clubId = typeof req.query.clubId === 'string' ? req.query.clubId : undefined;
    res.json(repo.listPostMatchReports(clubId));
  });

  app.get('/api/feedback', (req, res) => {
    const clubId = typeof req.query.clubId === 'string' ? req.query.clubId : undefined;
    res.json(repo.listRecommendationFeedback(clubId));
  });

  app.post('/api/matches/:id/feedback', (req, res) => {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid feedback payload', details: parsed.error.flatten() });
    }
    const saved = repo.saveRecommendationFeedback(req.params.id, parsed.data.choice, parsed.data.notes);
    return res.json(saved);
  });

  // Tactical Memory
  app.get('/api/clubs/:clubId/tactical-memory', (req, res) => {
    res.json(repo.listTacticalMemory(req.params.clubId));
  });

  app.post('/api/tactical-memory', (req, res) => {
    const parsed = memoryCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid tactical memory entry', details: parsed.error.flatten() });
    }
    return res.status(201).json(repo.createTacticalMemoryEntry(parsed.data));
  });

  app.delete('/api/tactical-memory/:id', (req, res) => {
    const deleted = repo.deleteTacticalMemoryEntry(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Memory entry not found' });
    return res.json({ deleted: true });
  });

  // Editable FC26 Tactical Catalog
  app.get('/api/tactical-catalog', (_req, res) => {
    res.json(repo.listTacticalCatalog());
  });

  app.post('/api/tactical-catalog', (req, res) => {
    const parsed = catalogCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid catalog entry', details: parsed.error.flatten() });
    }
    try {
      return res.status(201).json(repo.createTacticalCatalogItem(parsed.data));
    } catch {
      return res.status(409).json({ error: 'Catalog item with this name already exists in this category.' });
    }
  });

  app.delete('/api/tactical-catalog/:id', (req, res) => {
    const deleted = repo.deleteTacticalCatalogItem(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Catalog item not found' });
    return res.json({ deleted: true });
  });

  // ============================================================
  // Phase 1.2 — EA SPORTS FC 26 Master Reference Database API
  // ============================================================

  const importDatasetTypeSchema = z.enum([
    'nations',
    'leagues',
    'clubs',
    'players',
    'formations',
    'positions',
    'roles',
    'focuses',
    'sources',
  ]);

  const catalogImportPreviewSchema = z.object({
    datasetType: importDatasetTypeSchema,
    format: z.enum(['json', 'csv']),
    rawContent: z.string().min(1),
  });

  const catalogImportExecuteSchema = catalogImportPreviewSchema.extend({
    fileName: z.string().trim().max(180).optional(),
    sourceKey: z.string().trim().max(80).optional(),
    datasetVersion: z.string().trim().max(60).optional(),
    completeness: z
      .enum(['verified_complete', 'partial_baseline', 'user_imported', 'empty_awaiting_user_import'])
      .optional(),
    mode: z.enum(['upsert', 'insert_only', 'replace_dataset']).optional(),
  });

  const formationSlotsUpdateSchema = z.object({
    slots: z
      .array(
        z.object({
          slotOrder: z.number().int().min(0).max(10),
          x: z.number().min(5).max(95),
          y: z.number().min(8).max(94),
        })
      )
      .min(1)
      .max(11),
  });

  const roleFocusValidateSchema = z.object({
    positionCode: z.string().trim().min(1).max(12),
    role: z.string().trim().max(80).default(''),
    focus: z.string().trim().max(80).default(''),
  });

  const parseOptionalInt = (val: unknown): number | undefined => {
    if (typeof val !== 'string' || !val.trim()) return undefined;
    const n = Number(val);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  };

  app.get('/api/catalog/overview', (_req, res) => {
    res.json(catalogRepo.getCatalogOverview());
  });

  app.get('/api/catalog/sources', (_req, res) => {
    res.json(catalogRepo.listCatalogSources());
  });

  app.get('/api/catalog/import-runs', (_req, res) => {
    res.json(catalogRepo.listImportRuns());
  });

  app.get('/api/catalog/positions', (_req, res) => {
    res.json(catalogRepo.listCatalogPositions());
  });

  app.get('/api/catalog/nations', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const region = typeof req.query.region === 'string' ? req.query.region : undefined;
    res.json(catalogRepo.listCatalogNations({ q, region }));
  });

  app.get('/api/catalog/leagues', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const countryId = typeof req.query.countryId === 'string' ? req.query.countryId : undefined;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    res.json(catalogRepo.listCatalogLeagues({ q, countryId, category }));
  });

  app.get('/api/catalog/clubs', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const leagueId = typeof req.query.leagueId === 'string' ? req.query.leagueId : undefined;
    const nationId = typeof req.query.nationId === 'string' ? req.query.nationId : undefined;
    const teamCategory =
      req.query.teamCategory === 'mens' || req.query.teamCategory === 'womens'
        ? req.query.teamCategory
        : '';
    const sortBy =
      typeof req.query.sortBy === 'string' &&
      ['name', 'code', 'category', 'league', 'nation', 'players'].includes(req.query.sortBy)
        ? (req.query.sortBy as catalogRepo.ClubSortBy)
        : 'name';
    const sortDir = req.query.sortDir === 'desc' ? 'desc' : 'asc';
    const page = parseOptionalInt(req.query.page) ?? 1;
    const pageSize = parseOptionalInt(req.query.pageSize) ?? 40;
    res.json(
      catalogRepo.searchCatalogClubs({
        q,
        leagueId,
        nationId,
        teamCategory,
        sortBy,
        sortDir,
        page,
        pageSize,
      })
    );
  });

  app.get('/api/catalog/players', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const positionsParam = typeof req.query.positions === 'string' ? req.query.positions : '';
    const positions = positionsParam
      ? positionsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const clubId = typeof req.query.clubId === 'string' ? req.query.clubId : undefined;
    const leagueId = typeof req.query.leagueId === 'string' ? req.query.leagueId : undefined;
    const nationId = typeof req.query.nationId === 'string' ? req.query.nationId : undefined;
    const preferredFoot =
      req.query.preferredFoot === 'Right' ||
      req.query.preferredFoot === 'Left' ||
      req.query.preferredFoot === 'Both'
        ? req.query.preferredFoot
        : '';
    const sortBy =
      typeof req.query.sortBy === 'string' &&
      [
        'overall',
        'potential',
        'growth',
        'age',
        'name',
        'pace',
        'market_value',
        'position',
        'club',
      ].includes(req.query.sortBy)
        ? (req.query.sortBy as catalogRepo.PlayerSearchFilters['sortBy'])
        : 'overall';
    const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';

    res.json(
      catalogRepo.searchCatalogPlayers({
        q,
        positions,
        clubId,
        leagueId,
        nationId,
        minOvr: parseOptionalInt(req.query.minOvr),
        maxOvr: parseOptionalInt(req.query.maxOvr),
        minPot: parseOptionalInt(req.query.minPot),
        maxPot: parseOptionalInt(req.query.maxPot),
        minAge: parseOptionalInt(req.query.minAge),
        maxAge: parseOptionalInt(req.query.maxAge),
        preferredFoot,
        sortBy,
        sortDir,
        page: parseOptionalInt(req.query.page) ?? 1,
        pageSize: parseOptionalInt(req.query.pageSize) ?? 30,
      })
    );
  });

  app.get('/api/catalog/players/:id', (req, res) => {
    const player = catalogRepo.getCatalogPlayerById(req.params.id);
    if (!player) return res.status(404).json({ error: 'Catalog player not found' });
    return res.json(player);
  });

  app.get('/api/catalog/formations', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    res.json(catalogRepo.listCatalogFormations({ q, category }));
  });

  app.get('/api/catalog/formations/:id', (req, res) => {
    const formation = catalogRepo.getCatalogFormationByIdOrName(req.params.id);
    if (!formation) return res.status(404).json({ error: 'Catalog formation not found' });
    return res.json(formation);
  });

  app.put('/api/catalog/formations/:id/slots', (req, res) => {
    const parsed = formationSlotsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid slot coordinate payload', details: parsed.error.flatten() });
    }
    const updated = catalogRepo.updateFormationSlotCoordinates(req.params.id, parsed.data.slots);
    if (!updated) return res.status(404).json({ error: 'Catalog formation not found' });
    return res.json(updated);
  });

  app.get('/api/catalog/roles', (req, res) => {
    const positionCode =
      typeof req.query.positionCode === 'string' ? req.query.positionCode : undefined;
    res.json(catalogRepo.listCatalogRoles(positionCode));
  });

  app.get('/api/catalog/focuses', (req, res) => {
    const roleName = typeof req.query.roleName === 'string' ? req.query.roleName : undefined;
    const positionCode =
      typeof req.query.positionCode === 'string' ? req.query.positionCode : undefined;
    res.json(catalogRepo.listCatalogFocuses({ roleName, positionCode }));
  });

  app.get('/api/catalog/compatibility', (req, res) => {
    const positionCode =
      typeof req.query.positionCode === 'string' ? req.query.positionCode : undefined;
    const roleName = typeof req.query.roleName === 'string' ? req.query.roleName : undefined;
    res.json(catalogRepo.getRoleFocusCompatibilityMatrix({ positionCode, roleName }));
  });

  app.post('/api/catalog/validate-role-focus', (req, res) => {
    const parsed = roleFocusValidateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid validation payload', details: parsed.error.flatten() });
    }
    return res.json(
      validatePlayerRoleFocus(parsed.data.positionCode, parsed.data.role, parsed.data.focus)
    );
  });

  app.post('/api/catalog/import/preview', (req, res) => {
    const parsed = catalogImportPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid import preview payload', details: parsed.error.flatten() });
    }
    try {
      const preview = previewCatalogImport(
        getDb(),
        parsed.data.datasetType,
        parsed.data.format,
        parsed.data.rawContent
      );
      return res.json(preview);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to parse dataset preview',
      });
    }
  });

  app.post('/api/catalog/import/execute', (req, res) => {
    const parsed = catalogImportExecuteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid import execute payload', details: parsed.error.flatten() });
    }
    try {
      const run = executeCatalogImport(
        getDb(),
        parsed.data.datasetType,
        parsed.data.format,
        parsed.data.rawContent,
        {
          fileName: parsed.data.fileName,
          sourceKey: parsed.data.sourceKey,
          datasetVersion: parsed.data.datasetVersion,
          completeness: parsed.data.completeness,
          mode: parsed.data.mode,
        }
      );
      return res.status(201).json({ run });
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to execute catalog import',
      });
    }
  });

  app.post('/api/catalog/import-runs/:id/rollback', (req, res) => {
    const result = rollbackCatalogImportRun(getDb(), req.params.id);
    if (!result.rolledBack) {
      return res.status(400).json({ error: result.error ?? 'Failed to roll back import run' });
    }
    return res.json(result);
  });

  app.get('/api/catalog/export/:datasetType', (req, res) => {
    const parsedType = importDatasetTypeSchema.safeParse(req.params.datasetType);
    if (!parsedType.success) {
      return res.status(400).json({ error: 'Unsupported catalog dataset type for export.' });
    }
    const datasetType = parsedType.data as CatalogDatasetType;
    const payload = catalogRepo.exportCatalogDataset(datasetType);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="fc26-catalog-${datasetType}-${new Date().toISOString().slice(0, 10)}.json"`
    );
    return res.json(payload);
  });

  // Phase 2.2 — FC 26 Master Catalog Coverage Report & Club/League Reconciliation
  app.get('/api/catalog/coverage-report', (_req, res) => {
    try {
      return res.json(getCatalogCoverageReport(getDb()));
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to build catalog coverage report',
      });
    }
  });

  app.post('/api/catalog/reconcile/preview', (_req, res) => {
    try {
      return res.json(previewCatalogReconciliationFromPlayers(getDb()));
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to preview catalog reconciliation',
      });
    }
  });

  app.post('/api/catalog/reconcile/execute', (_req, res) => {
    try {
      return res.json(executeCatalogReconciliationFromPlayers(getDb()));
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to execute catalog reconciliation',
      });
    }
  });

  app.get('/api/matches/:id/ai-context', (req, res) => {
    const ctx = buildAiMatchTacticalContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Match not found' });
    return res.json(ctx);
  });

  // ============================================================
  // Phase 2 — Native Gameplay Recording Sessions & Segments API
  // ============================================================

  const sessionStatusEnum = z.enum([
    'idle',
    'recording',
    'paused',
    'finalizing',
    'completed',
    'partial',
    'failed',
    'recovered',
    'discarded',
  ]);
  const integrityStatusEnum = z.enum(['pending', 'verified', 'partial', 'corrupted', 'unverified']);
  const segmentStatusEnum = z.enum(['writing', 'finalized', 'corrupted', 'recovered']);

  const analysisStateEnum = z.enum(['not_ready', 'verified_awaiting_phase3', 'analysis_completed']);

  const createRecordingSessionSchema = z.object({
    id: z.string().uuid().optional(),
    matchId: z.string().uuid(),
    half: z.enum(['first_half', 'second_half']),
    status: sessionStatusEnum.default('recording'),
    captureSourceId: z.string().max(200).nullable().optional(),
    captureSourceName: z.string().max(260).nullable().optional(),
    resolution: z.string().trim().min(3).max(32).default('1920x1080'),
    fps: z.number().int().min(1).max(120).default(30),
    durationSeconds: z.number().min(0).default(0),
    totalBytes: z.number().min(0).default(0),
    encoder: z.string().max(64).nullable().optional(),
    audioEnabled: z.boolean().optional(),
    outputDirectory: z.string().max(500).nullable().optional(),
    integrityStatus: integrityStatusEnum.optional(),
    aiEligible: z.boolean().optional(),
    analysisState: analysisStateEnum.optional(),
    failureReason: z.string().max(1500).nullable().optional(),
    diagnosticsPath: z.string().max(600).nullable().optional(),
    recoveryNotes: z.string().max(2000).nullable().optional(),
    startedAt: z.string().max(64).nullable().optional(),
    endedAt: z.string().max(64).nullable().optional(),
  });

  const updateRecordingSessionSchema = z.object({
    status: sessionStatusEnum.optional(),
    resolution: z.string().trim().min(3).max(32).optional(),
    fps: z.number().int().min(1).max(120).optional(),
    durationSeconds: z.number().min(0).optional(),
    totalBytes: z.number().min(0).optional(),
    encoder: z.string().max(64).nullable().optional(),
    audioEnabled: z.boolean().optional(),
    outputDirectory: z.string().max(500).nullable().optional(),
    integrityStatus: integrityStatusEnum.optional(),
    aiEligible: z.boolean().optional(),
    analysisState: analysisStateEnum.optional(),
    failureReason: z.string().max(1500).nullable().optional(),
    diagnosticsPath: z.string().max(600).nullable().optional(),
    recoveryNotes: z.string().max(2000).nullable().optional(),
    endedAt: z.string().max(64).nullable().optional(),
  });

  const upsertRecordingSegmentSchema = z.object({
    matchId: z.string().uuid(),
    filePath: z.string().trim().min(1).max(600),
    durationSeconds: z.number().min(0).default(0),
    sizeBytes: z.number().min(0).default(0),
    checksum: z.string().max(128).nullable().optional(),
    status: segmentStatusEnum,
    resolution: z.string().max(32).nullable().optional(),
    fps: z.number().min(0).max(240).nullable().optional(),
    codec: z.string().max(48).nullable().optional(),
    hasAudio: z.boolean().optional(),
    integrityStatus: integrityStatusEnum.optional(),
    startedAt: z.string().max(64).nullable().optional(),
    endedAt: z.string().max(64).nullable().optional(),
  });

  const recordingDiagnosticsSaveSchema = z.object({
    matchId: z.string().uuid(),
    failureReason: z.string().max(1500).nullable().optional(),
    payload: z.record(z.string(), z.unknown()),
  });

  app.get('/api/recording-sessions', (req, res) => {
    const matchId = typeof req.query.matchId === 'string' ? req.query.matchId : undefined;
    const clubId = typeof req.query.clubId === 'string' ? req.query.clubId : undefined;
    res.json(repo.listMatchSessions({ matchId, clubId }));
  });

  app.get('/api/recording-sessions/:id', (req, res) => {
    const sessionData = repo.getMatchSessionById(req.params.id);
    if (!sessionData) return res.status(404).json({ error: 'Recording session not found' });
    return res.json(sessionData);
  });

  app.post('/api/recording-sessions', (req, res) => {
    const parsed = createRecordingSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid recording session payload', details: parsed.error.flatten() });
    }
    try {
      const created = repo.createOrUpsertMatchSession(parsed.data);
      return res.status(201).json(created);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to create recording session',
      });
    }
  });

  app.patch('/api/recording-sessions/:id', (req, res) => {
    const parsed = updateRecordingSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid recording session update', details: parsed.error.flatten() });
    }
    const updated = repo.updateMatchSession(req.params.id, parsed.data);
    if (!updated) return res.status(404).json({ error: 'Recording session not found' });
    return res.json(updated);
  });

  app.put('/api/recording-sessions/:id/segments/:segmentIndex', (req, res) => {
    const segmentIndex = Number(req.params.segmentIndex);
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 9999) {
      return res.status(400).json({ error: 'Invalid segmentIndex parameter.' });
    }
    const parsed = upsertRecordingSegmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid recording segment payload', details: parsed.error.flatten() });
    }
    try {
      const segment = repo.upsertRecordingSegment({
        sessionId: req.params.id,
        segmentIndex,
        ...parsed.data,
      });
      return res.json(segment);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to persist recording segment',
      });
    }
  });

  app.get('/api/recording-sessions/:id/diagnostics', (req, res) => {
    const diag = repo.getRecordingDiagnostics(req.params.id);
    if (!diag) return res.status(404).json({ error: 'Recording diagnostics not found for this session' });
    return res.json(diag);
  });

  app.put('/api/recording-sessions/:id/diagnostics', (req, res) => {
    const parsed = recordingDiagnosticsSaveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid recording diagnostics payload', details: parsed.error.flatten() });
    }
    try {
      const saved = repo.saveRecordingDiagnostics({
        sessionId: req.params.id,
        matchId: parsed.data.matchId,
        failureReason: parsed.data.failureReason ?? null,
        payload: parsed.data.payload as unknown as Parameters<typeof repo.saveRecordingDiagnostics>[0]['payload'],
      });
      return res.json(saved);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to save recording diagnostics',
      });
    }
  });

  // ============================================================
  // Phase 3 — Tactical Vision Engine, Coaching Staff & Familiarity
  // ============================================================

  const tacticalEvaluationAssignmentSchema = z.object({
    slotOrder: z.number().int().min(0).max(10),
    slotId: z.string().trim().max(16).nullable().optional(),
    positionCode: z.string().trim().min(1).max(12),
    playerId: z.string().uuid().nullable(),
    playerDisplayName: z.string().max(120).nullable().optional(),
    role: z.string().trim().max(80).default(''),
    focus: z.string().trim().max(80).default(''),
  });

  const tacticalEvaluationInputSchema = z.object({
    clubId: z.string().uuid().nullable().optional(),
    tacticalVisionKey: z.string().trim().max(60).nullable().optional(),
    formationName: z.string().trim().min(1).max(60),
    buildUpStyle: z.string().trim().min(1).max(80),
    defensiveApproach: z.string().trim().min(1).max(80),
    defensiveLineHeight: z.number().int().min(1).max(100),
    assignments: z.array(tacticalEvaluationAssignmentSchema).max(11).default([]),
    benchPlayerIds: z.array(z.string().uuid()).max(12).optional(),
    confirmedDoubtfulPlayerIds: z.array(z.string().uuid()).max(23).optional(),
  });

  const compareVisionsSchema = z.object({
    visionKeyA: z.string().trim().min(1).max(60),
    visionKeyB: z.string().trim().min(1).max(60),
    config: tacticalEvaluationInputSchema.omit({ tacticalVisionKey: true }),
  });

  const optimizeVisionSchema = tacticalEvaluationInputSchema.extend({
    targetVisionKey: z.string().trim().min(1).max(60),
    mode: z.enum([
      'minimal_adjustment',
      'role_optimization',
      'squad_optimization',
      'full_tactical_optimization',
    ]),
  });

  const clubCoachSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    department: z.preprocess(
      (val) => (val === 'attacking' ? 'attack' : val === 'defending' ? 'defense' : val),
      z.enum(['attack', 'midfield', 'defense', 'goalkeeping', 'head_coach'])
    ),
    tacticalVisionKey: z.string().trim().min(1).max(60),
    qualificationLevel: z.enum(['standard', 'bronze', 'silver', 'gold']),
    starRating: z.number().int().min(1).max(5),
    notes: z.string().trim().max(600).optional(),
  });

  const familiarityTierEnum = z.enum(['unknown', 'none', 'role_plus', 'role_plus_plus']);

  const playerRoleFamiliaritySchema = z.object({
    positionCode: z.string().trim().min(1).max(12),
    roleName: z.string().trim().min(1).max(80),
    baseFamiliarity: familiarityTierEnum.optional(),
    potentialCoachFamiliarity: familiarityTierEnum.optional(),
    confirmedFamiliarity: familiarityTierEnum.optional(),
    notes: z.string().trim().max(600).optional(),
  });

  app.get('/api/tactical-visions', (_req, res) => {
    res.json(tacticalVisionService.getTacticalVisionCatalog());
  });

  app.get('/api/tactical-visions/:key', (req, res) => {
    const vision = tacticalVisionService.getTacticalVisionByKey(req.params.key);
    if (!vision) return res.status(404).json({ error: 'Tactical Vision not found' });
    return res.json(vision);
  });

  app.post('/api/tactical-visions/evaluate', (req, res) => {
    const parsed = tacticalEvaluationInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid tactical evaluation payload', details: parsed.error.flatten() });
    }
    try {
      return res.json(tacticalVisionService.evaluateThreeLayerTactics(parsed.data));
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to evaluate tactical setup',
      });
    }
  });

  app.post('/api/tactical-visions/compare', (req, res) => {
    const parsed = compareVisionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid vision comparison payload', details: parsed.error.flatten() });
    }
    try {
      return res.json(
        tacticalVisionService.compareTacticalVisions(
          parsed.data.visionKeyA,
          parsed.data.visionKeyB,
          parsed.data.config
        )
      );
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to compare tactical visions',
      });
    }
  });

  app.post('/api/tactical-visions/optimize', (req, res) => {
    const parsed = optimizeVisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid vision optimization payload', details: parsed.error.flatten() });
    }
    try {
      return res.json(tacticalVisionService.optimizeForTacticalVision(parsed.data));
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to optimize for tactical vision',
      });
    }
  });

  app.get('/api/clubs/:clubId/coaches', (req, res) => {
    res.json(tacticalVisionService.listClubCoaches(req.params.clubId));
  });

  app.post('/api/clubs/:clubId/coaches', (req, res) => {
    const parsed = clubCoachSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid club coach payload', details: parsed.error.flatten() });
    }
    try {
      const saved = tacticalVisionService.upsertClubCoach(req.params.clubId, parsed.data);
      return res.status(201).json(saved);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to save club coach',
      });
    }
  });

  app.delete('/api/coaches/:id', (req, res) => {
    const deleted = tacticalVisionService.deleteClubCoach(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Coach not found' });
    return res.json({ deleted: true });
  });

  app.get('/api/clubs/:clubId/role-familiarities', (req, res) => {
    res.json(tacticalVisionService.listClubPlayerRoleFamiliarities(req.params.clubId));
  });

  app.put('/api/players/:playerId/role-familiarities', (req, res) => {
    const parsed = playerRoleFamiliaritySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid role familiarity payload',
        details: parsed.error.flatten(),
      });
    }
    try {
      const saved = tacticalVisionService.upsertPlayerRoleFamiliarity(
        req.params.playerId,
        parsed.data
      );
      return res.json(saved);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to update player role familiarity',
      });
    }
  });

  app.post('/api/matches/:id/tactical-snapshots/:snapshotId/confirm-applied', (req, res) => {
    const confirmed = Boolean(req.body?.confirmed ?? true);
    const updated = repo.confirmSnapshotAppliedInGame(req.params.snapshotId, confirmed);
    if (!updated) return res.status(404).json({ error: 'Tactical snapshot not found' });
    return res.json(updated);
  });

  // ============================================================
  // Phase 3 — Gemini Video Intelligence & Half-Time Analyst API
  // ============================================================

  const startAnalysisJobSchema = z.object({
    sessionId: z.string().uuid().nullable().optional(),
    half: z.enum(['first_half', 'second_half']).default('first_half'),
    analysisMode: z.enum(['quick', 'balanced', 'deep']).optional(),
    language: z.enum(['en', 'id']).optional(),
    privacyAuthorized: z.boolean(),
    entireDisplayAcknowledged: z.boolean().optional(),
    forceReanalyze: z.boolean().optional(),
  });

  const recommendationDecisionSchema = z.object({
    decisionStatus: z.enum([
      'ai_recommended',
      'user_accepted',
      'user_modified',
      'user_rejected',
      'applied_in_game',
      'unable_to_verify',
    ]),
    modifiedValue: z.string().trim().max(500).nullable().optional(),
    appliedInGame: z.boolean().optional(),
    userNotes: z.string().trim().max(1000).optional(),
  });

  const applyAdjustmentSchema = z.object({
    jobId: z.string().uuid(),
    recommendationIds: z.array(z.string().uuid()).min(1).max(30),
    appliedInGameConfirmed: z.boolean().optional(),
    notes: z.string().trim().max(1500).optional(),
  });

  const saveAdjustmentPresetSchema = z.object({
    snapshotId: z.string().uuid(),
    presetName: z.string().trim().min(1).max(120),
  });

  app.get('/api/ai/models', (_req, res) => {
    const settings = repo.getSettings();
    res.json({
      models: GEMINI_MODEL_REGISTRY,
      status: getGeminiStatus(settings.ai.modelId),
    });
  });

  app.post('/api/ai/test-connection', async (req, res) => {
    const requestedModel =
      typeof req.body?.modelId === 'string' && req.body.modelId.trim()
        ? req.body.modelId.trim()
        : repo.getSettings().ai.modelId;
    const result = await testGeminiConnection(requestedModel);
    return res.json(result);
  });

  app.get('/api/ai/budget-summary', (_req, res) => {
    const settings = repo.getSettings();
    const daily = repo.getDailyApiSpendUsd();
    const dailyBudgetUsd = settings.ai.dailyBudgetUsd ?? 10.0;
    res.json({
      datePrefix: daily.date,
      spentUsd: daily.totalEstimatedUsd,
      requestCount: daily.requestCount,
      dailyBudgetUsd,
      perMatchBudgetUsd: settings.ai.perMatchBudgetUsd,
      remainingDailyUsd: Number(Math.max(0, dailyBudgetUsd - daily.totalEstimatedUsd).toFixed(4)),
    });
  });

  app.get('/api/matches/:id/analysis', (req, res) => {
    const preferredJobId =
      typeof req.query.jobId === 'string' && req.query.jobId.trim()
        ? req.query.jobId.trim()
        : undefined;
    res.json(aiOrchestrator.listMatchAnalysisBundle(req.params.id, preferredJobId));
  });

  app.post('/api/matches/:id/analysis/start', async (req, res) => {
    const parsed = startAnalysisJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid analysis launch request', details: parsed.error.flatten() });
    }
    try {
      const result = await aiOrchestrator.startAnalysisJob({
        matchId: req.params.id,
        sessionId: parsed.data.sessionId ?? null,
        half: parsed.data.half,
        analysisMode: parsed.data.analysisMode,
        language: parsed.data.language,
        privacyAuthorized: parsed.data.privacyAuthorized,
        entireDisplayAcknowledged: parsed.data.entireDisplayAcknowledged,
        forceReanalyze: parsed.data.forceReanalyze,
      });
      return res.status(202).json(result);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to start AI video analysis',
      });
    }
  });

  app.get('/api/analysis-jobs/:jobId', (req, res) => {
    const job = aiOrchestrator.getAnalysisJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Analysis job not found' });
    return res.json(job);
  });

  app.post('/api/analysis-jobs/:jobId/cancel', (req, res) => {
    const job = aiOrchestrator.cancelAnalysisJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Analysis job not found' });
    return res.json(job);
  });

  app.post('/api/analysis-jobs/:jobId/retry-cleanup', async (req, res) => {
    try {
      const assets = await aiOrchestrator.retryRemoteCleanup(req.params.jobId);
      return res.json({ assets });
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to retry remote file cleanup',
      });
    }
  });

  app.post('/api/matches/:id/analysis/recommendations/:recId/decision', (req, res) => {
    const parsed = recommendationDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid recommendation decision payload',
        details: parsed.error.flatten(),
      });
    }
    try {
      const decision = aiOrchestrator.saveRecommendationDecision({
        recommendationId: req.params.recId,
        ...parsed.data,
      });
      return res.json(decision);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to save recommendation decision',
      });
    }
  });

  app.post('/api/matches/:id/analysis/apply-adjustment', (req, res) => {
    const parsed = applyAdjustmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid adjustment application payload',
        details: parsed.error.flatten(),
      });
    }
    try {
      const snapshot = aiOrchestrator.applyAcceptedRecommendationsToAdjustmentSnapshot({
        matchId: req.params.id,
        ...parsed.data,
      });
      return res.status(201).json(snapshot);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to apply half-time adjustment snapshot',
      });
    }
  });

  app.post('/api/matches/:id/analysis/save-preset', (req, res) => {
    const parsed = saveAdjustmentPresetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid save preset payload',
        details: parsed.error.flatten(),
      });
    }
    try {
      const preset = aiOrchestrator.saveAdjustmentAsNewClubPreset({
        matchId: req.params.id,
        snapshotId: parsed.data.snapshotId,
        presetName: parsed.data.presetName,
      });
      return res.status(201).json(preset);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to save preset from match adjustment',
      });
    }
  });

  // Browser Preview fallback: import a local MP4 test clip into an app-owned recording session
  app.post('/api/matches/:id/test-video-import', async (req, res) => {
    const half = req.query.half === 'second_half' ? 'second_half' : 'first_half';
    const rawFileName =
      typeof req.headers['x-file-name'] === 'string' && req.headers['x-file-name'].trim()
        ? req.headers['x-file-name'].trim()
        : 'test-clip.mp4';
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const imported = await aiOrchestrator.importBrowserPreviewTestClip({
        matchId: req.params.id,
        half,
        fileName: rawFileName,
        buffer,
      });
      return res.status(201).json(imported);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to import MP4 test clip',
      });
    }
  });

  // Authenticated, strictly path-confined evidence frame image route
  app.get('/api/evidence-frames/:matchId/:fileName', (req, res) => {
    const { matchId, fileName } = req.params;
    if (!/^[a-zA-Z0-9_-]{4,80}$/.test(matchId)) {
      return res.status(400).json({ error: 'Invalid matchId parameter.' });
    }
    const baseName = path.basename(fileName);
    if (baseName !== fileName || !/^[a-zA-Z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(baseName)) {
      return res.status(400).json({ error: 'Invalid evidence frame file name.' });
    }
    try {
      const matchFramesDir = getEvidenceFramesDir(matchId);
      const targetPath = path.join(matchFramesDir, baseName);
      const resolved = assertConfinedMediaPath(targetPath, [matchFramesDir]);
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ error: 'Evidence frame not found.' });
      }
      return res.sendFile(resolved);
    } catch {
      return res.status(403).json({ error: 'Evidence frame path outside confined directory.' });
    }
  });

  // Settings & API Usage
  app.get('/api/settings', (_req, res) => {
    res.json(repo.getSettings());
  });

  app.put('/api/settings', (req, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid settings update', details: parsed.error.flatten() });
    }
    const updated = repo.updateSettings(parsed.data as Parameters<typeof repo.updateSettings>[0]);
    return res.json(updated);
  });

  app.get('/api/usage-logs', (_req, res) => {
    res.json(repo.listApiUsageLogs());
  });

  // Database Backup, Restore, and Explicit Deletion (protected by Bearer auth + destructive header)
  app.get('/api/database/backup', (_req, res) => {
    const backup = exportDatabaseBackup();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="fc26-ai-manager-backup-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.json(backup);
  });

  app.post('/api/database/restore', requireDestructiveConfirmation, (req, res) => {
    try {
      restoreDatabaseBackup(req.body);
      return res.json({ restored: true, metadata: getDatabaseMetadata() });
    } catch (err) {
      return res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'Failed to restore backup' });
    }
  });

  app.delete('/api/database/all', requireDestructiveConfirmation, (req, res) => {
    if (req.body?.confirmation !== 'DELETE') {
      return res
        .status(400)
        .json({ error: 'Explicit confirmation ("DELETE") is required to clear all application data.' });
    }
    deleteAllApplicationData();
    return res.json({ cleared: true });
  });

  // Serve built static frontend in production / desktop mode (zero dependency on Vite dev server)
  if (!IS_PRODUCTION && !IS_DESKTOP_MODE) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.FC26_STATIC_DIR
      ? path.resolve(process.env.FC26_STATIC_DIR)
      : path.resolve(process.cwd(), 'dist');

    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      throw new Error(`Built frontend not found at ${distPath}. Run "npm run build" first.`);
    }

    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'API route not found' });
        return;
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(
      `FC26 AI Manager backend listening on http://${HOST}:${PORT} (${
        IS_DESKTOP_MODE ? 'desktop-loopback' : IS_PRODUCTION ? 'production' : 'dev-preview'
      })`
    );
  });

  const shutdown = () => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 2500).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start FC26 AI Manager server:', err);
  closeDb();
  process.exit(1);
});
