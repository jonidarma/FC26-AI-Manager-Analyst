/**
 * FC26 AI Manager — Phase 3.0.1 Shared Recording Storage & Canonical Media Path Contract
 *
 * Single authoritative contract shared between Electron Main/CaptureEngine and the
 * Express Backend / AI Video Intelligence pipeline.
 *
 * Guarantees:
 * - Zero dependency on process.cwd() for locating or confining recordings
 * - Windows 10/11 filesystem compatibility (reserved device names, invalid chars,
 *   trailing dots/spaces, Unicode normalization, case-insensitive containment, MAX_PATH guardrails)
 * - Symlink & Windows junction escape prevention via fs.realpathSync canonicalization
 * - Metadata-driven human-readable Career Mode folder & video filename builders
 * - Backward compatibility with legacy Phase 2/2.1/2.2/3 recording layouts
 * - Secret-safe atomic JSON manifest writing
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STRUCTURED_STORAGE_LAYOUT_VERSION = 2;
export const LEGACY_STORAGE_LAYOUT_VERSION = 1;

export type MediaErrorCode =
  | 'MEDIA_PATH_RESOLUTION_FAILED'
  | 'MEDIA_PATH_SECURITY_VIOLATION'
  | 'MEDIA_FILE_NOT_FOUND'
  | 'MEDIA_INTEGRITY_FAILED'
  | 'RECORDING_SESSION_MISMATCH'
  | 'RECORDING_DIRECTORY_CREATION_FAILED'
  | 'RECORDING_FILENAME_COLLISION'
  | 'RECORDING_METADATA_INVALID'
  | 'RECORDING_PATH_TOO_LONG';

export class MediaPathError extends Error {
  public readonly code: MediaErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: MediaErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MediaPathError';
    this.code = code;
    this.details = details;
  }
}

export function isMediaPathError(err: unknown): err is MediaPathError {
  return (
    err instanceof MediaPathError ||
    (typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      typeof (err as { code?: unknown }).code === 'string' &&
      [
        'MEDIA_PATH_RESOLUTION_FAILED',
        'MEDIA_PATH_SECURITY_VIOLATION',
        'MEDIA_FILE_NOT_FOUND',
        'MEDIA_INTEGRITY_FAILED',
        'RECORDING_SESSION_MISMATCH',
        'RECORDING_DIRECTORY_CREATION_FAILED',
        'RECORDING_FILENAME_COLLISION',
        'RECORDING_METADATA_INVALID',
        'RECORDING_PATH_TOO_LONG',
      ].includes((err as { code: string }).code))
  );
}

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;
const INVALID_WINDOWS_CHARS_RE = /[<>:"/\\|?*]+/g;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const WINDOWS_SAFE_MAX_PATH = 240;

export function shortStableHash(input: string, len = 6): string {
  return crypto.createHash('sha1').update(input, 'utf8').digest('hex').slice(0, len);
}

/**
 * Sanitizes an untrusted metadata string into a Windows/macOS/Linux-safe path component.
 * Preserves Unicode club names (e.g. "Bayern München", "Atlético Madrid") and readability.
 */
export function sanitizeWindowsSegment(
  raw: string | null | undefined,
  options?: {
    maxLength?: number;
    fallback?: string;
    replaceSpacesWith?: string;
  }
): string {
  const maxLength = Math.max(8, options?.maxLength ?? 80);
  const fallback = options?.fallback ?? 'Unknown';

  const normalized = String(raw ?? '')
    .normalize('NFC')
    .replace(CONTROL_CHARS_RE, '')
    .replace(/\.\.+/g, ' ')
    .replace(INVALID_WINDOWS_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let cleaned = normalized;
  if (options?.replaceSpacesWith !== undefined) {
    cleaned = cleaned.replace(/ /g, options.replaceSpacesWith);
    // Collapse repeated replacement separators
    if (options.replaceSpacesWith === '-') {
      cleaned = cleaned.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    }
  }

  // Windows forbids trailing periods and spaces in directory & file names
  cleaned = cleaned.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '');

  if (!cleaned) {
    cleaned = fallback;
  }

  // Guard Windows reserved device names (e.g. CON, NUL, COM1, LPT1, or CON.txt)
  const baseUpper = cleaned.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(baseUpper)) {
    cleaned = `${cleaned}_Item`;
  }

  if (cleaned.length > maxLength) {
    const suffix = `-${shortStableHash(normalized || cleaned, 4)}`;
    const sliceLen = Math.max(4, maxLength - suffix.length);
    cleaned = `${cleaned.slice(0, sliceLen).replace(/[. -]+$/g, '')}${suffix}`;
  }

  // Re-check trailing dot/space after truncation
  cleaned = cleaned.replace(/[. ]+$/g, '') || fallback;
  return cleaned;
}

/**
 * Validates an in-game Career Mode fixture date (YYYY-MM-DD).
 * Never silently substitutes real-world system date if missing or invalid.
 */
export function validateInGameMatchDate(rawDate: string | null | undefined): {
  valid: boolean;
  formatted: string;
  warning: string | null;
} {
  const trimmed = String(rawDate ?? '').trim();
  if (!trimmed) {
    return {
      valid: false,
      formatted: 'Date-Unknown',
      warning:
        'In-game Career Mode fixture date is missing. Set the fixture date in Match Preparation (never substituted with system clock).',
    };
  }

  const m = ISO_DATE_RE.exec(trimmed);
  if (!m) {
    return {
      valid: false,
      formatted: 'Date-Unknown',
      warning: `In-game fixture date "${trimmed}" is not in YYYY-MM-DD format.`,
    };
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  const realDate =
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day &&
    year >= 1900 &&
    year <= 2199;

  if (!realDate) {
    return {
      valid: false,
      formatted: 'Date-Unknown',
      warning: `In-game fixture date "${trimmed}" is not a valid calendar date.`,
    };
  }

  return { valid: true, formatted: trimmed, warning: null };
}

/**
 * Builds the human-readable Career Mode root folder name:
 *   e.g. "Chelsea-Career-Mode", "Real-Madrid-Career-Mode"
 * If a discriminator is provided (multiple profiles for the same club), appends it cleanly:
 *   e.g. "Chelsea-Career-Mode (Save 02)" or "Chelsea-Career-Mode (2026-27)"
 */
export function buildCareerFolderName(input: {
  clubName: string;
  discriminator?: string | null;
}): string {
  const clubSlug = sanitizeWindowsSegment(input.clubName, {
    maxLength: 48,
    fallback: 'Club',
    replaceSpacesWith: '-',
  });
  const base = `${clubSlug}-Career-Mode`;
  if (!input.discriminator?.trim()) {
    return base;
  }
  const safeDisc = sanitizeWindowsSegment(input.discriminator, {
    maxLength: 24,
    fallback: 'Profile',
  });
  return `${base} (${safeDisc})`;
}

export function getHalfFolderName(half: 'first_half' | 'second_half'): 'First Half' | 'Second Half' {
  return half === 'second_half' ? 'Second Half' : 'First Half';
}

/**
 * Builds the human-readable Match folder name:
 *   {UserClub}-vs-{OpponentClub} ({Competition}) {MatchDate}
 * Example:
 *   Chelsea-vs-Sunderland (Premier League) 2027-09-11
 * Optional duplicate index (>= 2):
 *   Chelsea-vs-Sunderland (Premier League) 2027-09-11 [Match 02]
 */
export function buildMatchFolderName(input: {
  userClubName: string;
  opponentClubName: string;
  competitionName: string;
  matchDate: string;
  duplicateIndex?: number;
  maxLength?: number;
}): {
  folderName: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const maxLength = Math.max(48, input.maxLength ?? 100);

  const rawUser = String(input.userClubName ?? '').trim();
  const rawOpp = String(input.opponentClubName ?? '').trim();
  const rawComp = String(input.competitionName ?? '').trim();

  if (!rawUser) warnings.push('User club display name missing; using fallback "Club".');
  if (!rawOpp) warnings.push('Opponent club display name missing; using fallback "Opponent".');
  if (!rawComp) warnings.push('Competition display name missing; using fallback "Unspecified Competition".');

  const dateCheck = validateInGameMatchDate(input.matchDate);
  if (dateCheck.warning) warnings.push(dateCheck.warning);

  const dupSuffix =
    input.duplicateIndex && input.duplicateIndex >= 2
      ? ` [Match ${String(input.duplicateIndex).padStart(2, '0')}]`
      : '';

  const buildCandidate = (clubCap: number, compCap: number): string => {
    const userSlug = sanitizeWindowsSegment(rawUser, {
      maxLength: clubCap,
      fallback: 'Club',
      replaceSpacesWith: '-',
    });
    const oppSlug = sanitizeWindowsSegment(rawOpp, {
      maxLength: clubCap,
      fallback: 'Opponent',
      replaceSpacesWith: '-',
    });
    const compLabel = sanitizeWindowsSegment(rawComp, {
      maxLength: compCap,
      fallback: 'Unspecified Competition',
    });
    return `${userSlug}-vs-${oppSlug} (${compLabel}) ${dateCheck.formatted}${dupSuffix}`;
  };

  let folderName = buildCandidate(30, 32);
  if (folderName.length > maxLength) {
    folderName = buildCandidate(20, 20);
  }
  if (folderName.length > maxLength) {
    folderName = buildCandidate(14, 14);
  }
  if (folderName.length > maxLength) {
    const hash = shortStableHash(`${rawUser}|${rawOpp}|${rawComp}|${dateCheck.formatted}`, 6);
    const trimmed = folderName.slice(0, Math.max(24, maxLength - 8 - dupSuffix.length)).trim();
    folderName = `${trimmed}-${hash}${dupSuffix}`;
  }

  return {
    folderName: sanitizeWindowsSegment(folderName, { maxLength, fallback: `Match-${dateCheck.formatted}` }),
    warnings,
  };
}

/**
 * Builds the human-readable video segment filename:
 *   {UserClub} vs {OpponentClub} ({Competition}) {Formation} {MatchDate} Part {SegmentNumber}.mp4
 * Example:
 *   Chelsea vs Sunderland (Premier League) 4-2-3-1 Wide 2027-09-11 Part 1.mp4
 *
 * Automatically compacts long metadata if parentDirectoryPath + filename would exceed Windows path limits.
 */
export function buildStructuredSegmentFileName(input: {
  userClubName: string;
  opponentClubName: string;
  competitionName: string;
  formationName: string;
  matchDate: string;
  partNumber: number;
  parentDirectoryPath?: string;
  maxFullPathLength?: number;
}): string {
  const partNum = Math.max(1, Math.round(input.partNumber));
  const dateCheck = validateInGameMatchDate(input.matchDate);
  const maxFullPath = Math.max(120, input.maxFullPathLength ?? WINDOWS_SAFE_MAX_PATH);

  const parentLen = input.parentDirectoryPath ? input.parentDirectoryPath.length + 1 : 0;
  const availableFileLen = parentLen > 0 ? Math.max(36, maxFullPath - parentLen) : 140;

  const rawUser = String(input.userClubName ?? '').trim() || 'Club';
  const rawOpp = String(input.opponentClubName ?? '').trim() || 'Opponent';
  const rawComp = String(input.competitionName ?? '').trim() || 'Competition';
  const rawForm = String(input.formationName ?? '').trim() || 'Unspecified Formation';

  const suffix = ` ${dateCheck.formatted} Part ${partNum}.mp4`;

  const makeCandidate = (clubCap: number, compCap: number, formCap: number): string => {
    const u = sanitizeWindowsSegment(rawUser, { maxLength: clubCap, fallback: 'Club' });
    const o = sanitizeWindowsSegment(rawOpp, { maxLength: clubCap, fallback: 'Opponent' });
    const c = sanitizeWindowsSegment(rawComp, { maxLength: compCap, fallback: 'Competition' });
    const f = sanitizeWindowsSegment(rawForm, { maxLength: formCap, fallback: 'Formation' });
    return `${u} vs ${o} (${c}) ${f}${suffix}`;
  };

  let candidate = makeCandidate(32, 32, 26);
  if (candidate.length > availableFileLen) {
    candidate = makeCandidate(20, 20, 20);
  }
  if (candidate.length > availableFileLen) {
    candidate = makeCandidate(14, 14, 16);
  }
  if (candidate.length > availableFileLen) {
    const hash = shortStableHash(`${rawUser}|${rawOpp}|${rawComp}|${rawForm}`, 6);
    const shortBase = sanitizeWindowsSegment(`${rawUser.slice(0, 10)} vs ${rawOpp.slice(0, 10)}`, {
      maxLength: Math.max(12, availableFileLen - suffix.length - 8),
      fallback: 'Match',
    });
    candidate = `${shortBase} ${hash}${suffix}`;
  }

  return candidate;
}

/**
 * Parses a positive numeric segment/part index from EITHER:
 * - Structured naming: "Chelsea vs Sunderland (Premier League) 4-2-3-1 Wide 2027-09-11 Part 2.mp4"
 * - Legacy naming: "segment_002.mp4"
 * - Temp FFmpeg staging naming: ".fc26_seg_002.mp4"
 */
export function parsePartOrSegmentIndexFromFileName(fileName: string): number | null {
  const base = path.basename(fileName);
  const legacyMatch = /^(?:\.fc26_seg_|segment_)(\d+)\.mp4$/i.exec(base);
  if (legacyMatch) {
    const parsed = Number.parseInt(legacyMatch[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const partMatch = /\bPart\s+(\d+)\.mp4$/i.exec(base);
  if (partMatch) {
    const parsed = Number.parseInt(partMatch[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

export function isWindowsStyleAbsolutePath(candidate: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\');
}

export function isAbsoluteCrossPlatform(candidate: string): boolean {
  return path.isAbsolute(candidate) || isWindowsStyleAbsolutePath(candidate);
}

/**
 * Normalizes a path string for containment checks, respecting Windows case-insensitivity
 * and mixed slash formats.
 */
export function normalizePathForComparison(
  p: string,
  platform: NodeJS.Platform = process.platform
): string {
  const resolved = platform === 'win32' ? path.win32.resolve(p) : path.resolve(p);
  const stripped =
    resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))
      ? resolved.replace(/[\\/]+$/, '')
      : resolved;
  return platform === 'win32' ? stripped.toLowerCase() : stripped;
}

export function isPathWithinRoot(
  candidatePath: string,
  rootPath: string,
  options?: { allowEqual?: boolean; platform?: NodeJS.Platform }
): boolean {
  const platform = options?.platform ?? process.platform;
  const sep = platform === 'win32' ? '\\' : path.sep;
  const normCandidate = normalizePathForComparison(candidatePath, platform);
  const normRoot = normalizePathForComparison(rootPath, platform);

  if (options?.allowEqual && normCandidate === normRoot) {
    return true;
  }
  const prefix = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`;
  return normCandidate.startsWith(prefix);
}

/**
 * Resolves filesystem symlinks / Windows junctions cleanly.
 * If the target path exists, calls fs.realpathSync directly.
 * If it does not yet exist, resolves the nearest existing ancestor via fs.realpathSync
 * and joins the remaining relative tail so non-existent traversal or symlink ancestors are still caught.
 */
export function canonicalizeFilesystemPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Walk up to nearest existing ancestor so symlink/junction escapes are caught even for missing targets
    const tail: string[] = [];
    let cursor = resolved;
    while (true) {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return resolved;
      }
      tail.unshift(path.basename(cursor));
      cursor = parent;
      if (fs.existsSync(cursor)) {
        try {
          const realAncestor = fs.realpathSync(cursor);
          return path.join(realAncestor, ...tail);
        } catch {
          return resolved;
        }
      }
    }
  }
}

/**
 * Canonicalizes a candidate path (resolving symlinks and Windows junctions) and verifies
 * that BOTH the lexical path and the real filesystem path remain strictly confined within
 * at least one approved root directory.
 */
export function canonicalizeAndContainPath(
  candidatePath: string,
  allowedRoots: string[],
  options?: {
    requireExists?: boolean;
    requireFile?: boolean;
    requireDirectory?: boolean;
    allowEqualRoot?: boolean;
    platform?: NodeJS.Platform;
  }
): string {
  if (!candidatePath || typeof candidatePath !== 'string' || candidatePath.includes('\0')) {
    throw new MediaPathError(
      'MEDIA_PATH_SECURITY_VIOLATION',
      'Invalid media path: empty or contains null byte.'
    );
  }

  const platform = options?.platform ?? process.platform;
  const validRoots = allowedRoots.filter((r) => Boolean(r && r.trim()));
  if (validRoots.length === 0) {
    throw new MediaPathError(
      'MEDIA_PATH_RESOLUTION_FAILED',
      'No approved application storage roots are configured.'
    );
  }

  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoots = validRoots.map((r) => path.resolve(r));
  const canonicalRoots = resolvedRoots.map((r) => canonicalizeFilesystemPath(r));

  // 1. Lexical containment check (rejects ".." escape before touching filesystem)
  const lexicallyAllowed = resolvedRoots.some((root) =>
    isPathWithinRoot(resolvedCandidate, root, {
      allowEqual: options?.allowEqualRoot,
      platform,
    })
  );

  // 2. Canonical (realpath) containment check (rejects symlinks & Windows junctions escaping root)
  const canonicalCandidate = canonicalizeFilesystemPath(resolvedCandidate);
  const canonicallyAllowed = canonicalRoots.some((root) =>
    isPathWithinRoot(canonicalCandidate, root, {
      allowEqual: options?.allowEqualRoot,
      platform,
    })
  );

  if (!lexicallyAllowed || !canonicallyAllowed) {
    throw new MediaPathError(
      'MEDIA_PATH_SECURITY_VIOLATION',
      `Security block: media path "${path.basename(resolvedCandidate)}" lies outside approved application recording/data directories.`,
      {
        fileName: path.basename(resolvedCandidate),
        lexicallyAllowed,
        canonicallyAllowed,
      }
    );
  }

  if (options?.requireExists || options?.requireFile || options?.requireDirectory) {
    if (!fs.existsSync(canonicalCandidate)) {
      throw new MediaPathError(
        'MEDIA_FILE_NOT_FOUND',
        `Media file or folder not found on disk: "${path.basename(canonicalCandidate)}".`,
        { fileName: path.basename(canonicalCandidate) }
      );
    }

    const st = fs.statSync(canonicalCandidate);
    if (options.requireFile && !st.isFile()) {
      throw new MediaPathError(
        'MEDIA_PATH_RESOLUTION_FAILED',
        `Resolved media target "${path.basename(canonicalCandidate)}" is not a regular file.`
      );
    }
    if (options.requireDirectory && !st.isDirectory()) {
      throw new MediaPathError(
        'MEDIA_PATH_RESOLUTION_FAILED',
        `Resolved storage target "${path.basename(canonicalCandidate)}" is not a directory.`
      );
    }
  }

  return canonicalCandidate;
}

/**
 * Converts an absolute path inside appStorageRoot to a portable POSIX-style relative path
 * (e.g. "Chelsea-Career-Mode/Chelsea-vs-Sunderland (Premier League) 2027-09-11/First Half/...").
 * Returns null if the path is not inside appStorageRoot.
 */
export function toPortableRelativePath(absolutePath: string, appStorageRoot: string): string | null {
  const realTarget = canonicalizeFilesystemPath(absolutePath);
  const realRoot = canonicalizeFilesystemPath(appStorageRoot);
  if (!isPathWithinRoot(realTarget, realRoot, { allowEqual: true })) {
    return null;
  }
  const rel = path.relative(realRoot, realTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return rel === '' ? '' : null;
  }
  return rel.split(path.sep).join('/');
}

/**
 * Resolves a portable POSIX-style relative path safely against a trusted root directory.
 */
export function fromPortableRelativePath(relativePath: string, trustedRoot: string): string {
  if (!relativePath || relativePath.includes('\0')) {
    throw new MediaPathError(
      'MEDIA_PATH_SECURITY_VIOLATION',
      'Invalid relative media path: empty or contains null byte.'
    );
  }
  if (isAbsoluteCrossPlatform(relativePath)) {
    throw new MediaPathError(
      'MEDIA_PATH_SECURITY_VIOLATION',
      'Expected a relative storage path, but received an absolute filesystem path.'
    );
  }
  const normalizedSegments = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.');
  if (normalizedSegments.some((seg) => seg === '..')) {
    throw new MediaPathError(
      'MEDIA_PATH_SECURITY_VIOLATION',
      'Path traversal ("..") is prohibited in recording storage paths.'
    );
  }
  const resolved = path.resolve(trustedRoot, ...normalizedSegments);
  return canonicalizeAndContainPath(resolved, [trustedRoot], { allowEqualRoot: true });
}

const FORBIDDEN_SECRET_KEY_RE =
  /^(api_?key|gemini_?api_?key|bearer|auth_?token|session_?token|access_?token|secret|password|authorization|credentials?)$/i;
const SECRET_VALUE_PATTERN_RE = /\b(AIza[0-9A-Za-z_-]{20,}|Bearer\s+[0-9A-Za-z._-]{16,})\b/;

/**
 * Recursively scrubs secret keys or secret-looking token strings from exported JSON artifacts.
 */
export function scrubSecretsFromMetadata<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    if (SECRET_VALUE_PATTERN_RE.test(input)) {
      return '[REDACTED]' as unknown as T;
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => scrubSecretsFromMetadata(item)) as unknown as T;
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (FORBIDDEN_SECRET_KEY_RE.test(k)) {
        continue;
      }
      out[k] = scrubSecretsFromMetadata(v);
    }
    return out as T;
  }
  return input;
}

/**
 * Atomically writes a secret-scrubbed JSON file (write temp sibling -> rename).
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const scrubbed = scrubSecretsFromMetadata(data);
  const tmpPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(scrubbed, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Structured storage plan contract shared between Express backend and Electron Main.
 */
export interface MatchRecordingStoragePlan {
  storageLayoutVersion: 2;
  appStorageRoot: string;
  careerDirectoryName: string;
  careerDirectoryRel: string;
  careerDirectoryAbs: string;
  matchDirectoryName: string;
  matchDirectoryRel: string;
  matchDirectoryAbs: string;
  halfFolderName: 'First Half' | 'Second Half';
  sessionSubfolderName: string | null;
  sessionDirectoryRel: string;
  sessionDirectoryAbs: string;
  evidenceFramesDirRel: string;
  evidenceFramesDirAbs: string;
  aiAnalysisDirRel: string;
  aiAnalysisDirAbs: string;
  diagnosticsDirRel: string;
  diagnosticsDirAbs: string;
  diagnosticsSummaryPathAbs: string;
  matchMetadataPathAbs: string;
  examplePart1FileName: string;
  namingMetadata: {
    matchId: string;
    careerProfileId: string;
    userClubId: string;
    userClubName: string;
    opponentClubId: string;
    opponentClubName: string;
    competitionName: string;
    matchDate: string;
    matchDateValid: boolean;
    formationName: string;
    formationSource: 'pre_match_snapshot' | 'confirmed_in_match_adjustment' | 'fallback_pre_match_unconfirmed';
    tacticalSnapshotId: string | null;
    half: 'first_half' | 'second_half';
  };
  warnings: string[];
}
