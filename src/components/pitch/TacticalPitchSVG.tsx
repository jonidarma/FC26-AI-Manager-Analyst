import { getFormationPositions } from '../../data/tacticalCatalog';
import { getDisplayPositionLabel, getSlotSideHint } from '../../utils/formationPositions';
import {
  hasDistinctFullName,
  resolvePlayerDisplayName,
  resolvePlayerFullName,
} from '../../utils/playerDisplayName';
import type {
  CatalogFormationSlot,
  PitchNodePosition,
  Player,
  PlayerRoleAssignment,
} from '../../types/domain';

interface TacticalPitchSVGProps {
  formation: string;
  formationSlots?: CatalogFormationSlot[];
  layoutVerified?: boolean;
  isUserAdjusted?: boolean;
  defensiveLineHeight?: number;
  assignments?: PlayerRoleAssignment[];
  players?: Player[];
  showAttackingChannels?: boolean;
  showDefensiveZones?: boolean;
  showPressingAreas?: boolean;
  showMovementArrows?: boolean;
  label?: string;
  variant?: 'current' | 'recommended';
  compact?: boolean;
  selectedSlotOrder?: number | null;
  onSelectSlot?: (slotOrder: number) => void;
}

export function TacticalPitchSVG({
  formation,
  formationSlots,
  layoutVerified = true,
  isUserAdjusted = false,
  defensiveLineHeight = 50,
  assignments = [],
  players = [],
  showAttackingChannels = true,
  showDefensiveZones = true,
  showPressingAreas = false,
  showMovementArrows = true,
  label,
  variant = 'current',
  compact = false,
  selectedSlotOrder = null,
  onSelectSlot,
}: TacticalPitchSVGProps) {
  const baseNodes: PitchNodePosition[] =
    formationSlots && formationSlots.length === 11
      ? formationSlots.map((slot) => ({
          slotIndex: slot.slotOrder,
          slotId: slot.slotId,
          positionCode: getDisplayPositionLabel(slot.positionCode),
          positionLabel: getDisplayPositionLabel(slot.positionCode),
          x: slot.x,
          y: slot.y,
          defaultRole: '',
          defaultFocus: '',
          isUserAdjusted: slot.isUserAdjusted,
        }))
      : getFormationPositions(formation);
  const playerById = new Map(players.map((p) => [p.id, p]));

  // Map defensive line height (1-100) to pitch Y coordinate (higher line moves toward top)
  const lineY = Math.max(36, Math.min(82, 84 - defensiveLineHeight * 0.44));

  const accentStroke = variant === 'recommended' ? '#34D399' : '#10B981';
  const nodeFill = variant === 'recommended' ? '#065F46' : '#161C24';
  const nodeStroke = variant === 'recommended' ? '#34D399' : '#10B981';

  const layoutStatusText = isUserAdjusted
    ? 'User Adjusted Layout'
    : formationSlots && formationSlots.length === 11
      ? layoutVerified
        ? 'Verified Catalog Layout'
        : 'Unverified Layout'
      : 'Reference Fallback Layout';

  return (
    <div className="w-full">
      {label && (
        <div className="flex items-center justify-between mb-2 text-[12px] text-[#9AA4B4]">
          <span className="font-medium text-[#E5E9F0]">{label}</span>
          <span className="font-mono tabular-nums">
            {formation} · Line {defensiveLineHeight} · {layoutStatusText}
          </span>
        </div>
      )}

      <div className="w-full rounded-lg border border-white/[0.08] bg-[#0D1412] overflow-hidden">
        <svg
          viewBox="0 0 100 138"
          className={`w-full block ${compact ? 'max-h-[380px]' : 'max-h-[540px]'}`}
          role="img"
          aria-label={`Football pitch tactical formation ${formation}`}
        >
          <defs>
            <pattern id={`pitch-stripes-${variant}`} width="100" height="14" patternUnits="userSpaceOnUse">
              <rect width="100" height="7" fill="#0F1A15" />
              <rect y="7" width="100" height="7" fill="#121F19" />
            </pattern>
            <marker
              id={`arrow-${variant}`}
              viewBox="0 0 10 10"
              refX="7"
              refY="5"
              markerWidth="4"
              markerHeight="4"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill={accentStroke} fillOpacity="0.85" />
            </marker>
          </defs>

          {/* Grass surface */}
          <rect x="0" y="0" width="100" height="138" fill={`url(#pitch-stripes-${variant})`} />

          {/* Pitch markings */}
          <g stroke="#2B4237" strokeWidth="0.45" fill="none">
            <rect x="4" y="5" width="92" height="128" />
            {/* Halfway line */}
            <line x1="4" y1="69" x2="96" y2="69" />
            <circle cx="50" cy="69" r="11" />
            <circle cx="50" cy="69" r="0.6" fill="#2B4237" />
            {/* Opponent penalty area (top) */}
            <rect x="22" y="5" width="56" height="19" />
            <rect x="35" y="5" width="30" height="7" />
            <path d="M 39 24 A 11 11 0 0 0 61 24" />
            {/* Own penalty area (bottom) */}
            <rect x="22" y="114" width="56" height="19" />
            <rect x="35" y="126" width="30" height="7" />
            <path d="M 39 114 A 11 11 0 0 1 61 114" />
          </g>

          {/* Vertical five-channel reference lines (half-spaces) */}
          <g stroke="#22362C" strokeWidth="0.25" strokeDasharray="1.5 2">
            <line x1="22" y1="5" x2="22" y2="133" />
            <line x1="37" y1="5" x2="37" y2="133" />
            <line x1="63" y1="5" x2="63" y2="133" />
            <line x1="78" y1="5" x2="78" y2="133" />
          </g>

          {/* Defensive zone & line overlay */}
          {showDefensiveZones && (
            <g>
              <rect
                x="4"
                y={lineY * 1.3}
                width="92"
                height={Math.max(8, 133 - lineY * 1.3)}
                fill="#10B981"
                fillOpacity="0.06"
              />
              <line
                x1="4"
                y1={lineY * 1.3}
                x2="96"
                y2={lineY * 1.3}
                stroke="#10B981"
                strokeOpacity="0.45"
                strokeWidth="0.55"
                strokeDasharray="2.5 1.8"
              />
              <text
                x="6"
                y={lineY * 1.3 - 1.4}
                fill="#6EE7B7"
                fillOpacity="0.7"
                fontSize="2.3"
                fontFamily="JetBrains Mono, monospace"
              >
                DEF LINE {defensiveLineHeight}
              </text>
            </g>
          )}

          {/* Pressing trigger zones */}
          {showPressingAreas && (
            <g>
              <rect
                x="6"
                y="18"
                width="26"
                height="24"
                rx="2"
                fill="#D97706"
                fillOpacity="0.11"
                stroke="#D97706"
                strokeOpacity="0.45"
                strokeWidth="0.4"
                strokeDasharray="1.6 1.2"
              />
              <rect
                x="68"
                y="18"
                width="26"
                height="24"
                rx="2"
                fill="#D97706"
                fillOpacity="0.11"
                stroke="#D97706"
                strokeOpacity="0.45"
                strokeWidth="0.4"
                strokeDasharray="1.6 1.2"
              />
              <text
                x="19"
                y="21.5"
                textAnchor="middle"
                fill="#FCD34D"
                fontSize="2.1"
                fontFamily="JetBrains Mono, monospace"
              >
                PRESS TRAP
              </text>
              <text
                x="81"
                y="21.5"
                textAnchor="middle"
                fill="#FCD34D"
                fontSize="2.1"
                fontFamily="JetBrains Mono, monospace"
              >
                PRESS TRAP
              </text>
            </g>
          )}

          {/* Attacking progression arrows */}
          {showAttackingChannels && (
            <g opacity="0.65">
              <line
                x1="29.5"
                y1="56"
                x2="29.5"
                y2="29"
                stroke={accentStroke}
                strokeWidth="0.55"
                markerEnd={`url(#arrow-${variant})`}
              />
              <line
                x1="70.5"
                y1="56"
                x2="70.5"
                y2="29"
                stroke={accentStroke}
                strokeWidth="0.55"
                markerEnd={`url(#arrow-${variant})`}
              />
            </g>
          )}

          {/* Player nodes */}
          {baseNodes.map((node) => {
            const assignment = assignments.find((a) => a.slotIndex === node.slotIndex);
            const assignedPlayer =
              assignment?.playerId ? playerById.get(assignment.playerId) : undefined;
            const displayName = assignedPlayer
              ? resolvePlayerDisplayName(assignedPlayer)
              : assignment?.playerName?.trim() || null;
            const fullName = assignedPlayer ? resolvePlayerFullName(assignedPlayer) : displayName;
            const roleLabel = assignment?.role || node.defaultRole;
            const focusLabel = assignment?.focus || node.defaultFocus;
            const isVerifiedPlayer = Boolean(displayName);

            const cx = node.x;
            const cy = 6 + (node.y / 100) * 124;

            // Movement vector based on focus
            const hasForwardRun =
              showMovementArrows &&
              node.positionCode !== 'GK' &&
              (focusLabel === 'Attack' || focusLabel === 'Roaming');

            const isSelected = selectedSlotOrder === node.slotIndex;
            const labelFontSize =
              displayName && displayName.length > 16
                ? '1.85'
                : displayName && displayName.length > 12
                  ? '2.05'
                  : '2.3';

            return (
              <g
                key={`${formation}-${node.slotIndex}`}
                onClick={onSelectSlot ? () => onSelectSlot(node.slotIndex) : undefined}
                className={onSelectSlot ? 'cursor-pointer' : undefined}
              >
                {(() => {
                  const canonicalPos = getDisplayPositionLabel(node.positionCode);
                  const sideHint = getSlotSideHint(node.slotId, canonicalPos);
                  const posTitle = sideHint ? `${canonicalPos} (${sideHint})` : canonicalPos;
                  return displayName && fullName ? (
                    <title>
                      {hasDistinctFullName(displayName, fullName)
                        ? `${displayName} (${fullName}) · ${posTitle}${roleLabel ? ` · ${roleLabel}` : ''}`
                        : `${displayName} · ${posTitle}${roleLabel ? ` · ${roleLabel}` : ''}`}
                    </title>
                  ) : (
                    <title>{`${posTitle} · Unassigned`}</title>
                  );
                })()}

                {hasForwardRun && (
                  <line
                    x1={cx}
                    y1={cy - 4.2}
                    x2={cx}
                    y2={Math.max(10, cy - 13)}
                    stroke={accentStroke}
                    strokeWidth="0.5"
                    strokeDasharray="1.4 1"
                    markerEnd={`url(#arrow-${variant})`}
                  />
                )}

                {isSelected && (
                  <circle
                    cx={cx}
                    cy={cy}
                    r="5.3"
                    fill="none"
                    stroke="#FBBF24"
                    strokeWidth="0.65"
                  />
                )}

                <circle
                  cx={cx}
                  cy={cy}
                  r="3.8"
                  fill={isVerifiedPlayer ? nodeFill : '#11161D'}
                  stroke={isSelected ? '#FBBF24' : isVerifiedPlayer ? nodeStroke : '#64748B'}
                  strokeWidth={isVerifiedPlayer || isSelected ? '0.75' : '0.55'}
                  strokeDasharray={isVerifiedPlayer ? undefined : '1.3 0.9'}
                />

                <text
                  x={cx}
                  y={cy + 0.9}
                  textAnchor="middle"
                  fill="#F8FAFC"
                  fontSize="2.2"
                  fontWeight="600"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {getDisplayPositionLabel(node.positionCode)}
                </text>

                <text
                  x={cx}
                  y={cy + 6.9}
                  textAnchor="middle"
                  fill={isVerifiedPlayer ? '#F1F5F9' : '#94A3B8'}
                  fontSize={labelFontSize}
                  fontWeight={isVerifiedPlayer ? '600' : '400'}
                >
                  {displayName ?? 'Unassigned'}
                </text>

                {!compact && roleLabel && (
                  <text
                    x={cx}
                    y={cy + 9.6}
                    textAnchor="middle"
                    fill="#7D8B9D"
                    fontSize="1.85"
                  >
                    {roleLabel}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Honest legend distinguishing verified squad assignments vs speculative formation slots */}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[#8A94A6]">
        <span>Solid ring: Verified squad player</span>
        <span aria-hidden="true">·</span>
        <span>Dashed ring: Speculative unassigned slot</span>
        <span aria-hidden="true">·</span>
        <span>{layoutStatusText}</span>
        <span aria-hidden="true">·</span>
        <span>Attack: Bottom to Top</span>
      </div>
    </div>
  );
}
