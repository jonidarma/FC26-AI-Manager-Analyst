/**
 * FC26 AI Manager — Centralized Formation Slot & Canonical FC26 Position Normalization (Phase 2.2)
 *
 * Single source of truth shared across frontend (Tactical Setup, Tactical Pitch SVG,
 * Match Preparation, Tactical Board) and backend (Tactical Preset validation,
 * Role/Focus compatibility validation, Match Tactical Snapshots, AI Tactical Context).
 *
 * Strictly separates:
 * - slotId: stable per-slot tactical identifier within a formation (e.g. "LCB", "RCB", "LDM", "RDM")
 * - slotIndex / slotOrder: 0..10 positional index within the formation
 * - canonicalPosition: one of the 15 official EA SPORTS FC 26 player position codes
 * - displayPosition: standard FC 26 position label shown in UI & pitch ("CB", "CDM", "CM", "CAM", "ST")
 *
 * IMPORTANT:
 * - Never blindly strips leading characters (e.g. "LB" != "B", "LW" != "W", "LM" != "M").
 * - Uses an explicit, audited alias table for left/right/central tactical slot variants.
 * - Unknown aliases are rejected with an actionable validation error.
 */

export const CANONICAL_FC26_POSITIONS = [
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
] as const;

export type CanonicalFc26Position = (typeof CANONICAL_FC26_POSITIONS)[number];

export const CANONICAL_FC26_POSITION_SET: ReadonlySet<string> = new Set(CANONICAL_FC26_POSITIONS);

/**
 * Audited mapping of formation slot identifiers / tactical side aliases
 * to canonical EA SPORTS FC 26 player position codes.
 */
export const FORMATION_SLOT_ALIAS_MAP: Readonly<Record<string, CanonicalFc26Position>> = {
  // Canonical identity mappings
  GK: 'GK',
  CB: 'CB',
  LB: 'LB',
  RB: 'RB',
  LWB: 'LWB',
  RWB: 'RWB',
  CDM: 'CDM',
  CM: 'CM',
  CAM: 'CAM',
  LM: 'LM',
  RM: 'RM',
  LW: 'LW',
  RW: 'RW',
  CF: 'CF',
  ST: 'ST',

  // Centre-back slot variants
  LCB: 'CB',
  RCB: 'CB',
  CCB: 'CB',
  SW: 'CB',

  // Defensive midfield slot variants
  LDM: 'CDM',
  RDM: 'CDM',
  LCDM: 'CDM',
  RCDM: 'CDM',
  DM: 'CDM',

  // Central midfield slot variants
  LCM: 'CM',
  RCM: 'CM',
  CCM: 'CM',

  // Attacking midfield slot variants
  LAM: 'CAM',
  RAM: 'CAM',
  LCAM: 'CAM',
  RCAM: 'CAM',
  AM: 'CAM',

  // Striker & centre-forward slot variants
  LST: 'ST',
  RST: 'ST',
  LS: 'ST',
  RS: 'ST',
  LF: 'CF',
  RF: 'CF',
};

export const POSITION_TACTICAL_LINE: Readonly<Record<CanonicalFc26Position, 'GK' | 'DEF' | 'MID' | 'ATT'>> = {
  GK: 'GK',
  CB: 'DEF',
  LB: 'DEF',
  RB: 'DEF',
  LWB: 'DEF',
  RWB: 'DEF',
  CDM: 'MID',
  CM: 'MID',
  CAM: 'MID',
  LM: 'MID',
  RM: 'MID',
  LW: 'ATT',
  RW: 'ATT',
  CF: 'ATT',
  ST: 'ATT',
};

export type SlotPositionNormalizationResult =
  | {
      ok: true;
      /** Stable tactical slot identifier (e.g. "LCB", "RCB", "LDM", "RDM", "GK") */
      slotId: string;
      /** Canonical EA SPORTS FC 26 position code (e.g. "CB", "CDM", "ST") */
      canonicalPosition: CanonicalFc26Position;
      /** Standard FC 26 UI/pitch display label (always canonical: "CB", "CDM", "ST", etc.) */
      displayPosition: CanonicalFc26Position;
      /** True when the raw input was a side/slot alias rather than already canonical */
      wasAlias: boolean;
    }
  | {
      ok: false;
      rawInput: string;
      error: string;
    };

/**
 * Normalizes a formation slot code or tactical position alias into a canonical
 * EA SPORTS FC 26 position code while preserving a stable slot identifier.
 *
 * Never blindly strips prefixes; unknown tokens fail with an actionable error.
 */
export function normalizeFormationSlotPosition(
  rawPositionOrAlias: string | null | undefined,
  explicitSlotId?: string | null,
  slotOrder?: number
): SlotPositionNormalizationResult {
  const cleaned = typeof rawPositionOrAlias === 'string' ? rawPositionOrAlias.trim().toUpperCase() : '';
  if (!cleaned) {
    return {
      ok: false,
      rawInput: cleaned,
      error: `Formation slot${slotOrder !== undefined ? ` #${slotOrder + 1}` : ''} is missing a position code.`,
    };
  }

  const canonical = FORMATION_SLOT_ALIAS_MAP[cleaned];
  if (!canonical) {
    return {
      ok: false,
      rawInput: cleaned,
      error: `Position "${cleaned}" is not a recognized EA SPORTS FC 26 position or formation slot alias. Valid canonical positions: ${CANONICAL_FC26_POSITIONS.join(', ')}.`,
    };
  }

  const wasAlias = cleaned !== canonical;
  const cleanedExplicit =
    typeof explicitSlotId === 'string' && explicitSlotId.trim()
      ? explicitSlotId.trim().toUpperCase()
      : null;

  const slotId =
    cleanedExplicit ??
    (wasAlias
      ? cleaned
      : slotOrder !== undefined
        ? `${canonical}_${slotOrder}`
        : canonical);

  return {
    ok: true,
    slotId,
    canonicalPosition: canonical,
    displayPosition: canonical,
    wasAlias,
  };
}

/**
 * Resolves a canonical FC 26 position code strictly (returns null if unrecognized).
 */
export function toCanonicalFc26Position(raw: string | null | undefined): CanonicalFc26Position | null {
  const res = normalizeFormationSlotPosition(raw);
  return res.ok ? res.canonicalPosition : null;
}

/**
 * Returns the standard FC 26 position display label for UI tables and pitch nodes.
 * Always resolves aliases like LCB -> CB, LDM -> CDM, LST/LS -> ST.
 */
export function getDisplayPositionLabel(raw: string | null | undefined): string {
  const res = normalizeFormationSlotPosition(raw);
  if (res.ok) return res.displayPosition;
  return (raw ?? '').trim().toUpperCase();
}

/**
 * Derives a stable, collision-free slotId for a formation slot (e.g. LCB, RCB, LDM, RDM,
 * or GK, LB, RB, ST) given its canonical position, optional legacy label, and coordinates.
 */
export function deriveStableSlotId(params: {
  slotId?: string | null;
  positionLabel?: string | null;
  positionCode: string;
  slotOrder: number;
  x?: number;
}): string {
  if (params.slotId && params.slotId.trim()) {
    return params.slotId.trim().toUpperCase();
  }
  const label = params.positionLabel?.trim().toUpperCase();
  if (label && FORMATION_SLOT_ALIAS_MAP[label]) {
    return label;
  }
  const pos = toCanonicalFc26Position(params.positionCode) ?? params.positionCode.trim().toUpperCase();
  return `${pos}_${params.slotOrder}`;
}

/**
 * Formats an optional subtle side hint (e.g. "LCB" -> "Left", "RCB" -> "Right",
 * "LDM" -> "Left", "RDM" -> "Right") for accessibility / tooltips without cluttering canonical labels.
 */
export function getSlotSideHint(slotId: string | null | undefined, canonicalPosition: string): string | null {
  const s = (slotId ?? '').trim().toUpperCase();
  const c = canonicalPosition.trim().toUpperCase();
  if (!s || s === c || s.startsWith(`${c}_`)) return null;
  if (['LCB', 'LDM', 'LCDM', 'LCM', 'LAM', 'LCAM', 'LST', 'LS', 'LF'].includes(s)) return 'Left';
  if (['RCB', 'RDM', 'RCDM', 'RCM', 'RAM', 'RCAM', 'RST', 'RS', 'RF'].includes(s)) return 'Right';
  if (['CCB', 'CCM'].includes(s)) return 'Center';
  return s;
}
