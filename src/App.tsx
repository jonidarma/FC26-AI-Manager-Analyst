import { AlertTriangle, X } from 'lucide-react';
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
import { SquadManagementView } from './views/SquadManagementView';
import { TacticalBoardView } from './views/TacticalBoardView';
import { TacticalMemoryView } from './views/TacticalMemoryView';
import { TacticalSetupView } from './views/TacticalSetupView';

function WorkspaceContent() {
  const {
    activeSection,
    loading,
    error,
    refreshAll,
    toasts,
    dismissToast,
    pendingNavigation,
  } = useApp();

  function renderSection() {
    switch (activeSection) {
      case 'dashboard':
        return <DashboardView />;
      case 'clubs':
        return <ClubsView />;
      case 'squad-management':
        return <SquadManagementView />;
      case 'tactical-setup':
        return <TacticalSetupView />;
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

      {/* Global Dirty-State Unsaved Changes Navigation Guard Modal (Save / Discard / Cancel) */}
      {pendingNavigation && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsaved-changes-title"
            className="w-full max-w-md border border-amber-500/35 bg-[#12151B] rounded-lg p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h2 id="unsaved-changes-title" className="text-[16px] font-semibold text-white">
                  Unsaved Changes in {pendingNavigation.guardLabel}
                </h2>
                <p className="mt-1 text-[13px] text-[#9AA4B4]">
                  You have unsaved tactical edits. Choose whether to save or discard them before
                  navigating to <span className="text-white">{pendingNavigation.targetDescription}</span>.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-white/[0.08]">
              <button
                type="button"
                disabled={pendingNavigation.saving}
                onClick={pendingNavigation.onCancel}
                className="px-3.5 py-2 rounded-md border border-white/[0.12] text-[13px] text-[#C5CCD7] hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pendingNavigation.saving}
                onClick={pendingNavigation.onConfirmDiscard}
                className="px-3.5 py-2 rounded-md border border-red-500/35 hover:bg-red-500/10 text-[13px] text-red-300 font-medium"
              >
                Discard
              </button>
              <button
                type="button"
                disabled={pendingNavigation.saving}
                onClick={() => void pendingNavigation.onConfirmSave()}
                className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[13px] font-medium"
              >
                {pendingNavigation.saving ? 'Saving...' : 'Save & Continue'}
              </button>
            </div>
          </div>
        </div>
      )}

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
