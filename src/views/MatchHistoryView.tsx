import { Check, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { desktopBridge } from '../services/desktopBridge';
import type { FeedbackChoice, MatchRecord } from '../types/domain';

const FEEDBACK_LABELS: Record<FeedbackChoice, string> = {
  applied_all: 'Applied all recommendations',
  applied_some: 'Applied some recommendations',
  not_applied: 'Did not apply recommendations',
  custom_changes: 'Made my own tactical changes',
};

export function MatchHistoryView() {
  const {
    matches,
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

  const feedbackByMatch = useMemo(
    () => new Map(feedbackRecords.map((f) => [f.matchId, f])),
    [feedbackRecords]
  );

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Match History</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Log final results manually when second-half capture is skipped, record recommendation
            adoption, and review past fixtures.
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
            const isEditingResult = editingResultMatchId === m.id;
            const isEditingFeedback = feedbackMatchId === m.id;
            const isConfirmingDelete = confirmDeleteId === m.id;

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
                      Status: <span className="capitalize text-white">{m.status.replace(/_/g, ' ')}</span>
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
                      {fb && (
                        <>
                          <span className="mx-2 text-[#4B5362]">·</span>
                          <span className="text-emerald-400">{FEEDBACK_LABELS[fb.choice]}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
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
