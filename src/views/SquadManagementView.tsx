import {
  AlertTriangle,
  ArrowRightLeft,
  Database,
  Download,
  Pencil,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { SortableTh } from '../components/common/SortableTh';
import { useApp } from '../context/AppContext';
import { PLAYER_POSITIONS } from '../data/tacticalCatalog';
import { type SortDirection, useTableSort } from '../hooks/useTableSort';
import { desktopBridge } from '../services/desktopBridge';
import type {
  CatalogPlayer,
  CatalogRole,
  DefaultRosterPreview,
  Player,
  PlayerAvailability,
  SquadStatus,
} from '../types/domain';
import {
  hasDistinctFullName,
  resolvePlayerDisplayName,
  resolvePlayerFullName,
} from '../utils/playerDisplayName';
import { evaluatePlayerEligibility, summarizeSquadEligibility } from '../utils/squadEligibility';

type SquadSortKey =
  | 'squadNumber'
  | 'player'
  | 'position'
  | 'overall'
  | 'potential'
  | 'age'
  | 'squadStatus'
  | 'availability'
  | 'roleFocus';

type CatalogImportSortKey = 'name' | 'position' | 'club' | 'overall' | 'potential' | 'age';

const SQUAD_STATUS_LABELS: Record<SquadStatus, string> = {
  active: 'Active',
  loaned_in: 'Loaned In',
  loaned_out: 'Loaned Out',
  transferred_out: 'Transferred Out',
  youth_academy: 'Youth Academy',
  released: 'Released',
};

const AVAILABILITY_LABELS: Record<PlayerAvailability, string> = {
  available: 'Available',
  injured: 'Injured',
  suspended: 'Suspended',
  doubtful: 'Doubtful',
  unavailable: 'Unavailable',
};

const POSITION_GROUPS: Record<string, string[]> = {
  GK: ['GK'],
  DEF: ['CB', 'LB', 'RB', 'LWB', 'RWB'],
  MID: ['CDM', 'CM', 'CAM', 'LM', 'RM'],
  ATT: ['LW', 'RW', 'ST', 'CF'],
};

const EMPTY_PLAYER_FORM = {
  name: '',
  displayNameOverride: '',
  shortName: '',
  fullName: '',
  position: 'CM',
  secondaryPositions: '',
  squadNumber: '',
  squadStatus: 'active' as SquadStatus,
  availability: 'available' as PlayerAvailability,
  seniorSelectionAuthorized: false,
  injuryStatus: '',
  suspensionStatus: '',
  membershipStartDate: new Date().toISOString().slice(0, 10),
  membershipEndDate: '',
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
  notes: '',
};

export function SquadManagementView() {
  const { activeClub, players, tacticalCatalog, refreshAll, notify, requestNavigation } = useApp();

  const [catalogRoles, setCatalogRoles] = useState<CatalogRole[]>([]);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SquadStatus>('all');
  const [availabilityFilter, setAvailabilityFilter] = useState<'all' | PlayerAvailability>('all');
  const [positionGroupFilter, setPositionGroupFilter] = useState<'all' | 'GK' | 'DEF' | 'MID' | 'ATT'>('all');

  // Panels / modals
  const [showPlayerModal, setShowPlayerModal] = useState(false);
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const [editingPlayerCatalogId, setEditingPlayerCatalogId] = useState<string | null>(null);
  const [playerForm, setPlayerForm] = useState(EMPTY_PLAYER_FORM);
  const [submitting, setSubmitting] = useState(false);

  // FC26 Catalog Player Import Drawer
  const [showCatalogImportPanel, setShowCatalogImportPanel] = useState(false);
  const [catalogPlayerQuery, setCatalogPlayerQuery] = useState('');
  const [catalogPlayerPos, setCatalogPlayerPos] = useState('');
  const [catalogPlayerSortBy, setCatalogPlayerSortBy] = useState<CatalogImportSortKey>('overall');
  const [catalogPlayerSortDir, setCatalogPlayerSortDir] = useState<SortDirection>('desc');
  const [catalogPlayerResults, setCatalogPlayerResults] = useState<CatalogPlayer[]>([]);
  const [catalogPlayerTotal, setCatalogPlayerTotal] = useState(0);
  const [catalogPlayerLoading, setCatalogPlayerLoading] = useState(false);
  const [importingCatalogPlayerId, setImportingCatalogPlayerId] = useState<string | null>(null);

  // Default Club Roster Preview & Import Modal
  const [showDefaultRosterModal, setShowDefaultRosterModal] = useState(false);
  const [defaultRosterPreview, setDefaultRosterPreview] = useState<DefaultRosterPreview | null>(null);
  const [loadingDefaultRoster, setLoadingDefaultRoster] = useState(false);
  const [importingDefaultRoster, setImportingDefaultRoster] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<Player | null>(null);

  useEffect(() => {
    let active = true;
    desktopBridge
      .listCatalogRoles()
      .then((roles) => {
        if (active) setCatalogRoles(roles);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!showCatalogImportPanel) return;
    let active = true;
    setCatalogPlayerLoading(true);
    const timer = window.setTimeout(() => {
      desktopBridge
        .searchCatalogPlayers({
          q: catalogPlayerQuery.trim() || undefined,
          positions: catalogPlayerPos ? [catalogPlayerPos] : undefined,
          sortBy: catalogPlayerSortBy,
          sortDir: catalogPlayerSortDir,
          page: 1,
          pageSize: 20,
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
  }, [
    showCatalogImportPanel,
    catalogPlayerQuery,
    catalogPlayerPos,
    catalogPlayerSortBy,
    catalogPlayerSortDir,
  ]);

  const importedCatalogIds = useMemo(
    () => new Set(players.map((p) => p.catalogPlayerId).filter((id): id is string => Boolean(id))),
    [players]
  );

  const filteredPlayers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return players.filter((p) => {
      if (statusFilter !== 'all' && p.squadStatus !== statusFilter) return false;
      if (availabilityFilter !== 'all' && p.availability !== availabilityFilter) return false;
      if (positionGroupFilter !== 'all') {
        const allowed = POSITION_GROUPS[positionGroupFilter] ?? [];
        if (!allowed.includes(p.position.toUpperCase())) return false;
      }
      if (q) {
        const hay = `${p.displayName} ${p.fullName} ${p.shortName ?? ''} ${p.position} ${p.playerRole} ${p.squadNumber ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [players, searchQuery, statusFilter, availabilityFilter, positionGroupFilter]);

  const squadAccessors = useMemo<Record<SquadSortKey, (p: Player) => string | number | null>>(
    () => ({
      squadNumber: (p) => p.squadNumber,
      player: (p) => resolvePlayerDisplayName(p),
      position: (p) => p.position,
      overall: (p) => p.overallRating,
      potential: (p) => p.potentialRating,
      age: (p) => p.age,
      squadStatus: (p) => p.squadStatus,
      availability: (p) => p.availability,
      roleFocus: (p) =>
        p.playerRole ? (p.playerFocus ? `${p.playerRole} ${p.playerFocus}` : p.playerRole) : null,
    }),
    []
  );

  const {
    sortedRows: sortedPlayers,
    sortKey: squadSortKey,
    sortDir: squadSortDir,
    toggleSort: toggleSquadSort,
  } = useTableSort(filteredPlayers, squadAccessors, {
    key: 'overall',
    dir: 'desc',
  });

  const stats = useMemo(() => {
    const eligibility = summarizeSquadEligibility(players);
    const activeCount = players.filter(
      (p) => p.squadStatus === 'active' || p.squadStatus === 'loaned_in' || p.squadStatus === 'youth_academy'
    ).length;
    const loanedOrOut = players.filter(
      (p) => p.squadStatus === 'loaned_out' || p.squadStatus === 'transferred_out' || p.squadStatus === 'released'
    ).length;
    const rated = players.filter((p) => p.overallRating !== null && p.squadStatus !== 'transferred_out');
    const avgOvr =
      rated.length > 0
        ? (rated.reduce((sum, p) => sum + (p.overallRating ?? 0), 0) / rated.length).toFixed(1)
        : '—';
    return {
      activeCount,
      availableCount: eligibility.eligibleCount,
      doubtfulCount: eligibility.doubtfulCount,
      unavailableCount: eligibility.ineligibleCount,
      loanedOrOut,
      avgOvr,
    };
  }, [players]);

  const validRolesForPosition = useMemo(
    () => catalogRoles.filter((r) => r.eligiblePositions.includes(playerForm.position)),
    [catalogRoles, playerForm.position]
  );

  const fallbackRoleNames = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'player_role').map((c) => c.name),
    [tacticalCatalog]
  );

  const validFocusesForRole = useMemo(() => {
    if (!playerForm.playerRole || catalogRoles.length === 0) return [];
    const roleObj = catalogRoles.find((r) => r.name === playerForm.playerRole);
    return roleObj?.compatibleFocusesByPosition[playerForm.position] ?? [];
  }, [catalogRoles, playerForm.playerRole, playerForm.position]);

  const liveResolvedDisplayNamePreview = resolvePlayerDisplayName({
    displayNameOverride: playerForm.displayNameOverride.trim() || null,
    shortName: playerForm.shortName.trim() || null,
    fullName: playerForm.fullName.trim() || playerForm.name.trim() || null,
    name: playerForm.name.trim() || null,
  });

  if (!activeClub) {
    return (
      <div className="max-w-2xl border border-white/[0.08] bg-[#12151B] rounded-lg p-8">
        <h1 className="text-[20px] font-semibold text-white">No Active Career Mode Club</h1>
        <p className="mt-2 text-[14px] text-[#9AA4B4]">
          Create or activate a Career Mode club first. Each career squad is persisted independently
          from the master FC26 reference database.
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

  function handleToggleCatalogPlayerSort(
    key: CatalogImportSortKey,
    defaultDir: SortDirection = 'asc'
  ) {
    if (catalogPlayerSortBy === key) {
      setCatalogPlayerSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setCatalogPlayerSortBy(key);
      setCatalogPlayerSortDir(defaultDir);
    }
  }

  async function openDefaultRosterPreview() {
    if (!activeClub) return;
    setShowDefaultRosterModal(true);
    setLoadingDefaultRoster(true);
    try {
      const preview = await desktopBridge.previewClubDefaultRoster(activeClub.id);
      setDefaultRosterPreview(preview);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to inspect default roster');
      setShowDefaultRosterModal(false);
    } finally {
      setLoadingDefaultRoster(false);
    }
  }

  async function handleExecuteDefaultRosterImport() {
    if (!activeClub) return;
    setImportingDefaultRoster(true);
    try {
      const result = await desktopBridge.importClubDefaultRoster(activeClub.id);
      await refreshAll();
      notify(result.importedCount > 0 ? 'success' : 'info', result.message);
      setShowDefaultRosterModal(false);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to import default club roster');
    } finally {
      setImportingDefaultRoster(false);
    }
  }

  function openAddCustomPlayer(isAcademy = false) {
    setEditingPlayerId(null);
    setEditingPlayerCatalogId(null);
    setPlayerForm({
      ...EMPTY_PLAYER_FORM,
      squadStatus: isAcademy ? 'youth_academy' : 'active',
    });
    setShowPlayerModal(true);
  }

  function openEditPlayer(p: Player) {
    setEditingPlayerId(p.id);
    setEditingPlayerCatalogId(p.catalogPlayerId ?? null);
    setPlayerForm({
      name: p.name,
      displayNameOverride: p.displayNameOverride ?? '',
      shortName: p.shortName ?? '',
      fullName: p.fullName || p.name,
      position: p.position,
      secondaryPositions: p.secondaryPositions.join(', '),
      squadNumber: p.squadNumber !== null ? String(p.squadNumber) : '',
      squadStatus: p.squadStatus,
      availability: p.availability,
      seniorSelectionAuthorized: Boolean(p.seniorSelectionAuthorized),
      injuryStatus: p.injuryStatus ?? '',
      suspensionStatus: p.suspensionStatus ?? '',
      membershipStartDate: p.membershipStartDate ?? '',
      membershipEndDate: p.membershipEndDate ?? '',
      overallRating: p.overallRating !== null ? String(p.overallRating) : '',
      potentialRating: p.potentialRating !== null ? String(p.potentialRating) : '',
      age: p.age !== null ? String(p.age) : '',
      preferredFoot: p.preferredFoot,
      playerRole: p.playerRole,
      playerFocus: p.playerFocus,
      contractExpiry: p.contractExpiry ?? '',
      strengths: p.strengths,
      weaknesses: p.weaknesses,
      preferredInstructions: p.preferredInstructions,
      notes: p.notes ?? '',
    });
    setShowPlayerModal(true);
  }

  async function handleSavePlayer(e: React.FormEvent) {
    e.preventDefault();
    if (!activeClub) return;
    if (!playerForm.name.trim()) {
      notify('error', 'Player name is required.');
      return;
    }

    const parseOptionalNum = (val: string, min: number, max: number, label: string): number | null => {
      if (!val.trim()) return null;
      const n = Number(val);
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new Error(`${label} must be between ${min} and ${max}.`);
      }
      return Math.round(n);
    };

    try {
      const ovr = parseOptionalNum(playerForm.overallRating, 1, 99, 'Overall rating');
      const pot = parseOptionalNum(playerForm.potentialRating, 1, 99, 'Potential rating');
      const age = parseOptionalNum(playerForm.age, 14, 55, 'Age');
      const squadNumber = parseOptionalNum(playerForm.squadNumber, 1, 99, 'Squad number');
      const secondaryPositions = playerForm.secondaryPositions
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);

      setSubmitting(true);
      if (editingPlayerId) {
        await desktopBridge.updatePlayer(editingPlayerId, {
          name: playerForm.name.trim(),
          displayNameOverride: playerForm.displayNameOverride.trim() || null,
          shortName: playerForm.shortName.trim() || null,
          fullName: playerForm.fullName.trim() || playerForm.name.trim(),
          position: playerForm.position,
          secondaryPositions,
          squadNumber,
          squadStatus: playerForm.squadStatus,
          availability: playerForm.availability,
          seniorSelectionAuthorized:
            playerForm.squadStatus === 'youth_academy'
              ? playerForm.seniorSelectionAuthorized
              : false,
          injuryStatus: playerForm.injuryStatus.trim() || null,
          suspensionStatus: playerForm.suspensionStatus.trim() || null,
          membershipStartDate: playerForm.membershipStartDate.trim() || null,
          membershipEndDate: playerForm.membershipEndDate.trim() || null,
          overallRating: ovr,
          potentialRating: pot,
          age,
          preferredFoot: playerForm.preferredFoot,
          playerRole: playerForm.playerRole,
          playerFocus: playerForm.playerFocus,
          contractExpiry: playerForm.contractExpiry.trim() || null,
          strengths: playerForm.strengths,
          weaknesses: playerForm.weaknesses,
          preferredInstructions: playerForm.preferredInstructions,
          notes: playerForm.notes,
        });
        notify('success', `Updated ${liveResolvedDisplayNamePreview} in Career Mode squad.`);
      } else {
        await desktopBridge.createPlayer({
          clubId: activeClub.id,
          name: playerForm.name.trim(),
          displayNameOverride: playerForm.displayNameOverride.trim() || null,
          shortName: playerForm.shortName.trim() || null,
          fullName: playerForm.fullName.trim() || playerForm.name.trim(),
          position: playerForm.position,
          secondaryPositions,
          squadNumber,
          squadStatus: playerForm.squadStatus,
          availability: playerForm.availability,
          seniorSelectionAuthorized:
            playerForm.squadStatus === 'youth_academy'
              ? playerForm.seniorSelectionAuthorized
              : false,
          injuryStatus: playerForm.injuryStatus.trim() || null,
          suspensionStatus: playerForm.suspensionStatus.trim() || null,
          membershipStartDate: playerForm.membershipStartDate.trim() || null,
          membershipEndDate: playerForm.membershipEndDate.trim() || null,
          overallRating: ovr,
          potentialRating: pot,
          age,
          preferredFoot: playerForm.preferredFoot,
          playerRole: playerForm.playerRole,
          playerFocus: playerForm.playerFocus,
          contractExpiry: playerForm.contractExpiry.trim() || null,
          strengths: playerForm.strengths,
          weaknesses: playerForm.weaknesses,
          preferredInstructions: playerForm.preferredInstructions,
          notes: playerForm.notes,
        });
        notify('success', `Added ${liveResolvedDisplayNamePreview} to ${activeClub.name}.`);
      }

      setShowPlayerModal(false);
      setEditingPlayerId(null);
      await refreshAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save player');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleQuickLifecycleUpdate(
    player: Player,
    patch: {
      squadStatus?: SquadStatus;
      availability?: PlayerAvailability;
      injuryStatus?: string | null;
      suspensionStatus?: string | null;
      membershipEndDate?: string | null;
    },
    label: string
  ) {
    try {
      await desktopBridge.updatePlayer(player.id, patch);
      await refreshAll();
      notify('info', `${resolvePlayerDisplayName(player)}: ${label}.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to update player status');
    }
  }

  async function handleImportCatalogPlayer(cp: CatalogPlayer, asLoan = false) {
    if (!activeClub) return;
    setImportingCatalogPlayerId(cp.id);
    try {
      await desktopBridge.importPlayerFromCatalog(activeClub.id, {
        catalogPlayerId: cp.id,
        squadStatus: asLoan ? 'loaned_in' : 'active',
        membershipStartDate: new Date().toISOString().slice(0, 10),
      });
      await refreshAll();
      notify(
        'success',
        `${asLoan ? 'Loaned in' : 'Signed'} ${resolvePlayerDisplayName(cp)} (${cp.primaryPosition}) into ${activeClub.name}.`
      );
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to import player from catalog');
    } finally {
      setImportingCatalogPlayerId(null);
    }
  }

  async function handleConfirmDeletePlayer() {
    if (!deleteTarget) return;
    try {
      await desktopBridge.deletePlayer(deleteTarget.id);
      notify('info', `Removed ${resolvePlayerDisplayName(deleteTarget)} from career squad.`);
      setDeleteTarget(null);
      await refreshAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to delete player');
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">
            Squad Management — {activeClub.name}
          </h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Manage your active Career Mode roster independently from the master FC26 reference
            database. Track transfers, loans, injuries, suspensions, squad numbers, and custom
            display names.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void openDefaultRosterPreview()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-white/[0.14] hover:border-emerald-500/60 bg-[#12151B] text-[13px] text-[#E5E9F0] font-medium transition-colors"
          >
            <Download className="w-4 h-4 text-emerald-400" />
            Import Default Roster
          </button>
          <button
            type="button"
            onClick={() => setShowCatalogImportPanel((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-emerald-500/40 bg-emerald-600/12 hover:bg-emerald-600/20 text-[13px] text-emerald-300 font-medium transition-colors"
          >
            <Database className="w-4 h-4" />
            {showCatalogImportPanel ? 'Close FC26 Scouting' : 'Add from FC26 DB'}
          </button>
          <button
            type="button"
            onClick={() => openAddCustomPlayer(false)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium transition-colors"
          >
            <UserPlus className="w-4 h-4" />
            Add Custom / Academy
          </button>
        </div>
      </div>

      {/* Squad Summary Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-4">
          <div className="text-[12px] text-[#8A94A6]">Total Squad Records</div>
          <div className="mt-1 text-[22px] font-bold font-mono tabular-nums text-white">
            {players.length}
          </div>
        </div>
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-4">
          <div className="text-[12px] text-[#8A94A6]">Active / Loaned In</div>
          <div className="mt-1 text-[22px] font-bold font-mono tabular-nums text-white">
            {stats.activeCount}
          </div>
        </div>
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-4">
          <div className="text-[12px] text-[#8A94A6]">Matchday Eligible</div>
          <div className="mt-1 text-[22px] font-bold font-mono tabular-nums text-emerald-400">
            {stats.availableCount}
            {stats.doubtfulCount > 0 && (
              <span className="ml-2 text-[12px] font-normal text-amber-300">
                ({stats.doubtfulCount} doubtful)
              </span>
            )}
          </div>
        </div>
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-4">
          <div className="text-[12px] text-[#8A94A6]">Ineligible / Unavailable</div>
          <div className="mt-1 text-[22px] font-bold font-mono tabular-nums text-amber-300">
            {stats.unavailableCount}
          </div>
        </div>
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-4">
          <div className="text-[12px] text-[#8A94A6]">Average OVR · Out/Loaned</div>
          <div className="mt-1 text-[22px] font-bold font-mono tabular-nums text-white">
            {stats.avgOvr}
            <span className="ml-2 text-[13px] font-normal text-[#8A94A6]">
              · {stats.loanedOrOut} out
            </span>
          </div>
        </div>
      </div>

      {/* Add Player from FC26 Master Database Drawer */}
      {showCatalogImportPanel && (
        <section className="border border-emerald-500/30 bg-[#12151B] rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[15px] font-semibold text-white">
                Transfer In / Loan In from FC26 Master Player Database
              </h2>
              <p className="text-[12px] text-[#8A94A6]">
                Copies player profile into {activeClub.name} Career Mode squad. Master catalog rows
                are never mutated.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowCatalogImportPanel(false)}
              className="p-1 text-[#8A94A6] hover:text-white"
              aria-label="Close scouting panel"
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
                placeholder="Search 18,405+ FC26 players by name, short name, or club..."
                className="w-full bg-[#0C0F14] border border-white/[0.1] rounded-md pl-8 pr-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
            <select
              value={catalogPlayerPos}
              onChange={(e) => setCatalogPlayerPos(e.target.value)}
              className="bg-[#0C0F14] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
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
            <div className="text-[13px] text-[#8A94A6] py-4">Searching FC26 database...</div>
          ) : catalogPlayerTotal === 0 && !catalogPlayerQuery && !catalogPlayerPos ? (
            <div className="rounded-md border border-white/[0.08] bg-[#0C0F14] p-4 flex flex-wrap items-center justify-between gap-4">
              <div className="text-[13px] text-[#9AA4B4]">
                No players imported in the FC26 Master Database yet. Import your players CSV/JSON in
                the FC26 Database Center.
              </div>
              <button
                type="button"
                onClick={() => requestNavigation('database-center')}
                className="px-3.5 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-medium"
              >
                Open FC26 Database Center
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="border-b border-white/[0.08] text-[#7D8798]">
                    <SortableTh
                      label="Player"
                      columnKey="name"
                      activeKey={catalogPlayerSortBy}
                      direction={catalogPlayerSortDir}
                      onSort={handleToggleCatalogPlayerSort}
                      className="py-2 pr-3 font-medium"
                    />
                    <SortableTh
                      label="Pos"
                      columnKey="position"
                      activeKey={catalogPlayerSortBy}
                      direction={catalogPlayerSortDir}
                      onSort={handleToggleCatalogPlayerSort}
                      className="py-2 pr-3 font-medium"
                    />
                    <SortableTh
                      label="Catalog Club"
                      columnKey="club"
                      activeKey={catalogPlayerSortBy}
                      direction={catalogPlayerSortDir}
                      onSort={handleToggleCatalogPlayerSort}
                      className="py-2 pr-3 font-medium"
                    />
                    <SortableTh
                      label="OVR"
                      columnKey="overall"
                      activeKey={catalogPlayerSortBy}
                      direction={catalogPlayerSortDir}
                      onSort={handleToggleCatalogPlayerSort}
                      defaultDir="desc"
                      align="right"
                      className="py-2 pr-3 font-medium"
                    />
                    <SortableTh
                      label="POT"
                      columnKey="potential"
                      activeKey={catalogPlayerSortBy}
                      direction={catalogPlayerSortDir}
                      onSort={handleToggleCatalogPlayerSort}
                      defaultDir="desc"
                      align="right"
                      className="py-2 pr-3 font-medium"
                    />
                    <SortableTh
                      label="Age"
                      columnKey="age"
                      activeKey={catalogPlayerSortBy}
                      direction={catalogPlayerSortDir}
                      onSort={handleToggleCatalogPlayerSort}
                      align="right"
                      className="py-2 pr-3 font-medium"
                    />
                    <th className="py-2 font-medium text-right">Sign / Loan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {catalogPlayerResults.map((cp) => {
                    const alreadyInSquad = importedCatalogIds.has(cp.id);
                    const displayName = resolvePlayerDisplayName(cp);
                    const fullName = resolvePlayerFullName(cp);
                    return (
                      <tr key={cp.id} className="hover:bg-white/[0.02]">
                        <td className="py-2 pr-3">
                          <div className="font-medium text-white">{displayName}</div>
                          {hasDistinctFullName(displayName, fullName) && (
                            <div className="text-[11px] text-[#7D8798]">{fullName}</div>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-[#C5CCD7]">{cp.primaryPosition}</td>
                        <td className="py-2 pr-3 text-[#9AA4B4]">{cp.clubName ?? 'Free Agent'}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-white">
                          {cp.overallRating ?? '—'}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-emerald-400">
                          {cp.potentialRating ?? '—'}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-[#9AA4B4]">
                          {cp.age ?? '—'}
                        </td>
                        <td className="py-2 text-right">
                          {alreadyInSquad ? (
                            <span className="text-[11px] text-emerald-400">In Squad</span>
                          ) : (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={importingCatalogPlayerId === cp.id}
                                onClick={() => void handleImportCatalogPlayer(cp, false)}
                                className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[11px] font-medium"
                              >
                                Transfer In
                              </button>
                              <button
                                type="button"
                                disabled={importingCatalogPlayerId === cp.id}
                                onClick={() => void handleImportCatalogPlayer(cp, true)}
                                className="px-2 py-1 rounded border border-white/[0.14] hover:border-emerald-500/60 text-[#D7DDE7] text-[11px]"
                              >
                                Loan In
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Filter Bar + Squad Table */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-5 relative">
            <Search className="w-3.5 h-3.5 text-[#7D8798] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search squad by display name, full name, position, #..."
              className="w-full bg-[#0C0F14] border border-white/[0.1] rounded-md pl-8 pr-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="md:col-span-3">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | SquadStatus)}
              className="w-full bg-[#0C0F14] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            >
              <option value="all">All Squad Statuses</option>
              {(Object.keys(SQUAD_STATUS_LABELS) as SquadStatus[]).map((st) => (
                <option key={st} value={st}>
                  {SQUAD_STATUS_LABELS[st]}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <select
              value={availabilityFilter}
              onChange={(e) => setAvailabilityFilter(e.target.value as 'all' | PlayerAvailability)}
              className="w-full bg-[#0C0F14] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            >
              <option value="all">All Availability</option>
              {(Object.keys(AVAILABILITY_LABELS) as PlayerAvailability[]).map((av) => (
                <option key={av} value={av}>
                  {AVAILABILITY_LABELS[av]}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <select
              value={positionGroupFilter}
              onChange={(e) =>
                setPositionGroupFilter(e.target.value as 'all' | 'GK' | 'DEF' | 'MID' | 'ATT')
              }
              className="w-full bg-[#0C0F14] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            >
              <option value="all">All Lines</option>
              <option value="GK">Goalkeepers</option>
              <option value="DEF">Defenders</option>
              <option value="MID">Midfielders</option>
              <option value="ATT">Forwards</option>
            </select>
          </div>
        </div>

        {sortedPlayers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-white/[0.08] text-[12px] text-[#7D8798]">
                  <SortableTh
                    label="#"
                    columnKey="squadNumber"
                    activeKey={squadSortKey}
                    direction={squadSortDir}
                    onSort={toggleSquadSort}
                    className="py-2 pr-3 font-medium"
                  />
                  <SortableTh
                    label="Player"
                    columnKey="player"
                    activeKey={squadSortKey}
                    direction={squadSortDir}
                    onSort={toggleSquadSort}
                    className="py-2 pr-4 font-medium"
                  />
                  <SortableTh
                    label="Pos"
                    columnKey="position"
                    activeKey={squadSortKey}
                    direction={squadSortDir}
                    onSort={toggleSquadSort}
                    className="py-2 pr-3 font-medium"
                  />
                  <SortableTh
                    label="OVR"
                    columnKey="overall"
                    activeKey={squadSortKey}
                    direction={squadSortDir}
                    onSort={toggleSquadSort}
                    defaultDir="desc"
                    align="right"
                    className="py-2 pr-3 font-medium"
                  />
                  <SortableTh
                    label="POT"
                    columnKey="potential"
                    activeKey={squadSortKey}
                    direction={squadSortDir}
                    onSort={toggleSquadSort}
                    defaultDir="desc"
                    align="right"
                    className="py-2 pr-3 font-medium"
                  />
                  <SortableTh
                    label="Age"
                    columnKey="age"
                    activeKey={squadSortKey}
                    direction={squadSortDir}
                    onSort={toggleSquadSort}
                    align="right"
                    className="py-2 pr-3 font-medium"
                  />
                  <SortableTh
                    label="Status"
                    columnKey="squadStatus"
                    activeKey={squadSortKey}
                    direction={squadSortDir}
                    onSort={toggleSquadSort}
                    className="py-2 pr-3 font-medium"
                  />
                  <SortableTh
                    label="Availability"
                    columnKey="availability"
                    activeKey={squadSortKey}
                    direction={squadSortDir}
                    onSort={toggleSquadSort}
                    className="py-2 pr-3 font-medium"
                  />
                  <SortableTh
                    label="Preferred Role / Focus"
                    columnKey="roleFocus"
                    activeKey={squadSortKey}
                    direction={squadSortDir}
                    onSort={toggleSquadSort}
                    className="py-2 pr-3 font-medium"
                  />
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {sortedPlayers.map((p) => {
                  const displayName = resolvePlayerDisplayName(p);
                  const fullName = resolvePlayerFullName(p);
                  const eligibility = evaluatePlayerEligibility(p);
                  const isUnavailable = !eligibility.eligible;
                  return (
                    <tr
                      key={p.id}
                      className={`hover:bg-white/[0.02] ${isUnavailable ? 'opacity-80' : ''}`}
                    >
                      <td className="py-2.5 pr-3 font-mono tabular-nums text-[#8A94A6]">
                        {p.squadNumber ?? '—'}
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="font-medium text-white" title={fullName}>
                          {displayName}
                          {p.displayNameOverride && (
                            <span className="ml-1.5 text-[10px] text-emerald-400 font-normal">
                              Custom
                            </span>
                          )}
                        </div>
                        {hasDistinctFullName(displayName, fullName) && (
                          <div className="text-[11px] text-[#7D8798]">{fullName}</div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[#D7DDE7]">
                        <div>{p.position}</div>
                        {p.secondaryPositions.length > 0 && (
                          <div className="text-[10px] text-[#7D8798]">
                            {p.secondaryPositions.join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-white font-semibold">
                        {p.overallRating ?? '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-emerald-400">
                        {p.potentialRating ?? '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-[#9AA4B4]">
                        {p.age ?? '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-[12px]">
                        <span
                          className={`font-medium ${
                            p.squadStatus === 'active'
                              ? 'text-emerald-300'
                              : p.squadStatus === 'loaned_in' || p.squadStatus === 'youth_academy'
                                ? 'text-sky-300'
                                : 'text-amber-300'
                          }`}
                        >
                          {SQUAD_STATUS_LABELS[p.squadStatus]}
                        </span>
                        {p.squadStatus === 'youth_academy' && (
                          <div className="text-[10px] text-[#8A94A6]">
                            {p.seniorSelectionAuthorized
                              ? 'Senior Selection Authorized'
                              : 'Not Promoted (Ineligible)'}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-[12px]">
                        <div
                          className={
                            p.availability === 'available'
                              ? 'text-[#C5CCD7]'
                              : p.availability === 'doubtful'
                                ? 'text-amber-300'
                                : 'text-red-300 font-medium'
                          }
                        >
                          {AVAILABILITY_LABELS[p.availability]}
                        </div>
                        {(p.injuryStatus || p.suspensionStatus) && (
                          <div className="text-[11px] text-[#8A94A6] truncate max-w-[160px]">
                            {p.injuryStatus || p.suspensionStatus}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-[12px] text-[#C5CCD7]">
                        {p.playerRole
                          ? p.playerFocus
                            ? `${p.playerRole} (${p.playerFocus})`
                            : p.playerRole
                          : '—'}
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {p.availability === 'available' ? (
                            <button
                              type="button"
                              onClick={() =>
                                void handleQuickLifecycleUpdate(
                                  p,
                                  { availability: 'injured', injuryStatus: 'Injured (Career Mode)' },
                                  'Marked Injured'
                                )
                              }
                              title="Mark Injured"
                              className="px-2 py-1 rounded border border-white/[0.1] hover:border-amber-500/50 text-[11px] text-[#B8C0CE] hover:text-amber-200"
                            >
                              Injure
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                void handleQuickLifecycleUpdate(
                                  p,
                                  {
                                    availability: 'available',
                                    injuryStatus: null,
                                    suspensionStatus: null,
                                  },
                                  'Marked Available'
                                )
                              }
                              title="Mark Available"
                              className="px-2 py-1 rounded border border-emerald-500/35 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
                            >
                              Clear Fit
                            </button>
                          )}

                          {p.squadStatus === 'active' ? (
                            <button
                              type="button"
                              onClick={() =>
                                void handleQuickLifecycleUpdate(
                                  p,
                                  {
                                    squadStatus: 'loaned_out',
                                    availability: 'unavailable',
                                  },
                                  'Loaned Out'
                                )
                              }
                              title="Loan Out"
                              className="p-1.5 rounded hover:bg-white/[0.06] text-[#9AA4B4] hover:text-amber-300"
                            >
                              <ArrowRightLeft className="w-3.5 h-3.5" />
                            </button>
                          ) : p.squadStatus === 'loaned_out' ? (
                            <button
                              type="button"
                              onClick={() =>
                                void handleQuickLifecycleUpdate(
                                  p,
                                  {
                                    squadStatus: 'active',
                                    availability: 'available',
                                  },
                                  'Recalled / Returned from Loan'
                                )
                              }
                              title="Recall from Loan"
                              className="px-2 py-1 rounded border border-sky-500/40 text-[11px] text-sky-300"
                            >
                              Recall
                            </button>
                          ) : p.squadStatus === 'youth_academy' ? (
                            <button
                              type="button"
                              onClick={() =>
                                void handleQuickLifecycleUpdate(
                                  p,
                                  {
                                    squadStatus: 'active',
                                    availability: 'available',
                                  },
                                  'Promoted to Senior Squad'
                                )
                              }
                              title="Promote from Youth Academy to Senior Squad"
                              className="px-2 py-1 rounded border border-emerald-500/40 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
                            >
                              Promote
                            </button>
                          ) : null}

                          <button
                            type="button"
                            onClick={() => openEditPlayer(p)}
                            aria-label={`Edit ${displayName}`}
                            className="p-1.5 rounded hover:bg-white/[0.06] text-[#9AA4B4] hover:text-white"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(p)}
                            aria-label={`Remove ${displayName}`}
                            className="p-1.5 rounded hover:bg-red-500/10 text-[#9AA4B4] hover:text-red-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-12 text-center space-y-3">
            <Users className="w-8 h-8 text-[#596272] mx-auto" />
            <div className="text-[14px] font-medium text-white">
              {players.length === 0
                ? `No players in ${activeClub.name}'s Career Mode squad yet`
                : 'No squad players match your current filters'}
            </div>
            <p className="text-[12px] text-[#8A94A6] max-w-md mx-auto">
              {players.length === 0
                ? 'Import the club’s default FC26 roster, sign individual players from the FC26 Database, or create custom/academy players.'
                : 'Clear search or status filters to view the full squad.'}
            </p>
            {players.length === 0 && (
              <div className="flex flex-wrap justify-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void openDefaultRosterPreview()}
                  className="px-3.5 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-medium"
                >
                  Import Default Club Roster
                </button>
                <button
                  type="button"
                  onClick={() => setShowCatalogImportPanel(true)}
                  className="px-3.5 py-2 rounded-md border border-white/[0.14] text-white text-[12px] font-medium"
                >
                  Browse FC26 Database
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Default Club Roster Preview & Import Modal */}
      {showDefaultRosterModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl border border-white/[0.12] bg-[#12151B] rounded-lg p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[17px] font-semibold text-white">
                  Import Missing Default FC26 Players — {activeClub.name}
                </h2>
                <p className="text-[11px] text-[#8A94A6] mt-0.5">
                  Source: Imported FC26 Dataset Snapshot · Never overwrites Career Mode transfers or
                  reactivates loaned-out/released players.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowDefaultRosterModal(false)}
                className="text-[#8A94A6] hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {loadingDefaultRoster ? (
              <div className="py-6 text-[13px] text-[#9AA4B4]">
                Checking stable FC26 catalog club mapping...
              </div>
            ) : defaultRosterPreview ? (
              <div className="space-y-4 text-[13px]">
                <div
                  className={`rounded-md border p-3.5 ${
                    defaultRosterPreview.status === 'linked_with_players'
                      ? 'border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-100'
                      : 'border-amber-500/30 bg-amber-500/[0.06] text-amber-100'
                  }`}
                >
                  <div className="font-medium">{defaultRosterPreview.message}</div>
                  {defaultRosterPreview.status === 'linked_with_players' && (
                    <div className="mt-1.5 text-[12px] font-mono tabular-nums text-[#C8D1DD]">
                      Matched Catalog Players: {defaultRosterPreview.totalMatchedPlayers} · Missing
                      to Import: {defaultRosterPreview.newToImportCount} · Already Tracked
                      (Preserved): {defaultRosterPreview.alreadyInSquadCount}
                    </div>
                  )}
                </div>

                {defaultRosterPreview.samplePlayers.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[12px] text-[#8A94A6]">
                      Dataset Snapshot Preview (Top {defaultRosterPreview.samplePlayers.length} by
                      OVR):
                    </div>
                    <div className="max-h-56 overflow-y-auto border border-white/[0.08] rounded-md divide-y divide-white/[0.06] bg-[#0C0F14]">
                      {defaultRosterPreview.samplePlayers.map((sp) => (
                        <div
                          key={sp.id}
                          className="px-3 py-2 flex items-center justify-between text-[12px]"
                        >
                          <div>
                            <span className="text-white font-medium">{sp.displayName}</span>
                            {hasDistinctFullName(sp.displayName, sp.fullName) && (
                              <span className="ml-2 text-[#7D8798]">{sp.fullName}</span>
                            )}
                          </div>
                          <div className="font-mono tabular-nums text-[#C5CCD7]">
                            {sp.primaryPosition} · OVR {sp.overallRating ?? '—'} · Age{' '}
                            {sp.age ?? '—'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.08]">
                  <button
                    type="button"
                    onClick={() => setShowDefaultRosterModal(false)}
                    className="px-4 py-2 rounded-md border border-white/[0.12] text-[#C5CCD7] text-[13px]"
                  >
                    Close
                  </button>
                  {defaultRosterPreview.status === 'linked_with_players' &&
                    defaultRosterPreview.newToImportCount > 0 && (
                      <button
                        type="button"
                        disabled={importingDefaultRoster}
                        onClick={() => void handleExecuteDefaultRosterImport()}
                        className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[13px] font-medium"
                      >
                        {importingDefaultRoster
                          ? 'Importing...'
                          : `Import ${defaultRosterPreview.newToImportCount} Missing Player(s)`}
                      </button>
                    )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Add / Edit Player Modal */}
      {showPlayerModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={(e) => void handleSavePlayer(e)}
            className="w-full max-w-3xl border border-white/[0.12] bg-[#12151B] rounded-lg p-6 space-y-5 shadow-2xl my-8"
          >
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div>
                <h2 className="text-[17px] font-semibold text-white">
                  {editingPlayerId ? 'Edit Career Mode Squad Player' : 'Add Custom / Academy Player'}
                </h2>
                <p className="text-[12px] text-[#8A94A6] mt-0.5">
                  Resolved UI Display Name:{' '}
                  <span className="text-emerald-300 font-medium">
                    {liveResolvedDisplayNamePreview}
                  </span>
                  {editingPlayerCatalogId && ' · Linked to master FC26 catalog (never mutated)'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPlayerModal(false)}
                className="text-[#8A94A6] hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[13px]">
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Full / Canonical Name *</label>
                <input
                  type="text"
                  required
                  value={playerForm.name}
                  onChange={(e) =>
                    setPlayerForm({
                      ...playerForm,
                      name: e.target.value,
                      fullName: playerForm.fullName || e.target.value,
                    })
                  }
                  placeholder="e.g. Bukayo Saka"
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">
                  Display Name Override (Optional)
                </label>
                <input
                  type="text"
                  value={playerForm.displayNameOverride}
                  onChange={(e) =>
                    setPlayerForm({ ...playerForm, displayNameOverride: e.target.value })
                  }
                  placeholder="e.g. Saka, Vini Jr."
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Short Name</label>
                <input
                  type="text"
                  value={playerForm.shortName}
                  onChange={(e) => setPlayerForm({ ...playerForm, shortName: e.target.value })}
                  placeholder="Imported short name"
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                />
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Primary Position *</label>
                <select
                  value={playerForm.position}
                  onChange={(e) => setPlayerForm({ ...playerForm, position: e.target.value })}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                >
                  {PLAYER_POSITIONS.map((pos) => (
                    <option key={pos} value={pos}>
                      {pos}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">
                  Secondary Positions (comma-separated)
                </label>
                <input
                  type="text"
                  value={playerForm.secondaryPositions}
                  onChange={(e) =>
                    setPlayerForm({ ...playerForm, secondaryPositions: e.target.value })
                  }
                  placeholder="e.g. RW, CAM"
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Squad Number</label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={playerForm.squadNumber}
                  onChange={(e) => setPlayerForm({ ...playerForm, squadNumber: e.target.value })}
                  placeholder="1–99"
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">OVR</label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={playerForm.overallRating}
                  onChange={(e) => setPlayerForm({ ...playerForm, overallRating: e.target.value })}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">POT</label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={playerForm.potentialRating}
                  onChange={(e) =>
                    setPlayerForm({ ...playerForm, potentialRating: e.target.value })
                  }
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Age</label>
                <input
                  type="number"
                  min={14}
                  max={55}
                  value={playerForm.age}
                  onChange={(e) => setPlayerForm({ ...playerForm, age: e.target.value })}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Squad Status</label>
                <select
                  value={playerForm.squadStatus}
                  onChange={(e) =>
                    setPlayerForm({ ...playerForm, squadStatus: e.target.value as SquadStatus })
                  }
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                >
                  {(Object.keys(SQUAD_STATUS_LABELS) as SquadStatus[]).map((st) => (
                    <option key={st} value={st}>
                      {SQUAD_STATUS_LABELS[st]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Availability</label>
                <select
                  value={playerForm.availability}
                  onChange={(e) =>
                    setPlayerForm({
                      ...playerForm,
                      availability: e.target.value as PlayerAvailability,
                    })
                  }
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                >
                  {(Object.keys(AVAILABILITY_LABELS) as PlayerAvailability[]).map((av) => (
                    <option key={av} value={av}>
                      {AVAILABILITY_LABELS[av]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Preferred Foot</label>
                <select
                  value={playerForm.preferredFoot}
                  onChange={(e) =>
                    setPlayerForm({
                      ...playerForm,
                      preferredFoot: e.target.value as 'Right' | 'Left' | 'Both',
                    })
                  }
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                >
                  <option value="Right">Right</option>
                  <option value="Left">Left</option>
                  <option value="Both">Both</option>
                </select>
              </div>

              {playerForm.squadStatus === 'youth_academy' && (
                <div className="md:col-span-3 rounded-md border border-sky-500/30 bg-sky-500/[0.06] px-3.5 py-2.5">
                  <label className="inline-flex items-start gap-2.5 cursor-pointer text-[12px] text-sky-100">
                    <input
                      type="checkbox"
                      checked={playerForm.seniorSelectionAuthorized}
                      onChange={(e) =>
                        setPlayerForm({
                          ...playerForm,
                          seniorSelectionAuthorized: e.target.checked,
                        })
                      }
                      className="mt-0.5 w-4 h-4 accent-sky-500"
                    />
                    <span>
                      <strong className="text-white">Authorize Senior Matchday Selection</strong> —
                      By default, Youth Academy players cannot be selected in Starting XI or Bench
                      until promoted to Active. Check this to authorize temporary senior selection.
                    </span>
                  </label>
                </div>
              )}

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">
                  Injury Note (if injured/doubtful)
                </label>
                <input
                  type="text"
                  value={playerForm.injuryStatus}
                  onChange={(e) => setPlayerForm({ ...playerForm, injuryStatus: e.target.value })}
                  placeholder="e.g. Hamstring (3 weeks)"
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">
                  Suspension Note (if suspended)
                </label>
                <input
                  type="text"
                  value={playerForm.suspensionStatus}
                  onChange={(e) =>
                    setPlayerForm({ ...playerForm, suspensionStatus: e.target.value })
                  }
                  placeholder="e.g. Red Card (1 match)"
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Contract Expiry</label>
                <input
                  type="text"
                  value={playerForm.contractExpiry}
                  onChange={(e) => setPlayerForm({ ...playerForm, contractExpiry: e.target.value })}
                  placeholder="e.g. 2028"
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Membership Start</label>
                <input
                  type="date"
                  value={playerForm.membershipStartDate}
                  onChange={(e) =>
                    setPlayerForm({ ...playerForm, membershipStartDate: e.target.value })
                  }
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Membership End</label>
                <input
                  type="date"
                  value={playerForm.membershipEndDate}
                  onChange={(e) =>
                    setPlayerForm({ ...playerForm, membershipEndDate: e.target.value })
                  }
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Preferred FC IQ Role</label>
                <select
                  value={playerForm.playerRole}
                  onChange={(e) => {
                    const nextRole = e.target.value;
                    const roleObj = catalogRoles.find((r) => r.name === nextRole);
                    const focuses = roleObj?.compatibleFocusesByPosition[playerForm.position] ?? [];
                    setPlayerForm({
                      ...playerForm,
                      playerRole: nextRole,
                      playerFocus: focuses[0] ?? '',
                    });
                  }}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                >
                  <option value="">None specified</option>
                  {(validRolesForPosition.length > 0
                    ? validRolesForPosition.map((r) => r.name)
                    : fallbackRoleNames
                  ).map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Compatible Focus</label>
                <select
                  value={playerForm.playerFocus}
                  onChange={(e) => setPlayerForm({ ...playerForm, playerFocus: e.target.value })}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                >
                  <option value="">None specified</option>
                  {validFocusesForRole.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-[12px] text-[#9AA4B4] mb-1">Manager Notes</label>
                <input
                  type="text"
                  value={playerForm.notes}
                  onChange={(e) => setPlayerForm({ ...playerForm, notes: e.target.value })}
                  placeholder="Development plan, captaincy, loan recall clause..."
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/[0.08]">
              <button
                type="button"
                onClick={() => setShowPlayerModal(false)}
                className="px-4 py-2 rounded-md border border-white/[0.12] text-[#C5CCD7] text-[13px]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[13px] font-medium"
              >
                {editingPlayerId ? 'Save Squad Player' : 'Add to Career Squad'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md border border-red-500/35 bg-[#12151B] rounded-lg p-5 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-[13px] text-[#D7DDE7]">
                <div className="font-semibold text-white">
                  Remove {resolvePlayerDisplayName(deleteTarget)} from Career Squad?
                </div>
                <p className="mt-1 text-[#9AA4B4]">
                  This removes the player from {activeClub.name}&apos;s Career Mode roster. Historical
                  match tactical snapshots and the master FC26 reference database remain intact.
                </p>
              </div>
            </div>
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
                onClick={() => void handleConfirmDeletePlayer()}
                className="px-3.5 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-[13px] font-medium"
              >
                Remove Player
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
