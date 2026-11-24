import { useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export type SortValue = string | number | null | undefined;

export function isNullishOrEmpty(value: SortValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isNaN(value);
  if (typeof value === 'string') return value.trim().length === 0;
  return false;
}

/**
 * Null-safe comparator: null/undefined/NaN/empty values always sort last
 * regardless of ascending or descending direction.
 */
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDirection): number {
  const aEmpty = isNullishOrEmpty(a);
  const bEmpty = isNullishOrEmpty(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  let cmp = 0;
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b;
  } else {
    cmp = String(a).localeCompare(String(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }

  return dir === 'asc' ? cmp : -cmp;
}

export interface TableSortConfig<K extends string> {
  key: K;
  dir: SortDirection;
}

export interface TableSortResult<T, K extends string> {
  sortedRows: T[];
  sortKey: K | null;
  sortDir: SortDirection;
  toggleSort: (key: K, defaultDir?: SortDirection) => void;
  setSort: (key: K | null, dir?: SortDirection) => void;
}

export function useTableSort<T, K extends string>(
  rows: readonly T[],
  accessors: Record<K, (row: T) => SortValue>,
  initialSort?: TableSortConfig<NoInfer<K>>,
): TableSortResult<T, K> {
  const [sortKey, setSortKey] = useState<K | null>(initialSort?.key ?? null);
  const [sortDir, setSortDir] = useState<SortDirection>(initialSort?.dir ?? 'asc');

  const toggleSort = (key: K, defaultDir: SortDirection = 'asc') => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(defaultDir);
    }
  };

  const setSort = (key: K | null, dir: SortDirection = 'asc') => {
    setSortKey(key);
    setSortDir(dir);
  };

  const sortedRows = useMemo(() => {
    if (!sortKey) return [...rows];
    const accessor = accessors[sortKey];
    if (!accessor) return [...rows];

    // Stable decorate-sort-undecorate preserving original index on ties
    return rows
      .map((row, index) => ({ row, index, value: accessor(row) }))
      .sort((a, b) => {
        const cmp = compareSortValues(a.value, b.value, sortDir);
        return cmp !== 0 ? cmp : a.index - b.index;
      })
      .map((item) => item.row);
  }, [rows, accessors, sortKey, sortDir]);

  return {
    sortedRows,
    sortKey,
    sortDir,
    toggleSort,
    setSort,
  };
}
