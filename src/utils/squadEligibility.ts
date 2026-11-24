/**
 * FC26 AI Manager — Centralized Squad Eligibility & Lineup Validation Engine (Phase 2.2)
 *
 * Single source of truth shared across frontend (Tactical Setup, Match Preparation,
 * Squad Management, Tactical Board) and backend (Tactical Preset validation, Match
 * Snapshot validation, Match Preparation confirmation, Pre-Recording guard).
 *
 * Eligibility requires BOTH squad membership AND player availability to pass:
 *
 * Squad Membership:
 * - active: eligible subject to availability
 * - loaned_in: eligible subject to availability
 * - loaned_out: INELIGIBLE
 * - transferred_out: INELIGIBLE
 * - released: INELIGIBLE
 * - youth_academy: INELIGIBLE unless explicitly promoted or seniorSelectionAuthorized === true
 *
 * Availability:
 * - available: eligible
 * - doubtful: selectable with prominent warning & explicit confirmation
 * - injured: INELIGIBLE
 * - suspended: INELIGIBLE
 * - unavailable (or legacy 'resting'): INELIGIBLE
 */

import type {
  LineupEligibilityIssue,
  LineupEligibilityReport,
  Player,
  PlayerAvailability,
  PlayerEligibilityEvaluation,
  SquadStatus,
} from '../types/domain.ts';
import { POSITION_TACTICAL_LINE, toCanonicalFc26Position } from './formationPositions.ts';
import { resolvePlayerDisplayName } from './playerDisplayName.ts';

export interface EligibilitySubject {
  id: string;
  squadStatus: SquadStatus | string;
  availability: PlayerAvailability | string;
  seniorSelectionAuthorized?: boolean;
  injuryStatus?: string | null;
  suspensionStatus?: string | null;
  displayName?: string | null;
  shortName?: string | null;
  fullName?: string | null;
  name?: string | null;
  position?: string;
  secondaryPositions?: string[];
  overallRating?: number | null;
}

export function evaluatePlayerEligibility(player: EligibilitySubject): PlayerEligibilityEvaluation {
  const reasons: string[] = [];
  let membershipIneligible = false;
  let availabilityIneligible = false;
  let isDoubtful = false;

  const status = String(player.squadStatus || 'active').toLowerCase();
  const availability = String(player.availability || 'available').toLowerCase();

  // 1. Evaluate Squad Membership
  switch (status) {
    case 'active':
    case 'loaned_in':
      break;
    case 'loaned_out':
      membershipIneligible = true;
      reasons.push('Loaned out to another club.');
      break;
    case 'transferred_out':
      membershipIneligible = true;
      reasons.push('Transferred out — no longer registered with this squad.');
      break;
    case 'released':
      membershipIneligible = true;
      reasons.push('Released — no longer registered with this squad.');
      break;
    case 'youth_academy':
      if (!player.seniorSelectionAuthorized) {
        membershipIneligible = true;
        reasons.push('Youth Academy — not yet promoted or authorized for senior selection.');
      }
      break;
    default:
      membershipIneligible = true;
      reasons.push(`Unrecognized squad membership status "${status}".`);
      break;
  }

  // 2. Evaluate Matchday Availability
  switch (availability) {
    case 'available':
      break;
    case 'doubtful':
      isDoubtful = true;
      reasons.push(
        player.injuryStatus?.trim()
          ? `Doubtful (${player.injuryStatus.trim()}) — explicit confirmation required.`
          : 'Doubtful fitness — explicit confirmation required before match confirmation.'
      );
      break;
    case 'injured':
      availabilityIneligible = true;
      reasons.push(
        player.injuryStatus?.trim()
          ? `Injured (${player.injuryStatus.trim()}).`
          : 'Injured — unavailable for selection.'
      );
      break;
    case 'suspended':
      availabilityIneligible = true;
      reasons.push(
        player.suspensionStatus?.trim()
          ? `Suspended (${player.suspensionStatus.trim()}).`
          : 'Suspended — unavailable for selection.'
      );
      break;
    case 'unavailable':
    case 'resting':
      availabilityIneligible = true;
      reasons.push('Unavailable for matchday selection.');
      break;
    default:
      availabilityIneligible = true;
      reasons.push(`Unavailable (status: ${availability}).`);
      break;
  }

  if (membershipIneligible || availabilityIneligible) {
    const shortBadge =
      status === 'loaned_out'
        ? 'Loaned Out'
        : status === 'transferred_out'
          ? 'Transferred Out'
          : status === 'released'
            ? 'Released'
            : status === 'youth_academy' && !player.seniorSelectionAuthorized
              ? 'Academy'
              : availability === 'injured'
                ? 'Injured'
                : availability === 'suspended'
                  ? 'Suspended'
                  : 'Unavailable';

    return {
      eligible: false,
      status: 'ineligible',
      requiresConfirmation: false,
      reasons,
      shortBadge,
    };
  }

  if (isDoubtful) {
    return {
      eligible: true,
      status: 'conditional_doubtful',
      requiresConfirmation: true,
      reasons,
      shortBadge: 'Doubtful',
    };
  }

  return {
    eligible: true,
    status: 'eligible',
    requiresConfirmation: false,
    reasons: [],
    shortBadge: status === 'loaned_in' ? 'Loaned In' : 'Eligible',
  };
}

export function isPlayerSelectableForMatchday(player: EligibilitySubject): boolean {
  return evaluatePlayerEligibility(player).eligible;
}

export function summarizeSquadEligibility(players: readonly EligibilitySubject[]): {
  total: number;
  eligibleCount: number;
  doubtfulCount: number;
  ineligibleCount: number;
  injuredCount: number;
  suspendedCount: number;
  loanedOutCount: number;
  academyUnpromotedCount: number;
} {
  let eligibleCount = 0;
  let doubtfulCount = 0;
  let ineligibleCount = 0;
  let injuredCount = 0;
  let suspendedCount = 0;
  let loanedOutCount = 0;
  let academyUnpromotedCount = 0;

  for (const p of players) {
    const ev = evaluatePlayerEligibility(p);
    if (ev.status === 'eligible') eligibleCount += 1;
    else if (ev.status === 'conditional_doubtful') doubtfulCount += 1;
    else ineligibleCount += 1;

    if (p.availability === 'injured') injuredCount += 1;
    if (p.availability === 'suspended') suspendedCount += 1;
    if (p.squadStatus === 'loaned_out') loanedOutCount += 1;
    if (p.squadStatus === 'youth_academy' && !p.seniorSelectionAuthorized) {
      academyUnpromotedCount += 1;
    }
  }

  return {
    total: players.length,
    eligibleCount,
    doubtfulCount,
    ineligibleCount,
    injuredCount,
    suspendedCount,
    loanedOutCount,
    academyUnpromotedCount,
  };
}

/**
 * Suggests eligible replacements for a formation slot, ranked by:
 * 1. Exact primary position match (canonical)
 * 2. Secondary position match (canonical)
 * 3. Same tactical line (GK / DEF / MID / ATT)
 * 4. Strictly available before doubtful
 * 5. Overall rating descending
 */
export function suggestEligibleReplacements(
  slotPositionCode: string,
  clubPlayers: readonly Player[],
  excludePlayerIds: ReadonlySet<string>,
  limit = 4
): Array<{
  playerId: string;
  displayName: string;
  position: string;
  overallRating: number | null;
  matchQuality: 'exact_primary' | 'secondary' | 'same_line' | 'fallback';
  isDoubtful: boolean;
}> {
  const canonicalSlot = toCanonicalFc26Position(slotPositionCode) ?? slotPositionCode.toUpperCase();
  const slotLine = POSITION_TACTICAL_LINE[canonicalSlot as keyof typeof POSITION_TACTICAL_LINE];

  const scored: Array<{
    player: Player;
    score: number;
    matchQuality: 'exact_primary' | 'secondary' | 'same_line' | 'fallback';
    isDoubtful: boolean;
  }> = [];

  for (const p of clubPlayers) {
    if (excludePlayerIds.has(p.id)) continue;
    const ev = evaluatePlayerEligibility(p);
    if (!ev.eligible) continue;

    const pPrimary = toCanonicalFc26Position(p.position) ?? p.position.toUpperCase();
    const pSecondary = (p.secondaryPositions ?? [])
      .map((s) => toCanonicalFc26Position(s) ?? s.toUpperCase());
    const pLine = POSITION_TACTICAL_LINE[pPrimary as keyof typeof POSITION_TACTICAL_LINE];

    // Never suggest outfield players for GK or GK for outfield unless no match exists
    if (canonicalSlot === 'GK' && pPrimary !== 'GK') continue;
    if (canonicalSlot !== 'GK' && pPrimary === 'GK') continue;

    let matchQuality: 'exact_primary' | 'secondary' | 'same_line' | 'fallback' = 'fallback';
    let baseScore = 100;
    if (pPrimary === canonicalSlot) {
      matchQuality = 'exact_primary';
      baseScore = 400;
    } else if (pSecondary.includes(canonicalSlot)) {
      matchQuality = 'secondary';
      baseScore = 300;
    } else if (slotLine && pLine === slotLine) {
      matchQuality = 'same_line';
      baseScore = 200;
    }

    const doubtfulPenalty = ev.status === 'conditional_doubtful' ? -40 : 0;
    const ovrBoost = p.overallRating ?? 60;
    scored.push({
      player: p,
      score: baseScore + doubtfulPenalty + ovrBoost,
      matchQuality,
      isDoubtful: ev.status === 'conditional_doubtful',
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((item) => ({
    playerId: item.player.id,
    displayName: resolvePlayerDisplayName(item.player),
    position: item.player.position,
    overallRating: item.player.overallRating,
    matchQuality: item.matchQuality,
    isDoubtful: item.isDoubtful,
  }));
}

export function validateLineupEligibility(params: {
  assignments: ReadonlyArray<{
    slotOrder: number;
    slotId?: string | null;
    positionCode: string;
    playerId: string | null;
    playerDisplayName?: string | null;
  }>;
  benchPlayerIds: readonly string[];
  clubPlayers: readonly Player[];
  confirmedDoubtfulPlayerIds?: readonly string[];
}): LineupEligibilityReport {
  const playerById = new Map<string, Player>(params.clubPlayers.map((p) => [p.id, p]));
  const confirmedDoubtful = new Set(params.confirmedDoubtfulPlayerIds ?? []);
  const seenStarting = new Set<string>();
  const seenAll = new Set<string>();

  const issues: LineupEligibilityIssue[] = [];
  const doubtfulUnconfirmed: LineupEligibilityIssue[] = [];
  const doubtfulConfirmed: LineupEligibilityIssue[] = [];
  let assignedStartersCount = 0;

  for (const a of params.assignments) {
    if (!a.playerId) continue;
    assignedStartersCount += 1;
    const canonicalPos = toCanonicalFc26Position(a.positionCode) ?? a.positionCode.toUpperCase();

    const player = playerById.get(a.playerId);
    if (!player) {
      issues.push({
        scope: 'starting_xi',
        slotOrder: a.slotOrder,
        slotId: a.slotId ?? null,
        positionCode: canonicalPos,
        playerId: a.playerId,
        playerDisplayName: a.playerDisplayName ?? 'Unknown Player',
        code: 'foreign_or_missing_player',
        reason: 'Assigned player does not belong to this club career squad.',
      });
      continue;
    }

    if (seenStarting.has(a.playerId)) {
      issues.push({
        scope: 'starting_xi',
        slotOrder: a.slotOrder,
        slotId: a.slotId ?? null,
        positionCode: canonicalPos,
        playerId: a.playerId,
        playerDisplayName: resolvePlayerDisplayName(player),
        code: 'duplicate_assignment',
        reason: 'Duplicate player assignment in Starting XI.',
      });
      continue;
    }
    seenStarting.add(a.playerId);
    seenAll.add(a.playerId);

    const evalRes = evaluatePlayerEligibility(player);
    if (!evalRes.eligible) {
      issues.push({
        scope: 'starting_xi',
        slotOrder: a.slotOrder,
        slotId: a.slotId ?? null,
        positionCode: canonicalPos,
        playerId: player.id,
        playerDisplayName: resolvePlayerDisplayName(player),
        code: 'ineligible_player',
        reason: evalRes.reasons.join(' '),
      });
    } else if (evalRes.requiresConfirmation) {
      const entry: LineupEligibilityIssue = {
        scope: 'starting_xi',
        slotOrder: a.slotOrder,
        slotId: a.slotId ?? null,
        positionCode: canonicalPos,
        playerId: player.id,
        playerDisplayName: resolvePlayerDisplayName(player),
        code: 'doubtful_player',
        reason: evalRes.reasons.join(' '),
      };
      if (confirmedDoubtful.has(player.id)) {
        doubtfulConfirmed.push(entry);
      } else {
        doubtfulUnconfirmed.push(entry);
      }
    }
  }

  for (const benchId of params.benchPlayerIds) {
    if (!benchId) continue;
    const player = playerById.get(benchId);
    if (!player) {
      issues.push({
        scope: 'bench',
        slotOrder: null,
        slotId: null,
        positionCode: null,
        playerId: benchId,
        playerDisplayName: 'Unknown Player',
        code: 'foreign_or_missing_player',
        reason: 'Bench player does not belong to this club career squad.',
      });
      continue;
    }

    if (seenAll.has(benchId)) {
      issues.push({
        scope: 'bench',
        slotOrder: null,
        slotId: null,
        positionCode: player.position,
        playerId: benchId,
        playerDisplayName: resolvePlayerDisplayName(player),
        code: 'duplicate_assignment',
        reason: seenStarting.has(benchId)
          ? 'Player cannot appear in both Starting XI and Substitutes Bench.'
          : 'Duplicate player on Substitutes Bench.',
      });
      continue;
    }
    seenAll.add(benchId);

    const evalRes = evaluatePlayerEligibility(player);
    if (!evalRes.eligible) {
      issues.push({
        scope: 'bench',
        slotOrder: null,
        slotId: null,
        positionCode: player.position,
        playerId: player.id,
        playerDisplayName: resolvePlayerDisplayName(player),
        code: 'ineligible_player',
        reason: evalRes.reasons.join(' '),
      });
    } else if (evalRes.requiresConfirmation) {
      const entry: LineupEligibilityIssue = {
        scope: 'bench',
        slotOrder: null,
        slotId: null,
        positionCode: player.position,
        playerId: player.id,
        playerDisplayName: resolvePlayerDisplayName(player),
        code: 'doubtful_player',
        reason: evalRes.reasons.join(' '),
      };
      if (confirmedDoubtful.has(player.id)) {
        doubtfulConfirmed.push(entry);
      } else {
        doubtfulUnconfirmed.push(entry);
      }
    }
  }

  return {
    validForMatchReady: issues.length === 0 && doubtfulUnconfirmed.length === 0,
    hasBlockingIssues: issues.length > 0,
    hasUnconfirmedDoubtful: doubtfulUnconfirmed.length > 0,
    assignedStartersCount,
    issues,
    doubtfulUnconfirmed,
    doubtfulConfirmed,
  };
}
