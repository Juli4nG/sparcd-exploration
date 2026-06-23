// Pure helpers for the time-correction UI. The actual date math lives in
// `@sparcd/camtrap` (`shiftTimestamp` / `correctedTimestamp`), which mirrors the
// Java desktop app's `TimeShiftController` clamping — see that package's
// `contracts.test.ts`. These are just the display/format glue the UI needs, kept
// pure so they can be unit-tested without React or Dexie.

import type { TimeOffsetRecord } from './db';

/** The earliest already-corrected timestamp among the bulk targets — the anchor a
 *  selection-scoped shift previews against. It MUST be the corrected time (not the
 *  raw base), because the shift is applied relative to the time each frame shows
 *  now, so the preview's before→after matches what apply actually persists. ISO
 *  timestamps sort chronologically, so a lexicographic min is the earliest.
 *  Returns '' for an empty target set. */
export function earliestCorrected(targets: { currentCorrected: string }[]): string {
  let earliest = '';
  for (const t of targets) {
    if (t.currentCorrected && (earliest === '' || t.currentCorrected < earliest)) {
      earliest = t.currentCorrected;
    }
  }
  return earliest;
}

export const ZERO_OFFSET_RECORD: TimeOffsetRecord = {
  years: 0,
  months: 0,
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
};

/** True when any field of the offset is non-zero (drives the active indicator). */
export function offsetActive(o: TimeOffsetRecord | null | undefined): boolean {
  return !!o && (o.years || o.months || o.days || o.hours || o.minutes || o.seconds) !== 0;
}

/** Compact signed delta, e.g. `+1h`, `-1d 7h 30m`, or `no shift` when zero.
 *  Matches the design's `fmtDelta` (TimeShiftModal / ClockChip label). */
export function formatOffsetDelta(o: TimeOffsetRecord | null | undefined): string {
  if (!o) return 'no shift';
  const parts: string[] = [];
  const push = (v: number, unit: string) => {
    if (v) parts.push(`${v > 0 ? '+' : ''}${v}${unit}`);
  };
  push(o.years, 'y');
  push(o.months, 'mo');
  push(o.days, 'd');
  push(o.hours, 'h');
  push(o.minutes, 'm');
  push(o.seconds, 's');
  return parts.length ? parts.join(' ') : 'no shift';
}

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Normalize a user-typed corrected timestamp to the canonical naive
 *  `YYYY-MM-DDTHH:mm:ss` shape (the form `media.csv` col 4 stores). Accepts a
 *  space or `T` separator and an optional seconds field. Returns null on a shape
 *  or range violation so the caller can reject the edit instead of writing junk. */
export function normalizeTimestampInput(raw: string): string | null {
  const m = INPUT_RE.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const min = Number(mi);
  const sec = s ? Number(s) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
    return null;
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${String(sec).padStart(2, '0')}`;
}
