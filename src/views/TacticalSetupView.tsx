import {
  AlertTriangle,
  Copy,
  Plus,
  RotateCcw,
  Save,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TacticalPitchSVG } from '../components/pitch/TacticalPitchSVG';
import { useApp } from '../context/AppContext';
import { getFormationPositions } from '../data/tacticalCatalog';
import { desktopBridge } from '../services/desktopBridge';
import type {
  CatalogFormation,
  CatalogRole,
  Player,
  PlayerRoleAssignment,
  TacticalPreset,
} from '../types/domain';
import { resolvePlayerDisplayName } from '../utils/playerDisplayName';

interface PresetDraft {
  id: string | null; // null when creating a brand-new unsaved preset
  name: string;
  formationId: string | null;
  formationName: string;
  buildUpStyle: string;
  defensiveApproach: string;
  defensiveLineHeight: number;
  isDefault: boolean;
  benchPlayerIds: string[];
  notes: string;
  assignments: PlayerRoleAssignment[];
}

function serializeDraft(d: PresetDraft): string {
  return JSON.stringify({
    name: d.name.trim(),
    formationName: d.formationName,
    buildUpStyle: d.buildUpStyle,
    defensiveApproach: d.defensiveApproach,
    defensiveLineHeight: d.defensiveLineHeight,
    benchPlayerIds: [...d.benchPlayerIds],
    notes: d.notes.trim(),
    assignments: d.assignments.map((a) => ({
      slotIndex: a.slotIndex,
      positionCode: a.positionCode,
      playerId: a.playerId,
      role: a.role,
      focus: a.focus,
    })),
  });
}

function isPlayerMatchdayUnavailable(p: Player): boolean {
  return (
    p.availability !== 'available' ||
    p.squadStatus === 'loaned_out' ||
    p.squadStatus === 'transferred_out' ||
    p.squadStatus === 'released'
  );
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
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [savedSignature, setSavedSignature] = useState<string>('');
  const [squadFilter, setSquadFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TacticalPreset | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([desktopBridge.listCatalogFormations(), desktopBridge.listCatalogRoles()])
      .then(([fList, rList]) => {
        if (!active) return;
        setCatalogFormations(fList);
        setCatalogRoles(rList);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

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

  const getValidRolesForPosition = useCallback(
    (positionCode: string): CatalogRole[] =>
      catalogRoles.filter((r) => r.eligiblePositions.includes(positionCode)),
    [catalogRoles]
  );

  const getValidFocusesForRole = useCallback(
    (roleName: string, positionCode: string): string[] => {
      const roleObj = catalogRoles.find((r) => r.name === roleName);
      return roleObj?.compatibleFocusesByPosition[positionCode] ?? [];
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
              positionCode: s.positionCode,
              defaultRole: '',
              defaultFocus: '',
            }))
          : getFormationPositions(formationName).map((s) => ({
              slotIndex: s.slotIndex,
              positionCode: s.positionCode,
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
      const mappedAssignments: PlayerRoleAssignment[] = preset.assignments.map((a) => {
        const p = a.playerId ? playerById.get(a.playerId) : undefined;
        return {
          slotIndex: a.slotOrder,
          positionCode: a.positionCode,
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
        buildUpStyle: preset.buildUpStyle,
        defensiveApproach: preset.defensiveApproach,
        defensiveLineHeight: preset.defensiveLineHeight,
        isDefault: preset.isDefault,
        benchPlayerIds: preset.benchPlayerIds.filter((id) => playerById.has(id)),
        notes: preset.notes,
        assignments: completeAssignments,
      };
    },
    [buildSlotsForFormation, playerById]
  );

  const buildBlankDraft = useCallback((): PresetDraft => {
    const formationName = activeClub?.profile.primaryFormation || '4-3-3 Holding';
    const catForm = catalogFormations.find((f) => f.name === formationName);
    return {
      id: null,
      name: tacticalPresets.length === 0 ? 'Primary Matchday Setup' : `Tactical Setup #${tacticalPresets.length + 1}`,
      formationId: catForm?.id ?? null,
      formationName,
      buildUpStyle: activeClub?.profile.preferredAttackingStyle || 'Balanced',
      defensiveApproach: activeClub?.profile.preferredDefensiveStyle || 'Balanced',
      defensiveLineHeight: 55,
      isDefault: tacticalPresets.length === 0,
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
      }
    } else if (!draft) {
      const blank = buildBlankDraft();
      setSelectedPresetId(null);
      setDraft(blank);
      setSavedSignature(serializeDraft(blank));
    }
  }, [activeClub?.id, tacticalPresets]);

  const isDirty = useMemo(() => {
    if (!draft) return false;
    if (draft.id === null) {
      return serializeDraft(draft) !== savedSignature || draft.assignments.some((a) => a.playerId !== null);
    }
    return serializeDraft(draft) !== savedSignature;
  }, [draft, savedSignature]);

  const handleSaveDraft = useCallback(async (): Promise<boolean> => {
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
          notify('error', 'Duplicate player detected in Starting XI. Each player can occupy only one slot.');
          return false;
        }
        seen.add(a.playerId);
      }
    }

    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        formationId:
          catalogFormations.find((f) => f.name === draft.formationName)?.id ?? draft.formationId,
        formationName: draft.formationName,
        buildUpStyle: draft.buildUpStyle,
        defensiveApproach: draft.defensiveApproach,
        defensiveLineHeight: draft.defensiveLineHeight,
        isDefault: draft.isDefault,
        benchPlayerIds: draft.benchPlayerIds.filter((id) => !seen.has(id)),
        notes: draft.notes,
        assignments: draft.assignments.map((a) => ({
          slotOrder: a.slotIndex,
          positionCode: a.positionCode,
          playerId: a.playerId,
          role: a.role,
          focus: a.focus,
        })),
      };

      let saved: TacticalPreset;
      if (draft.id) {
        saved = await desktopBridge.updateTacticalPreset(draft.id, payload);
        notify('success', `Saved tactical preset "${saved.name}".`);
      } else {
        saved = await desktopBridge.createTacticalPreset(activeClub.id, payload);
        notify('success', `Created tactical preset "${saved.name}".`);
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
  }, [activeClub, catalogFormations, draft, notify, presetToDraft, refreshAll]);

  const handleDiscardChanges = useCallback(() => {
    if (selectedPresetId) {
      const savedPreset = tacticalPresets.find((p) => p.id === selectedPresetId);
      if (savedPreset) {
        const restored = presetToDraft(savedPreset);
        setDraft(restored);
        setSavedSignature(serializeDraft(restored));
        return;
      }
    }
    const blank = buildBlankDraft();
    setDraft(blank);
    setSavedSignature(serializeDraft(blank));
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
            onSave: () => saveRef.current(),
            onDiscard: () => discardRef.current(),
          }
        : null
    );
    return () => registerDirtyGuard(null);
  }, [isDirty, draft?.name, registerDirtyGuard]);

  const unavailableWarnings = useMemo(() => {
    if (!draft) return [];
    const warnings: string[] = [];
    for (const a of draft.assignments) {
      if (!a.playerId) continue;
      const p = playerById.get(a.playerId);
      if (p && isPlayerMatchdayUnavailable(p)) {
        warnings.push(
          `${resolvePlayerDisplayName(p)} (${a.positionCode}): ${p.availability !== 'available' ? p.availability : p.squadStatus.replace(/_/g, ' ')}`
        );
      }
    }
    return warnings;
  }, [draft, playerById]);

  const selectedCatalogFormation = useMemo(
    () => (draft ? catalogFormations.find((f) => f.name === draft.formationName) ?? null : null),
    [catalogFormations, draft]
  );

  const filteredSquadPlayers = useMemo(() => {
    const q = squadFilter.trim().toLowerCase();
    if (!q) return players;
    return players.filter(
      (p) =>
        p.displayName.toLowerCase().includes(q) ||
        p.fullName.toLowerCase().includes(q) ||
        p.position.toLowerCase().includes(q)
    );
  }, [players, squadFilter]);

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
  }

  async function handleDuplicatePreset(preset: TacticalPreset) {
    try {
      const dup = await desktopBridge.duplicateTacticalPreset(preset.id);
      await refreshAll();
      const nextDraft = presetToDraft(dup);
      setSelectedPresetId(dup.id);
      setDraft(nextDraft);
      setSavedSignature(serializeDraft(nextDraft));
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

    // Prevent duplicate assignment across slots
    const existingSlot = draft.assignments.find(
      (a) => a.slotIndex !== slot.slotIndex && a.playerId === playerId
    );
    if (existingSlot) {
      notify(
        'error',
        `Player is already assigned to ${existingSlot.positionCode}. Remove them from that slot first.`
      );
      return;
    }

    const found = playerById.get(playerId);
    if (!found) return;

    const validRoles = getValidRolesForPosition(slot.positionCode);
    let nextRole = slot.role;
    let nextFocus = slot.focus;
    if (found.playerRole && (validRoles.length === 0 || validRoles.some((r) => r.name === found.playerRole))) {
      nextRole = found.playerRole;
      const validFocuses = getValidFocusesForRole(nextRole, slot.positionCode);
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
    setDraft({
      ...draft,
      benchPlayerIds: draft.benchPlayerIds.includes(playerId)
        ? draft.benchPlayerIds.filter((id) => id !== playerId)
        : [...draft.benchPlayerIds, playerId].slice(0, 9),
    });
  }

  const assignedIds = new Set(
    (draft?.assignments ?? []).map((a) => a.playerId).filter((id): id is string => Boolean(id))
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-[24px] font-bold text-white tracking-tight">
              Tactical Setup — {activeClub.name}
            </h1>
            {isDirty && (
              <span className="px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] font-medium text-amber-300">
                Unsaved Changes
              </span>
            )}
          </div>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Create and maintain persistent club Tactical Presets with FC26-validated formations,
            Starting XI assignments, and FC IQ roles &amp; focuses. Match Preparation loads your
            default preset automatically.
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
          <button
            type="button"
            disabled={saving || !draft}
            onClick={() => void handleSaveDraft()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-45 text-white text-[13px] font-medium"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Tactical Setup'}
          </button>
        </div>
      </div>

      {/* Saved Tactical Presets Strip */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between text-[12px]">
          <span className="font-semibold text-white">
            Saved Club Tactical Presets ({tacticalPresets.length})
          </span>
          <span className="text-[#8A94A6]">
            Select a preset to edit, duplicate, or set as matchday default
          </span>
        </div>

        {tacticalPresets.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {tacticalPresets.map((preset) => {
              const isSelected = draft?.id === preset.id;
              const filledSlots = preset.assignments.filter((a) => Boolean(a.playerId)).length;
              return (
                <div
                  key={preset.id}
                  onClick={() => handleSelectPreset(preset)}
                  className={`cursor-pointer rounded-md border p-3.5 transition-colors space-y-2 ${
                    isSelected
                      ? 'border-emerald-500 bg-emerald-500/[0.08]'
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
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-[#8A94A6] mt-0.5">
                        {preset.formationName} · {filledSlots}/11 XI · Line {preset.defensiveLineHeight}
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

      {/* Unavailable Player Warning Banner */}
      {unavailableWarnings.length > 0 && (
        <div className="border border-amber-500/35 bg-amber-500/[0.06] rounded-lg p-4 flex items-start gap-3 text-[13px] text-amber-100">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Lineup Availability Warning</div>
            <p className="text-[12px] text-amber-200/85 mt-0.5">
              One or more players assigned in this tactical preset are currently injured, suspended,
              loaned out, or transferred out: {unavailableWarnings.join(' · ')}.
            </p>
          </div>
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
                      Validated against {activeClub.name}&apos;s Career Mode squad · Duplicate
                      players prevented
                    </p>
                  </div>
                  <div className="relative w-52">
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
                        <th className="py-2 pr-2 font-medium">Slot</th>
                        <th className="py-2 pr-2 font-medium">Assigned Player</th>
                        <th className="py-2 pr-2 font-medium">FC IQ Role</th>
                        <th className="py-2 font-medium">Compatible Focus</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {draft.assignments.map((slot) => {
                        const validRoles = getValidRolesForPosition(slot.positionCode);
                        const validFocuses = getValidFocusesForRole(slot.role, slot.positionCode);
                        const roleOptions =
                          validRoles.length > 0 ? validRoles.map((r) => r.name) : fallbackRoleOptions;
                        const focusOptions =
                          validFocuses.length > 0 ? validFocuses : fallbackFocusOptions;

                        const selectOptions =
                          slot.playerId && !filteredSquadPlayers.some((p) => p.id === slot.playerId)
                            ? [
                                ...players.filter((p) => p.id === slot.playerId),
                                ...filteredSquadPlayers,
                              ]
                            : filteredSquadPlayers;

                        const currentPlayer = slot.playerId
                          ? playerById.get(slot.playerId)
                          : undefined;
                        const slotHasWarning =
                          currentPlayer && isPlayerMatchdayUnavailable(currentPlayer);

                        return (
                          <tr key={slot.slotIndex}>
                            <td className="py-2 pr-2 font-mono text-white">{slot.positionCode}</td>
                            <td className="py-2 pr-2">
                              <select
                                value={slot.playerId ?? ''}
                                onChange={(e) => handleAssignPlayer(slot, e.target.value)}
                                className={`w-full bg-[#0C0F14] border rounded px-2 py-1 text-[12px] text-white ${
                                  slotHasWarning
                                    ? 'border-amber-500/60'
                                    : 'border-white/[0.1]'
                                }`}
                              >
                                <option value="">Unassigned slot</option>
                                {selectOptions.map((p) => {
                                  const usedElsewhere =
                                    assignedIds.has(p.id) && slot.playerId !== p.id;
                                  const statusSuffix = isPlayerMatchdayUnavailable(p)
                                    ? ` · [${p.availability !== 'available' ? p.availability.toUpperCase() : p.squadStatus.replace(/_/g, ' ').toUpperCase()}]`
                                    : '';
                                  return (
                                    <option
                                      key={p.id}
                                      value={p.id}
                                      disabled={usedElsewhere}
                                    >
                                      {resolvePlayerDisplayName(p)} ({p.position}
                                      {p.overallRating ? ` · ${p.overallRating}` : ''})
                                      {statusSuffix}
                                      {usedElsewhere ? ' — In XI' : ''}
                                    </option>
                                  );
                                })}
                              </select>
                            </td>
                            <td className="py-2 pr-2">
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
                            </td>
                            <td className="py-2">
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
                  <div className="text-[13px] font-medium text-white mb-2">
                    Substitutes Bench ({draft.benchPlayerIds.length}/9 selected)
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {players
                      .filter((p) => !assignedIds.has(p.id))
                      .map((p) => {
                        const selected = draft.benchPlayerIds.includes(p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => toggleBenchPlayer(p.id)}
                            className={`px-2.5 py-1 rounded-md text-[12px] border transition-colors ${
                              selected
                                ? 'bg-emerald-600/20 border-emerald-500 text-emerald-200'
                                : 'bg-[#0C0F14] border-white/[0.1] text-[#9AA4B4] hover:text-white'
                            }`}
                          >
                            {resolvePlayerDisplayName(p)} ({p.position}
                            {p.overallRating ? ` · ${p.overallRating}` : ''})
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
                <div className="text-[#7D8798]">Build-Up Style</div>
                <div className="text-white font-medium mt-0.5">{draft.buildUpStyle}</div>
              </div>
              <div>
                <div className="text-[#7D8798]">Defensive Approach</div>
                <div className="text-white font-medium mt-0.5">{draft.defensiveApproach}</div>
              </div>
            </div>
          </div>
        </div>
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
