import {
  AlertTriangle,
  ArrowRight,
  Lock,
  SlidersHorizontal,
  Target,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { TacticalPitchSVG } from '../components/pitch/TacticalPitchSVG';
import { useApp } from '../context/AppContext';
import { getFormationPositions } from '../data/tacticalCatalog';
import { desktopBridge } from '../services/desktopBridge';
import type {
  CatalogClub,
  CatalogFormation,
  CatalogRole,
  MatchVenue,
  PlayerRoleAssignment,
  TacticalPreset,
} from '../types/domain';
import { resolvePlayerDisplayName } from '../utils/playerDisplayName';

export function MatchPrepView() {
  const {
    activeClub,
    players,
    tacticalPresets,
    opponents,
    tacticalCatalog,
    refreshAll,
    requestNavigation,
    setSelectedMatchId,
    notify,
  } = useApp();

  const [catalogFormations, setCatalogFormations] = useState<CatalogFormation[]>([]);
  const [catalogRoles, setCatalogRoles] = useState<CatalogRole[]>([]);
  const [opponentSuggestions, setOpponentSuggestions] = useState<CatalogClub[]>([]);

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

  const defaultPreset = useMemo(
    () => tacticalPresets.find((p) => p.isDefault) ?? tacticalPresets[0] ?? null,
    [tacticalPresets]
  );

  // Fixture metadata
  const [opponentMode, setOpponentMode] = useState<'new' | 'existing'>(
    opponents.length > 0 ? 'existing' : 'new'
  );
  const [selectedOpponentId, setSelectedOpponentId] = useState<string>(opponents[0]?.id ?? '');
  const [newOpponentName, setNewOpponentName] = useState('');
  const [competition, setCompetition] = useState(activeClub?.league || 'League');
  const [venue, setVenue] = useState<MatchVenue>('home');
  const [matchDate, setMatchDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [objective, setObjective] = useState('');
  const [preMatchNotes, setPreMatchNotes] = useState('');

  // Preset selection + optional match-only override state (NEVER mutates saved club preset)
  const [selectedPresetId, setSelectedPresetId] = useState<string>(defaultPreset?.id ?? '');
  const [overrideEnabled, setOverrideEnabled] = useState(false);

  const [formation, setFormation] = useState(
    defaultPreset?.formationName ?? activeClub?.profile.primaryFormation ?? '4-3-3 Holding'
  );
  const [buildUpStyle, setBuildUpStyle] = useState(
    defaultPreset?.buildUpStyle ?? activeClub?.profile.preferredAttackingStyle ?? 'Balanced'
  );
  const [defensiveApproach, setDefensiveApproach] = useState(
    defaultPreset?.defensiveApproach ?? activeClub?.profile.preferredDefensiveStyle ?? 'Balanced'
  );
  const [defensiveLineHeight, setDefensiveLineHeight] = useState<number>(
    defaultPreset?.defensiveLineHeight ?? 55
  );
  const [assignments, setAssignments] = useState<PlayerRoleAssignment[]>([]);
  const [benchIds, setBenchIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

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

  const applyPresetToLocalState = useCallback(
    (preset: TacticalPreset | null) => {
      if (!preset) {
        const fallbackForm = activeClub?.profile.primaryFormation || '4-3-3 Holding';
        setFormation(fallbackForm);
        setBuildUpStyle(activeClub?.profile.preferredAttackingStyle || 'Balanced');
        setDefensiveApproach(activeClub?.profile.preferredDefensiveStyle || 'Balanced');
        setDefensiveLineHeight(55);
        setBenchIds([]);
        const base = getFormationPositions(fallbackForm).map((s) => ({
          slotIndex: s.slotIndex,
          positionCode: s.positionCode,
          playerId: null,
          playerName: null,
          role: s.defaultRole,
          focus: s.defaultFocus,
        }));
        setAssignments(base);
        return;
      }

      setFormation(preset.formationName);
      setBuildUpStyle(preset.buildUpStyle);
      setDefensiveApproach(preset.defensiveApproach);
      setDefensiveLineHeight(preset.defensiveLineHeight);
      setBenchIds([...preset.benchPlayerIds]);
      setAssignments(
        preset.assignments.map((a) => {
          const p = a.playerId ? playerById.get(a.playerId) : undefined;
          return {
            slotIndex: a.slotOrder,
            positionCode: a.positionCode,
            playerId: p ? p.id : a.playerId,
            playerName: p ? resolvePlayerDisplayName(p) : (a.playerDisplayName ?? null),
            role: a.role,
            focus: a.focus,
          };
        })
      );
    },
    [activeClub, playerById]
  );

  // Sync default preset whenever club or presets load
  useEffect(() => {
    if (defaultPreset) {
      if (!selectedPresetId || !tacticalPresets.some((p) => p.id === selectedPresetId)) {
        setSelectedPresetId(defaultPreset.id);
        applyPresetToLocalState(defaultPreset);
        setOverrideEnabled(false);
      } else {
        const chosen = tacticalPresets.find((p) => p.id === selectedPresetId) ?? defaultPreset;
        if (!overrideEnabled) {
          applyPresetToLocalState(chosen);
        }
      }
    } else {
      setSelectedPresetId('');
      applyPresetToLocalState(null);
    }
  }, [activeClub?.id, tacticalPresets, defaultPreset?.id]);

  // Opponent catalog autocomplete
  useEffect(() => {
    if (opponentMode !== 'new' || newOpponentName.trim().length < 2) {
      setOpponentSuggestions([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      desktopBridge
        .searchCatalogClubs({ q: newOpponentName.trim(), page: 1, pageSize: 5 })
        .then((res) => {
          if (active) setOpponentSuggestions(res.items);
        })
        .catch(() => {
          if (active) setOpponentSuggestions([]);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [opponentMode, newOpponentName]);

  const selectedPreset = useMemo(
    () => tacticalPresets.find((p) => p.id === selectedPresetId) ?? null,
    [tacticalPresets, selectedPresetId]
  );

  const selectedCatalogFormation = useMemo(
    () => catalogFormations.find((f) => f.name === formation) ?? null,
    [catalogFormations, formation]
  );

  const availabilityWarnings = useMemo(() => {
    const warnings: string[] = [];
    for (const a of assignments) {
      if (!a.playerId) continue;
      const p = playerById.get(a.playerId);
      if (
        p &&
        (p.availability !== 'available' ||
          p.squadStatus === 'loaned_out' ||
          p.squadStatus === 'transferred_out' ||
          p.squadStatus === 'released')
      ) {
        warnings.push(
          `${resolvePlayerDisplayName(p)} (${a.positionCode}: ${p.availability !== 'available' ? p.availability : p.squadStatus.replace(/_/g, ' ')})`
        );
      }
    }
    return warnings;
  }, [assignments, playerById]);

  if (!activeClub) {
    return (
      <div className="max-w-2xl border border-white/[0.08] bg-[#12151B] rounded-lg p-8">
        <h1 className="text-[20px] font-semibold text-white">Create a Career Mode Club First</h1>
        <p className="mt-2 text-[14px] text-[#9AA4B4]">
          Every match is anchored to a Career Mode club profile and freezes an immutable Match
          Tactical Snapshot.
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

  function handlePresetChange(presetId: string) {
    setSelectedPresetId(presetId);
    const chosen = tacticalPresets.find((p) => p.id === presetId) ?? null;
    applyPresetToLocalState(chosen);
    setOverrideEnabled(false);
  }

  function handleOverrideFormation(nextFormation: string) {
    setFormation(nextFormation);
    const catForm = catalogFormations.find((f) => f.name === nextFormation);
    const baseSlots =
      catForm && catForm.slots.length === 11
        ? catForm.slots.map((s) => ({
            slotIndex: s.slotOrder,
            positionCode: s.positionCode,
            defaultRole: '',
            defaultFocus: '',
          }))
        : getFormationPositions(nextFormation).map((s) => ({
            slotIndex: s.slotIndex,
            positionCode: s.positionCode,
            defaultRole: s.defaultRole,
            defaultFocus: s.defaultFocus,
          }));

    setAssignments((prev) =>
      baseSlots.map((slot) => {
        const existing = prev.find((p) => p.slotIndex === slot.slotIndex);
        const validRoles = getValidRolesForPosition(slot.positionCode);
        let role = existing?.role || slot.defaultRole;
        if (validRoles.length > 0 && !validRoles.some((r) => r.name === role)) {
          role = validRoles[0].name;
        }
        const validFocuses = getValidFocusesForRole(role, slot.positionCode);
        let focus = existing?.focus || slot.defaultFocus;
        if (validFocuses.length > 0 && !validFocuses.includes(focus)) {
          focus = validFocuses[0];
        } else if (!focus) {
          focus = 'Balanced';
        }
        return {
          slotIndex: slot.slotIndex,
          positionCode: slot.positionCode,
          playerId: existing?.playerId ?? null,
          playerName: existing?.playerName ?? null,
          role,
          focus,
        };
      })
    );
  }

  function handleOverrideSlotPlayer(slotIndex: number, playerId: string) {
    if (playerId && assignments.some((a) => a.slotIndex !== slotIndex && a.playerId === playerId)) {
      notify('error', 'Player is already assigned in another Starting XI slot.');
      return;
    }
    const p = playerId ? playerById.get(playerId) : undefined;
    setAssignments((prev) =>
      prev.map((a) =>
        a.slotIndex === slotIndex
          ? {
              ...a,
              playerId: p ? p.id : null,
              playerName: p ? resolvePlayerDisplayName(p) : null,
            }
          : a
      )
    );
  }

  async function handleCreateMatch(e: React.FormEvent) {
    e.preventDefault();
    if (!activeClub) return;

    if (opponentMode === 'new' && !newOpponentName.trim()) {
      notify('error', 'Enter an opponent club name.');
      return;
    }
    if (opponentMode === 'existing' && !selectedOpponentId) {
      notify('error', 'Select an opponent or switch to entering a new opponent.');
      return;
    }

    setSaving(true);
    try {
      const startingXiIds = assignments
        .map((a) => a.playerId)
        .filter((id): id is string => Boolean(id));

      const created = await desktopBridge.createMatch({
        clubId: activeClub.id,
        careerProfileId: activeClub.profile.id,
        opponentId: opponentMode === 'existing' ? selectedOpponentId : undefined,
        opponentName: opponentMode === 'new' ? newOpponentName.trim() : undefined,
        competition: competition.trim() || 'League',
        venue,
        matchDate,
        startingFormation: formation,
        startingXiIds,
        benchIds,
        objective,
        preMatchNotes,
        sourcePresetId: selectedPreset?.id ?? null,
        tacticalSetup: {
          formationId: selectedCatalogFormation?.id ?? null,
          buildUpStyle,
          defensiveApproach,
          defensiveLineHeight,
          playerAssignments: assignments,
        },
      });

      await refreshAll();
      setSelectedMatchId(created.id);
      notify(
        'success',
        `Match vs ${created.opponentName} prepared with frozen Pre-Match Tactical Snapshot.`
      );
      requestNavigation('match-capture');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to create match');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleCreateMatch(e)} className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Match Preparation</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Configure fixture details and select a saved Tactical Preset for {activeClub.name}.
            Confirming creates an immutable Match Tactical Snapshot that locks when recording
            starts.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[13px] font-medium transition-colors"
        >
          Confirm Match &amp; Open Capture
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left 7 cols */}
        <div className="xl:col-span-7 space-y-6">
          {/* Fixture Metadata */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
            <h2 className="text-[16px] font-semibold text-white">1. Fixture Information</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[12px] text-[#9AA4B4]">Opponent Club *</label>
                  {opponents.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setOpponentMode((m) => (m === 'existing' ? 'new' : 'existing'))
                      }
                      className="text-[11px] text-emerald-400 hover:text-emerald-300"
                    >
                      {opponentMode === 'existing' ? 'Enter New Opponent' : 'Select Saved Opponent'}
                    </button>
                  )}
                </div>
                {opponentMode === 'existing' && opponents.length > 0 ? (
                  <select
                    value={selectedOpponentId}
                    onChange={(e) => setSelectedOpponentId(e.target.value)}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                  >
                    {opponents.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} {o.typicalFormation !== 'Unknown' ? `(${o.typicalFormation})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="space-y-1.5">
                    <input
                      type="text"
                      required
                      value={newOpponentName}
                      onChange={(e) => setNewOpponentName(e.target.value)}
                      placeholder="Opponent club name"
                      className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                    />
                    {opponentSuggestions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {opponentSuggestions.map((club) => (
                          <button
                            key={club.id}
                            type="button"
                            onClick={() => {
                              setNewOpponentName(club.name);
                              if (club.leagueName && (!competition || competition === 'League')) {
                                setCompetition(club.leagueName);
                              }
                              setOpponentSuggestions([]);
                            }}
                            className="px-2 py-0.5 rounded border border-white/[0.1] bg-[#0C0F14] hover:border-emerald-500/60 text-[11px] text-[#C5CCD7] hover:text-white"
                          >
                            {club.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Competition *</label>
                <input
                  type="text"
                  required
                  value={competition}
                  onChange={(e) => setCompetition(e.target.value)}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                />
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Venue</label>
                <div className="grid grid-cols-3 gap-1 p-1 bg-[#0C0F14] border border-white/[0.1] rounded-md">
                  {(['home', 'away', 'neutral'] as MatchVenue[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVenue(v)}
                      className={`py-1.5 rounded text-[12px] font-medium capitalize transition-colors ${
                        venue === v ? 'bg-[#1D232E] text-white' : 'text-[#8A94A6] hover:text-white'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Match Date</label>
                <input
                  type="date"
                  value={matchDate}
                  onChange={(e) => setMatchDate(e.target.value)}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white font-mono tabular-nums"
                />
              </div>
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Match Objective</label>
              <input
                type="text"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="e.g. Control midfield transitions and protect the far post"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Pre-Match Notes (Optional)
              </label>
              <textarea
                rows={2}
                value={preMatchNotes}
                onChange={(e) => setPreMatchNotes(e.target.value)}
                placeholder="Key opposition threats or half-time watchpoints..."
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>
          </section>

          {/* Tactical Preset Selection & Optional Match-Only Overrides */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-emerald-400" />
                <h2 className="text-[16px] font-semibold text-white">
                  2. Club Tactical Preset &amp; Snapshot
                </h2>
              </div>
              <button
                type="button"
                onClick={() => requestNavigation('tactical-setup')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/[0.12] hover:border-emerald-500/60 text-[12px] text-emerald-300"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Edit Tactical Setup
              </button>
            </div>

            {tacticalPresets.length > 0 ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Selected Tactical Preset (Auto-selects Club Default)
                  </label>
                  <select
                    value={selectedPresetId}
                    onChange={(e) => handlePresetChange(e.target.value)}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                  >
                    {tacticalPresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.isDefault ? ' (Default)' : ''} — {p.formationName} · {p.buildUpStyle} /{' '}
                        {p.defensiveApproach}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Read-Only Summary */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-md border border-white/[0.07] bg-[#0C0F14] p-3 text-[12px]">
                  <div>
                    <div className="text-[#7D8798]">Formation</div>
                    <div className="font-mono text-white font-medium mt-0.5">{formation}</div>
                  </div>
                  <div>
                    <div className="text-[#7D8798]">Build-Up</div>
                    <div className="text-white font-medium mt-0.5">{buildUpStyle}</div>
                  </div>
                  <div>
                    <div className="text-[#7D8798]">Defense</div>
                    <div className="text-white font-medium mt-0.5">{defensiveApproach}</div>
                  </div>
                  <div>
                    <div className="text-[#7D8798]">Line Height</div>
                    <div className="font-mono text-emerald-400 font-medium mt-0.5">
                      {defensiveLineHeight} / 100
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-4 flex flex-wrap items-center justify-between gap-3 text-[13px]">
                <div className="text-amber-100">
                  No saved Tactical Presets found for {activeClub.name}. You can still prepare a
                  match using club defaults, or create a reusable preset in Tactical Setup.
                </div>
                <button
                  type="button"
                  onClick={() => requestNavigation('tactical-setup')}
                  className="px-3.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-medium whitespace-nowrap"
                >
                  Create Tactical Preset
                </button>
              </div>
            )}

            {availabilityWarnings.length > 0 && (
              <div className="rounded-md border border-amber-500/35 bg-amber-500/[0.06] p-3 text-[12px] text-amber-100 flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Unavailable Players in Lineup:</span>{' '}
                  {availabilityWarnings.join(' · ')}. Enable match-only overrides below to swap
                  replacements for this fixture without modifying your saved preset.
                </div>
              </div>
            )}

            {/* Match-Only Override Toggle */}
            <div className="pt-2 border-t border-white/[0.08] space-y-3">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-[13px] font-medium text-white">
                    Match-Only Tactical Overrides (Optional)
                  </div>
                  <div className="text-[11px] text-[#8A94A6]">
                    Adjust formation, line height, or Starting XI solely for this fixture. Saved
                    club presets are NEVER mutated.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={overrideEnabled}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setOverrideEnabled(checked);
                    if (!checked && selectedPreset) {
                      applyPresetToLocalState(selectedPreset);
                    }
                  }}
                  className="w-4 h-4 accent-emerald-500"
                />
              </label>

              {overrideEnabled && (
                <div className="space-y-4 rounded-md border border-white/[0.08] bg-[#0C0F14] p-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
                    <div>
                      <label className="block text-[#9AA4B4] mb-1">Formation Override</label>
                      <select
                        value={formation}
                        onChange={(e) => handleOverrideFormation(e.target.value)}
                        className="w-full bg-[#12151B] border border-white/[0.12] rounded px-2.5 py-1.5 text-white"
                      >
                        {formations.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[#9AA4B4] mb-1">Build-Up Override</label>
                      <select
                        value={buildUpStyle}
                        onChange={(e) => setBuildUpStyle(e.target.value)}
                        className="w-full bg-[#12151B] border border-white/[0.12] rounded px-2.5 py-1.5 text-white"
                      >
                        {buildUpOptions.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[#9AA4B4] mb-1">Defense Override</label>
                      <select
                        value={defensiveApproach}
                        onChange={(e) => setDefensiveApproach(e.target.value)}
                        className="w-full bg-[#12151B] border border-white/[0.12] rounded px-2.5 py-1.5 text-white"
                      >
                        {defensiveOptions.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-[12px] mb-1">
                      <span className="text-[#9AA4B4]">Defensive Line Height Override</span>
                      <span className="font-mono text-emerald-400">{defensiveLineHeight}</span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={95}
                      value={defensiveLineHeight}
                      onChange={(e) => setDefensiveLineHeight(Number(e.target.value))}
                      className="w-full accent-emerald-500"
                    />
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[12px]">
                      <thead>
                        <tr className="border-b border-white/[0.08] text-[#7D8798]">
                          <th className="py-1.5 pr-2">Slot</th>
                          <th className="py-1.5 pr-2">Player</th>
                          <th className="py-1.5">Role / Focus</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.06]">
                        {assignments.map((slot) => (
                          <tr key={slot.slotIndex}>
                            <td className="py-1.5 pr-2 font-mono text-white">
                              {slot.positionCode}
                            </td>
                            <td className="py-1.5 pr-2">
                              <select
                                value={slot.playerId ?? ''}
                                onChange={(e) =>
                                  handleOverrideSlotPlayer(slot.slotIndex, e.target.value)
                                }
                                className="w-full bg-[#12151B] border border-white/[0.1] rounded px-2 py-1 text-[12px] text-white"
                              >
                                <option value="">Unassigned</option>
                                {players.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {resolvePlayerDisplayName(p)} ({p.position}
                                    {p.overallRating ? ` · ${p.overallRating}` : ''})
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="py-1.5 text-[#9AA4B4]">
                              {slot.role || 'Default'}
                              {slot.focus ? ` (${slot.focus})` : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Read-only Starting XI summary when not overriding */}
            {!overrideEnabled && assignments.length > 0 && (
              <div className="pt-2 border-t border-white/[0.06]">
                <div className="text-[12px] font-medium text-[#9AA4B4] mb-2">
                  Starting XI Snapshot Preview ({assignments.filter((a) => a.playerId).length}/11
                  assigned)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[12px]">
                  {assignments.map((slot) => (
                    <div
                      key={slot.slotIndex}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded bg-[#0C0F14] border border-white/[0.06]"
                    >
                      <span className="font-mono text-[#8A94A6] w-10">{slot.positionCode}</span>
                      <span className="text-white font-medium truncate flex-1">
                        {slot.playerName || 'Unassigned'}
                      </span>
                      <span className="text-[11px] text-[#7D8798] truncate ml-2">
                        {slot.role}
                        {slot.focus ? ` · ${slot.focus}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-md border border-white/[0.07] bg-[#0C0F14] px-3.5 py-2.5 text-[11px] text-[#8A94A6] flex items-center gap-2">
              <Lock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>
                Immutable Snapshot Guarantee: Future edits to your club squad or Tactical Presets
                will never alter this match&apos;s frozen Starting XI, player display names, or
                roles.
              </span>
            </div>
          </section>
        </div>

        {/* Right 5 cols: Live Pitch Preview */}
        <div className="xl:col-span-5 xl:sticky xl:top-20 border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
          <TacticalPitchSVG
            formation={formation}
            formationSlots={selectedCatalogFormation?.slots}
            layoutVerified={selectedCatalogFormation?.layoutVerified ?? true}
            isUserAdjusted={selectedCatalogFormation?.isUserAdjusted ?? false}
            defensiveLineHeight={defensiveLineHeight}
            assignments={assignments}
            players={players}
            label={
              selectedPreset
                ? `${selectedPreset.name}${overrideEnabled ? ' (Match Override)' : ''}`
                : 'Pre-Match Tactical Snapshot Preview'
            }
            showAttackingChannels
            showDefensiveZones
            showMovementArrows
          />
          <div className="mt-4 pt-4 border-t border-white/[0.08] grid grid-cols-2 gap-3 text-[12px]">
            <div>
              <div className="text-[#7D8798]">Source Tactical Preset</div>
              <div className="text-white font-medium mt-0.5">
                {selectedPreset ? selectedPreset.name : 'Club Profile Default'}
              </div>
            </div>
            <div>
              <div className="text-[#7D8798]">Snapshot Policy</div>
              <div className="text-emerald-400 font-medium mt-0.5">
                Locks on Recording Start
              </div>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
