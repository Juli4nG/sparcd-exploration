// Camtrap-DP-flavored types shared by the SPARC'd tools. Pure TS — no React,
// no S3. The uploader becomes the writer-of-record here; the tagger reads.
//
// The reader/writer (round-trip-stable, fixed-column-position CSV) land in
// the uploader's P3 (CSV generation) and the tagger's read path. P0 only
// needs the type surface so downstream phases share one definition.

/** One row of `deployments.csv` — a camera location for one upload. */
export type Deployment = {
  deploymentId: string; // "<collection-uuid>:<location-id>"
  locationId: string;
  locationName: string;
  latitude: number;
  longitude: number;
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
