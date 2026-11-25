import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TACTICAL_CATALOG_SEED } from '../../src/data/tacticalCatalog.ts';
import type { ApplicationSettings } from '../../src/types/domain.ts';
import { bootstrapLocalReferenceCatalogs } from '../services/catalogImporter.ts';
import { seedTacticalVisionCatalog } from '../services/tacticalVisionService.ts';
import { runMigrations } from './migrations.ts';

let dbInstance: Database.Database | null = null;

export function resolveDatabaseLocation(): {
  dataDir: string;
  dbPath: string;
  storageMode: 'electron-user-data' | 'workspace-preview';
} {
  const customUserDataDir = process.env.FC26_USER_DATA_DIR?.trim();
  if (customUserDataDir) {
    const resolvedDir = path.resolve(customUserDataDir);
    return {
      dataDir: resolvedDir,
      dbPath: path.join(resolvedDir, 'fc26_manager.db'),
      storageMode: 'electron-user-data',
    };
  }

  const fallbackDir = path.resolve(process.cwd(), 'data');
  return {
    dataDir: fallbackDir,
    dbPath: path.join(fallbackDir, 'fc26_manager.db'),
    storageMode: 'workspace-preview',
  };
}

/**
 * Resolves the authoritative application userData storage root directory.
 *
 * - In packaged/native Electron on Windows:
 *     C:\Users\<User>\AppData\Roaming\fc26-ai-manager
 *   (where database lives at <appStorageRoot>\database\fc26_manager.db,
 *    legacy v1 recordings live at <appStorageRoot>\recordings\...,
 *    and structured v2 Career Mode folders live directly at <appStorageRoot>\<Club>-Career-Mode\...)
 * - In browser preview / CLI tests without FC26_APP_USER_DATA_ROOT:
 *     if FC26_USER_DATA_DIR ends with "database", uses its parent directory;
 *     otherwise uses resolveDatabaseLocation().dataDir.
 *
 * CRITICAL: Never alters resolveDatabaseLocation().dbPath.
 */
export function resolveAppStorageRoot(): string {
  const explicitRoot = process.env.FC26_APP_USER_DATA_ROOT?.trim();
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const { dataDir } = resolveDatabaseLocation();
  if (path.basename(dataDir).toLowerCase() === 'database') {
    return path.dirname(dataDir);
  }
  return dataDir;
}

/**
 * Resolves the legacy Phase 2/2.1/2.2/3 recordings directory (e.g. <userData>/recordings).
 * Used strictly for backward-compatible resolution of existing v1 recordings.
 */
export function resolveLegacyRecordingsRoot(): string {
  const explicitRecDir = process.env.FC26_RECORDINGS_DIR?.trim();
  if (explicitRecDir) {
    return path.resolve(explicitRecDir);
  }
  return path.join(resolveAppStorageRoot(), 'recordings');
}

export const DEFAULT_APP_SETTINGS: ApplicationSettings = {
  capture: {
    resolution: '1920x1080',
    fallbackResolution: '1280x720',
    fps: 15,
    bitrateKbps: 4500,
    format: 'mp4',
    codec: 'h264',
    audioEnabled: false,
    microphoneEnabled: false,
    segmentDurationMinutes: 3,
    maxRecordingMinutes: 35,
    storageDirectory: 'Documents\\FC26_AI_Manager\\Recordings',
    autoRecoveryEnabled: true,
  },
  ai: {
    modelId: 'gemini-2.5-flash',
    usePrimaryModelForAllStages: true,
    analysisQuality: 'balanced',
    maxEvidenceFrames: 24,
    removeDuplicateFrames: true,
    requireUploadConfirmation: true,
    deleteRemoteAfterAnalysis: true,
    quickAnalysisModelId: '',
    balancedAnalysisModelId: '',
    deepAnalysisModelId: '',
    tacticalSynthesisModelId: '',
    defaultAnalysisMode: 'balanced',
    defaultLanguage: 'en',
    samplingFpsQuick: 1.0,
    samplingFpsBalanced: 2.0,
    samplingFpsDeep: 2.0,
    downscaleForAnalysis: true,
    proxyEnabled: true,
    proxyAudioInBalanced: false,
    proxyAudioInDeep: false,
    maxConcurrentRequests: 1,
    maxAnalysisDurationSeconds: 180,
    uploadTimeoutSeconds: 300,
    processingTimeoutSeconds: 180,
    inferenceTimeoutSeconds: 180,
    maxRetryAttempts: 2,
    perMatchBudgetUsd: 1.5,
    dailyBudgetUsd: 5.0,
    minLiveGameplaySeconds: 15,
    autoAnalyzeAfterStop: false,
  },
  activeClubId: null,
  updatedAt: new Date().toISOString(),
};

function seedDefaults(db: Database.Database): void {
  const now = new Date().toISOString();

  // Seed default application settings if absent (never seeds fictional clubs or matches)
  const existingSettings = db
    .prepare('SELECT key FROM application_settings WHERE key = ?')
    .get('app_config');
  if (!existingSettings) {
    db.prepare(
      'INSERT INTO application_settings (key, value_json, updated_at) VALUES (?, ?, ?)'
    ).run('app_config', JSON.stringify({ ...DEFAULT_APP_SETTINGS, updatedAt: now }), now);
  }

  // Seed editable FC26 tactical catalog baseline if empty
  const catalogCount = (
    db.prepare('SELECT COUNT(*) as count FROM tactical_catalog').get() as { count: number }
  ).count;

  if (catalogCount === 0) {
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO tactical_catalog (id, category, name, description, metadata_json, is_default, created_at)
      VALUES (?, ?, ?, ?, NULL, 1, ?)
    `);
    const tx = db.transaction(() => {
      for (const item of DEFAULT_TACTICAL_CATALOG_SEED) {
        insertStmt.run(crypto.randomUUID(), item.category, item.name, item.description, now);
      }
    });
    tx();
  }
}

export function getDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const { dataDir, dbPath } = resolveDatabaseLocation();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  seedDefaults(db);
  bootstrapLocalReferenceCatalogs(db);
  seedTacticalVisionCatalog(db);

  dbInstance = db;
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.pragma('wal_checkpoint(TRUNCATE)');
      dbInstance.close();
    } catch {
      // ignore close errors on shutdown
    }
    dbInstance = null;
  }
}

const OPERATIONAL_TABLES = [
  'clubs',
  'career_profiles',
  'club_coaches',
  'players',
  'player_role_familiarities',
  'tactical_presets',
  'tactical_preset_assignments',
  'opponents',
  'matches',
  'match_tactical_snapshots',
  'match_sessions',
  'recording_segments',
  'recording_diagnostics',
  'evidence_frames',
  'match_observations',
  'tactical_configurations',
  'halftime_reports',
  'tactical_recommendations',
  'recommendation_feedback',
  'second_half_reports',
  'post_match_reports',
  'tactical_memory',
  'ai_analysis_jobs',
  'ai_analysis_assets',
  'ai_video_classifications',
  'ai_gameplay_observations',
  'ai_tactical_vision_assessments',
  'ai_tactical_recommendations',
  'ai_recommendation_decisions',
  'ai_halftime_briefings',
  'ai_second_half_comparisons',
  'application_settings',
  'api_usage_logs',
  'tactical_catalog',
] as const;

const MASTER_CATALOG_TABLES = [
  'catalog_sources',
  'catalog_import_runs',
  'catalog_nations',
  'catalog_leagues',
  'catalog_clubs',
  'catalog_club_aliases',
  'catalog_positions',
  'catalog_players',
  'catalog_player_positions',
  'catalog_formations',
  'catalog_formation_slots',
  'catalog_player_roles',
  'catalog_player_focuses',
  'catalog_role_position_compatibility',
  'catalog_role_focus_compatibility',
  'catalog_tactical_vision_sources',
  'catalog_tactical_visions',
  'catalog_tactical_vision_aliases',
  'catalog_tactical_vision_requirements',
  'catalog_tactical_vision_role_affinities',
  'catalog_tactical_vision_setting_affinities',
] as const;

const ALLOWED_RESTORE_TABLES = [...OPERATIONAL_TABLES, ...MASTER_CATALOG_TABLES] as const;

function sanitizeSettingsRowForBackup(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.value_json !== 'string') return row;
  try {
    const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
    const forbiddenKeys = new Set(['apiKey', 'geminiApiKey', 'GEMINI_API_KEY', 'secret', 'token']);
    const scrub = (obj: unknown): unknown => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (forbiddenKeys.has(k)) continue;
        out[k] = scrub(v);
      }
      return out;
    };
    return {
      ...row,
      value_json: JSON.stringify(scrub(parsed)),
    };
  } catch {
    return row;
  }
}

export function getDatabaseMetadata(): {
  dbFileName: string;
  storageMode: 'electron-user-data' | 'workspace-preview';
  dbDirectory: string;
  sizeBytes: number;
  schemaVersion: number;
  tableCounts: Record<string, number>;
} {
  const db = getDb();
  const { dataDir, dbPath, storageMode } = resolveDatabaseLocation();
  const sizeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const versionRow = db
    .prepare('SELECT MAX(version) as version FROM schema_migrations')
    .get() as { version: number | null };

  const tableCounts: Record<string, number> = {};
  for (const table of ALLOWED_RESTORE_TABLES) {
    if (table === 'application_settings') continue;
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
    tableCounts[table] = row.count;
  }

  return {
    dbFileName: path.basename(dbPath),
    storageMode,
    dbDirectory: dataDir,
    sizeBytes,
    schemaVersion: versionRow?.version ?? 8,
    tableCounts,
  };
}

export function exportDatabaseBackup(): Record<string, unknown> {
  const db = getDb();
  const data: Record<string, unknown[]> = {};
  for (const table of ALLOWED_RESTORE_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    data[table] =
      table === 'application_settings' ? rows.map(sanitizeSettingsRowForBackup) : rows;
  }
  const versionRow = db
    .prepare('SELECT MAX(version) as version FROM schema_migrations')
    .get() as { version: number | null };

  return {
    format: 'fc26-ai-manager-backup-v8',
    exportedAt: new Date().toISOString(),
    schemaVersion: versionRow?.version ?? 8,
    tables: data,
  };
}

export function restoreDatabaseBackup(payload: {
  format?: string;
  tables?: Record<string, Array<Record<string, unknown>>>;
}): void {
  const isV1 = payload.format === 'fc26-ai-manager-backup-v1';
  const isFullBackup =
    payload.format === 'fc26-ai-manager-backup-v2' ||
    payload.format === 'fc26-ai-manager-backup-v3' ||
    payload.format === 'fc26-ai-manager-backup-v4' ||
    payload.format === 'fc26-ai-manager-backup-v5' ||
    payload.format === 'fc26-ai-manager-backup-v6' ||
    payload.format === 'fc26-ai-manager-backup-v7' ||
    payload.format === 'fc26-ai-manager-backup-v8';

  if ((!isV1 && !isFullBackup) || !payload.tables) {
    throw new Error(
      'Invalid backup format. Expected fc26-ai-manager-backup-v8 (or legacy v1–v7).'
    );
  }

  const db = getDb();
  const targetTables = isFullBackup ? ALLOWED_RESTORE_TABLES : OPERATIONAL_TABLES;
  const tableColumns = new Map<string, Set<string>>();
  for (const table of targetTables) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    tableColumns.set(table, new Set(info.map((c) => c.name)));
  }

  const restoreTx = db.transaction(() => {
    for (const table of [...targetTables].reverse()) {
      db.prepare(`DELETE FROM ${table}`).run();
    }

    for (const table of targetTables) {
      const rows = payload.tables?.[table];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const validCols = tableColumns.get(table)!;

      for (const rawRow of rows) {
        const row =
          table === 'application_settings' ? sanitizeSettingsRowForBackup(rawRow) : rawRow;
        const keys = Object.keys(row).filter((k) => validCols.has(k));
        if (keys.length === 0) continue;
        const placeholders = keys.map(() => '?').join(', ');
        const values = keys.map((k) => row[k]);
        db.prepare(
          `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`
        ).run(...values);
      }
    }

    const fkViolations = db.pragma('foreign_key_check') as Array<Record<string, unknown>>;
    if (fkViolations.length > 0) {
      throw new Error(
        `Backup restore aborted: ${fkViolations.length} foreign key integrity violation(s) detected (first table: ${String(fkViolations[0].table ?? 'unknown')}).`
      );
    }
  });

  db.pragma('foreign_keys = OFF');
  try {
    restoreTx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  seedDefaults(db);
  bootstrapLocalReferenceCatalogs(db);
  seedTacticalVisionCatalog(db);
}

export function deleteAllApplicationData(): void {
  const db = getDb();
  const clearTx = db.transaction(() => {
    for (const table of [...OPERATIONAL_TABLES].reverse()) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
  db.pragma('foreign_keys = OFF');
  try {
    clearTx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  seedDefaults(db);
}
