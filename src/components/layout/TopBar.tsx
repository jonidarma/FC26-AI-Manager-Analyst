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
  opposition: 'Opposition Analysis',
  'match-reports': 'Match Reports',
  'match-history': 'Match History',
  'tactical-memory': 'Tactical Memory',
  settings: 'Settings',
};

export function TopBar() {
  const { activeSection, setActiveSection, activeClub } = useApp();

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

      <div className="flex items-center gap-3 shrink-0">
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
