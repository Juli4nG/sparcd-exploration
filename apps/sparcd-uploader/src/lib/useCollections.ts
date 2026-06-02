import { useQuery } from '@tanstack/react-query';
import type { S3Config } from '@sparcd/types';
import { listCollections, fetchCollectionName, type CollectionRef } from './s3';

/** List the collection buckets for the connected endpoint (cached per endpoint). */
export function useCollections(cfg: S3Config | null) {
  return useQuery<CollectionRef[]>({
    queryKey: ['collections', cfg?.endpoint],
    queryFn: () => listCollections(cfg!),
    enabled: !!cfg,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

/** Resolve the display name for the selected collection only (lazy, cached). */
export function useCollectionName(cfg: S3Config | null, ref: CollectionRef | null) {
  return useQuery<string | null>({
    queryKey: ['collectionName', ref?.bucket],
    queryFn: () => fetchCollectionName(cfg!, ref!),
    enabled: !!cfg && !!ref,
    staleTime: 30 * 60 * 1000,
    retry: 0,
  });
}
