import crypto from 'node:crypto';
import type {
  ApiUsageLog,
  ApplicationSettings,
  ClubWithProfile,
  ConfidenceLevel,
  DashboardSummary,
  FeedbackChoice,
  HalftimeReportData,
  MatchRecord,
  MatchStatus,
  MatchVenue,
  Opponent,
  Player,
  PlayerRoleAssignment,
  PostMatchReportRecord,
  RecommendationFeedbackRecord,
  StructuredTacticalRecommendation,
  TacticalCatalogItem,
  TacticalConfiguration,
  TacticalMemoryEntry,
} from '../../src/types/domain.ts';
import { DEFAULT_APP_SETTINGS, getDb } from '../db/database.ts';
import { getCatalogPlayerById } from './catalogRepository.ts';
import { validatePlayerRoleFocus } from './tacticalContextService.ts';

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getSettings(): ApplicationSettings {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM application_settings WHERE key = ?')
    .get('app_config') as { value_json: string } | undefined;

  if (!row) return DEFAULT_APP_SETTINGS;
  const parsed = safeJsonParse<Partial<ApplicationSettings>>(row.value_json, {});
  return {
    capture: {
      ...DEFAULT_APP_SETTINGS.capture,
      ...(parsed.capture ?? {}),
      microphoneEnabled: false,
    },
    ai: {
      ...DEFAULT_APP_SETTINGS.ai,
      ...(parsed.ai ?? {}),
    },
    activeClubId: parsed.activeClubId ?? null,
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
  };
}

export function updateSettings(patch: Partial<ApplicationSettings>): ApplicationSettings {
  const db = getDb();
  const current = getSettings();
  const now = new Date().toISOString();

  const merged: ApplicationSettings = {
    capture: {
      ...current.capture,
      ...(patch.capture ?? {}),
      microphoneEnabled: false, // Microphone is never recorded per specification
    },
    ai: {
      ...current.ai,
      ...(patch.ai ?? {}),
    },
    activeClubId: patch.activeClubId !== undefined ? patch.activeClubId : current.activeClubId,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO application_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run('app_config', JSON.stringify(merged), now);

  return merged;
}

export function listClubs(): ClubWithProfile[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT
        c.id, c.name, c.league, c.nation, c.catalog_club_id, c.created_at, c.updated_at,
        cp.id as profile_id, cp.season, cp.manager_name, cp.preferred_philosophy,
        cp.primary_formation, cp.alternative_formation, cp.preferred_attacking_style,
        cp.preferred_defensive_style, cp.is_active, cp.created_at as profile_created_at,
        cp.updated_at as profile_updated_at,
        (SELECT COUNT(*) FROM players p WHERE p.club_id = c.id) as player_count,
        (SELECT COUNT(*) FROM matches m WHERE m.club_id = c.id) as match_count
      FROM clubs c
      JOIN career_profiles cp ON cp.club_id = c.id
      ORDER BY cp.is_active DESC, c.updated_at DESC
    `)
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    league: String(r.league),
    nation: String(r.nation ?? ''),
    catalogClubId: r.catalog_club_id ? String(r.catalog_club_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    playerCount: Number(r.player_count ?? 0),
    matchCount: Number(r.match_count ?? 0),
    profile: {
      id: String(r.profile_id),
      clubId: String(r.id),
      season: String(r.season),
      managerName: String(r.manager_name),
      preferredPhilosophy: String(r.preferred_philosophy),
      primaryFormation: String(r.primary_formation),
      alternativeFormation: String(r.alternative_formation),
      preferredAttackingStyle: String(r.preferred_attacking_style),
      preferredDefensiveStyle: String(r.preferred_defensive_style),
      isActive: Boolean(r.is_active),
      createdAt: String(r.profile_created_at),
      updatedAt: String(r.profile_updated_at),
    },
  }));
}

export function createClub(input: {
  name: string;
  league: string;
  nation?: string;
  catalogClubId?: string | null;
  season: string;
  managerName: string;
  preferredPhilosophy: string;
  primaryFormation: string;
  alternativeFormation: string;
  preferredAttackingStyle: string;
  preferredDefensiveStyle: string;
  setActive?: boolean;
}): ClubWithProfile {
  const db = getDb();
  const clubId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const now = new Date().toISOString();

  const existingCount = (
    db.prepare('SELECT COUNT(*) as count FROM clubs').get() as { count: number }
  ).count;
  const shouldBeActive = input.setActive ?? existingCount === 0;

  const tx = db.transaction(() => {
    if (shouldBeActive) {
      db.prepare('UPDATE career_profiles SET is_active = 0').run();
    }
    db.prepare(`
      INSERT INTO clubs (id, name, league, nation, catalog_club_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      clubId,
      input.name.trim(),
      input.league.trim(),
      (input.nation ?? '').trim(),
      input.catalogClubId ?? null,
      now,
      now
    );

    db.prepare(`
      INSERT INTO career_profiles (
        id, club_id, season, manager_name, preferred_philosophy,
        primary_formation, alternative_formation, preferred_attacking_style,
        preferred_defensive_style, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profileId,
      clubId,
      input.season.trim(),
      input.managerName.trim(),
      input.preferredPhilosophy.trim(),
      input.primaryFormation.trim(),
      input.alternativeFormation.trim(),
      input.preferredAttackingStyle.trim(),
      input.preferredDefensiveStyle.trim(),
      shouldBeActive ? 1 : 0,
      now,
      now
    );
  });

  tx();

  if (shouldBeActive) {
    updateSettings({ activeClubId: clubId });
  }

  return listClubs().find((c) => c.id === clubId)!;
}

export function updateClub(
  clubId: string,
  input: {
    name?: string;
    league?: string;
    nation?: string;
    catalogClubId?: string | null;
    season?: string;
    managerName?: string;
    preferredPhilosophy?: string;
    primaryFormation?: string;
    alternativeFormation?: string;
    preferredAttackingStyle?: string;
    preferredDefensiveStyle?: string;
  }
): ClubWithProfile | null {
  const db = getDb();
  const existing = listClubs().find((c) => c.id === clubId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE clubs SET name = ?, league = ?, nation = ?, catalog_club_id = ?, updated_at = ? WHERE id = ?'
    ).run(
      input.name?.trim() ?? existing.name,
      input.league?.trim() ?? existing.league,
      input.nation?.trim() ?? existing.nation,
      input.catalogClubId !== undefined ? input.catalogClubId : existing.catalogClubId,
      now,
      clubId
    );

    db.prepare(`
      UPDATE career_profiles
      SET season = ?, manager_name = ?, preferred_philosophy = ?,
          primary_formation = ?, alternative_formation = ?,
          preferred_attacking_style = ?, preferred_defensive_style = ?, updated_at = ?
      WHERE club_id = ?
    `).run(
      input.season?.trim() ?? existing.profile.season,
      input.managerName?.trim() ?? existing.profile.managerName,
      input.preferredPhilosophy?.trim() ?? existing.profile.preferredPhilosophy,
      input.primaryFormation?.trim() ?? existing.profile.primaryFormation,
      input.alternativeFormation?.trim() ?? existing.profile.alternativeFormation,
      input.preferredAttackingStyle?.trim() ?? existing.profile.preferredAttackingStyle,
      input.preferredDefensiveStyle?.trim() ?? existing.profile.preferredDefensiveStyle,
      now,
      clubId
    );
  });

  tx();
  return listClubs().find((c) => c.id === clubId) ?? null;
}

export function setActiveClub(clubId: string): ClubWithProfile | null {
  const db = getDb();
  const target = db.prepare('SELECT id FROM clubs WHERE id = ?').get(clubId);
  if (!target) return null;

  const tx = db.transaction(() => {
    db.prepare('UPDATE career_profiles SET is_active = 0').run();
    db.prepare('UPDATE career_profiles SET is_active = 1, updated_at = ? WHERE club_id = ?').run(
      new Date().toISOString(),
      clubId
    );
  });
  tx();

  updateSettings({ activeClubId: clubId });
  return listClubs().find((c) => c.id === clubId) ?? null;
}

export function deleteClub(clubId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM clubs WHERE id = ?').run(clubId);
  if (result.changes === 0) return false;

  const remaining = listClubs();
  if (remaining.length > 0 && !remaining.some((c) => c.profile.isActive)) {
    setActiveClub(remaining[0].id);
  } else if (remaining.length === 0) {
    updateSettings({ activeClubId: null });
  }
  return true;
}

export function listPlayers(clubId: string): Player[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM players WHERE club_id = ? ORDER BY overall_rating DESC NULLS LAST, name ASC')
    .all(clubId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    clubId: String(r.club_id),
    catalogPlayerId: r.catalog_player_id ? String(r.catalog_player_id) : null,
    name: String(r.name),
    position: String(r.position),
    overallRating: r.overall_rating === null ? null : Number(r.overall_rating),
    potentialRating: r.potential_rating === null || r.potential_rating === undefined ? null : Number(r.potential_rating),
    age: r.age === null || r.age === undefined ? null : Number(r.age),
    preferredFoot: String(r.preferred_foot) as Player['preferredFoot'],
    playerRole: String(r.player_role),
    playerFocus: String(r.player_focus ?? ''),
    contractExpiry: r.contract_expiry ? String(r.contract_expiry) : null,
    marketValueEur: r.market_value_eur === null || r.market_value_eur === undefined ? null : Number(r.market_value_eur),
    wageEur: r.wage_eur === null || r.wage_eur === undefined ? null : Number(r.wage_eur),
    strengths: String(r.strengths),
    weaknesses: String(r.weaknesses),
    preferredInstructions: String(r.preferred_instructions),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function createPlayer(input: {
  clubId: string;
  catalogPlayerId?: string | null;
  name: string;
  position: string;
  overallRating: number | null;
  potentialRating?: number | null;
  age?: number | null;
  preferredFoot: 'Right' | 'Left' | 'Both';
  playerRole: string;
  playerFocus?: string;
  contractExpiry?: string | null;
  marketValueEur?: number | null;
  wageEur?: number | null;
  strengths: string;
  weaknesses: string;
  preferredInstructions: string;
}): Player {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO players (
      id, club_id, catalog_player_id, name, position, overall_rating, potential_rating, age,
      preferred_foot, player_role, player_focus, contract_expiry, market_value_eur, wage_eur,
      strengths, weaknesses, preferred_instructions, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.clubId,
    input.catalogPlayerId ?? null,
    input.name.trim(),
    input.position.trim().toUpperCase(),
    input.overallRating,
    input.potentialRating ?? null,
    input.age ?? null,
    input.preferredFoot,
    input.playerRole.trim(),
    (input.playerFocus ?? '').trim(),
    input.contractExpiry ?? null,
    input.marketValueEur ?? null,
    input.wageEur ?? null,
    input.strengths.trim(),
    input.weaknesses.trim(),
    input.preferredInstructions.trim(),
    now,
    now
  );

  return listPlayers(input.clubId).find((p) => p.id === id)!;
}

export function importPlayerFromCatalog(
  clubId: string,
  catalogPlayerId: string,
  overrides: Partial<{
    position: string;
    overallRating: number | null;
    potentialRating: number | null;
    age: number | null;
    playerRole: string;
    playerFocus: string;
    contractExpiry: string | null;
    strengths: string;
    weaknesses: string;
    preferredInstructions: string;
  }> = {}
): Player | null {
  const master = getCatalogPlayerById(catalogPlayerId);
  if (!master) return null;

  return createPlayer({
    clubId,
    catalogPlayerId: master.id,
    name: master.fullName,
    position: overrides.position ?? master.primaryPosition,
    overallRating:
      overrides.overallRating !== undefined ? overrides.overallRating : master.overallRating,
    potentialRating:
      overrides.potentialRating !== undefined ? overrides.potentialRating : master.potentialRating,
    age: overrides.age !== undefined ? overrides.age : master.age,
    preferredFoot: master.preferredFoot ?? 'Right',
    playerRole: overrides.playerRole ?? '',
    playerFocus: overrides.playerFocus ?? '',
    contractExpiry:
      overrides.contractExpiry !== undefined ? overrides.contractExpiry : master.contractExpiry,
    marketValueEur: master.marketValueEur,
    wageEur: master.wageEur,
    strengths: overrides.strengths ?? '',
    weaknesses: overrides.weaknesses ?? '',
    preferredInstructions: overrides.preferredInstructions ?? '',
  });
}

export function updatePlayer(
  playerId: string,
  input: Partial<{
    name: string;
    position: string;
    overallRating: number | null;
    potentialRating: number | null;
    age: number | null;
    preferredFoot: 'Right' | 'Left' | 'Both';
    playerRole: string;
    playerFocus: string;
    contractExpiry: string | null;
    marketValueEur: number | null;
    wageEur: number | null;
    strengths: string;
    weaknesses: string;
    preferredInstructions: string;
  }>
): Player | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE players
    SET name = ?, position = ?, overall_rating = ?, potential_rating = ?, age = ?,
        preferred_foot = ?, player_role = ?, player_focus = ?, contract_expiry = ?,
        market_value_eur = ?, wage_eur = ?, strengths = ?, weaknesses = ?,
        preferred_instructions = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name?.trim() ?? String(row.name),
    input.position?.trim().toUpperCase() ?? String(row.position),
    input.overallRating !== undefined
      ? input.overallRating
      : row.overall_rating === null
        ? null
        : Number(row.overall_rating),
    input.potentialRating !== undefined
      ? input.potentialRating
      : row.potential_rating === null || row.potential_rating === undefined
        ? null
        : Number(row.potential_rating),
    input.age !== undefined
      ? input.age
      : row.age === null || row.age === undefined
        ? null
        : Number(row.age),
    input.preferredFoot ?? String(row.preferred_foot),
    input.playerRole?.trim() ?? String(row.player_role),
    input.playerFocus?.trim() ?? String(row.player_focus ?? ''),
    input.contractExpiry !== undefined
      ? input.contractExpiry
      : row.contract_expiry
        ? String(row.contract_expiry)
        : null,
    input.marketValueEur !== undefined
      ? input.marketValueEur
      : row.market_value_eur === null || row.market_value_eur === undefined
        ? null
        : Number(row.market_value_eur),
    input.wageEur !== undefined
      ? input.wageEur
      : row.wage_eur === null || row.wage_eur === undefined
        ? null
        : Number(row.wage_eur),
    input.strengths?.trim() ?? String(row.strengths),
    input.weaknesses?.trim() ?? String(row.weaknesses),
    input.preferredInstructions?.trim() ?? String(row.preferred_instructions),
    now,
    playerId
  );

  return listPlayers(String(row.club_id)).find((p) => p.id === playerId) ?? null;
}

export function deletePlayer(playerId: string): boolean {
  const db = getDb();
  return db.prepare('DELETE FROM players WHERE id = ?').run(playerId).changes > 0;
}

export function listOpponents(): Opponent[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM opponents ORDER BY name ASC')
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    league: String(r.league),
    catalogClubId: r.catalog_club_id ? String(r.catalog_club_id) : null,
    typicalFormation: String(r.typical_formation),
    strengths: String(r.strengths),
    weaknesses: String(r.weaknesses),
    dangerousChannels: String(r.dangerous_channels),
    notes: String(r.notes),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function createOpponent(input: {
  name: string;
  league: string;
  catalogClubId?: string | null;
  typicalFormation: string;
  strengths: string;
  weaknesses: string;
  dangerousChannels: string;
  notes: string;
}): Opponent {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO opponents (
      id, name, league, catalog_club_id, typical_formation, strengths, weaknesses,
      dangerous_channels, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name.trim(),
    input.league.trim(),
    input.catalogClubId ?? null,
    input.typicalFormation.trim() || 'Unknown',
    input.strengths.trim(),
    input.weaknesses.trim(),
    input.dangerousChannels.trim(),
    input.notes.trim(),
    now,
    now
  );

  return listOpponents().find((o) => o.id === id)!;
}

export function updateOpponent(
  id: string,
  input: Partial<{
    name: string;
    league: string;
    catalogClubId: string | null;
    typicalFormation: string;
    strengths: string;
    weaknesses: string;
    dangerousChannels: string;
    notes: string;
  }>
): Opponent | null {
  const db = getDb();
  const existing = listOpponents().find((o) => o.id === id);
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE opponents
    SET name = ?, league = ?, catalog_club_id = ?, typical_formation = ?, strengths = ?,
        weaknesses = ?, dangerous_channels = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name?.trim() ?? existing.name,
    input.league?.trim() ?? existing.league,
    input.catalogClubId !== undefined ? input.catalogClubId : existing.catalogClubId,
    input.typicalFormation?.trim() ?? existing.typicalFormation,
    input.strengths?.trim() ?? existing.strengths,
    input.weaknesses?.trim() ?? existing.weaknesses,
    input.dangerousChannels?.trim() ?? existing.dangerousChannels,
    input.notes?.trim() ?? existing.notes,
    now,
    id
  );

  return listOpponents().find((o) => o.id === id) ?? null;
}

export function deleteOpponent(id: string): { deleted: boolean; error?: string } {
  const db = getDb();
  const refCount = (
    db.prepare('SELECT COUNT(*) as count FROM matches WHERE opponent_id = ?').get(id) as {
      count: number;
    }
  ).count;

  if (refCount > 0) {
    return {
      deleted: false,
      error: `Cannot delete opponent referenced by ${refCount} saved match record(s).`,
    };
  }

  const res = db.prepare('DELETE FROM opponents WHERE id = ?').run(id);
  return { deleted: res.changes > 0 };
}

function mapMatchRow(r: Record<string, unknown>, db: ReturnType<typeof getDb>): MatchRecord {
  const matchId = String(r.id);
  const configRow = db
    .prepare(
      `SELECT * FROM tactical_configurations WHERE match_id = ? ORDER BY CASE phase WHEN 'pre_match' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
    )
    .get(matchId) as Record<string, unknown> | undefined;

  const tacticalConfiguration: TacticalConfiguration | null = configRow
    ? {
        id: String(configRow.id),
        matchId: String(configRow.match_id),
        clubId: String(configRow.club_id),
        label: String(configRow.label),
        phase: String(configRow.phase) as TacticalConfiguration['phase'],
        formation: String(configRow.formation),
        buildUpStyle: String(configRow.build_up_style),
        defensiveApproach: String(configRow.defensive_approach),
        defensiveLineHeight: Number(configRow.defensive_line_height),
        playerAssignments: safeJsonParse<PlayerRoleAssignment[]>(
          String(configRow.player_assignments_json),
          []
        ),
        customParameters: safeJsonParse<Record<string, string>>(
          String(configRow.custom_parameters_json),
          {}
        ),
        createdAt: String(configRow.created_at),
      }
    : null;

  return {
    id: matchId,
    clubId: String(r.club_id),
    careerProfileId: String(r.career_profile_id),
    opponentId: String(r.opponent_id),
    opponentName: String(r.opponent_name ?? 'Unknown Opponent'),
    competition: String(r.competition),
    venue: String(r.venue) as MatchVenue,
    matchDate: String(r.match_date),
    status: String(r.status) as MatchStatus,
    startingFormation: String(r.starting_formation),
    startingXiIds: safeJsonParse<string[]>(String(r.starting_xi_json), []),
    benchIds: safeJsonParse<string[]>(String(r.bench_json), []),
    objective: String(r.objective),
    preMatchNotes: String(r.pre_match_notes),
    halftimeScoreFor: r.halftime_score_for === null ? null : Number(r.halftime_score_for),
    halftimeScoreAgainst:
      r.halftime_score_against === null ? null : Number(r.halftime_score_against),
    finalScoreFor: r.final_score_for === null ? null : Number(r.final_score_for),
    finalScoreAgainst: r.final_score_against === null ? null : Number(r.final_score_against),
    hasSecondHalfRecording: Boolean(r.has_second_half_recording),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    tacticalConfiguration,
    hasHalftimeReport: Boolean(r.has_halftime_report),
    hasPostMatchReport: Boolean(r.has_post_match_report),
  };
}

export function listMatches(clubId?: string): MatchRecord[] {
  const db = getDb();
  const query = clubId
    ? `
      SELECT m.*, o.name as opponent_name,
        EXISTS(SELECT 1 FROM halftime_reports hr WHERE hr.match_id = m.id) as has_halftime_report,
        EXISTS(SELECT 1 FROM post_match_reports pmr WHERE pmr.match_id = m.id) as has_post_match_report
      FROM matches m
      JOIN opponents o ON o.id = m.opponent_id
      WHERE m.club_id = ?
      ORDER BY m.match_date DESC, m.created_at DESC
    `
    : `
      SELECT m.*, o.name as opponent_name,
        EXISTS(SELECT 1 FROM halftime_reports hr WHERE hr.match_id = m.id) as has_halftime_report,
        EXISTS(SELECT 1 FROM post_match_reports pmr WHERE pmr.match_id = m.id) as has_post_match_report
      FROM matches m
      JOIN opponents o ON o.id = m.opponent_id
      ORDER BY m.match_date DESC, m.created_at DESC
    `;

  const rows = (clubId ? db.prepare(query).all(clubId) : db.prepare(query).all()) as Array<
    Record<string, unknown>
  >;

  return rows.map((r) => mapMatchRow(r, db));
}

export function createMatch(input: {
  clubId: string;
  careerProfileId: string;
  opponentId?: string;
  opponentName?: string;
  competition: string;
  venue: MatchVenue;
  matchDate: string;
  startingFormation: string;
  startingXiIds: string[];
  benchIds: string[];
  objective: string;
  preMatchNotes: string;
  tacticalSetup: {
    buildUpStyle: string;
    defensiveApproach: string;
    defensiveLineHeight: number;
    playerAssignments: PlayerRoleAssignment[];
    customParameters?: Record<string, string>;
  };
}): MatchRecord {
  const db = getDb();
  const matchId = crypto.randomUUID();
  const configId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Enforce verified FC 26 Role-Position and Role-Focus compatibility before persisting
  for (const assignment of input.tacticalSetup.playerAssignments) {
    if (assignment.role.trim() || assignment.focus.trim()) {
      const check = validatePlayerRoleFocus(
        assignment.positionCode,
        assignment.role,
        assignment.focus,
        db
      );
      if (!check.valid) {
        throw new Error(`Slot #${assignment.slotIndex + 1} (${assignment.positionCode}): ${check.reason}`);
      }
    }
  }

  let resolvedOpponentId = input.opponentId;

  const tx = db.transaction(() => {
    if (!resolvedOpponentId) {
      const oppName = (input.opponentName ?? '').trim();
      if (!oppName) {
        throw new Error('Either an existing opponentId or a new opponentName is required.');
      }
      const existingOpp = db
        .prepare('SELECT id FROM opponents WHERE LOWER(name) = LOWER(?)')
        .get(oppName) as { id: string } | undefined;

      if (existingOpp) {
        resolvedOpponentId = existingOpp.id;
      } else {
        resolvedOpponentId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO opponents (id, name, league, typical_formation, strengths, weaknesses, dangerous_channels, notes, created_at, updated_at)
          VALUES (?, ?, ?, 'Unknown', '', '', '', '', ?, ?)
        `).run(resolvedOpponentId, oppName, input.competition.trim(), now, now);
      }
    }

    db.prepare(`
      INSERT INTO matches (
        id, club_id, career_profile_id, opponent_id, competition, venue,
        match_date, status, starting_formation, starting_xi_json, bench_json,
        objective, pre_match_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      matchId,
      input.clubId,
      input.careerProfileId,
      resolvedOpponentId,
      input.competition.trim(),
      input.venue,
      input.matchDate,
      input.startingFormation,
      JSON.stringify(input.startingXiIds),
      JSON.stringify(input.benchIds),
      input.objective.trim(),
      input.preMatchNotes.trim(),
      now,
      now
    );

    db.prepare(`
      INSERT INTO tactical_configurations (
        id, match_id, club_id, label, phase, formation, build_up_style,
        defensive_approach, defensive_line_height, player_assignments_json,
        custom_parameters_json, created_at
      ) VALUES (?, ?, ?, ?, 'pre_match', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      configId,
      matchId,
      input.clubId,
      'Pre-Match Setup',
      input.startingFormation,
      input.tacticalSetup.buildUpStyle,
      input.tacticalSetup.defensiveApproach,
      input.tacticalSetup.defensiveLineHeight,
      JSON.stringify(input.tacticalSetup.playerAssignments),
      JSON.stringify(input.tacticalSetup.customParameters ?? {}),
      now
    );
  });

  tx();
  return listMatches(input.clubId).find((m) => m.id === matchId)!;
}

export function updateMatchResult(
  matchId: string,
  input: {
    status?: MatchStatus;
    halftimeScoreFor?: number | null;
    halftimeScoreAgainst?: number | null;
    finalScoreFor?: number | null;
    finalScoreAgainst?: number | null;
    preMatchNotes?: string;
    objective?: string;
  }
): MatchRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE matches
    SET status = ?, halftime_score_for = ?, halftime_score_against = ?,
        final_score_for = ?, final_score_against = ?, pre_match_notes = ?,
        objective = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.status ?? String(row.status),
    input.halftimeScoreFor !== undefined ? input.halftimeScoreFor : row.halftime_score_for,
    input.halftimeScoreAgainst !== undefined
      ? input.halftimeScoreAgainst
      : row.halftime_score_against,
    input.finalScoreFor !== undefined ? input.finalScoreFor : row.final_score_for,
    input.finalScoreAgainst !== undefined ? input.finalScoreAgainst : row.final_score_against,
    input.preMatchNotes !== undefined ? input.preMatchNotes : String(row.pre_match_notes),
    input.objective !== undefined ? input.objective : String(row.objective),
    now,
    matchId
  );

  return listMatches(String(row.club_id)).find((m) => m.id === matchId) ?? null;
}

export function deleteMatch(matchId: string): boolean {
  const db = getDb();
  return db.prepare('DELETE FROM matches WHERE id = ?').run(matchId).changes > 0;
}

export function getHalftimeReport(matchId: string): HalftimeReportData | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM halftime_reports WHERE match_id = ?')
    .get(matchId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const parsed = safeJsonParse<HalftimeReportData | null>(String(row.report_json), null);
  return parsed;
}

export function listAllHalftimeReports(): Array<{
  matchId: string;
  opponentName: string;
  competition: string;
  matchDate: string;
  report: HalftimeReportData;
}> {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT hr.match_id, hr.report_json, o.name as opponent_name, m.competition, m.match_date
      FROM halftime_reports hr
      JOIN matches m ON m.id = hr.match_id
      JOIN opponents o ON o.id = m.opponent_id
      ORDER BY hr.created_at DESC
    `)
    .all() as Array<Record<string, unknown>>;

  return rows
    .map((r) => {
      const report = safeJsonParse<HalftimeReportData | null>(String(r.report_json), null);
      if (!report) return null;
      return {
        matchId: String(r.match_id),
        opponentName: String(r.opponent_name),
        competition: String(r.competition),
        matchDate: String(r.match_date),
        report,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export function saveRecommendationFeedback(
  matchId: string,
  choice: FeedbackChoice,
  notes: string
): RecommendationFeedbackRecord {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO recommendation_feedback (id, match_id, choice, notes, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(match_id) DO UPDATE SET choice = excluded.choice, notes = excluded.notes, created_at = excluded.created_at
  `).run(id, matchId, choice, notes.trim(), now);

  const row = db
    .prepare('SELECT * FROM recommendation_feedback WHERE match_id = ?')
    .get(matchId) as Record<string, unknown>;

  return {
    id: String(row.id),
    matchId: String(row.match_id),
    choice: String(row.choice) as FeedbackChoice,
    notes: String(row.notes),
    createdAt: String(row.created_at),
  };
}

export function listRecommendationFeedback(clubId?: string): RecommendationFeedbackRecord[] {
  const db = getDb();
  const query = clubId
    ? `
      SELECT rf.* FROM recommendation_feedback rf
      JOIN matches m ON m.id = rf.match_id
      WHERE m.club_id = ?
      ORDER BY rf.created_at DESC
    `
    : 'SELECT * FROM recommendation_feedback ORDER BY created_at DESC';
  const rows = (clubId ? db.prepare(query).all(clubId) : db.prepare(query).all()) as Array<
    Record<string, unknown>
  >;

  return rows.map((r) => ({
    id: String(r.id),
    matchId: String(r.match_id),
    choice: String(r.choice) as FeedbackChoice,
    notes: String(r.notes),
    createdAt: String(r.created_at),
  }));
}

export function listPostMatchReports(clubId?: string): PostMatchReportRecord[] {
  const db = getDb();
  const query = clubId
    ? `
      SELECT pmr.* FROM post_match_reports pmr
      JOIN matches m ON m.id = pmr.match_id
      WHERE m.club_id = ?
      ORDER BY pmr.created_at DESC
    `
    : 'SELECT * FROM post_match_reports ORDER BY created_at DESC';
  const rows = (clubId ? db.prepare(query).all(clubId) : db.prepare(query).all()) as Array<
    Record<string, unknown>
  >;

  return rows.map((r) => ({
    id: String(r.id),
    matchId: String(r.match_id),
    hasSecondHalfEvidence: Boolean(r.has_second_half_evidence),
    summary: String(r.summary),
    tacticalComparison: String(r.tactical_comparison),
    lessonsLearned: String(r.lessons_learned),
    createdAt: String(r.created_at),
  }));
}

export function listTacticalMemory(clubId: string): TacticalMemoryEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM tactical_memory WHERE club_id = ? ORDER BY evidence_count DESC, updated_at DESC'
    )
    .all(clubId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    clubId: String(r.club_id),
    matchId: r.match_id ? String(r.match_id) : null,
    opponentId: r.opponent_id ? String(r.opponent_id) : null,
    category: String(r.category) as TacticalMemoryEntry['category'],
    title: String(r.title),
    detail: String(r.detail),
    evidenceCount: Number(r.evidence_count),
    confidence: String(r.confidence) as ConfidenceLevel,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function createTacticalMemoryEntry(input: {
  clubId: string;
  matchId?: string | null;
  opponentId?: string | null;
  category: TacticalMemoryEntry['category'];
  title: string;
  detail: string;
  confidence: ConfidenceLevel;
}): TacticalMemoryEntry {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO tactical_memory (
      id, club_id, match_id, opponent_id, category, title, detail,
      evidence_count, confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id,
    input.clubId,
    input.matchId ?? null,
    input.opponentId ?? null,
    input.category,
    input.title.trim(),
    input.detail.trim(),
    input.confidence,
    now,
    now
  );

  return listTacticalMemory(input.clubId).find((m) => m.id === id)!;
}

export function deleteTacticalMemoryEntry(id: string): boolean {
  const db = getDb();
  return db.prepare('DELETE FROM tactical_memory WHERE id = ?').run(id).changes > 0;
}

export function listTacticalCatalog(): TacticalCatalogItem[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM tactical_catalog ORDER BY category ASC, is_default DESC, name ASC')
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    category: String(r.category) as TacticalCatalogItem['category'],
    name: String(r.name),
    description: String(r.description),
    metadataJson: r.metadata_json ? String(r.metadata_json) : null,
    isDefault: Boolean(r.is_default),
    createdAt: String(r.created_at),
  }));
}

export function createTacticalCatalogItem(input: {
  category: TacticalCatalogItem['category'];
  name: string;
  description: string;
}): TacticalCatalogItem {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tactical_catalog (id, category, name, description, metadata_json, is_default, created_at)
    VALUES (?, ?, ?, ?, NULL, 0, ?)
  `).run(id, input.category, input.name.trim(), input.description.trim(), now);

  return listTacticalCatalog().find((c) => c.id === id)!;
}

export function deleteTacticalCatalogItem(id: string): boolean {
  const db = getDb();
  return db.prepare('DELETE FROM tactical_catalog WHERE id = ?').run(id).changes > 0;
}

export function listApiUsageLogs(): ApiUsageLog[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM api_usage_logs ORDER BY created_at DESC LIMIT 100')
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    matchId: r.match_id ? String(r.match_id) : null,
    modelId: String(r.model_id),
    stage: String(r.stage),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    evidenceFramesCount: Number(r.evidence_frames_count),
    status: String(r.status) as 'success' | 'error',
    errorMessage: r.error_message ? String(r.error_message) : null,
    createdAt: String(r.created_at),
  }));
}

export function getDashboardSummary(): DashboardSummary {
  const clubs = listClubs();
  const activeClub = clubs.find((c) => c.profile.isActive) ?? clubs[0] ?? null;

  if (!activeClub) {
    return {
      activeClub: null,
      totalMatches: 0,
      analyzedMatches: 0,
      record: { wins: 0, draws: 0, losses: 0 },
      mostUsedFormation: null,
      upcomingFixtures: [],
      recentMatches: [],
      recurringWeaknesses: [],
      latestRecommendations: [],
      formationBreakdown: [],
    };
  }

  const db = getDb();
  const matches = listMatches(activeClub.id);
  let wins = 0;
  let draws = 0;
  let losses = 0;

  const formationMap = new Map<
    string,
    { formation: string; matches: number; wins: number; draws: number; losses: number }
  >();

  for (const m of matches) {
    const entry = formationMap.get(m.startingFormation) ?? {
      formation: m.startingFormation,
      matches: 0,
      wins: 0,
      draws: 0,
      losses: 0,
    };
    entry.matches += 1;

    if (m.finalScoreFor !== null && m.finalScoreAgainst !== null) {
      if (m.finalScoreFor > m.finalScoreAgainst) {
        wins += 1;
        entry.wins += 1;
      } else if (m.finalScoreFor === m.finalScoreAgainst) {
        draws += 1;
        entry.draws += 1;
      } else {
        losses += 1;
        entry.losses += 1;
      }
    }
    formationMap.set(m.startingFormation, entry);
  }

  const formationBreakdown = Array.from(formationMap.values()).sort(
    (a, b) => b.matches - a.matches
  );

  const mostUsedFormation = formationBreakdown[0]?.formation ?? null;
  const analyzedMatches = matches.filter((m) => m.hasHalftimeReport).length;
  const upcomingFixtures = matches.filter((m) => m.status === 'scheduled').slice(0, 5);
  const recentMatches = matches.filter((m) => m.status !== 'scheduled').slice(0, 6);

  const recurringWeaknesses = listTacticalMemory(activeClub.id)
    .filter((entry) => entry.category === 'recurring_weakness')
    .slice(0, 5);

  const recRows = db
    .prepare(`
      SELECT tr.* FROM tactical_recommendations tr
      JOIN matches m ON m.id = tr.match_id
      WHERE m.club_id = ?
      ORDER BY tr.created_at DESC
      LIMIT 5
    `)
    .all(activeClub.id) as Array<Record<string, unknown>>;

  const latestRecommendations: StructuredTacticalRecommendation[] = recRows.map((r) => ({
    id: String(r.id),
    matchId: String(r.match_id),
    halftimeReportId: String(r.halftime_report_id),
    currentTactic: String(r.current_tactic),
    recommendedChange: String(r.recommended_change),
    whyNecessary: String(r.why_necessary),
    expectedBenefit: String(r.expected_benefit),
    potentialRisk: String(r.potential_risk),
    whenToApply: String(r.when_to_apply),
    confidence: String(r.confidence) as ConfidenceLevel,
    priority: String(r.priority) as StructuredTacticalRecommendation['priority'],
    isUnverifiedGameOption: Boolean(r.is_unverified_option),
  }));

  return {
    activeClub,
    totalMatches: matches.length,
    analyzedMatches,
    record: { wins, draws, losses },
    mostUsedFormation,
    upcomingFixtures,
    recentMatches,
    recurringWeaknesses,
    latestRecommendations,
    formationBreakdown,
  };
}
