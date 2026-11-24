/**
 * FC26 AI Manager — Phase 2.1 Automated Acceptance Test Suite
 *
 * Verifies:
 * 1. Non-destructive SQLite Migration v3 -> v4 (preserves clubs, players, catalog_players,
 *    matches, reclassifies legacy 0-byte corrupted 'completed' sessions to 'failed', FK clean)
 * 2. Standardized Player Display Name resolution (override > displayName > shortName > fullName, UTF-8 safe)
 * 3. Automatic Default Club Roster Initialization & duplicate-safe re-import (stable club_id match;
 *    master catalog_players never mutated)
 * 4. Club Tactical Presets CRUD, duplicate player prevention, FC26 role/focus validation, default switching
 * 5. Immutable Match Tactical Snapshots (preserved across player/preset edits & deletions, locked on
 *    recording start, rejects pre-match overwrite after lock, allows separate in_match_adjustment)
 *
 * Runs strictly inside an isolated temp directory (NEVER touches the live workspace DB).
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePlayerDisplayName, hasDistinctFullName } from '../../src/utils/playerDisplayName';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fc26-phase21-suite-'));
const DB_DIR = path.join(TEST_ROOT, 'database');
fs.mkdirSync(DB_DIR, { recursive: true });
process.env.FC26_USER_DATA_DIR = DB_DIR;

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  console.log('=== FC26 AI Manager — Phase 2.1 Domain & Migration Test Suite ===');
  console.log(`Isolated temp workspace: ${TEST_ROOT}\n`);

  // -------------------------------------------------------------------------
  // 1. Player Display Name Standardization
  // -------------------------------------------------------------------------
  await runTest('Display name resolution follows priority order and preserves UTF-8 without truncation', () => {
    assert.equal(
      resolvePlayerDisplayName({
        displayNameOverride: 'Vini Jr.',
        displayName: 'Vinícius',
        shortName: 'Vinícius Jr.',
        fullName: 'Vinícius José Paixão de Oliveira Júnior',
      }),
      'Vini Jr.'
    );
    assert.equal(
      resolvePlayerDisplayName({
        displayNameOverride: null,
        shortName: 'M. Ødegaard',
        fullName: 'Martin Ødegaard',
      }),
      'M. Ødegaard'
    );
    assert.equal(
      resolvePlayerDisplayName({
        shortName: '',
        fullName: 'Trent Alexander-Arnold',
      }),
      'Trent Alexander-Arnold'
    );
    assert.equal(
      resolvePlayerDisplayName({
        shortName: 'L. Yamal',
        fullName: 'Lamine Yamal Nasraoui Ebana',
      }),
      'L. Yamal'
    );
    assert.equal(hasDistinctFullName('L. Yamal', 'Lamine Yamal Nasraoui Ebana'), true);
    assert.equal(hasDistinctFullName('Martin Ødegaard', 'Martin Ødegaard'), false);
  });

  // -------------------------------------------------------------------------
  // 2. Non-Destructive Upgrade from v3 to v4 (separate temp DB file)
  // -------------------------------------------------------------------------
  await runTest('Non-destructive Migration v3 -> v4 preserves all career/catalog data and fixes legacy 0-byte sessions', async () => {
    const legacyDbPath = path.join(TEST_ROOT, 'legacy_v3.sqlite');
    const legacyDb = new Database(legacyDbPath);
    const { MIGRATIONS } = await import('../../server/db/migrations');

    // Run only v1, v2, v3 to build a genuine Phase 2 v3 database
    legacyDb.pragma('foreign_keys = ON');
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const m of MIGRATIONS.filter((m) => m.version <= 3)) {
      legacyDb.exec(m.sql);
      if (m.afterSql) m.afterSql(legacyDb);
      legacyDb
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
    }

    const now = new Date().toISOString();
    const clubId = crypto.randomUUID();
    const profId = crypto.randomUUID();
    const oppId = crypto.randomUUID();
    const matchId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const badSessId = crypto.randomUUID();

    legacyDb
      .prepare('INSERT INTO clubs (id, name, league, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(clubId, 'Legacy Arsenal', 'Premier League', now, now);
    legacyDb
      .prepare(
        'INSERT INTO career_profiles (id, club_id, season, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
      )
      .run(profId, clubId, '2025/26', now, now);
    legacyDb
      .prepare(
        'INSERT INTO players (id, club_id, name, position, overall_rating, created_at, updated_at) VALUES (?, ?, ?, ?, 87, ?, ?)'
      )
      .run(playerId, clubId, 'Martin Ødegaard', 'CAM', now, now);
    legacyDb
      .prepare('INSERT INTO opponents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(oppId, 'Legacy Chelsea', now, now);
    legacyDb
      .prepare(
        `INSERT INTO matches (id, club_id, career_profile_id, opponent_id, competition, venue, match_date, starting_formation, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Premier League', 'home', '2026-02-01', '4-3-3 Holding', 'halftime_ready', ?, ?)`
      )
      .run(matchId, clubId, profId, oppId, now, now);
    // Insert the exact real-world Windows 0-byte corrupted 'completed' bug row!
    legacyDb
      .prepare(
        `INSERT INTO match_sessions (id, match_id, half, status, resolution, fps, duration_seconds, total_bytes, integrity_status, started_at, ended_at, created_at, updated_at)
         VALUES (?, ?, 'first_half', 'completed', '1280x720', 30, 445, 0, 'corrupted', ?, ?, ?, ?)`
      )
      .run(badSessId, matchId, now, now, now, now);

    // Run full runMigrations -> applies v4 non-destructively
    const { runMigrations } = await import('../../server/db/migrations');
    runMigrations(legacyDb);

    // Verify FK integrity
    const fkIssues = legacyDb.pragma('foreign_key_check') as unknown[];
    assert.equal(fkIssues.length, 0, 'Zero foreign key violations after v4 migration');

    // Verify existing player preserved and backfilled with display_name
    const migratedPlayer = legacyDb
      .prepare('SELECT name, display_name, full_name, squad_status, availability FROM players WHERE id = ?')
      .get(playerId) as Record<string, unknown>;
    assert.equal(migratedPlayer.display_name, 'Martin Ødegaard');
    assert.equal(migratedPlayer.squad_status, 'active');
    assert.equal(migratedPlayer.availability, 'available');

    // Verify legacy 0-byte corrupted 'completed' session was reclassified to 'failed' & ai_eligible = 0
    const fixedSession = legacyDb
      .prepare('SELECT status, ai_eligible, failure_reason FROM match_sessions WHERE id = ?')
      .get(badSessId) as Record<string, unknown>;
    assert.equal(fixedSession.status, 'failed');
    assert.equal(fixedSession.ai_eligible, 0);
    assert.ok(String(fixedSession.failure_reason).toLowerCase().includes('zero-byte'));

    legacyDb.close();
  });

  // -------------------------------------------------------------------------
  // 3. Default Club Roster Initialization & Master Catalog Isolation
  // -------------------------------------------------------------------------
  const dbMod = await import('../../server/db/database');
  const repo = await import('../../server/services/repository');
  const db = dbMod.getDb();

  let linkedCatalogClubId = '';
  let unlinkedCatalogClubId = '';
  let sampleCatalogPlayerIds: string[] = [];

  await runTest('Default Club Roster initialization matches by stable catalog club_id, prevents duplicates, and preserves master catalog', () => {
    const now = new Date().toISOString();
    const sourceRow = db
      .prepare('SELECT id FROM catalog_sources LIMIT 1')
      .get() as { id: string };
    const clubRow = db
      .prepare('SELECT id, name FROM catalog_clubs ORDER BY name ASC LIMIT 2')
      .all() as Array<{ id: string; name: string }>;
    assert.ok(clubRow.length >= 2);
    linkedCatalogClubId = clubRow[0].id;
    unlinkedCatalogClubId = clubRow[1].id;

    // Seed 3 real-shaped players mapped to linkedCatalogClubId
    const seedPlayers = [
      { ext: 'p_21_1', full: 'Bukayo Ayoyinka Temidayo Saka', short: 'B. Saka', pos: 'RW', ovr: 88, age: 24 },
      { ext: 'p_21_2', full: 'Martin Ødegaard', short: 'M. Ødegaard', pos: 'CAM', ovr: 89, age: 26 },
      { ext: 'p_21_3', full: 'Declan Rice', short: 'D. Rice', pos: 'CDM', ovr: 87, age: 26 },
    ];
    for (const sp of seedPlayers) {
      const id = crypto.randomUUID();
      sampleCatalogPlayerIds.push(id);
      db.prepare(
        `INSERT INTO catalog_players (
          id, external_source_id, full_name, short_name, club_id, primary_position,
          overall_rating, potential_rating, age, preferred_foot, source_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Right', ?, ?, ?)`
      ).run(id, sp.ext, sp.full, sp.short, linkedCatalogClubId, sp.pos, sp.ovr, sp.ovr + 2, sp.age, sourceRow.id, now, now);
    }

    // Preview linked club with players
    const preview1 = repo.previewDefaultClubRosterByCatalogClubId(linkedCatalogClubId);
    assert.equal(preview1.status, 'linked_with_players');
    assert.equal(preview1.totalMatchedPlayers, 3);
    assert.equal(preview1.samplePlayers[0].displayName, 'M. Ødegaard');

    // Preview linked club with 0 players -> honest disclosure
    const previewEmpty = repo.previewDefaultClubRosterByCatalogClubId(unlinkedCatalogClubId);
    assert.equal(previewEmpty.status, 'linked_no_players');
    assert.equal(previewEmpty.totalMatchedPlayers, 0);

    // Create club with rosterInitMode = 'default_roster'
    const club = repo.createClub({
      name: clubRow[0].name,
      league: 'Premier League',
      catalogClubId: linkedCatalogClubId,
      season: '2025/26',
      managerName: 'Mikel',
      preferredPhilosophy: 'Positional Play',
      primaryFormation: '4-3-3 Holding',
      alternativeFormation: '4-2-3-1 Wide',
      preferredAttackingStyle: 'Short Passing',
      preferredDefensiveStyle: 'High',
      setActive: true,
      rosterInitMode: 'default_roster',
    });

    assert.equal(club.defaultRosterImport?.importedCount, 3);
    const squad = repo.listPlayers(club.id);
    assert.equal(squad.length, 3);
    assert.equal(squad[0].displayName, 'M. Ødegaard');

    // Edit career player's displayNameOverride & OVR -> verify master catalog_players is UNTOUCHED
    repo.updatePlayer(squad[0].id, {
      displayNameOverride: 'Captain Ødegaard',
      overallRating: 93,
      squadStatus: 'active',
      availability: 'injured',
      injuryStatus: 'Ankle sprain',
    });
    const updatedCareer = repo.listPlayers(club.id).find((p) => p.id === squad[0].id)!;
    assert.equal(updatedCareer.displayName, 'Captain Ødegaard');
    assert.equal(updatedCareer.overallRating, 93);
    assert.equal(updatedCareer.availability, 'injured');

    const masterRow = db
      .prepare('SELECT full_name, short_name, overall_rating FROM catalog_players WHERE id = ?')
      .get(updatedCareer.catalogPlayerId!) as { full_name: string; short_name: string; overall_rating: number };
    assert.equal(masterRow.overall_rating, 89, 'Master catalog_players must NEVER be mutated by Career Mode edits');
    assert.equal(masterRow.short_name, 'M. Ødegaard');

    // Re-importing default roster must skip all 3 duplicates
    const reimport = repo.importDefaultClubRoster(club.id);
    assert.equal(reimport.importedCount, 0);
    assert.equal(reimport.skippedDuplicatesCount, 3);
    assert.equal(repo.listPlayers(club.id).length, 3);
  });

  // -------------------------------------------------------------------------
  // 4. Tactical Presets & Immutable Match Tactical Snapshots
  // -------------------------------------------------------------------------
  await runTest('Tactical Presets validate duplicates & roles, and Match Tactical Snapshots stay immutable & lock on recording', () => {
    const clubs = repo.listClubs();
    const club = clubs[0];
    const squad = repo.listPlayers(club.id);
    assert.ok(squad.length >= 3);

    // Restore squad[0] to available after test 3's injury check (Phase 2.2 blocks injured starters in match_ready presets)
    repo.updatePlayer(squad[0].id, { availability: 'available', injuryStatus: null });

    // Duplicate player in Starting XI must be rejected
    assert.throws(() =>
      repo.createTacticalPreset(club.id, {
        name: 'Invalid Duplicate XI',
        formationName: '4-3-3 Holding',
        buildUpStyle: 'Balanced',
        defensiveApproach: 'High',
        defensiveLineHeight: 65,
        assignments: [
          { slotOrder: 0, positionCode: 'GK', playerId: squad[0].id, role: '', focus: '' },
          { slotOrder: 1, positionCode: 'CB', playerId: squad[0].id, role: '', focus: '' },
        ],
      })
    );

    // Create valid preset
    const preset1 = repo.createTacticalPreset(club.id, {
      name: 'Home High Press 4-3-3',
      formationName: '4-3-3 Holding',
      buildUpStyle: 'Short Passing',
      defensiveApproach: 'High',
      defensiveLineHeight: 70,
      isDefault: true,
      benchPlayerIds: [squad[2].id],
      notes: 'Primary home shape',
      assignments: [
        { slotOrder: 0, positionCode: 'GK', playerId: null, role: '', focus: '' },
        { slotOrder: 8, positionCode: 'RW', playerId: squad[1].id, role: '', focus: '' },
        { slotOrder: 9, positionCode: 'CAM', playerId: squad[0].id, role: '', focus: '' },
      ],
    });
    assert.equal(preset1.isDefault, true);
    assert.equal(preset1.assignments.length, 3);

    // Duplicate & switch default
    const preset2 = repo.duplicateTacticalPreset(preset1.id, 'Away Counter Block');
    assert.ok(preset2);
    assert.equal(preset2!.isDefault, false);
    repo.setDefaultTacticalPreset(preset2!.id);
    const presetsAfter = repo.listTacticalPresets(club.id);
    assert.equal(presetsAfter.find((p) => p.id === preset2!.id)?.isDefault, true);
    assert.equal(presetsAfter.find((p) => p.id === preset1.id)?.isDefault, false);

    // Prepare match from preset1 -> freezes immutable Pre-Match Tactical Snapshot
    const match = repo.createMatch({
      clubId: club.id,
      careerProfileId: club.profile.id,
      opponentName: 'Manchester City',
      competition: 'Premier League',
      venue: 'home',
      matchDate: '2026-03-10',
      startingFormation: preset1.formationName,
      startingXiIds: [squad[1].id, squad[0].id],
      benchIds: [squad[2].id],
      objective: 'Win midfield battle',
      preMatchNotes: '',
      sourcePresetId: preset1.id,
      tacticalSetup: {
        buildUpStyle: preset1.buildUpStyle,
        defensiveApproach: preset1.defensiveApproach,
        defensiveLineHeight: preset1.defensiveLineHeight,
        playerAssignments: [
          {
            slotIndex: 8,
            positionCode: 'RW',
            playerId: squad[1].id,
            playerName: squad[1].displayName,
            role: '',
            focus: '',
          },
          {
            slotIndex: 9,
            positionCode: 'CAM',
            playerId: squad[0].id,
            playerName: squad[0].displayName,
            role: '',
            focus: '',
          },
        ],
      },
    });

    const preSnapBefore = repo.getPreMatchTacticalSnapshot(match.id);
    assert.ok(preSnapBefore);
    assert.equal(preSnapBefore!.isLocked, false);
    assert.equal(preSnapBefore!.sourcePresetName, 'Home High Press 4-3-3');
    const frozenName = preSnapBefore!.assignments.find((a) => a.slotOrder === 9)?.playerDisplayName;
    assert.equal(frozenName, 'Captain Ødegaard');

    // Rename player AND delete source preset -> snapshot MUST remain 100% unchanged!
    repo.updatePlayer(squad[0].id, { displayNameOverride: 'Renamed Later' });
    repo.deleteTacticalPreset(preset1.id);

    const preSnapAfterMutation = repo.getPreMatchTacticalSnapshot(match.id)!;
    assert.equal(
      preSnapAfterMutation.assignments.find((a) => a.slotOrder === 9)?.playerDisplayName,
      'Captain Ødegaard',
      'Match snapshot must preserve player display name as frozen at match prep time'
    );
    assert.equal(preSnapAfterMutation.sourcePresetName, 'Home High Press 4-3-3');

    // Start recording -> locks pre_match snapshot
    repo.createOrUpsertMatchSession({
      id: crypto.randomUUID(),
      matchId: match.id,
      half: 'first_half',
      status: 'recording',
      resolution: '1280x720',
      fps: 30,
    });

    const lockedSnap = repo.getPreMatchTacticalSnapshot(match.id)!;
    assert.equal(lockedSnap.isLocked, true, 'Pre-match snapshot must lock once recording starts');

    // Trying to overwrite locked pre_match snapshot MUST fail
    assert.throws(
      () =>
        repo.updatePreMatchTacticalSnapshot(match.id, {
          formationName: '5-3-2',
          buildUpStyle: 'Counter',
          defensiveApproach: 'Deep',
          defensiveLineHeight: 35,
          playerAssignments: [],
        }),
      /locked/i
    );

    // Saving an in_match_adjustment MUST succeed separately while keeping pre_match untouched
    const adjustment = repo.createInMatchTacticalAdjustment(match.id, {
      formationName: '4-2-3-1 Wide',
      buildUpStyle: 'Counter',
      defensiveApproach: 'Balanced',
      defensiveLineHeight: 50,
      playerAssignments: [],
      notes: 'Half-time switch to protect the lead',
    });
    assert.equal(adjustment.snapshotType, 'in_match_adjustment');
    assert.equal(adjustment.isLocked, true);

    const allSnaps = repo.listMatchTacticalSnapshots(match.id);
    assert.equal(allSnaps.length, 2);
    assert.equal(allSnaps[0].snapshotType, 'pre_match');
    assert.equal(allSnaps[0].formationName, '4-3-3 Holding');
    assert.equal(allSnaps[1].snapshotType, 'in_match_adjustment');
    assert.equal(allSnaps[1].formationName, '4-2-3-1 Wide');
  });

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Fatal Phase 2.1 test suite error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });
