import { useEffect, useState } from 'react';
import type { S3Config } from '@sparcd/types';
import { loadSharedConnection, subscribeSharedConnection } from './session';

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

/** "AKIA1234567890" → "AKIA…90". */
function maskKey(key: string): string {
  if (key.length <= 6) return key;
  return `${key.slice(0, 4)}…${key.slice(-2)}`;
}

/**
 * Live status chip for the active shared session. Renders nothing when there
 * is no session (the app shows its login gate instead).
 */
export function ConnectionChip({ identity, onDisconnect }: ConnectionChipProps) {
  const [cfg, setCfg] = useState<S3Config | null>(() => loadSharedConnection());

  useEffect(() => subscribeSharedConnection(setCfg), []);

  if (!cfg) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[12px] text-inkSoft">
      <span className="text-ink" title={cfg.endpoint}>
        {hostOf(cfg.endpoint)}
      </span>
      <span aria-hidden className="text-ruleSoft">
        ·
      </span>
      <span className="text-inkMute" title="Access key">
        {maskKey(cfg.accessKey)}
      </span>
      {identity && (
        <>
          <span aria-hidden className="text-ruleSoft">
            ·
          </span>
          <span className="text-inkSoft">{identity}</span>
        </>
      )}
      <button
        type="button"
        onClick={onDisconnect}
        className="ml-1 border border-rule px-2 py-0.5 text-[11px] font-body text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      >
        Disconnect
      </button>
    </div>
  );
}
