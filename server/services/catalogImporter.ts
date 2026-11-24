import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CatalogDatasetType,
  CatalogImportRun,
  DatasetCompleteness,
  ImportPreviewResult,
  ImportSchemaDiagnostics,
  ImportValidationError,
} from '../../src/types/domain.ts';
import {
  EAFC26_DATAHUB_SOURCE_KEY,
  EAFC26_DATAHUB_SOURCE_METADATA,
  VALID_FC26_POSITIONS,
  detectPlayerSourceProfile,
  normalizePlayerRecord,
} from './playerImportAdapters/eafc26DataHub.ts';

const VALID_POSITIONS = VALID_FC26_POSITIONS;

const MAX_STORED_ERRORS = 150;

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function parseCsvWithHeaders(rawCsv: string): {
  headers: string[];
  records: Array<Record<string, string>>;
} {
  const cleaned = rawCsv.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          currentField += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentField);
      currentField = '';
    } else if (ch === '\r') {
      if (cleaned[i + 1] === '\n') {
        i += 1;
      }
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
    } else if (ch === '\n') {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  const nonEmptyRows = rows.filter((r) => r.some((cell) => cell.trim().length > 0));
  if (nonEmptyRows.length === 0) return { headers: [], records: [] };

  const headers = nonEmptyRows[0].map((h) => h.trim()).filter(Boolean);
  if (nonEmptyRows.length < 2) return { headers, records: [] };

  const rawHeaders = nonEmptyRows[0].map((h) => h.trim());
  const records: Array<Record<string, string>> = [];

  for (let i = 1; i < nonEmptyRows.length; i += 1) {
    const values = nonEmptyRows[i];
    const obj: Record<string, string> = {};
    for (let j = 0; j < rawHeaders.length; j += 1) {
      const key = rawHeaders[j];
      if (!key) continue;
      obj[key] = (values[j] ?? '').trim();
    }
    records.push(obj);
  }

  return { headers, records };
}

export function parseCsvRecords(rawCsv: string): Array<Record<string, string>> {
  return parseCsvWithHeaders(rawCsv).records;
}

function getField(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }
  return undefined;
}

function toStringOrEmpty(val: unknown): string {
  if (val === undefined || val === null) return '';
  return String(val).trim();
}

function toNullableInt(val: unknown, min?: number, max?: number): number | null {
  if (val === undefined || val === null || val === '') return null;
  const cleaned = String(val).replace(/[€£$,\s]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  if (min !== undefined && rounded < min) return null;
  if (max !== undefined && rounded > max) return null;
  return rounded;
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function normalizeTeamCategory(val: unknown): 'mens' | 'womens' {
  const s = toStringOrEmpty(val).toLowerCase();
  if (s === 'womens' || s === 'women' || s === 'female' || s === 'f') return 'womens';
  return 'mens';
}

function normalizeLeagueCategory(val: unknown): 'mens' | 'womens' | 'mixed' {
  const s = toStringOrEmpty(val).toLowerCase();
  if (s === 'womens' || s === 'women' || s === 'female' || s === 'f') return 'womens';
  if (s === 'mixed') return 'mixed';
  return 'mens';
}

function extractJsonHeaders(records: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const sampleLimit = Math.min(records.length, 20);
  for (let i = 0; i < sampleLimit; i += 1) {
    const rec = records[i];
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
      for (const key of Object.keys(rec)) {
        if (key.trim()) seen.add(key.trim());
      }
    }
  }
  return Array.from(seen);
}

function parseRawPayload(
  datasetType: CatalogDatasetType,
  format: 'json' | 'csv',
  rawContent: string
): {
  headers: string[];
  records: Array<Record<string, unknown>>;
  extraCompatibility?: Array<Record<string, unknown>>;
  meta?: {
    datasetVersion?: string;
    sourceKey?: string;
    completeness?: DatasetCompleteness;
  };
} {
  if (format === 'csv') {
    const { headers, records } = parseCsvWithHeaders(rawContent);
    return { headers, records };
  }

  const parsed = JSON.parse(rawContent) as unknown;
  if (Array.isArray(parsed)) {
    const records = parsed as Array<Record<string, unknown>>;
    return { headers: extractJsonHeaders(records), records };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const meta = {
      datasetVersion: typeof obj.datasetVersion === 'string' ? obj.datasetVersion : undefined,
      sourceKey: typeof obj.sourceKey === 'string' ? obj.sourceKey : undefined,
      completeness: typeof obj.completeness === 'string'
        ? (obj.completeness as DatasetCompleteness)
        : undefined,
    };

    if (datasetType === 'focuses' && Array.isArray(obj.focuses)) {
      const records = obj.focuses as Array<Record<string, unknown>>;
      return {
        headers: extractJsonHeaders(records),
        records,
        extraCompatibility: Array.isArray(obj.compatibility)
          ? (obj.compatibility as Array<Record<string, unknown>>)
          : undefined,
        meta,
      };
    }
    if (datasetType === 'sources' && Array.isArray(obj.sources)) {
      const records = obj.sources as Array<Record<string, unknown>>;
      return { headers: extractJsonHeaders(records), records, meta };
    }
    if (Array.isArray(obj.records)) {
      const records = obj.records as Array<Record<string, unknown>>;
      return { headers: extractJsonHeaders(records), records, meta };
    }
    if (Array.isArray(obj.items)) {
      const records = obj.items as Array<Record<string, unknown>>;
      return { headers: extractJsonHeaders(records), records, meta };
    }
  }

  throw new Error(`Unsupported JSON structure for dataset "${datasetType}". Expected an array or an object with a "records" array.`);
}

interface NormalizedRow {
  key: string;
  data: Record<string, unknown>;
}

function validateAndNormalizeRows(
  datasetType: CatalogDatasetType,
  rawRecords: Array<Record<string, unknown>>,
  playerProfile?: ImportSchemaDiagnostics
): {
  validRows: NormalizedRow[];
  errors: ImportValidationError[];
  duplicatesInFile: number;
} {
  const validRows: NormalizedRow[] = [];
  const errors: ImportValidationError[] = [];
  const seenKeys = new Set<string>();
  let duplicatesInFile = 0;

  const pushError = (row: number, field: string, message: string) => {
    if (errors.length < MAX_STORED_ERRORS) {
      errors.push({ row, field, message });
    }
  };

  for (let i = 0; i < rawRecords.length; i += 1) {
    const rowNum = i + 1;
    const raw = rawRecords[i];
    if (!raw || typeof raw !== 'object') {
      pushError(rowNum, 'row', 'Row is not a valid object.');
      continue;
    }

    if (datasetType === 'sources') {
      const sourceKey = toStringOrEmpty(getField(raw, 'sourceKey', 'source_key'));
      const name = toStringOrEmpty(getField(raw, 'name'));
      const url = toStringOrEmpty(getField(raw, 'url'));
      if (!sourceKey || !name || !url) {
        pushError(rowNum, 'sourceKey/name/url', 'sourceKey, name, and url are required.');
        continue;
      }
      if (seenKeys.has(sourceKey)) duplicatesInFile += 1;
      seenKeys.add(sourceKey);
      validRows.push({
        key: sourceKey,
        data: {
          sourceKey,
          name,
          url,
          edition: toStringOrEmpty(getField(raw, 'edition')) || 'FC 26',
          licenseNotes: toStringOrEmpty(getField(raw, 'licenseNotes', 'license_notes')),
        },
      });
      continue;
    }

    if (datasetType === 'positions') {
      const code = toStringOrEmpty(getField(raw, 'code')).toUpperCase();
      const label = toStringOrEmpty(getField(raw, 'label'));
      const category = toStringOrEmpty(getField(raw, 'category')) || 'Midfielder';
      const tacticalLine = toStringOrEmpty(getField(raw, 'tacticalLine', 'tactical_line')).toUpperCase();
      if (!VALID_POSITIONS.has(code) || !label) {
        pushError(rowNum, 'code', `Invalid position code "${code}" or missing label.`);
        continue;
      }
      if (!['GK', 'DEF', 'MID', 'ATT'].includes(tacticalLine)) {
        pushError(rowNum, 'tacticalLine', `Invalid tactical line "${tacticalLine}".`);
        continue;
      }
      if (seenKeys.has(code)) duplicatesInFile += 1;
      seenKeys.add(code);
      validRows.push({
        key: code,
        data: {
          code,
          label,
          category,
          tacticalLine,
          sortOrder: toNullableInt(getField(raw, 'sortOrder', 'sort_order'), 0, 99) ?? rowNum,
        },
      });
      continue;
    }

    if (datasetType === 'nations') {
      const sourceName = toStringOrEmpty(getField(raw, 'sourceName', 'source_name', 'name'));
      const displayName = toStringOrEmpty(getField(raw, 'displayName', 'display_name')) || sourceName;
      if (!sourceName) {
        pushError(rowNum, 'sourceName', 'Nation name is required.');
        continue;
      }
      const externalSourceId =
        toStringOrEmpty(getField(raw, 'externalSourceId', 'external_source_id', 'id')) ||
        `nation_${toSlug(sourceName)}`;
      if (seenKeys.has(externalSourceId)) duplicatesInFile += 1;
      seenKeys.add(externalSourceId);
      validRows.push({
        key: externalSourceId,
        data: {
          externalSourceId,
          sourceName,
          displayName,
          isoCode: toStringOrEmpty(getField(raw, 'isoCode', 'iso_code')).toUpperCase(),
          region: toStringOrEmpty(getField(raw, 'region')),
        },
      });
      continue;
    }

    if (datasetType === 'leagues') {
      const name = toStringOrEmpty(getField(raw, 'name', 'league_name'));
      if (!name) {
        pushError(rowNum, 'name', 'League name is required.');
        continue;
      }
      const externalSourceId =
        toStringOrEmpty(getField(raw, 'externalSourceId', 'external_source_id', 'league_id', 'id')) ||
        `league_${toSlug(name)}`;
      if (seenKeys.has(externalSourceId)) duplicatesInFile += 1;
      seenKeys.add(externalSourceId);
      validRows.push({
        key: externalSourceId,
        data: {
          externalSourceId,
          name,
          countryName: toStringOrEmpty(getField(raw, 'countryName', 'country_name', 'country')),
          tier: toNullableInt(getField(raw, 'tier'), 1, 10),
          category: normalizeLeagueCategory(getField(raw, 'category')),
        },
      });
      continue;
    }

    if (datasetType === 'clubs') {
      const name = toStringOrEmpty(getField(raw, 'name', 'club_name'));
      if (!name) {
        pushError(rowNum, 'name', 'Club name is required.');
        continue;
      }
      const teamCategory = normalizeTeamCategory(getField(raw, 'teamCategory', 'team_category', 'category'));
      const externalSourceId =
        toStringOrEmpty(getField(raw, 'externalSourceId', 'external_source_id', 'club_id', 'id')) ||
        `club_${toSlug(name)}_${teamCategory}`;
      if (seenKeys.has(externalSourceId)) duplicatesInFile += 1;
      seenKeys.add(externalSourceId);
      validRows.push({
        key: externalSourceId,
        data: {
          externalSourceId,
          name,
          shortName: toStringOrEmpty(getField(raw, 'shortName', 'short_name')),
          leagueExternalId: toStringOrEmpty(getField(raw, 'leagueExternalId', 'league_external_id')),
          leagueName: toStringOrEmpty(getField(raw, 'leagueName', 'league_name', 'league')),
          countryName: toStringOrEmpty(getField(raw, 'countryName', 'country_name', 'nation', 'country')),
          teamCategory,
        },
      });
      continue;
    }

    if (datasetType === 'players') {
      const effectiveProfile =
        playerProfile ?? detectPlayerSourceProfile(Object.keys(raw), 'csv');
      const normalized = normalizePlayerRecord(raw, effectiveProfile);
      if (!normalized.ok) {
        pushError(rowNum, normalized.field, normalized.message);
        continue;
      }

      if (seenKeys.has(normalized.key)) duplicatesInFile += 1;
      seenKeys.add(normalized.key);

      validRows.push({
        key: normalized.key,
        data: normalized.data,
      });
      continue;
    }

    if (datasetType === 'formations') {
      const name = toStringOrEmpty(getField(raw, 'name'));
      const slots = Array.isArray(raw.slots) ? (raw.slots as Array<Record<string, unknown>>) : [];
      if (!name) {
        pushError(rowNum, 'name', 'Formation name is required.');
        continue;
      }
      if (slots.length !== 11) {
        pushError(rowNum, 'slots', `Formation "${name}" must define exactly 11 slots (found ${slots.length}).`);
        continue;
      }
      const badSlot = slots.find(
        (s) => !VALID_POSITIONS.has(toStringOrEmpty(s.positionCode).toUpperCase())
      );
      if (badSlot) {
        pushError(rowNum, 'slots', `Formation "${name}" contains invalid positionCode.`);
        continue;
      }
      const externalSourceId =
        toStringOrEmpty(getField(raw, 'externalSourceId', 'external_source_id')) ||
        `formation_${toSlug(name)}`;
      if (seenKeys.has(externalSourceId)) duplicatesInFile += 1;
      seenKeys.add(externalSourceId);
      validRows.push({
        key: externalSourceId,
        data: {
          externalSourceId,
          name,
          code: toStringOrEmpty(getField(raw, 'code')) || name,
          category: toStringOrEmpty(getField(raw, 'category')) || 'Back 4',
          defensiveShape: toStringOrEmpty(getField(raw, 'defensiveShape', 'defensive_shape')),
          attackingShape: toStringOrEmpty(getField(raw, 'attackingShape', 'attacking_shape')),
          tacticalSummary: toStringOrEmpty(getField(raw, 'tacticalSummary', 'tactical_summary')),
          gameModes: Array.isArray(raw.gameModes) ? raw.gameModes.map(String) : ['Career Mode'],
          careerModeStatus:
            toStringOrEmpty(getField(raw, 'careerModeStatus', 'career_mode_status')) || 'verified',
          layoutVerified: raw.layoutVerified !== false,
          slots: slots.map((s, idx) => ({
            slotOrder: Number(s.slotOrder ?? idx),
            positionCode: toStringOrEmpty(s.positionCode).toUpperCase(),
            positionLabel: toStringOrEmpty(s.positionLabel) || toStringOrEmpty(s.positionCode).toUpperCase(),
            x: Math.max(0, Math.min(100, Number(s.x ?? 50))),
            y: Math.max(0, Math.min(100, Number(s.y ?? 50))),
            tacticalLine: toStringOrEmpty(s.tacticalLine).toUpperCase() || 'MID',
          })),
        },
      });
      continue;
    }

    if (datasetType === 'roles') {
      const name = toStringOrEmpty(getField(raw, 'name'));
      if (!name) {
        pushError(rowNum, 'name', 'Role name is required.');
        continue;
      }
      const externalSourceId =
        toStringOrEmpty(getField(raw, 'externalSourceId', 'external_source_id')) ||
        `role_${toSlug(name)}`;
      const eligibleRaw = getField(raw, 'eligiblePositions', 'eligible_positions');
      const eligiblePositions = Array.isArray(eligibleRaw)
        ? eligibleRaw.map((p) => String(p).trim().toUpperCase()).filter((p) => VALID_POSITIONS.has(p))
        : typeof eligibleRaw === 'string'
          ? eligibleRaw
              .split(/[|;,]+/)
              .map((p) => p.trim().toUpperCase())
              .filter((p) => VALID_POSITIONS.has(p))
          : [];
      if (seenKeys.has(externalSourceId)) duplicatesInFile += 1;
      seenKeys.add(externalSourceId);
      validRows.push({
        key: externalSourceId,
        data: {
          externalSourceId,
          name,
          description: toStringOrEmpty(getField(raw, 'description')),
          positionCategory: toStringOrEmpty(getField(raw, 'positionCategory', 'position_category')) || 'Midfielder',
          tacticalBehavior: toStringOrEmpty(getField(raw, 'tacticalBehavior', 'tactical_behavior')),
          attackingBehavior: toStringOrEmpty(getField(raw, 'attackingBehavior', 'attacking_behavior')),
          defensiveBehavior: toStringOrEmpty(getField(raw, 'defensiveBehavior', 'defensive_behavior')),
          isFc26New: Boolean(getField(raw, 'isFc26New', 'is_fc26_new')),
          verificationStatus: toStringOrEmpty(getField(raw, 'verificationStatus')) === 'unverified' ? 'unverified' : 'verified',
          sourceReference: toStringOrEmpty(getField(raw, 'sourceReference', 'source_reference')),
          eligiblePositions,
        },
      });
      continue;
    }

    if (datasetType === 'focuses') {
      const name = toStringOrEmpty(getField(raw, 'name'));
      if (!name) {
        pushError(rowNum, 'name', 'Focus name is required.');
        continue;
      }
      const externalSourceId =
        toStringOrEmpty(getField(raw, 'externalSourceId', 'external_source_id')) ||
        `focus_${toSlug(name)}`;
      if (seenKeys.has(externalSourceId)) duplicatesInFile += 1;
      seenKeys.add(externalSourceId);
      validRows.push({
        key: externalSourceId,
        data: {
          externalSourceId,
          name,
          description: toStringOrEmpty(getField(raw, 'description')),
          tacticalPurpose: toStringOrEmpty(getField(raw, 'tacticalPurpose', 'tactical_purpose')),
          isFc26Updated: Boolean(getField(raw, 'isFc26Updated', 'is_fc26_updated')),
          verificationStatus: toStringOrEmpty(getField(raw, 'verificationStatus')) === 'unverified' ? 'unverified' : 'verified',
          sourceReference: toStringOrEmpty(getField(raw, 'sourceReference', 'source_reference')),
        },
      });
      continue;
    }
  }

  return { validRows, errors, duplicatesInFile };
}

function getExistingKeySet(db: Database.Database, datasetType: CatalogDatasetType): Set<string> {
  const tableMap: Record<CatalogDatasetType, { table: string; col: string }> = {
    sources: { table: 'catalog_sources', col: 'source_key' },
    positions: { table: 'catalog_positions', col: 'code' },
    nations: { table: 'catalog_nations', col: 'external_source_id' },
    leagues: { table: 'catalog_leagues', col: 'external_source_id' },
    clubs: { table: 'catalog_clubs', col: 'external_source_id' },
    players: { table: 'catalog_players', col: 'external_source_id' },
    formations: { table: 'catalog_formations', col: 'external_source_id' },
    roles: { table: 'catalog_player_roles', col: 'external_source_id' },
    focuses: { table: 'catalog_player_focuses', col: 'external_source_id' },
  };
  const target = tableMap[datasetType];
  const rows = db.prepare(`SELECT ${target.col} as key FROM ${target.table}`).all() as Array<{ key: string }>;
  return new Set(rows.map((r) => String(r.key)));
}

function ensureKnownCatalogSource(db: Database.Database, sourceKey?: string): void {
  if (!sourceKey) return;
  if (sourceKey === EAFC26_DATAHUB_SOURCE_KEY) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO catalog_sources (
        id, source_key, name, url, edition, license_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      EAFC26_DATAHUB_SOURCE_METADATA.sourceKey,
      EAFC26_DATAHUB_SOURCE_METADATA.name,
      EAFC26_DATAHUB_SOURCE_METADATA.url,
      EAFC26_DATAHUB_SOURCE_METADATA.edition,
      EAFC26_DATAHUB_SOURCE_METADATA.licenseNotes,
      now,
      now
    );
  }
}

export function previewCatalogImport(
  db: Database.Database,
  datasetType: CatalogDatasetType,
  format: 'json' | 'csv',
  rawContent: string
): ImportPreviewResult {
  const checksum = computeSha256(rawContent);
  const { headers, records } = parseRawPayload(datasetType, format, rawContent);
  const schemaDiagnostics =
    datasetType === 'players' ? detectPlayerSourceProfile(headers, format) : undefined;
  const { validRows, errors, duplicatesInFile } = validateAndNormalizeRows(
    datasetType,
    records,
    schemaDiagnostics
  );
  const existingKeys = getExistingKeySet(db, datasetType);

  let insertCount = 0;
  let updateCount = 0;
  const countedKeys = new Set<string>();

  for (const row of validRows) {
    if (countedKeys.has(row.key)) continue;
    countedKeys.add(row.key);
    if (existingKeys.has(row.key)) {
      updateCount += 1;
    } else {
      insertCount += 1;
    }
  }

  return {
    datasetType,
    format,
    checksum,
    totalRows: records.length,
    validCount: validRows.length,
    insertCount,
    updateCount,
    rejectedCount: records.length - validRows.length,
    duplicatesInFile,
    sampleRows: validRows.slice(0, 8).map((r) => r.data),
    validationErrors: errors,
    schemaDiagnostics,
  };
}

export interface ExecuteImportOptions {
  fileName?: string;
  sourceKey?: string;
  datasetVersion?: string;
  completeness?: DatasetCompleteness;
  mode?: 'upsert' | 'insert_only' | 'replace_dataset';
}

export function executeCatalogImport(
  db: Database.Database,
  datasetType: CatalogDatasetType,
  format: 'json' | 'csv',
  rawContent: string,
  options: ExecuteImportOptions = {}
): CatalogImportRun {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const checksum = computeSha256(rawContent);
  const mode = options.mode ?? 'upsert';

  const { headers, records, extraCompatibility, meta } = parseRawPayload(
    datasetType,
    format,
    rawContent
  );
  const schemaDiagnostics =
    datasetType === 'players' ? detectPlayerSourceProfile(headers, format) : undefined;
  const { validRows, errors } = validateAndNormalizeRows(
    datasetType,
    records,
    schemaDiagnostics
  );

  const effectiveSourceKey =
    options.sourceKey ?? meta?.sourceKey ?? schemaDiagnostics?.detectedSourceKey ?? undefined;
  ensureKnownCatalogSource(db, effectiveSourceKey);

  const sourceRow = effectiveSourceKey
    ? (db
        .prepare('SELECT id, name FROM catalog_sources WHERE source_key = ?')
        .get(effectiveSourceKey) as { id: string; name: string } | undefined)
    : undefined;
  const sourceId = sourceRow?.id ?? null;

  const datasetVersion = options.datasetVersion ?? meta?.datasetVersion ?? '1.0.0';
  const completeness: DatasetCompleteness =
    options.completeness ?? meta?.completeness ?? 'user_imported';

  let insertedCount = 0;
  let updatedCount = 0;
  const rejectedCount = records.length - validRows.length;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO catalog_import_runs (
        id, dataset_type, source_id, file_name, format, dataset_version, completeness,
        checksum, mode, status, total_rows, inserted_count, updated_count, rejected_count,
        errors_json, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, 0, 0, ?, ?, ?, ?)
    `).run(
      runId,
      datasetType,
      sourceId,
      options.fileName ?? `${datasetType}.${format}`,
      format,
      datasetVersion,
      completeness,
      checksum,
      mode,
      records.length,
      rejectedCount,
      JSON.stringify(errors),
      startedAt,
      startedAt
    );

    const existingKeys = getExistingKeySet(db, datasetType);
    const now = new Date().toISOString();

    if (datasetType === 'sources') {
      const stmt = db.prepare(`
        INSERT INTO catalog_sources (id, source_key, name, url, edition, license_notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          name = excluded.name,
          url = excluded.url,
          edition = excluded.edition,
          license_notes = excluded.license_notes,
          updated_at = excluded.updated_at
      `);
      for (const row of validRows) {
        const d = row.data;
        const exists = existingKeys.has(row.key);
        if (exists && mode === 'insert_only') continue;
        stmt.run(
          crypto.randomUUID(),
          String(d.sourceKey),
          String(d.name),
          String(d.url),
          String(d.edition),
          String(d.licenseNotes),
          now,
          now
        );
        if (exists) updatedCount += 1;
        else {
          insertedCount += 1;
          existingKeys.add(row.key);
        }
      }
    } else if (datasetType === 'positions') {
      const stmt = db.prepare(`
        INSERT INTO catalog_positions (code, label, category, tactical_line, sort_order, source_id, import_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          label = excluded.label,
          category = excluded.category,
          tactical_line = excluded.tactical_line,
          sort_order = excluded.sort_order,
          source_id = COALESCE(excluded.source_id, catalog_positions.source_id),
          updated_at = excluded.updated_at
      `);
      for (const row of validRows) {
        const d = row.data;
        const exists = existingKeys.has(row.key);
        if (exists && mode === 'insert_only') continue;
        stmt.run(
          String(d.code),
          String(d.label),
          String(d.category),
          String(d.tacticalLine),
          Number(d.sortOrder),
          sourceId,
          runId,
          now,
          now
        );
        if (exists) updatedCount += 1;
        else {
          insertedCount += 1;
          existingKeys.add(row.key);
        }
      }
    } else if (datasetType === 'nations') {
      const stmt = db.prepare(`
        INSERT INTO catalog_nations (id, external_source_id, source_name, display_name, iso_code, region, source_id, import_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_source_id) DO UPDATE SET
          source_name = excluded.source_name,
          display_name = excluded.display_name,
          iso_code = CASE WHEN excluded.iso_code <> '' THEN excluded.iso_code ELSE catalog_nations.iso_code END,
          region = CASE WHEN excluded.region <> '' THEN excluded.region ELSE catalog_nations.region END,
          source_id = COALESCE(excluded.source_id, catalog_nations.source_id),
          updated_at = excluded.updated_at
      `);
      for (const row of validRows) {
        const d = row.data;
        const exists = existingKeys.has(row.key);
        if (exists && mode === 'insert_only') continue;
        stmt.run(
          crypto.randomUUID(),
          String(d.externalSourceId),
          String(d.sourceName),
          String(d.displayName),
          String(d.isoCode),
          String(d.region),
          sourceId,
          runId,
          now,
          now
        );
        if (exists) updatedCount += 1;
        else {
          insertedCount += 1;
          existingKeys.add(row.key);
        }
      }
    } else if (datasetType === 'leagues') {
      const nations = db
        .prepare('SELECT id, source_name, display_name FROM catalog_nations')
        .all() as Array<{ id: string; source_name: string; display_name: string }>;
      const nationMap = new Map<string, string>();
      for (const n of nations) {
        nationMap.set(n.source_name.toLowerCase(), n.id);
        nationMap.set(n.display_name.toLowerCase(), n.id);
      }
      const stmt = db.prepare(`
        INSERT INTO catalog_leagues (id, external_source_id, name, country_id, country_name, tier, category, source_id, import_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_source_id) DO UPDATE SET
          name = excluded.name,
          country_id = COALESCE(excluded.country_id, catalog_leagues.country_id),
          country_name = excluded.country_name,
          tier = COALESCE(excluded.tier, catalog_leagues.tier),
          category = excluded.category,
          source_id = COALESCE(excluded.source_id, catalog_leagues.source_id),
          updated_at = excluded.updated_at
      `);
      for (const row of validRows) {
        const d = row.data;
        const exists = existingKeys.has(row.key);
        if (exists && mode === 'insert_only') continue;
        const countryName = String(d.countryName);
        const countryId = countryName ? nationMap.get(countryName.toLowerCase()) ?? null : null;
        stmt.run(
          crypto.randomUUID(),
          String(d.externalSourceId),
          String(d.name),
          countryId,
          countryName,
          d.tier as number | null,
          String(d.category),
          sourceId,
          runId,
          now,
          now
        );
        if (exists) updatedCount += 1;
        else {
          insertedCount += 1;
          existingKeys.add(row.key);
        }
      }
    } else if (datasetType === 'clubs') {
      const nations = db
        .prepare('SELECT id, source_name, display_name FROM catalog_nations')
        .all() as Array<{ id: string; source_name: string; display_name: string }>;
      const nationMap = new Map<string, string>();
      for (const n of nations) {
        nationMap.set(n.source_name.toLowerCase(), n.id);
        nationMap.set(n.display_name.toLowerCase(), n.id);
      }

      const leagues = db
        .prepare('SELECT id, external_source_id, name FROM catalog_leagues')
        .all() as Array<{ id: string; external_source_id: string; name: string }>;
      const leagueByExt = new Map<string, string>();
      const leagueByName = new Map<string, string>();
      for (const l of leagues) {
        leagueByExt.set(l.external_source_id, l.id);
        leagueByName.set(l.name.toLowerCase(), l.id);
      }

      const stmt = db.prepare(`
        INSERT INTO catalog_clubs (id, external_source_id, name, short_name, league_id, nation_id, team_category, source_id, import_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_source_id) DO UPDATE SET
          name = excluded.name,
          short_name = CASE WHEN excluded.short_name <> '' THEN excluded.short_name ELSE catalog_clubs.short_name END,
          league_id = COALESCE(excluded.league_id, catalog_clubs.league_id),
          nation_id = COALESCE(excluded.nation_id, catalog_clubs.nation_id),
          team_category = excluded.team_category,
          source_id = COALESCE(excluded.source_id, catalog_clubs.source_id),
          updated_at = excluded.updated_at
      `);
      for (const row of validRows) {
        const d = row.data;
        const exists = existingKeys.has(row.key);
        if (exists && mode === 'insert_only') continue;
        const leagueExt = String(d.leagueExternalId);
        const leagueName = String(d.leagueName);
        const countryName = String(d.countryName);
        const leagueId =
          (leagueExt ? leagueByExt.get(leagueExt) : undefined) ??
          (leagueName ? leagueByName.get(leagueName.toLowerCase()) : undefined) ??
          null;
        const nationId = countryName ? nationMap.get(countryName.toLowerCase()) ?? null : null;

        stmt.run(
          crypto.randomUUID(),
          String(d.externalSourceId),
          String(d.name),
          String(d.shortName),
          leagueId,
          nationId,
          String(d.teamCategory),
          sourceId,
          runId,
          now,
          now
        );
        if (exists) updatedCount += 1;
        else {
          insertedCount += 1;
          existingKeys.add(row.key);
        }
      }
    } else if (datasetType === 'players') {
      // Pre-load lookup maps into memory for fast 20,000+ batch ingestion
      const nations = db
        .prepare('SELECT id, external_source_id, source_name, display_name FROM catalog_nations')
        .all() as Array<{ id: string; external_source_id: string; source_name: string; display_name: string }>;
      const nationByExt = new Map<string, string>();
      const nationByName = new Map<string, string>();
      for (const n of nations) {
        nationByExt.set(n.external_source_id, n.id);
        nationByName.set(n.source_name.toLowerCase(), n.id);
        nationByName.set(n.display_name.toLowerCase(), n.id);
      }

      const leagues = db
        .prepare('SELECT id, external_source_id, name FROM catalog_leagues')
        .all() as Array<{ id: string; external_source_id: string; name: string }>;
      const leagueByExt = new Map<string, string>();
      const leagueByName = new Map<string, string>();
      for (const l of leagues) {
        leagueByExt.set(l.external_source_id, l.id);
        leagueByName.set(l.name.toLowerCase(), l.id);
      }

      const clubs = db
        .prepare('SELECT id, external_source_id, name, league_id FROM catalog_clubs')
        .all() as Array<{ id: string; external_source_id: string; name: string; league_id: string | null }>;
      const clubByExt = new Map<string, { id: string; leagueId: string | null }>();
      const clubByName = new Map<string, { id: string; leagueId: string | null }>();
      for (const c of clubs) {
        clubByExt.set(c.external_source_id, { id: c.id, leagueId: c.league_id });
        clubByName.set(c.name.toLowerCase(), { id: c.id, leagueId: c.league_id });
      }

      const existingPlayerIdMap = new Map<string, string>();
      const existingPlayers = db
        .prepare('SELECT id, external_source_id FROM catalog_players')
        .all() as Array<{ id: string; external_source_id: string }>;
      for (const p of existingPlayers) {
        existingPlayerIdMap.set(p.external_source_id, p.id);
      }

      const upsertPlayerStmt = db.prepare(`
        INSERT INTO catalog_players (
          id, external_source_id, full_name, short_name,
          club_id, league_id, nation_id,
          club_name_raw, league_name_raw, nation_name_raw,
          primary_position, age, overall_rating, potential_rating, growth,
          pace, shooting, passing, dribbling, defending, physicality,
          preferred_foot, weak_foot, skill_moves, height_cm, weight_kg,
          market_value_eur, wage_eur, contract_expiry, attributes_json,
          source_id, import_run_id, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?
        )
        ON CONFLICT(external_source_id) DO UPDATE SET
          full_name = excluded.full_name,
          short_name = excluded.short_name,
          club_id = COALESCE(excluded.club_id, catalog_players.club_id),
          league_id = COALESCE(excluded.league_id, catalog_players.league_id),
          nation_id = COALESCE(excluded.nation_id, catalog_players.nation_id),
          club_name_raw = excluded.club_name_raw,
          league_name_raw = excluded.league_name_raw,
          nation_name_raw = excluded.nation_name_raw,
          primary_position = excluded.primary_position,
          age = excluded.age,
          overall_rating = excluded.overall_rating,
          potential_rating = excluded.potential_rating,
          growth = excluded.growth,
          pace = excluded.pace,
          shooting = excluded.shooting,
          passing = excluded.passing,
          dribbling = excluded.dribbling,
          defending = excluded.defending,
          physicality = excluded.physicality,
          preferred_foot = excluded.preferred_foot,
          weak_foot = excluded.weak_foot,
          skill_moves = excluded.skill_moves,
          height_cm = excluded.height_cm,
          weight_kg = excluded.weight_kg,
          market_value_eur = excluded.market_value_eur,
          wage_eur = excluded.wage_eur,
          contract_expiry = excluded.contract_expiry,
          attributes_json = excluded.attributes_json,
          source_id = COALESCE(excluded.source_id, catalog_players.source_id),
          updated_at = excluded.updated_at
      `);

      const deletePositionsStmt = db.prepare('DELETE FROM catalog_player_positions WHERE player_id = ?');
      const insertPositionStmt = db.prepare(`
        INSERT OR IGNORE INTO catalog_player_positions (id, player_id, position_code, is_primary)
        VALUES (?, ?, ?, ?)
      `);

      for (const row of validRows) {
        const d = row.data;
        const extId = String(d.externalSourceId);
        const existingId = existingPlayerIdMap.get(extId);
        if (existingId && mode === 'insert_only') continue;

        const playerId = existingId ?? crypto.randomUUID();
        const clubRef =
          (d.clubExternalId ? clubByExt.get(String(d.clubExternalId)) : undefined) ??
          (d.clubNameRaw ? clubByName.get(String(d.clubNameRaw).toLowerCase()) : undefined);
        const clubId = clubRef?.id ?? null;

        const leagueId =
          (d.leagueExternalId ? leagueByExt.get(String(d.leagueExternalId)) : undefined) ??
          (d.leagueNameRaw ? leagueByName.get(String(d.leagueNameRaw).toLowerCase()) : undefined) ??
          clubRef?.leagueId ??
          null;

        const nationId =
          (d.nationExternalId ? nationByExt.get(String(d.nationExternalId)) : undefined) ??
          (d.nationNameRaw ? nationByName.get(String(d.nationNameRaw).toLowerCase()) : undefined) ??
          null;

        upsertPlayerStmt.run(
          playerId,
          extId,
          String(d.fullName),
          String(d.shortName),
          clubId,
          leagueId,
          nationId,
          String(d.clubNameRaw),
          String(d.leagueNameRaw),
          String(d.nationNameRaw),
          String(d.primaryPosition),
          d.age as number | null,
          d.overallRating as number | null,
          d.potentialRating as number | null,
          d.growth as number | null,
          d.pace as number | null,
          d.shooting as number | null,
          d.passing as number | null,
          d.dribbling as number | null,
          d.defending as number | null,
          d.physicality as number | null,
          d.preferredFoot as string | null,
          d.weakFoot as number | null,
          d.skillMoves as number | null,
          d.heightCm as number | null,
          d.weightKg as number | null,
          d.marketValueEur as number | null,
          d.wageEur as number | null,
          d.contractExpiry as string | null,
          d.attributesJson as string | null,
          sourceId,
          runId,
          now,
          now
        );

        deletePositionsStmt.run(playerId);
        insertPositionStmt.run(crypto.randomUUID(), playerId, String(d.primaryPosition), 1);
        for (const secPos of d.secondaryPositions as string[]) {
          insertPositionStmt.run(crypto.randomUUID(), playerId, secPos, 0);
        }

        if (existingId) {
          updatedCount += 1;
        } else {
          insertedCount += 1;
          existingPlayerIdMap.set(extId, playerId);
        }
      }
    } else if (datasetType === 'formations') {
      const existingMap = new Map<string, { id: string; isUserAdjusted: number }>();
      const rows = db
        .prepare('SELECT id, external_source_id, is_user_adjusted FROM catalog_formations')
        .all() as Array<{ id: string; external_source_id: string; is_user_adjusted: number }>;
      for (const r of rows) {
        existingMap.set(r.external_source_id, { id: r.id, isUserAdjusted: r.is_user_adjusted });
      }

      const upsertFormation = db.prepare(`
        INSERT INTO catalog_formations (
          id, external_source_id, name, code, category, defensive_shape, attacking_shape,
          tactical_summary, game_modes_json, career_mode_status, layout_verified, is_user_adjusted,
          source_id, import_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        ON CONFLICT(external_source_id) DO UPDATE SET
          name = excluded.name,
          code = excluded.code,
          category = excluded.category,
          defensive_shape = excluded.defensive_shape,
          attacking_shape = excluded.attacking_shape,
          tactical_summary = excluded.tactical_summary,
          game_modes_json = excluded.game_modes_json,
          career_mode_status = excluded.career_mode_status,
          layout_verified = excluded.layout_verified,
          source_id = COALESCE(excluded.source_id, catalog_formations.source_id),
          updated_at = excluded.updated_at
      `);
      const deleteSlots = db.prepare('DELETE FROM catalog_formation_slots WHERE formation_id = ?');
      const insertSlot = db.prepare(`
        INSERT INTO catalog_formation_slots (
          id, formation_id, slot_order, position_code, position_label, x, y, tactical_line, is_user_adjusted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);

      for (const row of validRows) {
        const d = row.data;
        const extId = String(d.externalSourceId);
        const existing = existingMap.get(extId);
        if (existing && mode === 'insert_only') continue;
        const formationId = existing?.id ?? crypto.randomUUID();

        upsertFormation.run(
          formationId,
          extId,
          String(d.name),
          String(d.code),
          String(d.category),
          String(d.defensiveShape),
          String(d.attackingShape),
          String(d.tacticalSummary),
          JSON.stringify(d.gameModes),
          String(d.careerModeStatus),
          d.layoutVerified ? 1 : 0,
          sourceId,
          runId,
          now,
          now
        );

        // Preserve user-adjusted slot coordinates if already customized
        if (!existing || existing.isUserAdjusted === 0) {
          deleteSlots.run(formationId);
          for (const slot of d.slots as Array<{
            slotOrder: number;
            positionCode: string;
            positionLabel: string;
            x: number;
            y: number;
            tacticalLine: string;
          }>) {
            insertSlot.run(
              crypto.randomUUID(),
              formationId,
              slot.slotOrder,
              slot.positionCode,
              slot.positionLabel,
              slot.x,
              slot.y,
              slot.tacticalLine
            );
          }
        }

        if (existing) updatedCount += 1;
        else {
          insertedCount += 1;
          existingMap.set(extId, { id: formationId, isUserAdjusted: 0 });
        }
      }
    } else if (datasetType === 'roles') {
      const existingMap = new Map<string, string>();
      const rows = db
        .prepare('SELECT id, external_source_id FROM catalog_player_roles')
        .all() as Array<{ id: string; external_source_id: string }>;
      for (const r of rows) existingMap.set(r.external_source_id, r.id);

      const upsertRole = db.prepare(`
        INSERT INTO catalog_player_roles (
          id, external_source_id, name, description, position_category,
          tactical_behavior, attacking_behavior, defensive_behavior,
          is_fc26_new, verification_status, source_reference,
          source_id, import_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_source_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          position_category = excluded.position_category,
          tactical_behavior = excluded.tactical_behavior,
          attacking_behavior = excluded.attacking_behavior,
          defensive_behavior = excluded.defensive_behavior,
          is_fc26_new = excluded.is_fc26_new,
          verification_status = excluded.verification_status,
          source_reference = excluded.source_reference,
          source_id = COALESCE(excluded.source_id, catalog_player_roles.source_id),
          updated_at = excluded.updated_at
      `);
      const insertPosCompat = db.prepare(`
        INSERT OR IGNORE INTO catalog_role_position_compatibility (id, role_id, position_code, verification_status, evidence)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const row of validRows) {
        const d = row.data;
        const extId = String(d.externalSourceId);
        const existingId = existingMap.get(extId);
        if (existingId && mode === 'insert_only') continue;
        const roleId = existingId ?? crypto.randomUUID();

        upsertRole.run(
          roleId,
          extId,
          String(d.name),
          String(d.description),
          String(d.positionCategory),
          String(d.tacticalBehavior),
          String(d.attackingBehavior),
          String(d.defensiveBehavior),
          d.isFc26New ? 1 : 0,
          String(d.verificationStatus),
          String(d.sourceReference),
          sourceId,
          runId,
          now,
          now
        );

        for (const posCode of d.eligiblePositions as string[]) {
          insertPosCompat.run(
            crypto.randomUUID(),
            roleId,
            posCode,
            String(d.verificationStatus),
            String(d.sourceReference)
          );
        }

        if (existingId) updatedCount += 1;
        else {
          insertedCount += 1;
          existingMap.set(extId, roleId);
        }
      }
    } else if (datasetType === 'focuses') {
      const existingMap = new Map<string, string>();
      const rows = db
        .prepare('SELECT id, external_source_id FROM catalog_player_focuses')
        .all() as Array<{ id: string; external_source_id: string }>;
      for (const r of rows) existingMap.set(r.external_source_id, r.id);

      const upsertFocus = db.prepare(`
        INSERT INTO catalog_player_focuses (
          id, external_source_id, name, description, tactical_purpose,
          is_fc26_updated, verification_status, source_reference,
          source_id, import_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_source_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          tactical_purpose = excluded.tactical_purpose,
          is_fc26_updated = excluded.is_fc26_updated,
          verification_status = excluded.verification_status,
          source_reference = excluded.source_reference,
          source_id = COALESCE(excluded.source_id, catalog_player_focuses.source_id),
          updated_at = excluded.updated_at
      `);

      for (const row of validRows) {
        const d = row.data;
        const extId = String(d.externalSourceId);
        const existingId = existingMap.get(extId);
        if (existingId && mode === 'insert_only') continue;
        const focusId = existingId ?? crypto.randomUUID();

        upsertFocus.run(
          focusId,
          extId,
          String(d.name),
          String(d.description),
          String(d.tacticalPurpose),
          d.isFc26Updated ? 1 : 0,
          String(d.verificationStatus),
          String(d.sourceReference),
          sourceId,
          runId,
          now,
          now
        );

        if (existingId) updatedCount += 1;
        else {
          insertedCount += 1;
          existingMap.set(extId, focusId);
        }
      }

      // Apply role-position-focus compatibility rows if provided alongside focuses
      if (extraCompatibility && extraCompatibility.length > 0) {
        const rolesByName = new Map<string, string>();
        for (const r of db
          .prepare('SELECT id, name FROM catalog_player_roles')
          .all() as Array<{ id: string; name: string }>) {
          rolesByName.set(r.name.toLowerCase(), r.id);
        }
        const focusesByName = new Map<string, string>();
        for (const f of db
          .prepare('SELECT id, name FROM catalog_player_focuses')
          .all() as Array<{ id: string; name: string }>) {
          focusesByName.set(f.name.toLowerCase(), f.id);
        }

        const insertRolePos = db.prepare(`
          INSERT OR IGNORE INTO catalog_role_position_compatibility (id, role_id, position_code, verification_status, evidence)
          VALUES (?, ?, ?, 'verified', ?)
        `);
        const insertRoleFocus = db.prepare(`
          INSERT OR IGNORE INTO catalog_role_focus_compatibility (id, role_id, position_code, focus_id, verification_status, evidence)
          VALUES (?, ?, ?, ?, 'verified', ?)
        `);

        for (const rule of extraCompatibility) {
          const roleId = rolesByName.get(toStringOrEmpty(rule.roleName).toLowerCase());
          if (!roleId) continue;
          const positions = Array.isArray(rule.positions)
            ? rule.positions.map((p) => String(p).toUpperCase()).filter((p) => VALID_POSITIONS.has(p))
            : [];
          const focuses = Array.isArray(rule.focuses) ? rule.focuses.map(String) : [];
          const evidence = toStringOrEmpty(rule.evidence);

          for (const posCode of positions) {
            insertRolePos.run(crypto.randomUUID(), roleId, posCode, evidence);
            for (const focusName of focuses) {
              const focusId = focusesByName.get(focusName.toLowerCase());
              if (!focusId) continue;
              insertRoleFocus.run(crypto.randomUUID(), roleId, posCode, focusId, evidence);
            }
          }
        }
      }
    }

    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE catalog_import_runs
      SET inserted_count = ?, updated_count = ?, completed_at = ?
      WHERE id = ?
    `).run(insertedCount, updatedCount, completedAt, runId);
  });

  tx();

  const runRow = db
    .prepare(`
      SELECT r.*, s.name as source_name
      FROM catalog_import_runs r
      LEFT JOIN catalog_sources s ON s.id = r.source_id
      WHERE r.id = ?
    `)
    .get(runId) as Record<string, unknown>;

  return mapImportRunRow(runRow);
}

export function rollbackCatalogImportRun(
  db: Database.Database,
  runId: string
): { rolledBack: boolean; deletedRows: number; error?: string } {
  const run = db
    .prepare('SELECT id, dataset_type, status FROM catalog_import_runs WHERE id = ?')
    .get(runId) as { id: string; dataset_type: CatalogDatasetType; status: string } | undefined;

  if (!run) {
    return { rolledBack: false, deletedRows: 0, error: 'Import run not found.' };
  }
  if (run.status === 'rolled_back') {
    return { rolledBack: false, deletedRows: 0, error: 'Import run was already rolled back.' };
  }

  const tableMap: Record<CatalogDatasetType, string | null> = {
    players: 'catalog_players',
    clubs: 'catalog_clubs',
    leagues: 'catalog_leagues',
    nations: 'catalog_nations',
    formations: 'catalog_formations',
    roles: 'catalog_player_roles',
    focuses: 'catalog_player_focuses',
    positions: null,
    sources: null,
  };

  const targetTable = tableMap[run.dataset_type];
  if (!targetTable) {
    return {
      rolledBack: false,
      deletedRows: 0,
      error: `Dataset type "${run.dataset_type}" is a core schema reference and cannot be rolled back directly.`,
    };
  }

  let deletedRows = 0;
  const tx = db.transaction(() => {
    const res = db.prepare(`DELETE FROM ${targetTable} WHERE import_run_id = ?`).run(runId);
    deletedRows = res.changes;
    db.prepare(`UPDATE catalog_import_runs SET status = 'rolled_back' WHERE id = ?`).run(runId);
  });
  tx();

  return { rolledBack: true, deletedRows };
}

export function mapImportRunRow(r: Record<string, unknown>): CatalogImportRun {
  let errors: Array<{ row: number; field: string; message: string }> = [];
  try {
    errors = JSON.parse(String(r.errors_json ?? '[]')) as typeof errors;
  } catch {
    errors = [];
  }
  return {
    id: String(r.id),
    datasetType: String(r.dataset_type) as CatalogDatasetType,
    sourceId: r.source_id ? String(r.source_id) : null,
    sourceName: r.source_name ? String(r.source_name) : null,
    fileName: String(r.file_name ?? ''),
    format: (String(r.format ?? 'json') === 'csv' ? 'csv' : 'json') as 'json' | 'csv',
    datasetVersion: String(r.dataset_version ?? '1.0.0'),
    completeness: String(r.completeness ?? 'partial_baseline') as DatasetCompleteness,
    checksum: String(r.checksum ?? ''),
    mode: String(r.mode ?? 'upsert') as CatalogImportRun['mode'],
    status: String(r.status ?? 'completed') as CatalogImportRun['status'],
    totalRows: Number(r.total_rows ?? 0),
    insertedCount: Number(r.inserted_count ?? 0),
    updatedCount: Number(r.updated_count ?? 0),
    rejectedCount: Number(r.rejected_count ?? 0),
    errors,
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
  };
}

export function resolveReferenceDataDir(): string {
  const custom = process.env.FC26_REFERENCE_DATA_DIR?.trim();
  if (custom && fs.existsSync(custom)) {
    return path.resolve(custom);
  }
  return path.resolve(process.cwd(), 'data', 'fc26');
}

export function bootstrapLocalReferenceCatalogs(db: Database.Database, customDir?: string): void {
  const refDir = customDir ? path.resolve(customDir) : resolveReferenceDataDir();
  if (!fs.existsSync(refDir)) return;

  const hasRun = (datasetType: CatalogDatasetType): boolean => {
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM catalog_import_runs WHERE dataset_type = ? AND status = 'completed'`
      )
      .get(datasetType) as { count: number };
    return row.count > 0;
  };

  const steps: Array<{
    datasetType: CatalogDatasetType;
    relativePath: string;
    completeness: DatasetCompleteness;
  }> = [
    { datasetType: 'sources', relativePath: 'manifests/sources.json', completeness: 'verified_complete' },
    { datasetType: 'positions', relativePath: 'roles/positions.json', completeness: 'verified_complete' },
    { datasetType: 'roles', relativePath: 'roles/roles.json', completeness: 'verified_complete' },
    { datasetType: 'focuses', relativePath: 'focuses/focuses.json', completeness: 'verified_complete' },
    { datasetType: 'formations', relativePath: 'formations/formations.json', completeness: 'verified_complete' },
    { datasetType: 'nations', relativePath: 'nations/nations.json', completeness: 'partial_baseline' },
    { datasetType: 'leagues', relativePath: 'leagues/leagues.json', completeness: 'partial_baseline' },
    { datasetType: 'clubs', relativePath: 'clubs/clubs.json', completeness: 'partial_baseline' },
  ];

  for (const step of steps) {
    const fullPath = path.resolve(refDir, step.relativePath);
    if (!fullPath.startsWith(refDir + path.sep) || !fs.existsSync(fullPath)) continue;

    if (hasRun(step.datasetType)) {
      // Idempotently register any newly added catalog sources (e.g. eafc26_datahub_player_data)
      // on existing installations without modifying user data or creating duplicate import runs.
      if (step.datasetType === 'sources') {
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const { records } = parseRawPayload('sources', 'json', raw);
          const now = new Date().toISOString();
          const insertMissingSource = db.prepare(`
            INSERT OR IGNORE INTO catalog_sources (
              id, source_key, name, url, edition, license_notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const rec of records) {
            const sourceKey = toStringOrEmpty(getField(rec, 'sourceKey', 'source_key'));
            const name = toStringOrEmpty(getField(rec, 'name'));
            const url = toStringOrEmpty(getField(rec, 'url'));
            if (!sourceKey || !name || !url) continue;
            insertMissingSource.run(
              crypto.randomUUID(),
              sourceKey,
              name,
              url,
              toStringOrEmpty(getField(rec, 'edition')) || 'FC 26',
              toStringOrEmpty(getField(rec, 'licenseNotes', 'license_notes')),
              now,
              now
            );
          }
        } catch {
          // Non-fatal: skip malformed manifest sync
        }
      }
      continue;
    }

    const raw = fs.readFileSync(fullPath, 'utf8');
    executeCatalogImport(db, step.datasetType, 'json', raw, {
      fileName: step.relativePath,
      completeness: step.completeness,
      mode: 'upsert',
    });
  }
}
