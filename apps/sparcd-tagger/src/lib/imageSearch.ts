// Find images by filename for the "jump to image" box. Returns the matching
// positions in canonical (media.csv) order, so the indices line up directly with
// the Overview / burst / selection indexing — the caller just moves focus to one
// of them and the virtualizer scrolls it into view. Pure and case-insensitive.

import type { TagImage } from './workspace';

export function findFilenameMatches(list: TagImage[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].fileName.toLowerCase().includes(q)) out.push(i);
  }
  return out;
}
