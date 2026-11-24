import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb } from '../../server/db/database.ts';
import {
  executeCatalogImport,
  previewCatalogImport,
  rollbackCatalogImportRun,
} from '../../server/services/catalogImporter.ts';
import {
  EAFC26_DATAHUB_SOURCE_KEY,
  detectPlayerSourceProfile,
} from '../../server/services/playerImportAdapters/eafc26DataHub.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc26-datahub-adapter-test-'));
process.env.FC26_USER_DATA_DIR = tmpDir;

const DATAHUB_HEADERS = [
  'player_id',
  'player_url',
  'short_name',
  'long_name',
  'player_positions',
  'overall',
  'potential',
  'value_eur',
  'wage_eur',
  'age',
  'dob',
  'height_cm',
  'weight_kg',
  'club_team_id',
  'club_name',
  'league_id',
  'league_name',
  'league_level',
  'club_position',
  'club_jersey_number',
  'club_contract_valid_until_year',
  'nationality_id',
  'nationality_name',
  'preferred_foot',
  'weak_foot',
  'skill_moves',
  'work_rate',
  'body_type',
  'real_face',
  'release_clause_eur',
  'player_traits',
  'pace',
  'shooting',
  'passing',
  'dribbling',
  'defending',
  'physic',
  'attacking_crossing',
  'attacking_finishing',
  'movement_acceleration',
  'power_stamina',
  'mentality_vision',
  'goalkeeping_diving',
  'player_face_url',
  'club_logo_url',
  'nation_flag_url',
];

function csvRow(values: Record<string, string>): string {
  return DATAHUB_HEADERS.map((h) => {
    const v = values[h] ?? '';
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');
}

function buildDataHubCsv(rows: Array<Record<string, string>>): string {
  return [DATAHUB_HEADERS.join(','), ...rows.map(csvRow)].join('\n');
}

let passed = 0;
function runTest(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`PASS: ${name}`);
}

try {
  const db = getDb();

  // Seed an operational Career Mode club + player to prove catalog imports never touch operational tables
  const opClubId = '11111111-1111-4111-8111-111111111111';
  const opPlayerId = '22222222-2222-4222-8222-222222222222';
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO clubs (id, name, league, nation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(opClubId, 'Test Operational FC', 'Eredivisie', 'Netherlands', now, now);
  db.prepare(
    `INSERT INTO players (id, club_id, name, position, overall_rating, preferred_foot, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(opPlayerId, opClubId, 'Operational Squad Player', 'ST', 82, 'Right', now, now);

  const sampleDataHubCsv = buildDataHubCsv([
    {
      player_id: '239380',
      player_url: 'https://sofifa.com/player/239380/noa-lang/',
      short_name: 'Noa Lang',
      long_name: 'Noa Noëll Lang',
      player_positions: 'LW, LM',
      overall: '80',
      potential: '81',
      value_eur: '25000000',
      wage_eur: '42000',
      age: '26',
      dob: '1999-06-17',
      height_cm: '179',
      weight_kg: '70',
      club_team_id: '247',
      club_name: 'PSV',
      league_id: '10',
      league_name: 'Eredivisie',
      league_level: '1',
      club_position: 'LW',
      club_jersey_number: '10',
      club_contract_valid_until_year: '2028.0',
      nationality_id: '34',
      nationality_name: 'Netherlands',
      preferred_foot: 'Right',
      weak_foot: '4',
      skill_moves: '4',
      work_rate: 'High/Medium',
      body_type: 'Lean (170-185)',
      real_face: 'Yes',
      release_clause_eur: '',
      player_traits: 'Technical, Flair, Trickster',
      pace: '86',
      shooting: '76',
      passing: '77',
      dribbling: '85',
      defending: '38',
      physic: '68',
      attacking_crossing: '79',
      attacking_finishing: '75',
      movement_acceleration: '88',
      power_stamina: '78',
      mentality_vision: '80',
      goalkeeping_diving: 'NaN',
      player_face_url: 'https://cdn.example.invalid/faces/239380.png',
      club_logo_url: 'https://cdn.example.invalid/clubs/247.png',
      nation_flag_url: 'https://cdn.example.invalid/flags/nl.png',
    },
    {
      player_id: '252371',
      short_name: 'J. Bellingham',
      long_name: 'Jude Victor William Bellingham',
      player_positions: 'CM, LM, CAM, CM',
      overall: '90',
      potential: '94',
      value_eur: '174500000',
      wage_eur: '280000',
      age: '22',
      height_cm: '186',
      weight_kg: '75',
      club_name: 'Real Madrid',
      league_name: 'LALIGA EA SPORTS',
      club_contract_valid_until_year: '2029',
      nationality_name: 'England',
      preferred_foot: 'Right',
      weak_foot: '4',
      skill_moves: '4',
      pace: '80',
      shooting: '87',
      passing: '83',
      dribbling: '90',
      defending: '78',
      physic: '84',
      attacking_finishing: '88',
      movement_acceleration: '81',
      power_stamina: '93',
      mentality_vision: '89',
      player_face_url: 'https://cdn.example.invalid/faces/252371.png',
    },
    {
      // Test F: empty long_name -> fallback to short_name
      player_id: '999001',
      short_name: 'Fallback Wing',
      long_name: '',
      player_positions: 'RW',
      overall: '74',
      potential: '82',
      age: '19',
      nationality_name: 'Spain',
      physic: '61',
      club_contract_valid_until_year: '2027.0',
    },
  ]);

  const preview = previewCatalogImport(db, 'players', 'csv', sampleDataHubCsv);

  runTest('Test A — DataHub Name Mapping & ID Namespacing', () => {
    assert.equal(preview.schemaDiagnostics?.profileId, 'eafc26_datahub_csv');
    assert.equal(preview.schemaDiagnostics?.detectedSourceKey, EAFC26_DATAHUB_SOURCE_KEY);
    assert.equal(preview.totalRows, 3);
    assert.equal(preview.validCount, 3);
    assert.equal(preview.rejectedCount, 0);

    const noa = preview.sampleRows[0];
    assert.equal(noa.externalSourceId, 'eafc26_datahub_239380');
    assert.equal(noa.fullName, 'Noa Noëll Lang');
    assert.equal(noa.shortName, 'Noa Lang');
  });

  runTest('Test B — Position Mapping ("LW, LM")', () => {
    const noa = preview.sampleRows[0];
    assert.equal(noa.primaryPosition, 'LW');
    assert.deepEqual(noa.secondaryPositions, ['LM']);
  });

  runTest('Test C — Multiple Positions ("CM, LM, CAM") & Explicit Precedence', () => {
    const jude = preview.sampleRows[1];
    assert.equal(jude.primaryPosition, 'CM');
    assert.deepEqual(jude.secondaryPositions, ['LM', 'CAM']);

    // Explicit primary_position takes precedence over player_positions if both exist
    const hybridCsv =
      'player_id,long_name,primary_position,player_positions,overall\n' +
      '777,Hybrid Player,CAM,"CM, CAM, RW",84';
    const hybridPreview = previewCatalogImport(db, 'players', 'csv', hybridCsv);
    assert.equal(hybridPreview.validCount, 1);
    assert.equal(hybridPreview.sampleRows[0].primaryPosition, 'CAM');
    assert.deepEqual(hybridPreview.sampleRows[0].secondaryPositions, ['CM', 'RW']);
  });

  runTest('Test D — Attribute Mapping (overall, potential, physic, value_eur, contract year)', () => {
    const noa = preview.sampleRows[0];
    assert.equal(noa.overallRating, 80);
    assert.equal(noa.potentialRating, 81);
    assert.equal(noa.growth, 1);
    assert.equal(noa.physicality, 68);
    assert.equal(noa.marketValueEur, 25000000);
    assert.equal(noa.wageEur, 42000);
    assert.equal(noa.contractExpiry, '2028');
    assert.equal(noa.nationNameRaw, 'Netherlands');
  });

  runTest('Test E — Extended Attributes Preserved & Third-Party Image URLs Excluded', () => {
    const noa = preview.sampleRows[0];
    assert.equal(typeof noa.attributesJson, 'string');
    const attrs = JSON.parse(String(noa.attributesJson)) as Record<string, unknown>;

    assert.equal(attrs.movement_acceleration, 88);
    assert.equal(attrs.power_stamina, 78);
    assert.equal(attrs.mentality_vision, 80);
    assert.equal(attrs.attacking_finishing, 75);
    assert.equal(attrs.player_traits, 'Technical, Flair, Trickster');
    assert.equal(attrs.work_rate, 'High/Medium');
    // Blank strings and source "NaN" become JSON null
    assert.equal(attrs.release_clause_eur, null);
    assert.equal(attrs.goalkeeping_diving, null);
    // Third-party image & profile URLs must NEVER be stored
    assert.equal('player_face_url' in attrs, false);
    assert.equal('club_logo_url' in attrs, false);
    assert.equal('nation_flag_url' in attrs, false);
    assert.equal('player_url' in attrs, false);
    // Canonical columns must NOT be duplicated in attributes_json
    assert.equal('long_name' in attrs, false);
    assert.equal('overall' in attrs, false);
    assert.equal('physic' in attrs, false);
    assert.equal('value_eur' in attrs, false);

    assert.ok(
      preview.schemaDiagnostics?.ignoredMediaColumns.includes('player_face_url'),
      'player_face_url should be listed in ignoredMediaColumns'
    );
  });

  runTest('Test F — Fallback Name (empty long_name falls back to short_name)', () => {
    const fallback = preview.sampleRows[2];
    assert.equal(fallback.fullName, 'Fallback Wing');
    assert.equal(fallback.shortName, 'Fallback Wing');
    assert.equal(fallback.externalSourceId, 'eafc26_datahub_999001');
  });

  runTest('Test G — Backward Compatibility with Standard template_players.csv', () => {
    const templatePath = path.resolve(process.cwd(), 'data/fc26/players/template_players.csv');
    const templateRaw = fs.readFileSync(templatePath, 'utf8');
    const templatePreview = previewCatalogImport(db, 'players', 'csv', templateRaw);
    assert.equal(templatePreview.schemaDiagnostics?.profileId, 'fc26_standard_csv');
    assert.equal(templatePreview.schemaDiagnostics?.requiredFieldsMapped.name, true);
    assert.equal(templatePreview.schemaDiagnostics?.requiredFieldsMapped.position, true);
    assert.equal(templatePreview.totalRows, 0);

    const standardCsv =
      templateRaw.trim() +
      '\n' +
      'std_1001,Pedri González,Pedri,FC Barcelona,LALIGA EA SPORTS,Spain,CM,CAM|CDM,22,87,92,5,79,72,88,90,71,74,Right,4,4,174,60,99500000,190000,2030';
    const stdPreview = previewCatalogImport(db, 'players', 'csv', standardCsv);
    assert.equal(stdPreview.schemaDiagnostics?.profileId, 'fc26_standard_csv');
    assert.equal(stdPreview.validCount, 1);
    assert.equal(stdPreview.sampleRows[0].externalSourceId, 'std_1001');
    assert.equal(stdPreview.sampleRows[0].fullName, 'Pedri González');
    assert.equal(stdPreview.sampleRows[0].primaryPosition, 'CM');
    assert.deepEqual(stdPreview.sampleRows[0].secondaryPositions, ['CAM', 'CDM']);
    assert.equal(stdPreview.sampleRows[0].physicality, 74);

    const stdRun = executeCatalogImport(db, 'players', 'csv', standardCsv, {
      fileName: 'standard_regression.csv',
    });
    assert.equal(stdRun.insertedCount, 1);
    assert.equal(stdRun.rejectedCount, 0);
  });

  runTest('Test H — Duplicate & Re-Import Idempotency + Source Attribution + Rollback', () => {
    const run1 = executeCatalogImport(db, 'players', 'csv', sampleDataHubCsv, {
      fileName: 'datahub_sample.csv',
      mode: 'upsert',
    });
    assert.equal(run1.insertedCount, 3);
    assert.equal(run1.updatedCount, 0);
    assert.equal(run1.rejectedCount, 0);
    assert.ok(run1.sourceId, 'DataHub import must link source_id to catalog_sources');

    const sourceRow = db
      .prepare('SELECT source_key, name FROM catalog_sources WHERE id = ?')
      .get(run1.sourceId) as { source_key: string; name: string };
    assert.equal(sourceRow.source_key, EAFC26_DATAHUB_SOURCE_KEY);

    // Verify stored player attributes_json and secondary positions in SQLite
    const storedNoa = db
      .prepare(
        `SELECT id, full_name, short_name, primary_position, overall_rating, physicality, market_value_eur, contract_expiry, attributes_json
         FROM catalog_players WHERE external_source_id = 'eafc26_datahub_239380'`
      )
      .get() as Record<string, unknown>;
    assert.equal(storedNoa.full_name, 'Noa Noëll Lang');
    assert.equal(storedNoa.physicality, 68);
    assert.equal(storedNoa.market_value_eur, 25000000);
    assert.equal(storedNoa.contract_expiry, '2028');
    const storedAttrs = JSON.parse(String(storedNoa.attributes_json)) as Record<string, unknown>;
    assert.equal(storedAttrs.movement_acceleration, 88);
    assert.equal('player_face_url' in storedAttrs, false);

    const noaPositions = db
      .prepare(
        `SELECT position_code, is_primary FROM catalog_player_positions WHERE player_id = ? ORDER BY is_primary DESC, position_code ASC`
      )
      .all(storedNoa.id) as Array<{ position_code: string; is_primary: number }>;
    assert.deepEqual(noaPositions, [
      { position_code: 'LW', is_primary: 1 },
      { position_code: 'LM', is_primary: 0 },
    ]);

    // Re-import the exact same CSV with updated OVR for Noa Lang -> must UPDATE, 0 new inserts, 0 duplicates
    const updatedCsv = sampleDataHubCsv.replace(',80,81,', ',82,84,');
    const preview2 = previewCatalogImport(db, 'players', 'csv', updatedCsv);
    assert.equal(preview2.insertCount, 0);
    assert.equal(preview2.updateCount, 3);

    const run2 = executeCatalogImport(db, 'players', 'csv', updatedCsv, {
      fileName: 'datahub_sample_v2.csv',
      mode: 'upsert',
    });
    assert.equal(run2.insertedCount, 0);
    assert.equal(run2.updatedCount, 3);

    const totalDataHubPlayers = db
      .prepare(`SELECT COUNT(*) as c FROM catalog_players WHERE external_source_id LIKE 'eafc26_datahub_%'`)
      .get() as { c: number };
    assert.equal(totalDataHubPlayers.c, 3);

    const updatedNoa = db
      .prepare(`SELECT overall_rating, potential_rating FROM catalog_players WHERE external_source_id = 'eafc26_datahub_239380'`)
      .get() as { overall_rating: number; potential_rating: number };
    assert.equal(updatedNoa.overall_rating, 82);
    assert.equal(updatedNoa.potential_rating, 84);

    // Rollback run1 cleanly removes the 3 DataHub rows while keeping standard row intact
    const rb = rollbackCatalogImportRun(db, run1.id);
    assert.equal(rb.rolledBack, true);
    assert.equal(rb.deletedRows, 3);
  });

  runTest('Test I — Invalid Records & Schema Warnings Handled Explicitly', () => {
    const invalidDataHubCsv = buildDataHubCsv([
      {
        // Missing both long_name and short_name
        player_id: '5001',
        short_name: '',
        long_name: '',
        player_positions: 'ST',
        overall: '70',
      },
      {
        // Empty player_positions
        player_id: '5002',
        short_name: 'No Pos',
        long_name: 'No Position Player',
        player_positions: '',
        overall: '70',
      },
      {
        // Unsupported-only position codes (must NOT invent or silently remap)
        player_id: '5003',
        short_name: 'Bad Pos',
        long_name: 'Unsupported Pos Player',
        player_positions: 'ZZZ, RCM, SUB',
        overall: '70',
      },
      {
        // Valid row mixed in to verify partial rejection works cleanly
        player_id: '5004',
        short_name: 'Valid GK',
        long_name: 'Valid Goalkeeper',
        player_positions: 'GK',
        overall: '77',
      },
    ]);

    const invalidPreview = previewCatalogImport(db, 'players', 'csv', invalidDataHubCsv);
    assert.equal(invalidPreview.totalRows, 4);
    assert.equal(invalidPreview.validCount, 1);
    assert.equal(invalidPreview.rejectedCount, 3);
    assert.equal(invalidPreview.validationErrors.length, 3);
    assert.match(invalidPreview.validationErrors[0].message, /long_name and short_name are empty/i);
    assert.match(invalidPreview.validationErrors[1].message, /position is required/i);
    assert.match(invalidPreview.validationErrors[2].message, /Unrecognized code\(s\): ZZZ, RCM, SUB/i);

    // Schema-level diagnostics on completely unrecognized CSV headers
    const badSchemaDiag = detectPlayerSourceProfile(['col_a', 'col_b', 'col_c'], 'csv');
    assert.equal(badSchemaDiag.profileId, 'unknown_schema');
    assert.equal(badSchemaDiag.requiredFieldsMapped.name, false);
    assert.equal(badSchemaDiag.requiredFieldsMapped.position, false);
    assert.ok(badSchemaDiag.schemaWarnings.length >= 2);
  });

  runTest('Operational Safety — Career Mode players table untouched', () => {
    const opPlayer = db
      .prepare('SELECT id, name, overall_rating FROM players WHERE id = ?')
      .get(opPlayerId) as { id: string; name: string; overall_rating: number } | undefined;
    assert.ok(opPlayer);
    assert.equal(opPlayer.name, 'Operational Squad Player');
    assert.equal(opPlayer.overall_rating, 82);
  });

  console.log(`\nALL ${passed} TESTS PASSED.`);
} finally {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
