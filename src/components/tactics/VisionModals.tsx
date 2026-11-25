import { Check, GitCompare, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import type {
  TacticalVisionKey,
  TacticalVisionRecord,
  ThreeLayerTacticalEvaluation,
  VisionOptimizationMode,
  VisionOptimizationProposalItem,
  VisionOptimizationResult,
} from '../../types/domain';

interface CompareVisionsModalProps {
  visions: TacticalVisionRecord[];
  initialVisionA: TacticalVisionKey;
  initialVisionB: TacticalVisionKey;
  onCompare: (
    visionA: TacticalVisionKey,
    visionB: TacticalVisionKey
  ) => Promise<{
    visionA: ThreeLayerTacticalEvaluation;
    visionB: ThreeLayerTacticalEvaluation;
    roleAffinityDelta: number;
    summary: string;
  }>;
  onClose: () => void;
}

export function CompareVisionsModal({
  visions,
  initialVisionA,
  initialVisionB,
  onCompare,
  onClose,
}: CompareVisionsModalProps) {
  const [visionA, setVisionA] = useState<TacticalVisionKey>(initialVisionA);
  const [visionB, setVisionB] = useState<TacticalVisionKey>(initialVisionB);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    visionA: ThreeLayerTacticalEvaluation;
    visionB: ThreeLayerTacticalEvaluation;
    roleAffinityDelta: number;
    summary: string;
  } | null>(null);

  async function runCompare() {
    setLoading(true);
    setError(null);
    try {
      const res = await onCompare(visionA, visionB);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compare tactical visions');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[88vh] overflow-y-auto border border-white/[0.12] bg-[#12151B] rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div className="flex items-center gap-2">
            <GitCompare className="w-4 h-4 text-emerald-400" />
            <h2 className="text-[16px] font-semibold text-white">Compare Tactical Visions</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-white/[0.08] text-[#9AA4B4] hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[12px] text-[#9AA4B4]">
          Compare how your current formation, build-up, defensive approach, and 11 player roles
          evaluate under two EA SPORTS FC 26 Tactical Visions without modifying your setup.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div>
            <label className="block text-[11px] text-[#8A94A6] mb-1">Vision A</label>
            <select
              value={visionA}
              onChange={(e) => setVisionA(e.target.value as TacticalVisionKey)}
              className="w-full bg-[#0C0F14] border border-white/[0.12] rounded px-2.5 py-1.5 text-[12px] text-white"
            >
              {visions.map((v) => (
                <option key={v.internalKey} value={v.internalKey}>
                  {v.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-[#8A94A6] mb-1">Vision B</label>
            <select
              value={visionB}
              onChange={(e) => setVisionB(e.target.value as TacticalVisionKey)}
              className="w-full bg-[#0C0F14] border border-white/[0.12] rounded px-2.5 py-1.5 text-[12px] text-white"
            >
              {visions.map((v) => (
                <option key={v.internalKey} value={v.internalKey}>
                  {v.displayName}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void runCompare()}
            className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[12px] font-medium"
          >
            {loading ? 'Comparing...' : 'Run Comparison'}
          </button>
        </div>

        {error && (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-[12px] text-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-3 text-[12px] text-emerald-100">
              {result.summary}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[result.visionA, result.visionB].map((ev, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-white/[0.08] bg-[#0C0F14] p-4 space-y-2.5 text-[12px]"
                >
                  <div className="font-semibold text-white text-[14px]">
                    {ev.tacticalVisionName}
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#8A94A6]">Layer 2 Official Compliance:</span>
                    <span
                      className={
                        ev.layer2OfficialRequirements.verifiedVisionCompliant
                          ? 'text-emerald-400 font-medium'
                          : 'text-amber-300 font-medium'
                      }
                    >
                      {ev.layer2OfficialRequirements.verifiedVisionCompliant
                        ? 'Compliant'
                        : `${ev.layer2OfficialRequirements.conflicts.length} Conflict(s)`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#8A94A6]">Layer 3 Role Affinity:</span>
                    <span className="font-mono text-white">
                      {ev.layer3RoleAffinity.matchedCount} of{' '}
                      {ev.layer3RoleAffinity.assignedRoleCount} (
                      {ev.layer3RoleAffinity.unknownCount} unknown)
                    </span>
                  </div>
                  {ev.layer2OfficialRequirements.conflicts.length > 0 && (
                    <ul className="space-y-1 pt-1 border-t border-white/[0.06] text-[11px] text-amber-200">
                      {ev.layer2OfficialRequirements.conflicts.map((c, ci) => (
                        <li key={ci}>• {c.explanation}</li>
                      ))}
                    </ul>
                  )}
                  <div className="text-[11px] text-[#8A94A6] pt-1 border-t border-white/[0.06]">
                    {ev.layer3RoleAffinity.coachPotentialSummary.note}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface OptimizeVisionModalProps {
  visions: TacticalVisionRecord[];
  initialTargetVision: TacticalVisionKey;
  onOptimize: (
    targetVisionKey: TacticalVisionKey,
    mode: VisionOptimizationMode
  ) => Promise<VisionOptimizationResult>;
  onApplySelectedChanges: (
    result: VisionOptimizationResult,
    selectedChangeIndices: number[]
  ) => void;
  onClose: () => void;
}

const OPTIMIZATION_MODES: Array<{
  mode: VisionOptimizationMode;
  label: string;
  description: string;
}> = [
  {
    mode: 'minimal_adjustment',
    label: 'Minimal Adjustment',
    description: 'Only resolves Layer 2 official Build-Up/Defensive requirements. Preserves players & roles.',
  },
  {
    mode: 'role_optimization',
    label: 'Role Optimization',
    description: 'Aligns Layer 2 requirements + suggests vision-associated FC IQ roles for your current XI.',
  },
  {
    mode: 'squad_optimization',
    label: 'Squad Optimization',
    description: 'Suggests eligible club squad replacements suited to the formation + vision roles.',
  },
  {
    mode: 'full_tactical_optimization',
    label: 'Full Tactical Optimization',
    description: 'Combines Layer 2 compliance, role affinity alignment, and eligible squad fit suggestions.',
  },
];

export function OptimizeVisionModal({
  visions,
  initialTargetVision,
  onOptimize,
  onApplySelectedChanges,
  onClose,
}: OptimizeVisionModalProps) {
  const [targetVision, setTargetVision] = useState<TacticalVisionKey>(initialTargetVision);
  const [mode, setMode] = useState<VisionOptimizationMode>('minimal_adjustment');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VisionOptimizationResult | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);

  async function runOptimization() {
    setLoading(true);
    setError(null);
    try {
      const res = await onOptimize(targetVision, mode);
      setResult(res);
      setSelectedIndices(res.proposals.map((_, idx) => idx));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compute optimization preview');
    } finally {
      setLoading(false);
    }
  }

  function toggleIndex(idx: number) {
    setSelectedIndices((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  }

  function describeProposal(c: VisionOptimizationProposalItem): string {
    if (c.category === 'build_up_style') return 'Build-Up Style (Layer 2)';
    if (c.category === 'defensive_approach') return 'Defensive Approach (Layer 2)';
    if (c.category === 'defensive_line_height') return 'Defensive Line Height';
    if (c.category === 'formation') return 'Formation Structure';
    if (c.category === 'role_focus') return `Slot ${(c.slotOrder ?? 0) + 1} (${c.positionCode ?? ''}) Role & Focus`;
    if (c.category === 'player_swap') return `Slot ${(c.slotOrder ?? 0) + 1} (${c.positionCode ?? ''}) Player Fit`;
    return c.category;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[88vh] overflow-y-auto border border-white/[0.12] bg-[#12151B] rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <h2 className="text-[16px] font-semibold text-white">
              Optimize Setup for Tactical Vision (Preview &amp; Selective Apply)
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-white/[0.08] text-[#9AA4B4] hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[12px] text-[#9AA4B4]">
          Generates a deterministic before/after preview without mutating your saved preset. Select
          only the specific changes you want to apply to your working draft.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-[#8A94A6] mb-1">Target Tactical Vision</label>
            <select
              value={targetVision}
              onChange={(e) => setTargetVision(e.target.value as TacticalVisionKey)}
              className="w-full bg-[#0C0F14] border border-white/[0.12] rounded px-3 py-2 text-[12px] text-white"
            >
              {visions.map((v) => (
                <option key={v.internalKey} value={v.internalKey}>
                  {v.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-[#8A94A6] mb-1">Optimization Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as VisionOptimizationMode)}
              className="w-full bg-[#0C0F14] border border-white/[0.12] rounded px-3 py-2 text-[12px] text-white"
            >
              {OPTIMIZATION_MODES.map((m) => (
                <option key={m.mode} value={m.mode}>
                  {m.label}
                </option>
              ))}
            </select>
            <div className="text-[11px] text-[#7D8798] mt-1">
              {OPTIMIZATION_MODES.find((m) => m.mode === mode)?.description}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            disabled={loading}
            onClick={() => void runOptimization()}
            className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[12px] font-medium"
          >
            {loading ? 'Computing Preview...' : 'Generate Preview Diff'}
          </button>
        </div>

        {error && (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-[12px] text-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-4 border-t border-white/[0.08] pt-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">
              <div className="rounded border border-white/[0.08] bg-[#0C0F14] p-3">
                <div className="text-[#8A94A6]">Before Optimization</div>
                <div className="font-mono text-white mt-1">
                  Layer 2:{' '}
                  {result.beforeEvaluation.layer2OfficialRequirements.verifiedVisionCompliant
                    ? 'Compliant'
                    : `${result.beforeEvaluation.layer2OfficialRequirements.conflicts.length} Conflict(s)`}
                </div>
                <div className="font-mono text-[#C5CCD7]">
                  Role Affinity: {result.beforeEvaluation.layer3RoleAffinity.matchedCount} /{' '}
                  {result.beforeEvaluation.layer3RoleAffinity.assignedRoleCount}
                </div>
              </div>
              <div className="rounded border border-emerald-500/35 bg-emerald-500/[0.05] p-3">
                <div className="text-emerald-300">After Full Preview</div>
                <div className="font-mono text-white mt-1">
                  Layer 2:{' '}
                  {result.afterPreview.evaluation.layer2OfficialRequirements.verifiedVisionCompliant
                    ? 'Compliant'
                    : `${result.afterPreview.evaluation.layer2OfficialRequirements.conflicts.length} Conflict(s)`}
                </div>
                <div className="font-mono text-emerald-200">
                  Role Affinity: {result.afterPreview.evaluation.layer3RoleAffinity.matchedCount} /{' '}
                  {result.afterPreview.evaluation.layer3RoleAffinity.assignedRoleCount}
                </div>
              </div>
            </div>

            {result.summaryNote && (
              <div className="rounded border border-white/[0.08] bg-[#0C0F14] p-3 text-[11px] text-[#C5CCD7]">
                {result.summaryNote}
              </div>
            )}

            {result.proposals.length === 0 ? (
              <div className="rounded border border-white/[0.08] bg-[#0C0F14] p-4 text-[12px] text-[#9AA4B4]">
                No changes required — your current setup already satisfies this mode for{' '}
                <strong className="text-white">{result.targetVisionName}</strong>.
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="font-medium text-white">
                    Proposed Changes ({selectedIndices.length}/{result.proposals.length} selected)
                  </span>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setSelectedIndices(result.proposals.map((_, i) => i))}
                      className="text-emerald-400 hover:underline"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedIndices([])}
                      className="text-[#8A94A6] hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5 max-h-60 overflow-y-auto">
                  {result.proposals.map((c, idx) => {
                    const checked = selectedIndices.includes(idx);
                    return (
                      <label
                        key={c.id || idx}
                        className={`flex items-start gap-2.5 p-2.5 rounded border cursor-pointer text-[12px] ${
                          checked
                            ? 'border-emerald-500/45 bg-emerald-500/[0.07]'
                            : 'border-white/[0.08] bg-[#0C0F14]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleIndex(idx)}
                          className="mt-0.5 accent-emerald-500"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-white">{describeProposal(c)}</div>
                          <div className="font-mono text-[11px] text-[#C5CCD7] mt-0.5">
                            <span className="text-[#8A94A6]">{c.currentValue || '—'}</span>
                            <span className="mx-1.5 text-emerald-400">→</span>
                            <span className="text-emerald-200">{c.proposedValue}</span>
                          </div>
                          <div className="text-[11px] text-[#8A94A6] mt-0.5">{c.explanation}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.08]">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-1.5 rounded border border-white/[0.12] text-[12px] text-[#C5CCD7]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={selectedIndices.length === 0}
                onClick={() => {
                  onApplySelectedChanges(result, selectedIndices);
                  onClose();
                }}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-45 text-white text-[12px] font-medium"
              >
                <Check className="w-3.5 h-3.5" />
                Apply {selectedIndices.length} Selected Change(s) to Draft
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
