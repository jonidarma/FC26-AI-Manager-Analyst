import type Database from 'better-sqlite3';
import type {
  CatalogClub,
  CatalogCompatibilityRow,
  CatalogDatasetType,
  CatalogFocus,
  CatalogFormation,
  CatalogFormationSlot,
  CatalogImportRun,
  CatalogLeague,
  CatalogNation,
  CatalogOverview,
  CatalogPlayer,
  CatalogPosition,
  CatalogRole,
  CatalogSource,
  DatasetCompleteness,
  PaginatedResult,
} from '../../src/types/domain.ts';
import { getDb } from '../db/database.ts';
import { mapImportRunRow } from './catalogImporter.ts';

function resolveDb(db?: Database.Database): Database.Database {
  return db ?? getDb();
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function listCatalogSources(dbArg?: Database.Database): CatalogSource[] {
  const db = resolveDb(dbArg);
  const rows = db
    .prepare('SELECT * FROM catalog_sources ORDER BY name ASC')
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    sourceKey: String(r.source_key),
    name: String(r.name),
    url: String(r.url),
    edition: String(r.edition),
    licenseNotes: String(r.license_notes),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function listImportRuns(dbArg?: Database.Database): CatalogImportRun[] {
  const db = resolveDb(dbArg);
  const rows = db
    .prepare(`
      SELECT r.*, s.name as source_name
      FROM catalog_import_runs r
      LEFT JOIN catalog_sources s ON s.id = r.source_id
      ORDER BY r.started_at DESC
      LIMIT 100
    `)
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapImportRunRow);
}

export function getCatalogOverview(dbArg?: Database.Database): CatalogOverview {
  const db = resolveDb(dbArg);
  const countOf = (sql: string): number =>
    (db.prepare(sql).get() as { count: number } | undefined)?.count ?? 0;

  const players = countOf('SELECT COUNT(*) as count FROM catalog_players');
  const clubs = countOf('SELECT COUNT(*) as count FROM catalog_clubs');
  const mensClubs = countOf("SELECT COUNT(*) as count FROM catalog_clubs WHERE team_category = 'mens'");
  const womensClubs = countOf("SELECT COUNT(*) as count FROM catalog_clubs WHERE team_category = 'womens'");
  const leagues = countOf('SELECT COUNT(*) as count FROM catalog_leagues');
  const nations = countOf('SELECT COUNT(*) as count FROM catalog_nations');
  const formations = countOf('SELECT COUNT(*) as count FROM catalog_formations');
  const positions = countOf('SELECT COUNT(*) as count FROM catalog_positions');
  const roles = countOf('SELECT COUNT(*) as count FROM catalog_player_roles');
  const focuses = countOf('SELECT COUNT(*) as count FROM catalog_player_focuses');
  const rolePositionPairs = countOf('SELECT COUNT(*) as count FROM catalog_role_position_compatibility');
  const roleFocusPairs = countOf('SELECT COUNT(*) as count FROM catalog_role_focus_compatibility');
  const sourcesCount = countOf('SELECT COUNT(*) as count FROM catalog_sources');
  const importRuns = countOf('SELECT COUNT(*) as count FROM catalog_import_runs');

  const schemaRow = db
    .prepare('SELECT MAX(version) as version FROM schema_migrations')
    .get() as { version: number | null };

  const lastImportRow = db
    .prepare("SELECT MAX(completed_at) as last_at FROM catalog_import_runs WHERE status = 'completed'")
    .get() as { last_at: string | null };

  const latestCompleteness = (
    datasetType: CatalogDatasetType,
    count: number,
    fallback: DatasetCompleteness
  ): DatasetCompleteness => {
    if (count === 0) return 'empty_awaiting_user_import';
    const row = db
      .prepare(
        `SELECT completeness FROM catalog_import_runs WHERE dataset_type = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`
      )
      .get(datasetType) as { completeness: DatasetCompleteness } | undefined;
    return row?.completeness ?? fallback;
  };

  const completeness: CatalogOverview['completeness'] = {
    positions: latestCompleteness('positions', positions, 'verified_complete'),
    roles: latestCompleteness('roles', roles, 'verified_complete'),
    focuses: latestCompleteness('focuses', focuses, 'verified_complete'),
    formations: latestCompleteness('formations', formations, 'verified_complete'),
    nations: latestCompleteness('nations', nations, 'partial_baseline'),
    leagues: latestCompleteness('leagues', leagues, 'partial_baseline'),
    clubs: latestCompleteness('clubs', clubs, 'partial_baseline'),
    players: latestCompleteness('players', players, 'empty_awaiting_user_import'),
  };

  const warnings: string[] = [];
  if (players === 0) {
    warnings.push(
      'Player catalog currently contains 0 imported records. Import your FC 26 Career Mode CSV or JSON player dump via Import & Update History or scripts/data-import/import-players.ts.'
    );
  }
  if (completeness.clubs === 'partial_baseline') {
    warnings.push(
      `Clubs catalog is currently a partial baseline (${clubs} clubs: ${mensClubs} men's, ${womensClubs} women's). Import a full club dataset to expand coverage.`
    );
  }
  if (completeness.leagues === 'partial_baseline' || completeness.nations === 'partial_baseline') {
    warnings.push(
      `Leagues (${leagues}) and Nations (${nations}) are starter baselines. Full FUTWIZ/FIFPlay coverage can be imported via CSV/JSON.`
    );
  }

  return {
    schemaVersion: schemaRow?.version ?? 2,
    counts: {
      players,
      clubs,
      mensClubs,
      womensClubs,
      leagues,
      nations,
      formations,
      positions,
      roles,
      focuses,
      rolePositionPairs,
      roleFocusPairs,
      sources: sourcesCount,
      importRuns,
    },
    completeness,
    lastImportAt: lastImportRow?.last_at ?? null,
    sources: listCatalogSources(db),
    warnings,
  };
}

export function listCatalogPositions(dbArg?: Database.Database): CatalogPosition[] {
  const db = resolveDb(dbArg);
  const rows = db
    .prepare('SELECT * FROM catalog_positions ORDER BY sort_order ASC, code ASC')
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    code: String(r.code),
    label: String(r.label),
    category: String(r.category),
    tacticalLine: String(r.tactical_line) as CatalogPosition['tacticalLine'],
    sortOrder: Number(r.sort_order),
  }));
}

export function listCatalogNations(
  filters: { q?: string; region?: string } = {},
  dbArg?: Database.Database
): CatalogNation[] {
  const db = resolveDb(dbArg);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.q?.trim()) {
    conditions.push('(n.display_name LIKE ? OR n.source_name LIKE ? OR n.iso_code LIKE ?)');
    const pattern = `%${filters.q.trim()}%`;
    params.push(pattern, pattern, pattern);
  }
  if (filters.region?.trim()) {
    conditions.push('n.region = ?');
    params.push(filters.region.trim());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`
      SELECT n.*,
        (SELECT COUNT(*) FROM catalog_leagues l WHERE l.country_id = n.id) as league_count,
        (SELECT COUNT(*) FROM catalog_clubs c WHERE c.nation_id = n.id) as club_count,
        (SELECT COUNT(*) FROM catalog_players p WHERE p.nation_id = n.id) as player_count
      FROM catalog_nations n
      ${where}
      ORDER BY n.display_name ASC
    `)
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    externalSourceId: String(r.external_source_id),
    sourceName: String(r.source_name),
    displayName: String(r.display_name),
    isoCode: String(r.iso_code),
    region: String(r.region),
    leagueCount: Number(r.league_count ?? 0),
    clubCount: Number(r.club_count ?? 0),
    playerCount: Number(r.player_count ?? 0),
  }));
}

export function listCatalogLeagues(
  filters: { q?: string; countryId?: string; category?: string } = {},
  dbArg?: Database.Database
): CatalogLeague[] {
  const db = resolveDb(dbArg);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.q?.trim()) {
    conditions.push('(l.name LIKE ? OR l.country_name LIKE ?)');
    const pattern = `%${filters.q.trim()}%`;
    params.push(pattern, pattern);
  }
  if (filters.countryId?.trim()) {
    conditions.push('l.country_id = ?');
    params.push(filters.countryId.trim());
  }
  if (filters.category && ['mens', 'womens', 'mixed'].includes(filters.category)) {
    conditions.push('l.category = ?');
    params.push(filters.category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`
      SELECT l.*,
        (SELECT COUNT(*) FROM catalog_clubs c WHERE c.league_id = l.id) as club_count,
        (SELECT COUNT(*) FROM catalog_players p WHERE p.league_id = l.id) as player_count
      FROM catalog_leagues l
      ${where}
      ORDER BY l.tier ASC NULLS LAST, l.name ASC
    `)
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    externalSourceId: String(r.external_source_id),
    name: String(r.name),
    countryId: r.country_id ? String(r.country_id) : null,
    countryName: String(r.country_name),
    tier: r.tier === null ? null : Number(r.tier),
    category: String(r.category) as CatalogLeague['category'],
    clubCount: Number(r.club_count ?? 0),
    playerCount: Number(r.player_count ?? 0),
  }));
}

export function searchCatalogClubs(
  filters: {
    q?: string;
    leagueId?: string;
    nationId?: string;
    teamCategory?: 'mens' | 'womens' | '';
    page?: number;
    pageSize?: number;
  } = {},
  dbArg?: Database.Database
): PaginatedResult<CatalogClub> {
  const db = resolveDb(dbArg);
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.q?.trim()) {
    conditions.push('(c.name LIKE ? OR c.short_name LIKE ?)');
    const pattern = `%${filters.q.trim()}%`;
    params.push(pattern, pattern);
  }
  if (filters.leagueId?.trim()) {
    conditions.push('c.league_id = ?');
    params.push(filters.leagueId.trim());
  }
  if (filters.nationId?.trim()) {
    conditions.push('c.nation_id = ?');
    params.push(filters.nationId.trim());
  }
  if (filters.teamCategory === 'mens' || filters.teamCategory === 'womens') {
    conditions.push('c.team_category = ?');
    params.push(filters.teamCategory);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM catalog_clubs c ${where}`).get(...params) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(`
      SELECT c.*, l.name as league_name, n.display_name as nation_name,
        (SELECT COUNT(*) FROM catalog_players p WHERE p.club_id = c.id) as player_count
      FROM catalog_clubs c
      LEFT JOIN catalog_leagues l ON l.id = c.league_id
      LEFT JOIN catalog_nations n ON n.id = c.nation_id
      ${where}
      ORDER BY c.name ASC
      LIMIT ? OFFSET ?
    `)
    .all(...params, pageSize, offset) as Array<Record<string, unknown>>;

  return {
    items: rows.map((r) => ({
      id: String(r.id),
      externalSourceId: String(r.external_source_id),
      name: String(r.name),
      shortName: String(r.short_name),
      leagueId: r.league_id ? String(r.league_id) : null,
      leagueName: r.league_name ? String(r.league_name) : null,
      nationId: r.nation_id ? String(r.nation_id) : null,
      nationName: r.nation_name ? String(r.nation_name) : null,
      teamCategory: String(r.team_category) as 'mens' | 'womens',
      playerCount: Number(r.player_count ?? 0),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface PlayerSearchFilters {
  q?: string;
  positions?: string[];
  clubId?: string;
  leagueId?: string;
  nationId?: string;
  minOvr?: number;
  maxOvr?: number;
  minPot?: number;
  maxPot?: number;
  minAge?: number;
  maxAge?: number;
  preferredFoot?: 'Right' | 'Left' | 'Both' | '';
  sortBy?: 'overall' | 'potential' | 'growth' | 'age' | 'name' | 'pace' | 'market_value';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

const PLAYER_SORT_COLUMNS: Record<NonNullable<PlayerSearchFilters['sortBy']>, string> = {
  overall: 'p.overall_rating',
  potential: 'p.potential_rating',
  growth: 'p.growth',
  age: 'p.age',
  name: 'p.full_name',
  pace: 'p.pace',
  market_value: 'p.market_value_eur',
};

export function searchCatalogPlayers(
  filters: PlayerSearchFilters = {},
  dbArg?: Database.Database
): PaginatedResult<CatalogPlayer> {
  const db = resolveDb(dbArg);
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 30));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.q?.trim()) {
    conditions.push('(p.full_name LIKE ? OR p.short_name LIKE ? OR p.club_name_raw LIKE ?)');
    const pattern = `%${filters.q.trim()}%`;
    params.push(pattern, pattern, pattern);
  }

  if (filters.positions && filters.positions.length > 0) {
    const cleanPos = filters.positions.map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (cleanPos.length > 0) {
      const placeholders = cleanPos.map(() => '?').join(', ');
      conditions.push(
        `(p.primary_position IN (${placeholders}) OR EXISTS (SELECT 1 FROM catalog_player_positions cpp WHERE cpp.player_id = p.id AND cpp.position_code IN (${placeholders})))`
      );
      params.push(...cleanPos, ...cleanPos);
    }
  }

  if (filters.clubId?.trim()) {
    conditions.push('p.club_id = ?');
    params.push(filters.clubId.trim());
  }
  if (filters.leagueId?.trim()) {
    conditions.push('p.league_id = ?');
    params.push(filters.leagueId.trim());
  }
  if (filters.nationId?.trim()) {
    conditions.push('p.nation_id = ?');
    params.push(filters.nationId.trim());
  }
  if (filters.minOvr !== undefined) {
    conditions.push('p.overall_rating >= ?');
    params.push(filters.minOvr);
  }
  if (filters.maxOvr !== undefined) {
    conditions.push('p.overall_rating <= ?');
    params.push(filters.maxOvr);
  }
  if (filters.minPot !== undefined) {
    conditions.push('p.potential_rating >= ?');
    params.push(filters.minPot);
  }
  if (filters.maxPot !== undefined) {
    conditions.push('p.potential_rating <= ?');
    params.push(filters.maxPot);
  }
  if (filters.minAge !== undefined) {
    conditions.push('p.age >= ?');
    params.push(filters.minAge);
  }
  if (filters.maxAge !== undefined) {
    conditions.push('p.age <= ?');
    params.push(filters.maxAge);
  }
  if (filters.preferredFoot && ['Right', 'Left', 'Both'].includes(filters.preferredFoot)) {
    conditions.push('p.preferred_foot = ?');
    params.push(filters.preferredFoot);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM catalog_players p ${where}`).get(...params) as {
      count: number;
    }
  ).count;

  const sortCol = PLAYER_SORT_COLUMNS[filters.sortBy ?? 'overall'] ?? 'p.overall_rating';
  const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

  const rows = db
    .prepare(`
      SELECT p.*,
        COALESCE(c.name, NULLIF(p.club_name_raw, '')) as resolved_club_name,
        COALESCE(l.name, NULLIF(p.league_name_raw, '')) as resolved_league_name,
        COALESCE(n.display_name, NULLIF(p.nation_name_raw, '')) as resolved_nation_name,
        s.name as source_name
      FROM catalog_players p
      LEFT JOIN catalog_clubs c ON c.id = p.club_id
      LEFT JOIN catalog_leagues l ON l.id = p.league_id
      LEFT JOIN catalog_nations n ON n.id = p.nation_id
      LEFT JOIN catalog_sources s ON s.id = p.source_id
      ${where}
      ORDER BY ${sortCol} ${sortDir} NULLS LAST, p.full_name ASC
      LIMIT ? OFFSET ?
    `)
    .all(...params, pageSize, offset) as Array<Record<string, unknown>>;

  const playerIds = rows.map((r) => String(r.id));
  const secPosMap = new Map<string, string[]>();
  if (playerIds.length > 0) {
    const placeholders = playerIds.map(() => '?').join(', ');
    const posRows = db
      .prepare(
        `SELECT player_id, position_code FROM catalog_player_positions WHERE is_primary = 0 AND player_id IN (${placeholders})`
      )
      .all(...playerIds) as Array<{ player_id: string; position_code: string }>;
    for (const pr of posRows) {
      const list = secPosMap.get(pr.player_id) ?? [];
      list.push(pr.position_code);
      secPosMap.set(pr.player_id, list);
    }
  }

  return {
    items: rows.map((r) => mapCatalogPlayerRow(r, secPosMap.get(String(r.id)) ?? [])),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function mapCatalogPlayerRow(r: Record<string, unknown>, secondaryPositions: string[]): CatalogPlayer {
  return {
    id: String(r.id),
    externalSourceId: String(r.external_source_id),
    fullName: String(r.full_name),
    shortName: String(r.short_name ?? ''),
    clubId: r.club_id ? String(r.club_id) : null,
    clubName: r.resolved_club_name ? String(r.resolved_club_name) : null,
    leagueId: r.league_id ? String(r.league_id) : null,
    leagueName: r.resolved_league_name ? String(r.resolved_league_name) : null,
    nationId: r.nation_id ? String(r.nation_id) : null,
    nationName: r.resolved_nation_name ? String(r.resolved_nation_name) : null,
    primaryPosition: String(r.primary_position),
    secondaryPositions,
    age: r.age === null ? null : Number(r.age),
    overallRating: r.overall_rating === null ? null : Number(r.overall_rating),
    potentialRating: r.potential_rating === null ? null : Number(r.potential_rating),
    growth: r.growth === null ? null : Number(r.growth),
    pace: r.pace === null ? null : Number(r.pace),
    shooting: r.shooting === null ? null : Number(r.shooting),
    passing: r.passing === null ? null : Number(r.passing),
    dribbling: r.dribbling === null ? null : Number(r.dribbling),
    defending: r.defending === null ? null : Number(r.defending),
    physicality: r.physicality === null ? null : Number(r.physicality),
    preferredFoot: r.preferred_foot ? (String(r.preferred_foot) as 'Right' | 'Left' | 'Both') : null,
    weakFoot: r.weak_foot === null ? null : Number(r.weak_foot),
    skillMoves: r.skill_moves === null ? null : Number(r.skill_moves),
    heightCm: r.height_cm === null ? null : Number(r.height_cm),
    weightKg: r.weight_kg === null ? null : Number(r.weight_kg),
    marketValueEur: r.market_value_eur === null ? null : Number(r.market_value_eur),
    wageEur: r.wage_eur === null ? null : Number(r.wage_eur),
    contractExpiry: r.contract_expiry ? String(r.contract_expiry) : null,
    attributes: safeJson<Record<string, unknown> | null>(r.attributes_json, null),
    sourceName: r.source_name ? String(r.source_name) : null,
  };
}

export function getCatalogPlayerById(id: string, dbArg?: Database.Database): CatalogPlayer | null {
  const db = resolveDb(dbArg);
  const row = db
    .prepare(`
      SELECT p.*,
        COALESCE(c.name, NULLIF(p.club_name_raw, '')) as resolved_club_name,
        COALESCE(l.name, NULLIF(p.league_name_raw, '')) as resolved_league_name,
        COALESCE(n.display_name, NULLIF(p.nation_name_raw, '')) as resolved_nation_name,
        s.name as source_name
      FROM catalog_players p
      LEFT JOIN catalog_clubs c ON c.id = p.club_id
      LEFT JOIN catalog_leagues l ON l.id = p.league_id
      LEFT JOIN catalog_nations n ON n.id = p.nation_id
      LEFT JOIN catalog_sources s ON s.id = p.source_id
      WHERE p.id = ?
    `)
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  const secPos = (
    db
      .prepare('SELECT position_code FROM catalog_player_positions WHERE player_id = ? AND is_primary = 0')
      .all(id) as Array<{ position_code: string }>
  ).map((x) => x.position_code);

  return mapCatalogPlayerRow(row, secPos);
}

export function listCatalogFormations(
  filters: { q?: string; category?: string } = {},
  dbArg?: Database.Database
): CatalogFormation[] {
  const db = resolveDb(dbArg);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.q?.trim()) {
    conditions.push('(f.name LIKE ? OR f.code LIKE ? OR f.tactical_summary LIKE ?)');
    const pattern = `%${filters.q.trim()}%`;
    params.push(pattern, pattern, pattern);
  }
  if (filters.category?.trim()) {
    conditions.push('f.category = ?');
    params.push(filters.category.trim());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM catalog_formations f ${where} ORDER BY f.category ASC, f.name ASC`)
    .all(...params) as Array<Record<string, unknown>>;

  const allSlots = db
    .prepare('SELECT * FROM catalog_formation_slots ORDER BY formation_id ASC, slot_order ASC')
    .all() as Array<Record<string, unknown>>;

  const slotMap = new Map<string, CatalogFormationSlot[]>();
  for (const s of allSlots) {
    const fId = String(s.formation_id);
    const list = slotMap.get(fId) ?? [];
    list.push({
      id: String(s.id),
      formationId: fId,
      slotOrder: Number(s.slot_order),
      positionCode: String(s.position_code),
      positionLabel: String(s.position_label),
      x: Number(s.x),
      y: Number(s.y),
      tacticalLine: String(s.tactical_line) as CatalogFormationSlot['tacticalLine'],
      isUserAdjusted: Boolean(s.is_user_adjusted),
    });
    slotMap.set(fId, list);
  }

  return rows.map((r) => ({
    id: String(r.id),
    externalSourceId: String(r.external_source_id),
    name: String(r.name),
    code: String(r.code),
    category: String(r.category),
    defensiveShape: String(r.defensive_shape),
    attackingShape: String(r.attacking_shape),
    tacticalSummary: String(r.tactical_summary),
    gameModes: safeJson<string[]>(r.game_modes_json, ['Career Mode']),
    careerModeStatus: String(r.career_mode_status) as CatalogFormation['careerModeStatus'],
    layoutVerified: Boolean(r.layout_verified),
    isUserAdjusted: Boolean(r.is_user_adjusted),
    slots: slotMap.get(String(r.id)) ?? [],
  }));
}

export function getCatalogFormationByIdOrName(
  idOrName: string,
  dbArg?: Database.Database
): CatalogFormation | null {
  const db = resolveDb(dbArg);
  const all = listCatalogFormations({}, db);
  return (
    all.find((f) => f.id === idOrName) ??
    all.find((f) => f.name.toLowerCase() === idOrName.toLowerCase()) ??
    all.find((f) => f.code.toLowerCase() === idOrName.toLowerCase()) ??
    null
  );
}

export function updateFormationSlotCoordinates(
  formationId: string,
  slots: Array<{ slotOrder: number; x: number; y: number }>,
  dbArg?: Database.Database
): CatalogFormation | null {
  const db = resolveDb(dbArg);
  const exists = db.prepare('SELECT id FROM catalog_formations WHERE id = ?').get(formationId);
  if (!exists) return null;

  const now = new Date().toISOString();
  const updateSlot = db.prepare(`
    UPDATE catalog_formation_slots
    SET x = ?, y = ?, is_user_adjusted = 1
    WHERE formation_id = ? AND slot_order = ?
  `);

  const tx = db.transaction(() => {
    for (const s of slots) {
      updateSlot.run(
        Math.max(5, Math.min(95, Number(s.x))),
        Math.max(8, Math.min(94, Number(s.y))),
        formationId,
        s.slotOrder
      );
    }
    db.prepare(
      'UPDATE catalog_formations SET is_user_adjusted = 1, updated_at = ? WHERE id = ?'
    ).run(now, formationId);
  });
  tx();

  return getCatalogFormationByIdOrName(formationId, db);
}

export function listCatalogRoles(
  positionCode?: string,
  dbArg?: Database.Database
): CatalogRole[] {
  const db = resolveDb(dbArg);
  const roleRows = positionCode?.trim()
    ? (db
        .prepare(`
          SELECT DISTINCT r.*
          FROM catalog_player_roles r
          JOIN catalog_role_position_compatibility rpc ON rpc.role_id = r.id
          WHERE rpc.position_code = ?
          ORDER BY r.is_fc26_new DESC, r.name ASC
        `)
        .all(positionCode.trim().toUpperCase()) as Array<Record<string, unknown>>)
    : (db
        .prepare('SELECT * FROM catalog_player_roles ORDER BY position_category ASC, name ASC')
        .all() as Array<Record<string, unknown>>);

  const posRows = db
    .prepare('SELECT role_id, position_code FROM catalog_role_position_compatibility')
    .all() as Array<{ role_id: string; position_code: string }>;
  const posMap = new Map<string, string[]>();
  for (const pr of posRows) {
    const list = posMap.get(pr.role_id) ?? [];
    list.push(pr.position_code);
    posMap.set(pr.role_id, list);
  }

  const focusRows = db
    .prepare(`
      SELECT rfc.role_id, rfc.position_code, f.name as focus_name
      FROM catalog_role_focus_compatibility rfc
      JOIN catalog_player_focuses f ON f.id = rfc.focus_id
      ORDER BY f.name ASC
    `)
    .all() as Array<{ role_id: string; position_code: string; focus_name: string }>;

  const focusMap = new Map<string, Record<string, string[]>>();
  for (const fr of focusRows) {
    const byPos = focusMap.get(fr.role_id) ?? {};
    const list = byPos[fr.position_code] ?? [];
    list.push(fr.focus_name);
    byPos[fr.position_code] = list;
    focusMap.set(fr.role_id, byPos);
  }

  return roleRows.map((r) => {
    const id = String(r.id);
    return {
      id,
      externalSourceId: String(r.external_source_id),
      name: String(r.name),
      description: String(r.description),
      positionCategory: String(r.position_category),
      tacticalBehavior: String(r.tactical_behavior),
      attackingBehavior: String(r.attacking_behavior),
      defensiveBehavior: String(r.defensive_behavior),
      isFc26New: Boolean(r.is_fc26_new),
      verificationStatus: String(r.verification_status) as 'verified' | 'unverified',
      sourceReference: String(r.source_reference),
      eligiblePositions: posMap.get(id) ?? [],
      compatibleFocusesByPosition: focusMap.get(id) ?? {},
    };
  });
}

export function listCatalogFocuses(
  filters: { roleName?: string; positionCode?: string } = {},
  dbArg?: Database.Database
): CatalogFocus[] {
  const db = resolveDb(dbArg);

  if (filters.roleName?.trim() && filters.positionCode?.trim()) {
    const rows = db
      .prepare(`
        SELECT DISTINCT f.*,
          (SELECT COUNT(DISTINCT rfc2.role_id) FROM catalog_role_focus_compatibility rfc2 WHERE rfc2.focus_id = f.id) as roles_count
        FROM catalog_player_focuses f
        JOIN catalog_role_focus_compatibility rfc ON rfc.focus_id = f.id
        JOIN catalog_player_roles r ON r.id = rfc.role_id
        WHERE LOWER(r.name) = LOWER(?) AND rfc.position_code = ?
        ORDER BY f.name ASC
      `)
      .all(filters.roleName.trim(), filters.positionCode.trim().toUpperCase()) as Array<
      Record<string, unknown>
    >;
    return rows.map(mapFocusRow);
  }

  const rows = db
    .prepare(`
      SELECT f.*,
        (SELECT COUNT(DISTINCT rfc.role_id) FROM catalog_role_focus_compatibility rfc WHERE rfc.focus_id = f.id) as roles_count
      FROM catalog_player_focuses f
      ORDER BY f.name ASC
    `)
    .all() as Array<Record<string, unknown>>;

  return rows.map(mapFocusRow);
}

function mapFocusRow(r: Record<string, unknown>): CatalogFocus {
  return {
    id: String(r.id),
    externalSourceId: String(r.external_source_id),
    name: String(r.name),
    description: String(r.description),
    tacticalPurpose: String(r.tactical_purpose),
    isFc26Updated: Boolean(r.is_fc26_updated),
    verificationStatus: String(r.verification_status) as 'verified' | 'unverified',
    sourceReference: String(r.source_reference),
    compatibleRolesCount: Number(r.roles_count ?? 0),
  };
}

export function getRoleFocusCompatibilityMatrix(
  filters: { positionCode?: string; roleName?: string } = {},
  dbArg?: Database.Database
): CatalogCompatibilityRow[] {
  const db = resolveDb(dbArg);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.positionCode?.trim()) {
    conditions.push('rfc.position_code = ?');
    params.push(filters.positionCode.trim().toUpperCase());
  }
  if (filters.roleName?.trim()) {
    conditions.push('LOWER(r.name) = LOWER(?)');
    params.push(filters.roleName.trim());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`
      SELECT rfc.role_id, r.name as role_name, rfc.position_code,
             rfc.focus_id, f.name as focus_name, rfc.verification_status, rfc.evidence
      FROM catalog_role_focus_compatibility rfc
      JOIN catalog_player_roles r ON r.id = rfc.role_id
      JOIN catalog_player_focuses f ON f.id = rfc.focus_id
      ${where}
      ORDER BY rfc.position_code ASC, r.name ASC, f.name ASC
    `)
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    roleId: String(r.role_id),
    roleName: String(r.role_name),
    positionCode: String(r.position_code),
    focusId: String(r.focus_id),
    focusName: String(r.focus_name),
    verificationStatus: String(r.verification_status) as 'verified' | 'unverified',
    evidence: String(r.evidence),
  }));
}

export function exportCatalogDataset(
  datasetType: CatalogDatasetType,
  dbArg?: Database.Database
): Record<string, unknown> {
  const db = resolveDb(dbArg);
  const exportedAt = new Date().toISOString();

  switch (datasetType) {
    case 'nations':
      return { datasetType, exportedAt, records: listCatalogNations({}, db) };
    case 'leagues':
      return { datasetType, exportedAt, records: listCatalogLeagues({}, db) };
    case 'clubs':
      return { datasetType, exportedAt, records: searchCatalogClubs({ page: 1, pageSize: 5000 }, db).items };
    case 'players':
      return {
        datasetType,
        exportedAt,
        records: searchCatalogPlayers({ page: 1, pageSize: 5000 }, db).items,
      };
    case 'formations':
      return { datasetType, exportedAt, records: listCatalogFormations({}, db) };
    case 'positions':
      return { datasetType, exportedAt, records: listCatalogPositions(db) };
    case 'roles':
      return { datasetType, exportedAt, records: listCatalogRoles(undefined, db) };
    case 'focuses':
      return {
        datasetType,
        exportedAt,
        focuses: listCatalogFocuses({}, db),
        compatibility: getRoleFocusCompatibilityMatrix({}, db),
      };
    case 'sources':
      return { datasetType, exportedAt, sources: listCatalogSources(db) };
  }
}
