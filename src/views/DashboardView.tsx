import { ArrowRight, Plus } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useApp } from '../context/AppContext';

export function DashboardView() {
  const { dashboard, activeClub, setActiveSection, setSelectedMatchId, capabilities } = useApp();

  if (!activeClub) {
    return (
      <div className="max-w-4xl mx-auto py-12">
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-8">
          <div className="text-[12px] text-emerald-400 font-medium mb-2">
            Phase 1 Foundation · Half-Time Analyst Workflow
          </div>
          <h1 className="text-[28px] font-bold text-white tracking-tight">
            Establish Your Career Mode Coaching Department
          </h1>
          <p className="mt-3 text-[15px] text-[#9AA4B4] max-w-2xl leading-relaxed">
            Observe first, analyze at half-time, recommend with evidence, and build long-term
            tactical memory across seasons. Create your first Career Mode club profile to start
            configuring fixtures, squad roles, and capture settings.
          </p>

          <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-5 border-t border-white/[0.08] pt-6">
            <div>
              <div className="text-[13px] font-semibold text-white">01. Club & Tactics</div>
              <p className="mt-1 text-[13px] text-[#8A94A6] leading-relaxed">
                Save your Career Mode club, preferred formations, and optional squad profiles in
                local SQLite storage.
              </p>
            </div>
            <div>
              <div className="text-[13px] font-semibold text-white">02. Quiet First-Half Capture</div>
              <p className="mt-1 text-[13px] text-[#8A94A6] leading-relaxed">
                Record the FC26 window locally in 2–5 minute segments with zero live AI
                interruptions during play.
              </p>
            </div>
            <div>
              <div className="text-[13px] font-semibold text-white">03. Half-Time Briefing</div>
              <p className="mt-1 text-[13px] text-[#8A94A6] leading-relaxed">
                Receive evidence-backed tactical adjustments, role instructions, and three priority
                actions at the break.
              </p>
            </div>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => setActiveSection('clubs')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create Career Mode Club
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('settings')}
              className="px-4 py-2.5 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[#D7DDE7] text-[13px] font-medium transition-colors"
            >
              Review Capture & Catalog Settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  const record = dashboard?.record ?? { wins: 0, draws: 0, losses: 0 };
  const totalCompleted = record.wins + record.draws + record.losses;
  const formationData = dashboard?.formationBreakdown ?? [];

  return (
    <div className="space-y-8">
      {/* Club Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <div className="text-[12px] text-[#8A94A6] flex flex-wrap items-center gap-2">
            <span>{activeClub.league || 'League Unspecified'}</span>
            <span aria-hidden="true">·</span>
            <span>Season {activeClub.profile.season}</span>
            <span aria-hidden="true">·</span>
            <span>Manager: {activeClub.profile.managerName || 'Unspecified'}</span>
          </div>
          <h1 className="mt-1 text-[28px] font-bold text-white tracking-tight">
            {activeClub.name}
          </h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Philosophy: {activeClub.profile.preferredPhilosophy} · Primary{' '}
            {activeClub.profile.primaryFormation} · Alternative{' '}
            {activeClub.profile.alternativeFormation}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setActiveSection('match-prep')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium transition-colors whitespace-nowrap"
          >
            Prepare Next Match
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Runtime Notice (Honest Browser Preview Disclosure) */}
      {capabilities && capabilities.environment === 'browser-preview' && (
        <div className="border border-white/[0.08] bg-[#12161D] rounded-lg px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-[13px]">
          <div className="text-[#C7CFD9]">
            <span className="font-semibold text-white">Browser Preview Environment</span>
            <span className="mx-2 text-[#4B5362]">·</span>
            <span>
              Local SQLite persistence is active. Native Windows FC26 window capture requires the
              packaged Electron desktop app.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setActiveSection('match-capture')}
            className="text-emerald-400 hover:text-emerald-300 font-medium whitespace-nowrap"
          >
            Inspect Capture Setup
          </button>
        </div>
      )}

      {/* 4-Column Executive KPI Strip (Strictly computed from saved SQLite rows) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
          <div className="text-[12px] text-[#8A94A6]">Analyzed Matches</div>
          <div className="mt-2 text-[26px] font-semibold text-white font-mono tabular-nums">
            {dashboard?.analyzedMatches ?? 0}
          </div>
          <div className="mt-1 text-[12px] text-[#6F798A] font-mono tabular-nums">
            of {dashboard?.totalMatches ?? 0} saved fixtures
          </div>
        </div>

        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
          <div className="text-[12px] text-[#8A94A6]">Saved Match Record (W–D–L)</div>
          <div className="mt-2 text-[26px] font-semibold text-white font-mono tabular-nums">
            {record.wins}–{record.draws}–{record.losses}
          </div>
          <div className="mt-1 text-[12px] text-[#6F798A]">
            {totalCompleted > 0
              ? `${totalCompleted} completed result${totalCompleted === 1 ? '' : 's'} logged`
              : 'No completed results recorded yet'}
          </div>
        </div>

        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
          <div className="text-[12px] text-[#8A94A6]">Most Used Formation</div>
          <div className="mt-2 text-[22px] font-semibold text-white truncate">
            {dashboard?.mostUsedFormation ?? 'Not yet logged'}
          </div>
          <div className="mt-1 text-[12px] text-[#6F798A]">
            Primary profile: {activeClub.profile.primaryFormation}
          </div>
        </div>

        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
          <div className="text-[12px] text-[#8A94A6]">Registered Squad Players</div>
          <div className="mt-2 text-[26px] font-semibold text-white font-mono tabular-nums">
            {activeClub.playerCount}
          </div>
          <div className="mt-1 text-[12px] text-[#6F798A]">
            Optional · Enhances player-specific briefings
          </div>
        </div>
      </div>

      {/* Main 2-Column Analytics Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left 7 cols: Fixtures & Recent Matches */}
        <div className="xl:col-span-7 space-y-6">
          {/* Upcoming Fixtures */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[16px] font-semibold text-white">Upcoming Fixtures</h2>
              <button
                type="button"
                onClick={() => setActiveSection('match-prep')}
                className="text-[12px] text-emerald-400 hover:text-emerald-300 font-medium"
              >
                Schedule Match
              </button>
            </div>

            {dashboard && dashboard.upcomingFixtures.length > 0 ? (
              <div className="divide-y divide-white/[0.06]">
                {dashboard.upcomingFixtures.map((match) => (
                  <div
                    key={match.id}
                    className="py-3 flex items-center justify-between gap-4 text-[13px]"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-white truncate">
                        {match.venue === 'home' ? 'vs' : '@'} {match.opponentName}
                      </div>
                      <div className="text-[12px] text-[#8A94A6] mt-0.5 font-mono tabular-nums">
                        {match.matchDate} · {match.competition} · {match.startingFormation}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedMatchId(match.id);
                        setActiveSection('match-capture');
                      }}
                      className="px-3 py-1.5 rounded-md border border-white/[0.12] hover:border-emerald-500/60 text-[12px] text-white font-medium transition-colors whitespace-nowrap shrink-0"
                    >
                      Open Capture
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-[13px] text-[#8A94A6]">
                No upcoming fixtures scheduled. Create a match in Match Preparation before kicking
                off in FC26.
              </div>
            )}
          </section>

          {/* Recent Matches */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[16px] font-semibold text-white">Recent Matches</h2>
              <button
                type="button"
                onClick={() => setActiveSection('match-history')}
                className="text-[12px] text-emerald-400 hover:text-emerald-300 font-medium"
              >
                View Full History
              </button>
            </div>

            {dashboard && dashboard.recentMatches.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-white/[0.08] text-[12px] text-[#7D8798]">
                      <th className="py-2 pr-3 font-medium">Opponent</th>
                      <th className="py-2 pr-3 font-medium">Competition</th>
                      <th className="py-2 pr-3 font-medium">Formation</th>
                      <th className="py-2 pr-3 font-medium text-right">Score</th>
                      <th className="py-2 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {dashboard.recentMatches.map((m) => (
                      <tr
                        key={m.id}
                        className="hover:bg-white/[0.02] cursor-pointer"
                        onClick={() => {
                          setSelectedMatchId(m.id);
                          setActiveSection('halftime-briefing');
                        }}
                      >
                        <td className="py-2.5 pr-3 font-medium text-white">
                          {m.venue === 'home' ? 'vs ' : '@ '}
                          {m.opponentName}
                        </td>
                        <td className="py-2.5 pr-3 text-[#9AA4B4]">{m.competition}</td>
                        <td className="py-2.5 pr-3 text-[#9AA4B4] font-mono tabular-nums">
                          {m.startingFormation}
                        </td>
                        <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-white">
                          {m.finalScoreFor !== null && m.finalScoreAgainst !== null
                            ? `${m.finalScoreFor}–${m.finalScoreAgainst}`
                            : m.halftimeScoreFor !== null && m.halftimeScoreAgainst !== null
                              ? `HT ${m.halftimeScoreFor}–${m.halftimeScoreAgainst}`
                              : 'Pending'}
                        </td>
                        <td className="py-2.5 text-right text-[12px] text-[#8A94A6] capitalize">
                          {m.status.replace(/_/g, ' ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-6 text-[13px] text-[#8A94A6]">
                No completed or in-progress matches yet. Saved results and half-time sessions will
                appear here automatically.
              </div>
            )}
          </section>

          {/* Formation Usage Chart (Only rendered when real match rows exist) */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <h2 className="text-[16px] font-semibold text-white mb-1">Formation Usage Breakdown</h2>
            <p className="text-[12px] text-[#8A94A6] mb-4">
              Computed strictly from saved matches for {activeClub.name}.
            </p>
            {formationData.length > 0 ? (
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={formationData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis
                      dataKey="formation"
                      tick={{ fill: '#9AA4B4', fontSize: 12 }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                      tickLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fill: '#9AA4B4', fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#161B22',
                        borderColor: 'rgba(255,255,255,0.12)',
                        color: '#F2F4F7',
                        fontSize: '12px',
                      }}
                    />
                    <Bar dataKey="matches" name="Matches" fill="#10B981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="py-8 text-[13px] text-[#8A94A6] border border-dashed border-white/[0.08] rounded-md text-center">
                No formation data recorded yet. Schedule or log a match to track formation trends.
              </div>
            )}
          </section>
        </div>

        {/* Right 5 cols: Recurring Weaknesses & Latest Recommendations */}
        <div className="xl:col-span-5 space-y-6">
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[16px] font-semibold text-white">Recurring Tactical Weaknesses</h2>
              <button
                type="button"
                onClick={() => setActiveSection('tactical-memory')}
                className="text-[12px] text-emerald-400 hover:text-emerald-300 font-medium"
              >
                Tactical Memory
              </button>
            </div>

            {dashboard && dashboard.recurringWeaknesses.length > 0 ? (
              <div className="divide-y divide-white/[0.06]">
                {dashboard.recurringWeaknesses.map((w) => (
                  <div key={w.id} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-white">{w.title}</span>
                      <span className="text-[12px] text-[#8A94A6] font-mono tabular-nums">
                        {w.evidenceCount} obs · {w.confidence}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] text-[#9AA4B4] leading-relaxed">{w.detail}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-5 text-[13px] text-[#8A94A6] leading-relaxed">
                No recurring tactical weaknesses recorded yet. As half-time analyses and manual
                notes accumulate in Tactical Memory, repeated structural issues will surface here.
              </div>
            )}
          </section>

          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[16px] font-semibold text-white">
                Latest Managerial Recommendations
              </h2>
              <button
                type="button"
                onClick={() => setActiveSection('halftime-briefing')}
                className="text-[12px] text-emerald-400 hover:text-emerald-300 font-medium"
              >
                Open Briefings
              </button>
            </div>

            {dashboard && dashboard.latestRecommendations.length > 0 ? (
              <div className="divide-y divide-white/[0.06]">
                {dashboard.latestRecommendations.map((rec) => (
                  <div key={rec.id} className="py-3">
                    <div className="text-[12px] text-[#8A94A6]">
                      Priority: {rec.priority} · Confidence: {rec.confidence}
                    </div>
                    <div className="mt-1 text-[13px] font-medium text-white">
                      {rec.recommendedChange}
                    </div>
                    <p className="mt-1 text-[12px] text-[#9AA4B4] leading-relaxed">
                      {rec.whyNecessary}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-5 text-[13px] text-[#8A94A6] leading-relaxed">
                No half-time recommendations generated yet. Recommendations are created strictly at
                half-time from verified match evidence.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
