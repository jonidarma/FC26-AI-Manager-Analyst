import type {
  ImportFieldMappingInfo,
  ImportSchemaDiagnostics,
  PlayerSourceProfileId,
} from '../../../src/types/domain.ts';

export const EAFC26_DATAHUB_SOURCE_KEY = 'eafc26_datahub_player_data';

export const EAFC26_DATAHUB_SOURCE_METADATA = {
  sourceKey: EAFC26_DATAHUB_SOURCE_KEY,
  name: 'EAFC26 DataHub Player Dataset (Community / Kaggle-Derived)',
  url: 'https://github.com/ismailoksuz/EAFC26-DataHub',
  edition: 'FC 26',
  licenseNotes:
    'Community-distributed FC 26 player dataset derived from a Kaggle dataset (not an official EA SPORTS export). Check upstream Kaggle/repository license and usage terms before redistributing. External image/logo URLs are ignored per third-party media policy.',
} as const;

export const VALID_FC26_POSITIONS: ReadonlySet<string> = new Set([
  'GK',
  'CB',
  'LB',
  'RB',
  'LWB',
  'RWB',
  'CDM',
  'CM',
  'CAM',
  'LM',
  'RM',
  'LW',
  'RW',
  'CF',
  'ST',
]);

// Third-party media & profile URLs explicitly excluded from storage / hotlinking
export const IGNORED_MEDIA_COLUMNS: ReadonlySet<string> = new Set([
  'player_face_url',
  'club_logo_url',
  'club_flag_url',
  'nation_logo_url',
  'nation_flag_url',
  'league_logo_url',
  'player_url',
  'sofifa_url',
  'face_url',
  'logo_url',
  'flag_url',
  'avatar_url',
  'image_url',
]);

// Known flat extended attributes preserved in catalog_players.attributes_json
export const KNOWN_EXTENDED_ATTRIBUTE_COLUMNS: ReadonlySet<string> = new Set([
  // Attacking
  'attacking_crossing',
  'attacking_finishing',
  'attacking_heading_accuracy',
  'attacking_short_passing',
  'attacking_volleys',
  // Skill
  'skill_dribbling',
  'skill_curve',
  'skill_fk_accuracy',
  'skill_long_passing',
  'skill_ball_control',
  // Movement
  'movement_acceleration',
  'movement_sprint_speed',
  'movement_agility',
  'movement_reactions',
  'movement_balance',
  // Power
  'power_shot_power',
  'power_jumping',
  'power_stamina',
  'power_strength',
  'power_long_shots',
  // Mentality
  'mentality_aggression',
  'mentality_interceptions',
  'mentality_positioning',
  'mentality_vision',
  'mentality_penalties',
  'mentality_composure',
  // Defending
  'defending_marking_awareness',
  'defending_standing_tackle',
  'defending_sliding_tackle',
  // Goalkeeping
  'goalkeeping_diving',
  'goalkeeping_handling',
  'goalkeeping_kicking',
  'goalkeeping_positioning',
  'goalkeeping_reflexes',
  'goalkeeping_speed',
  // Traits, work rates, metadata
  'player_traits',
  'player_tags',
  'work_rate',
  'body_type',
  'real_face',
  'dob',
  'release_clause_eur',
  'international_reputation',
  'club_team_id',
  'club_position',
  'club_jersey_number',
  'club_loaned_from',
  'club_joined_date',
  'league_id',
  'league_level',
  'nationality_id',
  'nation_team_id',
  'nation_position',
  'nation_jersey_number',
  'fifa_version',
  'fifa_update',
  'fifa_update_date',
  'update_as_of',
  'gender',
  // Positional matrix ratings
  'ls',
  'st',
  'rs',
  'lw',
  'lf',
  'cf',
  'rf',
  'rw',
  'lam',
  'cam',
  'ram',
  'lm',
  'lcm',
  'cm',
  'rcm',
  'rm',
  'lwb',
  'ldm',
  'cdm',
  'rdm',
  'rwb',
  'lb',
  'lcb',
  'cb',
  'rcb',
  'rb',
  'gk',
]);

// Canonical columns handled directly by dedicated SQLite columns (not duplicated into attributes_json)
const CANONICAL_SOURCE_COLUMNS: ReadonlySet<string> = new Set([
  'externalsourceid',
  'external_source_id',
  'player_id',
  'id',
  'fullname',
  'full_name',
  'long_name',
  'name',
  'shortname',
  'short_name',
  'clubexternalid',
  'club_external_id',
  'leagueexternalid',
  'league_external_id',
  'nationexternalid',
  'nation_external_id',
  'clubname',
  'club_name',
  'club',
  'leaguename',
  'league_name',
  'league',
  'nationname',
  'nation_name',
  'nationality_name',
  'nation',
  'nationality',
  'primaryposition',
  'primary_position',
  'position',
  'secondarypositions',
  'secondary_positions',
  'alt_positions',
  'player_positions',
  'age',
  'overallrating',
  'overall_rating',
  'ovr',
  'overall',
  'potentialrating',
  'potential_rating',
  'pot',
  'potential',
  'growth',
  'pace',
  'pac',
  'shooting',
  'sho',
  'passing',
  'pas',
  'dribbling',
  'dri',
  'defending',
  'def',
  'physicality',
  'physic',
  'phy',
  'physical',
  'preferredfoot',
  'preferred_foot',
  'foot',
  'weakfoot',
  'weak_foot',
  'wf',
  'skillmoves',
  'skill_moves',
  'sm',
  'heightcm',
  'height_cm',
  'height',
  'weightkg',
  'weight_kg',
  'weight',
  'marketvalueeur',
  'market_value_eur',
  'value_eur',
  'value',
  'market_value',
  'wageeur',
  'wage_eur',
  'wage',
  'contractexpiry',
  'contract_expiry',
  'club_contract_valid_until_year',
  'contract',
  'attributes',
]);

// Canonical mapping table for preview diagnostics
const CANONICAL_MAPPING_SPEC: Array<{
  canonicalField: string;
  aliases: string[];
  dataHubNote?: (src: string) => string | undefined;
}> = [
  {
    canonicalField: 'external_source_id',
    aliases: ['external_source_id', 'externalSourceId', 'player_id', 'id'],
    dataHubNote: (src) =>
      src.toLowerCase() === 'player_id'
        ? 'Namespaced as eafc26_datahub_<player_id> for collision-free upserts'
        : undefined,
  },
  {
    canonicalField: 'full_name',
    aliases: ['full_name', 'fullName', 'long_name', 'name'],
    dataHubNote: (src) =>
      src.toLowerCase() === 'long_name'
        ? 'Mapped to full_name (falls back to short_name if blank)'
        : undefined,
  },
  {
    canonicalField: 'short_name',
    aliases: ['short_name', 'shortName'],
  },
  {
    canonicalField: 'primary_position + secondary_positions',
    aliases: ['player_positions'],
    dataHubNote: () =>
      'Split on comma/semicolon/pipe/slash: first valid FC26 code → primary_position, remainder → secondary_positions',
  },
  {
    canonicalField: 'primary_position',
    aliases: ['primary_position', 'primaryPosition', 'position'],
  },
  {
    canonicalField: 'secondary_positions',
    aliases: ['secondary_positions', 'secondaryPositions', 'alt_positions'],
  },
  {
    canonicalField: 'club_name',
    aliases: ['club_name', 'clubName', 'club'],
  },
  {
    canonicalField: 'league_name',
    aliases: ['league_name', 'leagueName', 'league'],
  },
  {
    canonicalField: 'nation_name',
    aliases: ['nation_name', 'nationName', 'nationality_name', 'nation', 'nationality'],
  },
  { canonicalField: 'age', aliases: ['age'] },
  { canonicalField: 'overall_rating', aliases: ['overall_rating', 'overallRating', 'overall', 'ovr'] },
  {
    canonicalField: 'potential_rating',
    aliases: ['potential_rating', 'potentialRating', 'potential', 'pot'],
  },
  { canonicalField: 'growth', aliases: ['growth'] },
  { canonicalField: 'pace', aliases: ['pace', 'pac'] },
  { canonicalField: 'shooting', aliases: ['shooting', 'sho'] },
  { canonicalField: 'passing', aliases: ['passing', 'pas'] },
  { canonicalField: 'dribbling', aliases: ['dribbling', 'dri'] },
  { canonicalField: 'defending', aliases: ['defending', 'def'] },
  { canonicalField: 'physicality', aliases: ['physicality', 'physic', 'phy', 'physical'] },
  { canonicalField: 'preferred_foot', aliases: ['preferred_foot', 'preferredFoot', 'foot'] },
  { canonicalField: 'weak_foot', aliases: ['weak_foot', 'weakFoot', 'wf'] },
  { canonicalField: 'skill_moves', aliases: ['skill_moves', 'skillMoves', 'sm'] },
  { canonicalField: 'height_cm', aliases: ['height_cm', 'heightCm', 'height'] },
  { canonicalField: 'weight_kg', aliases: ['weight_kg', 'weightKg', 'weight'] },
  {
    canonicalField: 'market_value_eur',
    aliases: ['market_value_eur', 'marketValueEur', 'value_eur', 'market_value', 'value'],
  },
  { canonicalField: 'wage_eur', aliases: ['wage_eur', 'wageEur', 'wage'] },
  {
    canonicalField: 'contract_expiry',
    aliases: ['contract_expiry', 'contractExpiry', 'club_contract_valid_until_year', 'contract'],
  },
];

const DATAHUB_SIGNATURE_HEADERS = [
  'long_name',
  'player_positions',
  'nationality_name',
  'physic',
  'value_eur',
  'club_contract_valid_until_year',
  'attacking_finishing',
  'movement_acceleration',
  'power_stamina',
  'mentality_vision',
];

const STANDARD_SIGNATURE_HEADERS = [
  'full_name',
  'fullname',
  'primary_position',
  'primaryposition',
  'overall_rating',
  'overallrating',
  'potential_rating',
  'potentialrating',
  'physicality',
  'market_value_eur',
  'marketvalueeur',
  'contract_expiry',
  'contractexpiry',
];

function isBlankOrSourceNull(val: unknown): boolean {
  if (val === undefined || val === null) return true;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return true;
    const lower = trimmed.toLowerCase();
    if (lower === 'null' || lower === 'nan' || lower === 'none' || lower === 'n/a') {
      return true;
    }
  }
  return false;
}

function toTrimmedString(val: unknown): string {
  if (isBlankOrSourceNull(val)) return '';
  return String(val).trim();
}

function toNullableInt(val: unknown, min?: number, max?: number): number | null {
  if (isBlankOrSourceNull(val)) return null;
  const cleaned = String(val).replace(/[€£$,\s]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  if (min !== undefined && rounded < min) return null;
  if (max !== undefined && rounded > max) return null;
  return rounded;
}

function normalizeContractExpiry(val: unknown): string | null {
  const s = toTrimmedString(val);
  if (!s) return null;
  // DataHub/pandas CSV exports often format integer years as "2028.0"
  const floatYearMatch = s.match(/^(\d{4})\.0+$/);
  if (floatYearMatch) return floatYearMatch[1];
  return s;
}

function normalizePreferredFoot(val: unknown): 'Right' | 'Left' | 'Both' | null {
  const s = toTrimmedString(val).toLowerCase();
  if (!s) return null;
  if (s === 'right' || s === 'r') return 'Right';
  if (s === 'left' || s === 'l') return 'Left';
  if (s === 'both' || s === 'either') return 'Both';
  return null;
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

function getField(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && !isBlankOrSourceNull(row[key])) {
      return row[key];
    }
  }
  return undefined;
}

export function parsePositionTokens(rawVal: unknown): {
  valid: string[];
  invalid: string[];
} {
  const tokens: string[] = [];
  if (Array.isArray(rawVal)) {
    for (const item of rawVal) {
      if (!isBlankOrSourceNull(item)) {
        tokens.push(String(item).trim().toUpperCase());
      }
    }
  } else if (typeof rawVal === 'string' && rawVal.trim()) {
    for (const part of rawVal.split(/[,;|/]+/)) {
      const cleaned = part.trim().toUpperCase();
      if (cleaned) tokens.push(cleaned);
    }
  }

  const valid: string[] = [];
  const invalid: string[] = [];
  const seenValid = new Set<string>();

  for (const token of tokens) {
    if (VALID_FC26_POSITIONS.has(token)) {
      if (!seenValid.has(token)) {
        seenValid.add(token);
        valid.push(token);
      }
    } else {
      invalid.push(token);
    }
  }

  return { valid, invalid };
}

export function extractPlayerPositions(raw: Record<string, unknown>): {
  primaryPosition: string | null;
  secondaryPositions: string[];
  errorMessage?: string;
} {
  const explicitPrimaryRaw = getField(raw, 'primaryPosition', 'primary_position', 'position');
  const explicitSecondaryRaw = getField(
    raw,
    'secondaryPositions',
    'secondary_positions',
    'alt_positions'
  );
  const combinedRaw = getField(raw, 'player_positions');

  // Prioritize explicit primary_position / secondary_positions when provided
  if (explicitPrimaryRaw !== undefined) {
    const primaryCode = toTrimmedString(explicitPrimaryRaw).toUpperCase();
    if (!VALID_FC26_POSITIONS.has(primaryCode)) {
      return {
        primaryPosition: null,
        secondaryPositions: [],
        errorMessage: `Invalid primary position "${primaryCode}".`,
      };
    }

    const secParsed = parsePositionTokens(explicitSecondaryRaw);
    const derivedCombined =
      explicitSecondaryRaw === undefined && combinedRaw !== undefined
        ? parsePositionTokens(combinedRaw).valid
        : [];
    const secondary = Array.from(
      new Set([...secParsed.valid, ...derivedCombined].filter((p) => p !== primaryCode))
    );

    return {
      primaryPosition: primaryCode,
      secondaryPositions: secondary,
    };
  }

  // Otherwise extract from DataHub player_positions (e.g. "LW, LM", "CM, LM, CAM")
  if (combinedRaw !== undefined) {
    const parsed = parsePositionTokens(combinedRaw);
    if (parsed.valid.length === 0) {
      const rawDisplay = toTrimmedString(combinedRaw);
      const invalidInfo =
        parsed.invalid.length > 0 ? ` Unrecognized code(s): ${parsed.invalid.join(', ')}.` : '';
      return {
        primaryPosition: null,
        secondaryPositions: [],
        errorMessage: `No valid FC 26 position could be extracted from player_positions "${rawDisplay}".${invalidInfo}`,
      };
    }

    const [primary, ...rest] = parsed.valid;
    const extraSec = explicitSecondaryRaw !== undefined ? parsePositionTokens(explicitSecondaryRaw).valid : [];
    const secondary = Array.from(new Set([...rest, ...extraSec].filter((p) => p !== primary)));

    return {
      primaryPosition: primary,
      secondaryPositions: secondary,
    };
  }

  return {
    primaryPosition: null,
    secondaryPositions: [],
    errorMessage:
      'Player position is required (expected primary_position, position, or player_positions).',
  };
}

function normalizeExtendedValue(val: unknown): unknown {
  if (isBlankOrSourceNull(val)) return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    // Preserve pure numeric values (integers & decimals) as JSON numbers, except leading-zero strings
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num)) return num;
    }
    return trimmed;
  }
  return val;
}

export function extractExtendedPlayerAttributes(
  raw: Record<string, unknown>
): Record<string, unknown> | null {
  const preserved: Record<string, unknown> = {};
  let hasAnyKey = false;

  // 1. Preserve nested raw.attributes if supplied (backward compatible with JSON format)
  if (raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes)) {
    for (const [k, v] of Object.entries(raw.attributes as Record<string, unknown>)) {
      if (IGNORED_MEDIA_COLUMNS.has(k.toLowerCase())) continue;
      preserved[k] = normalizeExtendedValue(v);
      hasAnyKey = true;
    }
  }

  // 2. Preserve all flat non-canonical, non-media columns (e.g. 90+ DataHub attributes)
  for (const [key, val] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (CANONICAL_SOURCE_COLUMNS.has(lower)) continue;
    if (IGNORED_MEDIA_COLUMNS.has(lower)) continue;
    preserved[key] = normalizeExtendedValue(val);
    hasAnyKey = true;
  }

  return hasAnyKey ? preserved : null;
}

export function detectPlayerSourceProfile(
  columns: string[],
  format: 'csv' | 'json'
): ImportSchemaDiagnostics {
  const uniqueCols = Array.from(new Set(columns.map((c) => c.trim()).filter(Boolean)));
  const lowerToOriginal = new Map<string, string>();
  for (const col of uniqueCols) {
    if (!lowerToOriginal.has(col.toLowerCase())) {
      lowerToOriginal.set(col.toLowerCase(), col);
    }
  }

  let dataHubScore = 0;
  for (const sig of DATAHUB_SIGNATURE_HEADERS) {
    if (lowerToOriginal.has(sig)) dataHubScore += 1;
  }

  let standardScore = 0;
  for (const sig of STANDARD_SIGNATURE_HEADERS) {
    if (lowerToOriginal.has(sig)) standardScore += 1;
  }

  const hasLongName = lowerToOriginal.has('long_name');
  const hasPlayerPositions = lowerToOriginal.has('player_positions');
  const hasStandardFullName =
    lowerToOriginal.has('full_name') || lowerToOriginal.has('fullname');
  const hasStandardPrimaryPos =
    lowerToOriginal.has('primary_position') || lowerToOriginal.has('primaryposition');

  let profileId: PlayerSourceProfileId;
  let profileLabel: string;
  let detectedSourceKey: string | null = null;

  const isDataHub =
    (hasLongName || hasPlayerPositions || dataHubScore >= 3) &&
    !(hasStandardFullName && hasStandardPrimaryPos && standardScore > dataHubScore);

  const isStandard =
    !isDataHub &&
    (hasStandardFullName ||
      hasStandardPrimaryPos ||
      lowerToOriginal.has('name') ||
      lowerToOriginal.has('position') ||
      standardScore >= 2);

  if (isDataHub) {
    profileId = format === 'csv' ? 'eafc26_datahub_csv' : 'eafc26_datahub_json';
    profileLabel =
      format === 'csv'
        ? 'EAFC26 DataHub / SoFIFA-style CSV'
        : 'EAFC26 DataHub / SoFIFA-style JSON';
    detectedSourceKey = EAFC26_DATAHUB_SOURCE_KEY;
  } else if (isStandard) {
    profileId = format === 'csv' ? 'fc26_standard_csv' : 'fc26_standard_json';
    profileLabel =
      format === 'csv' ? 'FC26 AI Manager Standard CSV' : 'FC26 AI Manager Standard JSON';
  } else {
    profileId = 'unknown_schema';
    profileLabel = format === 'csv' ? 'Unrecognized Player CSV Schema' : 'Unrecognized Player JSON Schema';
  }

  const recognizedMappings: ImportFieldMappingInfo[] = [];
  const mappedLowerCols = new Set<string>();

  for (const spec of CANONICAL_MAPPING_SPEC) {
    for (const alias of spec.aliases) {
      const orig = lowerToOriginal.get(alias.toLowerCase());
      if (orig && !mappedLowerCols.has(orig.toLowerCase())) {
        mappedLowerCols.add(orig.toLowerCase());
        recognizedMappings.push({
          sourceColumn: orig,
          targetField: spec.canonicalField,
          note: isDataHub && spec.dataHubNote ? spec.dataHubNote(orig) : undefined,
        });
        break;
      }
    }
  }

  const nameSource =
    lowerToOriginal.get('full_name') ??
    lowerToOriginal.get('fullname') ??
    lowerToOriginal.get('long_name') ??
    lowerToOriginal.get('name') ??
    lowerToOriginal.get('short_name') ??
    lowerToOriginal.get('shortname') ??
    null;

  const positionSource =
    lowerToOriginal.get('primary_position') ??
    lowerToOriginal.get('primaryposition') ??
    lowerToOriginal.get('position') ??
    lowerToOriginal.get('player_positions') ??
    null;

  const extendedAttributeColumns: string[] = [];
  const ignoredMediaColumns: string[] = [];
  const unrecognizedColumns: string[] = [];

  for (const col of uniqueCols) {
    const lower = col.toLowerCase();
    if (mappedLowerCols.has(lower) || CANONICAL_SOURCE_COLUMNS.has(lower)) {
      continue;
    }
    if (IGNORED_MEDIA_COLUMNS.has(lower)) {
      ignoredMediaColumns.push(col);
      continue;
    }
    if (KNOWN_EXTENDED_ATTRIBUTE_COLUMNS.has(lower)) {
      extendedAttributeColumns.push(col);
      continue;
    }
    unrecognizedColumns.push(col);
  }

  const schemaWarnings: string[] = [];
  if (uniqueCols.length === 0) {
    schemaWarnings.push('No column headers were detected in the uploaded payload.');
  } else {
    if (!nameSource) {
      schemaWarnings.push(
        'Missing required player name column: expected "full_name", "name", or DataHub "long_name" / "short_name".'
      );
    }
    if (!positionSource) {
      schemaWarnings.push(
        'Missing required player position column: expected "primary_position", "position", or DataHub "player_positions".'
      );
    }
    if (profileId === 'unknown_schema' && nameSource && positionSource) {
      schemaWarnings.push(
        'Columns do not match a named source preset; attempting canonical fallback mapping.'
      );
    }
  }

  return {
    profileId,
    profileLabel,
    detectedSourceKey,
    columnCount: uniqueCols.length,
    detectedColumns: uniqueCols,
    recognizedMappings,
    requiredFieldsMapped: {
      name: Boolean(nameSource),
      position: Boolean(positionSource),
      nameSource,
      positionSource,
    },
    extendedAttributeColumns,
    ignoredMediaColumns,
    unrecognizedColumns,
    schemaWarnings,
  };
}

export type PlayerNormalizationResult =
  | {
      ok: true;
      key: string;
      data: Record<string, unknown>;
    }
  | {
      ok: false;
      field: string;
      message: string;
    };

export function normalizePlayerRecord(
  raw: Record<string, unknown>,
  profile: ImportSchemaDiagnostics
): PlayerNormalizationResult {
  const isDataHub =
    profile.profileId === 'eafc26_datahub_csv' || profile.profileId === 'eafc26_datahub_json';

  // 1. Name normalization: long_name preferred for DataHub, short_name fallback
  const shortName = toTrimmedString(getField(raw, 'shortName', 'short_name'));
  const fullName = isDataHub
    ? toTrimmedString(getField(raw, 'long_name', 'fullName', 'full_name', 'name')) || shortName
    : toTrimmedString(getField(raw, 'fullName', 'full_name', 'long_name', 'name')) || shortName;

  if (!fullName) {
    return {
      ok: false,
      field: isDataHub ? 'long_name/short_name' : 'full_name',
      message: isDataHub
        ? 'Player name is required (both long_name and short_name are empty).'
        : 'Player full_name is required.',
    };
  }

  // 2. Position normalization (prioritizes explicit primary_position, else parses player_positions)
  const posResult = extractPlayerPositions(raw);
  if (!posResult.primaryPosition) {
    return {
      ok: false,
      field: raw.player_positions !== undefined ? 'player_positions' : 'primary_position',
      message: posResult.errorMessage ?? 'Valid FC 26 player position is required.',
    };
  }

  const clubNameRaw = toTrimmedString(getField(raw, 'clubName', 'club_name', 'club'));
  const leagueNameRaw = toTrimmedString(getField(raw, 'leagueName', 'league_name', 'league'));
  const nationNameRaw = toTrimmedString(
    getField(raw, 'nationName', 'nation_name', 'nationality_name', 'nation', 'nationality')
  );

  // 3. Stable external_source_id normalization (namespaced for DataHub player_id)
  const explicitExtId = toTrimmedString(getField(raw, 'externalSourceId', 'external_source_id'));
  const rawPlayerId = toTrimmedString(getField(raw, 'player_id', 'id'));

  let externalSourceId: string;
  if (explicitExtId) {
    externalSourceId = explicitExtId;
  } else if (isDataHub && rawPlayerId) {
    externalSourceId = rawPlayerId.startsWith('eafc26_datahub_')
      ? rawPlayerId
      : `eafc26_datahub_${rawPlayerId}`;
  } else if (rawPlayerId) {
    externalSourceId = rawPlayerId;
  } else {
    externalSourceId = `player_${toSlug(fullName)}_${toSlug(clubNameRaw || 'free')}_${posResult.primaryPosition.toLowerCase()}`;
  }

  // 4. Ratings, face stats, physicals, financials, contract
  const ovr = toNullableInt(
    getField(raw, 'overallRating', 'overall_rating', 'overall', 'ovr'),
    1,
    99
  );
  const pot = toNullableInt(
    getField(raw, 'potentialRating', 'potential_rating', 'potential', 'pot'),
    1,
    99
  );
  const explicitGrowth = toNullableInt(getField(raw, 'growth'), -30, 50);
  const growth =
    explicitGrowth !== null ? explicitGrowth : ovr !== null && pot !== null ? pot - ovr : null;

  // 5. Extended attributes preserved in attributes_json (excluding canonical & media URLs)
  const extraAttrs = extractExtendedPlayerAttributes(raw);

  return {
    ok: true,
    key: externalSourceId,
    data: {
      externalSourceId,
      fullName,
      shortName,
      clubExternalId: toTrimmedString(getField(raw, 'clubExternalId', 'club_external_id')),
      leagueExternalId: toTrimmedString(getField(raw, 'leagueExternalId', 'league_external_id')),
      nationExternalId: toTrimmedString(getField(raw, 'nationExternalId', 'nation_external_id')),
      clubNameRaw,
      leagueNameRaw,
      nationNameRaw,
      primaryPosition: posResult.primaryPosition,
      secondaryPositions: posResult.secondaryPositions,
      age: toNullableInt(getField(raw, 'age'), 14, 55),
      overallRating: ovr,
      potentialRating: pot,
      growth,
      pace: toNullableInt(getField(raw, 'pace', 'pac'), 1, 99),
      shooting: toNullableInt(getField(raw, 'shooting', 'sho'), 1, 99),
      passing: toNullableInt(getField(raw, 'passing', 'pas'), 1, 99),
      dribbling: toNullableInt(getField(raw, 'dribbling', 'dri'), 1, 99),
      defending: toNullableInt(getField(raw, 'defending', 'def'), 1, 99),
      physicality: toNullableInt(
        getField(raw, 'physicality', 'physic', 'phy', 'physical'),
        1,
        99
      ),
      preferredFoot: normalizePreferredFoot(
        getField(raw, 'preferredFoot', 'preferred_foot', 'foot')
      ),
      weakFoot: toNullableInt(getField(raw, 'weakFoot', 'weak_foot', 'wf'), 1, 5),
      skillMoves: toNullableInt(getField(raw, 'skillMoves', 'skill_moves', 'sm'), 1, 5),
      heightCm: toNullableInt(getField(raw, 'heightCm', 'height_cm', 'height'), 130, 230),
      weightKg: toNullableInt(getField(raw, 'weightKg', 'weight_kg', 'weight'), 40, 140),
      marketValueEur: toNullableInt(
        getField(raw, 'marketValueEur', 'market_value_eur', 'value_eur', 'market_value', 'value'),
        0
      ),
      wageEur: toNullableInt(getField(raw, 'wageEur', 'wage_eur', 'wage'), 0),
      contractExpiry: normalizeContractExpiry(
        getField(raw, 'contractExpiry', 'contract_expiry', 'club_contract_valid_until_year', 'contract')
      ),
      attributesJson: extraAttrs ? JSON.stringify(extraAttrs) : null,
      extendedAttributeCount: extraAttrs ? Object.keys(extraAttrs).length : 0,
    },
  };
}
