// Joins the canonical `media.csv` + `observations.csv` into the per-image base
// state the Tag workspace edits on top of. `media.csv` is the authoritative
// image order and source of deployment + capture time; existing observation
// rows seed each image's "already-tagged" label so re-opening an upload shows
// prior work (from Java, sparcd-web, or an earlier tagger sync).

import {
  parseMedia,
  parseObservations,
  commonNameFromComments,
  requestedSpeciesFromComments,
  type Observation,
} from '@sparcd/camtrap';

/** The canonical CSV text `buildTagImages` reads (the sync path adds ETags/hashes). */
export type CanonicalBundle = {
  mediaCsv: string;
  observationsCsv: string;
};

/** One image as the Tag workspace sees it before any local edit. */
export type TagImage = {
  key: string; // media.csv col 0 = full object key (the presign + draft key)
  fileName: string;
  deploymentId: string;
  baseTimestamp: string; // media col 4, ISO
  baseLabel: string; // first existing observation's scientificName, or ''
  baseCommonName: string;
  baseCount: number;
  baseRequested: string;
};

// `.jpg`/`.mp4` only — same definition of "taggable image" the readers use, so
// snapshot/CSV/JSON rows in media.csv (there are none today, but be defensive)
// never become tiles.
const IMAGE_EXT = /\.(jpe?g|mp4)$/i;

export function buildTagImages(bundle: CanonicalBundle): TagImage[] {
  const obsByMedia = new Map<string, Observation[]>();
  for (const o of parseObservations(bundle.observationsCsv)) {
    const list = obsByMedia.get(o.mediaId);
    if (list) list.push(o);
    else obsByMedia.set(o.mediaId, [o]);
  }

  return parseMedia(bundle.mediaCsv)
    .filter((m) => IMAGE_EXT.test(m.mediaId))
    .map((m) => {
      const first = obsByMedia.get(m.mediaId)?.[0];
      return {
        key: m.mediaId,
        fileName: m.fileName || (m.mediaId.split('/').pop() ?? m.mediaId),
        deploymentId: m.deploymentId,
        baseTimestamp: m.timestamp,
        baseLabel: first?.scientificName ?? '',
        baseCommonName: first ? (commonNameFromComments(first.tags) ?? '') : '',
        baseCount: first?.count ?? 0,
        baseRequested: first ? (requestedSpeciesFromComments(first.tags) ?? '') : '',
      };
    });
}
