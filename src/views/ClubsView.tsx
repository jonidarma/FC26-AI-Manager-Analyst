import { Check, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { PLAYER_POSITIONS } from '../data/tacticalCatalog';
import { desktopBridge } from '../services/desktopBridge';
import type { ClubWithProfile, Player } from '../types/domain';

const EMPTY_CLUB_FORM = {
  name: '',
  league: '',
  season: '2025/26',
  managerName: '',
  preferredPhilosophy: 'Balanced Positional Play',
  primaryFormation: '4-3-3 Holding',
  alternativeFormation: '4-2-3-1 Wide',
  preferredAttackingStyle: 'Balanced',
  preferredDefensiveStyle: 'Balanced',
};

const EMPTY_PLAYER_FORM = {
  name: '',
  position: 'CM',
  overallRating: '',
  preferredFoot: 'Right' as 'Right' | 'Left' | 'Both',
  playerRole: '',
  strengths: '',
  weaknesses: '',
  preferredInstructions: '',
};

export function ClubsView() {
  const { clubs, activeClub, players, tacticalCatalog, refreshAll, notify } = useApp();
  const [clubForm, setClubForm] = useState(EMPTY_CLUB_FORM);
  const [editingClubId, setEditingClubId] = useState<string | null>(null);
  const [showClubForm, setShowClubForm] = useState<boolean>(clubs.length === 0);

  const [playerForm, setPlayerForm] = useState(EMPTY_PLAYER_FORM);
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const [showPlayerForm, setShowPlayerForm] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState(false);

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

  function startEditClub(club: ClubWithProfile) {
    setEditingClubId(club.id);
    setClubForm({
      name: club.name,
      league: club.league,
      season: club.profile.season,
      managerName: club.profile.managerName,
      preferredPhilosophy: club.profile.preferredPhilosophy,
      primaryFormation: club.profile.primaryFormation,
      alternativeFormation: club.profile.alternativeFormation,
      preferredAttackingStyle: club.profile.preferredAttackingStyle,
      preferredDefensiveStyle: club.profile.preferredDefensiveStyle,
    });
    setShowClubForm(true);
  }

  async function handleSaveClub(e: React.FormEvent) {
    e.preventDefault();
    if (!clubForm.name.trim()) {
      notify('error', 'Club name is required.');
      return;
    }
    setSubmitting(true);
    try {
      if (editingClubId) {
        await desktopBridge.updateClub(editingClubId, clubForm);
        notify('success', `Updated ${clubForm.name}.`);
      } else {
        await desktopBridge.createClub({ ...clubForm, setActive: true });
        notify('success', `Created Career Mode club ${clubForm.name}.`);
      }
      setClubForm(EMPTY_CLUB_FORM);
      setEditingClubId(null);
      setShowClubForm(false);
      await refreshAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save club');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleActivateClub(clubId: string) {
    try {
      await desktopBridge.activateClub(clubId);
      await refreshAll();
      notify('info', 'Active Career Mode club updated.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to switch club');
    }
  }

  async function handleDeleteClub(club: ClubWithProfile) {
    try {
      await desktopBridge.deleteClub(club.id);
      await refreshAll();
      notify('info', `Deleted ${club.name}.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to delete club');
    }
  }

  function startEditPlayer(player: Player) {
    setEditingPlayerId(player.id);
    setPlayerForm({
      name: player.name,
      position: player.position,
      overallRating: player.overallRating !== null ? String(player.overallRating) : '',
      preferredFoot: player.preferredFoot,
      playerRole: player.playerRole,
      strengths: player.strengths,
      weaknesses: player.weaknesses,
      preferredInstructions: player.preferredInstructions,
    });
    setShowPlayerForm(true);
  }

  async function handleSavePlayer(e: React.FormEvent) {
    e.preventDefault();
    if (!activeClub) return;
    if (!playerForm.name.trim()) {
      notify('error', 'Player name is required.');
      return;
    }

    const parsedOvr =
      playerForm.overallRating.trim() === '' ? null : Number(playerForm.overallRating);
    if (parsedOvr !== null && (Number.isNaN(parsedOvr) || parsedOvr < 1 || parsedOvr > 99)) {
      notify('error', 'Overall rating must be between 1 and 99.');
      return;
    }

    setSubmitting(true);
    try {
      if (editingPlayerId) {
        await desktopBridge.updatePlayer(editingPlayerId, {
          name: playerForm.name,
          position: playerForm.position,
          overallRating: parsedOvr,
          preferredFoot: playerForm.preferredFoot,
          playerRole: playerForm.playerRole,
          strengths: playerForm.strengths,
          weaknesses: playerForm.weaknesses,
          preferredInstructions: playerForm.preferredInstructions,
        });
        notify('success', `Updated player ${playerForm.name}.`);
      } else {
        await desktopBridge.createPlayer({
          clubId: activeClub.id,
          name: playerForm.name,
          position: playerForm.position,
          overallRating: parsedOvr,
          preferredFoot: playerForm.preferredFoot,
          playerRole: playerForm.playerRole,
          strengths: playerForm.strengths,
          weaknesses: playerForm.weaknesses,
          preferredInstructions: playerForm.preferredInstructions,
        });
        notify('success', `Added ${playerForm.name} to ${activeClub.name}.`);
      }
      setPlayerForm(EMPTY_PLAYER_FORM);
      setEditingPlayerId(null);
      setShowPlayerForm(false);
      await refreshAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save player');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeletePlayer(player: Player) {
    try {
      await desktopBridge.deletePlayer(player.id);
      await refreshAll();
      notify('info', `Removed ${player.name} from squad.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to remove player');
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Career Mode Clubs</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Manage persistent club profiles, managerial philosophy, and optional squad rosters.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditingClubId(null);
            setClubForm(EMPTY_CLUB_FORM);
            setShowClubForm((prev) => !prev);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          {showClubForm ? 'Close Club Form' : 'New Club Profile'}
        </button>
      </div>

      {/* Create / Edit Club Form */}
      {showClubForm && (
        <form
          onSubmit={(e) => void handleSaveClub(e)}
          className="border border-white/[0.1] bg-[#12151B] rounded-lg p-6 space-y-5"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-[16px] font-semibold text-white">
              {editingClubId ? 'Edit Career Mode Club Profile' : 'Create Career Mode Club Profile'}
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Club Name *</label>
              <input
                type="text"
                required
                value={clubForm.name}
                onChange={(e) => setClubForm({ ...clubForm, name: e.target.value })}
                placeholder="Enter your Career Mode club"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">League</label>
              <input
                type="text"
                value={clubForm.league}
                onChange={(e) => setClubForm({ ...clubForm, league: e.target.value })}
                placeholder="e.g. Premier League, Serie A"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Career Mode Season</label>
              <input
                type="text"
                value={clubForm.season}
                onChange={(e) => setClubForm({ ...clubForm, season: e.target.value })}
                placeholder="2025/26"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Manager Name</label>
              <input
                type="text"
                value={clubForm.managerName}
                onChange={(e) => setClubForm({ ...clubForm, managerName: e.target.value })}
                placeholder="Your manager name"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Preferred Playing Philosophy
              </label>
              <input
                type="text"
                value={clubForm.preferredPhilosophy}
                onChange={(e) =>
                  setClubForm({ ...clubForm, preferredPhilosophy: e.target.value })
                }
                placeholder="e.g. Positional Play & High Pressing"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Primary Formation</label>
              <select
                value={clubForm.primaryFormation}
                onChange={(e) => setClubForm({ ...clubForm, primaryFormation: e.target.value })}
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
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Alternative Formation
              </label>
              <select
                value={clubForm.alternativeFormation}
                onChange={(e) => setClubForm({ ...clubForm, alternativeFormation: e.target.value })}
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
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Preferred Attacking / Build-Up Style
              </label>
              <select
                value={clubForm.preferredAttackingStyle}
                onChange={(e) =>
                  setClubForm({ ...clubForm, preferredAttackingStyle: e.target.value })
                }
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
                Preferred Defensive Style
              </label>
              <select
                value={clubForm.preferredDefensiveStyle}
                onChange={(e) =>
                  setClubForm({ ...clubForm, preferredDefensiveStyle: e.target.value })
                }
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

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/[0.06]">
            <button
              type="button"
              onClick={() => {
                setShowClubForm(false);
                setEditingClubId(null);
              }}
              className="px-4 py-2 rounded-md border border-white/[0.12] text-[13px] text-[#C8CFD9] hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[13px] font-medium"
            >
              {editingClubId ? 'Save Changes' : 'Create Club Profile'}
            </button>
          </div>
        </form>
      )}

      {/* Saved Clubs Table */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
        <h2 className="text-[16px] font-semibold text-white mb-4">Saved Career Profiles</h2>
        {clubs.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-white/[0.08] text-[12px] text-[#7D8798]">
                  <th className="py-2 pr-4 font-medium">Club</th>
                  <th className="py-2 pr-4 font-medium">Season & Manager</th>
                  <th className="py-2 pr-4 font-medium">Formations</th>
                  <th className="py-2 pr-4 font-medium text-right">Squad</th>
                  <th className="py-2 pr-4 font-medium text-right">Matches</th>
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {clubs.map((club) => (
                  <tr key={club.id} className="hover:bg-white/[0.02]">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-white">
                        {club.name}
                        {club.profile.isActive && (
                          <span className="ml-2 text-[12px] text-emerald-400 font-normal">
                            Active
                          </span>
                        )}
                      </div>
                      <div className="text-[12px] text-[#8A94A6]">
                        {club.league || 'League not specified'} · {club.profile.preferredPhilosophy}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-[#C5CCD7]">
                      <div className="font-mono tabular-nums">{club.profile.season}</div>
                      <div className="text-[12px] text-[#8A94A6]">
                        {club.profile.managerName || 'Manager unspecified'}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-[#C5CCD7] font-mono tabular-nums">
                      {club.profile.primaryFormation} / {club.profile.alternativeFormation}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono tabular-nums text-[#C5CCD7]">
                      {club.playerCount}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono tabular-nums text-[#C5CCD7]">
                      {club.matchCount}
                    </td>
                    <td className="py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        {!club.profile.isActive && (
                          <button
                            type="button"
                            onClick={() => void handleActivateClub(club.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.12] hover:border-emerald-500/60 text-[12px] text-[#D7DDE7]"
                          >
                            <Check className="w-3.5 h-3.5" />
                            Set Active
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => startEditClub(club)}
                          aria-label={`Edit ${club.name}`}
                          className="p-1.5 rounded hover:bg-white/[0.06] text-[#9AA4B4] hover:text-white"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteClub(club)}
                          aria-label={`Delete ${club.name}`}
                          className="p-1.5 rounded hover:bg-red-500/10 text-[#9AA4B4] hover:text-red-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-8 text-[13px] text-[#8A94A6]">
            No Career Mode clubs created yet. Use the form above to add your club profile.
          </div>
        )}
      </section>

      {/* Active Club Optional Squad Roster */}
      {activeClub && (
        <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-[16px] font-semibold text-white">
                Squad Roster — {activeClub.name}
              </h2>
              <p className="text-[12px] text-[#8A94A6] mt-0.5">
                Full squad entry is optional. Adding key players enables named player instructions
                and verified tactical pitch labels.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setEditingPlayerId(null);
                setPlayerForm(EMPTY_PLAYER_FORM);
                setShowPlayerForm((prev) => !prev);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-white/[0.14] hover:border-emerald-500/60 text-[13px] text-white font-medium transition-colors"
            >
              <UserPlus className="w-4 h-4" />
              {showPlayerForm ? 'Close Player Form' : 'Add Player'}
            </button>
          </div>

          {showPlayerForm && (
            <form
              onSubmit={(e) => void handleSavePlayer(e)}
              className="border-t border-b border-white/[0.08] py-5 space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Player Name *</label>
                  <input
                    type="text"
                    required
                    value={playerForm.name}
                    onChange={(e) => setPlayerForm({ ...playerForm, name: e.target.value })}
                    placeholder="Player full or short name"
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Position *</label>
                  <select
                    value={playerForm.position}
                    onChange={(e) => setPlayerForm({ ...playerForm, position: e.target.value })}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  >
                    {PLAYER_POSITIONS.map((pos) => (
                      <option key={pos} value={pos}>
                        {pos}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Overall Rating (Optional)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={playerForm.overallRating}
                    onChange={(e) =>
                      setPlayerForm({ ...playerForm, overallRating: e.target.value })
                    }
                    placeholder="e.g. 82"
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white font-mono tabular-nums focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Preferred Foot</label>
                  <select
                    value={playerForm.preferredFoot}
                    onChange={(e) =>
                      setPlayerForm({
                        ...playerForm,
                        preferredFoot: e.target.value as 'Right' | 'Left' | 'Both',
                      })
                    }
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="Right">Right</option>
                    <option value="Left">Left</option>
                    <option value="Both">Both</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Preferred Role</label>
                  <select
                    value={playerForm.playerRole}
                    onChange={(e) => setPlayerForm({ ...playerForm, playerRole: e.target.value })}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">Unspecified</option>
                    {roleOptions.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Playing Strengths
                  </label>
                  <input
                    type="text"
                    value={playerForm.strengths}
                    onChange={(e) => setPlayerForm({ ...playerForm, strengths: e.target.value })}
                    placeholder="e.g. Ball progression, press resistance"
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Playing Weaknesses
                  </label>
                  <input
                    type="text"
                    value={playerForm.weaknesses}
                    onChange={(e) => setPlayerForm({ ...playerForm, weaknesses: e.target.value })}
                    placeholder="e.g. Recovery pace against counters"
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Preferred Tactical Instructions
                  </label>
                  <input
                    type="text"
                    value={playerForm.preferredInstructions}
                    onChange={(e) =>
                      setPlayerForm({ ...playerForm, preferredInstructions: e.target.value })
                    }
                    placeholder="e.g. Stay back while attacking"
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowPlayerForm(false);
                    setEditingPlayerId(null);
                  }}
                  className="px-3.5 py-1.5 rounded-md border border-white/[0.12] text-[13px] text-[#C8CFD9]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
                >
                  {editingPlayerId ? 'Update Player' : 'Save Player'}
                </button>
              </div>
            </form>
          )}

          {players.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-white/[0.08] text-[12px] text-[#7D8798]">
                    <th className="py-2 pr-3 font-medium">Player</th>
                    <th className="py-2 pr-3 font-medium">Pos</th>
                    <th className="py-2 pr-3 font-medium text-right">OVR</th>
                    <th className="py-2 pr-3 font-medium">Foot</th>
                    <th className="py-2 pr-3 font-medium">Role</th>
                    <th className="py-2 pr-3 font-medium">Strengths / Weaknesses</th>
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {players.map((p) => (
                    <tr key={p.id} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 pr-3 font-medium text-white">{p.name}</td>
                      <td className="py-2.5 pr-3 font-mono text-[#C5CCD7]">{p.position}</td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-white">
                        {p.overallRating ?? '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-[#9AA4B4]">{p.preferredFoot}</td>
                      <td className="py-2.5 pr-3 text-[#C5CCD7]">{p.playerRole || '—'}</td>
                      <td className="py-2.5 pr-3 text-[12px] text-[#9AA4B4] max-w-xs truncate">
                        {[p.strengths, p.weaknesses].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="py-2.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => startEditPlayer(p)}
                            aria-label={`Edit ${p.name}`}
                            className="p-1.5 rounded hover:bg-white/[0.06] text-[#9AA4B4] hover:text-white"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeletePlayer(p)}
                            aria-label={`Remove ${p.name}`}
                            className="p-1.5 rounded hover:bg-red-500/10 text-[#9AA4B4] hover:text-red-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-6 text-[13px] text-[#8A94A6]">
              No squad players entered yet. You can prepare and analyze matches without entering a
              full squad, or add key starters whenever ready.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
