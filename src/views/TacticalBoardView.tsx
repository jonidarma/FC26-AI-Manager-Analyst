import { useMemo, useState } from 'react';
import { TacticalPitchSVG } from '../components/pitch/TacticalPitchSVG';
import { useApp } from '../context/AppContext';

export function TacticalBoardView() {
  const { activeClub, matches, selectedMatchId, setSelectedMatchId, players, tacticalCatalog } =
    useApp();

  const formations = useMemo(
    () => tacticalCatalog.filter((c) => c.category === 'formation').map((c) => c.name),
    [tacticalCatalog]
  );

  const selectedMatch = matches.find((m) => m.id === selectedMatchId) ?? matches[0] ?? null;

  const [viewMode, setViewMode] = useState<'compare' | 'current' | 'recommended'>('compare');
  const [currentFormation, setCurrentFormation] = useState<string>(
    selectedMatch?.startingFormation || activeClub?.profile.primaryFormation || '4-3-3 Holding'
  );
  const [recommendedFormation, setRecommendedFormation] = useState<string>(
    activeClub?.profile.alternativeFormation || '4-2-3-1 Wide'
  );
  const [currentLine, setCurrentLine] = useState<number>(
    selectedMatch?.tacticalConfiguration?.defensiveLineHeight ?? 58
  );
  const [recommendedLine, setRecommendedLine] = useState<number>(48);

  const [showAttackingChannels, setShowAttackingChannels] = useState(true);
  const [showDefensiveZones, setShowDefensiveZones] = useState(true);
  const [showPressingAreas, setShowPressingAreas] = useState(true);
  const [showMovementArrows, setShowMovementArrows] = useState(true);

  const assignments = selectedMatch?.tacticalConfiguration?.playerAssignments ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Tactical Board</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Compare current tactical structure against alternative or AI-recommended second-half
            shapes.
          </p>
        </div>

        {/* Comparison Mode Segmented Control */}
        <div className="flex items-center gap-1 p-1 bg-[#12151B] border border-white/[0.1] rounded-md">
          {(
            [
              ['compare', 'Side-by-Side Comparison'],
              ['current', 'Current Structure'],
              ['recommended', 'Recommended Structure'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setViewMode(id)}
              className={`px-3 py-1.5 rounded text-[12px] font-medium transition-colors whitespace-nowrap ${
                viewMode === id
                  ? 'bg-emerald-600 text-white'
                  : 'text-[#9AA4B4] hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Controls Bar */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Bound Match Context</label>
            <select
              value={selectedMatch?.id ?? ''}
              onChange={(e) => {
                setSelectedMatchId(e.target.value || null);
                const found = matches.find((m) => m.id === e.target.value);
                if (found) {
                  setCurrentFormation(found.startingFormation);
                  if (found.tacticalConfiguration) {
                    setCurrentLine(found.tacticalConfiguration.defensiveLineHeight);
                  }
                }
              }}
              className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
            >
              <option value="">Club Baseline (No Match Selected)</option>
              {matches.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.matchDate} · vs {m.opponentName} ({m.startingFormation})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
              Current Tactical Structure
            </label>
            <select
              value={currentFormation}
              onChange={(e) => setCurrentFormation(e.target.value)}
              className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
            >
              {formations.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
              AI Recommended / Target Structure
            </label>
            <select
              value={recommendedFormation}
              onChange={(e) => setRecommendedFormation(e.target.value)}
              className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
            >
              {formations.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
              Defensive Line Comparison ({currentLine} vs {recommendedLine})
            </label>
            <div className="flex items-center gap-2 pt-1.5">
              <input
                type="range"
                min={15}
                max={90}
                value={currentLine}
                onChange={(e) => setCurrentLine(Number(e.target.value))}
                aria-label="Current defensive line height"
                className="w-1/2 accent-emerald-500"
              />
              <input
                type="range"
                min={15}
                max={90}
                value={recommendedLine}
                onChange={(e) => setRecommendedLine(Number(e.target.value))}
                aria-label="Recommended defensive line height"
                className="w-1/2 accent-emerald-400"
              />
            </div>
          </div>
        </div>

        {/* Tactical Layer Toggles */}
        <div className="flex flex-wrap items-center gap-5 pt-3 border-t border-white/[0.08] text-[12px] text-[#C5CCD7]">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showAttackingChannels}
              onChange={(e) => setShowAttackingChannels(e.target.checked)}
              className="accent-emerald-500"
            />
            Attacking Channels
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showDefensiveZones}
              onChange={(e) => setShowDefensiveZones(e.target.checked)}
              className="accent-emerald-500"
            />
            Defensive Line & Zone
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showPressingAreas}
              onChange={(e) => setShowPressingAreas(e.target.checked)}
              className="accent-emerald-500"
            />
            Pressing Traps
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showMovementArrows}
              onChange={(e) => setShowMovementArrows(e.target.checked)}
              className="accent-emerald-500"
            />
            Movement Arrows
          </label>
        </div>
      </section>

      {/* Pitch Canvas */}
      <div
        className={`grid gap-6 ${
          viewMode === 'compare' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 max-w-2xl mx-auto'
        }`}
      >
        {(viewMode === 'compare' || viewMode === 'current') && (
          <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <TacticalPitchSVG
              formation={currentFormation}
              defensiveLineHeight={currentLine}
              assignments={assignments}
              players={players}
              showAttackingChannels={showAttackingChannels}
              showDefensiveZones={showDefensiveZones}
              showPressingAreas={showPressingAreas}
              showMovementArrows={showMovementArrows}
              label="Current Tactical Structure"
              variant="current"
            />
          </div>
        )}

        {(viewMode === 'compare' || viewMode === 'recommended') && (
          <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <TacticalPitchSVG
              formation={recommendedFormation}
              defensiveLineHeight={recommendedLine}
              assignments={assignments}
              players={players}
              showAttackingChannels={showAttackingChannels}
              showDefensiveZones={showDefensiveZones}
              showPressingAreas={showPressingAreas}
              showMovementArrows={showMovementArrows}
              label="AI Recommended / Comparison Structure"
              variant="recommended"
            />
          </div>
        )}
      </div>
    </div>
  );
}
