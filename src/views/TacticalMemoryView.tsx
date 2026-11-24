import { Plus, Trash2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { SortableTh } from '../components/common/SortableTh';
import { useApp } from '../context/AppContext';
import { useTableSort } from '../hooks/useTableSort';
import { desktopBridge } from '../services/desktopBridge';
import type { ConfidenceLevel, DashboardSummary, TacticalMemoryEntry } from '../types/domain';

type FormationLedgerSortKey = 'formation' | 'matches' | 'record';
type FormationBreakdownRow = DashboardSummary['formationBreakdown'][number];

const CATEGORY_LABELS: Record<TacticalMemoryEntry['category'], string> = {
  recurring_weakness: 'Recurring Weakness',
  successful_pattern: 'Successful Tactical Pattern',
  formation_insight: 'Formation Insight',
  opponent_tendency: 'Opponent Tendency',
};

export function TacticalMemoryView() {
  const { activeClub, tacticalMemory, dashboard, feedbackRecords, refreshAll, notify } = useApp();
  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState<TacticalMemoryEntry['category']>('recurring_weakness');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [confidence, setConfidence] = useState<ConfidenceLevel>('Medium');

  const adoptionStats = useMemo(() => {
    const counts = {
      applied_all: 0,
      applied_some: 0,
      not_applied: 0,
      custom_changes: 0,
    };
    for (const f of feedbackRecords) {
      counts[f.choice] += 1;
    }
    return counts;
  }, [feedbackRecords]);

  const formations = dashboard?.formationBreakdown ?? [];
  const formationAccessors = useMemo<
    Record<FormationLedgerSortKey, (f: FormationBreakdownRow) => string | number | null>
  >(
    () => ({
      formation: (f) => f.formation,
      matches: (f) => f.matches,
      record: (f) => f.wins * 10000 + f.draws * 100 - f.losses,
    }),
    []
  );
  const {
    sortedRows: sortedFormations,
    sortKey: formationSortKey,
    sortDir: formationSortDir,
    toggleSort: toggleFormationSort,
  } = useTableSort(formations, formationAccessors, { key: 'matches', dir: 'desc' });

  if (!activeClub) {
    return (
      <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-8 text-[14px] text-[#9AA4B4]">
        Select or create a Career Mode club to inspect its long-term Tactical Memory profile.
      </div>
    );
  }

  async function handleAddMemory(e: React.FormEvent) {
    e.preventDefault();
    if (!activeClub || !title.trim() || !detail.trim()) {
      notify('error', 'Title and observation detail are required.');
      return;
    }

    try {
      await desktopBridge.createTacticalMemory({
        clubId: activeClub.id,
        category,
        title,
        detail,
        confidence,
      });
      setTitle('');
      setDetail('');
      setShowForm(false);
      await refreshAll();
      notify('success', 'Entry saved to club Tactical Memory.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save memory entry');
    }
  }

  async function handleDelete(id: string) {
    try {
      await desktopBridge.deleteTacticalMemory(id);
      await refreshAll();
      notify('info', 'Removed tactical memory entry.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to remove entry');
    }
  }


  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">
            Tactical Memory — {activeClub.name}
          </h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Evidence-based Career Mode learning across matches. Correlation is tracked transparently
            without assuming causality.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowForm((prev) => !prev)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
        >
          <Plus className="w-4 h-4" />
          {showForm ? 'Close Form' : 'Log Tactical Observation'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={(e) => void handleAddMemory(e)}
          className="border border-white/[0.1] bg-[#12151B] rounded-lg p-6 space-y-4"
        >
          <h2 className="text-[16px] font-semibold text-white">Add Club Tactical Memory Entry</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as TacticalMemoryEntry['category'])}
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              >
                {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Observation Title *</label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Build-up turnovers under aggressive high press"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Confidence Level</label>
              <select
                value={confidence}
                onChange={(e) => setConfidence(e.target.value as ConfidenceLevel)}
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              >
                <option value="High">High (Clearly observable)</option>
                <option value="Medium">Medium (Reasonably supported)</option>
                <option value="Low">Low (Uncertain interpretation)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
              Evidence & Tactical Context *
            </label>
            <textarea
              rows={3}
              required
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Document the recurring pitch behavior and tactical context observed across matches."
              className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
            />
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 rounded-md border border-white/[0.12] text-[13px] text-[#C5CCD7]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
            >
              Save to Memory
            </button>
          </div>
        </form>
      )}

      {/* Managerial Identity Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
          <h2 className="text-[16px] font-semibold text-white">Formation Performance Ledger</h2>
          {formations.length > 0 ? (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-white/[0.08] text-[12px] text-[#7D8798]">
                  <SortableTh
                    label="Formation"
                    columnKey="formation"
                    activeKey={formationSortKey}
                    direction={formationSortDir}
                    onSort={toggleFormationSort}
                    className="py-2 font-medium"
                  />
                  <SortableTh
                    label="Matches"
                    columnKey="matches"
                    activeKey={formationSortKey}
                    direction={formationSortDir}
                    onSort={toggleFormationSort}
                    defaultDir="desc"
                    align="right"
                    className="py-2 font-medium"
                  />
                  <SortableTh
                    label="W–D–L"
                    columnKey="record"
                    activeKey={formationSortKey}
                    direction={formationSortDir}
                    onSort={toggleFormationSort}
                    defaultDir="desc"
                    align="right"
                    className="py-2 font-medium"
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {sortedFormations.map((f) => (
                  <tr key={f.formation}>
                    <td className="py-2.5 text-white font-medium">{f.formation}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-[#C5CCD7]">
                      {f.matches}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-white">
                      {f.wins}–{f.draws}–{f.losses}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-4 text-[13px] text-[#8A94A6]">
              No formation performance history yet. Recorded matches will automatically aggregate
              here.
            </div>
          )}
        </section>

        <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
          <h2 className="text-[16px] font-semibold text-white">Recommendation Feedback Tracking</h2>
          <p className="text-[12px] text-[#8A94A6]">
            Tracks whether half-time advice was actually implemented in FC26.
          </p>
          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3">
              <div className="text-[12px] text-[#8A94A6]">Applied All</div>
              <div className="mt-1 text-[20px] font-mono tabular-nums text-white">
                {adoptionStats.applied_all}
              </div>
            </div>
            <div className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3">
              <div className="text-[12px] text-[#8A94A6]">Applied Some</div>
              <div className="mt-1 text-[20px] font-mono tabular-nums text-white">
                {adoptionStats.applied_some}
              </div>
            </div>
            <div className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3">
              <div className="text-[12px] text-[#8A94A6]">Not Applied</div>
              <div className="mt-1 text-[20px] font-mono tabular-nums text-white">
                {adoptionStats.not_applied}
              </div>
            </div>
            <div className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3">
              <div className="text-[12px] text-[#8A94A6]">Custom Adjustments</div>
              <div className="mt-1 text-[20px] font-mono tabular-nums text-white">
                {adoptionStats.custom_changes}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Memory Entries List */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
        <h2 className="text-[16px] font-semibold text-white mb-4">Persistent Pattern Memory</h2>
        {tacticalMemory.length > 0 ? (
          <div className="divide-y divide-white/[0.06]">
            {tacticalMemory.map((entry) => (
              <div key={entry.id} className="py-3.5 flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-[12px] text-[#8A94A6]">
                    {CATEGORY_LABELS[entry.category]} · Confidence: {entry.confidence} ·{' '}
                    <span className="font-mono tabular-nums">{entry.evidenceCount} obs</span>
                  </div>
                  <div className="text-[14px] font-medium text-white">{entry.title}</div>
                  <p className="text-[13px] text-[#A8B2C2] leading-relaxed">{entry.detail}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(entry.id)}
                  aria-label={`Delete memory ${entry.title}`}
                  className="p-1.5 rounded hover:bg-red-500/10 text-[#9AA4B4] hover:text-red-400 shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-6 text-[13px] text-[#8A94A6]">
            No tactical patterns stored yet for {activeClub.name}. Entries are added manually or
            automatically as matches are analyzed.
          </div>
        )}
      </section>
    </div>
  );
}
