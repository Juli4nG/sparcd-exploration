// Per-upload timezone handling for EXIF capture time.
//
// EXIF DateTimeOriginal/CreateDate/ModifyDate are NAIVE wall-clock strings with
// no zone. The camera wrote them in *its* local time; the uploading machine's
// zone is irrelevant. We capture the components verbatim (never letting
// `new Date(localString)` reinterpret them in the browser's zone), then
// interpret them in a user-chosen IANA zone to get the true UTC instant. The
// result is emitted in the canonical naive shape `YYYY-MM-DDTHH:mm:ss` (no `Z`,
// no millis, no offset) — the exact byte shape media.csv col 4 carries and the
// Java app, sparcd-web, the explorer, and the tagger all read.

/** Naive EXIF wall-clock with no zone — the components as written by the camera. */
export type NaiveDateTime = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
};

/** The browser's resolved IANA zone; the default tz for a new upload. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** All IANA zones for the picker. */
export function supportedTimeZones(): string[] {
  return Intl.supportedValuesOf('timeZone');
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Format naive components as canonical `YYYY-MM-DDTHH:mm:ss` (no Z). */
export function formatNaive(n: NaiveDateTime): string {
  return (
    `${String(n.year).padStart(4, '0')}-${pad(n.month)}-${pad(n.day)}T` +
    `${pad(n.hour)}:${pad(n.minute)}:${pad(n.second)}`
  );
}

// Read the wall-clock components a given UTC instant has *in* `timeZone`. Built
// once per zone; en-US + hourCycle h23 keeps midnight at 00 (not 24).
function partsInZone(utcMs: number, timeZone: string): NaiveDateTime {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

// Difference, in milliseconds, between the wall-clock `partsInZone` produced for
// `utcMs` and the wall-clock we *wanted* (`target`). Subtracting it from the
// UTC guess steers toward the offset that makes the zone show `target`.
function deltaMs(produced: NaiveDateTime, target: NaiveDateTime): number {
  return Date.UTC(produced.year, produced.month - 1, produced.day, produced.hour, produced.minute, produced.second) -
    Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
}

/**
 * Interpret naive wall-clock components AS IF in `timeZone`, returning the UTC
 * instant in canonical naive UTC shape `YYYY-MM-DDTHH:mm:ss` (no Z).
 *
 * DST-correct without a heavy dependency: start from a UTC guess equal to the
 * components, ask Intl what wall-clock that guess shows in `timeZone`, and
 * subtract the gap to home in on the offset. One pass handles the common case;
 * a second pass resolves the DST fold/gap where the offset itself changes
 * within the corrected window. Spring-forward gaps (a wall-clock that doesn't
 * exist) and fall-back folds (ambiguous) resolve deterministically to whatever
 * the two-pass fixed point lands on — pinned by tests, never throws.
 */
export function naiveInZoneToUtcNaive(n: NaiveDateTime, timeZone: string): string {
  let guess = Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second);
  guess -= deltaMs(partsInZone(guess, timeZone), n);
  // Second pass: if the first correction crossed a DST boundary, the offset at
  // the corrected instant may differ; re-correct from there.
  guess -= deltaMs(partsInZone(guess, timeZone), n);

  const d = new Date(guess);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}
