import { Check, ChevronDown, Search, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Player } from '../../types/domain';
import { toCanonicalFc26Position } from '../../utils/formationPositions';
import { resolvePlayerDisplayName } from '../../utils/playerDisplayName';
import { evaluatePlayerEligibility } from '../../utils/squadEligibility';

interface SearchablePlayerSelectProps {
  value: string | null;
  options: Player[];
  assignedIds: ReadonlySet<string>;
  slotPosition: string;
  onChange: (playerId: string) => void;
  unassignedLabel?: string;
  triggerBgClass?: string;
}

interface IndexedOption {
  player: Player;
  displayName: string;
  canonicalPrimary: string;
  isPrimaryFit: boolean;
  isSecondaryFit: boolean;
  eligible: boolean;
  requiresConfirmation: boolean;
  shortBadge: string;
  usedElsewhere: boolean;
  disabled: boolean;
  searchHaystack: string;
}

interface MenuCoords {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxListHeight: number;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .replace(/[đĐ]/g, 'd')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .trim();
}

export function SearchablePlayerSelect({
  value,
  options,
  assignedIds,
  slotPosition,
  onChange,
  unassignedLabel = 'Unassigned slot',
  triggerBgClass = 'bg-[#0C0F14]',
}: SearchablePlayerSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [coords, setCoords] = useState<MenuCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const targetCanonicalPos = useMemo(
    () => toCanonicalFc26Position(slotPosition) ?? slotPosition.toUpperCase(),
    [slotPosition]
  );

  const currentPlayer = useMemo(
    () => (value ? options.find((p) => p.id === value) ?? null : null),
    [options, value]
  );

  const currentEval = useMemo(
    () => (currentPlayer ? evaluatePlayerEligibility(currentPlayer) : null),
    [currentPlayer]
  );

  const indexedOptions = useMemo<IndexedOption[]>(() => {
    return options.map((player) => {
      const displayName = resolvePlayerDisplayName(player);
      const canonicalPrimary =
        toCanonicalFc26Position(player.position) ?? player.position.toUpperCase();
      const canonicalSecondaries = (player.secondaryPositions ?? []).map(
        (pos) => toCanonicalFc26Position(pos) ?? pos.toUpperCase()
      );
      const isPrimaryFit = canonicalPrimary === targetCanonicalPos;
      const isSecondaryFit = !isPrimaryFit && canonicalSecondaries.includes(targetCanonicalPos);
      const evalRes = evaluatePlayerEligibility(player);
      const usedElsewhere = assignedIds.has(player.id) && value !== player.id;
      const isBlockedOption = !evalRes.eligible && value !== player.id;

      const searchHaystack = normalizeSearchText(
        [
          displayName,
          player.fullName,
          player.shortName ?? '',
          player.name,
          player.position,
          canonicalPrimary,
          ...(player.secondaryPositions ?? []),
          ...canonicalSecondaries,
          player.squadNumber != null ? `#${player.squadNumber} ${player.squadNumber}` : '',
        ].join(' ')
      );

      return {
        player,
        displayName,
        canonicalPrimary,
        isPrimaryFit,
        isSecondaryFit,
        eligible: evalRes.eligible,
        requiresConfirmation: evalRes.requiresConfirmation,
        shortBadge: evalRes.shortBadge,
        usedElsewhere,
        disabled: usedElsewhere || isBlockedOption,
        searchHaystack,
      };
    });
  }, [options, targetCanonicalPos, assignedIds, value]);

  const { fitOptions, otherOptions } = useMemo(() => {
    const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    const filtered =
      tokens.length === 0
        ? indexedOptions
        : indexedOptions.filter((item) =>
            tokens.every((token) => item.searchHaystack.includes(token))
          );

    const fits: IndexedOption[] = [];
    const others: IndexedOption[] = [];

    for (const item of filtered) {
      if (item.isPrimaryFit || item.isSecondaryFit) {
        fits.push(item);
      } else {
        others.push(item);
      }
    }

    const sortByFitAndRating = (a: IndexedOption, b: IndexedOption) => {
      if (a.isPrimaryFit !== b.isPrimaryFit) return a.isPrimaryFit ? -1 : 1;
      const ovrDiff = (b.player.overallRating ?? 0) - (a.player.overallRating ?? 0);
      if (ovrDiff !== 0) return ovrDiff;
      return a.displayName.localeCompare(b.displayName);
    };

    fits.sort(sortByFitAndRating);
    others.sort((a, b) => {
      const ovrDiff = (b.player.overallRating ?? 0) - (a.player.overallRating ?? 0);
      if (ovrDiff !== 0) return ovrDiff;
      return a.displayName.localeCompare(b.displayName);
    });

    return { fitOptions: fits, otherOptions: others };
  }, [indexedOptions, query]);

  const showUnassignedRow = query.trim().length === 0;

  const selectableKeys = useMemo(() => {
    const keys: string[] = [];
    if (showUnassignedRow) keys.push('__unassigned__');
    for (const item of fitOptions) {
      if (!item.disabled) keys.push(item.player.id);
    }
    for (const item of otherOptions) {
      if (!item.disabled) keys.push(item.player.id);
    }
    return keys;
  }, [showUnassignedRow, fitOptions, otherOptions]);

  const computeCoords = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const margin = 8;
    const estimatedTotalHeight = 320;
    const spaceBelow = viewportH - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;

    const width = Math.min(Math.max(rect.width, 300), viewportW - margin * 2);
    const left = Math.min(Math.max(margin, rect.left), viewportW - width - margin);
    const availableHeight = Math.min(
      estimatedTotalHeight,
      Math.max(160, (openUpward ? spaceAbove : spaceBelow) - 4)
    );
    const maxListHeight = Math.max(110, availableHeight - 52);

    if (openUpward) {
      setCoords({
        bottom: viewportH - rect.top + 4,
        left,
        width,
        maxListHeight,
      });
    } else {
      setCoords({
        top: rect.bottom + 4,
        left,
        width,
        maxListHeight,
      });
    }
  }, []);

  const closeMenu = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    setQuery('');
    setHighlightedKey(null);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openMenu = useCallback(() => {
    computeCoords();
    setQuery('');
    setIsOpen(true);
  }, [computeCoords]);

  useEffect(() => {
    if (!isOpen) return;
    computeCoords();
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu(false);
    };

    const handleScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) {
        return;
      }
      computeCoords();
    };

    const handleResize = () => {
      computeCoords();
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [isOpen, computeCoords, closeMenu]);

  useEffect(() => {
    if (!isOpen) return;
    if (selectableKeys.length === 0) {
      setHighlightedKey(null);
      return;
    }
    if (query.trim().length > 0) {
      setHighlightedKey(selectableKeys[0]);
      return;
    }
    if (value && selectableKeys.includes(value)) {
      setHighlightedKey(value);
    } else {
      setHighlightedKey(selectableKeys[0]);
    }
  }, [isOpen, query, selectableKeys, value]);

  useEffect(() => {
    if (!isOpen || !highlightedKey) return;
    const node = itemRefs.current.get(highlightedKey);
    node?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, highlightedKey]);

  const handleSelect = useCallback(
    (nextPlayerId: string) => {
      onChange(nextPlayerId);
      closeMenu(true);
    },
    [onChange, closeMenu]
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (selectableKeys.length === 0) return;
      const idx = highlightedKey ? selectableKeys.indexOf(highlightedKey) : -1;
      const nextIdx = idx < 0 || idx >= selectableKeys.length - 1 ? 0 : idx + 1;
      setHighlightedKey(selectableKeys[nextIdx]);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (selectableKeys.length === 0) return;
      const idx = highlightedKey ? selectableKeys.indexOf(highlightedKey) : 0;
      const prevIdx = idx <= 0 ? selectableKeys.length - 1 : idx - 1;
      setHighlightedKey(selectableKeys[prevIdx]);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const targetKey = highlightedKey ?? selectableKeys[0];
      if (!targetKey) return;
      handleSelect(targetKey === '__unassigned__' ? '' : targetKey);
    }
  };

  const triggerBorderClass =
    currentEval && !currentEval.eligible
      ? 'border-red-500/70'
      : currentEval?.requiresConfirmation
        ? 'border-amber-500/60'
        : isOpen
          ? 'border-emerald-500/70'
          : 'border-white/[0.1] hover:border-white/[0.2]';

  const currentLabel = currentPlayer
    ? `${resolvePlayerDisplayName(currentPlayer)} (${currentPlayer.position}${
        currentPlayer.overallRating ? ` · ${currentPlayer.overallRating}` : ''
      })`
    : unassignedLabel;

  const renderPlayerRow = (item: IndexedOption) => {
    const isSelected = value === item.player.id;
    const isHighlighted = highlightedKey === item.player.id;

    return (
      <button
        key={item.player.id}
        ref={(el) => {
          if (el) itemRefs.current.set(item.player.id, el);
          else itemRefs.current.delete(item.player.id);
        }}
        type="button"
        disabled={item.disabled}
        onMouseEnter={() => {
          if (!item.disabled) setHighlightedKey(item.player.id);
        }}
        onClick={() => {
          if (!item.disabled) handleSelect(item.player.id);
        }}
        className={`w-full px-2.5 py-1.5 text-left text-[12px] flex items-center justify-between gap-2 transition-colors ${
          item.disabled
            ? 'opacity-45 cursor-not-allowed text-[#8A94A6]'
            : isHighlighted
              ? 'bg-emerald-500/20 text-white'
              : isSelected
                ? 'bg-white/[0.06] text-white'
                : 'text-[#DCE2EC] hover:bg-white/[0.05]'
        }`}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
            {isSelected && <Check className="w-3.5 h-3.5 text-emerald-400" />}
          </span>
          <span className="truncate font-medium">{item.displayName}</span>
          {item.player.squadNumber != null && (
            <span className="text-[10px] font-mono text-[#6E788A] shrink-0">
              #{item.player.squadNumber}
            </span>
          )}
        </span>

        <span className="flex items-center gap-1.5 shrink-0">
          <span
            className={`font-mono text-[10px] px-1 py-0.5 rounded ${
              item.isPrimaryFit
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                : item.isSecondaryFit
                  ? 'bg-sky-500/15 text-sky-300 border border-sky-500/25'
                  : 'bg-white/[0.05] text-[#9AA4B5]'
            }`}
          >
            {item.player.position}
          </span>
          {item.player.overallRating != null && (
            <span className="font-mono text-[11px] tabular-nums text-white w-5 text-right">
              {item.player.overallRating}
            </span>
          )}
          {!item.eligible && (
            <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30">
              {item.shortBadge}
            </span>
          )}
          {item.eligible && item.requiresConfirmation && (
            <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
              Doubtful
            </span>
          )}
          {item.usedElsewhere && (
            <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-white/[0.08] text-[#9AA4B5]">
              In XI
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => (isOpen ? closeMenu(false) : openMenu())}
        onKeyDown={(e) => {
          if (!isOpen && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            openMenu();
          }
        }}
        className={`w-full ${triggerBgClass} border ${triggerBorderClass} rounded px-2 py-1 text-[12px] text-left flex items-center justify-between gap-1.5 transition-colors focus:outline-none focus:border-emerald-500/70`}
      >
        <span
          className={`truncate ${
            currentPlayer ? 'text-white' : 'text-[#7D8798]'
          }`}
          title={currentLabel}
        >
          {currentLabel}
          {currentEval && !currentEval.eligible && (
            <span className="ml-1 text-[10px] text-red-300">
              [{currentEval.shortBadge.toUpperCase()}]
            </span>
          )}
          {currentEval && currentEval.eligible && currentEval.requiresConfirmation && (
            <span className="ml-1 text-[10px] text-amber-300">[DOUBTFUL]</span>
          )}
        </span>

        <span className="flex items-center gap-1 shrink-0">
          {currentPlayer && (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Unassign player"
              title="Unassign slot"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
                if (isOpen) closeMenu(false);
              }}
              className="p-0.5 rounded text-[#7D8798] hover:text-white hover:bg-white/[0.08]"
            >
              <X className="w-3 h-3" />
            </span>
          )}
          <ChevronDown
            className={`w-3.5 h-3.5 text-[#8A94A6] transition-transform ${
              isOpen ? 'rotate-180 text-emerald-400' : ''
            }`}
          />
        </span>
      </button>

      {isOpen &&
        coords &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={`Select player for ${targetCanonicalPos}`}
            onKeyDown={handleKeyDown}
            style={{
              position: 'fixed',
              top: coords.top,
              bottom: coords.bottom,
              left: coords.left,
              width: coords.width,
            }}
            className="z-50 rounded-md border border-white/[0.14] bg-[#0D1016] shadow-2xl shadow-black/70 overflow-hidden"
          >
            <div className="p-1.5 border-b border-white/[0.08] bg-[#12161F]">
              <div className="relative flex items-center">
                <Search className="w-3.5 h-3.5 text-[#7D8798] absolute left-2 pointer-events-none" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${targetCanonicalPos} or player...`}
                  className="w-full bg-[#0A0D12] border border-white/[0.1] focus:border-emerald-500/70 focus:outline-none rounded pl-7 pr-7 py-1 text-[12px] text-white placeholder-[#6E788A]"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery('');
                      inputRef.current?.focus();
                    }}
                    className="absolute right-1.5 p-0.5 text-[#7D8798] hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            <div
              style={{ maxHeight: coords.maxListHeight }}
              className="overflow-y-auto py-1 divide-y divide-white/[0.04]"
            >
              {showUnassignedRow && (
                <div className="pb-0.5">
                  <button
                    ref={(el) => {
                      if (el) itemRefs.current.set('__unassigned__', el);
                      else itemRefs.current.delete('__unassigned__');
                    }}
                    type="button"
                    onMouseEnter={() => setHighlightedKey('__unassigned__')}
                    onClick={() => handleSelect('')}
                    className={`w-full px-2.5 py-1.5 text-left text-[12px] flex items-center gap-1.5 transition-colors ${
                      highlightedKey === '__unassigned__'
                        ? 'bg-emerald-500/20 text-white'
                        : !value
                          ? 'bg-white/[0.06] text-white'
                          : 'text-[#8A94A6] hover:bg-white/[0.05]'
                    }`}
                  >
                    <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                      {!value && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                    </span>
                    <span className="italic">{unassignedLabel}</span>
                  </button>
                </div>
              )}

              {fitOptions.length > 0 && (
                <div className="py-0.5">
                  <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400/90 bg-emerald-500/[0.04]">
                    Position Fit ({targetCanonicalPos})
                  </div>
                  {fitOptions.map(renderPlayerRow)}
                </div>
              )}

              {otherOptions.length > 0 && (
                <div className="py-0.5">
                  {fitOptions.length > 0 && (
                    <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#7D8798] bg-white/[0.02]">
                      Other Squad Players
                    </div>
                  )}
                  {otherOptions.map(renderPlayerRow)}
                </div>
              )}

              {fitOptions.length === 0 && otherOptions.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-[#7D8798]">
                  No squad players match &ldquo;{query.trim()}&rdquo;
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
