import { describe, it, expect } from 'vitest';
import { sortIndices } from '../src/lib/sortImages';
import type { TagImage } from '../src/lib/workspace';

function img(fileName: string, baseTimestamp: string): TagImage {
  return { key: `k/${fileName}`, fileName, deploymentId: 'd', baseTimestamp, baseObservations: [] };
}

// b.JPG / a.JPG / c.mp4, out of name order, with distinct timestamps.
const list: TagImage[] = [
  img('b.JPG', '2024-01-01T08:01:00'),
  img('a.JPG', '2024-01-01T08:02:00'),
  img('c.mp4', '2024-01-01T08:00:00'),
];
const noSpecies = () => 0;

describe('sortIndices', () => {
  it('sorts by name asc/desc via localeCompare', () => {
    expect(sortIndices(list, noSpecies, 'name', 'asc')).toEqual([1, 0, 2]); // a, b, c
    expect(sortIndices(list, noSpecies, 'name', 'desc')).toEqual([2, 0, 1]); // c, b, a
  });

  it('sorts by type (extension), splitting stills from video', () => {
    // jpg, jpg, mp4 → mp4 sorts last asc; tie between the two jpgs keeps original order.
    expect(sortIndices(list, noSpecies, 'type', 'asc')).toEqual([0, 1, 2]);
  });

  it('sorts by date via ISO string order', () => {
    expect(sortIndices(list, noSpecies, 'date', 'asc')).toEqual([2, 0, 1]);
  });

  it('sorts by the passed species-count closure', () => {
    const counts: Record<string, number> = { 'b.JPG': 2, 'a.JPG': 0, 'c.mp4': 1 };
    const count = (i: TagImage) => counts[i.fileName];
    expect(sortIndices(list, count, 'species', 'asc')).toEqual([1, 2, 0]); // 0,1,2
    expect(sortIndices(list, count, 'species', 'desc')).toEqual([0, 2, 1]); // 2,1,0
  });

  it('keeps the tiebreak ascending even when the sort is desc (stable)', () => {
    const flat = [img('x.JPG', 't'), img('x.JPG', 't'), img('x.JPG', 't')];
    expect(sortIndices(flat, noSpecies, 'name', 'desc')).toEqual([0, 1, 2]);
  });

  it('handles empty and single-element lists', () => {
    expect(sortIndices([], noSpecies, 'name', 'asc')).toEqual([]);
    expect(sortIndices([list[0]], noSpecies, 'name', 'asc')).toEqual([0]);
  });
});
