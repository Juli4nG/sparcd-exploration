import type { S3Config } from '@sparcd/types';

/**
 * Shared S3 session across every SPARC'd tool on one origin. The full
 * S3Config — secret included — lives under a single localStorage key so that
 * logging in to any tool logs you in everywhere (across tabs and tab-close).
 * On-disk secret persistence is a deliberate product decision for these
 * internal tools, not an oversight.
 */
const KEY = 'sparcd-connection';

export function loadSharedConnection(): S3Config | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as S3Config;
  } catch {
    return null;
  }
}

export function saveSharedConnection(cfg: S3Config): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* storage unavailable (private mode / quota) — nothing to do */
  }
}

export function clearSharedConnection(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Fire `cb` whenever the shared connection changes in *another* tab (the
 * `storage` event only fires cross-tab). Returns an unsubscribe function.
 */
export function subscribeSharedConnection(cb: (cfg: S3Config | null) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key !== null && e.key !== KEY) return;
    cb(loadSharedConnection());
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
