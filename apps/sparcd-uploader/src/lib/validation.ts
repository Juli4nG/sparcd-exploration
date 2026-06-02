// Per-file validation for the inspect step. Pure: takes the processed batch and
// returns one verdict per file id. Severity drives the gate — `error` blocks the
// batch, `warning` is allowed once surfaced, `ok` is clean. Duplicate detection
// is cross-file (SHA-256), so this runs over the whole batch at once.

import type { FileEntry } from '../store';
import { sanitizeRelPath } from './normalize';

export type Severity = 'ok' | 'warning' | 'error';

export type FileValidation = {
  severity: Severity;
  issues: { severity: Exclude<Severity, 'ok'>; message: string }[];
};

// Soft warning ceiling — unusual for a camera-trap JPEG, but allowed.
const SOFT_SIZE_LIMIT = 100 * 1024 * 1024; // 100 MiB

export function validateBatch(files: FileEntry[]): Record<string, FileValidation> {
  // Count content hashes so a hash seen more than once flags every copy.
  const hashCounts = new Map<string, number>();
  for (const f of files) {
    if (f.sha256) hashCounts.set(f.sha256, (hashCounts.get(f.sha256) ?? 0) + 1);
  }

  const out: Record<string, FileValidation> = {};
  for (const f of files) {
    const issues: FileValidation['issues'] = [];

    if (f.processState === 'error') {
      issues.push({ severity: 'error', message: f.processError ?? 'Processing failed' });
    }

    // Object-key safety. JPEG type is guaranteed by the scan, so the only name
    // failure mode here is an unsafe relative path.
    const nameResult = sanitizeRelPath(f.relPath);
    if (!nameResult.ok) {
      issues.push({ severity: 'error', message: `Unsafe filename — ${nameResult.reason}` });
    }

    // EXIF timestamp is required; absence routes the file to "needs attention".
    if (f.processState === 'ready' && !f.exifTimestamp) {
      issues.push({ severity: 'error', message: 'No EXIF timestamp — needs manual entry' });
    }

    if (f.size > SOFT_SIZE_LIMIT) {
      issues.push({ severity: 'warning', message: 'Large file (>100 MiB) — unusual for camera-trap' });
    }

    if (f.sha256 && (hashCounts.get(f.sha256) ?? 0) > 1) {
      issues.push({ severity: 'warning', message: 'Duplicate of another file in this batch' });
    }

    const severity: Severity = issues.some((i) => i.severity === 'error')
      ? 'error'
      : issues.some((i) => i.severity === 'warning')
        ? 'warning'
        : 'ok';
    out[f.id] = { severity, issues };
  }
  return out;
}

export type BatchSummary = {
  total: number;
  processed: number;
  pending: number; // queued + processing
  errors: number;
  warnings: number;
  ready: boolean; // nothing pending and no blocking errors
};

export function summarize(
  files: FileEntry[],
  validations: Record<string, FileValidation>,
): BatchSummary {
  let processed = 0;
  let pending = 0;
  let errors = 0;
  let warnings = 0;
  for (const f of files) {
    if (f.processState === 'ready' || f.processState === 'error') processed++;
    else pending++;
    const v = validations[f.id];
    if (v?.severity === 'error') errors++;
    else if (v?.severity === 'warning') warnings++;
  }
  return {
    total: files.length,
    processed,
    pending,
    errors,
    warnings,
    ready: files.length > 0 && pending === 0 && errors === 0,
  };
}
