import { useQuery } from '@tanstack/react-query';
import type { S3Config } from '@sparcd/types';
import { fetchLocations, type LocationsResult } from './s3';

/**
 * Load + cache the camera-location registry for the connected endpoint.
 * Keyed on the endpoint so a reconnect to a different backend refetches,
 * but section switches and Assign revisits hit the cache. Locations change
 * rarely, so a long stale time avoids redundant reads.
 */
export function useLocations(cfg: S3Config | null) {
  return useQuery<LocationsResult>({
    queryKey: ['locations', cfg?.endpoint, cfg?.accessKey],
    queryFn: () => fetchLocations(cfg!),
    enabled: !!cfg,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
