import type {
  AiMatchTacticalContext,
  ApiUsageLog,
  ApplicationSettings,
  CaptureManifest,
  CaptureSourceInfo,
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
  CatalogSource,
  ClubWithProfile,
  ConfidenceLevel,
  DashboardSummary,
  DatasetCompleteness,
  DefaultRosterImportResult,
  DefaultRosterPreview,
  DesktopBridgeCapabilities,
  DiskSpaceInfo,
  FeedbackChoice,
  HalftimeReportData,
  ImportExecuteResult,
  ImportPreviewResult,
  MatchRecord,
  MatchSessionWithSegments,
  MatchStatus,
  MatchTacticalSnapshot,
  MatchVenue,
  Opponent,
  PaginatedResult,
  Player,
  PlayerAvailability,
  PlayerRoleAssignment,
  PostMatchReportRecord,
  RecommendationFeedbackRecord,
  RecoverableSessionSummary,
  RecordingChunkSendResult,
  RecordingDiagnosticsRecord,
  RecordingTelemetry,
  RecoveryExecutionResult,
  RendererCaptureDiagnostics,
  RoleFocusValidationResult,
  SquadStatus,
  TacticalCatalogItem,
  TacticalMemoryEntry,
  TacticalPreset,
  TacticalPresetAssignment,
} from '../types/domain';

interface ElectronBackendConnection {
  baseUrl: string;
  apiToken: string;
}

export interface StartRecordingPayload {
  matchId: string;
  half: 'first_half' | 'second_half';
  sourceId: string;
  sourceName: string;
  sourceType: 'window' | 'screen';
  resolution: '1280x720' | '1920x1080';
  fps: 20 | 30;
  bitrateKbps: number;
  segmentDurationMinutes: number;
  maxRecordingMinutes: number;
  audioRequested: boolean;
  audioActive: boolean;
  inputMimeType?: string;
}

interface ElectronPreloadApi {
  getBackendConnection: () => Promise<ElectronBackendConnection>;
  getCapabilities: () => Promise<DesktopBridgeCapabilities>;
  listCaptureSources: () => Promise<CaptureSourceInfo[]>;
  selectCaptureSource: (payload: {
    sourceId: string;
    sourceName: string;
    sourceType: 'window' | 'screen';
    audioRequested: boolean;
  }) => Promise<{
    authorized: boolean;
    sourceId?: string;
    sourceName?: string;
    sourceType?: 'window' | 'screen';
    reason?: string;
  }>;
  startRecordingSession: (req: StartRecordingPayload) => Promise<{
    sessionId: string;
    manifest: CaptureManifest;
    telemetry: RecordingTelemetry;
  }>;
  pauseRecordingSession: (sessionId: string) => Promise<RecordingTelemetry>;
  resumeRecordingSession: (payload: {
    sessionId: string;
    inputMimeType?: string;
  }) => Promise<RecordingTelemetry>;
  stopRecordingSession: (payload: {
    sessionId?: string;
    reason?: string;
  }) => Promise<{
    stopped: boolean;
    manifest: CaptureManifest | null;
    telemetry: RecordingTelemetry;
  }>;
  reportStreamInterrupted: (payload: {
    sessionId: string;
    reason: string;
  }) => Promise<{
    interrupted?: boolean;
    manifest?: CaptureManifest | null;
    telemetry?: RecordingTelemetry;
  }>;
  reportRendererDiagnostics: (payload: {
    sessionId: string;
    renderer: Partial<RendererCaptureDiagnostics>;
  }) => Promise<{ updated: boolean }>;
  reportWatchdogFailure: (payload: {
    sessionId: string;
    reason: string;
  }) => Promise<{ failed: boolean }>;
  discardRecordingSession: (payload: {
    sessionId: string;
    matchId?: string;
  }) => Promise<{ discarded: boolean; removedFiles: number }>;
  getRecordingStatus: () => Promise<RecordingTelemetry>;
  getDiskSpace: (targetDir: string) => Promise<DiskSpaceInfo>;
  getRecoverableSessions: () => Promise<RecoverableSessionSummary[]>;
  recoverSession: (sessionId: string) => Promise<RecoveryExecutionResult>;
  openRecordingSegment: (filePath: string) => Promise<{ opened: boolean; path: string }>;
  openSessionFolder: (folderPath: string) => Promise<{ opened: boolean; path: string }>;
  openDiagnosticsFolder: () => Promise<{ opened: boolean; path: string }>;
  exportSessionDiagnostics: (payload?: {
    sessionId?: string;
    matchId?: string;
  }) => Promise<{ exported: boolean; path: string }>;
  minimizeWindow: () => Promise<void>;
  isTransportPortReady: (sessionId: string) => boolean;
  sendRecordingChunk: (sessionId: string, chunk: ArrayBuffer | Uint8Array) => RecordingChunkSendResult;
  endRecordingTransport: (sessionId: string) => void;
  onTransportControl: (
    cb: (
      msg:
        | {
            type: 'backpressure';
            active: boolean;
            queuedBytes: number;
            queuedChunks: number;
          }
        | {
            type: 'port-ready';
            sessionId: string;
          }
    ) => void
  ) => () => void;
  onRecordingTelemetry: (cb: (telemetry: RecordingTelemetry) => void) => () => void;
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
        'Browser Preview Environment active. Local SQLite database and tactical workspace are live; native Windows FC26 window capture and FFmpeg segmented recording require the packaged Windows Electron desktop application.',
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

  public async selectCaptureSource(payload: {
    sourceId: string;
    sourceName: string;
    sourceType: 'window' | 'screen';
    audioRequested: boolean;
  }): Promise<{
    authorized: boolean;
    sourceId?: string;
    sourceName?: string;
    sourceType?: 'window' | 'screen';
    reason?: string;
  }> {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.selectCaptureSource(payload);
    }
    return {
      authorized: false,
      reason: 'Native capture source authorization is unavailable in Browser Preview.',
    };
  }

  public async startRecordingSession(req: StartRecordingPayload): Promise<{
    sessionId: string;
    manifest: CaptureManifest;
    telemetry: RecordingTelemetry;
  }> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Local FFmpeg video recording requires the Windows Electron desktop application.');
    }
    return window.fc26Desktop.startRecordingSession(req);
  }

  public async pauseRecordingSession(sessionId: string): Promise<RecordingTelemetry> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Native capture unavailable in Browser Preview.');
    }
    return window.fc26Desktop.pauseRecordingSession(sessionId);
  }

  public async resumeRecordingSession(payload: {
    sessionId: string;
    inputMimeType?: string;
  }): Promise<RecordingTelemetry> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Native capture unavailable in Browser Preview.');
    }
    return window.fc26Desktop.resumeRecordingSession(payload);
  }

  public async stopRecordingSession(payload: {
    sessionId?: string;
    reason?: string;
  }): Promise<{
    stopped: boolean;
    manifest: CaptureManifest | null;
    telemetry: RecordingTelemetry;
  }> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Native capture unavailable in Browser Preview.');
    }
    return window.fc26Desktop.stopRecordingSession(payload);
  }

  public async reportStreamInterrupted(payload: {
    sessionId: string;
    reason: string;
  }): Promise<{
    interrupted?: boolean;
    manifest?: CaptureManifest | null;
    telemetry?: RecordingTelemetry;
  }> {
    if (!this.isElectron() || !window.fc26Desktop) {
      return {};
    }
    return window.fc26Desktop.reportStreamInterrupted(payload);
  }

  public async discardRecordingSession(payload: {
    sessionId: string;
    matchId?: string;
  }): Promise<{ discarded: boolean; removedFiles: number }> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Native capture unavailable in Browser Preview.');
    }
    return window.fc26Desktop.discardRecordingSession(payload);
  }

  public async getRecordingStatus(): Promise<RecordingTelemetry> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Native capture unavailable in Browser Preview.');
    }
    return window.fc26Desktop.getRecordingStatus();
  }

  public isTransportPortReady(sessionId: string): boolean {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.isTransportPortReady(sessionId);
    }
    return false;
  }

  public sendRecordingChunk(
    sessionId: string,
    chunk: ArrayBuffer | Uint8Array
  ): RecordingChunkSendResult {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.sendRecordingChunk(sessionId, chunk);
    }
    return { ok: false, buffered: false, bytes: 0, error: 'Desktop transport unavailable.' };
  }

  public async reportRendererDiagnostics(payload: {
    sessionId: string;
    renderer: Partial<RendererCaptureDiagnostics>;
  }): Promise<{ updated: boolean }> {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.reportRendererDiagnostics(payload);
    }
    return { updated: false };
  }

  public async reportWatchdogFailure(payload: {
    sessionId: string;
    reason: string;
  }): Promise<{ failed: boolean }> {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.reportWatchdogFailure(payload);
    }
    return { failed: false };
  }

  public endRecordingTransport(sessionId: string): void {
    if (this.isElectron() && window.fc26Desktop) {
      window.fc26Desktop.endRecordingTransport(sessionId);
    }
  }

  public onTransportControl(
    cb: (
      msg:
        | {
            type: 'backpressure';
            active: boolean;
            queuedBytes: number;
            queuedChunks: number;
          }
        | {
            type: 'port-ready';
            sessionId: string;
          }
    ) => void
  ): () => void {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.onTransportControl(cb);
    }
    return () => undefined;
  }

  public onRecordingTelemetry(cb: (telemetry: RecordingTelemetry) => void): () => void {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.onRecordingTelemetry(cb);
    }
    return () => undefined;
  }

  public async openDiagnosticsFolder(): Promise<{ opened: boolean; path: string }> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Opening local diagnostics folder requires the Windows Electron desktop application.');
    }
    return window.fc26Desktop.openDiagnosticsFolder();
  }

  public async exportSessionDiagnostics(payload?: {
    sessionId?: string;
    matchId?: string;
  }): Promise<{ exported: boolean; path: string }> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Exporting local capture diagnostics requires the Windows Electron desktop application.');
    }
    return window.fc26Desktop.exportSessionDiagnostics(payload);
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

  public async getRecoverableSessions(): Promise<RecoverableSessionSummary[]> {
    if (this.isElectron() && window.fc26Desktop) {
      return window.fc26Desktop.getRecoverableSessions();
    }
    return [];
  }

  public async recoverSession(sessionId: string): Promise<RecoveryExecutionResult> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Crash recovery requires the Windows Electron desktop application.');
    }
    return window.fc26Desktop.recoverSession(sessionId);
  }

  public async openRecordingSegment(filePath: string): Promise<{ opened: boolean; path: string }> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Local recording playback requires the Windows Electron desktop application.');
    }
    return window.fc26Desktop.openRecordingSegment(filePath);
  }

  public async openSessionFolder(folderPath: string): Promise<{ opened: boolean; path: string }> {
    if (!this.isElectron() || !window.fc26Desktop) {
      throw new Error('Opening local folders requires the Windows Electron desktop application.');
    }
    return window.fc26Desktop.openSessionFolder(folderPath);
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
    nation?: string;
    catalogClubId?: string | null;
    season: string;
    managerName: string;
    preferredPhilosophy: string;
    primaryFormation: string;
    alternativeFormation: string;
    preferredAttackingStyle: string;
    preferredDefensiveStyle: string;
    setActive?: boolean;
    rosterInitMode?: 'default_roster' | 'empty';
  }): Promise<ClubWithProfile & { defaultRosterImport?: DefaultRosterImportResult | null }> {
    return this.apiFetch<ClubWithProfile & { defaultRosterImport?: DefaultRosterImportResult | null }>(
      '/api/clubs',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }

  public previewDefaultRosterByCatalogClub(catalogClubId: string): Promise<DefaultRosterPreview> {
    return this.apiFetch<DefaultRosterPreview>(
      `/api/catalog/clubs/${encodeURIComponent(catalogClubId)}/default-roster-preview`
    );
  }

  public previewClubDefaultRoster(clubId: string): Promise<DefaultRosterPreview> {
    return this.apiFetch<DefaultRosterPreview>(
      `/api/clubs/${encodeURIComponent(clubId)}/default-roster/preview`
    );
  }

  public importClubDefaultRoster(clubId: string): Promise<DefaultRosterImportResult> {
    return this.apiFetch<DefaultRosterImportResult>(
      `/api/clubs/${encodeURIComponent(clubId)}/default-roster/import`,
      { method: 'POST' }
    );
  }

  public updateClub(
    clubId: string,
    payload: Partial<{
      name: string;
      league: string;
      nation: string;
      catalogClubId: string | null;
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
    catalogPlayerId?: string | null;
    name: string;
    displayNameOverride?: string | null;
    shortName?: string | null;
    fullName?: string | null;
    position: string;
    secondaryPositions?: string[];
    squadNumber?: number | null;
    squadStatus?: SquadStatus;
    availability?: PlayerAvailability;
    injuryStatus?: string | null;
    suspensionStatus?: string | null;
    membershipStartDate?: string | null;
    membershipEndDate?: string | null;
    overallRating: number | null;
    potentialRating?: number | null;
    age?: number | null;
    preferredFoot: 'Right' | 'Left' | 'Both';
    playerRole: string;
    playerFocus?: string;
    contractExpiry?: string | null;
    marketValueEur?: number | null;
    wageEur?: number | null;
    strengths: string;
    weaknesses: string;
    preferredInstructions: string;
    notes?: string;
  }): Promise<Player> {
    return this.apiFetch<Player>('/api/players', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public importPlayerFromCatalog(
    clubId: string,
    payload: {
      catalogPlayerId: string;
      position?: string;
      displayNameOverride?: string | null;
      squadNumber?: number | null;
      squadStatus?: SquadStatus;
      availability?: PlayerAvailability;
      membershipStartDate?: string | null;
      overallRating?: number | null;
      potentialRating?: number | null;
      age?: number | null;
      playerRole?: string;
      playerFocus?: string;
      contractExpiry?: string | null;
      strengths?: string;
      weaknesses?: string;
      preferredInstructions?: string;
      notes?: string;
    }
  ): Promise<Player> {
    return this.apiFetch<Player>(`/api/clubs/${clubId}/players/from-catalog`, {
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

  // Phase 2.1 — Club Tactical Presets
  public listTacticalPresets(clubId: string): Promise<TacticalPreset[]> {
    return this.apiFetch<TacticalPreset[]>(`/api/clubs/${encodeURIComponent(clubId)}/tactical-presets`);
  }

  public createTacticalPreset(
    clubId: string,
    payload: {
      name: string;
      formationId?: string | null;
      formationName: string;
      buildUpStyle: string;
      defensiveApproach: string;
      defensiveLineHeight: number;
      isDefault?: boolean;
      benchPlayerIds?: string[];
      notes?: string;
      assignments: TacticalPresetAssignment[];
    }
  ): Promise<TacticalPreset> {
    return this.apiFetch<TacticalPreset>(`/api/clubs/${encodeURIComponent(clubId)}/tactical-presets`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public updateTacticalPreset(
    presetId: string,
    payload: Partial<{
      name: string;
      formationId: string | null;
      formationName: string;
      buildUpStyle: string;
      defensiveApproach: string;
      defensiveLineHeight: number;
      isDefault: boolean;
      benchPlayerIds: string[];
      notes: string;
      assignments: TacticalPresetAssignment[];
    }>
  ): Promise<TacticalPreset> {
    return this.apiFetch<TacticalPreset>(`/api/tactical-presets/${encodeURIComponent(presetId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  public duplicateTacticalPreset(presetId: string, newName?: string): Promise<TacticalPreset> {
    return this.apiFetch<TacticalPreset>(
      `/api/tactical-presets/${encodeURIComponent(presetId)}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify({ name: newName }),
      }
    );
  }

  public setDefaultTacticalPreset(presetId: string): Promise<TacticalPreset> {
    return this.apiFetch<TacticalPreset>(
      `/api/tactical-presets/${encodeURIComponent(presetId)}/set-default`,
      { method: 'POST' }
    );
  }

  public deleteTacticalPreset(presetId: string): Promise<{ deleted: boolean }> {
    return this.apiFetch<{ deleted: boolean }>(
      `/api/tactical-presets/${encodeURIComponent(presetId)}`,
      { method: 'DELETE' }
    );
  }

  public listOpponents(): Promise<Opponent[]> {
    return this.apiFetch<Opponent[]>('/api/opponents');
  }

  public createOpponent(payload: {
    name: string;
    league: string;
    catalogClubId?: string | null;
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
    sourcePresetId?: string | null;
    startingFormation: string;
    startingXiIds: string[];
    benchIds: string[];
    objective: string;
    preMatchNotes: string;
    tacticalSetup: {
      formationId?: string | null;
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

  public listMatchTacticalSnapshots(matchId: string): Promise<MatchTacticalSnapshot[]> {
    return this.apiFetch<MatchTacticalSnapshot[]>(
      `/api/matches/${encodeURIComponent(matchId)}/tactical-snapshots`
    );
  }

  public updateMatchPreMatchSnapshot(
    matchId: string,
    payload: {
      sourcePresetId?: string | null;
      formationId?: string | null;
      formationName: string;
      buildUpStyle: string;
      defensiveApproach: string;
      defensiveLineHeight: number;
      playerAssignments: PlayerRoleAssignment[];
      benchIds?: string[];
      notes?: string;
    }
  ): Promise<MatchTacticalSnapshot> {
    return this.apiFetch<MatchTacticalSnapshot>(
      `/api/matches/${encodeURIComponent(matchId)}/tactical-snapshot`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      }
    );
  }

  public createInMatchTacticalAdjustment(
    matchId: string,
    payload: {
      formationId?: string | null;
      formationName: string;
      buildUpStyle: string;
      defensiveApproach: string;
      defensiveLineHeight: number;
      playerAssignments: PlayerRoleAssignment[];
      benchIds?: string[];
      notes?: string;
    }
  ): Promise<MatchTacticalSnapshot> {
    return this.apiFetch<MatchTacticalSnapshot>(
      `/api/matches/${encodeURIComponent(matchId)}/tactical-adjustments`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
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

  // Phase 1.2 — FC 26 Master Reference Catalog API
  public getCatalogOverview(): Promise<CatalogOverview> {
    return this.apiFetch<CatalogOverview>('/api/catalog/overview');
  }

  public listCatalogSources(): Promise<CatalogSource[]> {
    return this.apiFetch<CatalogSource[]>('/api/catalog/sources');
  }

  public listCatalogImportRuns(): Promise<CatalogImportRun[]> {
    return this.apiFetch<CatalogImportRun[]>('/api/catalog/import-runs');
  }

  public listCatalogPositions(): Promise<CatalogPosition[]> {
    return this.apiFetch<CatalogPosition[]>('/api/catalog/positions');
  }

  public listCatalogNations(params?: { q?: string; region?: string }): Promise<CatalogNation[]> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.region) qs.set('region', params.region);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiFetch<CatalogNation[]>(`/api/catalog/nations${suffix}`);
  }

  public listCatalogLeagues(params?: {
    q?: string;
    countryId?: string;
    category?: string;
  }): Promise<CatalogLeague[]> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.countryId) qs.set('countryId', params.countryId);
    if (params?.category) qs.set('category', params.category);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiFetch<CatalogLeague[]>(`/api/catalog/leagues${suffix}`);
  }

  public searchCatalogClubs(params?: {
    q?: string;
    leagueId?: string;
    nationId?: string;
    teamCategory?: 'mens' | 'womens' | '';
    sortBy?: 'name' | 'code' | 'category' | 'league' | 'nation' | 'players';
    sortDir?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
  }): Promise<PaginatedResult<CatalogClub>> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.leagueId) qs.set('leagueId', params.leagueId);
    if (params?.nationId) qs.set('nationId', params.nationId);
    if (params?.teamCategory) qs.set('teamCategory', params.teamCategory);
    if (params?.sortBy) qs.set('sortBy', params.sortBy);
    if (params?.sortDir) qs.set('sortDir', params.sortDir);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiFetch<PaginatedResult<CatalogClub>>(`/api/catalog/clubs${suffix}`);
  }

  public searchCatalogPlayers(params?: {
    q?: string;
    positions?: string[];
    clubId?: string;
    leagueId?: string;
    nationId?: string;
    minOvr?: number;
    maxOvr?: number;
    minPot?: number;
    maxPot?: number;
    minAge?: number;
    maxAge?: number;
    preferredFoot?: 'Right' | 'Left' | 'Both' | '';
    sortBy?:
      | 'overall'
      | 'potential'
      | 'growth'
      | 'age'
      | 'name'
      | 'pace'
      | 'market_value'
      | 'position'
      | 'club';
    sortDir?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
  }): Promise<PaginatedResult<CatalogPlayer>> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.positions?.length) qs.set('positions', params.positions.join(','));
    if (params?.clubId) qs.set('clubId', params.clubId);
    if (params?.leagueId) qs.set('leagueId', params.leagueId);
    if (params?.nationId) qs.set('nationId', params.nationId);
    if (params?.minOvr !== undefined) qs.set('minOvr', String(params.minOvr));
    if (params?.maxOvr !== undefined) qs.set('maxOvr', String(params.maxOvr));
    if (params?.minPot !== undefined) qs.set('minPot', String(params.minPot));
    if (params?.maxPot !== undefined) qs.set('maxPot', String(params.maxPot));
    if (params?.minAge !== undefined) qs.set('minAge', String(params.minAge));
    if (params?.maxAge !== undefined) qs.set('maxAge', String(params.maxAge));
    if (params?.preferredFoot) qs.set('preferredFoot', params.preferredFoot);
    if (params?.sortBy) qs.set('sortBy', params.sortBy);
    if (params?.sortDir) qs.set('sortDir', params.sortDir);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiFetch<PaginatedResult<CatalogPlayer>>(`/api/catalog/players${suffix}`);
  }

  public getCatalogPlayerById(id: string): Promise<CatalogPlayer> {
    return this.apiFetch<CatalogPlayer>(`/api/catalog/players/${id}`);
  }

  public listCatalogFormations(params?: {
    q?: string;
    category?: string;
  }): Promise<CatalogFormation[]> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.category) qs.set('category', params.category);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiFetch<CatalogFormation[]>(`/api/catalog/formations${suffix}`);
  }

  public updateFormationSlotCoordinates(
    formationId: string,
    slots: Array<{ slotOrder: number; x: number; y: number }>
  ): Promise<CatalogFormation> {
    return this.apiFetch<CatalogFormation>(`/api/catalog/formations/${formationId}/slots`, {
      method: 'PUT',
      body: JSON.stringify({ slots }),
    });
  }

  public listCatalogRoles(positionCode?: string): Promise<CatalogRole[]> {
    const suffix = positionCode ? `?positionCode=${encodeURIComponent(positionCode)}` : '';
    return this.apiFetch<CatalogRole[]>(`/api/catalog/roles${suffix}`);
  }

  public listCatalogFocuses(params?: {
    roleName?: string;
    positionCode?: string;
  }): Promise<CatalogFocus[]> {
    const qs = new URLSearchParams();
    if (params?.roleName) qs.set('roleName', params.roleName);
    if (params?.positionCode) qs.set('positionCode', params.positionCode);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiFetch<CatalogFocus[]>(`/api/catalog/focuses${suffix}`);
  }

  public getRoleFocusCompatibility(params?: {
    positionCode?: string;
    roleName?: string;
  }): Promise<CatalogCompatibilityRow[]> {
    const qs = new URLSearchParams();
    if (params?.positionCode) qs.set('positionCode', params.positionCode);
    if (params?.roleName) qs.set('roleName', params.roleName);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiFetch<CatalogCompatibilityRow[]>(`/api/catalog/compatibility${suffix}`);
  }

  public validateRoleFocus(
    positionCode: string,
    role: string,
    focus: string
  ): Promise<RoleFocusValidationResult> {
    return this.apiFetch<RoleFocusValidationResult>('/api/catalog/validate-role-focus', {
      method: 'POST',
      body: JSON.stringify({ positionCode, role, focus }),
    });
  }

  public previewCatalogImport(payload: {
    datasetType: CatalogDatasetType;
    format: 'json' | 'csv';
    rawContent: string;
  }): Promise<ImportPreviewResult> {
    return this.apiFetch<ImportPreviewResult>('/api/catalog/import/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public executeCatalogImport(payload: {
    datasetType: CatalogDatasetType;
    format: 'json' | 'csv';
    rawContent: string;
    fileName?: string;
    sourceKey?: string;
    datasetVersion?: string;
    completeness?: DatasetCompleteness;
    mode?: 'upsert' | 'insert_only' | 'replace_dataset';
  }): Promise<ImportExecuteResult> {
    return this.apiFetch<ImportExecuteResult>('/api/catalog/import/execute', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public rollbackCatalogImportRun(
    runId: string
  ): Promise<{ rolledBack: boolean; deletedRows: number }> {
    return this.apiFetch<{ rolledBack: boolean; deletedRows: number }>(
      `/api/catalog/import-runs/${runId}/rollback`,
      { method: 'POST' }
    );
  }

  public async exportCatalogDataset(datasetType: CatalogDatasetType): Promise<Blob> {
    const res = await this.authorizedFetch(`/api/catalog/export/${datasetType}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Failed to export ${datasetType} catalog`);
    return res.blob();
  }

  public getMatchAiContext(matchId: string): Promise<AiMatchTacticalContext> {
    return this.apiFetch<AiMatchTacticalContext>(`/api/matches/${matchId}/ai-context`);
  }

  // Phase 2 — Persisted Recording Sessions & Segments
  public listRecordingSessions(params?: {
    matchId?: string;
    clubId?: string;
  }): Promise<MatchSessionWithSegments[]> {
    const qs = new URLSearchParams();
    if (params?.matchId) qs.set('matchId', params.matchId);
    if (params?.clubId) qs.set('clubId', params.clubId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiFetch<MatchSessionWithSegments[]>(`/api/recording-sessions${suffix}`);
  }

  public getRecordingSession(sessionId: string): Promise<MatchSessionWithSegments> {
    return this.apiFetch<MatchSessionWithSegments>(
      `/api/recording-sessions/${encodeURIComponent(sessionId)}`
    );
  }

  public async getRecordingSessionDiagnostics(
    sessionId: string
  ): Promise<RecordingDiagnosticsRecord | null> {
    const res = await this.authorizedFetch(
      `/api/recording-sessions/${encodeURIComponent(sessionId)}/diagnostics`,
      { method: 'GET' }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Failed to load recording diagnostics');
    return (await res.json()) as RecordingDiagnosticsRecord;
  }
}

export const desktopBridge = new DesktopBridgeService();
