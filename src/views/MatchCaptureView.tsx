import {
  AlertTriangle,
  HardDrive,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { desktopBridge } from '../services/desktopBridge';
import type { CaptureSourceInfo, DiskSpaceInfo } from '../types/domain';

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unavailable in Browser Preview';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function MatchCaptureView() {
  const {
    capabilities,
    matches,
    selectedMatchId,
    setSelectedMatchId,
    settings,
    setActiveSection,
    refreshAll,
    notify,
  } = useApp();

  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [diskInfo, setDiskInfo] = useState<DiskSpaceInfo | null>(null);
  const [recoverableCount, setRecoverableCount] = useState<number>(0);

  const selectedMatch = matches.find((m) => m.id === selectedMatchId) ?? matches[0] ?? null;
  const isNativeElectron = capabilities?.environment === 'electron-native';
  const isRecordingImplemented = capabilities?.localFfmpegRecording === true;

  const captureCfg = settings?.capture;

  // Estimate file size for a 15-minute real-time half based on configured bitrate
  const estimatedHalfSizeMb = captureCfg
    ? Math.round((((captureCfg.bitrateKbps * 1000) / 8) * (15 * 60)) / (1024 * 1024))
    : 495;

  async function refreshSources() {
    setLoadingSources(true);
    setSourceError(null);
    try {
      const result = await desktopBridge.listCaptureSources();
      if (!result.supported) {
        setSources([]);
        setSourceError(result.reason ?? 'Native capture unavailable in browser preview.');
      } else {
        setSources(result.sources);
        const fcWindow = result.sources.find(
          (s) =>
            s.name.toLowerCase().includes('fc 26') || s.name.toLowerCase().includes('fc26')
        );
        if (fcWindow) {
          setSelectedSourceId(fcWindow.id);
        } else if (result.sources[0] && !selectedSourceId) {
          setSelectedSourceId(result.sources[0].id);
        }
      }

      if (captureCfg) {
        const disk = await desktopBridge.getDiskSpace(captureCfg.storageDirectory);
        setDiskInfo(disk);
      }

      const recoverable = await desktopBridge.getRecoverableSessions();
      setRecoverableCount(recoverable.length);
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : 'Failed to inspect capture sources');
    } finally {
      setLoadingSources(false);
    }
  }

  useEffect(() => {
    void refreshSources();
  }, [capabilities?.environment]);

  async function handleQuickCaptureSetting(
    patch: Partial<NonNullable<typeof settings>['capture']>
  ) {
    try {
      await desktopBridge.updateSettings({ capture: patch });
      await refreshAll();
      notify('success', 'Recording configuration saved to SQLite.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to update capture setting');
    }
  }

  const selectedSource = sources.find((s) => s.id === selectedSourceId) ?? null;

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">
            Match Capture & Recording Configuration
          </h1>
          <p className="mt-1 text-[14px] text-[#9AA4B4]">
            Half-Time Analyst Mode — Configure FC26 capture parameters locally with zero live AI
            processing or gameplay notifications.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void refreshSources()}
            disabled={loadingSources}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-white/[0.12] hover:border-white/[0.24] text-[13px] text-[#D7DDE7] transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingSources ? 'animate-spin' : ''}`} />
            Refresh Sources
          </button>
        </div>
      </div>

      {/* Honest Runtime & Phase Scope Disclosure */}
      <div className="border border-amber-500/30 bg-amber-500/[0.06] rounded-lg p-5 flex items-start gap-3.5">
        <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1.5 text-[13px]">
          <div className="font-semibold text-amber-200">
            {isNativeElectron
              ? 'Phase 1.1 Desktop Foundation — Recording Engine Planned for Phase 2'
              : 'Browser Preview Environment — Native Windows Capture Unavailable'}
          </div>
          <p className="text-[#D2D7E0] leading-relaxed">
            {isNativeElectron
              ? 'Window and display source enumeration via Electron desktopCapturer, local disk space inspection, and persistent SQLite configuration are active. Actual H.264 FFmpeg segmented video recording is intentionally disabled until Phase 2 implementation and Windows verification.'
              : 'This preview runs inside a browser sandbox. Native Windows FC26 window capture is unavailable here and is never simulated. Recording configuration changes save to your local SQLite database; live video recording activates in Phase 2 on Windows.'}
          </p>
        </div>
      </div>

      {/* Active Match Selector */}
      <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="capture-match-select"
              className="block text-[12px] text-[#8A94A6] mb-1.5"
            >
              Bound Match ID (Isolates First-Half & Second-Half Recordings)
            </label>
            {matches.length > 0 ? (
              <select
                id="capture-match-select"
                value={selectedMatch?.id ?? ''}
                onChange={(e) => setSelectedMatchId(e.target.value)}
                className="w-full max-w-xl bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-emerald-500"
              >
                {matches.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.matchDate} · {m.venue === 'home' ? 'vs' : '@'} {m.opponentName} (
                    {m.competition}) · {m.startingFormation}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-[13px] text-[#9AA4B4]">
                No match prepared yet.{' '}
                <button
                  type="button"
                  onClick={() => setActiveSection('match-prep')}
                  className="text-emerald-400 hover:text-emerald-300 font-medium underline"
                >
                  Create a match in Match Preparation
                </button>
                .
              </div>
            )}
          </div>

          {selectedMatch && (
            <div className="text-right text-[12px] font-mono tabular-nums text-[#8A94A6]">
              <div>Match ID: {selectedMatch.id.slice(0, 8)}</div>
              <div className="mt-0.5 text-[#C5CCD7] capitalize">
                Status: {selectedMatch.status.replace(/_/g, ' ')}
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left 7 cols: Capture Source Preview & Phase 2 Recording Controls */}
        <div className="xl:col-span-7 space-y-6">
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-white">FC26 Window & Display Source</h2>
              <span className="text-[12px] text-[#8A94A6]">
                Recommended: Borderless Windowed Mode
              </span>
            </div>

            {isNativeElectron && sources.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                    Select Window or Display Fallback (Active in Phase 1.1)
                  </label>
                  <select
                    value={selectedSourceId}
                    onChange={(e) => setSelectedSourceId(e.target.value)}
                    className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-[13px] text-white"
                  >
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        [{s.type === 'window' ? 'Window' : 'Display Fallback'}] {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedSource?.thumbnailDataUrl && (
                  <div className="rounded-md overflow-hidden border border-white/[0.1] bg-black">
                    <img
                      src={selectedSource.thumbnailDataUrl}
                      alt={`Capture preview of ${selectedSource.name}`}
                      className="w-full aspect-video object-contain"
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="aspect-video rounded-md border border-dashed border-white/[0.12] bg-[#0C0F14] flex flex-col items-center justify-center p-6 text-center">
                <Monitor className="w-8 h-8 text-[#596272] mb-3" />
                <div className="text-[14px] font-medium text-white">
                  {isNativeElectron
                    ? 'No Capture Sources Returned'
                    : 'Capture Preview Requires Native Electron Runtime'}
                </div>
                <p className="mt-1.5 text-[12px] text-[#8A94A6] max-w-md leading-relaxed">
                  {sourceError ||
                    'Launch the Windows Electron application to enumerate EA SPORTS FC 26 windows and preview available capture sources.'}
                </p>
              </div>
            )}

            {/* Recording Telemetry Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-white/[0.08] text-[12px]">
              <div>
                <div className="text-[#7D8798]">Recording Engine</div>
                <div className="mt-0.5 font-medium text-amber-300">
                  {isRecordingImplemented ? 'Ready' : 'Planned (Phase 2)'}
                </div>
              </div>
              <div>
                <div className="text-[#7D8798]">Session Duration</div>
                <div className="mt-0.5 font-mono tabular-nums text-white">00:00:00</div>
              </div>
              <div>
                <div className="text-[#7D8798]">Target Resolution</div>
                <div className="mt-0.5 font-mono tabular-nums text-white">
                  {captureCfg?.resolution ?? '1920x1080'} · {captureCfg?.fps ?? 15} FPS
                </div>
              </div>
              <div>
                <div className="text-[#7D8798]">Captured Size</div>
                <div className="mt-0.5 font-mono tabular-nums text-white">0.0 MB</div>
              </div>
            </div>

            {/* Phase 2 Recording Controls — Strictly disabled until localFfmpegRecording is true */}
            <div className="pt-3 border-t border-white/[0.08] space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <span className="font-medium text-[#C5CCD7]">
                  Session Controls — Planned for Phase 2 (FFmpeg Capture Engine)
                </span>
                <span className="text-[#7D8798]">Disabled until Phase 2 verification</span>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={!isRecordingImplemented}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[#1E242E] text-[#687283] text-[13px] font-medium cursor-not-allowed"
                >
                  <Play className="w-3.5 h-3.5" />
                  Start First-Half Recording
                </button>

                <button
                  type="button"
                  disabled={!isRecordingImplemented}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-white/[0.08] text-[#687283] text-[13px] font-medium cursor-not-allowed"
                >
                  <Pause className="w-3.5 h-3.5" />
                  Pause
                </button>

                <button
                  type="button"
                  disabled={!isRecordingImplemented}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-white/[0.08] text-[#687283] text-[13px] font-medium cursor-not-allowed"
                >
                  <Square className="w-3.5 h-3.5" />
                  End First Half & Analyze
                </button>

                <button
                  type="button"
                  disabled={!isRecordingImplemented || recoverableCount === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-white/[0.08] text-[#687283] text-[13px] font-medium cursor-not-allowed"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Recover Session ({recoverableCount})
                </button>

                <button
                  type="button"
                  disabled={!isRecordingImplemented}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-white/[0.08] text-[#687283] text-[13px] font-medium cursor-not-allowed"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Discard
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* Right 5 cols: Active Phase 1.1 Recording Configuration & Safeguards */}
        <div className="xl:col-span-5 space-y-6">
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-white">Recording Configuration</h2>
              <span className="text-[12px] text-emerald-400">Active (Persisted)</span>
            </div>

            {captureCfg && (
              <div className="space-y-4 text-[13px]">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] text-[#9AA4B4] mb-1">Resolution</label>
                    <select
                      value={captureCfg.resolution}
                      onChange={(e) =>
                        void handleQuickCaptureSetting({
                          resolution: e.target.value as '1920x1080' | '1280x720',
                        })
                      }
                      className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-2.5 py-1.5 text-[13px] text-white font-mono"
                    >
                      <option value="1920x1080">1920×1080 (Default)</option>
                      <option value="1280x720">1280×720 (Fallback)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] text-[#9AA4B4] mb-1">Frame Rate</label>
                    <select
                      value={captureCfg.fps}
                      onChange={(e) =>
                        void handleQuickCaptureSetting({ fps: Number(e.target.value) })
                      }
                      className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-2.5 py-1.5 text-[13px] text-white font-mono tabular-nums"
                    >
                      <option value={10}>10 FPS</option>
                      <option value={15}>15 FPS (Default)</option>
                      <option value={24}>24 FPS</option>
                      <option value={30}>30 FPS</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] text-[#9AA4B4] mb-1">
                      Segment Length
                    </label>
                    <select
                      value={captureCfg.segmentDurationMinutes}
                      onChange={(e) =>
                        void handleQuickCaptureSetting({
                          segmentDurationMinutes: Number(e.target.value),
                        })
                      }
                      className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-2.5 py-1.5 text-[13px] text-white font-mono tabular-nums"
                    >
                      <option value={2}>2 min segments</option>
                      <option value={3}>3 min segments</option>
                      <option value={4}>4 min segments</option>
                      <option value={5}>5 min segments</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] text-[#9AA4B4] mb-1">
                      Video Codec / Format
                    </label>
                    <div className="bg-[#0C0F14] border border-white/[0.08] rounded-md px-2.5 py-1.5 text-[13px] text-[#B8C0CE] font-mono">
                      H.264 / MP4
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-white/[0.08] space-y-2 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="text-[#8A94A6]">Estimated 15-Min Half Size</span>
                    <span className="font-mono tabular-nums text-white">
                      ~{estimatedHalfSizeMb} MB ({captureCfg.bitrateKbps} kbps)
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#8A94A6] inline-flex items-center gap-1.5">
                      <HardDrive className="w-3.5 h-3.5" />
                      Available Disk Space
                    </span>
                    <span className="font-mono tabular-nums text-[#C5CCD7]">
                      {formatBytes(diskInfo?.availableBytes ?? null)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#8A94A6]">Game Audio Recording</span>
                    <span className="text-[#C5CCD7]">
                      {captureCfg.audioEnabled ? 'Enabled' : 'Disabled (Default)'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#8A94A6]">Microphone Input</span>
                    <span className="text-emerald-400">Permanently Disabled</span>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-2.5 text-[12px] text-[#9AA4B4]">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
              <AlertTriangle className="w-4 h-4 text-emerald-400" />
              Half-Time Analyst Operational Rules
            </div>
            <p className="leading-relaxed">
              While recording is active in Phase 2+, no frames or video segments are sent to Gemini,
              no AI notifications appear, and no controller or keyboard inputs are intercepted.
            </p>
            <p className="leading-relaxed">
              Footage will be written in crash-resilient {captureCfg?.segmentDurationMinutes ?? 3}
              -minute local segments so an unexpected game crash or power loss preserves completed
              segments.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
