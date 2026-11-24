import React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { SortDirection } from '../../hooks/useTableSort';

export interface SortableThProps<K extends string> {
  label: string;
  columnKey: K;
  activeKey: K | null;
  direction: SortDirection;
  onSort: (key: K, defaultDir?: SortDirection) => void;
  defaultDir?: SortDirection;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

export function SortableTh<K extends string>({
  label,
  columnKey,
  activeKey,
  direction,
  onSort,
  defaultDir = 'asc',
  align = 'left',
  className = '',
}: SortableThProps<K>) {
  const isActive = activeKey === columnKey;
  const ariaSort: React.AriaAttributes['aria-sort'] = isActive
    ? direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';

  const alignClass =
    align === 'right'
      ? 'justify-end text-right'
      : align === 'center'
        ? 'justify-center text-center'
        : 'justify-start text-left';

  const thAlignClass =
    align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`${thAlignClass} select-none ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(columnKey, defaultDir)}
        className={`group inline-flex w-full items-center gap-1 whitespace-nowrap font-inherit tracking-inherit transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 rounded-sm ${alignClass} ${
          isActive ? 'text-emerald-400' : 'text-inherit hover:text-white'
        }`}
        title={`Sort by ${label}`}
      >
        <span>{label}</span>
        {isActive ? (
          direction === 'asc' ? (
            <ArrowUp className="w-3 h-3 shrink-0 text-emerald-400" aria-hidden="true" />
          ) : (
            <ArrowDown className="w-3 h-3 shrink-0 text-emerald-400" aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown
            className="w-3 h-3 shrink-0 opacity-35 group-hover:opacity-80 transition-opacity"
            aria-hidden="true"
          />
        )}
      </button>
    </th>
  );
}
