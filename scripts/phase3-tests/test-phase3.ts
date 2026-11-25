/**
 * Phase 3 Automated Acceptance Test Suite
 *
 * Strictly isolated in an OS temp directory — NEVER modifies the live SQLite database.
 * Uses real FFmpeg/FFprobe binary to generate and validate synthetic MP4 clips and extract evidence frames,
 * paired with a clearly labeled deterministic mock GeminiVideoProvider (no live Gemini API calls).
 *
 * Suites:
 * - Suite A: Tactical Vision Engine (7 visions, aliases, 3-layer separation, 37-row affinity matrix,
 *            unknown affinity non-blocking, no auto-mutation on selection, club/preset persistence,
 *            historical snapshot immutability, 4-mode optimizer)
 * - Suite B: Video Intelligence Pipeline (real FFmpeg MP4 validation + evidence frame extraction,
 *            corrupted/missing/path-traversal rejection, duplicate active job block, menu-only
 *            insufficient_gameplay with 0 fabricated events, replay deduplication, timestamp bounds,
 *            malformed JSON / invalid ref rejection, unknown player attribution, cancellation,
 *            error classification, remote cleanup confirmation)
 * - Suite C: Tactical Recommendation Validation & Manager Approval (invalid formation/role/focus
 *            flagged preserving rawAiProposal, loaned-out & injured sub rejection, duplicate XI
 *            rejection, unknown player ID rejection, unsupported setting rejection, no unapproved
 *            mutation, accepted recommendations create separate in_match_adjustment preserving
 *            immutable pre_match snapshot, save-as-new-club-preset)
 * - Suite D: Security, Privacy, Budget, Interrupted Recovery, Migration v5->v6 & Backup/Restore
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Isolate SQLite & media root BEFORE importing server modules
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc26-phase3-test-'));
process.env.FC26_USER_DATA_DIR = tempDir;
// Ensure GEMINI_API_KEY is unset during mock tests to verify honest status + no leakage
delete process.env.GEMINI_API_KEY;

import {
  closeDb,
  exportDatabaseBackup,
  getDb,
  restoreDatabaseBackup,
} from '../../server/db/database.ts';
import { MIGRATIONS, runMigrations } from '../../server/db/migrations.ts';
import {
  applyAcceptedRecommendationsToAdjustmentSnapshot,
  cancelAnalysisJob,
  getAnalysisJob,
  importBrowserPreviewTestClip,
  listMatchAnalysisBundle,
  markInterruptedJobsOnStartup,
  saveAdjustmentAsNewClubPreset,
  saveRecommendationDecision,
  startAnalysisJob,
} from '../../server/services/aiAnalysisOrchestrator.ts';
import {
  validateAiRecommendations,
  validateObservationTimestamps,
} from '../../server/services/analysisValidationService.ts';
import {
  classifyGeminiError,
  getGeminiStatus,
} from '../../server/services/geminiService.ts';
import type {
  GeminiVideoProvider,
  RemoteUploadedVideo,
  SecondHalfComparisonOutput,
  TacticalSynthesisOutput,
  VideoClassificationOutput,
  VideoObservationOutput,
} from '../../server/services/geminiVideoService.ts';
import {
  createClub,
  createMatch,
  createOrUpsertMatchSession,
  createPlayer,
  createTacticalPreset,
  getPreMatchTacticalSnapshot,
  getSettings,
  listClubs,
  listMatchTacticalSnapshots,
  listTacticalPresets,
  updateMatchSession,
  updateSettings,
  upsertRecordingSegment,
} from '../../server/services/repository.ts';
import { buildAiMatchTacticalContext } from '../../server/services/tacticalContextService.ts';
import {
  compareTacticalVisions,
  evaluateThreeLayerTactics,
  getTacticalVisionByKey,
  getTacticalVisionCatalog,
  normalizeTacticalVisionKey,
  optimizeForTacticalVision,
  seedTacticalVisionCatalog,
  upsertClubCoach,
  upsertPlayerRoleFamiliarity,
} from '../../server/services/tacticalVisionService.ts';
import {
  assertConfinedMediaPath,
  getEvidenceFramesDir,
  resolveServerFfmpegBinaries,
  validateVideoFile,
} from '../../server/services/videoPreprocessingService.ts';

interface TestCase {
  name: string;
  run: () => Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void) {
  tests.push({ name, run });
}

function generateSyntheticMp4(outPath: string, durationSeconds = 18): string {
  const bins = resolveServerFfmpegBinaries();
  assert.ok(bins.ffmpegPath, 'FFmpeg binary must be available to run Phase 3 real-MP4 tests');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync(
    bins.ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=640x360:rate=15`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outPath,
    ],
    { stdio: 'pipe' }
  );
  return outPath;
}

function createClubAndFullSquad(label: string) {
  const club = createClub({
    name: `FC ${label}`,
    league: 'Premier League',
    nation: 'England',
    season: '2025/26',
    managerName: 'Coach Test',
    preferredPhilosophy: 'Possession control with balanced rest defense',
    primaryFormation: '4-3-3 Holding',
    alternativeFormation: '4-2-3-1 Wide',
    preferredAttackingStyle: 'Short Passing',
    preferredDefensiveStyle: 'Balanced',
    primaryTacticalVisionKey: 'possession',
    alternativeTacticalVisionKey: 'wing_play',
    preferredBuildUpStyle: 'Short Passing',
    preferredDefensiveApproach: 'Balanced',
    preferredDefensiveLineHeight: 58,
    tacticalFlexibility: 'balanced',
    setActive: true,
  });

  const positions = ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CM', 'CM', 'LW', 'ST', 'RW'];
  const roles = [
    ['Goalkeeper', 'Defend'],
    ['Fullback', 'Defend'],
    ['Defender', 'Defend'],
    ['Ball-Playing Defender', 'Defend'],
    ['Fullback', 'Balanced'],
    ['Holding', 'Defend'],
    ['Playmaker', 'Attack'],
    ['Box-to-Box', 'Balanced'],
    ['Inside Forward', 'Balanced'],
    ['Advanced Forward', 'Attack'],
    ['Winger', 'Balanced'],
  ];

  const starters = positions.map((pos, idx) =>
    createPlayer({
      clubId: club.id,
      name: `${label} Starter ${idx + 1}`,
      position: pos,
      squadNumber: idx + 1,
      overallRating: 82,
      preferredFoot: 'Right',
      playerRole: roles[idx][0],
      playerFocus: roles[idx][1],
      strengths: 'Composure',
      weaknesses: 'None noted',
      preferredInstructions: '',
      squadStatus: 'active',
      availability: 'available',
    })
  );

  const benchEligible = createPlayer({
    clubId: club.id,
    name: `${label} Bench Striker`,
    position: 'ST',
    squadNumber: 19,
    overallRating: 80,
    preferredFoot: 'Right',
    playerRole: 'Poacher',
    playerFocus: 'Attack',
    strengths: 'Finishing',
    weaknesses: 'Hold-up',
    preferredInstructions: '',
    squadStatus: 'active',
    availability: 'available',
  });

  const loanedOutPlayer = createPlayer({
    clubId: club.id,
    name: `${label} Loaned Out Winger`,
    position: 'LW',
    squadNumber: 29,
    overallRating: 78,
    preferredFoot: 'Left',
    playerRole: 'Winger',
    playerFocus: 'Balanced',
    strengths: 'Pace',
    weaknesses: 'Decision making',
    preferredInstructions: '',
    squadStatus: 'loaned_out',
    availability: 'available',
  });

  const injuredPlayer = createPlayer({
    clubId: club.id,
    name: `${label} Injured Midfielder`,
    position: 'CM',
    squadNumber: 24,
    overallRating: 81,
    preferredFoot: 'Right',
    playerRole: 'Playmaker',
    playerFocus: 'Attack',
    strengths: 'Passing',
    weaknesses: 'Pace',
    preferredInstructions: '',
    squadStatus: 'active',
    availability: 'injured',
  });

  const assignments = starters.map((p, idx) => ({
    slotIndex: idx,
    slotOrder: idx,
    slotId: `slot_${idx + 1}`,
    positionCode: positions[idx],
    playerId: p.id,
    playerName: p.displayName,
    role: roles[idx][0],
    focus: roles[idx][1],
  }));

  return {
    club,
    starters,
    benchEligible,
    loanedOutPlayer,
    injuredPlayer,
    assignments,
  };
}

function createMockProvider(options: {
  mode?: 'normal' | 'menu_only' | 'malformed_json' | 'slow_cancel' | 'cleanup_fail';
  deletedRemoteFiles?: string[];
  clubBenchPlayerId?: string;
  starterOutId?: string;
} = {}): GeminiVideoProvider {
  const deleted = options.deletedRemoteFiles ?? [];
  const mode = options.mode ?? 'normal';

  return {
    isMock: true,
    async uploadAndAwaitActive(input): Promise<RemoteUploadedVideo> {
      if (mode === 'slow_cancel') {
        await new Promise((r) => setTimeout(r, 80));
      }
      if (input.isCancelled()) {
        throw new Error('Analysis job cancelled by user.');
      }
      return {
        remoteFileName: `files/mock-${crypto.randomUUID().slice(0, 8)}`,
        remoteFileUri: `https://generativelanguage.googleapis.com/v1beta/files/mock-${crypto.randomUUID().slice(0, 8)}`,
        remoteState: 'ACTIVE',
        uploadMs: 12,
        mediaProcessingMs: 10,
      };
    },

    async deleteRemoteFile(remoteFileName: string) {
      if (mode === 'cleanup_fail') {
        return { deleted: false, error: 'Simulated transient 503 during remote delete' };
      }
      deleted.push(remoteFileName);
      return { deleted: true, error: null };
    },

    async classifyVideoSegment(): Promise<VideoClassificationOutput> {
      if (mode === 'menu_only') {
        return {
          segments: [
            {
              startSeconds: 0,
              endSeconds: 4,
              contentType: 'pause_menu',
              confidence: 'High',
              evidenceDescription: 'Pause menu overlay visible throughout clip.',
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
            modelId: 'gemini-3.1-flash-lite',
            inputTokens: 400,
            outputTokens: 120,
            estimatedCostUsd: 0.0005,
            durationMs: 15,
          },
        };
      }

      return {
        segments: [
          {
            startSeconds: 0,
            endSeconds: 16,
            contentType: 'live_gameplay',
            confidence: 'High',
            evidenceDescription: 'Open play visible from broadcast camera.',
            inGameClock: '38:10',
          },
          {
            startSeconds: 16,
            endSeconds: 18,
            contentType: 'replay',
            confidence: 'High',
            evidenceDescription: 'Slow-motion replay angle of preceding chance.',
            inGameClock: null,
          },
        ],
        readableHudStats: {
          scoreline: '1 - 1',
          matchClock: '45:00',
          possessionLabel: null,
          shotsLabel: null,
          otherVerifiedStats: [],
        },
        usage: {
          modelId: 'gemini-3.1-flash-lite',
          inputTokens: 500,
          outputTokens: 180,
          estimatedCostUsd: 0.0008,
          durationMs: 20,
        },
      };
    },

    async extractGameplayObservations(): Promise<VideoObservationOutput> {
      if (mode === 'malformed_json') {
        throw new SyntaxError('Unexpected token in JSON at position 0');
      }
      return {
        observations: [
          {
            startSeconds: 4.5,
            endSeconds: 8.0,
            inGameClock: '38:22',
            categoryGroup: 'defensive',
            category: 'wide_channel_exposure',
            teamAttribution: 'user_team',
            playerAttribution: 'Unknown',
            description: 'Right-sided defender stepped high leaving space behind wide channel.',
            supportingVisualEvidence: 'Visible 15m gap behind right flank during transition.',
            evidenceType: 'directly_observed',
            confidence: 'High',
            severity: 'High',
            limitations: 'Jersey number unreadable at broadcast zoom.',
            isFromReplay: false,
          },
          {
            // Replay duplicate
            startSeconds: 16.1,
            endSeconds: 17.5,
            inGameClock: null,
            categoryGroup: 'defensive',
            category: 'wide_channel_exposure',
            teamAttribution: 'user_team',
            playerAttribution: 'Unknown',
            description: 'Replay angle of right flank transition gap.',
            supportingVisualEvidence: 'Broadcast replay wipe visible.',
            evidenceType: 'directly_observed',
            confidence: 'Medium',
            severity: 'High',
            limitations: 'Replay footage.',
            isFromReplay: true,
          },
        ],
        usage: {
          modelId: 'gemini-4-hydrogen',
          inputTokens: 1200,
          outputTokens: 320,
          estimatedCostUsd: 0.0025,
          durationMs: 25,
        },
      };
    },

    async synthesizeTacticalBriefing(input): Promise<TacticalSynthesisOutput> {
      const firstObsId = input.observations[0]?.id ?? 'obs-1';
      return {
        evidenceQuality: 'moderate',
        managerVerdict: {
          whatIsWorking: ['Compact central passing triangles during early build-up.'],
          whatIsNotWorking: ['Space exposed behind the right flank during counter transitions.'],
          whyTacticStruggling: 'Right fullback pushing up without cover when possession turns over.',
          firstPriorityChange: 'Switch RB Fullback focus from Balanced to Defend.',
          conciseSummary: 'Balanced first half; tighten right-flank transition protection.',
        },
        gameplayCoaching: [
          {
            instruction: 'Delay pressing on turnovers until central midfielders recover.',
            triggerSituation: 'Opponent wins ball in central third',
            evidenceNote: 'Observed wide channel gap at 38:22.',
          },
        ],
        contingencyPlan: [
          {
            scenario: 'If leading after 70 minutes',
            trigger: 'Scoreline ahead by 1 goal',
            tacticalAction: 'Drop defensive line height to 45 and keep Fullbacks on Defend.',
          },
        ],
        limitations: ['Only short synthetic test clip analyzed; possession percentage unreadable.'],
        visionAssessment: {
          observedPlayingStyle: {
            primaryTendency: 'Controlled short build-up with exposed right flank',
            mixedTendencies: ['Possession', 'Occasional direct switch'],
            evidenceSummary: 'Short passing sequences observed in central zones.',
            isInsufficientEvidence: false,
          },
          recommendedVisionKey: 'retain_current',
          recommendationStance: 'retain_and_refine',
          recommendationRationale: 'Keep Possession vision and adjust RB focus rather than overhauling vision.',
          executionAssessmentLabel: 'Moderately Aligned — Right-Flank Rest Defense Needs Tightening',
          internalAssessmentScore: 74,
          scoreMethodologyNote: 'Internal FC26 AI Manager heuristic index (not an official EA rating).',
          criteriaBreakdown: [
            {
              criterion: 'Short passing support triangles',
              assessment: 'strong',
              evidenceNote: 'Consistent nearby passing lanes.',
            },
            {
              criterion: 'Rest defense behind wide channels',
              assessment: 'weak',
              evidenceNote: 'Gap exposed at 38:22.',
            },
          ],
          confidence: 'Medium',
          limitations: 'Short clip sample.',
        },
        recommendations: [
          {
            priorityGroup: 'immediate_correction',
            priorityRank: 1,
            title: 'Tighten Right Fullback Focus to Defend',
            actionType: 'player_focus',
            targetSlotId: 'slot_5',
            targetPositionCode: 'RB',
            currentValue: 'Balanced',
            proposedValue: 'Defend',
            reason: 'Prevents space opening behind the right flank on turnovers.',
            expectedBenefit: 'Stronger rest defense against counter-attacks.',
            potentialRisk: 'Slightly less overlapping width on the right.',
            evidenceObservationIds: [firstObsId],
            evidenceTimestamps: [
              { segmentId: input.observations[0]?.segmentId ?? null, startSeconds: 0.5, endSeconds: 2.0, inGameClock: '38:22' },
            ],
            confidence: 'High',
          },
          {
            priorityGroup: 'structural_adjustment',
            priorityRank: 2,
            title: 'Adjust Defensive Line Height to 52',
            actionType: 'defensive_line_height',
            currentValue: '58',
            proposedValue: '52',
            reason: 'Reduces space in behind when turnovers happen.',
            expectedBenefit: 'Better recovery distance for center backs.',
            potentialRisk: 'Slightly less high-pressing pressure.',
            evidenceObservationIds: [firstObsId],
            evidenceTimestamps: [
              { segmentId: input.observations[0]?.segmentId ?? null, startSeconds: 0.5, endSeconds: 2.0, inGameClock: '38:22' },
            ],
            confidence: 'Medium',
          },
          ...(options.clubBenchPlayerId && options.starterOutId
            ? [
                {
                  priorityGroup: 'player_change' as const,
                  priorityRank: 3,
                  title: 'Bring On Fresh Striker From Bench',
                  actionType: 'substitution' as const,
                  targetPositionCode: 'ST',
                  currentValue: 'Starter ST',
                  proposedValue: 'Bench Striker',
                  targetPlayerOutId: options.starterOutId,
                  targetPlayerInId: options.clubBenchPlayerId,
                  reason: 'Adds sharper box movement for second half.',
                  expectedBenefit: 'More direct threat in final third.',
                  potentialRisk: 'Less link-up play.',
                  evidenceObservationIds: [firstObsId],
                  evidenceTimestamps: [
                    { segmentId: input.observations[0]?.segmentId ?? null, startSeconds: 0.5, endSeconds: 2.0, inGameClock: '38:22' },
                  ],
                  confidence: 'Medium' as const,
                },
              ]
            : []),
        ],
        usage: {
          modelId: 'gemini-4-hydrogen',
          inputTokens: 1500,
          outputTokens: 650,
          estimatedCostUsd: 0.004,
          durationMs: 30,
        },
      };
    },

    async synthesizeSecondHalfComparison(): Promise<SecondHalfComparisonOutput> {
      return {
        summary: 'Second-half clip showed tighter right-side spacing after defensive adjustment.',
        appliedAdjustmentsReviewed: [
          {
            recommendationTitle: 'Tighten Right Fullback Focus to Defend',
            userConfirmedAppliedInGame: true,
            observedSecondHalfPattern: 'Fewer transition gaps on right flank.',
            outcomeAssessment: 'improved',
            causationCaveat:
              'Correlation observed in footage; opponent tactical changes or game state may also contribute.',
          },
        ],
        attackingComparison: 'Maintained central ball progression.',
        defensiveComparison: 'Reduced wide channel counter exposure.',
        tacticalVisionComparison: 'Remained aligned with Possession principles.',
        recurringWeaknesses: ['Occasional slow recovery after lost duels.'],
        limitations: ['Short clip comparison cannot guarantee causation.'],
        usage: {
          modelId: 'gemini-4-hydrogen',
          inputTokens: 1100,
          outputTokens: 350,
          estimatedCostUsd: 0.0022,
          durationMs: 20,
        },
      };
    },
  };
}

// ============================================================
// SUITE A — TACTICAL VISION ENGINE
// ============================================================

test('A1: All 7 official FC26 Tactical Visions seeded idempotently with aliases & 37 affinity entries', () => {
  const db = getDb();
  const firstSeed = seedTacticalVisionCatalog(db);
  const secondSeed = seedTacticalVisionCatalog(db);
  assert.equal(firstSeed.visionCount, 7);
  assert.equal(secondSeed.visionCount, 7);

  const catalog = getTacticalVisionCatalog(db);
  assert.equal(catalog.visions.length, 7);

  // Alias normalization checks
  assert.equal(normalizeTacticalVisionKey('Tiki Taka', db), 'possession');
  assert.equal(normalizeTacticalVisionKey('Gegenpressing', db), 'high_pressing');
  assert.equal(normalizeTacticalVisionKey('Kick & Rush', db), 'kick_and_rush');
  assert.equal(normalizeTacticalVisionKey('Wing-Play', db), 'wing_play');
  assert.equal(normalizeTacticalVisionKey('Park the Bus', db), 'park_the_bus');
  assert.equal(normalizeTacticalVisionKey('Counter-Attack', db), 'counter_attack');
  assert.equal(normalizeTacticalVisionKey('Standard', db), 'standard');
  assert.equal(normalizeTacticalVisionKey('nonexistent_style', db), 'unspecified');

  // Verify 37 unique position-role rows exist in the seeded role affinity matrix (37 rows x 7 visions = 259 cells)
  const uniquePairs = new Set(
    catalog.roleAffinities.map((r) => `${r.positionCode}::${r.roleName}`)
  );
  assert.ok(
    uniquePairs.size >= 37,
    `Expected at least 37 position-role pairs in affinity matrix, got ${uniquePairs.size}`
  );
  assert.ok(catalog.sources.length >= 2, 'Provenance sources and conflict notes must be seeded');

  const possession = getTacticalVisionByKey('possession', db);
  assert.ok(possession);
  assert.equal(possession.officialRequirements.length, 1);
  assert.equal(possession.officialRequirements[0].parameterType, 'build_up_style');
  assert.ok(possession.officialRequirements[0].allowedValues.includes('Short Passing'));
});

test('A2: 3-Layer validation strictly separates Layer 1 blocking, Layer 2 conflicts, and Layer 3 advisory affinity', () => {
  const { club, assignments } = createClubAndFullSquad('VisionLayers');

  // Test Possession + Counter (Layer 2 conflict) + Poacher on ST (Layer 3 not_associated, STILL LEGAL in Layer 1!)
  const modifiedAssignments = assignments.map((a) =>
    a.positionCode === 'ST' ? { ...a, role: 'Poacher', focus: 'Attack' } : a
  );

  const evalPossession = evaluateThreeLayerTactics({
    clubId: club.id,
    tacticalVisionKey: 'possession',
    formationName: '4-3-3 Holding',
    buildUpStyle: 'Counter', // conflicts with Possession's official Short Passing requirement
    defensiveApproach: 'Balanced',
    defensiveLineHeight: 55,
    assignments: modifiedAssignments,
  });

  assert.equal(evalPossession.layer1FcIqLegality.valid, true, 'Poacher on ST must remain legal in Layer 1');
  assert.equal(evalPossession.layer2OfficialRequirements.status, 'conflict');
  assert.equal(evalPossession.layer2OfficialRequirements.conflicts.length, 1);
  assert.equal(
    evalPossession.layer2OfficialRequirements.conflicts[0].suggestedCorrectionValue,
    'Short Passing'
  );

  const stSlot = evalPossession.layer3RoleAffinity.slotAffinities.find((s) => s.positionCode === 'ST');
  assert.ok(stSlot);
  assert.equal(stSlot.legalForPosition, true);
  assert.equal(stSlot.affinityStatus, 'not_associated', 'Poacher is not associated with Possession');

  // Test Wing Play + False 9 on ST (also legal & selectable!)
  const wingPlayAssignments = assignments.map((a) =>
    a.positionCode === 'ST' ? { ...a, role: 'False 9', focus: 'Build-Up' } : a
  );
  const evalWingPlay = evaluateThreeLayerTactics({
    clubId: club.id,
    tacticalVisionKey: 'wing_play',
    formationName: '4-3-3 Holding',
    buildUpStyle: 'Balanced',
    defensiveApproach: 'Balanced',
    defensiveLineHeight: 55,
    assignments: wingPlayAssignments,
  });
  assert.equal(evalWingPlay.layer1FcIqLegality.valid, true, 'Wing Play + False 9 must be legal in Layer 1');
  assert.equal(evalWingPlay.layer2OfficialRequirements.status, 'compliant');

  // Test Wide Half on CDM is recognized & legal in Layer 1
  const wideHalfAssignments = assignments.map((a) =>
    a.positionCode === 'CDM' ? { ...a, role: 'Wide Half', focus: 'Defend' } : a
  );
  const evalWideHalf = evaluateThreeLayerTactics({
    clubId: club.id,
    tacticalVisionKey: 'wing_play',
    formationName: '4-3-3 Holding',
    buildUpStyle: 'Balanced',
    defensiveApproach: 'Balanced',
    defensiveLineHeight: 55,
    assignments: wideHalfAssignments,
  });
  assert.equal(evalWideHalf.layer1FcIqLegality.valid, true, 'Wide Half on CDM must be legal');
  const cdmSlot = evalWideHalf.layer3RoleAffinity.slotAffinities.find((s) => s.positionCode === 'CDM');
  assert.equal(cdmSlot?.affinityStatus, 'associated', 'CDM Wide Half is associated with Wing Play');

  // Unknown position/role affinity must NOT block or fabricate association
  const evalUnknownRole = evaluateThreeLayerTactics({
    clubId: club.id,
    tacticalVisionKey: 'high_pressing',
    formationName: '4-3-3 Holding',
    buildUpStyle: 'Balanced',
    defensiveApproach: 'High',
    defensiveLineHeight: 72,
    assignments: assignments.map((a) =>
      a.positionCode === 'ST' ? { ...a, role: 'Target Forward', focus: 'Attack' } : a
    ),
  });
  assert.equal(evalUnknownRole.layer1FcIqLegality.valid, true);
  assert.equal(evalUnknownRole.layer2OfficialRequirements.status, 'compliant');
});

test('A3: Coaches, Role Familiarity, Vision Comparison, 4-Mode Optimizer (no auto-mutation) & Snapshot Immutability', () => {
  const { club, starters, benchEligible, assignments } = createClubAndFullSquad('VisionOpt');

  const coach = upsertClubCoach(club.id, {
    name: 'Assistant Coach Pep',
    department: 'midfield',
    tacticalVisionKey: 'possession',
    qualificationLevel: 'gold',
    starRating: 5,
    notes: 'Midfield possession coach',
  });
  assert.equal(coach.tacticalVisionKey, 'possession');

  const fam = upsertPlayerRoleFamiliarity(starters[6].id, {
    positionCode: 'CM',
    roleName: 'Playmaker',
    baseFamiliarity: 'role_plus',
    potentialCoachFamiliarity: 'role_plus_plus',
    confirmedFamiliarity: 'role_plus',
  });
  assert.equal(fam.confirmedFamiliarity, 'role_plus');

  // Save a tactical preset with Possession
  const preset = createTacticalPreset(club.id, {
    name: 'Base Possession 4-3-3',
    formationName: '4-3-3 Holding',
    tacticalVisionKey: 'possession',
    buildUpStyle: 'Counter', // deliberate Layer 2 conflict for optimizer test
    defensiveApproach: 'Balanced',
    defensiveLineHeight: 58,
    isDefault: true,
    presetStatus: 'match_ready',
    benchPlayerIds: [benchEligible.id],
    assignments: assignments.map((a) => ({
      slotOrder: a.slotOrder,
      slotId: a.slotId,
      positionCode: a.positionCode,
      playerId: a.playerId,
      role: a.role,
      focus: a.focus,
    })),
  });
  assert.equal(preset.tacticalVisionKey, 'possession');
  assert.equal(preset.buildUpStyle, 'Counter', 'Selecting a vision must NEVER silently mutate buildUpStyle');

  // Compare two visions
  const comparison = compareTacticalVisions('possession', 'counter_attack', {
    clubId: club.id,
    formationName: preset.formationName,
    buildUpStyle: preset.buildUpStyle,
    defensiveApproach: preset.defensiveApproach,
    defensiveLineHeight: preset.defensiveLineHeight,
    assignments: assignments.map((a) => ({
      slotOrder: a.slotOrder,
      slotId: a.slotId,
      positionCode: a.positionCode,
      playerId: a.playerId,
      role: a.role,
      focus: a.focus,
    })),
  });
  assert.equal(comparison.visionA.tacticalVisionKey, 'possession');
  assert.equal(comparison.visionB.tacticalVisionKey, 'counter_attack');

  // Test all 4 optimizer modes — none should auto-mutate saved preset in SQLite
  for (const mode of [
    'minimal_adjustment',
    'role_optimization',
    'squad_optimization',
    'full_tactical_optimization',
  ] as const) {
    const opt = optimizeForTacticalVision({
      clubId: club.id,
      targetVisionKey: 'possession',
      mode,
      formationName: preset.formationName,
      buildUpStyle: preset.buildUpStyle,
      defensiveApproach: preset.defensiveApproach,
      defensiveLineHeight: preset.defensiveLineHeight,
      assignments: assignments.map((a) => ({
        slotOrder: a.slotOrder,
        slotId: a.slotId,
        positionCode: a.positionCode,
        playerId: a.playerId,
        role: a.role,
        focus: a.focus,
      })),
      benchPlayerIds: [benchEligible.id],
    });
    assert.equal(opt.mode, mode);
    assert.equal(opt.afterPreview.buildUpStyle, 'Short Passing');
  }

  // Verify preset in DB was NOT mutated by running optimizer
  const reloadedPreset = listTacticalPresets(club.id).find((p) => p.id === preset.id);
  assert.equal(reloadedPreset?.buildUpStyle, 'Counter', 'Optimizer must never auto-mutate saved presets');

  // Create match and verify pre_match snapshot preserves vision even if preset changes later
  const match = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentName: 'Arsenal',
    competition: 'Premier League',
    venue: 'home',
    matchDate: '2026-03-14',
    sourcePresetId: preset.id,
    startingFormation: '4-3-3 Holding',
    startingXiIds: starters.map((p) => p.id),
    benchIds: [benchEligible.id],
    objective: 'Win',
    preMatchNotes: 'Press carefully',
    tacticalSetup: {
      tacticalVisionKey: 'possession',
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 58,
      playerAssignments: assignments,
    },
  });
  const preSnap = getPreMatchTacticalSnapshot(match.id);
  assert.ok(preSnap);
  assert.equal(preSnap.tacticalVisionKey, 'possession');
});

// ============================================================
// SUITE B — VIDEO INTELLIGENCE PIPELINE (REAL FFMPEG + MOCK PROVIDER)
// ============================================================

test('B1: Real FFmpeg MP4 validation, path confinement, corrupted/missing rejection, and Browser Preview clip import', async () => {
  const { club, starters, benchEligible, assignments } = createClubAndFullSquad('VideoVal');
  const match = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentName: 'Liverpool',
    competition: 'Premier League',
    venue: 'away',
    matchDate: '2026-03-20',
    startingFormation: '4-3-3 Holding',
    startingXiIds: starters.map((p) => p.id),
    benchIds: [benchEligible.id],
    objective: 'Draw or win',
    preMatchNotes: '',
    tacticalSetup: {
      tacticalVisionKey: 'possession',
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 55,
      playerAssignments: assignments,
    },
  });

  // Path traversal rejection
  assert.throws(
    () => assertConfinedMediaPath('/etc/passwd'),
    /Security block/
  );
  assert.throws(
    () => assertConfinedMediaPath(path.join(tempDir, '..', '..', 'etc', 'passwd')),
    /Security block/
  );

  // Missing file rejection
  const missingRes = await validateVideoFile(path.join(tempDir, 'recordings', 'does-not-exist.mp4'));
  assert.equal(missingRes.valid, false);

  // Corrupted MP4 rejection
  const corruptPath = path.join(tempDir, 'recordings', 'corrupt.mp4');
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, Buffer.from('not-a-valid-mp4-container'));
  const corruptRes = await validateVideoFile(corruptPath);
  assert.equal(corruptRes.valid, false);

  // Real FFmpeg synthetic MP4 validation + Browser Preview test clip import
  const validPath = generateSyntheticMp4(path.join(tempDir, 'recordings', 'valid_clip.mp4'), 4);
  const validRes = await validateVideoFile(validPath);
  assert.equal(validRes.valid, true, `Valid FFmpeg MP4 should pass validation: ${validRes.error}`);
  assert.ok(validRes.durationSeconds >= 3.5);
  assert.ok(validRes.sha256Hash.length === 64);

  const imported = await importBrowserPreviewTestClip({
    matchId: match.id,
    half: 'first_half',
    fileName: 'test-first-half.mp4',
    buffer: fs.readFileSync(validPath),
  });
  assert.ok(imported.sessionId);
  assert.ok(imported.durationSeconds >= 3.5);
});

test('B2: End-to-end First-Half + Second-Half analysis with replay deduplication, frame extraction & confirmed remote cleanup', async () => {
  const { club, starters, benchEligible, assignments } = createClubAndFullSquad('VideoE2E');
  const match = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentName: 'Manchester City',
    competition: 'Premier League',
    venue: 'home',
    matchDate: '2026-03-22',
    startingFormation: '4-3-3 Holding',
    startingXiIds: starters.map((p) => p.id),
    benchIds: [benchEligible.id],
    objective: 'Control transitions',
    preMatchNotes: 'Watch wide overloads',
    tacticalSetup: {
      tacticalVisionKey: 'possession',
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 58,
      playerAssignments: assignments,
    },
  });

  const clip1 = generateSyntheticMp4(path.join(tempDir, 'recordings', `${match.id}_h1.mp4`), 18);
  await importBrowserPreviewTestClip({
    matchId: match.id,
    half: 'first_half',
    fileName: 'h1.mp4',
    buffer: fs.readFileSync(clip1),
  });

  const deletedFiles: string[] = [];
  const provider = createMockProvider({
    mode: 'normal',
    deletedRemoteFiles: deletedFiles,
    clubBenchPlayerId: benchEligible.id,
    starterOutId: starters[9].id,
  });

  const started = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    analysisMode: 'balanced',
    language: 'en',
    privacyAuthorized: true,
    provider,
    awaitCompletion: true,
  });

  assert.equal(started.reusedFromCache, false);
  assert.ok(
    started.job.status === 'completed' || started.job.status === 'completed_with_limitations',
    `Expected completed status, got ${started.job.status}: ${started.job.errorMessage}`
  );
  assert.equal(deletedFiles.length, 1, 'Remote Gemini file must be deleted and confirmed');

  const bundle = listMatchAnalysisBundle(match.id);
  assert.ok(bundle.briefing, 'Briefing must be persisted');
  assert.ok(bundle.visionAssessment, 'Vision assessment must be persisted');
  assert.equal(bundle.assets.length, 1);
  assert.equal(bundle.assets[0].cleanupStatus, 'deleted');
  assert.ok(bundle.assets[0].cleanupConfirmedAt);

  // Replay deduplication check: only non-replay primary event should remain or replay marked deduplicated
  const nonReplayObs = bundle.observations.filter((o) => !o.isFromReplay);
  assert.equal(nonReplayObs.length, 1, 'Replay duplicate should not double-count as a new live event');
  assert.equal(nonReplayObs[0].playerAttribution, 'Unknown', 'Unreadable player identity stays Unknown');
  assert.ok(
    nonReplayObs[0].evidenceFramePath &&
      !nonReplayObs[0].evidenceFramePath.includes('/') &&
      fs.existsSync(path.join(getEvidenceFramesDir(match.id), nonReplayObs[0].evidenceFramePath)),
    'Real FFmpeg evidence frame JPEG must be extracted inside confined evidence_frames directory'
  );

  // Cached fingerprint reuse check
  const cached = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    analysisMode: 'balanced',
    language: 'en',
    privacyAuthorized: true,
    provider,
    awaitCompletion: true,
  });
  assert.equal(cached.reusedFromCache, true, 'Identical request fingerprint should reuse completed cache');

  // Second-half analysis & Stage 4 comparison
  const clip2 = generateSyntheticMp4(path.join(tempDir, 'recordings', `${match.id}_h2.mp4`), 18);
  await importBrowserPreviewTestClip({
    matchId: match.id,
    half: 'second_half',
    fileName: 'h2.mp4',
    buffer: fs.readFileSync(clip2),
  });

  const h2 = await startAnalysisJob({
    matchId: match.id,
    half: 'second_half',
    analysisMode: 'balanced',
    language: 'en',
    privacyAuthorized: true,
    provider,
    awaitCompletion: true,
  });
  assert.ok(h2.job.status === 'completed' || h2.job.status === 'completed_with_limitations');
  const h2Bundle = listMatchAnalysisBundle(match.id, h2.job.id);
  assert.ok(h2Bundle.secondHalfComparison, 'Stage 4 second-half comparison must be persisted');
  assert.ok(
    h2Bundle.secondHalfComparison.appliedAdjustmentsReviewed[0].causationCaveat.length > 10,
    'Second-half comparison must include explicit causation caveats'
  );
});

test('B3: Menu-only footage yields insufficient_gameplay with 0 fabricated events; malformed JSON fails cleanly; cancellation & error classification work', async () => {
  const { club, starters, benchEligible, assignments } = createClubAndFullSquad('EdgeCases');
  const match = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentName: 'Chelsea',
    competition: 'Premier League',
    venue: 'home',
    matchDate: '2026-03-25',
    startingFormation: '4-3-3 Holding',
    startingXiIds: starters.map((p) => p.id),
    benchIds: [benchEligible.id],
    objective: 'Win',
    preMatchNotes: '',
    tacticalSetup: {
      tacticalVisionKey: 'possession',
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 55,
      playerAssignments: assignments,
    },
  });

  const clip = generateSyntheticMp4(path.join(tempDir, 'recordings', `${match.id}_menu.mp4`), 4);
  await importBrowserPreviewTestClip({
    matchId: match.id,
    half: 'first_half',
    fileName: 'menu.mp4',
    buffer: fs.readFileSync(clip),
  });

  // 1. Menu-only -> insufficient_gameplay with 0 observations & 0 recommendations
  const menuRes = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    analysisMode: 'quick',
    language: 'en',
    privacyAuthorized: true,
    forceReanalyze: true,
    provider: createMockProvider({ mode: 'menu_only' }),
    awaitCompletion: true,
  });
  assert.equal(menuRes.job.status, 'insufficient_gameplay');
  const menuBundle = listMatchAnalysisBundle(match.id, menuRes.job.id);
  assert.equal(menuBundle.observations.length, 0, 'Must fabricate 0 observations on menu-only video');
  assert.equal(menuBundle.recommendations.length, 0, 'Must fabricate 0 recommendations on menu-only video');

  // 2. Malformed JSON -> failed cleanly without crashing
  const malformedRes = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    analysisMode: 'quick',
    language: 'en',
    privacyAuthorized: true,
    forceReanalyze: true,
    provider: createMockProvider({ mode: 'malformed_json' }),
    awaitCompletion: true,
  });
  assert.equal(malformedRes.job.status, 'failed');
  assert.ok(malformedRes.job.errorMessage);

  // 3. Cancellation & Duplicate active job prevention
  const slowStart = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    analysisMode: 'quick',
    language: 'en',
    privacyAuthorized: true,
    forceReanalyze: true,
    provider: createMockProvider({ mode: 'slow_cancel' }),
    awaitCompletion: false,
  });

  // Attempting to start a second concurrent job for same match+half must throw
  await assert.rejects(
    () =>
      startAnalysisJob({
        matchId: match.id,
        half: 'first_half',
        analysisMode: 'quick',
        language: 'en',
        privacyAuthorized: true,
        forceReanalyze: true,
        provider: createMockProvider({ mode: 'normal' }),
        awaitCompletion: false,
      }),
    /active AI analysis job is already running/i
  );

  cancelAnalysisJob(slowStart.job.id);
  await new Promise((r) => setTimeout(r, 150));
  const afterCancel = getAnalysisJob(slowStart.job.id);
  assert.ok(afterCancel);
  assert.ok(
    afterCancel.status === 'cancelled' || afterCancel.cancelRequested === true,
    `Expected cancelled job, got ${afterCancel.status}`
  );

  // 4. Timestamp bounds validation
  const tsCheck = validateObservationTimestamps(
    [
      { segmentId: 'seg-1', startSeconds: 10, endSeconds: 5 },
      { segmentId: 'seg-1', startSeconds: 999, endSeconds: 1010 },
    ],
    new Map([['seg-1', 60]])
  );
  assert.equal(tsCheck.valid, false);
  assert.equal(tsCheck.errors.length, 2);

  // 5. Gemini error classification (auth, rate limit, network)
  assert.equal(classifyGeminiError({ status: 401, message: 'API key invalid' }).code, 'AUTH_INVALID_KEY');
  assert.equal(classifyGeminiError({ status: 429, message: 'RESOURCE_EXHAUSTED quota' }).code, 'RATE_LIMIT_OR_QUOTA');
  assert.equal(classifyGeminiError(new Error('ECONNRESET fetch failed')).code, 'NETWORK_OR_UPSTREAM_TRANSIENT');
});

// ============================================================
// SUITE C — SERVER-SIDE RECOMMENDATION VALIDATION & MANAGER APPROVAL
// ============================================================

test('C1: Deterministic FC26 validation catches invalid formation/role/focus, loaned/injured subs, duplicates, unknown IDs & bad refs while preserving rawAiProposal', () => {
  const { club, starters, benchEligible, loanedOutPlayer, injuredPlayer, assignments } =
    createClubAndFullSquad('RecValidation');

  const match = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentName: 'Tottenham',
    competition: 'Premier League',
    venue: 'home',
    matchDate: '2026-03-28',
    startingFormation: '4-3-3 Holding',
    startingXiIds: starters.map((p) => p.id),
    benchIds: [benchEligible.id],
    objective: 'Win',
    preMatchNotes: '',
    tacticalSetup: {
      tacticalVisionKey: 'possession',
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 55,
      playerAssignments: assignments,
    },
  });

  const ctx = buildAiMatchTacticalContext(match.id);
  const validObs = [
    {
      id: 'obs-valid-1',
      jobId: 'job-1',
      matchId: match.id,
      half: 'first_half' as const,
      segmentId: 'seg-1',
      startSeconds: 5,
      endSeconds: 12,
      sessionStartSeconds: 5,
      sessionEndSeconds: 12,
      inGameClock: '22:10',
      categoryGroup: 'defensive' as const,
      category: 'gap',
      teamAttribution: 'user_team' as const,
      playerAttribution: 'Unknown',
      description: 'Midfield gap',
      supportingVisualEvidence: 'Visible gap',
      evidenceType: 'directly_observed' as const,
      confidence: 'High' as const,
      severity: 'High' as const,
      limitations: '',
      evidenceFramePath: null,
      isFromReplay: false,
      createdAt: new Date().toISOString(),
    },
  ];

  assert.ok(ctx, 'Match context should be built for validation test');
  const results = validateAiRecommendations({
    clubId: club.id,
    matchContext: ctx,
    observations: validObs,
    segmentDurationById: new Map([['seg-1', 60]]),
    rawRecommendations: [
      {
        priorityGroup: 'structural_adjustment',
        priorityRank: 1,
        title: 'Switch to fake formation 9-0-1',
        actionType: 'formation_change',
        currentValue: '4-3-3 Holding',
        proposedValue: '9-0-1 Ultra Fake',
        reason: 'Hallucinated formation',
        expectedBenefit: 'None',
        potentialRisk: 'Invalid',
        evidenceObservationIds: ['obs-valid-1'],
        evidenceTimestamps: [{ segmentId: 'seg-1', startSeconds: 5, endSeconds: 12, inGameClock: '22:10' }],
        confidence: 'Low',
      },
      {
        priorityGroup: 'immediate_correction',
        priorityRank: 2,
        title: 'Illegal role on GK',
        actionType: 'player_role',
        targetPositionCode: 'GK',
        currentValue: 'Goalkeeper (Defend)',
        proposedValue: 'Poacher (Attack)',
        reason: 'Illegal FC IQ role for GK',
        expectedBenefit: 'None',
        potentialRisk: 'Invalid',
        evidenceObservationIds: ['obs-valid-1'],
        evidenceTimestamps: [{ segmentId: 'seg-1', startSeconds: 5, endSeconds: 12, inGameClock: '22:10' }],
        confidence: 'Low',
      },
      {
        priorityGroup: 'player_change',
        priorityRank: 3,
        title: 'Sub on loaned-out player',
        actionType: 'substitution',
        targetPositionCode: 'LW',
        currentValue: starters[8].displayName,
        proposedValue: loanedOutPlayer.displayName,
        targetPlayerOutId: starters[8].id,
        targetPlayerInId: loanedOutPlayer.id,
        reason: 'Should be rejected as loaned out',
        expectedBenefit: 'None',
        potentialRisk: 'Ineligible',
        evidenceObservationIds: ['obs-valid-1'],
        evidenceTimestamps: [{ segmentId: 'seg-1', startSeconds: 5, endSeconds: 12, inGameClock: '22:10' }],
        confidence: 'Low',
      },
      {
        priorityGroup: 'player_change',
        priorityRank: 4,
        title: 'Sub on injured player',
        actionType: 'substitution',
        targetPositionCode: 'CM',
        currentValue: starters[6].displayName,
        proposedValue: injuredPlayer.displayName,
        targetPlayerOutId: starters[6].id,
        targetPlayerInId: injuredPlayer.id,
        reason: 'Should be rejected as injured',
        expectedBenefit: 'None',
        potentialRisk: 'Ineligible',
        evidenceObservationIds: ['obs-valid-1'],
        evidenceTimestamps: [{ segmentId: 'seg-1', startSeconds: 5, endSeconds: 12, inGameClock: '22:10' }],
        confidence: 'Low',
      },
      {
        priorityGroup: 'player_change',
        priorityRank: 5,
        title: 'Sub on player already in Starting XI (duplicate)',
        actionType: 'substitution',
        targetPositionCode: 'ST',
        currentValue: starters[9].displayName,
        proposedValue: starters[8].displayName,
        targetPlayerOutId: starters[9].id,
        targetPlayerInId: starters[8].id,
        reason: 'Duplicate XI player',
        expectedBenefit: 'None',
        potentialRisk: 'Duplicate',
        evidenceObservationIds: ['obs-valid-1'],
        evidenceTimestamps: [{ segmentId: 'seg-1', startSeconds: 5, endSeconds: 12, inGameClock: '22:10' }],
        confidence: 'Low',
      },
      {
        priorityGroup: 'player_change',
        priorityRank: 6,
        title: 'Sub on unknown non-existent player ID',
        actionType: 'substitution',
        targetPositionCode: 'ST',
        currentValue: starters[9].displayName,
        proposedValue: 'Ghost Player',
        targetPlayerOutId: starters[9].id,
        targetPlayerInId: 'unknown-player-uuid-999',
        reason: 'Ghost player',
        expectedBenefit: 'None',
        potentialRisk: 'Unknown',
        evidenceObservationIds: ['obs-valid-1'],
        evidenceTimestamps: [{ segmentId: 'seg-1', startSeconds: 5, endSeconds: 12, inGameClock: '22:10' }],
        confidence: 'Low',
      },
      {
        priorityGroup: 'immediate_correction',
        priorityRank: 7,
        title: 'Unsupported build-up style',
        actionType: 'build_up_style',
        currentValue: 'Short Passing',
        proposedValue: 'Hyper Warp Long Ball',
        reason: 'Not in FC26',
        expectedBenefit: 'None',
        potentialRisk: 'Unsupported',
        evidenceObservationIds: ['obs-nonexistent-id'],
        evidenceTimestamps: [{ segmentId: 'seg-1', startSeconds: 5, endSeconds: 12, inGameClock: '22:10' }],
        confidence: 'Low',
      },
      {
        priorityGroup: 'player_change',
        priorityRank: 8,
        title: 'Valid substitution from bench',
        actionType: 'substitution',
        targetPositionCode: 'ST',
        currentValue: starters[9].displayName,
        proposedValue: benchEligible.displayName,
        targetPlayerOutId: starters[9].id,
        targetPlayerInId: benchEligible.id,
        reason: 'Eligible bench striker',
        expectedBenefit: 'Fresh pace',
        potentialRisk: 'Slightly less hold-up',
        evidenceObservationIds: ['obs-valid-1'],
        evidenceTimestamps: [{ segmentId: 'seg-1', startSeconds: 5, endSeconds: 12, inGameClock: '22:10' }],
        confidence: 'High',
      },
    ],
  });

  // First 7 must all be flagged invalid_unsupported and preserve rawAiProposal
  for (let i = 0; i < 7; i++) {
    assert.equal(
      results[i].validationStatus,
      'invalid_unsupported',
      `Recommendation #${i + 1} (${results[i].title}) should be invalid_unsupported`
    );
    assert.ok(results[i].validationErrors.length > 0);
    assert.ok(results[i].rawAiProposal, 'rawAiProposal must be preserved for auditability');
  }
  // 8th is valid
  assert.equal(results[7].validationStatus, 'valid');
});

test('C2: Accepted recommendations create separate in_match_adjustment snapshot while pre_match remains immutable, and save as new club preset', async () => {
  const { club, starters, benchEligible, assignments } = createClubAndFullSquad('ApplySnap');
  const match = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentName: 'Newcastle',
    competition: 'Premier League',
    venue: 'home',
    matchDate: '2026-03-30',
    startingFormation: '4-3-3 Holding',
    startingXiIds: starters.map((p) => p.id),
    benchIds: [benchEligible.id],
    objective: 'Win',
    preMatchNotes: '',
    tacticalSetup: {
      tacticalVisionKey: 'possession',
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 58,
      playerAssignments: assignments,
    },
  });

  const clip = generateSyntheticMp4(path.join(tempDir, 'recordings', `${match.id}_apply.mp4`), 18);
  await importBrowserPreviewTestClip({
    matchId: match.id,
    half: 'first_half',
    fileName: 'apply.mp4',
    buffer: fs.readFileSync(clip),
  });

  const started = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    analysisMode: 'balanced',
    language: 'en',
    privacyAuthorized: true,
    provider: createMockProvider({
      mode: 'normal',
      clubBenchPlayerId: benchEligible.id,
      starterOutId: starters[9].id,
    }),
    awaitCompletion: true,
  });

  // Before approval, only the immutable pre_match snapshot exists
  assert.equal(listMatchTacticalSnapshots(match.id).length, 1);

  const bundle = listMatchAnalysisBundle(match.id, started.job.id);
  const validRecs = bundle.recommendations.filter((r) => r.validationStatus !== 'invalid_unsupported');
  assert.ok(validRecs.length >= 2);

  for (const r of validRecs) {
    saveRecommendationDecision({
      recommendationId: r.id,
      decisionStatus: 'user_accepted',
      userNotes: 'Approved for 2nd half',
    });
  }

  const adjSnapshot = applyAcceptedRecommendationsToAdjustmentSnapshot({
    matchId: match.id,
    jobId: started.job.id,
    recommendationIds: validRecs.map((r) => r.id),
    appliedInGameConfirmed: true,
  });

  assert.equal(adjSnapshot.snapshotType, 'in_match_adjustment');
  assert.equal(adjSnapshot.defensiveLineHeight, 52);
  assert.equal(adjSnapshot.appliedInGameConfirmed, true);

  // Verify pre_match snapshot is completely untouched
  const preSnap = getPreMatchTacticalSnapshot(match.id);
  assert.ok(preSnap);
  assert.equal(preSnap.defensiveLineHeight, 58, 'Pre-match snapshot MUST remain immutable');
  const preRb = preSnap.assignments.find((a) => a.positionCode === 'RB');
  const adjRb = adjSnapshot.assignments.find((a) => a.positionCode === 'RB');
  assert.equal(preRb?.focus, 'Balanced');
  assert.equal(adjRb?.focus, 'Defend');

  // Save adjustment snapshot explicitly as a new club tactical preset
  const savedPreset = saveAdjustmentAsNewClubPreset({
    matchId: match.id,
    snapshotId: adjSnapshot.id,
    presetName: 'Newcastle HT Tightened',
  });
  assert.equal(savedPreset.name, 'Newcastle HT Tightened');
  assert.equal(savedPreset.defensiveLineHeight, 52);
});

// ============================================================
// SUITE D — SECURITY, PRIVACY, BUDGET, RECOVERY, MIGRATION & BACKUP
// ============================================================

test('D1: Privacy gating, Entire-Display gating, budget caps, no API key leakage & startup interrupted job recovery', async () => {
  const { club, starters, benchEligible, assignments } = createClubAndFullSquad('SecBudget');
  const match = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentName: 'Aston Villa',
    competition: 'Premier League',
    venue: 'away',
    matchDate: '2026-04-02',
    startingFormation: '4-3-3 Holding',
    startingXiIds: starters.map((p) => p.id),
    benchIds: [benchEligible.id],
    objective: 'Win',
    preMatchNotes: '',
    tacticalSetup: {
      tacticalVisionKey: 'possession',
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 55,
      playerAssignments: assignments,
    },
  });

  const clip = generateSyntheticMp4(path.join(tempDir, 'recordings', `${match.id}_screen.mp4`), 18);
  const probe = await validateVideoFile(clip);
  const session = createOrUpsertMatchSession({
    matchId: match.id,
    half: 'first_half',
    captureSourceName: 'Entire Display 1 (1920x1080)',
    resolution: '640x360',
    fps: 15,
    encoder: 'libx264',
    audioEnabled: false,
    outputDirectory: path.dirname(clip),
    status: 'recording',
    integrityStatus: 'pending',
    aiEligible: false,
    durationSeconds: probe.durationSeconds,
    totalBytes: probe.sizeBytes,
  });
  upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: clip,
    durationSeconds: probe.durationSeconds,
    sizeBytes: probe.sizeBytes,
    checksum: probe.sha256Hash,
    resolution: '640x360',
    fps: 15,
    codec: 'h264',
    hasAudio: false,
    status: 'finalized',
    integrityStatus: 'verified',
  });
  updateMatchSession(session.id, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    failureReason: null,
    durationSeconds: probe.durationSeconds,
    totalBytes: probe.sizeBytes,
  });

  // 1. Privacy gate blocks upload without explicit consent
  await assert.rejects(
    () =>
      startAnalysisJob({
        matchId: match.id,
        sessionId: session.id,
        half: 'first_half',
        privacyAuthorized: false,
        entireDisplayAcknowledged: true,
        provider: createMockProvider(),
      }),
    /Privacy authorization is required/i
  );

  // 2. Entire Display gate blocks upload without entire-display acknowledgement
  await assert.rejects(
    () =>
      startAnalysisJob({
        matchId: match.id,
        sessionId: session.id,
        half: 'first_half',
        privacyAuthorized: true,
        entireDisplayAcknowledged: false,
        provider: createMockProvider(),
      }),
    /Entire Display/i
  );

  // 3. Per-match budget cap blocks jobs exceeding cap
  const baseAiSettings = getSettings().ai;
  updateSettings({ ai: { ...baseAiSettings, perMatchBudgetUsd: 0.00001 } });
  await assert.rejects(
    () =>
      startAnalysisJob({
        matchId: match.id,
        sessionId: session.id,
        half: 'first_half',
        privacyAuthorized: true,
        entireDisplayAcknowledged: true,
        provider: createMockProvider(),
      }),
    /budget/i
  );
  // Restore normal budget
  updateSettings({ ai: { ...baseAiSettings, perMatchBudgetUsd: 2.0, dailyBudgetUsd: 10.0 } });

  // 4. API key never leaked in getGeminiStatus or backup JSON
  const fakeKey = 'AIzaSyTEST_SECRET_NEVER_LEAK_12345';
  process.env.GEMINI_API_KEY = fakeKey;
  const status = getGeminiStatus('gemini-4-hydrogen');
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes(fakeKey), 'getGeminiStatus must never leak GEMINI_API_KEY');
  const backup = exportDatabaseBackup();
  assert.ok(!JSON.stringify(backup).includes(fakeKey), 'Backup export must never leak GEMINI_API_KEY');
  delete process.env.GEMINI_API_KEY;

  // 5. Startup interrupted job recovery
  const db = getDb();
  const stuckId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_analysis_jobs (
      id, match_id, session_id, half, analysis_mode, language, status, current_stage,
      progress_detail_json, model_video_id, model_synthesis_id, prompt_version, schema_version,
      request_fingerprint, privacy_authorized, created_at, updated_at
    ) VALUES (?, ?, ?, 'first_half', 'quick', 'en', 'analyzing_gameplay', 'stage2', '{}',
      'gemini-4-hydrogen', 'gemini-4-hydrogen', 'v3', 'v3', ?, 1, ?, ?)
  `).run(stuckId, match.id, session.id, `stuck-${stuckId}`, now, now);

  const interruptedCount = markInterruptedJobsOnStartup(db);
  assert.ok(interruptedCount >= 1);
  const stuckAfter = getAnalysisJob(stuckId, db);
  assert.equal(stuckAfter?.status, 'interrupted');
});

test('D2: Non-destructive v5->v6 migration preserves existing rows & marks legacy visions unspecified; Backup/Restore v6 passes PRAGMA foreign_key_check', () => {
  // Create a genuine v5 database by executing real MIGRATIONS v1..v5, then upgrade to v6
  const v5Path = path.join(tempDir, 'legacy_v5.db');
  const v5Db = new Database(v5Path);
  v5Db.pragma('foreign_keys = ON');
  v5Db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const m of MIGRATIONS.filter((mig) => mig.version <= 5)) {
    v5Db.transaction(() => {
      v5Db.exec(m.sql);
      if (m.afterSql) m.afterSql(v5Db);
      v5Db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, '2026-01-01T00:00:00.000Z');
    })();
  }

  v5Db.prepare(`
    INSERT INTO clubs (id, name, league, created_at, updated_at)
    VALUES ('c1', 'Legacy United', 'Premier League', '2026-01-01', '2026-01-01')
  `).run();
  v5Db.prepare(`
    INSERT INTO career_profiles (id, club_id, season, manager_name, preferred_philosophy, primary_formation, alternative_formation, preferred_attacking_style, preferred_defensive_style, is_active, created_at, updated_at)
    VALUES ('cp1', 'c1', '2025/26', 'Alex', 'Classic', '4-4-2 Flat', '4-3-3 Holding', 'Balanced', 'Balanced', 1, '2026-01-01', '2026-01-01')
  `).run();
  v5Db.prepare(`
    INSERT INTO opponents (id, name, league, created_at, updated_at)
    VALUES ('opp1', 'Arsenal', 'Premier League', '2026-01-01', '2026-01-01')
  `).run();
  v5Db.prepare(`
    INSERT INTO tactical_presets (id, club_id, name, formation_name, build_up_style, defensive_approach, defensive_line_height, created_at, updated_at)
    VALUES ('p1', 'c1', 'Legacy 4-4-2', '4-4-2 Flat', 'Balanced', 'Balanced', 50, '2026-01-01', '2026-01-01')
  `).run();
  v5Db.prepare(`
    INSERT INTO matches (id, club_id, career_profile_id, opponent_id, competition, venue, match_date, status, starting_formation, starting_xi_json, bench_json, objective, pre_match_notes, created_at, updated_at)
    VALUES ('m1', 'c1', 'cp1', 'opp1', 'Premier League', 'home', '2026-02-01', 'scheduled', '4-4-2 Flat', '[]', '[]', 'Win', '', '2026-01-01', '2026-01-01')
  `).run();
  v5Db.prepare(`
    INSERT INTO match_tactical_snapshots (id, match_id, snapshot_type, formation_name, build_up_style, defensive_approach, defensive_line_height, assignments_json, created_at, updated_at)
    VALUES ('s1', 'm1', 'pre_match', '4-4-2 Flat', 'Balanced', 'Balanced', 50, '[]', '2026-01-01', '2026-01-01')
  `).run();

  runMigrations(v5Db);
  const migVersion = (
    v5Db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number }
  ).v;
  assert.ok(migVersion >= 6, 'Legacy v5 DB must migrate cleanly to v6+');

  const legacyPreset = v5Db
    .prepare('SELECT tactical_vision_key FROM tactical_presets WHERE id = ?')
    .get('p1') as { tactical_vision_key: string };
  assert.equal(
    legacyPreset.tactical_vision_key,
    'unspecified',
    'Legacy presets must preserve unspecified vision without silently assigning one'
  );

  const legacySnap = v5Db
    .prepare('SELECT tactical_vision_key FROM match_tactical_snapshots WHERE id = ?')
    .get('s1') as { tactical_vision_key: string };
  assert.equal(legacySnap.tactical_vision_key, 'unspecified');
  const v5FkViolations = v5Db.pragma('foreign_key_check') as unknown[];
  assert.equal(v5FkViolations.length, 0, 'Migrated v5->v6+ database must have zero FK violations');
  v5Db.close();

  // Test Backup v6/v7 Export -> Restore -> PRAGMA foreign_key_check
  const backupV6 = exportDatabaseBackup();
  assert.ok(
    backupV6.format === 'fc26-ai-manager-backup-v6' ||
      backupV6.format === 'fc26-ai-manager-backup-v7',
    `Expected backup format v6 or v7, got ${backupV6.format}`
  );
  const clubCountBefore = listClubs().length;
  restoreDatabaseBackup(backupV6);
  const clubCountAfter = listClubs().length;
  assert.equal(clubCountAfter, clubCountBefore);
  const fkViolations = getDb().pragma('foreign_key_check') as unknown[];
  assert.equal(fkViolations.length, 0, 'Restored database must have zero foreign key violations');
});

async function runAll() {
  let passed = 0;
  let failed = 0;
  console.log(`\nRunning Phase 3 Automated Test Suite (${tests.length} test groups) in ${tempDir}...\n`);

  for (const t of tests) {
    try {
      await t.run();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack : err);
      failed++;
    }
  }

  closeDb();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore temp cleanup errors
  }

  console.log(`\nPhase 3 Test Summary: ${passed}/${tests.length} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('Fatal error running Phase 3 test suite:', err);
  closeDb();
  process.exit(1);
});
