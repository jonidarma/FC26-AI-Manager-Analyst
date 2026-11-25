import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  disableForeignKeys?: boolean;
  afterSql?: (db: Database.Database) => void;
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
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
  {
    version: 2,
    name: 'fc26_master_catalog_v2',
    sql: `
      CREATE TABLE IF NOT EXISTS catalog_sources (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        edition TEXT NOT NULL DEFAULT 'FC 26',
        license_notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_import_runs (
        id TEXT PRIMARY KEY,
        dataset_type TEXT NOT NULL CHECK (dataset_type IN ('nations', 'leagues', 'clubs', 'players', 'formations', 'positions', 'roles', 'focuses', 'sources')),
        source_id TEXT,
        file_name TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'csv')),
        dataset_version TEXT NOT NULL DEFAULT '1.0.0',
        completeness TEXT NOT NULL DEFAULT 'partial_baseline' CHECK (completeness IN ('verified_complete', 'partial_baseline', 'user_imported', 'empty_awaiting_user_import')),
        checksum TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'upsert' CHECK (mode IN ('upsert', 'insert_only', 'replace_dataset')),
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'rolled_back')),
        total_rows INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0,
        errors_json TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (source_id) REFERENCES catalog_sources(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_import_runs_dataset ON catalog_import_runs(dataset_type, completed_at DESC);

      CREATE TABLE IF NOT EXISTS catalog_nations (
        id TEXT PRIMARY KEY,
        external_source_id TEXT NOT NULL UNIQUE,
        source_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        iso_code TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        source_id TEXT,
        import_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES catalog_sources(id) ON DELETE SET NULL,
        FOREIGN KEY (import_run_id) REFERENCES catalog_import_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_nations_name ON catalog_nations(display_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_catalog_nations_source_name ON catalog_nations(source_name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS catalog_leagues (
        id TEXT PRIMARY KEY,
        external_source_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        country_id TEXT,
        country_name TEXT NOT NULL DEFAULT '',
        tier INTEGER,
        category TEXT NOT NULL DEFAULT 'mens' CHECK (category IN ('mens', 'womens', 'mixed')),
        source_id TEXT,
        import_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (country_id) REFERENCES catalog_nations(id) ON DELETE SET NULL,
        FOREIGN KEY (source_id) REFERENCES catalog_sources(id) ON DELETE SET NULL,
        FOREIGN KEY (import_run_id) REFERENCES catalog_import_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_leagues_name ON catalog_leagues(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_catalog_leagues_country ON catalog_leagues(country_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_leagues_category ON catalog_leagues(category);

      CREATE TABLE IF NOT EXISTS catalog_clubs (
        id TEXT PRIMARY KEY,
        external_source_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL DEFAULT '',
        league_id TEXT,
        nation_id TEXT,
        team_category TEXT NOT NULL DEFAULT 'mens' CHECK (team_category IN ('mens', 'womens')),
        source_id TEXT,
        import_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (league_id) REFERENCES catalog_leagues(id) ON DELETE SET NULL,
        FOREIGN KEY (nation_id) REFERENCES catalog_nations(id) ON DELETE SET NULL,
        FOREIGN KEY (source_id) REFERENCES catalog_sources(id) ON DELETE SET NULL,
        FOREIGN KEY (import_run_id) REFERENCES catalog_import_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_clubs_name ON catalog_clubs(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_catalog_clubs_league ON catalog_clubs(league_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_clubs_nation ON catalog_clubs(nation_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_clubs_category ON catalog_clubs(team_category);

      CREATE TABLE IF NOT EXISTS catalog_positions (
        code TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        category TEXT NOT NULL,
        tactical_line TEXT NOT NULL CHECK (tactical_line IN ('GK', 'DEF', 'MID', 'ATT')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        source_id TEXT,
        import_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES catalog_sources(id) ON DELETE SET NULL,
        FOREIGN KEY (import_run_id) REFERENCES catalog_import_runs(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_players (
        id TEXT PRIMARY KEY,
        external_source_id TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        short_name TEXT NOT NULL DEFAULT '',
        club_id TEXT,
        league_id TEXT,
        nation_id TEXT,
        club_name_raw TEXT NOT NULL DEFAULT '',
        league_name_raw TEXT NOT NULL DEFAULT '',
        nation_name_raw TEXT NOT NULL DEFAULT '',
        primary_position TEXT NOT NULL,
        age INTEGER CHECK (age IS NULL OR (age >= 14 AND age <= 55)),
        overall_rating INTEGER CHECK (overall_rating IS NULL OR (overall_rating >= 1 AND overall_rating <= 99)),
        potential_rating INTEGER CHECK (potential_rating IS NULL OR (potential_rating >= 1 AND potential_rating <= 99)),
        growth INTEGER,
        pace INTEGER CHECK (pace IS NULL OR (pace >= 1 AND pace <= 99)),
        shooting INTEGER CHECK (shooting IS NULL OR (shooting >= 1 AND shooting <= 99)),
        passing INTEGER CHECK (passing IS NULL OR (passing >= 1 AND passing <= 99)),
        dribbling INTEGER CHECK (dribbling IS NULL OR (dribbling >= 1 AND dribbling <= 99)),
        defending INTEGER CHECK (defending IS NULL OR (defending >= 1 AND defending <= 99)),
        physicality INTEGER CHECK (physicality IS NULL OR (physicality >= 1 AND physicality <= 99)),
        preferred_foot TEXT CHECK (preferred_foot IS NULL OR preferred_foot IN ('Right', 'Left', 'Both')),
        weak_foot INTEGER CHECK (weak_foot IS NULL OR (weak_foot >= 1 AND weak_foot <= 5)),
        skill_moves INTEGER CHECK (skill_moves IS NULL OR (skill_moves >= 1 AND skill_moves <= 5)),
        height_cm INTEGER CHECK (height_cm IS NULL OR (height_cm >= 130 AND height_cm <= 230)),
        weight_kg INTEGER CHECK (weight_kg IS NULL OR (weight_kg >= 40 AND weight_kg <= 140)),
        market_value_eur INTEGER,
        wage_eur INTEGER,
        contract_expiry TEXT,
        attributes_json TEXT,
        source_id TEXT,
        import_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (club_id) REFERENCES catalog_clubs(id) ON DELETE SET NULL,
        FOREIGN KEY (league_id) REFERENCES catalog_leagues(id) ON DELETE SET NULL,
        FOREIGN KEY (nation_id) REFERENCES catalog_nations(id) ON DELETE SET NULL,
        FOREIGN KEY (primary_position) REFERENCES catalog_positions(code) ON DELETE RESTRICT,
        FOREIGN KEY (source_id) REFERENCES catalog_sources(id) ON DELETE SET NULL,
        FOREIGN KEY (import_run_id) REFERENCES catalog_import_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_players_name ON catalog_players(full_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_short_name ON catalog_players(short_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_primary_pos ON catalog_players(primary_position);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_ovr ON catalog_players(overall_rating DESC);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_pot ON catalog_players(potential_rating DESC);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_age ON catalog_players(age);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_club ON catalog_players(club_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_league ON catalog_players(league_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_nation ON catalog_players(nation_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_foot ON catalog_players(preferred_foot);
      CREATE INDEX IF NOT EXISTS idx_catalog_players_import_run ON catalog_players(import_run_id);

      CREATE TABLE IF NOT EXISTS catalog_player_positions (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        position_code TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        FOREIGN KEY (player_id) REFERENCES catalog_players(id) ON DELETE CASCADE,
        FOREIGN KEY (position_code) REFERENCES catalog_positions(code) ON DELETE RESTRICT,
        UNIQUE(player_id, position_code)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_player_positions_pos ON catalog_player_positions(position_code, player_id);

      CREATE TABLE IF NOT EXISTS catalog_formations (
        id TEXT PRIMARY KEY,
        external_source_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        code TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'Back 4',
        defensive_shape TEXT NOT NULL DEFAULT '',
        attacking_shape TEXT NOT NULL DEFAULT '',
        tactical_summary TEXT NOT NULL DEFAULT '',
        game_modes_json TEXT NOT NULL DEFAULT '["Career Mode"]',
        career_mode_status TEXT NOT NULL DEFAULT 'verified' CHECK (career_mode_status IN ('verified', 'unverified', 'fut_only')),
        layout_verified INTEGER NOT NULL DEFAULT 1 CHECK (layout_verified IN (0, 1)),
        is_user_adjusted INTEGER NOT NULL DEFAULT 0 CHECK (is_user_adjusted IN (0, 1)),
        source_id TEXT,
        import_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES catalog_sources(id) ON DELETE SET NULL,
        FOREIGN KEY (import_run_id) REFERENCES catalog_import_runs(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_formation_slots (
        id TEXT PRIMARY KEY,
        formation_id TEXT NOT NULL,
        slot_order INTEGER NOT NULL CHECK (slot_order >= 0 AND slot_order <= 10),
        position_code TEXT NOT NULL,
        position_label TEXT NOT NULL,
        x REAL NOT NULL CHECK (x >= 0 AND x <= 100),
        y REAL NOT NULL CHECK (y >= 0 AND y <= 100),
        tactical_line TEXT NOT NULL CHECK (tactical_line IN ('GK', 'DEF', 'MID', 'ATT')),
        is_user_adjusted INTEGER NOT NULL DEFAULT 0 CHECK (is_user_adjusted IN (0, 1)),
        FOREIGN KEY (formation_id) REFERENCES catalog_formations(id) ON DELETE CASCADE,
        FOREIGN KEY (position_code) REFERENCES catalog_positions(code) ON DELETE RESTRICT,
        UNIQUE(formation_id, slot_order)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_formation_slots_formation ON catalog_formation_slots(formation_id, slot_order);

      CREATE TABLE IF NOT EXISTS catalog_player_roles (
        id TEXT PRIMARY KEY,
        external_source_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        position_category TEXT NOT NULL DEFAULT 'Midfielder',
        tactical_behavior TEXT NOT NULL DEFAULT '',
        attacking_behavior TEXT NOT NULL DEFAULT '',
        defensive_behavior TEXT NOT NULL DEFAULT '',
        is_fc26_new INTEGER NOT NULL DEFAULT 0 CHECK (is_fc26_new IN (0, 1)),
        verification_status TEXT NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('verified', 'unverified')),
        source_reference TEXT NOT NULL DEFAULT '',
        source_id TEXT,
        import_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES catalog_sources(id) ON DELETE SET NULL,
        FOREIGN KEY (import_run_id) REFERENCES catalog_import_runs(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_player_focuses (
        id TEXT PRIMARY KEY,
        external_source_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        tactical_purpose TEXT NOT NULL DEFAULT '',
        is_fc26_updated INTEGER NOT NULL DEFAULT 0 CHECK (is_fc26_updated IN (0, 1)),
        verification_status TEXT NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('verified', 'unverified')),
        source_reference TEXT NOT NULL DEFAULT '',
        source_id TEXT,
        import_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES catalog_sources(id) ON DELETE SET NULL,
        FOREIGN KEY (import_run_id) REFERENCES catalog_import_runs(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_role_position_compatibility (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        position_code TEXT NOT NULL,
        verification_status TEXT NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('verified', 'unverified')),
        evidence TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (role_id) REFERENCES catalog_player_roles(id) ON DELETE CASCADE,
        FOREIGN KEY (position_code) REFERENCES catalog_positions(code) ON DELETE RESTRICT,
        UNIQUE(role_id, position_code)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_role_pos_compat ON catalog_role_position_compatibility(position_code, role_id);

      CREATE TABLE IF NOT EXISTS catalog_role_focus_compatibility (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        position_code TEXT NOT NULL,
        focus_id TEXT NOT NULL,
        verification_status TEXT NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('verified', 'unverified')),
        evidence TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (role_id) REFERENCES catalog_player_roles(id) ON DELETE CASCADE,
        FOREIGN KEY (position_code) REFERENCES catalog_positions(code) ON DELETE RESTRICT,
        FOREIGN KEY (focus_id) REFERENCES catalog_player_focuses(id) ON DELETE CASCADE,
        UNIQUE(role_id, position_code, focus_id)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_role_focus_compat ON catalog_role_focus_compatibility(role_id, position_code);
    `,
    afterSql: (db: Database.Database) => {
      // Non-destructively link operational Career Mode tables to master FC26 catalog entities
      addColumnIfMissing(db, 'clubs', 'catalog_club_id', 'TEXT');
      addColumnIfMissing(db, 'clubs', 'nation', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'players', 'catalog_player_id', 'TEXT');
      addColumnIfMissing(db, 'players', 'potential_rating', 'INTEGER');
      addColumnIfMissing(db, 'players', 'age', 'INTEGER');
      addColumnIfMissing(db, 'players', 'contract_expiry', 'TEXT');
      addColumnIfMissing(db, 'players', 'market_value_eur', 'INTEGER');
      addColumnIfMissing(db, 'players', 'wage_eur', 'INTEGER');
      addColumnIfMissing(db, 'players', 'player_focus', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'opponents', 'catalog_club_id', 'TEXT');
    },
  },
  {
    version: 3,
    name: 'recording_session_metadata_v3',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_segments_session_index
      ON recording_segments(session_id, segment_index);
    `,
    afterSql: (db: Database.Database) => {
      // Non-destructively extend match_sessions and recording_segments for Phase 2 native recording telemetry & integrity
      addColumnIfMissing(db, 'match_sessions', 'encoder', 'TEXT');
      addColumnIfMissing(db, 'match_sessions', 'audio_enabled', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'match_sessions', 'output_directory', 'TEXT');
      addColumnIfMissing(db, 'match_sessions', 'integrity_status', "TEXT NOT NULL DEFAULT 'pending'");
      addColumnIfMissing(db, 'match_sessions', 'recovery_notes', 'TEXT');
      addColumnIfMissing(db, 'match_sessions', 'updated_at', 'TEXT');

      addColumnIfMissing(db, 'recording_segments', 'resolution', 'TEXT');
      addColumnIfMissing(db, 'recording_segments', 'fps', 'REAL');
      addColumnIfMissing(db, 'recording_segments', 'codec', 'TEXT');
      addColumnIfMissing(db, 'recording_segments', 'has_audio', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'recording_segments', 'integrity_status', "TEXT NOT NULL DEFAULT 'pending'");
      addColumnIfMissing(db, 'recording_segments', 'started_at', 'TEXT');
      addColumnIfMissing(db, 'recording_segments', 'ended_at', 'TEXT');
    },
  },
  {
    version: 4,
    name: 'phase_2_1_capture_squad_tactics_v4',
    disableForeignKeys: true,
    sql: `
      CREATE TABLE IF NOT EXISTS recording_diagnostics (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        match_id TEXT NOT NULL,
        failure_reason TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES match_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_recording_diagnostics_match
      ON recording_diagnostics(match_id);

      CREATE TABLE IF NOT EXISTS tactical_presets (
        id TEXT PRIMARY KEY,
        club_id TEXT NOT NULL,
        name TEXT NOT NULL,
        formation_id TEXT,
        formation_name TEXT NOT NULL,
        build_up_style TEXT NOT NULL DEFAULT 'Balanced',
        defensive_approach TEXT NOT NULL DEFAULT 'Balanced',
        defensive_line_height INTEGER NOT NULL DEFAULT 50 CHECK (defensive_line_height >= 1 AND defensive_line_height <= 100),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        bench_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
        FOREIGN KEY (formation_id) REFERENCES catalog_formations(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tactical_presets_club
      ON tactical_presets(club_id);

      CREATE TABLE IF NOT EXISTS tactical_preset_assignments (
        id TEXT PRIMARY KEY,
        preset_id TEXT NOT NULL,
        slot_order INTEGER NOT NULL CHECK (slot_order >= 0 AND slot_order <= 10),
        position_code TEXT NOT NULL,
        player_id TEXT,
        role TEXT NOT NULL DEFAULT '',
        focus TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (preset_id) REFERENCES tactical_presets(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL,
        UNIQUE(preset_id, slot_order)
      );

      CREATE INDEX IF NOT EXISTS idx_tactical_preset_assignments_preset
      ON tactical_preset_assignments(preset_id, slot_order);

      CREATE TABLE IF NOT EXISTS match_tactical_snapshots (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        source_preset_id TEXT,
        source_preset_name TEXT,
        snapshot_type TEXT NOT NULL DEFAULT 'pre_match' CHECK (snapshot_type IN ('pre_match', 'in_match_adjustment')),
        is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
        formation_id TEXT,
        formation_name TEXT NOT NULL,
        build_up_style TEXT NOT NULL DEFAULT 'Balanced',
        defensive_approach TEXT NOT NULL DEFAULT 'Balanced',
        defensive_line_height INTEGER NOT NULL DEFAULT 50 CHECK (defensive_line_height >= 1 AND defensive_line_height <= 100),
        assignments_json TEXT NOT NULL DEFAULT '[]',
        bench_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        FOREIGN KEY (source_preset_id) REFERENCES tactical_presets(id) ON DELETE SET NULL,
        FOREIGN KEY (formation_id) REFERENCES catalog_formations(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_match_tactical_snapshots_match
      ON match_tactical_snapshots(match_id, snapshot_type);
    `,
    afterSql: (db: Database.Database) => {
      // 1. Non-destructively rebuild match_sessions to allow 'failed' and 'partial' statuses and add ai_eligible/failure_reason/diagnostics_path
      db.exec(`
        CREATE TABLE match_sessions_v4 (
          id TEXT PRIMARY KEY,
          match_id TEXT NOT NULL,
          half TEXT NOT NULL CHECK (half IN ('first_half', 'second_half')),
          status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'recording', 'paused', 'finalizing', 'completed', 'partial', 'recovered', 'failed', 'discarded')),
          capture_source_id TEXT,
          capture_source_name TEXT,
          resolution TEXT NOT NULL DEFAULT '1920x1080',
          fps INTEGER NOT NULL DEFAULT 15,
          duration_seconds INTEGER NOT NULL DEFAULT 0,
          total_bytes INTEGER NOT NULL DEFAULT 0,
          encoder TEXT,
          audio_enabled INTEGER NOT NULL DEFAULT 0,
          output_directory TEXT,
          integrity_status TEXT NOT NULL DEFAULT 'pending',
          ai_eligible INTEGER NOT NULL DEFAULT 0 CHECK (ai_eligible IN (0, 1)),
          failure_reason TEXT,
          diagnostics_path TEXT,
          recovery_notes TEXT,
          started_at TEXT,
          ended_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT,
          FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
        );

        INSERT INTO match_sessions_v4 (
          id, match_id, half, status, capture_source_id, capture_source_name,
          resolution, fps, duration_seconds, total_bytes, encoder, audio_enabled,
          output_directory, integrity_status, ai_eligible, failure_reason, diagnostics_path,
          recovery_notes, started_at, ended_at, created_at, updated_at
        )
        SELECT
          id,
          match_id,
          half,
          CASE
            WHEN status = 'completed' AND (total_bytes <= 0 OR integrity_status = 'corrupted') THEN 'failed'
            ELSE status
          END,
          capture_source_id,
          capture_source_name,
          resolution,
          fps,
          duration_seconds,
          total_bytes,
          encoder,
          COALESCE(audio_enabled, 0),
          output_directory,
          COALESCE(integrity_status, 'pending'),
          CASE
            WHEN status IN ('completed', 'recovered') AND total_bytes > 0 AND COALESCE(integrity_status, '') != 'corrupted' THEN 1
            ELSE 0
          END,
          CASE
            WHEN status = 'completed' AND (total_bytes <= 0 OR integrity_status = 'corrupted') THEN 'Legacy zero-byte or corrupted recording reclassified as failed by Phase 2.1 migration.'
            ELSE NULL
          END,
          NULL,
          recovery_notes,
          started_at,
          ended_at,
          created_at,
          updated_at
        FROM match_sessions;

        DROP TABLE match_sessions;
        ALTER TABLE match_sessions_v4 RENAME TO match_sessions;
        CREATE INDEX IF NOT EXISTS idx_match_sessions_match ON match_sessions(match_id);
      `);

      // 2. Non-destructively extend players for standardized display names and full career squad lifecycle
      addColumnIfMissing(db, 'players', 'display_name', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'players', 'display_name_override', 'TEXT');
      addColumnIfMissing(db, 'players', 'short_name', 'TEXT');
      addColumnIfMissing(db, 'players', 'full_name', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'players', 'squad_number', 'INTEGER');
      addColumnIfMissing(db, 'players', 'squad_status', "TEXT NOT NULL DEFAULT 'active'");
      addColumnIfMissing(db, 'players', 'availability', "TEXT NOT NULL DEFAULT 'available'");
      addColumnIfMissing(db, 'players', 'injury_status', 'TEXT');
      addColumnIfMissing(db, 'players', 'suspension_status', 'TEXT');
      addColumnIfMissing(db, 'players', 'membership_start_date', 'TEXT');
      addColumnIfMissing(db, 'players', 'membership_end_date', 'TEXT');
      addColumnIfMissing(db, 'players', 'secondary_positions_json', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(db, 'players', 'notes', "TEXT NOT NULL DEFAULT ''");

      // 3. Extend catalog_players with optional display_name_override (never mutates imported data)
      addColumnIfMissing(db, 'catalog_players', 'display_name_override', 'TEXT');

      // 4. Backfill existing Career Mode players with canonical display_name, short_name, full_name
      db.exec(`
        UPDATE players
        SET
          full_name = CASE WHEN TRIM(COALESCE(full_name, '')) = '' THEN name ELSE full_name END,
          short_name = COALESCE(
            NULLIF(TRIM(short_name), ''),
            (SELECT NULLIF(TRIM(cp.short_name), '') FROM catalog_players cp WHERE cp.id = players.catalog_player_id)
          )
      `);

      db.exec(`
        UPDATE players
        SET display_name = COALESCE(
          NULLIF(TRIM(display_name_override), ''),
          NULLIF(TRIM(display_name), ''),
          NULLIF(TRIM(short_name), ''),
          NULLIF(TRIM(full_name), ''),
          name
        )
      `);

      // 5. Backfill immutable pre_match snapshots for any pre-existing matches that have tactical_configurations
      const existingPreMatch = db
        .prepare(
          `SELECT tc.id, tc.match_id, tc.formation, tc.build_up_style, tc.defensive_approach,
                  tc.defensive_line_height, tc.player_assignments_json, tc.created_at,
                  m.status as match_status, m.bench_json
           FROM tactical_configurations tc
           JOIN matches m ON m.id = tc.match_id
           WHERE tc.phase = 'pre_match'
             AND NOT EXISTS (
               SELECT 1 FROM match_tactical_snapshots mts
               WHERE mts.match_id = tc.match_id AND mts.snapshot_type = 'pre_match'
             )`
        )
        .all() as Array<{
        id: string;
        match_id: string;
        formation: string;
        build_up_style: string;
        defensive_approach: string;
        defensive_line_height: number;
        player_assignments_json: string;
        created_at: string;
        match_status: string;
        bench_json: string;
      }>;

      const insertSnapshot = db.prepare(`
        INSERT INTO match_tactical_snapshots (
          id, match_id, source_preset_id, source_preset_name, snapshot_type, is_locked,
          formation_id, formation_name, build_up_style, defensive_approach, defensive_line_height,
          assignments_json, bench_json, notes, created_at, updated_at
        ) VALUES (?, ?, NULL, NULL, 'pre_match', ?, NULL, ?, ?, ?, ?, ?, ?, '', ?, ?)
      `);

      for (const row of existingPreMatch) {
        const isLocked = row.match_status !== 'scheduled' ? 1 : 0;
        let normalizedAssignments: Array<Record<string, unknown>> = [];
        try {
          const parsed = JSON.parse(row.player_assignments_json) as Array<Record<string, unknown>>;
          if (Array.isArray(parsed)) {
            normalizedAssignments = parsed.map((a, idx) => ({
              slotOrder: typeof a.slotIndex === 'number' ? a.slotIndex : idx,
              positionCode: String(a.positionCode ?? ''),
              playerId: typeof a.playerId === 'string' ? a.playerId : null,
              playerDisplayName: typeof a.playerName === 'string' ? a.playerName : null,
              playerFullName: typeof a.playerName === 'string' ? a.playerName : null,
              role: String(a.role ?? ''),
              focus: String(a.focus ?? ''),
            }));
          }
        } catch {
          normalizedAssignments = [];
        }

        insertSnapshot.run(
          `snap_${row.id}`,
          row.match_id,
          isLocked,
          row.formation,
          row.build_up_style,
          row.defensive_approach,
          row.defensive_line_height,
          JSON.stringify(normalizedAssignments),
          '[]',
          row.created_at,
          row.created_at
        );
      }

      // 6. Add performance indexes for Phase 2.1 queries
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_players_club_status ON players(club_id, squad_status);
        CREATE INDEX IF NOT EXISTS idx_players_catalog_link ON players(club_id, catalog_player_id);
      `);
    },
  },
  {
    version: 5,
    name: 'phase_2_2_tactics_eligibility_catalog_v5',
    sql: `
      CREATE TABLE IF NOT EXISTS catalog_club_aliases (
        id TEXT PRIMARY KEY,
        club_id TEXT NOT NULL,
        alias_name TEXT NOT NULL,
        alias_type TEXT NOT NULL DEFAULT 'alternate_name' CHECK (alias_type IN ('unlicensed_name', 'short_name', 'alternate_name', 'datahub_name', 'historical_name')),
        verification_status TEXT NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('verified', 'unverified')),
        created_at TEXT NOT NULL,
        FOREIGN KEY (club_id) REFERENCES catalog_clubs(id) ON DELETE CASCADE,
        UNIQUE(club_id, alias_name COLLATE NOCASE)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_club_aliases_club ON catalog_club_aliases(club_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_club_aliases_name ON catalog_club_aliases(alias_name COLLATE NOCASE);
    `,
    afterSql: (db: Database.Database) => {
      // 1. Formation slot separation: slot_id vs canonical position_code & display position_label
      addColumnIfMissing(db, 'catalog_formation_slots', 'slot_id', 'TEXT');
      db.exec(`
        UPDATE catalog_formation_slots
        SET
          slot_id = COALESCE(NULLIF(TRIM(slot_id), ''), NULLIF(TRIM(position_label), ''), position_code),
          position_label = position_code
      `);

      // 2. Tactical presets: draft vs match_ready status & normalized slot_id / position_code
      addColumnIfMissing(db, 'tactical_presets', 'preset_status', "TEXT NOT NULL DEFAULT 'match_ready'");
      addColumnIfMissing(db, 'tactical_preset_assignments', 'slot_id', 'TEXT');

      const aliasMap: Record<string, string> = {
        LCB: 'CB',
        RCB: 'CB',
        CCB: 'CB',
        LDM: 'CDM',
        RDM: 'CDM',
        LCDM: 'CDM',
        RCDM: 'CDM',
        LCM: 'CM',
        RCM: 'CM',
        LAM: 'CAM',
        RAM: 'CAM',
        LCAM: 'CAM',
        RCAM: 'CAM',
        LS: 'ST',
        RS: 'ST',
        LST: 'ST',
        RST: 'ST',
        LF: 'CF',
        RF: 'CF',
      };

      const presetAssignments = db
        .prepare('SELECT id, slot_order, slot_id, position_code FROM tactical_preset_assignments')
        .all() as Array<{ id: string; slot_order: number; slot_id: string | null; position_code: string }>;
      const updatePresetAssignment = db.prepare(
        'UPDATE tactical_preset_assignments SET slot_id = ?, position_code = ? WHERE id = ?'
      );
      for (const row of presetAssignments) {
        const rawPos = String(row.position_code || '').trim().toUpperCase();
        const canonical = aliasMap[rawPos] ?? rawPos;
        const slotId = row.slot_id?.trim() ? row.slot_id.trim() : rawPos || `${canonical}_${row.slot_order}`;
        updatePresetAssignment.run(slotId, canonical, row.id);
      }

      // 3. Career Mode squad eligibility: explicit youth academy senior selection authorization
      addColumnIfMissing(db, 'players', 'senior_selection_authorized', 'INTEGER NOT NULL DEFAULT 0');

      // 4. Expanded FC26 master catalog provenance, aliasing, and external ID reconciliation
      addColumnIfMissing(db, 'catalog_nations', 'external_nation_id', 'TEXT');

      addColumnIfMissing(db, 'catalog_leagues', 'region', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'catalog_leagues', 'mode_availability', "TEXT NOT NULL DEFAULT 'career_mode'");
      addColumnIfMissing(db, 'catalog_leagues', 'dataset_version', 'TEXT');
      addColumnIfMissing(db, 'catalog_leagues', 'verification_status', "TEXT NOT NULL DEFAULT 'verified'");

      addColumnIfMissing(db, 'catalog_clubs', 'source_namespace', "TEXT NOT NULL DEFAULT 'baseline'");
      addColumnIfMissing(db, 'catalog_clubs', 'external_team_id', 'TEXT');
      addColumnIfMissing(db, 'catalog_clubs', 'canonical_name', 'TEXT');
      addColumnIfMissing(db, 'catalog_clubs', 'display_name', 'TEXT');
      addColumnIfMissing(db, 'catalog_clubs', 'aliases_json', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(db, 'catalog_clubs', 'region', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'catalog_clubs', 'mode_availability', "TEXT NOT NULL DEFAULT 'career_mode'");
      addColumnIfMissing(db, 'catalog_clubs', 'source_url', 'TEXT');
      addColumnIfMissing(db, 'catalog_clubs', 'dataset_version', 'TEXT');
      addColumnIfMissing(db, 'catalog_clubs', 'imported_at', 'TEXT');
      addColumnIfMissing(db, 'catalog_clubs', 'verification_status', "TEXT NOT NULL DEFAULT 'verified'");

      db.exec(`
        UPDATE catalog_clubs
        SET
          canonical_name = COALESCE(NULLIF(TRIM(canonical_name), ''), name),
          display_name = COALESCE(NULLIF(TRIM(display_name), ''), name)
      `);

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_clubs_source_ext_team
        ON catalog_clubs(source_namespace, external_team_id)
        WHERE external_team_id IS NOT NULL AND TRIM(external_team_id) != '';
        CREATE INDEX IF NOT EXISTS idx_catalog_clubs_external_team ON catalog_clubs(external_team_id);
        CREATE INDEX IF NOT EXISTS idx_catalog_nations_external_id ON catalog_nations(external_nation_id);
      `);

      // 5. Phase 3 readiness metadata on match_sessions (no AI video calls in Phase 2.2)
      addColumnIfMissing(db, 'match_sessions', 'analysis_state', "TEXT NOT NULL DEFAULT 'not_ready'");
      addColumnIfMissing(db, 'match_sessions', 'footage_classification_json', 'TEXT');
      db.exec(`
        UPDATE match_sessions
        SET analysis_state = CASE
          WHEN ai_eligible = 1 THEN 'verified_awaiting_phase3'
          ELSE 'not_ready'
        END
        WHERE analysis_state IS NULL OR TRIM(analysis_state) = '' OR analysis_state = 'not_ready'
      `);
    },
  },
  {
    version: 6,
    name: 'phase_3_tactical_vision_and_video_intelligence_v6',
    sql: `
      -- 1. Tactical Vision Master Catalog (Workstream A)
      CREATE TABLE IF NOT EXISTS catalog_tactical_vision_sources (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL CHECK (source_type IN (
          'official_ea_documentation',
          'user_provided_matrix',
          'in_game_verification',
          'internal_tactical_recommendation',
          'unverified_assumption'
        )),
        reliability_tier TEXT NOT NULL DEFAULT 'secondary_reference',
        notes TEXT NOT NULL DEFAULT '',
        conflict_resolutions_json TEXT NOT NULL DEFAULT '[]',
        verified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_tactical_visions (
        id TEXT PRIMARY KEY,
        internal_key TEXT NOT NULL UNIQUE,
        short_code TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        attacking_principles_json TEXT NOT NULL DEFAULT '[]',
        defensive_principles_json TEXT NOT NULL DEFAULT '[]',
        transition_principles_json TEXT NOT NULL DEFAULT '[]',
        strengths_json TEXT NOT NULL DEFAULT '[]',
        weaknesses_json TEXT NOT NULL DEFAULT '[]',
        evaluation_criteria_json TEXT NOT NULL DEFAULT '[]',
        source_type TEXT NOT NULL DEFAULT 'official_ea_documentation',
        source_references_json TEXT NOT NULL DEFAULT '[]',
        dataset_version TEXT NOT NULL DEFAULT 'fc26-tactical-visions-3.0.0',
        verification_status TEXT NOT NULL DEFAULT 'verified',
        last_verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_tactical_vision_aliases (
        id TEXT PRIMARY KEY,
        vision_id TEXT NOT NULL,
        alias_key TEXT NOT NULL,
        alias_label TEXT NOT NULL,
        alias_type TEXT NOT NULL DEFAULT 'legacy_alias',
        notes TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (vision_id) REFERENCES catalog_tactical_visions(id) ON DELETE CASCADE,
        UNIQUE(vision_id, alias_key)
      );

      CREATE INDEX IF NOT EXISTS idx_tv_aliases_key ON catalog_tactical_vision_aliases(alias_key COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS catalog_tactical_vision_requirements (
        id TEXT PRIMARY KEY,
        vision_id TEXT NOT NULL,
        parameter_type TEXT NOT NULL CHECK (parameter_type IN ('build_up_style', 'defensive_approach')),
        allowed_values_json TEXT NOT NULL DEFAULT '[]',
        canonical_in_game_labels_json TEXT NOT NULL DEFAULT '[]',
        is_mandatory INTEGER NOT NULL DEFAULT 1 CHECK (is_mandatory IN (0, 1)),
        source_type TEXT NOT NULL DEFAULT 'official_ea_documentation',
        source_reference TEXT NOT NULL DEFAULT '',
        verification_status TEXT NOT NULL DEFAULT 'verified',
        conflict_notes TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (vision_id) REFERENCES catalog_tactical_visions(id) ON DELETE CASCADE,
        UNIQUE(vision_id, parameter_type)
      );

      CREATE TABLE IF NOT EXISTS catalog_tactical_vision_role_affinities (
        id TEXT PRIMARY KEY,
        vision_id TEXT NOT NULL,
        position_code TEXT NOT NULL,
        role_id TEXT,
        role_name TEXT NOT NULL,
        affinity_status TEXT NOT NULL DEFAULT 'associated' CHECK (affinity_status IN ('associated', 'not_associated', 'unknown')),
        source_type TEXT NOT NULL DEFAULT 'user_provided_matrix',
        source_reference TEXT NOT NULL DEFAULT '',
        dataset_version TEXT NOT NULL DEFAULT 'fc26-tactical-visions-3.0.0',
        verification_status TEXT NOT NULL DEFAULT 'secondary_reference',
        FOREIGN KEY (vision_id) REFERENCES catalog_tactical_visions(id) ON DELETE CASCADE,
        FOREIGN KEY (role_id) REFERENCES catalog_player_roles(id) ON DELETE SET NULL,
        UNIQUE(vision_id, position_code, role_name)
      );

      CREATE INDEX IF NOT EXISTS idx_tv_role_aff_lookup
      ON catalog_tactical_vision_role_affinities(vision_id, position_code, role_name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS catalog_tactical_vision_setting_affinities (
        id TEXT PRIMARY KEY,
        vision_id TEXT NOT NULL,
        setting_type TEXT NOT NULL CHECK (setting_type IN ('build_up_style', 'defensive_height')),
        setting_value TEXT NOT NULL,
        is_associated INTEGER NOT NULL DEFAULT 0 CHECK (is_associated IN (0, 1)),
        source_type TEXT NOT NULL DEFAULT 'user_provided_matrix',
        source_reference TEXT NOT NULL DEFAULT '',
        conflict_with_official INTEGER NOT NULL DEFAULT 0 CHECK (conflict_with_official IN (0, 1)),
        conflict_note TEXT NOT NULL DEFAULT '',
        dataset_version TEXT NOT NULL DEFAULT 'fc26-tactical-visions-3.0.0',
        FOREIGN KEY (vision_id) REFERENCES catalog_tactical_visions(id) ON DELETE CASCADE,
        UNIQUE(vision_id, setting_type, setting_value)
      );

      -- 2. Club Coaching Staff & Player Role Familiarity (Section 9)
      CREATE TABLE IF NOT EXISTS club_coaches (
        id TEXT PRIMARY KEY,
        club_id TEXT NOT NULL,
        name TEXT NOT NULL,
        department TEXT NOT NULL CHECK (department IN ('attack', 'midfield', 'defense', 'goalkeeping', 'head_coach')),
        tactical_vision_key TEXT NOT NULL DEFAULT 'standard',
        qualification_level TEXT NOT NULL DEFAULT 'standard' CHECK (qualification_level IN ('bronze', 'silver', 'gold', 'standard')),
        star_rating INTEGER NOT NULL DEFAULT 3 CHECK (star_rating >= 1 AND star_rating <= 5),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_club_coaches_club ON club_coaches(club_id);

      CREATE TABLE IF NOT EXISTS player_role_familiarities (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        position_code TEXT NOT NULL,
        role_name TEXT NOT NULL,
        base_familiarity TEXT NOT NULL DEFAULT 'unknown' CHECK (base_familiarity IN ('none', 'role_plus', 'role_plus_plus', 'unknown')),
        potential_coach_familiarity TEXT NOT NULL DEFAULT 'unknown' CHECK (potential_coach_familiarity IN ('none', 'role_plus', 'role_plus_plus', 'unknown')),
        confirmed_familiarity TEXT NOT NULL DEFAULT 'unknown' CHECK (confirmed_familiarity IN ('none', 'role_plus', 'role_plus_plus', 'unknown')),
        confirmed_at TEXT,
        notes TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
        UNIQUE(player_id, position_code, role_name)
      );

      CREATE INDEX IF NOT EXISTS idx_player_role_fam_player ON player_role_familiarities(player_id);

      -- 3. Phase 3 AI Video Intelligence & Analysis Tables (Workstreams B, C, D)
      CREATE TABLE IF NOT EXISTS ai_analysis_jobs (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        session_id TEXT,
        half TEXT NOT NULL CHECK (half IN ('first_half', 'second_half')),
        analysis_mode TEXT NOT NULL DEFAULT 'quick' CHECK (analysis_mode IN ('quick', 'balanced', 'deep')),
        language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'id')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
          'not_requested',
          'queued',
          'validating_recording',
          'preprocessing',
          'uploading',
          'waiting_for_media_processing',
          'classifying_gameplay',
          'analyzing_gameplay',
          'evaluating_tactics',
          'generating_briefing',
          'validating_results',
          'completed',
          'insufficient_gameplay',
          'completed_with_limitations',
          'failed',
          'cancelled',
          'interrupted'
        )),
        current_stage TEXT NOT NULL DEFAULT 'queued',
        progress_detail_json TEXT NOT NULL DEFAULT '{}',
        model_video_id TEXT NOT NULL,
        model_synthesis_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        tactical_vision_dataset_version TEXT NOT NULL DEFAULT '',
        request_fingerprint TEXT NOT NULL DEFAULT '',
        privacy_authorized INTEGER NOT NULL DEFAULT 0 CHECK (privacy_authorized IN (0, 1)),
        entire_display_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (entire_display_acknowledged IN (0, 1)),
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        actual_cost_usd REAL,
        budget_cap_usd REAL NOT NULL DEFAULT 2.0,
        segments_total INTEGER NOT NULL DEFAULT 0,
        segments_processed INTEGER NOT NULL DEFAULT 0,
        sampling_fps REAL NOT NULL DEFAULT 1.0,
        coverage_summary TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        completed_at TEXT,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        timing_breakdown_json TEXT,
        error_code TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES match_sessions(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ai_jobs_match ON ai_analysis_jobs(match_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_analysis_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_ai_jobs_fingerprint ON ai_analysis_jobs(request_fingerprint);

      CREATE TABLE IF NOT EXISTS ai_analysis_assets (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        session_id TEXT,
        segment_id TEXT,
        local_file_path TEXT NOT NULL,
        prepared_file_path TEXT,
        is_temp_asset INTEGER NOT NULL DEFAULT 0 CHECK (is_temp_asset IN (0, 1)),
        sha256_hash TEXT NOT NULL DEFAULT '',
        file_size_bytes INTEGER NOT NULL DEFAULT 0,
        duration_seconds REAL NOT NULL DEFAULT 0,
        width INTEGER,
        height INTEGER,
        remote_file_name TEXT,
        remote_file_uri TEXT,
        remote_state TEXT,
        cleanup_status TEXT NOT NULL DEFAULT 'not_uploaded' CHECK (cleanup_status IN (
          'not_uploaded', 'pending', 'deleted', 'cleanup_failed', 'retained_by_policy'
        )),
        cleanup_attempted_at TEXT,
        cleanup_confirmed_at TEXT,
        cleanup_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES match_sessions(id) ON DELETE SET NULL,
        FOREIGN KEY (segment_id) REFERENCES recording_segments(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ai_assets_job ON ai_analysis_assets(job_id);
      CREATE INDEX IF NOT EXISTS idx_ai_assets_cleanup ON ai_analysis_assets(cleanup_status);

      CREATE TABLE IF NOT EXISTS ai_video_classifications (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        segment_id TEXT,
        start_seconds REAL NOT NULL DEFAULT 0,
        end_seconds REAL NOT NULL DEFAULT 0,
        session_start_seconds REAL NOT NULL DEFAULT 0,
        session_end_seconds REAL NOT NULL DEFAULT 0,
        content_type TEXT NOT NULL CHECK (content_type IN (
          'live_gameplay',
          'set_piece',
          'replay',
          'cutscene',
          'pre_match_menu',
          'tactical_setup',
          'squad_management',
          'pause_menu',
          'halftime_statistics',
          'fulltime_statistics',
          'loading_screen',
          'non_game_content',
          'obscured_or_black_screen',
          'unknown'
        )),
        confidence TEXT NOT NULL CHECK (confidence IN ('High', 'Medium', 'Low')),
        evidence_description TEXT NOT NULL DEFAULT '',
        in_game_clock TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ai_classifications_job ON ai_video_classifications(job_id);

      CREATE TABLE IF NOT EXISTS ai_gameplay_observations (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        half TEXT NOT NULL CHECK (half IN ('first_half', 'second_half')),
        segment_id TEXT,
        start_seconds REAL NOT NULL DEFAULT 0,
        end_seconds REAL NOT NULL DEFAULT 0,
        session_start_seconds REAL NOT NULL DEFAULT 0,
        session_end_seconds REAL NOT NULL DEFAULT 0,
        in_game_clock TEXT,
        category_group TEXT NOT NULL CHECK (category_group IN ('attacking', 'defensive', 'possession', 'match_events')),
        category TEXT NOT NULL,
        team_attribution TEXT NOT NULL DEFAULT 'unknown' CHECK (team_attribution IN ('user_team', 'opponent', 'both', 'unknown')),
        player_attribution TEXT NOT NULL DEFAULT 'Unknown',
        description TEXT NOT NULL,
        supporting_visual_evidence TEXT NOT NULL DEFAULT '',
        evidence_type TEXT NOT NULL DEFAULT 'directly_observed' CHECK (evidence_type IN (
          'directly_observed',
          'hud_or_statistics_screen',
          'user_confirmed',
          'tactical_inference',
          'master_database_attribute'
        )),
        confidence TEXT NOT NULL CHECK (confidence IN ('High', 'Medium', 'Low')),
        severity TEXT NOT NULL DEFAULT 'Medium' CHECK (severity IN ('Critical', 'High', 'Medium', 'Low', 'Positive')),
        limitations TEXT NOT NULL DEFAULT '',
        evidence_frame_path TEXT,
        is_from_replay INTEGER NOT NULL DEFAULT 0 CHECK (is_from_replay IN (0, 1)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ai_obs_job ON ai_gameplay_observations(job_id);
      CREATE INDEX IF NOT EXISTS idx_ai_obs_match ON ai_gameplay_observations(match_id, half);

      CREATE TABLE IF NOT EXISTS ai_tactical_vision_assessments (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE,
        match_id TEXT NOT NULL,
        half TEXT NOT NULL CHECK (half IN ('first_half', 'second_half')),
        intended_vision_key TEXT NOT NULL DEFAULT 'unspecified',
        observed_playing_style_json TEXT NOT NULL DEFAULT '{}',
        recommended_vision_key TEXT NOT NULL DEFAULT 'retain_current',
        recommendation_stance TEXT NOT NULL DEFAULT 'retain_and_refine' CHECK (recommendation_stance IN (
          'retain_and_refine', 'adapt_vision', 'insufficient_evidence'
        )),
        recommendation_rationale TEXT NOT NULL DEFAULT '',
        official_compliance_status TEXT NOT NULL DEFAULT 'unspecified',
        role_affinity_matched_count INTEGER NOT NULL DEFAULT 0,
        role_affinity_total_count INTEGER NOT NULL DEFAULT 0,
        role_affinity_unknown_count INTEGER NOT NULL DEFAULT 0,
        execution_assessment_label TEXT NOT NULL DEFAULT 'Unknown',
        internal_assessment_score INTEGER,
        score_methodology_note TEXT NOT NULL DEFAULT '',
        criteria_breakdown_json TEXT NOT NULL DEFAULT '[]',
        confidence TEXT NOT NULL DEFAULT 'Low' CHECK (confidence IN ('High', 'Medium', 'Low')),
        limitations TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS ai_tactical_recommendations (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        priority_group TEXT NOT NULL CHECK (priority_group IN (
          'immediate_correction',
          'player_change',
          'structural_adjustment',
          'gameplay_coaching',
          'contingency_plan'
        )),
        priority_rank INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_slot_id TEXT,
        target_position_code TEXT,
        current_value TEXT NOT NULL DEFAULT '',
        proposed_value TEXT NOT NULL DEFAULT '',
        target_player_out_id TEXT,
        target_player_in_id TEXT,
        reason TEXT NOT NULL DEFAULT '',
        expected_benefit TEXT NOT NULL DEFAULT '',
        potential_risk TEXT NOT NULL DEFAULT '',
        evidence_observation_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_timestamps_json TEXT NOT NULL DEFAULT '[]',
        confidence TEXT NOT NULL DEFAULT 'Medium' CHECK (confidence IN ('High', 'Medium', 'Low')),
        validation_status TEXT NOT NULL DEFAULT 'valid' CHECK (validation_status IN ('valid', 'corrected', 'invalid_unsupported')),
        validation_errors_json TEXT NOT NULL DEFAULT '[]',
        raw_ai_proposal_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ai_recs_job ON ai_tactical_recommendations(job_id, priority_group, priority_rank);

      CREATE TABLE IF NOT EXISTS ai_recommendation_decisions (
        id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL UNIQUE,
        match_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        decision_status TEXT NOT NULL DEFAULT 'ai_recommended' CHECK (decision_status IN (
          'ai_recommended',
          'user_accepted',
          'user_modified',
          'user_rejected',
          'applied_in_game',
          'unable_to_verify'
        )),
        modified_value TEXT,
        applied_in_game INTEGER NOT NULL DEFAULT 0 CHECK (applied_in_game IN (0, 1)),
        applied_confirmed_at TEXT,
        adjustment_snapshot_id TEXT,
        user_notes TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (recommendation_id) REFERENCES ai_tactical_recommendations(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (adjustment_snapshot_id) REFERENCES match_tactical_snapshots(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS ai_halftime_briefings (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE,
        match_id TEXT NOT NULL,
        half TEXT NOT NULL CHECK (half IN ('first_half', 'second_half')),
        language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'id')),
        model_used TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        briefing_json TEXT NOT NULL,
        evidence_quality TEXT NOT NULL DEFAULT 'limited',
        limitations_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ai_briefings_match ON ai_halftime_briefings(match_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_second_half_comparisons (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE,
        match_id TEXT NOT NULL,
        first_half_job_id TEXT,
        model_used TEXT NOT NULL,
        comparison_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        FOREIGN KEY (first_half_job_id) REFERENCES ai_analysis_jobs(id) ON DELETE SET NULL
      );
    `,
    afterSql: (db: Database.Database) => {
      // 1. Club Tactical Identity fields on career_profiles (non-destructive, legacy stays 'unspecified')
      addColumnIfMissing(db, 'career_profiles', 'primary_tactical_vision_key', "TEXT NOT NULL DEFAULT 'unspecified'");
      addColumnIfMissing(db, 'career_profiles', 'alternative_tactical_vision_key', "TEXT NOT NULL DEFAULT 'unspecified'");
      addColumnIfMissing(db, 'career_profiles', 'preferred_build_up_style', "TEXT NOT NULL DEFAULT 'Balanced'");
      addColumnIfMissing(db, 'career_profiles', 'preferred_defensive_approach', "TEXT NOT NULL DEFAULT 'Balanced'");
      addColumnIfMissing(db, 'career_profiles', 'preferred_defensive_line_height', 'INTEGER NOT NULL DEFAULT 55');
      addColumnIfMissing(db, 'career_profiles', 'tactical_philosophy_notes', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'career_profiles', 'tactical_flexibility', "TEXT NOT NULL DEFAULT 'balanced'");

      // 2. Tactical Vision key on tactical_presets (legacy presets explicitly marked 'unspecified', never guessed)
      addColumnIfMissing(db, 'tactical_presets', 'tactical_vision_key', "TEXT NOT NULL DEFAULT 'unspecified'");

      // 3. Immutable Tactical Vision snapshot fields + explicit in-game confirmation on match_tactical_snapshots
      addColumnIfMissing(db, 'match_tactical_snapshots', 'tactical_vision_key', "TEXT NOT NULL DEFAULT 'unspecified'");
      addColumnIfMissing(db, 'match_tactical_snapshots', 'tactical_vision_dataset_version', 'TEXT');
      addColumnIfMissing(db, 'match_tactical_snapshots', 'applied_in_game_confirmed', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'match_tactical_snapshots', 'applied_in_game_at', 'TEXT');

      // 4. Extend api_usage_logs with Phase 3 video/cost telemetry
      addColumnIfMissing(db, 'api_usage_logs', 'analysis_job_id', 'TEXT');
      addColumnIfMissing(db, 'api_usage_logs', 'file_size_bytes', 'INTEGER');
      addColumnIfMissing(db, 'api_usage_logs', 'video_duration_seconds', 'REAL');
      addColumnIfMissing(db, 'api_usage_logs', 'request_duration_ms', 'INTEGER');
      addColumnIfMissing(db, 'api_usage_logs', 'estimated_cost_usd', 'REAL');
      addColumnIfMissing(db, 'api_usage_logs', 'pricing_source', 'TEXT');
      addColumnIfMissing(db, 'api_usage_logs', 'is_estimate', 'INTEGER NOT NULL DEFAULT 1');

      // 5. Idempotently ensure Wide Half CDM role exists in catalog_player_roles for upgraded v5 databases
      const now = new Date().toISOString();
      const cdmPos = db.prepare("SELECT code FROM catalog_positions WHERE code = 'CDM'").get() as
        | { code: string }
        | undefined;
      if (cdmPos) {
        const existingWideHalf = db
          .prepare("SELECT id FROM catalog_player_roles WHERE LOWER(name) = 'wide half'")
          .get() as { id: string } | undefined;

        const wideHalfRoleId = existingWideHalf?.id ?? 'role_fc26_wide_half';
        if (!existingWideHalf) {
          db.prepare(`
            INSERT OR IGNORE INTO catalog_player_roles (
              id, external_source_id, name, description, position_category,
              tactical_behavior, attacking_behavior, defensive_behavior,
              is_fc26_new, verification_status, source_reference, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'verified', ?, ?, ?)
          `).run(
            wideHalfRoleId,
            'role_cdm_wide_half',
            'Wide Half',
            'Defensive midfielder who drifts into wide channels during possession to cover flanks behind advancing fullbacks or create wide build-up angles.',
            'Midfielder',
            'Shifts horizontally toward the touchline to support wide progression and protect flank transitions.',
            'Creates wide passing relief and diagonal delivery angles from deep.',
            'Covers wide spaces behind overlapping fullbacks and guards outer channels.',
            'EA FC 26 Pitch Notes & User Tactical Vision Matrix',
            now,
            now
          );
        }

        db.prepare(`
          INSERT OR IGNORE INTO catalog_role_position_compatibility (
            id, role_id, position_code, verification_status, evidence
          ) VALUES (?, ?, 'CDM', 'verified', 'EA FC 26 Pitch Notes & User Tactical Vision Matrix')
        `).run(`rpc_${wideHalfRoleId}_CDM`, wideHalfRoleId);

        const focusRows = db
          .prepare("SELECT id, name FROM catalog_player_focuses WHERE name IN ('Defend', 'Build-Up')")
          .all() as Array<{ id: string; name: string }>;
        for (const f of focusRows) {
          db.prepare(`
            INSERT OR IGNORE INTO catalog_role_focus_compatibility (
              id, role_id, position_code, focus_id, verification_status, evidence
            ) VALUES (?, ?, 'CDM', ?, 'verified', 'EA FC 26 Pitch Notes & User Tactical Vision Matrix')
          `).run(`rfc_${wideHalfRoleId}_CDM_${f.id}`, wideHalfRoleId, f.id);
        }
      }
    },
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
        if (migration.afterSql) {
          migration.afterSql(db);
        }
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
        ).run(migration.version, migration.name, new Date().toISOString());
      });

      if (migration.disableForeignKeys) {
        db.pragma('foreign_keys = OFF');
        try {
          apply();
        } finally {
          db.pragma('foreign_keys = ON');
        }
        const fkViolations = db.pragma('foreign_key_check') as unknown[];
        if (fkViolations.length > 0) {
          console.warn(
            `[db-migration] Foreign key check reported ${fkViolations.length} issue(s) after v${migration.version}.`
          );
        }
      } else {
        apply();
      }
    }
  }
}
