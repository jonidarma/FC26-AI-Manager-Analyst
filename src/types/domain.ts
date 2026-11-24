export type NavigationSection =
  | 'dashboard'
  | 'clubs'
  | 'match-prep'
  | 'match-capture'
  | 'halftime-briefing'
  | 'tactical-board'
  | 'database-center'
  | 'opposition'
  | 'match-reports'
  | 'match-history'
  | 'tactical-memory'
  | 'settings';

export type RuntimeEnvironment = 'electron-native' | 'browser-preview';

export type MatchVenue = 'home' | 'away' | 'neutral';

export type MatchStatus =
  | 'scheduled'
  | 'first_half_recording'
  | 'halftime_ready'
  | 'second_half_recording'
  | 'completed';

export type ConfidenceLevel = 'High' | 'Medium' | 'Low';
export type PriorityLevel = 'Critical' | 'High' | 'Medium' | 'Low';

export type FeedbackChoice =
  | 'applied_all'
  | 'applied_some'
  | 'not_applied'
  | 'custom_changes';

export interface Club {
  id: string;
  name: string;
  league: string;
  nation: string;
  catalogClubId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CareerProfile {
  id: string;
  clubId: string;
  season: string;
  managerName: string;
  preferredPhilosophy: string;
  primaryFormation: string;
  alternativeFormation: string;
  preferredAttackingStyle: string;
  preferredDefensiveStyle: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ClubWithProfile extends Club {
  profile: CareerProfile;
  playerCount: number;
  matchCount: number;
}

export interface Player {
  id: string;
  clubId: string;
  catalogPlayerId: string | null;
  name: string;
  position: string;
  overallRating: number | null;
  potentialRating: number | null;
  age: number | null;
  preferredFoot: 'Right' | 'Left' | 'Both';
  playerRole: string;
  playerFocus: string;
  contractExpiry: string | null;
  marketValueEur: number | null;
  wageEur: number | null;
  strengths: string;
  weaknesses: string;
  preferredInstructions: string;
  createdAt: string;
  updatedAt: string;
}

export interface Opponent {
  id: string;
  name: string;
  league: string;
  catalogClubId: string | null;
  typicalFormation: string;
  strengths: string;
  weaknesses: string;
  dangerousChannels: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerRoleAssignment {
  slotIndex: number;
  positionCode: string;
  playerId: string | null;
  playerName: string | null;
  role: string;
  focus: string;
}

export interface TacticalConfiguration {
  id: string;
  matchId: string | null;
  clubId: string;
  label: string;
  phase: 'pre_match' | 'halftime_recommended' | 'second_half_applied';
  formation: string;
  buildUpStyle: string;
  defensiveApproach: string;
  defensiveLineHeight: number;
  playerAssignments: PlayerRoleAssignment[];
  customParameters: Record<string, string>;
  createdAt: string;
}

export interface MatchRecord {
  id: string;
  clubId: string;
  careerProfileId: string;
  opponentId: string;
  opponentName: string;
  competition: string;
  venue: MatchVenue;
  matchDate: string;
  status: MatchStatus;
  startingFormation: string;
  startingXiIds: string[];
  benchIds: string[];
  objective: string;
  preMatchNotes: string;
  halftimeScoreFor: number | null;
  halftimeScoreAgainst: number | null;
  finalScoreFor: number | null;
  finalScoreAgainst: number | null;
  hasSecondHalfRecording: boolean;
  createdAt: string;
  updatedAt: string;
  tacticalConfiguration?: TacticalConfiguration | null;
  hasHalftimeReport?: boolean;
  hasPostMatchReport?: boolean;
}

export type RecordingIntegrityStatus =
  | 'pending'
  | 'verified'
  | 'partial'
  | 'corrupted'
  | 'unverified';

export interface MatchSession {
  id: string;
  matchId: string;
  half: 'first_half' | 'second_half';
  status: 'idle' | 'recording' | 'paused' | 'finalizing' | 'completed' | 'recovered' | 'discarded';
  captureSourceId: string | null;
  captureSourceName: string | null;
  resolution: string;
  fps: number;
  durationSeconds: number;
  totalBytes: number;
  encoder?: string | null;
  audioEnabled?: boolean;
  outputDirectory?: string | null;
  integrityStatus?: RecordingIntegrityStatus;
  recoveryNotes?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface RecordingSegment {
  id: string;
  sessionId: string;
  matchId: string;
  segmentIndex: number;
  filePath: string;
  durationSeconds: number;
  sizeBytes: number;
  checksum: string | null;
  status: 'writing' | 'finalized' | 'corrupted' | 'recovered';
  resolution?: string | null;
  fps?: number | null;
  codec?: string | null;
  hasAudio?: boolean;
  integrityStatus?: RecordingIntegrityStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt: string;
}

export interface MatchSessionWithSegments extends MatchSession {
  opponentName?: string;
  competition?: string;
  matchDate?: string;
  segments: RecordingSegment[];
}

export interface MatchObservation {
  id: string;
  matchId: string;
  half: 'first_half' | 'second_half';
  timestampLabel: string;
  category: string;
  frameReference: string | null;
  description: string;
  tacticalInterpretation: string;
  confidence: ConfidenceLevel;
  createdAt: string;
}

export interface StructuredTacticalRecommendation {
  id: string;
  matchId: string;
  halftimeReportId: string;
  currentTactic: string;
  recommendedChange: string;
  whyNecessary: string;
  expectedBenefit: string;
  potentialRisk: string;
  whenToApply: string;
  confidence: ConfidenceLevel;
  priority: PriorityLevel;
  isUnverifiedGameOption?: boolean;
}

export interface HalftimeReportData {
  id: string;
  matchId: string;
  generatedAt: string;
  modelUsed: string;
  section1MatchSituation: {
    clubName: string;
    opponentName: string;
    scoreLabel: string;
    halftimeStatus: string;
    startingFormation: string;
    observedOpponentFormation: string;
    matchObjective: string;
    overallAssessment: string;
    tacticalRatingLabel: string;
  };
  section2ManagersVerdict: string;
  section3FirstHalfPerformance: {
    attacking: string;
    defending: string;
    transitions: string;
  };
  section4WhatIsWorking: Array<{
    observation: string;
    whyEffective: string;
    continueDoing: string;
    confidence: ConfidenceLevel;
  }>;
  section5WhatIsNotWorking: Array<{
    rank: number;
    problem: string;
    evidence: string;
    tacticalExplanation: string;
    consequence: string;
    proposedSolution: string;
    confidence: ConfidenceLevel;
  }>;
  section6OpponentWeaknesses: Array<{
    strategy: string;
    evidence: string;
    executionDetail: string;
    confidence: ConfidenceLevel;
  }>;
  section7SecondHalfPlan: {
    planA: {
      formation: string;
      buildUpStyle: string;
      defensiveApproach: string;
      defensiveLine: string;
      roleChanges: string[];
      focusChanges: string[];
      pressingInstructions: string;
      attackingStrategy: string;
    };
    planB: {
      triggerCondition: string;
      adjustmentSummary: string;
    };
    planC: {
      ifLeading: string;
      ifDrawing: string;
      ifLosing: string;
    };
  };
  section8PlayerInstructions: Array<{
    playerLabel: string;
    currentRole: string;
    proposedRole: string;
    reasoning: string;
    expectedResult: string;
    downside: string;
  }>;
  section9Substitutions: Array<{
    playerOut: string;
    playerIn: string;
    tacticalReason: string;
    desiredImpact: string;
    staminaNote: string;
  }>;
  section10PriorityActions: [string, string, string];
  section11FinalInstruction: string;
  limitations: string[];
  recommendations: StructuredTacticalRecommendation[];
}

export interface RecommendationFeedbackRecord {
  id: string;
  matchId: string;
  choice: FeedbackChoice;
  notes: string;
  createdAt: string;
}

export interface PostMatchReportRecord {
  id: string;
  matchId: string;
  hasSecondHalfEvidence: boolean;
  summary: string;
  tacticalComparison: string;
  lessonsLearned: string;
  createdAt: string;
}

export interface TacticalMemoryEntry {
  id: string;
  clubId: string;
  matchId: string | null;
  opponentId: string | null;
  category: 'recurring_weakness' | 'successful_pattern' | 'formation_insight' | 'opponent_tendency';
  title: string;
  detail: string;
  evidenceCount: number;
  confidence: ConfidenceLevel;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureSettings {
  resolution: '1920x1080' | '1280x720';
  fallbackResolution: '1280x720';
  fps: number;
  bitrateKbps: number;
  format: 'mp4';
  codec: 'h264';
  audioEnabled: boolean;
  microphoneEnabled: false;
  segmentDurationMinutes: number;
  maxRecordingMinutes: number;
  storageDirectory: string;
  autoRecoveryEnabled: boolean;
}

export interface AiSettings {
  modelId: string;
  analysisQuality: 'balanced' | 'detailed' | 'compact';
  maxEvidenceFrames: number;
  removeDuplicateFrames: boolean;
  requireUploadConfirmation: boolean;
  deleteRemoteAfterAnalysis: boolean;
}

export interface ApplicationSettings {
  capture: CaptureSettings;
  ai: AiSettings;
  activeClubId: string | null;
  updatedAt: string;
}

export interface TacticalCatalogItem {
  id: string;
  category: 'formation' | 'build_up' | 'defensive_approach' | 'player_role' | 'player_focus';
  name: string;
  description: string;
  metadataJson: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface ApiUsageLog {
  id: string;
  matchId: string | null;
  modelId: string;
  stage: string;
  inputTokens: number;
  outputTokens: number;
  evidenceFramesCount: number;
  status: 'success' | 'error';
  errorMessage: string | null;
  createdAt: string;
}

export interface DashboardSummary {
  activeClub: ClubWithProfile | null;
  totalMatches: number;
  analyzedMatches: number;
  record: {
    wins: number;
    draws: number;
    losses: number;
  };
  mostUsedFormation: string | null;
  upcomingFixtures: MatchRecord[];
  recentMatches: MatchRecord[];
  recurringWeaknesses: TacticalMemoryEntry[];
  latestRecommendations: StructuredTacticalRecommendation[];
  formationBreakdown: Array<{
    formation: string;
    matches: number;
    wins: number;
    draws: number;
    losses: number;
  }>;
}

export interface CaptureSourceInfo {
  id: string;
  name: string;
  type: 'window' | 'screen';
  thumbnailDataUrl?: string;
  isFc26Candidate?: boolean;
  available?: boolean;
}

export interface DiskSpaceInfo {
  path: string;
  availableBytes: number | null;
  totalBytes: number | null;
  isEstimate: boolean;
}

export interface CapturePrerequisiteCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface CaptureEngineCapabilities {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion: string | null;
  ffmpegPathSource: 'packaged-resource' | 'dev-resource' | 'env-override' | 'system-path' | 'missing';
  h264Encoders: string[];
  preferredEncoder: string | null;
  supportedInputFormats: string[];
  aacAudioAvailable: boolean;
  recordingsRootDir: string | null;
  recordingsDirWritable: boolean;
  transportReady: boolean;
  ipcHandlersReady: boolean;
  prerequisites: CapturePrerequisiteCheck[];
  blockingReason: string | null;
  licenseNotice: string;
}

export interface DesktopBridgeCapabilities {
  environment: RuntimeEnvironment;
  nativeWindowCapture: boolean;
  localFfmpegRecording: boolean;
  nativeDiskInspection: boolean;
  safeStorageAvailable: boolean;
  platform: string;
  isPackaged?: boolean;
  notice: string;
  captureDiagnostics?: CaptureEngineCapabilities;
}

export type RecordingUiStatus =
  | 'idle'
  | 'initializing'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'interrupted'
  | 'recoverable'
  | 'recovered'
  | 'failed'
  | 'discarded';

export interface CaptureManifestSegment {
  index: number;
  fileName: string;
  filePath: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  sizeBytes: number;
  checksum: string | null;
  resolution: string | null;
  fps: number | null;
  codec: string | null;
  hasAudio: boolean;
  finalized: boolean;
  status: 'writing' | 'finalized' | 'corrupted' | 'recovered';
  integrityStatus: RecordingIntegrityStatus;
}

export interface CaptureManifest {
  manifestVersion: number;
  sessionId: string;
  matchId: string;
  half: 'first_half' | 'second_half';
  sourceId: string;
  sourceName: string;
  sourceType: 'window' | 'screen';
  resolution: string;
  fps: number;
  bitrateKbps: number;
  encoder: string;
  audioRequested: boolean;
  audioActive: boolean;
  segmentDurationMinutes: number;
  maxRecordingMinutes: number;
  outputDirectory: string;
  status: 'recording' | 'paused' | 'finalizing' | 'completed' | 'recovered' | 'discarded';
  integrityStatus: RecordingIntegrityStatus;
  activeDurationSeconds: number;
  totalBytes: number;
  nextSegmentIndex: number;
  segments: CaptureManifestSegment[];
  recoveryLog: string[];
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export interface RecordingTelemetry {
  uiStatus: RecordingUiStatus;
  sessionId: string | null;
  matchId: string | null;
  half: 'first_half' | 'second_half' | null;
  sourceId: string | null;
  sourceName: string | null;
  sourceType: 'window' | 'screen' | null;
  sourceAvailable: boolean;
  sessionElapsedSeconds: number;
  activeDurationSeconds: number;
  currentFps: number | null;
  captureResolution: string | null;
  encoder: string | null;
  currentSegmentIndex: number;
  completedSegmentCount: number;
  totalBytes: number;
  availableDiskBytes: number | null;
  diskLowWarning: boolean;
  audioRequested: boolean;
  audioActive: boolean;
  audioStatusLabel: string;
  ffmpegStatus: 'idle' | 'starting' | 'running' | 'paused' | 'finalizing' | 'stopped' | 'error';
  ffmpegPid: number | null;
  queuedChunks: number;
  queuedBytes: number;
  backpressureActive: boolean;
  outputDirectory: string | null;
  integrityStatus: RecordingIntegrityStatus;
  maxRecordingWarning: boolean;
  lastWarning: string | null;
  lastError: string | null;
  segments: CaptureManifestSegment[];
}

export interface RecoverableSessionSummary {
  sessionId: string;
  matchId: string;
  half: 'first_half' | 'second_half';
  sourceName: string;
  previousStatus: CaptureManifest['status'];
  startedAt: string;
  updatedAt: string;
  outputDirectory: string;
  manifestPath: string;
  completedSegmentsFound: number;
  partialSegmentsFound: number;
  corruptedSegmentsFound: number;
  totalBytesOnDisk: number;
  estimatedDurationSeconds: number;
  recoveryClassification: 'recoverable' | 'partially_recoverable' | 'corrupted';
  notes: string[];
}

export interface RecoveryExecutionResult {
  sessionId: string;
  matchId: string;
  half: 'first_half' | 'second_half';
  status: 'recovered' | 'discarded';
  integrityStatus: RecordingIntegrityStatus;
  classification: 'recovered' | 'partially_recovered' | 'corrupted';
  recoveredSegments: CaptureManifestSegment[];
  corruptedSegments: CaptureManifestSegment[];
  totalDurationSeconds: number;
  totalBytes: number;
  recoveryLog: string[];
}

export interface PitchNodePosition {
  slotIndex: number;
  positionCode: string;
  positionLabel?: string;
  x: number; // 0 to 100 (left to right across pitch width)
  y: number; // 0 to 100 (top = opponent goal, bottom = own goal)
  defaultRole: string;
  defaultFocus: string;
  isUserAdjusted?: boolean;
}

export type CatalogDatasetType =
  | 'nations'
  | 'leagues'
  | 'clubs'
  | 'players'
  | 'formations'
  | 'positions'
  | 'roles'
  | 'focuses'
  | 'sources';

export type DatasetCompleteness =
  | 'verified_complete'
  | 'partial_baseline'
  | 'user_imported'
  | 'empty_awaiting_user_import';

export interface CatalogSource {
  id: string;
  sourceKey: string;
  name: string;
  url: string;
  edition: string;
  licenseNotes: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogImportRun {
  id: string;
  datasetType: CatalogDatasetType;
  sourceId: string | null;
  sourceName: string | null;
  fileName: string;
  format: 'json' | 'csv';
  datasetVersion: string;
  completeness: DatasetCompleteness;
  checksum: string;
  mode: 'upsert' | 'insert_only' | 'replace_dataset';
  status: 'completed' | 'failed' | 'rolled_back';
  totalRows: number;
  insertedCount: number;
  updatedCount: number;
  rejectedCount: number;
  errors: Array<{ row: number; field: string; message: string }>;
  startedAt: string;
  completedAt: string | null;
}

export interface CatalogNation {
  id: string;
  externalSourceId: string;
  sourceName: string;
  displayName: string;
  isoCode: string;
  region: string;
  clubCount?: number;
  leagueCount?: number;
  playerCount?: number;
}

export interface CatalogLeague {
  id: string;
  externalSourceId: string;
  name: string;
  countryId: string | null;
  countryName: string;
  tier: number | null;
  category: 'mens' | 'womens' | 'mixed';
  clubCount?: number;
  playerCount?: number;
}

export interface CatalogClub {
  id: string;
  externalSourceId: string;
  name: string;
  shortName: string;
  leagueId: string | null;
  leagueName: string | null;
  nationId: string | null;
  nationName: string | null;
  teamCategory: 'mens' | 'womens';
  playerCount?: number;
}

export interface CatalogPosition {
  code: string;
  label: string;
  category: string;
  tacticalLine: 'GK' | 'DEF' | 'MID' | 'ATT';
  sortOrder: number;
}

export interface CatalogPlayer {
  id: string;
  externalSourceId: string;
  fullName: string;
  shortName: string;
  clubId: string | null;
  clubName: string | null;
  leagueId: string | null;
  leagueName: string | null;
  nationId: string | null;
  nationName: string | null;
  primaryPosition: string;
  secondaryPositions: string[];
  age: number | null;
  overallRating: number | null;
  potentialRating: number | null;
  growth: number | null;
  pace: number | null;
  shooting: number | null;
  passing: number | null;
  dribbling: number | null;
  defending: number | null;
  physicality: number | null;
  preferredFoot: 'Right' | 'Left' | 'Both' | null;
  weakFoot: number | null;
  skillMoves: number | null;
  heightCm: number | null;
  weightKg: number | null;
  marketValueEur: number | null;
  wageEur: number | null;
  contractExpiry: string | null;
  attributes: Record<string, unknown> | null;
  sourceName: string | null;
}

export interface CatalogFormationSlot {
  id: string;
  formationId: string;
  slotOrder: number;
  positionCode: string;
  positionLabel: string;
  x: number;
  y: number;
  tacticalLine: 'GK' | 'DEF' | 'MID' | 'ATT';
  isUserAdjusted: boolean;
}

export interface CatalogFormation {
  id: string;
  externalSourceId: string;
  name: string;
  code: string;
  category: string;
  defensiveShape: string;
  attackingShape: string;
  tacticalSummary: string;
  gameModes: string[];
  careerModeStatus: 'verified' | 'unverified' | 'fut_only';
  layoutVerified: boolean;
  isUserAdjusted: boolean;
  slots: CatalogFormationSlot[];
}

export interface CatalogRole {
  id: string;
  externalSourceId: string;
  name: string;
  description: string;
  positionCategory: string;
  tacticalBehavior: string;
  attackingBehavior: string;
  defensiveBehavior: string;
  isFc26New: boolean;
  verificationStatus: 'verified' | 'unverified';
  sourceReference: string;
  eligiblePositions: string[];
  compatibleFocusesByPosition: Record<string, string[]>;
}

export interface CatalogFocus {
  id: string;
  externalSourceId: string;
  name: string;
  description: string;
  tacticalPurpose: string;
  isFc26Updated: boolean;
  verificationStatus: 'verified' | 'unverified';
  sourceReference: string;
  compatibleRolesCount?: number;
}

export interface CatalogCompatibilityRow {
  roleId: string;
  roleName: string;
  positionCode: string;
  focusId: string;
  focusName: string;
  verificationStatus: 'verified' | 'unverified';
  evidence: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CatalogOverview {
  schemaVersion: number;
  counts: {
    players: number;
    clubs: number;
    mensClubs: number;
    womensClubs: number;
    leagues: number;
    nations: number;
    formations: number;
    positions: number;
    roles: number;
    focuses: number;
    rolePositionPairs: number;
    roleFocusPairs: number;
    sources: number;
    importRuns: number;
  };
  completeness: Record<
    'positions' | 'roles' | 'focuses' | 'formations' | 'nations' | 'leagues' | 'clubs' | 'players',
    DatasetCompleteness
  >;
  lastImportAt: string | null;
  sources: CatalogSource[];
  warnings: string[];
}

export interface ImportValidationError {
  row: number;
  field: string;
  message: string;
}

export type PlayerSourceProfileId =
  | 'fc26_standard_csv'
  | 'eafc26_datahub_csv'
  | 'fc26_standard_json'
  | 'eafc26_datahub_json'
  | 'unknown_schema';

export interface ImportFieldMappingInfo {
  sourceColumn: string;
  targetField: string;
  note?: string;
}

export interface ImportSchemaDiagnostics {
  profileId: PlayerSourceProfileId | string;
  profileLabel: string;
  detectedSourceKey: string | null;
  columnCount: number;
  detectedColumns: string[];
  recognizedMappings: ImportFieldMappingInfo[];
  requiredFieldsMapped: {
    name: boolean;
    position: boolean;
    nameSource: string | null;
    positionSource: string | null;
  };
  extendedAttributeColumns: string[];
  ignoredMediaColumns: string[];
  unrecognizedColumns: string[];
  schemaWarnings: string[];
}

export interface ImportPreviewResult {
  datasetType: CatalogDatasetType;
  format: 'json' | 'csv';
  checksum: string;
  totalRows: number;
  validCount: number;
  insertCount: number;
  updateCount: number;
  rejectedCount: number;
  duplicatesInFile: number;
  sampleRows: Array<Record<string, unknown>>;
  validationErrors: ImportValidationError[];
  schemaDiagnostics?: ImportSchemaDiagnostics;
}

export interface ImportExecuteResult {
  run: CatalogImportRun;
}

export interface RoleFocusValidationResult {
  valid: boolean;
  reason?: string;
  allowedRoles: string[];
  allowedFocuses: string[];
}

export interface AiMatchTacticalContext {
  matchId: string;
  clubName: string;
  opponentName: string;
  formation: {
    name: string;
    careerModeStatus: string;
    layoutVerified: boolean;
    slots: CatalogFormationSlot[];
  } | null;
  startingXi: Array<{
    slotIndex: number;
    positionCode: string;
    playerName: string | null;
    assignedRole: string;
    assignedFocus: string;
    roleFocusValid: boolean;
    careerModeOverall: number | null;
    masterCatalogOverall: number | null;
    potentialRating: number | null;
    preferredFoot: string | null;
    secondaryPositions: string[];
    faceStats: {
      pace: number | null;
      shooting: number | null;
      passing: number | null;
      dribbling: number | null;
      defending: number | null;
      physicality: number | null;
    } | null;
  }>;
  validRolesByPosition: Record<string, Record<string, string[]>>;
}
