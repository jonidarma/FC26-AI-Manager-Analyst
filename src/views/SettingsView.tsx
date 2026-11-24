import { Download, Plus, Trash2, Upload } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { ACTIVE_GEMINI_MODELS } from '../data/tacticalCatalog';
import { desktopBridge } from '../services/desktopBridge';
import type { TacticalCatalogItem } from '../types/domain';

type SettingsTab = 'capture' | 'ai' | 'catalog' | 'database';

const CATALOG_CATEGORY_LABELS: Record<TacticalCatalogItem['category'], string> = {
  formation: 'Formations',
  build_up: 'Build-Up Styles',
  defensive_approach: 'Defensive Approaches',
  player_role: 'Player Roles',
  player_focus: 'Player Focuses',
};

export function SettingsView() {
  const { settings, systemStatus, tacticalCatalog, usageLogs, refreshAll, notify } = useApp();
  const [tab, setTab] = useState<SettingsTab>('capture');

  // Local editable state for capture & AI settings
  const [captureDraft, setCaptureDraft] = useState(settings?.capture ?? null);
  const [aiDraft, setAiDraft] = useState(settings?.ai ?? null);
  const [saving, setSaving] = useState(false);

  // Tactical catalog creation state
  const [catalogCategory, setCatalogCategory] =
    useState<TacticalCatalogItem['category']>('formation');
  const [catalogName, setCatalogName] = useState('');
  const [catalogDesc, setCatalogDesc] = useState('');

  // Danger zone explicit delete confirmation
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const effectiveCapture = captureDraft ?? settings?.capture;
  const effectiveAi = aiDraft ?? settings?.ai;

  async function handleSaveCapture(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveCapture) return;
    setSaving(true);
    try {
      await desktopBridge.updateSettings({ capture: effectiveCapture });
      await refreshAll();
      notify('success', 'Capture and local storage settings saved.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save capture settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAi(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveAi) return;
    setSaving(true);
    try {
      await desktopBridge.updateSettings({ ai: effectiveAi });
      await refreshAll();
      notify('success', 'AI model and evidence policy saved.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save AI settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleAddCatalogItem(e: React.FormEvent) {
    e.preventDefault();
    if (!catalogName.trim()) {
      notify('error', 'Option name is required.');
      return;
    }
    try {
      await desktopBridge.createTacticalCatalogItem({
        category: catalogCategory,
        name: catalogName,
        description: catalogDesc,
      });
      setCatalogName('');
      setCatalogDesc('');
      await refreshAll();
      notify('success', `Added "${catalogName}" to FC26 Tactical Catalog.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to add catalog item');
    }
  }

  async function handleDeleteCatalogItem(id: string) {
    try {
      await desktopBridge.deleteTacticalCatalogItem(id);
      await refreshAll();
      notify('info', 'Removed tactical catalog entry.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to remove item');
    }
  }

  async function handleExportBackup() {
    try {
      const blob = await desktopBridge.exportBackup();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fc26-ai-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify('success', 'Database backup exported.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to export backup');
    }
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      await desktopBridge.restoreBackup(parsed);
      await refreshAll();
      notify('success', 'Database backup restored successfully.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Invalid backup file');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDeleteAllData() {
    if (deleteConfirmText !== 'DELETE') {
      notify('error', 'Type DELETE in uppercase to confirm wiping all local data.');
      return;
    }
    try {
      await desktopBridge.deleteAllData();
      setDeleteConfirmText('');
      await refreshAll();
      notify('info', 'All local application data has been permanently cleared.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to clear data');
    }
  }

  return (
    <div className="space-y-7">
      <div className="border-b border-white/[0.08] pb-5">
        <h1 className="text-[24px] font-bold text-white tracking-tight">Application Settings</h1>
        <p className="mt-1 text-[14px] text-[#9AA4B4]">
          Configure local video capture, Gemini model preferences, editable FC26 tactical options,
          and SQLite backup controls.
        </p>
      </div>

      {/* Tab Bar */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-[#12151B] border border-white/[0.1] rounded-md w-fit">
        {(
          [
            ['capture', 'Capture & Storage'],
            ['ai', 'AI & Evidence Policy'],
            ['catalog', 'FC26 Tactical Catalog'],
            ['database', 'Database & Privacy'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-3.5 py-1.5 rounded text-[13px] font-medium transition-colors whitespace-nowrap ${
              tab === id ? 'bg-emerald-600 text-white' : 'text-[#9AA4B4] hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* TAB 1: Capture & Storage */}
      {tab === 'capture' && effectiveCapture && (
        <form
          onSubmit={(e) => void handleSaveCapture(e)}
          className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-5 max-w-4xl"
        >
          <h2 className="text-[16px] font-semibold text-white">Local Recording Configuration</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[13px]">
            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">Primary Resolution</label>
              <select
                value={effectiveCapture.resolution}
                onChange={(e) =>
                  setCaptureDraft({
                    ...effectiveCapture,
                    resolution: e.target.value as '1920x1080' | '1280x720',
                  })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono"
              >
                <option value="1920x1080">1920×1080 (Full HD)</option>
                <option value="1280x720">1280×720 (HD Fallback)</option>
              </select>
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Capture Frame Rate (FPS)
              </label>
              <input
                type="number"
                min={5}
                max={60}
                value={effectiveCapture.fps}
                onChange={(e) =>
                  setCaptureDraft({ ...effectiveCapture, fps: Number(e.target.value) })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono tabular-nums"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Video Bitrate (kbps)
              </label>
              <input
                type="number"
                min={1000}
                max={20000}
                step={250}
                value={effectiveCapture.bitrateKbps}
                onChange={(e) =>
                  setCaptureDraft({ ...effectiveCapture, bitrateKbps: Number(e.target.value) })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono tabular-nums"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Automatic Segment Duration (2–5 Minutes)
              </label>
              <select
                value={effectiveCapture.segmentDurationMinutes}
                onChange={(e) =>
                  setCaptureDraft({
                    ...effectiveCapture,
                    segmentDurationMinutes: Number(e.target.value),
                  })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono tabular-nums"
              >
                <option value={2}>2 minutes</option>
                <option value={3}>3 minutes (Recommended)</option>
                <option value={4}>4 minutes</option>
                <option value={5}>5 minutes</option>
              </select>
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Maximum Session Duration (Minutes)
              </label>
              <input
                type="number"
                min={5}
                max={120}
                value={effectiveCapture.maxRecordingMinutes}
                onChange={(e) =>
                  setCaptureDraft({
                    ...effectiveCapture,
                    maxRecordingMinutes: Number(e.target.value),
                  })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono tabular-nums"
              />
            </div>

            <div>
              <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                Local Windows Storage Path
              </label>
              <input
                type="text"
                value={effectiveCapture.storageDirectory}
                onChange={(e) =>
                  setCaptureDraft({ ...effectiveCapture, storageDirectory: e.target.value })
                }
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono text-[12px]"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-white/[0.08] space-y-2.5 text-[13px]">
            <label className="flex items-center gap-2.5 cursor-pointer text-[#D7DDE7]">
              <input
                type="checkbox"
                checked={effectiveCapture.audioEnabled}
                onChange={(e) =>
                  setCaptureDraft({ ...effectiveCapture, audioEnabled: e.target.checked })
                }
                className="accent-emerald-500"
              />
              Record Game Audio (Disabled by default to minimize file size)
            </label>

            <label className="flex items-center gap-2.5 cursor-pointer text-[#D7DDE7]">
              <input
                type="checkbox"
                checked={effectiveCapture.autoRecoveryEnabled}
                onChange={(e) =>
                  setCaptureDraft({ ...effectiveCapture, autoRecoveryEnabled: e.target.checked })
                }
                className="accent-emerald-500"
              />
              Persist segment manifests automatically for crash recovery
            </label>

            <div className="text-[12px] text-[#8A94A6]">
              Privacy lock: Microphone recording is permanently disabled across all versions.
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
            >
              Save Capture Settings
            </button>
          </div>
        </form>
      )}

      {/* TAB 2: AI & Evidence Policy */}
      {tab === 'ai' && effectiveAi && (
        <div className="space-y-6 max-w-4xl">
          <form
            onSubmit={(e) => void handleSaveAi(e)}
            className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-white">
                Gemini Model & Evidence Pipeline Policy
              </h2>
              <span className="text-[12px] text-[#8A94A6]">
                Server-side @google/genai · Credentials managed outside renderer
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[13px]">
              <div className="md:col-span-2">
                <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                  Selected Gemini Model Identifier
                </label>
                <select
                  value={effectiveAi.modelId}
                  onChange={(e) => setAiDraft({ ...effectiveAi, modelId: e.target.value })}
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                >
                  {ACTIVE_GEMINI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[12px] text-[#8A94A6]">
                  Model identifier is configurable without rewriting the application. Credentials
                  are supplied exclusively via server environment secrets or Electron safeStorage.
                </p>
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                  Evidence Analysis Quality
                </label>
                <select
                  value={effectiveAi.analysisQuality}
                  onChange={(e) =>
                    setAiDraft({
                      ...effectiveAi,
                      analysisQuality: e.target.value as 'balanced' | 'detailed' | 'compact',
                    })
                  }
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                >
                  <option value="compact">Compact (Lowest Token Usage)</option>
                  <option value="balanced">Balanced (Recommended)</option>
                  <option value="detailed">Detailed (Higher Event Frame Density)</option>
                </select>
              </div>

              <div>
                <label className="block text-[12px] text-[#9AA4B4] mb-1.5">
                  Maximum Evidence Frames per Half (6–60)
                </label>
                <input
                  type="number"
                  min={6}
                  max={60}
                  value={effectiveAi.maxEvidenceFrames}
                  onChange={(e) =>
                    setAiDraft({ ...effectiveAi, maxEvidenceFrames: Number(e.target.value) })
                  }
                  className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white font-mono tabular-nums"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-white/[0.08] space-y-2.5 text-[13px] text-[#D7DDE7]">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={effectiveAi.removeDuplicateFrames}
                  onChange={(e) =>
                    setAiDraft({ ...effectiveAi, removeDuplicateFrames: e.target.checked })
                  }
                  className="accent-emerald-500"
                />
                Deduplicate static pause/menu frames before sending evidence
              </label>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={effectiveAi.requireUploadConfirmation}
                  onChange={(e) =>
                    setAiDraft({ ...effectiveAi, requireUploadConfirmation: e.target.checked })
                  }
                  className="accent-emerald-500"
                />
                Require explicit manual confirmation before uploading half-time evidence
              </label>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={effectiveAi.deleteRemoteAfterAnalysis}
                  onChange={(e) =>
                    setAiDraft({ ...effectiveAi, deleteRemoteAfterAnalysis: e.target.checked })
                  }
                  className="accent-emerald-500"
                />
                Delete temporary remote uploaded files immediately after analysis (keep local copy)
              </label>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium"
              >
                Save AI Policy
              </button>
            </div>
          </form>

          {/* API Usage Logs */}
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5">
            <h3 className="text-[15px] font-semibold text-white mb-3">API Request Usage Log</h3>
            {usageLogs.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-white/[0.08] text-[#7D8798]">
                      <th className="py-2 pr-3 font-medium">Timestamp</th>
                      <th className="py-2 pr-3 font-medium">Model</th>
                      <th className="py-2 pr-3 font-medium">Stage</th>
                      <th className="py-2 pr-3 font-medium text-right">Tokens (In/Out)</th>
                      <th className="py-2 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {usageLogs.map((l) => (
                      <tr key={l.id}>
                        <td className="py-2 pr-3 font-mono tabular-nums text-[#9AA4B4]">
                          {l.createdAt.slice(0, 19).replace('T', ' ')}
                        </td>
                        <td className="py-2 pr-3 text-white font-mono">{l.modelId}</td>
                        <td className="py-2 pr-3 text-[#C5CCD7]">{l.stage}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums text-[#C5CCD7]">
                          {l.inputTokens} / {l.outputTokens}
                        </td>
                        <td className="py-2 text-right capitalize text-white">{l.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-[13px] text-[#8A94A6]">
                No Gemini analysis requests logged yet. Usage tracking activates automatically when
                half-time evidence is submitted in Phase 3.
              </p>
            )}
          </section>
        </div>
      )}

      {/* TAB 3: Editable FC26 Tactical Catalog */}
      {tab === 'catalog' && (
        <div className="space-y-6 max-w-5xl">
          <form
            onSubmit={(e) => void handleAddCatalogItem(e)}
            className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-4"
          >
            <div>
              <h2 className="text-[16px] font-semibold text-white">
                Add Custom FC26 Tactical Parameter
              </h2>
              <p className="text-[12px] text-[#8A94A6] mt-0.5">
                Keep formations, build-up styles, defensive approaches, player roles, and focuses
                aligned with your exact FC26 version without hardcoded limitations.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[13px]">
              <select
                value={catalogCategory}
                onChange={(e) =>
                  setCatalogCategory(e.target.value as TacticalCatalogItem['category'])
                }
                className="bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
              >
                {Object.entries(CATALOG_CATEGORY_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                required
                value={catalogName}
                onChange={(e) => setCatalogName(e.target.value)}
                placeholder="Option name (e.g. 4-3-2-1, Half-Winger)"
                className="bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  value={catalogDesc}
                  onChange={(e) => setCatalogDesc(e.target.value)}
                  placeholder="Short tactical description"
                  className="flex-1 bg-[#0C0F14] border border-white/[0.12] rounded-md px-3 py-2 text-white"
                />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 px-3.5 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  Add
                </button>
              </div>
            </div>
          </form>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {(Object.keys(CATALOG_CATEGORY_LABELS) as TacticalCatalogItem['category'][]).map(
              (cat) => {
                const items = tacticalCatalog.filter((c) => c.category === cat);
                return (
                  <section
                    key={cat}
                    className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="text-[15px] font-semibold text-white">
                        {CATALOG_CATEGORY_LABELS[cat]}
                      </h3>
                      <span className="text-[12px] font-mono tabular-nums text-[#8A94A6]">
                        {items.length} options
                      </span>
                    </div>
                    <div className="divide-y divide-white/[0.06] max-h-64 overflow-y-auto pr-1">
                      {items.map((item) => (
                        <div
                          key={item.id}
                          className="py-2 flex items-start justify-between gap-2 text-[12px]"
                        >
                          <div>
                            <div className="text-white font-medium">{item.name}</div>
                            {item.description && (
                              <div className="text-[#8A94A6] mt-0.5">{item.description}</div>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleDeleteCatalogItem(item.id)}
                            aria-label={`Delete ${item.name}`}
                            className="p-1 rounded hover:bg-red-500/10 text-[#7D8798] hover:text-red-400 shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              }
            )}
          </div>
        </div>
      )}

      {/* TAB 4: Database & Privacy */}
      {tab === 'database' && (
        <div className="space-y-6 max-w-4xl">
          <section className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 space-y-5">
            <div>
              <h2 className="text-[16px] font-semibold text-white">Local SQLite Database</h2>
              <p className="text-[12px] text-[#8A94A6] mt-1">
                All Career Mode clubs, squads, matches, reports, and tactical memory are stored
                locally with zero automatic cloud backup.
              </p>
            </div>

            {systemStatus && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
                <div className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3">
                  <div className="text-[#7D8798]">Database File</div>
                  <div className="mt-1 font-mono text-white truncate">
                    {systemStatus.database.dbFileName}
                  </div>
                </div>
                <div className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3">
                  <div className="text-[#7D8798]">Schema Version</div>
                  <div className="mt-1 font-mono tabular-nums text-white">
                    v{systemStatus.database.schemaVersion}
                  </div>
                </div>
                <div className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3">
                  <div className="text-[#7D8798]">File Size</div>
                  <div className="mt-1 font-mono tabular-nums text-white">
                    {(systemStatus.database.sizeBytes / 1024).toFixed(1)} KB
                  </div>
                </div>
                <div className="border border-white/[0.07] bg-[#0E1116] rounded-md p-3">
                  <div className="text-[#7D8798]">Normalized Tables</div>
                  <div className="mt-1 font-mono tabular-nums text-white">
                    {Object.keys(systemStatus.database.tableCounts).length}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-white/[0.08]">
              <button
                type="button"
                onClick={() => void handleExportBackup()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-white/[0.14] hover:border-emerald-500/60 text-[13px] text-white font-medium"
              >
                <Download className="w-4 h-4" />
                Export Database Backup (.json)
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                onChange={(e) => void handleRestoreFile(e)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-white/[0.14] hover:border-white/[0.3] text-[13px] text-[#D7DDE7] font-medium"
              >
                <Upload className="w-4 h-4" />
                Restore From Backup
              </button>
            </div>
          </section>

          {/* Explicit Deletion Control */}
          <section className="border border-red-500/25 bg-[#161113] rounded-lg p-6 space-y-4">
            <div>
              <h2 className="text-[16px] font-semibold text-red-200">
                Delete All Application Data
              </h2>
              <p className="text-[13px] text-[#C5B4B8] mt-1">
                Permanently deletes all saved Career Mode clubs, squad players, matches, tactical
                memory, and reports from the local SQLite database. Type{' '}
                <code className="font-mono text-white">DELETE</code> below to authorize.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="Type DELETE to confirm"
                className="bg-[#0C0F14] border border-red-500/30 rounded-md px-3 py-2 text-[13px] text-white font-mono"
              />
              <button
                type="button"
                disabled={deleteConfirmText !== 'DELETE'}
                onClick={() => void handleDeleteAllData()}
                className="px-4 py-2 rounded-md bg-red-600 hover:bg-red-500 disabled:bg-red-950/60 disabled:text-red-300/40 text-white text-[13px] font-medium"
              >
                Delete All Data
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
