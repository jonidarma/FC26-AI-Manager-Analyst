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
      SELECT m.*, c.name as club_name, o.name as opponent_name
      FROM matches m
      JOIN clubs c ON c.id = m.club_id
      JOIN opponents o ON o.id = m.opponent_id
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
  let assignments: Array<{
    slotIndex: number;
    positionCode: string;
    playerId: string | null;
    playerName: string | null;
    role: string;
    focus: string;
  }> = [];

  if (snapshotRow) {
    formationName = String(snapshotRow.formation_name || formationName);
    try {
      const parsed = JSON.parse(String(snapshotRow.assignments_json || '[]')) as MatchTacticalSnapshotAssignment[];
      assignments = parsed.map((a, idx) => ({
        slotIndex: typeof a.slotOrder === 'number' ? a.slotOrder : idx,
        positionCode: a.positionCode,
        playerId: a.playerId,
        playerName: a.playerDisplayName ?? a.playerFullName ?? null,
        role: a.role,
        focus: a.focus,
      }));
    } catch {
      assignments = [];
    }
  } else {
    const configRow = db
      .prepare(
        `SELECT * FROM tactical_configurations WHERE match_id = ? ORDER BY CASE phase WHEN 'pre_match' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
      )
      .get(matchId) as Record<string, unknown> | undefined;

    if (configRow) {
      formationName = String(configRow.formation || formationName);
      try {
        assignments = JSON.parse(String(configRow.player_assignments_json || '[]')) as PlayerRoleAssignment[];
      } catch {
        assignments = [];
      }
    }
  }

  const catalogFormation = getCatalogFormationByIdOrName(formationName, db);

  const squadRows = db
    .prepare('SELECT * FROM players WHERE club_id = ?')
    .all(String(matchRow.club_id)) as Array<Record<string, unknown>>;
  const squadById = new Map<string, Record<string, unknown>>();
  for (const p of squadRows) {
    squadById.set(String(p.id), p);
  }

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
      positionCode: a.positionCode,
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

  return {
    matchId,
    clubName: String(matchRow.club_name),
    opponentName: String(matchRow.opponent_name),
    formation: catalogFormation
      ? {
          name: catalogFormation.name,
          careerModeStatus: catalogFormation.careerModeStatus,
          layoutVerified: catalogFormation.layoutVerified,
          slots: catalogFormation.slots,
        }
      : null,
    startingXi,
    validRolesByPosition,
  };
}
