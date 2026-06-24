import { describe, it, expect } from 'vitest';
import { formatUploadDate, formatUploadHeader } from '../src/lib/uploadDisplay';
import type { UploadMetaJson } from '@sparcd/camtrap';

const meta: UploadMetaJson = {
  uploadUser: 'Jane Doe',
  uploadDate: { date: { year: 2026, month: 3, day: 9 }, time: { hour: 7, minute: 5, second: 0, nano: 0 } },
  imagesWithSpecies: 12,
  imageCount: 40,
  editComments: [],
  bucket: 'sparcd-x',
  uploadPath: 'Collections/x/Uploads/stamp',
  description: '',
};

describe('uploadDisplay', () => {
  it('formats the stored local-time fields directly (zero-padded, no Date round-trip)', () => {
    expect(formatUploadDate(meta.uploadDate)).toBe('2026-03-09 at 07:05');
  });

  it('builds the uploader+date header', () => {
    expect(formatUploadHeader(meta)).toBe('Jane Doe on 2026-03-09 at 07:05');
  });

  it('does not throw on shape-drifted metadata (missing uploadDate / uploadUser)', () => {
    // A legacy/foreign UploadMeta.json is a plain JSON cast; tolerate gaps.
    expect(formatUploadDate(undefined)).toBe('unknown date');
    const drifted = { ...meta, uploadUser: '', uploadDate: undefined } as unknown as UploadMetaJson;
    expect(formatUploadHeader(drifted)).toBe('(unknown uploader) on unknown date');
  });
});
