import { Plus } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { NavigationSection } from '../../types/domain';

const SECTION_LABELS: Record<NavigationSection, string> = {
  dashboard: 'Dashboard',
  clubs: 'Career Mode Clubs',
  'match-prep': 'Match Preparation',
  'match-capture': 'Match Capture',
  'halftime-briefing': 'Half-Time Briefing',
  'tactical-board': 'Tactical Board',
  'database-center': 'FC26 Database Center',
  opposition: 'Opposition Analysis',
  'match-reports': 'Match Reports',
  'match-history': 'Match History',
  'tactical-memory': 'Tactical Memory',
  settings: 'Settings',
};

function formatShortTimer(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function TopBar() {
  const { activeSection, setActiveSection, activeClub, recordingTelemetry } = useApp();

  const isLiveSession =
    recordingTelemetry.uiStatus === 'recording' ||
    recordingTelemetry.uiStatus === 'paused' ||
    recordingTelemetry.uiStatus === 'finalizing';

  return (
    <header className="h-14 shrink-0 border-b border-white/[0.08] bg-[#0E1116] px-6 flex items-center justify-between gap-8 sticky top-0 z-20">
      <div className="flex items-center gap-2 text-[13px] min-w-0">
        <span className="text-[#8A94A6] whitespace-nowrap shrink-0">
          {activeClub ? activeClub.name : 'No Active Club'}
        </span>
        <span className="text-[#4B5362]" aria-hidden="true">
          /
        </span>
        <span className="font-medium text-white truncate">
          {SECTION_LABELS[activeSection]}
        </span>
      </div>

      <div className="flex items-center gap-4 shrink-0">
        {/* Real-time live capture status indicator — visible ONLY while an actual recording session is active */}
        {isLiveSession && (
          <button
            type="button"
            onClick={() => setActiveSection('match-capture')}
            className="inline-flex items-center gap-2.5 px-3 py-1.5 rounded-md border border-white/[0.12] bg-[#141820] hover:border-white/[0.25] text-[12px] text-white transition-colors whitespace-nowrap"
          >
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                recordingTelemetry.uiStatus === 'recording'
                  ? 'bg-red-500 animate-pulse'
                  : recordingTelemetry.uiStatus === 'paused'
                    ? 'bg-amber-400'
                    : 'bg-sky-400'
              }`}
              aria-hidden="true"
            />
            <span className="font-medium">
              {recordingTelemetry.uiStatus === 'recording'
                ? 'REC'
                : recordingTelemetry.uiStatus === 'paused'
                  ? 'PAUSED'
                  : 'FINALIZING'}
            </span>
            <span className="text-[#8A94A6]">
              {recordingTelemetry.half === 'second_half' ? '2nd Half' : '1st Half'}
            </span>
            <span className="font-mono tabular-nums text-[#D7DDE7]">
              {formatShortTimer(recordingTelemetry.activeDurationSeconds)}
            </span>
            <span className="font-mono tabular-nums text-[#8A94A6]">
              Seg #{recordingTelemetry.currentSegmentIndex}
            </span>
          </button>
        )}

        {activeSection !== 'match-prep' && (
          <button
            type="button"
            onClick={() => setActiveSection(activeClub ? 'match-prep' : 'clubs')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            {activeClub ? 'New Match' : 'Create Club'}
          </button>
        )}
      </div>
    </header>
  );
}
