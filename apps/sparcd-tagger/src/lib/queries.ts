// TanStack Query wrappers. Every key is scoped by `connectionId` (not raw
// credentials), and the client cache is cleared on connect/disconnect, so
// reconnecting with new credentials never serves a previous connection's data.

import { useQuery } from '@tanstack/react-query';
import type { S3Config } from '@sparcd/types';
import {
  listCollections,
  listUploads,
  listUploadImages,
  loadCanonicalState,
  parseCollectionKey,
  type CollectionRef,
  type UploadRef,
  type UploadImage,
} from './s3';
import { fetchSpecies, type SpeciesResult } from './species';
import { buildTagImages, type TagImage } from './workspace';
import { groundUpload } from './db';

export function useCollections(cfg: S3Config | null, connectionId: number) {
  return useQuery<CollectionRef[]>({
    queryKey: ['collections', connectionId, cfg?.endpoint],
    queryFn: () => listCollections(cfg!),
    enabled: !!cfg,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useUploads(cfg: S3Config | null, connectionId: number, collectionKey: string | null) {
  return useQuery<UploadRef[]>({
    queryKey: ['uploads', connectionId, collectionKey],
    queryFn: () => {
      const { bucket, uuid } = parseCollectionKey(collectionKey!);
      return listUploads(cfg!, bucket, uuid);
    },
    enabled: !!cfg && !!collectionKey,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useUploadImages(
  cfg: S3Config | null,
  connectionId: number,
  collectionKey: string | null,
  uploadPrefix: string | null,
) {
  return useQuery<UploadImage[]>({
    queryKey: ['uploadImages', connectionId, collectionKey, uploadPrefix],
    queryFn: () => {
      const { bucket } = parseCollectionKey(collectionKey!);
      return listUploadImages(cfg!, bucket, uploadPrefix!);
    },
    enabled: !!cfg && !!collectionKey && !!uploadPrefix,
    staleTime: 60 * 1000,
    retry: 1,
  });
}

/** The canonical base for the Tag workspace: `media.csv` joined with existing
 *  `observations.csv` into per-image state. Loading also grounds the upload —
 *  it records the canonical ETags/hashes the sync path writes against, so the
 *  on-screen base and the sync ground never drift apart. */
export function useTagImages(
  cfg: S3Config | null,
  connectionId: number,
  collectionKey: string | null,
  uploadPrefix: string | null,
) {
  return useQuery<TagImage[]>({
    queryKey: ['tagImages', connectionId, collectionKey, uploadPrefix],
    queryFn: async () => {
      const { bucket } = parseCollectionKey(collectionKey!);
      const state = await loadCanonicalState(cfg!, bucket, uploadPrefix!);
      await groundUpload(bucket, uploadPrefix!, state);
      return buildTagImages({
        mediaCsv: state.media.text,
        observationsCsv: state.observations.text,
      });
    },
    enabled: !!cfg && !!collectionKey && !!uploadPrefix,
    staleTime: 60 * 1000,
    retry: 1,
  });
}

/** The species vocabulary, loaded once per connection from the settings bucket. */
export function useSpecies(cfg: S3Config | null, connectionId: number) {
  return useQuery<SpeciesResult>({
    queryKey: ['species', connectionId, cfg?.endpoint],
    queryFn: () => fetchSpecies(cfg!),
    enabled: !!cfg,
    staleTime: Infinity, // vocabulary is stable for a session
    retry: 1,
  });
}
