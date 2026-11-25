import {
  ArrowRight,
  Check,
  Link2,
  Pencil,
  Plus,
  Search,
  Target,
  Trash2,
  Users,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { SortableTh } from '../components/common/SortableTh';
import { useApp } from '../context/AppContext';
import { useTableSort } from '../hooks/useTableSort';
import { desktopBridge } from '../services/desktopBridge';
import type {
  CatalogClub,
  CatalogFormation,
  ClubCoachRecord,
  ClubWithProfile,
  DefaultRosterPreview,
  TacticalFlexibility,
  TacticalVisionRecord,
} from '../types/domain';
import { hasDistinctFullName } from '../utils/playerDisplayName';

type SavedClubSortKey = 'club' | 'seasonManager' | 'formations' | 'squad' | 'matches';

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
  primaryTacticalVisionKey: 'standard',
  alternativeTacticalVisionKey: '' as string,
  preferredBuildUpStyle: 'Balanced',
  preferredDefensiveApproach: 'Balanced',
  preferredDefensiveLineHeight: 55,
  tacticalPhilosophyNotes: '',
  tacticalFlexibility: 'balanced' as TacticalFlexibility,
  rosterInitMode: 'default_roster' as 'default_roster' | 'empty',
};

const EMPTY_COACH_FORM = {
  name: '',
  department: 'midfield' as ClubCoachRecord['department'],
  tacticalVisionKey: 'standard',
  qualificationLevel: 'silver' as ClubCoachRecord['qualificationLevel'],
  starRating: 4,
  notes: '',
};

export function ClubsView() {
  const {
    clubs,
    activeClub,
    players,
    tacticalPresets,
    tacticalCatalog,
    refreshAll,
    notify,
    requestNavigation,
    guardedActivateClub,
  } = useApp();

  const [clubForm, setClubForm] = useState(EMPTY_CLUB_FORM);
  const [editingClubId, setEditingClubId] = useState<string | null>(null);
  const [showClubForm, setShowClubForm] = useState<boolean>(clubs.length === 0);

  const [catalogFormations, setCatalogFormations] = useState<CatalogFormation[]>([]);
  const [tacticalVisions, setTacticalVisions] = useState<TacticalVisionRecord[]>([]);
  const [clubCoaches, setClubCoaches] = useState<ClubCoachRecord[]>([]);
  const [coachForm, setCoachForm] = useState(EMPTY_COACH_FORM);
  const [savingCoach, setSavingCoach] = useState(false);

  // Master Club Picker state
  const [clubSearchQuery, setClubSearchQuery] = useState('');
  const [clubSearchCategory, setClubSearchCategory] = useState<'' | 'mens' | 'womens'>('');
  const [clubSearchResults, setClubSearchResults] = useState<CatalogClub[]>([]);
  const [clubSearching, setClubSearching] = useState(false);

  // Automatic Default Roster Preview (for newly selected catalog club)
  const [rosterPreview, setRosterPreview] = useState<DefaultRosterPreview | null>(null);
  const [rosterPreviewLoading, setRosterPreviewLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      desktopBridge.listCatalogFormations(),
      desktopBridge.getTacticalVisionCatalog().catch(() => null),
    ])
      .then(([fList, vCat]) => {
        if (!active) return;
        setCatalogFormations(fList);
        if (vCat) setTacticalVisions(vCat.visions);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!activeClub) {
      setClubCoaches([]);
      return;
    }
    let active = true;
    desktopBridge
      .listClubCoaches(activeClub.id)
      .then((list) => {
        if (active) setClubCoaches(list);
      })
      .catch(() => {
        if (active) setClubCoaches([]);
      });
    return () => {
      active = false;
    };
  }, [activeClub?.id]);

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
          if (active) setClubSearchResults(res.items);
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

  // Fetch default roster preview whenever a catalog club is linked during club creation
  useEffect(() => {
    if (!showClubForm || editingClubId || !clubForm.catalogClubId) {
      setRosterPreview(null);
      return;
    }
    let active = true;
    setRosterPreviewLoading(true);
    desktopBridge
      .previewDefaultRosterByCatalogClub(clubForm.catalogClubId)
      .then((preview) => {
        if (active) setRosterPreview(preview);
      })
      .catch(() => {
        if (active) setRosterPreview(null);
      })
      .finally(() => {
        if (active) setRosterPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [showClubForm, editingClubId, clubForm.catalogClubId]);

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

  function handleSelectCatalogClub(club: CatalogClub) {
    setClubForm((prev) => ({
      ...prev,
      name: club.name,
      league: club.leagueName ?? prev.league,
      nation: club.nationName ?? prev.nation,
      catalogClubId: club.id,
      rosterInitMode: 'default_roster',
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
      primaryTacticalVisionKey: club.profile.primaryTacticalVisionKey || 'standard',
      alternativeTacticalVisionKey: club.profile.alternativeTacticalVisionKey || '',
      preferredBuildUpStyle:
        club.profile.preferredBuildUpStyle || club.profile.preferredAttackingStyle || 'Balanced',
      preferredDefensiveApproach:
        club.profile.preferredDefensiveApproach || club.profile.preferredDefensiveStyle || 'Balanced',
      preferredDefensiveLineHeight: club.profile.preferredDefensiveLineHeight ?? 55,
      tacticalPhilosophyNotes: club.profile.tacticalPhilosophyNotes || '',
      tacticalFlexibility: club.profile.tacticalFlexibility || 'balanced',
      rosterInitMode: 'empty',
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
      const payload = {
        ...clubForm,
        alternativeTacticalVisionKey: clubForm.alternativeTacticalVisionKey || null,
        preferredAttackingStyle: clubForm.preferredBuildUpStyle || clubForm.preferredAttackingStyle,
        preferredDefensiveStyle:
          clubForm.preferredDefensiveApproach || clubForm.preferredDefensiveStyle,
      };
      if (editingClubId) {
        await desktopBridge.updateClub(editingClubId, payload);
        notify('success', `Updated ${clubForm.name}.`);
      } else {
        const created = await desktopBridge.createClub({
          ...payload,
          setActive: true,
        });
        const imported = created.defaultRosterImport?.importedCount ?? 0;
        if (imported > 0) {
          notify(
            'success',
            `Created ${clubForm.name} and imported ${imported} default FC26 squad player(s).`
          );
        } else {
          notify('success', `Created Career Mode club ${clubForm.name}.`);
        }
      }
      setClubForm(EMPTY_CLUB_FORM);
      setEditingClubId(null);
      setRosterPreview(null);
      setShowClubForm(false);
      await refreshAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save club');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddCoach(e: React.FormEvent) {
    e.preventDefault();
    if (!activeClub) return;
    if (!coachForm.name.trim()) {
      notify('error', 'Coach name is required.');
      return;
    }
    setSavingCoach(true);
    try {
      await desktopBridge.saveClubCoach(activeClub.id, coachForm);
      const updated = await desktopBridge.listClubCoaches(activeClub.id);
      setClubCoaches(updated);
      setCoachForm(EMPTY_COACH_FORM);
      notify('success', `Saved coach "${coachForm.name}" for ${activeClub.name}.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save club coach');
    } finally {
      setSavingCoach(false);
    }
  }

  async function handleDeleteCoach(coach: ClubCoachRecord) {
    if (!activeClub) return;
    try {
      await desktopBridge.deleteClubCoach(coach.id);
      setClubCoaches((prev) => prev.filter((c) => c.id !== coach.id));
      notify('info', `Removed coach "${coach.name}".`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to delete coach');
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

  const savedClubAccessors = useMemo<
    Record<SavedClubSortKey, (club: ClubWithProfile) => string | number | null>
  >(
    () => ({
      club: (c) => c.name,
      seasonManager: (c) => `${c.profile.season} ${c.profile.managerName || ''}`.trim(),
      formations: (c) => c.profile.primaryFormation,
      squad: (c) => c.playerCount,
      matches: (c) => c.matchCount,
    }),
    []
  );

  const {
    sortedRows: sortedClubs,
    sortKey: clubsSortKey,
    sortDir: clubsSortDir,
    toggleSort: toggleClubsSort,
  } = useTableSort(clubs, savedClubAccessors);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Career Mode Clubs</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Create and manage Career Mode club profiles linked to the FC26 Master Database with
            automatic default roster initialization.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditingClubId(null);
            setClubForm(EMPTY_CLUB_FORM);
            setRosterPreview(null);
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
                  onClick={() => {
                    setClubForm({ ...clubForm, catalogClubId: null });
                    setRosterPreview(null);
                  }}
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
                  FC26 Master Club Picker (Stable Catalog Club ID Linking)
                </div>
                <div className="text-[11px] text-[#7D8798]">
                  Select a club from the FC26 catalog to link its stable club ID and preview
                  automatic default squad initialization, or enter a custom club below.
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
                placeholder="Search all FC26 clubs by name or alias (e.g. Everton, Arsenal, Lombardia FC, Real Madrid)..."
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
                  No matching clubs in the local catalog. You can still enter a custom club below.
                </div>
              )}
            </div>
          </div>

          {/* Automatic Default Roster Initialization Panel (Create mode only) */}
          {!editingClubId && clubForm.catalogClubId && (
            <div className="rounded-md border border-emerald-500/30 bg-[#0D1412] p-4 space-y-3 text-[12px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-white">
                  Default Career Squad Initialization (Imported FC26 Dataset Snapshot)
                </div>
                {rosterPreviewLoading && (
                  <span className="text-[#8A94A6]">Checking FC26 catalog players...</span>
                )}
              </div>

              {rosterPreview && (
                <>
                  <p
                    className={
                      rosterPreview.status === 'linked_with_players'
                        ? 'text-emerald-200'
                        : 'text-amber-200'
                    }
                  >
                    {rosterPreview.message}
                  </p>

                  {rosterPreview.status === 'linked_with_players' && (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                        <label
                          className={`flex items-start gap-2.5 p-3 rounded border cursor-pointer ${
                            clubForm.rosterInitMode === 'default_roster'
                              ? 'border-emerald-500 bg-emerald-500/10 text-white'
                              : 'border-white/[0.1] bg-[#12151B] text-[#B8C0CE]'
                          }`}
                        >
                          <input
                            type="radio"
                            name="rosterInitMode"
                            checked={clubForm.rosterInitMode === 'default_roster'}
                            onChange={() =>
                              setClubForm({ ...clubForm, rosterInitMode: 'default_roster' })
                            }
                            className="mt-0.5 accent-emerald-500"
                          />
                          <div>
                            <div className="font-medium">
                              Import Default Club Roster (Recommended ·{' '}
                              {rosterPreview.totalMatchedPlayers} players)
                            </div>
                            <div className="text-[11px] text-[#8A94A6] mt-0.5">
                              Copies real FC26 players linked to this club ID into your independent
                              Career Mode squad.
                            </div>
                          </div>
                        </label>

                        <label
                          className={`flex items-start gap-2.5 p-3 rounded border cursor-pointer ${
                            clubForm.rosterInitMode === 'empty'
                              ? 'border-emerald-500 bg-emerald-500/10 text-white'
                              : 'border-white/[0.1] bg-[#12151B] text-[#B8C0CE]'
                          }`}
                        >
                          <input
                            type="radio"
                            name="rosterInitMode"
                            checked={clubForm.rosterInitMode === 'empty'}
                            onChange={() => setClubForm({ ...clubForm, rosterInitMode: 'empty' })}
                            className="mt-0.5 accent-emerald-500"
                          />
                          <div>
                            <div className="font-medium">Start with Empty Squad</div>
                            <div className="text-[11px] text-[#8A94A6] mt-0.5">
                              Build your squad manually or import the default roster later from
                              Squad Management.
                            </div>
                          </div>
                        </label>
                      </div>

                      {rosterPreview.samplePlayers.length > 0 &&
                        clubForm.rosterInitMode === 'default_roster' && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {rosterPreview.samplePlayers.slice(0, 8).map((sp) => (
                              <span
                                key={sp.id}
                                title={
                                  hasDistinctFullName(sp.displayName, sp.fullName)
                                    ? sp.fullName
                                    : undefined
                                }
                                className="px-2 py-0.5 rounded bg-[#12151B] border border-white/[0.08] text-[11px] text-[#D7DDE7] font-mono"
                              >
                                {sp.displayName} ({sp.primaryPosition} · {sp.overallRating ?? '—'})
                              </span>
                            ))}
                            {rosterPreview.totalMatchedPlayers > 8 && (
                              <span className="px-2 py-0.5 text-[11px] text-[#8A94A6]">
                                +{rosterPreview.totalMatchedPlayers - 8} more
                              </span>
                            )}
                          </div>
                        )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

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
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
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
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
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
                Preferred Build-Up Style
              </label>
              <select
                value={clubForm.preferredBuildUpStyle}
                onChange={(e) =>
                  setClubForm({
                    ...clubForm,
                    preferredBuildUpStyle: e.target.value,
                    preferredAttackingStyle: e.target.value,
                  })
                }
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
                Preferred Defensive Approach
              </label>
              <select
                value={clubForm.preferredDefensiveApproach}
                onChange={(e) =>
                  setClubForm({
                    ...clubForm,
                    preferredDefensiveApproach: e.target.value,
                    preferredDefensiveStyle: e.target.value,
                  })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              >
                {defensiveOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Primary Tactical Vision (FC 26)
              </label>
              <select
                value={clubForm.primaryTacticalVisionKey}
                onChange={(e) =>
                  setClubForm({ ...clubForm, primaryTacticalVisionKey: e.target.value })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              >
                <option value="unspecified">Unspecified</option>
                {tacticalVisions.map((v) => (
                  <option key={v.internalKey} value={v.internalKey}>
                    {v.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Alternative Tactical Vision
              </label>
              <select
                value={clubForm.alternativeTacticalVisionKey}
                onChange={(e) =>
                  setClubForm({ ...clubForm, alternativeTacticalVisionKey: e.target.value })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              >
                <option value="">None</option>
                {tacticalVisions.map((v) => (
                  <option key={v.internalKey} value={v.internalKey}>
                    {v.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Tactical Flexibility
              </label>
              <select
                value={clubForm.tacticalFlexibility}
                onChange={(e) =>
                  setClubForm({
                    ...clubForm,
                    tacticalFlexibility: e.target.value as TacticalFlexibility,
                  })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              >
                <option value="strict">Strict (Adhere closely to primary vision)</option>
                <option value="balanced">Balanced (Adapt when match evidence demands)</option>
                <option value="pragmatic">Pragmatic (Flexible in-match shifts)</option>
              </select>
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Preferred Defensive Line Height ({clubForm.preferredDefensiveLineHeight})
              </label>
              <input
                type="range"
                min={10}
                max={95}
                value={clubForm.preferredDefensiveLineHeight}
                onChange={(e) =>
                  setClubForm({
                    ...clubForm,
                    preferredDefensiveLineHeight: Number(e.target.value),
                  })
                }
                className="w-full accent-emerald-500 mt-2"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Club Tactical Philosophy Notes
              </label>
              <textarea
                rows={2}
                value={clubForm.tacticalPhilosophyNotes}
                onChange={(e) =>
                  setClubForm({ ...clubForm, tacticalPhilosophyNotes: e.target.value })
                }
                placeholder="Describe non-negotiables, pressing triggers, or Career Mode recruitment identity..."
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/[0.06]">
            <button
              type="button"
              onClick={() => {
                setShowClubForm(false);
                setEditingClubId(null);
                setRosterPreview(null);
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
                  <SortableTh
                    label="Club"
                    columnKey="club"
                    activeKey={clubsSortKey}
                    direction={clubsSortDir}
                    onSort={toggleClubsSort}
                    className="py-2 pr-4 font-medium"
                  />
                  <SortableTh
                    label="Season & Manager"
                    columnKey="seasonManager"
                    activeKey={clubsSortKey}
                    direction={clubsSortDir}
                    onSort={toggleClubsSort}
                    className="py-2 pr-4 font-medium"
                  />
                  <SortableTh
                    label="Formations"
                    columnKey="formations"
                    activeKey={clubsSortKey}
                    direction={clubsSortDir}
                    onSort={toggleClubsSort}
                    className="py-2 pr-4 font-medium"
                  />
                  <SortableTh
                    label="Squad"
                    columnKey="squad"
                    activeKey={clubsSortKey}
                    direction={clubsSortDir}
                    onSort={toggleClubsSort}
                    defaultDir="desc"
                    align="right"
                    className="py-2 pr-4 font-medium"
                  />
                  <SortableTh
                    label="Matches"
                    columnKey="matches"
                    activeKey={clubsSortKey}
                    direction={clubsSortDir}
                    onSort={toggleClubsSort}
                    defaultDir="desc"
                    align="right"
                    className="py-2 pr-4 font-medium"
                  />
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {sortedClubs.map((club) => (
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
                          tacticalVisions.find(
                            (v) => v.internalKey === club.profile.primaryTacticalVisionKey
                          )?.displayName || club.profile.preferredPhilosophy,
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
                            onClick={() => guardedActivateClub(club.id)}
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

      {/* Active Club Operational Hub Links (Clean Separation of Squad & Tactical Setup) */}
      {activeClub && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold text-white">
                <Users className="w-4 h-4 text-emerald-400" />
                Squad Management — {activeClub.name}
              </div>
              <p className="mt-1 text-[13px] text-[#9AA4B4]">
                Currently <span className="font-mono text-white">{players.length}</span> career
                squad player(s). Manage transfers, loans, injuries, suspensions, default roster
                imports, and custom display names.
              </p>
            </div>
            <button
              type="button"
              onClick={() => requestNavigation('squad-management')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-emerald-500/40 bg-emerald-600/12 hover:bg-emerald-600/20 text-[13px] text-emerald-300 font-medium whitespace-nowrap shrink-0"
            >
              Open Squad
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold text-white">
                <Target className="w-4 h-4 text-emerald-400" />
                Tactical Setup — {activeClub.name}
              </div>
              <p className="mt-1 text-[13px] text-[#9AA4B4]">
                Currently <span className="font-mono text-white">{tacticalPresets.length}</span>{' '}
                saved tactical preset(s). Configure formations, Starting XI, FC IQ roles &amp;
                focuses, and your default matchday setup.
              </p>
            </div>
            <button
              type="button"
              onClick={() => requestNavigation('tactical-setup')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-emerald-500/40 bg-emerald-600/12 hover:bg-emerald-600/20 text-[13px] text-emerald-300 font-medium whitespace-nowrap shrink-0"
            >
              Open Tactics
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </section>
      )}

      {/* Phase 3 — Club Coaching Staff (Tactical Vision & Potential Role+ Familiarity) */}
      {activeClub && (
        <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
          <div>
            <h2 className="text-[16px] font-semibold text-white">
              Coaching Staff — {activeClub.name}
            </h2>
            <p className="text-[12px] text-[#8A94A6] mt-0.5">
              Track your Career Mode coaches by department and Tactical Vision. Silver/Gold coaches
              matching your active Tactical Vision indicate potential Role+ familiarity for matching
              department roles (always distinguished from confirmed in-game familiarity).
            </p>
          </div>

          <form
            onSubmit={(e) => void handleAddCoach(e)}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end bg-[#0C0F14] border border-white/[0.08] rounded-md p-3.5"
          >
            <div className="lg:col-span-2">
              <label className="block text-[11px] text-[#8A94A6] mb-1">Coach Name *</label>
              <input
                type="text"
                value={coachForm.name}
                onChange={(e) => setCoachForm({ ...coachForm, name: e.target.value })}
                placeholder="e.g. Marco Rossi"
                className="w-full bg-[#12151B] border border-white/[0.12] rounded px-2.5 py-1.5 text-[12px] text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] text-[#8A94A6] mb-1">Department</label>
              <select
                value={coachForm.department}
                onChange={(e) =>
                  setCoachForm({
                    ...coachForm,
                    department: e.target.value as ClubCoachRecord['department'],
                  })
                }
                className="w-full bg-[#12151B] border border-white/[0.12] rounded px-2.5 py-1.5 text-[12px] text-white"
              >
                <option value="head_coach">Head Coach</option>
                <option value="goalkeeping">Goalkeeping</option>
                <option value="defense">Defense</option>
                <option value="midfield">Midfield</option>
                <option value="attack">Attack</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-[#8A94A6] mb-1">Tactical Vision</label>
              <select
                value={coachForm.tacticalVisionKey}
                onChange={(e) =>
                  setCoachForm({ ...coachForm, tacticalVisionKey: e.target.value })
                }
                className="w-full bg-[#12151B] border border-white/[0.12] rounded px-2.5 py-1.5 text-[12px] text-white"
              >
                {tacticalVisions.map((v) => (
                  <option key={v.internalKey} value={v.internalKey}>
                    {v.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-[#8A94A6] mb-1">Qualification / Stars</label>
              <div className="flex gap-1.5">
                <select
                  value={coachForm.qualificationLevel}
                  onChange={(e) =>
                    setCoachForm({
                      ...coachForm,
                      qualificationLevel: e.target.value as ClubCoachRecord['qualificationLevel'],
                    })
                  }
                  className="flex-1 bg-[#12151B] border border-white/[0.12] rounded px-2 py-1.5 text-[12px] text-white"
                >
                  <option value="standard">Standard</option>
                  <option value="bronze">Bronze</option>
                  <option value="silver">Silver</option>
                  <option value="gold">Gold</option>
                </select>
                <select
                  value={coachForm.starRating}
                  onChange={(e) =>
                    setCoachForm({ ...coachForm, starRating: Number(e.target.value) })
                  }
                  className="w-16 bg-[#12151B] border border-white/[0.12] rounded px-2 py-1.5 text-[12px] text-white"
                >
                  {[1, 2, 3, 4, 5].map((s) => (
                    <option key={s} value={s}>
                      {s}★
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              type="submit"
              disabled={savingCoach}
              className="px-3.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[12px] font-medium"
            >
              {savingCoach ? 'Saving...' : 'Add Coach'}
            </button>
          </form>

          {clubCoaches.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="border-b border-white/[0.08] text-[#7D8798]">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Coach</th>
                    <th className="py-2 pr-3 font-medium">Department</th>
                    <th className="py-2 pr-3 font-medium">Tactical Vision</th>
                    <th className="py-2 pr-3 font-medium">Qualification</th>
                    <th className="py-2 pr-3 font-medium">Stars</th>
                    <th className="py-2 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {clubCoaches.map((coach) => {
                    const visionLabel =
                      tacticalVisions.find((v) => v.internalKey === coach.tacticalVisionKey)
                        ?.displayName ?? coach.tacticalVisionKey;
                    const boostsRolePlus =
                      coach.qualificationLevel === 'silver' || coach.qualificationLevel === 'gold';
                    return (
                      <tr key={coach.id} className="hover:bg-white/[0.02]">
                        <td className="py-2.5 pr-3 font-medium text-white">{coach.name}</td>
                        <td className="py-2.5 pr-3 capitalize text-[#C5CCD7]">
                          {coach.department.replace('_', ' ')}
                        </td>
                        <td className="py-2.5 pr-3 text-[#C5CCD7]">{visionLabel}</td>
                        <td className="py-2.5 pr-3">
                          <span
                            className={`capitalize font-mono ${
                              boostsRolePlus ? 'text-emerald-300' : 'text-[#8A94A6]'
                            }`}
                          >
                            {coach.qualificationLevel}
                          </span>
                          {boostsRolePlus && (
                            <span className="ml-1.5 text-[10px] text-emerald-400">
                              (Potential Role+)
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-amber-300">
                          {'★'.repeat(coach.starRating)}
                        </td>
                        <td className="py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => void handleDeleteCoach(coach)}
                            aria-label={`Remove ${coach.name}`}
                            className="p-1 rounded hover:bg-red-500/10 text-[#9AA4B4] hover:text-red-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-[12px] text-[#7D8798]">
              No coaches logged for {activeClub.name} yet. Add your Career Mode coaches above to
              evaluate potential department Role+ familiarity boosts.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
