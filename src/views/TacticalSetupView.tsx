import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  GitCompare,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  Sparkles,
  Star,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TacticalPitchSVG } from '../components/pitch/TacticalPitchSVG';
import { SearchablePlayerSelect } from '../components/tactics/SearchablePlayerSelect';
import { CompareVisionsModal, OptimizeVisionModal } from '../components/tactics/VisionModals';
import { useApp } from '../context/AppContext';
import { getFormationPositions } from '../data/tacticalCatalog';
import { desktopBridge } from '../services/desktopBridge';
import type {
  CatalogFormation,
  CatalogRole,
  PlayerRoleAssignment,
  PlayerRoleFamiliarityRecord,
  RoleFamiliarityTier,
  TacticalPreset,
  TacticalPresetStatus,
  TacticalVisionKey,
  TacticalVisionRecord,
  ThreeLayerTacticalEvaluation,
  VisionOptimizationResult,
} from '../types/domain';
import {
  deriveStableSlotId,
  getDisplayPositionLabel,
  getSlotSideHint,
  toCanonicalFc26Position,
} from '../utils/formationPositions';
import { resolvePlayerDisplayName } from '../utils/playerDisplayName';
import {
  evaluatePlayerEligibility,
  suggestEligibleReplacements,
  summarizeSquadEligibility,
  validateLineupEligibility,
} from '../utils/squadEligibility';

interface PresetDraft {
  id: string | null; // null when creating a brand-new unsaved preset
  name: string;
  formationId: string | null;
  formationName: string;
  tacticalVisionKey: TacticalVisionKey | 'unspecified';
  buildUpStyle: string;
  defensiveApproach: string;
  defensiveLineHeight: number;
  isDefault: boolean;
  presetStatus: TacticalPresetStatus;
  benchPlayerIds: string[];
  notes: string;
  assignments: PlayerRoleAssignment[];
}

function serializeDraft(d: PresetDraft): string {
  return JSON.stringify({
    name: d.name.trim(),
    formationName: d.formationName,
    tacticalVisionKey: d.tacticalVisionKey,
    buildUpStyle: d.buildUpStyle,
    defensiveApproach: d.defensiveApproach,
    defensiveLineHeight: d.defensiveLineHeight,
    presetStatus: d.presetStatus,
    benchPlayerIds: [...d.benchPlayerIds],
    notes: d.notes.trim(),
    assignments: d.assignments.map((a) => ({
      slotIndex: a.slotIndex,
      slotId: a.slotId ?? '',
      positionCode: toCanonicalFc26Position(a.positionCode),
      playerId: a.playerId,
      role: a.role,
      focus: a.focus,
    })),
  });
}

export function TacticalSetupView() {
  const {
    activeClub,
    players,
    tacticalPresets,
    tacticalCatalog,
    refreshAll,
    notify,
    registerDirtyGuard,
    requestNavigation,
  } = useApp();

  const [catalogFormations, setCatalogFormations] = useState<CatalogFormation[]>([]);
  const [catalogRoles, setCatalogRoles] = useState<CatalogRole[]>([]);
  const [tacticalVisions, setTacticalVisions] = useState<TacticalVisionRecord[]>([]);
  const [familiarities, setFamiliarities] = useState<PlayerRoleFamiliarityRecord[]>([]);
  const [threeLayerEval, setThreeLayerEval] = useState<ThreeLayerTacticalEvaluation | null>(null);
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [showOptimizeModal, setShowOptimizeModal] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [savedSignature, setSavedSignature] = useState<string>('');
  const [squadFilter, setSquadFilter] = useState('');
  const [showUnavailablePlayers, setShowUnavailablePlayers] = useState(false);
  const [confirmDoubtful, setConfirmDoubtful] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TacticalPreset | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      desktopBridge.listCatalogFormations(),
      desktopBridge.listCatalogRoles(),
      desktopBridge.getTacticalVisionCatalog().catch(() => null),
    ])
      .then(([fList, rList, vCat]) => {
        if (!active) return;
        setCatalogFormations(fList);
        setCatalogRoles(rList);
        if (vCat) setTacticalVisions(vCat.visions);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!activeClub) {
      setFamiliarities([]);
      return;
    }
    let active = true;
    desktopBridge
      .listClubRoleFamiliarities(activeClub.id)
      .then((list) => {
        if (active) setFamiliarities(list);
      })
      .catch(() => {
        if (active) setFamiliarities([]);
      });
    return () => {
      active = false;
    };
  }, [activeClub?.id]);

  const formations = useMemo(() => {
    if (catalogFormations.length > 0) return catalogFormations.map((f) => f.name);
    return tacticalCatalog.filter((c) => c.category === 'formation').map((c) => c.name);
  }, [catalogFormations, tacticalCatalog]);

  const buildUpOptions = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'build_up').map((c) => c.name),
    [tacticalCatalog]
  );
  const defensiveOptions = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'defensive_approach').map((c) => c.name),
    [tacticalCatalog]
  );
  const fallbackRoleOptions = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'player_role').map((c) => c.name),
    [tacticalCatalog]
  );
  const fallbackFocusOptions = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'player_focus').map((c) => c.name),
    [tacticalCatalog]
  );

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const squadEligibilitySummary = useMemo(() => summarizeSquadEligibility(players), [players]);

  const getValidRolesForPosition = useCallback(
    (positionCode: string): CatalogRole[] => {
      const canonical = toCanonicalFc26Position(positionCode) ?? positionCode.toUpperCase();
      return catalogRoles.filter((r) => r.eligiblePositions.includes(canonical));
    },
    [catalogRoles]
  );

  const getValidFocusesForRole = useCallback(
    (roleName: string, positionCode: string): string[] => {
      const canonical = toCanonicalFc26Position(positionCode) ?? positionCode.toUpperCase();
      const roleObj = catalogRoles.find((r) => r.name === roleName);
      return roleObj?.compatibleFocusesByPosition[canonical] ?? [];
    },
    [catalogRoles]
  );

  const buildSlotsForFormation = useCallback(
    (formationName: string, existingAssignments?: PlayerRoleAssignment[]): PlayerRoleAssignment[] => {
      const catForm = catalogFormations.find((f) => f.name === formationName);
      const baseSlots =
        catForm && catForm.slots.length === 11
          ? catForm.slots.map((s) => ({
              slotIndex: s.slotOrder,
              slotId:
                s.slotId ||
                deriveStableSlotId({
                  positionCode: s.positionCode,
                  positionLabel: s.positionLabel,
                  slotOrder: s.slotOrder,
                  x: s.x,
                }),
              positionCode: toCanonicalFc26Position(s.positionCode) ?? s.positionCode.toUpperCase(),
              defaultRole: '',
              defaultFocus: '',
            }))
          : getFormationPositions(formationName).map((s) => ({
              slotIndex: s.slotIndex,
              slotId:
                s.slotId ||
                deriveStableSlotId({
                  positionCode: s.positionCode,
                  positionLabel: s.positionLabel,
                  slotOrder: s.slotIndex,
                  x: s.x,
                }),
              positionCode: toCanonicalFc26Position(s.positionCode) ?? s.positionCode.toUpperCase(),
              defaultRole: s.defaultRole,
              defaultFocus: s.defaultFocus,
            }));

      return baseSlots.map((slot) => {
        const prev = existingAssignments?.find((a) => a.slotIndex === slot.slotIndex);
        const validRoles = getValidRolesForPosition(slot.positionCode);
        let role = prev?.role || slot.defaultRole;
        if (validRoles.length > 0 && !validRoles.some((r) => r.name === role)) {
          role = validRoles[0].name;
        }
        const validFocuses = getValidFocusesForRole(role, slot.positionCode);
        let focus = prev?.focus || slot.defaultFocus;
        if (validFocuses.length > 0 && !validFocuses.includes(focus)) {
          focus = validFocuses[0];
        } else if (!focus) {
          focus = 'Balanced';
        }
        const assignedPlayer = prev?.playerId ? playerById.get(prev.playerId) : undefined;
        return {
          slotIndex: slot.slotIndex,
          slotId: slot.slotId,
          positionCode: slot.positionCode,
          playerId: assignedPlayer ? assignedPlayer.id : null,
          playerName: assignedPlayer ? resolvePlayerDisplayName(assignedPlayer) : null,
          role,
          focus,
        };
      });
    },
    [catalogFormations, getValidRolesForPosition, getValidFocusesForRole, playerById]
  );

  const presetToDraft = useCallback(
    (preset: TacticalPreset): PresetDraft => {
      const catForm = catalogFormations.find((f) => f.name === preset.formationName);
      const fallbackNodes = getFormationPositions(preset.formationName);
      const mappedAssignments: PlayerRoleAssignment[] = preset.assignments.map((a) => {
        const p = a.playerId ? playerById.get(a.playerId) : undefined;
        const catSlot = catForm?.slots.find((s) => s.slotOrder === a.slotOrder);
        const fallbackSlot = fallbackNodes.find((s) => s.slotIndex === a.slotOrder);
        const canonicalPos =
          toCanonicalFc26Position(a.positionCode) ?? a.positionCode.toUpperCase();
        const slotId =
          a.slotId ||
          catSlot?.slotId ||
          fallbackSlot?.slotId ||
          deriveStableSlotId({
            positionCode: a.positionCode,
            slotOrder: a.slotOrder,
            x: catSlot?.x ?? fallbackSlot?.x,
          });
        return {
          slotIndex: a.slotOrder,
          slotId,
          positionCode: canonicalPos,
          playerId: p ? p.id : null,
          playerName: p ? resolvePlayerDisplayName(p) : (a.playerDisplayName ?? null),
          role: a.role,
          focus: a.focus,
        };
      });
      const completeAssignments =
        mappedAssignments.length === 11
          ? mappedAssignments
          : buildSlotsForFormation(preset.formationName, mappedAssignments);
      return {
        id: preset.id,
        name: preset.name,
        formationId: preset.formationId,
        formationName: preset.formationName,
        tacticalVisionKey: preset.tacticalVisionKey ?? 'unspecified',
        buildUpStyle: preset.buildUpStyle,
        defensiveApproach: preset.defensiveApproach,
        defensiveLineHeight: preset.defensiveLineHeight,
        isDefault: preset.isDefault,
        presetStatus: preset.presetStatus ?? 'match_ready',
        benchPlayerIds: preset.benchPlayerIds.filter((id) => playerById.has(id)),
        notes: preset.notes,
        assignments: completeAssignments,
      };
    },
    [buildSlotsForFormation, catalogFormations, playerById]
  );

  const buildBlankDraft = useCallback((): PresetDraft => {
    const formationName = activeClub?.profile.primaryFormation || '4-3-3 Holding';
    const catForm = catalogFormations.find((f) => f.name === formationName);
    return {
      id: null,
      name:
        tacticalPresets.length === 0
          ? 'Primary Matchday Setup'
          : `Tactical Setup #${tacticalPresets.length + 1}`,
      formationId: catForm?.id ?? null,
      formationName,
      tacticalVisionKey: activeClub?.profile.primaryTacticalVisionKey || 'standard',
      buildUpStyle:
        activeClub?.profile.preferredBuildUpStyle ||
        activeClub?.profile.preferredAttackingStyle ||
        'Balanced',
      defensiveApproach:
        activeClub?.profile.preferredDefensiveApproach ||
        activeClub?.profile.preferredDefensiveStyle ||
        'Balanced',
      defensiveLineHeight: activeClub?.profile.preferredDefensiveLineHeight ?? 55,
      isDefault: tacticalPresets.length === 0,
      presetStatus: 'match_ready',
      benchPlayerIds: [],
      notes: '',
      assignments: buildSlotsForFormation(formationName),
    };
  }, [activeClub, catalogFormations, tacticalPresets.length, buildSlotsForFormation]);

  // Initialize selected preset when club or presets change
  useEffect(() => {
    if (!activeClub) {
      setSelectedPresetId(null);
      setDraft(null);
      setSavedSignature('');
      setConfirmDoubtful(false);
      return;
    }

    if (tacticalPresets.length > 0) {
      const target =
        (selectedPresetId && tacticalPresets.find((p) => p.id === selectedPresetId)) ||
        tacticalPresets.find((p) => p.isDefault) ||
        tacticalPresets[0];
      if (!draft || (draft.id !== null && draft.id !== target.id)) {
        const nextDraft = presetToDraft(target);
        setSelectedPresetId(target.id);
        setDraft(nextDraft);
        setSavedSignature(serializeDraft(nextDraft));
        setConfirmDoubtful(false);
      }
    } else if (!draft) {
      const blank = buildBlankDraft();
      setSelectedPresetId(null);
      setDraft(blank);
      setSavedSignature(serializeDraft(blank));
      setConfirmDoubtful(false);
    }
  }, [activeClub?.id, tacticalPresets]);

  const assignedIds = useMemo(
    () =>
      new Set(
        (draft?.assignments ?? []).map((a) => a.playerId).filter((id): id is string => Boolean(id))
      ),
    [draft?.assignments]
  );

  const selectedDoubtfulIds = useMemo(() => {
    if (!draft) return [];
    const ids = new Set<string>();
    for (const a of draft.assignments) {
      if (!a.playerId) continue;
      const p = playerById.get(a.playerId);
      if (p && evaluatePlayerEligibility(p).requiresConfirmation) ids.add(p.id);
    }
    for (const bId of draft.benchPlayerIds) {
      const p = playerById.get(bId);
      if (p && evaluatePlayerEligibility(p).requiresConfirmation) ids.add(p.id);
    }
    return [...ids];
  }, [draft, playerById]);

  const confirmedDoubtfulIds = useMemo(
    () => (confirmDoubtful ? selectedDoubtfulIds : []),
    [confirmDoubtful, selectedDoubtfulIds]
  );

  const eligibilityReport = useMemo(() => {
    if (!draft) return null;
    return validateLineupEligibility({
      clubPlayers: players,
      assignments: draft.assignments.map((a) => ({
        slotOrder: a.slotIndex,
        slotId: a.slotId,
        positionCode: toCanonicalFc26Position(a.positionCode) ?? a.positionCode.toUpperCase(),
        playerId: a.playerId,
      })),
      benchPlayerIds: draft.benchPlayerIds,
      confirmedDoubtfulPlayerIds: confirmedDoubtfulIds,
    });
  }, [draft, players, confirmedDoubtfulIds]);

  // Live debounced 3-Layer Tactical Vision Evaluation
  useEffect(() => {
    if (!draft || !activeClub) {
      setThreeLayerEval(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      desktopBridge
        .evaluateThreeLayerTactics({
          clubId: activeClub.id,
          tacticalVisionKey: draft.tacticalVisionKey,
          formationName: draft.formationName,
          buildUpStyle: draft.buildUpStyle,
          defensiveApproach: draft.defensiveApproach,
          defensiveLineHeight: draft.defensiveLineHeight,
          assignments: draft.assignments.map((a) => ({
            slotOrder: a.slotIndex,
            slotId: a.slotId,
            positionCode: toCanonicalFc26Position(a.positionCode) ?? a.positionCode.toUpperCase(),
            playerId: a.playerId,
            playerDisplayName: a.playerName,
            role: a.role,
            focus: a.focus,
          })),
          benchPlayerIds: draft.benchPlayerIds,
          confirmedDoubtfulPlayerIds: confirmedDoubtfulIds,
        })
        .then((ev) => {
          if (active) setThreeLayerEval(ev);
        })
        .catch(() => {
          // keep previous evaluation if transient
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draft, activeClub?.id, confirmedDoubtfulIds, familiarities]);

  const isDirty = useMemo(() => {
    if (!draft) return false;
    if (draft.id === null) {
      return (
        serializeDraft(draft) !== savedSignature ||
        draft.assignments.some((a) => a.playerId !== null)
      );
    }
    return serializeDraft(draft) !== savedSignature;
  }, [draft, savedSignature]);

  const handleSaveDraft = useCallback(
    async (requestedStatus: TacticalPresetStatus = 'match_ready'): Promise<boolean> => {
      if (!activeClub || !draft) return false;
      if (!draft.name.trim()) {
        notify('error', 'Tactical preset name is required.');
        return false;
      }

      // Prevent duplicate players in Starting XI
      const seen = new Set<string>();
      for (const a of draft.assignments) {
        if (a.playerId) {
          if (seen.has(a.playerId)) {
            notify(
              'error',
              'Duplicate player detected in Starting XI. Each player can occupy only one slot.'
            );
            return false;
          }
          seen.add(a.playerId);
        }
      }

      if (requestedStatus === 'match_ready' && eligibilityReport) {
        if (eligibilityReport.hasBlockingIssues) {
          const first = eligibilityReport.issues[0];
          notify(
            'error',
            `Cannot confirm match-ready setup: ${first.playerDisplayName} (${first.reason}). Replace ineligible players or save as Draft.`
          );
          return false;
        }
        if (eligibilityReport.hasUnconfirmedDoubtful) {
          notify(
            'error',
            'Confirm doubtful player(s) using the confirmation checkbox before saving as Match-Ready.'
          );
          return false;
        }
      }

      setSaving(true);
      try {
        const payload = {
          name: draft.name.trim(),
          formationId:
            catalogFormations.find((f) => f.name === draft.formationName)?.id ?? draft.formationId,
          formationName: draft.formationName,
          tacticalVisionKey: draft.tacticalVisionKey,
          buildUpStyle: draft.buildUpStyle,
          defensiveApproach: draft.defensiveApproach,
          defensiveLineHeight: draft.defensiveLineHeight,
          isDefault: draft.isDefault,
          presetStatus: requestedStatus,
          benchPlayerIds: draft.benchPlayerIds.filter((id) => !seen.has(id)),
          confirmedDoubtfulPlayerIds: confirmedDoubtfulIds,
          notes: draft.notes,
          assignments: draft.assignments.map((a) => ({
            slotOrder: a.slotIndex,
            slotId: a.slotId,
            positionCode: toCanonicalFc26Position(a.positionCode) ?? a.positionCode.toUpperCase(),
            playerId: a.playerId,
            role: a.role,
            focus: a.focus,
          })),
        };

        let saved: TacticalPreset;
        if (draft.id) {
          saved = await desktopBridge.updateTacticalPreset(draft.id, payload);
          notify(
            'success',
            requestedStatus === 'draft'
              ? `Saved draft tactical preset "${saved.name}".`
              : `Saved match-ready tactical preset "${saved.name}".`
          );
        } else {
          saved = await desktopBridge.createTacticalPreset(activeClub.id, payload);
          notify(
            'success',
            requestedStatus === 'draft'
              ? `Created draft tactical preset "${saved.name}".`
              : `Created match-ready tactical preset "${saved.name}".`
          );
        }

        const nextDraft = presetToDraft(saved);
        setSelectedPresetId(saved.id);
        setDraft(nextDraft);
        setSavedSignature(serializeDraft(nextDraft));
        await refreshAll();
        return true;
      } catch (err) {
        notify('error', err instanceof Error ? err.message : 'Failed to save tactical preset');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [
      activeClub,
      catalogFormations,
      confirmedDoubtfulIds,
      draft,
      eligibilityReport,
      notify,
      presetToDraft,
      refreshAll,
    ]
  );

  const handleDiscardChanges = useCallback(() => {
    if (selectedPresetId) {
      const savedPreset = tacticalPresets.find((p) => p.id === selectedPresetId);
      if (savedPreset) {
        const restored = presetToDraft(savedPreset);
        setDraft(restored);
        setSavedSignature(serializeDraft(restored));
        setConfirmDoubtful(false);
        return;
      }
    }
    const blank = buildBlankDraft();
    setDraft(blank);
    setSavedSignature(serializeDraft(blank));
    setConfirmDoubtful(false);
  }, [buildBlankDraft, presetToDraft, selectedPresetId, tacticalPresets]);

  // Register global dirty-state navigation guard with AppContext
  const saveRef = useRef(handleSaveDraft);
  const discardRef = useRef(handleDiscardChanges);
  saveRef.current = handleSaveDraft;
  discardRef.current = handleDiscardChanges;

  useEffect(() => {
    registerDirtyGuard(
      isDirty
        ? {
            isDirty: true,
            label: `Tactical Setup (${draft?.name || 'Unsaved Preset'})`,
            onSave: () =>
              saveRef.current(eligibilityReport?.hasBlockingIssues ? 'draft' : 'match_ready'),
            onDiscard: () => discardRef.current(),
          }
        : null
    );
    return () => registerDirtyGuard(null);
  }, [isDirty, draft?.name, eligibilityReport?.hasBlockingIssues, registerDirtyGuard]);

  const selectedCatalogFormation = useMemo(
    () => (draft ? catalogFormations.find((f) => f.name === draft.formationName) ?? null : null),
    [catalogFormations, draft]
  );

  const filteredSquadPlayers = useMemo(() => {
    const q = squadFilter.trim().toLowerCase();
    return players.filter((p) => {
      if (q) {
        const matches =
          p.displayName.toLowerCase().includes(q) ||
          p.fullName.toLowerCase().includes(q) ||
          p.position.toLowerCase().includes(q);
        if (!matches) return false;
      }
      if (!showUnavailablePlayers) {
        return evaluatePlayerEligibility(p).eligible;
      }
      return true;
    });
  }, [players, squadFilter, showUnavailablePlayers]);

  if (!activeClub) {
    return (
      <div className="max-w-2xl border border-white/[0.08] bg-[#12151B] rounded-lg p-8">
        <h1 className="text-[20px] font-semibold text-white">No Active Career Mode Club</h1>
        <p className="mt-2 text-[14px] text-[#9AA4B4]">
          Tactical presets belong to a specific Career Mode club. Create or activate a club first.
        </p>
        <button
          type="button"
          onClick={() => requestNavigation('clubs')}
          className="mt-5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
        >
          Go to Career Mode Clubs
        </button>
      </div>
    );
  }

  function handleSelectPreset(preset: TacticalPreset) {
    if (isDirty) {
      notify('error', 'Save or reset your current unsaved tactical changes before switching presets.');
      return;
    }
    const nextDraft = presetToDraft(preset);
    setSelectedPresetId(preset.id);
    setDraft(nextDraft);
    setSavedSignature(serializeDraft(nextDraft));
    setConfirmDoubtful(false);
  }

  function handleNewPreset() {
    if (isDirty) {
      notify('error', 'Save or reset current unsaved changes before creating a new preset.');
      return;
    }
    const blank = buildBlankDraft();
    setSelectedPresetId(null);
    setDraft(blank);
    setSavedSignature(serializeDraft(blank));
    setConfirmDoubtful(false);
  }

  async function handleDuplicatePreset(preset: TacticalPreset) {
    try {
      const dup = await desktopBridge.duplicateTacticalPreset(preset.id);
      await refreshAll();
      const nextDraft = presetToDraft(dup);
      setSelectedPresetId(dup.id);
      setDraft(nextDraft);
      setSavedSignature(serializeDraft(nextDraft));
      setConfirmDoubtful(false);
      notify('success', `Duplicated preset as "${dup.name}".`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to duplicate preset');
    }
  }

  async function handleSetDefaultPreset(preset: TacticalPreset) {
    try {
      const updated = await desktopBridge.setDefaultTacticalPreset(preset.id);
      await refreshAll();
      if (draft?.id === updated.id) {
        setDraft({ ...draft, isDefault: true });
      }
      notify('success', `"${updated.name}" is now the default matchday tactical preset.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to set default preset');
    }
  }

  async function handleConfirmDeletePreset() {
    if (!deleteTarget) return;
    try {
      await desktopBridge.deleteTacticalPreset(deleteTarget.id);
      notify('info', `Deleted tactical preset "${deleteTarget.name}". Historical match snapshots preserved.`);
      const remaining = tacticalPresets.filter((p) => p.id !== deleteTarget.id);
      setDeleteTarget(null);
      await refreshAll();
      if (remaining[0]) {
        const next = presetToDraft(remaining[0]);
        setSelectedPresetId(remaining[0].id);
        setDraft(next);
        setSavedSignature(serializeDraft(next));
      } else {
        const blank = buildBlankDraft();
        setSelectedPresetId(null);
        setDraft(blank);
        setSavedSignature(serializeDraft(blank));
      }
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to delete preset');
    }
  }

  function handleFormationChange(nextFormationName: string) {
    if (!draft) return;
    const catForm = catalogFormations.find((f) => f.name === nextFormationName);
    setDraft({
      ...draft,
      formationId: catForm?.id ?? null,
      formationName: nextFormationName,
      assignments: buildSlotsForFormation(nextFormationName, draft.assignments),
    });
  }

  function updateSlot(slotIndex: number, patch: Partial<PlayerRoleAssignment>) {
    if (!draft) return;
    setDraft({
      ...draft,
      assignments: draft.assignments.map((a) =>
        a.slotIndex === slotIndex ? { ...a, ...patch } : a
      ),
    });
  }

  function handleAssignPlayer(slot: PlayerRoleAssignment, playerId: string) {
    if (!draft) return;
    if (!playerId) {
      updateSlot(slot.slotIndex, { playerId: null, playerName: null });
      return;
    }

    const found = playerById.get(playerId);
    if (!found) return;

    const evalRes = evaluatePlayerEligibility(found);
    if (!evalRes.eligible) {
      notify(
        'error',
        `${resolvePlayerDisplayName(found)} cannot be assigned: ${evalRes.reasons.join(' ')}`
      );
      return;
    }

    // Prevent duplicate assignment across slots
    const existingSlot = draft.assignments.find(
      (a) => a.slotIndex !== slot.slotIndex && a.playerId === playerId
    );
    if (existingSlot) {
      notify(
        'error',
        `Player is already assigned to ${getDisplayPositionLabel(existingSlot.positionCode)}. Remove them from that slot first.`
      );
      return;
    }

    const canonicalPos =
      toCanonicalFc26Position(slot.positionCode) ?? slot.positionCode.toUpperCase();
    const validRoles = getValidRolesForPosition(canonicalPos);
    let nextRole = slot.role;
    let nextFocus = slot.focus;
    if (
      found.playerRole &&
      (validRoles.length === 0 || validRoles.some((r) => r.name === found.playerRole))
    ) {
      nextRole = found.playerRole;
      const validFocuses = getValidFocusesForRole(nextRole, canonicalPos);
      if (validFocuses.length > 0) {
        nextFocus =
          found.playerFocus && validFocuses.includes(found.playerFocus)
            ? found.playerFocus
            : validFocuses[0];
      }
    }

    setDraft({
      ...draft,
      benchPlayerIds: draft.benchPlayerIds.filter((id) => id !== found.id),
      assignments: draft.assignments.map((a) =>
        a.slotIndex === slot.slotIndex
          ? {
              ...a,
              positionCode: canonicalPos,
              playerId: found.id,
              playerName: resolvePlayerDisplayName(found),
              role: nextRole,
              focus: nextFocus,
            }
          : a
      ),
    });
  }

  function handleRoleChange(slot: PlayerRoleAssignment, nextRole: string) {
    const validFocuses = getValidFocusesForRole(nextRole, slot.positionCode);
    const nextFocus =
      validFocuses.length > 0
        ? validFocuses.includes(slot.focus)
          ? slot.focus
          : validFocuses[0]
        : slot.focus;
    updateSlot(slot.slotIndex, { role: nextRole, focus: nextFocus });
  }

  function toggleBenchPlayer(playerId: string) {
    if (!draft) return;
    if (draft.benchPlayerIds.includes(playerId)) {
      setDraft({
        ...draft,
        benchPlayerIds: draft.benchPlayerIds.filter((id) => id !== playerId),
      });
      return;
    }
    const found = playerById.get(playerId);
    if (!found) return;
    const evalRes = evaluatePlayerEligibility(found);
    if (!evalRes.eligible) {
      notify(
        'error',
        `${resolvePlayerDisplayName(found)} cannot be added to the bench: ${evalRes.reasons.join(' ')}`
      );
      return;
    }
    setDraft({
      ...draft,
      benchPlayerIds: [...draft.benchPlayerIds, playerId].slice(0, 9),
    });
  }

  function handleFixLayer2Conflicts() {
    if (!draft || !threeLayerEval) return;
    const conflicts = threeLayerEval.layer2OfficialRequirements.conflicts;
    if (conflicts.length === 0) return;
    let nextBuildUp = draft.buildUpStyle;
    let nextDefensive = draft.defensiveApproach;
    for (const c of conflicts) {
      if (c.parameterType === 'build_up_style') nextBuildUp = c.suggestedCorrectionValue;
      if (c.parameterType === 'defensive_approach') nextDefensive = c.suggestedCorrectionValue;
    }
    setDraft({
      ...draft,
      buildUpStyle: nextBuildUp,
      defensiveApproach: nextDefensive,
    });
    notify(
      'success',
      `Applied official ${threeLayerEval.tacticalVisionName} Layer 2 setting(s). Save preset when ready.`
    );
  }

  async function handleFamiliarityChange(
    playerId: string,
    positionCode: string,
    roleName: string,
    confirmedFamiliarity: RoleFamiliarityTier
  ) {
    try {
      const saved = await desktopBridge.savePlayerRoleFamiliarity(playerId, {
        positionCode,
        roleName,
        confirmedFamiliarity,
      });
      setFamiliarities((prev) => {
        const filtered = prev.filter(
          (f) =>
            !(
              f.playerId === saved.playerId &&
              f.positionCode === saved.positionCode &&
              f.roleName === saved.roleName
            )
        );
        return [...filtered, saved];
      });
      notify('success', `Saved confirmed familiarity (${confirmedFamiliarity.replace(/_/g, ' ')}) for ${roleName}.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save role familiarity');
    }
  }

  function handleApplyOptimizationChanges(
    result: VisionOptimizationResult,
    selectedChangeIndices: number[]
  ) {
    if (!draft) return;
    const selectedSet = new Set(selectedChangeIndices);
    let nextBuildUp = draft.buildUpStyle;
    let nextDefensive = draft.defensiveApproach;
    let nextLineHeight = draft.defensiveLineHeight;
    let nextAssignments = [...draft.assignments];

    result.proposals.forEach((change, idx) => {
      if (!selectedSet.has(idx)) return;
      if (change.category === 'build_up_style') {
        nextBuildUp = change.proposedValue;
      } else if (change.category === 'defensive_approach') {
        nextDefensive = change.proposedValue;
      } else if (change.category === 'defensive_line_height') {
        const parsed = Number(change.proposedValue);
        if (!Number.isNaN(parsed)) nextLineHeight = parsed;
      } else if (change.slotOrder !== undefined) {
        const proposedSlot = result.afterPreview.assignments.find(
          (s) => s.slotOrder === change.slotOrder
        );
        if (!proposedSlot) return;
        nextAssignments = nextAssignments.map((slot) => {
          if (slot.slotIndex !== change.slotOrder) return slot;
          if (change.category === 'role_focus') {
            return { ...slot, role: proposedSlot.role, focus: proposedSlot.focus };
          }
          if (change.category === 'player_swap') {
            const p = proposedSlot.playerId ? playerById.get(proposedSlot.playerId) : undefined;
            return {
              ...slot,
              playerId: proposedSlot.playerId,
              playerName: p ? resolvePlayerDisplayName(p) : proposedSlot.playerName ?? null,
            };
          }
          return slot;
        });
      }
    });

    setDraft({
      ...draft,
      tacticalVisionKey: result.targetVisionKey,
      buildUpStyle: nextBuildUp,
      defensiveApproach: nextDefensive,
      defensiveLineHeight: nextLineHeight,
      assignments: nextAssignments,
    });
    notify(
      'success',
      `Applied ${selectedChangeIndices.length} selected optimization change(s) to draft. Review and click Save Tactical Setup.`
    );
  }

  const canSaveMatchReady = Boolean(
    draft &&
      !saving &&
      (!eligibilityReport ||
        (!eligibilityReport.hasBlockingIssues && !eligibilityReport.hasUnconfirmedDoubtful))
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-[24px] font-bold text-white tracking-tight">
              Tactical Setup — {activeClub.name}
            </h1>
            {isDirty && (
              <span className="px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] font-medium text-amber-300">
                Unsaved Changes
              </span>
            )}
            {draft && eligibilityReport?.hasBlockingIssues && (
              <span className="px-2 py-0.5 rounded border border-red-500/45 bg-red-500/10 text-[11px] font-medium text-red-300">
                Ineligible Player(s) in Lineup
              </span>
            )}
            {draft && !eligibilityReport?.hasBlockingIssues && draft.presetStatus === 'draft' && (
              <span className="px-2 py-0.5 rounded border border-white/[0.18] bg-white/[0.05] text-[11px] font-medium text-[#C5CCD7]">
                Draft
              </span>
            )}
          </div>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Maintain persistent club Tactical Presets with canonical EA SPORTS FC 26 positions,
            FC IQ roles &amp; focuses, and centralized squad matchday eligibility validation.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleNewPreset}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-white/[0.14] hover:border-emerald-500/60 bg-[#12151B] text-[13px] text-white font-medium"
          >
            <Plus className="w-4 h-4" />
            New Preset
          </button>
          <button
            type="button"
            disabled={!isDirty || saving}
            onClick={() => setConfirmReset(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-white/[0.12] hover:border-white/[0.24] disabled:opacity-40 text-[13px] text-[#C5CCD7]"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          {eligibilityReport?.hasBlockingIssues && (
            <button
              type="button"
              disabled={saving || !draft}
              onClick={() => void handleSaveDraft('draft')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-45 text-amber-200 text-[13px] font-medium"
            >
              <Save className="w-4 h-4" />
              Save as Draft
            </button>
          )}
          <button
            type="button"
            disabled={!canSaveMatchReady}
            onClick={() => void handleSaveDraft('match_ready')}
            title={
              eligibilityReport?.hasBlockingIssues
                ? 'Replace or remove ineligible players before confirming as Match-Ready'
                : eligibilityReport?.hasUnconfirmedDoubtful
                  ? 'Confirm doubtful player(s) below before saving as Match-Ready'
                  : 'Save validated match-ready tactical preset'
            }
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-45 text-white text-[13px] font-medium"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Tactical Setup'}
          </button>
        </div>
      </div>

      {/* Saved Tactical Presets Strip */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span className="font-semibold text-white">
            Saved Club Tactical Presets ({tacticalPresets.length})
          </span>
          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono tabular-nums">
            <span className="text-emerald-400">
              {squadEligibilitySummary.eligibleCount} Eligible
            </span>
            <span className="text-amber-300">
              {squadEligibilitySummary.doubtfulCount} Doubtful
            </span>
            <span className="text-red-300">
              {squadEligibilitySummary.ineligibleCount} Unavailable / Out
            </span>
          </div>
        </div>

        {tacticalPresets.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {tacticalPresets.map((preset) => {
              const isSelected = draft?.id === preset.id;
              const filledSlots = preset.assignments.filter((a) => Boolean(a.playerId)).length;
              const presetValidation = validateLineupEligibility({
                clubPlayers: players,
                assignments: preset.assignments.map((a) => ({
                  slotOrder: a.slotOrder,
                  slotId: a.slotId,
                  positionCode:
                    toCanonicalFc26Position(a.positionCode) ?? a.positionCode.toUpperCase(),
                  playerId: a.playerId,
                })),
                benchPlayerIds: preset.benchPlayerIds,
                confirmedDoubtfulPlayerIds: players.map((p) => p.id),
              });
              return (
                <div
                  key={preset.id}
                  onClick={() => handleSelectPreset(preset)}
                  className={`cursor-pointer rounded-md border p-3.5 transition-colors space-y-2 ${
                    isSelected
                      ? 'border-emerald-500 bg-emerald-500/[0.08]'
                      : presetValidation.hasBlockingIssues
                        ? 'border-red-500/40 bg-red-500/[0.04] hover:border-red-500/60'
                        : 'border-white/[0.08] bg-[#0C0F14] hover:border-white/[0.2]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-white text-[13px] truncate flex items-center gap-1.5">
                        {preset.name}
                        {preset.isDefault && (
                          <span className="text-[10px] font-mono uppercase text-emerald-400">
                            Default
                          </span>
                        )}
                        {presetValidation.hasBlockingIssues ? (
                          <span className="text-[10px] font-mono uppercase text-red-400">
                            Squad Fix Needed
                          </span>
                        ) : preset.presetStatus === 'draft' ? (
                          <span className="text-[10px] font-mono uppercase text-amber-300">
                            Draft
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-[#8A94A6] mt-0.5">
                        {preset.formationName} · {filledSlots}/11 XI · Line{' '}
                        {preset.defensiveLineHeight}
                      </div>
                    </div>
                    <div
                      className="flex items-center gap-1 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {!preset.isDefault && (
                        <button
                          type="button"
                          onClick={() => void handleSetDefaultPreset(preset)}
                          title="Set as Default Preset"
                          className="p-1 rounded hover:bg-white/[0.08] text-[#8A94A6] hover:text-emerald-300"
                        >
                          <Star className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDuplicatePreset(preset)}
                        title="Duplicate Preset"
                        className="p-1 rounded hover:bg-white/[0.08] text-[#8A94A6] hover:text-white"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(preset)}
                        title="Delete Preset"
                        className="p-1 rounded hover:bg-red-500/10 text-[#8A94A6] hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="text-[11px] text-[#9AA4B4]">
                    {preset.buildUpStyle} · {preset.defensiveApproach}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-[13px] text-[#9AA4B4]">
            No tactical presets saved for {activeClub.name} yet. Configure your first formation and
            Starting XI below, then click <strong className="text-white">Save Tactical Setup</strong>.
          </div>
        )}
      </section>

      {/* Blocking Ineligible Players Banner (Preserves existing invalid references & offers replacements) */}
      {eligibilityReport && eligibilityReport.hasBlockingIssues && (
        <div className="border border-red-500/45 bg-red-500/[0.07] rounded-lg p-4 space-y-2.5 text-[13px] text-red-100">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">
                Matchday Eligibility Blocked ({eligibilityReport.issues.length}{' '}
                {eligibilityReport.issues.length === 1 ? 'player' : 'players'})
              </div>
              <p className="text-[12px] text-red-200/85 mt-0.5">
                The following assigned player(s) are ineligible for matchday selection. Replace or
                remove them before confirming this setup as Match-Ready (you may still click{' '}
                <strong className="text-white">Save as Draft</strong> to preserve work in progress):
              </p>
            </div>
          </div>
          <ul className="space-y-1.5 pl-6 text-[12px]">
            {eligibilityReport.issues.map((issue) => (
              <li
                key={`${issue.scope}-${issue.slotOrder ?? issue.playerId}`}
                className="flex flex-wrap items-center justify-between gap-2 bg-black/25 border border-red-500/25 rounded px-2.5 py-1.5"
              >
                <span>
                  <span className="font-mono text-red-300 mr-1.5">
                    {issue.scope === 'starting_xi'
                      ? `${getDisplayPositionLabel(issue.positionCode ?? '')} #${(issue.slotOrder ?? 0) + 1}`
                      : 'BENCH'}
                  </span>
                  <strong className="text-white">{issue.playerDisplayName}</strong> — {issue.reason}
                </span>
                {issue.scope === 'bench' && (
                  <button
                    type="button"
                    onClick={() => toggleBenchPlayer(issue.playerId)}
                    className="px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/35 text-red-200 text-[11px]"
                  >
                    Remove from Bench
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Doubtful Player Explicit Confirmation Banner */}
      {selectedDoubtfulIds.length > 0 && (
        <div className="border border-amber-500/40 bg-amber-500/[0.07] rounded-lg p-4 space-y-2 text-[13px] text-amber-100">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">
                Doubtful Player(s) Selected ({selectedDoubtfulIds.length})
              </div>
              <p className="text-[12px] text-amber-200/85 mt-0.5">
                {selectedDoubtfulIds
                  .map((id) => {
                    const p = playerById.get(id);
                    return p ? `${resolvePlayerDisplayName(p)} (${p.position})` : id;
                  })
                  .join(' · ')}{' '}
                — flagged as fitness doubtful. Confirm selection explicitly to save as Match-Ready.
              </p>
            </div>
          </div>
          <label className="inline-flex items-center gap-2 pl-6 cursor-pointer text-[12px] text-amber-100 font-medium">
            <input
              type="checkbox"
              checked={confirmDoubtful}
              onChange={(e) => setConfirmDoubtful(e.target.checked)}
              className="w-4 h-4 accent-amber-500"
            />
            Confirm doubtful player(s) for matchday selection
          </label>
        </div>
      )}

      {/* Main Editor */}
      {draft && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Left 7 cols */}
          <div className="xl:col-span-7 space-y-6">
            <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Preset Name *</label>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="e.g. Home High Press 4-3-3"
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Formation</label>
                  <select
                    value={draft.formationName}
                    onChange={(e) => handleFormationChange(e.target.value)}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                  >
                    {!formations.includes(draft.formationName) && (
                      <option value={draft.formationName}>{draft.formationName}</option>
                    )}
                    {formations.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Build-Up Style</label>
                  <select
                    value={draft.buildUpStyle}
                    onChange={(e) => setDraft({ ...draft, buildUpStyle: e.target.value })}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                  >
                    {buildUpOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Defensive Approach
                  </label>
                  <select
                    value={draft.defensiveApproach}
                    onChange={(e) => setDraft({ ...draft, defensiveApproach: e.target.value })}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                  >
                    {defensiveOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Phase 3 — Tactical Vision Selector & Comparison/Optimizer Controls */}
              <div className="rounded-md border border-white/[0.08] bg-[#0C0F14] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[13px] font-semibold text-white">
                      EA SPORTS FC 26 Tactical Vision
                    </div>
                    <div className="text-[11px] text-[#7D8798]">
                      Selecting a Tactical Vision never silently overwrites your Build-Up,
                      Defensive Approach, or player roles.
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={tacticalVisions.length < 2}
                      onClick={() => setShowCompareModal(true)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/[0.12] hover:border-emerald-500/50 text-[11px] text-[#D7DDE7]"
                    >
                      <GitCompare className="w-3.5 h-3.5 text-emerald-400" />
                      Compare Visions
                    </button>
                    <button
                      type="button"
                      disabled={tacticalVisions.length === 0}
                      onClick={() => setShowOptimizeModal(true)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-emerald-500/40 bg-emerald-600/15 hover:bg-emerald-600/25 text-[11px] text-emerald-200 font-medium"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Optimize for Vision
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
                  <select
                    value={draft.tacticalVisionKey}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        tacticalVisionKey: e.target.value as TacticalVisionKey | 'unspecified',
                      })
                    }
                    className="w-full bg-[#12151B] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                  >
                    <option value="unspecified">Unspecified (No Tactical Vision Target)</option>
                    {tacticalVisions.map((v) => (
                      <option key={v.internalKey} value={v.internalKey}>
                        {v.displayName}
                        {v.aliases.length > 0 ? ` (${v.aliases[0]})` : ''}
                      </option>
                    ))}
                  </select>

                  {threeLayerEval && (
                    <div className="text-[11px] font-mono text-[#C5CCD7] flex flex-wrap items-center gap-3">
                      <span
                        className={
                          threeLayerEval.layer1FcIqLegality.valid
                            ? 'text-emerald-400'
                            : 'text-red-400'
                        }
                      >
                        L1 Legality: {threeLayerEval.layer1FcIqLegality.valid ? 'OK' : 'Blocked'}
                      </span>
                      <span
                        className={
                          threeLayerEval.layer2OfficialRequirements.verifiedVisionCompliant
                            ? 'text-emerald-400'
                            : 'text-amber-300'
                        }
                      >
                        L2 Vision Req:{' '}
                        {threeLayerEval.layer2OfficialRequirements.verifiedVisionCompliant
                          ? 'Compliant'
                          : `${threeLayerEval.layer2OfficialRequirements.conflicts.length} Conflict(s)`}
                      </span>
                      <span className="text-sky-300">
                        L3 Affinity: {threeLayerEval.layer3RoleAffinity.matchedCount} of{' '}
                        {threeLayerEval.layer3RoleAffinity.assignedRoleCount}
                        {threeLayerEval.layer3RoleAffinity.unknownCount > 0
                          ? ` (${threeLayerEval.layer3RoleAffinity.unknownCount} unknown)`
                          : ''}
                      </span>
                    </div>
                  )}
                </div>

                {/* Layer 2 Official Conflict Banner with Explicit 1-Click Fix */}
                {threeLayerEval &&
                  !threeLayerEval.layer2OfficialRequirements.verifiedVisionCompliant &&
                  threeLayerEval.layer2OfficialRequirements.conflicts.length > 0 && (
                    <div className="rounded border border-amber-500/40 bg-amber-500/[0.08] p-3 flex flex-wrap items-start justify-between gap-3 text-[12px]">
                      <div className="space-y-1 text-amber-100">
                        <div className="font-semibold flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                          Layer 2 Official FC 26 Requirement Conflict (
                          {threeLayerEval.tacticalVisionName})
                        </div>
                        <ul className="space-y-0.5 text-[11px] text-amber-200/90">
                          {threeLayerEval.layer2OfficialRequirements.conflicts.map((c, idx) => (
                            <li key={idx}>• {c.explanation}</li>
                          ))}
                        </ul>
                      </div>
                      <button
                        type="button"
                        onClick={handleFixLayer2Conflicts}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-medium shrink-0"
                      >
                        <Wrench className="w-3.5 h-3.5" />
                        Fix Build-Up/Defensive Setting
                      </button>
                    </div>
                  )}

                {/* Layer 3 Advisory Role Affinity & Coach Potential Summary */}
                {threeLayerEval && draft.tacticalVisionKey !== 'unspecified' && (
                  <div className="text-[11px] text-[#9AA4B4] border-t border-white/[0.06] pt-2 space-y-0.5">
                    <div>{threeLayerEval.layer3RoleAffinity.coachPotentialSummary.note}</div>
                    <div className="text-[10px] text-[#7D8798]">
                      {threeLayerEval.layer3RoleAffinity.disclaimer}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[12px] text-[#9AA4B4]">Defensive Line Height</label>
                  <span className="text-[13px] font-mono tabular-nums text-emerald-400">
                    {draft.defensiveLineHeight} / 100
                  </span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={95}
                  value={draft.defensiveLineHeight}
                  onChange={(e) =>
                    setDraft({ ...draft, defensiveLineHeight: Number(e.target.value) })
                  }
                  className="w-full accent-emerald-500"
                />
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                  Tactical Preset Notes (Optional)
                </label>
                <textarea
                  rows={2}
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                  placeholder="When to deploy this setup, pressing triggers, transition shape..."
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                />
              </div>

              {/* Starting XI 11-Slot Assignment Table */}
              <div className="pt-3 border-t border-white/[0.08] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[14px] font-semibold text-white">
                      Starting XI Assignments &amp; FC IQ Roles
                    </h2>
                    <p className="text-[11px] text-[#7D8798]">
                      Canonical EA SPORTS FC 26 positions · Eligible squad players only · Duplicates
                      prevented
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowUnavailablePlayers((v) => !v)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-medium transition-colors ${
                        showUnavailablePlayers
                          ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
                          : 'border-white/[0.12] bg-[#0C0F14] text-[#9AA4B4] hover:text-white'
                      }`}
                    >
                      {showUnavailablePlayers ? (
                        <Eye className="w-3.5 h-3.5" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5" />
                      )}
                      {showUnavailablePlayers ? 'Showing Unavailable' : 'Show Unavailable Players'}
                    </button>
                    <div className="relative w-44">
                      <Search className="w-3.5 h-3.5 text-[#7D8798] absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={squadFilter}
                        onChange={(e) => setSquadFilter(e.target.value)}
                        placeholder="Filter squad..."
                        className="w-full bg-[#0C0F14] border border-white/[0.1] rounded pl-7 pr-2 py-1 text-[12px] text-white"
                      />
                    </div>
                  </div>
                </div>

                {players.length === 0 && (
                  <div className="rounded border border-white/[0.08] bg-[#0C0F14] p-3 text-[12px] text-[#9AA4B4] flex items-center justify-between gap-3">
                    <span>
                      Your squad is currently empty. Add players in Squad Management to assign a
                      Starting XI.
                    </span>
                    <button
                      type="button"
                      onClick={() => requestNavigation('squad-management')}
                      className="text-emerald-400 hover:text-emerald-300 font-medium whitespace-nowrap"
                    >
                      Open Squad Management
                    </button>
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-[#7D8798]">
                        <th className="py-2 pr-2 font-medium">Position</th>
                        <th className="py-2 pr-2 font-medium">Assigned Player</th>
                        <th className="py-2 pr-2 font-medium">FC IQ Role &amp; Vision Affinity</th>
                        <th className="py-2 pr-2 font-medium">Focus</th>
                        <th className="py-2 font-medium">Familiarity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {draft.assignments.map((slot) => {
                        const canonicalPos =
                          toCanonicalFc26Position(slot.positionCode) ??
                          slot.positionCode.toUpperCase();
                        const sideHint = getSlotSideHint(slot.slotId, canonicalPos);
                        const validRoles = getValidRolesForPosition(canonicalPos);
                        const validFocuses = getValidFocusesForRole(slot.role, canonicalPos);
                        const roleOptions =
                          validRoles.length > 0 ? validRoles.map((r) => r.name) : fallbackRoleOptions;
                        const focusOptions =
                          validFocuses.length > 0 ? validFocuses : fallbackFocusOptions;

                        const currentPlayer = slot.playerId
                          ? playerById.get(slot.playerId)
                          : undefined;
                        const currentEval = currentPlayer
                          ? evaluatePlayerEligibility(currentPlayer)
                          : null;

                        const slotAffinity = threeLayerEval?.layer3RoleAffinity.slotAffinities.find(
                          (s) => s.slotOrder === slot.slotIndex
                        );
                        const famRecord = currentPlayer
                          ? familiarities.find(
                              (f) =>
                                f.playerId === currentPlayer.id &&
                                f.positionCode === canonicalPos &&
                                f.roleName === slot.role
                            )
                          : undefined;

                        const selectOptions =
                          currentPlayer &&
                          !filteredSquadPlayers.some((p) => p.id === currentPlayer.id)
                            ? [currentPlayer, ...filteredSquadPlayers]
                            : filteredSquadPlayers;

                        const replacements =
                          currentEval && !currentEval.eligible
                            ? suggestEligibleReplacements(
                                canonicalPos,
                                players,
                                assignedIds,
                                3
                              )
                            : [];

                        return (
                          <tr
                            key={slot.slotIndex}
                            className={
                              currentEval && !currentEval.eligible ? 'bg-red-500/[0.05]' : undefined
                            }
                          >
                            <td className="py-2 pr-2 align-top">
                              <div className="font-mono font-semibold text-white">
                                {getDisplayPositionLabel(canonicalPos)}
                              </div>
                              {sideHint && (
                                <div className="text-[10px] text-[#7D8798] leading-tight">
                                  {sideHint}
                                </div>
                              )}
                            </td>
                            <td className="py-2 pr-2 align-top space-y-1">
                              <SearchablePlayerSelect
                                value={slot.playerId ?? null}
                                options={selectOptions}
                                assignedIds={assignedIds}
                                slotPosition={canonicalPos}
                                onChange={(nextPlayerId) => handleAssignPlayer(slot, nextPlayerId)}
                                unassignedLabel="Unassigned slot"
                                triggerBgClass="bg-[#0C0F14]"
                              />
                              {currentEval && !currentEval.eligible && (
                                <div className="text-[11px] text-red-300 space-y-1">
                                  <div>Invalid: {currentEval.reasons.join(' ')}</div>
                                  {replacements.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-1">
                                      <span className="text-[#8A94A6]">Replace:</span>
                                      {replacements.map((rep) => (
                                        <button
                                          key={rep.playerId}
                                          type="button"
                                          onClick={() => handleAssignPlayer(slot, rep.playerId)}
                                          className="px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 text-[10px]"
                                        >
                                          {rep.displayName} ({rep.position}
                                          {rep.overallRating ? ` ${rep.overallRating}` : ''})
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="py-2 pr-2 align-top space-y-1">
                              <select
                                value={slot.role}
                                onChange={(e) => handleRoleChange(slot, e.target.value)}
                                className="w-full bg-[#0C0F14] border border-white/[0.1] rounded px-2 py-1 text-[12px] text-white"
                              >
                                {roleOptions.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                              {slotAffinity && draft.tacticalVisionKey !== 'unspecified' && (
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span
                                    className={`text-[10px] font-mono ${
                                      slotAffinity.affinityStatus === 'associated'
                                        ? 'text-emerald-400'
                                        : slotAffinity.affinityStatus === 'not_associated'
                                          ? 'text-[#8A94A6]'
                                          : 'text-amber-300'
                                    }`}
                                  >
                                    {slotAffinity.affinityStatus === 'associated'
                                      ? 'Vision Associated'
                                      : slotAffinity.affinityStatus === 'not_associated'
                                        ? 'Not Associated (Legal)'
                                        : 'Unknown Affinity'}
                                  </span>
                                  {slotAffinity.coachBonusNote && (
                                    <span className="text-[10px] text-sky-300 font-mono">
                                      · {slotAffinity.coachBonusNote}
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="py-2 pr-2 align-top">
                              <select
                                value={slot.focus}
                                onChange={(e) => updateSlot(slot.slotIndex, { focus: e.target.value })}
                                className="w-full bg-[#0C0F14] border border-white/[0.1] rounded px-2 py-1 text-[12px] text-white"
                              >
                                {focusOptions.map((f) => (
                                  <option key={f} value={f}>
                                    {f}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="py-2 align-top">
                              {currentPlayer ? (
                                <select
                                  value={famRecord?.confirmedFamiliarity ?? 'unknown'}
                                  onChange={(e) =>
                                    void handleFamiliarityChange(
                                      currentPlayer.id,
                                      canonicalPos,
                                      slot.role,
                                      e.target.value as RoleFamiliarityTier
                                    )
                                  }
                                  title="User-confirmed FC 26 in-game role familiarity"
                                  className="w-full bg-[#0C0F14] border border-white/[0.1] rounded px-1.5 py-1 text-[11px] text-[#D7DDE7]"
                                >
                                  <option value="unknown">Unknown</option>
                                  <option value="none">None</option>
                                  <option value="role_plus">Role+</option>
                                  <option value="role_plus_plus">Role++</option>
                                </select>
                              ) : (
                                <span className="text-[11px] text-[#647082]">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Bench Selection */}
              {players.length > 0 && (
                <div className="pt-4 border-t border-white/[0.08]">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="text-[13px] font-medium text-white">
                      Substitutes Bench ({draft.benchPlayerIds.length}/9 selected)
                    </div>
                    <div className="text-[11px] text-[#7D8798]">
                      Eligible &amp; doubtful squad players only
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {players
                      .filter((p) => !assignedIds.has(p.id))
                      .filter((p) => {
                        const evalRes = evaluatePlayerEligibility(p);
                        const selected = draft.benchPlayerIds.includes(p.id);
                        return evalRes.eligible || selected || showUnavailablePlayers;
                      })
                      .map((p) => {
                        const selected = draft.benchPlayerIds.includes(p.id);
                        const evalRes = evaluatePlayerEligibility(p);
                        const disabled = !evalRes.eligible && !selected;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            disabled={disabled}
                            onClick={() => toggleBenchPlayer(p.id)}
                            title={evalRes.reasons.join(' ')}
                            className={`px-2.5 py-1 rounded-md text-[12px] border transition-colors ${
                              selected && !evalRes.eligible
                                ? 'bg-red-500/15 border-red-500/70 text-red-200'
                                : selected
                                  ? 'bg-emerald-600/20 border-emerald-500 text-emerald-200'
                                  : disabled
                                    ? 'bg-[#0C0F14]/50 border-white/[0.06] text-[#647082] cursor-not-allowed'
                                    : evalRes.requiresConfirmation
                                      ? 'bg-[#0C0F14] border-amber-500/40 text-amber-200 hover:border-amber-400'
                                      : 'bg-[#0C0F14] border-white/[0.1] text-[#9AA4B4] hover:text-white'
                            }`}
                          >
                            {resolvePlayerDisplayName(p)} ({p.position}
                            {p.overallRating ? ` · ${p.overallRating}` : ''})
                            {!evalRes.eligible
                              ? ` · ${evalRes.shortBadge}`
                              : evalRes.requiresConfirmation
                                ? ' · Doubtful'
                                : ''}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* Right 5 cols: Live Pitch Preview */}
          <div className="xl:col-span-5 xl:sticky xl:top-20 border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <TacticalPitchSVG
              formation={draft.formationName}
              formationSlots={selectedCatalogFormation?.slots}
              layoutVerified={selectedCatalogFormation?.layoutVerified ?? true}
              isUserAdjusted={selectedCatalogFormation?.isUserAdjusted ?? false}
              defensiveLineHeight={draft.defensiveLineHeight}
              assignments={draft.assignments}
              players={players}
              label={draft.name || 'Tactical Setup Preview'}
              showAttackingChannels
              showDefensiveZones
              showMovementArrows
            />
            <div className="mt-4 pt-4 border-t border-white/[0.08] grid grid-cols-2 gap-3 text-[12px]">
              <div>
                <div className="text-[#7D8798]">Tactical Vision</div>
                <div className="text-white font-medium mt-0.5">
                  {tacticalVisions.find((v) => v.internalKey === draft.tacticalVisionKey)
                    ?.displayName ?? 'Unspecified'}
                </div>
              </div>
              <div>
                <div className="text-[#7D8798]">Build-Up / Defending</div>
                <div className="text-white font-medium mt-0.5">
                  {draft.buildUpStyle} · {draft.defensiveApproach}
                </div>
              </div>
              <div className="col-span-2 text-[10px] text-[#7D8798]">
                Arrows above show <strong className="text-[#C5CCD7]">Illustrative Role Movement (Pre-Match Setup)</strong> — not observed match video evidence.
              </div>
              <div className="col-span-2 flex items-center gap-2 pt-2 border-t border-white/[0.06] text-[11px]">
                {eligibilityReport && !eligibilityReport.hasBlockingIssues ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="text-emerald-300">
                      Canonical FC26 positions &amp; squad eligibility verified
                    </span>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    <span className="text-red-300">
                      Resolve ineligible player(s) before matchday confirmation
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compare Tactical Visions Modal */}
      {showCompareModal && draft && tacticalVisions.length >= 2 && (
        <CompareVisionsModal
          visions={tacticalVisions}
          initialVisionA={
            draft.tacticalVisionKey !== 'unspecified'
              ? draft.tacticalVisionKey
              : tacticalVisions[0].internalKey
          }
          initialVisionB={
            tacticalVisions.find((v) => v.internalKey !== draft.tacticalVisionKey)?.internalKey ??
            tacticalVisions[1].internalKey
          }
          onCompare={(visionKeyA, visionKeyB) =>
            desktopBridge.compareTacticalVisions({
              visionKeyA,
              visionKeyB,
              config: {
                clubId: activeClub.id,
                formationName: draft.formationName,
                buildUpStyle: draft.buildUpStyle,
                defensiveApproach: draft.defensiveApproach,
                defensiveLineHeight: draft.defensiveLineHeight,
                assignments: draft.assignments.map((a) => ({
                  slotOrder: a.slotIndex,
                  slotId: a.slotId,
                  positionCode:
                    toCanonicalFc26Position(a.positionCode) ?? a.positionCode.toUpperCase(),
                  playerId: a.playerId,
                  playerDisplayName: a.playerName,
                  role: a.role,
                  focus: a.focus,
                })),
                benchPlayerIds: draft.benchPlayerIds,
                confirmedDoubtfulPlayerIds: confirmedDoubtfulIds,
              },
            })
          }
          onClose={() => setShowCompareModal(false)}
        />
      )}

      {/* 4-Mode Vision Optimizer Modal */}
      {showOptimizeModal && draft && tacticalVisions.length > 0 && (
        <OptimizeVisionModal
          visions={tacticalVisions}
          initialTargetVision={
            draft.tacticalVisionKey !== 'unspecified'
              ? draft.tacticalVisionKey
              : tacticalVisions[0].internalKey
          }
          onOptimize={(targetVisionKey, mode) =>
            desktopBridge.optimizeForTacticalVision({
              clubId: activeClub.id,
              tacticalVisionKey: draft.tacticalVisionKey,
              targetVisionKey,
              mode,
              formationName: draft.formationName,
              buildUpStyle: draft.buildUpStyle,
              defensiveApproach: draft.defensiveApproach,
              defensiveLineHeight: draft.defensiveLineHeight,
              assignments: draft.assignments.map((a) => ({
                slotOrder: a.slotIndex,
                slotId: a.slotId,
                positionCode:
                  toCanonicalFc26Position(a.positionCode) ?? a.positionCode.toUpperCase(),
                playerId: a.playerId,
                playerDisplayName: a.playerName,
                role: a.role,
                focus: a.focus,
              })),
              benchPlayerIds: draft.benchPlayerIds,
              confirmedDoubtfulPlayerIds: confirmedDoubtfulIds,
            })
          }
          onApplySelectedChanges={handleApplyOptimizationChanges}
          onClose={() => setShowOptimizeModal(false)}
        />
      )}

      {/* Confirm Reset Modal */}
      {confirmReset && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md border border-white/[0.12] bg-[#12151B] rounded-lg p-5 space-y-4">
            <h2 className="text-[16px] font-semibold text-white">Reset Unsaved Tactical Changes?</h2>
            <p className="text-[13px] text-[#9AA4B4]">
              This will revert all unsaved edits back to the last saved state of this tactical
              preset.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="px-3.5 py-1.5 rounded border border-white/[0.12] text-[13px] text-[#C5CCD7]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  handleDiscardChanges();
                  setConfirmReset(false);
                }}
                className="px-3.5 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-[13px] font-medium"
              >
                Reset Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Delete Preset Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md border border-red-500/35 bg-[#12151B] rounded-lg p-5 space-y-4">
            <h2 className="text-[16px] font-semibold text-white">
              Delete Tactical Preset &ldquo;{deleteTarget.name}&rdquo;?
            </h2>
            <p className="text-[13px] text-[#9AA4B4]">
              This deletes the reusable club preset. All historical matches that previously used
              this preset retain their immutable Match Tactical Snapshots unchanged.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-3.5 py-1.5 rounded border border-white/[0.12] text-[13px] text-[#C5CCD7]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDeletePreset()}
                className="px-3.5 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-[13px] font-medium"
              >
                Delete Preset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
