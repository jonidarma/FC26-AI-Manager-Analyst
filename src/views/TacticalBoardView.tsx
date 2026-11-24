import { Move, RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { TacticalPitchSVG } from '../components/pitch/TacticalPitchSVG';
import { useApp } from '../context/AppContext';
import { desktopBridge } from '../services/desktopBridge';
import type { CatalogFormation, CatalogFormationSlot, CatalogRole } from '../types/domain';
import {
  getDisplayPositionLabel,
  getSlotSideHint,
  toCanonicalFc26Position,
} from '../utils/formationPositions';

export function TacticalBoardView() {
  const {
    activeClub,
    matches,
    selectedMatchId,
    setSelectedMatchId,
    players,
    tacticalCatalog,
    notify,
  } = useApp();

  const [catalogFormations, setCatalogFormations] = useState<CatalogFormation[]>([]);
  const [catalogRoles, setCatalogRoles] = useState<CatalogRole[]>([]);

  useEffect(() => {
    let active = true;
    Promise.all([desktopBridge.listCatalogFormations(), desktopBridge.listCatalogRoles()])
      .then(([fList, rList]) => {
        if (!active) return;
        setCatalogFormations(fList);
        setCatalogRoles(rList);
      })
      .catch(() => {
        // Fallback to operational tacticalCatalog
      });
    return () => {
      active = false;
    };
  }, []);

  const formations = useMemo(() => {
    if (catalogFormations.length > 0) {
      return catalogFormations.map((f) => f.name);
    }
    return tacticalCatalog.filter((c) => c.category === 'formation').map((c) => c.name);
  }, [catalogFormations, tacticalCatalog]);

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

  // Manual slot coordinate editing & slot Role/Focus inspector
  const [selectedSlotOrder, setSelectedSlotOrder] = useState<number | null>(null);
  const [editCoordsMode, setEditCoordsMode] = useState(false);
  const [draftSlots, setDraftSlots] = useState<CatalogFormationSlot[] | null>(null);
  const [savingLayout, setSavingLayout] = useState(false);

  const currentCatalogFormation = useMemo(
    () => catalogFormations.find((f) => f.name === currentFormation) ?? null,
    [catalogFormations, currentFormation]
  );

  const recommendedCatalogFormation = useMemo(
    () => catalogFormations.find((f) => f.name === recommendedFormation) ?? null,
    [catalogFormations, recommendedFormation]
  );

  // Reset draft coordinates when current formation switches
  useEffect(() => {
    setDraftSlots(null);
    setEditCoordsMode(false);
    setSelectedSlotOrder(null);
  }, [currentFormation]);

  const activeCurrentSlots = draftSlots ?? currentCatalogFormation?.slots;

  const selectedSlot = useMemo(() => {
    if (selectedSlotOrder === null || !activeCurrentSlots) return null;
    return activeCurrentSlots.find((s) => s.slotOrder === selectedSlotOrder) ?? null;
  }, [selectedSlotOrder, activeCurrentSlots]);

  const eligibleRolesForSelectedSlot = useMemo(() => {
    if (!selectedSlot) return [];
    const canonical =
      toCanonicalFc26Position(selectedSlot.positionCode) ??
      selectedSlot.positionCode.toUpperCase();
    return catalogRoles.filter((r) => r.eligiblePositions.includes(canonical));
  }, [selectedSlot, catalogRoles]);

  const assignments = selectedMatch?.tacticalConfiguration?.playerAssignments ?? [];

  function startCoordinateEdit() {
    if (!currentCatalogFormation || currentCatalogFormation.slots.length !== 11) {
      notify('error', 'Formation catalog slots must be loaded before adjusting coordinates.');
      return;
    }
    setDraftSlots(currentCatalogFormation.slots.map((s) => ({ ...s })));
    setEditCoordsMode(true);
    setSelectedSlotOrder((prev) => prev ?? currentCatalogFormation.slots[0].slotOrder);
  }

  function updateDraftSlotCoord(slotOrder: number, axis: 'x' | 'y', value: number) {
    const clamped =
      axis === 'x' ? Math.max(5, Math.min(95, value)) : Math.max(8, Math.min(94, value));
    setDraftSlots((prev) =>
      prev
        ? prev.map((s) => (s.slotOrder === slotOrder ? { ...s, [axis]: clamped } : s))
        : null
    );
  }

  async function handleSaveSlotCoordinates() {
    if (!currentCatalogFormation || !draftSlots) return;
    setSavingLayout(true);
    try {
      const updated = await desktopBridge.updateFormationSlotCoordinates(
        currentCatalogFormation.id,
        draftSlots.map((s) => ({ slotOrder: s.slotOrder, x: s.x, y: s.y }))
      );
      setCatalogFormations((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
      setDraftSlots(null);
      setEditCoordsMode(false);
      notify('success', `Saved adjusted coordinates for ${updated.name} (marked User Adjusted).`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save formation coordinates');
    } finally {
      setSavingLayout(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Tactical Board</h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Compare verified FC26 formations, inspect position-specific FC IQ role compatibility,
            and adjust formation coordinates cleanly.
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
              {!formations.includes(currentFormation) && (
                <option value={currentFormation}>{currentFormation}</option>
              )}
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
              {!formations.includes(recommendedFormation) && (
                <option value={recommendedFormation}>{recommendedFormation}</option>
              )}
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

        {/* Tactical Layer Toggles & Coordinate Editor Action */}
        <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-white/[0.08]">
          <div className="flex flex-wrap items-center gap-5 text-[12px] text-[#C5CCD7]">
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
              Defensive Line &amp; Zone
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

          {currentCatalogFormation && viewMode !== 'recommended' && (
            <div className="flex items-center gap-2">
              {!editCoordsMode ? (
                <button
                  type="button"
                  onClick={startCoordinateEdit}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/[0.14] hover:border-emerald-500/60 text-[12px] text-white transition-colors"
                >
                  <Move className="w-3.5 h-3.5" />
                  Edit {currentFormation} Slot Coordinates
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setDraftSlots(null);
                      setEditCoordsMode(false);
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-white/[0.12] text-[12px] text-[#C5CCD7] hover:text-white"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Discard Draft
                  </button>
                  <button
                    type="button"
                    disabled={savingLayout}
                    onClick={() => void handleSaveSlotCoordinates()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-[12px] text-white font-medium"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {savingLayout ? 'Saving...' : 'Save Adjusted Layout'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Manual Slot Coordinate Editor Bar */}
        {editCoordsMode && draftSlots && (
          <div className="rounded-md border border-amber-500/30 bg-[#0C0F14] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[12px] text-amber-300 font-medium">
                Manual Formation Coordinate Editor · Click any node on the Current Structure pitch
                to adjust its X/Y coordinates.
              </div>
              <div className="text-[11px] text-[#8A94A6]">
                Saving persists to SQLite and marks this formation as User Adjusted Layout.
              </div>
            </div>

            {selectedSlot ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                <div className="text-[13px] text-white font-mono">
                  Slot #{selectedSlot.slotOrder} ·{' '}
                  {getDisplayPositionLabel(selectedSlot.positionCode)}
                  {getSlotSideHint(selectedSlot.slotId, selectedSlot.positionCode)
                    ? ` (${getSlotSideHint(selectedSlot.slotId, selectedSlot.positionCode)})`
                    : ''}{' '}
                  · {selectedSlot.tacticalLine}
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-[#9AA4B4] mb-1">
                    <span>Horizontal Position (X)</span>
                    <span className="font-mono text-white">{selectedSlot.x}</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={95}
                    value={selectedSlot.x}
                    onChange={(e) =>
                      updateDraftSlotCoord(selectedSlot.slotOrder, 'x', Number(e.target.value))
                    }
                    className="w-full accent-amber-400"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-[#9AA4B4] mb-1">
                    <span>Vertical Depth (Y · Top=Attack, Bottom=GK)</span>
                    <span className="font-mono text-white">{selectedSlot.y}</span>
                  </div>
                  <input
                    type="range"
                    min={8}
                    max={94}
                    value={selectedSlot.y}
                    onChange={(e) =>
                      updateDraftSlotCoord(selectedSlot.slotOrder, 'y', Number(e.target.value))
                    }
                    className="w-full accent-amber-400"
                  />
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-[#9AA4B4]">
                Click a player node on the pitch below to select a slot.
              </div>
            )}
          </div>
        )}
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
              formationSlots={activeCurrentSlots}
              layoutVerified={currentCatalogFormation?.layoutVerified ?? true}
              isUserAdjusted={Boolean(draftSlots) || Boolean(currentCatalogFormation?.isUserAdjusted)}
              defensiveLineHeight={currentLine}
              assignments={assignments}
              players={players}
              showAttackingChannels={showAttackingChannels}
              showDefensiveZones={showDefensiveZones}
              showPressingAreas={showPressingAreas}
              showMovementArrows={showMovementArrows}
              label="Current Tactical Structure"
              variant="current"
              selectedSlotOrder={selectedSlotOrder}
              onSelectSlot={(slotOrder) => setSelectedSlotOrder(slotOrder)}
            />
            <div className="mt-2 text-[11px] text-[#7D8798]">
              Click any node to inspect verified FC 26 compatible Roles &amp; Focuses for that
              position.
            </div>
          </div>
        )}

        {(viewMode === 'compare' || viewMode === 'recommended') && (
          <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <TacticalPitchSVG
              formation={recommendedFormation}
              formationSlots={recommendedCatalogFormation?.slots}
              layoutVerified={recommendedCatalogFormation?.layoutVerified ?? true}
              isUserAdjusted={recommendedCatalogFormation?.isUserAdjusted ?? false}
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
            {recommendedCatalogFormation && (
              <div className="mt-2 text-[11px] text-[#7D8798]">
                {recommendedCatalogFormation.category} · {recommendedCatalogFormation.defensiveShape}
                {' / '}
                {recommendedCatalogFormation.attackingShape}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Selected Slot FC IQ Role & Focus Compatibility Inspector */}
      {selectedSlot && (
        <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3">
            <div>
              <h2 className="text-[15px] font-semibold text-white">
                Verified FC 26 Role &amp; Focus Compatibility —{' '}
                {getDisplayPositionLabel(selectedSlot.positionCode)}
                {getSlotSideHint(selectedSlot.slotId, selectedSlot.positionCode)
                  ? ` (${getSlotSideHint(selectedSlot.slotId, selectedSlot.positionCode)})`
                  : ''}
              </h2>
              <p className="text-[12px] text-[#8A94A6]">
                Slot #{selectedSlot.slotOrder} in {currentFormation} · Tactical Line:{' '}
                {selectedSlot.tacticalLine} · Coordinates ({selectedSlot.x}, {selectedSlot.y})
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedSlotOrder(null)}
              className="text-[12px] text-[#8A94A6] hover:text-white"
            >
              Close Inspector
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {eligibleRolesForSelectedSlot.map((role) => {
              const canonical =
                toCanonicalFc26Position(selectedSlot.positionCode) ??
                selectedSlot.positionCode.toUpperCase();
              const focuses = role.compatibleFocusesByPosition[canonical] ?? [];
              return (
                <div
                  key={role.id}
                  className="rounded-md border border-white/[0.08] bg-[#0C0F14] p-3.5 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-white">{role.name}</span>
                    {role.isFc26New && (
                      <span className="text-[11px] font-mono text-emerald-400">FC 26 New</span>
                    )}
                  </div>
                  <p className="text-[12px] text-[#8A94A6] leading-relaxed">{role.description}</p>
                  <div className="pt-1.5 border-t border-white/[0.06] text-[11px] text-[#C5CCD7]">
                    <span className="text-[#7D8798]">Focuses at {canonical}: </span>
                    <span className="font-mono">{focuses.join(' · ') || 'None'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
