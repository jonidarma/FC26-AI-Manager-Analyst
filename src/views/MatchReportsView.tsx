import { Download, ExternalLink } from 'lucide-react';
import { useApp } from '../context/AppContext';

export function MatchReportsView() {
  const { halftimeReports, postMatchReports, matches, setSelectedMatchId, setActiveSection } =
    useApp();

  function exportReportFile(filename: string, payload: unknown) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-7">
      <div className="border-b border-white/[0.08] pb-5">
        <h1 className="text-[24px] font-bold text-white tracking-tight">Match Reports Archive</h1>
        <p className="mt-1 text-[14px] text-[#9AA4B4]">
          Saved half-time briefings and post-match evaluations stored locally in SQLite. Second-half
          comparisons are only generated when second-half footage is recorded.
        </p>
      </div>

      {/* Half-Time Briefings Archive */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
        <h2 className="text-[16px] font-semibold text-white mb-4">Saved Half-Time Briefings</h2>
        {halftimeReports.length > 0 ? (
          <div className="divide-y divide-white/[0.06]">
            {halftimeReports.map((item) => {
              const matched = matches.find((m) => m.id === item.matchId);
              const visionKey = matched?.tacticalConfiguration?.tacticalVisionKey;
              return (
                <div
                  key={item.matchId}
                  className="py-3.5 flex flex-wrap items-center justify-between gap-4 text-[13px]"
                >
                  <div>
                    <div className="font-medium text-white flex items-center gap-2 flex-wrap">
                      <span>
                        vs {item.opponentName} · {item.competition}
                      </span>
                      {visionKey && visionKey !== 'unspecified' && (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-mono text-emerald-300 uppercase">
                          {visionKey.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] text-[#8A94A6] font-mono tabular-nums mt-0.5">
                      {item.matchDate} · Score {item.report.section1MatchSituation.scoreLabel} ·
                      Model {item.report.modelUsed}
                    </div>
                  </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMatchId(item.matchId);
                      setActiveSection('halftime-briefing');
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/[0.12] hover:border-emerald-500/60 text-[12px] text-white"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open Briefing
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      exportReportFile(
                        `match-report-${item.matchDate}-${item.opponentName
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, '-')}.json`,
                        item.report
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[12px] text-[#C5CCD7]"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        ) : (
          <div className="py-6 text-[13px] text-[#8A94A6]">
            No half-time tactical reports have been saved yet. Complete a first-half recording and
            analysis session to generate your first report.
          </div>
        )}
      </section>

      {/* Post-Match Reports Archive */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
        <h2 className="text-[16px] font-semibold text-white mb-4">
          Post-Match & Full-Time Comparisons
        </h2>
        {postMatchReports.length > 0 ? (
          <div className="divide-y divide-white/[0.06]">
            {postMatchReports.map((pmr) => {
              const match = matches.find((m) => m.id === pmr.matchId);
              return (
                <div key={pmr.id} className="py-3.5 text-[13px] space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium text-white">
                      {match
                        ? `${match.matchDate} · vs ${match.opponentName}`
                        : `Match ${pmr.matchId.slice(0, 8)}`}
                    </div>
                    <span className="text-[12px] text-[#8A94A6]">
                      {pmr.hasSecondHalfEvidence
                        ? 'Includes Second-Half Evidence'
                        : 'First-Half Only + Manual Final Result'}
                    </span>
                  </div>
                  <p className="text-[#A8B2C2] leading-relaxed">{pmr.summary}</p>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-6 text-[13px] text-[#8A94A6]">
            No post-match evaluations stored yet. Second-half capture is optional—matches marked
            complete manually in Match History remain preserved without invented second-half data.
          </div>
        )}
      </section>
    </div>
  );
}
