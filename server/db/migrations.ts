import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_core_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS clubs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        league TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS career_profiles (
        id TEXT PRIMARY KEY,
        club_id TEXT NOT NULL,
        season TEXT NOT NULL DEFAULT '2025/26',
        manager_name TEXT NOT NULL DEFAULT '',
        preferred_philosophy TEXT NOT NULL DEFAULT 'Balanced Positional Play',
        primary_formation TEXT NOT NULL DEFAULT '4-3-3 Holding',
        alternative_formation TEXT NOT NULL DEFAULT '4-2-3-1 Wide',
        preferred_attacking_style TEXT NOT NULL DEFAULT 'Balanced',
        preferred_defensive_style TEXT NOT NULL DEFAULT 'Balanced',
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_career_profiles_club ON career_profiles(club_id);

      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        club_id TEXT NOT NULL,
        name TEXT NOT NULL,
        position TEXT NOT NULL,
        overall_rating INTEGER CHECK (overall_rating IS NULL OR (overall_rating >= 1 AND overall_rating <= 99)),
        preferred_foot TEXT NOT NULL DEFAULT 'Right' CHECK (preferred_foot IN ('Right', 'Left', 'Both')),
        player_role TEXT NOT NULL DEFAULT '',
        strengths TEXT NOT NULL DEFAULT '',
        weaknesses TEXT NOT NULL DEFAULT '',
        preferred_instructions TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_players_club ON players(club_id);

      CREATE TABLE IF NOT EXISTS opponents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        league TEXT NOT NULL DEFAULT '',
        typical_formation TEXT NOT NULL DEFAULT 'Unknown',
        strengths TEXT NOT NULL DEFAULT '',
        weaknesses TEXT NOT NULL DEFAULT '',
        dangerous_channels TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        club_id TEXT NOT NULL,
        career_profile_id TEXT NOT NULL,
        opponent_id TEXT NOT NULL,
        competition TEXT NOT NULL DEFAULT 'League',
        venue TEXT NOT NULL DEFAULT 'home' CHECK (venue IN ('home', 'away', 'neutral')),
        match_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'first_half_recording', 'halftime_ready', 'second_half_recording', 'completed')),
        starting_formation TEXT NOT NULL,
        starting_xi_json TEXT NOT NULL DEFAULT '[]',
        bench_json TEXT NOT NULL DEFAULT '[]',
        objective TEXT NOT NULL DEFAULT '',
        pre_match_notes TEXT NOT NULL DEFAULT '',
        halftime_score_for INTEGER,
        halftime_score_against INTEGER,
        final_score_for INTEGER,
        final_score_against INTEGER,
        has_second_half_recording INTEGER NOT NULL DEFAULT 0 CHECK (has_second_half_recording IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
        FOREIGN KEY (career_profile_id) REFERENCES career_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY (opponent_id) REFERENCES opponents(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_matches_club ON matches(club_id);
      CREATE INDEX IF NOT EXISTS idx_matches_opponent ON matches(opponent_id);
      CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date DESC);

      CREATE TABLE IF NOT EXISTS match_sessions (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        half TEXT NOT NULL CHECK (half IN ('first_half', 'second_half')),
        status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'recording', 'paused', 'finalizing', 'completed', 'recovered', 'discarded')),
        capture_source_id TEXT,
        capture_source_name TEXT,
        resolution TEXT NOT NULL DEFAULT '1920x1080',
        fps INTEGER NOT NULL DEFAULT 15,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_match_sessions_match ON match_sessions(match_id);

      CREATE TABLE IF NOT EXISTS recording_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        checksum TEXT,
        status TEXT NOT NULL DEFAULT 'writing' CHECK (status IN ('writing', 'finalized', 'corrupted', 'recovered')),
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES match_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_recording_segments_session ON recording_segments(session_id);
      CREATE INDEX IF NOT EXISTS idx_recording_segments_match ON recording_segments(match_id);

      CREATE TABLE IF NOT EXISTS evidence_frames (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        segment_id TEXT,
        timestamp_seconds REAL NOT NULL DEFAULT 0,
        category TEXT NOT NULL,
        file_path TEXT NOT NULL,
        ocr_text_json TEXT,
        ocr_confidence TEXT CHECK (ocr_confidence IS NULL OR ocr_confidence IN ('High', 'Medium', 'Low')),
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES match_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (segment_id) REFERENCES recording_segments(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_frames_match ON evidence_frames(match_id);

      CREATE TABLE IF NOT EXISTS match_observations (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        half TEXT NOT NULL CHECK (half IN ('first_half', 'second_half')),
        timestamp_label TEXT NOT NULL DEFAULT 'Unknown',
        category TEXT NOT NULL,
        frame_reference TEXT,
        description TEXT NOT NULL,
        tactical_interpretation TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK (confidence IN ('High', 'Medium', 'Low')),
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_match_observations_match ON match_observations(match_id);

      CREATE TABLE IF NOT EXISTS tactical_configurations (
        id TEXT PRIMARY KEY,
        match_id TEXT,
        club_id TEXT NOT NULL,
        label TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'pre_match' CHECK (phase IN ('pre_match', 'halftime_recommended', 'second_half_applied')),
        formation TEXT NOT NULL,
        build_up_style TEXT NOT NULL,
        defensive_approach TEXT NOT NULL,
        defensive_line_height INTEGER NOT NULL DEFAULT 50 CHECK (defensive_line_height >= 1 AND defensive_line_height <= 100),
        player_assignments_json TEXT NOT NULL DEFAULT '[]',
        custom_parameters_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tactical_configs_match ON tactical_configurations(match_id);

      CREATE TABLE IF NOT EXISTS halftime_reports (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL UNIQUE,
        model_used TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tactical_recommendations (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        halftime_report_id TEXT NOT NULL,
        current_tactic TEXT NOT NULL,
        recommended_change TEXT NOT NULL,
        why_necessary TEXT NOT NULL,
        expected_benefit TEXT NOT NULL,
        potential_risk TEXT NOT NULL,
        when_to_apply TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK (confidence IN ('High', 'Medium', 'Low')),
        priority TEXT NOT NULL CHECK (priority IN ('Critical', 'High', 'Medium', 'Low')),
        is_unverified_option INTEGER NOT NULL DEFAULT 0 CHECK (is_unverified_option IN (0, 1)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        FOREIGN KEY (halftime_report_id) REFERENCES halftime_reports(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tactical_recs_match ON tactical_recommendations(match_id);

      CREATE TABLE IF NOT EXISTS recommendation_feedback (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL UNIQUE,
        choice TEXT NOT NULL CHECK (choice IN ('applied_all', 'applied_some', 'not_applied', 'custom_changes')),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS second_half_reports (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL UNIQUE,
        model_used TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS post_match_reports (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL UNIQUE,
        has_second_half_evidence INTEGER NOT NULL DEFAULT 0 CHECK (has_second_half_evidence IN (0, 1)),
        summary TEXT NOT NULL,
        tactical_comparison TEXT NOT NULL DEFAULT '',
        lessons_learned TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tactical_memory (
        id TEXT PRIMARY KEY,
        club_id TEXT NOT NULL,
        match_id TEXT,
        opponent_id TEXT,
        category TEXT NOT NULL CHECK (category IN ('recurring_weakness', 'successful_pattern', 'formation_insight', 'opponent_tendency')),
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        confidence TEXT NOT NULL DEFAULT 'Medium' CHECK (confidence IN ('High', 'Medium', 'Low')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL,
        FOREIGN KEY (opponent_id) REFERENCES opponents(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tactical_memory_club ON tactical_memory(club_id);

      CREATE TABLE IF NOT EXISTS application_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_usage_logs (
        id TEXT PRIMARY KEY,
        match_id TEXT,
        model_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        evidence_frames_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('success', 'error')),
        error_message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS tactical_catalog (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('formation', 'build_up', 'defensive_approach', 'player_role', 'player_focus')),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        metadata_json TEXT,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(category, name)
      );
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version
    )
  );

  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      const apply = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
        ).run(migration.version, migration.name, new Date().toISOString());
      });
      apply();
    }
  }
}
