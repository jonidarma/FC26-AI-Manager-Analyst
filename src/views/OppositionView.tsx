import { Pencil, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { desktopBridge } from '../services/desktopBridge';
import type { Opponent } from '../types/domain';

const EMPTY_OPP = {
  name: '',
  league: '',
  typicalFormation: 'Unknown',
  strengths: '',
  weaknesses: '',
  dangerousChannels: '',
  notes: '',
};

export function OppositionView() {
  const { opponents, matches, refreshAll, notify } = useApp();
  const [form, setForm] = useState(EMPTY_OPP);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function startEdit(opp: Opponent) {
    setEditingId(opp.id);
    setForm({
      name: opp.name,
      league: opp.league,
      typicalFormation: opp.typicalFormation,
      strengths: opp.strengths,
      weaknesses: opp.weaknesses,
      dangerousChannels: opp.dangerousChannels,
      notes: opp.notes,
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      notify('error', 'Opponent name is required.');
      return;
    }
    try {
      if (editingId) {
        await desktopBridge.updateOpponent(editingId, form);
        notify('success', `Updated scouting dossier for ${form.name}.`);
      } else {
        await desktopBridge.createOpponent(form);
        notify('success', `Saved opposition dossier for ${form.name}.`);
      }
      setForm(EMPTY_OPP);
      setEditingId(null);
      setShowForm(false);
      await refreshAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save opponent');
    }
  }

  async function handleDelete(opp: Opponent) {
    try {
      await desktopBridge.deleteOpponent(opp.id);
      await refreshAll();
      notify('info', `Deleted opponent ${opp.name}.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Cannot delete opponent');
    }
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Opposition Analysis</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Maintain opposition tactical dossiers across Career Mode seasons to inform pre-match and
            half-time scouting.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setEditingId(null);
            setForm(EMPTY_OPP);
            setShowForm((prev) => !prev);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
        >
          <Plus className="w-4 h-4" />
          {showForm ? 'Close Form' : 'Add Opponent Dossier'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="border border-white/[0.1] bg-[#12151B] rounded-lg p-6 space-y-4"
        >
          <h2 className="text-[16px] font-semibold text-white">
            {editingId ? 'Edit Opposition Dossier' : 'New Opposition Dossier'}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Opponent Club *</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Club name"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">League</label>
              <input
                type="text"
                value={form.league}
                onChange={(e) => setForm({ ...form, league: e.target.value })}
                placeholder="Competition or league"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Observed Formation</label>
              <input
                type="text"
                value={form.typicalFormation}
                onChange={(e) => setForm({ ...form, typicalFormation: e.target.value })}
                placeholder="e.g. 4-2-3-1 or Unknown"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Observed Strengths</label>
              <textarea
                rows={2}
                value={form.strengths}
                onChange={(e) => setForm({ ...form, strengths: e.target.value })}
                placeholder="e.g. Aggressive front press, fast wide transitions"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Observed Weaknesses</label>
              <textarea
                rows={2}
                value={form.weaknesses}
                onChange={(e) => setForm({ ...form, weaknesses: e.target.value })}
                placeholder="e.g. Space left behind advancing right-back"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Dangerous Attacking Channels
              </label>
              <textarea
                rows={2}
                value={form.dangerousChannels}
                onChange={(e) => setForm({ ...form, dangerousChannels: e.target.value })}
                placeholder="e.g. Left half-space cutbacks"
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Scouting Notes</label>
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Recurring tactical patterns from previous Career Mode encounters"
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
              Save Dossier
            </button>
          </div>
        </form>
      )}

      {opponents.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {opponents.map((opp) => {
            const encounters = matches.filter((m) => m.opponentId === opp.id);
            return (
              <article
                key={opp.id}
                className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[16px] font-semibold text-white">{opp.name}</h2>
                    <div className="text-[12px] text-[#8A94A6] mt-0.5">
                      {opp.league || 'League Unspecified'} · Formation: {opp.typicalFormation} ·{' '}
                      <span className="font-mono tabular-nums">
                        {encounters.length} match{encounters.length === 1 ? '' : 'es'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(opp)}
                      aria-label={`Edit ${opp.name}`}
                      className="p-1.5 rounded hover:bg-white/[0.06] text-[#9AA4B4] hover:text-white"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(opp)}
                      aria-label={`Delete ${opp.name}`}
                      className="p-1.5 rounded hover:bg-red-500/10 text-[#9AA4B4] hover:text-red-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-white/[0.06] text-[12px]">
                  <div>
                    <div className="text-[#7D8798]">Strengths</div>
                    <p className="mt-0.5 text-[#C5CCD7] leading-relaxed">
                      {opp.strengths || 'No strengths logged yet.'}
                    </p>
                  </div>
                  <div>
                    <div className="text-[#7D8798]">Weaknesses</div>
                    <p className="mt-0.5 text-[#C5CCD7] leading-relaxed">
                      {opp.weaknesses || 'No weaknesses logged yet.'}
                    </p>
                  </div>
                </div>

                {opp.dangerousChannels && (
                  <div className="text-[12px]">
                    <span className="text-[#7D8798]">Dangerous Channels: </span>
                    <span className="text-[#D7DDE7]">{opp.dangerousChannels}</span>
                  </div>
                )}

                {opp.notes && (
                  <p className="text-[12px] text-[#8A94A6] pt-2 border-t border-white/[0.06]">
                    {opp.notes}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-8 text-[13px] text-[#9AA4B4]">
          No opposition dossiers saved yet. Opponents are added automatically when you schedule a
          match or manually via the button above.
        </div>
      )}
    </div>
  );
}
