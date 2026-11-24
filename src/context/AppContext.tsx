import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { desktopBridge, type SystemStatusResponse } from '../services/desktopBridge';
import {
  INITIAL_RECORDING_TELEMETRY,
  recordingController,
} from '../services/recordingController';
import type {
  ApiUsageLog,
  ApplicationSettings,
  ClubWithProfile,
  DashboardSummary,
  DesktopBridgeCapabilities,
  HalftimeReportData,
  MatchRecord,
  MatchSessionWithSegments,
  NavigationSection,
  Opponent,
  Player,
  PostMatchReportRecord,
  RecommendationFeedbackRecord,
  RecoverableSessionSummary,
  RecordingTelemetry,
  TacticalCatalogItem,
  TacticalMemoryEntry,
  TacticalPreset,
} from '../types/domain';

interface ToastMessage {
  id: string;
  tone: 'success' | 'error' | 'info';
  text: string;
}

export interface DirtyStateGuard {
  isDirty: boolean;
  label: string;
  onSave: () => Promise<boolean>;
  onDiscard: () => void;
}

export interface PendingNavigationPrompt {
  guardLabel: string;
  targetDescription: string;
  saving: boolean;
  onConfirmSave: () => Promise<void>;
  onConfirmDiscard: () => void;
  onCancel: () => void;
}

interface AppContextValue {
  activeSection: NavigationSection;
  setActiveSection: (section: NavigationSection) => void;
  requestNavigation: (section: NavigationSection) => void;
  guardedActivateClub: (clubId: string) => void;
  registerDirtyGuard: (guard: DirtyStateGuard | null) => void;
  pendingNavigation: PendingNavigationPrompt | null;
  selectedMatchId: string | null;
  setSelectedMatchId: (id: string | null) => void;
  capabilities: DesktopBridgeCapabilities | null;
  systemStatus: SystemStatusResponse | null;
  dashboard: DashboardSummary | null;
  clubs: ClubWithProfile[];
  activeClub: ClubWithProfile | null;
  players: Player[];
  tacticalPresets: TacticalPreset[];
  opponents: Opponent[];
  matches: MatchRecord[];
  recordingSessions: MatchSessionWithSegments[];
  recoverableSessions: RecoverableSessionSummary[];
  recordingTelemetry: RecordingTelemetry;
  tacticalMemory: TacticalMemoryEntry[];
  tacticalCatalog: TacticalCatalogItem[];
  halftimeReports: Array<{
    matchId: string;
    opponentName: string;
    competition: string;
    matchDate: string;
    report: HalftimeReportData;
  }>;
  postMatchReports: PostMatchReportRecord[];
  feedbackRecords: RecommendationFeedbackRecord[];
  settings: ApplicationSettings | null;
  usageLogs: ApiUsageLog[];
  loading: boolean;
  error: string | null;
  refreshAll: () => Promise<void>;
  refreshRecordingData: () => Promise<void>;
  notify: (tone: ToastMessage['tone'], text: string) => void;
  toasts: ToastMessage[];
  dismissToast: (id: string) => void;
}

const SECTION_LABELS: Record<NavigationSection, string> = {
  dashboard: 'Dashboard',
  clubs: 'Career Mode Clubs',
  'squad-management': 'Squad Management',
  'tactical-setup': 'Tactical Setup',
  'match-prep': 'Match Preparation',
  'match-capture': 'Match Capture',
  'halftime-briefing': 'Half-Time Briefing',
  'tactical-board': 'Tactical Board',
  'database-center': 'FC26 Database Center',
  opposition: 'Opposition Analysis',
  'match-reports': 'Match Reports',
  'match-history': 'Match History',
  'tactical-memory': 'Tactical Memory',
  settings: 'Settings',
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [activeSection, setActiveSectionState] = useState<NavigationSection>('dashboard');
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<DesktopBridgeCapabilities | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatusResponse | null>(null);
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [clubs, setClubs] = useState<ClubWithProfile[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [tacticalPresets, setTacticalPresets] = useState<TacticalPreset[]>([]);
  const [opponents, setOpponents] = useState<Opponent[]>([]);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [recordingSessions, setRecordingSessions] = useState<MatchSessionWithSegments[]>([]);
  const [recoverableSessions, setRecoverableSessions] = useState<RecoverableSessionSummary[]>([]);
  const [recordingTelemetry, setRecordingTelemetry] = useState<RecordingTelemetry>(
    INITIAL_RECORDING_TELEMETRY
  );
  const [tacticalMemory, setTacticalMemory] = useState<TacticalMemoryEntry[]>([]);
  const [tacticalCatalog, setTacticalCatalog] = useState<TacticalCatalogItem[]>([]);
  const [halftimeReports, setHalftimeReports] = useState<
    AppContextValue['halftimeReports']
  >([]);
  const [postMatchReports, setPostMatchReports] = useState<PostMatchReportRecord[]>([]);
  const [feedbackRecords, setFeedbackRecords] = useState<RecommendationFeedbackRecord[]>([]);
  const [settings, setSettings] = useState<ApplicationSettings | null>(null);
  const [usageLogs, setUsageLogs] = useState<ApiUsageLog[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dirtyGuardRef = useRef<DirtyStateGuard | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigationPrompt | null>(null);

  const registerDirtyGuard = useCallback((guard: DirtyStateGuard | null) => {
    dirtyGuardRef.current = guard;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback((tone: ToastMessage['tone'], text: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, tone, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const refreshRecordingData = useCallback(async (clubIdOverride?: string | null) => {
    try {
      const [sessions, recoverable] = await Promise.all([
        desktopBridge.listRecordingSessions(
          clubIdOverride ? { clubId: clubIdOverride } : undefined
        ),
        desktopBridge.getRecoverableSessions(),
      ]);
      setRecordingSessions(sessions);
      setRecoverableSessions(recoverable);
    } catch {
      // keep previous recording lists on transient fetch error
    }
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      setError(null);
      const [
        caps,
        sys,
        dash,
        clubList,
        oppList,
        catalogList,
        appSettings,
        htReports,
        logs,
        recoverable,
      ] = await Promise.all([
        desktopBridge.getCapabilities(),
        desktopBridge.getSystemStatus(),
        desktopBridge.getDashboardSummary(),
        desktopBridge.listClubs(),
        desktopBridge.listOpponents(),
        desktopBridge.listTacticalCatalog(),
        desktopBridge.getSettings(),
        desktopBridge.listHalftimeReports(),
        desktopBridge.listApiUsageLogs(),
        desktopBridge.getRecoverableSessions(),
      ]);

      setCapabilities(caps);
      setSystemStatus(sys);
      setDashboard(dash);
      setClubs(clubList);
      setOpponents(oppList);
      setTacticalCatalog(catalogList);
      setSettings(appSettings);
      setHalftimeReports(htReports);
      setUsageLogs(logs);
      setRecoverableSessions(recoverable);

      const resolvedActiveClub =
        clubList.find((c) => c.profile.isActive) ?? clubList[0] ?? null;

      if (resolvedActiveClub) {
        const [
          clubPlayers,
          clubPresets,
          clubMatches,
          clubMemory,
          clubPostReports,
          clubFeedback,
          clubSessions,
        ] = await Promise.all([
          desktopBridge.listPlayers(resolvedActiveClub.id),
          desktopBridge.listTacticalPresets(resolvedActiveClub.id),
          desktopBridge.listMatches(resolvedActiveClub.id),
          desktopBridge.listTacticalMemory(resolvedActiveClub.id),
          desktopBridge.listPostMatchReports(resolvedActiveClub.id),
          desktopBridge.listFeedback(resolvedActiveClub.id),
          desktopBridge.listRecordingSessions({ clubId: resolvedActiveClub.id }),
        ]);
        setPlayers(clubPlayers);
        setTacticalPresets(clubPresets);
        setMatches(clubMatches);
        setTacticalMemory(clubMemory);
        setPostMatchReports(clubPostReports);
        setFeedbackRecords(clubFeedback);
        setRecordingSessions(clubSessions);
        setSelectedMatchId((current) => {
          if (current && clubMatches.some((m) => m.id === current)) return current;
          return clubMatches[0]?.id ?? null;
        });
      } else {
        setPlayers([]);
        setTacticalPresets([]);
        setMatches([]);
        setTacticalMemory([]);
        setPostMatchReports([]);
        setFeedbackRecords([]);
        setRecordingSessions([]);
        setSelectedMatchId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load application data');
    } finally {
      setLoading(false);
    }
  }, []);

  const executeWithDirtyGuard = useCallback(
    (targetDescription: string, proceed: () => void | Promise<void>) => {
      const guard = dirtyGuardRef.current;
      if (!guard || !guard.isDirty) {
        void proceed();
        return;
      }

      setPendingNavigation({
        guardLabel: guard.label,
        targetDescription,
        saving: false,
        onConfirmSave: async () => {
          setPendingNavigation((prev) => (prev ? { ...prev, saving: true } : null));
          const savedOk = await guard.onSave();
          if (savedOk) {
            setPendingNavigation(null);
            await proceed();
          } else {
            setPendingNavigation((prev) => (prev ? { ...prev, saving: false } : null));
          }
        },
        onConfirmDiscard: () => {
          guard.onDiscard();
          setPendingNavigation(null);
          void proceed();
        },
        onCancel: () => {
          setPendingNavigation(null);
        },
      });
    },
    []
  );

  const requestNavigation = useCallback(
    (nextSection: NavigationSection) => {
      if (nextSection === activeSection) return;
      executeWithDirtyGuard(SECTION_LABELS[nextSection] ?? nextSection, () => {
        setActiveSectionState(nextSection);
      });
    },
    [activeSection, executeWithDirtyGuard]
  );

  const setActiveSection = useCallback(
    (nextSection: NavigationSection) => {
      requestNavigation(nextSection);
    },
    [requestNavigation]
  );

  const activeClub = clubs.find((c) => c.profile.isActive) ?? clubs[0] ?? null;

  const guardedActivateClub = useCallback(
    (clubId: string) => {
      if (!clubId || clubId === activeClub?.id) return;
      const targetClub = clubs.find((c) => c.id === clubId);
      executeWithDirtyGuard(
        targetClub ? `Switch Club to ${targetClub.name}` : 'Switch Career Club',
        async () => {
          try {
            await desktopBridge.activateClub(clubId);
            await refreshAll();
            notify('info', 'Switched active Career Mode club.');
          } catch (err) {
            notify('error', err instanceof Error ? err.message : 'Failed to switch club');
          }
        }
      );
    },
    [activeClub?.id, clubs, executeWithDirtyGuard, notify, refreshAll]
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Subscribe to app-level RecordingController so telemetry & active recording survive navigation
  useEffect(() => {
    const unsubscribe = recordingController.subscribe((nextTelemetry) => {
      setRecordingTelemetry(nextTelemetry);
    });
    return unsubscribe;
  }, []);

  // Warn before accidental reload/close while recording or editing unsaved tactical setup
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (recordingController.isRecordingOrBusy() || dirtyGuardRef.current?.isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const refreshRecordingForActiveClub = useCallback(async () => {
    await refreshRecordingData(activeClub?.id ?? null);
  }, [activeClub?.id, refreshRecordingData]);

  return (
    <AppContext.Provider
      value={{
        activeSection,
        setActiveSection,
        requestNavigation,
        guardedActivateClub,
        registerDirtyGuard,
        pendingNavigation,
        selectedMatchId,
        setSelectedMatchId,
        capabilities,
        systemStatus,
        dashboard,
        clubs,
        activeClub,
        players,
        tacticalPresets,
        opponents,
        matches,
        recordingSessions,
        recoverableSessions,
        recordingTelemetry,
        tacticalMemory,
        tacticalCatalog,
        halftimeReports,
        postMatchReports,
        feedbackRecords,
        settings,
        usageLogs,
        loading,
        error,
        refreshAll,
        refreshRecordingData: refreshRecordingForActiveClub,
        notify,
        toasts,
        dismissToast,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
