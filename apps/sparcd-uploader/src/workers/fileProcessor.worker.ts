// Off-main-thread per-file processing: EXIF parse, streamed SHA-256, and a
// downscaled thumbnail. One file per message. The hash streams the file
// chunk-by-chunk so memory stays flat regardless of batch size; the digest must
// be known before any future PUT, which is why hashing happens here, up front.

import exifr from 'exifr';
import { createSHA256 } from 'hash-wasm';

export type ProcessRequest = { id: string; file: File };

export type ProcessResponse = {
  id: string;
  sha256?: string;
  exifTimestamp?: string; // ISO 8601
  exifCamera?: string;
  gps?: { lat: number; lon: number };
  width?: number;
  height?: number;
  thumbnail?: Blob;
  error?: string;
};

const THUMB_MAX = 64; // longest edge, CSS px doubled for crisp 32px rows

// Window-typed `self` in this lib config; cast to the dedicated-worker shape we
// actually use for posting structured-clone messages.
const post = (msg: ProcessResponse) => (self as unknown as Worker).postMessage(msg);

async function streamSha256(file: File): Promise<string> {
  const hasher = await createSHA256();
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest('hex');
}

const EXIF_FIELDS = ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Make', 'Model'] as const;

function toIso(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return undefined;
}

async function readExif(file: File): Promise<Partial<ProcessResponse>> {
  try {
    // Tags and GPS are separate calls: exifr only computes decimal lat/lon via
    // .gps(); a picked parse returns raw degree arrays instead.
    const [tags, gps] = await Promise.all([
      exifr.parse(file, { pick: EXIF_FIELDS as unknown as string[] }),
      exifr.gps(file).catch(() => undefined),
    ]);
    if (!tags) return gpsToResult(gps);
    const exifTimestamp =
      toIso(tags.DateTimeOriginal) ?? toIso(tags.CreateDate) ?? toIso(tags.ModifyDate);
    const exifCamera = [tags.Make, tags.Model].filter(Boolean).join(' ').trim() || undefined;
    return { exifTimestamp, exifCamera, ...gpsToResult(gps) };
  } catch {
    return {}; // missing/corrupt EXIF is a validation concern, not a hard failure
  }
}

function gpsToResult(gps: { latitude: number; longitude: number } | undefined): Partial<ProcessResponse> {
  if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
    return { gps: { lat: gps.latitude, lon: gps.longitude } };
  }
  return {};
}

async function makeThumbnail(file: File): Promise<Partial<ProcessResponse>> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { width, height };
    }
    ctx.drawImage(bitmap, 0, 0, tw, th);
    bitmap.close();
    const thumbnail = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    return { width, height, thumbnail };
  } catch {
    return {}; // undecodable preview is non-fatal; the file still uploads
  }
}

self.onmessage = async (e: MessageEvent<ProcessRequest>) => {
  const { id, file } = e.data;
  try {
    // Hash is mandatory; EXIF and thumbnail are best-effort. Run them together.
    const [sha256, exif, thumb] = await Promise.all([
      streamSha256(file),
      readExif(file),
      makeThumbnail(file),
    ]);
    post({ id, sha256, ...exif, ...thumb });
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : 'Processing failed' });
  }
};
