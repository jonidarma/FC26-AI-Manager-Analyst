import {
  Activity,
  Brain,
  ClipboardList,
  Crosshair,
  FileText,
  History,
  LayoutDashboard,
  Radio,
  Settings,
  Shield,
  SlidersHorizontal,
} from 'lucide-react';
import React from 'react';
import { useApp } from '../../context/AppContext';
import { desktopBridge } from '../../services/desktopBridge';
import type { NavigationSection } from '../../types/domain';

interface NavGroup {
  label: string;
  items: Array<{
    id: NavigationSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }>;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Club Operations',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { id: 'clubs', label: 'Career Mode Clubs', icon: Shield },
      { id: 'opposition', label: 'Opposition Analysis', icon: Crosshair },
    ],
  },
  {
    label: 'Matchday Workflow',
    items: [
      { id: 'match-prep', label: 'Match Preparation', icon: ClipboardList },
      { id: 'match-capture', label: 'Match Capture', icon: Radio },
      { id: 'halftime-briefing', label: 'Half-Time Briefing', icon: Activity },
      { id: 'tactical-board', label: 'Tactical Board', icon: SlidersHorizontal },
    ],
  },
  {
    label: 'Intelligence Archive',
    items: [
      { id: 'match-reports', label: 'Match Reports', icon: FileText },
      { id: 'match-history', label: 'Match History', icon: History },
      { id: 'tactical-memory', label: 'Tactical Memory', icon: Brain },
    ],
  },
  {
    label: 'Configuration',
    items: [{ id: 'settings', label: 'Settings', icon: Settings }],
  },
];

export function Sidebar() {
  const { activeSection, setActiveSection, clubs, activeClub, capabilities, refreshAll, notify } =
    useApp();

  async function handleSwitchClub(clubId: string) {
    if (!clubId || clubId === activeClub?.id) return;
    try {
      await desktopBridge.activateClub(clubId);
      await refreshAll();
      notify('info', 'Switched active Career Mode club.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to switch club');
    }
  }

  return (
    <aside className="w-64 shrink-0 border-r border-white/[0.08] bg-[#101318] flex flex-col h-screen sticky top-0 select-none">
      {/* Brand Wordmark */}
      <div className="px-5 py-5 border-b border-white/[0.08]">
        <button
          type="button"
          onClick={() => setActiveSection('dashboard')}
          className="text-left block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
        >
          <span className="block text-[15px] font-bold tracking-tight text-white">
            FC26 AI Manager
          </span>
          <span className="block text-[12px] text-[#8A94A6] mt-0.5">
            Tactical Intelligence System
          </span>
        </button>
      </div>

      {/* Active Club Selector */}
      <div className="px-4 py-3.5 border-b border-white/[0.08]">
        <label
          htmlFor="sidebar-club-select"
          className="block text-[12px] text-[#8A94A6] mb-1.5"
        >
          Active Career Club
        </label>
        {clubs.length > 0 ? (
          <select
            id="sidebar-club-select"
            value={activeClub?.id ?? ''}
            onChange={(e) => void handleSwitchClub(e.target.value)}
            className="w-full bg-[#171B22] border border-white/[0.1] rounded-md px-2.5 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500 transition-colors"
          >
            {clubs.map((c) => (
              <option key={c.id} value={c.id} className="bg-[#171B22] text-white">
                {c.name} ({c.profile.season})
              </option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            onClick={() => setActiveSection('clubs')}
            className="w-full text-left bg-[#171B22] border border-white/[0.1] hover:border-emerald-500/50 rounded-md px-2.5 py-2 text-[13px] text-[#B8C0CE] transition-colors"
          >
            Create Career Club
          </button>
        )}
      </div>

      {/* Navigation Groups */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 mb-1.5 text-[12px] font-medium text-[#6F798A]">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setActiveSection(item.id)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-emerald-500/12 text-emerald-300'
                          : 'text-[#B2BAC8] hover:text-white hover:bg-white/[0.04]'
                      }`}
                    >
                      <Icon
                        className={`w-4 h-4 shrink-0 ${
                          active ? 'text-emerald-400' : 'text-[#6F798A]'
                        }`}
                      />
                      <span className="truncate">{item.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Honest Runtime Boundary Footer */}
      <div className="px-4 py-3 border-t border-white/[0.08] text-[12px] text-[#7D8798]">
        <div className="font-medium text-[#C3CBD8]">
          {capabilities?.environment === 'electron-native'
            ? 'Native Desktop Runtime'
            : 'Browser Preview Mode'}
        </div>
        <div className="mt-0.5 text-[11px] text-[#7D8798] leading-snug">
          {capabilities?.environment === 'electron-native'
            ? capabilities.localFfmpegRecording
              ? 'Local SQLite & FFmpeg capture active'
              : 'Local SQLite (userData) · Recording planned for Phase 2'
            : 'Local SQLite live · Native capture requires Windows Electron'}
        </div>
      </div>
    </aside>
  );
}
