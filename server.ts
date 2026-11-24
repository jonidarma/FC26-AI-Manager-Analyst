import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { z } from 'zod';
import {
  deleteAllApplicationData,
  exportDatabaseBackup,
  getDatabaseMetadata,
  getDb,
  restoreDatabaseBackup,
} from './server/db/database.ts';
import { getGeminiStatus } from './server/services/geminiService.ts';
import * as repo from './server/services/repository.ts';

const PORT = Number(process.env.PORT) || 3000;

const clubSchema = z.object({
  name: z.string().trim().min(1).max(120),
  league: z.string().trim().max(120).default(''),
  season: z.string().trim().min(1).max(40).default('2025/26'),
  managerName: z.string().trim().max(100).default(''),
  preferredPhilosophy: z.string().trim().max(120).default('Balanced Positional Play'),
  primaryFormation: z.string().trim().min(1).max(60).default('4-3-3 Holding'),
  alternativeFormation: z.string().trim().max(60).default('4-2-3-1 Wide'),
  preferredAttackingStyle: z.string().trim().max(80).default('Balanced'),
  preferredDefensiveStyle: z.string().trim().max(80).default('Balanced'),
  setActive: z.boolean().optional(),
});

const playerSchema = z.object({
  clubId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  position: z.string().trim().min(1).max(12),
  overallRating: z.number().int().min(1).max(99).nullable().default(null),
  preferredFoot: z.enum(['Right', 'Left', 'Both']).default('Right'),
  playerRole: z.string().trim().max(80).default(''),
  strengths: z.string().trim().max(400).default(''),
  weaknesses: z.string().trim().max(400).default(''),
  preferredInstructions: z.string().trim().max(400).default(''),
});

const opponentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  league: z.string().trim().max(120).default(''),
  typicalFormation: z.string().trim().max(60).default('Unknown'),
  strengths: z.string().trim().max(600).default(''),
  weaknesses: z.string().trim().max(600).default(''),
  dangerousChannels: z.string().trim().max(400).default(''),
  notes: z.string().trim().max(1000).default(''),
});

const roleAssignmentSchema = z.object({
  slotIndex: z.number().int().min(0).max(10),
  positionCode: z.string().trim().min(1).max(12),
  playerId: z.string().uuid().nullable(),
  playerName: z.string().max(100).nullable(),
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
  objective: z.string().trim().max(300).default(''),
  preMatchNotes: z.string().trim().max(1500).default(''),
  tacticalSetup: z.object({
    buildUpStyle: z.string().trim().min(1).max(80),
    defensiveApproach: z.string().trim().min(1).max(80),
    defensiveLineHeight: z.number().int().min(1).max(100),
    playerAssignments: z.array(roleAssignmentSchema).max(11).default([]),
    customParameters: z.record(z.string(), z.string()).optional(),
  }),
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
      analysisQuality: z.enum(['balanced', 'detailed', 'compact']).optional(),
      maxEvidenceFrames: z.number().int().min(6).max(60).optional(),
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
  // Initialize SQLite database and run migrations on startup
  getDb();

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // System & health endpoints
  app.get('/api/system/status', (_req, res) => {
    const settings = repo.getSettings();
    const dbMeta = getDatabaseMetadata();
    const gemini = getGeminiStatus(settings.ai.modelId);
    res.json({
      runtime: 'server-web-preview',
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
      return res.status(400).json({ error: 'Invalid club data', details: parsed.error.flatten() });
    }
    const created = repo.createClub(parsed.data);
    return res.status(201).json(created);
  });

  app.put('/api/clubs/:id', (req, res) => {
    const parsed = clubSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid club update', details: parsed.error.flatten() });
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

  app.delete('/api/players/:id', (req, res) => {
    const deleted = repo.deletePlayer(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Player not found' });
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

  // Database Backup, Restore, and Explicit Deletion
  app.get('/api/database/backup', (_req, res) => {
    const backup = exportDatabaseBackup();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="fc26-ai-manager-backup-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.json(backup);
  });

  app.post('/api/database/restore', (req, res) => {
    try {
      restoreDatabaseBackup(req.body);
      return res.json({ restored: true, metadata: getDatabaseMetadata() });
    } catch (err) {
      return res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'Failed to restore backup' });
    }
  });

  app.delete('/api/database/all', (req, res) => {
    if (req.body?.confirmation !== 'DELETE') {
      return res
        .status(400)
        .json({ error: 'Explicit confirmation ("DELETE") is required to clear all application data.' });
    }
    deleteAllApplicationData();
    return res.json({ cleared: true });
  });

  // Vite dev middleware or production static serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FC26 AI Manager server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start FC26 AI Manager server:', err);
  process.exit(1);
});
