import crypto from 'node:crypto';
import type {
  ApiUsageLog,
  ApplicationSettings,
  ClubWithProfile,
  ConfidenceLevel,
  DashboardSummary,
  DefaultRosterImportResult,
  DefaultRosterPreview,
  FeedbackChoice,
  HalftimeReportData,
  MatchRecord,
  MatchSession,
  MatchSessionWithSegments,
  MatchStatus,
  MatchTacticalSnapshot,
  MatchTacticalSnapshotAssignment,
  MatchTacticalSnapshotBenchEntry,
  MatchVenue,
  Opponent,
  Player,
  PlayerAvailability,
  PlayerRoleAssignment,
  PostMatchReportRecord,
  RecommendationFeedbackRecord,
  RecordingAnalysisState,
  RecordingDiagnosticsRecord,
  RecordingIntegrityStatus,
  RecordingPipelineDiagnostics,
  RecordingSegment,
  SquadStatus,
  StructuredTacticalRecommendation,
  TacticalCatalogItem,
  TacticalConfiguration,
  TacticalMemoryEntry,
  TacticalPreset,
  TacticalPresetAssignment,
  TacticalPresetStatus,
} from '../../src/types/domain.ts';
import {
  deriveStableSlotId,
  normalizeFormationSlotPosition,
} from '../../src/utils/formationPositions.ts';
import {
  resolvePlayerDisplayName,
  resolvePlayerFullName,
} from '../../src/utils/playerDisplayName.ts';
import { validateLineupEligibility } from '../../src/utils/squadEligibility.ts';
import { DEFAULT_APP_SETTINGS, getDb } from '../db/database.ts';
import { getCatalogFormationByIdOrName, getCatalogPlayerById } from './catalogRepository.ts';
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
  rosterInitMode?: 'default_roster' | 'empty';
}): ClubWithProfile & { defaultRosterImport?: DefaultRosterImportResult | null } {
  const db = getDb();
  const clubId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const now = new Date().toISOString();

  const existingCount = (
    db.prepare('SELECT COUNT(*) as count FROM clubs').get() as { count: number }
  ).count;
  const shouldBeActive = input.setActive ?? existingCount === 0;

  let defaultRosterImport: DefaultRosterImportResult | null = null;

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

    if (input.rosterInitMode === 'default_roster' && input.catalogClubId) {
      defaultRosterImport = importDefaultClubRosterInTransaction(db, clubId, input.catalogClubId, now);
    }
  });

  tx();

  if (shouldBeActive) {
    updateSettings({ activeClubId: clubId });
  }

  const created = listClubs().find((c) => c.id === clubId)!;
  return {
    ...created,
    defaultRosterImport,
  };
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

function mapPlayerRow(r: Record<string, unknown>): Player {
  const fullName = resolvePlayerFullName({
    fullName: r.full_name ? String(r.full_name) : null,
    name: String(r.name),
  });
  const shortName = r.short_name ? String(r.short_name) : null;
  const displayNameOverride = r.display_name_override ? String(r.display_name_override) : null;
  const displayName = resolvePlayerDisplayName({
    displayNameOverride,
    displayName: r.display_name ? String(r.display_name) : null,
    shortName,
    fullName,
    name: String(r.name),
  });

  return {
    id: String(r.id),
    clubId: String(r.club_id),
    catalogPlayerId: r.catalog_player_id ? String(r.catalog_player_id) : null,
    name: String(r.name),
    displayName,
    displayNameOverride,
    shortName,
    fullName,
    position: String(r.position),
    secondaryPositions: safeJsonParse<string[]>(
      r.secondary_positions_json ? String(r.secondary_positions_json) : '[]',
      []
    ),
    squadNumber:
      r.squad_number === null || r.squad_number === undefined ? null : Number(r.squad_number),
    squadStatus: (r.squad_status ? String(r.squad_status) : 'active') as SquadStatus,
    availability: (r.availability ? String(r.availability) : 'available') as PlayerAvailability,
    seniorSelectionAuthorized: Boolean(r.senior_selection_authorized),
    injuryStatus: r.injury_status ? String(r.injury_status) : null,
    suspensionStatus: r.suspension_status ? String(r.suspension_status) : null,
    membershipStartDate: r.membership_start_date ? String(r.membership_start_date) : null,
    membershipEndDate: r.membership_end_date ? String(r.membership_end_date) : null,
    overallRating: r.overall_rating === null ? null : Number(r.overall_rating),
    potentialRating:
      r.potential_rating === null || r.potential_rating === undefined
        ? null
        : Number(r.potential_rating),
    age: r.age === null || r.age === undefined ? null : Number(r.age),
    preferredFoot: String(r.preferred_foot) as Player['preferredFoot'],
    playerRole: String(r.player_role),
    playerFocus: String(r.player_focus ?? ''),
    contractExpiry: r.contract_expiry ? String(r.contract_expiry) : null,
    marketValueEur:
      r.market_value_eur === null || r.market_value_eur === undefined
        ? null
        : Number(r.market_value_eur),
    wageEur: r.wage_eur === null || r.wage_eur === undefined ? null : Number(r.wage_eur),
    strengths: String(r.strengths),
    weaknesses: String(r.weaknesses),
    preferredInstructions: String(r.preferred_instructions),
    notes: String(r.notes ?? ''),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function listPlayers(clubId: string): Player[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM players WHERE club_id = ? ORDER BY overall_rating DESC NULLS LAST, display_name ASC, name ASC'
    )
    .all(clubId) as Array<Record<string, unknown>>;

  return rows.map(mapPlayerRow);
}

export function createPlayer(input: {
  clubId: string;
  catalogPlayerId?: string | null;
  name: string;
  displayNameOverride?: string | null;
  shortName?: string | null;
  fullName?: string | null;
  position: string;
  secondaryPositions?: string[];
  squadNumber?: number | null;
  squadStatus?: SquadStatus;
  availability?: PlayerAvailability;
  seniorSelectionAuthorized?: boolean;
  injuryStatus?: string | null;
  suspensionStatus?: string | null;
  membershipStartDate?: string | null;
  membershipEndDate?: string | null;
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
  notes?: string;
}): Player {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const cleanFullName = (input.fullName?.trim() || input.name.trim());
  const cleanShortName = input.shortName?.trim() || null;
  const cleanOverride = input.displayNameOverride?.trim() || null;
  const resolvedDisplayName = resolvePlayerDisplayName({
    displayNameOverride: cleanOverride,
    shortName: cleanShortName,
    fullName: cleanFullName,
    name: input.name.trim(),
  });

  db.prepare(`
    INSERT INTO players (
      id, club_id, catalog_player_id, name, display_name, display_name_override,
      short_name, full_name, position, secondary_positions_json, squad_number,
      squad_status, availability, senior_selection_authorized, injury_status, suspension_status,
      membership_start_date, membership_end_date, overall_rating, potential_rating, age,
      preferred_foot, player_role, player_focus, contract_expiry, market_value_eur, wage_eur,
      strengths, weaknesses, preferred_instructions, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.clubId,
    input.catalogPlayerId ?? null,
    cleanFullName,
    resolvedDisplayName,
    cleanOverride,
    cleanShortName,
    cleanFullName,
    input.position.trim().toUpperCase(),
    JSON.stringify(input.secondaryPositions ?? []),
    input.squadNumber ?? null,
    input.squadStatus ?? 'active',
    input.availability ?? 'available',
    input.seniorSelectionAuthorized ? 1 : 0,
    input.injuryStatus?.trim() || null,
    input.suspensionStatus?.trim() || null,
    input.membershipStartDate ?? now.slice(0, 10),
    input.membershipEndDate ?? null,
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
    (input.notes ?? '').trim(),
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
    displayNameOverride: string | null;
    squadNumber: number | null;
    squadStatus: SquadStatus;
    availability: PlayerAvailability;
    membershipStartDate: string | null;
    overallRating: number | null;
    potentialRating: number | null;
    age: number | null;
    playerRole: string;
    playerFocus: string;
    contractExpiry: string | null;
    strengths: string;
    weaknesses: string;
    preferredInstructions: string;
    notes: string;
  }> = {}
): Player | null {
  const master = getCatalogPlayerById(catalogPlayerId);
  if (!master) return null;

  return createPlayer({
    clubId,
    catalogPlayerId: master.id,
    name: master.fullName,
    fullName: master.fullName,
    shortName: master.shortName || null,
    displayNameOverride: overrides.displayNameOverride ?? master.displayNameOverride ?? null,
    position: overrides.position ?? master.primaryPosition,
    secondaryPositions: master.secondaryPositions,
    squadNumber: overrides.squadNumber ?? null,
    squadStatus: overrides.squadStatus ?? 'active',
    availability: overrides.availability ?? 'available',
    membershipStartDate: overrides.membershipStartDate ?? new Date().toISOString().slice(0, 10),
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
    notes: overrides.notes ?? '',
  });
}

export function previewDefaultClubRosterByCatalogClubId(
  catalogClubId: string,
  existingCareerClubId?: string
): DefaultRosterPreview {
  const db = getDb();
  const catalogClub = db
    .prepare('SELECT id, name FROM catalog_clubs WHERE id = ?')
    .get(catalogClubId) as { id: string; name: string } | undefined;

  if (!catalogClub) {
    return {
      status: 'unlinked_club',
      catalogClubId: null,
      catalogClubName: null,
      totalMatchedPlayers: 0,
      alreadyInSquadCount: 0,
      newToImportCount: 0,
      samplePlayers: [],
      message: 'Selected club is not linked to a verified FC26 master catalog club ID.',
    };
  }

  // Strictly match by stable foreign key catalog_players.club_id = catalog_clubs.id (never fuzzy name match)
  const matchedPlayers = db
    .prepare(
      `SELECT id, full_name, short_name, display_name_override, primary_position, overall_rating, age
       FROM catalog_players
       WHERE club_id = ?
       ORDER BY overall_rating DESC NULLS LAST, full_name ASC`
    )
    .all(catalogClub.id) as Array<{
    id: string;
    full_name: string;
    short_name: string;
    display_name_override: string | null;
    primary_position: string;
    overall_rating: number | null;
    age: number | null;
  }>;

  if (matchedPlayers.length === 0) {
    return {
      status: 'linked_no_players',
      catalogClubId: catalogClub.id,
      catalogClubName: catalogClub.name,
      totalMatchedPlayers: 0,
      alreadyInSquadCount: 0,
      newToImportCount: 0,
      samplePlayers: [],
      message: `Club "${catalogClub.name}" is linked in the FC26 catalog, but no imported catalog players are mapped to this club ID yet. Import a players dataset in FC26 Database Center or add players manually.`,
    };
  }

  let existingCatalogIds = new Set<string>();
  if (existingCareerClubId) {
    const existingRows = db
      .prepare(
        'SELECT catalog_player_id FROM players WHERE club_id = ? AND catalog_player_id IS NOT NULL'
      )
      .all(existingCareerClubId) as Array<{ catalog_player_id: string }>;
    existingCatalogIds = new Set(existingRows.map((r) => r.catalog_player_id));
  }

  const alreadyInSquadCount = matchedPlayers.filter((p) => existingCatalogIds.has(p.id)).length;
  const newToImportCount = matchedPlayers.length - alreadyInSquadCount;

  return {
    status: 'linked_with_players',
    catalogClubId: catalogClub.id,
    catalogClubName: catalogClub.name,
    totalMatchedPlayers: matchedPlayers.length,
    alreadyInSquadCount,
    newToImportCount,
    samplePlayers: matchedPlayers.slice(0, 12).map((p) => ({
      id: p.id,
      displayName: resolvePlayerDisplayName({
        displayNameOverride: p.display_name_override,
        shortName: p.short_name,
        fullName: p.full_name,
      }),
      fullName: p.full_name,
      primaryPosition: p.primary_position,
      overallRating: p.overall_rating,
      age: p.age,
    })),
    message:
      newToImportCount > 0
        ? `FC26 dataset snapshot: ${matchedPlayers.length} player(s) mapped to ${catalogClub.name} (${newToImportCount} missing to import, ${alreadyInSquadCount} already tracked in Career Mode — existing edits, transfers, and loaned-out/released statuses will be preserved).`
        : `All ${matchedPlayers.length} player(s) from the imported FC26 dataset snapshot for ${catalogClub.name} are already tracked in this Career Mode squad.`,
  };
}

export function previewDefaultClubRoster(clubId: string): DefaultRosterPreview {
  const db = getDb();
  const club = db
    .prepare('SELECT id, name, catalog_club_id FROM clubs WHERE id = ?')
    .get(clubId) as { id: string; name: string; catalog_club_id: string | null } | undefined;

  if (!club) {
    throw new Error(`Club "${clubId}" not found.`);
  }
  if (!club.catalog_club_id) {
    return {
      status: 'unlinked_club',
      catalogClubId: null,
      catalogClubName: null,
      totalMatchedPlayers: 0,
      alreadyInSquadCount: 0,
      newToImportCount: 0,
      samplePlayers: [],
      message: `Club "${club.name}" is a custom club not linked to an FC26 master catalog club ID. Link it in Career Mode Clubs or add players manually in Squad Management.`,
    };
  }

  return previewDefaultClubRosterByCatalogClubId(club.catalog_club_id, clubId);
}

function importDefaultClubRosterInTransaction(
  db: ReturnType<typeof getDb>,
  clubId: string,
  catalogClubId: string,
  now: string
): DefaultRosterImportResult {
  const catalogClub = db
    .prepare('SELECT id, name FROM catalog_clubs WHERE id = ?')
    .get(catalogClubId) as { id: string; name: string } | undefined;

  if (!catalogClub) {
    return {
      clubId,
      catalogClubId: null,
      matchedCount: 0,
      importedCount: 0,
      skippedDuplicatesCount: 0,
      status: 'unlinked_club',
      message: 'Club is not linked to a valid FC26 catalog club ID.',
    };
  }

  const catalogPlayers = db
    .prepare(
      `SELECT * FROM catalog_players
       WHERE club_id = ?
       ORDER BY overall_rating DESC NULLS LAST, full_name ASC`
    )
    .all(catalogClubId) as Array<Record<string, unknown>>;

  if (catalogPlayers.length === 0) {
    return {
      clubId,
      catalogClubId,
      matchedCount: 0,
      importedCount: 0,
      skippedDuplicatesCount: 0,
      status: 'linked_no_players',
      message: `No catalog players are linked to "${catalogClub.name}" in the current FC26 database.`,
    };
  }

  const existingCatalogIds = new Set(
    (
      db
        .prepare(
          'SELECT catalog_player_id FROM players WHERE club_id = ? AND catalog_player_id IS NOT NULL'
        )
        .all(clubId) as Array<{ catalog_player_id: string }>
    ).map((r) => r.catalog_player_id)
  );

  // Load secondary positions for matched players
  const posRows = db
    .prepare(
      `SELECT cpp.player_id, cpp.position_code
       FROM catalog_player_positions cpp
       JOIN catalog_players cp ON cp.id = cpp.player_id
       WHERE cp.club_id = ? AND cpp.is_primary = 0`
    )
    .all(catalogClubId) as Array<{ player_id: string; position_code: string }>;
  const secPosByPlayer = new Map<string, string[]>();
  for (const row of posRows) {
    const arr = secPosByPlayer.get(row.player_id) ?? [];
    arr.push(row.position_code);
    secPosByPlayer.set(row.player_id, arr);
  }

  const insertStmt = db.prepare(`
    INSERT INTO players (
      id, club_id, catalog_player_id, name, display_name, display_name_override,
      short_name, full_name, position, secondary_positions_json, squad_number,
      squad_status, availability, injury_status, suspension_status,
      membership_start_date, membership_end_date, overall_rating, potential_rating, age,
      preferred_foot, player_role, player_focus, contract_expiry, market_value_eur, wage_eur,
      strengths, weaknesses, preferred_instructions, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', 'available', NULL, NULL, ?, NULL, ?, ?, ?, ?, '', '', ?, ?, ?, '', '', '', '', ?, ?)
  `);

  const today = now.slice(0, 10);
  let importedCount = 0;
  let skippedDuplicatesCount = 0;

  for (const cp of catalogPlayers) {
    const cpId = String(cp.id);
    if (existingCatalogIds.has(cpId)) {
      skippedDuplicatesCount += 1;
      continue;
    }

    const fullName = String(cp.full_name);
    const shortName = cp.short_name ? String(cp.short_name) : null;
    const override = cp.display_name_override ? String(cp.display_name_override) : null;
    const displayName = resolvePlayerDisplayName({
      displayNameOverride: override,
      shortName,
      fullName,
    });
    const prefFoot =
      cp.preferred_foot === 'Left' || cp.preferred_foot === 'Both' ? String(cp.preferred_foot) : 'Right';

    insertStmt.run(
      crypto.randomUUID(),
      clubId,
      cpId,
      fullName,
      displayName,
      override,
      shortName,
      fullName,
      String(cp.primary_position),
      JSON.stringify(secPosByPlayer.get(cpId) ?? []),
      today,
      cp.overall_rating === null || cp.overall_rating === undefined ? null : Number(cp.overall_rating),
      cp.potential_rating === null || cp.potential_rating === undefined
        ? null
        : Number(cp.potential_rating),
      cp.age === null || cp.age === undefined ? null : Number(cp.age),
      prefFoot,
      cp.contract_expiry ? String(cp.contract_expiry) : null,
      cp.market_value_eur === null || cp.market_value_eur === undefined
        ? null
        : Number(cp.market_value_eur),
      cp.wage_eur === null || cp.wage_eur === undefined ? null : Number(cp.wage_eur),
      now,
      now
    );

    importedCount += 1;
  }

  return {
    clubId,
    catalogClubId,
    matchedCount: catalogPlayers.length,
    importedCount,
    skippedDuplicatesCount,
    status: 'linked_with_players',
    message:
      importedCount > 0
        ? `Imported ${importedCount} missing player(s) from the FC26 dataset snapshot for ${catalogClub.name} (${skippedDuplicatesCount} existing Career Mode player record(s), including any transferred/loaned/released players, preserved untouched).`
        : `No new players imported; all ${skippedDuplicatesCount} player(s) in the FC26 dataset snapshot for ${catalogClub.name} are already tracked in this Career Mode squad.`,
  };
}

export function importDefaultClubRoster(clubId: string): DefaultRosterImportResult {
  const db = getDb();
  const club = db
    .prepare('SELECT id, name, catalog_club_id FROM clubs WHERE id = ?')
    .get(clubId) as { id: string; name: string; catalog_club_id: string | null } | undefined;

  if (!club) {
    throw new Error(`Club "${clubId}" not found.`);
  }
  if (!club.catalog_club_id) {
    return {
      clubId,
      catalogClubId: null,
      matchedCount: 0,
      importedCount: 0,
      skippedDuplicatesCount: 0,
      status: 'unlinked_club',
      message: `Club "${club.name}" is not linked to an FC26 catalog club ID.`,
    };
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() =>
    importDefaultClubRosterInTransaction(db, clubId, club.catalog_club_id!, now)
  );
  return tx();
}

export function updatePlayer(
  playerId: string,
  input: Partial<{
    name: string;
    displayNameOverride: string | null;
    shortName: string | null;
    fullName: string | null;
    position: string;
    secondaryPositions: string[];
    squadNumber: number | null;
    squadStatus: SquadStatus;
    availability: PlayerAvailability;
    seniorSelectionAuthorized: boolean;
    injuryStatus: string | null;
    suspensionStatus: string | null;
    membershipStartDate: string | null;
    membershipEndDate: string | null;
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
    notes: string;
  }>
): Player | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const nextName = input.name?.trim() ?? String(row.name);
  const nextFullName =
    input.fullName !== undefined
      ? input.fullName?.trim() || nextName
      : String(row.full_name || nextName);
  const nextShortName =
    input.shortName !== undefined
      ? input.shortName?.trim() || null
      : row.short_name
        ? String(row.short_name)
        : null;
  const nextOverride =
    input.displayNameOverride !== undefined
      ? input.displayNameOverride?.trim() || null
      : row.display_name_override
        ? String(row.display_name_override)
        : null;
  const nextDisplayName = resolvePlayerDisplayName({
    displayNameOverride: nextOverride,
    shortName: nextShortName,
    fullName: nextFullName,
    name: nextName,
  });

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE players
    SET name = ?, display_name = ?, display_name_override = ?, short_name = ?, full_name = ?,
        position = ?, secondary_positions_json = ?, squad_number = ?, squad_status = ?,
        availability = ?, senior_selection_authorized = ?, injury_status = ?, suspension_status = ?,
        membership_start_date = ?, membership_end_date = ?,
        overall_rating = ?, potential_rating = ?, age = ?,
        preferred_foot = ?, player_role = ?, player_focus = ?, contract_expiry = ?,
        market_value_eur = ?, wage_eur = ?, strengths = ?, weaknesses = ?,
        preferred_instructions = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    nextName,
    nextDisplayName,
    nextOverride,
    nextShortName,
    nextFullName,
    input.position?.trim().toUpperCase() ?? String(row.position),
    input.secondaryPositions !== undefined
      ? JSON.stringify(input.secondaryPositions)
      : String(row.secondary_positions_json ?? '[]'),
    input.squadNumber !== undefined
      ? input.squadNumber
      : row.squad_number === null || row.squad_number === undefined
        ? null
        : Number(row.squad_number),
    input.squadStatus ?? String(row.squad_status ?? 'active'),
    input.availability ?? String(row.availability ?? 'available'),
    input.seniorSelectionAuthorized !== undefined
      ? input.seniorSelectionAuthorized
        ? 1
        : 0
      : Number(row.senior_selection_authorized ?? 0),
    input.injuryStatus !== undefined
      ? input.injuryStatus?.trim() || null
      : row.injury_status
        ? String(row.injury_status)
        : null,
    input.suspensionStatus !== undefined
      ? input.suspensionStatus?.trim() || null
      : row.suspension_status
        ? String(row.suspension_status)
        : null,
    input.membershipStartDate !== undefined
      ? input.membershipStartDate
      : row.membership_start_date
        ? String(row.membership_start_date)
        : null,
    input.membershipEndDate !== undefined
      ? input.membershipEndDate
      : row.membership_end_date
        ? String(row.membership_end_date)
        : null,
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
    input.notes !== undefined ? input.notes.trim() : String(row.notes ?? ''),
    now,
    playerId
  );

  return listPlayers(String(row.club_id)).find((p) => p.id === playerId) ?? null;
}

export function deletePlayer(playerId: string): boolean {
  const db = getDb();
  return db.prepare('DELETE FROM players WHERE id = ?').run(playerId).changes > 0;
}

// ============================================================
// Phase 2.1 — Club Tactical Presets
// ============================================================

function mapTacticalPreset(
  presetRow: Record<string, unknown>,
  assignmentRows: Array<Record<string, unknown>>
): TacticalPreset {
  return {
    id: String(presetRow.id),
    clubId: String(presetRow.club_id),
    name: String(presetRow.name),
    formationId: presetRow.formation_id ? String(presetRow.formation_id) : null,
    formationName: String(presetRow.formation_name),
    buildUpStyle: String(presetRow.build_up_style),
    defensiveApproach: String(presetRow.defensive_approach),
    defensiveLineHeight: Number(presetRow.defensive_line_height),
    isDefault: Boolean(presetRow.is_default),
    presetStatus: (presetRow.preset_status === 'draft' ? 'draft' : 'match_ready') as TacticalPresetStatus,
    benchPlayerIds: safeJsonParse<string[]>(String(presetRow.bench_json ?? '[]'), []),
    notes: String(presetRow.notes ?? ''),
    assignments: assignmentRows.map((a) => {
      const rawPos = String(a.position_code);
      const norm = normalizeFormationSlotPosition(rawPos, a.slot_id ? String(a.slot_id) : null, Number(a.slot_order));
      const canonical = norm.ok ? norm.canonicalPosition : rawPos.trim().toUpperCase();
      return {
        id: String(a.id),
        slotOrder: Number(a.slot_order),
        slotId: a.slot_id ? String(a.slot_id) : norm.ok ? norm.slotId : canonical,
        positionCode: canonical,
        playerId: a.player_id ? String(a.player_id) : null,
        playerDisplayName: a.player_display_name
          ? String(a.player_display_name)
          : a.player_name
            ? String(a.player_name)
            : null,
        role: String(a.role ?? ''),
        focus: String(a.focus ?? ''),
      };
    }),
    createdAt: String(presetRow.created_at),
    updatedAt: String(presetRow.updated_at),
  };
}

interface NormalizedValidatedAssignment {
  slotOrder: number;
  slotId: string;
  positionCode: string;
  playerId: string | null;
  role: string;
  focus: string;
}

function validateTacticalAssignments(
  clubId: string,
  assignments: Array<{
    slotOrder: number;
    slotId?: string | null;
    positionCode: string;
    playerId: string | null;
    role: string;
    focus: string;
  }>,
  db: ReturnType<typeof getDb>,
  options: {
    benchPlayerIds?: string[];
    mode?: 'preset_match_ready' | 'preset_draft' | 'match_confirmation';
    confirmedDoubtfulPlayerIds?: string[];
    existingPreservedPlayerIds?: Set<string>;
  } = {}
): NormalizedValidatedAssignment[] {
  const mode = options.mode ?? 'preset_match_ready';
  const benchPlayerIds = options.benchPlayerIds ?? [];
  const clubPlayers = listPlayers(clubId);

  // 1. Normalize and validate every formation slot position + FC 26 Role/Focus compatibility
  const normalizedAssignments: NormalizedValidatedAssignment[] = [];
  for (const a of assignments) {
    const posCheck = normalizeFormationSlotPosition(a.positionCode, a.slotId, a.slotOrder);
    if (!posCheck.ok) {
      throw new Error(
        `Slot #${a.slotOrder + 1} (${a.positionCode}): ${posCheck.error}`
      );
    }

    const canonicalPos = posCheck.canonicalPosition;
    const slotId =
      a.slotId?.trim() ||
      posCheck.slotId ||
      deriveStableSlotId({
        positionCode: canonicalPos,
        positionLabel: a.positionCode,
        slotOrder: a.slotOrder,
      });

    if (a.role.trim() || a.focus.trim()) {
      const check = validatePlayerRoleFocus(canonicalPos, a.role, a.focus, db);
      if (!check.valid) {
        throw new Error(`Slot #${a.slotOrder + 1} (${canonicalPos}): ${check.reason}`);
      }
    }

    normalizedAssignments.push({
      slotOrder: a.slotOrder,
      slotId,
      positionCode: canonicalPos,
      playerId: a.playerId ?? null,
      role: a.role.trim(),
      focus: a.focus.trim(),
    });
  }

  // 2. Enforce centralized Squad Membership & Availability Eligibility (Starting XI + Bench)
  const report = validateLineupEligibility({
    clubPlayers,
    assignments: normalizedAssignments.map((a) => ({
      slotOrder: a.slotOrder,
      slotId: a.slotId,
      positionCode: a.positionCode,
      playerId: a.playerId,
    })),
    benchPlayerIds,
    confirmedDoubtfulPlayerIds: options.confirmedDoubtfulPlayerIds ?? [],
  });

  for (const issue of report.issues) {
    // Membership ownership and duplicates are NEVER allowed, even in draft mode
    if (issue.code === 'foreign_or_missing_player' || issue.code === 'duplicate_assignment') {
      throw new Error(issue.reason);
    }

    // In preset_draft mode, allow preserving pre-existing invalid player references while the user inspects/replaces them
    if (
      mode === 'preset_draft' &&
      options.existingPreservedPlayerIds &&
      options.existingPreservedPlayerIds.has(issue.playerId)
    ) {
      continue;
    }

    throw new Error(issue.reason);
  }

  // Doubtful players require explicit confirmation for Match-Ready presets and Match Confirmation
  if (mode !== 'preset_draft' && report.doubtfulUnconfirmed.length > 0) {
    throw new Error(report.doubtfulUnconfirmed[0].reason);
  }

  return normalizedAssignments;
}

export function listTacticalPresets(clubId: string): TacticalPreset[] {
  const db = getDb();
  const presets = db
    .prepare(
      'SELECT * FROM tactical_presets WHERE club_id = ? ORDER BY is_default DESC, updated_at DESC, name ASC'
    )
    .all(clubId) as Array<Record<string, unknown>>;

  if (presets.length === 0) return [];

  const presetIds = presets.map((p) => String(p.id));
  const placeholders = presetIds.map(() => '?').join(', ');
  const assignmentRows = db
    .prepare(
      `SELECT tpa.*, p.display_name as player_display_name, p.name as player_name
       FROM tactical_preset_assignments tpa
       LEFT JOIN players p ON p.id = tpa.player_id
       WHERE tpa.preset_id IN (${placeholders})
       ORDER BY tpa.slot_order ASC`
    )
    .all(...presetIds) as Array<Record<string, unknown>>;

  const byPreset = new Map<string, Array<Record<string, unknown>>>();
  for (const row of assignmentRows) {
    const pid = String(row.preset_id);
    const list = byPreset.get(pid) ?? [];
    list.push(row);
    byPreset.set(pid, list);
  }

  return presets.map((p) => mapTacticalPreset(p, byPreset.get(String(p.id)) ?? []));
}

export function getTacticalPresetById(presetId: string): TacticalPreset | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tactical_presets WHERE id = ?').get(presetId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const assignments = db
    .prepare(
      `SELECT tpa.*, p.display_name as player_display_name, p.name as player_name
       FROM tactical_preset_assignments tpa
       LEFT JOIN players p ON p.id = tpa.player_id
       WHERE tpa.preset_id = ?
       ORDER BY tpa.slot_order ASC`
    )
    .all(presetId) as Array<Record<string, unknown>>;

  return mapTacticalPreset(row, assignments);
}

export function createTacticalPreset(
  clubId: string,
  input: {
    name: string;
    formationId?: string | null;
    formationName: string;
    buildUpStyle: string;
    defensiveApproach: string;
    defensiveLineHeight: number;
    isDefault?: boolean;
    presetStatus?: TacticalPresetStatus;
    benchPlayerIds?: string[];
    confirmedDoubtfulPlayerIds?: string[];
    notes?: string;
    assignments: TacticalPresetAssignment[];
  },
  internalOptions?: { existingPreservedPlayerIds?: Set<string> }
): TacticalPreset {
  const db = getDb();
  const presetId = crypto.randomUUID();
  const now = new Date().toISOString();
  const presetStatus: TacticalPresetStatus = input.presetStatus === 'draft' ? 'draft' : 'match_ready';

  const normalizedAssignments = validateTacticalAssignments(clubId, input.assignments, db, {
    benchPlayerIds: input.benchPlayerIds ?? [],
    mode: presetStatus === 'draft' ? 'preset_draft' : 'preset_match_ready',
    confirmedDoubtfulPlayerIds: input.confirmedDoubtfulPlayerIds ?? [],
    existingPreservedPlayerIds: internalOptions?.existingPreservedPlayerIds,
  });

  const resolvedFormation =
    input.formationId
      ? getCatalogFormationByIdOrName(input.formationId, db)
      : getCatalogFormationByIdOrName(input.formationName, db);

  const existingCount = (
    db.prepare('SELECT COUNT(*) as c FROM tactical_presets WHERE club_id = ?').get(clubId) as {
      c: number;
    }
  ).c;
  const shouldBeDefault = input.isDefault ?? existingCount === 0;

  const tx = db.transaction(() => {
    if (shouldBeDefault) {
      db.prepare('UPDATE tactical_presets SET is_default = 0 WHERE club_id = ?').run(clubId);
    }

    db.prepare(`
      INSERT INTO tactical_presets (
        id, club_id, name, formation_id, formation_name, build_up_style,
        defensive_approach, defensive_line_height, is_default, preset_status, bench_json,
        notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      presetId,
      clubId,
      input.name.trim(),
      resolvedFormation?.id ?? null,
      input.formationName.trim(),
      input.buildUpStyle.trim(),
      input.defensiveApproach.trim(),
      Math.max(1, Math.min(100, Math.round(input.defensiveLineHeight))),
      shouldBeDefault ? 1 : 0,
      presetStatus,
      JSON.stringify(input.benchPlayerIds ?? []),
      (input.notes ?? '').trim(),
      now,
      now
    );

    const insertSlot = db.prepare(`
      INSERT INTO tactical_preset_assignments (
        id, preset_id, slot_order, slot_id, position_code, player_id, role, focus
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of normalizedAssignments) {
      insertSlot.run(
        crypto.randomUUID(),
        presetId,
        a.slotOrder,
        a.slotId,
        a.positionCode,
        a.playerId,
        a.role,
        a.focus
      );
    }
  });

  tx();
  return getTacticalPresetById(presetId)!;
}

export function updateTacticalPreset(
  presetId: string,
  input: Partial<{
    name: string;
    formationId: string | null;
    formationName: string;
    buildUpStyle: string;
    defensiveApproach: string;
    defensiveLineHeight: number;
    isDefault: boolean;
    presetStatus: TacticalPresetStatus;
    benchPlayerIds: string[];
    confirmedDoubtfulPlayerIds: string[];
    notes: string;
    assignments: TacticalPresetAssignment[];
  }>
): TacticalPreset | null {
  const db = getDb();
  const existing = getTacticalPresetById(presetId);
  if (!existing) return null;

  const nextAssignments = input.assignments ?? existing.assignments;
  const nextBenchIds = input.benchPlayerIds ?? existing.benchPlayerIds;
  const nextPresetStatus: TacticalPresetStatus =
    input.presetStatus ?? existing.presetStatus ?? 'match_ready';

  const existingPreservedPlayerIds = new Set<string>([
    ...existing.assignments.map((a) => a.playerId).filter((id): id is string => Boolean(id)),
    ...existing.benchPlayerIds,
  ]);

  // If only flipping isDefault on an existing preset without changing lineup, allow keeping existing references
  const isMetadataOnlyToggle =
    input.assignments === undefined &&
    input.benchPlayerIds === undefined &&
    input.presetStatus === undefined;

  const normalizedAssignments = validateTacticalAssignments(existing.clubId, nextAssignments, db, {
    benchPlayerIds: nextBenchIds,
    mode:
      isMetadataOnlyToggle || nextPresetStatus === 'draft'
        ? 'preset_draft'
        : 'preset_match_ready',
    confirmedDoubtfulPlayerIds: input.confirmedDoubtfulPlayerIds ?? [],
    existingPreservedPlayerIds,
  });

  const nextFormationName = input.formationName?.trim() ?? existing.formationName;
  const resolvedFormation =
    input.formationId !== undefined
      ? input.formationId
        ? getCatalogFormationByIdOrName(input.formationId, db)
        : null
      : getCatalogFormationByIdOrName(nextFormationName, db);

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    if (input.isDefault === true) {
      db.prepare('UPDATE tactical_presets SET is_default = 0 WHERE club_id = ?').run(
        existing.clubId
      );
    }

    db.prepare(`
      UPDATE tactical_presets
      SET name = ?, formation_id = ?, formation_name = ?, build_up_style = ?,
          defensive_approach = ?, defensive_line_height = ?, is_default = ?, preset_status = ?,
          bench_json = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name?.trim() ?? existing.name,
      resolvedFormation?.id ?? existing.formationId,
      nextFormationName,
      input.buildUpStyle?.trim() ?? existing.buildUpStyle,
      input.defensiveApproach?.trim() ?? existing.defensiveApproach,
      input.defensiveLineHeight !== undefined
        ? Math.max(1, Math.min(100, Math.round(input.defensiveLineHeight)))
        : existing.defensiveLineHeight,
      input.isDefault !== undefined ? (input.isDefault ? 1 : 0) : existing.isDefault ? 1 : 0,
      nextPresetStatus,
      JSON.stringify(nextBenchIds),
      input.notes !== undefined ? input.notes.trim() : existing.notes,
      now,
      presetId
    );

    if (input.assignments) {
      db.prepare('DELETE FROM tactical_preset_assignments WHERE preset_id = ?').run(presetId);
      const insertSlot = db.prepare(`
        INSERT INTO tactical_preset_assignments (
          id, preset_id, slot_order, slot_id, position_code, player_id, role, focus
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of normalizedAssignments) {
        insertSlot.run(
          crypto.randomUUID(),
          presetId,
          a.slotOrder,
          a.slotId,
          a.positionCode,
          a.playerId,
          a.role,
          a.focus
        );
      }
    }
  });

  tx();
  return getTacticalPresetById(presetId);
}

export function duplicateTacticalPreset(presetId: string, newName?: string): TacticalPreset | null {
  const existing = getTacticalPresetById(presetId);
  if (!existing) return null;

  const clubPlayers = listPlayers(existing.clubId);
  const eligibilityReport = validateLineupEligibility({
    clubPlayers,
    assignments: existing.assignments.map((a) => ({
      slotOrder: a.slotOrder,
      slotId: a.slotId,
      positionCode: a.positionCode,
      playerId: a.playerId,
    })),
    benchPlayerIds: existing.benchPlayerIds,
  });

  const existingPreservedPlayerIds = new Set<string>([
    ...existing.assignments.map((a) => a.playerId).filter((id): id is string => Boolean(id)),
    ...existing.benchPlayerIds,
  ]);

  const targetStatus: TacticalPresetStatus = eligibilityReport.validForMatchReady
    ? (existing.presetStatus ?? 'match_ready')
    : 'draft';

  return createTacticalPreset(
    existing.clubId,
    {
      name: newName?.trim() || `${existing.name} (Copy)`,
      formationId: existing.formationId,
      formationName: existing.formationName,
      buildUpStyle: existing.buildUpStyle,
      defensiveApproach: existing.defensiveApproach,
      defensiveLineHeight: existing.defensiveLineHeight,
      isDefault: false,
      presetStatus: targetStatus,
      benchPlayerIds: existing.benchPlayerIds,
      notes: existing.notes,
      assignments: existing.assignments,
    },
    { existingPreservedPlayerIds }
  );
}

export function setDefaultTacticalPreset(presetId: string): TacticalPreset | null {
  return updateTacticalPreset(presetId, { isDefault: true });
}

export function deleteTacticalPreset(presetId: string): boolean {
  const db = getDb();
  const existing = db
    .prepare('SELECT id, club_id, is_default FROM tactical_presets WHERE id = ?')
    .get(presetId) as { id: string; club_id: string; is_default: number } | undefined;
  if (!existing) return false;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM tactical_presets WHERE id = ?').run(presetId);
    if (existing.is_default === 1) {
      const next = db
        .prepare(
          'SELECT id FROM tactical_presets WHERE club_id = ? ORDER BY updated_at DESC LIMIT 1'
        )
        .get(existing.club_id) as { id: string } | undefined;
      if (next) {
        db.prepare('UPDATE tactical_presets SET is_default = 1 WHERE id = ?').run(next.id);
      }
    }
  });
  tx();
  return true;
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

function mapMatchTacticalSnapshotRow(r: Record<string, unknown>): MatchTacticalSnapshot {
  return {
    id: String(r.id),
    matchId: String(r.match_id),
    sourcePresetId: r.source_preset_id ? String(r.source_preset_id) : null,
    sourcePresetName: r.source_preset_name ? String(r.source_preset_name) : null,
    snapshotType: String(r.snapshot_type) as MatchTacticalSnapshot['snapshotType'],
    isLocked: Boolean(r.is_locked),
    formationId: r.formation_id ? String(r.formation_id) : null,
    formationName: String(r.formation_name),
    buildUpStyle: String(r.build_up_style),
    defensiveApproach: String(r.defensive_approach),
    defensiveLineHeight: Number(r.defensive_line_height),
    assignments: safeJsonParse<MatchTacticalSnapshotAssignment[]>(
      String(r.assignments_json ?? '[]'),
      []
    ),
    benchPlayers: safeJsonParse<MatchTacticalSnapshotBenchEntry[]>(
      String(r.bench_json ?? '[]'),
      []
    ),
    notes: String(r.notes ?? ''),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function buildFrozenSnapshotPayloads(
  clubId: string,
  playerAssignments: PlayerRoleAssignment[],
  benchIds: string[],
  db: ReturnType<typeof getDb>
): {
  assignments: MatchTacticalSnapshotAssignment[];
  benchPlayers: MatchTacticalSnapshotBenchEntry[];
} {
  const clubPlayers = listPlayers(clubId);
  const byId = new Map<string, Player>(clubPlayers.map((p) => [p.id, p]));

  const assignments: MatchTacticalSnapshotAssignment[] = playerAssignments.map((a) => {
    const p = a.playerId ? byId.get(a.playerId) : undefined;
    const norm = normalizeFormationSlotPosition(a.positionCode, a.slotId, a.slotIndex);
    const canonicalPos = norm.ok ? norm.canonicalPosition : a.positionCode.trim().toUpperCase();
    return {
      slotOrder: a.slotIndex,
      slotId: a.slotId?.trim() || (norm.ok ? norm.slotId : canonicalPos),
      positionCode: canonicalPos,
      playerId: a.playerId,
      playerDisplayName: p ? p.displayName : a.playerName,
      playerFullName: p ? p.fullName : a.playerName,
      role: a.role.trim(),
      focus: a.focus.trim(),
      squadStatusAtSnapshot: p?.squadStatus ?? null,
      availabilityAtSnapshot: p?.availability ?? null,
    };
  });

  const benchPlayers: MatchTacticalSnapshotBenchEntry[] = benchIds
    .map((pid) => byId.get(pid))
    .filter((p): p is Player => Boolean(p))
    .map((p) => ({
      playerId: p.id,
      displayName: p.displayName,
      fullName: p.fullName,
      position: p.position,
      overallRating: p.overallRating,
    }));

  return { assignments, benchPlayers };
}

export function listMatchTacticalSnapshots(matchId: string): MatchTacticalSnapshot[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM match_tactical_snapshots
       WHERE match_id = ?
       ORDER BY CASE snapshot_type WHEN 'pre_match' THEN 0 ELSE 1 END, created_at ASC`
    )
    .all(matchId) as Array<Record<string, unknown>>;
  return rows.map(mapMatchTacticalSnapshotRow);
}

export function getPreMatchTacticalSnapshot(matchId: string): MatchTacticalSnapshot | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM match_tactical_snapshots
       WHERE match_id = ? AND snapshot_type = 'pre_match'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(matchId) as Record<string, unknown> | undefined;
  return row ? mapMatchTacticalSnapshotRow(row) : null;
}

export function updatePreMatchTacticalSnapshot(
  matchId: string,
  input: {
    sourcePresetId?: string | null;
    formationId?: string | null;
    formationName: string;
    buildUpStyle: string;
    defensiveApproach: string;
    defensiveLineHeight: number;
    playerAssignments: PlayerRoleAssignment[];
    benchIds?: string[];
    confirmedDoubtfulPlayerIds?: string[];
    notes?: string;
  }
): MatchTacticalSnapshot {
  const db = getDb();
  const matchRow = db
    .prepare('SELECT id, club_id, status FROM matches WHERE id = ?')
    .get(matchId) as { id: string; club_id: string; status: MatchStatus } | undefined;
  if (!matchRow) {
    throw new Error(`Match "${matchId}" not found.`);
  }

  const existing = getPreMatchTacticalSnapshot(matchId);
  if (existing?.isLocked || matchRow.status !== 'scheduled') {
    throw new Error(
      'Pre-match tactical snapshot is locked because recording has already started. Save an in-match tactical adjustment instead.'
    );
  }

  validateTacticalAssignments(
    matchRow.club_id,
    input.playerAssignments.map((a) => ({
      slotOrder: a.slotIndex,
      slotId: a.slotId,
      positionCode: a.positionCode,
      playerId: a.playerId,
      role: a.role,
      focus: a.focus,
    })),
    db,
    {
      benchPlayerIds: input.benchIds ?? [],
      mode: 'match_confirmation',
      confirmedDoubtfulPlayerIds: input.confirmedDoubtfulPlayerIds ?? [],
    }
  );

  const now = new Date().toISOString();
  const sourcePreset = input.sourcePresetId ? getTacticalPresetById(input.sourcePresetId) : null;
  const resolvedFormation = input.formationId
    ? getCatalogFormationByIdOrName(input.formationId, db)
    : getCatalogFormationByIdOrName(input.formationName, db);
  const frozen = buildFrozenSnapshotPayloads(
    matchRow.club_id,
    input.playerAssignments,
    input.benchIds ?? [],
    db
  );

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(`
        UPDATE match_tactical_snapshots
        SET source_preset_id = ?, source_preset_name = ?, formation_id = ?, formation_name = ?,
            build_up_style = ?, defensive_approach = ?, defensive_line_height = ?,
            assignments_json = ?, bench_json = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `).run(
        sourcePreset?.id ?? null,
        sourcePreset?.name ?? null,
        resolvedFormation?.id ?? null,
        input.formationName.trim(),
        input.buildUpStyle.trim(),
        input.defensiveApproach.trim(),
        Math.max(1, Math.min(100, Math.round(input.defensiveLineHeight))),
        JSON.stringify(frozen.assignments),
        JSON.stringify(frozen.benchPlayers),
        (input.notes ?? existing.notes).trim(),
        now,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO match_tactical_snapshots (
          id, match_id, source_preset_id, source_preset_name, snapshot_type, is_locked,
          formation_id, formation_name, build_up_style, defensive_approach, defensive_line_height,
          assignments_json, bench_json, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pre_match', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        matchId,
        sourcePreset?.id ?? null,
        sourcePreset?.name ?? null,
        resolvedFormation?.id ?? null,
        input.formationName.trim(),
        input.buildUpStyle.trim(),
        input.defensiveApproach.trim(),
        Math.max(1, Math.min(100, Math.round(input.defensiveLineHeight))),
        JSON.stringify(frozen.assignments),
        JSON.stringify(frozen.benchPlayers),
        (input.notes ?? '').trim(),
        now,
        now
      );
    }

    const startingXiIds = frozen.assignments
      .map((a) => a.playerId)
      .filter((id): id is string => Boolean(id));
    db.prepare(
      'UPDATE matches SET starting_formation = ?, starting_xi_json = ?, bench_json = ?, updated_at = ? WHERE id = ?'
    ).run(
      input.formationName.trim(),
      JSON.stringify(startingXiIds),
      JSON.stringify(input.benchIds ?? []),
      now,
      matchId
    );
  });

  tx();
  return getPreMatchTacticalSnapshot(matchId)!;
}

export function createInMatchTacticalAdjustment(
  matchId: string,
  input: {
    formationId?: string | null;
    formationName: string;
    buildUpStyle: string;
    defensiveApproach: string;
    defensiveLineHeight: number;
    playerAssignments: PlayerRoleAssignment[];
    benchIds?: string[];
    confirmedDoubtfulPlayerIds?: string[];
    notes?: string;
  }
): MatchTacticalSnapshot {
  const db = getDb();
  const matchRow = db.prepare('SELECT id, club_id FROM matches WHERE id = ?').get(matchId) as
    | { id: string; club_id: string }
    | undefined;
  if (!matchRow) {
    throw new Error(`Match "${matchId}" not found.`);
  }

  validateTacticalAssignments(
    matchRow.club_id,
    input.playerAssignments.map((a) => ({
      slotOrder: a.slotIndex,
      slotId: a.slotId,
      positionCode: a.positionCode,
      playerId: a.playerId,
      role: a.role,
      focus: a.focus,
    })),
    db,
    {
      benchPlayerIds: input.benchIds ?? [],
      mode: 'match_confirmation',
      confirmedDoubtfulPlayerIds: input.confirmedDoubtfulPlayerIds ?? [],
    }
  );

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const resolvedFormation = input.formationId
    ? getCatalogFormationByIdOrName(input.formationId, db)
    : getCatalogFormationByIdOrName(input.formationName, db);
  const frozen = buildFrozenSnapshotPayloads(
    matchRow.club_id,
    input.playerAssignments,
    input.benchIds ?? [],
    db
  );

  db.prepare(`
    INSERT INTO match_tactical_snapshots (
      id, match_id, source_preset_id, source_preset_name, snapshot_type, is_locked,
      formation_id, formation_name, build_up_style, defensive_approach, defensive_line_height,
      assignments_json, bench_json, notes, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, 'in_match_adjustment', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    matchId,
    resolvedFormation?.id ?? null,
    input.formationName.trim(),
    input.buildUpStyle.trim(),
    input.defensiveApproach.trim(),
    Math.max(1, Math.min(100, Math.round(input.defensiveLineHeight))),
    JSON.stringify(frozen.assignments),
    JSON.stringify(frozen.benchPlayers),
    (input.notes ?? '').trim(),
    now,
    now
  );

  const row = db
    .prepare('SELECT * FROM match_tactical_snapshots WHERE id = ?')
    .get(id) as Record<string, unknown>;
  return mapMatchTacticalSnapshotRow(row);
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

  const snapshotRow = db
    .prepare(
      `SELECT * FROM match_tactical_snapshots
       WHERE match_id = ? AND snapshot_type = 'pre_match'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(matchId) as Record<string, unknown> | undefined;
  const tacticalSnapshot = snapshotRow ? mapMatchTacticalSnapshotRow(snapshotRow) : null;

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
    tacticalSnapshot,
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
  sourcePresetId?: string | null;
  startingFormation: string;
  startingXiIds: string[];
  benchIds: string[];
  confirmedDoubtfulPlayerIds?: string[];
  objective: string;
  preMatchNotes: string;
  tacticalSetup: {
    formationId?: string | null;
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
  const snapshotId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Enforce canonical FC26 positions, Role-Focus compatibility, duplicate prevention, AND squad eligibility
  validateTacticalAssignments(
    input.clubId,
    input.tacticalSetup.playerAssignments.map((a) => ({
      slotOrder: a.slotIndex,
      slotId: a.slotId,
      positionCode: a.positionCode,
      playerId: a.playerId,
      role: a.role,
      focus: a.focus,
    })),
    db,
    {
      benchPlayerIds: input.benchIds,
      mode: 'match_confirmation',
      confirmedDoubtfulPlayerIds: input.confirmedDoubtfulPlayerIds ?? [],
    }
  );

  const sourcePreset = input.sourcePresetId ? getTacticalPresetById(input.sourcePresetId) : null;
  const resolvedFormation = input.tacticalSetup.formationId
    ? getCatalogFormationByIdOrName(input.tacticalSetup.formationId, db)
    : getCatalogFormationByIdOrName(input.startingFormation, db);
  const frozenSnapshot = buildFrozenSnapshotPayloads(
    input.clubId,
    input.tacticalSetup.playerAssignments,
    input.benchIds,
    db
  );

  // Sync standardized display names & canonical position codes into tactical_configurations as well
  const standardizedAssignments: PlayerRoleAssignment[] = frozenSnapshot.assignments.map((a) => ({
    slotIndex: a.slotOrder,
    slotId: a.slotId,
    positionCode: a.positionCode,
    playerId: a.playerId,
    playerName: a.playerDisplayName,
    role: a.role,
    focus: a.focus,
  }));

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
      sourcePreset ? `Preset: ${sourcePreset.name}` : 'Pre-Match Setup',
      input.startingFormation,
      input.tacticalSetup.buildUpStyle,
      input.tacticalSetup.defensiveApproach,
      input.tacticalSetup.defensiveLineHeight,
      JSON.stringify(standardizedAssignments),
      JSON.stringify(input.tacticalSetup.customParameters ?? {}),
      now
    );

    db.prepare(`
      INSERT INTO match_tactical_snapshots (
        id, match_id, source_preset_id, source_preset_name, snapshot_type, is_locked,
        formation_id, formation_name, build_up_style, defensive_approach, defensive_line_height,
        assignments_json, bench_json, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pre_match', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      matchId,
      sourcePreset?.id ?? null,
      sourcePreset?.name ?? null,
      resolvedFormation?.id ?? null,
      input.startingFormation,
      input.tacticalSetup.buildUpStyle,
      input.tacticalSetup.defensiveApproach,
      input.tacticalSetup.defensiveLineHeight,
      JSON.stringify(frozenSnapshot.assignments),
      JSON.stringify(frozenSnapshot.benchPlayers),
      input.preMatchNotes.trim(),
      now,
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

// ============================================================
// Phase 2 — Native Gameplay Recording Sessions & Segments
// ============================================================

function mapRecordingSegmentRow(r: Record<string, unknown>): RecordingSegment {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    matchId: String(r.match_id),
    segmentIndex: Number(r.segment_index),
    filePath: String(r.file_path),
    durationSeconds: Number(r.duration_seconds ?? 0),
    sizeBytes: Number(r.size_bytes ?? 0),
    checksum: r.checksum ? String(r.checksum) : null,
    status: String(r.status) as RecordingSegment['status'],
    resolution: r.resolution ? String(r.resolution) : null,
    fps: r.fps === null || r.fps === undefined ? null : Number(r.fps),
    codec: r.codec ? String(r.codec) : null,
    hasAudio: Boolean(r.has_audio),
    integrityStatus: (r.integrity_status
      ? String(r.integrity_status)
      : 'pending') as RecordingIntegrityStatus,
    startedAt: r.started_at ? String(r.started_at) : null,
    endedAt: r.ended_at ? String(r.ended_at) : null,
    createdAt: String(r.created_at),
  };
}

function mapMatchSessionRow(
  r: Record<string, unknown>,
  segments: RecordingSegment[]
): MatchSessionWithSegments {
  return {
    id: String(r.id),
    matchId: String(r.match_id),
    half: String(r.half) as MatchSession['half'],
    status: String(r.status) as MatchSession['status'],
    captureSourceId: r.capture_source_id ? String(r.capture_source_id) : null,
    captureSourceName: r.capture_source_name ? String(r.capture_source_name) : null,
    resolution: String(r.resolution ?? '1920x1080'),
    fps: Number(r.fps ?? 30),
    durationSeconds: Number(r.duration_seconds ?? 0),
    totalBytes: Number(r.total_bytes ?? 0),
    encoder: r.encoder ? String(r.encoder) : null,
    audioEnabled: Boolean(r.audio_enabled),
    outputDirectory: r.output_directory ? String(r.output_directory) : null,
    integrityStatus: (r.integrity_status
      ? String(r.integrity_status)
      : 'pending') as RecordingIntegrityStatus,
    aiEligible: Boolean(r.ai_eligible),
    analysisState: (r.analysis_state
      ? String(r.analysis_state)
      : Boolean(r.ai_eligible)
        ? 'verified_awaiting_phase3'
        : 'not_ready') as RecordingAnalysisState,
    failureReason: r.failure_reason ? String(r.failure_reason) : null,
    diagnosticsPath: r.diagnostics_path ? String(r.diagnostics_path) : null,
    recoveryNotes: r.recovery_notes ? String(r.recovery_notes) : null,
    startedAt: r.started_at ? String(r.started_at) : null,
    endedAt: r.ended_at ? String(r.ended_at) : null,
    createdAt: String(r.created_at),
    updatedAt: r.updated_at ? String(r.updated_at) : null,
    opponentName: r.opponent_name ? String(r.opponent_name) : undefined,
    competition: r.competition ? String(r.competition) : undefined,
    matchDate: r.match_date ? String(r.match_date) : undefined,
    segments,
  };
}

export function listMatchSessions(filters?: {
  matchId?: string;
  clubId?: string;
}): MatchSessionWithSegments[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.matchId) {
    conditions.push('ms.match_id = ?');
    params.push(filters.matchId);
  }
  if (filters?.clubId) {
    conditions.push('m.club_id = ?');
    params.push(filters.clubId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `
      SELECT ms.*, o.name as opponent_name, m.competition, m.match_date
      FROM match_sessions ms
      JOIN matches m ON m.id = ms.match_id
      JOIN opponents o ON o.id = m.opponent_id
      ${whereClause}
      ORDER BY COALESCE(ms.started_at, ms.created_at) DESC
    `
    )
    .all(...params) as Array<Record<string, unknown>>;

  if (rows.length === 0) return [];

  const sessionIds = rows.map((r) => String(r.id));
  const placeholders = sessionIds.map(() => '?').join(', ');
  const segRows = db
    .prepare(
      `
      SELECT * FROM recording_segments
      WHERE session_id IN (${placeholders})
      ORDER BY segment_index ASC
    `
    )
    .all(...sessionIds) as Array<Record<string, unknown>>;

  const segBySession = new Map<string, RecordingSegment[]>();
  for (const sr of segRows) {
    const seg = mapRecordingSegmentRow(sr);
    const list = segBySession.get(seg.sessionId) ?? [];
    list.push(seg);
    segBySession.set(seg.sessionId, list);
  }

  return rows.map((r) => mapMatchSessionRow(r, segBySession.get(String(r.id)) ?? []));
}

export function getMatchSessionById(sessionId: string): MatchSessionWithSegments | null {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT ms.*, o.name as opponent_name, m.competition, m.match_date
      FROM match_sessions ms
      JOIN matches m ON m.id = ms.match_id
      JOIN opponents o ON o.id = m.opponent_id
      WHERE ms.id = ?
    `
    )
    .get(sessionId) as Record<string, unknown> | undefined;

  if (!row) return null;

  const segRows = db
    .prepare('SELECT * FROM recording_segments WHERE session_id = ? ORDER BY segment_index ASC')
    .all(sessionId) as Array<Record<string, unknown>>;

  return mapMatchSessionRow(row, segRows.map(mapRecordingSegmentRow));
}

export function createOrUpsertMatchSession(input: {
  id?: string;
  matchId: string;
  half: 'first_half' | 'second_half';
  status: MatchSession['status'];
  captureSourceId?: string | null;
  captureSourceName?: string | null;
  resolution: string;
  fps: number;
  durationSeconds?: number;
  totalBytes?: number;
  encoder?: string | null;
  audioEnabled?: boolean;
  outputDirectory?: string | null;
  integrityStatus?: RecordingIntegrityStatus;
  aiEligible?: boolean;
  analysisState?: RecordingAnalysisState;
  failureReason?: string | null;
  diagnosticsPath?: string | null;
  recoveryNotes?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}): MatchSessionWithSegments {
  const db = getDb();
  const matchRow = db
    .prepare('SELECT id, club_id, status FROM matches WHERE id = ?')
    .get(input.matchId) as { id: string; club_id: string; status: MatchStatus } | undefined;
  if (!matchRow) {
    throw new Error(`Match "${input.matchId}" not found.`);
  }

  // Phase 2.2 Workstream B: Block starting a recording on a scheduled match if its pre-match lineup
  // contains players who have since become ineligible (loaned_out, transferred_out, injured, suspended, etc.).
  // Already-started/completed matches and historical snapshots are never altered or blocked.
  if (input.status === 'recording' && matchRow.status === 'scheduled') {
    const preMatchSnapshot = getPreMatchTacticalSnapshot(input.matchId);
    if (preMatchSnapshot && !preMatchSnapshot.isLocked) {
      const clubPlayers = listPlayers(matchRow.club_id);
      const snapshotDoubtfulConfirmed = preMatchSnapshot.assignments
        .filter((a) => a.playerId && a.availabilityAtSnapshot === 'doubtful')
        .map((a) => a.playerId!);
      const eligibility = validateLineupEligibility({
        clubPlayers,
        assignments: preMatchSnapshot.assignments.map((a) => ({
          slotOrder: a.slotOrder,
          slotId: a.slotId,
          positionCode: a.positionCode,
          playerId: a.playerId,
        })),
        benchPlayerIds: preMatchSnapshot.benchPlayers.map((b) => b.playerId),
        confirmedDoubtfulPlayerIds: snapshotDoubtfulConfirmed,
      });
      if (eligibility.issues.length > 0) {
        throw new Error(
          `Cannot start match recording because the pre-match lineup contains ineligible player(s): ${eligibility.issues[0].reason} Update the match lineup in Match Preparation before kick-off.`
        );
      }
    }
  }

  const sessionId = input.id?.trim() || crypto.randomUUID();
  const now = new Date().toISOString();
  const derivedAnalysisState: RecordingAnalysisState =
    input.analysisState ?? (input.aiEligible ? 'verified_awaiting_phase3' : 'not_ready');

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO match_sessions (
        id, match_id, half, status, capture_source_id, capture_source_name,
        resolution, fps, duration_seconds, total_bytes, encoder, audio_enabled,
        output_directory, integrity_status, ai_eligible, analysis_state, failure_reason, diagnostics_path,
        recovery_notes, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        capture_source_id = COALESCE(excluded.capture_source_id, match_sessions.capture_source_id),
        capture_source_name = COALESCE(excluded.capture_source_name, match_sessions.capture_source_name),
        resolution = excluded.resolution,
        fps = excluded.fps,
        duration_seconds = excluded.duration_seconds,
        total_bytes = excluded.total_bytes,
        encoder = COALESCE(excluded.encoder, match_sessions.encoder),
        audio_enabled = excluded.audio_enabled,
        output_directory = COALESCE(excluded.output_directory, match_sessions.output_directory),
        integrity_status = excluded.integrity_status,
        ai_eligible = excluded.ai_eligible,
        analysis_state = excluded.analysis_state,
        failure_reason = COALESCE(excluded.failure_reason, match_sessions.failure_reason),
        diagnostics_path = COALESCE(excluded.diagnostics_path, match_sessions.diagnostics_path),
        recovery_notes = COALESCE(excluded.recovery_notes, match_sessions.recovery_notes),
        started_at = COALESCE(match_sessions.started_at, excluded.started_at),
        ended_at = COALESCE(excluded.ended_at, match_sessions.ended_at),
        updated_at = excluded.updated_at
    `).run(
      sessionId,
      input.matchId,
      input.half,
      input.status,
      input.captureSourceId ?? null,
      input.captureSourceName ?? null,
      input.resolution,
      input.fps,
      Math.max(0, Math.round(input.durationSeconds ?? 0)),
      Math.max(0, Math.round(input.totalBytes ?? 0)),
      input.encoder ?? null,
      input.audioEnabled ? 1 : 0,
      input.outputDirectory ?? null,
      input.integrityStatus ?? 'pending',
      input.aiEligible ? 1 : 0,
      derivedAnalysisState,
      input.failureReason ?? null,
      input.diagnosticsPath ?? null,
      input.recoveryNotes ?? null,
      input.startedAt ?? now,
      input.endedAt ?? null,
      now,
      now
    );

    syncMatchStatusForSession(db, sessionId, input.matchId, input.half, input.status, now);
  });

  tx();
  return getMatchSessionById(sessionId)!;
}

function syncMatchStatusForSession(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  matchId: string,
  half: 'first_half' | 'second_half',
  sessionStatus: MatchSession['status'],
  now: string
): void {
  if (sessionStatus === 'recording' || sessionStatus === 'paused') {
    const nextMatchStatus: MatchStatus =
      half === 'first_half' ? 'first_half_recording' : 'second_half_recording';
    db.prepare('UPDATE matches SET status = ?, updated_at = ? WHERE id = ?').run(
      nextMatchStatus,
      now,
      matchId
    );
    // Workstream E: Lock pre-match tactical snapshot once recording begins
    db.prepare(
      `UPDATE match_tactical_snapshots
       SET is_locked = 1, updated_at = ?
       WHERE match_id = ? AND snapshot_type = 'pre_match' AND is_locked = 0`
    ).run(now, matchId);
    return;
  }

  if (
    sessionStatus === 'completed' ||
    sessionStatus === 'recovered' ||
    sessionStatus === 'partial'
  ) {
    // Workstream A critical invariant: NEVER transition a match to halftime_ready
    // unless at least 1 FFprobe-verified non-empty segment exists for this session!
    const validSegRow = db
      .prepare(
        `SELECT COUNT(*) as c
         FROM recording_segments
         WHERE session_id = ?
           AND status IN ('finalized', 'recovered')
           AND size_bytes > 0
           AND duration_seconds > 0`
      )
      .get(sessionId) as { c: number };

    if (validSegRow.c === 0) {
      db.prepare(
        `UPDATE match_sessions
         SET status = 'failed',
             ai_eligible = 0,
             analysis_state = 'not_ready',
             integrity_status = 'corrupted',
             failure_reason = COALESCE(failure_reason, 'Finalized with 0 valid non-empty segments.'),
             updated_at = ?
         WHERE id = ?`
      ).run(now, sessionId);
      // Fall through to failed/discarded match recovery so user can retry cleanly
      syncMatchStatusForSession(db, sessionId, matchId, half, 'failed', now);
      return;
    }

    // Confirmed >=1 valid segment: ensure ai_eligible = 1 and Phase 3 waiting state
    db.prepare(
      `UPDATE match_sessions
       SET ai_eligible = 1,
           analysis_state = CASE WHEN analysis_state = 'analysis_completed' THEN 'analysis_completed' ELSE 'verified_awaiting_phase3' END,
           updated_at = ?
       WHERE id = ?`
    ).run(now, sessionId);

    if (half === 'first_half') {
      db.prepare(
        `UPDATE matches
         SET status = CASE WHEN status IN ('scheduled', 'first_half_recording') THEN 'halftime_ready' ELSE status END,
             updated_at = ?
         WHERE id = ?`
      ).run(now, matchId);
    } else {
      db.prepare(
        `UPDATE matches
         SET has_second_half_recording = 1,
             status = CASE WHEN status = 'second_half_recording' THEN 'completed' ELSE status END,
             updated_at = ?
         WHERE id = ?`
      ).run(now, matchId);
    }
    return;
  }

  if (sessionStatus === 'failed' || sessionStatus === 'discarded') {
    if (half === 'first_half') {
      const hasValidFirst = db
        .prepare(
          `SELECT COUNT(*) as c
           FROM match_sessions ms
           WHERE ms.match_id = ?
             AND ms.half = 'first_half'
             AND ms.status IN ('completed', 'recovered', 'partial')
             AND ms.ai_eligible = 1`
        )
        .get(matchId) as { c: number };
      if (hasValidFirst.c === 0) {
        db.prepare(
          `UPDATE matches
           SET status = CASE WHEN status = 'first_half_recording' THEN 'scheduled' ELSE status END,
               updated_at = ?
           WHERE id = ?`
        ).run(now, matchId);
      }
    } else {
      const hasValidSecond = db
        .prepare(
          `SELECT COUNT(*) as c
           FROM match_sessions ms
           WHERE ms.match_id = ?
             AND ms.half = 'second_half'
             AND ms.status IN ('completed', 'recovered', 'partial')
             AND ms.ai_eligible = 1`
        )
        .get(matchId) as { c: number };
      if (hasValidSecond.c === 0) {
        db.prepare(
          `UPDATE matches
           SET has_second_half_recording = 0,
               status = CASE WHEN status = 'second_half_recording' THEN 'halftime_ready' ELSE status END,
               updated_at = ?
           WHERE id = ?`
        ).run(now, matchId);
      }
    }
  }
}

export function updateMatchSession(
  sessionId: string,
  input: Partial<{
    status: MatchSession['status'];
    resolution: string;
    fps: number;
    durationSeconds: number;
    totalBytes: number;
    encoder: string | null;
    audioEnabled: boolean;
    outputDirectory: string | null;
    integrityStatus: RecordingIntegrityStatus;
    aiEligible: boolean;
    analysisState: RecordingAnalysisState;
    failureReason: string | null;
    diagnosticsPath: string | null;
    recoveryNotes: string | null;
    endedAt: string | null;
  }>
): MatchSessionWithSegments | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM match_sessions WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  const nextStatus = input.status ?? (String(existing.status) as MatchSession['status']);
  const matchId = String(existing.match_id);
  const half = String(existing.half) as MatchSession['half'];
  const nextAiEligible =
    input.aiEligible !== undefined ? Boolean(input.aiEligible) : Boolean(existing.ai_eligible);
  const existingAnalysisState = String(
    existing.analysis_state ?? (existing.ai_eligible ? 'verified_awaiting_phase3' : 'not_ready')
  ) as RecordingAnalysisState;
  const nextAnalysisState: RecordingAnalysisState =
    input.analysisState ??
    (nextAiEligible
      ? existingAnalysisState === 'analysis_completed'
        ? 'analysis_completed'
        : 'verified_awaiting_phase3'
      : 'not_ready');

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE match_sessions
      SET status = ?,
          resolution = ?,
          fps = ?,
          duration_seconds = ?,
          total_bytes = ?,
          encoder = ?,
          audio_enabled = ?,
          output_directory = ?,
          integrity_status = ?,
          ai_eligible = ?,
          analysis_state = ?,
          failure_reason = ?,
          diagnostics_path = ?,
          recovery_notes = ?,
          ended_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      input.resolution ?? String(existing.resolution),
      input.fps ?? Number(existing.fps),
      input.durationSeconds !== undefined
        ? Math.max(0, Math.round(input.durationSeconds))
        : Number(existing.duration_seconds),
      input.totalBytes !== undefined
        ? Math.max(0, Math.round(input.totalBytes))
        : Number(existing.total_bytes),
      input.encoder !== undefined ? input.encoder : existing.encoder,
      input.audioEnabled !== undefined
        ? input.audioEnabled
          ? 1
          : 0
        : Number(existing.audio_enabled ?? 0),
      input.outputDirectory !== undefined ? input.outputDirectory : existing.output_directory,
      input.integrityStatus ?? String(existing.integrity_status ?? 'pending'),
      nextAiEligible ? 1 : 0,
      nextAnalysisState,
      input.failureReason !== undefined ? input.failureReason : existing.failure_reason,
      input.diagnosticsPath !== undefined ? input.diagnosticsPath : existing.diagnostics_path,
      input.recoveryNotes !== undefined ? input.recoveryNotes : existing.recovery_notes,
      input.endedAt !== undefined ? input.endedAt : existing.ended_at,
      now,
      sessionId
    );

    syncMatchStatusForSession(db, sessionId, matchId, half, nextStatus, now);
  });

  tx();
  return getMatchSessionById(sessionId);
}

export function upsertRecordingSegment(input: {
  sessionId: string;
  matchId: string;
  segmentIndex: number;
  filePath: string;
  durationSeconds: number;
  sizeBytes: number;
  checksum?: string | null;
  status: RecordingSegment['status'];
  resolution?: string | null;
  fps?: number | null;
  codec?: string | null;
  hasAudio?: boolean;
  integrityStatus?: RecordingIntegrityStatus;
  startedAt?: string | null;
  endedAt?: string | null;
}): RecordingSegment {
  const db = getDb();
  const sessionRow = db
    .prepare('SELECT id, match_id FROM match_sessions WHERE id = ?')
    .get(input.sessionId) as { id: string; match_id: string } | undefined;
  if (!sessionRow) {
    throw new Error(`Match session "${input.sessionId}" not found.`);
  }
  if (sessionRow.match_id !== input.matchId) {
    throw new Error('Segment matchId does not match parent session matchId.');
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO recording_segments (
      id, session_id, match_id, segment_index, file_path, duration_seconds,
      size_bytes, checksum, status, resolution, fps, codec, has_audio,
      integrity_status, started_at, ended_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, segment_index) DO UPDATE SET
      file_path = excluded.file_path,
      duration_seconds = excluded.duration_seconds,
      size_bytes = excluded.size_bytes,
      checksum = COALESCE(excluded.checksum, recording_segments.checksum),
      status = excluded.status,
      resolution = COALESCE(excluded.resolution, recording_segments.resolution),
      fps = COALESCE(excluded.fps, recording_segments.fps),
      codec = COALESCE(excluded.codec, recording_segments.codec),
      has_audio = excluded.has_audio,
      integrity_status = excluded.integrity_status,
      started_at = COALESCE(recording_segments.started_at, excluded.started_at),
      ended_at = COALESCE(excluded.ended_at, recording_segments.ended_at)
  `).run(
    id,
    input.sessionId,
    input.matchId,
    input.segmentIndex,
    input.filePath,
    Math.max(0, Math.round(input.durationSeconds)),
    Math.max(0, Math.round(input.sizeBytes)),
    input.checksum ?? null,
    input.status,
    input.resolution ?? null,
    input.fps ?? null,
    input.codec ?? null,
    input.hasAudio ? 1 : 0,
    input.integrityStatus ?? 'pending',
    input.startedAt ?? now,
    input.endedAt ?? null,
    now
  );

  const row = db
    .prepare('SELECT * FROM recording_segments WHERE session_id = ? AND segment_index = ?')
    .get(input.sessionId, input.segmentIndex) as Record<string, unknown>;
  return mapRecordingSegmentRow(row);
}

export function saveRecordingDiagnostics(input: {
  sessionId: string;
  matchId: string;
  failureReason?: string | null;
  payload: RecordingPipelineDiagnostics;
}): RecordingDiagnosticsRecord {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO recording_diagnostics (
      id, session_id, match_id, failure_reason, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      failure_reason = excluded.failure_reason,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.sessionId,
    input.matchId,
    input.failureReason ?? null,
    JSON.stringify(input.payload),
    now,
    now
  );

  return getRecordingDiagnostics(input.sessionId)!;
}

export function getRecordingDiagnostics(sessionId: string): RecordingDiagnosticsRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM recording_diagnostics WHERE session_id = ?')
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    matchId: String(row.match_id),
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    payload: safeJsonParse<RecordingPipelineDiagnostics>(
      String(row.payload_json),
      {} as RecordingPipelineDiagnostics
    ),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
