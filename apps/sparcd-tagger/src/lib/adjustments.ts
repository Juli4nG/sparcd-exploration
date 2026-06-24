// View-only display adjustments for the Focus image. Pure presentation: these
// values drive a CSS `filter` on the focused <img> and never touch pixels,
// drafts, or S3. The 0–100 slider range and its mapping to CSS units mirror the
// upstream sparcd-web tagger (app/tagging/ImageAdjustments.js + ImageEdit.js) so
// a frame dialed-in here looks the same as it does in SPARC'd.

export type Adjustments = {
  brightness: number;
  contrast: number;
  hue: number;
  saturation: number;
};

/** Neutral = 50 on every slider, a visual no-op. */
export const NEUTRAL: Adjustments = { brightness: 50, contrast: 50, hue: 50, saturation: 50 };

export function isNeutral(a: Adjustments): boolean {
  return (
    a.brightness === 50 && a.contrast === 50 && a.hue === 50 && a.saturation === 50
  );
}

// Map the four 0–100 values to a CSS `filter` string. Mirrors upstream exactly:
// - brightness is piecewise (50 = 100%): below 50 darkens toward 0%, above 50
//   brightens toward 400%, so the neutral midpoint is a no-op.
// - contrast / saturation are a straight 0–200% (50 = 100%).
// - hue is a signed rotation -180°..+180° (50 = 0°).
export function cssFilter(a: Adjustments): string {
  const brightness =
    a.brightness <= 50 ? a.brightness * 2 : 100 + ((a.brightness - 50) / 50) * 300;
  const contrast = a.contrast * 2;
  const hue = -180 + (a.hue / 100) * 360;
  const saturate = a.saturation * 2;
  return `brightness(${brightness}%) contrast(${contrast}%) hue-rotate(${hue}deg) saturate(${saturate}%)`;
}
