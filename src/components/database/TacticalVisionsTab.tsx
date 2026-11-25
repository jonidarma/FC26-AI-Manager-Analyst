import { AlertTriangle, CheckCircle2, Info, Search, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TacticalVisionCatalogResponse, TacticalVisionKey } from '../../types/domain';

interface TacticalVisionsTabProps {
  catalog: TacticalVisionCatalogResponse | null;
}

interface RoleMatrixRow {
  positionCode: string;
  roleName: string;
  associatedVisionKeys: TacticalVisionKey[];
}

export function TacticalVisionsTab({ catalog }: TacticalVisionsTabProps) {
  const [selectedVisionKey, setSelectedVisionKey] = useState<TacticalVisionKey | 'all'>('all');
  const [positionFilter, setPositionFilter] = useState('');
  const [roleSearch, setRoleSearch] = useState('');

  const matrixRows = useMemo<RoleMatrixRow[]>(() => {
    if (!catalog) return [];
    const grouped = new Map<string, RoleMatrixRow>();
    for (const row of catalog.roleAffinities) {
      const key = `${row.positionCode}::${row.roleName}`;
      const existing = grouped.get(key) ?? {
        positionCode: row.positionCode,
        roleName: row.roleName,
        associatedVisionKeys: [],
      };
      if (
        row.affinityStatus === 'associated' &&
        !existing.associatedVisionKeys.includes(row.visionKey)
      ) {
        existing.associatedVisionKeys.push(row.visionKey);
      }
      grouped.set(key, existing);
    }
    return Array.from(grouped.values()).sort((a, b) =>
      a.positionCode === b.positionCode
        ? a.roleName.localeCompare(b.roleName)
        : a.positionCode.localeCompare(b.positionCode)
    );
  }, [catalog]);

  const filteredMatrix = useMemo(() => {
    const q = roleSearch.trim().toLowerCase();
    return matrixRows.filter((row) => {
      if (positionFilter && row.positionCode !== positionFilter) return false;
      if (
        selectedVisionKey !== 'all' &&
        !row.associatedVisionKeys.includes(selectedVisionKey)
      ) {
        return false;
      }
      if (
        q &&
        !row.roleName.toLowerCase().includes(q) &&
        !row.positionCode.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [matrixRows, positionFilter, roleSearch, selectedVisionKey]);

  const distinctPositions = useMemo(() => {
    return [...new Set(matrixRows.map((r) => r.positionCode))];
  }, [matrixRows]);

  const conflictResolutions = useMemo(() => {
    if (!catalog) return [];
    return catalog.sources.flatMap((src) =>
      src.conflictResolutions.map((cr) => ({
        sourceTitle: src.title,
        ...cr,
      }))
    );
  }, [catalog]);

  if (!catalog) {
    return (
      <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-6 text-[13px] text-[#9AA4B4]">
        Loading EA SPORTS FC 26 Tactical Visions catalog...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Architecture & Truthfulness Notice */}
      <div className="border border-emerald-500/25 bg-emerald-500/[0.04] rounded-lg p-4 flex items-start gap-3">
        <Info className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <div className="text-[12px] text-[#C8D1DF] space-y-1">
          <div className="font-semibold text-white">
            EA SPORTS FC 26 Tactical Vision Catalog ({catalog.datasetVersion} ·{' '}
            {catalog.visions.length} Visions · {matrixRows.length} Role Matrix Rows)
          </div>
          <p>
            Official Layer 2 Tactical Vision requirements (Build-Up Style &amp; Defensive Approach)
            are enforced distinctly from Layer 1 FC IQ role/position legality. Layer 3 Role
            Affinities are strictly advisory — any legal FC 26 role remains selectable under any
            Tactical Vision.
          </p>
        </div>
      </div>

      {/* 7 Tactical Visions Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {catalog.visions.map((vision) => {
          const isActive = selectedVisionKey === vision.internalKey;
          const associatedRolesCount = matrixRows.filter((r) =>
            r.associatedVisionKeys.includes(vision.internalKey)
          ).length;
          const buildUpReq = vision.officialRequirements.find(
            (r) => r.parameterType === 'build_up_style'
          );
          const defReq = vision.officialRequirements.find(
            (r) => r.parameterType === 'defensive_approach'
          );
          const refBuildUps = catalog.settingAffinities
            .filter(
              (s) =>
                s.visionKey === vision.internalKey &&
                s.settingType === 'build_up_style' &&
                s.isAssociated
            )
            .map((s) => s.settingValue);
          const refDefHeights = catalog.settingAffinities
            .filter(
              (s) =>
                s.visionKey === vision.internalKey &&
                s.settingType === 'defensive_height' &&
                s.isAssociated
            )
            .map((s) => s.settingValue);
          const hasOfficialConflict = catalog.settingAffinities.some(
            (s) => s.visionKey === vision.internalKey && s.conflictWithOfficial
          );

          return (
            <div
              key={vision.internalKey}
              onClick={() =>
                setSelectedVisionKey((prev) =>
                  prev === vision.internalKey ? 'all' : vision.internalKey
                )
              }
              className={`cursor-pointer rounded-lg border p-4 space-y-3 transition-colors ${
                isActive
                  ? 'border-emerald-500 bg-emerald-500/[0.08]'
                  : 'border-white/[0.08] bg-[#12151B] hover:border-white/[0.2]'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[15px] font-semibold text-white">
                    {vision.displayName}
                  </div>
                  <div className="text-[11px] font-mono text-[#7D8798] mt-0.5">
                    key: {vision.internalKey}
                    {vision.aliases.length > 0 &&
                      ` · aliases: ${vision.aliases.map((a) => a.aliasLabel).join(', ')}`}
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded bg-[#0C0F14] border border-white/[0.1] text-[10px] font-mono text-emerald-300">
                  {associatedRolesCount} roles
                </span>
              </div>

              <p className="text-[12px] text-[#A8B2C2] leading-relaxed">{vision.description}</p>

              {/* Layer 2 Official Requirements */}
              <div className="rounded bg-[#0C0F14] border border-white/[0.07] p-2.5 space-y-1 text-[11px]">
                <div className="text-[10px] uppercase tracking-wider text-emerald-400 font-semibold flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" />
                  Official FC 26 Layer 2 Requirements
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#8A94A6]">Build-Up Style:</span>
                  <span className="text-white font-mono">
                    {buildUpReq ? buildUpReq.allowedValues.join(' or ') : 'Any (No strict lock)'}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#8A94A6]">Defensive Approach:</span>
                  <span className="text-white font-mono">
                    {defReq ? defReq.allowedValues.join(' or ') : 'Any (No strict lock)'}
                  </span>
                </div>
                {(buildUpReq?.conflictNotes || defReq?.conflictNotes) && (
                  <div className="text-[10px] text-[#7D8798] pt-0.5">
                    {buildUpReq?.conflictNotes || defReq?.conflictNotes}
                  </div>
                )}
              </div>

              {/* Reference Affinities + Conflict Note */}
              <div className="text-[11px] space-y-1">
                <div className="text-[#8A94A6]">
                  Reference Build-Up:{' '}
                  <span className="text-[#D7DDE7] font-mono">
                    {refBuildUps.join(', ') || '—'}
                  </span>
                </div>
                <div className="text-[#8A94A6]">
                  Reference Defensive Height:{' '}
                  <span className="text-[#D7DDE7] font-mono">
                    {refDefHeights.join(', ') || '—'}
                  </span>
                </div>
                {hasOfficialConflict && (
                  <div className="flex items-start gap-1.5 text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2 mt-1">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>
                      Reference guide diverges from official FC 26 Layer 2 requirement; official
                      requirement takes precedence.
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 37-Row Role Affinity Matrix */}
      <div className="border border-white/[0.08] bg-[#12151B] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-white">
              Tactical Vision × FC IQ Role Affinity Matrix ({filteredMatrix.length} /{' '}
              {matrixRows.length})
            </h2>
            <p className="text-[12px] text-[#8A94A6] mt-0.5">
              Advisory matrix showing which Tactical Visions associate with each FC 26 role. Roles
              outside a vision remain 100% legal in FC 26.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedVisionKey}
              onChange={(e) =>
                setSelectedVisionKey(e.target.value as TacticalVisionKey | 'all')
              }
              className="bg-[#0C0F14] border border-white/[0.12] rounded-md px-2.5 py-1.5 text-[12px] text-white"
            >
              <option value="all">All 7 Tactical Visions</option>
              {catalog.visions.map((v) => (
                <option key={v.internalKey} value={v.internalKey}>
                  {v.displayName}
                </option>
              ))}
            </select>
            <select
              value={positionFilter}
              onChange={(e) => setPositionFilter(e.target.value)}
              className="bg-[#0C0F14] border border-white/[0.12] rounded-md px-2.5 py-1.5 text-[12px] text-white"
            >
              <option value="">All Positions</option>
              {distinctPositions.map((pos) => (
                <option key={pos} value={pos}>
                  {pos}
                </option>
              ))}
            </select>
            <div className="relative w-48">
              <Search className="w-3.5 h-3.5 text-[#7D8798] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={roleSearch}
                onChange={(e) => setRoleSearch(e.target.value)}
                placeholder="Search role..."
                className="w-full bg-[#0C0F14] border border-white/[0.12] rounded-md pl-7 pr-2.5 py-1.5 text-[12px] text-white"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-[#161A22] border-b border-white/[0.08] text-[#8A94A6]">
              <tr>
                <th className="px-4 py-2.5 font-medium">Pos</th>
                <th className="px-4 py-2.5 font-medium">FC IQ Role</th>
                {catalog.visions.map((v) => (
                  <th key={v.internalKey} className="px-2.5 py-2.5 font-medium text-center">
                    {v.displayName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {filteredMatrix.map((row) => (
                <tr key={`${row.positionCode}:${row.roleName}`} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-2 font-mono font-semibold text-white">
                    {row.positionCode}
                  </td>
                  <td className="px-4 py-2 text-[#E5E9F0]">{row.roleName}</td>
                  {catalog.visions.map((v) => {
                    const associated = row.associatedVisionKeys.includes(v.internalKey);
                    return (
                      <td key={v.internalKey} className="px-2.5 py-2 text-center">
                        {associated ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 inline-block" />
                        ) : (
                          <span className="text-[#454D5C]">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Provenance & Conflict Resolution Audit */}
      {conflictResolutions.length > 0 && (
        <div className="border border-white/[0.08] bg-[#12151B] rounded-lg p-5 space-y-3">
          <h3 className="text-[14px] font-semibold text-white">
            Reference Dataset Conflict Resolutions &amp; Provenance
          </h3>
          <div className="space-y-2 text-[12px]">
            {conflictResolutions.map((c, idx) => (
              <div
                key={idx}
                className="rounded border border-white/[0.07] bg-[#0C0F14] p-3 space-y-1"
              >
                <div className="font-mono text-amber-300">
                  {c.topic} · {c.sourceTitle}
                </div>
                <div className="text-[#D7DDE7]">{c.resolution}</div>
                <div className="text-[11px] text-[#8A94A6]">Conflict: {c.conflict}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
