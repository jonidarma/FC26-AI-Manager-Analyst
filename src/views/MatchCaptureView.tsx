import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  Film,
  FolderOpen,
  HardDrive,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { desktopBridge } from '../services/desktopBridge';
import { recordingController } from '../services/recordingController';
import type {
  AnalysisLanguage,
  CaptureSourceInfo,
  DiskSpaceInfo,
  MatchSessionWithSegments,
  MatchStorageFoldersInfo,
  RecoverableSessionSummary,
  RecoveryExecutionResult,
  TrustedFolderKind,
  VideoAnalysisMode,
} from '../types/domain';

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Unavailable in Browser Preview';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function MatchCaptureView() {
  const {
    capabilities,
    matches,
    selectedMatchId,
    setSelectedMatchId,
    recordingSessions,
    recoverableSessions,
    recordingTelemetry,
    settings,
    setActiveSection,
    refreshAll,
    refreshRecordingData,
    notify,
  } = useApp();

  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [diskInfo, setDiskInfo] = useState<DiskSpaceInfo | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showPipelineDiagnostics, setShowPipelineDiagnostics] = useState(false);
  const [inspectedRecoveryId, setInspectedRecoveryId] = useState<string | null>(null);
  const [lastRecoveryResult, setLastRecoveryResult] = useState<RecoveryExecutionResult | null>(null);
  const [analysisLaunchSessionId, setAnalysisLaunchSessionId] = useState<string | null>(null);
  const [analysisMode, setAnalysisMode] = useState<VideoAnalysisMode>(
    settings?.ai?.defaultAnalysisMode ?? 'balanced'
  );
  const [analysisLang, setAnalysisLang] = useState<AnalysisLanguage>(
    settings?.ai?.defaultLanguage ?? 'en'
  );
  const [privacyAck, setPrivacyAck] = useState(false);
  const [entireDisplayAck, setEntireDisplayAck] = useState(false);
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [matchStorageFolders, setMatchStorageFolders] = useState<MatchStorageFoldersInfo | null>(
    null
  );

  // Explicit discard confirmation state (double-step if discarding an already finalized session)
  const [discardTarget, setDiscardTarget] = useState<{
    sessionId: string;
    matchId: string;
    isFinalized: boolean;
    step: 1 | 2;
  } | null>(null);

  const selectedMatch = matches.find((m) => m.id === selectedMatchId) ?? matches[0] ?? null;
  const isNativeElectron = capabilities?.environment === 'electron-native';
  const isRecordingImplemented = capabilities?.localFfmpegRecording === true;
  const captureCfg = settings?.capture;
  const diag = capabilities?.captureDiagnostics;
  const pipelineDiag = recordingTelemetry.diagnostics;

  // Auto-expand live Recording Diagnostics Panel whenever a warning, stall, or failure occurs
  useEffect(() => {
    if (
      recordingTelemetry.uiStatus === 'failed' ||
      Boolean(recordingTelemetry.lastError) ||
      pipelineDiag?.startupWatchdogState === 'triggered' ||
      pipelineDiag?.stallWatchdogState === 'triggered'
    ) {
      setShowPipelineDiagnostics(true);
    }
  }, [
    recordingTelemetry.uiStatus,
    recordingTelemetry.lastError,
    pipelineDiag?.startupWatchdogState,
    pipelineDiag?.stallWatchdogState,
  ]);

  const isSessionActive =
    recordingTelemetry.uiStatus === 'initializing' ||
    recordingTelemetry.uiStatus === 'recording' ||
    recordingTelemetry.uiStatus === 'paused' ||
    recordingTelemetry.uiStatus === 'finalizing';

  const matchSessions = useMemo<MatchSessionWithSegments[]>(() => {
    if (!selectedMatch) return [];
    return recordingSessions.filter(
      (s) => s.matchId === selectedMatch.id && s.status !== 'discarded'
    );
  }, [recordingSessions, selectedMatch]);

  const hasValidFirstHalf = useMemo(
    () =>
      matchSessions.some(
        (s) =>
          s.half === 'first_half' &&
          (s.status === 'completed' || s.status === 'recovered' || s.status === 'partial') &&
          s.aiEligible !== false &&
          s.segments.some(
            (seg) =>
              (seg.status === 'finalized' || seg.status === 'recovered') &&
              seg.sizeBytes > 0 &&
              seg.durationSeconds > 0
          )
      ),
    [matchSessions]
  );

  const hasFailedFirstHalf = useMemo(
    () =>
      !hasValidFirstHalf &&
      matchSessions.some((s) => s.half === 'first_half' && s.status === 'failed'),
    [hasValidFirstHalf, matchSessions]
  );

  // Estimate file size for a 15-minute real-time half based on configured bitrate
  const estimatedHalfSizeMb = captureCfg
    ? Math.round((((captureCfg.bitrateKbps * 1000) / 8) * (15 * 60)) / (1024 * 1024))
    : 394;

  const effectiveFps: 20 | 30 = captureCfg && captureCfg.fps <= 22 ? 20 : 30;
  const effectiveResolution: '1280x720' | '1920x1080' =
    captureCfg?.resolution === '1920x1080' ? '1920x1080' : '1280x720';

  async function refreshSources() {
    setLoadingSources(true);
    setSourceError(null);
    try {
      const result = await desktopBridge.listCaptureSources();
      if (!result.supported) {
        setSources([]);
        setSourceError(result.reason ?? 'Native capture unavailable in browser preview.');
      } else {
        setSources(result.sources);
        const stillValid = result.sources.some((s) => s.id === selectedSourceId);
        if (!stillValid) {
          const fcWindow = result.sources.find((s) => s.isFc26Candidate);
          if (fcWindow) {
            setSelectedSourceId(fcWindow.id);
          } else if (result.sources[0]) {
            setSelectedSourceId(result.sources[0].id);
          } else {
            setSelectedSourceId('');
          }
        }
      }

      if (captureCfg) {
        const disk = await desktopBridge.getDiskSpace(captureCfg.storageDirectory);
        setDiskInfo(disk);
      }

      await refreshRecordingData();
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : 'Failed to inspect capture sources');
    } finally {
      setLoadingSources(false);
    }
  }

  useEffect(() => {
    void refreshSources();
  }, [capabilities?.environment]);

  useEffect(() => {
    if (!selectedMatch?.id) {
      setMatchStorageFolders(null);
      return;
    }
    let active = true;
    desktopBridge
      .getMatchStorageFolders(selectedMatch.id)
      .then((info) => {
        if (active) setMatchStorageFolders(info);
      })
      .catch(() => {
        if (active) setMatchStorageFolders(null);
      });
    return () => {
      active = false;
    };
  }, [selectedMatch?.id, matchSessions.length, recordingTelemetry.uiStatus]);

  async function handleQuickCaptureSetting(
    patch: Partial<NonNullable<typeof settings>['capture']>
  ) {
    if (isSessionActive) {
      notify('error', 'Stop the active recording before changing capture parameters.');
      return;
    }
    try {
      await desktopBridge.updateSettings({ capture: patch });
      await refreshAll();
      notify('success', 'Recording configuration saved to SQLite.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to update capture setting');
    }
  }

  const selectedSource = sources.find((s) => s.id === selectedSourceId) ?? null;

  async function handleStartHalf(half: 'first_half' | 'second_half') {
    if (!selectedMatch) {
      notify('error', 'Prepare or select a match before starting a recording session.');
      return;
    }
    if (!selectedSource) {
      notify('error', 'Select an active EA SPORTS FC 26 window or display source first.');
      return;
    }
    if (!isRecordingImplemented) {
      notify(
        'error',
        diag?.blockingReason ?? 'Local FFmpeg recording prerequisites are not satisfied.'
      );
      return;
    }

    setBusyAction(`start-${half}`);
    try {
      await recordingController.startRecording({
        matchId: selectedMatch.id,
        half,
        sourceId: selectedSource.id,
        sourceName: selectedSource.name,
        sourceType: selectedSource.type,
        resolution: effectiveResolution,
        fps: effectiveFps,
        bitrateKbps: captureCfg?.bitrateKbps ?? 3500,
        segmentDurationMinutes: captureCfg?.segmentDurationMinutes ?? 3,
        maxRecordingMinutes: captureCfg?.maxRecordingMinutes ?? 90,
        audioRequested: Boolean(captureCfg?.audioEnabled),
      });
      await refreshAll();
      notify(
        'success',
        `${half === 'first_half' ? 'First-half' : 'Second-half'} local recording started.`
      );
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to start recording');
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePause() {
    setBusyAction('pause');
    try {
      await recordingController.pauseRecording();
      await refreshRecordingData();
      notify('info', 'Recording paused. Active segment flushed and saved safely.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to pause recording');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleResume() {
    setBusyAction('resume');
    try {
      await recordingController.resumeRecording();
      await refreshRecordingData();
      notify('success', 'Recording resumed cleanly in the same match session.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to resume recording');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleStopAndFinalize() {
    setBusyAction('stop');
    try {
      const manifest = await recordingController.stopRecording();
      await refreshAll();
      if (manifest) {
        const validCount = manifest.segments.filter(
          (s) => s.finalized && s.sizeBytes > 0 && s.durationSeconds > 0
        ).length;
        if (manifest.status === 'failed' || validCount === 0) {
          setShowPipelineDiagnostics(true);
          notify(
            'error',
            manifest.failureReason ||
              'Recording failed: 0 playable MP4 segments were produced. Inspect Recording Diagnostics.'
          );
        } else if (manifest.status === 'partial') {
          notify(
            'info',
            `Recording saved as Partial (${validCount} verified MP4 segment${validCount === 1 ? '' : 's'} preserved).`
          );
        } else {
          notify(
            'success',
            `Recording finalized (${validCount} verified MP4 segment${validCount === 1 ? '' : 's'} saved locally).`
          );
        }
      } else {
        notify('info', 'Recording stopped.');
      }
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to finalize recording');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleOpenDiagnosticsFolder() {
    try {
      const res = await desktopBridge.openDiagnosticsFolder();
      if (!res.opened) {
        notify('error', 'Diagnostics folder is unavailable or could not be opened.');
      }
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to open diagnostics folder');
    }
  }

  async function handleExportDiagnostics(sessionId?: string | null) {
    try {
      const res = await desktopBridge.exportSessionDiagnostics({
        sessionId: sessionId ?? undefined,
        matchId: selectedMatch?.id ?? undefined,
      });
      if (res.exported) {
        notify('success', `Exported sanitized diagnostics bundle to ${res.path}`);
      }
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to export diagnostics');
    }
  }

  async function handleConfirmDiscard() {
    if (!discardTarget) return;
    if (discardTarget.isFinalized && discardTarget.step === 1) {
      setDiscardTarget({ ...discardTarget, step: 2 });
      return;
    }

    setBusyAction('discard');
    try {
      const res = await recordingController.discardRecording(
        discardTarget.sessionId,
        discardTarget.matchId
      );
      setDiscardTarget(null);
      await refreshAll();
      notify(
        'info',
        `Recording session discarded (${res.removedFiles} local file${res.removedFiles === 1 ? '' : 's'} removed).`
      );
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to discard recording session');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRecoverSession(summary: RecoverableSessionSummary) {
    setBusyAction(`recover-${summary.sessionId}`);
    try {
      const result = await desktopBridge.recoverSession(summary.sessionId);
      setLastRecoveryResult(result);
      await refreshAll();
      notify(
        result.classification === 'corrupted' ? 'error' : 'success',
        result.classification === 'recovered'
          ? `Recovered ${result.recoveredSegments.length} verified segment(s) cleanly.`
          : result.classification === 'partially_recovered'
            ? `Partially recovered: ${result.recoveredSegments.length} valid, ${result.corruptedSegments.length} unrecoverable.`
            : 'No playable MP4 segments could be recovered from this interrupted session.'
      );
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Crash recovery failed');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleOpenSegment(filePath: string) {
    try {
      await desktopBridge.openRecordingSegment(filePath);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to open recording segment');
    }
  }

  async function handleOpenTrustedFolder(
    kind: TrustedFolderKind,
    opts?: { matchId?: string; sessionId?: string }
  ) {
    try {
      await desktopBridge.openTrustedFolder({
        kind,
        matchId: opts?.matchId,
        sessionId: opts?.sessionId,
      });
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to open recording folder');
    }
  }

  const diskBytesToDisplay =
    recordingTelemetry.availableDiskBytes ?? diskInfo?.availableBytes ?? null;
  const lowDiskWarning =
    recordingTelemetry.diskLowWarning ||
    (diskBytesToDisplay !== null && diskBytesToDisplay < 500 * 1024 * 1024);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">
            Match Capture & Recording Deck
          </h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Half-Time Analyst Mode — Local segmented H.264 MP4 gameplay capture with zero live AI
            processing, cloud uploads, or gameplay notifications.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void refreshSources()}
            disabled={loadingSources || isSessionActive}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-white/[0.12] hover:border-white/[0.24] disabled:opacity-45 text-[13px] text-[#D7DDE7] transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingSources ? 'animate-spin' : ''}`} />
            Refresh Sources
          </button>
        </div>
      </div>

      {/* Honest Runtime Capability Banner */}
      {isNativeElectron && isRecordingImplemented ? (
        <div className="border border-emerald-500/30 bg-emerald-500/[0.06] rounded-lg p-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div className="space-y-1 text-[13px]">
              <div className="font-semibold text-emerald-200">
                Native Desktop Recording Engine Ready ({diag?.preferredEncoder ?? 'H.264'})
              </div>
              <p className="text-[#C8D1DD] leading-relaxed">
                All 8 FFmpeg, binary IPC transport, and local storage prerequisites passed.
                Recordings save exclusively inside your local Windows application data folder.
              </p>
            </div>
          </div>
          {diag && (
            <button
              type="button"
              onClick={() => setShowDiagnostics((v) => !v)}
              className="inline-flex items-center gap-1 text-[12px] text-emerald-300 hover:text-emerald-200 shrink-0"
            >
              {showDiagnostics ? 'Hide' : 'Inspect'} Prerequisites
              {showDiagnostics ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>
      ) : (
        <div className="border border-amber-500/30 bg-amber-500/[0.06] rounded-lg p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3.5">
              <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1 text-[13px]">
                <div className="font-semibold text-amber-200">
                  {isNativeElectron
                    ? 'Native Electron Active — Recording Prerequisite Blocked'
                    : 'Browser Preview Environment — Native Windows Capture Unavailable'}
                </div>
                <p className="text-[#D2D7E0] leading-relaxed">
                  {isNativeElectron
                    ? diag?.blockingReason ??
                      'One or more FFmpeg or storage runtime prerequisites failed verification.'
                    : 'This preview runs inside a browser sandbox. Native Windows FC 26 window capture and local FFmpeg H.264 MP4 recording require the packaged Windows Electron desktop application and are never simulated here.'}
                </p>
              </div>
            </div>
            {diag && (
              <button
                type="button"
                onClick={() => setShowDiagnostics((v) => !v)}
                className="inline-flex items-center gap-1 text-[12px] text-amber-200 hover:text-white shrink-0"
              >
                {showDiagnostics ? 'Hide' : 'Show'} Diagnostics
                {showDiagnostics ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Expandable FFmpeg Prerequisite Diagnostics */}
      {showDiagnostics && diag && (
        <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-3 text-[12px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold text-white">
              Capture Engine Runtime Verification ({diag.ffmpegPathSource})
            </div>
            <div className="font-mono text-[#8A94A6]">
              FFmpeg: {diag.ffmpegVersion ?? 'Missing'} · FFprobe:{' '}
              {diag.ffprobeAvailable ? 'OK' : 'Missing'}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {diag.prerequisites.map((check) => (
              <div
                key={check.key}
                className="border border-white/[0.07] bg-[#0D1015] rounded-md px-3 py-2 flex items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="font-medium text-white">{check.label}</div>
                  <div className="text-[#8A94A6] mt-0.5 break-all">{check.detail}</div>
                </div>
                <span
                  className={`font-mono font-semibold shrink-0 ${
                    check.ok ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {check.ok ? 'PASS' : 'FAIL'}
                </span>
              </div>
            ))}
          </div>
          <div className="text-[#7D8798] pt-1">{diag.licenseNotice}</div>
        </section>
      )}

      {/* Crash Recovery Panel — Shown whenever interrupted sessions exist on disk */}
      {recoverableSessions.length > 0 && (
        <section className="border border-amber-500/35 bg-[#171411] rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <RotateCcw className="w-4 h-4 text-amber-400" />
              <h2 className="text-[15px] font-semibold text-amber-100">
                Interrupted Recording Sessions Detected ({recoverableSessions.length})
              </h2>
            </div>
            <span className="text-[12px] text-amber-300/80">
              Completed segments are preserved on disk and verified via FFprobe
            </span>
          </div>

          <div className="space-y-3">
            {recoverableSessions.map((item) => {
              const isExpanded = inspectedRecoveryId === item.sessionId;
              return (
                <div
                  key={item.sessionId}
                  className="border border-white/[0.08] bg-[#12151B] rounded-md p-4 space-y-3 text-[12px]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-white font-medium text-[13px]">
                        {item.half === 'first_half' ? 'First Half' : 'Second Half'} ·{' '}
                        {item.sourceName}
                      </div>
                      <div className="text-[#8A94A6] font-mono tabular-nums mt-0.5">
                        Session {item.sessionId.slice(0, 8)} · Match {item.matchId.slice(0, 8)} ·{' '}
                        {item.completedSegmentsFound} finalized, {item.partialSegmentsFound} partial
                        · {formatBytes(item.totalBytesOnDisk)} · Classification:{' '}
                        <span className="text-amber-300 uppercase">
                          {item.recoveryClassification.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setInspectedRecoveryId(isExpanded ? null : item.sessionId)
                        }
                        className="px-3 py-1.5 rounded border border-white/[0.12] hover:border-white/[0.25] text-[#D7DDE7]"
                      >
                        {isExpanded ? 'Hide Details' : 'Inspect Recovery Details'}
                      </button>
                      <button
                        type="button"
                        disabled={busyAction !== null || isSessionActive}
                        onClick={() => void handleRecoverSession(item)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Recover Session
                      </button>
                      <button
                        type="button"
                        disabled={busyAction !== null || isSessionActive}
                        onClick={() =>
                          setDiscardTarget({
                            sessionId: item.sessionId,
                            matchId: item.matchId,
                            isFinalized: false,
                            step: 1,
                          })
                        }
                        className="px-2.5 py-1.5 rounded border border-red-500/30 hover:bg-red-500/10 text-red-300"
                      >
                        Discard
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="pt-3 border-t border-white/[0.07] space-y-1.5 text-[#9AA4B4]">
                      <div className="font-mono text-[11px] break-all">
                        Folder: {item.outputDirectory}
                      </div>
                      <div className="font-mono text-[11px]">
                        Started: {item.startedAt.replace('T', ' ').slice(0, 19)} · Last Updated:{' '}
                        {item.updatedAt.replace('T', ' ').slice(0, 19)}
                      </div>
                      {item.notes.length > 0 && (
                        <ul className="list-disc pl-4 space-y-0.5 text-[#C5CCD7]">
                          {item.notes.map((n, idx) => (
                            <li key={idx}>{n}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Last Recovery Report Banner */}
      {lastRecoveryResult && (
        <section className="border border-white/[0.1] bg-[#12151B] rounded-lg p-4 space-y-2 text-[12px]">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-white">
              Crash Recovery Summary — Session {lastRecoveryResult.sessionId.slice(0, 8)} (
              {lastRecoveryResult.classification.replace(/_/g, ' ')})
            </div>
            <button
              type="button"
              onClick={() => setLastRecoveryResult(null)}
              className="text-[#8A94A6] hover:text-white"
            >
              Dismiss
            </button>
          </div>
          <div className="font-mono tabular-nums text-[#C5CCD7]">
            Verified Segments: {lastRecoveryResult.recoveredSegments.length} · Corrupted:{' '}
            {lastRecoveryResult.corruptedSegments.length} · Total Duration:{' '}
            {formatDuration(lastRecoveryResult.totalDurationSeconds)} · Size:{' '}
            {formatBytes(lastRecoveryResult.totalBytes)}
          </div>
        </section>
      )}

      {/* Active Match Selector */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="capture-match-select"
              className="block text-[12px] text-[#8A94A6] mb-1.5"
            >
              Bound Match ID (Isolates First-Half & Second-Half Recordings)
            </label>
            {matches.length > 0 ? (
              <select
                id="capture-match-select"
                value={selectedMatch?.id ?? ''}
                disabled={isSessionActive}
                onChange={(e) => setSelectedMatchId(e.target.value)}
                className="w-full max-w-xl bg-[#0C0F14] border border-white/[0.12] disabled:opacity-60 rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              >
                {matches.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.matchDate} · {m.venue === 'home' ? 'vs' : '@'} {m.opponentName} (
                    {m.competition}) · {m.startingFormation}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-[13px] text-[#9AA4B4]">
                No match prepared yet.{' '}
                <button
                  type="button"
                  onClick={() => setActiveSection('match-prep')}
                  className="text-emerald-400 hover:text-emerald-300 font-medium underline"
                >
                  Create a match in Match Preparation
                </button>
                .
              </div>
            )}
          </div>

          {selectedMatch && (
            <div className="text-right text-[12px] font-mono tabular-nums text-[#8A94A6]">
              <div>Match ID: {selectedMatch.id.slice(0, 8)}</div>
              <div className="mt-0.5 text-[#C5CCD7] capitalize">
                Status: {selectedMatch.status.replace(/_/g, ' ')}
              </div>
              <div className="mt-0.5 text-[#8A94A6]">
                2nd Half Recorded: {selectedMatch.hasSecondHalfRecording ? 'Yes' : 'No'}
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left 7 cols: Source Preview, Live Telemetry & Recording Controls */}
        <div className="xl:col-span-7 space-y-6">
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[16px] font-semibold text-white">FC 26 Window & Display Source</h2>
              <span className="text-[12px] text-[#8A94A6]">
                Recommended: Borderless Windowed Mode
              </span>
            </div>

            {isNativeElectron && sources.length > 0 ? (
              <div className="space-y-3.5">
                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Select EA SPORTS FC 26 Window (Primary) or Display Fallback
                  </label>
                  <select
                    value={selectedSourceId}
                    disabled={isSessionActive}
                    onChange={(e) => setSelectedSourceId(e.target.value)}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] disabled:opacity-60 rounded-md px-3 py-2 text-[13px] text-white"
                  >
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.isFc26Candidate
                          ? `[FC 26 Detected] ${s.name}`
                          : `[${s.type === 'window' ? 'Window' : 'Display Fallback'}] ${s.name}`}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Display Fallback Privacy Warning */}
                {selectedSource?.type === 'screen' && (
                  <div className="border border-amber-500/30 bg-amber-500/[0.06] rounded-md px-3.5 py-2.5 text-[12px] text-amber-200 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-semibold">Display Fallback Privacy Notice:</span>{' '}
                      Capturing an entire monitor will record desktop notifications, other open
                      windows, and taskbar content if you Alt-Tab out of EA SPORTS FC 26. Switch FC
                      26 to Borderless Windowed mode and select the game window whenever possible.
                    </div>
                  </div>
                )}

                {selectedSource?.thumbnailDataUrl && (
                  <div className="rounded-md overflow-hidden border border-white/[0.1] bg-black relative">
                    <img
                      src={selectedSource.thumbnailDataUrl}
                      alt={`Capture preview of ${selectedSource.name}`}
                      className="w-full aspect-video object-contain"
                    />
                    <div className="px-3 py-1.5 bg-[#0C0F14]/90 border-t border-white/[0.08] flex items-center justify-between text-[11px] font-mono text-[#B8C0CE]">
                      <span className="truncate">{selectedSource.name}</span>
                      <span className="text-emerald-400 shrink-0 ml-2">
                        {selectedSource.type === 'window' ? 'WINDOW SOURCE' : 'DISPLAY FALLBACK'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="aspect-video rounded-md border border-dashed border-white/[0.12] bg-[#0C0F14] flex flex-col items-center justify-center p-6 text-center">
                <Monitor className="w-8 h-8 text-[#596272] mb-3" />
                <div className="text-[14px] font-medium text-white">
                  {isNativeElectron
                    ? 'No Capture Sources Returned'
                    : 'Capture Preview Requires Native Electron Runtime'}
                </div>
                <p className="mt-1.5 text-[12px] text-[#8A94A6] max-w-md leading-relaxed">
                  {sourceError ||
                    'Launch the Windows Electron application to enumerate EA SPORTS FC 26 windows and preview available capture sources.'}
                </p>
              </div>
            )}

            {/* Live Recording Telemetry Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-white/[0.08] text-[12px]">
              <div>
                <div className="text-[#7D8798]">Session State</div>
                <div className="mt-0.5 font-semibold text-white uppercase flex items-center gap-1.5">
                  {recordingTelemetry.uiStatus === 'recording' && (
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  )}
                  {recordingTelemetry.uiStatus === 'idle'
                    ? isRecordingImplemented
                      ? 'Ready'
                      : 'Unavailable'
                    : recordingTelemetry.uiStatus}
                </div>
              </div>

              <div>
                <div className="text-[#7D8798]">Active Duration</div>
                <div className="mt-0.5 font-mono tabular-nums text-white">
                  {formatDuration(recordingTelemetry.activeDurationSeconds)}
                </div>
              </div>

              <div>
                <div className="text-[#7D8798]">Segment / Completed</div>
                <div className="mt-0.5 font-mono tabular-nums text-white">
                  #{recordingTelemetry.currentSegmentIndex || 0} ·{' '}
                  {recordingTelemetry.completedSegmentCount} saved
                </div>
              </div>

              <div>
                <div className="text-[#7D8798]">Captured Size</div>
                <div className="mt-0.5 font-mono tabular-nums text-white">
                  {formatBytes(recordingTelemetry.totalBytes)}
                </div>
              </div>

              <div>
                <div className="text-[#7D8798]">Encoder & FPS</div>
                <div className="mt-0.5 font-mono tabular-nums text-[#D7DDE7]">
                  {recordingTelemetry.encoder ?? diag?.preferredEncoder ?? '—'} ·{' '}
                  {recordingTelemetry.currentFps !== null
                    ? `${recordingTelemetry.currentFps} FPS`
                    : `${effectiveFps} FPS target`}
                </div>
              </div>

              <div>
                <div className="text-[#7D8798]">Resolution</div>
                <div className="mt-0.5 font-mono tabular-nums text-[#D7DDE7]">
                  {recordingTelemetry.captureResolution ?? effectiveResolution}
                </div>
              </div>

              <div>
                <div className="text-[#7D8798]">Audio Mode</div>
                <div className="mt-0.5 text-[#D7DDE7] truncate">
                  {isSessionActive
                    ? recordingTelemetry.audioActive
                      ? 'Loopback Active'
                      : 'Video-only'
                    : captureCfg?.audioEnabled
                      ? 'Loopback Requested'
                      : 'Video-only'}
                </div>
              </div>

              <div>
                <div className="text-[#7D8798]">FFmpeg / Queue</div>
                <div className="mt-0.5 font-mono tabular-nums text-[#D7DDE7]">
                  {recordingTelemetry.ffmpegStatus}
                  {recordingTelemetry.backpressureActive ? ' (Backpressure)' : ''}
                </div>
              </div>
            </div>

            {/* Phase 3.0.1 Active Storage Location & Human-Readable Video Filename */}
            {(recordingTelemetry.sessionDirectory ||
              recordingTelemetry.outputDirectory ||
              matchStorageFolders?.matchDirectory) && (
              <div className="rounded-md border border-white/[0.08] bg-[#0C0F14] p-3 text-[11px] space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white">Recording Storage</span>
                    <span className="font-mono text-emerald-400">
                      {recordingTelemetry.storageLayoutVersion === 1
                        ? 'Legacy v1'
                        : matchStorageFolders?.storageLayoutVersion === 1 && !isSessionActive
                          ? 'Legacy v1'
                          : 'Structured v2'}
                    </span>
                    {(recordingTelemetry.recordedFormationName ||
                      selectedMatch?.startingFormation) && (
                      <span className="font-mono text-[#9AA4B4]">
                        · Formation:{' '}
                        {recordingTelemetry.recordedFormationName ??
                          selectedMatch?.startingFormation}
                      </span>
                    )}
                    {recordingTelemetry.half && (
                      <span className="font-mono text-[#9AA4B4]">
                        · {recordingTelemetry.half === 'first_half' ? 'First Half' : 'Second Half'}
                      </span>
                    )}
                  </div>
                  {isNativeElectron &&
                    (recordingTelemetry.sessionId || matchStorageFolders?.matchFolderExists) && (
                      <button
                        type="button"
                        onClick={() =>
                          void handleOpenTrustedFolder(
                            recordingTelemetry.sessionId
                              ? recordingTelemetry.half === 'second_half'
                                ? 'second_half'
                                : 'first_half'
                              : 'match',
                            {
                              matchId: recordingTelemetry.matchId ?? selectedMatch?.id,
                              sessionId: recordingTelemetry.sessionId ?? undefined,
                            }
                          )
                        }
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-white/[0.12] hover:border-emerald-500/50 text-[#D7DDE7]"
                      >
                        <FolderOpen className="w-3 h-3" />
                        Open Recording Folder
                      </button>
                    )}
                </div>
                <div className="font-mono text-[#9AA4B4] break-all">
                  Folder:{' '}
                  <span className="text-[#D7DDE7]">
                    {recordingTelemetry.sessionDirectory ??
                      recordingTelemetry.outputDirectory ??
                      matchStorageFolders?.primaryDisplayPath ??
                      matchStorageFolders?.matchDirectory}
                  </span>
                </div>
                {recordingTelemetry.currentFileName && (
                  <div className="font-mono text-[#9AA4B4] break-all">
                    Active File:{' '}
                    <span className="text-emerald-300">{recordingTelemetry.currentFileName}</span>
                  </div>
                )}
              </div>
            )}

            {/* Warnings & Errors */}
            {(recordingTelemetry.lastError || recordingTelemetry.lastWarning || lowDiskWarning) && (
              <div className="space-y-2 text-[12px]">
                {recordingTelemetry.lastError && (
                  <div className="border border-red-500/35 bg-red-500/[0.08] rounded-md px-3.5 py-2 text-red-200">
                    {recordingTelemetry.lastError}
                  </div>
                )}
                {recordingTelemetry.lastWarning && (
                  <div className="border border-amber-500/30 bg-amber-500/[0.08] rounded-md px-3.5 py-2 text-amber-200">
                    {recordingTelemetry.lastWarning}
                  </div>
                )}
                {lowDiskWarning && (
                  <div className="border border-amber-500/35 bg-amber-500/[0.08] rounded-md px-3.5 py-2 text-amber-200">
                    Low disk space warning ({formatBytes(diskBytesToDisplay)} free). Recording will
                    automatically finalize safely if available space drops below 150 MB.
                  </div>
                )}
              </div>
            )}

            {/* Phase 2 Recording Controls */}
            <div className="pt-3 border-t border-white/[0.08] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <span className="font-medium text-[#C5CCD7]">
                  Match Recording Controls
                </span>
                <span className="text-[#7D8798]">
                  {isSessionActive
                    ? `Active Session ${recordingTelemetry.sessionId?.slice(0, 8)} · Recording persists while navigating views`
                    : isRecordingImplemented
                      ? 'Select FC 26 window and start recording at kickoff'
                      : 'Disabled until runtime prerequisites pass'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {!isSessionActive ? (
                  <>
                    <button
                      type="button"
                      disabled={
                        !isRecordingImplemented ||
                        !selectedMatch ||
                        !selectedSource ||
                        busyAction !== null
                      }
                      onClick={() => void handleStartHalf('first_half')}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-[#1E242E] disabled:text-[#687283] text-white text-[13px] font-medium transition-colors"
                    >
                      <Play className="w-3.5 h-3.5" />
                      {hasFailedFirstHalf
                        ? 'Retry First-Half Recording'
                        : 'Start First-Half Recording'}
                    </button>

                    <button
                      type="button"
                      disabled={
                        !isRecordingImplemented ||
                        !selectedMatch ||
                        !selectedSource ||
                        busyAction !== null
                      }
                      onClick={() => void handleStartHalf('second_half')}
                      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-white/[0.14] hover:border-emerald-500/60 disabled:opacity-40 text-white text-[13px] font-medium transition-colors"
                    >
                      <Play className="w-3.5 h-3.5 text-emerald-400" />
                      {hasValidFirstHalf
                        ? 'Start Second-Half Recording'
                        : 'Record Second Half (Optional)'}
                    </button>
                  </>
                ) : (
                  <>
                    {recordingTelemetry.uiStatus === 'recording' && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void handlePause()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 text-[13px] font-medium"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        Pause Recording
                      </button>
                    )}

                    {recordingTelemetry.uiStatus === 'paused' && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void handleResume()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Resume Recording
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={
                        busyAction !== null || recordingTelemetry.uiStatus === 'finalizing'
                      }
                      onClick={() => void handleStopAndFinalize()}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-[13px] font-medium"
                    >
                      <Square className="w-3.5 h-3.5" />
                      {recordingTelemetry.half === 'second_half'
                        ? 'End Second Half & Save'
                        : 'End First Half & Save'}
                    </button>

                    {recordingTelemetry.sessionId && recordingTelemetry.matchId && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() =>
                          setDiscardTarget({
                            sessionId: recordingTelemetry.sessionId!,
                            matchId: recordingTelemetry.matchId!,
                            isFinalized: false,
                            step: 1,
                          })
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-white/[0.12] hover:border-red-500/40 text-[#C5CCD7] hover:text-red-300 text-[13px]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Discard
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Explicit Discard Confirmation Box */}
              {discardTarget && (
                <div className="border border-red-500/35 bg-[#191114] rounded-md p-3.5 flex flex-wrap items-center justify-between gap-3 text-[12px]">
                  <div className="text-red-200">
                    {discardTarget.isFinalized && discardTarget.step === 2
                      ? 'Final confirmation: Permanently delete all verified MP4 segments for this finalized recording session?'
                      : discardTarget.isFinalized
                        ? 'This session is already finalized. Step 1 of 2: Are you sure you want to permanently discard its local MP4 files?'
                        : 'Stop and permanently remove all local MP4 files for this recording session?'}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDiscardTarget(null)}
                      className="px-3 py-1 rounded border border-white/[0.12] text-[#C5CCD7]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => void handleConfirmDiscard()}
                      className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-medium"
                    >
                      {discardTarget.isFinalized && discardTarget.step === 1
                        ? 'Continue to Final Confirmation'
                        : 'Confirm Permanent Discard'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Phase 2.1 Collapsible Real-Time Recording Pipeline Diagnostics Panel */}
            <div className="pt-3 border-t border-white/[0.08] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowPipelineDiagnostics((v) => !v)}
                  className="inline-flex items-center gap-2 text-[12px] font-semibold text-[#D7DDE7] hover:text-white"
                >
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  Recording Pipeline Diagnostics
                  {showPipelineDiagnostics ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>
                {isNativeElectron && (
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => void handleOpenDiagnosticsFolder()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.12] hover:border-white/[0.24] text-[#C5CCD7]"
                    >
                      <FolderOpen className="w-3 h-3" />
                      Open Diagnostics Folder
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleExportDiagnostics(recordingTelemetry.sessionId)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.12] hover:border-emerald-500/50 text-[#C5CCD7]"
                    >
                      <Download className="w-3 h-3" />
                      Export Diagnostics
                    </button>
                  </div>
                )}
              </div>

              {showPipelineDiagnostics && (
                <div className="rounded-md border border-white/[0.08] bg-[#0C0F14] p-3.5 space-y-3 text-[11px] font-mono">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div>
                      <div className="text-[#7D8798]">MediaStream / Video Track</div>
                      <div className="text-white mt-0.5">
                        {pipelineDiag?.renderer.mediaStreamActive ? 'ACTIVE' : 'INACTIVE'} ·{' '}
                        {pipelineDiag?.renderer.videoTrackState ?? 'none'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[#7D8798]">MediaRecorder / MIME</div>
                      <div className="text-white mt-0.5 truncate" title={pipelineDiag?.renderer.negotiatedMimeType ?? ''}>
                        {pipelineDiag?.renderer.mediaRecorderState ?? 'inactive'} ·{' '}
                        {pipelineDiag?.renderer.negotiatedMimeType || '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[#7D8798]">MessagePort Transport</div>
                      <div className="text-white mt-0.5">
                        {pipelineDiag?.transportPortAttached ? 'ATTACHED' : 'DETACHED'} ·{' '}
                        {pipelineDiag?.transportPortReadyAck ? 'ACK OK' : 'NO ACK'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[#7D8798]">Watchdogs (Start / Stall)</div>
                      <div className="text-white mt-0.5">
                        {pipelineDiag?.startupWatchdogState ?? 'idle'} /{' '}
                        {pipelineDiag?.stallWatchdogState ?? 'idle'}
                      </div>
                    </div>

                    <div>
                      <div className="text-[#7D8798]">Renderer Chunks Gen / Sent</div>
                      <div className="text-white mt-0.5 tabular-nums">
                        {pipelineDiag?.renderer.chunksGenerated ?? 0} /{' '}
                        {pipelineDiag?.renderer.chunksTransmitted ?? 0} (fail{' '}
                        {pipelineDiag?.renderer.chunksFailedTransport ?? 0})
                      </div>
                    </div>
                    <div>
                      <div className="text-[#7D8798]">Main Chunks / Bytes Recv</div>
                      <div className="text-white mt-0.5 tabular-nums">
                        {pipelineDiag?.chunksReceivedMain ?? 0} ·{' '}
                        {formatBytes(pipelineDiag?.bytesReceivedMain ?? 0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[#7D8798]">FFmpeg PID / Lifetime Stdin</div>
                      <div className="text-white mt-0.5 tabular-nums">
                        PID {pipelineDiag?.ffmpegPid ?? '—'} ·{' '}
                        {formatBytes(
                          pipelineDiag?.lifetimeSessionStdinBytesWritten ??
                            pipelineDiag?.ffmpegStdinBytesWritten ??
                            0
                        )}
                        {pipelineDiag?.ffmpegState === 'running' &&
                        pipelineDiag.currentProcessStdinBytesWritten !== undefined &&
                        pipelineDiag.currentProcessStdinBytesWritten !==
                          (pipelineDiag.lifetimeSessionStdinBytesWritten ??
                            pipelineDiag.ffmpegStdinBytesWritten)
                          ? ` (proc ${formatBytes(pipelineDiag.currentProcessStdinBytesWritten)})`
                          : ''}
                      </div>
                    </div>
                    <div>
                      <div className="text-[#7D8798]">Disk File / Queue / Drops</div>
                      <div className="text-white mt-0.5 tabular-nums">
                        {formatBytes(pipelineDiag?.currentOutputFileBytes ?? 0)} · Q{' '}
                        {pipelineDiag?.queueSizeChunks ?? 0} · drop {pipelineDiag?.droppedChunks ?? 0}
                      </div>
                    </div>
                  </div>

                  {pipelineDiag?.lastChunkReceivedAt && (
                    <div className="text-[#8A94A6]">
                      Last Chunk Received in Main: {pipelineDiag.lastChunkReceivedAt} ·
                      Backpressure Events: {pipelineDiag.backpressureEvents} · FFmpeg Exit:{' '}
                      {pipelineDiag.ffmpegExitCode ?? 'running/none'}
                    </div>
                  )}

                  {(pipelineDiag?.lastFfmpegError ||
                    pipelineDiag?.lastPipelineError ||
                    pipelineDiag?.renderer.lastRendererError) && (
                    <div className="border border-red-500/30 bg-red-500/[0.08] rounded p-2 text-red-200 whitespace-pre-wrap break-all">
                      {pipelineDiag.lastFfmpegError ||
                        pipelineDiag.lastPipelineError ||
                        pipelineDiag.renderer.lastRendererError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Persisted Recorded Sessions & Post-Finalization Summary for Bound Match */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Film className="w-4 h-4 text-emerald-400" />
                <h2 className="text-[15px] font-semibold text-white">
                  Recorded Halves for Selected Match ({matchSessions.length})
                </h2>
              </div>
              <span className="text-[12px] text-[#8A94A6]">
                Local H.264 MP4 · Ready for Phase 3 Half-Time Analysis
              </span>
            </div>

            {matchSessions.length > 0 ? (
              <div className="space-y-3">
                {matchSessions.map((sess) => {
                  const finalizedSegs = sess.segments.filter(
                    (s) => s.status === 'finalized' || s.status === 'recovered'
                  );
                  return (
                    <div
                      key={sess.id}
                      className="border border-white/[0.07] bg-[#0D1015] rounded-md p-4 space-y-3 text-[12px]"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold text-white text-[13px] flex items-center gap-2">
                            <span>
                              {sess.half === 'first_half' ? 'First Half' : 'Second Half'} ·{' '}
                              <span
                                className={`capitalize ${
                                  sess.status === 'failed'
                                    ? 'text-red-400'
                                    : sess.status === 'partial'
                                      ? 'text-amber-300'
                                      : 'text-emerald-400'
                                }`}
                              >
                                {sess.status}
                              </span>
                            </span>
                            {sess.status === 'failed' ? (
                              <span className="text-[11px] font-mono text-red-300">
                                NOT AI-ELIGIBLE
                              </span>
                            ) : sess.aiEligible !== false &&
                              sess.integrityStatus === 'verified' ? (
                              <span className="text-[11px] font-mono text-sky-300">
                                {sess.analysisState === 'analysis_completed'
                                  ? 'ANALYSIS COMPLETED'
                                  : 'AWAITING ANALYSIS (PHASE 3)'}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 font-mono tabular-nums text-[#8A94A6]">
                            {formatDuration(sess.durationSeconds)} · {finalizedSegs.length} valid
                            segment{finalizedSegs.length === 1 ? '' : 's'} ·{' '}
                            {formatBytes(sess.totalBytes)} · {sess.resolution} @ {sess.fps} FPS ·{' '}
                            {sess.storageLayoutVersion === 2 ? 'Structured v2' : 'Legacy v1'}
                            {sess.recordedFormationName ? ` · ${sess.recordedFormationName}` : ''} ·
                            Integrity:{' '}
                            <span
                              className={
                                sess.integrityStatus === 'verified'
                                  ? 'text-emerald-400'
                                  : sess.integrityStatus === 'partial'
                                    ? 'text-amber-300'
                                    : sess.integrityStatus === 'corrupted'
                                      ? 'text-red-400'
                                      : 'text-[#C5CCD7]'
                              }
                            >
                              {sess.integrityStatus ?? 'pending'}
                            </span>
                          </div>
                          {(sess.sessionDirectory || sess.outputDirectory) && (
                            <div className="mt-0.5 font-mono text-[11px] text-[#7D8798] break-all">
                              {sess.sessionDirectory ?? sess.outputDirectory}
                            </div>
                          )}
                          {sess.failureReason && (
                            <div className="mt-1.5 text-[11px] text-red-300">
                              Failure Reason: {sess.failureReason}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {isNativeElectron && (
                            <button
                              type="button"
                              onClick={() => void handleExportDiagnostics(sess.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.12] hover:border-emerald-500/50 text-[#D7DDE7]"
                            >
                              <Download className="w-3.5 h-3.5" />
                              Diagnostics
                            </button>
                          )}
                          {isNativeElectron && (sess.outputDirectory || sess.sessionDirectory) && (
                            <button
                              type="button"
                              onClick={() =>
                                void handleOpenTrustedFolder(
                                  sess.half === 'second_half' ? 'second_half' : 'first_half',
                                  {
                                    sessionId: sess.id,
                                    matchId: sess.matchId,
                                  }
                                )
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.12] hover:border-white/[0.25] text-[#D7DDE7]"
                            >
                              <FolderOpen className="w-3.5 h-3.5" />
                              Open Recording Folder
                            </button>
                          )}
                          {isNativeElectron && (
                            <button
                              type="button"
                              disabled={isSessionActive}
                              onClick={() =>
                                setDiscardTarget({
                                  sessionId: sess.id,
                                  matchId: sess.matchId,
                                  isFinalized:
                                    sess.status === 'completed' ||
                                    sess.status === 'recovered' ||
                                    sess.status === 'partial',
                                  step: 1,
                                })
                              }
                              className="px-2.5 py-1 rounded border border-red-500/25 hover:bg-red-500/10 text-red-300 disabled:opacity-40"
                            >
                              Discard
                            </button>
                          )}
                        </div>
                      </div>

                      {sess.segments.length > 0 && (
                        <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] pt-2">
                          {sess.segments.map((seg) => (
                            <div
                              key={seg.id}
                              className="py-1.5 flex flex-wrap items-center justify-between gap-2"
                            >
                              <div className="font-mono tabular-nums text-[#C5CCD7] break-all">
                                {seg.displayFileName ||
                                  `segment_${String(seg.segmentIndex).padStart(3, '0')}.mp4`}{' '}
                                · {formatDuration(seg.durationSeconds)} ·{' '}
                                {formatBytes(seg.sizeBytes)}
                                {seg.codec ? ` · ${seg.codec}` : ''}
                                {seg.hasAudio ? ' · AAC' : ' · Video-only'}
                              </div>
                              <div className="flex items-center gap-2">
                                <span
                                  className={`font-mono uppercase text-[11px] ${
                                    seg.status === 'finalized' || seg.status === 'recovered'
                                      ? 'text-emerald-400'
                                      : seg.status === 'corrupted'
                                        ? 'text-red-400'
                                        : 'text-amber-300'
                                  }`}
                                >
                                  {seg.status}
                                </span>
                                {isNativeElectron &&
                                  (seg.status === 'finalized' || seg.status === 'recovered') && (
                                    <button
                                      type="button"
                                      onClick={() => void handleOpenSegment(seg.filePath)}
                                      className="px-2 py-0.5 rounded border border-white/[0.12] hover:border-emerald-500/60 text-white text-[11px]"
                                    >
                                      Play Segment
                                    </button>
                                  )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {sess.status === 'failed' ? (
                        <div className="text-[11px] text-red-200/90 pt-1 border-t border-white/[0.06]">
                          No verified non-empty MP4 segments were saved. This session will NOT
                          advance the match to Half-Time Ready. Use &ldquo;Retry First-Half
                          Recording&rdquo; above or export diagnostics to inspect the failure.
                        </div>
                      ) : (sess.status === 'completed' ||
                          sess.status === 'recovered' ||
                          sess.status === 'partial') &&
                        sess.aiEligible !== false &&
                        finalizedSegs.some((s) => s.sizeBytes > 0 && s.durationSeconds > 0) ? (
                        <div className="pt-2 border-t border-white/[0.06] space-y-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8A94A6]">
                            <div>
                              <strong className="text-emerald-300">Recording Verified</strong> ·{' '}
                              <strong className="text-white">Technically AI-Eligible</strong> ·{' '}
                              <strong className="text-sky-300">
                                {sess.analysisState === 'analysis_completed'
                                  ? 'Analysis Completed'
                                  : 'Ready for Gemini Video Analysis'}
                              </strong>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setAnalysisLaunchSessionId((prev) =>
                                    prev === sess.id ? null : sess.id
                                  );
                                  setPrivacyAck(false);
                                  setEntireDisplayAck(false);
                                }}
                                className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium"
                              >
                                <Sparkles className="w-3.5 h-3.5" />
                                {sess.half === 'first_half'
                                  ? 'Analyze First Half'
                                  : 'Analyze Second Half'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setActiveSection('halftime-briefing')}
                                className="px-2.5 py-1 rounded border border-white/[0.12] hover:border-emerald-500/50 text-[11px] text-[#D7DDE7]"
                              >
                                Open Briefing
                              </button>
                            </div>
                          </div>

                          {analysisLaunchSessionId === sess.id && (
                            <div className="rounded border border-emerald-500/30 bg-[#0B1210] p-3 space-y-2.5 text-[12px]">
                              <div className="flex flex-wrap items-center gap-3">
                                <label className="flex items-center gap-1.5 text-[#C5CCD7]">
                                  <span>Mode:</span>
                                  <select
                                    value={analysisMode}
                                    onChange={(e) =>
                                      setAnalysisMode(e.target.value as VideoAnalysisMode)
                                    }
                                    className="bg-[#12151B] border border-white/[0.12] rounded px-2 py-1 text-[11px] text-white"
                                  >
                                    <option value="quick">Quick</option>
                                    <option value="balanced">Balanced</option>
                                    <option value="deep">Deep</option>
                                  </select>
                                </label>
                                <label className="flex items-center gap-1.5 text-[#C5CCD7]">
                                  <span>Language:</span>
                                  <select
                                    value={analysisLang}
                                    onChange={(e) =>
                                      setAnalysisLang(e.target.value as AnalysisLanguage)
                                    }
                                    className="bg-[#12151B] border border-white/[0.12] rounded px-2 py-1 text-[11px] text-white"
                                  >
                                    <option value="en">English</option>
                                    <option value="id">Bahasa Indonesia</option>
                                  </select>
                                </label>
                              </div>

                              <label className="flex items-start gap-2 cursor-pointer text-[11px] text-[#D7DDE7]">
                                <input
                                  type="checkbox"
                                  checked={privacyAck}
                                  onChange={(e) => setPrivacyAck(e.target.checked)}
                                  className="mt-0.5 accent-emerald-500"
                                />
                                <span>
                                  I authorize uploading this local MP4 recording to the configured
                                  Gemini Files API for tactical analysis (remote file deletion is
                                  enabled after completion).
                                </span>
                              </label>

                              {(sess.captureSourceName ?? '').toLowerCase().includes('screen') ||
                              (sess.captureSourceName ?? '').toLowerCase().includes('display') ? (
                                <label className="flex items-start gap-2 cursor-pointer text-[11px] text-amber-200">
                                  <input
                                    type="checkbox"
                                    checked={entireDisplayAck}
                                    onChange={(e) => setEntireDisplayAck(e.target.checked)}
                                    className="mt-0.5 accent-amber-500"
                                  />
                                  <span>
                                    Entire Display capture detected ({sess.captureSourceName}). I
                                    confirm no private desktop content should block upload.
                                  </span>
                                </label>
                              ) : null}

                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setAnalysisLaunchSessionId(null)}
                                  className="px-3 py-1 rounded border border-white/[0.12] text-[11px] text-[#C5CCD7]"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    startingAnalysis ||
                                    !privacyAck ||
                                    (((sess.captureSourceName ?? '').toLowerCase().includes('screen') ||
                                      (sess.captureSourceName ?? '')
                                        .toLowerCase()
                                        .includes('display')) &&
                                      !entireDisplayAck)
                                  }
                                  onClick={async () => {
                                    setStartingAnalysis(true);
                                    try {
                                      await desktopBridge.startMatchVideoAnalysis(sess.matchId, {
                                        sessionId: sess.id,
                                        half: sess.half,
                                        analysisMode,
                                        language: analysisLang,
                                        privacyAuthorized: privacyAck,
                                        entireDisplayAcknowledged: entireDisplayAck,
                                      });
                                      setAnalysisLaunchSessionId(null);
                                      notify(
                                        'success',
                                        `Started ${analysisMode} Gemini video analysis for ${
                                          sess.half === 'first_half' ? 'First Half' : 'Second Half'
                                        }.`
                                      );
                                      setActiveSection('halftime-briefing');
                                    } catch (err) {
                                      notify(
                                        'error',
                                        err instanceof Error
                                          ? err.message
                                          : 'Failed to launch AI video analysis'
                                      );
                                    } finally {
                                      setStartingAnalysis(false);
                                    }
                                  }}
                                  className="px-3.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-45 text-white text-[11px] font-medium"
                                >
                                  {startingAnalysis ? 'Launching...' : 'Confirm & Start Analysis'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[13px] text-[#8A94A6]">
                No recording sessions saved yet for this match. Start a First-Half Recording above
                when kickoff begins in EA SPORTS FC 26.
              </p>
            )}
          </section>
        </div>

        {/* Right 5 cols: Persisted Recording Configuration & Half-Time Rules */}
        <div className="xl:col-span-5 space-y-6">
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-white">Recording Configuration</h2>
              <span className="text-[12px] text-emerald-400">SQLite Persisted</span>
            </div>

            {captureCfg && (
              <div className="space-y-4 text-[13px]">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] text-[#9AA4B4] mb-1">Resolution</label>
                    <select
                      value={effectiveResolution}
                      disabled={isSessionActive}
                      onChange={(e) =>
                        void handleQuickCaptureSetting({
                          resolution: e.target.value as '1920x1080' | '1280x720',
                        })
                      }
                      className="w-full bg-[#0C0F14] border border-white/[0.12] disabled:opacity-60 rounded-md px-2.5 py-1.5 text-[13px] text-white font-mono"
                    >
                      <option value="1280x720">1280×720 (Recommended)</option>
                      <option value="1920x1080">1920×1080 (Full HD)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] text-[#9AA4B4] mb-1">Frame Rate</label>
                    <select
                      value={effectiveFps}
                      disabled={isSessionActive}
                      onChange={(e) =>
                        void handleQuickCaptureSetting({ fps: Number(e.target.value) })
                      }
                      className="w-full bg-[#0C0F14] border border-white/[0.12] disabled:opacity-60 rounded-md px-2.5 py-1.5 text-[13px] text-white font-mono tabular-nums"
                    >
                      <option value={30}>30 FPS (Default)</option>
                      <option value={20}>20 FPS (Low Overhead)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] text-[#9AA4B4] mb-1">
                      Segment Length
                    </label>
                    <select
                      value={captureCfg.segmentDurationMinutes}
                      disabled={isSessionActive}
                      onChange={(e) =>
                        void handleQuickCaptureSetting({
                          segmentDurationMinutes: Number(e.target.value),
                        })
                      }
                      className="w-full bg-[#0C0F14] border border-white/[0.12] disabled:opacity-60 rounded-md px-2.5 py-1.5 text-[13px] text-white font-mono tabular-nums"
                    >
                      <option value={2}>2 min segments</option>
                      <option value={3}>3 min segments (Default)</option>
                      <option value={4}>4 min segments</option>
                      <option value={5}>5 min segments</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] text-[#9AA4B4] mb-1">
                      Video Codec / Format
                    </label>
                    <div className="bg-[#0C0F14] border border-white/[0.08] rounded-md px-2.5 py-1.5 text-[13px] text-[#B8C0CE] font-mono">
                      H.264 / MP4 (yuv420p)
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-white/[0.08] space-y-2 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="text-[#8A94A6]">Estimated 15-Min Half Size</span>
                    <span className="font-mono tabular-nums text-white">
                      ~{estimatedHalfSizeMb} MB ({captureCfg.bitrateKbps} kbps)
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#8A94A6] inline-flex items-center gap-1.5">
                      <HardDrive className="w-3.5 h-3.5" />
                      Available Disk Space
                    </span>
                    <span
                      className={`font-mono tabular-nums ${
                        lowDiskWarning ? 'text-amber-300 font-semibold' : 'text-[#C5CCD7]'
                      }`}
                    >
                      {formatBytes(diskBytesToDisplay)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#8A94A6]">Max Recording Safeguard</span>
                    <span className="font-mono tabular-nums text-[#C5CCD7]">
                      {captureCfg.maxRecordingMinutes} min auto-stop
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#8A94A6]">Windows Loopback Audio</span>
                    <span className="text-[#C5CCD7]">
                      {captureCfg.audioEnabled ? 'Enabled (System Audio)' : 'Disabled (Video-only)'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#8A94A6]">Microphone Input</span>
                    <span className="text-emerald-400">Permanently Disabled</span>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-2.5 text-[12px] text-[#9AA4B4]">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
              <AlertTriangle className="w-4 h-4 text-emerald-400" />
              Half-Time Analyst Operational Rules
            </div>
            <p className="leading-relaxed">
              While recording is active, no frames or segments are sent to Gemini, no AI
              notifications interrupt gameplay, and no controller or keyboard inputs are
              intercepted.
            </p>
            <p className="leading-relaxed">
              New recordings write in crash-resilient fragmented{' '}
              {captureCfg?.segmentDurationMinutes ?? 3}-minute local MP4 segments organized under
              human-readable Career Mode folders in your Electron{' '}
              <code className="font-mono">userData</code> directory, while preserving all existing
              legacy recordings untouched.
            </p>
            <p className="leading-relaxed">
              If Windows system loopback audio is enabled, other desktop applications playing audio
              may also be captured. Microphone capture is permanently disabled.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
