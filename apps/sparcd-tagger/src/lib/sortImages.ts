// Client-side ordering for the Overview. Returns a PERMUTATION of original
// indices rather than a sorted copy: the whole Tag workspace addresses images by
// position (selection is a Set<number>, bursts derive from list order, keyboard
// nav clamps against list.length), so the caller maps the permutation onto the
// canonical `media.csv` array once and lets everything re-derive — and can remap
// the live selection/focus through the permutation to keep them on their images.
//
// Comparators mirror the upstream sparcd-web tagger (getSortedImages). Species
// count is passed in as a closure so this module stays pure and testable and so
// "count" reflects effective (draft-aware) tags, not just the canonical base.

import type { TagImage } from './workspace';

export type SortField = 'name' | 'type' | 'date' | 'species';
export type SortDir = 'asc' | 'desc';

function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export function sortIndices(
  list: TagImage[],
  speciesCount: (img: TagImage) => number,
  field: SortField,
  dir: SortDir,
): number[] {
  const order = list.map((_, i) => i);
  const sign = dir === 'asc' ? 1 : -1;

  const cmp = (ia: number, ib: number): number => {
    const a = list[ia];
    const b = list[ib];
    let d = 0;
    switch (field) {
      case 'name':
        d = a.fileName.localeCompare(b.fileName);
        break;
      case 'type':
        d = extOf(a.fileName).localeCompare(extOf(b.fileName));
        break;
      case 'date':
        d = a.baseTimestamp.localeCompare(b.baseTimestamp);
        break;
      case 'species':
        d = speciesCount(a) - speciesCount(b);
        break;
    }
    // Stable, deterministic tiebreak: equal keys always keep media.csv order,
    // regardless of sort direction.
    return d !== 0 ? sign * d : ia - ib;
  };

  order.sort(cmp);
  return order;
}
