import type Database from 'better-sqlite3';
import type {
  AiGameplayObservationRecord,
  AiMatchTacticalContext,
  AiTacticalRecommendationRecord,
  ConfidenceLevel,
  Player,
  RecommendationPriorityGroup,
} from '../../src/types/domain.ts';
import { normalizeFormationSlotPosition } from '../../src/utils/formationPositions.ts';
import { evaluatePlayerEligibility } from '../../src/utils/squadEligibility.ts';
import { getDb } from '../db/database.ts';
import { getCatalogFormationByIdOrName, listCatalogRoles } from './catalogRepository.ts';
import { listPlayers } from './repository.ts';
import { validatePlayerRoleFocus } from './tacticalContextService.ts';
import {
  normalizeBuildUpStyle,
  normalizeDefensiveApproach,
  normalizeTacticalVisionKey,
} from './tacticalVisionService.ts';

export interface RawAiRecommendationInput {
  priorityGroup: RecommendationPriorityGroup;
  priorityRank: number;
  title: string;
  actionType: AiTacticalRecommendationRecord['actionType'];
  targetSlotId?: string | null;
  targetPositionCode?: string | null;
  currentValue: string;
  proposedValue: string;
  targetPlayerOutId?: string | null;
  targetPlayerInId?: string | null;
  reason: string;
  expectedBenefit: string;
  potentialRisk: string;
  evidenceObservationIds: string[];
  evidenceTimestamps: Array<{
    segmentId: string | null;
    startSeconds: number;
    endSeconds: number;
    inGameClock: string | null;
  }>;
  confidence: ConfidenceLevel;
}

export interface ValidatedAiRecommendationOutput {
  priorityGroup: RecommendationPriorityGroup;
  priorityRank: number;
  title: string;
  actionType: AiTacticalRecommendationRecord['actionType'];
  targetSlotId: string | null;
  targetPositionCode: string | null;
  currentValue: string;
  proposedValue: string;
  targetPlayerOutId: string | null;
  targetPlayerInId: string | null;
  reason: string;
  expectedBenefit: string;
  potentialRisk: string;
  evidenceObservationIds: string[];
  evidenceTimestamps: Array<{
    segmentId: string | null;
    startSeconds: number;
    endSeconds: number;
    inGameClock: string | null;
  }>;
  confidence: ConfidenceLevel;
  validationStatus: 'valid' | 'corrected' | 'invalid_unsupported';
  validationErrors: string[];
  rawAiProposal: Record<string, unknown>;
}

const ALLOWED_BUILD_UP = new Set(['Balanced', 'Counter', 'Short Passing']);
const ALLOWED_DEFENSIVE_APPROACH = new Set(['Deep', 'Balanced', 'High', 'Aggressive']);

function normalizeRoleNameForMatch(name: string): string {
  return name.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

export function validateObservationTimestamps(
  observations: Array<{
    segmentId: string | null;
    startSeconds: number;
    endSeconds: number;
  }>,
  segmentDurationById: Map<string, number>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    if (!Number.isFinite(obs.startSeconds) || !Number.isFinite(obs.endSeconds)) {
      errors.push(`Observation #${i + 1} contains non-numeric timestamps.`);
      continue;
    }
    if (obs.startSeconds < 0 || obs.endSeconds < obs.startSeconds) {
      errors.push(
        `Observation #${i + 1} has invalid timestamp range (${obs.startSeconds}s - ${obs.endSeconds}s).`
      );
      continue;
    }
    if (obs.segmentId && segmentDurationById.has(obs.segmentId)) {
      const maxDur = segmentDurationById.get(obs.segmentId)!;
      if (obs.startSeconds > maxDur + 2 || obs.endSeconds > maxDur + 5) {
        errors.push(
          `Observation #${i + 1} timestamp (${obs.startSeconds}s-${obs.endSeconds}s) exceeds segment duration (${maxDur}s).`
        );
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateAiRecommendations(input: {
  clubId: string;
  matchContext: AiMatchTacticalContext;
  rawRecommendations: RawAiRecommendationInput[];
  observations: AiGameplayObservationRecord[];
  segmentDurationById: Map<string, number>;
  db?: Database.Database;
}): ValidatedAiRecommendationOutput[] {
  const db = input.db ?? getDb();
  const clubPlayers: Player[] = listPlayers(input.clubId);
  const playerById = new Map<string, Player>(clubPlayers.map((p) => [p.id, p]));
  const startingXiPlayerIds = new Set(
    input.matchContext.startingXi
      .map((s) => s.playerId)
      .filter((id): id is string => Boolean(id))
  );
  const validObservationIds = new Set(input.observations.map((o) => o.id));

  return input.rawRecommendations.map((raw) => {
    const errors: string[] = [];
    let corrected = false;
    let proposedValue = raw.proposedValue.trim();
    let targetPositionCode = raw.targetPositionCode ? raw.targetPositionCode.trim().toUpperCase() : null;
    const targetSlotId = raw.targetSlotId ? raw.targetSlotId.trim() : null;
    const targetPlayerOutId = raw.targetPlayerOutId ? raw.targetPlayerOutId.trim() : null;
    const targetPlayerInId = raw.targetPlayerInId ? raw.targetPlayerInId.trim() : null;

    // 1. Validate Evidence Observation IDs (reject fabricated observation IDs)
    const verifiedObsIds: string[] = [];
    for (const obsId of raw.evidenceObservationIds ?? []) {
      if (validObservationIds.has(obsId)) {
        verifiedObsIds.push(obsId);
      } else {
        errors.push(`Referenced observation ID "${obsId}" does not exist in extracted match observations.`);
      }
    }

    // 2. Validate Evidence Timestamp Bounds
    const verifiedTimestamps: RawAiRecommendationInput['evidenceTimestamps'] = [];
    for (const ts of raw.evidenceTimestamps ?? []) {
      if (!Number.isFinite(ts.startSeconds) || ts.startSeconds < 0 || ts.endSeconds < ts.startSeconds) {
        errors.push(`Invalid evidence timestamp range (${ts.startSeconds}s-${ts.endSeconds}s).`);
        continue;
      }
      if (ts.segmentId && input.segmentDurationById.has(ts.segmentId)) {
        const dur = input.segmentDurationById.get(ts.segmentId)!;
        if (ts.startSeconds > dur + 2 || ts.endSeconds > dur + 5) {
          errors.push(`Evidence timestamp (${ts.startSeconds}s-${ts.endSeconds}s) exceeds segment duration (${dur}s).`);
          continue;
        }
      }
      verifiedTimestamps.push(ts);
    }

    // 3. Action-type specific deterministic FC26 validation
    if (raw.actionType === 'build_up_style') {
      const norm = normalizeBuildUpStyle(proposedValue);
      if (!ALLOWED_BUILD_UP.has(norm)) {
        errors.push(
          `Unsupported FC26 Build-Up Style "${proposedValue}". Allowed: Balanced, Counter, Short Passing (Close Support).`
        );
      } else if (norm !== proposedValue) {
        proposedValue = norm;
        corrected = true;
      }
    } else if (raw.actionType === 'defensive_approach') {
      const norm = normalizeDefensiveApproach(proposedValue);
      if (!ALLOWED_DEFENSIVE_APPROACH.has(norm)) {
        errors.push(
          `Unsupported FC26 Defensive Approach "${proposedValue}". Allowed: Deep, Balanced, High, Aggressive.`
        );
      } else if (norm !== proposedValue) {
        proposedValue = norm;
        corrected = true;
      }
    } else if (raw.actionType === 'defensive_line_height') {
      const numericMatch = proposedValue.match(/\d+/);
      const parsedNum = numericMatch ? Number(numericMatch[0]) : NaN;
      if (!Number.isFinite(parsedNum) || parsedNum < 1 || parsedNum > 100) {
        errors.push(`Defensive Line Height "${proposedValue}" must be an integer between 1 and 100.`);
      } else if (String(parsedNum) !== proposedValue) {
        proposedValue = String(parsedNum);
        corrected = true;
      }
    } else if (raw.actionType === 'formation_change') {
      const foundFormation = getCatalogFormationByIdOrName(proposedValue, db);
      if (!foundFormation) {
        errors.push(
          `Proposed formation "${proposedValue}" does not exist in the verified FC26 formations catalog.`
        );
      } else if (foundFormation.name !== proposedValue) {
        proposedValue = foundFormation.name;
        corrected = true;
      }
    } else if (raw.actionType === 'tactical_vision_change') {
      const normKey = normalizeTacticalVisionKey(proposedValue, db);
      if (normKey === 'unspecified') {
        errors.push(
          `Proposed Tactical Vision "${proposedValue}" is not one of the 7 official EA SPORTS FC 26 Tactical Visions.`
        );
      } else if (normKey !== proposedValue) {
        proposedValue = normKey;
        corrected = true;
      }
    } else if (raw.actionType === 'player_role' || raw.actionType === 'player_focus') {
      if (!targetPositionCode) {
        errors.push('Role/Focus recommendation must specify a canonical FC26 targetPositionCode.');
      } else {
        const posNorm = normalizeFormationSlotPosition(targetPositionCode, targetSlotId);
        if (!posNorm.ok) {
          errors.push(posNorm.error ?? `Unrecognized FC26 position "${targetPositionCode}".`);
        } else {
          if (posNorm.canonicalPosition !== targetPositionCode) {
            targetPositionCode = posNorm.canonicalPosition;
            corrected = true;
          }

          // Parse "Role (Focus)" or "Role / Focus" or plain "Role" / "Focus"
          let proposedRole = '';
          let proposedFocus = '';
          if (raw.actionType === 'player_role') {
            const parenMatch = proposedValue.match(/^(.+?)\s*\((.+?)\)$/);
            if (parenMatch) {
              proposedRole = parenMatch[1].trim();
              proposedFocus = parenMatch[2].trim();
            } else {
              proposedRole = proposedValue;
            }

            // Bounded normalization against catalog roles for this position (e.g., "Centre Half" -> "Centre-Half")
            const legalRoles = listCatalogRoles(targetPositionCode, db);
            const matchedRole = legalRoles.find(
              (r) => normalizeRoleNameForMatch(r.name) === normalizeRoleNameForMatch(proposedRole)
            );
            if (matchedRole && matchedRole.name !== proposedRole) {
              proposedRole = matchedRole.name;
              proposedValue = proposedFocus ? `${proposedRole} (${proposedFocus})` : proposedRole;
              corrected = true;
            }
          } else {
            // player_focus change on an existing slot's role
            const slot = input.matchContext.startingXi.find(
              (s) =>
                (targetSlotId && s.slotId === targetSlotId) ||
                s.positionCode.toUpperCase() === targetPositionCode
            );
            proposedRole = slot?.assignedRole ?? '';
            proposedFocus = proposedValue;
          }

          const check = validatePlayerRoleFocus(targetPositionCode, proposedRole, proposedFocus, db);
          if (!check.valid) {
            errors.push(
              check.reason ??
                `Invalid FC IQ Role/Focus "${proposedValue}" for position ${targetPositionCode}.`
            );
          }
        }
      }
    } else if (raw.actionType === 'substitution') {
      if (!targetPlayerInId) {
        errors.push('Substitution recommendation is missing a valid targetPlayerInId from the active club squad.');
      } else {
        const playerIn = playerById.get(targetPlayerInId);
        if (!playerIn) {
          errors.push(`Proposed incoming player ID "${targetPlayerInId}" does not belong to this Career Mode club.`);
        } else {
          const elig = evaluatePlayerEligibility(playerIn);
          if (!elig.eligible) {
            errors.push(
              `Proposed substitute ${playerIn.displayName} is ineligible (${elig.reasons.join('; ') || playerIn.squadStatus}).`
            );
          }
          if (startingXiPlayerIds.has(playerIn.id) && playerIn.id !== targetPlayerOutId) {
            errors.push(
              `Proposed substitute ${playerIn.displayName} is already assigned in the Starting XI (duplicate assignment prevented).`
            );
          }
        }
      }

      if (targetPlayerOutId) {
        const playerOut = playerById.get(targetPlayerOutId);
        if (!playerOut) {
          errors.push(`Outgoing player ID "${targetPlayerOutId}" was not found in the active club squad.`);
        } else if (!startingXiPlayerIds.has(playerOut.id)) {
          errors.push(
            `Outgoing player ${playerOut.displayName} is not currently in the Starting XI snapshot.`
          );
        }
      }
    }

    // Determine final status: NEVER silently replace unresolvable invalid items
    let validationStatus: 'valid' | 'corrected' | 'invalid_unsupported' = 'valid';
    if (errors.length > 0) {
      validationStatus = 'invalid_unsupported';
    } else if (corrected) {
      validationStatus = 'corrected';
    }

    return {
      priorityGroup: raw.priorityGroup,
      priorityRank: raw.priorityRank,
      title: raw.title.trim(),
      actionType: raw.actionType,
      targetSlotId,
      targetPositionCode,
      currentValue: raw.currentValue.trim(),
      proposedValue,
      targetPlayerOutId,
      targetPlayerInId,
      reason: raw.reason.trim(),
      expectedBenefit: raw.expectedBenefit.trim(),
      potentialRisk: raw.potentialRisk.trim(),
      evidenceObservationIds: verifiedObsIds,
      evidenceTimestamps: verifiedTimestamps,
      confidence: raw.confidence,
      validationStatus,
      validationErrors: errors,
      rawAiProposal: raw as unknown as Record<string, unknown>,
    };
  });
}
