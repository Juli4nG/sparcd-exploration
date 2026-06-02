// In-memory Camtrap-DP bundle generation for the Assign-step preview. Pure
// (apart from Web Crypto for the integrity hash) and S3-free — it produces the
// exact byte payloads P4 will upload, so the preview is truthful.
//
// Layout decision (P3, verified): image blobs live UNDER the upload prefix,
// because the existing SPARC'd reader lists objects under that prefix and
// ignores `media.csv`'s media_path. So `media_path` is
// `Collections/<uuid>/Uploads/<stamp>_<slug>/<relpath>` — not a separate
// UploadBlobs key. See plan "Persistence — S3 sync".

import type { Media } from '@sparcd/camtrap';
import {
  serializeDeployments,
  serializeMedia,
  serializeObservations,
  buildUploadMeta,
  serializeUploadMeta,
  serializeUploadComplete,
  uploadStamp,
  type UploadCompleteJson,
} from '@sparcd/camtrap';
import { locationToDeployment, type Location } from './locations';
import { sanitizeRelPath, resolveCollisions } from './normalize';
import type { FileEntry } from '../store';

/** One blob to stream: the full object key (= media_path) plus its source. */
export type UploadItem = {
  id: string; // FileEntry id
  key: string; // full S3 object key, identical to media_path
  file: File;
  size: number;
  sha256: string;
};

export type BundlePreview = {
  uploadPath: string;
  bucket: string;
  fileCount: number;
  totalBytes: number;
  metadataBundleSha256: string;
  deploymentsCsv: string;
  mediaCsv: string;
  observationsCsv: string;
  uploadMetaJson: string;
  uploadCompleteJson: string;
  /** Per-file upload plan; the orchestrator (P4) streams these to `key`. */
  items: UploadItem[];
};

const enc = new TextEncoder();

async function sha256Hex(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type BuildInput = {
  location: Location;
  collectionUuid: string;
  bucket: string;
  uploaderSlug: string;
  description: string;
  files: FileEntry[];
  now: Date;
};

/**
 * Build the five bundle payloads from the chosen deployment, identity, and the
 * processed files. Only files that finished processing with a hash are
 * included; collisions in the bundle-relative name get a deterministic suffix.
 */
export async function buildBundle(input: BuildInput): Promise<BundlePreview> {
  const { location, collectionUuid, bucket, uploaderSlug, description, files, now } = input;

  const stamp = uploadStamp(now);
  const uploadPath = `Collections/${collectionUuid}/Uploads/${stamp}_${uploaderSlug}`;

  const ready = files.filter((f) => f.processState === 'ready' && f.sha256);

  // Resolve the bundle-relative object name for each file (sanitized + any
  // collision suffix seeded by the content hash), then key it to the upload
  // prefix to form the full S3 object key used as media_path.
  const items = ready.map((f) => {
    const safe = sanitizeRelPath(f.relPath);
    return { id: f.id, name: safe.ok ? safe.name : f.fileName, seed: f.sha256! };
  });
  const names = resolveCollisions(items);

  const deployment = locationToDeployment(location, collectionUuid);

  const media: Media[] = ready.map((f) => {
    const objectName = names.get(f.id)!;
    const mediaPath = `${uploadPath}/${objectName}`;
    return {
      mediaId: mediaPath,
      deploymentId: deployment.deploymentId,
      mediaPath,
      fileName: f.fileName,
      timestamp: f.exifTimestamp ?? '',
      mimeType: 'image/jpeg',
    };
  });

  const uploadItems: UploadItem[] = ready.map((f, i) => ({
    id: f.id,
    key: media[i].mediaPath,
    file: f.file,
    size: f.size,
    sha256: f.sha256!,
  }));

  const deploymentsCsv = serializeDeployments([deployment]);
  const mediaCsv = serializeMedia(media);
  const observationsCsv = serializeObservations([]); // always empty on initial upload

  const uploadMetaJson = serializeUploadMeta(
    buildUploadMeta({
      uploadUser: uploaderSlug,
      date: now,
      imageCount: ready.length,
      imagesWithSpecies: 0,
      bucket,
      uploadPath,
      description,
    }),
  );

  // metadataBundleSha256 commits the bundle's index: the exact bytes of
  // UploadMeta.json followed by the three CSVs, in that order.
  const metadataBundleSha256 = await sha256Hex([
    enc.encode(uploadMetaJson),
    enc.encode(deploymentsCsv),
    enc.encode(mediaCsv),
    enc.encode(observationsCsv),
  ]);

  const complete: UploadCompleteJson = {
    schemaVersion: 1,
    uploadPath,
    fileCount: ready.length,
    metadataBundleSha256,
    files: media.map((m, i) => ({
      media_path: m.mediaPath,
      size: ready[i].size,
      sha256: ready[i].sha256!,
    })),
    completedAt: now.toISOString(),
  };

  return {
    uploadPath,
    bucket,
    fileCount: ready.length,
    totalBytes: ready.reduce((n, f) => n + f.size, 0),
    metadataBundleSha256,
    deploymentsCsv,
    mediaCsv,
    observationsCsv,
    uploadMetaJson,
    uploadCompleteJson: serializeUploadComplete(complete),
    items: uploadItems,
  };
}
