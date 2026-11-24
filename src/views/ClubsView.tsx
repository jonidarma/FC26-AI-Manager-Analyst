import {
  Check,
  Database,
  Link2,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { PLAYER_POSITIONS } from '../data/tacticalCatalog';
import { desktopBridge } from '../services/desktopBridge';
import type {
  CatalogClub,
  CatalogFormation,
  CatalogPlayer,
  CatalogRole,
  ClubWithProfile,
  Player,
} from '../types/domain';

const EMPTY_CLUB_FORM = {
  name: '',
  league: '',
  nation: '',
  catalogClubId: null as string | null,
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
  potentialRating: '',
  age: '',
  preferredFoot: 'Right' as 'Right' | 'Left' | 'Both',
  playerRole: '',
  playerFocus: '',
  contractExpiry: '',
  strengths: '',
  weaknesses: '',
  preferredInstructions: '',
};

export function ClubsView() {
  const { clubs, activeClub, players, tacticalCatalog, refreshAll, notify, setActiveSection } =
    useApp();
  const [clubForm, setClubForm] = useState(EMPTY_CLUB_FORM);
  const [editingClubId, setEditingClubId] = useState<string | null>(null);
  const [showClubForm, setShowClubForm] = useState<boolean>(clubs.length === 0);

  // Catalog reference data for formations & cascading roles/focuses
  const [catalogFormations, setCatalogFormations] = useState<CatalogFormation[]>([]);
  const [catalogRoles, setCatalogRoles] = useState<CatalogRole[]>([]);

  // Master Club Picker state
  const [clubSearchQuery, setClubSearchQuery] = useState('');
  const [clubSearchCategory, setClubSearchCategory] = useState<'' | 'mens' | 'womens'>('');
  const [clubSearchResults, setClubSearchResults] = useState<CatalogClub[]>([]);
  const [clubSearching, setClubSearching] = useState(false);

  // Squad manual add/edit form
  const [playerForm, setPlayerForm] = useState(EMPTY_PLAYER_FORM);
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const [editingPlayerCatalogId, setEditingPlayerCatalogId] = useState<string | null>(null);
  const [showPlayerForm, setShowPlayerForm] = useState<boolean>(false);

  // Import from FC26 Player Database panel
  const [showCatalogImportPanel, setShowCatalogImportPanel] = useState(false);
  const [catalogPlayerQuery, setCatalogPlayerQuery] = useState('');
  const [catalogPlayerPos, setCatalogPlayerPos] = useState('');
  const [catalogPlayerResults, setCatalogPlayerResults] = useState<CatalogPlayer[]>([]);
  const [catalogPlayerTotal, setCatalogPlayerTotal] = useState(0);
  const [catalogPlayerLoading, setCatalogPlayerLoading] = useState(false);
  const [importingCatalogPlayerId, setImportingCatalogPlayerId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([desktopBridge.listCatalogFormations(), desktopBridge.listCatalogRoles()])
      .then(([fList, rList]) => {
        if (!active) return;
        setCatalogFormations(fList);
        setCatalogRoles(rList);
      })
      .catch(() => {
        // Fallback silently to operational tacticalCatalog
      });
    return () => {
      active = false;
    };
  }, []);

  // Live search for FC26 Master Club Picker when club form is open
  useEffect(() => {
    if (!showClubForm) return;
    let active = true;
    setClubSearching(true);
    const timer = window.setTimeout(() => {
      desktopBridge
        .searchCatalogClubs({
          q: clubSearchQuery.trim() || undefined,
          teamCategory: clubSearchCategory || undefined,
          page: 1,
          pageSize: 12,
        })
        .then((res) => {
          if (!active) return;
          setClubSearchResults(res.items);
        })
        .catch(() => {
          if (active) setClubSearchResults([]);
        })
        .finally(() => {
          if (active) setClubSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [showClubForm, clubSearchQuery, clubSearchCategory]);

  // Live search for FC26 Player Database Import panel
  useEffect(() => {
    if (!showCatalogImportPanel) return;
    let active = true;
    setCatalogPlayerLoading(true);
    const timer = window.setTimeout(() => {
      desktopBridge
        .searchCatalogPlayers({
          q: catalogPlayerQuery.trim() || undefined,
          positions: catalogPlayerPos ? [catalogPlayerPos] : undefined,
          sortBy: 'overall',
          sortDir: 'desc',
          page: 1,
          pageSize: 15,
        })
        .then((res) => {
          if (!active) return;
          setCatalogPlayerResults(res.items);
          setCatalogPlayerTotal(res.total);
        })
        .catch(() => {
          if (active) {
            setCatalogPlayerResults([]);
            setCatalogPlayerTotal(0);
          }
        })
        .finally(() => {
          if (active) setCatalogPlayerLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [showCatalogImportPanel, catalogPlayerQuery, catalogPlayerPos]);

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

  const validRolesForPlayerPosition = useMemo(() => {
    if (catalogRoles.length > 0) {
      return catalogRoles.filter((r) => r.eligiblePositions.includes(playerForm.position));
    }
    return [];
  }, [catalogRoles, playerForm.position]);

  const fallbackRoleNames = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'player_role').map((c) => c.name),
    [tacticalCatalog]
  );

  const validFocusesForPlayerRole = useMemo(() => {
    if (!playerForm.playerRole || catalogRoles.length === 0) return [];
    const roleObj = catalogRoles.find((r) => r.name === playerForm.playerRole);
    return roleObj?.compatibleFocusesByPosition[playerForm.position] ?? [];
  }, [catalogRoles, playerForm.playerRole, playerForm.position]);

  function handleSelectCatalogClub(club: CatalogClub) {
    setClubForm((prev) => ({
      ...prev,
      name: club.name,
      league: club.leagueName ?? prev.league,
      nation: club.nationName ?? prev.nation,
      catalogClubId: club.id,
    }));
  }

  function startEditClub(club: ClubWithProfile) {
    setEditingClubId(club.id);
    setClubForm({
      name: club.name,
      league: club.league,
      nation: club.nation || '',
      catalogClubId: club.catalogClubId ?? null,
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
    setEditingPlayerCatalogId(player.catalogPlayerId ?? null);
    setPlayerForm({
      name: player.name,
      position: player.position,
      overallRating: player.overallRating !== null ? String(player.overallRating) : '',
      potentialRating: player.potentialRating !== null ? String(player.potentialRating) : '',
      age: player.age !== null ? String(player.age) : '',
      preferredFoot: player.preferredFoot,
      playerRole: player.playerRole,
      playerFocus: player.playerFocus || '',
      contractExpiry: player.contractExpiry ?? '',
      strengths: player.strengths,
      weaknesses: player.weaknesses,
      preferredInstructions: player.preferredInstructions,
    });
    setShowCatalogImportPanel(false);
    setShowPlayerForm(true);
  }

  function handlePlayerPositionChange(nextPos: string) {
    const allowedRoles = catalogRoles.filter((r) => r.eligiblePositions.includes(nextPos));
    const keepsRole = allowedRoles.some((r) => r.name === playerForm.playerRole);
    const nextRole = keepsRole ? playerForm.playerRole : '';
    const nextFocuses = nextRole
      ? (allowedRoles.find((r) => r.name === nextRole)?.compatibleFocusesByPosition[nextPos] ?? [])
      : [];
    const nextFocus = nextFocuses.includes(playerForm.playerFocus)
      ? playerForm.playerFocus
      : (nextFocuses[0] ?? '');
    setPlayerForm({
      ...playerForm,
      position: nextPos,
      playerRole: nextRole,
      playerFocus: nextFocus,
    });
  }

  function handlePlayerRoleChange(nextRole: string) {
    const roleObj = catalogRoles.find((r) => r.name === nextRole);
    const nextFocuses = roleObj?.compatibleFocusesByPosition[playerForm.position] ?? [];
    const nextFocus = nextFocuses.includes(playerForm.playerFocus)
      ? playerForm.playerFocus
      : (nextFocuses[0] ?? '');
    setPlayerForm({
      ...playerForm,
      playerRole: nextRole,
      playerFocus: nextFocus,
    });
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

    const parsedPot =
      playerForm.potentialRating.trim() === '' ? null : Number(playerForm.potentialRating);
    if (parsedPot !== null && (Number.isNaN(parsedPot) || parsedPot < 1 || parsedPot > 99)) {
      notify('error', 'Potential rating must be between 1 and 99.');
      return;
    }

    const parsedAge = playerForm.age.trim() === '' ? null : Number(playerForm.age);
    if (parsedAge !== null && (Number.isNaN(parsedAge) || parsedAge < 14 || parsedAge > 55)) {
      notify('error', 'Age must be between 14 and 55.');
      return;
    }

    setSubmitting(true);
    try {
      if (editingPlayerId) {
        await desktopBridge.updatePlayer(editingPlayerId, {
          name: playerForm.name,
          position: playerForm.position,
          overallRating: parsedOvr,
          potentialRating: parsedPot,
          age: parsedAge,
          preferredFoot: playerForm.preferredFoot,
          playerRole: playerForm.playerRole,
          playerFocus: playerForm.playerFocus,
          contractExpiry: playerForm.contractExpiry.trim() || null,
          strengths: playerForm.strengths,
          weaknesses: playerForm.weaknesses,
          preferredInstructions: playerForm.preferredInstructions,
        });
        notify('success', `Updated Career Mode player ${playerForm.name}.`);
      } else {
        await desktopBridge.createPlayer({
          clubId: activeClub.id,
          name: playerForm.name,
          position: playerForm.position,
          overallRating: parsedOvr,
          potentialRating: parsedPot,
          age: parsedAge,
          preferredFoot: playerForm.preferredFoot,
          playerRole: playerForm.playerRole,
          playerFocus: playerForm.playerFocus,
          contractExpiry: playerForm.contractExpiry.trim() || null,
          strengths: playerForm.strengths,
          weaknesses: playerForm.weaknesses,
          preferredInstructions: playerForm.preferredInstructions,
        });
        notify('success', `Added ${playerForm.name} to ${activeClub.name}.`);
      }
      setPlayerForm(EMPTY_PLAYER_FORM);
      setEditingPlayerId(null);
      setEditingPlayerCatalogId(null);
      setShowPlayerForm(false);
      await refreshAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save player');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleImportCatalogPlayer(cp: CatalogPlayer) {
    if (!activeClub) return;
    setImportingCatalogPlayerId(cp.id);
    try {
      await desktopBridge.importPlayerFromCatalog(activeClub.id, {
        catalogPlayerId: cp.id,
      });
      await refreshAll();
      notify(
        'success',
        `Imported ${cp.fullName} (${cp.primaryPosition}) into ${activeClub.name} Career Mode squad.`
      );
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to import player from catalog');
    } finally {
      setImportingCatalogPlayerId(null);
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

  const importedCatalogIds = useMemo(
    () => new Set(players.map((p) => p.catalogPlayerId).filter((id): id is string => Boolean(id))),
    [players]
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Career Mode Clubs</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Manage persistent club profiles linked to the FC26 Master Database, managerial
            philosophy, and editable Career Mode squad rosters.
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[16px] font-semibold text-white">
              {editingClubId ? 'Edit Career Mode Club Profile' : 'Create Career Mode Club Profile'}
            </h2>
            {clubForm.catalogClubId && (
              <div className="flex items-center gap-2 text-[12px] text-emerald-400">
                <Link2 className="w-3.5 h-3.5" />
                <span>Linked to FC26 Master Club</span>
                <button
                  type="button"
                  onClick={() => setClubForm({ ...clubForm, catalogClubId: null })}
                  className="text-[#9AA4B4] hover:text-white underline ml-1"
                >
                  Unlink
                </button>
              </div>
            )}
          </div>

          {/* FC26 Master Club Picker */}
          <div className="rounded-md border border-white/[0.08] bg-[#0C0F14] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[12px] font-medium text-[#E5E9F0]">
                  FC26 Master Club Picker (Optional Auto-Fill)
                </div>
                <div className="text-[11px] text-[#7D8798]">
                  Men&apos;s and women&apos;s clubs are maintained as separate records. Select a
                  club to auto-fill Name, League, and Nation, or enter a custom club below.
                </div>
              </div>
              <div className="flex items-center gap-1 text-[11px]">
                {(['', 'mens', 'womens'] as const).map((cat) => (
                  <button
                    key={cat || 'all'}
                    type="button"
                    onClick={() => setClubSearchCategory(cat)}
                    className={`px-2 py-1 rounded border transition-colors ${
                      clubSearchCategory === cat
                        ? 'border-emerald-500/60 bg-emerald-600/20 text-emerald-300'
                        : 'border-white/[0.1] text-[#8A94A6] hover:text-white'
                    }`}
                  >
                    {cat === '' ? 'All' : cat === 'mens' ? "Men's" : "Women's"}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#7D8798] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={clubSearchQuery}
                onChange={(e) => setClubSearchQuery(e.target.value)}
                placeholder="Search FC26 clubs by name (e.g. Arsenal, Real Madrid, Lyon)..."
                className="w-full bg-[#12151B] border border-white/[0.1] rounded-md pl-8 pr-3 py-1.5 text-[12px] text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-40 overflow-y-auto">
              {clubSearching ? (
                <div className="text-[12px] text-[#7D8798] py-2 col-span-full">
                  Searching FC26 clubs...
                </div>
              ) : clubSearchResults.length > 0 ? (
                clubSearchResults.map((c) => {
                  const selected = clubForm.catalogClubId === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => handleSelectCatalogClub(c)}
                      className={`text-left px-3 py-2 rounded border text-[12px] transition-colors ${
                        selected
                          ? 'border-emerald-500 bg-emerald-600/15 text-white'
                          : 'border-white/[0.08] bg-[#12151B] hover:border-white/[0.2] text-[#D7DDE7]'
                      }`}
                    >
                      <div className="font-medium truncate">{c.name}</div>
                      <div className="text-[11px] text-[#7D8798] truncate">
                        {c.leagueName || 'No league'} · {c.nationName || 'No nation'} ·{' '}
                        {c.teamCategory === 'womens' ? "Women's" : "Men's"}
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="text-[12px] text-[#7D8798] py-2 col-span-full">
                  No matching clubs in the local baseline catalog. You can still enter any custom
                  club manually below or import additional clubs in FC26 Database Center.
                </div>
              )}
            </div>
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
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Nation</label>
              <input
                type="text"
                value={clubForm.nation}
                onChange={(e) => setClubForm({ ...clubForm, nation: e.target.value })}
                placeholder="e.g. England, Spain"
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
                {!formations.includes(clubForm.primaryFormation) && (
                  <option value={clubForm.primaryFormation}>{clubForm.primaryFormation}</option>
                )}
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
                {!formations.includes(clubForm.alternativeFormation) && (
                  <option value={clubForm.alternativeFormation}>
                    {clubForm.alternativeFormation}
                  </option>
                )}
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
                        {[
                          club.league || 'League not specified',
                          club.nation || null,
                          club.profile.preferredPhilosophy,
                          club.catalogClubId ? 'FC26 Linked' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
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
                Import real players from your FC26 Player Database or enter players manually. Career
                Mode edits (OVR, POT, contract, role) never alter the master reference catalog.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowPlayerForm(false);
                  setShowCatalogImportPanel((prev) => !prev);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-emerald-500/40 bg-emerald-600/10 hover:bg-emerald-600/20 text-[13px] text-emerald-300 font-medium transition-colors"
              >
                <Database className="w-4 h-4" />
                {showCatalogImportPanel ? 'Close Catalog Import' : 'Import from FC26 Database'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingPlayerId(null);
                  setEditingPlayerCatalogId(null);
                  setPlayerForm(EMPTY_PLAYER_FORM);
                  setShowCatalogImportPanel(false);
                  setShowPlayerForm((prev) => !prev);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-white/[0.14] hover:border-emerald-500/60 text-[13px] text-white font-medium transition-colors"
              >
                <UserPlus className="w-4 h-4" />
                {showPlayerForm ? 'Close Player Form' : 'Add Player Manually'}
              </button>
            </div>
          </div>

          {/* Import from FC26 Master Player Database Panel */}
          {showCatalogImportPanel && (
            <div className="border border-white/[0.1] bg-[#0C0F14] rounded-lg p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-[14px] font-semibold text-white">
                    Import Players from FC26 Reference Catalog
                  </h3>
                  <p className="text-[12px] text-[#8A94A6]">
                    Copies baseline ratings and positions into {activeClub.name}. You can override
                    Career Mode growth, contract expiry, and preferred FC IQ role afterward.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCatalogImportPanel(false)}
                  aria-label="Close catalog import panel"
                  className="p-1 text-[#8A94A6] hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="md:col-span-3 relative">
                  <Search className="w-3.5 h-3.5 text-[#7D8798] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={catalogPlayerQuery}
                    onChange={(e) => setCatalogPlayerQuery(e.target.value)}
                    placeholder="Search imported FC26 players by name..."
                    className="w-full bg-[#12151B] border border-white/[0.1] rounded-md pl-8 pr-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <select
                  value={catalogPlayerPos}
                  onChange={(e) => setCatalogPlayerPos(e.target.value)}
                  className="bg-[#12151B] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                >
                  <option value="">All Positions</option>
                  {PLAYER_POSITIONS.map((pos) => (
                    <option key={pos} value={pos}>
                      {pos}
                    </option>
                  ))}
                </select>
              </div>

              {catalogPlayerLoading ? (
                <div className="text-[13px] text-[#8A94A6] py-4">Searching player database...</div>
              ) : catalogPlayerTotal === 0 && !catalogPlayerQuery && !catalogPlayerPos ? (
                <div className="rounded-md border border-white/[0.08] bg-[#12151B] p-4 flex flex-wrap items-center justify-between gap-4">
                  <div className="text-[13px] text-[#9AA4B4]">
                    Your FC26 Master Player Catalog currently has{' '}
                    <span className="font-mono text-white">0</span> records (no players are
                    pre-fabricated). Import a verified FUTWIZ FC26 CSV/JSON dataset in the Database
                    Center to enable one-click squad imports.
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveSection('database-center')}
                    className="px-3.5 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-medium whitespace-nowrap"
                  >
                    Open FC26 Database Center
                  </button>
                </div>
              ) : catalogPlayerResults.length === 0 ? (
                <div className="text-[13px] text-[#8A94A6] py-4">
                  No catalog players matched your filter.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-72 overflow-y-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-[#7D8798]">
                        <th className="py-2 pr-3 font-medium">Player</th>
                        <th className="py-2 pr-3 font-medium">Pos</th>
                        <th className="py-2 pr-3 font-medium">Catalog Club</th>
                        <th className="py-2 pr-3 font-medium text-right">OVR</th>
                        <th className="py-2 pr-3 font-medium text-right">POT</th>
                        <th className="py-2 pr-3 font-medium text-right">Age</th>
                        <th className="py-2 font-medium text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {catalogPlayerResults.map((cp) => {
                        const alreadyInSquad = importedCatalogIds.has(cp.id);
                        return (
                          <tr key={cp.id} className="hover:bg-white/[0.02]">
                            <td className="py-2 pr-3 font-medium text-white">{cp.fullName}</td>
                            <td className="py-2 pr-3 font-mono text-[#C5CCD7]">
                              {cp.primaryPosition}
                            </td>
                            <td className="py-2 pr-3 text-[#8A94A6]">{cp.clubName ?? '—'}</td>
                            <td className="py-2 pr-3 text-right font-mono tabular-nums text-white">
                              {cp.overallRating ?? '—'}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono tabular-nums text-emerald-400">
                              {cp.potentialRating ?? '—'}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono tabular-nums text-[#C5CCD7]">
                              {cp.age ?? '—'}
                            </td>
                            <td className="py-2 text-right">
                              {alreadyInSquad ? (
                                <span className="text-[11px] text-emerald-400">In Squad</span>
                              ) : (
                                <button
                                  type="button"
                                  disabled={importingCatalogPlayerId === cp.id}
                                  onClick={() => void handleImportCatalogPlayer(cp)}
                                  className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[11px] font-medium"
                                >
                                  {importingCatalogPlayerId === cp.id ? 'Importing...' : 'Import'}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {showPlayerForm && (
            <form
              onSubmit={(e) => void handleSavePlayer(e)}
              className="border-t border-b border-white/[0.08] py-5 space-y-4"
            >
              {editingPlayerCatalogId && (
                <div className="text-[12px] text-emerald-400">
                  Career Mode Override Mode · Changes apply only to {activeClub.name}; the master
                  FC26 reference player stays unchanged.
                </div>
              )}

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
                    onChange={(e) => handlePlayerPositionChange(e.target.value)}
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
                    Overall Rating (OVR)
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
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Potential Rating (POT)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={playerForm.potentialRating}
                    onChange={(e) =>
                      setPlayerForm({ ...playerForm, potentialRating: e.target.value })
                    }
                    placeholder="e.g. 88"
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white font-mono tabular-nums focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Age</label>
                  <input
                    type="number"
                    min={14}
                    max={55}
                    value={playerForm.age}
                    onChange={(e) => setPlayerForm({ ...playerForm, age: e.target.value })}
                    placeholder="e.g. 22"
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white font-mono tabular-nums focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Contract Expiry</label>
                  <input
                    type="text"
                    value={playerForm.contractExpiry}
                    onChange={(e) =>
                      setPlayerForm({ ...playerForm, contractExpiry: e.target.value })
                    }
                    placeholder="e.g. 2029"
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
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Preferred FC IQ Role ({playerForm.position})
                  </label>
                  <select
                    value={playerForm.playerRole}
                    onChange={(e) => handlePlayerRoleChange(e.target.value)}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">Unspecified</option>
                    {validRolesForPlayerPosition.length > 0
                      ? validRolesForPlayerPosition.map((r) => (
                          <option key={r.id} value={r.name}>
                            {r.name}
                            {r.isFc26New ? ' (FC 26 New)' : ''}
                          </option>
                        ))
                      : fallbackRoleNames.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Compatible Focus
                  </label>
                  <select
                    value={playerForm.playerFocus}
                    onChange={(e) => setPlayerForm({ ...playerForm, playerFocus: e.target.value })}
                    disabled={!playerForm.playerRole || validFocusesForPlayerRole.length === 0}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white disabled:opacity-50 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">
                      {playerForm.playerRole ? 'Select focus' : 'Choose a role first'}
                    </option>
                    {validFocusesForPlayerRole.map((f) => (
                      <option key={f} value={f}>
                        {f}
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
                    setEditingPlayerCatalogId(null);
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
                    <th className="py-2 pr-3 font-medium text-right">POT</th>
                    <th className="py-2 pr-3 font-medium text-right">Age</th>
                    <th className="py-2 pr-3 font-medium">Role & Focus</th>
                    <th className="py-2 pr-3 font-medium">Contract</th>
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {players.map((p) => (
                    <tr key={p.id} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-white">{p.name}</div>
                        <div className="text-[11px] text-[#7D8798]">
                          {[
                            p.preferredFoot,
                            p.catalogPlayerId ? 'FC26 Catalog Link' : 'Custom Entry',
                            p.strengths || null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[#C5CCD7]">{p.position}</td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-white">
                        {p.overallRating ?? '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-emerald-400">
                        {p.potentialRating ?? '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-[#C5CCD7]">
                        {p.age ?? '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-[#C5CCD7]">
                        {p.playerRole
                          ? p.playerFocus
                            ? `${p.playerRole} · ${p.playerFocus}`
                            : p.playerRole
                          : '—'}
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums text-[12px] text-[#9AA4B4]">
                        {p.contractExpiry || '—'}
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
              full squad, add key starters manually, or import players from the FC26 Database.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
