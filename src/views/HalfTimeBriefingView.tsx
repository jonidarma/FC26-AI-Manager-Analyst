import { ClipboardCheck, Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TacticalPitchSVG } from '../components/pitch/TacticalPitchSVG';
import { useApp } from '../context/AppContext';
import { desktopBridge } from '../services/desktopBridge';
import type { HalftimeReportData } from '../types/domain';

export function HalfTimeBriefingView() {
  const { matches, selectedMatchId, setSelectedMatchId, players, setActiveSection } = useApp();
  const [report, setReport] = useState<HalftimeReportData | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  const selectedMatch = matches.find((m) => m.id === selectedMatchId) ?? matches[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!selectedMatch) {
        setReport(null);
        return;
      }
      setLoadingReport(true);
      try {
        const fetched = await desktopBridge.getHalftimeReport(selectedMatch.id);
        if (!cancelled) setReport(fetched);
      } catch {
        if (!cancelled) setReport(null);
      } finally {
        if (!cancelled) setLoadingReport(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedMatch?.id]);

  function handleExportJson() {
    if (!report || !selectedMatch) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `halftime-briefing-${selectedMatch.matchDate}-${selectedMatch.opponentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">
            Half-Time Tactical Briefing
          </h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Executive 11-section half-time tactical report generated strictly from verified
            first-half visual evidence.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {matches.length > 0 && (
            <select
              value={selectedMatch?.id ?? ''}
              onChange={(e) => setSelectedMatchId(e.target.value)}
              className="bg-[#12151B] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
            >
              {matches.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.matchDate} · {m.venue === 'home' ? 'vs' : '@'} {m.opponentName}
                  {m.hasHalftimeReport ? ' (Report Saved)' : ' (Awaiting Analysis)'}
                </option>
              ))}
            </select>
          )}
          {report && (
            <button
              type="button"
              onClick={handleExportJson}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[13px] text-white"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSON
            </button>
          )}
        </div>
      </div>

      {loadingReport ? (
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-8 text-[13px] text-[#9AA4B4]">
          Loading saved half-time report from SQLite...
        </div>
      ) : !report ? (
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-8 space-y-6">
          <div className="max-w-2xl">
            <div className="text-[12px] text-[#8A94A6]">
              {selectedMatch
                ? `${selectedMatch.matchDate} · ${selectedMatch.venue === 'home' ? 'vs' : '@'} ${selectedMatch.opponentName} · ${selectedMatch.startingFormation}`
                : 'No match selected'}
            </div>
            <h2 className="mt-1 text-[20px] font-semibold text-white">
              No Half-Time Briefing Generated for This Match
            </h2>
            <p className="mt-2 text-[14px] text-[#9AA4B4] leading-relaxed">
              Half-time reports are never fabricated from pre-match assumptions. Once a first-half
              recording is finalized in Phase 2/3 and submitted to the two-stage Gemini analysis
              pipeline, all 11 tactical briefing sections populate here and persist in SQLite.
            </p>
          </div>

          {/* 11-Section Briefing Architecture Overview */}
          <div className="border-t border-white/[0.08] pt-6">
            <div className="text-[13px] font-semibold text-white mb-4">
              Structured 11-Section Half-Time Report Schema
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 text-[12px]">
              {[
                ['01. Match Situation', 'Scoreline, formations, objective, tactical rating'],
                ['02. Manager’s Verdict', 'Concise Head Coach assessment anchored to match footage'],
                ['03. First-Half Performance', 'Attacking, Defending, and Transition phase breakdown'],
                ['04. What Is Working', '3–5 evidence-backed strengths to preserve'],
                ['05. What Is Not Working', 'Ranked problems with evidence, consequence, and fix'],
                ['06. Opponent Exploitation', 'Top 3 evidence-supported ways to expose opponent gaps'],
                ['07. Second-Half Game Plan', 'Plan A adjustment, Plan B pivot, Plan C score-state rules'],
                ['08. Player Instructions', 'Role/focus adjustments bound to verified squad profiles'],
                ['09. Substitutions', 'Tactical replacements without fabricated stamina/ratings'],
                ['10. Three Priority Actions', 'Exactly three mandatory non-negotiable adjustments'],
                ['11. Manager’s Final Instruction', 'Decisive strategic closing directive with honest uncertainty'],
              ].map(([title, desc]) => (
                <div
                  key={title}
                  className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3.5"
                >
                  <div className="font-medium text-white">{title}</div>
                  <div className="mt-1 text-[#8A94A6] leading-relaxed">{desc}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setActiveSection('match-capture')}
              className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
            >
              Go to Match Capture
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('tactical-board')}
              className="px-4 py-2 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[#D7DDE7] text-[13px] font-medium"
            >
              Inspect Tactical Board
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Executive Header — Section 1 & Section 2 */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] pb-5">
              <div>
                <div className="text-[12px] text-[#8A94A6]">
                  Section 1 · Match Situation · Model {report.modelUsed}
                </div>
                <div className="mt-1 text-[24px] font-bold text-white font-mono tabular-nums">
                  {report.section1MatchSituation.clubName}{' '}
                  <span className="text-emerald-400 px-2">
                    {report.section1MatchSituation.scoreLabel}
                  </span>{' '}
                  {report.section1MatchSituation.opponentName}
                </div>
                <div className="mt-1 text-[13px] text-[#9AA4B4]">
                  {report.section1MatchSituation.halftimeStatus} · Starting{' '}
                  {report.section1MatchSituation.startingFormation} vs Observed{' '}
                  {report.section1MatchSituation.observedOpponentFormation}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[12px] text-[#8A94A6]">Tactical Assessment</div>
                <div className="mt-0.5 text-[18px] font-semibold text-white">
                  {report.section1MatchSituation.tacticalRatingLabel}
                </div>
              </div>
            </div>

            <div>
              <div className="text-[12px] text-emerald-400 font-medium mb-1">
                Section 2 · Manager’s Verdict
              </div>
              <p className="text-[15px] text-[#E6EBF2] leading-relaxed">
                {report.section2ManagersVerdict}
              </p>
            </div>
          </section>

          {/* Section 10 Highlight: Three Priority Actions */}
          <section className="border border-emerald-500/25 bg-[#111917] rounded-lg p-6">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-emerald-300 mb-3">
              <ClipboardCheck className="w-4 h-4" />
              Section 10 · Three Mandatory Priority Actions
            </div>
            <ol className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[13px]">
              {report.section10PriorityActions.map((action, idx) => (
                <li
                  key={idx}
                  className="border border-white/[0.08] bg-[#0D1311] rounded-md p-4 text-white leading-relaxed"
                >
                  <span className="font-mono text-emerald-400 mr-2">0{idx + 1}.</span>
                  {action}
                </li>
              ))}
            </ol>
          </section>

          {/* Section 3: First-Half Performance */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6">
            <h2 className="text-[16px] font-semibold text-white mb-4">
              Section 3 · First-Half Performance
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-[13px]">
              <div>
                <div className="font-semibold text-white mb-1.5">Attacking</div>
                <p className="text-[#A8B2C2] leading-relaxed">
                  {report.section3FirstHalfPerformance.attacking}
                </p>
              </div>
              <div>
                <div className="font-semibold text-white mb-1.5">Defending</div>
                <p className="text-[#A8B2C2] leading-relaxed">
                  {report.section3FirstHalfPerformance.defending}
                </p>
              </div>
              <div>
                <div className="font-semibold text-white mb-1.5">Transitions</div>
                <p className="text-[#A8B2C2] leading-relaxed">
                  {report.section3FirstHalfPerformance.transitions}
                </p>
              </div>
            </div>
          </section>

          {/* Sections 4 & 5: Working vs Failing */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-4">
              <h2 className="text-[16px] font-semibold text-white">Section 4 · What Is Working</h2>
              <div className="divide-y divide-white/[0.06]">
                {report.section4WhatIsWorking.map((item, idx) => (
                  <div key={idx} className="py-3 first:pt-0 text-[13px] space-y-1">
                    <div className="font-medium text-white">
                      {item.observation}{' '}
                      <span className="text-[11px] text-[#8A94A6] font-normal">
                        · Confidence: {item.confidence}
                      </span>
                    </div>
                    <p className="text-[#9AA4B4]">{item.whyEffective}</p>
                    <p className="text-emerald-300/90 text-[12px]">Continue: {item.continueDoing}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-4">
              <h2 className="text-[16px] font-semibold text-white">
                Section 5 · What Is Not Working
              </h2>
              <div className="divide-y divide-white/[0.06]">
                {report.section5WhatIsNotWorking.map((item) => (
                  <div key={item.rank} className="py-3 first:pt-0 text-[13px] space-y-1">
                    <div className="font-medium text-white">
                      #{item.rank} {item.problem}{' '}
                      <span className="text-[11px] text-[#8A94A6] font-normal">
                        · Confidence: {item.confidence}
                      </span>
                    </div>
                    <p className="text-[#9AA4B4]">Evidence: {item.evidence}</p>
                    <p className="text-[#B8C0CE]">{item.tacticalExplanation}</p>
                    <p className="text-amber-300/90 text-[12px]">Fix: {item.proposedSolution}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Section 6 & Section 7 + Tactical Pitch */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
            <div className="xl:col-span-7 space-y-6">
              <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-4">
                <h2 className="text-[16px] font-semibold text-white">
                  Section 6 · Opponent Weakness Exploitation
                </h2>
                <div className="divide-y divide-white/[0.06]">
                  {report.section6OpponentWeaknesses.map((w, idx) => (
                    <div key={idx} className="py-3 first:pt-0 text-[13px] space-y-1">
                      <div className="font-medium text-white">
                        {w.strategy}{' '}
                        <span className="text-[11px] text-[#8A94A6] font-normal">
                          · Confidence: {w.confidence}
                        </span>
                      </div>
                      <p className="text-[#9AA4B4]">Evidence: {w.evidence}</p>
                      <p className="text-[#C5CCD7]">{w.executionDetail}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-5 text-[13px]">
                <h2 className="text-[16px] font-semibold text-white">
                  Section 7 · Second-Half Game Plan
                </h2>
                <div className="space-y-1.5">
                  <div className="font-semibold text-emerald-400">
                    Plan A — Recommended Tactical Adjustment
                  </div>
                  <div className="text-[#C5CCD7]">
                    Formation: {report.section7SecondHalfPlan.planA.formation} · Build-Up:{' '}
                    {report.section7SecondHalfPlan.planA.buildUpStyle} · Defense:{' '}
                    {report.section7SecondHalfPlan.planA.defensiveApproach} (
                    {report.section7SecondHalfPlan.planA.defensiveLine})
                  </div>
                  <p className="text-[#9AA4B4]">
                    {report.section7SecondHalfPlan.planA.attackingStrategy}
                  </p>
                </div>
                <div className="pt-3 border-t border-white/[0.06] space-y-1">
                  <div className="font-semibold text-white">Plan B — Alternative Strategy</div>
                  <p className="text-[#9AA4B4]">
                    Trigger: {report.section7SecondHalfPlan.planB.triggerCondition}
                  </p>
                  <p className="text-[#C5CCD7]">
                    {report.section7SecondHalfPlan.planB.adjustmentSummary}
                  </p>
                </div>
                <div className="pt-3 border-t border-white/[0.06] grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <div className="font-medium text-white">If Leading</div>
                    <p className="text-[#9AA4B4] mt-1">
                      {report.section7SecondHalfPlan.planC.ifLeading}
                    </p>
                  </div>
                  <div>
                    <div className="font-medium text-white">If Drawing</div>
                    <p className="text-[#9AA4B4] mt-1">
                      {report.section7SecondHalfPlan.planC.ifDrawing}
                    </p>
                  </div>
                  <div>
                    <div className="font-medium text-white">If Losing</div>
                    <p className="text-[#9AA4B4] mt-1">
                      {report.section7SecondHalfPlan.planC.ifLosing}
                    </p>
                  </div>
                </div>
              </section>
            </div>

            <div className="xl:col-span-5 border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
              <TacticalPitchSVG
                formation={report.section7SecondHalfPlan.planA.formation}
                players={players}
                assignments={selectedMatch?.tacticalConfiguration?.playerAssignments ?? []}
                label="Recommended Second-Half Structure (Plan A)"
                variant="recommended"
                showAttackingChannels
                showDefensiveZones
                showPressingAreas
              />
            </div>
          </div>

          {/* Structured Recommendations Table (Part 9 Format) */}
          {report.recommendations.length > 0 && (
            <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-4">
              <h2 className="text-[16px] font-semibold text-white">
                Structured FC26 Tactical Recommendations
              </h2>
              <div className="space-y-4">
                {report.recommendations.map((rec) => (
                  <div
                    key={rec.id}
                    className="border border-white/[0.08] bg-[#0E1116] rounded-md p-4 text-[13px] grid grid-cols-1 md:grid-cols-2 gap-3"
                  >
                    <div>
                      <span className="text-[11px] text-[#7D8798] block">Current Tactic</span>
                      <span className="text-[#C5CCD7]">{rec.currentTactic}</span>
                    </div>
                    <div>
                      <span className="text-[11px] text-emerald-400 block">Recommended Change</span>
                      <span className="text-white font-medium">{rec.recommendedChange}</span>
                    </div>
                    <div>
                      <span className="text-[11px] text-[#7D8798] block">
                        Why This Change Is Necessary
                      </span>
                      <span className="text-[#B2BAC8]">{rec.whyNecessary}</span>
                    </div>
                    <div>
                      <span className="text-[11px] text-[#7D8798] block">Expected Benefit</span>
                      <span className="text-[#B2BAC8]">{rec.expectedBenefit}</span>
                    </div>
                    <div>
                      <span className="text-[11px] text-[#7D8798] block">Potential Risk</span>
                      <span className="text-[#B2BAC8]">{rec.potentialRisk}</span>
                    </div>
                    <div>
                      <span className="text-[11px] text-[#7D8798] block">
                        When / Confidence / Priority
                      </span>
                      <span className="text-[#C5CCD7]">
                        {rec.whenToApply} · Confidence: {rec.confidence} · Priority: {rec.priority}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Sections 8, 9, 11 */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-3 text-[13px]">
              <h2 className="text-[16px] font-semibold text-white">
                Section 8 · Player Instructions
              </h2>
              {report.section8PlayerInstructions.length > 0 ? (
                report.section8PlayerInstructions.map((p, idx) => (
                  <div key={idx} className="pt-2 border-t border-white/[0.06] first:border-t-0">
                    <div className="font-medium text-white">
                      {p.playerLabel}: {p.currentRole} → {p.proposedRole}
                    </div>
                    <p className="text-[#9AA4B4] mt-0.5">{p.reasoning}</p>
                  </div>
                ))
              ) : (
                <p className="text-[#8A94A6]">
                  No player-specific changes listed (requires verified squad profiles or visual
                  identification).
                </p>
              )}
            </section>

            <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-3 text-[13px]">
              <h2 className="text-[16px] font-semibold text-white">
                Section 9 · Substitution Recommendations
              </h2>
              {report.section9Substitutions.length > 0 ? (
                report.section9Substitutions.map((s, idx) => (
                  <div key={idx} className="pt-2 border-t border-white/[0.06] first:border-t-0">
                    <div className="font-medium text-white">
                      Off: {s.playerOut} → On: {s.playerIn}
                    </div>
                    <p className="text-[#9AA4B4] mt-0.5">{s.tacticalReason}</p>
                  </div>
                ))
              ) : (
                <p className="text-[#8A94A6]">
                  No substitutions recommended without bench availability or observed fatigue.
                </p>
              )}
            </section>
          </div>

          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6">
            <div className="text-[12px] text-[#8A94A6] mb-1">
              Section 11 · Manager’s Final Instruction
            </div>
            <p className="text-[15px] text-white leading-relaxed">
              {report.section11FinalInstruction}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
