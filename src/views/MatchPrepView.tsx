import { ArrowRight, Search } from 'lucide-react';
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
} from '../types/domain';

export function MatchPrepView() {
  const {
    activeClub,
    players,
    opponents,
    tacticalCatalog,
    refreshAll,
    setActiveSection,
    setSelectedMatchId,
    notify,
  } = useApp();

  // Verified FC26 master catalog formations & position-specific roles/focuses
  const [catalogFormations, setCatalogFormations] = useState<CatalogFormation[]>([]);
  const [catalogRoles, setCatalogRoles] = useState<CatalogRole[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // Opponent catalog autocomplete when entering a new opponent
  const [opponentSuggestions, setOpponentSuggestions] = useState<CatalogClub[]>([]);
  const [squadFilter, setSquadFilter] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([desktopBridge.listCatalogFormations(), desktopBridge.listCatalogRoles()])
      .then(([fList, rList]) => {
        if (!active) return;
        setCatalogFormations(fList);
        setCatalogRoles(rList);
        setCatalogLoaded(true);
      })
      .catch(() => {
        if (active) setCatalogLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const formations = useMemo(() => {
    if (catalogFormations.length > 0) {
      return catalogFormations.map((f) => f.name);
    }
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

  const [opponentMode, setOpponentMode] = useState<'new' | 'existing'>(
    opponents.length > 0 ? 'existing' : 'new'
  );
  const [selectedOpponentId, setSelectedOpponentId] = useState<string>(opponents[0]?.id ?? '');
  const [newOpponentName, setNewOpponentName] = useState('');
  const [competition, setCompetition] = useState(activeClub?.league || 'League');
  const [venue, setVenue] = useState<MatchVenue>('home');
  const [matchDate, setMatchDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [formation, setFormation] = useState(
    activeClub?.profile.primaryFormation || '4-3-3 Holding'
  );
  const [buildUpStyle, setBuildUpStyle] = useState(
    activeClub?.profile.preferredAttackingStyle || 'Balanced'
  );
  const [defensiveApproach, setDefensiveApproach] = useState(
    activeClub?.profile.preferredDefensiveStyle || 'Balanced'
  );
  const [defensiveLineHeight, setDefensiveLineHeight] = useState<number>(55);
  const [objective, setObjective] = useState('');
  const [preMatchNotes, setPreMatchNotes] = useState('');
  const [assignments, setAssignments] = useState<PlayerRoleAssignment[]>([]);
  const [benchIds, setBenchIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Suggest matching clubs from FC26 Master Catalog when entering a new opponent
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

  const selectedCatalogFormation = useMemo(
    () => catalogFormations.find((f) => f.name === formation) ?? null,
    [catalogFormations, formation]
  );

  const getValidRolesForPosition = useCallback(
    (positionCode: string): CatalogRole[] => {
      return catalogRoles.filter((r) => r.eligiblePositions.includes(positionCode));
    },
    [catalogRoles]
  );

  const getValidFocusesForRole = useCallback(
    (roleName: string, positionCode: string): string[] => {
      const roleObj = catalogRoles.find((r) => r.name === roleName);
      return roleObj?.compatibleFocusesByPosition[positionCode] ?? [];
    },
    [catalogRoles]
  );

  // Sync 11 slot assignments whenever formation or verified catalog data changes
  useEffect(() => {
    const slotsSource =
      selectedCatalogFormation && selectedCatalogFormation.slots.length === 11
        ? selectedCatalogFormation.slots.map((s) => ({
            slotIndex: s.slotOrder,
            positionCode: s.positionCode,
            defaultRole: '',
            defaultFocus: '',
          }))
        : getFormationPositions(formation).map((s) => ({
            slotIndex: s.slotIndex,
            positionCode: s.positionCode,
            defaultRole: s.defaultRole,
            defaultFocus: s.defaultFocus,
          }));

    setAssignments((prev) =>
      slotsSource.map((slot) => {
        const existing = prev.find((p) => p.slotIndex === slot.slotIndex);
        const validRoles = getValidRolesForPosition(slot.positionCode);

        let resolvedRole = existing?.role || slot.defaultRole;
        if (validRoles.length > 0) {
          const isRoleValid = validRoles.some((r) => r.name === resolvedRole);
          if (!isRoleValid) {
            resolvedRole = validRoles[0].name;
          }
        }

        const validFocuses = getValidFocusesForRole(resolvedRole, slot.positionCode);
        let resolvedFocus = existing?.focus || slot.defaultFocus;
        if (validFocuses.length > 0) {
          if (!validFocuses.includes(resolvedFocus)) {
            resolvedFocus = validFocuses[0];
          }
        } else if (!resolvedFocus) {
          resolvedFocus = 'Balanced';
        }

        return {
          slotIndex: slot.slotIndex,
          positionCode: slot.positionCode,
          playerId: existing?.playerId ?? null,
          playerName: existing?.playerName ?? null,
          role: resolvedRole,
          focus: resolvedFocus,
        };
      })
    );
  }, [formation, selectedCatalogFormation, getValidRolesForPosition, getValidFocusesForRole]);

  const filteredSquadPlayers = useMemo(() => {
    const q = squadFilter.trim().toLowerCase();
    if (!q) return players;
    return players.filter(
      (p) => p.name.toLowerCase().includes(q) || p.position.toLowerCase().includes(q)
    );
  }, [players, squadFilter]);

  if (!activeClub) {
    return (
      <div className="max-w-2xl border border-white/[0.08] bg-[#12151B] rounded-lg p-8">
        <h1 className="text-[20px] font-semibold text-white">Create a Career Mode Club First</h1>
        <p className="mt-2 text-[14px] text-[#9AA4B4]">
          Every match is anchored to a Career Mode club profile and stable match ID so first-half
          and second-half data never mix across careers.
        </p>
        <button
          type="button"
          onClick={() => setActiveSection('clubs')}
          className="mt-5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
        >
          Go to Career Mode Clubs
        </button>
      </div>
    );
  }

  function updateSlot(slotIndex: number, patch: Partial<PlayerRoleAssignment>) {
    setAssignments((prev) =>
      prev.map((slot) => (slot.slotIndex === slotIndex ? { ...slot, ...patch } : slot))
    );
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

  function handleSelectPlayerForSlot(slot: PlayerRoleAssignment, playerId: string) {
    if (!playerId) {
      updateSlot(slot.slotIndex, { playerId: null, playerName: null });
      return;
    }
    const found = players.find((p) => p.id === playerId);
    if (!found) return;

    // Only apply player's preferred role/focus if compatible with this exact slot position
    const validRoles = getValidRolesForPosition(slot.positionCode);
    let nextRole = slot.role;
    let nextFocus = slot.focus;

    if (found.playerRole) {
      const roleValidForSlot =
        validRoles.length === 0 || validRoles.some((r) => r.name === found.playerRole);
      if (roleValidForSlot) {
        nextRole = found.playerRole;
        const validFocuses = getValidFocusesForRole(nextRole, slot.positionCode);
        if (validFocuses.length > 0) {
          nextFocus =
            found.playerFocus && validFocuses.includes(found.playerFocus)
              ? found.playerFocus
              : validFocuses.includes(nextFocus)
                ? nextFocus
                : validFocuses[0];
        }
      }
    }

    updateSlot(slot.slotIndex, {
      playerId: found.id,
      playerName: found.name,
      role: nextRole,
      focus: nextFocus,
    });
  }

  function toggleBenchPlayer(playerId: string) {
    setBenchIds((prev) =>
      prev.includes(playerId) ? prev.filter((id) => id !== playerId) : [...prev, playerId].slice(0, 9)
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
      notify('error', 'Select an opponent or switch to creating a new opponent.');
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
        tacticalSetup: {
          buildUpStyle,
          defensiveApproach,
          defensiveLineHeight,
          playerAssignments: assignments,
        },
      });

      await refreshAll();
      setSelectedMatchId(created.id);
      notify('success', `Match vs ${created.opponentName} saved and ready for first-half capture.`);
      setActiveSection('match-capture');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to create match');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleCreateMatch(e)} className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Match Preparation</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Configure fixture details, verified FC26 formations, and position-validated FC IQ roles
            &amp; focuses for {activeClub.name}.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[13px] font-medium transition-colors"
        >
          Save Match &amp; Open Capture
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left 7 cols: Match details & Tactical Configuration */}
        <div className="xl:col-span-7 space-y-6">
          {/* Fixture Metadata */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
            <h2 className="text-[16px] font-semibold text-white">Fixture Information</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="relative">
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
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
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
                      className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
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
                            {club.teamCategory === 'womens' ? " (Women's)" : ''}
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
                  placeholder="e.g. Premier League, Champions League"
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
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
                        venue === v
                          ? 'bg-[#1D232E] text-white'
                          : 'text-[#8A94A6] hover:text-white'
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
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white font-mono tabular-nums focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Match Objective</label>
              <input
                type="text"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="e.g. Secure 3 points while limiting counterattacks down our right flank"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Pre-Match Tactical Notes (Optional)
              </label>
              <textarea
                rows={3}
                value={preMatchNotes}
                onChange={(e) => setPreMatchNotes(e.target.value)}
                placeholder="Example: My team has struggled against opponents who press aggressively."
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
          </section>

          {/* Tactical Configuration */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[16px] font-semibold text-white">FC26 Tactical Setup</h2>
              <span className="text-[12px] text-[#8A94A6]">
                {catalogFormations.length > 0
                  ? `${catalogFormations.length} verified FC26 formations · Position-locked Role & Focus compatibility`
                  : 'Loading FC26 Tactical Catalog...'}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                  Starting Formation
                </label>
                <select
                  value={formation}
                  onChange={(e) => setFormation(e.target.value)}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                >
                  {!formations.includes(formation) && (
                    <option value={formation}>{formation}</option>
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
                  value={buildUpStyle}
                  onChange={(e) => setBuildUpStyle(e.target.value)}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
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
                  value={defensiveApproach}
                  onChange={(e) => setDefensiveApproach(e.target.value)}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
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
                <label htmlFor="defensive-line-slider" className="text-[12px] text-[#9AA4B4]">
                  Defensive Line Height
                </label>
                <span className="text-[13px] font-mono tabular-nums text-emerald-400">
                  {defensiveLineHeight} / 100
                </span>
              </div>
              <input
                id="defensive-line-slider"
                type="range"
                min={10}
                max={95}
                value={defensiveLineHeight}
                onChange={(e) => setDefensiveLineHeight(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>

            {/* 11-Slot Player Role & Focus Table */}
            <div className="pt-2 border-t border-white/[0.08]">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div>
                  <h3 className="text-[14px] font-medium text-white">
                    Starting XI Roles &amp; Focus (Player Assignment Optional)
                  </h3>
                  <p className="text-[11px] text-[#7D8798]">
                    Each slot dynamically filters to verified FC 26 roles and position-specific
                    focuses.
                  </p>
                </div>
                {players.length > 0 && (
                  <div className="relative w-52">
                    <Search className="w-3.5 h-3.5 text-[#7D8798] absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={squadFilter}
                      onChange={(e) => setSquadFilter(e.target.value)}
                      placeholder="Filter squad dropdown..."
                      className="w-full bg-[#0C0F14] border border-white/[0.1] rounded px-7 py-1 text-[12px] text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-white/[0.08] text-[#7D8798]">
                      <th className="py-2 pr-2 font-medium">Slot</th>
                      <th className="py-2 pr-2 font-medium">Assigned Player</th>
                      <th className="py-2 pr-2 font-medium">FC IQ Player Role</th>
                      <th className="py-2 font-medium">Compatible Focus</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {assignments.map((slot) => {
                      const validRoles = getValidRolesForPosition(slot.positionCode);
                      const validFocuses = getValidFocusesForRole(slot.role, slot.positionCode);

                      const slotRoleNames =
                        validRoles.length > 0
                          ? validRoles.map((r) => r.name)
                          : fallbackRoleOptions;
                      const slotFocusNames =
                        validFocuses.length > 0 ? validFocuses : fallbackFocusOptions;

                      // Ensure currently assigned player always appears in select even when filtered
                      const selectPlayers =
                        slot.playerId && !filteredSquadPlayers.some((p) => p.id === slot.playerId)
                          ? [
                              ...players.filter((p) => p.id === slot.playerId),
                              ...filteredSquadPlayers,
                            ]
                          : filteredSquadPlayers;

                      return (
                        <tr key={slot.slotIndex}>
                          <td className="py-2 pr-2 font-mono text-white">{slot.positionCode}</td>
                          <td className="py-2 pr-2">
                            <select
                              value={slot.playerId ?? ''}
                              onChange={(e) => handleSelectPlayerForSlot(slot, e.target.value)}
                              className="w-full bg-[#0C0F14] border border-white/[0.1] rounded px-2 py-1 text-[12px] text-white"
                            >
                              <option value="">Unassigned slot</option>
                              {selectPlayers.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} ({p.position}
                                  {p.overallRating ? ` · ${p.overallRating}` : ''})
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 pr-2">
                            <select
                              value={slot.role}
                              onChange={(e) => handleRoleChange(slot, e.target.value)}
                              className="w-full bg-[#0C0F14] border border-white/[0.1] rounded px-2 py-1 text-[12px] text-white"
                            >
                              {!slotRoleNames.includes(slot.role) && !catalogLoaded && (
                                <option value={slot.role}>{slot.role}</option>
                              )}
                              {slotRoleNames.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2">
                            <select
                              value={slot.focus}
                              onChange={(e) =>
                                updateSlot(slot.slotIndex, { focus: e.target.value })
                              }
                              className="w-full bg-[#0C0F14] border border-white/[0.1] rounded px-2 py-1 text-[12px] text-white"
                            >
                              {!slotFocusNames.includes(slot.focus) && !catalogLoaded && (
                                <option value={slot.focus}>{slot.focus}</option>
                              )}
                              {slotFocusNames.map((f) => (
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

            {/* Optional Bench Players */}
            {players.length > 0 && (
              <div className="pt-4 border-t border-white/[0.08]">
                <div className="text-[13px] font-medium text-white mb-2">
                  Bench Options (Optional · {benchIds.length} selected)
                </div>
                <div className="flex flex-wrap gap-2">
                  {players
                    .filter((p) => !assignments.some((a) => a.playerId === p.id))
                    .map((p) => {
                      const selected = benchIds.includes(p.id);
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
                          {p.name} ({p.position})
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
            formation={formation}
            formationSlots={selectedCatalogFormation?.slots}
            layoutVerified={selectedCatalogFormation?.layoutVerified ?? true}
            isUserAdjusted={selectedCatalogFormation?.isUserAdjusted ?? false}
            defensiveLineHeight={defensiveLineHeight}
            assignments={assignments}
            players={players}
            label="Pre-Match Structural Preview"
            showAttackingChannels
            showDefensiveZones
            showMovementArrows
          />
          <div className="mt-4 pt-4 border-t border-white/[0.08] grid grid-cols-2 gap-3 text-[12px]">
            <div>
              <div className="text-[#7D8798]">Build-Up Style</div>
              <div className="text-white font-medium mt-0.5">{buildUpStyle}</div>
            </div>
            <div>
              <div className="text-[#7D8798]">Defensive Approach</div>
              <div className="text-white font-medium mt-0.5">{defensiveApproach}</div>
            </div>
          </div>
          {selectedCatalogFormation && (
            <div className="mt-3 pt-3 border-t border-white/[0.06] text-[12px] text-[#8A94A6]">
              <span className="text-[#C5CCD7] font-medium">{selectedCatalogFormation.category}</span>
              {' · '}
              <span>{selectedCatalogFormation.tacticalSummary}</span>
            </div>
          )}
        </div>
      </div>
    </form>
  );
}
