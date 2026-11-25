import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  ClubCoachRecord,
  Player,
  PlayerRoleFamiliarityRecord,
  RoleAffinityStatus,
  RoleFamiliarityTier,
  TacticalVisionAliasRecord,
  TacticalVisionCatalogResponse,
  TacticalVisionKey,
  TacticalVisionRecord,
  TacticalVisionRequirementRecord,
  TacticalVisionRoleAffinityRecord,
  TacticalVisionSettingAffinityRecord,
  TacticalVisionShortCode,
  TacticalVisionSourceRecord,
  TacticalVisionSourceType,
  ThreeLayerTacticalEvaluation,
  VisionOptimizationMode,
  VisionOptimizationProposalItem,
  VisionOptimizationResult,
} from '../../src/types/domain.ts';
import { normalizeFormationSlotPosition } from '../../src/utils/formationPositions.ts';
import { evaluatePlayerEligibility, validateLineupEligibility } from '../../src/utils/squadEligibility.ts';
import { getDb } from '../db/database.ts';
import {
  getCatalogFormationByIdOrName,
  listCatalogFocuses,
  listCatalogFormations,
  listCatalogRoles,
} from './catalogRepository.ts';
import { listPlayers } from './repository.ts';
import { validatePlayerRoleFocus } from './tacticalContextService.ts';

interface TacticalVisionSeedFile {
  datasetVersion: string;
  lastVerifiedAt: string;
  sources: Array<{
    sourceKey: string;
    title: string;
    url: string;
    sourceType: TacticalVisionSourceType;
    reliabilityTier: string;
    notes: string;
    conflictResolutions: Array<{ topic: string; conflict: string; resolution: string }>;
    verifiedAt: string;
  }>;
  visions: Array<{
    id: string;
    internalKey: TacticalVisionKey;
    shortCode: TacticalVisionShortCode;
    displayName: string;
    description: string;
    attackingPrinciples: string[];
    defensivePrinciples: string[];
    transitionPrinciples: string[];
    strengths: string[];
    weaknesses: string[];
    evaluationCriteria: string[];
    aliases: Array<{
      aliasKey: string;
      aliasLabel: string;
      aliasType: string;
      notes: string;
    }>;
    officialRequirements: Array<{
      parameterType: 'build_up_style' | 'defensive_approach';
      allowedValues: string[];
      canonicalInGameLabels: string[];
      isMandatory: boolean;
      sourceType: TacticalVisionSourceType;
      sourceReference: string;
      verificationStatus: string;
      conflictNotes: string;
    }>;
    sourceType: TacticalVisionSourceType;
    sourceReferences: string[];
    verificationStatus: string;
  }>;
  roleAffinityMatrix: Array<{
    positions: string[];
    roleName: string;
    visions: TacticalVisionShortCode[];
  }>;
  referenceBuildUpAffinities: Array<{
    settingValue: string;
    visions: TacticalVisionShortCode[];
  }>;
  referenceDefensiveHeightAffinities: Array<{
    settingValue: string;
    visions: TacticalVisionShortCode[];
  }>;
}

const VALID_VISION_KEYS: TacticalVisionKey[] = [
  'standard',
  'wing_play',
  'possession',
  'high_pressing',
  'park_the_bus',
  'counter_attack',
  'kick_and_rush',
];

const STATIC_VISION_ALIAS_MAP: Record<string, TacticalVisionKey> = {
  standard: 'standard',
  s: 'standard',
  balanced: 'standard',
  standard_vision: 'standard',
  wing_play: 'wing_play',
  'wing-play': 'wing_play',
  'wing play': 'wing_play',
  wingplay: 'wing_play',
  w: 'wing_play',
  possession: 'possession',
  possession_play: 'possession',
  'possession play': 'possession',
  tiki_taka: 'possession',
  'tiki-taka': 'possession',
  'tiki taka': 'possession',
  tikitaka: 'possession',
  p: 'possession',
  high_pressing: 'high_pressing',
  'high-pressing': 'high_pressing',
  'high pressing': 'high_pressing',
  high_press: 'high_pressing',
  'high press': 'high_pressing',
  gegenpressing: 'high_pressing',
  gegenpress: 'high_pressing',
  h: 'high_pressing',
  park_the_bus: 'park_the_bus',
  'park-the-bus': 'park_the_bus',
  'park the bus': 'park_the_bus',
  low_block: 'park_the_bus',
  'low block': 'park_the_bus',
  b: 'park_the_bus',
  counter_attack: 'counter_attack',
  'counter-attack': 'counter_attack',
  'counter attack': 'counter_attack',
  counter_attacking: 'counter_attack',
  'counter attacking': 'counter_attack',
  c: 'counter_attack',
  kick_and_rush: 'kick_and_rush',
  'kick-and-rush': 'kick_and_rush',
  'kick and rush': 'kick_and_rush',
  'kick_&_rush': 'kick_and_rush',
  'kick & rush': 'kick_and_rush',
  direct_play: 'kick_and_rush',
  'direct play': 'kick_and_rush',
  k: 'kick_and_rush',
};

function resolveDb(db?: Database.Database): Database.Database {
  return db ?? getDb();
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeRoleLookupKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function normalizeBuildUpStyle(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  if (cleaned === 'short passing' || cleaned === 'close support') return 'Short Passing';
  if (cleaned === 'counter' || cleaned === 'counter attack') return 'Counter';
  if (cleaned === 'balanced' || cleaned === 'standard') return 'Balanced';
  return raw.trim() || 'Balanced';
}

export function normalizeDefensiveApproach(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  if (cleaned === 'deep' || cleaned === 'low') return 'Deep';
  if (cleaned === 'balanced' || cleaned === 'standard') return 'Balanced';
  if (cleaned === 'high') return 'High';
  if (cleaned === 'aggressive' || cleaned === 'extreme') return 'Aggressive';
  return raw.trim() || 'Balanced';
}

export function isValidTacticalVisionKey(val: string): val is TacticalVisionKey {
  return VALID_VISION_KEYS.includes(val as TacticalVisionKey);
}

export function normalizeTacticalVisionKey(
  input: string | null | undefined,
  dbArg?: Database.Database
): TacticalVisionKey | 'unspecified' {
  if (!input || !input.trim()) return 'unspecified';
  const raw = input.trim().toLowerCase();
  if (raw === 'unspecified' || raw === 'none' || raw === 'unknown') return 'unspecified';

  const normalizedSpace = raw.replace(/\s+/g, ' ');
  const normalizedSnake = normalizedSpace.replace(/[\s-]+/g, '_');

  if (STATIC_VISION_ALIAS_MAP[raw]) return STATIC_VISION_ALIAS_MAP[raw];
  if (STATIC_VISION_ALIAS_MAP[normalizedSpace]) return STATIC_VISION_ALIAS_MAP[normalizedSpace];
  if (STATIC_VISION_ALIAS_MAP[normalizedSnake]) return STATIC_VISION_ALIAS_MAP[normalizedSnake];

  // Fallback to database aliases table if available
  if (dbArg) {
    try {
      const aliasRow = dbArg
        .prepare(
          `SELECT tv.internal_key
           FROM catalog_tactical_vision_aliases a
           JOIN catalog_tactical_visions tv ON tv.id = a.vision_id
           WHERE LOWER(a.alias_key) = LOWER(?) OR LOWER(a.alias_label) = LOWER(?)
           LIMIT 1`
        )
        .get(normalizedSnake, normalizedSpace) as { internal_key: string } | undefined;
      if (aliasRow && isValidTacticalVisionKey(aliasRow.internal_key)) {
        return aliasRow.internal_key;
      }
    } catch {
      // Table may not exist yet during early boot
    }
  }

  return 'unspecified';
}

function resolveTacticalVisionDatasetPath(): string | null {
  const candidates = [
    process.env.FC26_RESOURCES_DIR
      ? path.join(process.env.FC26_RESOURCES_DIR, 'data', 'fc26', 'tactical_visions', 'tactical_visions.json')
      : null,
    path.resolve(process.cwd(), 'data', 'fc26', 'tactical_visions', 'tactical_visions.json'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function seedTacticalVisionCatalog(dbArg?: Database.Database): {
  seeded: boolean;
  datasetVersion: string;
  visionCount: number;
  roleAffinityCount: number;
  settingAffinityCount: number;
} {
  const db = resolveDb(dbArg);
  const filePath = resolveTacticalVisionDatasetPath();
  if (!filePath) {
    return {
      seeded: false,
      datasetVersion: 'missing',
      visionCount: 0,
      roleAffinityCount: 0,
      settingAffinityCount: 0,
    };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const dataset = JSON.parse(raw) as TacticalVisionSeedFile;
  const now = new Date().toISOString();

  // Map normalized catalog_player_roles names -> role IDs for foreign-key linking
  const roleRows = db.prepare('SELECT id, name FROM catalog_player_roles').all() as Array<{
    id: string;
    name: string;
  }>;
  const roleIdByNormalized = new Map<string, string>();
  for (const r of roleRows) {
    roleIdByNormalized.set(normalizeRoleLookupKey(r.name), r.id);
  }

  const visionByShortCode = new Map<TacticalVisionShortCode, TacticalVisionSeedFile['visions'][number]>();
  for (const v of dataset.visions) {
    visionByShortCode.set(v.shortCode, v);
  }

  let roleAffinityCount = 0;
  let settingAffinityCount = 0;

  const tx = db.transaction(() => {
    const upsertSource = db.prepare(`
      INSERT INTO catalog_tactical_vision_sources (
        id, source_key, title, url, source_type, reliability_tier, notes, conflict_resolutions_json, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        source_type = excluded.source_type,
        reliability_tier = excluded.reliability_tier,
        notes = excluded.notes,
        conflict_resolutions_json = excluded.conflict_resolutions_json,
        verified_at = excluded.verified_at
    `);

    for (const s of dataset.sources) {
      upsertSource.run(
        `tvsrc_${s.sourceKey}`,
        s.sourceKey,
        s.title,
        s.url,
        s.sourceType,
        s.reliabilityTier,
        s.notes,
        JSON.stringify(s.conflictResolutions ?? []),
        s.verifiedAt
      );
    }

    const upsertVision = db.prepare(`
      INSERT INTO catalog_tactical_visions (
        id, internal_key, short_code, display_name, description,
        attacking_principles_json, defensive_principles_json, transition_principles_json,
        strengths_json, weaknesses_json, evaluation_criteria_json,
        source_type, source_references_json, dataset_version, verification_status,
        last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(internal_key) DO UPDATE SET
        short_code = excluded.short_code,
        display_name = excluded.display_name,
        description = excluded.description,
        attacking_principles_json = excluded.attacking_principles_json,
        defensive_principles_json = excluded.defensive_principles_json,
        transition_principles_json = excluded.transition_principles_json,
        strengths_json = excluded.strengths_json,
        weaknesses_json = excluded.weaknesses_json,
        evaluation_criteria_json = excluded.evaluation_criteria_json,
        source_type = excluded.source_type,
        source_references_json = excluded.source_references_json,
        dataset_version = excluded.dataset_version,
        verification_status = excluded.verification_status,
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at
    `);

    const upsertAlias = db.prepare(`
      INSERT INTO catalog_tactical_vision_aliases (
        id, vision_id, alias_key, alias_label, alias_type, notes
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(vision_id, alias_key) DO UPDATE SET
        alias_label = excluded.alias_label,
        alias_type = excluded.alias_type,
        notes = excluded.notes
    `);

    const upsertRequirement = db.prepare(`
      INSERT INTO catalog_tactical_vision_requirements (
        id, vision_id, parameter_type, allowed_values_json, canonical_in_game_labels_json,
        is_mandatory, source_type, source_reference, verification_status, conflict_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vision_id, parameter_type) DO UPDATE SET
        allowed_values_json = excluded.allowed_values_json,
        canonical_in_game_labels_json = excluded.canonical_in_game_labels_json,
        is_mandatory = excluded.is_mandatory,
        source_type = excluded.source_type,
        source_reference = excluded.source_reference,
        verification_status = excluded.verification_status,
        conflict_notes = excluded.conflict_notes
    `);

    for (const v of dataset.visions) {
      upsertVision.run(
        v.id,
        v.internalKey,
        v.shortCode,
        v.displayName,
        v.description,
        JSON.stringify(v.attackingPrinciples),
        JSON.stringify(v.defensivePrinciples),
        JSON.stringify(v.transitionPrinciples),
        JSON.stringify(v.strengths),
        JSON.stringify(v.weaknesses),
        JSON.stringify(v.evaluationCriteria),
        v.sourceType,
        JSON.stringify(v.sourceReferences),
        dataset.datasetVersion,
        v.verificationStatus,
        dataset.lastVerifiedAt,
        now,
        now
      );

      for (const a of v.aliases) {
        upsertAlias.run(
          `tva_${v.internalKey}_${a.aliasKey}`,
          v.id,
          a.aliasKey,
          a.aliasLabel,
          a.aliasType,
          a.notes
        );
      }

      for (const req of v.officialRequirements) {
        upsertRequirement.run(
          `tvreq_${v.internalKey}_${req.parameterType}`,
          v.id,
          req.parameterType,
          JSON.stringify(req.allowedValues),
          JSON.stringify(req.canonicalInGameLabels),
          req.isMandatory ? 1 : 0,
          req.sourceType,
          req.sourceReference,
          req.verificationStatus,
          req.conflictNotes
        );
      }
    }

    // Seed Role Affinity Matrix (all 37 rows expanded per canonical position and per 7 visions)
    const upsertRoleAff = db.prepare(`
      INSERT INTO catalog_tactical_vision_role_affinities (
        id, vision_id, position_code, role_id, role_name, affinity_status,
        source_type, source_reference, dataset_version, verification_status
      ) VALUES (?, ?, ?, ?, ?, ?, 'user_provided_matrix', 'user_provided_fc26_vision_matrix', ?, 'secondary_reference')
      ON CONFLICT(vision_id, position_code, role_name) DO UPDATE SET
        role_id = excluded.role_id,
        affinity_status = excluded.affinity_status,
        dataset_version = excluded.dataset_version,
        verification_status = excluded.verification_status
    `);

    for (const row of dataset.roleAffinityMatrix) {
      const matchedRoleId = roleIdByNormalized.get(normalizeRoleLookupKey(row.roleName)) ?? null;
      const assocSet = new Set(row.visions);

      for (const pos of row.positions) {
        for (const v of dataset.visions) {
          const status: RoleAffinityStatus = assocSet.has(v.shortCode)
            ? 'associated'
            : 'not_associated';
          const slug = normalizeRoleLookupKey(row.roleName).replace(/\s+/g, '_');
          upsertRoleAff.run(
            `tvra_${v.internalKey}_${pos}_${slug}`,
            v.id,
            pos,
            matchedRoleId,
            row.roleName,
            status,
            dataset.datasetVersion
          );
          roleAffinityCount += 1;
        }
      }
    }

    // Seed Reference Build-Up & Defensive Height Setting Affinities with explicit official-conflict detection
    const upsertSettingAff = db.prepare(`
      INSERT INTO catalog_tactical_vision_setting_affinities (
        id, vision_id, setting_type, setting_value, is_associated,
        source_type, source_reference, conflict_with_official, conflict_note, dataset_version
      ) VALUES (?, ?, ?, ?, ?, 'user_provided_matrix', 'user_provided_fc26_vision_matrix', ?, ?, ?)
      ON CONFLICT(vision_id, setting_type, setting_value) DO UPDATE SET
        is_associated = excluded.is_associated,
        conflict_with_official = excluded.conflict_with_official,
        conflict_note = excluded.conflict_note,
        dataset_version = excluded.dataset_version
    `);

    for (const row of dataset.referenceBuildUpAffinities) {
      const assocSet = new Set(row.visions);
      const normSetting = normalizeBuildUpStyle(row.settingValue);

      for (const v of dataset.visions) {
        const isAssociated = assocSet.has(v.shortCode);
        const officialBuildUpReq = v.officialRequirements.find(
          (r) => r.parameterType === 'build_up_style' && r.isMandatory
        );

        let conflict = false;
        let conflictNote = '';
        if (officialBuildUpReq) {
          const officialAllowed = officialBuildUpReq.allowedValues.map(normalizeBuildUpStyle);
          const isOfficiallyAllowed = officialAllowed.includes(normSetting);
          if (isAssociated && !isOfficiallyAllowed) {
            conflict = true;
            conflictNote = `Matrix marks "${row.settingValue}" for ${v.displayName}, but official FC26 Career Mode rules require Build-Up Style: ${officialBuildUpReq.canonicalInGameLabels.join(' or ')}. Official Layer 2 rules take precedence.`;
          } else if (!isAssociated && isOfficiallyAllowed) {
            conflict = true;
            conflictNote = `Matrix omits "${row.settingValue}" for ${v.displayName}, whereas official FC26 Career Mode rules permit it.`;
          }
        }

        const slug = row.settingValue.toLowerCase().replace(/\s+/g, '_');
        upsertSettingAff.run(
          `tvsa_${v.internalKey}_buildup_${slug}`,
          v.id,
          'build_up_style',
          row.settingValue,
          isAssociated ? 1 : 0,
          conflict ? 1 : 0,
          conflictNote,
          dataset.datasetVersion
        );
        settingAffinityCount += 1;
      }
    }

    for (const row of dataset.referenceDefensiveHeightAffinities) {
      const assocSet = new Set(row.visions);
      const normSetting = normalizeDefensiveApproach(row.settingValue);

      for (const v of dataset.visions) {
        const isAssociated = assocSet.has(v.shortCode);
        const officialDefReq = v.officialRequirements.find(
          (r) => r.parameterType === 'defensive_approach' && r.isMandatory
        );

        let conflict = false;
        let conflictNote = '';
        if (officialDefReq) {
          const officialAllowed = officialDefReq.allowedValues.map(normalizeDefensiveApproach);
          const isOfficiallyAllowed = officialAllowed.includes(normSetting);
          if (isAssociated && !isOfficiallyAllowed) {
            conflict = true;
            conflictNote = `Matrix marks "${row.settingValue}" for ${v.displayName}, but official FC26 Career Mode rules require Defensive Approach: ${officialDefReq.canonicalInGameLabels.join(' or ')}. Official Layer 2 rules take precedence.`;
          } else if (!isAssociated && isOfficiallyAllowed) {
            conflict = true;
            conflictNote = `Matrix omits "${row.settingValue}" for ${v.displayName}, whereas official FC26 Career Mode rules permit it.`;
          }
        }

        const slug = row.settingValue.toLowerCase().replace(/\s+/g, '_');
        upsertSettingAff.run(
          `tvsa_${v.internalKey}_def_${slug}`,
          v.id,
          'defensive_height',
          row.settingValue,
          isAssociated ? 1 : 0,
          conflict ? 1 : 0,
          conflictNote,
          dataset.datasetVersion
        );
        settingAffinityCount += 1;
      }
    }
  });

  tx();

  return {
    seeded: true,
    datasetVersion: dataset.datasetVersion,
    visionCount: dataset.visions.length,
    roleAffinityCount,
    settingAffinityCount,
  };
}

export function getTacticalVisionCatalog(dbArg?: Database.Database): TacticalVisionCatalogResponse {
  const db = resolveDb(dbArg);

  const visionRows = db
    .prepare('SELECT * FROM catalog_tactical_visions ORDER BY CASE internal_key WHEN \'standard\' THEN 1 WHEN \'wing_play\' THEN 2 WHEN \'possession\' THEN 3 WHEN \'high_pressing\' THEN 4 WHEN \'park_the_bus\' THEN 5 WHEN \'counter_attack\' THEN 6 WHEN \'kick_and_rush\' THEN 7 ELSE 99 END')
    .all() as Array<Record<string, unknown>>;

  const aliasRows = db
    .prepare('SELECT * FROM catalog_tactical_vision_aliases ORDER BY alias_label ASC')
    .all() as Array<Record<string, unknown>>;

  const reqRows = db
    .prepare('SELECT * FROM catalog_tactical_vision_requirements')
    .all() as Array<Record<string, unknown>>;

  const roleAffRows = db
    .prepare(`
      SELECT ra.*, tv.internal_key as vision_key
      FROM catalog_tactical_vision_role_affinities ra
      JOIN catalog_tactical_visions tv ON tv.id = ra.vision_id
      ORDER BY ra.position_code ASC, ra.role_name ASC
    `)
    .all() as Array<Record<string, unknown>>;

  const settingAffRows = db
    .prepare(`
      SELECT sa.*, tv.internal_key as vision_key
      FROM catalog_tactical_vision_setting_affinities sa
      JOIN catalog_tactical_visions tv ON tv.id = sa.vision_id
      ORDER BY sa.setting_type ASC, sa.setting_value ASC
    `)
    .all() as Array<Record<string, unknown>>;

  const sourceRows = db
    .prepare('SELECT * FROM catalog_tactical_vision_sources ORDER BY reliability_tier ASC, title ASC')
    .all() as Array<Record<string, unknown>>;

  const aliasesByVision = new Map<string, TacticalVisionAliasRecord[]>();
  for (const r of aliasRows) {
    const vid = String(r.vision_id);
    const arr = aliasesByVision.get(vid) ?? [];
    arr.push({
      id: String(r.id),
      visionId: vid,
      aliasKey: String(r.alias_key),
      aliasLabel: String(r.alias_label),
      aliasType: String(r.alias_type),
      notes: String(r.notes ?? ''),
    });
    aliasesByVision.set(vid, arr);
  }

  const reqsByVision = new Map<string, TacticalVisionRequirementRecord[]>();
  for (const r of reqRows) {
    const vid = String(r.vision_id);
    const arr = reqsByVision.get(vid) ?? [];
    arr.push({
      id: String(r.id),
      visionId: vid,
      parameterType: String(r.parameter_type) as 'build_up_style' | 'defensive_approach',
      allowedValues: safeJsonParse<string[]>(String(r.allowed_values_json), []),
      canonicalInGameLabels: safeJsonParse<string[]>(String(r.canonical_in_game_labels_json), []),
      isMandatory: Boolean(r.is_mandatory),
      sourceType: String(r.source_type) as TacticalVisionSourceType,
      sourceReference: String(r.source_reference ?? ''),
      verificationStatus: String(r.verification_status ?? 'verified'),
      conflictNotes: String(r.conflict_notes ?? ''),
    });
    reqsByVision.set(vid, arr);
  }

  const visions: TacticalVisionRecord[] = visionRows.map((r) => {
    const id = String(r.id);
    return {
      id,
      internalKey: String(r.internal_key) as TacticalVisionKey,
      shortCode: String(r.short_code) as TacticalVisionShortCode,
      displayName: String(r.display_name),
      description: String(r.description ?? ''),
      attackingPrinciples: safeJsonParse<string[]>(String(r.attacking_principles_json), []),
      defensivePrinciples: safeJsonParse<string[]>(String(r.defensive_principles_json), []),
      transitionPrinciples: safeJsonParse<string[]>(String(r.transition_principles_json), []),
      strengths: safeJsonParse<string[]>(String(r.strengths_json), []),
      weaknesses: safeJsonParse<string[]>(String(r.weaknesses_json), []),
      evaluationCriteria: safeJsonParse<string[]>(String(r.evaluation_criteria_json), []),
      sourceType: String(r.source_type) as TacticalVisionSourceType,
      sourceReferences: safeJsonParse<string[]>(String(r.source_references_json), []),
      datasetVersion: String(r.dataset_version ?? 'fc26-tactical-visions-3.0.0'),
      verificationStatus: String(r.verification_status ?? 'verified'),
      lastVerifiedAt: String(r.last_verified_at ?? ''),
      aliases: aliasesByVision.get(id) ?? [],
      officialRequirements: reqsByVision.get(id) ?? [],
    };
  });

  const roleAffinities: TacticalVisionRoleAffinityRecord[] = roleAffRows.map((r) => ({
    id: String(r.id),
    visionId: String(r.vision_id),
    visionKey: String(r.vision_key) as TacticalVisionKey,
    positionCode: String(r.position_code),
    roleId: r.role_id ? String(r.role_id) : null,
    roleName: String(r.role_name),
    affinityStatus: String(r.affinity_status) as RoleAffinityStatus,
    sourceType: String(r.source_type) as TacticalVisionSourceType,
    sourceReference: String(r.source_reference ?? ''),
    datasetVersion: String(r.dataset_version ?? 'fc26-tactical-visions-3.0.0'),
    verificationStatus: String(r.verification_status ?? 'secondary_reference'),
  }));

  const settingAffinities: TacticalVisionSettingAffinityRecord[] = settingAffRows.map((r) => ({
    id: String(r.id),
    visionId: String(r.vision_id),
    visionKey: String(r.vision_key) as TacticalVisionKey,
    settingType: String(r.setting_type) as 'build_up_style' | 'defensive_height',
    settingValue: String(r.setting_value),
    isAssociated: Boolean(r.is_associated),
    sourceType: String(r.source_type) as TacticalVisionSourceType,
    sourceReference: String(r.source_reference ?? ''),
    conflictWithOfficial: Boolean(r.conflict_with_official),
    conflictNote: String(r.conflict_note ?? ''),
    datasetVersion: String(r.dataset_version ?? 'fc26-tactical-visions-3.0.0'),
  }));

  const sources: TacticalVisionSourceRecord[] = sourceRows.map((r) => ({
    id: String(r.id),
    sourceKey: String(r.source_key),
    title: String(r.title),
    url: String(r.url ?? ''),
    sourceType: String(r.source_type) as TacticalVisionSourceType,
    reliabilityTier: String(r.reliability_tier ?? 'secondary_reference'),
    notes: String(r.notes ?? ''),
    conflictResolutions: safeJsonParse<
      Array<{ topic: string; conflict: string; resolution: string }>
    >(String(r.conflict_resolutions_json), []),
    verifiedAt: String(r.verified_at ?? ''),
  }));

  return {
    datasetVersion: visions[0]?.datasetVersion ?? 'fc26-tactical-visions-3.0.0',
    lastVerifiedAt: visions[0]?.lastVerifiedAt ?? '',
    visions,
    roleAffinities,
    settingAffinities,
    sources,
  };
}

export function getTacticalVisionByKey(
  keyOrAlias: string,
  dbArg?: Database.Database
): TacticalVisionRecord | null {
  const db = resolveDb(dbArg);
  const normalized = normalizeTacticalVisionKey(keyOrAlias, db);
  if (normalized === 'unspecified') return null;
  const catalog = getTacticalVisionCatalog(db);
  return catalog.visions.find((v) => v.internalKey === normalized) ?? null;
}

// ============================================================
// Coaching Staff & Player Role Familiarity CRUD
// ============================================================

export function listClubCoaches(clubId: string, dbArg?: Database.Database): ClubCoachRecord[] {
  const db = resolveDb(dbArg);
  const rows = db
    .prepare('SELECT * FROM club_coaches WHERE club_id = ? ORDER BY department ASC, star_rating DESC, name ASC')
    .all(clubId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    clubId: String(r.club_id),
    name: String(r.name),
    department: String(r.department) as ClubCoachRecord['department'],
    tacticalVisionKey: (isValidTacticalVisionKey(String(r.tactical_vision_key))
      ? String(r.tactical_vision_key)
      : 'standard') as TacticalVisionKey,
    qualificationLevel: String(r.qualification_level) as ClubCoachRecord['qualificationLevel'],
    starRating: Number(r.star_rating ?? 3),
    notes: String(r.notes ?? ''),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function upsertClubCoach(
  clubId: string,
  input: {
    id?: string;
    name: string;
    department: ClubCoachRecord['department'];
    tacticalVisionKey: string;
    qualificationLevel: ClubCoachRecord['qualificationLevel'];
    starRating: number;
    notes?: string;
  },
  dbArg?: Database.Database
): ClubCoachRecord {
  const db = resolveDb(dbArg);
  const id = input.id?.trim() || crypto.randomUUID();
  const now = new Date().toISOString();
  const normVision = normalizeTacticalVisionKey(input.tacticalVisionKey, db);
  const visionKey: TacticalVisionKey = normVision === 'unspecified' ? 'standard' : normVision;
  const clampedStars = Math.max(1, Math.min(5, Math.round(input.starRating)));

  db.prepare(`
    INSERT INTO club_coaches (
      id, club_id, name, department, tactical_vision_key, qualification_level, star_rating, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      department = excluded.department,
      tactical_vision_key = excluded.tactical_vision_key,
      qualification_level = excluded.qualification_level,
      star_rating = excluded.star_rating,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    id,
    clubId,
    input.name.trim(),
    input.department,
    visionKey,
    input.qualificationLevel,
    clampedStars,
    (input.notes ?? '').trim(),
    now,
    now
  );

  return listClubCoaches(clubId, db).find((c) => c.id === id)!;
}

export function deleteClubCoach(coachId: string, dbArg?: Database.Database): boolean {
  const db = resolveDb(dbArg);
  return db.prepare('DELETE FROM club_coaches WHERE id = ?').run(coachId).changes > 0;
}

export function listClubPlayerRoleFamiliarities(
  clubId: string,
  dbArg?: Database.Database
): PlayerRoleFamiliarityRecord[] {
  const db = resolveDb(dbArg);
  const rows = db
    .prepare(`
      SELECT prf.*
      FROM player_role_familiarities prf
      JOIN players p ON p.id = prf.player_id
      WHERE p.club_id = ?
      ORDER BY prf.position_code ASC, prf.role_name ASC
    `)
    .all(clubId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    playerId: String(r.player_id),
    positionCode: String(r.position_code),
    roleName: String(r.role_name),
    baseFamiliarity: String(r.base_familiarity) as RoleFamiliarityTier,
    potentialCoachFamiliarity: String(r.potential_coach_familiarity) as RoleFamiliarityTier,
    confirmedFamiliarity: String(r.confirmed_familiarity) as RoleFamiliarityTier,
    confirmedAt: r.confirmed_at ? String(r.confirmed_at) : null,
    notes: String(r.notes ?? ''),
  }));
}

export function upsertPlayerRoleFamiliarity(
  playerId: string,
  input: {
    positionCode: string;
    roleName: string;
    baseFamiliarity?: RoleFamiliarityTier;
    potentialCoachFamiliarity?: RoleFamiliarityTier;
    confirmedFamiliarity?: RoleFamiliarityTier;
    notes?: string;
  },
  dbArg?: Database.Database
): PlayerRoleFamiliarityRecord {
  const db = resolveDb(dbArg);
  const posNorm = normalizeFormationSlotPosition(input.positionCode);
  const pos = posNorm.ok ? posNorm.canonicalPosition : input.positionCode.trim().toUpperCase();
  const roleName = input.roleName.trim();
  const now = new Date().toISOString();

  const existing = db
    .prepare(
      'SELECT * FROM player_role_familiarities WHERE player_id = ? AND position_code = ? AND LOWER(role_name) = LOWER(?)'
    )
    .get(playerId, pos, roleName) as Record<string, unknown> | undefined;

  const id = existing ? String(existing.id) : crypto.randomUUID();
  const baseFam = input.baseFamiliarity ?? (existing ? (String(existing.base_familiarity) as RoleFamiliarityTier) : 'unknown');
  const potFam =
    input.potentialCoachFamiliarity ??
    (existing ? (String(existing.potential_coach_familiarity) as RoleFamiliarityTier) : 'unknown');
  const confFam =
    input.confirmedFamiliarity ??
    (existing ? (String(existing.confirmed_familiarity) as RoleFamiliarityTier) : 'unknown');
  const confirmedAt =
    input.confirmedFamiliarity && input.confirmedFamiliarity !== 'unknown'
      ? now
      : existing?.confirmed_at
        ? String(existing.confirmed_at)
        : null;

  db.prepare(`
    INSERT INTO player_role_familiarities (
      id, player_id, position_code, role_name, base_familiarity,
      potential_coach_familiarity, confirmed_familiarity, confirmed_at, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, position_code, role_name) DO UPDATE SET
      base_familiarity = excluded.base_familiarity,
      potential_coach_familiarity = excluded.potential_coach_familiarity,
      confirmed_familiarity = excluded.confirmed_familiarity,
      confirmed_at = excluded.confirmed_at,
      notes = excluded.notes
  `).run(
    id,
    playerId,
    pos,
    roleName,
    baseFam,
    potFam,
    confFam,
    confirmedAt,
    (input.notes ?? (existing ? String(existing.notes ?? '') : '')).trim()
  );

  const saved = db
    .prepare('SELECT * FROM player_role_familiarities WHERE id = ?')
    .get(id) as Record<string, unknown>;

  return {
    id: String(saved.id),
    playerId: String(saved.player_id),
    positionCode: String(saved.position_code),
    roleName: String(saved.role_name),
    baseFamiliarity: String(saved.base_familiarity) as RoleFamiliarityTier,
    potentialCoachFamiliarity: String(saved.potential_coach_familiarity) as RoleFamiliarityTier,
    confirmedFamiliarity: String(saved.confirmed_familiarity) as RoleFamiliarityTier,
    confirmedAt: saved.confirmed_at ? String(saved.confirmed_at) : null,
    notes: String(saved.notes ?? ''),
  };
}

// ============================================================
// Three-Layer Tactical Validation Engine (Section 8)
// ============================================================

function departmentForPosition(positionCode: string): ClubCoachRecord['department'] {
  if (positionCode === 'GK') return 'goalkeeping';
  if (['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(positionCode)) return 'defense';
  if (['CDM', 'CM', 'CAM', 'LM', 'RM'].includes(positionCode)) return 'midfield';
  return 'attack';
}

export interface TacticalEvaluationInput {
  clubId?: string | null;
  tacticalVisionKey?: string | null;
  formationName: string;
  buildUpStyle: string;
  defensiveApproach: string;
  defensiveLineHeight: number;
  assignments: Array<{
    slotOrder: number;
    slotId?: string | null;
    positionCode: string;
    playerId: string | null;
    playerDisplayName?: string | null;
    role: string;
    focus: string;
  }>;
  benchPlayerIds?: string[];
  confirmedDoubtfulPlayerIds?: string[];
}

export function evaluateThreeLayerTactics(
  input: TacticalEvaluationInput,
  dbArg?: Database.Database
): ThreeLayerTacticalEvaluation {
  const db = resolveDb(dbArg);
  const catalog = getTacticalVisionCatalog(db);
  const normalizedVisionKey = normalizeTacticalVisionKey(input.tacticalVisionKey, db);
  const visionRecord =
    normalizedVisionKey !== 'unspecified'
      ? catalog.visions.find((v) => v.internalKey === normalizedVisionKey) ?? null
      : null;

  const clubPlayers: Player[] = input.clubId ? listPlayers(input.clubId) : [];
  const playerById = new Map<string, Player>(clubPlayers.map((p) => [p.id, p]));
  const clubCoaches: ClubCoachRecord[] = input.clubId ? listClubCoaches(input.clubId, db) : [];
  const familiarities: PlayerRoleFamiliarityRecord[] = input.clubId
    ? listClubPlayerRoleFamiliarities(input.clubId, db)
    : [];

  // Build role-affinity lookup map for selected vision: `${positionCode}|${normalizedRoleName}` -> RoleAffinityStatus
  const roleAffinityMap = new Map<string, RoleAffinityStatus>();
  if (visionRecord) {
    for (const ra of catalog.roleAffinities) {
      if (ra.visionKey !== visionRecord.internalKey) continue;
      roleAffinityMap.set(
        `${ra.positionCode.toUpperCase()}|${normalizeRoleLookupKey(ra.roleName)}`,
        ra.affinityStatus
      );
    }
  }

  // Layer 1: FC IQ Legal Compatibility & Squad Eligibility (Blocking)
  const blockingIssues: ThreeLayerTacticalEvaluation['layer1FcIqLegality']['blockingIssues'] = [];
  const slotLegality = new Map<number, boolean>();

  for (const a of input.assignments) {
    const posCheck = normalizeFormationSlotPosition(a.positionCode, a.slotId, a.slotOrder);
    if (!posCheck.ok) {
      slotLegality.set(a.slotOrder, false);
      blockingIssues.push({
        slotOrder: a.slotOrder,
        slotId: a.slotId ?? null,
        positionCode: a.positionCode,
        code: 'invalid_position',
        message: posCheck.error ?? `Unrecognized position "${a.positionCode}".`,
      });
      continue;
    }

    const canonicalPos = posCheck.canonicalPosition;
    let legal = true;
    if (a.role.trim() || a.focus.trim()) {
      const rfCheck = validatePlayerRoleFocus(canonicalPos, a.role, a.focus, db);
      if (!rfCheck.valid) {
        legal = false;
        blockingIssues.push({
          slotOrder: a.slotOrder,
          slotId: a.slotId ?? posCheck.slotId,
          positionCode: canonicalPos,
          code: 'invalid_role_focus',
          message: rfCheck.reason ?? `Invalid Role/Focus for ${canonicalPos}.`,
        });
      }
    }
    slotLegality.set(a.slotOrder, legal);
  }

  if (input.clubId && clubPlayers.length > 0) {
    const eligReport = validateLineupEligibility({
      clubPlayers,
      assignments: input.assignments.map((a) => ({
        slotOrder: a.slotOrder,
        slotId: a.slotId ?? undefined,
        positionCode: a.positionCode,
        playerId: a.playerId,
      })),
      benchPlayerIds: input.benchPlayerIds ?? [],
      confirmedDoubtfulPlayerIds: input.confirmedDoubtfulPlayerIds ?? [],
    });

    for (const issue of eligReport.issues) {
      blockingIssues.push({
        slotOrder: issue.slotOrder ?? null,
        slotId: issue.slotId ?? null,
        positionCode: issue.positionCode ?? null,
        code: issue.code,
        message: issue.reason,
      });
    }
  }

  // Layer 2: Official FC 26 Tactical Vision Requirements
  const layer2Conflicts: ThreeLayerTacticalEvaluation['layer2OfficialRequirements']['conflicts'] = [];
  const layer2AdvisoryNotes: string[] = [];

  if (visionRecord) {
    const normBuildUp = normalizeBuildUpStyle(input.buildUpStyle);
    const normDefense = normalizeDefensiveApproach(input.defensiveApproach);

    for (const req of visionRecord.officialRequirements) {
      if (!req.isMandatory) continue;
      if (req.parameterType === 'build_up_style') {
        const allowedNorm = req.allowedValues.map(normalizeBuildUpStyle);
        if (!allowedNorm.includes(normBuildUp)) {
          layer2Conflicts.push({
            parameterType: 'build_up_style',
            currentValue: input.buildUpStyle,
            allowedValues: req.allowedValues,
            canonicalInGameLabels: req.canonicalInGameLabels,
            explanation: `${visionRecord.displayName} requires Build-Up Style: ${req.canonicalInGameLabels.join(' or ')} (official FC26 Career Mode baseline). Current setting "${input.buildUpStyle}" conflicts with verified vision compliance.`,
            suggestedCorrectionValue: req.canonicalInGameLabels[0] ?? req.allowedValues[0] ?? 'Balanced',
            sourceType: req.sourceType,
          });
        }
      } else if (req.parameterType === 'defensive_approach') {
        const allowedNorm = req.allowedValues.map(normalizeDefensiveApproach);
        if (!allowedNorm.includes(normDefense)) {
          layer2Conflicts.push({
            parameterType: 'defensive_approach',
            currentValue: input.defensiveApproach,
            allowedValues: req.allowedValues,
            canonicalInGameLabels: req.canonicalInGameLabels,
            explanation: `${visionRecord.displayName} requires Defensive Approach: ${req.canonicalInGameLabels.join(' or ')} (official FC26 Career Mode baseline). Current setting "${input.defensiveApproach}" conflicts with verified vision compliance.`,
            suggestedCorrectionValue: req.canonicalInGameLabels[0] ?? req.allowedValues[0] ?? 'Balanced',
            sourceType: req.sourceType,
          });
        }
      }
    }

    if (visionRecord.officialRequirements.length === 0) {
      layer2AdvisoryNotes.push(
        `${visionRecord.displayName} has no mandatory Build-Up Style or Defensive Approach restriction in EA SPORTS FC 26.`
      );
    }

    // Advisory note on numeric Defensive Line Height (never blocking in Layer 2)
    if (visionRecord.internalKey === 'high_pressing' && input.defensiveLineHeight < 65) {
      layer2AdvisoryNotes.push(
        `Advisory: Defensive Line Height is ${input.defensiveLineHeight}/100. High Pressing typically works more coherently with a higher line (65+), though numeric height is not officially locked.`
      );
    } else if (visionRecord.internalKey === 'park_the_bus' && input.defensiveLineHeight > 45) {
      layer2AdvisoryNotes.push(
        `Advisory: Defensive Line Height is ${input.defensiveLineHeight}/100. Park the Bus typically pairs with a deeper block (<=45), though numeric height is not officially locked.`
      );
    }
  } else {
    layer2AdvisoryNotes.push(
      'Tactical Vision is Unspecified. Select one of the 7 FC26 Tactical Visions to evaluate official requirements and role affinity.'
    );
  }

  // Layer 3: Advisory Role Affinity (NEVER blocks legal FC IQ roles)
  let matchedCount = 0;
  let assignedRoleCount = 0;
  let notAssociatedCount = 0;
  let unknownCount = 0;

  let naturalPositionCount = 0;
  let secondaryPositionCount = 0;
  let outOfPositionCount = 0;
  let unassignedCount = 0;

  const matchingVisionCoaches = visionRecord
    ? clubCoaches.filter((c) => c.tacticalVisionKey === visionRecord.internalKey)
    : [];
  const silverOrGoldMatchingCoaches = matchingVisionCoaches.filter(
    (c) => c.qualificationLevel === 'silver' || c.qualificationLevel === 'gold'
  );

  const slotAffinities: ThreeLayerTacticalEvaluation['layer3RoleAffinity']['slotAffinities'] = [];

  for (const a of input.assignments) {
    const posNorm = normalizeFormationSlotPosition(a.positionCode, a.slotId, a.slotOrder);
    const canonicalPos = posNorm.ok ? posNorm.canonicalPosition : a.positionCode.trim().toUpperCase();
    const slotId = a.slotId?.trim() || (posNorm.ok ? posNorm.slotId : canonicalPos);
    const roleTrim = a.role.trim();

    let affinityStatus: RoleAffinityStatus = 'unknown';
    if (visionRecord && roleTrim) {
      assignedRoleCount += 1;
      const lookupKey = `${canonicalPos}|${normalizeRoleLookupKey(roleTrim)}`;
      const found = roleAffinityMap.get(lookupKey);
      if (found === 'associated') {
        affinityStatus = 'associated';
        matchedCount += 1;
      } else if (found === 'not_associated') {
        affinityStatus = 'not_associated';
        notAssociatedCount += 1;
      } else {
        affinityStatus = 'unknown';
        unknownCount += 1;
      }
    } else if (!roleTrim) {
      affinityStatus = 'unknown';
    }

    const player = a.playerId ? playerById.get(a.playerId) : undefined;
    if (!player) {
      unassignedCount += 1;
    } else if (player.position.toUpperCase() === canonicalPos) {
      naturalPositionCount += 1;
    } else if (player.secondaryPositions.map((s) => s.toUpperCase()).includes(canonicalPos)) {
      secondaryPositionCount += 1;
    } else {
      outOfPositionCount += 1;
    }

    // Familiarity & Coach Potential (never fabricated)
    const famRecord = player
      ? familiarities.find(
          (f) =>
            f.playerId === player.id &&
            f.positionCode.toUpperCase() === canonicalPos &&
            normalizeRoleLookupKey(f.roleName) === normalizeRoleLookupKey(roleTrim)
        )
      : undefined;

    const dept = departmentForPosition(canonicalPos);
    const deptSilverGoldCoaches = silverOrGoldMatchingCoaches.filter(
      (c) => c.department === dept || c.department === 'head_coach'
    );

    let potentialCoachFamiliarity: RoleFamiliarityTier = famRecord?.potentialCoachFamiliarity ?? 'unknown';
    let coachBonusNote: string | null = null;

    if (visionRecord && affinityStatus === 'associated' && deptSilverGoldCoaches.length > 0) {
      if (potentialCoachFamiliarity === 'unknown') {
        potentialCoachFamiliarity = 'role_plus';
      }
      coachBonusNote = `Potential Role+ coaching boost via ${deptSilverGoldCoaches[0].name} (${deptSilverGoldCoaches[0].qualificationLevel.toUpperCase()} ${visionRecord.displayName} coach) — unconfirmed in-game unless verified by user.`;
    } else if (visionRecord && clubCoaches.length === 0) {
      coachBonusNote = null;
    }

    slotAffinities.push({
      slotOrder: a.slotOrder,
      slotId,
      positionCode: canonicalPos,
      role: roleTrim,
      focus: a.focus.trim(),
      affinityStatus,
      legalForPosition: slotLegality.get(a.slotOrder) ?? true,
      playerId: a.playerId,
      playerDisplayName: player?.displayName ?? a.playerDisplayName ?? null,
      baseFamiliarity: famRecord?.baseFamiliarity ?? 'unknown',
      potentialCoachFamiliarity,
      confirmedFamiliarity: famRecord?.confirmedFamiliarity ?? 'unknown',
      coachBonusNote,
    });
  }

  const tradeOffs: string[] = [];
  if (outOfPositionCount > 0) {
    tradeOffs.push(
      `${outOfPositionCount} starter(s) are deployed outside their natural or secondary FC26 positions.`
    );
  }
  if (unassignedCount > 0) {
    tradeOffs.push(`${unassignedCount} Starting XI slot(s) have no player assigned yet.`);
  }
  if (visionRecord && notAssociatedCount > 0) {
    tradeOffs.push(
      `${notAssociatedCount} legal role(s) are not listed as associated with ${visionRecord.displayName} in the secondary Role Affinity matrix (advisory only — still fully legal in FC 26).`
    );
  }
  if (visionRecord && unknownCount > 0) {
    tradeOffs.push(
      `${unknownCount} role/position pairing(s) have no entry in the secondary Role Affinity matrix and are truthfully marked Unknown.`
    );
  }

  const coachNote = !visionRecord
    ? 'Select a Tactical Vision to evaluate coaching staff synergy.'
    : clubCoaches.length === 0
      ? 'No Career Mode coaches configured yet. Potential Silver/Gold coach Role+ bonuses are marked unknown rather than assumed.'
      : silverOrGoldMatchingCoaches.length > 0
        ? `${silverOrGoldMatchingCoaches.length} Silver/Gold coach(es) match ${visionRecord.displayName}. Matching players may gain potential Role+ familiarity when aligned; confirm actual in-game familiarity per player.`
        : `${clubCoaches.length} coach(es) configured, but none hold Silver/Gold ${visionRecord.displayName} qualification.`;

  return {
    tacticalVisionKey: visionRecord ? visionRecord.internalKey : 'unspecified',
    tacticalVisionName: visionRecord ? visionRecord.displayName : 'Unspecified',
    datasetVersion: catalog.datasetVersion,
    layer1FcIqLegality: {
      valid: blockingIssues.length === 0,
      blockingIssues,
    },
    layer2OfficialRequirements: {
      status: !visionRecord
        ? 'unspecified'
        : layer2Conflicts.length === 0
          ? 'compliant'
          : 'conflict',
      verifiedVisionCompliant: Boolean(visionRecord) && layer2Conflicts.length === 0,
      conflicts: layer2Conflicts,
      advisoryNotes: layer2AdvisoryNotes,
    },
    layer3RoleAffinity: {
      status: visionRecord ? 'evaluated' : 'unspecified',
      matchedCount,
      assignedRoleCount,
      notAssociatedCount,
      unknownCount,
      summaryLabel: visionRecord
        ? `${matchedCount} of ${assignedRoleCount || input.assignments.length} roles match ${visionRecord.displayName} affinity${unknownCount > 0 ? ` (${unknownCount} unknown)` : ''}`
        : 'Unspecified Tactical Vision',
      disclaimer:
        'Advisory Role Affinity based on user-provided FC26 secondary matrix. Blank cells are never prohibited in FC26; all legal FC IQ roles remain selectable.',
      slotAffinities,
      coachPotentialSummary: {
        configuredCoachCount: clubCoaches.length,
        matchingVisionCoachCount: matchingVisionCoaches.length,
        silverOrGoldMatchingCoaches: silverOrGoldMatchingCoaches.length,
        note: coachNote,
      },
    },
    squadSuitability: {
      naturalPositionCount,
      secondaryPositionCount,
      outOfPositionCount,
      unassignedCount,
      tradeOffs,
    },
  };
}

export function compareTacticalVisions(
  visionKeyA: string,
  visionKeyB: string,
  config: Omit<TacticalEvaluationInput, 'tacticalVisionKey'>,
  dbArg?: Database.Database
): {
  visionA: ThreeLayerTacticalEvaluation;
  visionB: ThreeLayerTacticalEvaluation;
  roleAffinityDelta: number;
  summary: string;
} {
  const db = resolveDb(dbArg);
  const evalA = evaluateThreeLayerTactics({ ...config, tacticalVisionKey: visionKeyA }, db);
  const evalB = evaluateThreeLayerTactics({ ...config, tacticalVisionKey: visionKeyB }, db);
  const delta = evalB.layer3RoleAffinity.matchedCount - evalA.layer3RoleAffinity.matchedCount;
  const summary =
    delta === 0
      ? `${evalA.tacticalVisionName} and ${evalB.tacticalVisionName} match the same number of current Starting XI roles (${evalA.layer3RoleAffinity.matchedCount}).`
      : delta > 0
        ? `${evalB.tacticalVisionName} matches ${delta} more current Starting XI role(s) (${evalB.layer3RoleAffinity.matchedCount} vs ${evalA.layer3RoleAffinity.matchedCount}) than ${evalA.tacticalVisionName}.`
        : `${evalA.tacticalVisionName} matches ${Math.abs(delta)} more current Starting XI role(s) (${evalA.layer3RoleAffinity.matchedCount} vs ${evalB.layer3RoleAffinity.matchedCount}) than ${evalB.tacticalVisionName}.`;

  return {
    visionA: evalA,
    visionB: evalB,
    roleAffinityDelta: delta,
    summary,
  };
}

// ============================================================
// Deterministic 4-Mode Tactical Vision Optimizer (Section 12)
// ============================================================

export function optimizeForTacticalVision(
  input: TacticalEvaluationInput & {
    targetVisionKey: string;
    mode: VisionOptimizationMode;
  },
  dbArg?: Database.Database
): VisionOptimizationResult {
  const db = resolveDb(dbArg);
  const targetVision = getTacticalVisionByKey(input.targetVisionKey, db);
  if (!targetVision) {
    throw new Error(`Invalid target Tactical Vision "${input.targetVisionKey}".`);
  }

  const catalog = getTacticalVisionCatalog(db);
  const beforeEvaluation = evaluateThreeLayerTactics(
    { ...input, tacticalVisionKey: targetVision.internalKey },
    db
  );

  let nextFormationName = input.formationName;
  let nextBuildUpStyle = input.buildUpStyle;
  let nextDefensiveApproach = input.defensiveApproach;
  let nextLineHeight = input.defensiveLineHeight;
  let nextAssignments = input.assignments.map((a) => {
    const normalizedPos = normalizeFormationSlotPosition(a.positionCode, a.slotId, a.slotOrder);
    return {
      slotOrder: a.slotOrder,
      slotId: a.slotId?.trim() || `${a.positionCode}_${a.slotOrder}`,
      positionCode: normalizedPos.ok
        ? normalizedPos.canonicalPosition
        : a.positionCode.trim().toUpperCase(),
      playerId: a.playerId,
      playerName: a.playerDisplayName ?? null,
      role: a.role,
      focus: a.focus,
    };
  });

  const proposals: VisionOptimizationProposalItem[] = [];

  // Step 1: Resolve mandatory Layer 2 official requirements (applies to ALL 4 modes)
  for (const conflict of beforeEvaluation.layer2OfficialRequirements.conflicts) {
    if (conflict.parameterType === 'build_up_style') {
      nextBuildUpStyle = conflict.suggestedCorrectionValue;
      proposals.push({
        id: crypto.randomUUID(),
        category: 'build_up_style',
        currentValue: conflict.currentValue,
        proposedValue: conflict.suggestedCorrectionValue,
        mandatoryForOfficialVision: true,
        explanation: conflict.explanation,
        expectedBenefit: `Aligns Build-Up Style with official EA FC 26 ${targetVision.displayName} requirements.`,
        potentialDownside: 'Changes how quickly midfielders and forwards offer support vs make runs in transition.',
        evidenceBasis: 'Official EA SPORTS FC 26 Career Mode Tactical Vision requirements (Layer 2).',
      });
    } else if (conflict.parameterType === 'defensive_approach') {
      nextDefensiveApproach = conflict.suggestedCorrectionValue;
      proposals.push({
        id: crypto.randomUUID(),
        category: 'defensive_approach',
        currentValue: conflict.currentValue,
        proposedValue: conflict.suggestedCorrectionValue,
        mandatoryForOfficialVision: true,
        explanation: conflict.explanation,
        expectedBenefit: `Aligns Defensive Approach with official EA FC 26 ${targetVision.displayName} requirements.`,
        potentialDownside: 'Alters defensive block depth and space behind the back line.',
        evidenceBasis: 'Official EA SPORTS FC 26 Career Mode Tactical Vision requirements (Layer 2).',
      });
    }
  }

  // Advisory line height alignment for Full Tactical Optimization
  if (input.mode === 'full_tactical_optimization') {
    if (targetVision.internalKey === 'high_pressing' && nextLineHeight < 70) {
      proposals.push({
        id: crypto.randomUUID(),
        category: 'defensive_line_height',
        currentValue: `${nextLineHeight}/100`,
        proposedValue: '72/100',
        mandatoryForOfficialVision: false,
        explanation: 'High Pressing compresses space between lines more reliably at a 70+ line height.',
        expectedBenefit: 'Tighter vertical compactness during high-press traps.',
        potentialDownside: 'More space behind centre-backs against fast direct runners.',
        evidenceBasis: 'Internal tactical coherence guidance (advisory — not an official FC26 lock).',
      });
      nextLineHeight = 72;
    } else if (targetVision.internalKey === 'park_the_bus' && nextLineHeight > 38) {
      proposals.push({
        id: crypto.randomUUID(),
        category: 'defensive_line_height',
        currentValue: `${nextLineHeight}/100`,
        proposedValue: '35/100',
        mandatoryForOfficialVision: false,
        explanation: 'Park the Bus defends deeper around the box when line height sits near 35.',
        expectedBenefit: 'Protects central space behind the defensive line.',
        potentialDownside: 'Invites sustained possession pressure near the penalty area.',
        evidenceBasis: 'Internal tactical coherence guidance (advisory — not an official FC26 lock).',
      });
      nextLineHeight = 35;
    }
  }

  const clubPlayers = input.clubId ? listPlayers(input.clubId) : [];
  const eligiblePlayers = clubPlayers.filter((p) => evaluatePlayerEligibility(p).eligible);
  const playerById = new Map<string, Player>(clubPlayers.map((p) => [p.id, p]));
  const familiarities = input.clubId ? listClubPlayerRoleFamiliarities(input.clubId, db) : [];

  // Step 2: Formation evaluation for full_tactical_optimization (only if current formation has >2 out-of-position or unassigned slots)
  if (input.mode === 'full_tactical_optimization' && eligiblePlayers.length >= 11) {
    const formations = listCatalogFormations({}, db).filter((f) => f.slots.length === 11);
    const currentNaturalScore = beforeEvaluation.squadSuitability.naturalPositionCount;
    let bestFormation = getCatalogFormationByIdOrName(input.formationName, db);
    let bestScore = currentNaturalScore;

    for (const f of formations) {
      const used = new Set<string>();
      let natCount = 0;
      for (const slot of f.slots) {
        const candidate = eligiblePlayers.find(
          (p) => !used.has(p.id) && p.position.toUpperCase() === slot.positionCode.toUpperCase()
        );
        if (candidate) {
          used.add(candidate.id);
          natCount += 1;
        }
      }
      if (natCount >= bestScore + 2) {
        bestScore = natCount;
        bestFormation = f;
      }
    }

    if (bestFormation && bestFormation.name !== input.formationName) {
      proposals.push({
        id: crypto.randomUUID(),
        category: 'formation',
        currentValue: input.formationName,
        proposedValue: bestFormation.name,
        mandatoryForOfficialVision: false,
        explanation: `${bestFormation.name} provides natural positions for ${bestScore} eligible squad players (vs ${currentNaturalScore} in ${input.formationName}).`,
        expectedBenefit: 'Improves natural positional coverage across the Starting XI before assigning vision-aligned roles.',
        potentialDownside: 'Changes overall pitch geometry and requires verifying preferred player partnerships.',
        evidenceBasis: 'Eligible Career Mode squad positional distribution + FC26 catalog formations.',
      });
      nextFormationName = bestFormation.name;
      nextAssignments = bestFormation.slots.map((slot, idx) => ({
        slotOrder: idx,
        slotId: slot.slotId ?? `${slot.positionCode}_${idx}`,
        positionCode: slot.positionCode,
        playerId: null,
        playerName: null,
        role: '',
        focus: '',
      }));
    }
  }

  // Step 3: Squad Optimization (assign best eligible player per slot without duplicates)
  if (
    (input.mode === 'squad_optimization' || input.mode === 'full_tactical_optimization') &&
    eligiblePlayers.length > 0
  ) {
    const assignedIds = new Set<string>(
      nextAssignments.map((a) => a.playerId).filter((id): id is string => Boolean(id))
    );

    const scorePlayerForSlot = (p: Player, posCode: string, roleName: string): number => {
      let score = p.overallRating ?? 65;
      if (p.position.toUpperCase() === posCode) score += 25;
      else if (p.secondaryPositions.map((s) => s.toUpperCase()).includes(posCode)) score += 10;
      else score -= 25;

      // Factor confirmed or base familiarity if known
      const fam = familiarities.find(
        (f) =>
          f.playerId === p.id &&
          f.positionCode.toUpperCase() === posCode &&
          normalizeRoleLookupKey(f.roleName) === normalizeRoleLookupKey(roleName)
      );
      if (fam?.confirmedFamiliarity === 'role_plus_plus') score += 8;
      else if (fam?.confirmedFamiliarity === 'role_plus') score += 4;
      return score;
    };

    for (let i = 0; i < nextAssignments.length; i++) {
      const slot = nextAssignments[i];
      const currentPlayer = slot.playerId ? playerById.get(slot.playerId) : undefined;
      const currentScore = currentPlayer
        ? scorePlayerForSlot(currentPlayer, slot.positionCode, slot.role)
        : -999;

      const availableCandidates = eligiblePlayers.filter(
        (p) => !assignedIds.has(p.id) || p.id === slot.playerId
      );
      let bestCandidate: Player | null = null;
      let bestScore = currentScore;

      for (const cand of availableCandidates) {
        if (cand.id === slot.playerId) continue;
        const sc = scorePlayerForSlot(cand, slot.positionCode, slot.role);
        if (sc > bestScore + 5) {
          bestScore = sc;
          bestCandidate = cand;
        }
      }

      if (bestCandidate) {
        if (slot.playerId) assignedIds.delete(slot.playerId);
        assignedIds.add(bestCandidate.id);
        proposals.push({
          id: crypto.randomUUID(),
          category: 'player_swap',
          slotOrder: slot.slotOrder,
          slotId: slot.slotId,
          positionCode: slot.positionCode,
          currentValue: currentPlayer ? `${currentPlayer.displayName} (${currentPlayer.position} · ${currentPlayer.overallRating ?? '-'})` : 'Unassigned',
          proposedValue: `${bestCandidate.displayName} (${bestCandidate.position} · ${bestCandidate.overallRating ?? '-'})`,
          proposedPlayerId: bestCandidate.id,
          proposedPlayerName: bestCandidate.displayName,
          mandatoryForOfficialVision: false,
          explanation: `${bestCandidate.displayName} is an eligible squad player with stronger positional fit and rating for ${slot.positionCode}.`,
          expectedBenefit: 'Improves on-pitch execution quality and natural positional coverage.',
          potentialDownside: 'Rotates out the currently selected starter; verify stamina and match sharpness in-game.',
          evidenceBasis: 'Active Career Mode squad eligibility, natural/secondary positions, and OVR.',
        });
        nextAssignments[i] = {
          ...slot,
          playerId: bestCandidate.id,
          playerName: bestCandidate.displayName,
        };
      }
    }
  }

  // Step 4: Role Optimization (for role_optimization and full_tactical_optimization)
  if (input.mode === 'role_optimization' || input.mode === 'full_tactical_optimization') {
    const associatedRolesByPos = new Map<string, string[]>();
    for (const ra of catalog.roleAffinities) {
      if (ra.visionKey !== targetVision.internalKey || ra.affinityStatus !== 'associated') continue;
      const list = associatedRolesByPos.get(ra.positionCode.toUpperCase()) ?? [];
      list.push(ra.roleName);
      associatedRolesByPos.set(ra.positionCode.toUpperCase(), list);
    }

    for (let i = 0; i < nextAssignments.length; i++) {
      const slot = nextAssignments[i];
      const pos = slot.positionCode.toUpperCase();
      const legalRoles = listCatalogRoles(pos, db);
      if (legalRoles.length === 0) continue;

      const associatedNames = (associatedRolesByPos.get(pos) ?? []).map(normalizeRoleLookupKey);
      const currentIsAssociated =
        Boolean(slot.role.trim()) && associatedNames.includes(normalizeRoleLookupKey(slot.role));
      const currentIsLegal =
        Boolean(slot.role.trim()) &&
        legalRoles.some((r) => normalizeRoleLookupKey(r.name) === normalizeRoleLookupKey(slot.role));

      if (currentIsAssociated && currentIsLegal) continue;

      // Pick the best legal role that is also associated with targetVision (weighted by player familiarity if known)
      const candidateRoles = legalRoles.filter((r) =>
        associatedNames.includes(normalizeRoleLookupKey(r.name))
      );
      if (candidateRoles.length === 0) continue;

      let chosenRole = candidateRoles[0];
      if (slot.playerId) {
        const famRole = candidateRoles.find((r) =>
          familiarities.some(
            (f) =>
              f.playerId === slot.playerId &&
              f.positionCode.toUpperCase() === pos &&
              normalizeRoleLookupKey(f.roleName) === normalizeRoleLookupKey(r.name) &&
              (f.confirmedFamiliarity === 'role_plus_plus' || f.confirmedFamiliarity === 'role_plus')
          )
        );
        if (famRole) chosenRole = famRole;
      }

      const validFocuses = listCatalogFocuses({ roleName: chosenRole.name, positionCode: pos }, db);
      const chosenFocus =
        validFocuses.find((f) => f.name === slot.focus)?.name ??
        validFocuses.find((f) => f.name === 'Balanced')?.name ??
        validFocuses[0]?.name ??
        '';

      proposals.push({
        id: crypto.randomUUID(),
        category: 'role_focus',
        slotOrder: slot.slotOrder,
        slotId: slot.slotId,
        positionCode: pos,
        currentValue: slot.role ? `${slot.role} (${slot.focus || 'Default'})` : 'Unset',
        proposedValue: `${chosenRole.name} (${chosenFocus || 'Default'})`,
        proposedRole: chosenRole.name,
        proposedFocus: chosenFocus,
        mandatoryForOfficialVision: false,
        explanation: `${chosenRole.name} is legal for ${pos} in FC IQ and listed as an associated ${targetVision.displayName} role in the advisory affinity matrix.`,
        expectedBenefit: `Aligns ${pos} movement profile with ${targetVision.displayName} principles and unlocks potential coach Role+ synergy if matching Silver/Gold coaches are hired.`,
        potentialDownside: 'Advisory change only — if the assigned player has higher confirmed Role++ in their previous role, keeping the previous role may remain stronger in-game.',
        evidenceBasis: 'FC26 Role-Position-Focus catalog (Layer 1) + User Tactical Vision Role Affinity Matrix (Layer 3).',
      });

      nextAssignments[i] = {
        ...slot,
        role: chosenRole.name,
        focus: chosenFocus,
      };
    }
  }

  const afterEvaluation = evaluateThreeLayerTactics(
    {
      clubId: input.clubId,
      tacticalVisionKey: targetVision.internalKey,
      formationName: nextFormationName,
      buildUpStyle: nextBuildUpStyle,
      defensiveApproach: nextDefensiveApproach,
      defensiveLineHeight: nextLineHeight,
      assignments: nextAssignments.map((a) => ({
        slotOrder: a.slotOrder,
        slotId: a.slotId,
        positionCode: a.positionCode,
        playerId: a.playerId,
        playerDisplayName: a.playerName,
        role: a.role,
        focus: a.focus,
      })),
      benchPlayerIds: input.benchPlayerIds,
    },
    db
  );

  const summaryNote =
    proposals.length === 0
      ? `Current setup already satisfies ${targetVision.displayName} for "${input.mode.replace(/_/g, ' ')}" mode with no changes needed.`
      : `Generated ${proposals.length} reviewable proposal(s) for ${targetVision.displayName} (${input.mode.replace(/_/g, ' ')}). Role Affinity improves from ${beforeEvaluation.layer3RoleAffinity.matchedCount} to ${afterEvaluation.layer3RoleAffinity.matchedCount} matched roles. Nothing has been saved automatically — accept individual or all changes to apply.`;

  return {
    mode: input.mode,
    targetVisionKey: targetVision.internalKey,
    targetVisionName: targetVision.displayName,
    beforeEvaluation,
    afterPreview: {
      formationName: nextFormationName,
      buildUpStyle: nextBuildUpStyle,
      defensiveApproach: nextDefensiveApproach,
      defensiveLineHeight: nextLineHeight,
      assignments: nextAssignments,
      evaluation: afterEvaluation,
    },
    proposals,
    summaryNote,
  };
}
