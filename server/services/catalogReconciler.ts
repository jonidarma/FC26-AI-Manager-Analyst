import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type {
  CatalogCoverageReport,
  CatalogReconcilePreview,
  CatalogReconcileResult,
} from '../../src/types/domain.ts';
import { getDb } from '../db/database.ts';
import {
  EAFC26_DATAHUB_SOURCE_KEY,
  EAFC26_DATAHUB_SOURCE_METADATA,
} from './playerImportAdapters/eafc26DataHub.ts';

interface LeagueMetadataDef {
  leagueId: number;
  canonicalName: string;
  countryName: string;
  region: string;
  tier: number;
  category: 'mens' | 'womens';
  modeAvailability: string;
}

/**
 * Verified EA SPORTS FC 26 league registry keyed strictly by numeric EA league_id
 * to eliminate cross-country name collisions (e.g., England Premier League [13] vs
 * Ukraine Premier League [332], Germany Bundesliga [19] vs Austria Bundesliga [80],
 * Italy Serie A [31] vs Ecuador Serie A [2018], Super League [63, 189, 2012, 2149]).
 */
const VERIFIED_LEAGUE_METADATA: Record<number, LeagueMetadataDef> = {
  1: { leagueId: 1, canonicalName: '3F Superliga', countryName: 'Denmark', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  4: { leagueId: 4, canonicalName: 'Jupiler Pro League', countryName: 'Belgium', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  7: { leagueId: 7, canonicalName: 'Campeonato Brasileiro Série A', countryName: 'Brazil', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  10: { leagueId: 10, canonicalName: 'Eredivisie', countryName: 'Netherlands', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  13: { leagueId: 13, canonicalName: 'Premier League', countryName: 'England', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  14: { leagueId: 14, canonicalName: 'EFL Championship', countryName: 'England', region: 'Europe (UEFA)', tier: 2, category: 'mens', modeAvailability: 'career_mode' },
  16: { leagueId: 16, canonicalName: "Ligue 1 McDonald's", countryName: 'France', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  17: { leagueId: 17, canonicalName: 'Ligue 2 BKT', countryName: 'France', region: 'Europe (UEFA)', tier: 2, category: 'mens', modeAvailability: 'career_mode' },
  19: { leagueId: 19, canonicalName: 'Bundesliga', countryName: 'Germany', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  20: { leagueId: 20, canonicalName: '2. Bundesliga', countryName: 'Germany', region: 'Europe (UEFA)', tier: 2, category: 'mens', modeAvailability: 'career_mode' },
  31: { leagueId: 31, canonicalName: 'Serie A Enilive', countryName: 'Italy', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  32: { leagueId: 32, canonicalName: 'Serie BKT', countryName: 'Italy', region: 'Europe (UEFA)', tier: 2, category: 'mens', modeAvailability: 'career_mode' },
  39: { leagueId: 39, canonicalName: 'Major League Soccer', countryName: 'United States', region: 'North America (CONCACAF)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  41: { leagueId: 41, canonicalName: 'Eliteserien', countryName: 'Norway', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  50: { leagueId: 50, canonicalName: 'Scottish Premiership', countryName: 'Scotland', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  53: { leagueId: 53, canonicalName: 'LALIGA EA SPORTS', countryName: 'Spain', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  54: { leagueId: 54, canonicalName: 'LALIGA HYPERMOTION', countryName: 'Spain', region: 'Europe (UEFA)', tier: 2, category: 'mens', modeAvailability: 'career_mode' },
  56: { leagueId: 56, canonicalName: 'Allsvenskan', countryName: 'Sweden', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  60: { leagueId: 60, canonicalName: 'EFL League One', countryName: 'England', region: 'Europe (UEFA)', tier: 3, category: 'mens', modeAvailability: 'career_mode' },
  61: { leagueId: 61, canonicalName: 'EFL League Two', countryName: 'England', region: 'Europe (UEFA)', tier: 4, category: 'mens', modeAvailability: 'career_mode' },
  63: { leagueId: 63, canonicalName: 'Super League Greece', countryName: 'Greece', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'rest_of_world' },
  64: { leagueId: 64, canonicalName: 'Nemzeti Bajnokság I', countryName: 'Hungary', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'rest_of_world' },
  65: { leagueId: 65, canonicalName: 'SSE Airtricity Premier Division', countryName: 'Republic of Ireland', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  66: { leagueId: 66, canonicalName: 'PKO BP Ekstraklasa', countryName: 'Poland', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  68: { leagueId: 68, canonicalName: 'Trendyol Süper Lig', countryName: 'Türkiye', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  80: { leagueId: 80, canonicalName: 'Österreichische Fußball-Bundesliga', countryName: 'Austria', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  83: { leagueId: 83, canonicalName: 'K League 1', countryName: 'Korea Republic', region: 'Asia (AFC)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  189: { leagueId: 189, canonicalName: 'Credit Suisse Super League', countryName: 'Switzerland', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  308: { leagueId: 308, canonicalName: 'Liga Portugal', countryName: 'Portugal', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  313: { leagueId: 313, canonicalName: 'Azerbaijan Premyer Liqa', countryName: 'Azerbaijan', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'rest_of_world' },
  317: { leagueId: 317, canonicalName: 'SuperSport HNL', countryName: 'Croatia', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'rest_of_world' },
  318: { leagueId: 318, canonicalName: 'Cyprus 1. Division', countryName: 'Cyprus', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'rest_of_world' },
  319: { leagueId: 319, canonicalName: 'Chance Liga (Czech First League)', countryName: 'Czech Republic', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'rest_of_world' },
  322: { leagueId: 322, canonicalName: 'Veikkausliiga', countryName: 'Finland', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'rest_of_world' },
  330: { leagueId: 330, canonicalName: 'SuperLiga Romania', countryName: 'Romania', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  332: { leagueId: 332, canonicalName: 'Ukrainian Premier League', countryName: 'Ukraine', region: 'Europe (UEFA)', tier: 1, category: 'mens', modeAvailability: 'rest_of_world' },
  335: { leagueId: 335, canonicalName: 'Campeonato Nacional (Chile)', countryName: 'Chile', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'conmebol_cups' },
  336: { leagueId: 336, canonicalName: 'Categoría Primera A (Colombia)', countryName: 'Colombia', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'conmebol_cups' },
  337: { leagueId: 337, canonicalName: 'División Profesional (Paraguay)', countryName: 'Paraguay', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'conmebol_cups' },
  338: { leagueId: 338, canonicalName: 'Primera División (Uruguay)', countryName: 'Uruguay', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'conmebol_cups' },
  350: { leagueId: 350, canonicalName: 'ROSHN Saudi League', countryName: 'Saudi Arabia', region: 'Asia (AFC)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  351: { leagueId: 351, canonicalName: 'Isuzu UTE A-League Men', countryName: 'Australia', region: 'Oceania / AFC', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  353: { leagueId: 353, canonicalName: 'Liga Profesional de Fútbol', countryName: 'Argentina', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  2012: { leagueId: 2012, canonicalName: 'Chinese Super League', countryName: 'China PR', region: 'Asia (AFC)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
  2013: { leagueId: 2013, canonicalName: 'UAE Pro League', countryName: 'United Arab Emirates', region: 'Asia (AFC)', tier: 1, category: 'mens', modeAvailability: 'rest_of_world' },
  2017: { leagueId: 2017, canonicalName: 'División Profesional (Bolivia)', countryName: 'Bolivia', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'conmebol_cups' },
  2018: { leagueId: 2018, canonicalName: 'LigaPro Serie A (Ecuador)', countryName: 'Ecuador', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'conmebol_cups' },
  2019: { leagueId: 2019, canonicalName: 'Liga FUTVE (Venezuela)', countryName: 'Venezuela', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'conmebol_cups' },
  2020: { leagueId: 2020, canonicalName: 'Liga 1 (Peru)', countryName: 'Peru', region: 'South America (CONMEBOL)', tier: 1, category: 'mens', modeAvailability: 'conmebol_cups' },
  2076: { leagueId: 2076, canonicalName: '3. Liga', countryName: 'Germany', region: 'Europe (UEFA)', tier: 3, category: 'mens', modeAvailability: 'career_mode' },
  2149: { leagueId: 2149, canonicalName: 'Indian Super League', countryName: 'India', region: 'Asia (AFC)', tier: 1, category: 'mens', modeAvailability: 'career_mode' },
};

/**
 * Verified crosswalk from baseline men's catalog_clubs.external_source_id -> EA DataHub numeric club_team_id
 * so existing starter baseline clubs merge seamlessly without duplicates and preserve existing Career Mode UUIDs.
 */
const BASELINE_CLUB_EXT_TO_DATAHUB_ID: Record<string, string> = {
  club_roma_m: '52',
  club_atletico_m: '240',
  club_galatasaray_m: '325',
  club_intermiami_m: '112893',
  club_lille_m: '65',
  club_rangers_m: '86',
  club_betis_m: '449',
  club_leeds_m: '8',
  club_sunderland_m: '106',
  club_acmilan_m: '47',
};

/**
 * Verified EA SPORTS FC 26 unlicensed / alternate club aliases keyed by EA numeric club_team_id.
 */
const VERIFIED_CLUB_ALIASES_BY_TEAM_ID: Record<
  string,
  Array<{ aliasName: string; aliasType: 'unlicensed_name' | 'alternate_name' | 'short_name' }>
> = {
  '44': [
    { aliasName: 'Lombardia FC', aliasType: 'unlicensed_name' },
    { aliasName: 'Inter Milan', aliasType: 'alternate_name' },
    { aliasName: 'FC Internazionale Milano', aliasType: 'alternate_name' },
  ],
  '47': [
    { aliasName: 'Milano FC', aliasType: 'unlicensed_name' },
    { aliasName: 'Milan', aliasType: 'short_name' },
  ],
  '39': [
    { aliasName: 'Bergamo Calcio', aliasType: 'unlicensed_name' },
    { aliasName: 'Atalanta BC', aliasType: 'alternate_name' },
  ],
  '46': [
    { aliasName: 'Latium', aliasType: 'unlicensed_name' },
    { aliasName: 'SS Lazio', aliasType: 'alternate_name' },
  ],
  '52': [
    { aliasName: 'AS Roma', aliasType: 'alternate_name' },
  ],
  '240': [
    { aliasName: 'Atlético de Madrid', aliasType: 'alternate_name' },
    { aliasName: 'Atletico Madrid', aliasType: 'alternate_name' },
  ],
  '325': [
    { aliasName: 'Galatasaray', aliasType: 'short_name' },
  ],
  '112893': [
    { aliasName: 'Inter Miami CF', aliasType: 'alternate_name' },
  ],
  '65': [
    { aliasName: 'LOSC Lille', aliasType: 'alternate_name' },
  ],
  '86': [
    { aliasName: 'Rangers', aliasType: 'short_name' },
  ],
  '449': [
    { aliasName: 'Real Betis', aliasType: 'short_name' },
  ],
  '7': [
    { aliasName: 'Everton FC', aliasType: 'alternate_name' },
  ],
};

function resolveDb(db?: Database.Database): Database.Database {
  return db ?? getDb();
}

function toSlug(val: string): string {
  return val
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeMatchKey(val: string): string {
  return val
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function deriveShortName(clubName: string): string {
  const words = clubName
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return clubName.slice(0, 3).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  const significant = words.filter(
    (w) => !['FC', 'CF', 'SC', 'AC', 'AS', 'SS', 'CD', 'CA', 'UD', 'SD', 'RC', 'SV', 'TSV', 'VFB', 'VFL', 'DE', 'LA', 'EL'].includes(w.toUpperCase())
  );
  const pool = significant.length > 0 ? significant : words;
  if (pool.length === 1) return pool[0].slice(0, 3).toUpperCase();
  return pool
    .slice(0, 3)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

interface ExtractedNation {
  nationalityId: string;
  nationNameRaw: string;
  playerCount: number;
}

interface ExtractedLeague {
  leagueId: number;
  leagueNameRaw: string;
  leagueLevel: number | null;
  clubCount: number;
  playerCount: number;
}

interface ExtractedClub {
  clubTeamId: string;
  clubNameRaw: string;
  leagueId: number | null;
  leagueNameRaw: string;
  playerCount: number;
}

function extractEntitiesFromCatalogPlayers(db: Database.Database): {
  totalPlayers: number;
  freeAgentPlayers: number;
  datasetVersion: string | null;
  nations: ExtractedNation[];
  leagues: ExtractedLeague[];
  clubs: ExtractedClub[];
} {
  const totalPlayers = (
    db.prepare('SELECT COUNT(*) as c FROM catalog_players').get() as { c: number }
  ).c;

  const freeAgentPlayers = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM catalog_players
         WHERE TRIM(COALESCE(club_name_raw, '')) = ''
           AND TRIM(COALESCE(json_extract(attributes_json, '$.club_team_id'), '')) = ''`
      )
      .get() as { c: number }
  ).c;

  const versionRow = db
    .prepare(
      `SELECT
         json_extract(attributes_json, '$.fifa_version') as fv,
         json_extract(attributes_json, '$.fifa_update') as fu,
         json_extract(attributes_json, '$.fifa_update_date') as fud
       FROM catalog_players
       WHERE attributes_json IS NOT NULL
       LIMIT 1`
    )
    .get() as { fv: unknown; fu: unknown; fud: unknown } | undefined;

  const datasetVersion = versionRow?.fv
    ? `FC${versionRow.fv}-update${versionRow.fu ?? '0'}${versionRow.fud ? `-${versionRow.fud}` : ''}`
    : null;

  const nationRows = db
    .prepare(
      `SELECT
         CAST(json_extract(attributes_json, '$.nationality_id') AS TEXT) as nid,
         TRIM(nation_name_raw) as nation_name_raw,
         COUNT(*) as player_count
       FROM catalog_players
       WHERE TRIM(COALESCE(nation_name_raw, '')) != ''
       GROUP BY nid, TRIM(nation_name_raw)
       ORDER BY player_count DESC`
    )
    .all() as Array<{ nid: string | null; nation_name_raw: string; player_count: number }>;

  const nations: ExtractedNation[] = [];
  const seenNationByName = new Set<string>();
  for (const r of nationRows) {
    const key = normalizeMatchKey(r.nation_name_raw);
    if (!key || seenNationByName.has(key)) continue;
    seenNationByName.add(key);
    nations.push({
      nationalityId: r.nid?.trim() || `name_${toSlug(r.nation_name_raw)}`,
      nationNameRaw: r.nation_name_raw,
      playerCount: Number(r.player_count),
    });
  }

  const leagueRows = db
    .prepare(
      `SELECT
         CAST(json_extract(attributes_json, '$.league_id') AS INTEGER) as lid,
         TRIM(league_name_raw) as league_name_raw,
         MIN(CAST(json_extract(attributes_json, '$.league_level') AS INTEGER)) as lvl,
         COUNT(DISTINCT json_extract(attributes_json, '$.club_team_id')) as club_count,
         COUNT(*) as player_count
       FROM catalog_players
       WHERE json_extract(attributes_json, '$.league_id') IS NOT NULL
         AND TRIM(COALESCE(league_name_raw, '')) != ''
       GROUP BY lid
       ORDER BY lid ASC`
    )
    .all() as Array<{
    lid: number;
    league_name_raw: string;
    lvl: number | null;
    club_count: number;
    player_count: number;
  }>;

  const leagues: ExtractedLeague[] = leagueRows
    .filter((r) => Number.isFinite(r.lid) && r.lid > 0)
    .map((r) => ({
      leagueId: Number(r.lid),
      leagueNameRaw: r.league_name_raw,
      leagueLevel: r.lvl !== null && Number.isFinite(Number(r.lvl)) ? Number(r.lvl) : null,
      clubCount: Number(r.club_count),
      playerCount: Number(r.player_count),
    }));

  const clubRows = db
    .prepare(
      `SELECT
         CAST(json_extract(attributes_json, '$.club_team_id') AS TEXT) as tid,
         TRIM(club_name_raw) as club_name_raw,
         CAST(json_extract(attributes_json, '$.league_id') AS INTEGER) as lid,
         TRIM(league_name_raw) as league_name_raw,
         COUNT(*) as player_count
       FROM catalog_players
       WHERE json_extract(attributes_json, '$.club_team_id') IS NOT NULL
         AND TRIM(COALESCE(club_name_raw, '')) != ''
       GROUP BY tid
       ORDER BY player_count DESC, club_name_raw ASC`
    )
    .all() as Array<{
    tid: string;
    club_name_raw: string;
    lid: number | null;
    league_name_raw: string;
    player_count: number;
  }>;

  const clubs: ExtractedClub[] = clubRows
    .filter((r) => Boolean(r.tid?.trim()) && Boolean(r.club_name_raw))
    .map((r) => ({
      clubTeamId: r.tid.trim(),
      clubNameRaw: r.club_name_raw,
      leagueId: r.lid !== null && Number.isFinite(Number(r.lid)) ? Number(r.lid) : null,
      leagueNameRaw: r.league_name_raw ?? '',
      playerCount: Number(r.player_count),
    }));

  return {
    totalPlayers,
    freeAgentPlayers,
    datasetVersion,
    nations,
    leagues,
    clubs,
  };
}

function ensureDataHubSource(db: Database.Database, now: string): string {
  const existing = db
    .prepare('SELECT id FROM catalog_sources WHERE source_key = ?')
    .get(EAFC26_DATAHUB_SOURCE_KEY) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO catalog_sources (id, source_key, name, url, edition, license_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    EAFC26_DATAHUB_SOURCE_METADATA.sourceKey,
    EAFC26_DATAHUB_SOURCE_METADATA.name,
    EAFC26_DATAHUB_SOURCE_METADATA.url,
    EAFC26_DATAHUB_SOURCE_METADATA.edition,
    EAFC26_DATAHUB_SOURCE_METADATA.licenseNotes,
    now,
    now
  );
  return id;
}

export function previewCatalogReconciliationFromPlayers(
  dbArg?: Database.Database
): CatalogReconcilePreview {
  const db = resolveDb(dbArg);
  const extracted = extractEntitiesFromCatalogPlayers(db);
  const warnings: string[] = [];

  if (extracted.totalPlayers === 0) {
    warnings.push(
      'No players are currently imported in catalog_players. Import an EAFC26 DataHub players.csv file first before reconciling clubs and leagues.'
    );
  }

  // Existing nations lookup
  const existingNations = db
    .prepare('SELECT id, external_source_id, external_nation_id, source_name, display_name FROM catalog_nations')
    .all() as Array<{
    id: string;
    external_source_id: string;
    external_nation_id: string | null;
    source_name: string;
    display_name: string;
  }>;
  const nationByKey = new Map<string, string>();
  const nationByExtId = new Map<string, string>();
  for (const n of existingNations) {
    nationByKey.set(normalizeMatchKey(n.display_name), n.id);
    nationByKey.set(normalizeMatchKey(n.source_name), n.id);
    if (n.external_nation_id) nationByExtId.set(n.external_nation_id, n.id);
  }

  let nationsToInsert = 0;
  let nationsToUpdate = 0;
  for (const n of extracted.nations) {
    const matched =
      nationByExtId.get(n.nationalityId) ?? nationByKey.get(normalizeMatchKey(n.nationNameRaw));
    if (matched) nationsToUpdate += 1;
    else nationsToInsert += 1;
  }

  // Existing leagues lookup by league_<id>
  const existingLeagues = db
    .prepare('SELECT id, external_source_id, name, category FROM catalog_leagues')
    .all() as Array<{ id: string; external_source_id: string; name: string; category: string }>;
  const leagueByExtId = new Map<string, string>();
  for (const l of existingLeagues) {
    leagueByExtId.set(l.external_source_id, l.id);
  }

  let leaguesToInsert = 0;
  let leaguesToUpdate = 0;
  for (const l of extracted.leagues) {
    if (leagueByExtId.has(`league_${l.leagueId}`)) leaguesToUpdate += 1;
    else leaguesToInsert += 1;
  }

  // Existing men's clubs lookup
  const existingMensClubs = db
    .prepare(
      `SELECT c.id, c.external_source_id, c.external_team_id, c.name, c.league_id, l.external_source_id as league_ext_id
       FROM catalog_clubs c
       LEFT JOIN catalog_leagues l ON l.id = c.league_id
       WHERE c.team_category = 'mens'`
    )
    .all() as Array<{
    id: string;
    external_source_id: string;
    external_team_id: string | null;
    name: string;
    league_id: string | null;
    league_ext_id: string | null;
  }>;

  const clubByTeamId = new Map<string, string>();
  const clubByLeagueAndName = new Map<string, string>();
  for (const c of existingMensClubs) {
    if (c.external_team_id) {
      clubByTeamId.set(c.external_team_id, c.id);
    }
    const mappedTid = BASELINE_CLUB_EXT_TO_DATAHUB_ID[c.external_source_id];
    if (mappedTid) {
      clubByTeamId.set(mappedTid, c.id);
    }
    if (c.league_ext_id) {
      clubByLeagueAndName.set(`${c.league_ext_id}::${normalizeMatchKey(c.name)}`, c.id);
    }
  }

  let clubsToInsert = 0;
  let clubsToUpdate = 0;
  let clubAliasesToInsert = 0;
  const sampleNewClubs: CatalogReconcilePreview['sampleNewClubs'] = [];

  for (const c of extracted.clubs) {
    const leagueExtKey = c.leagueId ? `league_${c.leagueId}` : '';
    const matched =
      clubByTeamId.get(c.clubTeamId) ??
      (leagueExtKey
        ? clubByLeagueAndName.get(`${leagueExtKey}::${normalizeMatchKey(c.clubNameRaw)}`)
        : undefined);
    if (matched) {
      clubsToUpdate += 1;
    } else {
      clubsToInsert += 1;
      if (sampleNewClubs.length < 15) {
        const meta = c.leagueId ? VERIFIED_LEAGUE_METADATA[c.leagueId] : undefined;
        sampleNewClubs.push({
          externalTeamId: c.clubTeamId,
          name: c.clubNameRaw,
          leagueName: meta?.canonicalName ?? c.leagueNameRaw,
          playerCount: c.playerCount,
        });
      }
    }
    const verifiedAliases = VERIFIED_CLUB_ALIASES_BY_TEAM_ID[c.clubTeamId];
    if (verifiedAliases) clubAliasesToInsert += verifiedAliases.length;
  }

  const playersToRelinkClub = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM catalog_players
         WHERE club_id IS NULL
           AND json_extract(attributes_json, '$.club_team_id') IS NOT NULL
           AND TRIM(COALESCE(club_name_raw, '')) != ''`
      )
      .get() as { c: number }
  ).c;

  const playersToRelinkLeague = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM catalog_players
         WHERE league_id IS NULL
           AND json_extract(attributes_json, '$.league_id') IS NOT NULL
           AND TRIM(COALESCE(league_name_raw, '')) != ''`
      )
      .get() as { c: number }
  ).c;

  const playersToRelinkNation = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM catalog_players
         WHERE nation_id IS NULL
           AND TRIM(COALESCE(nation_name_raw, '')) != ''`
      )
      .get() as { c: number }
  ).c;

  const premierLeagueClubs = extracted.clubs.filter((c) => c.leagueId === 13);
  const evertonFoundInSource = premierLeagueClubs.some(
    (c) => c.clubTeamId === '7' || normalizeMatchKey(c.clubNameRaw) === 'everton'
  );

  warnings.push(
    'Source coverage note: EAFC26 DataHub players.csv covers men\'s club football across 51 competitions (including UEFA, CONMEBOL, CONCACAF, AFC, OFC, and Rest of World). Existing women\'s leagues and clubs are preserved separately; women\'s player rosters and national team squads require separate licensed dataset imports.'
  );

  return {
    sourcePlayerCount: extracted.totalPlayers,
    distinctNationsInPlayers: extracted.nations.length,
    distinctLeaguesInPlayers: extracted.leagues.length,
    distinctClubsInPlayers: extracted.clubs.length,
    freeAgentPlayers: extracted.freeAgentPlayers,
    nationsToInsert,
    nationsToUpdate,
    leaguesToInsert,
    leaguesToUpdate,
    clubsToInsert,
    clubsToUpdate,
    clubAliasesToInsert,
    playersToRelinkClub,
    playersToRelinkLeague,
    playersToRelinkNation,
    premierLeagueClubsAfter: premierLeagueClubs.length,
    evertonFoundInSource,
    sampleNewClubs,
    warnings,
  };
}

export function executeCatalogReconciliationFromPlayers(
  dbArg?: Database.Database
): CatalogReconcileResult {
  const db = resolveDb(dbArg);
  const now = new Date().toISOString();
  const extracted = extractEntitiesFromCatalogPlayers(db);
  const runId = crypto.randomUUID();

  let nationsInserted = 0;
  let nationsUpdated = 0;
  let leaguesInserted = 0;
  let leaguesUpdated = 0;
  let clubsInserted = 0;
  let clubsUpdated = 0;
  let clubAliasesInserted = 0;
  let playersRelinkedClub = 0;
  let playersRelinkedLeague = 0;
  let playersRelinkedNation = 0;

  const tx = db.transaction(() => {
    const sourceId = ensureDataHubSource(db, now);
    const datasetVersion = extracted.datasetVersion ?? 'FC26-reconciled';

    // Record audit import run up-front (referenced by FK import_run_id on new rows)
    db.prepare(`
      INSERT INTO catalog_import_runs (
        id, dataset_type, source_id, file_name, format, dataset_version, completeness,
        checksum, mode, status, total_rows, inserted_count, updated_count, rejected_count,
        errors_json, started_at, completed_at
      ) VALUES (?, 'clubs', ?, 'catalog_players_reconciliation', 'json', ?, 'user_imported', ?, 'upsert', 'completed', ?, 0, 0, 0, '[]', ?, ?)
    `).run(
      runId,
      sourceId,
      datasetVersion,
      crypto.createHash('sha256').update(`reconcile:${extracted.totalPlayers}:${extracted.clubs.length}:${now}`).digest('hex'),
      extracted.clubs.length,
      now,
      now
    );

    // --------------------------------------------------------
    // STEP 1: Reconcile Nations (preserve all existing nation UUIDs)
    // --------------------------------------------------------
    const nationIdByNormName = new Map<string, string>();
    const nationIdByExternalNationId = new Map<string, string>();
    const existingNations = db
      .prepare('SELECT id, external_source_id, external_nation_id, source_name, display_name FROM catalog_nations')
      .all() as Array<{
      id: string;
      external_source_id: string;
      external_nation_id: string | null;
      source_name: string;
      display_name: string;
    }>;

    for (const n of existingNations) {
      nationIdByNormName.set(normalizeMatchKey(n.display_name), n.id);
      nationIdByNormName.set(normalizeMatchKey(n.source_name), n.id);
      if (n.external_nation_id) nationIdByExternalNationId.set(n.external_nation_id, n.id);
    }

    const updateNationExt = db.prepare(
      'UPDATE catalog_nations SET external_nation_id = COALESCE(external_nation_id, ?), updated_at = ? WHERE id = ?'
    );
    const insertNation = db.prepare(`
      INSERT INTO catalog_nations (
        id, external_source_id, external_nation_id, source_name, display_name,
        iso_code, region, source_id, import_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?)
    `);

    for (const n of extracted.nations) {
      const normName = normalizeMatchKey(n.nationNameRaw);
      let nationId = nationIdByExternalNationId.get(n.nationalityId) ?? nationIdByNormName.get(normName);
      if (nationId) {
        updateNationExt.run(n.nationalityId, now, nationId);
        nationsUpdated += 1;
      } else {
        nationId = crypto.randomUUID();
        const extSrcId = `nation_${toSlug(n.nationNameRaw) || n.nationalityId}`;
        insertNation.run(
          nationId,
          extSrcId,
          n.nationalityId,
          n.nationNameRaw,
          n.nationNameRaw,
          sourceId,
          runId,
          now,
          now
        );
        nationsInserted += 1;
      }
      nationIdByNormName.set(normName, nationId);
      nationIdByExternalNationId.set(n.nationalityId, nationId);
    }

    // Also ensure country names referenced by VERIFIED_LEAGUE_METADATA exist in nation map
    const resolveCountryNationId = (countryName: string): string | null => {
      const direct = nationIdByNormName.get(normalizeMatchKey(countryName));
      if (direct) return direct;
      if (countryName === 'Türkiye') return nationIdByNormName.get('turkey') ?? null;
      if (countryName === 'Czech Republic') return nationIdByNormName.get('czechia') ?? null;
      return null;
    };

    // --------------------------------------------------------
    // STEP 2: Reconcile Leagues by numeric EA league_id (never by name alone!)
    // --------------------------------------------------------
    const leagueIdByNumericId = new Map<number, string>();
    const existingLeagues = db
      .prepare('SELECT id, external_source_id, name, country_name, region, category FROM catalog_leagues')
      .all() as Array<{
      id: string;
      external_source_id: string;
      name: string;
      country_name: string;
      region: string | null;
      category: string;
    }>;

    const leagueByExtId = new Map<string, string>();
    for (const l of existingLeagues) {
      leagueByExtId.set(l.external_source_id, l.id);
      const match = /^league_(\d+)$/.exec(l.external_source_id);
      if (match) {
        leagueIdByNumericId.set(Number(match[1]), l.id);
      }
    }

    // Backfill region metadata on existing women's/baseline leagues
    db.prepare(`
      UPDATE catalog_leagues
      SET region = CASE
        WHEN category = 'womens' AND country_name IN ('England', 'Spain', 'France', 'Germany', 'Italy') THEN 'Europe (UEFA)'
        WHEN category = 'womens' AND country_name = 'United States' THEN 'North America (CONCACAF)'
        ELSE region
      END
      WHERE TRIM(COALESCE(region, '')) = ''
    `).run();

    const updateLeague = db.prepare(`
      UPDATE catalog_leagues
      SET name = COALESCE(NULLIF(TRIM(name), ''), ?),
          country_id = COALESCE(country_id, ?),
          country_name = CASE WHEN TRIM(COALESCE(country_name, '')) = '' THEN ? ELSE country_name END,
          region = CASE WHEN TRIM(COALESCE(region, '')) = '' THEN ? ELSE region END,
          tier = COALESCE(tier, ?),
          mode_availability = COALESCE(NULLIF(TRIM(mode_availability), ''), ?),
          dataset_version = ?,
          verification_status = 'verified',
          updated_at = ?
      WHERE id = ?
    `);

    const insertLeague = db.prepare(`
      INSERT INTO catalog_leagues (
        id, external_source_id, name, country_id, country_name, region, tier,
        category, mode_availability, dataset_version, verification_status,
        source_id, import_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'mens', ?, ?, 'verified', ?, ?, ?, ?)
    `);

    for (const l of extracted.leagues) {
      const extId = `league_${l.leagueId}`;
      const meta = VERIFIED_LEAGUE_METADATA[l.leagueId];
      const canonicalName = meta?.canonicalName ?? l.leagueNameRaw;
      const countryName = meta?.countryName ?? '';
      const region = meta?.region ?? 'Rest of World';
      const tier = meta?.tier ?? l.leagueLevel ?? 1;
      const modeAvailability = meta?.modeAvailability ?? 'career_mode';
      const countryId = countryName ? resolveCountryNationId(countryName) : null;

      let leagueDbId = leagueByExtId.get(extId);
      if (leagueDbId) {
        updateLeague.run(
          canonicalName,
          countryId,
          countryName,
          region,
          tier,
          modeAvailability,
          datasetVersion,
          now,
          leagueDbId
        );
        leaguesUpdated += 1;
      } else {
        leagueDbId = crypto.randomUUID();
        insertLeague.run(
          leagueDbId,
          extId,
          canonicalName,
          countryId,
          countryName,
          region,
          tier,
          modeAvailability,
          datasetVersion,
          sourceId,
          runId,
          now,
          now
        );
        leaguesInserted += 1;
      }
      leagueByExtId.set(extId, leagueDbId);
      leagueIdByNumericId.set(l.leagueId, leagueDbId);
    }

    // --------------------------------------------------------
    // STEP 3: Reconcile Men's Clubs by stable external_team_id (keep Women's strictly separate!)
    // --------------------------------------------------------
    const existingMensClubs = db
      .prepare(
        `SELECT c.id, c.external_source_id, c.external_team_id, c.name, c.league_id, l.external_source_id as league_ext_id
         FROM catalog_clubs c
         LEFT JOIN catalog_leagues l ON l.id = c.league_id
         WHERE c.team_category = 'mens'`
      )
      .all() as Array<{
      id: string;
      external_source_id: string;
      external_team_id: string | null;
      name: string;
      league_id: string | null;
      league_ext_id: string | null;
    }>;

    const clubIdByTeamId = new Map<string, string>();
    const clubIdByLeagueAndNormName = new Map<string, string>();
    const clubNameById = new Map<string, string>();

    for (const c of existingMensClubs) {
      clubNameById.set(c.id, c.name);
      if (c.external_team_id) {
        clubIdByTeamId.set(c.external_team_id, c.id);
      }
      const mappedTid = BASELINE_CLUB_EXT_TO_DATAHUB_ID[c.external_source_id];
      if (mappedTid) {
        clubIdByTeamId.set(mappedTid, c.id);
      }
      if (c.league_ext_id) {
        clubIdByLeagueAndNormName.set(`${c.league_ext_id}::${normalizeMatchKey(c.name)}`, c.id);
      }
    }

    const updateClub = db.prepare(`
      UPDATE catalog_clubs
      SET source_namespace = 'eafc26_datahub',
          external_team_id = ?,
          canonical_name = COALESCE(NULLIF(TRIM(canonical_name), ''), ?),
          display_name = COALESCE(NULLIF(TRIM(display_name), ''), name),
          league_id = COALESCE(?, league_id),
          nation_id = COALESCE(?, nation_id),
          region = CASE WHEN TRIM(COALESCE(region, '')) = '' THEN ? ELSE region END,
          mode_availability = ?,
          source_url = ?,
          dataset_version = ?,
          imported_at = ?,
          verification_status = 'verified',
          updated_at = ?
      WHERE id = ?
    `);

    const insertClub = db.prepare(`
      INSERT INTO catalog_clubs (
        id, external_source_id, source_namespace, external_team_id,
        name, canonical_name, display_name, short_name, aliases_json,
        league_id, nation_id, region, team_category, mode_availability,
        source_url, dataset_version, imported_at, verification_status,
        source_id, import_run_id, created_at, updated_at
      ) VALUES (?, ?, 'eafc26_datahub', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mens', ?, ?, ?, ?, 'verified', ?, ?, ?, ?)
    `);

    const insertAlias = db.prepare(`
      INSERT OR IGNORE INTO catalog_club_aliases (
        id, club_id, alias_name, alias_type, verification_status, created_at
      ) VALUES (?, ?, ?, ?, 'verified', ?)
    `);

    const updateClubAliasesJson = db.prepare(
      'UPDATE catalog_clubs SET aliases_json = ? WHERE id = ?'
    );

    for (const c of extracted.clubs) {
      const leagueExtKey = c.leagueId ? `league_${c.leagueId}` : '';
      const leagueDbId = c.leagueId ? leagueIdByNumericId.get(c.leagueId) ?? null : null;
      const meta = c.leagueId ? VERIFIED_LEAGUE_METADATA[c.leagueId] : undefined;
      const nationDbId = meta?.countryName ? resolveCountryNationId(meta.countryName) : null;
      const region = meta?.region ?? 'Rest of World';
      const modeAvailability = meta?.modeAvailability ?? 'career_mode';

      let clubDbId =
        clubIdByTeamId.get(c.clubTeamId) ??
        (leagueExtKey
          ? clubIdByLeagueAndNormName.get(`${leagueExtKey}::${normalizeMatchKey(c.clubNameRaw)}`)
          : undefined);

      const aliasEntries: Array<{
        aliasName: string;
        aliasType: 'unlicensed_name' | 'short_name' | 'alternate_name' | 'datahub_name' | 'historical_name';
      }> = [...(VERIFIED_CLUB_ALIASES_BY_TEAM_ID[c.clubTeamId] ?? [])];

      if (clubDbId) {
        const existingName = clubNameById.get(clubDbId) ?? c.clubNameRaw;
        if (normalizeMatchKey(existingName) !== normalizeMatchKey(c.clubNameRaw)) {
          aliasEntries.push({ aliasName: c.clubNameRaw, aliasType: 'datahub_name' });
        }
        updateClub.run(
          c.clubTeamId,
          c.clubNameRaw,
          leagueDbId,
          nationDbId,
          region,
          modeAvailability,
          EAFC26_DATAHUB_SOURCE_METADATA.url,
          datasetVersion,
          now,
          now,
          clubDbId
        );
        clubsUpdated += 1;
      } else {
        clubDbId = crypto.randomUUID();
        const extSourceId = `club_dh_${c.clubTeamId}`;
        const shortName = deriveShortName(c.clubNameRaw);
        insertClub.run(
          clubDbId,
          extSourceId,
          c.clubTeamId,
          c.clubNameRaw,
          c.clubNameRaw,
          c.clubNameRaw,
          shortName,
          JSON.stringify(aliasEntries.map((a) => a.aliasName)),
          leagueDbId,
          nationDbId,
          region,
          modeAvailability,
          EAFC26_DATAHUB_SOURCE_METADATA.url,
          datasetVersion,
          now,
          sourceId,
          runId,
          now,
          now
        );
        clubsInserted += 1;
      }

      clubIdByTeamId.set(c.clubTeamId, clubDbId);

      if (aliasEntries.length > 0) {
        for (const alias of aliasEntries) {
          const res = insertAlias.run(
            crypto.randomUUID(),
            clubDbId,
            alias.aliasName,
            alias.aliasType,
            now
          );
          if (res.changes > 0) clubAliasesInserted += 1;
        }
        const allAliases = (
          db
            .prepare('SELECT alias_name FROM catalog_club_aliases WHERE club_id = ? ORDER BY alias_name ASC')
            .all(clubDbId) as Array<{ alias_name: string }>
        ).map((r) => r.alias_name);
        updateClubAliasesJson.run(JSON.stringify(allAliases), clubDbId);
      }
    }

    // --------------------------------------------------------
    // STEP 4: Non-destructively relink all catalog_players (NEVER touch id or attributes_json!)
    // --------------------------------------------------------
    const playerRows = db
      .prepare(
        `SELECT
           id, club_id, league_id, nation_id,
           CAST(json_extract(attributes_json, '$.club_team_id') AS TEXT) as tid,
           CAST(json_extract(attributes_json, '$.league_id') AS INTEGER) as lid,
           CAST(json_extract(attributes_json, '$.nationality_id') AS TEXT) as nid,
           nation_name_raw
         FROM catalog_players`
      )
      .all() as Array<{
      id: string;
      club_id: string | null;
      league_id: string | null;
      nation_id: string | null;
      tid: string | null;
      lid: number | null;
      nid: string | null;
      nation_name_raw: string;
    }>;

    const updatePlayerLinks = db.prepare(
      'UPDATE catalog_players SET club_id = ?, league_id = ?, nation_id = ?, updated_at = ? WHERE id = ?'
    );

    for (const p of playerRows) {
      const nextClubId = p.tid?.trim() ? (clubIdByTeamId.get(p.tid.trim()) ?? p.club_id) : p.club_id;
      const nextLeagueId =
        p.lid !== null && Number.isFinite(Number(p.lid))
          ? (leagueIdByNumericId.get(Number(p.lid)) ?? p.league_id)
          : p.league_id;
      const nextNationId =
        (p.nid?.trim() ? nationIdByExternalNationId.get(p.nid.trim()) : undefined) ??
        (p.nation_name_raw?.trim()
          ? nationIdByNormName.get(normalizeMatchKey(p.nation_name_raw))
          : undefined) ??
        p.nation_id;

      const clubChanged = nextClubId !== p.club_id;
      const leagueChanged = nextLeagueId !== p.league_id;
      const nationChanged = nextNationId !== p.nation_id;

      if (clubChanged || leagueChanged || nationChanged) {
        updatePlayerLinks.run(nextClubId, nextLeagueId, nextNationId, now, p.id);
        if (clubChanged && nextClubId) playersRelinkedClub += 1;
        if (leagueChanged && nextLeagueId) playersRelinkedLeague += 1;
        if (nationChanged && nextNationId) playersRelinkedNation += 1;
      }
    }

    // Update audit run counts
    db.prepare(
      'UPDATE catalog_import_runs SET inserted_count = ?, updated_count = ?, completed_at = ? WHERE id = ?'
    ).run(clubsInserted, clubsUpdated, now, runId);
  });

  tx();

  const coverageAfter = getCatalogCoverageReport(db);

  return {
    runId,
    executedAt: now,
    nationsInserted,
    nationsUpdated,
    leaguesInserted,
    leaguesUpdated,
    clubsInserted,
    clubsUpdated,
    clubAliasesInserted,
    playersRelinkedClub,
    playersRelinkedLeague,
    playersRelinkedNation,
    playersPreservedCount: extracted.totalPlayers,
    coverageAfter,
  };
}

export function getCatalogCoverageReport(dbArg?: Database.Database): CatalogCoverageReport {
  const db = resolveDb(dbArg);
  const countOf = (sql: string): number =>
    (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;

  const nations = countOf('SELECT COUNT(*) as c FROM catalog_nations');
  const leagues = countOf('SELECT COUNT(*) as c FROM catalog_leagues');
  const mensLeagues = countOf("SELECT COUNT(*) as c FROM catalog_leagues WHERE category = 'mens'");
  const womensLeagues = countOf("SELECT COUNT(*) as c FROM catalog_leagues WHERE category = 'womens'");
  const clubs = countOf('SELECT COUNT(*) as c FROM catalog_clubs');
  const mensClubs = countOf("SELECT COUNT(*) as c FROM catalog_clubs WHERE team_category = 'mens'");
  const womensClubs = countOf("SELECT COUNT(*) as c FROM catalog_clubs WHERE team_category = 'womens'");
  const clubAliases = countOf('SELECT COUNT(*) as c FROM catalog_club_aliases');
  const players = countOf('SELECT COUNT(*) as c FROM catalog_players');
  const linkedPlayersToClub = countOf('SELECT COUNT(*) as c FROM catalog_players WHERE club_id IS NOT NULL');
  const linkedPlayersToLeague = countOf('SELECT COUNT(*) as c FROM catalog_players WHERE league_id IS NOT NULL');
  const linkedPlayersToNation = countOf('SELECT COUNT(*) as c FROM catalog_players WHERE nation_id IS NOT NULL');
  const freeAgentPlayers = countOf(
    `SELECT COUNT(*) as c FROM catalog_players
     WHERE club_id IS NULL
       AND TRIM(COALESCE(club_name_raw, '')) = ''`
  );
  const unresolvedClubPlayers = countOf(
    `SELECT COUNT(*) as c FROM catalog_players
     WHERE club_id IS NULL
       AND TRIM(COALESCE(club_name_raw, '')) != ''`
  );
  const unresolvedLeaguePlayers = countOf(
    `SELECT COUNT(*) as c FROM catalog_players
     WHERE league_id IS NULL
       AND TRIM(COALESCE(league_name_raw, '')) != ''`
  );
  const unresolvedNationPlayers = countOf(
    `SELECT COUNT(*) as c FROM catalog_players
     WHERE nation_id IS NULL
       AND TRIM(COALESCE(nation_name_raw, '')) != ''`
  );

  // Premier League (league_13) 20/20 verification + Everton check
  const plRow = db
    .prepare("SELECT id, name FROM catalog_leagues WHERE external_source_id = 'league_13' LIMIT 1")
    .get() as { id: string; name: string } | undefined;

  const plClubs = plRow
    ? (db
        .prepare(
          `SELECT c.id, c.name, c.external_team_id,
             (SELECT COUNT(*) FROM catalog_players p WHERE p.club_id = c.id) as player_count
           FROM catalog_clubs c
           WHERE c.league_id = ? AND c.team_category = 'mens'
           ORDER BY c.name ASC`
        )
        .all(plRow.id) as Array<{
        id: string;
        name: string;
        external_team_id: string | null;
        player_count: number;
      }>)
    : [];

  const everton = plClubs.find(
    (c) => c.external_team_id === '7' || normalizeMatchKey(c.name) === 'everton'
  );

  // Coverage by region
  const regionRows = db
    .prepare(
      `SELECT
         COALESCE(NULLIF(TRIM(l.region), ''), 'Other / Unclassified') as region,
         COUNT(DISTINCT l.id) as league_count,
         (SELECT COUNT(*) FROM catalog_clubs c2 JOIN catalog_leagues l2 ON l2.id = c2.league_id
          WHERE COALESCE(NULLIF(TRIM(l2.region), ''), 'Other / Unclassified') = COALESCE(NULLIF(TRIM(l.region), ''), 'Other / Unclassified')) as club_count,
         (SELECT COUNT(*) FROM catalog_players p2 JOIN catalog_leagues l3 ON l3.id = p2.league_id
          WHERE COALESCE(NULLIF(TRIM(l3.region), ''), 'Other / Unclassified') = COALESCE(NULLIF(TRIM(l.region), ''), 'Other / Unclassified')) as player_count
       FROM catalog_leagues l
       GROUP BY COALESCE(NULLIF(TRIM(l.region), ''), 'Other / Unclassified')
       ORDER BY club_count DESC, region ASC`
    )
    .all() as Array<{ region: string; league_count: number; club_count: number; player_count: number }>;

  // Per-league breakdown
  const leagueRows = db
    .prepare(
      `SELECT
         l.id, l.external_source_id, l.name, l.country_name,
         COALESCE(NULLIF(TRIM(l.region), ''), 'Other / Unclassified') as region,
         l.category, l.tier,
         (SELECT COUNT(*) FROM catalog_clubs c WHERE c.league_id = l.id) as club_count,
         (SELECT COUNT(*) FROM catalog_players p WHERE p.league_id = l.id) as player_count
       FROM catalog_leagues l
       ORDER BY club_count DESC, l.name ASC`
    )
    .all() as Array<{
    id: string;
    external_source_id: string;
    name: string;
    country_name: string;
    region: string;
    category: 'mens' | 'womens' | 'mixed';
    tier: number | null;
    club_count: number;
    player_count: number;
  }>;

  // Unresolved club mappings report
  const unresolvedClubMappings = (
    db
      .prepare(
        `SELECT
           CAST(json_extract(attributes_json, '$.club_team_id') AS TEXT) as club_team_id,
           TRIM(club_name_raw) as club_name_raw,
           CAST(json_extract(attributes_json, '$.league_id') AS TEXT) as league_id_raw,
           TRIM(league_name_raw) as league_name_raw,
           COUNT(*) as player_count
         FROM catalog_players
         WHERE club_id IS NULL AND TRIM(COALESCE(club_name_raw, '')) != ''
         GROUP BY club_team_id, TRIM(club_name_raw), league_id_raw, TRIM(league_name_raw)
         ORDER BY player_count DESC
         LIMIT 50`
      )
      .all() as Array<{
      club_team_id: string | null;
      club_name_raw: string;
      league_id_raw: string | null;
      league_name_raw: string;
      player_count: number;
    }>
  ).map((r) => ({
    clubTeamId: r.club_team_id,
    clubNameRaw: r.club_name_raw,
    leagueIdRaw: r.league_id_raw,
    leagueNameRaw: r.league_name_raw,
    playerCount: Number(r.player_count),
  }));

  // Duplicate check: same club name inside the same league and same team_category
  const duplicateClubChecks = (
    db
      .prepare(
        `SELECT c.name, l.name as league_name, COUNT(*) as cnt
         FROM catalog_clubs c
         LEFT JOIN catalog_leagues l ON l.id = c.league_id
         GROUP BY LOWER(c.name), c.league_id, c.team_category
         HAVING COUNT(*) > 1`
      )
      .all() as Array<{ name: string; league_name: string | null; cnt: number }>
  ).map((r) => ({
    name: r.name,
    leagueName: r.league_name,
    count: Number(r.cnt),
  }));

  const datasetVersionRow = db
    .prepare(
      `SELECT dataset_version FROM catalog_leagues WHERE dataset_version IS NOT NULL ORDER BY updated_at DESC LIMIT 1`
    )
    .get() as { dataset_version: string } | undefined;

  const sourceCoverageNotices: string[] = [
    `Active dataset covers ${mensLeagues} men's competitions (${mensClubs} men's clubs) and ${womensLeagues} women's baseline competitions (${womensClubs} women's clubs) kept strictly separate.`,
    `EAFC26 DataHub players.csv is a men's club dataset; women's player rosters and national team squads are not present in players.csv and require separate verified datasets if needed.`,
    `${freeAgentPlayers} player(s) in catalog_players have no club affiliation (Free Agents) and are intentionally left unlinked rather than force-matched.`,
  ];

  return {
    generatedAt: new Date().toISOString(),
    datasetVersion: datasetVersionRow?.dataset_version ?? null,
    counts: {
      nations,
      leagues,
      mensLeagues,
      womensLeagues,
      clubs,
      mensClubs,
      womensClubs,
      clubAliases,
      players,
      linkedPlayersToClub,
      linkedPlayersToLeague,
      linkedPlayersToNation,
      freeAgentPlayers,
      unresolvedClubPlayers,
      unresolvedLeaguePlayers,
      unresolvedNationPlayers,
    },
    premierLeagueVerification: {
      leagueId: plRow?.id ?? null,
      leagueName: plRow?.name ?? null,
      clubCount: plClubs.length,
      expectedClubCount: 20,
      complete20Of20: plClubs.length === 20,
      evertonPresent: Boolean(everton),
      evertonClubId: everton?.id ?? null,
      evertonPlayerCount: everton ? Number(everton.player_count) : 0,
      clubs: plClubs.map((c) => ({
        id: c.id,
        name: c.name,
        externalTeamId: c.external_team_id,
        playerCount: Number(c.player_count),
      })),
    },
    coverageByRegion: regionRows.map((r) => ({
      region: r.region,
      leagueCount: Number(r.league_count),
      clubCount: Number(r.club_count),
      playerCount: Number(r.player_count),
    })),
    leagueBreakdown: leagueRows.map((r) => ({
      leagueId: r.id,
      externalSourceId: r.external_source_id,
      name: r.name,
      countryName: r.country_name,
      region: r.region,
      category: r.category,
      tier: r.tier === null ? null : Number(r.tier),
      clubCount: Number(r.club_count),
      playerCount: Number(r.player_count),
    })),
    unresolvedClubMappings,
    duplicateClubChecks,
    sourceCoverageNotices,
  };
}
