import { X } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { AppProvider, useApp } from './context/AppContext';
import { ClubsView } from './views/ClubsView';
import { DashboardView } from './views/DashboardView';
import { DatabaseCenterView } from './views/DatabaseCenterView';
import { HalfTimeBriefingView } from './views/HalfTimeBriefingView';
import { MatchCaptureView } from './views/MatchCaptureView';
import { MatchHistoryView } from './views/MatchHistoryView';
import { MatchPrepView } from './views/MatchPrepView';
import { MatchReportsView } from './views/MatchReportsView';
import { OppositionView } from './views/OppositionView';
import { SettingsView } from './views/SettingsView';
import { TacticalBoardView } from './views/TacticalBoardView';
import { TacticalMemoryView } from './views/TacticalMemoryView';

function WorkspaceContent() {
  const { activeSection, loading, error, refreshAll, toasts, dismissToast } = useApp();

  function renderSection() {
    switch (activeSection) {
      case 'dashboard':
        return <DashboardView />;
      case 'clubs':
        return <ClubsView />;
      case 'match-prep':
        return <MatchPrepView />;
      case 'match-capture':
        return <MatchCaptureView />;
      case 'halftime-briefing':
        return <HalfTimeBriefingView />;
      case 'tactical-board':
        return <TacticalBoardView />;
      case 'database-center':
        return <DatabaseCenterView />;
      case 'opposition':
        return <OppositionView />;
      case 'match-reports':
        return <MatchReportsView />;
      case 'match-history':
        return <MatchHistoryView />;
      case 'tactical-memory':
        return <TacticalMemoryView />;
      case 'settings':
        return <SettingsView />;
      default:
        return <DashboardView />;
    }
  }

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#F2F4F7] flex">
      <Sidebar />

      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        <TopBar />

        <main className="flex-1 px-6 py-7 max-w-[1440px] w-full mx-auto">
          {loading ? (
            <div className="space-y-4">
              <div className="h-8 w-64 bg-white/[0.05] rounded animate-pulse" />
              <div className="grid grid-cols-4 gap-4">
                {[0, 1, 2, 3].map((idx) => (
                  <div key={idx} className="h-28 bg-white/[0.04] rounded-lg animate-pulse" />
                ))}
              </div>
              <div className="h-64 bg-white/[0.04] rounded-lg animate-pulse" />
            </div>
          ) : error ? (
            <div className="border border-red-500/30 bg-red-500/[0.06] rounded-lg p-6 max-w-2xl">
              <h2 className="text-[16px] font-semibold text-red-200">
                Unable to Connect to Local Database Service
              </h2>
              <p className="mt-1 text-[13px] text-[#D7C4C7]">{error}</p>
              <button
                type="button"
                onClick={() => void refreshAll()}
                className="mt-4 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
              >
                Retry Connection
              </button>
            </div>
          ) : (
            renderSection()
          )}
        </main>
      </div>

      {/* Unobtrusive In-App Notification Stack */}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 space-y-2 max-w-sm w-full pointer-events-none"
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`pointer-events-auto flex items-start justify-between gap-3 px-4 py-3 rounded-lg border text-[13px] shadow-lg ${
                toast.tone === 'error'
                  ? 'bg-[#1F1215] border-red-500/35 text-red-100'
                  : toast.tone === 'success'
                    ? 'bg-[#101C17] border-emerald-500/35 text-emerald-100'
                    : 'bg-[#151921] border-white/[0.12] text-[#E6EBF2]'
              }`}
            >
              <span>{toast.text}</span>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                aria-label="Dismiss notification"
                className="text-current opacity-70 hover:opacity-100 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <WorkspaceContent />
    </AppProvider>
  );
}
