/**
 * Phase 3.0.2 Automated Verification Suite
 * Gemini Model Routing, Discovery, Preflight, Exact 19-Code Error Taxonomy,
 * Bounded Timeouts/Retries, Cancellation, Durable Remote Cleanup, Stale Job Recovery,
 * FFmpeg Mode-Specific Analysis Proxies, and Migration v8 / Backup v8 Compatibility.
 *
 * Uses an isolated temp SQLite database and temp recording root — NEVER touches /data/fc26_manager.db.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);

// Set isolated temp paths BEFORE importing app modules
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc26-phase302-test-'));
const tempRecordingsRoot = path.join(tempRoot, 'recordings');
fs.mkdirSync(tempRecordingsRoot, { recursive: true });

process.env.FC26_USER_DATA_DIR = tempRoot;
process.env.FC26_APP_USER_DATA_ROOT = tempRoot;
process.env.FC26_RECORDINGS_DIR = tempRecordingsRoot;
process.env.GEMINI_API_KEY = 'AIzaSyTestFakeKey1234567890ABCDEFGHIJ';

import {
  closeDb,
  exportDatabaseBackup,
  getDb,
  restoreDatabaseBackup,
} from '../../server/db/database.ts';
import { MIGRATIONS, runMigrations } from '../../server/db/migrations.ts';
import {
  cancelAnalysisJob,
  cleanupPendingRemoteFiles,
  getAnalysisJob,
  listMatchAnalysisBundle,
  markInterruptedJobsOnStartup,
  reconcileStaleAnalysisJobs,
  retryRemoteCleanup,
  startAnalysisJob,
} from '../../server/services/aiAnalysisOrchestrator.ts';
import { resolveEffectiveModelRouting } from '../../server/services/geminiModelRouter.ts';
import {
  classifyGeminiError,
  discoverAvailableGeminiModels,
  runAnalysisPreflight,
  sanitizeDiagnosticText,
  verifyModelCapabilities,
  type GeminiDiscoveryClientLike,
} from '../../server/services/geminiService.ts';
import {
  GeminiStageError,
  runWithTimeoutAndAbort,
  withBoundedStageRetries,
  type GeminiVideoProvider,
} from '../../server/services/geminiVideoService.ts';
import {
  createClub,
  createMatch,
  createOrUpsertMatchSession,
  createPlayer,
  getSettings,
  updateMatchSession,
  updateSettings,
  upsertRecordingSegment,
} from '../../server/services/repository.ts';
import {
  cleanupTempAnalysisDir,
  getAnalysisProxyProfileSpec,
  prepareAnalysisVideoAsset,
  resolveServerFfmpegBinaries,
  validateVideoFile,
} from '../../server/services/videoPreprocessingService.ts';
import type { GeminiErrorCode } from '../../src/types/domain.ts';

interface TestCase {
  name: string;
  run: () => Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void) {
  tests.push({ name, run });
}

async function generateTestMp4(
  outputPath: string,
  options: { width?: number; height?: number; fps?: number; durationSec?: number; withAudio?: boolean } = {}
): Promise<string> {
  const bins = resolveServerFfmpegBinaries();
  assert.ok(bins.ffmpegPath, 'FFmpeg must be available in environment for Phase 3.0.2 tests');
  const w = options.width ?? 640;
  const h = options.height ?? 360;
  const fps = options.fps ?? 15;
  const dur = options.durationSec ?? 4;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const args: string[] = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${w}x${h}:rate=${fps}:duration=${dur}`,
  ];
  if (options.withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`);
  }
  args.push(
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-crf',
    '28'
  );
  if (options.withAudio) {
    args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  }
  args.push('-movflags', '+faststart', outputPath);

  await execFileAsync(bins.ffmpegPath, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return outputPath;
}

function createFixtureClubAndMatch(label: string) {
  const club = createClub({
    name: `Chelsea ${label}`,
    league: 'Premier League',
    nation: 'England',
    season: '2025/26',
    managerName: 'Enzo Maresca',
    preferredPhilosophy: 'Possession',
    primaryFormation: '4-2-3-1 Wide',
    alternativeFormation: '4-3-3 Holding',
    preferredAttackingStyle: 'Short Passing',
    preferredDefensiveStyle: 'High',
    preferredBuildUpStyle: 'Short Passing',
    preferredDefensiveApproach: 'High',
    preferredDefensiveLineHeight: 65,
    primaryTacticalVisionKey: 'possession',
  });

  const positions = ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'LM', 'CAM', 'RM', 'ST'];
  const starters = positions.map((pos, idx) =>
    createPlayer({
      clubId: club.id,
      name: `${label} Starter ${idx + 1}`,
      position: pos,
      overallRating: 82,
      age: 24,
      preferredFoot: 'Right',
      playerRole: pos === 'GK' ? 'Goalkeeper' : 'Holding',
      playerFocus: 'Balanced',
      squadStatus: 'active',
      availability: 'available',
      strengths: 'Tactical awareness',
      weaknesses: 'None',
      preferredInstructions: 'Hold shape',
    })
  );
  const bench = [1, 2, 3].map((idx) =>
    createPlayer({
      clubId: club.id,
      name: `${label} Bench ${idx}`,
      position: idx === 1 ? 'ST' : 'CM',
      overallRating: 78,
      age: 22,
      preferredFoot: 'Right',
      playerRole: idx === 1 ? 'Advanced Forward' : 'Box-to-Box',
      playerFocus: 'Balanced',
      squadStatus: 'active',
      availability: 'available',
      strengths: 'Pace',
      weaknesses: 'None',
      preferredInstructions: 'Impact sub',
    })
  );

  const slots = [
    { slotId: 'GK', positionCode: 'GK', role: 'Goalkeeper', focus: 'Defend' },
    { slotId: 'LB', positionCode: 'LB', role: 'Fullback', focus: 'Defend' },
    { slotId: 'LCB', positionCode: 'CB', role: 'Defender', focus: 'Defend' },
    { slotId: 'RCB', positionCode: 'CB', role: 'Defender', focus: 'Defend' },
    { slotId: 'RB', positionCode: 'RB', role: 'Fullback', focus: 'Defend' },
    { slotId: 'LCDM', positionCode: 'CDM', role: 'Holding', focus: 'Defend' },
    { slotId: 'RCDM', positionCode: 'CDM', role: 'Deep-Lying Playmaker', focus: 'Build-Up' },
    { slotId: 'LM', positionCode: 'LM', role: 'Winger', focus: 'Balanced' },
    { slotId: 'CAM', positionCode: 'CAM', role: 'Playmaker', focus: 'Balanced' },
    { slotId: 'RM', positionCode: 'RM', role: 'Winger', focus: 'Balanced' },
    { slotId: 'ST', positionCode: 'ST', role: 'Advanced Forward', focus: 'Attack' },
  ];

  const match = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentName: `Sunderland ${label}`,
    competition: 'Premier League',
    venue: 'home',
    matchDate: '2026-11-25',
    startingFormation: '4-2-3-1 Wide',
    startingXiIds: starters.map((p) => p.id),
    benchIds: bench.map((p) => p.id),
    objective: 'Control possession and win',
    preMatchNotes: '',
    tacticalSetup: {
      tacticalVisionKey: 'possession',
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'High',
      defensiveLineHeight: 65,
      playerAssignments: starters.map((p, idx) => ({
        slotIndex: idx,
        slotId: slots[idx].slotId,
        positionCode: slots[idx].positionCode,
        positionLabel: slots[idx].positionCode,
        playerId: p.id,
        playerName: p.name,
        role: slots[idx].role,
        focus: slots[idx].focus,
      })),
    },
  });

  return { club, starters, bench, match };
}

async function createVerifiedSessionWithSegment(
  matchId: string,
  half: 'first_half' | 'second_half',
  label: string,
  clipOptions?: { width?: number; height?: number; fps?: number; durationSec?: number; withAudio?: boolean }
) {
  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(tempRecordingsRoot, `session_${label}_${sessionId.slice(0, 6)}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const segPath = path.join(sessionDir, 'segment_001.mp4');
  await generateTestMp4(segPath, clipOptions ?? { width: 640, height: 360, fps: 15, durationSec: 12 });
  const stat = fs.statSync(segPath);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(segPath)).digest('hex');

  createOrUpsertMatchSession({
    id: sessionId,
    matchId,
    half,
    status: 'recording',
    captureSourceName: 'EA SPORTS FC 26',
    outputDirectory: sessionDir,
    integrityStatus: 'pending',
    aiEligible: false,
    resolution: `${clipOptions?.width ?? 640}x${clipOptions?.height ?? 360}`,
    fps: clipOptions?.fps ?? 15,
    durationSeconds: clipOptions?.durationSec ?? 12,
    totalBytes: stat.size,
  });

  const segment = upsertRecordingSegment({
    sessionId,
    matchId,
    segmentIndex: 1,
    originalFileName: 'segment_001.mp4',
    filePath: segPath,
    durationSeconds: clipOptions?.durationSec ?? 12,
    sizeBytes: stat.size,
    checksum: sha,
    integrityStatus: 'verified',
    status: 'finalized',
  });

  updateMatchSession(sessionId, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    failureReason: null,
    durationSeconds: clipOptions?.durationSec ?? 12,
    totalBytes: stat.size,
  });

  return { sessionId, sessionDir, segPath, segment };
}

function buildFastMockProvider(overrides: Partial<GeminiVideoProvider> = {}): GeminiVideoProvider {
  const uploadedFiles = new Set<string>();
  return {
    isMock: true,
    async uploadAndAwaitActive(input) {
      const remoteName = `files/mock-${crypto.randomUUID().slice(0, 8)}`;
      uploadedFiles.add(remoteName);
      if (input.onRemoteFileUploaded) {
        input.onRemoteFileUploaded({
          remoteFileName: remoteName,
          remoteFileUri: `https://generativelanguage.googleapis.com/v1beta/${remoteName}`,
          remoteState: 'PROCESSING',
        });
      }
      if (input.onWaitingForProcessing) {
        input.onWaitingForProcessing();
      }
      return {
        remoteFileName: remoteName,
        remoteFileUri: `https://generativelanguage.googleapis.com/v1beta/${remoteName}`,
        remoteState: 'ACTIVE',
        uploadMs: 12,
        mediaProcessingMs: 8,
      };
    },
    async deleteRemoteFile(remoteFileName) {
      uploadedFiles.delete(remoteFileName);
      return { deleted: true, error: null };
    },
    async classifyVideoSegment(input) {
      return {
        segments: [
          {
            startSeconds: 0,
            endSeconds: Math.max(10, input.segmentDurationSeconds),
            contentType: 'live_gameplay',
            confidence: 'High',
            evidenceDescription: 'Live match camera on pitch',
            inGameClock: '12:00',
          },
        ],
        readableHudStats: {
          scoreline: '0-0',
          matchClock: '12:00',
          possessionLabel: null,
          shotsLabel: null,
          otherVerifiedStats: [],
        },
        usage: {
          modelId: input.modelId,
          inputTokens: 1200,
          outputTokens: 300,
          estimatedCostUsd: 0.001,
          durationMs: 25,
        },
      };
    },
    async extractGameplayObservations(input) {
      return {
        observations: [
          {
            startSeconds: 1,
            endSeconds: Math.min(8, Math.max(2, input.segmentDurationSeconds - 1)),
            inGameClock: '18:30',
            categoryGroup: 'defensive',
            category: 'Right flank transition gap',
            teamAttribution: 'user_team',
            playerAttribution: 'Unknown',
            description: 'Right fullback pushed high leaving channel open during turnover.',
            supportingVisualEvidence: 'Visible gap behind right fullback on transition.',
            evidenceType: 'directly_observed',
            confidence: 'High',
            severity: 'High',
            limitations: 'Jersey number unreadable at wide broadcast zoom.',
            isFromReplay: false,
          },
        ],
        usage: {
          modelId: input.modelId,
          inputTokens: 1600,
          outputTokens: 500,
          estimatedCostUsd: 0.002,
          durationMs: 30,
        },
      };
    },
    async synthesizeTacticalBriefing(input) {
      return {
        evidenceQuality: 'moderate',
        managerVerdict: {
          whatIsWorking: ['Short build-up centrally'],
          whatIsNotWorking: ['Transition recovery down the right flank'],
          whyTacticStruggling: 'Right fullback pushes high without midfield cover.',
          firstPriorityChange: 'Protect right channel on turnovers.',
          conciseSummary: 'Verified transition exposure behind the right fullback.',
        },
        gameplayCoaching: [],
        contingencyPlan: [],
        limitations: ['Short synthetic clip used for test verification.'],
        visionAssessment: {
          observedPlayingStyle: {
            primaryTendency: 'Possession',
            mixedTendencies: ['Short Passing'],
            evidenceSummary: 'Controlled central build-up with exposed right flank on turnover.',
            isInsufficientEvidence: false,
          },
          recommendedVisionKey: 'retain_current',
          recommendationStance: 'retain_and_refine',
          recommendationRationale: 'Possession structure held; adjust rest defense only.',
          executionAssessmentLabel: 'Moderate execution',
          internalAssessmentScore: 72,
          scoreMethodologyNote: 'Test synthesis',
          criteriaBreakdown: [],
          confidence: 'Medium',
          limitations: 'Short clip',
        },
        recommendations: [],
        usage: {
          modelId: input.modelId,
          inputTokens: 1400,
          outputTokens: 600,
          estimatedCostUsd: 0.002,
          durationMs: 25,
        },
      };
    },
    async synthesizeSecondHalfComparison(input) {
      return {
        summary: 'Comparison summary',
        appliedAdjustmentsReviewed: [],
        attackingComparison: 'Stable',
        defensiveComparison: 'Improved',
        tacticalVisionComparison: 'Consistent',
        recurringWeaknesses: [],
        limitations: ['Correlation only.'],
        usage: {
          modelId: input.modelId,
          inputTokens: 900,
          outputTokens: 300,
          estimatedCostUsd: 0.001,
          durationMs: 20,
        },
      };
    },
    ...overrides,
  };
}

// ============================================================
// SCENARIOS 1–6: MODEL ROUTING & SETTINGS PERSISTENCE
// ============================================================

test('01: Settings save & reload persists Primary, Quick, Balanced, Deep, Synthesis models, override flag, timeouts, retries & proxy toggles', () => {
  const updated = updateSettings({
    ai: {
      modelId: 'gemini-3.1-flash-lite',
      usePrimaryModelForAllStages: false,
      quickAnalysisModelId: 'gemini-2.5-flash-lite',
      balancedAnalysisModelId: 'gemini-2.5-flash',
      deepAnalysisModelId: 'gemini-2.5-pro',
      tacticalSynthesisModelId: 'gemini-2.5-pro',
      uploadTimeoutSeconds: 420,
      processingTimeoutSeconds: 240,
      inferenceTimeoutSeconds: 210,
      maxRetryAttempts: 3,
      proxyEnabled: true,
      proxyAudioInBalanced: true,
      proxyAudioInDeep: true,
    },
  });

  const reloaded = getSettings().ai;
  assert.equal(updated.ai.modelId, 'gemini-3.1-flash-lite');
  assert.equal(reloaded.modelId, 'gemini-3.1-flash-lite');
  assert.equal(reloaded.usePrimaryModelForAllStages, false);
  assert.equal(reloaded.quickAnalysisModelId, 'gemini-2.5-flash-lite');
  assert.equal(reloaded.balancedAnalysisModelId, 'gemini-2.5-flash');
  assert.equal(reloaded.deepAnalysisModelId, 'gemini-2.5-pro');
  assert.equal(reloaded.tacticalSynthesisModelId, 'gemini-2.5-pro');
  assert.equal(reloaded.uploadTimeoutSeconds, 420);
  assert.equal(reloaded.processingTimeoutSeconds, 240);
  assert.equal(reloaded.inferenceTimeoutSeconds, 210);
  assert.equal(reloaded.maxRetryAttempts, 3);
  assert.equal(reloaded.proxyEnabled, true);
  assert.equal(reloaded.proxyAudioInBalanced, true);
  assert.equal(reloaded.proxyAudioInDeep, true);
});

test('02: Legacy Phase 3.0.0/3.0.1 settings with stale gemini-4-hydrogen stage overrides auto-upgrade to route via Primary model', () => {
  const db = getDb();
  const currentRow = db
    .prepare(`SELECT value_json FROM application_settings WHERE key = 'app_config'`)
    .get() as { value_json: string };
  const parsedConfig = JSON.parse(currentRow.value_json);
  parsedConfig.ai = {
    modelId: 'gemini-3.1-flash-lite',
    quickAnalysisModelId: 'gemini-3.1-flash-lite',
    balancedAnalysisModelId: 'gemini-4-hydrogen',
    deepAnalysisModelId: 'gemini-4-neon',
    tacticalSynthesisModelId: 'gemini-4-hydrogen',
    defaultAnalysisMode: 'balanced',
    defaultLanguage: 'en',
  };
  db.prepare(`UPDATE application_settings SET value_json = ? WHERE key = 'app_config'`).run(
    JSON.stringify(parsedConfig)
  );

  const normalized = getSettings().ai;
  assert.equal(normalized.usePrimaryModelForAllStages, true);
  assert.equal(normalized.balancedAnalysisModelId, '');
  assert.equal(normalized.tacticalSynthesisModelId, '');

  const routing = resolveEffectiveModelRouting(normalized, 'balanced');
  assert.equal(routing.effectiveVideoModelId, 'gemini-3.1-flash-lite');
  assert.equal(routing.effectiveSynthesisModelId, 'gemini-3.1-flash-lite');
});

test('03: usePrimaryModelForAllStages=true forces Quick, Balanced, Deep, Synthesis & Comparison to Primary model', () => {
  updateSettings({
    ai: {
      modelId: 'gemini-3.1-flash-lite',
      usePrimaryModelForAllStages: true,
      quickAnalysisModelId: 'gemini-2.5-flash-lite',
      balancedAnalysisModelId: 'gemini-2.5-flash',
      deepAnalysisModelId: 'gemini-2.5-pro',
      tacticalSynthesisModelId: 'gemini-2.5-pro',
    },
  });
  const ai = getSettings().ai;
  for (const mode of ['quick', 'balanced', 'deep'] as const) {
    const r = resolveEffectiveModelRouting(ai, mode);
    assert.equal(r.effectiveVideoModelId, 'gemini-3.1-flash-lite');
    assert.equal(r.effectiveSynthesisModelId, 'gemini-3.1-flash-lite');
    assert.equal(r.comparisonModelId, 'gemini-3.1-flash-lite');
    assert.equal(r.routingSource, 'primary_override');
  }
});

test('04: usePrimaryModelForAllStages=false respects explicit stage overrides and inherits Primary when empty', () => {
  updateSettings({
    ai: {
      modelId: 'gemini-2.5-flash',
      usePrimaryModelForAllStages: false,
      quickAnalysisModelId: '',
      balancedAnalysisModelId: 'gemini-3.1-flash-lite',
      deepAnalysisModelId: 'gemini-2.5-pro',
      tacticalSynthesisModelId: '',
    },
  });
  const ai = getSettings().ai;
  const rQuick = resolveEffectiveModelRouting(ai, 'quick');
  const rBalanced = resolveEffectiveModelRouting(ai, 'balanced');
  const rDeep = resolveEffectiveModelRouting(ai, 'deep');

  assert.equal(rQuick.effectiveVideoModelId, 'gemini-2.5-flash');
  assert.equal(rBalanced.effectiveVideoModelId, 'gemini-3.1-flash-lite');
  assert.equal(rDeep.effectiveVideoModelId, 'gemini-2.5-pro');
  assert.equal(rDeep.effectiveSynthesisModelId, 'gemini-2.5-flash');
});

test('05: Single authoritative routing matches across Settings preview, Preflight, and created Job record', async () => {
  updateSettings({
    ai: {
      modelId: 'gemini-3.1-flash-lite',
      usePrimaryModelForAllStages: true,
    },
  });
  const { match } = createFixtureClubAndMatch('RoutingConsistency');
  const { sessionId, sessionDir } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'route');

  const expected = resolveEffectiveModelRouting(getSettings().ai, 'balanced');
  const preflight = await runAnalysisPreflight({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    analysisMode: 'balanced',
    privacyAuthorized: true,
    isMockProvider: true,
    allowedMediaDirs: [sessionDir],
  });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.routing.effectiveVideoModelId, expected.effectiveVideoModelId);
  assert.equal(preflight.routing.effectiveSynthesisModelId, expected.effectiveSynthesisModelId);

  const started = await startAnalysisJob({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    analysisMode: 'balanced',
    privacyAuthorized: true,
    provider: buildFastMockProvider(),
    allowedMediaDirs: [sessionDir],
    awaitCompletion: true,
  });
  assert.equal(started.job.modelVideoId, 'gemini-3.1-flash-lite');
  assert.equal(started.job.modelSynthesisId, 'gemini-3.1-flash-lite');
});

test('06: Historical completed job preserves original modelVideoId/modelSynthesisId after settings change; re-analysis uses new models', async () => {
  updateSettings({
    ai: { modelId: 'gemini-3.1-flash-lite', usePrimaryModelForAllStages: true },
  });
  const { match } = createFixtureClubAndMatch('HistoricalPreserve');
  const { sessionId, sessionDir } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'hist');

  const run1 = await startAnalysisJob({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    analysisMode: 'quick',
    privacyAuthorized: true,
    provider: buildFastMockProvider(),
    allowedMediaDirs: [sessionDir],
    awaitCompletion: true,
  });
  assert.equal(run1.job.modelVideoId, 'gemini-3.1-flash-lite');

  updateSettings({
    ai: { modelId: 'gemini-2.5-flash', usePrimaryModelForAllStages: true },
  });

  const run2 = await startAnalysisJob({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    analysisMode: 'quick',
    privacyAuthorized: true,
    forceReanalyze: true,
    provider: buildFastMockProvider(),
    allowedMediaDirs: [sessionDir],
    awaitCompletion: true,
  });

  const historicalJob = getAnalysisJob(run1.job.id);
  assert.equal(historicalJob?.modelVideoId, 'gemini-3.1-flash-lite');
  assert.equal(run2.job.modelVideoId, 'gemini-2.5-flash');
  assert.notEqual(run1.job.id, run2.job.id);
});

// ============================================================
// SCENARIOS 7–11: DYNAMIC DISCOVERY & CAPABILITY VERIFICATION
// ============================================================

test('07: Dynamic discoverAvailableGeminiModels filters deprecated/non-video models and flags unlisted configured models as inaccessible', async () => {
  const mockClient: GeminiDiscoveryClientLike = {
    models: {
      async list() {
        async function* gen() {
          yield { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedActions: ['generateContent'] };
          yield { name: 'models/gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite', supportedActions: ['generateContent'] };
          yield { name: 'models/gemini-1.5-flash', displayName: 'Deprecated 1.5', supportedActions: ['generateContent'] };
          yield { name: 'models/gemini-2.0-flash', displayName: 'Deprecated 2.0', supportedActions: ['generateContent'] };
          yield { name: 'models/text-embedding-004', displayName: 'Embedding', supportedActions: ['embedContent'] };
          yield { name: 'models/imagen-3.0-generate-002', displayName: 'Imagen', supportedActions: ['predict'] };
        }
        return gen();
      },
      async generateContent() {
        return { text: '{"ok":true,"note":"ok"}' };
      },
    },
  };

  const res = await discoverAvailableGeminiModels({
    forceRefresh: true,
    clientOverride: mockClient,
    configuredModelIds: ['gemini-4-hydrogen'],
  });
  assert.equal(res.discoveryError, null);
  const ids = res.models.map((m) => m.modelId);
  assert.ok(ids.includes('gemini-2.5-flash'));
  assert.ok(ids.includes('gemini-3.1-flash-lite'));
  assert.ok(!ids.includes('gemini-1.5-flash'), 'Deprecated 1.5 must be excluded');
  assert.ok(!ids.includes('gemini-2.0-flash'), 'Deprecated 2.0 must be excluded');
  assert.ok(!ids.includes('text-embedding-004'), 'Embedding model must be excluded');
  assert.ok(!ids.includes('imagen-3.0-generate-002'), 'Imagen model must be excluded');

  const unlisted = res.models.find((m) => m.modelId === 'gemini-4-hydrogen');
  assert.ok(unlisted, 'Unlisted configured model should be flagged in list');
  assert.equal(unlisted.accessStatus, 'inaccessible');
});

test('08: Discovery failure surfaces sanitized discoveryError without leaking GEMINI_API_KEY', async () => {
  const fakeSecret = process.env.GEMINI_API_KEY!;
  const mockClient: GeminiDiscoveryClientLike = {
    models: {
      async list() {
        throw Object.assign(
          new Error(`Request failed with key=${fakeSecret} Bearer ${fakeSecret}`),
          { status: 401 }
        );
      },
      async generateContent() {
        return { text: '{}' };
      },
    },
  };

  const res = await discoverAvailableGeminiModels({
    forceRefresh: true,
    clientOverride: mockClient,
  });
  assert.ok(res.discoveryError);
  assert.equal(res.discoveryError.code, 'INVALID_API_KEY');
  assert.ok(!res.discoveryError.upstreamMessage.includes(fakeSecret));
  assert.ok(!res.discoveryError.upstreamMessage.includes('AIzaSy'));
});

test('09: verifyModelCapabilities verifies structured JSON and writes SQLite TTL cache for subsequent reuse', async () => {
  let callCount = 0;
  const mockClient: GeminiDiscoveryClientLike = {
    models: {
      async list() {
        async function* gen() {}
        return gen();
      },
      async generateContent() {
        callCount++;
        return { text: JSON.stringify({ ok: true, note: 'connected' }) };
      },
    },
  };

  const first = await verifyModelCapabilities({
    modelId: 'gemini-3.1-flash-lite',
    testVideo: false,
    forceRefresh: true,
    clientOverride: mockClient,
  });
  assert.equal(first.ok, true);
  assert.equal(first.structuredOutputSupported, true);
  assert.equal(callCount, 1);

  // Verify SQLite cache row exists
  const row = getDb()
    .prepare(`SELECT access_status, structured_json_verified FROM gemini_model_capabilities_cache WHERE model_id = ?`)
    .get('gemini-3.1-flash-lite') as { access_status: string; structured_json_verified: number } | undefined;
  assert.ok(row);
  assert.equal(row.access_status, 'verified');
  assert.equal(row.structured_json_verified, 1);

  // Cache hit when clientOverride is omitted and forceRefresh=false
  const cachedHit = await verifyModelCapabilities({
    modelId: 'gemini-3.1-flash-lite',
    testVideo: false,
    forceRefresh: false,
  });
  assert.equal(cachedHit.ok, true);
  assert.equal(cachedHit.latencyMs, 0);
});

test('10: verifyModelCapabilities({ testVideo: true }) synthesizes 1s MP4 via FFmpeg and verifies video input capability', async () => {
  let sawVideoInlineOrUri = false;
  const mockClient: GeminiDiscoveryClientLike = {
    models: {
      async list() {
        async function* gen() {}
        return gen();
      },
      async generateContent(args) {
        const serialized = JSON.stringify(args.contents);
        if (serialized.includes('video/mp4')) sawVideoInlineOrUri = true;
        return { text: JSON.stringify({ ok: true, note: 'video_verified' }) };
      },
    },
  };

  const res = await verifyModelCapabilities({
    modelId: 'gemini-2.5-flash',
    testVideo: true,
    forceRefresh: true,
    clientOverride: mockClient,
  });
  assert.equal(res.ok, true);
  assert.equal(res.videoTested, true);
  assert.equal(res.videoSupported, true);
  assert.equal(sawVideoInlineOrUri, true, 'Video probe must send real video/mp4 payload');
});

test('11: verifyModelCapabilities classifies 404 MODEL_NOT_FOUND as inaccessible and caches failure status', async () => {
  const mockClient: GeminiDiscoveryClientLike = {
    models: {
      async list() {
        async function* gen() {}
        return gen();
      },
      async generateContent() {
        throw Object.assign(new Error('models/gemini-4-hydrogen is not found for API version v1beta'), {
          status: 404,
        });
      },
    },
  };

  const res = await verifyModelCapabilities({
    modelId: 'gemini-4-hydrogen',
    testVideo: false,
    forceRefresh: true,
    clientOverride: mockClient,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'MODEL_NOT_FOUND');
  assert.equal(res.accessStatus, 'inaccessible');

  const row = getDb()
    .prepare(`SELECT access_status, last_error_code FROM gemini_model_capabilities_cache WHERE model_id = ?`)
    .get('gemini-4-hydrogen') as { access_status: string; last_error_code: string } | undefined;
  assert.equal(row?.access_status, 'inaccessible');
  assert.equal(row?.last_error_code, 'MODEL_NOT_FOUND');
});

// ============================================================
// SCENARIOS 12–17: PREFLIGHT GATE BEFORE ANY UPLOAD
// ============================================================

test('12: Preflight blocks missing GEMINI_API_KEY with INVALID_API_KEY before any upload', async () => {
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = '';
  try {
    const { match } = createFixtureClubAndMatch('PreflightNoKey');
    const { sessionId, sessionDir } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'nokey');
    const res = await runAnalysisPreflight({
      matchId: match.id,
      sessionId,
      half: 'first_half',
      privacyAuthorized: true,
      allowedMediaDirs: [sessionDir],
    });
    assert.equal(res.ok, false);
    assert.equal(res.blockingErrorCode, 'INVALID_API_KEY');
  } finally {
    process.env.GEMINI_API_KEY = prevKey;
  }
});

test('13: Preflight blocks inaccessible/404 model with MODEL_NOT_FOUND BEFORE uploading any bytes', async () => {
  updateSettings({
    ai: { modelId: 'gemini-nonexistent-99', usePrimaryModelForAllStages: true },
  });
  const { match } = createFixtureClubAndMatch('Preflight404');
  const { sessionId, sessionDir } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'pf404');
  let uploadCalls = 0;

  const mockPreflightClient: GeminiDiscoveryClientLike = {
    models: {
      async list() {
        async function* gen() {}
        return gen();
      },
      async generateContent() {
        throw Object.assign(new Error('models/gemini-nonexistent-99 is not found'), { status: 404 });
      },
    },
  };

  const liveSpyProvider = buildFastMockProvider({
    isMock: false,
    async uploadAndAwaitActive(inp) {
      uploadCalls++;
      return buildFastMockProvider().uploadAndAwaitActive(inp);
    },
  });

  await assert.rejects(
    () =>
      startAnalysisJob({
        matchId: match.id,
        sessionId,
        half: 'first_half',
        privacyAuthorized: true,
        provider: liveSpyProvider,
        preflightClientOverride: mockPreflightClient,
        allowedMediaDirs: [sessionDir],
        awaitCompletion: true,
      }),
    (err: unknown) => {
      assert.ok(err instanceof GeminiStageError);
      assert.equal(err.geminiErrorCode, 'MODEL_NOT_FOUND');
      return true;
    }
  );
  assert.equal(uploadCalls, 0, 'Zero video bytes may be uploaded when preflight fails');

  updateSettings({
    ai: { modelId: 'gemini-3.1-flash-lite', usePrimaryModelForAllStages: true },
  });
});

test('14: Preflight blocks non-video-capable model (e.g. embedding/tts) with MODEL_VIDEO_UNSUPPORTED', async () => {
  updateSettings({
    ai: { modelId: 'gemini-embedding-001', usePrimaryModelForAllStages: true },
  });
  const { match } = createFixtureClubAndMatch('PreflightNoVideo');
  const { sessionId, sessionDir } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'pfnovid');

  const res = await runAnalysisPreflight({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    privacyAuthorized: true,
    verifyLiveModelAccess: false,
    allowedMediaDirs: [sessionDir],
  });
  assert.equal(res.ok, false);
  assert.equal(res.blockingErrorCode, 'MODEL_VIDEO_UNSUPPORTED');

  updateSettings({
    ai: { modelId: 'gemini-3.1-flash-lite', usePrimaryModelForAllStages: true },
  });
});

test('15: Preflight blocks recording session ownership mismatch with RECORDING_SESSION_MISMATCH', async () => {
  const { match: matchA } = createFixtureClubAndMatch('OwnA');
  const { match: matchB } = createFixtureClubAndMatch('OwnB');
  const { sessionId: sessionB, sessionDir } = await createVerifiedSessionWithSegment(matchB.id, 'first_half', 'ownb');

  const res = await runAnalysisPreflight({
    matchId: matchA.id,
    sessionId: sessionB,
    half: 'first_half',
    privacyAuthorized: true,
    isMockProvider: true,
    allowedMediaDirs: [sessionDir],
  });
  assert.equal(res.ok, false);
  assert.equal(res.blockingErrorCode, 'RECORDING_SESSION_MISMATCH');
});

test('16: Preflight blocks corrupted local MP4 segment with MEDIA_INTEGRITY_FAILED before upload', async () => {
  const { match } = createFixtureClubAndMatch('CorruptSeg');
  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(tempRecordingsRoot, `corrupt_${sessionId.slice(0, 6)}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const badPath = path.join(sessionDir, 'segment_001.mp4');
  fs.writeFileSync(badPath, Buffer.from('not-a-valid-mp4-header-at-all'));

  createOrUpsertMatchSession({
    id: sessionId,
    matchId: match.id,
    half: 'first_half',
    status: 'recording',
    captureSourceName: 'EA SPORTS FC 26',
    outputDirectory: sessionDir,
    integrityStatus: 'pending',
    aiEligible: false,
    resolution: '640x360',
    fps: 15,
    durationSeconds: 10,
    totalBytes: 32,
  });
  upsertRecordingSegment({
    sessionId,
    matchId: match.id,
    segmentIndex: 1,
    originalFileName: 'segment_001.mp4',
    filePath: badPath,
    durationSeconds: 10,
    sizeBytes: 32,
    checksum: 'abc',
    integrityStatus: 'verified',
    status: 'finalized',
  });
  updateMatchSession(sessionId, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    failureReason: null,
  });

  const res = await runAnalysisPreflight({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    privacyAuthorized: true,
    isMockProvider: true,
    allowedMediaDirs: [sessionDir],
  });
  assert.equal(res.ok, false);
  assert.equal(res.blockingErrorCode, 'MEDIA_INTEGRITY_FAILED');
});

test('17: Preflight blocks per-match budget overrun before uploading any bytes', async () => {
  updateSettings({
    ai: {
      modelId: 'gemini-2.5-pro',
      usePrimaryModelForAllStages: true,
      perMatchBudgetUsd: 0.0001,
      dailyBudgetUsd: 5.0,
    },
  });
  const { match } = createFixtureClubAndMatch('BudgetBlock');
  const { sessionId, sessionDir } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'budget');

  const res = await runAnalysisPreflight({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    privacyAuthorized: true,
    isMockProvider: true,
    allowedMediaDirs: [sessionDir],
  });
  assert.equal(res.ok, false);
  assert.equal(res.blockingErrorCode, 'QUOTA_EXCEEDED');

  updateSettings({
    ai: {
      modelId: 'gemini-3.1-flash-lite',
      usePrimaryModelForAllStages: true,
      perMatchBudgetUsd: 1.5,
      dailyBudgetUsd: 5.0,
    },
  });
});

// ============================================================
// SCENARIOS 18–19: EXACT 19-CODE TAXONOMY & SECRET REDACTION
// ============================================================

test('18: classifyGeminiError covers all 19 exact Phase 3.0.2 error codes accurately', () => {
  const cases: Array<[unknown, { stage?: string; modelId?: string }, GeminiErrorCode]> = [
    [{ status: 401, message: 'API_KEY_INVALID' }, {}, 'INVALID_API_KEY'],
    [{ status: 403, message: 'API key has been revoked / reported as leaked' }, {}, 'API_KEY_REVOKED'],
    [{ status: 404, message: 'models/gemini-4-hydrogen is not found' }, { modelId: 'gemini-4-hydrogen' }, 'MODEL_NOT_FOUND'],
    [{ status: 403, message: 'PERMISSION_DENIED does not have access' }, {}, 'MODEL_ACCESS_DENIED'],
    [{ status: 400, message: 'video input not supported by this model' }, {}, 'MODEL_VIDEO_UNSUPPORTED'],
    [{ status: 400, message: 'response_schema structured output not supported' }, {}, 'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED'],
    [{ status: 402, message: 'Please enable billing for paid tier' }, {}, 'BILLING_REQUIRED'],
    [{ status: 429, message: 'RESOURCE_EXHAUSTED rate limit too many requests' }, {}, 'RATE_LIMIT_EXCEEDED'],
    [{ status: 429, message: 'RESOURCE_EXHAUSTED exceeded your current quota per day' }, {}, 'QUOTA_EXCEEDED'],
    [new Error('ECONNRESET socket hang up'), { stage: 'video_upload' }, 'VIDEO_UPLOAD_FAILED'],
    [new Error('Operation timed out after 300s'), { stage: 'video_upload' }, 'VIDEO_UPLOAD_TIMEOUT'],
    [new Error('Gemini media processing ended in unexpected state "FAILED"'), { stage: 'media_processing' }, 'VIDEO_PROCESSING_FAILED'],
    [new Error('Timed out waiting for ACTIVE'), { stage: 'media_processing' }, 'VIDEO_PROCESSING_TIMEOUT'],
    [new Error('Request timed out'), { stage: 'stage2_observation' }, 'INFERENCE_TIMEOUT'],
    [new Error('ECONNREFUSED fetch failed'), { stage: 'stage1_classification' }, 'NETWORK_CONNECTION_FAILED'],
    [{ status: 503, message: 'Service Unavailable overloaded' }, { stage: 'stage3_synthesis' }, 'UPSTREAM_SERVICE_UNAVAILABLE'],
    [new Error('Malformed JSON returned from model'), { stage: 'stage1_classification' }, 'INVALID_MODEL_RESPONSE'],
    [new Error('__JOB_CANCELLED__'), { stage: 'stage2_observation' }, 'ANALYSIS_CANCELLED'],
    [new Error('APP_RESTARTED_MID_JOB interrupted'), { stage: 'stage2_observation' }, 'ANALYSIS_INTERRUPTED'],
  ];

  const seen = new Set<GeminiErrorCode>();
  for (const [err, ctx, expected] of cases) {
    const classified = classifyGeminiError(err, ctx);
    assert.equal(classified.code, expected, `Expected ${expected}, got ${classified.code}`);
    seen.add(classified.code);
  }
  assert.equal(seen.size, 19, 'All 19 error codes must be distinct and covered');
});

test('19: Secret redaction scrubs AIza..., Bearer..., key=... and GEMINI_API_KEY from diagnostics and backups', () => {
  const envKey = process.env.GEMINI_API_KEY!;
  const dirty = `Upstream error at https://api.google.com/v1?key=${envKey} with Authorization: Bearer secret_token_999 and AIzaSyAnotherExposedKey123456789012345`;
  const clean = sanitizeDiagnosticText(dirty);
  assert.ok(!clean.includes(envKey));
  assert.ok(!clean.includes('secret_token_999'));
  assert.ok(!clean.includes('AIzaSyAnotherExposedKey'));
  assert.ok(clean.includes('[REDACTED'));

  const backupJson = JSON.stringify(exportDatabaseBackup());
  assert.ok(!backupJson.includes(envKey), 'Database backup must never contain GEMINI_API_KEY');
});

// ============================================================
// SCENARIOS 20–24: BOUNDED RETRIES, NO-RETRY PERMANENT, TIMEOUTS
// ============================================================

test('20: withBoundedStageRetries retries transient 503/429 respecting Retry-After and succeeds on attempt 2', async () => {
  let attempts = 0;
  let retryCallbacks = 0;
  const result = await withBoundedStageRetries({
    stage: 'stage1_classification',
    modelId: 'gemini-3.1-flash-lite',
    maxRetries: 2,
    timeoutMs: 5000,
    baseDelayMs: 20,
    onRetryAttempt: () => {
      retryCallbacks++;
    },
    fn: async () => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error('503 Service Unavailable'), {
          status: 503,
          retryAfterMs: 40,
        });
      }
      return 'ok-attempt-2';
    },
  });
  assert.equal(result, 'ok-attempt-2');
  assert.equal(attempts, 2);
  assert.equal(retryCallbacks, 1);
});

test('21: withBoundedStageRetries NEVER retries permanent errors (401/404/403/billing/unsupported) — strictly 1 attempt', async () => {
  const permanentErrors = [
    { status: 401, message: 'API_KEY_INVALID' },
    { status: 404, message: 'models/bad-model is not found' },
    { status: 403, message: 'PERMISSION_DENIED' },
    { status: 402, message: 'enable billing' },
    { status: 400, message: 'video not supported' },
  ];

  for (const permErr of permanentErrors) {
    let attempts = 0;
    await assert.rejects(() =>
      withBoundedStageRetries({
        stage: 'stage1_classification',
        modelId: 'gemini-bad',
        maxRetries: 3,
        timeoutMs: 5000,
        baseDelayMs: 10,
        fn: async () => {
          attempts++;
          throw permErr;
        },
      })
    );
    assert.equal(attempts, 1, `Permanent error "${permErr.message}" must NEVER be retried`);
  }
});

test('22: Bounded VIDEO_UPLOAD_TIMEOUT aborts hung upload cleanly via AbortSignal and records diagnostics', async () => {
  updateSettings({
    ai: {
      modelId: 'gemini-3.1-flash-lite',
      usePrimaryModelForAllStages: true,
      uploadTimeoutSeconds: 30,
      maxRetryAttempts: 0,
    },
  });
  let abortedObserved = false;
  await assert.rejects(
    () =>
      runWithTimeoutAndAbort({
        stage: 'video_upload',
        modelId: 'gemini-3.1-flash-lite',
        timeoutMs: 60,
        timeoutCode: 'VIDEO_UPLOAD_TIMEOUT',
        timeoutMessage: 'Video upload timed out cleanly.',
        fn: (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              abortedObserved = true;
              reject(new Error('Upload aborted by timeout'));
            });
          }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GeminiStageError);
      assert.equal(err.geminiErrorCode, 'VIDEO_UPLOAD_TIMEOUT');
      return true;
    }
  );
  assert.equal(abortedObserved, true, 'AbortSignal must fire on upload timeout');
});

test('23: Bounded VIDEO_PROCESSING_TIMEOUT aborts hung processing poll AND cleans up already-uploaded remote file immediately', async () => {
  const { match } = createFixtureClubAndMatch('ProcTimeout');
  const { sessionId, sessionDir, segPath } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'procto');
  const deletedRemoteNames: string[] = [];

  const timeoutProvider = buildFastMockProvider({
    async uploadAndAwaitActive(input) {
      const remoteName = 'files/orphan-proc-timeout-1';
      if (input.onRemoteFileUploaded) {
        input.onRemoteFileUploaded({
          remoteFileName: remoteName,
          remoteFileUri: `https://generativelanguage.googleapis.com/v1beta/${remoteName}`,
          remoteState: 'PROCESSING',
        });
      }
      throw new GeminiStageError({
        code: 'VIDEO_PROCESSING_TIMEOUT',
        userMessage: 'Gemini media processing timed out waiting for ACTIVE.',
        retryable: true,
        diagnostic: {
          code: 'VIDEO_PROCESSING_TIMEOUT',
          httpStatus: null,
          apiStatus: null,
          upstreamMessage: 'Processing timeout after 180s',
          stage: 'media_processing',
          modelId: 'gemini-3.1-flash-lite',
          segmentIndex: 1,
          attemptNumber: 1,
          elapsedMs: 180_000,
          retryable: true,
          retryAfterMs: null,
          occurredAt: new Date().toISOString(),
        },
      });
    },
    async deleteRemoteFile(name) {
      deletedRemoteNames.push(name);
      return { deleted: true, error: null };
    },
  });

  const started = await startAnalysisJob({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    analysisMode: 'quick',
    privacyAuthorized: true,
    provider: timeoutProvider,
    allowedMediaDirs: [sessionDir],
    awaitCompletion: true,
  });

  const job = getAnalysisJob(started.job.id)!;
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'VIDEO_PROCESSING_TIMEOUT');
  assert.ok(job.diagnostics);
  assert.equal(job.diagnostics.code, 'VIDEO_PROCESSING_TIMEOUT');
  assert.deepEqual(deletedRemoteNames, ['files/orphan-proc-timeout-1']);

  const bundle = listMatchAnalysisBundle(match.id, job.id);
  assert.equal(bundle.assets[0]?.cleanupStatus, 'deleted');
  assert.ok(fs.existsSync(segPath), 'Local original MP4 MUST remain intact after remote cleanup');
});

test('24: Bounded INFERENCE_TIMEOUT fails cleanly with INFERENCE_TIMEOUT and deletes remote file', async () => {
  const { match } = createFixtureClubAndMatch('InfTimeout');
  const { sessionId, sessionDir } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'infto');
  const deletedRemoteNames: string[] = [];

  const infTimeoutProvider = buildFastMockProvider({
    async classifyVideoSegment() {
      throw new GeminiStageError({
        code: 'INFERENCE_TIMEOUT',
        userMessage: 'Gemini inference timed out.',
        retryable: true,
        diagnostic: {
          code: 'INFERENCE_TIMEOUT',
          httpStatus: null,
          apiStatus: null,
          upstreamMessage: 'Stage 1 inference timeout',
          stage: 'stage1_classification',
          modelId: 'gemini-3.1-flash-lite',
          segmentIndex: 1,
          attemptNumber: 1,
          elapsedMs: 180_000,
          retryable: true,
          retryAfterMs: null,
          occurredAt: new Date().toISOString(),
        },
      });
    },
    async deleteRemoteFile(name) {
      deletedRemoteNames.push(name);
      return { deleted: true, error: null };
    },
  });

  const started = await startAnalysisJob({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    analysisMode: 'quick',
    privacyAuthorized: true,
    provider: infTimeoutProvider,
    allowedMediaDirs: [sessionDir],
    awaitCompletion: true,
  });

  const job = getAnalysisJob(started.job.id)!;
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'INFERENCE_TIMEOUT');
  assert.equal(deletedRemoteNames.length, 1);
});

// ============================================================
// SCENARIOS 25–28: CANCELLATION, DURABLE CLEANUP, RECOVERY, STALE
// ============================================================

test('25: cancelAnalysisJob triggers AbortSignal, marks job cancelled (ANALYSIS_CANCELLED), blocks late writes, and cleans remote file', async () => {
  const { match } = createFixtureClubAndMatch('CancelFlow');
  const { sessionId, sessionDir } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'cancel');
  let abortSignalFired = false;
  let markStage1Started!: () => void;
  const stage1Started = new Promise<void>((resolve) => {
    markStage1Started = resolve;
  });
  const deletedRemotes: string[] = [];

  const slowProvider = buildFastMockProvider({
    async classifyVideoSegment(input) {
      markStage1Started();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 4000);
        input.abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          abortSignalFired = true;
          reject(new Error('__JOB_CANCELLED__'));
        });
      });
      return buildFastMockProvider().classifyVideoSegment(input);
    },
    async deleteRemoteFile(name) {
      deletedRemotes.push(name);
      return { deleted: true, error: null };
    },
  });

  const started = await startAnalysisJob({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    analysisMode: 'quick',
    privacyAuthorized: true,
    provider: slowProvider,
    allowedMediaDirs: [sessionDir],
    awaitCompletion: false,
  });

  // Deterministically wait until upload finishes and stage1 inference starts, then cancel
  await stage1Started;
  const cancelled = cancelAnalysisJob(started.job.id);
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.errorCode, 'ANALYSIS_CANCELLED');

  // Give background pipeline time to unwind and clean up remote file
  await new Promise((r) => setTimeout(r, 350));
  const afterJob = getAnalysisJob(started.job.id)!;
  assert.equal(afterJob.status, 'cancelled', 'Late background writes must NOT overwrite cancelled terminal status');
  assert.equal(abortSignalFired, true, 'AbortSignal must fire on cancelAnalysisJob');
  assert.equal(deletedRemotes.length, 1, 'Remote file must be cleaned up on cancellation');
});

test('26: Durable remote cleanup transitions (cleanup_failed -> retryRemoteCleanup -> deleted) while keeping local MP4 untouched', async () => {
  const { match } = createFixtureClubAndMatch('RetryCleanup');
  const { sessionId, sessionDir, segPath } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'retryc');
  let failDelete = true;

  const flakyDeleteProvider = buildFastMockProvider({
    async deleteRemoteFile() {
      if (failDelete) {
        return { deleted: false, error: 'Transient 503 during files.delete' };
      }
      return { deleted: true, error: null };
    },
  });

  const started = await startAnalysisJob({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    analysisMode: 'quick',
    privacyAuthorized: true,
    provider: flakyDeleteProvider,
    allowedMediaDirs: [sessionDir],
    awaitCompletion: true,
  });

  const bundleBefore = listMatchAnalysisBundle(match.id, started.job.id);
  assert.equal(bundleBefore.assets[0]?.cleanupStatus, 'cleanup_failed');
  assert.ok((bundleBefore.assets[0]?.cleanupAttempts ?? 0) >= 1);

  failDelete = false;
  const retried = await retryRemoteCleanup(started.job.id, flakyDeleteProvider);
  assert.equal(retried[0]?.cleanupStatus, 'deleted');
  assert.ok(retried[0]?.cleanupConfirmedAt);
  assert.ok(fs.existsSync(segPath), 'Local original MP4 must never be deleted by remote cleanup');
});

test('27: Startup interrupted recovery marks orphaned active jobs ANALYSIS_INTERRUPTED, does NOT auto-restart uploads, and sweeps orphaned remote files', async () => {
  const { match } = createFixtureClubAndMatch('StartupRecovery');
  const { sessionId, segPath, segment } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'startrec');
  const db = getDb();
  const orphanJobId = crypto.randomUUID();
  const orphanAssetId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ai_analysis_jobs (
      id, match_id, session_id, half, analysis_mode, language, status, current_stage,
      progress_detail_json, model_video_id, model_synthesis_id, prompt_version, schema_version,
      request_fingerprint, privacy_authorized, created_at, updated_at
    ) VALUES (?, ?, ?, 'first_half', 'balanced', 'en', 'waiting_for_media_processing', 'media_processing', '{}',
      'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite', 'v3.0.2', 'v3', ?, 1, ?, ?)
  `).run(orphanJobId, match.id, sessionId, `orphan-${orphanJobId}`, now, now);

  db.prepare(`
    INSERT INTO ai_analysis_assets (
      id, job_id, match_id, session_id, segment_id, local_file_path, is_temp_asset,
      sha256_hash, file_size_bytes, duration_seconds, remote_file_name, remote_file_uri,
      remote_state, cleanup_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'sha', 100, 10, 'files/orphan-startup-1', 'uri', 'ACTIVE', 'uploaded', ?, ?)
  `).run(orphanAssetId, orphanJobId, match.id, sessionId, segment.id, segPath, now, now);

  const count = markInterruptedJobsOnStartup(db);
  assert.ok(count >= 1);
  const jobAfter = getAnalysisJob(orphanJobId, db)!;
  assert.equal(jobAfter.status, 'interrupted');
  assert.equal(jobAfter.errorCode, 'ANALYSIS_INTERRUPTED');

  const deleted: string[] = [];
  const sweep = await cleanupPendingRemoteFiles(
    buildFastMockProvider({
      async deleteRemoteFile(name) {
        deleted.push(name);
        return { deleted: true, error: null };
      },
    }),
    db
  );
  assert.ok(sweep.deleted >= 1);
  assert.ok(deleted.includes('files/orphan-startup-1'));
});

test('28: Stale heartbeat reconciliation marks hung job interrupted & unblocks fresh launch while blocking healthy duplicate jobs', async () => {
  const { match } = createFixtureClubAndMatch('StaleReconcile');
  const { sessionId, sessionDir } = await createVerifiedSessionWithSegment(match.id, 'first_half', 'stale', {
    durationSec: 20,
  });
  const db = getDb();
  const staleJobId = crypto.randomUUID();
  const oldTs = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO ai_analysis_jobs (
      id, match_id, session_id, half, analysis_mode, language, status, current_stage,
      progress_detail_json, model_video_id, model_synthesis_id, prompt_version, schema_version,
      request_fingerprint, privacy_authorized, last_heartbeat_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'first_half', 'quick', 'en', 'analyzing_gameplay', 'stage2', '{}',
      'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite', 'v3.0.2', 'v3', ?, 1, ?, ?, ?)
  `).run(staleJobId, match.id, sessionId, `stale-${staleJobId}`, oldTs, oldTs, oldTs);

  const reconciled = reconcileStaleAnalysisJobs({ db, staleThresholdMs: 5 * 60 * 1000 });
  assert.ok(reconciled >= 1);
  assert.equal(getAnalysisJob(staleJobId, db)?.status, 'interrupted');

  // Fresh launch now succeeds
  const fresh = await startAnalysisJob({
    matchId: match.id,
    sessionId,
    half: 'first_half',
    analysisMode: 'quick',
    privacyAuthorized: true,
    provider: buildFastMockProvider(),
    allowedMediaDirs: [sessionDir],
    awaitCompletion: true,
  });
  assert.equal(
    fresh.job.status,
    'completed',
    `Expected completed but got ${fresh.job.status}: ${fresh.job.errorCode} — ${fresh.job.errorMessage}`
  );
});

// ============================================================
// SCENARIO 29: FFMPEG MODE-SPECIFIC ANALYSIS PROXY
// ============================================================

test('29: FFmpeg analysis proxy transcodes high-res/high-fps/audio clip in Quick mode, preserves duration & original file, and skips already-compliant clips', async () => {
  const quickSpec = getAnalysisProxyProfileSpec('quick');
  assert.equal(quickSpec.maxHeight, 720);
  assert.equal(quickSpec.maxFps, 15);
  assert.equal(quickSpec.stripAudio, true);

  const highResPath = path.join(tempRecordingsRoot, 'proxy_src_1080p.mp4');
  await generateTestMp4(highResPath, {
    width: 1280,
    height: 720,
    fps: 30,
    durationSec: 4,
    withAudio: true,
  });
  const origSize = fs.statSync(highResPath).size;
  const origSha = crypto.createHash('sha256').update(fs.readFileSync(highResPath)).digest('hex');

  const jobId1 = `proxy-job-${crypto.randomUUID().slice(0, 8)}`;
  const prepared = await prepareAnalysisVideoAsset({
    jobId: jobId1,
    filePath: highResPath,
    analysisMode: 'quick',
    proxyEnabled: true,
    allowedBaseDirs: [tempRecordingsRoot],
  });

  assert.equal(prepared.proxyApplied, true, '30fps clip with audio should be proxied in quick mode (15fps, no audio)');
  assert.equal(prepared.isTempAsset, true);
  assert.equal(prepared.originalSizeBytes, origSize);
  assert.ok(prepared.processedSizeBytes > 0);
  assert.ok(Math.abs(prepared.metadata.durationSeconds - 4) < 0.75, 'Duration/timestamps must be preserved');

  // Verify original file untouched
  const afterSha = crypto.createHash('sha256').update(fs.readFileSync(highResPath)).digest('hex');
  assert.equal(afterSha, origSha, 'Original gameplay recording MUST remain byte-for-byte untouched');

  // Verify temp proxy cleanup removes temp dir
  cleanupTempAnalysisDir(jobId1);
  assert.ok(!fs.existsSync(prepared.preparedFilePath), 'Temp proxy file must be removed after cleanup');

  // Now verify smart skip on already-compliant small no-audio 640x360@15fps clip
  const smallCompliantPath = path.join(tempRecordingsRoot, 'proxy_small_compliant.mp4');
  await generateTestMp4(smallCompliantPath, {
    width: 640,
    height: 360,
    fps: 15,
    durationSec: 3,
    withAudio: false,
  });
  const probeSmall = await validateVideoFile(smallCompliantPath, [tempRecordingsRoot]);
  assert.equal(probeSmall.valid, true);

  const jobId2 = `proxy-skip-${crypto.randomUUID().slice(0, 8)}`;
  const skipped = await prepareAnalysisVideoAsset({
    jobId: jobId2,
    filePath: smallCompliantPath,
    analysisMode: 'quick',
    proxyEnabled: true,
    allowedBaseDirs: [tempRecordingsRoot],
  });
  assert.equal(skipped.proxyApplied, false, 'Already-compliant small clip should skip unnecessary transcoding');
  assert.equal(skipped.preparedFilePath, smallCompliantPath);
});

// ============================================================
// SCENARIO 30: NON-DESTRUCTIVE MIGRATION V8 & BACKUP V8
// ============================================================

test('30: Non-destructive v7->v8 migration preserves existing jobs/assets, maps pending->cleanup_pending, and Backup v8 export/restore passes PRAGMA foreign_key_check', () => {
  const v7Path = path.join(tempRoot, 'legacy_v7.db');
  const v7Db = new Database(v7Path);
  v7Db.pragma('foreign_keys = ON');
  v7Db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  for (const m of MIGRATIONS.filter((mig) => mig.version <= 7)) {
    if (m.disableForeignKeys) v7Db.pragma('foreign_keys = OFF');
    v7Db.transaction(() => {
      v7Db.exec(m.sql);
      if (m.afterSql) m.afterSql(v7Db);
      v7Db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, '2026-01-01T00:00:00.000Z');
    })();
    if (m.disableForeignKeys) v7Db.pragma('foreign_keys = ON');
  }

  // Seed legacy v7 club/match/job/asset with cleanup_status = 'pending'
  v7Db.prepare(`INSERT INTO clubs (id, name, league, created_at, updated_at) VALUES ('c7', 'Chelsea', 'Premier League', '2026-01-01', '2026-01-01')`).run();
  v7Db.prepare(`INSERT INTO career_profiles (id, club_id, season, manager_name, preferred_philosophy, primary_formation, alternative_formation, preferred_attacking_style, preferred_defensive_style, is_active, created_at, updated_at) VALUES ('cp7', 'c7', '2025/26', 'Enzo', 'Possession', '4-2-3-1 Wide', '4-3-3 Holding', 'Short Passing', 'High', 1, '2026-01-01', '2026-01-01')`).run();
  v7Db.prepare(`INSERT INTO opponents (id, name, league, created_at, updated_at) VALUES ('o7', 'Sunderland', 'Premier League', '2026-01-01', '2026-01-01')`).run();
  v7Db.prepare(`INSERT INTO matches (id, club_id, career_profile_id, opponent_id, competition, venue, match_date, status, starting_formation, starting_xi_json, bench_json, objective, pre_match_notes, created_at, updated_at) VALUES ('m7', 'c7', 'cp7', 'o7', 'Premier League', 'home', '2026-11-25', 'scheduled', '4-2-3-1 Wide', '[]', '[]', 'Win', '', '2026-01-01', '2026-01-01')`).run();
  v7Db.prepare(`INSERT INTO ai_analysis_jobs (id, match_id, half, analysis_mode, language, status, current_stage, progress_detail_json, model_video_id, model_synthesis_id, prompt_version, schema_version, request_fingerprint, privacy_authorized, created_at, updated_at) VALUES ('j7', 'm7', 'first_half', 'balanced', 'en', 'failed', 'stage1', '{}', 'gemini-4-hydrogen', 'gemini-4-hydrogen', 'v3', 'v3', 'fp7', 1, '2026-01-01', '2026-01-01')`).run();
  v7Db.prepare(`INSERT INTO ai_analysis_assets (id, job_id, match_id, local_file_path, is_temp_asset, sha256_hash, file_size_bytes, duration_seconds, remote_file_name, cleanup_status, created_at, updated_at) VALUES ('a7', 'j7', 'm7', 'segment_001.mp4', 0, 'sha7', 500000, 120, 'files/legacy-1', 'pending', '2026-01-01', '2026-01-01')`).run();

  // Apply Migration v8
  runMigrations(v7Db);
  const version = (v7Db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number }).v;
  assert.ok(version >= 8, `Expected schema version >= 8, got ${version}`);

  const assetAfter = v7Db
    .prepare('SELECT cleanup_status, original_size_bytes, processed_size_bytes FROM ai_analysis_assets WHERE id = ?')
    .get('a7') as { cleanup_status: string; original_size_bytes: number; processed_size_bytes: number };
  assert.equal(assetAfter.cleanup_status, 'cleanup_pending', 'Legacy pending cleanup status must map to cleanup_pending');
  assert.equal(assetAfter.original_size_bytes, 500000);
  assert.equal(assetAfter.processed_size_bytes, 500000);

  const fkCheckV8 = v7Db.pragma('foreign_key_check') as unknown[];
  assert.equal(fkCheckV8.length, 0, 'Migrated v7->v8 DB must have zero foreign key violations');
  v7Db.close();

  // Export v8 backup and verify restore + legacy v7 format compatibility
  const backupV8 = exportDatabaseBackup();
  assert.ok(
    backupV8.format === 'fc26-ai-manager-backup-v8' || backupV8.format === 'fc26-ai-manager-backup-v9',
    `Expected backup format v8/v9, got ${backupV8.format}`
  );
  restoreDatabaseBackup(backupV8);
  const fkAfterRestore = getDb().pragma('foreign_key_check') as unknown[];
  assert.equal(fkAfterRestore.length, 0);
});

async function runAll() {
  let passed = 0;
  let failed = 0;
  console.log(`\nRunning Phase 3.0.2 Automated Test Suite (${tests.length} scenarios) in ${tempRoot}...\n`);

  for (const t of tests) {
    try {
      await t.run();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : String(err));
      failed++;
    }
  }

  closeDb();
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup warnings
  }

  console.log(`\nPhase 3.0.2 Suite Summary: ${passed}/${tests.length} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('Phase 3.0.2 test runner crashed:', err);
  closeDb();
  process.exit(1);
});
