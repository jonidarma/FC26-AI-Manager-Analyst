/**
 * Phase 3.0.1 Automated Regression & Acceptance Test Suite (35 Scenarios)
 *
 * Strictly isolated in an OS temp directory — NEVER modifies /data/fc26_manager.db
 * or any real user recordings.
 *
 * Uses real FFmpeg/FFprobe binaries for MP4 generation, FFprobe verification, and evidence frame
 * extraction; real filesystem symlinks for escape-prevention testing; explicitly labeled
 * cross-platform Windows path simulation; and a deterministic mock GeminiVideoProvider
 * (no live Gemini API network calls).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Isolate packaged-Electron-style userData layout BEFORE importing server modules:
//   <appRoot>/database/fc26_manager.db   (FC26_USER_DATA_DIR)
//   <appRoot>/recordings/...             (FC26_RECORDINGS_DIR)
//   <appRoot>/<Club>-Career-Mode/...     (FC26_APP_USER_DATA_ROOT)
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc26-phase301-test-'));
const appUserDataRoot = path.join(sandboxRoot, 'fc26-ai-manager');
const dbDataDir = path.join(appUserDataRoot, 'database');
const legacyRecordingsRoot = path.join(appUserDataRoot, 'recordings');
const outsideRoot = path.join(sandboxRoot, 'outside-untrusted');

fs.mkdirSync(dbDataDir, { recursive: true });
fs.mkdirSync(legacyRecordingsRoot, { recursive: true });
fs.mkdirSync(outsideRoot, { recursive: true });

process.env.FC26_APP_USER_DATA_ROOT = appUserDataRoot;
process.env.FC26_USER_DATA_DIR = dbDataDir;
process.env.FC26_RECORDINGS_DIR = legacyRecordingsRoot;
delete process.env.GEMINI_API_KEY;

import { CaptureSessionEngine } from '../../electron/captureEngine.ts';
import {
  buildCareerFolderName,
  buildMatchFolderName,
  buildStructuredSegmentFileName,
  canonicalizeAndContainPath,
  isMediaPathError,
  isPathWithinRoot,
  normalizePathForComparison,
  parsePartOrSegmentIndexFromFileName,
  sanitizeWindowsSegment,
  scrubSecretsFromMetadata,
  validateInGameMatchDate,
  WINDOWS_SAFE_MAX_PATH,
} from '../../shared/recordingStorage.ts';
import { closeDb, getDb, resolveDatabaseLocation } from '../../server/db/database.ts';
import { MIGRATIONS, runMigrations } from '../../server/db/migrations.ts';
import { startAnalysisJob, getAnalysisJob } from '../../server/services/aiAnalysisOrchestrator.ts';
import type {
  GeminiVideoProvider,
  RemoteUploadedVideo,
  SecondHalfComparisonOutput,
  TacticalSynthesisOutput,
  VideoClassificationOutput,
  VideoObservationOutput,
} from '../../server/services/geminiVideoService.ts';
import {
  buildMatchStoragePlan,
  exportDiagnosticsArtifactJson,
  getMatchStorageFoldersInfo,
  getStorageOverviewInfo,
  previewMatchStoragePlan,
  resolveActiveFormationForHalf,
  resolveRecordingSegmentMediaPath,
  resolveTrustedFolderPath,
  writeMatchMetadataManifest,
} from '../../server/services/recordingMediaResolver.ts';
import {
  createClub,
  createMatch,
  createOpponent,
  createOrUpsertMatchSession,
  createPlayer,
  listMatchTacticalSnapshots,
  updateMatchSession,
  upsertRecordingSegment,
} from '../../server/services/repository.ts';
import {
  resolveEvidenceFrameFilePath,
  resolveServerFfmpegBinaries,
} from '../../server/services/videoPreprocessingService.ts';

interface TestCase {
  name: string;
  run: () => Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void) {
  tests.push({ name, run });
}

let cachedSampleMp4: string | null = null;

function ensureSampleMp4(): string {
  if (cachedSampleMp4 && fs.existsSync(cachedSampleMp4)) {
    return cachedSampleMp4;
  }
  const bins = resolveServerFfmpegBinaries();
  assert.ok(bins.ffmpegPath, 'FFmpeg binary must be available for Phase 3.0.1 real-MP4 tests');
  const out = path.join(sandboxRoot, '_sample_18s.mp4');
  execFileSync(
    bins.ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=18:size=640x360:rate=15',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: 'pipe' }
  );
  cachedSampleMp4 = out;
  return out;
}

function copySampleMp4(destPath: string): { path: string; sizeBytes: number; sha256: string } {
  const src = ensureSampleMp4();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(src, destPath);
  const buf = fs.readFileSync(destPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { path: destPath, sizeBytes: buf.length, sha256 };
}

function createFixtureClubAndMatch(opts: {
  clubName: string;
  opponentName: string;
  competition: string;
  matchDate: string;
  formation?: string;
  season?: string;
}) {
  const formation = opts.formation ?? '4-2-3-1 Wide';
  const club = createClub({
    name: opts.clubName,
    league: opts.competition,
    nation: 'England',
    season: opts.season ?? '2027/28',
    managerName: 'Coach Joni',
    preferredPhilosophy: 'Structured positional play',
    primaryFormation: formation,
    alternativeFormation: '4-3-3 Holding',
    preferredAttackingStyle: 'Short Passing',
    preferredDefensiveStyle: 'Balanced',
    primaryTacticalVisionKey: 'possession',
    alternativeTacticalVisionKey: 'wing_play',
    preferredBuildUpStyle: 'Short Passing',
    preferredDefensiveApproach: 'Balanced',
    preferredDefensiveLineHeight: 55,
    tacticalFlexibility: 'balanced',
    setActive: true,
  });

  const positions = ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'LM', 'CAM', 'RM', 'ST'];
  const roles: Array<[string, string]> = [
    ['Goalkeeper', 'Defend'],
    ['Fullback', 'Defend'],
    ['Defender', 'Defend'],
    ['Ball-Playing Defender', 'Defend'],
    ['Fullback', 'Balanced'],
    ['Holding', 'Defend'],
    ['Deep-Lying Playmaker', 'Build-Up'],
    ['Inside Forward', 'Balanced'],
    ['Playmaker', 'Balanced'],
    ['Winger', 'Balanced'],
    ['Advanced Forward', 'Attack'],
  ];

  const starters = positions.map((pos, idx) =>
    createPlayer({
      clubId: club.id,
      name: `${opts.clubName} XI ${idx + 1}`,
      position: pos,
      squadNumber: idx + 1,
      overallRating: 82,
      preferredFoot: 'Right',
      playerRole: roles[idx][0],
      playerFocus: roles[idx][1],
      strengths: 'Composure',
      weaknesses: 'None',
      preferredInstructions: '',
      squadStatus: 'active',
      availability: 'available',
    })
  );

  const opp = createOpponent({
    name: opts.opponentName,
    league: opts.competition,
    typicalFormation: '4-4-2 Flat',
    strengths: 'Transitions',
    weaknesses: 'Wide channels',
    dangerousChannels: 'Right flank',
    notes: 'Compact mid-block',
  });

  const playerAssignments = starters.map((p, idx) => ({
    slotIndex: idx,
    slotId: `slot_${idx + 1}`,
    positionCode: positions[idx],
    playerId: p.id,
    playerName: p.displayName,
    role: roles[idx][0],
    focus: roles[idx][1],
  }));

  const match = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentId: opp.id,
    competition: opts.competition,
    venue: 'home',
    matchDate: opts.matchDate,
    startingFormation: formation,
    startingXiIds: starters.map((p) => p.id),
    benchIds: [],
    objective: 'Win match',
    tacticalSetup: {
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 55,
      tacticalVisionKey: 'possession',
      playerAssignments,
    },
    preMatchNotes: 'Phase 3.0.1 automated fixture',
  });

  return { club, opp, match, starters, playerAssignments };
}

function createTestSession(
  input: Omit<Parameters<typeof createOrUpsertMatchSession>[0], 'status' | 'resolution' | 'fps'> & {
    status?: Parameters<typeof createOrUpsertMatchSession>[0]['status'];
    resolution?: string;
    fps?: number;
  }
) {
  return createOrUpsertMatchSession({
    status: 'completed',
    resolution: '640x360',
    fps: 15,
    audioEnabled: false,
    ...input,
  });
}

function createMockGeminiProvider(): GeminiVideoProvider {
  return {
    isMock: true,
    async uploadAndAwaitActive(input): Promise<RemoteUploadedVideo> {
      if (input.isCancelled()) {
        throw new Error('Cancelled');
      }
      return {
        remoteFileName: `files/mock-${crypto.randomUUID().slice(0, 8)}`,
        remoteFileUri: `https://generativelanguage.googleapis.com/v1beta/files/mock-${crypto.randomUUID().slice(0, 8)}`,
        remoteState: 'ACTIVE',
        uploadMs: 5,
        mediaProcessingMs: 5,
      };
    },
    async deleteRemoteFile() {
      return { deleted: true, error: null };
    },
    async classifyVideoSegment(): Promise<VideoClassificationOutput> {
      return {
        segments: [
          {
            startSeconds: 0,
            endSeconds: 16,
            contentType: 'live_gameplay',
            confidence: 'High',
            evidenceDescription: 'Broadcast gameplay camera active.',
            inGameClock: '28:15',
          },
        ],
        readableHudStats: {
          scoreline: '1 - 0',
          matchClock: '45:00',
          possessionLabel: null,
          shotsLabel: null,
          otherVerifiedStats: [],
        },
        usage: {
          modelId: 'gemini-3.1-flash-lite',
          inputTokens: 450,
          outputTokens: 150,
          estimatedCostUsd: 0.0007,
          durationMs: 12,
        },
      };
    },
    async extractGameplayObservations(): Promise<VideoObservationOutput> {
      return {
        observations: [
          {
            startSeconds: 4.0,
            endSeconds: 7.5,
            inGameClock: '28:22',
            categoryGroup: 'defensive',
            category: 'wide_channel_exposure',
            teamAttribution: 'user_team',
            playerAttribution: 'Unknown',
            description: 'Right flank space opened during transition.',
            supportingVisualEvidence: 'Visible channel gap behind right fullback.',
            evidenceType: 'directly_observed',
            confidence: 'High',
            severity: 'High',
            limitations: 'Synthetic clip test.',
            isFromReplay: false,
          },
        ],
        usage: {
          modelId: 'gemini-3.1-flash-lite',
          inputTokens: 900,
          outputTokens: 240,
          estimatedCostUsd: 0.0018,
          durationMs: 18,
        },
      };
    },
    async synthesizeTacticalBriefing(input): Promise<TacticalSynthesisOutput> {
      const firstObsId = input.observations[0]?.id ?? 'obs-1';
      return {
        evidenceQuality: 'moderate',
        managerVerdict: {
          whatIsWorking: ['Compact central midfield build-up.'],
          whatIsNotWorking: ['Space behind right flank on transitions.'],
          whyTacticStruggling: 'Right fullback pushed high without cover.',
          firstPriorityChange: 'Set RB Fullback focus to Defend.',
          conciseSummary: 'Solid control; protect right flank transition space.',
        },
        gameplayCoaching: [
          {
            instruction: 'Hold central defensive shape on turnover.',
            triggerSituation: 'Possession lost in midfield',
            evidenceNote: 'Observed at 28:22.',
          },
        ],
        contingencyPlan: [
          {
            scenario: 'If protecting a 1-goal lead',
            trigger: 'After 70th minute',
            tacticalAction: 'Drop defensive line height to 46.',
          },
        ],
        limitations: ['Mock provider synthetic clip test.'],
        visionAssessment: {
          observedPlayingStyle: {
            primaryTendency: 'Short passing positional build-up',
            mixedTendencies: ['Possession'],
            evidenceSummary: 'Controlled midfield triangles.',
            isInsufficientEvidence: false,
          },
          recommendedVisionKey: 'retain_current',
          recommendationStance: 'retain_and_refine',
          recommendationRationale: 'Keep Possession vision and refine RB rest defense.',
          executionAssessmentLabel: 'Aligned — Minor Rest-Defense Adjustment Needed',
          internalAssessmentScore: 78,
          scoreMethodologyNote: 'Internal heuristic index.',
          criteriaBreakdown: [
            {
              criterion: 'Short build-up lanes',
              assessment: 'strong',
              evidenceNote: 'Clean central progression.',
            },
          ],
          confidence: 'Medium',
          limitations: 'Synthetic test footage.',
        },
        recommendations: [
          {
            priorityGroup: 'immediate_correction',
            priorityRank: 1,
            title: 'Switch RB Fullback Focus to Defend',
            actionType: 'player_focus',
            targetSlotId: 'slot_5',
            targetPositionCode: 'RB',
            currentValue: 'Balanced',
            proposedValue: 'Defend',
            reason: 'Closes transition space behind right flank.',
            expectedBenefit: 'Better counter-attack prevention.',
            potentialRisk: 'Slightly less overlap.',
            evidenceObservationIds: [firstObsId],
            evidenceTimestamps: [
              {
                segmentId: input.observations[0]?.segmentId ?? null,
                startSeconds: 4.0,
                endSeconds: 7.5,
                inGameClock: '28:22',
              },
            ],
            confidence: 'High',
          },
        ],
        usage: {
          modelId: 'gemini-3.1-flash-lite',
          inputTokens: 1200,
          outputTokens: 500,
          estimatedCostUsd: 0.0029,
          durationMs: 22,
        },
      };
    },
    async synthesizeSecondHalfComparison(): Promise<SecondHalfComparisonOutput> {
      return {
        summary: 'Second half showed improved right-flank rest defense.',
        appliedAdjustmentsReviewed: [
          {
            recommendationTitle: 'Switch RB Fullback Focus to Defend',
            userConfirmedAppliedInGame: true,
            observedSecondHalfPattern: 'Fewer right-flank counter openings.',
            outcomeAssessment: 'improved',
            causationCaveat: 'Correlation observed; opponent shifts may contribute.',
          },
        ],
        attackingComparison: 'Maintained central progression.',
        defensiveComparison: 'Reduced wide channel exposure.',
        tacticalVisionComparison: 'Remained consistent with Possession.',
        recurringWeaknesses: ['Occasional slow midfield recovery.'],
        limitations: ['Mock provider synthetic clip comparison.'],
        usage: {
          modelId: 'gemini-3.1-flash-lite',
          inputTokens: 900,
          outputTokens: 300,
          estimatedCostUsd: 0.0019,
          durationMs: 18,
        },
      };
    },
  };
}

// ============================================================
// SECTION A — CANONICAL MEDIA PATH RESOLUTION (Tests 1–9)
// ============================================================

test('01. Legacy v1 absolute path inside userData/recordings/{matchId}/{sessionId}/segment_001.mp4 resolves cleanly', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Fulham',
    competition: 'Premier League',
    matchDate: '2027-08-22',
  });
  const sessionId = `sess-v1-abs-${crypto.randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(legacyRecordingsRoot, match.id, sessionId);
  const segAbs = path.join(sessionDir, 'segment_001.mp4');
  const file = copySampleMp4(segAbs);

  const session = createTestSession({
    id: sessionId,
    matchId: match.id,
    half: 'first_half',
    outputDirectory: sessionDir,
    storageLayoutVersion: 1,
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
  });
  const seg = upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: segAbs,
    durationSeconds: 18,
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });

  const resolved = resolveRecordingSegmentMediaPath({
    matchId: match.id,
    expectedHalf: 'first_half',
    session,
    segment: seg,
  });
  assert.equal(resolved.resolvedPath, fs.realpathSync(segAbs));
  assert.equal(resolved.resolutionStrategy, 'absolute_direct');
  assert.equal(resolved.storageLayoutVersion, 1);
});

test('02. Legacy v1 relative path ("segment_001.mp4") resolves against session dir even when process.cwd() shifts', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Crystal Palace',
    competition: 'Premier League',
    matchDate: '2027-08-29',
  });
  const sessionId = `sess-v1-rel-${crypto.randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(legacyRecordingsRoot, match.id, sessionId);
  const segAbs = path.join(sessionDir, 'segment_001.mp4');
  const file = copySampleMp4(segAbs);

  const session = createTestSession({
    id: sessionId,
    matchId: match.id,
    half: 'first_half',
    outputDirectory: sessionDir,
    storageLayoutVersion: 1,
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
  });
  const seg = upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    // Exact production bug condition: relative filename only!
    filePath: 'segment_001.mp4',
    durationSeconds: 18,
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });

  const prevCwd = process.cwd();
  try {
    process.chdir(outsideRoot);
    const resolved = resolveRecordingSegmentMediaPath({
      matchId: match.id,
      expectedHalf: 'first_half',
      session,
      segment: seg,
    });
    assert.equal(resolved.resolvedPath, fs.realpathSync(segAbs));
    assert.ok(
      resolved.resolutionStrategy === 'session_directory_relative' ||
        resolved.resolutionStrategy === 'output_directory_relative'
    );
  } finally {
    process.chdir(prevCwd);
  }
});

test('03. Structured v2 relative_media_path and absolute path both resolve deterministically', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Sunderland',
    competition: 'Premier League',
    matchDate: '2027-09-11',
  });
  const plan = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const segAbs = path.join(plan.sessionDirectoryAbs, plan.examplePart1FileName);
  const file = copySampleMp4(segAbs);
  const relMedia = `${plan.sessionDirectoryRel}/${plan.examplePart1FileName}`;

  const session = createTestSession({
    matchId: match.id,
    half: 'first_half',
    outputDirectory: plan.sessionDirectoryAbs,
    storageLayoutVersion: 2,
    careerDirectory: plan.careerDirectoryRel,
    matchDirectory: plan.matchDirectoryRel,
    sessionDirectory: plan.sessionDirectoryRel,
    recordedFormationName: plan.namingMetadata.formationName,
    tacticalSnapshotId: plan.namingMetadata.tacticalSnapshotId,
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
  });

  const seg = upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: segAbs,
    relativeMediaPath: relMedia,
    originalFileName: '.fc26_seg_001.mp4',
    displayFileName: plan.examplePart1FileName,
    durationSeconds: 18,
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });

  const resolvedRel = resolveRecordingSegmentMediaPath({
    matchId: match.id,
    expectedHalf: 'first_half',
    session,
    segment: seg,
  });
  assert.equal(resolvedRel.resolvedPath, fs.realpathSync(segAbs));
  assert.equal(resolvedRel.resolutionStrategy, 'relative_media_path');
  assert.equal(resolvedRel.storageLayoutVersion, 2);

  // Also test resolving without relativeMediaPath via absolute path
  const resolvedAbs = resolveRecordingSegmentMediaPath({
    matchId: match.id,
    expectedHalf: 'first_half',
    session,
    segment: { ...seg, relativeMediaPath: null },
  });
  assert.equal(resolvedAbs.resolvedPath, fs.realpathSync(segAbs));
  assert.equal(resolvedAbs.resolutionStrategy, 'absolute_direct');
});

test('04. Packaged Electron layout (database/ sibling to recordings/ under userData) resolves without touching database path', () => {
  const loc = resolveDatabaseLocation();
  assert.equal(loc.dbPath, path.join(dbDataDir, 'fc26_manager.db'));
  assert.equal(path.dirname(loc.dataDir), appUserDataRoot);

  const { match } = createFixtureClubAndMatch({
    clubName: 'Arsenal',
    opponentName: 'Everton',
    competition: 'Premier League',
    matchDate: '2027-09-18',
  });
  const sessionId = `sess-pkg-${crypto.randomUUID().slice(0, 8)}`;
  const segAbs = path.join(legacyRecordingsRoot, match.id, sessionId, 'segment_001.mp4');
  const file = copySampleMp4(segAbs);

  // Even when outputDirectory is empty/null, legacyRecordingsRoot fallback resolves cleanly
  const session = createTestSession({
    id: sessionId,
    matchId: match.id,
    half: 'first_half',
    outputDirectory: null,
    storageLayoutVersion: 1,
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
  });
  const seg = upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: 'segment_001.mp4',
    durationSeconds: 18,
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });

  const resolved = resolveRecordingSegmentMediaPath({
    matchId: match.id,
    expectedHalf: 'first_half',
    session,
    segment: seg,
  });
  assert.equal(resolved.resolvedPath, fs.realpathSync(segAbs));
  assert.equal(resolved.resolutionStrategy, 'legacy_recordings_root_relative');
});

test('05. Unicode club names, spaces, parentheses, and hyphens resolve cleanly on disk', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Bayern München',
    opponentName: 'Atlético Madrid',
    competition: 'UCL',
    matchDate: '2027-10-19',
    formation: '4-2-3-1 Wide',
  });
  const plan = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  assert.ok(plan.careerDirectoryName.includes('Bayern-München-Career-Mode'));
  assert.ok(plan.matchDirectoryName.includes('Bayern-München-vs-Atlético-Madrid'));
  assert.ok(plan.examplePart1FileName.includes('Bayern München'));
  assert.ok(plan.examplePart1FileName.includes('Atlético'));

  const segAbs = path.join(plan.sessionDirectoryAbs, plan.examplePart1FileName);
  const file = copySampleMp4(segAbs);

  const session = createTestSession({
    matchId: match.id,
    half: 'first_half',
    outputDirectory: plan.sessionDirectoryAbs,
    storageLayoutVersion: 2,
    careerDirectory: plan.careerDirectoryRel,
    matchDirectory: plan.matchDirectoryRel,
    sessionDirectory: plan.sessionDirectoryRel,
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
  });
  const seg = upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: segAbs,
    relativeMediaPath: `${plan.sessionDirectoryRel}/${plan.examplePart1FileName}`,
    displayFileName: plan.examplePart1FileName,
    durationSeconds: 18,
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });

  const resolved = resolveRecordingSegmentMediaPath({
    matchId: match.id,
    expectedHalf: 'first_half',
    session,
    segment: seg,
  });
  assert.equal(resolved.resolvedPath, fs.realpathSync(segAbs));
});

test('06. Path traversal (../, ..\\, null byte) is rejected with MEDIA_PATH_SECURITY_VIOLATION', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Brighton',
    competition: 'Premier League',
    matchDate: '2027-09-25',
  });
  const session = createTestSession({
    matchId: match.id,
    half: 'first_half',
    outputDirectory: path.join(legacyRecordingsRoot, match.id, 'sess-trav'),
    storageLayoutVersion: 1,
  });

  const maliciousPaths = [
    '../../../etc/passwd',
    '..\\..\\outside-untrusted\\secret.mp4',
    'segment_001.mp4\0.txt',
    path.join(outsideRoot, 'secret.mp4'),
  ];

  for (const badPath of maliciousPaths) {
    assert.throws(
      () =>
        resolveRecordingSegmentMediaPath({
          matchId: match.id,
          expectedHalf: 'first_half',
          session,
          segment: {
            id: 'seg-bad',
            sessionId: session.id,
            matchId: match.id,
            segmentIndex: 1,
            filePath: badPath,
            relativeMediaPath: null,
            originalFileName: null,
            displayFileName: null,
          },
        }),
      (err) => isMediaPathError(err) && err.code === 'MEDIA_PATH_SECURITY_VIOLATION'
    );
  }
});

test('07. Symlink escaping approved roots is rejected via fs.realpathSync with MEDIA_PATH_SECURITY_VIOLATION', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Brentford',
    competition: 'Premier League',
    matchDate: '2027-10-02',
  });
  const outsideFile = path.join(outsideRoot, 'escaped.mp4');
  copySampleMp4(outsideFile);

  const sessionId = `sess-sym-${crypto.randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(legacyRecordingsRoot, match.id, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const symlinkPath = path.join(sessionDir, 'segment_001.mp4');
  fs.symlinkSync(outsideFile, symlinkPath);

  const session = createTestSession({
    id: sessionId,
    matchId: match.id,
    half: 'first_half',
    outputDirectory: sessionDir,
    storageLayoutVersion: 1,
  });

  assert.throws(
    () =>
      resolveRecordingSegmentMediaPath({
        matchId: match.id,
        expectedHalf: 'first_half',
        session,
        segment: {
          id: 'seg-sym',
          sessionId: session.id,
          matchId: match.id,
          segmentIndex: 1,
          filePath: symlinkPath,
          relativeMediaPath: null,
          originalFileName: 'segment_001.mp4',
          displayFileName: 'segment_001.mp4',
        },
      }),
    (err) => isMediaPathError(err) && err.code === 'MEDIA_PATH_SECURITY_VIOLATION'
  );
});

test('08. Missing media file inside approved root throws MEDIA_FILE_NOT_FOUND (not security error or Gemini error)', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Wolves',
    competition: 'Premier League',
    matchDate: '2027-10-09',
  });
  const sessionId = `sess-missing-${crypto.randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(legacyRecordingsRoot, match.id, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const session = createTestSession({
    id: sessionId,
    matchId: match.id,
    half: 'first_half',
    outputDirectory: sessionDir,
    storageLayoutVersion: 1,
  });

  assert.throws(
    () =>
      resolveRecordingSegmentMediaPath({
        matchId: match.id,
        expectedHalf: 'first_half',
        session,
        segment: {
          id: 'seg-missing',
          sessionId: session.id,
          matchId: match.id,
          segmentIndex: 1,
          filePath: 'segment_001.mp4',
          relativeMediaPath: null,
          originalFileName: 'segment_001.mp4',
          displayFileName: 'segment_001.mp4',
        },
      }),
    (err) => isMediaPathError(err) && err.code === 'MEDIA_FILE_NOT_FOUND'
  );
});

test('09. Cross-match / wrong-half / wrong-session segment throws RECORDING_SESSION_MISMATCH', () => {
  const { match: matchA } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Aston Villa',
    competition: 'Premier League',
    matchDate: '2027-10-16',
  });
  const { match: matchB } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Newcastle',
    competition: 'Premier League',
    matchDate: '2027-10-23',
  });

  const sessionA = createTestSession({
    matchId: matchA.id,
    half: 'first_half',
    outputDirectory: path.join(legacyRecordingsRoot, matchA.id, 'sess-a'),
    storageLayoutVersion: 1,
  });

  // Wrong matchId
  assert.throws(
    () =>
      resolveRecordingSegmentMediaPath({
        matchId: matchB.id,
        expectedHalf: 'first_half',
        session: sessionA,
        segment: {
          id: 'seg-1',
          sessionId: sessionA.id,
          matchId: matchA.id,
          segmentIndex: 1,
          filePath: 'segment_001.mp4',
          relativeMediaPath: null,
          originalFileName: null,
          displayFileName: null,
        },
      }),
    (err) => isMediaPathError(err) && err.code === 'RECORDING_SESSION_MISMATCH'
  );

  // Wrong half
  assert.throws(
    () =>
      resolveRecordingSegmentMediaPath({
        matchId: matchA.id,
        expectedHalf: 'second_half',
        session: sessionA,
        segment: {
          id: 'seg-1',
          sessionId: sessionA.id,
          matchId: matchA.id,
          segmentIndex: 1,
          filePath: 'segment_001.mp4',
          relativeMediaPath: null,
          originalFileName: null,
          displayFileName: null,
        },
      }),
    (err) => isMediaPathError(err) && err.code === 'RECORDING_SESSION_MISMATCH'
  );
});

// ============================================================
// SECTION B — STRUCTURED CAREER MODE STORAGE (Tests 10–28)
// ============================================================

test('10. Career Mode folder naming produces "{ClubName}-Career-Mode"', () => {
  assert.equal(buildCareerFolderName({ clubName: 'Chelsea' }), 'Chelsea-Career-Mode');
  assert.equal(buildCareerFolderName({ clubName: 'Real Madrid' }), 'Real-Madrid-Career-Mode');
});

test('11. Multiple Career Mode profiles for the same club receive a deterministic discriminator', () => {
  const { match: m1 } = createFixtureClubAndMatch({
    clubName: 'Liverpool',
    opponentName: 'Leeds United',
    competition: 'Premier League',
    matchDate: '2026-08-15',
    season: '2026/27',
  });
  const plan1 = buildMatchStoragePlan(m1.id, 'first_half', { allocateIfMissing: true });
  assert.equal(plan1.careerDirectoryName, 'Liverpool-Career-Mode');

  const { match: m2 } = createFixtureClubAndMatch({
    clubName: 'Liverpool',
    opponentName: 'Burnley',
    competition: 'Premier League',
    matchDate: '2028-08-19',
    season: '2028/29',
  });
  const plan2 = buildMatchStoragePlan(m2.id, 'first_half', { allocateIfMissing: true });
  assert.notEqual(plan2.careerDirectoryName, plan1.careerDirectoryName);
  assert.ok(plan2.careerDirectoryName.startsWith('Liverpool-Career-Mode ('));
});

test('12. Match folder naming produces "{UserClub}-vs-{Opponent} ({Competition}) {MatchDate}"', () => {
  const built = buildMatchFolderName({
    userClubName: 'Chelsea',
    opponentClubName: 'Sunderland',
    competitionName: 'Premier League',
    matchDate: '2027-09-11',
  });
  assert.equal(built.folderName, 'Chelsea-vs-Sunderland (Premier League) 2027-09-11');
  assert.equal(built.warnings.length, 0);
});

test('13. Duplicate match on the same in-game date appends deterministic "[Match 02]"', () => {
  const { club, opp, match: m1, starters, playerAssignments } = createFixtureClubAndMatch({
    clubName: 'Tottenham Hotspur',
    opponentName: 'West Ham',
    competition: 'FA Cup',
    matchDate: '2027-03-06',
  });
  const plan1 = buildMatchStoragePlan(m1.id, 'first_half', { allocateIfMissing: true });

  const m2 = createMatch({
    clubId: club.id,
    careerProfileId: club.profile.id,
    opponentId: opp.id,
    competition: 'FA Cup',
    venue: 'away',
    matchDate: '2027-03-06',
    startingFormation: '4-2-3-1 Wide',
    startingXiIds: starters.map((p) => p.id),
    benchIds: [],
    objective: 'Replay win',
    tacticalSetup: {
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 55,
      tacticalVisionKey: 'possession',
      playerAssignments,
    },
    preMatchNotes: 'Same-day replay fixture',
  });
  const plan2 = buildMatchStoragePlan(m2.id, 'first_half', { allocateIfMissing: true });

  assert.equal(plan1.matchDirectoryName, 'Tottenham-Hotspur-vs-West-Ham (FA Cup) 2027-03-06');
  assert.equal(plan2.matchDirectoryName, 'Tottenham-Hotspur-vs-West-Ham (FA Cup) 2027-03-06 [Match 02]');
});

test('14. First Half video filename uses pre-match formation metadata', () => {
  const fileName = buildStructuredSegmentFileName({
    userClubName: 'Chelsea',
    opponentClubName: 'Sunderland',
    competitionName: 'Premier League',
    formationName: '4-2-3-1 Wide',
    matchDate: '2027-09-11',
    partNumber: 1,
  });
  assert.equal(fileName, 'Chelsea vs Sunderland (Premier League) 4-2-3-1 Wide 2027-09-11 Part 1.mp4');
});

test('15. Second Half video filename uses confirmed in-match adjustment formation (applied_in_game_confirmed = 1)', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Sunderland',
    competition: 'Premier League',
    matchDate: '2027-11-06',
    formation: '4-2-3-1 Wide',
  });
  const db = getDb();
  const snapId = `snap-confirmed-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO match_tactical_snapshots
      (id, match_id, snapshot_type, formation_name, applied_in_game_confirmed, applied_in_game_at, created_at, updated_at)
     VALUES (?, ?, 'in_match_adjustment', '4-3-3 Holding', 1, ?, ?, ?)`
  ).run(snapId, match.id, now, now, now);

  const info = resolveActiveFormationForHalf(db, match.id, 'second_half', '4-2-3-1 Wide');
  assert.equal(info.formationName, '4-3-3 Holding');
  assert.equal(info.formationSource, 'confirmed_in_match_adjustment');
  assert.equal(info.tacticalSnapshotId, snapId);

  const plan2nd = buildMatchStoragePlan(match.id, 'second_half', { allocateIfMissing: true });
  assert.ok(plan2nd.examplePart1FileName.includes('4-3-3 Holding'));
});

test('16. Second Half ignores UNCONFIRMED AI proposal (applied_in_game_confirmed = 0) and retains pre-match formation', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Nottingham Forest',
    competition: 'Premier League',
    matchDate: '2027-11-13',
    formation: '4-2-3-1 Wide',
  });
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO match_tactical_snapshots
      (id, match_id, snapshot_type, formation_name, applied_in_game_confirmed, created_at, updated_at)
     VALUES (?, ?, 'in_match_adjustment', '3-5-2', 0, ?, ?)`
  ).run(`snap-unconf-${crypto.randomUUID().slice(0, 8)}`, match.id, now, now);

  const info = resolveActiveFormationForHalf(db, match.id, 'second_half', '4-2-3-1 Wide');
  assert.equal(info.formationName, '4-2-3-1 Wide');
  assert.equal(info.formationSource, 'fallback_pre_match_unconfirmed');

  const plan2nd = buildMatchStoragePlan(match.id, 'second_half', { allocateIfMissing: false });
  assert.ok(plan2nd.examplePart1FileName.includes('4-2-3-1 Wide'));
  assert.ok(!plan2nd.examplePart1FileName.includes('3-5-2'));
});

test('17. Multi-segment naming (Part 1, Part 2, Part 3) & parsePartOrSegmentIndexFromFileName handle v1, v2, and staging names', () => {
  const p1 = buildStructuredSegmentFileName({
    userClubName: 'Chelsea',
    opponentClubName: 'Sunderland',
    competitionName: 'Premier League',
    formationName: '4-2-3-1 Wide',
    matchDate: '2027-09-11',
    partNumber: 1,
  });
  const p2 = buildStructuredSegmentFileName({
    userClubName: 'Chelsea',
    opponentClubName: 'Sunderland',
    competitionName: 'Premier League',
    formationName: '4-2-3-1 Wide',
    matchDate: '2027-09-11',
    partNumber: 2,
  });
  const p3 = buildStructuredSegmentFileName({
    userClubName: 'Chelsea',
    opponentClubName: 'Sunderland',
    competitionName: 'Premier League',
    formationName: '4-2-3-1 Wide',
    matchDate: '2027-09-11',
    partNumber: 3,
  });
  assert.equal(parsePartOrSegmentIndexFromFileName(p1), 1);
  assert.equal(parsePartOrSegmentIndexFromFileName(p2), 2);
  assert.equal(parsePartOrSegmentIndexFromFileName(p3), 3);
  assert.equal(parsePartOrSegmentIndexFromFileName('segment_004.mp4'), 4);
  assert.equal(parsePartOrSegmentIndexFromFileName('.fc26_seg_005.mp4'), 5);
  assert.equal(parsePartOrSegmentIndexFromFileName('random-notes.txt'), null);
});

test('18. Pause/resume continuation preserves sequential Part numbering without collision', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Manchester City',
    opponentName: 'Bournemouth',
    competition: 'Premier League',
    matchDate: '2027-11-20',
  });
  const plan = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const engine = new CaptureSessionEngine(legacyRecordingsRoot, appUserDataRoot);

  const manifest = engine.createSessionManifest({
    matchId: match.id,
    half: 'first_half',
    sourceId: 'window:100',
    sourceName: 'EA SPORTS FC 26',
    resolution: '1280x720',
    fps: 30,
    segmentDurationMinutes: 3,
    storagePlan: plan,
  });

  // Part 1 before pause
  const tmp1 = path.join(manifest.outputDirectory, '.fc26_seg_001.mp4');
  copySampleMp4(tmp1);
  const fin1 = engine.finalizeStructuredSegmentFile(manifest, tmp1, 1);
  assert.ok(fin1.fileName.endsWith('Part 1.mp4'));
  assert.ok(!fs.existsSync(tmp1));

  // Part 2 after resume
  const tmp2 = path.join(manifest.outputDirectory, '.fc26_seg_002.mp4');
  copySampleMp4(tmp2);
  const fin2 = engine.finalizeStructuredSegmentFile(manifest, tmp2, 2);
  assert.ok(fin2.fileName.endsWith('Part 2.mp4'));
  assert.ok(fs.existsSync(fin1.filePath) && fs.existsSync(fin2.filePath));
});

test('19. Repeated recording sessions in the same match+half allocate "Session 02/" without clobbering Part 1', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Inter Milan',
    opponentName: 'AC Milan',
    competition: 'Serie A',
    matchDate: '2027-11-27',
  });
  const plan1 = buildMatchStoragePlan(match.id, 'first_half', {
    allocateIfMissing: true,
    createNewSessionSubdir: true,
  });
  assert.equal(plan1.sessionSubfolderName, null);
  copySampleMp4(path.join(plan1.sessionDirectoryAbs, plan1.examplePart1FileName));

  createTestSession({
    matchId: match.id,
    half: 'first_half',
    outputDirectory: plan1.sessionDirectoryAbs,
    storageLayoutVersion: 2,
    status: 'completed',
  });

  const plan2 = buildMatchStoragePlan(match.id, 'first_half', {
    allocateIfMissing: true,
    createNewSessionSubdir: true,
  });
  assert.equal(plan2.sessionSubfolderName, 'Session 02');
  assert.ok(plan2.sessionDirectoryRel.endsWith('First Half/Session 02'));
  assert.notEqual(plan2.sessionDirectoryAbs, plan1.sessionDirectoryAbs);
});

test('20. Windows invalid characters, trailing dots/spaces, and reserved device names are sanitized safely', () => {
  const invalid = sanitizeWindowsSegment('FC <Test>: "Club"/\\|?*...', { maxLength: 64 });
  assert.ok(!/[<>:"/\\|?*]/.test(invalid));
  assert.ok(!invalid.endsWith('.') && !invalid.endsWith(' '));

  for (const reserved of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1', 'con.txt']) {
    const cleaned = sanitizeWindowsSegment(reserved);
    assert.notEqual(cleaned.toUpperCase(), reserved.toUpperCase());
    assert.ok(cleaned.endsWith('_Item'));
  }
});

test('21. Missing or invalid in-game fixture date produces "Date-Unknown" + warning (NEVER substitutes system clock)', () => {
  const todayIso = new Date().toISOString().slice(0, 10);

  const missing = validateInGameMatchDate('');
  assert.equal(missing.valid, false);
  assert.equal(missing.formatted, 'Date-Unknown');
  assert.ok(missing.warning && missing.warning.length > 0);
  assert.notEqual(missing.formatted, todayIso);

  const invalid = validateInGameMatchDate('2027-02-31');
  assert.equal(invalid.valid, false);
  assert.equal(invalid.formatted, 'Date-Unknown');

  const preview = previewMatchStoragePlan({
    clubName: 'Chelsea',
    opponentName: 'Sunderland',
    competition: 'Premier League',
    matchDate: '',
    startingFormation: '4-2-3-1 Wide',
  });
  assert.equal(preview.matchDateValid, false);
  assert.ok(preview.matchFolderName.includes('Date-Unknown'));
  assert.ok(!preview.matchFolderName.includes(todayIso));
  assert.ok(preview.warnings.length > 0);
});

test('22. Very long club/competition/formation labels compact deterministically under WINDOWS_SAFE_MAX_PATH (240 chars)', () => {
  const longParent =
    'C:\\Users\\Joni Darma\\AppData\\Roaming\\fc26-ai-manager\\Very-Long-Club-Name-Career-Mode\\Long-Match-Folder\\First Half';
  const fileName = buildStructuredSegmentFileName({
    userClubName: 'Real Sociedad de Fútbol San Sebastián Athletic Club Internacional',
    opponentClubName: 'Borussia Verein für Leibesübungen 1900 Mönchengladbach e.V.',
    competitionName: 'UEFA European Champions League Knockout Play-Off Round Second Leg',
    formationName: '4-2-3-1 Wide Asymmetric Inverted Double Pivot',
    matchDate: '2027-12-08',
    partNumber: 12,
    parentDirectoryPath: longParent,
  });
  const totalLen = longParent.length + 1 + fileName.length;
  assert.ok(
    totalLen <= WINDOWS_SAFE_MAX_PATH,
    `Expected compacted full path <= ${WINDOWS_SAFE_MAX_PATH}, got ${totalLen} (${fileName})`
  );
  assert.ok(fileName.endsWith('2027-12-08 Part 12.mp4'));
});

test('23. Filename collision during final rename throws RECORDING_FILENAME_COLLISION and never overwrites existing file', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Real Madrid',
    opponentName: 'Sevilla',
    competition: 'La Liga',
    matchDate: '2027-12-12',
  });
  const plan = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const engine = new CaptureSessionEngine(legacyRecordingsRoot, appUserDataRoot);
  const manifest = engine.createSessionManifest({
    matchId: match.id,
    half: 'first_half',
    sourceId: 'window:200',
    sourceName: 'EA SPORTS FC 26',
    resolution: '1280x720',
    fps: 30,
    segmentDurationMinutes: 3,
    storagePlan: plan,
  });

  const existingDest = path.join(manifest.outputDirectory, plan.examplePart1FileName);
  fs.writeFileSync(existingDest, 'ORIGINAL_PROTECTED_BYTES', 'utf8');

  const tmpSeg = path.join(manifest.outputDirectory, '.fc26_seg_001.mp4');
  copySampleMp4(tmpSeg);

  assert.throws(
    () => engine.finalizeStructuredSegmentFile(manifest, tmpSeg, 1),
    (err) => isMediaPathError(err) && err.code === 'RECORDING_FILENAME_COLLISION'
  );
  assert.equal(fs.readFileSync(existingDest, 'utf8'), 'ORIGINAL_PROTECTED_BYTES');
});

test('24. Temp staging file (.fc26_seg_001.mp4) renames cleanly after FFmpeg closes, leaving zero stale temp files', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Barcelona',
    opponentName: 'Valencia',
    competition: 'La Liga',
    matchDate: '2027-12-19',
  });
  const plan = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const engine = new CaptureSessionEngine(legacyRecordingsRoot, appUserDataRoot);
  const manifest = engine.createSessionManifest({
    matchId: match.id,
    half: 'first_half',
    sourceId: 'window:201',
    sourceName: 'EA SPORTS FC 26',
    resolution: '1280x720',
    fps: 30,
    segmentDurationMinutes: 3,
    storagePlan: plan,
  });

  const tmpPath = path.join(manifest.outputDirectory, '.fc26_seg_001.mp4');
  copySampleMp4(tmpPath);
  const res = engine.finalizeStructuredSegmentFile(manifest, tmpPath, 1);

  assert.ok(fs.existsSync(res.filePath));
  assert.ok(!fs.existsSync(tmpPath));
  const leftovers = fs
    .readdirSync(manifest.outputDirectory)
    .filter((f) => f.startsWith('.fc26_seg_') || f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0);
});

test('25. match-metadata.json is written atomically and secret-scrubbed (zero API keys / Bearer tokens)', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Juventus',
    opponentName: 'Napoli',
    competition: 'Serie A',
    matchDate: '2028-01-09',
  });
  const plan = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const metaPath = writeMatchMetadataManifest(match.id);
  assert.ok(metaPath && fs.existsSync(metaPath));
  const raw = fs.readFileSync(metaPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 'fc26-match-metadata-v2');
  assert.equal(parsed.matchId, match.id);
  assert.ok(!raw.includes('GEMINI_API_KEY'));

  // Verify scrubSecretsFromMetadata strips secret keys and token patterns
  const scrubbed = scrubSecretsFromMetadata({
    ok: 'safe',
    apiKey: 'AIzaSyFakeSecretKey123456789012345678',
    GEMINI_API_KEY: 'AIzaSyFakeSecretKey123456789012345678',
    authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload',
    nested: {
      note: 'contains Bearer abcdef1234567890abcdef1234567890 inside text',
      keyText: 'AIzaSyFakeSecretKey123456789012345678',
    },
  }) as Record<string, unknown>;
  assert.equal('apiKey' in scrubbed, false);
  assert.equal('GEMINI_API_KEY' in scrubbed, false);
  assert.equal('authorization' in scrubbed, false);
  assert.equal((scrubbed.nested as Record<string, string>).note, '[REDACTED]');
  assert.equal((scrubbed.nested as Record<string, string>).keyText, '[REDACTED]');
});

test('26. Crash recovery discovers and recovers BOTH legacy v1 AND structured v2 interrupted sessions', async () => {
  const bins = resolveServerFfmpegBinaries();
  const engine = new CaptureSessionEngine(legacyRecordingsRoot, appUserDataRoot);

  // Legacy v1 interrupted session
  const { match: mV1 } = createFixtureClubAndMatch({
    clubName: 'Roma',
    opponentName: 'Lazio',
    competition: 'Serie A',
    matchDate: '2028-01-16',
  });
  const v1Manifest = engine.createSessionManifest({
    matchId: mV1.id,
    half: 'first_half',
    sourceId: 'window:301',
    sourceName: 'EA SPORTS FC 26',
    resolution: '640x360',
    fps: 15,
    segmentDurationMinutes: 3,
  });
  copySampleMp4(path.join(v1Manifest.outputDirectory, 'segment_001.mp4'));

  // Structured v2 interrupted session with un-renamed .fc26_seg_001.mp4
  const { match: mV2 } = createFixtureClubAndMatch({
    clubName: 'AC Milan',
    opponentName: 'Atalanta',
    competition: 'Serie A',
    matchDate: '2028-01-23',
  });
  const v2Plan = buildMatchStoragePlan(mV2.id, 'first_half', { allocateIfMissing: true });
  const v2Manifest = engine.createSessionManifest({
    matchId: mV2.id,
    half: 'first_half',
    sourceId: 'window:302',
    sourceName: 'EA SPORTS FC 26',
    resolution: '640x360',
    fps: 15,
    segmentDurationMinutes: 3,
    storagePlan: v2Plan,
  });
  copySampleMp4(path.join(v2Manifest.outputDirectory, '.fc26_seg_001.mp4'));

  const scanned = engine.scanRecoverableManifests();
  assert.ok(scanned.some((s) => s.sessionId === v1Manifest.sessionId));
  assert.ok(scanned.some((s) => s.sessionId === v2Manifest.sessionId));

  const recV1 = await engine.recoverSession(v1Manifest.sessionId, bins.ffmpegPath, bins.ffprobePath);
  assert.equal(recV1.recoveredSegments.length, 1);
  assert.equal(recV1.status, 'recovered');
  assert.equal(engine.loadSessionManifest(v1Manifest.sessionId)?.aiEligible, true);

  const recV2 = await engine.recoverSession(v2Manifest.sessionId, bins.ffmpegPath, bins.ffprobePath);
  assert.equal(recV2.recoveredSegments.length, 1);
  assert.equal(recV2.status, 'recovered');
  assert.equal(engine.loadSessionManifest(v2Manifest.sessionId)?.aiEligible, true);
  assert.ok(recV2.recoveredSegments[0].fileName.endsWith('Part 1.mp4'));
});

test('27. Migration v6 -> v7 preserves existing v1 rows and leaves legacy recording files untouched in place', () => {
  const migDbPath = path.join(sandboxRoot, 'migration-v6-to-v7.db');
  const migDb = new Database(migDbPath);
  migDb.pragma('foreign_keys = ON');
  try {
    migDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    // Apply migrations v1..v6 only
    for (const m of MIGRATIONS.filter((x) => x.version <= 6)) {
      if (m.disableForeignKeys) migDb.pragma('foreign_keys = OFF');
      migDb.exec(m.sql);
      if (m.afterSql) m.afterSql(migDb);
      if (m.disableForeignKeys) migDb.pragma('foreign_keys = ON');
      migDb
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
    }

    // Seed a legacy v1 match + session + segment
    const now = new Date().toISOString();
    migDb
      .prepare(
        `INSERT INTO clubs (id, name, league, created_at, updated_at)
         VALUES ('club-mig', 'Chelsea', 'Premier League', ?, ?)`
      )
      .run(now, now);
    migDb
      .prepare(
        `INSERT INTO career_profiles (id, club_id, season, manager_name, preferred_philosophy, is_active, created_at, updated_at)
         VALUES ('cp-mig', 'club-mig', '2026/27', 'Joni', 'Possession', 1, ?, ?)`
      )
      .run(now, now);
    migDb
      .prepare(
        `INSERT INTO opponents (id, name, league, created_at, updated_at)
         VALUES ('opp-mig', 'Sunderland', 'Premier League', ?, ?)`
      )
      .run(now, now);
    migDb
      .prepare(
        `INSERT INTO matches (id, club_id, career_profile_id, opponent_id, competition, venue, match_date,
          starting_formation, starting_xi_json, bench_json, objective, pre_match_notes, status, created_at, updated_at)
         VALUES ('match-mig', 'club-mig', 'cp-mig', 'opp-mig', 'Premier League', 'home', '2027-09-11',
          '4-2-3-1 Wide', '[]', '[]', 'Win', '', 'halftime_ready', ?, ?)`
      )
      .run(now, now);
    migDb
      .prepare(
        `INSERT INTO match_sessions (id, match_id, half, status, output_directory, created_at, updated_at)
         VALUES ('sess-mig', 'match-mig', 'first_half', 'completed', '/legacy/recordings/match-mig/sess-mig', ?, ?)`
      )
      .run(now, now);
    migDb
      .prepare(
        `INSERT INTO recording_segments (id, session_id, match_id, segment_index, file_path, duration_seconds, size_bytes, status, created_at)
         VALUES ('seg-mig', 'sess-mig', 'match-mig', 1, 'segment_001.mp4', 180, 1234567, 'finalized', ?)`
      )
      .run(now);

    // Run full migrations (applies v7)
    runMigrations(migDb);

    const matchRow = migDb
      .prepare('SELECT storage_layout_version FROM matches WHERE id = ?')
      .get('match-mig') as { storage_layout_version: number };
    const sessRow = migDb
      .prepare('SELECT storage_layout_version, output_directory FROM match_sessions WHERE id = ?')
      .get('sess-mig') as { storage_layout_version: number; output_directory: string };
    const segRow = migDb
      .prepare('SELECT file_path FROM recording_segments WHERE id = ?')
      .get('seg-mig') as { file_path: string };

    assert.equal(matchRow.storage_layout_version, 1);
    assert.equal(sessRow.storage_layout_version, 1);
    assert.equal(sessRow.output_directory, '/legacy/recordings/match-mig/sess-mig');
    assert.equal(segRow.file_path, 'segment_001.mp4');
  } finally {
    migDb.close();
  }
});

test('28. Trusted folder resolver rejects cross-match / missing requests and returns strictly confined directories', () => {
  const { match: m1 } = createFixtureClubAndMatch({
    clubName: 'Napoli',
    opponentName: 'Fiorentina',
    competition: 'Serie A',
    matchDate: '2028-02-05',
  });
  const { match: m2 } = createFixtureClubAndMatch({
    clubName: 'Napoli',
    opponentName: 'Torino',
    competition: 'Serie A',
    matchDate: '2028-02-12',
  });

  const plan = buildMatchStoragePlan(m1.id, 'first_half', { allocateIfMissing: true });
  const sess = createTestSession({
    matchId: m1.id,
    half: 'first_half',
    outputDirectory: plan.sessionDirectoryAbs,
    storageLayoutVersion: 2,
    sessionDirectory: plan.sessionDirectoryRel,
    matchDirectory: plan.matchDirectoryRel,
    careerDirectory: plan.careerDirectoryRel,
  });

  const rootResolved = resolveTrustedFolderPath({ kind: 'storage_root' });
  assert.equal(rootResolved.resolvedPath, fs.realpathSync(appUserDataRoot));

  const firstHalfResolved = resolveTrustedFolderPath({ kind: 'first_half', matchId: m1.id });
  assert.equal(firstHalfResolved.resolvedPath, fs.realpathSync(plan.sessionDirectoryAbs));

  // Cross-match sessionId must fail
  assert.throws(
    () => resolveTrustedFolderPath({ kind: 'first_half', matchId: m2.id, sessionId: sess.id }),
    (err) => isMediaPathError(err) && err.code === 'RECORDING_SESSION_MISMATCH'
  );

  // Non-existent second half folder must throw MEDIA_FILE_NOT_FOUND
  assert.throws(
    () => resolveTrustedFolderPath({ kind: 'second_half', matchId: m1.id }),
    (err) => isMediaPathError(err) && err.code === 'MEDIA_FILE_NOT_FOUND'
  );
});

// ============================================================
// SECTION C — AI PIPELINE INTEGRATION (Tests 29–35)
// ============================================================

test('29. End-to-end mock Gemini analysis succeeds on legacy v1 recording with relative "segment_001.mp4" (Production Bug Fix)', async () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Sunderland',
    competition: 'Premier League',
    matchDate: '2027-09-04',
  });
  const sessionId = `sess-prod-bug-${crypto.randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(legacyRecordingsRoot, match.id, sessionId);
  const segAbs = path.join(sessionDir, 'segment_001.mp4');
  const file = copySampleMp4(segAbs);

  const session = createTestSession({
    id: sessionId,
    matchId: match.id,
    half: 'first_half',
    outputDirectory: sessionDir,
    storageLayoutVersion: 1,
    status: 'recording',
  });

  upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: 'segment_001.mp4', // Relative filename that triggered the production bug
    durationSeconds: 18,
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });

  updateMatchSession(session.id, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    durationSeconds: 18,
    totalBytes: file.sizeBytes,
  });

  const prevCwd = process.cwd();
  try {
    process.chdir(outsideRoot);
    const { job } = await startAnalysisJob({
      matchId: match.id,
      half: 'first_half',
      sessionId: session.id,
      privacyAuthorized: true,
      provider: createMockGeminiProvider(),
      awaitCompletion: true,
    });
    assert.equal(job.status, 'completed', `Expected completed, got ${job.status}: ${job.errorMessage}`);
    assert.equal(job.errorCode, null);
  } finally {
    process.chdir(prevCwd);
  }
});

test('30. End-to-end mock Gemini analysis succeeds on structured v2 recording with spaces, parentheses & Unicode', async () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Bayern München',
    opponentName: 'São Paulo',
    competition: 'Club World Cup',
    matchDate: '2028-06-20',
  });
  const plan = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const segAbs = path.join(plan.sessionDirectoryAbs, plan.examplePart1FileName);
  const file = copySampleMp4(segAbs);

  const session = createTestSession({
    matchId: match.id,
    half: 'first_half',
    outputDirectory: plan.sessionDirectoryAbs,
    storageLayoutVersion: 2,
    careerDirectory: plan.careerDirectoryRel,
    matchDirectory: plan.matchDirectoryRel,
    sessionDirectory: plan.sessionDirectoryRel,
    recordedFormationName: plan.namingMetadata.formationName,
    tacticalSnapshotId: plan.namingMetadata.tacticalSnapshotId,
    status: 'recording',
  });

  upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: segAbs,
    relativeMediaPath: `${plan.sessionDirectoryRel}/${plan.examplePart1FileName}`,
    originalFileName: '.fc26_seg_001.mp4',
    displayFileName: plan.examplePart1FileName,
    durationSeconds: 18,
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });

  updateMatchSession(session.id, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    durationSeconds: 18,
    totalBytes: file.sizeBytes,
  });

  const { job } = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    sessionId: session.id,
    privacyAuthorized: true,
    provider: createMockGeminiProvider(),
    awaitCompletion: true,
  });
  assert.equal(job.status, 'completed', `Expected completed, got ${job.status}: ${job.errorMessage}`);

  // Tests 31 & 32 verified directly on this v2 match output as well, plus dedicated tests below
  const folders = getMatchStorageFoldersInfo(match.id);
  assert.equal(folders.storageLayoutVersion, 2);
  assert.equal(folders.firstHalfExists, true);
  assert.equal(folders.aiAnalysisExists, true);
});

test('31. Evidence frames are written into "{MatchDir}/Evidence Frames/First Half/" and resolved via resolveEvidenceFrameFilePath', async () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Sunderland',
    competition: 'Premier League',
    matchDate: '2028-02-26',
  });
  const plan = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const segAbs = path.join(plan.sessionDirectoryAbs, plan.examplePart1FileName);
  const file = copySampleMp4(segAbs);

  const session = createTestSession({
    matchId: match.id,
    half: 'first_half',
    outputDirectory: plan.sessionDirectoryAbs,
    storageLayoutVersion: 2,
    careerDirectory: plan.careerDirectoryRel,
    matchDirectory: plan.matchDirectoryRel,
    sessionDirectory: plan.sessionDirectoryRel,
    status: 'recording',
  });

  upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: segAbs,
    relativeMediaPath: `${plan.sessionDirectoryRel}/${plan.examplePart1FileName}`,
    displayFileName: plan.examplePart1FileName,
    durationSeconds: 18,
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });

  updateMatchSession(session.id, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    durationSeconds: 18,
    totalBytes: file.sizeBytes,
  });

  const { job } = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    sessionId: session.id,
    privacyAuthorized: true,
    provider: createMockGeminiProvider(),
    awaitCompletion: true,
  });
  assert.equal(job.status, 'completed');

  assert.ok(fs.existsSync(plan.evidenceFramesDirAbs));
  const jpgs = fs.readdirSync(plan.evidenceFramesDirAbs).filter((f) => f.endsWith('.jpg'));
  assert.ok(jpgs.length >= 1, 'Expected at least 1 extracted JPEG evidence frame in v2 Evidence Frames/First Half/');

  const resolvedFrame = resolveEvidenceFrameFilePath(match.id, jpgs[0]);
  assert.equal(resolvedFrame, fs.realpathSync(path.join(plan.evidenceFramesDirAbs, jpgs[0])));
});

test('32. AI analysis exports secret-safe first-half-analysis.json, second-half-analysis.json, and match-comparison.json', async () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Leeds United',
    competition: 'Premier League',
    matchDate: '2028-03-04',
  });

  // First Half v2
  const plan1 = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const seg1Abs = path.join(plan1.sessionDirectoryAbs, plan1.examplePart1FileName);
  const f1 = copySampleMp4(seg1Abs);
  const sess1 = createTestSession({
    matchId: match.id,
    half: 'first_half',
    outputDirectory: plan1.sessionDirectoryAbs,
    storageLayoutVersion: 2,
    careerDirectory: plan1.careerDirectoryRel,
    matchDirectory: plan1.matchDirectoryRel,
    sessionDirectory: plan1.sessionDirectoryRel,
    status: 'recording',
  });
  upsertRecordingSegment({
    sessionId: sess1.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: seg1Abs,
    relativeMediaPath: `${plan1.sessionDirectoryRel}/${plan1.examplePart1FileName}`,
    displayFileName: plan1.examplePart1FileName,
    durationSeconds: 18,
    sizeBytes: f1.sizeBytes,
    checksum: f1.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });
  updateMatchSession(sess1.id, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    durationSeconds: 18,
    totalBytes: f1.sizeBytes,
  });

  const { job: job1 } = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    sessionId: sess1.id,
    privacyAuthorized: true,
    provider: createMockGeminiProvider(),
    awaitCompletion: true,
  });
  assert.equal(job1.status, 'completed');

  // Second Half v2
  const plan2 = buildMatchStoragePlan(match.id, 'second_half', { allocateIfMissing: true });
  const seg2Abs = path.join(plan2.sessionDirectoryAbs, plan2.examplePart1FileName);
  const f2 = copySampleMp4(seg2Abs);
  const sess2 = createTestSession({
    matchId: match.id,
    half: 'second_half',
    outputDirectory: plan2.sessionDirectoryAbs,
    storageLayoutVersion: 2,
    careerDirectory: plan2.careerDirectoryRel,
    matchDirectory: plan2.matchDirectoryRel,
    sessionDirectory: plan2.sessionDirectoryRel,
    status: 'recording',
  });
  upsertRecordingSegment({
    sessionId: sess2.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: seg2Abs,
    relativeMediaPath: `${plan2.sessionDirectoryRel}/${plan2.examplePart1FileName}`,
    displayFileName: plan2.examplePart1FileName,
    durationSeconds: 18,
    sizeBytes: f2.sizeBytes,
    checksum: f2.sha256,
    status: 'finalized',
    integrityStatus: 'verified',
  });
  updateMatchSession(sess2.id, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    durationSeconds: 18,
    totalBytes: f2.sizeBytes,
  });

  const { job: job2 } = await startAnalysisJob({
    matchId: match.id,
    half: 'second_half',
    sessionId: sess2.id,
    privacyAuthorized: true,
    provider: createMockGeminiProvider(),
    awaitCompletion: true,
  });
  assert.equal(job2.status, 'completed');

  const firstJson = path.join(plan1.aiAnalysisDirAbs, 'first-half-analysis.json');
  const secondJson = path.join(plan1.aiAnalysisDirAbs, 'second-half-analysis.json');
  const compJson = path.join(plan1.aiAnalysisDirAbs, 'match-comparison.json');
  assert.ok(fs.existsSync(firstJson));
  assert.ok(fs.existsSync(secondJson));
  assert.ok(fs.existsSync(compJson));

  for (const fp of [firstJson, secondJson, compJson]) {
    const raw = fs.readFileSync(fp, 'utf8');
    assert.ok(!raw.includes('AIza'));
    assert.ok(!raw.includes('GEMINI_API_KEY'));
  }
});

test('33. Diagnostics mirror exports secret-safe Diagnostics/first-half-recording-diagnostics.json & overview stats count v1/v2', () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Southampton',
    competition: 'Premier League',
    matchDate: '2028-03-11',
  });
  buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const exported = exportDiagnosticsArtifactJson(match.id, 'first_half', {
    sessionId: 'diag-test',
    status: 'completed',
    apiKey: 'AIzaSyShouldBeScrubbed1234567890123456',
    chunksReceivedMain: 32,
  });
  assert.ok(exported && fs.existsSync(exported));
  const raw = fs.readFileSync(exported, 'utf8');
  assert.ok(!raw.includes('AIzaSyShouldBeScrubbed'));
  assert.ok(raw.includes('"chunksReceivedMain": 32'));

  const overview = getStorageOverviewInfo();
  assert.equal(overview.structuredLayoutVersion, 2);
  assert.ok(overview.stats.structuredSessionsCount >= 1);
  assert.ok(overview.stats.legacySessionsCount >= 1);
});

test('34. Corrupted 0-byte / invalid MP4 classifies as MEDIA_INTEGRITY_FAILED (NEVER GEMINI_ANALYSIS_ERROR)', async () => {
  const { match } = createFixtureClubAndMatch({
    clubName: 'Chelsea',
    opponentName: 'Leicester City',
    competition: 'Premier League',
    matchDate: '2028-03-18',
  });
  const plan = buildMatchStoragePlan(match.id, 'first_half', { allocateIfMissing: true });
  const badMp4 = path.join(plan.sessionDirectoryAbs, plan.examplePart1FileName);
  fs.writeFileSync(badMp4, 'NOT_A_VALID_MP4_STREAM', 'utf8');

  const session = createTestSession({
    matchId: match.id,
    half: 'first_half',
    outputDirectory: plan.sessionDirectoryAbs,
    storageLayoutVersion: 2,
    careerDirectory: plan.careerDirectoryRel,
    matchDirectory: plan.matchDirectoryRel,
    sessionDirectory: plan.sessionDirectoryRel,
    status: 'recording',
  });
  upsertRecordingSegment({
    sessionId: session.id,
    matchId: match.id,
    segmentIndex: 1,
    filePath: badMp4,
    relativeMediaPath: `${plan.sessionDirectoryRel}/${plan.examplePart1FileName}`,
    displayFileName: plan.examplePart1FileName,
    durationSeconds: 18,
    sizeBytes: 22,
    status: 'finalized',
    integrityStatus: 'verified',
  });
  updateMatchSession(session.id, {
    status: 'completed',
    integrityStatus: 'verified',
    aiEligible: true,
    durationSeconds: 18,
    totalBytes: 22,
  });

  const { job } = await startAnalysisJob({
    matchId: match.id,
    half: 'first_half',
    sessionId: session.id,
    privacyAuthorized: true,
    provider: createMockGeminiProvider(),
    awaitCompletion: true,
  });
  const fetched = getAnalysisJob(job.id);
  assert.equal(fetched?.status, 'failed');
  assert.equal(fetched?.errorCode, 'MEDIA_INTEGRITY_FAILED');
  assert.notEqual(fetched?.errorCode, 'GEMINI_ANALYSIS_ERROR');
});

test('35. [Cross-Platform Simulation] Windows paths, case-insensitive drive containment & traversal checks', () => {
  const winRoot = 'C:\\Users\\Joni Darma\\AppData\\Roaming\\fc26-ai-manager';
  const winAllowed =
    'c:\\users\\joni darma\\appdata\\roaming\\fc26-ai-manager\\Chelsea-Career-Mode\\Chelsea-vs-Sunderland (Premier League) 2027-09-11\\First Half\\Chelsea vs Sunderland (Premier League) 4-2-3-1 Wide 2027-09-11 Part 1.mp4';
  const winSiblingPrefixAttack =
    'C:\\Users\\Joni Darma\\AppData\\Roaming\\fc26-ai-manager-evil\\segment_001.mp4';
  const winTraversal =
    'C:\\Users\\Joni Darma\\AppData\\Roaming\\fc26-ai-manager\\..\\..\\Desktop\\secret.mp4';

  assert.equal(
    isPathWithinRoot(winAllowed, winRoot, { platform: 'win32' }),
    true,
    'Case-insensitive Windows path inside root should pass'
  );
  assert.equal(
    isPathWithinRoot(winSiblingPrefixAttack, winRoot, { platform: 'win32' }),
    false,
    'Sibling prefix bypass (fc26-ai-manager-evil) must be rejected'
  );
  assert.equal(
    isPathWithinRoot(winTraversal, winRoot, { platform: 'win32' }),
    false,
    'Windows .. traversal must be rejected'
  );
  assert.equal(
    normalizePathForComparison('C:\\Users\\Joni\\AppData\\Roaming\\fc26-ai-manager\\', 'win32'),
    'c:\\users\\joni\\appdata\\roaming\\fc26-ai-manager'
  );

  // Also ensure snapshots list remains intact and readable
  const anySnapshots = listMatchTacticalSnapshots('non-existent');
  assert.deepEqual(anySnapshots, []);
});

// ============================================================
// RUNNER
// ============================================================

async function main() {
  console.log(`\n=== FC26 AI Manager — Phase 3.0.1 Regression Suite (${tests.length} scenarios) ===\n`);
  let passed = 0;
  const failures: Array<{ name: string; error: unknown }> = [];

  for (const tc of tests) {
    try {
      await tc.run();
      passed += 1;
      console.log(`  [PASS] ${tc.name}`);
    } catch (err) {
      failures.push({ name: tc.name, error: err });
      console.error(`  [FAIL] ${tc.name}`);
      console.error(`         ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }

  closeDb();
  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup race on OS temp
  }

  console.log(`\nPhase 3.0.1 Result: ${passed}/${tests.length} passed`);
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
