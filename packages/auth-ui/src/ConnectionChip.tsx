import { useEffect, useState } from 'react';
import {
  loadPersistedConnection,
  getLiveConnection,
  subscribeSharedConnection,
  type PersistedConnection,
} from './session';

export type ConnectionChipProps = {
  /** Optional human identity, e.g. the SPARC'd username stamped on writes. */
  identity?: string;
  onDisconnect: () => void;
};

/** "https://wildcats.sparcd.arizona.edu:9000" → "wildcats.sparcd.arizona.edu". */
function hostOf(endpoint: string): string {
  return endpoint
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

/** "AKIA1234567890" → "AK…90". */
function maskKey(key: string): string {
  if (key.length <= 4) return key;
  return `${key.slice(0, 2)}…${key.slice(-2)}`;
}

/**
 * Live status chip for the active shared session. Renders nothing when there
 * is no session (the app shows its login gate instead).
 */
export function ConnectionChip({ identity, onDisconnect }: ConnectionChipProps) {
  // Only ever displays endpoint/accessKey — never the secret — so the
  // non-persisted (secret-included) shape from a live cross-tab connect and
  // the persisted (secret-less) shape read back after a reload both work
  // here. `getLiveConnection()` covers THIS tab's own just-happened connect
  // (this component only mounts once `s3Config` is already set, i.e. after
  // that call already ran — a plain synchronous read, not an event, so
  // there's no risk of mounting too late to catch it); falls back to
  // whatever's on disk (possibly nothing, if "Remember me" was unchecked).
  const [cfg, setCfg] = useState<PersistedConnection | null>(
    () => getLiveConnection() ?? loadPersistedConnection(),
  );

  // This chip is purely a passive display, not a source of truth for "is
  // anyone connected" — it never answers a sibling tab's request.
  useEffect(() => subscribeSharedConnection(setCfg, () => null), []);

  if (!cfg) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[12px] text-inkSoft">
      <span
        className="text-inkSoft italic focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        tabIndex={0}
        title="S3 endpoint you're connected to"
        aria-label={`S3 endpoint: ${hostOf(cfg.endpoint)}`}
      >
        {hostOf(cfg.endpoint)}
      </span>
      <span aria-hidden className="text-ruleSoft">
        ·
      </span>
      <span
        className="text-inkMute italic focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        tabIndex={0}
        title="Your access key (masked)"
        aria-label={`Access key, masked: ${maskKey(cfg.accessKey)}`}
      >
        {maskKey(cfg.accessKey)}
      </span>
      {identity && (
        <>
          <span aria-hidden className="text-ruleSoft">
            ·
          </span>
          <span
            className="text-inkSoft font-[600] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            tabIndex={0}
            title="Identity recorded with your activity"
            aria-label={`Identity: ${identity}`}
          >
            {identity}
          </span>
        </>
      )}
      <button
        type="button"
        onClick={onDisconnect}
        title="End this session and log out"
        className="ml-1 border border-rule px-2 py-0.5 text-[11px] font-body text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      >
        Logout
      </button>
    </div>
  );
}
