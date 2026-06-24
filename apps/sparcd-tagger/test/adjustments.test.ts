import { describe, it, expect } from 'vitest';
import { cssFilter, isNeutral, NEUTRAL } from '../src/lib/adjustments';

describe('cssFilter', () => {
  it('maps NEUTRAL to a visual no-op', () => {
    expect(cssFilter(NEUTRAL)).toBe(
      'brightness(100%) contrast(100%) hue-rotate(0deg) saturate(100%)',
    );
  });

  it('maps brightness endpoints (piecewise, 50 = 100%)', () => {
    expect(cssFilter({ ...NEUTRAL, brightness: 0 })).toBe(
      'brightness(0%) contrast(100%) hue-rotate(0deg) saturate(100%)',
    );
    expect(cssFilter({ ...NEUTRAL, brightness: 100 })).toBe(
      'brightness(400%) contrast(100%) hue-rotate(0deg) saturate(100%)',
    );
  });

  it('maps contrast and saturation as 0–200%', () => {
    expect(cssFilter({ ...NEUTRAL, contrast: 100 })).toContain('contrast(200%)');
    expect(cssFilter({ ...NEUTRAL, saturation: 0 })).toContain('saturate(0%)');
  });

  it('maps hue to a signed rotation (-180°..+180°)', () => {
    expect(cssFilter({ ...NEUTRAL, hue: 0 })).toContain('hue-rotate(-180deg)');
    expect(cssFilter({ ...NEUTRAL, hue: 100 })).toContain('hue-rotate(180deg)');
  });
});

describe('isNeutral', () => {
  it('is true only when every slider sits at 50', () => {
    expect(isNeutral(NEUTRAL)).toBe(true);
    expect(isNeutral({ ...NEUTRAL, hue: 51 })).toBe(false);
  });
});
