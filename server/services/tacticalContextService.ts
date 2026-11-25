import type Database from 'better-sqlite3';
import type {
  AiMatchTacticalContext,
  MatchTacticalSnapshotAssignment,
  PlayerRoleAssignment,
  RoleFocusValidationResult,
} from '../../src/types/domain.ts';
import {
  CANONICAL_FC26_POSITIONS,
  normalizeFormationSlotPosition,
} from '../../src/utils/formationPositions.ts';
import { resolvePlayerDisplayName } from '../../src/utils/playerDisplayName.ts';
import { getDb } from '../db/database.ts';
import {
  getCatalogFormationByIdOrName,
  getCatalogPlayerById,
  getRoleFocusCompatibilityMatrix,
  listCatalogFocuses,
  listCatalogRoles,
} from './catalogRepository.ts';

function resolveDb(db?: Database.Database): Database.Database {
  return db ?? getDb();
}

export function validatePlayerRoleFocus(
  positionCode: string,
  roleName: string,
  focusName: string,
  dbArg?: Database.Database
): RoleFocusValidationResult {
  const db = resolveDb(dbArg);
  const normalized = normalizeFormationSlotPosition(positionCode);
  if (!normalized.ok) {
    return {
      valid: false,
      reason:
        normalized.error ??
        `Position "${positionCode.trim().toUpperCase()}" is not a recognized FC 26 position code. Valid codes: ${CANONICAL_FC26_POSITIONS.join(', ')}.`,
      allowedRoles: [],
      allowedFocuses: [],
    };
  }

  const pos = normalized.canonicalPosition;
  const role = roleName.trim();
  const focus = focusName.trim();

  const rolesForPos = listCatalogRoles(pos, db);
  const allowedRoles = rolesForPos.map((r) => r.name);

  if (rolesForPos.length === 0) {
    return {
      valid: false,
      reason: `Position "${pos}" has no configured FC 26 player roles in the tactical catalog.`,
      allowedRoles: [],
      allowedFocuses: [],
    };
  }

  if (!role) {
    return { valid: true, allowedRoles, allowedFocuses: [] };
  }

  const matchedRole = rolesForPos.find((r) => r.name.toLowerCase() === role.toLowerCase());
  if (!matchedRole) {
    return {
      valid: false,
      reason: `Role "${role}" is not valid for position "${pos}". Allowed roles: ${allowedRoles.join(', ')}.`,
      allowedRoles,
      allowedFocuses: [],
    };
  }

  const allowedFocuses = listCatalogFocuses({ roleName: matchedRole.name, positionCode: pos }, db).map(
    (f) => f.name
  );

  if (!focus) {
    return { valid: true, allowedRoles, allowedFocuses };
  }

  const matchedFocus = allowedFocuses.find((f) => f.toLowerCase() === focus.toLowerCase());
  if (!matchedFocus) {
    return {
      valid: false,
      reason: `Focus "${focus}" is not compatible with ${matchedRole.name} at ${pos}. Allowed focuses: ${allowedFocuses.join(', ')}.`,
      allowedRoles,
      allowedFocuses,
    };
  }

  return { valid: true, allowedRoles, allowedFocuses };
}

export function buildAiMatchTacticalContext(
  matchId: string,
  dbArg?: Database.Database
): AiMatchTacticalContext | null {
  const db = resolveDb(dbArg);
  const matchRow = db
    .prepare(`
      SELECT m.*, c.name as club_name, o.name as opponent_name,
             cp.primary_tactical_vision_key, cp.alternative_tactical_vision_key,
             cp.tactical_flexibility, cp.tactical_philosophy_notes
      FROM matches m
      JOIN clubs c ON c.id = m.club_id
      JOIN opponents o ON o.id = m.opponent_id
      LEFT JOIN career_profiles cp ON cp.id = m.career_profile_id
      WHERE m.id = ?
    `)
    .get(matchId) as Record<string, unknown> | undefined;

  if (!matchRow) return null;

  // Prefer immutable Match Tactical Snapshot (latest in_match_adjustment if present, else pre_match)
  const snapshotRow = db
    .prepare(
      `SELECT * FROM match_tactical_snapshots
       WHERE match_id = ?
       ORDER BY CASE snapshot_type WHEN 'in_match_adjustment' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`
    )
    .get(matchId) as Record<string, unknown> | undefined;

  let formationName = String(matchRow.starting_formation);
  let buildUpStyle = 'Balanced';
  let defensiveApproach = 'Balanced';
  let defensiveLineHeight = 55;
  let tacticalVisionKey = 'unspecified';
  let benchIdsFromSnapshot: string[] = [];
  let assignments: Array<{
    slotIndex: number;
    slotId?: string | null;
    positionCode: string;
    playerId: string | null;
    playerName: string | null;
    role: string;
    focus: string;
  }> = [];

  if (snapshotRow) {
    formationName = String(snapshotRow.formation_name || formationName);
    buildUpStyle = String(snapshotRow.build_up_style || 'Balanced');
    defensiveApproach = String(snapshotRow.defensive_approach || 'Balanced');
    defensiveLineHeight = Number(snapshotRow.defensive_line_height ?? 55);
    tacticalVisionKey = String(snapshotRow.tactical_vision_key || 'unspecified');
    try {
      const parsed = JSON.parse(String(snapshotRow.assignments_json || '[]')) as MatchTacticalSnapshotAssignment[];
      assignments = parsed.map((a, idx) => ({
        slotIndex: typeof a.slotOrder === 'number' ? a.slotOrder : idx,
        slotId: a.slotId,
        positionCode: a.positionCode,
        playerId: a.playerId,
        playerName: a.playerDisplayName ?? a.playerFullName ?? null,
        role: a.role,
        focus: a.focus,
      }));
    } catch {
      assignments = [];
    }
    try {
      const parsedBench = JSON.parse(String(snapshotRow.bench_json || '[]')) as Array<{ playerId?: string }>;
      benchIdsFromSnapshot = parsedBench
        .map((b) => (typeof b === 'string' ? b : b?.playerId ?? ''))
        .filter(Boolean);
    } catch {
      benchIdsFromSnapshot = [];
    }
  } else {
    const configRow = db
      .prepare(
        `SELECT * FROM tactical_configurations WHERE match_id = ? ORDER BY CASE phase WHEN 'pre_match' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
      )
      .get(matchId) as Record<string, unknown> | undefined;

    if (configRow) {
      formationName = String(configRow.formation || formationName);
      buildUpStyle = String(configRow.build_up_style || 'Balanced');
      defensiveApproach = String(configRow.defensive_approach || 'Balanced');
      defensiveLineHeight = Number(configRow.defensive_line_height ?? 55);
      try {
        assignments = JSON.parse(String(configRow.player_assignments_json || '[]')) as PlayerRoleAssignment[];
      } catch {
        assignments = [];
      }
    }
  }

  const visionRow =
    tacticalVisionKey !== 'unspecified'
      ? (db
          .prepare('SELECT display_name FROM catalog_tactical_visions WHERE internal_key = ?')
          .get(tacticalVisionKey) as { display_name: string } | undefined)
      : undefined;

  const catalogFormation = getCatalogFormationByIdOrName(formationName, db);

  const squadRows = db
    .prepare('SELECT * FROM players WHERE club_id = ?')
    .all(String(matchRow.club_id)) as Array<Record<string, unknown>>;
  const squadById = new Map<string, Record<string, unknown>>();
  for (const p of squadRows) {
    squadById.set(String(p.id), p);
  }

  const startingPlayerIds = new Set(
    assignments.map((a) => a.playerId).filter((id): id is string => Boolean(id))
  );

  const startingXi = assignments.map((a) => {
    const squadPlayer = a.playerId ? squadById.get(a.playerId) : undefined;
    const catalogPlayerId = squadPlayer?.catalog_player_id
      ? String(squadPlayer.catalog_player_id)
      : null;
    const masterPlayer = catalogPlayerId ? getCatalogPlayerById(catalogPlayerId, db) : null;
    const validation = validatePlayerRoleFocus(a.positionCode, a.role, a.focus, db);

    const resolvedDisplayName =
      a.playerName ??
      (squadPlayer
        ? resolvePlayerDisplayName({
            displayNameOverride: squadPlayer.display_name_override
              ? String(squadPlayer.display_name_override)
              : null,
            displayName: squadPlayer.display_name ? String(squadPlayer.display_name) : null,
            shortName: squadPlayer.short_name ? String(squadPlayer.short_name) : null,
            fullName: squadPlayer.full_name ? String(squadPlayer.full_name) : null,
            name: String(squadPlayer.name),
          })
        : null);

    return {
      slotIndex: a.slotIndex,
      slotId: a.slotId ?? undefined,
      positionCode: a.positionCode,
      playerId: a.playerId,
      playerName: resolvedDisplayName,
      assignedRole: a.role,
      assignedFocus: a.focus,
      roleFocusValid: validation.valid,
      careerModeOverall:
        squadPlayer && squadPlayer.overall_rating !== null
          ? Number(squadPlayer.overall_rating)
          : null,
      masterCatalogOverall: masterPlayer?.overallRating ?? null,
      potentialRating:
        squadPlayer && squadPlayer.potential_rating !== null
          ? Number(squadPlayer.potential_rating)
          : masterPlayer?.potentialRating ?? null,
      preferredFoot: squadPlayer
        ? String(squadPlayer.preferred_foot)
        : masterPlayer?.preferredFoot ?? null,
      secondaryPositions: masterPlayer?.secondaryPositions ?? [],
      faceStats: masterPlayer
        ? {
            pace: masterPlayer.pace,
            shooting: masterPlayer.shooting,
            passing: masterPlayer.passing,
            dribbling: masterPlayer.dribbling,
            defending: masterPlayer.defending,
            physicality: masterPlayer.physicality,
          }
        : null,
    };
  });

  // Build bench candidates (from snapshot bench first, plus other eligible squad players not in Starting XI)
  const benchCandidateIds = new Set<string>(benchIdsFromSnapshot);
  if (benchCandidateIds.size === 0) {
    try {
      const matchBench = JSON.parse(String(matchRow.bench_json || '[]')) as string[];
      for (const id of matchBench) benchCandidateIds.add(id);
    } catch {
      // ignore
    }
  }

  const benchPlayers: NonNullable<AiMatchTacticalContext['benchPlayers']> = [];
  for (const p of squadRows) {
    const pid = String(p.id);
    if (startingPlayerIds.has(pid)) continue;
    const squadStatus = String(p.squad_status ?? 'active');
    const availability = String(p.availability ?? 'available');
    const seniorAuth = Boolean(p.senior_selection_authorized);
    const eligibleForMatch =
      (squadStatus === 'active' || (squadStatus === 'youth_academy' && seniorAuth)) &&
      (availability === 'available' || availability === 'doubtful');
    if (!benchCandidateIds.has(pid) && !eligibleForMatch) continue;

    let secPos: string[] = [];
    try {
      secPos = JSON.parse(String(p.secondary_positions_json ?? '[]')) as string[];
    } catch {
      secPos = [];
    }

    benchPlayers.push({
      playerId: pid,
      displayName: resolvePlayerDisplayName({
        displayNameOverride: p.display_name_override ? String(p.display_name_override) : null,
        displayName: p.display_name ? String(p.display_name) : null,
        shortName: p.short_name ? String(p.short_name) : null,
        fullName: p.full_name ? String(p.full_name) : null,
        name: String(p.name),
      }),
      position: String(p.position),
      secondaryPositions: secPos,
      overallRating: p.overall_rating === null ? null : Number(p.overall_rating),
      squadStatus: squadStatus as NonNullable<AiMatchTacticalContext['benchPlayers']>[number]['squadStatus'],
      availability: availability as NonNullable<AiMatchTacticalContext['benchPlayers']>[number]['availability'],
      eligibleForMatch,
    });
  }

  // Sort explicitly selected bench first, then by overall rating
  benchPlayers.sort((a, b) => {
    const aIn = benchCandidateIds.has(a.playerId) ? 0 : 1;
    const bIn = benchCandidateIds.has(b.playerId) ? 0 : 1;
    if (aIn !== bIn) return aIn - bIn;
    return (b.overallRating ?? 0) - (a.overallRating ?? 0);
  });

  // Build compact Role -> Focus lookup table scoped to positions in this formation
  const compatRows = getRoleFocusCompatibilityMatrix({}, db);
  const formationPositions = new Set(
    catalogFormation
      ? catalogFormation.slots.map((s) => s.positionCode)
      : assignments.map((a) => {
          const norm = normalizeFormationSlotPosition(a.positionCode);
          return norm.ok ? norm.canonicalPosition : a.positionCode.toUpperCase();
        })
  );

  const validRolesByPosition: Record<string, Record<string, string[]>> = {};
  for (const row of compatRows) {
    if (formationPositions.size > 0 && !formationPositions.has(row.positionCode)) continue;
    if (!validRolesByPosition[row.positionCode]) {
      validRolesByPosition[row.positionCode] = {};
    }
    if (!validRolesByPosition[row.positionCode][row.roleName]) {
      validRolesByPosition[row.positionCode][row.roleName] = [];
    }
    validRolesByPosition[row.positionCode][row.roleName].push(row.focusName);
  }

  const scoreline =
    matchRow.halftime_score_for !== null && matchRow.halftime_score_against !== null
      ? `${matchRow.halftime_score_for}-${matchRow.halftime_score_against}`
      : null;

  return {
    matchId,
    clubId: String(matchRow.club_id),
    clubName: String(matchRow.club_name),
    opponentName: String(matchRow.opponent_name),
    competition: String(matchRow.competition ?? ''),
    venue: String(matchRow.venue ?? ''),
    scoreline,
    snapshotId: snapshotRow ? String(snapshotRow.id) : null,
    tacticalVisionKey: tacticalVisionKey as AiMatchTacticalContext['tacticalVisionKey'],
    tacticalVisionName: visionRow?.display_name ?? 'Unspecified',
    buildUpStyle,
    defensiveApproach,
    defensiveLineHeight,
    clubTacticalIdentity: {
      primaryTacticalVisionKey: String(
        matchRow.primary_tactical_vision_key ?? 'unspecified'
      ) as NonNullable<AiMatchTacticalContext['clubTacticalIdentity']>['primaryTacticalVisionKey'],
      alternativeTacticalVisionKey: String(
        matchRow.alternative_tactical_vision_key ?? 'unspecified'
      ) as NonNullable<AiMatchTacticalContext['clubTacticalIdentity']>['alternativeTacticalVisionKey'],
      tacticalFlexibility: (String(matchRow.tactical_flexibility ?? 'balanced') as
        | 'strict'
        | 'balanced'
        | 'pragmatic'),
      philosophyNotes: String(matchRow.tactical_philosophy_notes ?? ''),
    },
    formation: catalogFormation
      ? {
          name: catalogFormation.name,
          careerModeStatus: catalogFormation.careerModeStatus,
          layoutVerified: catalogFormation.layoutVerified,
          slots: catalogFormation.slots,
        }
      : null,
    startingXi,
    benchPlayers: benchPlayers.slice(0, 16),
    validRolesByPosition,
  };
}
