import { describe, it, expect } from 'vitest';
import { findFilenameMatches } from '../src/lib/imageSearch';
import type { TagImage } from '../src/lib/workspace';

function img(fileName: string): TagImage {
  return { key: `k/${fileName}`, fileName, deploymentId: 'd', baseTimestamp: '', baseObservations: [] };
}

const list = [img('IMG001.JPG'), img('IMG002.JPG'), img('CLIP.mp4'), img('img010.jpg')];

describe('findFilenameMatches', () => {
  it('matches case-insensitive substrings in canonical order', () => {
    expect(findFilenameMatches(list, 'img')).toEqual([0, 1, 3]);
    expect(findFilenameMatches(list, '00')).toEqual([0, 1]);
    expect(findFilenameMatches(list, 'clip')).toEqual([2]);
  });

  it('returns [] for an empty / whitespace query', () => {
    expect(findFilenameMatches(list, '')).toEqual([]);
    expect(findFilenameMatches(list, '   ')).toEqual([]);
  });

  it('returns [] when nothing matches', () => {
    expect(findFilenameMatches(list, 'zzz')).toEqual([]);
  });
});
