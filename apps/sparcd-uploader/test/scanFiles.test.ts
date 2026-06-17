// Media-kind gating for the scan entry points. The `webkitdirectory` FileList
// path is the most portable to exercise (plain File objects, no DOM file-system
// entries), and it shares `mediaKindOf` with the drag-drop and handle walkers.

import { describe, it, expect, beforeAll } from 'vitest';

// scanFiles.ts probes `window.showDirectoryPicker` at module load for the
// File System Access capability flag. The default (node) test environment has
// no `window`; stub a minimal one before the dynamic import so the module loads
// without pulling in a DOM dependency just for this unit test.
(globalThis as Record<string, unknown>).window ??= {};

let scanFileList: typeof import('../src/lib/scanFiles')['scanFileList'];
let formatBytes: typeof import('../src/lib/scanFiles')['formatBytes'];

beforeAll(async () => {
  const mod = await import('../src/lib/scanFiles');
  scanFileList = mod.scanFileList;
  formatBytes = mod.formatBytes;
});

function fileWith(name: string, type: string, relPath = name): File {
  const f = new File([new Uint8Array(1)], name, { type });
  // jsdom/node File has no webkitRelativePath; pin it so paths are deterministic.
  Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
  return f;
}

function listOf(files: File[]): FileList {
  return {
    ...files,
    length: files.length,
    item: (i: number) => files[i] ?? null,
  } as unknown as FileList;
}

describe('scanFileList media-kind gating', () => {
  it('accepts JPEG as image, MP4 as video, and rejects others', () => {
    const list = listOf([
      fileWith('IMG001.JPG', 'image/jpeg', 'trip/IMG001.JPG'),
      fileWith('clip.mp4', 'video/mp4', 'trip/clip.mp4'),
      fileWith('notes.png', 'image/png', 'trip/notes.png'),
      fileWith('readme.txt', 'text/plain', 'trip/readme.txt'),
    ]);
    const scanned = scanFileList(list);
    expect(scanned.map((s) => [s.fileName, s.mediaKind])).toEqual([
      ['IMG001.JPG', 'image'],
      ['clip.mp4', 'video'],
    ]);
  });

  it('falls back to the extension when the type is blank (JPG and MP4)', () => {
    const list = listOf([
      fileWith('IMG.jpeg', '', 'a/IMG.jpeg'),
      fileWith('VID.MP4', '', 'a/VID.MP4'),
      fileWith('thing.mov', '', 'a/thing.mov'),
    ]);
    const scanned = scanFileList(list);
    expect(scanned.map((s) => s.mediaKind)).toEqual(['image', 'video']);
  });

  it('keeps the relative path for resume reconciliation', () => {
    const scanned = scanFileList(listOf([fileWith('IMG.JPG', 'image/jpeg', 'top/sub/IMG.JPG')]));
    expect(scanned[0].relPath).toBe('top/sub/IMG.JPG');
    expect(scanned[0].id).toBe('top/sub/IMG.JPG');
  });
});

describe('formatBytes', () => {
  it('renders human sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
