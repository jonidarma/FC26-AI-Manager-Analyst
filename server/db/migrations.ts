import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
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
      apply();
    }
  }
}
