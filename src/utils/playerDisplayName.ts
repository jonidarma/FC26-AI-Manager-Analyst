/**
 * FC26 AI Manager — Canonical Player Display Name Standardizer (Phase 2.1)
 *
 * Priority Order:
 * 1. User-defined display name override (if explicitly set)
 * 2. Existing preferred display name (if set and distinct from empty)
 * 3. Imported short_name (preferred concise football display name)
 * 4. full_name fallback
 *
 * Guarantees:
 * - Never arbitrarily truncates names.
 * - Preserves accented and international UTF-8 characters (e.g., Ödegaard, Mbappé, Vinícius Jr., Çalhanoğlu).
 * - Canonical identity always remains the player's database ID, never the display name string.
 */

export interface PlayerDisplayNameInput {
  displayNameOverride?: string | null;
  displayName?: string | null;
  shortName?: string | null;
  fullName?: string | null;
  name?: string | null;
}

function cleanName(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

export function resolvePlayerDisplayName(input: PlayerDisplayNameInput): string {
  const override = cleanName(input.displayNameOverride);
  if (override) return override;

  const explicitDisplay = cleanName(input.displayName);
  if (explicitDisplay) return explicitDisplay;

  const shortName = cleanName(input.shortName);
  if (shortName) return shortName;

  const fullName = cleanName(input.fullName);
  if (fullName) return fullName;

  const fallbackName = cleanName(input.name);
  if (fallbackName) return fallbackName;

  return 'Unnamed Player';
}

export function resolvePlayerFullName(input: PlayerDisplayNameInput): string {
  const fullName = cleanName(input.fullName);
  if (fullName) return fullName;

  const fallbackName = cleanName(input.name);
  if (fallbackName) return fallbackName;

  const shortName = cleanName(input.shortName);
  if (shortName) return shortName;

  return resolvePlayerDisplayName(input);
}

export function hasDistinctFullName(input: PlayerDisplayNameInput): boolean;
export function hasDistinctFullName(
  displayName: string | null | undefined,
  fullName: string | null | undefined
): boolean;
export function hasDistinctFullName(
  inputOrDisplay: PlayerDisplayNameInput | string | null | undefined,
  maybeFullName?: string | null
): boolean {
  if (typeof inputOrDisplay === 'object' && inputOrDisplay !== null) {
    const display = resolvePlayerDisplayName(inputOrDisplay);
    const full = resolvePlayerFullName(inputOrDisplay);
    return Boolean(full) && full.toLowerCase() !== display.toLowerCase();
  }
  const display = cleanName(inputOrDisplay);
  const full = cleanName(maybeFullName);
  return Boolean(display) && Boolean(full) && full.toLowerCase() !== display.toLowerCase();
}
