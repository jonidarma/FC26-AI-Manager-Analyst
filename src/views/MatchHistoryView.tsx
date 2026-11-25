import { Check, Copy, Film, FolderOpen, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { desktopBridge } from '../services/desktopBridge';
import { recordingController } from '../services/recordingController';
import type {
  FeedbackChoice,
  MatchRecord,
  MatchSessionWithSegments,
  MatchStorageFoldersInfo,
  TrustedFolderKind,
} from '../types/domain';

const FEEDBACK_LABELS: Record<FeedbackChoice, string> = {
  applied_all: 'Applied all recommendations',
  applied_some: 'Applied some recommendations',
  not_applied: 'Did not apply recommendations',
  custom_changes: 'Made my own tactical changes',
};

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function MatchHistoryView() {
  const {
    capabilities,
    matches,
    recordingSessions,
    feedbackRecords,
    refreshAll,
    notify,
    setSelectedMatchId,
    setActiveSection,
  } = useApp();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'scheduled' | 'completed'>('all');
  const [editingResultMatchId, setEditingResultMatchId] = useState<string | null>(null);
  const [scoreFor, setScoreFor] = useState('');
  const [scoreAgainst, setScoreAgainst] = useState('');
  const [htScoreFor, setHtScoreFor] = useState('');
  const [htScoreAgainst, setHtScoreAgainst] = useState('');

  const [feedbackMatchId, setFeedbackMatchId] = useState<string | null>(null);
  const [feedbackChoice, setFeedbackChoice] = useState<FeedbackChoice>('applied_some');
  const [feedbackNotes, setFeedbackNotes] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [expandedRecordingsMatchId, setExpandedRecordingsMatchId] = useState<string | null>(null);
  const [confirmDiscardSession, setConfirmDiscardSession] = useState<{
    sessionId: string;
    matchId: string;
    step: 1 | 2;
  } | null>(null);
  const [foldersByMatch, setFoldersByMatch] = useState<
    Record<string, MatchStorageFoldersInfo | undefined>
  >({});

  const isNativeElectron = capabilities?.environment === 'electron-native';

  useEffect(() => {
    if (!expandedRecordingsMatchId) return;
    let active = true;
    desktopBridge
      .getMatchStorageFolders(expandedRecordingsMatchId)
      .then((info) => {
        if (active) {
          setFoldersByMatch((prev) => ({ ...prev, [expandedRecordingsMatchId]: info }));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [expandedRecordingsMatchId, recordingSessions.length]);

  const feedbackByMatch = useMemo(
    () => new Map(feedbackRecords.map((f) => [f.matchId, f])),
    [feedbackRecords]
  );

  const sessionsByMatch = useMemo(() => {
    const map = new Map<string, MatchSessionWithSegments[]>();
    for (const sess of recordingSessions) {
      if (sess.status === 'discarded') continue;
      const list = map.get(sess.matchId) ?? [];
      list.push(sess);
      map.set(sess.matchId, list);
    }
    return map;
  }, [recordingSessions]);

  const filteredMatches = useMemo(() => {
    return matches.filter((m) => {
      if (statusFilter === 'scheduled' && m.status !== 'scheduled') return false;
      if (statusFilter === 'completed' && m.status !== 'completed') return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          m.opponentName.toLowerCase().includes(q) ||
          m.competition.toLowerCase().includes(q) ||
          m.startingFormation.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [matches, searchQuery, statusFilter]);

  function openResultEditor(m: MatchRecord) {
    setEditingResultMatchId(m.id);
    setScoreFor(m.finalScoreFor !== null ? String(m.finalScoreFor) : '');
    setScoreAgainst(m.finalScoreAgainst !== null ? String(m.finalScoreAgainst) : '');
    setHtScoreFor(m.halftimeScoreFor !== null ? String(m.halftimeScoreFor) : '');
    setHtScoreAgainst(m.halftimeScoreAgainst !== null ? String(m.halftimeScoreAgainst) : '');
  }

  async function handleSaveResult(matchId: string) {
    const fFor = scoreFor.trim() === '' ? null : Number(scoreFor);
    const fAgainst = scoreAgainst.trim() === '' ? null : Number(scoreAgainst);
    const hFor = htScoreFor.trim() === '' ? null : Number(htScoreFor);
    const hAgainst = htScoreAgainst.trim() === '' ? null : Number(htScoreAgainst);

    if (
      (fFor !== null && (Number.isNaN(fFor) || fFor < 0)) ||
      (fAgainst !== null && (Number.isNaN(fAgainst) || fAgainst < 0))
    ) {
      notify('error', 'Enter valid non-negative integer scores.');
      return;
    }

    try {
      await desktopBridge.updateMatch(matchId, {
        halftimeScoreFor: hFor,
        halftimeScoreAgainst: hAgainst,
        finalScoreFor: fFor,
        finalScoreAgainst: fAgainst,
        status: fFor !== null && fAgainst !== null ? 'completed' : undefined,
      });
      setEditingResultMatchId(null);
      await refreshAll();
      notify('success', 'Match score saved and marked complete.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save match result');
    }
  }

  function openFeedbackEditor(matchId: string) {
    const existing = feedbackByMatch.get(matchId);
    setFeedbackMatchId(matchId);
    setFeedbackChoice(existing?.choice ?? 'applied_some');
    setFeedbackNotes(existing?.notes ?? '');
  }

  async function handleSaveFeedback(matchId: string) {
    try {
      await desktopBridge.saveFeedback(matchId, feedbackChoice, feedbackNotes);
      setFeedbackMatchId(null);
      await refreshAll();
      notify('success', 'Tactical recommendation feedback recorded.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save feedback');
    }
  }

  async function handleDeleteMatch(matchId: string) {
    try {
      await desktopBridge.deleteMatch(matchId);
      setConfirmDeleteId(null);
      await refreshAll();
      notify('info', 'Match record deleted.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to delete match');
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

  async function handleCopyPath(targetPath: string) {
    try {
      await navigator.clipboard.writeText(targetPath);
      notify('success', 'Recording folder path copied to clipboard.');
    } catch {
      notify('error', 'Could not access clipboard to copy recording path.');
    }
  }

  async function handleConfirmDiscardSession() {
    if (!confirmDiscardSession) return;
    if (confirmDiscardSession.step === 1) {
      setConfirmDiscardSession({ ...confirmDiscardSession, step: 2 });
      return;
    }
    try {
      const res = await recordingController.discardRecording(
        confirmDiscardSession.sessionId,
        confirmDiscardSession.matchId
      );
      setConfirmDiscardSession(null);
      await refreshAll();
      notify('info', `Recording discarded (${res.removedFiles} local file(s) deleted).`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to discard recording');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Match History</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Review past fixtures, inspect recorded first-half and second-half video sessions, log
            final scores, and track tactical recommendation adoption.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#7D8798] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search opponent, competition..."
              className="pl-8 pr-3 py-1.5 bg-[#12151B] border border-white/[0.12] rounded-md text-[13px] text-white focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#12151B] border border-white/[0.1] rounded-md">
            {(['all', 'scheduled', 'completed'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-2.5 py-1 rounded text-[12px] font-medium capitalize transition-colors ${
                  statusFilter === st ? 'bg-[#1D232E] text-white' : 'text-[#8A94A6] hover:text-white'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>
      </div>

      {filteredMatches.length > 0 ? (
        <div className="space-y-3">
          {filteredMatches.map((m) => {
            const fb = feedbackByMatch.get(m.id);
            const matchRecordings = sessionsByMatch.get(m.id) ?? [];
            const isEditingResult = editingResultMatchId === m.id;
            const isEditingFeedback = feedbackMatchId === m.id;
            const isConfirmingDelete = confirmDeleteId === m.id;
            const isShowingRecordings = expandedRecordingsMatchId === m.id;

            return (
              <article
                key={m.id}
                className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-[12px] text-[#8A94A6] font-mono tabular-nums">
                      {m.matchDate} · {m.competition} · {m.venue.toUpperCase()} ·{' '}
                      {m.startingFormation}
                    </div>
                    <h2 className="mt-1 text-[17px] font-semibold text-white">
                      {m.venue === 'home' ? 'vs ' : '@ '}
                      {m.opponentName}
                    </h2>
                    <div className="mt-1 text-[12px] text-[#9AA4B4]">
                      Status:{' '}
                      <span className="capitalize text-white">{m.status.replace(/_/g, ' ')}</span>
                      <span className="mx-2 text-[#4B5362]">·</span>
                      HT:{' '}
                      <span className="font-mono tabular-nums text-white">
                        {m.halftimeScoreFor !== null && m.halftimeScoreAgainst !== null
                          ? `${m.halftimeScoreFor}–${m.halftimeScoreAgainst}`
                          : 'Unrecorded'}
                      </span>
                      <span className="mx-2 text-[#4B5362]">·</span>
                      FT:{' '}
                      <span className="font-mono tabular-nums text-white">
                        {m.finalScoreFor !== null && m.finalScoreAgainst !== null
                          ? `${m.finalScoreFor}–${m.finalScoreAgainst}`
                          : 'Unrecorded'}
                      </span>
                      <span className="mx-2 text-[#4B5362]">·</span>
                      Recordings:{' '}
                      <span className="font-mono tabular-nums text-white">
                        {matchRecordings.length} session{matchRecordings.length === 1 ? '' : 's'}
                      </span>
                      {m.hasSecondHalfRecording && (
                        <>
                          <span className="mx-2 text-[#4B5362]">·</span>
                          <span className="text-emerald-400">2nd Half Recorded</span>
                        </>
                      )}
                      {fb && (
                        <>
                          <span className="mx-2 text-[#4B5362]">·</span>
                          <span className="text-emerald-400">{FEEDBACK_LABELS[fb.choice]}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {matchRecordings.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedRecordingsMatchId(isShowingRecordings ? null : m.id)
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/15 text-[12px] text-emerald-200"
                      >
                        <Film className="w-3.5 h-3.5" />
                        {isShowingRecordings ? 'Hide Recordings' : `Recordings (${matchRecordings.length})`}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openResultEditor(m)}
                      className="px-3 py-1.5 rounded-md border border-white/[0.12] hover:border-emerald-500/60 text-[12px] text-white"
                    >
                      Log Final Score
                    </button>
                    <button
                      type="button"
                      onClick={() => openFeedbackEditor(m.id)}
                      className="px-3 py-1.5 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[12px] text-[#D7DDE7]"
                    >
                      Tactical Feedback
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedMatchId(m.id);
                        setActiveSection('match-capture');
                      }}
                      className="px-3 py-1.5 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[12px] text-[#D7DDE7]"
                    >
                      Capture Deck
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(isConfirmingDelete ? null : m.id)}
                      aria-label={`Delete match vs ${m.opponentName}`}
                      className="p-1.5 rounded hover:bg-red-500/10 text-[#9AA4B4] hover:text-red-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Phase 2 & 3.0.1 Recording Session History Panel */}
                {isShowingRecordings && matchRecordings.length > 0 && (
                  <div className="pt-4 border-t border-white/[0.08] space-y-3">
                    {(() => {
                      const folderInfo = foldersByMatch[m.id];
                      const copyTargetPath =
                        folderInfo?.primaryDisplayPath ??
                        folderInfo?.matchDirectory ??
                        folderInfo?.firstHalfDirectory ??
                        folderInfo?.secondHalfDirectory ??
                        matchRecordings[0]?.outputDirectory ??
                        null;
                      return (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-[12px] font-medium text-[#C5CCD7] flex items-center gap-2">
                            <span>Local Gameplay Recording Sessions</span>
                            {folderInfo && (
                              <span className="font-mono text-[11px] text-emerald-400">
                                {folderInfo.storageLayoutVersion === 2
                                  ? 'Structured v2'
                                  : 'Legacy v1'}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            {isNativeElectron && folderInfo?.matchFolderExists && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleOpenTrustedFolder('match', { matchId: m.id })
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.12] hover:border-emerald-500/50 text-[#D7DDE7]"
                              >
                                <FolderOpen className="w-3 h-3" />
                                Open Match Folder
                              </button>
                            )}
                            {isNativeElectron && folderInfo?.firstHalfExists && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleOpenTrustedFolder('first_half', { matchId: m.id })
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.12] hover:border-white/[0.25] text-[#D7DDE7]"
                              >
                                <FolderOpen className="w-3 h-3" />
                                Open First Half Folder
                              </button>
                            )}
                            {isNativeElectron && folderInfo?.secondHalfExists && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleOpenTrustedFolder('second_half', { matchId: m.id })
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.12] hover:border-white/[0.25] text-[#D7DDE7]"
                              >
                                <FolderOpen className="w-3 h-3" />
                                Open Second Half Folder
                              </button>
                            )}
                            {copyTargetPath && (
                              <button
                                type="button"
                                onClick={() => void handleCopyPath(copyTargetPath)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-white/[0.12] hover:border-white/[0.25] text-[#C5CCD7]"
                              >
                                <Copy className="w-3 h-3" />
                                Copy Recording Path
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                    {matchRecordings.map((sess) => (
                      <div
                        key={sess.id}
                        className="border border-white/[0.07] bg-[#0D1015] rounded-md p-3.5 space-y-2.5 text-[12px]"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-white font-medium">
                              {sess.half === 'first_half' ? 'First Half' : 'Second Half'} ·{' '}
                              <span className="capitalize">{sess.status}</span> ·{' '}
                              <span className="font-mono text-[11px] text-emerald-400">
                                {sess.storageLayoutVersion === 2 ? 'v2' : 'v1'}
                              </span>
                              {sess.recordedFormationName ? (
                                <span className="font-mono text-[11px] text-[#C5CCD7]">
                                  {' '}
                                  · {sess.recordedFormationName}
                                </span>
                              ) : null}{' '}
                              · Integrity:{' '}
                              <span
                                className={
                                  sess.integrityStatus === 'verified'
                                    ? 'text-emerald-400'
                                    : sess.integrityStatus === 'partial'
                                      ? 'text-amber-300'
                                      : 'text-[#C5CCD7]'
                                }
                              >
                                {sess.integrityStatus ?? 'pending'}
                              </span>
                            </div>
                            <div className="text-[#8A94A6] font-mono tabular-nums mt-0.5">
                              {sess.startedAt ? sess.startedAt.slice(0, 19).replace('T', ' ') : '—'}{' '}
                              → {sess.endedAt ? sess.endedAt.slice(0, 19).replace('T', ' ') : '—'} ·{' '}
                              {formatDuration(sess.durationSeconds)} · {sess.segments.length}{' '}
                              segment{sess.segments.length === 1 ? '' : 's'} ·{' '}
                              {formatBytes(sess.totalBytes)} · {sess.resolution} @ {sess.fps} FPS
                            </div>
                            {(sess.sessionDirectory || sess.outputDirectory) && (
                              <div className="text-[#7D8798] font-mono text-[11px] mt-0.5 break-all">
                                {sess.sessionDirectory ?? sess.outputDirectory}
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
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
                                Folder
                              </button>
                            )}
                            {isNativeElectron && (
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmDiscardSession({
                                    sessionId: sess.id,
                                    matchId: sess.matchId,
                                    step: 1,
                                  })
                                }
                                className="px-2.5 py-1 rounded border border-red-500/25 hover:bg-red-500/10 text-red-300"
                              >
                                Delete Video
                              </button>
                            )}
                          </div>
                        </div>

                        {confirmDiscardSession?.sessionId === sess.id && (
                          <div className="border border-red-500/35 bg-[#191114] rounded px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                            <span className="text-red-200">
                              {confirmDiscardSession.step === 1
                                ? 'Step 1 of 2: Permanently delete these verified local MP4 files?'
                                : 'Final confirmation: Permanently delete all MP4 segments for this session?'}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setConfirmDiscardSession(null)}
                                className="px-2.5 py-1 rounded border border-white/[0.12] text-[#C5CCD7]"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleConfirmDiscardSession()}
                                className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-medium"
                              >
                                {confirmDiscardSession.step === 1
                                  ? 'Continue'
                                  : 'Confirm Delete'}
                              </button>
                            </div>
                          </div>
                        )}

                        {sess.segments.length > 0 && (
                          <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] pt-2">
                            {sess.segments.map((seg) => (
                              <div
                                key={seg.id}
                                className="py-1.5 flex flex-wrap items-center justify-between gap-2"
                              >
                                <span className="font-mono tabular-nums text-[#C5CCD7] break-all">
                                  {seg.displayFileName ||
                                    `segment_${String(seg.segmentIndex).padStart(3, '0')}.mp4`}{' '}
                                  · {formatDuration(seg.durationSeconds)} ·{' '}
                                  {formatBytes(seg.sizeBytes)} ·{' '}
                                  <span className="uppercase">{seg.status}</span>
                                </span>
                                {isNativeElectron &&
                                  (seg.status === 'finalized' || seg.status === 'recovered') && (
                                    <button
                                      type="button"
                                      onClick={() => void handleOpenSegment(seg.filePath)}
                                      className="px-2 py-0.5 rounded border border-white/[0.12] hover:border-emerald-500/60 text-white text-[11px]"
                                    >
                                      Play MP4
                                    </button>
                                  )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Inline Manual Score Entry */}
                {isEditingResult && (
                  <div className="pt-4 border-t border-white/[0.08] flex flex-wrap items-end gap-4 text-[12px]">
                    <div>
                      <label className="block text-[#8A94A6] mb-1">HT Goals For</label>
                      <input
                        type="number"
                        min={0}
                        value={htScoreFor}
                        onChange={(e) => setHtScoreFor(e.target.value)}
                        className="w-24 bg-[#0C0F14] border border-white/[0.12] rounded px-2.5 py-1.5 text-white font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-[#8A94A6] mb-1">HT Goals Against</label>
                      <input
                        type="number"
                        min={0}
                        value={htScoreAgainst}
                        onChange={(e) => setHtScoreAgainst(e.target.value)}
                        className="w-24 bg-[#0C0F14] border border-white/[0.12] rounded px-2.5 py-1.5 text-white font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-[#8A94A6] mb-1">FT Goals For</label>
                      <input
                        type="number"
                        min={0}
                        value={scoreFor}
                        onChange={(e) => setScoreFor(e.target.value)}
                        className="w-24 bg-[#0C0F14] border border-white/[0.12] rounded px-2.5 py-1.5 text-white font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-[#8A94A6] mb-1">FT Goals Against</label>
                      <input
                        type="number"
                        min={0}
                        value={scoreAgainst}
                        onChange={(e) => setScoreAgainst(e.target.value)}
                        className="w-24 bg-[#0C0F14] border border-white/[0.12] rounded px-2.5 py-1.5 text-white font-mono tabular-nums"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSaveResult(m.id)}
                        className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Save Result
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingResultMatchId(null)}
                        className="px-3 py-1.5 rounded border border-white/[0.12] text-[#C5CCD7]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Inline Tactical Feedback Form (Part 11) */}
                {isEditingFeedback && (
                  <div className="pt-4 border-t border-white/[0.08] space-y-3 text-[13px]">
                    <div className="text-[12px] text-[#9AA4B4]">
                      Did you implement the recommended half-time tactical changes? (Prevents the AI
                      from assuming tactics were applied.)
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {(Object.keys(FEEDBACK_LABELS) as FeedbackChoice[]).map((choiceKey) => (
                        <button
                          key={choiceKey}
                          type="button"
                          onClick={() => setFeedbackChoice(choiceKey)}
                          className={`text-left px-3 py-2 rounded-md border text-[12px] transition-colors ${
                            feedbackChoice === choiceKey
                              ? 'border-emerald-500 bg-emerald-600/15 text-white'
                              : 'border-white/[0.1] bg-[#0C0F14] text-[#9AA4B4] hover:text-white'
                          }`}
                        >
                          {FEEDBACK_LABELS[choiceKey]}
                        </button>
                      ))}
                    </div>
                    <textarea
                      rows={2}
                      value={feedbackNotes}
                      onChange={(e) => setFeedbackNotes(e.target.value)}
                      placeholder="Optional notes on what changed in the second half..."
                      className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSaveFeedback(m.id)}
                        className="px-3.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-medium"
                      >
                        Save Feedback
                      </button>
                      <button
                        type="button"
                        onClick={() => setFeedbackMatchId(null)}
                        className="px-3 py-1.5 rounded border border-white/[0.12] text-[12px] text-[#C5CCD7]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Explicit Delete Confirmation */}
                {isConfirmingDelete && (
                  <div className="pt-3 border-t border-red-500/30 flex flex-wrap items-center justify-between gap-3 text-[12px]">
                    <span className="text-red-300">
                      Permanently delete this match and any linked tactical configurations and
                      reports?
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-3 py-1 rounded border border-white/[0.12] text-[#C5CCD7]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteMatch(m.id)}
                        className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-medium"
                      >
                        Confirm Delete
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-8 text-[13px] text-[#9AA4B4]">
          No matches match the current filter. Schedule a match in Match Preparation to start
          building your Career Mode match ledger.
        </div>
      )}
    </div>
  );
}
