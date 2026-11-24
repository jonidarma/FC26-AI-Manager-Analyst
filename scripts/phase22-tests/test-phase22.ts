/**
 * Phase 2.2 Automated Acceptance Test Suite
 *
 * Covers:
 * - Workstream A: Formation slot normalization, canonical FC 26 positions, legacy alias migration v4->v5,
 *   left/right slot distinction, rejection of unknown positions, all 34 catalog formations
 * - Workstream B: Centralized squad eligibility engine across Tactical Presets (draft vs match_ready),
 *   Starting XI & Bench, Match Preparation, pre-recording guard on scheduled matches,
 *   and immutability of historical snapshots
 * - Workstream C & D: Complete FC 26 Club/League/Nation reconciliation from imported DataHub players
 *   (20/20 Premier League + Everton, Italian unlicensed club aliases, cross-country league collisions,
 *   women's club isolation, idempotency, UUID/attributes preservation, Default Roster import safety)
 * - Workstream E & F: Lifetime FFmpeg stdin byte metric structure & Phase 3 analysis_state transitions
 *
 * Strictly isolated in an OS temp directory — NEVER modifies the live SQLite database.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Isolate SQLite database BEFORE importing server/db modules
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc26-phase22-test-'));
process.env.FC26_USER_DATA_DIR = tempDir;

import { createEmptyPipelineDiagnostics } from '../../electron/captureTypes.ts';
import type { Player } from '../../src/types/domain.ts';
import {
  getDisplayPositionLabel,
  normalizeFormationSlotPosition,
} from '../../src/utils/formationPositions.ts';
import {
  evaluatePlayerEligibility,
  validateLineupEligibility,
} from '../../src/utils/squadEligibility.ts';

interface TestCase {
  name: string;
  run: () => Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void) {
  tests.push({ name, run });
}

function makeMockPlayer(overrides: Partial<Player> = {}): Player {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    clubId: overrides.clubId ?? 'club-1',
    catalogPlayerId: null,
    name: overrides.name ?? 'Test Player',
    displayName: overrides.displayName ?? 'Test Player',
    displayNameOverride: null,
    shortName: overrides.shortName ?? 'T. Player',
    fullName: overrides.fullName ?? 'Test Player',
    position: overrides.position ?? 'CM',
    secondaryPositions: [],
    squadNumber: overrides.squadNumber ?? 8,
    age: 24,
    overallRating: overrides.overallRating ?? 82,
    potentialRating: 85,
    preferredFoot: 'Right',
    playerRole: 'Box-to-Box',
    playerFocus: 'Balanced',
    preferredInstructions: '',
    strengths: '',
    weaknesses: '',
    availability: overrides.availability ?? 'available',
    squadStatus: overrides.squadStatus ?? 'active',
    seniorSelectionAuthorized: overrides.seniorSelectionAuthorized ?? false,
    injuryStatus: null,
    suspensionStatus: null,
    membershipStartDate: null,
    membershipEndDate: null,
    contractExpiry: null,
    marketValueEur: null,
    wageEur: null,
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
}

function defaultClubInput(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    league: 'Premier League',
    nation: 'England',
    season: '2025/26',
    managerName: 'Coach Test',
    preferredPhilosophy: 'Positional Play',
    primaryFormation: '4-2-3-1 Wide',
    alternativeFormation: '4-3-3 Holding',
    preferredAttackingStyle: 'Balanced',
    preferredDefensiveStyle: 'High',
    setActive: true,
    ...overrides,
  };
}

function defaultPlayerInput(
  clubId: string,
  name: string,
  position: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    clubId,
    name,
    fullName: name,
    shortName: name,
    position,
    preferredFoot: 'Right' as const,
    playerRole: '',
    playerFocus: '',
    preferredInstructions: '',
    strengths: '',
    weaknesses: '',
    availability: 'available' as const,
    squadStatus: 'active' as const,
    overallRating: 82,
    ...overrides,
  };
}

async function main() {
  const { closeDb, getDb } = await import('../../server/db/database.ts');
  const { MIGRATIONS, runMigrations } = await import('../../server/db/migrations.ts');
  const {
    executeCatalogReconciliationFromPlayers,
    getCatalogCoverageReport,
    previewCatalogReconciliationFromPlayers,
  } = await import('../../server/services/catalogReconciler.ts');
  const {
    getCatalogFormationByIdOrName,
    listCatalogFormations,
    searchCatalogClubs,
  } = await import('../../server/services/catalogRepository.ts');
  const repo = await import('../../server/services/repository.ts');
  const { validatePlayerRoleFocus } = await import('../../server/services/tacticalContextService.ts');

  // ---------------------------------------------------------------------------
  // WORKSTREAM A — FORMATION SLOT NORMALIZATION & CANONICAL POSITIONS
  // ---------------------------------------------------------------------------

  test('A1: Canonical slot alias normalizer maps all side-prefixed FC 26 aliases & rejects unknown codes', () => {
    const cases: Array<[string, string, string]> = [
      ['LCB', 'CB', 'LCB'],
      ['RCB', 'CB', 'RCB'],
      ['CCB', 'CB', 'CCB'],
      ['LDM', 'CDM', 'LDM'],
      ['RDM', 'CDM', 'RDM'],
      ['LCDM', 'CDM', 'LCDM'],
      ['RCDM', 'CDM', 'RCDM'],
      ['LCM', 'CM', 'LCM'],
      ['RCM', 'CM', 'RCM'],
      ['LCAM', 'CAM', 'LCAM'],
      ['RCAM', 'CAM', 'RCAM'],
      ['LST', 'ST', 'LST'],
      ['RST', 'ST', 'RST'],
      ['CB', 'CB', 'CB'],
      ['GK', 'GK', 'GK'],
    ];

    for (const [raw, expectedCanonical, expectedSlotId] of cases) {
      const res = normalizeFormationSlotPosition(raw);
      assert.equal(res.ok, true, `Expected ${raw} to normalize cleanly`);
      if (res.ok) {
        assert.equal(res.canonicalPosition, expectedCanonical);
        assert.equal(res.slotId, expectedSlotId);
      }
      assert.equal(getDisplayPositionLabel(raw), expectedCanonical);
    }

    for (const bad of ['XYZ', 'RCB2', 'MID9', 'SWEEPER', '']) {
      const res = normalizeFormationSlotPosition(bad);
      assert.equal(res.ok, false, `Expected invalid position "${bad}" to be rejected`);
    }
  });

  test('A2: validatePlayerRoleFocus accepts LCB/RCB/LCDM/RCDM aliases and rejects unknown position codes', () => {
    const db = getDb();
    const lcbCheck = validatePlayerRoleFocus('LCB', 'Defender', 'Defend', db);
    assert.equal(lcbCheck.valid, true, lcbCheck.reason);

    const rdmCheck = validatePlayerRoleFocus('RDM', 'Holding', 'Defend', db);
    assert.equal(rdmCheck.valid, true, rdmCheck.reason);

    const unknownCheck = validatePlayerRoleFocus('XYZ', 'Defender', 'Defend', db);
    assert.equal(unknownCheck.valid, false);
    assert.match(unknownCheck.reason ?? '', /not a recognized/i);
  });

  test('A3: All 34 seeded catalog formations use 11 canonical FC 26 positions and distinct slotIds', () => {
    const formations = listCatalogFormations();
    assert.ok(formations.length >= 30, `Expected >= 30 formations, found ${formations.length}`);

    const wide4231 = getCatalogFormationByIdOrName('4-2-3-1 Wide');
    assert.ok(wide4231, 'Expected 4-2-3-1 Wide formation in catalog');
    assert.equal(wide4231.slots.length, 11);
    assert.deepEqual(
      wide4231.slots.map((s) => s.positionCode),
      ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'LM', 'CAM', 'RM', 'ST']
    );
    assert.deepEqual(
      wide4231.slots.map((s) => s.positionLabel),
      ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'LM', 'CAM', 'RM', 'ST']
    );
    assert.deepEqual(
      wide4231.slots.map((s) => s.slotId),
      ['GK', 'LB', 'LCB', 'RCB', 'RB', 'LCDM', 'RCDM', 'LM', 'CAM', 'RM', 'ST']
    );

    for (const formation of formations) {
      assert.equal(formation.slots.length, 11, `${formation.name} must have 11 slots`);
      const slotIds = new Set<string>();
      for (const slot of formation.slots) {
        const norm = normalizeFormationSlotPosition(slot.positionCode);
        assert.equal(norm.ok, true, `${formation.name} slot ${slot.slotOrder} invalid`);
        if (norm.ok) {
          assert.equal(
            slot.positionCode,
            norm.canonicalPosition,
            `${formation.name} slot ${slot.slotOrder} must store canonical position code`
          );
        }
        assert.ok(slot.slotId, `${formation.name} slot ${slot.slotOrder} must have slotId`);
        assert.equal(
          slotIds.has(slot.slotId),
          false,
          `${formation.name} has duplicate slotId ${slot.slotId}`
        );
        slotIds.add(slot.slotId);
      }
    }
  });

  test('A4: Saving 4-2-3-1 Wide tactical preset preserves distinct LCB/RCB & LCDM/RCDM players and normalizes legacy aliases', () => {
    const club = repo.createClub(defaultClubInput('Tactical Slot Test FC'));

    const positions = ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'LM', 'CAM', 'RM', 'ST'];
    const createdPlayers = positions.map((pos, idx) =>
      repo.createPlayer(
        defaultPlayerInput(club.id, `Starter ${idx + 1} ${pos}`, pos, { squadNumber: idx + 1 })
      )
    );

    // Deliberately send legacy side-prefixed alias codes (LCB, RCB, LDM, RDM)
    const preset = repo.createTacticalPreset(club.id, {
      name: '4-2-3-1 Wide Primary',
      formationName: '4-2-3-1 Wide',
      buildUpStyle: 'Balanced',
      defensiveApproach: 'High',
      defensiveLineHeight: 65,
      isDefault: true,
      presetStatus: 'match_ready',
      assignments: [
        { slotOrder: 0, slotId: 'GK', positionCode: 'GK', playerId: createdPlayers[0].id, role: 'Goalkeeper', focus: 'Defend' },
        { slotOrder: 1, slotId: 'LB', positionCode: 'LB', playerId: createdPlayers[1].id, role: 'Fullback', focus: 'Defend' },
        { slotOrder: 2, slotId: 'LCB', positionCode: 'LCB', playerId: createdPlayers[2].id, role: 'Defender', focus: 'Defend' },
        { slotOrder: 3, slotId: 'RCB', positionCode: 'RCB', playerId: createdPlayers[3].id, role: 'Ball-Playing Defender', focus: 'Defend' },
        { slotOrder: 4, slotId: 'RB', positionCode: 'RB', playerId: createdPlayers[4].id, role: 'Fullback', focus: 'Defend' },
        { slotOrder: 5, slotId: 'LCDM', positionCode: 'LDM', playerId: createdPlayers[5].id, role: 'Holding', focus: 'Defend' },
        { slotOrder: 6, slotId: 'RCDM', positionCode: 'RDM', playerId: createdPlayers[6].id, role: 'Deep-Lying Playmaker', focus: 'Build-Up' },
        { slotOrder: 7, slotId: 'LM', positionCode: 'LM', playerId: createdPlayers[7].id, role: 'Winger', focus: 'Balanced' },
        { slotOrder: 8, slotId: 'CAM', positionCode: 'CAM', playerId: createdPlayers[8].id, role: 'Playmaker', focus: 'Balanced' },
        { slotOrder: 9, slotId: 'RM', positionCode: 'RM', playerId: createdPlayers[9].id, role: 'Inside Forward', focus: 'Attack' },
        { slotOrder: 10, slotId: 'ST', positionCode: 'ST', playerId: createdPlayers[10].id, role: 'Advanced Forward', focus: 'Attack' },
      ],
    });

    const persisted = repo.getTacticalPresetById(preset.id);
    assert.ok(persisted);
    assert.deepEqual(
      persisted.assignments.map((a) => a.positionCode),
      ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'LM', 'CAM', 'RM', 'ST']
    );
    assert.equal(persisted.assignments[2].slotId, 'LCB');
    assert.equal(persisted.assignments[2].playerId, createdPlayers[2].id);
    assert.equal(persisted.assignments[3].slotId, 'RCB');
    assert.equal(persisted.assignments[3].playerId, createdPlayers[3].id);
    assert.equal(persisted.assignments[5].slotId, 'LCDM');
    assert.equal(persisted.assignments[5].playerId, createdPlayers[5].id);
    assert.equal(persisted.assignments[6].slotId, 'RCDM');
    assert.equal(persisted.assignments[6].playerId, createdPlayers[6].id);
  });

  test('A5: Non-destructive Migration v4 -> v5 normalizes legacy alias position_code in tactical_preset_assignments while preserving slot_id', () => {
    const legacyDbPath = path.join(tempDir, 'legacy_v4.sqlite');
    const legacyDb = new Database(legacyDbPath);
    legacyDb.pragma('foreign_keys = ON');
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (const m of MIGRATIONS.filter((x) => x.version <= 4)) {
      legacyDb.exec(m.sql);
      if (m.afterSql) m.afterSql(legacyDb);
      legacyDb
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
    }

    const now = new Date().toISOString();
    const clubId = crypto.randomUUID();
    const presetId = crypto.randomUUID();
    const assignId1 = crypto.randomUUID();
    const assignId2 = crypto.randomUUID();

    legacyDb
      .prepare('INSERT INTO clubs (id, name, league, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(clubId, 'Legacy Preset Club', 'Premier League', now, now);
    legacyDb
      .prepare(
        `INSERT INTO tactical_presets (
          id, club_id, name, formation_name, build_up_style, defensive_approach,
          defensive_line_height, is_default, bench_json, notes, created_at, updated_at
        ) VALUES (?, ?, 'Legacy 4-2-3-1', '4-2-3-1 Wide', 'Balanced', 'High', 60, 1, '[]', '', ?, ?)`
      )
      .run(presetId, clubId, now, now);
    legacyDb
      .prepare(
        `INSERT INTO tactical_preset_assignments (id, preset_id, slot_order, position_code, player_id, role, focus)
         VALUES (?, ?, 2, 'LCB', NULL, 'Defender', 'Defend'),
                (?, ?, 5, 'LDM', NULL, 'Holding', 'Defend')`
      )
      .run(assignId1, presetId, assignId2, presetId);

    runMigrations(legacyDb);

    const fkIssues = legacyDb.pragma('foreign_key_check') as unknown[];
    assert.equal(fkIssues.length, 0);

    const rows = legacyDb
      .prepare(
        'SELECT slot_order, slot_id, position_code FROM tactical_preset_assignments WHERE preset_id = ? ORDER BY slot_order ASC'
      )
      .all(presetId) as Array<{ slot_order: number; slot_id: string; position_code: string }>;

    assert.equal(rows[0].position_code, 'CB');
    assert.equal(rows[0].slot_id, 'LCB');
    assert.equal(rows[1].position_code, 'CDM');
    assert.equal(rows[1].slot_id, 'LDM');

    legacyDb.close();
  });

  // ---------------------------------------------------------------------------
  // WORKSTREAM B — CENTRALIZED SQUAD ELIGIBILITY ENGINE
  // ---------------------------------------------------------------------------

  test('B1: Centralized eligibility matrix enforces all squadStatus & availability rules', () => {
    assert.equal(
      evaluatePlayerEligibility(makeMockPlayer({ squadStatus: 'active', availability: 'available' })).eligible,
      true
    );
    assert.equal(
      evaluatePlayerEligibility(makeMockPlayer({ squadStatus: 'loaned_in', availability: 'available' })).eligible,
      true
    );

    for (const status of ['loaned_out', 'transferred_out', 'released'] as const) {
      const res = evaluatePlayerEligibility(makeMockPlayer({ squadStatus: status, availability: 'available' }));
      assert.equal(res.eligible, false, `Expected ${status} to be ineligible`);
      assert.equal(res.requiresConfirmation, false);
    }

    const youthBlocked = evaluatePlayerEligibility(
      makeMockPlayer({ squadStatus: 'youth_academy', seniorSelectionAuthorized: false, availability: 'available' })
    );
    assert.equal(youthBlocked.eligible, false);
    const youthAuthorized = evaluatePlayerEligibility(
      makeMockPlayer({ squadStatus: 'youth_academy', seniorSelectionAuthorized: true, availability: 'available' })
    );
    assert.equal(youthAuthorized.eligible, true);

    for (const avail of ['injured', 'suspended', 'unavailable'] as const) {
      const res = evaluatePlayerEligibility(makeMockPlayer({ squadStatus: 'active', availability: avail }));
      assert.equal(res.eligible, false, `Expected ${avail} to be ineligible`);
    }

    const doubtful = evaluatePlayerEligibility(
      makeMockPlayer({ squadStatus: 'active', availability: 'doubtful' })
    );
    assert.equal(doubtful.eligible, true);
    assert.equal(doubtful.requiresConfirmation, true);

    const doubtfulPlayer = makeMockPlayer({ id: 'p-doubt', squadStatus: 'active', availability: 'doubtful' });
    const unconfirmed = validateLineupEligibility({
      clubPlayers: [doubtfulPlayer],
      assignments: [{ slotOrder: 0, positionCode: 'CM', playerId: 'p-doubt' }],
      benchPlayerIds: [],
    });
    assert.equal(unconfirmed.validForMatchReady, false);
    assert.equal(unconfirmed.hasUnconfirmedDoubtful, true);
    assert.equal(unconfirmed.doubtfulUnconfirmed[0].playerId, 'p-doubt');

    const confirmed = validateLineupEligibility({
      clubPlayers: [doubtfulPlayer],
      assignments: [{ slotOrder: 0, positionCode: 'CM', playerId: 'p-doubt' }],
      benchPlayerIds: [],
      confirmedDoubtfulPlayerIds: ['p-doubt'],
    });
    assert.equal(confirmed.validForMatchReady, true);
    assert.equal(confirmed.hasUnconfirmedDoubtful, false);
  });

  test('B2: Backend blocks ineligible players in match_ready presets, allows draft preservation, blocks match/recording start, preserves historical snapshots', () => {
    const club = repo.createClub(defaultClubInput('Eligibility Guard FC'));

    const positions = ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'LM', 'CAM', 'RM', 'ST'];
    const starters = positions.map((pos, idx) =>
      repo.createPlayer(
        defaultPlayerInput(club.id, `Eligible Starter ${idx + 1}`, pos, {
          squadNumber: idx + 1,
          squadStatus: idx === 1 ? 'loaned_in' : 'active',
        })
      )
    );

    const loanedOutPlayer = repo.createPlayer(
      defaultPlayerInput(club.id, 'Loaned Out Winger', 'LM', {
        squadNumber: 21,
        squadStatus: 'loaned_out',
      })
    );
    const injuredPlayer = repo.createPlayer(
      defaultPlayerInput(club.id, 'Injured Striker', 'ST', {
        squadNumber: 22,
        availability: 'injured',
      })
    );
    const doubtfulPlayer = repo.createPlayer(
      defaultPlayerInput(club.id, 'Doubtful Playmaker', 'CAM', {
        squadNumber: 23,
        availability: 'doubtful',
      })
    );
    const youthPlayer = repo.createPlayer(
      defaultPlayerInput(club.id, 'Academy Prospect', 'RB', {
        squadNumber: 45,
        squadStatus: 'youth_academy',
        seniorSelectionAuthorized: false,
      })
    );

    const baseAssignments = starters.map((p, idx) => ({
      slotOrder: idx,
      positionCode: positions[idx],
      playerId: p.id,
      role:
        positions[idx] === 'GK'
          ? 'Goalkeeper'
          : positions[idx] === 'CB'
            ? 'Defender'
            : positions[idx] === 'CDM'
              ? 'Holding'
              : positions[idx] === 'ST'
                ? 'Advanced Forward'
                : positions[idx] === 'CAM'
                  ? 'Playmaker'
                  : positions[idx] === 'LM' || positions[idx] === 'RM'
                    ? 'Winger'
                    : 'Fullback',
      focus:
        positions[idx] === 'GK' ||
        positions[idx] === 'CB' ||
        positions[idx] === 'LB' ||
        positions[idx] === 'RB' ||
        positions[idx] === 'CDM'
          ? 'Defend'
          : positions[idx] === 'ST'
            ? 'Attack'
            : 'Balanced',
    }));

    // 1. Loaned out in Starting XI must be rejected
    assert.throws(
      () =>
        repo.createTacticalPreset(club.id, {
          name: 'Illegal Loaned Out XI',
          formationName: '4-2-3-1 Wide',
          buildUpStyle: 'Balanced',
          defensiveApproach: 'High',
          defensiveLineHeight: 65,
          presetStatus: 'match_ready',
          assignments: baseAssignments.map((a, idx) =>
            idx === 7 ? { ...a, playerId: loanedOutPlayer.id } : a
          ),
        }),
      /Loaned out/i
    );

    // 2. Injured player on Bench must be rejected
    assert.throws(
      () =>
        repo.createTacticalPreset(club.id, {
          name: 'Illegal Injured Bench',
          formationName: '4-2-3-1 Wide',
          buildUpStyle: 'Balanced',
          defensiveApproach: 'High',
          defensiveLineHeight: 65,
          presetStatus: 'match_ready',
          assignments: baseAssignments,
          benchPlayerIds: [injuredPlayer.id],
        }),
      /Injured/i
    );

    // 3. Unauthorized youth academy player rejected; authorized succeeds
    assert.throws(
      () =>
        repo.createTacticalPreset(club.id, {
          name: 'Unauthorized Youth',
          formationName: '4-2-3-1 Wide',
          buildUpStyle: 'Balanced',
          defensiveApproach: 'High',
          defensiveLineHeight: 65,
          presetStatus: 'match_ready',
          assignments: baseAssignments.map((a, idx) =>
            idx === 4 ? { ...a, playerId: youthPlayer.id } : a
          ),
        }),
      /Youth Academy/i
    );

    repo.updatePlayer(youthPlayer.id, { seniorSelectionAuthorized: true });
    const youthPreset = repo.createTacticalPreset(club.id, {
      name: 'Authorized Youth',
      formationName: '4-2-3-1 Wide',
      buildUpStyle: 'Balanced',
      defensiveApproach: 'High',
      defensiveLineHeight: 65,
      presetStatus: 'match_ready',
      assignments: baseAssignments.map((a, idx) =>
        idx === 4 ? { ...a, playerId: youthPlayer.id } : a
      ),
    });
    assert.equal(youthPreset.presetStatus, 'match_ready');

    // 4. Doubtful player rejected without confirmation, accepted when confirmed
    assert.throws(
      () =>
        repo.createTacticalPreset(club.id, {
          name: 'Unconfirmed Doubtful',
          formationName: '4-2-3-1 Wide',
          buildUpStyle: 'Balanced',
          defensiveApproach: 'High',
          defensiveLineHeight: 65,
          presetStatus: 'match_ready',
          assignments: baseAssignments.map((a, idx) =>
            idx === 8 ? { ...a, playerId: doubtfulPlayer.id } : a
          ),
        }),
      /Doubtful/i
    );

    const validPreset = repo.createTacticalPreset(club.id, {
      name: 'Confirmed Doubtful XI',
      formationName: '4-2-3-1 Wide',
      buildUpStyle: 'Balanced',
      defensiveApproach: 'High',
      defensiveLineHeight: 65,
      presetStatus: 'match_ready',
      assignments: baseAssignments.map((a, idx) =>
        idx === 8 ? { ...a, playerId: doubtfulPlayer.id } : a
      ),
      confirmedDoubtfulPlayerIds: [doubtfulPlayer.id],
    });
    assert.equal(validPreset.presetStatus, 'match_ready');

    // 5. Existing preset invalidation: injure starter[10] -> match_ready save blocked, draft save allowed
    repo.updatePlayer(starters[10].id, { availability: 'injured' });
    assert.throws(
      () =>
        repo.updateTacticalPreset(validPreset.id, {
          presetStatus: 'match_ready',
          confirmedDoubtfulPlayerIds: [doubtfulPlayer.id],
        }),
      /Injured/i
    );
    const savedDraft = repo.updateTacticalPreset(validPreset.id, {
      presetStatus: 'draft',
      notes: 'Preserving draft while striker recovers',
    });
    assert.equal(savedDraft?.presetStatus, 'draft');

    // Restore starter[10], create a scheduled match, then injure starter[10] BEFORE recording starts
    repo.updatePlayer(starters[10].id, { availability: 'available' });
    const opponent = repo.createOpponent({
      name: 'Guard Test United',
      league: 'Premier League',
      typicalFormation: '4-4-2',
      strengths: 'Transitions',
      weaknesses: 'High line',
      dangerousChannels: 'Right flank',
      notes: '',
    });
    const match = repo.createMatch({
      clubId: club.id,
      careerProfileId: club.profile.id,
      opponentId: opponent.id,
      matchDate: '2026-09-12',
      competition: 'Premier League',
      venue: 'home',
      startingFormation: '4-2-3-1 Wide',
      startingXiIds: starters.map((s) => s.id),
      benchIds: [],
      objective: 'win',
      preMatchNotes: '',
      tacticalSetup: {
        buildUpStyle: 'Balanced',
        defensiveApproach: 'High',
        defensiveLineHeight: 65,
        playerAssignments: baseAssignments.map((a, idx) => ({
          slotIndex: a.slotOrder,
          positionCode: a.positionCode,
          playerId: a.playerId,
          playerName: starters[idx].displayName,
          role: a.role,
          focus: a.focus,
        })),
      },
    });

    // Injure starter[10] before kickoff -> pre-recording guard MUST block starting a recording on scheduled match
    repo.updatePlayer(starters[10].id, { availability: 'injured' });
    assert.throws(
      () =>
        repo.createOrUpsertMatchSession({
          matchId: match.id,
          half: 'first_half',
          status: 'recording',
          captureSourceId: 'window:fc26',
          captureSourceName: 'EA SPORTS FC 26',
          resolution: '1280x720',
          fps: 30,
        }),
      /Cannot start match recording.*Injured/i
    );

    // Restore starter[10] -> recording starts cleanly and freezes historical pre-match snapshot
    repo.updatePlayer(starters[10].id, { availability: 'available' });
    const startedSession = repo.createOrUpsertMatchSession({
      matchId: match.id,
      half: 'first_half',
      status: 'recording',
      captureSourceId: 'window:fc26',
      captureSourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
    });
    assert.equal(startedSession.status, 'recording');

    // Later transfer/injure starter[10] -> historical frozen snapshot MUST remain completely untouched
    repo.updatePlayer(starters[10].id, { squadStatus: 'transferred_out', availability: 'unavailable' });
    const frozenSnapshot = repo.getPreMatchTacticalSnapshot(match.id);
    assert.ok(frozenSnapshot);
    assert.equal(frozenSnapshot.isLocked, true);
    assert.equal(frozenSnapshot.assignments[10].playerId, starters[10].id);
    assert.equal(frozenSnapshot.assignments[10].squadStatusAtSnapshot, 'active');
    assert.equal(frozenSnapshot.assignments[10].availabilityAtSnapshot, 'available');
  });

  // ---------------------------------------------------------------------------
  // WORKSTREAM C & D — FC 26 MASTER CATALOG RECONCILIATION & DEFAULT ROSTER
  // ---------------------------------------------------------------------------

  test('C1/D1: Reconciliation creates 20/20 Premier League + Everton, Italian aliases, cross-country leagues, preserves UUIDs/women clubs, is idempotent, and powers safe Default Roster import', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const sourceRow = db.prepare('SELECT id FROM catalog_sources LIMIT 1').get() as { id: string };

    const plClubs: Array<[number, string]> = [
      [1, 'Arsenal'],
      [2, 'Aston Villa'],
      [1943, 'AFC Bournemouth'],
      [1925, 'Brentford'],
      [1808, 'Brighton & Hove Albion'],
      [1796, 'Burnley'],
      [5, 'Chelsea'],
      [1799, 'Crystal Palace'],
      [7, 'Everton'],
      [144, 'Fulham'],
      [8, 'Leeds United'],
      [9, 'Liverpool'],
      [10, 'Manchester City'],
      [11, 'Manchester United'],
      [13, 'Newcastle United'],
      [14, 'Nottingham Forest'],
      [106, 'Sunderland'],
      [18, 'Tottenham Hotspur'],
      [19, 'West Ham United'],
      [110, 'Wolverhampton Wanderers'],
    ];

    const insertPlayer = db.prepare(`
      INSERT INTO catalog_players (
        id, external_source_id, full_name, short_name,
        nation_id, club_id, league_id,
        nation_name_raw, club_name_raw, league_name_raw,
        primary_position,
        overall_rating, potential_rating, age, preferred_foot,
        pace, shooting, passing, dribbling, defending, physicality,
        attributes_json, source_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 24, 'Right', 78, 76, 77, 79, 72, 75, ?, ?, ?, ?)
    `);

    const evertonPlayerIds: string[] = [];

    for (const [teamId, clubName] of plClubs) {
      const count = teamId === 7 ? 3 : 1;
      for (let i = 0; i < count; i++) {
        const pid = crypto.randomUUID();
        if (teamId === 7) evertonPlayerIds.push(pid);
        insertPlayer.run(
          pid,
          `dh-pl-${teamId}-${i}`,
          `${clubName} Player ${i + 1}`,
          `${clubName} P${i + 1}`,
          'England',
          clubName,
          'Premier League',
          i === 0 ? 'GK' : i === 1 ? 'CB' : 'ST',
          80 + i,
          84 + i,
          JSON.stringify({
            club_team_id: teamId,
            league_id: 13,
            league_level: 1,
            nationality_id: 14,
            club_jersey_number: i + 1,
            fifa_version: 26,
            fifa_update: 4,
            fifa_update_date: '2025-09-19',
          }),
          sourceRow.id,
          now,
          now
        );
      }
    }

    // Italian unlicensed clubs
    const italianClubs: Array<[number, string]> = [
      [44, 'Inter'],
      [47, 'Milan'],
      [39, 'Atalanta'],
      [46, 'Lazio'],
    ];
    for (const [teamId, clubName] of italianClubs) {
      insertPlayer.run(
        crypto.randomUUID(),
        `dh-ita-${teamId}`,
        `${clubName} Star`,
        `${clubName} S`,
        'Italy',
        clubName,
        'Serie A',
        'CM',
        85,
        86,
        JSON.stringify({
          club_team_id: teamId,
          league_id: 31,
          league_level: 1,
          nationality_id: 27,
          club_jersey_number: 10,
          fifa_version: 26,
          fifa_update: 4,
          fifa_update_date: '2025-09-19',
        }),
        sourceRow.id,
        now,
        now
      );
    }

    // Cross-country league collision: Premier League in Ukraine (league_id = 332)
    insertPlayer.run(
      crypto.randomUUID(),
      'dh-ukr-1',
      'Shakhtar Midfielder',
      'Shakhtar M',
      'Ukraine',
      'Shakhtar Donetsk',
      'Premier League',
      'CM',
      78,
      82,
      JSON.stringify({
        club_team_id: 101059,
        league_id: 332,
        league_level: 1,
        nationality_id: 49,
        club_jersey_number: 8,
        fifa_version: 26,
        fifa_update: 4,
        fifa_update_date: '2025-09-19',
      }),
      sourceRow.id,
      now,
      now
    );

    // Free agent + unresolved row
    insertPlayer.run(
      crypto.randomUUID(),
      'dh-fa-1',
      'Free Agent Striker',
      'FA Striker',
      'England',
      '',
      '',
      'ST',
      74,
      74,
      JSON.stringify({
        nationality_id: 14,
      }),
      sourceRow.id,
      now,
      now
    );
    insertPlayer.run(
      crypto.randomUUID(),
      'dh-unres-1',
      'Unresolved Club Player',
      'Unresolved',
      'England',
      'Mystery FC',
      '',
      'CB',
      70,
      72,
      JSON.stringify({
        club_team_id: 999999,
        nationality_id: 14,
      }),
      sourceRow.id,
      now,
      now
    );

    // Count baseline women's clubs BEFORE reconciliation
    const womenClubsBefore = (
      db
        .prepare(`SELECT COUNT(*) as c FROM catalog_clubs WHERE team_category = 'womens'`)
        .get() as { c: number }
    ).c;

    // Preview first (read-only)
    const preview = previewCatalogReconciliationFromPlayers(db);
    assert.ok(preview.clubsToInsert > 0, 'Preview should detect missing clubs like Everton');
    assert.equal(preview.evertonFoundInSource, true);

    // Execute reconciliation
    const firstRun = executeCatalogReconciliationFromPlayers(db);
    assert.equal(firstRun.coverageAfter.duplicateClubChecks.length, 0);
    assert.equal(firstRun.coverageAfter.premierLeagueVerification.expectedClubCount, 20);
    assert.equal(firstRun.coverageAfter.premierLeagueVerification.clubCount, 20);
    assert.equal(firstRun.coverageAfter.premierLeagueVerification.complete20Of20, true);
    assert.equal(firstRun.coverageAfter.premierLeagueVerification.evertonPresent, true);
    assert.equal(firstRun.coverageAfter.premierLeagueVerification.evertonPlayerCount, 3);

    // Verify women's clubs remained strictly intact & separate
    const womenClubsAfter = (
      db
        .prepare(`SELECT COUNT(*) as c FROM catalog_clubs WHERE team_category = 'womens'`)
        .get() as { c: number }
    ).c;
    assert.equal(womenClubsAfter, womenClubsBefore);

    // Verify Everton UUIDs and attributes_json were strictly preserved
    for (const pid of evertonPlayerIds) {
      const row = db
        .prepare('SELECT id, club_id, attributes_json FROM catalog_players WHERE id = ?')
        .get(pid) as { id: string; club_id: string | null; attributes_json: string } | undefined;
      assert.ok(row, 'Existing player UUID must be preserved');
      assert.ok(row.club_id, 'Everton player must now be linked to catalog_clubs');
      assert.ok(row.attributes_json.includes('"club_team_id":7'));
    }

    // Verify Italian unlicensed aliases are searchable via searchCatalogClubs
    const lombardiaHits = searchCatalogClubs({ q: 'Lombardia FC', pageSize: 20 }, db).items;
    assert.ok(
      lombardiaHits.some((c) => c.externalTeamId === '44'),
      'Lombardia FC alias should find Inter (team_id=44)'
    );
    const milanoHits = searchCatalogClubs({ q: 'Milano FC', pageSize: 20 }, db).items;
    assert.ok(
      milanoHits.some((c) => c.externalTeamId === '47'),
      'Milano FC alias should find Milan (team_id=47)'
    );
    const latiumHits = searchCatalogClubs({ q: 'Latium', pageSize: 20 }, db).items;
    assert.ok(
      latiumHits.some((c) => c.externalTeamId === '46'),
      'Latium alias should find Lazio (team_id=46)'
    );

    // Verify cross-country Premier League separation (England vs Ukraine)
    const ukrLeague = db
      .prepare(`SELECT id, name, country_name FROM catalog_leagues WHERE external_source_id = 'league_332'`)
      .get() as { id: string; name: string; country_name: string } | undefined;
    assert.ok(ukrLeague, 'Ukraine Premier League (league_332) must exist distinctly');
    assert.equal(ukrLeague.country_name, 'Ukraine');

    // Re-run reconciliation -> MUST be 100% idempotent
    const secondRun = executeCatalogReconciliationFromPlayers(db);
    assert.equal(secondRun.clubsInserted, 0, 'Second reconciliation must insert 0 clubs');
    assert.equal(secondRun.leaguesInserted, 0, 'Second reconciliation must insert 0 leagues');
    assert.equal(secondRun.nationsInserted, 0, 'Second reconciliation must insert 0 nations');
    assert.equal(secondRun.coverageAfter.duplicateClubChecks.length, 0);

    // Workstream D: Create Career Mode club linked to Everton and import default roster safely
    const evertonCatalog = searchCatalogClubs({ q: 'Everton', pageSize: 20 }, db).items.find(
      (c) => c.name === 'Everton'
    );
    assert.ok(evertonCatalog, 'Everton must be discoverable in club catalog search');

    const rosterPreview = repo.previewDefaultClubRosterByCatalogClubId(evertonCatalog.id);
    assert.equal(rosterPreview.totalMatchedPlayers, 3);

    const evertonCareer = repo.createClub(
      defaultClubInput('Everton', {
        catalogClubId: evertonCatalog.id,
        rosterInitMode: 'default_roster',
      })
    );

    const careerSquad1 = repo.listPlayers(evertonCareer.id);
    assert.equal(careerSquad1.length, 3);

    // Modify a career player to loaned_out and verify repeat import NEVER duplicates or reactivates
    repo.updatePlayer(careerSquad1[0].id, { squadStatus: 'loaned_out', overallRating: 91 });
    const repeatImport = repo.importDefaultClubRoster(evertonCareer.id);
    assert.equal(repeatImport.importedCount, 0);
    assert.equal(repeatImport.skippedDuplicatesCount, 3);

    const careerSquad2 = repo.listPlayers(evertonCareer.id);
    assert.equal(careerSquad2.length, 3);
    const modifiedAfter = careerSquad2.find((p) => p.id === careerSquad1[0].id);
    assert.equal(modifiedAfter?.squadStatus, 'loaned_out');
    assert.equal(modifiedAfter?.overallRating, 91);

    const coverage = getCatalogCoverageReport(db);
    assert.equal(coverage.premierLeagueVerification.evertonPresent, true);
    assert.equal(coverage.premierLeagueVerification.clubCount, 20);
  });

  // ---------------------------------------------------------------------------
  // WORKSTREAM E & F — DIAGNOSTICS LIFETIME METRICS & PHASE 3 READINESS
  // ---------------------------------------------------------------------------

  test('E1/F1: Lifetime FFmpeg stdin metric structure & analysis_state transitions distinguish Verified vs Awaiting Phase 3', () => {
    const diag = createEmptyPipelineDiagnostics();
    assert.equal(diag.ffmpegStdinBytesWritten, 0);
    assert.equal(diag.currentProcessStdinBytesWritten, 0);
    assert.equal(diag.lifetimeSessionStdinBytesWritten, 0);

    const club = repo.createClub(defaultClubInput('Phase 3 Readiness FC'));
    const opponent = repo.createOpponent({
      name: 'Readiness Athletic',
      league: 'Premier League',
      typicalFormation: '4-3-3 Holding',
      strengths: '',
      weaknesses: '',
      dangerousChannels: '',
      notes: '',
    });
    const match = repo.createMatch({
      clubId: club.id,
      careerProfileId: club.profile.id,
      opponentId: opponent.id,
      matchDate: '2026-10-03',
      competition: 'Premier League',
      venue: 'home',
      startingFormation: '4-2-3-1 Wide',
      startingXiIds: [],
      benchIds: [],
      objective: 'win',
      preMatchNotes: '',
      tacticalSetup: {
        buildUpStyle: 'Balanced',
        defensiveApproach: 'High',
        defensiveLineHeight: 60,
        playerAssignments: [],
      },
    });

    const session = repo.createOrUpsertMatchSession({
      matchId: match.id,
      half: 'first_half',
      status: 'recording',
      captureSourceId: 'window:fc26',
      captureSourceName: 'EA SPORTS FC 26',
      resolution: '1280x720',
      fps: 30,
    });
    assert.equal(session.analysisState, 'not_ready');
    assert.equal(session.aiEligible, false);

    repo.upsertRecordingSegment({
      sessionId: session.id,
      matchId: match.id,
      segmentIndex: 1,
      filePath: path.join(tempDir, 'segment_001.mp4'),
      durationSeconds: 45,
      sizeBytes: 18_273_756,
      checksum: 'abc123verifiedsha256',
      status: 'finalized',
      resolution: '1280x720',
      fps: 30,
      codec: 'h264',
      hasAudio: false,
      integrityStatus: 'verified',
    });

    const finalized = repo.updateMatchSession(session.id, {
      status: 'completed',
      integrityStatus: 'verified',
      aiEligible: true,
      durationSeconds: 45,
      totalBytes: 18_273_756,
    });
    assert.ok(finalized);
    assert.equal(finalized.integrityStatus, 'verified');
    assert.equal(finalized.aiEligible, true);
    assert.equal(finalized.analysisState, 'verified_awaiting_phase3');

    const db = getDb();
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    assert.equal(fkViolations.length, 0, 'SQLite foreign_key_check must return 0 violations');
  });

  // ---------------------------------------------------------------------------
  // RUNNER
  // ---------------------------------------------------------------------------

  let passed = 0;
  let failed = 0;

  console.log(`\nRunning Phase 2.2 Automated Acceptance Tests (${tests.length} tests)`);
  console.log(`Isolated temp SQLite directory: ${tempDir}\n`);

  for (const t of tests) {
    try {
      await t.run();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (error) {
      failed++;
      console.error(`  [FAIL] ${t.name}`);
      console.error(`         ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
  }

  closeDb();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failure
  }

  console.log(`\nPhase 2.2 Tests Complete: ${passed}/${tests.length} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
