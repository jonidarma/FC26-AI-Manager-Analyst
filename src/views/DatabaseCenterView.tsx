import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  RefreshCw,
  RotateCcw,
  Search,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SortableTh } from '../components/common/SortableTh';
import { TacticalPitchSVG } from '../components/pitch/TacticalPitchSVG';
import { useApp } from '../context/AppContext';
import { type SortDirection, useTableSort } from '../hooks/useTableSort';
import { desktopBridge } from '../services/desktopBridge';
import { hasDistinctFullName, resolvePlayerDisplayName } from '../utils/playerDisplayName';
import type {
  CatalogClub,
  CatalogCompatibilityRow,
  CatalogDatasetType,
  CatalogFocus,
  CatalogFormation,
  CatalogImportRun,
  CatalogLeague,
  CatalogNation,
  CatalogOverview,
  CatalogPlayer,
  CatalogPosition,
  CatalogRole,
  DatasetCompleteness,
  ImportPreviewResult,
  PaginatedResult,
} from '../types/domain';

type DatabaseTab =
  | 'overview'
  | 'players'
  | 'clubs'
  | 'leagues'
  | 'nations'
  | 'formations'
  | 'positions'
  | 'roles'
  | 'focuses'
  | 'imports';

type PlayerServerSortKey =
  | 'overall'
  | 'potential'
  | 'growth'
  | 'age'
  | 'name'
  | 'pace'
  | 'market_value'
  | 'position'
  | 'club';

type ClubServerSortKey = 'name' | 'code' | 'category' | 'league' | 'nation' | 'players';
type CompletenessSortKey = 'dataset' | 'records' | 'status';
type LeagueSortKey = 'league' | 'country' | 'tier' | 'category' | 'clubs' | 'players';
type NationSortKey = 'displayName' | 'sourceName' | 'iso' | 'region' | 'leagues' | 'clubs';
type PositionSortKey = 'code' | 'label' | 'category' | 'tacticalLine' | 'roles';
type CompatSortKey = 'position' | 'role' | 'focus' | 'evidence';
type SamplePreviewSortKey =
  | 'externalId'
  | 'fullName'
  | 'position'
  | 'clubNation'
  | 'overall'
  | 'value'
  | 'extAttrs';
type ImportRunSortKey = 'dataset' | 'file' | 'status' | 'counts' | 'checksum' | 'timestamp';

const PLAYER_SORT_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'overall:desc', label: 'OVR High → Low' },
  { value: 'potential:desc', label: 'POT High → Low' },
  { value: 'growth:desc', label: 'Growth High → Low' },
  { value: 'age:asc', label: 'Age Youngest' },
  { value: 'pace:desc', label: 'Pace High → Low' },
  { value: 'market_value:desc', label: 'Value High → Low' },
  { value: 'name:asc', label: 'Name A → Z' },
];

const PLAYER_SORT_FIELD_LABELS: Record<PlayerServerSortKey, string> = {
  overall: 'OVR',
  potential: 'POT',
  growth: 'Growth',
  age: 'Age',
  name: 'Player',
  pace: 'Pace',
  market_value: 'Value',
  position: 'Pos',
  club: 'Club',
};

const TABS: Array<{ id: DatabaseTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'players', label: 'Players' },
  { id: 'clubs', label: 'Clubs' },
  { id: 'leagues', label: 'Leagues' },
  { id: 'nations', label: 'Nations' },
  { id: 'formations', label: 'Formations' },
  { id: 'positions', label: 'Positions' },
  { id: 'roles', label: 'Player Roles' },
  { id: 'focuses', label: 'Player Focuses' },
  { id: 'imports', label: 'Import & History' },
];

const COMPLETENESS_LABEL: Record<DatasetCompleteness, { text: string; tone: string }> = {
  verified_complete: { text: 'Verified Complete', tone: 'text-emerald-400' },
  user_imported: { text: 'User Imported', tone: 'text-emerald-300' },
  partial_baseline: { text: 'Partial Baseline', tone: 'text-amber-300' },
  empty_awaiting_user_import: { text: 'Empty — Import Required', tone: 'text-amber-400' },
};

const ALL_POSITIONS = [
  'GK',
  'CB',
  'LB',
  'RB',
  'LWB',
  'RWB',
  'CDM',
  'CM',
  'CAM',
  'LM',
  'RM',
  'LW',
  'RW',
  'CF',
  'ST',
];

function formatEur(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_000_000) return `€${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `€${Math.round(value / 1_000)}K`;
  return `€${value}`;
}

export function DatabaseCenterView() {
  const { activeClub, notify, refreshAll } = useApp();
  const [activeTab, setActiveTab] = useState<DatabaseTab>('overview');

  const [overview, setOverview] = useState<CatalogOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);

  // Reference lists reused across filters
  const [nations, setNations] = useState<CatalogNation[]>([]);
  const [leagues, setLeagues] = useState<CatalogLeague[]>([]);
  const [positions, setPositions] = useState<CatalogPosition[]>([]);
  const [formations, setFormations] = useState<CatalogFormation[]>([]);
  const [roles, setRoles] = useState<CatalogRole[]>([]);
  const [focuses, setFocuses] = useState<CatalogFocus[]>([]);
  const [compatMatrix, setCompatMatrix] = useState<CatalogCompatibilityRow[]>([]);
  const [importRuns, setImportRuns] = useState<CatalogImportRun[]>([]);

  // Players tab state
  const [playerQuery, setPlayerQuery] = useState('');
  const [playerPositions, setPlayerPositions] = useState<string[]>([]);
  const [playerLeagueId, setPlayerLeagueId] = useState('');
  const [playerNationId, setPlayerNationId] = useState('');
  const [playerMinOvr, setPlayerMinOvr] = useState('');
  const [playerMaxOvr, setPlayerMaxOvr] = useState('');
  const [playerMinPot, setPlayerMinPot] = useState('');
  const [playerMaxAge, setPlayerMaxAge] = useState('');
  const [playerFoot, setPlayerFoot] = useState<'' | 'Right' | 'Left' | 'Both'>('');
  const [playerSortBy, setPlayerSortBy] = useState<PlayerServerSortKey>('overall');
  const [playerSortDir, setPlayerSortDir] = useState<SortDirection>('desc');
  const [playerPage, setPlayerPage] = useState(1);
  const [playerResults, setPlayerResults] = useState<PaginatedResult<CatalogPlayer>>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
    totalPages: 1,
  });
  const [selectedPlayer, setSelectedPlayer] = useState<CatalogPlayer | null>(null);
  const [loadingPlayers, setLoadingPlayers] = useState(false);

  // Clubs tab state
  const [clubQuery, setClubQuery] = useState('');
  const [clubLeagueId, setClubLeagueId] = useState('');
  const [clubCategory, setClubCategory] = useState<'' | 'mens' | 'womens'>('');
  const [clubSortBy, setClubSortBy] = useState<ClubServerSortKey>('name');
  const [clubSortDir, setClubSortDir] = useState<SortDirection>('asc');
  const [clubPage, setClubPage] = useState(1);
  const [clubResults, setClubResults] = useState<PaginatedResult<CatalogClub>>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 30,
    totalPages: 1,
  });

  // Leagues & Nations filters
  const [leagueQuery, setLeagueQuery] = useState('');
  const [leagueCategory, setLeagueCategory] = useState('');
  const [nationQuery, setNationQuery] = useState('');
  const [nationRegion, setNationRegion] = useState('');

  // Formations tab state
  const [formationQuery, setFormationQuery] = useState('');
  const [formationCategory, setFormationCategory] = useState('');
  const [selectedFormationId, setSelectedFormationId] = useState<string>('');

  // Roles & Focuses filters
  const [rolePosFilter, setRolePosFilter] = useState('');
  const [roleFc26NewOnly, setRoleFc26NewOnly] = useState(false);
  const [compatPosFilter, setCompatPosFilter] = useState('');
  const [compatRoleFilter, setCompatRoleFilter] = useState('');

  // Import panel state
  const [importDatasetType, setImportDatasetType] = useState<CatalogDatasetType>('players');
  const [importFormat, setImportFormat] = useState<'csv' | 'json'>('csv');
  const [importMode, setImportMode] = useState<'upsert' | 'insert_only'>('upsert');
  const [importFileName, setImportFileName] = useState('');
  const [importRawContent, setImportRawContent] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null);
  const [importing, setImporting] = useState(false);

  const loadCoreCatalogs = useCallback(async () => {
    setLoadingOverview(true);
    try {
      const [ov, nat, lgs, pos, forms, rls, fcs, compat, runs] = await Promise.all([
        desktopBridge.getCatalogOverview(),
        desktopBridge.listCatalogNations(),
        desktopBridge.listCatalogLeagues(),
        desktopBridge.listCatalogPositions(),
        desktopBridge.listCatalogFormations(),
        desktopBridge.listCatalogRoles(),
        desktopBridge.listCatalogFocuses(),
        desktopBridge.getRoleFocusCompatibility(),
        desktopBridge.listCatalogImportRuns(),
      ]);
      setOverview(ov);
      setNations(nat);
      setLeagues(lgs);
      setPositions(pos);
      setFormations(forms);
      setRoles(rls);
      setFocuses(fcs);
      setCompatMatrix(compat);
      setImportRuns(runs);
      if (forms.length > 0) {
        setSelectedFormationId((prev) => prev || forms[0].id);
      }
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to load FC26 Database Center');
    } finally {
      setLoadingOverview(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadCoreCatalogs();
  }, [loadCoreCatalogs]);

  const loadPlayers = useCallback(async () => {
    setLoadingPlayers(true);
    try {
      const res = await desktopBridge.searchCatalogPlayers({
        q: playerQuery || undefined,
        positions: playerPositions.length > 0 ? playerPositions : undefined,
        leagueId: playerLeagueId || undefined,
        nationId: playerNationId || undefined,
        minOvr: playerMinOvr ? Number(playerMinOvr) : undefined,
        maxOvr: playerMaxOvr ? Number(playerMaxOvr) : undefined,
        minPot: playerMinPot ? Number(playerMinPot) : undefined,
        maxAge: playerMaxAge ? Number(playerMaxAge) : undefined,
        preferredFoot: playerFoot || undefined,
        sortBy: playerSortBy,
        sortDir: playerSortDir,
        page: playerPage,
        pageSize: 25,
      });
      setPlayerResults(res);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to search players');
    } finally {
      setLoadingPlayers(false);
    }
  }, [
    playerQuery,
    playerPositions,
    playerLeagueId,
    playerNationId,
    playerMinOvr,
    playerMaxOvr,
    playerMinPot,
    playerMaxAge,
    playerFoot,
    playerSortBy,
    playerSortDir,
    playerPage,
    notify,
  ]);

  useEffect(() => {
    if (activeTab === 'players') {
      void loadPlayers();
    }
  }, [activeTab, loadPlayers]);

  const loadClubs = useCallback(async () => {
    try {
      const res = await desktopBridge.searchCatalogClubs({
        q: clubQuery || undefined,
        leagueId: clubLeagueId || undefined,
        teamCategory: clubCategory || undefined,
        sortBy: clubSortBy,
        sortDir: clubSortDir,
        page: clubPage,
        pageSize: 30,
      });
      setClubResults(res);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to search clubs');
    }
  }, [clubQuery, clubLeagueId, clubCategory, clubSortBy, clubSortDir, clubPage, notify]);

  useEffect(() => {
    if (activeTab === 'clubs') {
      void loadClubs();
    }
  }, [activeTab, loadClubs]);

  function handlePlayerHeaderSort(key: PlayerServerSortKey, defaultDir: SortDirection = 'asc') {
    if (playerSortBy === key) {
      setPlayerSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setPlayerSortBy(key);
      setPlayerSortDir(defaultDir);
    }
    setPlayerPage(1);
  }

  function handleClubHeaderSort(key: ClubServerSortKey, defaultDir: SortDirection = 'asc') {
    if (clubSortBy === key) {
      setClubSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setClubSortBy(key);
      setClubSortDir(defaultDir);
    }
    setClubPage(1);
  }

  function togglePlayerPos(pos: string) {
    setPlayerPage(1);
    setPlayerPositions((prev) =>
      prev.includes(pos) ? prev.filter((p) => p !== pos) : [...prev, pos]
    );
  }

  async function handleImportPlayerToSquad(player: CatalogPlayer) {
    if (!activeClub) {
      notify('error', 'Create or activate a Career Mode club before importing players into a squad.');
      return;
    }
    try {
      await desktopBridge.importPlayerFromCatalog(activeClub.id, {
        catalogPlayerId: player.id,
      });
      await refreshAll();
      notify('success', `Imported ${player.fullName} into ${activeClub.name} Career Mode squad.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to import player to squad');
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImportFileName(file.name);
    setImportRawContent(text);
    setImportFormat(file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv');
    setImportPreview(null);
  }

  async function handlePreviewImport() {
    if (!importRawContent.trim()) {
      notify('error', 'Select a CSV/JSON file or paste dataset content first.');
      return;
    }
    setImporting(true);
    try {
      const preview = await desktopBridge.previewCatalogImport({
        datasetType: importDatasetType,
        format: importFormat,
        rawContent: importRawContent,
      });
      setImportPreview(preview);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to preview import');
    } finally {
      setImporting(false);
    }
  }

  async function handleExecuteImport() {
    if (!importRawContent.trim()) return;
    setImporting(true);
    try {
      const { run } = await desktopBridge.executeCatalogImport({
        datasetType: importDatasetType,
        format: importFormat,
        rawContent: importRawContent,
        fileName: importFileName || `${importDatasetType}.${importFormat}`,
        sourceKey: importPreview?.schemaDiagnostics?.detectedSourceKey ?? undefined,
        completeness: 'user_imported',
        mode: importMode,
      });
      notify(
        'success',
        `Imported ${run.datasetType}: ${run.insertedCount} inserted, ${run.updatedCount} updated, ${run.rejectedCount} rejected.`
      );
      setImportPreview(null);
      setImportRawContent('');
      setImportFileName('');
      await loadCoreCatalogs();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Import execution failed');
    } finally {
      setImporting(false);
    }
  }

  async function handleRollbackRun(runId: string) {
    try {
      const res = await desktopBridge.rollbackCatalogImportRun(runId);
      notify('info', `Rolled back import run (${res.deletedRows} rows removed).`);
      await loadCoreCatalogs();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Rollback failed');
    }
  }

  async function handleExportDataset(datasetType: CatalogDatasetType) {
    try {
      const blob = await desktopBridge.exportCatalogDataset(datasetType);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fc26-catalog-${datasetType}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify('success', `Exported ${datasetType} catalog snapshot.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Export failed');
    }
  }

  const filteredFormations = formations.filter((f) => {
    const matchQ =
      !formationQuery.trim() ||
      f.name.toLowerCase().includes(formationQuery.toLowerCase()) ||
      f.code.toLowerCase().includes(formationQuery.toLowerCase()) ||
      f.tacticalSummary.toLowerCase().includes(formationQuery.toLowerCase());
    const matchCat = !formationCategory || f.category === formationCategory;
    return matchQ && matchCat;
  });

  const selectedFormation =
    filteredFormations.find((f) => f.id === selectedFormationId) ?? filteredFormations[0] ?? null;

  const filteredLeagues = useMemo(
    () =>
      leagues.filter((l) => {
        const matchQ =
          !leagueQuery.trim() ||
          l.name.toLowerCase().includes(leagueQuery.toLowerCase()) ||
          l.countryName.toLowerCase().includes(leagueQuery.toLowerCase());
        const matchCat = !leagueCategory || l.category === leagueCategory;
        return matchQ && matchCat;
      }),
    [leagues, leagueQuery, leagueCategory]
  );

  const filteredNations = useMemo(
    () =>
      nations.filter((n) => {
        const matchQ =
          !nationQuery.trim() ||
          n.displayName.toLowerCase().includes(nationQuery.toLowerCase()) ||
          n.sourceName.toLowerCase().includes(nationQuery.toLowerCase()) ||
          n.isoCode.toLowerCase().includes(nationQuery.toLowerCase());
        const matchReg = !nationRegion || n.region === nationRegion;
        return matchQ && matchReg;
      }),
    [nations, nationQuery, nationRegion]
  );

  const filteredRoles = roles.filter((r) => {
    const matchPos = !rolePosFilter || r.eligiblePositions.includes(rolePosFilter);
    const matchNew = !roleFc26NewOnly || r.isFc26New;
    return matchPos && matchNew;
  });

  const filteredCompat = useMemo(
    () =>
      compatMatrix.filter((row) => {
        const matchPos = !compatPosFilter || row.positionCode === compatPosFilter;
        const matchRole = !compatRoleFilter || row.roleName === compatRoleFilter;
        return matchPos && matchRole;
      }),
    [compatMatrix, compatPosFilter, compatRoleFilter]
  );

  // Table 6a: Catalog Completeness rows
  const completenessRows = useMemo(() => {
    if (!overview) return [];
    const items: Array<{
      key: keyof CatalogOverview['completeness'];
      label: string;
      count: number;
      statusText: string;
      tone: string;
    }> = (
      [
        ['positions', 'Player Positions', overview.counts.positions],
        ['roles', 'FC IQ Player Roles', overview.counts.roles],
        ['focuses', 'FC IQ Player Focuses', overview.counts.focuses],
        ['formations', 'Tactical Formations', overview.counts.formations],
        ['nations', 'Nations', overview.counts.nations],
        ['leagues', 'Leagues', overview.counts.leagues],
        ['clubs', 'Clubs (Men & Women)', overview.counts.clubs],
        ['players', 'Career Mode Players', overview.counts.players],
      ] as Array<[keyof CatalogOverview['completeness'], string, number]>
    ).map(([key, label, count]) => ({
      key,
      label,
      count,
      statusText: COMPLETENESS_LABEL[overview.completeness[key]].text,
      tone: COMPLETENESS_LABEL[overview.completeness[key]].tone,
    }));
    return items;
  }, [overview]);

  const completenessAccessors = useMemo<
    Record<CompletenessSortKey, (row: (typeof completenessRows)[number]) => string | number | null>
  >(
    () => ({
      dataset: (r) => r.label,
      records: (r) => r.count,
      status: (r) => r.statusText,
    }),
    []
  );
  const {
    sortedRows: sortedCompletenessRows,
    sortKey: completenessSortKey,
    sortDir: completenessSortDir,
    toggleSort: toggleCompletenessSort,
  } = useTableSort(completenessRows, completenessAccessors);

  // Table 6d: Leagues
  const leagueAccessors = useMemo<
    Record<LeagueSortKey, (l: CatalogLeague) => string | number | null>
  >(
    () => ({
      league: (l) => l.name,
      country: (l) => l.countryName || null,
      tier: (l) => l.tier,
      category: (l) => (l.category === 'womens' ? "Women's" : "Men's"),
      clubs: (l) => l.clubCount ?? 0,
      players: (l) => l.playerCount ?? 0,
    }),
    []
  );
  const {
    sortedRows: sortedLeagues,
    sortKey: leagueSortKey,
    sortDir: leagueSortDir,
    toggleSort: toggleLeagueSort,
  } = useTableSort(filteredLeagues, leagueAccessors);

  // Table 6e: Nations
  const nationAccessors = useMemo<
    Record<NationSortKey, (n: CatalogNation) => string | number | null>
  >(
    () => ({
      displayName: (n) => n.displayName,
      sourceName: (n) => n.sourceName,
      iso: (n) => n.isoCode || null,
      region: (n) => n.region || null,
      leagues: (n) => n.leagueCount ?? 0,
      clubs: (n) => n.clubCount ?? 0,
    }),
    []
  );
  const {
    sortedRows: sortedNations,
    sortKey: nationSortKey,
    sortDir: nationSortDir,
    toggleSort: toggleNationSort,
  } = useTableSort(filteredNations, nationAccessors);

  // Table 6f: Positions
  const positionsWithRoles = useMemo(
    () =>
      positions.map((pos) => ({
        ...pos,
        posRoles: roles
          .filter((r) => r.eligiblePositions.includes(pos.code))
          .map((r) => r.name),
      })),
    [positions, roles]
  );
  const positionAccessors = useMemo<
    Record<PositionSortKey, (pos: (typeof positionsWithRoles)[number]) => string | number | null>
  >(
    () => ({
      code: (p) => p.code,
      label: (p) => p.label,
      category: (p) => p.category,
      tacticalLine: (p) => p.tacticalLine,
      roles: (p) => p.posRoles.length,
    }),
    []
  );
  const {
    sortedRows: sortedPositions,
    sortKey: positionSortKey,
    sortDir: positionSortDir,
    toggleSort: togglePositionSort,
  } = useTableSort(positionsWithRoles, positionAccessors);

  // Table 6g: Role & Focus Compatibility Matrix
  const compatAccessors = useMemo<
    Record<CompatSortKey, (row: CatalogCompatibilityRow) => string | number | null>
  >(
    () => ({
      position: (r) => r.positionCode,
      role: (r) => r.roleName,
      focus: (r) => r.focusName,
      evidence: (r) => r.evidence,
    }),
    []
  );
  const {
    sortedRows: sortedCompat,
    sortKey: compatSortKey,
    sortDir: compatSortDir,
    toggleSort: toggleCompatSort,
  } = useTableSort(filteredCompat, compatAccessors);

  // Table 6h: Normalized Sample Players Preview
  const samplePreviewRows = useMemo(
    () =>
      importPreview?.datasetType === 'players' ? importPreview.sampleRows.slice(0, 8) : [],
    [importPreview]
  );
  const samplePreviewAccessors = useMemo<
    Record<SamplePreviewSortKey, (row: Record<string, unknown>) => string | number | null>
  >(
    () => ({
      externalId: (row) => String(row.externalSourceId ?? ''),
      fullName: (row) => String(row.fullName ?? ''),
      position: (row) => String(row.primaryPosition ?? ''),
      clubNation: (row) => String(row.clubNameRaw || row.nationNameRaw || ''),
      overall: (row) => (typeof row.overallRating === 'number' ? row.overallRating : null),
      value: (row) => (typeof row.marketValueEur === 'number' ? row.marketValueEur : null),
      extAttrs: (row) =>
        typeof row.extendedAttributeCount === 'number' ? row.extendedAttributeCount : 0,
    }),
    []
  );
  const {
    sortedRows: sortedSamplePreviewRows,
    sortKey: samplePreviewSortKey,
    sortDir: samplePreviewSortDir,
    toggleSort: toggleSamplePreviewSort,
  } = useTableSort(samplePreviewRows, samplePreviewAccessors);

  // Table 6i: Import & Update History
  const importRunAccessors = useMemo<
    Record<ImportRunSortKey, (run: CatalogImportRun) => string | number | null>
  >(
    () => ({
      dataset: (r) => r.datasetType,
      file: (r) => r.fileName,
      status: (r) => r.status,
      counts: (r) => r.insertedCount + r.updatedCount,
      checksum: (r) => r.checksum,
      timestamp: (r) => r.startedAt,
    }),
    []
  );
  const {
    sortedRows: sortedImportRuns,
    sortKey: importRunSortKey,
    sortDir: importRunSortDir,
    toggleSort: toggleImportRunSort,
  } = useTableSort(importRuns, importRunAccessors, { key: 'timestamp', dir: 'desc' });

  const playerSortPresetKey = `${playerSortBy}:${playerSortDir}`;
  const isCustomPlayerSort = !PLAYER_SORT_PRESETS.some((p) => p.value === playerSortPresetKey);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-white">
            FC26 Master Data & Tactical Database
          </h1>
          <p className="text-[13px] text-[#8A94A6] mt-1">
            Structured EA SPORTS FC 26 reference catalogs for Career Mode scouting, verified FC IQ Role-Focus compatibility, and batch CSV/JSON dataset maintenance.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadCoreCatalogs()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-white/[0.1] bg-[#141820] hover:bg-[#1A1F2A] text-[13px] text-[#D7DFEA] transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingOverview ? 'animate-spin' : ''}`} />
          Refresh Catalogs
        </button>
      </div>

      {/* Horizontal Tab Bar */}
      <div className="border-b border-white/[0.08] flex items-center gap-1 overflow-x-auto">
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors ${
                active
                  ? 'border-emerald-500 text-white'
                  : 'border-transparent text-[#8A94A6] hover:text-[#D5DCE6]'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: OVERVIEW */}
      {activeTab === 'overview' && overview && (
        <div className="space-y-6">
          {/* Primary Metric Strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4">
              <div className="text-[12px] text-[#8A94A6]">Players Indexed</div>
              <div className="text-[24px] font-bold text-white font-mono tabular-nums mt-1">
                {overview.counts.players.toLocaleString()}
              </div>
              <div className={`text-[12px] mt-1 ${COMPLETENESS_LABEL[overview.completeness.players].tone}`}>
                {COMPLETENESS_LABEL[overview.completeness.players].text}
              </div>
            </div>
            <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4">
              <div className="text-[12px] text-[#8A94A6]">Clubs (Men&apos;s · Women&apos;s)</div>
              <div className="text-[24px] font-bold text-white font-mono tabular-nums mt-1">
                {overview.counts.clubs.toLocaleString()}
              </div>
              <div className="text-[12px] text-[#8A94A6] mt-1 font-mono tabular-nums">
                {overview.counts.mensClubs} Men&apos;s · {overview.counts.womensClubs} Women&apos;s
              </div>
            </div>
            <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4">
              <div className="text-[12px] text-[#8A94A6]">Formations &amp; Positions</div>
              <div className="text-[24px] font-bold text-white font-mono tabular-nums mt-1">
                {overview.counts.formations} · {overview.counts.positions}
              </div>
              <div className="text-[12px] text-emerald-400 mt-1">
                {COMPLETENESS_LABEL[overview.completeness.formations].text}
              </div>
            </div>
            <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4">
              <div className="text-[12px] text-[#8A94A6]">FC IQ Roles · Focus Rules</div>
              <div className="text-[24px] font-bold text-white font-mono tabular-nums mt-1">
                {overview.counts.roles} · {overview.counts.roleFocusPairs}
              </div>
              <div className="text-[12px] text-emerald-400 mt-1">
                {overview.counts.focuses} Focuses · Schema v{overview.schemaVersion}
              </div>
            </div>
          </div>

          {/* Honest Completeness & Warnings */}
          {overview.warnings.length > 0 && (
            <div className="bg-[#161510] border border-amber-500/30 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Dataset Completeness Notice
              </div>
              <ul className="space-y-1.5 text-[13px] text-[#D8CFAF]">
                {overview.warnings.map((w, idx) => (
                  <li key={idx}>• {w}</li>
                ))}
              </ul>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setActiveTab('imports')}
                  className="text-[13px] font-medium text-emerald-400 hover:text-emerald-300"
                >
                  Open Import &amp; Update History to upload CSV/JSON datasets →
                </button>
              </div>
            </div>
          )}

          {/* Dataset Completeness Matrix */}
          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-white">Catalog Completeness Status</h2>
              <span className="text-[12px] text-[#8A94A6] font-mono tabular-nums">
                Last import: {overview.lastImportAt ? new Date(overview.lastImportAt).toLocaleString() : 'None'}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-[#161A22] text-[#8A94A6] border-b border-white/[0.08]">
                  <tr>
                    <SortableTh
                      label="Dataset"
                      columnKey="dataset"
                      activeKey={completenessSortKey}
                      direction={completenessSortDir}
                      onSort={toggleCompletenessSort}
                      className="px-5 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="Records"
                      columnKey="records"
                      activeKey={completenessSortKey}
                      direction={completenessSortDir}
                      onSort={toggleCompletenessSort}
                      defaultDir="desc"
                      className="px-5 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="Status"
                      columnKey="status"
                      activeKey={completenessSortKey}
                      direction={completenessSortDir}
                      onSort={toggleCompletenessSort}
                      className="px-5 py-2.5 font-medium"
                    />
                    <th className="px-5 py-2.5 font-medium text-right">Export</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {sortedCompletenessRows.map((row) => (
                    <tr key={row.key} className="hover:bg-white/[0.02]">
                      <td className="px-5 py-2.5 font-medium text-white">{row.label}</td>
                      <td className="px-5 py-2.5 font-mono tabular-nums text-[#D0D7E2]">
                        {row.count.toLocaleString()}
                      </td>
                      <td className={`px-5 py-2.5 font-medium ${row.tone}`}>{row.statusText}</td>
                      <td className="px-5 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => void handleExportDataset(row.key)}
                          className="inline-flex items-center gap-1 text-[12px] text-[#9AA4B4] hover:text-white"
                        >
                          <Download className="w-3.5 h-3.5" />
                          JSON
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Authoritative Data Sources */}
          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/[0.08]">
              <h2 className="text-[14px] font-semibold text-white">
                Authoritative Reference Sources &amp; Provenance
              </h2>
            </div>
            <div className="divide-y divide-white/[0.06]">
              {overview.sources.map((src) => (
                <div key={src.id} className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <div className="text-[13px] font-medium text-white">{src.name}</div>
                    <div className="text-[12px] text-[#8A94A6] mt-0.5">{src.licenseNotes}</div>
                  </div>
                  <div className="text-[12px] font-mono text-emerald-400/90 shrink-0 break-all">
                    {src.url}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PLAYERS */}
      {activeTab === 'players' && (
        <div className="space-y-4">
          {/* Search & Filters */}
          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="relative md:col-span-2">
                <Search className="w-4 h-4 text-[#6F798A] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={playerQuery}
                  onChange={(e) => {
                    setPlayerQuery(e.target.value);
                    setPlayerPage(1);
                  }}
                  placeholder="Search player name or club..."
                  className="w-full pl-9 pr-3 py-2 bg-[#171B22] border border-white/[0.1] rounded-md text-[13px] text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <select
                value={playerLeagueId}
                onChange={(e) => {
                  setPlayerLeagueId(e.target.value);
                  setPlayerPage(1);
                }}
                className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
              >
                <option value="">All Leagues</option>
                {leagues.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>

              <select
                value={playerNationId}
                onChange={(e) => {
                  setPlayerNationId(e.target.value);
                  setPlayerPage(1);
                }}
                className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
              >
                <option value="">All Nations</option>
                {nations.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
              <input
                type="number"
                min={1}
                max={99}
                value={playerMinOvr}
                onChange={(e) => {
                  setPlayerMinOvr(e.target.value);
                  setPlayerPage(1);
                }}
                placeholder="Min OVR"
                className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-1.5 text-[13px] text-white font-mono"
              />
              <input
                type="number"
                min={1}
                max={99}
                value={playerMaxOvr}
                onChange={(e) => {
                  setPlayerMaxOvr(e.target.value);
                  setPlayerPage(1);
                }}
                placeholder="Max OVR"
                className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-1.5 text-[13px] text-white font-mono"
              />
              <input
                type="number"
                min={1}
                max={99}
                value={playerMinPot}
                onChange={(e) => {
                  setPlayerMinPot(e.target.value);
                  setPlayerPage(1);
                }}
                placeholder="Min POT"
                className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-1.5 text-[13px] text-white font-mono"
              />
              <input
                type="number"
                min={15}
                max={50}
                value={playerMaxAge}
                onChange={(e) => {
                  setPlayerMaxAge(e.target.value);
                  setPlayerPage(1);
                }}
                placeholder="Max Age"
                className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-1.5 text-[13px] text-white font-mono"
              />
              <select
                value={playerFoot}
                onChange={(e) => {
                  setPlayerFoot(e.target.value as '' | 'Right' | 'Left' | 'Both');
                  setPlayerPage(1);
                }}
                className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-1.5 text-[13px] text-white"
              >
                <option value="">Any Foot</option>
                <option value="Right">Right</option>
                <option value="Left">Left</option>
                <option value="Both">Both</option>
              </select>
              <select
                value={playerSortPresetKey}
                onChange={(e) => {
                  const [sb, sd] = e.target.value.split(':');
                  setPlayerSortBy(sb as PlayerServerSortKey);
                  setPlayerSortDir(sd as SortDirection);
                  setPlayerPage(1);
                }}
                className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-1.5 text-[13px] text-white"
              >
                {PLAYER_SORT_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
                {isCustomPlayerSort && (
                  <option value={playerSortPresetKey}>
                    {PLAYER_SORT_FIELD_LABELS[playerSortBy]}{' '}
                    {playerSortDir === 'asc' ? 'Asc ↑' : 'Desc ↓'}
                  </option>
                )}
              </select>
            </div>

            {/* Position multi-filter */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-[12px] text-[#8A94A6] mr-1">Positions:</span>
              {ALL_POSITIONS.map((pos) => {
                const selected = playerPositions.includes(pos);
                return (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => togglePlayerPos(pos)}
                    className={`px-2 py-1 text-[11px] font-mono rounded border transition-colors ${
                      selected
                        ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                        : 'bg-[#171B22] border-white/[0.08] text-[#9AA4B4] hover:text-white'
                    }`}
                  >
                    {pos}
                  </button>
                );
              })}
              {playerPositions.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setPlayerPositions([]);
                    setPlayerPage(1);
                  }}
                  className="text-[12px] text-[#8A94A6] hover:text-white ml-2"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Results Table + Detail Inspector */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div
              className={`${selectedPlayer ? 'lg:col-span-8' : 'lg:col-span-12'} bg-[#12151B] border border-white/[0.08] rounded-lg overflow-hidden`}
            >
              <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between text-[12px] text-[#8A94A6]">
                <span className="font-mono tabular-nums">
                  {loadingPlayers
                    ? 'Querying SQLite index...'
                    : `${playerResults.total.toLocaleString()} matching player(s)`}
                </span>
                <span className="font-mono tabular-nums">
                  Page {playerResults.page} of {playerResults.totalPages}
                </span>
              </div>

              {playerResults.items.length === 0 ? (
                <div className="p-8 text-center space-y-2">
                  <Database className="w-7 h-7 text-[#4E5869] mx-auto" />
                  <div className="text-[14px] font-medium text-white">
                    {overview?.counts.players === 0
                      ? 'No FC 26 Player Dataset Imported Yet'
                      : 'No Players Match Current Filters'}
                  </div>
                  <p className="text-[13px] text-[#8A94A6] max-w-md mx-auto">
                    {overview?.counts.players === 0
                      ? 'The player table starts honestly empty with zero fabricated records. Upload your FC 26 Career Mode CSV or JSON export in Import & History.'
                      : 'Relax rating, age, or position filters to broaden the query.'}
                  </p>
                  {overview?.counts.players === 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('imports')}
                      className="mt-2 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Import Players CSV / JSON
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[13px]">
                      <thead className="bg-[#161A22] text-[#8A94A6] border-b border-white/[0.08]">
                        <tr>
                          <SortableTh
                            label="Player"
                            columnKey="name"
                            activeKey={playerSortBy}
                            direction={playerSortDir}
                            onSort={handlePlayerHeaderSort}
                            className="px-4 py-2.5 font-medium"
                          />
                          <SortableTh
                            label="Pos"
                            columnKey="position"
                            activeKey={playerSortBy}
                            direction={playerSortDir}
                            onSort={handlePlayerHeaderSort}
                            className="px-3 py-2.5 font-medium"
                          />
                          <SortableTh
                            label="Club"
                            columnKey="club"
                            activeKey={playerSortBy}
                            direction={playerSortDir}
                            onSort={handlePlayerHeaderSort}
                            className="px-3 py-2.5 font-medium"
                          />
                          <SortableTh
                            label="Age"
                            columnKey="age"
                            activeKey={playerSortBy}
                            direction={playerSortDir}
                            onSort={handlePlayerHeaderSort}
                            align="right"
                            className="px-3 py-2.5 font-medium"
                          />
                          <SortableTh
                            label="OVR"
                            columnKey="overall"
                            activeKey={playerSortBy}
                            direction={playerSortDir}
                            onSort={handlePlayerHeaderSort}
                            defaultDir="desc"
                            align="right"
                            className="px-3 py-2.5 font-medium"
                          />
                          <SortableTh
                            label="POT"
                            columnKey="potential"
                            activeKey={playerSortBy}
                            direction={playerSortDir}
                            onSort={handlePlayerHeaderSort}
                            defaultDir="desc"
                            align="right"
                            className="px-3 py-2.5 font-medium"
                          />
                          <SortableTh
                            label="Value"
                            columnKey="market_value"
                            activeKey={playerSortBy}
                            direction={playerSortDir}
                            onSort={handlePlayerHeaderSort}
                            defaultDir="desc"
                            align="right"
                            className="px-3 py-2.5 font-medium"
                          />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.06]">
                        {playerResults.items.map((p) => (
                          <tr
                            key={p.id}
                            onClick={() => setSelectedPlayer(p)}
                            className={`cursor-pointer transition-colors ${
                              selectedPlayer?.id === p.id
                                ? 'bg-emerald-500/10'
                                : 'hover:bg-white/[0.03]'
                            }`}
                          >
                            <td className="px-4 py-2.5">
                              {(() => {
                                const displayName = resolvePlayerDisplayName(p);
                                return (
                                  <>
                                    <div className="font-medium text-white" title={p.fullName}>
                                      {displayName}
                                    </div>
                                    <div className="text-[11px] text-[#7D8798]">
                                      {hasDistinctFullName(displayName, p.fullName)
                                        ? `${p.fullName} · `
                                        : ''}
                                      {p.nationName ?? 'Unknown Nation'}
                                      {p.preferredFoot ? ` · ${p.preferredFoot}` : ''}
                                    </div>
                                  </>
                                );
                              })()}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[12px] text-emerald-300">
                              {p.primaryPosition}
                              {p.secondaryPositions.length > 0 && (
                                <span className="text-[#7D8798]">
                                  {' '}
                                  · {p.secondaryPositions.join(', ')}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-[#CBD3DF]">
                              {p.clubName ?? '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#CBD3DF]">
                              {p.age ?? '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold text-white">
                              {p.overallRating ?? '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-emerald-400">
                              {p.potentialRating ?? '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#9AA4B4]">
                              {formatEur(p.marketValueEur)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  <div className="px-4 py-3 border-t border-white/[0.08] flex items-center justify-between text-[12px]">
                    <button
                      type="button"
                      disabled={playerPage <= 1}
                      onClick={() => setPlayerPage((p) => Math.max(1, p - 1))}
                      className="px-3 py-1.5 rounded border border-white/[0.1] disabled:opacity-40 text-white hover:bg-white/[0.04]"
                    >
                      Previous
                    </button>
                    <span className="font-mono text-[#8A94A6]">
                      {playerPage} / {playerResults.totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={playerPage >= playerResults.totalPages}
                      onClick={() => setPlayerPage((p) => Math.min(playerResults.totalPages, p + 1))}
                      className="px-3 py-1.5 rounded border border-white/[0.1] disabled:opacity-40 text-white hover:bg-white/[0.04]"
                    >
                      Next
                    </button>
                  </div>
                </>
              )}
            </div>

            {selectedPlayer && (
              <div className="lg:col-span-4 bg-[#12151B] border border-white/[0.08] rounded-lg p-5 space-y-4 h-fit">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-[16px] font-bold text-white">
                      {resolvePlayerDisplayName(selectedPlayer)}
                    </h3>
                    {hasDistinctFullName(
                      resolvePlayerDisplayName(selectedPlayer),
                      selectedPlayer.fullName
                    ) && (
                      <div className="text-[12px] text-[#A4AEBE]">{selectedPlayer.fullName}</div>
                    )}
                    <div className="text-[12px] text-[#8A94A6] mt-0.5">
                      {selectedPlayer.primaryPosition}
                      {selectedPlayer.secondaryPositions.length > 0
                        ? ` (${selectedPlayer.secondaryPositions.join(', ')})`
                        : ''}{' '}
                      · {selectedPlayer.clubName ?? 'No Club'} · {selectedPlayer.nationName ?? 'Unknown Nation'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedPlayer(null)}
                    className="text-[#8A94A6] hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-[#171B22] rounded p-2.5 border border-white/[0.06]">
                    <div className="text-[11px] text-[#8A94A6]">OVR</div>
                    <div className="text-[18px] font-bold font-mono text-white">
                      {selectedPlayer.overallRating ?? '—'}
                    </div>
                  </div>
                  <div className="bg-[#171B22] rounded p-2.5 border border-white/[0.06]">
                    <div className="text-[11px] text-[#8A94A6]">POT</div>
                    <div className="text-[18px] font-bold font-mono text-emerald-400">
                      {selectedPlayer.potentialRating ?? '—'}
                    </div>
                  </div>
                  <div className="bg-[#171B22] rounded p-2.5 border border-white/[0.06]">
                    <div className="text-[11px] text-[#8A94A6]">AGE</div>
                    <div className="text-[18px] font-bold font-mono text-white">
                      {selectedPlayer.age ?? '—'}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-[12px]">
                  {(
                    [
                      ['PAC', selectedPlayer.pace],
                      ['SHO', selectedPlayer.shooting],
                      ['PAS', selectedPlayer.passing],
                      ['DRI', selectedPlayer.dribbling],
                      ['DEF', selectedPlayer.defending],
                      ['PHY', selectedPlayer.physicality],
                    ] as Array<[string, number | null]>
                  ).map(([stat, val]) => (
                    <div
                      key={stat}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded bg-[#171B22] border border-white/[0.06]"
                    >
                      <span className="text-[#8A94A6] font-mono">{stat}</span>
                      <span className="font-mono font-semibold text-white">{val ?? '—'}</span>
                    </div>
                  ))}
                </div>

                <div className="text-[12px] space-y-1.5 text-[#B4BDCC] border-t border-white/[0.08] pt-3">
                  <div className="flex justify-between">
                    <span className="text-[#8A94A6]">League</span>
                    <span>{selectedPlayer.leagueName ?? '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#8A94A6]">Foot · WF · SM</span>
                    <span className="font-mono">
                      {selectedPlayer.preferredFoot ?? '—'} · {selectedPlayer.weakFoot ?? '—'}★ ·{' '}
                      {selectedPlayer.skillMoves ?? '—'}★
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#8A94A6]">Value · Wage</span>
                    <span className="font-mono">
                      {formatEur(selectedPlayer.marketValueEur)} · {formatEur(selectedPlayer.wageEur)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#8A94A6]">Contract Expiry</span>
                    <span className="font-mono">{selectedPlayer.contractExpiry ?? '—'}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleImportPlayerToSquad(selectedPlayer)}
                  disabled={!activeClub}
                  className="w-full inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[13px] font-medium transition-colors"
                >
                  <UserPlus className="w-4 h-4" />
                  {activeClub ? `Import to ${activeClub.name} Squad` : 'Activate a Club to Import'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: CLUBS */}
      {activeTab === 'clubs' && (
        <div className="space-y-4">
          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="relative md:col-span-2">
              <Search className="w-4 h-4 text-[#6F798A] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={clubQuery}
                onChange={(e) => {
                  setClubQuery(e.target.value);
                  setClubPage(1);
                }}
                placeholder="Search club name (e.g. Arsenal, Barcelona)..."
                className="w-full pl-9 pr-3 py-2 bg-[#171B22] border border-white/[0.1] rounded-md text-[13px] text-white"
              />
            </div>
            <select
              value={clubLeagueId}
              onChange={(e) => {
                setClubLeagueId(e.target.value);
                setClubPage(1);
              }}
              className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            >
              <option value="">All Leagues</option>
              {leagues.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <select
              value={clubCategory}
              onChange={(e) => {
                setClubCategory(e.target.value as '' | 'mens' | 'womens');
                setClubPage(1);
              }}
              className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            >
              <option value="">All Categories (Men&apos;s &amp; Women&apos;s)</option>
              <option value="mens">Men&apos;s Clubs Only</option>
              <option value="womens">Women&apos;s Clubs Only</option>
            </select>
          </div>

          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-white/[0.08] flex justify-between text-[12px] text-[#8A94A6]">
              <span className="font-mono tabular-nums">{clubResults.total} club(s)</span>
              <span>Men&apos;s and women&apos;s clubs are maintained as distinct entities</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-[#161A22] text-[#8A94A6] border-b border-white/[0.08]">
                  <tr>
                    <SortableTh
                      label="Club Name"
                      columnKey="name"
                      activeKey={clubSortBy}
                      direction={clubSortDir}
                      onSort={handleClubHeaderSort}
                      className="px-5 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="Code"
                      columnKey="code"
                      activeKey={clubSortBy}
                      direction={clubSortDir}
                      onSort={handleClubHeaderSort}
                      className="px-4 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="Category"
                      columnKey="category"
                      activeKey={clubSortBy}
                      direction={clubSortDir}
                      onSort={handleClubHeaderSort}
                      className="px-4 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="League"
                      columnKey="league"
                      activeKey={clubSortBy}
                      direction={clubSortDir}
                      onSort={handleClubHeaderSort}
                      className="px-4 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="Nation"
                      columnKey="nation"
                      activeKey={clubSortBy}
                      direction={clubSortDir}
                      onSort={handleClubHeaderSort}
                      className="px-4 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="Indexed Players"
                      columnKey="players"
                      activeKey={clubSortBy}
                      direction={clubSortDir}
                      onSort={handleClubHeaderSort}
                      defaultDir="desc"
                      align="right"
                      className="px-4 py-2.5 font-medium"
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {clubResults.items.map((c) => (
                    <tr key={c.id} className="hover:bg-white/[0.02]">
                      <td className="px-5 py-2.5 font-medium text-white">{c.name}</td>
                      <td className="px-4 py-2.5 font-mono text-[12px] text-[#9AA4B4]">
                        {c.shortName || '—'}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-[#CBD3DF]">
                        {c.teamCategory === 'womens' ? "Women's" : "Men's"}
                      </td>
                      <td className="px-4 py-2.5 text-[#CBD3DF]">{c.leagueName ?? '—'}</td>
                      <td className="px-4 py-2.5 text-[#9AA4B4]">{c.nationName ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#CBD3DF]">
                        {c.playerCount ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: LEAGUES */}
      {activeTab === 'leagues' && (
        <div className="space-y-4">
          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              type="text"
              value={leagueQuery}
              onChange={(e) => setLeagueQuery(e.target.value)}
              placeholder="Search league or country..."
              className="md:col-span-2 bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            />
            <select
              value={leagueCategory}
              onChange={(e) => setLeagueCategory(e.target.value)}
              className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            >
              <option value="">All Categories</option>
              <option value="mens">Men&apos;s Competitions</option>
              <option value="womens">Women&apos;s Competitions</option>
            </select>
          </div>

          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg overflow-hidden">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-[#161A22] text-[#8A94A6] border-b border-white/[0.08]">
                <tr>
                  <SortableTh
                    label="League"
                    columnKey="league"
                    activeKey={leagueSortKey}
                    direction={leagueSortDir}
                    onSort={toggleLeagueSort}
                    className="px-5 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="Country"
                    columnKey="country"
                    activeKey={leagueSortKey}
                    direction={leagueSortDir}
                    onSort={toggleLeagueSort}
                    className="px-4 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="Tier"
                    columnKey="tier"
                    activeKey={leagueSortKey}
                    direction={leagueSortDir}
                    onSort={toggleLeagueSort}
                    className="px-4 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="Category"
                    columnKey="category"
                    activeKey={leagueSortKey}
                    direction={leagueSortDir}
                    onSort={toggleLeagueSort}
                    className="px-4 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="Clubs"
                    columnKey="clubs"
                    activeKey={leagueSortKey}
                    direction={leagueSortDir}
                    onSort={toggleLeagueSort}
                    defaultDir="desc"
                    align="right"
                    className="px-4 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="Players"
                    columnKey="players"
                    activeKey={leagueSortKey}
                    direction={leagueSortDir}
                    onSort={toggleLeagueSort}
                    defaultDir="desc"
                    align="right"
                    className="px-4 py-2.5 font-medium"
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {sortedLeagues.map((l) => (
                  <tr key={l.id} className="hover:bg-white/[0.02]">
                    <td className="px-5 py-2.5 font-medium text-white">{l.name}</td>
                    <td className="px-4 py-2.5 text-[#CBD3DF]">{l.countryName || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-[#9AA4B4]">
                      {l.tier ? `Tier ${l.tier}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-[#CBD3DF]">
                      {l.category === 'womens' ? "Women's" : "Men's"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#CBD3DF]">
                      {l.clubCount ?? 0}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#CBD3DF]">
                      {l.playerCount ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: NATIONS */}
      {activeTab === 'nations' && (
        <div className="space-y-4">
          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              type="text"
              value={nationQuery}
              onChange={(e) => setNationQuery(e.target.value)}
              placeholder="Search nation, source name, or ISO code..."
              className="md:col-span-2 bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            />
            <select
              value={nationRegion}
              onChange={(e) => setNationRegion(e.target.value)}
              className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            >
              <option value="">All Confederations</option>
              <option value="UEFA">UEFA</option>
              <option value="CONMEBOL">CONMEBOL</option>
              <option value="CONCACAF">CONCACAF</option>
              <option value="CAF">CAF</option>
              <option value="AFC">AFC</option>
              <option value="OFC">OFC</option>
            </select>
          </div>

          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg overflow-hidden">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-[#161A22] text-[#8A94A6] border-b border-white/[0.08]">
                <tr>
                  <SortableTh
                    label="Display Name"
                    columnKey="displayName"
                    activeKey={nationSortKey}
                    direction={nationSortDir}
                    onSort={toggleNationSort}
                    className="px-5 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="Source Name"
                    columnKey="sourceName"
                    activeKey={nationSortKey}
                    direction={nationSortDir}
                    onSort={toggleNationSort}
                    className="px-4 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="ISO"
                    columnKey="iso"
                    activeKey={nationSortKey}
                    direction={nationSortDir}
                    onSort={toggleNationSort}
                    className="px-4 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="Confederation"
                    columnKey="region"
                    activeKey={nationSortKey}
                    direction={nationSortDir}
                    onSort={toggleNationSort}
                    className="px-4 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="Leagues"
                    columnKey="leagues"
                    activeKey={nationSortKey}
                    direction={nationSortDir}
                    onSort={toggleNationSort}
                    defaultDir="desc"
                    align="right"
                    className="px-4 py-2.5 font-medium"
                  />
                  <SortableTh
                    label="Clubs"
                    columnKey="clubs"
                    activeKey={nationSortKey}
                    direction={nationSortDir}
                    onSort={toggleNationSort}
                    defaultDir="desc"
                    align="right"
                    className="px-4 py-2.5 font-medium"
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {sortedNations.map((n) => (
                  <tr key={n.id} className="hover:bg-white/[0.02]">
                    <td className="px-5 py-2.5 font-medium text-white">{n.displayName}</td>
                    <td className="px-4 py-2.5 text-[#9AA4B4]">{n.sourceName}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-emerald-300">
                      {n.isoCode || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-[#CBD3DF]">{n.region || '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#CBD3DF]">
                      {n.leagueCount ?? 0}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#CBD3DF]">
                      {n.clubCount ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 6: FORMATIONS */}
      {activeTab === 'formations' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={formationQuery}
                onChange={(e) => setFormationQuery(e.target.value)}
                placeholder="Filter 30 verified FC 26 formations..."
                className="flex-1 bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
              />
              <select
                value={formationCategory}
                onChange={(e) => setFormationCategory(e.target.value)}
                className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
              >
                <option value="">All Shapes</option>
                <option value="Back 3">Back 3</option>
                <option value="Back 4">Back 4</option>
                <option value="Back 5">Back 5</option>
              </select>
            </div>

            <div className="bg-[#12151B] border border-white/[0.08] rounded-lg divide-y divide-white/[0.06] max-h-[560px] overflow-y-auto">
              {filteredFormations.map((f) => {
                const isSelected = selectedFormation?.id === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setSelectedFormationId(f.id)}
                    className={`w-full text-left px-4 py-3 transition-colors ${
                      isSelected ? 'bg-emerald-500/12' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[14px] text-white">{f.name}</span>
                      <span className="text-[11px] font-mono text-[#8A94A6]">
                        {f.category} · {f.careerModeStatus === 'verified' ? 'Career Mode Verified' : f.careerModeStatus}
                      </span>
                    </div>
                    <p className="text-[12px] text-[#9AA4B4] mt-1 line-clamp-2">
                      {f.tacticalSummary}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="lg:col-span-6 bg-[#12151B] border border-white/[0.08] rounded-lg p-5 space-y-4">
            {selectedFormation ? (
              <>
                <div>
                  <h2 className="text-[16px] font-bold text-white">{selectedFormation.name}</h2>
                  <div className="text-[12px] text-[#8A94A6] mt-0.5">
                    Def Shape: {selectedFormation.defensiveShape} · Att Shape:{' '}
                    {selectedFormation.attackingShape} · Modes: {selectedFormation.gameModes.join(', ')}
                  </div>
                </div>
                <TacticalPitchSVG
                  formation={selectedFormation.name}
                  formationSlots={selectedFormation.slots}
                  layoutVerified={selectedFormation.layoutVerified}
                  isUserAdjusted={selectedFormation.isUserAdjusted}
                  showAttackingChannels={false}
                  showDefensiveZones={false}
                  showMovementArrows={false}
                  label={selectedFormation.name}
                />
                <div className="text-[12px] text-[#B4BDCC]">
                  <span className="font-medium text-white">11 Tactical Slots: </span>
                  <span className="font-mono">
                    {selectedFormation.slots.map((s) => s.positionLabel).join(' · ')}
                  </span>
                </div>
              </>
            ) : (
              <div className="text-[13px] text-[#8A94A6]">Select a formation to preview slots.</div>
            )}
          </div>
        </div>
      )}

      {/* TAB 7: POSITIONS */}
      {activeTab === 'positions' && (
        <div className="bg-[#12151B] border border-white/[0.08] rounded-lg overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-[#161A22] text-[#8A94A6] border-b border-white/[0.08]">
              <tr>
                <SortableTh
                  label="Code"
                  columnKey="code"
                  activeKey={positionSortKey}
                  direction={positionSortDir}
                  onSort={togglePositionSort}
                  className="px-5 py-2.5 font-medium"
                />
                <SortableTh
                  label="Position Name"
                  columnKey="label"
                  activeKey={positionSortKey}
                  direction={positionSortDir}
                  onSort={togglePositionSort}
                  className="px-4 py-2.5 font-medium"
                />
                <SortableTh
                  label="Category"
                  columnKey="category"
                  activeKey={positionSortKey}
                  direction={positionSortDir}
                  onSort={togglePositionSort}
                  className="px-4 py-2.5 font-medium"
                />
                <SortableTh
                  label="Tactical Line"
                  columnKey="tacticalLine"
                  activeKey={positionSortKey}
                  direction={positionSortDir}
                  onSort={togglePositionSort}
                  className="px-4 py-2.5 font-medium"
                />
                <SortableTh
                  label="Compatible FC IQ Roles"
                  columnKey="roles"
                  activeKey={positionSortKey}
                  direction={positionSortDir}
                  onSort={togglePositionSort}
                  defaultDir="desc"
                  className="px-4 py-2.5 font-medium"
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {sortedPositions.map((pos) => (
                <tr key={pos.code} className="hover:bg-white/[0.02]">
                  <td className="px-5 py-2.5 font-mono font-semibold text-emerald-300">
                    {pos.code}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-white">{pos.label}</td>
                  <td className="px-4 py-2.5 text-[#CBD3DF]">{pos.category}</td>
                  <td className="px-4 py-2.5 font-mono text-[#9AA4B4]">{pos.tacticalLine}</td>
                  <td className="px-4 py-2.5 text-[12px] text-[#9AA4B4]">
                    {pos.posRoles.join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 8: PLAYER ROLES */}
      {activeTab === 'roles' && (
        <div className="space-y-4">
          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4 flex flex-wrap items-center gap-3">
            <select
              value={rolePosFilter}
              onChange={(e) => setRolePosFilter(e.target.value)}
              className="bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
            >
              <option value="">All Positions</option>
              {ALL_POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-2 text-[13px] text-[#CBD3DF] cursor-pointer">
              <input
                type="checkbox"
                checked={roleFc26NewOnly}
                onChange={(e) => setRoleFc26NewOnly(e.target.checked)}
                className="accent-emerald-500"
              />
              FC 26 New Additions Only (Wide Back, Inverted Wingback, Box Crasher, Ball-Playing Keeper)
            </label>
            <span className="ml-auto text-[12px] font-mono text-[#8A94A6]">
              {filteredRoles.length} role(s)
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredRoles.map((role) => (
              <div
                key={role.id}
                className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4 space-y-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-[15px] font-semibold text-white">
                      {role.name}
                      {role.isFc26New && (
                        <span className="ml-2 text-[11px] font-mono text-emerald-400">
                          FC 26 NEW
                        </span>
                      )}
                    </h3>
                    <div className="text-[12px] text-[#8A94A6] font-mono mt-0.5">
                      Positions: {role.eligiblePositions.join(', ')}
                    </div>
                  </div>
                  <span className="text-[11px] text-[#7D8798]">{role.positionCategory}</span>
                </div>
                <p className="text-[13px] text-[#CBD3DF]">{role.description}</p>
                <div className="text-[12px] text-[#9AA4B4] space-y-1 pt-1 border-t border-white/[0.06]">
                  <div>
                    <span className="text-[#D4DCE8] font-medium">Attacking:</span>{' '}
                    {role.attackingBehavior}
                  </div>
                  <div>
                    <span className="text-[#D4DCE8] font-medium">Defensive:</span>{' '}
                    {role.defensiveBehavior}
                  </div>
                  <div>
                    <span className="text-[#D4DCE8] font-medium">Compatible Focuses:</span>{' '}
                    {Object.entries(role.compatibleFocusesByPosition)
                      .map(([pos, list]) => `${pos}: ${list.join(', ')}`)
                      .join(' | ') || '—'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 9: PLAYER FOCUSES & COMPATIBILITY MATRIX */}
      {activeTab === 'focuses' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {focuses.map((f) => (
              <div
                key={f.id}
                className="bg-[#12151B] border border-white/[0.08] rounded-lg p-4 space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-[14px] font-semibold text-white">
                    {f.name}
                    {f.isFc26Updated && (
                      <span className="ml-2 text-[11px] font-mono text-emerald-400">
                        FC 26 UPDATED
                      </span>
                    )}
                  </h3>
                  <span className="text-[12px] font-mono text-[#8A94A6]">
                    {f.compatibleRolesCount ?? 0} role(s)
                  </span>
                </div>
                <p className="text-[13px] text-[#CBD3DF]">{f.description}</p>
                <div className="text-[12px] text-[#8A94A6]">Purpose: {f.tacticalPurpose}</div>
              </div>
            ))}
          </div>

          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[14px] font-semibold text-white">
                  Position-Specific Role &amp; Focus Compatibility Matrix
                </h2>
                <p className="text-[12px] text-[#8A94A6]">
                  Enforced dynamically in Match Preparation and validated by the Express backend.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={compatPosFilter}
                  onChange={(e) => setCompatPosFilter(e.target.value)}
                  className="bg-[#171B22] border border-white/[0.1] rounded-md px-2.5 py-1.5 text-[12px] text-white"
                >
                  <option value="">All Positions</option>
                  {ALL_POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <select
                  value={compatRoleFilter}
                  onChange={(e) => setCompatRoleFilter(e.target.value)}
                  className="bg-[#171B22] border border-white/[0.1] rounded-md px-2.5 py-1.5 text-[12px] text-white"
                >
                  <option value="">All Roles</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-[#161A22] text-[#8A94A6] border-b border-white/[0.08] sticky top-0">
                  <tr>
                    <SortableTh
                      label="Position"
                      columnKey="position"
                      activeKey={compatSortKey}
                      direction={compatSortDir}
                      onSort={toggleCompatSort}
                      className="px-5 py-2 font-medium"
                    />
                    <SortableTh
                      label="Player Role"
                      columnKey="role"
                      activeKey={compatSortKey}
                      direction={compatSortDir}
                      onSort={toggleCompatSort}
                      className="px-4 py-2 font-medium"
                    />
                    <SortableTh
                      label="Allowed Focus"
                      columnKey="focus"
                      activeKey={compatSortKey}
                      direction={compatSortDir}
                      onSort={toggleCompatSort}
                      className="px-4 py-2 font-medium"
                    />
                    <SortableTh
                      label="Verification Reference"
                      columnKey="evidence"
                      activeKey={compatSortKey}
                      direction={compatSortDir}
                      onSort={toggleCompatSort}
                      className="px-4 py-2 font-medium"
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {sortedCompat.map((row, idx) => (
                    <tr key={`${row.positionCode}-${row.roleId}-${row.focusId}-${idx}`}>
                      <td className="px-5 py-2 font-mono text-emerald-300">{row.positionCode}</td>
                      <td className="px-4 py-2 font-medium text-white">{row.roleName}</td>
                      <td className="px-4 py-2 text-[#CBD3DF]">{row.focusName}</td>
                      <td className="px-4 py-2 text-[12px] text-[#8A94A6]">{row.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 10: IMPORT & UPDATE HISTORY */}
      {activeTab === 'imports' && (
        <div className="space-y-6">
          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg p-5 space-y-4">
            <div>
              <h2 className="text-[15px] font-semibold text-white">
                Batch Dataset Import (CSV / JSON)
              </h2>
              <p className="text-[12px] text-[#8A94A6] mt-0.5">
                Idempotent upserts keyed by <span className="font-mono">external_source_id</span>. Supports both{' '}
                <span className="text-[#CBD3DF]">FC26 AI Manager Standard CSV/JSON</span> and{' '}
                <span className="text-[#CBD3DF]">EAFC26 DataHub / SoFIFA-style CSV</span> (110+ columns with extended attributes preserved in <span className="font-mono">attributes_json</span>). Operational Career Mode squads and matches are never overwritten.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div>
                <label className="block text-[12px] text-[#8A94A6] mb-1">Target Dataset</label>
                <select
                  value={importDatasetType}
                  onChange={(e) => {
                    setImportDatasetType(e.target.value as CatalogDatasetType);
                    setImportPreview(null);
                  }}
                  className="w-full bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
                >
                  <option value="players">Players (Career Mode)</option>
                  <option value="clubs">Clubs</option>
                  <option value="leagues">Leagues</option>
                  <option value="nations">Nations</option>
                  <option value="formations">Formations</option>
                  <option value="roles">Player Roles</option>
                  <option value="focuses">Player Focuses</option>
                </select>
              </div>
              <div>
                <label className="block text-[12px] text-[#8A94A6] mb-1">Format</label>
                <select
                  value={importFormat}
                  onChange={(e) => {
                    setImportFormat(e.target.value as 'csv' | 'json');
                    setImportPreview(null);
                  }}
                  className="w-full bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
                >
                  <option value="csv">CSV (RFC-4180)</option>
                  <option value="json">JSON</option>
                </select>
              </div>
              <div>
                <label className="block text-[12px] text-[#8A94A6] mb-1">Duplicate Strategy</label>
                <select
                  value={importMode}
                  onChange={(e) => setImportMode(e.target.value as 'upsert' | 'insert_only')}
                  className="w-full bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[13px] text-white"
                >
                  <option value="upsert">Upsert (Insert New + Update Existing)</option>
                  <option value="insert_only">Insert New Only (Skip Existing)</option>
                </select>
              </div>
              <div>
                <label className="block text-[12px] text-[#8A94A6] mb-1">Upload File</label>
                <input
                  type="file"
                  accept=".csv,.json,text/csv,application/json"
                  onChange={(e) => void handleFileSelected(e)}
                  className="w-full text-[12px] text-[#CBD3DF] file:mr-2 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-[#1E2430] file:text-white hover:file:bg-[#272F3E]"
                />
              </div>
            </div>

            <div>
              <label className="block text-[12px] text-[#8A94A6] mb-1">
                Dataset Payload {importFileName ? `(${importFileName})` : '(or paste Standard or EAFC26 DataHub CSV/JSON directly)'}
              </label>
              <textarea
                rows={5}
                value={importRawContent}
                onChange={(e) => {
                  setImportRawContent(e.target.value);
                  setImportPreview(null);
                }}
                placeholder="Standard: external_source_id,full_name,primary_position,overall_rating... | DataHub: player_id,short_name,long_name,player_positions,overall,potential,physic,value_eur..."
                className="w-full bg-[#171B22] border border-white/[0.1] rounded-md px-3 py-2 text-[12px] font-mono text-[#E2E8F0] focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={importing || !importRawContent.trim()}
                onClick={() => void handlePreviewImport()}
                className="px-4 py-2 rounded-md border border-white/[0.12] bg-[#181D26] hover:bg-[#202733] disabled:opacity-40 text-white text-[13px] font-medium"
              >
                Preview &amp; Validate
              </button>
              <button
                type="button"
                disabled={importing || !importPreview || importPreview.validCount === 0}
                onClick={() => void handleExecuteImport()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[13px] font-medium"
              >
                <CheckCircle2 className="w-4 h-4" />
                Confirm &amp; Execute Import
              </button>
            </div>

            {/* Preview Summary */}
            {importPreview && (
              <div className="border border-emerald-500/30 bg-emerald-500/[0.04] rounded-lg p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-semibold text-white">Import Validation Preview</span>
                    {importPreview.schemaDiagnostics && (
                      <span
                        className={`text-[12px] font-medium px-2 py-0.5 rounded border ${
                          importPreview.schemaDiagnostics.profileId === 'unknown_schema'
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                            : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                        }`}
                      >
                        {importPreview.schemaDiagnostics.profileLabel}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[11px] text-[#8A94A6]">
                    SHA-256: {importPreview.checksum.slice(0, 16)}…
                  </span>
                </div>

                {/* Schema-Level Diagnostics & Warnings (shown before row errors) */}
                {importPreview.schemaDiagnostics && (
                  <div className="space-y-3 border-t border-white/[0.08] pt-3">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
                      <div className="bg-[#12151B] border border-white/[0.07] rounded-md px-3 py-2">
                        <div className="text-[#8A94A6]">Detected Source Schema</div>
                        <div className="text-white font-medium mt-0.5">
                          {importPreview.schemaDiagnostics.columnCount} columns ·{' '}
                          {importPreview.schemaDiagnostics.recognizedMappings.length} canonical mapped
                        </div>
                        {importPreview.schemaDiagnostics.detectedSourceKey && (
                          <div className="text-[11px] font-mono text-sky-300 mt-0.5">
                            Provenance: {importPreview.schemaDiagnostics.detectedSourceKey}
                          </div>
                        )}
                      </div>
                      <div className="bg-[#12151B] border border-white/[0.07] rounded-md px-3 py-2">
                        <div className="text-[#8A94A6]">Required Fields Status</div>
                        <div className="mt-0.5 space-y-0.5 font-mono text-[11px]">
                          <div
                            className={
                              importPreview.schemaDiagnostics.requiredFieldsMapped.name
                                ? 'text-emerald-300'
                                : 'text-amber-300'
                            }
                          >
                            Name:{' '}
                            {importPreview.schemaDiagnostics.requiredFieldsMapped.nameSource
                              ? `mapped from ${importPreview.schemaDiagnostics.requiredFieldsMapped.nameSource}`
                              : 'MISSING'}
                          </div>
                          <div
                            className={
                              importPreview.schemaDiagnostics.requiredFieldsMapped.position
                                ? 'text-emerald-300'
                                : 'text-amber-300'
                            }
                          >
                            Position:{' '}
                            {importPreview.schemaDiagnostics.requiredFieldsMapped.positionSource
                              ? `mapped from ${importPreview.schemaDiagnostics.requiredFieldsMapped.positionSource}`
                              : 'MISSING'}
                          </div>
                        </div>
                      </div>
                      <div className="bg-[#12151B] border border-white/[0.07] rounded-md px-3 py-2">
                        <div className="text-[#8A94A6]">Extended Attributes &amp; Media Policy</div>
                        <div className="mt-0.5 text-[11px] text-[#CBD3DF] space-y-0.5">
                          <div>
                            Preserved in <span className="font-mono">attributes_json</span>:{' '}
                            <span className="font-mono text-emerald-300">
                              {importPreview.schemaDiagnostics.extendedAttributeColumns.length}
                            </span>{' '}
                            known cols
                            {importPreview.schemaDiagnostics.unrecognizedColumns.length > 0 && (
                              <span className="text-[#8A94A6]">
                                {' '}
                                (+{importPreview.schemaDiagnostics.unrecognizedColumns.length} extra)
                              </span>
                            )}
                          </div>
                          <div>
                            Third-party image URLs ignored:{' '}
                            <span className="font-mono text-sky-300">
                              {importPreview.schemaDiagnostics.ignoredMediaColumns.length}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {importPreview.schemaDiagnostics.schemaWarnings.length > 0 && (
                      <div className="border border-amber-500/40 bg-amber-500/10 rounded-md px-3 py-2.5 text-[12px] text-amber-200 space-y-1">
                        <div className="font-semibold text-amber-300">Schema Warnings</div>
                        {importPreview.schemaDiagnostics.schemaWarnings.map((warn, idx) => (
                          <div key={idx}>{warn}</div>
                        ))}
                      </div>
                    )}

                    {importPreview.schemaDiagnostics.recognizedMappings.length > 0 && (
                      <div className="bg-[#12151B] border border-white/[0.07] rounded-md p-3 space-y-2">
                        <div className="text-[11px] uppercase tracking-wider text-[#8A94A6] font-semibold">
                          Recognized Field Mappings ({importPreview.schemaDiagnostics.recognizedMappings.length})
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 text-[11px] font-mono">
                          {importPreview.schemaDiagnostics.recognizedMappings.map((m) => (
                            <div key={`${m.sourceColumn}-${m.targetField}`} className="truncate">
                              <span className="text-sky-300">{m.sourceColumn}</span>
                              <span className="text-[#8A94A6] mx-1.5">→</span>
                              <span className="text-emerald-300">{m.targetField}</span>
                            </div>
                          ))}
                        </div>
                        {importPreview.schemaDiagnostics.unrecognizedColumns.length > 0 && (
                          <div className="text-[11px] text-[#8A94A6] pt-1.5 border-t border-white/[0.06]">
                            Unrecognized columns (preserved in <span className="font-mono">attributes_json</span>):{' '}
                            <span className="font-mono text-[#CBD3DF]">
                              {importPreview.schemaDiagnostics.unrecognizedColumns.slice(0, 12).join(', ')}
                              {importPreview.schemaDiagnostics.unrecognizedColumns.length > 12
                                ? ` (+${importPreview.schemaDiagnostics.unrecognizedColumns.length - 12} more)`
                                : ''}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Row Count Summary */}
                <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-[12px] border-t border-white/[0.08] pt-3">
                  <div>
                    <div className="text-[#8A94A6]">Total Rows</div>
                    <div className="font-mono text-[15px] font-semibold text-white">
                      {importPreview.totalRows.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#8A94A6]">Valid Rows</div>
                    <div className="font-mono text-[15px] font-semibold text-emerald-300">
                      {importPreview.validCount.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#8A94A6]">New Inserts</div>
                    <div className="font-mono text-[15px] font-semibold text-emerald-400">
                      {importPreview.insertCount.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#8A94A6]">Updates</div>
                    <div className="font-mono text-[15px] font-semibold text-sky-400">
                      {importPreview.updateCount.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#8A94A6]">Rejected</div>
                    <div className="font-mono text-[15px] font-semibold text-amber-400">
                      {importPreview.rejectedCount.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#8A94A6]">In-File Duplicates</div>
                    <div className="font-mono text-[15px] font-semibold text-[#CBD3DF]">
                      {importPreview.duplicatesInFile.toLocaleString()}
                    </div>
                  </div>
                </div>

                {/* Normalized Sample Players Preview (first 5-8 rows) */}
                {importPreview.datasetType === 'players' && importPreview.sampleRows.length > 0 && (
                  <div className="border-t border-white/[0.08] pt-3 space-y-2">
                    <div className="text-[12px] font-semibold text-white">
                      Normalized Sample Players (first {importPreview.sampleRows.length} valid rows)
                    </div>
                    <div className="overflow-x-auto bg-[#12151B] border border-white/[0.08] rounded-md">
                      <table className="w-full text-left text-[12px]">
                        <thead className="bg-[#161A22] text-[#8A94A6] border-b border-white/[0.08]">
                          <tr>
                            <SortableTh
                              label="External ID"
                              columnKey="externalId"
                              activeKey={samplePreviewSortKey}
                              direction={samplePreviewSortDir}
                              onSort={toggleSamplePreviewSort}
                              className="px-3 py-1.5 font-medium"
                            />
                            <SortableTh
                              label="Full Name / Short"
                              columnKey="fullName"
                              activeKey={samplePreviewSortKey}
                              direction={samplePreviewSortDir}
                              onSort={toggleSamplePreviewSort}
                              className="px-3 py-1.5 font-medium"
                            />
                            <SortableTh
                              label="Positions"
                              columnKey="position"
                              activeKey={samplePreviewSortKey}
                              direction={samplePreviewSortDir}
                              onSort={toggleSamplePreviewSort}
                              className="px-3 py-1.5 font-medium"
                            />
                            <SortableTh
                              label="Club / Nation"
                              columnKey="clubNation"
                              activeKey={samplePreviewSortKey}
                              direction={samplePreviewSortDir}
                              onSort={toggleSamplePreviewSort}
                              className="px-3 py-1.5 font-medium"
                            />
                            <SortableTh
                              label="OVR / POT / Age"
                              columnKey="overall"
                              activeKey={samplePreviewSortKey}
                              direction={samplePreviewSortDir}
                              onSort={toggleSamplePreviewSort}
                              defaultDir="desc"
                              align="right"
                              className="px-3 py-1.5 font-medium"
                            />
                            <SortableTh
                              label="PHY / Value / Exp"
                              columnKey="value"
                              activeKey={samplePreviewSortKey}
                              direction={samplePreviewSortDir}
                              onSort={toggleSamplePreviewSort}
                              defaultDir="desc"
                              align="right"
                              className="px-3 py-1.5 font-medium"
                            />
                            <SortableTh
                              label="Ext. Attrs"
                              columnKey="extAttrs"
                              activeKey={samplePreviewSortKey}
                              direction={samplePreviewSortDir}
                              onSort={toggleSamplePreviewSort}
                              defaultDir="desc"
                              align="right"
                              className="px-3 py-1.5 font-medium"
                            />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.06]">
                          {sortedSamplePreviewRows.map((row, idx) => {
                            const sec = Array.isArray(row.secondaryPositions)
                              ? (row.secondaryPositions as string[])
                              : [];
                            const valueEur =
                              typeof row.marketValueEur === 'number'
                                ? row.marketValueEur >= 1_000_000
                                  ? `€${(row.marketValueEur / 1_000_000).toFixed(1)}M`
                                  : `€${row.marketValueEur.toLocaleString()}`
                                : '—';
                            const extCount =
                              typeof row.extendedAttributeCount === 'number'
                                ? row.extendedAttributeCount
                                : 0;
                            const shortNameStr =
                              typeof row.shortName === 'string' && row.shortName.trim()
                                ? row.shortName.trim()
                                : '';
                            const fullNameStr = String(row.fullName ?? '');
                            const fmtNum = (val: unknown): string =>
                              typeof val === 'number' || typeof val === 'string'
                                ? String(val)
                                : '—';
                            return (
                              <tr key={`${String(row.externalSourceId ?? idx)}-${idx}`}>
                                <td className="px-3 py-1.5 font-mono text-[11px] text-[#8A94A6]">
                                  {String(row.externalSourceId ?? '')}
                                </td>
                                <td className="px-3 py-1.5">
                                  <div className="text-white font-medium">{fullNameStr}</div>
                                  {shortNameStr && shortNameStr !== fullNameStr && (
                                    <div className="text-[11px] text-[#8A94A6]">{shortNameStr}</div>
                                  )}
                                </td>
                                <td className="px-3 py-1.5 font-mono">
                                  <span className="text-emerald-300 font-semibold">
                                    {String(row.primaryPosition ?? '')}
                                  </span>
                                  {sec.length > 0 && (
                                    <span className="text-[#8A94A6] ml-1">· {sec.join(', ')}</span>
                                  )}
                                </td>
                                <td className="px-3 py-1.5 text-[#CBD3DF]">
                                  <div>{String(row.clubNameRaw || '—')}</div>
                                  <div className="text-[11px] text-[#8A94A6]">
                                    {String(row.nationNameRaw || '—')}
                                  </div>
                                </td>
                                <td className="px-3 py-1.5 font-mono text-right text-white">
                                  {fmtNum(row.overallRating)} / {fmtNum(row.potentialRating)} /{' '}
                                  {fmtNum(row.age)}
                                </td>
                                <td className="px-3 py-1.5 font-mono text-right text-[#CBD3DF]">
                                  {fmtNum(row.physicality)} · {valueEur} ·{' '}
                                  {row.contractExpiry ? String(row.contractExpiry) : '—'}
                                </td>
                                <td className="px-3 py-1.5 font-mono text-right text-sky-300">
                                  {extCount > 0 ? extCount : '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {importPreview.validationErrors.length > 0 && (
                  <div className="text-[12px] text-amber-300 space-y-1 max-h-36 overflow-y-auto pt-2 border-t border-white/[0.08]">
                    <div className="font-semibold text-amber-200">
                      Row Validation Errors (showing {Math.min(10, importPreview.validationErrors.length)} of{' '}
                      {importPreview.rejectedCount.toLocaleString()} rejected rows)
                    </div>
                    {importPreview.validationErrors.slice(0, 10).map((err, i) => (
                      <div key={i}>
                        Row {err.row} ({err.field}): {err.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Import Run History Table */}
          <div className="bg-[#12151B] border border-white/[0.08] rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/[0.08]">
              <h2 className="text-[14px] font-semibold text-white">Import &amp; Update History</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-[#161A22] text-[#8A94A6] border-b border-white/[0.08]">
                  <tr>
                    <SortableTh
                      label="Dataset"
                      columnKey="dataset"
                      activeKey={importRunSortKey}
                      direction={importRunSortDir}
                      onSort={toggleImportRunSort}
                      className="px-4 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="File"
                      columnKey="file"
                      activeKey={importRunSortKey}
                      direction={importRunSortDir}
                      onSort={toggleImportRunSort}
                      className="px-4 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="Status"
                      columnKey="status"
                      activeKey={importRunSortKey}
                      direction={importRunSortDir}
                      onSort={toggleImportRunSort}
                      className="px-4 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="Ins / Upd / Rej"
                      columnKey="counts"
                      activeKey={importRunSortKey}
                      direction={importRunSortDir}
                      onSort={toggleImportRunSort}
                      defaultDir="desc"
                      align="right"
                      className="px-4 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="SHA-256"
                      columnKey="checksum"
                      activeKey={importRunSortKey}
                      direction={importRunSortDir}
                      onSort={toggleImportRunSort}
                      className="px-4 py-2.5 font-medium"
                    />
                    <SortableTh
                      label="Timestamp"
                      columnKey="timestamp"
                      activeKey={importRunSortKey}
                      direction={importRunSortDir}
                      onSort={toggleImportRunSort}
                      defaultDir="desc"
                      className="px-4 py-2.5 font-medium"
                    />
                    <th className="px-4 py-2.5 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {sortedImportRuns.map((run) => (
                    <tr key={run.id} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-2.5 font-medium text-white capitalize">
                        {run.datasetType}
                      </td>
                      <td className="px-4 py-2.5 text-[#CBD3DF] font-mono text-[12px]">
                        {run.fileName}
                      </td>
                      <td className="px-4 py-2.5 text-[12px]">
                        <span
                          className={
                            run.status === 'completed'
                              ? 'text-emerald-400'
                              : run.status === 'rolled_back'
                                ? 'text-amber-400'
                                : 'text-red-400'
                          }
                        >
                          {run.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#CBD3DF]">
                        {run.insertedCount} / {run.updatedCount} / {run.rejectedCount}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-[#8A94A6]">
                        {run.checksum.slice(0, 12)}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-[#8A94A6]">
                        {new Date(run.startedAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {run.status === 'completed' &&
                          run.datasetType !== 'sources' &&
                          run.datasetType !== 'positions' && (
                            <button
                              type="button"
                              onClick={() => void handleRollbackRun(run.id)}
                              className="inline-flex items-center gap-1 text-[12px] text-amber-300 hover:text-amber-200"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              Rollback
                            </button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
