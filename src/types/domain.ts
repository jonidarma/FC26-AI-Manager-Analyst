export type NavigationSection =
  | 'dashboard'
  | 'clubs'
  | 'match-prep'
  | 'match-capture'
  | 'halftime-briefing'
  | 'tactical-board'
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
  name: string;
  position: string;
  overallRating: number | null;
  preferredFoot: 'Right' | 'Left' | 'Both';
  playerRole: string;
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
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
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
  createdAt: string;
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
}

export interface DiskSpaceInfo {
  path: string;
  availableBytes: number | null;
  totalBytes: number | null;
  isEstimate: boolean;
}

export interface DesktopBridgeCapabilities {
  environment: RuntimeEnvironment;
  nativeWindowCapture: boolean;
  localFfmpegRecording: boolean;
  nativeDiskInspection: boolean;
  safeStorageAvailable: boolean;
  platform: string;
  notice: string;
}

export interface PitchNodePosition {
  slotIndex: number;
  positionCode: string;
  x: number; // 0 to 100 (left to right across pitch width)
  y: number; // 0 to 100 (top = opponent goal, bottom = own goal)
  defaultRole: string;
  defaultFocus: string;
}
