import {
  AlertTriangle,
  ArrowRight,
  BookmarkPlus,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Clock3,
  Copy,
  Download,
  Edit3,
  Eye,
  Film,
  GitCompare,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { desktopBridge } from '../services/desktopBridge';
import type {
  AiAnalysisJobRecord,
  AiGameplayObservationRecord,
  AiTacticalRecommendationRecord,
  AnalysisLanguage,
  EffectiveModelRouting,
  GeminiServiceStatus,
  HalftimeReportData,
  MatchAnalysisBundle,
  MatchSessionWithSegments,
  MatchTacticalSnapshot,
  RecommendationDecisionStatus,
  VideoAnalysisMode,
} from '../types/domain';

const TERMINAL_JOB_STATUSES = new Set<AiAnalysisJobRecord['status']>([
  'completed',
  'completed_with_limitations',
  'insufficient_gameplay',
  'failed',
  'cancelled',
  'interrupted',
  'not_requested',
]);

function formatSeconds(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function extractFrameFileName(framePath: string | null): string | null {
  if (!framePath) return null;
  const parts = framePath.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : null;
}

function statusBadgeStyle(status: string): string {
  switch (status) {
    case 'completed':
    case 'valid':
    case 'compliant':
    case 'deleted':
    case 'improved':
    case 'strong':
    case 'user_accepted':
    case 'applied_in_game':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35';
    case 'completed_with_limitations':
    case 'corrected':
    case 'mixed':
    case 'user_modified':
    case 'pending':
    case 'cleanup_pending':
    case 'uploaded':
    case 'deleting':
    case 'insufficient_gameplay':
    case 'unchanged':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/35';
    case 'failed':
    case 'invalid_unsupported':
    case 'conflict':
    case 'cleanup_failed':
    case 'worsened':
    case 'weak':
    case 'user_rejected':
    case 'interrupted':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/35';
    case 'cancelled':
    case 'unknown':
    case 'unspecified':
    case 'not_uploaded':
    case 'retained_by_policy':
    case 'insufficient_evidence':
      return 'bg-white/[0.06] text-[#9AA4B4] border-white/[0.14]';
    default:
      return 'bg-sky-500/15 text-sky-300 border-sky-500/35';
  }
}

function priorityGroupLabel(group: AiTacticalRecommendationRecord['priorityGroup']): string {
  switch (group) {
    case 'immediate_correction':
      return 'Immediate Half-Time Correction';
    case 'player_change':
      return 'Player Role / Substitution';
    case 'structural_adjustment':
      return 'Structural & Vision Adjustment';
    case 'gameplay_coaching':
      return 'Gameplay Coaching';
    case 'contingency_plan':
      return 'Contingency Rule';
  }
}

type BriefingTab = 'briefing' | 'recommendations' | 'evidence' | 'comparison';

export function HalfTimeBriefingView() {
  const { matches, selectedMatchId, setSelectedMatchId, setActiveSection, settings, refreshAll } =
    useApp();
  const selectedMatch = matches.find((m) => m.id === selectedMatchId) ?? matches[0] ?? null;

  const [selectedHalf, setSelectedHalf] = useState<'first_half' | 'second_half'>('first_half');
  const [selectedJobId, setSelectedJobId] = useState<string | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<BriefingTab>('briefing');

  const [bundle, setBundle] = useState<MatchAnalysisBundle | null>(null);
  const [legacyReport, setLegacyReport] = useState<HalftimeReportData | null>(null);
  const [sessions, setSessions] = useState<MatchSessionWithSegments[]>([]);
  const [snapshots, setSnapshots] = useState<MatchTacticalSnapshot[]>([]);
  const [aiStatus, setAiStatus] = useState<GeminiServiceStatus | null>(null);
  const [effectiveRouting, setEffectiveRouting] = useState<EffectiveModelRouting | null>(null);

  const [loading, setLoading] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Launcher controls
  const [analysisMode, setAnalysisMode] = useState<VideoAnalysisMode>(
    settings?.ai.defaultAnalysisMode ?? 'balanced'
  );
  const [language, setLanguage] = useState<AnalysisLanguage>(settings?.ai.defaultLanguage ?? 'en');
  const [privacyAuthorized, setPrivacyAuthorized] = useState(false);
  const [entireDisplayAcknowledged, setEntireDisplayAcknowledged] = useState(false);
  const [forceReanalyze, setForceReanalyze] = useState(false);
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [importingClip, setImportingClip] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copiedDiagnostics, setCopiedDiagnostics] = useState(false);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Recommendation decision editing state
  const [editingRecId, setEditingRecId] = useState<string | null>(null);
  const [modifiedText, setModifiedText] = useState('');
  const [decisionNotes, setDecisionNotes] = useState('');
  const [savingDecisionId, setSavingDecisionId] = useState<string | null>(null);
  const [applyingAdjustment, setApplyingAdjustment] = useState(false);

  // Save adjustment snapshot as club preset
  const [presetModalSnapshotId, setPresetModalSnapshotId] = useState<string | null>(null);
  const [presetNameInput, setPresetNameInput] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);

  // Evidence filters & frame lightbox
  const [obsCategoryFilter, setObsCategoryFilter] = useState<string>('all');
  const [hideReplayDuplicates, setHideReplayDuplicates] = useState(false);
  const [obsSearch, setObsSearch] = useState('');
  const [lightboxState, setLightboxState] = useState<{
    title: string;
    subtitle: string;
    objectUrl: string | null;
    loading: boolean;
    error: string | null;
  } | null>(null);

  const closeLightbox = useCallback(() => {
    setLightboxState((prev) => {
      if (prev?.objectUrl) {
        URL.revokeObjectURL(prev.objectUrl);
      }
      return null;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (lightboxState?.objectUrl) {
        URL.revokeObjectURL(lightboxState.objectUrl);
      }
    };
  }, [lightboxState]);

  const loadData = useCallback(
    async (silent = false) => {
      if (!selectedMatch) {
        setBundle(null);
        setLegacyReport(null);
        setSessions([]);
        setSnapshots([]);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const [fetchedBundle, matchSessions, matchSnapshots, fetchedLegacy, modelInfo] =
          await Promise.all([
            desktopBridge.getMatchAnalysisBundle(selectedMatch.id, selectedJobId).catch(() => null),
            desktopBridge.listRecordingSessions({ matchId: selectedMatch.id }).catch(() => []),
            desktopBridge.listMatchTacticalSnapshots(selectedMatch.id).catch(() => []),
            desktopBridge.getHalftimeReport(selectedMatch.id).catch(() => null),
            desktopBridge.getAiModelRegistry().catch(() => null),
          ]);
        setBundle(fetchedBundle);
        setSessions(matchSessions);
        setSnapshots(matchSnapshots);
        setLegacyReport(fetchedLegacy);
        if (modelInfo) setAiStatus(modelInfo.status);
      } catch (err) {
        setErrorBanner(err instanceof Error ? err.message : 'Failed to load match analysis data.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [selectedMatch, selectedJobId]
  );

  useEffect(() => {
    setSelectedJobId(undefined);
    setErrorBanner(null);
    setStatusMessage(null);
  }, [selectedMatch?.id]);

  useEffect(() => {
    void loadData(false);
  }, [loadData]);

  // Keep pre-launch effective model routing synchronized with settings & selected mode
  useEffect(() => {
    let active = true;
    desktopBridge
      .getEffectiveModelRouting(analysisMode)
      .then((routing) => {
        if (active) setEffectiveRouting(routing);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [analysisMode, settings?.ai]);

  // Poll every 2 seconds while an analysis job is active, and tick live elapsed timers every 1s
  const activeJob = bundle?.activeJob ?? null;
  const isJobRunning = Boolean(activeJob && !TERMINAL_JOB_STATUSES.has(activeJob.status));

  useEffect(() => {
    if (!isJobRunning || !selectedMatch) return;
    const pollTimer = window.setInterval(() => {
      void loadData(true);
    }, 2000);
    const tickTimer = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(pollTimer);
      window.clearInterval(tickTimer);
    };
  }, [isJobRunning, selectedMatch, loadData]);

  const halfSessions = useMemo(
    () => sessions.filter((s) => s.half === selectedHalf),
    [sessions, selectedHalf]
  );

  const aiEligibleHalfSession = useMemo(
    () =>
      halfSessions.find(
        (s) => s.aiEligible && s.segments.some((seg) => seg.integrityStatus === 'verified')
      ) ?? halfSessions.find((s) => s.aiEligible),
    [halfSessions]
  );

  const verifiedHalfSession = useMemo(
    () =>
      halfSessions.find(
        (s) => s.integrityStatus === 'verified' && s.segments.some((seg) => seg.integrityStatus === 'verified')
      ),
    [halfSessions]
  );

  const requiresEntireDisplayAck = useMemo(() => {
    const src = aiEligibleHalfSession?.captureSourceName?.toLowerCase() ?? '';
    return src.includes('screen') || src.includes('display') || src.includes('entire');
  }, [aiEligibleHalfSession]);

  const totalVerifiedBytes = useMemo(
    () =>
      halfSessions.reduce(
        (acc, s) =>
          acc +
          s.segments
            .filter((seg) => seg.integrityStatus === 'verified')
            .reduce((segAcc, seg) => segAcc + seg.sizeBytes, 0),
        0
      ),
    [halfSessions]
  );

  // Determine the displayed job (selected job -> activeJob -> latest for selected half -> latest overall)
  const displayedJob = useMemo(() => {
    if (!bundle) return null;
    if (selectedJobId) {
      return bundle.jobs.find((j) => j.id === selectedJobId) ?? bundle.activeJob ?? null;
    }
    if (bundle.activeJob && bundle.activeJob.half === selectedHalf) return bundle.activeJob;
    if (selectedHalf === 'first_half' && bundle.latestFirstHalfJob) return bundle.latestFirstHalfJob;
    if (selectedHalf === 'second_half' && bundle.latestSecondHalfJob) return bundle.latestSecondHalfJob;
    return bundle.activeJob ?? bundle.latestFirstHalfJob ?? bundle.latestSecondHalfJob ?? bundle.jobs[0] ?? null;
  }, [bundle, selectedJobId, selectedHalf]);

  const retryableCleanupAssets = useMemo(
    () =>
      (bundle?.assets ?? []).filter((a) =>
        ['cleanup_failed', 'cleanup_pending', 'uploaded', 'deleting', 'pending'].includes(
          a.cleanupStatus
        )
      ),
    [bundle?.assets]
  );

  const proxySavingsSummary = useMemo(() => {
    const assets = bundle?.assets ?? [];
    let origTotal = 0;
    let procTotal = 0;
    let proxiedCount = 0;
    for (const a of assets) {
      if (a.originalSizeBytes && a.processedSizeBytes && a.processedSizeBytes < a.originalSizeBytes) {
        origTotal += a.originalSizeBytes;
        procTotal += a.processedSizeBytes;
        proxiedCount += 1;
      }
    }
    if (proxiedCount === 0) return null;
    const pct = Math.round(((origTotal - procTotal) / Math.max(1, origTotal)) * 100);
    return {
      originalMb: (origTotal / (1024 * 1024)).toFixed(1),
      uploadedMb: (procTotal / (1024 * 1024)).toFixed(1),
      reductionPct: pct,
    };
  }, [bundle?.assets]);

  const acceptedRecommendationIds = useMemo(
    () =>
      (bundle?.recommendations ?? [])
        .filter(
          (r) =>
            r.validationStatus !== 'invalid_unsupported' &&
            (r.decision?.decisionStatus === 'user_accepted' ||
              r.decision?.decisionStatus === 'user_modified' ||
              r.decision?.decisionStatus === 'applied_in_game')
        )
        .map((r) => r.id),
    [bundle?.recommendations]
  );

  const filteredObservations = useMemo(() => {
    const list = bundle?.observations ?? [];
    return list.filter((obs) => {
      if (obsCategoryFilter !== 'all' && obs.categoryGroup !== obsCategoryFilter) return false;
      if (hideReplayDuplicates && obs.isFromReplay) return false;
      if (obsSearch.trim()) {
        const q = obsSearch.trim().toLowerCase();
        const haystack = `${obs.category} ${obs.description} ${obs.playerAttribution} ${obs.supportingVisualEvidence} ${obs.inGameClock ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [bundle?.observations, obsCategoryFilter, hideReplayDuplicates, obsSearch]);

  async function handleStartAnalysis() {
    if (!selectedMatch) return;
    if (!privacyAuthorized) {
      setErrorBanner('Explicit privacy authorization is required before uploading match footage.');
      return;
    }
    if (requiresEntireDisplayAck && !entireDisplayAcknowledged) {
      setErrorBanner(
        'This recording captured an entire display. Confirm the entire-display privacy checkbox before analyzing.'
      );
      return;
    }
    setStartingAnalysis(true);
    setErrorBanner(null);
    setStatusMessage(null);
    try {
      const result = await desktopBridge.startMatchVideoAnalysis(selectedMatch.id, {
        sessionId: aiEligibleHalfSession?.id ?? null,
        half: selectedHalf,
        analysisMode,
        language,
        privacyAuthorized,
        entireDisplayAcknowledged: requiresEntireDisplayAck ? entireDisplayAcknowledged : false,
        forceReanalyze,
      });
      setSelectedJobId(result.job.id);
      setStatusMessage(
        result.reusedFromCache
          ? `Reused cached completed analysis (${result.job.id.slice(0, 8)}). Toggle "Force Re-analyze" to run a fresh analysis.`
          : `Analysis job started (${result.job.status.replace(/_/g, ' ')}). Polling live progress...`
      );
      await loadData(false);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to start match video analysis.');
    } finally {
      setStartingAnalysis(false);
    }
  }

  async function handleCancelJob(jobId: string) {
    setErrorBanner(null);
    try {
      await desktopBridge.cancelAnalysisJob(jobId);
      setStatusMessage('Cancellation requested for active analysis job.');
      await loadData(true);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to cancel analysis job.');
    }
  }

  async function handleRetryCleanup(jobId: string) {
    setErrorBanner(null);
    try {
      await desktopBridge.retryAnalysisRemoteCleanup(jobId);
      setStatusMessage('Remote Gemini file cleanup retried.');
      await loadData(true);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Remote cleanup retry failed.');
    }
  }

  async function handleImportTestClip(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !selectedMatch) return;
    setImportingClip(true);
    setErrorBanner(null);
    setStatusMessage(null);
    try {
      const imported = await desktopBridge.importBrowserPreviewTestClip(
        selectedMatch.id,
        selectedHalf,
        file
      );
      setStatusMessage(
        `Imported & verified MP4 test clip (${imported.durationSeconds.toFixed(1)}s, ${(
          imported.sizeBytes /
          (1024 * 1024)
        ).toFixed(2)} MB, ${imported.resolution ?? 'unknown resolution'}). Ready for Phase 3 analysis.`
      );
      await loadData(false);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to import MP4 test clip.');
    } finally {
      setImportingClip(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleRecommendationDecision(
    rec: AiTacticalRecommendationRecord,
    decisionStatus: RecommendationDecisionStatus,
    modifiedValue?: string | null,
    userNotes?: string
  ) {
    if (!selectedMatch) return;
    setSavingDecisionId(rec.id);
    setErrorBanner(null);
    try {
      await desktopBridge.saveRecommendationDecision(selectedMatch.id, rec.id, {
        decisionStatus,
        modifiedValue: modifiedValue ?? null,
        appliedInGame: decisionStatus === 'applied_in_game',
        userNotes: userNotes ?? rec.decision?.userNotes ?? '',
      });
      setEditingRecId(null);
      await loadData(true);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to save recommendation decision.');
    } finally {
      setSavingDecisionId(null);
    }
  }

  async function handleApplyAcceptedToSnapshot() {
    if (!selectedMatch || !displayedJob || acceptedRecommendationIds.length === 0) return;
    setApplyingAdjustment(true);
    setErrorBanner(null);
    setStatusMessage(null);
    try {
      const snapshot = await desktopBridge.applyAcceptedRecommendationsToAdjustment(
        selectedMatch.id,
        {
          jobId: displayedJob.id,
          recommendationIds: acceptedRecommendationIds,
          appliedInGameConfirmed: false,
          notes: `Applied ${acceptedRecommendationIds.length} accepted Phase 3 recommendation(s) from ${displayedJob.half.replace('_', ' ')} analysis.`,
        }
      );
      setStatusMessage(
        `Created Half-Time Adjustment Snapshot (${snapshot.formationName}). Original pre-match snapshot remains immutable.`
      );
      await loadData(true);
      await refreshAll();
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Failed to create half-time adjustment snapshot.'
      );
    } finally {
      setApplyingAdjustment(false);
    }
  }

  async function handleToggleConfirmAppliedInGame(snapshot: MatchTacticalSnapshot) {
    if (!selectedMatch) return;
    setErrorBanner(null);
    try {
      await desktopBridge.confirmSnapshotAppliedInGame(
        selectedMatch.id,
        snapshot.id,
        !snapshot.appliedInGameConfirmed
      );
      setStatusMessage(
        !snapshot.appliedInGameConfirmed
          ? 'Confirmed adjustment was manually applied inside EA SPORTS FC 26.'
          : 'Cleared in-game application confirmation.'
      );
      await loadData(true);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to update confirmation.');
    }
  }

  async function handleSaveSnapshotAsPreset() {
    if (!selectedMatch || !presetModalSnapshotId || !presetNameInput.trim()) return;
    setSavingPreset(true);
    setErrorBanner(null);
    try {
      const created = await desktopBridge.saveAdjustmentAsNewClubPreset(selectedMatch.id, {
        snapshotId: presetModalSnapshotId,
        presetName: presetNameInput.trim(),
      });
      setStatusMessage(`Saved adjustment as new Club Tactical Preset "${created.name}".`);
      setPresetModalSnapshotId(null);
      setPresetNameInput('');
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to save club tactical preset.');
    } finally {
      setSavingPreset(false);
    }
  }

  async function handleOpenEvidenceFrame(obs: AiGameplayObservationRecord) {
    if (!selectedMatch) return;
    const fileName = extractFrameFileName(obs.evidenceFramePath);
    if (!fileName) return;
    setLightboxState({
      title: `${obs.category} (${formatSeconds(obs.sessionStartSeconds)}–${formatSeconds(obs.sessionEndSeconds)})`,
      subtitle: obs.description,
      objectUrl: null,
      loading: true,
      error: null,
    });
    try {
      const url = await desktopBridge.fetchEvidenceFrameObjectUrl(selectedMatch.id, fileName);
      setLightboxState((prev) =>
        prev ? { ...prev, objectUrl: url, loading: false, error: null } : null
      );
    } catch (err) {
      setLightboxState((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              error: err instanceof Error ? err.message : 'Failed to load evidence frame.',
            }
          : null
      );
    }
  }

  function handleExportBundleJson() {
    if (!selectedMatch) return;
    const payload = bundle?.briefing ? bundle : legacyReport;
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fc26-analysis-${selectedMatch.matchDate}-${selectedMatch.opponentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const briefing = bundle?.briefing ?? null;
  const visionAssessment = bundle?.visionAssessment ?? null;
  const recommendations = bundle?.recommendations ?? [];
  const secondHalfComparison = bundle?.secondHalfComparison ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">
            Half-Time &amp; Post-Half AI Tactical Briefing
          </h1>
          <p className="mt-1 text-[13px] text-[#9AA4B4]">
            Evidence-anchored Gemini video intelligence, 3-layer Tactical Vision evaluation, and
            server-validated FC26 tactical adjustments.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {matches.length > 0 && (
            <select
              value={selectedMatch?.id ?? ''}
              onChange={(e) => setSelectedMatchId(e.target.value)}
              className="bg-[#12151B] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
            >
              {matches.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.matchDate} · {m.venue === 'home' ? 'vs' : '@'} {m.opponentName} (
                  {m.startingFormation})
                </option>
              ))}
            </select>
          )}

          <div className="inline-flex rounded-md border border-white/[0.12] bg-[#12151B] p-0.5">
            {(['first_half', 'second_half'] as const).map((half) => (
              <button
                key={half}
                type="button"
                onClick={() => {
                  setSelectedHalf(half);
                  setSelectedJobId(undefined);
                }}
                className={`px-3 py-1.5 rounded text-[12px] font-medium transition-colors ${
                  selectedHalf === half
                    ? 'bg-emerald-600 text-white'
                    : 'text-[#9AA4B4] hover:text-white'
                }`}
              >
                {half === 'first_half' ? 'First Half' : 'Second Half'}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void loadData(false)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[12px] text-[#D7DDE7]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          {(briefing || legacyReport) && (
            <button
              type="button"
              onClick={handleExportBundleJson}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[12px] text-white"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSON
            </button>
          )}
        </div>
      </div>

      {/* Banners */}
      {errorBanner && (
        <div className="border border-rose-500/40 bg-rose-500/10 rounded-lg px-4 py-3 text-[13px] text-rose-200 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button type="button" onClick={() => setErrorBanner(null)} className="text-rose-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {statusMessage && (
        <div className="border border-emerald-500/35 bg-emerald-500/10 rounded-lg px-4 py-3 text-[13px] text-emerald-200 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
            <span>{statusMessage}</span>
          </div>
          <button type="button" onClick={() => setStatusMessage(null)} className="text-emerald-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!selectedMatch ? (
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-8 text-[14px] text-[#9AA4B4]">
          No matches created yet. Prepare a match in{' '}
          <button
            type="button"
            onClick={() => setActiveSection('match-prep')}
            className="text-emerald-400 underline"
          >
            Match Preparation
          </button>{' '}
          first.
        </div>
      ) : (
        <>
          {/* Launcher + Recording Verification + Browser Preview Test Clip Card */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-mono uppercase tracking-wider text-[#8A94A6]">
                  {selectedMatch.matchDate} · {selectedMatch.venue === 'home' ? 'vs' : '@'}{' '}
                  {selectedMatch.opponentName} · {selectedMatch.startingFormation} ·{' '}
                  {selectedHalf === 'first_half' ? 'First Half Pipeline' : 'Second Half Pipeline'}
                </div>
                <h2 className="mt-0.5 text-[16px] font-semibold text-white">
                  Gemini Video Analysis Launcher &amp; Recording Verification
                </h2>
              </div>

              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,.mp4"
                  onChange={handleImportTestClip}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={importingClip}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/[0.14] hover:border-sky-400/60 bg-[#0E1116] text-[12px] text-[#D7DDE7] disabled:opacity-50"
                >
                  {importingClip ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Upload className="w-3.5 h-3.5 text-sky-400" />
                  )}
                  Import MP4 Test Clip (Browser Preview)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSection('match-capture')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[12px] text-[#9AA4B4] hover:text-white"
                >
                  <Film className="w-3.5 h-3.5" />
                  Match Capture
                </button>
              </div>
            </div>

            {/* 3-State Recording Verification Strip */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[#8A94A6]">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  1. Recording Verified
                </div>
                <div className="mt-1 text-[13px] font-semibold text-white">
                  {verifiedHalfSession ? 'Verified Locally (FFprobe + SHA-256)' : 'No Verified Footage'}
                </div>
                <div className="mt-0.5 text-[11px] text-[#8A94A6]">
                  {verifiedHalfSession
                    ? `${verifiedHalfSession.segments.filter((s) => s.integrityStatus === 'verified').length} verified MP4 segment(s) · ${(totalVerifiedBytes / (1024 * 1024)).toFixed(2)} MB`
                    : `Record ${selectedHalf.replace('_', ' ')} in Match Capture or import a test MP4 clip.`}
                </div>
              </div>

              <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[#8A94A6]">
                  <CheckCircle2 className="w-3.5 h-3.5 text-sky-400" />
                  2. Technically AI-Eligible
                </div>
                <div className="mt-1 text-[13px] font-semibold text-white">
                  {aiEligibleHalfSession ? 'Eligible for Video Analysis' : 'Not Eligible Yet'}
                </div>
                <div className="mt-0.5 text-[11px] text-[#8A94A6]">
                  {aiEligibleHalfSession
                    ? `Source: ${aiEligibleHalfSession.captureSourceName || 'Verified MP4'} · Stays local until launched.`
                    : 'Requires a verified non-zero H.264 MP4 recording.'}
                </div>
              </div>

              <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[#8A94A6]">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  3. Gemini API &amp; Analysis State
                </div>
                <div className="mt-1 text-[13px] font-semibold text-white flex items-center gap-2">
                  <span>
                    {displayedJob
                      ? displayedJob.status.replace(/_/g, ' ')
                      : aiEligibleHalfSession
                        ? 'Ready to Analyze'
                        : 'Awaiting Footage'}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-[#8A94A6]">
                  {aiStatus?.configured
                    ? `Server GEMINI_API_KEY configured · Default: ${aiStatus.defaultModel}`
                    : 'Server GEMINI_API_KEY not configured in environment (.env).'}
                </div>
              </div>
            </div>

            {aiStatus && !aiStatus.configured && (
              <div className="border border-amber-500/35 bg-amber-500/10 rounded-md px-3.5 py-2.5 text-[12px] text-amber-200 flex items-center justify-between gap-3">
                <span>
                  <strong>Server-side GEMINI_API_KEY is not set.</strong> Live Gemini analysis
                  requires setting <code className="font-mono text-amber-100">GEMINI_API_KEY</code>{' '}
                  in your environment variables or local <code className="font-mono text-amber-100">.env</code>{' '}
                  file (API keys are never entered in the UI).
                </span>
                <button
                  type="button"
                  onClick={() => setActiveSection('settings')}
                  className="shrink-0 px-2.5 py-1 rounded border border-amber-400/40 text-amber-100 hover:bg-amber-500/20 text-[11px]"
                >
                  Open AI Settings
                </button>
              </div>
            )}

            {/* Pre-Launch Effective Model Routing Preview (shown BEFORE upload authorization) */}
            {effectiveRouting && (
              <div className="rounded-md border border-white/[0.08] bg-[#0C0F14] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-[11px] uppercase tracking-wider text-[#7D8798]">
                    Effective Routing ({analysisMode}):
                  </span>
                  <span className="font-mono text-emerald-300">
                    Video: {effectiveRouting.effectiveVideoModelId || 'Not configured'}
                  </span>
                  <span className="font-mono text-sky-300">
                    Synthesis: {effectiveRouting.effectiveSynthesisModelId || 'Not configured'}
                  </span>
                  <span className="text-[11px] text-[#8A94A6]">
                    (
                    {effectiveRouting.usePrimaryModelForAllStages
                      ? 'Primary Model for All Stages'
                      : 'Stage-Specific Overrides'}
                    )
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveSection('settings')}
                  className="text-[11px] text-[#9AA4B4] hover:text-white underline"
                >
                  Change Models
                </button>
              </div>
            )}

            {effectiveRouting && effectiveRouting.warnings.length > 0 && (
              <div className="rounded-md border border-amber-500/35 bg-amber-500/10 px-3.5 py-2 text-[12px] text-amber-200">
                {effectiveRouting.warnings.join(' ')}
              </div>
            )}

            {/* Launch Controls */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 pt-2 border-t border-white/[0.06] items-end">
              <div className="lg:col-span-3">
                <label className="block text-[11px] uppercase tracking-wider text-[#8A94A6] mb-1">
                  Analysis Mode
                </label>
                <select
                  value={analysisMode}
                  onChange={(e) => setAnalysisMode(e.target.value as VideoAnalysisMode)}
                  className="w-full bg-[#0E1116] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                >
                  <option value="quick">Quick Half-Time (Fastest / Low Cost)</option>
                  <option value="balanced">Balanced Analyst (Recommended)</option>
                  <option value="deep">Deep Tactical Breakdown</option>
                </select>
              </div>

              <div className="lg:col-span-2">
                <label className="block text-[11px] uppercase tracking-wider text-[#8A94A6] mb-1">
                  Output Language
                </label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as AnalysisLanguage)}
                  className="w-full bg-[#0E1116] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                >
                  <option value="en">English (EN)</option>
                  <option value="id">Bahasa Indonesia (ID)</option>
                </select>
              </div>

              <div className="lg:col-span-4 space-y-1.5 text-[12px] text-[#C5CCD7]">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={privacyAuthorized}
                    onChange={(e) => setPrivacyAuthorized(e.target.checked)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <span>
                    I explicitly authorize uploading this verified {selectedHalf.replace('_', ' ')}{' '}
                    footage to Google Gemini API (remote files deleted automatically after analysis).
                  </span>
                </label>

                {requiresEntireDisplayAck && (
                  <label className="flex items-start gap-2 cursor-pointer text-amber-200">
                    <input
                      type="checkbox"
                      checked={entireDisplayAcknowledged}
                      onChange={(e) => setEntireDisplayAcknowledged(e.target.checked)}
                      className="mt-0.5 accent-amber-500"
                    />
                    <span>
                      Entire-display capture detected: I confirm no sensitive desktop windows are
                      exposed in this recording.
                    </span>
                  </label>
                )}

                <label className="flex items-center gap-2 cursor-pointer text-[#8A94A6]">
                  <input
                    type="checkbox"
                    checked={forceReanalyze}
                    onChange={(e) => setForceReanalyze(e.target.checked)}
                    className="accent-sky-500"
                  />
                  <span>Force fresh re-analysis (bypass cached identical fingerprint)</span>
                </label>
              </div>

              <div className="lg:col-span-3 flex flex-col gap-2">
                <button
                  type="button"
                  disabled={
                    startingAnalysis ||
                    isJobRunning ||
                    !aiEligibleHalfSession ||
                    !privacyAuthorized ||
                    (requiresEntireDisplayAck && !entireDisplayAcknowledged)
                  }
                  onClick={() => void handleStartAnalysis()}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-white/[0.08] disabled:text-[#6B7485] text-white text-[13px] font-semibold transition-colors"
                >
                  {startingAnalysis || isJobRunning ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  {isJobRunning
                    ? 'Analysis In Progress...'
                    : selectedHalf === 'first_half'
                      ? 'Analyze First Half'
                      : 'Analyze Second Half'}
                </button>
              </div>
            </div>
          </section>

          {/* Job History & Live 17-State Progress Tracker */}
          {displayedJob && (
            <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span
                    className={`px-2.5 py-1 rounded border text-[11px] font-mono uppercase ${statusBadgeStyle(
                      displayedJob.status
                    )}`}
                  >
                    {displayedJob.status.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[13px] font-medium text-white">
                    {displayedJob.progressDetail?.stageLabel || displayedJob.currentStage}
                  </span>
                  <span className="text-[12px] text-[#8A94A6] font-mono">
                    {displayedJob.half.replace('_', ' ')} · {displayedJob.analysisMode} ·{' '}
                    {displayedJob.language.toUpperCase()}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {(bundle?.jobs.length ?? 0) > 1 && (
                    <select
                      value={displayedJob.id}
                      onChange={(e) => setSelectedJobId(e.target.value)}
                      className="bg-[#0E1116] border border-white/[0.12] rounded px-2.5 py-1 text-[12px] text-[#C5CCD7] font-mono"
                    >
                      {bundle?.jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.createdAt.slice(0, 16).replace('T', ' ')} · {j.half} · {j.status}
                        </option>
                      ))}
                    </select>
                  )}

                  {!TERMINAL_JOB_STATUSES.has(displayedJob.status) && (
                    <button
                      type="button"
                      onClick={() => void handleCancelJob(displayedJob.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-rose-500/40 text-rose-300 hover:bg-rose-500/10 text-[12px]"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Cancel Job
                    </button>
                  )}

                  {retryableCleanupAssets.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleRetryCleanup(displayedJob.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-amber-500/40 text-amber-200 hover:bg-amber-500/10 text-[12px]"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Retry Remote Cleanup ({retryableCleanupAssets.length})
                    </button>
                  )}
                </div>
              </div>

              {/* Honest Progress & Live Telemetry Strip (No Fabricated % or ETA) */}
              {(() => {
                const runningThisJob = !TERMINAL_JOB_STATUSES.has(displayedJob.status);
                const startedMs = displayedJob.startedAt ? Date.parse(displayedJob.startedAt) : NaN;
                const stageStartedMs = displayedJob.stageStartedAt
                  ? Date.parse(displayedJob.stageStartedAt)
                  : NaN;
                const totalElapsedSec =
                  runningThisJob && Number.isFinite(startedMs)
                    ? Math.max(0, (liveNowMs - startedMs) / 1000)
                    : displayedJob.elapsedMs / 1000;
                const stageElapsedSec =
                  runningThisJob && Number.isFinite(stageStartedMs)
                    ? Math.max(0, (liveNowMs - stageStartedMs) / 1000)
                    : null;
                const totalSegs = Math.max(1, displayedJob.segmentsTotal);
                const completedSegs = Math.min(totalSegs, displayedJob.segmentsProcessed);
                const activeSegNum =
                  displayedJob.currentSegmentIndex ?? displayedJob.progressDetail?.currentSegmentIndex ?? null;

                return (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 text-[11px] font-mono">
                      <div className="rounded border border-white/[0.07] bg-[#0C0F14] px-2.5 py-2">
                        <div className="text-[#7D8798] uppercase text-[10px]">Active Segment</div>
                        <div className="text-white mt-0.5">
                          {activeSegNum ? `Seg ${activeSegNum} / ${totalSegs}` : `${completedSegs} / ${totalSegs} done`}
                        </div>
                      </div>
                      <div className="rounded border border-white/[0.07] bg-[#0C0F14] px-2.5 py-2">
                        <div className="text-[#7D8798] uppercase text-[10px]">Models Used</div>
                        <div className="text-emerald-300 mt-0.5 truncate" title={`Video: ${displayedJob.modelVideoId} | Synthesis: ${displayedJob.modelSynthesisId}`}>
                          {displayedJob.modelVideoId}
                          {displayedJob.modelSynthesisId !== displayedJob.modelVideoId
                            ? ` -> ${displayedJob.modelSynthesisId}`
                            : ''}
                        </div>
                      </div>
                      <div className="rounded border border-white/[0.07] bg-[#0C0F14] px-2.5 py-2">
                        <div className="text-[#7D8798] uppercase text-[10px]">Elapsed (Total / Stage)</div>
                        <div className="text-white mt-0.5 tabular-nums">
                          {totalElapsedSec.toFixed(1)}s
                          {stageElapsedSec !== null ? ` · stage ${stageElapsedSec.toFixed(0)}s` : ''}
                        </div>
                      </div>
                      <div className="rounded border border-white/[0.07] bg-[#0C0F14] px-2.5 py-2">
                        <div className="text-[#7D8798] uppercase text-[10px]">Cost / Cap</div>
                        <div className="text-white mt-0.5 tabular-nums">
                          Est ${displayedJob.estimatedCostUsd.toFixed(4)}
                          {displayedJob.actualCostUsd !== null
                            ? ` · Act $${displayedJob.actualCostUsd.toFixed(4)}`
                            : ''}{' '}
                          / ${displayedJob.budgetCapUsd.toFixed(2)}
                        </div>
                      </div>
                      <div className="rounded border border-white/[0.07] bg-[#0C0F14] px-2.5 py-2">
                        <div className="text-[#7D8798] uppercase text-[10px]">Activity / Retries</div>
                        <div className="text-[#C5CCD7] mt-0.5 truncate">
                          {displayedJob.retryAttempt && displayedJob.retryAttempt > 0
                            ? `Retry #${displayedJob.retryAttempt} · `
                            : ''}
                          {displayedJob.lastActivityAt
                            ? new Date(displayedJob.lastActivityAt).toLocaleTimeString()
                            : new Date(displayedJob.updatedAt).toLocaleTimeString()}
                        </div>
                      </div>
                    </div>

                    {/* Discrete per-segment status blocks + indeterminate live activity indicator */}
                    <div className="flex items-center gap-1.5">
                      {Array.from({ length: totalSegs }, (_, idx) => {
                        const segNum = idx + 1;
                        const isDone =
                          displayedJob.status === 'completed' ||
                          displayedJob.status === 'completed_with_limitations' ||
                          displayedJob.status === 'insufficient_gameplay' ||
                          segNum <= completedSegs;
                        const isCurrent = runningThisJob && activeSegNum === segNum && !isDone;
                        const isFailedSeg =
                          (displayedJob.status === 'failed' ||
                            displayedJob.status === 'interrupted') &&
                          (activeSegNum === segNum || (!activeSegNum && segNum === completedSegs + 1));
                        return (
                          <div
                            key={segNum}
                            title={`Segment ${segNum} of ${totalSegs}`}
                            className={`h-2 flex-1 rounded-full transition-colors ${
                              isFailedSeg
                                ? 'bg-rose-500'
                                : isDone
                                  ? 'bg-emerald-500'
                                  : isCurrent
                                    ? 'bg-sky-400 animate-pulse'
                                    : 'bg-white/[0.08]'
                            }`}
                          />
                        );
                      })}
                    </div>

                    {runningThisJob && (
                      <div className="flex items-center justify-between text-[11px] text-[#8A94A6]">
                        <span className="inline-flex items-center gap-1.5">
                          <Loader2 className="w-3 h-3 animate-spin text-sky-400" />
                          {displayedJob.progressDetail?.stageLabel ||
                            displayedJob.progressDetail?.note ||
                            `Executing ${displayedJob.currentStage}...`}
                        </span>
                        <span className="font-mono text-[10px] text-[#6F7A8C]">
                          {completedSegs}/{totalSegs} segment(s) finished · live network/model stage in progress
                        </span>
                      </div>
                    )}

                    {proxySavingsSummary && (
                      <div className="text-[11px] font-mono text-[#9AA4B4]">
                        Analysis Upload Proxy: {proxySavingsSummary.originalMb} MB original →{' '}
                        <span className="text-emerald-300">{proxySavingsSummary.uploadedMb} MB uploaded</span>{' '}
                        ({proxySavingsSummary.reductionPct}% smaller · original recording untouched)
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Truthful Status Explanations for Special Terminal States */}
              {displayedJob.status === 'insufficient_gameplay' && (
                <div className="border border-amber-500/35 bg-amber-500/10 rounded-md p-3.5 text-[13px] text-amber-100">
                  <div className="font-semibold flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-amber-300" />
                    Insufficient Live Gameplay Detected — Zero Events Fabricated
                  </div>
                  <p className="mt-1 text-[12px] text-amber-200/90">
                    Stage 1 classification found primarily menus, pause screens, cutscenes, or
                    non-gameplay footage ({displayedJob.coverageSummary || 'no sustained live gameplay'}).
                    No tactical events or half-time recommendations were invented.
                  </p>
                </div>
              )}

              {(displayedJob.status === 'failed' ||
                displayedJob.status === 'interrupted' ||
                displayedJob.status === 'cancelled') && (
                <div className="border border-rose-500/35 bg-rose-500/10 rounded-md p-3.5 text-[13px] text-rose-100 space-y-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold">
                        {displayedJob.status === 'interrupted'
                          ? `Analysis Interrupted (${displayedJob.errorCode ?? 'ANALYSIS_INTERRUPTED'})`
                          : displayedJob.status === 'cancelled'
                            ? `Analysis Cancelled by Manager (${displayedJob.errorCode ?? 'ANALYSIS_CANCELLED'})`
                            : `Analysis Failed${displayedJob.errorCode ? ` (${displayedJob.errorCode})` : ''}`}
                      </div>
                      {displayedJob.errorMessage && (
                        <p className="mt-1 text-[12px] text-rose-200/90">
                          {displayedJob.errorMessage}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowDiagnostics((prev) => !prev)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-rose-400/35 bg-[#0C0F14]/70 hover:bg-[#0C0F14] text-[11px] text-rose-200"
                      >
                        <Terminal className="w-3 h-3" />
                        Technical Diagnostics
                        {showDiagnostics ? (
                          <ChevronUp className="w-3 h-3" />
                        ) : (
                          <ChevronDown className="w-3 h-3" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const payload = {
                            jobId: displayedJob.id,
                            status: displayedJob.status,
                            half: displayedJob.half,
                            analysisMode: displayedJob.analysisMode,
                            modelVideoId: displayedJob.modelVideoId,
                            modelSynthesisId: displayedJob.modelSynthesisId,
                            currentStage: displayedJob.currentStage,
                            errorCode: displayedJob.errorCode,
                            errorMessage: displayedJob.errorMessage,
                            elapsedMs: displayedJob.elapsedMs,
                            retryAttempt: displayedJob.retryAttempt ?? 0,
                            diagnostics: displayedJob.diagnostics ?? null,
                            remoteAssets: (bundle?.assets ?? []).map((a) => ({
                              segmentId: a.segmentId,
                              cleanupStatus: a.cleanupStatus,
                              cleanupAttempts: a.cleanupAttempts ?? 0,
                              cleanupError: a.cleanupError,
                            })),
                          };
                          void navigator.clipboard
                            .writeText(JSON.stringify(payload, null, 2))
                            .then(() => {
                              setCopiedDiagnostics(true);
                              window.setTimeout(() => setCopiedDiagnostics(false), 2000);
                            });
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.14] bg-[#0C0F14]/70 hover:bg-[#0C0F14] text-[11px] text-[#D7DDE7]"
                      >
                        {copiedDiagnostics ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        {copiedDiagnostics ? 'Copied' : 'Copy Diagnostics'}
                      </button>
                    </div>
                  </div>

                  {showDiagnostics && (
                    <div className="rounded border border-white/[0.1] bg-[#0A0D12] p-3 font-mono text-[11px] text-[#C5CCD7] space-y-1.5">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <div>
                          <span className="text-[#7D8798]">Code: </span>
                          <span className="text-rose-300">
                            {displayedJob.diagnostics?.code ?? displayedJob.errorCode ?? '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#7D8798]">HTTP / API: </span>
                          <span>
                            {displayedJob.diagnostics?.httpStatus ?? '—'} /{' '}
                            {displayedJob.diagnostics?.apiStatus ?? '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#7D8798]">Stage: </span>
                          <span>{displayedJob.diagnostics?.stage ?? displayedJob.currentStage}</span>
                        </div>
                        <div>
                          <span className="text-[#7D8798]">Model: </span>
                          <span className="text-amber-300">
                            {displayedJob.diagnostics?.modelId ?? displayedJob.modelVideoId}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#7D8798]">Segment: </span>
                          <span>
                            {displayedJob.diagnostics?.segmentIndex ??
                              displayedJob.currentSegmentIndex ??
                              '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#7D8798]">Attempt: </span>
                          <span>
                            {displayedJob.diagnostics?.attemptNumber ??
                              displayedJob.retryAttempt ??
                              1}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#7D8798]">Retryable: </span>
                          <span>
                            {displayedJob.diagnostics
                              ? displayedJob.diagnostics.retryable
                                ? 'Yes'
                                : 'No (Permanent)'
                              : '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#7D8798]">Elapsed: </span>
                          <span>
                            {(
                              (displayedJob.diagnostics?.elapsedMs ?? displayedJob.elapsedMs) / 1000
                            ).toFixed(1)}
                            s
                          </span>
                        </div>
                      </div>
                      {displayedJob.diagnostics?.upstreamMessage && (
                        <div className="pt-1.5 border-t border-white/[0.08] text-rose-200/90 break-words">
                          <span className="text-[#7D8798]">Sanitized Upstream: </span>
                          {displayedJob.diagnostics.upstreamMessage}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Durable Remote Cleanup Verification Strip */}
              {(bundle?.assets.length ?? 0) > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-[#8A94A6]">
                  <span className="uppercase tracking-wider">Remote Media Cleanup:</span>
                  {bundle?.assets.map((asset, idx) => (
                    <span
                      key={asset.id}
                      title={asset.cleanupError || `Remote status: ${asset.cleanupStatus}`}
                      className={`px-2 py-0.5 rounded border font-mono ${statusBadgeStyle(
                        asset.cleanupStatus
                      )}`}
                    >
                      Seg #{idx + 1}: {asset.cleanupStatus}
                      {asset.cleanupAttempts && asset.cleanupAttempts > 1
                        ? ` (${asset.cleanupAttempts} tries)`
                        : ''}
                    </span>
                  ))}
                  <span className="text-[10px] text-[#6F7A8C]">
                    (Local recordings on disk are never deleted)
                  </span>
                </div>
              )}
            </section>
          )}

          {/* Phase 3 Completed Executive Briefing Workbench */}
          {briefing ? (
            <div className="space-y-5">
              {/* Sub-Tabs */}
              <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.08] pb-3">
                {(
                  [
                    ['briefing', 'Executive Briefing & Vision', Layers],
                    [
                      'recommendations',
                      `Recommendations & Decisions (${recommendations.length})`,
                      ClipboardCheck,
                    ],
                    [
                      'evidence',
                      `Evidence Timeline & Frames (${bundle?.observations.length ?? 0})`,
                      Eye,
                    ],
                    ...(secondHalfComparison
                      ? ([['comparison', 'Second-Half Comparison', GitCompare]] as const)
                      : []),
                  ] as Array<[BriefingTab, string, typeof Layers]>
                ).map(([tabKey, label, Icon]) => (
                  <button
                    key={tabKey}
                    type="button"
                    onClick={() => setActiveTab(tabKey)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-[13px] font-medium transition-colors ${
                      activeTab === tabKey
                        ? 'bg-emerald-600 text-white'
                        : 'bg-[#12151B] border border-white/[0.08] text-[#9AA4B4] hover:text-white'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              {/* TAB 1: EXECUTIVE BRIEFING & TACTICAL VISION EVALUATION */}
              {activeTab === 'briefing' && (
                <div className="space-y-6">
                  {/* Section A: Match & Evidence Header */}
                  <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.06] pb-4">
                      <div>
                        <div className="text-[11px] font-mono uppercase tracking-wider text-[#8A94A6]">
                          Section A · Match &amp; Evidence Integrity · {briefing.modelUsed} · Prompt{' '}
                          {briefing.promptVersion}
                        </div>
                        <h3 className="mt-1 text-[20px] font-bold text-white">
                          {selectedMatch.venue === 'home' ? 'vs' : '@'} {selectedMatch.opponentName} ·{' '}
                          {briefing.readableHudStats.scoreline || 'Score Not Visible in HUD'}
                        </h3>
                        <div className="mt-1 text-[12px] text-[#9AA4B4]">
                          {displayedJob?.coverageSummary || 'Verified gameplay segments analyzed.'}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`px-2.5 py-1 rounded border text-[11px] font-mono uppercase ${statusBadgeStyle(
                            briefing.evidenceQuality === 'high'
                              ? 'completed'
                              : briefing.evidenceQuality === 'moderate'
                                ? 'completed_with_limitations'
                                : 'insufficient_gameplay'
                          )}`}
                        >
                          Evidence Quality: {briefing.evidenceQuality}
                        </span>
                        {briefing.readableHudStats.matchClock && (
                          <span className="px-2.5 py-1 rounded border border-white/[0.12] bg-[#0E1116] text-[11px] font-mono text-[#D7DDE7]">
                            HUD Clock: {briefing.readableHudStats.matchClock}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Verified HUD Stats (Only when actually readable) */}
                    {(briefing.readableHudStats.possessionLabel ||
                      briefing.readableHudStats.shotsLabel ||
                      briefing.readableHudStats.otherVerifiedStats.length > 0) && (
                      <div className="flex flex-wrap gap-2.5 text-[12px]">
                        {briefing.readableHudStats.possessionLabel && (
                          <div className="px-3 py-1.5 rounded bg-[#0E1116] border border-white/[0.08]">
                            <span className="text-[#8A94A6] mr-1.5">HUD Possession:</span>
                            <span className="text-white font-mono">
                              {briefing.readableHudStats.possessionLabel}
                            </span>
                          </div>
                        )}
                        {briefing.readableHudStats.shotsLabel && (
                          <div className="px-3 py-1.5 rounded bg-[#0E1116] border border-white/[0.08]">
                            <span className="text-[#8A94A6] mr-1.5">HUD Shots:</span>
                            <span className="text-white font-mono">
                              {briefing.readableHudStats.shotsLabel}
                            </span>
                          </div>
                        )}
                        {briefing.readableHudStats.otherVerifiedStats.map((st, idx) => (
                          <div
                            key={idx}
                            className="px-3 py-1.5 rounded bg-[#0E1116] border border-white/[0.08]"
                          >
                            <span className="text-[#8A94A6] mr-1.5">{st.label}:</span>
                            <span className="text-white font-mono">{st.value}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Section B: Manager Verdict */}
                    <div className="space-y-4">
                      <div>
                        <div className="text-[11px] font-mono uppercase tracking-wider text-emerald-400">
                          Section B · Manager’s Verdict
                        </div>
                        <p className="mt-1.5 text-[15px] text-[#E6EBF2] leading-relaxed">
                          {briefing.managerVerdict.conciseSummary}
                        </p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[13px]">
                        <div className="border border-emerald-500/20 bg-[#0D1412] rounded-md p-4">
                          <div className="font-semibold text-emerald-300 mb-2">What Is Working</div>
                          <ul className="space-y-1.5 text-[#C5CCD7] list-disc pl-4">
                            {briefing.managerVerdict.whatIsWorking.map((item, i) => (
                              <li key={i}>{item}</li>
                            ))}
                          </ul>
                        </div>

                        <div className="border border-rose-500/20 bg-[#150E11] rounded-md p-4">
                          <div className="font-semibold text-rose-300 mb-2">What Is Not Working</div>
                          <ul className="space-y-1.5 text-[#C5CCD7] list-disc pl-4">
                            {briefing.managerVerdict.whatIsNotWorking.map((item, i) => (
                              <li key={i}>{item}</li>
                            ))}
                          </ul>
                        </div>

                        <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-4">
                          <div className="font-semibold text-white mb-1.5">
                            Why Current Tactic Is Struggling
                          </div>
                          <p className="text-[#A8B2C2] leading-relaxed">
                            {briefing.managerVerdict.whyTacticStruggling}
                          </p>
                        </div>

                        <div className="border border-amber-500/25 bg-[#16130C] rounded-md p-4">
                          <div className="font-semibold text-amber-300 mb-1.5">
                            First Priority Half-Time Change
                          </div>
                          <p className="text-white leading-relaxed">
                            {briefing.managerVerdict.firstPriorityChange}
                          </p>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Section C: Tactical Vision Evaluation */}
                  {visionAssessment && (
                    <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
                        <div>
                          <div className="text-[11px] font-mono uppercase tracking-wider text-sky-400">
                            Section C · Tactical Vision Evaluation
                          </div>
                          <h3 className="mt-0.5 text-[16px] font-semibold text-white">
                            {visionAssessment.executionAssessmentLabel}
                          </h3>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                          <span
                            className={`px-2.5 py-1 rounded border uppercase ${statusBadgeStyle(
                              visionAssessment.officialComplianceStatus
                            )}`}
                          >
                            Layer 2 Official: {visionAssessment.officialComplianceStatus}
                          </span>
                          <span className="px-2.5 py-1 rounded border border-white/[0.12] bg-[#0E1116] text-[#D7DDE7]">
                            Layer 3 Affinity: {visionAssessment.roleAffinityMatchedCount} /{' '}
                            {visionAssessment.roleAffinityTotalCount}
                            {visionAssessment.roleAffinityUnknownCount > 0
                              ? ` (${visionAssessment.roleAffinityUnknownCount} unknown)`
                              : ''}
                          </span>
                          {visionAssessment.internalAssessmentScore !== null && (
                            <span className="px-2.5 py-1 rounded border border-sky-500/35 bg-sky-500/15 text-sky-200">
                              Internal Fit Index: {visionAssessment.internalAssessmentScore}/100
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[13px]">
                        <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3.5">
                          <div className="text-[11px] uppercase tracking-wider text-[#8A94A6]">
                            Intended Vision
                          </div>
                          <div className="mt-1 font-semibold text-white capitalize">
                            {visionAssessment.intendedVisionKey.replace(/_/g, ' ')}
                          </div>
                        </div>

                        <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3.5">
                          <div className="text-[11px] uppercase tracking-wider text-[#8A94A6]">
                            Observed Playing Style
                          </div>
                          <div className="mt-1 font-semibold text-white">
                            {visionAssessment.observedPlayingStyle.primaryTendency}
                          </div>
                          <p className="mt-1 text-[12px] text-[#9AA4B4]">
                            {visionAssessment.observedPlayingStyle.evidenceSummary}
                          </p>
                        </div>

                        <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3.5">
                          <div className="text-[11px] uppercase tracking-wider text-[#8A94A6]">
                            Recommended Stance ({visionAssessment.recommendationStance.replace(/_/g, ' ')})
                          </div>
                          <div className="mt-1 font-semibold text-emerald-300 capitalize">
                            {visionAssessment.recommendedVisionKey.replace(/_/g, ' ')}
                          </div>
                          <p className="mt-1 text-[12px] text-[#9AA4B4]">
                            {visionAssessment.recommendationRationale}
                          </p>
                        </div>
                      </div>

                      {visionAssessment.criteriaBreakdown.length > 0 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
                          {visionAssessment.criteriaBreakdown.map((c, idx) => (
                            <div
                              key={idx}
                              className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3 flex items-start justify-between gap-3"
                            >
                              <div>
                                <div className="font-medium text-white">{c.criterion}</div>
                                <div className="mt-0.5 text-[#9AA4B4]">{c.evidenceNote}</div>
                              </div>
                              <span
                                className={`shrink-0 px-2 py-0.5 rounded border text-[10px] font-mono uppercase ${statusBadgeStyle(
                                  c.assessment
                                )}`}
                              >
                                {c.assessment}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="text-[11px] text-[#8A94A6] border-t border-white/[0.06] pt-2.5">
                        <strong>Methodology Note:</strong> {visionAssessment.scoreMethodologyNote}
                        {visionAssessment.limitations && ` · Limitations: ${visionAssessment.limitations}`}
                      </div>
                    </section>
                  )}

                  {/* Section F: Gameplay Coaching & Contingency Plan + Limitations */}
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                    <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-3">
                      <h3 className="text-[15px] font-semibold text-white">
                        Gameplay Coaching Instructions
                      </h3>
                      {briefing.gameplayCoaching.length > 0 ? (
                        <div className="space-y-2.5 text-[13px]">
                          {briefing.gameplayCoaching.map((g, i) => (
                            <div
                              key={i}
                              className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3"
                            >
                              <div className="font-medium text-white">{g.instruction}</div>
                              <div className="mt-1 text-[12px] text-emerald-300/90">
                                Trigger: {g.triggerSituation}
                              </div>
                              <div className="mt-0.5 text-[12px] text-[#8A94A6]">
                                Evidence: {g.evidenceNote}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[13px] text-[#8A94A6]">
                          No specific gameplay coaching notes returned for this half.
                        </p>
                      )}
                    </section>

                    <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-3">
                      <h3 className="text-[15px] font-semibold text-white">
                        Contingency Plan &amp; Honest Limitations
                      </h3>
                      {briefing.contingencyPlan.length > 0 && (
                        <div className="space-y-2.5 text-[13px]">
                          {briefing.contingencyPlan.map((c, i) => (
                            <div
                              key={i}
                              className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3"
                            >
                              <div className="font-medium text-white">
                                {c.scenario}{' '}
                                <span className="text-[11px] font-normal text-amber-300">
                                  ({c.trigger})
                                </span>
                              </div>
                              <div className="mt-1 text-[12px] text-[#C5CCD7]">{c.tacticalAction}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {briefing.limitations.length > 0 && (
                        <div className="pt-2 border-t border-white/[0.06]">
                          <div className="text-[11px] font-mono uppercase tracking-wider text-[#8A94A6] mb-1.5">
                            Observed Analysis Limitations
                          </div>
                          <ul className="space-y-1 text-[12px] text-[#9AA4B4] list-disc pl-4">
                            {briefing.limitations.map((lim, i) => (
                              <li key={i}>{lim}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </section>
                  </div>
                </div>
              )}

              {/* TAB 2: RECOMMENDATIONS, DECISIONS & ADJUSTMENT SNAPSHOTS */}
              {activeTab === 'recommendations' && (
                <div className="space-y-6">
                  {/* Apply Accepted Action Bar */}
                  <section className="border border-emerald-500/30 bg-[#101815] rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="text-[14px] font-semibold text-white">
                        Manager-Controlled Tactical Application
                      </div>
                      <div className="text-[12px] text-[#9AA4B4] mt-0.5">
                        AI recommendations never auto-mutate your club preset or pre-match snapshot.
                        Accept or modify validated recommendations below, then create a separate
                        Half-Time Adjustment Snapshot.
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={acceptedRecommendationIds.length === 0 || applyingAdjustment}
                      onClick={() => void handleApplyAcceptedToSnapshot()}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-white/[0.08] disabled:text-[#6B7485] text-white text-[13px] font-semibold"
                    >
                      {applyingAdjustment ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <ClipboardCheck className="w-4 h-4" />
                      )}
                      Apply {acceptedRecommendationIds.length} Accepted to Half-Time Snapshot
                    </button>
                  </section>

                  {/* Recommendations Cards */}
                  <div className="space-y-3.5">
                    {recommendations.length === 0 ? (
                      <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 text-[13px] text-[#8A94A6]">
                        No tactical recommendations were generated for this job.
                      </div>
                    ) : (
                      recommendations.map((rec) => {
                        const decisionStatus = rec.decision?.decisionStatus ?? 'ai_recommended';
                        const isBlockedInvalid = rec.validationStatus === 'invalid_unsupported';
                        const isEditing = editingRecId === rec.id;

                        return (
                          <div
                            key={rec.id}
                            className={`border rounded-lg p-5 space-y-3 ${
                              isBlockedInvalid
                                ? 'border-rose-500/35 bg-[#171114]'
                                : 'border-white/[0.08] bg-[#12151B]'
                            }`}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                                  <span className="text-emerald-400">#{rec.priorityRank}</span>
                                  <span className="text-[#8A94A6] uppercase">
                                    {priorityGroupLabel(rec.priorityGroup)}
                                  </span>
                                  <span
                                    className={`px-2 py-0.5 rounded border uppercase ${statusBadgeStyle(
                                      rec.validationStatus
                                    )}`}
                                  >
                                    FC26 Check: {rec.validationStatus.replace(/_/g, ' ')}
                                  </span>
                                  <span
                                    className={`px-2 py-0.5 rounded border uppercase ${statusBadgeStyle(
                                      decisionStatus
                                    )}`}
                                  >
                                    {decisionStatus.replace(/_/g, ' ')}
                                  </span>
                                  <span className="text-[#8A94A6]">
                                    Confidence: {rec.confidence}
                                  </span>
                                </div>
                                <h4 className="mt-1 text-[15px] font-semibold text-white">
                                  {rec.title}
                                </h4>
                              </div>

                              {/* Decision Buttons */}
                              <div className="flex flex-wrap items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={isBlockedInvalid || savingDecisionId === rec.id}
                                  onClick={() =>
                                    void handleRecommendationDecision(rec, 'user_accepted')
                                  }
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-40 text-[12px] text-emerald-200"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  disabled={isBlockedInvalid || savingDecisionId === rec.id}
                                  onClick={() => {
                                    setEditingRecId(isEditing ? null : rec.id);
                                    setModifiedText(
                                      rec.decision?.modifiedValue || rec.proposedValue
                                    );
                                    setDecisionNotes(rec.decision?.userNotes || '');
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 text-[12px] text-amber-200"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                  Modify
                                </button>
                                <button
                                  type="button"
                                  disabled={savingDecisionId === rec.id}
                                  onClick={() =>
                                    void handleRecommendationDecision(rec, 'user_rejected')
                                  }
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-40 text-[12px] text-rose-200"
                                >
                                  <X className="w-3.5 h-3.5" />
                                  Reject
                                </button>
                              </div>
                            </div>

                            {/* Current -> Proposed */}
                            <div className="flex flex-wrap items-center gap-2 text-[13px] bg-[#0E1116] border border-white/[0.06] rounded-md px-3.5 py-2.5">
                              <span className="text-[#8A94A6]">{rec.currentValue}</span>
                              <ArrowRight className="w-4 h-4 text-emerald-400 shrink-0" />
                              <span className="text-white font-semibold">
                                {rec.decision?.modifiedValue || rec.proposedValue}
                              </span>
                              {rec.targetPositionCode && (
                                <span className="ml-auto text-[11px] font-mono text-sky-300">
                                  Slot: {rec.targetPositionCode}
                                </span>
                              )}
                            </div>

                            {rec.validationErrors.length > 0 && (
                              <div className="border border-rose-500/35 bg-rose-500/10 rounded px-3 py-2 text-[12px] text-rose-200">
                                <strong>Server Validation Notes:</strong>{' '}
                                {rec.validationErrors.join(' · ')}
                              </div>
                            )}

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
                              <div>
                                <div className="text-[#7D8798] uppercase text-[10px]">
                                  Tactical Rationale
                                </div>
                                <p className="mt-0.5 text-[#C5CCD7]">{rec.reason}</p>
                              </div>
                              <div>
                                <div className="text-[#7D8798] uppercase text-[10px]">
                                  Expected Benefit
                                </div>
                                <p className="mt-0.5 text-emerald-200/90">{rec.expectedBenefit}</p>
                              </div>
                              <div>
                                <div className="text-[#7D8798] uppercase text-[10px]">
                                  Potential Risk
                                </div>
                                <p className="mt-0.5 text-amber-200/90">{rec.potentialRisk}</p>
                              </div>
                            </div>

                            {/* Linked Evidence Timestamps */}
                            {rec.evidenceTimestamps.length > 0 && (
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8A94A6] pt-1">
                                <span>Evidence Clips:</span>
                                {rec.evidenceTimestamps.map((ts, idx) => (
                                  <button
                                    key={idx}
                                    type="button"
                                    onClick={() => setActiveTab('evidence')}
                                    className="px-2 py-0.5 rounded bg-white/[0.05] hover:bg-white/[0.1] text-[#D7DDE7] font-mono"
                                  >
                                    {formatSeconds(ts.startSeconds)}–{formatSeconds(ts.endSeconds)}
                                    {ts.inGameClock ? ` (${ts.inGameClock})` : ''}
                                  </button>
                                ))}
                              </div>
                            )}

                            {/* Inline Modify Editor */}
                            {isEditing && (
                              <div className="border-t border-white/[0.08] pt-3 space-y-2.5">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div>
                                    <label className="block text-[11px] text-[#8A94A6] mb-1">
                                      Modified Value
                                    </label>
                                    <input
                                      type="text"
                                      value={modifiedText}
                                      onChange={(e) => setModifiedText(e.target.value)}
                                      className="w-full bg-[#0E1116] border border-white/[0.14] rounded px-3 py-1.5 text-[13px] text-white"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-[11px] text-[#8A94A6] mb-1">
                                      Manager Notes
                                    </label>
                                    <input
                                      type="text"
                                      value={decisionNotes}
                                      onChange={(e) => setDecisionNotes(e.target.value)}
                                      placeholder="Optional reason for tweak..."
                                      className="w-full bg-[#0E1116] border border-white/[0.14] rounded px-3 py-1.5 text-[13px] text-white"
                                    />
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleRecommendationDecision(
                                        rec,
                                        'user_modified',
                                        modifiedText.trim() || rec.proposedValue,
                                        decisionNotes.trim()
                                      )
                                    }
                                    className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-[12px] font-medium"
                                  >
                                    Save Modification
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingRecId(null)}
                                    className="px-3 py-1.5 rounded border border-white/[0.12] text-[#9AA4B4] text-[12px]"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Match Tactical Snapshots Timeline */}
                  <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[15px] font-semibold text-white">
                        Match Tactical Snapshots (Pre-Match Immutable vs Half-Time Adjustments)
                      </h3>
                      <span className="text-[11px] font-mono text-[#8A94A6]">
                        {snapshots.length} snapshot(s)
                      </span>
                    </div>
                    <div className="space-y-2.5">
                      {snapshots.map((snap) => (
                        <div
                          key={snap.id}
                          className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3.5 flex flex-wrap items-center justify-between gap-3 text-[12px]"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span
                                className={`px-2 py-0.5 rounded border font-mono text-[10px] uppercase ${
                                  snap.snapshotType === 'pre_match'
                                    ? 'bg-sky-500/15 text-sky-300 border-sky-500/35'
                                    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                                }`}
                              >
                                {snap.snapshotType === 'pre_match'
                                  ? 'Pre-Match (Immutable)'
                                  : 'In-Match Adjustment'}
                              </span>
                              <span className="font-semibold text-white">
                                {snap.formationName} · {snap.buildUpStyle} · {snap.defensiveApproach}{' '}
                                (Line {snap.defensiveLineHeight})
                              </span>
                              {snap.tacticalVisionKey && snap.tacticalVisionKey !== 'unspecified' && (
                                <span className="text-emerald-300 font-mono text-[11px] uppercase">
                                  [{snap.tacticalVisionKey.replace(/_/g, ' ')}]
                                </span>
                              )}
                            </div>
                            {snap.notes && (
                              <div className="mt-1 text-[#8A94A6]">{snap.notes}</div>
                            )}
                          </div>

                          {snap.snapshotType === 'in_match_adjustment' && (
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void handleToggleConfirmAppliedInGame(snap)}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-[11px] font-medium ${
                                  snap.appliedInGameConfirmed
                                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                                    : 'border-white/[0.14] text-[#C5CCD7] hover:border-emerald-500/40'
                                }`}
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {snap.appliedInGameConfirmed
                                  ? 'Confirmed Applied in FC26'
                                  : 'Mark Applied in FC26'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setPresetModalSnapshotId(snap.id);
                                  setPresetNameInput(
                                    `${selectedMatch.opponentName} HT Adjustment (${snap.formationName})`
                                  );
                                }}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/[0.14] hover:border-sky-400/50 text-[#C5CCD7] text-[11px]"
                              >
                                <BookmarkPlus className="w-3.5 h-3.5" />
                                Save as Club Preset
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {presetModalSnapshotId && (
                      <div className="border border-sky-500/35 bg-sky-500/10 rounded-md p-3.5 flex flex-wrap items-center gap-3">
                        <input
                          type="text"
                          value={presetNameInput}
                          onChange={(e) => setPresetNameInput(e.target.value)}
                          placeholder="New club tactical preset name..."
                          className="flex-1 min-w-[220px] bg-[#0E1116] border border-white/[0.14] rounded px-3 py-1.5 text-[13px] text-white"
                        />
                        <button
                          type="button"
                          disabled={savingPreset || !presetNameInput.trim()}
                          onClick={() => void handleSaveSnapshotAsPreset()}
                          className="px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-[12px] font-medium disabled:opacity-50"
                        >
                          {savingPreset ? 'Saving...' : 'Confirm Save Preset'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPresetModalSnapshotId(null)}
                          className="px-3 py-1.5 rounded border border-white/[0.12] text-[#C5CCD7] text-[12px]"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </section>
                </div>
              )}

              {/* TAB 3: EVIDENCE TIMELINE & EXTRACTED FRAMES */}
              {activeTab === 'evidence' && (
                <div className="space-y-6">
                  {/* Stage 1 Segment Classification */}
                  <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-3">
                    <h3 className="text-[15px] font-semibold text-white">
                      Stage 1 · Video Content Classification Timeline ({bundle?.classifications.length ?? 0})
                    </h3>
                    {(bundle?.classifications.length ?? 0) > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5 text-[12px]">
                        {bundle?.classifications.map((cls) => (
                          <div
                            key={cls.id}
                            className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3 space-y-1"
                          >
                            <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                              <span className="text-emerald-300">
                                {formatSeconds(cls.sessionStartSeconds)}–
                                {formatSeconds(cls.sessionEndSeconds)}
                                {cls.inGameClock ? ` (${cls.inGameClock})` : ''}
                              </span>
                              <span
                                className={`px-1.5 py-0.5 rounded border uppercase text-[10px] ${statusBadgeStyle(
                                  cls.contentType === 'live_gameplay' || cls.contentType === 'set_piece'
                                    ? 'completed'
                                    : cls.contentType === 'replay'
                                      ? 'pending'
                                      : 'unknown'
                                )}`}
                              >
                                {cls.contentType.replace(/_/g, ' ')}
                              </span>
                            </div>
                            <p className="text-[#A8B2C2]">{cls.evidenceDescription}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[13px] text-[#8A94A6]">No segment classifications recorded.</p>
                    )}
                  </section>

                  {/* Stage 2 Gameplay Observations */}
                  <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-[15px] font-semibold text-white">
                        Stage 2 · Grounded Gameplay Observations ({filteredObservations.length})
                      </h3>
                      <div className="flex flex-wrap items-center gap-2.5 text-[12px]">
                        <div className="relative">
                          <Search className="w-3.5 h-3.5 text-[#7D8798] absolute left-2.5 top-2" />
                          <input
                            type="text"
                            value={obsSearch}
                            onChange={(e) => setObsSearch(e.target.value)}
                            placeholder="Search observations..."
                            className="bg-[#0E1116] border border-white/[0.12] rounded pl-8 pr-3 py-1.5 text-[12px] text-white"
                          />
                        </div>
                        <select
                          value={obsCategoryFilter}
                          onChange={(e) => setObsCategoryFilter(e.target.value)}
                          className="bg-[#0E1116] border border-white/[0.12] rounded px-2.5 py-1.5 text-[12px] text-white"
                        >
                          <option value="all">All Phases</option>
                          <option value="attacking">Attacking</option>
                          <option value="defensive">Defensive</option>
                          <option value="possession">Possession</option>
                          <option value="match_events">Match Events</option>
                        </select>
                        <label className="flex items-center gap-1.5 text-[#9AA4B4] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={hideReplayDuplicates}
                            onChange={(e) => setHideReplayDuplicates(e.target.checked)}
                            className="accent-emerald-500"
                          />
                          Hide replay duplicates
                        </label>
                      </div>
                    </div>

                    <div className="divide-y divide-white/[0.06]">
                      {filteredObservations.map((obs) => {
                        const frameFile = extractFrameFileName(obs.evidenceFramePath);
                        return (
                          <div key={obs.id} className="py-3.5 first:pt-0 space-y-1.5 text-[13px]">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                                <span className="text-emerald-400">
                                  {formatSeconds(obs.sessionStartSeconds)}–
                                  {formatSeconds(obs.sessionEndSeconds)}
                                </span>
                                {obs.inGameClock && (
                                  <span className="text-[#C5CCD7]">Clock {obs.inGameClock}</span>
                                )}
                                <span className="px-2 py-0.5 rounded bg-white/[0.06] text-white uppercase">
                                  {obs.categoryGroup} · {obs.category}
                                </span>
                                <span className="text-[#8A94A6]">
                                  Team: {obs.teamAttribution.replace(/_/g, ' ')}
                                </span>
                                <span className="text-sky-300">
                                  Player: {obs.playerAttribution || 'Unknown'}
                                </span>
                                {obs.isFromReplay && (
                                  <span className="px-2 py-0.5 rounded border border-amber-500/35 bg-amber-500/15 text-amber-200 uppercase">
                                    Replay Duplicate
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                <span className="text-[11px] text-[#8A94A6]">
                                  {obs.severity} · {obs.confidence}
                                </span>
                                {frameFile && (
                                  <button
                                    type="button"
                                    onClick={() => void handleOpenEvidenceFrame(obs)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.14] hover:border-emerald-400/60 text-[11px] text-white"
                                  >
                                    <Camera className="w-3 h-3 text-emerald-400" />
                                    View Frame
                                  </button>
                                )}
                              </div>
                            </div>

                            <p className="text-white">{obs.description}</p>
                            <p className="text-[12px] text-[#9AA4B4]">
                              Visual Evidence ({obs.evidenceType.replace(/_/g, ' ')}):{' '}
                              {obs.supportingVisualEvidence}
                            </p>
                            {obs.limitations && (
                              <p className="text-[11px] text-[#7D8798]">
                                Limitation: {obs.limitations}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>
              )}

              {/* TAB 4: SECOND-HALF COMPARISON */}
              {activeTab === 'comparison' && secondHalfComparison && (
                <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-5">
                  <div className="border-b border-white/[0.06] pb-4">
                    <div className="text-[11px] font-mono uppercase tracking-wider text-sky-400">
                      Section H · Stage 4 Second-Half vs First-Half Comparison ·{' '}
                      {secondHalfComparison.modelUsed}
                    </div>
                    <h3 className="mt-1 text-[17px] font-semibold text-white">
                      Second-Half Tactical Impact Evaluation
                    </h3>
                    <p className="mt-1.5 text-[14px] text-[#E6EBF2] leading-relaxed">
                      {secondHalfComparison.summary}
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[13px]">
                    <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3.5">
                      <div className="font-semibold text-white mb-1">Attacking Comparison</div>
                      <p className="text-[#9AA4B4]">{secondHalfComparison.attackingComparison}</p>
                    </div>
                    <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3.5">
                      <div className="font-semibold text-white mb-1">Defensive Comparison</div>
                      <p className="text-[#9AA4B4]">{secondHalfComparison.defensiveComparison}</p>
                    </div>
                    <div className="border border-white/[0.08] bg-[#0E1116] rounded-md p-3.5">
                      <div className="font-semibold text-white mb-1">Tactical Vision Comparison</div>
                      <p className="text-[#9AA4B4]">
                        {secondHalfComparison.tacticalVisionComparison}
                      </p>
                    </div>
                  </div>

                  {secondHalfComparison.appliedAdjustmentsReviewed.length > 0 && (
                    <div className="space-y-2.5">
                      <div className="text-[13px] font-semibold text-white">
                        Reviewed Half-Time Adjustments (With Explicit Causation Caveats)
                      </div>
                      <div className="space-y-2">
                        {secondHalfComparison.appliedAdjustmentsReviewed.map((adj, idx) => (
                          <div
                            key={idx}
                            className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3.5 text-[12px] space-y-1"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-semibold text-white">
                                {adj.recommendationTitle}
                              </span>
                              <div className="flex items-center gap-2 font-mono text-[10px]">
                                <span
                                  className={`px-2 py-0.5 rounded border uppercase ${
                                    adj.userConfirmedAppliedInGame
                                      ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-200'
                                      : 'border-white/[0.12] text-[#9AA4B4]'
                                  }`}
                                >
                                  {adj.userConfirmedAppliedInGame
                                    ? 'User Confirmed Applied'
                                    : 'Unconfirmed In-Game'}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded border uppercase ${statusBadgeStyle(
                                    adj.outcomeAssessment
                                  )}`}
                                >
                                  {adj.outcomeAssessment.replace(/_/g, ' ')}
                                </span>
                              </div>
                            </div>
                            <p className="text-[#C5CCD7]">{adj.observedSecondHalfPattern}</p>
                            <p className="text-amber-200/80 text-[11px]">
                              Causation Caveat: {adj.causationCaveat}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {secondHalfComparison.recurringWeaknesses.length > 0 && (
                    <div>
                      <div className="text-[12px] font-semibold text-rose-300 mb-1.5">
                        Recurring Weaknesses Remaining Unresolved
                      </div>
                      <ul className="list-disc pl-4 space-y-1 text-[12px] text-[#C5CCD7]">
                        {secondHalfComparison.recurringWeaknesses.map((w, idx) => (
                          <li key={idx}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}
            </div>
          ) : legacyReport ? (
            /* Backward-compatible view for any pre-Phase 3 stored legacy HalftimeReportData */
            <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-white/[0.08] pb-4">
                <div>
                  <div className="text-[11px] font-mono text-[#8A94A6] uppercase">
                    Legacy Stored Half-Time Report · Model {legacyReport.modelUsed}
                  </div>
                  <div className="mt-1 text-[20px] font-bold text-white">
                    {legacyReport.section1MatchSituation.clubName}{' '}
                    <span className="text-emerald-400">
                      {legacyReport.section1MatchSituation.scoreLabel}
                    </span>{' '}
                    {legacyReport.section1MatchSituation.opponentName}
                  </div>
                </div>
                <div className="text-[14px] font-semibold text-white">
                  {legacyReport.section1MatchSituation.tacticalRatingLabel}
                </div>
              </div>
              <p className="text-[14px] text-[#E6EBF2] leading-relaxed">
                {legacyReport.section2ManagersVerdict}
              </p>
              <ol className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[13px]">
                {legacyReport.section10PriorityActions.map((act, idx) => (
                  <li
                    key={idx}
                    className="border border-white/[0.08] bg-[#0E1116] rounded p-3 text-white"
                  >
                    <span className="text-emerald-400 font-mono mr-1.5">0{idx + 1}.</span>
                    {act}
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-7 text-center space-y-2">
              <Clock3 className="w-7 h-7 text-[#7D8798] mx-auto" />
              <h3 className="text-[16px] font-semibold text-white">
                No Phase 3 Briefing Generated Yet for {selectedHalf.replace('_', ' ')}
              </h3>
              <p className="text-[13px] text-[#9AA4B4] max-w-2xl mx-auto">
                Half-time tactical briefings are strictly evidence-anchored and never fabricated
                from pre-match presets. Verify a recording (or import an MP4 test clip above),
                authorize privacy upload, and launch analysis.
              </p>
            </div>
          )}
        </>
      )}

      {/* Authenticated Evidence Frame Lightbox */}
      {lightboxState && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={closeLightbox}
        >
          <div
            className="max-w-4xl w-full border border-white/[0.14] bg-[#12151B] rounded-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08]">
              <div>
                <div className="text-[14px] font-semibold text-white">{lightboxState.title}</div>
                <div className="text-[12px] text-[#9AA4B4]">{lightboxState.subtitle}</div>
              </div>
              <button
                type="button"
                onClick={closeLightbox}
                className="p-1.5 rounded hover:bg-white/[0.08] text-[#9AA4B4] hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 bg-[#0B0D11] flex items-center justify-center min-h-[280px]">
              {lightboxState.loading ? (
                <div className="flex items-center gap-2 text-[13px] text-[#9AA4B4]">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading authenticated evidence frame...
                </div>
              ) : lightboxState.error ? (
                <div className="text-[13px] text-rose-300">{lightboxState.error}</div>
              ) : lightboxState.objectUrl ? (
                <img
                  src={lightboxState.objectUrl}
                  alt={lightboxState.title}
                  className="max-h-[70vh] w-auto rounded border border-white/[0.1]"
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
