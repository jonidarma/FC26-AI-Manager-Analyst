import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { desktopBridge, type SystemStatusResponse } from '../services/desktopBridge';
import type {
  ApiUsageLog,
  ApplicationSettings,
  ClubWithProfile,
  DashboardSummary,
  DesktopBridgeCapabilities,
  HalftimeReportData,
  MatchRecord,
  NavigationSection,
  Opponent,
  Player,
  PostMatchReportRecord,
  RecommendationFeedbackRecord,
  TacticalCatalogItem,
  TacticalMemoryEntry,
} from '../types/domain';

interface ToastMessage {
  id: string;
  tone: 'success' | 'error' | 'info';
  text: string;
}

interface AppContextValue {
  activeSection: NavigationSection;
  setActiveSection: (section: NavigationSection) => void;
  selectedMatchId: string | null;
  setSelectedMatchId: (id: string | null) => void;
  capabilities: DesktopBridgeCapabilities | null;
  systemStatus: SystemStatusResponse | null;
  dashboard: DashboardSummary | null;
  clubs: ClubWithProfile[];
  activeClub: ClubWithProfile | null;
  players: Player[];
  opponents: Opponent[];
  matches: MatchRecord[];
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
  notify: (tone: ToastMessage['tone'], text: string) => void;
  toasts: ToastMessage[];
  dismissToast: (id: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [activeSection, setActiveSection] = useState<NavigationSection>('dashboard');
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<DesktopBridgeCapabilities | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatusResponse | null>(null);
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [clubs, setClubs] = useState<ClubWithProfile[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [opponents, setOpponents] = useState<Opponent[]>([]);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
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

      const resolvedActiveClub =
        clubList.find((c) => c.profile.isActive) ?? clubList[0] ?? null;

      if (resolvedActiveClub) {
        const [clubPlayers, clubMatches, clubMemory, clubPostReports, clubFeedback] =
          await Promise.all([
            desktopBridge.listPlayers(resolvedActiveClub.id),
            desktopBridge.listMatches(resolvedActiveClub.id),
            desktopBridge.listTacticalMemory(resolvedActiveClub.id),
            desktopBridge.listPostMatchReports(resolvedActiveClub.id),
            desktopBridge.listFeedback(resolvedActiveClub.id),
          ]);
        setPlayers(clubPlayers);
        setMatches(clubMatches);
        setTacticalMemory(clubMemory);
        setPostMatchReports(clubPostReports);
        setFeedbackRecords(clubFeedback);
        setSelectedMatchId((current) => {
          if (current && clubMatches.some((m) => m.id === current)) return current;
          return clubMatches[0]?.id ?? null;
        });
      } else {
        setPlayers([]);
        setMatches([]);
        setTacticalMemory([]);
        setPostMatchReports([]);
        setFeedbackRecords([]);
        setSelectedMatchId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load application data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const activeClub = clubs.find((c) => c.profile.isActive) ?? clubs[0] ?? null;

  return (
    <AppContext.Provider
      value={{
        activeSection,
        setActiveSection,
        selectedMatchId,
        setSelectedMatchId,
        capabilities,
        systemStatus,
        dashboard,
        clubs,
        activeClub,
        players,
        opponents,
        matches,
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
