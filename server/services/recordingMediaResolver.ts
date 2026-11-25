import fs from 'node:fs';
import path from 'node:path';
import {
  buildCareerFolderName,
  buildMatchFolderName,
  buildStructuredSegmentFileName,
  canonicalizeAndContainPath,
  canonicalizeFilesystemPath,
  fromPortableRelativePath,
  getHalfFolderName,
  isAbsoluteCrossPlatform,
  LEGACY_STORAGE_LAYOUT_VERSION,
  MediaPathError,
  sanitizeWindowsSegment,
  shortStableHash,
  STRUCTURED_STORAGE_LAYOUT_VERSION,
  toPortableRelativePath,
  validateInGameMatchDate,
  WINDOWS_SAFE_MAX_PATH,
  writeJsonAtomic,
  type MatchRecordingStoragePlan,
} from '../../shared/recordingStorage.ts';
import type {
  MatchRecordingStoragePreview,
  MatchSession,
  MatchStorageFoldersInfo,
  RecordingSegment,
  StorageOverviewInfo,
  TrustedFolderKind,
} from '../../src/types/domain.ts';
import {
  getDb,
  resolveAppStorageRoot,
  resolveDatabaseLocation,
  resolveLegacyRecordingsRoot,
} from '../db/database.ts';

export interface ResolvedSegmentMedia {
  resolvedPath: string;
  relativeToStorageRoot: string | null;
  sessionDirectory: string;
  storageLayoutVersion: number;
  resolutionStrategy:
    | 'relative_media_path'
    | 'absolute_direct'
    | 'session_directory_relative'
    | 'output_directory_relative'
    | 'match_half_directory_relative'
    | 'legacy_recordings_root_relative'
    | 'data_dir_recordings_relative'
    | 'app_storage_root_relative'
    | 'filename_fallback_in_session_dir';
}

/**
 * Returns all authoritative application-managed media & data roots.
 * Completely independent of process.cwd() when FC26_APP_USER_DATA_ROOT / FC26_USER_DATA_DIR are configured.
 */
export function getAuthoritativeStorageRoots(extraAllowedDirs: string[] = []): string[] {
  const { dataDir } = resolveDatabaseLocation();
  const appStorageRoot = resolveAppStorageRoot();
  const legacyRecordingsRoot = resolveLegacyRecordingsRoot();

  const rawRoots = [
    appStorageRoot,
    legacyRecordingsRoot,
    dataDir,
    path.join(dataDir, 'recordings'),
    path.join(dataDir, 'evidence_frames'),
    path.join(dataDir, 'analysis_temp'),
    path.join(dataDir, 'test_clips'),
    ...extraAllowedDirs,
  ].filter((r): r is string => Boolean(r && r.trim()));

  const dedup = new Set<string>();
  const out: string[] = [];
  for (const r of rawRoots) {
    const resolved = path.resolve(r);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!dedup.has(key)) {
      dedup.add(key);
      out.push(resolved);
    }
  }
  return out;
}

function containsTraversalSegments(rawPath: string): boolean {
  const parts = rawPath.replace(/\\/g, '/').split('/');
  return parts.some((p) => p === '..');
}

function resolveCandidateSessionDir(
  rawDir: string | null | undefined,
  appStorageRoot: string,
  allowedRoots: string[]
): string | null {
  const trimmed = rawDir?.trim();
  if (!trimmed || trimmed.includes('\0') || containsTraversalSegments(trimmed)) {
    return null;
  }
  try {
    if (isAbsoluteCrossPlatform(trimmed)) {
      return canonicalizeAndContainPath(trimmed, allowedRoots, { allowEqualRoot: true });
    }
    return fromPortableRelativePath(trimmed, appStorageRoot);
  } catch {
    return null;
  }
}

/**
 * Canonical server-side resolver for any recording segment (structured v2 OR legacy v1,
 * relative OR absolute path, Windows OR POSIX).
 *
 * Enforces:
 * 1. Session ownership (session.matchId === matchId, optional expectedHalf match, segment belongs to session & match)
 * 2. Traversal & null-byte rejection
 * 3. Symlink / Windows junction escape prevention via fs.realpathSync containment
 * 4. Zero dependency on process.cwd()
 */
export function resolveRecordingSegmentMediaPath(input: {
  matchId: string;
  expectedHalf?: 'first_half' | 'second_half';
  session: Pick<
    MatchSession,
    | 'id'
    | 'matchId'
    | 'half'
    | 'outputDirectory'
    | 'sessionDirectory'
    | 'matchDirectory'
    | 'storageLayoutVersion'
  >;
  segment: Pick<
    RecordingSegment,
    | 'id'
    | 'sessionId'
    | 'matchId'
    | 'segmentIndex'
    | 'filePath'
    | 'relativeMediaPath'
    | 'originalFileName'
    | 'displayFileName'
  >;
  extraAllowedDirs?: string[];
}): ResolvedSegmentMedia {
  const { matchId, expectedHalf, session, segment } = input;

  // 1. Strict ownership & session integrity check
  if (session.matchId !== matchId) {
    throw new MediaPathError(
      'RECORDING_SESSION_MISMATCH',
      `Recording session "${session.id}" belongs to a different match and cannot be used for match "${matchId}".`,
      { matchId, sessionId: session.id, sessionMatchId: session.matchId }
    );
  }
  if (expectedHalf && session.half !== expectedHalf) {
    throw new MediaPathError(
      'RECORDING_SESSION_MISMATCH',
      `Recording session "${session.id}" is for ${session.half}, not ${expectedHalf}.`,
      { matchId, sessionId: session.id, sessionHalf: session.half, expectedHalf }
    );
  }
  if (segment.matchId !== matchId || segment.sessionId !== session.id) {
    throw new MediaPathError(
      'RECORDING_SESSION_MISMATCH',
      `Recording segment #${segment.segmentIndex} does not belong to match "${matchId}" / session "${session.id}".`,
      { matchId, sessionId: session.id, segmentId: segment.id }
    );
  }

  const appStorageRoot = resolveAppStorageRoot();
  const legacyRecordingsRoot = resolveLegacyRecordingsRoot();
  const { dataDir } = resolveDatabaseLocation();
  const allowedRoots = getAuthoritativeStorageRoots(input.extraAllowedDirs);
  const layoutVersion = session.storageLayoutVersion ?? LEGACY_STORAGE_LAYOUT_VERSION;

  const rawFilePath = String(segment.filePath ?? '').trim();
  const rawRelPath = segment.relativeMediaPath?.trim() || null;

  if (!rawFilePath && !rawRelPath) {
    throw new MediaPathError(
      'MEDIA_PATH_RESOLUTION_FAILED',
      `Recording segment #${segment.segmentIndex} has no recorded file path.`
    );
  }

  if (
    rawFilePath.includes('\0') ||
    (rawRelPath && rawRelPath.includes('\0')) ||
    containsTraversalSegments(rawFilePath) ||
    (rawRelPath && containsTraversalSegments(rawRelPath))
  ) {
    throw new MediaPathError(
      'MEDIA_PATH_SECURITY_VIOLATION',
      `Security block: segment #${segment.segmentIndex} path contains prohibited traversal or invalid characters.`,
      { matchId, sessionId: session.id, segmentId: segment.id }
    );
  }

  const tryExistingFile = (
    candidate: string,
    strategy: ResolvedSegmentMedia['resolutionStrategy']
  ): ResolvedSegmentMedia | null => {
    // Always verify containment (lexical + realpath) BEFORE checking existence so
    // an attacker cannot probe arbitrary paths or escape via symlinks/junctions.
    const confined = canonicalizeAndContainPath(candidate, allowedRoots, {
      requireExists: false,
      allowEqualRoot: false,
    });
    if (!fs.existsSync(confined)) {
      return null;
    }
    const stat = fs.statSync(confined);
    if (!stat.isFile()) {
      throw new MediaPathError(
        'MEDIA_PATH_RESOLUTION_FAILED',
        `Resolved media target for segment #${segment.segmentIndex} is not a regular file.`
      );
    }
    return {
      resolvedPath: confined,
      relativeToStorageRoot: toPortableRelativePath(confined, appStorageRoot),
      sessionDirectory: path.dirname(confined),
      storageLayoutVersion: layoutVersion,
      resolutionStrategy: strategy,
    };
  };

  // Strategy 1: Authoritative portable relative path under appStorageRoot (v2 & normalized v1)
  if (rawRelPath) {
    if (isAbsoluteCrossPlatform(rawRelPath)) {
      throw new MediaPathError(
        'MEDIA_PATH_SECURITY_VIOLATION',
        `Security block: segment #${segment.segmentIndex} relative_media_path must not be an absolute path.`
      );
    }
    const candidateFromAppRoot = fromPortableRelativePath(rawRelPath, appStorageRoot);
    const hit = tryExistingFile(candidateFromAppRoot, 'relative_media_path');
    if (hit) {
      logMediaResolution(matchId, session.id, segment.id, hit);
      return hit;
    }
  }

  // Strategy 2: Absolute segment.filePath — MUST be confined inside approved roots (never silently bypasses security!)
  if (rawFilePath && isAbsoluteCrossPlatform(rawFilePath)) {
    // On Linux/macOS, a Windows-style path like "C:\Users\..." is not a local POSIX path;
    // detect and reject explicitly if outside approved roots.
    if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(rawFilePath)) {
      throw new MediaPathError(
        'MEDIA_PATH_SECURITY_VIOLATION',
        `Security block: Windows absolute path "${path.win32.basename(rawFilePath)}" cannot be resolved outside approved storage directories on ${process.platform}.`
      );
    }
    // Check containment unconditionally — throws MEDIA_PATH_SECURITY_VIOLATION if outside approved roots or symlink escapes!
    const confinedAbs = canonicalizeAndContainPath(rawFilePath, allowedRoots, {
      requireExists: false,
      allowEqualRoot: false,
    });
    if (fs.existsSync(confinedAbs)) {
      const st = fs.statSync(confinedAbs);
      if (!st.isFile()) {
        throw new MediaPathError(
          'MEDIA_PATH_RESOLUTION_FAILED',
          `Resolved media path for segment #${segment.segmentIndex} is not a regular file.`
        );
      }
      const res: ResolvedSegmentMedia = {
        resolvedPath: confinedAbs,
        relativeToStorageRoot: toPortableRelativePath(confinedAbs, appStorageRoot),
        sessionDirectory: path.dirname(confinedAbs),
        storageLayoutVersion: layoutVersion,
        resolutionStrategy: 'absolute_direct',
      };
      logMediaResolution(matchId, session.id, segment.id, res);
      return res;
    }
    // File was inside an approved root (e.g. from another folder move or renamed file) — check filename fallback in session dir before reporting NOT_FOUND
  }

  // Build list of authoritative session directories (strictly confined)
  const sessionDirs: Array<{ dir: string; strategy: ResolvedSegmentMedia['resolutionStrategy'] }> = [];
  const pushSessionDir = (dir: string | null, strategy: ResolvedSegmentMedia['resolutionStrategy']) => {
    if (!dir) return;
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (!sessionDirs.some((d) => (process.platform === 'win32' ? d.dir.toLowerCase() : d.dir) === key)) {
      sessionDirs.push({ dir, strategy });
    }
  };

  pushSessionDir(
    resolveCandidateSessionDir(session.sessionDirectory, appStorageRoot, allowedRoots),
    'session_directory_relative'
  );
  pushSessionDir(
    resolveCandidateSessionDir(session.outputDirectory, appStorageRoot, allowedRoots),
    'output_directory_relative'
  );
  if (session.matchDirectory) {
    const matchDirAbs = resolveCandidateSessionDir(session.matchDirectory, appStorageRoot, allowedRoots);
    if (matchDirAbs) {
      pushSessionDir(
        path.join(matchDirAbs, getHalfFolderName(session.half)),
        'match_half_directory_relative'
      );
    }
  }
  pushSessionDir(
    path.join(legacyRecordingsRoot, matchId, session.id),
    'legacy_recordings_root_relative'
  );
  pushSessionDir(
    path.join(dataDir, 'recordings', matchId, session.id),
    'data_dir_recordings_relative'
  );

  // Strategy 3: Relative segment.filePath anchored to authoritative session directories (NEVER process.cwd()!)
  if (rawFilePath && !isAbsoluteCrossPlatform(rawFilePath)) {
    const normalizedRelParts = rawFilePath
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s.length > 0 && s !== '.');

    for (const { dir, strategy } of sessionDirs) {
      const candidate = path.resolve(dir, ...normalizedRelParts);
      const hit = tryExistingFile(candidate, strategy);
      if (hit) {
        logMediaResolution(matchId, session.id, segment.id, hit);
        return hit;
      }
    }

    // Also try directly relative to appStorageRoot (e.g. "Chelsea-Career-Mode/.../Part 1.mp4")
    const appRootCandidate = path.resolve(appStorageRoot, ...normalizedRelParts);
    const appRootHit = tryExistingFile(appRootCandidate, 'app_storage_root_relative');
    if (appRootHit) {
      logMediaResolution(matchId, session.id, segment.id, appRootHit);
      return appRootHit;
    }
  }

  // Strategy 4: Fallback by displayFileName / originalFileName / basename inside resolved session directories
  const safeBaseNames = Array.from(
    new Set(
      [
        segment.displayFileName?.trim(),
        segment.originalFileName?.trim(),
        rawFilePath ? path.basename(rawFilePath.replace(/\\/g, '/')) : null,
      ].filter((n): n is string => Boolean(n && !n.includes('/') && !n.includes('\\') && n !== '..' && n !== '.'))
    )
  );

  for (const baseName of safeBaseNames) {
    for (const { dir } of sessionDirs) {
      const candidate = path.resolve(dir, baseName);
      const hit = tryExistingFile(candidate, 'filename_fallback_in_session_dir');
      if (hit) {
        logMediaResolution(matchId, session.id, segment.id, hit);
        return hit;
      }
    }
  }

  const displayTarget =
    segment.displayFileName ||
    segment.originalFileName ||
    (rawFilePath ? path.basename(rawFilePath.replace(/\\/g, '/')) : `segment_${segment.segmentIndex}.mp4`);

  throw new MediaPathError(
    'MEDIA_FILE_NOT_FOUND',
    `Recording media file "${displayTarget}" for segment #${segment.segmentIndex} could not be found in the approved recording session directory. Verify that the recording file still exists on disk.`,
    {
      matchId,
      sessionId: session.id,
      segmentId: segment.id,
      segmentIndex: segment.segmentIndex,
      storageLayoutVersion: layoutVersion,
      searchedSessionDirCount: sessionDirs.length,
    }
  );
}

function logMediaResolution(
  matchId: string,
  sessionId: string,
  segmentId: string,
  result: ResolvedSegmentMedia
): void {
  // Structured, secret-free diagnostic trace for desktop debugging
  console.info(
    `[media-resolver] match=${matchId} session=${sessionId} segment=${segmentId} layout=v${result.storageLayoutVersion} strategy=${result.resolutionStrategy} rel=${result.relativeToStorageRoot ?? path.basename(result.resolvedPath)}`
  );
}

/**
 * Resolves the authoritative official club display name from catalog_clubs if linked,
 * falling back to the Career Mode club name.
 */
function resolveOfficialClubDisplayName(
  db: ReturnType<typeof getDb>,
  rawName: string,
  catalogClubId?: string | null
): string {
  if (catalogClubId) {
    const row = db
      .prepare('SELECT name, display_name FROM catalog_clubs WHERE id = ?')
      .get(catalogClubId) as { name?: string; display_name?: string | null } | undefined;
    if (row?.display_name?.trim()) return row.display_name.trim();
    if (row?.name?.trim()) return row.name.trim();
  }
  return rawName.trim();
}

/**
 * Resolves the authoritative official formation display name from catalog_formations if available.
 */
function resolveOfficialFormationName(
  db: ReturnType<typeof getDb>,
  rawFormationName: string,
  formationId?: string | null
): string {
  if (formationId) {
    const byId = db
      .prepare('SELECT name FROM catalog_formations WHERE id = ?')
      .get(formationId) as { name?: string } | undefined;
    if (byId?.name?.trim()) return byId.name.trim();
  }
  const trimmed = rawFormationName.trim();
  if (trimmed) {
    const byName = db
      .prepare('SELECT name FROM catalog_formations WHERE LOWER(name) = LOWER(?)')
      .get(trimmed) as { name?: string } | undefined;
    if (byName?.name?.trim()) return byName.name.trim();
  }
  return trimmed || 'Unspecified Formation';
}

/**
 * Computes a deterministic, collision-safe Career Mode folder name for a career_profile.
 */
function resolveCareerDirectoryName(
  db: ReturnType<typeof getDb>,
  careerProfileId: string,
  clubDisplayName: string,
  season: string,
  existingStoredDir: string | null,
  persist: boolean
): string {
  if (existingStoredDir && existingStoredDir.trim()) {
    return existingStoredDir.trim();
  }

  const baseName = buildCareerFolderName({ clubName: clubDisplayName });
  // Check if any OTHER career_profile already uses this exact career folder name or shares the same club name
  const conflictByDir = db
    .prepare(
      `SELECT id FROM career_profiles
       WHERE id != ? AND LOWER(COALESCE(storage_career_directory, '')) = LOWER(?)`
    )
    .get(careerProfileId, baseName) as { id: string } | undefined;

  const sameClubOtherProfiles = db
    .prepare(
      `SELECT cp.id
       FROM career_profiles cp
       JOIN clubs c ON c.id = cp.club_id
       WHERE cp.id != ? AND LOWER(c.name) = LOWER(?)`
    )
    .all(careerProfileId, clubDisplayName) as Array<{ id: string }>;

  let chosenName = baseName;
  if (conflictByDir || sameClubOtherProfiles.length > 0) {
    const seasonClean = sanitizeWindowsSegment(season || 'Save', { maxLength: 16, fallback: 'Save' });
    const withSeason = buildCareerFolderName({ clubName: clubDisplayName, discriminator: seasonClean });
    const seasonConflict = db
      .prepare(
        `SELECT id FROM career_profiles
         WHERE id != ? AND LOWER(COALESCE(storage_career_directory, '')) = LOWER(?)`
      )
      .get(careerProfileId, withSeason) as { id: string } | undefined;

    chosenName = seasonConflict
      ? buildCareerFolderName({
          clubName: clubDisplayName,
          discriminator: `${seasonClean}-${shortStableHash(careerProfileId, 4)}`,
        })
      : withSeason;
  }

  if (persist) {
    db.prepare('UPDATE career_profiles SET storage_career_directory = ? WHERE id = ?').run(
      chosenName,
      careerProfileId
    );
  }
  return chosenName;
}

/**
 * Generates a read-only live preview of the structured Career Mode storage paths
 * for the Match Preparation UI before a match is created.
 */
export function previewMatchStoragePlan(input: {
  clubId?: string | null;
  clubName?: string;
  opponentId?: string | null;
  opponentName?: string;
  competition?: string;
  matchDate?: string;
  startingFormation?: string;
  secondHalfFormation?: string;
}): MatchRecordingStoragePreview {
  const db = getDb();
  const appStorageRoot = resolveAppStorageRoot();

  let userClubName = (input.clubName ?? '').trim();
  let careerFolderName = '';
  if (input.clubId) {
    const clubRow = db
      .prepare(
        `SELECT c.name, c.catalog_club_id, cp.id as profile_id, cp.season, cp.storage_career_directory
         FROM clubs c
         JOIN career_profiles cp ON cp.club_id = c.id
         WHERE c.id = ?
         ORDER BY cp.is_active DESC LIMIT 1`
      )
      .get(input.clubId) as
      | {
          name: string;
          catalog_club_id: string | null;
          profile_id: string;
          season: string;
          storage_career_directory: string | null;
        }
      | undefined;

    if (clubRow) {
      userClubName = resolveOfficialClubDisplayName(db, clubRow.name, clubRow.catalog_club_id);
      careerFolderName = resolveCareerDirectoryName(
        db,
        clubRow.profile_id,
        userClubName,
        clubRow.season,
        clubRow.storage_career_directory,
        false
      );
    }
  }
  if (!userClubName) userClubName = 'Active Club';
  if (!careerFolderName) {
    careerFolderName = buildCareerFolderName({ clubName: userClubName });
  }

  let opponentClubName = (input.opponentName ?? '').trim();
  if (input.opponentId) {
    const oppRow = db
      .prepare('SELECT name, catalog_club_id FROM opponents WHERE id = ?')
      .get(input.opponentId) as { name: string; catalog_club_id: string | null } | undefined;
    if (oppRow) {
      opponentClubName = resolveOfficialClubDisplayName(db, oppRow.name, oppRow.catalog_club_id);
    }
  }
  if (!opponentClubName) opponentClubName = 'Opponent';

  const competitionName = (input.competition ?? '').trim() || 'Competition';
  const dateCheck = validateInGameMatchDate(input.matchDate);
  const firstHalfFormation = resolveOfficialFormationName(
    db,
    input.startingFormation ?? '4-2-3-1 Wide'
  );
  const secondHalfFormation = resolveOfficialFormationName(
    db,
    input.secondHalfFormation ?? firstHalfFormation
  );

  const matchBuilt = buildMatchFolderName({
    userClubName,
    opponentClubName,
    competitionName,
    matchDate: input.matchDate ?? '',
  });

  const firstHalfFolderRel = `${careerFolderName}/${matchBuilt.folderName}/First Half`;
  const secondHalfFolderRel = `${careerFolderName}/${matchBuilt.folderName}/Second Half`;
  const firstHalfDirAbs = path.join(appStorageRoot, careerFolderName, matchBuilt.folderName, 'First Half');
  const secondHalfDirAbs = path.join(appStorageRoot, careerFolderName, matchBuilt.folderName, 'Second Half');

  const exampleFirstHalfFileName = buildStructuredSegmentFileName({
    userClubName,
    opponentClubName,
    competitionName,
    formationName: firstHalfFormation,
    matchDate: input.matchDate ?? '',
    partNumber: 1,
    parentDirectoryPath: firstHalfDirAbs,
  });

  const exampleSecondHalfFileName = buildStructuredSegmentFileName({
    userClubName,
    opponentClubName,
    competitionName,
    formationName: secondHalfFormation,
    matchDate: input.matchDate ?? '',
    partNumber: 1,
    parentDirectoryPath: secondHalfDirAbs,
  });

  return {
    appStorageRoot,
    careerFolderName,
    matchFolderName: matchBuilt.folderName,
    firstHalfFolderRel,
    secondHalfFolderRel,
    exampleFirstHalfFileName,
    exampleSecondHalfFileName,
    matchDateValid: dateCheck.valid,
    warnings: matchBuilt.warnings,
  };
}

/**
 * Resolves the authoritative formation for a match half.
 *
 * CRITICAL DOMAIN RULE:
 * - First Half ALWAYS uses the pre-match tactical snapshot formation (or match.starting_formation).
 * - Second Half uses the latest `in_match_adjustment` tactical snapshot ONLY IF explicitly
 *   confirmed as applied in FC 26 (`applied_in_game_confirmed = 1`).
 *   Unconfirmed AI proposals NEVER alter the second-half video filename!
 */
export function resolveActiveFormationForHalf(
  db: ReturnType<typeof getDb>,
  matchId: string,
  half: 'first_half' | 'second_half',
  fallbackStartingFormation: string
): {
  formationName: string;
  tacticalSnapshotId: string | null;
  formationSource: MatchRecordingStoragePlan['namingMetadata']['formationSource'];
} {
  const preMatchSnap = db
    .prepare(
      `SELECT id, formation_id, formation_name
       FROM match_tactical_snapshots
       WHERE match_id = ? AND snapshot_type = 'pre_match'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(matchId) as { id: string; formation_id: string | null; formation_name: string } | undefined;

  if (half === 'first_half') {
    const rawName = preMatchSnap?.formation_name || fallbackStartingFormation;
    return {
      formationName: resolveOfficialFormationName(db, rawName, preMatchSnap?.formation_id),
      tacticalSnapshotId: preMatchSnap?.id ?? null,
      formationSource: 'pre_match_snapshot',
    };
  }

  // Second Half: check for explicitly confirmed in-match adjustment first
  const confirmedAdjustment = db
    .prepare(
      `SELECT id, formation_id, formation_name
       FROM match_tactical_snapshots
       WHERE match_id = ?
         AND snapshot_type = 'in_match_adjustment'
         AND applied_in_game_confirmed = 1
       ORDER BY COALESCE(applied_in_game_at, updated_at, created_at) DESC
       LIMIT 1`
    )
    .get(matchId) as { id: string; formation_id: string | null; formation_name: string } | undefined;

  if (confirmedAdjustment) {
    return {
      formationName: resolveOfficialFormationName(
        db,
        confirmedAdjustment.formation_name,
        confirmedAdjustment.formation_id
      ),
      tacticalSnapshotId: confirmedAdjustment.id,
      formationSource: 'confirmed_in_match_adjustment',
    };
  }

  // Check if an unconfirmed adjustment exists so we can record accurate provenance
  const unconfirmedCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c
         FROM match_tactical_snapshots
         WHERE match_id = ? AND snapshot_type = 'in_match_adjustment' AND applied_in_game_confirmed = 0`
      )
      .get(matchId) as { c: number }
  ).c;

  const fallbackName = preMatchSnap?.formation_name || fallbackStartingFormation;
  return {
    formationName: resolveOfficialFormationName(db, fallbackName, preMatchSnap?.formation_id),
    tacticalSnapshotId: preMatchSnap?.id ?? null,
    formationSource:
      unconfirmedCount > 0 ? 'fallback_pre_match_unconfirmed' : 'pre_match_snapshot',
  };
}

/**
 * Builds (and optionally lazily allocates on disk + persists in SQLite) the authoritative
 * Phase 3.0.1 structured Career Mode storage plan for a match half recording.
 */
export function buildMatchStoragePlan(
  matchId: string,
  half: 'first_half' | 'second_half',
  options?: {
    allocateIfMissing?: boolean;
    createNewSessionSubdir?: boolean;
  }
): MatchRecordingStoragePlan {
  const db = getDb();
  const appStorageRoot = resolveAppStorageRoot();
  const allocate = options?.allocateIfMissing === true;

  const row = db
    .prepare(
      `SELECT
         m.id, m.club_id, m.career_profile_id, m.opponent_id, m.competition, m.venue,
         m.match_date, m.starting_formation, m.storage_layout_version,
         m.storage_career_directory, m.storage_match_directory,
         c.name as club_name, c.catalog_club_id as club_catalog_id,
         cp.season as career_season, cp.storage_career_directory as profile_career_dir,
         o.name as opponent_name, o.catalog_club_id as opponent_catalog_id
       FROM matches m
       JOIN clubs c ON c.id = m.club_id
       JOIN career_profiles cp ON cp.id = m.career_profile_id
       JOIN opponents o ON o.id = m.opponent_id
       WHERE m.id = ?`
    )
    .get(matchId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new MediaPathError(
      'RECORDING_METADATA_INVALID',
      `Match "${matchId}" was not found in the local database.`
    );
  }

  const userClubName = resolveOfficialClubDisplayName(
    db,
    String(row.club_name ?? ''),
    row.club_catalog_id ? String(row.club_catalog_id) : null
  );
  const opponentClubName = resolveOfficialClubDisplayName(
    db,
    String(row.opponent_name ?? ''),
    row.opponent_catalog_id ? String(row.opponent_catalog_id) : null
  );
  const competitionName = String(row.competition ?? '').trim() || 'Unspecified Competition';
  const rawMatchDate = String(row.match_date ?? '');
  const dateCheck = validateInGameMatchDate(rawMatchDate);

  const careerDirectoryName = resolveCareerDirectoryName(
    db,
    String(row.career_profile_id),
    userClubName,
    String(row.career_season ?? ''),
    (row.storage_career_directory ? String(row.storage_career_directory) : null) ??
      (row.profile_career_dir ? String(row.profile_career_dir) : null),
    allocate
  );

  const careerDirectoryAbs = canonicalizeAndContainPath(
    path.join(appStorageRoot, careerDirectoryName),
    [appStorageRoot],
    { allowEqualRoot: false }
  );

  // Determine stable Match directory name (reuse persisted folder if already assigned to this match)
  const warnings: string[] = [];
  let matchDirectoryName = row.storage_match_directory
    ? String(row.storage_match_directory).trim()
    : '';

  if (!matchDirectoryName) {
    let dupIndex = 1;
    while (dupIndex <= 99) {
      const built = buildMatchFolderName({
        userClubName,
        opponentClubName,
        competitionName,
        matchDate: rawMatchDate,
        duplicateIndex: dupIndex,
      });
      if (dupIndex === 1) {
        warnings.push(...built.warnings);
      }

      const candidateName = built.folderName;
      const dbConflict = db
        .prepare(
          `SELECT id FROM matches
           WHERE id != ?
             AND LOWER(COALESCE(storage_career_directory, '')) = LOWER(?)
             AND LOWER(COALESCE(storage_match_directory, '')) = LOWER(?)`
        )
        .get(matchId, careerDirectoryName, candidateName) as { id: string } | undefined;

      const fsCandidatePath = path.join(careerDirectoryAbs, candidateName);
      let fsConflict = false;
      if (!dbConflict && fs.existsSync(fsCandidatePath)) {
        // Check if existing match-metadata.json belongs to a DIFFERENT matchId
        const metaPath = path.join(fsCandidatePath, 'match-metadata.json');
        if (fs.existsSync(metaPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { matchId?: string };
            if (parsed.matchId && parsed.matchId !== matchId) {
              fsConflict = true;
            }
          } catch {
            fsConflict = true;
          }
        } else {
          // Existing populated folder without metadata -> avoid overwriting another fixture's folder
          const entries = fs.readdirSync(fsCandidatePath);
          if (entries.length > 0) {
            fsConflict = true;
          }
        }
      }

      if (!dbConflict && !fsConflict) {
        matchDirectoryName = candidateName;
        break;
      }
      dupIndex += 1;
    }

    if (!matchDirectoryName) {
      matchDirectoryName = `${sanitizeWindowsSegment(`${userClubName}-vs-${opponentClubName}`, {
        maxLength: 48,
        replaceSpacesWith: '-',
      })} ${dateCheck.formatted} [${shortStableHash(matchId, 6)}]`;
    }
  } else if (dateCheck.warning) {
    warnings.push(dateCheck.warning);
  }

  const matchDirectoryAbs = canonicalizeAndContainPath(
    path.join(careerDirectoryAbs, matchDirectoryName),
    [appStorageRoot],
    { allowEqualRoot: false }
  );

  const halfFolderName = getHalfFolderName(half);
  const halfDirectoryAbs = canonicalizeAndContainPath(
    path.join(matchDirectoryAbs, halfFolderName),
    [appStorageRoot],
    { allowEqualRoot: false }
  );

  // Handle multiple recording sessions for the same match + half cleanly without clobbering files
  let sessionSubfolderName: string | null = null;
  let sessionDirectoryAbs = halfDirectoryAbs;

  if (options?.createNewSessionSubdir) {
    const existingHalfSessions = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM match_sessions
           WHERE match_id = ? AND half = ? AND status != 'discarded'`
        )
        .get(matchId, half) as { c: number }
    ).c;

    const halfFolderHasArtifacts =
      fs.existsSync(halfDirectoryAbs) &&
      fs
        .readdirSync(halfDirectoryAbs)
        .some(
          (f) =>
            f.toLowerCase().endsWith('.mp4') ||
            f.toLowerCase() === 'recording-manifest.json' ||
            f.toLowerCase() === 'manifest.json'
        );

    if (existingHalfSessions > 0 || halfFolderHasArtifacts) {
      let attempt = Math.max(2, existingHalfSessions + 1);
      while (attempt <= 99) {
        const subName = `Session ${String(attempt).padStart(2, '0')}`;
        const subPath = path.join(halfDirectoryAbs, subName);
        if (!fs.existsSync(subPath)) {
          sessionSubfolderName = subName;
          sessionDirectoryAbs = canonicalizeAndContainPath(subPath, [appStorageRoot], {
            allowEqualRoot: false,
          });
          break;
        }
        attempt += 1;
      }
    }
  }

  const formationInfo = resolveActiveFormationForHalf(
    db,
    matchId,
    half,
    String(row.starting_formation ?? '')
  );

  const evidenceFramesDirAbs = canonicalizeAndContainPath(
    path.join(matchDirectoryAbs, 'Evidence Frames', halfFolderName),
    [appStorageRoot],
    { allowEqualRoot: false }
  );
  const aiAnalysisDirAbs = canonicalizeAndContainPath(
    path.join(matchDirectoryAbs, 'AI Analysis'),
    [appStorageRoot],
    { allowEqualRoot: false }
  );
  const diagnosticsDirAbs = canonicalizeAndContainPath(
    path.join(matchDirectoryAbs, 'Diagnostics'),
    [appStorageRoot],
    { allowEqualRoot: false }
  );
  const diagnosticsSummaryFile =
    half === 'first_half'
      ? 'first-half-recording-diagnostics.json'
      : 'second-half-recording-diagnostics.json';
  const diagnosticsSummaryPathAbs = path.join(diagnosticsDirAbs, diagnosticsSummaryFile);
  const matchMetadataPathAbs = path.join(matchDirectoryAbs, 'match-metadata.json');

  const examplePart1FileName = buildStructuredSegmentFileName({
    userClubName,
    opponentClubName,
    competitionName,
    formationName: formationInfo.formationName,
    matchDate: rawMatchDate,
    partNumber: 1,
    parentDirectoryPath: sessionDirectoryAbs,
  });

  // Guard Windows path length before creating directories
  const fullExamplePath = path.join(sessionDirectoryAbs, examplePart1FileName);
  if (fullExamplePath.length > WINDOWS_SAFE_MAX_PATH + 15) {
    throw new MediaPathError(
      'RECORDING_PATH_TOO_LONG',
      `Generated recording path exceeds safe Windows path length (${fullExamplePath.length} chars). Shorten the Career Mode storage root or match labels.`,
      { length: fullExamplePath.length }
    );
  }

  if (allocate) {
    try {
      fs.mkdirSync(sessionDirectoryAbs, { recursive: true });
      fs.mkdirSync(diagnosticsDirAbs, { recursive: true });
    } catch (err) {
      throw new MediaPathError(
        'RECORDING_DIRECTORY_CREATION_FAILED',
        `Failed to create structured recording directory: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    db.prepare(
      `UPDATE matches
       SET storage_layout_version = ?,
           storage_career_directory = ?,
           storage_match_directory = ?
       WHERE id = ?`
    ).run(STRUCTURED_STORAGE_LAYOUT_VERSION, careerDirectoryName, matchDirectoryName, matchId);
  }

  const careerDirectoryRel = careerDirectoryName;
  const matchDirectoryRel = `${careerDirectoryName}/${matchDirectoryName}`;
  const sessionDirectoryRel = sessionSubfolderName
    ? `${matchDirectoryRel}/${halfFolderName}/${sessionSubfolderName}`
    : `${matchDirectoryRel}/${halfFolderName}`;

  const plan: MatchRecordingStoragePlan = {
    storageLayoutVersion: STRUCTURED_STORAGE_LAYOUT_VERSION,
    appStorageRoot,
    careerDirectoryName,
    careerDirectoryRel,
    careerDirectoryAbs,
    matchDirectoryName,
    matchDirectoryRel,
    matchDirectoryAbs,
    halfFolderName,
    sessionSubfolderName,
    sessionDirectoryRel,
    sessionDirectoryAbs,
    evidenceFramesDirRel: `${matchDirectoryRel}/Evidence Frames/${halfFolderName}`,
    evidenceFramesDirAbs,
    aiAnalysisDirRel: `${matchDirectoryRel}/AI Analysis`,
    aiAnalysisDirAbs,
    diagnosticsDirRel: `${matchDirectoryRel}/Diagnostics`,
    diagnosticsDirAbs,
    diagnosticsSummaryPathAbs,
    matchMetadataPathAbs,
    examplePart1FileName,
    namingMetadata: {
      matchId,
      careerProfileId: String(row.career_profile_id),
      userClubId: String(row.club_id),
      userClubName,
      opponentClubId: String(row.opponent_id),
      opponentClubName,
      competitionName,
      matchDate: dateCheck.formatted,
      matchDateValid: dateCheck.valid,
      formationName: formationInfo.formationName,
      formationSource: formationInfo.formationSource,
      tacticalSnapshotId: formationInfo.tacticalSnapshotId,
      half,
    },
    warnings,
  };

  if (allocate) {
    try {
      writeMatchMetadataManifest(matchId);
    } catch {
      // Never block recording startup if supplementary metadata JSON fails
    }
  }

  return plan;
}

/**
 * Returns the confined v2 match root directory for a match if it uses layout v2.
 */
export function getStructuredMatchRootDir(matchId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT storage_layout_version, storage_career_directory, storage_match_directory
       FROM matches WHERE id = ?`
    )
    .get(matchId) as
    | {
        storage_layout_version: number | null;
        storage_career_directory: string | null;
        storage_match_directory: string | null;
      }
    | undefined;

  if (
    !row ||
    Number(row.storage_layout_version ?? 1) < STRUCTURED_STORAGE_LAYOUT_VERSION ||
    !row.storage_career_directory ||
    !row.storage_match_directory
  ) {
    return null;
  }

  const appStorageRoot = resolveAppStorageRoot();
  try {
    return canonicalizeAndContainPath(
      path.join(appStorageRoot, row.storage_career_directory, row.storage_match_directory),
      [appStorageRoot],
      { allowEqualRoot: false }
    );
  } catch {
    return null;
  }
}

/**
 * Atomically writes the secret-safe human-readable `match-metadata.json` file
 * inside a structured v2 match folder. SQLite remains authoritative.
 */
export function writeMatchMetadataManifest(matchId: string): string | null {
  const matchRootDir = getStructuredMatchRootDir(matchId);
  if (!matchRootDir) return null;

  const db = getDb();
  const matchRow = db
    .prepare(
      `SELECT m.*, c.name as club_name, c.catalog_club_id as club_catalog_id,
              cp.season, cp.manager_name, o.name as opponent_name, o.catalog_club_id as opponent_catalog_id
       FROM matches m
       JOIN clubs c ON c.id = m.club_id
       JOIN career_profiles cp ON cp.id = m.career_profile_id
       JOIN opponents o ON o.id = m.opponent_id
       WHERE m.id = ?`
    )
    .get(matchId) as Record<string, unknown> | undefined;

  if (!matchRow) return null;

  const firstHalfFormation = resolveActiveFormationForHalf(
    db,
    matchId,
    'first_half',
    String(matchRow.starting_formation ?? '')
  );
  const secondHalfFormation = resolveActiveFormationForHalf(
    db,
    matchId,
    'second_half',
    String(matchRow.starting_formation ?? '')
  );

  const sessions = db
    .prepare(
      `SELECT id, half, status, storage_layout_version, session_directory, output_directory,
              recorded_formation_name, duration_seconds, total_bytes, integrity_status, ai_eligible,
              started_at, ended_at
       FROM match_sessions
       WHERE match_id = ?
       ORDER BY created_at ASC`
    )
    .all(matchId) as Array<Record<string, unknown>>;

  const segments = db
    .prepare(
      `SELECT id, session_id, segment_index, display_file_name, original_file_name, relative_media_path,
              duration_seconds, size_bytes, checksum, status, integrity_status
       FROM recording_segments
       WHERE match_id = ?
       ORDER BY segment_index ASC`
    )
    .all(matchId) as Array<Record<string, unknown>>;

  const payload = {
    schemaVersion: 'fc26-match-metadata-v2',
    storageLayoutVersion: STRUCTURED_STORAGE_LAYOUT_VERSION,
    authoritativeSourceNote:
      'SQLite (database/fc26_manager.db) is the authoritative datastore. This file is a human-readable mirror.',
    updatedAt: new Date().toISOString(),
    matchId,
    careerProfileId: String(matchRow.career_profile_id),
    season: String(matchRow.season ?? ''),
    managerName: String(matchRow.manager_name ?? ''),
    clubName: resolveOfficialClubDisplayName(
      db,
      String(matchRow.club_name ?? ''),
      matchRow.club_catalog_id ? String(matchRow.club_catalog_id) : null
    ),
    opponentName: resolveOfficialClubDisplayName(
      db,
      String(matchRow.opponent_name ?? ''),
      matchRow.opponent_catalog_id ? String(matchRow.opponent_catalog_id) : null
    ),
    competition: String(matchRow.competition ?? ''),
    venue: String(matchRow.venue ?? ''),
    matchDate: String(matchRow.match_date ?? ''),
    status: String(matchRow.status ?? ''),
    halftimeScore:
      matchRow.halftime_score_for !== null && matchRow.halftime_score_against !== null
        ? `${matchRow.halftime_score_for}-${matchRow.halftime_score_against}`
        : null,
    finalScore:
      matchRow.final_score_for !== null && matchRow.final_score_against !== null
        ? `${matchRow.final_score_for}-${matchRow.final_score_against}`
        : null,
    formations: {
      firstHalf: firstHalfFormation,
      secondHalf: secondHalfFormation,
    },
    storage: {
      careerDirectory: matchRow.storage_career_directory ? String(matchRow.storage_career_directory) : null,
      matchDirectory: matchRow.storage_match_directory ? String(matchRow.storage_match_directory) : null,
    },
    sessions: sessions.map((s) => ({
      id: String(s.id),
      half: String(s.half),
      status: String(s.status),
      recordedFormationName: s.recorded_formation_name ? String(s.recorded_formation_name) : null,
      durationSeconds: Number(s.duration_seconds ?? 0),
      totalBytes: Number(s.total_bytes ?? 0),
      integrityStatus: String(s.integrity_status ?? 'pending'),
      aiEligible: Boolean(s.ai_eligible),
      startedAt: s.started_at ? String(s.started_at) : null,
      endedAt: s.ended_at ? String(s.ended_at) : null,
    })),
    segments: segments.map((seg) => ({
      id: String(seg.id),
      sessionId: String(seg.session_id),
      segmentIndex: Number(seg.segment_index),
      fileName: seg.display_file_name
        ? String(seg.display_file_name)
        : seg.original_file_name
          ? String(seg.original_file_name)
          : null,
      relativeMediaPath: seg.relative_media_path ? String(seg.relative_media_path) : null,
      durationSeconds: Number(seg.duration_seconds ?? 0),
      sizeBytes: Number(seg.size_bytes ?? 0),
      checksum: seg.checksum ? String(seg.checksum) : null,
      status: String(seg.status),
      integrityStatus: String(seg.integrity_status ?? 'pending'),
    })),
  };

  const metadataPath = path.join(matchRootDir, 'match-metadata.json');
  writeJsonAtomic(metadataPath, payload);
  return metadataPath;
}

/**
 * Atomically exports a supplementary AI analysis JSON artifact into `{MatchDir}/AI Analysis/{fileName}`
 * for structured v2 matches. Secret fields are scrubbed automatically.
 */
export function exportAnalysisArtifactJson(
  matchId: string,
  fileName: 'first-half-analysis.json' | 'second-half-analysis.json' | 'match-comparison.json',
  payload: unknown
): string | null {
  const matchRootDir = getStructuredMatchRootDir(matchId);
  if (!matchRootDir) return null;

  const safeName = path.basename(fileName);
  const aiDir = path.join(matchRootDir, 'AI Analysis');
  const appStorageRoot = resolveAppStorageRoot();
  const targetPath = canonicalizeAndContainPath(path.join(aiDir, safeName), [appStorageRoot], {
    allowEqualRoot: false,
  });
  writeJsonAtomic(targetPath, {
    exportedAt: new Date().toISOString(),
    authoritativeSource: 'sqlite',
    matchId,
    artifact: safeName,
    data: payload,
  });
  return targetPath;
}

/**
 * Atomically exports a supplementary recording diagnostics JSON artifact into
 * `{MatchDir}/Diagnostics/{first|second}-half-recording-diagnostics.json` for structured v2 matches.
 */
export function exportDiagnosticsArtifactJson(
  matchId: string,
  half: 'first_half' | 'second_half',
  payload: unknown
): string | null {
  const matchRootDir = getStructuredMatchRootDir(matchId);
  if (!matchRootDir) return null;

  const fileName =
    half === 'first_half'
      ? 'first-half-recording-diagnostics.json'
      : 'second-half-recording-diagnostics.json';
  const diagDir = path.join(matchRootDir, 'Diagnostics');
  const appStorageRoot = resolveAppStorageRoot();
  const targetPath = canonicalizeAndContainPath(path.join(diagDir, fileName), [appStorageRoot], {
    allowEqualRoot: false,
  });
  writeJsonAtomic(targetPath, {
    exportedAt: new Date().toISOString(),
    authoritativeSource: 'sqlite',
    matchId,
    half,
    diagnostics: payload,
  });
  return targetPath;
}

/**
 * Returns the structured Evidence Frames output directory for a match half if the match uses v2 layout.
 * Returns null for legacy v1 matches (which keep using `{dataDir}/evidence_frames/{matchId}`).
 */
export function getStructuredEvidenceFramesDir(
  matchId: string,
  half: 'first_half' | 'second_half'
): string | null {
  const matchRootDir = getStructuredMatchRootDir(matchId);
  if (!matchRootDir) return null;
  const appStorageRoot = resolveAppStorageRoot();
  const target = path.join(matchRootDir, 'Evidence Frames', getHalfFolderName(half));
  return canonicalizeAndContainPath(target, [appStorageRoot], { allowEqualRoot: false });
}

/**
 * Inspects which storage folders actually exist for a match (supports BOTH v2 structured & v1 legacy matches).
 */
export function getMatchStorageFoldersInfo(matchId: string): MatchStorageFoldersInfo {
  const db = getDb();
  const appStorageRoot = resolveAppStorageRoot();
  const legacyRecordingsRoot = resolveLegacyRecordingsRoot();
  const allowedRoots = getAuthoritativeStorageRoots();

  const matchRow = db
    .prepare(
      `SELECT id, storage_layout_version, storage_career_directory, storage_match_directory
       FROM matches WHERE id = ?`
    )
    .get(matchId) as
    | {
        id: string;
        storage_layout_version: number | null;
        storage_career_directory: string | null;
        storage_match_directory: string | null;
      }
    | undefined;

  if (!matchRow) {
    throw new MediaPathError('RECORDING_METADATA_INVALID', `Match "${matchId}" not found.`);
  }

  const layoutVersion = Number(matchRow.storage_layout_version ?? 1);
  const v2MatchRoot = getStructuredMatchRootDir(matchId);

  const checkDir = (dir: string | null): { path: string | null; exists: boolean } => {
    if (!dir) return { path: null, exists: false };
    try {
      const confined = canonicalizeAndContainPath(dir, allowedRoots, { allowEqualRoot: true });
      const exists = fs.existsSync(confined) && fs.statSync(confined).isDirectory();
      return { path: confined, exists };
    } catch {
      return { path: null, exists: false };
    }
  };

  if (v2MatchRoot) {
    const careerDir = matchRow.storage_career_directory
      ? path.join(appStorageRoot, matchRow.storage_career_directory)
      : path.dirname(v2MatchRoot);
    const matchInfo = checkDir(v2MatchRoot);
    const firstInfo = checkDir(path.join(v2MatchRoot, 'First Half'));
    const secondInfo = checkDir(path.join(v2MatchRoot, 'Second Half'));
    const evidenceInfo = checkDir(path.join(v2MatchRoot, 'Evidence Frames'));
    const aiInfo = checkDir(path.join(v2MatchRoot, 'AI Analysis'));
    const diagInfo = checkDir(path.join(v2MatchRoot, 'Diagnostics'));

    return {
      matchId,
      storageLayoutVersion: layoutVersion,
      appStorageRoot,
      careerDirectory: careerDir,
      matchDirectory: matchInfo.path,
      matchFolderExists: matchInfo.exists,
      firstHalfDirectory: firstInfo.path,
      firstHalfExists: firstInfo.exists,
      secondHalfDirectory: secondInfo.path,
      secondHalfExists: secondInfo.exists,
      evidenceFramesDirectory: evidenceInfo.path,
      evidenceFramesExists: evidenceInfo.exists,
      aiAnalysisDirectory: aiInfo.path,
      aiAnalysisExists: aiInfo.exists,
      diagnosticsDirectory: diagInfo.path,
      diagnosticsExists: diagInfo.exists,
      primaryDisplayPath: matchInfo.exists
        ? matchInfo.path
        : firstInfo.exists
          ? firstInfo.path
          : secondInfo.exists
            ? secondInfo.path
            : matchInfo.path,
    };
  }

  // Legacy v1 match: derive folders from match_sessions or <legacyRecordingsRoot>/<matchId>
  const sessions = db
    .prepare(
      `SELECT id, half, output_directory, session_directory
       FROM match_sessions
       WHERE match_id = ?
       ORDER BY COALESCE(started_at, created_at) DESC`
    )
    .all(matchId) as Array<{
    id: string;
    half: 'first_half' | 'second_half';
    output_directory: string | null;
    session_directory: string | null;
  }>;

  const firstSession = sessions.find((s) => s.half === 'first_half');
  const secondSession = sessions.find((s) => s.half === 'second_half');

  const resolveLegacySessionDir = (s?: {
    id: string;
    output_directory: string | null;
    session_directory: string | null;
  }): { path: string | null; exists: boolean } => {
    if (!s) return { path: null, exists: false };
    const candidates = [
      resolveCandidateSessionDir(s.session_directory, appStorageRoot, allowedRoots),
      resolveCandidateSessionDir(s.output_directory, appStorageRoot, allowedRoots),
      path.join(legacyRecordingsRoot, matchId, s.id),
    ];
    for (const c of candidates) {
      const checked = checkDir(c);
      if (checked.exists) return checked;
    }
    return checkDir(candidates.find(Boolean) ?? null);
  };

  const legacyMatchDir = checkDir(path.join(legacyRecordingsRoot, matchId));
  const firstInfo = resolveLegacySessionDir(firstSession);
  const secondInfo = resolveLegacySessionDir(secondSession);
  const { dataDir } = resolveDatabaseLocation();
  const legacyEvidence = checkDir(path.join(dataDir, 'evidence_frames', matchId));

  return {
    matchId,
    storageLayoutVersion: LEGACY_STORAGE_LAYOUT_VERSION,
    appStorageRoot,
    careerDirectory: null,
    matchDirectory: legacyMatchDir.path,
    matchFolderExists: legacyMatchDir.exists,
    firstHalfDirectory: firstInfo.path,
    firstHalfExists: firstInfo.exists,
    secondHalfDirectory: secondInfo.path,
    secondHalfExists: secondInfo.exists,
    evidenceFramesDirectory: legacyEvidence.path,
    evidenceFramesExists: legacyEvidence.exists,
    aiAnalysisDirectory: null,
    aiAnalysisExists: false,
    diagnosticsDirectory: null,
    diagnosticsExists: false,
    primaryDisplayPath: legacyMatchDir.exists
      ? legacyMatchDir.path
      : firstInfo.exists
        ? firstInfo.path
        : secondInfo.exists
          ? secondInfo.path
          : null,
  };
}

/**
 * Resolves a trusted folder path strictly by semantic kind + optional matchId/sessionId.
 * Renderer NEVER supplies raw filesystem paths to open in Windows Explorer.
 */
export function resolveTrustedFolderPath(input: {
  kind: TrustedFolderKind;
  matchId?: string;
  sessionId?: string;
}): { resolvedPath: string; exists: boolean } {
  const appStorageRoot = resolveAppStorageRoot();
  const legacyRecordingsRoot = resolveLegacyRecordingsRoot();
  const allowedRoots = getAuthoritativeStorageRoots();

  if (input.kind === 'storage_root') {
    fs.mkdirSync(appStorageRoot, { recursive: true });
    const real = canonicalizeFilesystemPath(appStorageRoot);
    return { resolvedPath: real, exists: fs.existsSync(real) };
  }

  if (input.kind === 'legacy_recordings_root') {
    fs.mkdirSync(legacyRecordingsRoot, { recursive: true });
    const real = canonicalizeFilesystemPath(legacyRecordingsRoot);
    return { resolvedPath: real, exists: fs.existsSync(real) };
  }

  if (input.sessionId) {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, match_id, half, output_directory, session_directory, match_directory
         FROM match_sessions WHERE id = ?`
      )
      .get(input.sessionId) as
      | {
          id: string;
          match_id: string;
          half: 'first_half' | 'second_half';
          output_directory: string | null;
          session_directory: string | null;
          match_directory: string | null;
        }
      | undefined;

    if (!row) {
      throw new MediaPathError('MEDIA_FILE_NOT_FOUND', `Recording session "${input.sessionId}" not found.`);
    }
    if (input.matchId && row.match_id !== input.matchId) {
      throw new MediaPathError('RECORDING_SESSION_MISMATCH', 'Session does not belong to the requested match.');
    }

    const candidates = [
      resolveCandidateSessionDir(row.session_directory, appStorageRoot, allowedRoots),
      resolveCandidateSessionDir(row.output_directory, appStorageRoot, allowedRoots),
      path.join(legacyRecordingsRoot, row.match_id, row.id),
    ].filter((c): c is string => Boolean(c));

    for (const c of candidates) {
      try {
        const confined = canonicalizeAndContainPath(c, allowedRoots, {
          requireExists: true,
          requireDirectory: true,
          allowEqualRoot: false,
        });
        return { resolvedPath: confined, exists: true };
      } catch {
        // try next
      }
    }
    throw new MediaPathError('MEDIA_FILE_NOT_FOUND', 'Recording session directory does not exist on disk.');
  }

  if (!input.matchId) {
    throw new MediaPathError(
      'RECORDING_METADATA_INVALID',
      `matchId is required to resolve folder kind "${input.kind}".`
    );
  }

  const folders = getMatchStorageFoldersInfo(input.matchId);
  const map: Record<Exclude<TrustedFolderKind, 'storage_root' | 'legacy_recordings_root'>, { dir: string | null; exists: boolean }> = {
    match: { dir: folders.matchDirectory, exists: folders.matchFolderExists },
    first_half: { dir: folders.firstHalfDirectory, exists: folders.firstHalfExists },
    second_half: { dir: folders.secondHalfDirectory, exists: folders.secondHalfExists },
    evidence: { dir: folders.evidenceFramesDirectory, exists: folders.evidenceFramesExists },
    ai_analysis: { dir: folders.aiAnalysisDirectory, exists: folders.aiAnalysisExists },
    diagnostics: { dir: folders.diagnosticsDirectory, exists: folders.diagnosticsExists },
  };

  const selected = map[input.kind];
  if (!selected?.dir || !selected.exists) {
    throw new MediaPathError(
      'MEDIA_FILE_NOT_FOUND',
      `The "${input.kind.replace(/_/g, ' ')}" folder does not exist yet for this match.`
    );
  }

  const confined = canonicalizeAndContainPath(selected.dir, allowedRoots, {
    requireExists: true,
    requireDirectory: true,
    allowEqualRoot: false,
  });
  return { resolvedPath: confined, exists: true };
}

/**
 * Returns authoritative storage architecture info for Settings > Capture & Storage.
 */
export function getStorageOverviewInfo(): StorageOverviewInfo {
  const db = getDb();
  const { dataDir, storageMode } = resolveDatabaseLocation();
  const appStorageRoot = resolveAppStorageRoot();
  const legacyRecordingsRoot = resolveLegacyRecordingsRoot();

  const structuredRow = db
    .prepare('SELECT COUNT(*) as c FROM match_sessions WHERE storage_layout_version >= 2')
    .get() as { c: number };
  const legacyRow = db
    .prepare('SELECT COUNT(*) as c FROM match_sessions WHERE COALESCE(storage_layout_version, 1) < 2')
    .get() as { c: number };
  const segRow = db.prepare('SELECT COUNT(*) as c FROM recording_segments').get() as { c: number };

  return {
    appStorageRoot,
    legacyRecordingsRoot,
    databaseDirectory: dataDir,
    storageMode,
    structuredLayoutVersion: STRUCTURED_STORAGE_LAYOUT_VERSION,
    namingConventions: {
      careerFolderTemplate: '{ClubName}-Career-Mode',
      matchFolderTemplate: '{UserClub}-vs-{OpponentClub} ({Competition}) {MatchDate}',
      videoFileTemplate:
        '{UserClub} vs {OpponentClub} ({Competition}) {Formation} {MatchDate} Part {SegmentNumber}.mp4',
    },
    exampleTree: [
      `${appStorageRoot}/`,
      '├── database/fc26_manager.db',
      '├── recordings/ (legacy v1 recordings preserved in place)',
      '└── Chelsea-Career-Mode/',
      '    └── Chelsea-vs-Sunderland (Premier League) 2027-09-11/',
      '        ├── First Half/',
      '        │   ├── Chelsea vs Sunderland (Premier League) 4-2-3-1 Wide 2027-09-11 Part 1.mp4',
      '        │   └── recording-manifest.json',
      '        ├── Second Half/',
      '        │   ├── Chelsea vs Sunderland (Premier League) 4-3-3 Holding 2027-09-11 Part 1.mp4',
      '        │   └── recording-manifest.json',
      '        ├── Evidence Frames/First Half/ & Second Half/',
      '        ├── AI Analysis/',
      '        ├── Diagnostics/',
      '        └── match-metadata.json',
    ],
    stats: {
      structuredSessionsCount: structuredRow.c,
      legacySessionsCount: legacyRow.c,
      totalSegmentsCount: segRow.c,
    },
  };
}
