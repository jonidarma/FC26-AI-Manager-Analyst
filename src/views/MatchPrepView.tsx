import { ArrowRight } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { TacticalPitchSVG } from '../components/pitch/TacticalPitchSVG';
import { useApp } from '../context/AppContext';
import { getFormationPositions } from '../data/tacticalCatalog';
import { desktopBridge } from '../services/desktopBridge';
import type { MatchVenue, PlayerRoleAssignment } from '../types/domain';

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

  const formations = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'formation').map((c) => c.name),
    [tacticalCatalog]
  );
  const buildUpOptions = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'build_up').map((c) => c.name),
    [tacticalCatalog]
  );
  const defensiveOptions = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'defensive_approach').map((c) => c.name),
    [tacticalCatalog]
  );
  const roleOptions = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'player_role').map((c) => c.name),
    [tacticalCatalog]
  );
  const focusOptions = useMemo(
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

  // Sync 11 slot assignments whenever formation changes
  useEffect(() => {
    const template = getFormationPositions(formation);
    setAssignments((prev) =>
      template.map((slot) => {
        const existing = prev.find((p) => p.slotIndex === slot.slotIndex);
        return {
          slotIndex: slot.slotIndex,
          positionCode: slot.positionCode,
          playerId: existing?.playerId ?? null,
          playerName: existing?.playerName ?? null,
          role: existing?.role || slot.defaultRole,
          focus: existing?.focus || slot.defaultFocus,
        };
      })
    );
  }, [formation]);

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

  function handleSelectPlayerForSlot(slotIndex: number, playerId: string) {
    if (!playerId) {
      updateSlot(slotIndex, { playerId: null, playerName: null });
      return;
    }
    const found = players.find((p) => p.id === playerId);
    updateSlot(slotIndex, {
      playerId: found?.id ?? null,
      playerName: found?.name ?? null,
      role: found?.playerRole || assignments[slotIndex]?.role || 'Balanced',
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
            Configure fixture details, starting FC26 tactical setup, and optional lineup roles for{' '}
            {activeClub.name}.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[13px] font-medium transition-colors"
        >
          Save Match & Open Capture
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
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  >
                    {opponents.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} {o.typicalFormation !== 'Unknown' ? `(${o.typicalFormation})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    required
                    value={newOpponentName}
                    onChange={(e) => setNewOpponentName(e.target.value)}
                    placeholder="Opponent club name"
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  />
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
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-white">FC26 Tactical Setup</h2>
              <span className="text-[12px] text-[#8A94A6]">
                Options sourced from editable Tactical Catalog
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
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[14px] font-medium text-white">
                  Starting XI Roles & Focus (Player Assignment Optional)
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-white/[0.08] text-[#7D8798]">
                      <th className="py-2 pr-2 font-medium">Slot</th>
                      <th className="py-2 pr-2 font-medium">Assigned Player</th>
                      <th className="py-2 pr-2 font-medium">Player Role</th>
                      <th className="py-2 font-medium">Focus</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {assignments.map((slot) => (
                      <tr key={slot.slotIndex}>
                        <td className="py-2 pr-2 font-mono text-white">{slot.positionCode}</td>
                        <td className="py-2 pr-2">
                          <select
                            value={slot.playerId ?? ''}
                            onChange={(e) =>
                              handleSelectPlayerForSlot(slot.slotIndex, e.target.value)
                            }
                            className="w-full bg-[#0C0F14] border border-white/[0.1] rounded px-2 py-1 text-[12px] text-white"
                          >
                            <option value="">Unassigned slot</option>
                            {players.map((p) => (
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
                            onChange={(e) => updateSlot(slot.slotIndex, { role: e.target.value })}
                            className="w-full bg-[#0C0F14] border border-white/[0.1] rounded px-2 py-1 text-[12px] text-white"
                          >
                            {!roleOptions.includes(slot.role) && (
                              <option value={slot.role}>{slot.role}</option>
                            )}
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
                            {!focusOptions.includes(slot.focus) && (
                              <option value={slot.focus}>{slot.focus}</option>
                            )}
                            {focusOptions.map((f) => (
                              <option key={f} value={f}>
                                {f}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
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
        </div>
      </div>
    </form>
  );
}
