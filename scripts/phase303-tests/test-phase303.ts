/**
 * Phase 3.0.3 Automated Regression Test Suite
 * Covers:
 * - Windows Gemini 3.5 Flash Quick Mode bug reproduction (`CHECK constraint failed: confidence IN ('High', 'Medium', 'Low')`)
 * - Centralized AI response runtime validation & safe canonical enum normalization
 * - Strict rejection of ambiguous/invalid enum values + bounded 1-pass JSON repair
 * - Canonical enum constraints on all 4 Gemini structured output schemas
 * - Strict error-domain separation: SQLite CHECK/persistence errors NEVER misclassified as Gemini upstream failures
 * - Atomic SQLite transactions & rollback integrity (0 partial rows)
 * - 4 independent capability probes (`text_json`, `image`, `inline_video`, `files_api_video` with remote cleanup)
 * - Model health tracking (`healthy` -> `degraded` -> `cooldown` -> `unsupported`) & reset
 * - Adaptive model failover with remote URI reuse & `allowHigherCostFailover` cost guardrail
 * - Stage checkpoint persistence, opt-in resume (never auto-resume), and invalidation
 * - Opt-in sequential keyframe fallback via FFmpeg leaving original MP4 untouched + temp cleanup + honest limitation disclosure
 * - Migration v8 -> v9 schema upgrade, foreign_key_check, and Backup v9 round-trip integrity
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

// Set isolated temp paths BEFORE loading any server module
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc26-phase303-test-'));
const tempRecordingsRoot = path.join(tempRoot, 'recordings');
fs.mkdirSync(tempRecordingsRoot, { recursive: true });

process.env.FC26_USER_DATA_DIR = tempRoot;
process.env.FC26_APP_USER_DATA_ROOT = tempRoot;
process.env.FC26_RECORDINGS_DIR = tempRecordingsRoot;
process.env.GEMINI_API_KEY = 'AIzaSyPhase303TestFakeKey1234567890ABCD';

async function main() {
  const {
    closeDb,
    exportDatabaseBackup,
    getDb,
    restoreDatabaseBackup,
  } = await import('../../server/db/database.ts');
  const { MIGRATIONS, runMigrations } = await import('../../server/db/migrations.ts');
  const {
    CANONICAL_ACTION_TYPES,
    CANONICAL_CATEGORY_GROUPS,
    CANONICAL_CONFIDENCE_LEVELS,
    CANONICAL_CRITERIA_ASSESSMENTS,
    CANONICAL_EVIDENCE_QUALITIES,
    CANONICAL_EVIDENCE_TYPES,
    CANONICAL_OUTCOME_ASSESSMENTS,
    CANONICAL_PRIORITY_GROUPS,
    CANONICAL_RECOMMENDATION_STANCES,
    CANONICAL_SEVERITY_LEVELS,
    CANONICAL_TEAM_ATTRIBUTIONS,
    CANONICAL_VIDEO_CONTENT_TYPES,
    normalizeActionType,
    normalizeCategoryGroup,
    normalizeConfidenceLevel,
    normalizeEvidenceQuality,
    normalizeEvidenceType,
    normalizeOutcomeAssessment,
    normalizePriorityGroup,
    normalizeRecommendationStance,
    normalizeSeverityLevel,
    normalizeTeamAttribution,
    normalizeVideoContentType,
    validateClassificationStageResponse,
    validateComparisonStageResponse,
    validateObservationStageResponse,
    validateSynthesisStageResponse,
  } = await import('../../server/services/aiResponseValidationService.ts');
  const {
    getModelHealth,
    isFailoverEligibleErrorCode,
    isModelUnavailableByHealth,
    listAllModelHealth,
    recordModelFailure,
    recordModelSuccess,
    resetModelHealth,
    selectFailoverCandidate,
  } = await import('../../server/services/modelHealthService.ts');
  const {
    getResumableCheckpointsForMatchHalf,
    invalidateCheckpointsForMatchHalf,
    listMatchAnalysisBundle,
    startAnalysisJob,
  } = await import('../../server/services/aiAnalysisOrchestrator.ts');
  const {
    classifyGeminiError,
    clearGeminiDiscoveryAndCapabilityCaches,
    verifyModelCapabilities,
  } = await import('../../server/services/geminiService.ts');
  const {
    buildStage1ClassificationSchema,
    buildStage2ObservationSchema,
    buildStage3SynthesisSchema,
    buildStage4ComparisonSchema,
    GeminiStageError,
  } = await import('../../server/services/geminiVideoService.ts');
  const {
    createClub,
    createMatch,
    createOrUpsertMatchSession,
    createPlayer,
    getSettings,
    updateMatchSession,
    updateSettings,
    upsertRecordingSegment,
  } = await import('../../server/services/repository.ts');
  const {
    extractSequentialFallbackFrames,
    resolveServerFfmpegBinaries,
  } = await import('../../server/services/videoPreprocessingService.ts');

  type GeminiDiscoveryClientLike = import('../../server/services/geminiService.ts').GeminiDiscoveryClientLike;
  type GeminiVideoProvider = import('../../server/services/geminiVideoService.ts').GeminiVideoProvider;
  type GeminiModelCapability = import('../../src/types/domain.ts').GeminiModelCapability;

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
    options: { width?: number; height?: number; fps?: number; durationSec?: number } = {}
  ): Promise<string> {
    const bins = resolveServerFfmpegBinaries();
    assert.ok(bins.ffmpegPath, 'FFmpeg must be available in environment for Phase 3.0.3 tests');
    const w = options.width ?? 640;
    const h = options.height ?? 360;
    const fps = options.fps ?? 15;
    const dur = options.durationSec ?? 12;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const args = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${w}x${h}:rate=${fps}:duration=${dur}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-movflags',
      '+faststart',
      outputPath,
    ];
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
      opponentName: `Arsenal ${label}`,
      competition: 'Premier League',
      venue: 'home',
      matchDate: '2026-11-25',
      startingFormation: '4-2-3-1 Wide',
      startingXiIds: starters.map((p) => p.id),
      benchIds: bench.map((p) => p.id),
      objective: 'Control possession and dominate midfield',
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

  async function createVerifiedSessionWithSegments(
    matchId: string,
    half: 'first_half' | 'second_half',
    label: string,
    segmentCount = 1,
    durationSec = 14
  ) {
    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(tempRecordingsRoot, `session_${label}_${sessionId.slice(0, 6)}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    let totalBytes = 0;
    const segPaths: string[] = [];

    createOrUpsertMatchSession({
      id: sessionId,
      matchId,
      half,
      status: 'recording',
      captureSourceName: 'EA SPORTS FC 26',
      outputDirectory: sessionDir,
      integrityStatus: 'pending',
      aiEligible: false,
      resolution: '640x360',
      fps: 15,
      durationSeconds: durationSec * segmentCount,
      totalBytes: 0,
    });

    for (let i = 1; i <= segmentCount; i++) {
      const fileName = `segment_00${i}.mp4`;
      const segPath = path.join(sessionDir, fileName);
      await generateTestMp4(segPath, { width: 640, height: 360, fps: 15, durationSec });
      const stat = fs.statSync(segPath);
      const sha = crypto.createHash('sha256').update(fs.readFileSync(segPath)).digest('hex');
      totalBytes += stat.size;
      segPaths.push(segPath);

      upsertRecordingSegment({
        sessionId,
        matchId,
        segmentIndex: i,
        originalFileName: fileName,
        filePath: segPath,
        durationSeconds: durationSec,
        sizeBytes: stat.size,
        checksum: sha,
        integrityStatus: 'verified',
        status: 'finalized',
      });
    }

    updateMatchSession(sessionId, {
      status: 'completed',
      integrityStatus: 'verified',
      aiEligible: true,
      failureReason: null,
      durationSeconds: durationSec * segmentCount,
      totalBytes,
    });

    return { sessionId, sessionDir, segPaths };
  }

  function buildMockProvider(overrides: Partial<GeminiVideoProvider> = {}): GeminiVideoProvider {
    return {
      isMock: true,
      async uploadAndAwaitActive(input) {
        const remoteName = `files/p303-${crypto.randomUUID().slice(0, 8)}`;
        const remoteUri = `https://generativelanguage.googleapis.com/v1beta/${remoteName}`;
        input.onRemoteFileUploaded?.({
          remoteFileName: remoteName,
          remoteFileUri: remoteUri,
          remoteState: 'PROCESSING',
        });
        input.onWaitingForProcessing?.();
        return {
          remoteFileName: remoteName,
          remoteFileUri: remoteUri,
          remoteState: 'ACTIVE',
          uploadMs: 10,
          mediaProcessingMs: 5,
        };
      },
      async deleteRemoteFile() {
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
              evidenceDescription: 'Broadcast gameplay camera on pitch',
              inGameClock: '14:00',
            },
          ],
          readableHudStats: {
            scoreline: '0-0',
            matchClock: '14:00',
            possessionLabel: null,
            shotsLabel: null,
            otherVerifiedStats: [],
          },
          usage: {
            modelId: input.modelId,
            inputTokens: 1000,
            outputTokens: 250,
            estimatedCostUsd: 0.001,
            durationMs: 20,
          },
        };
      },
      async extractGameplayObservations(input) {
        return {
          observations: [
            {
              startSeconds: 1,
              endSeconds: Math.min(10, Math.max(3, input.segmentDurationSeconds - 1)),
              inGameClock: '19:15',
              categoryGroup: 'defensive',
              category: 'Right flank transition gap',
              teamAttribution: 'user_team',
              playerAttribution: 'Unknown',
              description: 'Right fullback pushed high leaving channel open during turnover.',
              supportingVisualEvidence: 'Clear space behind right fullback on transition.',
              evidenceType: 'directly_observed',
              confidence: 'High',
              severity: 'High',
              limitations: 'Wide broadcast zoom hides jersey numbers.',
              isFromReplay: false,
            },
          ],
          usage: {
            modelId: input.modelId,
            inputTokens: 1400,
            outputTokens: 450,
            estimatedCostUsd: 0.0015,
            durationMs: 25,
          },
        };
      },
      async synthesizeTacticalBriefing(input) {
        return {
          evidenceQuality: 'moderate',
          managerVerdict: {
            whatIsWorking: ['Central build-up composure'],
            whatIsNotWorking: ['Transition cover behind right fullback'],
            whyTacticStruggling: 'Right fullback pushes high without midfield cover.',
            firstPriorityChange: 'Drop right fullback to Defend focus.',
            conciseSummary: 'Verified transition gap on the right flank.',
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
            recommendationRationale: 'Possession base works; tighten rest defense.',
            executionAssessmentLabel: 'Moderate execution',
            internalAssessmentScore: 72,
            scoreMethodologyNote: 'Test synthesis',
            criteriaBreakdown: [
              {
                criterion: 'Rest Defense',
                assessment: 'weak',
                evidenceNote: 'Exposed channel behind RB',
              },
            ],
            confidence: 'Medium',
            limitations: 'Short clip',
          },
          recommendations: [
            {
              priorityGroup: 'immediate_correction',
              priorityRank: 1,
              actionType: 'defensive_line_height',
              title: 'Lower defensive line to 55',
              currentValue: '65',
              proposedValue: '55',
              targetSlotId: null,
              targetPlayerId: null,
              targetPlayerOutId: null,
              targetPlayerInId: null,
              reason: 'Reduce transition gap behind fullbacks.',
              expectedBenefit: 'Tighter rest defense on turnovers.',
              potentialRisk: 'Slightly less high-press recovery.',
              evidenceObservationIds: [],
              evidenceTimestamps: [{ segmentId: null, startSeconds: 1, endSeconds: 10, inGameClock: '19:15' }],
              confidence: 'High',
            },
          ],
          usage: {
            modelId: input.modelId,
            inputTokens: 1200,
            outputTokens: 500,
            estimatedCostUsd: 0.0015,
            durationMs: 25,
          },
        };
      },
      async synthesizeSecondHalfComparison(input) {
        return {
          summary: 'Second half comparison',
          appliedAdjustmentsReviewed: [
            {
              recommendationTitle: 'Lower defensive line to 55',
              userConfirmedAppliedInGame: true,
              observedSecondHalfPattern: 'Fewer transition gaps observed.',
              outcomeAssessment: 'improved',
              causationCaveat: 'Observed correlation only.',
            },
          ],
          attackingComparison: 'Stable',
          defensiveComparison: 'Improved',
          tacticalVisionComparison: 'Consistent',
          recurringWeaknesses: [],
          limitations: ['Correlation only.'],
          usage: {
            modelId: input.modelId,
            inputTokens: 900,
            outputTokens: 250,
            estimatedCostUsd: 0.001,
            durationMs: 20,
          },
        };
      },
      ...overrides,
    };
  }

  // ============================================================
  // 1–6: RUNTIME VALIDATION, NORMALIZATION & CANONICAL SCHEMAS
  // ============================================================

  test('01: normalizeConfidenceLevel maps case variants, numeric 0-1 scores, percentages, and rejects ambiguous values', () => {
    const check = (raw: unknown, expectedValue: string, expectedNormalized: boolean) => {
      const r = normalizeConfidenceLevel(raw);
      assert.equal(r.ok, true);
      assert.equal(r.value, expectedValue);
      assert.equal(r.normalized, expectedNormalized);
    };

    check('High', 'High', false);
    check('high', 'High', true);
    check('HIGH ', 'High', true);
    check('medium', 'Medium', true);
    check('med', 'Medium', true);
    check('moderate', 'Medium', true);
    check('LOW', 'Low', true);
    check(0.92, 'High', true);
    check(0.62, 'Medium', true);
    check(0.25, 'Low', true);
    check('85%', 'High', true);
    check('55%', 'Medium', true);
    check('20%', 'Low', true);

    assert.equal(normalizeConfidenceLevel('maybe_kinda').ok, false);
    assert.equal(normalizeConfidenceLevel('').ok, false);
    assert.equal(normalizeConfidenceLevel(null).ok, false);
    assert.equal(normalizeConfidenceLevel(150).ok, false);
    assert.equal(normalizeConfidenceLevel(-0.2).ok, false);
  });

  test('02: All 11 other enum normalizers canonicalize safe case/hyphen variants and reject invalid values', () => {
    assert.equal(normalizeVideoContentType('LIVE-GAMEPLAY').value, 'live_gameplay');
    assert.equal(normalizeVideoContentType('live gameplay').value, 'live_gameplay');
    assert.equal(normalizeVideoContentType('completely_unknown_garbage').ok, false);

    assert.equal(normalizeCategoryGroup('Attacking').value, 'attacking');
    assert.equal(normalizeCategoryGroup('match-events').value, 'match_events');
    assert.equal(normalizeCategoryGroup('refereeing').ok, false);

    assert.equal(normalizeTeamAttribution('USER_TEAM').value, 'user_team');
    assert.equal(normalizeTeamAttribution('away_ghost').ok, false);

    assert.equal(normalizeEvidenceType('Directly Observed').value, 'directly_observed');
    assert.equal(normalizeEvidenceType('guessed_from_vibes').ok, false);

    assert.equal(normalizeSeverityLevel('critical').value, 'Critical');
    assert.equal(normalizeSeverityLevel('HIGH').value, 'High');
    assert.equal(normalizeSeverityLevel('extreme_catastrophe').ok, false);

    assert.equal(normalizeEvidenceQuality('MODERATE').value, 'moderate');
    assert.equal(normalizeEvidenceQuality('perfect_100').ok, false);

    assert.equal(normalizeRecommendationStance('Retain and Refine').value, 'retain_and_refine');
    assert.equal(normalizeRecommendationStance('burn_it_down').ok, false);

    assert.equal(normalizePriorityGroup('Immediate Correction').value, 'immediate_correction');
    assert.equal(normalizePriorityGroup('optional_bonus').ok, false);

    assert.equal(normalizeActionType('Defensive-Line-Height').value, 'defensive_line_height');
    assert.equal(normalizeActionType('bribe_referee').ok, false);

    assert.equal(normalizeOutcomeAssessment('Improved').value, 'improved');
    assert.equal(normalizeOutcomeAssessment('miraculous').ok, false);
  });

  test('03: All 4 Gemini structured output schemas declare explicit canonical enum arrays matching SQLite CHECK constraints', () => {
    const s1 = buildStage1ClassificationSchema() as Record<string, unknown>;
    const s1SegProps = ((s1.properties as Record<string, Record<string, unknown>>).segments.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(s1SegProps.contentType.enum, [...CANONICAL_VIDEO_CONTENT_TYPES]);
    assert.deepEqual(s1SegProps.confidence.enum, [...CANONICAL_CONFIDENCE_LEVELS]);

    const s2 = buildStage2ObservationSchema() as Record<string, unknown>;
    const s2ObsProps = ((s2.properties as Record<string, Record<string, unknown>>).observations.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(s2ObsProps.categoryGroup.enum, [...CANONICAL_CATEGORY_GROUPS]);
    assert.deepEqual(s2ObsProps.teamAttribution.enum, [...CANONICAL_TEAM_ATTRIBUTIONS]);
    assert.deepEqual(s2ObsProps.evidenceType.enum, [...CANONICAL_EVIDENCE_TYPES]);
    assert.deepEqual(s2ObsProps.confidence.enum, [...CANONICAL_CONFIDENCE_LEVELS]);
    assert.deepEqual(s2ObsProps.severity.enum, [...CANONICAL_SEVERITY_LEVELS]);

    const s3 = buildStage3SynthesisSchema() as Record<string, unknown>;
    const s3Props = s3.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(s3Props.evidenceQuality.enum, [...CANONICAL_EVIDENCE_QUALITIES]);
    const vaProps = s3Props.visionAssessment.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(vaProps.recommendationStance.enum, [...CANONICAL_RECOMMENDATION_STANCES]);
    assert.deepEqual(vaProps.confidence.enum, [...CANONICAL_CONFIDENCE_LEVELS]);
    const critProps = (vaProps.criteriaBreakdown.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(critProps.assessment.enum, [...CANONICAL_CRITERIA_ASSESSMENTS]);
    const recProps = (s3Props.recommendations.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(recProps.priorityGroup.enum, [...CANONICAL_PRIORITY_GROUPS]);
    assert.deepEqual(recProps.actionType.enum, [...CANONICAL_ACTION_TYPES]);
    assert.deepEqual(recProps.confidence.enum, [...CANONICAL_CONFIDENCE_LEVELS]);

    const s4 = buildStage4ComparisonSchema() as Record<string, unknown>;
    const s4Props = s4.properties as Record<string, Record<string, unknown>>;
    const adjProps = (s4Props.appliedAdjustmentsReviewed.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(adjProps.outcomeAssessment.enum, [...CANONICAL_OUTCOME_ASSESSMENTS]);
  });

  test('04: Windows Gemini 3.5 Flash Quick Mode bug reproduction — non-canonical confidence values normalize cleanly and persist with zero SQLite CHECK failure', async () => {
    updateSettings({
      ai: {
        modelId: 'gemini-2.5-flash',
        usePrimaryModelForAllStages: true,
        autoFailoverEnabled: false,
      },
    });
    const { match } = createFixtureClubAndMatch('BugRepro35Flash');
    const { sessionId, sessionDir } = await createVerifiedSessionWithSegments(match.id, 'first_half', 'bugrepro', 1, 22);

    const dirtyConfidenceProvider = buildMockProvider({
      async classifyVideoSegment(input) {
        return {
          segments: [
            {
              startSeconds: 0,
              endSeconds: 12,
              contentType: 'LIVE-GAMEPLAY' as unknown as 'live_gameplay',
              confidence: 'high' as unknown as 'High',
              evidenceDescription: 'Live gameplay with lowercase confidence',
              inGameClock: '06:00',
            },
            {
              startSeconds: 12,
              endSeconds: 18,
              contentType: 'set piece' as unknown as 'set_piece',
              confidence: 0.62 as unknown as 'Medium',
              evidenceDescription: 'Corner kick with numeric confidence',
              inGameClock: '10:00',
            },
            {
              startSeconds: 18,
              endSeconds: 22,
              contentType: 'replay',
              confidence: '25%' as unknown as 'Low',
              evidenceDescription: 'Replay with percentage confidence',
              inGameClock: null,
            },
          ],
          readableHudStats: {
            scoreline: '1-0',
            matchClock: '14:00',
            possessionLabel: null,
            shotsLabel: null,
            otherVerifiedStats: [],
          },
          usage: {
            modelId: input.modelId,
            inputTokens: 1100,
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
              endSeconds: 5,
              inGameClock: '04:00',
              categoryGroup: 'DEFENSIVE' as unknown as 'defensive',
              category: 'Right channel gap',
              teamAttribution: 'USER_TEAM' as unknown as 'user_team',
              playerAttribution: 'Unknown',
              description: 'Fullback caught forward',
              supportingVisualEvidence: 'Visible open space behind RB',
              evidenceType: 'DIRECTLY_OBSERVED' as unknown as 'directly_observed',
              confidence: 'HIGH' as unknown as 'High',
              severity: 'high' as unknown as 'High',
              limitations: 'Wide camera',
              isFromReplay: false,
            },
          ],
          usage: {
            modelId: input.modelId,
            inputTokens: 1200,
            outputTokens: 350,
            estimatedCostUsd: 0.001,
            durationMs: 25,
          },
        };
      },
    });

    const result = await startAnalysisJob({
      matchId: match.id,
      sessionId,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      provider: dirtyConfidenceProvider,
      allowedMediaDirs: [sessionDir],
      awaitCompletion: true,
    });

    assert.ok(
      result.job.status === 'completed' || result.job.status === 'completed_with_limitations',
      `Job must succeed after canonical normalization (got ${result.job.status}: ${result.job.errorCode} ${result.job.errorMessage})`
    );
    assert.ok(result.job.validationSummary);
    assert.ok(result.job.validationSummary.normalizedFields.length >= 5, 'Should audit all normalized enum fields');
    assert.equal(result.job.validationSummary.databaseErrors.length, 0);

    const bundle = listMatchAnalysisBundle(match.id, 'first_half');
    assert.equal(bundle.classifications.length, 3);
    assert.deepEqual(
      bundle.classifications.map((c) => c.confidence),
      ['High', 'Medium', 'Low']
    );
    assert.deepEqual(
      bundle.classifications.map((c) => c.contentType),
      ['live_gameplay', 'set_piece', 'replay']
    );
    assert.equal(bundle.observations[0].confidence, 'High');
    assert.equal(bundle.observations[0].severity, 'High');
  });

  test('05: Direct stage validators reject unmappable enum values with valid=false and structured AI_RESPONSE_ENUM_INVALID diagnostics', () => {
    const r1 = validateClassificationStageResponse(
      {
        segments: [
          {
            startSeconds: 0,
            endSeconds: 10,
            contentType: 'live_gameplay',
            confidence: 'definitely_maybe',
            evidenceDescription: 'Invalid confidence string',
          },
        ],
      },
      { segmentIndex: 1, segmentDurationSeconds: 10 }
    );
    assert.equal(r1.valid, false);
    assert.equal(r1.rejectedItems.length, 1);
    assert.equal(r1.rejectedItems[0].code, 'AI_RESPONSE_ENUM_INVALID');
    assert.equal(r1.rejectedItems[0].fieldName, 'confidence');

    const r2 = validateObservationStageResponse(
      {
        observations: [
          {
            startSeconds: 1,
            endSeconds: 4,
            categoryGroup: 'defensive',
            category: 'Test',
            teamAttribution: 'user_team',
            description: 'Test',
            supportingVisualEvidence: 'Test',
            evidenceType: 'directly_observed',
            confidence: 'High',
            severity: 'APOCALYPTIC',
          },
        ],
      },
      { segmentIndex: 1, segmentDurationSeconds: 10 }
    );
    assert.equal(r2.valid, false);
    assert.equal(r2.rejectedItems[0].code, 'AI_RESPONSE_ENUM_INVALID');
    assert.equal(r2.rejectedItems[0].fieldName, 'severity');

    const r3 = validateSynthesisStageResponse({ evidenceQuality: 'super_ultra' });
    assert.equal(r3.valid, false);
    assert.ok(r3.blockingError !== null || r3.rejectedItems.length > 0);

    const r4 = validateComparisonStageResponse({
      summary: 'x',
      appliedAdjustmentsReviewed: [
        {
          recommendationTitle: 'a',
          userConfirmedAppliedInGame: true,
          observedSecondHalfPattern: 'b',
          outcomeAssessment: 'teleported',
          causationCaveat: 'c',
        },
      ],
      attackingComparison: 'a',
      defensiveComparison: 'b',
      tacticalVisionComparison: 'c',
    });
    assert.equal(r4.data?.appliedAdjustmentsReviewed[0].outcomeAssessment, 'insufficient_evidence');
    assert.ok(r4.warnings.length >= 1, 'Unrecognized Stage 4 outcomeAssessment must downgrade to insufficient_evidence with warning');
    assert.equal(validateComparisonStageResponse(null).valid, false);
  });

  test('06: Bounded 1-pass JSON repair succeeds when repair returns valid canonical JSON, and fails cleanly with AI_RESPONSE_REPAIR_FAILED when repair also fails', async () => {
    const { match: matchOk } = createFixtureClubAndMatch('RepairPass');
    const { sessionId: sidOk, sessionDir: dirOk } = await createVerifiedSessionWithSegments(
      matchOk.id,
      'first_half',
      'reppass',
      1,
      20
    );

    let repairCallsPass = 0;
    const repairableProvider = buildMockProvider({
      async classifyVideoSegment(input) {
        return {
          segments: [
            {
              startSeconds: 0,
              endSeconds: 20,
              contentType: 'live_gameplay',
              confidence: 'totally_unmappable_enum' as unknown as 'High',
              evidenceDescription: 'Needs repair',
              inGameClock: '08:00',
            },
          ],
          readableHudStats: {
            scoreline: '0-0',
            matchClock: '08:00',
            possessionLabel: null,
            shotsLabel: null,
            otherVerifiedStats: [],
          },
          usage: {
            modelId: input.modelId,
            inputTokens: 900,
            outputTokens: 200,
            estimatedCostUsd: 0.001,
            durationMs: 20,
          },
        };
      },
      async repairStageJsonResponse(input) {
        repairCallsPass++;
        return {
          repairedPayload: {
            segments: [
              {
                startSeconds: 0,
                endSeconds: 20,
                contentType: 'live_gameplay',
                confidence: 'High',
                evidenceDescription: 'Repaired canonical confidence',
                inGameClock: '08:00',
              },
            ],
            readableHudStats: {
              scoreline: '0-0',
              matchClock: '08:00',
              possessionLabel: null,
              shotsLabel: null,
              otherVerifiedStats: [],
            },
          },
          usage: {
            modelId: input.modelId,
            inputTokens: 200,
            outputTokens: 150,
            estimatedCostUsd: 0.0002,
            durationMs: 12,
          },
        };
      },
    });

    const passRes = await startAnalysisJob({
      matchId: matchOk.id,
      sessionId: sidOk,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      provider: repairableProvider,
      allowedMediaDirs: [dirOk],
      awaitCompletion: true,
    });
    assert.equal(repairCallsPass, 1, 'Repair must execute strictly once');
    assert.ok(passRes.job.status === 'completed' || passRes.job.status === 'completed_with_limitations');
    assert.equal(passRes.job.validationSummary?.repairedAttemptsCount, 1);

    // Now test failing repair (must stop after 1 repair attempt, zero partial DB rows)
    const { match: matchFail } = createFixtureClubAndMatch('RepairFail');
    const { sessionId: sidFail, sessionDir: dirFail } = await createVerifiedSessionWithSegments(
      matchFail.id,
      'first_half',
      'repfail',
      1,
      12
    );
    let repairCallsFail = 0;
    const unrepairableProvider = buildMockProvider({
      async classifyVideoSegment(input) {
        return {
          segments: [
            {
              startSeconds: 0,
              endSeconds: 12,
              contentType: 'live_gameplay',
              confidence: 'garbage_value_1' as unknown as 'High',
              evidenceDescription: 'Bad',
              inGameClock: null,
            },
          ],
          readableHudStats: {
            scoreline: null,
            matchClock: null,
            possessionLabel: null,
            shotsLabel: null,
            otherVerifiedStats: [],
          },
          usage: {
            modelId: input.modelId,
            inputTokens: 900,
            outputTokens: 200,
            estimatedCostUsd: 0.001,
            durationMs: 20,
          },
        };
      },
      async repairStageJsonResponse(input) {
        repairCallsFail++;
        return {
          repairedPayload: {
            segments: [
              {
                startSeconds: 0,
                endSeconds: 12,
                contentType: 'live_gameplay',
                confidence: 'still_garbage_2',
                evidenceDescription: 'Still bad',
              },
            ],
          },
          usage: {
            modelId: input.modelId,
            inputTokens: 200,
            outputTokens: 150,
            estimatedCostUsd: 0.0002,
            durationMs: 12,
          },
        };
      },
    });

    const failRes = await startAnalysisJob({
      matchId: matchFail.id,
      sessionId: sidFail,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      provider: unrepairableProvider,
      allowedMediaDirs: [dirFail],
      awaitCompletion: true,
    });
    assert.equal(repairCallsFail, 1, 'Repair must be bounded to 1 attempt');
    assert.equal(failRes.job.status, 'failed');
    assert.equal(failRes.job.errorCode, 'AI_RESPONSE_REPAIR_FAILED');
    assert.equal(failRes.job.diagnostics?.errorDomain, 'ai_validation');
    assert.equal(failRes.job.diagnostics?.retryable, false);

    const failedRows = getDb()
      .prepare('SELECT COUNT(*) as c FROM ai_video_classifications WHERE job_id = ?')
      .get(failRes.job.id) as { c: number };
    assert.equal(failedRows.c, 0, 'Zero partial classification rows may be inserted on validation failure');
  });

  // ============================================================
  // 7–9: SQLITE ERROR DOMAIN SEPARATION & ATOMIC TRANSACTIONS
  // ============================================================

  test('07: Real SQLite CHECK constraint violation is classified as DATABASE_CONSTRAINT_VIOLATION (errorDomain=database, retryable=false) — NEVER upstream Gemini', () => {
    const db = getDb();
    const { match } = createFixtureClubAndMatch('SqliteCheck');
    const jobId = `job-chk-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO ai_analysis_jobs (
        id, match_id, half, status, analysis_mode, language,
        model_video_id, model_synthesis_id, prompt_version, schema_version, created_at, updated_at
      ) VALUES (?, ?, 'first_half', 'classifying_gameplay', 'quick', 'en', 'gemini-2.5-flash', 'gemini-2.5-flash', 'v3.0.3', 'v3.0.3', ?, ?)`
    ).run(jobId, match.id, now, now);

    let caughtErr: unknown = null;
    try {
      db.prepare(
        `INSERT INTO ai_video_classifications (
          id, job_id, match_id, segment_id, start_seconds, end_seconds,
          session_start_seconds, session_end_seconds, content_type, confidence,
          evidence_description, in_game_clock, created_at
        ) VALUES ('chk-test-row', ?, ?, NULL, 0, 5, 0, 5, 'live_gameplay', 'lowercase_high', 'test', NULL, ?)`
      ).run(jobId, match.id, now);
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'SQLite CHECK constraint must remain enforced in database schema');
    const classified = classifyGeminiError(caughtErr, {
      stage: 'classifying_gameplay',
      modelId: 'gemini-2.5-flash',
    });
    assert.equal(classified.code, 'DATABASE_CONSTRAINT_VIOLATION');
    assert.equal(classified.errorDomain, 'database');
    assert.equal(classified.retryable, false);
    assert.ok(classified.diagnostic.sqliteCode?.startsWith('SQLITE_CONSTRAINT'));
    assert.notEqual(classified.code, 'UPSTREAM_SERVICE_UNAVAILABLE');
  });

  test('08: Database errors NEVER penalize gemini_model_health and are NOT failover-eligible', () => {
    resetModelHealth('gemini-health-db-check');
    assert.equal(isFailoverEligibleErrorCode('DATABASE_CONSTRAINT_VIOLATION'), false);
    assert.equal(isFailoverEligibleErrorCode('DATABASE_PERSISTENCE_FAILED'), false);
    assert.equal(isFailoverEligibleErrorCode('ANALYSIS_CANCELLED'), false);

    const record = recordModelFailure({
      modelId: 'gemini-health-db-check',
      capability: 'video',
      stage: 'classifying_gameplay',
      errorCode: 'DATABASE_CONSTRAINT_VIOLATION',
      errorMessage: 'CHECK constraint failed: confidence IN (High, Medium, Low)',
    });
    assert.equal(record.status, 'healthy');
    assert.equal(record.consecutiveFailures, 0);

    const persisted = getModelHealth('gemini-health-db-check');
    assert.equal(persisted.length, 0, 'Local DB error must not create failure row in gemini_model_health');
  });

  test('09: Atomic SQLite transaction rolls back completely when an error occurs mid-stage write (0 partial rows)', () => {
    const db = getDb();
    const { match } = createFixtureClubAndMatch('TxRollback');
    const jobId = `job-tx-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO ai_analysis_jobs (
        id, match_id, half, status, analysis_mode, language,
        model_video_id, model_synthesis_id, prompt_version, schema_version, created_at, updated_at
      ) VALUES (?, ?, 'first_half', 'classifying_gameplay', 'quick', 'en', 'gemini-2.5-flash', 'gemini-2.5-flash', 'v3.0.3', 'v3.0.3', ?, ?)`
    ).run(jobId, match.id, now, now);

    const atomicWrite = db.transaction(() => {
      db.prepare(
        `INSERT INTO ai_video_classifications (
          id, job_id, match_id, segment_id, start_seconds, end_seconds,
          session_start_seconds, session_end_seconds, content_type, confidence,
          evidence_description, in_game_clock, created_at
        ) VALUES ('tx-row-1', ?, ?, NULL, 0, 5, 0, 5, 'live_gameplay', 'High', 'valid row', NULL, ?)`
      ).run(jobId, match.id, now);

      // Second row violates CHECK constraint -> entire transaction must roll back
      db.prepare(
        `INSERT INTO ai_video_classifications (
          id, job_id, match_id, segment_id, start_seconds, end_seconds,
          session_start_seconds, session_end_seconds, content_type, confidence,
          evidence_description, in_game_clock, created_at
        ) VALUES ('tx-row-2', ?, ?, NULL, 5, 10, 5, 10, 'live_gameplay', 'INVALID_ENUM', 'bad row', NULL, ?)`
      ).run(jobId, match.id, now);
    });

    assert.throws(() => atomicWrite());

    const countRow = db
      .prepare('SELECT COUNT(*) as c FROM ai_video_classifications WHERE job_id = ?')
      .get(jobId) as { c: number };
    assert.equal(countRow.c, 0, 'Atomic rollback must leave zero partial rows');
  });

  // ============================================================
  // 10–11: 4 SEPARATE CAPABILITY PROBES & REMOTE CLEANUP
  // ============================================================

  test('10: 4 independent capability probes (text_json, image, inline_video, files_api_video) verify & preserve flags independently', async () => {
    clearGeminiDiscoveryAndCapabilityCaches();
    const probeEvents: string[] = [];
    let uploadedName = '';
    let deletedName = '';

    const mockClient: GeminiDiscoveryClientLike = {
      models: {
        async list() {
          async function* gen() {}
          return gen();
        },
        async generateContent(args) {
          const raw = JSON.stringify(args.contents);
          if (raw.includes('image/png') || raw.includes('image/jpeg')) {
            probeEvents.push('image');
          } else if (raw.includes('fileUri') || raw.includes('https://generativelanguage.googleapis.com')) {
            probeEvents.push('files_api_video');
          } else if (raw.includes('video/mp4')) {
            probeEvents.push('inline_video');
          } else {
            probeEvents.push('text_json');
          }
          return { text: JSON.stringify({ ok: true, note: 'probe_ok' }) };
        },
      },
      files: {
        async upload(params) {
          assert.ok(fs.existsSync(params.file), 'Files API probe must upload a real synthesized MP4 file');
          uploadedName = 'files/probe-test-video-001';
          return {
            name: uploadedName,
            uri: `https://generativelanguage.googleapis.com/v1beta/${uploadedName}`,
            state: 'PROCESSING',
          };
        },
        async get(params) {
          return {
            name: params.name,
            uri: `https://generativelanguage.googleapis.com/v1beta/${params.name}`,
            state: 'ACTIVE',
          };
        },
        async delete(params) {
          deletedName = params.name;
          return {};
        },
      },
    };

    const modelId = 'gemini-2.5-flash';

    const p1 = await verifyModelCapabilities({
      modelId,
      probeType: 'text_json',
      forceRefresh: true,
      clientOverride: mockClient,
    });
    assert.equal(p1.ok, true);
    assert.equal(p1.probeType, 'text_json');
    assert.equal(p1.textVerified, true);
    assert.equal(p1.imageVerified, false);
    assert.equal(p1.inlineVideoVerified, false);
    assert.equal(p1.filesApiVideoVerified, false);

    const p2 = await verifyModelCapabilities({
      modelId,
      probeType: 'image',
      forceRefresh: true,
      clientOverride: mockClient,
    });
    assert.equal(p2.ok, true);
    assert.equal(p2.probeType, 'image');
    assert.equal(p2.textVerified, true, 'Prior text probe verification must be preserved');
    assert.equal(p2.imageVerified, true);
    assert.equal(p2.inlineVideoVerified, false);
    assert.equal(p2.filesApiVideoVerified, false);

    const p3 = await verifyModelCapabilities({
      modelId,
      probeType: 'inline_video',
      forceRefresh: true,
      clientOverride: mockClient,
    });
    assert.equal(p3.ok, true);
    assert.equal(p3.probeType, 'inline_video');
    assert.equal(p3.textVerified, true);
    assert.equal(p3.imageVerified, true);
    assert.equal(p3.inlineVideoVerified, true);
    assert.equal(p3.filesApiVideoVerified, false);

    const p4 = await verifyModelCapabilities({
      modelId,
      probeType: 'files_api_video',
      forceRefresh: true,
      clientOverride: mockClient,
    });
    assert.equal(p4.ok, true);
    assert.equal(p4.probeType, 'files_api_video');
    assert.equal(p4.textVerified, true);
    assert.equal(p4.imageVerified, true);
    assert.equal(p4.inlineVideoVerified, true);
    assert.equal(p4.filesApiVideoVerified, true);
    assert.equal(p4.remoteCleanupConfirmed, true);
    assert.equal(deletedName, uploadedName, 'Files API video probe must delete temporary uploaded file');
    assert.deepEqual(probeEvents, ['text_json', 'image', 'inline_video', 'files_api_video']);
  });

  test('11: Files API video probe cleans up remote file even when inference throws an error', async () => {
    let deletedAfterError = false;
    const failingInferenceClient: GeminiDiscoveryClientLike = {
      models: {
        async list() {
          async function* gen() {}
          return gen();
        },
        async generateContent() {
          throw Object.assign(new Error('503 Service Unavailable'), { status: 503 });
        },
      },
      files: {
        async upload() {
          return {
            name: 'files/probe-cleanup-on-err',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/probe-cleanup-on-err',
            state: 'ACTIVE',
          };
        },
        async get(params) {
          return {
            name: params.name,
            uri: `https://generativelanguage.googleapis.com/v1beta/${params.name}`,
            state: 'ACTIVE',
          };
        },
        async delete(params) {
          if (params.name === 'files/probe-cleanup-on-err') deletedAfterError = true;
          return {};
        },
      },
    };

    const res = await verifyModelCapabilities({
      modelId: 'gemini-3.1-flash-lite',
      probeType: 'files_api_video',
      forceRefresh: true,
      clientOverride: failingInferenceClient,
    });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'UPSTREAM_SERVICE_UNAVAILABLE');
    assert.equal(deletedAfterError, true, 'Remote probe file must be deleted in finally even on inference failure');
  });

  // ============================================================
  // 12–14: MODEL HEALTH, ADAPTIVE FAILOVER & COST GUARDRAIL
  // ============================================================

  test('12: Model health transitions healthy -> degraded -> cooldown -> unsupported and resets cleanly', () => {
    const model = 'gemini-health-lifecycle';
    resetModelHealth(model);

    const f1 = recordModelFailure({
      modelId: model,
      capability: 'video',
      stage: 'classifying_gameplay',
      errorCode: 'UPSTREAM_SERVICE_UNAVAILABLE',
      errorMessage: '503 overloaded',
    });
    assert.equal(f1.status, 'degraded');
    assert.equal(f1.consecutiveFailures, 1);
    assert.equal(isModelUnavailableByHealth(model, 'video', 'classifying_gameplay').unavailable, false);

    const f2 = recordModelFailure({
      modelId: model,
      capability: 'video',
      stage: 'classifying_gameplay',
      errorCode: 'UPSTREAM_SERVICE_UNAVAILABLE',
      errorMessage: '503 overloaded again',
    });
    assert.equal(f2.status, 'cooldown');
    assert.equal(f2.consecutiveFailures, 2);
    assert.ok(f2.cooldownUntil);
    assert.equal(isModelUnavailableByHealth(model, 'video', 'classifying_gameplay').unavailable, true);

    const recovered = recordModelSuccess({
      modelId: model,
      capability: 'video',
      stage: 'classifying_gameplay',
    });
    assert.equal(recovered.status, 'healthy');
    assert.equal(recovered.consecutiveFailures, 0);
    assert.equal(isModelUnavailableByHealth(model, 'video', 'classifying_gameplay').unavailable, false);

    const unsup = recordModelFailure({
      modelId: model,
      capability: 'video',
      stage: 'classifying_gameplay',
      errorCode: 'MODEL_NOT_FOUND',
      errorMessage: '404 model not found',
    });
    assert.equal(unsup.status, 'unsupported');
    assert.equal(isModelUnavailableByHealth(model, 'video', 'classifying_gameplay').unavailable, true);

    const cleared = resetModelHealth(model);
    assert.ok(cleared >= 1);
    assert.equal(getModelHealth(model).length, 0);
  });

  test('13: selectFailoverCandidate enforces allowHigherCostFailover guardrail and skips models in cooldown', () => {
    resetModelHealth();
    const discovered: GeminiModelCapability[] = [
      {
        modelId: 'gemini-3.1-flash-lite',
        displayName: 'Gemini 3.1 Flash-Lite',
        availability: 'available_default',
        supportsVideoInput: true,
        supportsStructuredOutput: true,
        recommendedStages: ['classification', 'quick'],
        estimatedInputPricePer1MTokensUsd: 0.1,
        estimatedOutputPricePer1MTokensUsd: 0.4,
        pricingVerified: false,
        pricingNote: 'Indicative test rate',
        description: 'Fast flash-lite model',
        accessStatus: 'verified',
      },
      {
        modelId: 'gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        availability: 'available_optional',
        supportsVideoInput: true,
        supportsStructuredOutput: true,
        recommendedStages: ['deep', 'synthesis'],
        estimatedInputPricePer1MTokensUsd: 1.25,
        estimatedOutputPricePer1MTokensUsd: 10.0,
        pricingVerified: false,
        pricingNote: 'Indicative test rate',
        description: 'Higher-cost pro model',
        accessStatus: 'verified',
      },
      {
        modelId: 'gemini-2.5-flash-lite',
        displayName: 'Gemini 2.5 Flash-Lite',
        availability: 'available_optional',
        supportsVideoInput: true,
        supportsStructuredOutput: true,
        recommendedStages: ['classification', 'quick'],
        estimatedInputPricePer1MTokensUsd: 0.1,
        estimatedOutputPricePer1MTokensUsd: 0.4,
        pricingVerified: false,
        pricingNote: 'Indicative test rate',
        description: 'Comparable-cost flash-lite fallback',
        accessStatus: 'verified',
      },
    ];

    const baseSettings = getSettings().ai;

    const d1 = selectFailoverCandidate({
      failedModelId: 'gemini-3.1-flash-lite',
      triedModelIds: new Set(['gemini-3.1-flash-lite']),
      stage: 'classifying_gameplay',
      capability: 'video',
      errorCode: 'UPSTREAM_SERVICE_UNAVAILABLE',
      aiSettings: {
        ...baseSettings,
        autoFailoverEnabled: true,
        fallbackModelChain: ['gemini-2.5-pro', 'gemini-2.5-flash-lite'],
        allowHigherCostFailover: false,
      },
      discoveredModels: discovered,
    });
    assert.equal(d1.selectedModelId, 'gemini-2.5-flash-lite');
    assert.ok(
      d1.skippedCandidates.some((s) => s.modelId === 'gemini-2.5-pro' && s.reason.includes('allowHigherCostFailover'))
    );

    const d2 = selectFailoverCandidate({
      failedModelId: 'gemini-3.1-flash-lite',
      triedModelIds: new Set(['gemini-3.1-flash-lite']),
      stage: 'classifying_gameplay',
      capability: 'video',
      errorCode: 'UPSTREAM_SERVICE_UNAVAILABLE',
      aiSettings: {
        ...baseSettings,
        autoFailoverEnabled: true,
        fallbackModelChain: ['gemini-2.5-pro', 'gemini-2.5-flash-lite'],
        allowHigherCostFailover: true,
      },
      discoveredModels: discovered,
    });
    assert.equal(d2.selectedModelId, 'gemini-2.5-pro');
    assert.equal(d2.costDeltaAuthorized, true);
  });

  test('14: Orchestrator performs adaptive model failover on stage 503 WITHOUT re-uploading remote video URI', async () => {
    resetModelHealth();
    updateSettings({
      ai: {
        modelId: 'gemini-3.1-flash-lite',
        usePrimaryModelForAllStages: true,
        autoFailoverEnabled: true,
        fallbackModelChain: ['gemini-2.5-flash-lite'],
        allowHigherCostFailover: false,
        maxRetryAttempts: 0,
      },
    });

    const { match } = createFixtureClubAndMatch('AdaptiveFailover');
    const { sessionId, sessionDir } = await createVerifiedSessionWithSegments(match.id, 'first_half', 'failover', 1, 20);

    let uploadCalls = 0;
    const seenStage1Models: string[] = [];

    const failoverProvider = buildMockProvider({
      async uploadAndAwaitActive(input) {
        uploadCalls++;
        const remoteName = `files/reused-uri-${uploadCalls}`;
        const remoteUri = `https://generativelanguage.googleapis.com/v1beta/${remoteName}`;
        input.onRemoteFileUploaded?.({
          remoteFileName: remoteName,
          remoteFileUri: remoteUri,
          remoteState: 'PROCESSING',
        });
        return {
          remoteFileName: remoteName,
          remoteFileUri: remoteUri,
          remoteState: 'ACTIVE',
          uploadMs: 10,
          mediaProcessingMs: 5,
        };
      },
      async classifyVideoSegment(input) {
        seenStage1Models.push(input.modelId);
        if (input.modelId === 'gemini-3.1-flash-lite') {
          throw new GeminiStageError({
            code: 'UPSTREAM_SERVICE_UNAVAILABLE',
            userMessage: '503 overloaded on primary model',
            retryable: true,
            diagnostic: {
              code: 'UPSTREAM_SERVICE_UNAVAILABLE',
              errorDomain: 'gemini_api',
              httpStatus: 503,
              apiStatus: 'UNAVAILABLE',
              upstreamMessage: '503 Service Unavailable',
              stage: 'classifying_gameplay',
              modelId: input.modelId,
              segmentIndex: 1,
              attemptNumber: 1,
              elapsedMs: 50,
              retryable: true,
              retryAfterMs: null,
              occurredAt: new Date().toISOString(),
            },
          });
        }
        return buildMockProvider().classifyVideoSegment(input);
      },
    });

    const res = await startAnalysisJob({
      matchId: match.id,
      sessionId,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      provider: failoverProvider,
      allowedMediaDirs: [sessionDir],
      awaitCompletion: true,
    });

    assert.ok(
      res.job.status === 'completed' || res.job.status === 'completed_with_limitations',
      `Expected completed/completed_with_limitations, got ${res.job.status}: ${res.job.errorMessage}`
    );
    assert.equal(uploadCalls, 1, 'Adaptive failover MUST reuse already-uploaded remote video URI without re-uploading');
    assert.deepEqual(seenStage1Models, ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
    assert.ok(res.job.fallbackHistory && res.job.fallbackHistory.length >= 1);
    assert.equal(res.job.fallbackHistory[0].fromModelId, 'gemini-3.1-flash-lite');
    assert.equal(res.job.fallbackHistory[0].toModelId, 'gemini-2.5-flash-lite');
    assert.equal(res.job.fallbackHistory[0].reusedRemoteMedia, true);
  });

  // ============================================================
  // 15–16: STAGE CHECKPOINTS, OPT-IN RESUME & INVALIDATION
  // ============================================================

  test('15: Multi-segment failure saves Segment 1 checkpoints; opt-in resume skips Segment 1 upload & inference', async () => {
    resetModelHealth();
    updateSettings({
      ai: {
        modelId: 'gemini-2.5-flash',
        usePrimaryModelForAllStages: true,
        autoFailoverEnabled: false,
        allowSequentialFrameFallback: false,
        maxRetryAttempts: 0,
      },
    });

    const { match } = createFixtureClubAndMatch('CheckpointResume');
    const { sessionId, sessionDir } = await createVerifiedSessionWithSegments(
      match.id,
      'first_half',
      'ckpt',
      2,
      12
    );

    let run1Uploads = 0;
    const failSeg2Provider = buildMockProvider({
      async uploadAndAwaitActive(input) {
        run1Uploads++;
        return buildMockProvider().uploadAndAwaitActive(input);
      },
      async classifyVideoSegment(input) {
        if (input.segmentIndex === 2) {
          throw new GeminiStageError({
            code: 'INFERENCE_TIMEOUT',
            userMessage: 'Segment 2 timed out',
            retryable: false,
            diagnostic: {
              code: 'INFERENCE_TIMEOUT',
              errorDomain: 'gemini_api',
              httpStatus: null,
              apiStatus: 'DEADLINE_EXCEEDED',
              upstreamMessage: 'Deadline exceeded on seg 2',
              stage: 'classifying_gameplay',
              modelId: input.modelId,
              segmentIndex: 2,
              attemptNumber: 1,
              elapsedMs: 50,
              retryable: false,
              retryAfterMs: null,
              occurredAt: new Date().toISOString(),
            },
          });
        }
        return buildMockProvider().classifyVideoSegment(input);
      },
    });

    const run1 = await startAnalysisJob({
      matchId: match.id,
      sessionId,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      provider: failSeg2Provider,
      allowedMediaDirs: [sessionDir],
      awaitCompletion: true,
    });
    assert.equal(run1.job.status, 'failed');
    assert.equal(run1Uploads, 2);

    const summary = getResumableCheckpointsForMatchHalf(match.id, 'first_half', {
      sessionId,
      analysisMode: 'quick',
    });
    assert.equal(summary.canResume, true);
    assert.equal(summary.sourceJobId, run1.job.id);
    assert.deepEqual(summary.completedSegmentIndices, [1]);

    let run2Uploads = 0;
    const run2ClassifiedSegments: number[] = [];
    const resumeProvider = buildMockProvider({
      async uploadAndAwaitActive(input) {
        run2Uploads++;
        return buildMockProvider().uploadAndAwaitActive(input);
      },
      async classifyVideoSegment(input) {
        if (typeof input.segmentIndex === 'number') {
          run2ClassifiedSegments.push(input.segmentIndex);
        }
        return buildMockProvider().classifyVideoSegment(input);
      },
    });

    const run2 = await startAnalysisJob({
      matchId: match.id,
      sessionId,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      resumeFromCheckpoint: true,
      provider: resumeProvider,
      allowedMediaDirs: [sessionDir],
      awaitCompletion: true,
    });

    assert.ok(run2.job.status === 'completed' || run2.job.status === 'completed_with_limitations');
    assert.equal(run2.job.checkpointResumedFromJobId, run1.job.id);
    assert.equal(run2Uploads, 1, 'Resumed run must only upload Segment 2, skipping checkpointed Segment 1');
    assert.deepEqual(run2ClassifiedSegments, [2]);

    const bundle = listMatchAnalysisBundle(match.id, 'first_half');
    assert.equal(bundle.classifications.length, 2, 'Both Segment 1 (hydrated) and Segment 2 (fresh) classifications must exist');
    assert.equal(bundle.observations.length, 2, 'Both Segment 1 (hydrated) and Segment 2 (fresh) observations must exist');
  });

  test('16: Without explicit resumeFromCheckpoint=true, orchestrator NEVER auto-resumes; invalidating checkpoints clears resume summary', async () => {
    const { match } = createFixtureClubAndMatch('NoAutoResume');
    const { sessionId, sessionDir } = await createVerifiedSessionWithSegments(
      match.id,
      'first_half',
      'noauto',
      2,
      12
    );

    const failSeg2 = buildMockProvider({
      async classifyVideoSegment(input) {
        if (input.segmentIndex === 2) {
          throw new GeminiStageError({
            code: 'UPSTREAM_SERVICE_UNAVAILABLE',
            userMessage: 'Seg 2 failed',
            retryable: false,
            diagnostic: {
              code: 'UPSTREAM_SERVICE_UNAVAILABLE',
              errorDomain: 'gemini_api',
              httpStatus: 503,
              apiStatus: 'UNAVAILABLE',
              upstreamMessage: '503',
              stage: 'classifying_gameplay',
              modelId: input.modelId,
              segmentIndex: 2,
              attemptNumber: 1,
              elapsedMs: 50,
              retryable: false,
              retryAfterMs: null,
              occurredAt: new Date().toISOString(),
            },
          });
        }
        return buildMockProvider().classifyVideoSegment(input);
      },
    });

    await startAnalysisJob({
      matchId: match.id,
      sessionId,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      provider: failSeg2,
      allowedMediaDirs: [sessionDir],
      awaitCompletion: true,
    });

    assert.equal(
      getResumableCheckpointsForMatchHalf(match.id, 'first_half', { sessionId, analysisMode: 'quick' }).canResume,
      true
    );

    const invalidated = invalidateCheckpointsForMatchHalf(match.id, 'first_half');
    assert.ok(invalidated >= 1);
    assert.equal(
      getResumableCheckpointsForMatchHalf(match.id, 'first_half', { sessionId, analysisMode: 'quick' }).canResume,
      false
    );

    // Re-create failed run with checkpoints, then start WITHOUT resumeFromCheckpoint -> must upload BOTH segments
    await startAnalysisJob({
      matchId: match.id,
      sessionId,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      forceReanalyze: true,
      provider: failSeg2,
      allowedMediaDirs: [sessionDir],
      awaitCompletion: true,
    });

    let freshUploads = 0;
    const freshRun = await startAnalysisJob({
      matchId: match.id,
      sessionId,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      resumeFromCheckpoint: false,
      provider: buildMockProvider({
        async uploadAndAwaitActive(input) {
          freshUploads++;
          return buildMockProvider().uploadAndAwaitActive(input);
        },
      }),
      allowedMediaDirs: [sessionDir],
      awaitCompletion: true,
    });
    assert.ok(freshRun.job.status === 'completed' || freshRun.job.status === 'completed_with_limitations');
    assert.equal(freshRun.job.checkpointResumedFromJobId, null);
    assert.equal(freshUploads, 2, 'Must NOT auto-resume without explicit user opt-in');
  });

  // ============================================================
  // 17–18: SEQUENTIAL KEYFRAME FALLBACK & MEDIA PRESERVATION
  // ============================================================

  test('17: extractSequentialFallbackFrames extracts bounded local JPEG keyframes without modifying original MP4', async () => {
    const outDir = path.join(tempRecordingsRoot, 'frame-extract-test');
    const mp4Path = path.join(outDir, 'sample.mp4');
    await generateTestMp4(mp4Path, { width: 640, height: 360, fps: 15, durationSec: 12 });
    const origHash = crypto.createHash('sha256').update(fs.readFileSync(mp4Path)).digest('hex');

    const extracted = await extractSequentialFallbackFrames({
      jobId: 'job-frame-unit',
      videoFilePath: mp4Path,
      segmentIndex: 1,
      durationSeconds: 12,
      intervalSeconds: 4,
      maxFrames: 6,
      allowedBaseDirs: [outDir],
    });

    assert.ok(extracted.frames.length >= 2 && extracted.frames.length <= 6);
    for (const f of extracted.frames) {
      assert.ok(fs.existsSync(f.filePath), 'Extracted frame JPEG must exist on disk');
      assert.equal(f.mimeType, 'image/jpeg');
      assert.ok(f.sizeBytes > 100);
    }

    const afterHash = crypto.createHash('sha256').update(fs.readFileSync(mp4Path)).digest('hex');
    assert.equal(afterHash, origHash, 'Original MP4 recording must remain completely unmodified');
  });

  test('18: Opt-in Sequential Frame Fallback triggers on native VIDEO_PROCESSING_FAILED, completes with completed_with_limitations, discloses limitation, cleans temp frames, preserves original MP4', async () => {
    resetModelHealth();
    updateSettings({
      ai: {
        modelId: 'gemini-2.5-flash',
        usePrimaryModelForAllStages: true,
        autoFailoverEnabled: false,
        allowSequentialFrameFallback: true,
        frameFallbackIntervalSeconds: 4,
        maxFallbackFramesPerSegment: 8,
        maxRetryAttempts: 0,
      },
    });

    const { match } = createFixtureClubAndMatch('FrameFallback');
    const { sessionId, sessionDir, segPaths } = await createVerifiedSessionWithSegments(
      match.id,
      'first_half',
      'framefb',
      1,
      20
    );
    const origSha = crypto.createHash('sha256').update(fs.readFileSync(segPaths[0])).digest('hex');

    let frameClassifyCalled = 0;
    let frameObserveCalled = 0;

    const frameFallbackProvider = buildMockProvider({
      async uploadAndAwaitActive() {
        throw new GeminiStageError({
          code: 'VIDEO_PROCESSING_FAILED',
          userMessage: 'Native video processing failed on Files API',
          retryable: false,
          diagnostic: {
            code: 'VIDEO_PROCESSING_FAILED',
            errorDomain: 'gemini_api',
            httpStatus: 400,
            apiStatus: 'FAILED_PRECONDITION',
            upstreamMessage: 'File processing state FAILED',
            stage: 'waiting_for_media_processing',
            modelId: 'gemini-2.5-flash',
            segmentIndex: 1,
            attemptNumber: 1,
            elapsedMs: 50,
            retryable: false,
            retryAfterMs: null,
            occurredAt: new Date().toISOString(),
          },
        });
      },
      async classifySequentialFrames(input) {
        frameClassifyCalled++;
        assert.ok(input.frames.length >= 2, 'Must pass real extracted JPEG frames');
        return {
          segments: [
            {
              startSeconds: 0,
              endSeconds: input.segmentDurationSeconds,
              contentType: 'live_gameplay',
              confidence: 'Medium',
              evidenceDescription: 'Sequential keyframes show live broadcast pitch play',
              inGameClock: '11:00',
            },
          ],
          readableHudStats: {
            scoreline: '0-0',
            matchClock: '11:00',
            possessionLabel: null,
            shotsLabel: null,
            otherVerifiedStats: [],
          },
          usage: {
            modelId: input.modelId,
            inputTokens: 800,
            outputTokens: 200,
            estimatedCostUsd: 0.0008,
            durationMs: 20,
          },
        };
      },
      async extractObservationsFromFrames(input) {
        frameObserveCalled++;
        assert.ok(input.frames.length >= 2);
        return {
          observations: [
            {
              startSeconds: 0,
              endSeconds: 8,
              inGameClock: '11:00',
              categoryGroup: 'defensive',
              category: 'High backline spacing',
              teamAttribution: 'user_team',
              playerAttribution: 'Unknown',
              description: 'Back four positioned near halfway line on keyframe sequence.',
              supportingVisualEvidence: 'Visible high defensive block across keyframes.',
              evidenceType: 'directly_observed',
              confidence: 'Medium',
              severity: 'Medium',
              limitations: 'Keyframe sampling reduces fluid transition motion visibility.',
              isFromReplay: false,
            },
          ],
          usage: {
            modelId: input.modelId,
            inputTokens: 900,
            outputTokens: 300,
            estimatedCostUsd: 0.001,
            durationMs: 25,
          },
        };
      },
    });

    const res = await startAnalysisJob({
      matchId: match.id,
      sessionId,
      half: 'first_half',
      analysisMode: 'quick',
      privacyAuthorized: true,
      provider: frameFallbackProvider,
      allowedMediaDirs: [sessionDir],
      awaitCompletion: true,
    });

    assert.equal(frameClassifyCalled, 1);
    assert.equal(frameObserveCalled, 1);
    assert.equal(res.job.analysisStrategy, 'sequential_frames');
    assert.equal(res.job.status, 'completed_with_limitations');

    const bundle = listMatchAnalysisBundle(match.id, 'first_half');
    assert.ok(bundle.briefing);
    assert.ok(
      bundle.briefing.limitations.some((l) => l.toLowerCase().includes('keyframe') || l.toLowerCase().includes('frame')),
      'Briefing limitations must honestly disclose sequential keyframe fallback'
    );

    const afterSha = crypto.createHash('sha256').update(fs.readFileSync(segPaths[0])).digest('hex');
    assert.equal(afterSha, origSha);

    const tempJobDir = path.join(tempRoot, 'analysis_temp', res.job.id);
    assert.equal(fs.existsSync(tempJobDir), false, 'Temp extracted keyframes directory must be removed after job finishes');
  });

  // ============================================================
  // 19–21: MIGRATION v8 -> v9, SETTINGS PERSISTENCE & BACKUP v9
  // ============================================================

  test('19: Phase 3.0.3 AI settings persist cleanly through updateSettings/getSettings with bounds clamping', () => {
    updateSettings({
      ai: {
        autoFailoverEnabled: true,
        fallbackModelChain: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
        allowHigherCostFailover: true,
        allowSequentialFrameFallback: true,
        frameFallbackIntervalSeconds: 5,
        maxFallbackFramesPerSegment: 36,
      },
    });

    const reloaded = getSettings().ai;
    assert.equal(reloaded.autoFailoverEnabled, true);
    assert.deepEqual(reloaded.fallbackModelChain, ['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
    assert.equal(reloaded.allowHigherCostFailover, true);
    assert.equal(reloaded.allowSequentialFrameFallback, true);
    assert.equal(reloaded.frameFallbackIntervalSeconds, 5);
    assert.equal(reloaded.maxFallbackFramesPerSegment, 36);
  });

  test('20: Upgrade path from Migration v8 -> v9 preserves existing rows, enforces foreign keys, and creates Phase 3.0.3 tables/columns', () => {
    const upgradeDbPath = path.join(tempRoot, 'upgrade-v8-to-v9.db');
    const upDb = new Database(upgradeDbPath);
    upDb.pragma('foreign_keys = ON');

    upDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const mig of MIGRATIONS.filter((m) => m.version <= 8)) {
      if (mig.disableForeignKeys) upDb.pragma('foreign_keys = OFF');
      if (mig.sql.trim()) upDb.exec(mig.sql);
      if (mig.afterSql) mig.afterSql(upDb);
      if (mig.disableForeignKeys) upDb.pragma('foreign_keys = ON');
      upDb
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(mig.version, mig.name, new Date().toISOString());
    }

    const beforeVer = (upDb.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number }).v;
    assert.equal(beforeVer, 8);

    // Now run full runMigrations to upgrade v8 -> v9
    runMigrations(upDb);
    const afterVer = (upDb.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number }).v;
    assert.equal(afterVer, 9);

    const tables = (
      upDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    assert.ok(tables.includes('gemini_model_health'));
    assert.ok(tables.includes('ai_analysis_checkpoints'));

    const capCols = (
      upDb.prepare('PRAGMA table_info(gemini_model_capabilities_cache)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    assert.ok(capCols.includes('text_verified'));
    assert.ok(capCols.includes('image_verified'));
    assert.ok(capCols.includes('inline_video_verified'));
    assert.ok(capCols.includes('files_api_video_verified'));

    const jobCols = (
      upDb.prepare('PRAGMA table_info(ai_analysis_jobs)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    assert.ok(jobCols.includes('analysis_strategy'));
    assert.ok(jobCols.includes('fallback_history_json'));
    assert.ok(jobCols.includes('validation_summary_json'));
    assert.ok(jobCols.includes('checkpoint_resumed_from_job_id'));

    const fkIssues = upDb.pragma('foreign_key_check') as unknown[];
    assert.equal(fkIssues.length, 0);
    upDb.close();
  });

  test('21: Backup v9 export & restore preserves gemini_model_health, ai_analysis_checkpoints, and never leaks API keys', () => {
    recordModelFailure({
      modelId: 'gemini-backup-test',
      capability: 'files_api_video',
      stage: 'classifying_gameplay',
      errorCode: 'RATE_LIMIT_EXCEEDED',
      errorMessage: '429 rate limited',
    });

    const backup = exportDatabaseBackup() as {
      format?: string;
      tables: Record<string, Record<string, unknown>[]>;
    };
    const serialized = JSON.stringify(backup);
    assert.ok(!serialized.includes(process.env.GEMINI_API_KEY!), 'Backup must never include GEMINI_API_KEY');
    assert.ok('gemini_model_health' in backup.tables, 'Backup must include gemini_model_health');
    assert.ok('ai_analysis_checkpoints' in backup.tables, 'Backup must include ai_analysis_checkpoints');
    assert.ok(backup.tables.gemini_model_health.length >= 1);

    resetModelHealth();
    assert.equal(listAllModelHealth().length, 0);

    restoreDatabaseBackup(backup);
    const restoredHealth = getModelHealth('gemini-backup-test');
    assert.equal(restoredHealth.length, 1);
    assert.equal(restoredHealth[0].status, 'cooldown');
  });

  // ============================================================
  // Execute All Tests
  // ============================================================

  let passed = 0;
  let failed = 0;
  console.log(`\n=== Running Phase 3.0.3 Regression Suite (${tests.length} tests) ===\n`);

  for (const t of tests) {
    try {
      await t.run();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack ?? err.message : err);
      failed++;
    }
  }

  closeDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log(`\n=== Phase 3.0.3 Summary: ${passed}/${tests.length} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error running Phase 3.0.3 test suite:', err);
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
  process.exit(1);
});
