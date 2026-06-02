// Camtrap-DP-flavored types shared by the SPARC'd tools. Pure TS — no React,
// no S3. The uploader becomes the writer-of-record here; the tagger reads.
//
// The writer below produces the exact byte shape SPARC'd already writes,
// verified against the live Educational Test collection and the upstream
// `camtrap/v016` module: three no-header CSVs whose readers parse by fixed
// column *position*, plus the `UploadMeta.json` shape. SPARC'd's writer
// quotes every field (QUOTE_ALL), terminates each row with a bare LF, and
// leaves a trailing newline — matched here so a round-trip is byte-stable.

/** One row of `deployments.csv` — a camera location for one upload. */
export type Deployment = {
  deploymentId: string; // "<collection-uuid>:<location-id>"
  locationId: string;
  locationName: string;
  latitude: number;
  longitude: number;
  elevation: number; // metres; serialized into the v016 `camera_height` column
};

/** One row of `media.csv` — one image blob. */
export type Media = {
  mediaId: string;
  deploymentId: string;
  mediaPath: string; // full S3 object key under UploadBlobs/
  fileName: string; // local filename
  timestamp: string; // ISO, from EXIF
  mimeType: string; // "image/jpeg"
};

/** One row of `observations.csv` — species + count. Empty on initial upload. */
export type Observation = {
  observationId: string;
  mediaId: string;
  deploymentId: string;
  timestamp: string; // ISO; v016 observation timestamp column
  scientificName: string;
  count: number;
  tags: string; // concatenated [PREFIX:value] markers
};

/** All three collections for one upload bundle. */
export type CamtrapBundle = {
  deployments: Deployment[];
  media: Media[];
  observations: Observation[];
};

// ---------------------------------------------------------------------------
// CSV writer — v016 fixed-position layout
//
// Verified live (Educational Test bucket) and against upstream `camtrap/v016`:
//   deployments.csv  23 columns
//   media.csv        11 columns
//   observations.csv 20 columns (written empty on initial upload)
// Every field is quoted; rows are LF-terminated including a trailing newline.
// Readers index by position, so column count and order are the contract.
// ---------------------------------------------------------------------------

function csvRow(fields: string[]): string {
  return fields.map((f) => `"${f.replace(/"/g, '""')}"`).join(',') + '\n';
}

// SPARC'd writes coordinates / camera geometry with six decimals; integer-ish
// fields (uncertainty, interval, heading) stay bare. Matches the live bytes.
const f6 = (n: number): string => n.toFixed(6);

/** Serialize `deployments.csv` (one row per deployment), v016 23-column shape. */
export function serializeDeployments(deployments: Deployment[]): string {
  return deployments
    .map((d) =>
      csvRow([
        d.deploymentId, // 0  deployment_id
        d.locationId, // 1  location_id
        d.locationName, // 2  location_name
        f6(d.longitude), // 3  longitude  (note: before latitude)
        f6(d.latitude), // 4  latitude
        '0', // 5  coordinate_uncertainty
        '', // 6  start
        '', // 7  end
        '', // 8  setup_by
        '', // 9  camera_id
        '', // 10 camera_model
        '0', // 11 camera_interval
        f6(d.elevation), // 12 camera_height (elevation)
        '0.000000', // 13 camera_tilt
        '0', // 14 camera_heading
        'false', // 15 timestamp_issues
        '', // 16 bait_use
        '', // 17 session
        '', // 18 array
        '', // 19 feature_type
        '', // 20 habitat
        '', // 21 tags
        '', // 22 comments
      ]),
    )
    .join('');
}

/**
 * Serialize `media.csv` (one row per image), v016 11-column shape. The full S3
 * object key is repeated in the media_id / sequence_id / file_path positions,
 * matching SPARC'd's own writer. The timestamp column (4) is left empty on
 * initial upload exactly as the canonical writer leaves it — per-image
 * timestamps enter later via the tagger, not here.
 */
export function serializeMedia(media: Media[]): string {
  return media
    .map((m) =>
      csvRow([
        m.mediaPath, // 0  media_id (= full key)
        m.deploymentId, // 1  deployment_id
        m.mediaPath, // 2  sequence_id (= full key)
        '', // 3  capture_method
        '', // 4  timestamp (empty on initial upload)
        m.mediaPath, // 5  file_path (= full key)
        m.fileName, // 6  file_name
        m.mimeType, // 7  file_media_type
        '', // 8  exif_data
        'false', // 9  favorite
        '', // 10 comments
      ]),
    )
    .join('');
}

/**
 * Serialize `observations.csv`, v016 20-column shape. Initial uploads always
 * write this as an empty file (`''`) so the tagger has a stable canonical base
 * to hash; the row serializer exists so the tagger's append path shares it.
 */
export function serializeObservations(observations: Observation[]): string {
  if (observations.length === 0) return '';
  return observations
    .map((o) =>
      csvRow([
        o.observationId, // 0  observation_id
        o.deploymentId, // 1  deployment_id
        '', // 2  sequence_id
        o.mediaId, // 3  media_id (= full key)
        o.timestamp, // 4  timestamp
        '', // 5  observation_type
        'false', // 6  camera_setup
        '', // 7  taxon_id
        o.scientificName, // 8  scientific_name
        String(o.count), // 9  count
        '0', // 10 count_new
        '', // 11 life_stage
        '', // 12 sex
        '', // 13 behaviour
        '', // 14 individual_id
        '', // 15 classification_method
        '', // 16 classified_by
        '', // 17 classification_timestamp
        '', // 18 classification_confidence
        o.tags, // 19 comments ([COMMONNAME:…])
      ]),
    )
    .join('');
}

// ---------------------------------------------------------------------------
// UploadMeta.json — matched byte-for-byte to the live shape (2-space pretty,
// LF newlines, no trailing newline). `uploadDate` is a nested Java
// LocalDateTime-style object.
// ---------------------------------------------------------------------------

export type UploadDate = {
  date: { year: number; month: number; day: number };
  time: { hour: number; minute: number; second: number; nano: number };
};

export type UploadMetaJson = {
  uploadUser: string;
  uploadDate: UploadDate;
  imagesWithSpecies: number;
  imageCount: number;
  editComments: string[];
  bucket: string;
  uploadPath: string;
  description: string;
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** The `<YYYY.MM.DD.HH.MM.SS>` stamp SPARC'd uses in upload prefix names. */
export function uploadStamp(d: Date): string {
  return (
    `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}.` +
    `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
  );
}

/** Local-time `uploadDate`, consistent with the prefix stamp from the same Date. */
export function uploadDateFrom(d: Date): UploadDate {
  return {
    date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
    time: {
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      nano: d.getMilliseconds() * 1_000_000,
    },
  };
}

export function buildUploadMeta(input: {
  uploadUser: string;
  date: Date;
  imageCount: number;
  imagesWithSpecies: number;
  bucket: string;
  uploadPath: string;
  description: string;
}): UploadMetaJson {
  // Key order matches the live file so the serialized bytes line up.
  return {
    uploadUser: input.uploadUser,
    uploadDate: uploadDateFrom(input.date),
    imagesWithSpecies: input.imagesWithSpecies,
    imageCount: input.imageCount,
    editComments: [],
    bucket: input.bucket,
    uploadPath: input.uploadPath,
    description: input.description,
  };
}

/** Serialize `UploadMeta.json` exactly as the live file: 2-space, LF, no trailing newline. */
export function serializeUploadMeta(meta: UploadMetaJson): string {
  return JSON.stringify(meta, null, 2);
}

// ---------------------------------------------------------------------------
// UploadComplete.json — this project's own completion sentinel (additive; not
// read by upstream SPARC'd, which keys completion off UploadMeta.json). Blobs
// live under the upload prefix, so there is no separate blob prefix to record.
// ---------------------------------------------------------------------------

export type UploadCompleteFile = { media_path: string; size: number; sha256: string };

export type UploadCompleteJson = {
  schemaVersion: 1;
  uploadPath: string;
  fileCount: number;
  metadataBundleSha256: string;
  files: UploadCompleteFile[];
  completedAt: string;
};

export function serializeUploadComplete(c: UploadCompleteJson): string {
  return JSON.stringify(c, null, 2);
}
