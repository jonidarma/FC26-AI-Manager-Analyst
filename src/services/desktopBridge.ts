import type {
  ApiUsageLog,
  ApplicationSettings,
  CaptureSourceInfo,
  ClubWithProfile,
  ConfidenceLevel,
  DashboardSummary,
  DesktopBridgeCapabilities,
  DiskSpaceInfo,
  FeedbackChoice,
  HalftimeReportData,
  MatchRecord,
  MatchStatus,
  MatchVenue,
  Opponent,
  Player,
  PlayerRoleAssignment,
  PostMatchReportRecord,
  RecommendationFeedbackRecord,
  TacticalCatalogItem,
  TacticalMemoryEntry,
} from '../types/domain';

interface ElectronBackendConnection {
  baseUrl: string;
  apiToken: string;
}

interface ElectronPreloadApi {
  getBackendConnection: () => Promise<ElectronBackendConnection>;
  getCapabilities: () => Promise<DesktopBridgeCapabilities>;
  listCaptureSources: () => Promise<CaptureSourceInfo[]>;
  getDiskSpace: (targetDir: string) => Promise<DiskSpaceInfo>;
  getRecoverableSessions: () => Promise<unknown[]>;
  minimizeWindow: () => Promise<void>;
}

declare global {
  interface Window {
    fc26Desktop?: ElectronPreloadApi;
  }
}

export interface SystemStatusResponse {
  runtime: string;
  boundHost: string;
  database: {
    dbFileName: string;
    storageMode: 'electron-user-data' | 'workspace-preview';
    dbDirectory: string;
    sizeBytes: number;
    schemaVersion: number;
    tableCounts: Record<string, number>;
  };
  gemini: {
    configured: boolean;
    defaultModel: string;
    supportedModels: string[];
    phaseNote: string;
  };
}

class DesktopBridgeService {
  // Held strictly in JS memory (never written to localStorage or sessionStorage)
  private apiBaseUrl = '';
  private apiToken: string | null = null;
  private authPromise: Promise<void> | null = null;

  public isElectron(): boolean {
    return typeof window !== 'undefined' && typeof window.fc26Desktop !== 'undefined';
  }

  private async ensureAuth(): Promise<void> {
    if (this.apiToken) return;
    if (this.authPromise) {
      await this.authPromise;
      return;
    }

    this.authPromise = (async () => {
      if (this.isElectron() && window.fc26Desktop) {
        const conn = await window.fc26Desktop.getBackendConnection();
        this.apiBaseUrl = conn.baseUrl.replace(/\/$/, '');
        this.apiToken = conn.apiToken;
      } else {
        const res = await fetch('/api/auth/session', {
          method: 'GET',
          headers: { 'X-Requested-With': 'FC26-AI-Manager' },
        });
        if (!res.ok) {
          throw new Error(`Failed to initialize backend session (${res.status})`);
        }
        const data = (await res.json()) as { token: string };
        this.apiBaseUrl = '';
        this.apiToken = data.token;
      }
    })();

    try {
      await this.authPromise;
    } finally {
      this.authPromise = null;
    }
  }

  private async authorizedFetch(pathUrl: string, options?: RequestInit): Promise<Response> {
    await this.ensureAuth();
    const targetUrl = `${this.apiBaseUrl}${pathUrl}`;
    const headers: Record<string, string> = {
      'X-Requested-With': 'FC26-AI-Manager',
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options?.headers as Record<string, string> | undefined),
    };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }

    const response = await fetch(targetUrl, {
      ...options,
      headers,
    });

    // If backend restarted in dev preview and rotated its ephemeral token, refresh once
    if (response.status === 401 && !this.isElectron()) {
      this.apiToken = null;
      await this.ensureAuth();
      const retryHeaders: Record<string, string> = {
        ...headers,
        Authorization: `Bearer ${this.apiToken ?? ''}`,
      };
      return fetch(targetUrl, {
        ...options,
        headers: retryHeaders,
      });
    }

    return response;
  }

  private async apiFetch<T>(pathUrl: string, options?: RequestInit): Promise<T> {
    const response = await this.authorizedFetch(pathUrl, options);

    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const errBody = (await response.json()) as { error?: string };
        if (errBody.error) message = errBody.error;
      } catch {
        // keep status error
      }
      throw new Error(message);
    }

    return (await response.json()) as T;
  }

  public async getCapabilities(): Promise<DesktopBridgeCapabilities> {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.getCapabilities();
    }

    return {
      environment: 'browser-preview',
      nativeWindowCapture: false,
      localFfmpegRecording: false,
      nativeDiskInspection: false,
      safeStorageAvailable: false,
      platform: 'browser',
      notice:
        'Browser Preview Environment active. Local SQLite database and tactical workspace are live; native Windows FC26 window capture requires the packaged Electron desktop runtime, and FFmpeg video recording is planned for Phase 2.',
    };
  }

  public async listCaptureSources(): Promise<{
    supported: boolean;
    sources: CaptureSourceInfo[];
    reason?: string;
  }> {
    if (this.isElectron() && window.fc26Desktop) {
      const sources = await window.fc26Desktop.listCaptureSources();
      return { supported: true, sources };
    }

    return {
      supported: false,
      sources: [],
      reason:
        'Native Windows display and FC26 window enumeration via Electron desktopCapturer is unavailable in Browser Preview.',
    };
  }

  public async getDiskSpace(targetDir: string): Promise<DiskSpaceInfo> {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.getDiskSpace(targetDir);
    }

    return {
      path: targetDir,
      availableBytes: null,
      totalBytes: null,
      isEstimate: true,
    };
  }

  public async getRecoverableSessions(): Promise<unknown[]> {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.getRecoverableSessions();
    }
    return [];
  }

  public async minimizeWindow(): Promise<boolean> {
    if (this.isElectron() && window.fc26Desktop) {
      await window.fc26Desktop.minimizeWindow();
      return true;
    }
    return false;
  }

  // Backend SQLite persistence methods
  public getSystemStatus(): Promise<SystemStatusResponse> {
    return this.apiFetch<SystemStatusResponse>('/api/system/status');
  }

  public getDashboardSummary(): Promise<DashboardSummary> {
    return this.apiFetch<DashboardSummary>('/api/dashboard');
  }

  public listClubs(): Promise<ClubWithProfile[]> {
    return this.apiFetch<ClubWithProfile[]>('/api/clubs');
  }

  public createClub(payload: {
    name: string;
    league: string;
    season: string;
    managerName: string;
    preferredPhilosophy: string;
    primaryFormation: string;
    alternativeFormation: string;
    preferredAttackingStyle: string;
    preferredDefensiveStyle: string;
    setActive?: boolean;
  }): Promise<ClubWithProfile> {
    return this.apiFetch<ClubWithProfile>('/api/clubs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public updateClub(
    clubId: string,
    payload: Partial<{
      name: string;
      league: string;
      season: string;
      managerName: string;
      preferredPhilosophy: string;
      primaryFormation: string;
      alternativeFormation: string;
      preferredAttackingStyle: string;
      preferredDefensiveStyle: string;
    }>
  ): Promise<ClubWithProfile> {
    return this.apiFetch<ClubWithProfile>(`/api/clubs/${clubId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  public activateClub(clubId: string): Promise<ClubWithProfile> {
    return this.apiFetch<ClubWithProfile>(`/api/clubs/${clubId}/activate`, { method: 'POST' });
  }

  public deleteClub(clubId: string): Promise<{ deleted: boolean }> {
    return this.apiFetch<{ deleted: boolean }>(`/api/clubs/${clubId}`, { method: 'DELETE' });
  }

  public listPlayers(clubId: string): Promise<Player[]> {
    return this.apiFetch<Player[]>(`/api/clubs/${clubId}/players`);
  }

  public createPlayer(payload: {
    clubId: string;
    name: string;
    position: string;
    overallRating: number | null;
    preferredFoot: 'Right' | 'Left' | 'Both';
    playerRole: string;
    strengths: string;
    weaknesses: string;
    preferredInstructions: string;
  }): Promise<Player> {
    return this.apiFetch<Player>('/api/players', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public updatePlayer(
    playerId: string,
    payload: Partial<Omit<Player, 'id' | 'clubId' | 'createdAt' | 'updatedAt'>>
  ): Promise<Player> {
    return this.apiFetch<Player>(`/api/players/${playerId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  public deletePlayer(playerId: string): Promise<{ deleted: boolean }> {
    return this.apiFetch<{ deleted: boolean }>(`/api/players/${playerId}`, { method: 'DELETE' });
  }

  public listOpponents(): Promise<Opponent[]> {
    return this.apiFetch<Opponent[]>('/api/opponents');
  }

  public createOpponent(payload: {
    name: string;
    league: string;
    typicalFormation: string;
    strengths: string;
    weaknesses: string;
    dangerousChannels: string;
    notes: string;
  }): Promise<Opponent> {
    return this.apiFetch<Opponent>('/api/opponents', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public updateOpponent(
    opponentId: string,
    payload: Partial<Omit<Opponent, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<Opponent> {
    return this.apiFetch<Opponent>(`/api/opponents/${opponentId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  public deleteOpponent(opponentId: string): Promise<{ deleted: boolean }> {
    return this.apiFetch<{ deleted: boolean }>(`/api/opponents/${opponentId}`, {
      method: 'DELETE',
    });
  }

  public listMatches(clubId?: string): Promise<MatchRecord[]> {
    const query = clubId ? `?clubId=${encodeURIComponent(clubId)}` : '';
    return this.apiFetch<MatchRecord[]>(`/api/matches${query}`);
  }

  public createMatch(payload: {
    clubId: string;
    careerProfileId: string;
    opponentId?: string;
    opponentName?: string;
    competition: string;
    venue: MatchVenue;
    matchDate: string;
    startingFormation: string;
    startingXiIds: string[];
    benchIds: string[];
    objective: string;
    preMatchNotes: string;
    tacticalSetup: {
      buildUpStyle: string;
      defensiveApproach: string;
      defensiveLineHeight: number;
      playerAssignments: PlayerRoleAssignment[];
    };
  }): Promise<MatchRecord> {
    return this.apiFetch<MatchRecord>('/api/matches', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public updateMatch(
    matchId: string,
    payload: {
      status?: MatchStatus;
      halftimeScoreFor?: number | null;
      halftimeScoreAgainst?: number | null;
      finalScoreFor?: number | null;
      finalScoreAgainst?: number | null;
      preMatchNotes?: string;
      objective?: string;
    }
  ): Promise<MatchRecord> {
    return this.apiFetch<MatchRecord>(`/api/matches/${matchId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  public deleteMatch(matchId: string): Promise<{ deleted: boolean }> {
    return this.apiFetch<{ deleted: boolean }>(`/api/matches/${matchId}`, { method: 'DELETE' });
  }

  public listHalftimeReports(): Promise<
    Array<{
      matchId: string;
      opponentName: string;
      competition: string;
      matchDate: string;
      report: HalftimeReportData;
    }>
  > {
    return this.apiFetch('/api/reports/halftime');
  }

  public async getHalftimeReport(matchId: string): Promise<HalftimeReportData | null> {
    const res = await this.authorizedFetch(`/api/matches/${matchId}/halftime-report`, {
      method: 'GET',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Failed to load half-time report');
    return (await res.json()) as HalftimeReportData;
  }

  public listPostMatchReports(clubId?: string): Promise<PostMatchReportRecord[]> {
    const query = clubId ? `?clubId=${encodeURIComponent(clubId)}` : '';
    return this.apiFetch<PostMatchReportRecord[]>(`/api/reports/post-match${query}`);
  }

  public listFeedback(clubId?: string): Promise<RecommendationFeedbackRecord[]> {
    const query = clubId ? `?clubId=${encodeURIComponent(clubId)}` : '';
    return this.apiFetch<RecommendationFeedbackRecord[]>(`/api/feedback${query}`);
  }

  public saveFeedback(
    matchId: string,
    choice: FeedbackChoice,
    notes: string
  ): Promise<RecommendationFeedbackRecord> {
    return this.apiFetch<RecommendationFeedbackRecord>(`/api/matches/${matchId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ choice, notes }),
    });
  }

  public listTacticalMemory(clubId: string): Promise<TacticalMemoryEntry[]> {
    return this.apiFetch<TacticalMemoryEntry[]>(`/api/clubs/${clubId}/tactical-memory`);
  }

  public createTacticalMemory(payload: {
    clubId: string;
    matchId?: string | null;
    opponentId?: string | null;
    category: TacticalMemoryEntry['category'];
    title: string;
    detail: string;
    confidence: ConfidenceLevel;
  }): Promise<TacticalMemoryEntry> {
    return this.apiFetch<TacticalMemoryEntry>('/api/tactical-memory', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public deleteTacticalMemory(id: string): Promise<{ deleted: boolean }> {
    return this.apiFetch<{ deleted: boolean }>(`/api/tactical-memory/${id}`, { method: 'DELETE' });
  }

  public listTacticalCatalog(): Promise<TacticalCatalogItem[]> {
    return this.apiFetch<TacticalCatalogItem[]>('/api/tactical-catalog');
  }

  public createTacticalCatalogItem(payload: {
    category: TacticalCatalogItem['category'];
    name: string;
    description: string;
  }): Promise<TacticalCatalogItem> {
    return this.apiFetch<TacticalCatalogItem>('/api/tactical-catalog', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public deleteTacticalCatalogItem(id: string): Promise<{ deleted: boolean }> {
    return this.apiFetch<{ deleted: boolean }>(`/api/tactical-catalog/${id}`, {
      method: 'DELETE',
    });
  }

  public getSettings(): Promise<ApplicationSettings> {
    return this.apiFetch<ApplicationSettings>('/api/settings');
  }

  public updateSettings(patch: {
    capture?: Partial<ApplicationSettings['capture']>;
    ai?: Partial<ApplicationSettings['ai']>;
    activeClubId?: string | null;
  }): Promise<ApplicationSettings> {
    return this.apiFetch<ApplicationSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  public listApiUsageLogs(): Promise<ApiUsageLog[]> {
    return this.apiFetch<ApiUsageLog[]>('/api/usage-logs');
  }

  public async exportBackup(): Promise<Blob> {
    const res = await this.authorizedFetch('/api/database/backup', { method: 'GET' });
    if (!res.ok) throw new Error('Failed to export database backup');
    return res.blob();
  }

  public restoreBackup(payload: unknown): Promise<{ restored: boolean }> {
    return this.apiFetch<{ restored: boolean }>('/api/database/restore', {
      method: 'POST',
      headers: {
        'X-FC26-Confirm-Destructive': 'true',
      },
      body: JSON.stringify(payload),
    });
  }

  public deleteAllData(): Promise<{ cleared: boolean }> {
    return this.apiFetch<{ cleared: boolean }>('/api/database/all', {
      method: 'DELETE',
      headers: {
        'X-FC26-Confirm-Destructive': 'true',
      },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
  }
}

export const desktopBridge = new DesktopBridgeService();
