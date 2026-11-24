import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TACTICAL_CATALOG_SEED } from '../../src/data/tacticalCatalog.ts';
import type { ApplicationSettings } from '../../src/types/domain.ts';
import { runMigrations } from './migrations.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'fc26_manager.db');

let dbInstance: Database.Database | null = null;

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
    modelId: 'gemini-4-hydrogen',
    analysisQuality: 'balanced',
    maxEvidenceFrames: 24,
    removeDuplicateFrames: true,
    requireUploadConfirmation: true,
    deleteRemoteAfterAnalysis: true,
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

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  seedDefaults(db);

  dbInstance = db;
  return dbInstance;
}

export function getDatabaseMetadata(): {
  dbFileName: string;
  sizeBytes: number;
  schemaVersion: number;
  tableCounts: Record<string, number>;
} {
  const db = getDb();
  const sizeBytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  const versionRow = db
    .prepare('SELECT MAX(version) as version FROM schema_migrations')
    .get() as { version: number | null };

  const tables = [
    'clubs',
    'career_profiles',
    'players',
    'opponents',
    'matches',
    'match_sessions',
    'recording_segments',
    'evidence_frames',
    'match_observations',
    'tactical_configurations',
    'halftime_reports',
    'tactical_recommendations',
    'recommendation_feedback',
    'second_half_reports',
    'post_match_reports',
    'tactical_memory',
    'api_usage_logs',
    'tactical_catalog',
  ];

  const tableCounts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
    tableCounts[table] = row.count;
  }

  return {
    dbFileName: path.basename(DB_PATH),
    sizeBytes,
    schemaVersion: versionRow?.version ?? 1,
    tableCounts,
  };
}

export function exportDatabaseBackup(): Record<string, unknown> {
  const db = getDb();
  const tables = [
    'clubs',
    'career_profiles',
    'players',
    'opponents',
    'matches',
    'match_sessions',
    'recording_segments',
    'evidence_frames',
    'match_observations',
    'tactical_configurations',
    'halftime_reports',
    'tactical_recommendations',
    'recommendation_feedback',
    'second_half_reports',
    'post_match_reports',
    'tactical_memory',
    'application_settings',
    'api_usage_logs',
    'tactical_catalog',
  ];

  const data: Record<string, unknown[]> = {};
  for (const table of tables) {
    data[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }

  return {
    format: 'fc26-ai-manager-backup-v1',
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    tables: data,
  };
}

const ALLOWED_RESTORE_TABLES = [
  'clubs',
  'career_profiles',
  'players',
  'opponents',
  'matches',
  'match_sessions',
  'recording_segments',
  'evidence_frames',
  'match_observations',
  'tactical_configurations',
  'halftime_reports',
  'tactical_recommendations',
  'recommendation_feedback',
  'second_half_reports',
  'post_match_reports',
  'tactical_memory',
  'application_settings',
  'api_usage_logs',
  'tactical_catalog',
] as const;

export function restoreDatabaseBackup(payload: {
  format?: string;
  tables?: Record<string, Array<Record<string, unknown>>>;
}): void {
  if (payload.format !== 'fc26-ai-manager-backup-v1' || !payload.tables) {
    throw new Error('Invalid backup format. Expected fc26-ai-manager-backup-v1.');
  }

  const db = getDb();
  const tableColumns = new Map<string, Set<string>>();
  for (const table of ALLOWED_RESTORE_TABLES) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    tableColumns.set(table, new Set(info.map((c) => c.name)));
  }

  const restoreTx = db.transaction(() => {
    db.pragma('foreign_keys = OFF');
    try {
      for (const table of [...ALLOWED_RESTORE_TABLES].reverse()) {
        db.prepare(`DELETE FROM ${table}`).run();
      }

      for (const table of ALLOWED_RESTORE_TABLES) {
        const rows = payload.tables?.[table];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const validCols = tableColumns.get(table)!;

        for (const row of rows) {
          const keys = Object.keys(row).filter((k) => validCols.has(k));
          if (keys.length === 0) continue;
          const placeholders = keys.map(() => '?').join(', ');
          const values = keys.map((k) => row[k]);
          db.prepare(
            `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`
          ).run(...values);
        }
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  });

  restoreTx();
  seedDefaults(db);
}

export function deleteAllApplicationData(): void {
  const db = getDb();
  const clearTx = db.transaction(() => {
    db.pragma('foreign_keys = OFF');
    try {
      for (const table of [...ALLOWED_RESTORE_TABLES].reverse()) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  });
  clearTx();
  seedDefaults(db);
}
